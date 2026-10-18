# Restore the tabs that were open at the last launch

**Status:** draft
**Date:** 2026-10-18
**ADR:** `../adr/2026-10-18-remembered-tabs.md` (written with the change)

## Context and goal

Preferences › Files › On Launch offers three choices: show the welcome
document, open a new file, or reopen the **most recent** file. There is no way to
reopen the **set of tabs** that was open, and the tab list lives only in memory.
Closing the window keeps at most one document for the next run; a crash, an
update, or a new launch loses the rest. F5/Ctrl+R are now swallowed (v0.3.1),
which removes the accidental reload, but it does not make tabs survive a normal
exit — the user still has to reopen every file by hand.

After this change, choosing **Reopen the last tabs** restores every saved
document that was open, in the same order, with the same tab active. Nothing is
promised about unsaved content: only paths and order are remembered.

## Scope and non-scope

**In scope**

- Two additive settings fields: `lastTabs: string[]` and
  `lastActiveTab: string | null` (Rust `last_tabs`, `last_active_tab`, both with
  `serde(default)` so an existing `settings.json` keeps loading).
- A fourth On Launch choice, `"tabs"` → **Reopen the last tabs**.
- Remembering the tab list as tabs are opened, closed, reordered, activated or
  saved under a new path; capped at 40 saved documents; duplicates removed with
  the same path identity the session store already uses.
- Restoring at boot: order preserved, the remembered tab re-activated, missing
  files skipped and counted in a toast, and a fallback to the welcome document
  when nothing can be restored.
- A flush before the window closes, so a tab opened a second before quitting is
  remembered too.
- Tests: Rust settings round-trip, pure restore-plan unit checks, a new
  two-launch CDP suite, and the existing tabs/close layers.

**Non-scope**

- Unsaved (untitled or dirty) buffers. Their content is not persisted; the close
  guard still prompts, and a crash still loses edits. Restoring them would need
  buffer snapshots and a recovery UI, a separate feature.
- Per-tab caret, scroll, undo history or preview scroll across launches. The
  session store keeps those in memory only; persisting `EditorState` JSON is
  large and versioned.
- Reopening a second window, or merging tabs when the app is launched with an
  explicit file path: the argv file still replaces the session, as today.
- A separate session file. The list is small and belongs with the other launch
  state in `settings.json`.

## Approach and rejected alternatives

The tab list is stored in `settings.json`, in two additive fields, and kept in
sync by the frontend. A 1.5 s signature check (`JSON.stringify` of the saved
paths plus the active path) writes only when the set actually changed, and the
close handler flushes once. At boot the list is filtered through
`pathExists`, deduplicated, opened in order — the first one fills the initial
blank session, the rest become tabs — and the remembered path is activated.

Why settings: it is already loaded before the editor exists, written atomically
by Rust, covered by the portable-build override, and needs no new command,
permission or second file. The fields are a list of strings, so the schema cost
is one `serde(default)` each.

Rejected alternatives:

- **A separate `last-tabs.json` with `load_tabs`/`save_tabs` commands.** Cleaner
  separation, but adds a public contract, a second write path and its own error
  handling for a list of strings. The ADR records the choice.
- **`localStorage`.** Survives a restart with no Rust change, but it lives in the
  WebView2 profile under `%LOCALAPPDATA%`, which the portable build shares and
  which deleting `EBWebView` wipes. `settings.json` follows the document
  directory override and is the store the rest of the launch state uses.
- **Persisting the full `EditorState` per tab.** Restores caret and undo, at the
  cost of serialising up to a megabyte per tab, a format that changes with
  CodeMirror, and a migration story. It answers a different question than "which
  documents were open".
- **Remembering only on a menu command.** Hidden, and the user asked for a launch
  preference, not a manual restore.

## Steps

- [ ] `src-tauri/src/settings.rs`: add `last_tabs: Vec<String>` and
  `last_active_tab: Option<String>` with `#[serde(default)]`; defaults empty;
  extend the `on_launch` doc comment with `"tabs"`. Tests: defaults, parsing an
  old file without the fields, round-trip with them.
- [ ] `src/api.ts`: add the two fields to `Settings`; add `"tabs"` to
  `OnLaunch`.
- [ ] `src/tab-restore.ts` (new): pure helpers
  `rememberTabs(list, active)` → `{ tabs, active }` (saved paths only, capped,
  deduplicated with the store's path identity) and
  `planRestore(saved, active, exists)` → `{ tabs, active, missing }` (order
  preserved, duplicates and missing files dropped). Export the path
  normalisation from `sessions.ts` instead of writing a second one.
- [ ] `src/main.ts`:
  - seed the remembered signature from the loaded settings, then a 1.5 s
    interval that calls `rememberTabs` and `persist()` only on a change;
  - `installCloseGuard`: always `preventDefault()` once, run the existing dirty
    prompts, then flush the tab list (bounded by a short timeout so a full disk
    cannot block the close), `allowClose = true`, `win.close()`;
  - boot: after the explicit `startupFile` branch, an `onLaunch === "tabs"`
    branch — `planRestore` with `api.pathExists`, open the first with
    `installingStartup` true and the rest as tabs, activate `lastActiveTab`,
    toast when files disappeared, otherwise fall back to the welcome document;
  - `openPath` gains a `rememberRecent` option so restoring ten tabs does not
    flood Recents.
- [ ] `src/preferences.ts`: add `["tabs", "Reopen the last tabs"]` to On Launch,
  with help text saying only saved documents are reopened.
- [ ] `scripts/tabs-restore-unit.mjs` (new): unit checks of `rememberTabs` and
  `planRestore` — order, duplicates under Windows case rules, missing files,
  cap, untitled exclusion, empty list. Register in `test-all.mjs`.
- [ ] `scripts/tabs-restore-test.mjs` (new) and a `restart` suite kind in
  `scripts/test-all.mjs`: phase 1 opens three documents, reorders, picks the
  active one and sets the preference through the Preferences UI; the harness
  closes and relaunches the app with the same settings; phase 2 asserts the tab
  names, their order, the active tab and the preference value. The close path
  uses WM_CLOSE so the flush runs.
- [ ] Docs: README/`docs/guide.md` (the new launch option), AGENTS (suite row,
  counts, a trap for the async close flush). ADR as above.
- [ ] Version: propose 0.4.0 for the feature at release time; the implementation
  commit itself does not bump.

## Files and modules

| File | Why |
| --- | --- |
| `src-tauri/src/settings.rs` | New persisted fields and their tests; `on_launch` doc |
| `src/api.ts` | Mirrors the settings schema; `OnLaunch` gains `"tabs"` |
| `src/tab-restore.ts` | Pure, testable remembering and restore planning |
| `src/sessions.ts` | Exports the path identity the restore plan must reuse |
| `src/main.ts` | Signature interval, safe-close flush, boot restore, `openPath` option |
| `src/preferences.ts` | The fourth On Launch choice |
| `scripts/tabs-restore-unit.mjs` | No-app checks of the two helpers |
| `scripts/tabs-restore-test.mjs` | The real two-launch check |
| `scripts/test-all.mjs` | Registers the unit layer and the `restart` suite kind |
| `docs/plans/` + `docs/adr/` + README/guide/AGENTS | The record and the docs |

## Risks and rollback

- **Settings write churn.** Every tab change could rewrite a file with the whole
  settings object. The signature check makes a write happen only when the set
  changes, and a tab click is not a hot loop. If it still shows up in profiles,
  the interval can be raised; the fields are inert when the preference is not
  `"tabs"`.
- **Close hangs on the flush.** The handler awaits the settings write; a disk
  error or a wedged IPC could keep the window open. Bound the wait (about
  750 ms) and close regardless — the 1.5 s interval has already written the
  common case. `scripts/test-close.ps1` (12 s budget) catches a regression.
- **Boot delay.** Restoring 40 documents reads 40 files before the first paint.
  The cap and sequential open make the common case (a handful) a few
  milliseconds; if a real set is slow, open the first, paint, then the rest.
  Measure with the tab suite and a 10-file folder.
- **A tab that no longer exists.** Skipped, counted, and reported; no placeholder
  tab is created.
- **Two instances.** The second instance writes the same `settings.json` last;
  the app already has this exposure for every preference, and a single-instance
  guard is out of scope.
- Rollback: revert the commit. Old settings files ignore the fields (serde
  default); the preference value `"tabs"` falls back to the welcome branch
  because no other code knows it.

## Tests and validation

- `npm run build` — typecheck.
- `npm run test:rust` — the new settings tests and the existing 79.
- `node scripts/tabs-restore-unit.mjs` — the two helpers, no application.
- `npm run tabs` — 104 existing tab checks must stay green (the interval and the
  close handler touch their paths).
- `.\scripts\test-close.ps1` — the window still exits and writes its state.
- `npm run test:tabs-restore` — the two-launch suite: phase 2 sees three
  `.doc-tab` elements in the same order with the same active tab.
- Full `npm test` before the release.

The one measurement that proves it: open three documents, reorder them, close
the window, relaunch, and read the tab names and the active tab from the DOM —
they must match, and `settings.json` must contain the same three paths under
`lastTabs`.

## Acceptance criteria

- Preferences › Files › On Launch lists **Reopen the last tabs**; choosing it
  and restarting restores every saved document that was open, in order, with the
  same tab active.
- A file deleted between runs is skipped, and a toast says how many were not
  reopened; if none can be opened, the welcome document appears.
- An untitled tab is not restored, and a document opened from the command line
  still wins over the remembered set.
- Closing the window writes the list before the process exits, including a tab
  opened immediately before closing.
- An existing `settings.json` without the new fields loads unchanged.
- The close test still passes inside its 12 s budget.

## Open questions

- **Version:** 0.4.0 (minor, new feature) rather than 0.3.2. Default: 0.4.0.
- **Dirty saved tabs:** restore them from disk (edits since the last save are
  lost) or skip them? Default: restore from disk — the close guard already
  prompts on a clean exit, and skipping would hide a document the reader had
  open.
- **Recents during restore:** do not write Recents for restored tabs. Default: no.
- **Cap:** 40 documents. Default: 40.
