# Auto-close brackets, quotes and HTML tags

**Status:** done
**Date:** 2026-10-18
**ADR:** none — the extension composition is local to the editor and reversible

## Context and goal

Typing an opening delimiter in MDraft inserts exactly one character. A `(` stays
`(`, a backtick stays one backtick, and `<p>` in an HTML document closes only
because CodeMirror's HTML language happens to include its own tag closer. The
reader coming from Typora expects the closing character, wants to type over it
instead of duplicating it, wants Backspace to remove both halves, and wants the
same for the quotes and backticks that Markdown and Typst use constantly.

What is already true, measured in the running 0.3.1 build:

- **HTML documents already close tags.** Typing `<p>` into
  `samples/html-tour/index.html` produced `<p></p>` with the caret between.
  CodeMirror's `html()` language support includes `autoCloseTags` unless it is
  explicitly turned off. There is no preference and no test.
- **Nothing else auto-closes.** In a new Markdown tab, typing `(`, `"` and `<p>`
  left the literal `("(<p>` in the buffer. `closeBrackets()` is not installed,
  and no language data supplies the extra backtick.
- `@codemirror/autocomplete` is in `node_modules` (6.20.3, pulled in by
  `lang-html`, `lang-markdown` and `language-data`) but not a direct dependency.

After this change, with the new preferences on (the default), typing `(`, `[`,
`{`, `'`, `"` or `` ` `` inserts the pair; typing the closing character steps
over it; Backspace between the two deletes both; a selection is wrapped. HTML
documents close tags as they do today; Markdown and AsciiDoc, which pass HTML
through, get a small conservative tag closer. Typst gets pairs and quotes but no
tags. Both behaviors have a checkbox in Preferences › Editor.

## Scope and non-scope

**In scope**

- `closeBrackets()` and `closeBracketsKeymap` from `@codemirror/autocomplete`,
  configured with `(`, `[`, `{`, `'`, `"` and `` ` `` (the library's defaults
  omit the backtick).
- A `Compartment` so the behavior can be toggled at runtime without rebuilding
  the editor, and so a new tab cannot inherit the previous tab's setting.
- `autoCloseTags` for HTML documents, behind the preference; currently it is
  always on and cannot be turned off.
- A conservative tag closer for Markdown and AsciiDoc: typing the `>` of an
  opening tag inserts `</tag>` and puts the caret inside. Void elements, explicit
  self-closing tags, autolinks (`<https://…>`), comments, escaped `<` and code
  contexts are left alone.
- Two additive settings: `autoClosePairs` and `autoCloseTags`, both defaulting to
  true, mirrored in Rust and TypeScript, plus two checkboxes under
  Preferences › Editor.
- Tests: a pure matcher unit layer, a Markdown CDP suite, HTML tag checks in the
  existing HTML suite, AsciiDoc pair checks in the existing AsciiDoc suite.

**Non-scope**

- Auto-closing `*`, `_`, `~`, `=` or Markdown emphasis markers. Those are
  formatting, not delimiters, and wrapping a selection with them is a different
  feature.
- Smart quotes or any transformation of the character typed.
- Closing a tag when typing `/` in `</…`; the closer runs on `>` only.
- Auto-closing `<` or `>` as a pair in Typst or in prose. Typst has no tag
  construct, and `<` in Markdown is too often a comparison or an autolink.
- Per-language toggles beyond what the document type implies. The two checkboxes
  are global; the behavior itself is already type-aware.
- Voice/IME composition: the library already refuses to act while composing, and
  this change does not try to improve that.

## Approach and rejected alternatives

Install `closeBrackets()` in a `pairCompartment`, with a language-data entry that
adds the backtick to the default bracket list:

```ts
pairCompartment.of([
  EditorState.languageData.of(() => [
    { closeBrackets: { brackets: ["(", "[", "{", "'", '"', "`"] } },
  ]),
  closeBrackets(),
])
```

and put `closeBracketsKeymap` in the keymap just before `defaultKeymap`, so
Backspace deletes a pair before it deletes one character. Reconfiguring the
compartment (or emptying it) turns both the insertion and the Backspace command
off together. The language data is what makes the backtick work: `closeBrackets`
reads `state.languageDataAt("closeBrackets")`, falls back to
`["(", "[", "{", "'", '"']`, and no language here supplies its own list.

Tags:

- **HTML** keeps CodeMirror's `autoCloseTags`, but `html()` is now called with
  `{ autoCloseTags }` so the preference can turn it off. The HTML language is
  lazily imported; the loader caches one promise per flag so toggling does not
  re-fetch the module.
- **Markdown and AsciiDoc** get a small `tag-close.ts` input handler, because
  `autoCloseTags` cannot work there: it guards on
  `htmlLanguage.isActiveAt(...)`, and Markdown parses its inline HTML with
  `html({ matchClosingTags: false })` — a configured language with different
  data — so the guard is false. The handler matches the opening tag on the
  current line, refuses void elements, self-closing tags, autolinks, comments
  and code contexts, and inserts `</tag>` with the caret inside.
- **Typst** gets no tag extension.

Rejected alternatives:

- **`basicSetup` from the `codemirror` meta-package.** It bundles a dozen
  extensions this editor configures itself (line numbers, fold gutter, history
  depth), and taking it to get one extension would change unrelated behavior.
- **`@codemirror/autocomplete`'s default bracket list as-is.** No backtick, which
  is the delimiter this editor's users type most.
- **A custom input handler for every pair.** Reimplementing insertion,
  step-over, pair deletion and selection wrapping is exactly what
  `closeBrackets` already does and what its state field tracks; a second
  implementation would drift.
- **Using `autoCloseTags` globally for Markdown too.** Its language guard
  rejects Markdown's nested HTML dialect, so it would be dead code there; the
  custom handler is the only way to cover it.
- **Turning tag closing into a language-specific preference.** The document type
  already decides; a third checkbox would be a control users cannot map to a
  behavior.

## Steps

- [ ] `package.json`: add `@codemirror/autocomplete` (6.20.3, already in the
  tree) as a direct dependency; `npm install` to update the lock file only.
- [ ] `src-tauri/src/settings.rs`: `auto_close_pairs` and `auto_close_tags`,
  both `#[serde(default = "default_true")]`, defaults true. Tests: defaults,
  an old settings file without them, round-trip.
- [ ] `src/api.ts`: the two fields on `Settings`.
- [ ] `src/tag-close.ts` (new): a pure `tagToClose(line, pos)` returning
  `{ tag } | null` (void, self-closing, autolink, comment, escaped and code
  cases reject), plus `closeTag()` as an `EditorView.inputHandler` for `>` that
  inserts the closing tag and places the caret inside.
- [ ] `src/editor.ts`:
  - `pairCompartment` with `closeBrackets`, the language-data backtick list and
    `closeBracketsKeymap` in the keymap before `defaultKeymap`;
  - `tagCompartment` for the Markdown/AsciiDoc handler;
  - `setAutoClose({ pairs, tags })` on `EditorHandle`, reconfiguring both
    compartments and, for HTML, reinstalling the language with the new
    `autoCloseTags` flag;
  - `setLanguage` installs the tag behavior that matches the document type and
    clears it when switching away;
  - `html-language.ts` caches `html({ autoCloseTags })` per flag.
- [ ] `src/main.ts`: pass the two settings into `createEditor`; call
  `editor.setAutoClose(...)` from `applySettingsPatch` when either changes.
- [ ] `src/preferences.ts`: under Editor, a heading **Auto-close** with
  **Auto-close brackets and quotes** and **Auto-close HTML tags**, each with
  help text naming the characters and the document types.
- [ ] Tests:
  - `scripts/autoclose-unit.mjs` (new): the matcher — `p`, `a href="x"`,
    `br`, `img`, `br/`, `https://…`, `<!--`, `\<`, attributes with `>`, a tag in
    a code span.
  - `scripts/autoclose-test.mjs` (new, CDP, Markdown fixture): `(`, `[`, `{`,
    `'`, `"`, `` ` ``; step-over; Backspace; selection wrap; apostrophe in
    `don't` not paired; Markdown `<a href="x">` closes; autolink and fenced code
    untouched; both preferences off → no insertion. Typed with
    `Input.dispatchKeyEvent` (`type: "char"`), because `closeBrackets` is an
    input handler and a synthetic `KeyboardEvent` never reaches it.
  - `scripts/html-preview-test.mjs`: `<p>` closes, `<img>` does not, preference
    off stops it (43 → 46).
  - `scripts/asciidoc-test.mjs`: pairs work in AsciiDoc and a tag closes (51 →
    53).
  - `scripts/test-all.mjs`: register the unit and CDP layers; 19 layers total.
- [ ] Docs: README feature list, `docs/guide.md` (how the preferences behave per
  document type), AGENTS (two suite rows, counts, the input-handler trap).
- [ ] Version: 0.4.0 when releasing; the implementation commit does not bump.

## Files and modules

| File | Why |
| --- | --- |
| `package.json`, `package-lock.json` | The bracket extension becomes a direct dependency |
| `src-tauri/src/settings.rs` | Two persisted booleans and their tests |
| `src/api.ts` | Mirrors the settings |
| `src/tag-close.ts` | The Markdown/AsciiDoc tag matcher and input handler |
| `src/editor.ts` | Compartments, keymap order, `setAutoClose`, per-language install |
| `src/html-language.ts` | `html({ autoCloseTags })` cache per flag |
| `src/main.ts` | Wires settings into the editor at boot and on change |
| `src/preferences.ts` | The two checkboxes |
| `scripts/autoclose-unit.mjs` | Matcher checks without an application |
| `scripts/autoclose-test.mjs` | The real typing checks in Markdown |
| `scripts/html-preview-test.mjs`, `scripts/asciidoc-test.mjs` | Tag and pair checks where the document type differs |
| `scripts/test-all.mjs` | Suite registration and counts |
| `README.md`, `docs/guide.md`, `AGENTS.md` | The user-facing description and the traps |

## Risks and rollback

- **Backticks inside fenced code.** `closeBrackets` has no context check, so
  typing three backticks to open a fence inserts a pair first. It is the
  behavior most likely to annoy a Markdown writer. The preference turns it off;
  if the feedback is bad, a context-aware backtick handler is the follow-up.
  Test the fence case explicitly so the behavior is known, not surprising.
- **Markdown tag closer misfires on prose `<`.** The matcher requires a valid
  tag name, rejects `://`, `<!--`, `<?`, escaped `<` and code contexts, and
  requires the `<` to start the tag on this line. The unit layer is where the
  edge cases are proven; the CDP suite proves the integration.
- **Keymap order.** `closeBracketsKeymap` must come before `defaultKeymap`, or
  Backspace deletes one character and leaves the pair. The suite asserts the pair
  is gone in one Backspace.
- **HTML language reinstalled on toggle.** Reconfiguring the language
  compartment recreates the parser support but not the document, selection or
  history; the flag cache avoids a second fetch. The HTML suite toggles the
  preference and asserts the tag does not close, which would catch a stale
  language support.
- **Two compartments reconfigured in one transaction.** Keep them separate:
  toggling pairs must not reset the tag handler and vice versa.
- Rollback: revert the commit. The settings fields are additive; an old
  `settings.json` keeps loading, and the preference rows simply disappear with
  the code.

## Tests and validation

- `npm run build` — typecheck.
- `npm run test:rust` — the settings tests.
- `node scripts/autoclose-unit.mjs` — the matcher.
- `npm run autoclose` — the Markdown behavior through the real editor.
- `npm run html` and `npm run asciidoc` — the document-type variants.
- `npm run tabs` — the keymap change must not disturb tab switching.
- Full `npm test` before the release.

The measurement that proves it: in a Markdown tab, type `(` and read the line —
it must be `()` with the caret between; type `)` and the caret must be after the
existing `)` without a second one; press Backspace and the line must be empty.
In the HTML fixture, `<p>` must become `<p></p>`, and with the preference off it
must stay `<p>`.

## Acceptance criteria

- With auto-close on, `(`, `[`, `{`, `'`, `"` and `` ` `` insert their closing
  character in Markdown, AsciiDoc, Typst and HTML.
- Typing the closing character steps over it; Backspace between the pair removes
  both; a non-empty selection is wrapped.
- An apostrophe inside a word (`don't`) is not paired.
- In HTML, `<p>` closes and `<img>` does not; turning **Auto-close HTML tags**
  off makes `<p>` stay `<p>`.
- In Markdown and AsciiDoc, `<a href="x">` closes, while `<https://…>`, a tag in
  a fenced block and `\<p>` are left alone.
- Both preferences persist in `settings.json` and survive a restart.
- An existing `settings.json` without the fields loads with both behaviors on.

## Open questions

- **Backticks in code fences:** accept the pair (proposed) or suppress it inside
  code contexts from the start? Default: accept, with the preference as the
  escape hatch.
- **Defaults:** both on. Typora behaves that way and the reader asked for the
  feature. Default: on.
- **Version:** 0.4.0. Default: 0.4.0.

## Execution record

Implemented as planned, with four deviations worth keeping:

- **`tag-name.ts` split from `tag-close.ts`.** The pure matcher has to be
  importable by a Node test without a DOM; keeping it beside the input handler
  would have pulled `@codemirror/view` into that import. `code-context.ts` was
  also extracted, because the tag closer and `EditorHandle.inCodeContext()` need
  the same answer and duplicating the node list would let them disagree.
- **Markdown's nested HTML grammar needed `autoCloseTags: false`.** Turning the
  preference off still closed `<p>` at the start of a line: `markdown()` installs
  `htmlTagLanguage` (`html({ matchClosingTags: false })`), whose support carries
  its own closer, and a line-start HTML block made its guard true. `markdownSupport`
  now passes `html({ matchClosingTags: false, autoCloseTags: false })` and the
  editor owns the behavior. This is recorded as a trap in AGENTS.
- **One CDP suite covers all four document types** by switching the default
  extension and opening a tab, instead of adding checks to the HTML and AsciiDoc
  suites. It keeps their fixtures untouched, and the language switch is exactly
  what a reader does.
- **The suite never closes a tab.** The first version closed each scenario tab;
  when a buffer failed to clear, `Ctrl+W` raised the native save prompt and
  `Runtime.evaluate` blocked forever. Each scenario now empties the current tab
  before and after, and the tabs stay open and clean. Recorded in the suite's
  comment so the next editor does not reintroduce the close.

Verified: `autoclose-unit` 17/17, `autoclose` 33/33, Rust 80 tests (79 run, one
ignored), and the full `npm test` run with all nineteen layers. No version bump
in this commit; 0.4.0 is the release number.

