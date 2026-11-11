# A preview that knows it is current: no rebuild without a changed input

**Status:** done — approved 2026-11-11; phases 0–3 implemented
**Date:** 2026-11-11
**ADR:** `../adr/2026-11-11-preview-freshness-key.md`, written in phase 1.
Supersedes milestone 2 of
[2026-11-10-preview-pane-ownership.md](2026-11-10-preview-pane-ownership.md)
(not started there; its Rust `contentDigest` field turns out to be unnecessary,
see *Context*).

## Context and goal

**Symptoms.**

1. Return to an unchanged `.tex` or `.typ` tab → full recompile (seconds for
   LaTeX, a whole compiler process for Typst).
2. Toggle the theme on a `.tex` tab → full LaTeX recompile. On an `.html` tab →
   the guest iframe is rebuilt and its scripts restart.
3. Returning to an unchanged Markdown/AsciiDoc tab → worker conversion, KaTeX,
   mermaid and DOM insertion all run again.

**Causes, read from the code** (baseline `a373712` plus the working tree):

- **No freshness key exists.** The only "is this output still current?" check
  in the app is `lastTypstRender` (`renderTypstPreview`, `main.ts:2998`), and it
  is per active tab only. `renderLatexPreview` (`main.ts:2657`) has no
  short-circuit at all: every call snapshots and compiles.
- **Tab switch throws everything away.** `displayDoc` → `invalidatePreview()`
  (`main.ts:3804`) sets `lastTypstRender = null`, `previewStale = true`, and —
  because the new tab is not covered by the old owner — `retirePreview()`
  disposes the PDF view. Then `scheduleRender(true)` rebuilds from nothing.
  Nothing is retained per session.
- **Theme is wired as a render input when it is not one.** `setTheme`
  (`main.ts:1143`) and the system-theme watcher (`installSystemThemeWatcher`,
  `main.ts:8648`) call `scheduleRender(true)`. But:
  - PDFs (LaTeX, Typst Pages) go dark through a CSS filter
    (`styles.css:2570`, `[data-theme="dark"] .typst-page canvas`); the bytes do
    not depend on the theme.
  - Code highlighting is a swapped stylesheet (`applyHighlightTheme`).
  - The HTML guest renders the document's own styles.
  - The **only** theme-dependent output is mermaid SVG (`renderMermaidIn(…,
    isDark)`), in Markdown and AsciiDoc.
  Typst is spared by `lastTypstRender`; LaTeX and HTML are not.
- **Two more false render triggers** in `applySettingsPatch`
  (`main.ts:1165`): `syntaxTheme` is the editor palette (`applySyntaxTheme`) and
  `editorMaxWidth` is a CSS width; neither changes any preview's content, yet
  both send a `.tex` tab through a full compile.
- **The LaTeX content key already exists and is ignored.**
  `latex_project_snapshot` returns `generation`: SHA-256 over every file the
  compile reads (path + SHA-256 of its bytes, open buffers overlaid) plus the
  local-library revision (`collect_referenced`, `latex.rs:1203`; `latex.rs:1268`).
  It is the exact compile input. Nothing in `src/` reads it. So the earlier
  plan's proposed Rust change is not needed.

**Goal.** Every preview commit records a **freshness key** — a value derived
only from what the output actually depends on. A render request whose wanted key
equals the key on screen (or in the cache) does no work. Theme, palette and width
changes never compile anything. Returning to an unchanged tab is a reattach
(phase 3) or at worst a PDF draw (phase 2), never a build.

**Targets** (measured by the phase-1 test, release build, the two sample
documents):

| Action | Today | Target |
| --- | --- | --- |
| Theme toggle on `.tex` / `.typ` / `.html` | full compile / iframe reload | 0 compiles, < 16 ms (one frame) |
| Theme toggle on `.md` with mermaid | full render | mermaid blocks only |
| Return to unchanged `.tex` | full compile | P2: snapshot + PDF draw, < 250 ms; P3: < 30 ms |
| Return to unchanged `.typ` | compiler process | P2: no process; P3: < 30 ms |
| Return to unchanged `.md` / `.adoc` | worker + KaTeX + mermaid | P3: < 30 ms, 0 worker messages |

## Scope and non-scope

**In scope.**

- Phase 0: remove the false render triggers (theme, system theme, syntax
  palette, editor width).
- Phase 1: the freshness key — a pure module, one key per language, recorded at
  every commit, consulted by `doRender`. Replaces `lastTypstRender`.
- Phase 2: a bounded in-memory store of compiled PDFs (LaTeX, Typst Pages)
  across tabs, keyed by freshness key.
- Phase 3: retained preview slots — the last N tabs keep their committed DOM /
  PDF view detached and are reattached on return.
- Tests that count compiles, plus docs, ADR and traps.

**Not in scope** (each is a separate plan if wanted — see *Open questions*):

- Persisting any cache to disk; everything dies with the window.
- Retaining HTML iframes across a switch (moving an iframe reloads it; keeping a
  hidden one alive keeps foreign scripts running). HTML gets the key-based skip
  only.
- Moving LaTeX snapshot bytes out of the JSON IPC path, and an in-process
  incremental Typst compiler (listed under *Open questions* as follow-ups).
- Any `settings.json`, menu event or `#[tauri::command]` change in phases 0–3,
  except the Typst dependency question below.

## Approach and rejected alternatives

**Chosen.** Treat "is the preview current?" as data, not as a side effect of
`renderToken`. A pure `src/preview-freshness.ts` exports
`wantedKey(language, inputs)` per language:

| Language | Key inputs | Not inputs |
| --- | --- | --- |
| LaTeX | `snapshot.generation`, backend, native engine + distribution, WASM engine version | theme, palette, width, view mode |
| Typst | source text hash, `typstView`, image root, dependency fingerprint (see *Open questions*) | theme, palette, width |
| Markdown | revision + incarnation, `enableMath`, `enableMermaid`, `documentPath`/`baseDir`, image root, `wantsMap` | theme (mermaid re-theme only) |
| AsciiDoc | same as Markdown | same |
| HTML | revision + incarnation, `htmlPreviewScripts`, base dir, image root | theme |

`commitPreview(owner)` takes the key too and records it on the slot. `doRender`
computes the wanted key first and returns early on a match — for LaTeX after the
snapshot, since disk files are inputs and only the snapshot can see them.
Theme becomes its own narrow path: `retheme()` re-renders mermaid blocks in place
and does nothing else.

The store (phase 2) is `Map<key, CompiledPdf>` with LRU eviction by bytes:
`{ pdf: Uint8Array, warnings, sources, files, engine, elapsedMs, compiledAt }` —
everything `renderLatexPreview` needs after its compile step, so a hit runs the
existing "render PDF + commit" tail unchanged.

The slots (phase 3) hold `{ owner, key, root: HTMLElement, pdf?: TypstPdfPreview,
blocks/fragments, scroll }` for the most recent N sessions. On return with a
matching key the pane swaps children, rebinds the word map from the kept
blocks, rebuilds anchors (layout-dependent, cheap) and restores scroll.

**Rejected.**

1. **Key on `doc.revision` alone.** Wrong for LaTeX and Typst: an included
   chapter, a `.bib` or an image changes on disk without touching the tab's
   revision. The LaTeX `generation` key exists precisely for that.
2. **Cache PDF bytes only, no freshness key** (old milestone 2). Fixes the tab
   return but not the theme/width/palette rebuilds, and leaves `lastTypstRender`
   as a second, inconsistent mechanism.
3. **Full per-tab preview panes (every tab keeps a live pane forever).** Instant,
   but unbounded memory (PDF canvases are tens of MB) and every hidden pane keeps
   observers alive. Phase 3 bounds it to N slots with PDF.js page canvases
   released on detach.
4. **Skip the LaTeX snapshot on return and trust a file-watcher.** Saves one IPC
   round trip but a missed watch event means a stale PDF presented as current —
   violates *fail safe, not silent*. The snapshot is the source of truth; its
   cost is addressed separately (follow-up 1).

## Steps

### Phase 0 — stop rebuilding for things that are not inputs (no new module)

- [x] Test first: `scripts/preview-freshness-test.mjs` (layer
      `preview-freshness`). Against the pre-change binary it failed 6 of 9:
      `.tex` theme toggle `latex_engine_status +2`, `.typ` `render_typst +1`,
      `.html` `set_html_preview +3`, palette `+4`, width `+2`, Markdown DOM
      rebuilt.
- [x] `setTheme` and `installSystemThemeWatcher`: replace `scheduleRender(true)`
      with `retheme()`.
- [x] `retheme()`: for Markdown/AsciiDoc, re-run `renderMermaidIn(preview,
      isDark)` over `.mermaid[data-mermaid]` (`mermaidCache` was already keyed
      by theme); then `rebuildAnchors()` + sync. Nothing for LaTeX, Typst, HTML.
      *Deviation:* `renderMermaidIn` gained an optional `cancelled` callback, and
      a `themeEpoch` stops a pass started under the previous theme from
      painting (or caching) over the new one; an AsciiDoc build that straddles a
      theme change re-themes after its commit.
- [x] `applySettingsPatch`: drop `syntaxTheme` from `affectsRendering`; move
      `editorMaxWidth` to a layout-only path. *Deviation:* `rebuildAnchors()` is
      not needed — anchors read live offsets, as zoom already relies on — so
      the path is `syncPreviewFromSource()` on the next frame.

### Phase 1 — the freshness key

- [x] `src/preview-freshness.ts` (pure, no DOM): the key functions above. Keys
      are strings, so no `sameKey` is needed. Unit layer
      `scripts/preview-freshness-unit.mjs` (`preview-freshness-unit`, 9 checks):
      each input changes the key, an undone edit keeps it. Non-inputs have no
      parameter, so the type signature is the check.
      *Deviation:* Markdown, AsciiDoc and HTML key on a 64-bit text fingerprint,
      not the revision, so an edit undone before the debounce matches. Typst
      keeps the revision (open question 1) and gains the path — a Save As moves
      it without a new incarnation, which `lastTypstRender` had missed.
- [x] `commitPreview(owner, key)`: records `committedKey`; successful builds
      pass their key, every other commit (failure, note, partial PDF) clears it,
      as do `retirePreview`, an HTML guest reset and `latexFailure`.
- [x] `doRender`: compute the wanted key; on a match under a covering owner,
      rebind the word map from the kept fragments/blocks (`proseMap`), redraw
      diagrams a cancelled pass left, re-anchor, sync, commit.
- [x] LaTeX: after `latexProjectSnapshot`, build the key from
      `snapshot.generation` + engine identity; `rebindLatexPreview` hands the
      PDF to the new token, rebinds the active chapter (`setActiveFile`) and
      restores warnings and the status ("Up to date · <engine>"). The PDF view's
      `onReady` now reads the committed token, so a map that finishes after a
      rebind still syncs.
- [x] Typst: `lastTypstRender` keeps its `syncReady`/`blocks` behaviour but
      matches on `key` and on `committedKey`. *Deviation:* the
      `lastTypstRender = null` in `invalidatePreview` stays — removing it buys
      nothing before phase 2's store, and it keeps a covered invalidation
      conservative. Compile forces by clearing `committedKey`.
- [x] Explicit Compile always compiles (LaTeX and Typst clear `committedKey`);
      engine and library invalidation do the same.
- [x] `preview.dataset.compileCount`, incremented where a LaTeX (native or
      bundled) or Typst compiler is started. *Deviation:* no
      `dataset.previewKey`; the tests count compiles and IPC requests instead.

### Phase 2 — compiled-output store across tabs

- [x] `src/preview-store.ts`: LRU by bytes, default budget 96 MB, one entry
      larger than half the budget is not stored. Pure; `preview-store-unit`
      (10 checks).
- [x] LaTeX success path stores the `LatexResult` under its key (bytes: PDF +
      log + sources as UTF-16); a snapshot whose key hits the store runs the
      existing PDF render + commit tail and the status reads "Up to date ·
      <engine>". *Deviation:* no "compiled HH:MM" — the toolbar's engine chip
      already shows the build time.
- [x] Typst stores the whole `RenderedTypst` (Pages PDF or Document HTML/CSS),
      so a hit skips only the compiler process and the existing tail rebuilds
      the DOM. *Deviation (open question 1, default taken):* a source that
      imports, includes or reads any file (`image(`, `read(`, data loaders,
      `bibliography(`, `plugin(`) is never stored; no Rust change.
- [x] Failures are not stored. `invalidateLatexBuild` (engine changes),
      `latexLibrariesChanged`, Clear Cache and `typstSetup` clear the
      stores.
- [x] Open question 2, default taken: in manual-compile mode a tab return
      (an immediate render, never an edit) probes the store; a hit shows the
      PDF as "Up to date", a miss keeps the idle "select Compile" surface. The
      LaTeX probe (`renderLatexPreview(..., { storeOnly: true })`) takes a
      snapshot and never compiles or reports a failure.

### Phase 3 — retained slots for instant returns

- [x] `PreviewSlot` in `main.ts`: the article DOM (moved into a detached
      holder), the PDF view and its token/base64, `proseMap`,
      `lastTypstRender`, `previewLinesMapped`, scroll, and for LaTeX the
      tab's `latexPreview`. `invalidatePreview` parks the outgoing preview
      (`parkPreview`) before retiring; at most 3 slots, oldest disposed.
      Only content with a committed key is parked, and never HTML (moving an
      iframe reloads it; a hidden guest would keep running scripts).
- [x] `displayDoc` restores the slot for this exact incarnation and language
      (`restorePreview`), at its own scroll position, before the normal
      render. *Deviation:* the slot is not matched by key at restore time; the
      render that follows compares keys as always and only rebinds — or, if an
      input changed while away, rebuilds over it as same-owner
      stale-while-revalidate. For LaTeX the restore also brings back the tab's
      `latexPreview` and `latexNavigationRoot`, so a project compiled in
      between cannot become this tab's root.
- [x] `TypstPdfPreview.park()`: detached, no fit observation, no scroll
      restore, map build stopped. *Deviation:* canvases are released by the
      page IntersectionObserver, which unpaints every page once the host
      leaves the document; no explicit release code was needed.
      `activate()` re-observes and refits.
- [x] Typst's reuse path redraws its toolbar from the kept result
      (`showTypstChrome`), because a retirement resets it; the issues/CSS code
      is shared with the compile path (`showTypstIssues`).
- [x] ADR `../adr/2026-11-11-retained-preview-slots.md`; the ownership ADR is
      left as written — its owner rule still decides what may be shown.

### Closing

- [x] `preview-freshness-test.mjs` and the two unit layers are in
      `test-all.mjs`, `docs/agent-guide/testing.md` and the catalog.
- [x] Trap entries: the theme recompile (preview-and-sync) and the settle race
      in the new suite (test-harness).
- [x] `docs/latex.md` describes skipped builds and that Compile always builds.
- [x] `scroll-sync-test.mjs` no longer assumes Source → Split rebuilds an
      unchanged HTML guest; it follows whichever guest is active.

## Files and modules

- `src/main.ts` — `setTheme`, `installSystemThemeWatcher`, `applySettingsPatch`,
  `doRender`, `renderLatexPreview`, `renderTypstPreview`, `commitPreview`,
  `invalidatePreview`, `retirePreview`, `displayDoc`, `compileCurrentDocument`.
- `src/preview-freshness.ts` (new) — key functions.
- `src/preview-store.ts` (new) — byte-bounded LRU.
- `src/preview-owner.ts` — owner gains the key (or a sibling type).
- `src/markdown.ts` — mermaid re-theme entry, cache keyed by theme.
- `src/typst-pdf.ts` — detach/attach that releases canvases (phase 3).
- `scripts/preview-freshness-test.mjs`, `scripts/preview-freshness-unit.mjs`,
  `scripts/test-all.mjs` — tests.
- Docs: this plan, the ADR, `testing.md`, catalog row,
  `traps/preview-and-sync.md`, `docs/latex.md`.
- **No Rust** in phases 0–3 (LaTeX uses the existing `generation`). The Typst
  dependency fingerprint is the one possible exception — see *Open questions*.

## Risks and rollback

- **Stale output presented as current** — the one failure that matters. Mitigated
  by keying LaTeX on the snapshot's content digest, never on revisions, and by
  Compile always forcing. A missed Typst dependency is the highest residual risk.
- **Memory** — bounded by the 96 MB store and N = 3 slots; detached canvases
  released. Measure with the `pdf-memory` style probe on the sample documents.
- **Scroll / word-map regressions on reattach** — the existing sync suites must
  stay green; anchors are always rebuilt after attach.
- **Rollback** — each phase is one commit; phase 0 alone already removes the
  worst rebuilds and can ship independently. Reverting phase 2/3 falls back to
  phase 1 behaviour.

## Tests and validation

- Unit (app-free, Node 24): key inputs/non-inputs; LRU eviction by bytes.
- New CDP layer `preview-freshness-test.mjs`, reading `dataset.compileCount`:
  1. theme toggle on `.tex`, `.typ`, `.html` → count unchanged, HTML guest not
     reloaded;
  2. `.tex` → `.md` → `.tex` with nothing changed → count unchanged;
  3. same, but an `\input` chapter edited on disk while away → count + 1;
  4. Compile pressed on an unchanged doc → count + 1;
  5. syntax palette / editor width change → count unchanged.
- Existing layers touched: preview ownership, LaTeX progress (criteria 5 and 7),
  Typst, sync scroll, word sync. Run them, not the whole `npm test` per edit.
- One measurement: `preview.dataset.latexMs`-style timing of a tab return on
  `docs/sample-files`, before/after, in the release build.

## Acceptance criteria

- Toggling the theme on any tab starts no compiler and reloads no iframe;
  `compileCount` is unchanged.
- Changing the syntax palette or editor width starts no compiler.
- Returning to an unchanged `.tex` tab shows its PDF without a compile, and the
  status says it is up to date.
- Returning after an included file changed on disk recompiles.
- Pressing Compile always compiles.
- After phase 3, returning to an unchanged Markdown tab sends no worker message.

## Open questions

1. **Typst disk dependencies.** Today's `lastTypstRender` already ignores files
   a `.typ` imports, which phase 1 would carry across tabs. Default: have
   `render_typst` pass `--deps <tmp> --deps-format json` (Typst ≥ 0.14; we ship
   0.15.1) and return a fingerprint of those files (path + mtime + size) as an
   additive field; until then, a Typst document whose source contains
   `#import`/`#include`/`image(`/`read(` is not served from the cross-tab
   store. This is an additive command change — approve or decline.
2. **Manual-compile mode returning to a tab.** The previous plan excluded
   showing a cached PDF without Compile. With a content key the cached PDF *is*
   current. Default: show it, labelled "Up to date".
3. **Follow-up plans, not in this one** (offered separately):
   - LaTeX snapshot transport: every compile base64-encodes every project file
     (images included) into JSON for the webview, and the native path sends them
     back. A Rust-held snapshot handle (native) and raw `ArrayBuffer` IPC (WASM)
     remove that copy — a contract change.
   - Typst in-process incremental compilation (the `typst` crate with `comemo`)
     instead of a process per compile — large dependency, conflicts with the
     binary-size plan.
4. **Budgets.** Default 96 MB store, N = 3 slots. Adjust after the memory
   measurement.
