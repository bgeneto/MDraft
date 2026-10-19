# Remembered tabs live in `settings.json` as two path-only fields

**Status:** accepted
**Date:** 2026-10-19

## Context

The open tab list lived only in memory. Closing the window kept at most one
document for the next launch — Preferences › Files › On Launch offered the
welcome document, a new file, or the most recent file — so a reader working on
several documents reopened each one by hand. A crash, an update or a reload lost
the rest. F5/Ctrl+R were already swallowed in 0.3.1, which removed the accidental
reload but did not make a normal exit keep the set.

The feature needs a persisted list of up to twenty paths and one active path,
read before the editor exists, written whenever the set changes, and correct for
the portable build (whose settings directory follows the executable). The
existing stores were the candidates: `settings.json` (loaded by Rust before the
frontend starts, written atomically, covered by `appDirectoriesOverride`, already
home to the recent list), `localStorage` (in the WebView2 profile under
`%LOCALAPPDATA%`, shared by the portable build and wiped when the profile is
deleted), or a separate `last-tabs.json` file behind new commands.

## Decision

Store the remembered set in `settings.json` as two additive fields,
`lastTabs: string[]` and `lastActiveTab: string | null` (Rust `last_tabs`,
`last_active_tab`, both serde-defaulted, so an older file keeps loading). The
frontend owns the list: it re-reads the open sessions on a 1.5 s interval,
compares a JSON signature of the saved paths plus the active path, and calls
`save_settings` only when the signature changed. The close handler flushes the
same signature once, bounded by 750 ms, after any dirty-buffer prompts.

At boot, `onLaunch === "tabs"` filters the stored paths through `path_exists`,
deduplicates under the session store's `pathKey` rule (case-folding on Windows),
skips missing files and reports them in one toast, opens the survivors in order —
the first fills the window's blank session — and activates the remembered tab,
falling back to the first. Restoring passes `rememberRecent: false`, so ten
restored tabs do not push the reader's actual history off the Recents list. The
cap is 20, enforced by the writer and by `truncate` in both `parse_settings` and
`AppState::save`; only saved documents are ever stored.

## Consequences

- Unsaved content, caret, scroll, undo history and per-tab preview scroll do not
  survive a restart. The close guard still prompts for dirty buffers; a crash
  still loses edits. A recovery UI would be a separate feature with its own
  format.
- The settings schema grew by two fields. They are inert for a reader who does
  not choose `"tabs"`, but the list is still written when tabs change, so the
  option works immediately if it is chosen later.
- The list is written from the frontend, so a second instance racing the first
  can overwrite it; every other preference already has that exposure, and a
  single-instance guard stays out of scope.
- Anything that opens several documents before the first paint must clear
  `installingStartup` before the second one, or every `openPath` would replace
  the same blank session (see the trap in AGENTS.md).
- `pathKey` in `src/sessions.ts` is exported: the remembered list must answer
  "is this the same file" with exactly the store's rule.
