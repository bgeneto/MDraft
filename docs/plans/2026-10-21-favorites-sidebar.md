# Replace the Files sidebar panel with Favorites

**Status:** done
**Date:** 2026-10-21
**ADR:** none

## Context and goal

The sidebar offers three panels: **Outline**, **Files** and **Recent**. The Files
panel is a directory browser, not a short list: it lists the current document's
folder, navigates into subfolders, filters by extension and honours a
"Show hidden folders and files" preference. The reporter does not use it and
wants the pill to become **Favorites** instead.

Favorites are deliberately not a second Recent list. Recent is ordered by the
last time a path was opened and can be cleared in one action. Favorites are
ordered by when they were favorited, never reorder when a file is opened, and can
only be removed one at a time. They are the files a reader returns to regardless
of how long ago they were last opened.

After this change:

- the pills read **Outline | Favorites | Recent**;
- **Add to Favorites** / **Remove from Favorites** is in the editor's right-click
  menu and in every tab's right-click menu;
- the Favorites panel lists saved paths in the order they were added, opens them
  on click and removes exactly one with its own `×` or row menu;
- the Files folder browser, its Show Hidden preference and its backend listing
  command are gone.

## Scope and non-scope

**In scope**

- A persisted `favorites` list in `settings.json`, with add/remove commands.
- A Favorites sidebar panel replacing Files, including its empty state, row
  layout, per-row `×`, row context menu and keyboard access.
- The **Add to Favorites** / **Remove from Favorites** item in the editor context
  menu and the tab context menu, including disabled state for untitled tabs.
- The native View menu entry, its check state and the existing `Ctrl+Shift+2`
  accelerator, renamed from File List to Favorites.
- Migration of an existing `"sidebarTab": "files"` value to `"favorites"`.
- Removal of the Files panel, `showHiddenFiles`, and the `list_directory` command
  plus its API wrapper.
- Tests, documentation and the test harness registration.

**Non-scope**

- No native **File › Add to Favorites** item and no new keyboard shortcut. The
  user chose the two right-click menus only.
- No drag reordering, multi-select, Clear All, rename or folder grouping.
- No automatic removal or dimming of missing favorites. A missing file is kept
  and explained when the reader clicks it.
- No tracking of a file that is renamed or moved outside the application. The
  stored path is what is opened.
- No changes to Open Recent, `recentFiles` or the Recent panel.
- No icon or visual redesign beyond what the new row needs.

## Approach and rejected alternatives

Store the list in `Settings` as `favorites: Vec<String>` and expose two commands,
`add_favorite` and `remove_favorite`, both returning the whole saved `Settings`
exactly as `add_recent` does. The list is append-only on add, deduplicated with
the same `same_path` rule Recent uses, and never reordered by opening. The
frontend renders it from `settings.favorites` and updates `settings` from each
command's return value, so the panel and the menu labels never disagree.

The editor and tab menus already have a callback shape for Format Document;
favorites extend it with `favoriteBlocked`, `isFavorite` and `favorite`, so the
menus stay presentation while the shell owns paths and persistence. The menu
label is computed when the menu opens, which makes it a toggle without a second
menu item.

The Favorites row cannot be a single `<button>` like a Recent row because it also
needs an `×`. It becomes a `div.favorite-item` containing a full-width open
button (name over directory) and a separate remove button, so both are keyboard
reachable and neither is a button nested inside another button. Right-clicking
the row opens a small menu with **Open** and **Remove from Favorites**; that menu
is the only place a pointer needs a context menu.

Rejected alternatives:

- **A pinned flag on `recentFiles`.** Recents reorder on every open and are
  cleared as a group; both rules contradict Favorites. A second list is smaller
  than a mode flag threaded through every recent operation.
- **A separate `favorites.json`.** `settings.json` already provides atomic writes,
  load-time caps and the migration path, and the existing commands return
  `Settings`. A second store would need its own save/load/backup discipline for
  no benefit.
- **Keep the Files folder browser behind another menu item.** The user chose a
  full replacement. A hidden second home for it would be dead UI by another
  name.
- **Newest favorite first.** That is still a recency ordering, just of favoriting
  rather than opening. The agreed model is insertion order: first favorite at the
  top, new ones appended.
- **Alphabetical or manual order.** Not chosen; insertion order is stable and
  needs no drag machinery.
- **Silently evict the oldest favorite at the cap.** Favorites are deliberate
  choices, so dropping one to make room is the wrong failure. At the cap the add
  command refuses with a message naming the limit.
- **A modal error when a favorite is missing.** A sidebar click should not open a
  native dialog, and a dialog is impossible to dismiss from a CDP suite. Favorites
  open through `openPath(path, { silent: true })`, so a failure is the usual
  toast and the row stays.
- **Auto-remove or dim missing favorites.** A network drive that is temporarily
  absent must not delete a reader's list.

## Steps

- [x] **Settings and commands.** Add `favorites: Vec<String>` and
      `MAX_FAVORITES` (50) to `settings.rs`; add to `Default`; cap on load and
      save; deduplicate on load using `same_path`. Add pure helpers
      `add_favorite_path` / `remove_favorite_path` and the commands
      `add_favorite` / `remove_favorite`. Adding an existing path is a no-op;
      adding at the cap returns an error; removing an absent path is a no-op.
- [x] **Settings migration.** In `parse_settings`, map an existing
      `sidebarTab: "files"` to `"favorites"`. Remove the `show_hidden_files`
      field from `Settings`; an old file that still contains `showHiddenFiles`
      keeps loading because unknown keys are ignored.
- [x] **Remove the folder browser's backend.** Delete `DirEntry`,
      `list_directory` and its tests from `documents.rs`; remove the command from
      the `lib.rs` handler table. Keep `path_exists` for images.
- [x] **Frontend API.** Change `SidebarTab` to
      `"outline" | "favorites" | "recent"`; add `favorites: string[]`; remove
      `showHiddenFiles`, `DirEntry` and `listDirectory`; add `addFavorite` and
      `removeFavorite` wrappers.
- [x] **Sidebar renderer.** Delete `DIRECTORY_STACK`, `currentDirectory`,
      `showDirectory`, `paintDirectory` and `resetDirectory`. Add
      `renderFavorites(container, files, handlers)` with the empty-state copy, a
      row per path (star, name, directory, `×`) and a small row menu with **Open**
      and **Remove from Favorites**. Dismiss the menu on outside pointerdown,
      Escape, scroll, resize and window blur; support Arrow keys, Home, End,
      Enter, Space and `Shift+F10`/Menu key.
- [x] **Shell wiring.** In `main.ts`, replace the Files branch in `renderSidebar`
      with the Favorites branch; remove the `resetDirectory` calls in
      `showInEditor` and `displayDoc`; remove the `showHiddenFiles` patch branch
      and the directory imports. Add `isFavoritePath` (using `pathKey` from
      `sessions.ts`), `toggleFavorite(path)` and `removeFavoritePath(path)`, each
      updating `settings` from the command result and re-rendering only when the
      Favorites panel is visible. Open favorites with `silent: true`.
- [x] **Editor context menu.** Extend `EditorMenuOptions` with
      `favoriteBlocked`, `isFavorite` and `favorite`. Add one item after Format
      Document: **Add to Favorites** or **Remove from Favorites**; disabled with
      `Save the document first.` when the document has no path.
- [x] **Tab context menu.** Extend `TabsCallbacks` with `favoriteBlocked`,
      `isFavorite` and `favorite`. Add the same item after Format Document and
      before Reveal in File Manager. It acts on the clicked tab's path, including
      an inactive tab.
- [x] **Native menu.** Rename `view.files` to `view.favorites` in `CHECK_IDS`,
      `is_checked`, the View submenu label, the focus-mode disable list and the
      Rust tests. The label becomes `Favorites`; `Ctrl+Shift+2` stays.
- [x] **Preferences.** Replace the Files option in **Default Sidebar Panel** with
      Favorites. Remove the File Tree / Library heading and the Show Hidden row;
      add a Favorites heading with a `note` row explaining the two context menus
      and the one-at-a-time `×` (a note, not a dead control).
- [x] **HTML and CSS.** Replace `#tab-files` with `#tab-favorites` in
      `index.html`. Add `.favorite-item`, `.favorite-open`, `.favorite-remove` and
      the row-menu styles; keep the row visually consistent with Recent.
- [x] **Existing suites.** Update `dom-smoke` (menu group and preference search
      probe), `asciidoc-test` (remove the Files-panel section),
      `document-tabs-test` (seed two favorites through the command, open the
      `.typ` row, keep the later tab checks), `format-document-test` (the exact
      editor label list), and `shortcut-test` (Ctrl+Shift+2 selects Favorites).
- [x] **New suite.** Add `scripts/favorites-test.mjs` (about 30 checks) and
      register it in `scripts/test-all.mjs` and `package.json`. Cover the empty
      state, both menu routes, the toggle label, insertion order across opens,
      inactive-tab favoriting, duplicate adds, per-row `×`, row context menu,
      missing-file toast, untitled disabled state, no Clear All, and the
      absence of the Files tab and `showHiddenFiles`.
- [x] **Documentation.** Update `README.md`, `docs/guide.md`, `src/content.ts`
      (the shortcut table), `AGENTS.md` (script tables, code map, counts and the
      asciidoc description) and this plan's status and deviations.
- [x] **Validation.** Run `cargo check`, `cargo test`, `npm run build`,
      `npm run lint`, `npm run knip`, then the affected suites through
      `npm test -- --only …` followed by a full `npm test`.

## Files and modules

| File | Why it changes |
| --- | --- |
| `src-tauri/src/settings.rs` | The persisted list, its cap and identity rule, the two commands, the `showHiddenFiles` removal and the sidebar migration |
| `src-tauri/src/lib.rs` | Register the two commands and remove `list_directory` |
| `src-tauri/src/documents.rs` | Remove the now-unused directory listing and `DirEntry` |
| `src-tauri/src/menu.rs` | Rename the native View item and check id, update its tests |
| `src/api.ts` | Types and command wrappers |
| `src/sidebar.ts` | Replace the directory browser with the Favorites renderer and row menu |
| `src/main.ts` | Shell wiring, toggles, open/remove handlers, Files removal |
| `src/context-menu.ts` | The editor's favorite item and callbacks |
| `src/tabs.ts` | The tab menu's favorite item and callbacks |
| `src/preferences.ts` | Default panel option, remove dead File Tree row, add the Favorites note |
| `src/styles.css` | Favorites rows and row menu |
| `index.html` | The pill's id and label |
| `src/content.ts` | Shortcut reference |
| `README.md`, `docs/guide.md` | User-facing description of the replacement |
| `AGENTS.md` | Script registration, code map and check counts |
| `scripts/favorites-test.mjs` | New CDP suite |
| `scripts/test-all.mjs`, `package.json` | Register and expose the suite |
| `scripts/dom-smoke.mjs`, `scripts/asciidoc-test.mjs`, `scripts/document-tabs-test.mjs`, `scripts/format-document-test.mjs`, `scripts/shortcut-test.mjs` | Existing expectations that the rename or the removed panel would break |

## Risks and rollback

- **Removing folder browsing is user-visible.** The only route to it today is
  the pill being replaced, and the user accepted that trade-off. The guide says
  so explicitly rather than leaving the loss implicit.
- **The editor menu's exact label list is asserted by the format suite.** Adding
  one item breaks it until the expected list is updated; that suite must run
  before the change is considered complete.
- **An in-flight `persist()` could race a favorite command.** Both write the
  whole settings object. The favorite command returns and installs the saved
  settings immediately, and every later save therefore carries the list. The
  window is the same one Recent already has and is not new machinery.
- **A hand-edited settings file could contain duplicates or an overlong list.**
  Load deduplicates with `same_path` and truncates to `MAX_FAVORITES`; save does
  the same.
- **Removing `list_directory` could break an overlooked caller.** A repository
  search finds only the Files panel and its Rust tests; the command table, API
  wrapper and tests are removed together, and `cargo check` proves the result.
- **Downgrading.** An older build ignores `favorites`, fills the removed
  `showHiddenFiles` with its default, and treats `sidebarTab: "favorites"` as
  Recent (its `else` branch). Nothing crashes, but the panel choice is not
  preserved. Rollback is the branch plus the previous settings file.
- **The cap refuses rather than evicts.** A reader at 50 favorites gets a toast
  naming the limit; no entry disappears silently.

## Tests and validation

**Rust unit tests** (`src-tauri/src/settings.rs`):

- favorites start empty and survive serialize/deserialize;
- insertion order is preserved and opening never touches it;
- adding the same path twice (including Windows case and separator differences)
  is a no-op;
- removing one leaves every other entry;
- the cap refuses an add at `MAX_FAVORITES`;
- load deduplicates and truncates an overlong list;
- an old settings file without `favorites` loads; `sidebarTab: "files"` becomes
  `"favorites"`;
- serialized settings no longer contain `showHiddenFiles`.
- the removed `list_directory` tests are deleted with the command.

**New CDP suite** (`scripts/favorites-test.mjs`), one freshly launched instance:

- the three pills are Outline, Favorites, Recent; `#tab-files` does not exist;
- the empty state explains how to add a file;
- the editor menu offers **Add to Favorites** for a saved document, and choosing
  it shows a toast and persists the path;
- the tab menu adds the clicked **inactive** tab's path, not the active one;
- rows appear in insertion order and opening a file does not reorder them;
- the menu label switches to **Remove from Favorites** for a favorited document;
- an untitled document/tab disables the item with `Save the document first.`;
- adding the same path again does not duplicate it;
- the row `×` removes only that row; the row context menu removes only that row;
- the last removal returns the empty state; there is no Clear All control;
- a favorite pointing at a missing file stays and produces a toast when clicked;
- `get_settings()` returns the list, and `menu_state` reports `view.favorites`
  with no `view.files`;
- `Ctrl+Shift+2` selects Favorites;
- Preferences offers Favorites as a default panel and no longer offers File list
  or Show Hidden.

**Measurement that proves it works:** right-click a saved file, choose
**Add to Favorites**, open two other files, return to the panel — the row is still
present, still in its original position, and its menu now says **Remove from
Favorites**. That sequence is the feature, not a count of rows.

**Existing layers to re-run:** `npm run build`, `npm run test:rust`,
`npm run smoke`, `npm run asciidoc`, `npm run tabs`,
`npm run format:document`, `npm run shortcuts`, then the full `npm test`.
`npm run lint`, `npm run knip` and `npm run format:check` are the quality gates.

The check counts quoted in `AGENTS.md` and `README.md` must be replaced with the
numbers the runs actually print: the Rust count changes with the removed
directory tests and the new settings tests, asciidoc loses one check, and the new
suite adds its own.

## Acceptance criteria

1. The sidebar pills read **Outline | Favorites | Recent**; there is no Files
   pill, no folder path header, no parent-folder button and no directory list.
2. **View › Favorites** is checked when the panel is shown, `Ctrl+Shift+2`
   selects it, and the three sidebar items still form one exclusive group.
3. An empty Favorites panel says how to add a file, and names both routes.
4. Right-clicking a saved document's source offers **Add to Favorites**; choosing
   it writes the path to `settings.json`, shows a confirmation and adds a row.
5. Right-clicking any tab offers the same item for that tab's file; an inactive
   tab is favorited without being activated.
6. Reopening one of the files, or another file, never changes the order of the
   Favorites rows.
7. When the current document or clicked tab is already a favorite, the item reads
   **Remove from Favorites** and removes only that path.
8. Each row has a `×`; right-clicking a row offers **Open** and **Remove from
   Favorites**; there is no Clear All, no multi-select and no bulk removal.
9. An untitled document or tab shows the item disabled with
   **Save the document first.**
10. A favorite whose file is missing stays in the list; clicking it produces a
    toast naming the failure and does not remove the row.
11. A restart preserves the list, its order and its entries; an older
    `sidebarTab: "files"` opens Favorites; an older file without `favorites`
    loads with an empty list.
12. Preferences › Files no longer contains **Show Hidden Folders and Files**; its
    **Default Sidebar Panel** offers Favorites instead of File list; the Favorites
    note explains management without presenting a dead control.
13. `list_directory` is no longer registered or wrapped, and no frontend code
    references it.
14. Every existing suite that asserted the Files pill, the Files panel, the
    `view.files` menu id or the exact editor menu list passes with the updated
    expectations, and the new suite passes.

## Open questions

None. The cap is **50**; a missing favorite reports with a **toast**, not a
modal; the row keeps the small `★` as its leading icon.

## Result

Implemented as approved. The measured differences from the estimate:

- The cap is **50** (the owner's change at approval).
- `scripts/favorites-test.mjs` ended at **56 checks**, not the estimated 30: the
  suite also covers an inactive tab, a deleted file and both Preferences
  sections that changed.
- Final counts: Rust **99** (97 passed, two ignored); Favorites **56**; Document
  tabs **106** (two more, for the favorite-row route); AsciiDoc **54** (one
  fewer, the removed Files-panel check). Smoke **105**, Format **80** and
  Shortcuts **43** are unchanged.
- `npm test -- --no-build` passed all **29/29** layers. One transient `word-sync`
  failure in the first full run passed in isolation and in the full rerun; the
  suite was not modified.
- `npm run format:check`, `npm run lint` and `npm run knip` pass; `cargo
  clippy --all-targets -- -D warnings` is clean.

## Follow-up (2026-10-22)

Acceptance criterion 11 — a restart preserves the list — had no automated test:
`scripts/favorites-test.mjs` reads `get_settings` from the running instance, so it
cannot see a list that was never written or was overwritten by the close flush.
`scripts/favorites-restore-test.mjs` now runs as the `favorites-restore` restart
layer (two launches, WM_CLOSE in between) and `src/main.ts` serialises settings
writes so a stale whole-object save cannot erase an in-flight favorite. See
`docs/plans/2026-10-22-favorites-persistence.md`.
