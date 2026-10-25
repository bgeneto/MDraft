# Export and conversion

MDraft opens source markup; it does not import DOCX, ODT or EPUB files. In the
other direction it exports to several document formats, and it tries to be
explicit about which of them need an extra program.

## Directions at a glance

| Source | Preview | Native export | Pandoc export | Tools |
| --- | --- | --- | --- | --- |
| Markdown | Markdown pipeline | HTML, Print (opens browser) | DOCX, ODT, EPUB, LaTeX, reStructuredText, AsciiDoc, RTF, Textile, MediaWiki, OPML, PDF (via Typst) | browser for Print; pandoc for pandoc formats; Typst for PDF (via Typst) |
| AsciiDoc | Asciidoctor.js | HTML, Print (opens browser) | same list | browser for Print; pandoc; Typst for PDF (via Typst) |
| HTML | Sandboxed guest | HTML copy, Print (opens browser) | same list | browser for Print; pandoc; Typst for PDF (via Typst) |
| Typst | Typst compiler | PDF (direct) | DOCX, ODT, EPUB, LaTeX, reStructuredText, AsciiDoc, RTF, Textile, MediaWiki, OPML | Typst for preview and PDF; pandoc for the other formats |

The native **HTML** and **Print (opens browser)** commands cover Markdown,
AsciiDoc and HTML. They do not cover Typst documents; use **PDF (via Typst)** for
a `.typ` file, which compiles it directly to PDF. The pandoc list is available
for all four source languages.

## Native exports

### HTML

For Markdown and AsciiDoc, **File › Export › HTML** writes a standalone page
built from the same HTML the preview is showing. It carries the active
highlight theme and the current typography settings, embeds any bundled faces
that are in use as data URLs, and links KaTeX's stylesheet so mathematics
renders in a browser.

Local images and links are restored to destinations a browser can follow. When
the output is on the same volume as the document, a relative path is used; a
different volume falls back to a `file://` URL. Remote addresses, `data:` URLs
and in-page `#heading` links keep their meaning. No application protocol is
required.

For an HTML document, the same command writes a copy of the source. Passing an
already-complete HTML file through the Markdown renderer would produce a
different document, so it is not done.

A Typst document is not handled by the native HTML command. Its PDF path is
direct; its other formats go through the pandoc list.

### Print (opens browser)

**File › Print (opens browser)…** renders a light print document and hands it to
the system browser, which opens its print dialog. Choose "Save as PDF" there.
Nothing needs to be installed beyond a browser, and the result follows the
article's mathematics, diagrams and syntax colours on a page that is always
light.

The print document is always light, whatever the editor theme is, and its
diagrams are rendered for that light page. It waits (up to ten seconds) for
images and web fonts before opening the dialog, and prints a visible list of
any image that failed to load. Local images use absolute `file://` URLs because
the document lives in the temporary folder.

This works for Markdown, AsciiDoc and HTML. It is not connected to the Typst
compiler; for a `.typ` document use **PDF (via Typst)** instead.

The print document is written to the temporary directory. MDraft does not learn
where the browser saved the PDF, so the after-export options do not run for
this one path.

## Pandoc exports

The default format list is:

| Entry | Extension | Needs |
| --- | --- | --- |
| PDF (via Typst) | `.pdf` | pandoc and Typst for Markdown, AsciiDoc and HTML; Typst directly for `.typ` |
| Word (.docx) | `.docx` | pandoc |
| LibreOffice / OpenDocument (.odt) | `.odt` | pandoc |
| LaTeX | `.tex` | pandoc |
| reStructuredText | `.rst` | pandoc |
| AsciiDoc | `.adoc` | pandoc |
| EPUB | `.epub` | pandoc |
| RTF | `.rtf` | pandoc |
| Textile | `.textile` | pandoc |
| MediaWiki | `.wiki` | pandoc |
| OPML | `.opml` | pandoc |

The list is editable. **Preferences › Export** can rename an entry, change its
extension, its pandoc arguments, its extra arguments and a style reference, or
add and remove formats.

### How the source is read

- Markdown is converted with pandoc's Markdown reader configured for the
  dialect MDraft writes, including the backslash math delimiters it renders.
- AsciiDoc is rendered by Asciidoctor to HTML first, then read with pandoc's
  HTML reader. This is the same engine that draws the preview, so document
  attributes, unset attributes (`:toc!:`), `ifdef::`/`ifndef::` conditionals,
  includes, LaTeX and AsciiMath are resolved before pandoc sees the document.
  The AsciiDoc target itself is the exception: it keeps the original source.
- HTML is read with pandoc's HTML reader.
- Typst is compiled by Typst to HTML first and that HTML is handed to pandoc.
  A `.typ` document exported to PDF is instead written by Typst directly.

### Format arguments

Four placeholders are substituted into a format's arguments and extra
arguments:

| Placeholder | Expands to |
| --- | --- |
| `${inputPath}` | The document's path, empty for an untitled document |
| `${outputPath}` | The file you chose |
| `${styleReference}` | The reference or stylesheet file, empty when unset |
| `${pdfEngine}` | `--pdf-engine=<path>` when Typst was found |

Arguments are passed to pandoc as a token list, never through a shell, so a
path with spaces needs no quoting. A token whose placeholder expanded to
nothing is dropped entirely, which is what lets
`--reference-doc=${styleReference}` disappear when no reference is set.

### After export

**Preferences › Export › After Export** can open the exported file's folder,
open the file itself, or run a command with `${outputPath}` substituted. These
are global: they run after every successful export that writes a file, not only
for the format currently selected in the panel. Print (opens browser) is the
exception, because the browser owns the save path.

## Installing pandoc and Typst

Both are optional and neither is bundled.

- **Tools › Check or Install Pandoc…** downloads the official release, checks
  the archive against the SHA-256 GitHub publishes, and unpacks it into MDraft's
  own data folder on Windows, Linux and macOS. It does not install system-wide
  and needs no administrator rights.
- **Tools › Check or Install Typst…** downloads the official compiler, checks
  the archive against the SHA-256 GitHub publishes, and unpacks it into the same
  application data area on Windows and Linux. On macOS the command opens the
  official download page instead; install it with your package manager or from
  that page. Typst is used for `.typ` previews and for PDF export, and is a
  single executable with no runtime dependencies.

A copy on `PATH` is also found. A copy MDraft installed itself takes precedence
over the one on `PATH`. Typst can be installed with a package manager
(`cargo install typst-cli`, `apt install typst`, `brew install typst`) or from
the [Typst download page](https://typst.app/open-source/#download).

## Fidelity and known gaps

- **The pandoc route is a real conversion, not the preview.** The Markdown
  extensions `[TOC]` and `[!NOTE]`-style alerts have no pandoc equivalent and
  arrive as literal text in DOCX, ODT and LaTeX. Typst page layout is lost when
  pandoc writes DOCX, ODT or another flow format.
- **AsciiDoc reaches pandoc as HTML, not as AsciiDoc.** Attributes,
  conditionals and includes are resolved by Asciidoctor, but an Asciidoctor
  PDF theme (`:pdf-theme:`, `:pdf-page-size:`) is not applied to the Typst
  layout. A `:toc:` arrives as Asciidoctor's static contents list, without page
  numbers; add `--toc` to the format's Extra Arguments if pandoc's own numbered
  table of contents is preferred. The AsciiDoc target keeps the original
  source and pandoc's AsciiDoc reader.
- **The native HTML and Print (opens browser) exports do not have those gaps for
  Markdown and AsciiDoc**, because they use the preview's own HTML. This is why
  both routes exist.
- **An HTML document's print copy uses a local file base.** The browser can
  read the document's own CSS, images and classic scripts, but local ES modules
  and fonts may still be subject to its file-origin rules. The HTML **export**
  copy is the source bytes unchanged: relative URLs in it still resolve against
  the folder it is opened from, not against the original document.
- **An exported Markdown or AsciiDoc HTML file fetches KaTeX from jsDelivr.**
  Its mathematics needs the stylesheet and fonts; the file links them rather
  than embedding them. MDraft itself makes no request when writing the export.
- **PDF through a user-added engine is possible.** A format can name its own
  `--pdf-engine`; that wins over Typst because extra arguments come last. MDraft
  does not install a TeX distribution for you.
- **No silent PDF.** Print (opens browser) asks the browser, and PDF (via Typst)
  asks for an output path. There is no in-app print interface that writes a PDF
  without a dialog.

## Dependency summary

| You want | You need |
| --- | --- |
| Edit and preview Markdown, AsciiDoc or HTML | MDraft only |
| Preview a `.typ` file, or export it to PDF | Typst |
| HTML or Print (opens browser) from Markdown, AsciiDoc or HTML | MDraft and a browser for Print |
| DOCX, ODT, EPUB, LaTeX, reStructuredText, AsciiDoc, RTF, Textile, MediaWiki or OPML | pandoc |
| PDF (via Typst) from Markdown, AsciiDoc or HTML | pandoc and Typst |
| PDF from a Typst document | Typst |
