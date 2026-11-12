# Move the bundled LaTeX engine to TeX Live 2026

**Status:** approved (2026-11-12)
**Date:** 2026-11-12
**ADR:** `../adr/2026-11-12-engine-year-and-cache-namespace.md`, written during
step 1 (the cache layout on disk changes, which outlives this plan)

## Context and goal

*Enable bundled TeX* downloads the WasmTex LuaHBTeX engine pinned to **TeX Live
2025**, and compiles fetch packages and fonts from a 2025 mirror snapshot. WasmTex
added a TeX Live 2026 line upstream
([corca-ai/wasmtex#66](https://github.com/corca-ai/wasmtex/commit/aaf1ce389fc7fd68ae0c103878ea12f67e64a69d),
2026-08-27), and its docs call 2025 "the compatibility default while 2026 is
supported side by side". The goal is for a new install to get TeX Live 2026, and
for an existing 2025 install to move to it without a restart-only quirk, a silent
download, or a mixed-year package cache.

Facts checked while writing this plan:

- The pinned SDK (`wasmtex` snapshot `f85a1d3cec1c0598`, 2026-11-06) already
  accepts `texliveVersion: "2026"` (`TexliveVersion = '2025' | '2026'`) and ships
  a 2026 default mirror. **No npm dependency change is needed.**
- Upstream's `2026-latest` discovery profile is `2026-20260826-f5d9443`: engine
  release **`2026-f5d94438a7c75a23`** with package mirror
  **`https://texlive.corca.ai/snapshots/2026-d26706764b740276/2026/`**. That
  mirror is the one upstream added because an earlier selection omitted run
  files (XeLaTeX quotes and dashes, Metafont-only fonts, `luamplib`). It is also
  the SDK's own default for 2026. The engine and the mirror must name the same
  year *and* snapshot, because the format files are built against one mirror.
- The 2026 manifest is `https://corca-ai.github.io/wasmtex/wasmtex/2026/manifest.json`,
  `releaseStatus: release-cleared`, no release blockers, body SHA-256
  `46ec5ab3d1e3c4d4e95b616051d8f81a6992724ceed1f91861dc20bf1c5509f6`. The same
  method on the 2025 manifest reproduces the `928bd4b7…3d12b4a` quoted in
  `latex.rs`, and its file digests equal the current `ASSETS`, so the method is
  the one the current pin used.
- Of the eight pinned files, **four change** and four are byte-identical
  (`wasmtex-luatex.worker.js`, `wasmtex-luatex-resolver-evidence.js`,
  `wasmtex-bibtex.js`, `wasmtex-bibtex.worker.js`). The download grows from
  10,549,798 to 12,572,568 bytes: **about 10 MiB becomes about 12 MiB**.

| File | 2026 SHA-256 | Bytes |
| --- | --- | --- |
| `wasmtex-luatex.js` | `2b16bc7f892a068a548e8950b7d3987f6b23ff2bac4ba6258520739a402906ef` | 116,890 |
| `wasmtex-luatex.wasm` | `a5d940bf6e8f989c55816ceb06dfad8687100a58d109fa92873175ed4e48b53e` | 8,077,323 |
| `wasmtex-luatex.fmt.gz` | `1e58b5d1ee400e937c5b690cc4e34af20458c42162b0340f8c06903c40a5ed0b` | 4,034,143 |
| `wasmtex-bibtex.wasm` | `7ee47f5959d9f2a0d4cbde264be97472b6c1b7a1da2ca58b67baea759b03c3d6` | 205,813 |
| the other four | unchanged from 2025 | 138,399 |

The year is written in **five places that must agree**: `ASSET_ROOT`, `MIRROR`
and the `/wasmtex/2025/` prefix in `src-tauri/src/latex.rs`, `texliveVersion` in
`src/latex.ts`, and the two worker shims in `public/wasmtex/2025/`. The SDK
rejects a mirror URL whose path names a different year, but MDraft's mirror URL is
the local `mdraft-tex://` scheme with no year in it, so nothing would catch a
disagreement.

## Scope and non-scope

In scope: the bundled engine (assets, mirror, worker shims, year), what an
existing 2025 install does after the app updates, the package cache layout, the
size and licence text that names the old engine, and tests for all of it.

Not in scope: the SDK version (the unreleased 2026-11-07 "early-body preview
checkpoints" candidate is a separate decision); the installed-distribution paths
(`latex_native*`, which measure real TeX Live 2025 installs and are unrelated); any
settings field, `#[tauri::command]` name or return shape; XeLaTeX, pdfLaTeX or any
second bundled engine; offering both years side by side in the UI.

## Approach and rejected alternatives

Switch the pin to the upstream `2026-latest` profile (engine `2026-f5d94438…`,
mirror `2026-d26706764…`) and make the year a property of the on-disk state, so
that an old install is recognised as old rather than trusted.

1. **Install state is a release marker.** `install_latex` writes
   `latex/assets/.release` containing the release id *last*, after every file is
   verified. "Installed" means the marker matches the pinned release and all eight
   files exist (existence only, no hashing). The scheme handler still SHA-256
   checks every asset it serves, so a tampered file cannot run. Today "installed"
   is `assets/` being a directory, which would report a stale 2025 install as
   working and then fail every compile with "Engine asset failed SHA-256
   verification".
2. **An existing 2025 install is upgraded by the reader, not by the app.** It
   reads as enabled-but-not-installed, and the existing "Retry setup" button, the
   Tools dialog or toggling the switch off and on re-run `install_latex`, which
   already skips files whose digest matches and replaces the ones that do not. No
   download happens at start-up or on a compile, which the no-network rule
   requires. The two notes that say "its files are missing" are reworded to
   "missing or out of date" and name the 2026 engine and its size. No new UI.
3. **The package cache is namespaced by mirror revision.** A cached file is stored
   at `mirror/<revision>/<relative>`. The relative path is the same across years
   (`pdftex/26/article.cls`) but the bytes are not, so a flat cache would hand 2025
   packages to the 2026 engine. Old flat entries are never read again, still count
   toward the limit and are evicted least-recently-used first, and *Clear package
   cache* removes them. The update deletes nothing itself, which keeps *Clear* the
   only destructive LaTeX action (decision D14 in
   [2026-11-06-latex-product-integration.md](2026-11-06-latex-product-integration.md)).
4. **The worker shims move to `public/wasmtex/2026/`** and `public/wasmtex/2025/`
   is removed. The shims differ from the upstream workers (they read the wasm over
   `mdraft-tex://`, hook the cache names and add the local-library search paths),
   and the upstream worker bytes did not change between years, so those hooks
   still bind.

Rejected:

- *Keep 2025 and add a switch.* Doubles the asset, cache and test matrix for a
  setting nobody asked for, and the user asked for 2026 as the default.
- *Auto-download on the first compile after an update.* Simple, but it is network
  activity the reader did not initiate; AGENTS.md rule 1.
- *Pin `2026-initial` (March snapshot).* Older package set, and it is the snapshot
  upstream had to supplement for missing run files.
- *Delete the old flat cache during the update.* Contradicts D14 and is a
  destructive action on a click that reads as "download".
- *Hash all assets on every `latex_status` call.* Roughly 12 MB per call for a
  fact a marker answers; the handler already verifies what it serves.

## Steps

- [x] 1. Write the ADR (engine year is one pinned unit; cache is namespaced by
      mirror revision; install state is a release marker).
- [x] 2. Download the eight 2026 files into a scratch directory and check each
      against the table above, independent of the manifest, before pinning.
- [x] 3. `src-tauri/src/latex.rs`: `ASSET_ROOT`, `MIRROR`, a `MIRROR_REVISION`
      constant, the `/wasmtex/2026/` serve prefix, the new `ASSETS` digests, the
      manifest hash in the comment, the `.release` marker written last by
      `install_latex`, and the cache path `mirror/<revision>/…`. `latex_status`
      and `latex_cache_info` use one `engine_installed` helper.
- [x] 4. Keep the 2025 digests as a small `ASSETS_2025` list used only by the
      legacy-directory migration (`verified_legacy_assets`), so a pre-`latex/`
      directory that still holds 2025 files migrates instead of tripping "An
      incomplete or damaged LaTeX engine directory was preserved". Rust unit tests
      for: marker absent, marker for another release, a file missing, a legacy
      directory with 2025 digests, and the year agreeing across the constants.
- [x] 5. `public/wasmtex/`: `git mv 2025 2026` and change the year in both shims.
- [x] 6. `src/latex.ts`: `texliveVersion: "2026"`.
- [x] 7. `src/latex-licenses.ts`: the manifest link, the corresponding-source
      archive (`engine-2026-f5d94438a7c75a23`, SHA-256
      `e6a1f9b8ad84c7127368bb521217af381407fcc0d5c5518114345d55b470d637`) and its
      label. The bundled notice files already equal the pinned SDK's and include the
      Xpdf 4.06 texts, so they are not touched.
- [x] 8. Wording: "about 10 MiB" to "about 12 MiB" in `src/preferences.ts`,
      `src/main.ts` (the Tools dialog), `README.md`, `docs/latex.md`,
      `samples/latex-reference.tex`, `scripts/test-all.mjs` (a comment) and both
      site pages; the "missing" notes in `preferences.ts` and `main.ts` become
      "missing or out of date". `docs/latex.md` says where the cache lives and that
      it is per mirror revision.
- [x] 9. Tests: `scripts/latex-sdk-unit.mjs` reads the 2026 shim and asserts the
      year in the shims, `latex.ts` and the Rust constants agree;
      `scripts/test-all.mjs` `linkLatexEngine` recognises a legacy directory by the
      2026 `wasmtex-luatex.js` digest.
- [x] 10. Trap entry in `docs/agent-guide/traps/latex-typst-asciidoc.md` if the
      upgrade surfaces anything non-obvious. Catalog entries if a script is added
      (none planned).
- [ ] 11. Validate (below), then `npm run site`. Validation items 1-3 and 6 are
      done; items 4 and 5 need the engine enabled in the real app, see
      "Status and deviations".

## Files and modules

- `src-tauri/src/latex.rs`: every year-dependent constant, install, status, cache
  path, migration, tests.
- `public/wasmtex/2025/*.worker.js` → `public/wasmtex/2026/`: the shims name the
  year in their asset root.
- `src/latex.ts`: the year handed to the SDK.
- `src/latex-licenses.ts`: licence links.
- `src/preferences.ts`, `src/main.ts`: size and "out of date" wording only.
- `README.md`, `docs/latex.md`, `samples/latex-reference.tex`, `site/index.html`,
  `site/pt-br/index.html`: size wording.
- `scripts/latex-sdk-unit.mjs`, `scripts/test-all.mjs`: test paths and digest.
- `docs/adr/2026-11-12-engine-year-and-cache-namespace.md`, this plan.
- Not touched: `package.json`, `package-lock.json`, `settings.rs`, `api.ts`,
  `tauri.conf.json`, `capabilities`.

## Risks and rollback

- **The 2026 engine has not been run by MDraft.** The upstream worker bytes are
  unchanged, so the shim hooks (`cacheFileName`, `writeTexmfCnf`) should bind, and
  the shims throw loudly if they do not, but only a compile proves it. The local
  TEXMF library path and the `.fmt.gz` loader are the parts to watch.
- **First compile after the update is cold:** a new cache namespace means packages
  download again, and the format is 0.9 MB larger.
- **Output can differ.** TeX Live 2026 packages and kernel differ from 2025, so a
  document can compile differently or newly warn. That is the point of the change,
  but it is user-visible.
- **Old flat cache entries linger** until evicted or cleared (bounded by the cache
  limit, default 256 MiB).
- **The developer's engine goes stale.** `scripts/test-all.mjs` links the
  developer's installed engine into the test instance, and every LaTeX UI suite
  skips when it is absent. After this change the developer's 2025 install reads as
  out of date, so those suites skip until the engine is re-enabled once in the
  real app.
- **Not checked:** whether the current 2025 mirror MDraft pins
  (`2025-0d3fc73b…`, not the SDK's `2025-92e10d32…` default) shows the missing
  run-file problem upstream fixed with `2025-2e1df8aa…`. It stops mattering once
  2026 ships.
- **Rollback:** revert the branch. A user who already updated and then installs an
  older MDraft sees "failed SHA-256 verification; reinstall", and toggling the
  switch off and on restores the 2025 files. The `.release` marker and the
  `mirror/<revision>/` directory are ignored by the older build.

## Tests and validation

Cheapest first; the whole suite is not needed.

1. `npm run build` (typecheck + bundle) and `npm run lint`.
2. `.\scripts\cargo-vcvars.cmd test --manifest-path src-tauri\Cargo.toml` and
   `cargo clippy --all-targets -- -D warnings`: the marker, migration and year
   consistency tests.
3. `node scripts/latex-sdk-unit.mjs` (Node 24).
4. With the app freshly built and the engine enabled through Preferences (which
   downloads the 2026 files): `latex-preview-test`, `latex-project-test`,
   `latex-texmf-test`, `preview-freshness-test` through `npm test -- --only`. The
   preview test already asserts the Engine note reports "Installed and enabled."
   without a restart.
5. **The measurement that proves it works:** compile `samples/latex-reference.tex`
   and confirm the log banner names TeX Live 2026, the PDF renders, and a package
   fetched during that compile lands under `mirror/2026-d26706764b740276/`.
   Then start from a 2025 install (keep a copy of the current `latex` directory)
   and confirm the app reports it as out of date, that *Retry setup* upgrades it in
   place, and that nothing was downloaded before the reader asked.
6. `npm run site` for the two pages.

## Status and deviations

**Implemented 2026-11-12; in-app verification still open.**

Done and passing: the eight 2026 files were downloaded and each matched the manifest
digest (12,572,568 bytes); `npm run build`, `tsc --noEmit`, eslint and prettier on the
changed files, `knip`, `npm run site`; `cargo clippy --all-targets -- -D warnings`;
the 22 `latex::` Rust tests (five new: year as one unit, digest shape and the
four-file difference, release marker, byte comparison, cache namespace); and 12
app-free layers (`latex-sdk-unit` now 35 checks, including the year agreeing across
`latex.ts`, the Rust constants and the shims).

Not run: the CDP layers (`latex-preview`, `latex-project`, `latex-texmf`,
`preview-freshness`) and the validation item 5 measurement. `scripts/test-all.mjs`
links the developer's installed engine into the test instance, which is still the
2025 one, so those layers would skip, and enabling it through the harness would
write the 2026 files into the developer's real `latex/` folder. That is the reader's
step (Retry setup, or the switch off and on), not the agent's.

Deviations from the plan as approved:

- The "Engine asset failed SHA-256 verification" error now says how to fix it
  ("turn it off and on in Preferences › LaTeX"), since an out-of-date engine is the
  one case where a reader sees it.
- The preview note names **Retry setup** as well as the switch.
- Step 4's "legacy directory with 2025 digests" test is covered through
  `assets_match` with a synthetic set: a fixture with the real digests would need
  SHA-256 preimages. The OR of the two real sets in `verified_legacy_assets` is
  not itself unit tested.
- Step 10's trap went to `traps/build-and-environment.md` (the scratchpad is not
  "inside the workspace" for the Low-integrity `TEMP` rule), not the LaTeX file;
  the upgrade itself surfaced nothing non-obvious.
- `git mv` staged the `public/wasmtex/2025` to `2026` rename. Nothing is committed.
