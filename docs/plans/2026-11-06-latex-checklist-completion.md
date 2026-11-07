# LaTeX product completion: the remaining checklist

**Status:** draft
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
| Print | **Deliberately disabled** (`menu.rs:556`), label `Print… (use Export › PDF)`. The maintainer has now asked for it to print the compiled PDF. |
| Pandoc export for `.tex` | **Disabled** (`menu.rs:559`): `export.html` and `export.pdf.browser` are false for LaTeX. |
| Format Document | **Disabled** (`menu.rs:572`). No formatter is bundled. |
| Zoom in the LaTeX preview | Unverified. The PDF viewer is `TypstPdfPreview`, which has `setZoom`; whether the LaTeX host calls it is not established. |
| Insert and Format commands | Partly. Headings and inline commands exist in `latex-commands.ts`; every other row needs checking against a real `.tex` document. |
| SyncTeX click and selection blink | Click works. Blink parity with Typst is unverified. |
| Two-column scroll precision | The correspondence rule set exists and is unit-tested; two-column behaviour is unverified. |
| Rich paste into LaTeX | **Missing.** `src/paste/` has readers and renderers for Markdown, HTML, Typst and AsciiDoc; there is no `render-latex.ts` or `read-latex.ts`. The detector scores LaTeX, so the destination is known — the conversion does not exist. |
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

- [ ] **1. Tools › Check or Install LaTeX…** Add the menu item beside Pandoc and
  Typst, route it to the existing `installLatex()` / `latex_status` pair, and give
  it the same three-state dialog the other two use: ready (version, location,
  who installed it), missing (offer the download), downloading (progress).
  `menu.rs` gains the id and its availability rule; `menu-test` gains the row.

- [ ] **2. Zoom in the LaTeX preview.** Establish whether the LaTeX host calls
  `typstPdf.setZoom`, then make document zoom reach the PDF the same way it
  reaches the Typst Pages view: the status chip, the keyboard route, Reset, and
  Content Width. `preview-zoom-test` gains LaTeX cases.

- [ ] **3. Insert and Format for LaTeX.** Audit every row in the Insert and Format
  menus against a real `.tex` document and make each one either work or say why
  not. Known work: headings exist; table, image, link, code, quote, math and the
  list commands need checking; `format.tasks` and `insert.alerts` stay disabled
  with their existing explanation because LaTeX has no syntax for them. The rule
  is that a row is enabled only if it produces compilable LaTeX.

- [ ] **4. Print the compiled PDF.** Enable `file.print` for LaTeX and route it to
  the PDF the preview holds: write it to a temporary file through the existing
  `print_document`-style path and print that, or hand the bytes to the webview's
  print surface. Refuse when the preview is stale, exactly as Export › PDF does.
  The label loses its "use Export › PDF" suffix. **This is the step that needs an
  ADR**, because it decides where printing a compiled document lives.

- [ ] **5. Pandoc export for `.tex`.** Widen the export gate so `export.html` and
  the pandoc-backed formats accept LaTeX, and make `buildExportArticle` pass the
  `.tex` source to pandoc rather than trying to render it. `export.pdf.browser`
  stays disabled — that route re-renders, which is the rejected approach.
  `export-test` gains a `.tex` source case.

- [ ] **6. tex-fmt as the LaTeX formatter.** Add `tex-fmt@0.5.7-npm.1` (MIT,
  **537 KiB gzip**, measured), load it lazily behind `src/format/formatters.ts`
  the way Typstyle is loaded, and enable `format.document` for LaTeX. The default
  configuration is deliberately conservative: `wrap = false`, so formatting never
  reflows a paragraph the reader wrote. A corpus test asserts that verbatim,
  `\verb`, comments and math survive byte-exact, and that formatting twice equals
  formatting once.

- [ ] **7. SyncTeX blink parity.** Make a click in the LaTeX preview paint the
  same way a click in the Typst Pages view does: the region painted, the four-beat
  pulse, reduced motion respected, Escape clearing it, and no selection stolen.
  `latex-correspondence-unit` covers the rules; the paint needs the viewer.

- [ ] **8. Two-column scroll precision.** Verify the correspondence against a
  two-column document — the case where one source line owns regions in both
  columns — and fix what the measurement shows. The rule already prefers the
  hinted page and the nearest region; what is unproven is whether that is enough
  when the columns are far apart horizontally.

- [ ] **9. Rich paste into a LaTeX document.** `src/paste/` has readers and
  renderers for Markdown, HTML, Typst and AsciiDoc — and **none for LaTeX**. So
  *Convert Rich Text on Paste* has no destination for a `.tex` buffer: pasting
  rich text, Markdown or HTML into LaTeX either inserts the source verbatim or
  does nothing, depending on the path. Add `render-latex.ts` and
  `read-latex.ts` to the same matrix the other four use, so a paste converts to
  valid LaTeX: headings become `\section`, emphasis `\emph`/`\textbf`, lists
  `itemize`/`enumerate`, code `verbatim`, links `\href`, images
  `\includegraphics`, tables `tabular`, math preserved. The detector already
  scores LaTeX (`scoreLatex`), so the destination is known; what is missing is the
  conversion. `paste:convert` gains the LaTeX row in both directions.

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
| `paste:convert` (411) | + the LaTeX row: rich text, Markdown and HTML into LaTeX, and LaTeX into the other four; heading levels, emphasis, lists, code, links, images, tables, math |
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
9. Pasting rich text, Markdown or HTML into a `.tex` document produces valid
   LaTeX, and pasting LaTeX into the other four produces their syntax.
10. `npm test` passes, and every count in `AGENTS.md` matches.

## Open questions

- **Print destination.** Does the webview's print surface accept a PDF it holds,
  or must the bytes be written to a temporary file first? Step 4 establishes this;
  the answer decides whether a new Rust command is needed.
- **Pandoc and `\newcommand`.** Pandoc expands some macros and not others. The
  test uses a document with a custom command to find out what a reader gets.
- **tex-fmt and two-column layout.** Formatting may re-indent a `multicols` body
  in a way the reader did not ask for. The corpus test should include one.
