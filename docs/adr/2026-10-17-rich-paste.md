# Paste converts through one IR, and an unsaved buffer is detected before it is trusted

**Status:** accepted
**Date:** 2026-10-17

## Context

A paste used to insert only `text/plain`. Copying a table from a browser, a bold
sentence from Word or a list from Google Docs therefore lost its structure, and
the same failure appeared in all three native formats (Markdown, Typst, HTML).

Two facts forced the shape of the fix:

1. **The destination is not always known.** A saved file's extension is
   authoritative, but a new buffer only starts with `settings.defaultExtension`
   as a suggestion for Save As. The reader can type Typst in a Markdown-default
   buffer, and Save As can choose any extension. The earlier assumption that
   `doc.language` was a guarantee was wrong.
2. **The clipboard is a small language zoo.** It can carry `text/html`,
   `text/markdown` or only `text/plain`, and the plain text may itself be
   Markdown or Typst. A converter per source/destination pair would multiply.

The project's network rule also had to change: it said the only outbound request
was `images::download_image`, reached solely by pasting an image URL. Rich paste
makes that command reachable from a pasted fragment as well.

## Decision

- **One intermediate representation.** Every source is parsed into plain
  `Block`/`Inline` objects, then rendered into the destination's syntax. A new
  source costs a reader; a new destination costs a renderer.
- **Destination resolution:** saved file → extension; unsaved buffer → a
  conservative classifier over its content; empty or ambiguous → the editor's
  current language (the default-extension fallback). The classifier chooses the
  **paste syntax only**. It never reclassifies the editor's parser or preview;
  a one-time notice points at Save As when the two disagree.
- **Source selection is destination-first:** plain text that already matches the
  destination wins; otherwise HTML wins over a different text syntax; otherwise
  paste natively. The clipboard classifier is synchronous and requires a score
  of 4 with a 2-point lead; shared constructs (bullets, inline code, `$…$`) never
  decide.
- **Existing dependencies only:** `parse5` for HTML, `marked` for Markdown,
  `codemirror-lang-typst/lezer` for Typst, `katex` for MathML. No new npm or
  cargo dependency.
- **HTML → HTML is sanitised**, not copied: the source page's stylesheets,
  scripts and event handlers are not imported. HTML → Markdown/Typst is parsed
  into the IR; raw HTML inside a Markdown source goes through the same HTML
  reader.
- **Images use one syntax builder and one save/import path.** Markdown keeps
  `![alt](path)` byte-for-byte; Typst gains `#image("path", alt: "…")`; HTML keeps
  `<img>`. Images inside a pasted fragment are resolved to local paths where they
  can be: `data:` through `save_clipboard_image`, local paths through
  `import_image`, and remote images by download.
- **Remote downloads are explicit product behaviour.** A new Image preference,
  *Remote Images in Pasted Rich Text*, chooses **Download and save** (default) or
  **Keep the original URL**. Downloading is bounded: at most eight remote images
  per paste, four at a time, eight seconds each, through the same
  `download_image` command that already enforced HTTP(S)-only and a 32 MB body
  limit. An optional `timeoutMs` lets the rich path cap the wait; the explicit
  URL path keeps the 25-second default.
- **No frontend `fetch`.** Every network request remains a Tauri `invoke` to
  `images::download_image`; nothing is requested at start-up or without a paste.

## Consequences

- Adding a source format means a reader; adding a destination means a renderer.
  The conversion matrix stays linear and is testable under Node without the
  application.
- The editor grammar and preview do not follow the detector. A reader who types
  Typst in a Markdown-default unsaved buffer sees a notice after the paste and is
  told which extension to save. A future "detected format" chip can make that
  explicit; it is deliberately not part of this change.
- The README and AGENTS.md must describe the broadened `download_image` trigger.
  The Image preference is the switch that restores the old "keep the URL"
  behaviour; *Apply Above Rules to Online Images* still governs an explicitly
  pasted URL.
- HTML→HTML is lossy by design. Pasted content is content, not a document; the
  source page's CSS, scripts and layout are not imported.
- TeX→Typst math is a bounded translator, not an engine. Unknown commands become
  bare names so a formula still parses; the README says so.
- The tests split along the same line as the code: a Node matrix for readers,
  renderers, detection and image syntax; CDP suites for the paste event, the
  destination notice and the image download path.
