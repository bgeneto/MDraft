# Browser-readable HTML and print output

**Status:** draft
**Date:** 2026-10-25
**ADR:** none

## Context and goal

The native **HTML** and **PDF (Print)** exports reuse the preview renderers, but
not the preview's environment. `decorateLinks` intentionally rewrites every
local image to an `asset:` URL and removes every anchor `href`, keeping the
original in `data-src`/`data-href`; inside MDraft those decorations are what make
Ctrl+click, the asset protocol and the link menu work. An external browser has
neither. An exported Markdown or AsciiDoc page therefore shows broken local
images and dead links. The print document is written to the temporary folder,
so even an untouched relative image would point at the wrong place.

Two more correctness problems share the same code path:

- Mermaid diagrams are rendered with the current `isDark` value, while the print
  wrapper is deliberately light. A dark editor prints diagrams with dark text
  and fills on white paper.
- Both print wrappers call `window.print()` from the `load` event. That event
  does not guarantee that every image has decoded or that web fonts (notably
  KaTeX's) are ready, and `decorateLinks` marks images `loading="lazy"`, so an
  off-screen figure may never load before the dialog opens. There is no
  explanation when a resource fails.

The exported HTML also sets the reader's typography custom properties but the
standalone wrapper never uses them: its `body` hard-codes a system font stack
and 16 px. The embedded faces travel in the file and render nothing.

The goal is that the HTML and print artifacts MDraft already offers are correct
when opened in an ordinary browser, without weakening preview sanitisation, the
HTML guest boundary, or the offline limits that belong to GAP-033.

## Scope and non-scope

**In scope**

- Restore the real image `src` and anchor `href` for the export only, from the
  decoration values MDraft itself set.
- Resolve local references against the document folder and emit URLs that a
  browser can use:
  - HTML export: paths relative to the chosen output folder when the resource is
    on the same volume/root, otherwise `file://` URLs;
  - print: absolute `file://` URLs, because the document lives in the temporary
    folder.
- Preserve external schemes, `data:` URLs, `#fragment` links, spaces, Unicode,
  `..` components and Windows drive/UNC paths.
- Render Mermaid with an explicit theme: current theme for HTML export, light
  for print, independent of the editor theme.
- Wait for images and `document.fonts.ready` before printing, with a bounded
  timeout, and print a visible warning listing resources that failed.
- Remove lazy loading from the print article and force it at runtime for an
  HTML source print copy.
- Make the standalone HTML wrapper use the typography custom properties
  (`--font-body`, `--font-heading`, `--font-code`, `--body-size`,
  `--weight-strong`) that the export already emits.
- Tests at three layers: pure path/URL unit, a real-UI export suite that captures
  the exact HTML handed to print, and manual browser/PDF inspection on Windows
  and Linux.

**Non-scope**

- Self-contained/offline packaging, embedding KaTeX fonts or removing the
  jsDelivr stylesheet. That is GAP-033; this plan keeps the existing documented
  network dependency for mathematics.
- Native WebView2/WebKitGTK printing and direct PDF save (GAP-009). The browser
  handoff stays.
- Rewriting an HTML document's own source copy. **File › Export › HTML** on an
  `.html` document still writes the source bytes, as `docs/export.md` says; a
  `<base>` element would break its internal `#` links, and packaging arbitrary
  HTML scripts/styles is GAP-033. The print copy keeps its existing `<base>`
  behavior.
- Typst's native HTML export (the app does not offer one). The transform still
  handles bare `src`/`href` from a Typst print article where they are local.
- Any change to preview decoration, Ctrl+click, word sync or the sandboxed HTML
  guest.
- Remote images that require authentication or are unreachable; the existing
  paste/download policy owns them.

## Approach and rejected alternatives

**Chosen approach: a publication transform applied only to the export DOM, plus
a theme and readiness contract for print.**

1. **Pure path/URL module.** Add `src/export-paths.ts`, with no DOM and no Tauri,
   exporting:
   - `isLocalReference(value)` — true for a relative path or a local absolute
     path, false for a scheme, `#fragment` and `data:`;
   - `splitSuffix(value)` — separates `?query`/`#fragment`;
   - `resolveLocalPath(reference, documentDir)` — normalises separators,
     resolves `.`/`..`, keeps a Windows drive or UNC root;
   - `fileUrl(path)` — the encoded `file://` form (drive, UNC, POSIX);
   - `relativeUrl(fromDir, targetPath)` — `null` when roots differ, otherwise a
     normalised relative URL with `/` separators;
   - `publicationUrl(reference, { documentDir, outputDir, absolute })` — the
     single policy function used by both exports.
   Being pure, it is testable in Node with Windows and POSIX fixtures side by
   side, which is where the drive/UNC/space bugs will otherwise hide.

2. **Export-only DOM transform.** Add `restoreExportReferences(host, options)` in
   `src/markdown.ts` (or a small `src/export-article.ts` if it keeps
   `markdown.ts` focused):
   - for an `<img>`: prefer the value in `data-src` (set by `decorateLinks`),
     otherwise its own `src`; skip `asset:` (which only the app can serve),
     `data:`, and remote schemes; resolve local values and set the new `src`;
     set `loading="eager"` and `decoding="sync"` for print;
   - for an `<a>`: prefer `data-href`, otherwise `href`; keep `#fragment`,
     `http:`, `https:`, `mailto:`, `tel:` and any other scheme; resolve local
     paths; set the new `href`;
   - remove the now-redundant `data-src`/`data-href` only when the original was
     restored, so no stale duplicate addresses travel in the file.
   The transform only uses values MDraft's own decoration attached to sanitised
   DOM. It never trusts an arbitrary attribute from the source document.

3. **One article builder, explicit theme.** `buildExportArticle(source, theme)`
   passes `isDark: theme === "dark"` to the AsciiDoc renderer and to
   `renderMermaidIn`. HTML export passes the current theme; print always passes
   light. After building, it applies the publication transform with
   `outputDir` = the chosen HTML folder (relative mode) or `null` (print,
   absolute mode). The HTML target is chosen before the article is assembled, so
   the output location is known; the source snapshot is still captured before
   the picker, as GAP-025 requires.

4. **Print readiness, one implementation.** Add `src/print-ready.ts` exporting
   the inline script used by both `wrapPrintHtml` and `buildHtmlPrintDocument`.
   On `load` it:
   - forces `loading="eager"` on every image;
   - waits for every image's `load`/`error` and for `document.fonts.ready`;
   - caps the whole wait (10 s) so a dead share cannot hang the print dialog;
   - after two animation frames, inserts a visible warning at the top of the
     document when an image has `naturalWidth === 0`, naming the failed
     addresses;
   - calls `window.print()` exactly once.

   The script is a shared constant, not two copies that drift. It must remain a
   string safe to inline: no `</script>` sequence inside it.

5. **Typography and theme.** `wrapStandaloneHtml` uses the custom properties the
   export already writes for body, headings and code, and `--body-size`; it stops
   hard-coding a system stack that ignores the embedded faces. Print already
   uses `var(--font-body)`; it gains the heading/code variables where it lacks
   them. The print article keeps the light token stylesheet, and the HTML export
   keeps the active one.

6. **Verification against real artifacts.** The UI suite intercepts the save
   picker and the `print_document` command at the IPC transport boundary, as
   `p0-lifecycle-test.mjs` already does, so it can inspect the exact HTML the
   frontend would write/open without launching a browser. Node then resolves
   every emitted URL against the filesystem and the output folder. A manual
   browser/PDF check on both platforms proves what a file inspection cannot:
   that the browser actually loads the image and prints the diagram.

**Rejected alternatives**

- *Change `decorateLinks` or the preview to keep real `href`/`src`.* The app
  needs the asset protocol and removes `href` so the webview's own navigation
  cannot replace MDraft with a clicked page. The export must adapt, not the
  preview.
- *Use `<base href="file:///document/folder/">` in the exported HTML.* It fixes
  relative images but changes how every `#fragment` resolves: clicking a table
  of contents entry would navigate to the original folder instead of staying in
  the exported file. It is right for the print copy, which is not navigated, and
  wrong for the exported page.
- *Inline every local image as a data URL.* It would make the HTML portable but
  explode file size, bypass the user's asset policy and overlap GAP-033's
  explicit self-contained option. Relative/file URLs are the honest default.
- *Wait indefinitely for images.* A missing network image would leave the print
  document hanging with no dialog. A bounded wait plus a printed warning is
  better than a silent infinite wait.
- *Keep `load` + `setTimeout(250)`.* It is the current bug: fonts and lazy
  images are not covered, and 250 ms is a guess.
- *Render Mermaid twice for print.* The article is built fresh for each export;
  passing the theme is cheaper and keeps one DOM.

## Steps

- [ ] Add `src/export-paths.ts` and `scripts/export-paths-unit.mjs`; register the
      script in `package.json`, `scripts/test-all.mjs`, `AGENTS.md` and the
      README table. Cover Windows drive, UNC, POSIX, spaces, Unicode, `..`,
      `?query`/`#fragment`, different roots, `data:`, `mailto:` and `asset:`.
- [ ] Add the export-only reference transform and unit-test its URL output
      through the pure module; keep preview DOM untouched.
- [ ] Parameterise `buildExportArticle` with the output theme and folder; pass
      light for print, current theme for HTML; apply the transform after
      Mermaid rendering.
- [ ] Extract the shared print-readiness script; use it in `wrapPrintHtml` and
      `buildHtmlPrintDocument`; add the failed-resource warning and its styles.
- [ ] Make `wrapStandaloneHtml` use the typography variables; verify the
      embedded faces are the ones the file declares.
- [ ] Add `scripts/export-browser-test.mjs` with a Markdown and an AsciiDoc
      fixture containing a local image, an external link, a heading link and a
      local-file link. Intercept the save picker and `print_document`, trigger
      `file.exportHtml` / `export.pdf`, and assert:
      - no `asset:` URL remains;
      - the exported image URL resolves to the real file from the output folder;
      - print image URLs are absolute `file://` URLs and resolve;
      - `#fragment` and external destinations survive;
      - the print script waits for `document.fonts.ready` and images;
      - a dark editor produces light Mermaid output in the print HTML;
      - the standalone page uses `var(--font-body` and the font data is present.
- [ ] Register the suite in `scripts/test-all.mjs` with its own fixture and
      fresh instance; update the counts.
- [ ] Update `docs/export.md`: local images/links now resolve, print waits and
      warns, dark diagrams print light; keep the HTML source-copy and KaTeX CDN
      limitations explicit.
- [ ] Manual validation on Windows and Linux: export a Markdown and an AsciiDoc
      document with a real image and links, open in an ordinary browser, print
      to PDF from a dark editor, and inspect selectable text, fractions,
      radicals, images and diagram colours.

## Files and modules

| File | Why it must change |
| --- | --- |
| `src/export-paths.ts` | Pure path/URL policy shared by HTML and print |
| `src/print-ready.ts` | One bounded print-readiness script and warning |
| `src/markdown.ts` | Export transform, article theme, standalone typography, print wrapper |
| `src/html-preview.ts` | HTML source print uses the shared readiness script; `fileUrl` moves or delegates |
| `src/main.ts` | `buildExportArticle` receives output folder/theme; export entry points pass them |
| `src/styles.css` | Warning banner styles that survive print, if not inline |
| `scripts/export-paths-unit.mjs` | App-free path/URL matrix |
| `scripts/export-browser-test.mjs` | Real-UI artifact inspection |
| `scripts/test-all.mjs`, `package.json`, `AGENTS.md`, `README.md` | Register the layers and counts |
| `docs/export.md` | Reader-facing claims and remaining limits |

## Risks and rollback

- **`file://` resource policy differs by browser.** Some browsers restrict
  subresources on file-origin pages more than others. Test the actual exported
  and print files in the browsers users have (Edge/Chrome and Firefox on
  Windows, a WebKit browser on Linux); if a browser refuses the absolute image,
  fall back to a relative path for the HTML export (always possible) and to an
  embedded data URL only for print, recording the size cost. Do not change the
  preview protocol.
- **Path identity across volumes.** Relative URLs cannot cross a drive or UNC
  share. The `file://` fallback is deliberate; test it rather than emitting
  `../..` nonsense.
- **Spaces, `#`, `?` and Unicode in names.** Each URL segment is encoded; the
  test matrix includes all four. A bare `encodeURI` would leave `#` and `?` as
  delimiters.
- **Print wait feels slow.** The cap is 10 s; a healthy document prints as soon
  as its resources settle. A failed image prints a warning rather than blocking.
- **Mermaid light output.** Some diagrams set explicit dark colours in their
  source; the chosen theme cannot override those. The print test uses MDraft's
  own sample diagrams; the limitation is documented.
- **Security.** The transform restores only `data-src`/`data-href` that
  `decorateLinks` set on sanitised DOM. It must never copy an arbitrary
  attribute from the source into an export URL.
- **Rollback.** The transform is export-only; deleting its call restores today's
  output. The shared print script can be reverted to the old `load` handler
  without affecting the editor.

## Tests and validation

- `npm run export:paths:unit` (new app-free layer).
- `npm run export:browser` (new UI layer, own fixture and instance).
- `npm run export` (existing real-pandoc layer) stays green.
- `npm run html`, `npm run asciidoc`, `npm run word-sync`, `npm run smoke` stay
  green; the preview and guest must not change.
- `npm run build`, `npm run lint`, `npm run format:check`, `npm run knip`.
- Manual, Windows and Linux: inspect the exported HTML in a browser and the
  printed PDF. Check a local image actually paints, a heading link stays in the
  document, an external link opens, fractions/radicals are laid out, a dark
  editor prints light diagrams, and a deliberately missing image produces the
  printed warning.
- **The measurement that proves it works:** in the exported file, the image's
  `src` resolves to the real bytes on disk and `naturalWidth > 0` in the browser;
  in the print document, the same holds and the Mermaid SVG's fills are the
  light theme's.

## Acceptance criteria

- Export a Markdown and an AsciiDoc document containing a real local image, an
  external link, a heading link and a local-file link. In an ordinary browser
  the image loads and each link has the intended destination; no `asset:` URL
  or app protocol is required.
- Export to the document's folder and to a different folder/volume: resources
  resolve in both, with relative URLs where possible and `file://` otherwise.
  Spaces, Unicode and `..` survive; source bytes are untouched.
- Print from a dark editor produces light diagrams and token colours; the print
  waits for fonts and images (bounded), and names any image that failed instead
  of printing a silent hole.
- The standalone HTML uses the reader's selected faces and body size; the
  embedded font data is what renders.
- An HTML document's print copy still uses its local base and prints after its
  resources settle; its export copy keeps the documented source-byte behavior.
- Existing preview, word-sync, HTML guest and pandoc export behavior is
  unchanged.
- `npm run export:browser` fails on the old output (dead links/asset URLs) and
  passes on the new one.

## Open questions

- **Fallback when a browser refuses `file://` images.** Default: relative URL
  for HTML export (always available); for print, embed only the images that
  would otherwise fail, and record the size in the plan. Do not make embedding
  the default.
- **Print banner placement.** Default: a small red-bordered block above the
  article, naming the failed addresses; it disappears when everything loaded.
- **Typst print images.** Default: run the same transform over bare `src`/`href`;
  if Typst emits an `asset:` or unknown scheme, leave it and document it rather
  than inventing a mapping.
- **Warning for a failed stylesheet/font.** Default: `document.fonts.ready`
  resolves on failure too, so only images get the visible warning in this slice;
  a stylesheet warning would need a load/error probe on the `<link>` and is
  deferred to GAP-033's offline work.
