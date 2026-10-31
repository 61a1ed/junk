import * as pdfjs from '/vendor/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const asset = name => `/vendor/${name}/`;
const assetOptions = {
  cMapUrl: asset('cmaps'),
  cMapPacked: true,
  standardFontDataUrl: asset('standard_fonts'),
  wasmUrl: asset('wasm'),
  iccUrl: asset('iccs'),
};

// A browser cold render has its own identity: Node ingestion manifests are not
// interchangeable with browser canvas pixels or browser range requests.
export const PROFILE = Object.freeze({
  implementation: 'browser-cold-render-v1',
  pdfjsVersion: pdfjs.version,
  pdfjsBuild: pdfjs.build,
  runtime: navigator.userAgent,
  intent: 'display',
  annotationMode: 'DISABLE',
  optionalContent: 'document-default-view',
  scale: 1,
  background: '#ffffff',
  useSystemFonts: false,
  disableFontFace: true,
  enableXfa: false,
  stopAtErrors: true,
  isEvalSupported: false,
});

async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('This workbench needs a secure browser context. Open it on localhost or HTTPS.');
  }
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

let profileIdPromise;
const getProfileId = () => profileIdPromise ??= sha256(new TextEncoder().encode(JSON.stringify(PROFILE)));
let databaseWorker;
let sequence = 0;
let disposed = false;
let workerFailure;
let busy = false;
let activity = null;
const requests = new Map();
const queryWorkers = new Map();
let queryCount = 0;

function rejectDatabaseRequests(error) {
  workerFailure = error;
  for (const request of requests.values()) request.reject(error);
  requests.clear();
}

function rpc(action, payload = {}, transfer = []) {
  if (disposed) return Promise.reject(new Error('The browser database session has been closed. Reload to start a new session.'));
  if (workerFailure) return Promise.reject(workerFailure);
  if (!databaseWorker) {
    databaseWorker = new Worker('/database-worker.js');
    databaseWorker.onmessage = ({ data }) => {
      const request = requests.get(data.id);
      if (!request) return;
      requests.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.result);
    };
    databaseWorker.onerror = event => {
      event.preventDefault();
      rejectDatabaseRequests(new Error(event.message || 'Unable to initialize browser SQLite. Reload to retry.'));
      databaseWorker.terminate();
    };
    databaseWorker.onmessageerror = () => rejectDatabaseRequests(new Error('The database worker returned an unreadable message.'));
  }
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    requests.set(id, { resolve, reject });
    try { databaseWorker.postMessage({ id, action, payload }, transfer); }
    catch (error) { requests.delete(id); reject(error); }
  });
}

async function mutate(label, callback) {
  if (busy) throw new Error(`Database is busy: ${activity}`);
  busy = true;
  activity = label;
  try { return await callback(); }
  finally { busy = false; activity = null; }
}

function parseBody(options) {
  try {
    const value = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new Error('Invalid request body'); }
}

function choosePages(body, document) {
  if (!Array.isArray(body.pages) || !body.pages.length || body.pages.length > 100) {
    throw new Error('Choose between 1 and 100 pages');
  }
  if (body.pages.some(page => !Number.isSafeInteger(page) || page < 1 || page > document.page_count)) {
    throw new Error(`Pages must be integers between 1 and ${document.page_count}`);
  }
  return [...new Set(body.pages)];
}

async function inspectPdf(bytes) {
  let task;
  let timer;
  try {
    // PDF.js transfers this copy to its renderer worker. The original bytes are
    // retained unchanged for insertion into the SQLite worker after validation.
    task = pdfjs.getDocument({
      ...assetOptions,
      data: bytes.slice(),
      useSystemFonts: false,
      enableXfa: false,
      stopAtErrors: true,
      isEvalSupported: false,
    });
    const inspect = async () => {
      const document = await task.promise;
      if (await document.getPermissions() !== null) throw new Error('Encrypted PDFs are not supported. Upload an unencrypted copy.');
      if (!Number.isSafeInteger(document.numPages) || document.numPages < 1 || document.numPages > 10000) {
        throw new Error('PDF must contain between 1 and 10,000 pages');
      }
      await document.getPage(1);
      return document.numPages;
    };
    return await Promise.race([
      inspect(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PDF validation timed out')), 15000); }),
    ]);
  } catch (error) {
    if (error.name === 'PasswordException') throw new Error('Encrypted PDFs are not supported. Upload an unencrypted copy.');
    throw new Error(`Unable to read PDF: ${error.message}`);
  } finally {
    clearTimeout(timer);
    await task?.destroy().catch(() => {});
  }
}

async function upload(url, options) {
  const file = options.body;
  if (!(file instanceof Blob)) throw new Error('Choose a PDF file to upload');
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('File exceeds the 25 MB limit.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length < 8 || new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') {
    throw new Error('This file does not have a PDF header');
  }
  const chunkSize = Number(url.searchParams.get('chunkSize') ?? 16384);
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1024 || chunkSize > 1024 * 1024 || Math.log2(chunkSize) % 1 !== 0) {
    throw new Error('Chunk size must be a power of two from 1 KiB to 1 MiB');
  }
  const filename = (url.searchParams.get('filename') || file.name || 'document.pdf')
    .split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240) || 'document.pdf';
  const pageCount = await inspectPdf(bytes);
  activity = `Storing ${filename} in browser SQLite`;
  return rpc('put-document', { bytes, filename, pageCount, chunkSize }, [bytes.buffer]);
}

async function renderColdPage(document, pageNumber, allowedChunks) {
  const seen = new Set();
  let task;
  let canvas;
  let stopped = false;
  let failed = false;
  let rejectFailure;
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  // Range callbacks run outside the main rendering promise. Forward failures so
  // a missing chunk cannot leave PDF.js waiting indefinitely for a range reply.
  const fail = error => {
    if (failed || stopped) return;
    failed = true;
    rejectFailure(error);
    void task?.destroy().catch(() => {});
  };
  const timer = setTimeout(() => fail(new Error('Page trace timed out')), 60000);
  const readRange = async (begin, end) => {
    if (stopped || failed) throw new Error('Page trace cancelled');
    const result = await rpc('read-range', { id: document.document_id, begin, end, allowedChunks });
    if (stopped || failed) throw new Error('Page trace cancelled');
    for (const chunk of result.chunks) seen.add(chunk);
    return result.bytes;
  };
  const work = async () => {
    const prefix = await readRange(0, Math.min(document.chunk_size, document.byte_length));
    const transport = new pdfjs.PDFDataRangeTransport(document.byte_length, Uint8Array.from(prefix), true);
    transport.requestDataRange = (begin, end) => {
      Promise.resolve().then(async () => {
        if (stopped || failed) return;
        const bytes = await readRange(begin, end);
        if (!stopped && !failed) transport.onDataRange(begin, Uint8Array.from(bytes));
      }).catch(fail);
    };
    transport.abort = () => { stopped = true; };
    task = pdfjs.getDocument({
      ...assetOptions,
      range: transport,
      rangeChunkSize: document.chunk_size,
      disableAutoFetch: true,
      disableStream: true,
      disableRange: false,
      useWorkerFetch: false,
      useSystemFonts: PROFILE.useSystemFonts,
      disableFontFace: PROFILE.disableFontFace,
      enableXfa: PROFILE.enableXfa,
      stopAtErrors: PROFILE.stopAtErrors,
      isEvalSupported: PROFILE.isEvalSupported,
    });
    task.onPassword = () => fail(new Error('Encrypted PDFs are not supported'));
    const pdf = await task.promise;
    const pdfPage = await pdf.getPage(pageNumber);
    if (pdfPage.isPureXfa) throw new Error('Pure XFA rendering is outside this profile');
    const viewport = pdfPage.getViewport({ scale: PROFILE.scale });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 20000000) {
      throw new Error('Page exceeds the tracing canvas pixel limit');
    }
    canvas = globalThis.document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('A 2D canvas is required to trace PDF pages');
    await pdfPage.render({
      canvasContext: context,
      viewport,
      intent: PROFILE.intent,
      background: PROFILE.background,
      annotationMode: pdfjs.AnnotationMode.DISABLE,
    }).promise;
    const pixelSha256 = await sha256(context.getImageData(0, 0, width, height).data);
    const chunks = [...seen].sort((a, b) => a - b);
    const observedBytes = chunks.reduce((sum, n) => sum + Math.min(document.chunk_size, document.byte_length - n * document.chunk_size), 0);
    return {
      documentId: document.document_id,
      profileId: await getProfileId(),
      pageNumber,
      pageCount: pdf.numPages,
      width: viewport.width,
      height: viewport.height,
      rotation: pdfPage.rotate,
      pixelSha256,
      chunks,
      observedBytes,
      sourceBytes: document.byte_length,
    };
  };
  try { return await Promise.race([work(), failure]); }
  finally {
    clearTimeout(timer);
    stopped = true;
    await task?.destroy().catch(() => {});
    if (canvas) canvas.width = canvas.height = 1;
  }
}

async function traceOrVerify(id, action, options) {
  const profileId = await getProfileId();
  const { document } = await rpc('detail', { id, profileId });
  const pages = choosePages(parseBody(options), document);
  const results = [];
  for (const pageNumber of pages) {
    activity = `${action === 'index' ? 'Tracing' : 'Verifying'} page ${pageNumber}`;
    try {
      if (action === 'index') {
        const result = await renderColdPage(document, pageNumber);
        await rpc('save-manifest', { id, profileId, profile: PROFILE, result });
        results.push({ pageNumber, success: true, ...result });
      } else {
        const { manifest } = await rpc('manifest', { id, profileId, pageNumber });
        if (!manifest) throw new Error('No manifest for the current rendering profile');
        const result = await renderColdPage(document, pageNumber, manifest.chunks);
        if (result.pixelSha256 !== manifest.pixel_sha256) throw new Error('Replay pixels differ from the original cold trace');
        results.push({ pageNumber, success: true, verified: true, pixelSha256: result.pixelSha256 });
      }
    } catch (error) { results.push({ pageNumber, success: false, error: error.message }); }
  }
  return { results };
}

async function query(sql) {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > 20000) throw new Error('Enter a SQL query of at most 20,000 characters');
  if (queryCount >= 2) throw new Error('Two SQL queries are already running');
  queryCount++;
  try {
    const { bytes: snapshot } = await rpc('snapshot');
    if (disposed) throw new Error('The browser database session is closed');
    return await new Promise((resolve, reject) => {
      const worker = new Worker('/query-worker.js');
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        queryWorkers.delete(worker);
        worker.terminate();
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error('Query timed out. Add a LIMIT or simplify the query.')), 2000);
      queryWorkers.set(worker, finish);
      worker.onmessage = ({ data }) => data.error ? finish(new Error(data.error)) : finish(null, data.result ?? data);
      worker.onerror = event => { event.preventDefault(); finish(new Error(event.message || 'Query worker failed')); };
      worker.onmessageerror = () => finish(new Error('The query worker returned an unreadable result'));
      try { worker.postMessage({ snapshot, sql }, [snapshot.buffer]); }
      catch (error) { finish(error); }
    });
  } finally { queryCount--; }
}

export async function getDocumentBytes(id) {
  const { bytes } = await rpc('source', { id });
  return bytes;
}

export async function readDocumentRange(id, begin, end) {
  const { bytes } = await rpc('read-range', { id, begin, end });
  return bytes;
}

// The interface intentionally mirrors the UI's former routes without performing
// any HTTP requests: PDF contents cross only the local browser Worker boundary.
export async function clientRequest(path, options = {}) {
  const url = new URL(path, 'https://browser-local.invalid');
  const method = options.method?.toUpperCase() || 'GET';
  if (method === 'GET' && url.pathname === '/state') {
    const profileId = await getProfileId();
    return { ...await rpc('state', { profileId }), profile: PROFILE, profileId, busy, activity };
  }
  if (method === 'POST' && url.pathname === '/documents') return mutate('Validating PDF upload', () => upload(url, options));
  if (method === 'GET' && url.pathname === '/schema') return rpc('schema');
  if (method === 'POST' && url.pathname === '/query') return query(parseBody(options).sql);
  if (method === 'POST' && url.pathname === '/reset') return mutate('Resetting browser database', () => rpc('reset'));
  const match = /^\/documents\/([a-f0-9]{64})(?:\/(index|verify|ranges))?$/.exec(url.pathname);
  if (match) {
    const [, id, action] = match;
    if (method === 'GET' && !action) return rpc('detail', { id, profileId: await getProfileId() });
    if (method === 'DELETE' && !action) return mutate('Deleting document', () => rpc('delete', { id }));
    if (method === 'POST' && ['index', 'verify'].includes(action)) return mutate('Preparing page render', () => traceOrVerify(id, action, options));
    if (method === 'POST' && action === 'ranges') {
      const profileId = await getProfileId();
      const { document } = await rpc('detail', { id, profileId });
      return rpc('ranges', { id, profileId, pages: choosePages(parseBody(options), document) });
    }
  }
  throw new Error('Unsupported browser database operation');
}

export function dispose() {
  if (disposed) return;
  disposed = true;
  const error = new Error('The browser database session has been closed');
  rejectDatabaseRequests(error);
  databaseWorker?.terminate();
  for (const finish of queryWorkers.values()) finish(error);
}
