# Paste and image traps

Rich paste, the clipboard, image destinations and the markup each document format expects.

Part of [the trap record](../traps.md). Search across every domain with:

```powershell
rg -n "<literal error text>" docs/agent-guide/traps
```

**A pasted URL lands in the document *and* becomes an image**
`preventDefault()` was called from a promise continuation. The decision must be
synchronous with the event; only the work may be deferred.

**A pasted HTML snippet becomes the editor's syntax highlighting — or nothing at all**
Copying `<link rel="stylesheet" href="…">` from a source editor with highlighting
and pasting it into an HTML document inserted
`<div style="color: #d4d4d4; white-space: pre"><div><span style="color: #808080">&lt;</span>…`,
and when the clipboard's HTML representation was the bare tag the paste inserted
**nothing**. The plain text was already the destination's syntax, but
`chooseSource` only trusted plain text that `detectTextSyntax` classified, and
`scoreHtml` refuses an HTML *fragment* on purpose — "a code snippet starting with
`<div>` must not be eaten by the parser" — so the next branch handed the snippet
to the parser anyway, through the clipboard's HTML representation, and
`sanitizeHtmlFragment` drops `link`, `meta` and `style`. `isHtmlSource()` now
names the source, and the destination decides whether it is pasted or converted.
Measure the paste
layer without the application: Node 24 strips the types, so a scratch `.mjs` that
imports `src/paste/index.ts` and calls `planPaste` prints exactly what the editor
will insert. Do not start by suspecting the sanitizer or the paste handler.

**Pasting an HTML article into Markdown inserts the literal tags**
A fix that made clipboard markup win in *every* destination repaired HTML and
broke Markdown: `<p>…<strong>…</strong>…</p>` landed in a `.md` file verbatim,
when the reader expects `**…**` and `[text](href)`. The clipboard is identical in
both reports — `<p>…</p>` source text plus a decorated HTML representation — so
the **destination** carries the intent: "keep this markup" in HTML, "convert
this into my format" in Markdown, Typst and AsciiDoc. `chooseSource` reads the
text as the *source format*, pastes it untouched only when that format is the
destination, and otherwise converts the **text** (never the HTML flavour, which
is only the same characters decorated and loses the spaces between token spans).
A snippet the HTML reader keeps nothing of (`<link>`, `<meta>`) is rendered as
escaped literal text for the destination. When a paste rule feels wrong in one
direction, add the case to `scripts/paste-convert-test.mjs`: the matrix is the
only thing that stops the next one-legged fix.

**The spaces vanish from a converted snippet (`como**CPF…**a`, `golpes,[doxing](…)e`)**
`src/paste/read-html.ts` trimmed the edges of *every* inline element's children
(`trimInline` inside `convertInline`, `wrap` and `inlineFrom`), so a space that
lives inside a wrapper was thrown away even though it is significant between
that element and its neighbour in the parent's flow — a syntax highlighter's
per-token `<span>`, or a page where an extension such as Google Translate or
Grammarly wraps every text run. Copying

```html
<p>… como <strong>CPF, e-mail ou telefone</strong> a estranhos, … <a href=…>doxing</a> e …</p>
```

from a rendered page produced `como**CPF, e-mail ou telefone**a estranhos` in
Markdown **and** AsciiDoc. Only a *block's* outer edges may be trimmed, and the
trim must descend through wrappers: `trimFlow` (join text, then
`trimStart`/`trimEnd`) runs at the paragraph, heading, list item, table cell and
flush level, while inline elements keep their edges (`joinText`).
`scripts/paste-convert-test.mjs` pins the sentence with and without `<span>`
wrappers, in both destinations. Do not "fix" this in a renderer: the IR is where
the space is lost.

**A pasted image URL shows a broken image and no folder is written, whatever the Image rule says**
The rich-paste resolver caught every failure with `console.warn` only and kept
the URL, so the reader saw a broken image and no explanation; changing the rule
could not help because the bytes never arrived. Reproduce the reported case
without the app: the address answers
`401 {"detail": "Not authenticated"}` to a request without the web app's
session, while the same URL renders in the user's browser. MDraft's WebView has
no session to lend, so no folder rule can copy it. `resolveImages` now turns a
failure into a notice (and `applyRichPaste` shows it), the direct URL paste keeps
the address instead of swallowing the paste, and `download_image` refuses a 200
that is not an image. Do not look for a path-handling bug when the status is 401.

**A local image is copied but the preview is an empty `<img>` with no `src`**
DOMPurify's default URI rule sees `C:` in `C:\Pictures\x.png` as an unknown
scheme and removes the attribute before `decorateLinks` can turn it into an
`asset:` URL. The image is on disk and the source is correct, which is what
makes it look like an asset-protocol failure. `src/markdown.ts` now passes an
`ALLOWED_URI_REGEXP` that admits `[A-Za-z]:[\\/%]`. Two details are easy to get
wrong: the hyphen must be escaped (`[a-z+.\-:]`), because `[a-z+.-:]` is a range
from `.` to `:` that **excludes `/`**, so every relative path without `./`
(`notes.assets/a.png`) is stripped as well; and a test must cover both a bare
relative path and a drive path, because `./` survives through the `[^a-z]`
branch and hides the range bug.

**Typst says `error: unknown image format` for AVIF (and HEIC, BMP, ICO)**
Typst 0.15.1 reads PNG, JPEG, GIF, WebP and SVG only; measured by compiling
`#image("sunset-beach.avif")` with the managed `typst.exe`. The webview decodes
AVIF, so it renders correctly in a Markdown or HTML preview and fails only in a
Typst document — do not infer compiler support from browser support. The app
saves the file (the rule asked for a copy) and inserts no reference, with a
toast naming the formats Typst does read. WebP *is* supported and must be
inserted normally.

**A clipboard bitmap pasted into an untitled document is written under `C:\Program Files\MDraft`, or the paste fails with `Access is denied`**
`target_dir` fell back to `std::env::current_dir()` when `document_path` was
`None`. An installed shortcut starts the app in its own program folder, so the
rule had no real destination. A rule now applies only when it names a folder
that exists without the document: a saved document's folder, or an **absolute**
Custom Folder. A URL or local path keeps its original address in an untitled
buffer (a toast says why); a clipboard bitmap is refused with "Save it first"
unless an absolute custom folder is configured. Typst and HTML need one more
condition: both resolve local images against a root only a saved document has,
so an untitled buffer of either language refuses the bitmap even with an
absolute folder. Never restore the working-directory fallback to make a test
pass.

**`Ctrl+click` on a link adds a second cursor instead of following it**
CodeMirror's built-in `mousedown` handler appends **after** extension handlers
(`computeHandlers` in `@codemirror/view`), and `allowMultipleSelections` is on,
so the default Ctrl+click gesture is a multi-cursor edit. A `ViewPlugin` with
`domEventHandlers.mousedown` must resolve the target and return `true` before the
built-in runs; the built-in sees `defaultPrevented` and stops. Open on
`mouseup` with a small movement threshold, not on `mousedown`: returning `true`
already suppressed the built-in selection, and opening immediately would launch
a link when the reader meant to Ctrl+drag from it. `Ctrl+click` on prose must
still add a cursor, so the handler returns `false` when `linkAt` is null.

**A `file:///C:/My%20Pictures/a.png` or Explorer's `"C:\My Pictures\a.png"` is pasted as text**
`localImageFromText` rejected any whitespace and stripped the scheme without
decoding it, so the resolved path began `/C:/…` and `path_is_file` said no.
Strip one pair of matching quotes, decode `file://` through `URL` (restoring a
UNC host), percent-decode the pathname, drop the slash before a drive, and allow
spaces when the value contains a path separator. A sentence that merely ends in
`.png` still has no separator and stays text.

**Pasting an article leaves `\` at the end of every paragraph, and one alone on the blank line**
The CMS wrote its visual paragraphs as `<br><br>` inside a single `<p>` (the UnB
Notícias article does), and the HTML reader turned each `<br>` into a hard
break. Markdown renders a break as `\` plus a newline, so each paragraph
boundary became two of them. A selection's clipboard HTML is not the page's
outer markup: clone the range and inspect it before assuming `<p>…</p><p>…</p>`
— every paragraph can be one text node run inside one `<p>`. The reader now
treats a run of two or more `break` nodes as a paragraph boundary and drops a
break at a block's edges, while a single `<br>` stays a hard break.
`scripts/paste-convert-test.mjs` pins both rules. To reproduce without the app,
import `planPaste` in a scratch `.mjs` and pass the cloned fragment as `html`;
Node 24 strips the types.
