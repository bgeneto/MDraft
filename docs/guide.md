# Using MDraft

MDraft edits four kinds of markup in one window and shows the rendered result
beside the text. The preview is not an afterthought: each language gets the
renderer that suits it, and for Markdown and AsciiDoc the native HTML and PDF
(Print) exports reuse that rendered document.

This guide covers the editor and the four document types. Export formats and
their dependencies are in [Export and conversion](export.md). Typefaces,
presets and OpenType settings are in [Typography](typography.md).

## Markdown

Markdown is the default language. `.md`, `.markdown`, `.mdown`, `.mkd` and
plain `.txt` files open in it.

The preview handles GitHub-flavoured tables, task lists, fenced code with
highlighting, blockquotes, rules and local images. On top of that it renders:

- KaTeX for `$…$`, `$$…$$`, `\(…\)` and `\[…\]`, including the space-padded
  delimiters common in documents converted from PDF;
- Mermaid diagrams from ` ```mermaid ` fences;
- GitHub alerts such as `> [!NOTE]` and `> [!WARNING]`;
- `[TOC]`, expanded into links to the document's headings.

Math inside code spans and fences is left alone. Local image links resolve
against the folder of the document being edited.

## AsciiDoc

`.adoc` and `.asciidoc` files open as AsciiDoc. The preview is produced in the
webview by Asciidoctor.js, loaded the first time an AsciiDoc document is
rendered. It handles titles and sections, admonitions, ordered and unordered
lists, tables, source listings, local images, `:toc:`, and `latexmath:[…]`
through KaTeX.

`include::` targets are read through the application's file commands, but only
from the document's own folder. Absolute paths, URLs and `..` escapes are
refused and replaced with a visible unresolved-directive message. Include
attributes such as `lines`, `tag` and `leveloffset` are not applied, and the
included file is read again on every preview pass: a document that includes a
large book pays for it on each edit pause.

AsciiMath is supported: `[asciimath]`, `asciimath:[…]` and `stem:[…]` under
`:stem: asciimath` are converted to TeX and drawn with KaTeX. A document that
declares `:stem: latexmath` is still LaTeX, so `sqrt(4)` there is four
variables, not a radical. **Help › AsciiDoc Reference** opens a live cheat
sheet of the syntax above. `.asc` and `.ad` are not recognised as AsciiDoc.

## Typst

`.typ` files are edited as source and previewed by the Typst compiler. Typst is
not bundled. On Windows, **Help › Install Typst** downloads it into MDraft's
own data folder. On Linux and macOS, install it with your package manager or
from the [Typst download page](https://typst.app/open-source/#download), or put
`typst` on your `PATH`; MDraft picks it up. Without it, the preview shows the
compiler's absence rather than an empty pane.

The preview has two views:

- **Document** shows Typst's HTML export: flowing, selectable text in the
  application's typography. It cannot represent page layout, so page size,
  `#align`, boxes and page breaks are not shown.
- **Pages** shows the compiler's real pages as SVG. This is what a PDF export
  will contain, but the text is drawn as outlines and cannot be selected or
  reflowed.

An `#include` or `#image` resolves against the document's folder, as it does
on export. PDF export from a `.typ` document goes directly through Typst, so
the page layout is preserved. Exporting a Typst document to DOCX, ODT or another
flow format goes through Typst's HTML output first and loses page layout; that
is the price of the word-processor file.

## HTML

`.html` and `.htm` files are edited as source and previewed as a guest
document: a sandboxed iframe served by MDraft's private preview scheme, not an
article inside the application's own page.

The document keeps its own `<style>`, linked CSS, images, media, inline
scripts, classic external scripts and ES modules. MDraft's preview typography,
math and diagram pipelines do not touch it. An HTML file that wants maths or
diagrams loads its own library.

The guest can read files in its own folder and request the network resources
its markup references. It cannot reach MDraft's commands, the editor, or files
outside that folder. **Open HTML documents from sources you trust.** With
**Preferences › HTML › Run scripts in the HTML preview** turned off, the
document's scripts are blocked while the preview, CSS, images and scroll sync
keep working.

The guest has no same-origin storage: `localStorage`, cookies, IndexedDB,
service workers, Web Workers and local `fetch()` of data files are
unavailable. A re-render reloads the guest, so scripts and form state restart;
the visible line is restored. A page that scrolls an inner container instead of
the window keeps independent panes.

## Editing

Documents open in tabs. Each tab keeps its text, caret, scroll position and
undo history while another tab is in front. The tab list itself is not saved
when the window closes.

When more tabs are open than fit, the strip scrolls horizontally: the arrow
buttons at its right edge move it, a vertical wheel over the strip does the
same, and the active tab is always scrolled back into view. Tabs can be dragged
to a new position (or moved one place with `Alt+Shift+Left` / `Alt+Shift+Right`
while a tab has focus). Right-click a tab for **Close**, **Close Others**,
**Close All to the Left**, **Close All to the Right**, **Close Unchanged**,
**Save**, **Save As…** and **Reveal in File Manager**; right-click the empty
part of the strip for **New Tab**, **Close All Tabs** and **Close Unchanged**.
Double-clicking the empty part starts a new tab. The active tab's name is shown
in Semibold and carries an accent edge. **File › Close All Tabs** closes the
whole strip, with the usual save prompt for each dirty tab.

The view can be **Source**, **Split** or **Preview**; Split is the default.
In Split view:

- scrolling either pane moves the other, when **Sync Scroll** is on;
- clicking in the source blinks the matching preview block without scrolling
  the preview;
- clicking in the preview moves the source caret without scrolling the source;
- selecting a word or a range in either pane paints the corresponding text in
  the other, without taking the selection or scrolling; Escape clears it. This
  covers Markdown and AsciiDoc. A paragraph whose text comes from an attribute
  substitution, or from an included file, is left alone rather than guessed at,
  and Typst and HTML documents have no word-level sync;
- keyboard movement may reveal the caret's block when it has left the pane.

The sidebar holds the document outline, a folder browser and recent files.
The outline updates as headings change; recents are remembered between runs.
Sidebar width and the editor/preview split are not persisted.

Other editor features:

- **Focus mode** dims every line except the one holding the caret.
- **Typewriter mode** keeps the caret vertically centred while typing.
- **Auto Save** is opt-in and writes dirty files in place every 20 seconds.
- A clean buffer reloads when the file changes on disk.
- **Themes** follow the system, or are fixed to light or dark.
- The source pane has eight syntax palettes, each with its own surface rather
  than a single set of token colours.
- **Spellchecking** uses the operating system's dictionaries. Code, URLs and
  mathematics are not sent to the checker. HTML documents are not spellchecked.
  A language the system does not have underlines nothing rather than guessing.
- Unsaved changes produce a **Save / Discard** prompt. The dialog plugin does
  not expose a third Cancel button, so there is no three-way prompt.
- **Preferences** does not show dead controls: every row writes a setting or
  performs the action it names.

## Paste, copy and images

Rich text pasted from a browser, word processor or another editor is converted
into the destination document's own markup. A saved file's extension decides
the destination. An unsaved buffer is inferred from its content; if the result
differs from the language the editor is currently using, a notice tells you
which extension to save. **Ctrl/Cmd+Shift+V** bypasses the conversion once and
pastes the clipboard's plain text.

The converter understands headings, emphasis, links, lists, tables, quotes,
code, images and common maths. If a conversion fails or the fragment is too
large, the plain text is pasted rather than nothing. Pasting inside a code
fence is left alone.

Copying a selection from a text preview — Markdown, AsciiDoc, HTML, or Typst's
Document view — sends the formatted selection to other applications. The
AsciiDoc preview also puts the matching AsciiDoc source on the clipboard as
plain text. Copying from the source pane gives plain markup. Typst's Pages view
is a picture of the page, so its text cannot be selected; copy from Document
view or the source.

Images can arrive by pasting a bitmap, pasting an image URL, pasting a path to
a local file, dropping image files on the window, or using **Format › Image**.
**Preferences › Image** decides where they go:

| Rule | Destination |
| --- | --- |
| Copy image to `./${filename}.assets` | A folder named after the document |
| Copy image to `./assets` | A shared `assets` folder beside the document |
| Copy image to a custom folder | Your path; a relative one resolves against the document |
| Keep the original location | The original path or URL is inserted; nothing is copied |

Imported filenames are sanitised, an existing file is never overwritten, and
the bytes decide the format rather than the URL or clipboard label. A
clipboard bitmap has no original location, so it is always saved. Remote images
inside pasted rich text are downloaded and saved by default; **Remote Images in
Pasted Rich Text** can keep the original URLs instead. The separate rule for an
explicitly pasted image URL can be turned off entirely.

The application's only network requests of its own are user-initiated image
downloads and the optional downloads of pandoc and Typst. It makes no request
at start-up, sends no telemetry and checks for no updates. An HTML document's
own linked resources are requested by the guest because its author asked for
them.

## Export

The short version: **HTML** needs no extra tools; **PDF (Print)** needs only a
browser; **DOCX**, **ODT**, **EPUB**, LaTeX, reStructuredText, AsciiDoc, RTF,
Textile, MediaWiki and OPML use pandoc; **PDF (via Typst)** uses pandoc with
the Typst compiler for Markdown, AsciiDoc and HTML, and Typst directly for a
`.typ` document.

See [Export and conversion](export.md) for the exact directions, dependencies,
configuration and fidelity notes.

## Keyboard shortcuts

`Ctrl` is the modifier on the Windows and Linux builds. macOS builds, when
built from source, use `Cmd` where the application registers `CmdOrCtrl`.

| Action | Shortcut |
| --- | --- |
| New / Open / Save | `Ctrl+N` / `Ctrl+O` / `Ctrl+S` |
| Save As | `Ctrl+Shift+S` |
| Close tab | `Ctrl+W` |
| Next / previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Move focused tab left / right | `Alt+Shift+Left` / `Alt+Shift+Right` |
| Tab context menu | `Shift+F10` (or the Menu key) |
| Preferences | `Ctrl+,` |
| Find / Find and Replace | `Ctrl+F` / `Ctrl+H` |
| Source code mode | `Ctrl+/` |
| Toggle sidebar | `Ctrl+Shift+L` |
| Outline / Files / Recent | `Ctrl+Shift+1` / `Ctrl+Shift+2` / `Ctrl+Shift+3` |
| Strong / Emphasis / Strikethrough | `Ctrl+B` / `Ctrl+I` / `Alt+Shift+5` |
| Inline code | `Ctrl+Shift+backtick` |
| Hyperlink / Image | `Ctrl+K` / `Ctrl+Shift+I` |
| Inline / display maths | Format menu |
| Headings 1–6 / Paragraph | `Ctrl+1` … `Ctrl+6` / `Ctrl+0` |
| Increase / decrease heading level | `Ctrl+=` / `Ctrl+-` |
| Quote / code fences / maths block | `Ctrl+Shift+Q` / `Ctrl+Shift+K` / `Ctrl+Shift+M` |
| Table | `Ctrl+T` |
| Ordered / unordered / task list | `Ctrl+Shift+[` / `Ctrl+Shift+]` / `Ctrl+Shift+X` |
| Indent / outdent | `Tab` / `Shift+Tab` |
| Focus / typewriter mode | `F8` / `F9` |
| Zoom in / out / reset | `Ctrl+Shift+=` / `Ctrl+Shift+-` / `Ctrl+Shift+0` |
| Full screen | `F11` |

## Limitations and troubleshooting

- **No typst?** `.typ` previews and PDF through Typst need the compiler. On
  Windows, **Help › Install Typst** installs it into MDraft's own data folder.
  On Linux, use your package manager or the official download page; MDraft
  finds `typst` on `PATH`.
- **No pandoc?** DOCX, ODT, EPUB and the other pandoc formats need it. Use
  **Help › Install Pandoc**, which installs into MDraft's own data folder; a
  copy on `PATH` is also found.
- **PDF (Print) opens a browser.** WebView2 has no print interface of its own,
  so MDraft writes a print copy and hands it to the system browser. Choose
  "Save as PDF" there. It is not a silent in-app PDF.
- **The native HTML and PDF (Print) commands are for Markdown, AsciiDoc and
  HTML.** For a `.typ` document, use **PDF (via Typst)**; its PDF is compiled
  directly. To turn a Typst document into DOCX or ODT, pandoc is given Typst's
  HTML output, so page layout is lost.
- **Pandoc cannot carry everything.** The Markdown extensions `[TOC]` and the
  GitHub alert markers have no pandoc equivalent and appear literally in DOCX,
  ODT and LaTeX output. AsciiDoc `include::` and `:toc:` are not expanded by
  pandoc; add `--toc` to the format's Extra Arguments for a real table of
  contents.
- **A Markdown or AsciiDoc HTML export fetches one stylesheet.** KaTeX's layout
  rules and fonts come from jsDelivr in the exported file, so its mathematics
  renders in a browser. The editor itself makes no such request.
- **The preview is re-rendered as a whole.** Rendering is debounced (200 ms for
  Markdown, 250 ms for AsciiDoc, 300 ms for HTML) and very large documents cost
  proportionally more on each pause.
- **No WYSIWYG editing.** The source stays visible; the rendered page is beside
  it. There is no auto-update, no image upload to a remote host, and no
  community CSS theme format.
- **macOS is not published.** The source has a macOS bundle configuration and
  uses the native spell checker, but the release page currently has Windows and
  Linux builds only.
