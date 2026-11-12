# Emmet abbreviations in HTML and CSS documents

**Status:** done (approved 2026-11-12; open questions took their stated defaults). Typing latency and the installer size delta were not measured; see Results.
**Date:** 2026-11-12
**ADR:** none (the implementation-location decision is recorded here; promote it to an ADR if you want it to outlive the plan)

## Context and goal

MDraft edits HTML (`html`) and, since the web-source-files change, CSS (`css`) documents, but every tag and every declaration is typed in full. The editor has tag auto-closing and a completion popup, and no abbreviation expansion. A reader coming from VS Code, Sublime or JetBrains expects `ul>li.item$*3` + Tab to produce the list, and `m10` + Tab to produce `margin: 10px;`.

Goal: in HTML and CSS documents, **Tab expands the Emmet abbreviation that ends at the caret** into a CodeMirror snippet (tab stops included), and Tab keeps indenting when there is nothing to expand. It is offline, adds no start-up work, and loads its code only when an HTML or CSS document is opened.

## Scope and non-scope

In scope:

- Markup abbreviations in `html` documents, in text context only (not inside a tag, an attribute value, a comment, `<script>` or the doctype).
- Stylesheet abbreviations in `css` documents (property position inside a rule block, and `@` snippets at top level), and in `html` documents inside `<style>` text and `style="…"` attribute values (inline output: no line breaks).
- A preference, on by default, to turn the Tab behaviour off.

Not in scope (each would be its own plan):

- Markdown, AsciiDoc, Typst, LaTeX, JavaScript and JSON documents, and HTML or CSS inside Markdown code fences. Tab already indents lists in Markdown, and prose is full of strings that look like abbreviations.
- JSX, Vue, Pug, Slim, Haml, SCSS, Sass and LESS. MDraft has no document type for them.
- A live abbreviation underline or preview tooltip, and the other Emmet actions (Wrap with Abbreviation, Balance, Go to Edit Point, Increment Number, Toggle Comment, …). They need menu and shortcut decisions of their own.
- User-defined Emmet snippets (`snippets.json`).
- Any change on the Rust side other than one settings field. No new `#[tauri::command]`.

## Approach and rejected alternatives

**Chosen: the `emmet` npm package (the reference implementation) plus a thin MDraft-owned CodeMirror extension, `src/emmet.ts`.** The package supplies the two algorithms that matter: `extract(line, caret, {type})` finds the abbreviation before the caret, and `expand(abbr, config)` produces the text, with `output.field` hooked to emit `${1:name}` tab stops. MDraft supplies the rest: deciding from the Lezer syntax tree whether the caret is somewhere an abbreviation is allowed (markup, stylesheet, or nothing), a Tab command inserted with `snippet()` from `@codemirror/autocomplete`, and the compartment wiring. The module is loaded on demand, the way `html-language.ts` is, and installed in a compartment from `setLanguage`. Tab runs the command at `Prec.high`, *below* the existing `tabAccepts` binding in `src/completion/layer.ts`, so an open completion popup still accepts first and Tab still indents when the command declines.

### Findings behind the choice

All of these were checked on 2026-11-12; sizes use the rolldown bundled in this repository, minified, with the CodeMirror packages external.

| Candidate | What I found | Verdict |
| --- | --- | --- |
| Rust crate `emmet` | Version 0.0.0; `lib.rs` is 8 lines. | A placeholder. |
| Rust `vix-emmet` 2.0.2 | 350-line "pragmatic subset"; `rust-version` 1.97; licence is an OR-list that includes GPL-2.0/GPL-3.0. | Too small, and the licence needs a decision of its own. |
| Rust `glyf-core` 0.5.0 | HTML and JSX only; "inspired by Emmet". | No stylesheet abbreviations. |
| Rust `codemmet-core` 0.5.0 | 15k lines, tree-sitter and LSP oriented. I read its metadata and size, not its source. | Not a port of the reference algorithm. |
| **Any Rust route** | The decision "is the caret somewhere an abbreviation is allowed" needs the Lezer syntax tree, which only exists in the frontend. Each Tab would become an async `invoke` round trip through a new `#[tauri::command]` (a public-contract change), plus a `src/api.ts` wrapper, a cargo dependency against the binary-size plan, and a second implementation of a ruleset the JavaScript reference already keeps current. There is no second consumer on the Rust side. | **Rejected.** |
| `@emmetio/codemirror6-plugin` 0.4.2 (MIT, published 2026-10-29, author-maintained) | Full feature set (tracker, preview, wrap, balance…). It also has problems that would land on this project, listed below (the second, as first written, was wrong). | **Rejected for now**; the fallback if you want live preview. |
| `emmet` 2.4.11 (MIT, published 2024-09-23, two `@emmetio/*` dependencies, `@emmetio/scanner` transitively) | The same engine the plugin and the other editors use. `expand` and `extract` are exported; `output.field`, `output.text` and `output.indent` are configurable. | **Chosen.** |

**Bundle cost** (raw / gzip, lazy chunk):

| Entry | Raw | Gzip |
| --- | --- | --- |
| `emmet` core: `expand` + `extract` | 71.5 KB | 25.4 KB |
| Plugin: only `expandAbbreviation`, `abbreviationTracker`, `emmetConfig` | 88.8 KB | 31.5 KB |
| Plugin: everything | 103.4 KB | 36.0 KB |

Both are under the 60 KB gzip yardstick in [workflow.md](../agent-guide/workflow.md#measuring-a-dependency). These are rolldown numbers, not the real Vite chunk; step 1 repeats the measurement in the real build and adds the other two costs the workflow guide requires (typing latency, installer size).

**The problems with the official plugin** (three stand; the second was corrected during implementation):

1. **A check that I expect to fail only in a release build.** `hasSnippet()` in its tracker detects an active snippet by `item.constructor?.name === 'ActiveSnippet'`. `class ActiveSnippet` is in the `@codemirror/autocomplete` source, but the minified `dist/` that is in this checkout (built today) contains the autocomplete code and no `ActiveSnippet` string, so the class is renamed. If the check is always false in a shipped build, then typing inside an expansion field would start abbreviation tracking and Tab would expand the typed word instead of moving to the next tab stop, while `tauri dev` behaves correctly. The missing string is verified; the consequence is read from the source and not run.
2. ~~**Indentation is hard-coded.**~~ **Withdrawn.** `getOutputOptions` does set `output.indent` to a tab, but `snippet()` turns each leading tab into the editor's `indentUnit` and adds the line's own indentation, so tab-indented output is exactly right. I reached the wrong conclusion by reading the plugin's option beside `indentUnit.of("  ")` without reading the consumer; the chosen route relies on the same behaviour. Recorded in `docs/agent-guide/traps/editor-and-ui.md`.
3. **Undeclared peers.** `plugin.js` statically imports `@codemirror/lang-css` and `@codemirror/lang-javascript`. Neither is a direct dependency here, so `knip --include dependencies,unlisted` would fail until both were added.
4. **More UI to own.** An underline mark, a preview tooltip that builds nested editors, an "Emmet abbreviation" row injected into the completion popup (it vanishes when the completion preference is off), tag-pair marking and auto-rename defaulting on beside MDraft's own tag handling, and a replacement `cssCompletion`. Each needs theming across the 8 syntax themes and a test.

The cost of the chosen route is that **MDraft owns the context rules** (step 2) and gets no live preview. The plugin's `lib/context.ts` and `lib/syntax.ts` are MIT and are the reference to check my rules against.

## Steps

- [ ] 1. **Measure before adding.** Add `emmet` at an exact version, build, and record in this plan: the lazy chunk's raw and gzip size in the real Vite build, whether it shares the existing `lang-css`/`lang-javascript` chunks, typing latency on the `preview:perf` 1.2 MB fixture with the feature on and off, and the staged binary size before and after. Stop and report if the chunk exceeds ~35 KB gzip. **Partly done:** the chunk size is measured; typing latency and the installer delta are not (see Results).
- [x] 2. **`src/emmet.ts`, the pure core.** `emmetContext(state, pos)` returns `markup`, `stylesheet` (with `inline` for `style=""`), or `null`, using `ensureSyntaxTree` with a short timeout; an unknown or partial tree returns `null`, so the command declines and Tab indents ("fail safe, not silent"). `expandAt(state, pos)` runs `extract` on a bounded window of the line, then `expand` with `output.field` mapped to snippet fields, `output.indent` a tab (the snippet converts it to `indentUnit`), `output.text` escaping braces, and `output.format` off for inline CSS. Literal `$`, `{` and `}` in expanded text are escaped for `snippet()`.
- [x] 3. **The Tab command and extension.** Act only on a single empty selection; insert with `snippet()` as one undo step; place the binding at `Prec.high` below `tabAccepts`.
- [x] 4. **Loader and wiring in `src/editor.ts`.** A cached dynamic import (as in `html-language.ts`), an `emmetCompartment`, a `setEmmet(enabled)` method, and a hook in `setLanguage` that installs the extension for `html` and `css` and removes it for every other kind, behind the existing `languageGeneration` guard.
- [x] 5. **The preference, end to end** (the five-file recipe in [AGENTS.md](../../AGENTS.md#adding-a-preference-end-to-end)): `settings.rs` field `emmet`, default `true`, with a Rust test that an older file keeps loading; `Settings` in `src/api.ts`; a checkbox in `src/preferences.ts` beside "Auto-close HTML tags"; `applySettingsPatch` and the initial editor options in `src/main.ts`; the exercise in `scripts/dom-smoke.mjs`.
- [x] 6. **Tests**: `scripts/emmet-unit.mjs` (app-free) and `scripts/emmet-test.mjs` (real editor over CDP), both registered in `package.json`, `scripts/test-all.mjs`, `docs/agent-guide/testing.md` and `docs/agent-guide/catalog/editor-and-documents.md`. Update the layer count in `AGENTS.md` and `testing.md`.
- [x] 7. **Documentation**: README and the site feature list where HTML and CSS editing are described, then `npm run site`. (README updated; the site lists no editor-level feature at this granularity, so it and `npm run site` were left alone.)
- [x] 8. **Traps**: record anything that cost time in `docs/agent-guide/traps/`, as the repository requires.

### Results and deviations (2026-11-12)

**Built.** `src/emmet.ts` (context rules, expansion, Tab command), `src/emmet-language.ts` (the lazy import), the `emmetCompartment` and `setEmmet` in `src/editor.ts`, and the preference through `settings.rs`, `src/api.ts`, `src/preferences.ts` and `src/main.ts`. `emmet` 2.4.11 is pinned exactly; the lockfile gained `emmet` and three `@emmetio/*` helpers, all MIT, and nothing else.

**Measured (step 1, partly).** The real Vite build emits `emmet.es-<hash>.js`, 71.4 KB raw and 25.4 KB gzip (`gzip -9`; Vite prints 25.87 KB), a separate chunk that no static import reaches. That agrees with the rolldown estimate above and is well under the 35 KB stop line. **Not measured:** typing latency on the `preview:perf` fixture, and the staged binary size before and after. The release binary is 19.0 MB with the change, but no baseline build was made to compare it with; the new chunk is 71 KB raw inside it. The extension does no work per keystroke, only on Tab, so no latency change is expected, but that is a prediction and not a measurement.

**Deviations from the plan as approved.**

1. *Indentation.* The plan counted the plugin's hard-coded tab indent as a defect. It is not: `snippet()` converts tabs to `indentUnit`. The chosen route depends on that, and `emmet-unit.mjs` proves it under two-space, four-space and tab units. Corrected above and recorded as a trap.
2. *Final tab stop.* Added, not planned. CodeMirror snippets have no implicit last stop, so Tab on the last field went nowhere. `expandAt` appends `${0}` when a template has numbered fields and no final stop.
3. *`output.text`.* The plan said literal `$`, `{` and `}` would be escaped. Only braces need it (`#{` and `${` start fields); the engine's own `$` numbering and `${1}` field syntax are Emmet semantics and are left alone.
4. *`tsconfig.json`.* Touched, which the plan did not list: `emmet`'s `exports` has no `types` condition, so `paths` maps the specifier to the shipped typings (trap recorded).
5. *Unit test and `@codemirror/lang-css`.* The CSS grammar is not a direct dependency, so `emmet-unit.mjs` loads it through `@codemirror/language-data`, the way the editor does, rather than add a dependency for a test.
6. *CSS context rules.* Settled from the parse trees, not guessed: a half-typed property parses as a selector, so the rule is structural (see the trap). Value-position abbreviations stay out, as planned.
7. *Layer count.* `AGENTS.md` and `testing.md` said fifty-nine layers; `node scripts/test-all.mjs --list` showed eighty before this change. Both now say eighty-two, which is the real number with the two new layers, and the catalog rows for the two Emmet layers were added. The `npm run smoke` rows said 119 and the suite has 122 checks with the two new ones, so it had already drifted.
8. *Site.* `site/` and `npm run site` were left alone; the page lists no editor-level feature at this granularity. The README HTML bullet carries the description.
9. *Open questions.* All took their defaults: thin extension, an open popup accepts Tab first, no value-position abbreviations, default on, no new notice file.
10. *The syntax-tree lookup.* Found only by the first real run, not planned for: `Tree.resolveInner` keeps a per-tree cache of its last result, so after another feature queried the tree at a different position it stopped entering the CSS inside `style="…"`, and Tab indented instead of expanding. A unit test on a freshly built state cannot see it. `emmetContext` now uses `tree.topNode.resolveInner`, and `emmet-unit.mjs` warms the cache four ways before asking (it fails without the fix). Trap recorded. `src/code-context.ts` and other callers of `syntaxTree(state).resolveInner` were not audited for the same exposure.
11. *`StyleText` guard.* Added to the nodes that mean "not markup text": a `<style>` body whose CSS has not mounted would otherwise be read as markup, and `@m` would become a tag.
12. *Test fixes.* The first `dom-smoke` check clicked a checkbox that the panel had already replaced, so its "restore" never happened; it now looks the row up again. `emmet-test.mjs` was otherwise unchanged by the runs.

**Verified.** `npx tsc --noEmit` clean; `npm run build` succeeds; ESLint clean on every changed file (the full run shows only the two `no-control-regex` errors already recorded in the npm-lock plan); Prettier clean on every changed file (the repo-wide check still lists the same 14 existing files); `npm run knip` clean. `npm run emmet:unit` 93/93; `completion:unit` 30/30, `autoclose:unit` 17/17, `test:sessions` 60/60, `p0:unit` 162/162 and `typography:unit` 27/27 still pass. The new Rust test `settings::tests::emmet_defaults_on_and_an_older_file_keeps_loading` passes. A temporary page in the in-app browser (a Vite dev server on a scratch entry, since deleted) drove the real editor with key events: `ul>li*3` + Tab gave the indented list; a word typed in a field and Tab walked the fields to a final stop after `</ul>`; one Ctrl+Z restored `ul>li`; in CSS `m10` gave `margin: 10px;` and, with the `pos` popup open, Tab accepted `position` and did not expand; Tab inside `<div cl` only indented; `setEmmet(false)` and `setEmmet(true)` took effect with no reopen; and after `setLanguage('markdown')` Tab only indented.

**Verified on the release binary.** Once the installed MDraft was closed, `scripts/test-all.mjs` rebuilt the release binary and ran the UI layers: `smoke` 122/122 and `emmet` 28/28. The first run of those two failed one check each — the style-attribute expansion (deviation 10) and the preference restore (deviation 12) — and a third run that overlapped other UI activity on the machine failed more checks for unrelated reasons and was green on the next quiet run (traps recorded). Thirteen other editor-related layers then ran against the same binary and all passed: `typewriter` 21/21, `autoclose` 43/43, `paste` 95/95, `html` 65/65, `spellcheck` 3/3, `format-document` 152/152, `links` 18/18, `shortcuts` 52/52, `menu` 172/172, `tabs` 113/113, `favorites` 56/56, `recent-menu` 26/26 and `licence` 4/4. The CDP test's `a {` + Enter path, which relies on `closeBrackets` adding the `}`, is exercised by `emmet` and passes.

**Not verified.**

- The full `npm test` run (82 layers) was not done; the thirteen layers above were chosen because they exercise the editor, Tab, completion, HTML and tab switching.
- Typing latency and the installer delta, as above.
- Rust: 81 tests in the full `cargo test` fail with `Os { code: 5, kind: PermissionDenied }` when creating temporary directories, across modules this change did not touch (`documents`, `images`, `print`, `export`, `ai::secret`, and three file-writing tests in `settings`). Re-running two of them against the original `settings.rs` fails the same way, so this session's environment, not the change, is the cause; 318 others pass, including the new one.

## Files and modules

- `package.json`, `package-lock.json`: add `emmet` (exact pin, like the other dependencies); no other package is added.
- `src/emmet.ts` (new): context rules, expansion, Tab command, extension factory.
- `src/emmet-language.ts` (new, or folded into `emmet.ts`): the cached lazy import. `editor.ts` and `main.ts` must not import `emmet` statically; `emmet-unit.mjs` asserts it.
- `src/editor.ts`: compartment, option, `setEmmet`, the `setLanguage` hook, and the `EditorHandle` type.
- `src/main.ts`: initial option and `applySettingsPatch` (near the existing `completion` lines).
- `src/api.ts`, `src/preferences.ts`: the `emmet` setting and its checkbox.
- `src-tauri/src/settings.rs`: one field, its default, one test. Unknown keys are already ignored by older builds (no `deny_unknown_fields` in the file).
- `scripts/emmet-unit.mjs`, `scripts/emmet-test.mjs` (new); `scripts/dom-smoke.mjs`, `scripts/test-all.mjs` and `package.json` scripts.
- `docs/agent-guide/testing.md`, `docs/agent-guide/catalog/editor-and-documents.md`, `AGENTS.md` (layer count), README, `site/`.
- This plan: ticked as it is executed, deviations recorded in it.

## Risks and rollback

- **Tab now does something new in HTML and CSS.** Anyone who typed a word and pressed Tab to indent will get an expansion. The preference turns it off; the default is on because that is the feature.
- **Tab versus the completion popup.** In CSS, `lang-css` opens a property-name popup while typing, so `pos` + Tab accepts the `position` row and does not expand `pos`. In HTML the popup only opens inside tags, where Emmet is inactive. This is the proposed behaviour (see open questions), and it is the case most likely to surprise an Emmet user.
- **Wrong context.** A misread tree could expand inside an attribute or a comment. The command returns `null` on any doubt, and the unit table below pins the negative cases.
- **Snippet field syntax.** `snippet()` parses `${…}`; an abbreviation whose text contains `$`, `{` or `}` must be escaped, or it silently loses text. Covered by a unit case.
- **Release-only differences.** The class-name check in the plugin is the example. The CDP layer runs against the staged release binary, so a divergence between `tauri dev` and release shows there.
- **Large files.** Tab on a one-megabyte single-line CSS file materialises that line; the window passed to `extract` is bounded, and `ensureSyntaxTree` has a timeout.
- **No network, no start-up work.** Nothing here makes a request, and the chunk is only fetched when an HTML or CSS document opens. `emmet-unit.mjs` checks the first by source scan, as `completion-unit.mjs` does.
- **Rollback.** Revert the branch. A saved `"emmet": true` key in `settings.json` is ignored by any build without the field. To disable without reverting, switch the preference off.

## Tests and validation

Cheapest layer first, from [testing.md](../agent-guide/testing.md):

1. `npm run build`, `npm run lint`, `npm run knip`, `npm run format:check`.
2. `npm run emmet:unit` (new, no application): a table of document, caret and expected snippet text, containing `ul>li*3`, `div.a#b`, `a[href=#]`, `!`, `lorem`; `m10`, `bgc#f00` (`bgc` → `background-color`), `@media`; `style="m10"` expanding inline; `<style>` text; two-space indentation; tab-stop count; a literal `$`; CRLF; a caret in the middle of a line; and negatives: inside a tag, an attribute value, a comment, `<script>`, a CSS selector, a CSS comment, a string, a partial tree, no abbreviation, multiple selections. Plus the static checks that the module is loaded lazily and contains no network call.
3. `npm run test:rust` through `scripts\cargo-vcvars.cmd`, for the settings default and the older-file load.
4. `npm run emmet` (new, CDP, real key events, staged release binary): in an HTML tab, type `ul>li*3` and press Tab; the list appears and the caret is in the first field; Tab again moves to the second; typing text inside a field and pressing Tab moves on and does not expand that text; Tab with no abbreviation indents by two spaces; with a completion popup open Tab accepts it; Ctrl+Z restores the typed abbreviation in one step; a CSS tab expands `m10`; Markdown Tab is unchanged; with the preference off Tab only indents.
5. `npm run smoke` for the preference row; `npm run autoclose` and `npm run html` as regression checks for the HTML editor and its completion popup.

**The one measurement that proves it:** in the staged release binary, `ul>li*3` + Tab + two Tabs through the fields produces the expected text and caret positions.

## Acceptance criteria

- In an HTML document, typing `ul>li.item$*3` and pressing Tab replaces the abbreviation with a three-item list whose `li` elements have classes `item1` to `item3`, indented with the editor's two-space unit, and the caret is in the first field.
- In a CSS rule block, `m10` + Tab gives `margin: 10px;`; inside `<style>` and `style="…"` in HTML the same abbreviation expands, and inline output has no line breaks.
- Typing inside an expansion field and pressing Tab moves to the next field.
- Tab does nothing but indent when there is no abbreviation before the caret, in a selector, an attribute value, a comment, a script, or any Markdown, AsciiDoc, Typst, LaTeX, JavaScript or JSON document.
- One Ctrl+Z undoes an expansion.
- The preference is on by default; off, Tab never expands. A `settings.json` written by an earlier version loads unchanged.
- Opening a Markdown document does not fetch the Emmet chunk, and no network request is made.
- Lint, knip, build, the new unit layer, the new CDP layer and the Rust settings test pass; the measured costs are recorded in this plan.

## Open questions

1. **Official plugin instead?** (Decided: the default.) Choose it if live preview and the other actions matter more than avoiding the four problems above. Default: the thin extension, with the other actions as separate later plans.
2. **Popup or Emmet first in CSS?** Default: an open popup row accepts first (the existing behaviour), and the reader presses Escape to expand. The alternative, Emmet first when the typed word is a complete Emmet snippet, is more Emmet-like and more code. I would build the default, then count collisions in the CDP test before deciding.
3. **Value-position abbreviations in CSS** (`margin: 1` + Tab). Default: not in this change; property abbreviations and `@` snippets only.
4. **Default on or off?** Default: on. Say so if you would rather opt in.
5. **Third-party notice.** `emmet` and its `@emmetio/*` helpers are MIT. I found no notice file for npm dependencies in the repository (only the font licences), so none is added; confirm that is still the policy.
