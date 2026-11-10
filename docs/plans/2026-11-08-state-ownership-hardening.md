# Protect document and asynchronous operation ownership

**Status:** in progress

**Approval:** approved in conversation, 2026-11-10 — "consider plan approved and
implement"; the paste open question was answered "a paste should land in the
tab switched away from".

**Date:** 2026-11-08 (revised 2026-11-10)

**ADR:** none. This plan follows the existing document-operation, preview-job,
AI transport and LaTeX-export decisions. If implementation establishes a new
durable architectural decision, add an ADR; supersede an existing ADR rather
than rewriting it.

## Context and goal

The [implicit state-machine audit](../audits/2026-11-08-implicit-state-machine-audit.md)
identified asynchronous paths that can lose the identity of the document,
request, render, process or file they started for. The most serious examples
are a recovered draft shadowed by disk text, a displayed session diverging from
the session store, and a LaTeX export combining the source of one project with
the snapshot of another. Other paths can paste or insert text into the wrong
place, accept stale previews, lose a cancellation, ignore a close decision, or
share an install or print resource.

The goal is to make those ownership and commit rules explicit at their existing
boundaries, with focused regression tests and no general state-machine rewrite.
Fix one independent behavior at a time. The audit's in-memory reproductions are
evidence for specific paths, not application-level verification.

**Reuse before invention.** The repository already contains a working example
of every ownership pattern this plan needs; the audit's Appendix B maps each
fix to it. Each milestone below names the primitive it copies. Introduce a new
mechanism only when that row does not fit, and record why in this plan.

**Revision of 2026-11-10.** A second code review confirmed the audit's findings,
added F16 (Auto Save during a close decision) and F17 (native LaTeX cancel before
registration), replaced the paste fallback's proposed retention surface with a
smaller policy that loses nothing, and corrected the suite list. The audit's
"What the 2026-11-10 revision changed" section lists every change.

**Workspace state.** The audit reviewed revision `50866e9`. On 2026-11-10 the
working tree also held the finished but uncommitted
[binary-size work](2026-11-08-binary-size-reduction.md): `src/clipboard.ts` now
reads and writes plain text through the new `clipboard_read_text` /
`clipboard_write_text` commands instead of the clipboard plugin, `latex.rs`
exports two helpers, and `tex_fmt.rs` is new. None of the files the findings
cite changed. Before each milestone, compare the tree with this baseline,
preserve all unrelated changes, rerun the baseline, and update this plan if the
scope or evidence moved.

## Scope and non-scope

**In scope, as separate milestones:**

- Restore recovered drafts without shadowing them and keep the displayed session
  synchronized with the store's active session (audit F1).
- Bind LaTeX conversion exports to their initiating project snapshot (F14).
- Preserve the owner of clipboard, rich paste, image paste and drop operations
  across asynchronous work, including Save As and replacement (F2).
- Prevent duplicate concurrent opens, including against Save As, and make the
  initial startup slot a single-consumer owned resource (F3).
- Map or safely reject stale AI insertion anchors (F15).
- Preserve ownership and reliable local cancellation of abandoned AI requests,
  including the pre-registration and pre-header races, and apply the same
  pre-registration rule to native LaTeX jobs (F4, F17).
- Report an HTML preview current only after its matching frame is promoted, and
  invalidate LaTeX ownership on backend/engine changes (F5 and the freshness
  part of F6).
- Keep Auto Save out of a close that is waiting for the reader's decision (F16).
- Isolate concurrent installations of the same tool and repeated or same-stem
  browser/compiled print files, without blocking unrelated tools or deleting a
  viewer's file (F6).
- Repair the existing P0 test harness baseline, add targeted tests, and update
  affected documentation or test catalogs.

**Internal interfaces this plan may change.** These are module APIs inside the
frontend or backend, not public contracts under `AGENTS.md`; each change is
listed so approval covers it explicitly:

- `SessionStore` (`src/sessions.ts`): an insert that does not change the active
  session, for recovery.
- `Session`: a runtime-only `incarnation` counter advanced only when a session's
  document is replaced (startup fill, reload). Like `revision`, it is never
  persisted in settings or recovery.
- `DocumentLifecycle` (`src/document-lifecycle.ts`): a read-only `closing` flag
  and a way to run an open under its existing `path:<pathKey>` queue.
- `openPath` returns the session it opened or focused, or `null`.
- Rust-internal registries in `ai/mod.rs` and `latex_native.rs`: a bounded
  record of cancels that precede registration.

**Out of scope:** a state-machine library; a global reducer; a single exclusive
session-status enum; broad session, preview, export or AI rewrites; new
dependencies; changes to command names, command argument/return shapes,
`src/api.ts` wrappers, settings or recovery schema, menu events or
`accelerators`/`menu_state` payloads; changes to Markdown dialect; telemetry or
automatic network activity. This plan does not add a print-queue UI, change
unknown-tool menu availability, add a request-header deadline, change the AI
policy that History/palette may cover a running request, or add a retention
surface for refused pastes. It does not restructure pane scroll synchronization
(audit F19) or the Preferences note slots (F20). Those need separate
authorization. Do not replace unrelated user work or change existing ADRs.

The corrections intentionally change the defective outcomes described in the
audit. Normal interactions, file formats, focus and undo behavior, existing
background AI completion, and current-caret rich-paste behavior should remain
the same where the initiating owner is still valid. An ambiguous target must
fail safely with a clear, recoverable result; the user-visible fallbacks below
are part of the proposal for approval.

## Approach and rejected alternatives

Use existing session IDs, document revisions, CodeMirror transactions, render
tokens, per-resource queues and Rust synchronization. Add only the runtime
identity or generation needed where an existing token cannot distinguish an
ordinary edit from replacing a document. Revalidate ownership at each commit
boundary; a TypeScript union alone cannot enforce cancellation or disk effects.

1. **Recovery (F1).** A recovered draft remains authoritative until displayed or
   deliberately discarded. A draft attached to the *displayed* session is
   installed into the editor in the same synchronous step, so `doc` never holds
   a pending draft; `draft` stays pending only for hidden sessions, where it is
   valid. Recovered sessions are inserted without moving the store's active ID,
   so `doc` and the store agree across every await in the restore loop. Do not
   retain a stale disk `editorState` beside an unshown draft and rely on display
   order to resolve it. Preserve the existing choice of active recovered tab and
   all recovery IDs/formats. Copies: `RecoveryScheduler` for journal authority.
2. **Project export (F14).** `latexExportSnapshot()` already captures its root
   and open-buffer overlays synchronously before its one IPC call. Call it
   before the Pandoc lookup in `exportWithPandoc` and `exportLatexWithWriter`,
   as the chooser route already does, and pass the captured value through. A
   later tab switch must not change it; a closed tab after capture does not
   silently select another project. Keep backend staging, destination collision
   checks and the compiled-PDF route. Capture of external disk files remains
   subject to filesystem changes during I/O; do not claim an atomic filesystem
   snapshot.
3. **Clipboard and paste (F2).** Capture an owner before the first clipboard or
   image await: the session object, its `incarnation`, path, directory and
   language. Do not use `Session.revision` (typing changes it) or the lifecycle
   generation (every Save and Auto Save changes it). Resolve assets relative to
   the captured destination. At commit:
   - owner on screen and unchanged: insert at the live caret, as today;
   - owner hidden but unchanged: insert into its stored `EditorState` at its
     saved selection as one undoable transaction, keeping revision, dirty state
     and the journal consistent exactly as `formatSession` does for a
     background tab, and say so in a toast;
   - owner saved under a different directory: recompute the reference from
     `SavedImage.absolutePath`, or refuse;
   - owner closed, reloaded/replaced, or holding a never-shown recovered draft:
     insert nothing and name the saved asset in a toast.

   A clipboard-read route (context-menu Paste, Paste without Formatting) whose
   target changed during the read inserts nothing and says the paste can be
   repeated: the system clipboard still holds the data. No route inserts into an
   unrelated document or field, or writes the system clipboard.
4. **Open and startup (F3).** Run the read of an open under `DocumentLifecycle`'s
   existing `path:<pathKey>` queue, then recheck the store before committing, so
   two opens of one path and a Save As to that path are ordered by one key. The
   queue is held only for the read, never across a dialog. Replace the
   `installingStartup` boolean with a startup slot that names its session and
   the revision it was reserved at; consume it once, when a document is actually
   installed (not by loop index in `restoreLastTabs`), and only if the session
   still exists, is still `doc`, and its revision is unchanged. A slot the
   reader typed in is no longer blank and the open becomes a new tab, which also
   keeps the typed text's recovery entry. `openPath` returns the opened or
   focused session; callers that act afterwards (preview link fragments) act on
   that session, as LaTeX problem navigation already rechecks. Preserve
   multi-file ordering and focus; failures must not poison later opens.
5. **AI insertion (F15).** Track the captured paragraph/caret anchor through
   intervening CodeMirror transactions with a small state field that maps it by
   `ChangeDesc.mapPos`, using `MapMode.TrackDel` to detect deletion of its
   surroundings. Preserve Insert/Insert below for stale but still mappable
   targets. If the anchor is deleted, ambiguous, belongs to a replaced document,
   or cannot be mapped safely, do not edit at a guessed offset: report the
   reason and keep Copy and New tab available. The stale-Replace message must
   name only actions that remain safe. Keep insertion one undoable transaction.
6. **Cancellation (F4, F17).** History or palette may continue to cover a
   running request; its answer must still reach history. A new action or close
   must not drop the only cancellation owner, and `close()` settles the panel
   state together with the request id. In Rust, copy the Typst preview
   registry's rule that a cancel which precedes registration still wins: for the
   opaque string ids of `ai_complete` and `latex_native_compile`, an unknown-id
   cancel records a tombstone, registration checks and clears it, and the set is
   bounded (oldest dropped). Do not parse tokens out of the ids. Poll AI
   cancellation during `post_chat`, including retry and error-body awaits.
   Report a completed request honestly if it wins the race; dropping the local
   future does not guarantee the provider stopped work or charges. Keep the
   existing 15-second connection and 90-second stream-idle policies; do not add
   an overall header deadline under this plan.
7. **Preview (F5).** Keep the HTML frame controller's generation, nonce, pending
   frame and old-frame safeguards. A matching bridge ready event must promote the
   pending frame before the shell marks it current or sync-ready. Build/IPC
   failure, timeout, supersession, reset and disposal must resolve any pending
   operation without a stale success or a stranded promise, following
   `PreviewWorkerChannel`'s distinct outcomes.
8. **LaTeX engine freshness (F6).** Include engine/backend configuration in the
   build owner, or invalidate the owner immediately when `setNativeEnabled` or
   `setNativeEngine` succeeds; preserve manual mode and the last readable PDF
   with truthful stale status. Check freshness again for save/print after
   dialogs.
9. **Auto Save and close (F16).** Expose the lifecycle's `closing` phase
   read-only and skip an Auto Save tick while it is set; skip a tick while the
   previous one is still running. Do not put the check in `run()`: the close's
   own Save goes through it.
10. **Install resources (F6).** Use a backend guard scoped to the same tool;
    two different tools need not block each other. Pandoc's executable is
    written atomically (temporary file and rename, as `latex::write_atomic`
    already does), and `install_latex` tolerates an asset another install
    already removed.
11. **Print resources (F6).** Give each browser-print and compiled-PDF handoff
    its own temporary path, so a repeated print of one document and two
    documents with the same stem cannot collide. Clean up owned partial files
    without removing a completed file the external viewer may still open or a
    file named in an opener-failure message. No new print queue or menu state is
    required.

**Rejected alternatives:**

- A new state-machine dependency or a global reducer adds migration and runtime
  cost without solving the existing ownership boundaries.
- Merely retaining a recovered draft in `snapshotDoc` while also keeping a stale
  `editorState` leaves `displayDoc` able to choose disk text instead.
- Reconciling `doc` with the store's active ID after the recovery loop leaves the
  two disagreeing across its awaits, where Next/Previous Tab and new tabs
  already observe the store.
- Guarding paste solely by the content revision rejects intentional typing;
  guarding solely by session ID misses Save As and document replacement; using
  the lifecycle generation refuses a paste whenever Auto Save runs.
- An in-memory "pending paste" surface with retry/copy/dismiss actions and
  capacity accounting (the previous draft of this plan). A refused paste loses
  nothing — the clipboard still holds the data and image assets are already on
  disk — so the surface would add UI, memory policy and tests without
  protecting any data.
- A second per-path map for opens beside the lifecycle's `path:` queue would
  leave Save As and open unordered against each other.
- Capturing `installingStartup` as a boolean does not identify or reserve the
  initial session and cannot protect it against edits or closure.
- Cancelling an AI request whenever History or palette opens changes explicitly
  supported background completion. Merely registering before Started does not
  order independent cancellation commands.
- Treating iframe creation as preview success misses readiness timeouts.
- Refusing every lifecycle operation while a close decides would also refuse
  the close's own Save.
- One global install/export mutex blocks independent work; deleting print files
  immediately after launching a viewer races the external application.

## Steps

Each milestone is independent and revertible on its own. Run them in this order
unless the reviewer reorders them; record any reordering here.

- [x] **0. Establish the baseline.** Record the current commit and unrelated
  working-tree changes without modifying them. Rerun the app-free suites. At the
  reviewed revision and again on 2026-11-10, `p0-unit` reported 110/113 because
  its VM export harness lacks `toastReport` (recorded in
  `docs/agent-guide/traps/test-harness.md`). Add the helper to the harness's
  `exportNames` or stub it, preserving the ownership assertions, and demonstrate
  that the unmodified suite passes. Do not treat an in-memory stub outside the
  repository as a passing test.
- [x] **1. Recovery (F1).** Add deterministic failing tests for draft shadowing
  and store/display active-ID divergence, including multiple journal orders,
  existing and new/untitled tabs, close, save, Auto Save, Next/Previous Tab and
  the position of a newly opened tab. Add a test helper that asserts
  `sessions.active() === doc` and `sessions.byId(doc.id) === doc` after each
  scripted operation. Add a restart-level test for exact draft text, saved bytes
  and journal removal. Implement the synchronous draft installation and the
  non-activating insert, then run the session, P0 and relevant isolated
  restart/UI layers.
- [x] **2. LaTeX export (F14).** Add a deferred tool-lookup test with two
  distinct projects and unsaved root/chapter overlays, and one that switches to
  a non-LaTeX tab. Assert the request's project identity and the actual output
  for configured and direct writer routes. Move the snapshot capture ahead of
  the lookup; test tab switch, source edit, close and lookup failure without
  exporting another project.
- [x] **3. Clipboard and paste (F2).** Add delayed clipboard and image tests for
  context menu, Paste without Formatting, image/drop and rich paste. Cover tab
  switch (insertion into the hidden owner, with undo), close, replacement/reload,
  same-session Save As to another directory, failed image resolution, a hidden
  owner that holds a never-shown recovered draft, and moving the caret while
  typing. Add the `incarnation` counter and the owner record; implement the
  commit policy above.
- [x] **4. Open/startup (F3).** Add deferred same-path and startup tests,
  including different-path opens, Save As to a path being opened, user typing
  in the blank tab (assert the editor text *and* the journal), close, a failed
  first remembered tab, failure/retry, multi-file order and focus, and a preview
  link whose open fails. Run opens under the lifecycle path queue, add the
  startup slot, return the session from `openPath`; do not change path
  comparison semantics or deadlock the existing bulk queue.
- [x] **5. AI insertion (F15).** Add tests that edit before, within and after
  the captured passage, delete an anchor, move the caret, apply Insert/Insert
  below, and undo. Map valid anchors; use the proposed safe fallback for
  ambiguous ones without disabling mappable stale insertions; make the stale
  message name only safe actions.
- [x] **6. Cancellation (F4, F17).** First, in Rust: tombstone tests for cancel
  before registration, after registration, unknown and finished ids, and the
  bound, for both `ai/mod.rs` and `latex_native.rs`; then AI cancellation during
  header/retry/error-body waits and completion races against a local controlled
  server. Then fix frontend abandonment, settle `close()`'s state, and keep
  stopping idempotent while preserving History/palette completion, focus,
  Escape, history and usage. Cover empty stopped answers and repeated parameter
  selection in independent focused tests.
- [x] **7. HTML preview (F5).** Add failure-injection tests for build/IPC,
  pending frame, ready promotion, timeout, supersession, reset and disposal.
  Report matching promotion to the shell; retain the old readable same-document
  frame and existing scroll/sync behavior.
- [x] **8. LaTeX engine freshness (F6).** Add tests for backend and engine
  changes during a build and after a successful build with auto-compile on and
  off, including failed settings changes and an open save dialog. Invalidate the
  correct owner without compiling in manual mode; verify exported and printed
  bytes match the current preview.
- [x] **9. Auto Save and close (F16).** In the lifecycle harness of `p0-unit`,
  defer `decide`, run an automatic save in between, and assert each of Save,
  Discard and Cancel; add the overlapping-tick case. Expose `closing`, skip Auto
  Save while it is set, and add the in-flight guard.
- [x] **10. Install ownership (F6).** Add deterministic backend tests for two
  installations of one tool, independent tools, an asset already removed by
  another install, failure and retry. Guard each tool, write Pandoc atomically,
  and verify normal installation and cleanup paths remain unchanged.
- [x] **11. Print-file ownership (F6).** Add tests for repeated same-document
  and overlapping same-stem HTML/PDF jobs, opener failure, partial write failure,
  unique paths and viewer lifetime. Isolate file ownership and preserve
  documented manual-open behavior.
- [ ] **12. Validate and document.** Run the applicable gates below, record
  results and unavailable platforms, update affected documentation/catalogs and
  the audit's status, tick each completed step and record deviations here. Stop
  and update this plan before any change outside its approved scope.

### Execution record (2026-11-10)

A ticked step means its code change landed with the app-free regression named
below. UI-level additions the step text also asks for are listed under
"Still open" instead of being implied by the tick.

| Step | What changed | Regression added |
| --- | --- | --- |
| 0 | `p0-unit` selects `toastReport`/`missingResources`; trap recorded | P0 back to 113/113 |
| 1 F1 | A draft for the tab on screen is installed in the same turn; `SessionStore.append` inserts recovered tabs without moving the active id; `closeSessions` never leaves a removed `doc` on screen | 13 P0 checks; the 8 ownership checks fail on the pre-fix code |
| 2 F14 | `latexExportSnapshot()` is started before the Pandoc lookup in `exportWithPandoc`, `exportLatexWithWriter` and `openWriterChooser` | 5 P0 checks (switch to LaTeX B and to Markdown, three routes); all 5 fail on the pre-fix code |
| 3 F2 | `PasteOwner` (session, `incarnation`, path, directory, language) captured before the first await; `insertForOwner` inserts live, into a hidden tab's `EditorState`, or refuses and names saved assets; both clipboard-read routes refuse a changed target; rich-paste images resolve against the owner's path | 11 P0 checks, including undo of a hidden-tab paste |
| 4 F3 | `openPath` reads and adopts under `lifecycle.exclusivePath`, rechecks the store, returns the session; `StartupSlot` replaces `installingStartup`; preview-link fragments act only on the opened session | 8 P0 checks with the real lifecycle, including Save As racing an open |
| 5 F15 | `editor.trackPositions` maps anchors with `mapPos(…, 1, MapMode.TrackDel)` and drops them on `setDoc`/`restoreState`; Insert and Insert below use mapped anchors or refuse; stale message names only safe actions | 5 `ai-unit` contract checks |
| 6 F4/F17 | New `cancel_registry.rs` (tombstones, tickets, guards) used by `ai_complete`, `ai_suggest_filename` and native LaTeX; AI registration moved to the start of the command; `post_chat` races the flag; the native loop checks the flag before each pass; `openPanel` cancels an abandoned request; `close()` settles state; `setParameter` keeps `entryId` for an unchanged value; empty answers disable Copy | 7 registry tests, 2 provider tests against a local server that never sends headers |
| 7 F5 | `HtmlPreviewHandle.render` resolves `current`/`failed`/`superseded` on promotion, timeout, supersession and reset; the shell marks HTML current only on `current` | covered by the `html` UI suite only |
| 8 F6 | `invalidateLatexBuild()` after `setNativeEnabled`/`setNativeEngine`; `latexFailure` and the engine-none branch delete `dataset.latexCurrent` | 6 P0 checks |
| 9 F16 | `lifecycle.closing` getter; `autoSaveTick` skips while closing and while a tick runs | 6 P0 checks, including the mechanism itself |
| 10 F6 | Per-tool install locks for Pandoc, Typst and LaTeX; Pandoc and Typst executables written with `latex::write_atomic`; `remove_if_present` for LaTeX assets | 1 Rust test |
| 11 F6 | `print::handoff_dir()` gives each browser-print and compiled-PDF handoff its own folder; a failed HTML write removes its folder | 1 Rust test |

**Deviations, all inside the approved intent:**

- One shared `src-tauri/src/cancel_registry.rs` instead of a tombstone set in
  each registry; the AI map is now private behind `AiState::register`/`cancel`.
- `editor.ts` exposes `pasteInsertionSpec`, the pure form of its three paste
  insertions, so a hidden tab's state and the live view share one rule.
- F2 refuses rather than recomputes a reference after Save As to another
  folder (the plan allowed either). A rename in the same folder stays valid.
- F3 boot passes every startup file through `openPaths`; the slot, not the
  first index, decides which one fills the blank tab.
- F5's render now resolves when the frame is ready (at most the existing 12 s
  timeout), so `doRender` waits for readiness on HTML documents.
- Completed print handoff folders are left to the system temporary directory;
  no cleanup policy was added (see Open questions).

**Second round (2026-11-10, same approval thread).** The reader asked for every
UI-level test above, a correct engine name on the LaTeX export row, and a
visible Auto-compile switch in the menu and in the preview. Two public
contracts change, by that explicit request:

- `MenuState` / `menu_state` gains `pdfEngine` (the engine that produced the
  current PDF, empty when unknown) and `latexAutoCompile`.
- A new menu event and check item, `view.latexAutoCompile` ("Compile LaTeX
  Automatically", View menu, under Compile LaTeX), enabled for `.tex` documents.

What landed:

| Item | Change | Test |
| --- | --- | --- |
| Engine label | `latexEngineName()` normalises the runner's executable name once in `nativeToLatex`; the export row reads `PDF… (compiled by <engine>)`, or `(compiled PDF)` when unknown; the stale "compiled LuaLaTeX PDF" toast no longer names an engine | Rust `menu` label test for LuaLaTeX/pdfLaTeX/XeLaTeX/unknown; 7 `latex-native-unit` checks; `latex-preview` reads the real row after a bundled compile |
| Auto-compile switch | `setLatexAutoCompile()` is the one writer; an "Auto-compile" switch sits beside Compile in the preview's status bar; the View check item and Preferences follow it | Rust settings-backed check-item test; `latex-preview` toggles from the preview and from the menu and reads settings, the menu check and Preferences each time |
| Recovery restart (1) | `scripts/recovery-restore-test.mjs`, harness id `recovery-restore` | two launches with crafted journal entries and an unreadable first remembered tab |
| Paste, open, Auto Save, HTML (3, 4, 7, 9) | `scripts/ownership-test.mjs`, harness id `ownership` | gated IPC in the page: duplicate drag-drop opens, hidden/closed image-paste owner, cancelled clipboard-read paste, Discard across one Auto Save interval, failed HTML render rebuilds |
| AI (5, 6) | additions at the end of `scripts/ai-assistant-test.mjs`; the mock gains a `stallHeaders` mode | covered completion, abandoned request closed at the provider, Stop before headers, disabled empty Copy, mapped Insert below and its undo, refused deleted target, one history row after re-choosing the same target |
| Print (11) | `print::write_handoff()` is the single writer for both viewer handoffs | Rust: a repeated same-stem print keeps a file held open by a "viewer"; a failed write removes its folder |

**Deliberately not UI-tested:**

- Startup typing and startup reads racing each other (step 4): boot finishes
  before a CDP client can attach, so no hook exists in time. The real bodies are
  covered by the P0 open/startup checks.
- Print handoffs (step 11): `print_document` and `print_compiled_pdf` always
  launch the system browser or PDF viewer. A UI test would open real external
  applications, so they are tested at `write_handoff`, which both now use.

## Files and modules

The expected files are listed by milestone. Adjust this list in the plan before
touching additional files; do not alter public command/wrapper shapes.

- **Baseline:** `scripts/p0-unit.mjs`.
- **Recovery (1):** `src/main.ts` (`restoreRecovery`, `snapshotDoc`,
  `displayDoc`), `src/sessions.ts` (non-activating insert), `scripts/sessions-test.mjs`,
  `scripts/p0-unit.mjs`, `scripts/p0-lifecycle-test.mjs`, and, only if needed
  for the same invariants, `src/document-lifecycle.ts` and `src/recovery.ts`.
- **LaTeX export (2):** `src/main.ts` (`exportWithPandoc`,
  `exportLatexWithWriter`), `scripts/p0-unit.mjs`, `scripts/export-test.mjs`
  and existing LaTeX project tests. Keep `src-tauri/src/export.rs` and
  `src/api.ts` contracts unchanged.
- **Clipboard/paste (3):** `src/main.ts` (`imageContext`, `resolveRichImage`,
  `applyRichPaste`, `pastePlain`, `describe` and lifecycle `replace` for the
  incarnation), `src/sessions.ts` (the `incarnation` field), `src/context-menu.ts`,
  `src/images.ts`, `src/clipboard.ts` or `src/paste/` helpers only as needed,
  and `scripts/rich-paste-test.mjs`, `scripts/image-rules-test.mjs`,
  `scripts/format-document-test.mjs`.
- **Open/startup (4):** `src/main.ts` (`openPath`, `openPaths`, `loadUntitled`,
  `restoreLastTabs`, `boot`, preview link navigation), `src/document-lifecycle.ts`
  (path-queued open), `scripts/p0-unit.mjs`, `scripts/tabs-restore-unit.mjs`,
  `scripts/tabs-restore-test.mjs`, `scripts/document-tabs-test.mjs`,
  `scripts/single-instance-test.mjs`.
- **AI insertion (5):** `src/ai/assistant.ts`, `src/ai/context.ts`, `src/editor.ts`
  (the anchor-mapping state field), `scripts/ai-unit.mjs` and
  `scripts/ai-assistant-test.mjs`.
- **Cancellation (6):** `src-tauri/src/ai/mod.rs`, `src-tauri/src/ai/provider.rs`,
  `src-tauri/src/latex_native.rs`, `src/ai/assistant.ts`, `scripts/ai-unit.mjs`,
  `scripts/ai-assistant-test.mjs` and Rust unit tests in those modules. Preserve
  `ai_complete`/`ai_cancel`/`latex_native_compile`/`latex_native_cancel` shapes.
- **Preview/engine (7, 8):** `src/main.ts`, `src/html-preview.ts`,
  `scripts/html-preview-test.mjs`, `scripts/latex-preview-test.mjs` and existing
  LaTeX unit/native tests. Backend engine modules may be touched only for an
  internal cancellation/freshness issue demonstrated by those tests.
- **Auto Save (9):** `src/document-lifecycle.ts` (read-only `closing`),
  `src/main.ts` (`installAutoSave`), `scripts/p0-unit.mjs`.
- **Install/print (10, 11):** `src-tauri/src/export.rs`, `typst.rs`, `latex.rs`
  and `print.rs` as needed; existing Rust tests, `scripts/export-test.mjs` and
  `scripts/pdf-native-test.mjs`. Preserve existing command names and return
  shapes; the normal successful output remains usable by external viewers.
- **Documentation/harness (12):** this plan, the audit, affected existing guides
  and trap files. Prefer extending existing scripts. If a dedicated test script
  is necessary, add it to `scripts/test-all.mjs` and the appropriate
  `docs/agent-guide/catalog/` entry in the same change.

## Risks and rollback

- **Recovery/data loss:** do not remove or overwrite a journal until the exact
  intended text is saved or explicitly discarded. Run crash/restart scenarios
  only against a harness-owned test profile and fixtures, never the user's real
  recovery directory. Retain old format compatibility and test cancelled close.
- **Ownership and UX:** a guard that drops a paste, changes the chosen tab,
  disables valid stale AI insertion, or cancels a covered AI request would be a
  regression. Inserting into a hidden owner must keep that tab's undo history,
  dirty dot and journal correct. Assert the existing allowed cases and the
  proposed safe fallbacks.
- **Concurrency:** per-path queues must release after errors; cancellation
  tombstones must be bounded; late callbacks and old generations must not remove
  or commit a newer job. Test orderings deterministically with deferred promises
  or controlled local servers, not timing sleeps.
- **Preview and external viewers:** do not strand a frame promise, publish an
  unready frame, start a manual-mode compile, or delete a print file the viewer
  still owns. Platform file locking and viewer lifetime require real-platform
  checks; report what could not be exercised.
- **Look-alike bugs:** `cancelTypstRender` passing the current `renderToken` is
  correct (watermark semantics); `preservingLatexHandoff` is correct only while
  `displayDoc` does its `setDoc` before its first `await`. Do not "fix" the
  first, and do not add an earlier `await` to `displayDoc` without moving the
  second.
- **Shared workspace:** do not revert or overwrite unrelated in-progress changes.
  Recheck overlapping clipboard, LaTeX, dependency and build changes before each
  milestone; update the plan rather than silently changing its scope.
- **Rollback:** keep each milestone logically independent so it can be reverted
  without reverting others or user work. Preserve settings and recovery formats;
  never use a destructive reset to roll back tests or implementation.

## Tests and validation

Run the relevant cheapest layer first; do not claim whole-application behavior
from a unit test. For each demonstrated defect, make a deterministic regression
fail before its fix where feasible and pass afterwards. Also assert normal
behavior that must remain unchanged. Record test output and any exceptions in
this plan as work proceeds.

1. **App-free:** `npm run test:sessions`, `npm run p0:unit`, `npm run ai:unit`,
   `npm run preview:worker:unit`, `npm run latex:native:unit`, and the harness
   ids `tabs-restore-unit` and `test-harness-ownership-unit` where a milestone
   touches them. These need Node 24.
2. **Frontend gates:** `npm run build`, `npm run lint`, `npm run format:check`
   and `npm run knip` after relevant TypeScript changes.
3. **Rust:** focused unit tests and `npm run test:rust` for backend changes;
   on Windows invoke Cargo/Tauri through `scripts\with-msvc.cmd` or
   `scripts\cargo-vcvars.cmd`, and run `cargo clippy --all-targets -- -D warnings`
   as the Quality workflow does. Exercise applicable filesystem/process tests on
   Linux too; if unavailable, record the gap rather than claiming a pass.
4. **Isolated application:** use `npm test -- --only <suite-ids>` with the
   repository harness, its running-instance guard and test-state restoration.
   Default ids that apply: `p0-lifecycle`, `tabs-restore`, `tabs`,
   `single-instance`, `paste`, `image-rules`, `format-document`, `ai`, `html`,
   `latex-preview`, `latex-project`, `latex-native` and `pdf-native`. The opt-in
   ids are `image-path` and `export`; `export` requires an installed Pandoc, so
   run it only where Pandoc is already present and record it as unrun otherwise.
   `scripts/image-paste-test.mjs` (`npm run images`) is not in the harness; run
   it by hand with a local image server, or move its F2 cases into `paste` or
   `image-rules`. Use `--list` to confirm current ids. Do not manually delete
   real settings, prompts, credentials or recovery entries.
5. **Boundaries:** use fake/delayed clipboard and image I/O, distinct local
   project fixtures, a controlled local AI server and a stub TeX process. Never
   contact a paid provider or download/install real tools merely to make a
   regression test pass. Check actual text, bytes, paths, journal contents,
   error/cleanup state, cancellation and undo; a toast or counter alone is not
   enough.
6. **Final integration:** run the relevant combined suites and required quality
   gates after the last approved milestone. Broaden to the full `npm test` only
   if the final combined scope and repository testing rules warrant it. Record
   Windows/Linux/macOS or external-viewer checks that remain unrun.

## Acceptance criteria

- Recovery retains both drafts across all tested orderings; after every scripted
  operation the displayed session equals the store's active session and remains
  in the store, and Next/Previous Tab and new-tab placement follow it. Save or
  Auto Save removes only the correct journal after writing the intended bytes;
  cancelled close retains recovery.
- A LaTeX export started for A uses A's captured root and unsaved overlays after
  a switch to B or to a non-LaTeX tab; it never silently exports B and never
  fails because the active tab changed. The existing staged conversion and
  compiled-PDF contracts remain intact.
- Delayed clipboard/image operations never edit an unrelated document or field
  or insert a reference relative to an obsolete folder. A paste whose owner was
  hidden lands in that owner, undoable as one step; normal typing in the
  originating document retains current-caret behavior; a refused image paste
  names the saved asset; a refused clipboard-read paste can be repeated; the
  system clipboard is never written.
- Concurrent same-path opens and an open racing a Save As to the same path do not
  create duplicate sessions; startup consumes a valid blank slot at most once,
  never discards typed text or its journal entry, and releases the slot when a
  document is installed. Multi-file order and a later open after failure work as
  before.
- AI Insert/Insert below place text at mapped valid anchors and undo as one edit.
  Ambiguous/deleted anchors do not mutate the document and leave Copy/New tab
  available, and the stale message names only safe actions. Covered requests
  still complete into history; abandoned requests can be locally cancelled
  before registration, before headers and during streaming, with bounded cleanup
  and truthful terminal outcomes. A native LaTeX cancel that precedes
  registration stops that job.
- HTML is current only after the matching frame is ready and promoted; timeout,
  failure, reset and supersession cannot publish stale success or strand work.
  An engine or backend change invalidates old LaTeX work/results without
  triggering a compile in manual mode.
- Choosing Save or Discard in a close dialog closes the tab or window even when
  Auto Save runs while the dialog is open; Cancel still keeps it.
- Same-tool installs and repeated or same-stem print handoffs cannot corrupt each
  other; unrelated installs remain independent and valid print files remain
  available to external viewers.
- Relevant tests and quality gates pass, or an unavailable platform or
  pre-existing failure is explicitly recorded. The P0 harness failure is fixed
  and the real repository suite, not an in-memory substitute, is rerun.

## Open questions

- **Paste into a hidden owner:** decided 2026-11-10 — a paste lands in the tab
  it was made in, at its saved selection, with a toast naming that tab.
- **Ambiguous AI anchor:** the default is no document mutation, a clear reason,
  and Copy/New tab; mappable stale anchors remain insertable.
- **Native menu Save during a close dialog (F16):** it has the same effect as
  Auto Save but needs the reader to reach the native menu past a modal dialog.
  The default is to leave it out of this plan and record it if a test shows it.
- **Print-file cleanup:** retain completed files while external viewers may use
  them. If a bounded cleanup policy cannot be proved safe on a platform, leave
  that cleanup as a documented follow-up instead of deleting a live file.
- **Cross-platform verification:** if an installed engine, viewer or platform is
  unavailable, mark the corresponding acceptance check pending and report the
  limitation; do not substitute a mock result for a native-platform pass.
