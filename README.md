# PDF range index and debugging workbench

A small local frontend for inspecting the application's real SQLite PDF store. Upload PDFs, preview pages, record cold-render chunk dependencies, replay a page using only its manifest, and inspect the database with SQL.

## Run

Requires **Node.js 24.19 or later** (the SQL console uses Node's SQLite serialization and authorizer APIs).

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:3000**. The server binds to loopback by default. Set `PORT` to use another port. `HOST` can be set for a trusted development environment; the tool has no login and is intended for local use.

No build step, external CDN, or additional frontend dependencies are needed. PDF.js and its assets are served from the installed package.

## Debug a PDF

1. Upload one or more PDFs, or choose **Load sample PDF** to use the existing three-page range-index test fixture. Set the chunk size before uploading. Duplicate bytes reuse the existing document; changing that document's chunk size requires deleting it first.
2. Select a document and page. The browser preview renders the original PDF; it is separate from the Node ingestion profile.
3. Choose **Trace page** or **Trace all pages**. Each trace runs the library's `indexPage` with a fresh PDF.js loading task. The chunk map reports observed cold-render reads, including bootstrap dependencies.
4. Choose **Verify replay**. The library's `verifyPage` renders using only the recorded dependency chunks, without fallback reads, and compares the resulting pixel hash. A different render profile may need different bytes; these manifests are observations, not universal PDF dependencies.
5. Open **Page manifests** to inspect completed traces and compute the deduplicated union of byte ranges for selected pages. The range form accepts `1, 3` or `1-3`; ranges are half-open `[start, end)`.
6. Use **SQL console** for read-only queries, query presets, and CSV export. **Database schema** shows the live schema and row counts. **Activity log** records operations in the current browser tab.

## Session behavior and limits

- The server calls `openDatabase(':memory:')`. All tabs connected to that process share a database. Refreshing the browser preserves uploads; **Reset session** or restarting the server clears them. Nothing is persisted to a database file.
- Original source bytes live in `document_chunks`. The existing five-table schema is preserved; the frontend server adds `upload_metadata` for the filename and page count.
- Uploads are validated with PDF.js before insertion. Maximum source size is 25 MiB per PDF and 100 MiB per server session. Encrypted PDFs are rejected. Individual render failures are reported without publishing incomplete manifests.
- A trace retains the existing 60-second timeout and 20-million-pixel canvas limit. Multi-page tracing is sequential and reports each page's result.
- SQL runs on an in-memory snapshot in a disposable child process. SQLite's authorizer allows read-only queries; the server kills the child after two seconds. Results are capped at 500 rows and approximately 2 MiB, with long cells truncated and BLOBs summarized. Queries cannot change the live database. Submit one SQL statement at a time; additional statements are rejected.
- Replay verification badges and activity logs belong to the browser tab. Reloading clears those UI records; stored manifests remain until deletion/reset/restart.
- This workbench does not perform OCR, text extraction, or document editing.

## Checks

```sh
npm test
```

The suite covers the original indexing library plus real HTTP upload, duplicate detection, source reconstruction, tracing, range unions, replay, deletion, SQL read-only enforcement, query timeouts, and request validation. HTTP tests bind only to loopback on ephemeral ports.

The optional `test/browser-smoke.mjs` exercises the actual UI using Playwright and Chromium when those tools are available; neither is a runtime dependency.

The existing CLI also remains available:

```sh
node index.mjs add example.sqlite document.pdf
node index.mjs index example.sqlite DOCUMENT_SHA256 1
node index.mjs ranges example.sqlite DOCUMENT_SHA256 1
node index.mjs verify example.sqlite DOCUMENT_SHA256 1
```
