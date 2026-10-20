# Linux Wayland app icon

**Status:** done
**Date:** 2026-10-19
**ADR:** none

## Context and goal

On KDE Plasma Wayland the MDraft window and taskbar show the Breeze
`wayland` icon (an amber “W”) instead of the MDraft icon. The icon assets are
installed correctly; the window's `app_id` does not match the installed desktop
entry.

GTK3 sets the Wayland app id from `g_get_prgname()`, which is the executable
name `mdraft`. Tauri's Linux bundler names the desktop entry after
`productName`, `MDraft.desktop`, and the compositor's lookup is case-sensitive.
KWin 6.3 then falls back to the theme's `wayland` icon
(`XdgToplevelWindow::updateIcon()` in `src/xdgshellwindow.cpp`). X11 is
unaffected because the icon comes from `_NET_WM_ICON`.

The goal is for the Wayland app id to match the desktop entry Tauri installs,
so KWin and GNOME show the MDraft icon, without renaming the binary, the
product, or the installed bundle.

## Scope and non-scope

Covers: the Linux-only GTK program name, the Linux desktop template's
`StartupWMClass`, the `glib` target dependency, and a Traps entry.

Does not cover: the upstream Tauri bundler naming decision, the AppImage
integration tool's filename, Windows/macOS icons, or the product/binary names.

## Approach and rejected alternatives

Set the GLib program name to the configured `productName` before Tauri builds
the GTK application. `tauri::generate_context!()` is moved to the start of
`run()` so the same config value drives the program name as the desktop file
name, and the builder receives that context. A small custom desktop template
sets `StartupWMClass={{name}}`, because changing the program name also changes
the X11 `WM_CLASS` from `mdraft` to `MDraft`; the template keeps the entry and
the class exactly aligned. `glib` is already in the dependency graph through
GTK/Tauri, so the direct target dependency adds no crate version.

Rejected:

- **Rename the desktop file to `mdraft.desktop`.** Tauri hardcodes
  `<productName>.desktop`; the AppImage root entry is a hardcoded symlink to
  the same path. A `files` workaround would leave duplicate or hidden entries.
- **Rename the binary or `productName`.** Changes the installed command,
  package and release artefact names, and existing users' package identity.
- **`app.enableGTKAppId`.** It would make the app id
  `io.github.bernh.mdraft`, while the installed file remains
  `MDraft.desktop`; the mismatch would only move.
- **A KDE window rule.** Fixes one user's desktop, not the installed
  application.
- **Patch Tauri upstream.** Correct long term, but not something this
  repository can ship.

## Steps

- [x] Add `glib = "0.18"` to the Linux target dependencies.
- [x] Move `tauri::generate_context!()` to the start of `run()` and set the
      GLib program name from `context.config().product_name` on Linux.
- [x] Add a custom desktop template with `StartupWMClass={{name}}` and point
      `bundle.linux.deb.desktopTemplate` at it. The path is relative to
      `src-tauri`, so it is `linux.desktop.hbs`; the first attempt used
      `src-tauri/linux.desktop.hbs` and the bundler reported
      `Failed to create desktop file: No such file or directory`.
- [x] Add the Wayland/desktop-entry trap to `AGENTS.md`.
- [x] Validate with `cargo check`, `cargo test`, a Wayland app-id probe, and a
      deb bundle whose desktop file carries `StartupWMClass=MDraft`.

## Files and modules

- `src-tauri/Cargo.toml` — the direct Linux `glib` dependency.
- `src-tauri/src/lib.rs` — context first, then the program-name call before
  the GTK application exists.
- `src-tauri/tauri.linux.conf.json` — points at the desktop template.
- `src-tauri/linux.desktop.hbs` — the default entry with `StartupWMClass`
  driven by `productName`.
- `AGENTS.md` — the trap entry for the orange “W” symptom.

## Risks and rollback

The program name is process-wide, so on X11 `WM_CLASS` changes from `mdraft` to
`MDraft`; the template updates `StartupWMClass` to match. KWin already compares
`StartupWMClass` case-insensitively, but other desktops are not assumed to.
`g_set_prgname` only affects GLib's own notion of the program name; the
executable and `ps` output are unchanged. The call is Linux-only, and the
dependency is target-specific, so Windows and macOS builds do not change.

Rollback: remove the call and the target dependency, restore the default
desktop template, and delete the template file. The previous bundle behaviour
returns with no data migration.

## Tests and validation

- `cargo check --manifest-path src-tauri/Cargo.toml`.
- `cargo test --manifest-path src-tauri/Cargo.toml`.
- Build the debug binary, launch it with `WAYLAND_DEBUG=1`, and require
  `xdg_toplevel.set_app_id("MDraft")` instead of `"mdraft"`.
- Build a deb bundle and inspect its
  `usr/share/applications/MDraft.desktop`: `StartupWMClass=MDraft` and
  `Icon=mdraft`.
- On KDE Wayland, launch the built binary and observe the MDraft icon in the
  decoration and taskbar. The CDP UI suites cannot run on Linux (WebKitGTK has
  no CDP), so this last step is manual.

Result: `cargo check` passed; `cargo test` passed 91 tests with the two download
tests ignored; `WAYLAND_DEBUG=1 src-tauri/target/debug/mdraft` printed
`xdg_toplevel.set_app_id("MDraft")`; a debug deb bundle built successfully and
its `usr/share/applications/MDraft.desktop` contains `StartupWMClass=MDraft`,
`Icon=mdraft`, `Exec=mdraft` and `Name=MDraft`. The visual check was not taken
over the user's running session; the app id now matches the installed entry,
which is the only input KWin's icon lookup uses.

## Acceptance criteria

- The Wayland window's `app_id` is `MDraft`, matching the installed
  `MDraft.desktop`.
- KDE Wayland shows the MDraft icon, not the Breeze `wayland` icon.
- X11 `WM_CLASS` and `StartupWMClass` still name the same application.
- Windows and macOS builds are unaffected; no product, binary or package name
  changes.

## Open questions

None. The upstream Tauri bundler naming remains a separate issue.
