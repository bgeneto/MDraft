# Export and print traps

Pandoc, the browser-readable artifacts, WebView2 and WebKitGTK printing, and the PDF measurements that follow them.

Part of [the trap record](../traps.md). Search across every domain with:

```powershell
rg -n "<literal error text>" docs/agent-guide/traps
```

**Ctrl+P invokes `print_native`, yet no usable print dialog remains**
`ShowPrintUI` returning was mistaken for dialog completion, so immediate webview
destruction removed the dialog's owner. A later Windows message said `Print
failed` / `Check your printer and try again. Printing failed.` Keep the visible
print owner until explicit closure; inspect the native window, not only the IPC
result or a webview screenshot. Windows cannot report print-versus-cancel from
this API's return value.

**`window is not a usable app window` on `Microsoft Edge WebView2 - Print`**
Windows hosts the system print dialog in Explorer. Sky can capture it but may
refuse input; that is not proof that Cancel is broken. Confirm cancellation
with the user if needed. The remaining MDraft-owned preview may appear only as
an additional screenshot in the main window's state, not in `list_windows`.
Select that screenshot's id/origin when closing its X, then verify the print
surface is gone and the editor remains usable. Do not infer completion from
`ShowPrintUI` returning or from the toast's retained text.

**`spawnSync pdffonts ENOENT` despite the PDF checker finding Poppler**
Finding only `pdfinfo` did not prove the full suite was installed. Detect all five
tools before choosing native/WSL. `MDRAFT_PDF_RASTERIZER=wsl` propagates through
the PDF test; keep its files on a WSL-mounted workspace path, since redirected
TEMP volumes such as T: need not exist under `/mnt/t`.

Each of these cost real time. Symptom → cause → fix.

**`Pandoc exited with 99` / `File 'chapter.tex' not found in resource path` although the file is beside the staged main file**
Pandoc's LaTeX reader resolves `\input`/`\include` against the **working directory**, not against the main file's own folder and not against `--resource-path`. Measured: an absolute staged `main.tex` with `chapter.tex` beside it, run from another directory, still reported `Could not load include file chapter.tex`; adding `--resource-path=<staged root>` changed nothing. Run pandoc **in** the staged root and pass the original project root as `--resource-path`, which is what makes `\includegraphics` resolve to the reader's own image. Do not conclude the snapshot is missing a file from this message.

**`[WARNING] Could not fetch resource s5/default/slides.css` and an 830 KB reveal.js file from `--embed-resources`**
`--embed-resources` inlines whatever the writer's template links, and the slide writers link their CSS and JavaScript from a CDN — so the flag makes **pandoc** fetch them. That is a network request the application must not start on its own. Restrict embedding to `html`, `html4`, `html5` and `chunkedhtml`; the slide writers keep their template links, which are the document's own request when the reader opens it. A local-only test cannot see this: the fetch happens inside pandoc.

**`run_pandoc_writer` writes a directory when the writer is `chunkedhtml` and the chosen path has no extension**
`chunkedhtml` writes a **directory tree** unless the output name ends in `.html`/`.zip`, in which case pandoc writes one ZIP. Measured: `-o out/noext` produced a directory and exit 0; `-o out/named.zip` produced a 3999-byte ZIP. The chooser suggests `zip` for this writer, and a save dialog always supplies an extension, so the single-output rule holds — but a direct call with an extensionless path would scatter HTML into a folder the reader did not choose.

**`pandoc -t bibtex` exits 0 with a zero-byte file for a `.tex` source, and `-t csljson` writes `[]`**
Pandoc's LaTeX reader does not carry the entries a `.bib` file holds, so the citation-data writers have nothing to emit — with or without `--citeproc`. Measured on a document with `\cite`, `\bibliographystyle` and `\bibliography`. This is not a broken writer and not a missing bibliography: the row is labelled *citation data only — empty for LaTeX* in the chooser, and the outcome carries a warning instead of presenting the empty file as a conversion.

**An exported document needs the KaTeX stylesheet, or the mathematics collapses**
`wrapPrintHtml` shipped with the highlight.js token colours but not KaTeX's
layout rules. The export still looked plausible and reported no error, while
exponents vanished, fraction bars disappeared and radicals drew a bar across the
whole page — the same failure the preview once had, now reproduced in the export
path. `KATEX_STYLESHEET_URL` in `markdown.ts` is the single source for both
exports; a second copy would drift again.

**An exported GitHub alert loses its colour and looks like a plain blockquote**
`.md-alert-*` lived only in `src/styles.css`, which none of the export wrappers
load. The preview was correct, while `Export › HTML`, the native PDF and the
browser PDF all printed a grey `blockquote` with no tinted background and no
coloured rule. Every rule the preview applies from `styles.css` must have an
export copy beside `ASCIIDOC_CSS`; `GITHUB_ALERT_CSS` in `markdown.ts` is that
copy, and `exportTypographyCss()` concatenates it. A regression is invisible in
the DOM: assert the rule in the exported bytes (`scripts/export-browser-test.mjs`)
or measure the computed background in a browser reading the exported file, not
that `.md-alert` exists in the article.

**Pandoc's markdown reader does not accept `\(…\)` or `\[…\]` by default**
`tex_math_dollars` is on, `tex_math_single_backslash` and
`tex_math_double_backslash` are off, so a document using the backslash delimiters
— which this editor renders — exports them as escaped literal text:
`(a\^{}2 + b\^{}2 = c\^{}2)` instead of the formula. The default formats pass
`-f markdown+tex_math_single_backslash+tex_math_double_backslash`, and a test
asserts it, because the difference is invisible in the preview.

**The pandoc export cannot render what pandoc has no concept of**
`[TOC]` and the GitHub alert markers (`[!NOTE]`, `[!TIP]`, `[!WARNING]`) are this
editor's own extensions. Pandoc prints them as literal text, so a DOCX or LaTeX
export shows `[TOC]` and `[!NOTE]` where the preview shows a table of contents
and a callout. This is a real fidelity gap, not a bug to fix by argument
tweaking; the PDF export, which prints the preview's own HTML, does not have it.
`[TOC]` has a partial answer: add `--toc` in the format's Extra Arguments.
Native PDF and `Export › HTML` do draw coloured alerts because they reuse the
preview article and the shared `GITHUB_ALERT_CSS`; `PDF (via Typst)` still prints
the `[!NOTE]` marker literally, because pandoc never evaluates it.

**An exported local HTML cannot be opened with the agent's browser tools**
`tools.browser.tabs.open` rejects a `file:` address with `Invalid browser URL`,
and Playwright reports `Access to "file:" protocol is blocked`.
`browser.preview` only renders a Review pane and cannot be evaluated. Do not read
that as a broken export: resolve the artifact's URLs in Node (`parse5` plus
`fileURLToPath`), as `export-browser-test.mjs` does, and leave the
ordinary-browser/PDF check to the owner.

**`PDF (via Typst)` prints `:toc!:`, `ifdef::backend-pdf[]` and `{attribute}` placeholders**
Pandoc's AsciiDoc reader is not AsciiDoc enough for an export. A single unset
attribute such as `:toc!:` makes it stop recognising every following
`:name: value` line, so the header is emitted as prose; it also never evaluates
`ifdef::`/`ifndef::` or substitutes document attributes. Measured with pandoc
3.12.1: `pandoc -f asciidoc -t plain` on the reported document starts with
`:toc!: :sectnums!: :icons!: :pdf-page-size: A4 ...`. Do not try to patch the
source with a regex. Render the buffer with Asciidoctor to HTML first (the
shared `src/asciidoc-render.ts`), send it to `run_export` with
`language: "html"`, and let pandoc's HTML reader carry it. The preview and the
native HTML/PDF (Print) paths already use Asciidoctor, which is why they looked
correct.

**`missing converter for backend 'pdf'` when Asciidoctor renders an export**
Setting `backend: "pdf"` is the way to make `ifdef::backend-pdf[]` true while
the output is still HTML, but Asciidoctor then looks for a converter registered
under `"pdf"` and aborts before producing anything. Register the HTML5
converter subclass for that backend:

```ts
const factory = new Asciidoctor.ConverterCustomFactory();
factory.register(PandocHtml5Converter, "pdf");
```

The preview keeps its own registry under `"html5"`; the two must not share one.

**An exported AsciiDoc formula is literal `\(x^2\)`, or a KaTeX formula disappears**
Pandoc's plain HTML reader does not enable the backslash math delimiters, and
Asciidoctor emits exactly `\(…\)` / `\[…\]`. Name
`html+tex_math_single_backslash+tex_math_double_backslash` (the `HTML_READER`
constant in `export.rs`) or the formula prints as punctuation. Do not hand
pandoc the preview HTML either: KaTeX's spans are dropped and the formula
vanishes completely (`No instante e .`). The export renderer emits source
delimiters, not rendered KaTeX.

**`[WARNING] Could not convert TeX math ... unexpected control sequence \\`, and the PDF shows the formula as literal text**
Pandoc's TeX -> Typst conversion does not accept TeX's `\\` line break. An
AsciiMath block whose lines were joined into one display formula with `\\`
produces that warning, and Typst then prints the source instead of typesetting.
Emit one `<div class="math">\[…\]</div>` per source line, which is also how the
preview draws a multi-line stem. The unit suite pins the separate blocks.

**`error: failed to load file (path contains invalid component "C:")` from Typst during a PDF export with images**
Pandoc resolves a local image to an absolute `C:/…` path, and Typst rejects a
drive-letter path even when `--root C:\` is supplied. Adding `--resource-path`
makes pandoc find the image and then triggers this error; without it pandoc
replaces the image with its description and the PDF still builds. That is a
pre-existing limitation of every pandoc PDF export with local images on
Windows, not an AsciiDoc problem. Do not add `--resource-path` casually.

**`Pandoc exited with 1` and `pandoc.exe: .: openTempFile: permission denied (Permission denied)` for every Markdown and AsciiDoc PDF export, while `.typ` documents export fine**
Pandoc's PDF writer does not use the system temporary directory. `toPdfViaTempFile` creates the engine's input and output with `withTempFile "."`, and for Typst its media directory with `withTempDirectory "."` — all relative to the process's **working directory**. The MSI's Start-menu shortcut sets `WorkingDirectory=C:\Program Files\MDraft`, which a normal user cannot write to, so pandoc died before it started Typst. `.typ` documents were unaffected because they are compiled by Typst directly, without pandoc; a development build launched from the repository and the portable build launched from a writable folder both worked, which is why it looked like a regression in one install. Reproduce it without the application: `cd` into a directory with a deny-write ACE, then run `pandoc -o out.pdf --pdf-engine=<full path to typst.exe>` with the document on stdin — the literal message and the `temporary-1.3` backtrace match. `src-tauri/src/export.rs` now runs pandoc in a per-export scratch directory under the system temp directory (falling back to the app cache directory when `TEMP` itself is unusable) and points `TMPDIR`/`TEMP`/`TMP` at it. Do not replace that with `--resource-path=<document folder>`: pandoc then hands Typst an absolute `C:/…` image path, which Typst rejects, so a document with images fails a different way. Non-PDF formats run in the document's folder instead, because only the PDF writer creates files in its working directory and the document folder is what makes relative image paths resolve as they do in the preview.

**Moving an export row by editing `default_export_formats()` changes nothing**
The Export submenu does not read `default_export_formats()`: it reads each
install's stored `settings.exportFormats`, and a built-in row can be pinned by
the builder instead of the list order (the pandoc PDF is, through
`is_pandoc_pdf`). A fresh profile can show a new order while the developer's own
does not, and editing the defaults alone moves no row that is pinned. Read the
real file before suspecting a stale build:
`(Get-Content "$env:APPDATA\io.github.bernh.mdraft\settings.json" -Raw | ConvertFrom-Json).exportFormats.id`.
Place a fixed row in `build` and assert it through `menu_items` in
`scripts/menu-test.mjs`; that probe is the only way to see a native menu.

**An export row says “— needs Typst” but stays enabled**
`apply_context` walked every menu item and answered `true` for ids it did not
recognise, so every `set_menu_state` re-enabled `export.pandoc.pdf` immediately
after `apply_export_availability` had disabled it. The label made it look as if
the availability path had run; `menu_items` showed `enabled=true` beside
`"PDF (via Typst)… — needs Typst"`. A menu-state sync must return “leave this
alone” for rows another owner controls: export formats, recent-file rows and the
generated open-tab rows. Test `enabled_for` for `None`, not merely for the
visible label.

**A scripted-HTML fallback never runs because the dialog stub answered "Ok"**
The export waits for `print_document` and the prompt is recorded, but the browser path never starts. `@tauri-apps/plugin-dialog` implements `ask()` as `plugin:dialog|message` with `buttons: "YesNo"` and resolves to the label of the pressed button, not a boolean; a stub that returns `"Ok"` is therefore `"Ok" !== "Yes"` and takes the No branch. Stub the message command with `"Yes"` when `args.buttons` is present. There is no `plugin:dialog|ask` command in this version.

**`The PDF writer failed: Printer not found` from WebKitGTK silent printing**
`GTK_PRINT_SETTINGS_OUTPUT_URI` plus `OUTPUT_FILE_FORMAT=pdf` is not enough: `webkit_print_operation_print()` still resolves a `GtkPrinter`, and a machine with no configured CUPS printer fails before writing. Set the print settings printer to GTK's **virtual PDF printer**. Its name is translated, so `"Print to File"` only works in English; enumerate printers with `gtk_enumerate_printers` and select the one where `gtk_printer_is_virtual()` and `gtk_printer_accepts_pdf()` are both true. The helper is `virtual_pdf_printer()` in `print.rs`.

**The Linux PDF's 18/16 mm `@page` margins do not apply, and content starts 6 mm from the paper edge**
WebKitGTK uses the `GtkPageSetup` margins and ignores the article's CSS `@page` rule in the silent print path. The rendered page looks plausible but the PDF visual checker reports ~96% white in the outer band. Set `set_top_margin(18, Mm)`, `set_bottom_margin(18, Mm)`, `set_left_margin(16, Mm)` and `set_right_margin(16, Mm)` on the page setup for both the dialog and the PDF writer. Do not "fix" this by shrinking the body; the geometry is the paper's.

**A heading is left at the foot of a page while its diagram moves to the next**
WebKitGTK does not honour `break-after: avoid` or `h2 + * { break-before: avoid }` in paged media. `keepHeadingsWithNext` wraps a heading and its following block in `.print-keep` with `break-inside: avoid`; tables and code are excluded so a block taller than a page can still break. The same wrapper plus `orphans:3; widows:3` removes the isolated two-line last page. Verify by viewing the rasterized pages, not by checking that the CSS rule exists.

**A PDF pixel check finds zero red/green/blue pixels although the page image clearly has them**
`pages.flatMap((page) => page.pixels)` looks reasonable but flattens each `Buffer` byte by byte, so the subsequent `i += 3` reads misaligned channels. Count per page, or concatenate the buffers, before stepping through RGB triples. The same class of bug appears if a line-density check uses a threshold darker than a `#c8c8c8` table rule; measure the threshold from the fixture.

**`Page.captureScreenshot` shows no print dialog, although the system dialog is open**
The native dialog is a separate top-level window, outside the webview, and a locked Windows session makes a screen capture show the lock screen while CDP still works. `EnumWindows` showed a visible `Microsoft Edge WebView2 - Print` window while the `print_native` command remained pending; that is the proof the dialog opened. Do not conclude from a CDP-captured PNG that native printing failed.

**A static HTML document prints on Letter paper from the native writer**
The native HTML copy only adds a base and a marker; a source file with no `@page` rule inherits WebView2's default paper. `buildHtmlNativePrintDocument` now inserts `@page{size:A4;margin:18mm 16mm}` first in the head, before the document's own styles, so a document that defines its own page rule still wins. The PDF visual checker's A4 assertion is what caught it.

**The ignored WebKitGTK print test writes the PDF and then aborts with `SIGABRT`**
The test result prints `ok` and the file is valid, but the process exits with signal 6 while WebKitGTK tears down its web process. The test is `#[ignore]`d and display-owned; it calls `std::process::exit(0)` after verifying the PDF so a manual run reports the result it produced. Do not read the signal as a printing failure, and do not run it in the normal headless suite.

**`the export carries the reader's code scale` reports FAIL while the document plainly contains the rule**
The assertion required `var(--code-scale)`, but the export wrappers write `var(--code-scale,1)` so a document from before the setting keeps its old size. The declaration matched, the use did not, and the detail line still read "variable and rule present". Match the fallback form (`var\(--code-scale[,)]`) or strip the fallback before comparing; the same applies to any new `var(--x, fallback)` contract asserted in exported bytes.
