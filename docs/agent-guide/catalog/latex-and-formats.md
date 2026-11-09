# LaTeX, Typst and AsciiDoc formats

The LaTeX engine, its reference validator, diagnostics, outline, formatter and
PDF correspondence, plus the AsciiDoc and Typst format layers. A change to
`src/latex*.ts`, `src/typst-*.ts`, `src/asciidoc-*.ts` or the Rust LaTeX
adapters (`latex.rs` for the bundled engine and cache, `latex_native*` for an
installed distribution and its process runner\) start here.

The user-facing LaTeX detail is `docs/latex.md`; the traps are in
[../traps/latex-typst-asciidoc.md](../traps/latex-typst-asciidoc.md).

## npm entry points

| Command | Runs | Does |
| --- | --- | --- |
| `npm run completion:latex:unit` | `scripts/completion-latex-unit.mjs` | 100 checks of the LaTeX catalog and context table: 190 rows across sections, no duplicate within a section, snippets whose bodies come from `latex-commands.ts` so Format and completion cannot disagree, real newlines in multi-line templates, **argument templates** (every command that takes a brace argument inserts it — `\cite` → `\cite{}`, `\frac` → `\frac{}{}` — with an empty field rather than a placeholder, and an optional `[...]` group dropped), every context (command, environment, package, class, label, citation, image), the positions that must offer nothing (prose, `%` comment, verbatim body, after `\\`), and prefix filtering — no application |
| `npm run latex:word-map:unit` | `scripts/latex-word-map-unit.mjs` | Checks guarded literal prose, standard verbatim words, unique inline/display equations and PDF correspondence, including a superscript split across adjacent PDF text lines and ambiguous duplicates — no application. |
| `npm run pdf:map-worker:unit` | `scripts/pdf-page-worker-unit.mjs` | Checks that the PDF word-map worker delivers a large index in acknowledged batches and preserves its source order — no application. |
| `npm run pdf:map:perf -- [math\|prose] [lines] [runs]` | `scripts/pdf-map-performance.mjs` | App-free Node worker probe for synthetic LaTeX PDF correspondence. Reports source size, anchors, wall time and 10 ms sampled process RSS; it does not measure WebView or typing latency. Defaults to 8,000 math lines or 10,000 prose lines, with each of three workers in a fresh process. |
| `npm run pdf:map:webview -- <port> <pid> <profile-marker> [paragraphs] [keystrokes]` | `scripts/pdf-webview-performance.mjs` | Probe for an already-running isolated Windows WebView with LaTeX enabled. Builds a temporary multi-file, image and equation fixture; compares SyncTeX on/off PDF output and mapping, samples the app/WebView working sets, and types real keys during map builds. Defaults to 180 paragraphs and 20 overlapping keystrokes. |
| `npm run latex:sync:unit` | `scripts/latex-sync-unit.mjs` | Checks LaTeX project-reference validation and confinement — no application. |
| `npm run latex:references:unit` | `scripts/latex-references-unit.mjs` | 68 checks of the validator that decides whether a project's `\input`/`\include`/`\includegraphics`/`\bibliography` references are literal paths. Pins the false-positive classes that once rejected the shipped LaTeX Reference — `\verb`, `\lstinline`, `\mintinline` (delimiter **and** brace forms), the verbatim environments, the `comment`/`filecontents` bodies, `\iffalse` blocks, `\texttt{\input}` prose and a bare command mention — and the real rejections that must survive: a macro path, a parent escape, an absolute path, a URL. Also pins the odd/even backslash comment rule (`\\%` is a comment, `\%` is not), the exact `%`-no-space line from the reported thesis, that masking preserves line and column offsets, and that two live occurrences are two diagnostics with their own line and compiled line — no application |
| `npm run latex:diagnostics:unit` | `scripts/latex-diagnostics-unit.mjs` | 27 checks of the pure mapper from a diagnostic's 1-based line/column to CodeMirror offsets: an exact command span, a command that moved along the line, a vanished command marked stale on the whole line, a line-only compiler diagnostic, the document edge and an empty line, UTF-16 columns after an accented prefix, the panel's `file:line`/signature strings, and project membership — an included chapter belongs to the failed project, an unrelated `.tex` beside it does not — no application |
| `npm run latex:native:unit` | `scripts/latex-native-unit.mjs` | 20 checks of the installed-TeX result adapter: only `.tex` files become sources with the main file first, the BOM and CRLF are normalised, a warning-only build is current with its line text, an error with a partial PDF throws `LatexBuildError` and offers the partial bytes, a cancelled job publishes nothing, a diagnostic outside the snapshot is shown without navigation, and truncation, timeout and no-PDF messages are exact — no application |
| `npm run latex:preview` | `scripts/latex-preview-test.mjs` | Checks the compiled LaTeX PDF through the real UI, including PDF/source correspondence, scroll, failed-build retention, missing images, manual compile, warnings, and PDF export and print. Set `MDRAFT_LATEX_REPORTED_SAMPLE=1` to additionally test a temporary copy of `docs/samples/Resumo-executivo.tex`; `MDRAFT_LATEX_SAMPLE_ONLY=1` runs only that reproduction. Either may need uncached packages. Set `MDRAFT_LATEX_SCREENSHOT` to an output path to capture that successful preview for visual inspection. Uses real wheel and PDF double-click events. Skips when the engine is not installed. |
| `npm run latex:outline:unit` | `scripts/latex-outline-unit.mjs` | 33 checks of the Outline panel's LaTeX scan: the shipped LaTeX Reference produces exactly its own eleven headings, with no phantom row for a `\section` it only *demonstrates* inside `\verb` or a verbatim block; every sectioning command and its nesting, starred forms, the optional short title, two headings on one line, a heading that contains a `\verb` keeping its literal text, a `%` inside a literal not starting a comment, and the line numbers masking must not move — no application |
| `npm run latex:sdk:unit` | `scripts/latex-sdk-unit.mjs` | Checks the LuaLaTeX engine pin, original snapshot retention and that the adapter does not request or consume SyncTeX — no application. |
| `npm run latex:measure` | `scripts/latex-measure.mjs` | A probe, not a check: the engine's on-disk footprint, the snapshot the compile receives against what the old directory walk would have sent (51% smaller on the fixture), and the base64 overhead. Prints no compile timing, because the engine drives a Web Worker and Node has no `Worker` global — the timings come from `latex:project`, which launches a real instance |
| `npm run latex:tools` | `scripts/latex-tools-test.mjs` | 7 checks that Tools › Check or Install LaTeX… reaches a handler rather than being a present-but-dead row. Uses a **positive control**: a bogus menu id must make the dispatcher warn (`[menu] no handler for …`), and `tools.latex` must not — so the check can fail. Also asserts the two rows beside it stay wired and the application survives the native dialog. The dialog itself is `plugin-dialog`, outside the webview, so no DOM selector can see it |
| `npm run latex:correspondence:unit` | `scripts/latex-correspondence-unit.mjs` | Checks file-aware PDF/source ranges, cross-file and incomplete selection rejection, and source lookup — no application. |
| `npm run latex:format:unit` | `scripts/latex-format-unit.mjs` | 29 checks of tex-fmt as the LaTeX formatter: indentation is applied, `verbatim`/`lstlisting`/`minted`/`alltt`/`\verb` bodies are **byte-identical** (tex-fmt 0.5.7 rewrites tabs to spaces and collapses blank-line runs inside them — measured, and `maskLatexLiterals` is what prevents it), math is not rewritten, prose is not reflowed (`wrap = false`), formatting twice equals formatting once, a non-LaTeX buffer is untouched, and the shipped LaTeX Reference survives with every comment and verbatim block intact — no application |
| `npm run latex:project -- [port] [offline]` | `scripts/latex-project-test.mjs` | 16 checks of the multi-file LuaLaTeX project, exact main-file mapping, an authored `\synctex=1` compile, PDF prose navigation into an included file, root retention and unsaved edits in an isolated Windows WebView2 instance; the offline mode expects a warmed cache and a process-level network block. The default harness also runs it as `latex-project` and skips if the engine is unavailable. |
| `npm run latex:native -- [port]` | `scripts/latex-native-test.mjs` | 13 checks of a real installed distribution through the application: `latex_native_validate` probes versions and compiles a probe, the switch selects the native backend, `latex_native_compile` returns a PDF, and the preview commits it. Requires `MDRAFT_TEST_TEX_BIN`; the default `latex-native` layer prints `SKIP` and exits 0 without it. Tests the reader's portable MiKTeX layout directly, with no sandbox or ACL setup. |
| `npm run asciidoc` | `scripts/asciidoc-test.mjs` | 54 checks of the AsciiDoc preview, source highlighting, outline, preview copy, spellcheck, includes, paste, the AsciiDoc reference, the default extension and word-level sync |
| `npm run asciidoc:export:unit` | `scripts/asciidoc-export-unit.mjs` | 28 unit checks of the AsciiDoc -> HTML step every pandoc export uses and the preview chunker: unset attributes, attribute substitution, backend-pdf/backend-html5 conditionals, the include jail and pre-reader, inline and block LaTeX and AsciiMath, top-level chunks, markers and the absence of export decorations; no application |

## Test harnesses

Every harness here needs the app already running with CDP enabled (see
[../testing.md](../testing.md#running-the-cdp-tests-correctly)) **and the right
document loaded**. The port is always `argv[2]` and defaults to `9222`.

| Script | Arguments | Needs this document | Proves |
| --- | --- | --- | --- |
| `asciidoc-test.mjs` | `[port]` | `samples/asciidoc-tour.adoc` | The AsciiDoc preview, title/TOC, KaTeX and AsciiMath, the built-in AsciiDoc reference, source anchors and scroll sync, highlighting, outline, preview copy, spellcheck, include refusal, rich paste, bitmap `image::`, default extension and word-level sync |
| `latex-word-map-unit.mjs` | — | none — runs without the application | Checks LaTeX prose candidate offsets and excludes conditional, comment, verbatim and macro-definition text. |

## Build and environment helpers

| Script | Arguments | Does |
| --- | --- | --- |
    [Releasing](../releasing.md).

## Testing layers

These rows are part of the ordered layer table; the full order and what the
runner does around them are in [../testing.md](../testing.md).

| Layer | Command | Count | Catches |
| --- | --- | --- | --- |
| AsciiDoc export source | `npm run asciidoc:export:unit` | 28 | Unset attributes, attribute substitution, backend-pdf/backend-html5 conditionals, the include jail/pre-reader, inline and block LaTeX and AsciiMath, the preview's top-level chunks and markers, and the absence of export decorations - no application |
| LaTeX completion (unit) | `npm run completion:latex:unit` | 100 | The catalog's 190 rows and its section/label deduplication, snippets whose bodies come from `latex-commands.ts` so Format and completion cannot disagree, real newlines in multi-line templates, argument templates (a command that takes a brace argument inserts it, with an empty field and any optional `[...]` dropped), every context the decision table recognises, the positions that must offer nothing (prose, `%` comment, verbatim, after `\\`), and prefix filtering — no application |
| AsciiDoc | `npm run asciidoc` | 54 | Preview, title/TOC, math, includes, source highlighting, outline, preview copy, spellcheck, paste, the built-in reference, defaults, word-level sync |
