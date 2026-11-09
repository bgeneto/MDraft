# Show the LaTeX PDF when it built, and say what the compiler is doing

**Status:** draft
**Date:** 2026-11-08
**ADR:** `../adr/2026-11-08-latex-compile-states.md` — the compile's observable
state machine and the "a warning never discards a PDF" rule are durable
decisions, not implementation detail.

## Context and goal

Two separate defects are being read as one, and the report describes both.

**Defect 1 — a warning throws away a PDF that was written.** The report's own
evidence is in the screenshot: the compiler output says

```
Output written on Resumo-executivo.pdf (23 pages, 344929 bytes).
Transcript written on Resumo-executivo.log.
```

and the pane still shows a failure. `src/latex.ts:198` builds a `blocking` list
from *every* diagnostic whose message matches

```ts
/citation .+ undefined|empty bibliography|undefined references|run biber/i
```

**without looking at `severity`**, and `:205` then throws `LatexBuildError`
whenever that list is non-empty, even though `result.success` is true and
`result.pdf` holds 23 real pages. The SDK only reports `success: false` when the
log carries a fatal-no-output line or the exit status is not 0/1
(`node_modules/wasmtex/lib/engine/wasmtex-engine.js:501`), so a cross-reference
warning reaches the frontend as a *successful* compile that the adapter then
converts into a failure.

This is reproducible with the supplied fixture, and the sample is guaranteed to
hit it:

| Fact | Where |
| --- | --- |
| `\ref{fig:arquitetura}` is used | `docs/samples/Resumo-executivo.tex:246` |
| `\label{fig:arquitetura}` is **never defined** (18 labels, none of them this) | verified by scanning the file |
| `\includegraphics{fluxo_analítico_da_biocomp_perenes.png}` points at a file that does **not exist** | `:254`, `Test-Path` is false |

So the fixture cannot render today for two independent reasons: the missing
image is caught by the reference validator before the compile (that is the
`Missing project file for \includegraphics` row in the screenshot), and once
that line is removed the undefined reference produces
`LaTeX Warning: There were undefined references.` — which the regex above
treats as blocking. A probe confirms the match:

```
True     There were undefined references.
False    Reference `fig:arquitetura' on page 4 undefined on input line 246.
```

`src/latex.ts:221` has the same shape for `/LaTeX Warning: File .+ not found/i`:
it throws although a PDF exists.

**Defect 2 — the pane never says what the compiler is doing.** Compiling a
`.tex` file is not like rendering Markdown. The recorded measurements are
**1134 ms cold and 1124 ms warm** for a small project
(`docs/plans/2026-11-06-latex-product-integration.md`, step 13), and a cold
package cache adds network time on top. During all of it:

- `renderDelay()` waits 800 ms after the last keystroke (`src/main.ts:1366`)
  with no visible sign that anything is queued.
- The pane keeps showing the *previous* result. `previewStale` (`:1324`) is a
  boolean used only to decide whether to re-render; it is never painted, so a
  stale PDF is indistinguishable from a current one.
- The SDK exposes `onAssetDownload` and `onLoadProgress`
  (`node_modules/wasmtex/lib/headless.d.ts:67-71`) — "the format download
  percentage and every TeX Live file fetched on demand … instead of a blank
  wait" — and **neither is wired anywhere in `src/`** (grep returns nothing).
  That is exactly the "user never knows if the backend is downloading packages
  or compiling" complaint.
- There is no way to turn automatic compilation off, and no Compile command.
  Every typing burst starts a compile, so a reader editing a long document
  spends the session racing the engine.
- On success the warnings are discarded entirely: `compileDiagnostics` maps
  `severity: "warning"` faithfully, but `latexProblemPanel` is only ever built
  from a thrown error. A document that builds with three warnings shows nothing.

The goal: **a PDF that the engine produced is shown**, warnings are listed
beside it rather than replacing it, and the pane always answers "what is
happening and how long will it take" — with the reader able to stop it and to
turn auto-compilation off, the way Overleaf does.

## Scope and non-scope

**In scope**

- The blocking rule: only a compile that produced no PDF is a failure.
  `LatexResult` gains `warnings`, and a successful compile always renders.
- A warnings surface: a count beside the PDF and a disclosure listing each
  warning, clickable to its source line, reusing `latexProblemPanel`'s row
  shape. Warnings get a quieter mark than errors.
- A compile status chip in the preview pane: *Queued*, *Compiling*,
  *Downloading packages (n)*, *Rendering*, *Done in 1.2 s*, *Failed*, *Out of
  date*. It is a button that cancels an in-flight compile.
- Wiring `onAssetDownload` and `onLoadProgress` to that chip, so package
  downloads are named instead of guessed.
- `latexAutoCompile` in `settings.json` (default **on**, so nothing changes for
  a reader who never opens Preferences), a View › Compile LaTeX command with an
  accelerator, and a Preferences row.
- Honest staleness: when the buffer changed since the last successful compile
  and auto-compile is off, the pane says so instead of looking current.
- The fixture gains the label it references, so `docs/samples/Resumo-executivo.tex`
  is a document that compiles as shipped, with its warnings visible.

**Out of scope**

- `\graphicspath` resolution, still tracked in `docs/backlog.md`.
- Provisional first-page renders through `previewColdPages`/`previewPages`.
  A large win for a 23-page cold start, but it is a second engine pass with its
  own cancellation and staleness rules; see open question 2.
- A global Problems panel, F8 navigation, gutter markers, or diagnostics for
  Typst/Markdown/AsciiDoc. GAP-029 keeps the general surface.
- Incremental compilation (`incremental`, `luatexHeapCheckpoints` in the SDK).
  LuaLaTeX does not take the pdfTeX checkpoint path, so this would be a
  different feature.
- Any change to the export routes, the snapshot contract or the cache policy.
- A new dependency. Everything needed is already in the pinned SDK.

## Approach and rejected alternatives

**The rule that fixes defect 1.** The engine's own verdict decides, not a
regex over its prose:

```ts
if (!result.success || !result.pdf) throw new LatexBuildError(...);
return { pdf, sources, files, mainFile, log, warnings };
```

The `blocking` regex existed for a real reason — a document with undefined
citations produces a PDF whose bibliography is empty, and silently showing it
would be a lie. The answer is not to discard the PDF but to **label it**: the
warnings travel with the result, the pane shows `23 pages · 3 warnings`, and
the disclosure names them. That is what Overleaf does and what a reader
expects: the document is readable, the cross-references are not finished yet.

The same change applies to `src/latex.ts:221`: `LaTeX Warning: File … not
found` becomes a warning attached to the result, because the PDF exists.

**The status chip.** One element, `#preview > .latex-status`, owned by a small
state machine with the states named above. It is created by `renderLatexPreview`
before the first `await` and updated by the SDK callbacks; it is removed when
the PDF commits and replaced by the warnings row. Two properties matter:

- It must be painted *before* the first `await`, or it never appears for a
  compile that finishes quickly and the reader learns nothing.
- It must be cancellable. `cancelLatex()` already bumps `generation` and
  disposes the compiler; the chip's click handler calls the same thing, so
  there is one cancellation path, not two.

The SDK's `onAssetDownload` gives `{ asset, phase, receivedBytes, retryCount }`
and `onLoadProgress` gives `{ phase: "format", percent }` or
`{ phase: "file", file, count }`. The chip shows the *count* and the kind, never
the file path — a TeX Live path is noise to a reader and the project promises
not to send document contents anywhere, so naming mirror files is the only
outward-facing string and it is a package name, not a document name.

**Auto-compile.** A boolean, mirroring Overleaf's switch. When it is on the
behaviour is exactly today's. When it is off, `scheduleRender` for a LaTeX
document marks the pane stale and does not compile; the chip becomes
*Out of date — click Compile* and the View menu's Compile row is the action.
The default is **on** because a reader who upgrades should not find that their
preview stopped updating; the plan's own acceptance criteria test both states.

**Rejected: keep the blocking regex and only relax `undefined references`.**
It fixes this one message and leaves the next one — `Citation … undefined`,
`empty bibliography`, a missing font — discarding a PDF the same way. The
severity field already carries the answer; a message regex is the bug.

**Rejected: treat every warning as blocking and show the log.** That is today,
and it is what the report is complaining about.

**Rejected: a modal progress dialog.** It blocks typing, and the compile is
already off the main thread. A chip in the pane is where the reader is looking.

**Rejected: put the compile state in the status bar only.** The status bar is
shared with word counts, zoom and the reading chip, and the LaTeX pane is the
surface that goes stale. The chip lives in the pane; the status bar is not
touched.

**Rejected: compile on save only.** A save is not the reader's only commit
point, and `saveSession` does not currently trigger a render at all — which is
part of why "I saved and nothing changed" was reported. Auto-compile stays
edit-driven; the plan adds a Compile command rather than repurposing Save.

## Steps

- [ ] **1. The blocking rule.** In `src/latex.ts`, replace the `blocking` filter
  with the engine's verdict: throw only when `!result.success || !result.pdf`.
  Convert `result.errors`/`result.telemetry.diagnostics` with
  `severity === "warning"` into a new `warnings` field on `LatexResult`; keep
  errors as today. Move the `File … not found` check from a throw to a warning.
  Unit-test the classifier in `latex-references-unit.mjs`'s neighbourhood: a
  log with `There were undefined references.` and a PDF must produce a result,
  not an error.
- [ ] **2. Warnings in the pane.** `renderLatexPreview` renders a
  `.latex-warnings` row above the PDF: `23 pages · 3 warnings`, a `<details>`
  with one row per warning built by the same code path as
  `latexProblemPanel` (extract the row builder rather than duplicate it), and
  each row clickable through `revealLatexProblem`. A warning mark uses a new
  `--diagnostic-warning` token and `.cm-latex-warning`, distinct from the pink
  error mark and from the amber word-sync mark.
- [ ] **3. The status chip.** Add `#preview > .latex-status` (a button) with the
  state machine, painted before the first `await` in `renderLatexPreview`, and
  removed on commit or failure. Wire `onAssetDownload` and `onLoadProgress`
  through `WasmTexCompiler`'s options in `compileLatex`, which means
  `compileLatex` gains an `onProgress` callback parameter. Clicking cancels via
  `cancelLatex()`. Styles in `src/styles.css` beside `.typst-viewbar`, with a
  `prefers-reduced-motion` rule.
- [ ] **4. Auto-compile and the Compile command.** `latexAutoCompile` in
  `settings.rs` (default `true`), `api.ts`, `preferences.ts` (a checkbox in the
  LaTeX section with help text), and `main.ts` (`applySettingsPatch`). In
  `scheduleRender`, a LaTeX document with the switch off marks stale and paints
  the chip instead of compiling. Add `view.latexCompile` to `menu.rs` with
  `CmdOrCtrl+Shift+Enter`, enabled only for a `.tex` document, plus its handler
  in `main.ts`.

  **Not `CmdOrCtrl+Enter`, which is the obvious choice and is taken.**
  CodeMirror's `defaultKeymap` — installed at `src/editor.ts:849` — binds
  `Mod-Enter` to `insertBlankLine`, so the menu accelerator would never reach
  the row. Verified: `Mod-Enter` is present in
  `@codemirror/commands`, `Shift-Mod-Enter` is absent from the commands, search
  and language keymaps, and no `Enter` accelerator exists in `menu.rs`.
- [ ] **5. Staleness.** When `previewStale` is true and a PDF is on screen, the
  chip reads *Out of date* until the next compile commits. This is the honest
  version of the "the preview keeps showing old errors" report.
- [ ] **6. The fixture.** Add `\label{fig:arquitetura}` to
  `docs/samples/Resumo-executivo.tex` at the architecture figure (or drop the
  `\ref`), so the shipped sample compiles. Leave the missing image in place —
  it is the fixture that proves the missing-reference row — and document that
  fact in the sample's own comment.
- [ ] **7. Tests and docs.** Extend `scripts/latex-preview-test.mjs` with the
  warning-does-not-block case and the chip's states; `menu-test.mjs` and
  `shortcut-test.mjs` for the new row; `dom-smoke.mjs` for the Preferences
  checkbox. Update the catalogs in `docs/agent-guide/catalog/`, the counts in
  `docs/agent-guide/testing.md`, and record the trap.

## Files and modules

| File | Why it must change |
| --- | --- |
| `src/latex.ts` | The blocking rule, `warnings` on `LatexResult`, the progress callback, the `File not found` warning. |
| `src/main.ts` | The chip, the warnings row, `renderLatexPreview`, `scheduleRender`, the Compile handler, `applySettingsPatch`. |
| `src/styles.css` | `.latex-status`, `.latex-warnings`, the warning mark, reduced motion. |
| `src-tauri/src/settings.rs` | `latex_auto_compile`, default `true`. |
| `src-tauri/src/menu.rs` | `view.latexCompile`, its accelerator, availability and label. |
| `src/api.ts` | `Settings.latexAutoCompile`, `MenuState` if the row needs a flag. |
| `src/preferences.ts` | The checkbox in the LaTeX section. |
| `index.html` | Nothing if the chip is created in JS; listed only if the element is static. |
| `docs/samples/Resumo-executivo.tex` | The missing label, so the sample compiles. |
| `scripts/latex-preview-test.mjs` | Warnings do not block; the chip's states; cancel. |
| `scripts/menu-test.mjs`, `scripts/shortcut-test.mjs` | The new row and its accelerator. |
| `scripts/dom-smoke.mjs` | The Preferences checkbox. |
| `docs/agent-guide/catalog/latex-and-formats.md` | The new layer rows and counts. |
| `docs/agent-guide/traps/latex-typst-asciidoc.md` | The trap below. |

## Risks and rollback

- **A genuinely broken PDF is now shown.** A document whose bibliography failed
  will render with an empty bibliography and a warning. That is the intended
  trade, but the warning row must be impossible to miss — a count in the pane,
  not a log line. If it proves too quiet, the fallback is a persistent banner
  rather than a disclosure.
- **The chip makes a fast compile flicker.** A sub-100 ms compile would flash
  *Compiling* and vanish. Mitigate with a 150 ms delay before the chip appears,
  and never remove it in the same frame it was added.
- **Progress callbacks fire on the compile's thread.** They must only touch the
  DOM through the existing token guard, or a cancelled compile paints over the
  next one.
- **Auto-compile off is a new way to be confused.** The *Out of date* chip and
  the Compile row are the answer; both must be visible without opening a menu,
  which is why the chip is a button.
- **The accelerator.** `CmdOrCtrl+Enter` is the natural key for "compile" and it
  is **already taken by CodeMirror's `defaultKeymap`** (`Mod-Enter` →
  `insertBlankLine`), so it would silently do nothing. `CmdOrCtrl+Shift+Enter`
  is free in the menu and in every CodeMirror keymap; verify it reaches the row
  through `shortcut-test.mjs`, which reads the `accelerators` registry — the
  only way to see an accelerator the platform rejected.
- **Rollback.** The settings key is additive with a default, so an older build
  loads the same file and ignores it. Reverting the branch restores the
  blocking rule; no document, cache or PDF is touched by the change itself.

## Tests and validation

| Layer | Command | What it proves |
| --- | --- | --- |
| Typecheck/build | `npm run build` | The new fields and callbacks compile. |
| Reference unit | `npm run latex:references:unit` | The classifier: a warning plus a PDF is a result, not an error. |
| Diagnostics unit | `npm run latex:diagnostics:unit` | The warning mark maps to the same range as the error mark. |
| LaTeX preview UI | `npm run latex:preview` | The supplied fixture renders 23 pages with its warnings listed; the chip reaches *Done*; cancel stops a compile; auto-compile off shows *Out of date* and the Compile row fixes it. |
| Menu | `npm run menu` | `view.latexCompile` is present, enabled only for `.tex`, and its label is honest. |
| Shortcuts | `npm run shortcuts` | The accelerator is registered and reaches the handler. |
| Smoke | `npm run smoke` | The Preferences checkbox exists and round-trips. |
| Rust | `cargo test --lib` via `scripts\cargo-vcvars.cmd` | The settings default and its clamp. |

The one measurement that proves it: open `docs/samples/Resumo-executivo.tex`,
and the pane must show a PDF of **23 pages** with a warnings row naming the
undefined reference — not a failure panel. `data-latex-ms` already records the
compile time; the chip's displayed duration must match it within a frame.

## Acceptance criteria

1. A compile that wrote a PDF is shown, whatever warnings it produced. The
   supplied fixture renders 23 pages.
2. Warnings are listed beside the PDF with their `file:line`, and clicking one
   reveals that line. They never replace the PDF.
3. The pane names its state — queued, compiling, downloading packages,
   rendering, done, failed, out of date — and the state is visible before the
   first `await`, so a slow compile is never a silent one.
4. A package download is reported as a count, and no document content or path
   appears in it.
5. Clicking the chip stops the compile, and the pane returns to the previous
   PDF without a partial render.
6. Auto-compile can be turned off; with it off, editing does not compile, the
   pane says it is out of date, and View › Compile (or its accelerator)
   compiles.
7. A failed compile still keeps the last readable PDF and overlays the problem
   list, as today.
8. No new dependency, no new network request, and the settings schema stays
   additive.

## Open questions

1. **Where the chip lives.** Default: inside the preview pane, top-right, beside
   where *Save PDF…* already sits. The alternative is the status bar, rejected
   above because the stale surface is the pane.
2. **Provisional first pages.** `previewColdPages` would put a real page on
   screen in a fraction of the 1.1 s. Default: **not in this change**; record it
   in `docs/backlog.md` and revisit once the chip proves the wait is the
   complaint. If it is, it is its own plan with its own cancellation rules.
3. **The warning threshold.** Should a document with 40 overfull-box warnings
   list all of them? Default: cap the disclosure at 20 with "and N more", and
   never count overfull boxes in the pane's summary — they are typographic
   noise, not a reason to distrust the PDF. Confirm if that hides too much.
4. **The fixture's missing image.** Default: keep it, because it is the only
   fixture that proves the missing-reference row. If a sample that compiles
   cleanly is wanted too, add a second file rather than weakening this one.
