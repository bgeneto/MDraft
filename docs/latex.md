# LaTeX in MDraft

MDraft edits `.tex` documents as a first-class language: syntax colouring, `%`
comments, an outline read from the sectioning commands, LaTeX-aware spelling
skips, `\includegraphics` on image paste, and the compiled PDF in the preview.
Compilation runs either in the **bundled TeX distribution** (a WebAssembly
preview frame), which needs no TeX installation, or in a TeX distribution the
reader has already installed and explicitly selected.

The bundled preview has **two engines behind one frame protocol**:

- **TeXpresso** on Windows, macOS, and Linux with WebKitGTK 2.54 or newer. It
  is the incremental JSPI engine, with LuaLaTeX and XeLaTeX.
- **PhiTeX** on Linux webviews that lack JSPI, including Ubuntu 26.04 LTS and
  26.10 with WebKitGTK 2.52.6. It is a single-threaded WebAssembly incremental
  engine and compiles **XeLaTeX** documents. LuaLaTeX is the one named gap.

The application chooses by webview capability, never by a preference, and the
reader sees the same toolbar, status, page gestures, source mapping, links,
logs and PDF export either way. The only product difference is the LuaLaTeX
sentence: a Lua document in the compatibility preview says so and offers the
installed-TeX route.

LaTeX is **opt-in**. Open a saved `.tex` file and choose **Enable bundled TeX** in
the preview, or tick the switch in *Preferences › LaTeX*. That action downloads
about 15 MB for TeXpresso or 33 MB for PhiTeX: the pinned engine, its formats,
the TeX Live 2026 kernel, fonts and the package index. Every file is verified
against its pinned SHA-256 before it is kept. The TeX packages and fonts a
document needs are fetched on demand from the pinned origin and cached locally.
Nothing about your document or bibliography leaves this device.

An engine installed by an earlier MDraft is reported as missing or out of date;
press **Retry setup**, or turn the switch off and on, to download the files the
selected engine needs. The package cache is shared by both engines and is never
read by a different engine revision.
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

In the bundled preview the engine's own source map answers a gesture on the
page. A click puts the source caret on the clicked character and marks its
source line; a double-click marks the word; dragging marks the dragged words.
Each click is checked against the point that was clicked: when the engine can
only name the line (text a macro produced, for example), the line is marked and
the caret goes to its start, and when it cannot name even that, the paragraph is
marked and the caret stays. A click in the source blinks that line on the page.
A click on a link follows the link instead, as it does in a PDF: a table of
contents entry, a `\ref` or a `\cite` scrolls the preview to its target, and a
web or mail address (`\href`, `\url`) opens outside MDraft. The source stays
where it is.

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
[the live-preview plan](architecture.md).

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

The bundled preview can also give up part-way through a long document. Its
engine's memory is limited, including the record it keeps to resume edits
quickly; a 592-page textbook ran out at about page 452 with XeLaTeX and 428
with LuaLaTeX. MDraft then labels the result
**PDF with errors** and names the page where the engine stopped. Logs explains
that the later pages, the table of contents and anything else LaTeX writes at
the end of the document are missing, and offers the installed-distribution
settings. Save PDF offers the pages typeset so far as `<root>-partial.pdf`;
Export › PDF and Print stay off.

Such a document also costs memory while it typesets. The preview's process
(`mdraft-tex.localhost` in Task Manager) holds the engine's memory, up to
4 GiB, and the preview's index of the pages: about 7 GB at peak on that
textbook. When the engine runs out of memory, MDraft releases it and shows the
pages typeset so far in its own PDF view, without the live preview. On that
textbook the preview's process, which still held about 5 GB, exits within
seconds, and the PDF view of its 452 pages takes about 2 GB. Edits to that
document then mark the preview out of date instead of starting a build, because
every build would start again from page 1 and stop at the same place.
**Compile** or **Recompile from scratch** tries again; after another engine or
an installed distribution is chosen, edits build again. An [installed TeX
distribution](#installed-tex-distributions) has no such limit.

The preview can also stop responding while it prepares the PDF. With XeLaTeX, a
`\setmainfont` that names a font MDraft cannot find sets the text without a
font; on a 106-page book the preview then blocked for good about 6 seconds into
the export, using a full processor core. MDraft asks the preview every 2
seconds whether it is still there. After 30 seconds without an answer it closes
the preview, labels the result **PDF could not be prepared**, and lists the
errors the preview reported, such as the missing font, in Logs; Save PDF, Export › PDF and Print stay off. Edits then wait
for **Compile**, as after running out of memory. The preview's process outlives
it by about 11 seconds, so a Compile in the first 15 seconds shows "Closing the
preview that stopped responding…" before it starts a new preview.

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

### Recompile from scratch

MDraft never writes `.aux`, `.log` or other build files into your project
folder: every build compiles a private copy of the sources. The preview engine
keeps a warm, incremental state between builds, so that the next build is fast.
If the preview seems stuck on an old failure after you fixed the source, or you
want to rule that state out, open the arrow beside **Compile** and choose
**Recompile from scratch**, or use **Tools › Recompile LaTeX from Scratch**.
MDraft then discards the engine's state, the kept results and the logs, and
builds again from the sources alone. The first build afterwards takes as long as
opening the project. Downloaded TeX Live packages and fonts are kept;
*Preferences › LaTeX* clears that cache separately. An installed TeX
distribution keeps a session workspace with its auxiliary files, font caches
and Biber's extracted runtime; this command discards that workspace too. The
next native build is cold (and its first Biber run extracts its runtime again),
while the distribution's own packages are untouched.

## Choosing the engine

The bundled distribution compiles with **XeLaTeX** unless a project asks for
another engine; XeLaTeX starts faster and its format is smaller. TeXpresso can
also compile with **LuaLaTeX**; the PhiTeX compatibility preview cannot. The
first rule that applies decides:

1. A magic comment in the main file, such as `% !TeX program = pdflatex`.
   TeXstudio and LaTeX Workshop read the same line.
2. The project's own choice. Click the engine name in the status bar (it
   shows while a LaTeX document is open) and pick an engine. The choice is
   remembered for that main document. **Use the Preferences default**
   forgets it.
3. *Preferences › LaTeX › Default engine*: XeLaTeX (the default), LuaLaTeX,
   or Auto. Auto reads the preamble:
   - Lua code → LuaLaTeX;
   - anything else → XeLaTeX.

   A document that asks for pdfLaTeX compiles with XeLaTeX, and the chip says
   so: neither bundled preview has pdfTeX. A document that asks for LuaLaTeX on
   a compatibility-preview host says that it needs an installed distribution.

The status-bar chip always names the engine in use and, in its tooltip, why.
When a magic comment decided, the chip offers no choice; if the engine it
names has not been downloaded yet, the chip offers that download.

TeXpresso ships XeLaTeX and LuaLaTeX together; the PhiTeX download ships
XeLaTeX only. MDraft never compiles with an engine other than the one shown. If
the document needs something the chosen engine lacks, such as Lua code under
XeLaTeX or LuaLaTeX in the compatibility preview, the status line says so.

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
LuaLaTeX, pdfLaTeX and XeLaTeX, then prefers XeLaTeX on a new install and
LuaLaTeX for settings from before that change) and the engines actually
present. A missing individual tool is reported when it is needed; an otherwise
usable installation is not rejected for lacking an unrelated one.

A native build runs TeX in the main file's own folder, as a terminal or another
editor would, and writes every output — the PDF, `.aux`, `.log`, `.bbl`, the
recorder's `.fls` and the font cache — to an app-owned private workspace with
`-output-directory`. Nothing is copied out of your folder and nothing is written
into it, so a committed `main.pdf`, `.bbl` or `.aux` is never touched. A file
with unsaved changes is compiled from an overlay folder that TeX searches before
the working directory; a saved file is read where it is. The workspace lasts for
the app session and is reused by the next build, so its auxiliary files, font
caches and Biber runtime are warm; **Recompile from scratch** discards it.

The engine's `-recorder` file lists every file the build opened, and that list
is what the PDF depends on: changing, adding or removing a file the build read,
or adding a file to a folder it read from, compiles again; anything else in the
folder does not. A file the document names with `./` (`\input{./chapter}`) is
looked up in the working directory only, so TeX reads its saved copy even when
the editor holds changes; Problems then says so, at that line. BibTeX and Biber
run beside the outputs, where the declared `.bib` and `.bst` files are
written, and find the rest in your folder.

MDraft runs the selected engine directly, compares the generated auxiliary
files after each pass, and reruns only when they changed. BibTeX or Biber runs
only when the `.bcf`/citation controls, a `.bib`/`.bst` input, or the `.bbl`
itself says it is needed; the first Biber run in a new workspace extracts its
runtime once, and later builds reuse it. An installed engine is a batch
compiler: every build typesets the document from the start. The warm workspace
removes repeated state, but it cannot resume mid-document like the bundled
preview. `latexmk` is not invoked: it builds its own command strings and starts
helpers outside the flags MDraft controls, so the bounded direct runner is the
controlled route. Shell escape is disabled. MiKTeX's package installer is left
enabled: a missing package can be downloaded by MiKTeX itself during the
compile. TeX Live's packages are managed by its own `tlmgr`, so a missing
package produces TeX Live's own error until you install it with that tool.

**Network and trust.** The installed engine is a separate program that you
chose. It runs with your operating-system permissions, and its package manager
may use the network to install its own packages; MDraft does not control,
monitor or proxy that traffic. MDraft itself makes no network request to start a
native compile. Only use a trusted installation and trusted documents. Shell
escape and project-supplied executables remain disabled, and nothing a native
job generates is written into your folder. On Windows the engine starts in your
document's folder, which Windows also searches, after its own system folders,
for a library a program needs and its installation lacks: compile documents from
folders you trust. The bundled engine remains the fully local choice for
readers who do not opt in.

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

A WSL build runs TeX in the document's folder as the distribution sees it on
the mounted Windows drive, with `wsl.exe --cd … --exec` — no shell, no login
profile — an exact Linux environment and a `PATH` that leaves out the Windows
`PATH`; the outputs go to the workspace on the Windows side. The engine runs as
your Linux user and can read the Windows drives mounted in that distribution. A
document on a network share cannot be compiled this way: MDraft says so and
names the alternatives, a Windows distribution or the bundled engine.
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
one TeX would load is arbitrary. In the bundled preview, the Problems list also
warns when a library file is loaded in place of a TeX Live file of the same name
(it can change how every document looks), and when a project file replaces a
library file.

What a library may contain: classes, packages, `.def`/`.cfg`/`.fd` files and
package data under `tex/`, Lua modules under `scripts/` or `tex/`, BibTeX styles
and databases under `bibtex/`, and OpenType/TrueType fonts under
`fonts/opentype/` and `fonts/truetype/` loaded **by file name**
(`\setmainfont{MyFont.otf}`). Not captured: `doc/`, `source/`, `web2c/`, `bin/`,
legacy TeX font trees (`fonts/tfm/`, `fonts/vf/`, `fonts/type1/`, `fonts/enc/`,
`fonts/map/`, `fonts/afm/`), hidden files, links and junctions, executables,
`texmf.cnf`, format dumps and compiled Lua. Font *family* names of private fonts
are not registered.

How each engine sees them — you set no `TEXMFHOME` or `TEXINPUTS` yourself:

| Engine | How the folders are passed | Verified |
| --- | --- | --- |
| Bundled TeX (preview frame) | Copied into the preview's project under a reserved `.mdraft-texmf` folder, with a manifest of the names each file answers; the frame resolves a name after the project and before TeX Live, case-insensitively as a fallback | classes and their packages for the selected engine; TeXpresso runs no BibTeX, PhiTeX runs BibTeX inside the build |
| TeX Live (Linux, macOS, Windows, WSL) | A private `TEXMFHOME` list in the job | TeX Live 2025: LuaLaTeX, pdfLaTeX; BibTeX |
| MiKTeX | Private `TEXINPUTS`/`BSTINPUTS`/`BIBINPUTS`/`LUAINPUTS`/font paths in the job | MiKTeX 23.1: LuaLaTeX, pdfLaTeX, XeLaTeX; BibTeX |

Every compile reads the enabled folders afresh into a private copy, so a
library is never changed by MDraft, never registered with your distribution,
and never evicted with the package cache. An enabled folder that is missing,
unreadable or too large stops the compile with a message; turn it off to
compile without it. Limits: 8 folders, 4,096 files and 64 MiB together, 32 MiB
per file, 16 levels.

TeXpresso's preview runs no BibTeX, so a library `.bst` or `.bib` is not used
there; PhiTeX runs BibTeX inside its build, and an installed distribution runs
BibTeX with them. A library `.bib` or `.bst` is found when the document or a
class names it literally (`\bibliographystyle{house}`).

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

The snapshot sends the main file, every open buffer and the files the document
declares ahead of the build: up to 256 files, 32 MiB per file and 64 MiB in all.
That is a budget for what is sent ahead, not a limit on the project: a declared
file past it is read when TeX opens it. Hidden directories are skipped. A
symlink is skipped with a named warning instead of aborting the project.

Nothing lists your folder as a whole, and no folder's size, depth or
permissions can stop a compile: a document in `C:\`, on the Desktop or in
Downloads compiles like any other, and a build costs what the document reads. A
file that cannot be read is reported by name, with the reason.

The TeXpresso preview fetches what the snapshot did not send when the engine
opens it. The frame holds listings of the main file's folder and of every folder
an earlier build looked in — each folder's own names, never its subfolders'
contents — so a name TeX tries in the project first, such as a package or a
font, is ruled out without a request. A folder below them is listed when TeX
first names a file inside it; a folder of more than 10,000 names is listed in
part, and a name it cannot rule out is asked for. A file that exists is fetched,
by its exact spelling, from the same `mdraft-tex` origin through a per-frame
capability (`/project/<token>/...`); the route refuses traversal, links and
files outside the folder, files above 128 MiB (a limit of the bundled engine,
which the message names), and more than 1 GiB per session. This is what makes
fontspec `Path=` fonts, `\subfile`, `\includepdf`, `\lstinputlisting`,
pgfplots tables and files a local class loads work without extending the
predictor. The eager snapshot remains the preload hint for SyncTeX and the
outline. Installed TeX needs none of this: it reads the folder itself.

Whether a stored PDF is still current is decided from what the builds read:
each file a build opened is checked by size and modification time, and each
folder it looked in by its names. A file modified within three seconds of being
read counts as changed until it is read again, so a save in the same instant is
never missed.

Real BibTeX runs in the bundled engine. **Biber and the full `biblatex` feature
set are not available there**; `biblatex-lite` covers the common cases, and the
limitation is documented rather than silently producing a wrong bibliography. An
installed distribution uses its own BibTeX or Biber when the tool is present and
validated, so a full `biblatex` project can compile natively.

## Exporting

*File › Export › PDF* writes the PDF the preview is currently showing, byte for
byte. It never starts a compile of its own: when the preview is stale the row is
disabled and says why. The preview's own **Save PDF** button writes the same
bytes. Both run the after-export options (open the file, open its folder,
run a command) once the file is written. The file is named after the project's root `.tex` file even when an
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
reports the size, lets you change the ceiling (default 512 MiB), clears the
cache and opens the folder. Clearing deletes only downloaded packages: the engine
is kept, and your documents are never touched. A ceiling still at the old
256 MiB default is raised to 512 MiB once; set it again afterwards and it stays.

The preview never evicts a file the open document is using: evicting it would
only make the next compile download it again. When one document alone needs
more than the ceiling, the preview says so and suggests raising it.

### Missing fonts and runaway downloads

On the **TeXpresso path**, a missing LuaLaTeX font used to make luaotfload
rebuild its font index by reading every font in TeX Live: about 3,300 downloads
and 1 GB, repeated on every compile. The preview turns that rebuild off (it adds
a `luaotfload.conf` with `update-live = false` to its own copy of the project,
unless the project has one), so a missing font now fails at once with
fontspec's "cannot be found" error. The PhiTeX compatibility preview has no Lua
font loader; a missing XeLaTeX font fails at the font/package lookup. Fonts of
your own are found by file name, from a local library or the project.

Fonts that are part of TeX Live are found by family name with both engines, as
in `\setmainfont{TeX Gyre Pagella}`. LuaLaTeX finds them through the font index
the preview ships. The preview's XeLaTeX has no font index, so for each TeX Live
family a document names in a fontspec command (`\setmainfont`, `\newfontfamily`,
`\babelfont`, `\setmathfont` and the like, in the project or a local library),
the preview adds a `<Family>.fontspec` file to its own copy of the project. That
file names the family's files; your folder is not changed, and a `.fontspec` of
the same name in the project, a local library or TeX Live is used instead. Some
limits:

- Each style uses the family's 10 pt design at every size, so an optical-size
  family such as Latin Modern can differ slightly from an installed TeX, which
  picks the design for each size.
- A family named through a macro of your own, or in a file the project only
  fetches on demand, is not found this way: name it by file instead
  (`\setmainfont{lmroman10-regular.otf}`).
- The PhiTeX compatibility preview receives the same files, but family names
  have not been checked there.

On TeXpresso, as a backstop, the preview pauses a download that would pass 100
font files, 1,500 files or 750 MB in one session and asks whether to continue. Continue
lets it go on (and asks again only after twice as much); *Stop downloads* ends
this preview session's downloads, and the status line says so until the
preview restarts.

Turning the switch off stops the engine from serving anything and leaves the
cache inert. It deletes nothing.

### Fonts the preview cannot load

When the preview's renderer cannot load a font, the text set in it is blank in
the preview, and Logs names the font in a warning. The XeLaTeX preview draws
*virtual fonts* — the families pdfLaTeX-era documents select through `fontenc`,
such as T1 Times (`mathptmx`, `times`) and Charter (`\fontfamily{bch}`) — since
MDraft moved to TeXpresso release 0.2; earlier builds left their text blank.

## Trying it

[The example project](../samples/latex-project/main.tex) has a chapter, a PNG, math,
`fontspec`, a local `.bib` and real BibTeX citations. *Help › LaTeX Reference*
opens a live document that explains the syntax this application supports, and
compiles with the same engine the preview uses.

## The incremental preview (developer note)

The bundled preview is **one frame protocol with two engines**:

- **TeXpresso** is the production engine on Windows, macOS and Linux with
  WebKitGTK 2.54+. It is a JSPI build: the frame's glue wraps its asynchronous
  imports and exports in `WebAssembly.Suspending` and `WebAssembly.promising`.
- **PhiTeX** is the Linux compatibility engine for WebKitGTK without JSPI
  (Ubuntu 26.04/26.10 ship 2.52.6). It runs `core1.wasm` (the single-threaded
  `wasm32-wasip1` build) in a worker. Its host uses JSPI only when the webview
  has it; without JSPI a build runs to its end and remains incremental.

Both engines are drawn in an iframe on `mdraft-tex://localhost`
(`/texpresso/` or `/phitex/`) and speak the same `TexpressoSession` protocol:
project, edits, selection, reveal, zoom, theme, export and dispose go in;
acknowledgements, status, paint, source, links and viewport come out. The host's
preview UI, wait surface, source gestures, export and print do not fork. The
engine is selected by `latexPreviewBackend()` in `src/latex-backend.ts` from
`WebAssembly.Suspending` + `promising`, the Linux user agent and the presence of
the frame capabilities; there is no reader-facing backend control.

**TeXpresso's** engine and TeX Live data are pinned in `src-tauri/texpresso.json`
and served by `src-tauri/src/latex_texpresso.rs`. Every file is verified on download and on every
serve. The frame resolves every file the engine opens by name — the project's
files, then the local library, then the TeX Live bundle — through the patched
`ocaml-worker.js` described below. The Linux JSPI row (Debian 13, WebKitGTK
2.54) is the tested TeXpresso path.

The pinned release asks its own hook,
`texpresso_project_file`, for a project file the snapshot did not send, and the
shell's `worker.js` answers it from the folder listings and the project route.
`scripts/texpresso-patch-worker.mjs` turns the release's `ocaml-worker.js` into
the pinned one with six anchored edits:

- a name the folder listings do not rule out is offered to that hook again
  after a miss, so a file created later is found; the worker remembers what the
  route did not find until a listing changes;
- the local libraries answer after the project and its folders and before the
  bundle, and report a library file that replaces a TeX Live one;
- the case-insensitive lookup checks the folder listings, then the libraries;
- the export's `xdvipdfmx`, which never asks for that lookup, gets its answer
  after an exact miss everywhere;
- after `retcon_trail: the arena is full` the worker reports the failure
  instead of restarting from scratch. The retry stopped at the same page every
  time, and while it ran the frame's process held the first engine's memory as
  well: on the 0.2 build's 452-page run, 11.1 GB at peak instead of 7.4 GB. Out
  of memory at the heap cap still retries once.

Since MDraft 0.9.8, the pinned build also fixes the old long-document stop on drawings and plots:
upstream reports it, and a 592-page `infdesc` project reached its final page
(576 pages in the preview's counter) in about 90 s under XeLaTeX in the public
editor, where the 0.2 build stopped near page 452. The 4 GiB heap cap is
unchanged; the engine retains less memory and answers completion queries from
logs. MDraft's release validation repeats the run through its own frame.

A new release means re-anchoring the edits, re-pinning, and uploading under its
own `engine/<appRelease>/` keys. The bundle list `tt2026/v4.lst` names the same
163,011 files as `v3`, in another order, so its digest table has a key of its
own, `digests-v4.bin`. Both readers of the list skip the `=` prefetch lines that
v4 appends after the names. The release's prefetch packs (`files/packs/…`) are
not mirrored; the engine then fetches each file alone, as before.

**PhiTeX** is pinned as one archive in `src-tauri/phitex.json`: `core1.wasm`,
the XeLaTeX format, the TeX Live kernel files, fonts, shims, the `minted`
Pyodide runtime and wheels, the Shelf index and release table. `src-tauri/src/latex_phitex.rs` downloads the archive once,
verifies the whole SHA-256, extracts it under the app data directory and serves
`/phitex/` from the same origin. The shell (`src-tauri/phitex-shell/`) is
embedded: `index.html`, the bridge `main.js` and the single-thread
`engine-worker.js`. The worker's Shelf host is the frame's own origin, so the
frame policy stays `connect-src 'self'`; Rust fetches and caches the packs from
the pinned Shelf release, and the core checks each against the release's pack
table again. The archive's SHA-256 is the trust root.

**Selection.** `latexPreviewBackend()` returns `texpresso` when JSPI is
present. On Linux without JSPI it returns `phitex` when the frame can compile
wasm, run a module worker and gunzip a format (all true on WebKitGTK 2.52);
otherwise the status line names the missing capability. The frame's `ready`
message carries `backend`, and the host only applies the TeXpresso JSPI check to
a TeXpresso frame. On PhiTeX, a LuaLaTeX document gets the `lua` reason; a
project that is not UTF-8 or that uses the reserved `.mdraft-texmf` folder gets
the same named reasons as TeXpresso.

**Install and cache.** Enabling bundled TeX runs `install_texpresso` or
`install_phitex` according to the same selection, and downloads only that
engine. `latex_engine_status` reports both installations; the host reads the one
the webview can run. The package cache is shared by the two engines' transports,
is bounded by *Preferences › LaTeX › Cache limit* and is cleared by **Clear
package cache**. The PhiTeX archive is `phitex-1.0.1-engine870e9ac-minted.zip`
(release `2026`); the pinned viewer source is the public frontends revision in
`src-tauri/phitex-shell/vendor/README.md`, and the engine source is the pinned
PhiTeX revision recorded in the plan and ADR. The source offer and the PhiTeX
AGPL notices are in *Licences and source*.

**What the fallback does not do.** LuaLaTeX is absent from the compatibility
engine, and `biber`/`xindy` are not available. A document that needs one fails
with a named message, never a silently wrong PDF; an installed TeX
distribution is the route. `minted` is available through the bundled Pyodide
runner, and XeLaTeX colour and microtype run in the engine. TeXpresso keeps
its full engine and remains the default wherever JSPI exists.

To exercise it:

```powershell
npm run texpresso:unit        # the pure half: selection, fallbacks, protocol, pins
$env:MDRAFT_TEXPRESSO_MIRROR = "T:\texpresso-mirror-2026"
$env:MDRAFT_TEXPRESSO_ENGINE = "T:\texpresso-engine"
node scripts/test-all.mjs --only latex-texpresso --allow-installed
```

The TeXpresso CDP layer starts the local origin itself and skips with one line
when the two variables are missing. The performance harness measures the frame:

```powershell
node scripts/test-all.mjs --only latex-perf-texpresso-book --allow-installed
```

**Linux matrix.** The bundled preview is tested on:

| Webview | Result |
|---|---|
| Debian 13 / WebKitGTK 2.54 | TeXpresso: starts, typesets, click/selection/links, export; JSPI present |
| Ubuntu 26.04 LTS / WebKitGTK 2.52.6 | PhiTeX: installs, typesets (single-thread), pages, click/double-click/selection, logs and export; JSPI and `SharedArrayBuffer` absent |
| Ubuntu 26.10 / WebKitGTK 2.52.6 | Same as 26.04; the package is the 2.52 security line |

The Linux run is a real WebKitGTK run (WSLg or native), not a Chromium
substitute: the PhiTeX engine's single-thread path is the point of the matrix.
The CDP pointer/scroll suite is WebView2-only; the Linux check uses the frame
harness and the visual/export checks recorded in the plan.
