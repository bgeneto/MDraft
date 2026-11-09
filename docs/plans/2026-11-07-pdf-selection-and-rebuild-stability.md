# Make PDF selection precise and keep the reader's place

**Status:** in progress
**Date:** 2026-11-07
**ADR:** `../adr/2026-11-07-pdf-correspondence-and-lifetime.md`

**Approval:** explicitly approved by the user on 2026-11-07.

**Progress:** The shared PDF viewer now uses cancellable worker-built text links
for Typst and LaTeX. LaTeX uses guarded syntax-service prose, literal words from
standard `verbatim`/`verbatim*`, and unique safe inline/display equation tokens;
MDraft no longer requests or consumes SyncTeX. Both selection directions,
file-aware scroll anchors, included-file handoff and staged PDF replacement are
connected. The approved math extension also handles superscript/subscript
tokens PDF.js emits on an adjacent line when the match is unique in the same
reading region.
Focused Windows UI validation on the current build passed for LaTeX (69/69), Typst
(70/70), Markdown/AsciiDoc/Typst Document word selection (105/105), HTML
selection (60/60), scroll correspondence across all five preview adapters
(62/62), the multi-file LaTeX project (16/16), and preview zoom (24/24).

The focused Windows real-app LaTeX preview passed 59/59 checks. On the 6,515-byte
five-page Reference, map-build wall time was 56.3 ms for 648 prose anchors, the
longest UI binding batch was 0.4 ms, and typing latency during the live preview
was p50 17.8 ms / p95 18.1 ms / max 18.4 ms. The rebuild test grew the PDF from
its existing last page while following the tail and confirmed no page-one flash;
a failed compile retained the prior PDF and viewport. These are one Windows
fixture run, not the full performance comparison. A separate Node worker probe
used a 1,200,031-byte synthetic LaTeX source and 10,000 PDF text lines: the map
completed in 669.7 ms for 139,992 anchors; sampled process RSS peaked at
378.8 MiB, 327 MiB above its 51.7 MiB baseline, and worker heap after the build
was 209 MiB (16 MiB before). The 10 ms RSS sampler is only an approximate
process peak; this is a synthetic Node worker probe, not a WebView measurement
or representative real project. The shared matcher was then changed to avoid
temporary vocabulary/signature arrays and inverse-match position lists; a
single before/after probe showed lower retained worker heap and sampled RSS but
higher wall time, so it does not establish a net performance gain. The later WebView comparison and its measurement limits are recorded below; a
controlled old-route comparison and a large real-world project remain
uncollected, so this plan stays in progress.

## Context and goal

In Split view, selecting `draws` in the source of the LaTeX Reference can leave a
whole PDF line blinking instead of highlighting that word. Selecting `A heading
is a command` in the PDF does not highlight the phrase in the source. The user
has observed both, and wants the interaction to resemble the other formats,
especially Typst Pages. The user also reports that after typing near the end of
a Typst or LaTeX document, rebuilding the PDF can jump the preview to page one,
away from the passage being edited. Map construction must remain responsive even
for large documents and while the user continues typing.

The current code explains the difference:

| Format | Selection correspondence today |
| --- | --- |
| Markdown | Renderer-provided source fragments and DOM ranges. |
| AsciiDoc and Typst Document | Text alignment within source blocks, with documented block fallbacks. |
| HTML | Validated source/guest text ranges over the sandbox bridge. |
| Typst Pages | A PDF.js text layer plus a per-render index matching literal Typst source words to PDF words in both directions. |
| LaTeX PDF | A single-click SyncTeX file/line lookup and whole-region paint. Neither selection direction uses a word map. |

Typst's precision is a bounded text-matching heuristic, not a compiler-provided
word-level source map. It excludes non-prose and refuses ambiguous occurrences.
The viewer already builds PDF text lines, handles selection ranges and can paint
multiple PDF text ranges; it is shared by both languages. But when the LaTeX
click callback is present, `src/typst-pdf.ts` explicitly skips building the Typst
map; `renderLatexPreview` passes a no-op selection callback; and
`syncPreviewFromSource` has no LaTeX selection branch. The line-shaped paint in
the screenshot is consistent with the separate source-click path: it calls
`latexSyncCursor` and paints SyncTeX regions, including on the first click of a
double-click. This timing explanation is inferred from the code, not a new UI
reproduction.

The two PDF rebuild paths also differ. Typst captures a source-based viewport
bookmark before compilation and restores it only when that bookmark exists,
survives the source edit and retains scroll ownership. The ownership epoch also
changes on keydown. If no usable bookmark survives, there is no explicit
geometry fallback. LaTeX replaces its PDF viewer without the equivalent bookmark
restoration. Both paths clear the old PDF DOM while building its replacement,
which can clamp the pane's scroll position. These are code-level explanations
to investigate, not a claim that the reported jump has already been reproduced.

The performance paths differ as well. Markdown and AsciiDoc defer DOM map
binding until after paint and use cancellable, approximately 8 ms batches (see
`bindPreviewWords` and `runMapSteps`). In contrast, the current PDF viewer builds
each page's text layer and line index, then synchronously constructs the Typst
word index before it finishes `render` and starts observing canvases. A lazy
import or one `requestIdleCallback` would not make that constructor nonblocking.
Measure these PDF stages in the real app before and after the change.

The current SDK lookup supplies file/line and page regions, not verified source
word offsets. SyncTeX can have column information in principle, but its own
[reference parser](https://github.com/jlaurens/synctex/blob/main/synctex_parser.h)
documents that column support may fall back to a whole line. In this repository,
the public SDK result is tried first and a private worker read is retained when
needed. Existing notes report that one fallback mapping can have no enclosing
boxes and zero-width nodes, so a rectangle alone is not proof of word ownership.

### SyncTeX removal: investigation on 2026-11-07

The user asked whether SyncTeX should be removed entirely rather than kept as
supporting evidence. MDraft currently injects `\synctex=1`, reads and parses the
result and rejects an otherwise successful PDF if no SyncTeX is available.
LaTeX clicks and both directions of Sync Scroll currently depend on that mapping;
removal must replace all three routes, not just the word-selection handler.

The generated `.synctex.gz` is read from the LuaLaTeX worker's in-memory virtual
filesystem. In the inspected MDraft path it is not written alongside the user's
document; the disk cache is for TeX engine and mirror assets. It still costs
engine work, worker memory, transfer, decompression, parsing and retained mapping
objects. On the pinned LuaLaTeX WASM engine with the installed local cache and
no network, a Node worker-host probe compiled each fixture in alternating
`on/off/off/on/on/off` order, using a fresh compiler each time. Times are medians
of three per mode, excluding engine initialization; the final column measures
the additional worker read and parse after an enabled compile.

| Fixture | SyncTeX on | SyncTeX off | On: gzip / expanded | On: read + parse |
| --- | --- | --- | --- | --- |
| LaTeX Reference, 6,515 source bytes, 5 pages | 3,361 ms | 3,350 ms | 20,390 / 76,240 bytes | 5 ms |
| Synthetic prose, 47,468 source bytes, 16 pages | 916 ms | 908 ms | 77,353 / 532,538 bytes | 23 ms |

The 16-page PDF was 22,678 bytes and its parsed SyncTeX held 24,098 nodes; the
compressed SyncTeX was about 3.4 times the PDF size. This was generated from
180 short repeated prose paragraphs in a package-free `article` document.
The few samples show a small compile-time difference on these fixtures, not a
general overhead bound. They are Node-host measurements of the same engine,
not MDraft WebView timings, and do not measure peak process memory. Page counts
and PDF byte lengths matched on and off; byte identity or visual equivalence was
not established. Measure real-app latency, peak memory and actual PDF content
before deciding the impact on larger projects.

In a second offline probe, LuaLaTeX compiled the actual Reference **without**
SyncTeX. PDF.js extracted the text; a temporary adapter combining the existing
Typst matcher with the pinned `wasmtex/syntax` service's `visibleProse` ranges
mapped `draws` and `A heading is a command` to their exact Reference offsets.
This proves feasibility for those examples, not real mouse interaction, general
coverage or visual accuracy: the probe used simplified PDF line grouping.

The same probe produced a real false match: source inside `\ifnum0=1 ... \fi`
was not typeset, while a macro printed identical words; `visibleProse` included
the false branch and the matcher mapped the PDF words into it. The syntax
service also marks a simple macro expansion as generated and non-editable. A
professional syntax parser is valuable, but it is not the executing TeX engine:
expansion, conditionals, repeated calls, generated text and output reordering
can make a PDF occurrence's source ambiguous. Guard unexecuted/unknown branches
and macro output, verify project-wide uniqueness, and test against real PDFs.

The already-installed WasmTex package exports `wasmtex/syntax`; it reports
UTF-16 prose spans, blocks, includes and bounded macro information. One isolated
Node-worker parse of 1,258,427 bytes of synthetic prose took 54 ms and increased
the worker's reported JS heap by about 7.3 MB; these are single-run indications,
not WebView or peak-memory benchmarks. A virtual-entry Rolldown probe measured
121,973 bytes raw / 33,129 gzip for `createLatexSyntaxService` alone; bundling it
with `WasmTexCompiler` increased that combined single bundle by 46,752 raw /
13,035 gzip relative to the compiler-only probe. Actual Vite chunking and staged
installer deltas remain unmeasured. The service's `upsert` retokenizes the
document, so it must not be called as a monolithic task on the UI thread.

Simply removing MDraft's prefix produced no SyncTeX for the tested ordinary
documents. An explicit `\synctex=1` **inside** a source file still produced a
511-byte virtual SyncTeX file, even when a preceding `\synctex=0` was injected.
The current SDK wrapper does not expose a SyncTeX command-line option in its
documented compiler options. Thus the safe, immediately supported target is no
MDraft-generated or consumed SyncTeX by default; do not rewrite authored TeX or
claim a strict engine-level ban for documents that explicitly enable it. Check
whether the pinned engine safely exposes `-synctex=0` before proposing stronger
enforcement; changing pinned engine assets is outside this plan and needs a
separate approved scope.

Feasibility was checked without editing product code: in a small, synthetic
in-memory example, passing LaTeX through `createTypstPageMap` mapped ordinary
prose such as `draws`, but also treated words inside a `\newcommand` definition
as literal prose. This was a parser/matcher probe, not a compiled-PDF UI test.
The existing Typst matcher is useful; the Typst parser is not a LaTeX parser.

Baseline on Node 24: `typst:map:unit` 35/35, `latex:sync:unit` 14/14,
`latex:correspondence:unit` 33/33, `latex:sdk:unit` 19/19, `sync:unit` 29/29,
`preview:worker:unit` 18/18 and `preview:unit` 170/170 pass. The LaTeX preview
test checks that some SyncTeX region is painted; it does not assert the selected
word, its exact occurrence or selection correspondence in either direction. No
real-app UI or WebView performance baseline was run for this draft.

## Scope and non-scope

In scope:

- Source double-click/selection to the corresponding PDF word or short phrase,
  and PDF double-click/selection to the matching source word or phrase, with the
  same pulse, resting mark, reduced-motion and Escape behaviour as Typst Pages.
- Reliable literal prose in the main file and referenced `.tex` files, including
  unsaved open buffers, headings, simple nested formatting, lists, Unicode,
  line-wrapped words, and prose adjacent to math. Preserve distinct occurrences
  in repeated text, multiple columns and multiple pages.
- Exact literal words inside standard `verbatim` and `verbatim*` environments,
  with both-direction highlighting against the PDF text layer. For inline and
  displayed equations, map the whole source expression as one atomic region when
  its safe literal math tokens match a unique PDF text-layer occurrence. A numeric
  superscript/subscript may be emitted on an adjacent PDF text line; accept it
  only when that token is unique in the same reading region. Refuse ambiguous,
  macro-driven, transformed, or otherwise unverifiable math.
- Remove MDraft's forced SyncTeX generation, parsing and requirement; replace
  single-click navigation and both directions of Sync Scroll with the same
  accepted in-memory PDF/source correspondences used for word selection.
  Preserve project-root handling, copying and selected text. An unsupported
  target has no guessed match or misleading broad rectangle.
- Preserve the visible reading position across successful PDF recompiles in
  **both** Typst Pages and LaTeX, including typing at the end and adding or
  removing a page. Follow the text being edited when the user is already tracking
  it; respect deliberate scrolling and disabled Sync Scroll.
- Make the PDF word/scroll-map pipeline for both formats lazy, cancellable and
  bounded in batches or a worker, so it does not stall typing or prevent the PDF
  from becoming usable. Preserve Typst's matching results and existing scroll
  semantics apart from the requested rebuild-position fix.
- Selection lifetime, view/tab changes, project revisions, delayed work, test
  coverage, documentation and a durable architecture decision.

Out of scope:

- Full TeX interpretation or expansion, arbitrary macros, conditionals,
  generated bibliography/citation/numbering text, graphics, and arbitrary
  verbatim-like environments outside standard `verbatim`/`verbatim*`. Math support is limited to unique equations whose
  safe literal token sequence can be verified against the PDF text layer; all
  unsupported or uncertain content has no word mark. With SyncTeX removed,
  such content may also have no click or scroll correspondence; only a verified
  nearby prose anchor or page-local viewport position may be used where
  appropriate.
- Exact correspondence for selections spanning different source files or
  unrelated PDF reading regions. The existing 120-character PDF-side selection
  limit applies; longer PDF selections remain selectable and copyable without a
  word mark.
- Changes to the rendered PDF, saved source, compiler, SyncTeX SDK, Tauri
  commands, settings schema, Markdown/AsciiDoc/HTML semantics, or network
  activity. No new dependency is proposed. A dependency or expanded TeX support
  needs a separately measured plan update and approval.
- Forcing SyncTeX off against an explicit `\synctex=1` in the user's own TeX by
  changing the pinned engine binary or rewriting the document. MDraft will not
  request, read or use it; a stronger engine-level ban needs a separate decision
  if the current SDK cannot expose it safely.

## Approach and rejected alternatives

Keep one PDF viewer and one accepted correspondence index per immutable LaTeX
compile snapshot. Extract the reusable word normalization, bounded contextual
matching and bidirectional lookup from the Typst Pages index behind a
source-neutral interface; keep Typst's existing parser adapter and observable
matching behaviour intact, while making its map build nonblocking. Use the
already-installed `wasmtex/syntax` service as the leading LaTeX parser
candidate, with additional guards for conditionals and other unexecuted or
uncertain regions. Feed its eligible literal words, project-relative file
identity and UTF-16 source offsets into the matcher, and use PDF.js's existing
text lines and DOM ranges for paint and geometry.

The intended implementation is **SyncTeX-free by default**: remove the injected
primitive, the worker read, parser and missing-SyncTeX failure from MDraft; use
the verified text anchors for selection, single-click navigation, scrolling and
rebuild restoration. Do not silently retain SyncTeX as a hidden fallback. First
prove the resulting interaction on the real fixtures; if safe coverage cannot
meet the acceptance criteria, document the measured gap and return to the user
with alternatives rather than shipping a wrong correspondence or widening this
plan. Retain only the compiler's other normal auxiliary files needed for
references and bibliography; removing SyncTeX is not permission to remove them.

### Source and PDF ownership

1. Capture the actual `.tex` inputs from `LatexProjectSnapshot`, including open
   buffer overlays, without modifying them to enable SyncTeX.
   Build the map from those exact inputs, not a fresh filesystem read. Preserve
   file identity and translate BOM/CRLF and Unicode offsets to the editor's
   representation. The snapshot's `generation` describes the referenced file
   set, not file contents, so it is insufficient by itself to prove freshness.
2. Use `wasmtex/syntax`'s source-preserving spans as **candidates**, not as proof
   that the engine rendered them. Scan only text whose role can be established:
   body prose and heading text,
   including arguments of a small explicit set of nested, text-preserving
   formatting commands. Keep offsets into the original source. Exclude preamble,
   comments, math, verbatim, definitions, path/key/option arguments and unknown
   or conditional constructs rather than treating all brace contents as prose.
   These are the prose candidates. Add separate literal candidates for standard
   `verbatim`/`verbatim*` bodies and for math accepted by the restricted math
   token reader; those paths must not weaken the prose guards or expand macros.
   Handle escaped delimiters and `%`, multiline groups and nested braces; if a
   command, environment, category-code change or redefinition makes a region's
   meaning uncertain, exclude that region. In particular, guard `\ifnum` and
   other unknown conditionals independently of the syntax service: the probe
   above shows that its `visibleProse` can include a false branch. Reuse existing
   literal-region helpers only where their semantics actually fit: the reference
   validator's masking also masks formatting arguments this feature needs.
3. Build candidate links from distinctive neighbouring literal words in the
   same PDF reading region and source context. Preserve the existing Typst
   normalization for ligatures, accents, soft hyphens and verified line-break
   fragments. Compare candidates across **all** eligible project files before
   accepting ownership; two per-file maps must not independently claim the same
   PDF occurrence. Accept only unique, independently supported literal-text
   alignments, using surrounding prose and reading-region geometry; a conflict or
   unresolved duplicate stays unmapped. Repeated inclusion of one source passage
   and identical generated text are ambiguity cases, not a reason to guess. The
   index is heuristic, so do not call its results compiler-exact.
4. Both directions consume the same accepted links. Source selections collect
   the matching PDF DOM ranges. PDF selections resolve their endpoints and all
   selected word tokens to ordered, consistent links in one file; reject
   unverified intervening words, reversed ownership, cross-file selections and
   unrelated reading regions. For a phrase crossing formatting syntax, paint the
   verified source segments rather than swallowing commands between them. Extend
   the editor's current single-range decoration to a bounded range list while
   preserving its existing single-range callers. Keep the user's real selection
   separate from correspondence decoration.

### Gestures and lifetime

- Wire LaTeX's PDF selection callback and source-selection branch to the index.
  Use the existing four-beat PDF pulse, editor decoration, resting mark and
  reduced-motion behaviour. Cancel a pending coarse source-click blink when a
  double-click/selection supersedes it, so the first click cannot leave a
  whole-line rectangle beside a word selection. An unmapped selection clears
  stale word and region marks; it does not silently fall back to whole-line
  paint. For a single click on verified prose, derive a paragraph/line blink and
  source navigation from accepted word anchors. A click on an unlinked formula,
  figure or generated region stays unmapped rather than invoking SyncTeX or
  jumping to a guessed line.
  Follow the existing Custom Highlight feature detection; if a webview lacks it,
  preserve selection and copy and report the limitation rather than painting an
  unrelated rectangle.
- Key the index and pending work to the PDF instance, render token, project root,
  actual source contents/revisions and active selection. Invalidate immediately
  on edit, compile cancellation, reload, root change, tab close, view change,
  disposal or a conflicting project revision, before any render debounce.
  Reconcile a still-current selection when a deferred map becomes ready, unless
  Escape or a newer gesture dismissed it. Never replay stale DOM ranges or let a
  late file-open operation steal focus or switch a newer tab.
- PDF selection of a word belonging to an included file must open or activate the
  correct existing/loaded source tab without discarding unsaved edits, and keep
  the main compilation root. Today `openPath`/`displayDoc` invalidate the viewer,
  schedule a render and focus the editor: merely adding a callback would lose
  the PDF selection. Add a scoped navigation handoff that retains the same PDF
  DOM and selection only while the root, compile snapshot and target contents
  remain valid; revalidate after asynchronous reads and before activation/paint.
  For a closed or externally changed file, compare the loaded editor text with
  the compiled snapshot before applying offsets. If validity cannot be proved,
  discard the handoff and wait for a fresh compile instead of painting old text.
  Ordinary tab switches and real edits retain their existing invalidation rules.
- Build the word index once per current PDF, only when Split needs it. A pending
  map must not block visible pages, text selection, copying, typing or viewport
  restoration; Typst's current dependency of scroll anchors on its word index
  needs a geometry fallback until the index is ready. Reconcile a current
  selection after publication, and never replace a newer scroll or Escape.
  Track PDF readiness separately from index readiness: entering Split for an
  already-current PDF schedules the missing index without recompiling, and the
  current map is never advertised as ready before publication.

### SyncTeX-free navigation and scrolling

Adapt the existing Typst Pages `ScrollIndex`, reading-region/column selection and
`scrollCorrection` path to accept LaTeX file-aware anchors. A source scroll uses
anchors in the active source file; a preview scroll must not switch source tabs
or apply another file's offsets. The map may offer exact word ranges within
verified prose and paragraph-level click feedback; page-local restoration is
only a viewport fallback and is not represented as a text match. With no anchors
or while a map is building, retain the user's position instead of searching the
whole source or inventing a correspondence. Do not use SyncTeX as the fallback.

This removes a current capability in uncertain regions: SyncTeX can sometimes
identify a line for math, images or generated material where a prose-only index
cannot. Measure those cases against the current app and state the loss clearly;
prefer safe no-match behaviour, matching Typst Pages' existing limits, to
pretending that a word was identified. If the loss is unacceptable for the
approved fixture matrix, improve evidence or return with alternatives before
claiming completion.

### PDF viewport across recompiles

Before replacing a still-current PDF, capture the **latest** old-view position,
not just the position at compile start. The old PDF remains scrollable and
copyable during a compile even though stale correspondence is disabled. Keep a
source-content anchor with its
screen offset when one is reliable, plus a page number, in-page position,
horizontal position and whether the user was following the edited tail. Use a
page-coordinate fallback even when the word/scroll map is absent or still
building. The state belongs to the document/root, old PDF and scroll-input
generation; an older compile or a different tab cannot apply it.

Keep the old layout or an equivalent correctly sized placeholder until the new
page shells have measurable geometry, then restore before presenting the
replacement; avoid a visible intermediate jump to page one and avoid a late
fit/resize frame overwriting the restore. For a matching current source anchor,
preserve its screen position using the accepted source/PDF word links and map
unchanged offsets across edits. When an anchor is unavailable or was
edited away, restore the same page and in-page position, clamped to the new page
count and scroll range. A document-wide fraction is only a last-resort fallback,
not evidence of text correspondence. Preserve horizontal scroll and zoom.

With Sync Scroll enabled, when the user was already following the passage being
typed near the end, keep the edited passage visible after the rebuild, including
when it moves onto a newly created last page. Determine this from the current
editor position and the previous viewport/available correspondence, not merely
from the caret being somewhere near the end of the source. If the user scrolls
the preview during compilation, their latest deliberate scroll owns the view;
typing keys must not accidentally cancel restoration without a replacement. With
Sync Scroll disabled, preserve the user's preview reading position instead of
following the editor. Preserve tab-restoration precedence and prevent restored
layout scrolls from feeding back into the other pane. Any deferred semantic
refinement must recheck ownership and must not oscillate or move a view the user
has since scrolled. LaTeX currently routes scrolling through a separate
SyncTeX-based path with its own suppression timers; replace that path with the
shared ownership-aware PDF anchor adapter so competing writers cannot undo it.

### Responsive map and page work

Apply the existing Markdown/AsciiDoc discipline to **both** PDF languages. Paint
and make the current PDF usable first; run the synchronous `wasmtex/syntax`
service and pure matching in a module worker, or use an equally responsive
implementation supported by measurements. Terminate a busy worker on superseding
edits because a cancellation message cannot interrupt a synchronous parser call.
Bind DOM ranges and geometry on the main thread in bounded batches, using
the existing approximately 8 ms yield pattern as a target. Idle scheduling alone
is not enough: include page-line grouping, normalization, sorting, source-offset
translation, DOM binding and scroll-anchor creation when measuring task length,
and remove any unbounded quadratic or long single-step work those measurements
expose. Do not transfer live DOM to a worker or weaken PDF selection and page
lifecycle behaviour.

Cancel obsolete work immediately on edits, renders, tab/view switches and
disposal; publish only a complete index for the current snapshot. Avoid building
word maps in Source-only or Preview-only modes, keep only bounded snapshot data,
and do not rebuild per selection. Ensure the latest uncancelled build eventually
completes after typing becomes quiet. If a worker cannot start, use a genuinely
bounded, cancellable fallback; never call the monolithic syntax-service `upsert`
on the UI thread for a large file. If safe fallback parsing is unavailable, keep
the PDF usable without a word map. If an explicit work or memory limit is hit,
keep the PDF, text selection, copy, viewport position and coarse navigation
usable while omitting uncertain word marks. Preserve source- and preview-scroll
behaviour while Typst's index is pending, and only refine with current evidence.

Rejected alternatives:

- **Use SyncTeX rectangles as word highlights.** The lookup can identify a line
  or box, but does not establish a selected word's geometry or source offsets.
- **Keep generating SyncTeX as a supporting or hidden fallback.** It can add
  evidence for some generated or non-prose material, but adds a second mapping,
  its compilation/parse/memory cost and the private worker protocol. The user
  prefers removing it; the measured tradeoff and missing cases must be reported
  before proposing any return to it.
- **Turn on `createTypstPageMap` for LaTeX unchanged.** Its Typst grammar reads
  LaTeX syntax as text and can claim definitions and other non-rendered material.
- **Search for the selected string or the occurrence nearest the caret.** Repeated
  words, identical chapters, generated text and multi-column reading order make
  those matches unreliable and history-dependent.
- **Build another PDF viewer or add a new parser dependency now.** The existing
  viewer already has the text layer, ranges, pulse and page lifecycle. A new
  dependency would require the repository's bundle, typing, installer and
  replacement measurements before it could be approved.
- **Automatically widen an unsupported selection to a SyncTeX line.** That
  produces the misleading highlight seen in the report. A separate single click
  may use only an independently linked prose paragraph.
- **Restore only a raw global scroll percentage, or always force the last page.**
  Page breaks, figures, columns and manual scrolling make both choices lose the
  passage the reader was viewing. Use a source anchor where valid and page-local
  geometry as a fallback; follow the tail only when that was the user's context.
- **Defer one monolithic map constructor to idle time.** The constructor still
  blocks input once it starts. Bound every expensive stage or move its pure work
  to a worker, and prove input responsiveness during the actual build.

## Steps

Implementation adjustment: a synthetic PDF with 8,000 distinct simple equations
took about 1.5 seconds to map in a Node worker probe, and doubling from 4,000
equations made the work about four times as long. Index candidate tokens and
equation overlaps so math-heavy documents do not repeatedly scan every line or
every accepted prose anchor. Preserve the existing uniqueness and fail-closed
rules, and record before/after measurements and correspondence regressions.

Validation adjustment: an app-free `test-all` run closed an unrelated active
staged test window because its cleanup matched every `mdraft-test-*` process.
Restrict cleanup to this run's staged executable and refuse to start a UI run
while another harness or staged instance is active. Verify ownership with a
small app-free unit test before continuing the UI matrix.

The separate UI harness remains active under another session's shared test
identifier. To continue without interrupting it, use a temporary Tauri build
whose config overrides only the application identifier, with its own profile,
engine junction, WebView folder and staged executable. This test-only build
does not change the repository's product identifier or installed application.

- [x] Establish a real-app baseline on the saved LaTeX Reference: `draws` in
      source and `A heading is a command` in the PDF, plus a collapsed click;
      record actual selected text, marks and timing. Add a regression fixture and
      a failing test that proves whole-line paint cannot satisfy word selection.
- [ ] Repeat the SyncTeX-on/off comparison in MDraft's WebView on small, large,
      multi-file and graphics/math-heavy projects; record compile time, output
      size, worker/host peak memory, map construction, navigation coverage and
      whether non-prose clicks work before removing the old route.
- [x] Reproduce both PDF rebuild jumps with real typing at the last page, including
      growth onto another page; capture scroll position during each render frame.
- [x] Extract and test the source-neutral matcher without changing the Typst
      adapter's existing output or ambiguity policy.
- [x] Make PDF page/index work for Typst and LaTeX deferred, cancellable and
      time-sliced or worker-backed; retain usable PDF pages and selection while
      the current map is pending.
- [x] Preserve the latest PDF viewport through successful recompilation in both
      languages, with source anchors, page-local fallback, tail following, scroll
      ownership and fit/zoom handling as described above.
- [x] Integrate the existing syntax service in a cancellable worker, add the
      conditional/unsupported-region guards and immutable project input snapshot,
      and build the global file-aware bidirectional index. Reproduce the real-PDF
      false-conditional/macro collision as a negative test.
- [x] Add literal candidates from standard `verbatim`/`verbatim*` bodies and
      atomically map only unique, safely tokenized math regions. Cover the user's
      `\section{name}` example, inline math, displayed math, and unsupported or
      repeated equations in both unit and real-PDF tests.
- [x] Remove the quadratic equation and overlap scans, with regression coverage
      and a repeatable math-heavy performance measurement.
- [x] Make test-harness cleanup respect the owning staged executable and prevent
      concurrent UI harnesses from taking over each other's test state.
- [x] Connect both selection directions and multi-segment editor paint; arbitrate
      single clicks versus double-clicks and preserve Escape, motion and copy.
- [x] Replace LaTeX's SyncTeX click and scroll adapters with the accepted
      file-aware text anchors; verify the changed non-prose coverage and that
      scrolling never switches files.
- [x] Remove MDraft's `\synctex=1` injection, worker read, parser and missing-map
      error. Update the old tests that require them and confirm the adapter
      does not request or consume SyncTeX.
- [x] Compile an explicitly authored `\synctex=1` in an isolated real-app run
      without rewriting the buffer; confirm PDF and mapping still work. The SDK
      unit test confirms MDraft does not request or consume its virtual output.
- [x] Implement the scoped included-file navigation handoff, freshness checks,
      cancellation and pending-selection reconciliation.
- [ ] Complete the remaining real-pointer interaction, project, lifecycle, zoom
      and regression matrix; run the required layers and record the full
      performance comparison.
- [x] Write the ADR, update LaTeX/user and test documentation, record any traps
      and tick the steps that are complete.

## Files and modules

| File or module | Purpose |
| --- | --- |
| `src/typst-page-map.ts` and new `src/pdf-page-map.ts` | Preserve the Typst adapter and extract the common, cancellable contextual matcher. |
| New `src/pdf-page-map-worker.ts` | Run syntax parsing and pure matching away from the UI; terminate obsolete work and provide a bounded fallback. |
| New `src/latex-word-map.ts` | Use and guard the pinned syntax service, then build file-aware links against the compiled snapshot. |
| `src/latex.ts` | Retain original compiled inputs; remove forced SyncTeX, its parser/read and its missing-map error. |
| `src/latex-correspondence.ts` | Replace or retire the SyncTeX-only click/scroll adapters once the file-aware PDF anchors cover their supported cases. |
| `src/typst-pdf.ts` | Supply text geometry and word ranges, batch page/index work, remove the SyncTeX-specific type dependency, route selections and preserve the PDF viewport. |
| `src/main.ts` and `src/scroll-sync.ts` | Connect LaTeX gestures and file-aware scroll anchors, own snapshot freshness and the included-file handoff, and coordinate viewport ownership across recompiles. |
| `src/editor.ts` | Support multiple bounded sync decorations while preserving current callers and selection behaviour. |
| New `scripts/latex-word-map-unit.mjs`, `scripts/pdf-page-worker-unit.mjs` and updated `scripts/latex-preview-test.mjs` | Pure source/matcher and worker tests plus real-app word, literal, math, rebuild and export regressions. |
| `scripts/latex-sdk-unit.mjs`, `scripts/latex-sync-unit.mjs`, `scripts/latex-correspondence-unit.mjs`, `scripts/latex-poc-test.mjs` | Replace or retire SyncTeX-specific assertions with no-SyncTeX compile, safe correspondence and included-file coverage; do not leave obsolete checks silently passing. |
| `scripts/typst-preview-test.mjs`, `scripts/latex-preview-test.mjs`, `scripts/latex-poc-test.mjs` and `scripts/scroll-sync-test.mjs` | Recompile-at-end, page-growth, scroll ownership, typing latency and multi-file navigation regressions. |
| Existing `samples/latex-poc/`, `samples/latex-reference.tex` and `samples/latex-two-column.tex` | Included-file navigation, known source occurrences, repeated prose, wrapping and multi-column PDF geometry. |
| `package.json`, `scripts/test-all.mjs`, `AGENTS.md` | Register and document the new test layers. Preserve any concurrent work in these files. |
| `docs/latex.md`, `README.md` as needed, new ADR, `docs/adr/2026-11-06-one-pdf-viewer.md` metadata, this plan | Describe no-SyncTeX selection/scroll, confidence limits and validation; supersede the old SyncTeX decision without rewriting its history. Correct the stale Sync Scroll note. |

No Rust, public API or new package is expected to change. If investigation shows
one is necessary, update this plan and obtain approval for the widened scope.

## Risks and rollback

- **Plausible wrong matches:** unique text can still be generated by TeX. Keep
  source eligibility conservative, guard conditional branches, use surrounding
  context and PDF reading geometry as corroboration, and reject conflicts or
  ambiguity; test the real-PDF false-conditional collision above.
- **Lost coarse navigation:** without SyncTeX, math, figures and macro-generated
  output can lose an existing line/region match. Measure this explicitly and
  fail closed rather than guessing; do not claim parity for unsupported content.
- **Snapshot and tab races:** an external file or unsaved buffer may differ from
  the compiled input, and the current tab switch destroys the preview selection.
  Validate the target text and navigation owner at each async boundary, and
  retain the viewer only for the explicitly validated handoff.
- **Matcher or PDF geometry regressions in Typst:** keep its adapter and
  scroll-index contract stable, run its full page tests and compare occurrences
  and highlight geometry rather than counting spans.
- **Latency and memory:** large documents and repeated text can make matching
  expensive. Bound candidate windows, individual UI-thread tasks, total work and
  cached inputs; measure and degrade to no word mark rather than blocking or
  guessing. A delayed map must not delay viewport restoration or canvas access.
- **Viewport races:** an empty replacement host can clamp `scrollTop`, and a late
  fit, older compile or sync event can undo a restore. Measure each frame, check
  input ownership, and test fallbacks with delayed maps and changed page counts.
- Roll back by reverting the feature's code changes as a unit, including the
  shared matcher extraction, restoring existing SyncTeX click and scroll
  behaviour. If an accepted architectural decision is reversed, record a new
  superseding ADR rather than erasing its history. Do not add a persisted setting
  solely for rollback.

## Tests and validation

Run the repository's required layers in `AGENTS.md`, including `npm run build`,
Rust tests through the Windows MSVC wrapper, relevant focused unit/UI suites and
the default `npm test` harness. Use isolated harness-owned application state; do
not operate on a user's running MDraft instance. Record a skipped UI layer as
unverified, not as a pass, if the LaTeX engine or target platform is unavailable.

**Validation completed so far (Windows x64, Node 24):**

- A separate test application with its own identifier and profile ran the current
  release build: LaTeX preview 69/69, Typst preview 70/70, cross-format word sync
  105/105, HTML preview 60/60, five-format scroll sync 62/62, and LaTeX project
  16/16, and preview zoom 24/24. The LaTeX phrase check now uses a real PDF
  pointer drag and independently
  checks the PDF selection and source highlight. The Reference map was 62.1 ms,
  its longest reported UI binding batch 0.4 ms, and typing p95/max 16.8 ms on that
  run. These runs do not establish every lifecycle and zoom case below.
- `pdf:map:webview` compiled a 52,254-byte, 16-page generated project containing
  an included file, an image and 180 safe formulas, then alternated authored
  SyncTeX on/off twice. The 45,112-byte PDFs had equal extracted text, page
  geometry and first/last canvas images. Enabled compiles took 966/968 ms,
  disabled compiles 957/988 ms; map time was 81.6/98.9 ms enabled and
  106.6/119.2 ms disabled, with longest binding batch 0.2 ms. Total measured
  compile-to-map times were 1,870/1,867 ms enabled and 1,907/1,900 ms disabled.
  The app plus WebView summed working-set samples peaked at 983/1,043 MiB
  enabled and 1,023/1,164 MiB disabled; samples are 250 ms apart, include shared
  pages and warmed caches, and are not a controlled memory comparison or a
  measurement of the removed SyncTeX reader/parser. Twenty real keystrokes
  overlapped map builds and recompiles: p95 25.2 ms, maximum 26 ms. A small
  one-page included-file/image pilot also passed. The earlier engine-only
  read/parse measurements remain the available evidence for the old parser;
  this does not reconstruct its old WebView route or prove a general speedup.
- The app-free default-harness selection of 13 relevant unit layers passed, as
  did the Rust suite (336 passed, two ignored). The isolated harness ownership
  suite passed 10/10, and preflight refused a competing UI run without changing
  the other harness's state.

- `npm test -- --only latex-preview --allow-installed --keep`: 59/59 checks.
  This was an isolated `.test-automation` instance; the installed user instance
  remained open. The suite exercises exact prose, verbatim and equation
  correspondence, the no-whole-line assertion, two-column scroll, last-page
  growth/rebuild restoration, failed-compile retention and LaTeX export/print.
- On the 6,515-byte / five-page LaTeX Reference, `wordMapMs` was 56.3 ms for
  648 prose anchors and `wordMapBatchMs` was 0.4 ms. The in-app typing probe
  measured p50 17.8 ms, p95 18.1 ms and max 18.4 ms with the PDF preview live.
- `latex:word-map:unit`, `pdf:map-worker:unit`, `typst:map:unit`,
  `latex:sync:unit`, `latex:references:unit`, `latex:outline:unit`,
  `latex:correspondence:unit`, `latex:sdk:unit` and `sync:unit` all passed.
  TypeScript and the Windows release build passed in the focused harness run;
  the latest `npm run build` also passed. Vite still reports the existing
  Asciidoctor Node-module externalization and large-chunk warnings.
  The shared-viewer regressions also passed: `typst-preview` 70/70, the
  five-adapter `sync` suite 62/62 and the multi-file `latex-poc` suite 16/16,
  including an authored `\synctex=1` compile whose source remained intact while
  the PDF and in-memory map rebuilt successfully.
- The synthetic 1.2 MB input and its results are recorded above. The matcher
  allocation reduction is kept for lower transient allocation, but the paired
  one-run worker benchmark was slower; repeat it with a controlled harness
  before claiming a performance win.
- `pdf:map:perf` on Windows x64 / Node 24.22, three fresh processes per mode:
  8,000 unique equations (70,924 source bytes, 8,000 anchors) took a median
  1,115.2 ms before indexing and 173.3 ms afterwards. Median 10 ms sampled
  process RSS was about 174.6 MiB before and 177.0 MiB after. A separate
  1,240,031-byte, 10,000-line synthetic prose input produced 110,000 anchors in
  both versions; median map time was 738.7 ms before and 594.4 ms after, and
  median sampled process RSS was about 478.8 MiB and 405.5 MiB respectively.
  These synthetic process measurements include the Node host and an active
  unrelated UI test run; they are not WebView memory or input-latency results.
  Four hundred mixed-math and 500 Typst fixtures also matched the previous
  implementation's exact outputs in a deterministic differential probe.
- `test:harness:unit`: 10/10. A second UI harness was deliberately attempted
  while another was active; preflight refused it without changing test state,
  and the other harness remained running. The Rust suite passed 336 tests, with
  two ignored.

Still outstanding: a controlled old-SyncTeX-route WebView memory and navigation
comparison, a large real-world (rather than generated) project, remaining
lifecycle and zoom cases, Linux, and the complete default `npm test` run. Another
independent harness still owns the shared UI test state, so this run was not
started or interrupted. These items remain unverified rather than being inferred
from focused passes.

1. **Pure units:** literal extraction and exact UTF-16 offsets for LF/CRLF/BOM,
   accents, combining marks, supplementary characters, ligatures, hyphenation,
   multiline lists and nested text formatting. Include comments and escaped `%`,
   definitions, unknown commands/conditionals, math, verbatim, labels, citations,
   excluded files, same text in different files, repeated includes, duplicate
   paragraphs, two columns and generated text. Pin the observed `\ifnum0=1`
   false branch that contains the same words as a rendered macro expansion;
   it must not map to the hidden words. Assert exact file and offsets, deliberate
   no-match cases and that both directions return the same accepted occurrence.
2. **Real app:** compile the Reference and focused multi-file fixture with the
   actual engine. Use real pointer double-clicks and drags in both panes; assert
   the text and occurrence of `.cm-sync-word` and both possible CSS Highlight
   registry entries, their visible rectangles and that no whole-line region
   substitutes for a word. Exercise the two phrases from the screenshots,
   20 alternating gesture pairs, repeated words in both columns, a wrapped word,
   a phrase across formatting, an included chapter, and no-match cases. Include
   a positive control that disables a mapping or perturbs the expected word so
   these assertions demonstrably fail when correspondence is broken.
3. **Lifetime and interaction:** verify a drag does not scroll the PDF under the
   pointer, reveal happens only after a settled gesture, selections/copy and
   caret are preserved, and single click still works. Cover Escape during a
   deferred build, reduced motion, reselection, edits during compile, tab/view
   changes, closed targets, unsaved included buffers, an externally changed
   closed file and a delayed open superseded by another gesture. Check zoom at
   50%, 100%, 150% and 300%, resize, page unpaint/repaint and two columns.
4. **Cross-format and scroll regressions:** `typst:map:unit`, `typst:preview`,
   `word-sync`, `html`, `sync:unit`, `sync`, `latex:preview`, `latex:poc`,
   `tabs` and `preview:zoom`, plus the new LaTeX unit suites and default harness.
   Update or retire `latex:sync:unit`, `latex:correspondence:unit` and
   `latex:sdk:unit`, whose current assertions require SyncTeX, only after their
   relevant behaviours have equivalent replacement tests. Assert real positions,
   not merely that a region element exists. Run Windows and Linux where hosts
   are available and report any platform not exercised.
5. **Rebuild position in both PDF formats:** use real keyboard input with the
   editor and preview already on the last page. Append text without a page break,
   then enough text to create a new last page; sample every animation frame from
   before compilation through settled layout and assert there is no page-one
   flash. With sync enabled and the tail being followed, check that the edited
   passage's text rectangle is visible on the current last page after each
   rebuild. Delete enough text to remove a page and verify the result clamps to a
   valid page. Repeat in the middle of the document, in two columns, at multiple
   zoom levels, with no word map, delayed map/fit, a superseding edit, a tab
   switch, and an intentional wheel scroll during compilation. With sync off or
   an intentional preview scroll, assert preservation of the reader's latest
   position instead of forcing the edited passage into view. Assert no feedback
   movement of the source, no unintended focus/caret change and no subsequent
   drift. Include a failing control that removes restoration, so a merely
   nonzero `scrollTop` cannot satisfy the test.
6. **Performance:** on the same stated host and warmed engine, record before/
   after time to first usable page, map-build wall time and longest UI-thread
   task, peak memory, median/p95 word-selection response and typing input age for
   **both** Typst and LaTeX. Use the Reference, two-column fixtures and
   deterministic larger multipage projects, plus a synthetic 1.2 MB map input;
   use a real project at that scale if the engine can compile it. The existing
   1.2 MB Markdown benchmark does not substitute for the PDF measurements.
   Include at least 20 gestures and 20 real keystrokes *while* page/map work is
   running and during overlapping recompiles. Follow the existing 100 ms p95 /
   150 ms maximum input-age thresholds in `preview:perf`, with a positive-control
   delay, and separately record the target approximately 8 ms batch sizes and any
   longer tasks. Verify
   map work is skipped outside Split, no index rebuild occurs per gesture,
   cancellation remains prompt and the PDF can be scrolled and selected while a
   map is pending. Compare total compile-plus-map time and peak memory with the
   old SyncTeX route; compare page count, extracted text, geometry, and rendered
   pages with SyncTeX on and off, allowing normal PDF metadata differences. Record
   fixture sizes, page counts, runs, thresholds and any unmeasured platform; run
   the existing Markdown/AsciiDoc performance checks as regressions too.
7. **SyncTeX absence and authorship:** compile ordinary, included-file,
   bibliography and graphics fixtures with no `\synctex` in the inputs. Inspect
   the worker filesystem for both `.synctex` and `.synctex.gz`, and require that
   MDraft neither injects, reads, parses nor requires either. Exercise an authored
   `\synctex=1` separately: preserve the source, ignore its virtual output and
   document the engine-level limitation. Confirm no project-directory sidecar is
   written, and that bibliography/cross-references still compile. Compare the
   existing 16-page measurement with a larger real-world document in WebView;
   report any inability to collect process memory or reproduce offline.

## Acceptance criteria

- In Split view, selecting source `draws` highlights only `draws` in the PDF;
  selecting `A heading is a command` in the PDF highlights that source phrase.
  Double-clicks and short drags work in both directions with the established
  pulse, resting highlight, selection preservation and Escape behaviour.
- Known repeated words map to the intended occurrence, including in a
  two-column page and a referenced chapter; source selection and PDF selection
  agree on file and offsets. Existing unsaved project edits survive navigation.
- The negative fixtures for ambiguous, generated, unsupported and stale content
  do not paint a fabricated word correspondence; unresolved ownership clears the
  mark. Document the remaining limits of heuristic provenance. A collapsed
  click uses only accepted text anchors; a selection cannot inherit a stale line
  rectangle. Literal `verbatim` words map exactly, and supported inline/display
  equations highlight as atomic regions in both directions; ambiguous or
  unsupported math and images remain unmapped.
- An ordinary LaTeX compile succeeds with no `.synctex`/`.synctex.gz` generated
  in the worker; MDraft never requests or parses SyncTeX. An explicit author
  `\synctex=1` is preserved and any resulting virtual file is ignored. The actual
  on/off compile, parse, total-map and memory results are recorded.
- Typst Pages, Markdown, AsciiDoc, HTML and existing LaTeX scrolling, PDF
  selection/copy and export regressions pass. Performance results and any
  unavailable platforms are recorded in this plan.
- After typing at the tracked end of either a Typst Pages or LaTeX document, the
  rebuilt PDF keeps the edited passage visible, even when it moves to a new page;
  it never flashes page one. Deliberate preview scrolling wins over a pending
  rebuild, and disabled Sync Scroll preserves the preview's reading position.
- Neither PDF language builds its map in a single UI-blocking task. The page
  remains usable while mapping is pending; typing and cancellation meet the
  stated measured thresholds without regressing Markdown or AsciiDoc.

## Open questions

- Can the pinned LuaLaTeX worker expose `-synctex=0` without changing the pinned
  engine assets, and should MDraft override an author's explicit `\synctex=1`?
  Default: never request or consume SyncTeX; respect the authored source and
  document the exceptional virtual output unless a safe, approved engine-level
  policy is chosen.
- Can file-aware text anchors match the existing click and scroll coverage on the
  representative fixtures? Default: no guess for missing or ambiguous evidence;
  document unsupported regions and return to the user if the agreed acceptance
  criteria cannot be met without SyncTeX.
- The approved math extension maps only source expression tokens that can be
  matched uniquely to PDF text-layer tokens. Full macro expansion, layout-aware
  math correspondence and non-textual glyph provenance remain out of scope.
