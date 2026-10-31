// Integration for the unmodified PDF.js reader UI. This script runs before the
// upstream modules so their preferences, view history, and saved signatures stay
// in this iframe's memory, just like the workbench's SQLite database.
(() => {
  function memoryStorage() {
    const values = new Map();
    return Object.freeze({
      get length() { return values.size; },
      key(index) { return [...values.keys()][index] ?? null; },
      getItem(key) { return values.get(String(key)) ?? null; },
      setItem(key, value) { values.set(String(key), String(value)); },
      removeItem(key) { values.delete(String(key)); },
      clear() { values.clear(); },
    });
  }
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(window, name, { configurable: true, value: memoryStorage() });
  }

  const host = parent.document;
  const emit = (name, detail = {}) => host.dispatchEvent(new CustomEvent(name, {
    detail: { source: window, ...detail },
  }));
  let application;
  let generation = 0;
  let opening = false;
  let queue = Promise.resolve();
  const initialized = Promise.withResolvers();

  function publishPage() {
    if (!opening && application?.pdfDocument) {
      emit('pdf-workbench-reader-page', { pageNumber: application.page });
    }
  }
  function setPage(value) {
    if (!application?.pdfDocument || !Number.isSafeInteger(value)) return;
    application.page = Math.max(1, Math.min(value, application.pagesCount));
  }

  const bridge = {
    ready: initialized.promise,
    get pageNumber() { return application?.page ?? 1; },
    set pageNumber(value) { setPage(value); },
    open({ data, filename, pageNumber = 1 }) {
      const request = ++generation;
      opening = true;
      queue = queue.catch(() => {}).then(async () => {
        await initialized.promise;
        if (request !== generation) return;
        const initialView = Promise.withResolvers();
        const onInitialView = () => initialView.resolve();
        application.eventBus.on('documentinit', onInitialView);
        try {
          application.initialBookmark = `page=${Number.isSafeInteger(pageNumber) ? Math.max(1, pageNumber) : 1}`;
          // Create the typed array in the reader's realm; PDF.js may transfer it
          // to its worker, leaving the workbench's original bytes untouched.
          await application.open({ data: new Uint8Array(data), filename });
          await application.pdfViewer.firstPagePromise;
          await initialView.promise;
          // Match the generic viewer's FORCE_PAGES_LOADED_TIMEOUT: readable
          // pages must not wait forever for metadata from every other page.
          let pagesTimer;
          try {
            await Promise.race([
              application.pdfViewer.pagesPromise,
              new Promise(resolve => { pagesTimer = setTimeout(resolve, 10000); }),
            ]).catch(() => {}); // The stock viewer reports individual page errors.
          } finally {
            clearTimeout(pagesTimer);
          }
          // PDF.js reapplies the initial view after discovering mixed page sizes.
          // Let that finish before applying the workbench's requested page.
          await new Promise(resolve => requestAnimationFrame(resolve));
          if (request !== generation) return;
          setPage(pageNumber);
        } finally {
          application.eventBus.off('documentinit', onInitialView);
          if (request === generation) {
            opening = false;
            publishPage();
          }
        }
      });
      return queue;
    },
    close() {
      const request = ++generation;
      opening = true;
      queue = queue.catch(() => {}).then(async () => {
        await initialized.promise;
        if (request !== generation) return;
        // Upstream close saves edited annotations before destroying its worker;
        // callers must await this promise before removing the reader iframe.
        await application.close();
        localStorage.clear();
        sessionStorage.clear();
        opening = false;
      });
      return queue;
    },
  };
  window.PDFWorkbenchReader = bridge;

  function onViewerLoaded(event) {
    if (event.detail?.source !== window) return;
    host.removeEventListener('webviewerloaded', onViewerLoaded);
    application = window.PDFViewerApplication;
    window.PDFViewerApplicationOptions.setAll({
      defaultUrl: '',
      disablePreferences: true,
      disableHistory: true,
      externalLinkTarget: 2,
    });
    application.initializedPromise.then(() => {
      application.eventBus.on('pagechanging', publishPage);
      initialized.resolve(bridge);
      emit('pdf-workbench-reader-ready');
    }, initialized.reject);
  }
  host.addEventListener('webviewerloaded', onViewerLoaded);
  window.addEventListener('pagehide', () => host.removeEventListener('webviewerloaded', onViewerLoaded), { once: true });

  // Keep stock Open, Ctrl/Cmd+O, and file drops connected to the workbench's
  // import flow, so the document being read is also the document being traced.
  function importFiles(event, files) {
    if (!files?.length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    emit('pdf-workbench-reader-files', { files: Array.from(files) });
  }
  document.addEventListener('change', event => {
    if (event.target.id === 'fileInput') importFiles(event, event.target.files);
  }, true);
  document.addEventListener('drop', event => {
    if ([...event.dataTransfer?.files ?? []].some(file => file.type === 'application/pdf' || /\.pdf$/i.test(file.name))) {
      importFiles(event, event.dataTransfer.files);
    }
  }, true);
})();
