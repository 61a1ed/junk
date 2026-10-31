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
const presets = {
  documents: 'SELECT d.document_id, u.filename, d.byte_length,\n       d.chunk_size, u.page_count, d.created_at\nFROM documents d\nJOIN upload_metadata u USING (document_id)\nORDER BY d.created_at DESC;',
  manifests: 'SELECT page_number, page_count, width, height,\n       observed_bytes, pixel_sha256\nFROM page_manifests\nORDER BY document_id, page_number;',
  dependencies: 'SELECT document_id, page_number, chunk_number\nFROM page_dependencies\nORDER BY document_id, page_number, chunk_number;',
  storage: 'SELECT u.filename, COUNT(*) AS chunks,\n       SUM(length(c.data)) AS stored_bytes\nFROM document_chunks c\nJOIN upload_metadata u USING (document_id)\nGROUP BY c.document_id;'
};
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
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
  $('#renderer-version').textContent = `PDF.js ${state.profile.pdfjsVersion} · SQLite`;
  $('#connection-label').textContent = state.busy || pending ? 'Working' : 'Session active';
  $('#list-footer-text').textContent = state.documents.length ? `${bytes(state.stats.sourceBytes)} / 100 MB session limit` : 'Waiting for your first PDF';
  renderDocuments();
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
  if (!detail) {
    $('#inspector').innerHTML = emptyInspector;
    setBusy(pending);
    return;
  }
  const d = detail.document;
  $('#inspector').innerHTML = `<div class="inspector-head"><div><h2>${escapeHtml(d.filename)}</h2><p title="${d.document_id}">${d.document_id.slice(0,24)}… <span>SHA-256</span></p></div><div class="row"><a class="button small secondary" href="/api/documents/${d.document_id}/pdf" download="${escapeHtml(d.filename)}">Download</a><button class="button small secondary" data-action="delete" data-mutation aria-label="Delete document">Delete</button></div></div><div class="inspector-tabs" role="tablist" aria-label="Document inspection"><button role="tab" aria-selected="${inspectorTab==='overview'}" class="inspector-tab ${inspectorTab==='overview'?'active':''}" data-tab="overview">Overview</button><button role="tab" aria-selected="${inspectorTab==='manifests'}" class="inspector-tab ${inspectorTab==='manifests'?'active':''}" data-tab="manifests">Page manifests <span class="count-pill">${detail.manifests.length}</span></button><button role="tab" aria-selected="${inspectorTab==='metadata'}" class="inspector-tab ${inspectorTab==='metadata'?'active':''}" data-tab="metadata">Metadata</button></div><div class="inspector-body" id="inspector-content"></div>`;
  if (inspectorTab === 'overview') renderOverview();
  if (inspectorTab === 'manifests') renderManifests();
  if (inspectorTab === 'metadata') $('#inspector-content').innerHTML = `<pre class="raw-metadata">${escapeHtml(JSON.stringify({document: d, profileId: state.profileId, renderingProfile: state.profile}, null, 2))}</pre>`;
  setBusy(pending);
}
function renderOverview() {
  const d = detail.document, manifest = detail.manifests.find(m => m.page_number === page);
  const isVerified = manifest && verified.get(`${selectedId}:${page}`) === manifest.pixel_sha256;
  $('#inspector-content').innerHTML = `<div class="doc-facts"><div><div class="fact-label">Source size</div><div class="fact-value">${bytes(d.byte_length)}</div></div><div><div class="fact-label">Chunk size</div><div class="fact-value">${bytes(d.chunk_size)}</div></div><div><div class="fact-label">Stored chunks</div><div class="fact-value">${number(d.chunk_count)}</div></div></div><div class="preview-toolbar"><span class="small-muted">DOCUMENT PREVIEW</span><div class="page-control"><button data-action="previous" aria-label="Previous page" ${page<=1?'disabled':''}>‹</button><label for="page-number">Page</label><input id="page-number" type="number" min="1" max="${d.page_count}" value="${page}" aria-label="Page number"><span>of ${d.page_count}</span><button data-action="next" aria-label="Next page" ${page>=d.page_count?'disabled':''}>›</button></div></div><div class="preview-frame" id="preview-frame"><span class="small-muted">Rendering preview…</span></div><p class="preview-description">Browser preview uses the source PDF. Trace below to measure a fresh Node renderer’s chunk reads.</p><div class="action-row"><button class="button primary" data-action="trace" data-mutation>${icon('activity')}${manifest ? 'Retrace page' : 'Trace page'}</button><button class="button secondary" data-action="verify" data-mutation ${manifest?'':'disabled'}>${icon('check')}Verify replay</button><button class="button secondary" data-action="trace-all" data-mutation>Trace all pages</button></div><div class="section-label">CHUNK DEPENDENCIES</div>${manifest ? `<div class="manifest-summary"><span>${manifest.chunks.length} / ${d.chunk_count} chunks · ${bytes(manifest.observed_bytes)} read</span><span class="tag ${isVerified?'verified':''}">${isVerified ? 'REPLAY VERIFIED' : `${(100*manifest.observed_bytes/d.byte_length).toFixed(1)}% OF SOURCE`}</span></div><div class="chunk-map" aria-label="Chunk dependency map">${Array.from({length:Math.min(d.chunk_count,2048)},(_,n)=>`<span class="chunk-cell ${manifest.chunks.includes(n)?'used':''}" title="Chunk ${n}: bytes ${n*d.chunk_size}–${Math.min((n+1)*d.chunk_size,d.byte_length)-1}${manifest.chunks.includes(n)?' · Read during trace':''}"></span>`).join('')}</div><div class="chunk-legend"><span><span class="legend-dot"></span>Read by page ${page}</span><span><span class="legend-dot unused"></span>Not read</span>${d.chunk_count>2048?'<span>First 2,048 chunks shown</span>':''}</div>` : '<div class="simple-empty" style="padding:20px 10px">Trace this page to see exactly which chunks it needs.</div>'}`;
  void renderPreview();
}
async function renderPreview() {
  const generation = ++previewGeneration, id = selectedId, targetPage = page;
  try {
    renderTask?.cancel();
    if (!pdfjs) {
      pdfjs = await import('/vendor/pdf.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';
    }
    if (generation !== previewGeneration) return;
    if (previewId !== id) {
      await previewTask?.destroy();
      if (generation !== previewGeneration) return;
      previewId = id;
      previewTask = pdfjs.getDocument({ url: `/api/documents/${id}/pdf`, cMapUrl: '/vendor/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/standard_fonts/', wasmUrl:'/vendor/wasm/', iccUrl:'/vendor/iccs/', isEvalSupported:false, enableXfa:false });
      previewDoc = null;
    }
    previewDoc = await previewTask.promise;
    if (generation !== previewGeneration || !$('#preview-frame')) return;
    const pdfPage = await previewDoc.getPage(targetPage);
    if (generation !== previewGeneration) return;
    const original = pdfPage.getViewport({ scale: 1 });
    const width = Math.max(100, Math.min(560, $('#preview-frame').clientWidth - 48));
    const scale = Math.min(width / original.width, 360 / original.height, 2);
    const viewport = pdfPage.getViewport({ scale: scale * Math.min(window.devicePixelRatio || 1, 2) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    canvas.style.width = `${original.width * scale}px`;
    canvas.setAttribute('aria-label', `PDF preview, page ${targetPage}`);
    renderTask = pdfPage.render({canvasContext:canvas.getContext('2d'), viewport, annotationMode:pdfjs.AnnotationMode.DISABLE});
    await renderTask.promise;
    if (generation !== previewGeneration || !$('#preview-frame')) return;
    $('#preview-frame').replaceChildren(canvas);
  } catch (error) {
    if (generation !== previewGeneration || error.name === 'RenderingCancelledException') return;
    if ($('#preview-frame')) $('#preview-frame').innerHTML = `<div class="preview-error">Preview unavailable: ${escapeHtml(error.message)}<br>You can still download the original PDF or inspect its chunks.</div>`;
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
async function uploadFiles(files) {
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
    if (accepted) { await selectDocument(selectedId); setView('documents'); }
    notify(failures.length ? `${accepted} accepted. ${failures.join(' ')}` : `${accepted} PDF${accepted===1?'':'s'} ready to inspect. Select a page and run a cold trace.`, failures.length?'error':'');
  });
  $('#file-input').value = '';
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
  ++detailGeneration; ++previewGeneration;
  selectedId = null; detail = null; previewId = null; previewDoc = null;
  renderTask?.cancel(); await previewTask?.destroy(); previewTask = null;
  renderInspector(); renderDocuments();
}
async function deleteDocument() {
  const { document_id:id, filename } = detail.document;
  if (!await confirmAction('Delete this PDF?', `${filename} and all of its stored chunks and page manifests will be removed from this session.`, 'Delete PDF')) return;
  await operation('Deleting PDF…',async()=>{
    await api(`/documents/${id}`,{method:'DELETE'});
    await clearSelection(); await refreshState();
    if(state.documents.length) await selectDocument(state.documents[0].document_id);
    log(`Deleted ${filename} and its dependent records.`); notify('PDF deleted.');
  });
}
async function resetSession() {
  if (!await confirmAction('Reset the database session?', 'This removes every uploaded PDF, stored chunk, and page manifest. Other tabs connected to this server share this database.', 'Reset session')) return;
  await operation('Resetting database…',async()=>{
    await post('/reset'); verified.clear(); queryResult=null; ++queryGeneration;
    $('#query-results').innerHTML='<div class="simple-empty">Session reset. Run a query to inspect the empty database.</div>';
    $('#result-count').textContent='—'; $('#query-time').textContent=''; $('#export-csv').disabled=true;
    await clearSelection(); await refreshState();
    if(currentView==='schema') await loadSchema();
    log('Database session reset. All source PDFs and manifests cleared.'); notify('Session reset. Your database is empty.');
  });
}
function setView(view) {
  if (!['documents','query','schema','activity'].includes(view)) view = 'documents';
  currentView = view;
  const text = {documents:['Documents','Document explorer','Upload, trace, and inspect. A closer look at your PDF pipeline.'],query:['SQL console','SQL console','Inspect your session with read-only SQL and export the results.'],schema:['Database schema','Database schema','See how original bytes, render profiles, and page dependencies fit together.'],activity:['Activity log','Session activity','A record of uploads, traces, queries, and verification results.']}[view];
  $('#breadcrumb-current').textContent=text[0]; $('#page-title').textContent=text[1]; $('#page-subtitle').textContent=text[2];
  document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!==`view-${view}`);
  document.querySelectorAll('.nav-item').forEach(el=>{el.classList.toggle('active',el.dataset.view===view); if(el.dataset.view===view)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
  if(view==='schema') void loadSchema().catch(error=>notify(error.message,'error'));
  if(view==='activity') renderLogs();
  history.replaceState(null,'',`#${view}`);
}
async function loadSchema() {
  const {tables} = await api('/schema');
  $('#schema-tables').innerHTML=tables.map(t=>`<section class="panel schema-card"><div class="panel-heading"><h2>${icon('database')}${escapeHtml(t.name)}</h2><span class="count-pill">${number(t.rowCount)} rows</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Column</th><th>Type</th><th>Constraint</th></tr></thead><tbody>${t.columns.map(c=>`<tr><td class="monospace">${escapeHtml(c.name)}</td><td>${escapeHtml(c.type)}</td><td>${c.pk?'PRIMARY KEY':c.notnull?'NOT NULL':'—'}</td></tr>`).join('')}</tbody></table></div><details><summary>View CREATE TABLE statement</summary><pre>${escapeHtml(t.sql)}</pre></details></section>`).join('');
}
async function runQuery() {
  if (queryPending) return;
  const generation = ++queryGeneration;
  queryPending=true; $('#run-query').disabled=true; $('#run-query').textContent='Running…';
  $('#export-csv').disabled=true; queryResult=null;
  try {
    const result=await post('/query',{sql:$('#sql-editor').value});
    if (generation !== queryGeneration) return;
    queryResult=result;
    $('#result-count').textContent=`${result.rows.length}${result.truncated?'+':''}`;
    $('#query-time').textContent=`${result.elapsedMs.toFixed(1)} ms${result.truncated?' · results truncated':''}`;
    $('#query-results').innerHTML=result.columns.length?`<table class="data-table"><thead><tr>${result.columns.map(c=>`<th>${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>${result.rows.map(row=>`<tr>${row.map(v=>`<td class="monospace"><span class="cell-truncate" title="${escapeHtml(v)}">${v===null?'<span class="small-muted">NULL</span>':escapeHtml(v)}</span></td>`).join('')}</tr>`).join('')}</tbody></table>${!result.rows.length?'<div class="simple-empty">Query completed. No rows matched.</div>':''}`:'<div class="simple-empty">Query returned no columns.</div>';
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
  if(viewButton){event.preventDefault();setView(viewButton.dataset.view);return;}
  const docButton=event.target.closest('[data-document]');
  if(docButton){try{await selectDocument(docButton.dataset.document);}catch(error){notify(error.message,'error');}return;}
  const tab=event.target.closest('[data-tab]');
  if(tab){inspectorTab=tab.dataset.tab;++previewGeneration;renderTask?.cancel();renderInspector();return;}
  const pageButton=event.target.closest('[data-page]');
  if(pageButton){page=Number(pageButton.dataset.page);inspectorTab='overview';renderInspector();return;}
  if(event.target.closest('#sample-button')){
    if(pending)return;
    await operation('Preparing sample PDF…',async()=>{
      const response=await fetch('/api/sample.pdf');
      if(!response.ok)throw new Error('Unable to load the sample PDF.');
      const file=new File([await response.blob()],'range-index-sample.pdf',{type:'application/pdf'});
      setBusy(false);await uploadFiles([file]);
    });return;
  }
  const action=event.target.closest('[data-action]')?.dataset.action;
  if(!action)return;
  if(action==='previous'||action==='next'){page+=action==='next'?1:-1;renderInspector();}
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
  log('Connected to in-memory SQLite. Ready for PDF uploads.');
}catch(error){$('#connection-label').textContent='Disconnected';notify(`Cannot connect to the debug server: ${error.message}`,'error');}
