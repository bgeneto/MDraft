# HTML as a third native document format

**Status:** draft — superseded by
[`2026-10-17-html-preview-guest.md`](2026-10-17-html-preview-guest.md)
**Date:** 2026-10-17
**ADR:** none (this draft was not approved)

> **Superseded.** This draft was written before the user's plan at
> `docs/plans/html-editor/README.md` became readable. The merged plan is
> [`2026-10-17-html-preview-guest.md`](2026-10-17-html-preview-guest.md); keep
> this file as the record of the first review, not as the plan to implement.

## Context and goal

Today MDraft edits two markup languages: Markdown (`.md`, `.markdown`, `.mdwn`,
`.mkd`, `.txt`) and Typst (`.typ`). Both are rendered by the application: marked
turns Markdown into HTML, Typst compiles to HTML or page images, and every block
is drawn inside the application's own `.markdown-body` typography. HTML export
exists, but only as an output format.

The goal is to make `.html` and `.htm` first-class documents as well:

- open, edit, save and reload them exactly like the other two formats;
- preview them as the document was written, not as MDraft thinks a document
  should look: its own `<style>`, linked CSS (including CDN stylesheets such as
  Bootstrap or Tailwind), images, inline and external `<script>`, `<base>`,
  fonts that allow cross-origin loading, media and so on;
- keep the parts users already rely on: split view, vertical scroll sync,
  click-to-line, the transient blink on the matching block, outline, status
  bar, autosave, recent files, drag-and-drop, image paste, export to HTML/PDF
  and to every configured pandoc format;
- render `$…$`, `$$…$$`, `\(…\)` and `\[…\]` in HTML text with KaTeX, the same
  math users already type in Markdown;
- leave every existing Markdown and Typst behaviour exactly as it is.

The product rationale is real: HTML is the only common document format the app
cannot open, and it is the one that can carry its own layout, its own JavaScript
and a whole ecosystem of CSS. The implementation is **not** a small branch in
`doRender`, though. An HTML document is executable, untrusted content, and the
webview it runs in has Tauri's IPC bridge behind it. The feature is worth doing
only with a hard origin boundary; the rest of this plan is mostly about that
boundary and about keeping the preview from leaking into the shell.

## What is true today

Facts that shaped the plan, so a later reader does not have to rediscover them:

- `languageFor()` classifies only `.typ` as Typst and everything else as
  Markdown. The editor's language support is a `Compartment` with exactly two
  states (`markdown`, `typst`), and `@codemirror/lang-html` is already in
  `node_modules` as a transitive dependency of `@codemirror/language-data`
  (lockfile entry `6.4.12`), so adding HTML syntax is a declaration, not a new
  download.
- The Markdown preview is raw HTML inside `#preview` in the parent document.
  The Typst preview is also parent DOM (or `<img>` pages). Both are styled by
  `styles.css` and both are positioned with `data-line` attributes.
- `renderPreview()` sanitises with DOMPurify and forbids `script`, `iframe`,
  `object`, `embed`, `form` and friends. That is correct for Markdown; it is the
  exact opposite of what an HTML document needs.
- The app's CSP is `null`, but that does not make an iframe safe: Tauri injects
  its IPC initialization scripts, and wry documents that on Windows those
  scripts are added to **subframes as well**, regardless of
  `for_main_frame_only`. `withGlobalTauri: false` removes the convenience
  `window.__TAURI__` global, not `window.__TAURI_INTERNALS__`.
- The IPC custom protocol reads the `Origin` header and requires a parseable
  URL. A sandboxed `srcdoc` iframe has an opaque origin, so its `fetch` carries
  `Origin: null`; `parse_invoke_request` rejects it before any ACL check. The
  `postMessage` fallback needs the per-webview invoke key hidden in the IPC
  closure and reports the frame URL (`about:srcdoc`) as its source. This is the
  security argument, and step 0 exists to prove it on this machine.
- The asset protocol (`asset://localhost` on macOS/Linux,
  `http://asset.localhost` on Windows) answers with
  `Access-Control-Allow-Origin: <window origin>`, not `*`. Images, stylesheets
  and classic scripts load cross-origin; local web fonts, ES modules and
  `fetch()` of local files do not, because those require CORS. Changing that
  header would let a document read arbitrary files in the asset scope, so it
  must not be changed.
- `convertFileSrc()` percent-encodes the whole path, including separators. It
  cannot be used directly as a `<base href>` (a relative `img.png` would replace
  the whole encoded path). The preview needs a directory URL with real `/`
  separators and each segment encoded separately.
- Vite's `?inline` on `katex/dist/katex.min.css` makes a self-contained KaTeX
  stylesheet: measured here, a dynamically imported chunk of **1,494,677 bytes**
  (1.5 MB) containing the stylesheet and all 21 font data URIs. It needs no
  network and no CORS, but it would be embedded in every preview document of a
  math-bearing page. The HTML path therefore uses KaTeX's **MathML** output,
  which needs no stylesheet and no fonts, and keeps the 1.5 MB route as a
  measured fallback if exact visual parity with the Markdown preview is ever
  required.
- `Export → HTML` and `Export → PDF (Print)` are native paths; every pandoc
  default carries `-f markdown+tex_math_single_backslash+…`. Passing HTML to
  pandoc with those arguments would make pandoc read raw markup as Markdown.

## Scope and non-scope

### In scope

- `.html` and `.htm` are document extensions everywhere a document is opened,
  created, saved, filtered or listed.
- The editor parses HTML with CodeMirror's HTML grammar; all existing shell
  behaviour (dirty state, autosave, reload, title, token count, word count,
  search, close guard) applies unchanged.
- A live preview rendered in a sandboxed iframe from the current buffer,
  preserving the document's own `<head>`, `<body>`, attributes, CSS, images,
  inline scripts and classic external scripts.
- Local relative assets resolve against the document's folder; local absolute
  paths (hand-written `src="C:\…"` and `file:///…`) resolve too, in the preview
  copy only.
- CDN stylesheets and scripts work when the document's own markup references
  them, subject to the document's own CSP and the machine's network.
- Math in text nodes, via the existing delimiter and currency heuristics.
- Vertical scroll sync in both directions, click-to-line in the preview, and the
  transient blink in both directions.
- Outline of `<h1>`–`<h6>` with source line numbers.
- Export to every pandoc target with the HTML reader selected, and a
  browser-printed PDF that keeps the document's own appearance and math.
- Image paste/drop inserts `<img>` markup (relative or absolute as the existing
  image settings decide), never Markdown image syntax.
- Default extension `html`, open/save filters, sidebar file listing, docs and
  tests.

### Non-scope

- WYSIWYG editing of the DOM. The preview is a preview; edits happen in the
  source.
- A general-purpose browser. Cookies, `localStorage`, `sessionStorage`,
  IndexedDB, service workers, popups, top-level navigation, downloads, custom
  protocols and WebViews inside the document are unavailable or degraded by the
  sandbox. A document that depends on them is not a reason to remove the
  sandbox.
- Local web fonts, ES-module scripts and `fetch()` of local files. They are
  blocked by the deliberately narrow asset CORS policy. CDN fonts and modules
  work because those servers allow CORS. This is a documented limitation, not a
  bug to "fix" by loosening the asset protocol.
- Automatic Mermaid rendering, syntax highlighting, `[TOC]`, GitHub alerts or
  any other MDraft-specific decoration. The document's own libraries do that
  for HTML. Math is the one exception because it is part of the editor's
  language and was explicitly requested.
- HTML project/site awareness, link rewriting on save, asset bundling, charset
  detection beyond UTF-8 (the existing document layer is UTF-8 by design),
  XHTML/XML, iframe debugging UI, and live-reload of the document's own
  resources.
- Running Markdown paragraph/format commands against HTML. They are guarded;
  implementing HTML equivalents is a later feature.
- MDraft's typography, zoom and OpenType preferences do not restyle an HTML
  document; its own CSS decides. The source pane still follows the editor
  settings, and the maths scale (a maths-specific control) is applied to the
  generated maths wrappers.

## Approach and rejected alternatives

### Chosen approach: inert assembly in the parent, execution only in an opaque iframe

The preview is a two-stage pipeline.

**Stage 1, assembly (parent, no execution).** Given the buffer:

1. Parse the source with `@lezer/html` to find every block element start tag and
   its 1-based line. Insert a `data-mdraft-line="N"` attribute immediately
   before the tag's closing `>`. This is done on a copy of the text, through
   parser positions, never by regex over the raw document; tags inside
   `<script>`, `<style>`, `<textarea>`, `<title>`, `<svg>` and `<math>` are
   skipped, as are elements inside `<head>`. The attribute travels with the
   element through browser error recovery, which is why this is more reliable
   than zipping a token list against a DOM element list.
2. Parse the annotated text with `DOMParser` (`text/html`). The resulting
   document is inert: scripts do not run and no browsing context exists.
3. Replace the document's `<base>` (resolving a relative one against the
   document's folder) with one absolute `<base>` as the first child of
   `<head>`: `http://asset.localhost/C%3A/dir/` on Windows,
   `asset://localhost/home/dir/` on Linux/macOS. This makes relative `src`,
   `href`, CSS `url()` and `@import` work without rewriting every attribute,
   while fragment-only links are intercepted by the bridge.
4. Remove `<meta http-equiv="refresh">` (a redirect would navigate the frame
   away from the preview).
5. Rewrite local absolute paths and `file://` URLs in `src`, `poster` and
   `srcset` to asset URLs in the preview copy. Relative URLs are left to the
   base.
6. Render math in text nodes outside `pre`, `code`, `kbd`, `samp`, `script`,
   `style`, `textarea`, `svg` and `math`. The exact `extractMath` scanner is
   moved, unchanged, out of `markdown.ts` into `math-scan.ts`; the HTML path
   splits the resulting `@@MATHn@@` placeholders into text and KaTeX nodes. The
   output format is `mathml`: no stylesheet, no fonts, no CSP problem, and the
   `<math>` element plus its `application/x-tex` annotation is what pandoc's
   HTML reader understands on export. The wrapper carries the existing
   `mathFontScale` preference. The 1.5 MB inline-CSS route is documented as the
   fallback if pixel parity with the Markdown preview is ever required.
7. Install the bridge `<script>` as the first child of `<head>`, before any
   document CSP meta, and a tiny blink style. The bridge is generated by the
   parent with a per-render random token.
8. Serialise the document, preserving the original doctype (or its absence, so
   quirks mode is preserved), and assign it to `iframe.srcdoc`.

**Stage 2, execution (opaque iframe).** The frame is created with

```html
<iframe sandbox="allow-scripts allow-forms allow-modals" referrerpolicy="no-referrer">
```

There is no `allow-same-origin`, no `allow-top-navigation`, no
`allow-popups` and no `allow-downloads`. The document sees an opaque origin, a
fresh storage area that throws on access, no cookies and no parent DOM. Its
scripts run, its CSS applies, its images load, its classic external scripts
load. It cannot reach `window.parent`, cannot navigate the application, cannot
open a window, and cannot call a Tauri command.

The bridge is the only channel back to the application. It posts messages to
`parent` with `{__mdraft: TOKEN, type: …}` and accepts messages only from
`parent` with the same token. The parent accepts a message only when
`event.source === iframe.contentWindow`. The token is not a secret — the
document can read its own bridge script — so every message is treated as
untrusted: finite line numbers, bounded strings, known message types. The only
actions it can request are scroll the editor, move the caret to a line, blink a
block in the preview, open an external URL through the opener plugin, or open a
local document through the existing `openPath` path, plus a menu action id that
the parent checks against the accelerator table it already installed. It cannot
name an arbitrary command, save, export, close or change settings, and a link it
opens can reveal a path to the user but never returns file contents to the
frame.

**Preview lifecycle.** A render creates the new iframe hidden on top of the old
one, waits for the bridge's `ready` message with the anchor layout, then swaps
visibility and removes the old frame. The scroll position is restored by line,
not by pixel, so a re-render after typing does not jump. A generation token
discards messages and renders that a newer edit has made stale.

**Sync.** The bridge reports the document's own anchor list (`line`, `top`),
scroll offset, scroll height and viewport height whenever layout settles
(`DOMContentLoaded`, `load`, `resize`, `ResizeObserver`, `document.fonts.ready`,
and a `MutationObserver` for documents that build their DOM in JavaScript). The
parent reuses the same interpolation idea as the Markdown path: map the editor's
scroll offset into the two surrounding anchors, and the inverse when the iframe
scrolls. Programmatic scrolls are wrapped in the same suppression windows, so
the two directions cannot feed each other. Clicks send the clicked block's line;
the parent calls `revealLine(line, true, false)` with `caretCameFromPreview` set,
exactly as a Markdown preview click does, then asks the bridge to blink that
line. Editor clicks ask the bridge to blink; editor scroll drives the iframe;
iframe scroll drives the editor. The keyboard still obeys the existing "reveal
only when the block is off screen" rule; the pointer never scrolls the other
pane.

**Keyboard.** A cross-origin iframe swallows keydown events, and Tauri 2 does not
translate menu accelerators on Windows, so Ctrl+S would stop working whenever
the preview has focus. The parent sends the parsed accelerator table to the
bridge on `ready`; the bridge matches a keydown, calls `preventDefault()` and
posts the action id. The parent runs it only if the id is in the accelerator
table it already installed. This is deliberately not a general key bridge: no
document-level shortcut is forwarded unless the native menu registered it.

**Export.** `ExportRequest.language` gains the value `"html"`. The pandoc path
rewrites the format's `-f`/`--from` pair to `-f html` (leaving the user's extra
arguments last, so they can still override it) and feeds the buffer on stdin.
The native `Export → HTML` entry explains that the document already is HTML and
does not overwrite it with a Markdown-rendered copy. `Export → PDF (Print)`
builds a print variant of the preview document with a `file:///` base, the
MathML formulas already rendered, no bridge and no line attributes, writes it
through the existing `print_document` command and lets the system browser print
it. A
document with no path has no base and therefore no relative assets, exactly as
an untitled Markdown document has no base for its images.

### Rejected alternatives

- **DOMPurify the document and draw it in `#preview`.** It solves XSS by deleting
  the format: no scripts, no stylesheets, no `<base>`; and the document's CSS
  would leak into the shell. It fails the requirement outright.
- **A same-origin iframe.** The document's scripts could read `window.parent`,
  the editor buffer, settings and `window.__TAURI_INTERNALS__`; one line of
  document JavaScript would own the application. Not acceptable.
- **A second Tauri webview or window with an empty capability set.** Capabilities
  are per window/webview, so this would deny commands, but embedding and
  positioning a native child webview over the preview pane, keeping it in sync
  with the splitter, and handling its own lifecycle is a much larger and more
  platform-specific change. The iframe gives the same origin boundary for a
  fraction of the cost.
- **A custom `mdraft-preview://` protocol with `Access-Control-Allow-Origin: *`.**
  It would make local fonts, ES modules and `fetch()` work, but it would also let
  a malicious HTML file read and exfiltrate every file under its folder. The
  feature would be more capable and less safe. Deferred; if it is ever added, it
  must be scoped to the document folder and discussed in its own ADR.
- **The system browser as the preview.** It is isolated, but it is not embedded,
  has no scroll sync, no click-to-line and no blink, and cannot be driven from
  the editor. It remains the right answer for `PDF (Print)`.
- **Styling HTML with MDraft's `.markdown-body`.** The requirement is the
  opposite: the document's own style must win. No app typography, syntax theme
  or layout rule is applied to the iframe.
- **A new Rust renderer/command.** Preview assembly needs DOM, CSS cascade and
  JavaScript; it belongs in the webview. Rust only learns the `"html"` value on
  the existing export request, which is a documentation change, not a new
  command.

## Steps

- [ ] **0. Security spike — stop if it fails.** In a throwaway dev build, add a
  sandboxed `srcdoc` iframe with `sandbox="allow-scripts"` and a document that
  (a) tries `parent.document`, (b) reports whether `window.__TAURI_INTERNALS__`
  and `window.ipc` exist, (c) calls
  `window.__TAURI_INTERNALS__.invoke("path_exists", …)` (the normal IPC path)
  and calls `window.ipc.postMessage` with a forged message that lacks the real
  invoke key (the fallback path). Expected: (a) throws `SecurityError`;
  (b) internals may exist on Windows; (c) both calls reject, the first because
  the IPC protocol rejects `Origin: null`, the second because the key is hidden
  and the source is not a local origin. Also prove that a local image, a local
  stylesheet and a classic local `<script src>` load inside the sandbox, that a
  relative `<base>` resolves, and that CDP can read the child frame for tests.
  If any command succeeds, do not continue: record the result and choose the
  fallback (scripts disabled by default, or no inline preview).
  - Write the result in the ADR and in the Traps section if it contradicts an
    assumption.
- [ ] **1. Move the math scanner, verbatim.** Create `src/math-scan.ts`; move
  `MATH_INDICATOR`, `AMOUNT_ONLY` and `extractMath` out of `markdown.ts` without
  changing a line of their logic; import `extractMath` back into `markdown.ts`.
  No new algorithm, no shared state. Gate: `npm run math`, `npm run smoke` and
  the KaTeX assertions in the export suite before anything else uses it.
- [ ] **2. Language plumbing.**
  - Extend `DocumentLanguage` with `"html"`.
  - `languageFor()`: `.html`/`.htm` → `html`; `.typ` unchanged.
  - `defaultDocumentLanguage()`: `html` when the default extension is
    `html`/`htm`; `typ` and `md` unchanged.
  - `documentFilters()`: add the HTML filter; keep the default language's filter
    first.
  - `preferences.ts`: add `html` to Default File Extension and update the help
    text.
  - `sidebar.ts`: include `html`/`htm` in the file browser, and add
    `extractHtmlHeadings()`.
  - `main.ts`: skip spelling decorations for HTML (`SKIP_NODES` is
    Markdown-shaped and would underline tag names); guard `para.*`/`format.*`
    with one explanatory toast.
- [ ] **3. Editor grammar.** Add `@codemirror/lang-html` as a direct
  dependency (already installed transitively; no new download), import its
  `html()` support, extend `setLanguage()` and the `languageCompartment` with a
  third branch. Do not touch the Markdown or Typst branches.
- [ ] **4. Build the preview document** in a new `src/html-preview.ts`:
  Lezer line injection; DOMParser; base handling; meta refresh removal;
  absolute-path rewrites; math substitution; bridge; doctype preservation.
  Keep every function pure and testable where possible. The only DOM it creates
  in the parent is the inert document and the KaTeX nodes; user HTML never goes
  through `innerHTML` on a live parent element.
- [ ] **5. Iframe lifecycle and layout.** Double-buffered iframe, `ready`
  handshake, generation token, scroll restoration by line, dispose on leaving
  HTML mode. CSS: `.app.document-html .preview-pane { padding:0; overflow:hidden }`
  and a full-size `.html-preview-frame`; no rule may change `.markdown-body` or
  `.typst-*`.
- [ ] **6. Sync, click and blink.** Add the bridge protocol and the parent-side
  mapping described above. Reuse the existing suppression windows,
  `caretCameFromPreview`, `caretByPointer`, `SYNC_MARGIN` and `BLINK_MS`; keep a
  separate `htmlLinesMapped`/anchor table so the Markdown globals are not
  overwritten. If fewer than two anchors are reported, disable positional sync
  for that document and leave the panes independent, with the same console note
  the Markdown path emits.
- [ ] **7. Outline.** Render HTML headings with levels and source lines; clicking
  scrolls the editor. Change `renderOutline`'s empty-state parameter from a
  Typst boolean to the document language, updating the single call site.
- [ ] **8. Keyboard forwarding.** Parent → bridge accelerator table; bridge →
  parent action id; parent validates against its parsed table. This is what
  keeps Ctrl+S, Ctrl+F and the view shortcuts alive when the preview has focus.
  If this proves disproportionately fragile on a platform, ship the rest and
  document the focus requirement instead of adding a second shortcut system.
- [ ] **9. Images in HTML.** Add an optional `imageSyntax` callback to
  `ImageContext` (default remains the Markdown `![alt](path)`), and pass an
  `<img src="…" alt="…">` builder when the document is HTML. Absolute local
  paths stay as written; the preview copy resolves them through the asset
  protocol. Keep the existing Markdown image-paste suite green.
- [ ] **10. Export.**
  - Rust: in `export.rs`, for `language == "html"`, remove the format's
    `-f`/`--from` token and its value and append `-f html` before the user's
    extra arguments. Pure helper with unit tests; no change to the Markdown or
    Typst arguments.
  - Frontend: guard `exportHtml` for HTML documents with an explanatory toast;
    implement the HTML print variant for `exportPdf`.
  - Update `ExportRequest.language` docs and the Preferences note that says
    what "after export" applies to.
- [ ] **11. Tests and fixtures.**
  - `samples/html-tour.html` plus a small folder (`styles.css`, `behaviour.js`,
    a PNG, maybe an SVG) exercising: inline style, linked local style, local
    image, inline script, external classic script, CDN-free, headings, enough
    blocks for scroll, math, a link and a fragment.
  - New `scripts/html-preview-test.mjs` (CDP port argument, same conventions,
    `PASS`/`FAIL` lines, non-zero exit): frame present with the exact sandbox
    attribute, local CSS applied, image `naturalWidth > 0`, inline and external
    scripts executed, no `allow-same-origin`, parent DOM inaccessible,
    `__TAURI_INTERNALS__.invoke` rejected, math fraction geometry real, editor
    scroll → frame scroll, frame scroll → editor scroll, click → caret, blink
    appears and clears, outline jumping.
  - Add the suite to `scripts/test-all.mjs` and `package.json`, and add the
    script row to AGENTS.md.
  - Extend the opt-in export suite with an HTML source converted to DOCX and
    PDF-with-Typst, asserting the output contains the prose and not literal
    `<p>` tags; skip only when the tool is absent, as the suite already does.
- [ ] **12. Docs.** README feature table, security/limitation section, AGENTS
  orientation and code map, `tauri.conf.json` descriptions, `package.json`
  description, About box, welcome document. Write
  `docs/adr/2026-10-17-html-preview-sandbox.md` before the code that depends on
  it is merged.
- [ ] **13. Full regression.** `npm run build`, `npm run test:rust`, and every
  existing UI layer, then the new suite, then `npm test`. Existing counts must
  not change; only the new suite adds checks. Run a manual CDN/Bootstrap check
  with network available and a manual launch on Linux if available.

## Files and modules

| File | Why it must change |
| --- | --- |
| `src/html-preview.ts` (new) | Assembly, bridge, iframe lifecycle, math, base and line anchors. The bulk of the feature lives here, so `main.ts` only delegates. |
| `src/math-scan.ts` (new) | Verbatim move of `extractMath` so Markdown and HTML share one scanner. |
| `src/editor.ts` | Third language branch; HTML grammar. Markdown/Typst branches untouched. |
| `src/main.ts` | Language detection, filters, render branch, sync delegation, outline, export guards, spelling/image guards. |
| `src/sidebar.ts` | HTML headings and file-list extensions. |
| `src/styles.css` | Full-bleed iframe only under `.app.document-html`; no existing selector changes. |
| `src/api.ts` | `DocumentLanguage` and export language docs. |
| `src/preferences.ts` | Default extension option and help text. |
| `src/images.ts` | Optional `imageSyntax` callback; default behaviour unchanged. |
| `src/markdown.ts` | One import replacing the moved scanner. No algorithm change. |
| `src-tauri/src/export.rs` | HTML input format for pandoc; pure helper and tests. |
| `src-tauri/tauri.conf.json`, `package.json`, `src-tauri/Cargo.toml` | Descriptions and the direct `@codemirror/lang-html` declaration. |
| `samples/html-tour.*` (new) | Deterministic offline fixture. |
| `scripts/html-preview-test.mjs` (new), `scripts/test-all.mjs`, `package.json` | New suite and its orchestration. |
| `scripts/export-test.mjs` | Opt-in HTML-source export checks. |
| `README.md`, `AGENTS.md`, `docs/adr/2026-10-17-html-preview-sandbox.md` | User and maintainer contract, security boundary, code map, test counts. |
| `docs/plans/2026-10-17-html-native-format.md` | This plan; status updated as work lands. |

`src-tauri/src/lib.rs`, the command table, `settings.rs`, `documents.rs`,
`menu.rs` and `markdown.ts`'s render pipeline are deliberately absent: the
preview needs no new Rust command and no settings migration, and Markdown/Typst
must keep using the code they use today.

## Risks and rollback

- **Tauri IPC reachable from the frame (highest).** The plan depends on the
  opaque-origin rejection described above. Step 0 proves it. If it fails, do not
  ship script execution in the embedded preview; fall back to a scripts-disabled
  preview (with a clear note) or an external-browser preview, and revise this
  plan before writing the rest. Do not "fix" it by adding `allow-same-origin`.
- **Local fonts, ES modules and local `fetch()` are blocked by CORS.** This is a
  consequence of keeping the asset protocol safe. Document it. Do not relax
  `Access-Control-Allow-Origin`; that would turn a document into a local-file
  reader.
- **Document CSP can block the injected display-math style or the document's own
  resources.** The bridge is installed before any CSP meta, so sync keeps
  working, and MathML renders without a stylesheet; a restrictive `style-src`
  can only change alignment, not the formula. Record the behaviour in the
  README.
- **Re-rendering re-executes scripts.** Forms reset, timers restart, and a
  script with side effects runs again on every typing pause. Debounce HTML
  renders more than Markdown (about 350–400 ms), skip rendering while in
  Source-only mode, and document the behaviour. Do not try to preserve live DOM
  state; that is a browser, not a preview.
- **Large HTML is slower to parse and serialise.** The whole document is
  reparsed on every render, including its MathML output. If a real document
  needs it, cap math at a sane number of formulas and show a note; measure
  before optimising.
- **Platform differences.** WebKitGTK has no CDP and may treat `srcdoc` base
  URLs, sandbox flags or postMessage timing differently. The automated suite is
  Windows-only, as every UI suite already is. Manual launch on Linux/macOS is
  required before release.
- **Pandoc's HTML reader ignores CSS and scripts.** A DOCX/LaTeX export keeps
  the words and the MathML, not the layout. That is expected and should be
  stated next to the existing export-fidelity notes.
- **A document that scrolls an inner container instead of the page cannot drive
  positional sync.** The bridge observes `window` scroll; a full-height layout
  with its own `overflow:auto` pane reports no page scroll, so the panes stay
  independent for that document. The outline and click-to-line still work. This
  is a deliberate v1 boundary; supporting arbitrary scroll containers would
  require guessing which element the document means.
- **A malformed document may serialise differently.** DOMParser repairs
  invalid markup; the preview is the browser's interpretation, not a byte
  mirror. Saving still writes the editor buffer exactly, so no repair is ever
  persisted.
- **Rollback.** Removing `.html`/`.htm` from `languageFor`, the filters and the
  default-extension option returns the app to today's behaviour. There is no
  settings migration, no new command and no data written beside user files, so a
  rollback is a source revert, not a cleanup. If a release has shipped, the
  extension mapping is the only switch needed to disable the feature.

## Tests and validation

Cheapest layers first, as AGENTS.md requires:

| Layer | What it must prove for this change |
| --- | --- |
| `npm run build` | Types, unused imports, the new lazy chunk. |
| `npm run test:rust` | The pandoc argument helper; existing 64 tests unchanged. |
| `npm run math` | The moved scanner still loads fonts and draws fractions/radicals. |
| `npm run smoke` | Markdown and Typst behaviour and counts unchanged. |
| `npm run syntax` / `typography` / `shortcuts` / `spellcheck` / `licence` | No shared CSS, menu, spell or typeface regression. |
| `npm run html` (new) | The feature and the sandbox boundary. |
| `npm run export -- --install` (opt-in) | HTML → pandoc targets; Markdown/Typst exports unchanged. |
| `npm test` | The whole orchestrated matrix, each suite on its own instance. |

The one measurement that proves the feature works is **not** "the iframe
exists". It is: in `samples/html-tour.html`, a paragraph's computed colour comes
from the fixture's linked stylesheet, its image reports a non-zero
`naturalWidth`, its inline and external scripts both set a DOM marker, the
KaTeX MathML fraction has a real numerator/denominator layout, scrolling the
editor by a known amount changes the iframe's `scrollTop`, scrolling the iframe
changes the editor offset back to the same line, and clicking a block moves the
editor caret to that block's source line while the iframe scroll position does
not move. The security check is equally concrete: from inside the frame,
`parent.document` throws, and `__TAURI_INTERNALS__.invoke("path_exists", …)`
rejects.

## Acceptance criteria

1. Opening `samples/html-tour.html` shows HTML syntax highlighting in the source
   pane and the document's own background, fonts (as far as the sandbox allows),
   CSS, images, inline script output and classic external script output in the
   preview pane. No `.markdown-body` typography is applied to it.
2. The iframe carries `sandbox="allow-scripts allow-forms allow-modals"` and
   **not** `allow-same-origin`; a document script cannot read `parent.document`
   and cannot execute a Tauri command.
3. `$E=mc^2$`, `$$\int_0^1 x\,dx$$`, `\(a^2+b^2=c^2\)` and `\[…\]` in HTML text
   render as KaTeX MathML with a real fraction/radical layout; code and `<pre>`
   contents are left alone. The appearance is the browser's MathML rendering,
   not a byte-for-byte copy of the Markdown preview's KaTeX HTML.
4. In Split view, scrolling either pane follows the other by content, not by a
   fixed ratio; clicking a preview block moves the caret to its source line and
   blinks the block without scrolling the preview; clicking source lines blinks
   the matching preview block and never moves the preview. The blink clears
   itself.
5. The outline lists the fixture's headings by level and clicking one scrolls
   the editor to the heading's line.
6. Saving an HTML document round-trips its bytes: the same line ending and BOM
   as before the edit, and no preview transformation is written to disk.
7. Default File Extension set to `html` makes a new document HTML, Save As
   suggest `.html` with the HTML filter selected, and the open dialog offer
   Markdown, Typst and HTML filters.
8. `Export → HTML` on an HTML document explains that it is already HTML instead
   of writing a Markdown-rendered copy; `Export → PDF (Print)` opens the system
   browser on a print copy that preserves the document's own styles and math;
   every pandoc format receives the source as HTML (a DOCX contains the prose,
   not literal `<p>` tags).
9. Markdown and Typst documents behave exactly as before: all existing suites
   pass with their current counts, and no existing selector, menu id, command
   shape or `settings.json` field changed.

## Open questions

- **Approve the sandbox limitations?** Local web fonts, ES-module scripts and
  local `fetch()` will not work; classic scripts, inline scripts, images, CSS
  and CDN resources will. This is the price of not giving the document the
  application's origin. Default if unanswered: accept and document.
- **Should script execution be a preference?** A checkbox "Allow scripts in HTML
  preview" (default on) would let a cautious reader turn the most dangerous part
  off without losing CSS. It adds a settings field, a preferences row and a
  re-render path. Default if unanswered: no setting in v1; ship the sandbox.
- **Should the HTML print path use the system browser, or pandoc/Typst?**
  Default if unanswered: system browser, because it is the only route that
  keeps the document's own layout.
- **Should Markdown paragraph/format commands be disabled in the native menu for
  HTML, or guarded with a toast?** Default if unanswered: toast guard, because
  it avoids changing the menu contract and the `menu_state` test payload.
- **Should Mermaid in `<pre class="mermaid">` be pre-rendered?** Default if
  unanswered: no; the document's own library handles its diagrams.
- **Is `@codemirror/lang-html` acceptable as a direct dependency even though it
  is already installed transitively?** Default if unanswered: yes; declaring
  what you import is the rule, and the lockfile does not change.
- **MathML versus the 1.5 MB KaTeX stylesheet?** The plan uses KaTeX's MathML
  output: self-contained, no fonts, no CSP problem, and exportable through
  pandoc. It looks like the browser's MathML, not like the Markdown preview's
  KaTeX HTML. The measured alternative is a lazy 1.5 MB inline stylesheet
  embedded in every math-bearing preview document. Default if unanswered:
  MathML; revisit only if readers report the difference.
- **Plan location.** The empty `docs/plans/html-editor/` directory is kept as a
  pointer because that is where the request said to look; this file is the
  canonical plan. Default if unanswered: keep the pointer and this path.
