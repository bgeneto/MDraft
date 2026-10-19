# Typst Pages are the compiler's PDF through PDF.js

**Status:** accepted
**Date:** 2026-10-18

## Context

The Typst preview has two views. Document is Typst's experimental HTML export:
flowing, selectable text with no page layout, and the source of the HTML that
MDraft hands to pandoc for DOCX/ODT/EPUB. Pages was `typst compile --format svg`:
faithful pagination, but every glyph is an outline. A two-column paper could be
read only as a picture: no selection, copy, search, or click-to-source.

The alternative considered was `typst.ts`'s DOM renderer. It is a page renderer
fed by a typst.ts vector artifact, so it would require a second Typst compiler
pipeline: 30.16 MB of compiler WASM (8.33 MB Brotli), 1.28 MB of renderer WASM
(0.40 MB Brotli), 8.31 MB of default fonts (4.86 MB Brotli), plus a filesystem
access model and a package registry. That is about 13.7 MB compressed and two
compilers that can disagree about fonts, packages and versions. Its DOM text
layer also does not carry source positions; the reference click sync in
`typst-preview` sends page coordinates to a compiler backend, not to typst.ts.

PDF.js draws the compiler's PDF and builds a text layer over it. The PDF is the
same layout the SVG pages showed, produced by the same CLI, and the text layer
supplies selection and hit-testing. The measured PDF.js payload is about 0.45 MB
compressed.

## Decision

Typst Pages is a single PDF compiled by the existing `typst` CLI and rendered by
PDF.js in the webview. The semantic HTML export remains the Document view and the
pandoc input. There is no second compiler.

The page is laid out at a fixed 96 dpi width (A4: 794 px), fitted to the pane by
a CSS transform, and the canvas is rendered lazily near the viewport. PDF.js's
exported `TextLayer` supplies selection, copy and the pointer hit-test. A
double-click or selection maps the selected word to the source with a bounded
nearest-occurrence search; generated text that cannot be found paints nothing.
Single click keeps the existing block/caret behaviour.

Typst Document gains the same block-record word map AsciiDoc uses:
`annotateTypstLines` returns source ranges, binds them to the existing word map,
and leaves generated text unmapped. This narrows the Typst exclusion in
`2026-10-18-word-level-sync.md`; it does not add compiler source spans or exact
word-level sync.

## Consequences

- `render_typst` returns `pdf` instead of `pages`; the command signature is
  otherwise unchanged.
- The Pages view depends on PDF.js (Apache-2.0) and its worker. The worker must
  load from the packaged application, not from a network URL.
- A long document can allocate a canvas per page. Rendering is lazy and the
  device-pixel ratio is capped; a bounded cache is the next step if memory still
  grows.
- The text layer is only as good as PDF.js's extraction. Selection under the fit
  transform must be tested; the fallback is to re-lay out the text layer at the
  fitted width.
- Word sync is heuristic for Typst. A missing mark is acceptable; a mark on the
  wrong word is not. Exact compiler-span sync remains a separate project.
- The semantic HTML export and all pandoc/PDF export paths are untouched.
