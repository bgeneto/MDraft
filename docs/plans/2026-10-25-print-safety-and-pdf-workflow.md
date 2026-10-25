# Correct print safety, shortcuts and Typewriter Mode

**Status:** done — corrective code and Windows interaction verified; remaining platform evidence is explicitly tracked below and in the backlog
**Approval:** explicit user approval on 2026-10-25: “sim, aprovo!”. All stages,
including conditional Typewriter removal, are authorized; retain all three PDF routes.
**Date:** 2026-10-25
**ADR:** a new print-operation/output-policy ADR will supersede the affected
decisions in `../adr/2026-10-25-native-print-surface.md`; the historical ADR and
completed native-print plan will remain as records.
**Backlog:** GAP-009, GAP-032, GAP-027, GAP-026, GAP-019, GAP-015,
GAP-012 and the missing GAP-017 ADR.
**Evidence:** [implementation review](../backlog-review-2026-10-25.md), R-01–R-06.

## Context and goal

The review reproduced deletion of a pre-existing PDF when the native writer
fails, document scripts running in a child frame of the nominally script-free
surface, two simultaneous exports interrupting each other, a hash conflict
notice removed by polling, unsafe test handoff to an installed application and
protocol-relative network references resolving as file URLs.

The owner has requested that the P0 be corrected first without losing the other
findings, and reports that Ctrl+P produces no visible result. The export menu
also exposes three PDF entries whose differing purpose was not clear. The owner
has now explicitly chosen to **retain all three routes**, and also reports a
non-working Ctrl+Shift+0 reset and Typewriter Mode. Typewriter must be verified
visually during typing; if it cannot be made reliable, its complete removal is
authorized as the fallback.

Deliver the P0 as the first independently verifiable stage. Keep the other
findings as explicit unfinished steps until repaired and validated. Preserve
the PDF menu and engines; fix their implementation and the reported controls.

## Scope and non-scope

**In scope**

- R-01 first: native PDF output uses an exclusively owned temporary sibling,
  verifies the generated file and replaces the chosen target only on success.
  Errors clean only owned temporary output, including failures before writing.
- R-02/R-03: enforce the script policy for child frames/active embeds, and
  serialize or exclusively own print operations so a second request cannot
  destroy an active surface.
- Diagnose and fix Ctrl+P through the complete route: real key event, frontend
  dispatch, article readiness, host print API, visible/foreground dialog,
  completion/cancellation and surface lifetime. Do not equate shortcut
  registration or a successful API invocation with a usable print dialog.
- Preserve PDF…, PDF (opens browser)… and PDF (via Typst)… as three distinct
  choices, per the owner's latest instruction. No menu consolidation is planned.
- Reproduce and fix reset via actual Ctrl+Shift+0, including shifted digits,
  keyboard layout/OS interception and focus in editor/preview/HTML guest. Reset
  must change only document zoom and preserve Content Width/base font settings.
- Make Typewriter Mode keep the primary caret near the viewport centre during
  real typing, with visual proof; otherwise remove the feature completely while
  keeping old settings files loadable. Do not leave a dead toggle or shortcut.
- R-04: preserve a content-detected conflict across unchanged-stat polls.
- R-05: prevent shared-identifier tests from touching or forwarding to an
  existing user installation before any backup/reset/launch.
- R-06: define explicit network URL publication from a file-origin output;
  preserve the separate UNC path policy.
- Correct stale backlog/plan/docs statements, add the missing handoff ADR and
  record completed stages plus remaining platform verification accurately.
- Improve test prerequisite detection: all required Poppler tools, selectable
  WSL measurement and an available Typst for renderer-specific checks.

**Non-scope**

- New PDF renderer, editor architecture, workspace features or generalized
  offline packaging (GAP-033).
- Rewriting release CI, publishing a release, installing dependencies globally,
  closing the user's running application or changing its settings.
- A new settings schema or deletion of configured export formats. Existing
  format IDs, custom options and callable menu IDs should remain compatible
  where possible; any unavoidable payload change must be recorded first.
  If Typewriter is removed, old persisted values must still load as deprecated
  input without retaining a nonfunctional user-facing feature.
- Claiming that typeset conversion and preview-faithful printing have identical
  output, or that a print dialog provides a final output path.

## Preserved PDF workflow

| Entry | Behavior |
| --- | --- |
| File > Print… / Ctrl+P | Opens an actual usable print dialog. Failure or unsupported content yields an actionable explanation/fallback, never silent completion. |
| File > Export > PDF… | Native PDF from the assembled HTML article on the supported source types. |
| File > Export > PDF (via Typst)… | Preserves the existing typeset conversion route and direct compilation of Typst sources. Existing format configuration survives. |
| File > Export > PDF (opens browser)… | Keeps browser printing as an explicit choice and as a fallback when needed. |

Keep the existing Typst-specific availability/reasons explicit. Validate Ctrl+P
on supported documents and make unsupported contexts explain the available
action. Do not silently return or add an unimplemented control. No new Typst
printing engine is required by this corrective scope.

## Approach and rejected alternatives

### Stage 1: target preservation

Keep filesystem ownership in Rust. Generate PDF into a unique sibling on the
destination volume, reserved exclusively by the operation. Close any reservation
handle before the platform writer uses it. Verify the writer result and the
generated PDF before replacement. A small ownership guard cleans only that
temporary file on every failure; it never infers ownership from the final path.
Retain the old target if preparation, platform writing, verification or final
rename fails. No new runtime PDF parser is proposed; state the limits of the
lightweight verification and use Poppler in tests for actual readable outputs.

Reject direct writes followed by unconditional deletion, a backup made only
after truncation, and a system-temp file renamed across volumes.

### Stage 2: print-operation and interaction ownership

Reproduce Ctrl+P on an owned build/profile before choosing the exact platform
fix. Inspect native windows as well as CDP: native dialogs are outside the
webview screenshot. The current hidden/unfocused surface and immediate cleanup
after `ShowPrintUI` require lifetime/ownership validation; neither is assumed to
be the confirmed cause yet.

The Microsoft API documents ShowPrintUI as opening a dialog, not as reporting
that the user completed printing. Primary API reference:
https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_16
Vendor tracker reports of hidden/behind-window dialogs are diagnostic leads,
not proof of the MDraft cause:
https://github.com/MicrosoftEdge/WebView2Feedback/issues/3361 and
https://github.com/MicrosoftEdge/WebView2Feedback/issues/5743.

Give each operation explicit lifetime and ownership; queue competing jobs or
reject the second request visibly without disturbing the first. Enforce the
no-document-script policy structurally and at the surface boundary, including
subframes/objects and encoded content. Keep host readiness instrumentation
possible without enabling document code. Preserve the unprivileged IPC boundary.

Reject a longer arbitrary timeout as the only print-dialog fix, changing the
three PDF choices against the owner's instruction, or regex-only script detection.

### Stage 2b: reset and Typewriter interaction

The current accelerator matcher already considers `KeyboardEvent.code` for
`Digit0`, so do not assume changing `event.key` aliases alone fixes reset.
Observe actual key delivery on the host, keyboard layout and focused surface.
Do not change the user's OS shortcuts or install a global keyboard hook.
If the OS consumes the chord, record that evidence and use an honest usable
binding/description rather than advertising a chord the app cannot receive.

Typewriter currently runs only for `selectionSet && !docChanged`, explicitly
excluding typing. Use a coalesced, revision-aware centering update after actual
document/primary-selection changes, with sufficient scroll space at the start
and end. Avoid scroll feedback loops, stale callbacks after tab changes and
jumps during IME composition. Manual scrolling remains undisturbed until the
next deliberate editing/caret action.

Visual acceptance requires screenshots and actual key/text input in an owned
test window, plus measured caret/viewport geometry. It is not satisfied by the
F9 flag, a checked menu item or a synthetic DOM event alone. Use the
computer-use skill's Windows selection/focus/capture workflow for the visual
check, alongside the existing CDP regression harness. A locked or unavailable
desktop is a validation blocker, not evidence that the feature works and not
by itself a reason to remove it.

If a reliable implementation cannot meet these criteria, remove Typewriter
from menus, F9 registration, Preferences/status flags, active editor logic,
help/docs and tests that promise the feature. Keep only compatibility needed
to load old settings; no dead UI remains. Record which outcome was delivered.

### Stage 3: remaining review corrections

Keep the content conflict until an explicit resolution or a sufficiently strong
revision validation. A same-stat poll is not proof that a hash mismatch vanished.
Before any test-state mutation, detect all running instances of the same
identifier, including Program Files/portable installations; use a consistent
disposable identifier for concurrent audit execution rather than killing a
user process. Publish remote protocol-relative references as explicit network
URLs under a documented policy, without reclassifying UNC filesystem paths.

## Ordered steps

- [x] Reproduce R-01 with existing-target byte assertions; implement protected
      temporary PDF output and tests for pre-write/write/verification/rename
      errors plus success. Finish and record this P0 stage before later work.
- [x] Put all review findings and the Ctrl+P report under active tracking in the
      backlog; preserve the 33 existing feature IDs and historical plan records.
- [x] Make the test preflight safe around an installed/running instance before
      further interactive regression runs (R-05).
- [x] Reproduce Ctrl+P with the real editor/preview and inspect native dialog
      visibility, ownership and completion; record the actual root cause.
- [x] Fix print surface lifetime, operation concurrency and nested-script policy
      (R-02/R-03), with the review's adversarial cases.
- [x] Preserve the three PDF routes and verify that each retains its intended
      behavior after the print fixes; update only inaccurate explanations.
- [x] Reproduce Ctrl+Shift+0 with actual input and fix zoom reset without changing
      Content Width; test the editor, preview and HTML guest routes.
- [x] Fix Typewriter typing/scroll behavior and confirm it visually at the start,
      middle and end of a document, including wraps and Focus mode; if it cannot
      be made reliable, remove it completely as authorized above.
- [x] Fix the hash-conflict poll behavior (R-04) and file-origin network URL
      publication (R-06), each with a reproducing test.
- [x] Improve Poppler/Typst prerequisite diagnostics and repeat affected layers.
- [x] Complete the handoff ADR and remove stale current-tense backlog evidence;
      distinguish code delivered, verification pending and actual outstanding work.
- [x] Validate Windows/Linux affected paths, record limits/traps and mark only
      verified stages complete. Record CI execution only when it actually runs.

## Affected files and modules

| Module/files | Reason |
| --- | --- |
| `src-tauri/src/print.rs` | Owned temporary output, platform dialog lifetime, operation serialization and surface policy |
| `src/main.ts`, `src-tauri/src/menu.rs` | Print/shortcut dispatch, accurate availability/feedback and any authorized Typewriter removal; retain the PDF menu routes |
| `src/api.ts`, `src-tauri/src/export.rs` | Only if needed for compatible print outcomes or direct Typst dispatch; no gratuitous API reshaping |
| `src/html-preview.ts`, `src/markdown.ts` | Script-safe print assembly and fallback classification |
| `src/document-lifecycle.ts`, `src/export-paths.ts` | R-04 conflict persistence and R-06 publication policy |
| `src/preferences.ts`, `src/content.ts` | Truthful menu/help/export descriptions |
| `src/editor.ts`, `src/styles.css` | Typewriter centering, scroll space, focus and visual behavior |
| `src-tauri/src/settings.rs` | Only if Typewriter removal requires backward-compatible handling of its old persisted value |
| `scripts/p0-unit.mjs`, `scripts/p0-lifecycle-test.mjs` | Conflict regression assertions |
| `scripts/pdf-native-test.mjs`, `scripts/pdf-visual-check.mjs` | Negative native cases, actual output checks and prerequisite selection |
| `scripts/menu-test.mjs`, `scripts/shortcut-test.mjs`, `scripts/export-paths-unit.mjs`, `scripts/export-browser-test.mjs` | Menu/real shortcut and URL behavior |
| `scripts/export-test.mjs` | Existing optional regression must explicitly select browser PDF after native PDF became the primary action; preserve its currency/math checks |
| `scripts/typewriter-test.mjs` (new, if retained), `scripts/dom-smoke.mjs` | Actual typing, caret geometry, manual scroll, wraps, Focus mode and retained screenshots; remove obsolete promises if the feature is removed |
| `scripts/test-all.mjs`, `scripts/test-close.ps1` | Safe instance preflight and consistent owned test state |
| `AGENTS.md`, `README.md`, `docs/guide.md`, `docs/export.md` | Updated behavior, scripts/counts and actual traps |
| Backlog/review, this plan and relevant ADRs | Tracking, corrected conclusions and durable decisions |

## Risks and rollback

- Windows and Linux replacement/permission rules differ; use a sibling on the
  same filesystem and prove preservation when final replacement fails.
- Dialog ownership/focus and completion differ across WebView2/WebKitGTK. A
  visible dialog must retain its content/surface until it is safe to dispose it.
- More restrictive static HTML classification can invoke fallback more often;
  never silently remove content and claim equivalent output.
- Preserve old export settings/custom formats and the three existing PDF choices.
- Keep the P0 fix independently reviewable. Roll back later menu changes
  separately if needed; never restore the unconditional target deletion.
- Preserve the owner's concurrent About-copy change and the existing review
  documentation. No user process is closed for testing.

## Test and validation strategy

1. Start with Rust failure-injection and temporary-target byte tests for the P0.
   Run through the MSVC wrapper on Windows and run equivalent Rust tests on Linux.
2. Run controller/URL unit cases and TypeScript/build/lint/format/knip/Clippy as
   appropriate to changed code; update test counts rather than inventing passes.
3. Owned UI runs: actual Ctrl+P from the editor, rendered preview and HTML guest;
   native-window visibility/foreground and cancel/print lifecycle. Menu registry
   assertions alone do not satisfy this check. Exercise available Typst behavior.
   Exercise actual Ctrl+Shift+0 at 150%/300% and verify 100% with unchanged width.
   For Typewriter, capture before/after real typing across multiple lines and
   wrapped lines at three document positions, repeat with Focus mode, and assert
   the primary caret stays in the central band without idle/manual-scroll pull.
   Cover IME/multi-cursor/undo, reduced motion, mode disable and tab switches.
4. Repeat the review probes: nested base64/local scripted children, concurrent
   print/PDF, a same-stat conflict surviving subsequent polls and an existing
   installation that the harness must leave untouched.
5. Run native/browser PDF, exports, menus/shortcuts and affected language/zoom/
   tab/close layers using the existing isolation conventions. Use a distinct
   identifier when the owner's installed application stays open.
6. Poppler must inspect real generated PDFs; keep page artifacts for visual
   review. Distinguish missing prerequisites, statistical metrics and human review.
7. Follow AGENTS testing/platform requirements for the final change; record
   skipped/unavailable cases explicitly and never close a GAP by test count alone.

## Acceptance criteria

- The original destination's bytes survive every failed native PDF operation;
  only verified successful output replaces it, and owned temporaries are cleaned.
- Ctrl+P opens usable print UI or gives a clear supported action/failure route;
  it cannot silently return after only a preparation toast.
- All three current PDF choices remain, with their distinct behavior intact.
- Reset works through a real usable shortcut and restores 100% without changing
  Content Width or the chosen base font sizes; any OS interception is explicit.
- Typewriter is either reliable during real typing and visually demonstrated
  with retained screenshots/geometry, or fully removed with old settings still
  loadable. A checked toggle alone never counts as completion.
- Nested document code cannot run on the native surface; simultaneous requests
  cannot destroy or substitute one another's content.
- Hash-detected conflicts remain actionable across unchanged-stat polls.
- Test runs cannot forward fixtures to or reset the state of a running user app.
- Published network references resolve to the intended network resource from
  `file:` output, while UNC references retain their filesystem meaning.
- Every review finding is resolved and tested or remains explicitly open with
  a reason; no pending finding disappears when the P0 stage is completed.

## Open questions

No additional product choice is needed: the owner has settled retention of all
three PDF routes and authorized complete Typewriter removal if a reliable fix
cannot be delivered. The owner approved this concrete plan on 2026-10-25.
The exact Ctrl+P platform fix follows reproduction, not an assumed root cause.
Any newly required dependency/public payload change outside this plan will be
recorded and brought back for approval before implementation.

## Execution record

- Approved explicitly on 2026-10-25; started with R-01 before later fixes.
- R-01: native writing now owns an exclusively reserved sibling, verifies its
  PDF envelope and renames only after success. Only that sibling is cleaned on
  failure. The former final-target deletion was removed.
- Windows targeted print tests: 13/13, including pre-write failure, partial
  output, invalid/truncated successful output, replacement failure, successful
  replacement and exclusive reservations. Subsequent full runs passed 154 Rust
  tests on Windows and 153 on Debian (2/3 ignored respectively), including the
  added first-position policy test. Clippy passed on both platforms.
- R-02/R-03: parsed active-content classification includes templates, decoded
  URLs, frames and objects. Rust adds CSP before article markup and confines
  navigation. A mutex owns the surface through the whole job. The expanded
  native suite passed 21/21, including actual PDFs with parent/child script
  markers absent, two deliberately overlapping jobs retaining distinct content,
  and an existing destination surviving preparation failure.
- R-04: unit assertions and the real UI prove that an unchanged-stat poll does
  not erase the hash mismatch. `p0:unit` 112/112; `p0-lifecycle` 35/35.
- R-05: preflight checks all MDraft executable paths before state mutation,
  fails closed on inspection errors, and cannot be bypassed by `--kill`. A safe
  external-path process fixture named mdraft.exe was refused (exit 2), remained
  alive and left settings byte-identical; only the owned fixture was then stopped.
- R-06: `//host` publishes as explicit HTTPS, while backslash UNC remains a file
  path. Export path tests passed 44/44; browser output tests passed 21/21.
- Typewriter retained: the plugin now centers after document/primary-selection
  changes, coalesces layout, supplies end padding, defers composition and cancels
  stale work on tab replacement/destroy. Normal suite 21/21; completed visual
  hold 22/22. Real Windows text input, wrapping and Enter were observed with
  caret fraction 0.49966. Captures are retained in
  `node_modules/.cache/mdraft-typewriter-visual-final` and
  `node_modules/.cache/mdraft-interaction-confirmed`.
- Shortcut deviation, justified by actual trusted events: Windows consumed
  Ctrl+Shift+0 before delivering the digit. Ctrl+0 is already Normal Paragraph.
  The canonical reset is therefore Ctrl+Alt+0, with the legacy Ctrl+Shift+0 alias
  retained wherever delivered. A physical Ctrl+Alt+0 reset 150% to 100%; the
  registered suite also verifies Content Width stays unchanged.
- Print lifetime diagnosis: real Ctrl+P reached print_native. Destroying the
  surface on ShowPrintUI return left no usable UI and later produced Windows's
  `Print failed` message. Keeping its visible owner alive produced an actual
  `Microsoft Edge WebView2 - Print` window with printer/settings/Print/Cancel.
  During the final run the native dialog closed, the remaining MDraft preview
  was closed with its X, and `get_all_windows` returned only main. The editor
  stayed usable. Sky cannot operate the Explorer-hosted system dialog directly
  (`window is not a usable app window`); it was not reported as a product failure.
- Final physical shortcut checks: Ctrl+Alt+0 restored 150% and 300% to 100% in
  the editor, and restored 150% in both Markdown Preview-only and the HTML guest.
  With the iframe focused, Ctrl+P forwarded exactly one native invocation with
  the static HTML source; Markdown preview forwarded its own article. For these
  focus-routing checks only, the native call was captured to avoid reopening
  the system dialog; the actual native UI had already been observed from the
  editor. The temporary capture/hooks were removed before suite cleanup.
- Debian display-owned WebKitGTK produced real output with the protected policy.
  The adverse script fixture passed 15/15 Poppler checks. The application's full
  captured quality article passed 36/36, two A4 pages with embedded fonts,
  selectable prose, mathematics, table rules and image/diagram colours. Both
  Windows and Linux page PNGs were visually inspected. Only file URL drive
  prefixes were translated to WSL mount paths for the Linux article fixture.
- Full Windows regression: **42/42 default layers passed**, recorded in
  `node_modules/.cache/mdraft-full-regression.log`. The final taskbar visibility
  and adversarial-doctype adjustments were then built as `52c325e1e478` and
  rechecked: Typewriter/manual hold 22/22, native PDF 21/21, print unit 14/14
  Windows and Debian, plus Clippy on both platforms. The final Debian quality
  probe again passed 36/36; its first-page PNG pixels were unchanged from the
  inspected page. Format/lint/knip all passed.

## Remaining platform evidence outside this corrective delivery

The optional export run exposed a stale test selector and Preferences copy:
the primary PDF action is native, while the old test and help still described
browser printing. The test now explicitly dispatches `export.pdf.browser` and
captures its handoff into a Rust-written article without opening external tabs;
the Pandoc/Typst writer still runs for real. Preferences descriptions now name
the actual route and dependency. This stays within the approved truth-pass and
three-route validation scope; no PDF entry or engine was removed.

Final optional export run: **38/38**, including a real engine-produced PDF,
browser article serialization, currency preservation and the two intended
equations. After the Preferences copy correction, smoke **108/108** and menu
**97/97** passed again. Final embedded release binary: SHA-256 prefix
`f13dae980c26`; format/lint/knip passed again. No dependencies, settings schema,
command names or PDF format IDs changed. The owner's About-copy edit remains.

- The updated GTK dialog interaction and Linux/high-DPI editor interaction have
  not received a new manual desktop review here. Actual WebKitGTK PDF writing,
  adverse policy output, Linux unit tests and Clippy were run; WSL Poppler alone
  is not being presented as a Linux application interaction. GAP-009 remains
  `recheck` (P1/S) for GTK dialog review, and GAP-019 retains its Linux/high-DPI
  follow-up. Typewriter's retained behavior is visually verified on Windows.
- The remote GitHub workflow has not been run/published from this task. Its
  checked-in safety jobs already exist; first remote execution and future
  crash/relaunch automation remain under GAP-027.
