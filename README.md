# PDF Workbench

A browser-only debugging frontend for the PDF range database. **SQLite runs as WebAssembly (`sql.js`) in a Web Worker. Uploaded PDF bytes, document metadata, and page manifests stay in that browser tab's memory.** There is no server database, PDF upload endpoint, or SQL endpoint.

## Run

With Node.js 24 or later:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:3000** in a current Chromium, Firefox, or Safari browser. Node serves the static HTML, JavaScript, WASM, PDF.js assets, and sample PDF only. It does not open SQLite or receive your PDF files or queries. No Node SQLite serialization APIs are required by the frontend.

Set `PORT` for another port. The default host is loopback; browser workers and Web Crypto work on localhost. If serving this frontend remotely, use HTTPS. No build step or third-party CDN is needed.

## Debug a PDF

1. Select PDFs, drag them into the page, or choose **Load sample PDF** to try the three-page range-index fixture. Set the chunk size before importing. Duplicate bytes reuse the existing document; changing its chunk size requires deleting it first.
2. Select a document and page. **Download** reconstructs the original PDF from its SQLite chunks in the browser.
3. Choose **Trace page** or **Trace all pages**. Each page uses a fresh PDF.js loading task with byte ranges read from SQLite WASM. Completed traces publish a manifest and display the chunks actually observed, including bootstrap dependencies.
4. Choose **Verify replay**. A fresh browser renderer is allowed to read only the recorded chunks and must produce the same pixel hash. Browser manifests use a distinct rendering profile from the optional Node CLI; they are observations for that profile, not universal PDF dependencies.
5. Open **Page manifests** to inspect traces and combine the deduplicated ranges for selected pages. Enter `1, 3` or `1-3`; ranges are half-open `[start, end)`.
6. Use **SQL console** for read-only SQL, query presets, and CSV export. **Database schema** shows live tables and row counts. **Activity log** records operations in this tab.

## Memory and query behavior

- Every tab owns a separate in-memory SQLite WASM database. **Reload, close the tab, or choose Reset session to discard its PDFs and database.** Nothing is stored in IndexedDB, localStorage, OPFS, or a server database file.
- Original bytes live in `document_chunks`; the existing schema is reused with an additional `upload_metadata` table for filenames and page counts.
- PDF.js validates files before insertion. Limits are 25 MiB per PDF and 100 MiB of source bytes per tab. Encrypted PDFs are rejected. Render failures do not publish incomplete manifests.
- Each cold trace has a 60-second timeout and a 20-million-pixel canvas limit. Multi-page traces run sequentially.
- SQL runs in a separate disposable browser worker on a snapshot of the current database. Only a single read query is accepted, and SQLite's `query_only` setting blocks writes. The worker is terminated after two seconds; the live database and UI remain available.
- Results are capped at 500 rows and approximately 2 MiB. Long cells are truncated and BLOBs are summarized. Queries cannot change the live database. CSV export contains the displayed results.
- The workbench does not perform OCR, text extraction, or document editing.

## Validation

```sh
npm test
```

This checks the existing PDF indexing library (including Windows asset path handling) and verifies that the development server serves frontend assets while rejecting all database API operations.

The optional browser smoke test exercises the real SQLite WASM UI, tracing, replay, SQL, isolation between tabs, and clearing on reload. With Playwright and Chromium available:

```sh
node test/browser-smoke.mjs
```

Alternatively set `PLAYWRIGHT_MODULE` to an installed Playwright module and `CHROMIUM_PATH` to a Chromium executable. Neither is a runtime dependency.

## Existing Node CLI

The repository's original Node SQLite library and CLI remain available for separate file-backed indexing workflows. They are **not imported or used by the frontend or its development server**:

```sh
node index.mjs add example.sqlite document.pdf
node index.mjs index example.sqlite DOCUMENT_SHA256 1
node index.mjs ranges example.sqlite DOCUMENT_SHA256 1
node index.mjs verify example.sqlite DOCUMENT_SHA256 1
```
