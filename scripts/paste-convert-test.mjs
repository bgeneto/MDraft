// Conversion matrix for the rich-paste pipeline.
//
//   node scripts/paste-convert-test.mjs
//
// This layer runs without the application. The paste core imports only ordinary
// packages (`marked`, `parse5`, `katex`, `codemirror-lang-typst/lezer`), and Node
// 24 strips the TypeScript types, so the modules are imported as-is.
//
// What it is for: the conversion rules are pure decisions, and a CDP test cannot
// cheaply cover every reader/writer pair. This suite pins the matrix, the
// destination resolution and the escaping before the UI layer sees it.

import { chooseSource, isHtmlSource } from "../src/paste/detect.ts";
import { resolvePasteDestination } from "../src/paste/detect-document.ts";
import { planPaste } from "../src/paste/index.ts";
import { imageSyntaxFor } from "../src/image-syntax.ts";

let passed = 0;
let total = 0;
function check(ok, label, detail = "") {
  total += 1;
  if (ok) passed += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

function payload(html = null, text = null, markdown = null) {
  return { html, text, markdown };
}

console.log("=== destination resolution ===");
{
  const saved = resolvePasteDestination({
    saved: true,
    language: "markdown",
    buffer: "= Typst looking\n#set text(size: 9pt)",
  });
  check(
    saved.language === "markdown" && !saved.detected,
    "a saved file ignores its content",
    saved.language,
  );

  const typst = resolvePasteDestination({
    saved: false,
    language: "markdown",
    buffer: "= A Typst title\n\n#set text(size: 10pt)\n\n- one\n- two",
  });
  check(
    typst.language === "typst" && typst.detected,
    "unsaved Typst content beats a Markdown default",
    typst.language,
  );

  const markdown = resolvePasteDestination({
    saved: false,
    language: "typst",
    buffer: "# A Markdown title\n\nA **bold** sentence and [a link](https://example.com).",
  });
  check(
    markdown.language === "markdown" && markdown.detected,
    "unsaved Markdown content beats a Typst default",
    markdown.language,
  );

  const html = resolvePasteDestination({
    saved: false,
    language: "markdown",
    buffer: "<h1>Title</h1>\n<p>Hello</p>",
  });
  check(
    html.language === "html" && html.detected,
    "an HTML-looking buffer detects HTML",
    html.language,
  );

  const blank = resolvePasteDestination({ saved: false, language: "typst", buffer: "   \n\n" });
  check(
    blank.language === "typst" && blank.fallback,
    "a blank buffer falls back to the default",
    blank.language,
  );

  const ambiguous = resolvePasteDestination({
    saved: false,
    language: "markdown",
    buffer: "A sentence.\n\n- one\n- two\n\nA little math $x^2$.",
  });
  check(
    ambiguous.language === "markdown" && ambiguous.fallback,
    "shared constructs fall back",
    ambiguous.language,
  );

  const fenced = resolvePasteDestination({
    saved: false,
    language: "markdown",
    buffer: "Prose.\n\n```typst\n= not a heading\n#set text(size: 9pt)\n```\n",
  });
  check(
    fenced.language === "markdown" && fenced.fallback,
    "a code sample cannot classify the document",
    fenced.language,
  );
}

console.log("\n=== clipboard source choice ===");
{
  const html = chooseSource(payload("<p>Hello</p>", "Hello"), "markdown");
  check(html.source === "html" && !html.native, "HTML wins for Markdown", html.source);

  const nativeMd = chooseSource(payload(null, "# Title\n\nA **bold** word."), "markdown");
  check(
    nativeMd.source === "markdown" && nativeMd.native,
    "plain Markdown into Markdown is native",
    `${nativeMd.source}/${nativeMd.native}`,
  );

  const typst = chooseSource(payload(null, "= Title\n\nSome *strong* text."), "markdown");
  check(
    typst.source === "typst" && !typst.native,
    "plain Typst into Markdown converts",
    typst.source,
  );

  const nativeTyp = chooseSource(payload(null, "= Title\n\nSome *strong* text."), "typst");
  check(
    nativeTyp.source === "typst" && nativeTyp.native,
    "plain Typst into Typst is native",
    `${nativeTyp.source}/${nativeTyp.native}`,
  );

  const plain = chooseSource(payload(null, "Just a sentence about nothing."), "typst");
  check(plain.source === "plain" && plain.native, "plain prose stays native", plain.source);

  const htmlList = chooseSource(payload(null, "- one\n- two\n- three"), "html");
  check(
    htmlList.source === "markdown" && !htmlList.native,
    "a list pasted into HTML converts",
    htmlList.source,
  );
}

console.log("\n=== markup source on the clipboard ===");
{
  const link =
    '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/reveal.js/5.2.1/reset.min.css">';

  const table = [
    [link, true, "a link tag"],
    [
      `${link}\n<script src="https://cdnjs.cloudflare.com/ajax/libs/reveal.js/5.2.1/reveal.js"></script>`,
      true,
      "two tags",
    ],
    ["<p>Hello</p>", true, "an element with text"],
    ["<div>\n  <p>Hello <strong>world</strong></p>\n</div>", true, "a nested fragment"],
    ["<style>p { color: red }</style>", true, "a style element"],
    ["<div>", true, "an opening tag left open at the end"],
    ["Use the <div> tag", false, "prose that mentions a tag"],
    ["<div> is how you group", false, "a tag followed by prose"],
    ["a < b", false, "a comparison"],
    ["<!-- only a comment -->", false, "a comment alone"],
    ["\\<p\\>", false, "an escaped tag"],
  ];
  for (const [text, expected, label] of table) {
    check(
      isHtmlSource(text) === expected,
      `${expected ? "source" : "not source"}: ${label}`,
      JSON.stringify(text).slice(0, 52),
    );
  }

  // What a syntax-highlighting editor puts on the clipboard: every token, its
  // leading space included, is its own span inside a styled wrapper.
  const highlighted =
    `<meta charset='utf-8'><div style="color: #d4d4d4;white-space: pre;"><div>` +
    `<span style="color: #808080;">&lt;</span><span style="color: #9CDCFE;">link</span>` +
    `<span style="color: #9CDCFE;"> rel</span>=<span style="color: #CE9178;">"stylesheet"</span> ` +
    `<span style="color: #9CDCFE;">href</span>=<span style="color: #CE9178;">"https://cdnjs.cloudflare.com/ajax/libs/reveal.js/5.2.1/reset.min.css"</span>` +
    `<span style="color: #808080;">&gt;</span></div></div>`;

  const choice = chooseSource(payload(highlighted, link), "html");
  check(
    choice.source === "html" && choice.native && choice.fromText,
    "HTML source into HTML is the text, untouched",
    JSON.stringify(choice),
  );

  const pasted = await planPaste(payload(highlighted, link), "html");
  check(
    pasted?.text === link && pasted.converted === false,
    "the snippet is pasted byte-for-byte",
    pasted?.text,
  );

  const bare = await planPaste(payload(link, link), "html");
  check(bare?.text === link, "a bare link tag is not dropped by the sanitizer", bare?.text);

  const codeBlock = await planPaste(
    payload(
      `<code class="language-html">&lt;link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/reveal.js/5.2.1/reset.min.css"&gt;</code>`,
      link,
    ),
    "html",
  );
  check(
    codeBlock?.text === link,
    "a code block copied from a docs page keeps the text",
    codeBlock?.text,
  );

  // The destination decides the intent: the same clipboard that is left alone
  // in an HTML document is *converted* into Markdown. The HTML representation
  // is a placeholder here on purpose — using it instead of the text would give
  // "Elsewhere".
  const article =
    '<p>Enviar sua chave Pix pode expor dados sensíveis como <strong>CPF, e-mail ou telefone</strong> a estranhos, abrindo portas para golpes, <a href="/blog/o-que-e-doxxing-e-como-evitar/">doxing</a> e exposição indesejada.</p>';
  const articleMarkdown =
    "Enviar sua chave Pix pode expor dados sensíveis como **CPF, e-mail ou telefone** a estranhos, abrindo portas para golpes, [doxing](/blog/o-que-e-doxxing-e-como-evitar/) e exposição indesejada.";
  const articleHtml = "<p>Elsewhere</p>";

  const markdown = await planPaste(payload(articleHtml, article), "markdown");
  check(
    markdown?.text === articleMarkdown && markdown.converted === true,
    "an HTML article pasted into Markdown becomes Markdown",
    markdown?.text,
  );

  const asciidoc = await planPaste(payload(articleHtml, article), "asciidoc");
  check(
    (asciidoc?.text ?? "").includes("*CPF, e-mail ou telefone*") &&
      (asciidoc?.text ?? "").includes("link:/blog/o-que-e-doxxing-e-como-evitar/[doxing]"),
    "the same article into AsciiDoc becomes AsciiDoc",
    asciidoc?.text,
  );

  const prose = await planPaste(
    payload("Use the <code>&lt;div&gt;</code> tag", "Use the <div> tag"),
    "html",
  );
  check(
    prose?.converted === true && (prose?.text ?? "").includes("&lt;div&gt;"),
    "prose that mentions a tag still converts",
    prose?.text,
  );

  const list = await planPaste(
    payload(`<div style="white-space: pre">- one<br>- two</div>`, "- one\n- two"),
    "markdown",
  );
  check(
    list?.text === "- one\n- two" && list.converted === false,
    "a Markdown list snippet stays byte-identical",
    JSON.stringify(list?.text),
  );

  // A tag has no content to convert, and `<link>` is a label in Typst: the
  // characters are pasted as escaped literal text rather than raw.
  const highlightedTag =
    '<div style="white-space: pre">&lt;link rel="stylesheet" href="a.css"&gt;</div>';
  const tag = '<link rel="stylesheet" href="a.css">';
  const typst = await planPaste(payload(highlightedTag, tag), "typst");
  check(
    typst?.converted === false && (typst?.text ?? "").includes("\\<link"),
    "a tag snippet into Typst becomes escaped literal text",
    typst?.text,
  );
}

console.log("\n=== whitespace across inline elements ===");
{
  const sentence =
    "Enviar sua chave Pix pode expor dados sensíveis como <strong>CPF, e-mail ou telefone</strong> a\n" +
    "estranhos, abrindo portas para golpes, <a href=/blog/o-que-e-doxxing-e-como-evitar/>doxing</a>\n" +
    "e exposição indesejada.";
  const quoted =
    "Enviar sua chave Pix pode expor dados sensíveis como **CPF, e-mail ou telefone** a estranhos, " +
    "abrindo portas para golpes, [doxing](/blog/o-que-e-doxxing-e-como-evitar/) e exposição indesejada.";

  const exact = await planPaste(payload(`<p>${sentence}</p>`, "prose"), "markdown");
  check(exact?.text === quoted, "spaces survive around bold and links", exact?.text);

  // A browser or an extension may wrap every text run in an inline element; the
  // space then sits inside that element, at the edge of its content.
  const wrapped =
    "<meta charset='utf-8'>" +
    "<span>Enviar sua chave Pix pode expor dados sensíveis como </span>" +
    "<strong>CPF, e-mail ou telefone</strong>" +
    "<span> a estranhos, abrindo portas para golpes, </span>" +
    "<a href=/blog/o-que-e-doxxing-e-como-evitar/>doxing</a>" +
    "<span> e exposição indesejada.</span>";
  const nested = await planPaste(payload(wrapped, "prose"), "markdown");
  check(nested?.text === quoted, "span wrappers do not swallow the boundary spaces", nested?.text);

  const asciidoc = await planPaste(payload(wrapped, "prose"), "asciidoc");
  check(
    asciidoc?.text ===
      "Enviar sua chave Pix pode expor dados sensíveis como *CPF, e-mail ou telefone* a estranhos, " +
        "abrindo portas para golpes, link:/blog/o-que-e-doxxing-e-como-evitar/[doxing] e exposição indesejada.",
    "the same copy keeps its spaces in AsciiDoc",
    asciidoc?.text,
  );

  const edges = await planPaste(
    payload("<p> <strong>  Hello  </strong> </p>", "Hello"),
    "markdown",
  );
  check(edges?.text === "**Hello**", "a block's own outer edges are still trimmed", edges?.text);

  const runs = await planPaste(
    payload("<p>a <em>b</em>  <strong>c</strong> d</p>", "a b c d"),
    "markdown",
  );
  check(runs?.text === "a *b* **c** d", "runs of whitespace collapse to one space", runs?.text);

  const emptyStrong = await planPaste(payload("<p>a<strong> </strong>b</p>", "a b"), "markdown");
  check(
    emptyStrong?.text === "a b",
    "a whitespace-only emphasis keeps its space",
    emptyStrong?.text,
  );

  const emptyLink = await planPaste(payload('<p>a<a href="/x"> </a>b</p>', "a b"), "markdown");
  check(emptyLink?.text === "a b", "a whitespace-only link keeps its space", emptyLink?.text);
}

console.log("\n=== HTML to Markdown ===");
{
  const result = await planPaste(
    payload(
      `<h2>Title</h2><p>Hello <strong>world</strong> and <em>you</em>.</p>` +
        `<ul><li>One</li><li>Two</li></ul>` +
        `<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>`,
    ),
    "markdown",
  );
  const text = result?.text ?? "";
  check(text.includes("## Title"), "heading", text.split("\n")[0]);
  check(text.includes("**world**") && text.includes("*you*"), "emphasis");
  check(text.includes("- One") && text.includes("- Two"), "bullets");
  check(text.includes("| A | B |") && text.includes("| --- | --- |"), "GFM table");
  check(result?.block === true, "the fragment is block-level");
}

console.log("\n=== HTML to Typst ===");
{
  const result = await planPaste(
    payload(
      `<h2>Title</h2><p>Hello <strong>world</strong> and <em>you</em>.</p>` +
        `<ul><li>One</li><li>Two</li></ul>` +
        `<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>` +
        `<pre><code class="language-js">let x = 1</code></pre>`,
    ),
    "typst",
  );
  const text = result?.text ?? "";
  check(text.includes("= Title"), "heading");
  check(text.includes("*world*") && text.includes("_you_"), "strong and emphasis");
  check(text.includes("- One") && text.includes("- Two"), "bullets");
  check(text.includes("#table("), "table");
  check(text.includes("```js"), "code language");
  check(!/<\/?[a-z][^>]*>/i.test(text), "no HTML tags survive");
}

console.log("\n=== Markdown to Typst ===");
{
  const result = await planPaste(
    payload(
      null,
      "# Title\n\nSome **bold** and *em* and `code`.\n\n- one\n- two\n\n| A | B |\n|:--|--:|\n| 1 | 2 |",
    ),
    "typst",
  );
  const text = result?.text ?? "";
  check(text.includes("= Title"), "ATX heading becomes Typst");
  check(
    text.includes("*bold*") && text.includes("_em_") && text.includes("`code`"),
    "inline syntax",
  );
  check(text.includes("- one") && text.includes("- two"), "list");
  check(
    text.includes("#table(columns: 2") && text.includes("align: (left, right)"),
    "table alignment",
  );
}

console.log("\n=== Typst to Markdown ===");
{
  const result = await planPaste(
    payload(null, "= Title\n\nSome *strong* and _emph_ and `raw`.\n\n- one\n- two\n\n$ x^2 $\n"),
    "markdown",
  );
  const text = result?.text ?? "";
  check(text.includes("# Title"), "Typst heading becomes Markdown");
  check(
    text.includes("**strong**") && text.includes("*emph*") && text.includes("`raw`"),
    "inline syntax",
  );
  check(text.includes("- one") && text.includes("- two"), "list");
  check(text.includes("$$\n") || text.includes("$x^2$"), "equation carried", JSON.stringify(text));
}

console.log("\n=== HTML and Markdown to AsciiDoc ===");
{
  const html = await planPaste(
    payload(
      `<h1>Title</h1><p>Hello <strong>world</strong> and <em>you</em>.</p>` +
        `<ul><li>One</li><li>Two</li></ul>` +
        `<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>`,
    ),
    "asciidoc",
  );
  const htmlText = html?.text ?? "";
  check(htmlText.includes("== Title"), "h1 becomes an AsciiDoc section", htmlText.split("\n")[0]);
  check(htmlText.includes("*world*") && htmlText.includes("_you_"), "strong and emphasis");
  check(htmlText.includes("* One") && htmlText.includes("* Two"), "bullets");
  check(htmlText.includes("|==="), "table");
  check(!/<\/?[a-z][^>]*>/i.test(htmlText), "no HTML tags survive");

  const markdown = await planPaste(
    payload(
      null,
      "# Title\n\nSome **bold** and *em* and `code`.\n\n- one\n- two\n\n| A | B |\n|:--|--:|\n| 1 | 2 |",
    ),
    "asciidoc",
  );
  const mdText = markdown?.text ?? "";
  check(mdText.includes("== Title"), "Markdown heading becomes an AsciiDoc section");
  check(
    mdText.includes("*bold*") && mdText.includes("_em_") && mdText.includes("`code`"),
    "inline syntax",
  );
  check(mdText.includes("* one") && mdText.includes("* two"), "list");
  check(mdText.includes('[options="header"]') && mdText.includes("|==="), "header table");
}

console.log("\n=== AsciiDoc to Markdown and AsciiDoc ===");
{
  const source = "= Title\n\n== Section\n\nA *strong* word and latexmath:[x^2].\n\n* one\n* two\n";
  const destination = resolvePasteDestination({
    saved: false,
    language: "markdown",
    buffer: source,
  });
  check(
    destination.language === "asciidoc",
    "an AsciiDoc buffer is detected",
    destination.language,
  );

  const markdown = await planPaste(payload(null, source), "markdown");
  const text = markdown?.text ?? "";
  check(
    text.includes("# Title") && text.includes("## Section"),
    "titles become Markdown headings",
    text,
  );
  check(text.includes("**strong**") && text.includes("$x^2$"), "inline syntax and math survive");
  check(text.includes("- one") && text.includes("- two"), "bullets become Markdown");

  const same = await planPaste(payload(null, source), "asciidoc");
  check(
    same?.text === source && same.converted === false,
    "AsciiDoc into AsciiDoc is byte-identical",
  );

  const fenced = resolvePasteDestination({
    saved: false,
    language: "markdown",
    buffer: "# Markdown\n\n```asciidoc\n= Not a title\n:toc:\n|===\n```\n",
  });
  check(
    fenced.language !== "asciidoc",
    "a fenced AsciiDoc example does not classify the document",
    fenced.language,
  );

  const asciiMath = await planPaste(payload(null, "A $x^2$ formula."), "asciidoc");
  check(!(asciiMath?.text ?? "").includes("latexmath"), "AsciiMath is not rewritten as TeX");
  check((asciiMath?.text ?? "").includes("$x^2$"), "AsciiMath is kept as text");
}

console.log("\n=== AsciiDoc images ===");
{
  check(
    imageSyntaxFor("asciidoc", "Alt", "./a.png") === "image::./a.png[Alt]",
    "AsciiDoc block image syntax",
  );
  check(
    imageSyntaxFor("asciidoc", "a]b,c", "./a.png") === "image::./a.png[a\\]b\\,c]",
    "AsciiDoc attribute escaping",
  );

  const inline = await planPaste(
    payload(`<p>Before <img src="data:image/png;base64,AAA" alt="shot"> after</p>`),
    "asciidoc",
    { resolveImage: async () => ({ src: "./assets/shot.png", alt: "shot" }) },
  );
  check(
    (inline?.text ?? "").includes("image:./assets/shot.png[shot]"),
    "an image in a sentence uses image:",
    inline?.text ?? "",
  );

  const block = await planPaste(
    payload(`<p><img src="data:image/png;base64,AAA" alt="shot"></p>`),
    "asciidoc",
    { resolveImage: async () => ({ src: "./assets/shot.png", alt: "shot" }) },
  );
  check(
    (block?.text ?? "").includes("image::./assets/shot.png[shot]"),
    "a standalone image uses image::",
    block?.text ?? "",
  );
}

console.log("\n=== same-format and plain passthrough ===");
{
  const markdown = "# Title\n\nA **bold** line.\n";
  const same = await planPaste(payload(null, markdown), "markdown");
  check(same?.text === markdown && same.converted === false, "Markdown stays byte-identical");

  const typst = "= Title\n\nSome *strong* text.\n";
  const sameTypst = await planPaste(payload(null, typst), "typst");
  check(sameTypst?.text === typst && sameTypst.converted === false, "Typst stays byte-identical");

  const plain = "A sentence with no markup at all.";
  const samePlain = await planPaste(payload(null, plain), "html");
  check(samePlain?.text === plain && samePlain.converted === false, "plain prose stays intact");
}

console.log("\n=== escaping and structure ===");
{
  const result = await planPaste(
    payload(null, "# Title\n\n- one\n  - nested\n- two\n\n> quote\n\n```js\nlet x = 1\n```\n"),
    "markdown",
  );
  const text = result?.text ?? "";
  check(text.includes("  - nested"), "nested list indentation", JSON.stringify(text));
  check(text.includes("> quote"), "blockquote");
  check(text.includes("```js"), "fenced code");

  const special = await planPaste(payload("<p>* _ [ ] &lt; $ | ` #</p>"), "markdown");
  const escaped = special?.text ?? "";
  check(
    escaped.includes("\\*") &&
      escaped.includes("\\_") &&
      escaped.includes("\\[") &&
      escaped.includes("\\$"),
    "special characters escaped",
    escaped,
  );

  const typstSpecial = await planPaste(payload("<p>a * b _ c # d @ e [ f ]</p>"), "typst");
  check(
    !/(^|[^\\])\*/.test(typstSpecial?.text ?? ""),
    "Typst markup escaped",
    typstSpecial?.text ?? "",
  );
}

console.log("\n=== sanitation and safety ===");
{
  const result = await planPaste(
    payload(
      `<p onclick="steal()">Hello <a href="javascript:alert(1)">link</a></p><script>alert(1)</script><style>p{color:red}</style>`,
    ),
    "html",
  );
  const text = result?.text ?? "";
  check(!/script/i.test(text) && !/onclick/i.test(text), "scripts and handlers removed", text);
  check(!/javascript:/i.test(text), "javascript URL removed");
  check(text.includes("Hello"), "text survives");
}

console.log("\n=== images and math ===");
{
  check(
    imageSyntaxFor("markdown", "Alt", "./a.png") === "![Alt](./a.png)",
    "Markdown image syntax",
  );
  check(
    imageSyntaxFor("typst", "Alt", "./a.png") === '#image("./a.png", alt: "Alt")',
    "Typst image syntax",
  );
  check(imageSyntaxFor("typst", "", "./a.png") === '#image("./a.png")', "Typst empty alt");
  check(
    imageSyntaxFor("html", 'A "quote"', "./a.png") ===
      '<img src="./a.png" alt="A &quot;quote&quot;">',
    "HTML image syntax",
  );

  const result = await planPaste(
    payload(`<p>Before <img src="data:image/png;base64,AAA" alt="shot"> after</p>`),
    "typst",
    { resolveImage: async () => ({ src: "./assets/shot.png", alt: "shot" }) },
  );
  check(
    result?.text.includes('#image("./assets/shot.png", alt: "shot")'),
    "resolved image path",
    result?.text ?? "",
  );

  const math = await planPaste(
    payload(
      `<p><span class="katex"><math><semantics><annotation encoding="application/x-tex">\\frac{a}{b}</annotation></semantics></math></span></p>`,
    ),
    "typst",
  );
  check(
    math?.text.includes("frac(a, b)") || math?.text.includes("\\frac"),
    "TeX math reaches Typst",
    math?.text ?? "",
  );
}

console.log("\n=== fallbacks ===");
{
  const huge = "A Markdown paragraph. ".repeat(60_000);
  const result = await planPaste(payload(null, null, huge), "html");
  check(
    result?.text === huge,
    "an oversized Markdown-only clipboard falls back to its Markdown text",
  );
  check(
    result?.notices.some((notice) => notice.includes("too large")),
    "the oversized fallback is announced",
    JSON.stringify(result?.notices),
  );
}

console.log(`\n${passed}/${total} checks passed`);
process.exit(passed === total ? 0 : 1);
