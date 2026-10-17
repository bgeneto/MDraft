# HTML as a third native format, in a sandboxed guest document

**Status:** done
**Date:** 2026-10-17
**ADR:** `../adr/2026-10-17-html-preview-guest.md` (accepted)

This plan merges the two earlier drafts:

- `docs/plans/html-editor/README.md` — the user's "HTML preview guest" plan;
- `docs/plans/2026-10-17-html-native-format.md` — the first review, written
  when the directory above was empty.

The first draft did not see the user's plan. This one keeps what each side got
right, corrects the points where the two disagreed, and records the decision.
The main differences are summarised in [What was conflicting](#what-was-conflicting)
before the steps, so a reviewer can challenge a decision without reading the
whole design first.

## Context and goal

MDraft edits Markdown and Typst, and renders both with the application's own
typography. HTML is currently only an export target. The goal is to open, edit,
save and preview `.html`/`.htm` as a third native document format, while
leaving `.md` and `.typ` byte-for-byte and behaviour-for-behaviour unchanged.

The requirement that decides the architecture is that the document's own style
must win: its `<style>`, linked CSS, CDN frameworks, images, inline and external
scripts, `<base>`, fonts and media. The app must not wrap it in
`.markdown-body` or apply its editor theme. That means the preview is a guest
document, not a third branch of the Markdown renderer.

The hard part is not the editor. It is that an HTML file is executable, untrusted
content running inside a Tauri webview that has an IPC bridge, a filesystem
command set and an asset protocol scoped to `**`. The feature is worth doing only
with a boundary that holds even when the document is hostile. The boundary is
the subject of most of this plan.

## What was conflicting

| Topic | User's plan | First review | Decision and reason |
| --- | --- | --- | --- |
| Preview transport | Rust custom protocol; serves the buffer and local assets; iframe URL has a nonce origin | `srcdoc` + asset-protocol `<base>`; no Rust protocol | **Custom protocol, with a sandboxed opaque origin.** It keeps the original markup intact apart from the deliberate line-anchor and bridge insertions, and it can serve local modules/fonts. The `srcdoc` design survives as the fallback if the protocol spike fails. |
| `allow-same-origin` | "Never" | Absent | **Absent.** The user is right. A sandboxed iframe that keeps its own origin with `allow-scripts` can navigate itself to the embedder's origin and then reach the parent; the classic warning applies even when the iframe starts cross-origin. The guest stays opaque. |
| Bridge origin validation | Compare `event.origin` with the nonce origin | Not specified | **`event.source === iframe.contentWindow` plus a per-render token.** An opaque sandbox reports `event.origin` as `"null"`, so the nonce URL cannot be used as the message origin. This is a correction to the user's plan. |
| Local modules and fonts | Work because the iframe has a nonce origin | Blocked by asset-protocol CORS | **Work through explicit CORS on the preview protocol**, not through `allow-same-origin`. The protocol sends `Access-Control-Allow-Origin: *` for font responses and for script responses whose `Sec-Fetch-Dest` is `script` (ES modules); a `fetch()` of a `.js` file is `Sec-Fetch-Dest: empty` and is refused. CSS, images and classic scripts need no CORS. |
| Local `fetch()` / JSON / storage | Same-origin; works | Blocked | **Blocked deliberately.** No CORS for data files; `localStorage` and friends throw in an opaque origin. A document that needs to fetch its own JSON is a future, explicitly-scoped feature, not a reason to hand it a same-origin file reader. |
| IPC defence | Initialization script deletes/locks `__TAURI_INTERNALS__` in child frames | Opaque `srcdoc` origin makes IPC reject `Origin: null` | **Neither relies on deleting internals.** Tauri defines `__TAURI_INTERNALS__` and `window.ipc` with non-configurable properties, so "delete and lock" is not a reliable boundary. The iframe URL uses a **non-local host** (`mdraft-preview.<nonce>.invalid`) so Tauri classifies the IPC origin as remote, and the sandbox origin is opaque so the fetch path sends `Origin: null`. Both paths are tested. The init-script lock is not part of the security case. |
| Line anchors | `parse5` with source locations; splice attributes into the original text | `@lezer/html` + `DOMParser` + reserialise | **`parse5` and splice.** Source locations from the browser-grade parser, no reserialisation. Scripts and `<style>` contents cannot be broken by an HTML serialiser. `parse5` is lazy-loaded only for HTML documents. |
| Math | Do not inject KaTeX/MathJax; the document's own library handles it; `enableMath` stays Markdown-only | Inject KaTeX MathML into text nodes | **Do not inject.** Auto-detecting `$…$` in arbitrary HTML would rewrite prices, fight a document's MathJax/KaTeX and force the whole document through a transformation. A document that wants math loads its own KaTeX or MathJax; scripts and CDN resources are allowed, so that works. This is a deliberate reversal of the first review and matches the user's later judgement. |
| Scripts preference | `htmlPreviewScripts`, default on | None | **Adopt.** It is a real safety valve. When off, the bridge still runs (it is trusted app code under a CSP nonce); document scripts are blocked. Sync, blink and shortcuts keep working. |
| Export → HTML on an HTML document | Write the source | Explain that it is already HTML | **Write the source.** A copy of the current buffer to another path is useful; pretending the menu item is meaningless is not. |
| Print PDF | Embed local `<link>`/`<img>`, keep `https` | `file:///` base | **`file:///` base first**, with asset embedding as a measured fallback. The system browser can read `file:` subresources; embedding CSS correctly requires rewriting its `url()`s, which is a second feature. The spike/manual check decides whether embedding is necessary. |
| Markdown formatting commands in HTML | Wrap in tags | Guard with a toast | **Wrap the unambiguous ones in tags**; guard the Markdown-only structural commands. |
| Test counts | 82 smoke checks | 85 smoke / 64 Rust | **Current repository counts:** 90 smoke checks and 65 Rust tests (one download test is ignored). The user's count and the first review's count were both stale. |
| Security trade-off | Directory-confined local file server | No local file reads at all | **Directory-confined, opaque origin, CORS-limited.** The document cannot read arbitrary data files; it can execute referenced JavaScript, render local CSS/images and load local fonts. This is the price of local modules/fonts and is documented loudly. |

## What is true today

Facts that shaped the design:

- `languageFor()` in `src/main.ts` classifies only `.typ` as Typst. Everything
  else falls through to Markdown, including `.html` opened through *All files*.
- `src/editor.ts` treats any language that is not `"markdown"` as Typst
  (`setLanguage` around line 467). The HTML branch has to be explicit and must
  come before that fallback.
- The Markdown preview lives in `#preview.markdown-body`. `scripts/dom-smoke.mjs`
  reads it directly; the HTML preview must never replace it or make it reachable
  only through a frame.
- `tauri.conf.json` has `csp: null`, `withGlobalTauri: false`, and the asset
  protocol is enabled with scope `**`. `withGlobalTauri: false` removes the
  convenience `window.__TAURI__`, not `window.__TAURI_INTERNALS__`.
- wry documents that on Windows, initialization scripts are added to **subframes
  as well**, regardless of `for_main_frame_only`. On macOS/Linux they are
  main-frame-only. The security plan must not depend on the difference.
- Tauri's IPC custom protocol requires a parseable `Origin` header. An opaque
  origin sends `Origin: null`, which fails before ACL. The `postMessage` fallback
  uses the frame's URL as its source and the per-webview invoke key. A non-local
  host makes that URL remote to Tauri's `is_local_url`, so the ACL rejects it.
- Tauri's custom-protocol workaround on Windows recognises the host prefix
  `http://<protocol>.` (see `wry/src/custom_protocol_workaround.rs`). It does
  **not** recognise a subdomain before the protocol name. Therefore a nonce
  subdomain must be added after `mdraft-preview.`:
  `http://mdraft-preview.<nonce>.invalid/...`, not
  `http://<nonce>.mdraft-preview.localhost/...`.
- Tauri treats `http://mdraft-preview.localhost/...` as **local** for ACL
  purposes because the domain ends in `.localhost`. That is why the production
  host is `.invalid`, not `.localhost`. This is a security requirement, not
  cosmetics.
- `@codemirror/lang-html` is already installed transitively through
  `@codemirror/language-data`; declaring it directly is not a download.
  `parse5` is not installed; it is a new npm dependency, lazy-loaded.
- `ExtractMath` in `src/markdown.ts`, `KATEX_STYLESHEET_URL`, `enableMath` and
  `enableMermaid` are Markdown/Typst concerns. None of them is used by the HTML
  guest.
- The existing test contract, as of the current `AGENTS.md`: `npm run smoke`
  reports 90 checks, `npm run test:rust` reports 65 tests (64 run, one ignored
  download). The other layers are math 10, syntax 7, export 34, typography 26,
  shortcuts 32, licence 4, close 4.

## Scope and non-scope

### In scope

- `.html` and `.htm` open, edit, save, reload, autosave, recent, title, token and
  word counts, close guard and drag-and-drop through the existing shell.
- HTML syntax highlighting in CodeMirror, loaded only when an HTML document is
  opened.
- A live preview in a sandboxed iframe served by a nonce-scoped custom protocol.
  The document's own `<style>`, linked CSS, CDN frameworks, images, media, inline
  scripts, classic external scripts, ES modules, local web fonts and relative
  assets work within the limits below.
- The original source is not reserialised. Only `data-mdraft-line` attributes
  and one bridge script are spliced into a preview copy; the editor buffer and
  the saved file are untouched.
- Vertical scroll sync in both directions, click-to-line, transient blink,
  outline, keyboard forwarding for modified/F-key accelerators.
- `htmlPreviewScripts` preference (default on). Off blocks document scripts but
  keeps the bridge, CSS, images and sync.
- HTML tag insertion for the unambiguous paragraph/format commands.
- Image paste/drop inserts `<img>` (with relative paths where the setting allows).
- Export: HTML → HTML writes the source; PDF (Print) prints a local copy; pandoc
  targets read HTML with `-f html`.
- Tests, fixture, ADR, README/AGENTS updates.

### Non-scope

- Auto-injected KaTeX, MathJax, Mermaid, highlight.js, `[TOC]`, GitHub alerts or
  any other app decoration in HTML. The document's own libraries do that.
- `localStorage`, cookies, IndexedDB, service workers, `fetch()` of local data
  files, Web Workers, `<object>`/`<embed>` and arbitrary local-file reading.
  These are unavailable or deliberately blocked.
- A full browser. Popups, top-level navigation, downloads, custom protocols and
  plugin content are unavailable.
- A faithful print of a browser-dependent page. The print copy is the source plus
  a `file:///` base; document scripts execute in the system browser, but local
  modules/fonts may be subject to the browser's file-origin rules.
- CharSet detection beyond UTF-8; XHTML/XML; HTML project/site awareness; link
  rewriting on save; asset bundling; iframe debugging UI; live reload of changed
  subresources.
- Changing the meaning of `enableMath`/`enableMermaid`: they remain Markdown-only
  settings. HTML documents bring their own math/diagram libraries.
- A setting for arbitrary local file access. If scripts are on, the document can
  reference files in its own folder; that is the documented boundary.
- MDraft's typography, zoom and OpenType preferences do not restyle an HTML
  document; its own CSS decides. The source pane still follows the editor
  settings, and there is no app math scale to apply because the guest does not
  inject math.
- A secure context. The guest host is deliberately not `.localhost`, so
  `crypto.subtle`, the async clipboard and similar secure-context APIs may be
  unavailable. Service workers are blocked anyway.

## Approach and rejected alternatives

### 1. A guest document served by a nonce custom protocol

Rust registers a custom URI scheme, `mdraft-preview`, in
`src-tauri/src/html_preview.rs`. No socket and no HTTP server is started; this is
a scheme handler, which is why the "there is no HTTP server" rule still holds.

The frontend prepares the preview copy of the buffer:

1. Parse the buffer with `parse5` and `sourceCodeLocationInfo: true`.
2. Walk the parse tree. For block-level start tags (`p`, `h1`–`h6`, `li`, `pre`,
   `blockquote`, `tr`, `figure`, `section`, `article`, `div`, lists, tables,
   `hr`, media, ...) outside `head`, `script`, `style`, `textarea`, `title`,
   `template`, `svg` and `math`, insert `data-mdraft-line="N"` immediately before
   the tag's optional `/` and closing `>`, never after a `/` that would turn
   `<img />` into invalid syntax. The line comes from the start tag's source
   location. Insertions are applied from the end of the string backwards, so
   offsets do not shift under the cursor.
3. Splice one `<script nonce="…">` bridge into the `<head>` (or before the first
   content if there is no head), after the doctype and after a leading
   `<meta charset>` when that comes first, and always before the first CSP meta
   or document script. The bridge is the only app code in the document; it is
   inert until it checks that it is in a child frame.
4. Do **not** reserialise. The document keeps its original doctype, comments,
   whitespace, `<script>` text, `<style>` text and markup. This is the property
   that makes `mutation`-sensitive documents behave like the browser instead of
   like a DOM serialiser.
5. Send the resulting string, the document root, the scripts flag, the bridge
   nonce and the document basename to the `set_html_preview` command. Rust
   returns the guest URL.

The iframe loads:

```
Windows:  http://mdraft-preview.<nonce>.invalid/<basename>?v=<generation>
Linux:    mdraft-preview://<nonce>.invalid/<basename>?v=<generation>
```

The nonce is per document, not per keystroke; the query generation makes each
render reload the frame without changing the origin. The guest is sandboxed:

```html
<iframe sandbox="allow-scripts allow-forms allow-modals"
        referrerpolicy="no-referrer"></iframe>
```

There is no `allow-same-origin`, no top navigation, no popups and no downloads.
The frame therefore has an opaque origin. On Windows the host deliberately does
not end in `.localhost`, so Tauri's ACL classifies the iframe as remote even if
the init scripts are present. On Linux/macOS the init scripts are main-frame-only
and the opaque sandbox is the boundary; that is verified manually, because the
CDP harness is Windows-only.

The protocol serves only:

- the document buffer at `/<basename>` (or `/index.html` when untitled), with
  `Content-Type: text/html; charset=utf-8` and the CSP header;
- files under the document's directory, resolved from the URL path after
  percent-decoding, with `..`, backslashes, NUL, absolute paths and symlinks
  escaping the root rejected;
- `.html`/`.htm` other than the document itself return 404, so the frame cannot
  navigate into another local page and lose the bridge;
- `/__mdraft/` is reserved and always 404.

Every response is `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`.
Because an opaque iframe needs CORS for `@font-face` and ES modules, the protocol
adds `Access-Control-Allow-Origin: *` to **font** responses and to **script**
responses whose `Sec-Fetch-Dest` is `script`. That covers modules without
turning the server into a reader: a `fetch()` of a `.js` file is
`Sec-Fetch-Dest: empty`, gets no CORS header, and is refused by the browser.
Data files, JSON, text, images, CSS and media carry no CORS: they render, but a
document cannot read their bytes with `fetch`. That is the boundary that keeps
the local file server from becoming a local file reader. `Range` requests are
not implemented; media seeking may be limited. If a platform does not send
`Sec-Fetch-Dest`, the fallback is to allow CORS on `.js`/`.mjs` by extension so
modules still work, and the README records that on that platform a script can
also be fetched as text; Windows WebView2 sends the header.

### 2. CSP for the guest

The protocol sets a response CSP per document, built in Rust from the origin,
the scripts flag and the bridge nonce. It blocks the app's own asset and IPC
origins, which are otherwise reachable from the webview.

With scripts on:

```
default-src 'none';
script-src <guest-origin> https: data: blob: 'unsafe-inline' 'unsafe-eval';
style-src <guest-origin> https: data: blob: 'unsafe-inline';
img-src <guest-origin> https: data: blob:;
font-src <guest-origin> https: data:;
media-src <guest-origin> https: data: blob:;
connect-src https: data: blob:;
frame-src <guest-origin> https:;
object-src 'none'; worker-src 'none';
base-uri <guest-origin> https:;
form-action <guest-origin> https:
```

With scripts off:

```
script-src 'nonce-<bridge-nonce>';
```

and the other directives unchanged. The bridge is inline and carries that
nonce; document scripts, inline handlers and external scripts are blocked, while
scroll sync, blink and the keyboard bridge keep working. Note the CSP subtlety:
when a nonce is present, `'unsafe-inline'` is ignored, so the two modes are
built as two separate directives. With scripts on there is no bridge nonce in
`script-src`; otherwise the document's own inline scripts would be blocked.

`<guest-origin>` is `http://mdraft-preview.<nonce>.invalid` on Windows and
`mdraft-preview://<nonce>.invalid` on Linux/macOS. On any platform the CSP names
that origin explicitly rather than `'self'`: the iframe is sandboxed, so `'self'`
is an opaque origin and need not match the protocol URL. On Windows the source is
the exact `http://…` origin; on Linux/macOS the scheme source `mdraft-preview:`
is used, because a host-source expression for a non-special scheme is not
portable. The explicit source also keeps `http://asset.localhost` and
`http://ipc.localhost` out of every directive.

The document's own CSP meta tags still apply after the bridge; they can make the
document stricter, never looser. The bridge is before them, which is why it
survives a document that forbids inline scripts.

### 3. Security case, honestly stated

The parent accepts a message only when `event.source === iframe.contentWindow`.
The iframe's origin is opaque, so `event.origin` is `"null"`; the bridge includes
a per-render token and the parent checks it. The token is not a secret (the
document can read its own bridge), so every field is treated as untrusted:
finite line numbers, bounded strings, known message types.

The guest can request only:

- scroll the editor to a line;
- move the caret to a line;
- blink a block in the preview;
- open an `http(s)`/`mailto:` URL through the existing opener;
- open a local `.html`, `.md` or `.typ` document through the existing
  `openPath`, which is a user-visible navigation and never returns file contents
  to the frame;
- run a menu action id that the parent re-checks against the accelerator table it
  already installed.

It cannot name an arbitrary Tauri command, save, export, change settings, close
the window or reach the parent DOM. Tauri IPC is denied twice: the opaque origin
sends `Origin: null`, and if a document finds the postMessage fallback, the
frame's `.invalid` host makes it a remote ACL origin. The security suite proves
both, and also proves the parent can still call a command after the guest loads.

What this design **does** allow is the thing that makes local HTML useful: a
document can reference and execute files in its own folder. With scripts on, a
hostile document can execute referenced JavaScript and load local fonts/images,
and can make network requests. It cannot read arbitrary data files through
`fetch`, and it cannot reach the application, the editor buffer or files outside
the document folder. This is the same trust model as opening an HTML file in a
browser with local script access, and it is why the README needs an explicit
warning and why `htmlPreviewScripts` exists. It is not a sandbox escape: the
application, the editor buffer and files outside the document folder remain out
of reach.

### 4. Rejected alternatives

- **`srcdoc` + asset-protocol base.** Safe and simple, and kept as the fallback,
  but it cannot serve local ES modules or web fonts (asset CORS is fixed to the
  app origin), and it needs an asset-protocol `<base>` rather than a real
  same-directory URL. It is the fallback if the custom-protocol spike fails.
- **`allow-same-origin` on the guest, with the user's nonce origin.** This was
  the first correction considered; it is rejected. A sandboxed frame with
  `allow-scripts` and `allow-same-origin` can navigate itself to the app origin
  and then reach the parent. The opaque origin plus CORS is the safe version.
- **An init script that deletes `__TAURI_INTERNALS__` in subframes.** The
  properties are defined non-configurably; deleting or redefining them is not a
  reliable, future-proof boundary. It is not used as the security argument.
- **A same-origin iframe.** The document would own the editor.
- **DOMPurify in `#preview`.** It deletes the format: scripts, links, base and
  CSS. It also leaks the document's CSS into the shell.
- **A real local HTTP server.** It would make the origin unambiguously remote,
  but the application has no server today and adding one means ports, lifecycle,
  firewall prompts and another attack surface. The nonce scheme handler is the
  smaller change.
- **Auto-math in HTML.** Rejected for the reasons in
  [What was conflicting](#what-was-conflicting).
- **A separate native webview with no capabilities.** It would be secure, but
  embedding, positioning, resizing and syncing a native child webview is a much
  larger platform-specific change than an iframe.

## Steps

- [x] **0. Security and protocol spike — stop if it fails.** Build a throwaway
  dev branch that registers `mdraft-preview` and loads a sandboxed iframe from
  `http://mdraft-preview.<nonce>.invalid/<name>` (Windows) and
  `mdraft-preview://<nonce>.invalid/<name>` (Linux). Prove, in order:
  1. WebView2 routes the `.invalid` host to the scheme handler; the protocol
     response arrives.
  2. The iframe's origin is opaque, `parent.document` throws, and it cannot
     remove its own sandbox.
  3. From the frame, `__TAURI_INTERNALS__.invoke("path_exists", …)` does not
     execute a command. It may never settle, because Tauri evaluates the ACL
     rejection in the main frame; race it with a timeout and prove the
     side-effect is absent (`write_document` to a temp path). If `window.ipc`
     exists, a forged `postMessage` is also refused. Confirm that the
     `.localhost` variant **would** be classified local (do not ship it).
  4. The parent can still invoke a command after the frame loads.
  5. Local CSS, an image, a classic `<script src>`, an ES module and a web font
     work. A `fetch()` of a `.json`/`.txt` file fails, and a `fetch()` of a `.js`
     file also fails when `Sec-Fetch-Dest` gates CORS; note the platform
     fallback if the header is absent.
  6. `../`, `%2e%2e`, a symlink outside the root and a nonce mismatch are
     rejected.
  7. The CSP nonce bridge still runs when document scripts are disabled.
  If any of 1–4 fails, fall back to the `srcdoc` opaque design in
  [Fallback](#fallback-if-the-protocol-spike-fails) and remove local modules and
  fonts from the acceptance criteria. Record the result in the ADR and in the
  Traps section if it contradicts an assumption.
- [x] **1. Language plumbing.** `DocumentLanguage` gains `"html"`;
  `languageFor` maps `.html`/`.htm` before the Markdown default; the explicit
  HTML branch in `editor.setLanguage` precedes the `else` that means Typst;
  `defaultDocumentLanguage` maps `html`; `documentFilters` adds HTML with the
  default language first; `sidebar` lists `html`/`htm`; the default-extension
  preference gains `html`; spelling is disabled for HTML (the Markdown
  `SKIP_NODES` set would underline tags).
- [x] **2. Editor grammar.** Declare `@codemirror/lang-html` directly (already in
  the lockfile) and load it lazily, following the `typst-language.ts` pattern.
  The Markdown and Typst branches stay byte-for-byte where they are.
- [x] **3. Rust preview protocol.** New `src-tauri/src/html_preview.rs`:
  - `HtmlPreviewState` in `AppState`: nonce, root, source, scripts flag, bridge
    nonce, basename.
  - `set_html_preview(request) -> HtmlPreviewUrl` and `clear_html_preview(nonce)`
    commands; both are called only from the main webview.
  - handler for the `mdraft-preview` scheme: nonce check, document buffer, path
    resolver, MIME table, CSP, CORS for fonts/scripts (script CORS only when
    `Sec-Fetch-Dest: script`), 404/403, HEAD. File reads happen on Tauri's async
    runtime, not the UI thread, with a size cap (e.g. 32 MB) and no directory
    listing.
  - canonicalise the root and every candidate; reject `..`, backslash, NUL,
    absolute paths, device names, symlinks escaping the root; never list a
    directory; never serve another HTML document.
  - pure helpers (`resolve_preview_path`, `csp_for`, `mime_for`,
    `parse_nonce_host`) with unit tests.
  - register the scheme and commands in `lib.rs`. No capability change is needed
    for a local main-window command; the guest cannot call it.
- [x] **4. Frontend assembly.** New `src/html-preview.ts` and
  `src/html-bridge.js` (`?raw`):
  - lazy `parse5`; line-attribute splice; heading extraction; bridge splice
    after the doctype/charset meta and before the first CSP meta/script; fail
    safe to the original source when parse5 cannot locate a head or tag.
  - `htmlPreviewNonce()` per document, `generation` per render, and the URL
    returned by the Rust command.
  - iframe construction with the exact sandbox attribute; double-buffered swap;
    `ready`/token handshake; scroll restoration by line; dispose on leaving the
    format.
- [x] **5. Preview rendering branch.** In `doRender`, a third branch **before**
  the Typst and Markdown branches. `#preview` and `.markdown-body` remain the
  Markdown/Typst targets; the iframe is a sibling. The panel gets
  `.app.document-html`, loses padding/scroll and lets the document scroll. On
  returning to `.md`/`.typ`, the class and iframe are removed and the existing
  path renders exactly as today. HTML renders are debounced at ~300 ms and
  skipped in Source-only mode; switching back to Split/Preview forces one.
- [x] **6. Sync, blink and keyboard.** Bridge layout messages with
  `{line, top}`, scroll metrics and anchors; parent interpolation in a separate
  table, not `rebuildAnchors`. Click in preview → `caretCameFromPreview` +
  `revealLine` + blink; click in source → blink only; scrolling follows in both
  directions with the existing suppression windows; `caretByPointer` still means
  the pointer never scrolls the other pane. Blink is an inline `outline` set and
  cleared by the bridge, never a document stylesheet class. Link clicks are
  resolved by the bridge against `document.baseURI`; the parent maps a
  guest-origin URL back to the document folder and refuses a path that escapes
  it. A `<base href="sub/">` therefore opens `sub/other.html` in the editor
  rather than `other.html` beside the document. Keyboard forwarding
  is limited to accelerators with a modifier or an F-key; plain typing is never
  forwarded, so a password field inside the document stays inside the document.
  The parent re-checks the action id against its accelerator table.
- [x] **7. Outline.** `extractHtmlHeadings` in `sidebar.ts` using the same parse5
  tree; `<h1>`–`<h6>` text and source line. `renderOutline` takes the document
  language instead of a Typst boolean, so the empty-state sentence is correct for
  all three formats. Clicking a heading scrolls the source.
- [x] **8. Scripts preference.** Add `htmlPreviewScripts` to
  `src-tauri/src/settings.rs` (default true, `#[serde(default = "default_true")]`),
  `src/api.ts`, a Preferences row with a note explaining the sandbox and the
  local-folder/network behaviour, and `applySettingsPatch` +
  `affectsRendering`. The HTML suite proves both modes.
- [x] **9. Formatting and images.**
  - Inline HTML tags: strong, em, s, code, a, img.
  - Block snippets: h1–h6, blockquote, pre, ul/ol, hr, table. These are
    source-level insertions; they do not parse or normalise the document.
  - Markdown-only commands (math, task state, alerts, TOC, YAML) show one
    explanatory note instead of inserting Markdown into HTML.
  - `ImageContext` gains an optional `imageSyntax` callback; the default remains
    `![alt](path)`. For HTML, emit `<img src="…" alt="…">` and force relative
    paths where the image rule allows it. Absolute paths that the protocol
    cannot reach are documented, not silently broken.
- [x] **10. Export.**
  - HTML → HTML: write the current buffer to the chosen path with the current
    line ending/BOM, then run the existing after-export actions. Do not pass an
    HTML buffer through `renderPreview`.
  - PDF (Print): write a print copy of the **original source** with a
    `file:///` base pointing at the document folder, a `window.print()` on load,
    no bridge and no line attributes. Keep `https:` URLs. If manual testing shows
    the browser refuses local subresources, embed local `<link>`/`<img>` up to a
    size limit as the fallback; that is a follow-up, not a prerequisite.
  - Pandoc: `ExportRequest.language == "html"`; remove the format's
    `-f`/`--from` pair and append `-f html` before the user's extra arguments.
    Unit-test the pure helper. Scripts and most CSS do not survive, as the README
    will say.
- [x] **11. Tests and fixture.**
  - `samples/html-tour/index.html` plus `style.css`, `app.js`, `module.js`,
    `data.json`, `image.png`, and a deliberate `../outside.txt` link. The
    fixture includes a script string containing `<div>` and a style containing
    `>` so a reserialiser regression is visible; headings; enough blocks for
    scroll; an inline style; a local font if one can be committed under the OFL
    (otherwise use a system font and test local modules separately); no CDN, so
    the suite is offline.
  - New `scripts/html-preview-test.mjs` (port in `argv[2]`, `PASS`/`FAIL`,
    non-zero exit): iframe exists and is not `#preview`; exact sandbox attribute;
    `parent.document` throws; Tauri command rejected; parent command succeeds;
    local CSS colour; image `naturalWidth`; inline/classic/module scripts run;
    local font loads (if fixture); JSON/text fetch blocked; `../` blocked;
    `data-mdraft-line` anchors monotonic; editor scroll → frame scroll; frame
    scroll → editor; click → caret; blink appears and clears; outline jumps;
    scripts off → document script blocked/bridge still syncs; guest IPC does not
    execute a command (timeout + absent side effect); returning to
    `samples/feature-tour.md` removes the iframe and restores `#preview`.
  - Rust unit tests for the protocol helpers and path confinement, including
    encoded traversal, symlink escape, nonce mismatch, MIME and both CSP modes.
  - Extend `scripts/export-test.mjs` or add a small opt-in HTML export check for
    `-f html` (DOCX contains the prose, not literal `<p>`); the pure argument
    helper is already unit-tested, so this is integration confidence.
  - Add the suite to `scripts/test-all.mjs` and `package.json`; add the script
    row to `AGENTS.md`; update the test-count table after the suite lands (the
    existing 90/65/10/7/34/26/32/4/4 counts must not move).
- [x] **12. Docs and ADR.** `docs/adr/2026-10-17-html-preview-guest.md`:
  opaque sandbox, nonce scheme, non-local host, CORS only for fonts/JS, local
  file access boundary, scripts preference. README: feature row, the network
  exception sentence, the local-folder warning, and the "no auto-math" note.
  AGENTS: orientation, code map, new script, test counts, any trap discovered.
  About box and `tauri.conf.json`/`package.json` descriptions.
- [x] **13. Regression that this change can affect.** `npm run build`, `npm run
  test:rust`, and the existing UI layers that touch preferences, preview,
  shortcuts, typography, math and syntax, plus the new suite. Existing counts:
  smoke 90, math 10, syntax 7, shortcuts 32, typography 26.
  - [x] Full `npm test` on a normal-identifier instance: **10 layers, 10 passed**.
  - [x] Manual HTML print exercise: the print copy has the `file:///` base, the
    document CSS and a `window.print()`, and no bridge.
  - [x] Manual CDN/Bootstrap check with network: Bootstrap's stylesheet, JS
    global and body font all reached the guest.
  - [x] Manual Linux launch: built on Debian 13 under WSL2, launched with
    WebKitGTK 2.54/WSLg, and screenshotted with scripts on and off. The first
    launch exposed a WebKitGTK CORS requirement for local CSS/images/classic
    scripts; fixed and re-verified.

## Implementation notes and deviations

The feature is implemented. The security/protocol spike passed on WebView2: the
`.invalid` host routes to the scheme handler, the opaque frame cannot read
`parent.document`, and a guest command does not execute. The `srcdoc` fallback was
not needed.

Measured on this checkout:

- `npm run build` — passes.
- `cargo test` — Windows **75 passed, 1 ignored**; Debian/WebKitGTK **74 passed,
  1 ignored**. The one-test difference is a Windows-only path test; the Linux run
  found that the filename test itself assumed Windows separators, fixed with a
  `cfg` branch. (The ignored test downloads pandoc.)
- `npm test` — **10 layers, 10 passed**: rust 75 passed/1 ignored, smoke 90,
  math 10, syntax 7, html 40, spellcheck 3, shortcuts 32, typography 26, licence
  4, close 4. It built and staged the binary outside the workspace and gave every
  UI suite a fresh instance and port.
- `npm run html` — **40/40**, including the scripts-off CSP and the return to
  Markdown.
- Manual HTML → DOCX through the real `run_export` command: the output is a
  valid DOCX and `word/document.xml` contains the fixture's text, including the
  literal `$5`/`$10`. Pandoc emitted one expected warning that it could not fetch
  the local `image.png`; the text conversion is correct.
- Manual HTML print: `%TEMP%\mdraft-print\index.html` contains
  `<base href="file:///.../samples/html-tour/">`, the document's own CSS link and
  inline style, `window.print()`, and **no** bridge token or line attributes. The
  system browser opened it to the print dialog.
- Manual Bootstrap CDN check with network: the guest's
  `document.styleSheets` contains `cdn.jsdelivr.net/.../bootstrap.min.css`,
  `window.bootstrap` is an object, the `.container` has Bootstrap's 12px padding
  and the body has Bootstrap's font stack. The CSP did not block it.
- The `htmlPreviewScripts` toggle is covered by the HTML suite rather than by
  `dom-smoke.mjs`; it is an HTML-specific row and the suite proves both CSP
  modes.
- The guest's `invoke` does not settle rather than rejecting, as Tauri evaluates
  the ACL rejection in the main frame. The suite proves no command executed by
  checking an absent write side effect. This is recorded in the plan's security
  section and in the Traps.
- The Linux/WebKitGTK launch found a real platform difference: a no-cors
  `<link>`, `<img>` or classic `<script src>` from `mdraft-preview://` was
  dropped before the scheme handler saw it, while a module loaded. The preview
  copy now marks **local** stylesheets, images, scripts and media
  `crossorigin="anonymous"`, and the handler sends CORS for static asset kinds
  when WebKit omits `Sec-Fetch-Dest`. The screenshot after the fix shows linked
  CSS green, the local image, all three scripts and `local fetch blocked`.
- With `htmlPreviewScripts` off, the same Linux build still loads CSS and the
  image, and every document script marker reads “did not run”; no script request
  reaches the handler. The bridge is the only inline script and still starts.
- The Linux build also rendered the Bootstrap CDN fixture: the primary heading
  and button are Bootstrap-styled, and the inline script reports
  `bootstrap JS: object`. CDN URLs were not marked `crossorigin`, so a CDN
  response without CORS is unaffected.
- `bin/linux/amd64` now contains only `MDraft_0.2.1_amd64.deb`, `mdraft`,
  `SHA256SUMS.txt` and `manifest.json`; the stale 0.1.0 artifacts from the cache
  were removed before the final build.

## Fallback if the protocol spike fails

If the `.invalid` host is not routed, or Tauri still treats it as local, the
feature falls back to the first review's design:

- iframe `srcdoc` with `sandbox="allow-scripts allow-forms allow-modals"`; no
  custom protocol, no Rust command, no local modules/fonts;
- the original source is still spliced with line attributes and the bridge, not
  reserialised; relative assets use an asset-protocol `<base>`; local fonts,
  ES modules and local `fetch()` are documented as unsupported;
- the same CSP, scripts preference, sync, outline, export and tests, minus the
  protocol tests.

This fallback is a smaller, safer feature. It is not the preferred outcome,
because it cannot honestly claim "the document's own JS and CSS all work", but it
is a complete HTML editor and preview.

## Files and modules

| File | Why it must change |
| --- | --- |
| `src/html-preview.ts` (new) | parse5 assembly, line attributes, bridge, iframe lifecycle, protocol URL, generation and scroll restore. |
| `src/html-bridge.js` (new, `?raw`) | The guest-side bridge: layout/scroll/click/link/key messages, blink, no access to the parent. |
| `src-tauri/src/html_preview.rs` (new) | Scheme handler, state, path confinement, CSP, MIME/CORS, commands and unit tests. |
| `src-tauri/src/lib.rs` | Register the scheme and the two commands. |
| `src-tauri/src/settings.rs` | `htmlPreviewScripts`, default true, old settings load. |
| `src/editor.ts` | Third language branch and lazy HTML grammar; Markdown/Typst untouched. |
| `src/main.ts` | Language plumbing, render branch, iframe delegation, sync, outline, spelling/image guards, format mapping, export branches. |
| `src/sidebar.ts` | HTML headings and file-list extensions. |
| `src/styles.css` | Full-bleed iframe only under `.app.document-html`; no existing selector changes. |
| `src/api.ts` | `DocumentLanguage`, `Settings.htmlPreviewScripts`, `set/clear_html_preview` wrappers. |
| `src/preferences.ts` | Default extension `html`; HTML preview scripts row and note. |
| `src/images.ts` | Optional `imageSyntax`; Markdown default unchanged. |
| `src/markdown.ts` | No change. This is deliberate; the HTML path does not touch it. |
| `src-tauri/src/export.rs` | `-f html` helper and tests. |
| `package.json`, `package-lock.json` | Direct `@codemirror/lang-html` and `parse5`; new npm script. |
| `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `README.md` | Descriptions, network/security copy. |
| `samples/html-tour/*` | Offline fixture. |
| `scripts/html-preview-test.mjs` | New UI/security suite. |
| `scripts/test-all.mjs`, `scripts/export-test.mjs` | Orchestration and HTML export check. |
| `AGENTS.md`, `docs/adr/2026-10-17-html-preview-guest.md` | Contract, code map, test counts, durable security decision. |
| `docs/plans/2026-10-17-html-preview-guest.md` | This plan. |

`src-tauri/src/documents.rs`, `menu.rs`, `settings`' existing fields, the menu
event names and the `accelerators`/`menu_state` payload stay unchanged. The only
new public contract is the pair of HTML preview commands and the new settings
field.

## Risks and rollback

- **The `.invalid` host trick depends on wry's workaround.** It is documented in
  wry's source but is not a stable API. Step 0 proves it on this version; the
  security suite keeps it honest. If it breaks, the fallback is `srcdoc`, which
  needs no trick.
- **Tauri classifies `.localhost` as local.** Do not switch to
  `<nonce>.mdraft-preview.localhost`, even though it is a secure context and
  would make modules easier. It would hand the guest a local ACL origin. This is
  the single most dangerous shortcut in the feature.
- **Local folder access is a real trade-off.** With scripts on, a hostile HTML
  file can execute referenced JavaScript and fonts, load local CSS/images and
  make network requests. It cannot read arbitrary data files or `fetch()` a
  `.js` as text where `Sec-Fetch-Dest` is available, but this is still a boundary
  the README must state. `htmlPreviewScripts` is the off switch.
- **`Sec-Fetch-Dest` is not universal.** WebView2 sends it; a WebKit port might
  not. If it is absent, the fallback allows CORS on `.js` by extension so modules
  keep working, which also lets a script fetch `.js` as text. That is a weaker
  boundary on that platform and belongs in the README and the manual Linux
  checklist, not in a silent divergence.
- **The file server is a new attack surface.** Canonicalisation, encoded
  traversal, symlinks, device names, UNC paths and nonce mismatch all get unit
  tests. The handler never serves a directory, another HTML document or the
  asset scope.
- **CSP can break a document.** A document with its own restrictive CSP may block
  its own resources or our styles. The bridge is before the document's CSP so
  sync survives; the document's policy is respected. `document.write`, workers,
  `object`/`embed` and local data `fetch` are unavailable.
- **`allow-scripts` is always present**, even when scripts are off, because the
  bridge needs it. The scripts-off mode is enforced by a nonce-only CSP. This is
  tested; do not "simplify" it by omitting `allow-scripts`, or sync and shortcuts
  disappear.
- **Re-rendering reloads the guest.** Script state, timers, forms and scroll
  positions inside the document reset; the bridge restores the visible line.
  Debounce, skip in Source-only mode, and document it.
- **The document can navigate itself.** It can leave the preview for `https:` or
  another URL; the bridge is then gone and sync stops. It cannot reach the
  parent. Reloading the preview restores it. A future navigation guard could
  intercept `beforeunload`; not v1.
- **Inner-scroller documents.** If the page scrolls a fixed-height container
  instead of `window`, the bridge sees no page scroll and sync stays
  independent. Outline and click-to-line still work.
- **Large documents.** parse5 plus a full buffer over IPC on each debounce is
  heavier than Markdown. Measure; if needed, cap or increase the debounce. The
  existing Markdown timing is unchanged.
- **Print fidelity.** `file:///` subresources may be restricted by the system
  browser; local modules/fonts may not print. The manual check decides whether
  the embedding fallback is needed.
- **Rollback.** Removing `.html`/`.htm` from `languageFor`, the filters and the
  default-extension option disables the feature. The protocol can stay
  registered and return 404 with no state. No settings migration, no file
  writes beside user documents, no data loss. The `htmlPreviewScripts` field is
  harmless to older versions because serde ignores an unknown field? It is a
  new known field; an older build ignores it via its own serde defaults. Remove
  it in a rollback if desired.

## Tests and validation

Cheapest layers first:

| Layer | What it must prove |
| --- | --- |
| `npm run build` | Types and the lazy `parse5`/HTML grammar chunks. |
| `npm run test:rust` | Protocol helpers, path confinement, CSP/MIME, settings default; existing 65 tests unchanged. |
| `npm run smoke` | Markdown/Typst path and all 90 existing checks unchanged. |
| `npm run math` / `syntax` / `typography` / `shortcuts` / `spellcheck` / `licence` | No shared CSS, menu, spelling or typeface regression. |
| `npm run html` (new) | The guest, the sandbox, sync, script modes, outline, return to Markdown. |
| `npm run export` (opt-in) | HTML → pandoc; Markdown/Typst exports unchanged. |
| `npm test` | The full matrix on one fresh instance per suite. |

The measurement that proves the feature is not "an iframe exists". In the
fixture: the paragraph colour comes from the fixture's linked CSS, the image
reports a non-zero `naturalWidth`, inline/classic/module scripts set their DOM
markers, the local font is active (`document.fonts`), the editor scroll moves the
frame's `scrollTop`, the frame scroll moves the editor back to the same line,
a click moves the caret to the block's source line without moving the frame, the
blink clears, and the outline jumps to the heading. The security measurement is:
from inside the frame, `parent.document` throws and
`__TAURI_INTERNALS__.invoke("path_exists", …)` does not execute a command (it may
not settle; the suite races it and checks the side effect), while the parent
still succeeds; a `../` fetch and a nonce mismatch do not return bytes.

The scripts-off mode is measured separately: the document's inline script marker
must be absent, the bridge must still report scroll, and the CSS/image must still
render.

## Acceptance criteria

1. Opening `samples/html-tour/index.html` shows HTML syntax highlighting in the
   source pane and the document's own background, linked CSS, inline style,
   image, inline script, classic external script and ES module in the preview.
   No `.markdown-body` class or app typography applies to it.
2. The iframe URL is the nonce guest URL; the sandbox is exactly
   `allow-scripts allow-forms allow-modals` and has no `allow-same-origin`.
   `parent.document` throws; a Tauri command invoked from the frame does not
   execute (and may not settle); the parent can still invoke one.
3. With scripts on, local modules and local fonts load; with scripts off, the
   document's scripts do not run and the bridge still provides sync and
   shortcuts. CSS and images work in both modes.
4. Relative CSS, images and scripts load from the document folder; `../`,
   percent-encoded traversal, a symlink outside the folder and a nonce mismatch
   are refused. `fetch()` of a `.json`/`.txt`/`.js` file is refused; an ES module
   still loads because its request is a script subresource, not a `fetch`.
   On a platform that does not send `Sec-Fetch-Dest`, the documented fallback
   applies.
5. In Split view, scrolling either pane follows the other by content; clicking a
   preview block moves the caret to its source line and blinks the block without
   scrolling the preview; clicking source lines blinks the block and never moves
   the preview; the blink clears itself; `caretByPointer` still applies.
6. The outline lists the fixture's headings by level and clicking one scrolls
   the editor to the heading's line.
7. Saving an HTML document round-trips its bytes (line ending/BOM); the preview's
   line attributes and bridge are never written to disk.
8. Default File Extension `html` makes a new document HTML, Save As suggests
   `.html` with the HTML filter first, and the open dialog offers Markdown,
   Typst and HTML.
9. `Export → HTML` on an HTML document writes the source; `Export → PDF (Print)`
   writes a print copy with the document's own CSS and prints it through the
   system browser; every pandoc format receives `-f html` (a DOCX contains the
   prose, not literal `<p>` tags). The HTML preview does not inject math; a
   document that loads its own KaTeX/MathJax renders it.
10. Markdown and Typst behave exactly as before: all existing suites pass at
    their current counts (smoke 90, math 10, syntax 7, export 34, typography 26,
    shortcuts 32, licence 4, close 4), and no existing selector, menu id,
    command shape, `settings.json` field or accelerator changed.

## Open questions

- **Approve the local-folder trade-off?** With scripts on, a document can
  execute referenced JS and fonts, load local images/CSS and make network
  requests; it cannot read arbitrary data files or fetch a `.js` as text where
  `Sec-Fetch-Dest` is available, and cannot reach the app or files outside the
  folder. Default if unanswered: accept, with the README warning and the
  scripts-off switch.
- **Approve the `.invalid` nonce host?** It depends on wry's workaround. Default
  if unanswered: yes, gated by step 0; fall back to `srcdoc` if the spike fails.
- **Approve no auto-math?** Default if unanswered: no injection; document's own
  KaTeX/MathJax only.
- **Should the print copy embed local assets?** Default if unanswered: no,
  `file:///` base first; embed only if the manual browser test shows local
  subresources are blocked.
- **How much HTML formatting?** Default if unanswered: inline tags plus the
  unambiguous block snippets; math/task/alert/TOC/YAML remain Markdown-only with
  a note.
- **Is `parse5` acceptable as a new npm dependency?** Default if unanswered:
  yes; it is lazy-loaded and is the source-location parser for the injection.
- **Does the HTML preview need a visible "Guest" badge/status?** Default if
  unanswered: no; the different rendering is the affordance, and the README
  explains the sandbox.
