# Landing page for MDraft on GitHub Pages

**Status:** done
**Date:** 2026-11-03
**ADR:** `../adr/2026-11-03-static-landing-page.md`

## Context and goal

The repository is public and has releases, but its only shopfront is
`README.md`. The GitHub API reports:

- `homepage` is empty and `has_pages` is `false`;
- the latest release is `v0.7.8`, with Windows installers (NSIS, MSI,
  portable), Linux packages (`.deb`, AppImage, bare binary) and per-platform
  checksums;
- the description is "Live-preview editor for Asciidoc, Markdown, Typst, and
  HTML." and the topics are already sensible.

A README is not a landing page. It is long, it is rendered inside GitHub's
chrome, it has no canonical URL of its own, no structured data, no social
preview beyond GitHub's card, and no place to explain in thirty seconds what
the product is and which file to download. Someone searching for an AsciiDoc or
Typst editor on Windows will not find the repository unless they already know
its name.

The goal is a fast, static, crawlable bilingual landing page at
`https://bgeneto.github.io/MDraft/` that:

1. explains in one screen what MDraft is and who it is for;
2. sends the reader to the correct download in one click, without lying about
   platforms;
3. is fully readable by Google with no JavaScript, with a canonical URL,
   structured data, `hreflang` and a sitemap;
4. stays correct as releases ship, without a second copy of the version or of
   the bundled fonts;
5. loads quickly and makes **zero third-party requests**, matching the
   product's "no telemetry" promise;
6. speaks English and Brazilian Portuguese as two indexable pages, not as a
   client-side toggle.

"How to get indexed" is engineering plus an owner action: the page can be made
crawlable and submitted, but Google decides when and whether it is indexed, and
ranking is not something the code can promise. The plan treats that honestly.

The page's emphasis follows the product's strongest differentiators, in this
order: the opt-in AI Assistant (blue circular button, action palette, token
count), the vertical scroll precision and double-click word highlight, Typst
with Document and Pages views, advanced typography with math and code scales,
KaTeX typesetting, four markup languages, durability, exports and privacy.

## Decisions (2026-11-03)

1. **Domain:** `https://bgeneto.github.io/MDraft/`. No custom domain now; the
   build still takes origin and base path from `configure-pages`, so a domain
   can be added later without editing the page.
2. **Language:** bilingual from the first release. English at `/`, Brazilian
   Portuguese at `/pt-br/`, each with its own metadata, canonical, JSON-LD and
   `hreflang`; a two-link language switch, no JavaScript translation.
3. **Screenshots:** use the v0.7.8 captures already placed in
   `docs/screenshots/`, convert and resize them to WebP, and show them as
   rounded, shadowed thumbnails that open a larger image in an accessible
   lightbox.
4. **Analytics:** none. Search Console, GitHub traffic and release asset
   download counts are the measurement.
5. **Theme:** follow the operating system with a persistent light/dark toggle.
6. **Palette:** the icon's navy, white and cyan, not a generic SaaS gradient.

## Scope and non-scope

**In scope**

- A static site in `site/`: English landing page at `/`, Portuguese at
  `/pt-br/`, a 404 per language, `robots.txt`, icons, a 1200×630 Open Graph
  image, and optimized WebP screenshots.
- Design that follows the application's identity: the icon palette
  (navy `#002050`, cyan `#0bbaf4`, white), the bundled EB Garamond and IBM Plex
  Mono faces, the platform UI face for body text, light and dark themes,
  responsive layout, reduced-motion support, WCAG AA contrast.
- Featured sections for the AI Assistant, scroll precision and word highlight,
  Typst Document/Pages, typography presets with math and code scales, KaTeX
  math, and the four markup languages.
- A thumbnail → lightbox pattern for the wide screenshots, with keyboard
  support, Escape, backdrop close, focus restoration and reduced motion.
- SEO: per-language title, description, canonical, Open Graph, Twitter card,
  JSON-LD (`SoftwareApplication`, `WebSite`, `FAQPage`), reciprocal `hreflang`,
  `sitemap.xml` with both URLs, permissive `robots.txt`, semantic headings,
  alt text, and a Search Console-ready page.
- `scripts/build-site.mjs`: assembles `_site/`, copies the canonical fonts,
  optimized images and icons, injects the site URL and release version,
  generates the sitemap, validates the result, and can serve it locally.
- `scripts/optimize-site-images.py`: the reproducible WebP step (Pillow, run
  only when screenshots change; never a build dependency).
- `.github/workflows/pages.yml`: deploy on site changes, on release publication
  (to refresh the version), and manually.
- Repository metadata: the GitHub "Website" field, a README link, and two
  topics that are missing (`tauri`, `pdf`).
- Documentation: the ADR, this plan, both scripts in `AGENTS.md`, a short
  publishing section, and the traps found while doing it.
- `package.json` scripts for the site and Prettier coverage for `site/`.

**Out of scope**

- Buying or configuring a custom domain. DNS and purchase are the owner's.
- Publishing `docs/`. It holds plans, ADRs, backlog audits and internal review
  notes; serving it would expose material the README does not, and `.md` files
  would be delivered as raw text. Docs stay on GitHub and the site links there.
- A docs site, blog, changelog page or rendered release notes. Releases already
  have a page.
- Analytics, cookie banner, newsletter, contact form or comments.
- New application captures beyond the files supplied in `docs/screenshots/`.
  Cropping and resizing those files is in scope; opening the app for a new
  session is not.
- macOS binaries or a macOS download claim. The README says it is not currently
  published, and both pages must say the same.
- Any change to the application, its identifier, `productName`, or the release
  workflow.
- Automatic indexing. Search Console submission is an owner action.
- Direct links to versioned asset filenames. Releases move; the CTA goes to
  `releases/latest`.

## Approach and rejected alternatives

### Static HTML assembled by one Node script

`site/` holds the sources: `index.html`, `pt-br/index.html`, `styles.css`,
`site.js`, `404.html`, `pt-br/404.html`, `robots.txt`, and `assets/` (Open
Graph image, icons, optimized screenshots). The pages are hand-written HTML and
CSS with a small amount of JavaScript: the theme toggle and the lightbox.

`scripts/build-site.mjs` produces `_site/` (gitignored):

- copies the selected `.woff2` faces and their OFL texts from
  `src/assets/fonts/`, so the site never carries a second copy of a binary;
- copies the optimized `.webp` files from `site/assets/img/` (they are already
  the right size) and the icons from `src-tauri/icons/`;
- substitutes `{{ORIGIN}}`, `{{BASE_PATH}}`, `{{CANONICAL}}`, `{{VERSION}}`,
  `{{RELEASE_URL}}`, `{{YEAR}}`, `{{OG_IMAGE}}` and the reciprocal `hreflang`
  URLs in every page;
- writes `sitemap.xml`, `.nojekyll` and the final `robots.txt`;
- validates, then prints the initial-load budget.

The script accepts `SITE_ORIGIN`, `SITE_BASE_PATH` and `SITE_VERSION` from the
environment (the workflow fills them from `configure-pages` and the latest
release), with defaults for a local build. `--serve` builds and serves `_site/`
on a local port with Node's built-in `http` module, so previewing needs no new
dependency.

Why this shape: HTML is what a crawler reads; there is no hydration, no client
router, no framework, and no second `node_modules`. Fonts, screenshots and the
version keep one source of truth. The build is a validation gate rather than a
bundler.

### Bilingual structure

Two real pages, not one page with a language switch:

```
/                     English, lang="en"
/pt-br/               Portuguese, lang="pt-BR"
```

- Each page is self-canonical: `https://bgeneto.github.io/MDraft/` and
  `https://bgeneto.github.io/MDraft/pt-br/`.
- Reciprocial `<link rel="alternate" hreflang="en">`,
  `hreflang="pt-BR"` and `hreflang="x-default"` on both.
- The language switch is two ordinary links in the header and footer
  (`EN` / `PT-BR`), with `hreflang` and `lang` attributes, not a JavaScript
  preference. It works with JavaScript disabled and is crawlable.
- The sitemap lists both URLs; `robots.txt` allows both.
- The copy is translated, not machine-generated: Brazilian Portuguese idiom,
  `pré-visualização`, `tipografia`, `editor`, `software livre`, with the same
  claims and the same numbers as the English page.
- The build compares both pages: the same number of FAQ entries, the same
  section ids, the same image set, and reciprocal `hreflang`. A missing
  translation fails the build.

### Image pipeline

`docs/screenshots/` is the source of truth; the site never references it
directly. `scripts/optimize-site-images.py` (Pillow) reads the chosen files and
writes `site/assets/img/*.webp`:

| Source | Site name | Target | Use |
| --- | --- | --- | --- |
| `builtin-ai-assistant.webp` | `ai-palette.webp` | 640 px wide | AI panel, portrait |
| `auto-highlighting.webp` | `scroll-sync.webp` | 1800 px wide | Hero / scroll precision |
| `typst-ieee-conference-paper.webp` | `typst-pages.webp` | 2000 px wide | Typst Document/Pages |
| `typography-presets-proposal.png` | `typography-presets.webp` | 1400 px wide | Preset specimen |
| `typography-presets-implemented.png` | `typography-settings.webp` | 1200 px wide | Preferences panel |
| `math-light.png` | `math-light.webp` | 1400 px wide | Math, light |
| `math-dark.png` | `math-dark.webp` | 1400 px wide | Math, dark |
| `statusbar-p2.png` | `statusbar-tokens.webp` | native 1771×46 | Token/word counters |

Rules: never upscale; `Image.Resampling.LANCZOS`; WebP quality 82–86; strip
metadata; keep the 2× density for the AI panel; verify each output with
Pillow (`format == "WEBP"`, expected dimensions, file size). The script prints
the before/after bytes. The site build only *verifies* the committed outputs,
so CI needs no image library.

The two old README screenshots are not used: they show the retired **Files**
sidebar tab, while the new captures show the current UI, including the AI
button, the Favorites tab and the Document/Pages switch.

### Content and design direction

The page is an editorial product page, not a documentation index. Order:

- **Header** — wordmark, Features / AI / Typst / Typography / Download / FAQ,
  GitHub, EN/PT-BR, theme toggle. The primary download button appears on
  desktop.
- **Hero** — “The markup editor that shows you the page.” A sentence naming
  Markdown, AsciiDoc, Typst and HTML, the two CTAs, and a small print line:
  free, open source, Windows and Linux, no account, no telemetry. The visual is
  `scroll-sync.webp`, framed like an application window.
- **AI Assistant** — the first feature after the hero, because it is the newest
  and the most distinctive. Token-count framing (“not just words — estimated
  tokens in the status bar”), the blue circular button, fourteen actions under
  a learned *Most used* group, streaming, apply/insert/new tab, History, prompt
  editing, any OpenAI-compatible endpoint or Anthropic, key in the OS store,
  off by default. `ai-palette.webp` in a portrait card; the status bar strip
  as a small token detail.
- **Scroll precision** — the vertical scroll algorithm, verified text rather
  than a page fraction, both directions, word highlight on double-click in
  either pane, no jump when a word cannot be verified, atomic code/formula
  spans. `scroll-sync.webp` opens in the lightbox; a cropped detail may show
  the two highlighted spans.
- **Typst, two views** — Document and Pages, PDF.js text layer, selectable
  text, click a paragraph and land on its source, two columns, generated text
  stays unmapped, direct PDF compile. `typst-pages.webp`.
- **Typography** — thirteen bundled faces, six presets plus Custom, independent
  editor/prose/heading/code faces, per-preset sizes and OpenType switches, math
  scale and code scale to match the prose, system-font fallback. The specimen
  sheet `typography-presets.webp` and the Preferences panel
  `typography-settings.webp` in a two-image gallery.
- **Math** — KaTeX with real fraction and radical geometry, `$…$` and `$$…$$`,
  currency-safe Markdown, math scale. `math-light.webp` and `math-dark.webp`
  side by side as “the same document in both themes”.
- **Four languages** — four cards: Markdown (GFM, KaTeX, Mermaid, alerts,
  `[TOC]`), AsciiDoc (Asciidoctor, includes, stem), Typst (Document/Pages),
  HTML (sandboxed guest with its own CSS, images and scripts). This is where
  the search intent for “AsciiDoc editor” and “Typst editor” is answered.
- **Documents that survive** — tabs with per-tab caret and undo, remembered
  tabs, crash recovery, disk-change notice, close dialog. Text and a CSS tab
  strip; no invented UI.
- **Exports** — HTML, PDF and Print without extra tools; DOCX/ODT/EPUB/LaTeX
  through pandoc, installed in-app; Typst straight to PDF.
- **Quiet by design** — no account, no telemetry, no start-up request, no
  update check. This is also true of the page itself.
- **Download** — Windows and Linux cards with artifact names, portable note,
  checksum note, explicit “macOS is not currently published”. Primary buttons
  go to `releases/latest`.
- **FAQ** — free, offline, platforms, pandoc/Typst, settings location, AI
  optional, commercial use (MIT), data and privacy. The visible answers and the
  `FAQPage` JSON-LD are the same text.
- **Final CTA** — one download button and one GitHub link.
- **Footer** — MIT, source, issues, docs, font licences, “this page sets no
  cookies and loads nothing from third parties”.

Visual language: deep navy from the icon as the dark surface, warm paper as the
light surface, cyan as the single accent (links, the AI button echo, the
underline of a highlighted word), white for display type. EB Garamond for the
large editorial headings (the app's Renaissance preset), the system UI face for
body and chrome (as the app does), IBM Plex Mono for code, tokens and
measurements. Cards have a 1 px border, a soft shadow and a 14–18 px radius;
screenshots are thumbnails with a caption and a “view larger” affordance. Motion
is 120–200 ms and disabled under `prefers-reduced-motion`.

The AI section uses a restrained glow behind the portrait panel, not a generic
purple gradient. The token theme appears in the copy and in the status-bar
detail, not as a fake dashboard.

Copy rules: every claim is traceable to `README.md` or `docs/`; no star counts,
testimonials or invented benchmarks; no “fastest”; the AI section says it is
off by default; the download section says macOS is not published; the
Portuguese copy says the same things, not a looser paraphrase.

### Lightbox

Each wide screenshot is a `<button class="shot">` wrapping an `<img>` (WebP,
`width`/`height`, `loading="lazy"`, `decoding="async"`, descriptive `alt`). The
button opens a native `<dialog>` with the full image, a caption, a close
button, and previous/next when the image belongs to a gallery.

- `showModal()` handles the focus trap and the inert background; Escape closes
  natively; the backdrop click is handled explicitly.
- Focus returns to the thumbnail that opened it.
- Arrow keys move within a pair (math light/dark, typography specimen/settings)
  and are ignored when a single image is open.
- The open/close transition is a 160 ms opacity/scale; `prefers-reduced-motion`
  removes it.
- Without JavaScript the thumbnail is still a link to the full image, so the
  content is never trapped.
- The slide images are not lazy inside the dialog beyond the first; `src` is
  set on open to avoid downloading every full image up front.

### Why a folder in this repository

| Option | Verdict |
| --- | --- |
| `site/` in this repository | **Chosen.** One history, one CI, one review flow; the fonts, screenshots and icons already live here; a release can inject its version; the page changes with the product. |
| `docs/` | Rejected: publishing it exposes plans, ADRs and backlog audits, and serves `.md` as raw text. It is documentation, not a marketing site. |
| A separate `mdraft-site` repository | Rejected: splits the source of truth and adds a second CI setup for one page. |
| A `gh-pages` branch | Rejected: stores generated output in git, drifts from the sources, and duplicates the deployment the workflow already does. |
| GitHub Releases as the page | Rejected: no control over title, description, canonical, structured data or social preview. |

`site/` holds sources; `_site/` is the generated artifact and is gitignored. The
Pages workflow uploads only `_site/`, so nothing else in the repository is ever
published.

### Conversion and measurement

The page has one job: turn a visitor into a download or a GitHub visit. The CTA
hierarchy is deliberate:

- **Primary**, repeated at the hero, after the feature sections and in the
  download section: *Download MDraft* → `releases/latest`. One primary action
  per viewport; the header repeats it only on desktop.
- **Secondary**: *View on GitHub* and *Read the docs*. They are quieter and
  never compete with the download button.
- **Tertiary**: per-platform notes, checksums and “all releases”.
- No email capture, no modal, no fake urgency, no “limited offer”. The download
  page is GitHub's, and the button says where it goes.

Objections are answered in the order a reader raises them: what is it (hero),
what does it do (AI, scroll, Typst, typography, languages), is it for my
platform (download cards), is it safe and private (quiet-by-design), what does
it cost (free, MIT), what is the catch (optional AI, optional pandoc/Typst),
and the FAQ for the rest.

Measurement needs no third-party script:

- **Search Console** — queries, impressions, CTR and position, per language.
- **GitHub Insights → Traffic** — views and referrers to the repository.
- **Release asset download counts** — the closest thing to a conversion, per
  platform, already reported by GitHub.
- A privacy-friendly counter can be added later, but it would be the first
  third-party request on the page and would need a footer note.

### Publishing

`pages.yml` uses the Pages artifact flow, not a `gh-pages` branch:

```yaml
on:
  push:
    branches: [master]
    paths: ["site/**", "scripts/build-site.mjs", "package.json", ".github/workflows/pages.yml"]
  release:
    types: [published]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write
```

One job, `environment: github-pages`, `concurrency: pages` with
`cancel-in-progress: false`. Steps: checkout, Node 22, `configure-pages@v5`,
resolve the latest release tag with `gh release view --json tagName`, build with
`SITE_ORIGIN`/`SITE_BASE_PATH` from `configure-pages` and `SITE_VERSION` from
that tag, upload `_site` with `upload-pages-artifact@v3`, deploy with
`deploy-pages@v5`. The release trigger refreshes the version chip without a
site commit.

One-time prerequisite: the repository must have Pages enabled with **Source:
GitHub Actions**. `configure-pages` cannot enable it with `GITHUB_TOKEN`
(its `enablement` input documents that it needs a PAT with `repo` or
`administration:write` + `pages:write`). Either the owner sets it under
Settings → Pages, or the agent runs the equivalent `gh api` call once with the
authenticated owner token. Until then the deploy job fails and releases are
unaffected.

GitHub's limits are far above what this site needs: 1 GB published site, 100 GB
per month soft bandwidth, and HTTPS on `github.io` without configuration. The
artifact is a few hundred kilobytes plus the screenshots.

### Search Console and indexing

- Property: URL-prefix `https://bgeneto.github.io/MDraft/`.
- Verification: the HTML tag, pasted into `site/index.html`, or a verification
  file dropped into `site/` (the build copies root files). Both need a token
  from the owner's Google account.
- Submit `https://bgeneto.github.io/MDraft/sitemap.xml`; use URL Inspection →
  Request indexing once for each language.
- `robots.txt` is only authoritative at the host root, which belongs to
  `bgeneto.github.io` and not to this repository. A project-level file is
  harmless and helps crawlers that look there, but the sitemap submission is
  what actually matters.
- FAQ rich results are limited by Google's policy; the `FAQPage` markup is
  still valid, useful to other engines and harmless.
- Expect days to weeks, not minutes. The page should target specific intent
  ("AsciiDoc editor for Windows", "Typst live preview", "Markdown editor
  offline") and the Portuguese equivalents ("editor Markdown", "editor
  AsciiDoc", "editor Typst", "pré-visualização ao vivo") rather than the head
  term "markdown editor", where established products dominate.

### Rejected alternatives

- **Jekyll (the Pages default).** A Ruby toolchain, front matter and magic
  includes for two pages; nothing in the repository needs it.
- **Docusaurus, VitePress, Astro, Next.** A second npm project, a build chain,
  hydration and dependency updates for a static product page. Documentation
  already exists as Markdown on GitHub.
- **Publishing `docs/` as the site.** It exposes plans, ADRs and backlog audits,
  serves `.md` as raw text, and mixes internal documentation with marketing.
- **A `gh-pages` branch.** Manual, drifts from the sources, no PR preview, and
  the repository already deploys through Actions.
- **Tailwind CDN, Google Fonts, Google Analytics, embedded YouTube.** Each is a
  third-party request; the product promises none, and a cookie banner would
  follow. Everything is self-hosted or absent.
- **Fetching the latest release from the browser.** A runtime dependency, a
  rate limit and a failure mode that leaves a blank download section. The
  version is resolved at build time instead.
- **A JavaScript language switch.** Google indexes the visible language only;
  two pages with `hreflang` are indexable independently.
- **A carousel for the screenshots.** It hides content, breaks keyboard flow
  and adds a dependency; a thumbnail → lightbox keeps every image visible.
- **Client-side image resizing or AVIF generation.** A browser-side dependency
  and an inconsistent result; the images are optimized once and committed.
- **The GitHub Releases page as the landing page.** No control over title,
  description, canonical, structured data or social preview, and no place to
  explain the product.
- **A separate `mdraft-site` repository.** Splits the source of truth, adds a
  second CI setup, and the site changes with the product.
- **Direct links to versioned asset filenames.** They are correct only until
  the next release; the primary CTA goes to `releases/latest`, and the artifact
  names are shown as prose with `<version>` placeholders.

## Steps

- [x] Write the ADR: static site, no framework, self-hosted assets, no
      third-party requests, bilingual pages, `site/` + build script, Pages
      artifact flow, icon palette.
- [x] Run `scripts/optimize-site-images.py`; commit the WebP outputs and verify
      dimensions, format and bytes.
- [x] Create `site/index.html` (English) with the sections above, semantic
      landmarks, the SEO head, JSON-LD and token placeholders.
- [x] Create `site/pt-br/index.html` with translated copy, metadata, canonical,
      JSON-LD and reciprocal `hreflang`.
- [x] Create `site/styles.css`: icon palette, fluid type, two themes, responsive
      grid, gallery thumbnails, dialog/lightbox, focus states, reduced motion.
- [x] Create `site/site.js`: theme toggle with `localStorage`, lightbox
      (`<dialog>`, gallery arrows, focus restoration), no other behavior.
- [x] Create `site/404.html` and `site/pt-br/404.html` (`noindex`), and
      `site/robots.txt`.
- [x] Produce `site/assets/og.png` at 1200×630, language-neutral (wordmark,
      four language names, screenshot), with its source composition under
      `docs/`.
- [x] Write `scripts/build-site.mjs`: assembly, token substitution, sitemap,
      bilingual parity checks, link/image/JSON-LD validation, budget report and
      `--serve`.
- [x] Add `npm run site` and `npm run site:serve`; extend the Prettier globs to
      `site/**/*.{html,css,js}`; ignore `_site/`.
- [x] Add `.github/workflows/pages.yml`.
- [x] Update `README.md` with the site link; update `AGENTS.md` with both script
      rows, the publishing section, the release-checklist line and the traps.
- [x] Enable Pages (Settings → GitHub Actions, or `gh api` once), set the
      repository homepage to the site URL, add `tauri` and `pdf` topics.
- [x] Deploy, verify both live URLs, the headers, the HTML, the social card, the
      sitemap and the absence of third-party requests; run Lighthouse on both.
- [ ] Hand the owner the Search Console verification token step and submit the
      sitemap. The sitemap is live; verification needs the owner's Google
      account.

## Files and modules

| File | Why |
| --- | --- |
| `site/index.html` | English page: content, head metadata, JSON-LD, tokens. |
| `site/pt-br/index.html` | Portuguese page with the same structure. |
| `site/styles.css` | All styling; icon palette, no framework. |
| `site/site.js` | Theme toggle and lightbox only. |
| `site/404.html`, `site/pt-br/404.html` | Branded not-found pages; `noindex`. |
| `site/robots.txt` | Permissive crawl rules plus the sitemap URL (advisory under a project path). |
| `site/assets/og.png` | 1200×630 social preview, committed. |
| `site/assets/img/*.webp` | Optimized screenshots; the only images the pages load. |
| `docs/og-source.html` | The composition used to render the social preview; not published. |
| `scripts/optimize-site-images.py` | Reproducible resize + WebP step (Pillow, run on demand). |
| `scripts/build-site.mjs` | Assembles `_site/`, copies assets, injects values, validates, serves. |
| `.github/workflows/pages.yml` | Builds and deploys the artifact to Pages. |
| `package.json` | `site`/`site:serve` scripts and Prettier globs. |
| `.gitignore` | Ignores `_site/`. |
| `README.md` | Adds the website link near the download line. |
| `AGENTS.md` | Documents both scripts, the publishing flow and the new traps. |
| `docs/plans/2026-11-03-github-pages-landing-page.md` | This plan and its status. |
| `docs/adr/2026-11-03-static-landing-page.md` | The durable decision. |

No application source, Rust code, settings schema, command, or release
workflow changes. The site reads `src/assets/fonts/` and `src-tauri/icons/`;
`docs/screenshots/` is read only by the on-demand image script.

## Risks and rollback

- **Pages is not enabled yet.** The first deploy fails at `configure-pages`
  with a message naming the Pages site. Fix: enable Source: GitHub Actions once.
  Releases and the application are unaffected.
- **Base-path mistakes.** A single absolute `/assets/…` works locally and 404s
  under `/MDraft/`. The build validator fails on any absolute internal URL and
  on any missing file; the acceptance test builds with `BASE_PATH=/` as well.
- **Translation drift.** The two pages can diverge. The build compares section
  ids, FAQ count, image set and reciprocal `hreflang`, and fails when they do
  not match. The copy is still reviewed by the owner, who reads Portuguese.
- **Image weight.** Seven WebP files can push the first load past the budget if
  the hero is not optimized. The build prints the initial payload (HTML, CSS,
  JS, fonts, hero) and the total; the target is under 900 KB initial and 2.5 MB
  total with every screenshot. The hero is the only eager image.
- **Lightbox accessibility.** A custom overlay can trap or lose focus. The
  implementation uses native `<dialog>`, returns focus to the opener, closes on
  Escape and backdrop, and is tested with the keyboard.
- **Screenshot rot.** The source images are current as of v0.7.8; when the UI
  changes they age. `AGENTS.md` says which captures feed the site and that
  `scripts/optimize-site-images.py` must be rerun.
- **Outdated captures.** The two old README screenshots show the retired Files
  tab; they are deliberately not used.
- **Pillow availability.** Only the image refresh needs it; the build and CI do
  not. The script names the install command when the import fails.
- **Font licensing.** The site redistributes the bundled woff2 files, so the
  matching OFL texts are copied beside them and linked in the footer. The build
  fails if a selected face has no licence file. IBM Plex and the other
  reserved-name families are already handled by the repository's font policy.
- **Social preview.** `og:image` must be an absolute URL and reachable; the
  build writes it from `ORIGIN`/`BASE_PATH`. A wrong value is invisible on the
  page and only shows when a link is shared, so it is checked in the built
  HTML and in the acceptance test.
- **Search Console.** Verification cannot be automated with the owner's Google
  account. Without it, the sitemap is still crawlable but there is no
  diagnostics or indexing request. The plan stops short of promising a
  position.
- **Actions drift.** The workflow pins major versions (`configure-pages@v5`,
  `upload-pages-artifact@v3`, `deploy-pages@v5`); a future major is a deliberate
  bump, not a floating `main`.
- **Rollback.** `git revert` the site commit and redeploy; or disable Pages in
  Settings. The application, its releases and the release workflow are
  untouched. The published artifact remains until the next deploy or until
  Pages is disabled.

## Tests and validation

The site is not application code, so the fifty-layer suite is not the right
gate. The cheapest layers that can catch this change:

1. **Image gate.** `python scripts/optimize-site-images.py --check` verifies
   every committed WebP: format, expected dimensions, no upscaling, file size
   and total. `--write` regenerates them from `docs/screenshots/`.
2. **Build gate.** `node scripts/build-site.mjs` exits 0 in the committed state
   and prints the initial-load budget. It fails on an unresolved `{{…}}`, an
   absolute internal URL, a missing internal target, a missing `alt`/
   `width`/`height` on an image, zero or duplicate `<h1>`, a canonical that does
   not match the page, invalid JSON-LD, a FAQ answer in the markup that is not
   present verbatim in the visible page, a missing OFL file, a non-WebP image,
   or a bilingual mismatch (section ids, FAQ count, image set, `hreflang`).
3. **Prove the gate.** Break one internal link on purpose and confirm the build
   exits non-zero with the path named; restore it. Remove one Portuguese FAQ
   entry and confirm the parity check fails. A validator that has never failed
   is not evidence.
4. **Local render.** `npm run site:serve`, then check: keyboard-only navigation,
   visible focus, 320/768/1440 widths, light and dark, reduced motion, no
   console errors, no request whose origin is not the local server, both
   language pages, the lightbox (open, Escape, backdrop, arrows, focus return),
   and no layout shift on the hero.
5. **Content check.** Every claim cross-read against `README.md`/`docs/` in both
   languages; the downloads table matches the asset names in the latest
   release; the Portuguese text reads naturally, not as a literal translation.
6. **Repository gates.** `npm run format:check`, `npm run lint`, `npm run knip`
   and `npm run build` — the same frontend gates CI runs, because Prettier now
   covers `site/`. No `npm test` run is warranted for files the application
   never imports.
7. **Post-deploy.** `Invoke-WebRequest` both live URLs: status 200, canonical,
   reciprocal `hreflang`, `<title>`, description, `og:image`, JSON-LD parses,
   sitemap is valid XML and lists both, `robots.txt` names it. Open both in a
   normal browser, confirm the network panel shows no third-party origin, run
   Lighthouse on each (Chrome DevTools or `npx lighthouse`, not a repository
   dependency), and record the four scores.
8. **Search Console (owner).** Verify the property, submit the sitemap, request
   indexing for both URLs, and confirm no coverage errors. Indexing time is
   Google's.

## Acceptance criteria

1. `https://bgeneto.github.io/MDraft/` and `/pt-br/` both serve over HTTPS with
   status 200, the expected `<title>`, description, canonical, Open Graph,
   Twitter card, valid JSON-LD and reciprocal `hreflang` (`en`, `pt-BR`,
   `x-default`).
2. The pages are complete and meaningful with JavaScript disabled; the theme
   toggle and lightbox are enhancements, not requirements to read the content.
3. A first load makes zero requests to any origin other than the site's own,
   and the initial payload (HTML, CSS, JS, hero image, fonts) is under 900 KB
   uncompressed; the build reports the number. Total site weight, with every
   lazy image, is under 2.5 MB.
4. Every page image is WebP with explicit `width` and `height`; no PNG or JPEG
   is served by the site pages.
5. Lighthouse mobile: Performance ≥ 95, Accessibility 100, Best Practices 100,
   SEO 100 on both pages; desktop Performance ≥ 99. The actual scores are
   recorded in the final response.
6. Every download CTA reaches the latest release; the artifact names in the
   table match the release; macOS is explicitly described as not published in
   both languages.
7. The visible FAQ and the `FAQPage` JSON-LD match one-for-one on each page, and
   `SoftwareApplication` reports price 0, the two operating systems, the release
   version and `inLanguage`; the structured data passes Google's Rich Results
   Test.
8. Each viewport has one primary action, and every primary action reaches
   `releases/latest`; secondary links never share its visual weight.
9. The lightbox opens from a thumbnail, closes with Escape and the backdrop,
   returns focus to the thumbnail, supports arrow keys in a pair, and respects
   reduced motion.
10. The build fails when an internal link is broken or a Portuguese section is
    missing (both demonstrated once), and passes in the committed state.
11. `sitemap.xml` and `robots.txt` are valid and name both canonical URLs;
    Search Console accepts the sitemap with no errors.
12. The artifact works under `/MDraft/` and under a simulated root build, with no
    404 for any local asset or link.
13. `README.md` links to the site, the repository homepage field points to it,
    `AGENTS.md` documents both scripts and the publishing flow, and the ADR is
    recorded.
14. The application is unaffected: `npm run build`, `npm run format:check`,
    `npm run lint` and `npm run knip` pass.

## Outcome (2026-11-03)

The site is live at `https://bgeneto.github.io/MDraft/` and
`https://bgeneto.github.io/MDraft/pt-br/`. GitHub Pages is enabled with
`build_type: workflow` and HTTPS enforced; the deploy workflow succeeded on
commits `b79abf7`, `8760816`, `9f8e856`, `36d8e41` and `f325ad6` (runs
41691156680, 41692417883, 41692929603, 41693933400 and 41694684642), and the
repository homepage and topics were updated.

Verified against the public address, not the local build:

- **Visual and responsive:** desktop 1440×960 and mobile 390×844 render the
  hero, AI palette, scroll pair, Typst paper, typography specimen, math pair,
  download cards, FAQ, final CTA and footer; no horizontal overflow at either
  width. All 12 image elements load with non-zero natural dimensions, the two
  fonts load, the theme toggle and lightbox work, and the language switch goes
  to the correct `lang`/`canonical` page.
- **SEO:** title, description, canonical, Open Graph, Twitter card and
  reciprocal `hreflang` (`en`, `pt-BR`, `x-default`) are correct on both pages;
  the live `sitemap.xml` and `robots.txt` are valid; the custom 404 is styled,
  `noindex`, resolves its assets through `<base>` and localises itself for
  `/pt-br/` paths. The schema.org validator reports **3 items, 0 errors, 0
  warnings** (`SoftwareApplication`, `WebSite`, `FAQPage`, with an `Organization`
  publisher).
- **CTAs:** five download links point at
  `https://github.com/bgeneto/MDraft/releases/latest`; the hero CTA was clicked
  and reached the `v0.7.8` release page. The release page returns 200.
- **Performance and privacy:** Lighthouse mobile **100 / 100 / 100 / 100**
  (Performance / Accessibility / Best Practices / SEO) on both the English and
  Portuguese pages, LCP 1.2 s / 1.4 s, CLS 0; desktop **100 / 100 / 100 / 100**,
  LCP 0.6 s, CLS 0.001. Every live resource request goes to one origin
  (`bgeneto.github.io`) and none to a third party; the build reports a 469 KB
  initial payload and 1,560 KB total.
- **Repository:** the site is committed with its sources, optimized WebP files,
  social card and build script; the existing Quality workflow passed after the
  push (run 41691157109).

The Google verification file
`site/google38db1b93bb68508e.html` is published at
`https://bgeneto.github.io/MDraft/google38db1b93bb68508e.html` (200, exact
content), so the URL-prefix property can be verified. The remaining owner
actions are to press **Verify** in Search Console, submit
`https://bgeneto.github.io/MDraft/sitemap.xml` and request indexing for both
languages; they need the owner's Google account. A direct `site:` query could
not be completed because Google served its bot check to this environment;
indexing is Google's decision and was not promised by the code.

## Open questions

None blocking. The decisions of 2026-11-03 settle domain, language, screenshots,
analytics and theme. The only owner action left is the Search Console
verification token (or verification file), which cannot be produced without the
owner's Google account; until then the site is crawlable but has no indexing
request. A custom domain remains a future option, not a requirement.
