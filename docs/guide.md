# Using MDraft

MDraft edits four kinds of markup in one window and shows the rendered result
beside the text. The preview is not an afterthought: each language gets the
renderer that suits it, and for Markdown and AsciiDoc the native HTML, PDF and
Print exports reuse that rendered document.

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
not bundled. On Windows and Linux, **Tools › Check or Install Typst…** downloads
it into MDraft's own data folder. On macOS, install it with your package manager
or from the [Typst download page](https://typst.app/open-source/#download), or
put `typst` on your `PATH`; MDraft picks it up. Without it, the preview shows the
compiler's absence rather than an empty pane.

The preview has two views:

- **Document** shows Typst's HTML export: flowing, selectable text in the
  application's typography. It cannot represent page layout, and the layout
  containers it cannot represent — `#columns`, `#grid`, `#align`, `#stack`,
  `#place`, `#rect` and `#pad` — are dropped *together with everything inside
  them*. A paper whose body is a two-column grid therefore shows only the text
  that sits outside the grid; the pane names the constructs it dropped and
  offers **Show pages**. Double-clicking or selecting a
  prose word paints the corresponding source word; generated text such as
  `#lorem` has no source word and paints nothing.
- **Pages** shows the compiler's real PDF, drawn by PDF.js. This is what a PDF
  export will contain, and its text layer can be selected and copied.
  A single click paints the corresponding source paragraph; double-clicking a
  word or dragging across a short range paints that selection and reveals it.
  Selecting literal prose in the source also paints the matching PDF text.
  Surrounding prose and reading regions identify repeated words across columns,
  including words beside formulas and verified line-break fragments. Generated
  text and indistinguishable repeated passages remain unpainted. This is text
  correspondence, so arbitrary macro expansion and formulas have no exact
  source mapping.
  In the dark theme the pages follow the application: the PDF's white paper and
  black text become the app's dark surface and off-white. In both themes a page
  fills the pane's width — its side edges are clipped, and only the rule between
  pages shows where one ends — so the preview reads as a continuous document
  rather than a sheet floating in the middle. Because PDF.js hands the page over
  as one raster, figures inside it are inverted with the text in the dark theme.

An `#include` or `#image` resolves against the document's folder, as it does
on export. **Help › Typst Reference** opens a live cheat sheet of the syntax
above: scripting, native mathematics, automatic numbering, cross-references,
footnotes, tables, page layout and the difference between the two views. It is
compiled by the same Typst the preview uses. The Insert and Format menus write
Typst syntax in a `.typ` document — `= Heading`, `+` for an ordered list,
`#quote(...)`, `#table(...)`, `#outline()`, `#link(...)` and `$ … $` — instead of
the Markdown spelling. Task lists, GitHub alerts and YAML front matter have no
Typst equivalent; those menu items are disabled in a `.typ` document. PDF export
from a `.typ` document goes directly through Typst, so the page layout is
preserved. Exporting a Typst document to DOCX, ODT or another flow format goes
through Typst's HTML output first and loses page layout; that is the price of the
word-processor file.

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
undo history while another tab is in front. The tab list is remembered when
**Reopen the last tabs** is selected under **On Launch**; the recovery journal
covers unsaved text separately.

When more tabs are open than fit, the strip scrolls horizontally: the arrow
buttons at its right edge move it, a vertical wheel over the strip does the
same, and the active tab is always scrolled back into view. Tabs can be dragged
to a new position (or moved one place with `Alt+Shift+Left` / `Alt+Shift+Right`
while a tab has focus). Right-click a tab for **Close Tab**, **Close Other
Tabs**, **Close Tabs to the Left**, **Close Tabs to the Right**, **Close Other
Unchanged Tabs**, **Close All Tabs**, **Save**, **Save As…** and **Show in
Folder**; right-click the empty part of the strip for **New Tab**, **Close All
Tabs** and **Close Other Unchanged Tabs**. Double-clicking the empty part starts
a new tab. The active tab's name is shown in Semibold and carries an accent edge.
**File › Close Tabs › All Tabs** closes the whole strip, with the usual save
prompt for each dirty tab.

The view can be **Source**, **Split** or **Preview**; Split is the default.
In Split view:

- scrolling either pane moves the other, when **Sync Scroll** is on;
- clicking in the source blinks the matching preview block without scrolling
  the preview;
- clicking in the Markdown, AsciiDoc or Typst Document preview moves the source
  caret without scrolling the source; a single click in Typst's Pages view paints
  the source paragraph that contains the clicked line;
- selecting a word or a range in either pane paints the corresponding text in
  the other without taking the selection; Escape clears the paint. Source
  selections do not scroll the preview; Pages may reveal a preview selection's
  source match. This
  covers Markdown, AsciiDoc, HTML and both Typst views. HTML supports inline
  selections and entities; script-mutated text must still match the render
  snapshot. AsciiDoc and Typst Document can fall back to an anchored containing
  block for substitutions or formulas. Unanchored generated content stays
  unpainted. During an edit the previous preview map is invalid until the fresh
  render arrives. Reduced motion keeps a steady resting mark;
- keyboard movement may reveal the caret's block when it has left the pane;
- **F5 and Ctrl+R do not reload the window.** A reload would discard every open
  tab and every unsaved buffer with no prompt, so those keys are swallowed.
  **File › Reload From Disk** is the explicit way to reread the current file.

The sidebar holds the document outline, Favorites and Recent. The outline
updates as headings change. **Add to Favorites** is on the editor's right-click
menu and on every tab's; favorites stay in the order they were added, opening one
never moves it, and each row's × removes only that entry — there is no Clear All.
A missing favorite stays in the list and explains itself when clicked. Recents
are remembered between runs, up to 100 paths, and the Recent panel scrolls.
**File › Open Recent** lists the newest 20 of those paths, newest first, in the
native menu; **Clear Items** there clears the same history as the sidebar footer
and Preferences. Sidebar width and the editor/preview split are not persisted.

**On Launch** (Preferences › Files) chooses what a new window opens with: the
welcome document, a new file, the most recent file, or **Reopen the last tabs** —
every saved document that was open when MDraft last closed, in the same order
with the same tab active. The list remembers paths; untitled or unsaved text is
restored by the recovery journal described below, not by the tab list. A file
that has since been deleted is skipped and reported. A document named on the
command line still wins over the remembered set. Several paths on one command
line open as tabs, in order, with the last one active.

Starting MDraft again with a document — from a terminal or an “Open with”
command — forwards the path to the running window, brings it forward and opens
a tab instead of starting a second process. A path that is already open is
focused. The installers do not register file associations yet: double-clicking
uses whatever handler the operating system already has until MDraft is chosen
there.

Other editor features:

- **Focus mode** dims every line except the one holding the caret.
- **Typewriter mode** keeps the primary caret near the vertical centre while
  typing or moving it, including wrapped lines. Manual scrolling stays put
  until the next editing/caret action; `F9` turns centering off again.
- **Line height** in the source pane is **Compact** (1.3×), **Normal** (1.5×)
  or **Wide** (1.8×), under **Preferences › Editor**. The preview keeps its own
  reading line height.
- **Auto Save** is opt-in and writes dirty files in place every 20 seconds.
- **Crash recovery.** Every dirty buffer, including an untitled one, is written
  to a journal beside `settings.json` while you type. If MDraft closes
  unexpectedly, the next launch restores those buffers as dirty tabs and shows a
  notice saying how many came back. Saving the current text or explicitly
  discarding it removes the journal entry. If typing continues during Save or
  Save As, the newer text stays dirty and journaled; a clean launch shows no
  notice. The journal is local, capped at
  64 documents and 16 MiB each, and is never written beside the document.
- **External changes.** If a file changes or is deleted on disk while its tab has
  unsaved text, a notice bar offers **Reload from disk**, **Keep my version** and
  **Save a copy…**. A save is refused until the conflict is resolved. A clean
  buffer still reloads silently if it remains unchanged while the disk read is
  pending. Typing during the read is preserved and leaves a visible conflict.
  Detection compares the file's bytes as well as its modification time and size,
  so an external rewrite of the same length with a restored timestamp is still
  refused. Checking and replacing a file are still separate operations from
  other programs' point of view: the window is narrow and the answer is safe
  (it refuses), but it is not an atomic compare-and-swap.
- **Safe text opening.** Binary files and invalid UTF-8 are refused rather than
  opened with replacement characters. UTF-16/32 receives an encoding explanation;
  convert a copy to UTF-8 until those encodings are supported. UTF-8 BOM and line
  endings are preserved. A legacy recovered lossy buffer keeps its text, pauses
  Auto Save and offers **Save a UTF-8 copy…**; the original is protected.
- **Save As** stays attached to the initiating tab even if another tab becomes
  active. It preserves typing and undo history. A destination already open in
  another tab is refused; choose another name or close that tab first.
- **Auto-close** inserts `)`, `]`, `}`, `'`, `"` and `` ` `` after the opening
  character, steps over the closer, deletes both with Backspace and wraps a
  selection. HTML tags close in HTML documents and in the inline HTML that
  Markdown and AsciiDoc pass through; Typst gets the pairs only. Both switches
  are under **Preferences › Editor**.
- **Themes** follow the system, or are fixed to light or dark.
- The source pane has eight syntax palettes, each with its own surface rather
  than a single set of token colours.
- **Spellchecking** uses the operating system's dictionaries. Code, URLs and
  mathematics are not sent to the checker. HTML documents are not spellchecked.
  A language the system does not have underlines nothing rather than guessing.
- Unsaved changes produce **Save / Discard / Cancel**. Escape and dismissal
  cancel, as do Save As cancellation, save failure or unresolved conflicts.
  Cancelling a bulk close keeps every tab; earlier successful saves are retained,
  but earlier Discard choices are not applied. New typing invalidates an older
  close/reload decision. The final native window close still saves window state.
- **Preferences** does not show dead controls: every row writes a setting or
  performs the action it names.

## Paste, copy and images

Rich text pasted from a browser, word processor or another editor is converted
into the destination document's own markup. A saved file's extension decides
the destination. An unsaved buffer is inferred from its content; if the result
differs from the language the editor is currently using, a notice tells you
which extension to save. **Ctrl/Cmd+Shift+V** bypasses the conversion once and
pastes the clipboard's plain text. Markup that is already written out is read as
the source: into a document of the same format it is pasted exactly as it is (an
HTML snippet into an HTML file, a Markdown list into a Markdown file), and into
another format it is converted from that text — an HTML article pasted into
Markdown becomes Markdown, not literal tags. Only when the copied text is plain
prose does the clipboard's formatted HTML decide the structure.

The converter understands headings, emphasis, links, lists, tables, quotes,
code, images and common maths. If a conversion fails or the fragment is too
large, the plain text is pasted rather than nothing. Pasting inside a code
fence is left alone.

Copying a selection from a text preview — Markdown, AsciiDoc, HTML, or either
Typst view — sends the selection to other applications; Typst's Pages text layer
is plain text. The AsciiDoc preview also puts the matching AsciiDoc source on the
clipboard as plain text. Copying from the source pane gives plain markup. Typst's
Pages view has a real text layer, so its text can be selected and copied like the
page it shows.

Images can arrive by pasting a bitmap, pasting an image URL, pasting a path to
a local file, dropping image files on the window, or using **Format › Image**.
**Preferences › Image** decides where they go:

| Rule | Destination |
| --- | --- |
| Copy image to `./${filename}.assets` | A folder named after the document |
| Copy image to `./assets` | A shared `assets` folder beside the document |
| Copy image to a custom folder | Your path; a relative one resolves against the document. `${filename}` expands to the document's name |
| Keep the original location | The original path or URL is inserted; nothing is copied |

Imported filenames are sanitised, an existing file is never overwritten, and
the bytes decide the format rather than the URL or clipboard label. WebP and
AVIF are recognised from their bytes and render in the Markdown, AsciiDoc and
HTML previews; Typst 0.15 reads PNG, JPEG, GIF, WebP and SVG, so an AVIF
destination is saved and explained instead of producing a `#image` that cannot
compile. A clipboard bitmap has no original location, so it is always saved.
Remote images inside pasted rich text are downloaded and saved by default;
**Remote Images in Pasted Rich Text** can keep the original URLs instead. The
separate rule for an explicitly pasted image URL can be turned off entirely.

A paste that cannot be turned into a file says why and keeps the address: an
expired session (HTTP 401), a server that returns an HTML page behind a `.png`
name, a timeout or a refused connection all reach you as a notice, and the
document keeps the URL so nothing is lost. `file:///…` addresses, Explorer's
quoted `"C:\My Pictures\a.png"` and `data:image/…` URLs are imported like any
other image.

An unsaved document has no folder, so a rule applies only when it names one that
exists without the document. A URL or local path keeps its original address
(the toast says so); a clipboard bitmap is refused with "Save it first" unless
**Custom Folder** is absolute. Typst and HTML also need a saved document before
they can show a local image, because both resolve images against a root that
only a saved file has.

The application's only network requests of its own are user-initiated image
downloads and the optional downloads of pandoc and Typst. It makes no request
at start-up, sends no telemetry and checks for no updates. An HTML document's
own linked resources are requested by the guest because its author asked for
them.

## Following links

**Ctrl/Cmd+click** a link or an image path in the source to follow it. A right
click offers the same action as **Open Link**, **Open File**, **Open Image** or
**Go to Heading**, with the shortcut beside it. In the preview a plain click
follows a link, and Ctrl/Cmd+click opens an image.

An `http`, `https`, `mailto` or `tel` target opens in the default application; a
`#fragment` scrolls the preview; a Markdown, AsciiDoc, Typst or HTML document
opens in a tab; an image or any other file goes to the OS. A relative target
needs a saved document, and an untitled buffer says so instead of guessing. A
path inside a fenced block or an inline code span is text, not a link.

## Export

The short version: **HTML**, **PDF** and **Print** need no extra tools;
**PDF (opens browser)** needs only a browser; **DOCX**, **ODT**, **EPUB**,
LaTeX, reStructuredText, AsciiDoc, RTF, Textile, MediaWiki and OPML use pandoc;
**PDF (via Typst)** uses pandoc with the Typst compiler for Markdown, AsciiDoc
and HTML, and Typst directly for a `.typ` document.

Exports use the document text and identity captured when the command begins.
Switching tabs while a picker or renderer is working does not change which
document is exported; subsequent typing stays in the editor for the next export.
Local images and links are rewritten into destinations a browser or the native
writer can follow, and the print document waits for its fonts and figures before
printing. **File › Export › PDF…** writes the file directly through WebView2 or
WebKitGTK; **File › Print…** (`Ctrl+P`) opens the platform print dialog. The
browser handoff remains for scripted HTML and hosts without a print API.

See [Export and conversion](export.md) for the exact directions, dependencies,
configuration and fidelity notes.

## Keyboard shortcuts

`Ctrl` is the modifier on the Windows and Linux builds. macOS builds, when
built from source, use `Cmd` where the application registers `CmdOrCtrl`.

| Action | Shortcut |
| --- | --- |
| New / Open / Save | `Ctrl+N` / `Ctrl+O` / `Ctrl+S` |
| Save As | `Ctrl+Shift+S` |
| Print | `Ctrl+P` |
| Close tab | `Ctrl+W` |
| Next / previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Move focused tab left / right | `Alt+Shift+Left` / `Alt+Shift+Right` |
| Tab context menu | `Shift+F10` (or the Menu key) |
| Preferences | `Ctrl+,` |
| Find / Find and Replace | `Ctrl+F` / `Ctrl+H` |
| Find next / previous | `F3` / `Shift+F3` |
| Select next occurrence | `Ctrl+D` |
| Go to line | `Ctrl+Alt+G` |
| Paste without formatting | `Ctrl+Shift+V` |
| Source code mode | `Ctrl+/` |
| Toggle sidebar | `Ctrl+Shift+L` |
| Outline / Favorites / Recent | `Ctrl+Shift+1` / `Ctrl+Shift+2` / `Ctrl+Shift+3` |
| Bold / Italic / Strikethrough | `Ctrl+B` / `Ctrl+I` / `Alt+Shift+5` |
| Inline code | `Ctrl+Shift+backtick` |
| Link / Image | `Ctrl+K` / `Ctrl+Shift+I` |
| Inline / block equation | Insert menu / `Ctrl+Shift+M` |
| Headings 1–6 / Normal | `Ctrl+1` … `Ctrl+6` / `Ctrl+0` |
| Promote / demote heading | `Ctrl+=` / `Ctrl+-` |
| Blockquote / code block / table | `Ctrl+Shift+Q` / `Ctrl+Shift+K` / `Ctrl+T` |
| Bulleted / numbered / task list | `Ctrl+Shift+]` / `Ctrl+Shift+[` / `Ctrl+Shift+X` |
| Indent / outdent | `Tab` / `Shift+Tab` |
| Focus / typewriter mode | `F8` / `F9` |
| Zoom in / out / reset | `Ctrl+Shift+=` / `Ctrl+Shift+-` / `Ctrl+Alt+0` |
| Full screen | `F11` |

Zoom applies to the whole document view: the source in Source-only, both panes
in Split, and the rendered document in Preview-only. It scales text, images,
diagrams and Typst pages together. Reset returns to 100% and leaves Content
Width and the base editor/preview font sizes alone; the percentage appears in
the status bar while it differs from 100%.

## Limitations and troubleshooting

- **No typst?** `.typ` previews and PDF through Typst need the compiler. On
  Windows and Linux, **Tools › Check or Install Typst…** installs it into
  MDraft's own data folder. On macOS, use your package manager or the official
  download page; MDraft finds `typst` on `PATH`.
- **No pandoc?** DOCX, ODT, EPUB and the other pandoc formats need it. Use
  **Tools › Check or Install Pandoc…**, which installs into MDraft's own data
  folder; a copy on `PATH` is also found.
- **PDF and Print are in-app; the browser route is the fallback.** WebView2 and
  WebKitGTK provide the print APIs; MDraft renders the light article into a
  hidden, script-free surface and writes the PDF there. **PDF (opens browser)**
  hands the same article to the system browser and asks you to choose "Save as
  PDF"; it is used for scripted HTML and hosts without a print API. The browser
  copy waits for its images and fonts and lists any resource that failed.
- **The native PDF and Print commands are for Markdown, AsciiDoc and static
  HTML.** For a `.typ` document, use **PDF (via Typst)**; its PDF is compiled
  directly. To turn a Typst document into DOCX or ODT, pandoc is given Typst's
  HTML output, so page layout is lost.
- **Pandoc cannot carry everything.** The Markdown extensions `[TOC]` and the
  GitHub alert markers have no pandoc equivalent and appear literally in DOCX,
  ODT and LaTeX output. An AsciiDoc document is rendered by Asciidoctor before
  pandoc sees it, so attributes, conditionals and `include::` are resolved, but
  an Asciidoctor PDF theme is not applied to the Typst layout. A `:toc:` arrives
  as a static contents list; add `--toc` to the format's Extra Arguments for
  pandoc's numbered table of contents.
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
