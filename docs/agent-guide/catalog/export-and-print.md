# Export and print scripts

Pandoc export, the browser-readable HTML and print artifacts, and the native PDF
writers on Windows and Linux. A change to `src-tauri/src/print.rs`, the export
commands or the print document belongs here.

The traps are in [../traps/export-and-print.md](../traps/export-and-print.md);
the reader-facing detail is `docs/export.md`.

## npm entry points

| Command | Runs | Does |
| --- | --- | --- |
| `npm run export` | `scripts/export-test.mjs` | 75 checks of every export path, against real pandoc, including an AsciiDoc source, the rendered-HTML math reader, the LaTeX reader, the on-demand writer list, a LaTeX snapshot converted to DOCX/HTML/Markdown (unsaved chapter, embedded image, rewritten Markdown link), an unsafe writer id, the `pdf` writer refused in favour of the compiled route, a citation-data writer's explanation, output/source collision refusal, a snapshot entry escaping its root, the math and code scale variables in the print document, and the Export preferences section printing no install path while offering one folder button per tool |
| `npm run export:paths:unit` | `scripts/export-paths-unit.mjs` | 44 checks of the browser path/URL policy: drive, UNC, POSIX, spaces, Unicode, `..`, different roots, fragments, `data:`, `file:` and protocol-relative addresses — no application |
| `npm run export:browser` | `scripts/export-browser-test.mjs` | 24 checks of the native HTML and Print artifacts through the real UI: restored local images/links, absolute print URLs, the readiness/failure script, the exported alert colours, and the same light diagram palette in a dark and a light editor |
| `npm run pdf:native` | `scripts/pdf-native-test.mjs` | 21 checks of real PDF output, static HTML, active/encoded-child fallbacks, native script blocking, queued-job ownership and existing-target preservation, plus Poppler page checks. `MDRAFT_PDF_KEEP=1` retains evidence; `MDRAFT_PDF_RASTERIZER=wsl` selects WSL |
| `npm run pdf:visual` | `scripts/pdf-visual-check.mjs` | App-free PDF measurement: A4 geometry, embedded fonts, selectable text, rasterized page PNGs, ink, image colours, table rules and margins |

## Test harnesses

Every harness here needs the app already running with CDP enabled (see
[../testing.md](../testing.md#running-the-cdp-tests-correctly)) **and the right
document loaded**. The port is always `argv[2]` and defaults to `9222`.

| Script | Arguments | Needs this document | Proves |
| --- | --- | --- | --- |
| `export-test.mjs` | `[port] [--install]` | `samples/feature-tour.md` | Real export bytes, including two simultaneous Typst/Pandoc exports while a preview is cancelled. `--install` additionally downloads pandoc |
| `export-paths-unit.mjs` | — | none — runs without the application | Drive, UNC and POSIX path resolution, relative URLs across one root, `file://` encoding, and the publication policy for spaces, Unicode, `..`, fragments, `data:`, `file:` and protocol-relative references |
| `export-browser-test.mjs` | `[port]` | `samples/export-tour.md`; opens `samples/export-tour.adoc` | That an exported HTML page and the captured print document have real local image/link destinations, no `asset:` URLs, absolute `file://` print images, the font/image readiness script, the exported alert tint, and the same light Mermaid palette whatever the editor theme |
| `pdf-native-test.mjs` | `[port]` | `samples/pdf-quality.md` | The real direct-PDF path: save picker stubbed, `PrintToPdf` writes the file, Poppler checks its pages, static HTML prints natively, and scripted HTML stays on the browser route |
| `pdf-visual-check.mjs` | `--pdf <file> [--out <dir>] [--fixture quality] [--rasterizer auto\|native\|wsl] [--expect <text>]` | any PDF | A4 geometry, embedded fonts, selectable text, one PNG/PPM per page, non-blank pages, quiet margins, image colours, table rules and math ink. Needs Poppler on `PATH` or in WSL; no application |

## Build and environment helpers

| Script | Arguments | Does |
| --- | --- | --- |
    [Releasing](../releasing.md).

## Testing layers

These rows are part of the ordered layer table; the full order and what the
runner does around them are in [../testing.md](../testing.md).

| Layer | Command | Count | Catches |
| --- | --- | --- | --- |
| Export paths (unit) | `npm run export:paths:unit` | 44 | Drive, UNC and POSIX paths, spaces, Unicode, `..`, different roots, encoded spaces, fragments, `data:`, `file:` and protocol-relative references — no application |
| Browser exports | `npm run export:browser` | 24 | Native HTML and Print artifacts: local image/link resolution, no app protocol, absolute print URLs, the resource-wait/failure script, the exported alert tint, and a light print diagram in a dark editor |
| Native PDF | `npm run pdf:native` | 21 | A real direct PDF from Markdown, static HTML through the same writer, scripted HTML kept on the browser route, and the Poppler visual metrics |
| PDF visual (app-free) | `npm run pdf:visual -- --pdf <file> --fixture quality` | 36 | A4 geometry, embedded fonts, selectable text, one PNG/PPM per page, non-blank pages, quiet margins, known image colours, table rules and mathematics ink |
