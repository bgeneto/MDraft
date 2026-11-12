# Audit and lock npm dependencies

**Status:** done
**Date:** 2026-11-11
**ADR:** none

## Context and goal

The npm lockfile was removed and ignored, but quality and release CI use `npm ci` and setup-node's lockfile-based cache. A clean checkout cannot run those jobs. The user wants a dependency and security audit, suitable version pins and compatible updates, followed by a versioned lockfile and reproducible installs.

On 2026-11-11, `npm outdated` against the local install identified `@asciidoctor/core` 4.1.1 → 4.2.1 and `pdfjs-dist` 6.4.299 → 6.5.438. The ignored local lockfile's `npm audit` reported ten moderate findings, including a minimatch denial-of-service advisory in the tooling dependency tree; these are preliminary findings for that local tree, not a clean-install result. Many direct dependencies use ranges; the TypeScript packages are npm aliases, and WasmTex is a snapshot URL coupled to engine assets. Preserve these distinctions when auditing pins and updates.

## Scope and non-scope

Audit all direct npm dependencies, aliases, overrides, the snapshot URL, supported Node versions and the resolved dependency tree. Update compatible packages, choose explicit direct version pins, restore the lockfile and document the common Node/npm workflow. Address audit findings where a compatible, tested fix is available and record any unresolved findings. No Rust dependency upgrades, unrelated product changes, engine asset upgrades or CI workflow redesign.

## Approach and rejected alternatives

Use exact versions for direct registry dependencies, preserving npm aliases and the WasmTex snapshot unless compatibility and integrity are established. Generate and track a lockfile with a documented toolchain; verify clean `npm ci`, existing CI quality checks and feature-specific tests for updates. Check upstream releases, engines, peer requirements and application integration before moving to the latest version; do not assume latest means compatible. Investigate the minimatch advisory and safe transitive resolution rather than blindly applying `npm audit fix --force`. Leaving the lockfile ignored would retain non-reproducible resolutions; pinning only direct dependencies would leave transitive versions unpinned.

## Steps

- [x] Record baseline package versions, audit findings, toolchain requirements and relevant CI/test commands; inspect release notes and compatibility for available updates.
- [x] Pin direct dependencies to reviewed exact versions, retaining aliases and the snapshot coupling; update compatible packages and record exclusions and reasons.
- [x] Investigate security findings and document those that remain.
- [x] Remove the ignore rule, generate a reviewable lockfile with the chosen documented Node/npm versions, and document the workflow for dependency changes and conflicts.
- [x] Validate a clean install and appropriate build, quality and feature-specific tests; record results and deviations here.
- [x] Mark the plan done and prepare the changes for review; commit or push only if separately authorized.

### Results and deviations

- The previously ignored lockfile was preserved at `%TEMP%/mdraft-lock-before-audit-20261111.json`. The new lockfile was authored with Node 24.11.1 and npm 11.19.1. All registry direct dependencies and both npm aliases are exact; WasmTex remains the snapshot URL, with integrity recorded in the lockfile. `npm outdated` initially showed Asciidoctor 4.2.1 and PDF.js 6.5.438 beyond the existing exact pins; ranged dependencies already resolved to their latest available versions in the local install.
- Updated Asciidoctor to 4.2.1 and pinned the other direct dependencies to the latest installed versions. Kept PDF.js 6.4.299: WasmTex declares `^5.4.624`, while both 6.4.299 and 6.5.438 are outside that range. The existing override already makes this a compatibility exception; actual Tauri preview validation is needed before widening it to 6.5.438. WasmTex's registry package is not an interchangeable upgrade for the coupled SDK/engine snapshot.
- `npm audit` initially reported ten moderate affected packages; a subsequent audit reports eleven, all stemming from [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), in development tooling through minimatch 10.2.6. The patched 11.x is outside upstream declared dependency ranges; no compatible patch was available. Do not force an untested major override. `npm audit --omit=dev` reports zero findings.
- Clean isolated `npm ci` and `npm run build` passed with Node 24.11.1 and Node 22.23.5; the lockfile hash was unchanged. AsciiDoc export (28 checks), PDF worker (11), LaTeX SDK (26), LaTeX TeXMF, P0, sessions, read-aloud and knip passed.
- `format:check` reports 14 existing files, and lint reports two existing `no-control-regex` errors in `src/latex-outline.ts` and `src/paste/render-latex.ts`. The same failures were reproduced with the prior locked Prettier 3.9.10 and ESLint 10.13.0. They are outside this dependency plan; CI quality is therefore not fully green on this baseline. The first archive check falsely reported 222 formatting files because of Windows line-ending conversion; the reusable trap was recorded.
- UI rendering, a full Tauri release build, Linux install and end-to-end CI were not run. Existing quality and release workflow files are unchanged. The lockfile is ready to add to Git; no commit or push was made.
- A further isolated `npm ci` with Node 26.13.1/npm 11.19.1 left the lockfile unchanged. Its build, knip, AsciiDoc export (28/28), PDF worker (11/11), LaTeX SDK (26/26), preview (183/183) and completion (30/30) checks passed. The same 14 formatting and two lint errors remained in the LF archive. The workspace's existing `node_modules` still contains Asciidoctor 4.1.1; use `npm ci` to synchronize it with the lockfile.

## Files and modules

- `package.json`: reviewed direct versions and any justified overrides.
- `package-lock.json`: reproducible resolved dependency tree and integrity metadata.
- `.gitignore`: allow the lockfile to be versioned.
- `docs/agent-guide/development.md`: common Node/npm and lockfile maintenance guidance, if needed.
- This plan: audit results, validation and decisions.
- Relevant application or test files only if a compatibility update requires them; record any scope change before editing.

## Risks and rollback

New dependency releases may alter rendering, PDF processing, APIs, licences or platform support. The WasmTex SDK snapshot and engine assets are coupled; the PDF.js override requires particular scrutiny. The lockfile can capture platform-specific optional dependencies incorrectly if generated or merged carelessly. Restore the previous manifest and ignore rule and remove the new lockfile to roll back; this returns CI to its currently broken lockfile-free state. Do not overwrite the existing ignored lockfile without preserving it first.

## Tests and validation

Use an isolated clean checkout or equivalent to run `npm ci` without relying on the existing `node_modules` or ignored lockfile. Run `npm run build`, `npm run format:check`, `npm run lint`, `npm run knip`, relevant app-free quality layers and focused AsciiDoc, PDF and LaTeX checks for packages actually updated. Run `npm audit` and compare findings to the baseline. Exercise the documented Node 22 and 24 paths as available, and report any UI, platform or release validation not run.

## Acceptance criteria

- Clean checkout's `npm ci` succeeds and its lockfile is unchanged after installation.
- Every direct dependency and alias is reviewed and pinned as agreed; exceptions are explained.
- Compatible available updates and security findings are assessed; unresolved issues and compatibility limits are recorded.
- Relevant tests pass or their failures and limitations are explicitly recorded.
- CI retains its existing lockfile-based installation and caching, and the lockfile maintenance workflow is documented.

## Open questions

- Which npm version should be the shared lockfile authoring standard? Default: select a version compatible with the project's Node 22 and 24 CI jobs after testing both.
- Can the newer PDF.js version be used with the WasmTex snapshot and supported runtimes? Default: retain the existing pin if focused verification cannot establish compatibility.

