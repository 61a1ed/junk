// Optional end-to-end smoke test. Install Playwright separately, or provide
// PLAYWRIGHT_MODULE and CHROMIUM_PATH for an existing browser installation.
import assert from 'node:assert/strict';
import { createDebugServer } from '../server.mjs';

const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { server } = createDebugServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: process.env.CHROMIUM_PATH ? ['--no-sandbox'] : [],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1060 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const visible = async selector => page.locator(selector).first().waitFor({ state: 'visible' });
const notice = async text => page.waitForFunction(text => document.querySelector('#notice')?.textContent.includes(text), text);
const mutationComplete = async () => page.waitForFunction(() => !document.querySelector('#upload-button').disabled);
const step = label => console.log(`PASS ${label}`);
try {
  await page.goto(origin);
  await page.getByText('Session active', { exact: true }).waitFor();
  assert.equal(await page.locator('#stat-documents').textContent(), '0');
  await page.screenshot({ path: '/tmp/pdf-workbench-empty.png', fullPage: true });
  step('initial empty state');

  await page.getByRole('button', { name: 'Load sample PDF' }).click();
  await notice('ready to inspect');
  await mutationComplete();
  assert.equal(await page.locator('#stat-documents').textContent(), '1');
  await visible('#preview-frame canvas');
  step('sample upload and rendered PDF preview');

  await page.getByRole('button', { name: 'Trace page', exact: true }).click();
  await notice('traced successfully');
  await mutationComplete();
  assert.equal(await page.locator('#stat-manifests').textContent(), '1');
  assert.ok(await page.locator('.chunk-cell.used').count() > 0);
  await page.getByRole('button', { name: 'Verify replay', exact: true }).click();
  await notice('Pixel hashes match');
  await mutationComplete();
  await page.getByText('REPLAY VERIFIED', { exact: true }).waitFor();
  step('cold page trace and constrained replay verification');

  await page.getByRole('button', { name: 'Trace all pages', exact: true }).click();
  await notice('3 pages traced successfully');
  await mutationComplete();
  assert.equal(await page.locator('#stat-manifests').textContent(), '3');
  await page.getByRole('tab', { name: 'Page manifests' }).click();
  await page.getByRole('textbox', { name: 'Pages for byte ranges' }).fill('1–3');
  await page.getByRole('button', { name: 'Get ranges', exact: true }).click();
  await visible('#range-result .range-output');
  assert.match(await page.locator('#range-result').textContent(), /chunks/);
  await page.getByRole('textbox', { name: 'Pages for byte ranges' }).fill('4');
  await page.getByRole('button', { name: 'Get ranges', exact: true }).click();
  await visible('#range-result .query-error');
  step('all-page tracing, deduplicated ranges, and invalid page feedback');

  // Hold a completed range response until its original inspector is detached.
  const rangesReady = Promise.withResolvers();
  const releaseRanges = Promise.withResolvers();
  const rangesRoute = async route => {
    const response = await route.fetch();
    rangesReady.resolve();
    await releaseRanges.promise;
    await route.fulfill({ response });
  };
  await page.route('**/api/documents/*/ranges', rangesRoute);
  await page.getByRole('textbox', { name: 'Pages for byte ranges' }).fill('1');
  const originalRangeButton = await page.getByRole('button', { name: 'Get ranges', exact: true }).elementHandle();
  await page.getByRole('button', { name: 'Get ranges', exact: true }).click();
  await rangesReady.promise;
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  releaseRanges.resolve();
  // The detached button is re-enabled in the request handler's finally block.
  await page.waitForFunction(button => !button.disabled, originalRangeButton);
  assert.equal(await page.locator('#range-result').count(), 0);
  await page.getByRole('tab', { name: 'Page manifests' }).click();
  assert.equal(await page.locator('#range-result').textContent(), '');
  await page.unroute('**/api/documents/*/ranges', rangesRoute);
  assert.deepEqual(errors, []);
  step('late range response cannot update a replaced inspector');

  await page.locator('[data-view="query"]').click();
  await page.getByRole('textbox', { name: 'SQL query' }).fill('SELECT count(*) AS count FROM documents');
  await page.getByRole('button', { name: 'Run query' }).click();
  await visible('#query-results tbody td');
  assert.equal((await page.locator('#query-results tbody td').textContent()).trim(), '1');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  assert.equal((await downloadPromise).suggestedFilename(), 'pdf-workbench-query.csv');
  await page.getByRole('textbox', { name: 'SQL query' }).fill('DELETE FROM documents');
  await page.getByRole('button', { name: 'Run query' }).click();
  await visible('#query-results .query-error');
  assert.match(await page.locator('#query-results').textContent(), /not authorized|read.?only|not permitted/i);
  await page.getByRole('textbox', { name: 'SQL query' }).fill('SELECT * FROM no_such_table');
  await page.getByRole('button', { name: 'Run query' }).click();
  await page.waitForFunction(() => document.querySelector('#query-results').textContent.includes('no such table'));
  step('SQL results, CSV export, rejected writes, and SQL errors');

  await page.locator('.nav-item[data-view="schema"]').click();
  await visible('.schema-card');
  assert.equal(await page.locator('.schema-card').count(), 6);
  await page.getByText('View CREATE TABLE statement', { exact: true }).first().click();
  assert.match(await page.locator('.schema-card details').first().textContent(), /CREATE TABLE/);
  step('live schema and table definitions');

  await page.locator('.nav-item[data-view="documents"]').click();
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await visible('#preview-frame canvas');
  await page.screenshot({ path: '/tmp/pdf-workbench.png', fullPage: true });
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await page.locator('canvas[aria-label="PDF preview, page 2"]').waitFor();
  await page.getByRole('spinbutton', { name: 'Page number' }).fill('3');
  await page.getByRole('spinbutton', { name: 'Page number' }).press('Tab');
  await page.locator('canvas[aria-label="PDF preview, page 3"]').waitFor();
  step('page navigation and rerender');

  const sample = await (await fetch(`${origin}/api/sample.pdf`)).arrayBuffer();
  await page.locator('#file-input').setInputFiles({name: 'duplicate.pdf', mimeType:'application/pdf', buffer:Buffer.from(sample)});
  await notice('ready to inspect');
  await mutationComplete();
  assert.equal(await page.locator('#stat-documents').textContent(), '1');
  await page.locator('#file-input').setInputFiles({name: 'invalid.pdf', mimeType:'application/pdf', buffer:Buffer.from('not a PDF')});
  await notice('0 accepted');
  await mutationComplete();
  assert.equal(await page.locator('#stat-documents').textContent(), '1');
  step('duplicate upload and invalid PDF feedback');

  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'/tmp/pdf-workbench-mobile.png', fullPage:true});
  const geometry = await page.evaluate(() => ({scroll:document.documentElement.scrollWidth, width:innerWidth}));
  assert.ok(geometry.scroll <= geometry.width + 1, `Mobile overflow: ${JSON.stringify(geometry)}`);
  await page.locator('.nav-item[data-view="query"]').click();
  await page.getByRole('textbox', {name:'SQL query'}).fill('SELECT count(*) FROM page_manifests');
  await page.getByRole('button', {name:'Run query'}).click();
  await visible('#query-results tbody td');
  assert.equal((await page.locator('#query-results tbody td').textContent()).trim(), '3');
  step('mobile navigation, layout, and SQL interaction');

  await page.locator('.nav-item[data-view="documents"]').click();
  await page.getByRole('button', {name:'Delete document', exact:true}).click();
  await page.getByRole('button', {name:'Delete PDF', exact:true}).click();
  await notice('PDF deleted');
  await mutationComplete();
  assert.equal(await page.locator('#stat-documents').textContent(), '0');
  assert.equal(await page.locator('#stat-manifests').textContent(), '0');
  await page.getByRole('button', {name:'Load sample PDF'}).click();
  await notice('ready to inspect');
  await mutationComplete();

  // Capture a real nonempty SQL result, then reset before the browser receives it.
  const queryReady = Promise.withResolvers();
  const releaseQuery = Promise.withResolvers();
  const queryRoute = async route => {
    const response = await route.fetch();
    assert.equal((await response.json()).rows[0][0], 1);
    queryReady.resolve();
    await releaseQuery.promise;
    await route.fulfill({ response });
  };
  await page.route('**/api/query', queryRoute);
  await page.locator('.nav-item[data-view="query"]').click();
  await page.getByRole('textbox', {name:'SQL query'}).fill('SELECT count(*) FROM documents');
  await page.getByRole('button', {name:'Run query'}).click();
  await queryReady.promise;
  await page.locator('#reset-button').click();
  await page.locator('#confirm-submit').click();
  await notice('Session reset.');
  await mutationComplete();
  assert.equal(await page.locator('#stat-documents').textContent(), '0');
  releaseQuery.resolve();
  await page.waitForFunction(() => !document.querySelector('#run-query').disabled);
  assert.match(await page.locator('#query-results').textContent(), /Session reset/);
  assert.equal(await page.locator('#result-count').textContent(), '—');
  assert.equal(await page.locator('#export-csv').isDisabled(), true);
  await page.unroute('**/api/query', queryRoute);
  step('delete cascading records and full session reset');
  step('late SQL response cannot restore results after a reset');

  assert.deepEqual(errors, [], `Unexpected browser exceptions: ${errors.join('; ')}`);
  step('no uncaught browser errors');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
