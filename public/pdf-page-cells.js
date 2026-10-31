import { decodePdfAddress } from './pdf-address.js';
import { createRangeSource } from './reader-transport.js';

export const PDF_PAGE_WIDTHS = Object.freeze([240, 320, 480, 640, 800]);

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
export function createPdfPageCells({ resolvePage, readRange, onOpen, width = 320 }) {
  if (!PDF_PAGE_WIDTHS.includes(width)) throw new Error('Unsupported page width');
  const documents = new Map();
  const cells = new Map();
  const queue = [];
  let running = 0, disposed = false;
  let popup = null;

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

  function release(cell, keepDocument = false) {
    ++cell.generation;
    cell.cancelText?.();
    cell.cancelText = null;
    // reset frees this view's layers/canvas without cleaning a PDFPageProxy
    // that another cell may still be using. The document owns shared cleanup.
    cell.view?.reset();
    void cell.view?.l10n.destroy().catch(() => {});
    cell.view = null;
    if (!keepDocument) {
      cell.lease?.release();
      cell.lease = null;
    }
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
      const [{ document: sourceDocument, manifest }, { pdfjs, PDFPageView, EventBus }] = await Promise.all([
        resolvePage(cell.address), loadComponents(),
      ]);
      if (!current()) return;
      cell.stage.style.setProperty('--pdf-page-ratio', manifest.width / manifest.height);
      cell.lease ||= acquire(sourceDocument);
      const pdf = await cell.lease.promise;
      if (!current()) return;
      const pdfPage = await pdf.getPage(cell.address.pageNumber);
      if (!current()) return;
      const viewport = pdfPage.getViewport({ scale: 1 });
      cell.stage.style.setProperty('--pdf-page-ratio', viewport.width / viewport.height);
      // Grid pages fit the chosen width and grow naturally in height. Only the
      // near-fullscreen preview fits both dimensions of its available space.
      const cssScale = cell.expanded
        ? Math.min((cell.stage.clientWidth - 20) / viewport.width, (cell.stage.clientHeight - 20) / viewport.height)
        : (width - 20) / viewport.width;
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
    if (cell.expanded) queue.unshift(cell);
    else queue.push(cell);
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

  function createCell(address, expanded = false) {
    const card = document.createElement('section');
    card.className = 'pdf-page-cell';
    card.style.setProperty('--pdf-cell-width', `${width}px`);
    const stage = document.createElement('div');
    stage.className = 'pdf-cell-stage pdfViewer';
    const status = document.createElement('div');
    status.className = 'pdf-cell-status';
    status.setAttribute('role', 'status');
    status.textContent = 'Scroll into view to load page';
    const open = document.createElement('button');
    open.className = 'button small secondary';
    open.textContent = expanded ? 'Open full reader' : 'Enlarge';
    open.disabled = true;
    open.setAttribute('aria-label', expanded ? 'Open full reader' : `Enlarge page ${address.pageNumber}`);
    const footer = document.createElement('div');
    footer.className = 'pdf-cell-footer';
    footer.append(status, open);
    card.append(stage, footer);
    const cell = { address, card, stage, status, open, generation: 0, visible: expanded, expanded };
    cells.set(card, cell);
    return cell;
  }

  function closePopup() {
    if (!popup) return;
    const previous = popup;
    popup = null;
    clearTimeout(previous.timer);
    previous.resize.disconnect();
    previous.cell.removed = true;
    cells.delete(previous.cell.card);
    release(previous.cell);
    previous.cell.open.onclick = null;
    previous.dialog.close();
    previous.dialog.remove();
    if (previous.origin.open.isConnected) previous.origin.open.focus({ preventScroll: true });
  }

  function enlarge(origin) {
    closePopup();
    const dialog = document.createElement('dialog');
    dialog.className = 'pdf-page-popup';
    dialog.setAttribute('aria-label', 'Page preview');
    const cell = createCell(origin.address, true);
    const close = document.createElement('button');
    close.className = 'button small secondary';
    close.textContent = 'Close preview';
    close.autofocus = true;
    close.onclick = closePopup;
    cell.card.querySelector('.pdf-cell-footer').append(close);
    dialog.append(cell.card);
    document.body.append(dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); closePopup(); });
    dialog.addEventListener('close', () => { if (popup?.dialog === dialog) closePopup(); });
    dialog.addEventListener('click', event => {
      const rect = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right ||
          event.clientY < rect.top || event.clientY > rect.bottom)) closePopup();
    });
    cell.open.onclick = async () => {
      const generation = cell.generation;
      cell.open.disabled = true;
      try {
        // Revalidate in case the source was deleted after the result was read.
        const { document: sourceDocument } = await resolvePage(cell.address);
        if (disposed || cell.removed || generation !== cell.generation) return;
        closePopup();
        await onOpen(sourceDocument, cell.address.pageNumber);
      } catch (error) {
        if (!disposed && !origin.removed) (cell.removed ? origin.status : cell.status).textContent = error.message;
      } finally {
        if (!disposed && !cell.removed && cell.view) cell.open.disabled = false;
      }
    };
    const resize = new ResizeObserver(() => {
      if (popup?.cell !== cell) return;
      const size = `${cell.stage.clientWidth}:${cell.stage.clientHeight}`;
      if (popup.size === size) return;
      popup.size = size;
      clearTimeout(popup.timer);
      popup.timer = setTimeout(() => {
        if (popup?.cell !== cell) return;
        release(cell, true);
        enqueue(cell);
      }, 100);
    });
    popup = { dialog, cell, origin, resize };
    dialog.showModal();
    popup.size = `${cell.stage.clientWidth}:${cell.stage.clientHeight}`;
    resize.observe(cell.stage);
    enqueue(cell);
  }

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
    const cell = createCell(address);
    container.replaceChildren(cell.card);
    cell.open.onclick = () => enlarge(cell);
    observer.observe(cell.card);
    return () => {
      if (popup?.origin === cell) closePopup();
      cell.removed = true;
      observer.unobserve(cell.card);
      cells.delete(cell.card);
      release(cell);
      cell.open.onclick = null;
    };
  }
  return {
    mount,
    setWidth(nextWidth) {
      if (!PDF_PAGE_WIDTHS.includes(nextWidth)) throw new Error('Unsupported page width');
      if (width === nextWidth || disposed) return;
      width = nextWidth;
      for (const cell of cells.values()) {
        if (cell.expanded) continue;
        cell.card.style.setProperty('--pdf-cell-width', `${width}px`);
        release(cell, true);
        enqueue(cell);
      }
    },
    dispose() {
      disposed = true;
      closePopup();
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
