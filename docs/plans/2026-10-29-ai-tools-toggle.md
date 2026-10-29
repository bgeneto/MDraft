# Tools › AI Assistant as an enable/disable check item

**Status:** done
**Date:** 2026-10-29
**ADR:** none

## Context and goal

The AI Assistant is enabled by `settings.aiEnabled`, and the floating button's
new right-click menu can already turn it off. The native **Tools › AI Assistant…**
item is still an ordinary `MenuItem`: it opens the palette (or Preferences when
the assistant is not configured), carries `CmdOrCtrl+Shift+Space`, and never
shows whether the assistant is on. That is inconsistent with the context menu
and with the other Tools check item, **Check Spelling While Typing**.

After this change **Tools › AI Assistant** is a `CheckMenuItem` whose check mark
mirrors `aiEnabled`. Clicking it turns the assistant on or off instead of
opening the palette. It has no accelerator, so `Ctrl+Shift+Space` no longer
opens or toggles anything; the floating button remains the way to open the
palette.

## Scope and non-scope

In scope: the native Tools item, its check state, its click handler, removal of
its accelerator, and the documentation and tests that name that accelerator or
the old "opens the assistant" behaviour.

Not in scope: the floating button's context menu, the palette itself, the
Preferences AI section, and the keyboard path to the button (Tab focus plus the
Menu key or Shift+F10). The historical design in
`docs/plans/2026-10-28-ai-assistant.md` is left as the record of what was
originally agreed.

## Approach and rejected alternatives

`tools.ai` becomes a `CheckMenuItem` through the existing `check(...)` menu
helper. `MenuState` gains `ai_enabled`, populated from `Settings` and sent by the
frontend, so the initial build, every later `menu_state` sync and a menu rebuild
all derive the check from one place. The frontend handler toggles
`settings.aiEnabled` through `applySettingsPatch`, which already persists,
updates the floating button and syncs the menu.

Rejected alternatives:

- Keep the item as an opener and add a second check row: two adjacent AI rows,
  and the user explicitly chose the single toggle.
- Show a check mark but keep the click opening the palette: a native check item
  toggles itself on click, so the mark would be wrong until the next state sync.
- Keep `Ctrl+Shift+Space` as a toggle: the user explicitly asked for no shortcut
  on enable/disable.

## Steps

- [x] Add `ai_enabled` to `MenuState`, `from_settings`, `with_settings`, the TS
      `MenuState` interface and `menuStateSnapshot`.
- [x] Add `tools.ai` to `CHECK_IDS` and `is_checked`.
- [x] Build `tools.ai` with `check(...)`, label it `AI Assistant`, and remove
      `Some("CmdOrCtrl+Shift+Space")`.
- [x] Make the `tools.ai` handler toggle `aiEnabled`; remove the now-unused
      `AssistantHandle.open` route.
- [x] Remove the shortcut from the button title, the Preferences help, README and
      AGENTS; update the test counts and the accelerator-count note.
- [x] Update the menu suite for the check state and both toggle directions, and
      the shortcut suite for the absent accelerator and the unclaimed chord.
- [x] Add a Rust assertion for the settings-backed check.
- [x] Run formatting, typecheck, lint, the Rust tests and the app-free suites;
      run the UI suites when no unrelated MDraft instance is open.

## Files and modules

- `src-tauri/src/menu.rs` — state field, check table, item kind, no accelerator.
- `src/api.ts` — `MenuState.aiEnabled`.
- `src/main.ts` — snapshot field and the toggle handler.
- `src/ai/assistant.ts` — remove the unused `open` handle and the shortcut from
  the button title.
- `src/preferences.ts` — the AI help text no longer promises a shortcut.
- `scripts/menu-test.mjs` — check state and toggle behaviour.
- `scripts/shortcut-test.mjs` — absence of the accelerator and of the effect.
- `README.md`, `AGENTS.md` — user documentation and the changed counts.
- `docs/plans/2026-10-29-ai-tools-toggle.md` — this record.

## Risks and rollback

The user loses the only keyboard accelerator that opened the palette; the FAB
and its context menu are the remaining routes, so this is intentional but should
be stated in the README. A menu rebuild must copy `ai_enabled` from settings in
`with_settings`, or the check reverts to off whenever export formats or recent
files rebuild the menu. Rollback is the previous `item(...)` line and the
accelerator registration; the setting itself is unchanged and older profiles
keep loading.

## Tests and validation

- `cargo test` for the `MenuState` check table.
- `npm run menu` for the check mark in both directions and the absence of a
  Preferences overlay.
- `npm run shortcuts` for the registry and for `Ctrl+Shift+Space` doing nothing.
- `npm run ai` for the context menu (unchanged) and its Settings route.
- `npm run build`, `npm run lint`, `npm run format:check`, `npm run knip`.

The measurement that proves it: after emitting `tools.ai`, `get_settings()`
reports `aiEnabled` flipped and `menu_items` reports the same `checked` value;
pressing `Ctrl+Shift+Space` leaves both the palette and Preferences closed.

Run on 2026-10-29: `cargo check`, `cargo test --lib` (229 passed, 2 ignored),
`npm run build`, `npm run lint`, `npm run format:check`, `npm run knip` and
`npm run ai:unit` (128/128) passed. The native menu suites remain unrun because
the owner's installed MDraft instance was open; the harness refuses to share its
identifier.

## Acceptance criteria

- **Tools › AI Assistant** has a check mark exactly when `aiEnabled` is true.
- Clicking it toggles `aiEnabled`, persists the change, shows or hides the FAB
  (when configured), and updates the check without a restart.
- No accelerator is registered for `tools.ai`; `Ctrl+Shift+Space` opens nothing.
- The menu, shortcut and AI suites pass with their documented counts updated.

## Open questions

None. The user chose the single toggle, no shortcut, and the label `AI Assistant`.
