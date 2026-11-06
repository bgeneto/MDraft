# Integrate LaTeX as a first-class MDraft language

**Status:** in progress (approved 2026-11-06)

**Date:** 2026-11-06

**ADR:** three to write before merge — the settings shape for the LaTeX switch
and cache, the two-route PDF export contract, and generalising the PDF viewer
into a source-neutral component. None supersedes an existing ADR.

## Context and goal

The [LuaLaTeX PoC](2026-11-06-wasmtex-lualatex-poc.md) landed on
`feat/wasmtex-lualatex-poc` (commit `02a7200`): a saved `.tex` project compiles
locally with WasmTex's LuaLaTeX, real BibTeX runs, the existing PDF.js page
viewer draws the result, SyncTeX resolves line/region clicks, and a warmed cache
recompiles offline on Windows and Linux.

What that commit already gave the product — and what this plan must therefore not
re-describe as missing work:

- `.tex` is a recognised language: `languageFor` (`src/main.ts:2275`),
  `CANONICAL_EXTENSION.latex` (`src/paste/detect-document.ts:90`), open/save
  filters (`src/main.ts:2322`), recovery (`src/main.ts:7000`), and the
  `DocumentLanguage` union (`src/api.ts:607`).
- A hidden-window test mode, the `mdraft-tex` URI scheme with a verified
  download path, a bounded project snapshot, and verified SyncTeX navigation.

What a reader still sees, and what this change fixes:

- A `.tex` file opens as **plain text**: `setLanguage("latex")` installs `[]`
  (`src/editor.ts:980`). No colouring, no comment syntax, so Edit › Comment is
  disabled (`src-tauri/src/menu.rs:552`).
- The **Outline panel is wrong**: `refreshOutline` falls through to the Markdown
  ATX extractor (`src/main.ts:2209`).
- **Spelling** treats the whole source as prose: the skip rules are syntax-node
  names and Markdown/AsciiDoc regexes (`src/spellcheck.ts:52,267`).
- **Read Aloud** speaks the rendered preview (`src/main.ts:6483`), which for
  LaTeX is a PDF canvas — the feature is present and produces nothing.
- An **unsaved LaTeX draft is misclassified**. Content detection scores only
  HTML, Markdown, Typst and AsciiDoc (`src/paste/detect.ts:203`), so `suggestSave`
  falls back to the editor's language and Save As pre-fills `untitled.md` with the
  Markdown filter first (`src/paste/detect-document.ts:128`). Accepting it re-parses
  the buffer as Markdown through `languageFor` (`src/main.ts:2275`), and the menus
  then offer Markdown actions for a `.tex` file. The same gap makes rich paste
  convert clipboard content to Markdown inside an untitled LaTeX buffer
  (`resolvePasteDestination`, `src/main.ts:6900`).
- LaTeX cannot be the language of a **new** document: the Default File Extension
  list has no `.tex` option (`src/preferences.ts:1542`) and
  `defaultDocumentLanguage` maps only typ/html/adoc (`src/main.ts:2292`).
- **Insert/Format/Export/Print are disabled** by one blanket rule in two places
  (`src-tauri/src/menu.rs:523`, `src/main.ts:5966`), and `format.document`
  refuses with "LaTeX formatting is deferred in this experiment"
  (`src/main.ts:2595`).
- There is **no LaTeX Reference** in Help while Markdown, AsciiDoc and Typst each
  have one (`src-tauri/src/menu.rs:1196`, `src/content.ts:315`).
- The feature's on/off state is a **marker file outside `settings.json`**
  (`src-tauri/src/latex.rs:79,168`), invisible to Preferences, impossible to
  turn off, and — because `latex.rs` resolves `app_data_dir()` while the portable
  build overrides only `config` — it would not travel with a portable build.
- Export has no LaTeX path at all: `export.*` is disabled
  (`src-tauri/src/menu.rs:526`), and the only PDF is the preview's **Save PDF…**
  button.

The goal: LaTeX becomes a normal document language — same editing, same menu
honesty, same export story, same respect for offline use, installer size and the
reader's files — while the experiment's explicit opt-in, verified assets and
LuaLaTeX choice are preserved.

## Scope and non-scope

**In scope**

- Syntax colouring and comment support from a lazy stream grammar; folding only
  if a real fold service exists, otherwise the menu says why not.
- LaTeX-aware outline, spelling skips, filename suggestion, document language
  declaration, image syntax, link targets, and a Read Aloud answer (either a
  source-derived prose extractor or an explicit refusal with a reason).
- Content detection and the Default File Extension preference: an untitled LaTeX
  draft is recognised, Save As recommends `.tex`, and a new document can start in
  LaTeX.
- Insert/Format commands and their menu, context-menu and shortcut availability,
  item by item, replacing the blanket gate; Format Document through the existing
  formatter contract.
- Completion: local catalog, CodeMirror completion layer introduced for the
  first time in this editor, bounded and cancellable, network-free.
- One PDF export route for both PDF-rendered languages: the PDF their own compiler
  produced, reachable from `Export › PDF` and from the preview, with labels that
  name the engine and availability that never lies.
- The switch and its cache ceiling in `settings.json`, portable and backup
  friendly; cache eviction, size reporting and a clear-cache action in
  Preferences.
- Snapshot hardening: reference-following, binaries over the `mdraft-tex` scheme,
  symlinks skipped and reported instead of aborting the project.
- A LaTeX Reference document, user documentation, and the test layers named
  below.

**Out of scope**

- A pandoc PDF route for Typst or LaTeX. Both already compile their own PDF, so a
  second, differently-laid-out PDF behind the same document would mislead; see
  D1. Pandoc input readers for `.tex` (`-f latex`) go with it: a `.tex` document
  exports PDF, and every other pandoc target stays disabled for LaTeX.
- Any change to `src-tauri/src/export.rs`, including the Typst PDF short-circuit
  that is already documented there.
- Full Biber and complete `biblatex`; the `biblatex-lite` limitation stays
  documented, not fixed.
- A complete TeX Live installation, `tlmgr`, arbitrary TeX macro expansion for
  path discovery, remote build services.
- The AI assistant's `MARKUPS` list (`src/ai/actions.ts:75`): LaTeX is not added
  to "convert to" targets in this change.
- Native **printing** (`file.print`) for PDF-rendered languages: the PDF already
  exists, so printing stays disabled with its current explanation.
- Any new startup or background network request; any change to `productName`,
  `identifier`, the release workflow or the updater.
- macOS *support* with the same claim as Windows and Linux. The compile path is
  attempted there; if it cannot be verified in this change, the preview shows an
  explicit note instead of a scheme error, and the documentation says so.

## Decisions

Closed on 2026-11-06. Each decision names where it lands in code; the rationale
lives in [the plan review](../audits/latex-product-plan-review.md).

| # | Decision | Answer | Lands in |
| --- | --- | --- | --- |
| D1 | PDF routes | **Native only, for both languages.** The engine-compiled PDF is what the preview button and `Export › PDF` write. No pandoc route for Typst or LaTeX: each already produces a PDF with its own compiler, and a second, differently-laid-out PDF behind the same word would be a worse product. Pandoc keeps its current behaviour for Markdown, HTML and AsciiDoc, and the Typst short-circuit in `export.rs` stays untouched as a safety net. | `main.ts`, `menu.rs`, `api.ts` |
| D1b | Feel of `Export › PDF` | Writes the PDF the preview currently holds; refuses when those bytes are stale or absent, and the menu says why. It never starts a compile. | `main.ts`, `menu.rs` |
| D2 | Where the switch lives | **`settings.json`**, so a portable build and a settings backup carry it. The app-data directory holds cache only. | `settings.rs`, `latex.rs`, `preferences.ts`, `tauri.portable.conf.json` |
| D3 | Cache policy | LRU eviction to a user-set ceiling (default 256 MiB), size reported, clear-cache action, per-file digest where the mirror publishes one, `CACHE_LOCK` released around the download. | `latex.rs`, `preferences.ts` |
| D4 | Snapshot shape | Follow the references the document declares instead of copying the directory tree; serve binaries through `mdraft-tex`; skip and report symlinks. | `latex.rs`, `latex.ts` |
| D5 | Project root | The main file's directory, stated in Help; a reference escaping it is an error with a plain message, not a silent omission. | `latex.rs`, `docs/` |
| D6 | SyncTeX source | Public engine route (`--synctex`) first; the private worker `readfile` stays as a fallback behind a capability check and a pinned-SDK test. | `latex.ts`, `scripts/latex-poc-test.mjs` |
| D7 | Formatter delivery | A WASM build behind `src/format/formatters.ts`, reusing `formattedTransaction` and the stale-document rule — not a new Tauri command. | `formatters.ts`, new formatter module |
| D8 | Completion catalog | Bundled local data; no network path in the completion code. | new module |
| D9 | macOS | Verify, or gate with an explicit note. Never a silent scheme failure. | `latex.ts`, `main.ts`, docs |
| D10 | Menu state shape | One `pdfPreviewAvailable` flag, added beside the existing `typstAvailable` (which keeps gating the Typst preview rows), so the payload does not grow one field per language. | `api.ts`, `menu.rs`, `main.ts` |
| D11 | Printing | Stays disabled for Typst and LaTeX, with the existing reason. | `menu.rs` |
| D12 | AI `MARKUPS` | LaTeX stays out; recorded as non-scope. | — |
| D13 | Test membership | A new layer joins `npm test` after the PoC's harness change is reviewed on its own. | `scripts/test-all.mjs`, `AGENTS.md` |
| D14 | Rollback | Nothing is deleted automatically; Clear cache is the only destructive action and it is the reader's. | `preferences.ts`, `latex.rs` |
| D15 | Detection and the default language | LaTeX joins `scoreLatex` in content detection and the Default File Extension list, under the same conservative rule as the others: only a **clear lead** (`score ≥ 4`, lead `≥ 2`, the existing threshold) may override the editor's language, so prose that mentions `\LaTeX` once never flips a Markdown document. A LaTeX *source* on the clipboard is pasted as plain text, because no LaTeX paste converter is in scope. | `paste/detect.ts`, `paste/detect-document.ts`, `preferences.ts`, `main.ts` |

**D1b (freshness and availability):** `Export › PDF` writes the bytes the preview
currently holds and refuses with a toast when they are stale. It never starts a
compile from a menu command; a multi-second WasmTex or Typst run behind a menu
item is indistinguishable from a hang. The row is therefore **enabled only when a
current PDF exists** — always for LaTeX (its preview *is* a PDF), and for Typst
only in the Pages view, which is where the PDF is compiled. Otherwise the label
says why, e.g. `PDF… (available in Pages view)`; a disabled row with a reason is
the existing pattern (`menu.rs:632`) and keeps the "no dead UI" rule.

## Approach and rejected alternatives

**Highlighter.** `StreamLanguage.define(stex)` from `@codemirror/legacy-modes`,
declared as a direct dependency, loaded through the existing language
compartment and only for LaTeX documents. The chunk is already emitted because
`@codemirror/language-data` maps both "sTeX" and "LaTeX" to the same module, so
the incremental installer delta should be zero — to be measured, not assumed,
after the baseline runs. Attach `commentTokens: { line: "%" }` as language data
the way Typst does (`src/typst-language.ts:32`), which is what makes
Edit › Comment and the context menu honest. Folding has no mechanism in a stream
grammar: `canFold` stays false for LaTeX and the menu carries a reason, rather
than offering a control that does nothing.

**Completion.** First the layer, then the catalog. `@codemirror/autocomplete` is
already a dependency but only `closeBrackets` is imported (`src/editor.ts:42`);
there is no `autocompletion()` extension, no `completionKeymap`, and no popup
styling in `src/styles.css`. So the work is: the extension and its keymap
negotiated with `indentOnInput` and bracket closing, theming through
`buildChromeTheme` for every syntax palette, screen-reader and reduced-motion
behaviour, IME behaviour, and cancellation. The catalog is a bundled local file
(commands, environments, packages, cross-references read from the project
snapshot); nothing in the completion path may reach the network. A project index
runs in a cancellable worker and returns stale-tagged results that are dropped by
generation.

**Formatter.** A WASM build of tex-fmt behind the same interface as Typstyle:
`hasFormatter`, `formatDocument`, `formattedTransaction`, the snapshot check and
the one-undo contract live in `src/format/formatters.ts` and are proven by 47
unit and 143 UI checks. A Tauri command would put formatting in Rust, duplicate
the stale-document rule over IPC, and add a second place where a formatter can
fail. Default is no line wrapping; verbatim, `lstlisting`, `minted`, comments,
math, `tikz` and macro bodies either survive byte-identical or the document is
left unchanged with the existing error toast.

**PDF export.** One mechanism, one promise: the PDF the document's own compiler
produced. Each of these languages already writes a PDF with its engine — Typst
with `typst`, LaTeX with LuaLaTeX through WasmTex — so a second, pandoc-laid-out
PDF behind the same document would either contradict the preview or silently
produce a different document. Decision D1 therefore keeps the pandoc route for
Markdown, HTML and AsciiDoc only, and gives Typst and LaTeX a working **native**
row.

- `Export › PDF` and the preview's Save PDF… write the compiled bytes.
  `latex_save_pdf` is renamed to a language-neutral `save_compiled_pdf`, because
  it already serves both Typst Pages and LaTeX (`src/main.ts:1903`).
- `export.pdf` stops being `!typst` (`src-tauri/src/menu.rs:541`) and stops being
  denied for LaTeX (`:523`). The `"PDF… (use PDF via Typst)"` label goes away
  because it pointed at another row that now *is* this row; the printing label
  (`"Print… (use PDF via Typst)"`) is reworded to point at `Export › PDF`, since
  `file.print` stays disabled (D11).
- The narrow rule that replaces the blanket LaTeX gate: every `export.*` row
  except `export.pdf` stays disabled, `file.print` stays disabled, and the
  pandoc formats stay disabled — a `.tex` file has no pandoc reader in this
  change and must not be fed to pandoc's Markdown reader. The frontend keeps a
  guard in `exportWithPandoc` for a stale menu or a keyboard route, the same way
  it already guards a missing pandoc (`src/main.ts:3483`).
- Nothing changes in `src-tauri/src/export.rs`. Its Typst PDF short-circuit
  (`:529`) stays exactly as documented, and now doubles as a safety net if a
  stale route ever reaches it.
- Availability follows D1b: enabled only while a current PDF exists. For LaTeX
  that is every successful preview compile; for Typst it is the Pages view,
  because the Document view renders HTML and has no PDF bytes at all. The label
  explains the disabled state instead of leaving a live row that refuses.

Labels name the mechanism, both of them built in Rust: `PDF… (compiled by
LuaLaTeX)` for a `.tex` document and `PDF… (compiled by Typst)` for a `.typ`
one. Nothing is stored, so there is no migration and no reader-facing rename of
a format they own.

**Detection and the default language.** `detectTextSyntax` (`src/paste/detect.ts:203`)
is the one classifier behind "which markup is this unsaved buffer" — it feeds both
the Save As recommendation (`suggestSave`, `src/paste/detect-document.ts:128`) and
the paste destination (`resolvePasteDestination`). It scores four languages today;
LaTeX becomes a fifth scorer with line-anchored evidence: `\documentclass`,
`\begin{document}`/`\end{document}`, `\usepackage`, `\section{`, `\newcommand`,
`\begin{environment}` and `%` comment lines. The existing gate — `score ≥ 4` and a
lead of `≥ 2` over the runner-up (`src/paste/detect.ts:232`) — already prevents a
prose mention from deciding, and it must stay untouched: a wrong suggestion
re-parses the reader's buffer on first save (`src/paste/detect-document.ts:123`).

Two knock-on rules keep this honest. `suggestSave` then recommends `.tex` through
`CANONICAL_EXTENSION.latex`, and the chosen extension decides the document's
language through `languageFor`, so the menus follow the file the reader saved —
the live buffer is never silently re-parsed, which is the module's documented
invariant. And `chooseSource` (`src/paste/detect.ts:268`) must treat a LaTeX
clipboard as plain text, because `src/paste/` has no LaTeX reader or writer; the
`destination === "latex"` branch that already pastes natively becomes reachable
for unsaved buffers too. The Default File Extension list gains `LaTeX (.tex)` and
`defaultDocumentLanguage` gains its branch, so "New Document" can start in LaTeX
the way it already can in Typst.

**State and cache.** `latexEnabled` and a cache-ceiling setting join
`settings.json`; `AppState` keeps an in-memory mirror so the URI scheme handler
answers synchronously without parsing JSON per package request. Turning the
switch off stops the scheme serving assets and leaves the cache inert;
Preferences gains a row with the current size, the ceiling and Clear cache, using
a `latex_cache_info` command and the already-present-but-uncalled
`latex_stats` (`src-tauri/src/latex.rs:93`). `tauri.portable.conf.json` gains a
`data` entry beside its `config` entry so the cache follows the portable bundle
instead of landing in `%APPDATA%` (the schema documents `config`, `data`,
`localData`, `cache` and `log`; a bare `"."` root is explicitly unsafe).

**Snapshot.** `latex_project_snapshot` currently copies the whole directory tree
(256 files, 32 MiB each, 64 MiB total, depth 12), base64-encodes it and sends it
over IPC, where the frontend decodes it again on the main thread. It also aborts
the entire project on the first symlink anywhere below the root. The replacement
walks the references the document declares — `\input`, `\include`,
`\includegraphics`, `\bibliography`, `\addbibresource`, the grammar
`validateLatexReferences` already implements in `src/latex.ts:67` — reads only
those files, serves images and fonts through `mdraft-tex` instead of base64, and
skips a symlink with a named warning. A singular `ids` generation keyed on the
main file and the referenced set replaces the current revision list.

**Rejected alternatives**

| Candidate | Why not |
| --- | --- |
| `codemirror-lang-latex` 0.6.1 | AGPL-3.0-or-later against MDraft's MIT, plus peer and bundle costs that are not the installer delta. Needs a licensing decision the project has not taken. |
| `lang-tex` / `lezer-tex` | Deprecated, GPL-3.0-or-later, built on pre-1.0 CodeMirror. A fork, not a dependency. |
| `tree-sitter-latex` | A second parser ecosystem and a bridge, for folding and structure this plan can live without. Kept as a fallback if the stream grammar demonstrably fails. |
| `wasmtex/lsp` as the completion backend | The pinned SDK already ships the editor-neutral service, but adopting it here drags the compiler SDK into the editor's dependency graph for a catalog that must be local anyway; measure only if the bundled catalog proves insufficient. |
| A pandoc PDF route for Typst and LaTeX | Rejected by decision D1: both languages already write their own PDF, so a pandoc-laid-out second PDF behind the same document contradicts the preview and mislabels the mechanism. Considered and dropped after review. |
| Formatter as a `#[tauri::command]` | Duplicates the snapshot/stale contract over IPC and splits formatting across two languages. |
| A second PDF.js viewer for LaTeX | Duplicates page lifecycle, zoom, text layer and selection geometry; `showRegions` already exists. |

## Steps

Ordered so each step leaves the product consistent. Steps 1–4 are the bulk of the
user-visible gain; 5–7 need their own measurement before they are committed.

- [x] **1. Baseline.** `npm ci` (the `wasmtex` tarball is a GitHub release asset),
  record that `npx tsc --noEmit` is clean, record the sTeX chunk size and the
  before/after installer and memory numbers, note the Node 22 CI vs
  `engines: node >= 24` gap, and remove `.npmrc`'s inert pnpm key. Create
  `codex/latex-product-integration` from `02a7200` unless told otherwise.
- [x] **2. Grammar.** Lazy sTeX support, direct `@codemirror/legacy-modes`
  dependency, `commentTokens`, `canFold` stays false with a menu reason. Verify
  commands, braces, `%` comments, inline/display math, Unicode and tab switching.
- [x] **3. Language sites.** Outline extractor; spelling skips for LaTeX tokens,
  commands, verbatim bodies and `$…$`/`\[…\]`; filename suggestion from
  `\title{}` and the first prose line; `declaredLanguage` for babel/polyglossia;
  `imageSyntaxFor` → `\includegraphics`; `needsRelativePath`; `linkAt` for URLs,
  `\href`, `\input`, `\includegraphics`; Read Aloud refused with the HTML-style
  reason or fed by a source prose extractor. Content detection: `scoreLatex`,
  the fifth entry in `detectTextSyntax`, the plain-text rule in `chooseSource`,
  the `LaTeX (.tex)` Default File Extension row and `defaultDocumentLanguage`.
  Remove the two image gates that exist only because of the Markdown fallback
  (`src/main.ts:6338,6871`).
- [x] **4. Commands and menus.** Replace the blanket gate in `menu.rs:523` and
  `main.ts:5966` with item-by-item availability; implement Insert/Format/para
  actions in LaTeX syntax; rewrite the Rust test
  `latex_defers_markup_commands_but_keeps_plain_editing`; keep `format.document`
  disabled until step 5 lands. Update `menu-test.mjs` and `shortcut-test.mjs`.
- [ ] **5. Format Document.** Measure the tex-fmt WASM build against the corpus
  and the installer; integrate behind `hasFormatter`/`formatDocument`; extend the
  47 unit and 143 UI checks with LaTeX rows.
- [ ] **6. Completion.** The CodeMirror layer first (keymap, theme, a11y, IME),
  then the local catalog, the worker index, the stale-tag rule and the
  "no network" assertion. Ship behind the same availability rules as the other
  languages; nothing appears in the menu that cannot work.
- [ ] **7. The native PDF row.** `save_compiled_pdf` (renamed from
  `latex_save_pdf`) behind `Export › PDF` and the preview button; `export.pdf`
  enabled for Typst and LaTeX with `pdfPreviewAvailable` from D10 and the D1b
  availability rule; labels naming the engine; the two `(use PDF via Typst)`
  labels removed; the LaTeX gate narrowed to "everything except `export.pdf`";
  `exportPdf()` writes the compiled bytes for both languages instead of the
  print path or the "use the other route" modal; the stale/kbd guard in
  `exportWithPandoc`. No change in `export.rs`.
- [ ] **8. State, portable build and cache.** `latexEnabled` and the ceiling in
  settings, in-memory mirror for the scheme, `latex_disable` /
  `latex_cache_info` / `latex_clear_cache`, LRU eviction, lock released around
  the download, digest check where published, Preferences rows, portable `data`
  override.
- [ ] **9. Snapshot hardening.** Reference-following collection, symlink skip with
  a warning, binaries over `mdraft-tex`, generation-keyed invalidation, and the
  memory measurement from step 13 repeated after it.
- [ ] **10. Correspondence.** Bidirectional Sync Scroll for LaTeX as a second
  implementation behind the viewer's interface, fail-closed on ambiguity, with
  the same Escape, blink and no-selection-stealing rules as Typst.
- [ ] **11. SyncTeX source.** Public engine route first; capability-checked
  fallback; a pinned-SDK test that fails when the shape changes.
- [ ] **12. Documentation.** `samples/latex-reference.tex` and a Help entry;
  `docs/latex.md` replacing `docs/latex-poc.md`; README language list and network
  policy; `AGENTS.md` (scripts, Testing layers, traps); `docs/backlog.md`.
- [ ] **13. Measurement.** First and warm compile, p95 typing latency, memory,
  installer delta, cache size, cold start — against the PoC baseline, on Windows
  and Linux, plus the macOS note.
- [ ] **14. ADRs and close.** Write the three ADRs, update this plan's status and
  record every deviation here.

## Deviations recorded while implementing

- **Step 1, `.npmrc`.** The pnpm-only `allow-remote=root` key was left in place:
  npm ignores it, and removing it is a separate housekeeping change that would
  ride in this branch for no benefit. Recorded here rather than done.
- **Step 1, baseline numbers.** `npx tsc --noEmit` is clean and the sTeX chunk is
  3,092 B (already emitted by `@codemirror/language-data`), so the incremental
  installer delta for the grammar is zero. Installer and memory numbers are
  deferred to step 13, which is where the plan already measures them.
- **Step 1, Rust suite.** `cargo test` reports 250 passed / 60 failed on this
  host, and the identical 250/60 on the untouched `02a7200` tree: every failure
  is `Os { code: 5, PermissionDenied }` from a test that creates a directory under
  `std::env::temp_dir()`. It is an environment problem, not a regression, and it
  is recorded in `AGENTS.md` under Traps.
- **Step 2, `canFold`.** No Rust change was needed: `menu.rs` already gates the
  fold rows on `state.can_fold`, and `main.ts` already computes it from the
  document language with LaTeX absent. The menu therefore says nothing about
  folding for LaTeX, which is the "no dead UI" outcome the plan wanted.
- **Step 3, Read Aloud.** Refused with a reason rather than fed by a prose
  extractor: a LaTeX preview is a PDF canvas, and the reader walks paragraph
  elements that a canvas does not have. The refusal is the plan's sanctioned
  alternative.
- **Step 3, one helper.** `languageFor` and `defaultDocumentLanguage` now delegate
  to `languageForExtension` in `src/paste/detect-document.ts`, and
  `documentFilters` builds its extension lists from the same `LANGUAGE_EXTENSIONS`
  table, so the dialog cannot offer a name the opener would read as Markdown.
- **Step 4, `export.html` and `export.pdf.browser`.** The blanket LaTeX gate used
  to disable these implicitly. They are now disabled explicitly, because HTML
  export and the browser print route both go through pandoc, which has no `.tex`
  reader in this change. They come back with the native PDF row in step 7.
- **Step 4, `apply_export_availability`.** It now reads the cached
  `LAST_MENU_STATE` so a pandoc row cannot be re-enabled for a `.tex` document by
  a later availability report, which would have left a live row that reaches
  pandoc's Markdown reader.

## Files and modules

Frontend:

- `src/editor.ts` — the language compartment, comment data, `canFold`.
- `src/latex-language.ts` (new), `src/latex-completion.ts` (new) — grammar and
  completion, both lazy.
- `src/latex.ts` — snapshot consumption, `validateLatexReferences`, the
  reference-following index, SyncTeX access.
- `src/main.ts` — gates, commands, preview, PDF routes, Read Aloud, menu state,
  `defaultDocumentLanguage` and the Save As filters.
- `src/sidebar.ts` — `extractLatexHeadings`.
- `src/spellcheck.ts` — LaTeX skip nodes and ranges.
- `src/filename.ts`, `src/language.ts`, `src/image-syntax.ts`, `src/links.ts` —
  the per-language branches.
- `src/paste/detect.ts`, `src/paste/detect-document.ts` — the LaTeX scorer, the
  fifth entry in `detectTextSyntax`, and the plain-text rule for a LaTeX source.
- `src/format/formatters.ts` (new LaTeX formatter module beside it) — the
  `hasFormatter`/`formatDocument` contract.
- `src/api.ts` — `save_compiled_pdf` (renamed), `latex_disable`,
  `latex_cache_info`, `latex_clear_cache`, `MenuState.pdfPreviewAvailable`.
- `src/preferences.ts` — the LaTeX section (switch, cache size, ceiling, Clear
  cache) and the `LaTeX (.tex)` row in Default File Extension.
- `src/content.ts` — the bundled Reference.

Rust:

- `src-tauri/src/latex.rs` — settings-driven enablement, reference-following
  snapshot, cache LRU and reporting, scheme gating.
- `src-tauri/src/settings.rs` — `latexEnabled` and the cache ceiling.
- `src-tauri/src/menu.rs` — the native `export.pdf` row for both languages, its
  availability and labels, the narrowed LaTeX gate, the rewritten unit test.
- `src-tauri/tauri.portable.conf.json` — the `data` override.

Deliberately untouched: `src-tauri/src/export.rs`. The pandoc route keeps its
Markdown/HTML/AsciiDoc contract, its Typst PDF short-circuit and its tests.

Fixtures, tests, docs: `samples/latex-poc/` (keep), `samples/latex-reference.tex`
(new), `scripts/latex-*.mjs`, `docs/latex.md`, `AGENTS.md`, `docs/backlog.md`,
`README.md`.

## Risks and rollback

- **The private worker read.** SyncTeX is obtained through an undocumented
  `postMessageWithResponse({cmd:"readfile"})` on the pinned SDK. Mitigated by
  D6 and step 11; until then the code fails closed with a named error.
- **Supply chain.** `npm ci` depends on a GitHub release asset; the lockfile pins
  the digest but not its existence, and the package declares Node 24 while the
  release workflow uses 22. Mitigated by recording both in step 1 and adding a CI
  check that the tarball resolves.
- **Dependency overrides.** `package.json` forces `wasmtex`'s `pdfjs-dist` peer to
  MDraft's 6.4.299; an SDK upgrade can break the viewer silently.
- **Formatter damage.** A formatter that rewrites verbatim or math is worse than
  no formatter. The corpus test and the "left unchanged" rule are the guard.
- **Completion cost.** A project index that runs on the main thread would undo
  the preview work. Worker, generation tags and cancellation are part of the
  step, not a follow-up.
- **Correspondence.** SyncTeX maps one region to several lines; the existing
  `latexSourceAt` fail-closed rule extends to scroll.
- **Cache.** Eviction can delete a file a compile needs; the size check must run
  before the download, not after, or a cold compile fails opaquely.
- **Portable/backup.** Any state written outside the settings directory escapes a
  backup; D2 and the portable `data` override are the answer, and the plan's
  rollback never deletes the reader's cache without an explicit action.
- **macOS.** Unverified until step 13; the preview must say so.

**Rollback** is a branch revert. `settings.json` keys are additive with defaults,
so an older build loads the same file; the cache directory stays inert and is
removable from Preferences; no document, bibliography or cache is deleted by the
change itself.

## Tests and validation

New or extended layers, named before the work starts because the counts are a
contract:

- `latex:unit` — grammar token categories, comment data, completion ranges and
  snippet insertion, UTF-16 and 1-based conversion, stale replies, cancellation,
  "completion never touches the network", reference-following index.
- `latex:format:unit` — verbatim/`lstlisting`/`minted`, comments, math, macros,
  `tikz`, tables, CRLF/BOM, no wrapping, idempotence, refusal on malformed input,
  undo.
- `latex:sync:unit` (exists) plus the scroll-correspondence cases.
- Extend: `menu` (123), `shortcuts` (47), `syntax` (10), `format:document`
  (47 unit + 143 UI), `paste:convert` (397), `paste` (87), `image:rules` (43),
  `links` (18), `read-aloud-unit` (106), `filename:unit` (76), `preview:zoom`
  (24), `export` (40).
- `paste:convert` gains the detection cases: a LaTeX document is recognised; a
  Markdown document that merely mentions `\LaTeX` is **not**; the score and lead
  gates hold at the boundary; `suggestSave` recommends `.tex` for an untitled
  LaTeX buffer and keeps the reader's own extension when the content agrees with
  the Default File Extension preference; a LaTeX clipboard is pasted as plain
  text. `defaultDocumentLanguage` (`src/main.ts:2290`) and `languageFor`
  (`:2273`) currently encode the same extension→language mapping twice; both
  delegate to one helper beside `CANONICAL_EXTENSION` in
  `src/paste/detect-document.ts`, which is what puts the mapping under
  `paste:convert` instead of an untested app entry point.
- Real hidden Tauri runs on Windows and Linux: main + included chapter, image,
  `fontspec`, real BibTeX, PDF save through the menu row **and** the preview
  button with byte equality, failure preservation, SyncTeX navigation, both
  directions of click and scroll, a warmed restart with traffic blocked and an
  uncached positive control, and a `latexEnabled`-off run proving the scheme
  refuses.
- Add the new layer to `scripts/test-all.mjs` (D13) with the harness change
  reviewed separately, and update every count in `AGENTS.md` in the same change.

The one measurement that proves the change works: on the fixture project, a cold
and a warm compile complete, `Export › PDF` and Save PDF… produce identical bytes
for the same compile, the writes land atomically, and typing latency stays within
the PoC baseline.

## Acceptance criteria

- A `.tex` document opens coloured, with comment toggling, a correct outline, no
  spelling marks inside commands or verbatim, no Read Aloud control that cannot
  speak, and a Save-As name drawn from `\title{}` or the first prose line.
- An **untitled buffer containing a LaTeX document** is offered `.tex` by Save As,
  and accepting it makes the document LaTeX: the menus, the preview and the
  language of the next paste all follow the file that was saved. A Markdown
  document that mentions a LaTeX command once is not reclassified. "New Document"
  can start in LaTeX by choosing the `LaTeX (.tex)` default extension.
- Insert, Format and paragraph commands insert LaTeX syntax; the same commands
  are re-enabled for the other languages when the tab changes; nothing that
  cannot work is enabled, and what is disabled says why.
- Format Document formats a document, refuses verbatim-changing output, and one
  undo restores the original bytes.
- Completion offers commands, environments, packages and project references from
  local data only, and typing never triggers a network request.
- `Export › PDF` writes exactly the compiled PDF for a `.tex` project and for a
  `.typ` document, with Save PDF… producing identical bytes; the label names the
  engine that produced them; the row is disabled with a reason when no current
  PDF exists (Typst Document view) and is never the reason a compile starts; no
  pandoc row is offered for either language.
- `latexEnabled` and the cache ceiling survive in `settings.json`; a portable
  build carries the switch and the cache beside the executable; Preferences
  reports the cache size and clears it.
- With the switch off, the scheme refuses every request and no download occurs.
  With it on, opening another markup performs no LaTeX request.
- Sync Scroll works both ways when enabled, an ambiguous region paints nothing,
  and Escape cancels. Clicking a PDF location never takes the editor's selection.
- The measured first/warm compile, typing latency, memory and installer delta are
  recorded against the PoC baseline, and macOS either passes or shows an explicit
  note.

## Open questions

- **Cache ceiling default.** 256 MiB as today, adjustable in Preferences. If no
  answer, 256 MiB stands and Clear cache is the escape hatch.
- **macOS verification window.** If no macOS machine is available for step 13,
  the preview ships gated with a note and the documentation says "Windows and
  Linux"; the gate is removed when the verification exists.
- **Typst Document view and the PDF row.** Decision D1b disables `Export › PDF`
  there, because the Document view compiles HTML and holds no PDF bytes. The
  alternative — compiling a PDF on demand from the menu — was rejected with the
  freshness rule, but if readers report the disabled row as a nuisance, the fix
  is a separate, visible "Compile PDF" action, not a silent compile behind
  Export.
