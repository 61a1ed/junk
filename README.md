# PDF Workbench

A browser-only debugging frontend for the PDF range database. **SQLite runs as WebAssembly (`sql.js`) in a Web Worker. Uploaded PDF bytes, document metadata, and page manifests stay in that browser tab's memory.** There is no server database, PDF upload endpoint, or SQL endpoint.

## Run

With Node.js 24.5 or later:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:3000** in a current Chromium, Firefox, or Safari browser. Node serves the static HTML, JavaScript, WASM, PDF.js assets, and sample PDF only. It does not open SQLite or receive your PDF files or queries. No Node SQLite serialization APIs are required by the frontend.

`npm ci` also downloads the pinned official PDF.js viewer, verifies its SHA-256, and installs it in ignored `.cache/pdfjs/`. No PDF.js distribution files are committed. Run `npm run setup:viewer` to restore those assets separately; see [setup and offline options](docs/pdfjs.md).

Set `PORT` for another port. The default host is loopback; browser workers and Web Crypto work on localhost. If serving this frontend remotely, use HTTPS. No bundler or runtime third-party CDN is needed.

## Debug a PDF

1. Select PDFs, drag them into the page, or choose **Load sample PDF** to try the three-page range-index fixture. Set the chunk size before importing. Duplicate bytes reuse the existing document; changing its chunk size requires deleting it first.
2. Select a document and page, then choose **Open reader**. The full PDF.js viewer fills the window, with continuous pages, selectable text, search, thumbnails, links, zoom, rotation, printing, and download. Choose **Workbench** to open the app over the document; **Return to document** or Escape closes the overlay without losing your page, zoom, or scroll position. **Exit reader** returns to the normal workbench. The inline preview keeps a fixed size for tracing and still offers fit/100–200% zoom.
3. Choose **Trace page** or **Trace all pages**. Each page uses a fresh PDF.js loading task with byte ranges read from SQLite WASM. Completed traces publish a manifest and display the chunks actually observed, including bootstrap dependencies.
4. Choose **Verify replay**. A fresh browser renderer is allowed to read only the recorded chunks and must produce the same pixel hash. Browser manifests use a distinct rendering profile from the optional Node CLI; they are observations for that profile, not universal PDF dependencies.
5. Open **Page manifests** to inspect traces and combine the deduplicated ranges for selected pages. Enter `1, 3` or `1-3`; ranges are half-open `[start, end)`.
6. Use **SQL console** for read-only SQL, query presets, and CSV export. Expand **Database schema** in the console for live tables, columns, constraints, and row counts while writing queries. **Activity log** records operations in this tab.

## PDF pages in SQL results

Choose **Page grid (traced pages)** in the SQL presets to display selectable PDF
pages inside the results table. Any column whose name starts with `pdf`
(case-insensitive) is treated as a page-address column. Other columns stay text,
even if they contain an address. Use multiple PDF columns for side-by-side pages,
or SQL ordering/filtering to choose an arbitrary collection across documents.

The address format is `pdf:v1:<document-id>:<profile-id>:<page-number>`. Both IDs
are lowercase 64-character SHA-256 hashes; the page number is a positive,
1-based decimal integer. `page_manifests.ref` is a virtual generated column
containing this address. Alias it to a name starting with `pdf` to render it:

```sql
SELECT u.filename, m.page_number, m.ref AS pdf_page
FROM page_manifests m
JOIN upload_metadata u USING (document_id)
ORDER BY u.filename, m.page_number;
```

The exact document/profile/page must already have a completed trace. Invalid
addresses remain visible with an explanation; missing documents or traces show
a per-cell error. NULL stays NULL. Rendering never creates a trace. CSV export
always contains the original SQL values, including encoded addresses.

Choose a **Page width** of 240, 320 (default), 480, 640, or 800 CSS pixels in the
results toolbar. Each cell renders a selectable `PDFPageView` at that width;
its height follows the page's aspect ratio, with no fixed or maximum height.
Results grow with their rows, with horizontal scrolling when needed. Cells do
not repeat filenames, page numbers, or addresses; include those as ordinary SQL
columns if useful.

**Enlarge** opens the same page in a near-fullscreen modal with selectable text,
sharing the grid's PDF.js document. Escape or **Close preview** returns to the
table. **Open full reader** in that modal opens the whole original document at
the selected page. Annotations and editing remain in the official reader. Cells render
only when visible, with at most two page renders in progress, and share one
PDF.js document per source PDF while its cells are active. Leaving the viewport,
replacing results, deleting a document, or resetting releases cell resources.

The table has a generic cell-decoration hook in `sql-results.js`; page-address
parsing lives in `pdf-address.js`, and the renderer in `pdf-page-cells.js` accepts
storage and navigation callbacks. The table itself has no PDF.js or database
dependency. Rendering reads source ranges through the existing storage adapter;
the trace is an eligibility check, not a restriction on text-layer reads. Strict
manifest-only verification remains a separate operation. This adds no remote
storage or prefetch policy.

## Named page regions

Enlarge a traced page in the SQL results, choose **Select region**, and drag a
rectangle on the page. Enter a name and choose **Save region**. Exit selection
to select text normally. Saved regions appear as outlines and named buttons;
choose one to preview its crop, or **Delete** to remove it. **Show source page**
returns from a crop to the full page and its region controls.

The **Saved regions** SQL preset renders cropped previews. Like full-page
references, a region reference must be in a column whose name begins with `pdf`:

```sql
SELECT name, bounds, ref AS pdf_region
FROM page_regions
ORDER BY id;
```

`page_regions.bounds` is a JSON array `[xmin, ymin, xmax, ymax]` in native PDF
page coordinates, including nonzero/negative origins. The same array is used
by the selection UI, database messages, and renderer. Display rotation, zoom,
and screen pixel density do not change the saved coordinates. Region references
have the generated form `pdf:region:v1:<id>` and refer to this database session.
Crops render to a canvas sized only for the selected area, with a translated
PDF.js viewport and a matching clipped, selectable text layer. PDF.js still
processes the page's drawing instructions and reads source PDF ranges.

`page_manifests.id` is an autoincrement primary key; document/profile/page remains
unique. Dependencies use `(page_manifest_id, chunk_number)`, and regions refer
to the same manifest ID. Retracing replaces the manifest and deletes its regions.
Deleting the source document or resetting the session also deletes its regions.
Reloading clears all browser data. This proof of concept uses fresh databases;
there are no schema migrations for existing Node database files.

## Memory and query behavior

- Every tab owns a separate in-memory SQLite WASM database. **Reload, close the tab, or choose Reset session to discard its PDFs and database.** Nothing is stored in IndexedDB, localStorage, OPFS, or a server database file.
- Original bytes live in `document_chunks`; the existing schema is reused with an additional `upload_metadata` table for filenames and page counts.
- PDF.js validates files before insertion. Limits are 25 MiB per PDF and 100 MiB of source bytes per tab. Encrypted PDFs are rejected. Render failures do not publish incomplete manifests.
- Each cold trace has a 60-second timeout and a 20-million-pixel canvas limit. Multi-page traces run sequentially.
- SQL runs in a separate disposable browser worker on a snapshot of the current database. Only a single read query is accepted, and SQLite's `query_only` setting blocks writes. The worker is terminated after two seconds; the live database and UI remain available.
- Results are capped at 500 rows and approximately 2 MiB. Long cells are truncated and BLOBs are summarized. Queries cannot change the live database. CSV export contains the displayed results.
- The reader uses the official PDF.js 6.4.299 viewer and matching assets from one verified release. It reads SQLite byte ranges through a custom `PDFDataRangeTransport`, without first assembling the full PDF. Search, printing, and download may require more or all bytes. Its preferences, view history, and saved signatures remain in iframe memory and disappear when you exit the reader. See [distribution, license, and storage details](docs/pdfjs.md).
- PDF.js supports selecting/searching existing text and its standard annotation tools. Use its download control to save reader edits; tracing and replay always use the original bytes imported into SQLite. The workbench does not perform OCR.

## Validation

```sh
npm test
```

This checks the PDF indexing library (including Windows asset path handling), reader transport failures and cancellation, archive checksum rejection, and asset serving while rejecting all database API operations.

The optional browser smoke test exercises the real SQLite WASM UI, tracing, replay, SQL, sparse range reads in the stock viewer, reader download and storage failure recovery, its workbench overlay, isolation between tabs, and clearing on reload. With Playwright and Chromium available:

```sh
node test/browser-smoke.mjs
node test/browser-page-grid.mjs
node test/browser-regions.mjs
node test/browser-page-grid.mjs
```

The page-grid test covers selectable cells, shared documents, reader navigation,
raw CSV values, malformed and untraced addresses, mixed sources, lazy rendering,
and cancellation when results are replaced or the session is reset.

Alternatively set `PLAYWRIGHT_MODULE` to an installed Playwright module and `CHROMIUM_PATH` to a Chromium executable. Neither is a runtime dependency.

## Existing Node CLI

The repository's original Node SQLite library and CLI remain available for separate file-backed indexing workflows. They are **not imported or used by the frontend or its development server**:

```sh
node index.mjs add example.sqlite document.pdf
node index.mjs index example.sqlite DOCUMENT_SHA256 1
node index.mjs ranges example.sqlite DOCUMENT_SHA256 1
node index.mjs verify example.sqlite DOCUMENT_SHA256 1
```
