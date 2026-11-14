# Script catalog

Use npm and Node 24. The shipped application does not execute these tools.
Run the cheapest relevant check first; `npm test -- --list` lists the functional
layers in their execution order. Build before the UI layers unless testing an
already-built isolated binary. On Windows invoke every cargo/Tauri command through
`scripts/with-msvc.cmd` or `scripts/cargo-vcvars.cmd`.

## Publication safeguards

| Command | Purpose |
| --- | --- |
| `npm run repo:hygiene` | Inspect the staged Git snapshot, private/artifact paths, public inventory and synthetic user paths |
| `npm run repo:hygiene:history` | Also inspect all reachable HEAD trees and commit identities |
| `npm run repo:hygiene:test` | Real temporary-Git regressions, including forced additions and historical exposure |
| `npm run security:scan` | Scan staged blob contents with SHA-256-pinned Gitleaks; source lines/secrets are not printed |
| `npm run security:history` | Scan the staged snapshot, HEAD diffs and commit/tag metadata |
| `npm run security:self-test` | Confirm that a temporary synthetic credential is rejected |
| `npm run security:hooks` | Install pre-commit/pre-push without replacing a custom hook configuration |

The scanner is downloaded to the OS cache only by an explicit development check,
verified before extraction and verified again as an executable on every run. Git
snapshots/reports are temporary and removed after scanning. Hooks inspect the
index at commit and every outgoing ref at push; `git add -f` cannot bypass policy.
CI reports a failed publication after a push, so keep local hooks and GitHub push
protection enabled. Changing the policy/scanner/workflows needs owner review.

Fixtures and public images/documents are listed with purposes in
[public-assets.json](fixtures/public-assets.json). Image hashes require an explicit inventory update when image bytes change;
review pixels and metadata before updating them. Preserve include trees and
license files. Private records and source captures must remain outside this tree.

## Capture, image and probe helpers

| Script | Usage and purpose |
| --- | --- |
| `screenshot.mjs` | `[port] [output.png] [setupExpression]`; captures an explicitly running window; defaults to a new OS temporary directory |
| `math-render-check.mjs` | `[port]`; checks the synthetic math corpus and saves diagnostic captures outside the checkout |
| `optimize-site-images.py` | `--check` validates canonical public WebP sizes/container metadata using Python only; `--write --source <private-captures>` needs Pillow; `MDRAFT_CAPTURE_DIR` can provide that explicit source |
| `preview-group-prototype.mjs` | Test-only grouping helpers imported by the performance suite; never application code |
| `preview-native-compare.mjs` | `[port]`; CDP/native preview comparison run by the isolated test harness |
| `latex-perf-baseline.mjs` | `<runs-dir> [--out=path]`; combines performance results, defaulting to an OS temporary output folder |
| `build-icons.mjs` | `--source <master.png> [--out src-tauri/icons]`; regenerate public installer/window icons from an explicitly selected master |
| `fetch-fonts.ps1` | Refresh pinned font assets; requires Python/fonttools/brotli and is not needed for ordinary builds |
| `build-linux.sh` | Linux-only build/staging; runs in WSL/container/Linux, not cross-compilation from Windows |
| `with-msvc.cmd`, `cargo-vcvars.cmd` | Load the Windows C++ toolchain before cargo or Tauri |

GUI/CDP tests require an isolated test app and the fixture the harness selects.
They must not reset a user's settings/profile. Node's WebSocket CDP scripts enable
Runtime, await promises, check exceptionDetails and exit nonzero on failed checks.

## npm command inventory

The command names below correspond directly to `package.json`. Scripts also carry
usage comments; use those for optional arguments. Any new script must be added
here with its public purpose and, for owner sessions, to the private catalog.

| Command | Runs |
| --- | --- |
| `npm run dev` | `vite` |
| `npm run build` | `tsc --noEmit && vite build` |
| `npm run format` | `prettier --write "src/**/*.{ts,js,css}" "site/**/*.{html,css,js}" "scripts/**/*.mjs" "*.{json,ts,html}"` |
| `npm run format:check` | `prettier --check "src/**/*.{ts,js,css}" "site/**/*.{html,css,js}" "scripts/**/*.mjs" "*.{json,ts,html}"` |
| `npm run lint` | `eslint src` |
| `npm run knip` | `knip --include dependencies,unlisted` |
| `npm run preview` | `vite preview` |
| `npm run tauri` | `tauri` |
| `npm run dist` | `node scripts/dist.mjs` |
| `npm run stage` | `node scripts/stage-artifacts.mjs` |
| `npm run check:version` | `node scripts/check-version.mjs` |
| `npm run icons` | `node scripts/build-icons.mjs` |
| `npm run smoke` | `node scripts/dom-smoke.mjs` |
| `npm run sync` | `node scripts/scroll-sync-test.mjs` |
| `npm run sync:unit` | `node scripts/scroll-sync-unit.mjs` |
| `npm run encoding:unit` | `node scripts/encoding-unit.mjs` |
| `npm run encoding:dialog` | `node scripts/encoding-dialog-test.mjs` |
| `npm run word-sync` | `node scripts/word-sync-test.mjs` |
| `npm run autoclose` | `node scripts/autoclose-test.mjs` |
| `npm run emmet` | `node scripts/emmet-test.mjs` |
| `npm run emmet:unit` | `node scripts/emmet-unit.mjs` |
| `npm run autoclose:unit` | `node scripts/autoclose-unit.mjs` |
| `npm run completion:unit` | `node scripts/completion-unit.mjs` |
| `npm run completion:latex:unit` | `node scripts/completion-latex-unit.mjs` |
| `npm run latex:references:unit` | `node scripts/latex-references-unit.mjs` |
| `npm run latex:diagnostics:unit` | `node scripts/latex-diagnostics-unit.mjs` |
| `npm run latex:native:unit` | `node scripts/latex-native-unit.mjs` |
| `npm run latex:outline:unit` | `node scripts/latex-outline-unit.mjs` |
| `npm run latex:word-map:unit` | `node scripts/latex-word-map-unit.mjs` |
| `npm run pdf:map-worker:unit` | `node scripts/pdf-page-worker-unit.mjs` |
| `npm run pdf:map:perf` | `node scripts/pdf-map-performance.mjs` |
| `npm run pdf:map:webview` | `node scripts/pdf-webview-performance.mjs` |
| `npm run test:harness:unit` | `node scripts/test-harness-ownership-unit.mjs` |
| `npm run latex:sdk:unit` | `node scripts/latex-sdk-unit.mjs` |
| `npm run texpresso:unit` | `node scripts/texpresso-unit.mjs` |
| `npm run latex:texmf:unit` | `node scripts/latex-texmf-unit.mjs` |
| `npm run latex:correspondence:unit` | `node scripts/latex-correspondence-unit.mjs` |
| `npm run latex:preview` | `node scripts/latex-preview-test.mjs` |
| `npm run latex:perf` | `node scripts/latex-performance-test.mjs` |
| `npm run latex:perf:baseline` | `node scripts/latex-perf-baseline.mjs` |
| `npm run latex:perf:book` | `node scripts/latex-perf-book.mjs` |
| `npm run latex:perf:native` | `node scripts/latex-perf-native.mjs` |
| `npm run latex:scheduler:unit` | `node scripts/latex-scheduler-unit.mjs` |
| `npm run latex:outline:project:unit` | `node scripts/latex-outline-project-unit.mjs` |
| `npm run latex:root` | `node scripts/latex-root-test.mjs` |
| `npm run latex:format:unit` | `node scripts/latex-format-unit.mjs` |
| `npm run audit` | `node scripts/audit-document.mjs` |
| `npm run math` | `node scripts/math-render-check.mjs` |
| `npm run syntax` | `node scripts/syntax-theme-test.mjs` |
| `npm run html` | `node scripts/html-preview-test.mjs` |
| `npm run export` | `node scripts/export-test.mjs` |
| `npm run export:paths:unit` | `node scripts/export-paths-unit.mjs` |
| `npm run export:browser` | `node scripts/export-browser-test.mjs` |
| `npm run pdf:visual` | `node scripts/pdf-visual-check.mjs` |
| `npm run pdf:native` | `node scripts/pdf-native-test.mjs` |
| `npm run typography` | `node scripts/typography-test.mjs` |
| `npm run typography:unit` | `node scripts/typography-unit.mjs` |
| `npm run shortcuts` | `node scripts/shortcut-test.mjs` |
| `npm run menu` | `node scripts/menu-test.mjs` |
| `npm run tabs` | `node scripts/document-tabs-test.mjs` |
| `npm run favorites` | `node scripts/favorites-test.mjs` |
| `npm run tabs:restore:unit` | `node scripts/tabs-restore-unit.mjs` |
| `npm run typst:map:unit` | `node scripts/typst-page-map-unit.mjs` |
| `npm run latex:sync:unit` | `node scripts/latex-sync-unit.mjs` |
| `npm run latex:project` | `node scripts/latex-project-test.mjs` |
| `npm run latex:native` | `node scripts/latex-native-test.mjs` |
| `npm run html:map:unit` | `node scripts/html-source-map-unit.mjs` |
| `npm run block:map:unit` | `node scripts/block-map-unit.mjs` |
| `npm run ai` | `node scripts/ai-assistant-test.mjs` |
| `npm run ai:unit` | `node scripts/ai-unit.mjs` |
| `npm run ai:live` | `node scripts/ai-live-test.mjs` |
| `npm run read-aloud` | `node scripts/read-aloud-test.mjs` |
| `npm run read-aloud:unit` | `node scripts/read-aloud-unit.mjs` |
| `npm run recent` | `node scripts/recent-menu-test.mjs` |
| `npm run test:sessions` | `node scripts/sessions-test.mjs` |
| `npm run p0:unit` | `node scripts/p0-unit.mjs` |
| `npm run filename:unit` | `node scripts/filename-unit.mjs` |
| `npm run p0:lifecycle` | `node scripts/p0-lifecycle-test.mjs` |
| `npm run single:instance` | `node scripts/single-instance-test.mjs` |
| `npm run preview:zoom` | `node scripts/preview-zoom-test.mjs` |
| `npm run preview:unit` | `node scripts/preview-render-unit.mjs` |
| `npm run preview:worker:unit` | `node scripts/preview-worker-unit.mjs` |
| `npm run preview-owner:unit` | `node scripts/preview-owner-unit.mjs` |
| `npm run preview-freshness:unit` | `node scripts/preview-freshness-unit.mjs` |
| `npm run preview-store:unit` | `node scripts/preview-store-unit.mjs` |
| `npm run preview:dom` | `node scripts/preview-dom-test.mjs` |
| `npm run preview:perf` | `node scripts/preview-performance-test.mjs` |
| `npm run preview:bench` | `node scripts/prose-render-bench.mjs --verify-equivalence` |
| `npm run prose:phase:unit` | `node scripts/prose-phase-unit.mjs` |
| `npm run typewriter` | `node scripts/typewriter-test.mjs` |
| `npm run paste:convert` | `node scripts/paste-convert-test.mjs` |
| `npm run paste` | `node scripts/rich-paste-test.mjs` |
| `npm run asciidoc` | `node scripts/asciidoc-test.mjs` |
| `npm run asciidoc:export:unit` | `node scripts/asciidoc-export-unit.mjs` |
| `npm run image:syntax` | `node scripts/image-syntax-test.mjs` |
| `npm run image:rules` | `node scripts/image-rules-test.mjs` |
| `npm run links` | `node scripts/link-navigation-test.mjs` |
| `npm run links:unit` | `node scripts/link-target-unit.mjs` |
| `npm run typst:preview` | `node scripts/typst-preview-test.mjs` |
| `npm run typst:perf` | `node scripts/typst-performance-test.mjs` |
| `npm run typst:scheduler:unit` | `node scripts/typst-scheduler-unit.mjs` |
| `npm run licence` | `node scripts/licence-test.mjs` |
| `npm run spellcheck` | `node scripts/spellcheck-test.mjs` |
| `npm run spellcheck:unit` | `node scripts/spellcheck-unit.mjs` |
| `npm run format:document` | `node scripts/format-document-test.mjs` |
| `npm run images` | `node scripts/image-paste-test.mjs` |
| `npm run screenshot` | `node scripts/screenshot.mjs` |
| `npm run site` | `node scripts/build-site.mjs` |
| `npm run site:serve` | `node scripts/build-site.mjs --serve` |
| `npm run site:images` | `python scripts/optimize-site-images.py --write` |
| `npm run site:images:check` | `python scripts/optimize-site-images.py --check` |
| `npm run check:rust` | `cargo check --manifest-path src-tauri/Cargo.toml` |
| `npm run test` | `node scripts/test-all.mjs` |
| `npm run test:rust` | `cargo test --manifest-path src-tauri/Cargo.toml` |
| `npm run repo:hygiene` | `node scripts/repo-hygiene.mjs` |
| `npm run repo:hygiene:history` | `node scripts/repo-hygiene.mjs --history` |
| `npm run repo:hygiene:test` | `node scripts/repo-hygiene-test.mjs` |
| `npm run security:scan` | `node scripts/security-scan.mjs --staged` |
| `npm run security:history` | `node scripts/security-scan.mjs --history` |
| `npm run security:self-test` | `node scripts/security-scan.mjs --self-test` |
| `npm run security:hooks` | `node scripts/install-security-hooks.mjs` |
