# Rich-text paste: clipboard HTML, Markdown and Typst into the document's own format

**Status:** done
**Date:** 2026-10-17
**ADR:** `../adr/2026-10-17-rich-paste.md` (written with the implementation)

## Context and goal

Today a paste inserts whatever `text/plain` carries. Copying a table from a
browser, a bold sentence from Word, or a list from Google Docs into a Markdown
document produces a tab-separated line, a run-together paragraph, or raw HTML.
Typora's model — use the clipboard's HTML when it is there, convert it to the
target markup, otherwise paste text — is what users expect from a document
editor. The goal is that behaviour for all three native formats: Markdown,
Typst and HTML.

The earlier version of this plan was wrong about the unsaved case. It said the
destination was always known; it is not. For a saved file the extension is
authoritative (`languageFor()`, `src/main.ts`, near line 998). For a new buffer,
`doc.language` starts as `defaultDocumentLanguage()`, which reads
`settings.defaultExtension` (`src/main.ts`, near line 1012), and `sessions.blank()`
sets Markdown (`src/sessions.ts`, near line 65). That is a **suggestion for Save
As**, not a guarantee: the user can type Typst in a Markdown-default buffer, and
Save As can choose `.typ` or `.html` no matter what the preference says. Save As
only reclassifies the buffer after the file is written (`src/main.ts`, near line
1350), which is too late to help a paste that happens before it.

The destination is therefore resolved in this order:

1. **Saved file** — the extension, via `languageFor()`. Content never overrides
   it.
2. **Unsaved buffer with a confident detection** — the markup the buffer actually
   looks like, from a conservative scan of the active document.
3. **Unsaved buffer that is empty or ambiguous** — `doc.language`, the
   default-extension fallback, which is also what Save As will suggest.

The detection chooses the **paste syntax only**. It does not reclassify the
editor's parser or preview in this change: flipping the grammar under text the
user has already typed is still the thing `languageFor()` refuses to do. When the
detected destination differs from `doc.language`, a one-time notice says which
syntax was used and suggests saving with the matching extension. That keeps the
paste correct while leaving the parser stable until the user commits to a file
name.

What is true today, so a later reader does not rediscover it:

- Paste is handled in the capture phase by `installImagePaste()`
  (`src/main.ts`, near line 3147). It moves the caret to the clicked preview
  block, then gives `handleImagePaste()` the first refusal. A clipboard bitmap
  wins over text, and that ordering must stay.
- `editor.insertBlock()` appends a block after the current line
  (`src/editor.ts`, near line 433). It is wrong for an inline paste in the middle
  of a sentence, so a new insertion method is needed.
- `marked`, `parse5`, `katex` and `codemirror-lang-typst` are already direct
  dependencies. `parse5` is loaded lazily by the HTML preview
  (`src/html-preview.ts`), and `codemirror-lang-typst/lezer` exports a
  synchronous, WASM-free `typstParser` whose tree carries headings, lists, raw
  blocks, equations and content blocks. Both were probed during planning; no
  new npm or cargo dependency is required.
- `marked`'s lexer already distinguishes table alignment, task-list items and
  nested lists. `katex.renderToString(tex, { output: "mathml" })` produces
  MathML that needs no stylesheet, which matters for an HTML document.
- `parse5.parseFragment()` on a complete HTML document hoists its `<style>` and
  `<script>` into the fragment. A clipboard payload from Word or a browser is
  often a complete document, so the reader must detect that case and walk
  `document.body` instead.
- Image paste is already a working path and must stay one. `handleImagePaste()`
  saves a clipboard bitmap, a URL or a local path through the Rust commands, then
  `ImageContext.imageSyntax` turns the saved path into the document's markup
  (`src/images.ts`, near line 98; `src/main.ts`, near line 3095). Markdown gets
  `![alt](path)`; HTML gets `<img src… alt…>` and a forced relative path. Typst
  gets **neither**: `imageContext()` passes `imageSyntax` only for HTML, so a
  `.typ` buffer receives `![…](…)`, which Typst does not understand, and the path
  is not forced relative even though the preview compiles with `--root` at the
  document directory. This change fixes that as part of the same paste path; it
  does not replace the existing image pipeline.
- Images inside a rich fragment are not part of that path yet: an `<img>` copied
  from a page arrives as an element, and without a resolver it would be inserted
  as a URL or a `data:` URI instead of being saved like a clipboard bitmap.
- The README's network rule says the only outbound request the application makes
  itself is `images::download_image`, reached solely by a user pasting or
  dropping an **image URL**. This plan deliberately broadens that trigger: a user
  who pastes a fragment containing remote images has asked for those images to
  arrive, and the user chose automatic download over keeping links. The command
  stays the same, it is still user-initiated, and the new *Images in Pasted Rich
  Text* preference is its switch; *Apply Above Rules to Online Images* still
  governs an explicit image URL. It never runs at start-up or without a paste.
  The README and AGENTS.md wording changes with the implementation; that is part
  of the scope, not an afterthought.

## Scope and non-scope

### In scope

- **Destination resolution for the active buffer**: a saved file uses its
  extension; an unsaved buffer is classified from its own content; an empty or
  ambiguous buffer falls back to `doc.language` (the default-extension
  language). The detected language decides the paste syntax and is surfaced in a
  one-time notice when it differs from the editor's current language.
- **HTML source** (from browsers, Word, Google Docs, Excel, Typora, VS Code
  "copy with syntax highlighting") converted to Markdown, Typst or a sanitized
  HTML fragment.
- **Markdown source** pasted into Typst or HTML; pasted into Markdown it stays
  byte-identical.
- **Typst source** pasted into Markdown or HTML; pasted into Typst it stays
  byte-identical.
- **Plain text** pasted unchanged unless it is confidently detected as Markdown
  or Typst *and* the destination is a different syntax.
- **Image parity** across Markdown, Typst and HTML: a clipboard bitmap, a pasted
  URL or path, a dropped file, and an image inside a rich fragment all use the
  existing save/import pipeline and produce the destination's own syntax. Remote
  images in a pasted fragment are downloaded automatically when the new
  *Remote Images in Pasted Rich Text* preference is **Download and save**, then inserted
  as local paths in all three formats. **Keep the original URL** makes no request.
  The current Markdown result is the reference and must not change.
- Structures: headings, paragraphs, hard breaks, bold, italic, strikethrough,
  inline code, fenced code with language, bullet/ordered/nested/task lists,
  blockquotes, tables (including alignment), links, images, horizontal rules,
  superscript/subscript, and math (TeX/KaTeX/MathJax annotation).
- Clipboard MIME handling: `text/html`, `text/markdown`/`text/x-markdown`,
  `text/plain`; the bitmap precedence and save flow stay exactly as they are.
- Insertion at the caret with correct inline-versus-block separation, a single
  undo step, indentation reuse, and preview updates.
- Pasting over the preview pane after the existing caret move.
- A new **Editor** preference, *Convert Rich Text on Paste* (default on), and
  the platform's `Ctrl/Cmd+Shift+V` bypass.
- A new **Image** preference, *Remote Images in Pasted Rich Text*, with two values:
  **Download and save** (default) and **Keep the original URL**. It applies to
  images inside a pasted HTML or Markdown fragment. An explicit image URL
  pasted on its own keeps following *Apply Above Rules to Online Images*; the
  two controls are separate on purpose and their help text says so.
- A code-context guard: inside a Markdown fence/inline code, an HTML
  `<pre>/<code>/<script>/<style>`, or a Typst raw/code block, paste plain rather
  than translating.
- Size/node caps, a plain-text fallback and a toast when the cap is hit.
- A pure Node conversion suite, two CDP suites (rich paste and image syntax),
  test-all wiring, docs, ADR and updates to the existing suites.

### Non-scope

- RTF, OMML (Word equations) and PDF clipboard formats. Word and Office put
  HTML on the clipboard; RTF would be a second parser for the same content.
- Downloading images in the background after the text has already been inserted,
  and rewriting the references later. It makes undo non-atomic and needs position
  tracking across arbitrary edits; the bounded wait below is simpler and keeps
  one paste as one undo step.
- Saving or downloading images beyond the per-paste cap in this change; they keep
  their URLs/links and a notice says so.
- Reclassifying the active buffer's parser or preview from the detector. The
  detector chooses the paste syntax only; Save As remains the moment the buffer's
  language is fixed. A future feature can surface the detected format as a
  clickable chip and switch the grammar deliberately.
- A "Paste as Markdown/Typst/Plain" menu that reads the clipboard. WebView2
  clipboard-read permission cannot be relied on without a plugin; the
  preference and `Ctrl/Cmd+Shift+V` cover the need. A future plugin can add the
  menu item without changing the conversion core.
- Paste events inside the sandboxed HTML preview iframe (they belong to the
  guest document, not the editor).
- Export, print, PDF, pandoc and the HTML guest renderer.
- Syntax highlighting inside an HTML document or preserving the source page's
  stylesheets, scripts, classes that refer to them, or layout.
- Footnote definitions, definition lists, figures/subfigures, `[TOC]`, GitHub
  alerts and other editor extensions beyond a plain textual mapping.
- A complete TeX engine. Math is carried as math and translated only for the
  common constructs (see step 5).

## Approach and rejected alternatives

### The shape

One small **intermediate representation (IR)** for a pasted fragment; one
reader per source syntax; one renderer per destination syntax. A new source
format costs a reader, a new destination costs a renderer, and neither
multiplies against the other. The IR is plain data: no DOM, no editor state, no
Tauri, which is what makes the whole conversion matrix testable in Node.

```
document ──> resolve destination (saved extension / unsaved detection / fallback) ─┐
                                                                                    ▼
clipboard ──> detect source ──> reader ──> IR ──> renderer ──> text ──> editor.insertPasted()
               (MIME + text)     HTML/    blocks     md/typst/html
                                 md/typst + inlines
```

`planPaste()` is asynchronous because `parse5` and the Typst Lezer parser are
loaded on first use, and because remote images are downloaded before the final
text is rendered. The `ClipboardEvent` data is read **synchronously** before the
first `await`, because a `DataTransfer` is not reliably readable after the event
dispatch returns. The same turn calls `preventDefault()` when (and only when) the
paste will be consumed. That is the existing rule from the image path, and it
becomes more important here.

### Destination resolution for the active buffer

Before looking at the clipboard, the paste handler resolves the destination from
the document actually on screen:

| Document state | Destination | Why |
| --- | --- | --- |
| Saved file | `doc.language`, from the extension | The extension is the only authoritative signal; content never overrides it. |
| Unsaved, detector confident | The detected Markdown, Typst or HTML | The buffer is the only evidence of what the user is writing. |
| Unsaved, empty or ambiguous | `doc.language`, the default-extension language | It is what Save As will suggest; there is nothing better to go on. |

The detector is a separate entry point from the clipboard classifier, although
they share the signal table. The whole rule lives in a pure
`resolvePasteDestination({ saved, language, buffer })` — saved is never scanned,
unsaved is classified, and null falls back — so the matrix is unit-testable
without the app. It reads the buffer synchronously (the first 256 KB, or the
whole buffer when smaller), ignores fenced code, inline code and HTML comments so
a code sample cannot classify the document, and requires a score of at least 4
with a 2-point lead; otherwise it returns null and the fallback applies. The
document-specific signals are:

| Weight | Markdown | Typst | HTML |
| --- | --- | --- | --- |
| 5 | YAML front matter (`---` + `key:` lines + `---`) | `#set/#show/#let/#import/#include` | `<!doctype html>`, `<html…>`, `<body…>` |
| 4 | ATX heading `# `, GFM table delimiter, task list | heading `= `, `#table(`, `#figure(` | starts with a block tag and has its matching close tag |
| 4 | `**strong**`, `[text](url)`, `![alt](url)` | `#link(`, `#image(`, `+ ` enum run | two or more structural tags with content |
| 1 | bullets, inline code, `$…$`, `*em*`/`_em_` | same shared constructs | an inline tag alone (`<b>`, `<span>`) |

Shared constructs never decide: a document containing only a bullet list, a
math span or an inline code span is ambiguous and falls back to
`doc.language`. A saved document is never scanned at all.

When the detected language differs from `doc.language`, the buffer's parser and
preview stay as they are; the paste uses the detected syntax and a one-time toast
says which one and suggests saving with that extension. The notice is per tab and
only appears when the paste actually changed the text or fetched an image, not on
every plain paste.

### Source selection, destination first

The destination above is fixed before the clipboard is read. The choice is then
not "which syntax is on the clipboard" in the abstract. It is "which clipboard
representation gives the best result in this destination". The rules, in order:

| Destination | Clipboard contents | Result |
| --- | --- | --- |
| Markdown | `text/plain` confidently Markdown | native paste, byte-identical |
| Markdown | HTML, and the plain text is not confidently Markdown | HTML → Markdown |
| Markdown | no HTML, plain text confidently Typst | Typst → Markdown |
| Typst | `text/plain` confidently Typst | native paste, byte-identical |
| Typst | HTML, and the plain text is not confidently Typst | HTML → Typst |
| Typst | no HTML, plain text confidently Markdown | Markdown → Typst |
| HTML | HTML | sanitized HTML fragment |
| HTML | no HTML, plain text confidently Markdown | Markdown → HTML |
| HTML | no HTML, plain text confidently Typst | Typst → HTML |
| any | anything else | native paste |

The rule in one sentence: **the plain-text representation wins when it already
matches the destination; otherwise HTML wins over a different text syntax; when
neither is decisive, paste natively.** A `text/markdown` MIME with no
`text/plain` is consumed and inserted by us, because CodeMirror's native paste
reads only `text/plain` and would otherwise insert nothing.

Consequences worth stating:

- Copying Markdown source from Typora into a Markdown document does not
  round-trip through HTML; the source arrives exactly as copied.
- Copying a rendered web page (whose `text/plain` is prose, not Markdown) into
  a Markdown document takes the HTML path, which is Typora's behaviour.
- Copying Typst source from another editor into a Typst document is likewise
  byte-identical even if that editor also put rendered HTML on the clipboard.
- HTML destination never imports a source style sheet or script; "same format"
  does not mean "trust the original document".

### Detection of a plain-text clipboard

This is the clipboard classifier, not the document classifier above: the
destination has already been resolved. MIME identifies a representation; the
source table decides which representation wins. `text/html` is authoritative when
present and is never sniffed. `text/markdown` is treated as Markdown source, and
when it is the chosen representation it is inserted by us if `text/plain` is
absent. Only when neither rich MIME is present is the plain text sniffed, and
only to decide whether it is **confidently** Markdown or Typst. The detector is
synchronous, allocation-light and fence-aware (code blocks and inline code are
ignored for scoring). A compact table of signals, not one regex for the whole
format:

| Weight | Markdown signal | Typst signal |
| --- | --- | --- |
| 4 | ATX heading `^#{1,6}\s+\S` | heading `^={1,6}\s+\S` |
| 4 | `**strong**`, `[text](url)`, `![alt](url)` | `#let/#set/#show/#import/#include`, `#table(`, `#figure(` |
| 4 | GFM table delimiter row, task list `- [ ]` | `^\+\s+` enum item run |
| 3 | fenced code (shared), reference definition, footnote | `#link("…")[`, `#image(`, label `<…>` |
| 2 | blockquote `> `, `~~strike~~` | `@reference`, term list `/ term:` |
| 1 | inline code, `$…$` (shared), bullets | `*strong*`/`_emph_` (too common in prose to score higher) |

A format is chosen only when its score is at least 4 **and** it leads the other
by at least 2. Otherwise the text is plain. Bullet lists alone never decide,
because both languages accept them; the destination rule already makes a bullet
list safe in Markdown and Typst. The exception is an **HTML destination**, where
a run of two or more `- ` or `1. ` lines scores 3 for Markdown: the plain
alternative would visibly lose the list, while the same text in a Typst
destination is already valid Typst and stays native. HTML source in a plain-text
clipboard is only recognized when it is a complete document (`<!doctype html>` or
`<html…>`), so a code snippet containing `<div>` is not eaten by a parser. The
document detector above is deliberately looser for HTML (a block tag at the start
plus its close tag), because a whole unsaved buffer that looks like markup is a
different signal from one pasted fragment.

### Readers

- **HTML** — `parse5` (already used by the HTML preview). Complete documents
  are parsed with `parse()` and walked from `body`; fragments with
  `parseFragment()`. CF_HTML wrappers (`Version:…`, `<!--StartFragment-->`) are
  normalized first. The walker maps semantic block and inline elements, maps the
  few inline CSS properties that Word/Google Docs actually use
  (`font-weight`, `font-style`, `text-decoration`, `vertical-align`), skips
  `script/style/meta/link/head` and hidden content, unwraps the Google Docs
  `docs-internal-guid` wrapper, and extracts KaTeX/MathJax TeX from an
  `annotation[encoding="application/x-tex"]`. Tables flatten `colspan/rowspan`
  into empty cells, because GFM cannot represent them; alignment is preserved.
- **Markdown** — `marked.lexer` with GFM. Block and inline tokens map directly;
  raw HTML tokens are passed back through the HTML reader so one fragment has
  one representation. A small, documented math scan (display first, tight inline,
  currency guard) mirrors the preview's intent without importing its DOM-bound
  code.
- **Typst** — `codemirror-lang-typst/lezer`'s `typstParser`, loaded on demand.
  It is synchronous, WASM-free, and error-recovering. Mapping covers headings,
  paragraphs, list/enum items (including nesting and continuation lines), raw
  blocks, equations, strong/emph, links/images/figures, simple `#table(...)`
  content blocks, quotes, escapes, references and labels. An unsupported code
  expression (`#set`, `#show`, arbitrary calls) is preserved as an inline code
  span or a fenced `typst` block rather than dropped; the document stays
  lossless and readable instead of silently losing content.

### Renderers

- **Markdown** — GFM. Context-aware escaping: always escape `` ` `` `*` `_` `[`
  `]` `<` `$` and `\` in text; escape `#`, `-`, `+`, `>` and an ordered-list
  `1.` only at a line start; escape `|` inside table cells; choose a code fence
  longer than the longest backtick run; angle-bracket link destinations when the
  URL contains spaces or parentheses. Blockquotes prefix every line, nested lists
  indent by the marker width, ordered lists keep their start number, task items
  keep `- [x]`/`- [ ]`.
- **Typst** — escape markup specials (`\ # * _ $ @ < > ~` and line-start
  `- + / =`), `*strong*`, `_emph_`, raw backticks, `#link("…")[…]`,
  `#image("…", alt: "…")`, `#table(columns: N, …)` (with `table.header` when the
  source had a header row, and escaped cell brackets), `#quote(block: true)`,
  `#strike`, `#super`/`#sub`, fences, `#line(length: 100%)`, and `$…$` math.
  Remote images become `#link` with alt text, because Typst cannot fetch a URL;
  a `data:` image that the resolver could not save becomes alt text with a
  notice.
- **HTML** — a semantic fragment, never the source document's markup:
  `<h1>…<h6>`, `<p>`, `<strong>`, `<em>`, `<s>`, `<code>`, `<pre><code
  class="language-…">`, `<ul>/<ol>/<li>`, `<blockquote>`, `<table><thead>…`,
  `<a href>`, `<img>`, `<hr>`, `<br>`, `<sup>/<sub>`. Math becomes MathML
  (`katex.renderToString(..., { output: "mathml" })`), which renders without a
  stylesheet.

For **HTML → HTML**, a separate sanitizing path is used: parse, remove
`script/style/link/meta/base/title/iframe/object/embed/form/input/button` and
comments, strip every `on*` attribute, `srcdoc`, and `javascript:`/`vbscript:`/
`data:` URLs outside `img src`, drop `annotation-xml`, unwrap the Google Docs
wrapper and dead `Mso*` classes, then serialize with `parse5.serialize`. It keeps
semantic tags, non-`Mso` classes, and safe inline style properties. A pasted
fragment is content, not a document.

### Insertion

A new `editor.insertPasted(text, block)` operation, one transaction with
`userEvent: "input.paste"`, so undo restores the whole paste in one step:

- **Inline** (one paragraph, only inline content): replace the selection with the
  text. Pasting `<b>word</b>` mid-sentence must not create a paragraph.
- **Block** (more than one block, or any heading/list/table/code/quote/rule/
  display-math): the block gets a blank line before and after, without
  duplicating blank lines that are already there, and the current line's leading
  indentation is reused for continuation lines. Examples:
  - `Text|` → `Text` + blank line + table;
  - `Text\n|Next` → `Text` + blank line + table + blank line + `Next`;
  - empty document → the block alone, no leading blank lines.
- After insertion the caret sits at the end of the pasted content and the preview
  re-renders through the existing change path.

### Images in every format

The existing image pipeline already saves the bytes and returns a path relative
to the document; what differs per format is only the syntax. That syntax moves
into one pure module, `src/image-syntax.ts`, so the image path and the paste
renderers cannot disagree:

| Document | Syntax produced for a saved image |
| --- | --- |
| Markdown | `![alt](path)` — exactly today's output |
| Typst | `#image("path", alt: "alt")`, or `#image("path")` when the alt is empty |
| HTML | `<img src="…" alt="…">` — exactly today's output |

`imageContext()` uses `imageSyntaxFor(doc.language)` and forces relative paths for
HTML **and Typst**. The Typst preview compiles with `--root` at the document
directory, so an absolute path outside it cannot resolve; HTML already forces
relative for the same class of reason. Markdown keeps its existing settings and
byte-for-byte syntax.

A clipboard bitmap still takes precedence in `handleImagePaste()` before rich
text is considered, so the path that already works is untouched. Only the final
syntax function changes for Typst, and the drag-drop path uses the same context.

Images inside a rich fragment are resolved through an injected sink, which keeps
the conversion core free of Tauri:

- `data:` URI → `save_clipboard_image`, the same command a bitmap uses, and the
  saved path in the destination syntax;
- an absolute local path or `file:` URI → `import_image` when `imageApplyLocal`
  allows it. A relative `src` from a copied web page is resolved against the
  fragment's `<base href>` when it has one; without a base it keeps its original
  relative reference and is not downloaded, because the source page's address is
  not on the clipboard;
- `http(s)` → downloaded through the existing `download_image` command when the
  new *Remote Images in Pasted Rich Text* preference is **Download and save**, then
  inserted as the saved local path in all three formats. **Keep the original
  URL** makes no request: the URL stays in Markdown and HTML, and Typst gets
  `#link("url")[alt]` because the compiler cannot fetch it. The explicit
  paste-a-URL path still follows *Apply Above Rules to Online Images*.
- If saving or downloading fails, keep the original reference where the
  destination can express it (the URL in Markdown/HTML, `#link` in Typst),
  otherwise fall back to the alt text; never drop the surrounding text. At most
  20 images are resolved per fragment, of which at most 8 are remote.

Network images are bounded so one slow host cannot hang a paste:

- 4 downloads at a time, 8 seconds per image and at most 8 remote images, so
  at most two waves and under 20 seconds in total;
- `download_image` gains an optional `timeoutMs` argument (clamped to 1–60 s,
  default 25 s, the current value) so the renderer can cap the wait without a new
  command; an aborted request writes no file;
- a download that fails or runs out of budget keeps its URL/link, and one toast
  says how many were saved and how many kept their address;
- images explicitly declared 1×1 or 2×2 (`width`/`height` attributes up to 2) are
  skipped as tracking pixels;
- nothing is requested at start-up, and nothing is requested unless a paste
  actually selects a rich source containing remote images **and** the new
  *Remote Images in Pasted Rich Text* preference is **Download and save**.

The new preference is intentionally specific: it is the switch for images inside
a pasted fragment, while *Apply Above Rules to Online Images* keeps governing an
image URL pasted on its own. If the image rule is `keepOriginal` while the new
preference says **Download and save**, the clipboard-image convention applies:
there is no local original to keep, so the file goes to the document's assets
folder and a toast says why. **Keep the original URL** overrides every download
path for rich paste, including `keepOriginal` (which is already a URL).

The paste waits for those downloads so the inserted text has final local paths
and stays one undo step. This is the same late-insertion behaviour the existing
image-URL paste already has, and a toast explains the wait. If the user types
while the images are arriving, the insertion follows the caret, exactly as the
bitmap/URL paths do today.

The sink is called for images from HTML and Markdown sources. A Typst source
image keeps its path, because the source path is the user's own project-relative
reference. Unit tests inject a fake sink; the application injects the real one in
`main.ts`.

### Event wiring

`installImagePaste()` becomes `installPasteHandlers()`:

1. Move the caret for a preview-pane paste (unchanged).
2. Give `handleImagePaste()` the first refusal (unchanged).
3. Read `text/html`, `text/markdown`/`text/x-markdown` and `text/plain`
   synchronously into strings.
4. Decide synchronously whether this paste is consumed (destination rule,
   preference, `Ctrl/Cmd+Shift+V`, code context, empty clipboard).
5. If consumed: `preventDefault()` and `stopPropagation()` in the same turn, then
   `void planPaste(...).then(insert).catch(fallback-to-plain)`.
6. Otherwise return without touching the event, so CodeMirror's native paste
   behaves exactly as before.

`Ctrl/Cmd+Shift+V` is tracked by one window-capture keydown listener that arms a
short-lived flag; the next paste is not consumed. On Windows this lets
Chromium's native "paste and match style" insert plain text. On macOS the flag
simply expires if the platform does not initiate a paste; the preference remains
the fallback. No accelerators are added, so the existing accelerator registry and
its 250 ms guard are untouched.

The code-context guard uses the syntax tree when the grammar is loaded
(Markdown `FencedCode`/`CodeBlock`/`InlineCode`, Typst `Raw`/`Code`, HTML by the
enclosing element tag) with a line-based fence scan as fallback.

### Safety and bounded work

- `parse5` is inert: nothing from the clipboard is inserted into a live DOM, and
  the paste module never calls `innerHTML`. The only HTML that reaches the HTML
  preview is text the user pasted into an HTML document, rendered later in the
  existing sandboxed guest.
- Link/image URLs are scheme-checked (`http`, `https`, `mailto`, `tel`, `#`,
  relative) and attribute values are escaped by every renderer.
- Network access happens only when a paste selects a rich source containing
  remote images, and only if *Remote Images in Pasted Rich Text* is **Download and
  save**. The explicit paste-a-URL path still follows `imageApplyOnline` and
  `keepOriginal`. It uses the existing `download_image` command, so the 32 MB
  body limit, HTTP(S)-only check, user agent and timeout plumbing stay in one
  place. At most 8 remote images per paste, 4 at a time, 8 s each — two waves,
  under 20 s total; no stylesheets, scripts, fonts or other subresources are
  fetched, and no frontend `fetch` is introduced (the call is still a Tauri
  `invoke`). The README and AGENTS.md wording must say that a paste can now reach
  the same command that an explicit image URL already reached, and that the new
  Image select disables it.
- Hotlink-protected images may refuse the request (403, referer check, login).
  That is a download failure like any other: the URL/link stays and the notice
  says some images were not saved. The document is never dropped.
- Caps: 2,000,000 characters of clipboard HTML, 1,000,000 of text, 20,000 IR
  nodes, depth 32. Above a cap, insert `text/plain` verbatim (or, when the
  clipboard carries only HTML, the text extracted from its parsed body) and toast
  once; a parse or render exception does the same and logs a `[paste]` warning. A
  paste must never lose text because a converter failed.
- The converters run only on paste; no work is added to typing, rendering or
  start-up. `parse5` and the Typst Lezer parser are dynamic imports, so their
  chunks load on first use.

### Rejected alternatives

1. **A one-way HTML→Markdown library (turndown, etc.) plus regexes for the
   rest.** Adds a dependency, still needs a second converter for Typst, and the
   two converters disagree about structure. The IR costs less than the drift.
2. **Pandoc for conversion.** Not always installed, a process spawn per paste
   (and the console-window trap), and the conversion must happen in the
   frontend anyway because that is where the clipboard lives.
3. **DOMParser instead of parse5.** It is synchronous and built in, but it is
   browser-only, so the conversion matrix could only be tested through CDP, and
   the project already depends on parse5. The pure core is worth the one-time
   dynamic import.
4. **Using only `settings.defaultExtension` for an unsaved buffer.** That was the
   earlier assumption and it is wrong: Save As can choose any extension, and the
   user can type another markup before saving. The plan detects the active buffer
   and keeps the default only as the fallback. **Reclassifying the parser or
   preview from that detection** is still rejected in this change: it flips the
   grammar under text the user has already typed. Detection chooses the paste
   syntax; a notice points at Save As.
5. **A live contenteditable bridge** (paste into a hidden div, read the DOM).
   Executes clipboard HTML, loses undo, and cannot produce Typst.
6. **Round-tripping through `renderPreview()` for Markdown→HTML.** It adds
   `data-line` anchors, heading ids, preview decorations and DOM work that must
   not enter a document, and it cannot serve the other destinations. A second
   renderer would appear anyway.
7. **Always plain, or always HTML.** The status quo is the bug; always HTML
   corrupts Markdown and Typst with raw tags.
8. **Regex-only Typst reading.** The Lezer parser is already installed,
   synchronous and handles nesting and escapes; regexes would mis-nest lists and
   content blocks.
9. **Clipboard-reading menu commands.** WebView2's clipboard permission is not
   available to the page without a host handler or a new plugin; the preference
   plus the native `Ctrl+Shift+V` covers the escape hatch.
10. **A new dependency or a Rust-side converter.** No platform API is needed,
    and Rust cannot see the paste event's rich formats without a plugin; keeping
    it in the frontend preserves the existing split.
11. **Insert the text first and localise images afterwards.** It makes undo
    non-atomic, needs position tracking across edits, and can leave references
    pointing at half-downloaded state. The bounded wait keeps one paste as one
    undo step.
12. **An unbounded download or a new batch-download command.** The existing
    command plus an optional timeout, a four-way pool and a per-paste cap is
    smaller than a new Rust API and cannot hang a paste indefinitely. A batch
    command remains an option if cancellation or a global deadline is ever
    needed at the Rust level.

## Steps

- [x] 1. Add `src/paste/ir.ts`: block/inline unions, table/list/task/math
      shapes, helpers for block detection and capability limits.
- [x] 2. Add `src/paste/detect.ts` and `src/paste/detect-document.ts`:
      synchronous clipboard classification with the signal table, and
      `resolvePasteDestination()` plus the document classifier for the
      saved/unsaved/fallback rule. Keep both dependency-free and testable.
- [x] 3. Add `src/paste/index.ts`: `planPaste()` orchestration, source priority,
      size/node caps, fallback to plain, and the notices a caller may toast.
- [x] 4. Add the HTML reader (`src/paste/read-html.ts`): parse5 parsing,
      CF_HTML normalization, block/inline walker, inline-style mapping, hidden
      content, Word/Google Docs quirks, tables, code and math extraction, and
      image discovery: `<base href>` resolution, `<picture>/srcset` and lazy
      `data-src`/`data-original` fallbacks, largest candidate when there is no
      `src`; skip explicit 1×1/2×2 images. Convert raw HTML inside Markdown
      through the same reader.
- [x] 5. Add the Typst reader (`src/paste/read-typst.ts`): lazy
      `codemirror-lang-typst/lezer`, markup walker, lists, raw blocks, equations,
      `#link`/`#image`/`#figure`/`#table`/`#quote`, and the
      unsupported-code-to-code-block fallback. Add `src/paste/math.ts` for the
      bounded TeX→Typst translator used by both source readers, keeping unknown
      commands as bare names so the formula still parses.
- [x] 6. Add the Markdown reader (`src/paste/read-markdown.ts`): `marked.lexer`,
      GFM tables/tasks/nesting, raw HTML delegation, and the small math scan.
- [x] 7. Add the three renderers (`src/paste/render-markdown.ts`,
      `render-typst.ts`, `render-html.ts`) and the HTML-fragment sanitizer
      (`src/paste/html-fragment.ts`). Verify escaping against the special-
      character corpus.
- [x] 8. Extend the editor: `insertPasted(text, block)` and `inCodeContext()` on
      `EditorHandle`; one transaction, `userEvent: "input.paste"`, block
      separation, indentation reuse, caret placement.
- [x] 9. Image parity: add `src/image-syntax.ts` with the Markdown, Typst and HTML
      builders; route `imageContext()` and `handleImagePaste()` through it; force
      relative paths for Typst as HTML already does; add the image sink to
      `planPaste()` and wire the real resolver in `main.ts` for `data:`, local and
      remote images, reading the new *Remote Images in Pasted Rich Text* preference
      (`download` vs `url`). Add the optional `timeoutMs` to `download_image` and
      its `src/api.ts` wrapper (clamped to 1–60 s), and implement the
      4-at-a-time / 8 s / two-wave download cap. Markdown's output must not
      change.
- [x] 10. Add the two preferences end to end: `rich_paste` (Editor, default true)
      and `rich_paste_images` (`"download"` default, or `"url"`) in
      `src-tauri/src/settings.rs` (serde defaults), `Settings` in `src/api.ts`,
      the Editor checkbox and the Image select row in `src/preferences.ts`, and
      both fields in `src/main.ts`'s `applySettingsPatch` (no re-render needed).
      Add a Rust unit test for the defaults and a settings round-trip. The
      select's help says: it applies to images inside formatted text pasted from
      a browser or another editor; **Download and save** writes them to the
      document's assets folder and contacts their hosts; **Keep the original
      URL** makes no request; an image URL pasted on its own still follows
      *Apply Above Rules to Online Images*. No dead or duplicate control is
      introduced.
- [x] 11. Wire the paste handler: resolve the destination first (saved extension;
      unsaved `detectDocumentLanguage`; fallback to `doc.language`), then read the
      clipboard synchronously, decide the source, `preventDefault`, convert
      asynchronously, insert, fall back to plain, honour `Ctrl/Cmd+Shift+V`, the
      code-context guard and the size-cap toast, and show the one-time
      "pasted as X" notice when the detected language differs from
      `doc.language`. Keep the image path first.
- [x] 12. Add `scripts/paste-convert-test.mjs` and `npm run paste:convert`: a
      pure Node suite that bundles `src/paste/index.ts` with Vite's JS API into a
      temporary directory and imports it. Assert the clipboard detection table,
      the document detection table (saved is not scanned, blank/ambiguous
      fallback, Markdown/Typst/HTML examples, code-only and front-matter cases),
      every reader/renderer pair, escaping, sanitizer security, caps, the three
      image syntax builders (including quote/backslash escaping and the
      empty-alt case), a fake image sink, and a round-trip property over the
      nasty-character corpus.
- [x] 13. Add `scripts/rich-paste-test.mjs` and `npm run paste`: a CDP suite
      against `samples/feature-tour.md`. Paste synthetic `ClipboardEvent`s and
      assert source and preview: HTML→Markdown structure, Markdown verbatim,
      plain unchanged, inline versus block insertion, code-context bypass,
      preference off, undo restores in one step, no console exceptions. Then
      exercise the unsaved destination: a new tab with Markdown-default
      `doc.language` but Typst content must paste as Typst, a Markdown-looking
      buffer must paste as Markdown even when the default is Typst (change the
      preference or use a new tab), an HTML-looking buffer must paste as HTML,
      a blank buffer must fall back to the default, and an ambiguous prose buffer
      must fall back; the one-time notice appears only in the first cases.
- [x] 14. Add `scripts/image-syntax-test.mjs` and `npm run image:syntax`: launch
      with `samples/typst-tour.typ`, paste a canvas bitmap, assert the source
      contains `#image("…")` and no `![`, assert the toast names a saved path and
      that the file exists, then remove the assets folder it created in a
      `finally`. Run the existing `npm run images` against `feature-tour.md` to
      prove Markdown did not move, and check HTML's `<img>` path manually or in
      the same suite if the fixture can be opened safely.
- [x] 15. Extend `scripts/test-all.mjs`: a `node` suite kind (no app launch), the
      paste-convert suite first, the paste and image-syntax CDP suites later, and
      keep `node` suites runnable on platforms where CDP is unavailable.
- [x] 16. Run the affected layers: build, paste-convert, paste, image:syntax,
      images, smoke, syntax, shortcuts, html, and `npm run test:rust` for the
      optional `download_image` timeout. Confirm the existing counts have not
      moved.
- [x] 17. Write the ADR, add a short Paste section to AGENTS.md (pipeline, image
      syntax, the broadened outbound-request trigger, how to add a
      source/destination, test commands, any trap found), and update the README:
      feature list, network-rule exception 1 (a pasted rich fragment now reaches
      `download_image`, under the 8-image/4-way/8 s cap, and *Preferences ›
      Image › Remote Images in Pasted Rich Text* set to **Keep the original URL**
      disables it; an explicit image URL still follows *Apply Above Rules to
      Online Images*), test docs and code map. Then tick this plan and set its
      status.
- [ ] 18. Manual matrix on Windows: Chrome page selection, Word paragraph/list/
      table, Google Docs, Excel range, VS Code copy-with-highlighting, Typora
      copy, Notepad plain text, a copied bitmap, and a page with remote images
      (online import on and off), into each of `.md`, `.typ`, `.html`. Repeat at
      least one case in a new unsaved tab whose content differs from
      `defaultExtension` (Typst content with a Markdown default and vice versa),
      and one in a blank new tab. Record any quirk that becomes a trap.

## Files and modules

New:

- `src/paste/ir.ts` — the shared data model; no imports beyond types.
- `src/paste/detect.ts` — synchronous MIME/regex classification and decision for
  the clipboard.
- `src/paste/detect-document.ts` — `resolvePasteDestination()` (saved /
  unsaved / fallback) and the active-buffer classifier, sharing the signal
  weights with `detect.ts`.
- `src/paste/index.ts` — `planPaste`, source priority, caps, fallback.
- `src/paste/read-html.ts` — parse5 → IR, including math and style mapping.
- `src/paste/read-markdown.ts` — marked → IR.
- `src/paste/read-typst.ts` — Lezer Typst → IR.
- `src/paste/render-markdown.ts` — IR → GFM.
- `src/paste/render-typst.ts` — IR → Typst markup.
- `src/paste/render-html.ts` — IR → semantic HTML fragment, MathML.
- `src/paste/html-fragment.ts` — sanitizing HTML→HTML path.
- `src/paste/math.ts` — the bounded TeX→Typst math translator and the paste
  math scan.
- `src/image-syntax.ts` — the one place that turns `(alt, savedPath)` into
  `![…](…)`, `#image("…", alt: "…")` or `<img …>`; no Tauri import.
- `scripts/paste-convert-test.mjs` — Node conversion matrix, including the image
  syntax builders and a fake image sink.
- `scripts/rich-paste-test.mjs` — CDP integration suite.
- `scripts/image-syntax-test.mjs` — CDP image test: a bitmap in Typst, a remote
  image downloaded through a local HTTP fixture, and the same image with online
  import turned off; removes the assets it creates.
- `docs/adr/2026-10-17-rich-paste.md` — the durable decisions: the
  saved/unsaved/fallback destination rule (detection for paste only, parser
  unchanged), the IR pipeline, and the broadened `download_image` trigger.
- `docs/plans/2026-10-17-rich-paste.md` — this file.

Modified:

- `src/editor.ts` — `insertPasted`, `inCodeContext`, interface entries.
- `src/images.ts` — use `imageSyntaxFor()` instead of the local Markdown default;
  keep the save/import/download flow and `ImageContext` semantics unchanged.
- `src/main.ts` — destination resolution (saved extension, unsaved detection,
  default fallback), paste handler, decision, preference wiring, notices, the
  `imageContext()` language switch, the one-time "pasted as" notice, and the real
  rich-image resolver with the preference check and the 4-at-a-time / 8 s /
  two-wave cap.
- `src/paste/index.ts` — accepts and awaits the image sink before rendering, with
  the bounded pool for remote images.
- `src/api.ts` — `richPaste` and `richPasteImages` in `Settings`; optional
  `timeoutMs` on `downloadImage`.
- `src/preferences.ts` — the Editor checkbox, the Image select row and its help
  text; no other UI change.
- `src-tauri/src/settings.rs` — both fields, their serde defaults and a
  round-trip test; no migration (older files keep loading).
- `src-tauri/src/images.rs` — optional `timeoutMs` on `download_image`, clamped
  to 1–60 s, default 25 s, plus a unit test that the argument is accepted and a
  non-HTTP URL is still refused.
- `scripts/test-all.mjs` — `node` suite kind and the new suite entries.
- `package.json` — `paste`, `paste:convert` and `image:syntax` scripts only; no
  dependency.
- `AGENTS.md` — scripts table, test layers, code map, paste section, traps, and
  the outbound-request wording (the only request is still `download_image`, but
  a rich paste can now trigger it).
- `README.md` — feature bullet, paste/image behaviour and limitations, the
  unsaved-buffer detection and fallback, the network-rule paragraph, test
  commands, code map.

## Risks and rollback

- **Clipboard lifetime.** Reading the `DataTransfer` after an `await` can return
  empty. Mitigation: read into strings synchronously; all conversion works from
  plain strings. This is also the existing "preventDefault must be synchronous"
  rule.
- **Asynchronous insertion ordering.** On first use the parse5/Typst chunks take
  a few milliseconds to load, and a paste with remote images can wait up to two
  eight-second download waves. If the user types before insertion, the paste can
  land at the moved caret. Mitigation: the download budget is hard-capped, a
  toast explains the wait, the insertion reads the current selection, and the
  existing bitmap/URL paste already behaves this way. If it proves visible, the
  rejected background-localisation design is the next step, not an unbounded
  wait.
- **Network and privacy.** Pasting a page now fetches its images automatically,
  which reveals the user's IP to those hosts and can reach tracking pixels. This
  is the explicit product decision; mitigation: *Preferences › Image › Images in
  Pasted Rich Text* can be set to **Keep the original URL** and stops every
  request for this path, while *Apply Above Rules to Online Images* still governs
  an explicit URL paste; explicit 1×1 and 2×2 images are skipped, the trigger is
  always a user paste, and the README states the consequence instead of hiding
  it.
- **Slow or failing downloads.** A dead host could hold up a paste. Mitigation:
  `download_image` gets an 8-second timeout for this path (25 s remains the
  default for an explicit URL paste), four concurrent downloads, at most eight
  remote images per fragment — two waves, under 20 seconds. A failed image keeps
  its URL/link; the text is never delayed beyond the cap.
- **Two image preferences that could be confused.** *Apply Above Rules to Online
  Images* and the new *Remote Images in Pasted Rich Text* do different jobs. Mitigation:
  the new select's help text names the scope explicitly, the network paragraph in
  the README describes both, and the Image suite exercises both values so the
  control cannot silently become decorative ("no dead UI").
- **`keepOriginal` while downloading rich images.** The rule says "link, do not
  copy", but the new preference says "download and save". Mitigation: follow the
  clipboard-bitmap convention — a pasted fragment image has no original local
  file to keep, so the file goes to the assets folder and a toast explains the
  override; **Keep the original URL** is the setting that means "no copy".
- **False clipboard detection.** A plain paragraph containing Markdown-like
  punctuation could be converted. Mitigation: score threshold plus a 2-point
  margin, no conversion when the destination already matches, the preference, and
  `Ctrl/Cmd+Shift+V`. Failure loses formatting, not text.
- **False or missed destination detection.** An unsaved buffer can look like two
  languages, or contain a signal only after the 256 KB sample. Mitigation: the
  same threshold and margin, shared constructs never decide, empty/ambiguous
  buffers fall back to `doc.language`, a saved file is never scanned, and the
  Node matrix covers blank, ambiguous, code-only, front-matter, Markdown, Typst
  and HTML buffers. A wrong detection changes the syntax of one paste, not the
  document's parser or file.
- **Detected destination differs from the editor's grammar.** An unsaved buffer
  created as Markdown can contain Typst and paste as Typst while the editor still
  highlights and previews Markdown until Save As. Mitigation: a one-time notice
  names the paste syntax and suggests the extension; the parser is not flipped
  under the user. If this proves too subtle, the open question below is whether
  the editor should follow the detected language explicitly.
- **Destination detection cost.** Running a scan on every paste could be slow on
  a huge buffer. Mitigation: first 256 KB only, synchronous regex work, no scan
  on saved files, and no detection during typing or rendering.
- **HTML variants.** Word, Google Docs, Excel, Outlook and browser markup differ
  from the fixtures. Mitigation: the semantic walker ignores unknown wrappers,
  the manual matrix in step 18, and fixtures built from real payloads rather than
  invented HTML.
- **The Markdown image path regresses.** It is the one behaviour the user
  explicitly asked to preserve. Mitigation: `imageSyntaxFor("markdown")` returns
  the identical `![alt](path)` string, the existing settings still decide the
  path, and the Node matrix plus `npm run images` assert both the string and the
  end-to-end result. HTML and Typst share the function only after that string is
  pinned.
- **Typst cannot reach a path outside its root.** The preview runs
  `typst --root <document dir>`, so `..\..` and absolute paths fail even though
  they may be valid for Markdown. Mitigation: force relative paths for Typst,
  keep the default assets folder under the document, and treat an import that
  lands outside the root as a notice rather than pretending the image rendered.
  An untitled Typst document has no folder; the existing save-to-working-directory
  behaviour applies, and the preview may not reach the file until the document is
  saved.
- **Image tests write into the repository.** Pasting a bitmap or downloading a
  fixture image saves into `<document>.assets/`. Mitigation: the new CDP image
  suite removes the folder in a `finally`, its HTTP fixture binds to 127.0.0.1 on
  an ephemeral port, and the existing manual image test keeps its own fixture
  server and assets out of the automated run.
- **HTML→HTML sanitizer is deliberately lossy.** Source stylesheets, scripts,
  classes tied to them and layout are dropped. Mitigation: it is the safe
  definition of "paste content"; the preference off gives plain text, and a
  future "paste as HTML source" command can be added without changing the core.
- **Typst output is syntax-checked, not compiled, in the suite.** Typst may not
  be installed where the tests run. Mitigation: re-parse every emitted document
  with the Lezer parser and assert no `Error` node; manual compile on a machine
  with Typst.
- **Math fidelity.** TeX→Typst is a bounded translator, not an engine.
  Unsupported commands become bare names so they parse but may need editing;
  the README says so.
- **Bundle growth.** The pure paste core is small; parse5 and the Typst parser
  are lazy. The Vite build output will show the chunk sizes; if the Typst chunk
  is unacceptable, the Typst reader is the one step that can be deferred without
  affecting the Typora case.
- **Rollback.** The feature is isolated: `src/paste/`, one editor method, one
  paste branch, two settings fields. Turning the conversion preference off is the
  user-level rollback for conversion; setting *Remote Images in Pasted Rich Text* to
  **Keep the original URL** is the rollback for network access from rich paste
  (and *Apply Above Rules to Online Images* off, or `keepOriginal`, covers an
  explicit URL). Reverting the commit restores today's paste and the old
  `download_image` signature (the new argument is optional, so an older frontend
  still compiles against it). No new command, menu event or file format is
  introduced.

## Tests and validation

Layers, cheap to expensive:

1. **Typecheck/build** — `npm run build`.
2. **Paste conversion (Node)** — `npm run paste:convert`, also a `node` suite in
   `npm test`. Covers:
   - the **clipboard** detection table, including the destination-aware cases and
     the no-conversion cases;
   - the **document** detection table through `resolvePasteDestination()`: saved
     files are never scanned even when their content looks like another syntax;
     blank, whitespace-only, ambiguous, shared-syntax-only and code-only buffers
     return the fallback; a Markdown heading/table/front matter, a Typst `= `
     heading or `#set`, and an HTML doctype/block element each detect; a 2-point
     margin is required;
   - HTML→Markdown, HTML→Typst, HTML→HTML; Markdown→Typst, Markdown→HTML;
     Typst→Markdown, Typst→HTML;
   - headings, nested/task lists, tables with alignment, code with language,
     quotes, links, images, rules, hard breaks, sub/sup, math;
   - `imageSyntaxFor()` for all three formats, including quotes/backslashes in a
     Typst path and alt, an empty alt, and the exact Markdown string that exists
     today;
   - a fake image sink resolves `data:`, local and remote images to local paths;
     when the fake sink says "not allowed", the same image keeps its URL in
     Markdown/HTML and becomes `#link` in Typst; a failed sink keeps the original
     reference or the alt text and never drops the fragment;
   - the bounded download pool never exceeds four concurrent calls, never starts
     more than eight remote images, and records a timeout as "keep the URL";
   - the nasty-character corpus round-trips: converting, re-reading and folding
     to text must return the original characters;
   - HTML→HTML security: `<script>`, `onerror`, `javascript:` links, `<style>`,
     `<svg onload>`, `annotation-xml`, hidden content;
   - caps and exceptions fall back to plain text.
3. **Rich paste (CDP)** — `npm run paste`, also a CDP suite in `npm test`.
   Covers:
   - a synthetic HTML clipboard into Markdown inserts `##`, `**`, `-`, a GFM
     table; the preview has the corresponding `h2`/`strong`/`ul`/`table`;
   - Markdown source pasted into Markdown is byte-identical;
   - plain prose is untouched;
   - an inline HTML fragment pasted mid-line has no surrounding blank lines; a
     table pasted at a line boundary is separated by blank lines;
   - a paste over a preview block lands in the source at that block;
   - inside a fenced code block the raw clipboard text is inserted;
   - an unsaved tab whose buffer is Typst but whose `doc.language` came from a
     Markdown default pastes as Typst, and the one-time notice says so;
   - an unsaved tab whose buffer is Markdown but whose default extension is Typst
     pastes as Markdown;
   - an unsaved tab whose buffer is HTML pastes as HTML;
   - a blank new tab falls back to the default extension, and an ambiguous prose
     buffer falls back silently;
   - the saved fixture keeps its Markdown destination after the unsaved-tab
     checks, so the detector state does not leak between tabs;
   - the preference off leaves the HTML as plain text;
   - `Ctrl+Shift+V` does not convert;
   - one undo restores the pre-paste buffer;
   - no `Runtime.exceptionThrown`.
4. **Image syntax (CDP)** — `npm run image:syntax` against
   `samples/typst-tour.typ`: a canvas bitmap pastes as `#image("…")`, never
   `![…]`, the toast names the saved path, and the file exists. A second case
   starts a Node HTTP server on 127.0.0.1 with a PNG, pastes HTML containing that
   remote `<img>`, and asserts the source holds a local `#image("…")` with no
   `http`, the file exists, and only one file was written. The same case with
   *Preferences › Image › Remote Images in Pasted Rich Text* set to *Keep the original
   URL* asserts the URL/`#link` stays and no file is written. The suite restores
   the preference to **Download and save** before it exits. The folder is
   removed in a `finally`. `npm run images` against `samples/feature-tour.md`
   proves the Markdown path still produces `![alt](path)` and still saves the
   bitmap. The HTML `<img>` output is asserted in the Node matrix and checked by
   hand in step 18, because the existing HTML image behaviour is unchanged apart
   from sharing the syntax function.
5. **Existing suites** — `npm run smoke` (93), `npm run syntax` (7),
   `npm run shortcuts` (39), `npm run html` (42), `npm run images` with its
   fixture server, and `npm run test:rust` (the new optional timeout argument).
   The smoke and shortcut runs prove the new keydown listener and capture-phase
   paste handler did not disturb the existing paths.
6. **Manual matrix** — step 18; on macOS and Linux, at least a browser copy and
   a Word/Google Docs copy into each format, plus a copied bitmap and a page with
   remote images, both with the online-image preference on and off, because
   WebKitGTK has no CDP and clipboard MIME behaviour differs.

The measurements that prove the feature: a copied HTML table, list and bold
sentence pasted into a Typst document produce `#table(`, `- `, `*…*` and no HTML
tags, while the same clipboard into a Markdown document produces a GFM table,
`- ` and `**…**`, and the preview renders both. Separately, a copied bitmap in
each of `.md`, `.typ` and `.html` is saved to the document's assets folder and
appears as `![…](…)`, `#image("…")` and `<img …>`, respectively, with the file on
disk and the preview showing it. A pasted fragment with one remote image makes
exactly one request, writes one file, and inserts its local path in all three
formats when the Image preference says **Download and save**; with **Keep the
original URL**, it makes no request and keeps the URL/link. A new unsaved tab
whose buffer is Typst but whose default extension is Markdown pastes as Typst,
with the notice; a blank tab falls back to the default. An explicit image URL
pasted on its own still follows *Apply Above Rules to Online Images*.

Record the final check counts in AGENTS.md and README.md; the counts in this
repository are a contract.

## Acceptance criteria

- A saved file's extension decides the destination even when its content looks
  like another markup; it is never reclassified.
- An unsaved buffer with Typst content pastes as Typst even when it was created
  with a Markdown default; a Markdown buffer pastes as Markdown even when the
  default extension is Typst; an HTML-looking buffer pastes as HTML.
- A blank or ambiguous unsaved buffer falls back to `doc.language`, which is the
  default-extension language.
- When the detected destination differs from `doc.language`, a one-time notice
  names the syntax used and suggests saving with the matching extension; the
  editor's parser and preview do not switch under the user.
- Copying rich content from a browser, Word, Google Docs or Excel and pasting it
  into a Markdown document yields Markdown headings, bold/italic, lists, tables,
  code, quotes and links; the preview shows those elements.
- The same clipboard into a Typst document yields Typst headings, `*strong*`,
  `_emph_`, lists, `#table(...)`, `#quote`, raw blocks and `$…$`, with no HTML
  tags and no Markdown-only markers left behind.
- The same clipboard into an HTML document yields a semantic fragment with no
  `<script>`, no `on*` attribute, no `javascript:` URL and no source
  stylesheet.
- Pasting Markdown source into Markdown, or Typst source into Typst, is
  byte-identical to the clipboard.
- Plain prose pastes unchanged in every format.
- An inline paste in the middle of a sentence does not split the paragraph; a
  block paste is separated by the right number of blank lines and keeps the
  current indentation.
- Pasting inside a code block inserts the clipboard text verbatim.
- `Ctrl/Cmd+Shift+V` and the preference off both bypass conversion.
- Undo once restores the buffer to exactly what it was before the paste.
- A clipboard bitmap, a pasted image URL and a pasted local image path are saved
  through the existing pipeline and insert `![alt](path)` in Markdown,
  `#image("path", alt: "alt")` in Typst and `<img src… alt…>` in HTML. The file
  exists, the preview shows it, and the Markdown result is exactly what it was
  before this change.
- An image inside a rich fragment is saved to the document's assets when it is a
  `data:` URI, a local file, or a remote image allowed by the Image preferences.
  The three formats then receive `![alt](path)`, `#image("path", alt: "alt")` and
  `<img src… alt…>`; the file exists and the preview loads it.
- A remote image in a pasted fragment produces exactly one download when
  *Preferences › Image › Remote Images in Pasted Rich Text* is **Download and save**,
  and the inserted source carries the local relative path with no `http` left
  behind. With **Keep the original URL** selected, no request is made and the
  URL/link stays. A failed or timed-out download keeps the URL/link and never
  drops the text.
- *Preferences › Image › Remote Images in Pasted Rich Text* is a working control with
  two named values, not a dead row: switching it changes the paste result and the
  network behaviour, and its help states that an explicitly pasted image URL still
  follows *Apply Above Rules to Online Images*.
- A clipboard above the cap is inserted as plain text with one toast; a
  converter exception never loses the text.
- The application makes no network request at start-up and none without a user
  paste. The README and AGENTS.md say that the sole outbound command is still
  `download_image`, now reachable from a rich paste as well as an explicit image
  URL, and that the new Image preference can turn it off.
- No new npm or cargo dependency, no console exception, and the existing suites
  keep their counts.

## Open questions

1. **HTML→HTML style preservation.** Default: keep classes and safe inline
   style properties, strip active content, `Mso*` classes, `mso-*` properties
   and positioning. If users paste a web page expecting its look, a future
   "paste as HTML source" command is the honest answer, not keeping scripts.
2. **Headerless tables in Markdown.** Default: render an empty GFM header row
   instead of promoting the first data row, so no data changes meaning. Typst
   and HTML keep the table headerless.
3. **Math in Typst.** Default: the bounded TeX→Typst translator plus raw
   fallback names. A complete converter is a separate feature.
4. **Typst source reader scope.** Default: the Lezer mapping above; arbitrary
   `#let`/`#show`/`#table` expressions survive as code, not as converted
   structure.
5. **A "Paste as Plain Text" menu item.** Default: none in this change. If the
   clipboard plugin is added later, it can call the same `planPaste` with a
   forced plain source.
6. **Preference placement.** Default: the Editor checkbox next to the other paste
   controls and the two-value select in the Image section, where the rest of the
   image policy lives. Moving them to a future Paste section is cosmetic.
7. **Scope of *Remote Images in Pasted Rich Text*.** Default: images from HTML and
   Markdown pasted fragments; a Typst source image keeps its own path. If the
   select should cover only HTML, the Markdown reader can simply stop calling the
   sink.
8. **`keepOriginal` while the select says Download.** Default: map it to the
   assets folder with a notice, following the clipboard-bitmap convention, because
   a pasted fragment image has no original local file to keep. **Keep the original
   URL** is the no-copy option. Revisit if the override surprises users.
9. **Tracking pixels that do not declare a size.** The default skips only
   images whose `width`/`height` attributes are at most 2. A stricter URL/alt
   heuristic would catch more, at the cost of skipping legitimate images; leave
   it out until there is evidence.
10. **Should the editor's grammar and preview follow the detected destination?**
   Default: no. Detection chooses the paste syntax only and a notice points at
   Save As; switching the parser under the user is the behaviour `languageFor()`
   deliberately avoids. A clickable "detected format" chip would be the next
   step if the mismatch proves confusing.
11. **Should Save As preselect the detected extension?** Default: no in this
   change; it still suggests `defaultExtension`. Aligning it with the detector is
   a separate, visible workflow change.
12. **Detection sample size.** Default: the first 256 KB of the active buffer.
   A document whose only distinctive syntax appears later falls back to the
   default; scanning more on every paste would trade that for latency.
13. **Node suite harness.** Resolved: the paste modules import directly under
    Node 24 type stripping, exactly like `sessions-test.mjs`; no Vite build step
    was needed. Node 20 remains a build prerequisite, but the unit layer the
    repository already had depends on 24.

## Implementation notes (deviations and verification)

- Steps 1–17 are implemented. Step 18 (the manual Word/Google Docs/Excel
  matrix) was **not** completed; the synthetic clipboard tests and the Node
  matrix cover the conversion paths, but a real Word/Docs/Excel payload still
  deserves a human pass.
- **Deviation:** `scripts/paste-convert-test.mjs` imports `src/paste/index.ts`
  directly instead of bundling it with Vite. `sessions-test.mjs` already
  establishes that convention; Node 24 strips the types.
- **Deviation:** the Markdown image builder deliberately does **not** escape
  `]` in alt text, because the previous image path did not. That keeps
  `![alt](path)` byte-identical; Typst and HTML still escape their strings.
- The image CDP suite covers the Typst bitmap and the two remote-image modes;
  Markdown and HTML image syntax are covered by the Node matrix, and the existing
  `npm run images` path is unchanged.
- `detect-document.ts` shares the signal table with `detect.ts` but keeps the
  looser HTML rule and the saved/unsaved/fallback decision.
- Validation run: `npm run build`; `npm run paste:convert` 51/51;
  `npm test -- --only paste-convert,paste,image-syntax --no-build` 51/51,
  23/23 and 14/14; `npm test -- --only smoke,syntax,shortcuts,html,tabs
  --no-build` 93/93, 7/7, 39/39, 42/42 and 68/68. Rust: 76 passed + 1 ignored
  when the test executable is run outside the workspace; the 14 failures inside
  the workspace are the documented `%TEMP%` sandbox, not the tests.
- Traps recorded in AGENTS.md: the Typst list-item `Space` and the
  `.cm-content.innerText` blank-line artefact.
