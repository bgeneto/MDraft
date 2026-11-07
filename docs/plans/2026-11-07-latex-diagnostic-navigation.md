# Point LaTeX errors at the offending source line

**Status:** in progress
**Date:** 2026-11-07
**ADR:** none — the diagnostics shape is internal; no Tauri command, `api.ts`
wrapper or `settings.json` field changes.

**Approval:** explicitly approved by the user on 2026-11-07 ("start the plan now
(it is approved)"). The user also confirmed that the reported image is genuinely
missing, added the requirement to jump to the included file, and supplied the
exact commented lines from `Resumo executivo.tex`.

**Progress:** the structured scan, the collect-all contract, the compiled-line
evidence, the pure mapper, the editor mark, the panel, the auto-jump, the root
pin and the pink pulse are implemented. `npm run build`, `latex:references:unit`
(62/62), `latex:diagnostics:unit` (20/20), `latex:sync:unit`, `latex:outline:unit`,
`latex:sdk:unit`, `latex:word-map:unit`, `pdf:map-worker:unit` and the `latex::`
Rust tests pass. The new UI section in `latex:preview` has not been run here; it
needs the staged app and the engine. `\graphicspath` moved to the follow-up in
`docs/backlog.md`, as the reported file really is missing.

**Also fixed while tracing the report:** the Rust collector resolved a
reference against the **including file's** directory, while TeX and the
TypeScript validator resolve it against the **main file's** directory. A chapter
under `chapters/` that names `figures/plot.png` was therefore omitted from the
snapshot, and the validator then reported a file that exists. Both sides now use
the project root, with a Rust test.

**What the supplied source proved:** the two commented `\includegraphics` lines
from `Resumo executivo.tex` are accepted by `collectLatexReferences` (a probe
returns zero diagnostics). The old scanner is therefore not misreading that
`%`. If the running app still reports the image, it is compiling text other than
the buffer the reader sees, and the panel's new "Compiled source" row is what
shows which file and line it did read. The jump into the included file is how
the reader reaches it.

A concrete way that happens: TeX resolves `\input{Resumo executivo}` against the
**main file's** directory. If the tab the reader edited is
`capitulos/Resumo executivo.tex`, while the main file is one level up, the
compile reads `Resumo executivo.tex` beside `main.tex` — a different file with
the same name. The error names only the project-relative path, so the two are
indistinguishable today. The row and the jump show which one was compiled.

## Context and goal

A LaTeX project with a missing figure shows this in the preview pane and nothing
else:

```
Error: Missing project file for \includegraphics in Resumo executivo.tex:
arquitetura_tecnológica_biocomp_perenes(1).png
```

The reader cannot see *where* in `Resumo executivo.tex` the command is, and the
editor shows no mark. In a long document with many figures the file name and
image name are not enough to find the line.

The report also says that **commenting the command with `%` does not clear the
error**, and the user has confirmed that the image genuinely does not exist. So
the message is not a false positive about a file that lives in a
`\graphicspath` folder: the reference is real. "Commenting does nothing" and
"the file is missing" are therefore two separate questions, and today the UI
gives no way to tell them apart:

- If the same image is referenced twice, `validateLatexReferences` throws the
  **identical** message for the second occurrence. A probe with two live copies
  reproduces it: comment one, the message does not change.
- If the command is inside a `\begin{comment} … \end{comment}` block or after
  `\\%` on the same line, it is not a `%` comment and is still scanned. Both are
  reproduced by a probe against `referencesIn`; the SDK's own
  `stripTexComments` documents the odd/even backslash rule that the app does not
  implement.
- If the reference lives in another project file, or in a different tab than
  the one on screen, the reader edits one buffer while the compile reads
  another. The current message names a file but offers no way to reach it.
- If the buffer is dirty and the file was changed in another editor, the compile
  uses the buffer, not the disk copy the reader just edited; nothing in the UI
  shows which text was compiled.

None of these is visible in the current message. The goal is to make the compile
**show its own source**: name the file, the line and the command, mark it, and
list every occurrence. Then "I commented it" and "the compile still sees it"
stop being a guessing game: the panel displays the line the compiler actually
read, with or without the `%`, and one click takes the reader there — including
into an included file.

The mark is pink on purpose: amber is the word-sync mark (`--word-sync`), so the
error mark must be a different family. It is a *state*, not only a blink: after
the pulse, a persistent pink wash and wavy underline remain until the buffer
changes or the next compile succeeds. Reduced-motion readers get the state
without the animation.

## Scope and non-scope

**In scope**

- Structured LaTeX diagnostics: project-relative file, 1-based line, 1-based
  column/endColumn, severity, stable code, message, the matched command, and the
  **compiled line text**. One entry per occurrence; no early throw.
- Exact spans for the project-reference diagnostics (the `\includegraphics`,
  `\input`, `\bibliography` command and its argument), and whole-line spans for
  compiler errors that only carry a line.
- A pure mapper from a diagnostic plus a buffer to a CodeMirror range, with a
  staleness guard (line endings, edits, missing lines).
- An editor mark: persistent pink tint + wavy underline, plus a finite pulse that
  respects `prefers-reduced-motion`.
- A navigable problem list in the preview pane. Each row shows the compiled
  `file:line`, the message and the **compiled source line** in monospace.
- **Auto-jump to the first new problem**, including an included file: activate
  that tab, reveal and mark the line. It happens once per new diagnostic set,
  not on every recompile, and it never changes the project root.
- Comment-correctness fixes in both the TS validator and the Rust collector: the
  odd/even backslash rule and the `comment`/`filecontents*` literal
  environments.

**Out of scope**

- `\graphicspath` resolution. It is a real gap — the validator is stricter than
  the compiler — but the user has confirmed the file is genuinely missing, so it
  is not the cause here. Record it in `docs/backlog.md` as a follow-up rather
  than widening this change.
- Typst, Markdown, Mermaid, AsciiDoc and HTML diagnostics. GAP-029 already
  covers a general diagnostics surface; this plan builds the LaTeX half and
  leaves a reusable shape, without claiming the other languages.
- A global Problems panel, error-count status-bar chip, F8 navigation, gutter
  markers and scrollbar overview marks.
- Auto-fixes, quick fixes, or a compiler-language server.
- Warnings in the problem list; they stay in the raw log for now.
- New dependencies. `@codemirror/lint` is not added; the existing
  `StateField`/`Decoration` pattern in `src/editor.ts` is enough and keeps the
  bundle flat.

## Approach and rejected alternatives

**Chosen approach.** Make the diagnostics carry *identity and evidence*, not just
text. The validator walks the whole project and returns a list; each entry names
a file, line, column, the exact command text, the candidates it tried, and the
compiled line as read from the snapshot. The preview pane renders that list as
buttons and keeps the raw log in a `<details>` so nothing is lost. On a new
failure the first diagnostic is revealed automatically: the tab is activated
(or the included file opened), the range is marked and scrolled into view. The
decoration clears on the next edit (the same rule as the sync mark) and is
replaced by the next compile result; a successful compile removes both the marks
and the list.

The compiled line is the part that answers this report. If the panel shows
`\includegraphics{arquitetura…png}` while the reader's buffer shows
`% \includegraphics{…}`, the compile used different text — a second occurrence, a
different file, or a stale buffer — and the panel shows exactly which. If the
panel shows `% \includegraphics{…}` and still reports it, the scanner is wrong
and the unit test pins it. In neither case is the answer a guess.

Auto-jump is deliberately **once per new diagnostic set**, not on every
recompile. The preview compiles 800 ms after the last edit; a jump on every
keystroke burst would fight the reader. A new signature (file + line + message)
is the trigger. The caret is placed at the command only when the tab is
activated; a jump caused by a background recompile does not touch the caret.

The mapper is the rest of the robustness:

1. Clamp the line to the current document; a deleted line yields no mark.
2. If the columns are present and the slice at `line.from + (column-1) …
   line.from + (endColumn-1)` equals the stored command text, use it.
3. Otherwise search the line for the stored text (first at or after the column,
   then anywhere on the line).
4. Otherwise mark the whole line and mark the diagnostic as stale, so the panel
   can say "from the last compile" instead of pretending the range is exact.

Line and column, not byte offsets, are the contract. `documents.rs` normalises
CRLF to LF for an open buffer, while a closed project file is read from disk
with its original endings; offsets would silently drift by one per line. A
1-based line and a UTF-16 column mean the same thing in both.

**Rejected: highlight only the line.** The user's question is "which
`\includegraphics`", and a figure line can hold `\centering`,
`\includegraphics`, `\caption` and `\label`. Marking the command is what answers
it; the line wash is only the secondary cue.

**Rejected: throw a richer string.** A message cannot be clicked, cannot map to a
range, cannot list two occurrences of the same image, and cannot show the
compiled line. It also keeps the current early exit.

**Rejected: parse the raw log only.** The reported error never reaches the
compiler: the snapshot validator throws first. `result.errors` is needed for
engine errors, but it cannot replace the validator's exact spans and compiled
line.

**Rejected: `@codemirror/lint`.** It brings a diagnostics model, a panel and a
gutter we do not want, and costs bundle size for a mark we can express in the
existing `syncRangeField` shape. The hand-rolled field is also the pattern the
word-sync code already tests.

**Rejected: auto-jump on every failed render.** That would switch tabs on every
800 ms recompile of a broken project. One jump per new signature is the rule.

**Rejected: retarget the project at the jumped-to file.** The jump must not
change which file is compiled; the root of the failed render is retained until a
successful render or a deliberate project change.

## Steps

- [x] **Structured reference scan.** In `src/latex-references.ts`, replace the
  comment-stripping `replace` with a length-preserving mask (spaces, newlines
  kept) that uses the odd/even backslash rule; keep the masked text so match
  offsets survive. Extend `LatexReference` with `line`, `column`, `endColumn`,
  the matched command text and the compiled line text.
- [x] **Collect, do not throw.** Add `collectLatexReferences(sources, files,
  mainFile): { reachable, diagnostics }` that keeps walking after a bad
  reference, records every occurrence (cap 50), and reports the candidate paths
  it tried (`searched`). Keep `validateLatexReferences` as a wrapper that throws
  the first diagnostic's message, so `latex-references-unit.mjs` and
  `latex-sync-unit.mjs` keep their current shape.
- [x] **Literal regions.** Add `comment` and `filecontents*?` to the masked
  environments; add the brace-form and comment cases to the unit suite.
- [x] **Build error type.** In `src/latex.ts`, add `LatexBuildError extends
  Error` with `diagnostics: LatexDiagnostic[]` and `log: string`; call
  `collectLatexReferences` directly; convert `result.errors` /
  `result.telemetry?.diagnostics` into the same shape (file, line, severity,
  message, compiled line; line-only ranges when no column exists). Keep the
  existing `hint + detail` text as `log` so nothing disappears.
- [x] **Pure mapper.** Add `src/latex-diagnostics.ts` with
  `diagnosticRange(text, diagnostic)`, `diagnosticPlace` and
  `diagnosticSignature`. No DOM, no CodeMirror import: Node 24 can run it.
  (The dedupe and cap live in the two scanners, where the duplicates are
  created.)
- [x] **Editor mark.** In `src/editor.ts`, add a `StateField` beside
  `syncRangeField` for `Decoration.mark` and `Decoration.line`, the
  `diagnosticsEffect`, and `setDiagnostics(ranges, pulse)` /
  `clearDiagnostics()` / `pulseDiagnostics()` on `EditorHandle`. Clear on
  `docChanged`, map otherwise. Use `Decoration.set(ranges, true)` because the
  set mixes line and mark decorations.
- [x] **Panel and navigation.** In `src/main.ts`, replace the plain
  `latexFailure` body with a `.latex-problems` list (one button per diagnostic)
  plus the existing `.typst-error` inside a `<details>`; keep
  `.pdf-rebuild-error` for a failed rebuild over the last PDF. Each row shows
  `file:line`, the message and the compiled source line in a `<code>` block.
- [x] **Auto-jump.** After a failed compile, if the diagnostic signature is new,
  reveal the first diagnostic: resolve the project-relative path, activate the
  tab or `openPath` the included file, apply the marks, `revealOffset` and pulse.
  A click also places the caret; the automatic jump does not. Do not jump when
  only a re-render happened.
- [x] **Root pinning.** Record the `{ path, directory }` used by a failed render
  and reuse it for every render until a successful one, so navigating into a
  chapter does not silently change the main file.
- [x] **Apply and clear.** Keep the last compile's `latexProblems` and
  `latexProblemRoot`; apply the active document's entries after a failure and on
  `displayDoc` (no pulse on the tab switch). A successful compile clears both
  and the marks. The panel is rebuilt from the list on every failure.
- [x] **Styling.** Add `--diagnostic-error`, `--diagnostic-error-peak`,
  `--diagnostic-rule` to `:root` and `[data-theme="dark"]`; add
  `.cm-latex-error`, `.cm-latex-error-line`, the three-beat pulse and a
  `prefers-reduced-motion` rule that keeps the static state. Add the panel
  styles and the `.pdf-rebuild-error` overlay. Amber tokens stay untouched.
- [ ] **Tests and docs.** `scripts/latex-references-unit.mjs` (62/62) and
  `scripts/latex-diagnostics-unit.mjs` (20/20) pass; `scripts/latex-preview-test.mjs`
  has the new section but has not been run here because it needs the staged app
  and the engine. `package.json`, the AGENTS.md tables and the GAP-029 entry are
  updated; the `\graphicspath` follow-up is recorded in `docs/backlog.md`.

## Files and modules

| File | Why it must change |
| --- | --- |
| `src/latex-references.ts` | The scan, the comment rule, the collect-all contract, the compiled line, literal environments. |
| `src/latex.ts` | `LatexBuildError`, the validator call, compiler diagnostics from the SDK. |
| `src/latex-diagnostics.ts` (new) | Pure line/column → CodeMirror range, staleness, descriptions and caps. |
| `src/editor.ts` | The diagnostics `StateField` and the three handle methods. |
| `src/main.ts` | Panel rendering, auto-jump, click-to-reveal, apply/clear, root pinning across a failed render. |
| `src/styles.css` | Pink tokens, the mark, the pulse, reduced motion, the panel. |
| `src-tauri/src/latex.rs` | `comment`/`filecontents` masking, the odd/even comment rule, and root-relative resolution of a chapter's references, with Rust tests. |
| `scripts/latex-references-unit.mjs` | The new contract and the proven false-positive cases. |
| `scripts/latex-diagnostics-unit.mjs` (new) | The mapper: CRLF, Unicode, edited lines, deleted lines, duplicates, stale text. |
| `scripts/latex-preview-test.mjs` | The real UI: mark geometry, pulse, auto-jump, click-through, clearing, compiled-line evidence. |
| `package.json` | The new unit script. |
| `AGENTS.md` | Script table, test counts, and a trap if one is earned. |
| `docs/backlog.md` | GAP-029 gains the delivered LaTeX slice; `\graphicspath` is recorded as a follow-up. |

No `src/api.ts` or `src-tauri/src/lib.rs` change: the diagnostics never cross the
IPC boundary, and `latexProjectSnapshot` keeps its shape.

## Risks and rollback

- **The compiled line could be mistaken for the buffer line.** The panel labels
  it "Compiled source"; when it differs from the buffer at that line, the row
  adds "the buffer has changed since this compile". That difference is the
  evidence, not a bug.
- **A jump on every recompile.** Prevented by the new-signature rule and by
  root pinning; test it by typing in a project whose failure is in a chapter.
- **Offsets drift between snapshot and buffer.** Line/column is the contract;
  offsets are never stored. The mapper's expected-text guard prevents a mark on
  the wrong word. Test CRLF, BOM and a Unicode prefix.
- **A stale mark after an edit.** The mark clears on the first change and comes
  back only from a new compile result (800 ms quiet). A mark on a line the
  reader just commented would be a lie.
- **`comment` masking goes too far.** It is a real environment only when the
  `comment` package is loaded; masking its body is still correct for reference
  validation because the compiler does not read it. Test the `\end{comment}`
  boundary and an unterminated block.
- **A wall of diagnostics.** Cap the list at 50 and say "and N more"; the raw log
  stays one click away.
- **The UI suite needs the engine.** `latex:preview` already skips without it; the
  pure suites still cover the mapper and the scan. The new checks must not make
  the suite fail on a host without LuaLaTeX.
- **Rollback.** The notes are self-contained. Revert the branch; the settings
  schema is untouched, so no user state is stranded.

## Tests and validation

| Layer | Command | What it proves | Result |
| --- | --- | --- | --- |
| Typecheck/build | `npm run build` | The new modules compile and tree-shake. | Pass |
| Reference unit | `npm run latex:references:unit` | `%`, `\\%`, `\%`, `comment`, `filecontents*`, `\verb`, `\lstinline`, `\iffalse`, duplicates, CRLF, Unicode, collect-all, compiled line. | 62/62 |
| Diagnostics unit (new) | `npm run latex:diagnostics:unit` | Line/column → range, stale text, deleted line, line-only compiler ranges, the document edge, UTF-16 columns, panel strings. | 20/20 |
| LaTeX sync/outline/SDK | `npm run latex:sync:unit`, `latex:outline:unit`, `latex:sdk:unit` | The old throwing contract, the outline masking and the engine pin still hold. | 14/14, 35/35, 5/5 |
| Rust | `cargo test --lib latex::` through `scripts\cargo-vcvars.cmd` with `TEMP` inside the workspace | The collector masks `comment`, applies the odd/even comment rule, and resolves a chapter's references from the project root. | 10/10 |
| LaTeX preview UI | `npm run latex:preview` | A real missing image produces a row and an exact mark; the pulse runs; a new failure jumps into the included file; clicking another row reveals; commenting clears; the compiled line is shown. Uses `MDRAFT_PDF_KEEP=1` evidence when needed. | Added, not yet run on this host |
| Format/lint | `npx prettier --check` on the touched files; `npx eslint` on the touched files; `npm run knip` | The repository's own gates. The two known `no-control-regex` errors in `latex-outline.ts` and `render-latex.ts` predate this change and are not part of it. | Pass |

The one measurement that proves the feature: from the failing document, the
editor's `.cm-latex-error` rectangle must cover the `\includegraphics` command
(the slice from `from` to `to` equals the command text), the panel row must name
the same line, and the compiled-line text in that row must equal the snapshot
slice. A screenshot alone is not evidence; assert the slice.

## Acceptance criteria

1. A missing image produces **one row per occurrence**, each with
   `file:line` and the compiled source line; two occurrences in the same file
   are two rows, and commenting one leaves the other visible.
2. The offending `\includegraphics` (or `\input`/`\bibliography`) is marked in
   pink, pulses three times (unless reduced motion), and keeps a static wash and
   wavy underline afterwards.
3. A new failure whose culprit is in an included file activates that tab,
   reveals the line and applies the mark, **without changing the compile root**.
   A re-render of the same failure does not jump again.
4. A diagnostic whose line has been edited away is shown as stale and marks the
   line rather than a wrong range; it is never silently dropped.
5. The panel shows the line the compiler actually read. If it still contains the
   command after the reader commented the visible buffer, the compile used other
   text — a second occurrence, another file, or a stale buffer — and the row names
   the file and line it did use. If it contains the comment, the scanner no
   longer reports it.
6. `%`, `\\%`, `\begin{comment}` and `\iffalse` are not scanned.
7. A successful compile clears the panel and every mark; a failed rebuild keeps
   the last PDF and overlays the list, as today.
8. No network request, no new dependency, no `settings.json` change.

## Open questions

1. **Auto-jump scope.** Decided: the first diagnostic of a **new** failure, once.
   It activates the tab, reveals the line and pulses it; a click also places the
   caret at the command. A background re-render of the same failure does not
   jump. If this is too eager in use, the fallback is click-only.
2. **`\graphicspath`.** Default: not in this change; recorded in
   `docs/backlog.md`. The user has confirmed the image is genuinely absent.
3. **How many rows?** Default: 50, then "and N more". The log stays complete.
4. **Keep a mark after an edit?** Default: no. The mark is removed on the first
   change and restored by the next compile result.
5. **Should the pulse be one beat or three?** Default: three 520 ms beats, then
   the resting state; the sync word uses four 500 ms beats, so the two remain
   distinguishable by colour and count. Confirm if this reads as too busy.
