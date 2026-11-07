# LaTeX product completion: the remaining checklist

**Status:** in progress (approved 2026-11-06)
**Date:** 2026-11-06
**ADR:** none yet; this plan will need one for the print route (see step 4)

## Context and goal

The LaTeX integration works: a `.tex` file opens coloured, its outline is right,
spelling skips its commands, completion offers its catalog and its project's own
labels, the preview is the PDF LuaLaTeX produced, click navigation and scroll
correspondence go through SyncTeX, and Export › PDF writes the compiled bytes.

What is missing is the **parity** a reader notices by comparing LaTeX with Typst
and Markdown side by side. This plan closes the eight gaps the maintainer named,
each verified against the code rather than assumed:

| Gap | Verified state |
| --- | --- |
| Tools › Check or Install LaTeX… | **Missing.** Tools offers Pandoc and Typst (`menu.rs:1218–1227`); `installLatex()` exists in `src/main.ts:7557` but no menu item reaches it. |
| Print | **Done.** `print_compiled_pdf` writes the compiled bytes to a temporary PDF and opens it; ADR `2026-11-06-print-the-compiled-pdf.md`. Refuses a stale preview. |
| Pandoc export for `.tex` | **Done.** The backend gained a `latex` reader arm; `export.html` and every pandoc format are available. `export.pdf.browser` stays disabled because it re-renders. |
| Format Document | **Done.** tex-fmt behind `hasFormatter`; both gates removed. tex-fmt damages `verbatim` (tabs → spaces, blank runs collapsed) and `maskLatexLiterals` is what prevents it. |
| Zoom in the LaTeX preview | **Already works.** The LaTeX host builds `TypstPdfPreview` and calls `setZoom` both at creation (`main.ts:1680`) and on every change (`main.ts:969`). No UI assertion, because the harness cannot see the engine assets. |
| Insert and Format commands | **Audited and complete.** Every applicable row produces valid LaTeX; task lists, alerts and front matter are disabled with a real alternative named. Format Document is gated twice (`menu.rs:572` and `main.ts:2666`) — that is step 6. |
| SyncTeX click and selection blink | **Done.** A click paints its regions with the blink; two container/geometry defects fixed; proven end to end by `latex:preview`. |
| Two-column scroll precision | The correspondence rule set exists and is unit-tested; two-column behaviour is unverified. |
| Rich paste into LaTeX | **Done.** `render-latex.ts` and `read-latex.ts` added; three defects fixed, the last of which (`main.ts:7241` returning before conversion for plain text) was the one that kept the feature broken. |
| Tests for all of the above | Partial. |

The goal is that a reader cannot tell LaTeX is the newest language: every menu row
that applies to a document format applies to `.tex`, and each one is covered by a
test that would fail if it regressed.

## Scope and non-scope

**In scope:** the nine gaps above; the tests that pin them; the documentation and
`AGENTS.md` rows the changes touch.

**Not in scope:**

- A second PDF viewer. The LaTeX preview keeps using `TypstPdfPreview`.
- A pandoc *PDF* route for LaTeX. Decision D1 stands: LaTeX writes its own PDF.
  Pandoc gains the **other** formats (DOCX, ODT, EPUB, RTF), which LaTeX cannot
  write itself.
- SyncTeX for a document compiled outside MDraft.
- Any change to how the engine is installed or verified; step 1 only adds a menu
  route to what already exists.

## Approach and rejected alternatives

**Approach.** Work outward from the menu: make every row *available* first, then
make each one *correct*, then pin each with a test. That order means a reader who
tries the app after any single step finds no row that is present but dead, which
is the project's no-dead-UI rule.

Decisions taken by the maintainer for this plan:

- **Print prints the compiled PDF.** Not a re-render. The bytes already exist and
  match the preview exactly, so printing them cannot disagree with what is on
  screen.
- **Pandoc export is enabled for `.tex`.** Pandoc reads LaTeX natively; DOCX, ODT
  and EPUB are formats LaTeX cannot produce itself.
- **tex-fmt is taken at 537 KiB gzip.** Measured, not estimated.

**Rejected alternatives**

| Candidate | Why not |
| --- | --- |
| Print by re-rendering the document to HTML and printing that | The pandoc route the maintainer already rejected: it produces a second layout that contradicts the preview. Printing the compiled PDF has no such gap. |
| Print by opening the PDF in the system viewer and letting the reader print it | An extra application launch and a dialog the reader did not ask for. The webview can print a PDF it already holds. |
| Pandoc as the LaTeX PDF route | Rejected before: LaTeX writes its own PDF (D1). |
| A hand-written LaTeX formatter | tex-fmt is 537 KiB and already correct on the cases that matter (verbatim preserved, idempotent). Writing one would be worse and larger. |
| Typstyle's formatter reused for LaTeX | It parses Typst, not TeX. The output would be mangled. |
| Enabling `format.document` without a formatter | A row that does nothing, which the no-dead-UI rule forbids. |

## Steps

Each step leaves the product consistent and is independently testable.

- [x] **1. Tools › Check or Install LaTeX…** Add the menu item beside Pandoc and
  Typst, route it to the existing `installLatex()` / `latex_status` pair, and give
  it the same three-state dialog the other two use: ready (version, location,
  who installed it), missing (offer the download), downloading (progress).
  `menu.rs` gains the id and its availability rule; `menu-test` gains the row.

  **Landed.** `menu.rs` gains `tools.latex` in the Tools submenu and in the
  always-available list; `src/main.ts` gains `latexSetup()` with the ready and
  missing states, the cache size and ceiling in the ready state, and the download
  offer in the missing state. `menu` 150 → **156**: the row's label, and all three
  install rows being available whatever document is open.

  **A new suite, `latex:tools` (7 checks), because the menu test cannot prove a
  row is *wired*.** A menu id with no handler is a silent no-op —
  `runMenuAction` looks the id up in a `Record<string, …>`, so the type checker
  cannot catch a missing entry. The suite uses a **positive control**: a bogus id
  must make the dispatcher warn, and `tools.latex` must not. Two wrong approaches
  were tried first and are recorded in the test's header: a `window` hook that
  Vite tree-shook out of the bundle, and patching `__TAURI_INTERNALS__.invoke`,
  which `api.ts` binds at import so it never intercepts.

- [x] **2. Zoom in the LaTeX preview.** Establish whether the LaTeX host calls
  `typstPdf.setZoom`, then make document zoom reach the PDF the same way it
  reaches the Typst Pages view: the status chip, the keyboard route, Reset, and
  Content Width. `preview-zoom-test` gains LaTeX cases.

  **Established: zoom already reaches the LaTeX preview, and no code was
  needed.** The LaTeX host builds the same `TypstPdfPreview` and calls
  `view.setZoom(zoomFactor())` when it is created (`main.ts:1680`), and
  `setZoom` re-applies `typstPdf?.setZoom(zoom)` on every change
  (`main.ts:969`). So the chip, the keyboard route, Reset and Content Width all
  drive it, because they all go through the one `setZoom`.

  **The UI test is not written, and the reason is a harness limit rather than an
  omission.** `preview-zoom-test` runs against a staged instance whose `%APPDATA%`
  is private to the run, so the engine assets in the real app-data directory are
  not visible to it; a `.tex` document there shows the "Enable LuaLaTeX" note
  instead of a PDF, and there is nothing to measure. Making the suite copy 10 MiB
  of engine assets into every staged instance would slow every run for one
  language. The honest position is that the wiring is proven by reading the two
  call sites and the rule is covered by `latex:correspondence:unit`; a UI zoom
  assertion needs the engine-copying work that step 9's measurement would justify
  anyway. Recorded as remaining work rather than claimed.

- [x] **3. Insert and Format for LaTeX.** Audit every row in the Insert and Format
  menus against a real `.tex` document and make each one either work or say why
  not. Known work: headings exist; table, image, link, code, quote, math and the
  list commands need checking; `format.tasks` and `insert.alerts` stay disabled
  with their existing explanation because LaTeX has no syntax for them. The rule
  is that a row is enabled only if it produces compilable LaTeX.

  **Audited: every row already does the right thing, and no code was needed.**
  This was the step most likely to hide dead rows, so each one was traced rather
  than assumed:

  | Row | LaTeX behaviour |
  | --- | --- |
  | Bold, italic, strike, code, link, inline math | `latexInline()` returns `\textbf`, `\emph`, `\sout`, `\texttt`, `\href`, `$…$` |
  | Table, code block, quote, horizontal line, TOC, display math | `LATEX_TABLE`, `LATEX_CODE`, `LATEX_QUOTE`, `LATEX_RULE`, `LATEX_TOC`, `LATEX_DISPLAY_MATH`, all wired in `main.ts:4018–4131` |
  | Headings 1–6, paragraph, promote/demote | `latexHeadingCommand` / `latexShiftHeadingLine` map levels to `\section`…`\subparagraph` |
  | Lists, indent, outdent, insert before/after | Enabled and language-neutral |
  | Task list, alerts, YAML front matter | **Disabled with a reason**, and the reason is a real alternative: `latexUnsupported()` names `\item[\checkmark]`, `tcolorbox` and `\title{}` respectively |
  | Format Document | **Disabled in two places** — `menu.rs:572` and `formatUnavailableReason` (`main.ts:2666`, "LaTeX formatting is deferred in this experiment"). This is step 6's work, not a separate gap |

  The second gate is worth recording: `menu.rs` alone would have looked like the
  only one, and removing it without the other would have produced a row that is
  enabled and then refuses.

- [x] **4. Print the compiled PDF.** Enable `file.print` for LaTeX and route it to
  the PDF the preview holds: write it to a temporary file through the existing
  `print_document`-style path and print that, or hand the bytes to the webview's
  print surface. Refuse when the preview is stale, exactly as Export › PDF does.
  The label loses its "use Export › PDF" suffix. **This is the step that needs an
  ADR**, because it decides where printing a compiled document lives.

  **Landed, with the ADR the step asked for:**
  `docs/adr/2026-11-06-print-the-compiled-pdf.md`.

  `print_compiled_pdf` is the PDF sibling of `export::print_document`: same
  temporary `mdraft-print` directory, same "write then open" shape, same refusal
  to invent content. It validates the bytes (`%PDF-` prefix, size ceiling) before
  writing, because the file is handed to the system viewer and accepting
  arbitrary bytes would open whatever they are. The frontend refuses a stale
  preview with a named reason and never starts a compile of its own.

  **The label changed meaning, not just wording.** It used to read
  `Print… (use Export › PDF)` — a pointer at another row. It is now a real Print
  row, disabled before a compile with `Print… (available after the preview
  compiles)`, which is the same condition `export.pdf` uses because both print
  the same bytes.

  **Decision D11 is narrowed, not reversed.** The part that mattered — one PDF,
  the compiler's, never a second layout — is unchanged. `export.pdf.browser` stays
  disabled for LaTeX for exactly that reason.

  `rust` 321 → **322**, `menu` 156 unchanged with the assertions updated to the
  new behaviour.

- [x] **5. Pandoc export for `.tex`.** Widen the export gate so `export.html` and
  the pandoc-backed formats accept LaTeX, and make `buildExportArticle` pass the
  `.tex` source to pandoc rather than trying to render it. `export.pdf.browser`
  stays disabled — that route re-renders, which is the rejected approach.
  `export-test` gains a `.tex` source case.

  **Landed.** The backend gained a `latex` arm beside `html` and `asciidoc`
  (`export.rs`), so pandoc reads `.tex` with its **own LaTeX reader** rather than
  the Markdown one. The language already travelled with the request, which is why
  the change is three lines and a test rather than a new pipeline.

  **Three gates, and only one was in the plan.** The frontend guard
  (`main.ts:3639`) refused LaTeX outright; `menu.rs` had `export.html` in the
  `!latex` arm; and `export.html` had **no arm at all** in `enabled_for`, so
  removing the `!latex` gate left it falling through to `_ => return None`
  instead of becoming available. Only running the test found the third.

  **`export.pdf.browser` stays disabled**, and for a reason worth keeping: it
  re-renders the document to HTML and prints that, which would produce a second
  layout contradicting the compiled PDF. `export.pdf` writes the compiled bytes.

  **Verified against real pandoc 3.12.1:** the shipped LaTeX Reference converts
  to a 15,213-byte DOCX, and to 5,680 characters of text with the sections and
  emphasis intact. Math pandoc cannot convert is preserved as TeX with a warning
  rather than dropped — the right behaviour for a lossy target.

  `export` 40 → **44**. One assertion of mine was wrong and the real output
  corrected it: for a LaTeX *target* pandoc legitimately writes a
  `\documentclass` preamble and `\item` on its own line, so "no preamble" was the
  wrong signal. The right one is that the commands are not *escaped* as literal
  text.

- [x] **6. tex-fmt as the LaTeX formatter.** Add `tex-fmt@0.5.7-npm.1` (MIT,
  **537 KiB gzip**, measured), load it lazily behind `src/format/formatters.ts`
  the way Typstyle is loaded, and enable `format.document` for LaTeX. The default
  configuration is deliberately conservative: `wrap = false`, so formatting never
  reflows a paragraph the reader wrote. A corpus test asserts that verbatim,
  `\verb`, comments and math survive byte-exact, and that formatting twice equals
  formatting once.

  **Landed, and tex-fmt damages verbatim — measured, not assumed.** The module
  rewrites a **tab to two spaces** and **collapses a run of blank lines to one**
  inside `verbatim`, regardless of configuration. Both change what the document
  *prints*, not just its layout, so a naive integration would have silently
  corrupted every code listing a reader formatted.

  `maskLatexLiterals` swaps `verbatim`, `lstlisting`, `minted`, `alltt` and
  `\verb` for placeholders before formatting and restores the original bytes
  afterwards — the same masking idea `latex-references.ts` uses, for the same
  reason. `latex:format:unit` (29 checks) pins every one of those bodies as
  byte-identical, plus math untouched, prose not reflowed, idempotence, a
  non-LaTeX buffer left alone, and the shipped LaTeX Reference surviving with
  every comment and verbatim block intact.

  **Two gates, not one.** `menu.rs:572` disabled the row and
  `formatUnavailableReason` (`main.ts:2666`) refused it a second time. Removing
  only the menu gate would have produced a row that is enabled and then refuses.

  **Cost, measured on the real build:** `tex_fmt_bg.wasm` 1,701,774 bytes raw /
  **549,610 gzip (537 KiB)**, emitted as its own chunk and not referenced from the
  entry bundle — so the module is genuinely lazy. The staged binary grew
  18.6 → 19.0 MB.

- [x] **7. SyncTeX blink parity.** Make a click in the LaTeX preview paint the
  same way a click in the Typst Pages view does: the region painted, the four-beat
  pulse, reduced motion respected, Escape clearing it, and no selection stolen.
  `latex-correspondence-unit` covers the rules; the paint needs the viewer.

  **Landed, after two real defects were found and fixed.**

  1. **`latexSyncSource` never painted.** The preview→editor click moved the caret
     and stopped, while its editor→preview sibling `latexSyncCursor` painted. It
     now resolves the regions for the line it landed on and paints them with the
     blink — the parity with Typst this step asked for.
  2. **A click required a SyncTeX container that the fallback mapping cannot
     provide.** `latexSourceAt` returned null whenever `inverse.container` was
     null, and the bracket search that fills it needs **box nodes**. A mapping from
     the private worker fallback — the route this engine build depends on, because
     it emits no SyncTeX of its own — is a flat node list with none. Click
     navigation was therefore impossible on any fallback mapping. The container is
     now used when present and optional when not.
  3. **The candidate loop then still rejected the click.** It required each node's
     forward lookup to land on the click, which needs non-degenerate boxes: measured
     `region=302,346 0x8` — a kern with zero width — and zero candidates for a click
     the inverse match had already resolved. Without a container the inverse match
     *is* the answer: it has already done the geometric work, and the loop's
     evidence is the weaker kind.

  **A third shipped-document defect fell out of this:** the LaTeX Reference did not
  compile — `Reference 'sec:links' undefined`. The text says *"This section is
  labelled `sec:links`"* and no `\label` existed. Fixed; the reference now compiles
  to 5 pages.

  `latex:preview` (11 checks) proves it end to end: engine reachable, reference
  compiles, zoom 399 → 439 with an exact Reset, a click paints **2 regions**, and
  scrolling the editor moves the preview. It is in the default run.

  **Found by the CDP console, not by reading code.** Every early return in the
  click path now logs why it fired; that is what turned "nothing happens" into
  three named causes.

- [ ] **8. Two-column scroll precision.** Verify the correspondence against a
  two-column document — the case where one source line owns regions in both
  columns — and fix what the measurement shows. The rule already prefers the
  hinted page and the nearest region; what is unproven is whether that is enough
  when the columns are far apart horizontally.

  **The oscillation is real and reproduced.** `samples/latex-two-column.tex` (a
  `multicols` body, no `lipsum` — that package needs a fetch the test profile's
  cache does not have) compiles to one page, and stepping the editor down gave:

  ```
  preview scrollTop: 0 -> 0 -> 264 -> 345 -> 277
  ```

  It advances to 345 and then **jumps back** to 277. That is exactly the failure
  this step predicted: the same source line owns a region in each column, and the
  rule kept choosing the left one.

  **Two fixes landed:**

  1. **`topPosition()` returned `null` whenever the top edge fell between pages**,
     which made the correspondence fall back to `onPage[0]` — the *first* region of
     the line, which on a two-column page is the left column. It now returns the
     nearest page with the point clamped into it, so a hint always exists. Measured
     before and after: `hint: none` → `hint: 1@0`.
  2. **The region choice compared only `y`.** Two columns share a `y`, so the
     comparison was arbitrary. It now weights `x` by 0.5 — a column is about half a
     page wide, so a wrong column costs about as much as half a page of vertical
     error, and unweighted `x` in points would dominate.

  **Still not deterministic in the UI, and the remaining cause is named.** Logging
  the hint on both sides of every scroll gave the whole sequence and then, on a
  repeat pass over the same editor positions:

  ```
  pass 1: 0 -> 0 -> 264 -> 345 -> 236
  pass 2: 236 -> 165 -> 304 -> 243 -> 318
  ```

  Pass 2 starts where pass 1 ended, so the *first* step of a pass does not move —
  which means the target was computed but the scroll was suppressed. The
  correspondence itself is now deterministic: `latex:correspondence:unit` proves the
  same line gives the same target regardless of the hint (33 checks), and the
  hint is no longer an input to the choice.

  **What changed and why it is better even though the assertion still fails:**

  - `previewTargetForLine` **no longer consults the hint** to choose among a line's
    regions. It orders them by reading order — column first, then y — and takes the
    first. A correspondence must be a function of the document: the earlier version
    mapped the same line to different places depending on where the preview already
    was, so a reader could never predict the result and a repeat scroll drifted.
  - `columnSplit` infers a gutter from a horizontal gap no region crosses, with a
    24pt threshold so a word space is not mistaken for a column.
  - The two-column assertion was **wrong** and is corrected: a `multicols` page is
    not monotonic in y, because the columns are balanced, so a later source line can
    legitimately be typeset higher. Asserting "never backward" would have demanded a
    bug. It now asserts that the preview moves, stays inside the pane, and converges
    — and convergence is the one that fails.

  **Next measurement:** the suppression window. `syncLatexToPreview` sets
  `suppressPreviewScrollUntil` after writing, and a scroll that arrives inside that
  window is dropped. A pass that starts immediately after the previous one therefore
  loses its first step. That is a timing question, not a correspondence one.

- [x] **9. "Convert Rich Text on Paste" must produce valid LaTeX.** This is the
  requirement in full: **every** source format the clipboard can carry — rich
  text (HTML), Markdown, plain text, Typst and AsciiDoc — must paste into a `.tex`
  document as valid LaTeX, and LaTeX source must paste into the other four.

  **Landed.** `render-latex.ts` and `read-latex.ts` join the matrix, and
  `escapeLatex` covers the ten special characters. `paste:convert` 411 → **445**,
  `paste` (UI) 87 → **95**.

  **Three defects, not one, and only the third was visible from the plan.** Each
  was found by testing rather than reading:

  1. **`chooseSource` short-circuited LaTeX to `plain`** (`detect.ts:315`), so
     rich text and Markdown were *never* converted for a `.tex` buffer. Removed;
     LaTeX now goes through the same detection as the other four.
  2. **`literalFor` fell through to `renderHtmlFragment`** (`index.ts:206`), so
     plain text pasted into a `.tex` buffer was rendered as HTML.
  3. **The paste handler returned before conversion.** `main.ts:7241` read
     `if (choice.native || choice.source === "plain") return;` — plain text is the
     commonest clipboard shape, so it took CodeMirror's native path and the
     escaper was never reached. This was the one that kept the feature broken
     after the first two were fixed, and it is why the UI test mattered: the pure
     `planPaste` matrix passed while the application still pasted raw text.

  **The escaping rule.** A backslash cannot be replaced with `\textbackslash{}`
  in a plain chain, because the brace-escaping pass then rewrites those braces to
  `\textbackslash\{\}`. A NUL placeholder protects it. Math is passed through
  untouched — escaping it would turn `\alpha` into `\textbackslash{}alpha`, the
  worst possible outcome for a pasted formula.

  **A diagnostic worth recording:** an event probe added in the capture phase
  reported `prevented: false` and sent the investigation the wrong way for
  several runs. A capture-phase listener runs *before* the application's own, so
  it cannot answer "did the handler claim this".

- [ ] **10. Measurement and close.** Typing latency with the popup open, the
  installer delta for tex-fmt, the first and warm compile through `latex:poc`, and
  the memory the snapshot holds. Record every number here, tick the plan, and
  update `AGENTS.md`, `docs/latex.md` and the LaTeX Reference.

## Files and modules

Frontend:

- `src/main.ts` — the menu route for the install dialog, the print route, the zoom
  wiring, the export gate.
- `src/format/formatters.ts` — the tex-fmt loader and its conservative options.
- `src/latex-correspondence.ts` — the two-column refinement, if step 8 needs one.
- `src/typst-pdf.ts` — only if the blink or zoom needs a new method.

Rust:

- `src-tauri/src/menu.rs` — the Tools row, the print gate, the export gate, the
  labels, and the tests that assert them.
- `src-tauri/src/latex.rs` — a print command if the PDF must be written first.

Data and documents:

- `docs/latex.md`, `samples/latex-reference.tex`, `AGENTS.md`.

## Risks and rollback

- **Print could produce a different page than the preview** if it re-renders.
  Mitigated by printing the compiled bytes and refusing a stale preview; this is
  the reason the step needs an ADR.
- **tex-fmt could reformat a document the reader did not intend to change.** It is
  undoable in one step, the configuration disables wrapping, and the corpus test
  pins verbatim and math. The feature can be turned off by disabling the menu row.
- **Pandoc on `.tex` may hit constructs it reads imperfectly** (`\newcommand`
  bodies, conditionals). The export already fails loudly rather than writing a
  half-converted file; the test asserts a real document converts.
- **Enabling rows widens the menu surface** and therefore the test contract. Every
  count that changes is updated in the same commit.

**Rollback** is a branch revert. No settings key changes shape, no existing
document is rewritten by anything but an explicit Format, and tex-fmt is a lazy
chunk that simply stops being imported.

## Tests and validation

Named before the work starts, because the counts are a contract:

| Layer | Change |
| --- | --- |
| `menu` (150) | + Tools › Check or Install LaTeX row, + print enabled for LaTeX, + pandoc export enabled, + Format Document enabled, − the "use Export › PDF" label |
| `latex:correspondence:unit` (33) | + two-column cases |
| `latex:format:unit` (new) | tex-fmt: verbatim and math preserved byte-exact, idempotence, comments kept, a non-LaTeX file untouched |
| `preview:zoom` (24) | + LaTeX preview zoom: chip, keyboard, Reset, Content Width |
| `export` (40) | + a `.tex` source converting to DOCX and HTML |
| `paste:convert` (411) | + the LaTeX row: **all four sources** (rich text/HTML, Markdown, plain text, Typst, AsciiDoc) into LaTeX, and LaTeX into all four; heading levels, emphasis, nested lists, code, links, images, tables, math, the ten-character escape table, and the `literalFor` fall-through regression |
| `latex:measure` (probe) | + the installer delta for tex-fmt |
| `latex:poc` | + print produces a PDF the Poppler checks accept |

## Acceptance criteria

1. Every row in Insert and Format that applies to a document format applies to
   `.tex`, and each either works or states why not.
2. Tools › Check or Install LaTeX… reports the engine's state and can install it.
3. Print prints the compiled PDF, and refuses a stale preview with a named reason.
4. Pandoc export produces a real DOCX and HTML from a `.tex` document.
5. Format Document formats a `.tex` document, preserves verbatim and math exactly,
   and is idempotent.
6. The LaTeX preview zooms exactly as the Typst Pages view does.
7. A click in the preview paints the region with the same pulse Typst uses.
8. Scroll correspondence is precise on a two-column document in both directions.
9. *Convert Rich Text on Paste* produces valid LaTeX from **every** source the
   clipboard can carry — rich text, Markdown, plain text, Typst and AsciiDoc — and
   pasting LaTeX into the other four produces their syntax. A pasted `50%` or
   `a_b` arrives as text, not as a compile error.
10. `npm test` passes, and every count in `AGENTS.md` matches.

## Open questions

- **Print destination.** Does the webview's print surface accept a PDF it holds,
  or must the bytes be written to a temporary file first? Step 4 establishes this;
  the answer decides whether a new Rust command is needed.
- **Pandoc and `\newcommand`.** Pandoc expands some macros and not others. The
  test uses a document with a custom command to find out what a reader gets.
- **tex-fmt and two-column layout.** Formatting may re-indent a `multicols` body
  in a way the reader did not ask for. The corpus test should include one.
- **Paste escaping versus intent.** Escaping every special character is right for
  plain text, but a reader who pastes `\alpha` meaning the command would get
  `\textbackslash{}alpha`. Step 9 starts from the safe rule — plain text is text —
  and the test pins that a pasted `50%` and `a_b` survive; whether a pasted
  backslash-command should be recognised as markup is a judgement call to settle
  while implementing, with the reader's likely intent as the tiebreaker.
- **Paste into a LaTeX *project*.** A pasted image path must resolve relative to
  the main file's directory (decision D5), not the buffer's. The test uses a
  project with a subdirectory to pin it.
