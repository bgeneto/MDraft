# The LaTeX switch and its cache ceiling live in `settings.json`

**Status:** accepted
**Date:** 2026-11-06

## Context

The LuaLaTeX experiment kept its on/off state in a marker file,
`<app_data_dir>/wasmtex-poc-2025/enabled`, written by `install_latex` and read by
`latex_status` and the `mdraft-tex` scheme handler. That worked for a proof of
concept and failed the product in three ways:

- **It did not travel.** A portable build overrides `config` only, so
  `app_data_dir()` still resolved to `%APPDATA%`. Copying the portable folder to
  another machine carried the settings and not the switch.
- **It could not be backed up.** The project promises that a settings backup
  restores what a reader configured. A marker file beside a cache is not that.
- **It could not be turned off.** There was no code path that removed the marker,
  so the only way to disable the engine was to find the file by hand.

The cache ceiling had the same problem from the other side: it was a `const`
(`MAX_CACHE = 256 MiB`), so a reader with a small disk had no recourse and a
reader compiling a large paper had a hard wall.

## Decision

`latexEnabled` and `latexCacheLimitMb` are fields of `Settings`, persisted in
`settings.json`. The cache directory holds downloaded bytes and nothing else.

The `mdraft-tex` scheme handler is synchronous and runs once per package a
compile requests, so it cannot parse `settings.json` per request. `AppState`
mirrors the two values into process-wide atomics on load and on every save, and
the handler reads those. A mirror that has not been written yet reads as
disabled: an engine nobody switched on must never serve assets.

`latexEnabled` defaults to `false` and the ceiling to 256 MiB, clamped to
32–4096 MiB on both load and save, so a hand-edited or stale file cannot set a
value that makes every compile re-download or turns the cache into a second
document folder.

`tauri.portable.conf.json` gains a `data` override beside its `config` one, so
the cache follows the portable bundle instead of landing in `%APPDATA%`.

## Consequences

- A settings backup and a portable copy both carry the switch and the ceiling.
  An older build loading the same file sees two unknown keys and ignores them.
- Turning the switch off deletes nothing. The cache stays on disk, inert, and
  Clear cache is the only destructive action — and it is the reader's.
- The mirror is a second place where the switch lives, so **every** write must go
  through `AppState::save`; a command that wrote `settings.json` directly would
  leave the scheme handler serving a stale answer. `install_latex` and
  `latex_disable` both go through it.
- The ceiling is a preference, not a measurement. The cache *size* is read on
  demand through `latex_cache_info`, because it changes whenever a compile
  downloads a package and does not belong in a file that is written on every
  preference change.
