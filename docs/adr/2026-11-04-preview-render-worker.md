# The pure preview pipeline runs in a module worker; the main thread owns sanitising and the DOM

**Status:** accepted
**Date:** 2026-11-04

## Context

A full preview render blocked typing. Measured on Debian with WebKitGTK 2.54 and
a 1.2 MB Markdown document: `renderPreview` took 656 ms, `preview.innerHTML`
26 ms, `bindPreviewWords`/`scrollTextAnchors` 118 ms, and `doRender` about 1.03 s.
A key pressed while that render ran waited 932 ms before the editor received it.
A 223 KB file already cost about 160 ms per render. The pipeline is a single
synchronous function call, so no debounce can hide it: the first key after a
quiet period waits for the whole task.

DOMPurify needs a DOM, and the decoration passes (`decorateLinks`,
`decorateAlerts`, heading ids, the table of contents) need the live host. The
expensive steps do not: marked, the math/code masking, KaTeX's
`renderToString`, highlight.js and the fragment table are pure string work.

## Decision

The pure part of the preview pipeline runs in module Web Workers. Markdown
(`src/preview-worker.ts`) and AsciiDoc (`src/asciidoc-worker.ts`) have separate
entries so a Markdown session never downloads or parses Asciidoctor; each has
its own single-flight queue. A worker returns the marked or Asciidoctor HTML
chunks, the fragment table, the pre-rendered KaTeX HTML (Markdown), the include
map results and the block line list. The main thread applies DOMPurify to the
HTML and inserts the math afterwards, which is the same trust boundary
`restorePlaceholders` already uses: only generated markup is inserted after
sanitising. highlight.js stays on the main thread inside the 64 KB insert batch;
a document has few fences and moving it would duplicate the library in the
worker for no measured gain.

The synchronous `renderPreview` stays in the tree. It is the export/print path,
where an explicit action may block, and it is the fallback when a worker cannot
start (no module-worker support, a CSP rejection, a worker error). A worker
failure must fall back to that path, never to an empty preview.

The word map is built after the DOM is painted, in a `requestIdleCallback`,
only in Split view. It cannot move into the worker because it binds to live DOM
text nodes; building it late keeps it from sitting between a keystroke and a
frame. AsciiDoc includes are pre-read on the main thread because the worker
cannot call the Tauri command; a document whose include path is built from an
attribute falls back to the main-thread conversion.

## Consequences

- The main thread stays free while a preview renders; the preview may lag the
  buffer by the worker's render time, but typing does not.
- DOMPurify and all DOM decoration remain main-thread code. Any new preview
  feature must decide which side of the boundary it belongs to, and the pure
  side must not import a DOM module.
- The worker output is not trusted input: the sanitizer gauntlet runs on it, and
  the math/code HTML is inserted only after sanitising.
- There are two render paths to keep in step. A golden test compares the worker
  result with the synchronous result on the fixtures; a divergence is a bug.
- A failed worker is a performance regression, not a functional one.
