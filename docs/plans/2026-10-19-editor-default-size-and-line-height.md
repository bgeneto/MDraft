# Editor default font size, line height, and a Line Height preference

**Status:** done
**Date:** 2026-10-19
**ADR:** none

> **Reopened on 2026-10-19.** Part A below was implemented and validated: a fresh
> profile opens the editor at 15 px with a 1.5 line height. After seeing the
> result, the reader asked for a **Line Height** preference in
> *Preferences › Editor*, directly below **Content Width**, with three choices:
> **Compact = 1.3**, **Normal = 1.5** and **Wide = 1.8**. That is Part B, now
> approved with those values.

## Context and goal

A fresh installation used to open the source pane at 16 px with a line height of
1.75. At that height only a small number of source lines fit in the window,
which made reading and navigating a long document harder than it needs to be.

Part A solved the default: the editor now starts at **15 px** for every
typography preset and uses a **1.5** line height instead of 1.75. That change is
live and validated.

Part B is the follow-up the reader asked for after using it. A single default
cannot suit everyone: some readers want the old, more open 1.75 spacing back,
while others want a denser 1.3 for long documents. The goal is to expose the
three sensible densities without turning the setting into a free numeric field.

The preference sits under **Content Width** in *Preferences › Editor* and
applies to the **source pane only**. The preview keeps its own reading line
height (currently 1.72) because it is prose laid out for reading, not code-like
source text.

## Scope and non-scope

**In scope**

- **Part A (done):**
  - The Rust `Settings::default()` editor size and its test.
  - The TypeScript default constant used by the preset picker.
  - The initial shell default and the reset-to-default behaviour.
  - The editor's initial font size and `baseTheme` line height.
  - The live typography documentation and the smoke-suite expectations.
- **Part B (done):**
  - A persisted `editorLineHeight` setting with three values: `compact`,
    `normal`, `wide`.
  - The mapping Compact = 1.3, Normal = 1.5, Wide = 1.8 in one TypeScript
    table.
  - A **Line Height** select row in *Preferences › Editor* immediately after
    **Content Width**.
  - Live application to the source pane at every font size, using a CSS variable
    and CodeMirror's existing measure path.
  - Defaults, fallbacks for older or hand-edited settings files, and tests.

**Not in scope**

- Preview prose line height, math scale, padding and the preview's reading
  rhythm. The preview stays at 1.72.
- Per-preset line heights. Content Width, Focus Mode and Typewriter Mode are
  global, and line height is spacing rather than part of a typeface preset.
- A custom numeric multiplier or a free-entry field. Three named choices are the
  request; a number input would need validation and a wider settings contract.
- Migrating existing `settings.json` files. A missing `editorLineHeight` is
  `normal`, which is exactly the 1.5 that Part A established.
- Changing the font catalogue or any bundled face.

## Approach and rejected alternatives

### Part A — done

Change the existing defaults in place and keep one value per layer:

- Rust owns the persisted default (`settings.rs`).
- `src/fonts.ts` owns the TypeScript default used when a preset has neither a
  remembered override nor its own editor default.
- `src/main.ts` and `src/editor.ts` consume that exported constant rather than
  repeating the literal, so the zoom-reset chip and the first paint cannot drift
  from the preset picker.
- The line height is a single unitless declaration in `baseTheme`.

### Part B — done

Store a **named value**, not a number:

```json
{ "editorLineHeight": "normal" }
```

- `"compact"` → 1.3
- `"normal"` → 1.5 (default)
- `"wide"` → 1.8

Rust stores it as a `String` with `#[serde(default = "default_editor_line_height")]`,
mirroring how `theme`, `view_mode` and `typst_view` already store named choices.
An older settings file gets `normal`; an unknown hand-edited value is treated as
`normal` by both the panel and the layout code rather than producing an invalid
CSS declaration.

The three multipliers live in **one** exported table in `src/fonts.ts`, beside
`DEFAULT_EDITOR_FONT_SIZE`, so the panel, `main.ts`, the editor default and the
smoke test cannot drift.

The value reaches CodeMirror through a CSS variable:

1. `:root` declares `--editor-line-height: 1.5` in `styles.css`, so the first
   paint is correct before settings load.
2. `applyLayout()` writes the variable from the table.
3. `baseTheme` uses `lineHeight: "var(--editor-line-height)"`, the same
   mechanism already used for `fontFamily: "var(--font-source)"`.
4. `applyTypography()` already calls `editor.requestMeasure()`; changing the
   line height therefore makes CodeMirror re-measure its line boxes without a
   new compartment or extension.

Rejected alternatives:

- **Store a floating-point multiplier (`editorLineHeight: 1.3`).** It reads
  naturally, but a hand-edited `0`, negative or huge value breaks the pane, and
  the UI only offers three choices. The named value is the smaller contract and
  matches the existing enum-like settings.
- **Store an integer percentage (`125`).** It would require a conversion and
  still allows meaningless values such as `3`; the names are clearer in
  `settings.json`.
- **Apply it to the preview as well.** The preview has a separate reading line
  height and a separate size setting. A future *Preview line height* option can
  be its own plan; coupling them would make one control do two jobs.
- **Remember it per typography preset.** The preset identity is the four faces
  and the OpenType switches; the existing per-preset overrides are sizes. Line
  height is a density choice that should survive a preset switch.
- **Use a CodeMirror compartment.** A compartment would work, but the existing
  font-family path already proves that a CSS variable survives CodeMirror's
  stylesheet generation. One variable and the existing measure call is less
  machinery.
- **Use a pixel line height.** It would stop scaling with font size; the
  unitless multiplier is exactly what makes 1.3/1.5/1.8 proportional at 10,
  15 or 40 px.
- **Migrate stored 16 px values to 15 px.** It would silently overwrite a
  deliberate choice and is impossible to distinguish from an old default.
- **Rejected in Part A and now superseded: "Add a line-height setting."** Part A
  deliberately deferred it; Part B is that setting.

## Steps

### Part A — done

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

### Part B — done

- [x] `src-tauri/src/settings.rs`: add
      `#[serde(default = "default_editor_line_height")] pub editor_line_height: String`,
      a `default_editor_line_height()` returning `"normal"`, the `Default`
      assignment, and tests for the default and for an older settings file.
- [x] `src/api.ts`: add `EditorLineHeight = "compact" | "normal" | "wide"` and
      `editorLineHeight: EditorLineHeight` to `Settings`.
- [x] `src/fonts.ts`: export `EDITOR_LINE_HEIGHTS` (the three multipliers) and
      `DEFAULT_EDITOR_LINE_HEIGHT = "normal"`, with a comment explaining that a
      missing or unknown value falls back to Normal.
- [x] `src/preferences.ts`: add the **Line Height** select directly after
      **Content Width**, with options `Compact`, `Normal`, `Wide`; help text
      names the multipliers and says it applies to the source pane.
- [x] `src/main.ts`: in `applyLayout()`, publish
      `--editor-line-height` from the table, falling back to Normal for an
      unknown stored value.
- [x] `src/styles.css`: declare `--editor-line-height: 1.5` in `:root` beside
      `--editor-max-width`, so the first paint is correct.
- [x] `src/editor.ts`: change `baseTheme`'s `.cm-scroller` `lineHeight` to
      `var(--editor-line-height)` and update the comment to explain why a
      variable is enough.
- [x] `scripts/dom-smoke.mjs`: check that the row exists directly below Content
      Width, that Compact/Normal/Wide produce 19.5/22.5/27 px at 15 px, that
      the value is written through `get_settings`, that it survives a preset
      switch, and restore Normal before finishing.
- [x] `docs/typography.md`: document the preference, its three values and the
      fact that it is global and editor-only.
- [x] `README.md` and `docs/guide.md`: add the preference to the user-facing
      feature lists.
- [x] `AGENTS.md`: update the DOM-smoke and Rust counts and the smoke-suite
      description.
- [x] Run the validation below and record the results in this plan.

## Files and modules

| File | Why it must change |
| --- | --- |
| `src-tauri/src/settings.rs` | Persisted default and its tests |
| `src/api.ts` | `Settings` contract and the named union |
| `src/fonts.ts` | One table for the three multipliers and the default |
| `src/preferences.ts` | The Line Height row under Content Width |
| `src/main.ts` | Publishes the CSS variable from the setting |
| `src/styles.css` | First-paint default for the variable |
| `src/editor.ts` | `baseTheme` reads the variable |
| `scripts/dom-smoke.mjs` | Placement, live geometry, persistence and fallback checks |
| `docs/typography.md` | Live documentation of the preference |
| `README.md`, `docs/guide.md` | User-facing feature lists |
| `AGENTS.md` | Check-count and suite-description contract |

## Risks and rollback

- **Compact at the minimum 10 px.** 1.3 × 10 px is a 13 px line box, which is
  tight for faces with tall ascenders and deep descenders. The default remains
  Normal, the choice is explicit, and the source pane does not clip glyphs; at
  worst a reader who selects Compact at 10 px sees tighter leading. The value is
  a one-line change in the shared table if it ever needs revisiting.
- **Unknown or hand-edited values.** `editorLineHeight: "huge"` must not produce
  an invalid line height or leave the select blank. Both the panel and
  `applyLayout()` fall back to `normal`.
- **CSS variable inside CodeMirror's theme.** This is the same mechanism as
  `--font-source`; the risk is that the variable is not read at all, which the
  smoke test catches by measuring the computed line height rather than the
  setting value.
- **Re-measurement.** A line-height change alters every line box. The existing
  `requestMeasure()` in `applyTypography()` runs after `applyLayout()` writes the
  variable, so scroll position and word-sync geometry are re-measured. Run the
  word-sync suite as a regression check.
- **Per-preset expectations.** The preference is global by design. Switching a
  preset must not silently reset it; the smoke suite asserts that.
- **Backward and forward compatibility.** Older builds ignore the unknown
  `editorLineHeight` field (serde does not deny unknown fields), and older
  settings files load as `normal`. No migration is required.
- **Rollback.** Remove the row and the field, and restore the static
  `lineHeight: "1.5"` in `baseTheme`. Nothing in `settings.json` needs repair;
  the extra field is ignored.
- Part A has already shipped and needs no rollback; its defaults stay.

## Tests and validation

Part A, already run:

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

Part B, run:

1. `npm run build` — typecheck and frontend bundle. **Passed.**
2. `node scripts/test-all.mjs --only rust --no-build` — new settings assertions.
   **Passed: 90 passed, 1 ignored** (91 total; the new round-trip test is the
   one addition).
3. `node scripts/test-all.mjs --only smoke` — the new placement, geometry,
   persistence and preset-switch checks. **Passed: 105/105 checks** on a freshly
   built binary.
4. `node scripts/test-all.mjs --only word-sync --no-build` — line geometry and
   word mapping. **Passed: 30/30 checks at the default Normal spacing**; the
   smoke suite measures Compact and Wide geometry separately.
5. Manual check on `samples/feature-tour.md`: Open *Preferences › Editor*, confirm
   **Line Height** is directly below **Content Width**, switch Compact → Normal →
   Wide, and watch the source spacing change immediately. **Covered by the
   105/105 smoke checks**, which assert the row order and the three computed
   heights; no separate screenshot was taken. Restart persistence is covered by
   the Rust round-trip and the frontend reading the same setting at boot, not by
   a two-launch test.

The measurement that proves Part B: at a 15 px editor, Compact computes to
**19.5 px**, Normal to **22.5 px** and Wide to **27 px**; at 20 px, Normal
computes to **30 px**, proving the multiplier still scales with the font size.
The preview's `.markdown-body` line height remains **1.72**.

## Acceptance criteria

- A fresh profile opens the source pane at 15 px for System, Serif,
  Renaissance, Editorial, Bauhaus and Notebook, unless the preset has a
  remembered editor size or an explicit per-preset default.
- The zoom chip's reset action and the status-bar percentage use 15 px as 100 %.
- The editor's default line height is **Normal (1.5)**.
- *Preferences › Editor* shows **Line Height** directly below **Content Width**,
  with exactly three choices: Compact, Normal and Wide.
- Choosing a value changes the source pane's line spacing immediately, at every
  editor font size, and does not change the preview.
- The choice persists in `settings.json` and comes back after a restart.
- An older `settings.json` without the field opens at Normal; an unknown stored
  value also falls back to Normal without a blank control or broken layout.
- Switching typography presets does not reset the line height.
- Build, Rust tests, the DOM smoke suite and the word-sync suite pass.
- Existing `settings.json` files keep their stored editor sizes and overrides.

## Open questions

- **Exact multipliers.** Resolved at approval: Compact 1.3, Normal 1.5, Wide
  1.8.
- **Compact at 10 px.** Use 1.3 as approved; if the manual check shows
  overlapping glyphs with a bundled face, increasing the value is the only
  remedy, but 1.3 is the chosen default.
- **Editor only or preview too?** Resolved: editor only, matching the section
  and the existing 1.72 preview reading line height.
- **Global or per preset?** Resolved: global, like Content Width. No
  `PresetOverride` field was added.
