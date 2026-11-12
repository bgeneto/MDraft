# The bundled engine's year and pins live in one JSON file that Rust and TypeScript both read

**Status:** accepted
**Date:** 2026-11-12

This refines `2026-11-12-engine-year-and-cache-namespace.md`, which made the TeX Live
year one pinned unit. It does not supersede it: the namespaced cache, the release
marker and the no-automatic-download rule stand.

## Context

That decision kept the year consistent by having a test notice when seven places
disagreed: the Rust asset root, scheme prefix, mirror, mirror revision, release id and
digest tables, `texliveVersion` in `latex.ts`, the year inside both worker shims, and
the year and size written into two UI messages. A reader who wants to compare two
years, for example to find out whether a compile problem comes from the engine, had to
edit all seven by hand and keep the 2025 digests somewhere else (`ASSETS_2025`, kept
only for migration).

An environment variable would not fix that. The year has to reach a Rust binary and a
Vite bundle, and at run time the frontend could only learn it through a new
`#[tauri::command]`.

## Decision

`src-tauri/latex-engine.json` holds an `active` year and one profile per year. A profile
has the engine release id, the package-mirror revision, the digest of the upstream
manifest it was pinned from, and the engine's assets with `name`, `bytes` and
`sha256`. Switching the year is a one-line edit of `active`.

Everything else is derived from the year and the revision: the asset root, the
`mdraft-tex` scheme prefix, the mirror URL and the download size shown to the reader.
Rust reads the file with `include_str!`; TypeScript imports the same file through
`src/latex-engine.ts`. The worker shims read their year from their own URL, so
`public/wasmtex/<year>/` holds identical shim files for every profile.

The legacy-directory migration accepts the digests of any profile, which retires the
hand-kept 2025 list.

## Consequences

- Adding a year is a new profile, a new `public/wasmtex/<year>/` folder and nothing
  else. `latex-sdk-unit` and the Rust tests fail when a profile has no shim folder, an
  asset list differs from the others, or a derived value disagrees.
- A malformed file panics on first use of the engine. Only a developer edits it, and a
  Rust test parses the real file, so `cargo test` catches it first.
- The file is read at build time on both sides. In `tauri dev` the page can see a new
  year a few seconds before the binary does.
- A flip does not download anything by itself. The engine reads as out of date until
  the reader presses Retry setup, and only the files whose digest differs are fetched.
  Each year keeps its own package cache, because the cache is namespaced by revision.
- There is no run-time override and no user-facing picker. A build-time override of
  `active` is a small addition if one is ever wanted.
