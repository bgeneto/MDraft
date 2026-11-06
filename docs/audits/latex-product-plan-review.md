# Review: the LaTeX product-integration plan against this codebase

**Subject:** [docs/plans/2026-11-06-latex-product-integration.md](../plans/2026-11-06-latex-product-integration.md) (status `draft`)
**Reviewed:** 2026-11-06, checkout `feat/wasmtex-lualatex-poc` at `02a7200`, tree clean.
**Method:** read-only inspection of the plan, the committed PoC (`02a7200`), the
frontend and Rust dispatch sites, the test harness and the packaging metadata.
No build was run beyond `npx tsc --noEmit`, which fails for a dependency reason
recorded in §1.

## Verdict

The plan is careful where care is cheap — the alternatives table carries size and
licence evidence, SyncTeX is told to fail closed, and "no network merely by
typing" is stated as a rule. What it does not do is describe *this* repository.

Three things are true of the current tree and not of the plan:

1. `/\.tex$/i` is already a recognised language in the product
   (`src/main.ts:2275`, `src/paste/detect-document.ts:90`, `src/main.ts:2322`,
   `src/main.ts:7000`). The plan's opening claim — "LaTeX currently has no syntax
   colouring, completion or formatter … markup commands are deferred" — is
   accurate about the *features* and misleading about the *integration*: the
   remaining work is a specific list of dispatch sites, not a greenfield.
2. Two of the four "reuse" pillars are not what the plan says they are. There is
   **no completion UI anywhere in the editor** (`@codemirror/autocomplete` is
   imported only for `closeBrackets`, `src/editor.ts:42`; no `autocompletion()`
   extension, no popup styling in `src/styles.css`), and the "existing PDF
   viewer" is `TypstPdfPreview`, whose bidirectional scroll correspondence is
   Typst-map-specific.
3. The branch does not build as checked out, so the plan's first step ("record
   the baseline") has no baseline to record until dependencies are installed.

The plan reads as a PoC extension plan. It needs to become an integration plan
with a closed list of dispatch sites, four decisions made rather than deferred,
and a test-layer budget.

## 1. Claims that do not hold in this checkout

**1.1 "Connect them through … the existing CodeMirror completion APIs" (Approach).**
There is no completion infrastructure to connect to. `package.json:89` declares
`@codemirror/autocomplete`, but the only import is
`closeBrackets, closeBracketsKeymap` (`src/editor.ts:42`); no extension calls
`autocompletion(...)`, `completionKeymap` is absent, and `src/styles.css` has no
`.cm-tooltip-autocomplete` rule. Introducing completion therefore means, for the
first time: the extension and its keymap (Tab/Enter interplay with
`indentOnInput` and `closeBrackets`), popup theming for every syntax palette
(`buildChromeTheme`, `src/editor.ts:943`), screen-reader and reduced-motion
behaviour, IME interaction, and the "no dead UI" note when a catalog is missing.
That is a sub-project, and it is the step most likely to slip.

**1.2 The baseline cannot be established without installing a GitHub tarball.**
`wasmtex` is declared at `package.json:114` and locked at `package-lock.json:5861`,
but `node_modules/wasmtex` is absent. `npx tsc --noEmit` fails:

```
src/latex.ts(3,38): error TS2307: Cannot find module 'wasmtex/headless'
src/latex.ts(4,49): error TS2307: Cannot find module 'wasmtex/synctex'
src/typst-pdf.ts(28,34): error TS2307: Cannot find module 'wasmtex/synctex'
```

Consequences the plan has to own, because a product release depends on them:

- `npm ci` in CI now requires a GitHub release asset
  (`…/releases/download/snapshot-f85a1d3cec1c0598/wasmtex-optional-monaco-d6a39bc.tgz`).
  A release asset can be deleted or replaced; the lockfile `integrity`
  (`sha512-IYYMZmFC…`) catches replacement but not disappearance.
- The package declares `"engines": {"node": ">=24"}` while
  `.github/workflows/release.yml:86` and `quality.yml:30` use Node 22. npm only
  warns, but the PoC's own install therefore happened on a newer Node than the
  release build uses.
- The PoC commit added `.npmrc` containing `allow-remote=root` — a **pnpm** key
  (this repo uses npm, per `AGENTS.md`), so it is inert noise that should be
  removed or explained.
- The plan's stated `wasmtex/lsp` probe results (316,985 B / 81,146 B gzip,
  `\doc` → `\documentclass`) cannot be reproduced in this checkout, because the
  package is not installed. State them as *pending re-verification after
  `npm ci`*, not as established evidence.

**1.3 "The existing PDF viewer" overstates the reuse.**
`src/typst-pdf.ts:28` type-imports `PdfLocation` from `wasmtex/synctex`, and
`showRegions` (`:1023`) is the only LaTeX-facing entry point. Everything the plan
calls "complete … bidirectional Sync Scroll" — `scrollAnchorsNear`,
`scrollAnchorsAt`, `scrollTopFor`, `measureScrollRegions` (`:486–:608`) — is built
on `ScrollIndex`/`ScrollRegion` from the Typst page map. LaTeX needs a *second*
correspondence implementation (SyncTeX regions ↔ scroll offsets ↔ source lines),
including the region-selection rule that `scroll-sync.ts` already solved for
Typst. The plan budgets one bullet for it; it is the largest single piece of new
frontend work in the change, larger than highlighting and completion together.

**1.4 The sTeX size argument is right but unverified, and the folding claim needs
a mechanism.** `@codemirror/legacy-modes` 6.5.5 resolves through
`@codemirror/language-data`, which maps both "sTeX" and "LaTeX" to
`mode/stex.js` (`node_modules/@codemirror/language-data/dist/index.js:836,846`),
so a dynamic import of that specifier shares the chunk already emitted for fenced
code — the plan's near-zero-delta argument is sound. What it does not say is
*why* folding cannot follow: `StreamLanguage` produces a flat token stream with
no nesting, so `foldGutter()` (`src/editor.ts:745`) and
`view.foldCurrent|foldAll` (`src-tauri/src/menu.rs:581`) have nothing to fold
unless a `foldService` is written. Since `canFold` is a hard-coded language list
(`src/main.ts:759`), leaving `latex` out is the honest answer, and the menu needs
a reason string rather than an enabled no-op (`AGENTS.md`, "No dead UI").

## 2. The dispatch sites the plan omits

Every entry below is work the plan's Files-and-modules section does not list and
its Steps do not name. Each is a place where a `.tex` document silently gets
another language's behaviour today.

| Site | Today | Needed |
| --- | --- | --- |
| `src/editor.ts:980` | `setLanguage("latex")` installs `[]` — plain text | Lazy `StreamLanguage.define(stex)` + `commentTokens` so `edit.comment` (`menu.rs:552`) works |
| `src/sidebar.ts:8` + `src/main.ts:2209` | Outline falls through to `extractHeadings`, the **Markdown ATX** extractor — the Outline panel is empty or wrong for `.tex` | `extractLatexHeadings`: `\part`, `\chapter`, `\section*?`, `\subsection`, `\paragraph`, `\addcontentsline`, `%` comments, `\begin{document}` boundary |
| `src/spellcheck.ts:52,267` | Skips are syntax-node names plus a regex list; a `StreamLanguage` yields stream token names. `$…$`/`\[…\]` skips collide with real LaTeX (`\\[2pt]` is a line break, `\%` is a percent sign) | LaTeX token names in `SKIP_NODES`, LaTeX-specific skip ranges for `\command[opt]{arg}`, verbatim/`lstlisting`/`minted` bodies; `ALLOWED` (`:35`) already has `latexmath` but not `latex`/`lualatex`/`biblatex` |
| `src/read-aloud.ts` via `src/main.ts:6483` | Read Aloud speaks the **rendered preview**; the LaTeX preview is a PDF canvas, so it has no prose | Either a LaTeX prose extractor from source, or an explicit refusal worded like the HTML branch (`main.ts:6487`) |
| `src/language.ts:202` | `declaredLanguage` returns `null` for latex | `\documentclass[...]{…}` babel/polyglossia, `\usepackage[<lang>]{babel}` — the same "author outranks the guess" rule |
| `src/filename.ts:117,256` | No latex branch: Save-As pre-fill and `\title{}` metadata use Markdown/HTML rules | `\title{}`, first prose line, `%` comments, structural-line skip; extend `filename:unit` (76 checks) |
| `src/image-syntax.ts:24,43` | `imageSyntaxFor` falls through to `![](…)` and `needsRelativePath` is false | `\includegraphics[width=\linewidth]{…}`; the two gates at `main.ts:6338` and `main.ts:6871` exist precisely because this fallback would emit Markdown into a `.tex` file |
| `src/links.ts:345` | `linkAt` has html/typst branches only | LaTeX URL/`\href`/`\includegraphics`/`\input` targets, so Ctrl+click and Navigate › Open Target stay honest |
| `src/format/formatters.ts:173,181` | Allow-list plus `formatDocument`; no latex route | Whatever formatter wins, routed through `formattedTransaction` (`:206`) and the stale-doc rule (`:241`) |
| `src/ai/actions.ts:75` | `MARKUPS` omits latex, so "convert to LaTeX" is impossible | Include it or record the exclusion as non-scope |
| `src-tauri/src/menu.rs:523` | Blanket `Some(false)` for `format.*`, `insert.*`, most `para.*`, `export.*`, `file.print` | Item-by-item availability; the Rust test `latex_defers_markup_commands_but_keeps_plain_editing` (`menu.rs:1714`) must change with it, as must `menu-test.mjs` and `shortcut-test.mjs` |
| `src/main.ts:5966` | Duplicate gate plus the toast "LaTeX editing commands are deferred" | Removed in the same commit that closes `menu.rs`, or the two disagree |
| `src/paste/detect.ts:203,232,268` | `detectTextSyntax` scores only HTML/Markdown/Typst/AsciiDoc, so an unsaved LaTeX buffer is classified as Markdown | A fifth `scoreLatex` with line-anchored evidence, under the existing `score ≥ 4`, lead `≥ 2` gate; `chooseSource` must then treat LaTeX source as plain text (no LaTeX paste converter exists) |
| `src/paste/detect-document.ts:128` | `suggestSave` therefore never recommends `.tex`: an untitled LaTeX draft pre-fills `untitled.md` and becomes Markdown on acceptance, so the menus switch to Markdown for a `.tex` file | `.tex` through `CANONICAL_EXTENSION.latex`, plus one extension→language helper shared with `languageFor` (`main.ts:2273`) and `defaultDocumentLanguage` (`:2290`), which encode the same mapping twice today |
| `src/preferences.ts:1542` | Default File Extension offers md/markdown/txt/typ/html/adoc/asciidoc — no `.tex`, and `defaultDocumentLanguage` has no latex branch | A `LaTeX (.tex)` row, so "New Document" can start in LaTeX the way it can in Typst |
| `src-tauri/src/menu.rs:1194`, `src/content.ts:315` | Help has Markdown, AsciiDoc and Typst references; no LaTeX reference | `samples/latex-reference.tex` imported `?raw` + `help.latexReference`, matching the existing three |

Two cross-cutting notes on this list:

- The `menu_state` payload (`src/api.ts:701`) is a **public contract** by
  `AGENTS.md`'s definition. `canFormat`, `canFold` and `hasCommentSyntax` change
  meaning for LaTeX; `typstAvailable` has no LaTeX analogue even though the plan
  adds an optional 10 MiB download. Either add a field (`latexAvailable`) or
  reuse the settings-backed path — but decide, because `menu-test.mjs` reads it.
- `docs/backlog.md`, `README.md` (the product description lists four languages)
  and the `AGENTS.md` Testing table are untouched by the plan's file list, and
  the table has no LaTeX layer: `latex:sync:unit` and `latex:poc` appear only in
  the npm-scripts table (`AGENTS.md:246`), not in `scripts/test-all.mjs`.

## 3. Decisions the plan leaves open

**3.1 What Export does for a `.tex` file — decided 2026-11-06: native only, both
languages.** `Export › PDF` and the preview's Save PDF… must both exist for Typst
*and* LaTeX, and both write the PDF that language's own compiler produced. A
pandoc PDF was considered and **rejected**: each language already generates its
own PDF, so a second, differently-laid-out PDF behind the same document would
contradict the preview and mislabel the mechanism. Consequences the plan records:

- `export.pdf` is disabled for Typst (`menu.rs:541`) **and** for LaTeX
  (`menu.rs:526`); both gates open, and the conditional labels
  `"PDF… (use PDF via Typst)"` / `"Print… (use PDF via Typst)"` (`menu.rs:632`)
  disappear. `menu-test.mjs` asserts that tree and changes with it.
- The LaTeX gate becomes narrow rather than blanket: every `export.*` row except
  `export.pdf` stays disabled, and `file.print` stays disabled, so no `.tex` file
  is ever handed to pandoc's **markdown** reader (`export.rs:548–:552`) — which
  would otherwise produce a plausible, wrong PDF with no error. A frontend guard
  in `exportWithPandoc` covers a stale menu or a keyboard route, the same way it
  already guards a missing pandoc (`main.ts:3483`).
- `src-tauri/src/export.rs` is deliberately untouched: its Typst PDF
  short-circuit (`:529–:535`) stays as documented and, for a Typst document,
  still returns the compiled PDF if any route reaches it.
- Labels are built in Rust and name the engine (`PDF… (compiled by LuaLaTeX)` /
  `… Typst`). Nothing is stored, so the persisted-`export_formats` problem
  (`settings.rs:505`, defaulted only at `:658`) and the migration it would need in
  `parse_settings` (`settings.rs:878`) both fall away.
- Availability and freshness (**D1b**). Both buttons already refuse stale bytes
  (`latexCurrent` `main.ts:1370`, `typstPdfToken` `main.ts:1888`); the menu row now
  mirrors that instead of offering a live control: enabled while a current PDF
  exists — always for LaTeX, only in Typst's Pages view, because the Document view
  compiles HTML and holds no PDF bytes at all. Otherwise the label says why. It
  never starts a compile: a multi-second engine run behind a menu item is
  indistinguishable from a hang.

Out of scope by the same decision: pandoc **input** for `.tex`. `export.rs` has
readers for html and asciidoc only, and adding `-f latex` (plus the scratch
project a multi-file document needs) is not justified while the native PDF route
exists.

**3.2 Where "enabled" lives — the question, restated.** Today the whole state of
the feature is one empty-ish file: `install_latex` downloads the eight assets,
then writes `«appDataDir»/wasmtex-poc-2025/enabled` containing
`wasmtex-poc-2025\n` (`latex.rs:168`); `latex_status` answers "does that file
exist?" (`latex.rs:79`); and `serve` refuses every request without it
(`latex.rs:231`). Nothing else stores the choice — `settings.json` has no LaTeX
key at all.

That is the problem in three sentences: the switch is a **second settings store**
that `save_settings`, the migration rules and the portable build do not know
about; it has **no off switch** (there is no `latex_disable`, so a reader who
wants the 10 MiB download and up to 256 MiB of cache gone must find the folder by
hand); and it is **invisible** — Preferences cannot show what was downloaded or
how much space it takes, while the counters that could (`latex_stats`,
`latex.rs:93`) have no caller. The render path then pays an IPC call for it on
every debounce tick (`main.ts:1540`), where the Typst analogue is cached once and
mirrored into the menu (`typstAvailable`, `main.ts:792`).

The decision is therefore: **(a)** move the switch into `settings.json` (for
example `latexEnabled` plus a cache-size ceiling), leave the directory as pure
cache, and add Preferences rows for Enable/Disable and "cache size, clear";
**(b)** keep the marker file and add `latex_disable` / `latex_cache_info` /
`latex_clear_cache` around it; or **(c)** leave it as the PoC has it. (a) is
recommended, with one nuance: the scheme handler must answer synchronously, so
keep an in-memory flag refreshed by `save_settings` rather than reading the JSON
per package request.

**3.3 Cache behaviour under pressure.** Three concrete defects a product pass
should fix, all in `latex.rs:256–:278`:

- `CACHE_LOCK` is held across `download()`, serialising every mirror fetch for up
  to 32 MiB. The engine issues synchronous requests for missing files (see the
  PoC plan), so this is on the critical path of a cold compile.
- `cache_size()` re-walks the whole tree on every miss, and runs **after** the
  download — so a full cache downloads up to 32 MiB and then refuses.
- There is no eviction: `MAX_CACHE` is enforced by failing the package request
  (`:272`), which turns a full cache into an unexplained compile failure. The
  plan's "bounded cache" needs an eviction policy and a user-visible size.

**3.4 The snapshot is bigger than it needs to be.** `collect` copies the whole
directory tree — up to 256 files / 64 MiB (`latex.rs:24–:28`) — base64-encodes it
(`latex.rs:443`) and sends it over IPC, where `compileLatex` decodes it again on
the main thread (`latex.ts:131`). The peak cost for a large project is therefore
something like 3–4× the project size in JS strings and typed arrays, on the
thread that must keep typing responsive — and the plan's memory budget is
mentioned only inside a benchmark bullet. Two better shapes:

- build the snapshot from the references `validateLatexReferences`
  (`latex.ts:67`) already walks, instead of from the directory listing; and
- serve binary assets (images, fonts, PDFs) through the existing `mdraft-tex`
  scheme instead of base64 over IPC — the CSP already permits it
  (`src-tauri/tauri.conf.json:28`).

Related, and cheap: `collect` aborts the **entire** project when it meets one
symlink anywhere below the root (`latex.rs:348`). A `build/` directory with a
junction makes the whole document uncompilable. Skipping the link (and recording
it) is the product behaviour.

**3.5 The private worker read is the weakest runtime dependency.** SyncTeX is
obtained through
`engine.tex.postMessageWithResponse({cmd:"readfile", url:…synctex.gz})`
(`latex.ts:199–:215`), an undocumented internal of the pinned SDK, with the
SDK's public LuaLaTeX result deliberately bypassed (`docs/latex-poc.md:28`).
Every other risk in the plan is bounded by configuration; this one is bounded by
a vendor's private class shape. The plan should name it as a risk with a
fallback (pass `--synctex` through the engine invocation) and add a pinned-SDK
test that fails loudly when the shape changes — the current code throws
`"This WasmTex build cannot read LuaLaTeX SyncTeX output."`, which is correct but
only discovered at compile time by the reader.

**3.6 macOS is silently excluded.** The PoC verified Windows x64 and Linux x64;
`src-tauri/tauri.macos.conf.json` exists, so the product ships there. The plan's
acceptance criteria say "on Windows and Linux" and never mention what a macOS
reader sees. Decide: verify there, or gate the preview with an explicit note (the
HTML and missing-Typst notes are the precedent) rather than a 404 from the scheme
handler.

**3.7 Rollback leaves an orphan.** "Roll back … without removing user settings,
files or caches" is right for the user's data, but the app-data directory
(`wasmtex-poc-2025/`) then stays behind with up to 256 MiB and no UI to remove
it, after the feature is gone. Either ship the cache-clear command *before*
adoption, or have rollback delete only the marker file.

**3.8 Decisions — all closed on 2026-11-06.** D1 is answered in §3.1 (native PDF
only, for both languages), D2 in §3.2 (`settings.json`). The answers below are
the ones recorded in
[the plan](../plans/2026-11-06-latex-product-integration.md#decisions); this
table is the audit trail, not an open list.

| # | Decision | Options considered | Answer |
| --- | --- | --- | --- |
| D2 | Where the LaTeX switch lives (§3.2) | `settings.json` key; marker file + commands; leave as is | **`settings.json`**, so a portable build and a settings backup carry it, with an in-memory flag for the scheme handler |
| D3 | Cache policy | fixed 256 MiB hard-fail; LRU eviction to a user-set ceiling; no bound | **LRU** to a ceiling in Preferences, per-file digest where the mirror publishes one, lock released around the download |
| D4 | Snapshot shape | whole directory as base64 over IPC; reference-following; binaries over the `mdraft-tex` scheme | **reference-following**, binaries over the scheme, symlinks skipped and reported instead of aborting |
| D5 | Project root | the main file's directory (today, `latex.rs:393`); a chosen root; anything under the filesystem | **main file's directory**, stated in Help, with a clear error when `\input` escapes it |
| D6 | SyncTeX source | private worker `readfile` (`latex.ts:199`); `--synctex` through the engine invocation | **public route first**, the private one as a capability-checked fallback with a pinned-SDK test that fails loudly |
| D7 | Formatter delivery | new `#[tauri::command]` around the tex-fmt crate; a WASM build like Typstyle (`src/format/formatters.ts:71`) | **WASM build**, because formatting is already a frontend concern with a stale-doc rule a command would have to reinvent |
| D8 | Completion catalog | bundled local file; `wasmtex/lsp` with an on-demand package index; network | **bundled local**, no network path in the completion code at all |
| D9 | macOS | verify the compile path; ship gated with a note; ship untested | **verify, or gate** with the same kind of note as the missing-Typst pane |
| D10 | `menu_state` shape | add `latexAvailable`; derive from settings; reuse `typstAvailable` | **one `pdfPreviewAvailable`** shared by both languages |
| D11 | Printing | keep `file.print` disabled for pdf-rendered languages; enable it through the native HTML path | **keep disabled** with the existing explanation |
| D12 | AI `MARKUPS` | add LaTeX; leave it out and record the exclusion | **leave it out**; separate feature with its own prompts and tests |
| D13 | Test membership | new layer in `npm test`; opt-in only | **new layer in `npm test`** *after* the harness change in §4 is reviewed on its own |
| D14 | Rollback | delete nothing; delete only the marker; delete the cache directory | **delete nothing** automatically; expose Clear cache and keep the directory inert |
| D1b | `Export › PDF` freshness and availability | refuse with a toast; compile first; disable the row with a reason | **refuse, and disable the row with a reason** — enabled only while a current PDF exists (always for LaTeX; Typst only in Pages view); a multi-second engine run behind a menu item reads as a hang |

Two implementation facts found while closing D2 and D1, both now in the plan:

- The portable build overrides only `config` (`tauri.portable.conf.json`), while
  `latex.rs:72` resolves `app_data_dir()`. So the PoC's assets and cache would
  land in the machine-wide app-data directory beside a portable executable. The
  schema documents `config`, `data`, `localData`, `cache` and `log` as override
  keys, so the fix is a `data` entry in the same file — and a single `"."` root
  is explicitly unsafe, which rules out the shortcut.
- The Typst Document view compiles HTML and carries no PDF bytes
  (`typstPdfBase64` is set only from a `pages` render, `main.ts:1815`), so a
  uniform `Export › PDF` row cannot write a PDF there. That is why D1b ties
  availability to the bytes that exist instead of adding an on-demand compile.
- `export_formats` are stored, not derived (`settings.rs:505`, defaulted only at
  `:658`). The native-only decision makes this moot — the row's label is built in
  Rust and nothing is persisted — but it is the reason a relabelled *pandoc*
  format would have needed a migration in `parse_settings` (`settings.rs:878`).

## 4. Test and measurement gaps

- **New layers to declare, with counts.** `latex:unit` (tokens, comment data,
  completion ranges, UTF-16 conversion, stale replies, cancellation, "no
  network"), `latex:format:unit` (verbatim, comments, math, CRLF/BOM,
  idempotence, refusal), and extension of `menu` (123), `shortcuts` (47),
  `syntax` (10), `format:document` (47 unit + 143 UI), `paste:convert` (397),
  `image:rules` (43), `links` (18), `read-aloud-unit` (106), `filename:unit`
  (76), `preview:zoom` (24). The plan says "focused tests in `scripts/`"; the
  counts are a contract quoted in `AGENTS.md` and the README, so they have to be
  named before the work starts.
- **`npm test` membership.** `latex:sync:unit` and `latex:poc` are not layers of
  `scripts/test-all.mjs` (grep: no `id: "latex…"`). Decide whether the product
  suite joins the 54 layers; if it does, the harness count and `AGENTS.md` change
  too, and the PoC suite needs the hidden-window path that `test-all.mjs` now
  supplies.
- **The harness change is unreviewed.** `02a7200` changed `scripts/test-all.mjs`
  for **every** layer: `MDRAFT_TEST_HIDDEN=1` and a settings directory named
  `…test-automation` (`test-all.mjs:51,59`), plus `src-tauri/src/launch.rs:144`
  honouring the hidden flag. That is the right direction (`AGENTS.md` requires
  tests that never take the desktop), but it is a change to the shared harness
  smuggled in by a PoC commit. The plan should either bless it explicitly with a
  Windows+Linux re-run or split it out as its own reviewed change.
- **The size gate measures the wrong thing.** The engine assets are downloaded,
  not bundled (`latex.rs:36`, 8 files ≈ 10 MiB), and `wasmtex` is already a
  dependency of the branch, so "≤ 1 MiB additional compressed installer" is met
  before the work starts. The budgets that matter are cold-start, first compile,
  warm compile, cache size, and peak memory on a 1 MB project. Keep an installer
  ceiling (it is cheap to assert) but stop presenting it as the release gate.

## 5. Plan-format gaps

Against [docs/plans/README.md](../plans/README.md):

- **Scope and non-scope** has no boundary for the AI assistant (the `MARKUPS`
  question), for pandoc export, or for macOS. Each is something a reviewer would
  assume is covered.
- **Steps** mix spike and integration in one line ("Evaluate and integrate a
  formatter"), which cannot be ticked honestly. Split measure → decide →
  integrate, and order by dependency: baseline and `npm ci`; highlighter and
  comment data; outline/spelling/read-aloud/filename/links/image syntax (the
  cheap sites); menus and commands; formatter; completion; scroll
  correspondence; export and PDF route; packaging, docs and measurement.
- **Files and modules** omits nine of the twelve sites in §2, and `src/filename.ts`,
  `src/sidebar.ts`, `src/spellcheck.ts`, `src/read-aloud.ts`, `src/language.ts`,
  `src/links.ts`, `src/image-syntax.ts`, `src/content.ts`, `src-tauri/Cargo.toml`
  appear without a reason beyond "modules".
- **Risks and rollback** gives per-area hazards but no restoration point per
  step, and no statement of what the settings schema change means for a reader
  who downgrades.
- **ADR** names "language, compiler and project boundaries". Two more durable
  decisions belong there: generalising `TypstPdfPreview` into a source-neutral
  PDF viewer, and the `settings.json` shape for the LaTeX switch and cache.
- **Open questions** carry defaults for licensing and size; the four decisions in
  §3 have no default, so a reviewer cannot tell what happens if no answer
  arrives.

## 6. Quick wins worth folding into the first step

1. `npm ci` and record `npx tsc --noEmit` clean — otherwise every later
   measurement is against a branch that does not build.
2. Remove `.npmrc`'s pnpm-only `allow-remote=root`, or document why it exists.
3. Move `bin/wasmtex-poc/probe-biblatex.mjs` into `scripts/`: `bin/` is ignored
   (`.gitignore:17`), so the PoC's only `biblatex-lite` evidence is not in a
   clone, while the plan asks to "document the observed failure".
4. Add `latex`, `lualatex`, `biblatex` to `ALLOWED` (`src/spellcheck.ts:35`) — one
   line, and it removes three false underlines from every document that mentions
   the feature.
5. Make `hasCommentSyntax` work by attaching `commentTokens` (`%`) as language
   data; it is the same mechanism Typst uses (`src/typst-language.ts:32`) and it
   lights up Edit › Comment with no menu work.
6. Add the LaTeX Reference document + menu item while the help tree is open
   (`menu.rs:1194`, `main.ts:4299`); every other language has one.

## 7. Suggested amendment, in one paragraph

Replace "Approach" with a decision record that states: highlighter = lazy sTeX
stream mode (chunk already emitted, verify after `npm ci`); completion =
*build* a CM6 completion layer first, then adapt `wasmtex/lsp`, with the catalog
bundled locally; formatter = measure a WASM build of tex-fmt against the existing
`typstyle` route before accepting a new `#[tauri::command]`; PDF = one route
through `Export › PDF` reusing `latex_save_pdf`, gated on `latexCurrent`; scroll
correspondence = a second implementation behind the existing viewer interface,
not a variation of the Typst map. Then replace "Steps" with the dependency-ordered
list in §5, add the twelve sites in §2 to "Files and modules" with the reason for
each, answer the four questions in §3 with a default each, and move the size gate
from "≤ 1 MiB installer" to "first-compile, warm-compile and peak memory on the
fixture project, plus a no-regression ceiling on installer size".
