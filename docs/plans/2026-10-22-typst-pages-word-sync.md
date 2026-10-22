# Make selection highlighting reliable across document formats

**Status:** done
**Date:** 2026-10-22
**ADR:** `../adr/2026-10-22-selection-highlighting.md`

**Approval:** explicitly approved by the user on 2026-10-22 for implementation
of the expanded cross-format scope.

**Release follow-up:** the user explicitly authorized committing the completed,
green implementation on master, publishing version `0.4.6` with the repository's
required `v0.4.6` tag, and checking that the
release workflow starts without waiting for its build artifacts.

## Context and goal

Alternating selections between the source editor and Typst Pages can produce no
highlight, especially in the two-column `docs/samples/prova-fisica.typ` exam.
Investigation used an isolated copy of the existing portable release, a private
settings/WebView profile, real CDP mouse double-clicks and drags, and read-only
debugger instrumentation of the running mapper. No application source was edited.

Confirmed observations:

- Preview double-clicks on `instante` and `partícula` in question 1 paint those
  source words. Double-clicking `velocidade` in the nearby `com velocidade` span
  selects the correct preview word but paints nothing. Selecting `partícula`
  again succeeds: this sequence does not permanently disable sync.
- The failing PDF line is `com velocidade 𝑣 = ( 2,0 𝑖 − 9,0 𝑗 ) m/s`.
  `TypstSourceMap.mapLine` chooses a matching numeric pair (`2,0`) instead of
  the selected prose. The selected word lies outside the winning match, and
  `wordForLineToken` cannot recover it by adding a fixed token-index offset.
  Source math such as `arrow(v)_0`, `hat(i)` and `thin` also has a different
  token sequence from the PDF's mathematical glyphs.
- Indexed line contexts sometimes combine question 1's trailing formula text
  with question 6's prose in the other column. Column assignment currently
  chooses the closest column *start* for each individual span; a formula or
  right-hand fragment of a left-column line can consequently join the right
  column. Sorting spans by their top edges also mishandles superscripts and
  subscripts, and inserting a space between every span can split a word.
- A real drag selects exactly `com velocidade`, but `contextForRange` reports
  `multiLine: true` with `end: 0`: the browser can place a range endpoint on a
  wrapper/element boundary, which `locate` does not resolve. Drags selecting
  `No instante` and `coordenadas estão` paint the correct source phrases.
- Every tested editor double-click selects its source word but registers no
  preview CSS highlight in Pages. `doRender` clears `wordMap`; only Document
  binds a new one. `syncPreviewFromSource` therefore exits early in Pages.
- `npm run typst:map:unit` passes all 9 existing checks. Those checks do not
  cover the failing mixed prose/math line, DOM endpoints, or reverse sync.

A diagnostic sweep found 248 unmapped tokens among 1,099 extracted PDF tokens.
This is **not** a failure rate: the inventory includes generated labels and
mathematics that are deliberately not mapped. Correct source occurrences and
visible highlights, rather than raw coverage, must decide acceptance.

The goal is reliable bidirectional selection of literal source prose, including
words adjacent to formulas and words fragmented by PDF layout, without painting
an unrelated occurrence or letting selection history affect the answer.

### Scope expansion requested on 2026-10-22

The user also requested an audit of the other formats and inclusion of their
flaws and improvement opportunities in this plan, then explicitly approved the
expanded plan for implementation. The existing filename is retained so links to
this plan keep working.

The expanded audit used the existing portable release, private settings and
temporary Markdown, AsciiDoc, Typst Document and HTML fixtures. It combined real
HTML double-clicks/keyboard input with valid browser Range endpoint probes and
CodeMirror selections. A Range probe is identified below where a boundary case
was constructed directly rather than produced by a real mouse drag.

| Area | Confirmed result | Cause / classification |
| --- | --- | --- |
| Markdown, AsciiDoc and Typst Document endpoints | A browser Range selecting only bold `bravo` maps to the entire `alpha **bravo** charlie` sentence (single asterisks in the other two formats). | `textNodeAt` chooses the first/last descendant text while ignoring the element's child offset. This is a shared correctness bug, not a format-specific heuristic limit. |
| AsciiDoc and Typst Document reverse mapping | A source selection covering `alpha *bravo* charlie.` and `delta echo` paints only `delta echo`. | `rangeForSource` returns from the first candidate block with a match; candidates are ordered by block size, not selected document order. It drops the other selected block. |
| Render snapshot lifetime | Immediately after inserting `PREFIX ` at the start of the temporary Markdown buffer, selecting still-visible preview `alpha` paints source `audit`. | The map still describes the previous buffer during the render debounce. Clearing the old paint alone does not invalidate the old correspondence. The observed failure is Markdown; every adapter needs the same snapshot guard and its own regression test. |
| Reduced motion | With `prefers-reduced-motion: reduce`, the preview registry changes from `mdraft-sync` to `mdraft-sync-peak` after 310 ms. | The JavaScript pulse continues despite reduced motion; the existing CSS rule suppresses only the editor animation. |
| HTML named entities | Selecting `afterword` in `Caf&eacute; afterword.` paints `acute; af` in source. Pure reproductions with `&copy;` and `&NotEqualTilde;` also produce wrong raw slices. | parse5 decodes HTML entities fully, but `rawOffsetForDecoded` knows only six named entities. The decoded sample check passes while the decoded-to-raw conversion is wrong. |
| HTML nested ownership | Real double-click on `afterwordNested` in `<div>lead<p>inside</p>afterwordNested</div>` selects the right word but paints nothing. The guest reports outer stamp index 2; the host records it as index 1. | Guest indexing counts the nested stamped paragraph's text, whereas host indexing assigns it to the nested stamp. Both sides must use the same text-node ownership and skip rules. |
| HTML inline boundaries and multiword selections | Real double-click on `<strong>bravo</strong>` selects `bravo ` with the trailing space in the next text node and paints nothing. A Range selecting `alpha bravo` across the inline element sends no selection report and leaves an earlier `sample` source mark visible. | The bridge rejects different start/end text nodes before trimming whitespace; it also rejects element endpoints. Rejection does not clear the previous correspondence. |
| HTML Escape | After successful preview selection of `sample`, pressing Escape while the iframe has focus leaves the source `sample` mark visible. | The host's document key listener cannot see an unmodified key pressed in the guest, and the bridge does not report Escape. |
| HTML same-word reselection after editing | `sample` paints successfully; append a newline at the end of the temporary HTML buffer, wait for the new guest, and select the same `sample` again: no source mark. | An edit clears CodeMirror's decoration but HTML rendering leaves `syncedSource` cached. The equal-range fast path then pulses a decoration that no longer exists. |
| HTML reverse highlighting | Source selection produces no word highlight inside the guest (`CSS.highlights` stays empty). | An explicit earlier scope exclusion in the HTML ADR. Adding this is a proposed parity improvement, not a newly introduced regression. |

Positive controls and intentional limits:

- An ordinary Markdown preview selection of `afterword` after `&eacute;` maps
  correctly in the audit fixture. The demonstrated entity corruption belongs
  to the HTML mapping path; do not assume every format has the same decoder bug.
- A real HTML double-click on the ordinary single-node word `sample` maps
  correctly before the lifecycle/boundary tests.
- AsciiDoc attribute values and inline formulas inside anchored blocks
  intentionally fall back to the containing block, as recorded in
  `../adr/2026-10-20-block-sync-fallback.md`. Preserve this documented behavior
  and distinguish it from an exact word match in internal results and tests.
  Unanchored generated/included content still must not receive a guessed match.
- The existing `block:map:unit` and `html:map:unit` suites pass **12/12** and
  **14/14** respectively. Their present cases miss these cross-node,
  multi-block, complete-entity and lifecycle failures. Full builds and UI suites
  are deferred to implementation; the audit did not change application source.

## Scope and non-scope

In scope:

- Pages text geometry, column separation, fragment joining and DOM endpoints.
- A per-render, bidirectional correspondence between source offsets and PDF
  text ranges; both gestures use the same accepted correspondences.
- Single-word and short multiword selections, including a word split across
  spans or a hyphenated line break, and phrases crossing visual lines when the
  endpoints belong to a verified source passage.
- Clear ownership of Pages events, pending timers and stale render state.
- Shared DOM endpoint resolution, complete selections across block boundaries,
  immediate source-snapshot invalidation, reliable repainting of repeated
  selections, Escape handling and reduced-motion behavior across formats.
- HTML entity offsets, consistent host/guest text ownership, selections across
  inline nodes, stale-mark clearing and source-to-guest word highlighting.
- Preserve Markdown's exact fragments and the documented AsciiDoc/Typst
  Document block fallback; share lifecycle/selection mechanics without replacing
  those formats with Pages' text heuristic.
- Regression tests, documentation and an ADR for the mapping responsibility.

Out of scope:

- Changing Typst compilation, PDF export, PDF.js, the document dialects or
  converter output; adding dependencies, Tauri commands or settings. Preview-only
  mapping metadata and the internal HTML bridge messages may change as described
  below; saved documents and the guest's sandbox/IPC permissions do not.
- Inferring exact source origins for arbitrary evaluated/generated content,
  includes, macros or formulas. Unanchored content remains unpainted; the
  documented anchored-block fallback in AsciiDoc/Typst Document is preserved.
- Replacing the CLI with a bundled Typst compiler, WASM compiler or Tinymist.
- A permanent diagnostic panel, telemetry, background network requests, or a
  promise of exact compiler source positions recovered from PDF text alone.
- Restyling all highlights, replacing renderers, adding an LSP, or making block
  fallback and generated-content mapping exact without source provenance.

## Approach and rejected alternatives

Retain the existing compiler/PDF.js pipeline and build a Pages correspondence
index once per rendered source snapshot. Keep the matching logic pure in
`typst-page-map.ts`, and keep PDF geometry and DOM ranges in `typst-pdf.ts`.
Preserve exact UTF-16 offsets through normalization and fragment joining.

Use page-local coordinates and PDF baseline/text-item information to establish
lines and reading regions. Column membership must respect column extents and
gutters, rather than assigning every span to its nearest left edge. Join adjacent
glyph fragments using spacing evidence; retain separate DOM ranges for a source
word that is drawn in multiple places across a hyphenated break.

Locate reliable prose anchors, then align the bounded text around them with
explicit gaps for rendered math and non-rendered source syntax. Resolve each
target token independently within that alignment. A longer matching numeric
window elsewhere on the line must not invalidate a verified selected prose word.
Use neighboring anchors and reading-region order to distinguish repeated words;
the editor caret must not decide between otherwise indistinguishable passages.
Exclude non-rendered comments/directives as evidence, and retain ambiguity rather
than guessing. Alignment work must be bounded to avoid whole-document quadratic
comparisons.

Use those accepted links in both directions: preview selections resolve their
actual endpoints to source offsets, and source selections collect the linked PDF
DOM ranges. Extend the existing CSS Highlight pulse to accept multiple ranges
while preserving the existing one-range callers. Resolve element endpoints with
Range offset/bias semantics, rather than treating a missing span as a multiline
selection or expanding a short phrase to its paragraph.

Route Pages gestures separately from the generic Document handler so one handler
cannot clear another handler's mark. Invalidate links on source edits, tab/view
changes, render replacement and disposal; bind a finished index only to the
matching source/render generation. Preserve selection and the existing scroll
policy: source gestures do not scroll the preview; preview drags do not move it
under the pointer, and source reveal happens only after the gesture settles.

### Shared repairs and format adapters

Implement shared correctness repairs before the format-specific work:

1. Resolve DOM endpoints using the actual child offset and start/end bias.
   Trim browser-added whitespace across node boundaries before deciding whether
   a short selection is supported. Cover reversed selections, empty inline
   elements and endpoints exactly between siblings; do not replace the user's
   selection to simplify the mapping.
2. Collect all mapped ranges intersecting a source selection in document order.
   Do not return the narrowest matching block alone. Support multiple highlight
   ranges so an unmapped generated gap does not force painting intervening text.
   Keep atomic code/math behavior and existing block fallbacks explicit.
3. Invalidate correspondence snapshots as soon as the source changes, before
   the renderer's debounce/async work. Bind new maps to the exact source, tab,
   view and render generation that produced their DOM. Old visible content may
   stay on screen during rendering but must not paint offsets in a newer buffer.
4. Keep cached match identity consistent with the actual decoration. Rendering,
   editing, dismissal and tab/view changes clear both, or a same-range gesture
   must reapply the decoration instead of assuming it still exists. A new
   unmapped selection clears the old word mark for that gesture's surface.
5. Under reduced motion, register the resting highlight immediately and schedule
   no alternating pulse. Honor preference changes while a pulse is active.
   Escape clears correspondence marks even when the HTML guest owns focus,
   without collapsing the user's text selection.

Retain the format adapters:

- **Markdown:** preserve exact `marked` fragments, escaping/substitution offsets
  and atomic fragments. Repair endpoints/lifecycle and consume the shared
  range collection; do not downgrade exact positions to a word search.
- **AsciiDoc / Typst Document:** retain bounded per-node alignment and the
  documented block fallback. Correct selection across multiple blocks and test
  nested table/list ownership, repeated text and substitutions explicitly.
- **Typst Pages:** use the correspondence index described above.
- **HTML:** construct complete decoded-to-raw offset maps while preparing the
  preview, using the existing parser/browser's HTML decoding rules. Reuse the
  resulting table for both directions; handle all named/numeric entities,
  multi-codepoint expansions and CRLF, or reject an invalid boundary safely.
  Never interpret an unknown decoded entity as literal raw characters and then
  publish a plausible offset. Host and guest must enumerate the same nodes,
  excluding descendants owned by another stamp and the same skipped subtrees.

Extend the internal HTML bridge with bounded start/end node identities for
selections, a corresponding range-list paint/clear request from the host, and a
clear gesture for Escape. Keep source offsets exclusively in the host: the
guest receives only stamped text-node ids, decoded offsets and samples needed
to paint. Validate both endpoint samples, bounds, active-frame identity, token
and generation. Reject pending/old-frame selections against the current frame's
table. Script-mutated DOM still fails closed rather than triggering a source
search. No privileged command, weaker sandbox, external service or document
reserialization is involved.

Use the same pulse/resting behavior in the HTML guest through local Custom
Highlight styles, preserving selection and DOM node identity. Feature-detect the
Highlight API and keep block navigation as the existing fallback when unavailable.
The new ADR records the shared lifetime rules, mapping confidence (exact word,
atomic fragment, block fallback, unmapped) and scoped changes to the earlier
word-sync, HTML and Pages decisions.

Rejected alternatives:

- **Lower the match threshold or search for the selected word nearest the
  caret.** This hides misses by introducing incorrect repeated-word matches.
- **Normalize mathematical glyphs or fix one line-grouping tolerance only.**
  Neither fixes source/PDF token insertions, the missing reverse path, or DOM
  boundary endpoints. A tolerance in screen pixels also varies with fit/zoom.
- **Keep independent forward and reverse searches.** They can disagree about
  the occurrence and retain history-dependent behavior.
- **Call the resulting text alignment exact or state of the art.** Exact source
  provenance requires compiler data that this PDF interface does not return.
  Typst's [IDE jump APIs](https://docs.rs/typst-ide/latest/src/typst_ide/jump.rs.html)
  operate on the compiler world and rendered document, while
  [Tinymist's preview](https://myriad-dreamin.github.io/tinymist/feature/preview.html)
  provides compiler-integrated bidirectional navigation. Adopting such a backend
  is a separate architecture/dependency decision, beyond this bounded fix.

## Steps

- [x] Mark this plan approved after explicit approval, then in progress.
- [x] Pin the cross-format audit reproducers above in the existing suites,
      including the ordinary single-node controls and documented fallbacks.
- [x] Repair shared endpoint handling, range collection, snapshot invalidation,
      repeated-range repainting and reduced-motion/clear behavior.
- [x] Correct HTML entity offsets and text-node ownership; implement safe
      multi-node selection and reverse highlighting through the existing bridge.
- [x] Pin minimal regression cases for the observed Portuguese prose/math,
      two-column fragments, repeated words, span-boundary drags and hyphenation.
      Keep deterministic fixtures tracked: `docs/samples/*` is ignored.
- [x] Correct Pages text-region construction and DOM boundary resolution.
- [x] Implement bounded, target-aware correspondence indexing and its inverse;
      test offsets, ambiguity and generated/non-rendered text exclusion.
- [x] Wire both selection directions and multiple-range pulse painting, with
      render-generation invalidation and Pages event ownership.
- [x] Test repeated alternation in both columns, view/tab switching, render
      replacement, Escape and canvas unpaint/repaint; record deviations here.
- [x] Run the corresponding alternating-selection matrix for Markdown,
      AsciiDoc, Typst Document and HTML, including an edit and same-word
      reselection, guest focus and delayed/invalid selection reports.
- [x] Run the validation layers below and inspect rendered highlights.
- [x] Write the ADR, update user/test documentation and any newly discovered
      traps, tick completed steps and mark the plan done.
- [x] Bump the release version, validate the final binary, commit on master,
      push `v0.4.6`, and confirm the Release workflow was triggered.

## Files and modules

| File | Reason |
| --- | --- |
| `src/typst-page-map.ts` | Pure source/render token correspondence, bounded alignment, ambiguity and reverse lookup. |
| `src/typst-pdf.ts` | Page geometry, region/fragment index, DOM endpoints/ranges and index lifecycle. |
| `src/main.ts` | Pages source-to-preview route, selection-event ownership, snapshot checks and multiple-range highlight pulse. |
| `src/source-map.ts` | Shared endpoint/range mechanics, complete multi-block reverse lookups and preserved exact/atomic/block mapping semantics. |
| `src/html-source-map.ts` | Validated decoded/raw offset tables, multi-node endpoints and reverse lookups. |
| `src/html-preview.ts` | Construct offset tables; keep host/guest ownership consistent; validate frame/generation; route bidirectional paint/clear messages. |
| `src/html-bridge.js` | Endpoint reporting across inline nodes, matching text enumeration, local range highlights and Escape forwarding. |
| `src/editor.ts` | Only if needed to keep repeated-match state consistent with the actual decoration; no editor selection/focus changes beyond the existing behavior. |
| `scripts/typst-page-map-unit.mjs` | Deterministic alignment/offset/ambiguity regressions. |
| `scripts/typst-preview-test.mjs` | Real mouse selections, both directions, precise occurrence and visible geometry checks. |
| `scripts/block-map-unit.mjs`, `scripts/html-source-map-unit.mjs` | Pure mapping, entity, ownership/endpoint data and reverse-lookup regressions. |
| `scripts/word-sync-test.mjs`, `scripts/asciidoc-test.mjs`, `scripts/html-preview-test.mjs` | Cross-format endpoint, multi-block, stale-map, same-word, reduced-motion and guest-focus interaction tests; preserve HTML security coverage. |
| `samples/typst-pages.typ` | Small tracked examples reproducing the Portuguese exam's text fragmentation and math contexts without requiring the ignored exam file. |
| `samples/word-sync.md`, `samples/asciidoc-tour.adoc`, `samples/html-tour/index.html` | Minimal tracked entity/inline/nested/multi-paragraph fixtures where existing content cannot express the regression; avoid changing unrelated fixture content. |
| `README.md`, `docs/guide.md` | Accurate bidirectional behavior and remaining heuristic limits. |
| `AGENTS.md` | Updated test descriptions/counts and required trap records. Preserve concurrent unrelated edits. |
| `docs/adr/2026-10-22-selection-highlighting.md` | Record shared mapping lifetime, confidence, bidirectional HTML/Pages adapters and limits. |
| `docs/adr/2026-10-18-typst-pdf-pages.md`, `docs/adr/2026-10-18-word-level-sync.md`, `docs/adr/2026-10-20-html-word-sync.md` | Add only scoped supersession pointers where needed; preserve historical decisions and the block-fallback ADR. |
| `docs/plans/2026-10-22-typst-pages-word-sync.md` | Approval, execution checklist, deviations and validation record. |
| `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` | User-authorized 0.4.6 version bump; no dependency changes. |

No new script or test-runner suite is planned. Extend the existing fixture/suite.
If implementation needs another module, dependency or public contract change,
update this plan and obtain approval for that scope before proceeding.

### Implementation notes and deviations

- Pages now builds one immutable bidirectional token index at PDF render time;
  the obsolete caret-assisted mapper was removed. Both gesture directions use
  precisely the same accepted links, with no source search per selection.
- Literal markup is parsed with the already-installed Typst syntax parser.
  No dependency or Rust contract changed. PDF geometry stays in the adapter.
- Actual exam testing exposed column-origin drift from averaging paragraph
  indents. Column clusters retain their leftmost origin. Zero-width glyph items
  remain indexed, and Typst ActualText breaks without an extracted hyphen are
  joined only for otherwise unknown letter fragments with a literal vocabulary
  match and normal occurrence evidence.
- The shared cross-format DOM regressions are in `word-sync-test.mjs`, using
  temporary Markdown/AsciiDoc/Typst fixtures. Existing block-map unit coverage
  remains 12 checks; multi-block DOM behavior is measured in the UI suite rather
  than duplicated with DOM stubs. The AsciiDoc suite retains its 54 checks and
  documented substitution/formula fallback coverage.
- HTML regressions use a temporary fixture in its existing suite, preserving
  the original sandbox/assets/scripts-off checks. Preferences must be closed
  before real pointer gestures. Shared endpoint and HTML boundary probes use
  constructed Ranges where stated; alternation uses real source/guest clicks.
- `samples/typst-pages.typ` includes a small Portuguese inline-math paragraph.
  The local ignored exam adds one optional assertion covering fifty alternating
  gestures; the remaining 48 Pages checks do not depend on that local file.
- The final Windows distribution includes portable, NSIS and MSI outputs.
  Publication uses the existing `v*` release workflow and requires `v0.4.6`;
  no release-workflow change is needed. Linux build validation remains with CI.
- A real focused-editor Escape test exposed CodeMirror consuming the key before
  the old bubbling listener. Correspondence dismissal now runs in capture phase
  and consumes the key only for an active editor/preview correspondence. It
  preserves selection and leaves modal dialogs' Escape handlers available.
  This is covered in all five preview modes, including source-to-HTML paint.

## Risks and rollback

- False matches are worse than missing highlights. Assert exact source offsets
  and source slices for duplicates, comments, generated labels and two columns;
  verify every accepted target against surrounding anchors.
- Source edits can precede an asynchronous PDF render. Never apply a map from an
  older source snapshot to the current buffer. The same guard must cover the
  Markdown debounce, AsciiDoc/Typst async conversions and active HTML guest.
- Shared changes affect all formats. Stage the work as common correctness
  repairs, HTML parity and Pages indexing, preserving independently testable
  adapters and the earlier exact/atomic/block contracts.
- HTML own-script mutations, parser repairs and nested stamps can change text
  identity. Keep sample/ownership checks and active-frame validation; never
  widen IPC access or trust guest-supplied source coordinates.
- Headers, full-width blocks and superscripts can corrupt reading order. Test
  them explicitly and allow isolated/unmapped regions.
- CSS highlights across separate DOM ranges must not paint intervening text.
  Measure the ranges and visible rectangles, including both halves of a
  hyphenated word, without replacing the user's selection.
- Bound alignment and reuse the index for selections. Measure render/index time
  and selection latency on the exam and a longer multi-page fixture.
- Revert only this change's files/hunks to roll back. No persisted state or
  public API migration is involved. Preserve unrelated concurrent repository work.

## Tests and validation

Run cheapest relevant layers first:

1. `npm run build` and the expanded `npm run typst:map:unit`.
2. Expanded `npm run block:map:unit` and `npm run html:map:unit`; targeted
   Prettier and ESLint checks for changed source/scripts.
3. In fresh isolated app instances, `typst-preview`, `word-sync`, `asciidoc`,
   `html`, `syntax` and `smoke`
   through the existing harness, using a freshly built release and private
   settings. Keep test counts synchronized with documentation.
4. Reopen `docs/samples/prova-fisica.typ` locally and alternate at least 50
   preview/editor gestures across both columns, including `velocidade` beside
   the first formula, `com velocidade`, `partícula`, repeated words, short
   lines, hyphenated words and two-word drags. Check exact occurrences, actual
   CSS/CodeMirror highlight ranges, visible geometry, and unchanged selection.
5. Run the cross-format matrix below. Repeat at narrow/wide pane sizes, after
   editing/rerendering, after view/tab switches and after scrolling lazy canvases
   out and back. Inspect screenshots.
6. Record existing limitations separately from regressions. Full `npm test`
   and Rust tests are not planned for a frontend-only change unless evidence
   expands the affected surface. All cargo/Tauri invocations on this host use
   `scripts/with-msvc.cmd` or the existing harness wrapper.

Primary proof: preview double-clicking question 1's `velocidade` paints that
source occurrence, selecting that source occurrence paints the PDF word, and
alternating these with two-word selections in either column continues to work.

Cross-format matrix, measured in both directions where applicable:

| Scenario | Formats / required measurement |
| --- | --- |
| Single words, repeated words and short phrases | All five preview modes; exact source offsets and visible ranges, with preserved user selection. |
| Inline and element boundaries | All; forward/backward drags and constructed boundary Ranges select only the intended text, including browser-added trailing whitespace. |
| Selection spanning paragraphs, table cells or list items | Markdown, AsciiDoc, Typst Document, HTML; every verified selected region is painted, without unrelated gaps. Pages tests use established reading-region boundaries. |
| Entities, CRLF, accents, combining characters and supplementary-plane characters | HTML exact decoded/raw mappings; Markdown positive controls; all shared word-boundary/UTF-16 cases. Include `&eacute;`, `&copy;`, a multi-codepoint named entity and numeric references. |
| Nested ownership | HTML nested stamped elements and skipped subtrees; AsciiDoc/Typst Document nested blocks. Check host/guest identities and exact occurrences. |
| Render debounce and async replacement | Edit before the old selection, select during the pending render, then retry on the new DOM. A stale map paints nothing; the current map paints the current word. |
| Same word after edit or tab/view change | All; append text after the target, allow rerender, reselect identical source offsets and require a real decoration. |
| Invalid/generated/script-mutated target | All relevant adapters; documented block fallback or no new word mark, and no stale mark from an unrelated preceding selection. HTML checks old/pending-frame messages and keeps the existing sandbox/IPC tests. |
| Escape and reduced motion | Host and focused HTML guest; all correspondence paint clears, selection survives, and reduced motion uses a stable resting highlight with no pulse timer. |
| Atomic code/math/images and generated blocks | Preserve the current declared semantics and test coverage; do not claim an exact text mapping for a non-text target. |
| Alternation and cost | At least 20 preview/source gesture pairs per mode, plus the 50 Pages gestures above; exact occurrence stays stable, no scroll feedback, bounded selection latency and no index rebuild per gesture. |

Correctness repairs to source/HTML mappings need no Rust change. Run Rust layers
only if implementation evidence requires touching a Rust module or contract;
such a change first requires updating the approved scope.

### Validation record (2026-10-22)

- `npm run dist`: Windows portable executable, NSIS installer and MSI built and
  staged successfully as version 0.4.6. No dependency changes.
- `npm run lint`, `npm run knip`, targeted Prettier checks, `git diff --check`
  and `npm run check:version -- v0.4.6`: passed.
- Fresh isolated release sweep through `test-all.mjs --no-build --keep`:

  | Layer | Result |
  | --- | --- |
  | Rust | 97 passed; two expected download tests ignored |
  | Typst page map | 21/21 |
  | HTML source map | 38/38 |
  | Block source map | 12/12 |
  | Smoke | 107/107 |
  | Shared word sync | 58/58 |
  | AsciiDoc | 54/54 |
  | Typst preview | 49/49, including the local physics exam |
  | Math | 12/12 |
  | Syntax palettes | 10/10 |
  | HTML guest | 60/60 |
  | Document tabs | 106/106 |
  | Favorites | 56/56 |
  | Native shutdown | 4/4 |

- Twenty alternating source/preview pairs pass in each mode. The exam adds
  fifty alternating real gestures across both columns, including `velocidade`
  beside question 1's formula. Pages phrase mapping, native selection,
  view/tab restoration, stale render rejection, same-offset reselection,
  narrow/wide fit, lazy canvas repaint, Escape and reduced motion pass.
- Native guest and host CSS Highlight/CodeMirror ranges were inspected along
  with a captured Pages screenshot. Pages uses separate word ranges and leaves
  the rest of the formula/column unpainted. Snapshot probes intentionally
  construct browser Ranges; alternation and focused Escape use CDP input.
- A final Escape event-flow refinement uses `preventDefault` without stopping
  propagation: CodeMirror honors default prevention, while PDF cancellation
  listeners still receive Escape. The final packages and focused word-sync,
  Pages and HTML suites passed after that refinement: 58/58, 49/49 and 60/60.
  The final normal executable's SHA-256 starts `bd3d4ca93531`; both installers
  and the portable executable were rebuilt and staged with it.
- Full unrelated UI/export/paste layers and Linux builds were not run locally.
  The release workflow builds Windows and Linux; this task stops after verifying
  its trigger, as requested, rather than waiting for build artifacts.

### Publication record

- Implementation/release commit: `b5663a3d17489ee019d6f944b5f0eae13cbbea4e`.
- Pushed master and annotated tag `v0.4.6` to `bgeneto/MDraft`.
- Confirmed the push-triggered **Release** workflow for that exact commit/tag:
  [run 39729847359](https://github.com/bgeneto/MDraft/actions/runs/39729847359),
  observed `in_progress`. Build/artifact completion was not monitored, as the
  user explicitly requested.
- This documentation follow-up records the completed publication on master;
  the release tag remains on the tested implementation commit.

## Acceptance criteria

- The demonstrated `velocidade`/`com velocidade` failures paint exactly their
  corresponding source words; numeric matches cannot displace prose mapping.
- Selecting verified literal prose in the editor highlights the corresponding
  Pages text, using the existing blink/resting appearance.
- Repeated words resolve to the intended occurrence in the correct column;
  results do not change with unrelated editor caret positions or gesture order.
- Span boundaries, ligatures, accents and hyphenation preserve correct source
  offsets and select only the intended PDF text.
- Short multiline phrases map their verified endpoints without expanding to an
  unrelated paragraph or column.
- Selection/copy and scroll behavior remain stable; stale indices/timers never
  repaint after an edit, Escape, disposal or view/tab change.
- Unanchored generated content stays unpainted; tests identify any documented
  anchored-block fallback separately, do not count it as an exact word match,
  and never claim exact compiler provenance.
- Existing Document and Markdown word sync checks pass alongside the new Pages
  checks. HTML and AsciiDoc suites also pass with their new cases, preserving
  the guest's sandbox and fail-closed behavior.
- Element-boundary `bravo` maps only to `bravo` in the three audited host
  previews; a two-paragraph source selection paints all its verified words.
- Selecting `afterword` after an HTML named entity paints source `afterword`,
  never a substring of entity markup. Nested stamps and inline boundaries do
  not silently discard otherwise valid text selections.
- Source-to-HTML highlighting works through the validated guest protocol;
  selecting the same word after editing still paints it, and Escape while the
  guest has focus clears the mark.
- Selecting stale visible `alpha` after a prefix edit never paints unrelated
  source `audit`; it waits for a current correspondence snapshot.
- Reduced motion stops preview pulses as well as source CSS animations.
- The plan and ADR retain the final validation record.

## Open questions

- **Compiler-backed provenance:** recommended default is the bounded PDF.js
  repair above. Exact source-span navigation, generated content origins and
  arbitrary macro expansion require a separately approved compiler integration.
- **Generated labels and formula selections:** default is to leave unresolved
  origins unpainted rather than selecting a variable definition or macro body
  based on text coincidence. Atomic formula sync is a follow-up.
- **Ambiguity reporting:** default is internal diagnostic results available to
  tests, without user-facing toasts for normal selections. Any permanent UI
  for unmatched content would need an explicit product decision.
- **HTML parity:** proposed scope includes source-to-guest highlighting and
  valid multi-node phrases. This deliberately supersedes the earlier HTML ADR's
  one-direction/one-node limit while preserving the sandbox and host-side
  source-offset ownership.
- **Existing block fallback:** preserve the documented AsciiDoc/Typst Document
  containing-block fallback for substitutions/formulas. Internal confidence and
  assertions identify it as block correspondence, never as a verified word.
