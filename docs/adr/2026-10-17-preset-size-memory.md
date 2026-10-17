# Preview text size and Math scale are remembered per preset, not defined by it

**Status:** accepted
**Date:** 2026-10-17

## Context

The typography presets used to be complete fixed bundles: picking one wrote the
four font stacks, `bodyFontSize` and the OpenType switches. The active preset was
inferred by comparing those values, so changing Preview text size immediately
turned the picker into "Custom (user)", and the value was not remembered when
another preset was chosen. Math scale had the same problem from the other side:
it was a single global percentage that every preset overwrote or ignored.

The reader needs both sizes to be properties of the preset they were set under:
Serif at 19 px / 83%, System at 16 px / 100%, and a round trip through other
presets must restore each pair. The values must survive a restart, and a
`settings.json` written before this change must keep loading with no visible
loss for the preset in use.

## Decision

A preset's **identity** is only its four font stacks and its OpenType switches.
Preview text size and Math scale are reader adjustments stored in
`Settings.preset_overrides: BTreeMap<String, PresetOverride>`, keyed by the stable
preset id. Each `PresetOverride` has optional `bodyFontSize` and
`mathFontScale`; a missing field means the application default (16 px / 100%).

The top-level `bodyFontSize` and `mathFontScale` remain the **active** values, so
the preview, exports and the rest of the application read the same fields as
before. The map is consulted only when a preset is selected.

- Picking a preset seeds any missing entry for the outgoing preset from the
  current global values (the lazy migration), then applies the incoming
  preset's remembered pair or the defaults.
- Editing either size under an active preset writes the global value and that
  preset's entry. Under "Custom (user)" it writes only the global value.
- Re-clicking the active preset re-runs its `set`, which restores its stored
  pair after a hand-edited global value.

## Consequences

- A fresh profile starts System at 16 px / 100%, and an unvisited preset also
  starts there. The old Serif/Literary 17 px starting size is gone: the reader
  sets it once and Serif remembers it from then on.
- A size-only difference no longer makes a preset "Custom (user)"; changing a
  face or an OpenType switch still does.
- The settings schema gains one backward-compatible object. Older builds ignore
  it; newer builds default it to empty. Unknown preset ids are inert.
- `PresetOverride` is the place to add another adjustable size later; the preset
  identity must stay on faces and OpenType, or editing a size would flip the
  picker.
- Exports keep using the active top-level values, so no export code changes and
  no format change.
