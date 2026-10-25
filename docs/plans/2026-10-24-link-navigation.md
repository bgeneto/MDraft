# Follow links from the source, the preview and the HTML guest

**Status:** done
**Date:** 2026-10-24
**ADR:** none

## Context and goal

The built-in Shortcuts document already tells the reader that `Ctrl+click`
follows a link (`src/content.ts`, the paragraph after the View table), but no
code implements it. In the source pane a link is inert text: clicking moves the
caret, and the editor's right-click menu (`src/context-menu.ts`) only offers
editing, formatting and favorites. The preview does follow links
(`installPreviewClicks` reads `data-href` added by `decorateLinks`), but a
preview **image** is not clickable, and in preview-only mode there is no source
to click either. The HTML guest follows `<a>` clicks
(`src/html-bridge.js` → `handleHtmlLink`) but not images, and its link mapping
refuses a `../` target.

The goal: a reader can follow a link or open an image from any document type
(Markdown, AsciiDoc, Typst, HTML) without leaving the keyboard or guessing.
**Ctrl/Cmd+click** is the primary gesture, matching every current editor; a
right-click **Open Link / Open Image / Open File** item is the discoverable
alternative in the source pane.

## Scope and non-scope

**Scope**

- A pure resolver that finds the link or image target under a source offset for
  all four languages.
- Ctrl/Cmd+click in the source editor, and a pointer cursor while the modifier
  is held over a target.
- A contextual item in the editor's right-click menu.
- Ctrl/Cmd+click on an image in the Markdown/AsciiDoc preview.
- Ctrl/Cmd+click on an image in the HTML guest; parent-folder document links
  from the guest.
- One Rust command that opens a local file with the OS default application,
  refusing executables.
- Tests: a unit suite for the resolver, a UI suite for the gestures, the
  existing menu and HTML suites kept green, and the script tables in AGENTS.md.

**Non-scope**

- Plain click in the source following links. It would fight caret placement and
  selection, which is why every editor uses a modifier.
- A preview right-click menu. Links there already open on a plain click; the
  source is where a menu adds something. (Open question 1.)
- PDF/Typst-Pages link annotations, `#ref`/`@label` jumps inside Typst, and
  hover previews of link destinations.
- A browser-like "open in new window" or link history.

## Approach and rejected alternatives

**Approach.** Add `src/links.ts`, a dependency-free, pure module exporting one
function:

```ts
linkAt(text: string, offset: number, language: DocumentLanguage): LinkTarget | null
```

where `LinkTarget` is `{ href: string; kind: "external" | "anchor" | "file" | "image"; }`.
It reads the line around `offset` (plus the whole document only for Markdown
reference definitions) and understands:

| Language | Constructs |
| --- | --- |
| Markdown | inline image/link with balanced parentheses and an optional title, `<autolinks>`, bare `http(s)://` URLs, reference links `[text][id]` and `[id]: url` definitions, inline `<img src>`/`<a href>` |
| AsciiDoc | `image:target[alt]`, `image::target[alt]`, `link:target[text]`, `xref:target[text]`, `<<id,text>>`, bare URLs with `[text]` |
| Typst | `#link("target")`, `#image("target")`, bare URLs |
| HTML | the `href`/`src` attribute of the tag that contains the offset, bare URLs |

`kind` is `image` for image syntax and `src` attributes, `anchor` for a
leading `#` (and `<<id>>`), `external` for `http(s):`, `mailto:` and `tel:`,
and `file` otherwise.

The editor installs a `ViewPlugin` with a `mousedown` **event handler**.
CodeMirror appends its own built-in handlers after extension handlers
(`computeHandlers` in `@codemirror/view`), and returning `true` stops the
built-in selection logic — necessary because `allowMultipleSelections` is on
(`editor.ts`), so a plain Ctrl+click would otherwise add a second cursor. The
handler resolves the target at `posAtCoords`, records the pointer, and consumes
the press; a `mouseup` within 5 px opens it, so a Ctrl+drag that starts on a
link still does not launch anything by accident. No target means `false` and
the normal gesture. The same plugin tracks Control/Meta keydown/keyup and sets
`cursor: pointer` when the pointer is over a target while the modifier is held.

The context menu receives `linkAt(pos)` through `EditorMenuOptions`; when a
target exists it prepends one item whose label follows the kind — **Open
Link**, **Open Image**, **Open File**, **Go to Heading** — with
`data-href` set on the button for the suites and for debugging. The item is
only present when there is a target, so the existing "the menu lists every
editor action in order" assertion in `format-document-test.mjs` (which
right-clicks prose) is untouched.

One opener in `main.ts`, `openLinkTarget(target)`, decides:

- `external` → `openUrl` (already used by the preview), refusing
  `javascript:`, `data:` and `blob:` URLs.
- `anchor` → the same `preview.querySelector` scroll the preview click uses,
  with `CSS.escape`.
- `file`/`image` → decode with `decodeURI` (never `decodeURIComponent`, which
  would turn `%2F` into a separator), strip `file://` and a leading slash
  before a drive, drop `?query` and `#fragment`, resolve against
  `doc.directory`, then:
  - `.md`, `.markdown`, `.mkd`, `.typ`, `.adoc`, `.asciidoc`, `.html`, `.htm`
    open in a tab through the existing `openPath`; a `#fragment` scrolls the
    newly activated preview to that id;
  - anything else goes to a new Rust command `open_external(path)`.

`open_external` canonicalises, requires the path to exist, refuses executable
extensions (`exe bat cmd com scr msi ps1 vbs js jar lnk`), and calls
`tauri_plugin_opener::open_path` from Rust. A missing path returns a message the
frontend shows as a toast. A relative target in an untitled document says the
document must be saved first; a `#anchor` still works because the preview has
the headings even when the buffer was never saved.

The preview keeps its existing link behaviour and gains a Ctrl/Cmd+click on
`<img>`: `decorateLinks` stores the original address in `data-src` before it
rewrites `src` to an `asset:` URL, and `installPreviewClicks` opens that target
through the same `openLinkTarget`. The HTML guest's click handler does the same
for an image when the modifier is held, posting the existing `link` message;
the message already carries `raw`, which `onLink` starts forwarding. A local
target is resolved from `raw` (so `../other.md` works), restricted to the
editable document extensions; the resolved URL keeps serving `http(s)` and
same-folder guest documents as today.

**Rejected alternatives**

- *Plain click in the source.* It would destroy caret placement and break
  drag-selection, and it contradicts the Shortcuts sheet, which already says
  Ctrl+click.
- *Use the opener plugin's JS `openPath` and add `opener:allow-open-path`.* That
  grants the webview the ability to launch any path, and the JS side cannot
  cheaply refuse executables. A Rust command can validate first, and
  `export.rs` already uses the same plugin API from Rust.
- *Open on `mousedown`.* A Ctrl+drag that begins on a link would launch the
  target before the reader finished the gesture. The press is consumed and the
  release decides.
- *Parse with `marked`/`parse5` and map offsets back.* Both are already
  dependencies, but neither exposes the source offsets of a link destination
  reliably; the offset mapping would be more code than the resolver and would
  fail on the half-written text an editor legitimately contains.
- *Open local documents with the OS application.* The app already opens a
  linked document in a tab when the preview is clicked, and a reader editing
  Markdown expects the editor, not Word.
- *A `window.__…` probe for tests.* Not needed: the anchor gesture has a
  visible effect (the preview scrolls), and a relative document link opens a
  tab, so the suites can assert real behaviour.

### Edge cases the resolver and the opener must get right

| Case | Expected |
| --- | --- |
| Offset inside an inline code span or fenced block | no target (`\`https://x\`` is text) |
| Offset inside an AsciiDoc literal block or Typst code block | no target |
| Escaped `\[text\]\(url\)` | no target |
| `[![alt](img.png)](page.md)` | the innermost construct wins: an offset on the image opens the image, on the text opens the page |
| URL with balanced parentheses (`…/A_(b).png`) | the whole target, not `…/A_(b` |
| URL ending in `.`/`,`/`;` outside the link | trailing punctuation not part of the target |
| `<https://…>` autolink | brackets stripped |
| Markdown `[x][id]` / `[id]: url` | resolved from the definition, including one on another line |
| HTML `href="a&amp;b.html"` | `&amp;` decoded |
| `%20`, `%28` in a local target | decoded once |
| `file:///C:/x.md`, `/C:/x.md` | drive restored, opened |
| `\\server\share\x.md` | opened as a UNC path |
| `doc.md?x=1#sec` | the file opens; the fragment scrolls when it lands |
| A directory target | opened with the OS file explorer |
| A document already open in a tab | that tab is activated, not duplicated |
| An untitled document + a relative target | toast: save first |
| An untitled document + `#heading` | the preview scrolls |
| A `javascript:`, `data:` or `blob:` target | ignored |
| A `.exe`, `.bat`, `.lnk` target | refused by `open_external` with a message |
| A missing file | toast naming the path; nothing is launched |
| A local image inside the preview | `Ctrl+click` opens the file, not the Markdown source |

## Steps

- [ ] **1. `src/links.ts`.** `LinkTarget`, `linkAt`, the per-language scanners,
  URL decoding and the executable/absolute helpers, all pure.
- [ ] **2. `src/editor.ts`.** `EditorOptions.linkAt` + `linkClick`; the
  `ViewPlugin` with `mousedown`/`mouseup`, keydown/keyup and the pointer
  cursor; the handlers must not run during IME composition and must leave the
  caret alone when no target is found.
- [ ] **3. `src/context-menu.ts`.** `linkAt(pos)` and `openLink(target)` on the
  options; one conditional item at the top of the list, labelled by kind, with
  `data-href`; the menu's keyboard navigation and focus stay as they are.
- [ ] **4. `src/main.ts`.** `openLinkTarget`, the composition with
  `openPath`, `openUrl`, the anchor scroll, the fragment-after-activation
  jump, the untitled-document message and the toast on failure; wire
  `linkAt`/`linkClick` into `createEditor` and `installEditorContextMenu`.
- [ ] **5. `src/markdown.ts` + `src/main.ts` preview.** Keep `data-src` in
  `decorateLinks`; Ctrl/Cmd+click an image in the preview opens it.
- [ ] **6. `src/html-bridge.js`, `src/html-preview.ts`, `src/main.ts`.** The
  guest posts a `link` for a Ctrl/Cmd+clicked image; `onLink` forwards `raw`;
  a local `raw` is resolved against the document folder, so `../other.md`
  opens, while the editable-extension list still bounds what a guest can ask
  the host to open.
- [ ] **7. `src-tauri/src/documents.rs` (or `open.rs`).** `open_external`
  command: canonicalise, existence check, executable refusal, plugin call;
  register it in `lib.rs`; unit tests for the refusal and a missing path.
- [ ] **8. `src/api.ts`.** The wrapper for `open_external`.
- [ ] **9. Tests and docs.** New `scripts/link-target-unit.mjs` (no app) and
  `scripts/link-navigation-test.mjs` (app); register both in
  `scripts/test-all.mjs`; add them to AGENTS.md's script and testing tables;
  update `docs/guide.md` and keep `src/content.ts`'s claim true.

## Files and modules

| File | Why |
| --- | --- |
| `src/links.ts` | New: the pure resolver |
| `src/editor.ts` | Mod+click, pointer cursor, option seam |
| `src/context-menu.ts` | The conditional open item |
| `src/main.ts` | Opener, wiring, preview and guest gestures |
| `src/markdown.ts` | `data-src` for preview images |
| `src/html-bridge.js` | Guest image gesture |
| `src/html-preview.ts` | `onLink` forwarding the raw target |
| `src/api.ts` | `openExternal` wrapper |
| `src-tauri/src/documents.rs` (or a new `open.rs`) + `lib.rs` | The OS-open command and its registration |
| `scripts/link-target-unit.mjs`, `scripts/link-navigation-test.mjs` | The two new suites |
| `scripts/test-all.mjs`, `AGENTS.md`, `docs/guide.md` | Registration, counts, reader docs |

## Risks and rollback

- **Ctrl+click is already a multi-cursor gesture.** The event handler must
  return `true` before CodeMirror's built-in handler. A suite asserts that
  Ctrl+click on prose still adds a range and on a link does not. A Ctrl+drag
  that starts on a link gives up the multi-cursor for that press; the release
  threshold keeps it from opening anything.
- **Opening an executable.** The Rust command refuses by extension and never
  accepts a URL; the frontend also refuses `javascript:`/`data:`/`blob:`.
- **A guest document asking the host to open a parent-folder file.** Only the
  user's click reaches the host, and only the editable extensions open in a
  tab; anything else goes through the same validated OS opener.
- **A custom keyboard layout that uses Ctrl for selection.** Ctrl+click follows
  the link only when the pointer is over a target; elsewhere nothing changes.
- **Packaged capability surface.** No new webview permission is added; the
  command runs through the existing plugin from Rust, so
  `capabilities/default.json` does not change. `test-close.ps1` is still run
  because the command table changes (AGENTS.md asks for it after capability
  work).
- Rollback: the resolver and the seams are additive. Reverting the commit
  removes the menu item and the gesture; no settings and no schema change.

## Tests and validation

- `node scripts/link-target-unit.mjs` (new): every construct in the tables
  above, including the edge-case rows, offsets at the first and last character,
  and a miss beside the link returning `null`.
- `node scripts/link-navigation-test.mjs` (new), with
  `samples/feature-tour.md`:
  - Ctrl+click `../README.md` opens a tab named `README.md` and the source is
    unchanged (a caret is not moved, no text inserted);
  - Ctrl+click `#math` scrolls the preview to the Math heading;
  - Ctrl+click plain prose adds a multi-cursor range (the behaviour survives);
  - Ctrl+drag from a link past 5 px opens nothing;
  - right-click a link shows exactly one **Open Link** item, enabled, with the
    resolved `data-href`, and right-click prose shows the old exact label list;
  - right-click a missing relative path: the item is **Open File**, and
    clicking it reports "not found" without launching anything;
  - the same menu over `samples/typst-tour.typ`, `samples/asciidoc-tour.adoc`
    and `samples/html-tour/index.html` finds the link/image target of each
    fixture;
  - a preview image with Ctrl+click opens the local image path (asserted on a
    missing file, to keep the runner from launching a viewer).
- `npm run format:document` — the menu label sequence on prose is unchanged.
- `npm run html` — the guest's existing link checks stay green, the image
  gesture posts the resolved address, and a parent-folder document link opens.
- `npm run test:rust` — the executable refusal, a missing path, and no
  regression in the documents tests.
- The UI layers need the machine's own MDraft closed: WebView2 allows one
  browser process per user-data folder, and an installed copy shares it. If it
  must stay open, use the documented throwaway build with its own `identifier`.
- `npm run build`, `npm run lint`, `npm run format:check`, `npm run knip`.

## Acceptance criteria

- In a Markdown, AsciiDoc, Typst or HTML document, Ctrl/Cmd+click on a link
  opens the URL, scrolls to the anchor, opens a linked document in a tab, or
  opens a local file with its default application.
- In the source pane, right-clicking a link or image shows one working
  **Open …** item; right-clicking elsewhere shows the previous menu unchanged.
- A source click without the modifier behaves exactly as today, and a
  Ctrl+drag does not launch anything.
- The Shortcuts document's `Ctrl+click` claim is true.
- No new capability is added, and an executable or a `javascript:` target is
  never launched.
- A target inside code, an escaped link or plain prose is never treated as a
  link.

## Deviations recorded during implementation

- **The menu item is conditional.** It appears only when `linkAt` finds a target,
  so the existing "the menu lists every editor action in order" assertion (which
  right-clicks prose) keeps the exact label sequence.
- **The gesture opens on `mouseup`.** Consuming `mousedown` is what stops
  CodeMirror's Ctrl+click multi-cursor, but opening there would launch a link at
  the start of a Ctrl+drag. A 5 px movement threshold decides.
- **`open_external` lives in `documents.rs`**, not a new module.
- **Parent-folder guest links use the clipboard bridge's `raw` value.** The
  resolved URL has already collapsed `../` into the guest root, so `raw` is the
  only faithful path; the host resolves it and opens an editable document in a
  tab or hands anything else to the validated OS opener.
- **The resolver also treats AsciiDoc `<<id>>`, HTML `<script>`/`<style>` and
  fenced code as boundaries**, which were not all spelled out in the plan.
- Validation: `links:unit` 39/39; `links` 18/18; `format-document` 139/139;
  `html` 60/60; `smoke` 107/107; `paste` 87/87; `typst:preview` 52/52; Rust
  112 passed / 2 ignored; `lint`, `knip` and `clippy -D warnings` clean.
  Visual: Ctrl+click opened `other.md` in a tab, scrolled the preview to
  `#target`, opened the JPEG in Photos and opened `https://tauri.app` in Edge.

## Open questions

1. Do we also want a right-click **Open** in the preview pane (preview-only
   mode has no source)? Default: not in this change. The preview already
   follows a link on a plain click and an image on Ctrl+click; a preview menu
   would need the editor menu generalised.
2. Should Ctrl+click on a **local image** open a viewer inside MDraft instead
   of the OS application? Default: the OS application, because the app has no
   image view and adding one is a feature of its own.
