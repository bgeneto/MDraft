# Working preview zoom and zoom-only reset

**Status:** in progress — implementation and Windows validation complete;
WebKitGTK/high-DPI inspection remains
**Date:** 2026-10-25
**ADR:** [`../adr/2026-10-25-document-zoom-model.md`](../adr/2026-10-25-document-zoom-model.md)

## Context and goal

`View › Editor Text Size` currently changes `editorFontSize` by one pixel per
command. That has three visible problems:

- In Preview-only the editor is hidden, so zoom does nothing at all.
- In Split only the source pane grows; the rendered document keeps its size.
- The menu is disabled in Preview-only (`enabled_for` returns false for
  `view.zoomIn/Out/Reset`), even though the command is named Zoom and the status
  chip shows a percentage.

The reset path already leaves Content Width (`editorMaxWidth`) alone — the
comment in `view.zoomReset` says so explicitly — and that behaviour must stay.
What is missing is a real view-zoom state that the rendered document can use.
The goal is one persisted zoom percentage that scales the active reading or
writing surface: the editor in Source-only, both panes in Split, and the
rendered document in Preview-only. It must work for Markdown, AsciiDoc, Typst
Document, the sandboxed HTML guest and Typst Pages, and reset must change only
zoom.

The backlog (GAP-019) asks for this in explicit renderer increments. This plan
ships the shared state, the DOM renderers, the HTML guest and Typst Pages
together, because a global shortcut that silently ignores the visible renderer
is exactly the inconsistency the item exists to remove.

## Scope and non-scope

**In scope**

- A persisted `zoomLevel` setting: 50–300 %, default 100 %, 10 % steps.
  It is additive; an older `settings.json` without it loads with 100.
- One **document zoom**, not one per pane:
  - Source-only: the editor text and its line height scale.
  - Split: the editor and the preview both scale by the same percentage.
  - Preview-only: the rendered document scales; the hidden editor's base font
    is irrelevant.
- Preview zoom for:
  - Markdown, AsciiDoc and Typst Document, through the shared DOM article;
  - the sandboxed HTML guest iframe;
  - Typst Pages, including sharp canvas re-rastering and horizontal scrolling
    when the page is wider than the pane.
- Menu wording and enablement: `Zoom`, `Zoom In`, `Zoom Out`, `Reset Zoom`,
  enabled in every view mode.
- Status chip: percentage of the current zoom, hidden at 100 %, click resets.
- Reset that changes only `zoomLevel`; Content Width and the base editor/preview
  font sizes stay as the reader set them.
- Tests at the pure/settings, Rust menu and real-UI layers, including a zoomed
  word-sync interaction and a 150 % screenshot.

**Non-scope**

- Per-pane independent zoom (two states, two chips, two shortcuts). Rejected in
  the approach section.
- Changing Content Width, the Preferences "Editor font size"/"Preview font size"
  rows, or adding a new Preferences row for zoom.
- Browser-style whole-application zoom (`webview.setZoom`), which would scale
  the chrome, menus and dialogs rather than the document.
- Zoom affecting exports or print. Exports keep their own typography settings
  and the print page its fixed page size.
- Typst Pages toolbar, page navigation and fit modes (GAP-016).
- Touch pinch gestures, per-document zoom, or remembering a zoom per tab.
- GAP-009 native printing.

## Approach and rejected alternatives

**Chosen model: one persisted document zoom multiplier, applied by each
renderer.**

1. **Settings.** Add `zoomLevel: u32` to `Settings` with a default of 100 and
   `#[serde(default)]`. `api.Settings` mirrors it. Existing files load; no
   migration is needed. The base `editorFontSize` and `bodyFontSize` remain the
   reader's *base* choices. On upgrade, a user whose old zoom commands changed
   `editorFontSize` keeps that value as their base size; the chip is hidden at
   100 %, and they can change the base in Preferences. This is a semantic
   change, not data loss, and is recorded in the plan.

2. **Core state and commands.** Add `MIN_ZOOM = 50`, `MAX_ZOOM = 300`,
   `ZOOM_STEP = 10`, and `setZoom(level)` in `main.ts`:
   - clamp and round to the step;
   - update `settings.zoomLevel`;
   - `applyLayout()` (which applies editor and preview scaling);
   - `persist()`;
   - toast `Zoom 110%`.
   `view.zoomIn/Out` call `setZoom(settings.zoomLevel ± 10)`;
   `view.zoomReset` sets 100 and touches nothing else. The status chip click and
   the keyboard accelerators use the same functions.
   `updateZoomIndicator` reads `zoomLevel`; title/aria say "Zoom", not "Font
   size", and it hides only at 100 %.

3. **Editor.** `applyLayout` calls
   `editor?.setFontSize(settings.editorFontSize * zoom)`. CodeMirror's line
   height is a unitless multiplier (`--editor-line-height`), so it follows the
   font size. In Source-only this is the whole effect; in Split it keeps the
   source comparable to the preview.

4. **DOM preview.** The shared `#preview.markdown-body` gets:
   ```css
   zoom: var(--preview-zoom, 1);
   width: calc(100% / var(--preview-zoom, 1));
   max-width: calc(var(--editor-max-width, 100%) / var(--preview-zoom, 1));
   ```
   `applyLayout` sets `--preview-zoom` from `zoomLevel` and changes the full
   Content Width value from `none` to `100%` so the division is always valid
   (the rendered result is the same). The width compensation is what keeps
   text wrapping inside the pane instead of producing a horizontal scrollbar.
   CSS `zoom` scales text, images, SVG/Mermaid, KaTeX, tables and code as one
   layout, and `getBoundingClientRect` — which the scroll/word sync uses —
   reports the scaled geometry.
   `Typst Pages` has its own rule that cancels this DOM zoom and delegates the
   scale to the PDF view.

5. **HTML guest.** The iframe is a sibling of `#preview` and owns its pane. Set
   `zoom: var(--preview-zoom)` on `.html-preview-frame` and compensate its
   width/height with `calc(100% / var(--preview-zoom))`; `inset: 0` keeps it
   anchored. The guest's CSS viewport becomes narrower, so its own layout
   reflows, and the frame is then scaled to the pane. Guest→source selection
   already travels as text offsets, not screen coordinates; scroll anchors are
   computed in guest coordinates; the existing HTML sync is preserved.

6. **Typst Pages.** `TypstPdfPreview` receives the current zoom:
   - `fit = (available / maxPageWidth) * zoom`;
   - `--typst-fit` keeps the page shell and the text layer in sync;
   - `paint` already renders at `max(1, fit)`, so a 150 % page is re-rastered
     sharper instead of merely stretched;
   - horizontal scrolling is enabled only above 100 % (`overflow-x: auto` plus
     `margin-inline: auto` on the shells, so a smaller page still centres and a
     wider one can be scrolled from its left edge);
   - `setZoom` preserves the reader's position by scaling `scrollTop` with the
     fit ratio after layout;
   - the view bar stays at 100 % and is not part of the zoomed content.
   A newly rendered PDF receives the current zoom when its view is created.

7. **Menu and docs.** Rename the submenu `Editor Text Size` to `Zoom` and its
   rows to `Zoom In`, `Zoom Out`, `Reset Zoom`; keep the existing ids and
   accelerators so user key habits and the accelerator registry do not move.
   Enable the items in every view mode. Update the built-in shortcut table
   (`src/content.ts`), the guide and the README.
   The status chip title/aria and toast use "Zoom".

**Rejected alternatives**

- *Keep changing `editorFontSize` and add a preview-only size.* Two independent
  values, two notions of "100 %", and a chip that cannot describe both. The
  reader would have to reset each one separately.
- *Use `transform: scale()` on the article.* A transform does not change layout
  height, so the preview's scrollbar and `scrollTop`/sync math would disagree
  with what is on screen; a zoomed article would be clipped or unreachable.
- *Scale only `font-size`.* Text would grow but images, Mermaid SVG, tables'
  borders and PDF pages would not; the preview would look inconsistent.
- *Call the native webview zoom.* It scales the whole application surface,
  including menus, dialogs and the sidebar, and cannot give the preview its own
  pane policy.
- *Re-render Markdown/AsciiDoc at a different font size.* It would invalidate
  the source map and KaTeX/Mermaid caches on every step for no benefit over
  CSS zoom.
- *Per-pane zoom in Split.* It needs a focus rule ("which pane does Ctrl+= hit?")
  and two chips; the resulting view is harder to explain than one document
  zoom.

## Steps

- [x] Settings: add `zoomLevel` (default 100) to Rust and `api.ts`; add the
      settings round-trip/old-file test.
- [x] Core: constants, `setZoom`, `updateZoomIndicator`, `applyLayout`
      editor/preview scaling, chip click, toast.
- [x] Menu: labels, enablement in Preview-only, id stability; update the Rust
      `enabled_for` test that expected `view.zoomIn` disabled.
- [x] CSS: `--preview-zoom`, `--preview-max-width`, width/max-width
      compensation, Pages exclusion, HTML iframe zoom.
- [x] Typst Pages: zoom-aware fit, sharp paint, horizontal scroll, position
      preservation, current zoom on a new render.
- [x] Docs: `src/content.ts`, `docs/guide.md`, `README.md`, AGENTS counts and the
      shortcut table.
- [x] New `scripts/preview-zoom-test.mjs` and its `test-all`/`package.json`
      registration; update the layer count.
- [x] Tests: Markdown/Split/Preview-only, AsciiDoc, Typst Document, HTML guest,
      Typst Pages, reset/content-width, zoomed word sync, 150 % screenshot.
- [x] Regression: `smoke`, `word-sync`, `html`, `typst:preview`, `asciidoc`,
      `shortcuts`, `menu`, `tabs`, `build`, `lint`, `knip`.
- [ ] Manual: WebKitGTK/Linux `zoom` support, high-DPI, PDF sharpness at 150 %,
      and a screenshot at 100/150 %. *The 150 % screenshot is captured by the
      suite; the visual check on Linux remains for the owner.*

## Files and modules

| File | Why it must change |
| --- | --- |
| `src-tauri/src/settings.rs` | `zoomLevel` field, default and old-file test |
| `src/api.ts` | `zoomLevel` in `Settings` |
| `src/main.ts` | Zoom state, editor multiplier, status chip, menu handlers, reset |
| `src/styles.css` | Preview width compensation, HTML iframe zoom, Pages horizontal scroll |
| `src/typst-pdf.ts` | Zoom-aware fit, paint scale, scroll preservation |
| `src-tauri/src/menu.rs` | Labels and enablement; test update |
| `src/content.ts`, `docs/guide.md`, `README.md` | Reader-facing shortcut/zoom wording |
| `scripts/preview-zoom-test.mjs` | Real-UI coverage across renderers |
| `scripts/typst-preview-test.mjs` | The reference view switch waits for content and uses the menu after the view bar moved outside `#preview` |
| `scripts/test-all.mjs`, `package.json`, `AGENTS.md` | Register the layer and counts |

## Risks and rollback

- **CSS `zoom` on WebKitGTK.** Chromium supports it; WebKitGTK's support must be
  proved on the published Linux build. If it is absent or wrong, fall back to a
  transform plus an explicit measured wrapper height for the DOM article, and
  record the limitation. Do not silently ship a zoom that only works on
  Windows.
- **Geometry and sync.** Width compensation changes line wrapping; the
  data-line anchors and `getBoundingClientRect` mapping must stay aligned.
  Zoomed word sync is an explicit test, not an assumption.
- **PDF memory and sharpness.** The fit multiplier feeds `paint`; the existing
  `MAX_CANVAS_PIXELS` cap still bounds memory. At 300 % a page may hit the cap;
  the text layer stays sharp, and the plan records the raster limit.
- **Horizontal scroll in Pages.** Allowing `overflow-x` only above 100 % avoids
  a permanent scrollbar at fit-to-pane. The shells' auto margins must centre at
  100 % and not clip the left edge when wider.
- **Settings semantics.** Existing users' zoomed `editorFontSize` becomes their
  base size. The chip hides at 100 %; Preferences still edits the base. This is
  documented and reversible by changing the base.
- **Menu/test drift.** The submenu id stays, but the label changes; tests that
  locate the menu by label or assume zoom is disabled in Preview-only must be
  updated. Keep the accelerator registry unchanged.
- **Concurrent menu work.** The working tree is currently being reorganised in
  `menu.rs`, `main.ts`, `content.ts` and `tabs.ts`. Land this after that work (or
  rebase onto it) and change only the zoom labels/enablement; do not duplicate
  menu ids, reorder unrelated submenus or rewrite the new tab-menu tests.
- **Export/print.** Neither reads `zoomLevel`; the export typography remains
  `bodyFontSize` and the print page remains A4. A regression test asserts the
  export's `--body-size` is unaffected.
- **Rollback.** `zoomLevel` is additive and defaults to 100; removing the CSS
  property and the multiplier returns the current behavior without touching
  documents or Content Width.

## Tests and validation

- **Pure/settings:** old `settings.json` without `zoomLevel` loads at 100; a
  save round-trips 150; clamp at 50/300; step rounding.
- **Rust menu:** `view.zoomIn/Out/Reset` are enabled in source, split and
  preview modes; labels are the new ones; accelerators unchanged.
- **New UI suite** (`preview-zoom-test.mjs`):
  - Source-only: Ctrl+Shift+= raises the editor's computed size; the preview is
    hidden; the chip reads 110 %.
  - Split with Markdown: editor and preview both grow; the article's
    `scrollWidth <= clientWidth` (no horizontal overflow); a paragraph and a
    local image grow by the same factor; Content Width is unchanged.
  - Preview-only: the rendered text and image grow; Ctrl+Shift+0 restores 100 %,
    hides the chip and leaves Content Width untouched.
  - AsciiDoc and Typst Document: the same preview geometry checks.
  - HTML guest: the iframe's computed zoom and its internal viewport width
    change while its rendered rect still fills the pane; selection/sync still
    reaches the source.
  - Typst Pages: page shell width/height and canvas backing size grow; the page
    is horizontally scrollable above 100 %; the same page stays in view; a text
    click still maps to the source line.
  - A zoomed double-click/word selection still paints the source.
  - Screenshot at 150 % for visual proof.
- **Existing layers:** `shortcut-test` (accelerator/chip), `smoke` (layout and
  content width), `word-sync`, `html`, `typst:preview`, `asciidoc`, `tabs`.
- `npm run build`, `npm run lint`, `npm run format:check` on touched files,
  `npm run knip`, `cargo clippy --all-targets -- -D warnings`.
- **The measurement that proves it works:** the bounding box of a known
  paragraph/image/PDF page at 150 % is 1.5× its 100 % box, while
  `--editor-max-width` is byte-identical and the status chip reads `150%`.

## Acceptance criteria

- In Preview-only, `Ctrl+Shift+=` visibly enlarges rendered text and images;
  `Ctrl+Shift+-` reduces them; `Ctrl+Shift+0` returns to 100 %.
- In Split, the documented policy is visible: both panes scale by the same
  percentage, line wrapping stays inside each pane, selection and source/preview
  sync remain usable, and no horizontal scrollbar appears in the DOM preview.
- The reset changes zoom only: Content Width and the base editor/preview font
  sizes are unchanged.
- The chip shows the current percentage, hides at 100 %, and its title/aria and
  the menu use "Zoom"; the zoom items are enabled in Preview-only.
- HTML guest and Typst Pages scale with the same shortcut; Pages is sharp,
  horizontally scrollable above 100 %, and keeps its scroll/page position.
- The zoom survives a restart through `settings.json`; an old settings file
  without the field loads at 100 %.
- Exports and print do not inherit the zoom.
- The existing smoke, word-sync, HTML, AsciiDoc, Typst Pages and shortcut layers
  stay green.

## Validation record

Implemented on Windows on 2026-10-25.

| Layer | Result |
| --- | --- |
| `npm test -- --only preview-zoom` | **24/24** |
| `cargo test --manifest-path src-tauri/Cargo.toml` | **140 passed**, 0 failed, 2 ignored downloads |
| `cargo clippy --all-targets -- -D warnings` | clean |
| `npm test -- --only menu` | 87/87 |
| `npm test -- --only shortcuts` | 43/43 |
| `npm test -- --only smoke` | 108/108 |
| `npm test -- --only word-sync` | 58/58 |
| `npm test -- --only html` | 60/60 |
| `npm test -- --only asciidoc` | 54/54 |
| `npm test -- --only tabs` | 107/107 |
| `npm test -- --only typst-preview` | 52/52 (the optional local physics exam ran) |
| `npm run build`, `npm run lint`, `npm run knip` | PASS |
| Prettier on the files this plan touched | PASS |

**The measurement that proves it works:** the new suite measures a paragraph,
local image and PDF page at 100 % and 150 % with `getBoundingClientRect`; the
150 % boxes grow by the zoom factor, the status chip reads `150%`, and
`--editor-max-width` is identical before and after reset. A real double-click on
a zoomed preview word still paints `.cm-sync-word`. The 150 % screenshot is
written by the suite.

**Deviations and remaining verification.**

- CSS zoom does not change a percentage `width` the way a naive division
  predicts: with `zoom: z`, `width: 100%` already fills the pane. The DOM article
  therefore uses `width: 100%` and a separate `--preview-max-width` layout cap
  divided by the zoom; the HTML iframe uses the same `100%` width. The plan's
  earlier formula was corrected during implementation.
- The zoom is on `#preview`, not every `.markdown-body`: Typst's Document host
  also carries that class, and zooming both would double-scale the document.
  `.markdown-body.typst-document` explicitly drops its second max-width.
- The Typst Document/Pages switch moved outside `#preview`; otherwise the buttons
  would scale with the document. `doRender` removes the previous bar before each
  render. The Typst reference test now switches via the native menu because a
  stale bar can outlive a tab change for one frame; the bar itself remains
  covered by the existing style and button checks.
- The menu labels/enablement and the `menu-test` zoom assertions were already
  present in the concurrent menu-reorganization work; this plan supplied the
  state and rendering they assert.
- Manual WebKitGTK/Linux support, high-DPI and PDF sharpness at 150 % remain for
  the owner. The repository-wide `npm run format:check`, `npm run lint` and
  `npm run knip` pass on the current tree; every file changed here is included.

## Open questions

- **Step size.** Default 10 % per command, clamped to 50–300 %. Five percent is
  finer but doubles the keystrokes; one pixel (the old behavior) is not a
  percentage the chip can explain.
- **Persistence scope.** Default global, like the other view preferences, not
  per document or per tab. A per-document zoom would need a session field and a
  rule for restored tabs; it is not worth the extra state yet.
- **Full-width Content Width.** The implementation keeps `--editor-max-width`
  as `none` for the editor and adds `--preview-max-width` for the zoomed article:
  the cap is a layout length, so it is divided by the zoom while `width: 100%`
  fills the pane. This avoids changing the meaning of the editor variable.
- **View bar.** The Typst Document/Pages switch moved outside `#preview`, so
  document zoom cannot scale its buttons; the reference test uses the native menu
  to switch views because a stale bar can outlive a tab change for one frame.
- **Pages horizontal policy.** Default scale the page and allow horizontal
  scrolling above 100 %, rather than re-fitting the page to the pane (which
  would not make the text larger). Record the choice in the guide.
