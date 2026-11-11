# Shared local TEXMF libraries with predictable resolution

**Status:** draft
**Date:** 2026-11-10
**ADR:** ../adr/2026-11-10-local-texmf-libraries.md — proposed; write after approval.

## Context and goal

A reader cannot register a personal TEXMF tree once and use its classes and
packages across MDraft projects. The bundled engine receives a project-confined
snapshot, and the native runner replaces TEXMFHOME with a private job directory.
Copying a class beside every document is inconvenient and is not sufficient:
the project collector recognises documentclass/usepackage but misses the
LoadClass/RequirePackage family.

After this change, a reader can choose a personal packages folder, keep their
existing TDS tree, or register a simple folder of packages. The same ordinary
documentclass/usepackage declarations work in unrelated projects and across
the bundled LuaLaTeX and supported installed engines. Originals remain the
reader's files; downloaded-package eviction cannot delete them.

### Inspected baseline and constraints

- Investigated on branch feat/wasmtex-lualatex-poc; HEAD observed as 2840c2a
  during planning. The working tree already contains substantial unrelated
  changes, including the compiled-preview workspace and ownership work. This
  plan does not approve overwriting, reverting, or committing those changes.
  Recheck the baseline and current function bodies before implementation.
- Relevant current entry points: collect_referenced and declared_references
  in [latex.rs](../../src-tauri/src/latex.rs); compileLatex in
  [latex.ts](../../src/latex.ts); base_environment/stage in
  [latex_native.rs](../../src-tauri/src/latex_native.rs); latexRows in
  [preferences.ts](../../src/preferences.ts); renderLatexPreview,
  latexExportSnapshot and applySettingsPatch in [main.ts](../../src/main.ts).
- The SDK snapshot resolves to d6a39bc62ed7abd4d95c87bf13ab386005b682fb.
  The engine release resolves to 3e4d679cbe7ec9b93944a8de46663af7b98a5254.
  These are separate pins. Inspecting current upstream main is not proof that
  the installed engine has a capability.
- The pinned [LuaTeX controller](https://github.com/corca-ai/wasmtex/blob/3e4d679cbe7ec9b93944a8de46663af7b98a5254/wasm-build/luatex-worker.js)
  writes its own texmf.cnf before compilation. Its default paths search the
  working directory and mirror cache. Merely supplying a project texmf.cnf
  cannot establish a shared tree.
- The pinned [kpathsea wrapper](https://github.com/corca-ai/wasmtex/blob/3e4d679cbe7ec9b93944a8de46663af7b98a5254/wasm-build/kpse-hook.c)
  searches local MEMFS first, then uses the JavaScript mirror resolver.
  That resolver can reject a name using its Bloom/negative caches before
  requesting the mirror. A Rust-only mirror override would miss private names.
- The SDK supplies files through its public files/setFile surface. Its
  [bibliography handoff](https://github.com/corca-ai/wasmtex/blob/d6a39bc62ed7abd4d95c87bf13ab386005b682fb/src/headless.ts)
  forwards selected bibliography inputs to a separate worker. A tree available
  to LuaLaTeX is not automatically available to BibTeX.
- Follow [TDS format-specific searching](https://tug.ctan.org/tds/tds.html#Duplicate-filenames)
  rather than one recursive basename map: legitimate format-specific files
  can share a name. Browser MEMFS is separate from the host filesystem;
  [NODEFS is Node-only](https://emscripten.org/docs/api_reference/Filesystem-API.html#nodefs).

## Scope and non-scope

In scope:

- An ordered, per-user list of explicitly registered local libraries, shared
  by projects and compilation backends; an app-provided personal-folder action.
- Standard TDS roots, including tex/latex, applicable engine-specific and
  generic TeX inputs, Lua support files, BibTeX styles/databases, and supported
  font resources. A simple recursive packages-folder mode also works.
- Transitive custom class/package loading, optional inputs, and runtime
  package resource lookup without asking readers to duplicate declarations.
- Original-byte preservation for TeX runtime files and binary assets;
  directory structure, lookup precedence, provenance, and bounded snapshots.
- Local package/class completion, actionable diagnostics, input invalidation,
  normal PDF export/print behaviour, and cross-platform regression coverage.

Outside this change:

- Registering new bundled TeX engines, upgrading TeX Live, installing CTAN
  packages into a distribution, executing installers, or running texhash,
  updmap, mtxrun, shell escape, or project executables.
- A general TeX macro interpreter in the static project scanner; the existing
  restrictions on arbitrary project paths remain. Library runtime lookup is
  handled by the real engine against the captured library namespace.
- Automatic scanning/importing of home directories, environment TEXINPUTS,
  a full TeX installation, or operating-system font directories.
- Automatic font-family database rebuilding. Private OpenType/TrueType fonts
  are supported by filename/path; family-name lookup is not promised.
- Executable/native Lua modules, custom format dumps, arbitrary web2c or
  texmf.cnf overrides, and new external helper programs. Existing backend
  restrictions, including the bundled Biber limitation, remain visible.
- Per-project library profiles, distributing a project with its dependencies,
  and editing assistance for package internals beyond current editor support.
- A new compile-output cache or a redesign of the shared preview workspace.

## Approach and rejected alternatives

Treat a local library as a read-only compiler input with its own origin and
revision. Rust validates the registered roots and captures a bounded immutable
library snapshot. The frontend passes that namespace to a small, versioned
WasmTeX compatibility adapter. Native compilation stages the same captured
inputs into private library directories and configures its search paths there.
Document sources, library sources, generated output, and downloaded packages
keep separate identities.

### 1. Preferences and the everyday flow

Add a **Local packages and classes** group under Preferences > LaTeX, shared
by the two backend groups. Preferences search must find "TEXMF", "local
packages", "classes", and "TEXINPUTS".

The initial state explains: "Add a folder once to use your own classes and
packages in every LaTeX project." Offer:

- **Create personal folder...** Creates and registers the app configuration
  directory's texmf/tex/latex/local folder, then opens it in the file manager.
  The registered root is texmf. The help text states what the action creates.
  Repeating it opens the existing folder and never overwrites its contents.
- **Add folder...** Uses the existing native directory picker. Inspect the
  selected directory before saving. Recognise a TDS root or a simple packages
  folder, show the detected layout, and allow correcting that layout. Do not
  silently register a parent directory or enable an engine.

Each root has a short name, selectable full path, enabled switch, layout,
status, Open, Refresh, Move up/down, and Remove. Use labelled, keyboard
accessible actions; boundary reorder buttons are disabled with a reason.
Successful inspection reports usable package/class counts. Busy, empty,
unreadable, unavailable, oversized, and conflicting roots have distinct states
and a specific remedy. Picker cancellation and failed validation do not save
partial entries. Remove only unregisters the root; it never deletes files and
does not require a deletion confirmation.

Explain priority beside the list: **Project files, then enabled folders from
top to bottom, then the engine's standard packages.** Show a small placement
example in help:

    texmf/
      tex/latex/my-package/my-package.sty
      tex/latex/my-class/my-class.cls

Use on-demand inspection and cancellable busy feedback. Keep focus on the
acted-on row after refresh/reorder; announce status changes accessibly.
Use the shared Logs view for package-origin details and problems. A missing
custom package offers **Manage local packages...**, focused on this group.
No folder-management controls or warnings are drawn over the PDF.

### 2. Settings and authority

Add latexTexmfRoots, defaulting to an empty list. Each record has:

    id: stable opaque identifier
    kind: personal | folder
    path: absolute selected path for folder; absent for personal
    layout: tds | packages
    enabled: boolean

List order is search order. Resolve a personal root through Tauri's
app_config_dir at use time so portable settings and the personal tree move
together. External folders remain explicit machine-local paths; a moved drive
is reported rather than silently replaced. Existing settings keep loading with
unchanged effective behaviour when the list is empty.

Use dedicated typed backend operations for configure, inspect/refresh, and
open. Configure accepts a tagged action: addFolder, usePersonal, setEnabled,
setLayout, move, or remove. Mutations validate against current settings and
commit through AppState::save, returning the saved configuration and report.
Open takes a registered root ID, not an arbitrary path. Refresh reads files
only; it neither compiles nor downloads. Do not expose generic filesystem or
shell access to the frontend.

Proposed command names are latex_texmf_configure, latex_texmf_inspect, and
latex_texmf_open. Inspection takes registered IDs or one explicitly selected
candidate, plus a refresh flag; reports contain typed states/issues and counts,
not executable commands. Reserve precise argument/return types in the ADR
before implementing their Rust and TypeScript halves.

Do not auto-enable the bundled engine or execute a native probe when adding
a library. The existing backend choices remain independent.

### 3. Index, precedence, and resource bounds

Create a focused Rust TEXMF module rather than putting another subsystem into
latex.rs. It owns canonical roots, typed lookup domains, indexing, validation,
capture, content fingerprints, and structured reports. No new npm or Cargo
dependency is planned.

- Resolve TDS TeX inputs in the active format/engine's applicable directories
  before generic inputs. Keep Lua, bibliography, and font lookup domains
  separate. Preserve all relative directories in the captured namespace.
- A simple packages folder supports ordinary loose classes/styles and their
  subdirectories without requiring readers to reorganise existing files.
  Preserve those paths too; do not flatten its entire contents.
- Project-local files win. Enabled roots then win in visible order. Standard
  distribution/mirror fallback comes last. Within one root/domain, reject
  ambiguous duplicate lookup names with both paths instead of selecting an
  arbitrary directory-entry order. Format-specific duplicates permitted by
  TDS are not conflicts. Report cross-root shadowing without blocking an
  intentional override.
- Deduplicate equivalent roots using platform path identity. Diagnose
  overlapping roots, exact/path aliases, and case-only portability conflicts.
  Preserve Unicode and spaces; never interpolate a reader's path into TeX,
  JavaScript, a shell command, or an unescaped search-path expression.
- Walk only approved runtime portions of a TDS tree. Skip doc, source, bin,
  web2c, hidden metadata, symlinks, junctions/reparse-point escapes, devices,
  and host executable files. Permit package-owned data/images and source Lua
  files needed at runtime. Preserve binary files as bytes. Do not reinterpret
  a library's texmf.cnf, Lua bytecode, native module, or format dump as config.
- Verify containment when opening files as well as while indexing. A link
  substitution or file change between listing and read cannot broaden access.
  Retry an unstable capture a bounded number of times, then name the changing
  file; never combine unlabelled generations.
- Initial limits: 8 roots, 4,096 runtime files, 64 MiB library bytes combined,
  32 MiB per file, 16 directory levels, and a bounded directory-entry scan.
  Keep the existing project limits separate. Surface the exact exceeded limit
  and suggest a smaller private tree; never silently truncate a library.
  These are implementation budgets, not another set of Preferences controls.

An enabled root that is missing, unreadable, or invalid blocks a new compile
with a named remedy. Do not silently fall back to a different version of its
packages. Disabling that root is the explicit way to continue. The previous
same-project PDF remains readable as previous output.

### 4. Captured inputs and the compiler boundary

Extend LatexProjectSnapshot additively with a separate TEXMF snapshot:
ordered root IDs/layouts, virtual relative paths and bytes, lookup/provenance
metadata, structured issues, and a content-derived revision. That revision
covers enablement, order, layout, paths, and content, not just directory mtimes.
NativeCompileRequest carries the separate library snapshot as well. Validate
all received virtual paths, counts, byte totals, and reserved names again at
the native staging boundary.

Keep snapshot.files as project files. A library .tex must not become a chapter,
a PDF/source correspondence candidate, a project owner member, or a Pandoc
input just because its extension is .tex. Track library errors with their own
origin. Open a registered original only through its validated origin mapping;
it must not pin that file or another project to the current document's PDF.

Capture all eligible runtime files from these deliberately small libraries:
the engine, rather than a regex scanner, can then discover a computed package
name, InputIfFileExists, an internal .def/.fd, a Lua module, or package data.
Cache metadata and immutable content buffers in Rust to avoid repeated
allocations. A capture verifies bytes/digests and does not trust metadata alone.
No full TeX distribution is copied or exposed.

The existing project collector gains the missing LoadClass,
LoadClassWithOptions, RequirePackage, RequirePackageWithOptions and
bibliographystyle declarations. Extend its existing lexical/masking helpers;
do not invent a fourth scanner. Preserve optional-file semantics. The frontend
reference check consults the captured library namespace before labelling a
literal TeX/bibliography input missing. It does not scan or reject the internal
macro implementation of a library as though it were a project document.

### 5. Bundled engine integration: prove this before building the UI

Use a small source-owned adaptation of the pinned JavaScript worker controller,
with a versioned manifest under a reserved virtual prefix. Pass the manifest
and namespaced library bytes through the SDK's public files interface. The
controller installs the library paths in its generated search configuration
before the first TeX lookup. Native engine binaries, the TeX Live year, format,
and mirror remain pinned.

Keep the exact upstream controller provenance, licence, and a reviewable diff
beside the adapter. Bundle only the adapted controller and its small helper,
not a second copy of the SDK or the engine binaries. Keep installation and
asset verification explicit about which assets are bundled and which are
downloaded. Never edit node_modules, rewrite JavaScript strings at runtime,
access private SDK worker fields, or accept arbitrary configuration from a
document. Reserve the manifest prefix in project validation.

Before any UI controls are added, demonstrate on the exact pinned assets:

- A nested TDS class loads another private class and two private packages,
  including WithOptions variants, internal .def/.cfg/.fd files, and a Lua file.
- Local lookup wins even when that private name is absent from the mirror
  Bloom filter or was negatively cached during an earlier failed compile.
- Format-aware search, multiple-root precedence, resource-relative paths,
  binary assets, and supported font-by-filename lookup work.
- Private .bst/.bib inputs reach the separate BibTeX worker. At this narrow
  auxiliary boundary, resolve requested bibliography names through the same
  index and forward their exact selected inputs with origin metadata. This
  handoff is distinct from flattening the general TeX library namespace.
- Reinitialisation, a new library revision, repeated compile, and Cancel do
  not retain a removed file, old search path, or old successful/negative cache.

The compatibility proof must exercise real compilation and output, not source
string assertions. If the public SDK handoff requires a dependency repin or a
larger fork, record the measured alternative and revise this plan for approval
before taking it. Do not ship a control backed by an incomplete proof.

### 6. Installed engines use the same captured inputs

Stage library snapshots under a reserved private directory alongside the staged
project, with separate roots in the same order. Use generated, platform-correct
search paths for TeX/Lua, BibTeX, and font inputs. Preserve the distribution's
default search paths through its supported fallback mechanism. Do not redirect
the selected distribution's package-manager configuration or remove the
existing MiKTeX/TeX Live font-cache handling.

All output and writable caches remain in the private job. MDraft never runs an
index updater, registers roots globally with MiKTeX, changes environment
variables for the parent app, or writes to the user's original trees.
Shell escape and project executables stay disabled. The installed engine still
runs with the reader's OS permissions, as the existing trust disclosure says;
staging is not a new OS sandbox.

Validate actual lookup using TeX Live and MiKTeX, and LuaLaTeX/pdfLaTeX/XeLaTeX
where installed. An environment-variable unit test alone cannot prove native
distribution compatibility.

### 7. Freshness, completion, and export

Include the library revision in compile identity and result acceptance. A
configuration change cancels/invalidates the current LaTeX job, completion
catalog, and successful-output eligibility. Inspect registered trees on
Preferences inspection, before compilation, and on app focus with an active
LaTeX project. Verify captured inputs again before publishing a result and
before a current-PDF export/print action. Use bounded, coalesced background
work; none of this runs on every keystroke or scans an unrelated home tree.

When a library changes, mark affected LaTeX output stale conservatively and
retain the prior readable PDF. Auto-compile may schedule a rebuild; manual
mode stays manual. A refresh and a settings change do not override that switch.
An old compile cannot publish after removal/reordering, a tab switch, or a
new library revision. Clear all job-owned input buffers when their owners end.

Make local class/package names available to completion from the latest
explicit inspection/capture, with a short "Local: <folder>" origin. Deduplicate
according to lookup priority. Completion itself never reads disk, compiles,
downloads, or infers arbitrary commands from package implementations.
Scope the catalog to the active editor/root and library revision, and clear
or replace it on document switches; do not use a mutable process-global
completion list that can leak another document's context.

PDF Save/Export/Print continue to use the compiled bytes. Pandoc conversions
keep their existing project-source snapshot and fidelity limitations: a
registered library must not cause unrelated source files, labels, or
bibliographies to be injected into a conversion.

### Rejected alternatives

| Alternative | Reason |
| --- | --- |
| Tell users to copy files beside every project | Does not provide one shared installation and misses transitive/runtime inputs. |
| Follow project symlinks or allow arbitrary parent paths | Broadens the existing document filesystem boundary instead of adding an explicit library boundary. |
| Put private files in the mirror cache | Eviction can delete them, cache clears affect user assets, and resolver Bloom/negative caches can prevent lookup. |
| Serve a local-first mirror endpoint only | Private names may never reach it; it also loses TDS path/domain semantics. |
| Flatten every class/package into the project root | Creates collisions, breaks resource-relative paths, and obscures provenance. |
| Trust process TEXMFHOME/TEXINPUTS or invoke texhash | Does not configure browser MEMFS and introduces implicit machine-dependent state. |
| Copy an entire installed TeX distribution | Excessive scan, memory, IPC, and staging cost; use the native backend for that installation. |
| A large new TeX parsing/indexing dependency | The engine already resolves package internals; use a bounded file index and existing lexical helpers. |

## Steps

- [ ] Recheck the working tree and existing preview changes. Record exact SDK,
  engine and application baseline identifiers and relevant cold/warm sizes.
- [ ] Add an isolated adversarial fixture and prove the bundled controller/
  SDK integration above, including auxiliary lookup, before Preferences work.
  Record the source diff and measurements; revise the plan if its gate fails.
- [ ] Write the ADR, settle typed schema/commands and origin rules, then add
  backwards-compatible settings and Rust configuration/index/capture support.
- [ ] Extend project dependency discovery and reference validation, keeping
  project inputs and library inputs separate. Add boundary and conflict tests.
- [ ] Integrate the versioned bundled adapter and native staged search paths.
  Test real transitive resolution and cancellation on both backends.
- [ ] Add the accessible Preferences manager, personal-folder flow, inline
  diagnostics, and deep link from missing-package errors.
- [ ] Integrate library freshness with preview ownership, manual/automatic
  compile, successful PDF eligibility, and local class/package completion.
- [ ] Run the targeted validation matrix below, inspect the actual Preferences
  and Logs UI at narrow widths, and record all measurements and skips.
- [ ] Update user/agent docs, script catalog and required trap records; tick
  acceptance criteria and mark the plan done only after its gates pass.

## Files and modules

Expected implementation surface; keep unrelated working-tree edits intact.
Update this inventory before adding another area.

| File/module | Purpose |
| --- | --- |
| src-tauri/src/latex_texmf.rs (new) | Root configuration, inspection, capture, lookup domains, provenance, bounds, and unit tests. |
| src-tauri/src/settings.rs | Additive default-empty root records and settings validation. |
| src-tauri/src/lib.rs | Register the focused module and configure/inspect/open commands. |
| src-tauri/src/latex.rs | Extended project declarations, separate library snapshot, reserved paths, and bundled-controller serving. |
| src-tauri/src/latex_native.rs | Separate library staging, typed native request, search environments, and native regression tests. |
| src-tauri/assets/wasmtex-texmf/README.md, luatex-worker.js, bibtex-worker.js, texmf-runtime.js (new) | Exact pinned source provenance, reviewed controller changes, and compatible bundled assets; omit an auxiliary adaptation if the proof establishes the unchanged controller already suffices, and record that decision. |
| src/api.ts | Settings, operations/reports, origin types, and additive compile snapshot contracts. |
| src/latex-texmf.ts (new) | Pure snapshot/lookup/manifest preparation and auxiliary-input handoff. |
| src/latex-texmf-preferences.ts (new) | Focused folder-list UI/controller used by Preferences. |
| src/latex.ts | Namespaced bundled inputs, progress/errors, and library provenance without polluting project sources. |
| src/latex-native.ts | Origin-aware result handling and project-only source correspondence. |
| src/latex-references.ts | Resolve literal references against library inputs and preserve optional semantics. |
| src/latex-diagnostics.ts | Separate library origin/navigation from project membership. |
| src/preferences.ts; src/styles.css | Embed/style the accessible library manager, searchable text, responsive states. |
| src/main.ts | Settings handlers, picker actions, capture/currentness guards, logs/deep links, and completion context lifecycle. |
| src/completion/latex-source.ts; src/completion/project-index.ts; src/editor.ts | Local package/class catalog input and editor-scoped context without reading files during completion. |
| src/assets/wasmtex-licenses/THIRD_PARTY_NOTICES.md | Identify the adapted pinned JavaScript controller and its corresponding source/licence. |
| scripts/latex-texmf-unit.mjs (new) | Meaningful manifest, lookup, origin, freshness and auxiliary-input contract tests. |
| scripts/latex-texmf-test.mjs (new) | Real UI/compiler tests using two projects and an external temporary library. |
| scripts/dom-smoke.mjs; scripts/completion-latex-unit.mjs | Exercise the live Preferences controls and local completion. |
| scripts/latex-sdk-unit.mjs; scripts/latex-references-unit.mjs; scripts/latex-sync-unit.mjs; scripts/latex-native-unit.mjs | Update existing adapter contracts and extend relevant behavioural cases. |
| scripts/latex-project-test.mjs; scripts/latex-native-test.mjs; scripts/latex-preview-test.mjs; scripts/preview-ownership-test.mjs | Preserve real compile, export, currentness, cancellation and project ownership across the new inputs. |
| scripts/test-all.mjs; package.json | Register new app-free and isolated UI layers in the appropriate order. |
| docs/latex.md; README.md | Explain placement, limits, ordering, native behaviour, offline use and removal. |
| docs/agent-guide/architecture.md; docs/agent-guide/catalog/latex-and-formats.md; docs/agent-guide/testing.md | Document module ownership, new scripts and test layers. |
| docs/agent-guide/traps/latex-typst-asciidoc.md | Append only traps actually encountered during implementation. |
| docs/adr/2026-11-10-local-texmf-libraries.md (new); this plan | Durable boundary/search decision and implementation record. |

No new dependency or SDK pin change is approved implicitly by this inventory.
No source patch to the unrelated compiled-preview ownership/workspace feature
is required; integrate through its current helpers.

## Risks and rollback

- **Controller compatibility:** an upstream repin can change startup, path
  initialisation, bibliography handoff, or cache restoration. Bind the adapter
  to explicit engine/SDK versions and fail with an actionable compatibility
  error, rather than quietly ignoring libraries.
- **Memory and latency:** full bounded library capture adds bytes and IPC
  work. Measure before the UI lands; keep Rust buffer sharing and avoid
  decoding binary/runtime library sources into editor strings. Do not hide
  excessive costs by raising limits or weakening freshness.
- **Different distributions:** search syntax, fallback, and font caching differ.
  Check actual output and selected origins on each tested distribution.
- **Package conflicts:** intentional local overrides can break standard packages.
  Make priority and selected origins visible; disable/remove is reversible.
- **Concurrent edits and path races:** copied inputs must describe one capture,
  and late results cannot claim a newer configuration. Revalidate boundaries
  and reject an unstable capture; preserve the last PDF as previous output.
- **Concurrent repository work:** re-read the current preview integration and
  tests at each step. Do not replace files wholesale from the inspected base.

Rollback for a user is to disable or unregister the folders; no original
library content is changed and the empty list uses today's compilation route.
An application rollback may ignore the new settings field. If the code change
is reverted, revert its adapter/schema/UI/tests/docs together, retaining the
reader's files and the unrelated working tree.

## Tests and validation

This draft is documentation only: do not build the application or disturb a
running user's settings to validate the plan. Implementation runs the cheapest
relevant checks in the repository's documented order:

1. npm run build; targeted Rust unit tests through scripts/cargo-vcvars.cmd
   on Windows, then the relevant Rust suite and Linux path tests. Cover old
   settings, empty defaults, canonical duplicates, TDS domains, priorities,
   optional inputs, byte preservation, separate budgets, missing roots,
   symlink/junction swaps, reserved names, unstable reads, and traversal.
2. New app-free TEXMF tests plus latex:references:unit, latex:sync:unit,
   latex:sdk:unit, latex:native:unit, latex:diagnostics:unit,
   completion:latex:unit and preview-owner:unit as affected. Cover immutable
   captures, library-only .tex files, auxiliary routing, and stale jobs.
3. Isolated UI layers through npm test -- --only, including the new TEXMF
   layer, smoke, latex-project, latex-preview and preview-ownership. Use the
   harness's owned profile and temporary directories; never reset the running
   user's settings. Name and document the new layer IDs when added.
4. Real bundled compilation on Windows WebView2 and Linux WebKitGTK, with
   standard dependencies warmed first. Block external package requests and
   compile two separate projects using the same external private tree. Prove
   custom names were resolved locally and the expected text appears in the
   PDF; a returned PDF header or a source-regex assertion is insufficient.
5. Real installed TeX tests with MDRAFT_TEST_TEX_BIN: TeX Live and MiKTeX,
   each available engine, transitive custom dependencies, bibliography,
   supported fonts, retained standard-package fallback, and output cleanup.
   A missing engine/distribution is an explicit unvalidated matrix cell,
   never a passing compatibility claim. Run macOS path tests and smoke on a
   Mac when available; otherwise record that platform validation limitation.
6. UI interaction and visual checks: add/cancel, personal-folder creation,
   path/layout correction, enable/order/remove, missing drive, duplicates,
   busy/cancelled inspection, keyboard/focus/screen-reader labels, and 320,
   480 and 900px Preferences/preview widths in light and dark themes.
7. Modify, add and remove a library resource while compiling, while manual
   mode is on, while changing tabs, and before PDF Save/Export/Print. Check
   previous-output labels, cancelled late results, package-origin diagnostics,
   project-only mapping, and an unchanged Pandoc source snapshot.
8. npm run format:check, npm run lint, npm run knip, and wrapped cargo clippy
   --all-targets -- -D warnings for the changed implementation. Broaden the
   functional suites only for new failures or unresolved interactions.

Record before/after frontend raw+gzip size, bundled adapter size, staged
executable size, peak memory, IPC bytes, snapshot/index/staging time, and
typing responsiveness. Use 100, 1,000 and 4,096-file synthetic private trees
with controlled total bytes, as well as the small real fixture.

Initial performance targets, not claimed measurements: no added filesystem
work per keystroke; no-library compile overhead within measurement noise; a
warm 1,000-file/10 MiB library preparation under 250 ms p95 on this host;
bounded cancellation that does not block typing; memory returns to a stable
baseline after repeated capture/compile/cancel. Report cold and maximum-budget
numbers separately. If a target fails, optimise the captured-input transport
within this design or revise the plan before widening architecture/dependencies.

The decisive measurement: after warming standard dependencies, the same
external private TDS tree produces the expected PDF content in two unrelated
projects, through both backends, with no per-project copies and no external
request for the private files.

## Acceptance criteria

- [ ] Older settings load unchanged; no roots are discovered, enabled, copied,
  or downloaded merely by starting the app.
- [ ] A reader can create/open the personal folder or register an existing TDS
  or loose packages folder without editing JSON or environment variables.
- [ ] One registered tree works in two projects without duplicate package
  declarations or copying its files into either project.
- [ ] LoadClass/RequirePackage and their WithOptions forms, optional inputs,
  internal resources, supported Lua files and font-by-filename lookups work
  from the actual captured tree. No custom-name mirror membership is required.
- [ ] Custom BibTeX style/database inputs reach the auxiliary stage correctly;
  existing native Biber and bundled bibliography limitations remain explicit.
- [ ] Project > ordered enabled roots > standard packages is reproducible;
  same-domain ambiguity is named, and legitimate TDS duplicates still work.
- [ ] Disabled/missing/oversized roots and rejected links have actionable
  messages. An unavailable enabled tree cannot silently change package versions.
- [ ] Roots survive restart and personal-folder paths relocate correctly with
  portable configuration. Remove/cache clear never deletes original packages.
- [ ] Changed libraries invalidate output and local completions; manual mode
  does not compile automatically; a stale job cannot publish current output.
- [ ] Library .tex files never become document chapters, cross-project preview
  owners, correspondence sources, or unsolicited Pandoc inputs.
- [ ] Folder management and failure recovery work by keyboard and at narrow
  widths; controls and diagnostics stay outside the PDF.
- [ ] The pinned-engine proof, applicable automated suites, real cross-platform
  checks, and performance measurements are recorded with honest skips.

## Open questions

- **Default folder location:** use the app configuration directory's texmf
  folder, registered only by the explicit personal-folder action. This is the
  default unless the user requests another location.
- **Large trees:** start with the stated bounded private-tree budget. Lazy
  host-file serving, a full distribution mirror and persistent package-content
  caching are separate architectural work, not automatic scope expansion.
- **Private fonts:** support explicit filenames/paths now. Automatic private
  font-family registration is deferred unless separately requested and planned.
- **SDK compatibility proof:** the controller/public-file approach is the
  default. If a required auxiliary capability cannot be supplied through the
  reviewed small adapter, stop that branch, record evidence and measured
  alternatives, and obtain approval for a revised dependency/integration plan.

No user preference is required to review this draft. Approval of this plan is
the gate to implementation required by [AGENTS.md](../../AGENTS.md#governance-and-workflow).
