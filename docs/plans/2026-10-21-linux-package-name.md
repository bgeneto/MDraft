# The Linux package is named `mdraft`, not `m-draft`

**Status:** done
**Date:** 2026-10-21
**ADR:** `../adr/2026-10-21-linux-package-name.md` (written in step 1)

## Context and goal

Installing `MDraft_0.4.4_amd64.deb` registers a Debian package whose name is
`m-draft`:

```
$ dpkg -s m-draft | head -3
Package: m-draft
Status: install ok installed
Priority: optional
```

Everything else about the install is spelled correctly. The `.deb` file is
`MDraft_0.4.4_amd64.deb`, the binary is `/usr/bin/mdraft`, the desktop entry is
`/usr/share/applications/MDraft.desktop` with `Name=MDraft`, `Exec=mdraft`,
`Icon=mdraft` and `StartupWMClass=MDraft`. Only dpkg's package identity is
wrong, and it is the name a user types to uninstall (`apt remove m-draft`) and
the name GDebi, Discover and Synaptic display.

The cause is upstream, not a typo. `tauri-bundler` derives the control file's
`Package:` field by kebab-casing `productName`:

```rust
// crates/tauri-bundler/src/bundle/linux/debian.rs:172 (tauri-cli 2.12.3)
let package = heck::AsKebabCase(settings.product_name());
```

Debian policy requires all-lowercase package names, hence the lowering; `heck`
then splits `MDraft` at its camel-case boundary, which turns `MDraft` into
`m-draft`. An already-lowercase product name is left untouched.

The goal: on Linux the installed package is `mdraft`, matching the binary, the
icon name and the command a user types; the launcher and taskbar still say
**MDraft**; the Wayland app-id match must not regress; and upgrading from an
existing `m-draft` install must work without asking the user to uninstall by
hand. Windows and macOS names, the Windows portable executable and the settings
directory are out of bounds.

## Scope and non-scope

Covers: the Linux-only product name, the desktop entry's display name, the deb
transition metadata (`Replaces`/`Conflicts`), the staging script's bundle-name
matcher, stale-bundle cleanup in `build-linux.sh`, the naming documentation and
a new ADR.

Does not cover: `productName` on Windows or macOS; the settings directory
(`identifier` is unchanged, so nothing moves); renaming the binary or the Cargo
package (`mdraft` and `mdraft_lib` stay); the AppImage's internal layout or
integration; localised `Name[xx]` entries; a version bump or a release. The
Linux AppImage filename follows `productName` and becomes
`mdraft_<version>_amd64.AppImage` as a consequence; that is accepted, not a
separate decision.

## Approach and rejected alternatives

Set `"productName": "mdraft"` in `src-tauri/tauri.linux.conf.json`. Tauri
merges that file into the base config with JSON Merge Patch before anything
reads it: `tauri_utils::config::parse::read_from(target, …)` is called by both
`tauri-build` (which `generate_context!` uses, so `context.config().product_name`
in `lib.rs` sees the override) and the CLI's bundler. Every consumer on Linux
therefore sees `mdraft`, while `tauri.windows.conf.json` and
`tauri.macos.conf.json` do not override it and keep `MDraft`. The kebab-case
step becomes the identity: `heck::AsKebabCase("mdraft")` is `mdraft`.

The product name is also the desktop entry's `Name` (`freedesktop/mod.rs` passes
`name: settings.product_name()`), so `linux.desktop.hbs` stops interpolating
`{{name}}` there and hard-codes `Name=MDraft`. The template's only name
variable is the product name, and the visible label must stay capitalised. The
rest of the template still uses `{{name}}`: `StartupWMClass` becomes `mdraft`,
which is exactly what `g_set_prgname` produces, so the Wayland app id, the
desktop-entry basename and the WM class remain one value.

`bundle.linux.deb.replaces` and `.conflicts` gain `["m-draft"]`, so dpkg treats
the first renamed build as the successor of the old package: it removes
`m-draft` and takes over `/usr/bin/mdraft`, the icons and the desktop entry
rather than refusing on a file conflict. The old `MDraft.desktop` is removed
with the old package, which is also why the validation below checks that no
orphan entry survives.

Staging currently requires every bundle filename to contain the base config's
`productName` (`MDraft`). It gains two names: the **display name** from
`tauri.conf.json` for the manifest and the Windows portable filename, and the
**bundle name** from the platform config for matching files. On Windows they are
the same string, so nothing changes there.

`build-linux.sh` copies every `.deb` and `.AppImage` it finds in the cached
build directory. Renaming guarantees that a previous `MDraft_*.deb` sits next to
the new `mdraft_*.deb`, which is the already-recorded stale-bundle trap. The
script clears the three bundle kind directories before building, so only what
this build produced can be collected.

Rejected:

- **Post-process the deb** (rewrite the control archive and rename the file). It
  bypasses dpkg's own conflict handling, so the first renamed build fails on
  file conflicts, and it repeats what the bundler already does.
- **Keep `productName` and accept `m-draft`.** This is the complaint, and the
  package name is what users see in every package manager.
- **Leave `Name={{name}}`.** The launcher would read `mdraft`, which trades a
  hyphen for a lost capital, and the brand would change in the one place a user
  reads it.
- **Rename `productName` everywhere to `mdraft`.** It changes Windows installer
  names, the Start Menu folder, the macOS `.app` and every artefact reference,
  to fix a Linux-only problem.
- **Add a `packageName` option upstream.** Correct long term, but not something
  this repository can ship, and the kebab-casing is deliberate for spaced names.

## Steps

- [x] Write `docs/adr/2026-10-21-linux-package-name.md`.
- [x] Add `"productName": "mdraft"`, `"replaces": ["m-draft"]` and
      `"conflicts": ["m-draft"]` to `src-tauri/tauri.linux.conf.json`.
- [x] Hard-code `Name=MDraft` in `src-tauri/linux.desktop.hbs`.
- [x] Rewrite the comment on the `glib::set_prgname` block in
      `src-tauri/src/lib.rs` to the new invariant (product name = desktop entry
      basename = `StartupWMClass`); keep the call so a future rename cannot
      reintroduce the icon mismatch.
- [x] Separate the display name from the bundle name in
      `scripts/stage-artifacts.mjs` and use the platform config's value for
      bundle matching and its error message.
- [x] Clear `bundle/{deb,rpm,appimage}` in `scripts/build-linux.sh` before the
      build, with a comment naming the stale-artefact trap. **Deviation:** the
      first build showed a stale `MDraft_0.4.0_amd64.deb` in
      `bin/linux/amd64/` — the collection destination was never cleared either.
      The script now also removes `*.deb`, `*.rpm` and `*.AppImage` there before
      collecting, which is what the acceptance criterion about no `MDraft_*`
      file requires.
- [x] Build the deb, inspect its control file and desktop entry, stage it and
      install it over the existing `m-draft`. Verified: `Package: mdraft`,
      `Replaces: m-draft`, `Conflicts: m-draft`, entry
      `Name=MDraft`/`Exec=mdraft`/`Icon=mdraft`/`StartupWMClass=mdraft`,
      `apt install` removed `m-draft` and left only `mdraft.desktop`, and
      `WAYLAND_DEBUG=1 mdraft` prints `set_app_id("mdraft")`.
- [x] Update `AGENTS.md`: the naming table, the Wayland trap, the Linux build
      and release-checklist wording, and the stale-bundle trap.
- [x] Run the frontend and Rust gates. `npm run build`, `npm run lint`,
      `npm run knip` and `npm test -- --only rust` (97 passed, 2 ignored) pass;
      Prettier passes on the changed JSON and script. Repository-wide
      `format:check` still fails on unrelated uncommitted files
      (`src/editor.ts`, `src/main.ts`, `src/markdown.ts`, the two scratch
      `scripts/.currency-*.mjs`), which this change does not touch.

## Files and modules

- `src-tauri/tauri.linux.conf.json` — the Linux product name and the deb
  transition metadata. This is the whole behavioural change.
- `src-tauri/linux.desktop.hbs` — keeps the visible label `MDraft` while
  `StartupWMClass` follows the lowercase product name.
- `src-tauri/src/lib.rs` — comment only; the code keeps the invariant.
- `scripts/stage-artifacts.mjs` — bundle matching must accept the platform
  product name without losing the display name in the manifest.
- `scripts/build-linux.sh` — removes stale bundles and documents that the
  manifest's `product` is the display name from the base config.
- `AGENTS.md` — the naming table gains the Debian package row; the Wayland trap
  records why the names now coincide; the Linux sections quote the new artefact
  names.
- `docs/adr/2026-10-21-linux-package-name.md` — the durable decision.
- `docs/plans/2026-10-21-linux-package-name.md` — this file.

Untouched, and checked: `.github/workflows/release.yml` (it uploads
`bin/<os>/<arch>/` and renames only the shared manifest and checksum files),
`README.md` (already says `mdraft notes.md`), `scripts/dist.mjs` (the portable
pass is Windows-only), `scripts/check-version.mjs` (versions only),
`stage-artifacts.mjs`'s portable naming (display name, unchanged on Windows).

## Risks and rollback

- **The package identity change is one-way for users.** A later release that
  goes back to `MDraft` would install `m-draft` again while `mdraft` stays
  behind. Reverting after a release means shipping the reverse transition
  (`replaces`/`conflicts: mdraft`) or leaving the name alone. Reverting the
  source before any release is a plain `git revert`.
- **Old dpkg or a bare `dpkg -i`.** `apt install ./…deb` honours
  `Replaces`+`Conflicts`; a very old dpkg may require `dpkg -r m-draft` first.
  The validation covers `apt`, and the release notes mention the manual step as
  a fallback.
- **Any script or documentation outside this repository that names
  `MDraft_*.deb` or `MDraft_*.AppImage`** stops matching. Nothing in this
  repository does; the release assets keep their platform-infixed names.
- **`Name=MDraft` is now a literal.** A future rename has one more place to
  update; the AGENTS.md naming table lists it so the next agent sees it.
- **Staging fails loudly, not silently** when matching is wrong: it prints
  `No deb bundle matching "mdraft" <version>` and the directory contents.
- Rollback on this host: `sudo dpkg -r mdraft` then
  `sudo apt install ~/Downloads/MDraft_0.4.4_amd64.deb` restores the previous
  package exactly.

## Tests and validation

No CDP suite applies: WebKitGTK has no CDP endpoint, so the Linux evidence is
`cargo test` plus a real install.

- `npm run build` — typecheck and bundle; the frontend is untouched, but it is
  the cheapest gate and CI runs it.
- `npm run test:rust` — 93 tests; nothing in Rust changes except a comment.
- `npm run format:check`, `npm run lint`, `npm run knip` — config and scripts
  only, but cheap.
- `bash scripts/build-linux.sh --bundles deb` — the real proof. Then measure:
  - `dpkg-deb -I .../bundle/deb/mdraft_<version>_amd64.deb` shows
    `Package: mdraft`, `Conflicts: m-draft`, `Replaces: m-draft`.
  - `dpkg-deb -c` lists `./usr/share/applications/mdraft.desktop`; extracting
    it shows `Name=MDraft`, `Exec=mdraft`, `Icon=mdraft`,
    `StartupWMClass=mdraft`.
  - `node scripts/stage-artifacts.mjs` stages `mdraft_<version>_amd64.deb` and
    writes `"product": "MDraft"` into `manifest.json`.
- `sudo apt install ./bin/linux/amd64/mdraft_<version>_amd64.deb`, then:
  - `dpkg -l | grep -i draft` lists `mdraft` and no `m-draft`.
  - `ls /usr/share/applications | grep -i draft` lists only `mdraft.desktop`;
    the old `MDraft.desktop` went away with the old package.
  - Launch from the launcher: the entry reads **MDraft** with the app icon, and
    the taskbar shows the same icon.
  - `WAYLAND_DEBUG=1 mdraft` prints `xdg_toplevel.set_app_id("mdraft")`.
- One regression check for the other platform: `node scripts/stage-artifacts.mjs`
  on Windows still stages `MDraft_<version>_x64-portable.exe` and the
  `MDraft_<version>_x64_en-US.msi`/`.exe` installers (covered by the release
  workflow; the platform-config lookup falls back to the base name there).

## Acceptance criteria

- `dpkg-deb -I` reports `Package: mdraft`, with `Replaces: m-draft` and
  `Conflicts: m-draft`.
- Installing the deb on a machine that has `m-draft` removes the old package and
  leaves exactly one `mdraft` package owning `/usr/bin/mdraft`; no orphan
  `MDraft.desktop` remains in `/usr/share/applications`.
- The desktop entry installed by the deb has `Name=MDraft`, `Exec=mdraft`,
  `Icon=mdraft` and `StartupWMClass=mdraft`.
- `bin/linux/amd64/` contains `mdraft_<version>_amd64.deb` (and, on a full
  build, `mdraft_<version>_amd64.AppImage`) and no `MDraft_*` file from an older
  build; `manifest.json` still names the product `MDraft`.
- Windows staging is unchanged: the portable executable and the installers keep
  the `MDraft_<version>_…` names.

## Open questions

- Keep `replaces`/`conflicts: m-draft` permanently? Default: yes, they cost
  nothing and prevent a simultaneous install of the old package.
- Ship a compatibility copy named `MDraft_<version>_amd64.deb`? Default: no —
  two identical installers with different names is the ambiguity the Windows
  staging rules already avoid.
- Localise the desktop `Name`? Default: no; the app has no localised strings.
- Which release carries the rename? Default: the next one, with the version
  bumped through the release checklist; this change does not touch the version.
