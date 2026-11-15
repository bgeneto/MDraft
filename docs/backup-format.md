# MDraft application-data backup format

MDraft exports a standard ZIP for explicit, offline backup. It is not encrypted:
the archive can contain personal writing and paths. SHA-256 detects accidental
corruption; it does not identify who created the archive or make an included
program trustworthy. API keys, WebView profiles and documents saved outside the
application's own folders are excluded.

## Version 1

`manifest.json` has `format: "mdraft-backup"`, `formatVersion: 1`, the MDraft
version, UTC millisecond creation and capture times, source OS/architecture,
portable flag, category presence/inclusion, component schema versions, directory
records and file records. Each file record has its relative path, category,
uncompressed size, lowercase SHA-256 and an executable flag. The manifest does
not hash itself. `README.txt` is an ordinary hashed entry.

Logical roots do not embed a computer's application directory:

- `config/settings.json`, optional `config/ai-prompts.md` and
  `config/.window-state.json`;
- `config/texmf/`, `config/recovery/` and `config/recovered-backups/`;
- `session/session.json` and `session/buffers/<id>.txt` for current unsaved text;
- `preserved/settings-on-disk.json` when disk settings differ from the live state;
- `data/pandoc/`, `data/typst/`, `data/latex/` and `data/tex-fmt/` when the
  reader includes downloads. Generated caches and partial files are omitted.

Text buffers are UTF-8; their metadata retains source language, original path
as a reference, encoding, BOM, line ending and disk-baseline details. A missing
category is distinguished from one intentionally omitted. Empty directories are
recorded. Format version 1 and component schema 1 are the baseline; future
changes must declare compatibility and add tested migrations instead of
silently discarding unknown data.

The reader verifies the entire archive before staging. It rejects unsupported
versions, extra or missing entries, duplicate or case-ambiguous names, unsafe
paths, links, encrypted entries, unsupported compression, size limit violations
and mismatched hashes. Extraction is confined to a new staging directory. The
input archive is not changed.

## Restore and manual recovery

The in-app restore previews compatible categories, creates a separate verified
safety ZIP, and applies selected replacements across a journaled headless
restart. Interrupted replacement is rolled back before the normal profile is
loaded. Restored writing is added to the recovery inbox as independent copies;
its original paths are not save targets. Imported AI, post-export commands and
native TeX configuration require renewed user action. Downloaded files are
retained for inspection and are not automatically executed.

If MDraft cannot start, first copy the current application data elsewhere and
keep the safety ZIP. Extract the backup into a new empty directory, validate its
file sizes and hashes against the manifest, and inspect its contents. With MDraft
closed, copy only understood compatible data into the correct application
folders. Installed Windows builds normally keep config and data in the same app
folder; portable builds use `app-data/config` and `app-data/data` beside the
executable. Linux uses the configured XDG locations. Open files in
`session/buffers/` as new documents and save copies under new names. Do not copy
WebView profiles or run downloaded executables from an untrusted archive.
