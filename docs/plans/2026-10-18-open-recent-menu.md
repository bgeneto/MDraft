# File › Open Recent: the persisted recent-files list in the native menu

**Status:** done
**Date:** 2026-10-18
**ADR:** none

## Context and goal

The application already has an all-time recent list: `Settings.recent_files`,
persisted in `settings.json`, maintained by `add_recent` (newest first, paths
deduplicated with `same_path`) and cleared by `clear_recent`. It is currently
capped at 20 and reachable only from the sidebar's **Recent** tab and from
Preferences › Files › **Clear Recent Files**. The File menu has no
recent-documents entry, so a reader who works from the menu bar cannot reopen
yesterday's document without going through the sidebar.

After this change, the persisted history holds up to **100** paths and the
scrollable sidebar offers all of them; **File › Open Recent** shows the newest
**20** of that same history as a submenu modelled on the supplied Typora
screenshot — one full path per row, a separator, and **Clear Items** at the
bottom. Opening an entry goes through the same `openPath` path as every other
route, so an already-open file focuses its tab instead of opening twice. The
submenu is refreshed whenever the list changes, from the menu, the sidebar or
Preferences. With no entries it shows a single disabled **No Recent Files** row
rather than an empty popup.

"All-time" here means the existing persisted store: the list survives restarts
and is independent of which tabs happen to be open. It is deliberately the same
store the Recent tab reads. The menu is a newest-20 window onto that list rather
than a second history, so adding a file to one view adds it to both.

## Scope and non-scope

**In scope**

- A pure `record_recent(&mut Settings, path)` helper so the insert/dedupe/cap
  rules can be unit-tested; `add_recent` keeps its current frontend contract and
  return type but gains an `AppHandle` so it can refresh the menu.
- Two limits: `MAX_RECENT = 100` in the store, rendered in full by the
  scrollable sidebar, and a separate `RECENT_MENU_LIMIT = 20` in `menu.rs`.
- `menu.rs`: an `Open Recent` submenu with a stable id (`file.openRecent`),
  built from the settings list and capped at the menu limit; item ids carry the
  path (`recent.file:<path>`) so a click cannot open the wrong entry after a
  list reorder; `recent.clear` for **Clear Items**; a disabled `recent.empty`
  row for the empty state.
- Menu refresh after `add_recent`, `clear_recent`, and any `save_settings` that
  changes the list, using one `menu::rebuild(app, &settings)` helper shared with
  the existing export-format rebuild.
- Frontend dispatch for the recent ids, and one `clearRecentFiles()` used by
  the menu, the sidebar footer and Preferences so all three routes update the
  list and the UI together.
- A test-only `recent_menu` command that walks the actual native submenu and
  returns its rows, in the same spirit as `menu_state`.
- A new CDP suite, `scripts/recent-menu-test.mjs`, plus Rust unit tests.
- Documentation: `docs/guide.md`, the README feature list, and AGENTS (new
  suite row, test count, code map if needed).

**Non-scope**

- **Reopen Closed File** (the first row in the screenshot). The application has
  no closed-tab history to reopen; adding the row without that history would be
  exactly the dead UI the project forbids. It is a separate feature with its own
  state and shortcut.
- Numbered entries or `Ctrl+1`… accelerators for recents. The screenshot has
  none, and the menu already uses those keys for headings.
- Removing a disappeared file from the list when it is clicked. The existing
  "Could not open file" dialog remains; pruning is a separate decision.
- Windows Jump Lists, macOS Recents, or any OS-level recent-documents
  integration.
- Changing `recordRecent` semantics. It still controls whether new opens are
  recorded; it does not hide or clear entries already recorded.
- A second "all-time" store. The menu and the Recent tab must stay two views of
  `settings.recent_files`.
- A version bump; the release step owns that.

## Approach and rejected alternatives

One persisted list stays the source of truth. `record_recent` moves the path to
the front, removes the same path under the platform's path identity, truncates
the stored history to 100, and updates `last_directory`. The Rust menu builder
reads that list at build time, takes its newest 20 rows, and lays out the
submenu; the frontend only receives the clicked id,
strips `recent.file:`, and calls `openPath`. Because the id contains the path
rather than an index, a menu built a moment before a list change still opens
the file the reader saw.

A native menu cannot be edited by the frontend, and Tauri menus cannot be
mutated item-by-item safely without managing separators and disabled states by
hand. The existing Export submenu already uses the full-rebuild route when the
format list changes; recents reuse `menu::rebuild` for the same reason. The
rebuild is cheap relative to opening a file and happens only when the list
actually changes.

Labels show the full path, middle-ellipsized at about 88 characters with the
file name preserved, matching the screenshot's `C:\Users\…\file.md` shape.
`plain_label` still escapes `&`, which would otherwise become a Windows
mnemonic. If the list is empty there is no separator and no Clear Items row:
there is nothing to clear.

Rejected alternatives:

- **A separate all-time file or command pair.** It would duplicate a list that
  is already persisted, atomic, covered by the portable-build directory
  override, and capped correctly; the two copies would drift.
- **Index-based ids (`recent.0`).** They are shorter, but a menu built before a
  list mutation would then open whatever file now occupies that index. The path
  in the id makes the menu snapshot self-contained.
- **Building the submenu in the frontend.** The menu is native; the DOM cannot
  render or click it. Rust owns the menu structure, as it does for Export.
- **Removing and appending items in place.** Fewer rebuilds, but separators,
  the empty-state row and Clear Items would each have to be removed and
  re-created in the right order on every change; a stale separator is a visible
  defect. The full rebuild is already proven by the Export path.
- **Adding Reopen Closed File now.** It needs a closed-tab stack, a shortcut and
  its own tests; it is not the list the request describes. Default: leave it
  out and plan it separately if wanted.

## Steps

- [x] `src-tauri/src/settings.rs`: make `MAX_RECENT` `pub(crate)`; extract
  `record_recent(settings, path)`; add `AppHandle<R>` to `add_recent` and
  `clear_recent`; call `menu::rebuild` only when the list changed; include
  recents in `save_settings`'s rebuild condition. Tests: newest first,
  dedupe (case-insensitive on Windows), and the 20-entry cap.
- [x] `src-tauri/src/menu.rs`: add `RECENT_PREFIX`, `RECENT_SUBMENU_ID`,
  `recent_files(app)`, a pure `recent_entries(files)` (ids, labels, enabled
  flags), the path-ellipsis and ampersand-safe label helper, the submenu built
  after `file.open`, `menu::rebuild(app, &settings)`, the `recent_menu` probe,
  and unit tests for empty/20-entry/long-path/`&` cases.
- [x] `src-tauri/src/lib.rs`: register `menu::recent_menu` in the invoke
  handler.
- [x] `src/main.ts`: add the `recent.file:` prefix constant beside
  `EXPORT_MENU_PREFIX`; dispatch it and `recent.clear` in `runMenuAction`; add
  `clearRecentFiles()` and route the sidebar footer and Preferences host
  through it.
- [x] `src/api.ts`: only documentation if a comment is useful; the settings
  schema and the `addRecent`/`clearRecent` wrappers do not change shape.
- [x] `scripts/recent-menu-test.mjs` (new): boot with `samples/feature-tour.md`,
  assert the menu row for it, open a temporary file, assert it becomes the
  first row, emit the menu event for the first file and assert the tab is
  focused without a duplicate, emit `recent.clear` and assert the empty row,
  the sidebar empty state and `settings.recentFiles` empty, then reopen a file
  and assert the row returns.
- [x] `scripts/test-all.mjs` and `package.json`: register the suite as
  `recent-menu` / `npm run recent`.
- [x] Docs: `docs/guide.md` (File › Open Recent and Clear Items), README's
  feature list, AGENTS' suite table and command list. Record any trap found
  while implementing.
- [x] Validation (see below), then set this plan's status to `done`.
  Results: `npm run build` passed; Rust `86 passed, 1 ignored`; the rebuilt
  `recent-menu` suite passed `26/26` (including the 27-row sidebar versus the
  20-row menu); `smoke 93/93`, `shortcuts 43/43` and `tabs 104/104` passed
  earlier in the same change.

## Files and modules

| File | Why |
| --- | --- |
| `src-tauri/src/settings.rs` | The list rules, the menu refresh on add/clear/save, and their tests |
| `src-tauri/src/menu.rs` | The submenu, ids, labels, rebuild helper, probe command, tests |
| `src-tauri/src/lib.rs` | Registers the probe command |
| `src/main.ts` | Routes recent ids to `openPath`; one shared clear action |
| `src/api.ts` | Only comments/typing if needed; no schema or wrapper change |
| `scripts/recent-menu-test.mjs` | Proves the menu mirrors the newest 20 rows and clears the same history |
| `scripts/test-all.mjs` | Registers the new suite |
| `package.json` | The manual `npm run recent` entry point |
| `docs/guide.md`, `README.md`, `AGENTS.md` | The user-facing and maintainer record |

## Risks and rollback

- **Menu rebuild churn.** Every newly recorded file rebuilds the whole native
  menu. Opening a file already does IO and a preview render; this is one more
  native call, and it happens only when the list changed. If a platform shows a
  visible flicker, the fallback is an in-place submenu update, not a second
  list.
- **A failed rebuild leaves the previous menu.** `add_recent` still saves the
  list and returns success; the stderr diagnostic names the failure, and the
  next open or clear rebuilds again. The sidebar remains correct.
- **Rebuild uses the saved settings.** Check marks are rebuilt from what Rust
  just saved; the frontend remains the source of truth for layout state and
  already calls `syncMenuState` after layout changes. The recents list is the
  only data this change adds to the rebuild.
- **Path-in-id length and characters.** `muda::MenuId` is an arbitrary string
  and the path is carried as the event payload; the id is not parsed by the
  platform. The label is escaped separately, so `&` in a folder name cannot
  become a mnemonic.
- **Twenty entries may overflow a short screen.** The menu stays at 20; the
  sidebar holds up to 100 and scrolls, so a long history costs one file read and
  a taller scroll range rather than an unusable popup. The settings file grows by
  roughly a path per open, capped at 100.
- Rollback: revert the commit. `settings.json` is unchanged, so an older build
  opens the same file and ignores the new menu ids. No migration is needed.

## Tests and validation

- `npm run build` — typecheck.
- `npm test -- --no-build --only rust` — new menu/settings tests plus the
  existing Rust suite. The harness gives cargo a writable temp directory; a bare
  `cargo test` fails unrelated file-IO tests on this host (recorded in AGENTS).
- `npm run recent` against a launched instance — the new CDP suite.
- `npm run tabs` — the Recent panel and `openPath` paths it already covers.
- `npm run shortcuts` — a menu rebuild must not disturb the accelerator
  registry or its DOM bindings.
- `npm run smoke` — the menu state and layout probes.
- Full `npm test` before a release.

Actual results: typecheck passed; Rust 86 passed + 1 ignored; `recent-menu`
26/26 (a 27-path history, all sidebar rows, menu 20 + Clear Items); `smoke`
93/93, `shortcuts` 43/43 and `tabs` 104/104 passed before the final cap split,
whose only UI effect is the sidebar row count already covered by the new suite.

The unit measurement for the split: `recent_entries` over 100 paths must return
20 file rows plus Clear Items, while `record_recent` keeps the first 100 paths.

The end-to-end measurement: with the app open on `feature-tour.md`, open a second
file and read `recent_menu` — the second path must be the first row with id
`recent.file:<that path>`; emitting that id must activate its tab; emitting
`recent.clear` must leave exactly one disabled `No Recent Files` row
and an empty Recent sidebar.

## Acceptance criteria

- **File › Open Recent** exists directly under **File › Open…** and lists the
  newest 20 paths, newest first, as full paths.
- The sidebar's Recent tab renders the full stored history (up to 100) and
  scrolls; the menu's shorter window never removes a path from that history.
- Choosing an entry opens it through the normal document path; an already-open
  file focuses its existing tab and does not duplicate it.
- A file opened from anywhere appears at the top of the submenu without a
  restart.
- **Clear Items** empties the submenu, the Recent sidebar and
  `settings.recentFiles`; the same clear from the sidebar or Preferences also
  leaves the submenu showing **No Recent Files**.
- With no entries the submenu contains only the disabled **No Recent Files**
  row, and no Clear Items row.
- A path containing `&` displays as `&`, not as a mnemonic or a doubled
  ampersand, and a long path keeps its file name visible with an ellipsis in
  the middle.
- An existing `settings.json` without the menu still loads; the settings schema
  is unchanged.
- The menu and the Recent tab never disagree about the list order or contents.

## Open questions

- **Label:** decided at approval: **Open Recent**, as in the supplied image.
- **Reopen Closed File:** decided at approval: do not implement it. The row is
  excluded above because there is no closed-tab history; it would be a separate
  feature.
- **Ellipsis budget:** about 88 characters, file name preserved. Default: 88.
- **Clear row label:** "Clear Items" (screenshot) rather than "Clear Recent
  Files". Default: "Clear Items".
- **Sidebar/store cap:** changed at the user's request from 20 to 100, while the
  menu keeps 20. Default: 100; the constant is `settings::MAX_RECENT`.
