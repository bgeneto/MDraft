# Architecture, code map and the preference walkthrough

What the application is made of, which side of the Rust/TypeScript split
owns what, and the files a change usually touches.

Related: [development.md](development.md) for the build and debugging,
[workflow.md](workflow.md) for when a plan is required.

## Orientation

A **Markdown, Typst, LaTeX, HTML and AsciiDoc** editor: a **Rust/Tauri 2 backend** and a
**TypeScript frontend** that runs in the platform webview. There is no HTTP
server and no Node runtime in the shipped application; the HTML preview is an
in-process URI scheme, not a socket.

The split matters constantly:

| Lives in Rust (`src-tauri/src/`) | Lives in TypeScript (`src/`) |
| --- | --- |
| Reading and writing files | Markdown → HTML (`marked` + `DOMPurify`) |
| Directory listing, path existence | CodeMirror 6 editor and keymaps |
| Settings persistence | Preview rendering, KaTeX, Mermaid, highlight.js |
| Native menus | Pane sync, sidebar, Preferences panel |
| Image import and download | Paste and drop handling |
| HTML preview scheme, CSP, path confinement | HTML guest assembly and bridge |

The frontend **cannot** touch the filesystem. Every file operation is a
`#[tauri::command]` in Rust, called through the wrappers in `src/api.ts`.

Two rules that are not negotiable, both documented in the README:

1. **No telemetry, and no start-up network activity.** The only outbound
   requests the application makes itself are `images::download_image`, reached by
   a user pasting or dropping an image URL, or by pasting rich content that
   contains remote images, and the AI Assistant's
   `ai_complete`/`ai_fetch_models`/`ai_suggest_filename`, reached only after the
   reader enables the assistant, configures an endpoint and presses Generate,
   Fetch, or Save on an untitled document with *Suggest file names when saving*
   turned on. Both are user actions; *Preferences › Image*
   can turn each image request off, and the assistant is off by default. An HTML
   document the reader
   opens may request the resources its own markup links; that is the document's
   request, not the application's. The LaTeX engine is one
   additional user-initiated exception: after the reader explicitly enables
   it, MDraft downloads verified engine assets and fetches missing TeX Live
   packages and fonts from its pinned mirror. It does not send document or
   bibliography contents.
2. **No dead UI.** If a Typora option is not implemented, the Preferences panel
   shows a note explaining that, never a control that does nothing.

## Adding a preference, end to end

Five files, in this order — more than three, so a plan comes first; see
[Governance and workflow](workflow.md#governance-and-workflow).

1. **`src-tauri/src/settings.rs`** — add the field to the struct and to
   `Default`. `#[serde(rename_all = "camelCase", default)]` means an older
   `settings.json` keeps working; keep it that way.
2. **`src/api.ts`** — add the field to the `Settings` interface.
3. **`src/preferences.ts`** — add a row. The `Row` union covers `heading`,
   `note`, `checkbox`, `select`, `number`, `text`, `button`. Every row needs a
   `get` and a `set`; a row without behaviour is a `note`.
4. **`src/main.ts`** — handle the field in `applySettingsPatch`, and add it to
   `affectsRendering` if the preview must be re-rendered.
5. **Test** — extend `scripts/dom-smoke.mjs` so the row is exercised.

A **size** preference that also has to be remembered per typography preset
touches two more places: `src/fonts.ts` (`DEFAULT_*`, the preset `defaults` type,
and the comments that count the reader adjustments) and the preset write/restore
branch in `src/preferences.ts`. If the size is published as a CSS variable, the
export wrappers in `src/markdown.ts` need the same `var()` or the setting stops
at the preview; `Code scale` in `docs/plans/2026-10-28-code-font-scale.md` is the
worked example. The export suite should assert the variable and its rule in the
printed bytes.

If the setting changes the editor's appearance, call it through
`applySyntaxTheme`/`applyLayout` rather than mutating the DOM directly.

## Code map

```
src/
  main.ts            shell: document lifecycle, menus, status bar, pane sync
  sessions.ts        open documents: one session per tab, one EditorState each
  filename.ts        the Save dialog's content-derived name and its sanitiser
  document-lifecycle.ts session/revision snapshots, save queues, safe reload and close coordination
  unsaved-dialog.ts  explicit Save/Discard/Cancel modal; dismissal cancels
  statistics-dialog.ts read-only Document Statistics snapshot modal
  recovery.ts        debounced crash-recovery journal scheduler
  disk-change.ts     pure unchanged/modified/deleted classification
  typst-commands.ts  the Typst side of the Paragraph/Format menus
  tabs.ts            tab strip: rendering, overflow arrows, context menu, drag/keyboard order
  editor.ts          CodeMirror 6 setup, incremental word/line metrics, EditorHandle API
  links.ts           the pure link/image resolver behind Ctrl+click and the menu
  typst-pdf.ts       PDF.js Pages: page shells, text layer, fit transform, click context
  typst-page-map.ts  PDF visual line -> source occurrence and paragraph mapping
  typst-map.ts       Typst Document block ranges for the shared word map
  code-context.ts    code-like positions shared by spelling, paste conversion and the tag closer
  tag-close.ts       the Markdown/AsciiDoc `>` input handler
  tag-name.ts        the pure rule: which tag a typed `>` closes
  spellcheck.ts      spelling marks, language detection, suggestion menu
  context-menu.ts    the editor's right-click menu: clipboard, case, comment,
                     line operations and the Format Document callback
  clipboard.ts       web Clipboard API first, Tauri plugin fallback for text
  format/            the lazy Prettier/Typstyle dispatcher, snapshot guard and
                     the one transaction that applies a formatted document
  ai/                the AI Assistant: catalog/search, context capture, edit
                     plans, capped diff, session history, icon-only draggable
                     button, its right-click menu, palette, history and panel,
                     the Translate target's language table, and the decaying
                     per-action usage behind the derived *Most used* section
  markdown.ts        markdown → HTML; math extraction, mermaid, alerts, anchors
  html-preview.ts    sandboxed HTML guest: parse5 splice, iframe, bridge protocol
  html-source-map.ts host-side source offsets for the guest's text nodes
  html-bridge.js     guest-side scroll/click/keyboard bridge (inlined, not imported)
  html-language.ts   lazy CodeMirror HTML grammar
  asciidoc-language.ts AsciiDoc stream highlighter
  asciidoc-preview.ts Asciidoctor preview: registry, data-line markers, KaTeX
  asciidoc-render.ts shared Asciidoctor load/include and the pandoc export HTML
  latex-texmf.ts     local libraries, pure: bundled MEMFS namespace + manifest,
                     bibliography handoff, lookup names, origins, completion names
  latex-texmf-preferences.ts the Preferences › LaTeX library rows
  syntax-themes.ts   editor palettes: token colours and writing surface
  image-syntax.ts    the one image markup builder for Markdown, Typst, HTML and AsciiDoc
  images.ts          paste, drop and download of images; the four rules and the
                     untitled fallback
  paste/             rich paste: IR, destination/source detection, readers,
                     renderers (AsciiDoc included), HTML sanitizer and image resolution
  combo.ts           the shared searchable combobox: whole list on open, filter
                     while typing, accent and alias folding, fixed popup
  model-combo.ts     the AI Model field's picker, a thin wrapper over combo.ts
  fonts.ts           bundled typefaces, the four roles, the six detection presets
                     and the selectable Custom preset
  font-stacks.ts     CSS family quoting/parsing: exotic names, generic keywords,
                     the preset fallback tail
  font-picker.ts     searchable installed-family picker: grouped specimens, ARIA,
                     missing-family warning, fixed popup
  read-aloud.ts      sentence queue and voice choice; Web Speech or an injected
                     platform backend (Linux uses speech-dispatcher)
  system-speech.ts   the Linux `spd-say` backend and voice catalogue behind
                     read-aloud.ts
  preferences.ts     the Preferences panel and its declarative rows
  sidebar.ts         outline (active-marker updates) / favorites / recent files
  api.ts             typed wrappers over every Rust command
  highlight-theme.ts highlight.js theme swap, so code follows light/dark
  content.ts         the welcome, reference and shortcuts documents
  styles.css         all styling, light and dark
src-tauri/src/
  lib.rs             builder, plugin registration, command table
  html_preview.rs    preview scheme, CSP, path confinement, preview commands (+ tests)
  settings.rs        persisted settings, typography preset state and AppState
  fonts.rs           installed-family enumeration through fontique, session cache
                     and name normalisation (+ tests)
  ai/                OpenAI-compatible and Anthropic streaming, prompts, the
                     reader's ai-prompts.md (parser and generator), output-tag
                     filter, the token context budget, the reasoning-off field
                     and its test request, keychain/file/session credentials and
                     the AI commands
  speech.rs          Linux Read Aloud through speech-dispatcher: `spd-say -L`
                     parsing, speech/stop commands and their tests
  linux_webkit_env.rs pre-GTK Wayland/NVIDIA DMA-BUF workaround (+ tests)
  documents.rs       file IO, path existence, startup file
  recovery.rs        the crash-recovery journal, atomic per-entry files (+ tests)
  images.rs          image import: sniffing, sanitiser, dedup, download
  clipboard.rs       plain-text clipboard: one arboard handle, read/write commands
  tex_fmt.rs         tex-fmt's wasm, downloaded and hash-verified on first format
  latex_texmf.rs     registered local TEXMF libraries: configure/inspect/open
                     commands, bounded index, per-compile captured snapshot (+ tests)
  latex_native/wsl.rs TeX Live inside WSL: registry listing, explicit look-inside,
                     the `wsl.exe --exec env -i` launcher, wslpath (+ tests)
  tokens.rs          approximate token count for the status bar and AI context
  spellcheck.rs      OS spell checker: Windows ISpellChecker, Linux hunspell, macOS NSSpellChecker
  print.rs           hidden print surface, WebView2/WebKitGTK printing, PDF verification,
                     one temp folder per viewer handoff
  cancel_registry.rs cancel-by-id for AI requests and native LaTeX jobs, including
                     a Cancel that arrives before its job registers (+ tests)
  menu.rs            native menu construction, Open Recent, event routing, menu probes
scripts/             build helpers and CDP test harnesses — every one is in
                     "Repository scripts", and a new one belongs there too
samples/             fixtures the smoke test asserts against
samples/asciidoc-tour.adoc  AsciiDoc fixture and its include
samples/html-tour/   offline HTML guest fixture
docs/samples/   real documents used to judge rendering quality
docs/plans/          one file per approved plan
docs/adr/            one decision that outlives its change
docs/backlog.md      prioritized product gaps that do not have a plan yet
docs/icon/           master icon (`mdraft-icon.png`) that `build-icons.mjs` reads
```

Anything under `src/` or `src-tauri/src/` that you cannot place from this map is
probably in `main.ts`, which is the largest file and holds the shell: document
lifecycle, native menu routing, status bar, and pane sync.
