import { clientRequest, getDocumentBytes, readDocumentRange, getTracedPageSource } from './client-db.js';
import { createReader } from './reader-shell.js';
import { renderSqlResults } from './sql-results.js';
import { createPdfPageCells } from './pdf-page-cells.js';

const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const number = value => Number(value || 0).toLocaleString();
const bytes = value => {
  if (!value) return '0 B';
  const unit = Math.min(3, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B','KB','MB','GB'][unit]}`;
};
let state = { documents: [], stats: {}, profile: {} }, selectedId = null, detail = null, page = 1, inspectorTab = 'overview', currentView = 'documents';
let pending = false, queryPending = false, queryGeneration = 0, logs = [], queryResult = null, verified = new Map();
let pdfjs, previewTask, previewDoc, previewId, renderTask, previewGeneration = 0, detailGeneration = 0;
let previewZoom = 'fit', previewSize = '', previewResizeTimer;
let disposeQueryResults = () => {};
const reader = createReader({
  readRange: readDocumentRange,
  onShowWorkbench: async (id, currentPage) => {
    if (selectedId !== id) await selectDocument(id, true);
    if (!reader.active || reader.documentId !== id || selectedId !== id || !detail) return;
    page = Math.max(1, Math.min(currentPage, detail.document.page_count));
    renderInspector();
  },
  onFiles: files => uploadFiles([...files].map(file => new File([file], file.name, { type: file.type, lastModified: file.lastModified })), { read: true }),
});
document.addEventListener('reader-error', event => notify(event.detail.message, 'error'));
async function openReader() {
  if (!detail) return;
  try { await reader.open(detail.document, page); }
  catch (error) { notify(error.message, 'error'); log(error.message, true); }
}
const presets = {
  pages: "SELECT u.filename, m.page_number,\n       'pdf:v1:' || m.document_id || ':' || m.profile_id\n       || ':' || m.page_number AS pdf_page\nFROM page_manifests m\nJOIN upload_metadata u USING (document_id)\nORDER BY u.filename, m.page_number;",
  documents: 'SELECT d.document_id, u.filename, d.byte_length,\n       d.chunk_size, u.page_count, d.created_at\nFROM documents d\nJOIN upload_metadata u USING (document_id)\nORDER BY d.created_at DESC;',
  manifests: 'SELECT page_number, page_count, width, height,\n       observed_bytes, pixel_sha256\nFROM page_manifests\nORDER BY document_id, page_number;',
  dependencies: 'SELECT document_id, page_number, chunk_number\nFROM page_dependencies\nORDER BY document_id, page_number, chunk_number;',
  storage: 'SELECT u.filename, COUNT(*) AS chunks,\n       SUM(length(c.data)) AS stored_bytes\nFROM document_chunks c\nJOIN upload_metadata u USING (document_id)\nGROUP BY c.document_id;'
};
async function api(path, options = {}) {
  return clientRequest(path, options);
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
function notify(message, type = '') {
  const notice = $('#notice');
  notice.textContent = message;
  notice.className = `notice ${type}`;
  notice.hidden = !message;
}
function log(message, error = false) {
  logs.unshift({ message, error, at: new Date() });
  logs = logs.slice(0, 200);
  $('#log-count').textContent = logs.length;
  renderLogs();
}
function renderLogs() {
  $('#activity-list').innerHTML = logs.length ? logs.map(item => `<div class="activity-row ${item.error ? 'error' : ''}"><time>${item.at.toLocaleTimeString([], { hour12:false })}</time><span class="activity-dot"></span><p>${escapeHtml(item.message)}</p></div>`).join('') : '<div class="simple-empty">Nothing to report yet. Upload a PDF to start your session.</div>';
}
function setBusy(value) {
  pending = value;
  for (const button of document.querySelectorAll('#upload-button, #browse-button, #sample-button, #reset-button, [data-mutation]')) {
    button.disabled = value || (button.dataset.action === 'verify' && !detail?.manifests.some(m => m.page_number === page));
  }
  $('#file-input').disabled = value;
  $('#chunk-size').disabled = value;
  $('#connection-label').textContent = value ? 'Working' : 'Session active';
}
async function operation(message, fn) {
  if (pending) return;
  setBusy(true); notify(message, 'busy');
  try { await fn(); }
  catch (error) { notify(error.message, 'error'); log(error.message, true); }
  finally { setBusy(false); }
}
async function refreshState() {
  state = await api('/state');
  $('#stat-documents').textContent = number(state.stats.documents);
  $('#stat-chunks').textContent = number(state.stats.chunks);
  $('#stat-manifests').textContent = number(state.stats.manifests);
  const [size, unit] = bytes(state.stats.sourceBytes).split(' ');
  $('#stat-bytes').innerHTML = `${size} <span>${unit}</span>`;
  $('#nav-doc-count').textContent = state.documents.length;
  $('#list-count').textContent = state.documents.length;
  $('#renderer-version').textContent = `PDF.js ${state.profile.pdfjsVersion} · SQLite WASM`;
  $('#connection-label').textContent = state.busy || pending ? 'Working' : 'Session active';
  $('#list-footer-text').textContent = state.documents.length ? `${bytes(state.stats.sourceBytes)} / 100 MB session limit` : 'Waiting for your first PDF';
  renderDocuments();
  refreshSchema();
}
function renderDocuments() {
  const term = $('#document-search').value.toLowerCase();
  const docs = state.documents.filter(d => `${d.filename} ${d.document_id}`.toLowerCase().includes(term));
  $('#document-list').innerHTML = docs.length ? docs.map(d => `<button class="document-item ${d.document_id === selectedId ? 'selected' : ''}" data-document="${d.document_id}" aria-pressed="${d.document_id === selectedId}"><span class="pdf-icon">PDF</span><span class="document-info"><span class="document-name" title="${escapeHtml(d.filename)}">${escapeHtml(d.filename)}</span><span class="document-meta">${bytes(d.byte_length)}<span>·</span>${d.page_count} pages</span><span class="document-status">${d.indexed_pages ? `${d.indexed_pages} / ${d.page_count} traced` : 'Ready to inspect'}</span></span>${d.document_id === selectedId ? '<span class="selected-arrow">›</span>' : ''}</button>`).join('') : `<div class="simple-empty">${term ? 'No matching documents.' : 'Your documents will appear here.<br>Upload a PDF to get started.'}</div>`;
}
const emptyInspector = $('#inspector').innerHTML;
async function selectDocument(id, keepPage = false) {
  const generation = ++detailGeneration;
  const next = await api(`/documents/${id}`);
  if (generation !== detailGeneration) return;
  selectedId = id; detail = next;
  if (!keepPage) { page = 1; inspectorTab = 'overview'; }
  page = Math.min(page, detail.document.page_count);
  renderDocuments(); renderInspector();
}
function renderInspector() {
  // Keep the viewer (and its last complete canvas) while the inspector updates.
  const previewPane = $('#preview-pane');
  const previewFocus = previewPane?.contains(document.activeElement) ? document.activeElement : null;
  previewPane?.remove();
  if (!detail || inspectorTab !== 'overview') {
    previewObserver.disconnect();
    clearTimeout(previewResizeTimer);
  }
  if (!detail) {
    $('#inspector').innerHTML = emptyInspector;
    setBusy(pending);
    return;
  }
  const d = detail.document;
  $('#inspector').innerHTML = `<div class="inspector-head"><div><h2>${escapeHtml(d.filename)}</h2><p title="${d.document_id}">${d.document_id.slice(0,24)}… <span>SHA-256</span></p></div><div class="row"><button class="button small secondary" data-action="download" data-mutation>Download</button><button class="button small secondary" data-action="delete" data-mutation aria-label="Delete document">Delete</button></div></div><div class="inspector-tabs" role="tablist" aria-label="Document inspection"><button role="tab" aria-selected="${inspectorTab==='overview'}" class="inspector-tab ${inspectorTab==='overview'?'active':''}" data-tab="overview">Overview</button><button role="tab" aria-selected="${inspectorTab==='manifests'}" class="inspector-tab ${inspectorTab==='manifests'?'active':''}" data-tab="manifests">Page manifests <span class="count-pill">${detail.manifests.length}</span></button><button role="tab" aria-selected="${inspectorTab==='metadata'}" class="inspector-tab ${inspectorTab==='metadata'?'active':''}" data-tab="metadata">Metadata</button></div><div class="inspector-body" id="inspector-content"></div>`;
  if (inspectorTab === 'overview') renderOverview(previewPane);
  if (previewFocus?.isConnected) previewFocus.focus({ preventScroll: true });
  if (inspectorTab === 'manifests') renderManifests();
  if (inspectorTab === 'metadata') $('#inspector-content').innerHTML = `<pre class="raw-metadata">${escapeHtml(JSON.stringify({document: d, profileId: state.profileId, renderingProfile: state.profile}, null, 2))}</pre>`;
  setBusy(pending);
}
function renderOverview(previewPane) {
  const d = detail.document, manifest = detail.manifests.find(m => m.page_number === page);
  const isVerified = manifest && verified.get(`${selectedId}:${page}`) === manifest.pixel_sha256;
  $('#inspector-content').innerHTML = `<div class="doc-facts"><div><div class="fact-label">Source size</div><div class="fact-value">${bytes(d.byte_length)}</div></div><div><div class="fact-label">Chunk size</div><div class="fact-value">${bytes(d.chunk_size)}</div></div><div><div class="fact-label">Stored chunks</div><div class="fact-value">${number(d.chunk_count)}</div></div></div><div id="preview-slot"></div><p class="preview-description">Preview uses the source PDF. Trace below to measure a fresh browser renderer’s reads from SQLite WASM.</p><div class="action-row"><button class="button primary" data-action="trace" data-mutation>${icon('activity')}${manifest ? 'Retrace page' : 'Trace page'}</button><button class="button secondary" data-action="verify" data-mutation ${manifest?'':'disabled'}>${icon('check')}Verify replay</button><button class="button secondary" data-action="trace-all" data-mutation>Trace all pages</button></div><div class="section-label">CHUNK DEPENDENCIES</div>${manifest ? `<div class="manifest-summary"><span>${manifest.chunks.length} / ${d.chunk_count} chunks · ${bytes(manifest.observed_bytes)} read</span><span class="tag ${isVerified?'verified':''}">${isVerified ? 'REPLAY VERIFIED' : `${(100*manifest.observed_bytes/d.byte_length).toFixed(1)}% OF SOURCE`}</span></div><div class="chunk-map" aria-label="Chunk dependency map">${Array.from({length:Math.min(d.chunk_count,2048)},(_,n)=>`<span class="chunk-cell ${manifest.chunks.includes(n)?'used':''}" title="Chunk ${n}: bytes ${n*d.chunk_size}–${Math.min((n+1)*d.chunk_size,d.byte_length)-1}${manifest.chunks.includes(n)?' · Read during trace':''}"></span>`).join('')}</div><div class="chunk-legend"><span><span class="legend-dot"></span>Read by page ${page}</span><span><span class="legend-dot unused"></span>Not read</span>${d.chunk_count>2048?'<span>First 2,048 chunks shown</span>':''}</div>` : '<div class="simple-empty" style="padding:20px 10px">Trace this page to see exactly which chunks it needs.</div>'}`;
  mountPreview(previewPane);
  void renderPreview();
}
function mountPreview(pane) {
  if (pane?.dataset.previewDocument !== selectedId) pane = null;
  if (!pane) {
    pane = document.createElement('div');
    pane.id = 'preview-pane';
    pane.dataset.previewDocument = selectedId;
    pane.innerHTML = `<div class="preview-toolbar"><span class="small-muted">DOCUMENT PREVIEW</span><button class="button small secondary" data-action="open-reader">Open reader</button></div><div class="preview-toolbar"><div class="page-control"><button data-action="previous" aria-label="Previous page">‹</button><label for="page-number">Page</label><input id="page-number" type="number" min="1" aria-label="Page number"><span id="preview-page-count"></span><button data-action="next" aria-label="Next page">›</button></div><div class="preview-zoom"><label for="preview-zoom">Zoom</label><select id="preview-zoom" aria-label="Preview zoom"><option value="fit">Fit page</option><option value="1">100%</option><option value="1.5">150%</option><option value="2">200%</option></select></div></div><div class="preview-stage"><div class="preview-frame" id="preview-frame" aria-label="Document page" tabindex="0"></div><span id="preview-status" class="preview-status" role="status"></span></div>`;
  }
  $('#preview-slot').append(pane);
  pane.querySelector('[data-action="previous"]').disabled = page <= 1;
  pane.querySelector('[data-action="next"]').disabled = page >= detail.document.page_count;
  pane.querySelector('#page-number').value = page;
  pane.querySelector('#page-number').max = detail.document.page_count;
  pane.querySelector('#preview-page-count').textContent = `of ${detail.document.page_count}`;
  pane.querySelector('#preview-zoom').value = previewZoom;
  previewObserver.disconnect();
  previewObserver.observe($('#preview-frame'));
}
// Resize only the bitmap; CSS reserves the viewport before any PDF work starts.
const previewObserver = new ResizeObserver(() => {
  const frame = $('#preview-frame');
  if (!frame?.clientWidth || !frame.clientHeight) return;
  if (`${frame.clientWidth}:${frame.clientHeight}` === previewSize) return;
  clearTimeout(previewResizeTimer);
  previewResizeTimer = setTimeout(() => void renderPreview(), 100);
});
async function renderPreview() {
  clearTimeout(previewResizeTimer);
  const frame = $('#preview-frame'), status = $('#preview-status');
  if (!frame?.clientWidth || !frame.clientHeight || !detail || currentView !== 'documents') return;
  const generation = ++previewGeneration, id = selectedId, targetPage = page, zoom = previewZoom;
  const isCurrent = () => generation === previewGeneration && frame.isConnected && selectedId === id && currentView === 'documents';
  previewSize = `${frame.clientWidth}:${frame.clientHeight}`;
  frame.setAttribute('aria-busy', 'true');
  status.textContent = `Rendering page ${targetPage}…`;
  status.hidden = false;
  try {
    renderTask?.cancel();
    if (!pdfjs) {
      pdfjs = await import('/vendor/pdf.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';
    }
    if (!isCurrent()) return;
    if (previewId !== id) {
      const previousTask = previewTask;
      previewId = null;
      previewTask = null;
      previewDoc = null;
      await previousTask?.destroy();
      if (!isCurrent()) return;
      const data = await getDocumentBytes(id);
      if (!isCurrent()) return;
      previewId = id;
      previewTask = pdfjs.getDocument({ data, cMapUrl: '/vendor/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/standard_fonts/', wasmUrl:'/vendor/wasm/', iccUrl:'/vendor/iccs/', isEvalSupported:false, enableXfa:false });
      previewDoc = null;
    }
    const loadedDoc = await previewTask.promise;
    if (!isCurrent()) return;
    previewDoc = loadedDoc;
    const pdfPage = await previewDoc.getPage(targetPage);
    if (!isCurrent()) return;
    const original = pdfPage.getViewport({ scale: 1 });
    // PDF units are 72/inch; CSS pixels are 96/inch. At 100%, ordinary
    // document text is readable without being shrunk to the inspector width.
    const scale = zoom === 'fit'
      ? Math.min(Math.max(1, frame.clientWidth - 48) / original.width, Math.max(1, frame.clientHeight - 48) / original.height)
      : Number(zoom) * 96 / 72;
    const width = original.width * scale, height = original.height * scale;
    // Limit backing-store memory for unusually large pages without changing zoom.
    const outputScale = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(20000000 / (width * height)), 16384 / width, 16384 / height);
    const viewport = pdfPage.getViewport({ scale: scale * outputScale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    canvas.setAttribute('aria-label', `PDF preview, page ${targetPage}`);
    renderTask = pdfPage.render({canvasContext:canvas.getContext('2d'), viewport, annotationMode:pdfjs.AnnotationMode.DISABLE});
    await renderTask.promise;
    if (!isCurrent()) return;
    // Keep the previous complete page visible until the new bitmap is ready.
    frame.replaceChildren(canvas);
    frame.scrollTop = 0; frame.scrollLeft = 0;
  } catch (error) {
    if (!isCurrent() || error.name === 'RenderingCancelledException') return;
    frame.innerHTML = `<div class="preview-error">Preview unavailable: ${escapeHtml(error.message)}<br>You can still download the original PDF or inspect its chunks.</div>`;
  } finally {
    if (isCurrent()) { frame.setAttribute('aria-busy', 'false'); status.hidden = true; }
  }
}
function renderManifests() {
  $('#inspector-content').innerHTML = `<p class="small-muted" style="margin-top:0">Only complete cold renders publish a manifest. Replays must match the recorded pixel hash.</p>${detail.manifests.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Page</th><th>Dimensions</th><th>Chunks</th><th>Bytes read</th><th>Replay</th></tr></thead><tbody>${detail.manifests.map(m=>`<tr><td><button class="text-button" data-page="${m.page_number}">${m.page_number} ↗</button></td><td>${Math.round(m.width)} × ${Math.round(m.height)}</td><td>${m.chunks.length}</td><td>${bytes(m.observed_bytes)}</td><td>${verified.get(`${selectedId}:${m.page_number}`)===m.pixel_sha256 ? '<span class="tag verified">VERIFIED</span>':'<span class="small-muted">Not checked</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="simple-empty">No page manifests yet.<br>Run a trace from the Overview tab.</div>'}<div class="section-label">COMBINE PAGE RANGES</div><label for="range-pages" class="small-muted">Enter traced pages, for example 1, 2 or 1–3.</label><form id="range-form" class="range-form"><input id="range-pages" placeholder="1, 2" value="${detail.manifests.map(m=>m.page_number).slice(0,10).join(', ')}" aria-label="Pages for byte ranges"><button class="button secondary" type="submit">Get ranges</button></form><div id="range-result"></div><p class="small-muted">Ranges are deduplicated, contiguous, and half-open: [start, end).</p>`;
}
function parsePages(input, max) {
  const result = new Set();
  for (const part of input.split(',')) {
    const match = part.trim().match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
    if (!match) throw new Error('Use page numbers separated by commas, or a range such as 1–3.');
    const start = Number(match[1]), end = Number(match[2] || match[1]);
    if (start < 1 || end < start || end > max || end-start > 99) throw new Error(`Choose up to 100 pages between 1 and ${max}.`);
    for (let n=start;n<=end;n++) result.add(n);
  }
  if (!result.size || result.size > 100) throw new Error('Choose between 1 and 100 pages.');
  return [...result];
}
async function uploadFiles(files, { read = false } = {}) {
  let acceptedId;
  await operation(`Uploading ${files.length} PDF${files.length===1?'':'s'}…`, async () => {
    let accepted = 0, failures = [];
    for (const file of files) {
      notify(`Validating and storing ${file.name}…`, 'busy');
      try {
        if (file.size > 25 * 1024 * 1024) throw new Error('File exceeds the 25 MB limit.');
        const params = new URLSearchParams({ filename:file.name, chunkSize:$('#chunk-size').value });
        const result = await api(`/documents?${params}`, {method:'POST',headers:{'Content-Type':'application/pdf'},body:file});
        accepted++;
        log(`${result.duplicate?'Existing PDF selected':'Uploaded'}: ${file.name} · ${bytes(file.size)} · ${result.document.page_count} pages.`);
        selectedId = result.document.document_id;
      } catch (error) { failures.push(`${file.name}: ${error.message}`); log(failures.at(-1), true); }
    }
    await refreshState();
    if (accepted) { await selectDocument(selectedId); setView('documents'); acceptedId = selectedId; }
    notify(failures.length ? `${accepted} accepted. ${failures.join(' ')}` : `${accepted} PDF${accepted===1?'':'s'} ready to inspect. Select a page and run a cold trace.`, failures.length?'error':'');
  });
  $('#file-input').value = '';
  if (read && acceptedId === selectedId && detail) await openReader();
}
async function tracePages(pages) {
  const id = selectedId;
  await operation(`Tracing ${pages.length} page${pages.length===1?'':'s'} with a fresh renderer…`, async () => {
    let successes = 0, failures = [];
    for (let i=0;i<pages.length;i++) {
      notify(`Tracing page ${pages[i]} · ${i+1} of ${pages.length}…`, 'busy');
      verified.delete(`${id}:${pages[i]}`);
      const {results} = await post(`/documents/${id}/index`, {pages:[pages[i]]});
      for (const result of results) {
        if (result.success) { successes++; log(`Traced page ${result.pageNumber}: ${result.chunks.length} chunks, ${bytes(result.observedBytes)} of ${bytes(result.sourceBytes)} read.`); }
        else { failures.push(`Page ${result.pageNumber}: ${result.error}`); log(failures.at(-1),true); }
      }
    }
    await refreshState();
    if (selectedId === id) await selectDocument(id,true);
    notify(failures.length ? `${successes} traced. ${failures.join(' ')}` : `${successes} page${successes===1?'':'s'} traced successfully. The manifest is ready for replay verification.`,failures.length?'error':'');
  });
}
async function verifyCurrent() {
  const id = selectedId, targetPage = page;
  await operation(`Replaying page ${targetPage} using only its recorded chunks…`, async () => {
    const {results} = await post(`/documents/${id}/verify`, {pages:[targetPage]});
    const result = results[0];
    if (!result.success) { verified.delete(`${id}:${targetPage}`); throw new Error(result.error); }
    verified.set(`${id}:${targetPage}`,result.pixelSha256);
    if (selectedId===id) renderInspector();
    log(`Verified page ${targetPage}: replay pixels match the cold trace, with no fallback reads.`);
    notify(`Page ${targetPage} verified. Pixel hashes match using only the manifest’s recorded chunks.`);
  });
}
async function confirmAction(title, description, action) {
  const dialog = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-description').textContent = description;
  $('#confirm-submit').textContent = action;
  dialog.returnValue = '';
  const choice = new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), {once:true}));
  dialog.showModal();
  return choice;
}
async function clearSelection() {
  if (reader.active) await reader.exit();
  previewObserver.disconnect();
  clearTimeout(previewResizeTimer);
  ++detailGeneration; ++previewGeneration;
  selectedId = null; detail = null; previewId = null; previewDoc = null;
  renderTask?.cancel(); await previewTask?.destroy(); previewTask = null;
  renderInspector(); renderDocuments();
}
async function deleteDocument() {
  const { document_id:id, filename } = detail.document;
  if (!await confirmAction('Delete this PDF?', `${filename} and all of its stored chunks and page manifests will be removed from this session.`, 'Delete PDF')) return;
  await operation('Deleting PDF…',async()=>{
    clearQueryResults('Source document deleted. Run a query to refresh the results.');
    await api(`/documents/${id}`,{method:'DELETE'});
    await clearSelection(); await refreshState();
    if(state.documents.length) await selectDocument(state.documents[0].document_id);
    log(`Deleted ${filename} and its dependent records.`); notify('PDF deleted.');
  });
}
async function resetSession() {
  if (!await confirmAction('Reset this browser session?', 'This removes every uploaded PDF, stored chunk, and page manifest from this tab’s memory. Other tabs have their own databases.', 'Reset session')) return;
  await operation('Resetting database…',async()=>{
    clearQueryResults('Session reset. Run a query to inspect the empty database.');
    await post('/reset'); verified.clear();
    await clearSelection(); await refreshState();
    log('Database session reset. All source PDFs and manifests cleared.'); notify('Session reset. Your database is empty.');
  });
}
function setView(view, expandSchema = false) {
  ++previewGeneration;
  renderTask?.cancel();
  clearTimeout(previewResizeTimer);
  expandSchema ||= view === 'schema'; // Keep existing schema bookmarks useful.
  if (view === 'schema') view = 'query';
  if (!['documents','query','activity'].includes(view)) view = 'documents';
  currentView = view;
  const text = {documents:['Documents','Document explorer','Upload, trace, and inspect. A closer look at your PDF pipeline.'],query:['SQL console','SQL console','Inspect your session with read-only SQL and export the results.'],activity:['Activity log','Session activity','A record of uploads, traces, queries, and verification results in this tab.']}[view];
  $('#breadcrumb-current').textContent=text[0]; $('#page-title').textContent=text[1]; $('#page-subtitle').textContent=text[2];
  document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!==`view-${view}`);
  document.querySelectorAll('.nav-item').forEach(el=>{el.classList.toggle('active',el.dataset.view===view); if(el.dataset.view===view)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
  if (expandSchema && !$('#schema-reference').open) $('#schema-reference').open = true;
  else refreshSchema();
  if(view==='activity') renderLogs();
  if(view==='documents') void renderPreview();
  history.replaceState(null,'',`#${view}`);
}
function refreshSchema() {
  if (currentView === 'query' && $('#schema-reference').open) void loadSchema();
}
let schemaGeneration = 0;
async function loadSchema() {
  const generation = ++schemaGeneration;
  try {
    const {tables} = await api('/schema');
    if (generation !== schemaGeneration) return;
    $('#schema-tables').innerHTML=tables.map(t=>`<section class="panel schema-card"><div class="panel-heading"><h2>${icon('database')}${escapeHtml(t.name)}</h2><span class="count-pill">${number(t.rowCount)} rows</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Column</th><th>Type</th><th>Constraint</th></tr></thead><tbody>${t.columns.map(c=>`<tr><td class="monospace">${escapeHtml(c.name)}</td><td>${escapeHtml(c.type)}</td><td>${c.pk?'PRIMARY KEY':c.notnull?'NOT NULL':'—'}</td></tr>`).join('')}</tbody></table></div><details><summary>View CREATE TABLE statement</summary><pre>${escapeHtml(t.sql)}</pre></details></section>`).join('');
  } catch (error) {
    if (generation === schemaGeneration) $('#schema-tables').innerHTML = `<div class="query-error">Unable to load schema: ${escapeHtml(error.message)}</div>`;
  }
}
function clearQueryResults(message) {
  disposeQueryResults();
  disposeQueryResults = () => {};
  queryResult = null;
  ++queryGeneration;
  const empty = document.createElement('div');
  empty.className = 'simple-empty';
  empty.textContent = message;
  $('#query-results').replaceChildren(empty);
  $('#result-count').textContent = '—';
  $('#query-time').textContent = '';
  $('#export-csv').disabled = true;
}
async function runQuery() {
  if (queryPending) return;
  clearQueryResults('Running query…');
  const generation = ++queryGeneration;
  queryPending=true; $('#run-query').disabled=true; $('#run-query').textContent='Running…';
  $('#export-csv').disabled=true; queryResult=null;
  try {
    const result=await post('/query',{sql:$('#sql-editor').value});
    if (generation !== queryGeneration) return;
    queryResult=result;
    $('#result-count').textContent=`${result.rows.length}${result.truncated?'+':''}`;
    $('#query-time').textContent=`${result.elapsedMs.toFixed(1)} ms${result.truncated?' · results truncated':''}`;
    const pages = createPdfPageCells({
      resolvePage: getTracedPageSource,
      readRange: readDocumentRange,
      onOpen: (sourceDocument, pageNumber) => reader.open(sourceDocument, pageNumber),
    });
    const disposeTable = renderSqlResults($('#query-results'), result, ({ container, column, value }) => {
      if (/^pdf/i.test(column) && value !== null) return pages.mount(container, value);
    });
    disposeQueryResults = () => { disposeTable(); pages.dispose(); };
    $('#export-csv').disabled=!result.columns.length;
    log(`SQL query completed: ${result.rows.length}${result.truncated?'+':''} rows in ${result.elapsedMs.toFixed(1)} ms.`);
  } catch(error) {
    if (generation !== queryGeneration) return;
    $('#query-results').innerHTML=`<div class="query-error">${escapeHtml(error.message)}</div>`;
    $('#result-count').textContent='—';$('#query-time').textContent='';log(`SQL: ${error.message}`,true);
  } finally {queryPending=false;$('#run-query').disabled=false;$('#run-query').innerHTML='Run query <span>▶</span>';}
}
function exportCsv() {
  if(!queryResult)return;
  const field=value=>`"${String(value??'').replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')}"`;
  const content=[queryResult.columns,...queryResult.rows].map(row=>row.map(field).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download='pdf-workbench-query.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
document.addEventListener('click',async event=>{
  const viewButton=event.target.closest('[data-view]');
  if(viewButton){event.preventDefault();setView(viewButton.dataset.view, viewButton.hasAttribute('data-open-schema'));return;}
  const docButton=event.target.closest('[data-document]');
  if(docButton){try{await selectDocument(docButton.dataset.document);}catch(error){notify(error.message,'error');}return;}
  const tab=event.target.closest('[data-tab]');
  if(tab){inspectorTab=tab.dataset.tab;++previewGeneration;renderTask?.cancel();renderInspector();return;}
  const pageButton=event.target.closest('[data-page]');
  if(pageButton){page=Number(pageButton.dataset.page);inspectorTab='overview';renderInspector();return;}
  if(event.target.closest('#sample-button')){
    if(pending)return;
    await operation('Preparing sample PDF…',async()=>{
      const response=await fetch('/sample.pdf');
      if(!response.ok)throw new Error('Unable to load the sample PDF.');
      const file=new File([await response.blob()],'range-index-sample.pdf',{type:'application/pdf'});
      setBusy(false);await uploadFiles([file]);
    });return;
  }
  const action=event.target.closest('[data-action]')?.dataset.action;
  if(!action)return;
  if(action==='open-reader')await openReader();
  if(action==='download'){
    const {document_id:id,filename}=detail.document;
    await operation('Preparing original PDF…',async()=>{
      const data=await getDocumentBytes(id);
      const url=URL.createObjectURL(new Blob([data],{type:'application/pdf'}));
      const link=document.createElement('a');link.href=url;link.download=filename;link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);notify('Original PDF downloaded from browser memory.');
    });
  }
  if(action==='previous'||action==='next'){page=Math.max(1,Math.min(detail.document.page_count,page+(action==='next'?1:-1)));renderInspector();}
  if(action==='trace')await tracePages([page]);
  if(action==='trace-all'){
    const count=detail.document.page_count;
    if(count>20&&!await confirmAction(`Trace all ${count} pages?`,'Each page uses a fresh renderer. This may take several minutes; keep this tab open.','Trace all pages'))return;
    await tracePages(Array.from({length:count},(_,i)=>i+1));
  }
  if(action==='verify')await verifyCurrent();
  if(action==='delete')await deleteDocument();
});
document.addEventListener('change',event=>{
  if(event.target.id==='preview-zoom'){previewZoom=event.target.value;void renderPreview();}
  if(event.target.id==='page-number'){
    const value=Number(event.target.value);
    if(!Number.isSafeInteger(value)||value<1||value>detail.document.page_count){event.target.value=page;notify(`Choose a page between 1 and ${detail.document.page_count}.`,'error');return;}
    page=value;renderInspector();
  }
});
document.addEventListener('submit',async event=>{
  if(event.target.id!=='range-form')return;
  event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;
  const output=$('#range-result'), id=selectedId;
  try{
    const pages=parsePages($('#range-pages').value,detail.document.page_count);
    const result=await post(`/documents/${id}/ranges`,{pages});
    if(!output.isConnected || selectedId!==id)return;
    output.innerHTML=`<div class="range-output"><strong>${result.ranges.length} ranges · ${result.chunks.length} chunks · ${bytes(result.bytes)} / ${bytes(result.sourceBytes)}</strong><br><span class="monospace">${result.ranges.map(r=>`[${r[0]}, ${r[1]})`).join('<br>')}</span></div>`;
    log(`Computed deduplicated ranges for pages ${pages.join(', ')}: ${bytes(result.bytes)}.`);
  }catch(error){if(output.isConnected && selectedId===id)output.innerHTML=`<div class="query-error">${escapeHtml(error.message)}</div>`;}finally{button.disabled=false;}
});
$('#upload-button').onclick=$('#browse-button').onclick=()=>$('#file-input').click();
$('#file-input').onchange=()=>void uploadFiles([...$('#file-input').files]);
const drop=$('#drop-zone');
for(const name of ['dragenter','dragover'])drop.addEventListener(name,event=>{event.preventDefault();if(!pending)drop.classList.add('dragging');});
for(const name of ['dragleave','drop'])drop.addEventListener(name,event=>{event.preventDefault();drop.classList.remove('dragging');});
drop.addEventListener('drop',event=>{if(!pending&&event.dataTransfer.files.length)void uploadFiles([...event.dataTransfer.files]);});
window.addEventListener('dragover',event=>event.preventDefault());
window.addEventListener('drop',event=>event.preventDefault());
$('#document-search').oninput=renderDocuments;
$('#reset-button').onclick=resetSession;
$('#schema-reference').addEventListener('toggle', refreshSchema);
$('#query-preset').onchange=()=>$('#sql-editor').value=presets[$('#query-preset').value];
$('#run-query').onclick=runQuery;
$('#export-csv').onclick=exportCsv;
$('#clear-log').onclick=()=>{logs=[];$('#log-count').textContent='0';renderLogs();};
document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();setView('query');void runQuery();}});
window.addEventListener('hashchange',()=>setView(location.hash.slice(1)));
window.addEventListener('beforeunload',event=>{if(pending){event.preventDefault();event.returnValue='';}});
try {
  await refreshState(); setView(location.hash.slice(1)||'documents');
  if(state.documents.length)await selectDocument(state.documents[0].document_id);
  log('SQLite WASM is ready in this tab. PDF bytes stay in browser memory.');
}catch(error){$('#connection-label').textContent='Unavailable';notify(`Could not initialize browser SQLite: ${error.message}`,'error');}
