// Use the viewer's own PDF.js constructor: getDocument checks instanceof, so a
// transport created with another build or in the parent window is not accepted.
export async function createRangeSource(pdfjs, {
  byteLength, chunkSize, filename, readRange, onError = () => {}, timeoutMs = 30_000,
}) {
  const failure = Promise.withResolvers();
  failure.promise.catch(() => {});
  const timers = new Set();
  let stopped = false;
  function abort(reason = new Error('Reader storage request cancelled')) {
    if (stopped) return;
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    failure.reject(reason);
  }
  function fail(error) {
    if (stopped) return;
    abort(error);
    onError(error);
  }
  async function read(begin, end) {
    if (stopped) throw new Error('Reader storage request cancelled');
    let timer;
    try {
      const bytes = await Promise.race([
        Promise.resolve().then(() => readRange(begin, end)),
        failure.promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Reader storage request timed out')), timeoutMs);
          timers.add(timer);
        }),
      ]);
      // Copy into the viewer's realm and never transfer the storage owner's data.
      const copy = Uint8Array.from(bytes);
      if (copy.length !== end - begin) throw new Error(`Incomplete PDF byte range [${begin}, ${end})`);
      return copy;
    } catch (error) {
      fail(error);
      throw error;
    } finally {
      clearTimeout(timer);
      timers.delete(timer);
    }
  }
  const prefix = await read(0, Math.min(chunkSize, byteLength));
  const transport = new pdfjs.PDFDataRangeTransport(byteLength, prefix, true, filename);
  transport.requestDataRange = (begin, end) => {
    // PDF.js installs its listener after making the request; answer async.
    void read(begin, end).then(bytes => {
      if (!stopped) transport.onDataRange(begin, bytes);
    }).catch(fail);
  };
  transport.abort = () => abort();
  return { transport, failure: failure.promise, abort };
}
