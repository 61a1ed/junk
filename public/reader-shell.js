// The stock PDF.js viewer owns reading. Moving the workbench into a dialog
// leaves the iframe, document, text selection, search, and scroll position intact.
export function createReader({ getBytes, onShowWorkbench, onFiles }) {
  const $ = selector => document.querySelector(selector);
  const surface = $('#pdf-reader');
  const overlay = $('#workbench-overlay');
  const workbench = $('#workbench');
  let active = false, documentId = null, generation = 0;
  let readyFrame = null, closingFrame = null, closingPromise;
  const frame = () => $('#pdf-reader-frame');
  const bridge = () => frame()?.contentWindow?.PDFWorkbenchReader;

  function focusReader() {
    if (!active || overlay.open) return;
    frame()?.focus();
    frame()?.contentWindow?.focus();
  }
  function hideWorkbench() {
    overlay.close();
    focusReader();
  }
  async function showWorkbench() {
    if (!active || overlay.open) return;
    overlay.showModal();
    if (documentId) await onShowWorkbench(documentId, bridge()?.pageNumber || 1);
  }
  function closeFrame(target) {
    if (target && target === closingFrame) return closingPromise;
    // An opening reader is behind the modal workbench and cannot contain edits.
    if (!target || target !== readyFrame) return Promise.resolve();
    closingFrame = target;
    closingPromise = target.contentWindow.PDFWorkbenchReader.close().then(() => {
      if (readyFrame === target) readyFrame = null;
    }).finally(() => {
      if (closingFrame === target) { closingFrame = null; closingPromise = null; }
    });
    return closingPromise;
  }
  function finishExit() {
    active = false;
    documentId = null;
    overlay.close();
    $('#workbench-home').append(workbench);
    document.body.classList.remove('reader-active');
    surface.hidden = true;
    surface.setAttribute('aria-busy', 'false');
    $('#hide-workbench').disabled = false;
    frame()?.remove();
    workbench.querySelector('[data-action="open-reader"]')?.focus({ preventScroll: true });
  }
  async function exit() {
    const request = ++generation;
    // Stock PDF.js saves modified annotations on close. Keep its context alive
    // until that download completes, including when switching documents.
    await closeFrame(frame());
    if (request === generation) finishExit();
  }
  async function open(sourceDocument, pageNumber = 1) {
    if (active && documentId === sourceDocument.document_id && readyFrame === frame() && !closingFrame && bridge()) {
      bridge().pageNumber = pageNumber;
      hideWorkbench();
      return;
    }
    const request = ++generation;
    await closeFrame(frame());
    if (request !== generation) return;
    documentId = null;
    if (!active) {
      active = true;
      surface.hidden = false;
      document.body.classList.add('reader-active');
      overlay.append(workbench);
      overlay.showModal();
    }
    const oldFrame = frame();
    const next = window.document.createElement('iframe');
    next.id = 'pdf-reader-frame';
    next.title = 'Document reader';
    next.allow = 'fullscreen';
    if (oldFrame) oldFrame.replaceWith(next);
    else surface.prepend(next);
    $('#hide-workbench').disabled = true;
    surface.setAttribute('aria-busy', 'true');
    try {
      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The PDF reader took too long to load. Please try again.')), 20000);
        next.addEventListener('load', async () => {
          try {
            const api = next.contentWindow.PDFWorkbenchReader;
            if (!api) throw new Error('Unable to load the PDF reader.');
            await api.ready;
            resolve(api);
          } catch (error) { reject(error); }
          finally { clearTimeout(timer); }
        }, { once: true });
        next.src = '/pdfjs/web/viewer.html?file=';
      });
      const [api, data] = await Promise.all([ready, getBytes(sourceDocument.document_id)]);
      if (request !== generation) return;
      await api.open({ data, filename: sourceDocument.filename, pageNumber });
      if (request !== generation) return;
      documentId = sourceDocument.document_id;
      readyFrame = next;
      hideWorkbench();
    } catch (error) {
      if (request !== generation) return;
      finishExit();
      throw error;
    } finally {
      if (request === generation) {
        $('#hide-workbench').disabled = false;
        surface.setAttribute('aria-busy', 'false');
      }
    }
  }
  $('#show-workbench').addEventListener('click', () => {
    void showWorkbench().catch(error => {
      // Let the application display failures through its existing notice flow.
      window.document.dispatchEvent(new CustomEvent('reader-error', { detail: error }));
    });
  });
  $('#hide-workbench').addEventListener('click', hideWorkbench);
  $('#exit-reader').addEventListener('click', () => {
    void exit().catch(error => window.document.dispatchEvent(new CustomEvent('reader-error', { detail: error })));
  });
  overlay.addEventListener('cancel', event => {
    event.preventDefault();
    if (!$('#hide-workbench').disabled) hideWorkbench();
  });
  overlay.addEventListener('close', focusReader);
  window.document.addEventListener('pdf-workbench-reader-files', event => {
    if (!active || event.detail.source !== frame()?.contentWindow) return;
    if (!overlay.open) overlay.showModal();
    void onFiles(event.detail.files);
  });
  return { open, exit, get active() { return active; }, get documentId() { return documentId; } };
}
