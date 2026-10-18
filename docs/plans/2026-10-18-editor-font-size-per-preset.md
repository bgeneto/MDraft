# Per-preset Editor font size, Typography UI labels, and Serif defaults

**Status:** done
**Date:** 2026-10-18
**ADR:** `../adr/2026-10-18-editor-font-size-per-preset.md` (to be created with the implementation, superseding `2026-10-17-preset-size-memory.md`)

## Context and goal

Currently:

1. The source editor's font size (`editorFontSize`) is configured globally under **Preferences › Editor › Font Size**, while **Preview text size** (`bodyFontSize`) and **Math scale** (`mathFontScale`) live in **Preferences › Typography** and are remembered per preset via `presetOverrides`.
2. In **Preferences › Typography**, the source-pane font picker is labelled **Editor** and the preview body size is labelled **Preview text size**.
3. The **Serif** preset (`superfamily`) starts at the application defaults (`16 px` preview size, `100 %` math scale) and has **Oldstyle figures in prose** (`oldstyleFigures`) set to `false`.

The goal is to:

- Move the editor font size control from **Preferences › Editor** to **Preferences › Typography**, placed immediately above the source-pane font role as **Editor font size**, and make it remembered per preset alongside **Preview font size** and **Math scale** (while remaining global under **Custom (user)**).
- Rename in the UI only:
  - **Editor** (the `sourceFont` role in Typography) → **Source Editor**
  - **Preview text size** → **Preview font size**
- Set the **Serif** preset defaults to:
  - **Preview font size** = `18 px`
  - **Math scale** = `80 %`
  - **Oldstyle figures in prose** = `On` (`oldstyleFigures: true`)

## Scope and non-scope

**In scope:**
- Extend `PresetOverride` in Rust (`src-tauri/src/settings.rs`) and TypeScript (`src/api.ts`) with optional `editorFontSize`.
- Add per-preset default sizes (`defaults?: { editorFontSize?: number; bodyFontSize?: number; mathFontScale?: number }`) to `TypographyPreset` in `src/fonts.ts`, configure **Serif** (`superfamily`) with `bodyFontSize: 18`, `mathFontScale: 80`, and `oldstyleFigures: true`, and rename the `sourceFont` role label from `"Editor"` to `"Source Editor"`.
- In `src/preferences.ts`, remove **Font Size** from the **Editor** section, add **Editor font size** in **Typography** right above **Source Editor**, rename **Preview text size** to **Preview font size**, and wire `editorFontSize` into `updateSize` and preset switching.
- Update `scripts/dom-smoke.mjs`, `docs/typography.md`, and add an ADR.

**Non-scope:**
- Renaming the **Preferences › Editor** section title itself (only the `sourceFont` role label in **Typography** changes from **Editor** to **Source Editor**).
- Renaming the persisted keys in `settings.json` (`editorFontSize`, `bodyFontSize`, `mathFontScale`, `sourceFont` remain unchanged for backward compatibility).
- Changing how `View › Zoom In / Zoom Out / Actual Size` works in `src/main.ts`.

## Approach and rejected alternatives

Extend the existing split between preset **identity** (`TypographyPreset.values`: the four font stacks and four OpenType booleans) and **per-preset reader adjustments** (`PresetOverride` in `settings.presetOverrides`):

1. **Identity & OpenType (`src/fonts.ts`):**
   - In `TYPOGRAPHY_PRESETS`, the `superfamily` (**Serif**) preset sets `oldstyleFigures: true` in `values`. Because `oldstyleFigures` is an OpenType switch, it is part of the preset's identity: choosing **Serif** turns **Oldstyle figures in prose** on, and toggling the checkbox manually switches the preset picker to **Custom (user)** just like every other OpenType switch.
2. **Per-preset default and remembered sizes (`src/fonts.ts`, `src-tauri/src/settings.rs`, `src/api.ts`, `src/preferences.ts`):**
   - `PresetOverride` gains `editor_font_size: Option<u32>` (`editorFontSize?: number`).
   - `TypographyPreset` gains an optional `defaults` object for initial adjustable sizes (`editorFontSize`, `bodyFontSize`, `mathFontScale`). When a preset has no remembered override for a field, it falls back to `preset.defaults?.[key]` and then to the application default (`DEFAULT_EDITOR_FONT_SIZE = 16`, `DEFAULT_BODY_FONT_SIZE = 16`, `DEFAULT_MATH_SCALE = 100`).
   - **Serif** (`superfamily`) specifies `defaults: { bodyFontSize: 18, mathFontScale: 80 }`.
   - Editing **Editor font size**, **Preview font size**, or **Math scale** calls `updateSize(key, value)`, which writes both the top-level setting and `presetOverrides[preset.id][key]` when a preset is active, or only the top-level setting under **Custom (user)**.
   - Switching presets saves any unrecorded `editorFontSize`, `bodyFontSize`, and `mathFontScale` on the outgoing preset before applying the incoming preset's remembered (or default) values.

**Rejected:** Putting `bodyFontSize: 18` and `mathFontScale: 80` inside `TypographyPreset.values` for **Serif**. `activePreset()` compares `values` to determine which preset is active; including sizes in `values` would cause any size adjustment to immediately flip the preset picker to **Custom (user)**.

## Steps

- [x] Add `editor_font_size: Option<u32>` to `PresetOverride` in `src-tauri/src/settings.rs` and update/add Rust unit tests for `PresetOverride` serialization and partial overrides.
- [x] Add `editorFontSize?: number` to `PresetOverride` in `src/api.ts`.
- [x] In `src/fonts.ts`:
  - Export `DEFAULT_EDITOR_FONT_SIZE = 16`.
  - Rename the `sourceFont` role label from `"Editor"` to `"Source Editor"`.
  - Add `defaults?: { editorFontSize?: number; bodyFontSize?: number; mathFontScale?: number }` to `TypographyPreset`.
  - Set `oldstyleFigures: true` and `defaults: { bodyFontSize: 18, mathFontScale: 80 }` on the **Serif** (`superfamily`) preset, and update its description note.
- [x] In `src/preferences.ts`:
  - Remove the **Font Size** row from the **Editor** section.
  - Place **Editor font size** (10–40 px) in **Typography** under **Faces**, immediately above **Source Editor**.
  - Rename **Preview text size** to **Preview font size**.
  - Extend `updateSize` and the preset `set` handler to include `editorFontSize` and consult `preset.defaults` before the global defaults.
- [x] Update `scripts/dom-smoke.mjs` to match the new labels (`Source Editor`, `Editor font size`, `Preview font size`), the **Serif** defaults (`18 px`, `80 %`, oldstyle figures on), and verify that `Editor font size` is remembered per preset.
- [x] Update `docs/typography.md` and record the decision in `docs/adr/2026-10-18-editor-font-size-per-preset.md`.
- [x] Run validation (`npm run build`, `npm run test:rust`, `npm run smoke`, `npm run typography`).

## Files and modules

| File | Why it must change |
| --- | --- |
| `src-tauri/src/settings.rs` | Add `editor_font_size` to `PresetOverride` and unit tests |
| `src/api.ts` | Add `editorFontSize` to `PresetOverride` |
| `src/fonts.ts` | Rename `Editor` role to `Source Editor`, export `DEFAULT_EDITOR_FONT_SIZE`, set `Serif` defaults (`18 px`, `80 %`, `oldstyleFigures: true`) |
| `src/preferences.ts` | Move `Editor font size` to Typography above `Source Editor`, rename `Preview font size`, persist per preset |
| `scripts/dom-smoke.mjs` | Update UI labels, test `Editor font size` per-preset persistence and `Serif` initial defaults |
| `docs/typography.md` | Document `Editor font size`, `Source Editor`, `Preview font size`, and the `Serif` defaults |
| `docs/adr/2026-10-18-editor-font-size-per-preset.md` | Supersede `2026-10-17-preset-size-memory.md` with the three per-preset sizes and per-preset size defaults |

## Risks and rollback

- **Existing `settings.json` files with `Serif` active (`oldstyleFigures: false`):** Because `Serif` now requires `oldstyleFigures: true` in its identity, a profile that previously saved `Serif` with `oldstyleFigures: false` will show as `Custom (user)` until the user clicks **Serif** again (which turns `oldstyleFigures` on and applies the `18 px` / `80 %` defaults or any remembered overrides).
- **DOM smoke test selectors:** `dom-smoke.mjs` queries rows by exact label (`Source Editor`, `Editor font size`, `Preview font size`) and section (`Typography` instead of `Editor` for `setFonts`). Updating all references keeps the 93 checks green.
- **Rollback:** Revert the commits; `editorFontSize` inside `presetOverrides` is ignored by older builds thanks to serde's default handling.

## Tests and validation

- `npm run build` — TypeScript check and Vite bundle.
- `.\scripts\cargo-vcvars.cmd test --manifest-path src-tauri\Cargo.toml` — Rust unit tests for `settings.rs`.
- `npm run smoke` — 93 DOM checks covering the updated labels, `Serif` defaults (`18 px` / `80 %`), per-preset `Editor font size`, `Preview font size`, and `Math scale` round-tripping, and scroll sync at multiple font sizes.
- `npm run typography` — 26 checks covering preset activation and font rendering.

## Acceptance criteria

- **Font Size** is no longer in **Preferences › Editor**.
- In **Preferences › Typography**, **Editor font size** appears immediately above **Source Editor**, and **Preview text size** is now labelled **Preview font size**.
- Selecting **Serif** on a fresh profile sets **Editor font size** to `16 px`, **Preview font size** to `18 px`, **Math scale** to `80 %`, and **Oldstyle figures in prose** to `On`, with **Serif** remaining the active preset.
- Changing **Editor font size**, **Preview font size**, or **Math scale** under an active preset keeps that preset active and remembers all three values when switching to another preset and back.
- Existing `settings.json` files load without error.

## Open questions

- None.
