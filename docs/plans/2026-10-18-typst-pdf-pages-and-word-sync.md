# Typst Pages through PDF.js, and block-record word sync for Typst

**Status:** done
**Date:** 2026-10-18
**ADR:** `../adr/2026-10-18-typst-pdf-pages.md` (new; written in step 1)

## Context and goal

A Typst document has two previews. **Document** is Typst's HTML export: flowing,
selectable text in the application's typography, but no page layout. **Pages** is
the compiler's own SVG output: faithful page layout, but every glyph is an
outline, so the text cannot be selected, copied, searched, or clicked. A
two-column paper therefore looks right only in Pages, and in Pages it is a
picture. This is the mismatch the reader sees.

The previous investigation rejected `typst.ts`'s DOM renderer for Document. It
would add a second Typst compiler pipeline (about 13.7 MB compressed including
fonts) and still would not expose source spans; its click sync in the reference
implementation is a compiler-backend feature. The decision here is narrower:

- **Pages** should be the compiler's PDF drawn by PDF.js, with PDF.js's text
  layer over it. That gives the real two-column page, selectable/copyable text,
  and a DOM to hit-test, for about 0.45 MB compressed and without a second
  compiler. The existing CLI remains the single source of layout truth.
- **Document** should keep its semantic HTML. Clicking a block already reveals
  the source line. Double-clicking or selecting prose there should paint the
  corresponding source word, using the same block-record heuristic AsciiDoc
  already uses; generated text that cannot be found must paint nothing rather
  than a wrong word.
- **Pages** should map a double-clicked word (or a selected word) to the source
  by the same bounded search, with the whole source as the bound and the caret
  as the proximity hint.

The goal is not "make Document look like Pages". It is: make the exact page
usable, and make the flow view's word-level sync honest about what it can map.

## Scope and non-scope

In scope:

- Compile the Pages view to a single PDF in `src-tauri/src/typst.rs`, return it
  to the webview as base64, and render it with PDF.js.
- A canvas per page, a PDF.js `TextLayer` per page, page shells that keep the
  page's aspect ratio, fit-to-pane by CSS transform, and lazy canvas rendering
  for pages away from the viewport.
- Selection and copy from the text layer; the existing page stack, view bar,
  error box, and pending-scroll behaviour remain.
- Pages double-click/selection sync: determine the selected word, find it in the
  source, and paint it with the existing `editor.setSyncRange` decoration. No
  match means no mark.
- Document word-level sync for Typst: `annotateTypstLines` also returns block
  ranges and marks elements with `data-b`; `bindPreviewWords` binds them; the
  existing Markdown/AsciiDoc selection and double-click handlers become active
  for Typst. Document keeps the existing single-click block reveal; Pages gets
  the paragraph click described below.
- A package-free two-column fixture, a CDP suite covering both views, the
  `test-all` entry, the npm script, and the documentation/test-table updates.

Out of scope:

- `typst.ts`, a WASM compiler, or embedding the Typst compiler.
- Exact compiler-span word sync, or source positions for generated content
  (`#lorem`, `#let`, numbering, math). The block-record search is best-effort
  and documented as such.
- Two columns in Document. The HTML export still has no layout.
- A PDF.js viewer toolbar, search UI, annotations, links, outlines, zoom
  controls, page navigation, or PDF/A/encryption handling.
- Source → Pages highlighting. Document keeps both directions; Pages only maps
  preview → source.
- Changes to the semantic HTML export, pandoc export, PDF export, print, or the
  Typst CLI installation path.
- A preference for SVG versus PDF Pages. The change replaces the Pages renderer;
  rollback is a revert, not a setting.

## Approach and rejected alternatives

### Pages: PDF.js over the compiler's PDF

`render_pages` already runs the Typst CLI once. It will run
`typst compile --format pdf` instead of `--format svg`, read the one PDF, and
return it base64-encoded in `RenderedTypst.pdf`. The frontend decodes it, calls
PDF.js `getDocument({ data })`, and builds one page shell per page.

Each page is laid out at a fixed 96 dpi width (A4 becomes 794 px, the same cap
the SVG pages used), so the text layer has a stable coordinate system. The page
is fitted to the pane with a CSS transform on a wrapper; changing the pane width
changes only the transform, not the PDF layout or the text-layer geometry. The
canvas is rendered at the shell's device-pixel size (capped at 2×) when the page
is near the viewport; the text layer is built with the page. This keeps a long
document from allocating a full-resolution canvas per page while keeping text
selection available.

The text layer uses PDF.js's exported `TextLayer` class and the text-layer rules
from `pdf_viewer.css` (copied locally, with the source version noted), not the
whole PDF.js viewer. `--total-scale-factor` is set from the page's PDF points to
CSS pixels so the spans land on the canvas glyphs. The page shell gets
`aria-label="Page N"`; the canvas is `role="img"`.

Click sync on Pages:

- A double-click selects a word in the text layer; a drag selection is also
  mapped.
- The handler reads the whole visual line around the selection, groups the
  PDF.js text items on the same baseline (joining a line split into several
  spans), and matches that line's word sequence to the source. The matched
  occurrence identifies the clicked word or paragraph; it is not a search for
  the first/nearest occurrence of the selected word. A line that starts or ends
  in a hyphenated fragment still maps when a complete window inside it matches.
- A single click maps the source paragraph containing the clicked line. A
  double-click or drag maps the selected word/range. In both cases the handler
  calls `editor.setSyncRange` and `editor.revealOffset`; a generated line has no
  match and does nothing. It never moves the preview selection.
- The view bar is transparent; only its buttons are opaque, so the sticky bar
  does not blur the page underneath.

### Document: block records, not a second source map

`annotateTypstLines` already folds each top-level block and finds its source
line. It will also compute each block's source range from the line offsets (the
same technique `asciidoc-preview.ts` uses), set `data-b` on the element, and
return the `BlockRange[]` beside `mapped`. The Document render path passes those
ranges to `bindPreviewWords(source, undefined, ranges)`. `wordSyncAvailable`
then admits Typst when a map exists, so the existing selection, double-click,
source→preview painting and Escape handling work without a second implementation.

The fidelity limit is the same as AsciiDoc: prose and visible macro text are
found by a forward search inside the block; generated text, a `#let` value, a
numbering difference or math is not found. A block whose text cannot be found
paints nothing; the single-click block blink remains. No unmatched word is
guessed at.

### Rejected alternatives

- **`typst.ts` DOM renderer.** Measured at about 13.7 MB compressed with the
  default fonts and requires a second compiler pipeline; its DOM text layer has
  no source spans, and the reference click sync lives in a compiler backend.
  It also turns Document into Pages-with-text, which is not the requested split.
- **Keep SVG and overlay a PDF text layer.** This preserves the exact SVG
  artwork but needs two Typst compiles per render (SVG and PDF), doubles the IPC
  payload, and keeps the canvas/vs-vector question alive. PDF.js's canvas at
  device resolution is faithful enough, and one compile is simpler.
- **PDF.js full viewer.** The viewer bundle, toolbar, CSS and event model would
  add a second UI inside the preview and conflict with the application's type,
  scroll and theme. Only `getDocument`, `TextLayer` and page rendering are used.
- **Typst HTML plus CSS columns / Paged.js.** This was the previous
  investigation's conclusion: the HTML export has no page/column data, and the
  generic pagers re-lay out rather than reproduce Typst. It would be a different
  approximation, not the page.
- **Extract text from the SVG.** Typst's SVG output draws glyphs as paths; there
  is no text to select. Reconstructing text would be OCR, not an implementation.
- **Embed the compiler for exact word spans.** The existing word-level ADR
  estimates about +50 MB and a build-time cost; this plan deliberately stays
  with the CLI and a bounded heuristic. Exact sync is a separate project.
- **A preference to choose SVG/PDF.** It doubles the renderer and test matrix
  for a transition. The branch revert is the rollback.

## Steps

- [x] 1. Write `docs/adr/2026-10-18-typst-pdf-pages.md`: Pages use the CLI PDF
      through PDF.js; Document stays semantic; Typst word sync is a bounded
      block-record heuristic with a no-wrong-mark fallback. Reference the
      measurements from the investigation.
- [x] 2. Backend: change `RenderedTypst.pages: Vec<String>` to
      `pdf: Option<String>`; make `render_pages` compile `--format pdf`, read the
      file, base64-encode it with the already-declared `base64` crate, and update
      the comments. Keep the document-view fallback calling the same function.
- [x] 3. Contract: update `RenderedTypst` in `src/api.ts` and every `pages` use
      in `src/main.ts`. The command name and arguments stay
      `render_typst(path, source, mode)`; only the result shape changes.
- [x] 4. Add `pdfjs-dist` pinned to a tested version and its lockfile entry; add
      the lazy `import("pdfjs-dist")` and worker `?url` setup. Add the local
      text-layer CSS and the page-shell/canvas/transform rules to `styles.css`.
- [x] 5. Add `src/typst-pdf.ts`: `render(pdf: Uint8Array)` builds page shells,
      text layers and lazy canvases; `dispose()` cancels the PDF document and
      renders; `setFit()` updates the wrapper transform; it exposes an
      `onWord(text, hint)` callback. It must survive a render-token change and a
      view switch without leaking a worker or a document.
- [x] 6. Integrate Pages in `renderTypstPreview`: decode the base64, create the
      PDF view, attach the word callback, destroy the previous view, and remove
      the SVG object-URL bookkeeping. Keep the view bar, error box and pending
      scroll. Document path unchanged except for step 8.
- [x] 7. Pages click sync: group the text layer into visual lines, map the line's
      word sequence to the source occurrence (not a nearest-word search), and
      call `setSyncRange`/`revealOffset` from the click/double-click/selection
      handler. A single click maps the paragraph; a word gesture maps the word.
      Do not move the preview selection.
- [x] 8. Document word sync: extend `annotateTypstLines` to return
      `{ mapped, blocks: BlockRange[] }`, set `data-b`, and pass the ranges to
      `bindPreviewWords`; add Typst to `wordSyncAvailable` only when the map is
      present. Single click keeps the existing block reveal.
- [x] 9. Add `samples/typst-pages.typ`: package-free, A4, two columns, a title
      block that Document drops, prose containing a unique word (`pendulum`),
      a repeated word, generated `#lorem` text, a `#pagebreak()`, and a
      `#colbreak()` so both columns and two pages are exercised.
- [x] 10. Add `scripts/typst-preview-test.mjs` and the
      `typst-preview` entry in `scripts/test-all.mjs`; add
      `"typst:preview": "node scripts/typst-preview-test.mjs"` to
      `package.json`.
- [x] 11. Update `docs/guide.md` (Pages is PDF.js, selectable; Document and
      Pages word sync and their limits; the copy section no longer says Pages is
      an unselectable picture), `README.md` (the feature list already names the
      page view and word sync), `AGENTS.md` (scripts table, testing table, layer
      count), and the plan/ADR status.
- [x] 12. Validate: typecheck/build, Rust tests, the new suite, the existing
      Typst-adjacent suites, a release-build worker check, a narrow/dark-mode
      selection check, and a bundle-size measurement.

### Implementation notes

- `pdfjs-dist` is pinned to **6.4.299**; its worker loads from a hashed local
  asset and was exercised in the release build.
- The PDF is written to a per-render temporary filename (`pages-<n>.pdf`) rather
  than a shared `pages.pdf`. Concurrent previews share the temporary directory,
  and the shared name could let a slow render overwrite a newer one.
- The suite has **31** checks. The first cut had 23 and asserted that a single
  Pages click painted no word; that was the approved interaction at the time.
  The follow-up below replaced it with paragraph mapping, repeated-word, right
  column, drag-range and view-bar assertions.
- `cargo fmt --check` reports formatting differences across unrelated existing
  files; the changed Rust follows the surrounding file's style rather than
  reformatting the repository.

### Follow-up: two columns and the clicked occurrence

The first implementation searched the source for the selected word nearest the
editor caret. That cannot distinguish repeated words and is wrong in a two-column
PDF: a word in the left column can match a later occurrence in the right column,
or the first occurrence in the document. The follow-up:

- adds `src/typst-page-map.ts`, which indexes the source's 2/3/4-word sequences
  and maps a PDF visual line to its actual source occurrence (with fragment
  handling for hyphenated lines);
- groups PDF.js text items into visual lines by baseline and repeated left-edge
  clusters, so a line split into several spans (`tion` + `time error…`) is one
  context and a narrow two-column gutter still starts a new line;
- maps a single Pages click to the source paragraph and a double-click/drag to
  the clicked word/range; a drag reveals the source once on mouseup, not on
  every intermediate selection change;
- removes the old `findWordInSource` nearest-word fallback, so an unmatched line
  paints nothing rather than the wrong occurrence;
- removes the full-width `backdrop-filter` from the view bar and gives only its
  buttons an opaque background.

## Files and modules

| File | Why it must change |
| --- | --- |
| `src-tauri/src/typst.rs` | `RenderedTypst` result shape; `render_pages` compiles/reads/base64s the PDF; comments and any render tests. |
| `src/api.ts` | The `RenderedTypst` interface and its documentation; no command signature change. |
| `src/main.ts` | Pages integration, PDF view lifecycle, click/double-click wiring, Document word-map binding, removal of SVG object URLs. |
| `src/typst-pdf.ts` | New PDF.js page renderer: shells, text layers, lazy canvases, fit transform, cleanup, word callback. |
| `src/typst-map.ts` | Return `BlockRange[]`, set `data-b`, keep `mapped` and the existing line heuristics. |
| `src/source-map.ts` | Add the nearest-word search used by Pages (and export only what is needed). |
| `src/styles.css` | PDF page shell/canvas/text layer, fit transform, selection colour, dark-mode shadow. |
| `package.json`, `package-lock.json` | `pdfjs-dist` and the `typst:preview` script. |
| `scripts/typst-preview-test.mjs` | New CDP suite for Pages and Document word sync. |
| `scripts/test-all.mjs` | New suite entry and fixture. |
| `samples/typst-pages.typ` | Package-free two-column, two-page fixture with generated text. |
| `docs/guide.md` | The Typst section's description of Pages and word sync; the copy paragraph that currently calls Pages an unselectable picture. |
| `README.md` | The feature list names the page view and word sync; both statements become true for Typst as well. |
| `AGENTS.md` | Scripts table, testing table, layer count. |
| `docs/adr/2026-10-18-typst-pdf-pages.md` | New ADR for the Pages renderer decision. |
| `docs/plans/2026-10-18-typst-pdf-pages-and-word-sync.md` | This plan; status updated when approved/done. |

`src-tauri/tauri.conf.json` should not need a CSP change: the application CSP is
`null`, and PDF.js runs in the main webview, not the sandboxed HTML guest. If the
release worker fails under the asset protocol, that is the first place to
investigate, not a reason to loosen the guest CSP.

## Risks and rollback

- **PDF.js worker in the packaged application.** The Vite `?url` worker may work
  in dev and fail under Tauri's asset protocol. Test both a `tauri dev` window
  and a release build. Rollback is the branch revert; do not add a network
  fallback.
- **Base64 IPC size.** A large PDF becomes a large JSON string. Measure a
  10-page and a 100-page document. Default is base64; if a document exceeds an
  agreed threshold (proposed 8 MB of PDF), stop and consider a temp-file/asset
  URL instead. That is a follow-up, not part of this plan.
- **Canvas memory.** One full-resolution canvas per page is expensive. Render
  canvases only near the viewport, cap the device-pixel ratio at 2, and keep the
  text layer independent. If a long document still grows memory, add a bounded
  cache of rendered canvases.
- **Selection under a CSS transform.** Text selection on a scaled text layer can
  drift if the transform origin or the text-layer scale variables are wrong.
  The test must double-click a word, assert the selected string, and compare the
  source mark. If it drifts, fall back to re-laying out the text layer at the
  fitted width (and rerender the canvas) rather than shipping a broken overlay.
- **Wrong word on a duplicate.** `findWordInSource` must prefer the occurrence
  nearest the caret, and return null when the choice is not safe. A missing mark
  is acceptable; a mark on the wrong paragraph is not.
- **Typst word sync makes selectionchange do more work.** The block map is
  small, but a document with hundreds of blocks now binds and searches on every
  selection. Measure; if needed, only bind when the language is Typst and the
  preview is in split view, and clear the map when Pages is shown.
- **Visual regression from SVG to canvas.** Compare a page screenshot before and
  after at the same width. The PDF is the same layout, but canvas anti-aliasing
  and font hinting can differ. If the difference is unacceptable, the rejected
  "SVG + PDF text layer" alternative is the fallback, at the cost of a second
  compile.
- **Contract change.** `RenderedTypst.pages` disappears. Every consumer is in
  this repository (`api.ts`, `main.ts`), but the plan records the change because
  `render_typst` is a `#[tauri::command]`.

Rollback:

- Revert the branch/commits. There is no settings schema change, no persisted
  format, and no migration.
- If only the Pages renderer misbehaves, restore the previous `render_pages`
  SVG path and the `.typst-page` image branch from the parent commit.
- If only word sync misbehaves, remove `typst` from `wordSyncAvailable` (or stop
  binding the Typst block map); block click and Pages selection remain. This is
  a one-line behavioural rollback.

## Tests and validation

Layers, cheapest first:

- **Typecheck/build:** `npm run build`; the dynamic PDF.js import and the
  `RenderedTypst` shape must typecheck.
- **Rust:** `npm run test:rust` (or the MSVC wrapper's `cargo test`) for the
  existing Typst/settings tests; add a small unit assertion if the PDF result
  shape has a testable helper.
- **New CDP suite:** `npm run typst:preview` against a freshly launched instance
  holding `samples/typst-pages.typ`. It must measure:
  - Pages has page shells, canvases and non-empty text layers; the text layer
    contains both columns' words; the page aspect ratio is A4.
  - Double-clicking `pendulum` in Pages selects the word and paints
    `.cm-sync-word` with `pendulum`; the source is revealed.
  - Double-clicking a generated `#lorem` word paints nothing.
  - Switching to Document and double-clicking `pendulum` paints the source word;
    double-clicking `#lorem` paints nothing; a single block click still moves the
    caret/blinks.
  - Switching views twice disposes the PDF document; no page count growth, no
    stale text layer.
- **Existing suites:** `npm run smoke`, `npm run word-sync` (Markdown/AsciiDoc
  unchanged), `npm run image:syntax` (Document Typst still renders), and
  `npm run tabs` (a Typst tab still restores its scroll and caret). Run them in
  fresh instances as the harness already does.
- **Release check:** build with `npm run dist`, launch the staged release
  binary, open `samples/typst-pages.typ`, switch to Pages, select/copy a word,
  and double-click it. This is the test that catches a worker URL that only
  works under Vite.
- **Visual check:** screenshot one page at the same width before and after;
  compare the two-column layout and the page edges.
- **Bundle measurement:** record `dist` and the release exe before/after. The
  expected increase is about 0.45 MB compressed for PDF.js; if it is
  substantially larger, inspect the imported PDF.js surface.

The one measurement that proves the feature: **a word selected in Pages is
copied as text and double-clicking it paints exactly that word in the source,
while a generated word paints nothing.**

## Acceptance criteria

- Opening `samples/typst-pages.typ` in Pages shows A4 pages with a canvas and a
  text layer per page, both columns' text in the DOM, and selectable/copyable
  text.
- Double-clicking a prose word in Pages paints exactly that word in the source
  and reveals it; a repeated word in a later line or the second column paints
  that occurrence, not the first; double-clicking a generated word paints
  nothing; the page selection is not moved.
- A single click in Pages paints the source paragraph containing the clicked
  line. The view bar does not blur or tint the page; only the buttons are
  opaque.
- In Document, double-clicking or selecting a prose word paints exactly that
  word in the source; generated text paints nothing; a single click still
  reveals/blinks the block as it does today.
- `RenderedTypst` carries the PDF and no longer carries `pages`; the command
  signature is unchanged.
- `npm run build`, `npm run test:rust`, the new suite, `npm run smoke`,
  `npm run word-sync` and `npm run image:syntax` pass.
- The release build loads the PDF.js worker with no network request; the bundle
  growth is within the measured ~0.45 MB (plus the local CSS), not an
  unexplained multi-megabyte jump.
- The plan and the new ADR are left in the repository with their final status.

## Open questions

- **Single click versus double-click in Pages and Document.** The first cut kept
  single click passive in Pages; the user then asked for a paragraph click.
  Resolved in the follow-up: Pages single click paints the paragraph,
  double-click/drag paints the word; Document keeps its existing block reveal.
- **Text layer timing.** Default: build the text layer with the page when it is
  near the viewport, alongside the canvas, so selection is available as soon as
  the page appears. A text layer for every page at once is simpler but heavier
  for long documents.
- **Base64 threshold.** Default: keep base64 for this plan and measure; above
  8 MB of PDF, stop and design a temp-file/asset URL follow-up rather than
  guessing.
- **Visual fallback.** Default: PDF.js canvas. If the page screenshot differs
  materially from SVG, use the SVG-plus-text-layer alternative; do not silently
  accept a blurry or shifted page.
- **Fixture scope.** Default: `samples/typst-pages.typ` is package-free so the
  test is offline and deterministic. A package-importing paper remains covered
  by the CLI, which is the reason this plan does not need the WASM compiler's
  package registry.
- **ADR granularity.** Default: one ADR for the Pages renderer, with the
  block-record word sync recorded as a consequence. If review prefers a second
  ADR for the heuristic, split it before implementation.
