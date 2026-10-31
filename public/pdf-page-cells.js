import { decodePdfAddress } from './pdf-address.js';
import { createRangeSource } from './reader-transport.js';

let components;
async function loadComponents() {
  return components ??= (async () => {
    // The component bundle uses the core's global pdfjsLib. Load core first.
    const pdfjs = await import('/vendor/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';
    const { PDFPageView, EventBus } = await import('/vendor/pdf_viewer.mjs');
    const response = await fetch('/vendor/pdf_viewer.css');
    if (!response.ok) throw new Error('Unable to load PDF page styles');
    // Upstream includes generic selectors such as .sidebar. Keep them inside
    // this component, with its :root variables applied to each cell instead.
    const style = document.createElement('style');
    const css = (await response.text()).replaceAll(':root', ':scope')
      .replace(/url\((["']?)images\//g, 'url($1/pdfjs/web/images/');
    style.textContent = `@scope (.pdf-page-cell) {\n${css}\n}`;
    document.head.append(style);
    return { pdfjs, PDFPageView, EventBus };
  })().catch(error => { components = null; throw error; });
}

// Storage and navigation are injected; this module knows nothing about SQL,
// result columns, the inspector, or the database implementation.
export function createPdfPageCells({ resolvePage, readRange, onOpen }) {
  const documents = new Map();
  const cells = new Map();
  const queue = [];
  let running = 0, disposed = false;

  function acquire(sourceDocument) {
    const id = sourceDocument.document_id;
    let entry = documents.get(id);
    if (!entry) {
      entry = { refs: 0, stopped: false, task: null, source: null };
      documents.set(id, entry);
      entry.promise = (async () => {
        const { pdfjs } = await loadComponents();
        if (entry.stopped) throw new Error('Page view cancelled');
        entry.source = await createRangeSource(pdfjs, {
          byteLength: sourceDocument.byte_length,
          chunkSize: sourceDocument.chunk_size,
          filename: sourceDocument.filename,
          readRange: (begin, end) => readRange(id, begin, end),
          onError: () => { void entry.task?.destroy().catch(() => {}); },
        });
        if (entry.stopped) { entry.source.abort(); throw new Error('Page view cancelled'); }
        entry.task = pdfjs.getDocument({
          range: entry.source.transport,
          rangeChunkSize: sourceDocument.chunk_size,
          disableAutoFetch: true, disableStream: true,
          enableXfa: false, isEvalSupported: false,
          cMapUrl: '/vendor/cmaps/', cMapPacked: true,
          standardFontDataUrl: '/vendor/standard_fonts/',
          wasmUrl: '/vendor/wasm/', iccUrl: '/vendor/iccs/',
        });
        entry.task.onPassword = () => entry.source.abort(new Error('Encrypted PDFs are not supported'));
        return await Promise.race([entry.task.promise, entry.source.failure]);
      })();
    }
    entry.refs++;
    let released = false;
    return {
      promise: entry.promise,
      release() {
        if (released) return;
        released = true;
        if (--entry.refs) return;
        if (documents.get(id) === entry) documents.delete(id);
        entry.stopped = true;
        entry.source?.abort();
        void entry.task?.destroy().catch(() => {});
      },
    };
  }

  function release(cell) {
    ++cell.generation;
    cell.cancelText?.();
    cell.cancelText = null;
    // reset frees this view's layers/canvas without cleaning a PDFPageProxy
    // that another cell may still be using. The document owns shared cleanup.
    cell.view?.reset();
    void cell.view?.l10n.destroy().catch(() => {});
    cell.view = null;
    cell.lease?.release();
    cell.lease = null;
    cell.stage.replaceChildren();
    cell.card.removeAttribute('aria-busy');
    cell.open.disabled = true;
  }

  async function render(cell) {
    const generation = ++cell.generation;
    const current = () => !disposed && !cell.removed && cell.visible && generation === cell.generation;
    cell.status.textContent = 'Loading page…';
    cell.card.setAttribute('aria-busy', 'true');
    try {
      const [{ document: sourceDocument }, { pdfjs, PDFPageView, EventBus }] = await Promise.all([
        resolvePage(cell.address), loadComponents(),
      ]);
      if (!current()) return;
      cell.label.textContent = `${sourceDocument.filename} · Page ${cell.address.pageNumber}`;
      cell.lease = acquire(sourceDocument);
      const pdf = await cell.lease.promise;
      if (!current()) return;
      const pdfPage = await pdf.getPage(cell.address.pageNumber);
      if (!current()) return;
      const viewport = pdfPage.getViewport({ scale: 1 });
      // Fit within the fixed 320 × 420 stage, allowing for padding and border.
      const cssScale = Math.min(300 / viewport.width, 400 / viewport.height);
      const eventBus = new EventBus();
      const view = cell.view = new PDFPageView({
        container: cell.stage, id: cell.address.pageNumber, eventBus,
        scale: cssScale * 72 / 96,
        defaultViewport: pdfPage.getViewport({ scale: cssScale }),
        textLayerMode: 1, annotationMode: pdfjs.AnnotationMode.DISABLE,
        enableAutoLinking: false, enableDetailCanvas: false,
        maxCanvasPixels: 2_000_000, maxCanvasDim: 4096,
      });
      view.setPdfPage(pdfPage);
      // draw() can finish before text extraction. Keep the queue slot until
      // selection is ready, and detach the listener on cancellation as well.
      const textReady = new Promise((resolve, reject) => {
        const done = event => {
          if (event.source !== view) return;
          eventBus.off('textlayerrendered', done);
          cell.cancelText = null;
          event.error ? reject(event.error) : resolve();
        };
        eventBus.on('textlayerrendered', done);
        cell.cancelText = () => { eventBus.off('textlayerrendered', done); resolve(); };
      });
      await Promise.all([view.draw(), textReady]);
      if (!current()) return;
      cell.status.textContent = '';
      cell.card.setAttribute('aria-busy', 'false');
      cell.open.disabled = false;
    } catch (error) {
      if (!current()) return;
      release(cell);
      cell.failed = true;
      cell.status.textContent = `Preview unavailable: ${error.message}`;
    }
  }

  function pump() {
    while (!disposed && running < 2 && queue.length) {
      const cell = queue.shift();
      cell.queued = false;
      if (cell.removed || !cell.visible || cell.view || cell.rendering || cell.failed) continue;
      running++;
      cell.rendering = true;
      void render(cell).finally(() => {
        running--;
        cell.rendering = false;
        // It may have left and re-entered the viewport while awaiting storage.
        enqueue(cell);
        pump();
      });
    }
  }
  function enqueue(cell) {
    if (disposed || cell.removed || !cell.visible || cell.queued || cell.rendering || cell.view || cell.failed) return;
    cell.queued = true;
    queue.push(cell);
    pump();
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const cell = cells.get(entry.target);
      if (!cell || cell.visible === entry.isIntersecting) continue;
      cell.visible = entry.isIntersecting;
      if (cell.visible) enqueue(cell);
      else {
        release(cell);
        cell.status.textContent = 'Scroll into view to load page';
        cell.failed = false;
      }
    }
  });

  function mount(container, value) {
    let address;
    try { address = decodePdfAddress(value); }
    catch (error) {
      const message = document.createElement('div');
      message.className = 'pdf-cell-error';
      message.textContent = error.message;
      container.append(message); // Preserve the original invalid value.
      return () => message.remove();
    }
    const card = document.createElement('section');
    card.className = 'pdf-page-cell';
    card.title = value;
    const label = document.createElement('div');
    label.className = 'pdf-cell-label';
    label.textContent = `Page ${address.pageNumber}`;
    const stage = document.createElement('div');
    stage.className = 'pdf-cell-stage pdfViewer';
    const status = document.createElement('div');
    status.className = 'pdf-cell-status';
    status.setAttribute('role', 'status');
    status.textContent = 'Scroll into view to load page';
    const open = document.createElement('button');
    open.className = 'button small secondary';
    open.textContent = 'Open reader';
    open.disabled = true;
    open.setAttribute('aria-label', `Open document at page ${address.pageNumber}`);
    const footer = document.createElement('div');
    footer.className = 'pdf-cell-footer';
    footer.append(status, open);
    card.append(label, stage, footer);
    container.replaceChildren(card);
    const cell = { address, card, label, stage, status, open, generation: 0, visible: false };
    cells.set(card, cell);
    open.onclick = async () => {
      const generation = cell.generation;
      open.disabled = true;
      try {
        // Revalidate in case the source was deleted after the result was read.
        const { document: sourceDocument } = await resolvePage(address);
        if (disposed || cell.removed || generation !== cell.generation) return;
        await onOpen(sourceDocument, address.pageNumber);
      } catch (error) {
        if (!disposed && !cell.removed) status.textContent = error.message;
      } finally {
        if (!disposed && !cell.removed && cell.view) open.disabled = false;
      }
    };
    observer.observe(card);
    return () => {
      cell.removed = true;
      observer.unobserve(card);
      cells.delete(card);
      release(cell);
      open.onclick = null;
    };
  }
  return {
    mount,
    dispose() {
      disposed = true;
      observer.disconnect();
      queue.length = 0;
      for (const cell of cells.values()) {
        cell.removed = true;
        release(cell);
        cell.open.onclick = null;
      }
      cells.clear();
    },
  };
}
