# Install Typst automatically on Linux

**Status:** done
**Date:** 2026-10-19
**ADR:** none

## Context and goal

**Help › Install Typst** is already a complete managed installer on Windows:
`typst::install` fetches the latest GitHub release, downloads the platform
archive, extracts the single executable, writes it to
`<app data>/typst/<version>/typst`, marks it executable, probes `--version`, and
returns a `TypstStatus` with `source: "managed"`. `find_typst` already prefers
that copy over anything on `PATH`, so no menu or settings change is involved.

On Linux the same command only opens the download page. `release_asset()` returns
`None`, `can_install` is false, and `extract_binary()` is a stub that returns
"Automatic installation is not implemented on this platform." The reason given
in the source is the `.tar.xz` shape: the project has an xz algorithm but no xz
decoder, and adding one looked like a large dependency for a platform where
`apt install typst`, `cargo install typst-cli` and friends work.

That reasoning no longer holds for the experience we want. A Debian package is
not available on every distribution or release, needs administrator rights, and
puts a different compiler version in the system; the official musl tarball is
self-contained, works on every Linux distribution, and fits the existing
"install into MDraft's own folder, remove the folder to undo" model. The user's
request is one click: **Help › Install Typst** should leave the user with a
working compiler on Linux too.

Verified against the current upstream release (`v0.15.1`):

- GitHub publishes `typst-x86_64-unknown-linux-musl.tar.xz` (17.5 MB) and
  `typst-aarch64-unknown-linux-musl.tar.xz` (16.2 MB), each with a
  `sha256:` digest in the release API.
- The x86_64 archive contains exactly
  `typst-x86_64-unknown-linux-musl/typst` (55.7 MB, mode 0755), plus
  `README.md`, `NOTICE` and `LICENSE`. The binary is statically linked against
  musl, so it has no runtime dependencies.
- `lzma-rs` 0.3 (pure Rust, MIT) decompresses that archive correctly and the
  existing `tar` crate reads the member: measured in a scratch debug build,
  17.5 MB → 55.7 MB in 6.5 s, with the `typst` entry found by name. Release
  builds will be faster.

Goal: on Linux x86_64 and aarch64, **Help › Install Typst** performs the same
managed install as Windows, with no administrator rights, no package manager and
no external `tar`/`xz` process.

## Scope and non-scope

In scope:

- Platform asset names for Linux x86_64 and aarch64 in `release_asset()`, so
  `can_install` becomes true and the existing frontend flow asks to download
  instead of opening the browser.
- SHA-256 verification of the Typst archive against the digest GitHub publishes
  (the pandoc installer already does this; the Typst installer currently does
  not, which matters more once the archive is unpacked and executed on Linux).
- An in-process xz + tar reader for the Linux archive, reusing the existing
  `tar` dependency and adding a pure-Rust `lzma-rs` dependency only on Linux.
- Unit coverage for the asset name, the archive reader, and an ignored live
  contract test mirroring `downloading_pandoc_yields_a_runnable_binary`.
- Updated user-facing copy in `src/main.ts` and the three documents that still
  say Typst installs automatically only on Windows.

Non-scope (deliberately):

- **macOS auto-install.** It also ships `.tar.xz` and could use the same reader,
  but macOS is not published, and its Gatekeeper/quarantine behaviour has not
  been tested. It keeps the download-page path.
- **Bundling Typst.** The binary is 55.7 MB uncompressed and Apache-2.0 with a
  NOTICE; the project deliberately does not bundle it.
- **System-wide installation, package-manager integration, `pkexec`, or adding
  anything to `PATH`.** The managed copy needs none of that.
- **Automatic installation without a click.** The confirmation dialog stays; the
  only start-up network activity remains none.
- **Version sorting in `managed_typst`.** It still chooses the
  lexicographically last version directory. That is correct for the 0.10+ tags
  Typst publishes today and is not required for this change.
- **A new preference or command.** `install_typst`, `typst_status` and
  `typst_download_page` keep their names and payloads; no `settings.json`
  migration.

## Approach and rejected alternatives

Reuse pandoc's installer shape. `typst::install` is split into a
`download_binary(agent)` helper that fetches the release, picks the platform
asset, verifies its digest and extracts the executable, and `install` that only
writes, chmods and probes it. This mirrors `export::download_binary` and makes
the ignored live contract test possible.

For Linux, `extract_binary` decompresses the `.tar.xz` in memory with
`lzma_rs::xz_decompress`, walks the tar entries with the existing `tar` crate,
and returns the bytes of the entry whose file name is `typst`. It never writes
the archive's other members to disk and never uses the entry's path for
anything except matching the name, so tar path traversal is not a concern. The
rest of the install path — app data directory, version subdirectory, mode 0755,
`--version` probe, removal on failure — is already platform-neutral and stays
unchanged.

Why `lzma-rs`: it is pure Rust and MIT, so it matches the project's stated
reason for using flate2's `rust_backend` and adds no C toolchain, no
`liblzma-dev`, and no runtime `.so` dependency. It is used only on Linux, so the
Windows and macOS builds do not compile it.

Rejected alternatives:

- **Shell out to `tar -xJf` / `xz -dc`.** No new crate, but it depends on
  `xz-utils` being installed, spawns an external process, and reports failures
  through another program's stderr. The application already unpacks pandoc
  in-process and should not have two install behaviours.
- **`xz2` / liblzma bindings.** Battle-tested, but requires the C library and
  headers during build, and either a bundled C build or a new system
  requirement. The pure-Rust decoder avoids both.
- **Download a raw Linux binary instead of the archive.** Upstream publishes no
  raw Linux asset; the `.tar.xz` is the only shape.
- **`cargo install typst-cli` or the distro package.** Needs a Rust toolchain or
  root, is slow, and produces a system copy with a version we do not control.
- **A bundled Typst.** Size and licence obligations; explicitly out of scope in
  the existing design.

## Steps

- [x] Add `lzma-rs = "0.3"` to the Linux-only dependencies in
      `src-tauri/Cargo.toml`, with a comment explaining why it is pure Rust and
      Linux-only; update `src-tauri/Cargo.lock` through cargo.
- [x] Make `export::sha256_hex` visible to the typst module
      (`pub(crate)`), or move it to a shared helper if the reviewer prefers;
      reuse it rather than duplicating the digest code.
- [x] Extend `typst::release_asset()` with
      `typst-x86_64-unknown-linux-musl.tar.xz` and
      `typst-aarch64-unknown-linux-musl.tar.xz`; leave Windows unchanged and
      return `None` for other architectures.
- [x] Add `digest: Option<String>` to the release `Asset` and reject an archive
      whose SHA-256 does not match the `sha256:` digest GitHub published,
      before extraction or execution. The error names both digests.
- [x] Refactor the fetch/verify/extract half of `install` into
      `download_binary(agent)` returning `(tag, bytes)`, matching
      `export::download_binary`.
- [x] Implement `extract_binary` for Linux with `lzma_rs::xz_decompress` and the
      `tar` crate; find the entry named `typst`, return its non-empty bytes, and
      keep the existing clear "layout may have changed" error.
- [x] Add tests in `typst.rs`:
      - the asset name for the platform the tests run on (including Linux
        x86_64/aarch64);
      - replace `automatic_installation_is_windows_only_and_says_so` with the
        new platform rule;
      - an offline round-trip: build a small tar containing a fake `typst`
        member, compress it with `lzma_rs::xz_compress`, and assert
        `extract_binary` returns those bytes;
      - an ignored live test
        `downloading_typst_yields_a_runnable_binary` that downloads the real
        release, asserts the digest/extraction, writes and probes the binary.
- [x] Change the confirmation copy in `src/main.ts` from "about 21 MB" to
      "about 20 MB" (17.5 MB on Linux, 22.5 MB on Windows), and keep the
      existing managed-folder wording.
- [x] Update `README.md`, `docs/export.md` and `docs/guide.md` so Typst install
      is described as automatic on Windows **and Linux**, with macOS still on
      the download page.
- [x] Run the Rust layer on Linux.
- [ ] Confirm the one-click flow in a launched window. Not driven in this
      session: WebKitGTK has no CDP and this host has no X input automation. The
      live contract test covers every new code path below the click; the
      write/chmod/probe path is unchanged from Windows. This remains a manual
      release check.

## Files and modules

- `src-tauri/Cargo.toml` — Linux-only `lzma-rs` dependency and the comment that
  records why it is pure Rust.
- `src-tauri/Cargo.lock` — the new crate and its two small transitive deps
  (`byteorder`, `crc`).
- `src-tauri/src/typst.rs` — asset names, digest verification, the
  `download_binary` split, the Linux extractor, hint/status copy if needed, and
  the tests.
- `src-tauri/src/export.rs` — only the visibility of `sha256_hex` (one line),
  unless a shared helper is chosen instead.
- `src/main.ts` — the download-size sentence in the Typst confirmation dialog.
- `README.md` — requirements and first-run instructions.
- `docs/export.md` — the "Installing pandoc and Typst" section.
- `docs/guide.md` — the Typst section and the troubleshooting bullet.

No menu, settings, capability or API-contract change is needed: `can_install`
is already part of `TypstStatus`, and the frontend already branches on it.

## Risks and rollback

- **`lzma-rs` fails on a future archive.** The release may switch to a
  different xz filter chain or a multi-stream file. The error is contained: the
  installer returns "The downloaded archive is not readable xz…", nothing is
  written or executed, and the download page remains the fallback. The ignored
  live contract test is the canary; run it when bumping Typst.
- **GitHub omits the digest.** The installer refuses the download, exactly as
  pandoc does. That is intentional: fetching 17 MB and executing it without a
  published checksum is arbitrary code execution from the network. The user can
  still install manually.
- **The downloaded binary is blocked by endpoint security.** `probe_version`
  fails, the file is removed, and the existing "downloaded but would not run"
  error is shown. No partial install is left behind.
- **Disk use.** About 56 MB per installed version under the app data directory.
  Removing the version directory undoes the install; `managed_typst` will fall
  back to `PATH` or report not found.
- **Windows/macOS regression.** The new crate and extractor are Linux-only;
  the Windows ZIP reader remains the compiled path there. The digest requirement
  does affect Windows, but upstream publishes a digest for every Typst asset.
- **Rollback.** Revert the commit (Cargo.toml/lock, typst.rs, export.rs, copy and
  docs). Existing managed installs remain valid because the directory layout
  and executable name do not change; delete
  `<app data>/typst/<version>/` if a clean state is wanted.

## Tests and validation

Layers, cheapest first:

- `cargo test` (through `npm test -- --only rust` on this host, which sets a
  writable `TEMP`) — the asset-name test, the platform rule, the offline
  xz+tar round-trip, and the digest/hex helper.
- `npm run build` — the frontend copy change typechecks.
- Live contract, opt-in because it downloads about 18 MB:
  `cargo test -- --ignored --nocapture downloading_typst`.
- Manual Linux check, because WebKitGTK has no CDP and the UI suites cannot run
  there: launch the built app, delete
  `~/.local/share/io.github.bernh.mdraft/typst/` first, choose
  **Help › Install Typst**, then:
  - the dialog says about 20 MB and the progress toast appears;
  - `<app data>/typst/<version>/typst --version` prints `typst <version>`;
  - `typst_status` reports `found: true`, `source: "managed"`;
  - a `.typ` document previews and a PDF export completes.

The one measurement that proves it: after one click on a machine with no Typst
on `PATH`, the managed executable exists, is mode 0755, prints its version, and
a Typst preview renders.

**Run on 2026-10-19, Linux x86_64:**

- `cargo check` — passed. This agent host has no system `libhunspell-dev`, so a
  locally extracted `.deb` prefix was supplied through `PKG_CONFIG_PATH`; no
  repository file was changed for that.
- `cargo test` — 91 passed, 2 ignored (the two live download tests).
- `cargo test -- --ignored downloading_typst` — passed in 2.89 s: the real
  0.15.1 archive was downloaded, its SHA-256 matched the GitHub digest, the
  `typst` member was extracted, made executable and printed its version.
- `npm run build` — passed.
- The one-click UI was not driven in this session: WebKitGTK has no CDP and this
  host has no X input automation. The live test exercises every new path beneath
  the click; only the unchanged `install` write/chmod/probe wrapper is not
  re-exercised end to end here.

## Acceptance criteria

- On Linux x86_64 with no Typst installed, **Help › Install Typst** offers a
  download (not "Open page"), installs the latest official musl build into
  `<app data>/typst/<version>/typst`, and reports the version.
- The archive is rejected with both digests printed if its SHA-256 does not
  match the digest GitHub published; nothing is written or executed.
- After a successful install, `typst_status` returns `found: true` and
  `source: "managed"`, PDF export uses it, and `.typ` previews render.
- A copy on `PATH` is still found when no managed copy exists; a managed copy
  still wins over `PATH`.
- Linux aarch64 gets the aarch64 asset; other architectures keep
  `canInstall: false` and the package-manager/download-page hint.
- Windows and macOS behavior is unchanged apart from the now-verified digest.
- The README and both guides no longer say Linux installs Typst only by hand.
- Existing Rust tests pass, and the new offline extractor test fails if the xz
  or tar member lookup is removed.

## Open questions

- Include aarch64 now? **Default: yes** — the asset exists, the code path is
  identical, and it costs one more name.
- Should the live installer test be added to a scheduled CI job, given that it
  is ignored by default? **Default: no** — keep it opt-in, as pandoc's is, and
  run it when bumping the Typst version.
- If the reviewer rejects any new crate on principle, the fallback is
  `tar -xJf` through `Command` with `xz-utils` required. **Default: the
  pure-Rust decoder**, because the installer should not depend on an external
  program.
