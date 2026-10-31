/* The live database exists only in this worker's memory, for this browser tab. */
importScripts('/vendor/sql-wasm.js');

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_SESSION_BYTES = 100 * 1024 * 1024;
let db;
const ready = (async () => {
  const SQL = await initSqlJs({ locateFile: file => `/vendor/${file}` });
  const response = await fetch('/schema.sql');
  if (!response.ok) throw new Error('Unable to load the database schema.');
  const schema = await response.text();
  db = new SQL.Database();
  db.run(schema);
  db.run(`CREATE TABLE upload_metadata (
    document_id TEXT PRIMARY KEY REFERENCES documents ON DELETE CASCADE,
    filename TEXT NOT NULL,
    page_count INTEGER NOT NULL
  ) STRICT`);
})();
// An initialization error is returned by the first request, not left unhandled.
ready.catch(() => {});

function rows(sql, parameters = []) {
  const statement = db.prepare(sql);
  try {
    statement.bind(parameters);
    const result = [];
    while (statement.step()) result.push(statement.getAsObject());
    return result;
  } finally { statement.free(); }
}

function one(sql, parameters = []) {
  const statement = db.prepare(sql);
  try {
    statement.bind(parameters);
    return statement.step() ? statement.getAsObject() : null;
  } finally { statement.free(); }
}

function transaction(callback) {
  db.run('BEGIN IMMEDIATE');
  try {
    const value = callback();
    db.run('COMMIT');
    return value;
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

const documentSelect = `SELECT d.*, u.filename, u.page_count,
  (SELECT count(*) FROM document_chunks c WHERE c.document_id = d.document_id) AS chunk_count,
  (SELECT count(DISTINCT m.page_number) FROM page_manifests m
   WHERE m.document_id = d.document_id AND (? IS NULL OR m.profile_id = ?)) AS indexed_pages
  FROM documents d JOIN upload_metadata u USING (document_id)`;

function documentRow(id, profileId = null) {
  const document = one(`${documentSelect} WHERE d.document_id = ?`, [profileId, profileId, id]);
  if (!document) throw new Error('Document not found.');
  return document;
}

function manifestRow(id, profileId, pageNumber) {
  const manifest = one(`SELECT * FROM page_manifests
    WHERE document_id = ? AND profile_id = ? AND page_number = ?`, [id, profileId, pageNumber]);
  if (!manifest) return null;
  manifest.chunks = rows(`SELECT chunk_number FROM page_dependencies
    WHERE document_id = ? AND profile_id = ? AND page_number = ? ORDER BY chunk_number`,
  [id, profileId, pageNumber]).map(row => row.chunk_number);
  return manifest;
}

function validateProfileId(profileId) {
  if (typeof profileId !== 'string' || !profileId || profileId.length > 200) throw new Error('Invalid rendering profile.');
}

function validatePage(pageNumber, pageCount) {
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) {
    throw new Error(`Pages must be integers between 1 and ${pageCount}.`);
  }
}

function readRange({ id, begin, end, allowedChunks }) {
  const document = documentRow(id);
  if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) ||
      begin < 0 || end <= begin || end > document.byte_length) throw new Error(`Invalid byte range [${begin}, ${end}).`);
  if (allowedChunks !== undefined && !(allowedChunks instanceof Set) && !Array.isArray(allowedChunks)) {
    throw new Error('Allowed chunks must be a list.');
  }
  const allowed = allowedChunks === undefined ? null : new Set(allowedChunks);
  const first = Math.floor(begin / document.chunk_size);
  const last = Math.floor((end - 1) / document.chunk_size);
  const bytes = new Uint8Array(end - begin);
  const chunks = [];
  const lookup = db.prepare('SELECT data FROM document_chunks WHERE document_id = ? AND chunk_number = ?');
  try {
    for (let n = first; n <= last; n++) {
      if (allowed && !allowed.has(n)) throw new Error(`Manifest miss: chunk ${n}, requested [${begin}, ${end}).`);
      lookup.bind([id, n]);
      const data = lookup.step() ? lookup.get()[0] : null;
      const chunkStart = n * document.chunk_size;
      const expectedLength = Math.min(document.chunk_size, document.byte_length - chunkStart);
      if (!(data instanceof Uint8Array) || data.length !== expectedLength) throw new Error(`Missing or truncated source chunk ${n}.`);
      const from = Math.max(begin, chunkStart);
      const to = Math.min(end, chunkStart + data.length);
      bytes.set(data.subarray(from - chunkStart, to - chunkStart), from - begin);
      chunks.push(n);
      lookup.reset();
    }
  } finally { lookup.free(); }
  return { bytes, chunks };
}

async function putDocument({ bytes, filename, pageCount, chunkSize = 16384 }) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8 ||
      String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') throw new Error('This file does not have a PDF header.');
  if (bytes.length > MAX_FILE_BYTES) throw new Error('File exceeds the 25 MB limit.');
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 10000) throw new Error('PDF must contain between 1 and 10,000 pages.');
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1024 || chunkSize > 1024 * 1024 ||
      Math.log2(chunkSize) % 1 !== 0) throw new Error('Chunk size must be a power of two from 1 KB to 1 MB.');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const id = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  if (one('SELECT 1 FROM documents WHERE document_id = ?', [id])) {
    const document = documentRow(id);
    if (document.chunk_size !== chunkSize) throw new Error('This PDF already exists with a different chunk size. Delete it before changing the chunk size.');
    return { document, duplicate: true };
  }
  const sourceBytes = one('SELECT coalesce(sum(byte_length), 0) AS n FROM documents').n;
  if (sourceBytes + bytes.length > MAX_SESSION_BYTES) throw new Error('The session has reached its 100 MB source-file limit. Delete documents or reset the session.');
  const cleanName = String(filename || 'document.pdf').replaceAll('\\', '/').split('/').at(-1)
    .replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240) || 'document.pdf';
  transaction(() => {
    db.run('INSERT INTO documents VALUES (?, ?, ?, CURRENT_TIMESTAMP)', [id, bytes.length, chunkSize]);
    db.run('INSERT INTO upload_metadata VALUES (?, ?, ?)', [id, cleanName, pageCount]);
    const insert = db.prepare('INSERT INTO document_chunks VALUES (?, ?, ?)');
    try {
      for (let start = 0; start < bytes.length; start += chunkSize) {
        insert.run([id, start / chunkSize, bytes.subarray(start, start + chunkSize)]);
      }
    } finally { insert.free(); }
  });
  return { document: documentRow(id), duplicate: false };
}

function saveManifest({ id, profileId, profile, result }) {
  validateProfileId(profileId);
  const document = documentRow(id, profileId);
  if (!result || !profile || typeof profile !== 'object') throw new Error('Missing render result or profile.');
  validatePage(result.pageNumber, document.page_count);
  if (result.pageCount !== document.page_count) throw new Error('Rendered page count differs from the uploaded document.');
  if (!Number.isFinite(result.width) || result.width <= 0 || !Number.isFinite(result.height) || result.height <= 0 ||
      !Number.isSafeInteger(result.rotation)) throw new Error('Invalid rendered page dimensions.');
  if (typeof result.pixelSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.pixelSha256)) throw new Error('Invalid rendered pixel hash.');
  if (!Array.isArray(result.chunks) || !result.chunks.length || result.chunks.some(n =>
    !Number.isSafeInteger(n) || n < 0 || n >= document.chunk_count)) throw new Error('Invalid chunk dependencies.');
  const chunks = [...new Set(result.chunks)].sort((a, b) => a - b);
  const observedBytes = chunks.reduce((sum, n) => sum + Math.min(document.chunk_size, document.byte_length - n * document.chunk_size), 0);
  if (result.observedBytes !== observedBytes) throw new Error('Observed byte count does not match the dependency chunks.');
  const settings = JSON.stringify(profile);
  transaction(() => {
    const existing = one('SELECT settings_json FROM render_profiles WHERE profile_id = ?', [profileId]);
    if (existing && existing.settings_json !== settings) throw new Error('Rendering profile ID already has different settings.');
    db.run('INSERT OR IGNORE INTO render_profiles VALUES (?, ?)', [profileId, settings]);
    db.run('DELETE FROM page_manifests WHERE document_id = ? AND profile_id = ? AND page_number = ?',
      [id, profileId, result.pageNumber]);
    db.run(`INSERT INTO page_manifests
      (document_id, profile_id, page_number, page_count, width, height, rotation, pixel_sha256, observed_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, profileId, result.pageNumber, result.pageCount, result.width, result.height, result.rotation, result.pixelSha256, observedBytes]);
    const insert = db.prepare('INSERT INTO page_dependencies VALUES (?, ?, ?, ?)');
    try { for (const chunk of chunks) insert.run([id, profileId, result.pageNumber, chunk]); }
    finally { insert.free(); }
  });
  return { manifest: manifestRow(id, profileId, result.pageNumber) };
}

function rangesForPages({ id, profileId, pages }) {
  validateProfileId(profileId);
  const document = documentRow(id, profileId);
  if (!Array.isArray(pages) || !pages.length || pages.length > 100) throw new Error('Choose between 1 and 100 pages.');
  const used = new Set();
  for (const pageNumber of new Set(pages)) {
    validatePage(pageNumber, document.page_count);
    const manifest = manifestRow(id, profileId, pageNumber);
    if (!manifest) throw new Error(`No manifest for page ${pageNumber} and the current rendering profile.`);
    for (const chunk of manifest.chunks) used.add(chunk);
  }
  const chunks = [...used].sort((a, b) => a - b);
  const ranges = [];
  for (const chunk of chunks) {
    const begin = chunk * document.chunk_size;
    const end = Math.min(begin + document.chunk_size, document.byte_length);
    if (ranges.length && ranges.at(-1)[1] === begin) ranges.at(-1)[1] = end;
    else ranges.push([begin, end]);
  }
  return { ranges, chunks, sourceBytes: document.byte_length, bytes: ranges.reduce((sum, [begin, end]) => sum + end - begin, 0) };
}

async function handle(action, payload = {}) {
  switch (action) {
    case 'state': {
      const profileId = payload.profileId ?? null;
      return {
        documents: rows(`${documentSelect} ORDER BY d.created_at DESC, u.filename`, [profileId, profileId]),
        stats: {
          documents: one('SELECT count(*) AS n FROM documents').n,
          chunks: one('SELECT count(*) AS n FROM document_chunks').n,
          manifests: one('SELECT count(*) AS n FROM page_manifests').n,
          sourceBytes: one('SELECT coalesce(sum(byte_length), 0) AS n FROM documents').n,
        },
      };
    }
    case 'put-document': return putDocument(payload);
    case 'detail': {
      validateProfileId(payload.profileId);
      const document = documentRow(payload.id, payload.profileId);
      const pages = rows('SELECT page_number FROM page_manifests WHERE document_id = ? AND profile_id = ? ORDER BY page_number',
        [payload.id, payload.profileId]);
      return { document, manifests: pages.map(row => manifestRow(payload.id, payload.profileId, row.page_number)) };
    }
    case 'source': {
      const document = documentRow(payload.id);
      return { bytes: readRange({ id: payload.id, begin: 0, end: document.byte_length }).bytes };
    }
    case 'read-range': return readRange(payload);
    case 'save-manifest': return saveManifest(payload);
    case 'manifest': {
      validateProfileId(payload.profileId);
      const document = documentRow(payload.id);
      validatePage(payload.pageNumber, document.page_count);
      return { manifest: manifestRow(payload.id, payload.profileId, payload.pageNumber) };
    }
    case 'ranges': return rangesForPages(payload);
    case 'delete':
      documentRow(payload.id);
      db.run('DELETE FROM documents WHERE document_id = ?', [payload.id]);
      return { deleted: true };
    case 'reset':
      transaction(() => { db.run('DELETE FROM documents; DELETE FROM render_profiles;'); });
      return { reset: true };
    case 'schema': {
      const tables = rows("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
      return { tables: tables.map(table => {
        const name = `"${table.name.replaceAll('"', '""')}"`;
        return {
          ...table,
          columns: rows(`PRAGMA table_info(${name})`).map(({ name, type, pk, notnull }) => ({ name, type, pk, notnull })),
          rowCount: one(`SELECT count(*) AS n FROM ${name}`).n,
        };
      }) };
    }
    case 'snapshot': {
      const bytes = db.export();
      // sql.js export reopens its connection, resetting connection PRAGMAs.
      db.run('PRAGMA foreign_keys = ON');
      return { bytes };
    }
    default: throw new Error(`Unknown database action: ${action}`);
  }
}

let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  const { id, action, payload } = data || {};
  const request = queue.then(() => ready).then(() => handle(action, payload));
  queue = request.catch(() => {});
  request.then(result => {
    const transfer = result?.bytes instanceof Uint8Array ? [result.bytes.buffer] : [];
    self.postMessage({ id, result }, transfer);
  }, error => self.postMessage({ id, error: error.message || String(error) }));
};
