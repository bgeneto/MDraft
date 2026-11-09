# Development, build and debugging

Prerequisites, the build pipeline, the Linux build, the development loop
and the debugging tools.

Related: [scripts.md](scripts.md) for the command catalog,
[testing.md](testing.md) for the test layers,
[releasing.md](releasing.md) for the release flow.

## Prerequisites

- **Rust** 1.91+ (`x86_64-pc-windows-msvc` target on Windows)
- **Node.js** 20+ and npm; **Node 24** for the app-free suites. This repo uses
  **npm**; pnpm is not installed here. The application build works on Node 20/22
  (the release workflow uses 22), but suites such as `read-aloud:unit`,
  `p0:unit` and `test:sessions` import `.ts` sources directly. Node 22 is built
  without TypeScript support; Node 24 strips the types.
- **Python 3** with `fonttools` and `brotli`, only to refresh the bundled fonts
  through `scripts/fetch-fonts.ps1`. Ordinary builds and the test suite do not
  need Python.
- **Windows**: Visual Studio C++ build tools, Windows SDK, WebView2 runtime
- **macOS**: Xcode command line tools
- **Linux**: `webkit2gtk-4.1`, `libayatana-appindicator3`, `librsvg2`, `patchelf`, `libhunspell-dev` (spelling; the dictionaries themselves are `hunspell-en-us` and `hunspell-pt-br`, which are not bundled)
- **PDF visual tests only**: Poppler (`pdfinfo`, `pdffonts`, `pdftotext`, `pdfimages`, `pdftoppm`). On Windows the commands are usually run through WSL (`--rasterizer wsl`); on Debian install `poppler-utils`. Poppler is never bundled or called by the application.

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

On Linux the product name is lowercase `mdraft`, set in
`src-tauri/tauri.linux.conf.json`: dpkg derives its `Package:` field by
kebab-casing `productName`, so `MDraft` installed as `m-draft`. Everything users
read stays capitalised — the launcher label is the literal `Name=MDraft` in
`src-tauri/linux.desktop.hbs`, and the base config still names Windows and macOS
artefacts and the manifest. Linux artefacts are therefore
`mdraft_<version>_amd64.deb` and `mdraft_<version>_amd64.AppImage`. The deb
declares `Replaces`/`Conflicts: m-draft` so installing it over the old package
is an upgrade rather than a file conflict.

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

`ai-prompts.md` sits beside it and holds the reader's prompt overrides: the same
rule applies, and `scripts/test-all.mjs` backs it up and restores it with the
settings. Deleting only `settings.json` leaves the prompts in force.

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
