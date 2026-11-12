# Refresh the bilingual product site and keep release downloads current

**Status:** done
**Date:** 2026-11-12
**ADR:** none

**Approved scope update (2026-11-12):** The user is publishing 0.9.0 now and
explicitly requested removal of all temporary upcoming-release notices, plus
Emmet highlights in the HTML section. The final site presents the 0.9.0 feature
set directly in both languages. Remove the temporary availability templating
and its checks; retain strict latest-stable version resolution, pinned links,
placeholder checks and automated Pages rebuilding. Earlier availability notes
below record the original investigation and are superseded by this update.

## Context and goal

The published English and Brazilian Portuguese pages both show v0.7.8 even
though the latest stable GitHub release is v0.8.0. Both pages display five
literal `<version>` placeholders in installer filenames. Every platform button
opens the same general release page, and the filenames are not download links.

Both pages still describe four markup languages. HTML has only a short language
card, without a dedicated screenshot or a useful explanation of its editing
tools. LaTeX appears as math syntax and a pandoc export target, rather than an
editable document format with PDF compilation.

Read-only investigation on 2026-11-12 confirmed:

- Both live pages have three v0.7.8 chips, no LaTeX section, no HTML screenshot,
  and the same five placeholder filenames.
- GitHub's latest release is `v0.8.0`, published 2026-11-06. Its Windows setup,
  MSI and portable executable, Linux deb and AppImage, and bare `mdraft` binary
  all exist with concrete 0.8.0 filenames.
- The Pages push run started before the v0.8.0 release build completed. There
  was no subsequent Pages run after that release was published.
- `release.yml` publishes through `GITHUB_TOKEN`. GitHub suppresses downstream
  `release: published` workflow runs for that token; the current Pages trigger
  therefore misses automated releases.
- `scripts/build-site.mjs` replaces `{{VERSION}}`, while the filenames use
  `&lt;version&gt;`. Its placeholder check only looks for double braces.
- A baseline `SITE_VERSION=0.8.0 npm run site` passes despite those filename
  placeholders: initial payload 470 KB, total site 1622 KB.
- `package.json` is already 0.9.0, while `v0.8.0:README.md` and that release's
  source predate LaTeX support and the new completion layer. Published downloads
  must not be presented as containing unreleased features.
- The supplied `docs/screenshots/html-editor.webp` exists (1919 x 1050) and was
  visually inspected. It is ignored by Git; use it as the unchanged source for
  a committed, optimized site asset.
- The working tree contains unrelated application/Emmet work. Preserve it.

The goal is an accurate, useful product presentation in both languages, with
the supplied HTML screenshot, substantial LaTeX and HTML coverage, and release
versions and downloads that update together after each successful publication.

Evidence:

- [English site](https://bgeneto.github.io/MDraft/) and
  [Portuguese site](https://bgeneto.github.io/MDraft/pt-br/).
- [Latest stable release](https://github.com/bgeneto/MDraft/releases/tag/v0.8.0).
- [Pages run before publication](https://github.com/bgeneto/MDraft/actions/runs/42269210644)
  and [successful release run](https://github.com/bgeneto/MDraft/actions/runs/42269233977).
- [GitHub token trigger behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow).

## Scope and non-scope

Cover both landing pages, their navigation and footer links, product copy,
metadata and visible/structured FAQ answers, the HTML image pipeline, download
rendering and checks, the Pages trigger, and the associated site documentation.
Keep the established design, bilingual parity, accessible lightbox, theme
switch, responsive layout and static GitHub Pages hosting.

Do not change application behavior, settings, dependencies, versions, tags,
release packaging or `release.yml`. Describe the existing Emmet implementation
as requested in the approved scope update; do not change its application code.
Do not migrate hosting or create a new Sites project. Publication
to GitHub Pages happens through the existing repository workflow after these
changes reach the default branch; do not commit or push unrelated work.

## Approach and rejected alternatives

Add focused HTML and LaTeX sections using the site's existing visual patterns.
Show the supplied HTML capture with localized alt text, captions, intrinsic
dimensions, lazy loading and the existing enlarge interaction. Explain live
HTML rendering with the document's CSS, local assets and scripts; syntax
highlighting, tag closing, formatting, outline and source/preview navigation;
and the static versus script-dependent print/PDF distinction. Highlight Emmet
with HTML and CSS input/output examples and explain Tab behavior, snippet
fields, embedded CSS, offline use and its Editor preference.

Explain LaTeX as a document workflow: opt-in bundled LuaLaTeX, a compiled PDF
with selectable text, compile/cancel and automatic compilation, project files
and bibliographies, diagnostics, completion and formatting, local packages, and
the optional installed TeX backend. Keep networking claims precise: verified
engine/formatter downloads and package fetching require the relevant explicit
action; document contents remain local; a selected external TeX distribution
can have its own package-manager traffic. Do not claim universal source/PDF
matching or SyncTeX support.

Present five formats and the 0.9.0 feature set consistently in the overview,
structured data and FAQ. Per the user's scope update, remove all temporary
upcoming-version notices and the availability templates: the user is publishing
0.9.0 now. Continue resolving the actual latest stable version for badges and
downloads independently of the feature copy.

Keep all version substitution at build time, with no client-side release API
request. Render filenames with the same validated release version as the chips
and JSON-LD. Turn the six artifact entries into direct links pinned to that
version's release tag; make each platform's primary button select its normal
installer and retain an all-releases link. Keep checksums reachable. Extend
validation to reject angle-bracket version placeholders and mismatched
artifact labels/URLs.

In `pages.yml`, add `workflow_run` on completion of the existing `Release`
workflow, guarded to successful tag release runs. Retain push, manually
published release and manual dispatch entry points. Resolve the latest stable
release on every deployment, so rerunning an older release cannot downgrade
the site. Fail a CI deployment if that lookup fails or its version is invalid;
keep `package.json` fallback for local builds only. Preserve current token
permissions and do not execute source or download artifacts from the triggering
workflow. Expand Pages path filters for the image optimizer inputs as needed.

Rejected alternatives:

- Hardcode 0.8.0: fixes this screenshot but recreates the next stale release.
- Use the working-tree package version in CI: currently advertises an
  unpublished 0.9.0 and can generate nonexistent installer links.
- Resolve versions in visitors' browsers: adds request/rate-limit/error states
  and leaves no-JavaScript content and structured data stale.
- Add a personal access token or rewrite `release.yml`: unnecessary when a
  successful Release `workflow_run` can trigger the existing Pages workflow.
- Invent a LaTeX screenshot or claim the supplied HTML image demonstrates new
  completion features: unsupported by the provided image.

## Steps

- [x] Audit both live pages, the local source, release assets, workflow history,
  implemented features, screenshot and baseline validation.
- [x] Obtain explicit approval and update this plan's status (2026-11-12).
- [x] Add and translate the HTML and LaTeX sections, update the overview,
  navigation, footer, exports, privacy, FAQ and metadata consistently, and
  reflect the 0.9.0 feature set without temporary availability notices.
- [x] Add the supplied HTML capture to the existing optimization pipeline and
  integrate its committed WebP output with responsive styling and the lightbox.
- [x] Render concrete, versioned artifact links and extend the builder's
  release/version/placeholder/feature-availability checks.
- [x] Fix Pages rebuilding after an automated release and enforce reliable
  latest-stable version resolution for deployment.
- [x] Validate the release versions, links, translations, metadata, layouts,
  screenshot behavior and workflow logic; record any observed limitations.
- [x] Update the site build/release documentation, record any qualifying traps,
  review the final scoped diff, and mark this plan done.

## Files and modules

- `site/index.html`: English sections, overview, navigation/footer, download
  links, FAQ, privacy/export statements and metadata.
- `site/pt-br/index.html`: the corresponding Brazilian Portuguese content and
  localized image descriptions and availability notices.
- `site/styles.css`: the additional feature/availability and download-link
  presentation, with responsive language cards and readable filenames.
- `site/assets/img/html-editor.webp`: optimized version of the supplied capture.
- `docs/screenshots/html-editor.webp`: track the supplied ignored source,
  unchanged, so image regeneration and checks also work from a fresh clone.
- `scripts/optimize-site-images.py`: register that capture and its output.
- `scripts/build-site.mjs`: include/validate the new image; render consistent
  release version and artifact URLs; reject unresolved
  filename placeholders and invalid version inputs.
- `.github/workflows/pages.yml`: guarded Release completion trigger, reliable
  latest stable lookup and relevant build input path filters.
- `docs/agent-guide/releasing.md`: explain the automatic release-to-Pages path,
  failure behavior and distinction between local and published versions.
- `docs/agent-guide/catalog/build-and-site.md`: document changed builder and
  image checks without adding an undocumented new script.
- `docs/agent-guide/traps/assets-and-site.md` and its count in
  `docs/agent-guide/traps.md`: record the valid multiline closing-tag and sticky
  header screenshot traps encountered during validation. Preserve unrelated
  edits in the trap index when staging.
- This plan: approval, progress, validation results and deviations.

`site/site.js` and both 404 pages should need no changes. If an observed issue
requires another file, update this plan before widening the implementation.

## Risks and rollback

- A checkout can be ahead of the published release. Always resolve badges and
  downloads from the published stable version rather than the package version;
  explicitly exercise 0.8.0, 0.9.0 and arbitrary future version inputs. The
  full 0.9.0 feature copy is intentional per the user's scope update.
- The additional section/image can worsen mobile layout or payload. Reuse the
  existing components, retain lazy loading and the current payload budgets, and
  inspect narrow screens and both themes.
- GitHub dispatch behavior cannot be proven end to end without a subsequent
  real release. Validate event guards and resolution locally; clearly report
  that production activation requires the workflow change on the default branch.
- Failing closed on a release lookup error retains the previous published site
  until a successful rerun, rather than publishing incorrect version information.
- Revert only this change's site, builder, optimizer, workflow and documentation
  edits to roll back. Preserve all pre-existing application work and the supplied
  screenshot. No application settings or release assets are changed.

## Tests and validation

1. Run `npm run site:images:check` after generating the new asset; inspect it.
2. Run `npm run site` with explicit 0.8.0 and 0.9.0 published versions, then an
   arbitrary future version to prove filenames are not hardcoded. Confirm chips,
   artifact labels, pinned URLs and JSON-LD agree in both
   languages. Confirm LaTeX/Emmet descriptions and no temporary release notices
   for every build. Reject malformed version input before it reaches markup or URLs.
3. Build at `/MDraft/` and at an empty base path/custom origin; retain existing
   link, canonical, hreflang, image, FAQ parity, sitemap and payload checks.
4. Demonstrate that a reintroduced encoded `<version>` filename fails the
   validator; restore the real template immediately after the negative check.
5. Compare generated 0.8.0 artifact links with the published release's asset
   list, without downloading the installers.
6. Validate the Pages YAML/event guards and shell commands for push, manual
   dispatch, manual release, successful tag Release completion and failed or
   non-tag runs; ensure a failed API lookup cannot silently publish 0.9.0.
7. Preview English and Portuguese in light/dark themes on desktop and mobile.
   Check overflow, section anchors, the HTML image load/enlarge/close keyboard
   behavior, download link targets and no-JavaScript content. Use the existing
   server; no new browser dependency.
8. Run the documented site quality gates (`npm run format:check`, `npm run lint`,
   `npm run knip`, `npm run build`), attributing any pre-existing failures to the
   concurrent application changes rather than modifying them. Do not run the
   application UI suites, Rust builds or full `npm test` for this site-only change.

The decisive measurement is that a build against released 0.8.0 displays
`v0.8.0` and exact matching installer links in both languages, with no
`<version>` text, and that both pages present LaTeX and Emmet without temporary
coming-soon warnings as requested for the 0.9.0 publication.

## Acceptance criteria

- Both pages give HTML its own screenshot and concrete feature highlights.
- Both pages explain the implemented LaTeX workflow and its setup, networking
  and availability accurately.
- Both pages describe the 0.9.0 feature set directly, including Emmet examples,
  with no temporary upcoming-version notices or availability templating.
- All five versioned filenames and the bare Linux binary are usable links to
  the same release version shown by the chips and structured metadata.
- Automatic GitHub release publication has a guarded Pages rebuild path that
  does not depend on the suppressed bot-generated `release` event.
- Both languages retain matching sections/images and visible FAQ/schema parity;
  mobile layout, lightbox access, base-path portability and payload budgets pass.
- The repository's unrelated application changes remain untouched.

## Open questions

None. The user explicitly requested direct 0.9.0 feature copy while publishing
that release. Do not create a release or tag as part of this site change.

## Execution record

- Approved by the user on 2026-11-12; implementation follows this scope.
- The user requested a commit after validation, and explicitly authorized
  `playwright-cli` for browser QA. Commit only this task's changes.
- Read-only baseline: `SITE_VERSION=0.8.0 npm run site` passed, including both
  languages, both 404 pages, FAQ/schema parity, images, links and payload checks.
  No site or workflow source had been edited at that point.
- Final site builds passed with 0.8.0, 0.9.0, 0.10.0 and 1.2.3, including a
  custom-origin root and a different project base path. Chips, six artifact
  links, platform buttons, checksum links and JSON-LD match the selected version.
  All builds present the requested five-format/Emmet copy without transition notes.
- Negative checks passed: malformed and prerelease versions are rejected;
  missing/empty `SITE_VERSION` in CI cannot fall back to the development package;
  an encoded filename `<version>` fails validation. The source was restored.
- YAML parsing and event-guard cases passed for push, release, manual dispatch,
  successful tag completion, failed/cancelled/timed-out runs, ordinary branch
  runs and foreign repositories. The actual Bash release-resolution step passed
  against mocked stable tags, prereleases, empty/null tags and API failure.
- All ten generated download URLs were compared with the live v0.8.0 release
  assets and matched. No installers were downloaded. Actual future release
  triggering remains a production check after this workflow reaches the default branch.
- Image checks passed for all 11 captures using the bundled Python runtime
  (the default Python lacks Pillow). The HTML derivative is 1800 x 985 and
  154,150 bytes; the supplied original is preserved and included for regeneration.
- `playwright-cli` passed English and Portuguese at 1440 px and 390 px, in light
  and dark themes: no horizontal overflow, correct versioned links, loaded HTML
  image and Emmet examples, lightbox open/Escape/focus restoration, theme
  toggle/persistence, no-JavaScript fallbacks and section-anchor clearance.
  Screenshots were visually inspected. There were no page errors or third-party requests.
- Final site formatting and `git diff --check` passed. Initial payload is
  484 KB and total output is 1802 KB, within the unchanged 900 KB/2.5 MB budgets.
- `npm run knip` and `npm run build` passed. Repository-wide `format:check`
  reports 14 pre-existing application/test files; `npm run lint` reports
  pre-existing `no-control-regex` errors in `src/latex-outline.ts:184` and
  `src/paste/render-latex.ts:37`. Those files were not changed by this task.
  App UI suites, Rust builds and full `npm test` were skipped for this site-only change.
- Two site-validation traps were recorded. The temporary availability
  templating was removed per the user's approved scope update. Other application
  and documentation changes in the shared working tree are excluded from this commit.
