# Unify LaTeX and Typst preview controls with a Logs toggle

**Status:** in progress
**Date:** 2026-11-10
**ADR:** [Compiled preview workspace](../adr/2026-11-10-compiled-preview-workspace.md)

Scope updated before approval: the user requested one Logs toggle instead of
separate PDF/Logs buttons, and the same preview UI for Typst as for LaTeX.
The original plan filename is retained so earlier links continue to work.

## Context and goal

The supplied screenshots show compiler problems covering a readable PDF, two
vertical scrollbars, and a compile strip covering document text. Inspection of
the current code and the installed application confirms these causes:

- `latexFailure` offers `View partial PDF`, then prepends the same problems
  panel over the rendered PDF. `.pdf-rebuild-error` is a zero-height sticky
  layer whose absolutely positioned `.latex-problems` scrolls independently.
- `.latex-build-status` is sticky inside `#preview-pane`, which is also the PDF
  scroll owner. The pane's 34px top padding leaves the toolbar below the pane's
  top initially; once scrolled, it covers the PDF. Save PDF is another sticky
  strip at the same offset, and warnings are a third strip.
- In the installed app, compiling `docs/samples/Resumo-executivo.tex` succeeded
  in 7.3 s with 15 warnings. Expanding the warning disclosure pushed the first
  page far down. Actionable warnings looked like native buttons while other
  warnings were plain list items.
- Failed-build diagnostics live inside `#preview.markdown-body`. Their font
  inherits document typography, and failures without a PDF inherit document
  zoom. Compiler tools should use the application UI font and scale.
- A failed build deletes `data-latex-current`, but partial PDF display does not
  create a saveable successful `LatexPreview`. Showing output and declaring a
  build successful are currently too tightly coupled for the requested UX.
- Typst Pages uses the same PDF viewer and `showPdfRebuildError` overlay.
  `typstViewBar` adds another sticky Document/Pages/Save strip. The backend
  returns warning headlines, but the frontend does not display ordinary
  `RenderedTypst.warnings`. Successful compiles discard the rest of stderr;
  failures retain only the first 20 non-empty lines. A useful shared Logs view
  needs bounded Typst compiler output as well as UI work.

Goal for both formats: show any readable compiler-produced PDF automatically, keep its complete
viewport clear of application controls, and make diagnostics easy to inspect
without fighting the document. A PDF with errors remains visibly different from
a successful build.

The user's follow-up makes visual separation an explicit requirement: nothing
inside or over the PDF viewport may look like part of the generated document.
Status, errors, warnings, logs and controls belong to application chrome or the
separate Logs view. Never add an in-page banner, watermark or floating panel.

## Scope and non-scope

In scope: a shared LaTeX/Typst preview toolbar and Logs toggle, automatic LaTeX
partial PDF display, unified diagnostics/logs, partial Save, Typst Compile/
Cancel/Auto-compile parity, responsive layout, accessibility and regression
tests. Both Typst Document and Pages use the shared chrome; retain their
rendering behavior and default Document selection.

No new dependency or Tauri command name is required. Typst's existing result
gains additive compiler-output metadata. A default-on `typstAutoCompile`
preference is additive and older settings must keep loading. Engine execution,
package fetching, Markdown dialects, native menu names, success-only PDF print/
export eligibility, and the shared PDF mapping/fit algorithms are outside this
change. Preserve existing LaTeX source-navigation confinement and compiled-line
matching rules.

The separate [preview ownership plan](2026-11-10-preview-pane-ownership.md)
remains independent. Related changes are already present in the working tree;
integrate with their current owner/retirement helpers without overwriting them.
This plan does not implement the separate compile cache. Output/log records
must carry document/project and render-token guards so they never add a new
cross-document leak. Clear this change's surfaces on document invalidation.

## Approach and rejected alternatives

Add a preview shell around the existing `#preview-pane`. The shell reserves an
automatic-height row for compiler controls and gives the remaining height to the
selected content view. Keep `#preview-pane` as the PDF scroll owner so existing
PDF geometry, source correspondence, bookmarks and scroll listeners still use
the same element. A sibling Logs viewport occupies the same remaining area
when selected. Exactly one content viewport is visible and scrollable at a
time. The toolbar is outside both, not sticky over either.

### Toolbar and content behavior

- One shared toolbar contains Compile, Auto-compile, a single Logs toggle with
  an issue count, and Save PDF when the selected output is PDF. No separate PDF
  button. Compile becomes Cancel during a build, retaining a stable position.
  Use the existing local icon system plus readable labels; essential actions
  never depend on hover. Actions dispatch to the active document's compiler.
- Logs is a native toggle button with a stable label, `aria-pressed` and
  `aria-controls`. Click once to show Logs; click again to restore the preview
  at its saved position. Enter and Space provide the same interaction. Keep
  the active state visible; do not implement a one-tab tablist.
- Typst retains its distinct Document/Pages selector in the same toolbar.
  This chooses its renderer, not whether logs are visible. Returning from Logs
  restores the selected mode. LaTeX has no mode selector.
- Both formats get working Compile/Cancel/Auto-compile controls. LaTeX retains
  its existing preference. Typst gains `typstAutoCompile`, default true, in
  Rust settings, `src/api.ts`, Preferences and the toolbar. False retains the
  last output, marks it out of date after edits, and compiles only on explicit
  Compile or a renderer choice requiring a render. Use Typst's existing
  cancellation command for its preview job. Add no new native menu event.
- A concise status line within that toolbar states build/output condition.
  Engine and elapsed time are secondary. Long status text wraps; actions stay
  reachable. Use application fonts and theme tokens, independent of prose
  typography and document zoom.
- Preview and Logs are mutually exclusive views. Logs contains Problems and
  Compiler output selections. They share one scroll viewport; no independently
  scrolling list, raw-log box, or floating overlay. Only these inner Logs
  selections use accessible tabs with arrow-key navigation. Retain independent
  preview/log scroll positions.
- Keep the PDF viewer mounted and laid out while Logs is selected, but make it
  invisible, inert and absent from the accessibility tree. Do not destroy or
  re-render the PDF merely to toggle views. Suspend source/preview sync while
  Logs is selected and restore the saved PDF position before resuming it.
- Remove both formats' separate save/control strips and floating errors, plus
  LaTeX's warning disclosure. Move Typst's Document/Pages controls into the
  shared toolbar. Ordinary Typst warnings appear in Logs and its count. Move
  Typst's Document content-loss warning out of document markup into application
  chrome, keeping the affected constructs and Pages remedy clear. Never
  conceal omitted Document content merely inside a closed log.
- The PDF starts below the reserved toolbar. Remove the inherited Markdown
  top inset for compiler chrome; keep document content padding scoped to its
  renderer. Check the inherited 45vh bottom spacer against end-of-document
  synchronization before reducing it for PDF output. Do not change it blindly.

### Output states

| Build result | Default content | Status and actions |
| --- | --- | --- |
| Successful PDF, no warnings | PDF | Compiled; Save PDF enabled; raw output available in Logs |
| Successful PDF with warnings | PDF | Warning count on Logs; no automatic disclosure |
| LaTeX failed build with readable partial PDF | New PDF automatically | PDF with errors; counts on Logs; saveable as explicitly partial output |
| Failed build with no new output, same document/project has older output | Previous preview | Build failed; showing previous output; Logs shows latest failure |
| Failed build with no usable output | Logs automatically | No output produced; Save unavailable; toggling Logs off shows the explanatory empty preview |
| Building with an existing PDF | Existing PDF | Compiling; showing previous output; Cancel available |
| Building before any output | Preparing surface | Named phase and elapsed time; no invented progress percentage |
| Never compiled in manual mode | Ready surface | Not compiled yet; use Compile in the toolbar |
| Cancelled or edited since the displayed result | Retained output, when available | Cancelled or Out of date; do not label it current |
| Typst Document success, including warnings | Flowing document | Selected mode retained; warnings in Logs; Save PDF offered in Pages mode |

Readable output means actual bytes accepted by the existing PDF.js renderer.
Do not infer it from `Output written on ...` alone. If partial bytes fail to
render, retain the same project's last readable output, or show Logs, with the
PDF-render failure explained. Never publish cancelled or superseded output.
Track the revision of the last completed attempt separately from successful
output eligibility: a displayed partial PDF must not trigger an endless
automatic rebuild merely because it is not a successful `latexCurrent` result.

The first usable PDF, including LaTeX partial output, appears automatically
with Logs inactive. Typst continues honoring the selected Document/Pages mode.
Warnings/errors never force Logs over an available PDF. An explicit choice to
read Logs remains selected during subsequent automatic builds; a new result
updates the toolbar without taking the reader out of the view they chose.
When no usable output exists, a failed attempt opens Logs automatically, but
the toggle can still be turned off to show a clear no-output surface. Toggling
must never create a rebuild. Typst does not currently publish partial PDFs on
failure; preserve its previous output rather than inventing partial support.

### Typst compiler output contract

- Add `compilerOutput: string` and `compilerOutputTruncated: boolean` to
  `RenderedTypst` in Rust and TypeScript, for both Document and Pages. Existing
  `kind`, HTML/CSS/PDF, `warnings` and `ignored` fields keep their meaning; other
  callers continue working. No command rename or argument change. Allow test
  doubles to omit the new metadata with safe frontend defaults.
- Preserve actual stderr, bounded to 64 KiB on a UTF-8 boundary, and report
  truncation visibly. Keep draining the process as today. Never treat binary
  PDF/HTML stdout as log text. Empty successful stderr says the compiler
  reported no messages; do not fabricate a TeX-style transcript for Typst.
- Preserve bounded failure output rather than discarding everything after 20
  lines. Keep the existing string rejection shape and missing-engine sentence
  working, including its install remedy. Cancellation and supersession publish
  no new output or completion state.
- Adapt existing Typst warning strings to the shared issue presentation. A
  locationless warning remains a readable, non-clickable row. Do not invent
  locations or add a general Typst diagnostic parser in this task. LaTeX's
  structured, safely navigable diagnostics retain their richer data.

### Problems, logs and saving

- Use one diagnostic presentation for both formats' warnings and build errors.
  Show severity using an icon and text as well as color, file/line where
  available, message, and the existing captured source excerpt. Rows wrap in
  narrow panes; long paths never force the toolbar wider. Compiler/package
  paths outside the project remain readable but cannot open files. Unknown
  locations use non-interactive rows rather than dead navigation controls.
- Preserve occurrence ordering, truncation notices, LaTeX captured-line validation,
  and safe source navigation. Use severity fields, not message regexes.
  Automatic failure handling must not steal editor focus or change the active
  file; explicit diagnostic clicks perform navigation.
- Raw output uses a wrapping monospace view and a Copy log action. Preserve
  plain-text rendering at the boundary. It never inherits Markdown styling.
- Save PDF writes the displayed result's actual bytes. For a partial PDF, use
  a dialog titled `Save PDF with compilation errors` and default to
  `<root>-partial.pdf`; the status already explains the errors, so add no extra
  confirmation. The native save dialog remains the explicit save action.
- Keep success-only export/print and source/PDF correspondence checks intact.
  A partial PDF is viewable/saveable without becoming `latexCurrent` or
  claiming reliable correspondence. Prevent Save from silently writing an
  older successful build when the screen displays a newer partial build.
- Capture output bytes, project root, render token and all relevant source
  revisions for Save. Recheck after the dialog, including included-file edits.
  Disable Save for stale/previous output under the existing freshness policy.
  LaTeX uses its captured project snapshot; Typst retains its current document
  revision guard. This UI change does not introduce a Typst project snapshot.

Rejected alternatives: raising z-index or adding a fixed top offset still
covers content and fails when controls wrap; a bottom log drawer creates a
second vertical viewport and reduces the PDF's usable height; a modal makes
source navigation cumbersome; an always-expanded problems list steals reading
space; discarding all PDFs on error removes useful output; treating partial
output as success would weaken export and correspondence safeguards.

## Steps

- [ ] Restore diagnostic click-to-source navigation and the light-red source
      line highlight, including warnings after a successful build. Investigate
      unresolved bundled-engine locations such as `/tex/luavlna`; retain
      snapshot membership and stale-line checks rather than guessing a target.
- [ ] Correct the implementation's visual mismatch with the approved prototype:
      local outline icons, filled primary Compile, issue badges, structured
      status, flat diagnostic rows, and matching spacing/theme colors. Inspect
      actual application screenshots against the prototype before completion.
- [x] Record approval, recheck the working tree, and preserve unrelated edits.
- [x] Extend the existing LaTeX UI suite with failing overlap, scroll-owner,
      automatic-partial-output and Logs-toggle checks; cover Typst too.
- [x] Add bounded Typst compiler output metadata and focused Rust tests.
- [x] Add the compatible Typst auto-compile preference and validate its wiring.
- [x] Add the preview shell and shared compiler UI controller; update pane mode and
      split-resize integration while retaining the PDF scroll owner.
- [x] Move both formats' controls and diagnostics into the new surfaces; wire
      the Logs toggle, Typst renderer choice, availability, focus and scrolling.
- [x] Automatically stage/commit partial PDF bytes with ownership guards and
      record their separate display/save eligibility.
- [x] Implement safe partial Save and full-snapshot revalidation; retain
      success-only File export and Print behavior.
- [x] Validate real UI states, responsive layouts and cross-format regressions.
- [x] Write the ADR, update user/test documentation, record any qualifying
      traps, and mark the plan done.

## Files and modules

- `index.html`: outer preview shell, toolbar slot and separate Logs viewport.
- `src/compiled-preview-ui.ts` (new): shared toolbar, Logs toggle and diagnostic/log
  DOM controller, using callbacks to the existing shell actions.
- `src/main.ts`: both compilers' results, partial rendering, output/save ownership,
  synchronization suspension, document invalidation, view modes and resizing.
- `src/styles.css`: shell sizing, reserved toolbar, responsive controls and
  UI-font diagnostics; remove both formats' overlay styling.
- `src-tauri/src/typst.rs`: bounded stderr in both success variants and failure
  output; tests for metadata, truncation and silent successful output.
- `src-tauri/src/settings.rs`: default-on `typstAutoCompile`, with existing
  settings loading safely through the established serde defaults.
- `src/api.ts`: additive Typst result metadata and settings interface field.
- `src/preferences.ts`: working Typst auto-compile preference.
- `scripts/dom-smoke.mjs`: exercise the new preference end to end.
- `scripts/latex-preview-test.mjs`: replace the explicit partial-button
  expectation and add the focused state/geometry/save checks.
- `scripts/typst-preview-test.mjs` and `scripts/typst-test.mjs`: shared chrome,
  warnings/logs, retained failed output, both modes, cancellation/manual mode,
  save ownership and existing correspondence behavior.
- `scripts/preview-zoom-test.mjs`: assert chrome stays unscaled for both formats.
- `scripts/scroll-sync-test.mjs`: position source probes in the common visible
  area of both panes; the reserved toolbar makes their top edges different.
- `scripts/document-tabs-test.mjs`: account for device-pixel border rounding
  when checking the existing 2px accent; tab product styles are unchanged.
- `docs/latex.md`: explain Logs, automatic partial display and partial Save.
- `README.md`: shared Typst controls alongside its two preview modes.
- `docs/agent-guide/catalog/latex-and-formats.md` and
  `docs/agent-guide/catalog/preview-and-sync.md`: document extended suites.
- `docs/adr/2026-11-10-compiled-preview-workspace.md`: record viewport/chrome and
  partial-output eligibility decisions without rewriting existing ADRs.
- This plan and an appropriate trap file only if a qualifying trap occurs.

Extend existing suites rather than introducing an undocumented new runner.

## Risks and rollback

The shared pane is used by resizing, view modes, HTML positioning, scroll sync,
zoom and PDF bookmarks. The wrapper must inherit the old pane's flex behavior
and source-only hiding, while the old ID remains on the content scroll owner.
Logs must not let invisible PDF geometry drive editor scrolling. Tests cover
these seams; Linux/WebKitGTK still needs a visual check before release.

Automatic partial commits must dispose superseded staged views without
publishing late output. Saving must target the displayed bytes and captured
project snapshot. Tests exercise cancellation, tab switches and changes while
the save dialog is open. If this work is reverted, restore only this change's
hunks; do not reset the working tree or the separate ownership plan.

## Tests and validation

After approval: run `npm run build` first, then `npm run test:rust` through
`scripts\cargo-vcvars.cmd`, followed by relevant app-free LaTeX diagnostic and
native-adapter layers. Test Typst metadata retention, UTF-8 truncation,
missing-engine and cancellation paths, plus old/default settings loading.
Run changed-file formatting/lint checks and Rust clippy for the changed backend.
Run focused UI layers in the repository's documented order: smoke, scroll
sync, document zoom, Typst pages, HTML, tabs and LaTeX preview as applicable.
Use the existing orchestrator/owned instance and the required MSVC wrapper for
builds; do not reset settings or close the user's running installed MDraft.

Extend the existing fixtures to cover success, warnings, errors with valid
partial bytes, errors with no PDF, invalid partial bytes, retained old output,
manual mode, cancellation and recovery. Cover bundled/native result shapes
without requiring the installation of a new TeX distribution.
Also cover Typst warnings on successful PDF and HTML renders, empty successful
stderr, errors beyond 20 lines, current-output retention, manual compilation,
and switching Document/Pages while Logs is active. Verify both auto-compile
preferences remain independent and default to their current automatic behavior.

Inspect light/dark themes and pane widths of 320, 480 and 900 CSS pixels, with
document zoom at 100% and 200%. Measure toolbar bottom against the active
viewport top: the viewport must start at or below the toolbar bottom at every
scroll position, including while wrapped. The visible view must have exactly
one vertical scroll owner; opening a raw log must not add another. Toggle Logs
at a mid-document page and assert the page/offset returns without PDF rerender.
Verify keyboard selection/focus and that document zoom does not scale chrome.

## Acceptance criteria

1. A readable PDF produced alongside compiler errors appears without pressing
   View partial PDF; it remains clearly labeled PDF with errors.
2. Neither format's problem panel, warning list, log box or toolbar covers PDF content.
   The visible PDF host contains rendered pages only; build status and controls
   are outside it, with no PDF visible behind the Logs view.
3. Both formats' Compile, Auto-compile, Logs toggle and Save share one reserved toolbar that
   remains at the top and wraps without clipping at 320px pane width.
4. A single Logs toggle opens logs when pressed and restores the selected
   preview when released. No separate PDF button. Each visible content view
   has one vertical scroll owner; toggling retains its page and offset.
5. Logs supports consistent severity-aware source navigation and raw output
   without inheriting prose font or document zoom.
6. Partial Save writes the displayed partial bytes with an explicit filename
   and full-snapshot freshness guard; it never enables success-only export or
   correspondence. Previous/stale output is never presented as current.
7. No-PDF, first-build, cancelled, failed-rebuild and recovery states have clear
   status, usable actions and no unexplained empty pane.
8. Existing Typst, HTML, split resizing, source-only mode, zoom and PDF scroll/
   selection behavior continue to work.
9. Typst warnings and bounded compiler output are visible through the shared
   Logs view for Document and Pages. Its Document content-loss notice remains
   visible in application chrome, outside the rendered document.
10. Typst Compile/Cancel/Auto-compile work end to end; older settings load with
    automatic compilation enabled. No new action is decorative or a dead control.

## Open questions

No implementation blocker. The user chose a single Logs toggle and shared
LaTeX/Typst UI. Use visible labels beside local icons and a compact two-line
toolbar whose status line can wrap. Typst retains Document/Pages rather than
gaining a redundant PDF button. Approval covers these defaults and the scope above.

## Execution notes

Approval received on 2026-11-10. Implementation preserves the current
`commitPreview`/`retirePreview` owner seam and the existing waiting surface.
Foreign output and logs are removed during retirement, and the waiting surface
stays a sibling of the article inside the original scroll owner.

The UI regressions were extended during implementation rather than executing a
red/green cycle first: another chat's `test-all.mjs` process (PID 35536), running
`ai-assistant-test.mjs`, held the shared test profile. The harness correctly
refused to start; its guard was not bypassed and its processes were not stopped.
Full real-app validation remains required before this plan is marked done.

Continuation: the updated release executable built successfully through
`scripts\with-msvc.cmd npm run tauri -- build --no-bundle` (35.56 s Rust build).
The competing harness (35536) and its `ai-assistant-test.mjs` child (20712)
still exist although no MDraft app remains. Permission to stop those two stale
test processes has been requested; do not infer approval from elapsed time or
stop unrelated processes. Once the profile is free, run the approved subset
with `--no-build --only smoke,sync,preview-zoom,preview-ownership,typst-preview,html,tabs,latex-preview`.

Validation so far: frontend build; 379 Rust tests passed, 4 ignored; Rust clippy
with all targets and warnings denied; LaTeX diagnostics and native adapter units;
12 preview-owner checks; changed-file formatting and lint; dependency audit via
knip. Full frontend lint reports existing `no-control-regex` errors in
`src/latex-outline.ts:184` and `src/paste/render-latex.ts:37`, neither edited by
this task. Initial sandbox-only Rust socket failures passed outside the sandbox
with a workspace temporary directory, as documented in the existing traps.

An independent browser layout attempt could not connect to the local Vite
listener (`net::ERR_CONNECTION_TIMED_OUT`); no visual pass is claimed. The
approved real-app UI suites remain the authority for layout and interaction.

UI validation found an existing probe assumption exposed by the reserved
toolbar: `scrollSourceTo` put its word at source top + 12px, above the PDF
viewport. The production solver already uses max(source top, preview top).
The test now uses that same shared visible reference; error limits and the
solver are unchanged. This is a validation adaptation within the approved pane
layout scope, not permission to relax scroll accuracy.

### Completed validation

The user explicitly authorized stopping stale harness 35536 and its AI child
20712; their identities were checked and those two processes were stopped.
Subsequent active harnesses from another chat were allowed to finish. All
profile guards remained enabled. The earlier blocking notes above describe
execution history; there is no outstanding test-profile blocker.

The focused Windows UI layers passed: LaTeX preview 91/91, DOM smoke 119/119,
content scroll 62/62, document zoom 24/24, preview ownership/spinner 69/69,
Typst preview 79/79, HTML 60/60 and document tabs 107/107. The final LaTeX run
also writes a real partial PDF, verifies its error-specific dialog/default
filename and exact writer bytes, and rejects a source edit while the Save
dialog is held open. The unchanged strict scroll limits pass with settled
baseline p95 errors below 1 CSS pixel in every adapter. Logs also suspends
source-driven movement of the hidden PDF.

The four-layer rerun used release SHA-256
`1a437d7137fb6c1d9a664e9204beb7cafed560a0643b10a7c9ffc58568906bab`.
Another chat subsequently rebuilt the same source tree for its AI/recovery
tests; the final 91-check LaTeX run used release SHA-256
`404d60f0d8a09b407223c2c219d3ba0eb6cb536160bc79e325e1a0500e8f85c3`.
No product source was changed between these two runs.

Actual WebView screenshots were captured and inspected: a dark LaTeX partial
PDF and Problems view, plus light Typst PDF/Logs views at 320, 480 and 900 CSS
pixels. Controls reserve their own space, narrow panes wrap without clipping,
and the Logs surface completely hides the rendered document. These app
screenshots supersede the failed standalone-browser attempt above. Evidence
is in this chat's visualization `validation/` directory.

Frontend build, 379 Rust tests (4 ignored), clippy with warnings denied,
LaTeX diagnostics/native-adapter units, preview-owner units, knip, changed-file
Prettier/ESLint and the CRLF-aware diff check passed. Full frontend lint still
reports the two pre-existing `no-control-regex` errors named above. Linux/
WebKitGTK visual verification remains a release-platform check.

The existing 45vh tail spacer was retained: the regression suite verifies
end-of-document following and viewport retention rather than changing the
shared PDF fit/scroll algorithms. The ADR, user documentation, script catalogs
and qualifying scroll-probe/pixel-rounding trap records are updated.

### Visual fidelity correction

The user's follow-up identified that the delivered chrome did not match the
approved interactive prototype. The earlier completion validated behavior and
responsive geometry but missed the promised visual treatment. This correction
implements that already-approved design rather than proposing another one.
Use `latex-preview-workspace.html` in this chat's visualization directory as
the visual reference, including toolbar and Logs rows. Preserve the existing
owner/spinner, save guards, and exclusive PDF/Logs surfaces. Update the shared
controller, its CSS, the status metadata in `main.ts`, and the affected existing
UI probes; do not add dependencies or change compiler contracts.

The user also reported that diagnostic clicks no longer reveal/highlight the
source. This is part of the already-approved diagnostics behavior. Extend the
existing diagnostics/SDK units and LaTeX UI suite as needed, and fix the adapter
or navigation path established by a reproduction. Preserve explicit navigation;
do not restore automatic jumps after compilation.

The subsequent explicit request to investigate `exemplo.tex` was reproduced
without editing the reader's project. `luavlna.sty` executes `\input luavlna`,
but the bundled worker caches both extensionless TeX and Lua lookups in the
same `/tex/luavlna` file. Lua source is then typeset as TeX, producing the exact
50 internal-package diagnostics in the screenshot. Scope now includes a local
bootstrap compatibility fix for these cache names and focused SDK tests. Keep
the downloaded assets and their verification hashes unchanged; do not edit
the reader's document or mask dependency errors as arbitrary source lines.

After fixing that collision, the same project exposed two independent defects:
the SDK drops an error's `l.<n>` pointer when normal help text exceeds its
five-line lookahead, and the bounded snapshot omits literal image names passed
through custom class macros. Recover pointers within their own error blocks;
collect file-like literal graphics arguments/defaults through the existing
confined snapshot walker. Preserve root/symlink/size limits and never expand
arbitrary TeX or collect every sibling file. Extend focused Rust and SDK tests.
