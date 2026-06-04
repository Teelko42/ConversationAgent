# `public/vendor/` — vendored, no-build-step browser libraries

Files here are served as static assets under `/vendor/…` and loaded by the client
directly (no bundler). Keeping third-party libraries vendored (not pulled from a
CDN) matches Aizen's offline-safe, no-external-CDN posture (the app already
self-hosts its own JS/CSS).

## PDF text extraction (F3 — local files)

`client.js` extracts text from added **PDF** files with Mozilla's **pdf.js**. It is
loaded lazily — only when a user actually adds a PDF — via:

```js
import('/vendor/pdf.mjs')           // the pdf.js ES module (sets GlobalWorkerOptions.workerSrc)
// worker: '/vendor/pdf.worker.mjs'
```

This repo intentionally does **not** commit the (multi-MB, minified) pdf.js build.
Until you drop it in, adding a PDF shows a clear, skippable per-file message
("PDF support needs the vendored pdf.js …") and every other file still works — the
"never block the others" rule (F3 §8).

### To enable PDF support

1. Get the `pdfjs-dist` legacy/ESM build (matching your target browsers), e.g.:
   ```
   npm pack pdfjs-dist            # or download a release from github.com/mozilla/pdf.js
   ```
2. Copy the two ES-module files here, named exactly:
   - `pdf.mjs`         (the main library, exports `getDocument`, `GlobalWorkerOptions`)
   - `pdf.worker.mjs`  (the worker)
   (In recent `pdfjs-dist` these are `build/pdf.mjs` and `build/pdf.worker.mjs`.)
3. Reload — PDFs now extract client-side, in the browser, with no build step.

No code change is needed: `loadPdfLib()` in `client.js` already points at these
paths and wires the worker. The extracted text becomes an `origin:'file'` doc in the
S0 source library exactly like a `.md`/`.txt` file.

> `.docx`/`.pptx`/image-OCR remain out of scope for this pass (F3 §11) — `mammoth.js`
> / an OCR lib are the documented later adds, vendored the same way.
