import test from 'node:test';
import assert from 'node:assert/strict';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createRangeSource } from '../public/reader-transport.js';

const options = { byteLength: 4096, chunkSize: 1024, filename: 'custom.pdf' };

await test('reader requests storage ranges asynchronously and copies storage buffers', async () => {
  const bytes = new Uint8Array(4096).map((_, index) => index % 251);
  const reads = [];
  const source = await createRangeSource(pdfjs, { ...options, readRange(begin, end) {
    reads.push([begin, end]);
    return bytes.subarray(begin, end);
  } });
  try {
    assert.equal(source.transport.contentDispositionFilename, 'custom.pdf');
    assert.deepEqual(reads, [[0, 1024]]);
    source.transport.initialData.fill(0);
    assert.equal(bytes[1], 1);
    const response = Promise.withResolvers();
    source.transport.requestDataRange(2048, 3072);
    source.transport.transportReady(response.resolve);
    const event = await response.promise;
    assert.equal(event.begin, 2048);
    assert.deepEqual(event.chunk, bytes.subarray(2048, 3072));
    assert.deepEqual(reads, [[0, 1024], [2048, 3072]]);
  } finally { source.abort(); }
});

for (const mode of ['reject', 'truncate', 'timeout']) {
  await test(`reader propagates ${mode} failures instead of leaving PDF.js waiting`, async () => {
    const errors = [];
    const source = await createRangeSource(pdfjs, { ...options, timeoutMs: 20,
      onError: error => errors.push(error),
      readRange(begin, end) {
        if (begin === 0) return new Uint8Array(end);
        if (mode === 'reject') throw new Error('Storage unavailable');
        if (mode === 'truncate') return new Uint8Array(1);
        return new Promise(() => {});
      },
    });
    source.transport.transportReady(() => assert.fail('Failed reads must not reach PDF.js'));
    source.transport.requestDataRange(2048, 3072);
    await assert.rejects(source.failure, /Storage unavailable|Incomplete PDF byte range|timed out/);
    assert.equal(errors.length, 1);
  });
}

await test('closing the viewer ignores late storage responses and rejects pending waits', async () => {
  const pending = Promise.withResolvers();
  const source = await createRangeSource(pdfjs, { ...options,
    readRange: (begin, end) => begin === 0 ? new Uint8Array(end) : pending.promise,
    onError: () => assert.fail('Normal close must not report a storage error'),
  });
  source.transport.transportReady(() => assert.fail('Closed transport received data'));
  source.transport.requestDataRange(1024, 2048);
  source.transport.abort();
  pending.resolve(new Uint8Array(1024));
  await assert.rejects(source.failure, /cancelled/);
});
