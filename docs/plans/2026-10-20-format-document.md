# Right-click Format Document for Markdown, HTML and Typst

**Status:** done
**Date:** 2026-10-20
**ADR:** `../adr/2026-10-20-webview-formatters.md`

## Context and goal

The editor has no way to reformat a document. A reader who pastes badly wrapped
HTML, an unaligned Markdown table, or Typst whose indentation has drifted must
fix it by hand. Spelling already owns a right-click menu on a misspelled word
(`src/spellcheck.ts`); everywhere else the webview's own menu appears. The goal
is a right-click **Format Document** action for Markdown, HTML and Typst that is
undoable in one step, keeps the caret, never touches a document it did not
format, and costs nothing at launch.

AsciiDoc is deliberately excluded. There is no maintained AsciiDoc source
formatter, and the only two candidates found were not worth a dependency:
`dprint-plugin-asciidoc` is 0.1.0, says "No tests specified" and only trims
trailing whitespace; the IntelliJ plugin is not reusable. A whitespace-only
normaliser was considered and rejected as not worth calling "format".

CodeMirror 6 does **not** provide this. It is an editor toolkit: it exposes
`EditorState`/`EditorView`, keymaps and DOM event handlers, but no formatter and
no context menu. `@codemirror/commands` has indentation commands only
(`indentMore`, `indentLess`, `indentWithTab`), not a format command. The two
near-misses are:

- a third-party menu package, which only supplies the menu and still needs a
  formatter per language;
- an LSP client (`codemirror-languageserver`, or `@codemirror/lsp-client`) and a
  formatting server per language. That is several processes, per-language
  configuration and start-up work for one command, and the application has no
  LSP today.

The menu is therefore ours, and the formatters are the real decision.

## Scope and non-scope

In scope:

- A right-click menu item inside the source editor. It is not shown in the
  preview, the tab strip, the sidebar or the Preferences panel.
- Markdown and HTML through Prettier's browser build (Prettier is already a
  devDependency and is already the repository's formatter).
- Typst through `typstyle` compiled to WebAssembly.
- Lazy loading: nothing is fetched, parsed or instantiated until the first
  Format Document for that language.
- One undo step, caret preservation, a read-only check, error reporting, and a
  guard against applying a result to a document that changed while the
  formatter was running.
- Tests and documentation, including the `AGENTS.md` script/test tables.

Out of scope:

- AsciiDoc formatting, for the reason above. Right-click in an AsciiDoc buffer
  keeps its current behaviour.
- Format Selection. Prettier's range support is unreliable outside
  JavaScript/TypeScript and Typst's `format_range` would give one language a
  different menu shape. Document only.
- A native menu item, accelerator, or shortcut. The request is right-click;
  adding a native command changes `menu.rs`, the accelerator registry and the
  shortcut test.
- A Web Worker. Measured cost is 25 ms for the 2.5 KB tour document, 33 ms for
  the 43 KB physics paper and 800 ms for the 1 MB book. A worker can follow if
  that 800 ms freeze is judged unacceptable; it is not worth the extra module,
  worker-WASM loading and WebKitGTK risk for the common case.
- Third-party licence-screen changes. Prettier is MIT and typstyle is
  Apache-2.0; the About dialog will name them, but the existing
  "Font Licences" document stays as it is. See Open questions.

## Approach and rejected alternatives

**Approach.** Add `src/format/` with two small modules: a formatter dispatcher
with dynamic imports, and a context-menu installer. `src/main.ts` installs the
menu once after `createEditor` with `() => doc.language` and the existing
`toast` function. The menu listens on `document` for `contextmenu`, so the
spelling plugin's `preventDefault()` + `stopPropagation()` on `view.dom` wins
whenever a misspelled word is under the pointer; otherwise the event reaches
`document` and the format menu opens. No change to `spellcheck.ts`. For an
AsciiDoc document the listener returns without opening anything.

All formatters return a whole string. The dispatcher snapshots
`view.state.doc`, compares the result, and dispatches one transaction with the
caret moved to the same line/column (clamped), `scrollIntoView: false`, and
`userEvent: "format"`. If the document changed while an async formatter was
running the result is discarded. If the result equals the input, nothing is
dispatched and the toast says "Already formatted".

Markdown/HTML options: `printWidth: 100` (the repository's Prettier config),
`proseWrap: "preserve"` so prose line breaks are not rewritten, `endOfLine:
"lf"` (the backend already normalises CRLF in memory and restores the original
ending on save). Typst options: 2 spaces, width 100, no text wrapping, imports
reordered (typstyle's normal behaviour), blank-line bound 2.

### Size, measured

The chunks below are the exact Vite/Rolldown output of a probe that imports the
three formatters dynamically, minified like the application. Tauri embeds each
asset Brotli-compressed (quality 9, the release default; `compression` is in
Tauri's default features and is confirmed by `cargo tree` and the `brotli`
entry in `Cargo.lock`). The Brotli column is therefore the bytes added to the
installed executable, not a gzip estimate.

| Asset (minified; KB = 1024 bytes) | Raw | Brotli q9 |
| --- | ---: | ---: |
| Prettier `standalone` | 79.1 KB | 24.4 KB |
| Prettier Markdown plugin | 266.8 KB | 71.5 KB |
| Prettier HTML plugin | 156.1 KB | 45.5 KB |
| Typstyle WASM | 643.2 KB | 205.0 KB |
| Typstyle bindings | 8.9 KB | 3.2 KB |
| **All formatter assets** | **1,154.0 KiB** | **349.6 KiB** |

- **Installed executable: about +0.35 MiB (0.36 MB)** (349.6 KiB of compressed assets plus
  a few KB for the menu code and asset index). This is the number the staged
  binary will be measured against.
- **Initial JS entry: under ~5 KB raw / ~2 KB compressed.** The formatter
  chunks are dynamic imports and are not parsed or fetched at launch.
- **First use, from local assets (no network):** Markdown 345.9 KB raw /
  95.9 KB compressed; HTML 235.1 KB raw / 70.0 KB compressed; Typst 652.0 KB
  raw / 208.2 KB compressed. Prettier's `standalone` chunk is shared, so
  formatting Markdown and then HTML costs only the HTML plugin the second time.
- **Installer delta** will be smaller than the executable delta because the
  installer compresses the executable again. It will be measured with
  `npm run dist`; it is not assumed here.

### Why not native Rust crates

I did not rule them out on capability or speed; native is faster. I ruled them
out on what every user pays and what every build pays. The numbers are measured
with the application's release profile (`opt-level = 3`, thin LTO, 16 codegen
units, `panic = "abort"`, `strip = true`) on Windows/MSVC, against a 147,456-byte
baseline binary:

| Native implementation | Binary | Delta |
| --- | ---: | ---: |
| `typstyle-core` 0.14.4 | 702,976 B | **+542.5 KB** |
| `dprint-plugin-markdown` 0.26.0 | 620,032 B | **+461.5 KB** |
| `markup_fmt` 0.27.6 (HTML) | 816,128 B | **+653.0 KB** |
| All three together | 1,807,872 B | **+1,621.5 KiB (1.58 MiB)** |

The real application already links `serde`, `serde_json` and much of `std`, so
the deltas there may be somewhat smaller; they cannot close a 4.6x gap against
349.6 KiB of lazily decompressed assets. Native code is linked into every
executable and cannot be left out for users who never format, while the WASM is
only instantiated on first use.

There is also a hard version conflict. `typstyle-core` 0.15.0 through 0.15.2
declare `rust-version = 1.92`; this repository pins Rust 1.91 and the host has
rustc 1.91.1. The native route would either bump the project's MSRV (and every
contributor's and CI's toolchain) or pin `typstyle-core` 0.14.4, which is older
than the 0.15.1 WASM package. The WASM binary is prebuilt, so it has no MSRV
cost.

The remaining costs are architectural:

- Formatting becomes a `#[tauri::command]`, its `src/api.ts` wrapper, a serialized
  full-document round trip, and Rust tests — a public contract for a pure text
  transformation the frontend already has the text for.
- The release profile is `panic = "abort"`. A parser bug that panics on
  adversarial input terminates the application. A WASM trap is catchable in the
  dispatcher and leaves the buffer untouched.
- The crates compile for every target and every clean build; the WASM artifact
  is one file, identical on Windows, macOS and Linux.

If the project later wants native formatting for speed or to avoid WASM, the
viable combination is `typstyle-core` 0.14.4 + `dprint-plugin-markdown` +
`markup_fmt`, at roughly 1.6 MiB and with an MSRV decision. For this feature's
constraints, WASM wins.

### Other rejected alternatives

- **Prettier alone**: no Typst parser.
- **dprint for Markdown/HTML**: `@dprint/markdown` is 777 KB raw / 209 KB
  Brotli, about 3x Prettier's Markdown chunk; `dprint-plugin-markup` is 1.96 MB
  raw / 427 KB Brotli, about 9x Prettier's HTML chunk, and it dedents
  `<style>`/`<script>` contents incorrectly on the HTML tour.
- **Native Tauri context menu**: platform menus cannot merge with the spelling
  suggestions or the existing themed DOM menu, and every change becomes a Rust
  command plus capability work.
- **`codemirror-context-menu`**: supplies only the popup. The repository already
  has a themed menu pattern in `spellcheck.ts`; a second dependency buys nothing.
- **LSP formatting**: correct in principle, far too much machinery for three
  document languages and no server installation story.
- **Custom Markdown/HTML/Typst formatters**: formatting is the hard part;
  Prettier and typstyle are the maintained implementations.

### Speed, measured

Warm, Node on this host: Prettier Markdown 25 ms for
`samples/feature-tour.md`, 33 ms for the 43 KB physics paper, 800 ms for the
1 MB `docs/samples/kardec.md`; typstyle 13 ms for `samples/typst-tour.typ` and
1 ms on the second call. dprint's Markdown plugin was 8 ms, but it is larger
after compression and would add a second engine. Native typstyle would be
faster still; the measured WASM time is not the bottleneck.

## Steps

- [x] 1. Move `prettier` from `devDependencies` to `dependencies`; add
      `@typstyle/typstyle-wasm-bundler` pinned to `0.15.1`; update the lockfile.
- [x] 2. Add `src/format/formatters.ts` (language dispatch, dynamic imports,
      typstyle instantiation, error normalisation, snapshot guard) and
      `src/format/typstyle.d.ts` for the wasm-bindgen glue module.
- [x] 3. Add `src/format/menu.ts`; install it from `src/main.ts` after
      `createEditor`; add the shared menu styles in `src/styles.css`.
- [x] 4. Add `scripts/format-document-test.mjs` (Markdown, HTML, Typst) and
      register it in `package.json` and `scripts/test-all.mjs`.
- [x] 5. Run `npm run build`, `npm run lint`, `npm run knip`,
      `npm run format:check`, the new suite, and the regression suites
      (`spellcheck`, `smoke`). Build once with `npm run dist` and record the
      staged binary, installer and `dist/assets` sizes against the numbers
      above.
- [x] 6. Update `README.md` (the right-click bullet and About credits),
      `AGENTS.md` (scripts and tests tables) and this plan's
      status/deviations.

## Files and modules

- `package.json`, `package-lock.json` — one new dependency, one section move.
- `src/format/formatters.ts` — `formatDocument(text, language)`; Prettier and
  typstyle loaders; the untouched/empty and error rules.
- `src/format/typstyle.d.ts` — types for `typstyle_wasm_bg.js`, which the
  package does not declare.
- `src/format/menu.ts` — the document-level contextmenu listener, menu DOM,
  placement, dismissal, disabled state, AsciiDoc exclusion.
- `src/main.ts` — one `installFormatMenu(...)` call, with `doc.language` and
  `toast`.
- `src/styles.css` — `.format-menu` added to the existing `.spell-menu`
  selectors, plus the disabled-item rule.
- `scripts/format-document-test.mjs` — CDP checks across the three languages.
- `scripts/test-all.mjs`, `AGENTS.md`, `README.md` — registration and docs.
- `docs/plans/2026-10-20-format-document.md` — this file.

No Rust file, CSP rule, capability, settings key or menu id changes.

## Risks and rollback

- **WASM does not instantiate in one of the webviews.** The CSP already allows
  `wasm-unsafe-eval`, Vite's `?init` falls back to `arrayBuffer` when the asset
  is not served as `application/wasm`, and `typst-pdf.ts` already proves that
  workers and local assets load. If a webview still refuses, the fallback is
  the native route above — a larger change and a new plan, not a drop-in.
- **Prettier changes a Markdown or HTML construct the user did not expect.**
  The action is explicit, previews update immediately, and one undo restores the
  exact bytes. `proseWrap: "preserve"` avoids the most intrusive rewrite.
- **A 1 MB document freezes the window for ~0.8 s.** The toast is painted
  before the formatter starts. If this is unacceptable, move only the Prettier
  path to a module worker; the dispatcher interface stays the same.
- **Formatting a document that changes underneath it.** The dispatcher compares
  the captured `Text` identity before dispatching and discards stale results.
- **The format menu shadows the spelling suggestions.** It does not: the
  spelling menu calls `preventDefault()` and `stopPropagation()` on `view.dom`,
  so the document-level listener never fires. The CDP suite asserts both paths.
- **Size.** The initial bundle is untouched; only the lazy chunks and the
  executable grow. If the measured growth is unacceptable, dropping the HTML
  plugin saves ~45 KB compressed; dropping Typst saves ~208 KB but removes a
  supported language.

Rollback: revert the branch. Nothing persists in settings, no schema changes,
no files on disk.

## Tests and validation

Cheapest layers first:

1. `npm run build` — the dynamic import types, the wasm declaration and the
   menu compile.
2. `npm run lint`, `npm run knip`, `npm run format:check`.
3. `npm run format:document` with the app on `samples/feature-tour.md`:
   right-click opens one menu; Markdown aligns the table and normalises
   `*emphasis*`; the tab turns dirty; the caret stays on its line; Ctrl+Z
   restores the exact original; a second format says "Already formatted";
   the HTML tour gains `<!DOCTYPE html>` and `/>`; the Typst tour is
   reindented; an AsciiDoc tab opens no format menu; right-clicking a
   misspelled word still opens the spell menu and not the format menu; Escape
   and an outside click close the menu; the preview does not open it.
4. `npm run spellcheck`, `npm run smoke` — regressions.
5. `npm run dist` once; record `dist/assets` sizes, the staged executable size
   and the installer size. Manual launch on Linux (CDP is unavailable there) to
   confirm that the Typst WASM loads under WebKitGTK.

The measurement that proves the feature is the CDP suite's byte comparison
before/after and after-undo, not a count of menu items. The measurement that
proves the cost is the `dist/assets` listing and the staged binary size.

## Deviations and measurements

- The HTML fixture already began with `<!doctype html>`, so the suite asserts
  that Prettier keeps it and turns void elements into `<meta … />`, rather than
  "gains a doctype".
- The Typstyle package's entry point imports its `.wasm` as an ES module, which
  Vite turns into a URL rather than a WebAssembly module. The dispatcher loads
  `typstyle_wasm_bg.js` and `typstyle_wasm_bg.wasm?init` separately, passes the
  glue as the wasm import object, and calls `__wbindgen_start()` once.
  `src/format/typstyle.d.ts` declares the glue module the package leaves
  untyped.
- The CDP suite waits 300 ms before reusing a menu id: `runMenuAction` suppresses
  the same id within 250 ms, which is correct for the application but faster
  than a person can save twice. See the Traps section in `AGENTS.md`.

Build output for the lazy chunks (Vite reports gzip; the Brotli column is
quality 9, the compression Tauri uses for embedded assets):

| Asset | Raw | gzip | Brotli q9 |
| --- | ---: | ---: | ---: |
| Prettier `standalone` | 80,983 B | 26.72 KB | 25,004 B |
| Prettier Markdown plugin | 273,189 B | 92.22 KB | 73,187 B |
| Prettier HTML plugin | 159,810 B | 50.65 KB | 46,630 B |
| Typstyle WASM | 658,635 B | 253.26 KB | 209,901 B |
| Typstyle glue | 8,159 B | 2.92 KB | 2,797 B |
| **All formatter assets** | **1,180,776 B (1,153.1 KiB)** | — | **357,519 B (349.1 KiB)** |

The measured Brotli total matches this plan's 349.6 KiB estimate within 0.5 KiB.
The initial entry chunk grew from 890,497 B to 890,740 B (0.2 KB) and references
none of those assets until the first format.

Staged artefacts, compared with the 0.4.2 files they replaced:

| Artefact | 0.4.2 | 0.4.3 | Delta |
| --- | ---: | ---: | ---: |
| Published portable `.exe` | 14,412,800 B | 14,773,248 B | +352.0 KiB |
| NSIS setup | 8,866,923 B | 9,228,543 B | +353.1 KiB |
| MSI | 10,158,080 B | 10,514,432 B | +348.0 KiB |

The installed executable grew by about the compressed formatter assets, as
predicted. `npm test` passed all 28 layers, including the new 42-check suite,
`spellcheck` and `smoke`; the suite was run after the 0.4.3 build as well.

## Acceptance criteria

- Right-clicking in a Markdown, HTML or Typst source editor shows exactly one
  themed menu with **Format Document**; right-clicking anywhere else, or in an
  AsciiDoc buffer, does not.
- Markdown, HTML and Typst documents change in the way their formatter defines.
- One Ctrl+Z restores the exact original text; the caret is on the same line;
  the document is marked dirty when it changed.
- A misspelled word still offers suggestions and **Add to dictionary**; the
  format menu does not replace them.
- No formatter asset is requested at launch. `dist/assets` shows separate
  Prettier and Typstyle chunks, the entry chunk grows by no more than a few KB,
  and the installed executable grows by about 0.35 MiB (measured, not assumed).
- A formatter failure leaves the buffer byte-for-byte unchanged and names the
  failure in a toast.
- The new suite and the `spellcheck` and `smoke` regressions pass.

## Open questions

- **Width 100 or 80.** Default 100 to match `.prettierrc.json`; typstyle's own
  default is 80. A different width is a one-constant change.
- **Worker now or later.** Default later: 800 ms on a 1 MB book, with a toast,
  does not justify a worker until someone reports it.
- **Licence notices.** Prettier is MIT and typstyle is Apache-2.0; both require
  their notices to travel with a binary distribution. The About dialog will
  name them, but the project currently ships no third-party notice file beyond
  the font licences. Default for this change: About lines only, and a follow-up
  audit of all bundled dependencies.


