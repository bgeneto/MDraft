# Protect document revisions, closing decisions and text-file writes

**Status:** done
**Approval:** explicit user approval on 2026-10-25; execution may proceed.
**Date:** 2026-10-25
**ADR:** [Document operation ownership](../adr/2026-10-25-document-operation-ownership.md)
**Backlog:** GAP-025, GAP-004 (P0 slice), GAP-005 (P0 slice)
**Basis:** [backlog audit](../backlog-audit-2026-10-25.md) and
[revised backlog](../backlog.md)

## Context and goal

The audit reproduced three failures in the document shell: a completed save
marks newer typing clean and forgets recovery; an automatic reload applies a
read after the reader started typing; and Save As continues using the current
global tab rather than its initiating session. These failures remain in the
read-only recheck of `0.4.7`, HEAD `2647311`.

Two other open P0 scopes remain: native two-button unsaved prompts interpret
dismissal as discard, and `read_document` decodes arbitrary bytes lossily before
allowing a later write. Recovery does not protect work whose entry these paths
explicitly remove. Concurrent source work, including About text in `main.ts`,
is outside this plan and must be preserved.

Fix all three open P0 items with reproducible tests, preserving the existing
session/recovery model, supported text behavior and completed P0 foundations.
Explicit approval under AGENTS.md was received before source edits.

## Scope and non-scope

**In scope**

- GAP-025: ownership/revision guards for in-place save, Save As, automatic and
  explicit reload, conflict reload, and their close/Auto Save callers. Review
  adjacent asynchronous operations for the same mutable-global ownership bug;
  fix direct instances within these document lifecycle paths.
- Serialization of competing document saves and safe temporary-write handling.
- GAP-004 P0: Save / Discard / Cancel for tab, bulk, window close and destructive
  reload decisions; Escape/dismissal cancel. Wait for relevant pending writes
  and revalidate decisions before removing tabs, recovery or the window.
- GAP-005 P0: refuse binary and unsupported-encoding input before a text tab is
  created, protect legacy lossy recovery buffers, and refuse accidental writes
  over non-text/unsupported-encoding destinations.
- Deterministic unit/IO tests and an isolated real-UI lifecycle suite registered
  in the existing harness; reader documentation, ADR and backlog records.

**Out of scope**

- Save All as a new user command (GAP-004 P1), workspace/file-management UI,
  large-file budgets (GAP-005 P1), UTF-16/legacy decoding (GAP-021), stronger
  content-based external-writer validation (GAP-032), printing/export repairs,
  saved-version history and the remaining P1/P2 backlog.
- Rewriting CI or adding the general crash/relaunch project from GAP-027.
  Reproducing regression tests for the P0 fixes are included now.
- New runtime dependencies, settings/recovery schema changes, command names,
  argument/return shapes, menu events or accelerators. Existing recovery files
  and four-argument `write_document` callers remain compatible.
- Converting Preferences into a modal. It intentionally remains a non-modal card.

## Approach and rejected alternatives

### Session ownership and revision checks

Add a small `src/document-lifecycle.ts` controller with injected IO, session and
UI callbacks, so the code used by the shell is directly testable without the
webview. Rust retains filesystem ownership; `main.ts` retains app chrome and
editor rendering. Do not move unrelated shell responsibilities.

Give sessions a runtime-only monotonic content revision. Increment it on live
document changes, undo/redo, background formatting and document replacement.
A snapshot captures the session object/id, path, revision, text, baseline and
write-format metadata. Every completion checks that the session still exists
and that the relevant identity/revision has not changed.

Serialize save/Save As work per session and competing destination. Revalidate
the path/baseline when queued work actually starts. Record the exact written
snapshot as `savedContent`; clear dirty/recovery only when current text still
matches it. Otherwise retain newer editor state and reschedule recovery with
the new disk baseline. A write failure keeps text and recovery intact.

Save As captures its initiating session before the dialog. It uses that
session's text, not whatever the shared editor later displays. Adopt successful
write metadata on that session without reading old disk bytes back over newer
typing. Update the active view only if that session remains active; preserve
background state, undo and the reader's chosen active tab. Revalidate any
already-open target before replacing it; a changed/dirty target cannot disappear
because an earlier answer became stale.

For disk reads, check session/path/revision again before applying the result.
If a previously clean buffer became dirty, preserve it and expose the existing
conflict actions. Discard obsolete metadata-only/matching-content responses too
when their initiating baseline is no longer current. Prevent overlapping poll
passes from applying stale results. Explicit Reload/conflict actions bind to
the initiating session and the revision the reader agreed to replace.

Use unique, exclusively created temporary siblings in Rust rather than the
current path-plus-process-id name shared by competing writes. Keep atomic
replacement, BOM/EOL behavior and error cleanup. This does not claim to solve
GAP-032's separate external-process compare/write race.

### Explicit unsaved-work decisions

Add `src/unsaved-dialog.ts` for an in-app modal with explicit `save`, `discard`
and `cancel` results. Use a native HTML modal dialog with accessible labeling,
safe Cancel focus, Escape/dismissal handling and focus restoration; validate it
on the published webviews. A close-request gate prevents duplicate dialogs and
reentrant window close. The existing native final close path remains intact.

Capture the affected sessions and approved revisions. For bulk/window close,
collect decisions and finish required saves before applying discards/removals.
If a later prompt is cancelled, all tabs remain; earlier successful saves need
not be undone, but no uncommitted discard removes recovery. Recheck for newer
edits/new dirty sessions before final close. A changed revision aborts or asks
again; Save As cancellation, conflicts and failed saves abort the close.

Await pending writes and necessary recovery cleanup in the finalization path.
Only an explicit Discard authorizes removal without a successful save. Keep
the existing remembered-tabs/settings flush and clean WM_CLOSE behavior.

### Non-text and legacy lossy-file protection

In `documents.rs`, classify bytes before normalization: recognize UTF-16/32
BOMs before NUL detection and refuse them with an unsupported-encoding message;
reject known binary/image/archive signatures and non-text control patterns;
require valid UTF-8. Valid UTF-8 text with supported whitespace, Unicode, a
UTF-8 BOM and unknown text extensions continues to open. Choose conservative
signature rules and test text that contains signature-like prose/code.

Use the existing `Result` error path, not a new IPC payload. Reuse the private
validation for an existing destination before atomic replacement, so Save As
and legacy recovered binary buffers cannot bypass the boundary. Keep image
drop/import routed through its existing image pipeline. No OS application is
launched automatically merely because a file was refused.

Existing recovery entries with `lossy: true` still restore their text. Auto Save
must leave them dirty/journaled and visibly blocked. Manual save offers an
explicitly explained UTF-8 copy route; the unsupported original is never
rewritten by default. Cancelling preserves everything. A chosen copy target
must pass the same destination guard; same-path Save As is not a bypass.
Full in-place encoding conversion remains GAP-021, not this safety patch.

### Rejected alternatives

- Marking every successful write clean, or checking only `dirty` before an
  await: both are exactly the reproduced loss paths.
- Merely capturing global `doc` in Save As: ownership alone does not protect
  newer text, destination collisions or pending close.
- Blocking normal typing while saving: unnecessary and poor on slow storage.
- Debouncing saves without serialization: completion order can still invert.
- Keeping a two-button prompt or asking a second confirmation after dismissal:
  the decision remains ambiguous and is difficult to test through the real UI.
- Relying on filename filters or a lossy-decoding toast: Open/drop/recovery and
  background saves need enforcement at the actual read/write boundaries.
- Adding encoding libraries or a generalized workspace framework: neither is
  needed for these P0 fixes.

## Steps

- [x] Add deterministic regression cases reproducing the three async failures
      and protect their assertions during the controller extraction.
- [x] Add runtime session revisions and the narrow lifecycle controller; wire
      live/background mutations and preserve all existing session behavior.
- [x] Fix in-place/Auto Save serialization, written-baseline adoption and
      recovery retention for newer edits and failures.
- [x] Fix Save As session ownership, target collision revalidation and
      preservation of newer text/undo/background state.
- [x] Guard automatic, explicit and conflict reload against newer revisions,
      tab changes, pending writes and overlapping disk polls.
- [x] Add the three-way unsaved dialog and gated tab/bulk/window close/reload;
      commit discards only after the operation is safe to finish.
- [x] Add Rust text/binary/encoding refusal, destination validation, unique temp
      siblings and byte/IO regression fixtures; protect old lossy recovery saves.
- [x] Add/register the real-UI P0 lifecycle suite in the existing harness and
      document its command, fixture, isolation and check count.
- [x] Write the ADR and update reader docs, plan validation and backlog slice
      records; do not mark GAP-004/005 entirely done while later slices remain.
- [x] Run the validation sequence below, repair relevant failures and record
      any non-obvious traps before marking this plan done.

## Files and modules

| File/module | Purpose |
| --- | --- |
| `src/document-lifecycle.ts` (new) | Testable operation snapshots, queues, guarded read/write completion and close coordination |
| `src/sessions.ts` | Runtime revision field/default; no persisted schema change |
| `src/main.ts` | Controller integration, mutation revisions, UI/recovery callbacks and guarded lifecycle routes |
| `src/unsaved-dialog.ts` (new), `src/styles.css` | Explicit accessible Save/Discard/Cancel modal and styling |
| `src-tauri/src/documents.rs` | Private byte/destination validation, unique atomic-write temporaries and Rust tests |
| `scripts/p0-unit.mjs`, `scripts/sessions-test.mjs` | Delayed-I/O/controller, close policy, revision and recovery regression cases |
| `scripts/p0-lifecycle-test.mjs` (new) | Real editor/dirty state, tab switches, close modal and refused-file UI checks |
| `scripts/test-all.mjs`, `package.json` | Register the isolated UI layer and `p0:lifecycle`; no dependency changes |
| `README.md`, `docs/guide.md`, `AGENTS.md` | Actual safety/encoding limits, script map, test counts, code map and applicable traps |
| `docs/adr/2026-10-25-document-operation-ownership.md` | Durable ownership/IO-boundary decision after approval |
| This plan, `docs/backlog.md` | Validation/deviations and delivered P0 slices with remaining P1 ownership |

No unrelated formatting or edits to concurrent paste/About work are included.
If source discovery requires widening this list or changing a public payload,
update the plan and obtain approval for that scope before implementing it.

## Risks and rollback

- A revision counter missing a background mutation would make stale reads look
  current; audit every direct `EditorState`/draft replacement and test undo/redo.
- A queue can deadlock if Save As calls its own queued save recursively; keep
  queue ownership explicit and test cancellation, reentry and competing paths.
- Programmatic `setDoc` emits change callbacks; adopt baselines and revisions in
  an order that does not forget newly scheduled recovery.
- Strict decoding changes unsafe permissive behavior; provide accurate messages,
  keep UTF-8/BOM/EOL/unknown text files working, and preserve legacy recovery.
- Temporary sibling creation/rename semantics differ on Windows/Linux. Test
  failures and concurrency on both without writing over real documents.
- Closing has native events, pending writes and modal state; test final close as
  well as cancellation. Never force-close the developer's running instance.

Rollback is a focused revert of this implementation's changes, preserving
concurrent edits and recovery files. No migration or cleanup of the user's
settings/journal is part of rollout or rollback.

## Tests and validation

1. Run the new deterministic cases against the current behavior to establish
   that the tests detect the audited failures; after integration run
   `npm run p0:unit` and `npm run test:sessions`.
2. Run targeted Rust byte/atomic-write tests through
   `scripts\cargo-vcvars.cmd`, then `npm run build`, the full Rust suite,
   `npm run lint`, `npm run format:check` and `npm run knip`. Format only files
   owned by this implementation; report pre-existing unrelated failures.
3. Run the registered P0 lifecycle UI suite with the real editor and delayed
   IPC responses. Assert disk bytes, current text, dirty marks and recovery;
   restore interception hooks on every exit. Use normal user/menu routes, not
   production-only test commands/globals.
4. Run `npm test` in the repository's layer order with its isolation/backup and
   restoration, covering smoke, tabs, tab/favorite restore, rich paste, HTML,
   AsciiDoc and Typst regressions plus the new layer. Do not use `--kill` to
   close a user's instance. Run the release WM_CLOSE check after this close-path
   change. Test image import/drop still works and mixed drops retain valid docs.
5. Run the platform-specific Rust and close/dialog checks on Linux as required
   by AGENTS.md; record any unavailable environment explicitly rather than
   claiming unperformed platform validation. Repeat only after relevant changes
   or unresolved failures.

Use throwaway documents and owned test state/profile. Crash probes, if needed,
terminate only a disposable instance. Every command/check/result and justified
deviation is recorded here during execution. No application tests were run as
part of creating this draft.

## Acceptance criteria

- All three audited async scenarios preserve the correct document, newer text,
  dirty state and recovery; second saves write the final text exactly.
- Save As in A cannot mutate B, including switches during dialog/write/metadata
  completion and cases where A is no longer active.
- Automatic/explicit/conflict reload cannot erase edits made during a pending
  read. A pending save/poll cannot falsely clean or redirect a session.
- Cancel, Escape, dismissal, Save As cancellation, conflicts and write failures
  leave affected tabs/window and unsaved recovery intact. Only successful saves
  of the accepted revision or explicit Discard permit final removal/close.
- PDF/DOCX/ZIP/images/invalid UTF-8/NUL binaries cannot become editable lossy
  tabs or be silently rewritten; UTF-16/32 get an encoding explanation. UTF-8
  text, BOM/EOL and image import continue working.
- Legacy lossy recovery remains recoverable, Auto Save cannot overwrite its
  original, and an acknowledged UTF-8 copy can be saved safely.
- No new dependency, network behavior, public payload or persisted schema;
  completed recovery/conflict/Typst behavior stays covered.
- The plan's checks pass, with real UI and platform limits stated accurately;
  GAP-025 is closed only when its accepted scope is verified. GAP-004/005 move
  to their remaining P1 slices rather than incorrectly disappearing.

## Open questions

None requiring additional product input beyond approval of this concrete scope.
Defaults are strict refusal for unsupported new input, an explicitly acknowledged
UTF-8 copy for legacy lossy buffers, an in-app three-way modal for destructive
decisions, and no P1 feature expansion. Any implementation-driven scope change
will be recorded and approved before it is made.

## Execution record

- Explicit user approval received on 2026-10-25; implementation started.
- Re-ran the three original deferred-IPC probes before source edits: all three failures reproduced.
- Controller/helper/export tests: 99/99; session tests: 60/60.
- Targeted Windows document Rust tests: 12/12 with workspace TEMP/TMP.
- Frontend build, TypeScript, ESLint and knip pass; Vite build requires the documented sandbox escalation.
- UI lifecycle suite: 30/30; final GTK close/dialog checks: 8/8.
- Conservative collision policy: Save As refuses a destination already owned by another open tab, preserving both buffers rather than trusting a stale overwrite confirmation.
- Adjacent-operation review found the same mutable-global identity issue in
  HTML/Print/Pandoc exports. Within the approved ownership-review scope, these
  routes now capture their initiating text/name/path/language/resource base
  before the first await. All nine new deferred-export assertions fail against
  HEAD and pass after the fix; no browser-output/native-print feature was added.
- Clean-close integration initially failed after the license layer, while
  passing alone. The title/journal identified a restored license buffer, not a
  native permission failure: CRLF bundled text had a different baseline from
  CodeMirror's LF text, and the clean-close layer inherited prior recovery.
  Normalize untitled baselines and reset the owned close-test state; retain
  independent dirty-window tests. Record both lessons in AGENTS.md.
- GTK testing exposed focus lost by the short inert commit phase after closing
  the final dirty tab. Restore connected prior focus or the replacement editor.
  The final GTK probe passes all eight checks, including native close and window
  state. The ignored probe uses only its own PID/XDG state and is removed after use.

### Final validation results

- `npm run build`: TypeScript and bundled frontend pass; release binary built
  with `scripts\cargo-vcvars.cmd build --release --manifest-path
  src-tauri\Cargo.toml --features tauri/custom-protocol` (embedded frontend).
  Final functional-test binary SHA-256 prefix: `b90e5930599a`.
- `npm run test:sessions`: 60/60. `npm run p0:unit`: 99/99, including the real
  lifecycle controller and actual shell export functions with deferred IO.
  All nine new export assertions fail against HEAD `2647311`; the three original
  lifecycle failure probes were reproduced before editing source.
- Windows Rust: 124 passed, 2 ignored downloads; Linux Rust: 123 passed,
  2 ignored downloads. The 12 targeted document tests pass. Windows
  `cargo clippy --all-targets -- -D warnings` passes through the MSVC wrapper.
- The full default 35-layer run was executed: 34 passed and clean close exposed
  the inherited-journal/CRLF issue above. After the focus fix, the affected
  smoke (107), image syntax (22), image rules (28), shortcuts (43), tabs (106),
  tab restore (25), favorites restore (30) and licenses (4) layers passed; the
  repeated close failure identified the remaining test-state interference.
- After both fixes and export ownership integration, the final command
  `node scripts/test-all.mjs --only p0-unit,p0-lifecycle,asciidoc,typst-preview,html,licence,close,export --no-build --keep`
  passes **8/8 layers**: 99/99, 30/30, 54/54, 52/52, 60/60, 4/4, 4/4 and 38/38.
  Logs are retained in `T:\Temp\mdraft-test-kHGaHT\logs`; each test used its
  owned temporary documents/profile, and the harness restored developer state.
  This is a final affected-layer rerun, not a claim of rerunning all 35 layers
  after the last small change. The broader run's 8 native clipboard checks were
  explicitly skipped because that session could not own the clipboard.
- Linux/WSL Debian: rebuilt with the final embedded frontend and ran eight
  native X11/GTK checks: owned window, typing/recovery, Escape cancellation,
  Save bytes, original-tab closure, native-window cancellation, explicit
  Discard and clean native exit/window-state persistence. GTK has no CDP;
  the Windows-only CDP suite is not claimed as a Linux run.
- ESLint, knip, all owned-file Prettier checks and `git diff --check` pass.
  Global `npm run format:check` still fails only on the pre-existing committed
  formatting in `scripts/typst-preview-test.mjs`; its HEAD version also fails
  Prettier. That unrelated file was preserved.
- Backlog verification: 33 unique IDs/triage rows, matching detailed metadata,
  valid local links/references, no known open P0. GAP-025 is done; GAP-004/005
  stay open at P1 for their explicitly retained slices. ADR, reader docs,
  audit follow-up, script counts and traps are updated. Existing About copy is
  preserved. No dependency, command payload or persisted schema changed.
