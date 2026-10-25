# P0 data safety: recovery journal, external-change guard, Typst commands

**Status:** done — see the validation record below
**Date:** 2026-10-24
**ADR:** none

The user approved this plan in advance in the session that produced
`docs/backlog.md` and asked for implementation to proceed unattended after the
plan was written. The approval is recorded here so a later session can see that
the normal stop-and-wait step was deliberately satisfied.

## Context and goal

`docs/backlog.md` marks three items P0 — data loss or silent document
corruption:

- **GAP-001** — unsaved work has no durable copy. `Auto Save` is opt-in, runs
  every 20 s and only writes sessions with a path. Untitled buffers, and saved
  buffers edited since the last Auto Save, disappear on a crash or a forced
  kill. `Reopen the last tabs` remembers paths only.
- **GAP-002** — a dirty buffer is never compared with its file. The disk poll
  deliberately skips dirty sessions, and `Auto Save`/`Ctrl+S` then overwrite an
  external change without warning.
- **GAP-003** — the Paragraph and Format commands insert Markdown syntax into
  Typst documents (`# Title`, `1.`, `> `, pipe tables, `[TOC]`, `**…**`, …).
  Typst cannot read most of it, so an ordinary menu action can break the
  document.

The goal is one coherent data-safety layer: a journal that survives a crash, a
conflict state that prevents silent overwrites, and a language-aware command
layer that never inserts the wrong markup. The UI must explain what happened and
give the reader the choice.

## Scope and non-scope

**Scope**

- A recovery journal for dirty buffers, including untitled ones, stored under
  the application config directory beside `settings.json` and restored at boot.
- A disk-conflict state for saved buffers: detect external modification or
  deletion, show a notice bar, block the save, and offer Reload / Keep mine /
  Save a copy.
- Typst-aware Paragraph and Format commands, including valid alternatives or an
  explicit note for constructs Typst does not have.
- A reusable in-app notice bar for recovery and conflict messages.
- Unit tests for the Rust store, the frontend scheduler, disk classification and
  Typst command strings.
- Reader documentation, backlog statuses and AGENTS.md counts/traps.

**Non-scope**

- The three-way close prompt and Save All (backlog GAP-004). Recovery makes the
  current two-button prompt less dangerous, but it does not replace it.
- File encoding (GAP-021), binary open/drop (GAP-005), workspace search
  (GAP-006/007/008), autocomplete (GAP-022), and every other backlog item.
- Restoring undo history, caret or scroll position. Content, language, path,
  line ending, BOM and read-only state are enough for this pass.
- A journal of clean buffers. Clean content already exists on disk.
- A second window or single-instance handoff (GAP-017).
- Compiling Typst commands in CI when the compiler is absent. The unit suite
  checks the strings; the manual acceptance step compiles them when Typst is
  installed.

## Approach and rejected alternatives

### 1. Recovery journal

**Rust owns the files.** The frontend cannot touch the filesystem, and a
`localStorage` copy is not durable: the WebView profile can be cleared or
corrupted, and it is not the directory beside the settings the reader expects.
`src-tauri/src/recovery.rs` gets a small store:

```text
<app_config_dir>/recovery/<id>.json
```

One file per dirty buffer, written atomically through a sibling temporary file
and a rename. The filename is the entry id, restricted to ASCII letters,
digits, `-` and `_`; anything else is rejected. `updatedMs` is set by Rust when
the entry is written, so a frontend clock cannot reorder the list.

Entry schema (camelCase over IPC):

```json
{
  "id": "2b5c…",
  "path": "C:\\notes\\chapter.md",
  "name": "chapter.md",
  "language": "markdown",
  "content": "the editor buffer",
  "lineEnding": "\r\n",
  "hadBom": false,
  "lossy": false,
  "readOnly": false,
  "baseModifiedMs": 1760000000000,
  "baseSize": 8123,
  "updatedMs": 1760000001000
}
```

`baseModifiedMs`/`baseSize` are the disk revision the buffer was based on. On
restore they become the session's `modifiedMs`/`size`, so a file that changed
while MDraft was closed is detected by the same conflict guard as a live
change. They also make "Keep mine" update the journal's base, so a second crash
does not resurrect the old conflict.

Commands:

| Command | Purpose |
| --- | --- |
| `list_recovery` | Read every valid `.json`, skip corrupt files, newest first |
| `write_recovery` | Validate, set `updatedMs`, atomic write, enforce caps |
| `remove_recovery` | Remove one entry; a missing file is success |

Caps: 16 MiB of content per entry, 64 entries. A failed write returns a message;
the frontend shows it once per session and keeps editing. Corrupt files are
ignored, never deleted; a future version may quarantine them.

**Frontend owns the schedule.** `src/recovery.ts` exports
`createRecoveryScheduler`, which debounces each session independently (700 ms),
serialises writes for the same id so an older write cannot land after a newer
one, and removes the entry when the session becomes clean. A session gets a
`recoveryId` (UUID) on its first dirty write; a recovered session keeps the id
from its journal.

`Session` gains:

- `recoveryId: string | null` — journal key;
- `draft: string | null` — recovered text for a session that has never been in
  the editor view. `textOf`, `showInEditor` and `displayDoc` prefer it over
  `savedContent`; it is cleared when the state is captured.
- `conflict: "modified" | "deleted" | null` — see below.

**Restore happens after the normal startup choice.** `restoreLastTabs` (or the
welcome/recent/new document) runs first, then `restoreRecovery` reads the
journal. A recovered path that is already open overlays its draft on the clean
session instead of duplicating the tab. A missing path becomes an untitled
buffer with the stored name and language. The first recovered session is
activated, and one notice says how many documents were recovered. Entries are
removed only on Save, Save As, Discard, or when the recovered content equals
what is already on disk.

**Rejected:** one global JSON snapshot (write amplification and a large file on
every keystroke); `localStorage` (not durable); auto-saving dirty buffers to
their real files (surprising, and it defeats the unsaved state); a blocking
restore modal (startup must not depend on a click); silently dropping stale
journals (exactly the data loss this fixes).

### 2. External-change guard

`src/disk-change.ts` is a pure classifier:

```ts
classifyDiskChange(session, stat): "unchanged" | "modified" | "deleted"
```

The comparison is `modifiedMs` plus `size`; a hash is not needed for the first
pass and would cost a full read on every poll. `reloadChangedSessions` keeps the
existing silent reload for clean sessions, but a dirty session now gets
`session.conflict` and a notice instead of being skipped. A deleted file is a
conflict even when the buffer is clean, because the next save would recreate it.

`writeSession` performs the same check before writing. A mismatch marks the
conflict and returns false; `Auto Save`, `Ctrl+S`, Save All and the close guard
all inherit the guard because they already route through `writeSession`. Save As
to a new path is exempt until the new file exists.

The notice bar (below) offers:

- **Reload from disk** — replace the buffer with the file, preserving one undo
  step where the editor supports it, clear the conflict and forget the journal.
- **Keep my version** — accept the current disk revision as the base and leave
  the buffer dirty. The next save may overwrite, which is now an explicit
  choice. The journal is updated with the new base.
- **Save a copy…** — Save As to a new path; the tab then tracks the copy. The
  original conflict is resolved by the move. Cancelling the dialog keeps the
  conflict.

A background session that conflicts gets a toast; its notice appears when the
tab is activated. `reloadChangedSessions` does not repeat the toast for the same
conflict kind.

**Rejected:** a native two-button prompt on every poll (there is no Cancel and
it interrupts typing); a silent auto-reload for dirty buffers (loses work); a
modal (blocks the editor); no deletion handling (a clean deleted file silently
reappears on save).

### 3. Typst-aware commands

`src/typst-commands.ts` is pure and owns the strings/line transforms. `main.ts`
keeps the language dispatch; `editor.ts` gains two line-transform methods for
Typst headings. The supported commands:

| Command | Typst result |
| --- | --- |
| Heading 1–6 | `= Title` … `====== Title` |
| Paragraph | existing `=` markers stripped |
| Increase/decrease heading | shift `=` level |
| Bullet list | `- ` prefix |
| Ordered list | `+ ` prefix |
| Quote | `#quote(block: true)[…]` |
| Table | `#table(columns: 2, [Column], [Column], [Cell], [Cell])` |
| Horizontal rule | `#line(length: 100%)` |
| Table of contents | `#outline()` |
| Strong | `*text*` |
| Emphasis | `_text_` |
| Strikethrough | `#strike[text]` |
| Inline code | `` `text` `` |
| Link | `#link("https://")[text]` |
| Inline math | `$…$` |
| Display math | `$ … $` block |
| Code fence | triple backticks (already valid) |
| Image | `#image("…", alt: "…")` (already fixed) |

Unsupported in Typst and therefore a note, not a wrong insertion:

- task lists (no native task-list markup);
- GitHub alerts (`> [!NOTE]`);
- YAML front matter (Typst uses `#set document(...)`);
- HTML tags.

The note uses the same pattern as `htmlCommandNote` and names the Typst
equivalent where one exists. The menu item stays visible because the menu is
global; it explains itself instead of silently doing nothing.

**Rejected:** disabling the whole Format/Paragraph menu in Typst (too coarse and
it would hide the commands that do work); generating arbitrary Typst code from
user text (quoting and escaping become a parser problem); a separate Typst-only
menu (more native menu state than the feature needs).

### 4. Notice bar

A single row under the tabs, spanning all columns:

```html
<div id="notice-bar" class="notice-bar" hidden>
  <span id="notice-text"></span>
  <span id="notice-actions"></span>
  <button id="notice-close" aria-label="Dismiss">×</button>
</div>
```

`showNotice(text, tone, actions, closable)` builds real buttons, not innerHTML.
It is used for recovery (one informational notice) and conflicts (three actions,
not closable until resolved). The app grid gains one `auto` row:
`grid-template-rows: auto auto 1fr auto`, with the tabs at row 1, the notice at
row 2, sidebar/resizer/workspace at row 3 and the status bar at row 4. A hidden
notice collapses to zero height.

**Rejected:** a toast (no actions); a modal (blocks typing); a native dialog
(no Cancel); four separate banners (one component, one state).

## Steps

- [x] **1. `src-tauri/src/recovery.rs`.** Entry struct, ids, store directory,
      atomic write, list/remove, caps, corrupt-file handling, unit tests.
- [x] **2. `src-tauri/src/lib.rs`.** Register `list_recovery`, `write_recovery`,
      `remove_recovery`; add the module.
- [x] **3. `src/api.ts`.** `RecoveryEntry` interface and three wrappers.
- [x] **4. `src/sessions.ts`.** `recoveryId`, `draft`, `conflict` on `Session`
      and the blank session.
- [x] **5. `src/recovery.ts`.** Pure entry builder and the debounced,
      serialised scheduler; unit-testable dependencies.
- [x] **6. `src/main.ts` recovery.** Scheduler wiring on document change,
      format and save; forget on save/save-as/close/discard/reload; `draft` in
      `textOf`/`showInEditor`/`displayDoc`; `restoreRecovery` after the normal
      startup; recovery notice.
- [x] **7. `src/disk-change.ts`.** Pure classifier and unit tests.
- [x] **8. `src/main.ts` conflicts.** `markConflict`/`clearConflict`, poll,
      `writeSession` preflight, reload/keep/copy actions, notice rendering,
      toast deduplication.
- [x] **9. `index.html` + `src/styles.css`.** Notice bar markup, styles, grid
      rows, light/dark surfaces and keyboard focus.
- [x] **10. `src/typst-commands.ts`.** Pure heading/line/block/inline builders
      and unit tests.
- [x] **11. `src/editor.ts`.** `setTypstHeading` and `shiftTypstHeading`.
- [x] **12. `src/main.ts` Typst.** Branches for heading/paragraph/shift, quote,
      lists, table, rule, TOC, front matter, alert, task, inline commands and
      display math; unsupported notes.
- [x] **13. Tests and registration.** `scripts/p0-unit.mjs`, package script,
      `scripts/test-all.mjs`, AGENTS.md script/test tables and counts.
- [x] **14. Documentation.** `README.md` feature bullet, `docs/guide.md`
      recovery/conflict/Typst paragraphs, `docs/backlog.md` statuses and
      evidence, plan checkboxes/status.
- [x] **15. Validation.** `npm run build`, `lint`, `format:check`, `knip`,
      `test:sessions`, `test:rust`, `p0:unit`; manual recovery kill/relaunch,
      external-change, and Typst menu checks; relevant existing suites.

## Validation record (2026-10-24)

- `npm run build` — pass.
- `npm run lint` — pass.
- `npm run knip` — pass.
- `npm run p0:unit` — **52/52**.
- `npm run test:sessions` — **59/59**.
- `npm run test:rust` — **117 passed, 2 ignored** (119 total).
- `npm run smoke` against a freshly built release — **107/107**.
- A manual release-build probe, on a backed-up config and a disposable WebView
  profile: typed an untitled buffer, force-killed, relaunched, and found the text
  back in a dirty tab with "Recovered 1 unsaved document"; edited a saved file,
  rewrote it externally, saw the conflict notice, clicked **Reload from disk**
  (buffer became the external text) and **Keep my version** (the next `Ctrl+S`
  wrote the local text); deleted the file externally and **Save anyway**
  recreated it.
- Typst **0.15.1** compiled every emitted construct: heading, ordered and bullet
  lists, `#quote(block: true)`, `#table(...)`, `#line(...)`, `#outline()`,
  `#strike[...]`, `#link(...)[...]`, inline math and the empty display-math block.
- `format:check` is clean for every touched file; the repository-wide check still
  flags `scripts/typst-preview-test.mjs`, which belongs to another workstream and
  was not reformatted here.

## Files and modules

| File | Why |
| --- | --- |
| `src-tauri/src/recovery.rs` | New store, commands and tests |
| `src-tauri/src/lib.rs` | Module and command registration |
| `src/api.ts` | Typed wrappers and `RecoveryEntry` |
| `src/sessions.ts` | `recoveryId`, `draft`, `conflict` |
| `src/recovery.ts` | Entry builder and debounced scheduler |
| `src/disk-change.ts` | Pure disk-state classifier |
| `src/typst-commands.ts` | Pure Typst command strings/line transforms |
| `src/editor.ts` | Typst heading line transforms |
| `src/main.ts` | Startup restore, scheduler, conflict UI, Typst dispatch |
| `index.html` | Notice bar |
| `src/styles.css` | Notice bar and grid row |
| `scripts/p0-unit.mjs` | Unit checks for the three pure frontend modules |
| `package.json`, `scripts/test-all.mjs` | Register the unit layer |
| `AGENTS.md` | Module map, test counts, any trap learned |
| `README.md`, `docs/guide.md` | Reader-facing behaviour |
| `docs/backlog.md` | Close GAP-001/002/003 with evidence |
| `docs/plans/2026-10-24-p0-data-safety.md` | This plan and its final status |

## Risks and rollback

- **Journal write frequency.** Writing a full buffer on every keystroke would
  cost more than the editor. Debounce per session at 700 ms, serialise writes
  per id, and skip when the content has not changed. Large buffers hit the
  16 MiB cap and get one visible message, not silence.
- **Crash during a journal write.** Atomic temp + rename; a leftover `.tmp` is
  ignored and never parsed as an entry.
- **Restore duplicates.** Match by `pathKey`, not raw path. A recovered path
  already open from `lastTabs` overlays the draft; it never adds a second tab.
- **Conflict false positives.** `mtime` plus size can differ for a metadata-only
  touch; Reload is harmless and Keep mine is explicit. A network share with
  coarse timestamps gets the same benign prompt. A content hash is deliberately
  deferred.
- **Save race.** The preflight stat and the write are not atomic; another
  process can write between them. This pass narrows the window and gives the
  reader control; a file lock/compare-and-swap is out of scope.
- **CSS grid shift.** Moving sidebar/resizer/workspace/status bar from rows
  2/3 to 3/4 can break layout tests. The notice row is `auto` and hidden by
  default; run `npm run smoke` and inspect both themes.
- **Typst syntax drift.** The strings target the installed Typst version. The
  Reference document and the supporting tests are the source; a future compiler
  change must update both.
- **UI tests are expensive.** Data-loss acceptance needs a real kill/relaunch.
  The automated layers cover the store, scheduler and classifier; the manual
  acceptance step is recorded in the plan and the guide.
- **Rollback.** The recovery module and scheduler are additive; remove the
  commands and the `Session` fields to return to the old behaviour. The notice
  bar is a new row and can be hidden. The Typst branches are localized to
  `main.ts`/`typst-commands.ts`; revert those files to restore the old command
  output. No settings schema changes, so no migration is needed.

## Tests and validation

**Rust — `npm run test:rust`**

- round-trip write/list/remove;
- unsafe id (`../x`, `a/b`, empty) refused;
- corrupt `.json` and `.tmp` ignored, not deleted;
- content cap and entry cap;
- `updatedMs` set by Rust and newest first.

**Frontend — `npm run p0:unit`**

- `buildRecoveryEntry` carries path/name/language/content/base and never leaks
  an unsafe id;
- scheduler debounces, coalesces two changes into one write, serialises a
  forget behind an in-flight write, and reports a save failure once;
- `classifyDiskChange` covers unchanged, modified, deleted and no-path;
- Typst heading/paragraph/shift, quote, table, rule, outline, inline commands
  and display math produce the expected strings, and unsupported commands
  produce the note path rather than Markdown.

**Existing layers**

- `npm run test:sessions` — the new Session fields do not change the store
  invariants.
- `npm run smoke` — layout, preferences, status bar; the notice row is hidden.
- `npm run tabs` — tab restore and close still run.
- `npm run links` / `npm run links:unit` — link code is untouched.
- `npm run image:rules` / `npm run image:syntax` — image code is untouched.
- `npm run typst:preview` — Typst preview and menu reference.
- `npm run format:document` — the command dispatch still lists the same actions.
- `npm run build`, `npm run lint`, `npm run format:check`, `npm run knip`.

**Manual acceptance**

1. Launch with a scratch profile, type into an untitled Markdown buffer, wait
   one second, kill the process, relaunch: the text is back in a dirty tab and
   the recovery notice names one document.
2. Save the recovered buffer: the journal file disappears; relaunch shows no
   notice.
3. Discard it: the journal disappears and no tab returns.
4. Open a saved file, edit it, change the same file externally, wait for the
   poll: the notice appears; `Ctrl+S` does not overwrite; Reload restores the
   disk text with one undo; Keep mine lets the next save through.
5. Delete the file externally while dirty: the notice says deleted; Save is
   blocked until Keep mine/Save a copy.
6. In a `.typ` document, invoke Heading 1, ordered/bullet list, quote, table,
   rule, TOC, strong, emphasis, strikethrough, link, display math and image;
   compile the result with Typst. Unsupported items show the note, not
   Markdown.
7. Both themes: the notice bar is readable, the close button is focusable, and
   the hidden row leaves no gap.

## Acceptance criteria

- An untitled or saved dirty buffer survives a crash/forced kill and is offered
  back on the next launch, without writing next to the document.
- Save, Save As and Discard remove the journal entry; a clean launch shows no
  recovery notice.
- A dirty buffer whose file changed or disappeared on disk cannot be saved over
  the change without an explicit choice.
- Reload, Keep mine and Save a copy each produce the stated state and clear or
  preserve the conflict accordingly.
- Every enabled Paragraph/Format command in a Typst document inserts valid
  Typst; unsupported commands explain themselves.
- Markdown, AsciiDoc and HTML command output is unchanged.
- The notice bar does not shift the layout when hidden and is usable with the
  keyboard in both themes.
- The full test list above passes, with the documentation and counts updated.

## Open questions

1. **Journal retention.** Default: 64 entries and 16 MiB each, under the
   application config directory beside `settings.json`, with no time-based
   deletion; a future pass can prune with a visible setting.
2. **Restore focus.** Default: activate the newest recovered document. If a
   command-line file was opened, it stays open as a tab but the recovered one
   takes focus so the reader sees that work was saved.
3. **Conflict UI.** Default: the notice bar, not a modal. It is visible in
   every view mode and does not block typing.
4. **Typst task lists.** Default: a note, no lookalike markup. If Typst gains a
   native task list, add the branch then.
5. **Journal for read-only buffers.** Default: skip; a read-only buffer cannot
   be edited, and its content is on disk.
