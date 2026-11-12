# Switch the bundled engine's TeX Live year with one line

**Status:** approved (2026-11-12)
**Date:** 2026-11-12
**ADR:** `../adr/2026-11-12-engine-profile-config.md`, written in step 1. It refines
`2026-11-12-engine-year-and-cache-namespace.md` (the year is still one pinned unit,
now with a single source) and does not supersede it.

## Context and goal

After moving to TeX Live 2026 ([the previous plan](2026-11-12-texlive-2026-engine.md))
the reader reports that "something is not quite right with the 2026 engine". The
symptom is not yet known: in the app, `latex-reference.tex` compiled to 5 pages with
one warning and no console error, and three of the four GUI suites passed with a
warm cache. To find out, the reader needs to flip between 2025 and 2026 quickly and
compare. Today that means editing **seven places by hand** (the Rust asset root,
scheme prefix, mirror, mirror revision, release id and digest tables; `texliveVersion`
in `latex.ts`; the year in both worker shims; the "TeX Live 2026" and "about 12 MiB"
wording in `preferences.ts` and `main.ts`), and the last change needed a test to
notice when they disagreed.

Goal: one line in one file chooses the year, and everything else follows from it.

## Scope and non-scope

In scope: a single config file for the engine profiles, Rust and TypeScript reading
it, year-agnostic worker shims, wording derived from the active profile, and tests.

Not in scope: a user-facing picker (nobody asked for one, and a control a shipped
build should not need is the dead UI this project refuses); a new `#[tauri::command]`
or any `settings.json` field; per-year asset folders (below); changing the SDK;
rewriting the README, site and `docs/latex.md` prose, which keep describing the
shipped default (2026, about 12 MiB) plus one paragraph on how to flip.

## Approach and rejected alternatives

A new file, `src-tauri/latex-engine.json`, holds the active year and one profile per
year. Each profile has the engine release id, the mirror revision, the manifest
digest it was pinned from, and the eight assets with `name`, `sha256` and `bytes`.
**Everything else is derived**: the asset root, scheme prefix and mirror URL come
from the year and the revision, and "about N MiB" comes from the summed `bytes`, so
a profile cannot disagree with itself.

```json
{ "active": "2026",
  "profiles": {
    "2025": { "release": "2025-3a6c0df0b2b95005", "mirrorRevision": "2025-0d3fc73b65e39905", ... },
    "2026": { "release": "2026-f5d94438a7c75a23", "mirrorRevision": "2026-d26706764b740276", ... } } }
```

- **Rust** reads it with `include_str!` and `serde_json` into a `OnceLock`, and the
  constants `ASSET_ROOT`, `ASSET_PREFIX`, `MIRROR`, `MIRROR_REVISION`,
  `ENGINE_RELEASE`, `ASSETS` and the hand-kept `ASSETS_2025` list become reads of the
  active profile. The legacy-directory migration accepts the digests of *any*
  profile, so `ASSETS_2025` disappears.
- **TypeScript** imports the same file (`resolveJsonModule` is already on) through a
  small `src/latex-engine.ts` that exports the year and the download size.
  `latex.ts` passes the year to the SDK; the two wording sites read the same module.
- **The worker shims** read their year from their own URL
  (`/wasmtex/<year>/…`), so both `public/wasmtex/2025/` and `public/wasmtex/2026/`
  hold identical, year-agnostic files. The SDK builds the shim path from
  `texliveVersion`, so both folders must exist.
- **The 2025 profile is exactly what shipped before `fc92a10`**: release
  `2025-3a6c0df0b2b95005`, mirror `2025-0d3fc73b65e39905` and the old digests, so
  flipping back is a faithful rollback.

To flip: change `"active"`, let `npm run tauri dev` rebuild both sides, then press
**Retry setup** (or toggle the switch). That re-downloads only the files whose digest
differs (four, up to about 12 MiB). Each year keeps its own package cache, because
the cache is namespaced by mirror revision, so flipping back finds the earlier
cache warm.

Rejected:

- **An environment variable as the mechanism.** It has to reach both a Rust binary
  and a Vite bundle. At run time the frontend could only learn it through a new
  command (a contract change, and an `await` at every use); at build time it needs a
  `build.rs` `rerun-if-env-changed` and a Vite `define`. It is also a hidden knob in
  a shipped build that picks the engine. If wanted later, a build-time override of
  `active` is two lines on top of this design.
- **The frontend asks the backend for the year.** A new command and an async hop for
  one constant, to avoid reading a file both sides can already read.
- **A second constant in `latex.ts`.** Two lines to change is the drift this plan
  exists to remove.
- **Per-year asset folders** (`assets/<year>/`, so a flip needs no download once both
  are installed). Deferred: it moves the existing flat `assets/` again and needs a
  migration for a convenience of a developer's A/B loop. Worth doing if the
  re-download of the changed files is annoying.

## Steps

- [x] 1. ADR `2026-11-12-engine-profile-config.md`.
- [x] 2. `src-tauri/latex-engine.json` with both profiles. The 2026 values are the
      ones now in `latex.rs`; the 2025 values come from `git show fc92a10^`, and each
      `bytes` and `sha256` is checked against the two upstream manifests, not copied.
- [x] 3. `src-tauri/src/latex.rs`: load and validate the config, derive the URLs and
      the migration digests from it, drop the constants and `ASSETS_2025`. Rust tests:
      the real file parses, `active` names a profile, each profile has eight assets
      with 64-hex digests and ids that start with its year, URLs derive correctly for
      both years, the legacy match accepts either profile.
- [x] 4. `public/wasmtex/2025/` restored and `2026/` rewritten: identical shims that
      read the year from `self.location`.
- [x] 5. `src/latex-engine.ts` (new), `src/latex.ts`, `src/preferences.ts`,
      `src/main.ts`: year and size from the config.
- [x] 6. `scripts/latex-sdk-unit.mjs`: replace the regexes over `latex.rs` with checks
      against the JSON: the active year has a shim folder, every profile does, the
      shims are identical and year-agnostic, and the vm run of the shim derives the
      right root for each year. `scripts/test-all.mjs`: `linkLatexEngine` takes the
      legacy digest from the config.
- [x] 7. `docs/latex.md`: one paragraph on flipping. Catalog row for the SDK unit.
- [ ] 8. Validate (below). Flip to 2025, rebuild, Retry setup, compile, then flip
      back, and record both banners in this plan.

## Files and modules

- `src-tauri/latex-engine.json` (new), `src-tauri/src/latex.rs`.
- `src/latex-engine.ts` (new), `src/latex.ts`, `src/preferences.ts`, `src/main.ts`.
- `public/wasmtex/2025/*.worker.js` (restored), `public/wasmtex/2026/*.worker.js`.
- `scripts/latex-sdk-unit.mjs`, `scripts/test-all.mjs`.
- `docs/latex.md`, `docs/agent-guide/catalog/latex-and-formats.md`, the ADR, this plan.
- Not touched: `package.json`, `Cargo.toml` (`serde_json` is already a dependency),
  `settings.rs`, `api.ts`, `tauri.conf.json`, capabilities.

## Risks and rollback

- **A malformed config panics on first use** of the engine. Only a developer edits it,
  and the Rust test parses the real file, so `cargo test` catches it before a build.
- **Vite and cargo reload at different moments in `tauri dev`**, so the page can see
  the new year before the binary does for a few seconds. Both are built together in
  `tauri build`.
- **A flip leaves the engine "out of date" until Retry setup**, by design.
- **The 2025 profile is the older mirror** (`2025-0d3fc73b…`), not the wider run-file
  snapshot upstream later added. Flipping back reproduces the previous behaviour,
  not a better 2025.
- **Static docs describe the default.** After a flip the README and site still say
  about 12 MiB.
- **Rollback:** revert the branch. The on-disk layout (`.release` marker,
  `mirror/<revision>/`) does not change, so an engine installed either way keeps
  working.

## Tests and validation

1. `npm run build`, `npm run lint` on the changed files, `knip`.
2. `cargo test --lib latex::` (with `TEMP` inside the workspace, see the trap) and
   `cargo clippy --all-targets -- -D warnings`.
3. `node scripts/latex-sdk-unit.mjs`, and `npm test -- --only latex-sdk-unit`.
4. **The measurement that proves it works:** with `"active": "2025"`, a rebuilt app
   reports the engine out of date, Retry setup downloads the 2025 files, and the
   compile log banner names TeX Live 2025; flipped back to `"2026"` the banner names
   2026 and the 2026 cache is still warm. Both banners go in this plan.

## Status and deviations

**Implemented 2026-11-12; the in-app flip (step 8) was not completed.**

Done and passing: `src-tauri/latex-engine.json` generated from the two upstream
manifests (its 2025 digests are identical to the ones shipped before `fc92a10`); Rust
reads it and derives the URLs and migration digests (`cargo test --lib latex::`, 24
tests, five of them new for the config); identical year-agnostic shims in
`public/wasmtex/2025/` and `2026/`; `src/latex-engine.ts` and the three message sites;
`latex-sdk-unit` (flipping `active` to 2025 makes the TypeScript side report year 2025
and 10 MiB, an unknown year is refused with a clear message); clippy with warnings
denied, `tsc`, eslint on the changed files and `knip`. A release build with `active`
set to 2025 also compiled.

Deviations:

- `EngineAsset` in Rust keeps only `name` and `sha256`; `bytes` stays in the file for
  the TypeScript download size and for humans.
- `assets_match_any` was added so the "either profile" migration rule has a unit test.
- `latex-engine.ts` imports the JSON with `with { type: "json" }` and `latex.ts` imports
  it with a `.ts` extension, because `latex-sdk-unit` loads `latex.ts` under Node.
- `scripts/test-all.mjs` accepts the `wasmtex-luatex.js` digest of **any** profile when it
  looks for a pre-`latex/` engine directory, the same rule the backend uses.

**Not done, and why.** Step 8 (flip to 2025, rebuild, Retry setup, compile, read the
banner, flip back) was started and stopped. A debug launcher of mine set
`MDRAFT_TEST_IDENTIFIER` but not `MDRAFT_TEST_HIDDEN`, so an earlier run (the one that
compiled `latex-reference.tex` to 5 pages) used the **real** profile instead of the test
one: it recreated `%APPDATA%\io.github.bgeneto.mdraft`, which had been moved to the
Recycle Bin at 09:59, with the 2026 engine installed in it. A second launch was handed
to the user's running installed MDraft by the single-instance plugin. Both are recorded
in `traps/debugging-probes.md`. The in-app check should be repeated through
`scripts/test-all.mjs`, or with both variables set and the user's MDraft closed.
