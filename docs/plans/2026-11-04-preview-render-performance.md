# Preview render off the UI thread and Typst compile control

**Status:** done
**Date:** 2026-11-04
**ADR:** `../adr/2026-11-04-preview-render-worker.md`

## Context and goal

Typing in a large document stutters. The editor's own input path is fast — a
1.2 MB Markdown buffer updates 5–11 ms after a key — but the preview rebuild
runs on the webview's main thread and blocks the next keystroke while it runs.

Measured on Debian, WebKitGTK 2.54, with a 1.2 MB Markdown fixture:

| Step | Time |
| --- | --- |
| `renderPreview` (marked + DOMPurify + KaTeX + highlight.js + fragment map) | 656 ms |
| `preview.innerHTML` | 26 ms |
| `bindPreviewWords` + `scrollTextAnchors` | 118 ms |
| total `doRender` | ~1.03 s |
| key event age while that render ran (`event.timeStamp` to the update listener) | **932 ms** max |

A 223 KB file took ~160 ms per render. The same behaviour appears for
AsciiDoc (Asciidoctor), while the HTML guest reloads a whole iframe and Typst
spawns a fresh compiler process per render.

The cheap wins have landed: Source mode no longer renders a hidden preview; the
quiet period scales with the buffer; the word map and the fragment map are built
only in Split. That removes the worst case (a hidden pane) but does not bound
the latency of a render that is legitimately needed: a pause longer than the
debounce still starts a ~1 s task on the UI thread, and typing during it waits.

The second measured cost is independent: a focused editor with a large document
burns ~9% of one core in WebKitGTK compositing because of CodeMirror's caret
blink; `cursorBlinkRate: 0` drops it to ~1%.

The goal is that a preview render never delays a keystroke by more than a frame
or two, that idle CPU is low, and that Typst does not compile hidden panes or
leave superseded compiles running.

## Scope and non-scope

In scope:

- Move the pure part of the Markdown pipeline (marked, math analysis, KaTeX
  string rendering, highlight.js, the fragment table and the block line list)
  to a module Web Worker. The main thread keeps DOMPurify and the DOM.
- Build the word map after paint in an idle task, only in Split.
- Keep mermaid out of the critical path when it is not needed for the first
  paint.
- A caret-blink preference (default off on Linux), replacing the unconditional
  `drawSelection()`.
- Typst: no compile for a hidden or unchanged pane; at most one compile in
  flight; a superseded compile is killed; a Typst-specific quiet period.
- A regression test that types during a render and measures the delay.

Non-scope:

- Incremental or block-virtualised preview rendering. It is the other way to
  bound latency, but it changes every renderer's assumptions; this plan keeps
  the existing full-document model and moves it off the thread.
- AsciiDoc and the HTML guest moving behind the same worker. Measure first;
  they keep the current synchronous path in this plan.
- Typst's compiler itself (we cannot make `typst compile` incremental).
- Changes to the export/print path, which may stay synchronous because it is an
  explicit action and not an editing interaction.

## Approach and rejected alternatives

**Chosen:** a module worker runs the pure half of `renderPreview`; the main
thread sanitises its HTML with DOMPurify and inserts the trusted math/code HTML
after sanitising, exactly as `restorePlaceholders` does today. The synchronous
`renderPreview` stays as the export path and as the fallback when a worker
cannot start. A render request carries a generation; only the newest result is
applied. The word map is built in `requestIdleCallback` after the DOM is
painted, so it never sits between a keystroke and a frame.

Why the split is where it is: DOMPurify needs a DOM, and the decoration passes
(`decorateLinks`, `decorateAlerts`, heading ids, TOC) need the live host. marked,
KaTeX's `renderToString`, highlight.js and the fragment table are pure strings
and are the expensive parts.

**Rejected: incremental/visible-block rendering.** It is the best long-term
answer for a 10 MB document, but it requires the preview to be a list of
independently rendered blocks, plus scroll anchoring and word-map ownership per
block. That is a larger rewrite than this symptom needs.

**Rejected: a DOM implementation in the worker (linkedom/jsdom).** It would let
the whole pipeline move, but it adds a dependency, a second HTML parser with its
own parser-difference surface, and a sanitizer that must be proved equivalent to
DOMPurify. Not worth it.

**Rejected: a longer debounce alone.** It reduces how often a render starts but
does not help when one does: the first keystroke after the quiet period still
waits for the whole task.

**Rejected: `requestIdleCallback` around the synchronous pipeline.** A single
`marked`/`DOMPurify` call cannot be preempted; moving the callback only changes
when the long task starts.

**Rejected: removing `WEBKIT_DISABLE_DMABUF_RENDERER`.** It is set on Wayland to
avoid a WebKitGTK abort (see the trap in `AGENTS.md`); the caret blink is the
part we can control.

For Typst, the chosen approach is a per-window generation in Rust: a new
`render_typst` marks the previous generation cancelled, and the wait loop kills
its child. The frontend also stops sending requests while the pane is hidden and
coalesces edits into one pending request.

## Steps

- [x] Write `docs/adr/2026-11-04-preview-render-worker.md`: worker boundary,
      message shape, sanitizer ownership, fallback.
- [x] Extract the pure pipeline out of `src/markdown.ts` into
      `src/preview-render.ts` (no DOM imports): math/code masking, marked with
      fragments, KaTeX HTML, block line list. highlight.js stays on the main
      thread inside the 64 KB batch; it is not the expensive part.
- [x] Add `src/preview-worker.ts` with a request/response protocol carrying a
      generation, source, options, HTML chunks, fragments, math HTML and block
      lines; `src/preview-worker-client.ts` keeps one job in flight and one
      pending, replacing an older pending job. Bundled with
      `new Worker(new URL(...), { type: "module" })`.
- [x] Keep `renderPreview` synchronous for export and as the fallback; the live
      path is `renderPreviewInto`. A worker failure falls back to the
      synchronous pipeline, not to an empty preview.
- [x] In `doRender`, await the worker result, check the generation, sanitise and
      insert in 64 KB batches with an ~8 ms yield budget, restore pre-rendered
      KaTeX, decorate, assign `data-line`, and paint. `finishPreview` runs the
      whole-host passes after the batches.
- [x] Move `bindPreviewWords`/`scrollTextAnchors` to a `requestIdleCallback`
      (800 ms timeout) with a 400 ms quiet gate, only in Split, cancelled by a
      generation. Word sync is unavailable until it finishes; an edit drops the
      generation.
- [x] Move mermaid rendering to a follow-up task after the first paint; it is
      cancelled by the render generation and re-anchors when the diagrams settle.
- [x] Add the `cursorBlink` setting end to end (settings, `api.ts`, preferences
      row, editor compartment), default off on Linux and on elsewhere; applied
      through `EditorHandle.setCursorBlink`.
- [x] Typst: a per-application cancel generation in `render_typst`; the wait
      loop kills a superseded child; a successful render is reused when the
      document id, revision, source, mode and image root are unchanged; Typst
      uses a 450 ms base quiet period; Source mode starts no compile.
- [x] Add `scripts/preview-performance-test.mjs` (CDP, Windows) that loads a
      generated 1.2 MB fixture, types during a render, and asserts key-to-DOM
      latency and long tasks; add `scripts/preview-render-unit.mjs` for the pure
      pipeline (35 checks, runs here).
- [x] Update `AGENTS.md`'s script and testing tables, package.json scripts and
      the measured trap entry.

## Implementation notes and deviations

- **Chunking, not a second sanitizer.** The worker returns one HTML fragment per
  top-level `marked` token. The main thread joins them in 64 KB batches, runs
  the existing DOMPurify options once per batch, and yields between batches.
  Math/KaTeX HTML is inserted after sanitising, which is the existing trust
  boundary.
- **KaTeX moved, highlight.js did not.** KaTeX rendering (per formula) is now in
  the worker. highlight.js stays on the main thread per batch because a
  document has few fences and moving it would duplicate the library in the
  worker bundle for no measured gain.
- **`renderPreview` stays.** It is the export/print path and the worker
  fallback. It uses the same `renderChunks` and the same batched insertion, so
  the two paths cannot drift; the goldens below compare them.
- **Word map timing.** It is built in an idle callback after paint, gated on
  400 ms of quiet, rather than in the render task.
- **Mermaid.** It starts after the first paint and re-anchors when the SVGs
  settle; a newer render cancels it.
- **Typst identity.** The plan said "source hash"; the implementation uses the
  session id, revision, source string, mode and image root. A revision bump is
  cheaper than a hash and catches every edit.
- **AsciiDoc followed in its own plan.** A generated 610 KB `.adoc` took 596 ms
  in one task when this plan was written. The follow-up
  (`docs/plans/2026-11-04-asciidoc-preview-worker.md`) has landed: the Asciidoctor
  conversion runs in `src/asciidoc-worker.ts` with its includes pre-read on the
  main thread, and the 610 KB worker path measured 156 ms with a 22 ms maximum
  main-thread gap in Chromium. The Source skip and quiet-period scaling apply to
  it unchanged.
- **Validation on this host.** `tsc`, Prettier, ESLint, `npm run build`,
  `npm run preview:unit` (36/36), the two new Rust tests and the whole
  `cargo check` pass. The Markdown worker and the synchronous path produced
  byte-identical HTML, fragments and anchors for `feature-tour.md`,
  `word-sync.md` and a 1.2 MB fixture in Chromium (goldens captured from the
  pre-refactor renderer): 22,483 / 3,354 / 1,650,510 bytes respectively. The
  worker rendered the 1.2 MB fixture in 479 ms off the main thread. On the real
  Tauri/WebKitGTK app (dev build, isolated profile) the worker reported a
  successful render and the Split preview painted the feature tour, which
  proves module workers work on the Linux target. The Windows CDP suites
  (`preview:perf`, `smoke`, `sync`, `word-sync`, `preview:zoom`, `asciidoc`,
  `typst:preview`) were not run on this Linux host; they remain the release
  gate in `AGENTS.md`.

## Files and modules

- `src/markdown.ts` — the DOM half and the synchronous/fallback path; the
  batched sanitise/insert loop.
- `src/preview-render.ts` (new) — the pure pipeline shared by the worker and the
  synchronous fallback.
- `src/preview-worker.ts` (new) — worker entry and protocol.
- `src/preview-worker-client.ts` (new) — one in-flight and one pending job.
- `src/main.ts` — `doRender` awaits the worker, generation checks, idle word
  map, mermaid deferral, Typst debounce/cache.
- `src/editor.ts` — `drawSelection` compartment and `setCursorBlink`.
- `src-tauri/src/settings.rs`, `src/api.ts`, `src/preferences.ts` — the caret
  preference.
- `src-tauri/src/typst.rs` — cancel generation and child kill.
- `src-tauri/tauri.conf.json` — no change: `worker-src 'self' blob:` was
  already present.
- `scripts/preview-performance-test.mjs` and
  `scripts/preview-render-unit.mjs` (new), plus the suites that already cover
  the renderers.
- `docs/adr/2026-11-04-preview-render-worker.md` and the AsciiDoc follow-up
  plan.
- `AGENTS.md`, `package.json` — script tables and the measured trap entry.

## Risks and rollback

- **CSP / module workers.** Vite emits a separate worker file; the Tauri CSP
  must allow it (and WebKitGTK must support module workers). The fallback to the
  synchronous `renderPreview` is the safety net; if the worker cannot start, the
  app remains correct and only the performance win is lost. Roll back the
  worker commit independently.
- **Sanitizer boundary.** Math and code HTML are inserted after DOMPurify, as
  today. A regression here is a security bug: the sanitizer gauntlet must run on
  the worker path (script tags, event handlers, `javascript:`, `data:` URLs,
  `file:` paths, malformed HTML) and compare the sync and worker outputs.
- **Fidelity.** `renderMarked` emits `data-f` spans; preview-only renders use
  plain marked. The golden comparison over the fixtures must prove the worker
  returns the same HTML for the same options, and the math/typography suites
  must still measure real glyph geometry.
- **Word-map timing.** Building it in an idle callback means word sync may be
  absent for a moment after a render. If the user acts then, the selection sync
  is a no-op instead of a wrong range; that is the fail-safe direction.
- **Caret preference.** A settings field is additive (`#[serde(default)]`); the
  default is platform-dependent only for a fresh profile. Roll back by toggling
  the preference or reverting the editor change.
- **Typst kill.** Killing a child while it writes its temporary output must
  still reap it and leave no `typst` process. The temporary directory is per
  render; no user file is touched.
- **Rollback of the whole plan.** The cheap wins (source skip, adaptive delay,
  map gating) are independent commits; the worker, the preference and Typst
  cancellation each revert separately. No data migration.

## Tests and validation

- **App-free unit test.** `npm run preview:unit` checks the pure pipeline:
  chunk counts, fragment order/ranges, line anchors, KaTeX/code tables, CRLF,
  empty input and a 2,400-block document. It does not build the DOM; the
  Chromium goldens did.
- **Renderer goldens.** The pre-refactor HTML, fragments and anchors were
  captured in Chromium for `feature-tour.md`, `word-sync.md` and a generated
  1.2 MB document, then compared with both the new synchronous path and the
  worker path. All three are byte-identical (see Implementation notes).
- **UI performance test.** `npm run preview:perf` opens a generated 1.2 MB
  document in Split, types while the initial render runs, and measures the key
  event's age and Long Tasks; it also checks idle typing, Source mode and the
  return to Split. To run on a Windows CDP host; the Linux session here could
  not drive the app after the X restart.
- **Caret test.** The Rust settings test covers the default and round trip; the
  preferences row applies through `applyLayout`. The idle-CPU measurement that
  motivated it (focused editor ~9%, blink off ~1%) was taken before the
  setting existed and is recorded in the trap entry.
- **Typst tests.** The Rust cancel-registry test passes; the frontend passes the
  render token and reuses an unchanged compile. A process-list check belongs to
  the Windows UI suite, which was not run here.
- **Existing suites** (order from `AGENTS.md`): `npm run build`, Rust tests,
  `npm run smoke`, `npm run sync`, `npm run sync:unit`, `npm run word-sync`,
  `npm run math`, `npm run typography`, `npm run html`, `npm run asciidoc`,
  `npm run typst:preview`, `npm run export`, `npm run export:browser`,
  `npm run pdf:native`, `npm run read-aloud`, `npm run format:document`,
  `npm run menu`, `npm run tabs`. Run the whole `npm test` before the branch is
  proposed for merge.
- **Linux manual measurement.** The CDP suites are Windows-only; repeat the
  probe on this Debian host (key event age, `doRender` duration, `top` idle CPU)
  and record the numbers in the plan's status note.

## Acceptance criteria

- With the 1.2 MB fixture in Split, a keystroke during a preview render appears
  in the editor within 150 ms (p95 100 ms), measured by the new suite and the
  Linux probe.
- Source mode performs no preview work: no `renderPreview`, no word map, no
  Typst compile, and idle CPU stays at the editor's own cost.
- Preview Only builds no word map; Split does, after paint.
- Switching Source → Split renders the current buffer once and word sync works
  on the next interaction.
- Typst: at most one compiler process, a superseded compile exits promptly, and
  an unchanged buffer is not recompiled.
- The caret preference persists; blink off leaves a visible solid caret and
  removes the measured idle CPU.
- The render-related suites and the sanitizer gauntlet pass; the exported HTML
  and PDF are unchanged.

## Open questions

- Does the Tauri CSP in `tauri.conf.json` already permit a Vite module worker,
  or does it need `worker-src 'self'`? Default: add the directive if a worker
  refuses to start; verify in the release build, not only in `tauri dev`.
- Is the caret default off on Linux only, or off everywhere with a preference?
  Default: off on Linux (where the cost is measured), on elsewhere.
- Does the Asciidoctor browser build tolerate a worker, or does it need a DOM?
  Default: keep AsciiDoc on the main thread in this plan and measure it; a
  follow-up plan if it is a real share of the lag.
- Should the word map move into the worker after all? It binds to DOM text
  nodes, so it cannot without transferring a DOM snapshot; the idle task is the
  cheap answer. Default: idle task.
- Is the 100 ms test target realistic on the slowest supported machine? Default:
  record the reference host's number and keep a 150 ms max, 100 ms p95 gate;
  adjust only with a recorded measurement.
