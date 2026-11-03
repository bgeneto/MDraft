# The landing page is a static, bilingual site in `site/`, deployed to Pages by Actions

**Status:** accepted
**Date:** 2026-11-03

## Context

The repository had no product page: `README.md` was the only shopfront, the
GitHub `homepage` field was empty and Pages was disabled. A README cannot carry
a canonical URL, structured data, a social preview or a page designed around a
download, and it sits inside GitHub's chrome rather than on a domain the
project controls.

The product's public promise constrains the site as much as the application:
no account, no telemetry, no start-up network request. A landing page that
loads Google Fonts, a CDN script or an analytics tag would contradict the
product on its own front page and would invite a cookie banner.

The site must also stay correct as releases move. The version, the downloadable
artifact names and the screenshots change; a second copy of any of them is a
future lie. The application already owns the fonts, the icons and the canonical
screenshots, and the repository already has a release workflow.

Two languages are required from the first release: English for the GitHub and
international audience, Brazilian Portuguese for the owner's audience. A
client-side language toggle would hide one language from crawlers.

## Decision

The landing page is a hand-written static site in `site/`, with English at `/`
and Portuguese at `/pt-br/`.

- **No framework and no second npm project.** `site/` holds HTML, one CSS file
  and one small JavaScript file (theme toggle and lightbox). There is no
  hydration and no client-side routing; every word is in the served HTML.
- **One assembler, `scripts/build-site.mjs`.** It copies the site into `_site/`,
  copies the selected fonts and their OFL texts from `src/assets/fonts/`, the
  optimized screenshots from `site/assets/img/` and the icons from
  `src-tauri/icons/`, injects the origin, base path, version, canonical and
  `hreflang` values, writes `sitemap.xml` and validates links, images, metadata,
  JSON-LD and bilingual parity. `--serve` previews the result with Node's
  `http` module.
- **Self-hosted assets only.** The site loads no third-party origin: no font
  CDN, no analytics, no embedded video, no cookie. The footer says so.
- **WebP screenshots, optimized once and committed.** `scripts/optimize-site-images.py`
  (Pillow) resizes and encodes the captures from `docs/screenshots/` into
  `site/assets/img/*.webp`; the build and CI never need an image library. The
  script is run when the screenshots change, not on every deploy.
- **Two real pages, reciprocal `hreflang`.** `/` and `/pt-br/` are independently
  indexable, each with its own title, description, canonical, Open Graph locale
  and JSON-LD. The language switch is two ordinary links.
- **GitHub Pages through the artifact flow.** `.github/workflows/pages.yml`
  builds `_site/` and deploys it with `configure-pages`, `upload-pages-artifact`
  and `deploy-pages` on site changes, on a published release (to refresh the
  version) and on manual dispatch. Pages must be enabled once with Source:
  GitHub Actions; the workflow token cannot enable it.
- **The icon palette is the brand palette.** Navy `#002050`, cyan `#0bbaf4` and
  white, with EB Garamond for display headings, the platform UI face for body
  text and IBM Plex Mono for code, tokens and measurements.

## Consequences

- The site changes in the same commits as the product, and a release can refresh
  its version without a site commit.
- A broken internal link, a missing image, an unresolved placeholder, a
  mismatched FAQ or a missing Portuguese section fails the site build before it
  can be published. The site is reviewed like code.
- The build never touches the application, its identifier or its release
  workflow. Disabling Pages or reverting the commit removes the site without
  affecting the product.
- Adding a page means adding it to the build's page list, the sitemap, the
  language switch and the parity check; adding an image means running the
  optimizer and committing the WebP, not referencing `docs/screenshots/` from
  the page.
- A custom domain later changes only the origin/base path supplied by
  `configure-pages` (plus a `CNAME`); the HTML does not hardcode `github.io`.
- The site has no analytics. Measurement is Search Console, GitHub traffic and
  release asset download counts. If a counter is ever added, it becomes the
  first third-party request and the footer promise must change with it.
- The site is English-first in structure but fully bilingual in content; every
  new claim must be written twice and pass the parity check.
