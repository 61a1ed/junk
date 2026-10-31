# PDF.js distribution and storage integration

The stock viewer is Mozilla's official generic PDF.js distribution, licensed
under Apache-2.0. Its version, release archive URL, and SHA-256 are pinned in
[`pdfjs-release.json`](../pdfjs-release.json). No upstream viewer files are
committed to this repository.

`npm ci` runs `scripts/setup-viewer.mjs` through the `postinstall` hook. Setup
downloads the archive, verifies its checksum before extraction, and installs it
in ignored `.cache/pdfjs/`, including its upstream LICENSE and file notices.
It adds one script tag to `web/viewer.html`, before the viewer modules, to load
our `/reader.js` adapter. All other upstream files remain unchanged.

The server serves the complete viewer and browser rendering core (including the
inline preview and tracer) from that release. Standalone SQL page cells use
`pdf_viewer.mjs` and `pdf_viewer.css` from the matching, lockfile-pinned
`pdfjs-dist` npm package; the generic release does not provide this component
entry point. The cell renderer scopes the component CSS to its own cells so
upstream sidebar and dialog selectors do not style the workbench. Cells use the
same release core and worker as the rest of the app.
The npm package also supplies the Node CLI renderer. No browser assets are
fetched from a third-party CDN at runtime.

Run `npm run setup:viewer` to restore the generated assets. For offline setup,
set `PDFJS_ARCHIVE` to a previously downloaded release ZIP; the same checksum
check applies. Node's environment proxy support is enabled for the downloader.
When deploying, include `.cache/pdfjs/` or run setup on the destination; copying
only `public/` is insufficient. If npm lifecycle scripts are disabled, run setup
explicitly after installing dependencies.

## Reading from custom storage

`reader-shell.js` passes document length, chunk size, filename, and an async
`readRange(begin, end)` callback into the viewer iframe. `reader-transport.js`
creates `PDFDataRangeTransport` with the iframe's own PDF.js instance and supplies
it to `PDFViewerApplication.open`. The callback currently uses the browser-local
SQLite worker's `read-range` operation; another storage implementation can supply
the same callback without changing the stock viewer.

Only an initial chunk is read before opening. Further ranges are requested on
demand, with streaming and automatic prefetch disabled. Storage failures and
timeouts stop the loading task and surface an error; closing the reader ignores
late responses. Search, printing, and download can request additional ranges or
the entire document. Page manifests are not enforced by the reader: cold tracing
and constrained replay remain separate operations.

The adapter also keeps preferences and history in iframe memory, routes file
imports through the workbench, and synchronizes page selection. It uses the
generic viewer application's lifecycle and therefore needs browser validation
when upgrading PDF.js. Annotation edits are exported through the viewer;
original SQLite bytes remain unchanged.

## Upgrades

Update the version, archive URL and SHA-256 in `pdfjs-release.json` and the pinned
`pdfjs-dist` npm version together. Run `npm install`, `npm test`, and the browser
smoke test. Check that the HTML injection still matches and that range loading,
search, download, storage errors, and the workbench overlay work with the new
viewer. The setup script fails rather than silently accepting another archive
or an unexpected HTML entry point.
