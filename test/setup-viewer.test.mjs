import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installViewer } from '../scripts/setup-viewer.mjs';

await test('unverified viewer archives cannot replace installed assets', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'pdfjs-install-test-'));
  try {
    await writeFile(path.join(target, 'sentinel'), 'existing installation');
    await assert.rejects(installViewer(new Uint8Array([1, 2, 3]), target), /checksum mismatch/);
    assert.equal(await readFile(path.join(target, 'sentinel'), 'utf8'), 'existing installation');
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});
