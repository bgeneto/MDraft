# Shared local TEXMF libraries with predictable resolution

**Status:** approved 2026-11-11 by the reader ("proceed autonomously to
implementing the plan … in full with e2e tests"); in progress. Revised
2026-11-11: per-distribution native wiring, WSL, console windows.
**Date:** 2026-11-10
**ADR:** ../adr/2026-11-10-local-texmf-libraries.md — proposed; write after approval.

### Revision 2026-11-11 summary

A review against the four target cases (bundled WasmTeX, MiKTeX on Windows,
TeX Live on Linux, TeX Live inside WSL used from Windows MDraft) found:

- Section 6 treated "installed engines" as one mechanism. They are not:
  kpathsea (TeX Live) and MiKTeX resolve user trees differently, and the
  current runner *replaces* TEXMFHOME with an empty private directory. The
  section now names the mechanism per distribution, with the evidence for
  each and the parts that remain unproven.
- WSL was not a supported backend at all. Discovery is Windows-only on a
  Windows build (it looks for lualatex.exe), and an ELF binary in a WSL
  distribution cannot be started by CreateProcess. A new section 7 adds an
  explicit WSL TeX backend; local libraries then reach it through the same
  staged inputs. It is independently shippable and may be split into its
  own plan at approval time (see Open questions).
- A backend × mechanism matrix states, cell by cell, what is proven, what is
  documented-but-unproven, and what is out of scope.
- Reported by the reader: choosing a Windows distribution (for example a
  portable MiKTeX) flashes a console window for every validation probe and
  compile pass. Section 9 fixes it first, because every native and WSL
  launch in this plan goes through the same runner.

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
the bundled LuaLaTeX and supported installed engines — MiKTeX and TeX Live on
Windows, TeX Live/MacTeX on Linux and macOS, and TeX Live inside a WSL
distribution driven from Windows MDraft. Originals remain the reader's files;
downloaded-package eviction cannot delete them.

A reader who already keeps packages in ~/texmf (Linux/WSL) or a MiKTeX user
root finds that the native backend ignores it today, because the runner sets
TEXMFHOME to an empty job directory and MiKTeX roots are never consulted from
the job. Registering that same folder is the supported remedy; MDraft does
not re-enable implicit machine state (see Rejected alternatives).

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
- Revision baseline: HEAD f8a2083, working tree clean. In
  [latex_native.rs](../../src-tauri/src/latex_native.rs) base_environment sets
  TEXMFHOME to job/home, TEXMFVAR/TEXMFCONFIG to job directories, and
  TEXMFCACHE only for MiKTeX; stage writes project files under job/project
  with a 256-file/64 MiB budget. [discovery.rs](../../src-tauri/src/latex_native/discovery.rs)
  is metadata-only, searches PATH plus fixed MiKTeX/TeX Live/MacTeX locations,
  and requires `<engine>.exe` on Windows, so it can never report a WSL engine.
  settings.latex_native_root is a single host path string.
- **TeX Live, measured on this host** (WSL 2.7.11, Debian 13.7, TeX Live
  2025/Debian, kpathsea 6.4.0) with a throwaway fixture:
  - `TEXMFHOME={<r1>,<r2>,<r 3 ü>}` (kpathsea brace list) resolved private
    files from all three roots in list order, including a root whose name
    contains a space and a non-ASCII letter, while standard packages still
    came from texmf-dist.
  - Lookup stayed format-aware: with tex/lualatex/dup/dup.sty, tex/latex/
    dup/dup.sty and tex/context/dup/dup.sty in one root, lualatex selected the
    lualatex copy, pdflatex the latex copy, and neither the context copy. Both
    engines produced a PDF containing the private macros' text.
  - A private .bst under bibtex/bst/ resolved through the same TEXMFHOME.
  - `TEXINPUTS=<loose>//:` found a loose package in a subdirectory.
    **Without the trailing separator, article.cls was not found**: the
    trailing empty element is what keeps the distribution default.
  - No texhash/ls-R was needed: TEXMFHOME is not a `!!` (ls-R-only) entry.
- **MiKTeX, documented but not measured here** (MiKTeX is not installed on
  this host). The [environment-variable chapter](https://docs.miktex.org/manual/envvars.html)
  lists TEXINPUTS, BIBINPUTS, BSTINPUTS, MFINPUTS and TFMFONTS as "extra
  paths"; it does not list TEXMFHOME, LUAINPUTS, OPENTYPEFONTS or TTFONTS, and
  does not document `//` recursion or the trailing-separator default.
  [Unique TeX features](https://docs.miktex.org/manual/texfeatures.html)
  documents `--include-directory=dir`, which "prepends" dir to the input
  search path. Root registration (`initexmf --register-root`, MiKTeX Console)
  is persistent per-user configuration. Treat every MiKTeX mechanism below as
  unproven until the section 6 gate passes.
- **WSL, measured on this host:** distributions are listed without starting
  anything under HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss
  (DistributionName, Version, State, BasePath; this host also lists
  docker-desktop, which is not a user distribution). Windows environment
  variables do **not** reach the Linux process unless named in WSLENV;
  `wsl.exe -d <distro> --cd <dir> --exec env -i NAME=value <program>` passes an
  exact environment as argv without a shell. `--cd` accepts a Windows path and
  translates it (T:\Temp became /mnt/t/Temp). Force-killing wsl.exe also
  terminated the Linux child and its background grandchildren on this WSL
  version — an observation, not a documented guarantee. A login shell
  (`bash -l`) printed unrelated profile noise (a pyenv rehash warning) on
  this host. \\wsl.localhost\<distro>\usr\bin\lualatex is visible as a file
  from Windows, but only while the distribution's VM runs; reaching it starts
  the VM. A tiny document compiled roughly 1.5–1.8× slower from a /mnt (9p)
  directory than from Linux /tmp (lualatex ~620 vs ~400 ms warm; a rough
  single sample, to be re-measured in the implementation).

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
- Per-distribution native wiring (kpathsea vs MiKTeX) with a stated support
  level per lookup domain, instead of one generic environment recipe.
- A WSL TeX backend on Windows: explicit discovery inside a chosen
  distribution, validation by probe compile, and compilation through
  wsl.exe with the same staging, cancel and log mapping as other natives.
- Library folders that live inside a WSL distribution
  (\\wsl.localhost\<distro>\…), captured like any other registered folder.

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
- TeX reached through SSH, Docker/containers, Cygwin or MSYS2; WSL on any
  host other than Windows; installing TeX inside a distribution.
- Registering roots with MiKTeX (initexmf --register-root/--user-roots,
  MiKTeX Console) or editing any distribution's texmf.cnf.

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
  silently register a parent directory or enable an engine. On Windows a
  folder inside WSL (for example \\wsl.localhost\Debian\home\me\texmf, the
  usual place for an existing Linux tree) is accepted: the help says that
  inspecting or capturing it starts that distribution if it is stopped, and
  a stopped/unregistered distribution is the "unavailable" state with that
  remedy. Links are judged by the same containment rules; a link whose
  target is outside the root is skipped and reported, as on any other root.

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

Stage each enabled root's snapshot as job/texmf/<n> — a sibling of
job/project, numbered in list order — so library files never enter the
project namespace, log mapping, or the project's 256-file budget. The
directory names are generated, so a reader's folder name (spaces, Unicode,
commas, braces) never appears in a search-path expression. The job directory
itself can contain such characters (a Windows user name such as "Smith, J"
puts a comma in %LOCALAPPDATA%), so search paths are written **relative to
the engine's working directory** (../texmf/0), which contains only generated
names. Verify that relative entries behave identically on each distribution
in the gate below; if one rejects them, validate the absolute job path
against that distribution's special characters and fail with a named error
rather than emitting an ambiguous path.

The mechanism is chosen per distribution, because the distributions differ:

**kpathsea distributions** (TeX Live on Linux, Windows and in WSL; MacTeX;
TinyTeX; distribution packages such as Debian's):

- TDS roots: replace today's private job/home with
  `TEXMFHOME={../texmf/0,../texmf/1,…}`, falling back to the existing
  empty job/home when no root is enabled. Because TEXMFHOME is part of
  $TEXMF, the distribution's own cnf supplies format-aware TEXINPUTS.<fmt>,
  BSTINPUTS, BIBINPUTS, LUAINPUTS, OPENTYPEFONTS, TTFONTS and the rest, so
  every lookup domain follows TDS without MDraft re-deriving it. Measured
  on TeX Live 2025 (see baseline).
- Packages-layout roots: prepend `../texmf/<n>//` to TEXINPUTS, and to
  BSTINPUTS/BIBINPUTS when the inspection found .bst/.bib files, **always
  ending with the platform separator** so the empty element keeps the
  default path (measured: without it, article.cls is not found). Order
  across mixed layouts follows the visible list: an environment TEXINPUTS
  entry is searched before $TEXMF, so a packages root would otherwise
  out-rank an earlier TDS root. When a packages root sits below a TDS root,
  express that TDS root's tex/ directories in TEXINPUTS too, ahead of it,
  using the format list the cnf reports; or, simpler, stage packages-layout
  roots as a synthetic TDS tree (tex/latex/<n>/…, bibtex/bst/<n>/…) and use
  only TEXMFHOME. **Decided: the synthetic tree** — one ordered mechanism,
  proven in the gate run (a loose package staged as tex/latex/sub/ resolved
  on both distributions). Its .bst/.bib/.lua/font files go to the matching
  TDS directory under the same root number.
- Keep the existing luaotfload rule (no TEXMFCACHE override on TeX Live).
  Private fonts by file name resolve through OPENTYPEFONTS/TTFONTS under
  TEXMFHOME; luaotfload may rebuild its name database in TEXMFVAR on first
  use, which is job-owned and discarded.

**MiKTeX** (Windows) — decided by the gate run of 2026-11-11 (below):

- MiKTeX **ignores TEXMFHOME** (measured: the class was not found with the
  same relative brace list that works on TeX Live). Do not register roots.
- Set, per engine, `TEXINPUTS=.;<root>/tex/<format>//;<root>/tex/latex//;
  <root>/tex/generic//;…;` for each root in list order (format list:
  lualatex → lualatex, latex, generic; xelatex → xelatex, latex, generic;
  pdflatex → latex, generic), plus `BSTINPUTS=.;<root>/bibtex/bst//;…;`,
  `BIBINPUTS=.;<root>/bibtex/bib//;…;`, `LUAINPUTS=.;<root>/scripts//;
  <root>/tex/…//;…;` and `OPENTYPEFONTS`/`TTFONTS` over fonts/opentype//
  and fonts/truetype//. All entries are cwd-relative (../texmf/<n>/…).
- **The leading `.` is required:** without it the private root's
  mdraftover.sty beat the project's own copy, because MiKTeX searches
  environment entries before the working directory. With it, the project
  wins. The trailing `;` is harmless; MiKTeX keeps its defaults either way.
- `//` recursion works in all of those variables, including LUAINPUTS and
  OPENTYPEFONTS, which the manual does not list.
- `--include-directory` is **not** used: it does not recurse (the class in
  tex/latex/mdraftcls was not found from tex/latex), so it would need one
  argument per captured directory.
- Lua modules and fonts by file name are therefore supported on MiKTeX; if
  a future MiKTeX release regresses a domain, the native test reports it and
  the domain becomes a named limitation rather than a silent gap.
- On-the-fly installation stays enabled (today's rule). A private name that
  also exists on CTAN is found locally first when its root is enabled; when
  the reader disables the root, MiKTeX may install the CTAN package of the
  same name. The diagnostic for an unexpectedly resolved standard package
  says so.

**Both families:** all output and writable caches remain in the private job.
MDraft never runs an index updater, registers roots, changes environment
variables for the parent app, or writes to the reader's original trees.
Shell escape and project executables stay disabled. The installed engine
still runs with the reader's OS permissions, as the existing trust
disclosure says; staging is not a new OS sandbox.

**Native gate (before the Preferences UI, like section 5):** with the
section 5 fixture, run kpsewhich (where present) and a real compile per
distribution and engine, assert the selected file *origin* (from
`\listfiles`/the log's file list, or kpsewhich output), not just success,
and assert the PDF text. Cover: TDS format-specific duplicates, two TDS roots
plus one packages root in a mixed order, a root path with spaces/Unicode, a
job path containing a comma, .bst/.bib, a Lua module, a font by file name,
and that standard packages still resolve. Record per cell: proven, failed
(with the limitation shown to readers), or not run. An environment-variable
unit test alone cannot prove native distribution compatibility.

### 7. TeX Live inside WSL, driven from Windows MDraft

A Windows reader who keeps TeX Live in a WSL distribution should be able to
use it as the installed engine. This is a new backend variant, not a path:
an ELF binary cannot be launched by CreateProcess, and a \\wsl.localhost
UNC path is not an executable location.

**Settings and contract.** Add an additive, default-null
`latexNativeWsl: { distro: string, bin: string }` (bin is a Linux absolute
path such as /usr/bin or /usr/local/texlive/2025/bin/x86_64-linux). When it
is set, latexNativeRoot is null and status/compile take the WSL route; an
older build reading the new file sees no native root and reports "no
installation selected" rather than misusing it. latex_engine_status reports
the distribution as "TeX Live (WSL: <distro>)". Exact field names and the
command shapes below go into the ADR before code.

**Discovery stays metadata-only by default.** "Find installation…" also reads
the Lxss registry key (no process, no VM start) and lists each registered
distribution, skipping names that start with docker-desktop and distributions
whose registry State is not installed. It does **not** look inside them,
because any access — wsl.exe or \\wsl.localhost — boots the VM. Each listed
distribution gets an explicit **Look for TeX in <distro>…** action whose help
says it starts the distribution. That action never uses a shell (a login
shell also runs the account's profile, which printed unrelated output on
this host). It runs
`wsl.exe -d <distro> --exec /usr/bin/test -x <candidate>/lualatex` (and
pdflatex, xelatex) over a fixed candidate list: /usr/bin, /usr/local/bin,
each /usr/local/texlive/<year>/bin/<arch> found by listing that directory
through `--exec /bin/ls`, and the account's ~/.TinyTeX/bin/<arch> after
reading HOME with `--exec /usr/bin/printenv HOME`. The distro name is passed
only as its own argv element and must equal a registry-listed name. Found
candidates join the existing "Found installations" choices; Browse… stays
host-only (a WSL bin directory is entered through this action, not a picker).

**Validation** reuses validate(): version probes and the probe document,
executed through the WSL launcher below; success commits latexNativeWsl.

**Execution.** One launcher builds every WSL RunSpec:

    wsl.exe -d <distro> --cd <job dir, Windows form>
            --exec /usr/bin/env -i <NAME=value>… <bin>/<engine> <args>

- The environment is passed as env -i argv, never through WSLENV (measured:
  plain Windows variables do not cross). It contains a controlled
  PATH=<bin>:/usr/bin:/bin — dropping the Windows PATH that WSL interop
  appends — plus LANG/LC_ALL, HOME/TMPDIR/TEXMFVAR/TEXMFCONFIG and the
  section 6 kpathsea variables, all as Linux paths.
- Job paths: stage on the Windows side as today, so output reading, cleanup
  and log capture are unchanged. Translate the job directory once per job
  with `wsl.exe -d <distro> --exec /usr/bin/wslpath -u <windows path>` (do
  not assume /mnt: the automount root is configurable) and reject a result
  that is not absolute. A drive that is not automounted fails with that
  remedy. Search paths stay cwd-relative as in section 6.
- Performance: /mnt (9p) was measured ~1.5–1.8× slower on a tiny document.
  Measure realistic projects; if the cost is unacceptable, stage into a
  per-job Linux directory created with `--exec /usr/bin/mktemp -d` and fed
  by a tar stream on stdin, then copy outputs back. That is a revision of
  this section, not an automatic expansion.
- Cancel/timeout: the Windows job object kills wsl.exe; on this host that
  terminated the Linux tree. Because that is not documented, also wrap the
  engine in coreutils `timeout --kill-after=5s <limit>` inside env -i, and
  add a test that a cancelled compile leaves no engine process in the
  distribution.
- First use after the VM stopped can take seconds: emit a
  "starting WSL" progress phase so the preview does not look hung.
- Logs: engine paths in the log are Linux paths. Strip the translated job
  prefix (and ./) before log::parse maps them to staged sources; anything
  else stays an unmapped external file, as today.
- Status reads must not boot the VM: latex_engine_status checks only that
  the distribution is still registered; engine presence is re-checked at
  validate/compile time, and a missing engine is reported then.
- Trust note addition: "In WSL the engine runs as your Linux user and can
  read Windows drives mounted in the distribution."

WSL stays Windows-only; the section is compiled out elsewhere. TeX
distributions in WSL other than kpathsea-based ones are not supported.

### Support matrix

"Proven" means measured on a real engine with origin and PDF text checked.
Every other cell must be proven or turned into a reader-visible limitation by
the section 5/6/7 gates before the Preferences UI ships.

| Backend | TeX inputs (TDS, format-aware) | Packages folder | BibTeX .bst/.bib | Lua | Fonts by file | Mechanism |
| --- | --- | --- | --- | --- | --- | --- |
| Bundled WasmTeX (LuaLaTeX) | gate §5 | gate §5 | gate §5 (separate worker) | gate §5 | gate §5 | adapted controller + MEMFS |
| TeX Live, Linux | proven (same kpathsea as the WSL run); re-run on a Linux host | proven (synthetic TDS) | proven | proven | proven | relative TEXMFHOME list |
| TeX Live, WSL from Windows | **proven** through the launcher: lualatex, pdflatex (xelatex not installed) | **proven** | **proven** | **proven** | **proven** (.otf) | wsl.exe --exec env -i + relative TEXMFHOME |
| TeX Live, Windows native | not available on this host | — | — | — | — | relative TEXMFHOME list (`;`-free brace list) |
| MiKTeX, Windows | **proven**: lualatex, pdflatex, xelatex | **proven** | **proven** | **proven** (undocumented) | **proven** (.otf, undocumented) | `.;`-prefixed relative TEXINPUTS/…INPUTS/…FONTS with `//` |
| MacTeX | not available on this host | — | — | — | — | relative TEXMFHOME list |

**Gate run 2026-11-11** (exploratory script; the durable checks become the
native tests). Hosts: TeX Live 2025/Debian in WSL 2.7.11 through
`wsl.exe --cd <job> --exec /usr/bin/env -i … /usr/bin/timeout …`, and
MiKTeX 23.1 Portable (pdfTeX 4.14, LuaHBTeX 1.16.0). The job path was
`…\job, comma ü\`; the fixture had a class in root 0 loading a package that
exists in roots 0 and 1 (root 0 must win), a package only in root 1,
lualatex/latex/xelatex/context copies of one package, an
\InputIfFileExists .def, a loose package staged as tex/latex/sub, a project
file shadowing a root-0 file (project must win), a Lua module under
scripts/, an .otf under fonts/opentype/ loaded by file name, and a
.bst/.bib pair. Each file typed a marker into the log; every expected origin
was observed, BibTeX resolved both private files, and every run produced a
PDF. Only the MiKTeX variants without a leading `.` (project lost to root 0)
and with `--include-directory` (class not found) failed, as described above.

Native Biber is unchanged: it is used when the installation has it (the WSL
Debian tested here has neither biber nor xelatex, a real configuration the
tests must report as "not run", not fail).

### 8. Freshness, completion, and export

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

### 9. No console windows from installed engines on Windows

**Symptom (reader report, 2026-11-11):** after selecting
C:\…\miktex-portable\texmfs\install\miktex\bin\x64, or any Windows
distribution, several console windows open and close in front of MDraft.
Validation alone launches one `--version` probe per engine and per tool
(up to 3 + 4) and then the probe compile, so a burst of up to eight
windows is expected from the current code; each compile adds one per pass
and one per BibTeX run.

**Cause:** the release build uses `windows_subsystem = "windows"` and owns
no console, so Windows gives every console-subsystem child a new, visible
console. The repository already knows this trap ("Spawning any console
program from this GUI flashes a console window per call" in
[editor-and-ui.md](../agent-guide/traps/editor-and-ui.md)) and fixes it
through `quiet()` in [export.rs](../../src-tauri/src/export.rs), which sets
`CREATE_NO_WINDOW`. The LaTeX runner does not use `Command`, so it cannot
use `quiet()`: [runner/windows.rs](../../src-tauri/src/latex_native/runner/windows.rs)
calls `CreateProcessW` with
`EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT`
and no `CREATE_NO_WINDOW`.

**Fix:**

- Add `CREATE_NO_WINDOW` to the runner's creation flags; it is the only
  Windows spawn site that does not go through `quiet()`. Keep the
  explicit standard handles, the handle list and the job object unchanged.
  Not `DETACHED_PROCESS`, for the reason the existing helper records:
  the child must keep a console so engines that use the console API and
  their redirected handles still work.
- Grandchildren (MiKTeX helpers that build formats or refresh its file
  database on a fresh portable install, kpsewhich, mktexpk, luaotfload's
  tools) inherit the hidden console unless they ask for a new one, so the
  single flag covers them. A helper that deliberately creates its own
  console or a GUI window is outside MDraft's control. MiKTeX's
  "install missing package?" dialog is such a GUI window and stays
  visible on purpose: it is the distribution asking the reader.
- The WSL launcher (section 7) starts `wsl.exe`, a console program, for
  every discovery check, `wslpath` call, probe and compile. It must go
  through the same runner or `quiet()`; a new spawn site that skips both
  brings the flicker back.
- Add one comment at the flag pointing to the trap entry, and extend that
  trap entry to name the LaTeX runner as a fifth spawn site that bypassed
  the helper (the entry says "four spawn sites").

**Verification.** The dom-measurement trap "A `conhost` count does not
measure whether a console window is visible" applies: counting conhost
processes proves nothing, and window visibility cannot be observed from an
agent session. So:

- Automated: a Windows-only Rust test runs the runner on the current test
  binary in a helper mode, and the helper reports `GetConsoleWindow()`. It
  must be null (a console with no window) and `GetStdHandle` must still be
  the redirected file, so the flag hides the window without breaking
  output capture. A grandchild started by the helper reports the same.
- Manual, recorded in this plan: in the release build, validate the
  portable MiKTeX above and a TeX Live installation, then compile a project
  with BibTeX; no console window appears. Note that this check was done by
  a person, as the trap requires.

This is a one-line fix in one file. Under [AGENTS.md](../../AGENTS.md#governance-and-workflow)
it may also land on its own ahead of this plan; if it does, tick the step
below and keep this section as the record.

### Rejected alternatives

| Alternative | Reason |
| --- | --- |
| Tell users to copy files beside every project | Does not provide one shared installation and misses transitive/runtime inputs. |
| Follow project symlinks or allow arbitrary parent paths | Broadens the existing document filesystem boundary instead of adding an explicit library boundary. |
| Put private files in the mirror cache | Eviction can delete them, cache clears affect user assets, and resolver Bloom/negative caches can prevent lookup. |
| Serve a local-first mirror endpoint only | Private names may never reach it; it also loses TDS path/domain semantics. |
| Flatten every class/package into the project root | Creates collisions, breaks resource-relative paths, and obscures provenance. |
| Trust process TEXMFHOME/TEXINPUTS or invoke texhash | Does not configure browser MEMFS and introduces implicit machine-dependent state. |
| Keep the reader's real TEXMFHOME on native TeX Live | Different results per backend for the same document, and an unregistered tree bypasses capture, freshness and provenance. Registering the same folder gives the same effect explicitly. |
| Register roots with MiKTeX (initexmf --register-root) | Persistent per-user configuration outside the job, affects every other MiKTeX program, and needs undo on removal. |
| Point TEXMFHOME at the reader's original folders | Skips capture/currentness; a concurrent edit can change what a running compile reads. Stage the captured bytes instead. |
| Run WSL engines through `bash -lc "<command>"` | Interpolates paths into a shell and runs profile scripts; `--exec` with `env -i` argv needs neither. |
| Pass the WSL environment through WSLENV | Mutates the child-visible Windows environment contract and needs per-variable path flags; env -i argv is exact and local to one spec. |
| Probe WSL distributions automatically in "Find installation" | Any look inside boots the distribution's VM, breaking the metadata-only discovery rule; it is an explicit per-distribution action. |
| Run the Windows build of TeX Live inside WSL, or a WSL engine through a \\wsl.localhost path | CreateProcess cannot start an ELF binary; the UNC path is only a file view. |
| Copy an entire installed TeX distribution | Excessive scan, memory, IPC, and staging cost; use the native backend for that installation. |
| A large new TeX parsing/indexing dependency | The engine already resolves package internals; use a bounded file index and existing lexical helpers. |

## Steps

- [x] Hide console windows for installed engines (section 9): add
  `CREATE_NO_WINDOW` to the Windows runner, add the GetConsoleWindow test,
  update the trap entry, and record the manual release-build check.
  Done 2026-11-11. Deviation: the first test passed with the flag removed
  (it inherited the agent shell's windowless console); it now runs a
  launcher that calls FreeConsole() first, and fails with
  `child-window=visible` when the flag is removed. latex_native tests:
  26 passed, 2 ignored (need MDRAFT_TEST_TEX_BIN); clippy -D warnings
  clean. **Manual release-build check with the reader's portable MiKTeX:
  not yet done** — window visibility cannot be observed from an agent
  session; the reader confirms it.
- [x] Recheck the working tree and existing preview changes. Record exact SDK,
  engine and application baseline identifiers and relevant cold/warm sizes.
  HEAD f8a2083, tree clean before this work. SDK tarball
  wasmtex-optional-monaco-d6a39bc; engine worker SHA-256 9a065d4c…a084
  (50,436 bytes), BibTeX worker 73700491…990 (9,572 bytes).
- [x] Add an isolated adversarial fixture and prove the bundled controller/
  SDK integration above, including auxiliary lookup, before Preferences work.
  Record the source diff and measurements; revise the plan if its gate fails.
  **Passed 2026-11-11** on the exact pinned assets through the SDK's Node
  host (`wasmtex/node`, worker_threads), with the section 6 fixture:
  - Upstream worker: `mdraftcls.cls' not found` (expected).
  - Adapted worker (one anchored replacement of writeTexmfCnf, reading
    `/work/.mdraft-texmf/manifest.json` {version:1, roots:N} written through
    the public files option): every origin as on TeX Live — project over
    root 0 over root 1, the lualatex copy of a format duplicate, the .def,
    the loose package, the Lua module and the .otf by file name; PDF
    produced. Warm compile ~6 s including mirror fetches of standard files.
  - One compiler instance: a compile without the library failed; adding
    the library with setFile then succeeded (**no Bloom/negative-cache
    interference**: MEMFS paths are searched by kpathsea before the
    resolver hook); loadProject without the library failed again (no
    retention); restoring and then changing a file picked up the new
    revision.
  - **Decision: the BibTeX worker stays unchanged.** The SDK forwards every
    project-namespace .bib and a root-level `<style>.bst` to it; MDraft
    hands a requested library .bst/.bib over under its requested root name
    only when the project has no file of that name. With that, the .bbl
    contained the private entry. A computed `\bibliography` name is outside
    this static handoff and is documented as such.
  - Cancel: the app already disposes the compiler (terminating the worker)
    per job, so no library state can survive a cancelled job.
- [x] Run the section 6 native gate on every distribution available (TeX
  Live in WSL Debian is available on this host; install MiKTeX in a
  disposable profile or record it as not run). Fill in the support matrix.
  Done 2026-11-11 with the reader's portable MiKTeX 23.1 (it was on this
  host after all) and WSL TeX Live 2025; results in the support matrix.
- [x] Write the ADR, settle typed schema/commands and origin rules, then add
  backwards-compatible settings and Rust configuration/index/capture support.
  ADR accepted. `src-tauri/src/latex_texmf.rs`; commands
  `latex_texmf_{list,configure,inspect,open,revision}`; `latexTexmfRoots`
  and `latexNativeWsl` are backend-owned (`save_settings` keeps the stored
  values). Deviations: `latex_texmf_list` and `latex_texmf_revision` were
  added (Preferences needs the list without inspecting; the focus check
  needs a revision without the bytes); captures read every file every time
  (no metadata cache) — bounded libraries made a cache unnecessary so far.
- [x] WSL backend (section 7), shippable on its own: registry listing,
  explicit look-inside action, launcher, wslpath translation, validate,
  compile, cancel/timeout, log prefix mapping, status without VM start.
  `src-tauri/src/latex_native/wsl.rs`; commands
  `latex_native_wsl_{distributions,look,validate}`. Deviation: the registry
  is read through the `windows` crate's `Win32_System_Registry` feature (a
  feature of an existing dependency, no new crate). Log paths needed no
  prefix mapping: cwd-relative names (`./main.tex`, `../texmf/<n>/…`) are
  what the engine reports. Verified by the opt-in Rust test through the real
  launcher (library resolution with lualatex and pdflatex, BibTeX, and a
  Cancel that leaves no engine process in Debian) — run from a
  Medium-integrity copy of the test binary (new trap). **Not verified
  through the UI rows**: Find › Look for TeX in WSL › validate was not
  clicked in the real app in this session.
- [x] Extend project dependency discovery and reference validation, keeping
  project inputs and library inputs separate. Add boundary and conflict tests.
  Rust collector: `\LoadClass`, `\LoadClassWithOptions`, `\RequirePackage`,
  `\RequirePackageWithOptions`, `\bibliographystyle` (+ test). The frontend
  check treats library lookup names as resolvable; `.mdraft-texmf` is
  reserved.
- [x] Integrate the versioned bundled adapter and native staged search paths.
  Test real transitive resolution and cancellation on both backends.
  **Deviation (smaller than planned):** no forked worker under
  `src-tauri/assets/wasmtex-texmf/`. MDraft's existing source-owned
  bootstrap `public/wasmtex/2025/wasmtex-luatex.worker.js` replaces the
  upstream global `writeTexmfCnf` exactly as it already replaces
  `cacheFileName`; the upstream worker stays digest-verified and unchanged.
  The BibTeX worker is unchanged (root-name handoff). Native: `stage_texmf`
  + `library_environment` (kpathsea TEXMFHOME list / MiKTeX `.;` variables);
  real-engine Rust test passes on MiKTeX 23.1 (lualatex, pdflatex, xelatex).
- [x] Add the accessible Preferences manager, personal-folder flow, inline
  diagnostics, and deep link from missing-package errors.
  `src/latex-texmf-preferences.ts` builds the group from the panel's own
  rows; *Manage local packages…* appears in the Logs problem panel.
  Deviation: diagnostics from a library name the reader's file and are not
  navigable (a library file is not a project source).
- [x] Integrate library freshness with preview ownership, manual/automatic
  compile, successful PDF eligibility, and local class/package completion.
  The library revision is part of the snapshot generation; a configure
  action invalidates the running compile through the existing render token;
  window focus compares the revision. Completion names live in a CodeMirror
  `StateField` of each LaTeX editor state.
- [ ] Run the targeted validation matrix below, inspect the actual Preferences
  and Logs UI at narrow widths, and record all measurements and skips.
  Done so far (2026-11-11): see "Validation record" below. Open: narrow-width
  and dark-theme visual inspection, Linux WebKitGTK, macOS, the WSL UI path,
  the performance measurements, and the reader's manual console-window check.
- [x] Update user/agent docs, script catalog and required trap records; tick
  acceptance criteria and mark the plan done only after its gates pass.
  docs/latex.md, README.md, architecture code map, testing table, LaTeX
  catalog, two new trap entries (vacuous console test; WSL
  `E_ACCESSDENIED`). The plan stays **in progress** until the open
  validation items are done.

### Validation record (2026-11-11, Windows 11, this host)

| Layer | Result |
| --- | --- |
| `cargo test --lib` (all) | 400 passed, 6 ignored (opt-in real-engine tests) |
| Real MiKTeX 23.1 library test (opt-in) | lualatex, pdflatex, xelatex verified |
| Real WSL Debian TeX Live 2025 library + Cancel test (opt-in) | passed (Medium copy of the test binary) |
| clippy `--all-targets -D warnings` | clean |
| `latex:sdk:unit`, `latex:texmf:unit`, `completion:latex:unit`, `latex:native:unit`, `latex:references:unit`, `latex:sync:unit`, `latex:diagnostics:unit` | 26, 23, 112, 27, 68, 14, 27 — all passed |
| UI: `latex-project`, `latex-native` (MiKTeX), `smoke` | 16/16, 13/13, 119/119 |
| UI: `latex-texmf` first run | 22/25; the 3 failures were a hyphenated marker (`EXTRADE-FOK`, a test bug) and Preferences showing a stale list after command-bridge registration (fixed: the group re-reads a list older than 2 s) |
| UI: `latex-texmf` rerun (with MiKTeX as `MDRAFT_TEST_TEX_BIN`), `smoke` | 25/25, 119/119 |
| format:check / lint / knip | changed files formatted; lint's 2 errors and `package.json` formatting predate this change and are in untouched files |

## Files and modules

Expected implementation surface; keep unrelated working-tree edits intact.
Update this inventory before adding another area.

| File/module | Purpose |
| --- | --- |
| src-tauri/src/latex_texmf.rs (new) | Root configuration, inspection, capture, lookup domains, provenance, bounds, and unit tests. |
| src-tauri/src/settings.rs | Additive default-empty root records, default-null latexNativeWsl, and settings validation. |
| src-tauri/src/lib.rs | Register the focused module and configure/inspect/open commands. |
| src-tauri/src/latex.rs | Extended project declarations, separate library snapshot, reserved paths, and bundled-controller serving. |
| src-tauri/src/latex_native.rs | Separate library staging (job/texmf/<n>), typed native request, per-distribution search wiring (kpathsea TEXMFHOME list vs MiKTeX include directories), WSL status/validate/compile routing, and native regression tests. |
| src-tauri/src/latex_native/discovery.rs | Registry-only WSL distribution listing; explicit in-distribution candidate search. |
| src-tauri/src/latex_native/wsl.rs (new, Windows-only) | WSL launcher (env -i argv, controlled PATH, timeout wrapper), wslpath translation, distro-name validation, log path prefix. |
| src-tauri/src/latex_native/runner/windows.rs | `CREATE_NO_WINDOW` in the creation flags plus the console-window test (section 9); otherwise changed only if the WSL cancel test shows the job object does not end the Linux tree. |
| docs/agent-guide/traps/editor-and-ui.md | Extend the existing console-flash entry with the LaTeX runner spawn site. |
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
- **MiKTeX semantics are undocumented** for TEXMFHOME, LUAINPUTS, font
  variables, `//` recursion and default-preserving separators. The gate may
  turn some domains into visible limitations; it must not be skipped
  because the TeX Live cells pass.
- **WSL behaviour varies by WSL release:** tree termination on wsl.exe exit,
  automount root, interop PATH and VM start latency. Keep the Linux-side
  timeout, translate paths with wslpath, and record the WSL version in
  test output.
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
   Assert selected file origins, not just success. WSL: an opt-in
   MDRAFT_TEST_WSL_DISTRO runs the same cases through the launcher, plus
   a Cancel that leaves no engine process in the distribution, a stopped-VM
   first compile, a job path with a comma/space, a missing distribution,
   and a status read that does not start a stopped VM.
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

- [x] Older settings load unchanged; no roots are discovered, enabled, copied,
  or downloaded merely by starting the app.
  Rust tests `older_settings_load_with_no_roots`, `older_settings_have_no_wsl_selection`; no capture runs at start-up.
- [x] A reader can create/open the personal folder or register an existing TDS
  or loose packages folder without editing JSON or environment variables.
  UI layer `latex-texmf` registers both layouts through the real commands; the Preferences rows render.
- [x] One registered tree works in two projects without duplicate package
  declarations or copying its files into either project.
  UI layer: project A compiled through the bundled engine; project B captured and compiled natively (MiKTeX pdflatex, lualatex).
- [x] LoadClass/RequirePackage and their WithOptions forms, optional inputs,
  internal resources, supported Lua files and font-by-filename lookups work
  from the actual captured tree. No custom-name mirror membership is required.
  Bundled (app + Node proof) and native (MiKTeX, WSL TeX Live) with PDF text or log markers.
- [x] Custom BibTeX style/database inputs reach the auxiliary stage correctly;
  existing native Biber and bundled bibliography limitations remain explicit.
  .bbl verified natively (MiKTeX, WSL) and in the bundled Node proof; the bundled app path is covered by unit tests of the handoff only.
- [ ] On Windows, validating or compiling with an installed distribution
  (MiKTeX portable, TeX Live) or WSL opens no console window: the helper
  test proves a hidden console with working redirected output, and a person
  confirmed it in the release build.
  Helper test done (fails with the flag removed). Waiting for the reader's release-build confirmation.
- [x] Every support-matrix cell is proven or shown to readers as a named
  limitation (MiKTeX Lua/fonts in particular); none is claimed untested.
  Native Windows TeX Live and MacTeX are not available here and are marked so in the matrix.
- [ ] On Windows, "Find installation…" lists registered WSL distributions
  without starting them; looking inside one is an explicit action; a TeX
  Live found there validates and compiles, and a registered library reaches
  it, with Cancel ending the Linux process tree.
  Backend verified (registry listing, launcher, compile, library, Cancel). The UI click-through is not yet verified.
- [x] Project > ordered enabled roots > standard packages is reproducible;
  same-domain ambiguity is named, and legitimate TDS duplicates still work.
  Rust unit tests (ambiguity, format duplicates) and every real-engine run.
- [x] Disabled/missing/oversized roots and rejected links have actionable
  messages. An unavailable enabled tree cannot silently change package versions.
  UI layer (disabled class → named failure + Manage local packages…; vanished folder → remedy) and Rust tests (limits, links/junctions).
- [ ] Roots survive restart and personal-folder paths relocate correctly with
  portable configuration. Remove/cache clear never deletes original packages.
  Remove never deletes (UI layer). Restart and portable relocation are not yet exercised by a test.
- [ ] Changed libraries invalidate output and local completions; manual mode
  does not compile automatically; a stale job cannot publish current output.
  Configure actions invalidate through the render token; focus check by revision; completion per editor state (unit). No UI test yet for focus/manual mode.
- [x] Library .tex files never become document chapters, cross-project preview
  owners, correspondence sources, or unsolicited Pandoc inputs.
  Separate `texmf` field; conversions request `includeLibraries: false` (UI layer).
- [ ] Folder management and failure recovery work by keyboard and at narrow
  widths; controls and diagnostics stay outside the PDF.
  Built from the panel's standard rows; narrow-width and dark-theme inspection not yet done.
- [ ] The pinned-engine proof, applicable automated suites, real cross-platform
  checks, and performance measurements are recorded with honest skips.
  Recorded in the validation record; Linux, macOS and performance measurements are still open.

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

- **Split the WSL backend?** Section 7 does not depend on local libraries
  and is useful alone. Recommended: approve it as a separate plan
  (2026-11-11-wsl-tex-backend.md) landing first, with this plan's WSL
  matrix row depending on it. Keeping it here is acceptable if one change
  is preferred; the step list already isolates it.
- **MiKTeX test host:** resolved — the reader's portable MiKTeX 23.1 is on
  this host and was used for the gate.

No user preference is required to review this draft. Approval of this plan is
the gate to implementation required by [AGENTS.md](../../AGENTS.md#governance-and-workflow).
