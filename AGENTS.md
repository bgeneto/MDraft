# AGENTS.md

Working guide for this repository: how to build it, test it, debug it, which
scripts exist, and which traps have already cost time. **Read only the guide your
task needs** — each heading below is a link target that points at the detailed
file under `docs/agent-guide/`.

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

A **Markdown, Typst, LaTeX, HTML and AsciiDoc** editor: a **Rust/Tauri 2
backend** and a **TypeScript frontend** that runs in the platform webview. There
is no HTTP server and no Node runtime in the shipped application; the HTML
preview is an in-process URI scheme, not a socket.

The frontend **cannot** touch the filesystem. Every file operation is a
`#[tauri::command]` in Rust, called through the wrappers in `src/api.ts`.

Two rules that are not negotiable, both documented in the README:

1. **No telemetry, and no start-up network activity.** The only outbound requests
   the application makes itself are `images::download_image`, reached by a user
   pasting or dropping an image URL or by pasting rich content that contains
   remote images, and the AI Assistant's
   `ai_complete`/`ai_fetch_models`/`ai_suggest_filename`, reached only after the
   reader enables the assistant, configures an endpoint and presses Generate,
   Fetch, or Save on an untitled document with *Suggest file names when saving*
   turned on. Both are user actions; *Preferences › Image* can turn each image
   request off, and the assistant is off by default. An HTML document the reader
   opens may request the resources its own markup links; that is the document's
   request, not the application's. The LaTeX engine is one additional
   user-initiated exception: after the reader explicitly enables it, MDraft
   downloads verified engine assets and fetches missing TeX Live packages and
   fonts from its pinned mirror. It does not send document or bibliography
   contents. An installed TeX distribution, when the reader selects one, is a
   separate external program: it runs with the reader's permissions and may use
   the network to install its own packages. MDraft does not control or monitor
   that traffic; shell escape and project executables remain disabled. The LaTeX
   formatter is the same kind of exception at a smaller scale: the first Format
   Document on a `.tex` file downloads the pinned tex-fmt WebAssembly module
   (about 1.7 MB, SHA-256 verified, cached under the app data directory), and
   every later format runs offline.
2. **No dead UI.** If a Typora option is not implemented, the Preferences panel
   shows a note explaining that, never a control that does nothing.

The Rust/TypeScript split in full, the annotated code map and the end-to-end
preference walkthrough: [architecture.md](docs/agent-guide/architecture.md).

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
what you skipped. When the two cases are not obvious, ask in one line —
"implement directly, or do you want a plan?" — rather than producing a plan out
of caution.

When a plan is required: investigate read-only first, write it to
`docs/plans/YYYY-MM-DD-short-slug.md` following the template in
[docs/plans/README.md](docs/plans/README.md), and **stop and wait for explicit
approval** before implementing anything. Set the status to `approved` when
approval arrives: the file, not the conversation, is what a later session can
read. While executing, tick the checkboxes, record deviations in the plan
itself, and never widen the scope without updating it. A durable architectural
decision becomes an ADR in `docs/adr/` (template in
[docs/adr/README.md](docs/adr/README.md)); ADRs are superseded, never rewritten.
When the work is done, update the status and the documentation the change
touched, and leave the plan in `docs/plans/` as the record of what was agreed.

The licensing position (MIT today, AGPL an allowed destination), how a
dependency's cost is measured, the full plan format and the project conventions:
[workflow.md](docs/agent-guide/workflow.md).

## Recording traps is required

**If you lose time to something that was not obvious, add it to the right trap
file before you finish the task.** Do not wait to be asked, and do not decide it
is too small. The entry that saves the next agent an hour is usually the one that
felt embarrassing to write down. Quote the literal error text, say how you found
it, and record the false conclusion you almost published — not just the final
answer.

An event is a trap only when you were wrong or a tool lied to you, it is not
obvious from the code or the error text, and it can happen again to another
agent. Do not record one when it belongs somewhere more specific: a wrong
`bundle.icon` path belongs in a fix and a test, not in a list of symptoms.

The trap record is split by domain so a task loads one file, not all of them.
Start at [traps.md](docs/agent-guide/traps.md) for the domain index, the entry
format and the literal-text search examples:

```powershell
rg -n "<literal error text>" docs/agent-guide/traps
```

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
- **Linux**: `webkit2gtk-4.1`, `libayatana-appindicator3`, `librsvg2`,
  `patchelf`, `libhunspell-dev` (spelling; the dictionaries themselves are
  `hunspell-en-us` and `hunspell-pt-br`, which are not bundled)
- **PDF visual tests only**: Poppler (`pdfinfo`, `pdffonts`, `pdftotext`,
  `pdfimages`, `pdftoppm`). On Windows the commands are usually run through WSL
  (`--rasterizer wsl`); on Debian install `poppler-utils`. Poppler is never
  bundled or called by the application.

### Windows: everything through `scripts\with-msvc.cmd`

**On Windows, every cargo or Tauri invocation must go through
`scripts\with-msvc.cmd`** (or `scripts\cargo-vcvars.cmd` for cargo). Rust finds
the MSVC toolchain and Windows SDK through the registry; when the registered SDK
version and the on-disk directory disagree — this host registers
`ProductVersion 10.0.26100` while the folder is `10.0.26100.0` — that lookup
never exports `INCLUDE`/`LIB`, and the build dies with
`C1083: cannot open include file 'windows.h'` or
`LNK1181: cannot open input file 'windows.h'`. Loading `vcvars64.bat` first fixes
it:

```powershell
.\scripts\with-msvc.cmd npm run tauri dev
.\scripts\cargo-vcvars.cmd check --manifest-path src-tauri\Cargo.toml
.\scripts\cargo-vcvars.cmd test  --manifest-path src-tauri\Cargo.toml
```

`npm run dist` handles this itself, which is why it is the recommended entry
point. On macOS and Linux the wrappers are unnecessary and plain commands work.

The full prerequisite list and the wrapper explanation:
[development.md](docs/agent-guide/development.md#prerequisites).

## Repository scripts

Everything in `scripts/` is documented. **If you add a script, add it to one of
the catalog files in the same change** — an undocumented script is one the next
agent will rewrite from scratch.

[scripts.md](docs/agent-guide/scripts.md) is the index: it names each subject
catalog, says what each covers, and carries the conventions every new CDP test
script must follow (port as `argv[2]`, `Runtime.enable` first, throw on
`exceptionDetails`, one `PASS`/`FAIL` line per check, non-zero exit, no
`node -e` snippets). The full rows — command, what it runs, what it does — live
in `docs/agent-guide/catalog/`.

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
`extends` key, which Tauri rejects with
`Additional properties are not allowed`.

The pipeline in full and the staging rules:
[development.md](docs/agent-guide/development.md#build-pipeline). The scripts:
[catalog/build-and-site.md](docs/agent-guide/catalog/build-and-site.md).

## Building for Linux

Cross-compiling from Windows is not possible: Tauri resolves `webkit2gtk-4.1`,
`javascriptcoregtk-4.1`, `libsoup-3.0` and `gtk+-3.0` through `pkg-config`, and
there is no usable Windows sysroot for them. Build inside Linux — WSL2, a
container, or a runner:

```powershell
wsl -e bash -lc 'cd /mnt/c/Users/reader/Documents/GitHub/MDraft && bash scripts/build-linux.sh'
```

`scripts/build-linux.sh` rsyncs the sources into `~/.cache/mdraft-build` before
building (`/mnt/c` is an order of magnitude slower for cargo, and its file
locking over 9p is unreliable; override with `MDRAFT_BUILD_DIR`), works without
Node by reusing the pre-built `dist/`, and accepts either `cargo-tauri` or
`npx tauri`.

On Linux the product name is lowercase `mdraft`, set in
`src-tauri/tauri.linux.conf.json`: dpkg derives its `Package:` field by
kebab-casing `productName`, so `MDraft` installed as `m-draft`. Everything users
read stays capitalised — the launcher label is the literal `Name=MDraft` in
`src-tauri/linux.desktop.hbs`. Linux artefacts are therefore
`mdraft_<version>_amd64.deb` and `mdraft_<version>_amd64.AppImage`, and the deb
declares `Replaces`/`Conflicts: m-draft` so installing it over the old package is
an upgrade rather than a file conflict.

Verified results and the full explanation:
[development.md](docs/agent-guide/development.md#building-for-linux).

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
pure rendering work — except anything that calls into Rust, which needs the Tauri
shell.

[development.md](docs/agent-guide/development.md#development-loop)

## Debugging

Launch with WebView2 remote debugging enabled, then drive it over the Chrome
DevTools Protocol:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
.\src-tauri\target\release\MDraft.exe "C:\path\to\doc.md"
```

`http://127.0.0.1:9222/json/list` lists targets. Node's built-in `WebSocket`
speaks CDP with **no extra packages**, which is the pattern every script in
`scripts/` uses. **`Runtime.enable` first**, or events are not delivered;
**`awaitPromise: true`** for async expressions; and **check
`r.result.exceptionDetails`** — a rejected promise in the page arrives as a
*successful* CDP response with the error inside, and ignoring it turns failures
into passes. Generic browser-automation tooling tends to **time out** against the
WebView2 endpoint on this host; speak CDP directly.

**In release builds Rust output is discarded.** `src-tauri/src/main.rs` sets
`windows_subsystem = "windows"` when `debug_assertions` is off, so the process
has no console and `println!`/`eprintln!` go nowhere. When a release-only problem
needs Rust-side output, attach a debugger or add a logging crate that writes to a
file — do not assume a `println!` will be seen.

**Delete `settings.json` before running any UI test** — a persisted `viewMode`,
`theme` or `syntaxTheme` from a previous run changes what the test sees and
produces confusing failures. `ai-prompts.md` sits beside it and holds the
reader's prompt overrides: deleting only `settings.json` leaves the prompts in
force.

```powershell
Remove-Item "$env:APPDATA\io.github.bgeneto.mdraft\settings.json" -Force
```

Settings live in `%APPDATA%\io.github.bgeneto.mdraft\settings.json` on Windows
(`~/Library/Application Support/…` on macOS, `~/.config/…` on Linux).

The CDP snippet, the logging detail, the state paths and the screenshot-measuring
commands: [development.md](docs/agent-guide/development.md#debugging).

## Testing

Fifty-nine default layers, cheapest first, plus opt-in layers. **Run them in
order when changing anything**, and run the cheapest layer that can catch the
mistake rather than the whole suite out of habit.

`npm test` (`scripts/test-all.mjs`) runs that table in that order. It exists
because the layers are not self-contained: it builds first, gives every UI suite
its own freshly launched instance, its own port and its own fixture, starts each
one from first-run state, runs the restart layers as two launches of one settings
directory — the first closed with WM_CLOSE so the flush runs, the second started
with no document argument — stages the binary outside the workspace (an
executable launched from inside it cannot write `%APPDATA%`, which is exactly
what the close test asserts), and closes everything it started on every exit
path. `--no-build` tests the binary already built, `--only`/`--skip` narrow the
run, `--all` adds the pandoc export and the image paste checks, and `--list`
enumerates the layers. **Before touching state, the harness refuses any running
user MDraft**, including installed and portable copies outside the repository; it
closes only owned test leftovers. A private webview folder or CDP port does not
isolate the app identifier.

The frontend quality gates are separate from the functional table: `npm run
format:check`, `npm run lint` and `npm run knip`, run by the `Quality` workflow
with `npm run build`, the app-free unit layers and
`cargo clippy --all-targets -- -D warnings`.

The ordered layer table with each row's description, the runner's full
behaviour, the CDP setup, the Linux print probe and what an assertion is worth:
[testing.md](docs/agent-guide/testing.md). Per-layer descriptions live in
`docs/agent-guide/catalog/`.

## Traps

The trap record is split by domain so a task loads one file, not all of them.
Start at [traps.md](docs/agent-guide/traps.md) for the domain index, the
qualification rules, the entry format and the search examples:

```powershell
rg -n "<literal error text>" docs/agent-guide/traps
```

Each entry's first line is its bold symptom, so `rg -n "^\*\*"` lists every
symptom in a file. The list is append-only in spirit: do not delete an entry
because the fix landed, because the fix is what makes it recur.

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

A **size** preference remembered per typography preset touches two more places,
and a CSS-variable size must reach the export wrappers or the setting stops at
the preview. The per-file detail:
[architecture.md](docs/agent-guide/architecture.md#adding-a-preference-end-to-end).

## Code map

`src/` is the frontend: `main.ts` (the shell — document lifecycle, native menu
routing, status bar, pane sync), `sessions.ts`, `editor.ts`, `markdown.ts`,
`html-preview.ts`, `asciidoc-preview.ts`, `typst-*.ts`, `latex*.ts`,
`preferences.ts`, `api.ts`, `styles.css`, plus the `ai/`, `paste/` and `format/`
directories. `src-tauri/src/` is the backend: `lib.rs` (builder, plugins, command
table), `documents.rs`, `settings.rs`, `menu.rs`, `images.rs`, `clipboard.rs`,
`print.rs`, `recovery.rs`, `tex_fmt.rs`, `spellcheck.rs`, `html_preview.rs`,
`speech.rs`, and the `ai/` directory.

Anything under `src/` or `src-tauri/src/` that you cannot place from the map is
probably in `main.ts`, which is the largest file and holds the shell.

The full annotated tree:
[architecture.md](docs/agent-guide/architecture.md#code-map).

## Conventions

- **Comments explain why.** The code says what it does. Comments in this repo
  record the reason a non-obvious choice was made, and the failure it prevents.
- **Record the traps you hit.** Anything that cost you time for a non-obvious
  reason goes into the trap record before you finish, and every new script goes
  into one of the catalogs. Both are contracts with the next agent, not
  summaries for the reader.
- **Fail safe, not silent.** The line-anchor mapping drops the whole annotation
  when a token does not line up, rather than pointing at the wrong line. Keep
  that instinct.
- **Sanitise at the boundary.** Filenames, URLs and clipboard content are hostile
  until proven otherwise. `src-tauri/src/images.rs` is the reference for how much
  paranoia is expected, and each property has a test.
- **No dead controls.** Unimplemented options are `note` rows.
- **Relative paths in prose.** Link files by name, not absolute path.

## Releasing

One workflow does everything: `.github/workflows/release.yml`, triggered by
pushing a tag.

```bash
git tag -a v0.1.0 -m "MDraft 0.1.0"
git push origin master --follow-tags
```

`check-version.mjs` runs first, before the toolchain is even installed, and fails
in seconds if the tag and the two version files disagree. Two build jobs then run
in parallel (`windows-latest`, `ubuntu-22.04`) with `fail-fast: false`; artefacts
upload even on failure (`if: always()`); and a single release job creates the
GitHub release, deliberately one job because two racing to create the same
release loses with a 422. `workflow_dispatch` re-runs the build for a tag that is
already pushed.

Four things are easy to get wrong here: pushing `.github/workflows/` needs the
`workflow` token scope; the Windows runner installs Visual Studio **Enterprise**,
which `with-msvc.cmd` must search; `APPIMAGE_EXTRACT_AND_RUN=1` is set because
linuxdeploy is itself an AppImage and the runners have no FUSE; and release
assets share one flat namespace, so the two platforms' `SHA256SUMS.txt` and
`manifest.json` are renamed per platform before upload.

The full release flow and the landing page (GitHub Pages, bilingual, validated by
`npm run site`): [releasing.md](docs/agent-guide/releasing.md).

## Portable builds

`mdraft_<version>_x64-portable.exe` is the ordinary Windows build compiled with
one extra config file, `src-tauri/tauri.portable.conf.json`. There is no portable
code path: the config sets `appDirectoriesOverride`, and Tauri applies it to its
own path APIs and to plugins. Only `config` is redirected, on purpose — `data`
holds the pandoc download and the webview profile, both large and volatile.

`npm run dist` builds the portable variant first, parks it as
`target/release/<name>-portable.exe`, then does the ordinary build, because both
passes write the same `target/release/mdraft.exe`. `--no-portable` skips the
pass; it is skipped automatically on Linux.

The staging rules, the name-case rules and the verification:
[releasing.md](docs/agent-guide/releasing.md#portable-builds).

## Release checklist

1. Bump `version` in `package.json` **and** `src-tauri/tauri.conf.json`;
   `npm run check:version` proves they agree.
2. `npm run build` — typecheck plus frontend bundle.
3. `npm run test:rust` — and run it on Linux too, because the path tests are
   `#[cfg]`-split and half of them never execute on either platform alone.
4. Launch with each fixture and run the UI suites the change touches.
5. `npm run audit` against both `docs/sample-files` documents.
6. Refresh `site/` if the feature list changed, then `npm run site`.
7. `npm run dist` — installers and checksums land in `bin/<os>/<arch>/`.
8. `.\scripts\test-close.ps1` — the release binary must exit on WM_CLOSE and
   write `.window-state.json`. Do not skip it: it passed in every other test and
   still failed in a shipped build once.
9. Install the MSI **and** the NSIS setup on a clean profile; confirm the icon
   and that the app starts with no console window. There are **no**
   `fileAssociations` in the bundle config, so the installer does not register
   `.md`.
10. Confirm the release binary still refuses to do anything on its own: no
    network at start-up, no telemetry, no licence check.
11. For Linux: `bash scripts/build-linux.sh`, install the `.deb`, and check the
    GTK menu bar, the outline, math and the status-bar icons.
12. Tag and push — CI builds both platforms and publishes the release.

The numbered checklist with the exact commands, the suite counts and the Linux
package checks: [releasing.md](docs/agent-guide/releasing.md#release-checklist).
