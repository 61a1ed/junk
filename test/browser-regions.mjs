// Optional browser test; same Playwright/Chromium setup as browser-page-grid.mjs.
import assert from 'node:assert/strict';
import { createDebugServer } from '../server.mjs';
import { makeReadingFixturePdf } from './fixture.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { server } = createDebugServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true, args: process.env.CHROMIUM_PATH ? ['--no-sandbox'] : [] });
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 }, deviceScaleFactor: 2 });
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const run = async sql => {
  await page.locator('#sql-editor').fill(sql);
  await page.locator('#run-query').click();
  await page.waitForFunction(() => !document.querySelector('#run-query').disabled);
};
const ready = selector => page.waitForFunction(selector =>
  document.querySelector(`${selector} .pdf-page-cell[aria-busy="false"] .textLayer`), selector);
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByText('Session active', { exact: true }).waitFor();
  // A rotated, nonzero-origin page makes coordinate and text-layer mistakes visible.
  const bytes = makeReadingFixturePdf({ rotation: 90, origin: [-20, 10] });
  await page.locator('#file-input').setInputFiles({ name: 'rotated.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('ready to inspect'));
  const id = await page.evaluate(async () => {
    const { clientRequest } = await import('/client-db.js');
    const id = (await clientRequest('/state')).documents[0].document_id;
    const result = await clientRequest(`/documents/${id}/index`, { method: 'POST', body: { pages: [1] } });
    if (!result.results[0].success) throw new Error(JSON.stringify(result));
    return id;
  });
  await page.locator('.nav-item[data-view="query"]').click();
  await run('SELECT ref AS pdf_page FROM page_manifests');
  await ready('#query-results');
  await page.getByRole('button', { name: 'Enlarge page 1' }).click();
  await ready('.pdf-page-popup');
  await page.getByRole('button', { name: 'Select region', exact: true }).click();
  const overlay = await page.locator('.pdf-region-overlay').boundingBox();
  // Reverse drag over the title near the right edge of this rotated page.
  await page.mouse.move(overlay.x + overlay.width * .96, overlay.y + overlay.height * .65);
  await page.mouse.down();
  await page.mouse.move(overlay.x + overlay.width * .83, overlay.y + overlay.height * .08, { steps: 8 });
  await page.mouse.up();
  await page.getByRole('textbox', { name: 'Region name' }).fill('Title crop');
  await page.getByRole('button', { name: 'Save region', exact: true }).click();
  await page.getByText('Region saved.', { exact: true }).waitFor();
  assert.equal(await page.locator('.pdf-region-box').count(), 1);
  console.log('PASS saved region overlay');
  const region = await page.evaluate(async () => {
    const { clientRequest, savePageRegion } = await import('/client-db.js');
    const result = await clientRequest('/query', { method: 'POST', body: { sql: 'SELECT id, page_manifest_id, bounds FROM page_regions' } });
    const [id, manifestId, json] = result.rows[0];
    for (const bounds of [[0, 0, 0, 1], [0, 0, NaN, 1], [0, 0, '1', 1]]) {
      let rejected = false;
      try { await savePageRegion({ pageManifestId: manifestId, name: 'invalid', bounds }); }
      catch { rejected = true; }
      if (!rejected) throw new Error('Invalid bounds accepted');
    }
    return { id, manifestId, bounds: JSON.parse(json) };
  });
  assert.equal(region.bounds.length, 4);
  assert.ok(region.bounds[0] < region.bounds[2] && region.bounds[1] < region.bounds[3]);
  // Check the pointer-to-PDF conversion against independent rotated-page geometry.
  const expected = [-20 + 612 * .08, 10 + 792 * .83, -20 + 612 * .65, 10 + 792 * .96];
  region.bounds.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 2));
  await page.getByRole('button', { name: 'Title crop', exact: true }).click();
  await ready('.pdf-page-popup');
  await page.locator('.pdf-page-popup .pdf-region-crop canvas').waitFor();
  // Selection uses the same crop translation as the rendered bitmap.
  const text = page.locator('.pdf-page-popup .textLayer span').filter({ hasText: 'Reading preview - page 1' });
  const textBox = await text.boundingBox();
  const cropBox = await page.locator('.pdf-page-popup .pdf-region-crop').boundingBox();
  assert.ok(textBox.x >= cropBox.x && textBox.y >= cropBox.y);
  assert.ok(textBox.x + textBox.width <= cropBox.x + cropBox.width);
  await page.mouse.dblclick(textBox.x + textBox.width / 2, textBox.y + textBox.height * .1);
  assert.ok((await page.evaluate(() => window.getSelection().toString())).trim().length > 0);
  await page.getByRole('button', { name: 'Show source page' }).click();
  await ready('.pdf-page-popup');
  assert.equal(await page.locator('.pdf-region-box').count(), 1);
  await page.getByRole('button', { name: 'Close preview' }).click();
  await page.locator('#query-preset').selectOption('regions');
  await page.locator('#run-query').click();
  await ready('#query-results');
  const geometry = await page.locator('#query-results .pdf-region-crop').evaluate(div => ({
    width: div.clientWidth, height: div.clientHeight,
    canvasWidth: div.querySelector('canvas').width, canvasHeight: div.querySelector('canvas').height,
  }));
  assert.ok(Math.abs(geometry.width / geometry.height - (region.bounds[3] - region.bounds[1]) / (region.bounds[2] - region.bounds[0])) < .02);
  assert.ok(geometry.canvasWidth <= 2 * (geometry.width + 1) && geometry.canvasHeight <= 2 * (geometry.height + 1));
  await page.getByRole('button', { name: `Enlarge region ${region.id}` }).click();
  await ready('.pdf-page-popup');
  await page.getByRole('button', { name: 'Show source page' }).click();
  await ready('.pdf-page-popup');
  await page.getByRole('button', { name: 'Delete region Title crop' }).click();
  await page.waitForFunction(() => !document.querySelector('.pdf-region-box'));
  await page.getByRole('button', { name: 'Close preview' }).click();
  await run(`SELECT 'pdf:region:v1:${region.id}' AS pdf_region`);
  await page.getByText('Preview unavailable: Region no longer exists.', { exact: true }).waitFor();
  await page.evaluate(async ({ id, region }) => {
    const { clientRequest, savePageRegion } = await import('/client-db.js');
    await savePageRegion({ pageManifestId: region.manifestId, name: 'cascade', bounds: region.bounds });
    await clientRequest(`/documents/${id}`, { method: 'DELETE' });
    const result = await clientRequest('/query', { method: 'POST', body: { sql: 'SELECT count(*) FROM page_regions' } });
    if (result.rows[0][0] !== 0) throw new Error('Document deletion did not delete regions');
  }, { id, region });
  assert.deepEqual(errors, []);
  console.log('PASS rotated region drawing, array bounds, save/reopen, crop canvas and selectable text, SQL references, deletion');
} catch (error) {
  console.error('Browser errors:', errors);
  console.error(await page.locator('.pdf-cell-status, .pdf-region-status, #notice').allTextContents());
  await page.screenshot({ path: '/tmp/pdf-regions-failure.png' });
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
