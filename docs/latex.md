# LaTeX in MDraft

MDraft edits `.tex` documents as a first-class language: syntax colouring, `%`
comments, an outline read from the sectioning commands, LaTeX-aware spelling
skips, `\includegraphics` on image paste, and the compiled PDF in the preview.
Compilation runs either in the **bundled TeX distribution** (LuaLaTeX, or pdfLaTeX
and XeLaTeX on request, compiled to WebAssembly), which needs no TeX installation, or in a TeX distribution the reader has already installed and
explicitly selected.

LaTeX is **opt-in**. Open a saved `.tex` file and choose **Enable bundled TeX** in
the preview, or tick the switch in *Preferences › LaTeX*. That action downloads
about 20 MiB of TeX Live 2026 engine files, each verified against a pinned SHA-256
digest. The TeX packages and fonts a document needs are fetched on demand from a
pinned TeX Live 2026 package snapshot and cached locally, in a folder named for
that snapshot. Nothing about your document or bibliography leaves this device.

An engine installed by an earlier MDraft (TeX Live 2025) is not replaced
automatically. The preview and *Preferences › LaTeX* report it as missing or out
of date; press **Retry setup**, or turn the switch off and on, to download the
2026 files. Only the files that changed are fetched. Packages cached for 2025 are
never read by the 2026 engine. They still count toward the cache limit, are
evicted first, and are removed by *Clear package cache*.

**Switching the bundled engine's TeX Live year (developers).** The year is one line,
`"active"`, in `src-tauri/latex-engine.json`, which holds a profile for 2025 and for
2026: the engine release, the package-mirror revision and the SHA-256 and size of each
file. Rust and TypeScript both read it, and everything else is derived from it: the
asset URL, the mirror, the download size in the messages, and the shim folder
`public/wasmtex/<year>/`, whose worker files are identical in every year and read their
year from their own URL. After changing the line, `npm run tauri dev` (or a build)
picks it up; the engine then reads as out of date until you press **Retry setup**,
which fetches only the files whose digest differs. Each year keeps its own package
cache, so switching back finds the earlier one warm. The 2025 profile is the exact
pin MDraft shipped before TeX Live 2026, not a newer 2025 snapshot. To add a year,
add a profile and a `public/wasmtex/<year>/` folder with copies of the two shims;
`cargo test --lib latex::` and `node scripts/latex-sdk-unit.mjs` fail if either is
missing, if a profile ships a different set of files, or if a derived value disagrees
with its year. The README, the site and this page describe the shipped default
(2026, about 20 MiB).

An installed distribution is a second, independent choice. It is off by default
and never chosen automatically, because it runs a program outside the bundled
engine's WebAssembly environment. *Preferences › LaTeX* finds one (metadata
only), validates it by compiling a probe with it, and only then offers the
switch. The two backends keep separate settings and caches:
turning one off does not disturb the other.

## What the preview does

The preview draws the PDF the compiler produced, with the real page size,
margins and layout. Text in it is selectable, so it can be copied. In Split
view, selecting prose highlights the corresponding words in the other pane;
clicking an unambiguous passage reveals its source. Sync Scroll uses the same
accepted text matches. Words in standard `verbatim` and `verbatim*` environments
are matched literally. A simple inline or displayed equation can highlight as
one atomic region when its safe literal tokens identify one unique PDF
occurrence. Macro-expanded math, figures, generated text and ambiguous or
unsupported LaTeX may not have a match.

MDraft does not request or consume SyncTeX for this correspondence. If the
document explicitly enables SyncTeX, LuaLaTeX may still create it in its
temporary virtual filesystem; MDraft ignores it.

The main file is the compilation root, and it stays the root while an included
chapter is open. Changes in any open project file are compiled without saving
first.

**How the live preview keeps up.** The bundled engine stays loaded between
compiles of the same project, so an edit pays only for the files that changed
and the typesetting:
- After you pause typing (60–200 ms, following your own rhythm), the newest
  text compiles.
- A compile that is already running is never thrown away because you typed; the
  newest revision runs as soon as it finishes.
- During a long stretch of typing, the preview still updates at least every
  1.5 s.
- A result that is older than what you have typed is shown as "Out of date ·
  Updating…". Export, print and source navigation wait for the current
  result.
- The engine also keeps snapshots ("checkpoints") just before the paragraph
  you are editing. A later edit there resumes from the snapshot instead of
  re-reading the preamble and every page above.

These are the reasons the engine download includes a second, checkpoint-capable
engine build. In a fixture with 15 pages, a chapter edit appears in under 0.6 s;
in one with 105 pages, in about 1.5 s. The measurements and their method are in
[the live-preview plan](plans/2026-11-12-latex-compile-cost.md).

**The main document of a chapter.** A chapter opened on its own compiles through
its main file when MDraft can tell which one that is. The first rule that
applies wins:
1. A `% !TeX root = ../main.tex` line in its first 20 lines (the convention
   TeXstudio and LaTeX Workshop use). The main file opens as a background tab,
   and the chapter stays active.
2. A file with its own `\documentclass` or `\begin{document}` is a main file.
3. A chapter of the project already being previewed stays in that project.

Otherwise the preview says "No main document for this file." and Logs explains
how to add the comment; it does not compile the chapter alone into a cryptic
error.

MDraft also recognizes literal image filenames such as
`\qrcode{qrcode.png}` and file-like class defaults such as `{ school_logo }`.
It does not expand arbitrary TeX to discover computed filenames.

The toolbar above the preview contains Compile/Cancel, Auto-compile, Logs and
Save PDF. **Logs** is a toggle: press it to inspect problems or compiler output
in the full preview area; press it again to return to the same PDF page. Logs
and controls never cover or become part of the rendered document. Typst uses
the same toolbar and log presentation, retaining its Document/Pages choice.

When a build reports errors but produces a readable PDF, MDraft displays that
PDF automatically and labels it **PDF with errors**. Save PDF offers those exact
bytes as `<root>-partial.pdf`; the partial result does not enable successful
PDF export, printing or source correspondence. If no new PDF can be read, the
same project's previous PDF remains visible and is labelled as previous output.
Without usable output, Logs opens to explain the failure.

The preview shows whether its result is out of date and whether LaTeX is
preparing, resolving packages, compiling, or rendering the PDF. **Compile**
starts a build immediately; **Cancel** stops the active compiler. A package
request already handed to the backend may still finish after cancellation.
Warnings from a successful build appear in **Logs** and do not prevent you from
reading or saving the PDF. The compiler output is available there too.

Click a project warning or error to reveal its source line with a light-red
highlight. From Preview-only, this opens Split so the source is visible. An
edit elsewhere does not disable a still-matching location; if the target line
has changed, compile again to update it. Internal package messages without a
matching project source location remain visible in Logs.

*Preferences › LaTeX › Auto-compile* is on by default. Turn it off to compile
only when you select **Compile** in the preview or **Tools › Compile LaTeX**.
Saving does not start a build in manual mode; the preview remains marked out of
date until you compile. The document and all open included files are compiled
from their current buffers, including unsaved changes.

An automatic build is skipped when nothing it would read has changed. MDraft
fingerprints every file of the project (open buffers included) and the local
libraries before each build; when the fingerprint, the main file and the engine
match the PDF on screen, the preview says **Up to date** instead of compiling.
That covers saving a file the preview already showed, undoing an edit, and moving
between chapters of the same project. **Compile** always builds.

## Choosing the engine

The bundled distribution compiles with **LuaLaTeX** unless a project asks for
another engine. It can also compile with **pdfLaTeX** and **XeLaTeX**. The
first rule that applies decides:

1. A magic comment in the main file, such as `% !TeX program = pdflatex`.
   TeXstudio and LaTeX Workshop read the same line.
2. The project's own choice. Click the engine name in the status bar (it
   shows while a LaTeX document is open) and pick an engine. The choice is
   remembered for that main document. **Use the Preferences default**
   forgets it.
3. *Preferences › LaTeX › Default engine*: LuaLaTeX (the default), pdfLaTeX,
   XeLaTeX, or Auto. Auto reads the preamble:
   - Lua code → LuaLaTeX;
   - `fontspec`, `unicode-math` or XeTeX-only packages → XeLaTeX;
   - anything else → pdfLaTeX.

The status-bar chip always names the engine in use and, in its tooltip, why.
When a magic comment decided, the chip offers no choice; if the engine it
names has not been downloaded yet, the chip offers that download.

pdfLaTeX (about 8 MB) and XeLaTeX (about 9 MB, with its dvipdfmx converter) download the first time a
project chooses them. They come from the same pinned release as LuaLaTeX and
are verified against SHA-256 digests in the same way. MDraft never compiles
with an engine other than the one shown. If the chosen engine has not been
downloaded, the preview says so, and the chip downloads it. If the document
needs something the chosen engine lacks, such as Lua code under pdfLaTeX, the
status line says so.

LuaLaTeX alone resumes from heap checkpoints, so it has the fastest live
preview on long documents. pdfLaTeX and XeLaTeX use the engine's own
incremental compile.

**TikZ figures.** A document that calls `\tikzexternalize` has its figures
rendered once and reused while you edit the text. To get the same for a
document that loads TikZ without calling it, add
`% !WASMTEX tikz-externalization = auto` near the top. Each text edit is then
about 0.1 s faster. The cost is a slower first compile and several hundred MB
more memory, which is why this is not the default.

## Installed TeX distributions

*Preferences › LaTeX* has a separate **Installed TeX distribution** group. It is
off by default. **Find installation…** searches `PATH` and the standard TeX Live,
MacTeX and MiKTeX locations by reading directory entries; **Browse…** opens a
folder picker for a portable installation. Neither step starts an engine.

**Validate** is the explicit action that may execute external code. It:

1. runs `--version` for each engine and auxiliary tool the directory contains;
2. compiles a one-page probe through the same staging a real build uses; and
3. saves the directory only when the probe produced a readable PDF.

The selected directory must contain `lualatex`, `pdflatex` or `xelatex`. The
engine choice offers **Auto** (which recognises only the `% !TEX program` values
LuaLaTeX, pdfLaTeX and XeLaTeX, then prefers LuaLaTeX) and the engines actually
present. A missing individual tool is reported when it is needed; an otherwise
usable installation is not rejected for lacking an unrelated one.

A native build stages the same bounded project snapshot as the bundled engine
into an app-owned private directory, and runs there. Generated files — the PDF,
`.aux`, `.log`, `.bbl` and the font cache — never enter your project. MDraft
runs the selected engine directly, reruns for cross-references, and runs BibTeX
or Biber when the document asks for one and the tool is present. `latexmk` is
not invoked: it builds its own command strings and starts helpers outside the
flags MDraft controls, so the bounded direct runner is the controlled route.
Shell escape is disabled. MiKTeX's package installer is left enabled: a missing
package can be downloaded by MiKTeX itself during the compile. TeX Live's
packages are managed by its own `tlmgr`, so a missing package produces TeX
Live's own error until you install it with that tool.

**Network and trust.** The installed engine is a separate program that you
chose. It runs with your operating-system permissions, and its package manager
may use the network to install its own packages; MDraft does not control,
monitor or proxy that traffic. MDraft itself makes no network request to start a
native compile. Only use a trusted installation and trusted documents. Shell
escape and project-supplied executables remain disabled, and a native job never
compiles inside your project directory. The bundled engine remains the fully
local choice for readers who do not opt in.

The installed distribution owns its packages and cache. MDraft's *Clear package
cache* and *Cache limit* apply only to the bundled engine. If a package is
missing, install it with the distribution's own tools and compile again; MDraft
neither updates the distribution nor downloads its packages.

On Windows, a choice of distribution — even a portable MiKTeX — no longer opens
console windows: every engine, probe and helper runs without one.

### TeX Live inside WSL

On Windows, **Find installation…** also lists your WSL distributions. It reads
the registry only, so nothing starts. **Look for TeX in WSL: <name>…** is the
explicit step that starts that distribution (if it is stopped) and looks for
`lualatex`, `pdflatex` and `xelatex` the way a terminal's `which` does — through
the distribution's `PATH` — and also in `~/.TinyTeX/bin`, `~/texlive/<year>/bin`,
`/usr/local/texlive/<year>/bin/<arch>` and `/opt/texlive`. The whole search is a
single launch inside the distribution; a launch that does not finish is reported
as an error instead of "no TeX found", and one retry covers a distribution that
was still starting. Validation then runs the same version probes and probe
compile, inside the distribution. Repeating the click while that work is in
flight does nothing; the row stays disabled until it settles.

A WSL build stages the project on the Windows side, as usual, and runs the
engine with `wsl.exe --exec` — no shell, no login profile — with an exact Linux
environment and a `PATH` that leaves out the Windows `PATH`. The engine runs as
your Linux user and can read the Windows drives mounted in that distribution.
Cancel and the time limit end the engine inside the distribution too. The first
compile after the distribution stopped takes a few seconds longer while WSL
starts it.

## Local packages

*Preferences › LaTeX › Local packages* sets the folder of custom classes and
packages used by every LaTeX project, with either compilation backend.

MDraft creates `texmf/tex/latex/local` inside its settings folder on first
launch. New profiles use it automatically with **Folder of packages** layout:
put your `.sty` and `.cls` files there, in subfolders if desired. **Open** opens
the displayed folder; **Choose folder…** selects another location. Cancelling
or choosing an unreadable folder leaves the previous choice intact. Nothing is
copied or moved. A portable build resolves the default folder beside its settings.

**Layout** offers **Folder of packages** or **TEXMF tree**. For the default
hierarchy, TEXMF mode uses the `texmf` root; the displayed path and Open change
to that root. For a chosen directory, its path is the root for either layout.
An existing tree such as `~/texmf` or
`\\wsl.localhost\<distro>\home\<you>\texmf` can therefore be selected directly.

The status refreshes when you open Preferences, change the folder/layout, or
return from another application. **Retry** appears when a check fails.
**Use local packages** turns the folder off without deleting files. Existing
profiles keep their registered folders, layouts, enablement and search order;
additional registrations are under **Additional folders**, with ordering and
removal in each folder's **⋯** menu. A deliberately empty list stays empty on
restart. There is no separate personal-folder setting.

In a TEXMF tree, give each package its own folder:

    texmf/
      tex/latex/my-package/my-package.sty
      tex/latex/my-class/my-class.cls
      bibtex/bst/my-style/my-style.bst
      fonts/opentype/my-font/MyFont.otf

**Search order:** project files first, then the enabled folders from top to
bottom, then the engine's standard packages. Within a TEXMF tree the
engine-specific directories (`tex/lualatex`, `tex/xelatex`) come before
`tex/latex` and `tex/generic`, as in TeX Live. A folder that provides the same
name as one above it is reported as shadowed, not blocked; two files with the
same name inside one folder are a conflict you have to resolve, because which
one TeX would load is arbitrary.

What a library may contain: classes, packages, `.def`/`.cfg`/`.fd` files and
package data under `tex/`, Lua modules under `scripts/` or `tex/`, BibTeX styles
and databases under `bibtex/`, and fonts under `fonts/` loaded **by file name**
(`\setmainfont{MyFont.otf}`). Not captured: `doc/`, `source/`, `web2c/`, `bin/`,
hidden files, links and junctions, executables, `texmf.cnf`, format dumps and
compiled Lua. Font *family* names of private fonts are not registered.

How each engine sees them — you set no `TEXMFHOME` or `TEXINPUTS` yourself:

| Engine | How the folders are passed | Verified |
| --- | --- | --- |
| Bundled TeX | Through the engine's in-memory file system, searched before its package mirror | classes, packages, `.def`, Lua, fonts, BibTeX |
| TeX Live (Linux, macOS, Windows, WSL) | A private `TEXMFHOME` list in the job | TeX Live 2025: LuaLaTeX, pdfLaTeX; BibTeX |
| MiKTeX | Private `TEXINPUTS`/`BSTINPUTS`/`BIBINPUTS`/`LUAINPUTS`/font paths in the job | MiKTeX 23.1: LuaLaTeX, pdfLaTeX, XeLaTeX; BibTeX |

Every compile reads the enabled folders afresh into a private copy, so a
library is never changed by MDraft, never registered with your distribution,
and never evicted with the package cache. An enabled folder that is missing,
unreadable or too large stops the compile with a message; turn it off to
compile without it. Limits: 8 folders, 4,096 files and 64 MiB together, 32 MiB
per file, 16 levels.

With the bundled engine, a library `.bst` or `.bib` is found when the document
or a class names it literally (`\bibliographystyle{house}`); a computed name is
not. A project file of the same name always wins.

Changing the list, or editing a library file in another program, marks the
preview out of date when MDraft regains focus; auto-compile rebuilds, manual
mode waits for **Compile**. Local class and package names appear in completion
after the next compile, marked *Local*. Exports to other formats never include
library files. **Remove** only takes a folder off the list; it never deletes it.

## The project

The project root is the main file's directory. The application reads the
references the document declares — `\input`, `\include`, `\includegraphics`,
`\bibliography`, `\bibliographystyle`, `\addbibresource`, and local
`\documentclass`/`\usepackage` files, including the `\LoadClass` and
`\RequirePackage` (and `…WithOptions`) loads inside a local class or package —
rather than copying the whole directory tree, and it does not expand
arbitrary TeX macros to discover files. A reference
that escapes the root is an error with a plain message. Literal directories in
the main file's preamble, such as `\graphicspath{{figures/}{images/}}`, are
searched for images too. Macro-expanded paths and directories declared later in
the document are not resolved by the snapshot.

The snapshot is bounded: 256 files, 32 MiB per file, 64 MiB total and 12
directory levels. Hidden directories are skipped. A symlink is skipped with a
named warning instead of aborting the project.

Real BibTeX runs in the bundled engine. **Biber and the full `biblatex` feature
set are not available there**; `biblatex-lite` covers the common cases, and the
limitation is documented rather than silently producing a wrong bibliography. An
installed distribution uses its own BibTeX or Biber when the tool is present and
validated, so a full `biblatex` project can compile natively.

## Exporting

*File › Export › PDF* writes the PDF the preview is currently showing, byte for
byte. It never starts a compile of its own: when the preview is stale the row is
disabled and says why. The preview's own **Save PDF** button writes the same
bytes. The file is named after the project's root `.tex` file even when an
included chapter is the active tab, because that is the document the compile
belongs to.

**Every other format goes through pandoc**, which reads LaTeX with its own
reader. *Export › HTML*, *Export › Markdown* and the configured DOCX, ODT, EPUB
and RTF targets all work on a `.tex` document. Those are formats LaTeX cannot
write itself, so they are a real gain rather than a duplicate route.

*Export › More Pandoc Formats…* opens a searchable list of **every writer the
installed pandoc advertises** — around 77 with pandoc 3.12 — so a pandoc update
adds formats without a settings change. Two rows behave differently:

- **PDF** in that list is the compiled-PDF route, not a conversion. Converting
  LaTeX to Typst for PDF would change the layout and need a second engine.
- **bibtex**, **biblatex** and **csljson** emit citation data, and pandoc's LaTeX
  reader does not carry the entries a `.bib` file holds, so they produce an empty
  result. The row says so instead of handing you a zero-byte file.

A conversion reads the **project snapshot**, not the file on disk: unsaved edits
in the root and in any open `\input` chapter reach the export, and a reference
outside the project root is refused rather than silently read. The snapshot is
copied into a temporary directory, so nothing is ever written back into your
project. A Markdown target rewrites its image links to your own files, and the
HTML writers embed local images, because that temporary copy is deleted when the
export returns.

`--citeproc` runs when the project declares a bibliography, so a `\cite` renders
as text rather than as `[?]`. Pandoc is a converter, not a TeX engine: it drops
what it has no concept of, and the compiled PDF remains the authoritative layout.

Two things are deliberately not offered:

- **PDF (opens browser)** is disabled, because that route re-renders the document
  to HTML and prints that, producing a second layout that would contradict the
  preview. *Export › PDF* writes the compiled bytes instead.
- **PDF (via Typst)** in the configured formats is disabled for LaTeX with the
  same reason, and its label points at the compiled route.

**Printing** prints the compiled PDF. *File › Print* writes the bytes the preview
is holding to a temporary file and opens it in your PDF viewer, which owns the
print dialog. It refuses a stale preview and never starts a compile of its own.

## What is not implemented

- **Folding.** The grammar is a stream tokenizer, which produces no syntax tree,
  so there is nothing to fold. The menu says so rather than offering a control
  that does nothing.
- **Read Aloud.** A LaTeX preview is a PDF canvas, so the command is disabled
  with a reason instead of producing silence.
- **Task lists and GitHub alerts.** LaTeX has no syntax for either; the commands
  are disabled and explain the alternative.

## Formatting

**Format › Document** indents and aligns a `.tex` file with tex-fmt, the same
WebAssembly formatter used for Typst. It is conservative on purpose:

- **Prose is never reflowed.** A paragraph written across several source lines
  stays across those lines, so formatting a version-controlled file produces a
  small diff rather than a rewrite.
- **`verbatim`, `lstlisting`, `minted`, `alltt` and `\verb` are byte-identical.**
  These bodies are literal by definition, and tex-fmt would otherwise convert a
  tab to spaces and collapse blank-line runs inside them — changing what the
  document prints. The bodies are masked before formatting and restored after.
- **Math is not rewritten.** Alignment inside `align` may be adjusted; the
  expressions are not.
- **Formatting twice equals formatting once**, so a second Format changes nothing.

The formatter is a lazily-loaded 537 KiB module: a session that never formats a
`.tex` file does not pay for it.

## Completion

Typing `\` in a `.tex` document opens a list of commands; `\begin{` offers
environments; `\usepackage{` offers packages; `\ref{`, `\cite{` and
`\includegraphics{` offer the labels, citation keys and image paths the project
already uses. **Tab** accepts the highlighted row, and Tab still indents when no
list is open. `Ctrl+Space` opens the list explicitly, and Escape closes it.

**A command that takes an argument inserts its braces.** Accepting `\cite`
produces `\cite{}` with the caret between the braces, `\frac` produces
`\frac{}{}` with the caret in the first pair, and `\section` produces
`\section{}` — the behaviour Overleaf has. Tab then moves to the next argument,
so `\frac` goes numerator, denominator. An optional `[...]` argument is not
inserted: `\includegraphics` produces `\includegraphics{}` with the caret in the
file argument, which is where you almost always want to start. A command with no
argument, such as `\alpha` or `\maketitle`, inserts its bare name.

The braces are what make the next step work: `\cite{}` leaves the brace group
open, so the list of the project's own citation keys appears straight away.
Inserting a bare `\cite` would leave you to type the `{` yourself.

The catalog is bundled — a curated set of commands, environments, packages and
snippets — and nothing in the completion path makes a network request. A label
you wrote earlier in the same document is offered immediately, because the active
buffer is always available; other files are offered when the project snapshot has
been read for the preview. Completion never triggers a compile.

The same layer serves Markdown and HTML. In HTML, tags and attributes are offered
because the HTML grammar already carries its own source; in Markdown the list
opens on the character that begins a construct (a backtick, a bracket, a pipe)
and never in ordinary prose.

*Preferences › Editor › Suggest completions while typing* turns the whole
feature off, which removes the Tab binding with it.

## Cache

Downloaded TeX packages live in the application's data directory and are evicted
least-recently-used when the cache reaches its ceiling. *Preferences › LaTeX*
reports the size, lets you change the ceiling (default 256 MiB), clears the
cache and opens the folder. Clearing deletes only downloaded packages: the engine
is kept, and your documents are never touched.

Turning the switch off stops the engine from serving anything and leaves the
cache inert. It deletes nothing.

## Trying it

[The example project](../samples/latex-project/main.tex) has a chapter, a PNG, math,
`fontspec`, a local `.bib` and real BibTeX citations. *Help › LaTeX Reference*
opens a live document that explains the syntax this application supports, and
compiles with the same engine the preview uses.

## The incremental preview (developer note)

The bundled preview is **TeXpresso**, an incremental engine that typesets to
its own canvases in a frame of its own on the `mdraft-tex` scheme and reports a
source map. Its own `xdvipdfmx` export is the authoritative PDF for Export ›
PDF, Save PDF, Print, the menu state and the Problems list. The default is the
constant `DEFAULT_LATEX_PREVIEW_BACKEND` in `src/latex-backend.ts` and the
hidden `view.latexBackend.texpresso` / `.wasmtex` menu events, not a Preference.
WasmTex is disabled, not deleted: its code and hidden tests remain, but no
reader-facing path installs or selects it. The decisions are recorded in
[the production ADR](adr/2026-11-13-texpresso-production.md) and
[the earlier two-backend ADR](adr/2026-11-13-latex-preview-backends.md); the work
is in [the plan](plans/2026-11-13-texpresso-backend.md).

Every engine file and every TeX Live byte is pinned in
`src-tauri/texpresso.json` and verified on download and on every serve;
`src-tauri/src/latex_texpresso.rs` is the handler and cache. The production
origin is `https://mdraft.webonly.app/`; `scripts/texpresso-origin-server.mjs`
serves the reader's mirror during development, and the test runner points a
launch at it with `MDRAFT_TEXPRESSO_ORIGIN`.

The preview has no second bundled engine to fall back to. A WebView without
JSPI, a project with a non-UTF-8 text file, a project that uses a registered
local TEXMF library, and a frame that stops responding each stop the frame and
name the reason in the status line; pdfLaTeX is not offered for the bundled
preview at all. An installed TeX distribution keeps its own compiler and keeps
pdfLaTeX.

To exercise it:

```powershell
npm run texpresso:unit        # the pure half: protocol, fallbacks, pins
$env:MDRAFT_TEXPRESSO_MIRROR = "T:\texpresso-mirror-2026"
$env:MDRAFT_TEXPRESSO_ENGINE = "T:\texpresso-engine"
node scripts/test-all.mjs --only latex-texpresso --allow-installed
```

The CDP layer starts the local origin itself and skips with one line when the
two variables are missing. The comparison harness takes a backend parameter:

```powershell
$env:MDRAFT_LATEX_PERF_BACKEND = "texpresso"
node scripts/test-all.mjs --only latex-perf-texpresso-book --allow-installed
```

**Linux.** WebKitGTK 2.54 has been run on Debian 13 under WSLg: the application
starts, opens a project and the frame typesets there — the status bar reads
`LuaLaTeX` and the exported PDF is current — so `mdraft-tex://localhost` works
as a secure frame origin on WebKitGTK. The CDP layer and the pointer/scroll
correspondence are WebView2 only; the Linux result is a visual check, recorded
in the handoff.
