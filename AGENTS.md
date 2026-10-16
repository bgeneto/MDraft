# AGENTS.md

Working guide for this repository: how to build it, test it, debug it, which
scripts exist, and which traps have already cost time.

- [Orientation](#orientation)
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
- [Release checklist](#release-checklist)

## Orientation

A markdown editor: a **Rust/Tauri 2 backend** and a **TypeScript frontend** that
runs in the platform webview. There is no HTTP server and no Node runtime in the
shipped application.

The split matters constantly:

| Lives in Rust (`src-tauri/src/`) | Lives in TypeScript (`src/`) |
| --- | --- |
| Reading and writing files | Markdown → HTML (`marked` + `DOMPurify`) |
| Directory listing, path existence | CodeMirror 6 editor and keymaps |
| Settings persistence | Preview rendering, KaTeX, Mermaid, highlight.js |
| Native menus | Pane sync, sidebar, Preferences panel |
| Image import and download | Paste and drop handling |

The frontend **cannot** touch the filesystem. Every file operation is a
`#[tauri::command]` in Rust, called through the wrappers in `src/api.ts`.

Two rules that are not negotiable, both documented in the README:

1. **No licensing, telemetry, or start-up network activity.** The only outbound
   request in the codebase is `images::download_image`, reached solely by a user
   pasting or dropping an image URL.
2. **No dead UI.** If a Typora option is not implemented, the Preferences panel
   shows a note explaining that, never a control that does nothing.

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
- **Linux**: `webkit2gtk-4.1`, `libayatana-appindicator3`, `librsvg2`, `patchelf`

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
| `npm run check:rust` | `cargo check` | Fastest Rust feedback |
| `npm run test:rust` | `cargo test` | 38 tests, on Windows and on Linux |
| `npm run smoke` | `scripts/dom-smoke.mjs` | 59 checks against `samples/feature-tour.md` |
| `npm run audit` | `scripts/audit-document.mjs` | Render metrics for whatever document is loaded |
| `npm run math` | `scripts/math-render-check.mjs` | 10 checks against the physics paper |
| `npm run syntax` | `scripts/syntax-theme-test.mjs` | 7 checks that highlighting is real |
| `npm run export` | `scripts/export-test.mjs` | 26 checks of every export path, against real pandoc |
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
| `math-render-check.mjs` | `[port]` | `docs/sample-files/physrevb_70_035307.md` | That fonts actually load and that fractions and radicals have real geometry |
| `syntax-theme-test.mjs` | `[port]` | `samples/feature-tour.md` | Distinct computed token colours, and that switching palette changes them |
| `export-test.mjs` | `[port] [--install]` | `samples/feature-tour.md` | That pandoc really converts: the bytes of each output are inspected. `--install` additionally exercises the pandoc download, which is why it is opt-in |
| `image-paste-test.mjs` | `[port] [imageUrl] [localPath]` | `samples/feature-tour.md` | Clipboard, local and remote image paths, and the markdown that results |
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
| `with-msvc.cmd` | `<command> [args…]` | Loads `vcvars64.bat` then runs the command. **Required for every cargo or tauri invocation on this host** |
| `cargo-vcvars.cmd` | `<cargo args…>` | The same wrapper specialised for cargo: `cargo-vcvars.cmd test --manifest-path src-tauri\Cargo.toml` |

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

Seven layers, cheapest first. Run them in this order when changing anything.

| Layer | Command | Count | Catches |
| --- | --- | --- | --- |
| Typecheck | `npm run build` | — | Type errors, unused imports |
| Rust unit | `npm run test:rust` | 23 | Path handling, sanitisers, file IO, settings |
| DOM smoke | `npm run smoke` | 59 | Rendering, pane sync, preferences, math, fonts, status icons |
| Math | `npm run math` | 10 | Font loading, fraction and radical geometry |
| Syntax | `npm run syntax` | 7 | Token colours, palette switching |
| Close | `.\scripts\test-close.ps1` | 4 | The window really exits and saves its state |
| Document audit | `npm run audit` | — | Real-world render quality on big files |

The close test is PowerShell rather than CDP because it has to kill the
application, which no DOM test can survive. It launches the release binary, sends
WM_CLOSE — exactly what the title-bar X sends — and asserts that the process
exits and that `.window-state.json` was written. Run it after any change to
`capabilities/default.json`.

### Running the CDP tests correctly

**Each test needs the app open with the right document.** The smoke test asserts
against `samples/feature-tour.md`; the math test against
`docs/sample-files/physrevb_70_035307.md`. Running a test against the wrong
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

## Adding a preference, end to end

Five files, in this order:

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
  editor.ts          CodeMirror 6 setup, EditorHandle API, heading/task helpers
  markdown.ts        markdown → HTML; math extraction, mermaid, alerts, anchors
  syntax-themes.ts   editor palettes: token colours and writing surface
  images.ts          paste, drop and download of images
  preferences.ts     the Preferences panel and its declarative rows
  sidebar.ts         outline / file list / recent files
  api.ts             typed wrappers over every Rust command
  highlight-theme.ts highlight.js theme swap, so code follows light/dark
  content.ts         the welcome, reference and shortcuts documents
  styles.css         all styling, light and dark
src-tauri/src/
  lib.rs             builder, plugin registration, command table
  settings.rs        persisted settings and AppState
  documents.rs       file IO, directory listing, startup file
  images.rs          image import: sniffing, sanitiser, dedup, download
  menu.rs            native menu construction and event routing
scripts/             build helpers and CDP test harnesses — all 14 are in
                     "Repository scripts", and a new one belongs there too
samples/             fixtures the smoke test asserts against
docs/sample-files/   real documents used to judge rendering quality
docs/screenshots/    reference captures of Typora beside this build
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

## Release checklist

1. Bump `version` in `package.json` **and** `src-tauri/tauri.conf.json` — Tauri
   reads the latter for the bundle, and the two must agree.
2. `npm run build` — typecheck plus frontend bundle.
3. `npm run test:rust` — 38 tests. Run them on Linux too
   (`cd ~/.cache/mdraft-build/src-tauri && cargo test`): the path tests are
   `#[cfg]`-split, so half of them never execute on either platform alone.
4. Launch with each fixture and run `npm run smoke`, `npm run math`,
   `npm run syntax` — 59 + 10 + 7 checks.
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
