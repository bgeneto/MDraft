# Experimental LuaLaTeX proof of concept

This branch evaluates a small, local LaTeX workflow; it is not a release or a
claim of general TeX Live compatibility. Open a saved `.tex` file in its own
project directory and choose **Enable LuaLaTeX** in the preview. That action
downloads the engine once. The preview then compiles with **LuaLaTeX**, renders
the PDF with MDraft's existing PDF.js page viewer, and offers **Save PDF**.
Clicking an unambiguous PDF location opens the corresponding
project source line. The main file remains the compilation root while an
included file is opened through SyncTeX.

Try [the example](../samples/latex-poc/main.tex), which has a chapter, PNG,
math, `fontspec`, a local `.bib` and real BibTeX citations. Changes in open
project files are included without saving. The project snapshot is limited to
256 supported files, 32 MiB per file, 64 MiB total and 12 directory levels.
Hidden directories are skipped; symlinks and paths escaping the root are
rejected. The PoC recognizes literal project-relative `\input`, `\include`,
`\includegraphics`, `\bibliography` and `\addbibresource` references.
It reports missing or unsupported references, rather than expanding arbitrary
TeX macros to discover project files.

**Insert and Format commands for LaTeX are deferred.** Unsupported markup
actions are disabled or guarded; plain editing, paste, save and undo remain.
The preview only navigates when SyncTeX identifies an unambiguous source line.
This is line/region navigation, not a promise of exact word mapping. The
existing word/range selection correspondence and bidirectional Sync Scroll
behaviour are not yet implemented for LaTeX. The
experimental compiler uses a pinned internal WasmTex worker read to obtain
LuaLaTeX's compressed SyncTeX output because the selected SDK does not expose
that output through its public LuaLaTeX result.

## Downloads and offline use

Enabling the experiment is the first network action. MDraft downloads eight
engine and format files, checks each against a pinned SHA-256, and stores them
under its own application data directory. Thereafter it fetches missing
package and font files from a fixed TeX Live mirror as the document needs
them, caching successful responses on disk up to 256 MiB. This PoC does not
yet provide cache eviction or a cache-management interface. The document and bibliography
contents are not uploaded. Package and font names occur in the mirror request
URLs. There is no TeX network traffic at startup, before enablement, or merely
because another markup is opened.

A project can be recompiled offline **only after all its required engine,
format, package and font files have been cached**. An unseen package requires
network access. This is not a complete TeX Live installation or a `tlmgr`
implementation. The mirror revision is pinned, but this PoC does not verify
individual package/font files against an independent per-file digest.

BibTeX is run locally. Full Biber is outside the experiment. In the separate
`biblatex-lite` example, the selected SDK produced a PDF but reported an
invalid `.bbl` and an empty bibliography. MDraft reports this failure instead
of treating that PDF as a resolved bibliography. The fallback is a limited
approximation and is not Biber.

## Provenance and licences

The SDK snapshot is
[`f85a1d3cec1c0598`](https://github.com/corca-ai/wasmtex/releases/tag/snapshot-f85a1d3cec1c0598),
archive SHA-256 `f85a1d3cec1c05986f225c839204162d4d94dcb1bfd814a944e8183b64068809`.
The selected engine release is
[`2025-3a6c0df0b2b95005`](https://corca-ai.github.io/wasmtex/wasmtex/2025/manifest.json);
its manifest SHA-256 is
`928bd4b75ff945ffe3b782da99a61b89ee4c38fcda8ccb5c0390aafda3d12b4a`.
The exact
[corresponding engine source archive](https://github.com/corca-ai/wasmtex/releases/download/engine-2025-3a6c0df0b2b95005/wasmtex-2025-3a6c0df0b2b95005-source.tar.xz)
has SHA-256
`34529fcbdf887731d229fe8e25acacf862d04115cacdc0df0ba244a71017136b`.
The format's recorded mirror is
`https://texlive.corca.ai/snapshots/2025-0d3fc73b65e39905/2025/`;
the engine build receipt names another mirror revision, a compatibility gap
which the experiment must continue to track.

The SDK is MIT licensed; the separately downloaded LuaHBTeX engine is
GPL-2.0-only with linked-component notices. BibTeX and individual TeX Live
packages and fonts carry their own terms. **Help › LaTeX Licences and Source**
opens the SDK's notices and licence texts; the engine source and
release manifest are linked there as well.
