# Per-preset Preview text size and Math scale

**Status:** done
**Date:** 2026-10-17
**ADR:** `../adr/2026-10-17-preset-size-memory.md` (created with the implementation)

## Context and goal

The preset picker writes a fixed bundle of typography values (faces,
`bodyFontSize` and the OpenType switches), and infers the active preset by
comparing those values. Changing `bodyFontSize` therefore makes the picker say
"Custom (user)", and the value is not remembered when another preset is chosen.

The reader's requirement is stronger: **Preview text size must not be a fixed
part of the preset definition.** Both Preview text size and Math scale are
adjustments remembered for each preset. Set Serif to 19 px and 83%, switch to
System, then back to Serif: both values must return. A preset that has never
been adjusted starts at the application defaults (16 px and 100%). The active
value is still what `applyTypography` and the exports read; the new part is one
remembered pair per preset. A settings file written before this change must keep
loading, and the current global values must not be lost for the preset the
reader is already using.

## Scope and non-scope

**In scope:** remove the fixed `bodyFontSize` from the preset definitions;
per-preset memory for `bodyFontSize` and `mathFontScale`; preset selection
applies the remembered pair if present, otherwise 16 px / 100%; editing either
size under an active preset updates that preset and leaves the picker on it;
under Custom both remain global; backward-compatible settings schema; lazy
migration of the current global values; tests, README and an ADR.

**Non-scope:** per-preset memory for faces or OpenType switches. Those stay the
preset's identity: changing a face still moves the picker to "Custom (user)".
The editor font size and content width are editor settings, not typography
presets. The export format does not change; exports keep reading the active
values.

## Approach and rejected alternatives

Split a preset into identity and reader adjustments:

- `TypographyPreset.values` keeps only what identifies the preset — the four
  font stacks and the OpenType booleans. It no longer carries a body size.
- `DEFAULT_BODY_FONT_SIZE = 16` and `DEFAULT_MATH_SCALE = 100` are application
  defaults, exported beside the presets. They apply only when a preset has no
  remembered value; they are not part of any preset.
- `activePreset` compares `values` only. Changing either size therefore cannot
  turn an active preset into "Custom (user)"; changing a face or an OpenType
  switch still can.

Persist the remembered values in one typed map:

```rust
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PresetOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_font_size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub math_font_scale: Option<u32>,
}

pub preset_overrides: BTreeMap<String, PresetOverride>,
```

The map is keyed by the stable preset id (`system`, `superfamily`, `classic`,
`literary`, `technical`). The top-level `bodyFontSize` and `mathFontScale`
remain the **active** values used by the preview and exports. The map only
records what each preset remembers.

Selecting a preset works in this order:

1. Find the outgoing preset (`activePreset` before the update) and fill any
   missing entries for it with the current global `bodyFontSize` and
   `mathFontScale`. This is the lazy migration for settings written before the
   map existed, and it also covers a size edited by hand.
2. Apply the incoming preset's identity values plus
   `override?.bodyFontSize ?? DEFAULT_BODY_FONT_SIZE` and
   `override?.mathFontScale ?? DEFAULT_MATH_SCALE`, and the updated map.

Changing Preview text size or Math scale under an active preset writes both the
global value and that preset's entry. Under "Custom (user)" it writes only the
global value. Re-clicking the preset that is already active must re-run the
preset `set` (remove the generic choices early-return) so it restores its stored
pair after a hand-edited global value.

**Rejected:** keeping `bodyFontSize` in `TypographyPreset.values` and merely
making the picker ignore it. It would leave a fixed preset size in the
definition, which the reader explicitly rejected, and the preset note for
Literary would keep claiming a size the preset no longer owns. **Rejected:**
adding the sizes to `values` and paying attention only on selection. Editing
either still makes the preset Custom and the edited value is lost on the next
switch. **Rejected:** a full typography snapshot per preset. Faces and OpenType
are identity and already compared; duplicating them would create two sources of
truth. **Rejected:** separate maps per size. One typed override object keeps the
pair together, adds one schema field, and leaves room for another adjustable
size.

## Steps

- [x] Add `PresetOverride` and `preset_overrides: BTreeMap<String, PresetOverride>`
      to `Settings`, with a default empty map; add Rust tests for the default,
      an older file without the field, a body-only override and a round trip.
- [x] Add `PresetOverride` and `presetOverrides` to `api.Settings`.
- [x] In `fonts.ts`, remove `bodyFontSize` from every preset's `values`, export
      `DEFAULT_BODY_FONT_SIZE = 16` and `DEFAULT_MATH_SCALE = 100`, and correct
      the Literary note that promises a larger measure.
- [x] In `preferences.ts`, split the preset application from the size setters:
      seed the outgoing preset, apply the incoming preset's remembered or
      default pair, and update the map when either size is edited under an
      active preset. Update the Preset, Preview text size and Math scale help
      texts. Let a preset button re-run when already active.
- [x] Extend the typography-size phase of `dom-smoke.mjs`: set both sizes under
      System, verify the active label stays System, switch to Serif and set a
      different pair, visit Classic, return to Serif, and assert both values;
      then return to System and assert its pair. Reset to System at 16 px and
      100% before closing the panel.
- [x] Update the Typography section and test table in `README.md`; update the
      smoke count wherever AGENTS.md quotes it.
- [x] Write the ADR recording the identity/adjustable split and the map.
- [x] Validate with the layers below.

## Execution notes

- `npm run build` passed. `cargo test` passed 64 tests with 1 ignored.
- `npm run smoke` passed 90/90 against a fresh instance; `npm run typography`
  passed 26/26.
- A restart check read Serif as 19 px / 83% and System as 16 px / 100% after
  closing and relaunching the release binary.
- Deviation from the draft: the Serif/Literary 17 px starting size was removed
  entirely, as the final requirement asked. A fresh Serif starts at 16 px and
  remembers 17 once the reader sets it; an existing profile keeps its current
  size through the outgoing-preset seed.
- `AGENTS.md` now quotes 65 Rust tests (64 run), 90 smoke checks and the README
  table has the new preset-size row.


## Files and modules

| File | Why it must change |
| --- | --- |
| `src-tauri/src/settings.rs` | The typed map is persisted settings; serde defaults and tests |
| `src/api.ts` | The frontend reads and writes the new map |
| `src/fonts.ts` | Remove the fixed preset size; add the two application defaults |
| `src/preferences.ts` | Preset selection and both size setters |
| `scripts/dom-smoke.mjs` | The per-preset round trip is the observable proof |
| `docs/adr/2026-10-17-preset-size-memory.md` | Records the durable schema and identity decision |
| `README.md` | Typography docs and the test count |
| `AGENTS.md` | Smoke count, if it changes |

`src/main.ts` should not need to change: `applySettingsPatch` already applies
`bodyFontSize` and `mathFontScale`, and the Preferences patch carries the map.

## Risks and rollback

- **Identity must stay on faces and OpenType only.** If `bodyFontSize` or
  `mathFontScale` remains in `values`, the first edit flips the picker to
  Custom. The smoke test asserts the label stays on the preset after editing
  either size.
- **Fresh installations lose the Serif/Literary 17 px starting size.** That is
  the direct consequence of removing the size from the preset definition: an
  unadjusted Serif now starts at 16 px, and the reader sets 17 once if they want
  it. Existing profiles keep their current global size through the lazy
  migration. The Literary note must stop claiming a larger measure.
- **Behaviour change for size-only custom setups.** A reader whose only
  difference was a body size will now see the matching preset active with that
  size remembered, rather than "Custom (user)". That follows from the request,
  but it is user-visible and belongs in the README.
- **Lazy migration runs on switch or re-click.** A reader who upgrades and never
  switches still has the global values in force; the first switch seeds the
  outgoing preset before applying another. No value is lost.
- **A preset's default changes in a future release.** A preset with no override
  follows the application default; a preset with an override keeps the reader's
  value.
- **Downgrade:** Serde ignores unknown fields by default, so an older build
  reads a file containing `presetOverrides` and keeps the top-level sizes.
  Rollback is reverting the files; no setting is lost.
- `BTreeMap` serialises keys in a stable order, keeping `settings.json`
  reviewable.

## Tests and validation

- Rust: `cargo test` covers the serde default, an older file without the field,
  a body-only override (math omitted) and a round trip.
- Typecheck: `npm run build`.
- `npm run smoke` against a fresh `samples/feature-tour.md` instance proves both
  per-preset round trips, the active label staying on the preset, and the
  existing bounds/math scale checks.
- `npm run typography` proves every preset still reports itself active after
  selection, and that the font matrix is unchanged.
- Manual: set Serif to 19 px / 83%, visit System and Classic, return to Serif,
  relaunch and repeat. Under Custom set 21 px / 90%, switch presets, and confirm
  no preset inherited the Custom values.
- The single measurement: after Serif 19/83 → System 16/100 → Serif, the two
  inputs read 19 and 83 and the Preset picker reads Serif.

## Acceptance criteria

- A fresh installation has System active, Preview text size 16, Math scale 100,
  and an empty override map.
- Set Preview text size 19 and Math scale 83 under Serif. Choose Classic
  (16/100), then System (16/100), then Serif: both inputs read 19/83 and the
  picker stays on Serif.
- Set System to 18/90, visit another preset and return: 18/90 are still there.
- Editing either size under an active preset leaves the preset active; it does
  not change the picker to "Custom (user)".
- Editing a face or an OpenType switch still leaves the picker on
  "Custom (user)"; editing either size then changes only the global value and no
  preset entry.
- A settings file without `presetOverrides` loads, and the current global pair is
  preserved for the active preset when the reader first switches or re-clicks.
- HTML and PDF exports use the active `bodyFontSize` and `mathFontScale` exactly
  as before.

## Open questions

- Should the old 17 px starting size of Serif/Literary be preserved as a
  one-time initial override for existing profiles only, or dropped entirely?
  Default: dropped from the preset definition; an existing profile keeps its
  current global size, a fresh profile starts at 16 and the reader sets 17 once.
- Should faces or OpenType switches also become per-preset remembered? Default:
  no; they are the identity and changing one still means "Custom (user)".
- Should editing sizes under Custom update the last active preset? Default: no;
  Custom is global.
- Should the map be pruned when a preset is removed? Default: leave unknown keys
  alone; they are inert and removing data is worse.
