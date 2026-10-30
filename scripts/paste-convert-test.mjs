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

import { chooseSource, isHtmlSource, detectTextSyntax, scoreTypst } from "../src/paste/detect.ts";
import { resolvePasteDestination, suggestSave } from "../src/paste/detect-document.ts";
import { planPaste } from "../src/paste/index.ts";
import { imageSyntaxFor } from "../src/image-syntax.ts";
import {
  analyzeMath,
  escapeMarkdownCurrency,
  markdownProseSelection,
} from "../src/math-delimiters.ts";
import { readMarkdown } from "../src/paste/read-markdown.ts";
import { readHtml } from "../src/paste/read-html.ts";
import { renderMarkdown } from "../src/paste/render-markdown.ts";
import { renderTypst } from "../src/paste/render-typst.ts";
import { renderAsciidoc } from "../src/paste/render-asciidoc.ts";
import { renderHtmlFragment } from "../src/paste/render-html.ts";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

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

console.log("\n=== save suggestion ===");
{
  // `main.ts` maps Default File Extension to the language a new document starts
  // in and passes both here; these calls use the same pairs.
  const suggest = (buffer, options = {}) =>
    suggestSave({
      path: null,
      language: "markdown",
      defaultExtension: "md",
      defaultLanguage: "markdown",
      ...options,
      buffer,
    });

  const saved = suggest("# A Markdown title\n\nA **bold** sentence.", {
    path: "C:/docs/paper.typ",
    language: "typst",
  });
  check(
    saved.language === "typst" && saved.extension === null,
    "a saved file keeps its own path and language",
    `${saved.language}/${saved.extension}`,
  );

  const typst = suggest("= A Typst title\n\n#set text(size: 10pt)\n\n- one\n- two");
  check(
    typst.language === "typst" && typst.extension === "typ",
    "untitled Typst content suggests .typ",
    `${typst.language}/${typst.extension}`,
  );

  const markdown = suggest(
    "# A Markdown title\n\nA **bold** sentence and [a link](https://example.com).",
    { language: "typst", defaultExtension: "typ", defaultLanguage: "typst" },
  );
  check(
    markdown.language === "markdown" && markdown.extension === "md",
    "untitled Markdown content beats a Typst default",
    `${markdown.language}/${markdown.extension}`,
  );

  const html = suggest("<h1>Title</h1>\n<p>Hello</p>", {
    language: "typst",
    defaultExtension: "typ",
    defaultLanguage: "typst",
  });
  check(
    html.language === "html" && html.extension === "html",
    "untitled HTML content suggests .html",
    `${html.language}/${html.extension}`,
  );

  const asciidoc = suggest(
    "= A book\n:doctype: book\n:toc:\n\nNOTE: Keep this.\n\nimage::cover.png[Cover]",
  );
  check(
    asciidoc.language === "asciidoc" && asciidoc.extension === "adoc",
    "untitled AsciiDoc content suggests .adoc",
    `${asciidoc.language}/${asciidoc.extension}`,
  );

  const blank = suggest("   \n\n", {
    language: "typst",
    defaultExtension: "typ",
    defaultLanguage: "typst",
  });
  check(
    blank.language === "typst" && blank.extension === "typ",
    "a blank buffer keeps the configured default",
    `${blank.language}/${blank.extension}`,
  );

  const preference = suggest("# Title\n\nA **bold** sentence.", {
    defaultExtension: "markdown",
  });
  check(
    preference.language === "markdown" && preference.extension === "markdown",
    "the reader's own Markdown spelling survives",
    `${preference.language}/${preference.extension}`,
  );

  const text = suggest("# Title\n\nA **bold** sentence.", { defaultExtension: "txt" });
  check(
    text.language === "markdown" && text.extension === "txt",
    "a plain-text default survives detected Markdown",
    `${text.language}/${text.extension}`,
  );

  const tie = suggest("= Title\n\nA sentence.");
  check(
    tie.language === "markdown" && tie.extension === "md",
    "a bare title is not a recommendation",
    `${tie.language}/${tie.extension}`,
  );

  const fenced = suggest("Prose.\n\n```typst\n= not a heading\n#set text(size: 9pt)\n```\n");
  check(
    fenced.language === "markdown" && fenced.extension === "md",
    "a fenced Typst sample cannot classify the buffer",
    `${fenced.language}/${fenced.extension}`,
  );

  const restored = suggest("A sentence with no markup yet.", { language: "typst" });
  check(
    restored.language === "typst" && restored.extension === "typ",
    "an untitled Typst buffer keeps Typst over a Markdown preference",
    `${restored.language}/${restored.extension}`,
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

  // The UnB news page writes its visual paragraphs as `<br><br>` inside one
  // `<p>`. Two hard breaks used to become a `\` at the end of every paragraph
  // and another alone on the blank line.
  const cms = await planPaste(
    payload("<p><br>One.<br><br>Two.<br><br>Three.</p>", "One.\n\nTwo.\n\nThree."),
    "markdown",
  );
  check(
    cms?.text === "One.\n\nTwo.\n\nThree.",
    "a CMS's <br><br> paragraphs become blank lines",
    JSON.stringify(cms?.text),
  );
  check(
    !(cms?.text ?? "").includes("\\"),
    "no hard-break backslash is left at a paragraph edge",
    JSON.stringify(cms?.text),
  );
  check(cms?.block === true, "split paragraphs paste as a block");

  const lineBreak = await planPaste(payload("<p>One<br>Two</p>", "One\nTwo"), "markdown");
  check(
    lineBreak?.text === "One\\\nTwo",
    "a single <br> stays a hard break",
    JSON.stringify(lineBreak?.text),
  );
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

console.log("\n=== image failures ===");
{
  const html = `<p>Before <img src="https://x.test/a.png" alt="a"> after</p>`;

  const thrown = await planPaste(payload(html), "markdown", {
    resolveImage: async () => {
      throw new Error("https://x.test/a.png answered HTTP 401.");
    },
  });
  check(
    (thrown?.text ?? "").includes("https://x.test/a.png"),
    "a failed image keeps its original address",
    thrown?.text ?? "",
  );
  check(
    (thrown?.notices ?? []).some(
      (notice) => notice.includes("could not be saved") && notice.includes("401"),
    ),
    "a failed image reaches the reader as a notice",
    JSON.stringify(thrown?.notices),
  );

  const reported = await planPaste(payload(html), "markdown", {
    resolveImage: async (_image, report) => {
      report("No document folder yet.");
      return null;
    },
  });
  check(
    (reported?.notices ?? []).includes("No document folder yet."),
    "a resolver can explain a kept address",
    JSON.stringify(reported?.notices),
  );
  check(
    (reported?.text ?? "").includes("https://x.test/a.png"),
    "the explained address is still the one in the document",
    reported?.text ?? "",
  );

  const kept = await planPaste(payload(html), "markdown", {
    resolveImage: async () => null,
  });
  check(
    (kept?.notices ?? []).length === 0,
    "a deliberate keep stays silent",
    JSON.stringify(kept?.notices),
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

console.log("\n=== currency and math contract ===");
const money = ["R$50", "R$ 10.000", "R$ 15.200,75", "US$5", "US$5.00", "C$8,123.50"];
function formulas(items) {
  return items.flatMap((node) =>
    node.kind === "math"
      ? [node.tex]
      : "children" in node
        ? formulas(node.children)
        : "blocks" in node
          ? formulas(node.blocks)
          : node.kind === "list"
            ? node.items.flatMap((item) => formulas(item.blocks))
            : node.kind === "table"
              ? [...(node.header ?? []), ...node.rows.flat()].flatMap(formulas)
              : [],
  );
}
for (const amount of money) {
  for (const source of [
    amount,
    amount + " e " + amount,
    "**" + amount + "**",
    amount + " and $ a + b $",
    "$x$ and " + amount,
  ]) {
    const expected = source.replace(/\$/g, (dollar, at) =>
      source.slice(at - 1, at) === "R" ||
      source.slice(at - 1, at) === "C" ||
      source.slice(at - 2, at) === "US"
        ? "\\$"
        : dollar,
    );
    const output = escapeMarkdownCurrency(source);
    check(output === expected, "minimal escapes: " + source, JSON.stringify(output));
    check(escapeMarkdownCurrency(output) === output, "idempotent: " + source);
    const actual = await planPaste(payload(null, source), "markdown");
    check(actual?.text === expected && actual.converted, "native plan: " + source);
  }
}
const originals = [
  "Você está autorizando uma média de **R$50/dia, R$350/semana e ~R\\$1.500/mês**, e aceitando disputar cliques oferecendo **até R\\$13,50 por clique",
  "Você pode subir gradualmente (em dólares canadenses): C$5 → C$6 → C$7,50 etc. Eu evitaria começar diretamente em C$13,50.",
];
const currencyOnly = [
  ...originals,
  "US$5 and US$7",
  "R$50 e R$40",
  "$2.00 and $3.50",
  "$2.00–$3.50",
  "$2.00-$3.50",
  "$2.00/$3.50",
  "$5 + $7 = $12",
  "$10 > $5",
  "It costs $50 ($40 for members)",
  '"$50" or "$40"',
  "$350/week and ~$1,500/month",
  "U$S100 e U$S 100",
  "-$5, $-5, R$ -10,50, ($50), $.50",
  "R$\u00a015.200,75 / C$\u202f8,123.50",
  "US$1 000 and C$8'123.50",
  "R$50\\\nUS$5\r\nC$8,123.50",
];
for (const source of currencyOnly) {
  const expected = source.replace(/(?<!\\)\$/g, "\\$");
  const result = escapeMarkdownCurrency(source);
  check(
    result === expected &&
      analyzeMath(source).math.length === 0 &&
      formulas(await readMarkdown(source)).length === 0,
    "literal currency: " + JSON.stringify(source),
    result,
  );
}
const mathCases = [
  ["$[a](b)$", ["[a](b)"]],
  ["$ a + b $", ["a + b"]],
  ["$ a - b $", ["a - b"]],
  ["$ a * b $", ["a * b"]],
  ["$ a / bc $", ["a / bc"]],
  ["$ ^{1} $", ["^{1}"]],
  ["$ E_{n} $", ["E_{n}"]],
  ["$ L $", ["L"]],
  ["$ 2\\gamma\\hbar\\omega_x $", ["2\\gamma\\hbar\\omega_x"]],
  ["$5$", ["5"]],
  ["$ 5 $", []],
  ["$ -5 $", ["-5"]],
  ["$2x + 1$", ["2x + 1"]],
  ["$10^6$", ["10^6"]],
  ["$1/2$", ["1/2"]],
  ["$2/ab$", ["2/ab"]],
  ["$2M$", ["2M"]],
  ["f$2x+1$", ["2x+1"]],
  ["R$2x+1$", ["2x+1"]],
  ["Al$_x$Ga$_{1-x}$As", ["_x", "_{1-x}"]],
  ["assuming$^29$", ["^29"]],
  ["R$5$ and $x$", ["x"]],
  ["$50/day$", ["50/day"]],
  ["$5 + tax$", ["5 + tax"]],
  ["$5 and $x$", ["x"]],
  ["$5 + $x$", ["x"]],
  ["$50/day and $x$", ["x"]],
  ["$x$2", []],
  ["The symbol \\$ precedes $ a + b $", ["a + b"]],
  ["$ foo bar $ and $x$", ["x"]],
  ["$a*b*c$", ["a*b*c"]],
  ["$\\{x\\}$", ["\\{x\\}"]],
  ["\\(x + y\\)", ["x + y"]],
  ["\\[x^2\\]", ["x^2"]],
  ["$$x^2\n+ y^2$$", ["x^2\n+ y^2"]],
  ["$a → b$ and $x'$ and $x@@y$", ["a → b", "x'", "x@@y"]],
  ["[$x$](https://example.com/$5) and | $y$ |", ["x", "y"]],
];
for (const [source, expected] of mathCases) {
  const scanned = analyzeMath(source).math.map((range) => range.body);
  check(
    JSON.stringify(scanned) === JSON.stringify(expected),
    "math ranges: " + source,
    JSON.stringify(scanned),
  );
  const read = formulas(await readMarkdown(source));
  check(
    JSON.stringify(read) === JSON.stringify(expected),
    "math before Markdown tokenization: " + source,
    JSON.stringify(read),
  );
}
const protectedSnippets = [
  "https://example.com/$5",
  "www.example.com/$5",
  "`R$50 and $x$`",
  "``R$50 ` and $x$``",
  "`R$50\nUS$5`",
  "````md\nR$50\n```\nUS$5\n````",
  "~~~\nR$50\n~~~",
  "```\nR$50",
  "> - ````\n>   R$50\n>   ```\n>   US$5\n>   ````",
  "    R$50\n    US$5",
  '[price](https://example.com/$5 "R$50")',
  "![image](./$5.png)",
  '[price]: https://example.com/$5 "R$50"',
  "<https://example.com/$5>",
  '<p title="R$50">safe</p>',
  "<!-- R$50 -->",
  "<code>R$50</code>",
  "<pre>R$50</pre>",
  "$\\text{R\\$50}$",
  "$$\\text{R\\$50}$$",
  "\\[\\text{R\\$50}\\]",
  "\\(\\text{R\\$50}\\)",
];
for (const source of protectedSnippets) {
  check(escapeMarkdownCurrency(source) === source, "protected source: " + JSON.stringify(source));
  check(
    escapeMarkdownCurrency(source + "\n\nR$7") === source + "\n\nR\\$7" ||
      source.startsWith("```\n"),
    "prose resumes after protected region: " + JSON.stringify(source),
  );
}
for (let count = 0; count <= 6; count++) {
  const source = "\\".repeat(count) + "$5";
  const expected = "\\".repeat(count + (count % 2 === 0 ? 1 : 0)) + "$5";
  check(escapeMarkdownCurrency(source) === expected, "backslash parity " + count);
}
check(
  formulas(await readMarkdown("R\\$50 and R\\$40")).length === 0 &&
    renderMarkdown(await readMarkdown("R\\$50 and R\\$40")) === "R\\$50 and R\\$40",
  "Markdown escapes decode once",
);
for (const source of [
  "<p>R<span>$50 and R</span>$40</p>",
  "<p><span>US</span><span>$5+$</span>7</p>",
  "<p>R$50 e <strong>R$40</strong></p>",
]) {
  const blocks = await readHtml(source);
  check(
    formulas(blocks).length === 0 && !renderHtmlFragment(blocks).includes("katex"),
    "HTML adjacent text context: " + source,
  );
}
const htmlSlash = await readHtml("<p>R\\$50 and R\\$40</p>");
check(
  renderMarkdown(htmlSlash) === "R\\\\\\$50 and R\\\\\\$40",
  "HTML visible backslashes are retained",
);
for (const amount of money) {
  const blocks = await readHtml("<p>" + amount + "</p>");
  check(
    renderMarkdown(blocks) === amount.replace("$", "\\$") &&
      renderTypst(blocks) === amount.replace("$", "\\$") &&
      renderAsciidoc(blocks) === amount &&
      renderHtmlFragment(blocks).includes(amount),
    "currency through all renderers: " + amount,
  );
}
const annotated = await readHtml(
  '<span class="katex"><math><semantics><annotation encoding="application/x-tex">\\text{R\\$50}</annotation></semantics></math></span>',
);
check(formulas(annotated)[0] === "\\text{R\\$50}", "semantic HTML math is authoritative");
for (const [data, expected] of [
  [payload(null, null, "\n\nR$50\n\n"), "\n\nR\\$50\n\n"],
  [payload(null, "plain R$50", "# unrelated R$7"), "plain R\\$50"],
  [payload("<strong>decoration R$7</strong>", "# Source R$50"), "# Source R\\$50"],
]) {
  const result = await planPaste(data, "markdown");
  check(
    result?.text === expected && result.converted && !result.block,
    "selected representation without block formatting",
    JSON.stringify(result),
  );
}
for (const source of [
  "`R$5`",
  "```\nR$5",
  "$x + y$",
  "\\(x + y\\)",
  "[label](https://example.com/$5)",
  '<span title="R$5">',
]) {
  const position = source.includes("https:")
    ? source.indexOf("https:")
    : source.indexOf("$5") >= 0
      ? source.indexOf("$5") + 1
      : Math.floor(source.length / 2);
  check(
    !markdownProseSelection(source, [{ from: position, to: position }]),
    "protected insertion: " + source,
  );
}
check(
  markdownProseSelection("R$50 and $x$ after", [{ from: 4, to: 4 }]) &&
    markdownProseSelection("$x$", [{ from: 3, to: 3 }]),
  "currency and completed math boundaries are prose",
);
check(
  !markdownProseSelection("text `code`", [
    { from: 0, to: 0 },
    { from: 8, to: 8 },
  ]),
  "mixed multi-selection guard",
);
for (const [file, baseline] of Object.entries(
  JSON.parse(readFileSync(new URL("./fixtures/math-inventory.json", import.meta.url), "utf8")),
)) {
  const sourceUrl = new URL("../" + file, import.meta.url);
  const optional = file.startsWith("docs/samples/");
  const source =
    existsSync(sourceUrl) && !(optional && process.argv.includes("--without-optional-corpus"))
      ? readFileSync(sourceUrl, "utf8")
      : null;
  check(
    source !== null
      ? createHash("sha256").update(source).digest("hex") === baseline.sha256
      : optional && baseline.entries.length === 292 && /^[a-f\d]{64}$/.test(baseline.sha256),
    source !== null
      ? "independent baseline source hash: " + file
      : "optional local corpus absent; 292 pinned formula cases remain available",
  );
  const actual =
    source !== null
      ? analyzeMath(source).math.map(({ body, display, from, to }) => ({
          body,
          display,
          src0: from,
          src1: to,
        }))
      : null;
  check(
    actual !== null
      ? JSON.stringify(actual) === JSON.stringify(baseline.entries)
      : baseline.entries.every(({ body, display }) => {
          const marker = display ? "$$" : "$";
          const parsed = analyzeMath(marker + body + marker).math;
          return parsed.length === 1 && parsed[0].body === body && parsed[0].display === display;
        }),
    actual !== null
      ? "every baseline body/range/display kind: " + file
      : "all recorded physics bodies/display kinds parse without the ignored source file",
  );
}
const malformed = "\\( ".repeat(20_000) + "$5 and ".repeat(15_000);
const started = performance.now();
escapeMarkdownCurrency(malformed);
check(
  performance.now() - started < 4000,
  "bounded malformed delimiter work",
  Math.round(performance.now() - started) + "ms",
);
const oversizedMoney = await planPaste(payload(null, "R$50 ".repeat(210_000)), "markdown");
check(
  oversizedMoney?.converted === false &&
    oversizedMoney.notices.some((n) => n.includes("too large")),
  "currency size cap retains fallback notice",
);

check(
  detectTextSyntax("- first\n- second\n\n@ref <label>\n\n$ 5 $")?.language === "typst",
  "native Typst numeric math retains its threshold signal",
);
check(
  scoreTypst("- first\n- second\n\n@ref <label>\n\nR$5 e R$7") === 3 &&
    detectTextSyntax("- first\n- second\n\n@ref <label>\n\nR$5 e R$7") === null,
  "currency does not award a false Typst threshold point",
);
check(
  escapeMarkdownCurrency("\\[unfinished R$50") === "\\[unfinished R$50",
  "unfinished explicit math protects its contents",
);
check(
  !markdownProseSelection("$x\n\nR$50", [{ from: 2, to: 2 }]),
  "unfinished math context ends at its own source line",
);
check(
  analyzeMath("😀 Café\r\nR$50 and $x$ final").math[0]?.from === 18,
  "CRLF and non-BMP source offsets remain UTF-16 positions",
);
const privateMarker = "\ue000PASTEMATH0:0\ue001";
const markerRead = await readMarkdown(privateMarker + " $x$");
check(
  renderMarkdown(markerRead).includes(privateMarker) &&
    JSON.stringify(formulas(markerRead)) === '["x"]',
  "literal placeholder-like input cannot become a formula",
);
check(
  JSON.stringify(analyzeMath("$x" + "\\".repeat(2) + "$").math.map((range) => range.body)) ===
    JSON.stringify(["x" + "\\".repeat(2)]) && analyzeMath("$x\\$").math.length === 0,
  "closing delimiter uses full backslash parity",
);
check(
  escapeMarkdownCurrency("Cr$ and Cz$") === "Cr$ and Cz$",
  "numberless currency prefixes remain ordinary text",
);
console.log(`\n${passed}/${total} checks passed`);
process.exit(passed === total ? 0 : 1);
