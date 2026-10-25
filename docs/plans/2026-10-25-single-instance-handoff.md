# Reliable second-launch handoff and multi-file opening

**Status:** in progress — Phase 1 approved 2026-10-25; Phase 2 (file
associations) remains a separate approval gate
**Date:** 2026-10-25
**ADR:** [Single-instance boundary](../adr/2026-10-25-single-instance-boundary.md)
— delivered architecture recorded during the corrective review.

## Context and goal

MDraft has no single-instance boundary. Starting a second copy while one is open
does not reach the existing window: on Windows the second process tries to
create a WebView2 environment for the same user-data folder and dies with
`HRESULT(0x800700AA)`, which AGENTS records as a trap. Opening a file from
Explorer, a terminal or a shortcut therefore has no predictable path into the
running editor.

`documents.rs::startup_file` returns only `std::env::args().nth(1)`, so an
initial launch with several paths opens one and silently ignores the rest. The
frontend already listens for `open-files` (used by macOS `RunEvent::Opened`), and
`openPath` already focuses an existing tab instead of duplicating it — but on
Windows and Linux nothing produces that event from a second launch.

`tauri.conf.json` registers no file associations, so a double-click on a `.md`
file does not start MDraft at all unless the reader has chosen it in “Open
with”. GAP-017's P1 slice is the handoff; association registration is its P2
slice. This plan keeps them as two explicit phases, because the second changes
installer behaviour and cannot be validated by the same test.

**What the Tauri 2 plugin does and does not do.** Tauri 2 has no single
`tauri.conf.json` flag for this. The official
`tauri-plugin-single-instance` is a Rust dependency registered before every
other plugin. It keeps one process, passes the second launch's `(args, cwd)` to
the running instance, and lets the second process exit *before* it creates a
WebView — which also removes the `0x800700AA` failure. It does **not** itself
open a tab, and it does **not** register file associations. Those are the two
pieces of work below.

**Answer to the double-click question.** With the plugin plus an argv handler,
double-clicking a Markdown file opens it in a new tab of the running window
instead of a second window — *provided the operating system actually starts
MDraft for that file*. Today it does not, because no association is registered.
Registering one is Phase 2. On Windows 10/11 the installer can register MDraft
as a handler and add it to “Open with”, but it cannot silently take over an
extension another application already owns; the user's existing default wins
until they choose MDraft in Settings. On Linux the `.desktop` file's
`MimeType=` and the desktop database decide. The portable build and the
AppImage have no installer step, so they cannot register associations; they
still receive paths via “Open with”, a terminal or a drag onto the executable.

## Scope and non-scope

**Phase 1 — P1, the handoff**

- Add `tauri-plugin-single-instance` and register it first.
- Parse a second launch's arguments in Rust with a pure, tested function: skip
  the executable and flags, resolve relative paths against the supplied `cwd`,
  keep the order, and do not drop an argument merely because the file is
  missing (the frontend must report it).
- Queue forwarded paths in managed Rust state and emit `open-files`; the
  frontend drains the queue after installing its listener, so a launch that
  arrives during boot is not lost. Duplicate delivery is harmless because
  `openPath` focuses an existing tab.
- Focus and raise the existing window (unminimise, show, focus).
- Add `startup_files` for the initial launch; open every path as a tab, report
  each failure as a toast and continue with the rest.
- Keep the dirty-buffer, recovery and tab-restore behaviour untouched.

**Phase 2 — P2, association registration (separate approval gate in this plan)**

- `bundle.fileAssociations` for Markdown, Typst and AsciiDoc:
  `.md`, `.markdown`, `.mdown`, `.mkd`; `.typ`; `.adoc`, `.asciidoc`.
  `.html` is deliberately excluded: claiming the system's web-page handler is
  an aggressive default, not an editor convenience.
- Windows NSIS and MSI registration; Linux deb desktop `MimeType`; uninstall
  cleanup.
- Test on a clean profile and with another editor already owning `.md`.

**Non-scope**

- True multi-window (separate window state, recovery ownership and settings
  arbitration); it remains a later P3 decision.
- Forcing MDraft to become the default handler, or bypassing Windows' user
  choice model.
- macOS associations and handoff (macOS is not published); keep the existing
  `RunEvent::Opened` path.
- Portable/AppImage association registration.
- Drag-and-drop inside the window, which already works.
- Changing `startup_file` or `open-files` payloads. `startup_files` is additive.

## Approach and rejected alternatives

**Chosen approach: the official plugin as the process boundary, a Rust argv
queue as the contract, and the existing frontend as the tab authority.**

1. **Dependency and order.** Add `tauri-plugin-single-instance = "2"` (Rust
   1.90+; the project requires 1.91). Register it as the first `.plugin(...)` in
   `lib.rs`, before clipboard, dialog, opener and window-state, as the plugin
   documentation requires. It has no JavaScript API, so no capability entry is
   needed.
2. **Pure argument parsing.** `documents.rs` (or a small `launch.rs`) gains
   `launch_paths(args: &[String], cwd: &Path) -> Vec<String>`:
   - skip index 0 (the executable);
   - skip tokens starting with `-` (Tauri/Chromium-style switches), except that
     a path may legitimately start with `-` only when the OS passes it after
     `--`; support `--` as “everything after is a path”;
   - resolve a relative token against `cwd`, not the process working directory
     of the already-running instance;
   - preserve order and de-duplicate under the platform's path identity
     (case-insensitive on Windows, case-sensitive elsewhere), reusing the same
     rule as `pathKey` where possible.
   Existence is *not* checked here. A missing path must reach the UI so the
   reader sees “could not open”, instead of disappearing.
3. **Forwarding without a lost launch.** The plugin callback runs on the running
   process:
   - append the parsed paths to a `Mutex<Vec<String>>` in managed state;
   - emit `open-files` with the same list;
   - unminimise/show/focus the `main` window.
   On the frontend, after `listen("open-files")` is installed, call a new
   `take_forwarded_paths` command. It drains and returns whatever arrived before
   the listener existed. The listener and the drain both go through one
   `openPaths` helper, and `openPath`'s path identity makes a double delivery
   focus the tab rather than duplicate it. This closes the startup race that a
   bare `emit` would have.
4. **Opening several paths.** `startup_files` returns every initial path.
   `main.ts` opens the first with `installingStartup` still true, then sets it
   false before the second, exactly as the restored-tab trap requires. A new
   `openPaths(paths, { report: "toast" })` loops, catches per path, shows a
   toast naming the failure, and continues. Startup and handoff use toast
   reporting, never a stack of native modal dialogs. The active tab becomes the
   last successfully opened path; an already-open path is focused.
5. **Focus.** `app.get_webview_window("main")` → `unminimize()`, `show()`,
   `set_focus()`. If Windows' foreground lock refuses the raise, do not fight it
   with an always-on-top flash; the tab still opens, and the reader sees the
   taskbar entry. Record manual results rather than claiming a guarantee.
6. **Phase 2 associations.** Add `bundle.fileAssociations` entries with
   `mimeType` values (`text/markdown`, `text/x-typst`, `text/asciidoc`), a
   user-facing `description`, and `role: "Editor"`. The bundler supports
   `deb`, `rpm`, `nsis` and `msi`. The installers register the handler; they do
   not force the default. Validate:
   - clean Windows profile: “Open with” lists MDraft; choosing it opens the
     file in a new tab; setting it as default makes double-click work;
   - an existing default editor for `.md` is not silently replaced;
   - uninstall removes the registration;
   - Linux deb: `MimeType=` is present, `update-desktop-database` runs, and
     `xdg-mime query default text/markdown` plus a desktop launch reach the
     running instance;
   - AppImage/portable: documented as “no registration”, but a path passed on
     the command line still reaches the window.

**Rejected alternatives**

- *Rely on WebView2's `0x800700AA` as the accidental single-instance guard.* It
  is a crash, not a handoff, and it cannot forward a path.
- *A custom named mutex/socket or a second `tauri-plugin-process`-based
  launcher.* The official plugin already handles the three platforms, the
  second process exit and the callback; writing another is a maintenance
  liability.
- *Emit `open-files` only from the callback.* A second launch during boot, before
  the frontend listener exists, is lost. The queue plus drain is the small,
  testable fix.
- *Open a second window when a file arrives.* It creates two owners for settings,
  recovery and `lastTabs`, which is exactly the multi-window design this plan
  does not attempt.
- *Register every supported extension, including `.html`.* It would make MDraft
  a candidate handler for web pages and other apps' documents. Markdown, Typst
  and AsciiDoc are the product's own formats; `.html` stays an ordinary “Open
  with” choice.
- *Have the installer force the default.* Windows 10/11 protects the user's
  choice; attempting it would be hostile and unreliable.

## Steps

**Phase 1**

- [x] Add the dependency; register the plugin first; confirm the second process
      exits before creating a WebView.
- [x] Add `launch_paths` with Rust unit tests: no args, one path, several,
      flags, `--`, spaces, relative `cwd`, duplicate paths under the platform
      rule, and a missing path retained.
- [x] Add managed forwarded-path state, the plugin callback, the
      `open-files` emit and `take_forwarded_paths`; focus/show/unminimise the
      window.
- [x] Add `startup_files` and its API wrapper; open every initial path; set
      `installingStartup = false` after the first.
- [x] Add `openPaths` with per-path toast reporting; use it for startup,
      handoff and the existing `open-files` listener.
- [x] Add `scripts/single-instance-test.mjs` and launch it from `test-all.mjs`
      with the staged executable, two initial fixtures and a second-launch
      fixture. Assert: both initial tabs exist; a second process exits; a third
      tab opens; only one page target remains; a duplicate path is focused; a
      missing path shows a toast and keeps the valid tabs; a dirty buffer
      survives.
- [x] Register the suite and its counts in `AGENTS.md` and the README/guide.
- [ ] Manual: installed and portable builds independently; launch from a
      terminal with spaces and Unicode in the path; close the last window and
      confirm window state/settings are written. *The file-level suite covers
      the process boundary; the installed/portable focus and close checks are
      for the owner.*

**Phase 2 (only after Phase 1 is accepted and a clean-profile test plan is
agreed)**

- [ ] Add `bundle.fileAssociations` for Markdown, Typst and AsciiDoc with
      descriptions and MIME types; no HTML.
- [ ] Build NSIS and MSI; test “Open with”, choosing the default, an
      already-owned `.md`, and uninstall on a clean profile.
- [ ] Build the deb; verify the desktop `MimeType`, `update-desktop-database`
      and `xdg-mime query default text/markdown`; test a desktop double-click
      with the app open and closed.
- [ ] Document the portable/AppImage limitation and the Windows default-app
      semantics in `docs/guide.md`/`README.md`.
- [ ] Update the backlog row and release checklist.

## Files and modules

| File | Why it must change |
| --- | --- |
| `src-tauri/Cargo.toml` | New single-instance dependency (Phase 1) |
| `src-tauri/src/lib.rs` | Plugin registered first, callback, focus, `take_forwarded_paths`, `startup_files` |
| `src-tauri/src/documents.rs` or new `launch.rs` | Pure `launch_paths`, forwarded queue, commands, Rust tests |
| `src/api.ts` | `startupFiles` and `takeForwardedPaths` wrappers |
| `src/main.ts` | Multi-path startup, handoff drain, `openPaths` toast reporting, focus-safe ordering |
| `src-tauri/tauri.conf.json` | `bundle.fileAssociations` (Phase 2) |
| `scripts/single-instance-test.mjs` | Two-launch and multi-file coverage |
| `scripts/test-all.mjs`, `package.json`, `AGENTS.md`, `README.md` | Register the layer and counts |
| `docs/guide.md`, `docs/backlog.md` | Reader claims, Windows/Linux semantics, status |

## Risks and rollback

- **New dependency.** It is an official Tauri plugin with no JavaScript surface.
  Registering it first is mandatory; a later position can let another plugin
  initialise a second WebView.
- **Lost early handoff.** The queue plus `take_forwarded_paths` is the
  mitigation; test a second launch immediately after the first paints, not only
  after a long idle.
- **Focus stealing.** Only an explicit second launch raises the window. Do not
  add always-on-top or repeated focus attempts; Windows foreground rules are
  user-protective. If `set_focus` is refused, the tab still opens and the
  taskbar shows the window.
- **Installed and portable builds share an identifier.** Whichever starts first
  owns the single-instance lock, so a path launched against the other build is
  handed to the running one. That is better than two WebViews fighting over the
  same profile, but it must be documented and tested, not assumed.
- **Relative paths from Explorer.** The plugin supplies `cwd`; resolving against
  it is the whole point. A missing file must still be reported, not filtered
  out in Rust.
- **Association registration is persistent.** It touches the registry/desktop
  database and the user's default-app surface. Phase 2 has its own approval and
  clean-profile tests, and uninstall must remove exactly what install added.
- **Linux AppImage/portable.** No registration; do not claim otherwise in the
  docs.
- **Rollback.** Phase 1 is a dependency plus additive commands; removing the
  plugin registration restores the old behaviour. Phase 2 is configuration plus
  installer output; reverting the config and re-running the installer removes
  the handler.

## Tests and validation

- Rust unit: `launch_paths` (arguments, `--`, flags, `cwd`, duplicates, missing
  paths) and the forwarded queue drain.
- `npm run single:instance` (new UI layer, own instance and two-launch
  lifecycle) — initial multi-file, second-process exit, new tab, one page
  target, missing-path toast, dirty buffer preserved.
- `npm test -- --only single-instance` once the layer is registered.
- `npm run tabs`, `npm run favorites`, `npm run recent` and `npm run p0:lifecycle`
  stay green; the handoff must not disturb tab identity or recents.
- `.\scripts\test-close.ps1` still proves WM_CLOSE writes `.window-state.json`.
- Manual Phase 1: installed and portable builds, terminal paths with spaces and
  Unicode, window focus, missing file.
- Manual Phase 2: clean Windows profile (NSIS and MSI), another editor already
  owning `.md`, uninstall; Linux deb desktop database and double-click;
  AppImage/portable limitation.
- **The measurement that proves it works:** after starting a second process
  with a document path, the second process has exited, the running window holds
  one additional tab with that document, and no second WebView/page target
  exists. For Phase 2, Explorer double-click starts the running window (or the
  app when closed) and opens the file in a tab.

## Acceptance criteria

- With MDraft open, launching `MDraft.exe second.md` (or using an existing
  association) brings the existing window forward and opens `second.md` as a
  tab; no second process remains.
- Launching from a terminal with a path does the same; a relative path resolves
  against the terminal's working directory.
- Initial launch with several paths opens each once, preserves existing dirty
  buffers, and reports a missing/unsupported path without dropping the valid
  ones.
- A second launch that arrives during startup is not lost.
- The installed and portable builds are tested independently; the shared
  identifier behaviour is documented.
- Closing the last window still writes window state and settings.
- If the handoff fails, the second launch reports it instead of dying silently.
- **Phase 2 only:** on a clean profile, double-clicking a Markdown, Typst or
  AsciiDoc file opens it in a new tab of the running window; an existing default
  handler is not silently replaced; uninstall removes the registration; the
  Linux deb registers the MIME types and the AppImage/portable limitation is
  documented.
- True multi-window remains out of scope and is not implied by this change.

## Validation record

Phase 1 implemented on Windows on 2026-10-25.

| Layer | Result |
| --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml` | **136 passed**, 0 failed, 2 ignored downloads |
| `cargo clippy --all-targets -- -D warnings` | clean |
| `npm test -- --only single-instance` | **12/12** on the staged release build |
| `npm test -- --only p0-lifecycle` | 34/34 (after expecting the new toast) |
| `npm test -- --only tabs` | 106/106 |
| `npm test -- --only smoke` | 107/107 |
| `npm test -- --only export-browser` | 21/21 |
| `npm run build`, `npm run lint`, `npm run knip` | PASS |
| Prettier on the files this plan touched | PASS |
| Manual WM_CLOSE on the release binary | exited with code 0 and wrote `.window-state.json` |

The plugin resolves to `tauri-plugin-single-instance` **2.5.4**. The UI layer
reports 12 checks: two initial paths as ordered tabs, the last active, one page
target, the second process exiting cleanly, a relative path opening a third tab,
the dirty startup buffer surviving, a duplicate path focusing its existing tab,
and a missing path producing a toast without a tab.

**The measurement that proves it works:** after spawning the staged executable
with a new path, the child exited with code 0, the running window gained exactly
one tab for that path, and `/json/list` still reported one page target.

**Deviations / remaining verification.**

- `openPaths(paths)` takes no options object; it always reports per-path
  failures as toasts. This is what startup and handoff need, and the old
  `open-files` modal was precisely the behaviour that would stack dialogs.
  `p0-lifecycle` now accepts the toast for its binary `open-files` probe; AGENTS
  records that trap.
- `startup_file` remains registered as an additive compatibility command even
  though the frontend now calls `startup_files`.
- `test-all.mjs` gained a `docs` array so one suite can be launched with several
  initial documents, and passes `MDRAFT_EXE`/`MDRAFT_REPO`/private user-data to
  the CDP layers.
- The "second launch during startup" case is covered by the Rust queue unit
  (`a_forwarded_path_is_queued_once_and_drained_once`) plus the frontend
  `pendingOpenFiles` gate, not by a timing-sensitive end-to-end race.
- Installed/portable focus, a terminal path with spaces/Unicode, Linux DBus and
  the clean-profile association tests remain manual (Phase 2 is not started).
- `scripts/test-close.ps1` itself hangs in the agent shell at its unredirected
  `Start-Process` (an existing trap). A redirected one-off proved WM_CLOSE exits
  with code 0 and writes `.window-state.json`, but it used the real profile
  because Tauri ignores `APPDATA`/`LOCALAPPDATA` for its directories; Recents and
  `lastDirectory` were touched. The AGENTS trap now records both facts, and the
  release check remains a normal-terminal run.
- **Update:** the repository-wide `npm run format:check` now passes after the
  concurrent formatting change to `scripts/typst-preview-test.mjs`.

## Open questions

- **How many paths should a second launch forward?** Default: all of them, in
  order, deduplicated; the last successfully opened one becomes active.
- **Should a second launch with no path still raise the window?** Default: yes;
  it is what a user double-clicking the app icon expects, and it is harmless.
- **Association owner for shared formats.** Default: Markdown, Typst and
  AsciiDoc only; `.html`, `.txt` and `.mdx` stay unclaimed.
- **Phase 2 timing.** Default: do not bundle it with Phase 1's release. Ship
  the handoff, watch it, then register associations after the clean-profile
  test.
