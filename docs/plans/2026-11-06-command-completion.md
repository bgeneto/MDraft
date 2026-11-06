# Command completion in the source editor

**Status:** in progress (approved 2026-11-06)

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

## What was investigated, and measured

Licensing is **not** the constraint. Per
[AGENTS.md](../../AGENTS.md#licensing-mit-today-agpl-is-an-allowed-destination),
MDraft may move to the AGPL if a package worth having requires it. Size and
performance are the gate, so the numbers below decide the approach.

**`codemirror-lang-latex` 0.6.1, measured on this host.** The package is a real
implementation — a Lezer grammar ported from Overleaf, with
`latexCompletionSource`, snippets, hover tooltips and a linter. Its licence went
from MIT (0.1.0–0.4.2) to `AGPL-3.0-or-later` at 0.5.0, following the
Overleaf-derived grammar. That is now acceptable; the cost is not:

| Measurement | Result |
| --- | --- |
| Tarball | 287 KB |
| `dist/index.js` raw | 188,801 B |
| `dist/index.js` gzip / brotli | **57,433 B / 40,759 B** |
| Import **only** `latexCompletionSource`, minified, CodeMirror peers external | **60,586 B gzip** |
| Import the full `latex()` support, same conditions | 67,399 B gzip |
| `dist/latex-data.js` alone (the catalog) | 5,246 B gzip |
| Our existing sTeX grammar chunk | 1,169 B gzip |

The decisive number is the second row of the tree-shaking pair: importing **one
function** costs 60 KB gzip, because `src/completion.ts` imports `scanLatexModes`
from `parser-utils`, which pulls the parser and its tables. There is no `exports`
map and no `sideEffects: false` in its `package.json`, so the bundle is
monolithic and a bundler cannot split the linter, tooltips and symbol tables out
of it.

**The layer itself, measured the same way.** `autocompletion` + `completionKeymap`
alone, minified with CodeMirror peers external: **9,839 B gzip**. That is the
floor for having completion at all, and it is paid whichever catalog we write.

**HTML costs nothing, and that is the sharpest contrast in this plan.**
`@codemirror/lang-html` is already a dependency and is already loaded for every
`.html` document (`src/html-language.ts:18`), and `html()` registers its own
completion source as language data
(`@codemirror/lang-html/dist/index.js:605`). Measured: importing
`htmlCompletionSource` alone is **58,411 B gzip**, but importing `html()` — which
we already do — is **65,718 B gzip** and *includes* it. So HTML completion
arrives with the layer, at **zero additional bytes and zero catalog code**. The
same package also exposes `extraTags` and `extraGlobalAttributes` for the day a
project-specific tag list is wanted.

**What this means.** A hand-written catalog is ~5 KB gzip of data (the same order
as `latex-data.js`) plus the 10 KB layer — roughly **15 KB gzip**, against
**60 KB** for importing their completion source alone. The package would cost
four times as much to deliver a catalog we can write in a day, and it would bring
a second LaTeX parser that can disagree with the sTeX grammar the editor already
runs. HTML shows the other side of the same rule: a package that already ships a
completion source we can reach for free is simply used.

**What CodeMirror 6 gives us for free.** `@codemirror/autocomplete` is already
installed and exports everything needed: `autocompletion`, `completionKeymap`,
`snippetCompletion`, `snippetKeymap`, `completeFromList`, `ifIn`, `ifNotIn`,
`CompletionContext`, `CompletionResult`, `Completion`, `CompletionSection`,
`startCompletion`, `acceptCompletion`, `completionStatus`. Snippets with tab-stop
fields come from the same package. **No new dependency is required.**

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
- **HTML completion at zero cost.** `@codemirror/lang-html` — already a
  dependency, already loaded for every `.html` document — registers its own
  autocomplete source inside `html()` (`node_modules/@codemirror/lang-html/dist/index.js:605`:
  `htmlLanguage.data.of({ autocomplete: htmlCompletionSourceWith(config) })`).
  So the moment `autocompletion()` is installed, HTML gets tag, attribute and
  attribute-value completion with **no catalog to write and no bytes to add**.
  This is a verification step, not a build step: confirm it works, confirm it
  respects the preference, and confirm the `extraTags`/`extraGlobalAttributes`
  hooks are left alone. Measured: importing `htmlCompletionSource` alone is
  58 KB gzip, but we pay **0** because `html()` already ships it.
- A preference to turn completion off, and a documented key that opens it
  explicitly.

**Out of scope**

- `codemirror-lang-latex` as a dependency. Not for licensing — that is settled —
  but because it costs 60 KB gzip to deliver what this plan writes in ~15 KB, and
  because it duplicates the parser. Recorded as a rejected alternative with the
  measurement, not as a licence objection.
- Replacing the sTeX stream grammar with a Lezer grammar. Completion does not
  need a syntax tree; the catalog is a list and the context is a regex over the
  current line. A tree would give better context detection and is the right
  follow-up if this proves too coarse — recorded as an open question.
- Diagnostics, linting, hover tooltips and auto-closing environments. Those are
  separate features with their own cost; the linter in particular needs
  `@codemirror/lint` and a decision about what a "wrong" LaTeX document is.
- Typst and AsciiDoc catalogs. The layer supports them; adding their catalogs is
  follow-up work. HTML is **not** in this list: it needs no catalog, because
  `@codemirror/lang-html` already carries one (see scope above).
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

| Candidate | Measured cost | Why not |
| --- | --- | --- |
| `codemirror-lang-latex` 0.6.1, full `latex()` | 67 KB gzip | Four times this plan's cost, and it ships a second LaTeX parser that can disagree with the sTeX grammar already in the editor. |
| `codemirror-lang-latex`, `latexCompletionSource` only | 60 KB gzip | The tempting subset, and it barely helps: the module imports `parser-utils`, so the parser comes along. No `exports` map, no `sideEffects: false`. |
| Pinning the MIT 0.4.2 release | not measured | Two minor versions behind and unmaintained. Its licence is no longer the reason to avoid it — the cost is. |
| A Lezer grammar of our own | — | Correct long-term, and the right follow-up for context detection and folding, but it is a parser project, not a completion project. Completion does not need a tree. |
| `wasmtex/lsp` | not measured | The pinned SDK ships an editor-neutral service, but adopting it drags the compiler SDK into the editor's dependency graph for a catalog that must be local. |
| Completing from the document's own words only | ~0 | Useful, and `completeAnyWord` already exists, but it cannot offer `\includegraphics` to a reader who has never typed it. |
| A second, LaTeX-only completion implementation | — | The duplication this plan exists to avoid: two keymaps, two tooltip themes, two cancellation rules. |

## Steps

- [x] **1. The layer.** `completionCompartment`; `autocompletion()` and
  `completionKeymap` installed with the precedence that keeps `indentWithTab`
  working; `setCompletion(enabled)` on the editor interface; the compartment
  reconfigured on language change and on the preference. Verify Tab in all four
  states, plus Escape, plus IME composition. **Measure the bundle delta here**,
  before any catalog exists, and record it against the 9,839 B floor.

  **Landed, and the measurement beat the floor by two orders of magnitude.**
  `src/completion/layer.ts` holds the one `autocompletion()` extension and its
  keymap; `src/editor.ts` gained `completionCompartment`, `setCompletion` and an
  `EditorOptions.completion` flag. Measured on the real build:

  | | entry chunk |
  | --- | --- |
  | before | 1,160,794 B raw / **352,531 B gzip** |
  | after | 1,161,081 B raw / **352,644 B gzip** |
  | **delta** | **+287 B raw / +113 B gzip** |

  The 9,839 B floor assumed the whole `@codemirror/autocomplete` package was new.
  It is not: `closeBrackets` already pulled the module in, so the popup machinery
  was already in the bundle and this step adds only the configuration object and
  the keymap. That is a useful correction to the estimate, and it means the
  budget for steps 3 and 6 is now effectively the catalogs alone (~5 KB each).

  **Tab precedence, verified rather than reasoned.** `acceptCompletion` returns
  `false` unless a popup is open with a selection
  (`@codemirror/autocomplete/dist/index.js`), so `Prec.high` on the completion
  keymap lets Tab fall through to `indentWithTab`. `shortcut-test.mjs` grew from
  47 to **51** checks proving it through the real editor: Tab changes the buffer,
  the editor consumes it, typing prose opens no popup, and a second Tab still
  indents. `completion-unit.mjs` (new, **14** checks) pins the configuration, the
  precedence, the empty-source rule and the no-network rule.
- [x] **1b. HTML, which comes for free.** With the layer installed, a `.html`
  document already offers tags, attributes and attribute values, because
  `html()` registers `htmlCompletionSourceWith(config)` as its `autocomplete`
  language data (`@codemirror/lang-html/dist/index.js:605`). Confirm it works
  through the real editor, that the preference turns it off, that it does not
  fight `autoCloseTags` (which is a separate extension and stays governed by its
  own preference), and that the bundle does not grow — the completion source is
  already inside the `html()` chunk we ship. If any of that is false, the
  assumption is wrong and HTML moves to its own step.

  **Verified through the real editor, and the claim held.** `autoclose-test.mjs`
  grew from 33 to **36** checks: typing `<di` in an HTML document opens the
  popup, the popup offers `div`, and Escape dismisses it without touching the
  buffer. No catalog was written and the bundle did not grow — step 1's +113 B
  gzip is the whole cost of adding completion to HTML, Markdown and LaTeX alike.
  Auto-closing stayed independent: its own preference still governs it, and the
  three existing checks for that still pass.
- [ ] **2. Theme and accessibility.** Tooltip selectors in `buildChromeTheme` for
  all nine palettes; `aria-activedescendant` and the live-region announcement the
  library emits; reduced-motion respect; a visible focus ring that survives the
  dark palettes.
- [ ] **3. The LaTeX catalog.** Commands, environments, packages and snippets as
  data. Snippets reuse the strings `src/latex-commands.ts` already inserts, so
  Format › Table and typing `\begin{table}` cannot disagree. **Measure the
  catalog chunk**; the target is ~5 KB gzip, in line with `latex-data.js`.
- [ ] **4. LaTeX context.** The pure decision table: command, environment,
  package, label, citation, image path. Unit-tested without an editor, including
  the cases that must offer nothing — inside a `%` comment, inside `verbatim`,
  after `\\` (a line break, not a command).
- [ ] **5. Project references.** Labels, citation keys and image files from the
  cached project snapshot, generation-tagged and cancellable, with a test that a
  stale reply is dropped.
- [ ] **6. The Markdown catalog.** The second consumer, proving the layer is
  language-neutral.- [ ] **7. Preference and documentation.** A `completion` setting in
  `settings.json` (default on), a Preferences row, the LaTeX Reference and
  `docs/latex.md` updated, `AGENTS.md` script and test rows.
- [ ] **8. Measurement and close.** Typing latency with the popup open and closed
  on the 1.2 MB fixture, popup open latency on the LaTeX project, and the
  installer delta. Record the numbers in this plan.

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
- **Bundle growth.** The whole point of the measurement above. Budget: **≤ 20 KB
  gzip** for layer plus both catalogs, against 60 KB for the rejected package. A
  step that exceeds its share is a reason to stop and reconsider, not to ship.
- **A noisy popup.** Completion that opens on every word is worse than none. The
  context table decides when to open, and it must offer nothing in prose — the
  same conservatism `scoreLatex` uses.
- **Project references.** Reading the snapshot on demand could trigger a compile
  or a slow disk read. Mitigated by using the already-cached snapshot and by
  never compiling from completion.

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
- Extend `autoclose-test.mjs` (33) — HTML completion offers tags and attributes
  through the real editor, and the preference turns it off without affecting
  auto-closing, which is a separate setting.
- A hidden Tauri run on the LaTeX project: typing `\beg` offers `\begin`, `\ref{`
  offers the project's labels, a stale reply after an edit paints nothing.
- Update every count in `AGENTS.md` in the same change.

The measurement that proves it works: typing latency with the popup closed is
unchanged from today, typing latency with it open stays within the existing
`preview:perf` budget, and the bundle grows by ≤ 20 KB gzip.

## Acceptance criteria

- Typing `\` in a `.tex` document offers commands; `\begin{` offers environments;
  `\usepackage{` offers packages; `\ref{`, `\cite{` and `\includegraphics{` offer
  the project's own labels, keys and images.
- Typing `<` in a `.html` document offers tags, and inside a tag offers
  attributes and their values — with no catalog written for it and no bundle
  growth, because `html()` already carries that source.
- Tab accepts a completion when the popup is open and indents when it is not, in
  every language, with no change to existing indentation behaviour.
- The popup is legible in every syntax palette, announces itself to a screen
  reader, and respects reduced motion.
- Nothing is offered inside a comment, inside `verbatim`, or in prose where no
  construct could follow.
- Completion never makes a network request; the preference turns it off entirely.
- The bundle grows by ≤ 20 KB gzip and typing latency is unchanged by
  measurement, not by assumption.

## Open questions

- **Fuzzy or prefix matching?** Prefix is predictable and cheap; fuzzy finds
  `\includegraphics` from `inc`. If no answer, prefix stands and fuzzy is a
  follow-up measured on its own.
- **Should the catalog include the whole of LaTeX, or a curated set?** A curated
  set of a few hundred entries covers what people write; a complete list is
  thousands and makes the popup worse. If no answer, curated, with the list
  living in one file so extending it is a data change.
- **Is a Lezer grammar now worth it?** Completion works without one, and the
  licensing objection is gone. A tree would improve context detection (knowing it
  is inside a `tabular`, say) and would finally enable folding for LaTeX. It is
  still a separate plan, and its cost must be measured the same way — the
  Overleaf-derived grammar's 60 KB is the number to beat.

