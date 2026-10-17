# AGENTS.md

Working guide for this repository: how to build it, test it, debug it, which
scripts exist, and which traps have already cost time.

- [Orientation](#orientation)
- [Governance and workflow](#governance-and-workflow)
- [Recording traps is required](#recording-traps-is-required)
- [Prerequisites](#prerequisites)
- [Repository scripts](#repository-scripts)
- [Build pipeline](#build-pipeline)
- [Building for Linux](#building-for-linux)
- [Development loop](#development-loop)
- [Debugging](#debugging)
- [Testing](#testing)
- [Traps](#traps)
- [Adding a preference, end to end](#adding-a-preference-end-to-end)
- [Code map](#code-map)
- [Conventions](#conventions)
- [Releasing](#releasing)
- [Portable builds](#portable-builds)
- [Release checklist](#release-checklist)

## Orientation

A **Markdown, Typst and HTML** editor: a **Rust/Tauri 2 backend** and a
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

1. **No licensing, telemetry, or start-up network activity.** The only outbound
   request the application makes itself is `images::download_image`, reached by a
   user pasting or dropping an image URL, or by pasting rich content that contains
   remote images. Both are user actions; *Preferences › Image* can turn each one
   off. An HTML document the reader
   opens may request the resources its own markup links; that is the document's
   request, not the application's.
2. **No dead UI.** If a Typora option is not implemented, the Preferences panel
   shows a note explaining that, never a control that does nothing.

## Governance and workflow

**A plan needs approval before code is edited when any one of these holds:**
refactoring; an architectural change; more than three files; a public contract
change — a `#[tauri::command]` name, argument or return shape, its `src/api.ts`
wrapper, the `settings.json` schema (an existing file must keep loading), the
markdown dialect existing documents rely on, a menu event name, or the
`accelerators`/`menu_state` payload a test reads; a new dependency, whether npm,
cargo or a bundled font; something hard to undo, such as renaming
`productName`/`identifier` (which moves every install's settings) or rewriting
the release workflow; or the user asks for a plan.

**No plan — implement directly**, for example: UI copy; CSS; an obvious local JS
fix; renaming a variable; a typo; a message or validation tweak; a bug confined
to one file. Do not write a plan, do not ask for approval, and do not run the
whole `npm test` out of habit: make the smallest change that fixes it, validate
with the cheapest layer that can catch the mistake, and report what you ran and
what you skipped.

When the two cases are not obvious, ask in one line — "implement directly, or do
you want a plan?" — rather than producing a plan out of caution.

When a plan is required:

1. Investigate the relevant code first, read-only.
2. Write the plan to `docs/plans/YYYY-MM-DD-short-slug.md`, following the
   template in `docs/plans/README.md`.
3. **Stop and wait for explicit approval** before implementing anything.

The plan format: context and goal; scope and non-scope; approach and rejected
alternatives; ordered steps as a checklist; affected files and modules; risks and
rollback; test and validation strategy; acceptance criteria; open questions;
status (`draft`, `approved`, `in progress`, `done`). Set the status to `approved`
when approval arrives: the file, not the conversation, is what a later session
can read.

While executing: tick the checkboxes, record deviations in the plan itself, and
never widen the scope without updating it. An approved plan is permission to
implement its scope — not to skip the [Testing](#testing) layers or the
[Traps](#traps) discipline. A durable architectural decision — where a
responsibility lives, a command's shape, a format that outlives the change —
becomes an ADR in `docs/adr/YYYY-MM-DD-slug.md` (template in
`docs/adr/README.md`); ADRs are superseded, never rewritten. When the work is
done, update the status and the documentation the change touched, and leave the
plan in `docs/plans/` as the record of what was agreed.

## Recording traps is required

The [Traps](#traps) section is the most valuable part of this file: every entry
in it is time that somebody already lost. **If you lose time to something that
was not obvious, add it to Traps before you finish the task.** Do not wait to be
asked, and do not decide it is too small. The entry that saves the next agent an
hour is usually the one that felt embarrassing to write down.

An event is a trap when all three hold:

1. **You were wrong, or a tool lied to you.** A build failed for a reason
   unrelated to your change; a measurement said one thing and reality said
   another; you reached a confident conclusion that turned out to be false.
2. **It is not obvious from the code, the error text, or the documentation.** If
   the message already says exactly what to fix, it is not a trap.
3. **It can happen again** to another agent working in this repository. If it was
   a one-off caused by your own typo that the compiler caught immediately, leave
   it out.

Write the entry as **symptom → cause → fix**, using the literal error text when
there is any:

```markdown
**<the symptom, exactly as you first saw it>**
<what actually caused it>. <what to do instead, concretely>.
```

Three things make an entry good, and all three were learned by writing bad ones:

- **Quote the literal error or the literal measurement.** "The build failed" is
  useless; `C1083: cannot open include file 'windows.h'` is searchable.
- **Say how you found it when that is the reusable part.** "Instrument the Rust
  side with `eprintln!` and redirect stderr" helps the next agent far more than
  the conclusion alone.
- **Record the false conclusion you almost published**, not just the final
  answer. Three of the entries below exist because a first diagnosis was wrong,
  and that wrong turn is what a future agent will repeat.

Do not put a trap here when it belongs somewhere more specific: a wrong
`bundle.icon` path belongs in a fix and a test, not in a list of symptoms. Traps
are for knowledge that has no natural home in the code.

## Prerequisites

- **Rust** 1.91+ (`x86_64-pc-windows-msvc` target on Windows)
- **Node.js** 20+ and npm. This repo uses **npm**; pnpm is not installed here.
- **Windows**: Visual Studio C++ build tools, Windows SDK, WebView2 runtime
- **macOS**: Xcode command line tools
- **Linux**: `webkit2gtk-4.1`, `libayatana-appindicator3`, `librsvg2`, `patchelf`, `libhunspell-dev` (spelling; the dictionaries themselves are `hunspell-en-us` and `hunspell-pt-br`, which are not bundled)

### Windows: everything through `scripts\with-msvc.cmd`

Rust finds the MSVC toolchain and Windows SDK through the registry. When the
registered SDK version and the on-disk directory disagree — this host registers
`ProductVersion 10.0.26100` while the folder is `10.0.26100.0` — that lookup
never exports `INCLUDE`/`LIB`, and the build dies with:

```
C1083: cannot open include file 'windows.h'
LNK1181: cannot open input file 'windows.h'
```

Loading `vcvars64.bat` first fixes it. **Any** cargo or tauri invocation must go
through the wrapper on this host:

```powershell
.\scripts\with-msvc.cmd npm run tauri dev
.\scripts\cargo-vcvars.cmd check --manifest-path src-tauri\Cargo.toml
.\scripts\cargo-vcvars.cmd test  --manifest-path src-tauri\Cargo.toml
```

`npm run dist` handles this itself, which is why it is the recommended entry
point. On macOS and Linux the wrappers are unnecessary and plain commands work.

## Repository scripts

Everything in `scripts/` is listed here. **If you add a script, add it to this
section in the same change** — an undocumented script is one the next agent will
rewrite from scratch.

### npm entry points

`package.json` wires the common ones so they can be run without arguments.

| Command | Runs | Does |
| --- | --- | --- |
| `npm install` | — | Install frontend dependencies |
| `npm run dev` | `vite` | Vite dev server only, no Tauri shell |
| `npm run tauri dev` | `tauri dev` | Full app with HMR |
| `npm run build` | `tsc --noEmit && vite build` | Typecheck plus frontend bundle into `dist/` |
| `npm run dist` | `scripts/dist.mjs` | Build, bundle and stage into `bin/<os>/<arch>/` |
| `npm run stage` | `scripts/stage-artifacts.mjs` | Re-stage what is already built |
| `npm run check:version` | `scripts/check-version.mjs` | The two version files agree, and match a tag when one is given |
| `npm run check:rust` | `cargo check` | Fastest Rust feedback |
| `npm run test:rust` | `cargo test` | 77 tests on Windows (76 run, one ignored download); Linux has 76 total (75 run, one ignored) |
| `npm test` | `scripts/test-all.mjs` | Every layer in the order below, doing the setup each one quietly depends on: build, Rust, then one freshly launched instance per UI suite on its own free port, each with its fixture and first-run state. Puts back the working tree and the developer's own settings afterwards. `--only`, `--skip`, `--all`, `--no-build`, `--kill`, `--list` |
| `npm run smoke` | `scripts/dom-smoke.mjs` | 93 checks against `samples/feature-tour.md` |
| `npm run spellcheck` | `scripts/spellcheck-test.mjs` | Underlines a misspelling, then clears it when spelling is turned off |
| `npm run audit` | `scripts/audit-document.mjs` | Render metrics for whatever document is loaded |
| `npm run math` | `scripts/math-render-check.mjs` | 10 checks against the physics paper |
| `npm run syntax` | `scripts/syntax-theme-test.mjs` | 7 checks that highlighting is real |
| `npm run html` | `scripts/html-preview-test.mjs` | 42 checks of the sandboxed HTML guest |
| `npm run export` | `scripts/export-test.mjs` | 34 checks of every export path, against real pandoc |
| `npm run typography` | `scripts/typography-test.mjs` | 26 checks that each face loads, each OpenType switch changes pixels, and the preset matrix and Semibold weights hold |
| `npm run shortcuts` | `scripts/shortcut-test.mjs` | 39 checks that every menu accelerator is registered, that pressing one changes state, that F8/F11 move the menu checks, that the zoom chip follows the level, and that a new tab keeps the previous buffer's undo |
| `npm run tabs` | `scripts/document-tabs-test.mjs` | 68 checks of several open documents: sidebar and Recents, `open-files`, caret and scroll per tab, dirty dot, × and middle-click, Ctrl+Tab, the disk poll, Auto Save across tabs, the last tab |
| `npm run test:sessions` | `scripts/sessions-test.mjs` | 43 unit checks of `src/sessions.ts`, with no application and no build |
| `npm run paste:convert` | `scripts/paste-convert-test.mjs` | 51 unit checks of the paste readers, renderers, destination detection and image syntax; no application |
| `npm run paste` | `scripts/rich-paste-test.mjs` | 23 checks of rich paste through the real UI: destination detection, conversion, preferences, Ctrl+Shift+V, undo |
| `npm run image:syntax` | `scripts/image-syntax-test.mjs` | 14 checks of bitmap and remote-image handling in Typst, Markdown and HTML, including the Image preference |
| `npm run licence` | `scripts/licence-test.mjs` | 4 checks that the bundled typefaces' licences ship inside the application. Run against its own instance: it opens a document |
| `npm run images` | `scripts/image-paste-test.mjs` | Image paste through the real UI |
| `npm run screenshot` | `scripts/screenshot.mjs` | PNG of the running window |

### Test harnesses

All of these need the app already running with CDP enabled (see
[Debugging](#debugging)) **and the right document loaded**. The port is always
`argv[2]` and defaults to `9222`.

| Script | Arguments | Needs this document | Proves |
| --- | --- | --- | --- |
| `dom-smoke.mjs` | `[port]` | `samples/feature-tour.md` | Rendering, pane sync, preferences, search, toggles, math, fonts, status icons, blink behaviour |
| `audit-document.mjs` | `[port] [label]` | any — `label` names it in the output | Block/anchor counts, table and code-fence totals, KaTeX errors, stray `$` in prose |
| `math-render-check.mjs` | `[port]` | `docs/samples/physrevb_70_035307.md` | That fonts actually load and that fractions and radicals have real geometry |
| `syntax-theme-test.mjs` | `[port]` | `samples/feature-tour.md` | Distinct computed token colours, and that switching palette changes them |
| `html-preview-test.mjs` | `[port]` | `samples/html-tour/index.html` | The guest iframe, its sandbox and IPC boundary, local CSS/images/modules, sync, blink, scripts-off, outline, the return to Markdown and the HTML tab coming back. It connects to the iframe target as well as the page |
| `export-test.mjs` | `[port] [--install]` | `samples/feature-tour.md` | That pandoc really converts: the bytes of each output are inspected. `--install` additionally exercises the pandoc download, which is why it is opt-in |
| `typography-test.mjs` | `[port]` | any | Screenshots text with each OpenType feature off and on and compares pixels, then asserts the preset matrix and the Semibold weights. Width cannot measure a monospaced face, so nothing narrower would work |
| `shortcut-test.mjs` | `[port] [document]` | `samples/feature-tour.md` | Presses each accelerator through a synthetic keydown and checks what changed. Also reads the `accelerators` registry, which is the only way to see an accelerator the platform rejected |
| `licence-test.mjs` | `[port]` | any | Opens *Font licences* and looks for the five OFL texts in the rendered document. Searching the executable cannot answer this: the frontend bundle is compressed inside it |
| `fetch-fonts.ps1` | `[--work-directory]` | — | Downloads the five bundled families, verifies each archive against a pinned SHA-256 and rewrites `src/assets/fonts/fonts.json`. Only needed to upgrade them; the fonts are committed |
| `image-paste-test.mjs` | `[port] [imageUrl] [localPath]` | `samples/feature-tour.md` | Clipboard, local and remote image paths, and the markdown that results |
| `image-path-paste-test.mjs` | `[port]` | `samples/feature-tour.md` | Selects the `./image.png` placeholder with the mouse, pastes a relative path beside the document, and checks the text is replaced and the preview loads it |
| `spellcheck-test.mjs` | `[port]` | `samples/feature-tour.md` | Sets the dictionary to English, types a misspelling, requires the wavy underline, then turns spelling off and requires the mark to be gone |
| `document-tabs-test.mjs` | `[port]` | `samples/feature-tour.md` | That several documents stay open sanely: a path already open is focused, the caret and both scroll offsets come back, the disk poll reloads a clean inactive tab and leaves a dirty one alone, Auto Save writes every dirty tab, and a large document no longer breaks the next New |
| `sessions-test.mjs` | — | none — runs without the application | The session store's rules: insertion after the active tab, untitled names, one tab per path under both case rules, the neighbour that takes over on close, wrap-around, and the empty-list invariant |
| `paste-convert-test.mjs` | — | none — runs without the application | The paste matrix: clipboard and document detection, all reader/renderer pairs, escaping, sanitisation, caps and image syntax |
| `rich-paste-test.mjs` | `[port]` | `samples/feature-tour.md` | That the paste event converts HTML, leaves Markdown/plain text alone, detects an unsaved Typst/Markdown/HTML buffer, honours Ctrl+Shift+V and the preference, and undoes in one step |
| `image-syntax-test.mjs` | `[port]` | `samples/typst-tour.typ` | A clipboard bitmap becomes `#image`, a remote image is downloaded or kept according to the Image preference, and the files land in the document's assets folder |
| `set-palette.mjs` | `[port] [paletteId] [--split]` | `samples/feature-tour.md` | Not a test: drives the palette through the Preferences UI so you can screenshot a theme |
| `screenshot.mjs` | `[port] [out.png] [setupExpression]` | any | Not a test: captures the window, optionally after running a JS setup string |
| `test-close.ps1` | `[-Exe path] [-Doc path] [-TimeoutSeconds 12]` | `samples\feature-tour.md` | Launches the release binary, sends WM_CLOSE, and asserts the process exits and writes `.window-state.json` |

`image-paste-test.mjs` needs a fixture server for the remote case, which the
`file://` URL alone cannot provide:

```powershell
node scripts\image-paste-test.mjs 9222 "http://127.0.0.1:8791/served.png" "C:\path\to\served.png"
```

### Build and environment helpers

| Script | Arguments | Does |
| --- | --- | --- |
| `dist.mjs` | `[-- <tauri build args>] [--kill]` | Typechecks, builds the frontend, routes through the MSVC wrapper on Windows, then calls `stage-artifacts.mjs`. Streams output; exits non-zero on any failure. **Refuses to start while a copy of the app is running** (Windows locks a running executable, so cargo cannot replace it) unless `--kill` is given, which closes it first |
| `stage-artifacts.mjs` | `[--dry-run]` | Copies the binary and every installer into `bin/<os>/<arch>/` with `SHA256SUMS.txt` and `manifest.json`. Fails loudly, naming the path it searched, when it finds no bundles |
| `build-linux.sh` | `[--bundles deb,appimage] [--build-dir path]` | The whole Linux build inside WSL2 or a container — see [Building for Linux](#building-for-linux) |
| `with-msvc.cmd` | `<command> [args…]` | Loads `vcvars64.bat` then runs the command. **Required for every cargo or tauri invocation on this host.** Searches the standard Visual Studio locations, including the Enterprise edition the GitHub runners install |
| `cargo-vcvars.cmd` | `<cargo args…>` | The same wrapper specialised for cargo: `cargo-vcvars.cmd test --manifest-path src-tauri\Cargo.toml` |
| `check-version.mjs` | `[tag]` | Asserts `package.json` and `src-tauri/tauri.conf.json` carry the same version, and that a supplied tag (`v0.1.0`, or `GITHUB_REF_NAME`) matches. CI runs it before building anything |

### Conventions for new test scripts

The existing scripts share a shape because it makes failures legible. Follow it:

- **Take the CDP port as `argv[2]`, defaulting to `9222`.** Never hard-code it.
- **`Runtime.enable` first**, and **throw on `result.exceptionDetails`**. A
  rejected promise in the page arrives as a *successful* CDP response with the
  error inside; ignoring it turns failures into passes.
- **Print one line per assertion** as `  PASS  <what was measured>` or the same
  with `FAIL`, and end with `N/M checks passed`. The counts are quoted in this
  file and in the README, so they are a contract.
- **Exit non-zero when any check fails**, so the script composes with `&&`.
- **Measure something a person could see.** Geometry, computed colours, scroll
  positions. See [What the assertions are worth](#what-the-assertions-are-worth).
- **Never inline a snippet with `node -e`.** PowerShell's nested quoting broke
  this repeatedly; every non-trivial script lives in `scripts/`.

## Build pipeline

```
src/**.ts ───tsc──▶ typecheck ──vite──▶ dist/ ─┐
                                               ├─▶ tauri build ─▶ target/release/
src-tauri/**.rs ──cargo──▶ mdraft_lib ─────────┘                   │
                                                                   ▼
                        scripts/stage-artifacts.mjs ──▶ bin/<os>/<arch>/
```

1. `npm run build` typechecks and bundles the frontend into `dist/`.
2. `tauri build` compiles Rust and embeds `dist/` into the executable.
3. Tauri's bundlers produce the installers (NSIS, MSI, dmg, deb, appimage…).
4. `stage-artifacts.mjs` copies the runnable binary and every installer into one
   folder with `SHA256SUMS.txt` and `manifest.json`.

Bundle targets are per platform, in `src-tauri/tauri.<platform>.conf.json`. These
files **merge onto `tauri.conf.json` automatically** — they must not contain an
`extends` key, which Tauri rejects with `Additional properties are not allowed`.

## Building for Linux

Cross-compiling from Windows is not possible: Tauri resolves `webkit2gtk-4.1`,
`javascriptcoregtk-4.1`, `libsoup-3.0` and `gtk+-3.0` through `pkg-config`, and
there is no usable Windows sysroot for them. Build inside Linux — WSL2, a
container, or a runner.

```powershell
wsl -e bash -lc 'cd /mnt/c/Users/bernh/Documents/GitHub/MDraft && bash scripts/build-linux.sh'
```

`scripts/build-linux.sh` handles three things a bare `tauri build` does not:

1. **rsyncs the sources into `~/.cache/mdraft-build`** before building.
   `/mnt/c` is an order of magnitude slower for cargo, and its file locking over
   9p is unreliable. Override with `MDRAFT_BUILD_DIR`.
2. **Works without Node.** `dist/` is platform-independent, so when Node is
   missing the pre-built frontend is reused and `beforeBuildCommand` is
   overridden to `true`. With Node present it runs `npm ci && npm run build`.
3. **Accepts either CLI**: `cargo-tauri` (`cargo install tauri-cli`) or `npx
   tauri` from `package.json`.

Verified on Debian 13 (trixie) with WSLg: `bin/linux/amd64/` receives a `.deb`
(6.0 MB), an AppImage (107 MB) and the bare binary. Installing the `.deb` puts
`/usr/bin/mdraft` and a `.desktop` entry in place, and the app runs as a
normal window with a native GTK menu bar.

## Development loop

```powershell
.\scripts\with-msvc.cmd npm run tauri dev
```

What reloads without a restart:

| Change | Effect |
| --- | --- |
| `src/*.ts`, `src/styles.css`, `index.html` | Vite HMR, instant |
| `src-tauri/src/*.rs` | Cargo rebuilds and restarts the app |
| `src-tauri/tauri.conf.json`, capabilities, icons | rebuild required |
| `src-tauri/Cargo.toml` | full rebuild |

The frontend is a plain Vite app, so `npm run dev` plus a browser is enough for
pure rendering work — except anything that calls into Rust, which needs the
Tauri shell.

## Debugging

### The frontend: CDP against the running app

Launch with WebView2 remote debugging enabled, then drive it over the Chrome
DevTools Protocol:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
.\src-tauri\target\release\MDraft.exe "C:\path\to\doc.md"
```

`http://127.0.0.1:9222/json/list` lists targets. Node's built-in `WebSocket`
speaks CDP with **no extra packages**, which is the pattern every script in
`scripts/` uses:

```js
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
await send("Runtime.enable");
const r = await send("Runtime.evaluate", {
  expression, returnByValue: true, awaitPromise: true,
});
```

Notes that matter:

- `Runtime.enable` first, or events are not delivered.
- `awaitPromise: true` for async expressions; otherwise you get a Promise handle.
- **Check `r.result.exceptionDetails`.** A rejected promise in the page arrives
  as a successful CDP response with the error inside; ignoring it makes failures
  look like passes. Every script here throws on it.
- Screenshots come from `Page.captureScreenshot`, no `Page.enable` needed.
- Generic browser-automation tooling tends to **time out** against the WebView2
  endpoint on this host. Speak CDP directly; it is a few lines and always works.

### The backend: logs

**In release builds Rust output is discarded.** `src-tauri/src/main.rs` sets
`windows_subsystem = "windows"` when `debug_assertions` is off, so the process has
no console and `println!`/`eprintln!` go nowhere. In `tauri dev` and
`cargo build` the console subsystem is kept and the output appears in the
terminal.

That is why the menu builder's `[menu] accelerator … was rejected` diagnostic is
visible while developing and silent in a release binary. When a release-only
problem needs Rust-side output, attach a debugger or add a logging crate that
writes to a file — do not assume a `println!` will be seen.

Useful commands:

```powershell
.\scripts\cargo-vcvars.cmd check --manifest-path src-tauri\Cargo.toml   # fastest feedback
.\scripts\cargo-vcvars.cmd clippy --manifest-path src-tauri\Cargo.toml
```

### Application state

Settings live in `%APPDATA%\io.github.bernh.mdraft\settings.json` on
Windows (`~/Library/Application Support/…` on macOS,
`~/.config/…` on Linux).

Editing or deleting that file is the fastest way to reproduce a first-run
problem. **Delete it before running any UI test** — a persisted `viewMode`,
`theme`, or `syntaxTheme` from a previous run changes what the test sees and
produces confusing failures.

```powershell
Remove-Item "$env:APPDATA\io.github.bernh.mdraft\settings.json" -Force
```

### Reading a screenshot

Measure pixels; do not trust your impression of a downscaled preview. A capture
that looks light may be dark. Two lines settle it:

```powershell
Add-Type -AssemblyName System.Drawing
$b = [System.Drawing.Bitmap]::FromFile("shot.png")
$c = $b.GetPixel(1300, 300); "R$($c.R) G$($c.G) B$($c.B)"
```

The same applies to icons: use `[System.Drawing.Icon]::ExtractAssociatedIcon` and
hash the pixels.

## Testing

Thirteen layers, cheapest first. Run them in this order when changing anything.

| Layer | Command | Count | Catches |
| --- | --- | --- | --- |
| Typecheck | `npm run build` | — | Type errors, unused imports |
| Rust unit | `npm run test:rust` | 77 | Path handling, sanitisers, file IO, settings, token estimate, spellcheck, HTML preview scheme |
| Session store | `npm run test:sessions` | 43 | Tab order, untitled names, path identity, the neighbour on close — no application needed |
| Paste conversion | `npm run paste:convert` | 51 | Clipboard/document detection, every reader and renderer, escaping, sanitisation, image syntax |
| DOM smoke | `npm run smoke` | 93 | Rendering, pane sync, preferences, math, fonts, status icons |
| Rich paste | `npm run paste` | 23 | The paste event, destination notice, preferences, Ctrl+Shift+V, undo |
| Image syntax | `npm run image:syntax` | 14 | Bitmap and remote-image handling in Typst, Markdown and HTML, plus the Image preference |
| Math | `npm run math` | 10 | Font loading, fraction and radical geometry |
| Syntax | `npm run syntax` | 7 | Token colours, palette switching |
| HTML guest | `npm run html` | 42 | Sandbox, IPC boundary, local assets, sync/blink, scripts-off, outline |
| Document tabs | `npm run tabs` | 68 | Several open documents, the disk poll, Auto Save across tabs, caret and scroll per tab |
| Close | `.\scripts\test-close.ps1` | 4 | The window really exits and saves its state |
| Document audit | `npm run audit` | — | Real-world render quality on big files |

`npm test` (`scripts/test-all.mjs`) runs that table in that order. It exists
because the layers are not self-contained: it builds first, gives every UI suite
its own freshly launched instance, its own port and its own fixture, starts each
one from first-run state, stages the binary outside the workspace — an executable
launched from inside it cannot write `%APPDATA%`, which is exactly what the close
test asserts — and closes everything it started on every exit path. `--no-build`
tests the binary already built, `--only`/`--skip` narrow the run, `--all` adds the
pandoc export and the image paste checks, and `--kill` closes an MDraft that is
running from `target/release` instead of refusing to build over it.

The close test is PowerShell rather than CDP because it has to kill the
application, which no DOM test can survive. It launches the release binary, sends
WM_CLOSE — exactly what the title-bar X sends — and asserts that the process
exits and that `.window-state.json` was written. Run it after any change to
`capabilities/default.json`.

It closes a window whose one document is clean. The guard's save-all path —
several dirty tabs, one native prompt each — needs those prompts answered, which
CDP cannot do, so that path stays manual. `sessions-test.mjs` covers the store
invariants the guard relies on (which sessions are in the list, what `remove`
returns, that the active session is always defined), not the prompts themselves.

### Running the CDP tests correctly

**Each test needs the app open with the right document.** The smoke test asserts
against `samples/feature-tour.md`; the math test against
`docs/samples/physrevb_70_035307.md`. Running a test against the wrong
document produces a wall of failures that look like regressions.

```powershell
Remove-Item "$env:APPDATA\io.github.bernh.mdraft\settings.json" -Force -ErrorAction SilentlyContinue
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
Start-Process ".\src-tauri\target\release\MDraft.exe" -ArgumentList "`"$PWD\samples\feature-tour.md`""
Start-Sleep -Seconds 15
npm run smoke
```

The image test also needs a fixture server:

```powershell
node scripts\image-paste-test.mjs 9222 "http://127.0.0.1:8791/served.png" "C:\path\to\served.png"
```

### What the assertions are worth

Counting elements proves code ran, not that the result is correct. This project
was once "verified" by a check that counted 270 KaTeX elements and reported zero
errors — while the application was rendering math with **no stylesheet at all**,
because `katex.min.css` was never imported. Fractions collapsed and radicals
vanished, and every assertion passed.

Assertions here therefore measure what a person would see:

- **Math**: `document.fonts.load()` each family (a declared `@font-face` is not a
  reachable file), then the width of `.frac-line` and the radical's `.hide-tail`
  box.
- **Syntax highlighting**: the count of *distinct computed colours* of token
  spans, and that switching palette changes both surface and tokens.
- **UI**: exactly one view-mode control may be active; a duplicate means the
  button that used to sit next to it came back. The status-bar icons must stay
  inline SVG at 16px or more, not text glyphs. The preview highlight must be a
  blink that leaves nothing behind — a persistent tint reads as markup applied
  to the document.

When adding a test, ask what a broken result looks like and measure that, rather
than asserting the feature's own internal counters.

## Traps

Each of these cost real time. Symptom → cause → fix.

**Add yours before you finish the task** — see
[Recording traps is required](#recording-traps-is-required) for what qualifies and
how to write it. The list is append-only in spirit: do not delete an entry because
the fix landed, because the fix is what makes it recur.

**`cannot open include file 'windows.h'` / `LNK1181`**
Cargo never found the Windows SDK because the registry version and the on-disk
version disagree. Run everything through `scripts\with-msvc.cmd`.

**`link.exe` resolves to the wrong program**
`C:\Program Files\Git\usr\bin\link.exe` is GNU `link`, not MSVC's linker, and it
sits on `PATH`. The MSVC wrapper puts the right one first; do not "fix" a link
error by editing `PATH` by hand.

**`Additional properties are not allowed ('extends' was unexpected)`**
`tauri.<platform>.conf.json` merges onto the base config implicitly. Remove
`extends`.

**`unexpected closing delimiter` or `unknown start of token: \`**
A JavaScript regex literal written inside Rust, or a backtick inside a
template literal in an `.mjs` file. Both happened here. Rust has no regex
literals; and a backtick ends a template literal, so use `\x60` or restructure.

**`ParserError: An expression was expected after '('` from PowerShell**
Nested quoting in an inline `node -e "…"`. Write the script to a file instead —
every non-trivial snippet here lives in `scripts/`.

**`ReplaceFileW EIO (Win32 1175): C:\…\README.md` from the edit tool**
The file was open in another program that did not grant delete sharing, so
Windows could not replace it atomically — Notepad++ left open on a file under
edit is the usual culprit here. Nothing is wrong with the patch or the file.
Retry the same edit once; the second attempt succeeds as soon as the external
handle is released. Do not switch to an in-place shell write to work around it:
it bypasses the tool's read-before-write check and the other program's buffer
then overflows the change on its next save.

**`document.fonts.check()` is false for a font that exists**
Web fonts load lazily. `check()` reports whether a face is *active*, not whether
it is declared. `await document.fonts.load('1em KaTeX_AMS')` first, then check.

**A font file is "missing" from `dist/`**
Vite inlines assets under 4 KB as data URIs and renames the rest with a content
hash. `KaTeX_Size3` is inlined; the other nineteen are hashed. Compare by base
name after stripping the hash, and verify an inlined font by decoding it and
comparing digests.

**`new System.Drawing.Icon(path, 256, 256)` returns the 128 frame**
.NET cannot decode PNG-compressed ICO entries and silently falls back to a
smaller one, so a 256-frame check reports a false mismatch. Parse the ICO
directory from the raw bytes.

**A pasted URL lands in the document *and* becomes an image**
`preventDefault()` was called from a promise continuation. The decision must be
synchronous with the event; only the work may be deferred.

**Typst list items are separated by a top-level `Space`, not by another node in the list**
The Lezer tree puts `Space "\n"` between sibling `ListItem`s. Treating every
non-list node as the end of the list produced one list per item, and the Markdown
renderer then joined them with blank lines. Ignore whitespace-only nodes while a
list is open (`space.trim() === "" && list && inline.length === 0`), and inspect
the tree before assuming the list is contiguous.

**A CDP test reading `.cm-content.innerText` sees extra blank lines**
CodeMirror's content element includes the visual gap between lines, so
`innerText` does not equal the buffer and a string comparison fails even when the
paste is correct. Join `[...document.querySelectorAll('.cm-line')].map((line) =>
line.textContent)` instead; it is the rendered source, in order. The internal
`cmView` is not exposed by this build, so do not rely on it either.

**`npm run dist` succeeds but `bin/` is empty**
`stage-artifacts.mjs` exits non-zero with the path it searched when it finds no
bundles. Check the bundle kind is in its `BUNDLE_KINDS` map.

**The X button does nothing and the window will not close**
`onCloseRequested` in the frontend calls `window.destroy()` for you when the
handler does not `preventDefault()`. That command is gated by the capability set,
and `core:window:allow-destroy` is **not** part of `core:default`. Without it the
close is a silent no-op: the Rust side reports `CloseRequested` and then never
`Destroyed`, and the only way out is killing the process. Add the permission.
`scripts/test-close.ps1` exists because nothing else in the suite catches this.

**A plain `cargo build` debug binary shows a blank window**
Debug builds load `devUrl` (`http://localhost:1420`), not the embedded `dist/`, so
with no dev server running the window appears with no frontend at all: no JS, no
title, no close listener. Anything concluded from a debug binary is worthless
unless the dev server was up. This produced a confidently wrong "release is
broken, debug is fine" conclusion once. To trace Rust events in a release build,
add temporary `eprintln!` and launch with `Start-Process -RedirectStandardError`;
the redirected handle still receives output from a
`windows_subsystem = "windows"` process.

**A window-rect measurement disagrees with the saved window state**
A non-DPI-aware process gets *virtualised* coordinates from `GetWindowRect`, so
on a 150% display every reading is two thirds of the real value and looks like a
restore failure. Call `SetProcessDpiAwarenessContext(-4)` first, and compare
`GetClientRect` against the state file — the plugin stores the client size, not
the window rect, so frame chrome accounts for another 20-40 px.

**`pkill -f <pattern>` kills the shell running it**
`pkill -f` matches against full command lines, and the shell's own command line
contains the pattern you just typed. The result is a silent exit 1 with no
output, which looks like the command never ran. Use a bracket so the pattern
cannot match itself: `pkill -f "amd64/mdraf[t]"`.

**The CDP test scripts do not work against the Linux build**
They speak Chrome DevTools Protocol through WebView2's remote debugging port.
WebKitGTK has no CDP: it offers a WebKit inspector instead
(`WEBKIT_INSPECTOR_SERVER`), which is a different protocol and only in debug
builds. On Linux the automated coverage is therefore `cargo test` plus a manual
launch; do not read a missing `9222` endpoint as an app failure.

**`npm run dist` stalls, then fails with `failed to remove file ...MDraft.exe` / `Access is denied. (os error 5)`**
Two independent causes arrive together and cargo's message names neither.

  *The stall* is `Blocking waiting for file lock on build directory`. Cargo takes
  an exclusive lock on `src-tauri/target`, and **rust-analyzer holds it** while
  idle-checking — the editor is not obviously "building" anything, so the wait
  looks like a hang. `.vscode/settings.json` sets
  `rust-analyzer.cargo.targetDir: true` so the editor compiles into its own
  directory; keep that setting, it is the whole fix. A second terminal running
  `cargo test`, or a build that was killed mid-flight, causes the same wait.

  *The error* is the app being open. Windows keeps a running executable locked,
  so cargo cannot replace the output binary. **A copy started from the Start menu
  counts**, not just one from `target/release`. `scripts/dist.mjs` now checks for
  this before building and refuses with the PID list instead of failing inside
  cargo, and `npm run dist -- --kill` closes it for you. If you hit the raw cargo
  error, that is the cause.

**`npm run dist` sits on `Building … 461/463: mdraft` for minutes even though
every dependency is cached**
That unit is the app crate (lib + bin). The release profile used to give it
`lto = true` with `codegen-units = 1`, which is effectively single-threaded:
104 s per pass. `dist.mjs` then makes it run **twice**: the portable pass and
the ordinary pass carry different `TAURI_CONFIG` values, and `tauri-build`
declares `cargo:rerun-if-env-changed=TAURI_CONFIG`, so the final crate is dirty
each time. Each pass also rewrites `dist/`, and every file there is listed in
`src-tauri/target/release/mdraft.d`, so a frontend rebuild dirties the crate
again. Measured on this host with a warm cache: 222 s total, 208 s of it in that
step; the frontend build is 1.3 s and bundling 7 s. `--no-portable` halves it.
The profile now ships `lto = "thin"` with `codegen-units = 16`: the same step
takes 27 s and a whole `npm run dist` 78 s, with no meaningful change in binary
size. Do not try profile changes casually through
`CARGO_PROFILE_RELEASE_LTO` / `CARGO_PROFILE_RELEASE_CODEGEN_UNITS`: they
invalidate all 461 dependency fingerprints, and switching back invalidates them
again, so the next ordinary build is a cold rebuild.

**A plain `cargo build --release` links a binary with no frontend**
`tauri build` sets the environment that makes `generate_context!` embed `dist/`;
invoking cargo directly produces a binary about 5 MB smaller that contains no UI.
The tell is the dep-info: `src-tauri/target/release/mdraft.d` is 835 bytes instead
of ~78 KB, and it lists no `dist/` asset at all. A size comparison or a benchmark
taken from such a binary is worthless — build through `npm run dist` /
`tauri build`. This is how a "the thin build is 7.9 MB instead of 12.0 MB" claim
was produced and then had to be retracted.

**`npm test` builds, prints `building ... PASS`, then the new UI is simply absent**
The suites ran the previous binary. `tauri build` had written
`Built application at: T:\Temp\cursor-sandbox-cache\...\cargo-target\release\mdraft.exe`
because the agent sandbox redirects `CARGO_TARGET_DIR` out of `src-tauri\target`.
`scripts/test-all.mjs` only stages `src-tauri\target\release\mdraft.exe`, so a
green build line still tests the exe whose timestamp predates the edit. The
false conclusion was that the feature had not landed: no `.doc-tab`, and
`file.close` / `file.nextTab` / `file.prevTab` reported `MISSING`. Compare the
exe's `LastWriteTime` with the source, and search the bytes for a string only
the new menu has (`Close Tab`). Copy the sandbox binary over
`src-tauri\target\release\mdraft.exe` before `--no-build`.

**A test that launches the app can leave it running and break the next build**
This is how the failure above gets manufactured. Any script that starts
`MDraft.exe` has to kill it on **every** exit path — an early `Write-Error`
under `$ErrorActionPreference = "Stop"` exits before the cleanup runs, which is
what `scripts/test-close.ps1` used to do. Wrap the launched process in
`try { … } finally { … }`, and re-check for leftovers after touching either
script.

**A CDP test that inspects "what is on screen" breaks when something scrolled first**
CodeMirror renders only the visible lines, so probes that read `.cm-line` or
token spans see whatever is in the viewport. Two suites failed this way in one
session: `syntax-theme-test.mjs` reported "italics exist" as FAIL because a
previous script had left the editor scrolled into a section without emphasis, and
`dom-smoke.mjs` reported "source scroll drives the preview" as FAIL on the second
run because it scrolled to 45% from a position that was already 45%. Both now
reset to a known baseline — scroll to the top — before measuring. **Any new probe
that reads the viewport must establish its own starting position.** A suite that
passes once and fails on re-run is usually this.

**A CDP test sets `window.getSelection()` but CodeMirror still reports no selection**
`editor.cursorInfo().selectionLength` stays 0 when a test sets a DOM Range from
`Runtime.evaluate`, even after dispatching `selectionchange`; the paste handler
then imports the image instead of replacing the selected text, so the test
reproduces a bug that is not there. Select with real mouse events
(`Input.dispatchMouseEvent` pressed/moved/released), assert
`window.getSelection().toString()` before pasting, and only then dispatch the
paste. `scripts/image-path-paste-test.mjs` does exactly this.

**A Preferences row's label includes its help mark, and one label can be a prefix of another**
`row.querySelector('.prefs-label').textContent` is `"Run a command?"` for a row that has help: the `?` span is part of the text. Worse, `"Open the exported file"` is a prefix of `"Open the exported file's folder"`, so an `includes()` match silently picks the first row and a test can report both boxes ticked while one was never touched. Strip the trailing `?` and compare the exact label. A probe that matched by substring concluded the second checkbox was already on and never clicked it, then chased a backend/frontend mismatch that did not exist.

**Renaming the product leaves stale bundles that staging will happily ship**
`src-tauri/target/release/bundle/` is not cleaned between builds, so after
changing `productName` the directory held two installers: one under the new name
and one under the previous one. `stage-artifacts.mjs` copied every file matching
the extension, so `bin/<os>/<arch>/` ended up offering both, with the wrong one
just as prominent. The same happens on a version bump. Staging now requires the
filename to contain both the current `productName` and `version`, and fails
loudly naming the directory when nothing matches.

Renaming is more than a find-and-replace. The name lives in six shapes, and
missing one fails in a way that does not point at the cause:

| Shape | Where | Example |
| --- | --- | --- |
| Cargo package (kebab) | `Cargo.toml`, names the binary | `mdraft` |
| Rust lib (snake) | `Cargo.toml` `[lib]`, used by `main.rs` | `mdraft_lib` |
| `productName` | `tauri.conf.json`, names every bundle | `MDraft` |
| `identifier` | `tauri.conf.json`, **moves the settings directory** | `io.github.bernh.mdraft` |
| npm package | `package.json` and the lock file | `mdraft` |
| Display strings | window title, menus, About, welcome document | `MDraft` |

The bare binary is named after the **Cargo package**, not `productName`, and
Tauri renames it to `productName` only inside the bundle. `stage-artifacts.mjs`
therefore reads the package name out of `Cargo.toml` and tries
`mainBinaryName`, `productName` and the package name in turn.

Changing the `identifier` silently relocates settings and window state, because
both live under `%APPDATA%\<identifier>`. That is a user-visible reset; do it
deliberately, and say so, rather than as a side effect.

**`window.print()` silently does nothing in WebView2**
It does not throw, and `beforeprint` and `afterprint` both fire immediately, so
it looks like it worked — but no print UI opens and nothing is produced. WebView2
does not implement a print interface: the host application is expected to provide
one (`ICoreWebView2_16::ShowPrintUI`, or `PrintToPdf` for a silent file). The PDF
export therefore renders the same HTML the preview uses, writes it to the
temporary directory, and lets the *system browser* print it, because a real
browser does implement `window.print()`. Verified by calling it over CDP and
screenshotting immediately after: the application was unchanged and the events
had already fired.

**Spawning any console program from this GUI flashes a console window per call**
The application is built with `windows_subsystem = "windows"`, so it owns no
console — and Windows then allocates a brand new one, window included, for every
console child it spawns. Measured: **12 `pandoc` launches created 18 `conhost`
processes.** One `pandoc_status()` was worse than it looked, because it launched
pandoc twice: once to find it and once to read its version.

Two fixes, and both are needed:

  * `CreationFlags(CREATE_NO_WINDOW)` on every `Command`, through the `quiet()`
    helper in `export.rs`. There are four spawn sites; a new one that skips the
    helper reintroduces the flicker.
  * `find_pandoc` now returns the version from the same launch that proved the
    binary runs, so a status query costs one launch instead of two.

`CREATE_NO_WINDOW` rather than `DETACHED_PROCESS`: the child still gets a console,
so its standard handles keep working, which is how pandoc's output is read.

**A `conhost` count does not measure whether a console window is visible**
`CREATE_NO_WINDOW` still allocates a console — it just gives it no window — so
counting `conhost` processes reports roughly the same number either way, and
comparing "before and after" snapshots misses every transient one entirely. The
only trustworthy signal is window visibility, and **that cannot be observed from
an agent session at all**: a process launched with `CREATE_NEW_CONSOLE`, which by
definition owns a new console, produces no entry in `EnumWindows` here, while the
same enumeration correctly lists the application's own window. Conclude nothing
from a zero count; say the verification is unavailable instead.

**A measurement that runs against a stopped application proves nothing**
A driver reported "0 console hosts during 8 status calls and 8 conversions" —
because the application was not running and the driver had died with
`ECONNREFUSED 127.0.0.1:9222` before doing any work. The results looked like a
clean pass. **Check the driver printed its own success line, and that the files it
should have produced exist**, before believing a zero. This is the same trap as
the CDP suites that "pass" against a window showing the wrong document.

**An exported document needs the KaTeX stylesheet, or the mathematics collapses**
`wrapPrintHtml` shipped with the highlight.js token colours but not KaTeX's
layout rules. The export still looked plausible and reported no error, while
exponents vanished, fraction bars disappeared and radicals drew a bar across the
whole page — the same failure the preview once had, now reproduced in the export
path. `KATEX_STYLESHEET_URL` in `markdown.ts` is the single source for both
exports; a second copy would drift again.

**Pandoc's markdown reader does not accept `\(…\)` or `\[…\]` by default**
`tex_math_dollars` is on, `tex_math_single_backslash` and
`tex_math_double_backslash` are off, so a document using the backslash delimiters
— which this editor renders — exports them as escaped literal text:
`(a\^{}2 + b\^{}2 = c\^{}2)` instead of the formula. The default formats pass
`-f markdown+tex_math_single_backslash+tex_math_double_backslash`, and a test
asserts it, because the difference is invisible in the preview.

**The pandoc export cannot render what pandoc has no concept of**
`[TOC]` and the GitHub alert markers (`[!NOTE]`, `[!TIP]`, `[!WARNING]`) are this
editor's own extensions. Pandoc prints them as literal text, so a DOCX or LaTeX
export shows `[TOC]` and `[!NOTE]` where the preview shows a table of contents
and a callout. This is a real fidelity gap, not a bug to fix by argument
tweaking; the PDF export, which prints the preview's own HTML, does not have it.
`[TOC]` has a partial answer: add `--toc` in the format's Extra Arguments.

**A monospaced font makes width useless as a measurement**
Testing that a typography feature works by comparing text widths works for
proportional faces and silently fails for monospaced ones. Every glyph in a
monospace face has the same advance by definition, and a programming ligature
draws one glyph across two cells — so `->` measures identically whether or not it
is an arrow. `slashed-zero` likewise changes the glyph, never the width.
`canvas.measureText` is no better: `ctx.font` accepts only
style/variant/weight/size/family, so `font-variant-numeric` and
`font-variant-ligatures` are dropped without complaint and every comparison comes
back identical. `scripts/typography-test.mjs` therefore screenshots each sample
with the feature off and on and compares pixels; a feature that changes nothing
on screen fails there.

**`font-weight: 600` silently renders as Bold**
`font-weight: var(--weight-strong)` with 600 looks correct in the stylesheet and
computes to `600`, yet draws the 700 face: when a family declares only 400 and
700, CSS's weight-matching serves the nearest heavier face rather than
synthesising a lighter one. The rule works only if a Semibold face exists and is
declared. Source Serif 4 and Inter carry 600 on a variable axis; Source Sans 3 is
static, so `SourceSans3-Semibold.woff2` and its italic are bundled and listed in
`fonts.json`. Verify with `document.fonts` (`weight === "600"`) and by comparing
600 against 700 pixels — not by reading the computed style, which is 600 either
way.

**`appDirectoriesOverride` reaches below the plugin**
`tauri-plugin-window-state` hardcodes `app_config_dir().join(filename)` with no
API to redirect the directory, which makes it look like a portable build would
strand `.window-state.json` in `%APPDATA%`. It does not: the override is applied
inside `app_config_dir()` itself, so the plugin follows without a change. Verified
by running the portable build in an empty folder — settings and window state both
landed beside the executable and the `%APPDATA%` copies kept their old
timestamps.

**Tauri 2 never translates menu accelerators on Windows, so the menu lies**
*Symptom:* the File, Paragraph, Format and View shortcuts do nothing while the
Edit ones work, and the menu prints "Ctrl+N" beside *New* regardless.
*Cause:* muda documents that the application's own message loop must call
`TranslateAcceleratorW` with the menu's `haccel()`. Neither `wry` 0.57, `tao`
0.37 nor `tauri-runtime-wry` 2.12 calls it — verified by grepping their sources
for it, which returns nothing but a doc comment in `tao`.
*The trap inside the trap:* the Edit entries that appear to work are Ctrl+Z/X/C/V/A,
which are **Chromium's own commands**, handled inside the webview. That makes a
total failure look like a bug in some menu entries. Ctrl+F and Ctrl+H were dead
too, and so was clicking the menu itself in that respect.
*Fix:* the accelerators are collected while the menu is built (a static registry
filled by the same `item()` helper that registers them) and handed to the
frontend by the `accelerators` command, which binds them in a capture-phase
keydown handler. Deriving the list from the menu rather than writing it out twice
is what keeps the two from drifting. A 250 ms per-id guard stops a command from
running twice on platforms whose native accelerators do work, such as GTK.
*Do not test this with CDP input:* `Input.dispatchKeyEvent` injects a synthetic
DOM event **inside** the webview and never reaches a native accelerator, so such
a test reports every shortcut broken. The frontend handler is testable that way
because it *is* DOM; `scripts/shortcut-test.mjs` does exactly that.
*Assert on the effect, not on `defaultPrevented`:* that flag says only that
something handled the key, and CodeMirror legitimately claims Ctrl+Z. Three
assertions failed this way before the axis was changed.

**A test suite that replaces the document breaks the next suite, not itself**
The licence check opens a built-in document, which is correct behaviour — the
application asks before discarding — but it left the window holding the licence
text. `syntax` then failed three assertions about token colours that had nothing
to do with licences, and it passed in isolation. Attempts to restore the fixture
from inside the check (clicking a Recent entry, polling for the title) were
fragile enough to fail twice more. The licence checks live in their own suite
now. **Run each suite against its own freshly launched instance**; do not batch
them against one window unless they have been shown to compose.

**A face in a stack is not a face that will render**
Two separate traps. In an exported document, a family named by name gets a silent
system fallback, because a browser reading a temporary file cannot reach the
application's assets — so exports must embed the faces as data URLs. And in an
embedding pass, only the *first* bundled family in a stack can ever be used: the
default heading stack is `"Source Sans 3", Inter, …`, and embedding Inter as well
added nearly a megabyte per export for a face that could not render. Both are
guarded in `scripts/export-test.mjs`.

**Force-killing the app can corrupt its WebView2 profile, and the next launch dies silently**
After enough `Stop-Process -Force` cycles the app starts dying on launch with no
output at all — release builds have no console, so nothing is printed and the
window never appears. The Application event log shows `Event Name: BEX64`, a
DEP/buffer-overflow exception, which reads like a native regression and is not
one. The fix is to delete the WebView2 user-data folder
(`%LOCALAPPDATA%\<identifier>\EBWebView`, ~80 MB) and relaunch. Diagnose it by
launching the *previous* binary: if that also fails, the profile is at fault and
nothing in the change is. Prefer `CloseMainWindow()` over `Stop-Process -Force`
when a script needs the app gone.

**The release build dies with `BEX64` while the portable build is open**
The portable build redirects only the config directory; it shares
`%LOCALAPPDATA%\io.github.bernh.mdraft\EBWebView` with the ordinary build.
Starting one while the other runs makes the new process die on launch with the
same `Event Name: BEX64` signature as profile corruption, and deleting the
profile fails with `being used by another process`. Close the other MDraft
window first, then remove `EBWebView` only if the launch still fails. This is
not a native regression in the binary being tested.

**A file in the repository is not a file in the application**
Vite bundles only what is imported. The OFL licence texts were committed
next to the fonts, documented in the README, and referenced from nothing — so
every installer shipped the fonts without the licence they are distributed
under, which is exactly what the SIL Open Font License forbids. They are now
imported with `?raw` into `content.ts` and shown under *Help › Font Licences*.
Searching the built executable for the text proves nothing either way: the
frontend bundle is compressed inside it, so the licence reads as absent even
when present. Verify in the running application.

**Pane sync: only scrolling may scroll**
The rule that survived review is that a click never moves the other pane, and
keyboard movement may reveal the caret's block only when it has actually left the
view. Getting there took two wrong versions, both shipped:

  1. A click in the **preview** scrolled the preview. The caret change travelled
     back through `onCursor` and yanked the clicked block to the top. It also
     made drag-selection impossible, because the text slid out from under the
     pointer mid-drag. Fixed with the `caretCameFromPreview` flag.
  2. A click in the **source** scrolled the preview, the same mistake in the other
     direction: `scrollPreviewToLine` always aligned the block to the top, even
     when it was already on screen. Fixed by splitting *follow* (always align, used
     by scroll sync) from *reveal* (only when off screen).

  "Reveal if off screen" is still not enough on its own, which is the part worth
  remembering: the rendered preview is roughly **twice as tall** as its markdown
  for a document with tables and diagrams, so a source line can be plainly visible
  in the left pane while its block sits far below the preview fold. Revealing it
  there throws the alignment away — the exact complaint. Hence `caretByPointer`:
  the pointer never scrolls, the keyboard may.

  Two functions now exist, `alignPreviewToLine` and `revealPreviewLine`, and
  confusing them is how this regresses. `revealCursorInPreview` after a re-render
  also has to respect `caretByPointer`, or a pending render reintroduces the jump
  through the back door.

**`cargo test` fails with `Access is denied` in every temp-directory test, and the release app exits with WebView2 `0x800700AA`**
Both are the agent harness, not the code. Executables launched from inside the
workspace run under a file sandbox that cannot create files outside it. The test
binary at `src-tauri\target\debug\deps\mdraft_lib-*.exe` cannot create
`%TEMP%\tt-*`, so ten tests fail with
`Os { code: 5, kind: PermissionDenied, message: "Access is denied." }`; and
`mdraft.exe` cannot create its WebView2 profile under `%LOCALAPPDATA%`, which the
runtime reports as
`HRESULT(0x800700AA): "The requested resource is in use."` (sometimes
`0x8007139F`). Neither is profile corruption. Copy the test executable or the app
to a directory outside the workspace and run it there: all 75 runnable tests pass
and the window starts. `cargo test` still has to be invoked from the workspace
through the MSVC wrapper, so run the executable it produces from `%TEMP%`.

**`cl : Command line error D8050 : cannot execute '…\c1.dll': failed to get command line into debug records` while `cargo test` compiles `ring`**
The message names the compiler, so it reads as a broken MSVC install, the wrong
`cl.exe` or a missing SDK — none of them. `cl.exe` writes debug records for `/Z7`
through its temporary directory, and when `%TEMP%`/`%TMP%` names a directory the
launching process may not write to, that write fails and `cl` reports the loader
error instead. On this host both variables point at `T:\Temp` (`T:` is a separate
local volume), and the workspace sandbox covers only executables launched from
inside the workspace: `echo > %TEMP%\x` from `cmd` succeeds while the same
compiler spawned by cargo is denied. The same run then produces a second,
unrelated-looking symptom — 13 tests panic with
`Os { code: 5, kind: PermissionDenied, message: "Access is denied." }`. Prove it
in one step, before touching the toolchain, by pointing `TEMP` and `TMP` at a
folder **inside** the workspace: the build completes and all 56 runnable tests
pass. `CARGO_PROFILE_DEV_DEBUG=0` also gets the build through, because without
`-Z7` no debug records are written; that hides the cause rather than fixing it.

**Starting the app with `Start-Process` never returns and prints nothing**
`Start-Process .\src-tauri\target\release\mdraft.exe` from a harness shell hangs
until the call is moved to the background: the GUI child inherits the caller's
output handles, so the shell never sees the pipe close, and not even the line
printed before the launch appears. It reads like the application failing to
start. Pass `-RedirectStandardOutput` and `-RedirectStandardError` to files —
which also recovers the release build's Rust output, normally discarded — and
poll `http://127.0.0.1:9222/json/list` for readiness.

**A second MDraft for a CDP test dies with `HRESULT(0x800700AA)`, even when the exe is outside the workspace**
WebView2 allows one browser process per user-data folder, and every instance
defaults to `%LOCALAPPDATA%\io.github.bernh.mdraft\EBWebView`. While another
MDraft window — including the user's portable build — is open, launching a test
copy with the same `identifier` fails with
`failed to create webview: WebView2 error: WindowsError(Error { code: HRESULT(0x800700AA), message: "The requested resource is in use." })`.
Setting `WEBVIEW2_USER_DATA_FOLDER` does **not** help: Tauri resolves
`app_local_data_dir()` and passes that to WebView2, overriding the variable.
Build a throwaway binary with a different identifier and run it from outside the
workspace:
`tauri build --no-bundle --config .tmp-test/tauri.htmltest.conf.json`, where the
merge sets `identifier` and `productName`. That gives the test its own settings
and WebView2 profile. Delete `%APPDATA%\<test identifier>` to reset it; do not
kill the user's instance or delete the shared profile.

**`Page.captureScreenshot` shows the status bar but never the native menu**
A check mark in the View, File or Themes menu cannot be photographed by CDP and
cannot be read from the DOM: the menu is a native control outside the webview.
Screenshots of the application therefore look as if the checks were never added.
The `menu_state` command returns every check item's `id` and `checked` for the
suites; use a Win32 screen capture only if a pixel proof is genuinely needed, and
do not conclude from a CDP screenshot that the menu is unchanged.

**Two view modes are checked at once after a toggle**
`CheckMenuItem` is a checkbox, not a radio button: setting `view.preview` does not
clear `view.split`, and the platform only toggles the item that was clicked.
`sync` must write every item in each exclusive group from one state table;
`dom-smoke.mjs` asserts exactly one check per group. Tauri/muda has no radio item,
so the check mark plus this write-everything rule is the whole mechanism.

**F8 and F9 stop working when their menu items become check marks**
The accelerators are collected by the `item()` helper that builds each
`MenuItem`, and the frontend binds only what the `accelerators` command returns.
A separate helper that built `CheckMenuItem` with an accelerator but did not push
it to `ACCELERATORS` produced a menu that printed `F8` and did nothing. Keep the
registry push in both helpers; the command should still report 40 entries, now
including `F11`.

**View › Full Screen and `F11` do nothing on Windows**
`PredefinedMenuItem::fullscreen` is documented as unsupported on Windows and
GTK 3, and muda's `run_predefined` falls through to `_ => {}`; predefined items
also emit no `MenuEvent`, so the frontend never hears about the click. Replace it
on non-macOS with a custom `CheckMenuItem` whose handler calls `setFullscreen`,
and keep the predefined item on macOS for Spaces integration. `F11` now reaches
the handler through the accelerator registry, and `menu_state` proves the check.

**The status flags lose their names on a window nowhere near the breakpoint**
`.window-state.json` stores physical pixels, not CSS pixels: on this 165 % display
the restored window was 1770 px wide, but `window.innerWidth` was **1073**, under
the 1080 px media query, so the labels were hidden and the screenshot looked like
a CSS bug. Measure `innerWidth` and `devicePixelRatio` over CDP before choosing a
breakpoint. The five flags plus a long cursor selection also truncate the word
and token counts near 1070 px; keep the visible names short (`Type`, `Auto`).

**The HTML preview iframe loads but every Tauri command from it hangs instead of rejecting**
A sandboxed iframe with an opaque origin sends `Origin: null`; the IPC custom
protocol rejects that before ACL, and the postMessage fallback makes the frame's
URL the IPC source. WebView2 receives the message and the ACL rejects it, but
Tauri evaluates the response in the **main** frame, so the iframe's promise never
settles. Do not `await` an `invoke` from the guest in a test; race it with a
timeout and prove the command did nothing by checking its side effect (the suite
tries `write_document` to a temp path). The parent's own `invoke` still resolves.

**`http://<nonce>.mdraft-preview.localhost` is routed by wry but is local to Tauri**
The workaround recognises the host prefix `http://mdraft-preview.`, not a
subdomain before the protocol name, and Tauri's `is_local_url` strips
`.localhost` to `mdraft-preview`, which is a registered scheme. That makes the
guest a **local** ACL origin. Use `http://mdraft-preview.<nonce>.invalid`
(Windows) or `mdraft-preview://<nonce>.invalid` (elsewhere): wry still routes it,
and Tauri treats it as remote. Never "fix" a secure-context problem by switching
to `.localhost`.

**`allow-same-origin` on the HTML guest would make it same-origin with the app after navigation**
A sandboxed iframe with both `allow-scripts` and `allow-same-origin` can navigate
itself to the embedder's origin (its `document.referrer` names it), and then
reach `parent.document` and remove the sandbox. The guest is deliberately opaque;
local fonts and ES modules get CORS on the preview scheme instead. The preview
suite asserts `parent.document` throws.

**On Linux, the HTML preview shows linked CSS unstyled, images as alt text and classic scripts unrun**
The first Linux launch looked like a parser bug: only `<script type="module">`
reached the scheme handler. WebKitGTK requires a local stylesheet, image or
classic script loaded from this custom scheme to be a **CORS-mode** request; a
plain no-cors `<link>`, `<img>` or `<script src>` is dropped before any network
request, so the handler never sees it. Modules already are CORS-mode and an
inline `<style>` hides the CSS failure. The fix has two halves: the preview copy
adds `crossorigin="anonymous"` to **local** `link[rel=stylesheet]`, `script[src]`,
`img`, `source`, `video` and `audio` (never to CDN URLs, whose images may not send
CORS), and `allows_cors` answers static asset kinds even when `Sec-Fetch-Dest` is
absent. A `fetch()` still reports `Sec-Fetch-Dest: empty` and gets no header, and
`connect-src` blocks it. Verify with a screenshot, not with the DOM: the source
pane is correct either way.

**`bin/linux/amd64` offers both the old and the new version after a version bump**
`build-linux.sh` copies every `.deb`/`.AppImage` it finds under
`~/.cache/mdraft-build/src-tauri/target/release/bundle/`, and the cache is not
cleared by the next build, so a 0.2.1 build also shipped the cached 0.1.0 `.deb`
and AppImage. Delete `bundle/deb` and `bundle/appimage` in the cache before a
release build, or filter by the current version. Check the printed collection
list, not just the exit code: the stale files look like successful outputs.

**A tab switch throws `RangeError: Position 30262 is out of range for changeset of length 2532`, and the command silently does nothing**
The numbers are two different documents: `2532` is the buffer on screen, `30262`
a position from a larger one. A restored `EditorState` carries CodeMirror's
`Language.state` parse context, whose `skipped` ranges belong to the document the
state was captured from; `view.dispatch({changes})` maps them through the new
change set and `ParseContext.changes` throws when one lies beyond the buffer. The
symptom is *not* an error: `runMenuAction` catches handler rejections and only
calls `toast(...)`, so Ctrl+N "does nothing" and the tab appears much later, when
an unrelated dispatch happens to succeed. No suite saw it because every fixture
is small. Drop the grammar — `languageCompartment.reconfigure([])` — before
replacing the buffer and immediately after `view.setState()`, then let
`setLanguage` install it again for the document on screen. Two habits follow: when
a menu command "does nothing", read `#toast` (and `Runtime.exceptionThrown`)
before touching the handler, and treat a state captured for one document as
unusable for another.

## Adding a preference, end to end

Five files, in this order — more than three, so a plan comes first; see
[Governance and workflow](#governance-and-workflow).

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

If the setting changes the editor's appearance, call it through
`applySyntaxTheme`/`applyLayout` rather than mutating the DOM directly.

## Code map

```
src/
  main.ts            shell: document lifecycle, menus, status bar, pane sync
  sessions.ts        open documents: one session per tab, one EditorState each
  editor.ts          CodeMirror 6 setup, incremental word/line metrics, EditorHandle API
  spellcheck.ts      spelling marks, language detection, suggestion menu
  markdown.ts        markdown → HTML; math extraction, mermaid, alerts, anchors
  html-preview.ts    sandboxed HTML guest: parse5 splice, iframe, bridge protocol
  html-bridge.js     guest-side scroll/click/keyboard bridge (inlined, not imported)
  html-language.ts   lazy CodeMirror HTML grammar
  syntax-themes.ts   editor palettes: token colours and writing surface
  image-syntax.ts    the one image markup builder for Markdown, Typst and HTML
  images.ts          paste, drop and download of images
  paste/             rich paste: IR, destination/source detection, readers,
                     renderers, HTML sanitizer and image resolution
  preferences.ts     the Preferences panel and its declarative rows
  sidebar.ts         outline (active-marker updates) / file list / recent files
  api.ts             typed wrappers over every Rust command
  highlight-theme.ts highlight.js theme swap, so code follows light/dark
  content.ts         the welcome, reference and shortcuts documents
  styles.css         all styling, light and dark
src-tauri/src/
  lib.rs             builder, plugin registration, command table
  html_preview.rs    preview scheme, CSP, path confinement, preview commands (+ tests)
  settings.rs        persisted settings and AppState
  documents.rs       file IO, directory listing, startup file
  images.rs          image import: sniffing, sanitiser, dedup, download
  tokens.rs          approximate token count for the status bar
  spellcheck.rs      OS spell checker: Windows ISpellChecker, Linux hunspell, macOS NSSpellChecker
  menu.rs            native menu construction and event routing
scripts/             build helpers and CDP test harnesses — every one is in
                     "Repository scripts", and a new one belongs there too
samples/             fixtures the smoke test asserts against
samples/html-tour/   offline HTML guest fixture
docs/samples/   real documents used to judge rendering quality
docs/plans/          one file per approved plan
docs/adr/            one decision that outlives its change
docs/ícones/         source archive for the application icon
```

Anything under `src/` or `src-tauri/src/` that you cannot place from this map is
probably in `main.ts`, which is the largest file and holds the shell: document
lifecycle, native menu routing, status bar, and pane sync.

## Conventions

- **Comments explain why.** The code says what it does. Comments in this repo
  record the reason a non-obvious choice was made, and the failure it prevents.
- **Record the traps you hit.** Anything that cost you time for a non-obvious
  reason goes into [Traps](#traps) before you finish, and every new script goes
  into [Repository scripts](#repository-scripts). Both sections are contracts with
  the next agent, not summaries for the reader.
- **Fail safe, not silent.** The line-anchor mapping drops the whole annotation
  when a token does not line up, rather than pointing at the wrong line. Keep
  that instinct.
- **Sanitise at the boundary.** Filenames, URLs and clipboard content are
  hostile until proven otherwise. `src-tauri/src/images.rs` is the reference for
  how much paranoia is expected, and each property has a test.
- **No dead controls.** Unimplemented options are `note` rows.
- **Relative paths in prose.** Link files by name, not absolute path.

## Releasing

One workflow does everything: `.github/workflows/release.yml`, triggered by
pushing a tag.

```bash
git tag -a v0.1.0 -m "MDraft 0.1.0"
git push origin master --follow-tags
```

What happens then:

1. **`check-version.mjs` runs first**, before the toolchain is even installed. It
   fails in seconds if the tag and the two version files disagree, instead of
   after a twenty-minute build.
2. **Two build jobs run in parallel**, `windows-latest` and `ubuntu-22.04`,
   `fail-fast: false` so one platform failing does not hide the other's result.
   Each runs `npm run dist` and stages into `bin/<os>/<arch>/`.
3. **Artefacts are uploaded even on failure** (`if: always()`), so a broken build
   can be downloaded and inspected rather than guessed at.
4. **A single release job** downloads both and creates the GitHub release. It is
   deliberately one job: two jobs racing to create the same release means the
   loser fails with a 422.

No secrets are configured. The release uses the token GitHub provides, which is
why the workflow asks for `contents: write` — the default token is read-only on
newer repositories.

`workflow_dispatch` re-runs the build for a tag that is already pushed, for when
a job failed and the tag should not move.

Three things are easy to get wrong here and are worth knowing:

- **Pushing `.github/workflows/` needs the `workflow` token scope.** A classic
  PAT with only `repo` is rejected with *"refusing to allow an OAuth App to
  create or update workflow ... without `workflow` scope"*, and the error names
  the file rather than the scope.
- **The Windows runner installs Visual Studio **Enterprise**.** `with-msvc.cmd`
  searched only `BuildTools` and `Community`, so CI would have failed with
  *"Could not find vcvars64.bat"* on a runner that has a complete toolchain. The
  Enterprise and Professional paths are now in the search list.
- **`APPIMAGE_EXTRACT_AND_RUN=1`** is set in the workflow. linuxdeploy, which
  Tauri runs to build the AppImage, is itself an AppImage and needs FUSE, which
  the runners do not have; the variable makes it run by extraction instead.
- **Release assets share one flat namespace.** Both platforms stage a
  `SHA256SUMS.txt` and a `manifest.json`, so uploading both silently keeps
  whichever finished last and discards the other platform's checksums. The first
  release shipped the Linux checksums alone for exactly this reason. The release
  job renames them to `SHA256SUMS-<platform>.txt` and `manifest-<platform>.json`
  before uploading; anything else added later with a platform-independent name
  needs the same treatment.

## Portable builds

`MDraft-portable.exe` is the ordinary Windows build compiled with one extra config
file, `src-tauri/tauri.portable.conf.json`. There is no portable code path: the
config sets `appDirectoriesOverride`, and Tauri applies it to its own path APIs
(`app_config_dir`, `app_data_dir`, and the webview's data directory) and to
plugins.

Two things follow from that, and both were verified rather than assumed:

- **`tauri-plugin-window-state` needs no change.** Its source hardcodes
  `app_config_dir().join(filename)` with no way to set the directory, which looks
  like it would strand `.window-state.json` in `%APPDATA%`. It does not: the
  override happens inside `app_config_dir()` itself, below the plugin. A portable
  run writes `.window-state.json` and `settings.json` into
  `<exe dir>/app-data/config/` and touches nothing in `%APPDATA%`.
- **Only `config` is redirected, on purpose.** `data` holds the pandoc download
  and the webview profile lives in the local data directory; both are large and
  volatile, and a Dropbox user does not want either synchronised.

`npm run dist` builds the portable variant first, parks it as
`target/release/<name>-portable.exe`, and then does the ordinary build, because
both passes write the same `target/release/mdraft.exe` and the staging step must
still find the ordinary one there. `--no-portable` skips the pass; it is skipped
automatically on Linux, where the AppImage is already a single self-contained
file.

`stage-artifacts.mjs` resolves bare binaries by listing `target/release` and
matching case-insensitively, rather than returning a path it constructed. The
names it looks for are guesses (`mainBinaryName`, `productName`, the Cargo
package, each possibly differing in case) and Windows matches them
case-insensitively while Linux does not, so a constructed path stages fine on one
platform and fails on the other.

## Release checklist

1. Bump `version` in `package.json` **and** `src-tauri/tauri.conf.json` — Tauri
   reads the latter for the bundle, and the two must agree. `npm run
   check:version` proves it, and CI runs the same check against the tag.
2. `npm run build` — typecheck plus frontend bundle.
3. `npm run test:rust` — 76 tests (one ignored: the pandoc download). Run them on Linux too
   (`cd ~/.cache/mdraft-build/src-tauri && cargo test`): the path tests are
   `#[cfg]`-split, so half of them never execute on either platform alone.
4. Launch with each fixture and run `npm run smoke`, `npm run math`,
   `npm run syntax` — 93 + 10 + 7 + 42 checks.
5. `npm run audit` against both `docs/sample-files` documents and compare the
   counts with the table in the README.
6. `npm run dist` — installers and checksums land in `bin/<os>/<arch>/`.
7. `.\scripts\test-close.ps1` — the release binary must exit on WM_CLOSE and
   write `.window-state.json`. Do not skip it: it passed in every other test and
   still failed in a shipped build once.
8. Install the MSI **and** the NSIS setup on a clean profile; confirm the icon and
   that the app starts with no console window. Note there are **no**
   `fileAssociations` in the bundle config, so the installer does not register
   `.md` — adding that would be a deliberate feature, not a fixed default.
9. Confirm the release binary still refuses to do anything on its own: no
   network at start-up, no telemetry, no licence check.
10. For Linux: `bash scripts/build-linux.sh`, then
    `sudo apt install -y ./bin/linux/amd64/*.deb` and launch `mdraft` from
    a WSLg or desktop session. Check the GTK menu bar, the outline, math and the
    status-bar icons.
11. Tag and push — CI builds both platforms and publishes the release. See
    [Releasing](#releasing).
