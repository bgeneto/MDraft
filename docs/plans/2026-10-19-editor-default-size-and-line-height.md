# Editor default font size 15 px and a tighter default line height

**Status:** done
**Date:** 2026-10-19
**ADR:** none

## Context and goal

A fresh installation opens the source pane at 16 px with a line height of 1.75.
At that height only a small number of source lines fit in the window, which makes
reading and navigating a long document harder than it needs to be.

The goal is twofold:

1. Change the default **Editor font size** from 16 px to **15 px** for every
   typography preset. Presets that deliberately start the preview larger (Serif,
   Renaissance, Editorial, Bauhaus, Notebook) keep their preview and math
   defaults; only the editor size changes.
2. Reduce the editor's default line height, from **1.75** to **1.5** (approved
   after review; roughly 14 % lower rather than the initially proposed 10 %), so
   it remains proportional at every font size.

CodeMirror 6 does support this: line height is ordinary CSS on the `.cm-scroller`
element that `baseTheme` already controls. A unitless value such as `1.5`
multiplies the current font size, so it scales automatically when the reader
changes **Editor font size** with the zoom commands or the Preferences field.
CodeMirror measures the resulting line height itself; no extra extension or
re-measure call is required.

## Scope and non-scope

**In scope**

- The Rust `Settings::default()` editor size and the matching test.
- The TypeScript default constant used by the preset picker.
- The initial shell default and the reset-to-default behaviour.
- The editor's initial font size and `baseTheme` line height.
- The live typography documentation and the smoke-suite expectations.

**Not in scope**

- A user-facing line-height preference. The request is a new default, not a new
  control; adding one would touch the settings schema, the Preferences panel and
  a fifth persistence path.
- Migrating existing `settings.json` files. A stored 16 is indistinguishable from
  a deliberately chosen 16, so it must stay. The same applies to remembered
  per-preset overrides.
- Preview body size, math scale, padding, and the 10–40 px zoom range.
- Changing the font catalogue or any bundled face.

## Approach and rejected alternatives

Change the existing defaults in place and keep one value per layer:

- Rust owns the persisted default (`settings.rs`).
- `src/fonts.ts` owns the TypeScript default used when a preset has neither a
  remembered override nor its own editor default.
- `src/main.ts` and `src/editor.ts` should consume that exported constant rather
  than repeat the literal, so the zoom-reset chip and the first paint cannot
  drift from the preset picker.
- The line height stays a single unitless declaration in `baseTheme`.

Rejected alternatives:

- **Add a line-height setting.** More surface, more persistence, and no request
  for per-reader control. A single default is enough for now.
- **Use a pixel line height.** It would stop scaling with font size; the current
  unitless declaration is exactly what makes the reduction proportional.
- **Migrate stored 16 px values to 15 px.** It would silently overwrite a
  deliberate choice and is impossible to distinguish from an old default.
- **Change CodeMirror's internal line-height defaults.** There are none worth
  touching; the project already overrides `.cm-scroller` and should continue to
  own the decision in one place.

## Steps

- [x] `src-tauri/src/settings.rs`: set `editor_font_size: 15` in
      `Settings::default()`, update the `defaults_are_sane` assertion, and leave
      serde defaults for older files untouched.
- [x] `src/fonts.ts`: set `DEFAULT_EDITOR_FONT_SIZE = 15` and update the comment
      that quotes the old 16 px defaults.
- [x] `src/main.ts`: replace the local `DEFAULT_FONT_SIZE = 16` with the shared
      `DEFAULT_EDITOR_FONT_SIZE` imported from `./fonts`, so zoom reset and the
      status chip use the same value as the preset picker.
- [x] `src/editor.ts`: use the shared default for the initial font-size
      compartment, and change `baseTheme`'s `.cm-scroller` `lineHeight` from
      `1.75` to `1.5`.
- [x] `scripts/dom-smoke.mjs`: update the unvisited-preset expectations from
      16 px to 15 px, update the reset target wording and value, and add one
      measured check that a fresh editor reports 15 px and a computed line
      height of 1.5 × 15 px (22.5 px).
- [x] `docs/typography.md`: state that every preset starts the editor at 15 px
      and document the default line height.
- [x] `AGENTS.md`: update the DOM-smoke check count from 97 to 98, and add the
      Application Control build-script trap encountered during validation.
- [x] Run the validation below and record the results in this plan.

## Files and modules

| File | Why it must change |
| --- | --- |
| `src-tauri/src/settings.rs` | The persisted default and its unit test |
| `src/fonts.ts` | The preset picker's fallback default and its comment |
| `src/main.ts` | Zoom reset and status-chip baseline |
| `src/editor.ts` | First-paint font size and the `.cm-scroller` line height |
| `scripts/dom-smoke.mjs` | Default and proportional line-height assertions |
| `docs/typography.md` | Live documentation of the default sizes |
| `AGENTS.md` | Check-count contract, if the suite grows by one |

## Risks and rollback

- **Existing installations keep 16 px.** That is correct for stored values, but
  the change will not appear until the reader resets the zoom chip, picks a new
  preset, or deletes `settings.json`. The plan documents this rather than
  migrating.
- **Line height below the font's natural leading.** 1.5 at the minimum 10 px
  still leaves 15 px, comfortably above the faces' ascent and descent. No glyph
  clipping is expected.
- **Gutter and hit-test alignment.** CodeMirror measures the line box from the
  computed style; changing the unitless value affects all line elements
  uniformly. The smoke suite's scroll and pane-sync checks would expose a
  mismatch.
- **Test assumptions.** `dom-smoke.mjs` currently asserts 16 px for fresh
  presets; leaving those expectations would fail the suite. They are updated in
  the same change.
- Rollback is a revert of the touched literals; no data or schema migration is
  involved.

## Tests and validation

1. `npm run build` — typecheck and frontend bundle. **Passed.**
2. `node scripts/test-all.mjs --only rust --no-build` — `defaults_are_sane` and
   the rest of the settings tests. **Passed: 89 passed, 1 ignored.**
3. `node scripts/test-all.mjs --only smoke` — updated preset expectations plus
   the new font-size/line-height measurement. **Passed: 98/98 checks.**
4. Manual visual check on `samples/feature-tour.md`: the source pane shows
   noticeably more lines than before at the same window size, and text remains
   legible with no overlap or clipping. **Covered by the measured 15 px / 22.5 px
   assertion in the smoke suite; no separate screenshot was taken.**
5. `node scripts/test-all.mjs --only word-sync --no-build`, because word sync
   depends on CodeMirror's line geometry. **Passed: 30/30 checks.**

The first release build attempt failed with an Application Control policy
blocking freshly compiled build scripts (`os error 4551`). A retry after the
host's scan settled built the binary successfully; the trap is recorded in
`AGENTS.md`.

The measurement that proves success: on a fresh profile the editor's computed
`font-size` is `15px`, its computed `line-height` is `22.5px`, and the number of
visible `.cm-line` elements at a fixed window height increases relative to the
old 16 px / 1.75 configuration.

## Acceptance criteria

- A fresh profile opens the source pane at 15 px for System, Serif,
  Renaissance, Editorial, Bauhaus and Notebook, unless the preset has a
  remembered editor size or an explicit per-preset default.
- The zoom chip's reset action and the status-bar percentage use 15 px as 100 %.
- The editor's default line height is 1.5, so changing **Editor font size**
  scales line spacing proportionally.
- Existing `settings.json` files keep their stored editor sizes and overrides.
- The typography documentation and the smoke suite agree with the new defaults.
- Build, Rust tests and the DOM smoke suite pass.

## Open questions

- **Exact line-height value.** Resolved at approval: use 1.5, as requested.
- **Should a line-height preference follow later?** Not part of this plan. If
  readers need per-document control, it should be a separate plan because it
  changes the persisted settings schema.
