import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pdfjsAssetDirectory } from './pdfjs-assets.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const canvasVersion = JSON.parse(readFileSync(
  new URL('./node_modules/@napi-rs/canvas/package.json', import.meta.url), 'utf8'
)).version;

// This profile deliberately describes a Node ingestion renderer. Browser traces
// should use their own profile/build/settings. A trace is a prefetch hint, not a
// promise that another renderer or appearance configuration needs no more bytes.
export const PROFILE = Object.freeze({
  implementation: 'cold-render-v1',
  pdfjsVersion: pdfjs.version,
  pdfjsBuild: pdfjs.build,
  canvasVersion,
  runtime: `${process.version}/${process.platform}/${process.arch}`,
  intent: 'display',
  annotationMode: 'DISABLE',
  optionalContent: 'document-default-view',
  scale: 1,
  background: '#ffffff',
  useSystemFonts: false,
  disableFontFace: true,
  enableXfa: false,
  stopAtErrors: true,
});
export const PROFILE_ID = sha256(JSON.stringify(PROFILE));

export function openDatabase(filename) {
  const db = new DatabaseSync(filename);
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// Stores exact source bytes once. A document's chunk size is immutable.
export function putDocument(db, bytes, chunkSize = 16 * 1024) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new Error('Expected nonempty PDF bytes');
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1024 ||
      Math.log2(chunkSize) % 1 !== 0) {
    throw new Error('chunkSize must be a power of two >= 1024');
  }
  const documentId = sha256(bytes);
  return transaction(db, () => {
    const existing = db.prepare('SELECT * FROM documents WHERE document_id = ?')
      .get(documentId);
    if (existing) {
      if (existing.chunk_size !== chunkSize) {
        throw new Error('Document already exists with another chunk size');
      }
      return documentId;
    }
    db.prepare('INSERT INTO documents VALUES (?, ?, ?, CURRENT_TIMESTAMP)')
      .run(documentId, bytes.length, chunkSize);
    const insert = db.prepare('INSERT INTO document_chunks VALUES (?, ?, ?)');
    for (let start = 0; start < bytes.length; start += chunkSize) {
      insert.run(documentId, start / chunkSize, bytes.subarray(start, start + chunkSize));
    }
    return documentId;
  });
}

function getDocumentRow(db, documentId) {
  const row = db.prepare('SELECT * FROM documents WHERE document_id = ?').get(documentId);
  if (!row) throw new Error(`Unknown document: ${documentId}`);
  return row;
}

function makeReader(db, documentId, seen, allowedChunks) {
  const document = getDocumentRow(db, documentId);
  const lookup = db.prepare(
    'SELECT data FROM document_chunks WHERE document_id = ? AND chunk_number = ?'
  );
  const readRange = (begin, end) => {
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) ||
        begin < 0 || end <= begin || end > document.byte_length) {
      throw new Error(`Invalid byte range [${begin}, ${end})`);
    }
    const result = new Uint8Array(end - begin);
    const first = Math.floor(begin / document.chunk_size);
    const last = Math.floor((end - 1) / document.chunk_size);
    for (let n = first; n <= last; n++) {
      if (allowedChunks && !allowedChunks.has(n)) {
        throw new Error(`Manifest miss: chunk ${n}, requested [${begin}, ${end})`);
      }
      const row = lookup.get(documentId, n);
      const chunkStart = n * document.chunk_size;
      const expectedLength = Math.min(document.chunk_size, document.byte_length - chunkStart);
      if (!row || row.data.length !== expectedLength) {
        throw new Error(`Missing or truncated source chunk ${n}`);
      }
      seen.add(n);
      const from = Math.max(begin, chunkStart);
      const to = Math.min(end, chunkStart + row.data.length);
      result.set(row.data.subarray(from - chunkStart, to - chunkStart), from - begin);
    }
    return result; // A new, disposable buffer; never SQLite's stored buffer.
  };
  return { document, readRange };
}

// Public for testing/custom storage adapters. readRange may return a Promise.
// No data: fullPdf option is used: all PDF bytes flow through this reader.
export async function renderColdPage({
  byteLength, chunkSize, readRange, pageNumber, password,
  timeoutMs = 60_000, maxPixels = 20_000_000,
}) {
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
    throw new Error('pageNumber must be a positive, 1-based integer');
  }
  const failure = Promise.withResolvers();
  failure.promise.catch(() => {});
  let loadingTask;
  let stopped = false;
  let failed = false;
  const fail = error => {
    if (failed || stopped) return;
    failed = true;
    failure.reject(error);
    // An async range callback rejection alone does not reject PDF.js's wait.
    void loadingTask?.destroy().catch(() => {});
  };
  const timer = setTimeout(() => fail(new Error('Page trace timed out')), timeoutMs);

  const work = async () => {
    // Include this bootstrap chunk in the observed dependency set.
    const prefix = await readRange(0, Math.min(chunkSize, byteLength));
    if (failed || stopped) throw new Error('Page trace cancelled');
    const transport = new pdfjs.PDFDataRangeTransport(
      byteLength, Uint8Array.from(prefix), true
    );
    transport.requestDataRange = (begin, end) => {
      // Always answer asynchronously, after PDF.js installs its range reader.
      Promise.resolve().then(async () => {
        if (stopped || failed) return;
        const bytes = await readRange(begin, end);
        if (!stopped && !failed) transport.onDataRange(begin, Uint8Array.from(bytes));
      }).catch(fail);
    };
    transport.abort = () => { stopped = true; };
    loadingTask = pdfjs.getDocument({
      range: transport,
      rangeChunkSize: chunkSize,
      disableAutoFetch: true,
      disableStream: true,
      disableRange: false,
      password,
      useSystemFonts: PROFILE.useSystemFonts,
      disableFontFace: PROFILE.disableFontFace,
      enableXfa: PROFILE.enableXfa,
      stopAtErrors: PROFILE.stopAtErrors,
      useWorkerFetch: false,
      cMapUrl: pdfjsAssetDirectory('cmaps'),
      cMapPacked: true,
      standardFontDataUrl: pdfjsAssetDirectory('standard_fonts'),
      wasmUrl: pdfjsAssetDirectory('wasm'),
      iccUrl: pdfjsAssetDirectory('iccs'),
    });
    loadingTask.onPassword = () => fail(new Error('A valid PDF password is required'));
    const document = await loadingTask.promise;
    const page = await document.getPage(pageNumber);
    if (page.isPureXfa) throw new Error('Pure XFA rendering is outside this profile');
    const viewport = page.getViewport({ scale: PROFILE.scale });
    const pixelWidth = Math.ceil(viewport.width);
    const pixelHeight = Math.ceil(viewport.height);
    if (pixelWidth < 1 || pixelHeight < 1 || pixelWidth * pixelHeight > maxPixels) {
      throw new Error('Page exceeds the tracing canvas pixel limit');
    }
    const canvas = createCanvas(pixelWidth, pixelHeight);
    const context = canvas.getContext('2d');
    try {
      await page.render({
        canvasContext: context,
        viewport,
        intent: PROFILE.intent,
        background: PROFILE.background,
        annotationMode: pdfjs.AnnotationMode.DISABLE,
      }).promise;
      const pixels = context.getImageData(0, 0, pixelWidth, pixelHeight).data;
      return {
        pageCount: document.numPages,
        width: viewport.width,
        height: viewport.height,
        rotation: page.rotate,
        pixelSha256: sha256(pixels),
      };
    } finally {
      canvas.width = canvas.height = 1;
    }
  };
  try {
    return await Promise.race([work(), failure.promise]);
  } finally {
    clearTimeout(timer);
    stopped = true;
    await loadingTask?.destroy();
  }
}

export async function indexPage(db, documentId, pageNumber, options = {}) {
  const seen = new Set();
  const { document, readRange } = makeReader(db, documentId, seen);
  // A NEW loading task for EVERY page. Warm document caches hide dependencies.
  const rendered = await renderColdPage({
    ...options,
    byteLength: document.byte_length,
    chunkSize: document.chunk_size,
    readRange,
    pageNumber,
  });
  const chunks = [...seen].sort((a, b) => a - b);
  const observedBytes = chunks.reduce((sum, n) => sum + Math.min(
    document.chunk_size, document.byte_length - n * document.chunk_size
  ), 0);
  transaction(db, () => {
    db.prepare('INSERT OR IGNORE INTO render_profiles VALUES (?, ?)')
      .run(PROFILE_ID, JSON.stringify(PROFILE));
    db.prepare(`DELETE FROM page_manifests
      WHERE document_id = ? AND profile_id = ? AND page_number = ?`)
      .run(documentId, PROFILE_ID, pageNumber);
    db.prepare(`INSERT INTO page_manifests
      (document_id, profile_id, page_number, page_count, width, height, rotation,
       pixel_sha256, observed_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(documentId, PROFILE_ID, pageNumber, rendered.pageCount,
        rendered.width, rendered.height, rendered.rotation, rendered.pixelSha256, observedBytes);
    const insert = db.prepare('INSERT INTO page_dependencies VALUES (?, ?, ?, ?)');
    for (const n of chunks) insert.run(documentId, PROFILE_ID, pageNumber, n);
  });
  return { documentId, profileId: PROFILE_ID, pageNumber, chunks, observedBytes,
    sourceBytes: document.byte_length, ...rendered };
}

// Return the deduplicated union for one or many pages, coalesced into half-open
// byte ranges. A missing manifest is an error, never an empty dependency set.
export function pageRanges(db, documentId, pageNumbers, profileId = PROFILE_ID) {
  const document = getDocumentRow(db, documentId);
  const manifest = db.prepare(`SELECT 1 FROM page_manifests
    WHERE document_id = ? AND profile_id = ? AND page_number = ?`);
  const deps = db.prepare(`SELECT chunk_number FROM page_dependencies
    WHERE document_id = ? AND profile_id = ? AND page_number = ?`);
  const chunks = new Set();
  for (const pageNumber of new Set(pageNumbers)) {
    if (!manifest.get(documentId, profileId, pageNumber)) {
      throw new Error(`No manifest for page ${pageNumber} and profile ${profileId}`);
    }
    for (const row of deps.all(documentId, profileId, pageNumber)) chunks.add(row.chunk_number);
  }
  const ranges = [];
  for (const n of [...chunks].sort((a, b) => a - b)) {
    const begin = n * document.chunk_size;
    const end = Math.min(begin + document.chunk_size, document.byte_length);
    if (ranges.length && ranges.at(-1)[1] === begin) ranges.at(-1)[1] = end;
    else ranges.push([begin, end]);
  }
  return ranges;
}

// Validation only: fail instead of doing fallback I/O, and compare render pixels.
// A production prefetch cache should fetch missing ranges on demand.
export async function verifyPage(db, documentId, pageNumber, options = {}) {
  const manifest = db.prepare(`SELECT * FROM page_manifests
    WHERE document_id = ? AND profile_id = ? AND page_number = ?`)
    .get(documentId, PROFILE_ID, pageNumber);
  if (!manifest) throw new Error('No manifest for the current rendering profile');
  const allowed = new Set(db.prepare(`SELECT chunk_number FROM page_dependencies
    WHERE document_id = ? AND profile_id = ? AND page_number = ?`)
    .all(documentId, PROFILE_ID, pageNumber).map(row => row.chunk_number));
  const { document, readRange } = makeReader(db, documentId, new Set(), allowed);
  const rendered = await renderColdPage({
    ...options, byteLength: document.byte_length, chunkSize: document.chunk_size,
    readRange, pageNumber,
  });
  if (rendered.pixelSha256 !== manifest.pixel_sha256) {
    throw new Error('Replay pixels differ from the original cold trace');
  }
  return { verified: true, pixelSha256: rendered.pixelSha256 };
}

async function main() {
  const [command, databasePath, ...args] = process.argv.slice(2);
  if (!databasePath || !['add', 'index', 'ranges', 'verify'].includes(command)) {
    throw new Error('Usage: node index.mjs add DB FILE.pdf [CHUNK_SIZE] | ' +
      'index|ranges|verify DB DOCUMENT_SHA256 PAGE [PAGE ...]');
  }
  const db = openDatabase(databasePath);
  try {
    if (command === 'add') {
      console.log(putDocument(db, new Uint8Array(readFileSync(args[0])),
        args[1] === undefined ? 16 * 1024 : Number(args[1])));
      return;
    }
    const [documentId, ...pageArgs] = args;
    if (!pageArgs.length) throw new Error('Specify at least one page number');
    const pages = pageArgs.map(Number);
    if (command === 'ranges') {
      console.log(JSON.stringify(pageRanges(db, documentId, pages)));
    } else {
      for (const page of pages) {
        console.log(JSON.stringify(await (command === 'index' ? indexPage : verifyPage)(
          db, documentId, page
        )));
      }
    }
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
