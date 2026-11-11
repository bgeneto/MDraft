# LaTeX, Typst and AsciiDoc traps

The non-Markdown formats: engine selection, reference validation, includes, outline scans and PDF correspondence.

Part of [the trap record](../traps.md). Search across every domain with:

```powershell
rg -n "<literal error text>" docs/agent-guide/traps
```

**A synthetic LaTeX PDF phrase selection reports the previous editor word even though the source mark is correct.** A synthetic DOM `Range` and `mouseup` left CodeMirror focused, and the editor restored its native selection while applying the source decoration. Use a real CDP pointer drag and independently assert both the browser selection and the source mark; the PDF selection test must exercise the actual focus change.

**A page-growth test reports `Reference ... undefined` followed by `Emergency stop.`**
The test inserted prose between the backslash and `end{document}`: a JavaScript
expression embedded inside a template string consumed one level of backslash
escaping, so `lastIndexOf("\\end{document}")` searched for `end{document}`.
The reference warning was a distracting first-pass warning, not the cause. In
CDP expressions build the backslash with `String.fromCharCode(92)` or verify the
actual expression and source around the insertion before blaming the compiler.

**`Document requires LuaLaTeX, which is not available in this build.` from a `wasmtex/node` probe**
The engine assets were present: a probe launched with `node --input-type=module`
passes that option to the SDK's eval-created worker, whose CommonJS bootstrap then
throws `ReferenceError: require is not defined in ES module scope`. WasmTex
catches the worker failure and reports an unavailable engine, which looks like a
missing install. Run a normal `.mjs` file or use `node` stdin with an async
`import()` and no `--input-type` flag; install `installNodeWorkerHost` and select
`engine: "lualatex"`. With the installed assets and locally cached mirror this
compiled a 4,341-byte PDF offline. The `latex-measure.mjs` note that Node has no
`Worker` applies to `wasmtex/headless` without the Node adapter, not to
`wasmtex/node`.

**`Document requires XeLaTeX, which is not available in this build.` — and the false conclusion that `fontspec` is XeLaTeX-only**
This build ships **only** the LuaLaTeX engine. The SDK's detection
(`engine/engine-select.js`) puts `fontspec`, `unicode-math`, `polyglossia` and
`mathspec` in a set whose own reason string reads *"requires a Unicode engine
(XeTeX/LuaTeX)"* — but then **defaults to XeLaTeX** for them. With no XeLaTeX
engine present, `compile-engine.js` fails with that message.

**LuaLaTeX supports `fontspec` perfectly well**; it is the standard way to use
OpenType fonts there. The set is a *preference*, not a requirement, and the fix is
never to strip `fontspec` from a document. Pass an explicit engine instead — the
SDK documents it: *"Set an explicit engine to override detection."* `src/latex.ts`
already does (`engine: "lualatex"`), which is why the application was never
affected.

The trap is that a probe or a test that constructs `WasmTexCompiler` **without**
that option inherits detection and fails on any `fontspec` document, and the error
text reads like a document defect rather than a missing option. I published that
wrong diagnosis and "fixed" the sample by deleting `fontspec` before reading the
adapter's own options. `latex:sdk:unit` asserts the engine pin and that the
sample still exercises `fontspec`.

**`Help › LaTeX Reference` opens a document that cannot compile: `Missing project file for \bibliography in LaTeX Reference.tex`**
The reference validator scanned every line as live markup, so it treated the
document's own examples — `\verb|\input{…}|`, `\texttt{\input}`, a bare
`\includegraphics` mention, `\iffalse` blocks, and the bodies of `verbatim`,
`lstlisting` and `minted` — as real references to files that do not exist. Saving
a copy of a built-in document is a normal thing to do, which is what surfaced it.
`src/latex-references.ts` now masks those regions before scanning, preserving line
and column offsets so an error still points at the right line. The lesson is
general: **a scanner that decides what a document *means* must mask the regions
that are literal text first** — `spellcheck.ts` and the outline extractor already
did, and this validator was the one that did not. `latex:references:unit` pins
every false-positive class plus the real rejections that must survive.

**The Outline panel grows phantom headings for every command the LaTeX Reference merely *shows***
`extractLatexHeadings` scanned each line as live markup, so `\verb|\section{...}|`
in the reference's own prose produced a heading. Its hand-rolled guard knew only
`verbatim`/`lstlisting`/`minted` bodies — not `\verb`, not `\lstinline`, not
`\mintinline`, not `\iffalse` — so the shipped reference listed four rows that
are sample text: `...`, `..`, `.` and a full `\section{...}` line. The fix is to
scan a copy masked by `maskLiteralRegions` from `latex-references.ts`; masking
preserves newlines and line lengths, so `i + 1` still names the right line.
**Do not write a fourth literal-region scanner** — there are already three
(`latex-references.ts`, `spellcheck.ts`, `format/formatters.ts`), and the one
that disagreed was the one that lost track.

**The LaTeX problem panel never changes: switching to another `.tex` tab re-shows the same `Missing project file for \includegraphics in Graphics and tables.tex: head_foot/LF` rows forever, even for a tab that compiles**
The root pin in `renderLatexPreview` asked "is the active tab inside the project
that failed?" by comparing **directories**:
`pathKey(doc.path).startsWith(pathKey(latexProblemRoot.directory) + "/")`. Two
unrelated documents share a folder, so every `.tex` tab beside a broken project
looked like a member of it; the pin then recompiled the broken main file and
repainted its problems, and a valid document never got its own preview. The
question the pin means to ask is **membership in the failed snapshot's file
set**, not location. `latexProblemFiles` now records the snapshot's files and
`latexProjectMember` (`src/latex-diagnostics.ts`) answers it, using the same
`pathKey` identity the session store uses. `latex:diagnostics:unit` pins that an
included chapter is a member while an unrelated `.tex` in the same folder is not.
The general lesson: **a "same project" test must compare the project's declared
file set, never just the parent directory** — a directory is a location, not an
identity.

**`\lstinline{\input{x}}` and `\mintinline{tex}{\input{x}}` are not masked, although the comment says they are**
The brace forms of the inline literals used a flat `[^{}]*`, which cannot match a
body that contains braces — and a code body usually does. So the brace form was
never blanked: `latex:references:unit` rejected `\lstinline{\input{chapters/intro}}`
as a real missing reference, and the outline listed a `\section` shown inside one.
The Rust twin (`mask_literal_regions` in `src-tauri/src/latex.rs`) already read
these with a depth-aware `brace_end`; `src/latex-references.ts` now does the same
through `braceGroupEnd`/`braceLiteralRanges`, and the brace scan runs **after**
the verbatim bodies are blanked so a `\lstinline{` written inside a listing cannot
open a group that swallows the rest of the file. The lesson is the one the
`\verb` trap above states: a comment claiming a region is covered is not a test.

**WasmTex returns `success: true` for a PDF whose log says `File 'biblatex-lite.bbl' not created by biblatex`**
The selected SDK returned a PDF with an unresolved `[knuth1984]` citation and
no bibliography even though its success flag was true; the error and undefined
citation were present in `result.errors`. Check error diagnostics and
unresolved bibliography warnings as well as the success flag, and inspect the
actual PDF when evaluating `biblatex-lite`.

**WasmTex reports `AssetDownloadError: TeX asset download failed: network` in both Tauri hosts while the same mirror works in Node**
The TeX Live mirror did not send an `Access-Control-Allow-Origin` header for
the WebView2 or WebKitGTK origins. The SDK's worker also makes synchronous
lookups, so an asynchronous `invoke` alone cannot replace its fetch. The
experiment uses an allowlisted in-process Tauri protocol and a Rust-managed
cache; test both worker imports and synchronous requests on each host.

**`typst --version` succeeds but a package-free compile returns `error: Access is denied. (os error 5)`**
The shell's execution sandbox can reject compilation even when the managed
compiler starts and its output is stdout or a writable workspace file. This
looked like a broken Typst/PDF pipeline; disabling system fonts and redirecting
temporary/package paths into the workspace did not fix it. The same original
stdin-to-PDF-stdout probe succeeded through approved execution escalation and
PDF.js extracted both fixture pages. Compare the exact invocation outside the
sandbox before changing the compiler installation, font setup or preview code;
do not treat this environment failure as evidence about source-map support.

**The AsciiDoc document title silently disappears from the preview**
`standalone: false` makes Asciidoctor set `notitle` on the (embedded) document,
and `convert_embedded` then omits the `<h1>`. The title is in
`doc.doctitle()`/`doc.header.title` but not in the HTML. Pass
`attributes: { showtitle: "" }` to `load`; the outline and the source plain-text
scan still find the title either way, so the symptom is only visible in the
preview.

**`include::` is refused with "outside the document directory" even though the file is beside the document**
The browser build reports paths derived from `base_dir` with a leading slash
before the drive (`/C:/…`), while Rust's `DocumentPayload.directory` uses
`C:\…`. A naive containment check compares `C:/…` with `/C:/…` and rejects a
legitimate target. Normalize the form `/C:/` to `C:/` before folding case, on
both the document directory and the reader's current directory. The same
mismatch is invisible on Linux, where both sides start with `/`.

**An AsciiDoc block admonition with a title and no body renders as nothing**
`[WARNING]` followed by `.Title` and nothing below converts to an empty string —
not to an admonition with just a title — with no error, so a title-only template
inserted by the Alert menu makes the whole block vanish from the preview until
the reader types a body. Keep a body line in the template
(`[WARNING]\n.Title\nText`). To check a candidate string cheaply, load it rather
than reasoning about the syntax: the app's browser build can be imported in Node
by file URL when the package `exports` map hides the subpath.

**A custom inline macro named `asciimath` never runs; the built-in stem macro wins**
An `InlineMacroProcessor` registered for `asciimath` builds a regexp that
matches `asciimath:[…]`, but its `process` is never called: the built-in stem
substitution consumes the text first. A custom `foo:[…]` macro in the same
registry does run, so the registry and its regexp are not the problem. Do not
intercept `stem`, `asciimath` or `latexmath` with an inline macro. Mark stems in
the HTML5 converter instead: `convert_inline_quoted` receives
`node.type === "asciimath"` and `convert_stem` receives `node.style`.

**`latex-poc` exits 13 with `Warning: Detected unsettled top-level await` at the included-file click**
The original probe clicked `Included chapter`, which appears in both the section heading and the following body sentence, so it was a poor unique-occurrence handoff target. The CDP helper also had no per-request timeout, allowing a missing response to end Node without a test summary. Click a distinctive body passage in the included file; reject pending CDP requests on socket close and time them out. That exit did not establish that the installed user app crashed; it was untouched. After changing the target to `independent SyncTeX navigation target`, and adding the authored-`\synctex=1` regression, the isolated suite passed 16/16.

**A PDF equation click test lands on `\section{` while targeting a glyph beside it**
PDF.js positions each glyph in its own text span, and adjacent math spans can overlap in their transformed rectangles. A DOM `Range` spanning a sequence of text nodes can return a center that hits an earlier span. For pointer tests, target a specific glyph's own span and confirm `document.elementFromPoint` before blaming the correspondence map.

**A LaTeX compile that wrote a PDF is reported as a failure because a warning was classified as blocking**
`src/latex.ts` built its `blocking` list from every diagnostic matching
`/citation .+ undefined|empty bibliography|undefined references|run biber/i`
**without reading `severity`**, then threw `LatexBuildError` even when
`result.success` was true and `result.pdf` held real pages. The pane therefore
showed "1 LaTeX problem" while the compiler output in the same panel said
`Output written on Resumo-executivo.pdf (23 pages, 344929 bytes).` The SDK only
reports `success: false` for a fatal-no-output line or an exit status other than
0/1 (`wasmtex-engine.js:501`), so cross-reference warnings arrive as a
*successful* compile that the adapter converted into a failure. The same shape
existed for `/LaTeX Warning: File .+ not found/i`. Decide from
`result.success`/`result.pdf`, never from a regex over the engine's prose; carry
warnings beside the PDF instead of discarding it. Reproduce with
`docs/samples/Resumo-executivo.tex`: it references `fig:arquitetura`, which it
never labels, so it always emits `LaTeX Warning: There were undefined
references.`

**A menu accelerator of `CmdOrCtrl+Enter` never fires, because CodeMirror already owns `Mod-Enter`**
`defaultKeymap` (installed at `src/editor.ts:849`) binds `Mod-Enter` to
`insertBlankLine`, so a native menu row with that accelerator is shadowed by the
editor and appears dead. Check `node_modules/@codemirror/commands/dist/index.js`
for the candidate before choosing one; `Shift-Mod-Enter` is free. `menu.rs`
having no `Enter` accelerator does not mean the key is available — the editor
keymap is the other half.

**Portable MiKTeX LuaLaTeX fails with `system : no writeable cache path, quiting` in an isolated compile.** A `--disable-installer --no-shell-escape` test could read the installed engine and packages, but Lua font loading tried to write its cache outside the writable test root. Setting both `TEXMFCACHE` and `TEXMFVAR` to the job's writable directory let the same one-page document compile. The `log4cxx: IO Exception : status code = 720005` message about the portable installation's own log still appeared. The first failure did not prove that the executable or distribution was unusable; isolate its writable caches as well as its output before diagnosing it.

**A sandboxed `latexmk.exe --version` exits 1 with `Sorry, but latexmk.exe did not succeed.`** The portable MiKTeX folder contained both `latexmk.exe` and `biber.exe`, yet both version probes exited 1 inside the AppContainer while separate LuaLaTeX and BibTeX passes succeeded. The latexmk output also reported `log4cxx: IO Exception : status code = 720005`; no Perl executable was found on the session PATH. The exact failure cause was not established, so do not claim that a missing Perl installation is the cause or that a filename proves a working tool. Probe each capability in the environment in which it will run and report the failure.

**A Windows AppContainer LuaLaTeX probe still reports `no writeable cache path` after the parent sets `TEXMFCACHE` and `TEXMFVAR`.** With a null environment block passed to the experimental process sandbox API, a plain LuaTeX probe reported `CACHE=nil VAR=nil`. Passing an explicit Unicode environment block delivered both values and let the same portable LuaLaTeX build a PDF. Do not conclude that the distribution cannot work in the container from the first failure. A spawned child also needed the temporary AppContainer SID and low-integrity write access on the disposable job directory before it could create files there.

**`luaotfload | load : FATAL ERROR ... system : no writeable cache path, quiting` while `TEXMFCACHE` points at a writable job directory**
TeX Live's `luaotfload` rejects a single `TEXMFCACHE` entry even when the
directory exists and is writable by the sandboxed process; the compile then
continues with `nullfont`, prints thousands of `Missing character` warnings and
exits 1. Leaving `TEXMFCACHE` unset and overriding only `TEXMFVAR` works, because
the default cache list keeps the system cache alongside the user cache. MiKTeX's
portable layout is the opposite and does need `TEXMFCACHE` redirected. Branch the
environment by distribution; do not "simplify" the two cases into one.

**The installed-TeX design no longer sandboxes the engine.** The two AppContainer
entries above describe the withdrawn isolation experiment. The current design
runs the selected engine directly, allows MiKTeX to install its own packages, and
keeps shell escape disabled; see
`docs/adr/2026-11-08-native-tex-user-responsibility.md`.

**The PDF prints `-- Module luavlna` and reports `Missing \begin{document}` / `Missing $ inserted` under `/tex/luavlna`**
The bundled worker uses format-qualified lookup keys, but cached extensionless
TeX and Lua lookups in the same flat `/tex/luavlna` file. Portuguese polyglossia
loads both `luavlna.lua` and `luavlna.tex`; Lua source was then read by `\input`
and typeset, producing 50 misleading package diagnostics. The almost wrong
conclusion was that the UI had misattributed a document error or removed its
source link. The raw transcript showed `l.1 -- Module luavlna`, and the cached
`.sty` showed `\input luavlna`. Keep `.tex` and `.lua` on the worker's physical
cache filenames, including preloads. The local bootstrap compatibility hook
does this without altering the verified downloaded assets or their hashes;
the SDK unit and a real Portuguese polyglossia fixture pin both paths.

**An error names the right `.tex` file but has no line or clickable source link, although the raw log has `l.19 \header`**
The SDK's error parser searches only five lines after `! ...`. Ordinary LaTeX
help text can already put the pointer farther away. The missing line is not
proof that the compiler supplied none. Recover the pointer inside that error's
own block; stop at another error or warning, preserve an existing SDK line,
and consume repeated-message pointers in order before deduplicating. A raw
transcript from the reported project exposed this after the Lua cache problem
was fixed. Do not invent a source file for internal package errors.

**A class's logo or QR image is reported missing even though the image exists beside the main file**
The bounded snapshot follows declared references instead of copying the whole
directory. `\customimage{qr.png}` and a class constant `{ school_logo }` hide
the filename from the normal `\includegraphics` scan. Comparing the snapshot's
file list with the existing files revealed the omission; the almost wrong
conclusion was that the reader had a missing image. File-like literal graphics
arguments/defaults now pass through the same root, symlink and size checks as
ordinary graphics references. Comments, literal examples and unnamed sibling
images stay excluded; computed TeX filenames still are not evaluated.

**The diagnostic jump works but the source line stays gray instead of pink**
Clicking a diagnostic makes its line CodeMirror's active line. The theme's
active-line background outranked `.cm-latex-error-line`; a probe that only
checked for a nontransparent background falsely passed with
`rgba(255, 255, 255, 0.05)`. Inspect the actual computed color, not just the
presence of the mark class. Scope the diagnostic wash to
`.cm-editor .cm-line.cm-latex-error-line` so it wins over active-line styling,
and verify that its red channel exceeds green and blue in light/dark themes.

**The partial-PDF test reports `this failure returned no partial PDF` while the preview is still rendering it**
Logs are published before the asynchronous PDF render completes. Waiting only
for `.typst-error` let the suite sample `data-latex-partial` too early and skip
all partial-save checks. This almost looked like the compiler had stopped
returning PDF bytes. Wait for the compiler action to return from Cancel to
Compile as well as the error log before checking the committed partial output.
