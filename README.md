# MDraft

A cross-platform markup editor for **Markdown, AsciiDoc, Typst and HTML**, with
live preview and an eye for the finished document.

MDraft is for people who care about both the source they type and the page it
becomes. It keeps the rendered document beside the text, handles four markup
languages in one window, and exports to the formats other people ask for. It is
a native Tauri application: the system webview draws the preview. There is no
bundled browser, no account, and no telemetry.

[![Latest release](https://img.shields.io/github/v/release/bgeneto/MDraft?label=latest&sort=semver)](https://github.com/bgeneto/MDraft/releases/latest)

**[Download the latest release →](https://github.com/bgeneto/MDraft/releases/latest)**

Windows installers and a portable `.exe`; Linux `.deb`, AppImage and a bare
binary. The release page always names the current version and carries its notes
and checksums.

![MDraft in the light theme with the Renaissance typography preset, showing Markdown source and its typeset preview](docs/screenshots/readme-markdown-light-renaissance.png)

*Light theme with the Renaissance preset: EB Garamond prose and headings, IBM
Plex Mono in the source.*

![MDraft in the dark theme with the System typography preset, showing the same Markdown source and preview](docs/screenshots/readme-markdown-dark-system.png)

*Dark theme with the System preset: the platform's own faces, 
Markdown document active.*

## What it does well

- **Four languages, each with the right preview.** Markdown supports GFM tables,
  KaTeX, Mermaid, GitHub alerts and `[TOC]`. AsciiDoc supports Asciidoctor's
  admonitions, tables, listings, local includes and `latexmath`/`asciimath`. Typst, once
  its compiler is installed, gets a flowing document view and a PDF page view
  whose text can be selected and clicked. HTML keeps its own CSS, images and
  scripts, isolated in a sandbox.
- **A preview that follows the work.** Split, source-only and preview-only
  modes; scroll sync; clicking a source line blinks the matching block;
  selecting a word or a range in either pane paints it in the other, for
  Markdown, AsciiDoc and Typst, without moving the selection or scrolling. The
  outline, file browser and recent list are one shortcut away, and
  **File › Open Recent** reaches the newest twenty entries of the persisted
  history without opening the sidebar.
- **Many documents, each with its own state.** Tabs keep every document's
  caret, undo and scroll position. A crowded strip scrolls with arrows, the
  wheel or drag reordering, and right-click offers the tab actions. **Reopen
  the last tabs** on launch restores the set that was open, in the same order
  and with the same one active.
- **Typing that closes itself.** `(`, `[`, `{`, quotes and backticks insert
  their pair, step over the closer and delete both on Backspace; HTML tags close
  in HTML, Markdown and AsciiDoc. Both behaviors have a switch under
  Preferences › Editor.
- **Spelling in the language being written.** The operating system's own
  dictionary underlines prose as you type; code, URLs and mathematics are left
  alone. English and Portuguese are detected automatically, a language can be
  pinned under Preferences › Editor, and the status bar turns checking on and
  off. Right-click a marked word for suggestions or **Add to dictionary**.
  Nothing is downloaded, and HTML guests are not checked.
- **Typography that holds up.** Thirteen bundled typefaces, six presets,
  independent faces for editor, prose, headings and code, plus OpenType
  controls. The source pane's line height is **Compact**, **Normal** or
  **Wide** under Preferences › Editor. Preview headings and emphasis use
  Semibold; mathematics has its own scale. Native HTML and PDF (Print) exports
  of Markdown and AsciiDoc embed the chosen faces.
- **Content moves both ways.** Paste formatted text from a browser or word
  processor and MDraft converts it into the destination's markup; paste markup
  source and it is converted the same way, or kept byte-for-byte when it is
  already the destination's format. Copy from a text preview and the formatting
  goes with it. Images can be pasted, dropped, linked or downloaded into the
  document's assets folder.
- **Useful exports, stated plainly.** HTML needs no extra tools; PDF (Print)
  needs only a browser. DOCX, ODT, EPUB, LaTeX and the rest go through pandoc,
  which MDraft can install for you. A format whose converter is missing is
  disabled and says which tool it needs. Typst documents compile straight to
  PDF; PDF via Typst handles the other languages.
- **Quiet by design.** No accounts, activation, telemetry or update checks.
  MDraft makes no network request at start-up; it goes online only for an action
  you take, such as installing pandoc or Typst, fetching a pasted image URL, or
  opening an HTML document whose own markup references remote resources.

## Getting started

1. Download the installer for your platform from
   [Releases](https://github.com/bgeneto/MDraft/releases/latest). On Windows,
   the portable `.exe` keeps its settings beside itself; the installers put
   them in the usual application data folder.
2. Open a document with **File › Open**, drop it on the window, or pass it on
   the command line:

   ```bash
   mdraft notes.md          # Linux, after installing the .deb
   MDraft.exe notes.md      # Windows
   ```

3. Split view is the default. Use the status-bar buttons for Source or
   Preview; `Ctrl+/` jumps to the source.
4. For `.typ` files, install the Typst compiler: **Help › Install Typst** on
   Windows and Linux; on macOS use your package manager or the [Typst download
   page](https://typst.app/open-source/#download), with `typst` on your `PATH`.
   For DOCX, ODT and the other pandoc formats, use **Help › Install Pandoc**.
   Neither is required to edit or preview Markdown, AsciiDoc or HTML.

## Requirements

- **Windows 10/11 (x64)** with the WebView2 runtime, which is preinstalled on
  Windows 11.
- **Linux (x64)** with WebKitGTK 4.1 and GTK 3. The `.deb` declares its
  dependencies.
- **macOS is not currently published.** The code includes macOS support, but
  the release page has Windows and Linux builds only.
- PDF (Print) hands the document to your browser's print dialog. It is not a
  silent in-app PDF.
- Pandoc and Typst are optional. **Help › Install Pandoc** installs pandoc
  into MDraft's own data folder on every published platform; **Help › Install
  Typst** does the same on Windows and Linux. On macOS, install Typst with your
  package manager or from its download page, and put `typst` on `PATH`.
  Administrator rights are not needed for the in-app installs.

## Documentation

- [User guide](docs/guide.md) — the four document types, previews, paste and
  images, shortcuts, limitations.
- [Export and conversion](docs/export.md) — formats, dependencies, PDF paths,
  pandoc configuration.
- [Typography](docs/typography.md) — bundled faces, presets, OpenType, export
  embedding and licences.
- [Contributing](CONTRIBUTING.md) — build, test and packaging instructions.
  [AGENTS.md](AGENTS.md) is the deeper working guide.
- [Issues](https://github.com/bgeneto/MDraft/issues) — bug reports and feature
  requests.

MDraft is open source under the [MIT License](LICENSE).
