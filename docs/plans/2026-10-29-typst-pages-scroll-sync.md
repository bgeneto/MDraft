# Add scroll sync to Typst Pages and improve vertical alignment

**Status:** done
**Approval:** the user explicitly approved both phases on 2026-10-29 and asked
that existing production behaviour be preserved.
**Date:** 2026-10-29
**ADR:** `../adr/2026-10-29-content-scroll-sync.md`, to be written after approval.
It will extend the PDF/PDF.js decision in `2026-10-18-typst-pdf-pages.md`
and preserve the snapshot and correspondence rules in
`2026-10-22-selection-highlighting.md`.

## Context and goal

The reader wants source text and its preview counterpart to remain close to the
same screen height while either pane scrolls. Markdown, AsciiDoc, HTML and Typst
Document already follow each other reasonably well. Typst Pages has selection
correspondence, but no continuous scroll correspondence.

The priority is bidirectional vertical scroll sync for Pages, including ordinary
two-column papers. A second phase improves precision in the existing renderers.
Neither phase promises that all content in differently laid-out viewports can
simultaneously occupy the same height.

### Findings from the current implementation

| Area | Current behaviour and implication |
| --- | --- |
| `src/main.ts`, `syncSegmentFor`, `alignPreviewToScroll`, `alignEditorToScroll` | Piecewise linear interpolation between measured block starts. This is already substantially better than comparing total scroll percentages: local geometry includes fonts, wrapping, figures and tables. Preserve it as the coarse fallback. |
| `src/markdown.ts`, `annotatePreviewLines` | Original `marked` tokens identify top-level block source lines. Annotation fails closed if the token/block correspondence disagrees. |
| `src/asciidoc-preview.ts` | Asciidoctor source locations become block line ranges, including nested blocks. |
| `src/typst-map.ts`, `annotateTypstLines` | Typst Document matches folded block text forward against source text, normally using a 24-character prefix. These are heuristic block locations, not compiler spans. |
| HTML: `src/html-bridge.js`, `src/html-preview.ts`, `htmlSegmentFor` | The sandboxed guest supplies measured element tops; the host interpolates against source line tops. The guest already queues measurements and scroll reports with animation frames and observes layout changes. |
| `src/main.ts`, `renderTypstPreview` | Pages explicitly sets `previewLinesMapped = false`. Source scroll therefore skips its normal sync route. Pages supplies no `[data-line]` anchors to the reverse route either. Enabling that boolean alone would not add support. |
| `src/typst-pdf.ts` | All PDF text layers and line indices are built before `render` resolves. Only canvas rasterisation is lazy; freeing a canvas retains the text layer. A scroll map can therefore work beyond the currently painted pages. |
| `src/typst-pdf.ts`, `indexLines` | PDF-space baselines, column clusters and full-width bands already define reading regions. `TextLine.top` is a baseline, not a CSS glyph-top coordinate. Fit, page shells and inter-page gaps must be included when converting to screen coordinates. |
| `src/typst-page-map.ts` | One immutable bidirectional index links literal source prose to PDF words using unique windows of two to six words and bounded gap filling. Both selection directions share accepted links. Repeated ambiguous passages and generated content remain unmapped. This is the starting point for Pages scroll anchors. |
| `src/editor.ts`, `topVisibleLine` / `lineTop` | Uses logical source lines and `lineBlockAt(...).top`. Wrapped rows and the character position within a long paragraph are absent from the scroll map. CodeMirror defines these heights relative to `documentTop`, whereas `scrollDOM.scrollTop` includes the scroller's padding. The editor theme has 22px top padding. Normalising these coordinate systems is necessary; the visible size of the current bias still needs measurement. |

The current 12px preview margin and 150ms suppression window are sensible
stability mechanisms. They do not establish literal screen-height equality:
block interpolation assumes approximately uniform content distribution between
anchors. Long paragraphs, uneven lists, code, tables and different wrapping can
violate that assumption. Duplicate source-line anchors also produce degenerate
segments. Forward/reverse interpolation is inverse only for strictly increasing,
unclamped segments; equal heights, rounding and viewport limits are exceptions.

The existing DOM smoke checks prove continuity at font-size extremes and catch a
large reverse jump. They do not measure the height difference between the same
word or visual row on both sides. The new validation must do so.

### Typst research, checked on 2026-10-29

- The installed compiler is `typst 0.15.1 (9dfd3a08)`. Its `compile --help`
  exposes no SyncTeX/source-map output switch. `--deps` is a dependency-file list,
  not a layout/source map. This agrees with the
  [official CLI arguments at v0.15.1](https://github.com/typst/typst/blob/v0.15.1/crates/typst-cli/src/args.rs).
- Typst does have compiler-level navigation. The official
  [`typst-ide` jump implementation](https://github.com/typst/typst/blob/v0.15.1/crates/typst-ide/src/jump.rs)
  provides `jump_from_cursor` and `jump_from_click`, backed by source spans and
  the compiled document. These functions do not accept an exported PDF as their
  source of provenance. Forward navigation may return multiple positions, and
  is itself limited to supported syntax/spans; it is not a universal inverse.
- The maintainers explicitly recommend that integration layer rather than
  embedding development source links in PDF in
  [Typst issue 7086](https://github.com/typst/typst/issues/7086#issuecomment-3412511556).
  Therefore a closed SyncTeX feature request is not evidence that the CLI gained
  a SyncTeX sidecar format.
- Tinymist demonstrates the compiled-document approach: its
  [preview adapter](https://github.com/Myriad-Dreamin/tinymist/blob/73db58b8e2fd2cc6b85038594464b91684c79491/crates/tinymist/src/tool/preview/compile.rs)
  resolves source/document positions against a retained compilation artifact.
  Its [standard preview integration](https://myriad-dreamin.github.io/tinymist/feature/preview.html)
  also starts a local server. Adopting that whole integration would change
  MDraft's current architecture and compiler lifecycle.

**Conclusion:** Pages scroll sync is feasible using our existing PDF and text
map, without another compiler or dependency. Compiler provenance could later
improve coverage of formulas, expansions and included files, but requires a
separate architectural project. It is not a missing CLI flag we can turn on.

### Investigation validation

- `npm run typst:map:unit`: **21/21 passed**.
- `npm run block:map:unit`: **12/12 passed**.
- `npm run html:map:unit`: **38/38 passed**.
- Compiled the package-free `samples/typst-pages.typ` through the managed CLI,
  with stdin input and PDF stdout, then extracted its two pages using the
  installed PDF.js. Both are A4; extraction returned 39 nonblank text items on
  page 1 and 41 on page 2. This confirms the current pipeline, not new scroll
  precision or the coverage of the application map.
- The diagnostic compilation required execution outside the shell sandbox;
  sandboxed runs returned `error: Access is denied. (os error 5)`, including
  with embedded fonts and workspace-local temporary/package paths. The same
  original probe succeeded through approved execution escalation. Recorded in
  `AGENTS.md`.
- No application code or settings were changed. No UI suite, full build or full
  `npm test` was run for this investigation. Current pixel error has not yet
  been measured; the targets below are proposed acceptance thresholds.

## Scope and non-scope

**Phase 1, priority:** add both scroll directions for Typst Pages; use accepted
prose correspondences; account for pages, columns, fit, zoom and source wrapping;
preserve the reader's place through layout changes; retain the existing Sync
scroll preference and its Split-only operation. Establish a shared coordinate
contract and correct the existing block path to use it.

**Phase 2:** refine scrolling within supported literal text in Markdown,
AsciiDoc, Typst Document and HTML, using existing text correspondence. Keep the
current block interpolation whenever fine mapping is unavailable. Add measured
precision tests for both phases.

Both phases are proposed for approval together, implemented and validated in
that order. A difficulty in phase 2 must not turn phase 1 into a compiler rewrite.

**Outside this plan:** embedding `typst`/`typst-ide`, installing Tinymist or
typst.ts, emitting SyncTeX, replacing PDF.js, source instrumentation, rewriting
Typst Document's text matcher, changing PDF export, automatically opening
included source files, adding horizontal sync, new settings/menu commands, and
exact provenance for arbitrary generated material. No npm/Cargo dependency,
Tauri command, `src/api.ts` contract or settings schema change is needed.

## Approach and rejected alternatives

Keep rendering and correspondence separate from scroll policy. A small pure
solver operates on verified correspondence anchors and local monotonic runs;
the existing renderer adapters own DOM/PDF/iframe geometry. `main.ts` continues
to own active-document lifetime and the direction of synchronisation. This is a
focused extraction of scroll calculations, not a general rewrite of `main.ts`.

### 1. One explicit coordinate contract

- Represent content identity with UTF-16 source offsets, not just line numbers.
  Geometry is in CSS pixels, with an explicit conversion to each scroll
  container. Read CodeMirror's `documentTop`, scale and actual text rectangles;
  do not equate document-relative `lineBlockAt().top` with `scrollTop`.
- Preserve a reference near the top of the overlapping visible pane area, using
  the existing 12px intent. Use actual pane rectangles so borders, padding,
  iframe origin and the Typst view bar do not become unexplained offsets.
- For a verified pair, the desired correction is
  `targetScroll += targetScreenY - originScreenY`, clamped to the target range.
  Interpolate between compatible pairs to keep movement continuous. Align the
  same visual-row feature on both sides, rather than a PDF baseline to a DOM
  glyph top.
- Source positions outside CodeMirror's measured viewport may need an estimated
  line/block scroll first. Refine once after `requestMeasure` if the request's
  source, render, layout and input generations are still current. Never refine
  repeatedly against a changing height estimate.
- Coalesce equal-height anchors and treat them as intervals with a stable
  representative. Do not divide by zero or promise a unique inverse where a
  source row corresponds to several preview rows.

### 2. Pages anchors and two-column policy

- Expose a read-only view/index of the already accepted source/PDF links from
  `TypstPageMap`. Include source ranges, PDF line/range identities and reading
  region. Do not relax the matcher or feed approximate scroll fallback back into
  word highlighting.
- `TypstPdfPreview` combines these identities with page-local geometry and live
  shell/fit positions. Use `PageViewport` conversions and text-layer rectangles;
  do not assume all pages have the same size, multiply the document's total
  scroll position by fit, or include device-pixel ratio in CSS coordinates.
- Build source-sorted and region/height-sorted lookup indices once per render.
  Avoid scanning every PDF word or measuring every page on every scroll event.
  Existing lazy canvas painting remains unchanged.
- Split runs at page, column/band and layout-order discontinuities. In a
  two-column page, moving down the source from the left-column end to the
  right-column start legitimately moves the PDF reference upward. Do not flatten
  that transition with `Math.max` or interpolate through the column boundary.
  Make one deliberate reposition when entering the new run.
- In the reverse direction, vertical position alone cannot choose between two
  columns at the same height. An explicit preview wheel/pointer gesture over a
  body column chooses that column. Otherwise retain the last successfully
  synchronised region while it remains relevant; when it leaves the viewport,
  choose the adjacent visible region on the same reading branch. With no prior
  context, start with the first visible body region in reading order. A pointer
  merely hovering over another column must not change an established branch.
- Use a small, tested hysteresis around region boundaries. Source caret
  proximity must never establish textual identity for a repeated passage; branch
  state only chooses among already verified geometric candidates.
- In page margins, inter-page gaps, drawings, repeated headers and unmapped
  formulas/generated text, use a nearby verified boundary only within the same
  established region and bounded source neighbourhood. Do not interpolate
  across unrelated regions or large unmapped gaps. Hold the last good alignment
  if no safe candidate exists; resume at the next reliable anchor. Record
  fallback/coverage separately from precision in tests.

### 3. Finer anchors in existing flowing previews

- Query verified source/text spans from the existing word maps near the origin
  pane's reference row; measure their actual wrapped rectangles. Adaptively add
  local anchors inside long paragraphs, list items and code where correspondence
  exists. This improves the assumption that all progress inside a block is
  proportional, without tokenising or re-rendering on scroll.
- Distinguish verified text geometry from an atomic formula/image or a whole
  block fallback. The current selection API may return a whole block for an
  unmapped span; that result must not masquerade as precise word geometry.
- Keep block anchors, interpolation and source safety when text is transformed,
  generated, ambiguous, or otherwise not mapped. Hidden, nested, duplicate and
  non-monotonic HTML element positions need filtered/local runs rather than an
  assumed globally invertible list.
- HTML fine geometry stays in the opaque-origin guest. Extend its existing
  tokened bridge with bounded text-identity/decoded-offset probes and scroll
  targets, reusing the current fragment identities and sample validation. Source
  offsets remain host-only. Validate frame, render/layout/request generation,
  sample, finite geometry and offset limits; stale or malformed messages do
  nothing. This does not grant the guest editor or Tauri access.

### 4. Ownership, invalidation and interaction

- Coalesce work to one animation frame, batch geometry reads before writes and
  use cached/searchable correspondence. Rebuild only geometry affected by
  font/width/zoom/fit changes. No compilation, IPC filesystem request, network
  request or full-document text search is allowed on the scroll path.
- Track the originating pane, expected programmatic target and input generation.
  Matching reflected scroll events must not bounce back. New wheel/touch/key or
  scrollbar input in the other pane can take ownership immediately instead of
  being swallowed for the remainder of 150ms. Keep a bounded timeout as a
  safety guard, not as the only ownership mechanism.
- Key maps by session/revision, source snapshot, render token and layout epoch.
  Editing invalidates fine/Pages sync immediately, before debounce. Late renders,
  measurements, bridge replies and callbacks cannot move a replacement tab.
- Re-render, resize and zoom preserve a semantic source/region reference when
  available. Honour pending tab scroll restoration before any automatic align;
  cancel restoration/refinement if the reader has already scrolled again.
- Scroll moves offsets only. It never moves the caret, focus, selection or paints
  correspondence. Preserve existing click, drag, Escape and keyboard-reveal
  semantics; keyboard reveal remains a separate policy. Suspending follow during
  an active text drag avoids moving content under the pointer. Do not add smooth
  animation to the continuous scroll loop.

### Alternatives

| Alternative | Assessment |
| --- | --- |
| Global scroll ratio or source-line/page fraction | Cheap, but drifts at directives, large figures, unequal page sizes and columns. Rejected. |
| Feed Pages into the existing sorted `[data-line]` list | Cannot represent column resets or reverse ambiguity. Rejected. |
| Search PDF words nearest the caret for every scroll | Reintroduces the repeated-word bug, performs full searches and confuses navigation state with provenance. Rejected. |
| Inject labels/metadata or `show` rules and query their positions | A probe may help a controlled document, but source rewriting and extra compilation can change layout/semantics and do not supply a general source map. Rejected for this feature. |
| Replace PDF.js with SVG/typst.ts | A renderer replacement does not recover provenance from the existing CLI PDF and reopens selection/compiler parity work. Rejected. |
| Native compiler spans via `typst-ide` or Tinymist | Best future route for broader provenance. Defer to a separately approved plan: PDF and map must come from the same compiled artifact, with matching fonts, roots, packages, unsaved overlays and compiler version. A second independent compilation beside the CLI PDF could disagree. Any such map needs file identity, occurrence handling and explicit UTF-8-byte to UTF-16 conversion. It still cannot make a two-column vertical inverse unique. |

## Steps

- [x] Record approval in this file and set status to `approved` before source edits.
- [x] Capture a baseline of content-pair vertical error, coverage, round trips,
  event latency and source/selection stability in all five preview modes. Use
  isolated test ownership and the named fixtures below; do not manipulate a
  running user instance.
- [x] Add the coordinate/run solver and unit tests for clamps, ties,
  discontinuities, branch selection, stale generations and reflected events.
  Correct the shared block coordinate conversion without changing its fallback.
- [x] Expose/index accepted Pages correspondences and add geometry adapters,
  including varying page sizes, fit and region boundaries.
- [x] Connect both Pages scroll directions to the existing Sync scroll toggle.
  Complete phase 1 UI/visual validation before proceeding to the other renderers.
- [x] Add strict fine-text geometry queries for flowing previews and local
  interpolation, keeping atomic/block fallback and highlight semantics.
- [x] Add the bounded HTML geometry bridge extension and its rejection tests.
- [x] Complete resize/zoom/re-render/tab restoration and immediate ownership
  handoff checks; verify no scrolling during selection gestures.
- [x] Compare before/after precision and performance, run relevant suites during
  development and the final required suite, then inspect screenshots at the
  difficult transitions.
- [x] Write the ADR, update README/script documentation, record traps and any
  deviations here, tick the checklist and set status to `done`.

## Files and modules

| File | Purpose |
| --- | --- |
| `src/scroll-sync.ts` (new) | Pure local-run interpolation, anchor selection and branch/ownership calculations. |
| `src/main.ts` | Renderer dispatch, snapshot lifetime, input ownership, scroll scheduling and restoration priority. |
| `src/editor.ts` | Source-offset/visual-row geometry and coordinate conversion; retain existing callers' contracts or update the scoped internal call sites together. |
| `src/typst-page-map.ts` | Read-only accepted-link access and reusable lookup indices, without widening correspondence. |
| `src/typst-pdf.ts` | PDF geometry, region/run adapter, fit/layout epoch and semantic place preservation. |
| `src/source-map.ts` | Strict fine-text geometry queries that expose mapping quality separately from whole-block fallback. |
| `src/html-preview.ts`, `src/html-bridge.js` | Validated fine geometry/scroll probes over the existing guest boundary. |
| `scripts/scroll-sync-unit.mjs` (new), `scripts/scroll-sync-test.mjs` (new) | Pure solver/ownership cases and pixel/error measurements through the real UI. |
| `scripts/typst-page-map-unit.mjs`, `scripts/block-map-unit.mjs`, `scripts/html-source-map-unit.mjs` | Accepted-link parity and strict query/boundary rejection regressions. |
| `scripts/dom-smoke.mjs`, `scripts/typst-preview-test.mjs`, `scripts/html-preview-test.mjs`, `scripts/preview-zoom-test.mjs` | Extend relevant existing no-jump, selection, lifecycle and zoom checks. |
| `samples/scroll-sync/prose.md`, `samples/scroll-sync/prose.adoc`, `samples/scroll-sync/prose.html` (new) | Equivalent long/uneven literal prose, lists, entities, inline formatting and unmapped blocks. |
| `samples/scroll-sync/single-column.typ`, `samples/scroll-sync/two-columns.typ` (new) | Unique measurable passages; page/column transitions, mixed page sizes, full-width text, repeated words, formulas and generated gaps. Keep the existing two-page fixture's page-count assertions intact. |
| `package.json`, `scripts/test-all.mjs`, `AGENTS.md` | Register/document `sync:unit` and `sync` layers, their fixtures and ordering. No lockfile change is expected. |
| `README.md`, `docs/adr/2026-10-29-content-scroll-sync.md`, relevant supersession pointers | User-facing coverage/limits and the durable responsibility/coordinate decision. |
| This plan | Approval, implementation record, deviations and measured results. |

No backend file or export path is in the implementation scope.

## Risks and rollback

- Wrong correspondence is more disruptive than a temporary pause. Share existing
  accepted links, keep confidence explicit, and never silently fall back to a
  global page ratio.
- Multi-column reading order, floats, tables and generated content may defeat
  the existing region heuristic. Support the tested one/two-column prose cases;
  degrade to bounded anchors or hold, and document unresolved layouts. Do not
  promise arbitrary-layout accuracy.
- Dense measurement may cause layout thrashing or amplify rounding. Cache
  indices, measure only bounded visible neighbourhoods, cap refinement to one
  current request and test idle stability.
- New input ownership can fight typewriter, keyboard reveal or restoration.
  Explicit priorities and existing interaction regressions are required.
- HTML geometry is untrusted input. Reuse the current sandbox/authentication and
  decoded/raw offset validation; do not expose a filesystem/editor command.
- Revert the scoped implementation commits to recover the existing block path
  and unsupported Pages scrolling. There is no settings migration to undo.
  Phase 2 can be reverted independently while retaining phase 1 and its tests.

## Tests and validation

1. **Pure tests:** local interpolation and inverse only where mathematically
   defined; equal source/preview heights, clamping, empty maps, large gaps,
   column resets, deterministic branch choice/hysteresis, Unicode offsets,
   accepted-link parity, invalid/stale geometry and immediate input handoff.
2. **Content error:** measure `abs(sourceTextRect.top - previewTextRect.top)` in
   common screen CSS coordinates for explicitly matched literal words/rows,
   plus the equivalent baseline where a block is the supported unit. Report
   median, p95, maximum, mapped/fallback/unmapped counts and clamped cases.
   Do not count unmapped probes as zero-error successes.
3. **UI matrix:** both directions; small wheel steps and large scrollbar jumps;
   at least 20 declared probe positions per direction across each fixture;
   editor/preview font extremes, long logical lines, wrapped rows, zoom
   50/100/150/300%, narrow/wide panes, typewriter on/off and reduced motion.
4. **Pages:** both columns at the same height, deliberate column handoff, page
   boundaries, full-width bands, short last pages, mixed page dimensions,
   formulas beside prose, repeated passages, generated gaps and lazy canvases.
   Scroll must not depend on canvas paint completion.
5. **Lifetimes/interactions:** disable Sync scroll; leave Split; selection/copy,
   double-click/drag/Escape; caret and focus invariance; edit during a pending
   render; compilation failure; tab/view replacement; resize/zoom during a
   pending correction; font/image/diagram layout changes; no idle oscillation.
6. **Development gates:** `npm run build`, `npm run sync:unit`, the three map
   unit suites, then the focused `sync`, smoke, word-sync, HTML, AsciiDoc,
   Typst-preview, preview-zoom and typewriter layers through the owned harness.
   Run format/lint/knip after the relevant source edits.
7. **Completion gate:** the repository's full normal `npm test` sequence and
   frontend quality gates, observing its user-instance guard. Every cargo/Tauri
   invocation on this Windows host uses the documented wrapper. Opt-in live
   network/download layers remain opt-in. Repeat representative geometry/fit
   checks on WebKitGTK or WKWebView when available and record platform gaps.

Retain baseline/after metrics and screenshots in the normal ignored evidence
directory, summarised here. For mapped, non-clamped literal probes, target p95
vertical error of no more than one larger visual line-height, and a lower median
on the long/uneven flowing-prose fixtures than the baseline. An already precise
fixture must not materially regress. Once a specific pair has been selected,
the final alignment correction should settle within 4 CSS pixels; report line
selection error separately. A locally invertible round trip should return
within 4 CSS pixels after layout settles. These are implementation acceptance
targets, not results established by this investigation.

Measure scroll work separately from compilation and canvas paint; target one
update per frame and p95 synchronous work below a 16ms frame on this host for a
long prose fixture. Record the document size and timings rather than treating a
fast two-page example as sufficient performance evidence.

## Acceptance criteria

- With Sync scroll enabled in Split, ordinary Typst Pages prose follows either
  pane, including passages in both columns and pages beyond the first canvas.
- The two-column transition repositions once; reverse scrolling follows a
  deterministic established column and does not alternate between columns.
- The measured alignment targets above pass on all declared supported probes.
  Missing/ambiguous correspondence is reported separately and never sends the
  reader to a plausible but unrelated word or region.
- Flowing previews improve measured long-paragraph alignment while preserving
  their existing safe block fallback, click behaviour and keyboard reveal.
- Source bytes, dirty state, caret, focus and selection do not change from
  scrolling. Disabled/outside-Split and stale snapshots cannot trigger follow.
- Resize, zoom, fit changes and fresh renders preserve the current semantic
  place without fighting user input or tab scroll restoration.
- The implementation adds no compiler, dependency, background request, setting
  migration or PDF export change. Existing functional/quality gates pass, with
  environmental skips or platform coverage gaps recorded explicitly.

## Open questions

- **Compiler spans now or later?** Default: later, in a separate plan. Revisit
  only if the measured text-map coverage is inadequate for representative real
  documents; do not silently add a compiler to this scope.
- **Which column without an explicit preview gesture?** Default: retain the
  established reading branch; otherwise the first visible body region. Do not
  add a column picker in this change.
- **How much precision is practical?** The targets above apply to supported,
  mapped, non-clamped content near the reading reference. Capture baseline
  measurements first. If they prove unsuitable, record evidence and revise the
  plan before weakening acceptance or widening scope.
- **Optional real corpus?** Use `docs/samples/prova-fisica.typ` if present and
  package/font dependencies are locally available; it is not a test prerequisite.
  Tracked, package-free reproducers must cover every required layout case.

## Execution record

- 2026-10-29: read-only investigation and plan drafted. Application source is
  unchanged; awaiting explicit implementation approval under
  `AGENTS.md` governance.
- 2026-10-29: user approved implementation of the plan; beginning baseline
  measurements before changing application source.
- Phase 1: geometry/ownership unit 25/25; Pages map 24/24; existing block/HTML
  maps 12/12 and 38/38. Isolated UI correspondence 15/15, including 40/40
  measurable Pages pairs and Pages p95 1.14px (explicit gestures identify the
  preview column). Existing smoke remains 114/114. Flowing-mode p95 with just
  coordinate normalisation: Markdown/AsciiDoc 1.15px, Document 1.38px, HTML
  2.35px. Continuing with phase 2 and lifecycle/zoom stress validation.
- Baseline: private identifier `io.github.bernh.mdraft.scrolltest`, because an
  installed production instance was open. The temporary runner and build config
  are under ignored `node_modules/.cache/mdraft-scroll`; production settings and
  recovery are never touched. Existing smoke: 114/114 passed. Forty probes per
  renderer: median/p95 errors in CSS pixels were Markdown 12.86/13.51,
  AsciiDoc 12.86/13.51, Document 12.60/13.76 and HTML 13.88/14.41. Pages had
  median 1269.49/p95 3222.65 and 20 unavailable source rectangles, as expected
  without scroll support. Startup focus changed during the first Markdown
  measurement; final interaction assertions will establish focus explicitly
  before taking their snapshot. Raw measurements: ignored `baseline.json`.
- 2026-10-29 final verification pass: the new `sync` layer was made
  non-blocking: every CDP request has a timeout and socket-close failure, the
  suite owns its final `process.exit`, and it reconnects to the new
  `.html-preview-frame.active` target after returning from Source-only to Split
  (that re-render replaces the iframe and closed the old CDP target). The
  Pages column handoff now also follows a wheel that changes the column without
  changing `scrollTop`; a pending refinement or bookmark read no longer consumes
  that pointer. `HtmlLayout`/`HtmlScrollGeometry` carry the iframe's CSS zoom,
  and the HTML fine/coarse paths convert guest CSS pixels to host pixels and
  back. The suite waits 200ms between gestures and polls each correction until
  it settles, so the old fixed 190ms sample and the 764px column transient are
  gone: Pages max 1.14px, all five 100% matrices pass 40/40, Markdown/AsciiDoc/
  Document/HTML p95 0.30/0.30/0.20/0.29px. The zoom matrix runs two source pairs
  at 50/150/300% and settles below 0.4px; narrow/wide resize and a Pages tab
  switch are now explicit checks. The reverse direction at a zoom is not
  asserted here because its chosen pair lives inside the guest probe and is not
  exposed to the Node harness; the 100% matrix exercises both directions. The
  suite exits 62/62 and closes its launched app.
- 2026-10-29 selection and performance verification: the Pages word
  correspondence failures were a real follow/reveal race. A preview-scroll
  correction queued before a double-click could run after the selection reveal
  and move the source to the previous region; `queuePaneScroll` now discards a
  queued correction when the input epoch changes or an active drag owns the
  pane, and a preview correction does not run during a selection's short reveal
  hand-off. The test also focuses the editor before its local edit and blurs the
  editor before a programmatic Pages range, so it measures the intended
  gesture. `typst-preview` is 52/52. Word-sync 58/58, AsciiDoc 54/54,
  preview-zoom 24/24, typewriter 21/21, HTML 60/60 and smoke 114/114 pass on
  fresh instances. The scroll callback was measured over 482 corrections on the
  21KB prose fixture: median 0.30ms, p95 0.70ms, maximum 1.10ms, well inside a
  16ms frame. The ADR (`docs/adr/2026-10-29-content-scroll-sync.md`), README and
  guide coverage/limits, script-table rows and test traps are written.
- 2026-10-29 completion gate: the repository's full normal
  `npm test -- --no-build` finished **49/49 layers passed, 0 failed**. The
  final run includes `sync` 62/62, `typst-preview` 52/52, typewriter 21/21,
  word-sync 58/58, HTML 60/60, preview-zoom 24/24, tabs 107/107, favorites
  56/56, tabs-restore 25/25 and favorites-restore 30/30. Two earlier full runs
  exposed unrelated flakes: `favorites-restore` right-clicked before the editor
  context-menu listener was installed, and the typewriter caret was sampled
  before its post-undo centering frame. The restart test now retries the menu
  gesture (and its tab menu) and the typewriter check polls the caret; both
  layers pass alone and in the final full run. The plan is done; the only
  intentional test-scope note is that reverse-direction zoom precision is
  asserted at 100%, while the source direction is asserted at 50/150/300%
  because the guest probe's selected pair is not exposed to the Node harness.
