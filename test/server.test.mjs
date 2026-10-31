import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createDebugServer } from '../server.mjs';

await test('development server only serves assets and rejects database operations', async () => {
  const { server } = createDebugServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const route of ['/', '/app.js', '/client-db.js', '/database-worker.js', '/query-worker.js', '/schema.sql', '/vendor/sql-wasm.js', '/vendor/sql-wasm.wasm', '/vendor/pdf.mjs', '/vendor/pdf.worker.mjs']) {
      const response = await fetch(origin + route);
      assert.equal(response.status, 200, route);
      if (route.endsWith('.wasm')) assert.equal(response.headers.get('content-type'), 'application/wasm');
      await response.body.cancel();
    }
    const sample = await fetch(origin + '/sample.pdf');
    assert.equal(sample.headers.get('content-type'), 'application/pdf');
    assert.equal(new TextDecoder().decode((await sample.arrayBuffer()).slice(0, 5)), '%PDF-');
    for (const route of ['/api/state', '/api/documents', '/api/query']) {
      assert.equal((await fetch(origin + route)).status, 404);
      assert.equal((await fetch(origin + route, { method: 'POST', body: 'no PDF or SQL is accepted' })).status, 405);
    }
    for (const route of ['/vendor/package.json', '/..%2fpackage.json', '/vendor/..%2fpackage.json']) {
      assert.equal((await fetch(origin + route)).status, 404);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
