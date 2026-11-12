# The bundled engine's TeX Live year is one pinned unit, and its cache is namespaced by mirror revision

**Status:** accepted
**Date:** 2026-11-12

## Context

The bundled LuaHBTeX engine was pinned to TeX Live 2025 in five places that had to
agree and nothing checked: the asset root, the package mirror and the
`/wasmtex/2025/` scheme prefix in `latex.rs`, `texliveVersion` in `latex.ts`, and
the two worker shims in `public/wasmtex/2025/`. WasmTex added a TeX Live 2026 line
(corca-ai/wasmtex commit `aaf1ce3`) and documents that an engine, its format
files, its cache namespace and its package mirror must all name the same year and
snapshot. The SDK enforces that only when a mirror URL carries a year in its path,
and MDraft's mirror URL is the local `mdraft-tex://` scheme, which does not.

Two on-disk facts made a plain version bump unsafe:

- **The package cache was keyed by relative path only.** A request for
  `pdftex/26/article.cls` is the same path in 2025 and 2026 and the bytes are not,
  so a flat `mirror/` directory would hand 2025 packages to the 2026 engine.
- **"Installed" meant `assets/` was a directory.** Four of the eight pinned files
  changed between the years. A 2025 install would have reported as installed and
  then failed every compile with "Engine asset failed SHA-256 verification".

Measured: the eight 2026 files total 12,572,568 bytes against 10,549,798 for 2025.
The 2026 manifest body hashes to
`46ec5ab3d1e3c4d4e95b616051d8f81a6992724ceed1f91861dc20bf1c5509f6`; the same method
on the 2025 manifest reproduces the `928bd4b7…3d12b4a` the previous pin recorded.

## Decision

The engine year is one pinned unit: the asset root, the mirror root and its
revision, the scheme prefix, the SDK year and the worker shims are changed
together, and `scripts/latex-sdk-unit.mjs` and a Rust test fail when they
disagree. The pin is the upstream `2026-latest` profile: engine release
`2026-f5d94438a7c75a23` with mirror revision `2026-d26706764b740276`.

Downloaded packages are stored at `mirror/<mirror revision>/<relative path>`.

`install_latex` writes `assets/.release`, containing the engine release id, after
every file is verified and replaces files whose digest differs. The engine counts
as installed only when that marker names the pinned release and all eight files
exist. Existence is checked, not hashes: the scheme handler still verifies the
SHA-256 of every asset it serves.

An engine from an earlier release is treated as not installed. The app never
downloads a replacement on its own; the reader re-runs the install (the switch,
*Retry setup*, or Tools › Check or Install LaTeX), which fetches only the files
that changed.

## Consequences

- Moving to another year or snapshot is one pin change plus new digests, and a
  mismatch between the places that name the year is a test failure, not a
  compile-time mystery.
- Cache entries from an earlier mirror revision are never read again. They stay on
  disk, count toward the cache ceiling and are evicted least-recently-used first;
  Clear package cache removes them. The update deletes nothing, so Clear cache
  remains the only destructive LaTeX action (decision D14,
  `docs/plans/2026-11-06-latex-product-integration.md`).
- A build older than this one finds the new marker and the namespaced cache and
  ignores both; its own digest check then asks the reader to reinstall, which
  restores the earlier files.
- The legacy-directory migration still recognises directories holding 2025 files,
  through a retained list of the previous digests, so a pre-`latex/` directory is
  moved rather than rejected as damaged.
- The first compile after moving to a new revision is cold: packages download
  again into the new namespace.
