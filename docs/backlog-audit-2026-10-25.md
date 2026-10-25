# Backlog audit — 2026-10-25

**Tree:** `0.4.7`, commit `2a0f1be`; working tree clean before the audit.
**Scope:** Compare all 24 backlog items with their implementation, approved
plans, tests and reader documentation; propose priorities and missing work.
**Disposition:** Review findings and proposals, not an implementation plan.
The backlog and application code have not been changed.

## Assessment

Most open items describe real omissions. The backlog needs a refresh rather
than a replacement. Its main problems are an overly broad P1 tier, stale
descriptions of completed work, duplicate ownership, and missing tests and
acceptance criteria for asynchronous document operations.

Fix document safety and the correctness of existing output before investing
in a new print engine or a full workspace file manager. A documented limitation
can still be valuable backlog work: documentation alone does not settle product
priority.

## PDF (Print): already useful, currently a browser handoff

The existing route is:

1. `src/main.ts::exportPdf` builds a print document from the rendered article.
2. `src/api.ts::printDocument` invokes Rust's `print_document`.
3. `src-tauri/src/export.rs::print_document` writes
   `<temp>/mdraft-print/<name>.html` and calls
   `tauri_plugin_opener::open_path`.
4. The HTML invokes `window.print()` in the associated browser.

This already supports the everyday print / Save as PDF workflow. It does not
call WebView2 `ShowPrintUI` or `PrintToPdf`, and MDraft cannot observe the PDF's
chosen path, successful creation or cancellation. This explains the existing
exception for After Export actions. `docs/export.md` describes that exception
accurately.

WebView2 itself **does** have native printing APIs. Microsoft documents
`ShowPrintUI`, `Print`, `PrintToPdf` and `PrintToPdfStream` in
[Printing from WebView2 apps](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/print).
The comments in `main.ts`, `export.rs` and `docs/guide.md` that say WebView2 has
no print interface are too broad. A reported failure of `window.print()` in
MDraft's current embedding does not establish that the host APIs are absent.
No native print dialog was exercised during this audit.

**Recommendation for GAP-009:** rename it to **In-app printing and direct PDF
save**, lower native integration to **P2**, and retain the browser fallback.
Only promote it if browser handoff is demonstrably blocking users. A visible
File > Print entry could reuse the existing route; adding that entry does not
require a new rendering engine. Decide its shortcut alongside GAP-008, which
currently reserves Ctrl+P for Quick Open.

Separate existing-output defects from that integration project:

- `buildExportArticle` reuses `renderPreview` / `renderAsciidocPreview`.
  Their `decorateLinks` rewrites local images to app asset URLs, removes
  ordinary anchor `href` attributes, and stores their destinations in
  `data-href`. The HTML and print wrappers do not restore browser-readable
  assets or ordinary link destinations. An external browser has neither the
  app's asset handler nor its click listener. Fix this as **P1 output
  correctness**, independently of native printing.
- The print wrapper uses a light page and light code colors, but
  `buildExportArticle` renders Mermaid with the current `isDark` value. The
  requested light-diagram behavior is a repair to the current path.
- The HTML and print wrappers link KaTeX CSS/fonts on jsDelivr. An offline,
  self-contained output option would be useful, but is separate **P2** work.
  The current network dependency is already documented in `docs/export.md`.

## Missing safety work: asynchronous document operations

**Proposed GAP-025 — Preserve session identity and buffer revisions across
asynchronous operations — P0.**

Three controlled probes reproduced incorrect transitions in the current
functions. They used source extracted from `main.ts`, transpiled with the
installed TypeScript package, with deferred IPC responses and stubbed UI
dependencies. They are deterministic function probes, not full application or
OS filesystem tests.

| Scenario | Observed result | Evidence |
| --- | --- | --- |
| Start saving `first edit`; type additional text before the write completes | Disk baseline remains `first edit`, but the newer buffer is marked `dirty: false`; recovery is forgotten | `main.ts::writeSession`, especially the unconditional clean/forget after `await api.writeDocument` |
| A clean active tab begins reading an external change; type before that read returns | The new local text is replaced by the external text and the tab is clean | `main.ts::reloadChangedSessions` checks cleanliness before the read, without revalidating it afterward |
| Start Save As in tab A; switch to tab B while the write is pending | B acquires A's new path and content; A remains untitled | `main.ts::saveAs` continues using mutable global `doc` across awaits |

These are different from the external-writer stat/write race acknowledged in
the completed P0 plan. They concern edits and tab changes inside MDraft.

Acceptance should cover a captured session identity, a captured text revision,
serialized saves per destination/session, and revalidation before applying a
read or clearing dirty state. Saving an older revision must leave newer edits
dirty and journaled. Save As must finish against its initiating session.
Apply the same review to reload, close, recovery and export operations.

## Existing item-by-item assessment

The priorities below are product judgments based on the code and available
workarounds, not measurements of user demand.

| ID | Match with current code | Recommended disposition |
| --- | --- | --- |
| GAP-001 recovery | Implemented: atomic journal, debounce, restore and cleanup exist | Keep done for the approved implementation; add GAP-025 rather than treating recovery as complete protection against every loss path. Recovery management/failed-entry notices remain possible follow-up work. |
| GAP-002 external changes | Implemented within the narrower approved plan: mtime + size preflight and conflict actions | Keep the implementation record, but make the residual limitations explicit. The backlog's hash target was deferred by the approved plan. Same-size/same-mtime changes are missed; stat and write are separate operations. Track stronger save validation as a safety follow-up. |
| GAP-003 Typst commands | Supported syntax is implemented; unsupported commands show explanatory toasts | Keep done for the approved plan. Correct the backlog's stricter claim that unsupported menu entries are disabled and that one cross-language table feeds Help. The plan deliberately retained a global menu; only Typst strings/transforms were centralized. |
| GAP-004 close prompt / Save All | Still missing: two-button prompts treat a negative/dismissed answer as discard and remove recovery | Promote cancellation-safe close to **P0**; retain Save All as **P1** in the same workstream. A recovery journal does not protect deliberately discarded entries. |
| GAP-005 binary/non-text | Still open: unrestricted `fs::read`, lossy decoding, and only a toast before later saves | Promote the minimum binary/lossy-write guard to **P0**; keep the broader classifier, OS-opening UI and size policy **P1**. Link navigation now filters editable extensions, but File > Open and drop still expose the issue. |
| GAP-006 folder/tree | Missing: sidebar is Outline/Favorites/Recent; no listing command | The full file manager is **P2**. A minimal read-only folder tree can be the first strategic **P1** after safety if folder-based writing is the intended audience. Defer rename/delete/expanded-state management from its first increment. |
| GAP-007 cross-file search | Missing; editor search is single-document | **P2** for the full proposal. Split read-only search from multi-file Replace, which has much greater safety and undo scope. Open-tab search can ship without a folder tree. |
| GAP-008 quick open | Missing | **P2**, initially over tabs/recents/favorites. It need not wait for workspace search. Resolve the Ctrl+P print conflict deliberately. |
| GAP-009 native print/PDF | Missing native integration; existing browser print/PDF is implemented | **P2** integration. Put current asset/link/diagram output repairs in a separate **P1** item. |
| GAP-010 table editing | Insertion templates exist; no cell navigation or row/column operations | **P2** for a complete table editor; start with Markdown cell navigation and add/remove row. Formatting existing columns is already covered by Format Document. No dependency on native printing. |
| GAP-011 preview Find | Real gap: Find/Replace always opens the editor search panel, including Preview-only | Keep **P1**. Start with visible, mode-aware Find. Replace should reveal/target the source. DOM, guest and PDF searching can be separate increments. |
| GAP-012 documentation | Still partly open: shortcut mismatches and Preferences claims remain | Keep **P1**. Add the misleading print-API claims and the backlog's own stale statuses. Compare Help shortcuts with the registered accelerators. |
| GAP-013 front matter | Markdown gap reproduces; the Typst subproblem is already fixed | Keep **P1** for Markdown preview/export consistency. Remove Typst YAML insertion from the remaining scope. |
| GAP-014 academic Markdown | Missing footnotes/sub/sup/mark/definition lists; measured examples still reproduce | Keep **P2** overall. Footnotes can be prioritized separately for academic users; this is a dialect decision, not a cosmetic extension. |
| GAP-015 typewriter | Still recenters only on selection changes without document changes | Keep **P2**, small repair to an existing feature. |
| GAP-016 preview interactions | Task toggling, copy buttons, lightbox and Pages controls are absent; image opening now exists | Split it. Pages navigation/zoom and task toggling **P2**; optional lightbox/math-copy polish later. Keep completed Ctrl+click image opening out of remaining scope. |
| GAP-017 instance/window | No single-instance registration or handoff; only one configured window | Promote reliable second-launch file handoff to **P1**. Keep true multi-window separate and optional. Startup currently consumes only the first argv path; add multi-file launch acceptance here. |
| GAP-018 link authoring | Navigation is implemented; authoring remains syntax wrapping without a dialog | Keep **P2**. Reuse the landed resolver. A native file picker and current-document heading picker do not require a workspace tree. |
| GAP-019 zoom | Confirmed: changes editor font size only; menu reset also resets content width | Promote preview zoom and zoom-only reset to **P1**, because the existing command has no visible effect in Preview-only. Decide shared versus independent pane zoom during design; do not prescribe CSS zoom prematurely. |
| GAP-020 spell languages | OS integration exists, but exposed tags/resolution remain limited to en/pt | Keep **P2**. This is extending an existing checker, not adding spelling from scratch. |
| GAP-021 encoding | UTF-8 BOM and EOL preservation exist; other encodings do not | Share the **P0** lossy-write guard with GAP-005. UTF-16 round-trip **P1**; broader encodings/picker **P2**. Do not implement the first-save guard twice. |
| GAP-022 completion | Bracket closing exists; the proposed semantic completion sources do not | Keep **P2**. Current-document headings and document-relative paths can precede a workspace index. Recognized Typst image/include strings need completion despite being code contexts. |
| GAP-023 conveniences | Most listed conveniences are absent | Keep **P3** for remaining polish. Remove duplicate Save All (GAP-004) and per-document language ownership (GAP-020). Define asset/link behavior for move/rename with GAP-006. |
| GAP-024 localization | English strings remain throughout the app | Agree with **P3 / parked**. Broader language support and text-input correctness can be addressed independently. |

## Additional work worth tracking

### P1 — Verify existing output outside the app

**Proposed GAP-026 — Browser-readable exports.** Fix image URLs, ordinary
hyperlinks and light-theme diagrams as described above. Acceptance should open
the exported HTML in an ordinary browser, load a real local image, follow an
ordinary link, and inspect actual PDF output where applicable. Current export
tests inspect useful HTML/style properties but do not establish these behaviors.
Keep offline packaging as a separately estimated increment.

### P1 — Automate the safety guarantees

**Proposed GAP-027 — Lifecycle regression coverage and CI.** The current
`p0:unit` suite covers the scheduler, classifier and Typst strings, not the
`main.ts` save/reload/close orchestration. The completed P0 plan records manual
release probes rather than an automated crash/relaunch suite.

`quality.yml` runs build/format/lint/knip and Clippy; `release.yml` runs Rust
tests, but neither executes the app-free JavaScript safety/session suites.
Run those cheap suites in CI and add deterministic delayed-I/O lifecycle tests.
Add an isolated two-launch recovery test, plus dirty close/cancel and failure
cases. Keep native UI tests in an appropriate Windows runner; do not make every
pull request depend on manual validation.

### P2 — Normal authoring behavior in every advertised language

**Proposed GAP-028 — AsciiDoc/Typst list continuation.** Markdown installs its
continuation keymap; the other two do not provide equivalent language-specific
Enter behavior. GAP-012 currently only corrects the documentation claim.
Track the actual feature: continue/terminate lists and quotations with Enter,
preserve nesting, and make indent/outdent predictable and undoable.

### P2 — Actionable compiler diagnostics

**Proposed GAP-029 — Navigate from errors to source.** Typst failures are shown
as a preformatted message; warnings are reduced to headline strings. Add
file/line/column diagnostics that reveal the offending source range. Consider
retaining the last successful preview while explicitly marking it stale.
Reuse the mechanism for actionable Mermaid/math/asset errors where possible.
Error messages already exist; navigable diagnostics are the missing capability.

### P2 — Keyboard and assistive-technology coverage

**Proposed GAP-030 — Complete keyboard operation and focus behavior.** Tabs and
menus already have meaningful keyboard/ARIA support. Complete the remaining
paths rather than claiming accessibility is absent: Preferences has a dialog
role and Escape handling, but no modal focus trap/restoration; pane resizing
uses mouse handlers only. Add keyboard resizing, predictable modal focus and
screen-reader announcements for recovery/conflicts, with an end-to-end audit.

### P2 — Saved-version recovery

**Proposed GAP-031 — Optional bounded local history.** A crash journal and
atomic replacement do not recover a previously saved version after an
accidental successful save. Consider opt-in, size-capped version snapshots and
a compare/restore interface under the app's data/config storage. Define
retention, privacy and portable behavior before implementation. This is a
product proposal, not a claim that existing recovery is missing.

### Strengthen existing items instead of creating duplicates

- **GAP-005:** `too_large` already appears in the target, but size-limit
  acceptance is missing. Check size before reading, expose the 16 MiB recovery
  ceiling, and define what happens when a document is editable but unjournaled.
  Separately measure render responsiveness/cancellation on large documents.
- **GAP-017:** cover initial multi-file argv, second-launch handoff and optional
  installer file associations together. The current bundle does not register
  associations; make registration an explicit product choice.
- **GAP-006/023:** moving or saving a document into another directory must define
  whether relative images/includes/links are rebased, copied, or retained with a
  warning. The current Save As changes the base directory without such a policy.
- **GAP-002:** state that same-size, same-mtime replacement is undetected.
  The classifier returned `unchanged` in a direct probe. The comment that this
  case leads to a benign prompt is incorrect; the approved plan also accepts
  the separate stat/write race. Evaluate content-based pre-save validation and
  move check/write closer together without promising an absolute filesystem
  compare-and-swap guarantee.

## Backlog maintenance and sequencing

The header still says `0.4.6` / 2026-10-24; the current tree is `0.4.7`.
Link-navigation and image-paste plans both have status `done`, but remain in
the In flight section and several recheck notes. The recovery-storage open
question is settled. Old Evidence paragraphs in completed items should be
labeled as pre-change observations so they do not contradict their resolutions.

The Shared foundations table is a proposed design, not a list of existing
modules: a single `commandsFor(language)` driving menus and Help has not landed.
Remove hard dependency arrows that merely indicate related work: native print
does not block tables; preview search does not block code-copy buttons; heading
completion, link dialogs and a tabs/recents picker do not require a file tree.

Recommended execution order:

1. **P0:** GAP-025 async lifecycle guards; cancellation-safe close; minimum
   binary/lossy-write protection. Add reproducing tests with each fix.
2. **P1:** browser-readable output; safety regression CI; documentation/front
   matter; preview Find/zoom; second-launch handoff; UTF-16 as needed.
3. **Product expansion:** a small folder/index/search/quick-open workstream,
   prioritized against table authoring and footnotes using the intended users'
   workflows. Defer multi-file replacement and file-management operations.
4. **P2/P3:** native print integration, broader completion/languages, diagnostics,
   accessibility improvements, preview conveniences and remaining polish.

## Validation and limits

- `npm run p0:unit`: **52/52 passed**.
- `npm run test:sessions`: **59/59 passed**.
- Controlled deferred-I/O probes reproduced the save, active-tab reload and
  Save As identity failures above.
- Direct classifier probe: identical size/mtime yields `unchanged`.
- Direct bundled `marked` probes reproduced front-matter misrendering,
  absent footnotes, `H~2~O` strikethrough and literal sup/highlight syntax.
- An isolated `decorateLinks` probe confirmed removal of an ordinary `href`
  and retention of an app asset URL; its asset resolver was stubbed. The actual
  resolver/export/wrapper path was also inspected. No complete browser/PDF
  rendering probe was run.
- No application source changed. No full build, Rust suite, native print test
  or live UI suite was run for this review. Passing the 111 existing unit
  checks does not cover or disprove the newly reproduced orchestration races.

Implementation of these proposals still follows the repository's plan approval
rules. This audit does not authorize architecture, dependency or command/schema
changes.
