# HTML previews run in a sandboxed guest served by a nonce scheme

**Status:** accepted
**Date:** 2026-10-17

## Context

MDraft is a Tauri 2 application whose frontend is the editor. Its webview has
`csp: null`, an asset protocol scoped to `**`, and a command set that includes
file reads and writes. The application had no HTTP server.

Opening an HTML document as a third native format cannot use the Markdown
pipeline. DOMPurify would delete the scripts and styles that make the document
HTML, and drawing it in `#preview` would apply `.markdown-body` and let the
document reach the application. The document must keep its own CSS, images,
inline and external scripts, and relative URLs, while preserving the existing
Markdown and Typst behaviour exactly.

The first design considered was a sandboxed `srcdoc` iframe with an
asset-protocol `<base>`. It is safe, but the asset protocol's
`Access-Control-Allow-Origin` is fixed to the application origin, so local ES
modules and web fonts cannot load in an opaque frame. The accepted design serves
the guest from a private scheme instead.

## Decision

The HTML document is prepared as a **preview copy** and served by the
`mdraft-preview` URI scheme, in a sandboxed iframe:

- On Windows the URL is `http://mdraft-preview.<nonce>.invalid/<basename>`; on
  Linux/macOS it is `mdraft-preview://<nonce>.invalid/<basename>`. The host ends
  in `.invalid`, not `.localhost`. wry routes the `http://mdraft-preview.` prefix,
  while Tauri's `is_local_url` strips `.localhost`; a `.localhost` host would make
  the guest a local ACL origin and the IPC bridge reachable. The nonce is routing
  state, not an origin claim.
- The iframe is `sandbox="allow-scripts allow-forms allow-modals"` with **no**
  `allow-same-origin`. The origin is opaque. A cross-origin sandbox that keeps
  `allow-same-origin` can navigate itself to the embedder's origin and reach the
  parent; it is never enabled.
- Tauri's IPC is denied twice: the opaque origin sends `Origin: null` on the
  custom-protocol IPC request, and the postMessage fallback uses a `.invalid`
  frame URL that Tauri classifies as remote. A guest `invoke` does not execute a
  command. It may not settle, because Tauri evaluates the rejection in the main
  frame; the preview suite races it and checks a command's side effect.
- The preview copy is spliced, not reserialised. `parse5` supplies source
  locations for `data-mdraft-line` attributes and one bridge `<script>`; the
  document's original doctype, comments, scripts and style text are preserved.
  The editor buffer and the saved file are never transformed.
- The scheme serves only the buffer, files below the document's canonical
  directory, and nothing else. Paths are percent-decoded, `..`, backslashes,
  NUL, absolute paths, Windows device names and symlinks escaping the root are
  rejected. Another `.html` is a 404 so the guest cannot navigate away from the
  bridge.
- The response carries a CSP. It allows the guest origin, `https:`, `data:` and
  `blob:` where a document needs them; it excludes the app's asset and IPC
  origins. `connect-src` does not include the guest origin, so a document cannot
  `fetch()` local data. CORS is sent for fonts and static asset kinds; a request
  that reports `Sec-Fetch-Dest: empty` (a `fetch()`) gets no header. WebKitGTK
  omits the metadata and also refuses a no-cors local stylesheet, image or
  classic script from this scheme, so the preview copy adds
  `crossorigin="anonymous"` to **local** assets only; CDN URLs are left untouched.
  The HTML suite covers the Chromium path; a Debian 13/WebKitGTK 2.54 launch
  with scripts on and off covers the WebKit path.
- `Preferences › HTML › Run scripts in the HTML preview` (default on) controls the
  document's scripts. Off uses `script-src 'nonce-<bridge>'`: the inline bridge
  still runs, so scroll sync, blink and shortcuts survive, while document
  scripts, inline handlers and modules are blocked.
- The guest reports layout and scroll anchors over `postMessage`. The parent
  accepts only messages whose `source` is the current iframe and whose per-render
  token matches; an opaque sandbox reports `event.origin` as `"null"`, so the
  nonce URL cannot be used as the message origin. Every message is treated as
  untrusted.
- MDraft does not inject KaTeX, MathJax, Mermaid or app typography into HTML. An
  HTML document uses the libraries and styles it links. The math and diagram
  preferences remain Markdown/Typst settings.
- The HTML path does not touch `src/markdown.ts`, `renderPreview`, the Markdown
  anchors or the Typst preview. It enters a third branch before them.

## Consequences

- HTML documents keep their own appearance and scripts, including local CSS,
  images, classic scripts, ES modules and web fonts. A document that links a CDN
  library works as it would in a browser.
- On WebKitGTK, local CSS, images and classic scripts only load when the request
  is CORS-mode. The preview copy adds `crossorigin="anonymous"` to those local
  elements; this is an extra attribute in the preview document, never in the
  saved source or the print copy. CDN elements are not marked, so an image host
  without CORS headers keeps working.
- With scripts on, a hostile document can execute referenced JavaScript and read
  or execute files in its own folder, and it may load network resources it links.
  It cannot reach the editor, the application's commands, or files outside its
  folder; it cannot read arbitrary data files through `fetch`. The README states
  this trust boundary and the preference is the off switch.
- The document loses same-origin storage, cookies, IndexedDB, service workers,
  Web Workers and local `fetch()` of data. The guest is not a secure context
  because the host is not `.localhost`; APIs such as `crypto.subtle` may be
  unavailable. Re-rendering restarts the document's scripts.
- The preview scheme is a permanent part of the Rust command and protocol
  surface. It is not an HTTP server: no socket is opened, and the handler reads
  files on Tauri's async runtime.
- A future change must keep the `.invalid` host, the opaque sandbox, the
  path-confinement tests and the scripts-off CSP. Switching to a `.localhost`
  host, adding `allow-same-origin`, or relying on a child-frame initialization
  script to delete `__TAURI_INTERNALS__` would break the boundary this decision
  establishes.
- If the `.invalid` host ever stops being routed, the fallback is the
  `srcdoc` opaque design: local ES modules and fonts are dropped, and the same
  Markdown/Typst isolation and scripts preference remain.
