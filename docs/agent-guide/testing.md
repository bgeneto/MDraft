# Testing

The test strategy: which layers exist, the order `npm test` runs them in,
how to drive a UI suite against a running application, and what an assertion
is worth. The per-layer descriptions live in the subject catalogs.

Related: [scripts.md](scripts.md) for every command,
[catalog/](catalog/) for the layer descriptions, [traps.md](traps.md) for
the failures these suites keep rediscovering.

## The order layers run in

Eighty-two default layers, cheapest first, plus opt-in layers. Run them in this
order when changing anything. Each row links to the catalog file that carries
its full description; the table is in run order, and the catalog file groups
the same rows by subject.

| Layer | Command | Described in |
| --- | --- | --- |
| Typecheck | `npm run build` | [catalog/build-and-site.md](catalog/build-and-site.md) |
| Rust unit | `npm run test:rust` | [catalog/build-and-site.md](catalog/build-and-site.md) |
| Spelling corpus (unit) | `npm run spellcheck:unit` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| Session store | `npm run test:sessions` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| P0 data safety (unit) | `npm run p0:unit` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| File name suggestions (unit) | `npm run filename:unit` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| Paste conversion | `npm run paste:convert` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| AsciiDoc export source | `npm run asciidoc:export:unit` | [catalog/latex-and-formats.md](catalog/latex-and-formats.md) |
| Preview pipeline (unit) | `npm run preview:unit` | [catalog/preview-and-sync.md](catalog/preview-and-sync.md) |
| Preview worker ownership | `npm run preview:worker:unit` | [catalog/preview-and-sync.md](catalog/preview-and-sync.md) |
| Preview ownership (unit) | `npm run preview-owner:unit` | [catalog/preview-and-sync.md](catalog/preview-and-sync.md) |
| Preview DOM and security | `npm run preview:dom` | [catalog/preview-and-sync.md](catalog/preview-and-sync.md) |
| Export paths (unit) | `npm run export:paths:unit` | [catalog/export-and-print.md](catalog/export-and-print.md) |
| Browser exports | `npm run export:browser` | [catalog/export-and-print.md](catalog/export-and-print.md) |
| Native PDF | `npm run pdf:native` | [catalog/export-and-print.md](catalog/export-and-print.md) |
| PDF visual (app-free) | `npm run pdf:visual -- --pdf <file> --fixture quality` | [catalog/export-and-print.md](catalog/export-and-print.md) |
| DOM smoke | `npm run smoke` | [catalog/preview-and-sync.md](catalog/preview-and-sync.md) |
| Content scroll (unit) | `npm run sync:unit` | [catalog/preview-and-sync.md](catalog/preview-and-sync.md) |
| Content scroll | `npm run sync` | [catalog/preview-and-sync.md](catalog/preview-and-sync.md) |
| P0 lifecycle (UI) | `npm run p0:lifecycle` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| Second launch | `npm run single:instance` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| Document zoom | `npm run preview:zoom` | [catalog/preview-and-sync.md](catalog/preview-and-sync.md) |
| Preview pane ownership | `npm test -- --only preview-ownership` | [catalog/preview-and-sync.md](catalog/preview-and-sync.md) |
| Preview freshness (unit) | `npm run preview-freshness:unit` | [catalog/preview-and-sync.md](catalog/preview-and-sync.md) |
| Preview output store (unit) | `npm run preview-store:unit` | [catalog/preview-and-sync.md](catalog/preview-and-sync.md) |
| Preview freshness | `npm test -- --only preview-freshness` | [catalog/preview-and-sync.md](catalog/preview-and-sync.md) |
| Preview performance | `npm run preview:perf` | [catalog/preview-and-sync.md](catalog/preview-and-sync.md) |
| Typewriter | `npm run typewriter` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| Word sync | `npm run word-sync` | [catalog/preview-and-sync.md](catalog/preview-and-sync.md) |
| Auto-close matching | `npm run autoclose:unit` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| Completion layer (unit) | `npm run completion:unit` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| Emmet abbreviations (unit) | `npm run emmet:unit` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| LaTeX completion (unit) | `npm run completion:latex:unit` | [catalog/latex-and-formats.md](catalog/latex-and-formats.md) |
| Local TEXMF libraries (unit) | `npm run latex:texmf:unit` | [catalog/latex-and-formats.md](catalog/latex-and-formats.md) |
| Local TEXMF libraries | `npm test -- --only latex-texmf` | [catalog/latex-and-formats.md](catalog/latex-and-formats.md) |
| Remembered tabs (unit) | `npm run tabs:restore:unit` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| Typst page map (unit) | `npm run typst:map:unit` | [catalog/preview-and-sync.md](catalog/preview-and-sync.md) |
| HTML source map (unit) | `npm run html:map:unit` | [catalog/preview-and-sync.md](catalog/preview-and-sync.md) |
| Block source map (unit) | `npm run block:map:unit` | [catalog/preview-and-sync.md](catalog/preview-and-sync.md) |
| Typography stacks (unit) | `npm run typography:unit` | [catalog/ai-accessibility-and-typography.md](catalog/ai-accessibility-and-typography.md) |
| AI Assistant (unit) | `npm run ai:unit` | [catalog/ai-accessibility-and-typography.md](catalog/ai-accessibility-and-typography.md) |
| AI Assistant (mock) | `npm run ai` | [catalog/ai-accessibility-and-typography.md](catalog/ai-accessibility-and-typography.md) |
| AI Assistant (live) | `npm run ai:live` | [catalog/ai-accessibility-and-typography.md](catalog/ai-accessibility-and-typography.md) |
| Read Aloud (unit) | `npm run read-aloud:unit` | [catalog/ai-accessibility-and-typography.md](catalog/ai-accessibility-and-typography.md) |
| Read Aloud | `npm run read-aloud` | [catalog/ai-accessibility-and-typography.md](catalog/ai-accessibility-and-typography.md) |
| Auto-close typing | `npm run autoclose` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| Emmet on Tab | `npm run emmet` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| Rich paste | `npm run paste` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| Image syntax | `npm run image:syntax` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| Image rules | `npm run image:rules` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| Link targets (unit) | `npm run links:unit` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| Link navigation | `npm run links` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| Typst pages | `npm run typst:preview` | [catalog/preview-and-sync.md](catalog/preview-and-sync.md) |
| Math | `npm run math` | [catalog/preview-and-sync.md](catalog/preview-and-sync.md) |
| Syntax | `npm run syntax` | [catalog/preview-and-sync.md](catalog/preview-and-sync.md) |
| Typography | `npm run typography` | [catalog/ai-accessibility-and-typography.md](catalog/ai-accessibility-and-typography.md) |
| AsciiDoc | `npm run asciidoc` | [catalog/latex-and-formats.md](catalog/latex-and-formats.md) |
| Editor menu / Format | `npm run format:document` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| Menu structure | `npm run menu` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| HTML guest | `npm run html` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| Document tabs | `npm run tabs` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| Favorites | `npm run favorites` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| Favorites restore | `npm test -- --only favorites-restore` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| Tab restore | `npm test -- --only tabs-restore` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| Recent menu | `npm run recent` | [catalog/editor-and-documents.md](catalog/editor-and-documents.md) |
| Close | `.\scripts\test-close.ps1` | [catalog/build-and-site.md](catalog/build-and-site.md) |
| Document audit | `npm run audit` | [catalog/preview-and-sync.md](catalog/preview-and-sync.md) |

## What the runner does around them

`npm test` (`scripts/test-all.mjs`) runs that table in that order. It exists
because the layers are not self-contained: it builds first, gives every UI suite
its own freshly launched instance, its own port and its own fixture, starts each
one from first-run state, runs the tab-restore layer as two launches of one
settings directory — the first closed with WM_CLOSE so the flush runs, the
second started with no document argument — stages the binary outside the
workspace — an executable
launched from inside it cannot write `%APPDATA%`, which is exactly what the close
test asserts — and closes everything it started on every exit path. `--no-build`
tests the binary already built, `--only`/`--skip` narrow the run, `--all` adds the
pandoc export and the image paste checks, and `--kill` is a legacy option that cannot bypass the user-instance guard.
Before touching state, the harness refuses any running user MDraft, including
installed/portable copies outside the repository. It closes only owned test
leftovers. A private webview folder or CDP port does not isolate the app identifier.

The two commands that belong to the runner rather than to any one subject:

| Command | Runs | Does |
| --- | --- | --- |
| `npm test` | `scripts/test-all.mjs` | Every layer in the order below, doing the setup each one quietly depends on: build, Rust, then one freshly launched instance per UI suite on its own free port, each with its fixture and first-run state. The two restart layers are the exception: two launches of the same instance's settings directory, closed with WM_CLOSE in between so the close flush runs. Puts back the working tree, the developer's own settings, window state and recovery journal afterwards. UI runs refuse to start while another harness or staged instance is active, and cleanup only closes this run's staged executable. `--only`, `--skip`, `--all`, `--no-build`, `--kill`, `--list`; `--allow-installed` only permits suites explicitly marked read-only to run alongside the installed app under the distinct hidden test identifier |
| `npm run test:harness:unit` | `scripts/test-harness-ownership-unit.mjs` | Checks that a test run identifies only its own staged executable and detects another harness without treating itself as a conflict — no application. |

The frontend quality gates are separate from the functional table: `npm run
format:check`, `npm run lint` and `npm run knip`. The `Quality` workflow
(`.github/workflows/quality.yml`) runs those with `npm run build`, `npm run
p0:unit`, `npm run test:sessions`, `npm run preview:unit`, `npm run
preview:worker:unit`, `npm run preview:dom`, `npm run asciidoc:export:unit` and
`cargo clippy --all-targets -- -D warnings`. The Linux job needs a Chromium browser
for `preview:dom`; native WebView2 performance remains a controlled-machine test.

The close test is PowerShell rather than CDP because it has to kill the
application, which no DOM test can survive. It launches the release binary, sends
WM_CLOSE — exactly what the title-bar X sends — and asserts that the process
exits and that `.window-state.json` was written. Run it after any change to
`capabilities/default.json`.

It closes a window whose one document is clean. `p0-lifecycle-test.mjs` separately
checks dirty tab/bulk/native-window cancellation through the in-app three-way
dialog, plus a failed close-save. It delays browser fetch for selected IPC
commands and stubs native pickers at that transport boundary; protected Tauri
methods remain immutable. `sessions-test.mjs` covers the store
invariants the guard relies on (which sessions are in the list, what `remove`
returns, that the active session is always defined), not the prompts themselves.

### Running the CDP tests correctly

**Each test needs the app open with the right document.** The smoke test asserts
against `samples/feature-tour.md`; the math test against
`docs/samples/physrevb_70_035307.md`. Running a test against the wrong
document produces a wall of failures that look like regressions.

```powershell
Remove-Item "$env:APPDATA\io.github.bgeneto.mdraft\settings.json" -Force -ErrorAction SilentlyContinue
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
Start-Process ".\src-tauri\target\release\MDraft.exe" -ArgumentList "`"$PWD\samples\feature-tour.md`""
Start-Sleep -Seconds 15
npm run smoke
```

The image test also needs a fixture server:

```powershell
node scripts\image-paste-test.mjs 9222 "http://127.0.0.1:8791/served.png" "C:\path\to\served.png"
```

### The Linux print probe

The WebKitGTK print path is display-owned and ignored by the normal test run. It
can print the exact native article you captured from the application, or a
small built-in page, and writes a real PDF:

```powershell
wsl -e bash -lc 'cd ~/.cache/mdraft-build/src-tauri && DISPLAY=:0 GDK_BACKEND=x11 WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 MDRAFT_PRINT_HTML=/mnt/c/path/quality-native-linux.html MDRAFT_PRINT_PDF=/tmp/mdraft-linux.pdf cargo test --lib webkitgtk_writes_a_pdf_with_the_same_settings -- --ignored --nocapture --test-threads=1'
```

`MDRAFT_PRINT_HTML` is optional; without it the test prints a small built-in
page. `MDRAFT_PRINT_PDF` is optional and defaults to
`/tmp/mdraft-linux-print-test.pdf`. The test exits 0 after verifying `%PDF-`; it
deliberately calls `process::exit(0)` before WebKitGTK's teardown abort. Use
`pdftoppm` and `scripts/pdf-visual-check.mjs` on the result exactly as for the
Windows direct PDF.

### What the assertions are worth

Counting elements proves code ran, not that the result is correct. This project
was once "verified" by a check that counted 270 KaTeX elements and reported zero
errors — while the application was rendering math with **no stylesheet at all**,
because `katex.min.css` was never imported. Fractions collapsed and radicals
vanished, and every assertion passed.

Assertions here therefore measure what a person would see:

- **Math**: `document.fonts.load()` each family (a declared `@font-face` is not a
  reachable file), then the width of `.frac-line` and the radical's `.hide-tail`
  box.
- **Syntax highlighting**: the count of *distinct computed colours* of token
  spans, and that switching palette changes both surface and tokens.
- **UI**: exactly one view-mode control may be active; a duplicate means the
  button that used to sit next to it came back. The status-bar icons must stay
  inline SVG at 16px or more, not text glyphs. The preview highlight must be a
  blink that leaves nothing behind — a persistent tint reads as markup applied
  to the document.

When adding a test, ask what a broken result looks like and measure that, rather
than asserting the feature's own internal counters.
