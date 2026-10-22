# The Linux product name is lowercase `mdraft`; every other platform keeps `MDraft`

**Status:** accepted
**Date:** 2026-10-21

## Context

Installing `MDraft_0.4.4_amd64.deb` registered a Debian package named `m-draft`:

```
$ dpkg -s m-draft | head -3
Package: m-draft
Status: install ok installed
Priority: optional
```

Everything else was spelled correctly: the binary is `/usr/bin/mdraft`, the entry
is `/usr/share/applications/MDraft.desktop` with `Name=MDraft` and
`StartupWMClass=MDraft`. Only dpkg's package identity was wrong — the name a user
types into `apt remove` and the one GDebi, Discover and Synaptic show.

The cause is upstream. `tauri-bundler` derives the control file's `Package:`
field by kebab-casing `productName`
(`crates/tauri-bundler/src/bundle/linux/debian.rs:172`, tauri-cli 2.12.3):

```rust
let package = heck::AsKebabCase(settings.product_name());
```

Debian policy requires lowercase, so the bundler lowers first; `heck` then splits
`MDraft` at its camel-case boundary and produces `m-draft`. An already-lowercase
name has no boundary to split and passes through unchanged.

## Decision

`src-tauri/tauri.linux.conf.json` sets `"productName": "mdraft"`. Tauri merges
that file over the base config before `tauri-build` and the bundler read it, so
on Linux `context.config().product_name`, the deb's `Package:`, the
`mdraft.desktop` basename and its `StartupWMClass` are one value. Windows and
macOS do not override the name and keep `MDraft`.

The desktop template hard-codes `Name=MDraft`, because `productName` is also the
entry's visible label and the brand must stay capitalised. The deb declares
`replaces` and `conflicts` on `m-draft`, so the first renamed build succeeds the
old package and takes over its files rather than failing on a conflict.

## Consequences

- Upgrading from `m-draft` is handled by dpkg through `Replaces`+`Conflicts`.
  Going back to `MDraft` after a release would install `m-draft` again while
  `mdraft` remains; reverting after release needs the reverse transition, not a
  plain `git revert`.
- `Name=MDraft` is now a literal that a future rename must update. AGENTS.md's
  naming table lists it for that reason.
- Linux artefacts are named `mdraft_<version>_amd64.deb` and
  `mdraft_<version>_amd64.AppImage`. Staging therefore distinguishes the
  **display name** (manifest, Windows portable filename) from the **bundle name**
  (artefact matching) read from the platform config.
- A cached build directory — and the staging destination — can hold both names,
  so `build-linux.sh` clears `bundle/{deb,rpm,appimage}` before building and
  previous installers from `bin/linux/amd64` before collecting.
- The settings directory does not move: `identifier` is unchanged.
- Do not "fix" a future naming problem by post-processing the deb. Rewriting its
  control archive bypasses dpkg's conflict handling, which is the part that makes
  the transition work.
