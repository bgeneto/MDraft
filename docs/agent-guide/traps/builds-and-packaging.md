# Build and packaging traps

The bundle, staging, installer and release-artifact problems: what `npm run dist` produces and what it silently keeps.

Part of [the trap record](../traps.md). Search across every domain with:

```powershell
rg -n "<literal error text>" docs/agent-guide/traps
```

**`msiexec /i ... ALLUSERS=2 MSIINSTALLPERUSER=1 INSTALLDIR=T:\Temp\...` fails with `Error 1321 ... C:\Program Files\MDraft\mdraft.exe. System Error 5`**
The MSI's `AppSearch` can replace the requested `INSTALLDIR` with an existing MDraft installation path from the registry before `InstallFinalize`. A registry query inside the ordinary sandbox did not show the machine-wide installation; an escalated query did. In the observed attempt Windows refused the overwrite, the old product remained registered, and the old executable kept its original size and timestamp, but the test was not an isolated installation. Check the registry and the installer's AppSearch behavior outside the sandbox first; use a genuinely clean VM/sandbox instead of relying on `INSTALLDIR` to protect an existing installation.

**`Additional properties are not allowed ('extends' was unexpected)`**
`tauri.<platform>.conf.json` merges onto the base config implicitly. Remove
`extends`.

**`npm run dist` succeeds but `bin/` is empty**
`stage-artifacts.mjs` exits non-zero with the path it searched when it finds no
bundles. Check the bundle kind is in its `BUNDLE_KINDS` map.

**A plain `cargo build` debug binary shows a blank window**
Debug builds load `devUrl` (`http://localhost:1420`), not the embedded `dist/`, so
with no dev server running the window appears with no frontend at all: no JS, no
title, no close listener. Anything concluded from a debug binary is worthless
unless the dev server was up. This produced a confidently wrong "release is
broken, debug is fine" conclusion once. To trace Rust events in a release build,
add temporary `eprintln!` and launch with `Start-Process -RedirectStandardError`;
the redirected handle still receives output from a
`windows_subsystem = "windows"` process.

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

**`failed to run custom build command for mdraft ... exit code: 0xc0000142, STATUS_DLL_INIT_FAILED`**
When `CARGO_TARGET_DIR` is not redirected out of the workspace, the Windows agent
sandbox denies DLL initialization (`0xc0000142`) to newly compiled executables
whose backing file lives inside `src-tauri\target\release\build\mdraft-*\build-script-build.exe` —
the same sandbox rule that prevents an un-staged `mdraft.exe` inside the workspace
from reaching `%APPDATA%`. Deleting `deps\*build_script_build*` does not touch
`build\mdraft-*\build-script-build.exe` and a recompiled binary at that path hits
the same `0xc0000142`. Temporarily replace `src-tauri\target\release\build\mdraft-<hash>`
with a directory junction (`cmd /c mklink /J`) to a folder in `$env:TEMP` for the
`tauri build --no-bundle` pass, then remove the junction (`cmd /c rmdir`) and
copy the folder back so Cargo keeps its warm `src-tauri\target\release\deps` cache
without leaving a junction in the tree.

**Renaming the product leaves stale bundles that staging will happily ship**
`src-tauri/target/release/bundle/` is not cleaned between builds, so after
changing `productName` the directory held two installers: one under the new name
and one under the previous one. `stage-artifacts.mjs` copied every file matching
the extension, so `bin/<os>/<arch>/` ended up offering both, with the wrong one
just as prominent. The same happens on a version bump. Staging now requires the
filename to contain both the current bundle name and `version`, and fails
loudly naming the directory when nothing matches — where the bundle name comes
from the platform config, not the base one, because Linux lowercases it.

The Linux rename from `MDraft` to `mdraft` makes the collision certain rather
than occasional, since the cache keeps the previous build. `scripts/build-linux.sh`
therefore clears `bundle/{deb,rpm,appimage}` before building.

Renaming is more than a find-and-replace. The name lives in eight shapes, and
missing one fails in a way that does not point at the cause:

| Shape | Where | Example |
| --- | --- | --- |
| Cargo package (kebab) | `Cargo.toml`, names the binary | `mdraft` |
| Rust lib (snake) | `Cargo.toml` `[lib]`, used by `main.rs` | `mdraft_lib` |
| `productName` | `tauri.conf.json`, names every bundle | `MDraft` |
| `productName` (Linux) | `tauri.linux.conf.json`, kebab-cased into dpkg's `Package:` | `mdraft` |
| Desktop label | `linux.desktop.hbs` `Name=` (a literal since the Linux rename) | `MDraft` |
| `identifier` | `tauri.conf.json`, **moves the settings directory** | `io.github.bgeneto.mdraft` |
| npm package | `package.json` and the lock file | `mdraft` |
| Display strings | window title, menus, About, welcome document | `MDraft` |

The bare binary is named after the **Cargo package**, not `productName`, and
Tauri renames it to `productName` only inside the bundle. `stage-artifacts.mjs`
therefore reads the package name out of `Cargo.toml` and tries
`mainBinaryName`, both product names and the package name in turn.

Changing the `identifier` silently relocates settings and window state, because
both live under `%APPDATA%\<identifier>`. That is a user-visible reset; do it
deliberately, and say so, rather than as a side effect.

**`appDirectoriesOverride` reaches below the plugin**
`tauri-plugin-window-state` hardcodes `app_config_dir().join(filename)` with no
API to redirect the directory, which makes it look like a portable build would
strand `.window-state.json` in `%APPDATA%`. It does not: the override is applied
inside `app_config_dir()` itself, so the plugin follows without a change. Verified
by running the portable build in an empty folder — settings and window state both
landed beside the executable and the `%APPDATA%` copies kept their old
timestamps.

**A file in the repository is not a file in the application**
Vite bundles only what is imported. The OFL licence texts were committed
next to the fonts, documented in the README, and referenced from nothing — so
every installer shipped the fonts without the licence they are distributed
under, which is exactly what the SIL Open Font License forbids. They are now
imported with `?raw` into `content.ts` and shown under *Help › Font Licences*.
Searching the built executable for the text proves nothing either way: the
frontend bundle is compressed inside it, so the licence reads as absent even
when present. Verify in the running application.

**`bin/linux/amd64` offers both the old and the new version after a version bump**
`build-linux.sh` copies every `.deb`/`.AppImage` it finds under
`~/.cache/mdraft-build/src-tauri/target/release/bundle/`, and the cache is not
cleared by rsync, so a 0.2.1 build also shipped the cached 0.1.0 `.deb` and
AppImage. The script now clears `bundle/{deb,rpm,appimage}` before building, so
only what this build produced can be collected; if you collect by hand instead,
delete those directories first. Check the printed collection list, not just the
exit code: the stale files look like successful outputs.

**`npm test -- --no-build` / a hand-built binary shows `asset not found: index.html` or a `chrome-error://chromewebdata/` page, while `npm run build` succeeds**
The release executable was linked **without** the frontend. A plain
`cargo build --release` does not run Tauri's asset codegen, and `tauri build`
itself can reuse a stale `target/release/build/mdraft-*/out` when only `dist/`
changed. The tell is size: 19.5 MB with the frontend embedded, about 12.1 MB
without. Delete `target/release/mdraft.exe` and
`target/release/build/mdraft-*` (or touch `tauri.conf.json`) and build through
`npm run tauri -- build --no-bundle`. After that, check the page loads before
blaming a UI suite.
