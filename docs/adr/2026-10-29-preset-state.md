# Typography presets keep a stored id and per-field diffs, and Custom is a preset

**Status:** accepted
**Date:** 2026-10-29
**Supersedes:** `2026-10-18-editor-font-size-per-preset.md`
(and, through it, `2026-10-17-preset-size-memory.md`)
**Amends:** the "Custom until a new preset is chosen" consequence of
`2026-10-18-typography-presets.md`; the bundled faces and the six preset
systems in that ADR remain.

## Context

A preset's identity was inferred by comparing the live settings with each
preset's `values` (four font stacks and four OpenType switches). That made
**Custom** the label the picker fell back to whenever a value no longer
matched, rather than a choice the reader could make. The `set` handler for
`"custom"` found no preset and returned, so the pill could not be clicked.
Editing one face of Serif silently turned the panel into Custom, and there was
nowhere to remember the edited face: `presetOverrides` held only the four
sizes. Switching away and back could not restore a face or an OpenType switch.

The reader asked for a selectable Custom preset based on System, for edits to
stay in whichever preset is active, and for a per-preset Reset.

## Decision

**Store the active preset id, and store only the fields a reader changed.**

1. `Settings.typography_preset` is the active id. It is empty in a file written
   before the field existed; the frontend then detects a matching built-in from
   the resolved live values (the old behaviour) or falls back to Custom. A
   stored id always wins over detection, so editing a face cannot change the
   active preset.
2. `Settings.preset_overrides[id]` is an `Option` per typography field: four
   faces, four sizes and four OpenType booleans. `None` means "use the preset's
   built-in value", so a later release can still improve an untouched part of a
   preset. The old size-only entries load unchanged.
3. Editing any typography field writes the top-level active value and
   canonicalises that preset's diff. Setting a field back to the built-in value
   removes it; an empty entry is removed.
4. Selecting a preset captures the **outgoing** preset's live differences
   first, then applies the incoming preset's built-ins plus its remembered
   diffs. This also preserves a pre-existing hand-edited setup: on the first
   switch its whole state is stored under Custom.
5. **Reset** removes the active preset's diff and applies its built-ins. Custom
   resets to the System values. Other presets are untouched.
6. **Custom is the seventh choice**, always visible and selectable. It is not in
   `TYPOGRAPHY_PRESETS` (the detection list), so an untouched System setup can
   never be detected as Custom. Its built-in values and defaults are System's;
   the first time it is chosen it starts from System, and its own diff is
   remembered afterwards.
7. The top-level face, size and OpenType fields remain the active values every
   consumer reads (editor, preview, exports). No export code changes.

## Consequences

- Editing a face, an OpenType switch or a size keeps the selected preset. The
  note says **Adjusted**, and the per-preset Reset is enabled.
- Switching away and back restores the preset's own faces, sizes and OpenType
  choices. Custom is a real saved setup rather than a transient label.
- A fresh install still reports System. An older `settings.json` loads with its
  current faces and sizes; an old face-edited setup opens as Custom (as before)
  and is preserved under Custom when a named preset is chosen.
- `presetOverrides` grows from four optional numbers to twelve optional fields.
  It is backward compatible in both directions: an older build ignores the new
  fields and still reads the active top-level values, while a newer build reads
  the old size-only entries.
- A preset's built-in value is compared as a resolved stack, not as raw text:
  an empty setting means the role fallback. System and Custom's fallback stack
  is also reported as **System default** in the picker, so the reader sees the
  intent rather than `system-ui`.
- The reset action is destructive but guarded: the button is disabled when the
  preset is unadjusted, and the first click arms a four-second confirmation.
- The custom id and the widened overrides are the only schema that outlives
  this change; the UI and the picker can be replaced without touching them.

## Alternatives rejected

- **Keep deriving the preset and add a Custom button:** the core complaint
  remains — editing a face still leaves the preset, and there is nowhere to
  remember it.
- **Make named presets immutable and edit only Custom:** simpler, but it does
  not meet the request to adjust and reset each preset, and one change in Serif
  would force rebuilding the whole system in Custom.
- **Store a full snapshot per preset:** it freezes built-in values the reader
  never touched, so a later release cannot improve a preset without overwriting
  a choice. Per-field diffs match the existing `PresetOverride` contract.
- **Keep the four sizes global under Custom:** Custom would then differ from
  every other preset for no reader-visible reason. It is a preset and remembers
  all twelve fields.
