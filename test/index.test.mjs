import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  openDatabase, putDocument, indexPage, verifyPage, pageRanges,
  renderColdPage, PROFILE, PROFILE_ID,
} from '../index.mjs';
import { makeFixturePdf, makeIncrementalFixturePdf, makeObjectStreamFixturePdf } from './fixture.mjs';
import { pdfjsAssetDirectory } from '../pdfjs-assets.mjs';
import { encodePdfAddress } from '../public/pdf-address.js';

await test('page refs, regions and dependencies use manifest IDs and cascade on replacement/deletion', async () => {
  const db = openDatabase(':memory:');
  try {
    const id = putDocument(db, makeFixturePdf());
    await indexPage(db, id, 2);
    const manifest = db.prepare('SELECT * FROM page_manifests').get();
    assert.equal(manifest.ref, encodePdfAddress({ documentId: id, profileId: PROFILE_ID, pageNumber: 2 }));
    assert.throws(() => db.prepare("UPDATE page_manifests SET ref = 'incorrect'").run(), /generated column/);
    const insert = db.prepare('INSERT INTO page_regions(name, page_manifest_id, bounds) VALUES (?, ?, ?)');
    for (const bounds of ['[0,0,0,5]', '[5,0,2,5]', '[0,0,null,5]', '[0,0,"5",5]', '[0,0,5]', '{}']) {
      assert.throws(() => insert.run('bad', manifest.id, bounds));
    }
    assert.throws(() => insert.run('', manifest.id, '[0,0,5,5]'));
    assert.throws(() => insert.run('orphan', manifest.id + 100, '[0,0,5,5]'));
    insert.run('first', manifest.id, '[0,0,50,50]');
    const region = db.prepare('SELECT * FROM page_regions').get();
    assert.equal(region.ref, `pdf:region:v1:${region.id}`);
    assert.deepEqual(JSON.parse(region.bounds), [0, 0, 50, 50]);
    await indexPage(db, id, 2);
    const replacement = db.prepare('SELECT id FROM page_manifests').get().id;
    assert.notEqual(replacement, manifest.id);
    assert.equal(db.prepare('SELECT count(*) AS n FROM page_regions').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM page_dependencies WHERE page_manifest_id = ?').get(manifest.id).n, 0);
    insert.run('second', replacement, '[0,0,50,50]');
    db.prepare('DELETE FROM documents WHERE document_id = ?').run(id);
    for (const table of ['page_manifests', 'page_dependencies', 'page_regions']) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

async function fullFilePixelHash(bytes, pageNumber) {
  const task = pdfjs.getDocument({
    data: Uint8Array.from(bytes),
    useSystemFonts: PROFILE.useSystemFonts,
    disableFontFace: PROFILE.disableFontFace,
    stopAtErrors: true,
    standardFontDataUrl: pdfjsAssetDirectory('standard_fonts'),
  });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: PROFILE.scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport,
      background: PROFILE.background, annotationMode: pdfjs.AnnotationMode.DISABLE,
    }).promise;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    return createHash('sha256').update(pixels).digest('hex');
  } finally { await task.destroy(); }
}

await test('PDF.js accepts Windows asset paths, including decoded names and UNC shares', async () => {
  for (const root of [
    new URL('file:///E:/61a/junk/node_modules/pdfjs-dist/'),
    new URL('file:///E:/PDF%20files/%E6%96%87%E6%A1%A3%23test/node_modules/pdfjs-dist/'),
    new URL('file://fileserver/pdf-share/node_modules/pdfjs-dist/'),
  ]) {
    const paths = Object.fromEntries([
      ['cMapUrl', 'cmaps'], ['standardFontDataUrl', 'standard_fonts'],
      ['wasmUrl', 'wasm'], ['iccUrl', 'iccs'],
    ].map(([key, name]) => [key, pdfjsAssetDirectory(name, { root, windows: true })]));
    assert.ok(Object.values(paths).every(path => path.endsWith('/')));
    assert.ok(!paths.cMapUrl.startsWith('file:'), 'Node asset loading expects a filesystem path');
    if (root.href.includes('%20')) assert.ok(paths.cMapUrl.includes('PDF files\\文档#test'));
    if (root.hostname) assert.ok(paths.cMapUrl.startsWith('\\\\fileserver\\pdf-share\\'));
    // PDF.js validates all four paths during loading, before any assets are
    // requested. This reproduces Windows' path format on every test platform.
    const task = pdfjs.getDocument({ data: makeFixturePdf(), ...paths, useWorkerFetch: false });
    try { assert.equal((await task.promise).numPages, 3); }
    finally { await task.destroy(); }
  }
});

await test('cold manifests are narrow, replay without fallback, and match full-file pixels', async () => {
  const db = openDatabase(':memory:');
  try {
    const bytes = makeFixturePdf();
    const id = putDocument(db, bytes);
    const page1 = await indexPage(db, id, 1);
    const page2 = await indexPage(db, id, 2);
    for (const result of [page1, page2]) {
      assert.ok(result.observedBytes < bytes.length / 3);
      assert.ok(result.chunks.includes(0), 'Initial prefix must be recorded');
      assert.equal(result.pixelSha256, await fullFilePixelHash(bytes, result.pageNumber));
      assert.equal((await verifyPage(db, id, result.pageNumber)).verified, true);
    }
    assert.notEqual(page1.pixelSha256, page2.pixelSha256);
    assert.ok(page2.chunks.some(n => !page1.chunks.includes(n)));
    const count = db.prepare('SELECT count(*) AS n FROM document_chunks').get().n;
    assert.equal(count, Math.ceil(bytes.length / 16384), 'Page manifests never copy PDF bytes');
    assert.equal(putDocument(db, bytes), id, 'Import is idempotent');

    const merged = pageRanges(db, id, [1, 2, 1]);
    const actual = new Set();
    for (const [start, end] of merged) {
      assert.ok(start >= 0 && end <= bytes.length && end > start);
      for (let n = start / 16384; n < Math.ceil(end / 16384); n++) actual.add(n);
    }
    assert.deepEqual(actual, new Set([...page1.chunks, ...page2.chunks].sort((a,b) => a-b)));
    assert.ok(merged.every((range, i) => i === 0 || merged[i-1][1] < range[0]));
    assert.throws(() => pageRanges(db, id, [3]), /No manifest/);

    // A missing non-bootstrap dependency must cause a real replay failure.
    const needed = page2.chunks.find(n => n !== 0);
    db.prepare(`DELETE FROM page_dependencies WHERE page_manifest_id =
      (SELECT id FROM page_manifests WHERE document_id = ? AND profile_id = ? AND page_number = 2) AND chunk_number = ?`).run(id, PROFILE_ID, needed);
    await assert.rejects(verifyPage(db, id, 2), /Manifest miss/);
  } finally { db.close(); }
});

await test('incremental xref chains are captured and replayed', async () => {
  const db = openDatabase(':memory:');
  try {
    const bytes = makeIncrementalFixturePdf();
    const id = putDocument(db, bytes);
    const result = await indexPage(db, id, 3);
    assert.ok(result.observedBytes < bytes.length / 3);
    assert.equal(result.pixelSha256, await fullFilePixelHash(bytes, 3));
    assert.equal((await verifyPage(db, id, 3)).verified, true);
  } finally { db.close(); }
});

await test('compressed object and xref streams are captured and replayed', async () => {
  const db = openDatabase(':memory:');
  try {
    const bytes = makeObjectStreamFixturePdf();
    const id = putDocument(db, bytes);
    const result = await indexPage(db, id, 2);
    assert.ok(result.observedBytes < bytes.length / 3);
    assert.equal(result.pixelSha256, await fullFilePixelHash(bytes, 2));
    assert.equal((await verifyPage(db, id, 2)).verified, true);
  } finally { db.close(); }
});

await test('a failed trace never publishes an empty or partial manifest', async () => {
  const db = openDatabase(':memory:');
  try {
    const id = putDocument(db, makeFixturePdf());
    await assert.rejects(indexPage(db, id, 9), /Invalid page request/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM page_manifests').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM page_dependencies').get().n, 0);
    const old = await indexPage(db, id, 1);
    await assert.rejects(indexPage(db, id, 1, { maxPixels: 1 }), /pixel limit/);
    assert.equal(db.prepare('SELECT pixel_sha256 FROM page_manifests').get().pixel_sha256,
      old.pixelSha256, 'Failed refresh preserves the last successful manifest');
  } finally { db.close(); }
});

await test('range read failures reject the trace rather than hanging PDF.js', async () => {
  const bytes = makeFixturePdf();
  await assert.rejects(renderColdPage({
    byteLength: bytes.length, chunkSize: 16384, pageNumber: 1, timeoutMs: 2000,
    readRange: (begin, end) => {
      if (begin !== 0) throw new Error('simulated storage failure');
      return bytes.slice(begin, end);
    },
  }), /simulated storage failure/);
});

await test('hung storage reads time out without publishing a result', async () => {
  await assert.rejects(renderColdPage({
    byteLength: 100000, chunkSize: 16384, pageNumber: 1, timeoutMs: 25,
    readRange: () => new Promise(() => {}),
  }), /timed out/);
});
