# Image paste: every folder rule works, and a failed fetch is never silent

**Status:** done
**Date:** 2026-10-24
**ADR:** none

## Context and goal

### What the user sees

An image pasted into a Markdown document never appears. The source ends up
holding the remote address instead of a copied file, and the preview shows the
broken-image icon with the alt text (`## Gráfico` in the screenshot). Changing
**Preferences › Image** to *Copy image to a custom folder* or *Copy image to
./assets* changes nothing.

### What actually happened

The evidence is on this machine:

- `C:\Users\bernh\Documents\fupia.md` contains
  `![generated image 1](https://fupia.sistema.pro.br/api/v1/interpreter/files/05782d7c9d9c/XJnZGxn5U2BViaxH/rk8_comparacao.png)`.
- `%APPDATA%\io.github.bernh.mdraft\settings.json` has `imageRule: "custom"`,
  `imageCustomDir: "C:\\Users\\bernh\\Pictures"`,
  `imageApplyLocal: true`, `imageApplyOnline: true`,
  `richPasteImages: "download"`, `richPaste: true`.
- The `alt` text is `generated image 1`, not the file name, so the clipboard
  carried **rich HTML** with an `<img>`; the paste went through
  `resolveRichImage` → `api.downloadImage(..., 8000)`.
- The address answers `401 {"detail": "Not authenticated"}` to a request that
  does not carry the web application's session.

So the bytes were never fetched. `resolveImages` in `src/paste/index.ts` catches
every resolver failure with `console.warn` only, keeps the original URL, and
`applyRichPaste` shows nothing. The preview then requests the same protected
address, which also fails (MDraft's WebView has no session for that site), and
the reader gets a broken image with no explanation. **No folder rule can copy
bytes the server refuses to send**, which is why all four rules looked equally
dead.

### Further defects that make the rules look broken even when the bytes arrive

1. `download_image` falls back to the URL's extension when the bytes are not a
   recognised image (`images.rs`, `let ext = sniffed … .or_else(|| ext_from_url)`).
   A 200 response that is HTML or JSON is therefore written as `*.png` and
   reported as a successful download — the module doc claims the opposite.
2. The **Custom Folder** help promises `${filename}` expansion; `target_dir`
   never substitutes it, so `media/${filename}` creates a literal `${filename}`
   directory.
3. Images saved **outside the document folder** are unreachable to two
   previews:
   - Typst compiles with `--root <document folder>` (`typst.rs`), so
     `../Pictures/x.png` is "outside the root".
   - The HTML guest's `resolve_asset` canonicalises and refuses anything that
     does not start with the document root (`html_preview.rs`).

   Markdown and AsciiDoc reach such an image through the asset protocol, so
   *custom folder* works for two of the four languages today.
4. `richImageOptions` rewrites `keepOriginal` to `assetsFolder`, so the
   **Keep the original location** rule is ignored for rich text and the image is
   downloaded instead.
5. A clipboard bitmap, a URL or a local path pasted into an **untitled**
   document is resolved against the process working directory. In an installed
   build that is `C:\Program Files\MDraft`, which is not writable; the toast
   names an `Access is denied` on a folder the user never chose. See the next
   section for the replacement policy.
6. `Format › Image` inserts Markdown `![…](…)` in a **Typst** document, where
   the text is not an image at all.
7. Pasted `file://` addresses, Explorer's quoted `"C:\My Pictures\a.png"` and
   bare `data:` image URLs are not recognised as images, so they are pasted as
   text (`images.ts`).

### Untitled documents: a rule is applied only when a destination exists

An unsaved buffer has no folder, so `./assets` and `./${filename}.assets` have
nothing to resolve against. The policy, in one sentence: **write only when the
chosen rule names a folder that exists independently of the document;
otherwise keep the image's original location, and refuse an image that has
none.**

| Rule while untitled | Destination | Behaviour |
| --- | --- | --- |
| `assetsFolder` / `assetsDir` | none | keep the original |
| `custom` with a **relative** path (`media`) | none | keep the original |
| `custom` with an **absolute** path (`C:\Users\bernh\Pictures`) | real, writable | apply the rule |
| `keepOriginal` | none needed | keep the original |

"Keep the original" means, by source:

- **A URL** — the URL is inserted unchanged, as today's `keepOriginal` does. A
  toast says the document has no folder yet, so the address was kept.
- **An absolute local path** — the path is inserted unchanged. Markdown and
  AsciiDoc render it; Typst rejects a drive-letter path and the HTML guest
  cannot serve a file outside its root, so for those two languages the notice
  says so (see below).
- **A relative local path** — inserted as typed; it will resolve once the
  document is saved. Today the app tries to resolve it against the working
  directory and reports "not found".
- **A `data:` image** — inserted unchanged in Markdown, HTML and AsciiDoc; the
  previews allow `data:`. Typst has no data-URI image, so it is refused with a
  message.
- **A clipboard bitmap** (or a rich-paste image with no address) — there is
  nothing to keep. With an absolute custom folder, Markdown and AsciiDoc save
  there and insert the absolute path. Otherwise nothing is inserted; the toast
  says to save the document first, or to set an absolute **Custom Folder**.
  Never a file in the process working directory.

**Typst and HTML need one more condition.** Both resolve *local* images against
a root that only a saved document has (Typst's `--root`, the guest's scheme
handler), so an untitled Typst or HTML document has no usable local
destination, even with an absolute custom folder:

- a bitmap is refused with the save-first message;
- a local path is kept with a notice that it cannot render until the document
  is saved (Typst will still need it copied afterwards, because it rejects a
  drive-letter path);
- a remote URL differs by language: the HTML guest's CSP allows `https:`, so
  the image renders even while the document is untitled; Typst cannot fetch a
  URL at all, so the notice says it will never render and a folder rule is the
  only way.

A **saved** document whose destination cannot be written (read-only volume, a
custom folder that is a file, a denied network share) does **not** fall back:
the write failed for a reason the reader can act on, so the toast keeps naming
the folder. The fallback exists only for the case where no destination was ever
chosen.

### Other edge cases found while tracing the four rules

| Situation | Today | After |
| --- | --- | --- |
| Saved Typst + a URL + `keepOriginal` | `#image("https://…")`, which Typst cannot fetch, so the document never compiles | insert and say Typst cannot display a URL; a folder rule downloads it |
| Saved Typst + an absolute local path + `keepOriginal` | a drive-letter path Typst rejects | rewrite to a relative path when it is inside the document folder; otherwise keep it and say Typst cannot read it |
| Typst + `Format › Image` | Markdown `![…]` syntax | `#image("./image.png", alt: "alt text")` |
| `file:///C:/My%20Pictures/a.png` pasted as text | `/C:/My%20…` is not resolved; pasted as text | percent-decoded, the leading slash before the drive removed, then imported |
| `"C:\My Pictures\a.png"` pasted (Explorer's *Copy as path*) | ignored because of the quotes and the space | quotes stripped, path imported |
| `data:image/png;base64,…` pasted as text | pasted as text | decoded and saved like a clipboard bitmap |
| `<https://host/x.png>` pasted (autolink form) | not recognised | surrounding angle brackets trimmed |
| A remote URL that answers 200 with HTML/JSON | saved as `*.png` and called a download | refused with the content type named |
| A remote URL with no extension (`…/image`) | sniffed; name `image` | unchanged |
| AVIF whose major brand is `mif1` with `avif` among the compatible brands | sniffed as HEIC (`mif1`), saved with the wrong extension | scan the whole `ftyp` brand list; `avif`/`avis` win over `mif1` |
| Typst + AVIF, HEIC, BMP or ICO | `#image("…")` and a compiler error ("unknown image format" for AVIF, measured with Typst 0.15.1) | save the file when a folder rule applies, insert no reference, and say which formats Typst reads (PNG, JPEG, GIF, WebP, SVG); with `keepOriginal`, insert nothing and explain |
| A clipboard bitmap in an untitled Markdown/AsciiDoc + absolute custom folder | written under the working directory | written to the custom folder, absolute path inserted |
| A clipboard bitmap in an untitled Typst/HTML | written under the working directory, never renders | refused with the save-first message |
| `custom` chosen with an empty folder | "No custom image folder is configured" | unchanged (the message is already actionable) |
| `custom` pointing at a file, not a folder | "Could not create …: File exists" | unchanged; the message names the path |
| A document called `Resolução.md` | the default folder is `Resolu--o.assets` (`sanitize_stem` keeps ASCII only) | `Resolução.assets`, and `${filename}` reads the same |
| Rich text with several images, some failing | silent, URL kept | one notice per failure, capped, naming the first reason |
| A custom folder with `${filename}` | literal folder named `${filename}` | the sanitised document stem |
| A document named `CON.md` | `sanitize_stem` already protects files | `${filename}` uses the same sanitiser |
| A failed image in the preview | broken-image icon only | the icon plus a `title` with the original address |

## Scope and non-scope

**Scope**

- `src-tauri/src/images.rs`: content validation, HTTP error classification,
  `${filename}`, the no-document case.
- `src/images.ts`, `src/paste/index.ts`, `src/main.ts`: the untitled policy,
  the failure notices, and the paste parsers (`file://`, quotes, `data:`,
  angle brackets).
- `src-tauri/src/html_preview.rs` + `src/api.ts`: the guest may load static
  assets from the configured custom image folder.
- `src-tauri/src/typst.rs` + `src-tauri/src/export.rs` + `src/api.ts`: the
  compiler root covers the custom image folder when it is on the document's
  volume; the export path gets the same root.
- `src/main.ts` `imageCommand`: Typst syntax.
- `src/markdown.ts`: failed-image `title` and `data-src` (shared with the link
  plan).
- `src/preferences.ts` help text where the semantics become explicit.
- `docs/guide.md`, `AGENTS.md` traps.

**Non-scope**

- Authenticating a download with a browser session. MDraft has no access to the
  user's browser cookies, and importing another application's session is not a
  feature this project should grow. The fix is to say what happened.
- A lightbox or image viewer in the preview; the broken-image marker stays.
- Dragging an image out of a browser window. Tauri delivers only real file
  paths for native drags.
- Changing where **exports** put assets; only the Typst *reader* root changes.
- Embedding a clipboard bitmap as a `data:` URI when an untitled HTML document
  has no root. It would render, but it turns a screenshot into a multi-megabyte
  source line that never shrinks; the message asks for a save instead.

## Approach and rejected alternatives

**Approach.** Treat "the bytes are not an image, or the request failed" as a
first-class outcome instead of the current silent fallback. The Rust commands
return a classified error (status 401/403, non-image content type, too large,
timeout). The resolver throws instead of returning `null` on failure, so
`resolveImages` can keep the URL **and** add a notice; `applyRichPaste` shows
the first notice. `null` remains the "deliberately kept, no request" answer for
`keepOriginal`, the *Keep the original URL* preference, and the untitled
fallback.

The untitled policy lives in one place in `src/images.ts`
(`hasImageDestination(language, documentPath, rule, customDir)`), and the Rust
`target_dir` enforces the same rule as a second line of defence: a rule that
needs a document folder and has none returns the save-first message instead of
`std::env::current_dir()`.

Then make the folder destinations reachable: expand `${filename}`, add the
configured image folder as an allowed extra root to the HTML guest, and give
Typst a `--root` that covers the custom folder (common ancestor of the document
folder and the custom folder, same volume only).

**Rejected alternatives**

- *Fetch with the WebView's cookies.* MDraft's WebView is a different browser
  profile from the one that signed in to the web app; it has no session to
  lend, and copying a session across applications is not something this
  application should do.
- *Keep a bogus file and let the preview show it.* That is today's behaviour and
  it is the bug: a `.png` that contains HTML is worse than no file.
- *Always fall back to keepOriginal for an untitled document.* Wrong for a
  clipboard bitmap, which has no original location, and wrong when the reader
  configured an absolute custom folder that works without the document.
- *Silently fall back to the document's assets folder when the chosen folder is
  outside the Typst root.* The rule would keep looking broken because the file
  appears where the user did not ask for it.
- *Point Typst's `--root` at the drive root for every document.* It widens what
  every document may `#include`, including documents that never use images.
  The common ancestor of the two folders the user actually chose is the
  smallest useful widening.
- *Read the image through a canvas in the preview.* Cross-origin pixels are
  unreadable without CORS headers, and the address in question answers 401.
- *A retry button in the toast.* The failure is deterministic (no session), and
  the toast has no room for a second action.

## Steps

- [ ] **1. Content validation in `download_image`.**
      Use the sniffed format for the file extension and refuse the download
      when sniffing fails. The URL extension may name the file only after the
      bytes proved to be an image. The error names the response's content type:
      `… answered text/html, not an image.`
- [ ] **2. Classify HTTP failures.** Map `ureq::Error::StatusCode(401 | 403)` to
      a sentence that says the address needs a sign-in and that MDraft cannot
      use the browser's session; map timeout and DNS failures to their own
      sentences. Keep the URL in all of them.
- [ ] **3. `resolveImage` failures become notices.** `resolveImages` records
      `Could not save <image>: <reason>` (one per failure, capped) and keeps the
      URL; `applyRichPaste` prints the first notice instead of dropping all but
      the skip count. Direct URL paste and drop already toast their errors;
      they inherit the clearer messages.
- [ ] **4. `keepOriginal` wins for rich text.** `richImageOptions` no longer
      rewrites the rule; `resolveRichImage` returns `null` for it (no request,
      URL kept). Update the help text of **Remote Images in Pasted Rich Text**
      to say that *Keep the original location* keeps every URL.
- [ ] **5. The untitled policy.** Add `hasImageDestination` to `src/images.ts`
      with the four-rule table above and the Typst/HTML exception. Route
      `saveClipboard`, `saveOnline`, `saveLocal`, `handleImageDrop` and
      `resolveRichImage` through it. A refused bitmap calls `notify` and inserts
      nothing; a kept image is inserted unchanged with a notice.
- [ ] **6. `${filename}` in a custom folder.** Substitute the document's
      sanitised stem (`sanitize_stem`) for the literal token; document it in
      the row help and the guide. An untitled document never reaches this
      branch (step 5).
- [ ] **7. No working-directory fallback in Rust.** `target_dir` returns the
      save-first message when the rule needs a document folder and there is
      none. An absolute custom folder keeps working.
- [ ] **8. HTML guest asset roots.** `HtmlPreviewRequest` gains
      `imageRoots: Vec<String>` (serde default, empty). `PreviewState` keeps
      them canonicalised; `resolve_asset` accepts a path that starts with the
      document root **or** one of those roots. The frontend passes the custom
      folder when `imageRule == "custom"` and the folder resolves. Nothing else
      becomes readable: the list is the one folder the reader configured.
- [ ] **9. Typst root.** `render_typst` and `compile_to` accept an optional
      `image_root`; Rust takes the longest common ancestor of the document
      folder and that root when both exist on the same volume, otherwise keeps
      the document folder. The frontend passes the configured custom folder.
      `ExportRequest` gains the same optional field and `run_export` forwards
      it, so a PDF export of a `.typ` document sees the image the preview sees.
- [ ] **10. Typst and `keepOriginal`.** A remote URL cannot be fetched by the
      compiler and a drive-letter path is an invalid Typst path. Keep the value
      and add a notice saying so; rewrite an absolute path that lies inside the
      document folder to its relative form, which Typst can read.
- [ ] **11. Typst `Format › Image`.** Insert `#image("./image.png", alt: "alt
      text")` instead of Markdown syntax.
- [ ] **12. Paste parsers.** Accept `file://` URLs (percent-decoded, leading
      slash before a drive removed), one pair of surrounding quotes around a
      local path with spaces, `data:image/…` as a bitmap source, and strip
      surrounding angle brackets from an image URL.
- [ ] **13. Readable names for accented documents.** `sanitize_stem` keeps
      `char::is_alphanumeric()` instead of `is_ascii_alphanumeric()`, so
      `Resolução.md` produces `Resolução.assets` and `${filename}` is readable.
      Separators, dots and the reserved names keep their current rules.
- [ ] **14. Failed preview image.** Keep `data-src` in `decorateLinks` and set
      `title` to the original address when the image fails to load.
- [ ] **15. Docs and traps.** `docs/guide.md` gains the untitled policy, the
      failure behaviour, `${filename}` and the Typst/HTML reach rules. AGENTS.md
      traps: the 401-plus-silent-catch diagnosis, the content-sniffing
      fallback, the Typst `--root` and HTML `resolve_asset` confinement, and
      the untitled working-directory trap.

## Files and modules

| File | Why |
| --- | --- |
| `src-tauri/src/images.rs` | Validation, error text, `${filename}`, no-document guard, tests |
| `src-tauri/src/html_preview.rs` | Extra asset roots in the preview state and resolver, tests |
| `src-tauri/src/typst.rs` | `image_root` on render and compile, common-ancestor helper, tests |
| `src-tauri/src/export.rs` | `ExportRequest.imageRoot` and forwarding it to `compile_to` |
| `src-tauri/src/lib.rs` | Register nothing new; the command signatures change in place |
| `src/images.ts` | `hasImageDestination`, the four sources, the new parsers |
| `src/paste/index.ts` | Resolver outcome → notice |
| `src/main.ts` | Pass the custom root to the guest and Typst; `imageCommand`; the untitled notices |
| `src/markdown.ts` | `data-src` and the failed-image `title` |
| `src/api.ts` | `setHtmlPreview`, `renderTypst`/`renderTypstFile` and `ExportRequest` wrappers |
| `src/preferences.ts` | Two help strings |
| `docs/guide.md` | Reader-facing behaviour |
| `AGENTS.md` | Traps |

## Risks and rollback

- **A content-type check rejects a real image.** Some servers return
  `application/octet-stream`; sniffing the bytes is the authoritative test, so
  only payloads whose bytes are not an image are refused. The existing
  `sniff_ext` already covers PNG/JPEG/GIF/WebP/BMP/ICO/AVIF/HEIC/SVG.
- **The untitled policy could surprise a reader whose custom folder is
  relative.** The toast names the setting and the two ways forward; the guide
  states the rule. No file is written outside a folder the reader chose.
- **The Typst root widens file access.** It never goes above the common
  ancestor of the document folder and the folder the reader configured. A
  document on another volume keeps today's root. Tests pin both directions.
- **The HTML extra root could be abused by a crafted document.** Only the
  configured image folder is added, canonicalised, and a `..` escape still has
  to land inside it. The existing symlink test is extended.
- **The accented-name fix can split an existing asset folder.** A document that
  already wrote `Resolu--o.assets` will put *new* images in `Resolução.assets`;
  existing links keep working and nothing is moved. Say so in the guide.
- **`keepOriginal` in rich text may surprise a reader who also chose "Download
  and save".** The master rule wins by design; the help text says so and the
  guide repeats it.
- Rollback: the change is confined to the image pipeline and the two preview
  roots. Reverting the commits restores today's behaviour; no settings schema
  changes, so no migration is needed.

## Tests and validation

- `npm run test:rust` — new tests:
  - a 200 response with HTML bytes is refused, not saved as `.png`;
  - a 200 response with PNG bytes is saved with the sniffed extension;
  - a 401 response produces the sign-in sentence;
  - `${filename}` expands to the sanitised document stem;
  - an accented document name (`Resolução.md`) keeps its letters in the folder
    name and in `${filename}`;
  - an untitled document refuses a relative destination and accepts an
    absolute custom folder;
  - the Typst common-ancestor helper (same volume, different volume, custom
    folder inside the document folder);
  - the guest `resolve_asset` accepts an extra root and still refuses `..` out
    of it.
- `npm run paste:convert` — extended: a throwing resolver keeps the URL and
  produces a notice; a `null` resolver keeps it silently; an untitled document
  keeps a remote image and reports the reason.
- `npm run image:syntax` — extended:
  - `custom` with a temporary folder for a bitmap and a remote image;
  - an untitled Markdown document: a bitmap with an absolute custom folder is
    written there, a URL keeps its address, a bitmap with a relative rule is
    refused and leaves the buffer unchanged;
  - a fixture server answering 401 and one answering HTML: the source keeps
    the URL, **a toast is visible**, and no file is written;
  - `file://`, a quoted path with a space and a `data:` URL are imported.
- `npm run html` — the guest still loads the document's own assets, and a
  relative image under a configured extra root is served.
- `npm run typst:preview` — an image outside the document folder renders when
  its folder is the configured root; `Format › Image` inserts `#image`.
- `npm run smoke` — the untitled state is not part of its fixture; the
  `image:syntax` suite owns that case.
- **Live validation, opt-in.** The public
  `https://noticias.unb.br/images/Noticias/2026/10-out/21102026_Peacartesmarciais_Divulgacao.jpeg`
  answers `200`, `image/jpeg`, 51,775 bytes and its first bytes are `FF D8 FF`,
  so it sniffs as JPEG. Two modern-format counterparts answer
  `200 image/avif` (44,225 bytes) and `200 image/webp` (30,320 bytes):
  `https://www.aviftools.net/img/samples/sunset-beach.avif` and
  `https://www.gstatic.com/webp/gallery/1.webp`. They are the reachable
  counterparts to the 401 address in the diagnosis: with `imageRule = custom`
  and a temporary folder, pasting each URL as text and inside a rich fragment
  must write the file into that folder and insert a path the preview renders.
  In a Typst document the AVIF case must save the file and report that Typst
  cannot display it, while the WebP case inserts `#image`. The first URL
  (JPEG) is also the general case. `scripts/image-syntax-test.mjs` gains an
  opt-in `--live <url>` argument for this; the default suite keeps its local
  fixture server, because `npm test` must never depend on the network.
- Manual: load `fupia.md`, paste the same rich fragment again and read the
  toast; the public address above must copy into `C:\Users\bernh\Pictures`
  (the reported setting) and render, while the authenticated address keeps its
  URL and explains why.
- The UI layers need the machine's own MDraft closed: WebView2 allows one
  browser process per user-data folder, and an installed copy shares it. If it
  must stay open, use the documented throwaway build with its own `identifier`
  (AGENTS.md, second-instance trap).

## Acceptance criteria

- Pasting a clipboard bitmap, a local image path or a downloadable URL with
  **each** of the four rules writes the file where the rule says and inserts a
  path that the preview renders, whenever the image and the destination can
  exist.
- An untitled Markdown or AsciiDoc document never writes into the process
  working directory: a URL keeps its address, a bitmap uses an absolute custom
  folder or is refused with the save-first message.
- An untitled Typst or HTML document never inserts a local reference that
  cannot render; a bitmap is refused and a URL is kept with an explanation.
- A URL that needs a sign-in produces a visible message naming the address and
  the status, and the document keeps the URL instead of a bogus `.png`.
- A 200 response whose bytes are HTML never becomes an image file.
- Typst and HTML documents render an image saved in the configured custom
  folder on the same volume.
- `${filename}` in the custom folder becomes the document's name.
- `file://`, quoted and `data:` sources are imported rather than pasted as
  text, and `Format › Image` produces valid Typst.

## Deviations recorded during implementation

- **A fifteenth bug surfaced during the visual check.** DOMPurify removed any
  `src` written as a Windows drive path (`C:\…` looks like an unknown scheme),
  so an absolute image was copied but rendered as an empty `<img>`. `markdown.ts`
  now passes an `ALLOWED_URI_REGEXP` that admits `[A-Za-z]:[\\/%]`. The first
  version of that regexp wrote `[a-z+.-:]`, whose `.`-to-`:` range excludes `/`
  and therefore broke **relative** paths without `./`; the hyphen is escaped now
  and the UI suite pins both forms.
- **AVIF in Typst.** Typst 0.15.1 reads PNG, JPEG, GIF, WebP and SVG only;
  `#image("x.avif")` fails with `unknown image format`. The file is saved and the
  toast explains it, but no reference is inserted. WebP is inserted normally.
- **The `--live` flag lives on `image:rules`**, not `image:syntax`: that suite
  now owns every rule, the untitled fallback and the failing addresses. It was
  run against the three public samples (JPEG, WebP, AVIF) plus the public PNG.
- **The Markdown and HTML syntax checks moved to saved temporary files.** An
  untitled buffer refuses a bitmap by design, so the old `newTab()` setup could
  not exercise the syntax builders.
- **`open_external` lives in `documents.rs`** rather than a new module: it is a
  path command and the module already owns path resolution.
- Validation: Rust 112 passed / 2 ignored; `image:rules` 28/28; `image:syntax`
  22/22; the live run 12/12 plus the visual screenshots; `smoke` 107/107;
  `html` 60/60; `paste` 79/79 (the 8 native Ctrl+V checks skip themselves
  because this session cannot own the clipboard; they run as 87 when it can);
  `format-document` 139/139; `typst:preview` 52/52; `lint`, `knip` and
  `clippy -D warnings` clean. `format:check` was clean for every file this plan
  touched; `scripts/typst-preview-test.mjs` was already unformatted in the
  working tree.
- **The paste suite now proves the clipboard before using it.** A write followed
  by a read that comes back empty skips the 8 real Ctrl+V checks with a `SKIP`
  line instead of turning a locked session into a test failure, as the existing
  clipboard trap already advises.

## Open questions

1. When a custom folder is on a different volume from a Typst document, Typst
   cannot be given both roots. Default: honour the rule, save the file, and let
   the preview report the compiler's error with a toast that explains why. The
   alternative — silently saving into `<filename>.assets` — is rejected above.
2. Should a failed rich-paste image be inserted as a plain link rather than a
   broken image? Default: keep the image markup, because it is what the author
   wrote and it starts working as soon as the address is reachable.
3. Should the save-first message offer to save the document right there
   (a dialog with a button) instead of a toast? Default: no in this change. The
   paste is recoverable because the clipboard still holds the image, and the
   image pipeline has no access to the save flow today.
