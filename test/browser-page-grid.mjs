// Optional browser integration test; uses the same setup as browser-smoke.mjs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDebugServer } from '../server.mjs';
import { makeReadingFixturePdf } from './fixture.mjs';
import { encodePdfAddress } from '../public/pdf-address.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { server } = createDebugServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined, headless: true,
  args: process.env.CHROMIUM_PATH ? ['--no-sandbox'] : [],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  const send = Worker.prototype.postMessage;
  window.__loads = [];
  window.__reads = [];
  window.__holdPageSource = false;
  window.__heldSources = [];
  Worker.prototype.postMessage = function (message, ...rest) {
    if (message?.action === 'GetDocRequest') window.__loads.push(message);
    if (['source', 'read-range'].includes(message?.action)) window.__reads.push(message);
    if (message?.action === 'page-source' && window.__holdPageSource) {
      window.__heldSources.push(() => send.call(this, message, ...rest));
      return;
    }
    return send.call(this, message, ...rest);
  };
});
const sqlLiteral = value => `'${value.replaceAll("'", "''")}'`;
const run = async sql => {
  await page.locator('#sql-editor').fill(sql);
  await page.locator('#run-query').click();
  await page.waitForFunction(() => !document.querySelector('#run-query').disabled);
};
const readyCells = count => page.waitForFunction(count =>
  document.querySelectorAll('#query-results .pdf-page-cell[aria-busy="false"] .textLayer').length === count, count);
const step = label => console.log(`PASS ${label}`);
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByText('Session active', { exact: true }).waitFor();
  const sidebarStyle = () => page.locator('.sidebar').evaluate(el => {
    const style = getComputedStyle(el);
    return { borderRadius: style.borderRadius, boxShadow: style.boxShadow };
  });
  const initialSidebar = await sidebarStyle();
  const bytes = makeReadingFixturePdf();
  await page.locator('#file-input').setInputFiles({ name: 'reading.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('ready to inspect') && !document.querySelector('#upload-button').disabled);
  const ids = await page.evaluate(async bytes => {
    const { clientRequest } = await import('/client-db.js');
    const state = await clientRequest('/state');
    const first = state.documents[0].document_id;
    const { document: second } = await clientRequest('/documents?filename=second.pdf', {
      method: 'POST', body: new Blob([new Uint8Array(bytes), '\n'], { type: 'application/pdf' }),
    });
    for (const [id, pages] of [[first, [1, 2]], [second.document_id, [1]]]) {
      const result = await clientRequest(`/documents/${id}/index`, { method: 'POST', body: { pages } });
      if (result.results.some(r => !r.success)) throw new Error(JSON.stringify(result));
    }
    return { first, second: second.document_id, profileId: state.profileId };
  }, Array.from(bytes));
  const address = (id, pageNumber, profileId = ids.profileId) => encodePdfAddress({ documentId: id, profileId, pageNumber });
  const a1 = address(ids.first, 1), a2 = address(ids.first, 2), b1 = address(ids.second, 1);
  await page.locator('.nav-item[data-view="query"]').click();
  await page.evaluate(() => { window.__loads = []; window.__reads = []; });
  await run(`SELECT ${sqlLiteral(a1)} AS pdf_left, ${sqlLiteral(a2)} AS PDF_right`);
  await readyCells(2);
  assert.equal(await page.evaluate(() => window.__loads.length), 1, 'Two pages of one PDF share a loading task');
  assert.equal(await page.evaluate(() => window.__reads.some(r => r.action === 'source')), false, 'Cells must use range storage');
  const geometry = await page.locator('.pdf-cell-stage').evaluateAll(stages => stages.map(stage => {
    const page = stage.querySelector('.page').getBoundingClientRect();
    return { width: stage.offsetWidth, height: stage.offsetHeight, pageRatio: page.width / page.height };
  }));
  assert.deepEqual(geometry.map(g => g.width), [320, 320]);
  assert.ok(geometry[0].height > geometry[1].height, 'Portrait and landscape must have natural, different heights');
  assert.ok(Math.abs(geometry[0].pageRatio - 612 / 792) < .01);
  assert.ok(Math.abs(geometry[1].pageRatio - 792 / 612) < .01);
  assert.equal(await page.locator('.pdf-cell-label').count(), 0);
  assert.equal(await page.locator('#query-results [title^="pdf:v1:"]').count(), 0);
  const selection = await page.locator('.pdf-page-cell .textLayer').first().evaluate(layer => {
    const range = document.createRange(); range.selectNodeContents(layer);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const text = selection.toString(); selection.removeAllRanges(); return text;
  });
  assert.match(selection, /twelve-point Helvetica/);
  const firstLine = page.locator('.pdf-page-cell .textLayer span').first();
  await firstLine.scrollIntoViewIfNeeded();
  const bounds = await firstLine.boundingBox();
  await page.mouse.move(bounds.x + 0.5, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 0.5, bounds.y + bounds.height / 2, { steps: 10 });
  await page.mouse.up();
  assert.match(await page.evaluate(() => getSelection().toString()), /Reading preview/);
  await page.evaluate(() => getSelection().removeAllRanges());
  assert.deepEqual(await sidebarStyle(), initialSidebar, 'PDF component styles must not affect the workbench');
  assert.equal(await page.locator('.pdf-page-cell .annotationLayer').count(), 0);
  await page.screenshot({ path: '/tmp/pdf-sql-grid.png', fullPage: true });
  step('selectable cells share one document and preserve page proportions without metadata labels');

  const downloadEvent = page.waitForEvent('download');
  await page.locator('#export-csv').click();
  const csv = await readFile(await (await downloadEvent).path(), 'utf8');
  assert.ok(csv.includes(a1) && csv.includes(a2), 'CSV must contain raw addresses');
  step('CSV exports the original page addresses');

  assert.deepEqual(await page.locator('#page-cell-width option').evaluateAll(options => options.map(o => o.value)), ['240', '320', '480', '640', '800']);
  await page.getByRole('combobox', { name: 'Page width', exact: true }).selectOption('480');
  await readyCells(2);
  assert.deepEqual(await page.locator('.pdf-cell-stage').evaluateAll(stages => stages.map(s => s.offsetWidth)), [480, 480]);
  await page.getByRole('combobox', { name: 'Page width', exact: true }).selectOption('320');
  await readyCells(2);
  step('the width menu resizes existing cells while preserving natural height');

  const popupReady = () => page.waitForFunction(() => document.querySelector('.pdf-page-popup .pdf-page-cell[aria-busy="false"] .textLayer'));
  const enlarge = async number => {
    const button = page.getByRole('button', { name: `Enlarge page ${number}`, exact: true });
    await button.scrollIntoViewIfNeeded();
    await button.click();
    await popupReady();
  };
  const loadsBeforePopup = await page.evaluate(() => window.__loads.length);
  await enlarge(2);
  assert.equal(await page.locator('#pdf-reader').isVisible(), false, 'Enlargement must not open the official reader');
  assert.equal(await page.evaluate(() => !!document.querySelector('#pdf-reader-frame')?.contentWindow.PDFViewerApplication), false);
  assert.equal(await page.evaluate(() => window.__loads.length), loadsBeforePopup, 'Popup shares the grid document');
  const popupBounds = await page.locator('.pdf-page-popup').boundingBox();
  assert.ok(popupBounds.width > 1400 && popupBounds.height > 1000);
  const largePage = await page.locator('.pdf-page-popup .page').boundingBox();
  assert.ok(largePage.width > 600 && Math.abs(largePage.width / largePage.height - 792 / 612) < .01);
  assert.match(await page.locator('.pdf-page-popup .textLayer').textContent(), /Reading preview - page 2/);
  const popupSelection = await page.locator('.pdf-page-popup .textLayer').evaluate(layer => {
    const range = document.createRange(); range.selectNodeContents(layer);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const text = selection.toString(); selection.removeAllRanges(); return text;
  });
  assert.match(popupSelection, /twelve-point Helvetica/);
  await page.screenshot({ path: '/tmp/pdf-page-popup.png' });
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.waitForFunction(() => {
    const cell = document.querySelector('.pdf-page-popup .pdf-page-cell');
    const stage = cell?.querySelector('.pdf-cell-stage').getBoundingClientRect();
    const page = cell?.querySelector('.page')?.getBoundingClientRect();
    return cell?.getAttribute('aria-busy') === 'false' && page && page.width < stage.width && page.height < stage.height;
  });
  await page.setViewportSize({ width: 1500, height: 1100 });
  await page.keyboard.press('Escape');
  await page.locator('.pdf-page-popup').waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('button', { name: 'Enlarge page 2', exact: true }).evaluate(el => el === document.activeElement), true);
  await enlarge(2);
  await page.getByRole('button', { name: 'Open full reader', exact: true }).click();
  await page.waitForFunction(() => {
    const app = document.querySelector('#pdf-reader-frame')?.contentWindow.PDFViewerApplication;
    return app?.page === 2 && app.pdfViewer.getPageView(1)?.renderingState === 3 && !document.querySelector('#workbench-overlay').open;
  });
  await page.locator('#show-workbench').click();
  await enlarge(1);
  await page.keyboard.press('Escape');
  await page.locator('.pdf-page-popup').waitFor({ state: 'detached' });
  assert.equal(await page.locator('#workbench-overlay').evaluate(el => el.open), true, 'Escape must only close the top preview');
  await page.locator('#exit-reader').click();
  await page.locator('#pdf-reader-frame').waitFor({ state: 'detached' });
  step('the large preview shares the document, closes independently, and opens the full reader at the requested page');

  await page.evaluate(() => { window.__loads = []; });
  await run(`SELECT ${sqlLiteral(a1)} AS pdf_a, ${sqlLiteral(b1)} AS pdf_b`);
  await readyCells(2);
  assert.equal(await page.evaluate(() => window.__loads.length), 2);
  await run(`SELECT ${sqlLiteral(a1)} AS pdf_a, ${sqlLiteral(a1)} AS pdf_b`);
  await readyCells(2);
  step('mixed documents and duplicate page coordinates render independently');

  await run(`SELECT ${sqlLiteral(a1)} AS ordinary, NULL AS pdf_null, '<img src=x onerror=alert(1)>' AS pdf_bad`);
  assert.equal(await page.locator('.pdf-page-cell').count(), 0);
  assert.equal(await page.locator('#query-results td').nth(0).textContent(), a1);
  assert.equal(await page.locator('#query-results td').nth(1).textContent(), 'NULL');
  assert.equal(await page.locator('#query-results img').count(), 0);
  assert.match(await page.locator('.pdf-cell-error').textContent(), /Expected pdf:v1/);
  step('ordinary columns, NULL, and invalid addresses retain safe text output');

  for (const value of [address(ids.first, 3), address(ids.first, 1, '0'.repeat(64)), address('0'.repeat(64), 1)]) {
    await run(`SELECT ${sqlLiteral(value)} AS pdf_missing`);
    await page.waitForFunction(() => document.querySelector('.pdf-cell-status')?.textContent.includes('Preview unavailable'));
    assert.equal(await page.locator('.pdf-page-cell canvas').count(), 0);
  }
  step('untraced pages, missing profiles, and missing documents fail per cell');

  await run(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<20)
    SELECT x, ${sqlLiteral(a1)} AS pdf_page FROM n`);
  await page.waitForFunction(() => document.querySelector('.pdf-page-cell[aria-busy="false"]'));
  assert.ok(await page.locator('.pdf-page-cell .textLayer').count() < 5, 'Offscreen rows should not render');
  const resultsHeight = await page.locator('#query-results').evaluate(el => ({ height: el.clientHeight, scrollHeight: el.scrollHeight, maxHeight: getComputedStyle(el).maxHeight }));
  assert.ok(resultsHeight.height > 7000 && resultsHeight.scrollHeight <= resultsHeight.height + 1);
  assert.equal(resultsHeight.maxHeight, 'none');
  await page.locator('#query-results tr').last().scrollIntoViewIfNeeded();
  await page.waitForFunction(() => {
    const cells = [...document.querySelectorAll('.pdf-page-cell')];
    return !cells[0].querySelector('canvas') && cells.at(-1).querySelector('.textLayer') && cells.at(-1).getAttribute('aria-busy') === 'false';
  });
  step('unbounded-height results scroll with the document and release offscreen canvases');

  await page.evaluate(() => { window.__holdPageSource = true; });
  await run(`SELECT ${sqlLiteral(a1)} AS pdf_delayed`);
  await page.waitForFunction(() => window.__heldSources.length > 0);
  await run('SELECT 42 AS answer');
  await page.evaluate(() => { window.__holdPageSource = false; window.__heldSources.splice(0).forEach(send => send()); });
  await page.waitForFunction(() => document.querySelector('#query-results td')?.textContent === '42');
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  assert.equal(await page.locator('.pdf-page-cell').count(), 0);
  step('late page replies cannot restore replaced query results');

  await page.locator('#query-preset').selectOption('pages');
  assert.match(await page.locator('#sql-editor').inputValue(), /m\.ref AS pdf_page/);
  await page.locator('#run-query').click();
  await page.waitForFunction(() => !document.querySelector('#run-query').disabled);
  assert.equal(await page.locator('#query-results tbody tr').count(), 3);
  const refs = await page.evaluate(async () => {
    const { clientRequest } = await import('/client-db.js');
    const [result, schema] = await Promise.all([
      clientRequest('/query', { method: 'POST', body: { sql: 'SELECT ref FROM page_manifests ORDER BY ref' } }),
      clientRequest('/schema'),
    ]);
    return { values: result.rows.flat(), generated: schema.tables.find(t => t.name === 'page_manifests').columns.find(c => c.name === 'ref').generated };
  });
  assert.deepEqual(refs.values, [a1, a2, b1].sort());
  assert.equal(refs.generated, true);
  await page.waitForFunction(() => document.querySelector('.pdf-page-cell[aria-busy="false"]'));
  await page.locator('#reset-button').click();
  await page.locator('#confirm-submit').click();
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('Session reset.') && !document.querySelector('#upload-button').disabled);
  assert.equal(await page.locator('.pdf-page-cell').count(), 0);
  assert.match(await page.locator('#query-results').textContent(), /Session reset/);
  step('the grid preset lists traces and session reset disposes its cells');
  assert.deepEqual(errors, []);
  step('no uncaught browser errors');
} catch (error) {
  console.error('Browser errors:', errors);
  console.error('Cell status:', await page.locator('.pdf-cell-status').allTextContents());
  await page.screenshot({ path: '/tmp/pdf-sql-grid-failure.png', fullPage: true });
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
