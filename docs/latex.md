# LaTeX in MDraft

MDraft edits `.tex` documents as a first-class language: syntax colouring, `%`
comments, an outline read from the sectioning commands, LaTeX-aware spelling
skips, `\includegraphics` on image paste, and the compiled PDF in the preview.
Compilation runs **LuaLaTeX** locally through WebAssembly, so no TeX
installation is required.

LaTeX is **opt-in**. Open a saved `.tex` file and choose **Enable LuaLaTeX** in
the preview, or tick the switch in *Preferences › Export*. That action downloads
about 10 MiB of engine files, each verified against a pinned SHA-256 digest. The
TeX packages and fonts a document needs are fetched on demand from a pinned
mirror and cached locally. Nothing about your document or bibliography leaves
this device.

## What the preview does

The preview draws the PDF the compiler produced, with the real page size,
margins and layout. Text in it is selectable, so it can be copied. Clicking an
unambiguous location opens the source line that produced it; that is line and
region navigation through SyncTeX, not exact word mapping.

The main file is the compilation root, and it stays the root while an included
chapter is open. Changes in any open project file are compiled without saving
first.

A compile error appears above the preview with the compiler's own message and
the line it refers to. The last successful PDF stays on screen, so a
half-finished edit does not blank the page.

## The project

The project root is the main file's directory. The application reads the
references the document declares — `\input`, `\include`, `\includegraphics`,
`\bibliography`, `\addbibresource` — rather than copying the whole directory
tree, and it does not expand arbitrary TeX macros to discover files. A reference
that escapes the root is an error with a plain message.

The snapshot is bounded: 256 files, 32 MiB per file, 64 MiB total and 12
directory levels. Hidden directories are skipped. A symlink is skipped with a
named warning instead of aborting the project.

Real BibTeX runs. **Biber and the full `biblatex` feature set are not
available**; `biblatex-lite` covers the common cases, and the limitation is
documented rather than silently producing a wrong bibliography.

## Exporting

*File › Export › PDF* writes the PDF the preview is currently showing, byte for
byte. It never starts a compile of its own: when the preview is stale the row is
disabled and says why. The preview's own **Save PDF** button writes the same
bytes.

Native printing is disabled for LaTeX, because the PDF already exists. There is
no pandoc route for a `.tex` document: it has its own compiler, and a second,
differently-laid-out PDF behind the same document would contradict the preview.

## What is not implemented

- **Folding.** The grammar is a stream tokenizer, which produces no syntax tree,
  so there is nothing to fold. The menu says so rather than offering a control
  that does nothing.
- **Format Document.** A formatter is planned; until it lands the command is
  disabled with a reason.
- **Read Aloud.** A LaTeX preview is a PDF canvas, so the command is disabled
  with a reason instead of producing silence.
- **Task lists and GitHub alerts.** LaTeX has no syntax for either; the commands
  are disabled and explain the alternative.
- **Bidirectional Sync Scroll.** Click navigation works; scroll correspondence
  does not.

## Completion

Typing `\` in a `.tex` document opens a list of commands; `\begin{` offers
environments; `\usepackage{` offers packages; `\ref{`, `\cite{` and
`\includegraphics{` offer the labels, citation keys and image paths the project
already uses. **Tab** accepts the highlighted row, and Tab still indents when no
list is open. `Ctrl+Space` opens the list explicitly, and Escape closes it.

The catalog is bundled — a few hundred curated commands, environments, packages
and snippets — and nothing in the completion path makes a network request. A
label you wrote earlier in the same document is offered immediately, because the
active buffer is always available; other files are offered when the project
snapshot has been read for the preview. Completion never triggers a compile.

The same layer serves Markdown and HTML. In HTML, tags and attributes are offered
because the HTML grammar already carries its own source; in Markdown the list
opens on the character that begins a construct (a backtick, a bracket, a pipe)
and never in ordinary prose.

*Preferences › Editor › Completion* turns the whole feature off, which removes the
Tab binding with it.

## Cache

Downloaded TeX packages live in the application's data directory and are evicted
least-recently-used when the cache reaches its ceiling. *Preferences › Export*
reports the size, lets you change the ceiling (default 256 MiB) and clears the
cache. Clearing deletes only downloaded packages: the engine is kept, and your
documents are never touched.

Turning the switch off stops the engine from serving anything and leaves the
cache inert. It deletes nothing.

## Trying it

[The example project](../samples/latex-poc/main.tex) has a chapter, a PNG, math,
`fontspec`, a local `.bib` and real BibTeX citations. *Help › LaTeX Reference*
opens a live document that explains the syntax this application supports, and
compiles with the same engine the preview uses.
