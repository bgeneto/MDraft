# There is one editable combobox engine, and short closed lists stay native selects

**Status:** accepted
**Date:** 2026-11-02

## Context

Two surfaces need the same control: a text field whose value is either chosen
from a list or typed by hand, with the list opening whole and filtering only
while the reader types. The AI Assistant's Model field got one on 2026-10-28
(`src/model-combo.ts`) after a `<datalist>` opened empty for a saved id; the
Translate target still used `<datalist>`, whose popup is browser chrome: its type
scale, row height, hover tint, mark on the current value and scrollbar are
unreachable from CSS. `color-scheme` on `:root` and `[data-theme="dark"]` does
give it the right light/dark form controls, so the defect is typography and
rhythm, not palette.

A third, older control exists: `src/font-picker.ts`, a button trigger with
grouped two-line specimens and its own search field inside the popup.

## Decision

`src/combo.ts` is the single implementation of the editable combobox:
`filterEntries` (pure), `attachCombo`, `closeCombo`, and one module-level popup
owner. `src/model-combo.ts` is a thin wrapper over it, and the AI Assistant's
Translate target uses it directly. Its CSS is structural (`combo`,
`combo-toggle`, `combo-popup`, `combo-option`, `combo-empty`); each surface
supplies its own width context (`prefs-combo`, `ai-param-combo`).

The popup is appended to `document.body` and positioned `fixed` from the field's
rectangle, because both callers sit inside a scrolling panel. It closes on
outside pointerdown, panel scroll, window resize and its owner's teardown.

A short closed enumeration keeps a native `<select>`: Tone (6), Convert (3), and
every Preferences enumeration. `src/font-picker.ts` stays out of the engine
because it is a different control — a button that shows a specimen, grouped rows,
and search inside the popup rather than in the field.

## Consequences

- A new picker that needs free text plus suggestions uses `attachCombo`; it does
  not copy the popup, the outside-click listener or the positioning maths.
- `filterEntries` must stay pure and free of top-level DOM, because
  `scripts/ai-unit.mjs` loads it under Node with only the types stripped.
- The component owns one popup at a time for the whole application, so every
  surface that can hide or rebuild a combo row has to call `closeCombo()`. A
  forgotten call leaves a list floating beside a detached field.
- The value a combo commits is the caller's choice and is not normalised by the
  component: a model id is an id, a language is a readable name that reaches the
  prompt verbatim. Search-only metadata belongs in `keywords`.
- Folding the font picker into this engine, or replacing a short native select
  with it, now requires arguing with this record rather than choosing quietly.
