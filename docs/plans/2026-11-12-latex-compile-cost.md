# Measure and reduce the LaTeX preview compile cost

**Status:** draft
**Date:** 2026-11-12
**ADR:** `../adr/2026-11-12-latex-engine-lifetime.md` (written in Step 3; the
baseline in Step 1 needs none)

## Context and goal

A one-letter edit in a `.tex` file can show "Resolving LaTeX packages…" for
seconds. The message is misleading: it is set by the first format-load progress
event (`src/main.ts:3323`) and is never replaced by "Compiling LaTeX…" unless a
package download finishes, so on a warm cache it stays on screen for the whole
compile. Nothing is being resolved, and nothing is being downloaded.

The work behind it is real. Every render calls `compileLatex`, which starts with
`cancelLatex()` and disposes the previous compiler (`src/latex.ts:269`), creates
a new `WasmTexCompiler`, boots a worker, fetches and verifies the 6.9 MB
`wasmtex-luatex.wasm` and the 3.16 MB `wasmtex-luatex.fmt.gz`, loads the format,
and then typesets the whole document. The `finally` block disposes all of it
(`src/latex.ts:409`). The project snapshot is rebuilt from disk and base64-encoded
on every render (`src/main.ts:3265`, `src-tauri/src/latex.rs:1412`). A local
mirror cache of 314 files / 25.6 MiB on this host is warm; it is not the cause.

The repository already measured the symptom: **1134 ms first compile and
1124 ms warm** on the small fixture (Windows, `latex:preview`), with the engine
and package cache warm (`docs/plans/2026-11-06-latex-product-integration.md`,
step 13). Warm is only 10 ms faster because the cache cannot remove the engine
boot or the typeset; it only removes network fetches that a warm cache never
performed anyway.

The goal is to know where every millisecond goes, then buy the largest
reader-visible reduction for the smallest permanent cost: one approach or the
smallest combination that pays for itself, not all possible approaches. A stage
that does not clear its measured gate is reverted and recorded as a negative
result. The status text becomes truthful in the same change, because the
current message is actively misleading.

**The plan starts with a baseline benchmark, before any performance change.**
Two deterministic documents are generated into the test temp directory: a small
single-file `.tex` and a large project with a main file and twelve `\include`d
chapters. The current build, with only the measurement marks added, is measured
on both, and the raw JSON is kept as the reference for every later stage.
Timings are compared as deltas against that baseline and against the immediately
preceding accepted stage. Absolute milliseconds are recorded for context, never
used as a target: the question is whether a change improves the number, not
whether it crosses an arbitrary threshold.

## Scope and non-scope

**In scope**

- Phase-level measurement in the shipping preview path (`performance.mark` /
  `measure`), a reproducible CDP probe, a committed baseline artifact, and a
  comparison log for every stage.
- A truthful, coalesced compile status: engine loading, compiling, downloading
  a package count.
- Stage S2: keep one LuaLaTeX compiler alive between compiles, send only
  changed files, and dispose it on the documented boundaries.
- Stage S3: per-file digests from Rust and a frontend diff so unchanged files
  are neither decoded nor re-uploaded; an optional delta payload only if S0
  proves it is worth the contract change.
- Stage S4: a provisional first page shown while the canonical compile runs.
- Stage S5: LuaLaTeX heap checkpoints, including the two checkpoint engine
  assets and the shim's `?engine=checkpoint` selection.
- Tests, documentation, and the final combination decision.

**Non-scope**

- The installed-TeX backend, pdfLaTeX switching, and the engine's own typesetting
  speed. They are reference points, not deliverables.
- Changing the 800 ms debounce. It is measured as part of the reader's wait and
  is not touched; a longer debounce hides work instead of reducing it.
- Export and print. The compiled PDF they hand over is unchanged; `compileLatex`
  is only called by the preview (`src/main.ts:3317`), and export reuses the
  stored result.
- Cache policy, offline behaviour, and cache-cold measurements. The mirror
  affects whether a compile can succeed, not how fast it is.
- A second engine pool, a user-facing performance preference, and a Settings
  schema change.
- Linux and macOS parity as a deliverable. The probe runs on the Windows test
  host; a Linux run is recorded when a host is available.

## Approach and rejected alternatives

**Chosen: a measurement-first, stage-gated experiment.**

The first deliverable is the baseline benchmark (S0). It changes no behaviour
except adding marks, runs on the current code, and records the before numbers
for both primary documents. Every later stage is one commit that can be
reverted on its own; the same probe runs on the same generated fixtures, and a
stage is kept only when its median improvement over the previous accepted set
is larger than the measured run-to-run noise and its resource cost stays inside
the budget. The absolute phase split tells us which stage is worth trying
first - if `T_init` is a large share, S2 is the candidate; if the typeset
dominates on the huge document, S5 is - but the decision is always the measured
delta, not an absolute target.

**The probe.** In-page `performance.mark` / `measure` around the existing
phases, read over CDP by a new `scripts/latex-performance-test.mjs`. It prints
a table and a JSON form, and writes nothing outside the test stage. The marks
stay in the shipping build: they cost microseconds, they are cleared per
render, and a flag would measure a different code path. No global variable and
no user-visible surface is added.

**Warm reuse (S2).** One idle compiler per project, keyed by the absolute main
file, library revision and engine year. A content-only edit calls `setFile` for
the changed files and `compile()` again; a file-set change uses `loadProject`
(which keeps the worker) or a fresh instance, whichever the measurement says is
cheaper. Disposal happens on project/engine/library change, a thrown engine
error, an explicit engine disable, a different document language, and an idle
timeout. Cancellation is split into "stop the in-flight job" and "dispose the
warm engine" because today one function means both.

**Snapshot digest (S3).** Rust already computes a SHA-256 per file for the
generation key (`src-tauri/src/latex.rs:1398`); exposing it per file lets the
frontend compare without decoding unchanged bytes, and only changed text files
need decoding for diagnostics. The warm state keeps the previous decoded text
sources because the diagnostic scan and the result's source list need them;
the saving is skipping unchanged binaries. Omitting unchanged file bytes from
the IPC is a separate, conditional step (S3b): do it only if the measured
snapshot share justifies the contract change.

**Provisional page (S4).** The pinned SDK can typeset a page prefix for
LuaLaTeX (`previewPages` / `previewColdPages`, `headless.d.ts:246-254`). Show
the first page while the canonical compile runs, label it provisional, and
replace it with the full result. It is a perceived-latency win, not a faster
compile, and it is killed if it pushes the full render past the noise band or
disturbs the reading position.

**Heap checkpoints (S5).** The checkpoint engine is a different compiled
binary from the same upstream manifest: `wasmtex-luatex-checkpoint.js` +
`.wasm` (2025: 122,242 + 6,937,825 B; 2026: 122,783 + 8,087,608 B). MDraft's
pinned profile installs neither, and the local shim always fetches the plain
`wasmtex-luatex.wasm`, so the controller's `?engine=checkpoint` import falls
back to the plain build. S5 pins the pair, makes the shim select it, passes
`luatexHeapCheckpoints` with a budget, and relies on S2 being present - a
checkpoint on a compiler that is disposed immediately is pure overhead.

**Rejected alternatives**

- **Ship all five changes and compare at the end.** It hides which change paid,
  spends the memory and download budget before knowing the return, and makes a
  regression impossible to attribute.
- **A longer debounce alone.** It reduces how often the engine runs, not what
  one run costs; the first pause after typing still pays everything.
- **Auto-select pdfLaTeX for documents that do not need Lua.** It changes fonts
  and output, contradicts the engine decision recorded in
  `2026-11-06-wasmtex-lualatex-poc.md`, and makes the preview disagree with a
  `fontspec` document.
- **The SDK's persistent IndexedDB cache instead of the Rust mirror.** It
  duplicates a cache that is already warm, adds a second eviction policy, and
  does not remove the engine boot.
- **A Node harness for the compile timings.** `wasmtex/headless` drives a Web
  Worker; Node has no `Worker` global, so it would measure a different host.
- **A second engine pool (one per open project).** More memory and more
  lifetime bugs for a marginal tab-switch win; one warm instance is the scope.
- **Page-preview only, without the canonical compile.** The preview would have
  no references, no bibliography and no exact SyncTeX; it is a provisional
  surface, not a replacement.
- **Always-on checkpoints without S2.** Every compile would build a checkpoint
  and throw it away.

## The measurement method

### Metrics

All timestamps are page `performance.now()` marks, so no clock conversion is
involved. The probe records the edit time itself; the application marks the
rest.

| Metric | From | To | What it answers |
| --- | --- | --- | --- |
| `T_user` | the probe dispatches the edit | full PDF committed | What the reader waits, including the 800 ms debounce |
| `T_render` | `renderLatexPreview` entry | full PDF committed | What the engine pipeline costs, without the debounce |
| `T_status` | the probe's edit mark | chip shows the correct phase | Whether S1 fixed the misleading message |
| `T_engine_status` | render entry | `latex_engine_status` resolves | Is the pre-compile IPC visible? |
| `T_snapshot` | snapshot request | snapshot resolved and base64-decoded | Is the re-read and decode cost material? |
| `T_module` | first `import("wasmtex/headless")` | module available | First-use module cost (session cold only) |
| `T_init` | `new WasmTexCompiler` | `init()` resolves | Worker + wasm + format boot; what S2 should remove |
| `T_compile` | `compile()` called | `compile()` resolves | Typesetting and all reruns; what S5 should reduce |
| `T_post` | compile resolved | before the viewer is created | Diagnostics, source map, store |
| `T_pdf` | `view.render()` called | PDF ready | Viewer cost, not engine cost |
| `T_firstpage` | the probe's edit mark | provisional page painted | S4's perceived win |
| `RSS` | OS process tree | at fixed checkpoints | Memory the warm engine and checkpoints hold |
| `download` | the active profile | static | Extra bytes the reader must fetch |
| `phaseUpdates` | chip text changes in one compile | count | How noisy the status is |

`T_user` is the headline before/after number because it is observable without
marks and is what the reader waits. `T_render` is the attribution metric for
engine work: it removes the constant 800 ms debounce, so a 30% engine
improvement is not diluted into a smaller-looking `T_user` change. The baseline
records both; the phase split explains where the change came from. The SDK's
`result.compileTime` is recorded inside `T_compile`'s detail as a cross-check;
it covers the worker's compile only and is not exposed as a user-facing
"compiled in" time.

### Instrumentation

- Add a tiny mark helper (a new `src/perf.ts` or local functions) with stable
  names: `mdraft:latex:render`, `snapshot`, `engine-status`, `module`, `init`,
  `compile`, `post`, `pdf`, `commit`, `phase`, `first-page`.
- Clear the `mdraft:latex:*` marks and measures at the start of each
  `renderLatexPreview`, so a long session does not grow the PerformanceEntry
  buffer.
- Every mark carries a `detail` object: `{ token, projectKey, warm:
  "created" | "reused", reason, files, bytes, libraries, engine, checkpoint? }`.
  The probe reads the last set; no global buffer is added.
- `compileLatex` marks `init` and `compile`; `renderLatexPreview` marks the rest.
  `T_snapshot` spans the IPC and the base64 decode at the top of `compileLatex`
  (two sub-marks, `snapshot-ipc` and `snapshot-decode`, so S3 can attribute the
  saving). The status helper marks each phase change while `latexInFlight` is
  true, so `phaseUpdates` is a real count rather than a polled guess.
- The probe reads `performance.getEntriesByType("measure")` over CDP and
  clears them before the next edit; it never relies on `data-latex-ms` for a
  phase, only as a cross-check of the total.

### Fixtures and edits

The two primary fixtures are **generated by the probe** into the test temp
directory from a fixed seed, so their content is byte-identical on every stage
and no fixture drift can masquerade as a performance change. The generator
version and the content hash are recorded with every run.

| Name | Shape | Content | Why |
| --- | --- | --- | --- |
| `small` | one `.tex` file, about 1-2 pages | `\documentclass{article}`, `fontspec`, a section, inline and displayed math, a label and a `\ref` | The small single-file case |
| `huge` | `main.tex` + 12 `chapters/chNN.tex`, about 30-40 pages | `\include{chapters/chNN}` for every chapter, sections, tables, cross-chapter refs, one local image, a `references.bib` | The multi-file case the snapshot, include graph, library handling and warm reuse must survive |

`huge` is the primary comparison: it has enough content that the typeset is
measurable above the engine boot, and its include graph exercises the snapshot
and the per-file diff. The image is copied from
`samples/latex-project/figures/diagram.png`, so no binary fixture is generated.
An optional `real` run copies `docs/samples/Resumo-executivo.tex` (23 pages)
into the temp directory and measures it with the same probe; it is a real-world
sanity check, not a gate.

Each measured edit replaces one character with a different one at a known
offset, so the document length is unchanged, the content hash changes, and the
run cannot be served from `latexStore`. Positions:

- `small`: one edit at 50% of the file.
- `huge`: a main-file edit at 10%, 50% and 90%; an included-file edit in the
  first, middle and last chapter; and one file-set edit that adds or removes an
  `\include`. The included-file and file-set cases are correctness checks for
  warm reuse as well as timing points.

The probe inserts a unique marker character per run and removes it before the
next run only if that does not invalidate the comparison; otherwise it cycles a
letter.

### Run protocol

- **The baseline comes first.** Before S1 or any performance change, build the
  release binary from the current base commit with only the measurement marks
  added, and run the probe twice (two launches) on `small` and `huge`. Write
  the raw JSON to `docs/audits/latex-compile-baseline.json` and record the
  medians and p95 in the results log. Those two launches define the
  between-launch noise band. No later comparison is valid without this file.
- Launch through the existing harness with an isolated profile:
  `node scripts/test-all.mjs --only latex-perf` (build on the first run, then
  `--no-build` while the binary is unchanged). The harness links the
  developer's engine and mirror into the private profile, which is what makes
  the measurement warm; the engine is never downloaded for a run. The probe
  skips cleanly when `latex_status` is false, like `latex:preview`, because a
  host without the engine has nothing to measure.
- Per fixture and launch: record the session-cold compile (the first one),
  then discard one warm-up compile, then five measured edits. A full matrix is
  therefore 1 cold + 6 warm per fixture.
- The session-cold compile also warms the mirror for that fixture. Verify the
  measured runs report zero package downloads; a download makes the run a
  network test and invalidates a cross-stage comparison for that fixture.
  Record any missing package and either warm it or drop the fixture from the
  comparison.
- The probe opens the fixture in Split with Auto-compile on, because Source mode
  never compiles and manual mode measures the Compile button rather than an
  edit. Record both settings with the run.
- The isolated suite window is hidden, and Chromium can throttle a hidden page.
  Before trusting a run, verify that the 800 ms debounce fires at about 800 ms
  and that the PDF paints rather than waiting on a paused animation frame. If
  either is throttled, run the perf layer in a visible test window (still the
  separate test profile) and record the mode; never compare a hidden run with
  a visible one.
- Between edits, wait until the compile is finished and the pane is idle; do
  not overlap. Record the wall gap and keep it constant.
- Report min, median and p95. Decisions use the median; a change is real only
  when it moves past the noise band and p95 agrees. A single-run difference is
  never evidence.
- Record host, OS build, git commit, engine year, binary hash, mirror bytes
  (`latex_cache_info`), and the fixture content hash with every run. A number
  without its conditions is not evidence.
- `RSS` is sampled at four points: after launch, after the session-cold
  compile, after the fifth warm compile, and 130 s after the last compile
  (after the 120 s idle timeout has fired). Sum the process tree rooted at the
  app PID; the harness passes that PID to the suite. The method is coarse on
  purpose: WASM memory is not in V8's heap counters, and the question is what
  the engine holds, not how the allocator labels it.
- The probe has a negative control: before S2, repeated compiles in one launch
  establish the run-to-run noise floor; after S2, the session-cold compile (no
  warm instance) must be measurably slower than a reused warm compile. If it is
  not, the instrumentation or the reuse path is not being exercised, and the
  run is invalid. S5 has its own control: a preamble edit must fall back to a
  full typeset, while a paragraph edit resumes from a checkpoint.

### Stage matrix and decision rules

Each stage is measured against the immediately preceding accepted set, not the
original baseline. The results log records both the marginal and cumulative
change. There is no arbitrary score: the decision is the measured marginal
gain weighed against the stated permanent cost and the correctness result.

| Stage | Change | Expected effect | Keep only if | Permanent cost |
| --- | --- | --- | --- | --- |
| S0 | Marks + probe + baseline | none | Always | ~0 bytes, one test layer + one baseline file |
| S1 | Truthful phases | `T_status`, `phaseUpdates` | Correct phases, <= 20 updates per compile (always ship) | Two files, no runtime cost |
| S2 | Warm engine reuse | `T_init` -> ~0 on reuse | The median `T_render` improves over the baseline by more than the noise band on `small` or `huge`, p95 agrees, and RSS is inside the budget; PDF text/pages unchanged | Lifetime state machine, ~4 files |
| S3 | Per-file digest + diff | `T_snapshot`, decode work | The median `T_snapshot` or `T_render` improves over S2 by more than the noise band; no extra failures | Additive snapshot field, two sides |
| S3b | Omit unchanged bytes | Payload, IPC | The payload reduction is needed before `T_snapshot` clears the noise band over S3; otherwise skip | Contract change, optional `known` map |
| S4 | Provisional first page | `T_firstpage` | `T_firstpage` is at most one third of the current `T_render`, the full `T_render` does not regress beyond the noise band, and scroll/zoom survive | Second pass and a provisional owner |
| S5 | Heap checkpoints | `T_compile` at 90% | The median `T_render` or `T_compile` improves over S2+S3 by more than the noise band; PDF text and page count equal; download and RSS budgets accepted | 7.1/8.2 MB download, shim, budget |

**No absolute timing target.** Every gate is a delta over the previous accepted
set, measured on the same build, fixtures and host. The absolute medians are
reported for context and to spot a regression, but they do not decide a stage.
A target such as "under 3 seconds" can be met by several approaches and says
nothing about which one is better; the measured delta does. A change that is
below the noise band is not an improvement, even when the absolute number looks
better; a change that is above it is kept even when the absolute number is still
far from a theoretical ideal.

**Dependencies.** S3, S4 and S5 are evaluated on top of S2. S5 is not evaluated
at all if S2 is rejected: the asset cost only pays on a reused compiler. S4
may be evaluated alone only if S2 is rejected and `T_compile` dominates the
baseline and the relative drop in `T_firstpage` is still worth its cost.

**Stop rule.** Stop adding stages when no remaining stage beats the noise band
on either primary fixture, or when a stage's improvement is not worth its
permanent cost. Choose the smallest accepted set whose median is within the
noise band of the best measured combination - fewer files, fewer states and
fewer assets win a tie.

**Kill rule.** A stage below the noise-band threshold, over budget, or with a
correctness regression is reverted in its own commit and recorded in the
decision log. A negative result is a valid outcome; "it might help" is not a
reason to keep it.

**Final-combination run.** After the gates, run the surviving combinations
end to end rather than summing stage deltas, because they interact:

1. Baseline (S0 only)
2. S2
3. S2 + S3 (and S3b if accepted)
4. S2 + S3 + S4
5. S2 + S3 + S5
6. The full accepted set

Report the absolute medians, the delta against the baseline, and the delta
against the previous accepted set, plus the cost column. The chosen row is the
cheapest row whose median is within the noise band of the best measured
combination.

### Results log (to fill during execution)

The baseline is measured twice on the current code plus the measurement marks
and stored as `docs/audits/latex-compile-baseline.json`. Host, OS build, commit,
binary hash, engine year, mirror bytes, generator version and fixture hashes are
recorded with it. The table below is the human summary; the JSON is the
evidence.

Baseline (before any performance change):

| Fixture | Scenario | Runs | `T_snapshot` | `T_init` | `T_compile` | `T_pdf` | `T_render` | `T_user` | RSS |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| small | cold | 1 | | | | | | | |
| small | warm | 5 | | | | | | | |
| huge main 10% | cold | 1 | | | | | | | |
| huge main 10% | warm | 5 | | | | | | | |
| huge main 90% | cold | 1 | | | | | | | |
| huge main 90% | warm | 5 | | | | | | | |
| huge first chapter | warm | 5 | | | | | | | |
| huge middle chapter | warm | 5 | | | | | | | |
| huge last chapter | warm | 5 | | | | | | | |
| huge add/remove `\include` | warm | 5 | | | | | | | |

Baseline noise band, per fixture and metric (two launches and five runs each):
`noise = max(|launch 1 median - launch 2 median|, 2 x within-launch MAD)`. A
stage must beat this band; the numbers go here.

| Fixture | Metric | Launch 1 median | Launch 2 median | Noise band |
| --- | --- | ---: | ---: | ---: |
| small | `T_render` | | | |
| huge main 10% | `T_render` | | | |
| huge main 90% | `T_render` | | | |
| huge main 90% | `T_compile` | | | |

Before/after comparison, one row per stage and commit. `Δ baseline` and
`Δ previous` are medians, not sums; a negative value is an improvement.

| Stage | Commit | small warm `T_render` | Δ baseline | Δ previous | huge 90% `T_render` | Δ baseline | Δ previous | huge 90% `T_compile` | Δ previous | `T_firstpage` | RSS | Download | Keep? |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Baseline | | | 0 | 0 | | 0 | 0 | | 0 | n/a | | | reference |
| S1 | | | | | | | | | | | | 0 | |
| S2 | | | | | | | | | | n/a | | 0 | |
| S3 | | | | | | | | | | n/a | | 0 | |
| S3b | | | | | | | | | | n/a | | 0 | |
| S4 | | | | | | | | | | | | 0 | |
| S5 | | | | | | | | | | n/a | | 7.1 / 8.2 MB | |

Stage decisions:

| Stage | Improvement vs previous | Noise band | Improvement vs baseline | Extra download | Extra idle RSS | Correctness | Decision |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| S1 | | | | 0 | 0 | | |
| S2 | | | | 0 | | | |
| S3 | | | | 0 | | | |
| S3b | | | | 0 | | | |
| S4 | | | | 0 | | | |
| S5 | | | | 7.1 / 8.2 MB | | | |

Multi-file cases, one row per stage. These are timing points and warm-reuse
correctness points: the PDF text must still match a full compile after an
included-file edit or an `\include` is added or removed.

| Stage | first chapter `T_render` | middle chapter `T_render` | last chapter `T_render` | add/remove `\include` | Reused? | PDF text equal? | Decision |
| --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| Baseline | | | | | n/a | reference | |
| S2 | | | | | | | |
| S3 | | | | | | | |
| S4 | | | | | | | |
| S5 | | | | | | | |

Final combination, measured end to end against the baseline:

| Candidate | small `T_render` | Δ baseline | huge 90% `T_render` | Δ baseline | `T_firstpage` | Download | RSS | Chosen |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Baseline | | 0 | | 0 | n/a | | | reference |
| S2 | | | | | n/a | | | |
| S2 + S3 | | | | | n/a | | | |
| S2 + S3 + S4 | | | | | | | | |
| S2 + S3 + S5 | | | | | n/a | | | |
| Full accepted set | | | | | | | | |

## Steps

- [ ] **1. S0: the baseline benchmark, before changing anything.** Add the
  marks and a tiny helper; add `scripts/latex-performance-test.mjs`; add the
  `latex-perf` layer (opt-in, `kind: "cdp"`,
  `script: "latex-performance-test.mjs"`) and `npm run latex:perf`; accept
  `--runs` and `--json` on a direct run, with defaults for the layer; set
  `MDRAFT_TEST_PID` from `test-all.mjs` after the launch so the probe can
  sample the process tree. The probe generates `small` (one file) and `huge`
  (main + 12 included chapters) deterministically in the suite temp directory,
  opens each in Split with Auto-compile on, performs the edits, and prints the
  table/JSON.
  - **Control first, before the marks exist.** Run the probe in an
    `--external` mode on the unmodified binary once per fixture: it times the
    edit to the existing `data-latex-ms`/committed-preview signal using only
    the DOM. Record `T_user`. Then add the marks and run the full baseline;
    the two `T_user` values must agree within the noise band. This proves the
    instrument did not change the before number.
  - Run the marked build **twice** (two launches), write the raw JSON to
    `docs/audits/latex-compile-baseline.json`, and fill the baseline,
    noise-band and comparison tables above.
  - Measure: `node scripts/test-all.mjs --only latex-perf` and
    `--only latex-perf --no-build` for repeats; the same probe is the only
    measurement tool used by every later stage.
  - Gate: the baseline file exists and is reproducible on a second launch; the
    external control agrees with the marked run within the noise band; the
    generated fixture hashes match between the two runs. The baseline build is
    the current code plus the measurement marks only; because the marks are
    `performance.measure` calls with no control-flow effect, the probe
    cross-checks `T_user` against the existing `data-latex-ms` total. If
    `T_init` and `T_snapshot` are too small to clear the noise band on either
    primary fixture, record that the engine stages cannot improve the total and
    stop after S1; if `T_compile` dominates and the perceived wait is still
    worth improving, evaluate S4 alone as the remaining candidate. Any other
    hotspot above the noise band is recorded in the baseline table; a cheap fix
    for it is added to this plan before it is implemented, with the same
    relative gate.

- [ ] **2. S1: tell the truth about the phase.** Change the adapter's progress
  contract to `"loading" | "compiling" | "downloading"` with an optional
  `{ percent, count }`; coalesce to at most one update per 100 ms or a phase
  change; emit `"compiling"` when the compiler is ready (after `init()`, or
  immediately on a reused engine). Map the labels in
  `main.ts` to "Loading the TeX engine…", "Compiling LaTeX…" and
  "Downloading LaTeX packages (n)…". Add the phase marks. Extend
  `latex-preview-test.mjs` (or the new probe) with the transition assertions
  and a `phaseUpdates` count.
  - Measure: `T_status`, `phaseUpdates`, and the same probe on both primary
    fixtures to prove S1 did not change `T_render` beyond the noise band.
  - Gate: every label that applies appears in order for a session-cold compile
    ("Loading" then "Compiling", with "Downloading (n)" only while a package is
    fetched); once S2 is in place, a reused engine goes straight to
    "Compiling"; the old "Resolving…" text never appears; the count stays
    <= 20. Ship independently of the later stages.

- [ ] **3. The lifetime decision, before S2 code.** Write
  `docs/adr/2026-11-12-latex-engine-lifetime.md`: one warm LuaLaTeX instance,
  its key, the stop/dispose split, the disposal boundaries, the idle timeout,
  and the memory budget. No S2 code before this is accepted.
  - Measure: none.
  - Gate: the ADR records the rules the tests will assert.

- [ ] **4. S2: keep one engine warm.** Add the warm slot and the pure decision
  helper (key, file diff, file-set change, busy, failed). `compileLatex` gains
  an options argument carrying `projectKey` (the absolute main file from
  `root.path`), the caret path/offset for S5, and the expected project
  revision. Split `cancelLatex()` into stop and dispose; audit every call site
  in `main.ts` (source mode, Compile, invalidate, settings change, tab close,
  language switch, engine disable). Reuse: `setFile` for changed files;
  file-set change: `loadProject` or a fresh instance, whichever the measurement
  says. If S3 is rejected, the file diff compares the decoded contents (length
  first, then bytes) and S0's snapshot result decides whether that cost is
  acceptable. On success keep the compiler; keep it too after a normal
  `LatexBuildError` (the engine ran and produced a log); dispose it after an
  `init`/worker error, an abort, or an explicit disable. Idle timeout: 120 s;
  test the boundary.
  - Measure: the same probe on the baseline fixtures; `warm: created` vs
    `warm: reused`, `T_init`, `T_render`, RSS at the four checkpoints; a
    two-edit series in `latex:preview`, an included-file edit, add/remove
    `\include`, cancel, tab switch, engine disable.
  - Gate: the S2 row of the matrix, with the improvement measured against the
    baseline and against S1. If it does not beat the noise band, revert the
    commit and record the failure; do not proceed to S5.

- [ ] **5. S3: stop decoding what did not change.** Add the per-file SHA-256 to
  the snapshot (Rust already computes it for the generation), keep the warm
  file map, compare digests, and decode only changed text files while keeping
  the previous decoded sources for the diagnostic scan. A file-set change uses
  the full snapshot. Optionally add S3b: an optional `known` map that lets Rust
  omit `data` for unchanged files, only if the measured snapshot share
  justifies it.
  - Measure: the same probe; `T_snapshot`, decoded bytes, IPC payload, and
    that a changed binary image is still sent exactly once.
  - Gate: the S3/S3b row; keep only an improvement over S2 that clears the
    noise band. If the baseline shows the snapshot below the noise
    contribution, record S3 as unnecessary and keep the simple TS-side
    comparison S2 needs.

- [ ] **6. S4: show a page while the full pass runs.** After a full compile,
  set the changed files, call `previewPages(1)` (or `previewColdPages(1)`
  before the first full pass), show the prefix as provisional, then run the
  canonical compile and replace it. Mark `T_firstpage`. Keep SyncTeX, word
  maps and export on the canonical result only. Cancel and supersede the
  provisional surface with the same token discipline.
  - Measure: `T_firstpage`, `T_render`, scroll/zoom retention, cancel and
    stale-result cases, on the same probe.
  - Gate: the S4 row: `T_firstpage` at most one third of the current
    `T_render`, the full `T_render` not regressing beyond the noise band, and
    the reading position surviving. Otherwise revert.

- [ ] **7. S5: heap checkpoints, only if S2 survived.** Add
  `wasmtex-luatex-checkpoint.js` and `.wasm` to both profiles in
  `src-tauri/latex-engine.json` with their sizes and SHA-256 from the upstream
  manifest (the same `manifest.json` the profile's `manifestSha256` anchors, at
  `https://corca-ai.github.io/wasmtex/wasmtex/<year>/manifest.json`). Teach
  `public/wasmtex/<year>/wasmtex-luatex.worker.js` to fetch the
  checkpoint wasm when `self.location.search` says `engine=checkpoint`. The
  shim already fails with "LuaLaTeX WASM unavailable" when its selected binary
  cannot be read; keep that fail-safe rather than silently handing the
  checkpoint glue the plain bytes. The controller's own fallback still covers a
  missing checkpoint glue. Pass
  `luatexHeapCheckpoints: { maxCheckpoints: 2, maxBytes: 128 MiB }` (measure
  the budget) and the caret position as `incrementalPreparation`; reuse is
  required. Extend `latex-sdk-unit.mjs` to assert the shim URL for the
  checkpoint query and the asset pair in both profiles; extend the CDP suite
  with a preamble edit (must fall back) and a paragraph edit (must resume),
  comparing PDF text with a full compile.
  - Measure: the same probe; `T_compile` at 10/50/90%, PDF text/page equality,
    fallback count, RSS, and the download delta.
  - Gate: the S5 row; keep only an improvement over S2+S3 that clears the
    noise band. If the checkpoint build does not activate or the improvement
    does not clear the band, remove the assets and the shim branch in the same
    commit.

- [ ] **8. Choose and close.** Run the final-combination matrix for the
  survivors, fill the comparison tables, choose the cheapest row within the
  noise band of the best, and record why every rejected stage lost. Update the
  ADR status, `docs/latex.md` (the phase names and, if shipped, the
  warm-engine behaviour), the catalog rows and counts, `package.json`, and the
  trap record if a measurement surprised us. Leave the plan and the baseline
  JSON in the repository as the record.

## Files and modules

| File | Why it must change |
| --- | --- |
| `src/main.ts` | Phase marks and labels, snapshot/compile marks, stop/dispose call-site audit, provisional-page surface, caret position for S5 |
| `src/latex.ts` | Warm slot, `setFile` diff, mark boundaries, progress contract, checkpoint option, reuse key |
| `src/perf.ts` (new, or local helpers) | One mark/measure helper with stable names and detail payloads |
| `src/latex-warm.ts` (new) | The pure reuse decision: key, changed files, file-set change, busy/failed cases; unit-tested without the app |
| `src/api.ts` | `LatexProjectSnapshot.files[].digest`; optional `known` map for S3b |
| `src-tauri/src/latex.rs` | Per-file digest, optional delta snapshot, tests |
| `src-tauri/latex-engine.json` | The two checkpoint assets in both profiles (S5) |
| `public/wasmtex/<year>/wasmtex-luatex.worker.js` | Fetch the checkpoint wasm on `?engine=checkpoint` (S5); keep the existing loud failure if the selected binary cannot be read |
| `src/latex-engine.ts` | No change expected; it already derives the download size from the profile |
| `scripts/latex-performance-test.mjs` (new) | The probe: deterministic `small`/`huge` generator, edits, cold/warm runs, table/JSON, RSS, negative control |
| `docs/audits/latex-compile-baseline.json` (new) | The committed before measurement: raw runs, fixture/generator hashes, host, commit; every stage compares against it |
| `scripts/latex-warm-unit.mjs` (new) | Decision-table and diff checks without the application |
| `scripts/latex-sdk-unit.mjs` | Shim plain/checkpoint URL selection, asset-pair parity, the loud failure path |
| `scripts/latex-preview-test.mjs` | Status transitions and a two-edit reuse case (or the probe owns the timing and this owns the UI assertions) |
| `scripts/test-all.mjs` | The `latex-perf` opt-in layer, the app PID in the suite environment, and a visible-window option for the perf layer if the hidden window is throttled |
| `package.json` | `latex:perf` |
| `docs/agent-guide/catalog/latex-and-formats.md` | New layer and script rows |
| `docs/agent-guide/testing.md` | Counts if the layer is default; the opt-in note otherwise |
| `docs/agent-guide/scripts.md` / the catalog | Every new script is indexed |
| `docs/latex.md` | The phase names and the warm-engine sentence, if shipped |
| `docs/adr/2026-11-12-latex-engine-lifetime.md` (new) | The warm instance's lifetime, cancellation and memory decision |
| `docs/plans/2026-11-12-latex-compile-cost.md` | This plan's logs and final status |

## Risks and rollback

- **A warm engine holds memory.** One LuaLaTeX worker can retain a substantial
  WASM heap. The idle timeout, the language/project disposal and the RSS
  checkpoint are the guards; if RSS exceeds +150 MiB, reduce the checkpoint
  budget or reject S5 first; if the warm engine alone exceeds it, reconsider
  S2. Rollback: revert the S2 commit; the
  previous dispose-per-compile path is intact and needs no state migration.
  A normal LaTeX build failure (an error with a log, thrown as
  `LatexBuildError` by the adapter) keeps the warm engine; only an `init` or
  worker failure, an abort, or an explicit dispose discards it. Otherwise every
  document error would pay a cold boot again.
- **Stale results and ownership.** A warm engine is another object whose
  result can arrive after a newer edit. The existing render token and
  `latexCurrent` checks stay the only authority; no result is committed before
  them. A cancelled compile must dispose the busy worker, not leave it running.
  Tests cover cancel, edit-during-compile, tab switch and engine disable.
- **Cancellation semantics drift.** `cancelLatex()` currently means both "stop"
  and "dispose". Splitting it without auditing every call site can keep a
  worker alive after the reader disabled the engine, or dispose one that a
  newer render is about to reuse. The audit is a required step, not a code
  review afterthought.
- **The snapshot contract is additive.** A new `digest` field is ignored by an
  older frontend; S3b's `known` argument is optional. There is no settings or
  cache migration.
- **Provisional pages can mislead.** They are labelled, carry no SyncTeX or
  word-map authority, and are replaced by the full pass or dropped on failure.
  If the viewer's scroll or zoom jumps, S4 is rejected.
- **Checkpoint assets are required once pinned.** A missing checkpoint pair
  makes the engine read as not installed because `engine_installed` requires
  every asset. The installer retries; if that proves too brittle, the profile
  needs an optional-asset list, which is a schema change this plan does not
  approve. Rollback: remove the pair and the shim branch; stale files on disk
  are harmless.
- **The probe can measure itself.** Always-on marks are cheap but not free, and
  a probe that changes the code path measures something else. The marks are
  `performance.measure` only, cleared per render; the negative control proves
  they do not hide a difference.
- **Fixture or generator drift.** The benchmark is only comparable when the
  generated documents are identical. The probe records the generator version
  and the content hashes; a change to the generator, the fixture text or the
  image invalidates the baseline and requires re-running it before a stage is
  measured. The real-world thesis copy is an optional sanity check and is never
  mixed into the primary comparison.
- **The benchmark host is noisy.** Relative medians and p95, five runs, two
  baseline launches, a recorded host and binary, and an opt-in layer keep the
  suite from failing on absolute milliseconds. No result is published without
  its conditions.

## Tests and validation

- **App-free units.** `latex-warm-unit.mjs`: the reuse decision table (same
  key/unchanged, one changed file, added/removed file, main change, library
  revision change, engine year change, busy, previous failure) and the diff
  output. `latex-sdk-unit.mjs`: the shim's plain and checkpoint URLs and the
  checkpoint pair in every profile. Rust: per-file digest stability, overlay
  digests, a delta snapshot that omits only unchanged data, and the
  asset/profile validation.
- **The probe.** `npm run latex:perf` (or
  `node scripts/test-all.mjs --only latex-perf`) prints the matrix and the
  negative control; every stage's before/after row in this plan is copied from
  a run of it on the same host and engine assets, and the stage's binary hash is
  recorded with the row.
- **Real-app regression.** `latex:preview`, `latex:project`, `latex:texmf`
  and `latex:native` (when a distribution is configured) prove the PDF,
  correspondence, warnings, library resolution, export and cancellation still
  work. `latex:preview` gains the status-transition and two-edit-reuse checks;
  the probe owns the timings.
- **Build and quality.** `npm run build`, `npm run format:check`, `npm run lint`,
  `npm run knip`; Rust through `scripts\cargo-vcvars.cmd test --manifest-path
  src-tauri\Cargo.toml` and `cargo clippy --all-targets -- -D warnings` on
  Windows. The Linux/macOS probe is recorded as unavailable if no host is
  available.
- **The one measurement that proves a stage.** S2: two consecutive edits show
  `warm: reused` and no `init` phase, the PDF text and page count are
  unchanged, and the median `T_render` improves over the previous accepted set
  by more than the noise band. S3: an edit in a project with an unchanged image
  does not decode that image and lowers `T_snapshot` beyond the noise band. S4:
  the provisional page's `T_firstpage` is at most one third of the current
  `T_render` on `huge`, and the full render does not regress beyond the band.
  S5: a paragraph edit's `T_compile` improves beyond the noise band while a
  preamble edit falls back and a forced full compile matches the PDF text and
  page count.
- **The final check.** After the chosen combination lands, re-run the same probe
  against the committed baseline on the same host and engine assets, and record
  the final delta. A final result that does not clear the baseline noise band
  means the plan delivered no measurable improvement, and that is recorded
  rather than dressed up.

## Acceptance criteria

- The baseline JSON and table exist for `small` and `huge` **before any
  performance change**, measured on two launches, with the phase split, noise
  band, RSS, host/commit/engine and generator/fixture hashes.
- No absolute timing number is used to keep or reject a stage. Every stage
  reports its median and p95 against the baseline and against the previous
  accepted set; a stage is kept only when the improvement clears the measured
  noise band and its resource cost is inside the budget. Otherwise it is
  reverted and recorded as rejected.
- The status never says "Resolving LaTeX packages…": it says "Loading the TeX
  engine…" while the format loads, "Compiling LaTeX…" as soon as the engine is
  ready, and "Downloading LaTeX packages (n)…" only while a package actually
  downloads; a compile emits at most 20 chip updates.
- The final combination is the cheapest measured set whose median is within the
  noise band of the best measured combination; its delta against the baseline,
  extra download and idle RSS are stated.
- If S2 ships: a second edit in the same project reuses the engine, produces
  the same PDF text and page count, and does not re-run the worker, wasm and
  format boot; a file-set change, a library change, an engine error, a language
  switch and the idle timeout all dispose it.
- No PDF, diagnostic, warning, SyncTeX, library or export regression in the
  existing suites.
- Every new script is in the catalog and `package.json`; the plan, the baseline
  JSON and the comparison logs are complete enough that a later session can see
  why each stage was kept or dropped.

## Open questions

1. **No absolute timing target.** Confirm that the relative noise-band rule is
   the only timing gate; absolute medians are recorded for context only.
   Default: yes, and the baseline benchmark is the reference.
2. **Is +7.1 to +8.2 MB of engine download acceptable if S5 clears the noise
   band?** Default: only if the measured improvement over S2+S3 pays for the
   download; the 2025 profile adds 7.1 MB and the 2026 profile 8.2 MB.
3. **Keep the warm engine across tab switches?** Default: only while the active
   document's root matches; dispose on a different root or language, and after
   120 s idle.
4. **What is the memory ceiling?** Default: +150 MiB RSS after five compiles,
   +50 MiB after idle disposal; adjust only with a recorded baseline.
5. **Are the generated `small` and `huge` documents representative enough?**
   Default: yes for the primary comparison - they are deterministic, the huge
   one has 12 included chapters and an image, and both exercise the paths that
   change. The real thesis copy is the optional sanity check, not a gate. If a
   reviewer wants a committed fixture instead of a generated one, it becomes a
   separate, versioned corpus and the baseline is re-run.
6. **Should S1 land before this plan is approved?** Default: it is a small,
   independent UI-copy fix and can land first; the plan does not depend on it,
   but the baseline should record the old `phaseUpdates` count if it does not.
