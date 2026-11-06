# Command completion in the source editor

**Status:** draft (awaiting approval)

**Date:** 2026-11-06

**ADR:** one to write before merge — the completion layer's ownership of the Tab
key and its place in the extension stack. It does not supersede an existing ADR.

## Context and goal

The editor has **no completion of any kind**. `@codemirror/autocomplete` is
declared (`package.json:89`, `^6.20.3`) but only `closeBrackets` and
`closeBracketsKeymap` are imported from it (`src/editor.ts:42`). There is no
`autocompletion()` extension, no `completionKeymap`, no `CompletionSource`
anywhere in `src/`, and no tooltip styling in `src/styles.css` — the only popup
CSS is `.combo-popup`, which belongs to the AI model picker. This is not a LaTeX
gap: Markdown, Typst, HTML and AsciiDoc have no completion either.

The LaTeX plan ([2026-11-06-latex-product-integration.md](2026-11-06-latex-product-integration.md))
listed completion as step 6, conditioned on measurement, and left it unstarted.
That was the right call for that plan — completion is not a LaTeX feature, it is
an editor feature — but it leaves the largest remaining usability gap in the
product, and LaTeX is where it hurts most: `\begin{…}`, `\usepackage{…}`,
`\includegraphics{…}` and `\cite{…}` are long, unforgiving, and frequently
mistyped.

The goal: a completion layer that is **introduced once**, works for every
language the editor supports, offers LaTeX commands/environments/packages and
project references first because that is where the need is, and never touches the
network.

## What was investigated

**`codemirror-lang-latex` (TeXlyre) is not usable.** The reference implementation
is real and good — a Lezer grammar ported from Overleaf, with
`latexCompletionSource`, snippets, hover tooltips and a linter. But its licence
changed: versions 0.1.0-alpha.0 through **0.4.2 were MIT**, and **0.5.0 onward is
`AGPL-3.0-or-later`** (confirmed in the npm registry metadata and the repository
`LICENSE`). The relicensing follows the grammar's provenance: Overleaf, from
which the Lezer grammar is ported, is itself AGPL-3.0.

MDraft is MIT. Linking an AGPL parser into the shipped application would impose
AGPL's network-and-redistribution obligations on the whole product. That is a
licensing decision this project has not taken, and the existing plan already
rejected this package for exactly this reason. **Reading its approach for
reference is fine; depending on it is not.**

Two further points against it even if the licence were acceptable: it brings
`@codemirror/lint` (not currently a dependency) for diagnostics this change does
not want, and it ships a *second* LaTeX parser alongside the sTeX stream grammar
the editor already uses — two grammars that can disagree about the same buffer.

**What CodeMirror 6 gives us for free.** `@codemirror/autocomplete` exports
everything this plan needs and is already installed:
`autocompletion`, `completionKeymap`, `snippetCompletion`, `snippetKeymap`,
`completeFromList`, `ifIn`, `ifNotIn`, `CompletionContext`, `CompletionResult`,
`Completion`, `CompletionSection`, `startCompletion`, `acceptCompletion`,
`completionStatus`. Snippets with tab-stop fields come from the same package, so
no new dependency is required at all.

## Scope and non-scope

**In scope**

- The completion layer itself: `autocompletion()` in a dedicated compartment, the
  completion keymap, tooltip theming through the existing palette builder,
  screen-reader and reduced-motion behaviour, IME safety, and cancellation.
- A **LaTeX catalog**: commands, environments, packages, and snippets for the
  constructs the Format menu already inserts.
- **Project references** for LaTeX: labels (`\ref`, `\eqref`), citation keys
  (`\cite`) and image files, read from the project snapshot the backend already
  builds.
- A **Markdown catalog** as the second consumer, to prove the layer is
  language-neutral rather than a LaTeX special case: ATX headings, emphasis,
  links, tables, and the built-in Reference's own constructs.
- A preference to turn completion off, and a documented key that opens it
  explicitly.

**Out of scope**

- `codemirror-lang-latex` or any AGPL dependency, and any new npm dependency.
- Replacing the sTeX stream grammar with a Lezer grammar. Completion does not
  need a syntax tree; the catalog is a list and the context is a regex over the
  current line. A tree would give better context detection and is the right
  follow-up if this proves too coarse — recorded as an open question.
- Diagnostics, linting, hover tooltips and auto-closing environments. Those are
  separate features with their own risk; the linter in particular needs
  `@codemirror/lint` and a decision about what a "wrong" LaTeX document is.
- Typst, HTML and AsciiDoc catalogs. The layer supports them; adding their
  catalogs is follow-up work, and shipping the layer with two languages proves
  the abstraction better than four half-tested ones.
- AI-assisted completion. The assistant is a separate, opt-in, network feature
  and must not be entangled with a local catalog.

## Approach and rejected alternatives

**The layer.** One `autocompletion()` extension in a new `completionCompartment`,
reconfigured when the document language changes, exactly as `languageCompartment`
and `spellCompartment` already work (`src/editor.ts:445-460`). Configuration:

- `activateOnTyping: true`, so typing `\` or `\b` opens the list without a key.
- `closeOnBlur: true` and `maxRenderedOptions: 50`, so a large catalog cannot
  produce a thousand-row popup.
- `icons: false` — the catalog has no icon set, and a generic one adds noise.
- `aboveCursor` only when there is no room below, which is what the library
  already does; no override.

**The Tab conflict is the real integration risk.** `indentWithTab` currently owns
Tab (`src/editor.ts:768`). CodeMirror's `completionKeymap` binds Tab to
`acceptCompletion` only when a completion is active, and `indentWithTab` binds
Tab to indentation otherwise — but the two are in *different* keymaps, and
precedence decides which wins. The completion keymap must be installed with
`Prec.high` above the base keymap, and the behaviour must be verified in all four
states: no popup, popup open with a selection, popup open with no selection, and
popup closed by Escape. Getting this wrong means Tab indents instead of accepting,
or accepts instead of indenting — both are silent, and both are the kind of bug a
reader reports as "the editor broke".

**The catalog.** A bundled TypeScript module, no network, no fetch, no worker for
the static part:

- `src/completion/latex-catalog.ts` — commands with their argument shape,
  environments, packages, and snippets. Data only, so it is testable without an
  editor.
- `src/completion/markdown-catalog.ts` — the Markdown constructs.
- `src/completion/latex-context.ts` — decides *what* to offer from the text before
  the cursor: after `\` a command; inside `\begin{` an environment; inside
  `\usepackage{` a package; inside `\ref{`/`\cite{`/`\includegraphics{` a project
  reference. Pure functions over a string, so the whole decision table is a unit
  test.

**Project references are the one asynchronous part.** Labels and citation keys
come from the files the LaTeX project snapshot already reads. The completion
source must therefore be cancellable and generation-tagged, the same discipline
`src/preview/` uses: a reply that arrives after the document changed is dropped
by generation, never applied. The snapshot is read once per document and cached;
completion must not trigger a compile.

**Theming.** `buildChromeTheme` (`src/syntax-themes.ts`, used at
`src/editor.ts:952`) gains the tooltip selectors, so the popup follows every
syntax palette instead of being a hard-coded light box on a dark editor. This is
the same rule the existing chrome follows and the reason `.combo-popup` has a
`[data-theme="dark"]` block.

**Rejected alternatives**

| Candidate | Why not |
| --- | --- |
| `codemirror-lang-latex` 0.6.1 | AGPL-3.0-or-later against MDraft's MIT. The grammar is ported from Overleaf, which is AGPL, which is why the package relicensed at 0.5.0. Also pulls `@codemirror/lint` and a second LaTeX parser. |
| Pinning the MIT 0.4.2 release | The last MIT release is two minor versions behind, unmaintained, and its grammar is the same Overleaf-derived code — the licence change at 0.5.0 is evidence the author believes the port carries AGPL obligations. Relying on an older tag to escape that is not a decision to take silently. |
| A Lezer grammar of our own | Correct long-term, and the right follow-up for context detection and folding, but it is a parser project, not a completion project. Completion does not need a tree. |
| `wasmtex/lsp` | The pinned SDK ships an editor-neutral service, but adopting it drags the compiler SDK into the editor's dependency graph for a catalog that must be local. |
| Completing from the document's own words only | Useful, and `completeAnyWord` already exists, but it cannot offer `\includegraphics` to a reader who has never typed it. |
| A second, LaTeX-only completion implementation | The duplication this plan exists to avoid: two keymaps, two tooltip themes, two cancellation rules. |

## Steps

- [ ] **1. The layer.** `completionCompartment`; `autocompletion()` and
  `completionKeymap` installed with the precedence that keeps `indentWithTab`
  working; `setCompletion(enabled)` on the editor interface; the compartment
  reconfigured on language change and on the preference. Verify Tab in all four
  states, plus Escape, plus IME composition.
- [ ] **2. Theme and accessibility.** Tooltip selectors in `buildChromeTheme` for
  all nine palettes; `aria-activedescendant` and the live-region announcement the
  library emits; reduced-motion respect; a visible focus ring that survives the
  dark palettes.
- [ ] **3. The LaTeX catalog.** Commands, environments, packages and snippets as
  data. Snippets reuse the strings `src/latex-commands.ts` already inserts, so
  Format › Table and typing `\begin{table}` cannot disagree.
- [ ] **4. LaTeX context.** The pure decision table: command, environment,
  package, label, citation, image path. Unit-tested without an editor, including
  the cases that must offer nothing — inside a `%` comment, inside `verbatim`,
  after `\\` (a line break, not a command).
- [ ] **5. Project references.** Labels, citation keys and image files from the
  cached project snapshot, generation-tagged and cancellable, with a test that a
  stale reply is dropped.
- [ ] **6. The Markdown catalog.** The second consumer, proving the layer is
  language-neutral.
- [ ] **7. Preference and documentation.** A `completion` setting in
  `settings.json` (default on), a Preferences row, the LaTeX Reference and
  `docs/latex.md` updated, `AGENTS.md` script and test rows.
- [ ] **8. Measurement and close.** Typing latency with the popup open and closed
  on the 1.2 MB fixture, popup open latency on the LaTeX project, and the
  installer delta (expected zero). Record the numbers in this plan.

## Files and modules

Frontend:

- `src/editor.ts` — the compartment, the keymap precedence, `setCompletion`.
- `src/completion/layer.ts` (new) — the `autocompletion()` configuration and the
  language dispatch.
- `src/completion/latex-catalog.ts` (new), `src/completion/markdown-catalog.ts`
  (new) — data only.
- `src/completion/latex-context.ts` (new) — the decision table.
- `src/completion/project-index.ts` (new) — labels, citations and images from the
  cached snapshot, generation-tagged.
- `src/syntax-themes.ts` — tooltip chrome for every palette.
- `src/styles.css` — any selector the theme builder cannot express.
- `src/preferences.ts` — the completion row.
- `src/api.ts` — the `completion` setting field.
- `src/latex.ts` — expose the cached snapshot's references to the index.

Rust:

- `src-tauri/src/settings.rs` — `completion: bool`, default `true`, additive.

No new dependency. `@codemirror/autocomplete` is already declared and installed.

## Risks and rollback

- **The Tab key.** The highest-risk part, and the reason step 1 is separate. A
  wrong precedence silently breaks indentation or acceptance. Mitigated by
  testing all four popup states in `shortcut-test.mjs` and by keeping the
  completion keymap on its own precedence level rather than merging it into the
  base keymap.
- **Typing latency.** A catalog searched on every keystroke is a per-character
  cost. Mitigated by `maxRenderedOptions`, by filtering on a prefix rather than a
  fuzzy match, and by measuring in step 8. The layer must not run when the
  preference is off.
- **A noisy popup.** Completion that opens on every word is worse than none. The
  context table decides when to open, and it must offer nothing in prose — the
  same conservatism `scoreLatex` uses.
- **Project references.** Reading the snapshot on demand could trigger a compile
  or a slow disk read. Mitigated by using the already-cached snapshot and by
  never compiling from completion.
- **Licence.** No AGPL code enters the tree. This is the constraint that shaped
  the whole approach and must survive review.

**Rollback** is a branch revert plus turning the preference off. The setting is
additive with a default, so an older build loads the same `settings.json`.

## Tests and validation

- `completion:unit` (new, no application) — the LaTeX and Markdown catalogs, the
  context decision table (including the offer-nothing cases), snippet shapes
  matching `latex-commands.ts`, project-index generation tagging, and the
  assertion that **no completion module imports anything that can reach the
  network**.
- Extend `shortcut-test.mjs` (47) — Tab in all four popup states, Escape, and
  that `Ctrl+Space` opens the list explicitly.
- Extend `format-document-test.mjs` (143) — that a snippet inserts exactly the
  construct the Format menu inserts.
- Extend `menu-test.mjs` (150) — the Preferences row exists and persists.
- Extend `syntax-theme-test.mjs` (10) — the popup is legible on a dark palette.
- A hidden Tauri run on the LaTeX project: typing `\beg` offers `\begin`, `\ref{`
  offers the project's labels, a stale reply after an edit paints nothing.
- Update every count in `AGENTS.md` in the same change.

The measurement that proves it works: typing latency with the popup closed is
unchanged from today, typing latency with it open stays within the existing
`preview:perf` budget, and the installer delta is zero.

## Acceptance criteria

- Typing `\` in a `.tex` document offers commands; `\begin{` offers environments;
  `\usepackage{` offers packages; `\ref{`, `\cite{` and `\includegraphics{` offer
  the project's own labels, keys and images.
- Tab accepts a completion when the popup is open and indents when it is not, in
  every language, with no change to existing indentation behaviour.
- The popup is legible in every syntax palette, announces itself to a screen
  reader, and respects reduced motion.
- Nothing is offered inside a comment, inside `verbatim`, or in prose where no
  construct could follow.
- Completion never makes a network request; the preference turns it off entirely.
- Typing latency and installer size are unchanged by measurement, not by
  assumption.

## Open questions

- **Fuzzy or prefix matching?** Prefix is predictable and cheap; fuzzy finds
  `\includegraphics` from `inc`. If no answer, prefix stands and fuzzy is a
  follow-up measured on its own.
- **Should the catalog include the whole of LaTeX, or a curated set?** A curated
  set of a few hundred entries covers what people write; a complete list is
  thousands and makes the popup worse. If no answer, curated, with the list
  living in one file so extending it is a data change.
- **Is a Lezer grammar now worth it?** Completion works without one. A tree would
  improve context detection (knowing it is inside a `tabular`, say) and would
  finally enable folding for LaTeX. That is a separate plan with its own
  licensing question, since the good grammar is the AGPL one.
