# MDraft backlog — prioritized gaps

**Status:** living document, not a plan
**Audited:** 2026-10-24, against the `0.4.6` tree with the link-navigation and
image-paste plans in flight
**Owner:** whoever picks an item up; update `Status` and add the plan/commit
**Related:** [plans](plans/README.md), [ADRs](adr/README.md),
[AGENTS.md](../AGENTS.md)

This is the map of product gaps, documentation drift and missing editor
capabilities found by a read-only audit. It is deliberately **not** a plan: an
item becomes a plan in `docs/plans/` when it is picked up, and a durable
architectural decision becomes an ADR.

## How to use this document

1. Pick an item by priority and dependency. Do not start two items that touch the
   same foundation at once unless they are the same workstream.
2. Re-verify the evidence. The tree was being edited while this audit was
   written; the date is in the header and the item notes say when something is
   likely to move.
3. Follow [AGENTS.md](../AGENTS.md#governance-and-workflow): a plan is required
   before code when the change refactors, touches more than three files, changes
   a command/settings/menu contract, or adds a dependency.
4. Implement, test at the cheapest layer that can fail, update the reader docs
   and the counts in AGENTS.md, then set `Status` to `done` with the plan or
   commit hash.
5. If an item is no longer true, close it as `done (invalid)` with the reason.
   Do not renumber IDs: a developer may have linked to one.

**Done means:** the acceptance criteria are observable; a test that would fail
on the old behaviour exists; the settings schema and public commands still load
old data; the documentation no longer promises the old behaviour; and any
non-obvious lesson is added to the Traps section.

**Priority**

| Priority | Meaning | Rule of thumb |
| --- | --- | --- |
| **P0** | Data loss or silent document corruption | Stop and fix before new work |
| **P1** | Blocks a core daily workflow | Next planned work |
| **P2** | Important quality or consistency | Schedule after P0/P1 |
| **P3** | Polish | Opportunistic; do not delay P0/P1 |

**Effort**

| Size | Meaning |
| --- | --- |
| **S** | Half a day or less |
| **M** | One to three days |
| **L** | About a week |
| **XL** | More than a week, or a separate project |

**Status:** `open`, `in progress`, `blocked`, `recheck`, `parked`, `done`.

## Triage table

| ID | P | Effort | Workstream | Item | Status |
| --- | --- | --- | --- | --- | --- |
| GAP-001 | P0 | L | Data safety | Recover unsaved work | done |
| GAP-002 | P0 | M | Data safety | Guard dirty buffers against external changes | done |
| GAP-003 | P0 | M | Typst | Make Paragraph/Format commands Typst-aware | done |
| GAP-004 | P1 | M | Data safety | Three-way close prompt and Save All | open |
| GAP-005 | P1 | S/M | Data safety | Refuse binary/non-text files on open and drop | open |
| GAP-006 | P1 | L | Workspace | Open a folder and show a file tree | open |
| GAP-007 | P1 | L | Workspace | Search across files | open |
| GAP-008 | P1 | M | Workspace | Quick open (`Ctrl+P`) | open |
| GAP-009 | P1 | M/L | Output | Native Print / PDF | open |
| GAP-010 | P1 | L | Output | Table editing | open |
| GAP-011 | P1 | M | Preview | Search inside the preview | open |
| GAP-012 | P1 | S | Documentation | Documentation truth pass | in progress |
| GAP-013 | P1 | S/M | Markdown | YAML front matter handling | open |
| GAP-014 | P2 | M | Markdown | Academic Markdown dialect | open |
| GAP-015 | P2 | S | Editing | Typewriter mode while typing | open |
| GAP-016 | P2 | M/L | Preview | Preview interaction: images, tasks, copy, PDF toolbar | open |
| GAP-017 | P2 | M | Platform | Second window / single instance | open |
| GAP-018 | P2 | M | Editing | Link authoring | open |
| GAP-019 | P2 | S | Preview | Global zoom | open |
| GAP-020 | P2 | M | Platform | Spellcheck languages beyond en/pt | open |
| GAP-021 | P2 | M | Platform | File encoding | open |
| GAP-022 | P2 | L | Editing | Autocomplete for paths, headings and includes | open |
| GAP-023 | P3 | S/M | Polish | Small conveniences and persistence | open |
| GAP-024 | P3 | XL | Platform | UI localization | parked |

## P0 — data loss and silent corruption

### GAP-001 — Recover unsaved work

**Priority:** P0 · **Effort:** L · **Workstream:** Data safety · **Status:** done
— plan `docs/plans/2026-10-24-p0-data-safety.md`; unit, release-build smoke and
a force-kill/relaunch probe all passed

**Evidence.** `Auto Save` is opt-in (`auto_save: false` in `settings.rs`), runs
every 20 s, and `installAutoSave` skips every session without a `path`.
`restoreLastTabs` stores only paths. There is no journal, backup or recovery
command. An untitled buffer, or a saved buffer edited since the last Auto Save,
is lost on a crash or a forced kill.

**Target.** A recovery journal under the application config directory, beside
`settings.json`, records every dirty buffer, including untitled ones and the
language it was created in. The next launch restores them as dirty tabs and shows
how many came back; saving, Save As or discarding removes the entry. The journal
is written atomically and never inside the document's folder.

**Resolution.** `src-tauri/src/recovery.rs` stores one atomic JSON entry per
buffer (`list_recovery`/`write_recovery`/`remove_recovery`, 64 entries, 16 MiB
each). `src/recovery.ts` owns the 700 ms per-session debounce and the serialised
write/remove queue; `main.ts` journals dirty buffers, restores them after the
normal startup choice, and shows the notice. The test harness now backs up and
restores the `recovery/` directory with `settings.json`.

**Acceptance.**

- Type into an untitled document, kill the process, relaunch: the text is
  offered for restore, with its language and a sensible name.
- Edit a saved document with Auto Save off, kill, relaunch: both the on-disk
  version and the unsaved text are available; the reader chooses.
- After Save, Save As or Discard, no journal entry for that session remains.
- A crash during a journal write cannot leave a half-written file that blocks
  startup.
- No file is written next to the document.

**Tests.** Unit for the journal plan (names, deduplication, cleanup, cap); Rust
test for atomic write and read-back; a two-launch UI suite that kills the first
instance and checks the second. Use the throwaway-identifier build described in
AGENTS.md; never delete the user's `settings.json`, and back up
`.window-state.json` if a profile reset is unavoidable.

**Risks.** Force-killing the app can corrupt the WebView2 profile (AGENTS trap).
The test must own its profile and only kill the process it launched. A stale
journal must never overwrite a newer disk file without the reader's choice.

**Related.** GAP-002, GAP-004, GAP-021.

### GAP-002 — Guard dirty buffers against external changes

**Priority:** P0 · **Effort:** M · **Workstream:** Data safety · **Status:** done
— plan `docs/plans/2026-10-24-p0-data-safety.md`; Reload, Keep mine and the
deleted-file Save-anyway path were exercised on a release build

**Evidence.** `reloadChangedSessions` starts with
`if (!session.path || session.dirty) continue;`. A dirty tab is left alone
silently, but `Auto Save` (every 20 s) and `Ctrl+S` write it back. If another
editor or a sync client changed the file meanwhile, the change is overwritten
without a prompt.

**Target.** Before every write, and on the 2.5 s disk poll, compare the file's
identity (`mtime` plus size; a hash only when they are ambiguous). When a dirty
buffer's file changed on disk, notify and offer **Reload**, **Keep my version**
or **Save a copy**. Auto Save pauses for that session until the reader chooses.
Clean buffers keep the existing silent reload.

**Acceptance.**

- Change a file externally while its tab is dirty: a visible notice appears
  within one poll interval; the next `Ctrl+S` asks before overwriting.
- Choose **Reload**: the disk text replaces the buffer, one undo step can
  restore the unsaved text.
- Choose **Keep my version**: the next save goes through, and the choice is not
  asked again for that same disk revision.
- Auto Save does not overwrite while the conflict is unresolved.
- A clean tab still reloads automatically, as today.

**Resolution.** `src/disk-change.ts` classifies the stat; `main.ts` polls it,
raises `Session.conflict`, shows the notice-bar actions and performs the same
check in `writeSession` before every save. `reloadChangedSessions` now handles a
dirty or deleted buffer instead of skipping it, and a recovered journal restores
the base `mtime`/size so a file that moved while MDraft was closed is caught.

**Tests.** Rust unit for the stat comparison; UI suite using a temporary file
edited outside the app; two saves separated by more than the 250 ms menu guard.

**Risks.** Coarse timestamps on network shares; a save that changes only `mtime`
without content changes; a sync client that rewrites in place. Use size first,
then `mtime`, and never loop the prompt on every poll.

**Related.** GAP-001, GAP-004, GAP-021.

### GAP-003 — Make Paragraph/Format commands Typst-aware

**Priority:** P0 · **Effort:** M · **Workstream:** Typst · **Status:** done —
plan `docs/plans/2026-10-24-p0-data-safety.md`; Typst 0.15.1 compiled every
emitted construct

**Evidence.** `setHeadingCommand`, `quoteCommand`, `listCommand`, `tableCommand`,
`tocCommand`, `frontMatterCommand`, `alertCommand` and `inlineCommand` have
branches for HTML and AsciiDoc but none for Typst. They fall through to
Markdown:

| Command | Inserts today | Typst expects |
| --- | --- | --- |
| Heading 1 | `# Title` | `= Title` |
| Ordered list | `1. item` | `+ item` |
| Quote | `> text` | `#quote[...]` |
| Table | pipe table | `#table(...)` |
| Horizontal rule | `---` | `#line(length: 100%)` |
| Table of contents | `[TOC]` | `#outline()` |
| Strong / emphasis | `**x**` / `*x*` | `*x*` / `_x_` |
| Link | `[x](url)` | `#link("url")[x]` |
| Display math | `$$ … $$` | `$ … $` with spaces |
| Front matter | YAML | no such construct |

`Ctrl+1` in a `.typ` file inserts `# Title`, which is not a heading and can stop
the document compiling. `Ctrl+Shift+7` inserts `1.`, which Typst does not read
as a list. `Format › Image` now has a Typst branch; the rest does not.

**Target.** One language-aware command table (pure and unit-testable) owns what
each command inserts. Typst gets correct syntax. Commands with no Typst
equivalent (task list, GitHub alert, YAML front matter) are disabled with a note
that says why, not silently converted. The same table feeds the help text.

**Acceptance.**

- Every Paragraph/Format item that remains enabled in a `.typ` document inserts
  valid Typst and compiles in the installed compiler.
- Unsupported items are disabled with an explanatory title; no enabled command
  inserts Markdown syntax into Typst.
- Markdown, AsciiDoc and HTML output is byte-for-byte unchanged.
- The Typst Reference and the built-in shortcut sheet agree with the behaviour.

**Resolution.** `src/typst-commands.ts` owns the heading/paragraph/shift line
transforms and the quote/table/rule/TOC/inline/display-math strings;
`editor.ts` gained the Typst heading transforms; `main.ts` dispatches every
Paragraph/Format item to a Typst branch or to an explanatory note. No Markdown
syntax remains on an enabled Typst path.

**Tests.** Unit for each command × language; a UI suite that invokes the menu in a
`.typ` fixture and checks both the buffer and a fresh Typst compile; `npm run
typst:preview` stays green.

**Risks.** Typst syntax changes between compiler versions; pin the minimum
version the app supports. Do not "fix" an unsupported construct with a lookalike
that silently renders differently.

**Related.** GAP-012, GAP-016, the Typst Reference in
`samples/typst-reference.typ`.

## P1 — essential workflows

### GAP-004 — Three-way close prompt and Save All

**Priority:** P1 · **Effort:** M · **Workstream:** Data safety · **Status:** open

**Evidence.** `confirmDiscard`, `closeSession` and `installCloseGuard` use the
native two-button `ask("Save them first?")`. There is no Cancel: closing the
dialog or choosing No discards. Several dirty tabs produce one prompt each, and
there is no **Save All**.

**Target.** An in-app modal (same visual language as Preferences) with **Save**,
**Discard** and **Cancel**, plus **Save All** when more than one buffer is dirty.
Escape and the window close button cancel the operation. The native close path
still runs when the reader confirms.

**Acceptance.**

- Cancel leaves the tab or the window open, with every buffer intact.
- Save writes and closes; Discard closes without writing; Save All writes every
  dirty buffer with a path and asks for a path for each untitled one.
- The close prompt names the document and the number of dirty buffers.
- `test-close.ps1` still proves the release binary exits and writes
  `.window-state.json`.

**Tests.** UI suite for tab and window close; `test-close.ps1`; capability check
if the modal uses a new command.

**Risks.** The window is closing while a modal is open; the native close must not
race the prompt. Keyboard focus and screen-reader labels need the same care as
the editor menu.

**Related.** GAP-001, GAP-002.

### GAP-005 — Refuse binary/non-text files on open and drop

**Priority:** P1 · **Effort:** S/M · **Workstream:** Data safety · **Status:** open
(recheck: preview links now route through `openLinkTarget`)

**Evidence.** `File › Open` offers **All files** and passes every path to
`openPath`; `installDragDrop` passes every non-image path to `openPath`;
`read_document` decodes any bytes with `String::from_utf8_lossy` and only shows a
toast afterwards. Opening a PDF, DOCX, ZIP or image through the dialog creates a
tab of replacement characters, and saving rewrites the original file.

**Target.** A `FileKind` classifier used by Open, drop and link opening:
`text` (editable), `image` (import/drop), `binary` (refuse or open with the OS),
`too_large` (warn or refuse), `missing`. Text detection checks a BOM, UTF-8
validity and NUL bytes before the lossy path. A lossy buffer requires an explicit
confirmation before its first save.

**Acceptance.**

- Opening or dropping a PDF/DOCX/ZIP/image does not create a text tab; images
  still import, and other binaries go to the OS opener (subject to the
  executable refusal) or are refused with a message.
- A UTF-16 text file is not misclassified as binary; it is offered the encoding
  path (GAP-021) or opened read-only with a clear message.
- A lossy buffer cannot be saved until the reader confirms the rewrite.
- Dropping several files imports the images and opens the editable documents,
  ignoring the rest.

**Tests.** Rust unit over byte fixtures (PNG, PDF, ZIP, UTF-8, UTF-16 BOM, NUL
text); UI with temporary files and the drop event.

**Risks.** False positives for UTF-16/UTF-32 and for text with a stray NUL;
false negatives for PDFs whose header is not at byte 0. Detect a BOM first, then
sniff the first block, then validate UTF-8.

**Related.** GAP-021, `open_external` in `documents.rs`.

### GAP-006 — Open a folder and show a file tree

**Priority:** P1 · **Effort:** L · **Workstream:** Workspace · **Status:** open

**Evidence.** The sidebar has only Outline, Favorites and Recent. `documents.rs`
has no directory-listing command; the only `read_dir` calls in the tree are for
finding pandoc and Typst. There is no folder state in settings.

**Target.** **File › Open Folder…** adds a workspace. The sidebar gets a lazy
file tree for the supported extensions, with the active tab highlighted, a
context menu (Open, Reveal, New File, Rename, Delete with confirmation), and
recent folders. Folders are remembered per window; a missing folder explains
itself and can be removed.

**Acceptance.**

- Open a folder, expand it, click a file: it opens in a tab and the tree marks
  the active file.
- The tree skips hidden, ignored and binary files by default; a toggle shows
  everything.
- A folder with 10,000 entries remains usable (lazy children, no full recursive
  walk on open).
- Closing and relaunching restores the folder and the expanded state, or
  explains that it is gone.
- No network access and no write outside the folder the reader chose.

**Tests.** Rust unit for listing/filtering and path confinement; UI with a
temporary tree containing nested folders, spaces, accents, a symlink and a
binary. `npm run tabs` and `npm run favorites` stay green.

**Risks.** Huge folders, slow network shares, symlink loops, Windows long paths
and permissions. Never walk the whole drive; never follow a symlink outside the
workspace without asking.

**Related.** GAP-007, GAP-008, GAP-018, GAP-022.

### GAP-007 — Search across files

**Priority:** P1 · **Effort:** L · **Workstream:** Workspace · **Status:** open

**Evidence.** `Ctrl+F` searches the focused editor only. There is no command to
search a folder, no results panel, and no replace across files.

**Target.** A search panel scoped to the workspace (or to the open tabs when
there is no folder): query, case, whole word, regex, include/exclude globs;
results grouped by file with line previews; click opens the file at the match;
**Replace** with a preview and a confirmation, never a silent multi-file write.

**Acceptance.**

- Search a temporary tree with accented text, a binary file and an ignored
  folder: only text files match, accents fold correctly, results are ordered by
  path then line.
- Clicking a result opens the tab at the right line and column.
- Replace All lists the files and the number of replacements before writing;
  Cancel changes nothing; Undo restores each touched buffer.
- A cancelled or superseded search stops doing work.
- No result is returned from a file that changed after the snapshot without a
  warning.

**Tests.** Rust unit for walking/filtering and caps; UI with a fixture tree;
replace tested on a copy. `npm run tabs` and `npm run paste` stay green.

**Risks.** Regex denial of service, binary files, encodings, very large results.
Cap results and file size, abort on cancel, and run the search off the UI thread.

**Depends on.** GAP-006 for the workspace index; can search open tabs without it.

**Related.** GAP-006, GAP-008, GAP-021.

### GAP-008 — Quick open (`Ctrl+P`)

**Priority:** P1 · **Effort:** M · **Workstream:** Workspace · **Status:** open

**Evidence.** There is no `Ctrl+P`, no command palette and no go-to-file by name.
Recent and Favorites are the only shortcuts to a path.

**Target.** `Ctrl+P` opens a fuzzy picker over the workspace file index (or the
recent list without a folder). `Ctrl+Shift+P` may open a command palette later;
start with files. Enter opens the highlighted file; Escape restores focus;
recent choices rank first. A `:` prefix can go to a line, matching the existing
CodeMirror `gotoLine` command.

**Acceptance.**

- Type a partial name with accents/spaces and open the file; the picker is
  keyboard-only and does not steal typing from the editor when closed.
- A file outside the workspace is not listed.
- With no folder open, recent files are listed and still open.
- The picker does not duplicate an already open tab; it activates it.

**Tests.** Unit for the fuzzy ranker; UI with a temporary tree; keyboard-only
path including Escape and IME.

**Risks.** Rebuilding the index on every keystroke; stale index after a rename;
conflict with the editor's own `Ctrl+P` (none today). Debounce and invalidate on
folder changes.

**Depends on.** GAP-006 for the file index.

**Related.** GAP-006, GAP-007, GAP-022.

### GAP-009 — Native Print / PDF

**Priority:** P1 · **Effort:** M/L · **Workstream:** Output · **Status:** open

**Evidence.** There is no `File › Print`. `File › Export › PDF (Print)` writes a
temporary HTML and opens the system browser; `PDF (via Typst)` needs pandoc and
Typst. `window.print()` is dead in WebView2, as AGENTS.md documents.

**Target.** **File › Print…** opens the platform print UI for Markdown, AsciiDoc
and HTML. **File › Export › PDF…** writes a PDF without a browser where the host
supports it (WebView2 `PrintToPdf`; WebKitGTK print API), with the browser path
as a fallback. The print document is always light, embeds faces, and renders
Mermaid in the light theme even when the editor is dark.

**Acceptance.**

- Print opens a real print dialog and prints the same article the preview
  shows, with working page breaks and no console window flash.
- Export PDF writes a readable PDF at the chosen path; the text is selectable;
  fractions, radicals, diagrams and images are present.
- If the host cannot print, the command says so and offers the browser path; it
  never silently does nothing.
- `After Export` options run only when a file was actually written.

**Tests.** Windows manual/UI capture; Linux WebKit manual; `npm run export`
(real pandoc) stays green; inspect the PDF bytes and the number of pages; a dark
theme with a Mermaid diagram prints on white.

**Risks.** WebView2 COM interop and WebKitGTK APIs differ; printing from a hidden
webview may fail. Do not replace the existing HTML/Print path until the new one
is proven on both published platforms.

**Related.** GAP-010, GAP-016, `export.rs`, `markdown.ts` print wrapper.

### GAP-010 — Table editing

**Priority:** P1 · **Effort:** L · **Workstream:** Output · **Status:** open

**Evidence.** `tableCommand` inserts a fixed template. There is no table parser,
no row/column operation, no alignment control and no cell navigation. Format
Document aligns existing columns with Prettier, but editing is manual.

**Target.** A table model that parses the table under the caret, serializes it
back losslessly, and drives: add/delete row, add/delete column, move row/column,
set alignment, and `Tab`/`Shift+Tab` between cells. Markdown first; AsciiDoc
second; HTML tables can follow. Typst tables are `#table` code and are out of
scope for the first pass.

**Acceptance.**

- Operations work on a table with escaped pipes, inline code, links and
  alignment markers; cell text is never lost.
- `Tab` at the last cell adds a row or moves to the next logical cell, depending
  on the chosen convention (document it).
- One undo restores the exact original bytes.
- A document with no table still gets the template.
- Format Document and table editing do not fight: formatting a table is
  idempotent after an edit.

**Tests.** Unit for parse/serialize and each operation; UI on Markdown and
AsciiDoc fixtures; `npm run format:document` stays green.

**Risks.** Escaped pipes, multi-line cells, alignment rows, CRLF, tables inside
blockquotes or lists. Parse only the contiguous table block and fail closed
rather than rewriting a malformed table.

**Related.** GAP-014, `format/formatters.ts`.

### GAP-011 — Search inside the preview

**Priority:** P1 · **Effort:** M · **Workstream:** Preview · **Status:** open

**Evidence.** `edit.find` always calls `editor.openSearch`. In Preview-only mode
the editor pane is hidden, so `Ctrl+F`/`Ctrl+H` show nothing. The HTML guest
forwards known accelerators to the same handler, and Typst Pages has no search.
`docs/guide.md` said the Pages text layer could be "searched"; that claim was
removed in the P0 pass, but the search itself is still absent. The 2026-10-18
plan listed a search UI as non-scope.

**Target.** A preview-search overlay that targets the active renderer: DOM text
for Markdown/AsciiDoc, a bridge message for the HTML guest, and the PDF.js text
layer for Typst Pages. Match count, next/previous, case and whole-word; Escape
closes and clears the highlight. It searches the rendered text, never mutates the
source.

**Acceptance.**

- In Preview-only, `Ctrl+F` finds visible text, scrolls to the first match and
  highlights every match.
- In Split, the command can target the source or the preview; the choice is
  visible, not a hidden mode.
- The HTML guest searches its current document without running its scripts.
- Typst Pages finds text across pages and scrolls the page into view.
- Escape clears the highlight and returns focus to the pane that had it.

**Tests.** UI per renderer; guest bridge message; PDF text layer with a repeated
word; reduced motion; `npm run word-sync` and `npm run html` stay green.

**Risks.** PDF text extraction splits words at line breaks; guest CSP/IPC; a
selection in the preview must not be stolen by the editor; highlighting must not
persist after a re-render.

**Related.** GAP-012, GAP-016.

### GAP-012 — Documentation truth pass

**Priority:** P1 · **Effort:** S · **Workstream:** Documentation · **Status:** in progress — the P0 pass fixed the tab-list, Pages-search and
typewriter claims in `docs/guide.md`; the built-in shortcut table, the
Preferences notes and the AsciiDoc/Typst Enter sentence remain

**Evidence.** The built-in **Help › Keyboard Shortcuts** disagrees with the
native menu:

| The document says | The app does |
| --- | --- |
| Zoom `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | `Ctrl+Shift+=` / `Ctrl+Shift+-` / `Ctrl+Shift+0` |
| Bullet list `Ctrl+Shift+8` | `Ctrl+Shift+[` |
| Ordered list `Ctrl+Shift+7` | `Ctrl+Shift+]` |
| Task list `Ctrl+Shift+9` | `Ctrl+Shift+X` |
| Strikethrough `Ctrl+Shift+X` | `Alt+Shift+5` |

Following the sheet for strikethrough inserts a task item; following it for zoom
turns a paragraph into a heading. Other stale claims:

- `docs/guide.md`: "The tab list itself is not saved when the window closes",
  although Reopen the last tabs restores it.
- `docs/guide.md`: Pages text can be "searched" (GAP-011 has no search yet).
- `docs/guide.md`: Typewriter "keeps the caret vertically centred while typing"
  (GAP-015).
- `src/content.ts`: "`Enter` continues lists and quotes" is true only in
  Markdown; AsciiDoc and Typst install no continuation keymap.
- `src/preferences.ts`: "Math and diagram settings above apply to Markdown and
  Typst" — they apply to Markdown and AsciiDoc; Typst compiles its own.
- `src/preferences.ts`: "YAML front matter [is] always enabled" (GAP-013).

**Target.** One pass over `README.md`, `docs/guide.md`, `docs/export.md`,
`src/content.ts` and the preference help strings. Every shortcut in Help is
registered and behaves; every capability sentence is either tested or removed.
Add a test that compares the shortcut table with the `accelerators` registry, so
the two cannot drift again.

**Acceptance.**

- `npm run shortcuts` (or a new unit) fails when a documented accelerator is not
  registered, or is registered with a different key.
- Help, menu and guide list the same shortcuts.
- The stale sentences above are gone or state the real limitation.
- The typo fix does not change behaviour unless the code was wrong by design;
  decide per row and record the decision.

**Tests.** Extend `scripts/shortcut-test.mjs` to parse the built-in table and
compare it with `api.accelerators()`; `npm run build`; manual Help check.

**Risks.** The document may be right and the menu may have the wrong Typora
accelerators. Decide deliberately: either add aliases (`Ctrl+Shift+8/7/9`) or
document the menu's chosen keys. Do not silently rename a shortcut readers
already use.

**Related.** GAP-003, GAP-011, GAP-013, GAP-015.

### GAP-013 — YAML front matter handling

**Priority:** P1 · **Effort:** S/M · **Workstream:** Markdown · **Status:** open

**Evidence.** `Paragraph › YAML Front Matter` inserts:

```markdown
---
title:
date:
---

```

`renderPreview` has no front-matter handling. Measured with the bundled
`marked`, this renders as `<hr>` plus `<h2>title: \ndate:</h2>`. Preferences says
YAML front matter is "always enabled"; the same command is offered in Typst,
where YAML does not exist. Pandoc reads the block as metadata, so preview and
export disagree.

**Target.** Recognize a leading `---` block only when it closes with `---` and
contains `key: value` lines. Hide it from the preview, or render a small
metadata card (choose one and document it). Headings, `[TOC]` and word sync
ignore the block; the source and every export keep it. In Typst, the command is
disabled with a note or replaced by the native equivalent.

**Acceptance.**

- The inserted block no longer produces an `<hr>` and a heading in the preview.
- A genuine horizontal rule at the top of a document is still a rule.
- `[TOC]` does not list front-matter keys.
- Word sync maps the body correctly around the block.
- The source and the pandoc input keep the block; the native HTML/PDF output
  does not print it as body text.
- Typst does not insert YAML.

**Tests.** Unit for `renderPreview` with valid, empty and malformed front matter;
smoke fixture; `npm run export`; `npm run typst:preview` for the Typst command.

**Risks.** Hiding a real rule; treating a `---` separator in prose as metadata;
CRLF. Fail closed: show the block rather than hide content that is not clearly
front matter.

**Related.** GAP-014, GAP-012.

## P2 — important quality and consistency

### GAP-014 — Academic Markdown dialect

**Priority:** P2 · **Effort:** M · **Workstream:** Markdown · **Status:** open

**Evidence.** The preview is GFM. Measured with the bundled `marked`:

- `Text[^1]` and `[^1]: A note` stay literal (no footnotes).
- `H~2~O` becomes `H<del>2</del>O` — chemistry renders as strikethrough.
- `x^2^` stays literal (no superscript).
- `==highlight==` stays literal (no mark).
- Definition lists render as paragraphs.

Pandoc's Markdown reader understands footnotes, superscript/subscript and
definition lists (check the `mark` extension for the pandoc version in use), so
the DOCX/LaTeX output and the preview disagree. The physics-paper sample and the
Typst/LaTeX focus make this audience real.

**Target.** Decide the dialect explicitly and implement it in the preview and in
the paste readers/renderers: footnotes, subscript, superscript, highlight and
definition lists. Keep the source syntax and the exported output aligned. If a
construct is not adopted, remove it from the copy/paste mapping too.

**Acceptance.**

- A fixture with all five constructs renders correctly in the preview and in the
  native HTML/PDF paths.
- `H~2~O` is subscript, never strikethrough.
- Footnotes get stable ids, backlinks and anchors that survive word sync.
- Paste converts the same constructs in both directions.
- DOCX/LaTeX spot checks show the same structures (not literal markers).

**Tests.** Unit for the renderer extensions; smoke fixture; `npm run
paste:convert`; `npm run export`; `npm run word-sync`.

**Risks.** `~` and `^` are ambiguous with math and currency; footnote ids can
collide with heading ids; DOMPurify must keep the generated markup; performance
on large documents. Add the extension behind a setting only if the ambiguity
cannot be resolved safely.

**Related.** GAP-013, GAP-012.

### GAP-015 — Typewriter mode while typing

**Priority:** P2 · **Effort:** S · **Workstream:** Editing · **Status:** open

**Evidence.** `editor.ts` recenters only when
`typewriter && update.selectionSet && !update.docChanged`. Typing produces both
flags, so the caret is not recentered while typing. `docs/guide.md` now states
the actual behaviour; the code gap remains.

**Target.** Recenter after a text change when typewriter mode is on, without
fighting a manual scroll. A small threshold (only when the caret leaves the
middle band) avoids constant scroll updates.

**Acceptance.**

- Type at the bottom of the viewport with F9 on: the caret stays near the
  vertical centre.
- A manual scroll is not yanked back until the next keystroke.
- IME composition and multi-cursor do not jump.
- Reduced-motion users get the same final position without animation.

**Tests.** UI geometry at three viewport positions; repeat with focus mode;
`npm run smoke` stays green.

**Risks.** Scroll jitter, performance on every keystroke, source/preview sync
fighting the scroll. Use one `requestAnimationFrame` and the existing
suppression window.

**Related.** GAP-012.

### GAP-016 — Preview interaction

**Priority:** P2 · **Effort:** M/L · **Workstream:** Preview · **Status:** open
(recheck: Ctrl+click image opening and `data-src` are in flight)

**Evidence.** Task-list checkboxes are forced `disabled` by `normalizeInputs`.
There is no image lightbox, resize syntax or alt editor. Code blocks have no
copy button; formulas have no copy-TeX menu. Typst Pages has no toolbar, zoom,
page navigation or outline (the 2026-10-18 plan lists them as non-scope).

**Target.** Split into independently shippable sub-items:

1. **Task lists** — clicking a checkbox toggles the matching source marker, one
   undo step, only when the document is editable.
2. **Images** — a lightbox and a width/height insertion helper; keep the
   existing Ctrl+click open.
3. **Code** — a copy button on fenced blocks.
4. **Math** — copy TeX / copy MathML from a context menu.
5. **Pages** — a minimal toolbar: zoom, page number, previous/next page.

**Acceptance.** Each sub-item has its own observable statement; the first one
must not fire when the preview is stale, and no preview interaction may edit a
read-only buffer.

**Tests.** UI per sub-item; `npm run html`, `npm run typst:preview`, `npm run
word-sync` stay green; source bytes unchanged after clicking a checkbox twice.

**Risks.** Editing source from the preview must be undoable and must respect
word-sync mapping; the HTML guest is sandboxed; PDF.js text layers are not DOM
anchors.

**Related.** GAP-011, the image plan, the link plan.

### GAP-017 — Second window / single instance

**Priority:** P2 · **Effort:** M · **Workstream:** Platform · **Status:** open

**Evidence.** There is no single-instance plugin and no `New Window` command.
AGENTS.md records that a second copy with the same identifier fails to create its
WebView2 environment (`0x800700AA`) while another MDraft window is open. Opening
a second file from Explorer therefore has no reliable path into the running
window.

**Target.** Single-instance handoff: a second launch forwards its paths to the
existing window and exits. Add **File › New Window** only if multi-window is
explicitly wanted; then each window needs its own tab set and a safe settings
merge.

**Acceptance.**

- With MDraft open, double-click a second document: the existing window comes
  forward and opens a tab; no second process remains.
- Launching from a terminal with a path does the same.
- Closing the last window still writes window state and settings.
- If the handoff fails, the second launch reports it instead of dying silently.

**Tests.** Manual two-launch; a PowerShell launcher with a throwaway identifier;
`test-close.ps1`; no user profile deletion.

**Risks.** New dependency; macOS/Linux activation; portable build paths; two
windows fighting over `settings.json` and `lastTabs`. Define the ownership before
adding windows.

**Related.** GAP-006, GAP-023.

### GAP-018 — Link authoring

**Priority:** P2 · **Effort:** M · **Workstream:** Editing · **Status:** open
(recheck: link navigation is in flight)

**Evidence.** `Ctrl+K` is `wrapSelection("[", "](https://)")` (or the HTML/
AsciiDoc equivalent). There is no dialog, no file or heading picker, no way to
edit an existing link and no title/alt field.

**Target.** A link dialog that accepts a URL, a local file (workspace picker) or
a heading (`#id`), shows the resolved target, validates it, and edits the link
under the caret in place. Reuse `links.ts` and the open-link resolver so the
authoring and navigation sides agree.

**Acceptance.**

- Select text, `Ctrl+K`, choose a file/heading/URL: the correct syntax is
  inserted for Markdown, AsciiDoc, Typst and HTML.
- Right-click an existing link: **Edit Link…** changes destination and title
  without duplicating the text.
- Escaping and balanced parentheses survive; no broken syntax on a path with
  spaces.
- A local target that does not exist warns before inserting.

**Tests.** Unit for per-language syntax and escaping; UI for insert/edit/cancel;
the link-navigation suite (`scripts/link-navigation-test.mjs`, once registered)
and `npm run paste` stay green.

**Risks.** Source offsets after a selection change; link vs image syntax; nested
brackets; a dialog that steals focus from the editor.

**Depends on.** The link-navigation plan for `linkAt`/`openLinkTarget`; GAP-006
for the file picker.

**Related.** GAP-022, `src/links.ts`, the link-navigation plan.

### GAP-019 — Global zoom

**Priority:** P2 · **Effort:** S · **Workstream:** Preview · **Status:** open

**Evidence.** `view.zoomIn/Out` change only `editorFontSize`; `view.zoomReset`
also resets `editorMaxWidth` to 980. In Preview-only the zoom does nothing
visible. The status chip says "Reset zoom".

**Target.** A single document zoom that scales the editor and the preview
together (CSS `zoom` or a root font scale), with reset affecting zoom only.
Content width stays a separate preference.

**Acceptance.**

- In Preview-only, `Ctrl+Shift+=` enlarges the rendered text and images.
- In Split, both panes scale together; line wrapping stays usable.
- Reset returns to 100% without touching Content Width.
- The chip shows the current percentage and hides at 100%.

**Tests.** UI computed font sizes in both modes; screenshot at 150%; `npm run
smoke` layout checks.

**Risks.** CSS `zoom` vs font-size scaling changes line measurement; PDF canvases
and Mermaid SVGs need care; `devicePixelRatio` on high-DPI.

**Related.** GAP-016.

### GAP-020 — Spellcheck languages beyond en/pt

**Priority:** P2 · **Effort:** M · **Workstream:** Platform · **Status:** open

**Evidence.** `spellcheck.rs` `resolve()` maps only `en`, `pt-BR` and `pt-PT`;
the Hunspell path probes only those keys. `dictionaryOptions` offers the same
short list. An installed French or German dictionary is ignored.

**Target.** List every language the OS reports, accept any tag the engine can
resolve, and map a requested tag to the best installed match. Keep the current
auto-detection for English/Portuguese, and allow a per-document override.

**Acceptance.**

- A machine with a French dictionary offers French and underlines a French
  misspelling; if the dictionary is absent, the option is disabled with a note.
- The selected language survives a restart and is shown in the status bar.
- Code, URLs and math remain excluded.
- No dictionary is downloaded and no network request is made.

**Tests.** Rust unit with a fake list and a real dictionary when present; UI on a
machine with en+pt; skip when the OS lacks the third language.

**Risks.** OS APIs differ (ISpellChecker, Hunspell, NSSpellChecker); dictionary
tags are not uniform; auto-detection on short text. Fail closed: underline
nothing rather than guess.

**Related.** GAP-024.

### GAP-021 — File encoding

**Priority:** P2 · **Effort:** M · **Workstream:** Platform · **Status:** open

**Evidence.** `read_document` decodes every file as UTF-8 lossily, records
`lossy`, and warns after opening; saving rewrites the bytes. There is no encoding
picker, no UTF-16 detection and no "Reopen with Encoding".

**Target.** Detect a BOM (UTF-8/UTF-16LE/BE), validate UTF-8, and fall back to an
encoding picker (UTF-8, UTF-16, Windows-1252 at minimum). Remember the chosen
encoding per document; save in the same encoding; preserve BOM and EOL. A lossy
buffer requires confirmation before its first save.

**Acceptance.**

- Open a UTF-16 file with a BOM: it opens correctly and saves back as UTF-16
  with the same BOM.
- Open a Windows-1252 file: the picker offers it, the text is correct, and
  saving does not replace accents with `?`.
- Reopen with Encoding changes the decoding without touching the file.
- The status bar shows the encoding in use.
- A file with mixed/invalid bytes never silently becomes valid UTF-8 on save.

**Tests.** Rust unit over byte fixtures; UI with temporary files; round-trip
byte comparison; `npm run test:rust`.

**Risks.** A new dependency (`encoding_rs` or similar) needs a plan; heuristic
detection can be wrong; invalid sequences in the middle of a file. Prefer BOM,
then valid UTF-8, then the reader's choice.

**Related.** GAP-005.

### GAP-022 — Autocomplete for paths, headings and includes

**Priority:** P2 · **Effort:** L · **Workstream:** Editing · **Status:** open

**Evidence.** `@codemirror/autocomplete` is used only for `closeBrackets`. There
is no completion for image paths, link targets, headings or `#include`/
`include::`.

**Target.** Context-aware completion sources:

- image/link path from the workspace index;
- heading targets (`#…`) in the current document;
- `#include`/`include::` paths;
- snippets for table/front matter/code fence.

No completion inside code spans, fenced code or math. Accept with Enter/Tab,
dismiss with Escape; never block typing when the index is cold.

**Acceptance.**

- Type `#image("` in Typst or `![` in Markdown: a filtered file list appears.
- Type `](#`: headings from the current document appear.
- Type `include::`: paths relative to the document appear, with the same jail
  as the preview.
- No completion appears in a code block or after a currency `$`.
- The list is keyboard-navigable and does not steal focus from the editor.

**Tests.** Unit for each completion source; UI on Markdown/Typst/AsciiDoc;
`npm run autoclose` and `npm run paste` stay green.

**Risks.** Noisy suggestions, index latency, IME composition, a completion that
inserts a path the preview cannot read (custom folder/Typst root). Reuse the
workspace index and the image root rules.

**Depends on.** GAP-006 for path completion.

**Related.** GAP-006, GAP-007, GAP-018.

## P3 — polish

### GAP-023 — Small conveniences and persistence

**Priority:** P3 · **Effort:** S/M · **Workstream:** Polish · **Status:** open

**Evidence / target.** Independent small items; pick them in batches:

- **Save All** (`Ctrl+Shift+S` is taken; choose a menu-only command or another
  key) and **Reopen Closed Tab** (`Ctrl+Shift+T`).
- **Rename/Move** and **Copy Path** from the tab menu.
- **Word wrap** and **line numbers** toggles (today always on).
- **Selection statistics** (words/characters) and reading time in the status
  tooltip.
- **Read-only toggle** for a buffer.
- **Per-document spell language** (GAP-020 provides the list).
- **Persist sidebar width and editor/preview split** (the guide says they are
  not persisted today).
- **Reset preferences** and **Open settings folder** in Preferences.

**Acceptance.** Each sub-item has its own observable check; settings additions
keep old files loading; no new menu item is dead in a language/mode where it
cannot run.

**Tests.** Unit where the logic is pure; `npm run tabs`, `npm run smoke`; a
settings round-trip test in Rust.

**Risks.** Settings schema growth; window-state plugin only stores window size,
not the split; keyboard conflicts with the editor.

**Related.** GAP-006, GAP-020.

### GAP-024 — UI localization

**Priority:** P3 · **Effort:** XL · **Workstream:** Platform · **Status:** parked

**Evidence.** Every string in the UI, dialogs, menus and built-in documents is
English, while the spellchecker and the audience include Portuguese.

**Target.** A string catalog with locale detection and a Portuguese translation
first. Keep the built-in documents translatable or ship localized copies. Do not
translate code identifiers, command ids or settings keys.

**Acceptance.** A Portuguese locale produces Portuguese menus, dialogs,
preferences and status text; switching locale does not change settings or
document bytes; missing keys fall back to English.

**Tests.** Unit for catalog completeness; UI screenshot per locale; menu labels
in `menu_state`.

**Risks.** Native menu labels come from Rust; a catalog must span both sides.
Large surface; keep it out of the P0/P1 path until the product gaps are closed.

**Related.** GAP-020, `menu.rs`, `preferences.ts`.

## Shared foundations

Do these once and reuse them; they are the “common points” between items.

| Foundation | Serves | Shape |
| --- | --- | --- |
| **Recovery store** | GAP-001, 002, 004 | Dirty-state model + atomic journal + restore/discard plan |
| **File policy** | GAP-005, 021 | `FileKind` classifier + encoding decision, used by Open, drop and links |
| **Workspace index** | GAP-006, 007, 008, 018, 022 | Directory listing + ignore rules + fuzzy/path search |
| **Preview search adapter** | GAP-011, 016 | One query/highlight interface over DOM, guest and PDF text layer |
| **Language command table** | GAP-003, 012, 013, 014 | Pure `commandsFor(language)` used by menus, help and tests |
| **Table model** | GAP-010, 014 | Parse/serialize a contiguous table block, fail closed |
| **Shortcut registry test** | GAP-012 | Compare menu accelerators with the built-in table |
| **Data-safety test harness** | GAP-001, 002, 004, 017 | Throwaway identifier, two launches, graceful close vs kill |

## Suggested order

**Batch 1 — stop losing work (P0).**
GAP-001 + GAP-002 + GAP-004 share the dirty-state model; GAP-003 is independent
but equally urgent. **GAP-001, GAP-002 and GAP-003 are done** (plan
`2026-10-24-p0-data-safety.md`); GAP-004 remains.

**Batch 2 — cheap truth and safety (P1).**
GAP-012 (shortcuts/docs), GAP-005 (file policy), GAP-013 (front matter). These
are small and remove daily confusion.

**Batch 3 — workspace (P1).**
GAP-006 first, then GAP-007 and GAP-008 on the same index.

**Batch 4 — output and preview (P1).**
GAP-009, GAP-010, GAP-011.

**Batch 5 — quality (P2).**
GAP-014, GAP-015, GAP-016, GAP-019.

**Batch 6 — platform and authoring (P2).**
GAP-017, GAP-018, GAP-020, GAP-021, GAP-022.

**Batch 7 — polish.**
GAP-023, then GAP-024 only when the rest is stable.

**Quick wins (S):** GAP-012 (shortcuts/docs), GAP-015 (typewriter), GAP-019
(zoom), and GAP-005 (binary guard, S/M). These remove daily confusion without a
large design.

**Highest risk:** GAP-001, GAP-002 and GAP-004 (data safety) and GAP-005
(opening a binary as text). Start there even if the quick wins are tempting.

Dependencies in one line:

```
001 ─┬─ 002 ─ 004
     └─ 003 ─ 012 ─ 013 ─ 014
006 ─┬─ 007 ─ 008
     └─ 018 ─ 022
005 ─ 021
011 ─ 016
009 ─ 010
015 ─ 012
019 ─ 016
```

## Verification and test conventions

- Start with the cheapest layer that can fail: a pure unit test, then a Rust
  test, then a UI suite.
- UI suites follow [AGENTS.md](../AGENTS.md#conventions-for-new-test-scripts):
  port as `argv[2]`, `Runtime.enable`, throw on `exceptionDetails`, one
  `PASS`/`FAIL` line per check, non-zero exit on failure, `ws.close()` and
  `process.exit` on both paths.
- Every new suite needs its own freshly launched instance and its own fixture.
  Do not batch unrelated suites against one window.
- Never delete the user's `settings.json` or `.window-state.json` to get
  first-run state. Run against a build with its own `identifier` or back the
  files up; AGENTS.md records the blast radius.
- Data-safety tests must kill only the process they launched and must own their
  WebView2 profile. A forced kill can corrupt the profile; prefer
  `taskkill /PID <pid>` (no `/F`) for a graceful close.
- Printing is platform-specific: Windows and Linux need separate manual checks;
  CDP cannot see the native print dialog.
- Update the test counts in `AGENTS.md` and `README` when a suite changes.

**Commands that will be used repeatedly**

```
npm run build
npm run lint
npm run format:check
npm run knip
npm run test:rust
npm run shortcuts
npm run tabs
npm run favorites
npm run html
npm run typst:preview
npm run paste
npm run image:syntax
npm run format:document
npm run export
npm test -- --only <layer>
.\scripts\test-close.ps1
```

## Known limitations — not backlog items

These are already documented; do not treat them as regressions unless the
documentation promises otherwise.

- AsciiDoc `include::` reads only the document's folder; `lines`, `tag` and
  `leveloffset` are not applied; includes are re-read on every render.
- The pandoc route cannot represent `[TOC]` or GitHub alerts; they arrive as
  literal text in DOCX/ODT/LaTeX.
- Typst's Document view drops layout containers (`#columns`, `#grid`, `#align`,
  `#stack`, `#place`, `#rect`, `#pad`) together with their content.
- PDF (Print) is a browser hand-off until GAP-009 removes the dependency.
- macOS is not published.
- The HTML guest has no same-origin storage, service workers or Web Workers.
- There is no WYSIWYG editing, image upload or community CSS theme format.

## In flight — do not duplicate

- **Link navigation** — `docs/plans/2026-10-24-link-navigation.md`. The resolver,
  editor gesture, context-menu item and the Rust `open_external` command were
  landing while this audit was written. Reuse them for GAP-018.
- **Image paste rules** — `docs/plans/2026-10-24-image-paste-rules.md`. The
  Rust validation, `${filename}`, extra HTML/Typst roots and the frontend
  notices were landing. GAP-016 starts after the Ctrl+click/data-src work.
- **Typst Reference** — landed in `src/content.ts`, `samples/typst-reference.typ`
  and the Help menu; use it as the syntax source for GAP-003.

## Open questions

1. **Recovery storage.** The application config directory beside
   `settings.json` (survives a renamed document) vs the document's folder
   (portable). Default: config directory, with a cap.
2. **Workspace search.** A Rust walker with `ignore` rules, or shell out to an
   installed `rg`? Default: in-process walker, no new runtime dependency.
3. **Print architecture.** WebView2 `PrintToPdf`/`ShowPrintUI` first, with the
   browser as fallback; Typst only for deterministic Typst output.
4. **Markdown dialect.** Adopt Typora's footnotes/sub/sup/highlight, or stay
   strictly GFM and document the limitation? Default: adopt, because pandoc
   already understands them.
5. **Second window.** Single-instance handoff only, or true multi-window?
   Default: handoff first; multi-window only if asked.
6. **Localization.** Portuguese first, or wait for a translator? Default: wait
   until P0/P1 are closed.

## Snapshot and maintenance

- The audit is static: no UI suite was run. Two `marked` behaviours were measured
  directly (front matter and footnotes/subscript).
- Evidence names symbols and files rather than line numbers, because line
  numbers move with every edit. Use the symbol as the locator and the quote as
  the confirmation.
- The working tree changed during the audit (link navigation, image paste,
  Typst Reference). Items marked **recheck** may have moved; verify before
  starting and close them as `done (invalid)` if so.
- Re-audit at each release: add new gaps, close fixed ones, keep the IDs stable.
- This file is not a substitute for a plan. When an item is picked up, write the
  plan in `docs/plans/YYYY-MM-DD-slug.md`, link it here, and let the plan carry
  the detailed steps.
