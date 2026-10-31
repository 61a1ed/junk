// Optional end-to-end smoke test. Install Playwright separately, or provide
// PLAYWRIGHT_MODULE and CHROMIUM_PATH for an existing browser installation.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDebugServer } from '../server.mjs';
import { makeIncrementalFixturePdf, makeReadingFixturePdf } from './fixture.mjs';

const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { server } = createDebugServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: process.env.CHROMIUM_PATH ? ['--no-sandbox'] : [],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1060 } });
const page = await context.newPage();
const errors = [];
const requests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => requests.push({ method: request.method(), url: request.url() }));
await page.addInitScript(() => {
  // Instrument browser boundaries without changing production modules.
  window.__storageWrites = [];
  window.__nativeLocalStorage = localStorage;
  window.__nativeSessionStorage = sessionStorage;
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (...args) {
    window.__storageWrites.push(args[0]);
    return setItem.apply(this, args);
  };
  const open = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function (...args) {
    window.__storageWrites.push(`indexedDB:${args[0]}`);
    return open.apply(this, args);
  };
  const postMessage = Worker.prototype.postMessage;
  window.__holdRanges = false;
  window.__heldRangeCalls = [];
  window.__holdPdfTermination = false;
  window.__heldPdfTerminations = [];
  window.__holdPreviewPages = false;
  window.__heldPreviewPages = [];
  window.__pendingPreviewReplies = 0;
  Worker.prototype.postMessage = function (message, ...args) {
    if (window.__holdRanges && message?.action === 'ranges') {
      window.__heldRangeCalls.push(() => postMessage.call(this, message, ...args));
      return;
    }
    if (window.__holdPdfTermination && message?.action === 'Terminate') {
      window.__heldPdfTerminations.push(() => postMessage.call(this, message, ...args));
      return;
    }
    if (window.__holdPreviewPages && message?.action === 'GetPage') {
      window.__heldPreviewPages.push(() => {
        ++window.__pendingPreviewReplies;
        const receive = event => {
          if (event.data?.callbackId !== message.callbackId || event.data?.sourceName !== message.targetName) return;
          this.removeEventListener('message', receive);
          --window.__pendingPreviewReplies;
        };
        this.addEventListener('message', receive);
        postMessage.call(this, message, ...args);
      });
      return;
    }
    return postMessage.call(this, message, ...args);
  };
  window.__releaseRanges = () => {
    window.__holdRanges = false;
    for (const send of window.__heldRangeCalls.splice(0)) send();
  };
  window.__releasePdfTerminations = () => {
    window.__holdPdfTermination = false;
    for (const send of window.__heldPdfTerminations.splice(0)) send();
  };
  window.__releasePreviewPages = () => {
    window.__holdPreviewPages = false;
    for (const send of window.__heldPreviewPages.splice(0)) send();
  };
});
const visible = async selector => page.locator(selector).first().waitFor({ state: 'visible' });
const notice = async text => page.waitForFunction(text => document.querySelector('#notice')?.textContent.includes(text), text);
const mutationComplete = async () => page.waitForFunction(() => !document.querySelector('#upload-button').disabled);
const queryComplete = async () => page.waitForFunction(() => !document.querySelector('#run-query').disabled);
const previewComplete = async number => page.waitForFunction(number => {
  const frame = document.querySelector('#preview-frame');
  return frame?.getAttribute('aria-busy') === 'false' && frame.querySelector(`canvas[aria-label="PDF preview, page ${number}"]`);
}, number);
const previewGeometry = () => page.locator('#preview-frame').evaluate(frame => {
  const bounds = frame.getBoundingClientRect();
  return { width: bounds.width, height: bounds.height,
    followingOffset: document.querySelector('.preview-description').getBoundingClientRect().top - bounds.top };
});
const sameGeometry = (actual, expected) => {
  for (const key of Object.keys(expected)) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1, `Preview ${key} changed: ${JSON.stringify({actual, expected})}`);
  }
};
const canvasSize = () => page.locator('#preview-frame canvas').evaluate(canvas => {
  const { width, height } = canvas.getBoundingClientRect();
  return { width, height };
});
const noPageOverflow = async () => {
  const geometry = await page.evaluate(() => ({scroll:document.documentElement.scrollWidth, width:innerWidth}));
  assert.ok(geometry.scroll <= geometry.width + 1, `Page overflow: ${JSON.stringify(geometry)}`);
};
const openReader = async (pageNumber, {strictCurrentPage = true} = {}) => {
  await page.getByRole('button', {name:'Open reader', exact:true}).click();
  await visible('#pdf-reader');
  await page.waitForFunction(() => document.querySelector('#pdf-reader-frame')?.contentWindow.PDFViewerApplication?.pdfDocument);
  const reader = await (await page.locator('#pdf-reader-frame').elementHandle()).contentFrame();
  await reader.waitForFunction(({pageNumber, strictCurrentPage}) => {
    const app = window.PDFViewerApplication;
    return (!strictCurrentPage || app.page === pageNumber) && app.pdfViewer.getPageView(pageNumber - 1)?.renderingState === 3;
  }, {pageNumber, strictCurrentPage});
  await page.locator('#workbench-overlay').waitFor({state:'hidden'});
  return reader;
};
const fullViewportReader = async () => {
  const bounds = await page.locator('#pdf-reader-frame').boundingBox();
  const viewport = await page.evaluate(() => ({width:innerWidth, height:innerHeight}));
  sameGeometry(bounds, {x:0, y:0, ...viewport});
};
const readerState = reader => reader.evaluate(() => {
  const app = window.PDFViewerApplication;
  return {page:app.page, scale:app.pdfViewer.currentScale,
    scrollTop:app.pdfViewer.container.scrollTop, scrollLeft:app.pdfViewer.container.scrollLeft};
});
const readerStorageEmpty = async reader => {
  assert.deepEqual(await reader.evaluate(() => window.__storageWrites), [], 'The PDF.js reader must not write persistent preferences or document history');
  assert.equal(await reader.evaluate(() => window.__nativeLocalStorage.length + window.__nativeSessionStorage.length), 0);
  assert.deepEqual(await reader.evaluate(() => indexedDB.databases()), []);
};
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

  const sample = await (await fetch(`${origin}/sample.pdf`)).arrayBuffer();
  const pdfDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const pdfDownload = await pdfDownloadPromise;
  assert.equal(pdfDownload.suggestedFilename(), 'range-index-sample.pdf');
  assert.deepEqual(await readFile(await pdfDownload.path()), Buffer.from(sample));
  await mutationComplete();
  step('PDF download preserves every original source byte');

  await page.locator('#file-input').setInputFiles({name:'alternate.pdf', mimeType:'application/pdf', buffer:Buffer.from(makeIncrementalFixturePdf())});
  await notice('ready to inspect');
  await mutationComplete();
  assert.equal(await page.locator('#stat-documents').textContent(), '2');
  await visible('#preview-frame canvas');
  await page.locator('.document-item').filter({hasText:'range-index-sample.pdf'}).click();
  await page.locator('.inspector-head h2').filter({hasText:'range-index-sample.pdf'}).waitFor();
  await visible('#preview-frame canvas');
  // Hold A's actual PDF worker teardown while selecting B, then return to A.
  await page.evaluate(() => { window.__holdPdfTermination = true; });
  await page.locator('.document-item').filter({hasText:'alternate.pdf'}).click();
  await page.waitForFunction(() => window.__heldPdfTerminations.length > 0);
  await page.locator('.document-item').filter({hasText:'range-index-sample.pdf'}).click();
  await page.locator('.inspector-head h2').filter({hasText:'range-index-sample.pdf'}).waitFor();
  await visible('#preview-frame canvas');
  await page.evaluate(() => window.__releasePdfTerminations());
  assert.equal(await page.locator('.preview-error').count(), 0);
  await page.locator('.document-item').filter({hasText:'alternate.pdf'}).click();
  await page.locator('.inspector-head h2').filter({hasText:'alternate.pdf'}).waitFor();
  await visible('#preview-frame canvas');
  await page.getByRole('button', {name:'Delete document', exact:true}).click();
  await page.getByRole('button', {name:'Delete PDF', exact:true}).click();
  await notice('PDF deleted');
  await mutationComplete();
  assert.equal(await page.locator('#stat-documents').textContent(), '1');
  await visible('#preview-frame canvas');
  step('rapid A-to-B-to-A switching survives asynchronous PDF worker teardown');

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

  // Delay a worker request until its original inspector is detached.
  await page.evaluate(() => { window.__holdRanges = true; });
  await page.getByRole('textbox', { name: 'Pages for byte ranges' }).fill('1');
  const originalRangeButton = await page.getByRole('button', { name: 'Get ranges', exact: true }).elementHandle();
  await page.getByRole('button', { name: 'Get ranges', exact: true }).click();
  await page.waitForFunction(() => window.__heldRangeCalls.length === 1);
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await page.evaluate(() => window.__releaseRanges());
  // The detached button is re-enabled in the request handler's finally block.
  await page.waitForFunction(button => !button.disabled, originalRangeButton);
  assert.equal(await page.locator('#range-result').count(), 0);
  await page.getByRole('tab', { name: 'Page manifests' }).click();
  assert.equal(await page.locator('#range-result').textContent(), '');
  assert.deepEqual(errors, []);
  step('late worker range result cannot update a replaced inspector');

  await page.locator('.nav-item[data-view="query"]').click();
  await page.getByRole('textbox', { name: 'SQL query' }).fill('SELECT count(*) AS count FROM documents');
  await page.getByRole('button', { name: 'Run query' }).click();
  await queryComplete();
  await visible('#query-results tbody td');
  assert.equal((await page.locator('#query-results tbody td').textContent()).trim(), '1');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  assert.equal((await downloadPromise).suggestedFilename(), 'pdf-workbench-query.csv');
  await page.getByRole('textbox', { name: 'SQL query' }).fill('DELETE FROM documents');
  await page.getByRole('button', { name: 'Run query' }).click();
  await queryComplete();
  await visible('#query-results .query-error');
  assert.match(await page.locator('#query-results').textContent(), /not authorized|read.?only|not permitted/i);
  await page.getByRole('textbox', { name: 'SQL query' }).fill('SELECT * FROM no_such_table');
  await page.getByRole('button', { name: 'Run query' }).click();
  await queryComplete();
  await page.waitForFunction(() => document.querySelector('#query-results').textContent.includes('no such table'));
  step('SQL results, CSV export, rejected writes, and SQL errors');

  await page.getByRole('textbox', { name: 'SQL query' }).fill('WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x + 1 FROM n) SELECT sum(x) FROM n');
  await page.getByRole('button', { name: 'Run query' }).click();
  await queryComplete();
  await page.waitForFunction(() => /timed out/i.test(document.querySelector('#query-results').textContent));
  await page.getByRole('textbox', { name: 'SQL query' }).fill('SELECT count(*) AS count FROM documents');
  await page.getByRole('button', { name: 'Run query' }).click();
  await queryComplete();
  await visible('#query-results tbody td');
  assert.equal((await page.locator('#query-results tbody td').textContent()).trim(), '1');
  step('expensive SQL times out without blocking or mutating the live database');

  assert.equal(await page.locator('.nav-item[data-view="schema"]').count(), 0);
  assert.equal(await page.locator('#schema-reference').evaluate(details => details.open), false);
  await page.locator('#schema-reference > summary').click();
  await visible('.schema-card');
  assert.equal(await page.getByRole('textbox', { name: 'SQL query' }).isVisible(), true);
  assert.equal(await page.locator('.schema-card').count(), 6);
  await page.getByText('View CREATE TABLE statement', { exact: true }).first().click();
  assert.match(await page.locator('.schema-card details').first().textContent(), /CREATE TABLE/);
  await page.locator('#schema-reference > summary').click();
  assert.equal(await page.locator('.schema-card').first().isVisible(), false);
  assert.equal(await page.getByRole('textbox', { name: 'SQL query' }).isVisible(), true);
  step('schema expands and collapses within the SQL console');

  await page.locator('.nav-item[data-view="documents"]').click();
  await page.getByRole('link', {name:'Explore the schema'}).click();
  await visible('.schema-card');
  assert.equal(await page.locator('#schema-reference').evaluate(details => details.open), true);
  assert.equal(await page.getByRole('textbox', {name:'SQL query'}).isVisible(), true);
  await page.screenshot({path:'/tmp/pdf-workbench-schema.png', fullPage:true});
  await page.locator('#schema-reference > summary').click();
  await page.evaluate(() => { location.hash = 'schema'; });
  await page.waitForFunction(() => location.hash === '#query' && document.querySelector('#schema-reference').open);
  assert.equal(await page.getByRole('textbox', {name:'SQL query'}).isVisible(), true);
  await page.locator('#schema-reference > summary').click();
  step('Explore the schema and legacy schema links open the SQL reference');

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

  await page.locator('#file-input').setInputFiles({name:'reading.pdf', mimeType:'application/pdf', buffer:Buffer.from(makeReadingFixturePdf())});
  await notice('ready to inspect');
  await mutationComplete();
  await previewComplete(1);
  await page.getByRole('combobox', {name:'Preview zoom'}).selectOption('1');
  await previewComplete(1);
  sameGeometry(await canvasSize(), {width:816, height:1056});
  await page.getByRole('combobox', {name:'Preview zoom'}).selectOption('fit');
  await previewComplete(1);
  const initialPreview = await previewGeometry();
  await page.evaluate(() => { window.__holdPreviewPages = true; });
  await page.getByRole('button', {name:'Next page', exact:true}).click();
  await page.waitForFunction(() => window.__heldPreviewPages.length === 1);
  assert.equal(await page.locator('#preview-frame').getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('canvas[aria-label="PDF preview, page 1"]').count(), 1);
  sameGeometry(await previewGeometry(), initialPreview);
  // The pending page must not be fitted against a hidden, zero-width frame.
  await page.locator('.nav-item[data-view="query"]').click();
  await page.evaluate(() => window.__releasePreviewPages());
  await page.waitForFunction(() => window.__pendingPreviewReplies === 0);
  await page.locator('.nav-item[data-view="documents"]').click();
  await previewComplete(2);
  sameGeometry(await previewGeometry(), initialPreview);
  const fittedSize = await canvasSize();
  assert.ok(fittedSize.width > 200 && fittedSize.height > 150, `Returned preview is too small: ${JSON.stringify(fittedSize)}`);
  assert.ok(fittedSize.width < initialPreview.width && fittedSize.height < initialPreview.height, 'Fit page must fit inside the visible frame');
  assert.ok(Math.abs(fittedSize.width / fittedSize.height - 792 / 612) < 0.01, 'Returned preview must retain the page aspect ratio');
  assert.equal(await page.getByRole('combobox', {name:'Preview zoom'}).inputValue(), 'fit');
  step('returning from SQL after a delayed page load refits the visible preview');
  await page.getByRole('combobox', {name:'Preview zoom'}).selectOption('1');
  await previewComplete(2);
  sameGeometry(await previewGeometry(), initialPreview);
  sameGeometry(await canvasSize(), {width:1056, height:816});
  assert.equal(await page.getByRole('combobox', {name:'Preview zoom'}).inputValue(), '1');
  step('portrait-to-landscape navigation keeps the viewport stable while loading and preserves readable zoom');

  // Let an uncached page reply arrive after the user has already gone back.
  await page.evaluate(() => { window.__holdPreviewPages = true; });
  await page.getByRole('button', {name:'Next page', exact:true}).click();
  await page.waitForFunction(() => window.__heldPreviewPages.length === 1);
  await page.getByRole('button', {name:'Previous page', exact:true}).click();
  await previewComplete(2);
  await page.evaluate(() => window.__releasePreviewPages());
  await page.waitForFunction(() => window.__pendingPreviewReplies === 0);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByRole('spinbutton', {name:'Page number'}).inputValue(), '2');
  assert.equal(await page.locator('canvas[aria-label="PDF preview, page 2"]').count(), 1);
  await page.getByRole('button', {name:'Next page', exact:true}).click();
  await previewComplete(3);
  sameGeometry(await previewGeometry(), initialPreview);
  sameGeometry(await canvasSize(), {width:816, height:1056});
  step('rapid page navigation ignores a late response for an abandoned page');

  const reader = await openReader(3);
  await fullViewportReader();
  assert.equal(await reader.locator('#viewer .page').count(), 3, 'The standard viewer keeps every page in its continuous document');
  assert.equal(await reader.evaluate(() => window.PDFViewerApplication.pdfViewer.scrollMode), 0);
  await reader.locator('.page[data-page-number="3"] .textLayer span').first().waitFor();
  const selectableText = await reader.locator('.page[data-page-number="3"] .textLayer').evaluate(layer => {
    const range = document.createRange();
    range.selectNodeContents(layer);
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    const text = selection.toString();
    selection.removeAllRanges();
    return {text, userSelect:getComputedStyle(layer).userSelect};
  });
  assert.match(selectableText.text, /twelve-point Helvetica/);
  assert.notEqual(selectableText.userSelect, 'none');
  await reader.locator('#viewFindButton').click();
  await reader.locator('#findInput').fill('Paragraph 12');
  await reader.locator('#findInput').press('Enter');
  await reader.locator('.textLayer .highlight.selected').first().waitFor();
  await reader.waitForFunction(() => /\b3\b/.test(document.querySelector('#findResultsCount').textContent));
  assert.match(await reader.locator('#findResultsCount').textContent(), /3/);
  await reader.locator('#viewFindButton').click();
  await reader.locator('#secondaryToolbarToggleButton').click();
  const readerFileChooser = page.waitForEvent('filechooser');
  await reader.locator('#secondaryOpenFile').click();
  await (await readerFileChooser).setFiles({name:'reading-duplicate.pdf', mimeType:'application/pdf', buffer:Buffer.from(makeReadingFixturePdf())});
  await notice('ready to inspect');
  await mutationComplete();
  await page.locator('#workbench-overlay').waitFor({state:'hidden'});
  assert.equal(await page.locator('#stat-documents').textContent(), '2');
  await reader.waitForFunction(() => window.PDFViewerApplication.page === 1);
  step('stock Open imports a cross-frame File through SQLite and deduplicates the source PDF');
  await reader.locator('#scaleSelect').selectOption('1.5');
  await reader.locator('#pageNumber').fill('2');
  await reader.locator('#pageNumber').press('Enter');
  await reader.waitForFunction(() => {
    const app = window.PDFViewerApplication;
    return app.page === 2 && app.pdfViewer.currentScale === 1.5 && app.pdfViewer.getPageView(1)?.renderingState === 3;
  });
  await reader.locator('.page[data-page-number="2"] .textLayer span').first().waitFor();
  await reader.evaluate(() => {
    const app = window.PDFViewerApplication;
    window.__readerDocument = app.pdfDocument;
    window.__readerViewer = app.pdfViewer;
    app.pdfViewer.container.scrollTop += 60;
  });
  await reader.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const savedReader = await readerState(reader);
  assert.equal(savedReader.page, 2);
  await page.screenshot({path:'/tmp/pdf-workbench-reader.png', fullPage:true});
  step('full-viewport PDF.js reader provides continuous pages, selectable text, find, and standard zoom');

  await page.locator('#show-workbench').click();
  await visible('#workbench-overlay[open]');
  assert.equal(await page.getByRole('spinbutton', {name:'Page number'}).inputValue(), '2');
  await page.getByRole('button', {name:'Trace page', exact:true}).click();
  await notice('traced successfully');
  await mutationComplete();
  await page.locator('.nav-item[data-view="query"]').click();
  await page.locator('#schema-reference > summary').click();
  await visible('.schema-card');
  await page.getByRole('textbox', {name:'SQL query'}).fill("SELECT page_number FROM page_manifests JOIN upload_metadata USING (document_id) WHERE filename = 'reading.pdf'");
  await page.getByRole('button', {name:'Run query'}).click();
  await queryComplete();
  await visible('#query-results tbody td');
  assert.equal((await page.locator('#query-results tbody td').textContent()).trim(), '2', 'Trace must follow the reader page when opening the workbench');
  await page.screenshot({path:'/tmp/pdf-workbench-reader-overlay.png', fullPage:true});
  await page.locator('#schema-reference > summary').click();
  await page.locator('#hide-workbench').click();
  await page.locator('#workbench-overlay').waitFor({state:'hidden'});
  assert.deepEqual(await readerState(reader), savedReader);
  assert.equal(await reader.evaluate(() => window.PDFViewerApplication.pdfDocument === window.__readerDocument && window.PDFViewerApplication.pdfViewer === window.__readerViewer), true);
  await page.locator('#show-workbench').click();
  await visible('#workbench-overlay[open]');
  await page.locator('.nav-item[data-view="documents"]').click();
  await page.keyboard.press('Escape');
  await page.locator('#workbench-overlay').waitFor({state:'hidden'});
  assert.deepEqual(await readerState(reader), savedReader);
  await readerStorageEmpty(reader);
  await reader.evaluate(() => {
    const close = window.PDFWorkbenchReader.close.bind(window.PDFWorkbenchReader);
    const deferred = Promise.withResolvers();
    window.__releaseReaderClose = deferred.resolve;
    window.PDFWorkbenchReader.close = async (...args) => {
      window.__readerCloseStarted = true;
      await deferred.promise;
      return close(...args);
    };
  });
  await page.locator('#show-workbench').click();
  await visible('#workbench-overlay[open]');
  await page.locator('#exit-reader').click();
  await reader.waitForFunction(() => window.__readerCloseStarted);
  assert.equal(await page.locator('#pdf-reader-frame').count(), 1, 'Reader must remain alive until PDF.js finishes closing and saving edits');
  await reader.evaluate(() => window.__releaseReaderClose());
  await page.locator('#pdf-reader').waitFor({state:'hidden'});
  assert.equal(await page.locator('#pdf-reader-frame').count(), 0);
  await previewComplete(2);
  sameGeometry(await previewGeometry(), initialPreview);
  step('workbench overlay traces the reader page and preserves the live document, zoom, and scroll on return or Escape');
  step('exiting waits for PDF.js to finish closing before destroying its frame');

  await page.setViewportSize({width:390,height:844});
  await page.getByRole('combobox', {name:'Preview zoom'}).selectOption('1');
  await previewComplete(2);
  sameGeometry(await canvasSize(), {width:1056, height:816});
  await noPageOverflow();
  await page.locator('#preview-frame').evaluate(frame => { frame.scrollLeft = 0; frame.scrollTop = 0; });
  const startEdges = await page.locator('#preview-frame').evaluate(frame => {
    const outer = frame.getBoundingClientRect(), canvas = frame.querySelector('canvas').getBoundingClientRect();
    return {left:canvas.left - outer.left, top:canvas.top - outer.top,
      horizontal:frame.scrollWidth > frame.clientWidth, vertical:frame.scrollHeight > frame.clientHeight};
  });
  assert.ok(startEdges.horizontal && startEdges.vertical, 'Readable preview must scroll within its frame');
  assert.ok(startEdges.left >= 0 && startEdges.top >= 0, 'The start of an oversized page must remain reachable');
  await page.locator('#preview-frame').evaluate(frame => { frame.scrollLeft = frame.scrollWidth; frame.scrollTop = frame.scrollHeight; });
  const endEdges = await page.locator('#preview-frame').evaluate(frame => {
    const outer = frame.getBoundingClientRect(), canvas = frame.querySelector('canvas').getBoundingClientRect();
    return {right:canvas.right - outer.right, bottom:canvas.bottom - outer.bottom};
  });
  assert.ok(endEdges.right <= 1 && endEdges.bottom <= 1, 'The end of an oversized page must remain reachable');
  // At this width multiple fitted pages can be visible; stock PDF.js chooses
  // its current page from visibility while still rendering the requested page.
  const mobileReader = await openReader(2, {strictCurrentPage:false});
  await fullViewportReader();
  await noPageOverflow();
  await page.screenshot({path:'/tmp/pdf-workbench-reader-mobile.png', fullPage:true});
  await page.locator('#show-workbench').click();
  await visible('#workbench-overlay[open]');
  await page.locator('.nav-item[data-view="query"]').click();
  await page.getByRole('textbox', {name:'SQL query'}).fill('SELECT count(*) FROM documents');
  await page.getByRole('button', {name:'Run query'}).click();
  await queryComplete();
  await visible('#query-results tbody td');
  assert.equal((await page.locator('#query-results tbody td').textContent()).trim(), '2');
  await page.keyboard.press('Escape');
  await page.locator('#workbench-overlay').waitFor({state:'hidden'});
  await fullViewportReader();
  await readerStorageEmpty(mobileReader);
  await page.locator('#show-workbench').click();
  await visible('#workbench-overlay[open]');
  await page.locator('.nav-item[data-view="documents"]').click();
  await page.getByRole('button', {name:'Delete document', exact:true}).click();
  await page.getByRole('button', {name:'Delete PDF', exact:true}).click();
  await notice('PDF deleted');
  await mutationComplete();
  await page.locator('#pdf-reader').waitFor({state:'hidden'});
  assert.equal(await page.locator('#pdf-reader-frame').count(), 0);
  assert.equal(await page.locator('#workbench-overlay').isVisible(), false);
  await page.setViewportSize({width:1440,height:1060});
  await page.getByRole('combobox', {name:'Preview zoom'}).selectOption('fit');
  await previewComplete(1);
  assert.equal(await page.locator('#stat-documents').textContent(), '1');
  step('mobile preview scrolls, the reader fills the viewport, and deleting its PDF closes the reader');

  await page.locator('#file-input').setInputFiles({name: 'duplicate.pdf', mimeType:'application/pdf', buffer:Buffer.from(sample)});
  await notice('ready to inspect');
  await mutationComplete();
  assert.equal(await page.locator('#stat-documents').textContent(), '1');
  await page.locator('#file-input').setInputFiles({name: 'invalid.pdf', mimeType:'application/pdf', buffer:Buffer.from('not a PDF')});
  await notice('0 accepted');
  await mutationComplete();
  assert.equal(await page.locator('#stat-documents').textContent(), '1');
  step('duplicate upload and invalid PDF feedback');

  const secondTab = await page.context().newPage();
  secondTab.on('pageerror', error => errors.push(error.message));
  secondTab.on('request', request => requests.push({ method: request.method(), url: request.url() }));
  await secondTab.goto(origin);
  await secondTab.getByText('Session active', {exact:true}).waitFor();
  assert.equal(await secondTab.locator('#stat-documents').textContent(), '0');
  await secondTab.getByRole('button', {name:'Load sample PDF'}).click();
  await secondTab.waitForFunction(() => document.querySelector('#notice').textContent.includes('ready to inspect'));
  await secondTab.waitForFunction(() => !document.querySelector('#upload-button').disabled);
  assert.equal(await secondTab.locator('#stat-documents').textContent(), '1');
  step('a second browser tab starts with its own empty SQLite database');

  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'/tmp/pdf-workbench-mobile.png', fullPage:true});
  const geometry = await page.evaluate(() => ({scroll:document.documentElement.scrollWidth, width:innerWidth}));
  assert.ok(geometry.scroll <= geometry.width + 1, `Mobile overflow: ${JSON.stringify(geometry)}`);
  await page.locator('.nav-item[data-view="query"]').click();
  await page.getByRole('textbox', {name:'SQL query'}).fill('SELECT count(*) FROM page_manifests');
  await page.getByRole('button', {name:'Run query'}).click();
  await queryComplete();
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

  const resetReader = await openReader(1, {strictCurrentPage:false});
  await readerStorageEmpty(resetReader);
  await page.locator('#show-workbench').click();
  await visible('#workbench-overlay[open]');

  // Pause a query worker after its live database snapshot is taken, then reset.
  const queryReady = Promise.withResolvers();
  const releaseQuery = Promise.withResolvers();
  const queryRoute = async route => {
    const response = await route.fetch();
    queryReady.resolve();
    await releaseQuery.promise;
    await route.fulfill({ response });
  };
  await page.route('**/query-worker.js', queryRoute);
  await page.locator('.nav-item[data-view="query"]').click();
  await page.locator('#schema-reference > summary').click();
  await visible('.schema-card');
  const documentsSchema = page.locator('.schema-card').filter({has:page.getByRole('heading', {name:'documents', exact:true})});
  await documentsSchema.locator('.count-pill').filter({hasText:/^1 rows$/}).waitFor();
  await page.getByRole('textbox', {name:'SQL query'}).fill('SELECT count(*) FROM documents');
  await page.getByRole('button', {name:'Run query'}).click();
  await queryReady.promise;
  await page.locator('#reset-button').click();
  await page.locator('#confirm-submit').click();
  await notice('Session reset.');
  await mutationComplete();
  assert.equal(await page.locator('#stat-documents').textContent(), '0');
  await page.locator('#pdf-reader').waitFor({state:'hidden'});
  assert.equal(await page.locator('#pdf-reader-frame').count(), 0);
  assert.equal(await page.locator('#workbench-overlay').isVisible(), false);
  releaseQuery.resolve();
  await page.waitForFunction(() => !document.querySelector('#run-query').disabled);
  assert.match(await page.locator('#query-results').textContent(), /Session reset/);
  assert.equal(await page.locator('#result-count').textContent(), '—');
  assert.equal(await page.locator('#export-csv').isDisabled(), true);
  await page.waitForFunction(() => [...document.querySelectorAll('.schema-card')].some(card =>
    card.querySelector('h2')?.textContent === 'documents' && card.querySelector('.count-pill')?.textContent === '0 rows'));
  await page.unroute('**/query-worker.js', queryRoute);
  step('delete cascading records and full session reset');
  step('reset closes the active reader and releases its document');
  step('late SQL response cannot restore results after a reset');

  await secondTab.locator('.nav-item[data-view="query"]').click();
  await secondTab.getByRole('textbox', {name:'SQL query'}).fill('SELECT count(*) FROM documents');
  await secondTab.getByRole('button', {name:'Run query'}).click();
  await secondTab.locator('#query-results tbody td').waitFor();
  assert.equal((await secondTab.locator('#query-results tbody td').textContent()).trim(), '1');
  await secondTab.reload();
  await secondTab.getByText('Session active', {exact:true}).waitFor();
  assert.equal(await secondTab.locator('#stat-documents').textContent(), '0');
  await secondTab.close();
  step('reset is tab-local and reloading discards the in-memory database');

  assert.ok(requests.some(request => /sql.*\.wasm(?:$|\?)/.test(request.url)), 'Real sql.js WASM must load');
  assert.deepEqual(requests.filter(request => !['GET', 'HEAD'].includes(request.method) || new URL(request.url).pathname.startsWith('/api/')), [], 'PDF and database operations must never use a backend API');
  assert.deepEqual(await page.evaluate(() => window.__storageWrites), [], 'No localStorage/sessionStorage/IndexedDB writes');
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.deepEqual(await page.evaluate(() => indexedDB.databases()), []);
  step('real WASM, static GETs only, and no browser persistence');

  assert.deepEqual(errors, [], `Unexpected browser exceptions: ${errors.join('; ')}`);
  step('no uncaught browser errors');
} catch (error) {
  console.error('Browser errors:', errors);
  console.error('Workbench notice:', await page.locator('#notice').textContent());
  await page.screenshot({path:'/tmp/pdf-workbench-failure.png', fullPage:true});
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
