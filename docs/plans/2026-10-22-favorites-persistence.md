# Favorites: prove persistence across launches and close the stale-save race

## Context and goal

The Favorites panel persists its list in `settings.json`, but the suite that
covers it only reads `get_settings` — the running instance's memory — and never
restarts the application or reads the file back. Acceptance criterion 11 of
`docs/plans/2026-10-21-favorites-sidebar.md` ("a restart preserves the list, its
order and its entries") therefore had no test.

While investigating a reported loss, a second weakness was confirmed: the shell
writes the whole `Settings` object (`persist`, `flushRememberedTabs`) while the
favorite and recent commands return whole snapshots of their own. A save whose
snapshot predates an in-flight `add_favorite` and reaches Rust after it
overwrites the list, on disk and in memory. It was reproduced deliberately by
issuing `add_favorite` followed immediately by `save_settings` with the stale
snapshot.

Goal: make a stale whole-object save impossible for the list-owning commands,
and add a two-launch suite that proves a favorite survives a real close and a
real restart, in order, with its panel rows.

## Scope

**In scope**

- Serialise every settings mutation/write in the frontend through one queue;
  reads of `settings` happen when a queued write runs, not when it is scheduled.
- Merge only the fields each command owns (`favorites`, `recentFiles`,
  `lastDirectory`) instead of replacing the whole object with a command reply.
- Make the close flush wait for the queue (bounded, as before).
- New two-launch suite `scripts/favorites-restore-test.mjs`, registered as the
  `favorites-restore` restart layer.
- Documentation: this plan, `AGENTS.md` script/tables/counts.

**Non-scope**

- Changing the `settings.json` schema or any `#[tauri::command]` shape.
- Changing the Favorites UI, row rules, ordering or cap.
- A disk-writing unit test in Rust; the two-launch suite covers the real path.

## Approach

`main.ts` gets `queueSettings(task)`: a promise chain that survives a failed
task and returns the failure to its caller. Every route that reads or writes
the settings object goes through it:

- `persist()` queues `api.saveSettings(settings)` and reads `settings` **inside**
  the task, after any earlier favorite/recent command has completed.
- `get_settings` at boot, `add_favorite`/`remove_favorite`, `add_recent` and
  `clear_recent` are queued too, so their replies cannot land out of order.
- Command replies are merged field-by-field, so a preference patch made while a
  command was in flight is not thrown away by its whole-object reply.
- `flushRememberedTabs()` enqueues the remembered-tab write and then waits for
  the queue (raced with the existing 750 ms bound) before the window closes.

Rejected alternative: a save queue alone, without queueing the commands. It
would order writes but still let a save read a snapshot taken before the add.
Rejected alternative: ignoring `favorites` in `save_settings` on the Rust side.
That would silently make a genuine whole-object reset impossible and keep the
same bug for `recentFiles` without fixing the frontend state.

## Steps

- [x] Add `queueSettings` and route `persist()` through it.
- [x] Queue and merge the favorite commands; keep the toast/render behaviour.
- [x] Queue and merge `add_recent`/`clear_recent` callers.
- [x] Queue boot `get_settings` and the close flush, with the existing bound.
- [x] Add `scripts/favorites-restore-test.mjs` (phase 1 adds via both menus and
      leaves a tab change for the close flush; phase 2 verifies the list, order,
      `sidebarTab` and panel rows from a launch without a document argument).
      Phase 1 also schedules a whole-settings save during the second add, which
      is the stale-save regression check.
- [x] Register the suite in `scripts/test-all.mjs`.
- [x] Update `AGENTS.md` (script tables, layer table, counts, layer total) and
      the Favorites plan's deviation note.
- [x] Validate: `npm run build`, `npm run lint`, `npm run format:check`,
      `npm test -- --only favorites,favorites-restore`, then the full `npm test`.

## Affected files

| File | Change |
| --- | --- |
| `src/main.ts` | Settings write queue, merged command replies, close barrier |
| `scripts/favorites-restore-test.mjs` | New two-launch suite |
| `scripts/test-all.mjs` | Register `favorites-restore` |
| `scripts/format-document-test.mjs` | Recompute the physics right-click in one task, with one retry |
| `AGENTS.md` | Script tables, layer row/counts, plan reference, trap entry |
| `docs/plans/2026-10-21-favorites-sidebar.md` | Deviation note: restart coverage |
| `docs/plans/2026-10-22-favorites-persistence.md` | This plan |

## Risks and rollback

- **A failed command could wedge the queue.** The chain catches every rejection
  and resolves, while the caller still receives the error.
- **A queued write could starve the close.** The close flush keeps its 750 ms
  bound; a wedged IPC still ends the window, and the favorites command has
  already written its own copy.
- **Merging fields could miss one a command changed.** The commands only touch
  `favorites`, `recentFiles` and `lastDirectory`; the mapping is explicit and
  covered by the existing Favorites and Recent suites.
- Rollback: revert the commit; no schema or format changed.

## Tests and validation

- New restart layer: phase 1 uses the editor menu for one favorite and the tab
  menu for another, asserts insertion order and rows, then closes a tab just
  before the window closes; phase 2 boots without a document argument and
  asserts the stored list, its order, the remembered sidebar panel and both
  rows, then opens a row.
- Existing `favorites` (56) and `recent-menu` (26) suites must stay green.
- `npm run build`, `npm run lint`, `npm run format:check`.

## Acceptance criteria

1. A favorite added through either menu is present after WM_CLOSE and a fresh
   launch, in the order it was added.
2. The Favorites panel shows those rows at boot when it was the last panel.
3. A whole-object save scheduled after a favorite command sends the object that
   includes it; the deliberate stale-save sequence can no longer erase it.
4. A preference patch made while a favorite command is in flight survives.
5. The existing Favorites, Recent and tab-restore layers stay green.

## Result

Implemented. The restart layer ended at **30 checks**, not the estimated ~20:
it also schedules a whole-settings save during the second add and proves that
save keeps the favorite, which is the race this plan closes.

The full suite then exposed a separate, pre-existing test problem: the physics
right-click measured the line in one CDP call and dispatched `contextmenu` in
another, so a preview-driven scroll under full-suite load moved the pane between
them and no menu opened. It reproduced in three consecutive full runs and never
in five isolated ones. `rightClickLine` now measures and dispatches in the same
task, with one retry; `format-document` moved from 138 to **139 checks**.

Final full run: **30/30 layers**, including Rust 97 passed + 2 ignored,
Favorites 56/56, Favorites restore 30/30, Format 139/139, Tab restore 25/25.

## Status

`done` — the owner asked for both changes directly.
