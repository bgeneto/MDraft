# Adopt a reproducible JavaScript/TypeScript quality baseline

**Status:** done
**Date:** 2026-10-20
**ADR:** none (tooling; no runtime decision)

## Context and goal

The audit ran the tools but could not turn most of them into a gate:

- Prettier is not configured. With `printWidth: 100`, 65 files differ; the
  default width differs in 80. The repository has a consistent hand-written
  style, so this is a one-time mechanical change, not a defect to fix file by
  file.
- ESLint/typescript-eslint cannot start against the repository's TypeScript
  7.0.2. `typescript-eslint` 8.72 imports the TypeScript 6 API and aborts with
  `typescript-eslint does not support TS 7.0`. The official workaround is
  `typescript` aliased to `@typescript/typescript6` plus
  `@typescript/native` aliased to TypeScript 7, so `tsc` stays 7.0.2 while the
  linter gets the 6.0 API. With that alias and an ES5 override for
  `src/html-bridge.js`, the current tree has **21 real lint errors**: 16
  `no-useless-escape`, 1 `prefer-const`, 4 `no-useless-assignment`.
- Knip reports one unused dependency, `codemirror`; the modular
  `@codemirror/*` packages are imported directly.
- Clippy has 25 style warnings, all fixable without changing behaviour.
- `cargo fmt --check` has 99 hunks in 7 Rust files, including the two files
  stored as CRLF (`settings.rs`, `typst.rs`). That is a separate formatting
  decision; it must not ride along with lint fixes.

The goal is a reproducible `npm run format:check`, `npm run lint`,
`npm run knip`, `cargo clippy -- -D warnings` and a small CI job — without a
single commit that mixes formatting, lint fixes and feature work.

## Scope and non-scope

In scope:

- Prettier configuration, ignore rules, one mechanical formatting pass over
  `src/` and `scripts/`, and `format` / `format:check` scripts.
- ESLint 10 + typescript-eslint with the TypeScript 6 compatibility aliases,
  a flat config, and fixes for the 21 errors above.
- Knip configuration and removal of the unused `codemirror` dependency.
- Manual fixes for the 25 Clippy warnings, then a `-D warnings` gate.
- A quality workflow that runs these checks plus `npm run build`.
- Documentation of every new script in `AGENTS.md`, as the repository requires.

Out of scope:

- `cargo fmt` / rustfmt across the Rust tree. The 99-hunk diff and the CRLF
  files are a separate decision; until then rustfmt remains advisory.
- Type-aware ESLint rules. Start with the recommended non-type-aware set;
  type-aware linting adds noise and is not needed to replace `tsc`.
- Full Knip unused-export/file cleanup. Gate only dependencies and unlisted
  imports first.
- Dependency upgrades, security CI (gitleaks/Semgrep/cargo-deny) and release
  workflow changes. Those are separate plans.

## Approach and rejected alternatives

Implement in three independent commits/PRs after the current block-sync work is
committed, because that work touches `src/main.ts`, `src/source-map.ts`,
`src/typst-map.ts` and `package.json`; formatting now would conflict with it.

1. **Formatting commit.** Add `.prettierrc.json` (`printWidth: 100`, two
   spaces, semicolons, double quotes, trailing commas), `.prettierignore`
   (`dist/`, `bin/`, `node_modules/`, `src-tauri/`, `docs/`, `samples/`,
   `src/assets/fonts/`, `package-lock.json`), run `prettier --write` once over
   `src/**/*.{ts,js,css}` and `scripts/**/*.mjs`, and add the resulting commit
   to `.git-blame-ignore-revs`.
2. **Lint commit.** Add ESLint 10, `@eslint/js`, `typescript-eslint`, Prettier,
   Knip and the TypeScript aliases. Configure browser globals for `src`, a
   scoped ES5 override for `src/html-bridge.js` (`no-var: off`,
   `prefer-const: off`), and fix the 21 errors by hand.
3. **Rust cleanup commit.** Fix the 25 Clippy warnings manually; do not run
   `cargo clippy --fix` blindly. Then add `cargo clippy --all-targets -- -D
   warnings` to the quality job.

Rejected alternatives:

- `npm install --legacy-peer-deps` for ESLint: it hides a real compatibility
  problem and makes `npm ci` fragile. The TypeScript 6 alias is the official
  workaround and keeps `tsc` 7.0.2.
- Formatting now: it conflicts with the uncommitted block-sync work and makes
  review impossible.
- Formatting documentation and generated font JSON: it would add noise to
  prose and change CRLF files that are deliberately stored that way.
- A global rustfmt gate in this change: the tree is not rustfmt-clean and two
  files use CRLF; normalize them only in a dedicated decision.

## Steps

- [x] 1. Wait for the block-sync work to be committed; preserve its
      `package.json` script addition.
- [x] 2. Add Prettier config, ignore file, scripts and one formatting commit;
      add `.git-blame-ignore-revs` after the commit exists.
- [x] 3. Add ESLint 10/typescript-eslint with the TypeScript 6 alias; verify
      `npx tsc --version` is still 7.0.2.
- [x] 4. Add the flat ESLint config and scoped ES5 bridge override; fix the 21
      errors; run `npm run lint`.
- [x] 5. Add `knip.json`, remove `codemirror`, and gate
      `knip --include dependencies,unlisted`.
- [x] 6. Fix the 25 Clippy warnings; run
      `cargo clippy --all-targets -- -D warnings`.
- [x] 7. Add a quality workflow on push/PR running `npm ci`,
      `npm run build`, `format:check`, `lint`, `knip` and Clippy.
- [x] 8. Document the new scripts in `AGENTS.md` and rerun the affected test
      layers.

Deviations: the formatting commit touched 69 files rather than 65 because the
root `index.html`, `tsconfig.json` and `vite.config.ts` are in the Prettier
patterns. The quality workflow splits frontend (Ubuntu) from Rust (Windows) so
Clippy does not need the Linux WebKit and hunspell packages.

## Files and modules

- `package.json`, `package-lock.json` — dev dependencies, aliases, scripts.
- `.prettierrc.json`, `.prettierignore`, `.git-blame-ignore-revs`.
- `eslint.config.mjs`, `knip.json`.
- `src/**/*.{ts,js,css}`, `scripts/**/*.mjs` — mechanical formatting; the 21
  lint fixes are the only semantic edits.
- `src-tauri/src/{documents,export,lib,menu,settings,spellcheck,typst}.rs` —
  Clippy fixes only.
- `.github/workflows/quality.yml` — new quality gate.
- `AGENTS.md` — repository scripts table and any new trap.

## Risks and rollback

- A 65-file formatting commit obscures blame. Mitigate with a commit that
  touches no logic, `.git-blame-ignore-revs`, and a separate lint commit.
- `typescript` becomes the 6.0 API for tooling while `tsc` stays 7.0.2 via
  `@typescript/native`. If a tool imports `typescript` and expects 7.0, the
  alias is the wrong choice; verify `npm run build`, the Tauri build and the
  editor's TypeScript integration before merging.
- Prettier can rewrite template literals and JSX-like markup; run the full
  unit and UI suites after the formatting commit.
- Clippy fixes can change behaviour if a warning is misunderstood; the 25 are
  style-only, but each file gets `cargo test` before commit.
- Rollback is a revert of the three commits. Reverting the alias restores
  TypeScript 7 as the tooling API.

## Tests and validation

1. `npm run format:check` and `npm run lint` pass.
2. `npm run knip` reports no dependency/unlisted issues.
3. `npm run build` and `npx tsc --version` (7.0.2) pass.
4. `cargo clippy --all-targets -- -D warnings` and the Rust suite pass.
5. `npm test -- --no-build` passes on the formatted tree; at minimum smoke,
   html, asciidoc, typst-preview, math, syntax and the node unit layers.
6. The quality workflow passes on a pull request.

The single measurement that proves the TypeScript alias works:
`npx tsc --version` prints `Version 7.0.2` while
`node -e "console.log(require('typescript').version)"` prints `6.0.x`; ESLint
then exits 0 on the same tree.

## Acceptance criteria

- `format:check`, `lint`, `knip`, `build` and `clippy -D warnings` are green
  locally and in CI.
- Formatting commit contains no logic changes; lint commit contains only the
  21 fixes and configuration.
- `codemirror` is gone from `package.json` and the lock file.
- `npx tsc --version` remains 7.0.2.
- No Rust formatting changes are included.

## Outcome

- `npm run format:check`, `npm run lint`, `npm run knip` and `npm run build`
  pass; `npx tsc --version` is 7.0.2 while the linter's TypeScript API is 6.0.2.
- `cargo clippy --all-targets -- -D warnings` passes; the Rust suite reports
  91 passed and 2 ignored.
- Smoke 105/105, AsciiDoc 55/55, Typst Pages 36/36, math 10/10, syntax 10/10,
  word sync 33/33, rich paste 28/28 and HTML 50/50 pass. One combined run
  reported the pre-existing HTML outline race; the suite passes on its own.

## Open questions

- Do we want a global rustfmt pass in a later, dedicated commit? Default: no;
  keep rustfmt advisory until someone accepts the CRLF normalization.
- Should the quality workflow be required for merges? Default: yes after one
  green PR.
