# Evaluate LuaLaTeX in MDraft with a WasmTex proof of concept

**Status:** in progress

**Interaction clarification:** The user requested consistency with MDraft's existing click, selection, Escape and bidirectional Sync Scroll behaviour. The initial PoC provided explicit line/region SyncTeX navigation and a button; that is not equivalent. Source clicks now request an unambiguous region without scrolling, and PDF clicks paint source without taking the selection. These latest changes still need real-app tests. Bidirectional Sync Scroll and exact word/range selection correspondence remain unimplemented. Align and verify those interactions before marking the PoC complete; do not describe line-level matches as exact word matches.

**Checkout clarification:** This worktree already has branch `feat/wasmtex-lualatex-poc` checked out. The user asks for the completed branch to be available in the original checkout afterwards; handle that only after the PoC and tests are complete, preserving both checkouts and all changes.

**Test and toolbar clarification:** The user requires test application windows to stay hidden and never steal desktop focus. Stop the foreground suite, restore its saved user state, make hidden execution the default, and report any focus-dependent checks that cannot run that way. Remove unnecessary LaTeX toolbar buttons, use the Typst visual style, and offer saving the current PDF for both LaTeX and Typst Pages.

**Date:** 2026-11-06

**ADR:** none for the isolated experiment. Before adopting its architecture in the product, record any durable decision in a new ADR.

## Context and goal

MDraft opens Markdown, AsciiDoc, Typst and HTML but treats a `.tex` file as Markdown. Its Typst Pages preview already renders a compiler-produced PDF with PDF.js, selectable text and source correspondence. The PDF renderer is currently coupled to Typst's page map and must be made reusable without changing Typst's behaviour.

The goal is an experimental, reviewable LuaLaTeX workflow in the real Tauri application, using WasmTex's headless compiler and the existing PDF viewer. Establish whether it works for a small multi-file document, whether a warmed project can recompile offline after an application restart, and what it costs in installer size, downloaded and cached bytes, startup time and memory on Windows and Linux. Report actual results rather than extrapolating from upstream engine sizes.

The base inspected for this plan is `master` at `70dda4523562ab3d6fa43fde1c0eafaba7fc43c3`. The checkout was clean before this plan was written. The WasmTex candidate inspected is commit [`1c9fa6207d4978f1d1a95cd44651ed91a2d98a31`](https://github.com/corca-ai/wasmtex/commit/1c9fa6207d4978f1d1a95cd44651ed91a2d98a31), for which the project publishes a [prebuilt SDK snapshot](https://github.com/corca-ai/wasmtex/releases/tag/snapshot-f85a1d3cec1c0598) with SHA-256 `f85a1d3cec1c05986f225c839204162d4d94dcb1bfd814a944e8183b64068809`. Its SDK, engine assets, format and TeX Live mirror are separate pieces that must be versioned consistently.

## Scope and non-scope

- After approval, create an isolated worktree and branch `feat/wasmtex-lualatex-poc` from the inspected `master` commit. Transfer only this approved plan into it and keep the original checkout and any intervening unrelated edits intact. Use an independent `node_modules`, never a junction to the original checkout. The PoC remains on this branch; no merge, tag or release is included.
- Open a saved `.tex` project, edit it in the existing CodeMirror editor and compile the current buffer with `WasmTexCompiler` in a worker, explicitly setting `engine: 'lualatex'`. Display the resulting PDF in the existing Pages viewer and allow the finished result to be saved as PDF through the existing export interaction or a clearly labelled experimental action.
- **Deferred until after the PoC is validated:** implement LaTeX-specific Insert and Format commands and other markup-aware editing actions, such as bold, italic, headings, lists, tables, links, images, equations and document formatting. During the PoC, audit these commands and disable or hide unsupported actions for LaTeX with a clear explanation; guard their menu, context-menu, keyboard-shortcut and stale-event routes so they cannot insert Markdown, Typst, HTML or AsciiDoc syntax into a `.tex` file. Keep format-independent editing actions such as typing, undo/redo, find, copy/paste and save working. A later product-integration plan will define and test the actual LaTeX commands; do not present the deferred actions as implemented.
- Exercise a project with a main file, an included chapter, a local image, math, `fontspec`, citations and a `.bib` file. Support literal, project-relative references for the constructs needed by the fixture; use current unsaved contents of open project files when available. Report unsupported or missing inputs instead of silently producing a misleading preview. Full TeX macro expansion for discovering paths and general project management are outside this PoC.
- Test forward and inverse SyncTeX navigation for known source lines in both the main file and the included chapter. Retain the selected main file as the compilation root while navigating to an included file. Line/region correspondence is the target; exact word-level highlighting for every TeX construct is not promised. Uncertain or stale mappings must not select the wrong source.
- Cover a real local BibTeX bibliography, including resolved citations in the final PDF. Also evaluate a small `biblatex` example with WasmTex's default `biblatex-lite` and record its fidelity and limitations. Full Biber, a remote bibliography service and complete `biblatex` compatibility are outside the success criteria; never label the lite result as full Biber.
- Compile locally. Network access is limited to an explicitly enabled experimental setup and demand downloads from a pinned asset/mirror source; no requests occur at startup or merely because another markup format is opened. Opening an experimental LaTeX document must not download anything until the reader enables this feature. Do not transmit document or bibliography contents to a service. Update the repository's network-policy text and user documentation to describe this new, user-initiated exception.
- Demonstrate offline recompilation only for the fixture whose required engine assets, formats, project inputs, bibliography tools, fonts and packages have already been cached. Do not imply that unseen packages, an evicted cache, arbitrary system fonts or a fresh installation work offline. The experiment does not install the complete TeX Live distribution or implement `tlmgr`.
- Run the real application and compare baseline and PoC artifacts on Windows x64 and Linux x64. Keep the application identifier and product name unchanged. Do not edit the release workflow or publish artifacts. Do not silently classify a Linux build, browser-only test or cross-compilation as a Linux Tauri UI pass.

## Approach and rejected alternatives

Start with a small integration gate in the actual Tauri WebView before changing the editor workflow. Load the pinned headless SDK and a compatible, release-cleared LuaHBTeX engine/format set, force LuaLaTeX, and produce a PDF from a minimal document. Verify loading of the worker, its imported scripts and WASM under both WebView2 and WebKitGTK. The upstream worker uses browser requests, including synchronous requests for missing TeX Live files; an async Rust `invoke` call by itself is not evidence that the transport can be replaced. Preserve MDraft's in-process, no-local-HTTP-server architecture. Prefer a narrowly confined local Tauri resource/protocol and a controlled Rust download path; prove the actual origin, worker, CSP, caching and synchronous lookup behaviour before committing to that design. If that is not feasible, record the failure and a specific narrowly scoped alternative; do not open unrestricted `connect-src` or silently introduce a server.

Fix the SDK to the immutable snapshot above, verify its digest, and select an exact compatible TeX Live year, engine manifest, format and mirror revision. Record the identifiers and checksums in the experiment; do not mix assets merely because they share a year. Verify downloaded engine/format assets against a trusted pinned digest. For package and font files, use a pinned immutable mirror and verify individual hashes when reliable upstream metadata is available; record explicitly any remaining verification gap. Load engine assets from app-managed local storage after the reader elects to install them, rather than charging every installer for a TeX tree. If workers cannot use those installed assets under a platform's origin rules, measure a bundled-engine variant as an experiment and report the impact instead of claiming the optional-install design works.

Create a bounded project snapshot using MDraft's Rust filesystem boundary and existing session state. Canonicalize and confine every read to the chosen project root, including binary images, and reject traversal, symlink/junction escapes, unsupported paths and resources that exceed explicit file/count/size/depth limits. Preserve unsaved tab contents for matching open project files. Do not grant the frontend general filesystem access, execute shell escape, or copy the document to a remote service. A snapshot belongs to a particular main file and revision set; invalidate its result when any input changes.

Extract only the general PDF page/viewer responsibilities from `src/typst-pdf.ts`: PDF.js loading, rendering, text layer, zoom, page lifecycle and selection geometry. Inject or adapt source correspondence so the existing Typst mapping remains unchanged and the LaTeX adapter consumes WasmTex's SyncTeX results. Reuse the current generation/cancellation ownership so an older compile cannot replace a newer preview or exported PDF. Keep CodeMirror and MDraft's existing PDF.js; do not bring in Monaco or a second viewer. Check npm's optional peer resolution against MDraft's existing PDF.js version rather than assuming the headless entry avoids every install-time conflict.

Use WasmTex's documented persistent asset cache if it works in the actual Tauri hosts. Its IndexedDB cache is opt-in and bounded, and engine assets are separate from cached TeX Live files. Test the real cold → warm → restart → offline sequence and expose a useful missing-asset error. Preserve the cache identity for the pinned mirror; a test must not accidentally switch the mirror URL and thereby test a different namespace.

Rejected alternatives: bundling the full TeX Live tree or the whole WasmTex UI (installer size and duplicated editor/viewer); silently routing a `fontspec` document to XeLaTeX (the requested engine is LuaLaTeX); relying on a server or sending documents to one (privacy and offline goals); claiming generic offline support from an in-memory cache; assuming a working browser demo proves WebView2/WebKitGTK or Tauri protocol behaviour; and replacing the Typst page-map algorithm wholesale without regression evidence.

## Steps

### Completed evidence and handoff

- [x] Created branch `feat/wasmtex-lualatex-poc` at the approved base and an independent worktree; the user requested returning the branch to the main checkout after committing.
- [x] Produced PDF in real Windows/WebView2 and Linux/WebKitGTK from the fixture with explicit LuaLaTeX, `fontspec`, included chapter, local image and resolved local BibTeX.
- [x] Tested warmed-cache recompilation after restart with an unavailable proxy and an uncached `qrcode.sty` positive control on both platforms. The separate `biblatex-lite` evaluation failed fidelity and is reported as such.
- [x] Validated main/chapter SyncTeX navigation and unsaved buffers in Windows, and visually checked chapter navigation in Linux. A Windows hidden offline run passed 16/16 checks before the last toolbar change; the latest toolbar and full interaction contract still require regression checks.
- [x] Added a hidden isolated test mode, verified zero visible main windows and unchanged foreground/user settings, then passed a hidden smoke run (114/114). Interrupted the earlier foreground suite at the user's request and restored the original settings and recovery, verifying hashes.
- [x] Measured provisional baseline and PoC package sizes, engine assets and the warmed cache; recorded the values below.
- [ ] Product-grade word/range correspondence, bidirectional Sync Scroll, final Windows/Linux size and memory measurements, PDF-save/UI regressions and the full suite remain open. Continue them in the separate [product integration plan](2026-11-06-latex-product-integration.md); this PoC is not marked complete.

- [x] After approval, mark this plan approved, create the isolated worktree and `feat/wasmtex-lualatex-poc` from the recorded base, move only the task's plan into it, and install dependencies independently. Record any base change and do not overwrite intervening work. — Created the managed worktree at the recorded `70dda452` base and installed its own `node_modules` with `npm ci`; the original checkout was not changed apart from moving this plan.
- [x] Build and record same-toolchain baseline artifacts for both platforms. Preserve them outside build output paths that later builds clean. Confirm the Linux environment can build and run a Tauri WebKitGTK application; use a distinct `MDRAFT_BUILD_DIR` for every Linux worktree/build to avoid `scripts/build-linux.sh`'s `rsync --delete` and bundle cleanup touching another build. — Both builds were preserved in ignored `bin/wasmtex-poc/baseline/`; a separate Tauri WebKitGTK gate ran successfully. The actual MDraft Linux UI is still a separate pending check.
- [x] Pin and verify the WasmTex SDK snapshot and a compatible engine/format/mirror set. Check Node 24 installation/build behaviour, lockfile reproducibility, optional PDF.js/Monaco peers and required license/source notices. Record any compatibility gap before proceeding. — SDK and engine hashes are pinned, the npm override retains MDraft's PDF.js without Monaco, and upstream licences/source links are retained. The engine-build and format-generation mirror revisions differ; see the notes below.
- [ ] Prove the minimal headless LuaLaTeX worker in the real Windows and Linux Tauri hosts, including local asset delivery and controlled package lookup. Exercise a missing engine and a failed lookup with actionable errors. If the transport cannot work within the stated boundary, stop and document the cause and options rather than widening scope silently.
- [ ] Add a confined, bounded project snapshot and an experimental `.tex` compilation path. Preserve unsaved main and included-file buffers, handle binary images, set LuaLaTeX explicitly, and fence asynchronous work by project snapshot and generation. Add a real PDF export that cannot write a stale result.
- [ ] Audit markup-aware Insert, Format and related editing actions. For LaTeX, disable or hide the unimplemented actions, provide a clear explanation and guard all invocation routes; retain ordinary text-editing actions. Defer implementing LaTeX-specific command syntax until after this PoC is validated.
- [ ] Generalize the existing PDF viewer only as needed, preserving the Typst adapter, and connect the WasmTex SyncTeX adapter for main and included-file navigation. Preserve page disposal, fit/zoom, selection, scroll and the existing Typst interactions.
- [ ] Match the existing pane interactions for LaTeX: source click blink without scrolling, Pages click paints a source paragraph without taking the selection, exact selection correspondence in both directions with Escape dismissal, and bidirectional Sync Scroll. Add real-app checks for both operating systems and fail closed when correspondence is uncertain.
- [ ] Add the reproducible fixture and checks for included source, image, mathematics, Lua/font selection, multiple passes, real BibTeX citations, SyncTeX and the observed `biblatex-lite` subset. Include error cases and editing or closing/switching tabs while compilation is in flight.
- [ ] Test initial setup and on-demand asset access only after explicit enablement. Confirm persistence, exit the application, block external network for the test process while retaining local IPC, reopen and recompile the unchanged fixture. Instrument both worker and host requests; use a deliberately uncached package as a positive control and report failed or attempted requests. Do not alter the machine-wide firewall.
- [ ] Run the required targeted and repository test layers, the real Tauri checks on both operating systems, and baseline-versus-PoC artifact and performance measurements. Record exact commands, versions, sizes, cache conditions, results and any unavailable checks.
- [ ] Update this plan with checked steps and deviations, document the experimental workflow and limitations, add any required third-party notices/ADR, and recommend whether to pursue product integration. Record non-obvious repeatable traps in `AGENTS.md` and document every new repository script there.

## Measurements and investigation so far

Baseline built from `70dda452` before the SDK dependency was added. Sizes are bytes:

| Platform | Artifact | Baseline bytes |
| --- | --- | ---: |
| Windows x64 | `mdraft.exe` | 19,193,856 |
| Windows x64 | portable executable | 19,193,856 |
| Windows x64 | NSIS setup | 10,720,479 |
| Windows x64 | MSI | 12,214,272 |
| Debian/WSL2 x64 | `mdraft` | 24,210,288 |
| Debian/WSL2 x64 | `.deb` | 13,626,382 |
| Debian/WSL2 x64 | AppImage | 119,196,152 |

Windows used Node 24.22.0 and Rust 1.99.1; Linux used Node 24.13.1, npm 11.18.0, Rust 1.91.1 and WebKitGTK 2.54.0. Preserve these toolchain choices for the corresponding post-change comparison.

The pinned SDK archive's SHA-256 matches the approved snapshot. npm 12 defaults to `allow-remote=none`; this branch opts in only to root URL dependencies. The SDK's optional PDF.js peer requires version 5 while MDraft already uses version 6; a scoped WasmTex-only npm override retains the existing PDF.js and leaves other peer checks enabled.

The 2025 engine asset manifest observed for the experiment is release `2025-3a6c0df0b2b95005`, SHA-256 `928bd4b75ff945ffe3b782da99a61b89ee4c38fcda8ccb5c0390aafda3d12b4a`. The selected LuaLaTeX and BibTeX files were individually checked against it. The LuaLaTeX format's generation receipt identifies mirror `2025-0d3fc73b65e39905`, which differs from the SDK's default mirror; the initial experiment explicitly selects that format-generation mirror rather than assuming year alone is sufficient. With these files and the Node host, a synthetic LuaLaTeX document produced a 25,881-byte PDF; that is a preparatory check, not evidence of Tauri or offline support.

The real WebView2 and WebKitGTK engines both compiled a minimal LuaLaTeX document in a separate Tauri host using the local protocol; each produced a 4,322-byte PDF and working forward/inverse SyncTeX for its main file. The upstream mirror does not send the needed CORS header to the Tauri origins, so the experiment uses a confined Rust custom protocol with a fixed mirror and a persistent disk cache instead of the SDK's IndexedDB cache. No HTTP server is introduced. The SDK's Lua result omits SyncTeX; the branch enables it on the same source line and reads the gzip through the pinned private worker protocol.

The actual Windows MDraft UI, built with an isolated test identifier and profile, passed 14/14 online checks for the main file, included file, local image, `fontspec`, resolved BibTeX, both SyncTeX directions, unsaved edits, retained main-file root and a guarded format event. After a full restart with WebView2 and Rust HTTPS requests directed to a closed local proxy, the warmed project recompiled and 15/15 checks passed, including a real uncached `qrcode.sty` request that failed and increased the host cache-miss counter. Normal compilation made some uncached lookup attempts even when the final document compiled offline. This is a process-proxy test, not a machine-wide firewall test.

For that Windows fixture the verified engine files occupy 10,549,798 bytes in eight files; the warmed mirror cache occupies 15,647,886 bytes in 125 files. The first setup plus initial render was about 7.8 seconds in this run. Package/font files are from a pinned mirror but are not individually verified against independent hashes. The measured engine-build mirror and format-generation mirror differ, so the successful fixture does not establish compatibility for arbitrary packages.

The separate `samples/latex-poc/biblatex-lite.tex` Node-host evaluation took 15,543 ms and returned `success: true` with a 6,285-byte PDF, but also reported `File 'biblatex-lite.bbl' not created by biblatex`, an undefined citation and an empty bibliography. PDF text confirmed `[knuth1984]` with no bibliography. This is a failed fidelity check, not Biber support; the adapter now treats those diagnostics as a compilation failure.

The real Linux/WSL WebKitGTK MDraft also displayed the fixture, including the image and resolved bibliography. After exiting, it reopened and recompiled the warmed fixture while HTTP(S) traffic was routed to a closed localhost proxy. A separate file requiring the uncached `qrcode.sty` failed with a missing-package explanation. Clicking the PDF opened and highlighted the included chapter; source-to-PDF also worked, but initially marked an unrelated line and was subsequently tightened to reject ambiguous regions. These checks were visual; Linux unsaved-file interactions have not yet been independently automated. The Linux cache was warmed on Linux and stored outside the build staging directory.

The Linux fixture used the same 10,549,798 engine bytes and 15,647,886 cached mirror bytes as the Windows fixture (eight and 125 files respectively).

Provisional same-toolchain packaged measurements, before the final cancellation adjustment:

| Artifact | Baseline bytes | PoC bytes | Difference |
| --- | ---: | ---: | ---: |
| Windows x64 executable / portable | 19,193,856 | 19,458,560 | +264,704 |
| Windows x64 NSIS | 10,720,479 | 10,884,160 | +163,681 |
| Windows x64 MSI | 12,214,272 | 12,390,400 | +176,128 |
| Linux x64 executable | 24,210,288 | 24,447,856 | +237,568 |
| Linux x64 deb | 13,626,382 | 13,799,318 | +172,936 |
| Linux x64 AppImage | 119,196,152 | 119,372,280 | +176,128 |

These installer figures exclude the separate engine and on-demand cache. A later Windows offline run measured 4,331 ms for the initial compile/page load and 4,528 ms for a warm edited compile/page load, plus the 800 ms edit debounce. Peak memory and comparable Linux timing remain to be measured.

## Files and modules

Exact additions may be adjusted within the approved scope and recorded here during execution.

- `package.json`, `package-lock.json`: pinned headless SDK dependency and any genuinely required test entry points; avoid Monaco and a second PDF.js.
- `src/api.ts`, `src/main.ts`, `src/sessions.ts`, editor/language modules, `src/context-menu.ts` and native menu state in `src-tauri/src/menu.rs`: experimental `.tex` detection, project-root and tab/snapshot ownership, preview, export, enablement, diagnostics and safe availability of deferred markup commands. Change only the parts actually needed by the PoC, preserving existing saved settings.
- `src/typst-pdf.ts`, potentially a new shared PDF-viewer module, `src/typst-page-map.ts` and a new LaTeX/SyncTeX adapter: reuse rendering while keeping Typst's current mapping and interaction contract.
- New focused LaTeX compiler/project modules under `src/` and new confined Rust filesystem/asset commands under `src-tauri/src/`, registered via `src-tauri/src/lib.rs`: snapshot, asset storage and safe PDF output. Review command payloads as new public contracts and keep input/output bounds explicit.
- `src-tauri/tauri.conf.json` and/or the existing Tauri protocol implementation only if the minimal host experiment establishes a necessary, constrained change; preserve the no-server design and do not add blanket network or filesystem permissions.
- `samples/` or a dedicated test fixture directory: main `.tex`, included chapter, local image and bibliography; any new test scripts go in `scripts/` and are indexed in `AGENTS.md`.
- `docs/` and `AGENTS.md`: this plan, experimental user instructions, supported limitations, explicit user-initiated network exception, source/license notices, test inventory and reproducible measurements. Add an ADR only when a decision is intended to outlive the PoC.

## Risks and rollback

- Browser worker origin, synchronous resource loading, CSP, custom protocols and IndexedDB can behave differently on WebView2 and WebKitGTK. The first platform gate tests this before the main refactor. If either host fails, keep the branch as evidence and document the blocker and a bounded follow-up.
- WasmTex and its asset publishing are evolving; pin the SDK and assets independently, confirm compatibility and preserve exact third-party source and notices. The SDK's MIT license does not cover every engine, format, font or TeX Live package.
- Reusing the PDF viewer risks Typst regressions in rendering, scrolling, highlighting, selection and cancellation. Keep its mapper as an adapter and run its existing real-app tests, not just the new LaTeX tests.
- Project files and generated output can be large or hostile. Use bounded reads, a confined root, no shell escape, no document upload and clear errors. Do not overwrite an existing target on a failed or stale export.
- A cache can be incomplete or evicted, and optional resources may still be requested. Test after restart with network blocked and an uncached positive control; do not promise indefinite offline operation.
- Small WASM files do not imply low peak memory or quick first compilation. Measure both cold and warm operation and input responsiveness with the actual fixture on each host.
- Roll back by leaving or deleting the isolated branch/worktree after preserving its results; the original checkout is not reset or cleaned. Never force-remove a worktree that contains a junction to another checkout's `node_modules`.

## Tests and validation

1. **Reproducible baseline and packaging:** same base revision, SDK/engine version where applicable, Node/Rust/toolchain, flags and architecture for before/after. On Windows measure bare/portable executable, NSIS and MSI; on Linux measure bare executable, `.deb` and AppImage. Record exact bytes and deltas, not just rounded sizes. Separate installer bytes, initial engine download, package/font transfer, and cache size after the fixture; note what each figure includes. Do not install over the user's application to take measurements.
2. **Focused unit and security checks:** snapshot path confinement, traversal and junction/symlink escape, binary integrity, input bounds, source revisions, stale results and PDF-save failure/overwrite safety; SyncTeX coordinates and source identity in both files. Run the smallest checks first, then `npm run build` and the repository's Rust tests using the Windows MSVC wrapper where required.
3. **Real-app fixture:** verify visible LuaLaTeX PDF, included chapter, image, equation and resolved BibTeX citation; compare produced PDF structure/text and inspect page rendering. Verify unsaved main and included edits, changing/closing tabs, diagnostics and both SyncTeX directions. Exercise `biblatex-lite` separately and report differences. Check representative deferred Insert/Format commands through menus, context menu, shortcuts and stale events: they must not modify LaTeX source; ordinary editing continues to work and supported commands return when switching back to another markup language.
4. **Offline:** clean cache, explicit install/enablement and first successful online compile; ensure persistent writes complete, fully exit and restart, block external network for this process, and compile the same snapshot successfully. Verify the block with a deliberately missing package and ensure the UI reports it. Record network attempts and distinguish engine storage from IndexedDB cache.
5. **Regression and performance:** run existing `typst:preview`, `typst:map:unit`, `word-sync`, `sync`, `preview:zoom`, `tabs`, `menu` and relevant lifecycle/export layers, then the applicable full `npm test` per repository governance. Measure first compile, warm edit-to-PDF, input responsiveness and peak process memory under stated conditions; identify environment and number of runs.
6. **Both platforms:** use the MSVC wrapper on Windows. Build and run natively in Linux/WSL with WebKitGTK and a display for the UI checks. `wsl --list --verbose` returned `Wsl/E_ACCESSDENIED` inside the current sandbox during planning, so Linux availability is unconfirmed, not absent. If access or a GUI is unavailable, resolve it where authorized or explicitly report the Linux check as blocked; do not mark the cross-platform acceptance criterion passed.

## Acceptance criteria

- The named branch and isolated worktree exist; the original checkout and unrelated files are preserved. The exact SDK, engine, format, mirror and license/source provenance are recorded.
- In the real Windows and Linux Tauri applications, the fixture compiles with explicitly selected LuaLaTeX and the existing PDF viewer shows its included text, image, mathematics and resolved BibTeX citation. The successful PDF can be saved without exporting stale or incomplete results.
- SyncTeX navigates between a known main-file line and its PDF region in both directions, and likewise for a known included-chapter line. Wrong, ambiguous or stale mappings are rejected. Typst's existing preview and synchronization tests remain green.
- LaTeX-specific Insert/Format implementations remain deferred and are described as such. Unsupported markup commands cannot insert another language's syntax through any invocation route, while ordinary text editing and the existing commands for other languages continue to work.
- After the fixture's assets are warmed and the application is restarted, the same project recompiles while external network is blocked; an uncached package proves the block and produces a clear failure. The scope and cache-eviction limitation are documented.
- There is no startup network request and no LaTeX asset download before explicit experimental enablement. No source document is transmitted. Project reads remain confined, and incomplete or invalid inputs are surfaced.
- A results table contains measured before/after artifact sizes, initial transfer and cached bytes, and cold/warm time and memory for both operating systems, with commands and environment. All required checks pass or are clearly marked unavailable; no untested host or incomplete bibliography mode is represented as supported.

## Open questions

- **Biber:** default is real BibTeX plus an explicit `biblatex-lite` evaluation, with full Biber deferred. If full Biber is a prerequisite for this PoC, revise scope before implementation. [Biber is out of scope]
- **Runtime asset transport:** the exact Tauri protocol/origin and persistent cache behaviour must be established by the early Windows/Linux gate; no solution is assumed without a real-host test.
- **Linux execution:** WSL availability and a working WebKitGTK/display environment remain to be confirmed outside the restricted planning probe. A native Linux machine or runner is an acceptable equivalent for build and real-app testing.
- **Offline duration:** the default is a warmed-fixture guarantee, subject to cache availability and eviction; an installed, permanently managed package collection would be separate product work.
- **Product adoption:** a successful PoC supports a later decision and ADR; it does not itself approve a merge, release, complete LaTeX compatibility or a permanent network policy beyond the experimental workflow.
