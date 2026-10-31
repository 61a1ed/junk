# PDF.js viewer 6.4.299

These files come from Mozilla's official generic PDF.js distribution:

- Release: https://github.com/mozilla/pdf.js/releases/tag/v6.4.299
- Archive: https://github.com/mozilla/pdf.js/releases/download/v6.4.299/pdfjs-6.4.299-dist.zip
- Archive SHA-256: `f2245eb7ef3f674c872fe568a177bfec15874f5c034613e55d8e307f93ebd86d`
- Build: `d0991a0d5`
- License: Apache-2.0; see `LICENSE` and individual file notices.

Included: the official viewer HTML, JavaScript, CSS, images, all translations,
and its matching `build/pdf.mjs`. The release core and viewer share an internal
event identifier that differs from the npm distribution's build, so they must
stay together even when both have the same version number.

The only upstream file change is one script tag in `web/viewer.html`, loading
`/reader.js` before the viewer modules. That adapter supplies in-memory preferences
and document state and connects the reader to the workbench. The viewer's toolbar,
page rendering, text selection, search, links, annotations, and printing remain
the upstream implementation.

The development server maps the viewer's relative worker, sandbox, CMap, font,
ICC, and WASM URLs to the pinned `pdfjs-dist` npm dependency. Source maps, the demo
PDF, and the optional debugging UI are omitted. No viewer assets are downloaded
at runtime from a third-party CDN.

When updating PDF.js, update the pinned npm version and these release files
together, retaining the HTML adapter tag and verifying the viewer smoke tests.
