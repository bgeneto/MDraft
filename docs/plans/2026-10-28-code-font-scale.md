# A code scale for the preview and exports

**Status:** done
**Date:** 2026-10-28
**ADR:** none — this applies the decision recorded in
[`../adr/2026-10-17-preset-size-memory.md`](../adr/2026-10-17-preset-size-memory.md)
to one more reader adjustment; no new architectural choice is made.

## Context and goal

The preview draws code below the prose on purpose: `.markdown-body pre` is
`0.86em` and inline `.markdown-body code` is `0.88em` (`src/styles.css`). A
monospaced face has different x-height and cap-height proportions from the
serif or sans beside it, so the ratio that looks right for one code face and
one body face looks too large for another. There is no control for it.
**Preview font size** moves prose and code together and cannot close the gap,
and **Document Zoom** scales the whole article.

Mathematics already has exactly this control: **Math scale**, 70–130 %,
remembered per typography preset through `presetOverrides`. Code has nothing
equivalent, which is the asymmetry a reader sees when a listing is plainly
larger than the paragraph that introduces it.

Goal: a persisted `codeFontScale` percentage, 70–130, default 100, remembered
per typography preset exactly like `mathFontScale`. 100 keeps today's ratios,
about 116 makes a fenced block match the prose, and the preview, the Typst
Document view, exported HTML and the printed PDF all read one `--code-scale`
variable.

## Scope and non-scope

**In scope**

- `codeFontScale` in `Settings` and `PresetOverride`, additive with a serde
  default so an older `settings.json` loads at 100.
- `--code-scale` published by `applyTypography()` and carried by
  `exportTypographyCss()`.
- The multiplier applied to `pre`/`code` in `src/styles.css` and in both export
  wrappers in `src/markdown.ts`.
- Unify the export wrappers' ratios to the preview's 0.86 (block) and 0.88
  (inline). They currently use 0.9/0.9, so one percentage would mean two
  different sizes depending on where the document is read.
- A **Code scale** row under **Preferences › Typography**, immediately after
  **Math scale**, with the same 70–130 % bounds and per-preset memory.
- Tuned starting points for the bundled presets, at the reader's request:
  Serif 98 %, Renaissance 90 %, Editorial 96 %, Bauhaus 93 %, Notebook 93 %.
  System stays at 100 %, because its code face is the reader's own.
- Comments in the settings, the panel, the CSS and the export wrappers; a
  `docs/typography.md` section; the README feature bullet; the test counts and
  the "Adding a preference" note in `AGENTS.md`.
- Tests: Rust settings tests, the DOM smoke suite (row bounds, real rendered
  size change, clamp behaviour, per-preset memory) and the export suite (the
  variable and the rule travel into the print document).

**Non-scope**

- The source editor (Editor font size owns it), the AI panel's code blocks, the
  sandboxed HTML guest (it renders the document's own CSS, and neither body size
  nor math scale crosses into it) and Typst Pages (the compiler's own layout).
- Pandoc exports (DOCX, ODT, LaTeX, PDF via Typst) keep pandoc's layout, exactly
  as Math scale already does.
- Rewriting a preset that has already been adjusted. The tuned numbers are only
  what an **unvisited** preset starts at; a `presetOverrides` entry the reader
  already made keeps its value, as the other sizes do.
- `kbd` elements at 0.82em: they are keys, not code.

## Approach and rejected alternatives

**Chosen:** a percentage multiplier on the existing em ratios, exposed as
`--code-scale` (unitless), exactly parallel to `--math-scale`. Preferences
stores the percentage; `applyTypography()` and `exportTypographyCss()` divide by
100. `calc(.86em * var(--code-scale, 1))` keeps a missing variable meaning "the
old size", so an exported document written before this change still opens
correctly. The ratio stays relative to the prose, so changing **Preview font
size** continues to scale code with it.

**Rejected: an absolute code size in pixels.** It would break when Preview font
size changes, and it is not the shape the reader already knows from Math scale.

**Rejected: putting the size in `TypographyPreset.values`.** `activePreset()`
compares `values` to decide which preset is active; a size there would flip the
picker to **Custom** on the first edit. The existing ADR settled this for the
other three sizes, and this follows it.

**Rejected: leaving the export wrappers at 0.9em.** The same stored percentage
would then produce a larger block in exported HTML than in the preview, which is
the mismatch the feature exists to remove. The wrappers now use the preview's
ratios; the visible change is at most 4 % on code in a newly exported document.

**Rejected: applying it to the HTML guest and the AI panel.** Those are separate
documents with their own CSS; the app's body size and math scale do not reach
them either, and a control that silently changes only some of them would be
worse than one with a stated boundary.

## Steps

- [x] Add `code_font_scale` to `Settings` and `PresetOverride` in
      `src-tauri/src/settings.rs`, with the default function, the `Default`
      impl, the documentation comments and the settings tests.
- [x] Add `codeFontScale` to `src/api.ts` (both the settings interface and the
      preset override) with the same documentation.
- [x] Add `DEFAULT_CODE_SCALE = 100` and the optional preset default to
      `src/fonts.ts`; update the "three reader adjustments" comments.
- [x] Add the **Code scale** row and the per-preset write/restore in
      `src/preferences.ts`; update the preset help and the size comments.
- [x] Publish `--code-scale` in `applyTypography()` and
      `exportTypographyCss()` in `src/main.ts`.
- [x] Apply the multiplier in `src/styles.css` (inline code and fenced blocks)
      with the reasoning in a comment.
- [x] Apply it in `wrapPrintHtml` and `wrapStandaloneHtml` in
      `src/markdown.ts`, and unify their ratios to 0.86/0.88.
- [x] Extend `scripts/dom-smoke.mjs` with the row and memory checks; extend
      `scripts/export-test.mjs` with the variable-and-rule check.
- [x] Update `docs/typography.md`, `README.md` and `AGENTS.md` (counts,
      descriptions, the size-preference note).
- [x] Run typecheck, the Rust settings tests, the smoke suite and, when pandoc
      is available, the export suite. Record what was skipped.

## Files and modules

| File | Why it must change |
| --- | --- |
| `src-tauri/src/settings.rs` | Persisted field, preset override, serde default, defaults, tests |
| `src/api.ts` | The typed mirror of both settings shapes |
| `src/fonts.ts` | `DEFAULT_CODE_SCALE`, preset `defaults` type, adjustment comments |
| `src/preferences.ts` | The row, the clamp, preset write/restore, help text |
| `src/main.ts` | `--code-scale` for the app and for exports |
| `src/styles.css` | The preview's `pre`/`code` ratios consume the variable |
| `src/markdown.ts` | The print and standalone HTML wrappers consume it |
| `scripts/dom-smoke.mjs` | The row is real, changes rendered code, clamps, is remembered |
| `scripts/export-test.mjs` | The print document carries the variable and the rule |
| `docs/typography.md` | The user-facing explanation and the new default |
| `README.md` | The feature bullet names the code scale |
| `AGENTS.md` | Test counts and the size-preference note |

## Risks and rollback

- **A hand-edited extreme value.** Loading does not clamp, matching every other
  size in `Settings`; the panel clamps to 70–130. A value of 0 would hide code,
  and that is the same contract the other sizes already accept.
- **An exported document that predates the variable.** `var(--code-scale, 1)`
  and its `1` fallback keep every old export and any partial state at the old
  size.
- **The export ratio unification** makes newly exported code 4 % smaller in
  standalone HTML than before; it also makes it match the preview for the first
  time. Roll back by removing the `--code-scale` multiplier from `markdown.ts`
  and restoring `.9em`.
- **Typst Document** has no stylesheet of its own in the bundled Typst 0.15.1
  HTML export (verified), so the preview's `.markdown-body pre`/`code` rules are
  what draw it; the variable reaches it without extra work.
- Rollback for the whole change: remove the setting and the variable, and the
  CSS falls back to `1`. No data needs migrating.

## Tests and validation

- **Rust unit:** `cargo test` for the settings module — the default is 100, an
  old file without the key loads at 100, and `presetOverrides` round-trips a
  partial `codeFontScale` while leaving missing entries absent.
- **Typecheck/build:** `npm run build`.
- **DOM smoke (real UI):** the row exists with 70–130 and 100; setting 130 and
  70 changes the computed size *and* the rendered height of `#preview pre` by
  the same ratio; out-of-range input clamps; the value is restored; System 108 %
  and Serif 84 % come back after preset round-trips while an unvisited preset
  shows 100.
- **Export (real pandoc):** the print document contains `--code-scale:<n>` and a
  `var(--code-scale)` rule beside the existing math-scale check.
- **Manual:** `samples/feature-tour.md`, set Code scale to 116 % on Serif, and
  compare a fenced block with the paragraph above it in Split and in a printed
  PDF.

The one measurement that proves the feature: the height of a rendered fenced
block changes by the same factor as the percentage, which a stored number alone
cannot produce.

## Acceptance criteria

- **Preferences › Typography** shows **Code scale** after **Math scale**,
  bounded 70–130 %; System and Custom start at 100 %, while an unvisited Serif
  starts at 98 %, Renaissance 90 %, Editorial 96 %, Bauhaus 93 % and Notebook
  93 %.
- Setting it to 130 % makes a fenced code block in the preview visibly 30 %
  larger in font size and height; 70 % makes it 30 % smaller; 100 % restores the
  previous drawing.
- The value is remembered for the active preset, survives a visit to another
  preset and back, and does not change the preset picker away from that preset.
- An older `settings.json` without `codeFontScale` loads and renders exactly as
  before.
- A newly exported standalone HTML and printed PDF use the same
  `--code-scale` percentage as the preview, with the same 0.86/0.88 base ratios.
- The TypeScript build, the Rust settings tests, the DOM smoke suite and the
  export suite pass; anything not run is named in the final report.

## Implementation record

Implemented as planned, with these deviations and measurements:

- **Export count was already stale.** The suite reported 39 checks before this
  change, not the 38 `AGENTS.md` claimed. The new code-scale check makes it 40,
  and both the table and the description now say 40.
- **The first export assertion was too strict.** It required
  `var(--code-scale)`, while both wrappers write `var(--code-scale,1)` for the
  fallback; the rule was present and the check failed anyway. The assertion now
  accepts the fallback form, and the trap is recorded in `AGENTS.md`.
- **The UI suites ran on a disposable build** with identifier
  `io.github.bernh.mdraft.codescaletest`, because the installed MDraft was open
  and the harness correctly refuses to disturb a user instance. Its settings,
  WebView profile and executable were removed afterwards, and the ordinary
  release binary was rebuilt so `src-tauri/target/release/mdraft.exe` is not the
  test copy.
- **The standalone HTML wrapper's base ratios were normalised** from 90 % to the
  preview's 86 % / 88 %, as the approach section describes. The print wrapper's
  inline code moved from 90 % to 88 % for the same reason.
- **The bundled presets received tuned starting points after the first pass**,
  at the reader's request: Serif 98 %, Renaissance 90 %, Editorial 96 %, Bauhaus
  93 %, Notebook 93 %; System stays 100 %. `TypographyPreset.defaults` already
  carried the field, so only `src/fonts.ts`, the smoke expectations and the docs
  changed. A preset the reader had already adjusted keeps its remembered value.

Validation actually run:

| Layer | Result |
| --- | --- |
| `npm run build` | Typecheck and Vite bundle pass |
| `cargo test --lib` (TEMP inside the workspace) | 199 passed, 2 ignored downloads |
| DOM smoke against the disposable build | 113/113, including the four code-scale checks, per-preset memory, and the unvisited code defaults (Serif 98, Renaissance 90, Editorial 96, Bauhaus 93, Notebook 93) |
| Export suite | 40/40, including the print document's `--code-scale` declaration and `var(--code-scale,1)` rule |
| Typography suite | 48/48, no regression from the extra row |
| Chromium CSS probe | 16 px prose, block 13.76 px and inline 14.08 px at 100 %, 17.89 / 18.30 at 130 %, 9.63 / 9.86 at 70 %, and 100 % again with the variable removed |

Not run: the full `npm test` harness (it refuses while a user instance is open),
a pandoc PDF through Typst (Typst is not on this instance's `PATH`, so the
suite's expected-failure path ran instead), and a visual inspection of a printed
page, which is left to the reader.

## Open questions

None. The application default stays at 100 % for System and Custom, the shared
70–130 % range follows Math scale, and the five bundled presets carry the
reader's tuned starting points. A future preset adds its own value to
`TypographyPreset.defaults.codeFontScale`.
