# Native print and direct PDF with visual quality gates

**Status:** done — implementation, automated PDF validation and the real Debian
desktop print-dialog check are complete.
**Date:** 2026-10-25
**ADR:** [Print through a script-free hidden webview, keeping the browser handoff](../adr/2026-10-25-native-print-surface.md)

## Context and goal

**File › Print** does not exist, and **File › Export › PDF (Print)** writes a
print-ready HTML document, opens the system browser and asks the reader to save
the PDF there. GAP-026 already fixed the hard part of that artifact: local
images and links resolve, the page is light, the print wrapper waits for fonts
and images and names failures, and the standalone typography uses the chosen
faces. The conversion/export pipeline has been validated typographically
(mathematics, images, tables, colours, fonts); this plan must **not** rebuild
it.

What is missing is the **native output path** and proof that the generated PDF
is as good as the preview:

- Windows WebView2 exposes `ICoreWebView2_16::ShowPrintUI` and
  `ICoreWebView2_7::PrintToPdf`. The current `window.print()` limitation is
  real, but it is not the host API's limitation.
- Linux WebKitGTK exposes `WebKitPrintOperation` with a native dialog and a
  silent print path.
- Tauri 2.12 exposes the platform webview through
  `PlatformWebview::controller()/environment()` on Windows and
  `PlatformWebview::inner()` on Linux, so both APIs are reachable without
  replacing the webview.
- The current browser handoff remains the fallback when the host cannot print
  or when a document uses content a safe print surface must not execute.

The goal is a native **File › Print…** dialog and a direct **File › Export ›
PDF…** that write the same article the preview shows, plus an automated visual
harness that renders the actual PDF pages and checks the graphical result on
**Windows and Debian in WSL2**.

## Scope and non-scope

**In scope**

- A hidden, non-interactive print surface that loads the GAP-026 article with
  no application IPC capability and no document scripts. It is used for both
  the native print dialog and direct PDF writing.
- Windows WebView2 `ShowPrintUI` and `PrintToPdf`, A4 settings, backgrounds on,
  completion/error reporting and cleanup.
- Linux WebKitGTK `PrintOperation`: native print dialog and direct PDF using
  GTK print settings/output URI, with a browser fallback if the installed
  WebKitGTK cannot write the file.
- Markdown, AsciiDoc and **static** HTML documents. An HTML document whose
  print copy depends on scripts keeps the existing browser handoff and says so;
  see the security boundary below.
- `File › Print…` with `Ctrl+P`, and `File › Export › PDF…` as a direct file
  writer. The existing browser PDF path remains available as a fallback/second
  route so a host without native printing is never a dead end.
- After-export options only when a direct PDF file was actually written.
  The native print dialog has no known output path and does not run them.
- A PDF visual harness using Poppler (`pdfinfo`, `pdftoppm`, `pdffonts`,
  `pdftotext`, `pdfimages`) and page PNGs at 150 dpi, plus structural pixel
  metrics. It is app-free and can run on Windows and inside Debian/WSL2.
- Visual validation matrix and artifacts for Windows and Debian/WSL2.

**Non-scope**

- Typst native printing. A `.typ` document keeps **PDF (via Typst)**, which
  already compiles a PDF directly; Print for Typst is not part of this slice.
- HTML documents whose print output needs scripts. They keep the browser print
  path; a sandboxed script-capable native surface is a separate security
  decision.
- Changing the GAP-026 article, typography, KaTeX, Mermaid, image or export
  conversion (already validated).
- GAP-033 offline KaTeX/fonts: the print page may still request the CDN.
- GAP-008 Quick Open's shortcut decision beyond choosing `Ctrl+P` for Print.
- macOS (not published), PDF editing, printer-specific drivers.
- New Preferences options for print margins/orientation in this slice. A4,
  light theme and the article's `@page` rules are fixed and validated.
- A pixel-perfect cross-platform golden image. Fonts and rasterizers differ;
  per-platform structural metrics plus human-reviewed page PNGs are the gate.

## Approach and rejected alternatives

### 1. One print artifact, two host paths

`buildExportArticle`/`wrapPrintHtml` stay the single source of the printed
article. Add a native variant of the wrapper that:

- keeps the exact same body HTML, typography CSS, image URLs and token colours;
- does **not** auto-call `window.print()` on load (the host triggers printing);
- exposes a small host-injected readiness check (fonts/images) instead;
- removes document scripts; generated Markdown/AsciiDoc articles have none
  after the renderer, and static HTML is printed as static content.

The direct PDF and the print dialog use the same HTML. `File › Print…` only
changes the host call; it does not re-render the document with different CSS.

### 2. Hidden print surface, no IPC

Create a Tauri `WebviewWindow` once per print job:

- label `print`, `visible(false)`, `focused(false)`, `skipTaskbar(true)`,
  `decorations(false)`, A4-ish size (794 × 1123 CSS px);
- initial URL `about:blank`; the platform code replaces its content with the
  print HTML via `ICoreWebView2::NavigateToString` (Windows) or
  `webkit_web_view_load_html(html, base)` (Linux);
- **no capability entry for the `print` window**, so even if the content
  somehow reached the Tauri IPC bridge, no command is authorized. The main
  window keeps its capabilities;
- no user scripts: the HTML source copy has every `<script>` removed; the
  generated article contains none. Inline styles, images, KaTeX CSS and Mermaid
  SVG are allowed;
- no navigation away from the prepared document; the window is closed after
  the print operation or on cancellation.

The print window exists only for the duration of one operation. A second print
request while one is active is refused or queued with a visible message, not
allowed to overwrite the first.

### 3. Readiness without relying on page scripts

After `load`/`NavigationCompleted`, the host injects a readiness expression
through the platform API (`ExecuteScript` on Windows, `evaluate_javascript` on
Linux):

```js
Promise.all([
  document.fonts.ready,
  ...Array.from(document.images).map(img =>
    img.complete ? Promise.resolve()
      : new Promise(resolve => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        })
  )
]).then(() => Array.from(document.images)
  .filter(img => !img.complete || img.naturalWidth === 0)
  .map(img => img.getAttribute('src') || img.src));
```

The host waits (bounded to 10 s) for the expression, records failed image URLs,
and proceeds. This is the same contract as `src/print-ready.ts`, but the host
owns the trigger and no page script can run. If the expression cannot run, the
operation fails with a message and offers the browser path; it never prints a
blank page silently.

### 4. Platform calls

**Windows (WebView2)**

- `controller.CoreWebView2()` from `PlatformWebview::controller()`.
- `PrintToPdf` lives on `ICoreWebView2_7`, not `_16`; `ShowPrintUI` lives on
  `ICoreWebView2_16`. Cast each separately and report the runtime version when
  either query fails.
- `PrintToPdf(path, settings, handler)`; create settings from the environment
  (`ICoreWebView2Environment6::CreatePrintSettings`), A4, margins 0 (the article
  carries its own `@page` margins), `ShouldPrintBackgrounds(true)`, scale 1.
- Wait for the completed handler; success must mean the file exists and is not
  empty. Report the exact path.
- `ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM)` for the native dialog.
  Keep the hidden webview alive while the dialog is open; close it on
  completion/cancel. If the host cannot show the system dialog, fall back to
  the browser path with a clear explanation.
- If the system dialog does not surface from a fully hidden window, position
  the print window off the work area instead of making it visible in front of
  the editor; record which behaviour the installed runtime exhibits.

**Linux (WebKitGTK)**

- `PlatformWebview::inner()` gives the `webkit2gtk::WebView`.
- `WebKitPrintOperation::new(&webview)`.
- **Print dialog:** set A4 `PageSetup`, call `run_dialog(Some(main_window))`;
  close the hidden webview after `Print` or `Cancel`.
- **Direct PDF:** set a `gtk::PrintSettings` with
  `GTK_PRINT_SETTINGS_OUTPUT_URI = file:///…`,
  `GTK_PRINT_SETTINGS_OUTPUT_FILE_FORMAT = "pdf"`, call `print()`, then verify
  the file. If the installed WebKitGTK/GTK ignores the output settings, report
  the limitation and use the browser fallback; do not claim a PDF was written.
- Job cleanup must run on the GTK main thread, including when the dialog is
  cancelled.

### 5. Menu and shell behaviour

- `file.print` (`Ctrl+P`): native dialog; if unavailable, offer the browser
  print document (existing GAP-026 path).
- `export.pdf` (direct PDF): save dialog with `.pdf`, then native writer; if
  the host cannot write, offer browser print as fallback. It runs the global
  After Export actions only after a real file is written.
- Move today's browser handoff to an explicit **PDF (opens browser)…** route
  (`export.pdf.browser`) for HTML documents and as the fallback. It is the
  current path, not a dead menu item. Because `export.pdf` currently means the
  browser route, update `scripts/export-browser-test.mjs` to drive
  `export.pdf.browser`, and update the `export.pdf` label assertion in
  `scripts/menu-test.mjs` in the same change.
- `Ctrl+P` is assigned to Print. GAP-008's Quick Open must choose another
  accelerator; this plan records the decision. `scripts/shortcut-test.mjs`
  must assert `Ctrl+P` is registered and that emitting `file.print` reaches
  the print route.
- Availability by language: `file.print` and direct `export.pdf` are enabled
  for Markdown, AsciiDoc and HTML; a script-dependent HTML document uses the
  browser fallback. For a Typst document both rows are disabled with a label
  that names **Export › PDF (via Typst)…**, which is the existing direct PDF
  compiler. `scripts/menu-test.mjs` must assert that availability, not only the
  row's existence, and no row may be present but inert.
- `File › Print…` and direct PDF capture the document identity/text before the
  picker or any await, exactly as the other exports do.

### 6. Visual quality harness

A new app-free script, `scripts/pdf-visual-check.mjs`, takes one or more PDFs
and an output directory. It uses Poppler tools and never ships in the app:

- `pdfinfo`: page count, A4 page size (595.28 × 841.89 pt, tolerance), title.
- `pdffonts`: every used font embedded (`emb = yes`), including the body,
  monospace and KaTeX faces.
- `pdftotext -layout`: headings, table cells, prose and math-adjacent text are
  selectable; no replacement characters or literal delimiters where rendered
  math is expected.
- `pdfimages -list`: fixture images are present with sensible dimensions.
- `pdftoppm -r 150 -png`: one PNG per page for human review.
- `pdftoppm -r 150` PPM (default PPM) for dependency-free pixel metrics in
  Node: page dimensions, blank-page ratio, outer-margin purity, expected image
  colours, table-line density, dark-pixel density in the formula region, and
  light/dark diagram check.
- The script prints `PASS`/`FAIL` lines and exits non-zero on a failed metric.
  It accepts `--out <dir>` and `--rasterizer native|wsl`; Poppler on `PATH` is
  the default, `wsl -e` is the Windows fallback when Poppler is installed in
  the WSL distro. Missing tools are reported as a skip/failure, never a silent
  pass.

Visual tests are **not** a byte-for-byte cross-platform golden comparison:
font hinting and Poppler/WebKit rendering differ. They assert the structural
and graphical properties above and leave the page PNGs for visual review.
An optional per-platform baseline can be added later with a tolerance; it is
not a prerequisite for this slice.

### Rejected alternatives

- *Print the main application webview.* It contains chrome, sidebar and status
  bar, and it may be in Source-only where the article is not rendered.
- *Call `window.print()` in the hidden webview.* WebView2's own print UI is the
  host API; `window.print()` is the known no-op trap.
- *Keep the browser handoff as the only path.* It cannot produce a known output
  path, cannot run after-export actions, and is the limitation GAP-009 exists to
  remove.
- *Load the print HTML in the main webview.* Document scripts would run with the
  app's IPC and UI.
- *Use a script-capable hidden Tauri webview.* HTML source would run arbitrary
  scripts and could reach local files; a no-capability window is necessary but
  not sufficient. Strip scripts and keep dynamic HTML on the browser path.
- *Reuse pandoc/Typst to produce the print PDF.* It changes the article and
  loses the preview's fidelity, exactly what GAP-026 fixed.
- *Use screenshot-only evidence.* A screenshot of the app is not the PDF; the
  delivered artifact must be rasterized and measured.

## Steps

- [x] Write the ADR for the print surface (hidden window, no IPC, no scripts,
  browser fallback) and get approval.
- [x] Add the Rust print module: job state, hidden window lifecycle, readiness
  injection, error propagation, cleanup on every path.
- [x] Windows: implement `NavigateToString`, readiness, `PrintToPdf` with A4
  settings and `ShowPrintUI`; add tests for settings/cleanup where possible.
- [x] Linux: implement `load_html`, readiness, `PrintOperation` dialog and
  output-URI PDF; verify the installed GTK/WebKitGTK behaviour; fallback.
  **Deviation:** both hosts load a per-operation temporary HTML file rather than
  `NavigateToString`/`load_html`, because the article's absolute `file://`
  images need a real file base.
- [x] Add `wrapNativePrintHtml` (no auto-print, scripts removed) and a
  script-free static HTML print copy; dynamic HTML keeps the browser route.
- [x] Add `file.print`, `export.pdf` direct and `export.pdf.browser` fallback;
  `Ctrl+P`; save picker; after-export only on a written PDF; error messages.
- [x] Update the route assertions: `scripts/export-browser-test.mjs` drives the
  explicit browser id, `scripts/menu-test.mjs` expects the new Print/PDF labels,
  and `scripts/shortcut-test.mjs` covers `Ctrl+P`.
- [x] Build the visual fixture and `samples/pdf-quality.*` (image with known
  colours, table, code, quote, math, Mermaid, enough content for two pages).
- [x] Add `scripts/pdf-visual-check.mjs` and a Windows UI suite that exports a
  real PDF through the app, then invokes the checker.
- [x] Register the UI/visual layers, document Poppler/WSL requirements, and add
  the AGENTS entries.
- [x] Validate Windows: direct PDF, visual metrics, page PNG review, multi-page,
  dark theme, high DPI; the native print dialog window was observed, but the
  system dialog cannot be screenshotted while the session is locked.
- [x] Validate Debian/WSL2: WebKitGTK PDF through the same print settings,
  Poppler rasterization/page review, A4 margins, embedded fonts and a two-page
  article. The native GTK dialog was confirmed on a real Debian desktop on
  2026-10-25; WSLg could not focus or dismiss it from this session, so the
  dialog part was checked on the desktop and the PDF part on both.
- [x] Update `docs/export.md`, `docs/guide.md`, README, backlog and AGENTS.

## Files and modules

| File | Why it must change |
| --- | --- |
| `src-tauri/src/print.rs` (new) | Hidden print window, job lifecycle, readiness, platform calls, cleanup |
| `src-tauri/src/lib.rs` | Register commands/state and the hidden-window lifecycle |
| `src-tauri/Cargo.toml` | Windows `webview2-com`/`windows` features; Linux `webkit2gtk`/`gtk` direct dependencies |
| `src-tauri/capabilities/` | A print-window capability with no permissions, or no matching capability at all |
| `src-tauri/src/menu.rs` | Print/PDF items, labels, availability, `Ctrl+P` |
| `src-tauri/src/export.rs` | Keep the browser print helper; expose shared print-article helpers if needed |
| `src/markdown.ts` | Native print wrapper/readiness and script stripping; keep GAP-026 export CSS |
| `src/html-preview.ts` | Static HTML print copy path; dynamic fallback detection |
| `src/main.ts`, `src/api.ts` | Print/direct PDF commands, source snapshot, picker, fallback, after-export |
| `scripts/pdf-visual-check.mjs` | Poppler-based PDF page and pixel checks |
| `scripts/pdf-native-test.mjs` | Real-UI direct PDF generation on Windows |
| `samples/pdf-quality.*` | Stable fixture with image/table/code/math/Mermaid/pages |
| `scripts/export-browser-test.mjs`, `menu-test.mjs`, `shortcut-test.mjs` | Route/label/accelerator assertions for the split PDF menu |
| `scripts/test-all.mjs`, `package.json`, `AGENTS.md` | Register the layers and prerequisites |
| `docs/export.md`, `docs/guide.md`, `README.md`, `docs/backlog.md` | Reader claims, limitations, status |

## Risks and rollback

- **WebView2 interface version.** `ICoreWebView2_16` must exist on the runtime;
  if the cast fails, report the runtime version and use the browser fallback.
  Do not lower the app's minimum WebView2 version silently.
- **Native dialog lifetime.** `ShowPrintUI`/GTK dialogs can outlive the
  command. Keep the hidden window alive until completion/cancel and close it
  in a `finally`-style path; a leaked hidden window is a bug, not cosmetic.
- **Security.** A hidden Tauri webview still has the Tauri bridge injected.
  A no-permission capability is mandatory, and scripts are stripped. HTML that
  needs scripts never reaches the native surface. This is the boundary the ADR
  records.
- **Linux/WSLg.** The published Linux build is WebKitGTK, not Chromium. WSLg can
  show a white WebKit pane or refuse focus (AGENTS trap); launch with
  `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1`, `GDK_BACKEND=x11` and
  `WEBKIT_DISABLE_COMPOSITING_MODE=1` for diagnostics, and use a real Debian
  desktop for the visual print acceptance if WSLg cannot drive the dialog.
  Do not read a white pane as a print bug.
- **A4/margins.** WebView2 print settings and the article's `@page` can both
  contribute margins. Choose one source of truth (host margins zero, CSS
  `@page` 18/16 mm), verify the PDF page geometry, and document the choice.
- **PDF sharpness.** WebView2 `PrintToPdf` and WebKit print must produce vector
  text and embedded images; the rasterizer at 150 dpi is the proof. Do not
  accept a screenshot-scaled raster or a canvas-only page.
- **Poppler availability.** The visual checker needs test-only Poppler tools.
  It is not an app dependency; missing tools fail with a named prerequisite,
  not a green skip. On Windows, WSL Debian is the fallback rasterizer.
- **Large documents.** The hidden webview holds the full article; enforce the
  existing export size/recovery boundaries and report failure rather than
  hanging. The print job has a timeout.
- **Rollback.** `File › Print…` and direct PDF can be removed; the GAP-026
  browser path remains untouched and the existing `export.pdf` name can point
  back to it. The hidden window and platform deps are additive.

## Tests and validation

### Layers

- Rust unit: job state, A4 print settings values, path/cleanup, unsupported
  platform fallback, timeout, no IPC capability assumption is documented.
- Windows UI (`pdf-native-test.mjs`): stub the save picker, emit `export.pdf`,
  wait for the direct file, assert `%PDF-`, size, page count via the visual
  checker; emit `file.print` and assert the native dialog path is requested
  (manual dialog dismissal).
- PDF visual checker: app-free, uses Poppler, runs against a real generated PDF.
- Existing: `export`, `export:browser` (updated to the explicit browser id),
  `menu` (updated labels), `shortcuts` (updated for `Ctrl+P`), `smoke`,
  `asciidoc`, `html`, `word-sync`, `typst:preview` and `tabs` stay green.
  Check-count changes are recorded in AGENTS and the README, as usual.
- Manual Linux: Debian/WSL2 with WebKitGTK; print dialog, direct PDF, visual
  page review.

### Visual matrix

| Fixture/scenario | PDF check | Expected |
| --- | --- | --- |
| Markdown article, light theme | `pdfinfo`, `pdftoppm -r 150 -png` | A4; ≥2 pages; no blank/clipped page |
| Same, dark editor | page PNG + background pixels | PDF is light; Mermaid/token colours are the light palette |
| Local image with known colours | PPM pixel search + `pdfimages -list` | Image present at expected size/colours; not a broken placeholder |
| Table | PPM line runs + `pdftotext` cells | Borders and every cell visible; no split row clipped |
| KaTeX fraction/radical/display math | PPM region density + page PNG | Fraction bar/radical visible; no collapsed math; text selectable |
| Mermaid diagram | PPM colour/region check | Diagram present, light theme, no dark background |
| Long fixture | `pdfinfo` + all page PNGs | Page breaks, no blank last page, headings not stranded |
| AsciiDoc equivalent | same | AsciiDoc tables/images/math/callout match the article |
| Static HTML with CSS/image | same | Local resources loaded; scripts stripped; no chrome |
| Script-dependent HTML | UI + fallback | Browser path offered; no native script execution |
| Typst document | `menu` probe | Print/direct PDF disabled with the Typst PDF reason |
| 150%/300% app zoom | page geometry | PDF page size/margins unchanged by view zoom |
| Windows high-DPI | page PNG/geometry | Same A4 page, sharp text/PDF, no double scaling |
| Debian/WSL2 | same | WebKitGTK output matches the article; Poppler checks pass |
| Direct PDF vs Print dialog | page PNG/metrics | Same article and page structure; print dialog is manual |
| After Export | filesystem | Runs only for direct PDF with a known path |

### Commands and artifacts

```text
pdfinfo file.pdf
pdffonts file.pdf
pdftotext -layout file.pdf -
pdfimages -list file.pdf
pdftoppm -r 150 -png file.pdf page
pdftoppm -r 150 file.pdf page   # PPM for Node pixel metrics
node scripts/pdf-visual-check.mjs --pdf file.pdf --out page-dir --fixture quality
```

On Windows without Poppler:

```text
wsl -e pdftoppm -r 150 -png /mnt/c/path/file.pdf /mnt/c/path/page
```

`scripts/pdf-visual-check.mjs` therefore has to translate `C:\…` to `/mnt/c/…`
for every WSL invocation, keep Windows paths in the report, and fail with the
install command (`apt install poppler-utils`) when no rasterizer answers.
Poppler is a test prerequisite only; it is never bundled or called by the app.

Poppler/WSL instructions belong in AGENTS and `docs/export.md`.

**The measurement that proves it works:** the direct PDF and the print-dialog
PDF are rasterized to page PNGs; A4 geometry, embedded fonts, selectable text,
image colours, table lines, math density and light Mermaid colours all pass,
and a second page is non-blank. The page PNGs are attached/reviewed, not just
counted.

## Acceptance criteria

- **File › Print…** opens a real native print dialog on Windows and Linux for
  Markdown and AsciiDoc, printing the same article the preview shows; the
  browser is not involved when the host supports native printing.
- **File › Export › PDF…** writes a PDF at the chosen path with selectable
  text, embedded fonts, images, tables, fractions/radicals and a light Mermaid
  diagram, at A4, with no blank or clipped pages.
- A static HTML document prints natively; a script-dependent HTML document
  explains and uses the browser route instead of executing its scripts in a
  Tauri surface.
- Typst documents do not offer an inert Print/direct-PDF row: both name
  **PDF (via Typst)** and stay disabled, because that route already compiles a
  PDF.
- If native printing is unavailable or fails, the command offers the existing
  browser path and never silently does nothing.
- After Export runs only when a direct PDF was actually written; the print
  dialog does not claim a path.
- The visual harness produces page PNGs and passes the structural metrics on
  Windows and Debian/WSL2; the pages are reviewed for graphical quality.
- `npm run export`, `export:browser`, `menu`, `shortcuts`, `smoke`,
  `asciidoc`, `html`, `word-sync`, `typst:preview` and `tabs` stay green.
- The app does not depend on Poppler; only the visual test layer does.
- No HTML scripts run in the native print window; no print window has app IPC
  permissions.

## Open questions

- **HTML dynamic content.** Default: static HTML native, scripts stripped;
  script-dependent HTML stays browser. A script-capable sandboxed print surface
  is a separate security decision, not a silent extension of this plan.
- **Linux WSLg versus a real Debian desktop.** Default: build and run the PDF
  checks in WSL2; use a real Debian desktop (or a functional WSLg session) for
  the print-dialog gesture if the WebKit surface cannot be focused. Do not
  weaken the sandbox just to make WSLg interactive.
- **`Ctrl+P`.** Default: Print owns it; Quick Open (GAP-008) uses another
  accelerator. This is the joint decision the backlog asked for.
- **Browser PDF menu.** Default: keep an explicit **PDF (opens browser)**
  entry for HTML/fallback; the native direct PDF is the primary Export PDF
  entry.
- **Poppler baseline.** Default: structural metrics plus human page review;
  optional per-platform golden PNGs later, not a first-slice gate.
- **A4/margins.** Default: A4 with the article's `@page` margins; host print
  settings use zero margins and backgrounds on. Confirm on both platforms and
  record the measured geometry.
