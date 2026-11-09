# Reliable LaTeX preview and installed distributions

**Status:** done
**Date:** 2026-11-08
**ADR:** `../adr/2026-11-08-latex-preview-and-engine-boundaries.md`,
`../adr/2026-11-08-native-tex-user-responsibility.md` (supersedes
`2026-11-08-native-tex-process-boundary.md`)

**Approval:** The user approved this plan on 2026-11-08. Implementation is complete
except for real-distribution validation on this Windows host, recorded below.

**Progress:** The bundled adapter retains warning-only PDFs, shows warnings,
marks stale output, exposes Compile and Cancel, and supports manual compilation.
The existing controls live under Preferences > LaTeX. Active fixture and script
names use `latex-project`; the bundled data directory migrates only when all
pinned assets match, with collision handling and focused Rust tests. Literal
main-preamble graphics paths are included in the bounded project snapshot, and
the collector now also follows local `\documentclass`/`\usepackage` files.

The installed-distribution backend is implemented end to end: metadata-only
discovery, a folder picker, a validation action that probes versions and compiles
a one-page document, explicit settings, engine selection (including the
`% !TEX program` allowlist), bounded staging, direct multi-pass and
BibTeX/Biber orchestration, structured diagnostics, progress events,
cancellation of the whole tree, and an engine-specific result that shares the
preview's ownership rules.

**Policy revision (2026-11-08, after the initial implementation):** the reader
decided that an installed TeX distribution is their own external program, not an
extension of MDraft's network behaviour. The process-tree network-isolation gate
is therefore withdrawn; the engine runs directly, MiKTeX's package installer is
left enabled, and only the safeguards needed for correctness remain:
`-no-shell-escape`, no `latexmk`/`latexmkrc`, no project executables, structured
arguments, a private staged working directory, timeouts, output limits and
process-tree cancellation. MDraft itself still makes no request to run a native
build; the distribution may use the network for its own packages, and the
Preferences text says so. The new ADR records the decision.

**Platform validation.** Native execution now uses the same direct runner on all
three platforms. The ignored Linux tests were run against WSL Debian TeX Live
2025: a real `lualatex` compile produced a PDF and cancellation terminated the
process group. On Windows, the reader's portable MiKTeX at
`…\miktex-portable\texmfs\install\miktex\bin\x64` passed the real application
path: `latex_native_validate` committed it, the switch selected native,
`latex_native_compile` returned a PDF, and the preview committed it
(`latex-native` 13/13). macOS was not available; it uses the same `Command`
runner with no platform-specific isolation.

**Final tests after the policy revision:** `cargo test --lib` 364 passed
(3 ignored: the Linux real-engine and cancellation tests and the Windows real
MiKTeX test; all three were run manually and passed). `cargo clippy
--all-targets -- -D warnings` is clean, `npm run build` passes, and the isolated
UI layers pass: `latex-preview` 75/75, `latex-project` 16/16, `latex-native`
13/13 with the reader's MiKTeX (skips cleanly without `MDRAFT_TEST_TEX_BIN`),
`smoke` 117/117, `shortcuts` 52/52 and `menu` 170/170. The app-free suites:
`latex:references:unit` 68/68, `latex:diagnostics:unit` 27/27, `latex:sdk:unit`
10/10, `latex:sync:unit` 14/14, `latex:outline:unit` 35/35, `latex:format:unit`
29/29, `latex:correspondence:unit` 7/7 and `latex:native:unit` 20/20.


**Native gate investigation (historical; superseded by the 2026-11-08 policy
revision above):** The selected portable MiKTeX executable and its
directory grant access to the user, administrators and SYSTEM, but do not
explicitly grant an AppContainer principal. Microsoft documents that
[AppContainer filesystem and network access need separate grants](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer).
The newer [Create Process in Sandbox API](https://learn.microsoft.com/en-us/windows/win32/secauthz/createprocessinsandbox)
is experimental and Windows 11-only. Neither observation proves that a safe
runner is impossible. The probes below demonstrate some, but not all, of the
required boundary and lifecycle properties. Native execution stays unavailable
until the gate is met; no policy exception has been approved.

On the available Debian WSL instance, `unshare --user --map-root-user --net`
succeeded without administrator privileges. A parent connected to a local test
listener, while a process inside the namespace and its child could not connect
to it. This establishes a promising Linux mechanism, not complete application
integration or protection against every IPC-mediated network route. TeX Live,
`latexmk`, `bwrap`, and `unshare` are present there. macOS remains unverified.

The portable MiKTeX installation was also probed inside the execution sandbox.
Its LuaLaTeX version command worked, and a one-page document compiled after
`TEXMFCACHE` and `TEXMFVAR` were redirected to the writable job directory.
Without those variables it failed with `system : no writeable cache path,
quiting`. This verifies the distribution itself can compile with isolated
caches; the execution sandbox belongs to the development environment and is not
an MDraft process-tree network boundary, so it does not satisfy the product gate.

On this Windows 11 machine, a prototype of the experimental process sandbox API
ran portable MiKTeX in an AppContainer and produced a one-page PDF using
read-only access to the distribution and a writable temporary job directory.
The first attempt failed with `no writeable cache path` because a null
environment block did not deliver the cache variables; an explicit Unicode
environment fixed it. A sandboxed child could not initially write in the job
directory. Granting the temporary AppContainer SID access and a low-integrity
label on that disposable directory allowed the child to write, while its
loopback connection was blocked; the same test child connected outside the
container. The temporary AppContainer profiles were removed successfully. This
is a promising prototype, not a production runner: the API is experimental and
Windows 11-only, and other networking routes, installation validation, and
other operating systems remain unverified.

In a further temporary Windows run, three sandboxed LuaLaTeX passes with a
separate sandboxed BibTeX pass produced both a PDF and a `.bbl` containing the
expected entry. On the same installation, `latexmk.exe --version` and
`biber.exe --version` both exited 1 inside the sandbox; their filenames alone
must therefore not be treated as working capabilities. No Perl executable was
found on this session's PATH. This does not establish the exact cause of either
tool's failure or full Biber/latexmk support.

A separate Windows probe started the sandboxed parent suspended, assigned it to
a job object with `KILL_ON_JOB_CLOSE`, then resumed it. After its child wrote its
PID in the temporary directory, closing the job terminated both processes and
the child was no longer running. This validates the cancellation mechanism on
this host; the production implementation and edge cases remain to be tested.

## Context and goal

The reader removed a missing `\includegraphics` command, but the preview kept
showing the old problem while a subsequent build ran. The reader also reports
that the compiler log said `Output written on Resumo-executivo.pdf (23 pages,
344929 bytes).` while the pane still showed a problem instead of the PDF. Long
package downloads and builds currently give the reader no indication of what
the application is doing. Saving does not itself make the pane's state clearer.

The current implementation supports an explicitly enabled, bundled WebAssembly
LuaLaTeX engine. It cannot use a TeX installation already on the computer, and
its controls are buried in Preferences > Export. Its data directory, a sample
project, and a test still carry a prototype-era name.

The earlier draft, [LaTeX preview progress and warnings](2026-11-08-latex-preview-progress-and-warnings.md),
contains useful investigation, but its implementation and acceptance criteria
conflict in several places. This draft replaces it **when this plan is
approved**; do not implement both plans. In particular:

- `src/latex.ts` rejects a successful result containing certain warning text,
  and separately rejects a missing-file warning in the log. A successful build
  with only warnings should display its PDF and those warnings. A PDF's
  existence alone, however, does not prove a clean build: a compiler can leave
  a partial PDF after reporting errors.
- `src/main.ts` invalidates the render token and cancels the old compile on
  editor changes, but leaves the previous result or diagnostics on screen until
  a later result arrives. That presentation does not identify the old result
  as stale. Failure, progress, PDF rendering, cancellation, tab changes, and
  settings changes all need the same ownership rules.
- The original draft asks a status chip to be both progress and Cancel, then
  proposes removing it on completion. It also calls for a 150 ms delay while
  requiring immediate state feedback. Separate status from explicit actions.
- `docs/samples/Resumo-executivo.tex` refers to a missing image at line 254;
  the referenced `fig:arquitetura` label is also absent. The sample cannot
  both keep the missing image reference and compile as shipped. The reported
  23 pages are evidence from the reader, not a portable golden page count.
- SDK resource callbacks exist, but a request to MDraft's `mdraft-tex` scheme
  can be satisfied from Rust's cache. An SDK callback alone cannot prove that
  an Internet download is occurring, or that a cancelled Rust request stopped.

Read-only investigation for this draft: the reference validator reports the
sample's missing image and reports no reference diagnostics after the image
command is removed **in memory**. `npm run latex:references:unit` passed 62/62;
`npm run latex:diagnostics:unit` passed 27/27. The requested portable MiKTeX
directory exists on the investigation machine and contains `lualatex`,
`pdflatex`, `xelatex`, `latexmk`, `bibtex`, `biber`, and `kpsewhich`, but those
executables are not on this session's PATH. No real compile or visual preview
was performed for this draft; the attached screenshot shows the existing
Preferences controls, not the reported compiler log. Do not present the
reported PDF or package-download hypothesis as independently reproduced.

Goal: the preview always tells the reader which document revision its PDF and
problems belong to, what the current build is doing, and how to compile or stop
it. A usable PDF produced with warnings is visible, with its diagnostics. A
reader can explicitly choose a validated installed TeX distribution while the
existing bundled option and upgrade behavior remain available.

## Scope and non-scope

**In scope**

- A revision-owned LaTeX build lifecycle, honest stale and progress states,
  explicit Compile and Cancel actions, and an auto-compile preference.
- Preserve successful PDFs with warnings, distinguish errors and partial output,
  and make the relevant diagnostics and complete bounded log accessible.
- A top-level Preferences > LaTeX section containing **all existing LaTeX
  controls**, auto-compile, and the installed-distribution controls.
- An installed-distribution backend, explicitly opted into and off by default:
  discovery, a folder picker, validation, engine selection, multi-pass and
  bibliography orchestration, cancellation, and actionable missing-tool errors.
- Common project-relative `\graphicspath` resolution and the project inputs
  needed by the supported native workflows, without weakening the existing
  snapshot boundaries or ignoring unsaved editor buffers.
- Rename active prototype-named code, scripts, fixtures, and the application
  engine directory; migrate existing user data safely and never create another
  directory under the old name.
- Update the product documentation, script catalogs, tests, and the durable
  decision record. No new bundled TeX distribution or dependency is assumed.

**Out of scope**

- A promise that every package or arbitrary TeX project works. Macros can
  construct paths and request tools that a bounded snapshot or controlled
  runner cannot infer. Explain unsupported cases and missing capabilities.
- Executing project-supplied build recipes, shell commands, or `latexmkrc`
  files; unrestricted shell escape; installing or updating a system TeX
  distribution; changing its settings; or automatically downloading its
  packages. A future explicit, separately reviewed feature may consider these.
- A general Problems panel, new diagnostics for other languages, provisional
  page previews, incremental compilation, cloud compilation, or telemetry.
- Changing original documents to make a test pass, including the user's sample.
  Test on isolated copies and dedicated fixtures.

## Approach and rejected alternatives

### 1. A build owns a snapshot, not the preview forever

Give each build an opaque job ID plus the root identity, active document
identity, relevant open-buffer revisions, backend, engine, and configuration
generation. Capture the existing project snapshot, including unsaved changes.
Every progress message, result, failure, source mark, and rendered PDF must
still match that owner before it can change the active UI. An edit, tab/root
switch, backend/engine change, close, or explicit cancellation invalidates the
owner immediately, including while waiting for the snapshot or rendering pages.

Display a small persistent preview toolbar with a **Compile** button, a
separate **Cancel** button only during a cancellable job, and a non-button
status. Show the main filename when compiling an included chapter. The toolbar
is available before the first successful PDF, and in both split and preview-only
views. Keep the last readable PDF and scroll position when possible. Existing
diagnostics may remain available as **Previous result — out of date**, but must
not look current, move the caret automatically, or leave current-looking
editor marks after the source changes. A job from a different project must never
leave its PDF or problems in the active tab.

| State | Visible meaning and behavior |
| --- | --- |
| Out of date | The visible PDF or problems describe an earlier snapshot, or no build has run. Offer Compile. |
| Queued | An edit is waiting for the auto-compile debounce. |
| Preparing | Snapshot/validation or engine initialization is running. |
| Resolving packages | The bundled engine is requesting resources; use when cache versus network is unknown. |
| Downloading packages | Show only while the Rust transport reports a real mirror cache miss and active download. Show a count and bytes/percentage only when known. |
| Compiling | Name the active engine; for native multi-pass builds show the actual pass or bibliography stage when known. |
| Rendering PDF | The compiler finished and the viewer is preparing pages. |
| Cancelling | Cancellation was requested but owned work has not all stopped. |
| Finished | Show elapsed time and the actual error/warning counts; keep a disclosure for details and the log. |
| Failed / Cancelled | Explain the outcome; identify any retained PDF as previous or partial, and offer Compile. |

Staleness is an **orthogonal property**, not an alternative to progress: for
example, “Compiling… Previous preview out of date.” Show a synchronous queued
or preparing state before expensive work, and yield to a paint opportunity before
blocking work; a short minimum display duration may avoid flicker without hiding
that work started. Use elapsed time, not a made-up remaining time, percentage,
package name, or network claim. A stalled/failed download says what happened and
offers retry. No document content or paths enter progress events or remote URLs.

`latexAutoCompile` defaults to **on**, preserving upgrades. With it off, opening
or editing a LaTeX document does not implicitly compile; show Compile and stale
state. With it on, editing uses the existing debounce and a save of a stale
snapshot expedites the queued build or joins an identical in-flight job instead
of starting duplicates. With it off, saving leaves the document stale and says
Compile is needed. Compile is available in the pane and View menu, and its
accelerator must be checked through the real menu and editor keymaps. Re-enable
auto-compile by queuing the current stale snapshot once. Do not make a save,
view-mode switch, tab handoff, export, or print accidentally bypass manual mode.
In source-only view, defer automatic work until the preview becomes visible;
with auto-compile off, revealing the preview still requires an explicit Compile.
If the reader invokes View > Compile while in source-only view, open the split
preview and start that requested build.

For the bundled backend, pass SDK progress through a job-scoped adapter.
Instrument the Rust scheme handler at the **actual cache-miss/download**
boundary if needed to distinguish downloading from cache reads. Correlate and
validate messages by job ID without accepting arbitrary resource URLs. Disposal
of a Web Worker does not necessarily cancel a Rust HTTP request: provide an
abortable, bounded transport or keep the state honest until outstanding work
ends. Cancellation must invalidate late responses immediately and stop owned
work without cancelling another job's shared resource. Test actual host/worker
callback delivery rather than assuming the SDK declarations guarantee it.

### 2. Result quality and diagnostics

Normalize both backends into an outcome containing the owned snapshot,
completion/exit status, fresh PDF bytes if any, structured errors, warnings,
other information, a bounded log, truncation flags, and selected engine.
Validate that bytes are from this job and can be opened as a PDF; a stale file
from an earlier run is never evidence of success.

- Completed successfully, valid PDF, **warnings only**: display it as current,
  visibly show warning count and details, and allow the existing PDF save,
  export, and print routes. Missing citations/bibliographies must be prominent
  warnings, not silent success.
- Valid new PDF **and actual errors or failed process status**: show the errors
  and distinguish an incomplete/partial PDF from a successful build. Keep the
  last successful PDF visible by default and offer an explicit “View partial
  PDF” when there is one; never label or export the partial as a successful
  current build. If the outcome is ambiguous, use this conservative state.
- No valid PDF, failed setup, or rendering failure: show the relevant error and
  retain the previous readable PDF with an out-of-date label when available.
- Cancelled or superseded: do not publish any PDF, diagnostics, auto-jump, or
  completion state from that job.

Treat severity, process status, and PDF existence as independent facts. Do not
reclassify unknown or informational diagnostics as errors by default; do not
make arbitrary message regexes decide build success. Retain explicit fallback
parsing for compiler messages missing from structured diagnostics, with tests.
Deduplicate only true duplicates. Keep all warning categories discoverable,
including overfull boxes; if the visible list is capped, show the accurate
omitted count when known, otherwise say more were omitted, and make the bounded
log available with its own truncation notice. Show unknown-location messages as
text, not dead navigation controls. Navigate or mark only a verified
project-relative file and matching snapshot text; no wrong-line annotations.
Do not auto-jump to warnings. Preserve existing PDF/source correspondence,
zoom, selection, scroll, export bytes, and printing behavior.

### 3. Preferences and installed-distribution flow

Move the existing enable switch, engine status, package-cache usage/limit,
clear-cache action, and Open LaTeX Folder action into a dedicated **LaTeX**
Preferences navigation item. Keep their settings and effect intact; rename the
switch label to **Enable bundled LuaLaTeX** so it is not confused with the
installed backend. Identify bundled cache controls as such. When neither backend
is enabled, the preview explains how to enable one. Add:

1. **Auto-compile**: on by default, with the manual behavior above.
2. **Use my installed TeX distribution**: off by default. It chooses the
   installed backend independently of whether the bundled backend was enabled;
   choosing it must not download the bundled engine. Turning it off restores
   the prior bundled configuration without deleting either installation/cache.
3. When explicitly enabled, **Find installation** searches PATH and a bounded,
   documented set of platform-standard TeX Live/MacTeX/MiKTeX locations. No
   disk-wide scan, executable launch, or network access at application startup.
   A portable installation outside those locations may require Browse.
4. Show the candidate's full binary directory, detected distribution/version,
   available engines, and auxiliary tools. **Browse…** selects a directory;
   **Validate** checks the directory and bounded version/capability probes before
   committing it. Discovery and validation do not install or update anything.
   A failed or cancelled selection leaves the last valid setting unchanged.
5. Native **Engine** offers installed LuaLaTeX, pdfLaTeX, and XeLaTeX with
   LuaLaTeX as the default where available, plus an Auto option that recognizes
   only an allowlist of `% !TEX program` values. An explicit selection wins.
   A missing individual engine or bibliography tool is reported when needed;
   do not reject an otherwise usable installation for lacking unrelated tools.
   Never execute a program named by arbitrary document text. The bundled backend
   remains LuaLaTeX and shows that choice honestly.

Validate capabilities, not just filenames: wrappers, broken links, missing
runtime dependencies, wrong architecture, and stale portable paths can make an
existing executable unusable. Probe with a timeout and bounded output, verify
again at use time, and report the affected path and a repair action. Support
spaces and Unicode in folder and project names. If the configured directory
disappears, do not silently compile with another engine or overwrite it; offer
Find/Browse or an explicit switch back to bundled. Persist only validated
settings through the existing settings store. Handle old settings, portable
builds, upgrade/downgrade, and concurrent settings changes without changing the
meaning of `latexEnabled` or `latexCacheLimitMb`.

The installed distribution owns its own packages and cache. MDraft's cache
controls and Clear Cache affect only the bundled engine and say so. MiKTeX can
install packages automatically; **its installer is not disabled**. TeX Live's
packages are managed by its own tools. When packages are missing, show the
distribution's own message and let the reader install them with its tools; do
not block the distribution's package installation. See the [MiKTeX manual](https://docs.miktex.org/manual/texfeatures.html).

### 4. Native compilation boundary and workflow

**Policy revision (approved 2026-11-08 after implementation):** an installed TeX
distribution is a program the reader explicitly chose and installed. It runs
with the reader's operating-system permissions, and its own package manager may
use the network to obtain packages. MDraft does not control, monitor or proxy
that traffic, and does not claim that the engine is offline. The application
itself still makes no network request to run an installed engine: it only starts
the executable the reader selected, on an explicit Validate/Compile action.

This replaces the earlier “non-negotiable first gate” in this plan. That gate
required a process-tree network boundary before native execution, and the
Windows implementation could not satisfy it on the available host. The reader
chose the trust model above instead: the external engine is the reader's
program, not an extension of MDraft's own network behaviour. The controls that
remain are about correctness and accidental execution, not about proving an
offline boundary: the bounded staged snapshot, `-no-shell-escape`, no
`latexmk`/`latexmkrc`, no project executables, structured arguments, controlled
working directory/environment, timeouts, output limits and process-tree
cancellation.

The setting explains that native TeX processes the document with the reader's
OS privileges, that only trusted documents/installations should be used, and
that the distribution may download its own packages. The bundled engine remains
the choice for readers who do not opt in.

Use the same bounded project snapshot for both backends. Stage
each native job into an app-owned, private temporary working directory with
unsaved overlays applied; never compile directly in or write generated files
back to the project. Retain the existing path, symlink, size, and file-count
checks; extend the collector for common literal `\graphicspath` directories,
project classes/styles, bibliography files, and supported image extensions.
Do not guess macro-expanded paths: explain a limitation when the snapshot cannot
resolve one safely. Keep generated auxiliary files inside the owned job
directory and delete only directories the job created after processes exit.

Use validated absolute executable paths and structured process arguments;
never concatenate a document path into a command sent directly to a shell.
Do not search the project directory for executables. Control working directory,
tool lookup, environment, TeX interaction mode, output locations, timeouts,
output sizes, and platform-specific shell-escape/installer flags. Do not allow
project files to replace an approved helper executable. Keep enough diagnostics
to explain missing packages and tools without exposing document contents over
the network.

Prefer a validated installed `latexmk` when it and its required runtime work:
its documented purpose includes rerunning TeX and invoking BibTeX/Biber as
needed. Invoke it with `-norc`, fixed reviewed configuration, a controlled
environment and output directory, and no continuous-preview mode. `latexmk`
can itself spawn subprocesses and use command strings, so argument quoting,
unsafe filenames, subprocess resolution, network isolation, and process-tree
cancellation must be verified on each platform; a structured launch of
`latexmk` alone does not prove those properties. Its
[manual](https://tug.ctan.org/support/latexmk/latexmk.txt) documents both
multi-pass orchestration and `-norc`. If that controlled route cannot be made
safe for an input, fail with an actionable explanation rather than weaken it.

If `latexmk` is absent, provide a bounded direct-run fallback for ordinary
LaTeX: selected engine, reruns until relevant auxiliary state stabilizes or a
documented pass limit is reached, and validated BibTeX/Biber when indicated.
Show a missing-helper or unsettled-reference diagnostic when that fallback
cannot complete a requested workflow; do not imply it supports arbitrary custom
build rules. Execute each validated helper without a shell. Verify bibliography
output, cross-references, and real PDF content, not just a zero exit status.
Test the user's MiKTeX portable layout and at least one TeX Live/MacTeX layout;
do not require all tools for every document.

Cancel the entire owned native process tree, wait for termination, release the
job directory, and ignore any late log/exit/result. Distinguish cancellation,
timeout, engine failure, bibliography failure, and viewer failure. Export and
print continue to consume only the current accepted preview bytes; no hidden
second compile. Prevent an obsolete job from replacing those bytes.

### 5. Remove prototype naming without losing data

Use `latex` as the application-owned engine data directory, with versioned
assets/mirror structure below it. Never create `wasmtex-poc-2025` again.
Rename the active `samples/latex-poc` fixture, `scripts/latex-poc-test.mjs`,
the npm command and test-layer ID to descriptive LaTeX names; update every
active import, fixture path, command, catalog, test, and user-facing document.
Remove prototype terminology from first-party code, comments, active script and
fixture names. Historical plans, audits, and accepted ADRs remain historical
records; supersede an ADR where a durable decision changes rather than rewriting
history.

Existing users may already have assets, a package cache, and an old enable
marker in the old directory. Because the request also removes prototype-named
references from code, implement a **name-independent, narrowly scoped legacy
recognizer**: inspect only immediate directories under MDraft's own data root,
never follow symlinks, and identify an eligible old engine by the known layout
and pinned asset fingerprints/legacy marker, not by constructing or persisting
the old directory name. Preserve the existing enable-marker migration when an
old settings file lacks `latexEnabled`. Never treat an unrelated directory as
an engine. If more than one candidate exists, fingerprints are incomplete, or
both old and new destinations contain data, do not merge, overwrite, delete, or
guess: keep the originals and report a recoverable migration problem.

Perform migration once, at first use of the opted-in bundled engine rather than
on ordinary startup. Settings loading may perform the bounded, read-only legacy
marker recognition needed to preserve an existing opt-in before first use; it
must not move data, launch a process, or make a request. Use same-volume atomic
rename where safe, or staged
copy/verification and atomic commit; make interruption and retry idempotent.
Preserve cached bytes, verified assets, settings, and portable data locations.
Do not delete the only copy on failure. Exercise empty, complete, partial,
corrupt, duplicate, interrupted, and permission-denied cases in isolated test
directories. If a name-independent recognizer cannot identify a real historical
installation safely, stop and revise this migration design rather than smuggle
the old path back into code or discard the user's cache.

### Alternatives considered

- **Only fix the warning regex:** leaves old diagnostics appearing current and
  gives no feedback during a slow build.
- **Any PDF means success:** can silently present a document with real errors or
  a missing bibliography as finished.
- **One clickable status chip:** hides the difference between checking status,
  compiling, and cancelling; separate controls make each action predictable.
- **Always require all native executables:** rejects useful partial installs;
  validate each capability and explain a missing tool when it is needed.
- **Use the native distribution automatically when found:** changes the engine
  and trust boundary without consent and breaks the current opt-in model.
- **Compile from the saved project folder:** loses unsaved edits and lets
  compiler outputs modify the user's project.
- **Treat package requests as downloads:** cached resource requests look the
  same to the SDK unless the Rust transport distinguishes them.
- **Keep the historical directory forever:** violates the naming request and
  leaves a product feature tied to its experiment. Migrate safely instead.

## Steps

- [x] **1. Validate the native security gate.** **Withdrawn by the approved
  policy revision of 2026-11-08:** the installed engine is the reader’s external
  program, so there is no process-tree network gate to validate. Windows,
  Linux and macOS now use the same direct runner. The old investigation below
  remains as history.
- [x] **2. Define contracts and ADR.** Specify job ownership, cancellation,
  outcome classification, bounded diagnostics, engine capability records,
  explicit settings defaults/migrations, and the trust/network boundary. Write
  the ADR after approval; do not change the old accepted ADR.
- [x] **3. Fix bundled outcomes and staleness.** Keep warning-only PDFs; clearly
  distinguish errors/partial output and stale results; prevent old callbacks,
  marks, auto-jumps, and PDFs from committing. Cover PDF rendering failures.
- [x] **4. Add visible compile controls and honest progress.** Implement the
  state and actions above, real cache-miss/download events, cancellation,
  accessible keyboard/live-region behavior, and manual/automatic scheduling.
  Wire menu availability, accelerator, save, export, and print consistently.
- [x] **5. Reorganize Preferences and settings.** Add the LaTeX navigation item,
  move all existing controls without changing values, add auto-compile and
  native-selection settings, and preserve existing/portable settings behavior.
  Do not expose a native control until its platform and validation gate works.
- [x] **6. Rename and migrate.** Rename active fixture, test, command, data
  directory, and references; implement/test the name-independent migration and
  marker handling. Update affected catalog entries and legacy test fixtures.
- [x] **7. Discover and validate installed distributions.** Implement explicit
  bounded discovery, folder picker, capability/version probes, per-engine
  selection, reversible settings commits, and a missing-installation recovery
  flow. Test the stated portable MiKTeX directory and platform layouts.
- [x] **8. Run native builds.** Extend safe snapshot handling and common
  `\graphicspath`; implement controlled native job/process management,
  `latexmk` and direct fallback, multi-pass/BibTeX/Biber, logs, timeouts,
  resource cleanup, and shared preview result contract. The direct runner
  compiled a real document with the reader’s portable MiKTeX on Windows and with
  TeX Live on WSL Linux.
- [x] **9. Verify real interactions and document.** Focused UI and unit layers
  pass, the documentation is updated, and the real Windows MiKTeX was driven
  through the application (validate, enable, compile, preview). macOS was not
  available; it now uses the same direct runner. Run the ordered tests
  below, visually inspect the supplied sample and an isolated edited copy,
  exercise cold/warm/offline and native cases, update `docs/latex.md` and the
  guide, catalog every new or renamed script, and record any newly encountered
  trap. Tick steps and record deviations as work proceeds.

**Deviations recorded during implementation**

- **The native build runs the engine directly, not `latexmk`.** `latexmk`
  constructs command strings and starts helpers outside the flags `latexmk` alone
  is given, and the plan requires those properties to be verified per platform.
  The bounded direct runner keeps every engine argument under MDraft's control,
  reruns until the auxiliary state settles (three passes), and invokes BibTeX or
  Biber only when the log asks for one. The plan's preference for `latexmk` is
  therefore not implemented; the direct fallback is the shipped route and
  `docs/latex.md` says so.
- **The process-tree network gate was withdrawn by explicit reader decision.**
  The installed engine is the reader’s own program; it runs directly with the
  reader’s permissions and may use the network for its own packages. The
  AppContainer/namespace/`sandbox-exec` requirement, the profile creation and the
  distribution ACL changes are removed. Shell escape, `latexmk`, project
  executables and arbitrary engine names remain refused.
- **MiKTeX’s installer is no longer disabled.** `--disable-installer` and
  `MIKTEX_AUTOINSTALL=0` were removed, so MiKTeX can install a missing package
  during a compile. TeX Live’s packages remain managed by `tlmgr`.
- **One Unix-only dependency remains:** `libc`, for process-group cancellation.
  It is already in the tree through Tauri; no new binary, download or bundled
  component is involved.

Steps 3–6 may ship independently of native execution **only if** the resulting
scope, settings, documentation, and approval are updated accordingly. Do not
ship an enabled but unimplemented native control.

## Files and modules

This is the expected complete impact inventory; before implementation, reconcile
the names with the working tree and add any newly discovered affected file to
this plan rather than widening scope silently.

| Area | Files / reason |
| --- | --- |
| Bundled engine and diagnostics | `src/latex.ts`, `src/latex-references.ts`, `src/latex-diagnostics.ts` and related modules: job ownership, outcome/severity, path resolution, mapping and SDK progress. |
| Installed TeX backend | `src-tauri/src/latex_native.rs` and its `latex_native/{log,discovery,runner}.rs` modules: job staging, log parsing, engine selection, direct multi-pass/BibTeX/Biber, process-tree cancellation. |
| Native result adapter | `src/latex-native.ts`: converts the runner's facts into `LatexResult`/`LatexBuildError`, so both backends obey one preview rule set; `scripts/latex-native-unit.mjs` pins it. |
| Preview and menus | `src/main.ts`, `src/styles.css`, `src/editor.ts` if marks need severity support, `src-tauri/src/menu.rs`: status, separate actions, revision guards, shortcuts, PDF and diagnostics. |
| Settings and UI | `src/preferences.ts`, `src/api.ts`, `src-tauri/src/settings.rs`: dedicated navigation, additive settings, engine validation APIs, migration and defaults. |
| Rust engine and paths | `src-tauri/src/latex.rs`, `src-tauri/src/documents.rs`, `src-tauri/src/lib.rs`, and focused native runner/discovery modules: safe data migration, project snapshot, events, process lifecycle, tool validation and commands. |
| Export and shared PDF | `src-tauri/src/export.rs`, `src/main.ts`, `src/api.ts`, `src/pdf-*.ts` only where engine labels, current-result gating or shared rendering require changes; preserve exact PDF bytes. |
| Fixtures and scripts | Rename `samples/latex-poc/` and `scripts/latex-poc-test.mjs`; update `package.json`, `scripts/test-all.mjs`, `scripts/latex-preview-test.mjs`, `scripts/latex-sdk-unit.mjs`, `scripts/latex-measure.mjs`, `scripts/menu-test.mjs`, `scripts/pdf-webview-performance.mjs`, `scripts/dom-smoke.mjs`, `scripts/shortcut-test.mjs` and relevant unit tests. Add focused tests/fixtures as needed and catalog any new script. |
| Documentation | `docs/latex.md`, `docs/guide.md`, relevant agent-guide catalog/testing/trap entries, a new ADR, and this plan. Keep historical audit/plan/ADR text as history. Do not alter `docs/samples/Resumo-executivo.tex`; use a temporary copy in tests. |

## Risks and rollback

- **Native TeX is not WebAssembly.** Its filesystem and network capabilities
  differ materially. The platform policy gate and explicit opt-in are required;
  do not claim a scratch directory or disabled shell escape confines TeX.
- **False success or stale data.** Separate outcome facts, validate the PDF,
  tag every callback, and test error/partial and edit/cancel races. Never export
  an old PDF as if it described current text.
- **Discovery or tool invocation selects the wrong binary.** Bound search,
  show the resolved path, validate individual capabilities, use absolute paths,
  and fail visibly when the chosen installation moves.
- **Native compatibility is broader than a static snapshot.** Test common
  graphics, package, bibliography and Unicode cases; give an actionable limit
  rather than reading arbitrary paths or promising universal compatibility.
- **Migration can strand an existing cache or re-enable a disabled engine.**
  Recognize only verified app-owned layouts, migrate transactionally, preserve
  the settings/marker precedence, and exercise interrupted and conflicting
  states. Back up rather than delete on ambiguity. A rollback restores the
  prior executable and, if needed, the untouched old directory/setting from the
  migration backup; no document is rewritten.
- **Progress can lie or chatter.** Use transport-confirmed download state and
  rate-limit announcements; never invent totals or allow an obsolete callback
  to update the current job.
- **Process cleanup can kill unrelated programs or leave children running.**
  Own and cancel a job's process group/job object only; verify descendants exit
  and never use broad process-name termination.

## Tests and validation

Run the repository's layers in its documented order, using the Windows MSVC
wrapper for every Cargo/Tauri invocation. UI suites must use the isolated test
runner and must not touch an installed or portable user's state. Do not count a
skipped engine or unavailable platform as a pass. Record versions and explicit
skip reasons.

| Layer | Required evidence |
| --- | --- |
| `npm run build`; Rust tests via `scripts\cargo-vcvars.cmd` | Type contracts, additive old-settings defaults, engine/cache migration, path confinement, mock discovery, argument construction, process ownership, and cancellation. |
| `npm run latex:references:unit`, `latex:diagnostics:unit`, `latex:sdk:unit`, `latex:sync:unit` | Missing image before/after edit, safe path resolution including graphics paths, diagnostics severity and navigation, result classification, job guards, current engine and snapshot contracts. Add focused app-free tests for new contracts. |
| Deterministic lifecycle tests | Delay/fail snapshot, cache hit, cache miss, offline, slow download, compiler, viewer, and cancellation at each stage; edit or switch projects between callbacks; no old result, mark, jump, or event commits. Verify progress messages match the real stage. |
| `npm test -- --only latex-preview,<renamed-latex-project>,menu,shortcuts,smoke` after build | Real isolated application: queued/compiling/rendering/cancel, warnings and partial PDFs, auto on/off, immediate stale indication, save behavior, active project/tab ownership, Preferences round-trip, keyboard access and accelerator. Ensure menu tests actually exercise focus in the editor and preview. |
| Existing PDF/scroll/export layers as applicable | PDF zoom, selection, correspondence, scroll retention, exact exported/printed bytes, and stale-export gating for both backends. |
| Migration and native process tests | Temporary roots/fake executables with spaces and Unicode; PATH versus portable discovery; missing/broken tools; no startup probe; shell escape disabled and installer left enabled; standard and hostile filenames; interrupted migration; real cancellation of descendants. |
| Real installations, opt-in matrix | Windows portable MiKTeX, plus TeX Live on Linux and MacTeX/TeX Live on macOS when available. Compile warning-only, missing-package, multi-pass cross-reference, BibTeX and Biber fixtures; inspect PDF text and bibliography, not only process exit. Confirm no project files changed. |
| Visual and accessibility inspection | In an isolated app, inspect keyboard/screen-reader labels, contrast, reduced motion, a long build, and the user's `Resumo-executivo.tex` copied to a temporary project. First show the real missing-image problem; remove its command in the unsaved copy; verify stale feedback immediately, subsequent progress, then a readable PDF with any remaining warnings. Record actual elapsed time/page count rather than asserting 23 on every platform. |

## Acceptance criteria

1. Editing/removing the command immediately marks the old diagnostic as
   outdated; after a new build starts, its actual activity is visible. A late
   result from the previous revision or another tab cannot replace it.
2. A valid current PDF from a completed warning-only build is displayed with
   discoverable warnings and can be saved, exported, and printed. Real errors,
   invalid output, cancellation, and partial PDFs are visibly distinct.
3. Compile and Cancel have separate accessible actions. Auto-compile defaults
   on, can be turned off, and manual mode neither compiles on save nor hides how
   to compile. Saving in auto mode promptly schedules or joins the current job.
4. Downloading is shown only for an actual active network transfer; cache hits,
   initialization, native compilation, rendering, and cancellation are labelled
   accurately. No fake remaining-time estimate or document data is sent out.
5. Preferences > LaTeX contains the existing controls and the new options.
   Existing installs and portable settings retain their prior enabled state and
   cache ceiling. Native use is off by default and requires an explicit,
   validated selection; missing or moved tools have a clear recovery route.
6. Native jobs compile the captured unsaved snapshot, support the documented
   installed engines and bibliography workflows when their tools are present,
   keep generated output out of the project, and terminate their owned process
   trees. The installed engine is disclosed as the reader's external program;
   shell escape stays disabled and the distribution may install its own packages.
7. Upgrading preserves eligible old assets, cache and enablement, including
   interrupted migration. No new directory uses the old name, and active
   first-party code, scripts and fixtures contain no prototype naming.
8. Tests cover the reader's reproduction, races, warnings versus errors,
   migration, discovery, settings, process behavior, and both backends. The
   supplied sample remains unmodified; page counts are observed, not assumed.

## Open questions

1. **Native process network isolation:** **resolved 2026-11-08.** The reader
   approved treating an installed distribution as their own external program.
   The process-tree network gate is withdrawn; MDraft discloses that the
   distribution may download its own packages, keeps shell escape and project
   executables disabled, and does not claim an offline native compile. The new
   ADR records the decision.
2. **Ambiguous historical cache:** the default is to preserve every candidate
   and report a repair path; do not guess or restore a prototype-named runtime
   path. Validate the recognizer against actual previous-release layouts before
   approving an implementation that depends on it.
3. **Custom build recipes and shell escape:** default off and out of scope even
   if the installed distribution ordinarily enables them. A project needing
   them receives an actionable limitation rather than silent execution.
4. **Default shortcut:** try `CmdOrCtrl+Shift+Enter` only if the actual platform
   registry, menu, and focused editor tests confirm it is available; otherwise
   choose a tested alternative and record it here.
