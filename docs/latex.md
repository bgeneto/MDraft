# LaTeX in MDraft

MDraft edits `.tex` documents as a first-class language: syntax colouring, `%`
comments, an outline read from the sectioning commands, LaTeX-aware spelling
skips, `\includegraphics` on image paste, and the compiled PDF in the preview.
Compilation runs either in the bundled **LuaLaTeX** engine, which needs no TeX
installation, or in a TeX distribution the reader has already installed and
explicitly selected.

LaTeX is **opt-in**. Open a saved `.tex` file and choose **Enable LuaLaTeX** in
the preview, or tick the switch in *Preferences › LaTeX*. That action downloads
about 10 MiB of engine files, each verified against a pinned SHA-256 digest. The
TeX packages and fonts a document needs are fetched on demand from a pinned
mirror and cached locally. Nothing about your document or bibliography leaves
this device.

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

## The project

The project root is the main file's directory. The application reads the
references the document declares — `\input`, `\include`, `\includegraphics`,
`\bibliography`, `\addbibresource`, and local `\documentclass`/`\usepackage`
files — rather than copying the whole directory tree, and it does not expand
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
