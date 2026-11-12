# Build, packaging and landing-page scripts

The build helpers, the staging and version commands, and the landing-page
tooling. Every row is the one from the repository guide's script inventory,
moved here unchanged; the command names are the same.

The pipeline these commands drive is described in
[../development.md](../development.md#build-pipeline). The release flow that
uses `dist`, `stage` and `check:version` is in
[../releasing.md](../releasing.md).

## npm entry points

| Command | Runs | Does |
| --- | --- | --- |
| `npm install` | — | Install frontend dependencies |
| `npm run dev` | `vite` | Vite dev server only, no Tauri shell |
| `npm run tauri dev` | `tauri dev` | Full app with HMR |
| `npm run build` | `tsc --noEmit && vite build` | Typecheck plus frontend bundle into `dist/` |
| `npm run format` | `prettier --write …` | Format the TypeScript, JavaScript, CSS, JSON and HTML sources; see `.prettierignore` |
| `npm run format:check` | `prettier --check …` | Fail when a source file is not Prettier-formatted |
| `npm run lint` | `eslint src` | ESLint plus typescript-eslint over the frontend |
| `npm run knip` | `knip --include dependencies,unlisted` | Fail on an unused dependency or an import that is not declared |
| `npm run dist` | `scripts/dist.mjs` | Build, bundle and stage into `bin/<os>/<arch>/` |
| `npm run stage` | `scripts/stage-artifacts.mjs` | Re-stage what is already built |
| `npm run check:version` | `scripts/check-version.mjs` | The two version files agree, and match a tag when one is given |
| `npm run check:rust` | `cargo check` | Fastest Rust feedback |
| `npm run test:rust` | `cargo test` | 271 passed on Windows, 270 on Linux; two ignored downloads, plus the ignored display-owned Linux print probe |
| `npm run screenshot` | `scripts/screenshot.mjs` | PNG of the running window |
| `npm run site` | `scripts/build-site.mjs` | Build and validate the landing page into `_site/`: copies fonts/icons/WebP screenshots, injects the origin and stable version, renders pinned artifact links, validates LaTeX/Emmet metadata, generates the sitemap, and rejects unresolved filenames, inconsistent downloads, broken links, bad metadata or bilingual mismatches. `SITE_VERSION` is required in CI; local builds fall back to `package.json` |
| `npm run site:serve` | `scripts/build-site.mjs --serve` | The same build, then serves `_site/` at `http://127.0.0.1:4173/MDraft/` with Node's `http` module |
| `npm run site:images` | `scripts/optimize-site-images.py --write` | Resize and encode the landing-page captures from `docs/screenshots/` into `site/assets/img/*.webp`; needs Pillow, and is run by hand, never by CI |
| `npm run site:images:check` | `scripts/optimize-site-images.py --check` | Verify the committed WebP files, including the HTML editor capture: format, expected dimensions, no upscaling |

## Test harnesses

Every harness here needs the app already running with CDP enabled (see
[../testing.md](../testing.md#running-the-cdp-tests-correctly)) **and the right
document loaded**. The port is always `argv[2]` and defaults to `9222`.

| Script | Arguments | Needs this document | Proves |
| --- | --- | --- | --- |
| `fetch-fonts.ps1` | `[--work-directory]` | — | Downloads the thirteen families pinned in `scripts/font-sources.json`, verifies every source, subsets the Google faces through `scripts/subset-fonts.py`, and rewrites `src/assets/fonts/fonts.json`. Only needed to upgrade them; needs Python/fonttools; the fonts are committed |
| `set-palette.mjs` | `[port] [paletteId] [--split]` | `samples/feature-tour.md` | Not a test: drives the palette through the Preferences UI so you can screenshot a theme |
| `screenshot.mjs` | `[port] [out.png] [setupExpression]` | any | Not a test: captures the window, optionally after running a JS setup string |

## Build and environment helpers

| Script | Arguments | Does |
| --- | --- | --- |
| `dist.mjs` | `[-- <tauri build args>] [--kill]` | Typechecks, builds the frontend, routes through the MSVC wrapper on Windows, then calls `stage-artifacts.mjs`. Streams output; exits non-zero on any failure. **Refuses to start while a copy of the app is running** (Windows locks a running executable, so cargo cannot replace it) unless `--kill` is given, which closes it first. Also refuses with the `npm ci` instruction when the local `@tauri-apps/cli` is missing, rather than letting `npx` fetch the unrelated registry package |
| `stage-artifacts.mjs` | `[--dry-run]` | Copies the binary and every installer into `bin/<os>/<arch>/` under all-lowercase names (the extension keeps its case, so `.AppImage` stays), with `SHA256SUMS.txt` and `manifest.json`. The manifest keeps the display `productName`, and bundle filenames are matched against the platform config's product name, which is `mdraft` on Linux. Fails loudly, naming the path it searched, when it finds no bundles |
| `build-linux.sh` | `[--bundles deb,appimage] [--build-dir path]` | The whole Linux build inside WSL2 or a container — see [Building for Linux](../development.md#building-for-linux). Clears the cached `bundle/{deb,rpm,appimage}` before building and previous installers from `bin/linux/amd64` before collecting, so a previous name or version cannot linger |
| `with-msvc.cmd` | `<command> [args…]` | Loads `vcvars64.bat` then runs the command. **Required for every cargo or tauri invocation on this host.** Searches the standard Visual Studio locations, including the Enterprise edition the GitHub runners install |
| `cargo-vcvars.cmd` | `<cargo args…>` | The same wrapper specialised for cargo: `cargo-vcvars.cmd test --manifest-path src-tauri\Cargo.toml` |
| `check-version.mjs` | `[tag]` | Asserts `package.json` and `src-tauri/tauri.conf.json` carry the same version, and that a supplied tag (`v0.1.0`, or `GITHUB_REF_NAME`) matches. CI runs it before building anything |
| `build-icons.mjs` | `[--source path] [--out dir]` | Regenerates every file in `src-tauri/icons/` from one square master PNG (default `docs/icon/mdraft-icon.png`): the bundle PNGs including `256x256.png`/`512x512.png`, the Windows Store logos, `icon.ico` and `icon.icns`. Resamples with Lanczos, quantises each size to a small palette and wraps the frames itself, so the set stays around 300 KB instead of the 2.4 MB `tauri icon` produced. `npm run icons` is the same command |
| `subset-fonts.py` | `--source … --output … [--instance JSON] [--instance-after-subset] [--features csv] [--require csv]` | Instances and subsets one source into woff2, verifies the Latin probe and the required OpenType features. Called by `fetch-fonts.ps1` for each Google output; needs Python, fonttools and brotli. Keeps the source's `head.modified`, so the same input produces the same SHA-256 |

## Testing layers

These rows are part of the ordered layer table; the full order and what the
runner does around them are in [../testing.md](../testing.md).

| Layer | Command | Count | Catches |
| --- | --- | --- | --- |
| Typecheck | `npm run build` | — | Type errors, unused imports |
| Rust unit | `npm run test:rust` | 302 on Linux (2026-11-03), 4 ignored; Windows omits the 7 Linux-only Wayland tests | Path handling, sanitisers, file IO, settings, recent-list order/cap (100 stored, 20 in the menu), the favorites order/cap (50, refused not evicted), the remembered-tab cap (20), menu labels, token estimate, the AI context budget and its token-bounded prefix/suffix helpers, the filename prompt's first-line/label/wrapper cleaning, the reader's prompt file (round trip, sparse override, unknown action and placeholder, fence and preamble rules, caps), spellcheck, HTML preview scheme, export reader selection, the PDF scratch directory, xz/tar release extraction, image content sniffing (WebP/AVIF brands), `${filename}`, the untitled image guard, the Typst image root, the OS opener's executable refusal, the recovery journal's round-trip/id/cap rules, checked-write hashes and same-metadata conflicts, launch argument parsing and path identity, the keychain/file/session fallback branch, the AI prompts/tags/caps/URL joins, the fixed wrapper appendix, the namespaced wrappers and the answer sanitizer, SSE parsing and model-list diagnostics, installed-family normalisation and the widened preset overrides |
| Close | `.\scripts\test-close.ps1` | 4 | The window really exits and saves its state |
