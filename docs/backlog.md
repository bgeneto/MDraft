# MDraft backlog — prioritized gaps

**Status:** living document, not a plan
**Audited / revised:** 2026-10-25, `0.4.7`; original audit `2a0f1be`,
rechecked during integration at `2647311`
**Basis:** [2026-10-25 backlog audit](backlog-audit-2026-10-25.md)
**Owner:** whoever picks an item up; update `Status` and add the plan/commit
**Related:** [plans](plans/README.md), [ADRs](adr/README.md),
[AGENTS.md](../AGENTS.md)

This is the map of product gaps, documentation drift and missing editor
capabilities, revised from the code audit and its accepted recommendations.
It is deliberately **not** an implementation plan: an item becomes a plan in
`docs/plans/` when it is picked up, and a durable
architectural decision becomes an ADR.

## How to use this document

1. Pick an item by priority and actual dependency. Do not start two items that
   touch the same foundation at once unless they are the same workstream.
2. Re-verify the evidence against the current tree. The linked audit records a
   snapshot and controlled probes, not a guarantee about subsequent changes.
3. Follow [AGENTS.md](../AGENTS.md#governance-and-workflow): a plan is required
   before code when the change refactors, touches more than three files, changes
   a command/settings/menu contract, or adds a dependency.
4. Implement, test at the cheapest layer that can catch the failure, update the
   reader docs and the counts in AGENTS.md, then set `Status` to `done` with the
   plan or commit hash. If later accepted slices remain, record the delivered
   slice and update the row to the next slice's priority/effort instead.
5. If an item is no longer true, close it as `done (invalid)` with the reason.
   Keep IDs stable. Completed items retain their historical record; new
   follow-ups get their own IDs rather than silently expanding a completed plan.

**Scope and ownership.** A row's priority and effort describe its **next slice**.
Later slices have their own priority in the item; a P0 fix does not promote its
whole feature family to P0. Effort includes validation and is provisional until
the implementation plan. Related items are not automatically prerequisites.
Each capability has one owner: Save All is GAP-004, lossy-write protection is
GAP-005, per-document spell language is GAP-020, and offline exports are GAP-033.

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
| GAP-004 | P1 | S/M | Data safety | Save All and bulk-save UX; cancellation-safe close delivered | open |
| GAP-005 | P1 | M | Data safety | Shared file classification and size policy; binary/lossy guard delivered | open |
| GAP-026 | P1 | M | Output | Browser-readable HTML and print output | in progress |
| GAP-027 | P1 | M/L | Testing | Lifecycle regression coverage and CI | open |
| GAP-032 | P1 | M | Data safety | Stronger pre-save disk revision validation | in progress |
| GAP-011 | P1 | M | Preview | Search inside the preview | open |
| GAP-012 | P1 | S | Documentation | Documentation truth pass | in progress |
| GAP-013 | P1 | S/M | Markdown | YAML front matter handling | open |
| GAP-017 | P1 | M | Platform | Reliable second-launch handoff and multi-file opening | in progress |
| GAP-019 | P1 | M | Preview | Working preview zoom and zoom-only reset | in progress |
| GAP-021 | P1 | M | Platform | UTF-16 round-trip; broader encoding support follows at P2 | open |
| GAP-006 | P2 | M/L | Workspace | Read-only folder tree before file management | open |
| GAP-007 | P2 | M | Workspace | Read-only cross-file search before multi-file Replace | open |
| GAP-008 | P2 | M | Workspace | Quick open over tabs, recents and favorites | open |
| GAP-009 | P2 | M/L | Output | In-app printing and direct PDF save | in progress |
| GAP-010 | P2 | M | Editing | Markdown table navigation and row operations first | open |
| GAP-014 | P2 | M | Markdown | Academic Markdown dialect | open |
| GAP-015 | P2 | S | Editing | Typewriter mode while typing | open |
| GAP-016 | P2 | M | Preview | Task toggling and Pages controls; conveniences follow separately | open |
| GAP-018 | P2 | M | Editing | Link authoring | open |
| GAP-020 | P2 | M | Platform | Spellcheck languages beyond en/pt | open |
| GAP-022 | P2 | M | Editing | Heading and document-relative path completion first | open |
| GAP-028 | P2 | M | Editing | AsciiDoc/Typst list and quote continuation | open |
| GAP-029 | P2 | M/L | Preview | Actionable compiler diagnostics | open |
| GAP-030 | P2 | M/L | Accessibility | Keyboard operation, modal focus and announcements | open |
| GAP-031 | P2 | L | Data safety | Optional bounded saved-version history | open |
| GAP-033 | P2 | M/L | Output | Self-contained offline HTML and print assets | open |
| GAP-023 | P3 | S/M | Polish | Small conveniences and persistence | open |
| GAP-024 | P3 | XL | Platform | UI localization | parked |
| GAP-001 | P0 | L | Data safety | Recover unsaved work — approved implementation | done |
| GAP-002 | P0 | M | Data safety | External-change guard — initial stat-based implementation | done |
| GAP-003 | P0 | M | Typst | Typst-aware commands — approved implementation | done |
| GAP-025 | P0 | M/L | Data safety | Preserve session identity and revisions across async operations | done |

P0/P1 rows come first; rows within a tier are not a strict execution order.
Completed rows retain the original priority and effort as historical information.
See [Suggested order](#suggested-order) for sequencing.

## Completed foundations

### GAP-001 — Recover unsaved work

**Priority:** P0 · **Effort:** L · **Workstream:** Data safety · **Status:** done
— plan `docs/plans/2026-10-24-p0-data-safety.md`; unit, release-build smoke and
a force-kill/relaunch probe all passed

**Historical evidence (before the completed plan).** `Auto Save` is opt-in
(`auto_save: false` in `settings.rs`), runs every 20 s, and `installAutoSave`
skips every session without a `path`.
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
  restored as a dirty tab, with its language and a sensible name.
- Edit a saved document with Auto Save off, kill, relaunch: both the on-disk
  version and the unsaved text are available; the reader chooses.
- After Save, Save As or Discard, no journal entry for that session remains.
- A crash during a journal write cannot leave a half-written file that blocks
  startup.
- No file is written next to the document.

**Validation record.** The completed plan records scheduler/store unit tests,
release-build smoke and a manual force-kill/relaunch probe. An automated
two-launch recovery suite is still GAP-027; it is not claimed as delivered here.
The 2026-10-25 audit reran `p0:unit` and `test:sessions` successfully.

**Remaining boundaries.** Recovery has a 700 ms debounce, a 16 MiB per-entry
limit and a 64-entry cap. It is a crash journal, not saved-version history.
Internal save/reload races are GAP-025; automated lifecycle coverage is GAP-027;
saved-version recovery is GAP-031; large-file handling is GAP-005.

**Risks.** Force-killing the app can corrupt the WebView2 profile (AGENTS trap).
The test must own its profile and only kill the process it launched. A stale
journal must never overwrite a newer disk file without the reader's choice.

**Related.** GAP-002, GAP-004, GAP-005, GAP-025, GAP-027, GAP-031.

### GAP-002 — Guard dirty buffers against external changes

**Priority:** P0 · **Effort:** M · **Workstream:** Data safety · **Status:** done
— plan `docs/plans/2026-10-24-p0-data-safety.md`; Reload, Keep mine and the
deleted-file Save-anyway path were exercised on a release build

**Historical evidence (before the completed plan).** `reloadChangedSessions`
starts with
`if (!session.path || session.dirty) continue;`. A dirty tab is left alone
silently, but `Auto Save` (every 20 s) and `Ctrl+S` write it back. If another
editor or a sync client changed the file meanwhile, the change is overwritten
without a prompt.

**Delivered scope.** Before an in-place save, and on the 2.5 s disk poll,
compare the remembered `mtime` and size. When a dirty
buffer's file changed on disk, notify and offer **Reload**, **Keep my version**
or **Save a copy**. Auto Save pauses for that session until the reader chooses.
Clean buffers keep the existing silent reload.

**Acceptance.**

- Change a file's size or modification timestamp externally while its tab is
  dirty: a visible notice appears within one poll interval; the next `Ctrl+S`
  requires a decision before overwriting.
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

**Validation record.** The completed plan records the pure classifier tests
and manual release-build Reload, Keep mine and deleted-file Save-anyway probes.
Automated orchestration and two-launch coverage belong to GAP-027.

**Accepted limits and follow-up.** The approved plan intentionally deferred
hashing and filesystem compare-and-swap. A different file with the same size
and `mtime` is classified as `unchanged`, not as a benign prompt; stat and write
are also separate operations. GAP-032 owns stronger pre-save disk validation.
GAP-025 owns races with edits and tab changes inside MDraft. Keep this completed
implementation record rather than treating it as a guarantee against all races.

**Related.** GAP-001, GAP-004, GAP-025, GAP-027, GAP-032.

### GAP-003 — Make Paragraph/Format commands Typst-aware

**Priority:** P0 · **Effort:** M · **Workstream:** Typst · **Status:** done —
plan `docs/plans/2026-10-24-p0-data-safety.md`; Typst 0.15.1 compiled every
emitted construct

**Historical evidence (before the completed plan).** `setHeadingCommand`,
`quoteCommand`, `listCommand`, `tableCommand`, `tocCommand`, `frontMatterCommand`,
`alertCommand` and `inlineCommand` had branches for HTML and AsciiDoc but none
for Typst. They fell through to Markdown:

| Command | Inserted before the fix | Typst expects |
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

Before that fix, Heading 1 inserted `# Title`, which could stop Typst compiling;
ordered-list insertion produced `1.`, which Typst does not read as a list.
Image insertion already had its own Typst branch.

**Delivered scope.** Pure Typst strings and line transforms own the Typst side
of the commands. `main.ts` retains language dispatch; supported commands insert
correct syntax. Unsupported task lists, alerts and YAML front matter show an
explanatory toast. The menu reorganization of 2026-10-25 now also disables those
items in a Typst document; the handler guards remain for stale menus and
keyboard routes. A single cross-language command table feeding menus and Help was
not implemented or required by that plan.

**Acceptance.**

- Supported Paragraph/Format commands in a `.typ` document insert valid Typst
  that compiles in the installed compiler.
- Unsupported items explain the limitation without changing the document; no
  command inserts Markdown syntax into Typst.
- Markdown, AsciiDoc and HTML output is byte-for-byte unchanged.
- The Typst Reference reflects supported syntax. Remaining shortcut-sheet/key
  mismatches are owned by GAP-012, not claimed as completed here.

**Resolution.** `src/typst-commands.ts` owns the heading/paragraph/shift line
transforms and the quote/table/rule/TOC/inline/display-math strings;
`editor.ts` gained the Typst heading transforms; `main.ts` dispatches every
Paragraph/Format item to a Typst branch or to an explanatory note. No Markdown
syntax remains on an enabled Typst path.

**Validation record.** The completed plan records pure Typst command checks
and compilation of emitted constructs with Typst 0.15.1. Preserve that record;
future UI/command changes need their own relevant regression coverage.

**Risks.** Typst syntax changes between compiler versions; pin the minimum
version the app supports. Do not "fix" an unsupported construct with a lookalike
that silently renders differently.

**Related.** GAP-012, GAP-016, the Typst Reference in
`samples/typst-reference.typ`.

## Existing gaps — stable ID order

### GAP-004 — Three-way close prompt and Save All

**Priority:** P1 · **Effort:** S/M · **Workstream:** Data safety · **Status:** open

**Slices.** P0 delivered: cancellation-safe tab, bulk and window close. P1 next: a separate
Save All command and bulk-save UX (S/M). Save All is owned here, not GAP-023.

**Plan:** [Open P0 document safety](plans/2026-10-25-open-p0-document-safety.md)
— approved on 2026-10-25; P0 slice delivered. Save All remains open.

**Historical evidence (before this P0 slice).** `confirmDiscard`, `closeSession` and `installCloseGuard` used the
native two-button `ask("Save them first?")`. There was no Cancel: closing the
dialog or choosing No discarded. Several dirty tabs produced one prompt each, and
there was no **Save All**. The separate Save All command is still missing.

**Delivered P0.** `unsaved-dialog.ts` offers explicit Save/Discard/Cancel;
Escape, dismissal and window close while prompting cancel. `document-lifecycle.ts`
waits for pending saves, revalidates accepted revisions and commits bulk discards
only after all decisions succeed. Failed/cancelled saves retain tabs and recovery.
The short commit phase restores editor focus afterward; native WM_CLOSE remains
covered on Windows and native window deletion on Linux/GTK.

**Target.** A dialog with **Save**, **Discard** and **Cancel**, plus **Save All**
in the later bulk-save slice when more than one buffer is dirty.
Escape and the window close button cancel the operation. The native close path
still runs when the reader confirms.

**Acceptance.**

- Cancel leaves the tab or the window open, with every buffer intact.
- Escape and dialog dismissal cancel; only an explicit Discard clears recovery
  without saving. Cancelling Save As or a failed save aborts closing.
- Save writes the initiating session and closes only the saved revision; new
  edits made during the operation remain protected (GAP-025).
- In the P1 slice, Save All is available without closing anything, writes every
  dirty buffer with a path, asks for untitled paths, and honors conflicts/errors.
- The close prompt names the document and the number of dirty buffers.
- `test-close.ps1` still proves the release binary exits and writes
  `.window-state.json`.

**Tests.** UI suite for tab and window close; `test-close.ps1`; capability check
if the modal uses a new command.

**Risks.** The window is closing while a modal is open; the native close must not
race the prompt. Keyboard focus and screen-reader labels need the same care as
the editor menu.

**Related.** GAP-001, GAP-002, GAP-025, GAP-027.

### GAP-005 — Refuse binary/non-text files on open and drop

**Priority:** P1 · **Effort:** M · **Workstream:** Data safety · **Status:** open

**Slices.** P0 delivered: refuse binary input and prevent lossy rewrites.
P1 next: shared classification/opening UX and an explicit large-file policy (M).
GAP-021 owns supported encoding round-trips, not a second lossy-write guard.

**Plan:** [Open P0 document safety](plans/2026-10-25-open-p0-document-safety.md)
— approved on 2026-10-25; P0 slice delivered. Classification/size UX remains open.

**Historical evidence (before this P0 slice).** `File › Open` offers **All files** and passes every path to
`openPath`; `installDragDrop` passes every non-image path to `openPath`;
`read_document` decodes any bytes with `String::from_utf8_lossy` and only shows a
toast afterwards. Opening a PDF, DOCX, ZIP or image through the dialog creates a
tab of replacement characters, and saving rewrites the original file. Link
navigation now routes recognized editable extensions through `openLinkTarget`
and other targets through the OS opener.

**Delivered P0.** Rust validates bytes before decoding: binary signatures,
NUL/non-text controls and invalid UTF-8 are refused; UTF-16/32 BOMs receive an
encoding explanation. Existing write destinations receive the same guard.
Legacy lossy recovery remains journaled; Auto Save pauses and manual save offers
an acknowledged UTF-8 copy to a different path. BOM/EOL text round-trips and image
import remain covered. This does not implement size thresholds or new decoders.

**Target.** A `FileKind` classifier used by Open, drop and link opening:
`text` (editable), `image` (import/drop), `binary` (refuse or open with the OS),
`too_large` (warn or refuse), `missing`. Text detection checks a BOM, UTF-8
validity and NUL bytes. Retain the delivered refusal policy and explicit UTF-8
copy route for legacy lossy recovery; broader decoding belongs to GAP-021.

**Acceptance.**

- Opening or dropping a PDF/DOCX/ZIP/image does not create a text tab; images
  still import, and other binaries go to the OS opener (subject to the
  executable refusal) or are refused with a message.
- A UTF-16 BOM is recognized as text in an unsupported encoding, not mislabeled
  binary or opened lossily. Until GAP-021 ships, refuse it with a clear encoding
  explanation; afterward route it through the supported decoding path.
- A legacy lossy buffer can only be saved to an explicitly acknowledged UTF-8
  copy at a different path; the original remains protected.
- The guard covers manual save, Auto Save, Save As, close-save and recovered
  buffers; dismissing a warning never authorizes conversion. A minimal P0 fix
  may refuse unsupported input rather than implement a picker.
- Dropping several files imports the images and opens the editable documents,
  ignoring the rest.
- In the P1 slice, check file size before an unrestricted read, set tested
  warn/refuse thresholds, and keep a large-file refusal responsive. Explain when
  an editable buffer exceeds recovery's 16 MiB ceiling; never imply it is journaled.
- Measure representative large-document open/edit/render behavior and cancellation;
  record a responsiveness budget in the plan rather than assuming virtualization
  makes whole-document rendering cheap.

**Tests.** Rust unit over byte fixtures (PNG, PDF, ZIP, UTF-8, UTF-16 BOM, NUL
text); UI with temporary files and the drop event.

**Risks.** False positives for UTF-16/UTF-32 and for text with a stray NUL;
false negatives for PDFs whose header is not at byte 0. Detect a BOM first, then
sniff the first block, then validate UTF-8.

**Related.** GAP-021, `open_external` in `documents.rs`.

### GAP-006 — Read-only folder tree before file management

**Priority:** P2 · **Effort:** M/L · **Workstream:** Workspace · **Status:** open

**Slices.** First: Open Folder and a read-only tree. Later P2: file management,
recent folders and detailed expansion persistence, estimated separately. Promote
the first slice to P1 only when folder-based writing is the agreed next product
focus; it does not outrank the safety/output fixes by default.

**Evidence.** The sidebar has only Outline, Favorites and Recent. `documents.rs`
has no directory-listing command. There is no workspace folder state in settings.

**Target.** **File › Open Folder…** adds a workspace. The sidebar gets a lazy
file tree for supported documents, with the active tab highlighted and Open /
Reveal actions. List children lazily and share listing/filtering with later
folder search and path completion. Do not require a full recursive index just
to display the tree.

**Acceptance.**

- Open a folder, expand it, click a file: it opens in a tab and the tree marks
  the active file.
- The tree skips hidden, ignored and binary files by default; a toggle shows
  everything.
- A folder with 10,000 entries remains usable (lazy children, no full recursive
  walk on open).
- The chosen folder can be closed; a missing/unreadable folder explains itself.
- Tree browsing is read-only and makes no application-initiated network requests.
- Later file management gets separate acceptance for New File, Rename, Move and
  confirmed Delete. Define unsaved-tab conflicts and how relative images,
  links and includes are rebased/copied or retained with a warning, including
  Save As to another directory. Never silently break references or overwrite
  dirty documents. Deletion must have an explicit recoverability policy.
- Remembering recent folders and expanded state is a later slice; restoration
  explains missing folders and keeps old settings loading.

**Tests.** Rust unit for listing/filtering and path confinement; UI with a
temporary tree containing nested folders, spaces, accents, a symlink and a
binary. `npm run tabs` and `npm run favorites` stay green.

**Risks.** Huge folders, slow network shares, symlink loops, Windows long paths
and permissions. Never walk the whole drive; never follow a symlink outside the
workspace without asking.

**Related.** GAP-007, GAP-008, GAP-018, GAP-022.

### GAP-007 — Read-only cross-file search before multi-file Replace

**Priority:** P2 · **Effort:** M · **Workstream:** Workspace · **Status:** open

**Slices.** First: search open tabs (M); then folder search (M/L) using shared
listing/filtering. Multi-file Replace is a separate later P2 slice (L) with its
own preview, revision validation and undo/recovery design.

**Evidence.** `Ctrl+F` searches the focused editor only. There is no command to
search a folder, no results panel, and no replace across files.

**Target.** A search panel over current open buffers, including unsaved edits,
or over a chosen folder: query, case, whole word and bounded regex; folder
search adds include/exclude rules. Results are grouped by file with line
previews; a click reveals the match. The first slices do not write files.

**Acceptance.**

- Open-tab search includes dirty and untitled buffers without reading stale
  disk text. Folder search excludes binaries/ignored paths, handles Unicode and
  documents its case/normalization rules; results are ordered consistently.
- Clicking a result opens the tab at the right line and column.
- In the later Replace slice, list files/counts before writing; Cancel changes
  nothing. Define exact undo/recovery for open and initially closed documents,
  changed/deleted files, encoding, partial failure and interrupted writes before
  enabling the command.
- A cancelled or superseded search stops doing work.
- No result is returned from a file that changed after the snapshot without a
  warning.

**Tests.** Rust unit for walking/filtering and caps; UI with a fixture tree;
replace tested on a copy. `npm run tabs` and `npm run paste` stay green.

**Risks.** Regex denial of service, binary files, encodings, very large results.
Cap results and file size, abort on cancel, and run the search off the UI thread.

**Depends on.** No folder tree is needed for open-tab search. Folder search
needs shared listing/ignore/encoding rules, which can be built with GAP-006
without requiring its visual tree. Replacement requires GAP-005, GAP-025 and
GAP-032 protections and a separate approved plan.

**Related.** GAP-006, GAP-008, GAP-021.

### GAP-008 — Quick open over tabs, recents and favorites

**Priority:** P2 · **Effort:** M · **Workstream:** Workspace · **Status:** open

**Evidence.** There is no quick-open picker, no command palette and no
go-to-file by name. `Ctrl+P` now belongs to Print (GAP-009), so Quick Open must
choose another accelerator. Recent and Favorites are the only shortcuts to a
path.

**Target.** A fuzzy picker over open tabs, recents and favorites first; folder
files can follow when listing/indexing exists. Enter opens or activates the
highlighted document; Escape restores focus; recent choices rank first.
Print owns `Ctrl+P` (GAP-009); Quick Open needs another accelerator. Command
palette and line-prefix navigation are optional later increments, not
prerequisites for quick open.

**Acceptance.**

- Type a partial name with accents/spaces and open the file; the picker is
  keyboard-only and does not steal typing from the editor when closed.
- The picker works without a folder, includes untitled tabs, deduplicates saved
  paths, and clearly identifies its source/scope. A future folder-only filter
  does not silently include outside files; recents/favorites may be outside it.
- The picker does not duplicate an already open tab; it activates it.

**Tests.** Unit for the fuzzy ranker; UI with a temporary tree; keyboard-only
path including Escape and IME.

**Risks.** Rebuilding the index on every keystroke; stale index after a rename;
conflict with a future Print shortcut. Keep the first slice independent of a
recursive file index; debounce later folder queries and invalidate stale paths.

**Depends on.** None for tabs/recents/favorites; shared folder indexing only for
the later folder slice. No dependency on GAP-007's search UI.

**Related.** GAP-006, GAP-007, GAP-022.

### GAP-009 — In-app printing and direct PDF save

**Priority:** P2 · **Effort:** M/L · **Workstream:** Output · **Status:** in progress — native PDF and the Windows/Linux PDF path are implemented and visually validated; the Linux print dialog still needs a desktop confirmation.

**Plan:** [Native print and direct PDF with visual quality gates](plans/2026-10-25-native-print-pdf.md)
— approved and implemented. It covers the hidden print surface, Windows WebView2
and Linux WebKitGTK paths, the browser fallback, and the Poppler-based visual
PDF validation for Windows and Debian/WSL2.

**Implementation.** `File › Print…` (`Ctrl+P`) opens the platform dialog and
`File › Export › PDF…` writes the file directly. The hidden surface has no
capability entry and no document scripts; static HTML prints natively, while
scripted HTML keeps **PDF (opens browser)…** as an explicit fallback. Typst
keeps **PDF (via Typst)** and disables the other two rows with a reason.
`scripts/pdf-native-test.mjs` exports a real PDF and runs
`scripts/pdf-visual-check.mjs`; the fixture covers image colours, table rules,
KaTeX fractions and radicals, a light Mermaid diagram and two A4 pages.

**Before this change.** `File › Print (opens browser)…` wrote a temporary HTML
and opened the system browser; `Export › PDF (via Typst)` needed pandoc and
Typst for Markdown conversion; a `.typ` PDF was compiled directly by Typst. The
browser route supported printing and Save as PDF, but did not call native
WebView2 printing, and MDraft did not learn the final PDF path, completion or
cancellation.

WebView2 exposes `ShowPrintUI` and `PrintToPdf`, as described in
[Microsoft's printing documentation](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/print).
The observed `window.print()` limitation in this embedding does not mean the
host APIs are absent. Correct the broader repository claims under GAP-012.

**Target.** **File › Print…** opens the platform print UI for Markdown, AsciiDoc
and HTML. **File › Export › PDF…** writes a PDF without a browser where the host
supports it (WebView2 `PrintToPdf`; WebKitGTK print API), with the browser path
as a fallback. Reuse the corrected export document from GAP-026. A visible
File > Print entry can be a small earlier slice using that browser route;
it does not require a new renderer. Resolve its accelerator with GAP-008.

**Non-scope.** Missing images/links and dark diagrams in the current output are
GAP-026 (P1); offline KaTeX/assets are GAP-033 (P2). Neither should wait for
native integration. Promote this item only if handoff itself blocks users.

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

**Related.** GAP-008, GAP-012, GAP-026, GAP-033, `export.rs`, `markdown.ts` print wrapper.

### GAP-010 — Markdown table navigation and row operations first

**Priority:** P2 · **Effort:** M · **Workstream:** Editing · **Status:** open

**Slices.** First: Markdown Tab/Shift+Tab and add/remove row. Later P2 (L for
the broader feature): column operations, alignment and moves; AsciiDoc next,
HTML only after separate scoping. Native print is not a prerequisite.

**Evidence.** `tableCommand` inserts a fixed template. There is no table parser,
no row/column operation, no alignment control and no cell navigation. Format
Document aligns existing columns with Prettier, but editing is manual.

**Target.** Parse the table under the caret and serialize only the edited block
without losing cell text. The first slice drives add/delete row and cell
navigation. Later operations reuse that model. Typst tables are `#table` code
and remain outside this item until explicitly scoped.

**Acceptance.**

- Operations work on a table with escaped pipes, inline code, links and
  alignment markers; cell text is never lost.
- `Tab` at the last cell adds a row or moves to the next logical cell, depending
  on the chosen convention (document it).
- One undo restores the exact original bytes.
- A document with no table still gets the template.
- Format Document and table editing do not fight: formatting a table is
  idempotent after an edit.

**Tests.** Unit for parse/serialize and each shipped operation; UI on Markdown
first, AsciiDoc when added; `npm run format:document` stays green.

**Risks.** Escaped pipes, multi-line cells, alignment rows, CRLF, tables inside
blockquotes or lists. Parse only the contiguous table block and fail closed
rather than rewriting a malformed table.

**Related.** GAP-014, `format/formatters.ts`.

### GAP-011 — Search inside the preview

**Priority:** P1 · **Effort:** M · **Workstream:** Preview · **Status:** open

**Slices.** First: visible, mode-aware Find for the DOM preview. Add HTML guest
and Typst Pages search in separate P1 increments, estimated per renderer.
Replace reveals/targets source; it never edits rendered output directly.

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
- In Preview-only, Find and Replace reveals the editor and its replace panel
  or offers a clear source-editing route; it never opens an invisible panel.
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
typewriter claims in `docs/guide.md`; the menu reorganisation of 2026-10-25
fixed the built-in shortcut table and the guide's menu names. The AsciiDoc/Typst
Enter sentence and some Preferences notes remain.

**Evidence.** The menu reorganisation corrected the shortcut table and the
headings, lists, maths, typography and print paths across Help, the guide, the
README and the export document. Remaining stale claims:

- `src/content.ts`: "`Enter` continues lists and quotes" is true only in
  Markdown; AsciiDoc and Typst install no continuation keymap.
- `src/preferences.ts`: "Math and diagram settings above apply to Markdown and
  Typst" — they apply to Markdown and AsciiDoc; Typst compiles its own.
- `src/preferences.ts`: "YAML front matter [is] always enabled" (GAP-013).
- `main.ts`, `export.rs` and `docs/guide.md` say WebView2 has no print interface;
  native host APIs exist, while MDraft currently uses browser handoff (GAP-009).
- Export comments still describe a large LaTeX installation as the standard
  alternative even though the built-in PDF engine is now Typst.

**Target.** One pass over `README.md`, `docs/guide.md`, `docs/export.md`,
`src/content.ts`, export comments and the preference help strings. Every
shortcut in Help is registered and behaves; every capability sentence is either
tested or removed.
Add a test that compares the shortcut table with the `accelerators` registry, so
the two cannot drift again.

**Acceptance.**

- `npm run shortcuts` (or a new unit) fails when a documented accelerator is not
  registered, or is registered with a different key.
- Help, menu and guide list the same shortcuts.
- The stale sentences above are gone or state the real limitation.
- Capability claims distinguish implemented behavior, approved deviations and
  future scope; the backlog agrees with completed plans and the audit record.
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

**Evidence.** `Insert › Document Metadata` (labelled `YAML Front Matter` in
Markdown) inserts:

```markdown
---
title:
date:
---

```

`renderPreview` has no front-matter handling. Measured with the bundled
`marked`, this renders as `<hr>` plus `<h2>title: \ndate:</h2>`. Preferences says
YAML front matter is "always enabled". Pandoc reads the block as metadata, so
preview and export disagree. GAP-003 already prevents YAML insertion in Typst
by explaining the unsupported command; that is completed behavior.

**Target.** Recognize a leading `---` block only when it closes with `---` and
contains `key: value` lines. Hide it from the preview, or render a small
metadata card (choose one and document it). Headings, `[TOC]` and word sync
ignore the block. Keep source metadata in source-oriented exports and pandoc
input; rendered HTML/Print must not print raw YAML as body text. Do not change
the completed Typst guard as part of this Markdown fix.

**Acceptance.**

- The inserted block no longer produces an `<hr>` and a heading in the preview.
- A genuine horizontal rule at the top of a document is still a rule.
- `[TOC]` does not list front-matter keys.
- Word sync maps the body correctly around the block.
- The source and the pandoc input keep the block; the native HTML/PDF output
  does not print it as body text.
- The existing Typst explanatory no-op remains intact.

**Tests.** Unit for `renderPreview` with valid, empty and malformed front matter;
smoke fixture; `npm run export`; `npm run typst:preview` for the Typst command.

**Risks.** Hiding a real rule; treating a `---` separator in prose as metadata;
CRLF. Fail closed: show the block rather than hide content that is not clearly
front matter.

**Related.** GAP-014, GAP-012.

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

**Priority:** P2 · **Effort:** M · **Workstream:** Preview · **Status:** open

**Slices.** Task toggles and basic Pages navigation are independent P2 slices
(estimate each). Code-copy, image lightbox, resize/alt helpers and math-copy
menus are later P3 conveniences. Do not make any of
them wait for a complete preview-search implementation.

**Evidence.** Task-list checkboxes are forced `disabled` by `normalizeInputs`.
There is no image lightbox, resize syntax or alt editor. Code blocks have no
copy button; formulas have no copy-TeX menu. Typst Pages has no toolbar, zoom,
page navigation or outline (the 2026-10-18 plan lists them as non-scope).
Ctrl+click image opening and preservation of the original `data-src` are now
implemented by the completed link/image work; do not reimplement them.

**Target.** Split into independently shippable sub-items:

1. **Task lists** — clicking a checkbox toggles the matching source marker, one
   undo step, only when the document is editable.
2. **Images** — a lightbox and a width/height insertion helper; keep the
   existing Ctrl+click open.
3. **Code** — a copy button on fenced blocks.
4. **Math** — copy TeX / copy MathML from a context menu.
5. **Pages** — a minimal toolbar: zoom, page number, previous/next page.

**Acceptance.** Each sub-item ships with its own check and estimate. Task
toggle changes the correct marker in one undo step, paints nothing from stale
source, and never edits a read-only buffer. Pages controls work across lazy
pages and have keyboard labels. Copy/resize/alt features preserve the original
code, formula or alternative text, and lightbox dismissal restores focus.

**Tests.** UI per sub-item; `npm run html`, `npm run typst:preview`, `npm run
word-sync` stay green; source bytes unchanged after clicking a checkbox twice.

**Risks.** Editing source from the preview must be undoable and must respect
word-sync mapping; the HTML guest is sandboxed; PDF.js text layers are not DOM
anchors.

**Related.** GAP-011, the image plan, the link plan.

### GAP-017 — Reliable second-launch handoff and multi-file opening

**Priority:** P1 · **Effort:** M · **Workstream:** Platform · **Status:** in progress

**Plan:** [Reliable second-launch handoff and multi-file opening](plans/2026-10-25-single-instance-handoff.md)
— Phase 1 approved 2026-10-25 and delivered. Phase 2 (association
registration) remains open, with its own approval gate.

**Delivered (Phase 1).** `tauri-plugin-single-instance` is registered first,
turns a second launch into a path list resolved against the launching `cwd`,
queues it, emits `open-files`, and focuses the existing window before the second
process exits. `startup_files` opens every initial path as a tab (the first
fills the window, the rest are added); `take_forwarded_paths` drains launches
that arrive before the webview listener exists. The frontend serialises path
opening, reports a missing path as a toast without blocking the valid ones, and
focuses an already open document. Windows validation: 12/12 UI checks covering
two initial tabs, a relative second launch, second-process exit, one page
target, duplicate focus, a missing path and a dirty buffer surviving.

**Slices.** P1: single-instance path handoff and initial multi-file argv.
Optional file-association registration is P2, explicitly scoped and estimated.
True multi-window is separate P3 / parked work unless requested; it is not a
prerequisite for reliable file opening.

**Evidence.** There is no single-instance plugin and no `New Window` command.
AGENTS.md records that a second copy with the same identifier fails to create its
WebView2 environment (`0x800700AA`) while another MDraft window is open. Opening
a second file from Explorer therefore has no reliable path into the running
window. `documents.rs::startup_file` consumes only the first argv path; the
bundle config registers no file associations today.

**Target.** Single-instance handoff: a second launch forwards its paths to the
existing window and exits. An initial launch accepts every supported path,
deduplicates tabs and reports individual failures. Association registration,
if adopted, must be an explicit product choice rather than an assumed existing
installer capability. A future New Window needs separate settings/recovery/tab
ownership and its own plan.

**Acceptance.**

- With MDraft open, launch MDraft with a second document (or use an existing OS
  association): the existing window comes forward and opens a tab; no second
  process remains. Do not claim installer associations until the P2 slice ships.
- Launching from a terminal with a path does the same.
- Initial and subsequent launches with several paths open each once, preserve
  existing dirty buffers, and report a missing/unsupported path without dropping
  the valid ones. Test installed and portable builds independently.
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

**Already available.** Link navigation, `linkAt`, `openLinkTarget`, editor
gestures and the contextual Open action are implemented. This item owns authoring.

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
the registered link-navigation suite (`scripts/link-navigation-test.mjs`)
and `npm run paste` stay green.

**Risks.** Source offsets after a selection change; link vs image syntax; nested
brackets; a dialog that steals focus from the editor.

**Depends on.** Reuse the completed link resolver. A native file picker and
current-document heading picker need no workspace; only optional workspace
suggestions share GAP-006's listing/indexing.

**Related.** GAP-022, `src/links.ts`, the link-navigation plan.

### GAP-019 — Working preview zoom and zoom-only reset

**Priority:** P1 · **Effort:** M · **Workstream:** Preview · **Status:** in progress

**Plan:** [Working preview zoom and zoom-only reset](plans/2026-10-25-preview-zoom.md)
— approved 2026-10-25 and delivered for Windows. It covers the shared zoom
state and the DOM, HTML guest and Typst Pages renderers.

**Delivered.** One persisted `zoomLevel` (50–300 %, 10 % steps, default 100)
scales the editor in Source-only, both panes in Split and the rendered document
in Preview-only. Markdown/AsciiDoc/Typst Document use CSS zoom on `#preview`
with a separate zoomed Content Width cap; the HTML guest iframe scales with its
internal viewport narrowed; Typst Pages multiplies its PDF.js fit, re-rasters the
canvases, allows horizontal scrolling above 100 % and keeps the reader's place.
The Typst Document/Pages bar moved outside the zoomed content. The menu is
`Zoom / Zoom In / Zoom Out / Reset Zoom`, enabled in Preview-only; the chip shows
the percentage and hides at 100 %. Reset changes only the zoom. Windows
validation: 24/24 zoom checks plus menu 87, shortcuts 43, smoke 108, word-sync
58, html 60, asciidoc 54, tabs 107 and typst-preview 52; Rust 140 passed.
WebKitGTK/high-DPI inspection remains.

**Slices.** The reset that preserves Content Width is already true in the
current tree (`view.zoomReset` writes only `editorFontSize`). Working preview
zoom is M across DOM, HTML guest and Typst Pages; ship renderer support in
explicit increments rather than estimating the whole feature as S.

**Evidence.** `view.zoomIn/Out` change only `editorFontSize`; the reset comment
now deliberately preserves `editorMaxWidth`, which is the delivered S fix. In
Preview-only the zoom does nothing visible, and the native menu disables the
zoom items in that mode. The status chip still says "Font size" and derives its
percentage from the editor font size rather than a view-zoom level.

**Target.** Zoom has a visible effect in the active document view, including
Preview-only, and reset changes zoom only. Content Width remains a separate
preference. Decide shared versus independent pane zoom in the plan; select a
scaling mechanism only after validating layout, PDF resolution and source sync.

**Acceptance.**

- In Preview-only, `Ctrl+Shift+=` enlarges the rendered text and images.
- In Split, the documented pane policy is visible/predictable; line wrapping,
  selection and source/preview mapping remain usable. Toolbar UI stays operable.
- Reset returns to 100% without touching Content Width.
- The chip shows the current percentage and hides at 100%.

**Tests.** UI geometry (not computed font-size, which CSS zoom leaves unchanged)
in both modes; a zoomed word sync and PDF page; screenshot at 150%; `npm run
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
This item owns the per-document language feature; GAP-023 must not duplicate it.

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

### GAP-021 — UTF-16 round-trip, then broader encoding support

**Priority:** P1 · **Effort:** M · **Workstream:** Platform · **Status:** open

**Slices.** P1: BOM-detected UTF-16LE/BE open/save round-trip. P2 (M): broader
encodings, including Windows-1252, and Reopen with Encoding. GAP-005 owns the P0
guard against unconfirmed lossy rewrites across every save path; reuse it.

**Evidence.** `read_document` decodes every file as UTF-8 lossily, records
`lossy`, and warns after opening; saving rewrites the bytes. UTF-8 BOM and EOL
preservation are already implemented. There is no other encoding
picker, no UTF-16 detection and no "Reopen with Encoding".

**Target.** Detect a BOM (UTF-8/UTF-16LE/BE), validate UTF-8, and fall back to an
encoding picker (UTF-8, UTF-16, Windows-1252 at minimum). Remember the chosen
encoding per document; save in the same encoding; preserve BOM and EOL.
The P1 slice may continue refusing unsupported encodings under GAP-005 while
the later picker is unavailable. Never bypass that guard in Auto Save or recovery.

**Acceptance.**

- Open a UTF-16 file with a BOM: it opens correctly and saves back as UTF-16
  with the same BOM.
- In the P2 slice, open a Windows-1252 file: the picker offers it, the text is
  correct, and saving does not replace accents with `?`.
- In the P2 slice, Reopen with Encoding changes decoding without touching disk;
  dirty-buffer handling uses an explicit cancellation-safe decision.
- The status bar shows the encoding in use.
- A file with mixed/invalid bytes never silently becomes valid UTF-8 on save.

**Tests.** Rust unit over byte fixtures; UI with temporary files; round-trip
byte comparison; `npm run test:rust`.

**Risks.** A new dependency (`encoding_rs` or similar) needs a plan; heuristic
detection can be wrong; invalid sequences in the middle of a file. Prefer BOM,
then valid UTF-8, then the reader's choice.

**Related.** GAP-005.

### GAP-022 — Autocomplete for paths, headings and includes

**Priority:** P2 · **Effort:** M · **Workstream:** Editing · **Status:** open

**Slices.** Current-document headings first, then document-relative paths and
includes, then optional workspace-wide suggestions/snippets. Estimate each
increment; a folder tree is not required for the first two.

**Evidence.** `@codemirror/autocomplete` is used only for `closeBrackets`. There
is no completion for image paths, link targets, headings or `#include`/
`include::`.

**Target.** Context-aware completion sources:

- image/link paths relative to a saved document, with optional workspace results later;
- heading targets (`#…`) in the current document;
- `#include`/`include::` paths;
- snippets for table/front matter/code fence.

Do not offer prose snippets in arbitrary code, fenced examples or math. Explicit
language contexts such as Typst `#image("…")` and `#include "…"` strings and
AsciiDoc `include::` are supported completion contexts even though they are
code-like. Accept with Enter/Tab, dismiss with Escape, respect IME composition,
and never block typing while paths load.

**Acceptance.**

- Type `#image("` in Typst or an image/link destination in Markdown: a filtered
  file list appears. Typing alternative text alone does not trigger path completion.
- Type `](#`: headings from the current document appear.
- Type `include::`: paths relative to the document appear, with the same jail
  as the preview.
- No unrelated completion appears in a fenced example, math or after a currency
  `$`; supported image/include string contexts still receive path suggestions.
- The list is keyboard-navigable and does not steal focus from the editor.

**Tests.** Unit for each completion source; UI on Markdown/Typst/AsciiDoc;
`npm run autoclose` and `npm run paste` stay green.

**Risks.** Noisy suggestions, index latency, IME composition, a completion that
inserts a path the preview cannot read (custom folder/Typst root). Reuse the
workspace index and the image root rules.

**Depends on.** None for current-document headings. Document-relative paths
need bounded directory listing and existing preview root rules, not a visual
tree. Workspace suggestions may share GAP-006/007's index when available.

**Related.** GAP-006, GAP-007, GAP-018.

### GAP-023 — Small conveniences and persistence

**Priority:** P3 · **Effort:** S/M · **Workstream:** Polish · **Status:** open

**Evidence / target.** Independent small items; pick them in batches:

- **Reopen Closed Tab** (`Ctrl+Shift+T`), preserving the appropriate buffer state.
- **Copy Path** from the tab menu. Rename/Move and relative-reference behavior
  are owned by GAP-006's later file-management slice, including Save As rebasing.
- **Word wrap** and **line numbers** toggles (today always on).
- **Selection statistics** (words/characters) and reading time in the status
  tooltip.
- **Read-only toggle** for a buffer.
- **Persist sidebar width and editor/preview split** (the guide says they are
  not persisted today).
- **Reset preferences** and **Open settings folder** in Preferences.

Save All is GAP-004 (P1). Per-document spell language is GAP-020 (P2). Keep this
item for independently scoped conveniences, not higher-priority duplicates.

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

## Additional gaps from the 2026-10-25 audit

### GAP-025 — Preserve session identity and revisions across async operations

**Priority:** P0 · **Effort:** M/L · **Workstream:** Data safety · **Status:** done

**Plan:** [Open P0 document safety](plans/2026-10-25-open-p0-document-safety.md)
— approved on 2026-10-25; delivered with the ownership ADR and regression coverage.

**Historical evidence.** Controlled deferred-IPC probes against `main.ts` reproduced three
failures: `writeSession` marks newer unsaved typing clean and forgets recovery;
`reloadChangedSessions` replaces typing that happened during a pending read;
`saveAs` uses mutable global `doc` after awaits and can assign tab A's saved
path/content to tab B. See the audit for the probe boundaries.

**Resolution.** Sessions carry runtime revisions. The lifecycle controller
serializes saves per session/destination, adopts the exact written baseline,
journals newer typing and rejects stale reloads. Save As captures its initiating
session, preserves the active tab and refuses another open tab's destination.
Close decisions revalidate snapshots before cleanup. HTML, Print and Pandoc
exports capture text/name/path/language/resource base before their first await;
picker, tool and renderer delays cannot substitute another tab's content.
Rust writes through unique, exclusively created temporary siblings.

**Validation record.** The completed plan records 99/99 P0 unit checks,
30/30 real-UI lifecycle checks, Rust tests on Windows/Linux, native GTK and
WM_CLOSE checks, export/format regressions and the pre-existing global-format
limit. All nine new export assertions also fail against the original HEAD.

**Target.** Bind operations to their initiating session, destination and text
revision. Serialize saves that can compete; revalidate state before applying a
read or clearing dirty/recovery state. Review reload, close and export paths
for the same identity/revision problem. The external-writer race is GAP-032.

**Acceptance.**

- Type while a save is pending: the saved snapshot becomes the disk baseline,
  while newer text stays dirty, visible and journaled. A later save persists it.
- Type while a clean-buffer disk read is pending: the response cannot replace
  those edits or clear recovery; a real external conflict remains visible.
- Switch A to B during Save As, including between write and read-back: only A
  acquires the chosen path; B's text, metadata and recovery are unchanged.
- Concurrent manual/Auto Save cannot complete out of order, reuse a temporary
  destination unsafely or falsely clear dirty state. Failure preserves unsaved
  text; closing during a pending save cannot discard a newer revision.
- Related async reload/export operations retain the initiating session and
  source snapshot; tab changes cannot redirect the operation to another buffer.

**Tests.** Deterministic delayed reads/writes, overlapping saves, tab switches,
write failures and recovery cleanup; real UI probes with isolated files/profile.
Use `p0:unit`, `test:sessions`, relevant tab/close tests and Rust IO tests.

**Risks.** Duplicate requests, background sessions, Save As target collisions,
disk polling during a write, and mutation after a successful snapshot save.
Do not solve this by freezing normal typing or silently discarding stale replies
that still need a visible conflict decision.

**Related.** GAP-001, GAP-002, GAP-004, GAP-005, GAP-027, GAP-032.

### GAP-026 — Browser-readable HTML and print output

**Priority:** P1 · **Effort:** M · **Workstream:** Output · **Status:** in progress

**Plan:** [Browser-readable HTML and print output](plans/2026-10-25-browser-readable-exports.md)
— approved 2026-10-25.

**Delivered.** The export-only transform restores the real image/anchor
destinations from the preview's `data-src`/`data-href` and resolves them through
`src/export-paths.ts`: a relative URL when the output shares the document's
root, a `file://` URL otherwise; print always uses absolute file URLs. Mermaid
is rendered with the output's own theme (light for print, current theme for
HTML). Both print wrappers share `src/print-ready.ts`, which waits (bounded) for
images and web fonts, forces eager/sync images, and prints a visible list of
failed resources. The standalone HTML now uses the typography variables it
already emitted. Windows validation: `export:paths:unit` 42/42,
`export:browser` 21/21, plus smoke/html/asciidoc/word-sync/export green. Manual
ordinary-browser/PDF inspection and the Linux run remain.

**Evidence.** `buildExportArticle` reuses preview renderers. Their shared
`decorateLinks` converts local image sources into app asset URLs and removes
ordinary anchor `href`, keeping destinations in `data-href`. The standalone
wrappers do not restore them. An external browser has neither the asset handler
nor MDraft's click listener. Mermaid also uses current `isDark` even when the
print page is forced light. This is existing-output correctness, not GAP-009's
native printing integration.

**Target.** Assemble a browser-readable article with valid image/link targets,
explicit output theme and resource readiness. Reuse it for HTML and browser
printing without weakening preview sanitization or the HTML guest boundary.

**Acceptance.**

- Export Markdown and AsciiDoc containing a real local image, external link,
  heading link and local-file link. In an ordinary browser the image loads and
  each link has the intended destination; no app asset protocol is required.
- Resolve/rebase resources for the actual output location; preserve escaping,
  spaces, Unicode and the chosen allowed URI schemes. Keep source bytes intact.
- Print from a dark editor produces readable light diagrams and token colors;
  printing waits for required fonts/images or explains a resource failure.
- Inspect actual output, including selectable PDF text and visible images/math;
  checking for CSS strings alone is insufficient. After Export runs only where
  MDraft knows a file was written; browser handoff retains its documented limit.

**Tests.** Export serialization unit checks and real browser/PDF inspection;
`npm run export` plus relevant Markdown/AsciiDoc/HTML regressions. Test the HTML
source-copy path separately from generated Markdown/AsciiDoc output.

**Risks.** File-origin restrictions, lazy images, remote resources, URI escaping
and accidentally reusing preview event/data attributes as export behavior.
Offline packaging is GAP-033 and must not delay these repairs.

**Related.** GAP-009, GAP-012, GAP-013, GAP-033.

### GAP-027 — Lifecycle regression coverage and CI

**Priority:** P1 · **Effort:** M/L · **Workstream:** Testing · **Status:** open

**Plan:** the first CI slice (`p0:unit` + `test:sessions` in the quality
workflow) is delivered by
[Stronger pre-save disk revision validation](plans/2026-10-25-stronger-disk-validation.md)
— approved 2026-10-25. Crash/relaunch automation remains open here.

**Evidence.** The 2026-10-25 P0 plan added deterministic controller/export
regressions to `p0:unit` and registered `p0-lifecycle` in the default isolated
UI harness, including three-way close and binary/encoding refusal. Reuse those
tests. Crash/relaunch probes remain manual. Quality CI runs build/format/lint/knip/Clippy and release
CI runs Rust tests; neither runs the app-free JavaScript safety/session suites.

**Target.** Run the existing cheap app-free suites in CI and extend the registered
lifecycle coverage for crash/relaunch. Keep native UI coverage isolated on suitable platform
runners. Each P0 fix still includes its reproducing tests immediately; this item
is not permission to defer them until a later testing project.

**Acceptance.**

- A CI failure catches regression in session/recovery/classifier behavior and
  delayed-I/O save/reload/Save As handling. Failed tests fail the job.
- An isolated two-launch test restores saved and untitled dirty buffers after
  a controlled kill; saved/discarded entries do not return. Corrupt entries,
  refused journal writes and cleanup failures cannot silently lose other entries.
- Automated tab/bulk/window close tests cover Cancel, dismissal, failed save,
  untitled Save As cancellation and conflicts. The clean WM_CLOSE test remains.
- Tests preserve user settings/window state/recovery and terminate only their
  own processes. Skipped native prerequisites are reported explicitly.

**Tests.** Demonstrate failure on old behavior and success after fixes; verify
CI configuration and run the registered layers locally. Update script tables
and counts if scripts change; do not add a second undocumented test harness.

**Risks.** Shared WebView2 profiles, clipboard ownership, unreliable timing and
tests that assert implementation counters rather than protected document bytes.

**Related.** GAP-001, GAP-004, GAP-005, GAP-017, GAP-025, GAP-032.

### GAP-028 — AsciiDoc/Typst list and quote continuation

**Priority:** P2 · **Effort:** M · **Workstream:** Editing · **Status:** open

**Evidence.** Markdown installs its continuation keymap; AsciiDoc and Typst do
not provide equivalent language-specific Enter behavior. GAP-012 corrects the
overbroad Help sentence but does not implement the missing editing behavior.

**Target.** Continue/terminate lists and supported quotation constructs with
Enter, preserve nesting and make indent/outdent predictable in each language.

**Acceptance.** Enter continues supported list forms and exits an empty item;
nesting/indentation remain valid; code, math and IME composition are not
rewritten; one undo restores each editing action. Typst operations insert Typst,
not Markdown, and emitted examples compile. Define quotation behavior per
language rather than assuming every language uses `>`.

**Tests.** Pure transforms plus real typing in both languages; `autoclose`,
`paste`, Typst preview and AsciiDoc tests as appropriate.

**Risks.** Empty-item conventions, multi-cursor edits and competing Enter keymaps.
**Related.** GAP-003, GAP-012, GAP-022.

### GAP-029 — Actionable compiler diagnostics

**Priority:** P2 · **Effort:** M/L · **Workstream:** Preview · **Status:** open

**Evidence.** Typst failures are preformatted messages; warning extraction
retains headline strings. Messages exist, but there is no navigable
file/line/column diagnostic surface.

**Target.** Show actionable source locations and reveal the offending range.
Consider retaining the last successful preview with an explicit stale label;
reuse navigation for math, Mermaid and missing assets where precise mapping is
available. This must not let a stale preview mutate or falsely select source.

**Acceptance.** A Typst error opens the right source range, including an allowed
included file; generated/stdin/temporary paths map correctly or explain why
they cannot. New edits invalidate old diagnostic locations. Warnings remain
readable and keyboard reachable, and a retained preview is visibly stale.

**Tests.** Structured diagnostic/parser fixtures and UI navigation with errors
in the active file and an include; successful compilation clears stale errors.

**Risks.** Compiler version/output changes, Unicode columns and public command
payload changes. Plan the boundary before choosing a representation.
**Related.** GAP-025, GAP-030, Typst preview/render commands.

### GAP-030 — Keyboard operation, modal focus and announcements

**Priority:** P2 · **Effort:** M/L · **Workstream:** Accessibility · **Status:** open

**Evidence.** Tabs and menus already have keyboard/ARIA support. Preferences
is intentionally a non-modal floating card (`preferences.ts` and its overlay
CSS say so); it must remain possible to reach the editor while it is open.
Its close path has no explicit focus restoration, and pane resizing has mouse
handlers only. Existing attributes do not establish end-to-end accessibility.

**Target.** Complete keyboard resizing, appropriate focus restoration and
screen-reader announcements for recovery/conflicts, then audit the whole path.
Trap focus only in genuinely modal dialogs; preserve Preferences' non-modal
behavior. GAP-004's new close dialog must be accessible when it ships, not wait
for this item.

**Acceptance.** Keyboard users can resize panes and operate every shipped
modal without reaching its background controls. Preferences remains keyboard
reachable and non-modal; closing it restores meaningful focus instead of leaving
focus on hidden content. Recovery, save failure and conflicts are announced
without moving the caret. Existing tab/menu navigation, high-contrast and
reduced-motion behavior remain usable; record screen-reader checks on published
platforms.

**Tests.** Focus-order/keyboard UI tests and geometry checks, plus manual
screen-reader/high-contrast checks with documented results.

**Risks.** Rerenders removing focused elements, accelerator ownership in guests
and announcements repeated on every poll.
**Related.** GAP-004, GAP-011, GAP-016, GAP-019, GAP-029.

### GAP-031 — Optional bounded saved-version history

**Priority:** P2 · **Effort:** L · **Workstream:** Data safety · **Status:** open

**Evidence.** Atomic replacement prevents a partial save and the recovery
journal protects dirty work; neither retains an earlier successfully saved
version after the reader accidentally saves over it.

**Target.** Opt-in, size-capped local snapshots with compare/restore under app
storage. Define retention, privacy, Save As/rename identity and portable behavior
in the plan. This is separate from recovery and starts disabled.

**Acceptance.** When enabled, an earlier saved version can be compared and
restored through a conflict-aware, undoable operation. Retention respects both
count and byte limits; history failure reports a problem without corrupting the
document or recovery. No network request or unsolicited document-folder backup
is introduced; disabling/clearing history has an explicit storage policy.

**Tests.** Snapshot/retention/failure unit and Rust tests, UI compare/restore,
and restart/portable checks on disposable documents.

**Risks.** Sensitive retained text, storage growth, retention races and confusing
saved versions with unsaved recovery entries.
**Related.** GAP-001, GAP-006, GAP-025, GAP-032.

### GAP-032 — Stronger pre-save disk revision validation

**Priority:** P1 · **Effort:** M · **Workstream:** Data safety · **Status:** in progress

**Plan:** [Stronger pre-save disk revision validation](plans/2026-10-25-stronger-disk-validation.md)
— approved 2026-10-25. It also carries the first GAP-027 CI slice.

**Delivered.** Disk revisions are identified by the SHA-256 of the raw bytes
(`DocumentPayload.sha256`, `RecoveryEntry.baseSha256`). The editor saves through
`write_document_checked`, which validates the expected digest before creating
the temporary sibling and again immediately before the rename; a mismatch
returns `written: false` and keeps the buffer dirty and journaled.
`fingerprint_document` supplies the revision **Keep my version** adopts.
`write_document` keeps its old contract for exports. Windows validation:
`p0:unit` 110/110, `p0:lifecycle` 34/34 (including a same-size/same-mtime
rewrite), Rust 130 passed, Clippy/build/lint/knip clean. The CI job for
`p0:unit` and `test:sessions` is in the quality workflow; its first GitHub run
and the Linux Rust run remain to be recorded.

**Evidence.** GAP-002's approved first pass compares `mtime` and size. A direct
probe returns `unchanged` for different bytes with matching metadata. The stat
and write are separate IPC operations, leaving an acknowledged external-writer
race. The classifier comment's claim of a benign prompt for matching metadata
is incorrect. Preserve GAP-002 as completed; this is its explicit follow-up.

**Target.** Evaluate content-based baseline validation before overwriting and
move validation/write closer together at the backend boundary. Use metadata
for cheap polling where appropriate; do not impose full-file hashing on every
poll or promise an absolute filesystem compare-and-swap guarantee.

**Acceptance.** A same-size/same-mtime external rewrite cannot be silently
overwritten by a normal save or Auto Save. Reload/Keep mine/Save a copy operate
against the intended disk revision; newer external revisions require a new
decision. Preserve BOM/EOL/encoding distinctions and document any remaining
filesystem race, with measured cost on representative files.

**Tests.** Byte fixtures with preserved timestamps, changed encoding/BOM/EOL,
metadata-only touches and injected intervening writes; UI conflict/Auto Save
tests on copies. Extend existing IO/classifier coverage rather than duplicate it.

**Risks.** New command arguments/return shape, network-share behavior, false
conflicts, aliases and check/write semantics. Choose any lock/replace strategy
in the approved plan after checking both published platforms.
**Related.** GAP-002, GAP-005, GAP-021, GAP-025, GAP-027.

### GAP-033 — Self-contained offline HTML and print assets

**Priority:** P2 · **Effort:** M/L · **Workstream:** Output · **Status:** open

**Evidence.** Generated HTML and print wrappers link KaTeX CSS/fonts from
jsDelivr. `docs/export.md` already documents this network dependency. GAP-026
repairs browser readability but does not itself package every resource offline.

**Target.** An explicit self-contained export option embeds the required math
styles/fonts and local resources, or packages a documented companion directory.
Do not silently download remote resources while exporting; define their policy
and the output size limit. Keep the existing lightweight route available.

**Acceptance.** Export a local-image/math/diagram fixture, move the resulting
artifact or package away from its source folder, disable network access, and
verify images, fractions/radicals, typefaces and links in an ordinary browser
and print output. Remote-only assets are either deliberately resolved through
an authorized action or clearly reported; the option never claims success for
an incomplete offline package. No app asset protocol or CDN is required.

**Tests.** Resource inventory/serialization checks and an ordinary-browser
offline render with an actual output/PDF inspection; include missing/oversized
assets and the documented HTML-source limitations.

**Risks.** Licensing, output size, CSS-relative URLs, file-origin policy and
packaging arbitrary HTML scripts/modules. Scope HTML-source support explicitly.
**Related.** GAP-009, GAP-026, font embedding and export wrappers.

## Shared foundations

Reuse existing modules; proposed interfaces below are not claims that those
modules already exist and are not architecture approved by this backlog.

| Foundation | State | Consumers and boundary |
| --- | --- | --- |
| Recovery store/scheduler | Implemented (GAP-001) | Reuse for GAP-004/025/027; saved-version history (GAP-031) has a different lifecycle |
| Stat-based disk guard | Implemented (GAP-002) | Reuse conflict actions; GAP-032 adds stronger validation without claiming the first pass was absent |
| Session/revision lifecycle | Implemented (GAP-025) | Reuse `document-lifecycle.ts` and shell export snapshots for session/revision ownership |
| File policy and encoding | Binary/lossy guard implemented; classification/size/decoding follow in GAP-005/021 | Reuse Rust refusal and legacy-copy protection; shared UX and supported decoding remain separate |
| Directory listing/ignore rules | Proposed (GAP-006/007/022) | Shared bounded listing; neither a visual tree nor a whole-workspace index is required by every consumer |
| Browser-readable article | Implemented (GAP-026) | The export-only URL/theme transform and shared print-readiness script; native printing (GAP-009) and offline packaging (GAP-033) reuse it |
| Preview search adapters | Proposed (GAP-011) | DOM, guest and PDF can ship separately; independent copy/task controls do not depend on search |
| Language commands | Typst helpers implemented (GAP-003) | Language dispatch remains in `main.ts`; a cross-language table feeding Help has not landed |
| Table model | Proposed (GAP-010) | Parse/serialize only the table being edited; fail closed on unsupported structures |
| Shortcut comparison | Proposed (GAP-012) | Compare Help with the actual accelerator registry |
| Lifecycle test harness | Partial; extend under GAP-027 | Reuse existing isolation and restart conventions; add deterministic I/O and owned crash profiles |

## Suggested order

1. **P0 foundations delivered.** GAP-025 async session/revision safety, GAP-004
   cancellation-safe close and GAP-005 binary/lossy-write guard are implemented
   by the approved 2026-10-25 plan. No known P0 remains open in this backlog.
   Preserve their reproducing tests and the earlier GAP-001/002/003 foundations.
2. **P1 — reinforce safety and existing output.** GAP-032 stronger disk
   validation, GAP-026 browser-readable exports, and GAP-027 automated lifecycle
   coverage/CI. Add Save All under GAP-004 and finish the file-size policy under
   GAP-005 as separately scoped slices. GAP-027 does not gate writing P0 tests.
3. **P1 — make current workflows consistent.** Finish GAP-012 documentation,
   GAP-013 front matter, GAP-011 visible preview Find, GAP-019 preview zoom/reset,
   GAP-017 file handoff/multi-file launch, and GAP-021 UTF-16 round-trip. Order
   these by independent ownership and actual user need; encoding work reuses
   GAP-005 rather than postponing the safety guard.
4. **P2 — choose the next authoring/workspace increment.** Compare a small
   folder/search/quick-open package (GAP-006/007/008) with Markdown table editing
   (GAP-010) and footnotes (GAP-014) using the intended users' workflows. Defer
   multi-file replacement and destructive file management until their safety
   and undo designs are approved.
5. **P2 — quality and optional integration.** GAP-015/016/018/020/022,
   GAP-028/029/030/031/033 and GAP-009 native printing. Each is independent unless
   its particular slice needs an existing shared foundation. New UI must meet
   its own keyboard/focus requirements immediately, not wait for GAP-030.
6. **P3 — remaining conveniences.** GAP-023, the later preview conveniences and
   optional multi-window; GAP-024 localization stays parked.

**Small follow-ups:** GAP-012 copy/shortcut corrections, GAP-019's reset-only
fix and GAP-015 typewriter centering are small; they do not justify delaying P0.

Actual prerequisites, rather than a general dependency chain:

| Slice | Needs | Does not need |
| --- | --- | --- |
| Open-tab search / quick open | Current session snapshots / existing recents/favorites | Folder tree or cross-file Replace |
| Heading completion / link dialog | Current headings / completed resolver and native picker | Workspace UI |
| Folder search / document-relative completion | Shared bounded listing, file policy and preview path rules | A full file manager or every other workspace feature |
| Encoding round-trip | GAP-005 safety policy | A second implementation of lossy confirmation |
| Multi-file Replace | Revision checks, encoding, explicit partial-failure/undo design | Native printing |
| Native print / offline packaging | Correct browser-readable assembly (GAP-026) | Table editing |
| Task toggles / code-copy / Pages navigation | Fresh renderer/source state and their own UI tests | Complete preview-search adapters |

## Verification and test conventions

- Start with the cheapest layer that can catch the failure: a pure unit test, then a Rust
  test, then a UI suite.
- UI suites follow [AGENTS.md](../AGENTS.md#conventions-for-new-test-scripts):
  port as `argv[2]`, `Runtime.enable`, throw on `exceptionDetails`, one
  `PASS`/`FAIL` line per check, non-zero exit on failure, `ws.close()` and
  `process.exit` on both paths.
- Every new suite needs its own freshly launched instance and its own fixture.
  Do not batch unrelated suites against one window.
- Never delete the user's `settings.json`, `.window-state.json` or recovery to get
  first-run state. Run against a build with its own `identifier` or back the
  files up; AGENTS.md records the blast radius.
- Data-safety tests must own their settings/recovery/WebView2 profile and
  terminate only processes they launched. Normal shutdown uses WM_CLOSE and
  awaits the flush. A crash test may force-kill its own disposable instance;
  a graceful close cannot establish crash-recovery behavior.
- Printing is platform-specific: Windows and Linux need separate manual checks;
  CDP cannot see the native print dialog.
- Update the test counts in `AGENTS.md` and `README` when a suite changes.
- Saving and lifecycle checks assert actual document bytes, dirty state and
  recovery retention under deliberately delayed I/O. Pure helper tests alone
  cannot establish orchestration safety.
- Record both output artifacts and visible behavior for exports. Inspect real
  image/link/math rendering, not just the presence of markup or CSS links.
- On this Windows host, every cargo/Tauri invocation goes through
  `scripts\with-msvc.cmd` or `scripts\cargo-vcvars.cmd` as AGENTS.md requires.

**Commands that will be used repeatedly**

```
npm run build
npm run lint
npm run format:check
npm run knip
npm run p0:unit
npm run test:sessions
.\scripts\cargo-vcvars.cmd test --manifest-path src-tauri\Cargo.toml
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

## Documented boundaries and deferred product choices

Documentation does not make a limitation ineligible for backlog work. The
following boundaries are intentional or deferred; promote one only with a clear
user benefit, scope and priority. Do not label a documented limit as a newly
introduced regression without evidence.

- AsciiDoc `include::` reads only the document's folder; `lines`, `tag` and
  `leveloffset` are not applied; includes are re-read on every render.
- The pandoc route cannot represent `[TOC]` or GitHub alerts; they arrive as
  literal text in DOCX/ODT/LaTeX.
- Typst's Document view drops layout containers (`#columns`, `#grid`, `#align`,
  `#stack`, `#place`, `#rect`, `#pad`) together with their content.
- Native print and direct PDF are implemented; the browser handoff remains for
  scripted HTML and hosts without a print API.
- macOS is not published.
- The HTML guest has no same-origin storage, service workers or Web Workers.
- There is no WYSIWYG editing, image upload or community CSS theme format.

## Completed adjacent work — reuse, do not duplicate

- **Link navigation — done.** [Plan](plans/2026-10-24-link-navigation.md).
  Reuse the resolver, editor gesture, contextual Open item, image Ctrl+click and
  Rust `open_external` command for authoring and completion.
- **Image paste rules — done.** [Plan](plans/2026-10-24-image-paste-rules.md).
  Reuse byte validation, `${filename}`, extra HTML/Typst roots, untitled guards,
  failure notices and preserved original image addresses.
- **P0 foundations — done.** [Plan](plans/2026-10-24-p0-data-safety.md).
  GAP-001/002/003 retain that plan's approved scope and validation; GAP-025 and
  GAP-032 explicitly own the newly detected internal races and stronger disk
  protection.
- **Typst Reference** — landed in `src/content.ts`, `samples/typst-reference.typ`
  and the Help menu; use it as the syntax source for GAP-003.

## Open questions

1. **Next product audience.** Prioritize folder-based technical writing,
   table-heavy documents or academic footnotes after safety/current workflows?
   Default: keep these at P2 until actual user needs choose the next increment.
2. **Quick Open shortcut.** Print owns `Ctrl+P` (GAP-009); Quick Open needs another
   accelerator. Decide before either registers a second one.
3. **Preview zoom policy.** Shared pane scale or independent document scales?
   Default: make Preview-only zoom work and reset zoom without changing width;
   choose the rest through layout/source-sync validation.
4. **Markdown dialect.** Adopt footnotes/sub/sup/highlight/definitions or retain
   the current dialect explicitly? Default proposal: evaluate each syntax with
   preview/paste/export compatibility; the public dialect change needs a plan.
5. **File management.** Define reference rebasing and recoverable deletion before
   rename/move/delete; existing Save As must be covered by that decision too.
6. **History / offline exports.** Resolve storage retention and remote-resource
   policy in GAP-031/033 plans; neither introduces automatic background network.

Already settled: recovery is under app config with caps; browser printing is a
working fallback; single-instance handoff precedes any optional multi-window;
localization is parked. Workspace walker/library and native printing APIs remain
implementation choices for their plans, not dependencies already approved here.

## Snapshot and maintenance

- The linked audit records code inspection, 52/52 P0 helper and 59/59 session
  checks, deferred-I/O failure probes and direct Markdown/decorator checks. No
  native print or full live UI suite was run for that review. Its limitations
  remain part of the evidence; do not describe the probes as end-to-end tests.
- Evidence names symbols and files rather than line numbers, because line
  numbers move with every edit. Use the symbol as the locator and the quote as
  the confirmation.
- This revision keeps GAP-001–024 stable, adopts the audit's GAP-025–031, and
  assigns GAP-032 to stronger disk validation and GAP-033 to offline exports.
  Those last two name follow-ups already described in the audit; they do not
  duplicate the completed stat guard or browser-readability repair.
- Keep triage metadata and detailed sections synchronized. A later slice is
  separately scoped and estimated before pickup; do not close its parent while
  uncompleted accepted slices remain without a transferred, linked owner.
- New code or concurrent work may invalidate evidence; recheck before starting.
- Re-audit at each release: add new gaps, close fixed ones, keep the IDs stable.
- This file is not a substitute for a plan. When an item is picked up, write the
  plan in `docs/plans/YYYY-MM-DD-slug.md`, link it here, and let the plan carry
  the detailed steps.
