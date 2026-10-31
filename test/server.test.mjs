import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createDebugServer } from '../server.mjs';
import { makeFixturePdf } from './fixture.mjs';

async function startServer(options = {}) {
  const { server } = createDebugServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
    async json(route, body, method = 'POST') {
      const response = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    },
    async upload(bytes, name = 'fixture.pdf', chunkSize = 16384) {
      const response = await fetch(`${base}/api/documents?filename=${encodeURIComponent(name)}&chunkSize=${chunkSize}`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: bytes });
      return { status: response.status, body: await response.json() };
    },
  };
}

await test('HTTP session uploads exact PDF bytes, indexes, inspects ranges, verifies, and deletes', async () => {
  const app = await startServer();
  try {
    const initial = await app.json('/api/state', undefined, 'GET');
    assert.equal(initial.body.stats.documents, 0);
    assert.equal(initial.body.busy, false);
    const bytes = makeFixturePdf();
    const uploaded = await app.upload(bytes, 'range-debug.pdf');
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.body.document.filename, 'range-debug.pdf');
    assert.equal(uploaded.body.document.page_count, 3);
    assert.equal(uploaded.body.document.indexed_pages, 0, 'Upload must not cold-index implicitly');
    const id = uploaded.body.document.document_id;
    assert.deepEqual(new Uint8Array(await (await fetch(`${app.base}/api/documents/${id}/pdf`)).arrayBuffer()), bytes);
    const duplicate = await app.upload(bytes);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal((await app.upload(bytes, 'other.pdf', 32768)).status, 409);
    const missing = await app.json(`/api/documents/${id}/ranges`, { pages: [1] });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /No manifest/);
    const indexed = await app.json(`/api/documents/${id}/index`, { pages: [1, 2, 1] });
    assert.equal(indexed.status, 200);
    assert.equal(indexed.body.results.length, 2);
    assert.ok(indexed.body.results.every(result => result.success));
    const detail = (await app.json(`/api/documents/${id}`, undefined, 'GET')).body;
    assert.equal(detail.manifests.length, 2);
    assert.equal(detail.document.indexed_pages, 2);
    assert.ok(detail.manifests[0].chunks.includes(0));
    const ranges = (await app.json(`/api/documents/${id}/ranges`, { pages: [1, 2] })).body;
    assert.ok(ranges.ranges.length >= 1);
    assert.equal(ranges.bytes, ranges.ranges.reduce((sum, [start, end]) => sum + end - start, 0));
    assert.ok(ranges.bytes < ranges.sourceBytes);
    const verified = (await app.json(`/api/documents/${id}/verify`, { pages: [1, 2, 3] })).body.results;
    assert.equal(verified[0].verified, true);
    assert.equal(verified[1].verified, true);
    assert.equal(verified[2].success, false);
    assert.match(verified[2].error, /No manifest/);
    assert.equal((await app.json(`/api/documents/${id}/index`, { pages: [4] })).status, 400);
    const schema = (await app.json('/api/schema', undefined, 'GET')).body;
    assert.equal(schema.tables.find(table => table.name === 'document_chunks').rowCount, Math.ceil(bytes.length / 16384));
    assert.equal((await app.json(`/api/documents/${id}`, undefined, 'DELETE')).body.deleted, true);
    const after = (await app.json('/api/state', undefined, 'GET')).body;
    assert.equal(after.stats.documents, 0);
    assert.equal(after.stats.chunks, 0);
    assert.equal(after.stats.manifests, 0);
  } finally { await app.close(); }
});

await test('SQL console reads real SQLite, bounds output, blocks writes, and times out without stopping HTTP', async () => {
  const app = await startServer({ queryTimeoutMs: 500 });
  try {
    await app.upload(makeFixturePdf());
    const query = await app.json('/api/query', { sql: 'SELECT filename, page_count FROM upload_metadata' });
    assert.equal(query.status, 200);
    assert.deepEqual(query.body.columns, ['filename', 'page_count']);
    assert.deepEqual(query.body.rows, [['fixture.pdf', 3]]);
    const blob = await app.json('/api/query', { sql: 'SELECT data FROM document_chunks LIMIT 1' });
    assert.match(blob.body.rows[0][0], /BLOB.*16384 bytes/);
    const capped = await app.json('/api/query', { sql: 'WITH RECURSIVE seq(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM seq WHERE x<800) SELECT x FROM seq' });
    assert.equal(capped.body.rows.length, 500);
    assert.equal(capped.body.truncated, true);
    for (const sql of ['DELETE FROM documents', 'PRAGMA query_only = OFF', "ATTACH DATABASE '/tmp/debug-query-test.db' AS bad", 'SELECT load_extension(\'bad\')']) {
      const result = await app.json('/api/query', { sql });
      assert.equal(result.status, 400, sql);
    }
    assert.equal((await app.json('/api/query', { sql: 'SELECT 1; SELECT 2;' })).status, 400);
    const pending = app.json('/api/query', { sql: 'WITH RECURSIVE seq(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM seq) SELECT sum(x) FROM seq' });
    const live = await app.json('/api/state', undefined, 'GET');
    assert.equal(live.status, 200);
    assert.equal(live.body.stats.documents, 1);
    assert.equal((await pending).status, 408);
    assert.equal((await app.json('/api/query', { sql: 'SELECT count(*) FROM documents' })).body.rows[0][0], 1);
  } finally { await app.close(); }
});

await test('input validation, session reset, and loopback request guards', async () => {
  const app = await startServer({ maxUploadBytes: 2 * 1024 * 1024 });
  try {
    assert.equal((await app.upload(new TextEncoder().encode('not a pdf'))).status, 400);
    assert.equal((await app.upload(new TextEncoder().encode('%PDF-1.7\ninvalid'))).status, 400);
    assert.equal((await app.upload(makeFixturePdf(), 'sample.pdf', 3000)).status, 400);
    assert.equal((await app.upload(new Uint8Array(3 * 1024 * 1024))).status, 413);
    const crossOrigin = await fetch(`${app.base}/api/reset`, { method: 'POST', headers: { Origin: 'https://example.com' } });
    assert.equal(crossOrigin.status, 403);
    const rebindingStatus = await new Promise((resolve, reject) => {
      http.get(`${app.base}/api/state`, { headers: { Host: 'attacker.example' } }, response => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(rebindingStatus, 403);
    const sample = await fetch(`${app.base}/api/sample.pdf`);
    assert.equal(sample.headers.get('content-type'), 'application/pdf');
    assert.equal((await app.upload(new Uint8Array(await sample.arrayBuffer()))).status, 201);
    assert.equal((await app.json('/api/reset', {})).body.reset, true);
    assert.equal((await app.json('/api/state', undefined, 'GET')).body.stats.sourceBytes, 0);
    const vendor = await fetch(`${app.base}/vendor/pdf.worker.mjs`);
    assert.equal(vendor.status, 200);
    assert.match(vendor.headers.get('content-type'), /javascript/);
    await vendor.body.cancel();
    assert.equal((await fetch(`${app.base}/vendor/package.json`)).status, 404);
  } finally { await app.close(); }
});

await test('an in-progress upload blocks conflicting mutations while state remains readable', async () => {
  const app = await startServer();
  let upload;
  try {
    const bytes = makeFixturePdf();
    const completed = new Promise((resolve, reject) => {
      upload = http.request(`${app.base}/api/documents?filename=slow.pdf`, {
        method: 'POST', headers: { 'Content-Type': 'application/pdf', 'Content-Length': bytes.length },
      }, response => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      }).on('error', reject);
      upload.write(bytes.subarray(0, 16));
    });
    completed.catch(() => {});
    let state;
    for (let n = 0; n < 20; n++) {
      state = (await app.json('/api/state', undefined, 'GET')).body;
      if (state.busy) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(state.busy, true);
    assert.equal((await app.json('/api/reset', {})).status, 409);
    upload.end(bytes.subarray(16));
    assert.equal(await completed, 201);
    assert.equal((await app.json('/api/state', undefined, 'GET')).body.busy, false);
  } finally { upload?.destroy(); await app.close(); }
});
