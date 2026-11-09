# Repository scripts

Everything in `scripts/` is documented, and **if you add a script, add it to
one of the catalogs in the same change** — an undocumented script is one the
next agent will rewrite from scratch. This page is the index; the full rows
live in [catalog/](catalog/).

## Where a command is documented

| Subject | Catalog | Covers |
| --- | --- | --- |
| Build, staging, version, landing page | [catalog/build-and-site.md](catalog/build-and-site.md) | `dist`, `stage`, `check:version`, `build-linux.sh`, `with-msvc.cmd`, `cargo-vcvars.cmd`, `build-icons.mjs`, `subset-fonts.py`, `fetch-fonts.ps1`, `site*` |
| Editor, documents, chrome | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) | `smoke` is not here; `tabs`, `favorites`, `menu`, `shortcuts`, `paste`, `image:*`, `links`, `format:document`, `p0:*`, `sessions`, `filename:unit`, `autoclose*`, `completion:unit`, `recent`, `typewriter`, `single:instance`, `close-test-window.ps1`, `test-close.ps1` |
| Preview, sync, performance | [catalog/preview-and-sync.md](catalog/preview-and-sync.md) | `smoke`, `sync*`, `word-sync`, `preview:*`, `typst:preview`, `math`, `syntax`, `audit`, `set-palette.mjs`, `screenshot.mjs` |
| LaTeX, Typst, AsciiDoc | [catalog/latex-and-formats.md](catalog/latex-and-formats.md) | `latex:*`, `completion:latex:unit`, `asciidoc*` |
| Export and print | [catalog/export-and-print.md](catalog/export-and-print.md) | `export*`, `pdf:*` |
| AI, Read Aloud, typography | [catalog/ai-accessibility-and-typography.md](catalog/ai-accessibility-and-typography.md) | `ai*`, `read-aloud*`, `typography*`, `licence` |

The layer order and what the runner does around the suites are in
[testing.md](testing.md).

### Conventions for new test scripts

The existing scripts share a shape because it makes failures legible. Follow it:

- **Take the CDP port as `argv[2]`, defaulting to `9222`.** Never hard-code it.
- **`Runtime.enable` first**, and **throw on `result.exceptionDetails`**. A
  rejected promise in the page arrives as a *successful* CDP response with the
  error inside; ignoring it turns failures into passes.
- **Print one line per assertion** as `  PASS  <what was measured>` or the same
  with `FAIL`, and end with `N/M checks passed`. The counts are quoted in this
  file and in the README, so they are a contract.
- **Exit non-zero when any check fails**, so the script composes with `&&`.
- **Measure something a person could see.** Geometry, computed colours, scroll
  positions. See [What the assertions are worth](testing.md#what-the-assertions-are-worth).
- **Never inline a snippet with `node -e`.** PowerShell's nested quoting broke
  this repeatedly; every non-trivial script lives in `scripts/`.
