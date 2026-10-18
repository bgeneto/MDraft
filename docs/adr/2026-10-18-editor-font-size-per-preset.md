# Editor font size, Preview font size and Math scale are remembered per preset

**Status:** accepted
**Date:** 2026-10-18
**Supersedes:** `2026-10-17-preset-size-memory.md`

## Context

`2026-10-17-preset-size-memory.md` separated preset identity (the four font
stacks and four OpenType booleans) from two per-preset reader adjustments
(`bodyFontSize` and `mathFontScale`). Meanwhile, `editorFontSize` remained a
global setting under **Preferences › Editor**, and every unadjusted preset
started at the global defaults (`16 px` and `100 %`).

In practice, switching between presets with different x-heights and code faces
also calls for per-preset control of the source editor's font size in the same
Typography section, and the **Serif** (`superfamily`) preset benefits from a
larger initial prose size (`18 px`), a tighter KaTeX scale (`80 %`), and
oldstyle figures enabled by default.

## Decision

1. **Three per-preset adjustable sizes:** `PresetOverride` in
   `Settings.preset_overrides` stores optional `editorFontSize`, `bodyFontSize`,
   and `mathFontScale`. All three controls (**Editor font size**, **Preview font
   size**, **Math scale**) live in **Preferences › Typography**, with **Editor
   font size** placed immediately above **Source Editor**.
2. **Per-preset initial size defaults:** `TypographyPreset` may declare optional
   `defaults` (`editorFontSize`, `bodyFontSize`, `mathFontScale`). When a preset
   is selected and has no remembered value for a size in `presetOverrides`, it
   uses `preset.defaults?.[key]` before falling back to the application default
   (`16 px` / `16 px` / `100 %`). Because these defaults live outside
   `preset.values`, adjusting any of the three sizes still keeps the preset
   active rather than flipping the picker to **Custom (user)**.
3. **Serif preset defaults:** **Serif** (`superfamily`) sets
   `oldstyleFigures: true` in `values` and `defaults: { bodyFontSize: 18, mathFontScale: 80 }`.

## Consequences

- Top-level `editorFontSize`, `bodyFontSize`, and `mathFontScale` remain the
  active settings read by the editor, preview, and exports.
- Existing `settings.json` files without `editorFontSize` in `presetOverrides`
  continue to load cleanly, and lazy migration populates missing fields on the
  outgoing preset when switching.
