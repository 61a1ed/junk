import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { makeFixturePdf } from './test/fixture.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_ROOT = path.join(ROOT, 'public');
const PDF_ROOT = path.join(ROOT, 'node_modules/pdfjs-dist');
const SQL_ROOT = path.join(ROOT, 'node_modules/sql.js/dist');
const fail = (message, status) => Object.assign(new Error(message), { status });
const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.json': 'application/json; charset=utf-8', '.ftl': 'text/plain; charset=utf-8',
};

// Development asset server only. PDFs, SQLite, queries, and rendering all live
// in the browser; this process never receives uploaded files or opens SQLite.
export function createDebugServer({ host = '127.0.0.1' } = {}) {
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!request.headers.host) throw fail('Host header is required', 400);
      const url = new URL(request.url, `http://${request.headers.host}`);
      const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'];
      if (loopback.includes(host) && !loopback.includes(url.hostname)) throw fail('Only localhost requests are accepted', 403);
      if (!['GET', 'HEAD'].includes(request.method)) throw fail('This server only serves frontend assets; database operations run in your browser.', 405);
      if (url.pathname.startsWith('/api/')) throw fail('There is no server database API. SQLite runs in your browser.', 404);
      if (url.pathname === '/sample.pdf') {
        const bytes = makeFixturePdf();
        response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
        return response.end(request.method === 'HEAD' ? undefined : bytes);
      }
      let filename;
      if (url.pathname === '/schema.sql') filename = path.join(ROOT, 'schema.sql');
      else {
        let root = PUBLIC_ROOT;
        let relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
        // The official viewer keeps its release-matched core in public/pdfjs.
        // Its unchanged relative URLs reuse the identical worker and resources
        // from the pinned pdfjs-dist dependency instead of vendoring duplicates.
        if (url.pathname.startsWith('/pdfjs/')) {
          const viewerAsset = decodeURIComponent(url.pathname.slice('/pdfjs/'.length));
          if (/^build\/pdf\.(worker|sandbox)\.mjs$/.test(viewerAsset)) {
            root = PDF_ROOT;
            relative = viewerAsset;
          } else if (/^web\/(cmaps|standard_fonts|wasm|iccs)\/[^/]+$/.test(viewerAsset)) {
            root = PDF_ROOT;
            relative = viewerAsset.slice('web/'.length);
          }
        }
        if (url.pathname.startsWith('/vendor/')) {
          relative = decodeURIComponent(url.pathname.slice('/vendor/'.length));
          if (['sql-wasm.js', 'sql-wasm.wasm'].includes(relative)) root = SQL_ROOT;
          else {
            root = PDF_ROOT;
            if (['pdf.mjs', 'pdf.worker.mjs'].includes(relative)) relative = `build/${relative}`;
            if (!/^(build\/(pdf|pdf\.worker)\.mjs|(cmaps|standard_fonts|wasm|iccs)\/[^/]+)$/.test(relative)) throw fail('Asset not found', 404);
          }
        }
        filename = path.resolve(root, relative);
        if (!filename.startsWith(`${root}${path.sep}`)) throw fail('Asset not found', 404);
      }
      const info = await stat(filename).catch(() => null);
      if (!info?.isFile()) throw fail('Asset not found. Run npm ci to install frontend dependencies.', 404);
      response.writeHead(200, {
        'Content-Type': contentTypes[path.extname(filename)] || 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': 'no-cache',
      });
      response.end(request.method === 'HEAD' ? undefined : await readFile(filename));
    } catch (error) {
      if (response.headersSent) response.destroy(error);
      else {
        response.writeHead(error.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error.message }));
      }
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return { server, host };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
  const { server } = createDebugServer({ host });
  server.listen(port, host, () => console.log(`PDF Workbench: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}\nStatic assets only. SQLite WASM and uploaded PDFs stay in browser memory; reload clears the tab's database.`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
