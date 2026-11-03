#!/usr/bin/env node
/**
 * Assemble the MDraft landing page into `_site/` and validate it.
 *
 * The sources live in `site/`; the fonts, icons and the release version come
 * from the application, so the site never carries a second copy of either. The
 * build fails on a broken link, a missing image, a wrong dimension, a bad
 * canonical, an invalid JSON-LD document, a bilingual mismatch or a payload
 * above the budget.
 *
 *   node scripts/build-site.mjs
 *   node scripts/build-site.mjs --serve
 *
 * Environment (all optional outside CI):
 *   SITE_ORIGIN     https://bgeneto.github.io
 *   SITE_BASE_PATH  /MDraft (or empty for a custom-domain root)
 *   SITE_VERSION    0.7.8 (the workflow resolves the latest release tag)
 */

import { createServer } from "node:http";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SITE = join(ROOT, "site");
const OUT = join(ROOT, "_site");
const FONTS = join(ROOT, "src", "assets", "fonts");
const ICONS = join(ROOT, "src-tauri", "icons");

const ORIGIN = (process.env.SITE_ORIGIN || "https://bgeneto.github.io").replace(/\/+$/, "");
const BASE_PATH = normalizeBase(process.env.SITE_BASE_PATH ?? "/MDraft");
const SITE_URL = `${ORIGIN}${BASE_PATH}/`;
// Bump the version when the image changes so sharing services fetch the new card.
const OG_IMAGE_URL = `${SITE_URL}assets/og.png?v=2`;
const RELEASE_URL = "https://github.com/bgeneto/MDraft/releases/latest";
const YEAR = String(new Date().getFullYear());

const PAGES = [
  {
    source: "index.html",
    output: "index.html",
    lang: "en",
    canonical: SITE_URL,
    locale: "en_US",
  },
  {
    source: "pt-br/index.html",
    output: "pt-br/index.html",
    lang: "pt-BR",
    canonical: `${SITE_URL}pt-br/`,
    locale: "pt_BR",
  },
];

const ERROR_PAGES = [
  { source: "404.html", output: "404.html" },
  { source: "pt-br/404.html", output: "pt-br/404.html" },
];

const CONTENT_IMAGES = new Set([
  "scroll-sync.webp",
  "sync-source.webp",
  "sync-preview.webp",
  "ai-palette.webp",
  "statusbar-tokens.webp",
  "typst-pages.webp",
  "typography-presets.webp",
  "typography-settings.webp",
  "math-light.webp",
  "math-dark.webp",
]);

const FONT_FILES = [
  ["EBGaramond-Variable.woff2", "eb-garamond.woff2"],
  ["IBMPlexMono-Regular.woff2", "ibm-plex-mono.woff2"],
  ["licenses/eb-garamond-OFL.txt", "eb-garamond-OFL.txt"],
  ["licenses/ibm-plex-mono-OFL.txt", "ibm-plex-mono-OFL.txt"],
];

const failures = [];

function normalizeBase(value) {
  let base = value.trim();
  if (!base || base === "/") return "";
  if (!base.startsWith("/")) base = `/${base}`;
  return base.replace(/\/+$/, "");
}

function fail(message) {
  failures.push(message);
}

function pass(message) {
  console.log(`  PASS  ${message}`);
}

function check(condition, message) {
  if (condition) {
    pass(message);
  } else {
    fail(message);
    console.log(`  FAIL  ${message}`);
  }
  return condition;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyFile(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination);
}

async function copyDirectory(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await copyDirectory(from, to);
    else if (entry.isFile()) await copyFile(from, to);
  }
}

async function resolveVersion() {
  const fromEnvironment = (process.env.SITE_VERSION || "").trim().replace(/^v/, "");
  if (fromEnvironment) return fromEnvironment;
  try {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
    return String(pkg.version || "");
  } catch {
    return "";
  }
}

function render(html, page, version) {
  const chip = version ? `<span class="version">v${version}</span>` : "";
  let output = html
    .replaceAll("{{SITE_URL}}", SITE_URL)
    .replaceAll("{{CANONICAL}}", page.canonical)
    .replaceAll("{{OG_IMAGE}}", OG_IMAGE_URL)
    .replaceAll("{{RELEASE_URL}}", RELEASE_URL)
    .replaceAll("{{VERSION_CHIP}}", chip)
    .replaceAll("{{VERSION}}", version)
    .replaceAll("{{YEAR}}", YEAR);
  if (!version) {
    output = output.replace(/[ \t]*"softwareVersion":\s*"",\r?\n/, "");
  }
  return output;
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function visibleText(html) {
  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  return decodeEntities(withoutScripts.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return match ? (match[2] ?? match[3] ?? "") : null;
}

function imageSize(buffer) {
  if (buffer.subarray(1, 4).toString("ascii") === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: "png" };
  }
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
        format: "webp",
      };
    }
    if (chunk === "VP8 ") {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
        format: "webp",
      };
    }
    if (chunk === "VP8L") {
      const bits = buffer.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
        format: "webp",
      };
    }
  }
  return null;
}

function stripQuery(value) {
  return value.split(/[?#]/, 1)[0];
}

function sitePathFromBase(value, baseHref) {
  const url = new URL(value, baseHref);
  if (!url.href.startsWith(SITE_URL)) {
    throw new Error(`${value} resolves outside ${SITE_URL} (${url.href})`);
  }
  return decodeURIComponent(url.href.slice(SITE_URL.length));
}

function resolveLink(pageFile, value, baseHref) {
  if (!value) return null;
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    /^(https?:|mailto:|tel:|data:|javascript:|\/\/)/i.test(trimmed)
  ) {
    return null;
  }
  if (trimmed.startsWith("/")) {
    return { error: `absolute internal URL ${trimmed}` };
  }

  let sitePath;
  if (baseHref) {
    sitePath = sitePathFromBase(trimmed, baseHref);
  } else {
    const pathPart = stripQuery(trimmed);
    if (!pathPart) return null;
    sitePath = normalize(join(dirname(pageFile), pathPart))
      .split(sep)
      .join("/");
  }

  if (sitePath === "." || sitePath === "") sitePath = "";
  if (sitePath.endsWith("/") || sitePath === "") {
    sitePath = `${sitePath}index.html`;
  } else if (!extname(sitePath)) {
    sitePath = `${sitePath}/index.html`;
  }
  return { sitePath };
}

async function validatePage(file, page, options) {
  const html = await readFile(join(OUT, file), "utf8");
  const label = page.output;
  const baseTag = html.match(/<base\s[^>]*href\s*=\s*("([^"]*)"|'([^']*)')/i);
  const baseHref = baseTag ? (baseTag[2] ?? baseTag[3] ?? "") : null;

  check(!html.includes("{{") && !html.includes("}}"), `${label}: no unresolved placeholders`);
  check(/<!doctype html>/i.test(html), `${label}: has a doctype`);
  check(
    new RegExp(`<html\\s[^>]*lang\\s*=\\s*"${page.lang}"`, "i").test(html),
    `${label}: html lang is ${page.lang}`,
  );

  const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim() || "";
  check(title.length > 0 && title.length <= 70, `${label}: title is ${title.length} characters`);

  const description = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1] || "";
  check(
    description.length >= 90 && description.length <= 170,
    `${label}: description is ${description.length} characters`,
  );

  const h1s = html.match(/<h1\b/gi) || [];
  check(h1s.length === 1, `${label}: exactly one h1 (${h1s.length})`);

  if (!options.errorPage) {
    const canonical = html.match(/<link\s+rel="canonical"\s+href="([^"]*)"/i)?.[1];
    check(canonical === page.canonical, `${label}: canonical is ${page.canonical}`);

    const alternates = new Map();
    for (const match of html.matchAll(
      /<link\s+rel="alternate"\s+hreflang="([^"]+)"\s+href="([^"]+)"/gi,
    )) {
      alternates.set(match[1], match[2]);
    }
    check(
      alternates.get("en") === SITE_URL &&
        alternates.get("pt-BR") === `${SITE_URL}pt-br/` &&
        alternates.get("x-default") === SITE_URL,
      `${label}: reciprocal hreflang (en, pt-BR, x-default)`,
    );

    const ogUrl = html.match(/<meta\s+property="og:url"\s+content="([^"]*)"/i)?.[1];
    const ogLocale = html.match(/<meta\s+property="og:locale"\s+content="([^"]*)"/i)?.[1];
    const ogImage = html.match(/<meta\s+property="og:image"\s+content="([^"]*)"/i)?.[1];
    check(ogUrl === page.canonical, `${label}: og:url matches canonical`);
    check(ogLocale === page.locale, `${label}: og:locale is ${page.locale}`);
    check(ogImage === OG_IMAGE_URL, `${label}: og:image is absolute`);

    const jsonLd = html.match(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/i)?.[1];
    let graph = null;
    try {
      graph = JSON.parse(jsonLd || "");
      check(true, `${label}: JSON-LD parses`);
    } catch (error) {
      check(false, `${label}: JSON-LD parses (${error.message})`);
    }
    if (graph) {
      const nodes = graph["@graph"] || [];
      const app = nodes.find((node) => node["@type"] === "SoftwareApplication");
      const site = nodes.find((node) => node["@type"] === "WebSite");
      const faq = nodes.find((node) => node["@type"] === "FAQPage");
      check(Boolean(app && site && faq), `${label}: JSON-LD has app, site and FAQ`);
      check(app?.inLanguage === page.lang, `${label}: app inLanguage is ${page.lang}`);
      check(site?.inLanguage === page.lang, `${label}: site inLanguage is ${page.lang}`);
      check(faq?.inLanguage === page.lang, `${label}: FAQ inLanguage is ${page.lang}`);
      if (options.version) {
        check(
          app?.softwareVersion === options.version,
          `${label}: softwareVersion is ${options.version}`,
        );
      }
      check(
        app?.offers?.price === "0" && app?.offers?.priceCurrency === "USD",
        `${label}: price is 0 USD`,
      );
      check(app?.downloadUrl === RELEASE_URL, `${label}: downloadUrl points at the latest release`);

      const questions = faq?.mainEntity || [];
      const details = (html.match(/<details\b/gi) || []).length;
      check(
        questions.length === details,
        `${label}: ${questions.length} FAQ entries match ${details} details`,
      );
      const text = visibleText(html);
      let parity = true;
      for (const question of questions) {
        const answer = question?.acceptedAnswer?.text || "";
        if (!text.includes(question.name) || !text.includes(answer)) parity = false;
      }
      check(parity, `${label}: every FAQ question and answer is visible`);
    }
  } else {
    const robots = html.match(/<meta\s+name="robots"\s+content="([^"]*)"/i)?.[1] || "";
    check(/noindex/i.test(robots), `${label}: noindex`);
  }

  const imageTags = [...html.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0]);
  let imagesOk = true;
  for (const tag of imageTags) {
    if (tag.includes("data-lightbox-image")) continue;
    const src = attribute(tag, "src");
    const alt = attribute(tag, "alt");
    const width = attribute(tag, "width");
    const height = attribute(tag, "height");
    if (src === null || alt === null || !width || !height) {
      imagesOk = false;
      fail(`${label}: image ${src || "(no src)"} needs alt, width and height`);
      continue;
    }
    const resolved = resolveLink(page.output, src, baseHref);
    if (!resolved || resolved.error) {
      imagesOk = false;
      fail(`${label}: image ${src} does not resolve`);
      continue;
    }
    const target = join(OUT, resolved.sitePath);
    if (!(await exists(target))) {
      imagesOk = false;
      fail(`${label}: image ${src} is missing`);
      continue;
    }
    const buffer = await readFile(target);
    const size = imageSize(buffer);
    if (!size) {
      imagesOk = false;
      fail(`${label}: image ${src} is not PNG or WebP`);
      continue;
    }
    if (size.format !== "webp" && !src.includes("apple-touch-icon")) {
      imagesOk = false;
      fail(`${label}: ${src} is ${size.format}, not WebP`);
    }
    if (
      src.includes("/assets/img/") &&
      (size.width !== Number(width) || size.height !== Number(height))
    ) {
      imagesOk = false;
      fail(`${label}: ${src} declares ${width}×${height}, file is ${size.width}×${size.height}`);
    }
  }
  check(imagesOk, `${label}: every image resolves, is WebP and keeps its dimensions`);

  for (const match of html.matchAll(/(?:href|src)\s*=\s*"([^"]+)"/gi)) {
    const value = match[1];
    if (value.startsWith("https://") || value.startsWith("http://")) continue;
    let resolved;
    try {
      resolved = resolveLink(page.output, value, baseHref);
    } catch (error) {
      fail(`${label}: ${error.message}`);
      continue;
    }
    if (!resolved) continue;
    if (resolved.error) {
      fail(`${label}: ${resolved.error}`);
      continue;
    }
    const target = join(OUT, resolved.sitePath);
    if (!(await exists(target))) {
      fail(`${label}: broken link ${value} → ${resolved.sitePath}`);
    }
  }
  check(true, `${label}: internal links checked`);
  return html;
}

function warnAboutSectionParity(english, portuguese) {
  const ids = (html) => [...html.matchAll(/<section\b[^>]*\bid="([^"]+)"/gi)].map((m) => m[1]);
  const en = ids(english);
  const pt = ids(portuguese);
  check(
    en.length === pt.length && en.every((id, index) => id === pt[index]),
    `both pages have the same ${en.length} section ids`,
  );
  const images = (html) =>
    [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)]
      .map((match) => match[1].split("/").pop())
      .sort();
  const enImages = images(english);
  const ptImages = images(portuguese);
  check(
    enImages.length === ptImages.length &&
      enImages.every((name, index) => name === ptImages[index]),
    `both pages use the same ${enImages.length} images`,
  );
  const faqCount = (html) => (html.match(/<details\b/gi) || []).length;
  check(
    faqCount(english) === faqCount(portuguese),
    `both pages have ${faqCount(english)} FAQ entries`,
  );
}

async function measure(files) {
  let bytes = 0;
  for (const file of files) {
    if (await exists(file)) bytes += (await stat(file)).size;
  }
  return bytes;
}

async function totalSiteBytes(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) bytes += await totalSiteBytes(path);
    else if (entry.isFile()) bytes += (await stat(path)).size;
  }
  return bytes;
}

async function validateSitemap() {
  const xml = await readFile(join(OUT, "sitemap.xml"), "utf8");
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  check(
    locs.length === 2 && locs.includes(SITE_URL) && locs.includes(`${SITE_URL}pt-br/`),
    `sitemap lists both language URLs (${locs.length})`,
  );
  check(/<urlset\b/.test(xml) && /<\/urlset>/.test(xml), "sitemap is a urlset");
}

async function build() {
  const version = await resolveVersion();
  console.log(`site:    ${SITE_URL}`);
  console.log(`version: ${version ? `v${version}` : "(not available)"}`);
  console.log("");

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await copyDirectory(SITE, OUT);

  for (const [source, destination] of FONT_FILES) {
    const from = join(FONTS, source);
    if (!(await exists(from))) {
      fail(`missing font asset: ${relative(ROOT, from)}`);
      continue;
    }
    await copyFile(from, join(OUT, "assets", "fonts", destination));
  }
  await copyFile(join(ICONS, "32x32.png"), join(OUT, "assets", "favicon-32.png"));
  await copyFile(join(ICONS, "128x128@2x.png"), join(OUT, "assets", "apple-touch-icon.png"));

  for (const page of PAGES) {
    const source = await readFile(join(SITE, page.source), "utf8");
    await writeFile(join(OUT, page.output), render(source, page, version));
  }
  for (const page of ERROR_PAGES) {
    const source = await readFile(join(SITE, page.source), "utf8");
    await writeFile(
      join(OUT, page.output),
      source.replaceAll("{{SITE_URL}}", SITE_URL).replaceAll("{{YEAR}}", YEAR),
    );
  }

  const robots = (await readFile(join(SITE, "robots.txt"), "utf8")).replaceAll(
    "{{SITE_URL}}",
    SITE_URL,
  );
  await writeFile(join(OUT, "robots.txt"), robots);
  await writeFile(
    join(OUT, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      PAGES.map((page) => `  <url><loc>${page.canonical}</loc></url>\n`).join("") +
      `</urlset>\n`,
  );
  await writeFile(join(OUT, ".nojekyll"), "");

  console.log("Validating");
  const rendered = [];
  for (const page of PAGES) {
    rendered.push(await validatePage(page.output, page, { version }));
  }
  for (const page of ERROR_PAGES) {
    await validatePage(
      page.output,
      { ...page, lang: page.output.startsWith("pt-br") ? "pt-BR" : "en" },
      {
        errorPage: true,
      },
    );
  }
  warnAboutSectionParity(rendered[0], rendered[1]);
  await validateSitemap();

  const ogBuffer = await readFile(join(OUT, "assets", "og.png"));
  const ogSize = imageSize(ogBuffer);
  check(
    ogSize?.format === "png" && ogSize.width === 1200 && ogSize.height === 630,
    "Open Graph image is 1200×630 PNG",
  );

  const initial = await measure([
    join(OUT, "index.html"),
    join(OUT, "styles.css"),
    join(OUT, "site.js"),
    join(OUT, "assets", "fonts", "eb-garamond.woff2"),
    join(OUT, "assets", "fonts", "ibm-plex-mono.woff2"),
    join(OUT, "assets", "img", "scroll-sync.webp"),
    join(OUT, "assets", "apple-touch-icon.png"),
    join(OUT, "assets", "favicon-32.png"),
  ]);
  const total = await totalSiteBytes(OUT);
  console.log("");
  console.log(`initial payload: ${(initial / 1024).toFixed(0)} KB`);
  console.log(`total site:      ${(total / 1024).toFixed(0)} KB`);
  check(
    initial <= 900 * 1024,
    `initial payload is under 900 KB (${(initial / 1024).toFixed(0)} KB)`,
  );
  check(total <= 2.5 * 1024 * 1024, `total site is under 2.5 MB (${(total / 1024).toFixed(0)} KB)`);

  console.log("");
  if (failures.length) {
    console.error(`${failures.length} validation failure(s):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("Site built and validated.");

  if (process.argv.includes("--serve")) {
    const port = Number(process.env.PORT || 4173);
    const server = createServer(async (request, response) => {
      let requestPath = decodeURIComponent((request.url || "/").split("?")[0]);
      if (BASE_PATH && requestPath.startsWith(BASE_PATH)) {
        requestPath = requestPath.slice(BASE_PATH.length) || "/";
      }
      let file = join(OUT, requestPath.replace(/^\/+/, ""));
      if (!resolve(file).startsWith(resolve(OUT))) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      if (requestPath.endsWith("/")) file = join(file, "index.html");
      if (!(await exists(file)) || (await stat(file)).isDirectory()) {
        file = join(file, "index.html");
      }
      if (!(await exists(file))) {
        const notFound = join(OUT, "404.html");
        response.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        createReadStream(notFound).pipe(response);
        return;
      }
      const types = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".webp": "image/webp",
        ".png": "image/png",
        ".woff2": "font/woff2",
        ".xml": "application/xml; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
      };
      response.writeHead(200, {
        "Content-Type": types[extname(file)] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      createReadStream(file).pipe(response);
    });
    server.listen(port, "127.0.0.1", () => {
      console.log(`Preview: http://127.0.0.1:${port}${BASE_PATH}/`);
    });
  }
}

async function main() {
  const packageVersion = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version;
  console.log(`Building the landing page for MDraft ${packageVersion}…`);
  await build();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
