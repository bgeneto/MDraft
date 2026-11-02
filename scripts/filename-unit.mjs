// Unit tests for the filename suggester.
//
//   node scripts/filename-unit.mjs
//
// No application and no build: `src/filename.ts` imports only a type, so Node
// strips it and runs the module directly.
//
// What it is for: the Save dialog pre-fills this name. The rules are a matrix
// across four markups plus a cross-platform sanitiser, and a mistake is visible
// only after a native dialog opens — which is exactly what a CDP suite cannot
// inspect. Pin the matrix here; `p0-lifecycle-test.mjs` proves the dialog wiring
// and `ai-assistant-test.mjs` proves the optional request.

import {
  AI_EXCERPT_CHARS,
  MAX_STEM_BYTES,
  MAX_STEM_CHARS,
  UNTITLED_STEM,
  cleanAiSuggestion,
  plainExcerpt,
  sanitizeFileStem,
  suggestFileStem,
  withExtension,
} from "../src/filename.ts";

let passed = 0;
let total = 0;
function check(ok, label, detail = "") {
  total += 1;
  if (ok) passed += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

function same(actual, expected, label) {
  check(actual === expected, label, actual === expected ? "" : `got ${JSON.stringify(actual)}`);
}

function stem(text, language = "markdown") {
  return suggestFileStem({ text, language });
}

function lines(...items) {
  return items.join("\n");
}

const utf8 = (text) => new TextEncoder().encode(text).length;

// ---------------------------------------------------------------------------
console.log("=== Markdown: title sources ===");
{
  const headline =
    "A Grande Mudança que se Aproxima nas Relações entre os Estados Unidos e a China na Era da Inteligência Artificial";
  const found = stem(`# ${headline}`);
  same(found.stem, headline, "a heading becomes the whole 113-character name, accents intact");
  same(found.source, "heading", "the source is the heading");
}
{
  const found = stem("# Notes ##");
  same(found.stem, "Notes", "a closing hash sequence is not part of the name");
}
{
  const found = stem("# C#");
  same(found.stem, "C#", "a hash inside the title survives");
}
{
  const found = stem(lines("A setext title", "==============", "", "Body"));
  same(found.stem, "A setext title", "a setext heading is a heading");
  same(found.source, "heading", "setext reports heading");
}
{
  const found = stem(
    lines("---", 'title: "A quoted title"', "author: Someone", "---", "", "# Body"),
  );
  same(found.stem, "A quoted title", "YAML front matter supplies the title");
  same(found.source, "metadata", "front matter reports metadata");
}
{
  const found = stem(lines("---", "title: >", "  A folded", "  title", "---", "", "# Body"));
  same(found.stem, "A folded title", "a folded YAML title is joined");
}
{
  const found = stem(lines("", "A plain first line.", "", "More text."));
  same(
    found.stem,
    "A plain first line",
    "a first paragraph becomes the name without its final period",
  );
  same(found.source, "line", "a paragraph reports line");
}
{
  const found = stem(lines("## Intro", "", "# The real title", "", "Body"));
  same(found.stem, "The real title", "an H1 wins over an earlier H2");
}
{
  const found = stem(lines("# CON", "", "A real opening line."));
  same(
    found.stem,
    "A real opening line",
    "a heading that sanitises to fallback falls through to the next source",
  );
  same(found.source, "line", "the fall-through reports line");
}

// ---------------------------------------------------------------------------
console.log("=== Markdown: what is not a title ===");
{
  const found = stem(
    lines(
      "[TOC]",
      "",
      "---",
      "",
      "```",
      "const x = 1;",
      "```",
      "",
      "| a | b |",
      "|---|---|",
      "",
      "[ref]: https://example.com",
      "",
      "Real opening sentence.",
    ),
  );
  same(
    found.stem,
    "Real opening sentence",
    "directives, fences, tables and definitions are skipped",
  );
}
{
  const found = stem(lines("![](plot.png)", "", "A caption after the image."));
  same(found.stem, "A caption after the image", "an image-only line does not become the name");
}
{
  const found = stem(lines("# **Bold** and *italic* with [a link](https://x) and `code`."));
  same(found.stem, "Bold and italic with a link and code", "inline markup is reduced to its words");
}
{
  const found = stem("# Research &amp; Development");
  same(found.stem, "Research & Development", "an HTML entity is decoded");
}
{
  const found = stem(lines("- Buy milk", "- Call Ana"));
  same(found.stem, "Buy milk", "a list marker is not part of the name");
}
{
  const found = stem("[TOC]\n\n<!-- a comment -->");
  same(found.stem, UNTITLED_STEM, "a directive-only document falls back to untitled");
  same(found.source, "fallback", "the fallback is reported");
}

// ---------------------------------------------------------------------------
console.log("=== Typst ===");
{
  const found = stem("= A Typst title\n\nBody", "typst");
  same(found.stem, "A Typst title", "a Typst heading is a heading");
}
{
  const found = stem(lines('#set document(title: "Typst metadata")', "", "Body"), "typst");
  same(found.stem, "Typst metadata", "a document title is metadata");
  same(found.source, "metadata", "the Typst title reports metadata");
}
{
  const found = stem(
    lines(
      "//! A small tour.",
      "//!",
      '#set page(paper: "a4", margin: 2.2cm)',
      "#set text(size: 11pt)",
      "",
      "#align(center)[",
      '  #text(size: 20pt, weight: "bold")[MDraft - Typst tour]',
      "]",
    ),
    "typst",
  );
  same(found.stem, "MDraft - Typst tour", "a title block's bracketed text is the first prose line");
  same(found.source, "line", "the title block reports line");
}
{
  const found = stem("The value $x^2$ is final.", "typst");
  same(found.stem, "The value is final", "inline math is not part of the name");
}
{
  const found = stem("= Results #strong[by the team]", "typst");
  same(found.stem, "Results by the team", "an inline Typst command keeps its bracket text");
}

// ---------------------------------------------------------------------------
console.log("=== AsciiDoc ===");
{
  const found = stem(lines("= AsciiDoc Tour", ":toc:", ":stem: latexmath", "", "Body"), "asciidoc");
  same(found.stem, "AsciiDoc Tour", "the document title is the name");
}
{
  const found = stem(lines(":title: Attribute Title", "", "Body"), "asciidoc");
  same(found.stem, "Attribute Title", "the title attribute is metadata");
  same(found.source, "metadata", "the attribute reports metadata");
}
{
  const found = stem("= *Bold* and _italic_", "asciidoc");
  same(found.stem, "Bold and italic", "AsciiDoc inline markup is removed");
}
{
  const found = stem("See link:https://example.com[the label] for details.", "asciidoc");
  same(found.stem, "See the label for details", "a link keeps its label");
}
{
  const found = stem("See image:plot.png[the results] here.", "asciidoc");
  same(found.stem, "See the results here", "an inline image keeps its alt text");
}

// ---------------------------------------------------------------------------
console.log("=== HTML ===");
{
  const found = stem(
    lines("<!doctype html>", "<html>", "<head>", "<title>Page &amp; Title</title>", "</head>"),
    "html",
  );
  same(found.stem, "Page & Title", "the title element is metadata");
  same(found.source, "metadata", "the HTML title reports metadata");
}
{
  const found = stem("<h1>Hello <em>World</em></h1>", "html");
  same(found.stem, "Hello World", "tags inside a heading are removed");
}
{
  const found = stem(
    lines(
      "<!doctype html>",
      "<html><head><title></title></head>",
      "<body><script>var x = 1;</script><p>First paragraph</p></body>",
    ),
    "html",
  );
  same(found.stem, "First paragraph", "script text is not document text");
  same(found.source, "line", "the first block reports line");
}
{
  const found = stem("<style>p{color:red}</style><p>Real text</p>", "html");
  same(found.stem, "Real text", "style text is not document text");
}

// ---------------------------------------------------------------------------
console.log("=== sanitising ===");
{
  same(
    sanitizeFileStem("Q&A: What's Next?"),
    "Q&A What's Next",
    "invalid punctuation becomes a space",
  );
  same(
    sanitizeFileStem("U.S./China: The Next Chapter"),
    "U.S. China The Next Chapter",
    "slashes and colons become spaces",
  );
  same(sanitizeFileStem("A title..."), "A title", "a trailing ellipsis is removed");
  same(sanitizeFileStem('"A quoted title"'), "A quoted title", "wrapping quotes are removed");
  same(
    sanitizeFileStem("A\u200b zero\u0000 width"),
    "A zero width",
    "zero-width and control characters vanish",
  );
  same(sanitizeFileStem("A title."), "A title", "a trailing dot is removed");
  same(sanitizeFileStem("  spaced  "), "spaced", "outer whitespace is removed");
  same(sanitizeFileStem("---"), UNTITLED_STEM, "punctuation alone is not a name");
  same(sanitizeFileStem("CON"), UNTITLED_STEM, "a reserved device name is refused");
  same(sanitizeFileStem("LPT1"), UNTITLED_STEM, "a reserved printer name is refused");
  same(sanitizeFileStem("console"), "console", "a name beginning like a reserved word is fine");
}
{
  const long = `${"word ".repeat(60)}end`;
  const cut = sanitizeFileStem(long);
  check(cut.length <= MAX_STEM_CHARS, "a long name is capped by characters", String(cut.length));
  check(!cut.endsWith(" "), "the cap leaves no trailing space");
  check(/word$/.test(cut) || /end$/.test(cut), "the cap ends on a word boundary", cut.slice(-20));
}
{
  const cjk = "漢".repeat(100);
  const cut = sanitizeFileStem(cjk);
  check(utf8(cut) <= MAX_STEM_BYTES, "a CJK name is capped by UTF-8 bytes", String(utf8(cut)));
  check(cut.length === 60, "180 bytes holds 60 three-byte characters", String(cut.length));
}
{
  const prefix = "a".repeat(MAX_STEM_CHARS);
  const cut = sanitizeFileStem(`${prefix}😀`);
  check(cut.length === MAX_STEM_CHARS, "a surrogate pair is not counted as one UTF-16 unit");
  check(!/[\uD800-\uDBFF]$/.test(cut), "a cut never leaves a lone high surrogate");
}
{
  same(withExtension("Name", "md"), "Name.md", "the extension is appended");
  same(withExtension("Name", ".md"), "Name.md", "a leading dot in the extension is tolerated");
  same(withExtension("Name", ""), "Name", "an empty extension adds nothing");
}

// ---------------------------------------------------------------------------
console.log("=== the assistant's answer ===");
{
  same(
    cleanAiSuggestion('File name: "Relações EUA-China"', "md"),
    "Relações EUA-China",
    "a label and quotes are removed",
  );
  same(
    cleanAiSuggestion(lines("```", "Title Here", "```"), "md"),
    "Title Here",
    "a fenced answer is unwrapped",
  );
  same(
    cleanAiSuggestion(lines("Here is a name:", "Better Name"), "md"),
    "Better Name",
    "a preamble line ending in a colon is skipped",
  );
  same(cleanAiSuggestion("Notes.md", "md"), "Notes", "the extension the model added is removed");
  same(cleanAiSuggestion("A/B?", "md"), "A B", "an illegal answer is repaired");
  same(cleanAiSuggestion("   ", "md"), null, "an empty answer is rejected");
  same(cleanAiSuggestion("untitled", "md"), null, "a fallback answer is rejected");
  same(cleanAiSuggestion("CON", "md"), null, "a reserved answer is rejected");
  same(cleanAiSuggestion("A useful name", "md"), "A useful name", "a clean answer passes through");
  same(
    cleanAiSuggestion("**A bold answer**", "md"),
    "A bold answer",
    "wrapping emphasis is removed",
  );
}
{
  const long = cleanAiSuggestion("x".repeat(300), "md");
  check(
    long !== null && long.length <= MAX_STEM_CHARS,
    "an overlong answer is capped",
    String(long?.length),
  );
}

// ---------------------------------------------------------------------------
console.log("=== the excerpt ===");
{
  same(plainExcerpt("A short document."), "A short document.", "a short document is unchanged");
  same(plainExcerpt(""), "", "an empty document has no excerpt");
  const long = "word ".repeat(3_000);
  const excerpt = plainExcerpt(long);
  check(
    Array.from(excerpt).length <= AI_EXCERPT_CHARS,
    "the excerpt is capped",
    String(Array.from(excerpt).length),
  );
  check(excerpt.endsWith("word"), "the excerpt is cut at a boundary", excerpt.slice(-12));
}

console.log(`\n${passed}/${total} checks passed`);
process.exit(passed === total ? 0 : 1);
