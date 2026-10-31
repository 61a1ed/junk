import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { fork } from 'node:child_process';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { openDatabase, putDocument, indexPage, verifyPage, pageRanges, PROFILE, PROFILE_ID } from './index.mjs';
import { makeFixturePdf } from './test/fixture.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PDF_ROOT = path.join(ROOT, 'node_modules/pdfjs-dist');
const MAX_UPLOAD = 25 * 1024 * 1024;
const MAX_SESSION = 100 * 1024 * 1024;
const errorWithStatus = (message, status = 400) => Object.assign(new Error(message), { status });
const quoteName = name => `"${name.replaceAll('"', '""')}"`;

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readBody(request, limit) {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    request.resume();
    throw errorWithStatus(`Request exceeds the ${Math.round(limit / 1024 / 1024)} MiB limit`, 413);
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw errorWithStatus('Request body is too large', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw errorWithStatus('Expected application/json', 415);
  try {
    const value = JSON.parse((await readBody(request, 64 * 1024)).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch (error) {
    if (error.status) throw error;
    throw errorWithStatus('Invalid JSON body');
  }
}

async function inspectPdf(bytes) {
  const task = pdfjs.getDocument({ data: Uint8Array.from(bytes), stopAtErrors: true, useSystemFonts: false, enableXfa: false });
  let timer;
  try {
    const document = await Promise.race([
      task.promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PDF validation timed out')), 15000); }),
    ]);
    if (await document.getPermissions() !== null) throw new Error('Encrypted PDFs are not supported');
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1 || document.numPages > 10000) throw new Error('PDF must contain between 1 and 10,000 pages');
    await document.getPage(1);
    return document.numPages;
  } catch (error) {
    if (error.name === 'PasswordException') throw errorWithStatus('Encrypted PDFs are not supported. Upload an unencrypted copy.');
    throw errorWithStatus(`Unable to read PDF: ${error.message}`);
  } finally {
    clearTimeout(timer);
    await task.destroy();
  }
}

export function createDebugServer({ host = '127.0.0.1', queryTimeoutMs = 2000, maxUploadBytes = MAX_UPLOAD, maxSessionBytes = MAX_SESSION } = {}) {
  const db = openDatabase(':memory:');
  db.exec(`CREATE TABLE upload_metadata (
    document_id TEXT PRIMARY KEY REFERENCES documents ON DELETE CASCADE,
    filename TEXT NOT NULL,
    page_count INTEGER NOT NULL
  ) STRICT`);
  let busy = false;
  let activity = null;
  let closed = false;
  const queryProcesses = new Set();
  const documentSql = `SELECT d.*, u.filename, u.page_count,
    (SELECT count(*) FROM document_chunks c WHERE c.document_id = d.document_id) AS chunk_count,
    (SELECT count(*) FROM page_manifests m WHERE m.document_id = d.document_id AND m.profile_id = '${PROFILE_ID}') AS indexed_pages
    FROM documents d JOIN upload_metadata u USING (document_id)`;
  const getDocument = id => {
    const document = db.prepare(`${documentSql} WHERE d.document_id = ?`).get(id);
    if (!document) throw errorWithStatus('Document not found', 404);
    return document;
  };
  const sourceBytes = () => db.prepare('SELECT coalesce(sum(byte_length), 0) AS n FROM documents').get().n;
  const getPages = (body, document) => {
    if (!Array.isArray(body.pages) || !body.pages.length || body.pages.length > 100) throw errorWithStatus('Choose between 1 and 100 pages');
    if (body.pages.some(page => !Number.isSafeInteger(page) || page < 1 || page > document.page_count)) throw errorWithStatus(`Pages must be integers between 1 and ${document.page_count}`);
    return [...new Set(body.pages)];
  };
  async function mutate(label, callback) {
    if (busy) throw errorWithStatus(`Database is busy: ${activity}`, 409);
    busy = true;
    activity = label;
    try { return await callback(); }
    finally { busy = false; activity = null; }
  }
  function query(sql) {
    if (typeof sql !== 'string' || !sql.trim() || sql.length > 20000) throw errorWithStatus('Enter a SQL query of at most 20,000 characters');
    if (queryProcesses.size >= 2) throw errorWithStatus('Two SQL queries are already running', 429);
    const snapshot = db.serialize();
    return new Promise((resolve, reject) => {
      const child = fork(fileURLToPath(new URL('./query-worker.mjs', import.meta.url)), [], {
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        execArgv: ['--max-old-space-size=128'],
      });
      queryProcesses.add(child);
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        queryProcesses.delete(child);
        child.kill('SIGKILL');
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => finish(errorWithStatus('Query timed out. Add a LIMIT or simplify the query.', 408)), queryTimeoutMs);
      child.once('message', result => result.error ? finish(errorWithStatus(result.error)) : finish(null, result));
      child.once('error', error => finish(errorWithStatus(error.message)));
      child.once('exit', code => { if (!settled) finish(errorWithStatus(`Query process stopped (${code})`)); });
      child.send({ snapshot, sql }, error => { if (error) finish(errorWithStatus(error.message)); });
    });
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!request.headers.host) throw errorWithStatus('Host header is required', 400);
      const origin = `http://${request.headers.host}`;
      const url = new URL(request.url, origin);
      const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'];
      if (loopback.includes(host) && !loopback.includes(new URL(origin).hostname)) throw errorWithStatus('Only localhost requests are accepted', 403);
      if (request.headers.origin) {
        const requestOrigin = URL.canParse(request.headers.origin) ? new URL(request.headers.origin) : null;
        if (!requestOrigin || !['http:', 'https:'].includes(requestOrigin.protocol) || requestOrigin.host !== request.headers.host) throw errorWithStatus('Cross-origin requests are not accepted', 403);
      }
      if (request.headers['sec-fetch-site'] === 'cross-site') throw errorWithStatus('Cross-site requests are not accepted', 403);
      const method = request.method;
      const pathname = url.pathname;
      if (method === 'GET' && pathname === '/api/state') {
        return sendJson(response, 200, {
          documents: db.prepare(`${documentSql} ORDER BY d.created_at DESC, u.filename`).all(),
          stats: {
            documents: db.prepare('SELECT count(*) AS n FROM documents').get().n,
            chunks: db.prepare('SELECT count(*) AS n FROM document_chunks').get().n,
            manifests: db.prepare('SELECT count(*) AS n FROM page_manifests').get().n,
            sourceBytes: sourceBytes(),
          }, profile: PROFILE, profileId: PROFILE_ID, busy, activity,
        });
      }
      if (method === 'POST' && pathname === '/api/documents') {
        if (!request.headers['content-type']?.startsWith('application/pdf')) throw errorWithStatus('Expected application/pdf', 415);
        const result = await mutate('Validating PDF upload', async () => {
          const bytes = await readBody(request, maxUploadBytes);
          if (bytes.length < 8 || bytes.subarray(0, 5).toString() !== '%PDF-') throw errorWithStatus('This file does not have a PDF header');
          const chunkSize = Number(url.searchParams.get('chunkSize') ?? 16384);
          if (!Number.isSafeInteger(chunkSize) || chunkSize < 1024 || chunkSize > 1024 * 1024 || Math.log2(chunkSize) % 1 !== 0) throw errorWithStatus('Chunk size must be a power of two from 1 KiB to 1 MiB');
          const id = createHash('sha256').update(bytes).digest('hex');
          const existing = db.prepare('SELECT 1 FROM documents WHERE document_id = ?').get(id);
          if (existing) {
            const document = getDocument(id);
            if (document.chunk_size !== chunkSize) throw errorWithStatus('This PDF already exists with a different chunk size. Delete it before changing the chunk size.', 409);
            return { document, duplicate: true };
          }
          if (sourceBytes() + bytes.length > maxSessionBytes) throw errorWithStatus('The session has reached its 100 MiB source-file limit. Delete documents or reset the session.', 413);
          const pageCount = await inspectPdf(bytes);
          const rawName = url.searchParams.get('filename') || 'document.pdf';
          const filename = path.basename(rawName.replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240) || 'document.pdf';
          putDocument(db, bytes, chunkSize);
          try { db.prepare('INSERT INTO upload_metadata VALUES (?, ?, ?)').run(id, filename, pageCount); }
          catch (error) { db.prepare('DELETE FROM documents WHERE document_id = ?').run(id); throw error; }
          return { document: getDocument(id), duplicate: false };
        });
        return sendJson(response, result.duplicate ? 200 : 201, result);
      }
      const documentRoute = /^\/api\/documents\/([a-f0-9]{64})(?:\/(pdf|index|verify|ranges))?$/.exec(pathname);
      if (documentRoute) {
        const [, id, action] = documentRoute;
        const document = getDocument(id);
        if (method === 'GET' && !action) {
          const manifests = db.prepare('SELECT * FROM page_manifests WHERE document_id = ? AND profile_id = ? ORDER BY page_number').all(id, PROFILE_ID).map(manifest => ({
            ...manifest,
            chunks: db.prepare('SELECT chunk_number FROM page_dependencies WHERE document_id = ? AND profile_id = ? AND page_number = ? ORDER BY chunk_number').all(id, PROFILE_ID, manifest.page_number).map(row => row.chunk_number),
          }));
          return sendJson(response, 200, { document, manifests });
        }
        if (method === 'GET' && action === 'pdf') {
          response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': document.byte_length, 'Cache-Control': 'no-store' });
          for (const chunk of db.prepare('SELECT data FROM document_chunks WHERE document_id = ? ORDER BY chunk_number').iterate(id)) response.write(chunk.data);
          return response.end();
        }
        if (method === 'DELETE' && !action) {
          await mutate('Deleting document', () => db.prepare('DELETE FROM documents WHERE document_id = ?').run(id));
          return sendJson(response, 200, { deleted: true });
        }
        if (method === 'POST' && ['index', 'verify', 'ranges'].includes(action)) {
          const pages = getPages(await readJson(request), document);
          if (action === 'ranges') {
            const ranges = pageRanges(db, id, pages);
            const chunks = [...new Set(pages.flatMap(page => db.prepare('SELECT chunk_number FROM page_dependencies WHERE document_id = ? AND profile_id = ? AND page_number = ?').all(id, PROFILE_ID, page).map(row => row.chunk_number)))].sort((a, b) => a - b);
            return sendJson(response, 200, { ranges, bytes: ranges.reduce((sum, [start, end]) => sum + end - start, 0), sourceBytes: document.byte_length, chunks });
          }
          const results = await mutate(`${action === 'index' ? 'Indexing' : 'Verifying'} ${pages.length} page${pages.length === 1 ? '' : 's'}`, async () => {
            const results = [];
            for (const pageNumber of pages) {
              activity = `${action === 'index' ? 'Indexing' : 'Verifying'} page ${pageNumber}`;
              try {
                const result = await (action === 'index' ? indexPage : verifyPage)(db, id, pageNumber);
                results.push({ pageNumber, success: true, ...result });
              } catch (error) { results.push({ pageNumber, success: false, error: error.message }); }
            }
            return results;
          });
          return sendJson(response, 200, { results });
        }
        throw errorWithStatus('Method not supported', 405);
      }
      if (method === 'POST' && pathname === '/api/reset') {
        await mutate('Resetting session', () => db.exec('DELETE FROM documents; DELETE FROM render_profiles;'));
        return sendJson(response, 200, { reset: true });
      }
      if (method === 'GET' && pathname === '/api/schema') {
        const tables = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(table => ({
          ...table,
          columns: db.prepare(`PRAGMA table_info(${quoteName(table.name)})`).all().map(({ name, type, pk, notnull }) => ({ name, type, pk, notnull })),
          rowCount: db.prepare(`SELECT count(*) AS n FROM ${quoteName(table.name)}`).get().n,
        }));
        return sendJson(response, 200, { tables });
      }
      if (method === 'POST' && pathname === '/api/query') {
        const body = await readJson(request);
        return sendJson(response, 200, await query(body.sql));
      }
      if (method === 'GET' && pathname === '/api/sample.pdf') {
        const bytes = makeFixturePdf();
        response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
        return response.end(bytes);
      }
      if (pathname.startsWith('/api/')) throw errorWithStatus('API route not found', 404);
      if (method !== 'GET' && method !== 'HEAD') throw errorWithStatus('Method not supported', 405);
      let root = path.join(ROOT, 'public');
      let relativePath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
      if (pathname.startsWith('/vendor/')) {
        root = PDF_ROOT;
        relativePath = decodeURIComponent(pathname.slice('/vendor/'.length));
        if (relativePath === 'pdf.mjs' || relativePath === 'pdf.worker.mjs') relativePath = `build/${relativePath}`;
        if (!/^(build\/(pdf|pdf\.worker)\.mjs|(cmaps|standard_fonts|wasm|iccs)\/[^/]+)$/.test(relativePath)) throw errorWithStatus('Asset not found', 404);
      }
      const filename = path.resolve(root, relativePath);
      if (!filename.startsWith(`${root}${path.sep}`)) throw errorWithStatus('Asset not found', 404);
      const info = await stat(filename).catch(() => null);
      if (!info?.isFile()) throw errorWithStatus('Asset not found', 404);
      const type = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ico': 'image/x-icon' })[path.extname(filename)] || 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size, 'Cache-Control': pathname.startsWith('/vendor/') ? 'public, max-age=3600' : 'no-cache' });
      response.end(method === 'HEAD' ? undefined : await readFile(filename));
    } catch (error) {
      if (!response.headersSent) sendJson(response, error.status || 400, { error: error.message || 'Request failed' });
      else response.destroy(error);
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 15000;
  server.on('close', () => {
    for (const child of queryProcesses) child.kill('SIGKILL');
    if (!closed) { db.close(); closed = true; }
  });
  return { server, host };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
  const { server } = createDebugServer({ host });
  server.listen(port, host, () => console.log(`PDF database debug console: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}\nSQLite is in memory. Restarting this process clears all uploaded files and manifests.`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
