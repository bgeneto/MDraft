# Releasing, the landing page and portable builds

How a tag becomes a published release, how the landing page is built and
deployed, what the portable build changes, and the checklist to run before
tagging.

Related: [development.md](development.md#build-pipeline) for the pipeline,
[catalog/build-and-site.md](catalog/build-and-site.md) for the scripts.

## Releasing

One workflow does everything: `.github/workflows/release.yml`, triggered by
pushing a tag.

```bash
git tag -a v0.1.0 -m "MDraft 0.1.0"
git push origin master --follow-tags
```

What happens then:

1. **`check-version.mjs` runs first**, before the toolchain is even installed. It
   fails in seconds if the tag and the two version files disagree, instead of
   after a twenty-minute build.
2. **Two build jobs run in parallel**, `windows-latest` and `ubuntu-22.04`,
   `fail-fast: false` so one platform failing does not hide the other's result.
   Each runs `npm run dist` and stages into `bin/<os>/<arch>/`.
3. **Artefacts are uploaded even on failure** (`if: always()`), so a broken build
   can be downloaded and inspected rather than guessed at.
4. **A single release job** downloads both and creates the GitHub release. It is
   deliberately one job: two jobs racing to create the same release means the
   loser fails with a 422.

No secrets are configured. The release uses the token GitHub provides, which is
why the workflow asks for `contents: write` — the default token is read-only on
newer repositories.

`workflow_dispatch` re-runs the build for a tag that is already pushed, for when
a job failed and the tag should not move.

Three things are easy to get wrong here and are worth knowing:

- **Pushing `.github/workflows/` needs the `workflow` token scope.** A classic
  PAT with only `repo` is rejected with *"refusing to allow an OAuth App to
  create or update workflow ... without `workflow` scope"*, and the error names
  the file rather than the scope.
- **The Windows runner installs Visual Studio **Enterprise**.** `with-msvc.cmd`
  searched only `BuildTools` and `Community`, so CI would have failed with
  *"Could not find vcvars64.bat"* on a runner that has a complete toolchain. The
  Enterprise and Professional paths are now in the search list.
- **`APPIMAGE_EXTRACT_AND_RUN=1`** is set in the workflow. linuxdeploy, which
  Tauri runs to build the AppImage, is itself an AppImage and needs FUSE, which
  the runners do not have; the variable makes it run by extraction instead.
- **Release assets share one flat namespace.** Both platforms stage a
  `SHA256SUMS.txt` and a `manifest.json`, so uploading both silently keeps
  whichever finished last and discards the other platform's checksums. The first
  release shipped the Linux checksums alone for exactly this reason. The release
  job renames them to `SHA256SUMS-<platform>.txt` and `manifest-<platform>.json`
  before uploading; anything else added later with a platform-independent name
  needs the same treatment.

## Landing page (GitHub Pages)

`site/` is the source of the landing page; `_site/` is generated and ignored.
`npm run site` assembles and validates it, and `npm run site:serve` serves it at
`http://127.0.0.1:4173/MDraft/`. The deploy is
`.github/workflows/pages.yml`, which uploads only `_site/` on a site change, on
a published release (to refresh the version) and on manual dispatch.

The page is bilingual: English at `/` and Brazilian Portuguese at `/pt-br/`.
Both are static HTML with one stylesheet and one small script (theme toggle and
lightbox). There is no framework and no third-party request: the fonts, icons,
screenshots and social image are self-hosted.

What the build enforces, and what a change must keep true:

- The origin and base path come from `configure-pages`; every internal link is
  relative, so the same artifact works at `/MDraft/` and at a custom-domain
  root. Canonical, Open Graph, JSON-LD and the sitemap use absolute URLs from
  the same pair.
- `scripts/optimize-site-images.py` resizes the captures in
  `docs/screenshots/` to WebP under `site/assets/img/`. Run
  `npm run site:images` when a screenshot changes, then commit the results;
  `npm run site:images:check` verifies format and dimensions. Pillow is needed
  only for that script, never for the site build or CI.
- The version chip and `softwareVersion` come from the latest release tag in
  CI, with `package.json` as the local fallback.
- A broken link, a missing image, a wrong dimension, a bad canonical, invalid
  JSON-LD, a FAQ answer that is not visible, a missing Portuguese section or a
  payload over the budget fails the build. The site is not part of `npm test`;
  validate it with `npm run site`, then `npm run format:check`,
  `npm run lint`, `npm run knip` and `npm run build`.
- **Pages must be enabled once with Source: GitHub Actions.** The workflow's
  `GITHUB_TOKEN` cannot do it: `configure-pages`'s `enablement` input needs a
  PAT with `repo` or `administration:write` + `pages:write`. Until that one-time
  setting exists the deploy job fails; the release workflow is unaffected.
- `docs/` is deliberately not published: it contains plans, ADRs and internal
  reviews.

Search Console is an owner action: verify the URL-prefix property
`https://bgeneto.github.io/MDraft/`, submit `sitemap.xml` and request indexing
for both languages. The project-level `robots.txt` is advisory; only the host
root is authoritative. A custom domain later needs only the `CNAME`/Pages
setting; the build reads the new origin from `configure-pages`.

## Portable builds

`mdraft_<version>_x64-portable.exe` is the ordinary Windows build compiled with
one extra config file, `src-tauri/tauri.portable.conf.json`. There is no portable
code path: the config sets `appDirectoriesOverride`, and Tauri applies it to its
own path APIs (`app_config_dir`, `app_data_dir`, and the webview's data
directory) and to plugins.

Two things follow from that, and both were verified rather than assumed:

- **`tauri-plugin-window-state` needs no change.** Its source hardcodes
  `app_config_dir().join(filename)` with no way to set the directory, which looks
  like it would strand `.window-state.json` in `%APPDATA%`. It does not: the
  override happens inside `app_config_dir()` itself, below the plugin. A portable
  run writes `.window-state.json` and `settings.json` into
  `<exe dir>/app-data/config/` and touches nothing in `%APPDATA%`.
- **Only `config` is redirected, on purpose.** `data` holds the pandoc download
  and the webview profile lives in the local data directory; both are large and
  volatile, and a Dropbox user does not want either synchronised.

`npm run dist` builds the portable variant first, parks it as
`target/release/<name>-portable.exe`, and then does the ordinary build, because
both passes write the same `target/release/mdraft.exe` and the staging step must
still find the ordinary one there. `--no-portable` skips the pass; it is skipped
automatically on Linux, where the AppImage is already a single self-contained
file.

Staging keeps only the portable on Windows, under
`mdraft_<version>_<arch>-portable.exe` (`x64`, like the installers). The bare
`MDraft.exe` is deliberately **not** published: it is the same program as the
portable with settings in `%APPDATA%`, and two near-identical executables make
the download page ambiguous. Linux still publishes the bare `mdraft`.

Every staged artefact name is lowercase apart from its extension, because
`productName` is `MDraft` on Windows and `mdraft` on Linux and one release must
not offer two spellings of the same product. The rename happens at staging, not
by changing `productName`: the installed application, its Start-menu entry, its
uninstaller and its `MDraft.exe` keep their names. A file extension keeps the
case Tauri gave it, so the AppImage stays `.AppImage`.

`stage-artifacts.mjs` resolves bare binaries by listing `target/release` and
matching case-insensitively, rather than returning a path it constructed. The
names it looks for are guesses (`mainBinaryName`, `productName`, the Cargo
package, each possibly differing in case) and Windows matches them
case-insensitively while Linux does not, so a constructed path stages fine on one
platform and fails on the other.

## Release checklist

1. Bump `version` in `package.json` **and** `src-tauri/tauri.conf.json` — Tauri
   reads the latter for the bundle, and the two must agree. `npm run
   check:version` proves it, and CI runs the same check against the tag.
2. `npm run build` — typecheck plus frontend bundle.
3. `npm run test:rust` — 302 runnable tests on Linux (2026-11-03; Windows runs the same suite minus the 7 Linux-only Wayland tests), with two ignored downloads (pandoc and Typst), the ignored display-owned Linux print probe and the ignored host speech probe. Run them on Linux too
   (`cd ~/.cache/mdraft-build/src-tauri && cargo test`): the path tests are
   `#[cfg]`-split, so half of them never execute on either platform alone.
4. Launch with each fixture and run `npm run smoke`, `npm run menu`,
   `npm run preview:zoom`, `npm run math`, `npm run syntax`, `npm run html`,
   `npm run asciidoc`, `npm run favorites`, `npm run filename:unit`,
   `npm run ai:unit`, `npm run ai`, `npm run read-aloud:unit`,
   `npm run read-aloud`, `npm run typography:unit`, `npm run typography` and
   `npm run pdf:native` — 114 + 123 + 24 + 12 + 10 + 60 + 54 + 56 + 76 + 184 +
   323 + 99 + 49 + 27 + 60 + 21 checks; also run
   `npm run typewriter` (21 checks, plus the manual visual
   hold when changing its behavior), and `npm run ai:live` when the Qwen
   credentials are present.
5. `npm run audit` against both `docs/sample-files` documents and compare the
   counts with the table in the README.
6. When a release changes the feature list, re-read `site/index.html` and
   `site/pt-br/index.html` against the README, refresh the screenshots with
   `npm run site:images` if the UI changed, and run `npm run site`. The landing
   page is the shopfront; a stale claim there is worse than a long README.
7. `npm run dist` — installers and checksums land in `bin/<os>/<arch>/`.
8. `.\scripts\test-close.ps1` — the release binary must exit on WM_CLOSE and
   write `.window-state.json`. Do not skip it: it passed in every other test and
   still failed in a shipped build once.
9. Install the MSI **and** the NSIS setup on a clean profile; confirm the icon and
   that the app starts with no console window. Note there are **no**
   `fileAssociations` in the bundle config, so the installer does not register
   `.md` — adding that would be a deliberate feature, not a fixed default.
10. Confirm the release binary still refuses to do anything on its own: no
    network at start-up, no telemetry, no licence check.
11. For Linux: `bash scripts/build-linux.sh`, then
    `sudo apt install -y ./bin/linux/amd64/mdraft_*.deb` and launch `mdraft`
    from a WSLg or desktop session. Check the GTK menu bar, the outline, math and
    the status-bar icons. `dpkg -s mdraft` must report `Package: mdraft` with
    `Replaces: m-draft`, the launcher must still read **MDraft**, and
    `/usr/share/applications/` must hold only `mdraft.desktop`.
12. Tag and push — CI builds both platforms and publishes the release. See
    [Releasing](#releasing).
