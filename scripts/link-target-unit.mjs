// Unit tests for the link resolver.
//
//   node scripts/link-target-unit.mjs
//
// No application and no build: `src/links.ts` is pure and imports only a type,
// so Node strips it and runs the module directly.
//
// What it is for: Ctrl+click and the context menu both ask one question, and
// the answer depends on four different markup dialects. The UI suite can only
// press a few of these; the matrix is cheap to pin here.

import { linkAt } from "../src/links.ts";

let passed = 0;
let total = 0;
function check(ok, label, detail = "") {
  total += 1;
  if (ok) passed += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

/** Offset of `needle` inside `source`, optionally nudged. Throws when absent. */
function at(source, needle, delta = 0) {
  const index = source.indexOf(needle);
  if (index < 0) throw new Error(`${needle} is not in the fixture`);
  return index + delta;
}

function same(actual, href, kind) {
  return actual !== null && actual.href === href && actual.kind === kind;
}

function shows(actual) {
  return actual === null ? "null" : `${actual.kind}:${actual.href}`;
}

// ---------------------------------------------------------------------------
console.log("=== Markdown ===");
{
  const source = "See [the Tauri project](https://tauri.app) and [the readme](../README.md) now.";
  const external = linkAt(source, at(source, "the Tauri project", 4), "markdown");
  check(
    same(external, "https://tauri.app", "external"),
    "an inline link is external",
    shows(external),
  );

  const file = linkAt(source, at(source, "the readme", 3), "markdown");
  check(same(file, "../README.md", "file"), "a relative destination is a file", shows(file));

  const plain = linkAt(source, at(source, "and", 0), "markdown");
  check(plain === null, "prose between links has no target", shows(plain));
}

{
  const source = "![generated image 1](../Pictures/rk8_comparacao.jpg)";
  const image = linkAt(source, at(source, "generated image 1", 5), "markdown");
  check(
    same(image, "../Pictures/rk8_comparacao.jpg", "image"),
    "an image is an image target",
    shows(image),
  );
}

{
  const source = '![a](x.png "a title")';
  const image = linkAt(source, at(source, "x.png"), "markdown");
  check(same(image, "x.png", "image"), "a title does not become part of the path", shows(image));
}

{
  const source = "![A](https://x.test/A_(b).png)";
  const image = linkAt(source, at(source, "A_(b)"), "markdown");
  check(
    same(image, "https://x.test/A_(b).png", "external"),
    "balanced parentheses stay in the URL",
    shows(image),
  );
}

{
  const source = "[A](<a b.md>)";
  const link = linkAt(source, at(source, "a b"), "markdown");
  check(same(link, "a b.md", "file"), "an angle destination keeps its space", shows(link));
}

{
  const source = "Read [the docs][docs] first.\n\n[docs]: ./docs/index.md";
  const link = linkAt(source, at(source, "the docs", 2), "markdown");
  check(same(link, "./docs/index.md", "file"), "a reference link uses its definition", shows(link));
  const definition = linkAt(source, at(source, "./docs/index.md", 4), "markdown");
  check(
    same(definition, "./docs/index.md", "file"),
    "a definition line is a target itself",
    shows(definition),
  );
}

{
  const source = "Read [docs] first.\n\n[docs]: ./docs.md";
  const link = linkAt(source, at(source, "[docs]", 2), "markdown");
  check(same(link, "./docs.md", "file"), "a shortcut reference resolves", shows(link));
}

{
  const source = "Go [up](#graph) or <https://x.test/a>.";
  const anchor = linkAt(source, at(source, "#graph", 2), "markdown");
  check(same(anchor, "#graph", "anchor"), "a fragment is an anchor", shows(anchor));
  const autolink = linkAt(source, at(source, "https://x.test/a", 3), "markdown");
  check(same(autolink, "https://x.test/a", "external"), "an autolink is external", shows(autolink));
}

{
  const source = "See https://x.test/a.png, then stop.";
  const bare = linkAt(source, at(source, "https://x.test/a.png", 4), "markdown");
  check(same(bare, "https://x.test/a.png", "external"), "a bare URL is a target", shows(bare));
  const comma = linkAt(source, at(source, "https://x.test/a.png", 17), "markdown");
  check(
    same(comma, "https://x.test/a.png", "external"),
    "trailing punctuation is not part of it",
    shows(comma),
  );
}

{
  const source = "[![alt](img.png)](page.md)";
  const onImage = linkAt(source, at(source, "alt"), "markdown");
  check(
    same(onImage, "img.png", "image"),
    "the image inside a link wins on its own text",
    shows(onImage),
  );
  const onPage = linkAt(source, at(source, "page.md"), "markdown");
  check(same(onPage, "page.md", "file"), "the outer link wins on its own text", shows(onPage));
}

{
  const source = 'An `https://x.test/a` in code, and <img src="inline.png">.';
  const code = linkAt(source, at(source, "https://x.test/a", 3), "markdown");
  check(code === null, "a URL inside an inline code span is not a target", shows(code));

  const html = linkAt(source, at(source, "inline.png"), "markdown");
  check(same(html, "inline.png", "image"), "an embedded <img> is a target", shows(html));
}

{
  const source = "```md\nhttps://x.test/a\n```\nAfter.";
  const fenced = linkAt(source, at(source, "https://x.test/a", 3), "markdown");
  check(fenced === null, "a fenced block has no links", shows(fenced));
}

{
  const source = "\\[not a link](https://x.test/a)";
  const escaped = linkAt(source, at(source, "not a link", 2), "markdown");
  check(escaped === null, "an escaped bracket is not a link", shows(escaped));
}

// ---------------------------------------------------------------------------
console.log("=== HTML ===");
{
  const source = '<p><a href="https://x.test/a?x=1&amp;y=2">A</a> <img src="../pics/a.webp"></p>';
  const link = linkAt(source, at(source, "https://x.test/a", 2), "html");
  check(same(link, "https://x.test/a?x=1&y=2", "external"), "an href is decoded", shows(link));
  const image = linkAt(source, at(source, "a.webp", 1), "html");
  check(same(image, "../pics/a.webp", "image"), "an img src is an image", shows(image));
  const tag = linkAt(source, at(source, "img", 1), "html");
  check(tag === null, "the tag name is not a target", shows(tag));
}

{
  const source = '<a href="page.html">Go</a>';
  const local = linkAt(source, at(source, "page.html", 2), "html");
  check(same(local, "page.html", "file"), "a relative href is a file", shows(local));
}

{
  const source = "<script>const u = 'https://x.test/a';</script>";
  const scripted = linkAt(source, at(source, "https://x.test/a", 3), "html");
  check(scripted === null, "a URL inside a script is not a link", shows(scripted));
}

{
  const source = "<p>Read https://x.test/a now.</p>";
  const bare = linkAt(source, at(source, "https://x.test/a", 2), "html");
  check(
    same(bare, "https://x.test/a", "external"),
    "a bare URL in HTML text is a target",
    shows(bare),
  );
}

// ---------------------------------------------------------------------------
console.log("=== AsciiDoc ===");
{
  const source =
    "image::images/plot.webp[The plot]\n\nSee link:https://x.test[a link] and <<intro,Intro>>.";
  const image = linkAt(source, at(source, "images/plot.webp", 3), "asciidoc");
  check(same(image, "images/plot.webp", "image"), "an image macro is an image", shows(image));
  const link = linkAt(source, at(source, "https://x.test", 3), "asciidoc");
  check(same(link, "https://x.test", "external"), "a link macro is external", shows(link));
  const xref = linkAt(source, at(source, "intro", 1), "asciidoc");
  check(same(xref, "#intro", "anchor"), "<<id>> is an anchor", shows(xref));
}

{
  const source = "----\nhttps://x.test/a\n----\nAfter.";
  const fenced = linkAt(source, at(source, "https://x.test/a", 3), "asciidoc");
  check(fenced === null, "a listing block has no links", shows(fenced));
}

{
  const source = "https://example.com[a link]";
  const bare = linkAt(source, at(source, "https://example.com", 4), "asciidoc");
  check(
    same(bare, "https://example.com", "external"),
    "a bare URL before [text] is a target",
    shows(bare),
  );
}

// ---------------------------------------------------------------------------
console.log("=== Typst ===");
{
  const source = '#link("https://typst.app")[the site] and #image("../img/a.webp", alt: "a")';
  const link = linkAt(source, at(source, "https://typst.app", 3), "typst");
  check(same(link, "https://typst.app", "external"), "#link is external", shows(link));
  const image = linkAt(source, at(source, "../img/a.webp", 3), "typst");
  check(same(image, "../img/a.webp", "image"), "#image is an image", shows(image));
}

{
  const source = '#link("mailto:a@b.test")[mail]';
  const mail = linkAt(source, at(source, "a@b.test", 2), "typst");
  check(same(mail, "mailto:a@b.test", "external"), "mailto is external", shows(mail));
}

{
  const source = 'Text with "https://x.test/a" quoted.';
  const bare = linkAt(source, at(source, "https://x.test/a", 2), "typst");
  check(same(bare, "https://x.test/a", "external"), "a bare URL is a target", shows(bare));
}

{
  const source = '```\n#link("https://x.test")\n```';
  const fenced = linkAt(source, at(source, "https://x.test", 2), "typst");
  check(fenced === null, "a fenced block has no links", shows(fenced));
}

// ---------------------------------------------------------------------------
console.log("=== bounds ===");
{
  const source = "[A](https://x.test)";
  check(linkAt(source, -1, "markdown") === null, "a negative offset is null");
  check(linkAt(source, source.length + 5, "markdown") === null, "an offset past the end is null");
  check(linkAt("", 0, "markdown") === null, "an empty document is null");
}

console.log(`\n${passed}/${total} checks passed`);
process.exit(passed === total ? 0 : 1);
