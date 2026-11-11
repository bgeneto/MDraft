# The preview pane shows only the active document's output

**Status:** done — milestone 1 implemented; milestone 2 not started
**Date:** 2026-11-10
**ADR:** `../adr/2026-11-10-preview-pane-ownership.md`, written as step 2 of
milestone 1.

## Handoff: read this first

This plan is written so a developer who has not seen the conversation can
implement it.

- **Baseline.** Written against branch `feat/wasmtex-lualatex-poc` at `189f219`
  with a clean tree. Line numbers below are from that tree; if they have moved,
  find the code by the **function name** given next to each number.
- **What is decided and what is open.** Everything under *Specification* is
  decided. *Open questions* lists the few calls that are not, each with a
  default; implement the default unless told otherwise.
- **Milestones.** Milestone 1 is the complete fix for the reported bug and
  touches no Rust. Milestone 2 (a compile-output cache) is approved separately
  and adds one additive field to a Rust command. One commit per milestone.
- **Read first** (about 20 minutes): `AGENTS.md` (Governance, Testing, Traps),
  `docs/agent-guide/traps/preview-and-sync.md`, the
  [LaTeX progress plan](2026-11-08-latex-preview-progress-and-warnings.md)
  (its criteria 5 and 7 must keep passing), and the
  [preview job ownership ADR](../adr/2026-11-05-preview-job-ownership.md).
- **Commands.** On Windows every cargo or Tauri invocation goes through
  `scripts\with-msvc.cmd` or `scripts\cargo-vcvars.cmd`. UI suites need Node 24
  for the unit layers and **no MDraft running** — the harness refuses to start
  against a running instance, including an installed copy.
- **Order of work.** Write the failing test first (step 1). It is the
  reproduction of the bug and the definition of done.

## Context and goal

**Symptom (as reported).** Switch from a Markdown tab to a `.tex` tab. The source
pane shows the LaTeX source; the preview pane keeps showing the Markdown document
while the LaTeX build downloads packages and compiles. When the build takes
minutes, the two panes describe different documents for minutes. The status strip
above the preview says "Compiling LaTeX…", but everything under it belongs to
another file.

**Cause, read from the code** (not yet reproduced with a timing probe — the
step 1 test is the reproduction and must fail before the fix):

- A tab switch runs `displayDoc` → `invalidatePreview()` (`main.ts:3269`). It
  bumps the render token and cancels work, but it deliberately leaves `#preview`
  alone. The only exception is a manual-compile LaTeX tab (`main.ts:3273-3279`).
- Every renderer builds off-screen and swaps on success: `stagedPdfHost` /
  `commitPdfHost` for PDFs (`main.ts:1477`, `1494`), the staging container in
  `renderPreviewInto` (`markdown.ts:169`) and `renderAsciidocPreviewInto`
  (`asciidoc-preview.ts:286`), and the Typst `innerHTML` swap. For **one
  document** that is the right rule — the LaTeX progress plan depends on it. But
  nothing records **whose** output is on screen, so the same rule also applies
  across documents.
- Nothing is reused across a switch. `displayDoc` calls `scheduleRender(true)`,
  `invalidatePreview` sets `lastTypstRender = null`, and `latexCurrent` requires
  `token === renderToken`, which a switch has just bumped. Returning to an
  unchanged `.tex` tab therefore starts the whole build again. A switch is
  expensive in time, and for that time it is also wrong on screen.
- Two latent defects share the cause: `commitPdfHost` maps the previous PDF's
  scroll bookmark into the new one with `mapScrollOffset(old.source,
view.source, …)` even when `old` is another document's PDF; and a tab switched
  in Source mode leaves the previous document's DOM mounted, so the next
  Source → Split shows it until the render commits.
- **HTML already does this correctly.** `syncGuest` (`main.ts:3220`) resets the
  guest on entry and disposes it on exit, so an HTML tab never shows another
  document's frame. The goal is to make that the rule for the rest of the pane.

**Goal.** At no moment does the preview pane display output that does not belong
to the active document. A slow build is visibly a build — a spinner, a named
phase, elapsed time — never another file's content. Coming back to an unchanged
LaTeX project does not rebuild it (milestone 2).

**Principle.** Preview content has an *owner*: the document, or for LaTeX the
project, it was built from. Within one owner, keep the last good output while
rebuilding and say it is out of date (stale-while-revalidate — today's
behaviour, unchanged). Across owners, never show it. Compile output is cached by
its inputs, so a return costs a PDF draw, not a build.

## Definitions

- **Owner** — what a piece of preview content was built from. Either a
  *document* (a session at one incarnation) or a *LaTeX project* (a root session
  plus the set of files the compile contained).
- **Commit** — the moment content becomes what the pane shows. The ten places
  that today write `previewStale = false`.
- **Covered** — the active document is allowed to see the current content:
  it is the owner document, or a file of the owner project.
- **Retire** — remove foreign content and its view objects from the pane.
- **Pending surface** — the spinner panel shown while the pane has no content
  for the active document.

## Scope and non-scope

**In scope — milestone 1.** The ownership stamp; retiring foreign content at the
one seam every document change already passes through; the pending surface; the
regression test; documentation and the ADR.

**In scope — milestone 2.** A bounded in-memory cache of compiled LaTeX PDFs
keyed by the content of the compile inputs.

**Not in scope.**

- **Per-tab preview slots** (each tab owns a detached preview container that the
  pane mounts). The cleanest end state, left open by this plan: `main.ts`
  touches `preview`/`previewPane` in about 120 places (anchors, word map, scroll
  sync, outline, zoom, selection marks).
- Retaining Markdown, AsciiDoc or Typst output across a switch (rebuilds take
  tens to hundreds of milliseconds). Typst Pages retention can join the
  milestone 2 store later.
- Changes to the LaTeX engine, package downloader, compile commands,
  `settings.json`, menu events, `render_typst`, or `latex_native_compile`. (The
  one Rust change is milestone 2's additive `contentDigest` field.)
- Persisting anything to disk; the cache dies with the window.
- Manual-compile mode showing a cached PDF without pressing Compile.
- Any control on the pending surface. Cancel, Compile and Auto-compile stay on
  the existing `.latex-build-status` strip, the single control surface.

## Approach and rejected alternatives

**Milestone 1.** A pure module defines owners and the timing policy. Each commit
stamps an owner. `invalidatePreview()` — already called by every path that
changes the active document — retires the pane unless the new active document is
covered by the stamped owner. A pending surface fills the gap until the new
document commits. **Milestone 2.** Cache the PDF bytes of successful LaTeX
compiles under a digest of the snapshot the compiler would receive, so a return
to an unchanged project skips the compile.

**Rejected alternatives.**

1. **Per-tab preview slots.** Removes the need for owner tokens but refactors
   `main.ts`'s preview globals across scroll sync, anchors, word map and zoom,
   with 57 test layers to keep green. Milestone 1's owner stamp and
   `retirePreview()` are the seam such a change would replace; the ADR records it
   as the direction.
2. **Dim the old preview and overlay a spinner.** Still renders another file's
   content — selectable, searchable, read by screen readers — and leaves the
   cross-document scroll mapping. It hides the symptom.
3. **Clear on every switch, with no owner.** Fixes the mismatch, but blanks a
   LaTeX project's own PDF when moving between its chapters, and discards the
   stale-while-revalidate on reload, Save As and edits that LaTeX progress plan
   criteria 5 and 7 promise.
4. **Keep the old preview and label it "preview of other.md".** Honest, but a
   reader looking at `.tex` source beside a Markdown preview is still not served.
5. **Compile every open tab eagerly.** Minutes of CPU and network for tabs nobody
   is looking at.
6. **A revision-only cache key (milestone 2).** An include, image or `.bib`
   edited outside MDraft would be served stale, and today's recompile-on-switch
   quietly picks such edits up.
7. **A skeleton screen instead of a spinner.** Suits a content-shaped load of a
   second or two. A Markdown wait is shorter than the grace delay, and a LaTeX
   skeleton would imply a page count and layout nobody knows yet.
8. **A determinate progress bar.** The compile callbacks report phases
   (`downloading`, `resolving`, `compiling`), not a fraction; a percentage would
   be invented. If a backend later reports a count, the surface can show it.
9. **A spinner that stands alone.** Past about ten seconds a bare spinner stops
   saying the work is alive; it is always paired with phase and elapsed time.
10. **A Cancel button on the pending surface.** Duplicates the strip's Cancel.

## Specification — milestone 1

### 1. `src/preview-owner.ts` (new, pure, no DOM)

Importable by Node 24 like `scroll-sync.ts`. Only runtime import:
`pathKey` from `./sessions` (type imports are erased).

```ts
export interface OwnerProbe {
  id: string;
  incarnation: number;
  path: string | null;
  language: DocumentLanguage;
}

export type PreviewOwner =
  | { kind: "document"; sessionId: string; incarnation: number }
  | {
      kind: "latex-project";
      rootId: string;
      rootIncarnation: number;
      /** pathKey() of every file the compile contained, root included. */
      memberKeys: ReadonlySet<string>;
    };

export function documentOwner(s: { id: string; incarnation: number }): PreviewOwner;
export function projectOwner(
  root: { id: string; incarnation: number },
  memberKeys: Iterable<string>,
): PreviewOwner;

/** True when `active` may see content stamped with `owner`. Null owner: false. */
export function covers(owner: PreviewOwner | null, active: OwnerProbe): boolean;

export const PENDING_GRACE_MS = 150;
export const ELAPSED_AFTER_MS = 5000;
export const ELAPSED_AFTER_REDUCED_MS = 1000;
export function formatElapsed(ms: number): string; // 7000 -> "0:07", 723000 -> "12:03"
export function pendingPhase(language: DocumentLanguage): string; // non-LaTeX label
```

`covers` rules:

- `document`: `active.id === sessionId && active.incarnation === incarnation`.
  The incarnation matters: opening the first file into the untitled startup tab
  reuses the session id (`takeStartupSlot` → `describe`), but it is a different
  document (`sessions.ts:22-28`, `main.ts:3527`).
- `latex-project`: the root (same id **and** incarnation), or
  `active.language === "latex"` and `active.path !== null` and
  `memberKeys.has(pathKey(active.path))`. The language test stops a `.bib` or
  `.sty` tab, which gets its own non-LaTeX preview, from inheriting the PDF.

`pendingPhase`: markdown → "Rendering preview…", asciidoc → "Rendering
AsciiDoc…", typst → "Compiling Typst…", html → "" (unused), latex → "Preparing
LaTeX compilation…" (the initial text; later text comes from `setLatexStatus`).

### 2. State and helpers in `main.ts`

```ts
let previewOwner: PreviewOwner | null = null;
function commitPreview(owner: PreviewOwner): void; // previewStale = false;
                                                   // previewOwner = owner; clearPending();
function retirePreview(): void;                    // see §4
```

### 3. Commit sites — replace each `previewStale = false` with `commitPreview(...)`

All ten already run after a `token`/`doc.id` guard, so `doc` is the document that
rendered. Keep any other statements in the same block exactly as they are.

| Line | Function | Owner passed |
| --- | --- | --- |
| 2109 | `latexFailure` (end) | `projectOwner(root session, latexProblemFiles ∪ {root path key})` when a root is known, else `documentOwner(doc)` |
| 2270 | `renderLatexPreview`, backend `"none"` | `documentOwner(doc)` |
| 2398 | `renderLatexPreview`, success | `projectOwner(root, [...result.files].map(f => pathKey(joinDir(root.directory, f))))` — the same membership `latexRelative` tests |
| 2460 | `showTypstFailure` (top) | `documentOwner(doc)` |
| 2530 | `renderTypstPreview`, cache hit | `documentOwner(doc)` |
| 2609 | `renderTypstPreview`, Document | `documentOwner(doc)` |
| 2657 | `renderTypstPreview`, Pages | `documentOwner(doc)` |
| 2825 | `doRender`, HTML | `documentOwner(doc)` (the guest already resets on a switch; stamped for consistency) |
| 2850 | `doRender`, AsciiDoc | `documentOwner(doc)` |
| 2899 | `doRender`, Markdown | `documentOwner(doc)` |

The `previewStale = true` writes (edit, mode change, cancel, engine change) are
unchanged: an edit makes the **same** owner's content stale; it does not change
the owner.

### 4. `retirePreview()` — exactly what it resets

Call it only from `invalidatePreview()` (§5). It runs after `invalidatePreview`'s
existing cancellations.

*Remove from the DOM:* `previewPane > .typst-viewbar`, `previewPane >
.latex-warnings`, `previewPane > .latex-build-status` (already removed by
`invalidatePreview`'s first lines), then `preview.replaceChildren()` (which also
removes `.pdf-rebuild-error`, the staged host and any PDF host). Reset
`preview.style.minHeight = ""`. Delete `preview.dataset.latexCurrent`,
`latexMs` and `pdfCommit`.

*Reset variables:* `disposeTypstPdf()` (clears `typstPdf` and `typstPdfBase64`),
`typstPdfToken = -1`, `latexLastSourceScroll = null`, `previewLinesMapped = false`,
`previewOwner = null`. `discardStagedPdf()`, `wordMap`, `wordMapGeneration`,
`lastTypstRender`, `previewStale = true` and `previewSyncReady = false` are
already handled by `invalidatePreview`.

*Do not touch:* `latexPreview` (it is also the project-root memory that
`renderLatexPreview` reads at `main.ts:2285-2300`; nulling it would make a chapter
tab compile standalone after a switch), `latexNavigationRoot`, `latexProblems`,
`latexProblemRoot`, `latexProblemFiles`, `latexProblemSignature`, and the global
`#typst-export-css` style element.

### 5. `invalidatePreview()` (`main.ts:3269`)

Keep everything it does today **except** the block at `3273-3279` (the
manual-compile special case), which is replaced by:

```ts
if (!covers(previewOwner, probeOf(doc))) {
  retirePreview();
  armPending();
}
```

where `probeOf(session)` builds an `OwnerProbe`. Then delete
`navigatingLatexProblem` (`main.ts:1598`, `1971`, `1979`): its only reader was the
removed block, and a project-owned preview covers the chapter a problem row
opens. Confirm with a search that nothing else reads it before deleting.

Resulting behaviour: reload, Save As, an edit and a move to another file of the
same LaTeX project keep the content; everything else retires.

### 6. The pending surface

**State.**

```ts
let pending: {
  sessionId: string; incarnation: number;
  startedAt: number;          // performance.now() when armed
  graceTimer: number;         // window.setTimeout
  tick: number;               // window.setInterval, elapsed counter
  node: HTMLElement | null;   // null until shown
} | null = null;
```

**`armPending(opts?: { immediate?: boolean })`** — idempotent. Does nothing when
`doc.language === "html"`, `previewOwner !== null`, or `settings.viewMode ===
"source"`. If `pending` already belongs to this session and incarnation, return
(so `startedAt` survives repeated renders of the same wait). Otherwise create it
and start `graceTimer` for `PENDING_GRACE_MS` (0 when `immediate`). When the timer
fires and `pending` is still current, `previewOwner` is still null, and the mode
is not Source: build the node (below) and start `tick` (1 s).

**Entry points.** (a) `invalidatePreview` after a retire (§5); (b) top of
`doRender`, after its Source-mode early return, as `if (previewOwner === null)
armPending()` — this covers `scheduleRender`, `compileCurrentLatex`, the
`doRender(true)` caller at `main.ts:8166`, and leaving Source mode (via
`setViewMode` → `scheduleRender`); (c) the manual-compile branch of
`scheduleRender` (`main.ts:1391`): `armPending({ immediate: true })`, which shows
the idle variant.

**Exits.** `commitPreview` and `retirePreview` call `clearPending()` (clear both
timers, remove the node, `pending = null`); `retirePreview`'s caller re-arms for
the new document. `setViewMode("source")` and the Source branch of
`scheduleRender` call `clearPending()`. `cancelLatexBuild` (`main.ts:1666`)
switches an existing node to the idle variant with the text "Compilation
cancelled." when `previewOwner === null`.

**Variants.** *Pending:* spinner + title + phase + elapsed. *Idle:* no spinner;
title + phase. Idle is used when `doc.language === "latex"`,
`settings.latexAutoCompile === false` and no build is in flight; its phase reads
"Not compiled yet — select Compile." Elapsed appears after `ELAPSED_AFTER_MS`
(`ELAPSED_AFTER_REDUCED_MS` when `matchMedia("(prefers-reduced-motion: reduce)")`
matches), measured from `startedAt`, formatted by `formatElapsed`.

**Phase text.** `setLatexStatus(message)` (`main.ts:1704`) also writes `message`
into the node's phase line when one exists. Other languages use `pendingPhase`.

**DOM** — a child of `.preview-pane`, **not** of `#preview` (UI inside `#preview`
is scaled by Document Zoom; see the sticky Typst view bar trap in
[editor-and-ui.md](../agent-guide/traps/editor-and-ui.md)):

```html
<div class="preview-pending" data-state="pending">
  <div class="preview-pending-spinner" aria-hidden="true"></div>
  <div class="preview-pending-title">main.tex</div>
  <div class="preview-pending-phase" role="status" aria-live="polite">Compiling LaTeX…</div>
  <div class="preview-pending-elapsed" aria-hidden="true">0:42</div>
</div>
```

The elapsed counter is outside the live region so a screen reader is not
interrupted each second. The title is `doc.name`, set with `textContent`.

**CSS** (`styles.css`, near `.latex-build-status`, `styles.css:2331`):

```css
/* The pane is padded and scrolls; while the surface is shown it is neither, so
   the surface can fill it without changing the sticky strip's width. */
.preview-pane:has(> .preview-pending) {
  position: relative;
  overflow: hidden;
}
.preview-pending {
  position: absolute;
  inset: 0;
  z-index: 1; /* below .latex-build-status (z-index 4) */
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  color: var(--muted);
  text-align: center;
  pointer-events: none;
}
.preview-pending-spinner {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2.5px solid var(--border);
  border-top-color: var(--accent);
  animation: preview-spin 0.9s linear infinite;
}
.preview-pending[data-state="idle"] .preview-pending-spinner {
  display: none;
}
.preview-pending-title {
  max-width: 70%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg);
  font-size: 14px;
  font-weight: 600;
}
.preview-pending-phase,
.preview-pending-elapsed {
  font-size: 12px;
}
.preview-pending-elapsed {
  min-height: 1.2em; /* the counter appearing must not move the column */
  font-variant-numeric: tabular-nums;
}
@keyframes preview-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .preview-pending-spinner {
    animation: none; /* a static arc; the counter carries liveness */
  }
}
```

Why these choices: a thin ring in `--border`/`--accent` follows both themes and
every accent without an asset or dependency; `transform: rotate` is composited,
so the ring keeps turning while the main thread draws a PDF or inserts Markdown
batches (not verified on WebKitGTK — see Risks); `animation: none` under reduced
motion matches `sync-blink` and `latex-error-pulse`; `pointer-events: none`
because the surface is informational; fixed sizes keep the column from jumping
when the phase text changes.

### 7. Edge cases the implementation must handle

| Case | Required behaviour |
| --- | --- |
| A → B → C before B commits | Owner is what last **committed**, not the outgoing tab. A's content retires once at A→B; C's switch finds `previewOwner === null` and retires nothing; pending re-arms for C. |
| Reload, Save As, edit | Same session and incarnation → covered → nothing retires. |
| First file opened into the untitled startup tab | Incarnation changed → not covered → retire. |
| Close the active tab, or last tab | `displayDoc` → `invalidatePreview`; the closed owner no longer covers the neighbour → retire. |
| Switch in Source mode, later → Split | Retire happens at the switch (the pane is hidden then); `armPending` skips Source; leaving Source reaches `doRender` → arms. No foreign DOM exists when the pane reappears. |
| HTML ↔ other | HTML is excluded from the surface; `syncGuest` already resets/disposes the guest; the retire on the hidden `#preview` is harmless. |
| Edit while pending | `editor.onDocChanged` (`main.ts:8922`) is unchanged; the surface stays, phase text follows `setLatexStatus`. |
| Build commits as a failure panel, the "LaTeX not enabled" note or the Typst "not installed" note | These are commit sites (§3); the surface clears. |
| Untitled `.tex` (no path) | `renderLatexPreview` commits a failure ("Save this .tex file before compiling.") → surface clears. |
| Build never returns | The surface stays, elapsed keeps counting; the strip's Cancel stops it; `cancelLatexBuild` makes the surface idle. |
| Manual-compile `.tex`, never compiled | Idle surface at once; the strip's Compile builds. |
| Project root ↔ chapter, auto or manual | Covered by the project owner; the PDF stays (marked out of date by the strip). In auto mode a rebuild follows. |
| Theme or zoom change | A render of the same owner; nothing retires. |

## Specification — milestone 2

Ship only after milestone 1 has landed.

**Rust (`src-tauri/src/latex.rs`, additive).** Add `content_digest: String`
(serialised `contentDigest`) to the result of `latex_project_snapshot`
(`latex.rs:1173`; struct at `~637`, built at `~1221`): hex SHA-256 over the
snapshot's files **sorted by project-relative path**, each contributing its path
length, path, data length and data (length-prefixed, so two projects cannot
produce the same stream). Open-buffer overlays are already folded into the file
data, so they are included. `sha2` is already a dependency (`latex.rs:7`) — no
new crate. Add `contentDigest` to `LatexProjectSnapshot` in `src/api.ts:727`. A
Rust test proves: same inputs → same digest; one byte changed, a file added, a
path renamed or an overlay changed → different digest. Computing it in Rust
avoids relying on `crypto.subtle`, which the frontend does not use today and
whose availability in every webview's secure-context rules is unverified.

**`src/latex-build-cache.ts` (new, pure).**

```ts
export interface BuildEntry { result: LatexResult; builtAt: number; bytes: number }
export function cacheKey(
  backend: string, engine: string, rootPath: string, digest: string,
): string;
export class LatexBuildCache {
  constructor(budgetBytes = 64 * 1024 * 1024);
  get(key: string): BuildEntry | undefined; // refreshes recency
  put(key: string, entry: BuildEntry): void; // evicts oldest; skips entry > budget
  dropWhere(test: (key: string) => boolean): void;
  clear(): void;
}
```

**`main.ts`.** In `renderLatexPreview`, after `api.latexProjectSnapshot`
resolves and its token check passes (`main.ts:2323-2324`), build the key from
`engineStatus.backend`, the engine name, `root.path` and `snapshot.contentDigest`.
On a hit, use `entry.result` and skip the compile (status: "Built HH:MM ·
cached"); the rest of the function (staged host, PDF draw, `commitPreview`) is
unchanged, and the PDF is passed as `result.pdf.slice()` as today so the cached
bytes are never transferred away. On a miss, compile as today and `put` only a
**successful** result — never a failure or a partial PDF. A one-shot flag set by
`compileCurrentLatex` bypasses the cache so Compile always rebuilds. Call
`clear()` from `invalidateLatexBuild()` (`main.ts:1651`, engine or backend
change); call `dropWhere` for a root's path when its tab closes. The cache is
module state, never persisted.

## Steps

Milestone 1:

- [x] **1. Failing test first.** Write `scripts/preview-ownership-test.mjs`
      (see Tests), register it, run it against the current build, and record
      which assertions fail and how.
- [x] **2. ADR.** `docs/adr/2026-11-10-preview-pane-ownership.md` using
      `docs/adr/README.md`'s template: content has an owner; foreign content is
      removed, not dimmed; same-owner stale-while-revalidate is kept; the HTML
      guest rule generalised; per-tab slots recorded as the direction.
- [x] **3. Module + unit test.** `src/preview-owner.ts` and
      `scripts/preview-owner-unit.mjs`; script `preview-owner:unit` in
      `package.json`.
- [x] **4. Commit/retire.** `previewOwner`, `commitPreview` at the ten sites,
      `retirePreview`, the `invalidatePreview` change, removal of
      `navigatingLatexProblem`.
- [x] **5. Pending surface.** State, `armPending`/`clearPending`, entry and exit
      points, DOM, `setLatexStatus` mirroring, CSS.
- [x] **6. Green.** Step 1's test passes; run every layer under Tests.
- [x] **7. Docs.** See Documentation. Set this plan's status to `done`, tick the
      boxes, and record any deviation here.

Milestone 2:

- [ ] **8.** Extend the ownership test (compile counter), then the Rust digest
      and its test, `api.ts` field, `latex-build-cache.ts` and its unit test,
      `main.ts` wiring, bypass flag, drops.
- [ ] **9.** Add a section to the ADR (do not rewrite it); update the LaTeX trap
      notes; set the status.

## Files and modules

| File | Change |
| --- | --- |
| `src/preview-owner.ts` (new) | Owner types, `covers`, timing constants, `formatElapsed`, `pendingPhase`. |
| `src/main.ts` | `previewOwner`, `commitPreview`, `retirePreview`, `invalidatePreview`, pending surface, `setLatexStatus` mirror, `doRender`/`scheduleRender`/`cancelLatexBuild` hooks; remove `navigatingLatexProblem`. Milestone 2: cache wiring. |
| `src/styles.css` | `.preview-pending*`, `@keyframes preview-spin`, reduced motion. |
| `scripts/preview-owner-unit.mjs` (new) | Unit layer for the module. |
| `scripts/preview-ownership-test.mjs` (new) | The reproduction and acceptance, in the real UI. |
| `scripts/test-all.mjs`, `package.json` | Register both layers and the `preview-owner:unit` script. |
| `scripts/cdp-page.mjs` | `onEvent`, so a suite can consume `Fetch.requestPaused` alongside the console and exception listeners. |
| `docs/adr/2026-11-10-preview-pane-ownership.md` (new) | The decision. |
| `docs/agent-guide/testing.md`, `AGENTS.md` (Testing section), README if it quotes the count | Layer count "Fifty-seven" → "Fifty-nine"; two table rows. |
| `docs/agent-guide/catalog/preview-and-sync.md` | A row in each table that lists the preview scripts (command table, per-script fixture table, check-count table). |
| `docs/agent-guide/traps/preview-and-sync.md` | The trap entry below, plus anything that cost time. |
| Milestone 2 only: `src-tauri/src/latex.rs`, `src/api.ts`, `src/latex-build-cache.ts`, `scripts/latex-build-cache-unit.mjs`, `docs/agent-guide/traps/latex-typst-asciidoc.md` | Digest, type, cache, unit layer, notes. |

Not touched: `settings.json` schema, menu events, any other command, the HTML
guest, `markdown.ts`, `asciidoc-preview.ts` (their commits already replace the
host's children; clearing the surface is `commitPreview`'s job).

## Tests and validation

### Unit layer — `scripts/preview-owner-unit.mjs`

Follows `scripts/scroll-sync-unit.mjs` (`node:assert/strict`, a `check(label,
fn)` helper printing `  PASS  <label>`, final `N/N checks passed`). Cases:
`covers(null, …)` is false; a document owner covers only its own id **and**
incarnation (same id, bumped incarnation → false); a project owner covers the
root, a member by path key, and not an outsider; a member whose
`language !== "latex"` is not covered; a member with `path: null` is not
covered; path keys are case-folded as `pathKey` does on Windows; `formatElapsed`
boundaries (0, 59 999, 60 000, 3 600 000 ms); the three constants are as
specified.

### UI layer — `scripts/preview-ownership-test.mjs`

Shape per [scripts.md](../agent-guide/scripts.md#conventions-for-new-test-scripts):
port from `argv[2]`, `openPage` from `./cdp-page.mjs`, one `PASS`/`FAIL` line per
check, `N/M checks passed`, non-zero exit on failure. Register in
`scripts/test-all.mjs`:

```js
{
  id: "preview-ownership",
  title: "Preview pane ownership across tabs",
  kind: "cdp",
  script: "preview-ownership-test.mjs",
  doc: "samples/feature-tour.md",
  safeWithInstalledApp: true, // in-memory edits and temp files only
},
{ id: "preview-owner-unit", title: "Preview ownership (unit)", kind: "node",
  script: "preview-owner-unit.mjs" },
```

Place the unit layer after "Preview worker ownership" and the UI layer after
"Document zoom", matching the table's cheapest-first order.

**Fixtures.** Written to a temp directory by the test, never into the repo:
`a.md` with an `# OWNER-MARKER-MD` heading; `b.md` (another marker); `doc.tex`
(`\documentclass{article}\begin{document}OWNER-MARKER-TEX\end{document}`);
`a.typ`; `a.adoc`; and a copy of `samples/latex-project/` for the root ↔ chapter
cases. Open with the `open-files` event
(`window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {event: "open-files",
payload: [path]})`, as `latex-preview-test.mjs:121`); switch by clicking the tab
(`.doc-tab` whose `.doc-tab-name` matches, as `clickTab` in
`document-tabs-test.mjs`). `view.split` / `view.source` via `emitMenu`.

**Holding a build without a production seam.** Install a wrapper in the page that
delays chosen IPC commands, then release it:

```js
window.__holds = new Map(); // command -> Promise to wait for
const real = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
window.__TAURI_INTERNALS__.invoke = (cmd, args, opts) =>
  window.__holds.has(cmd)
    ? window.__holds.get(cmd).then(() => real(cmd, args, opts))
    : real(cmd, args, opts);
```

Hold `latex_engine_status` (the first await in `renderLatexPreview`,
`main.ts:2253`) for the LaTeX cases and `render_typst` for Typst: both hold the
render **independently of whether an engine is installed**, so the ownership
cases run on every host. After release the render ends as either a PDF or the
"not enabled" note, both commits. Cases that need a real PDF skip cleanly when no
engine is available, as `latex-preview-test.mjs` does. *Assumption to confirm in
step 1:* `@tauri-apps/api` calls `window.__TAURI_INTERNALS__.invoke` at call time
so the wrapper takes effect; if it does not, hold through the next seam up
(`api.ts`).

**Sampling.** The harness runs the window hidden, so do not rely on
`requestAnimationFrame`. Sample with `setInterval(…, 10)` and a
`MutationObserver` on `#preview-pane`; record whether the pane's text contains
the previous document's marker. Also assert **synchronously in the same
`evaluate` as the tab click** — `invalidatePreview` runs before `displayDoc`'s
first `await`, so the marker must already be gone when `click()` returns.

**Cases** (each one or more `PASS`/`FAIL` lines):

1. MD → `.tex` with `latex_engine_status` held 5 s: marker absent synchronously
   after the click and in every sample; `.preview-pending` appears within 250 ms,
   `data-state="pending"`, title is `doc.tex`, phase non-empty, spinner's
   computed `animation-name` is not `none`, spinner rect is centred in the pane
   within 2 px, and `.latex-build-status` keeps the same `left` and `width` as
   before the surface appeared (no layout shift). After 5 s the elapsed counter
   is non-empty. After release the surface is gone and the pane shows a PDF or
   the not-enabled note.
2. The same with emulated `prefers-reduced-motion: reduce`
   (`Emulation.setEmulatedMedia`): spinner `animation-name` is `none`; the
   counter shows by ~1 s.
3. Cancel during the hold (click the strip's Cancel): the surface becomes
   `data-state="idle"` with "Compilation cancelled", no spinner.
4. MD → Typst (`render_typst` held), both Document and Pages: no marker in any
   sample; surface shown; cleared on commit. MD → AsciiDoc: no marker in any
   sample (no hold available).
5. `.tex` (PDF shown) → MD: no `.typst-preview` element remains and no PDF
   canvas is attached once the Markdown renders. *(Needs an engine; skips.)*
6. MD ↔ MD: `.preview-pending` never appears (render faster than the grace);
   record the empty-pane window and assert it is under `PENDING_GRACE_MS`.
7. Source mode: `view.source`, switch to `.tex` with the hold on, then
   `view.split` — marker never present in any sample.
8. Five rapid switches among MD, `.tex`, `.typ`, `.adoc`, MD: the pane never
   shows a document other than the active one; no `.preview-pending` remains
   after the final commit; no timer leaks (a pending surface that outlives its
   commit fails).
9. Project root ↔ chapter in auto and manual mode (`view.latexAutoCompile`): the
   pane keeps the project's content on moving between them; moving to an
   unrelated `.tex` retires it. *(Needs an engine for the PDF assertion; the
   manual-mode idle-surface assertions run without one.)*
10. Manual-compile `.tex`, never compiled: idle surface immediately, no spinner,
    text "Not compiled yet — select Compile."
11. HTML ↔ others: the HTML guest still resets/disposes; no `.preview-pending`
    on an HTML tab.
12. First file opened into the startup tab shows no leftover preview of the
    untitled document (needs the unit layer's incarnation rule plus one UI
    check where the harness allows).

### Regression layers

`npm run build`, `npm run lint`, `npm run format:check`, `npm run knip` (every
new export must be used); `npm run tabs`; `npm run latex:preview` (failed-build
retention, rebuild-at-tail, manual compile — LaTeX progress plan criteria 5 and
7); `npm run typst:preview` (PDF disposal); `npm run html`; the AsciiDoc test;
`npm run preview:dom`; `npm run preview:zoom` (the surface must not scale);
`npm run smoke`. Use `node scripts/test-all.mjs --list` for layer ids and
`--only <ids>` to run a subset; run plain `npm test` before merging. Milestone 2
also runs `npm run test:rust` and `cargo clippy --all-targets -- -D warnings`
through `scripts\cargo-vcvars.cmd`.

**One measurement that proves milestone 1.** In the real app, with
`latex_engine_status` held for 5 s, switch from a Markdown tab to a `.tex` tab
and count the samples whose pane text contains the Markdown marker. It must be
**0**. Before the fix it is expected to be every sample for the whole hold.

## Documentation to update

- `docs/agent-guide/testing.md` and `AGENTS.md` (Testing): "Fifty-seven" →
  "Fifty-nine" default layers; two rows in the ordered table. Milestone 2's
  `latex-build-cache-unit` layer makes it "Sixty".
- `docs/agent-guide/catalog/preview-and-sync.md`: rows for
  `preview-owner-unit.mjs` and `preview-ownership-test.mjs` (command, what it
  measures, fixtures, check count) in each table that lists preview scripts.
- `docs/agent-guide/traps/preview-and-sync.md`, new entry (symptom first line in
  bold, per `traps.md`): **"After a tab switch the preview shows the previous
  document until the new one commits."** Cause: build-off-screen-and-swap is
  only correct per owner. Fix: owner stamp + retire in `invalidatePreview`.
  False conclusions to record: that the status strip proves the pane is current
  (it describes the build, not the pane's content); that `latexPreview` can be
  nulled on retire (it is the project-root memory).
- The ADR (step 2) and, for milestone 2, a section appended to it.
- No `site/` change: the feature list does not change.

## Risks and rollback

- **`latexPreview` is also the project-root memory.** Nulling it on retire makes
  a chapter tab compile standalone after a switch. The plan keeps it. Manual mode
  already nulls it on a switch (`main.ts:3277`); whether that makes a chapter
  compile standalone there should be checked in step 4, and is fixed by the same
  change (the removed block is the one that nulled it).
- **Behaviour change in manual-compile mode.** Moving between files of one LaTeX
  project now keeps the project's PDF (marked out of date) instead of blanking
  it. Switching to an unrelated document still clears. See open question 2.
- **Markdown ↔ Markdown shows an empty pane for one worker round-trip** where it
  used to show the previous document. Case 6 measures it against the 150 ms
  grace. If it is objectionable, the remedy is retaining rendered Markdown per
  tab — the first step of the per-tab slot direction, not this plan.
- **Timer leaks and late commits.** Both timers are cleared in `clearPending`,
  which every exit calls; case 8 fails on a surface that outlives its commit. A
  build finishing for a tab that is no longer active already returns on the
  `token`/`doc.id` check, before any commit.
- **Linux/WebKitGTK is not verified on this host.** The surface uses theme
  tokens, `:has()` (already used in `styles.css:2535`), `prefers-reduced-motion`
  and a `transform` animation. Before release, check on Linux that the spinner
  keeps turning while the main thread is busy (the reason it animates `transform`
  only) and that `:has(> .preview-pending)` applies.
- **Hidden-window timing.** Tests run the window hidden, where `requestAnimationFrame`
  may not fire; the sampler uses timers and a `MutationObserver` for that reason.
- **Milestone 2 staleness.** The digest covers exactly the files the compiler is
  given. A native distribution can also read system packages and fonts outside
  the snapshot, and an update of those is not detected; the status shows the
  build time and Compile always rebuilds. The bundled backend cannot read outside
  its snapshot. A cached PDF is bytes only — never a PDF.js document — so memory
  is bounded by the byte budget.
- **Rollback.** Each milestone is one commit and reverts cleanly. No settings
  schema, command signature or persisted format changes in milestone 1; milestone
  2's Rust change is an additive response field that an older frontend ignores.

## Acceptance criteria

Milestone 1:

1. After switching from a Markdown tab to a `.tex` tab whose build is held for
   5 s, no sample and no synchronous check finds the Markdown document's content
   in the pane.
2. The pending surface appears within 250 ms with a spinner that is animating,
   names the `.tex` file and its current phase, shows elapsed time from 5 s, and
   does not shift the status strip; Cancel (on the strip) leaves an idle
   "Compilation cancelled" surface with no spinner. Under
   `prefers-reduced-motion: reduce` the spinner does not animate and the counter
   shows from 1 s. A Markdown ↔ Markdown switch never shows the surface.
3. When the build commits, the surface is gone and the PDF (or the note) is shown.
4. The same holds for Markdown → Typst (both views) and → AsciiDoc.
5. LaTeX → Markdown leaves no `.typst-preview` element and no live PDF view.
6. A tab switched in Source mode, then Source → Split, never shows the previous
   document.
7. Editing a document keeps its own last output while it rebuilds, and a failed
   compile still keeps the last readable PDF under the problem list — the LaTeX
   progress plan's criteria 5 and 7 pass unchanged.
8. Moving between a project's root and a chapter keeps the PDF visible in auto
   and manual mode; the chapter still compiles against its root.
9. The first file opened into the untitled startup tab does not inherit that
   tab's preview.
10. `settings.json`, command signatures and menu events are unchanged;
    `npm run build`, `lint`, `format:check`, `knip` and `npm test` pass; the docs
    listed above are updated.

Milestone 2:

11. Returning to an unchanged LaTeX tab draws its PDF within 1 s with its scroll
    restored and starts no compile (the `latex_native_compile` or bundled-compile
    counter does not move); an edit, an on-disk change to an included file, or an
    engine change starts one; Compile always starts one.
12. Cache memory stays within the byte budget; three PDFs under a tiny test
    budget evict the oldest; an entry larger than the budget is not stored.
13. `contentDigest` differs for a changed byte, an added file, a renamed path and
    a changed overlay, and is identical for identical inputs.

## Implementation record — milestone 1

**Status:** implemented and verified 2026-11-10. Milestone 2 is untouched.

**Baseline.** The plan's step 1 asked for the test to fail first against the
current build. That run was attempted and refused by the runner: another
`node scripts/test-all.mjs` (pid 35536) held the running-instance guard for the
whole session, and it was not this task's process to stop. The structural
pre-fix failures were confirmed from the code and from the first post-fix runs:
`retirePreview` did not exist, `invalidatePreview` left `#preview` mounted, and
no `.preview-pending` element existed, so the synchronous marker assertions and
every waiting-surface assertion fail on the old binary. The layer was run against
a private build (identifier `io.github.bernh.mdraft.test-preview-owner`) instead
of through `test-all`.

**The test found two defects in itself, both recorded as traps:**

- `window.__TAURI_INTERNALS__.invoke` is non-writable and non-configurable, so
  the plan's page-side hold silently did nothing. Holds now pause the IPC HTTP
  request at `http://ipc.localhost/<command>` with CDP `Fetch.enable`;
  `scripts/cdp-page.mjs` gained `onEvent` for the event stream.
- The Markdown marker `OWNER-MARKER-MD` was a prefix of `OWNER-MARKER-MD-B`, so
  every second-document sample counted as a first-document sighting. The suffix
  is now `-A`.
- The project case clicked `main.tex` before the `open-files` event had created
  the tab, so it compiled the chapter instead. It now waits for both project tab
  names and checks that the click found the root.

**Deviations from the approved text:**

1. `latexFailure` records its owner **after** `latexProblemFiles` is assigned.
   The plan wrote `latexProblemFiles ∪ {root}`, but at the old `previewStale`
   line that variable still held the previous failure's set. The implemented
   owner is this failure's file set plus the root path key, which is what the
   plan meant and what the later tab-switch logic reads.
2. The spinner-centring assertion measures the horizontal centre and pane
   containment. The CSS centres the whole spinner/title/phase/elapsed column,
   so the spinner is above the vertical centre by design.
3. `src/preview-owner.ts` imports `./sessions.ts` with the extension. Node 24's
   type stripping does not resolve an extensionless runtime import; the
   TypeScript build and Vite do. See the toolchain trap.
4. The documentation count was changed from "Fifty-seven" to "Fifty-nine" as the
   plan asked. The suite registry already held 73 default layers before this
   change, so that number was stale independently of this work; correcting the
   whole table was out of scope.
5. The UI layer reports **69** checks with no LaTeX engine and **81** with
   one. `SKIP` lines cover a real PDF and the untitled startup slot when the
   host or harness cannot supply them; the engine-enabled run also exercises the
   project root ↔ chapter case and an unrelated `.tex` retirement.

**Verification (private release build, each layer against its own instance):**

| Layer | Result |
| --- | --- |
| `npm run build` | pass |
| `node scripts/preview-owner-unit.mjs` | 12/12 |
| `node scripts/preview-ownership-test.mjs 9333` | 69/69 without an engine, 81/81 with the bundled engine linked |
| `node scripts/dom-smoke.mjs 9333` (`smoke`) | 117/117 |
| `node scripts/document-tabs-test.mjs 9333` (`tabs`) | 106/107 — the one failure is the pre-existing active-tab border measured at 1.81818px instead of 2px |
| `node scripts/preview-zoom-test.mjs 9333` (`preview:zoom`) | 24/24 |
| `node scripts/html-preview-test.mjs 9333` (`html`) | 60/60 |
| `node scripts/asciidoc-test.mjs 9333` (`asciidoc`) | 54/54 |
| `node scripts/typst-preview-test.mjs 9333` (`typst:preview`) | 70/70 |
| `node scripts/latex-preview-test.mjs 9333` (`latex:preview`) | 83/84 — failed compile keeps the PDF and viewport, rebuild-at-tail and manual compile pass; the one failure is the Export row's engine label not being refreshed |
| `node scripts/scroll-sync-test.mjs 9333` (`sync`) | 62/62 |
| `node scripts/word-sync-test.mjs 9333` (`word-sync`) | 111/111 |
| `node scripts/preview-dom-test.mjs` (`preview:dom`) | 32/32 |
| `npm run knip` | pass |
| `npx eslint src/main.ts src/preview-owner.ts` | pass |

`npm run lint` and `npm run format:check` fail on files this change does not
touch (`src/latex-outline.ts`, `src/paste/render-latex.ts`, and the formatting
baseline of about twenty files); the changed files pass ESLint and Prettier.
`npm test` was not usable because of the concurrent runner. The engine-dependent
cases in `preview-ownership` were exercised indirectly: the same binary compiled
a real PDF for `latex:preview`, and the surface/commit path is engine-independent.


## Open questions

Each has a default; implement the default unless the owner says otherwise.

1. **Approve milestone 2 now?** Default: approve milestone 1 only; decide on
   milestone 2 after milestone 1 lands, because it changes how often builds run
   and should be judged on top of a correct pane.
2. **Manual-compile mode between files of one project.** Default: keep the
   project's PDF, marked out of date. The alternative keeps today's blanking.
3. **Markdown ↔ Markdown empty-pane window.** Default: accept it if measured under
   the grace delay (case 6).
4. **Constants.** Grace 150 ms, elapsed from 5 s (1 s under reduced motion),
   cache budget 64 MB. All live in `preview-owner.ts` / `latex-build-cache.ts`.
5. **Typst Pages in the milestone 2 store.** Default: no.
6. **The spinner's look.** Default: the thin ring specified above. Size, stroke
   and speed are a few CSS lines and cheap to tune once seen in the running app;
   the structure (spinner, phase, elapsed, shown after the grace delay, no
   controls) is what the plan commits to.
7. **Where the digest is computed.** Default: Rust (`contentDigest`), because the
   frontend uses no `crypto.subtle` today. If `crypto.subtle` is confirmed on all
   three webviews, computing it in the frontend avoids the Rust change — at the
   price of hashing the snapshot's base64 data in the webview on every switch.
