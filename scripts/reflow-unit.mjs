// Unit checks for Unwrap Paragraph and Wrap Paragraph (src/format/reflow*.ts).
//
//   node scripts/reflow-unit.mjs
//
// App-free (Node 24). Three layers:
//   1. named hazards with exact expected output, one per rule in the classifiers;
//   2. invariants over every shipped Markdown, LaTeX, Typst and AsciiDoc sample
//      plus README.md and docs/guide.md, wrapped at 40/80/100 and unwrapped:
//      idempotence, round trip, unchanged structure, unchanged words, width;
//   3. render oracles: the Lezer Markdown tree, Asciidoctor's HTML, and a
//      comment-aware LaTeX token stream must not change.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import * as asciidoctor from "@asciidoctor/core";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { applyChanges, displayWidth, linesOf, reflow } from "../src/format/reflow.ts";
import { reflowDialect } from "../src/format/reflow-dialects.ts";
import { commentStart } from "../src/latex-references.ts";

let failures = 0;
let passes = 0;
function check(ok, label, detail = "") {
  if (ok) passes += 1;
  else {
    failures += 1;
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
  return ok;
}
function pass(label) {
  console.log(`PASS ${label}`);
}

const LANGUAGES = { ".md": "markdown", ".tex": "latex", ".typ": "typst", ".adoc": "asciidoc" };

function run(text, language, mode, column = 80, ranges = [{ from: 0, to: text.length }]) {
  const result = reflow(text, ranges, reflowDialect(language), { mode, column });
  return { text: applyChanges(text, result.changes), result };
}
const wrap = (text, language, column = 80) => run(text, language, "wrap", column).text;
const unwrap = (text, language) => run(text, language, "unwrap").text;

function expectEqual(actual, expected, label) {
  if (check(actual === expected, label, `\n--- expected\n${expected}\n--- actual\n${actual}`)) pass(label);
}

// ---------------------------------------------------------------------------
console.log("=== named hazards ===");

// LaTeX
const latexDoc = (body) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
expectEqual(
  unwrap(latexDoc("This is one\nparagraph of text\nover three lines."), "latex"),
  latexDoc("This is one paragraph of text over three lines."),
  "latex: a paragraph unwraps to one line",
);
expectEqual(
  unwrap(latexDoc("before % a comment\nafter the comment\nand more."), "latex"),
  latexDoc("before % a comment\nafter the comment and more."),
  "latex: a line with a % comment keeps its newline",
);
expectEqual(
  unwrap(latexDoc("glued%\ntogether"), "latex"),
  latexDoc("glued%\ntogether"),
  "latex: word% newline is not joined",
);
expectEqual(
  unwrap(latexDoc("first line,\\\\\nsecond line\nstill second.\\\\[2pt]\nthird"), "latex"),
  latexDoc("first line,\\\\\nsecond line still second.\\\\[2pt]\nthird"),
  "latex: \\\\ and \\\\[2pt] keep their breaks",
);
expectEqual(
  unwrap(latexDoc("A 50\\% share\nof text."), "latex"),
  latexDoc("A 50\\% share of text."),
  "latex: an escaped percent is text",
);
expectEqual(
  unwrap(latexDoc("\\begin{itemize}\n  \\item first item\n    continues here\n  \\item second\n\\end{itemize}"), "latex"),
  latexDoc("\\begin{itemize}\n  \\item first item continues here\n  \\item second\n\\end{itemize}"),
  "latex: \\item lines start paragraphs and keep their marker",
);
expectEqual(
  wrap(latexDoc("\\begin{itemize}\n  \\item one two three four five six seven\n\\end{itemize}"), "latex", 26),
  latexDoc("\\begin{itemize}\n  \\item one two three four\n    five six seven\n\\end{itemize}"),
  "latex: wrapped \\item continuation is indented under the item",
);
{
  const verbatim = latexDoc("Text before\nthe block.\n\\begin{verbatim}\nkeep   this\nexactly\n\\end{verbatim}\nText after\nthe block.");
  expectEqual(
    unwrap(verbatim, "latex"),
    latexDoc("Text before the block.\n\\begin{verbatim}\nkeep   this\nexactly\n\\end{verbatim}\nText after the block."),
    "latex: verbatim bodies are untouched",
  );
  const tabular = latexDoc("\\begin{tabular}{ll}\na & b \\\\\nc & d\n\\end{tabular}");
  expectEqual(unwrap(tabular, "latex"), tabular, "latex: tabular is protected");
  const preamble = "\\documentclass{article}\n\\newcommand{\\x}{a\nb}\n\\begin{document}\nok\n\\end{document}\n";
  expectEqual(unwrap(preamble, "latex"), preamble, "latex: the preamble is protected");
  const display = latexDoc("Before\n\\[\n  x = 1\n\\]\nafter.");
  expectEqual(unwrap(display, "latex"), display, "latex: display math lines are protected");
  const label = latexDoc("A sentence with a\n\\label{x} after it.");
  expectEqual(unwrap(label, "latex"), label, "latex: a line starting with \\label is not joined");
  expectEqual(
    wrap(latexDoc("Some words \\label{eq:one} then more words follow here"), "latex", 22),
    latexDoc("Some words \\label{eq:one}\nthen more words follow\nhere"),
    "latex: wrap never starts a line with a structural command",
  );
  expectEqual(
    wrap(latexDoc("aa \\verb|x y z| bb cc"), "latex", 8),
    latexDoc("aa\n\\verb|x y z|\nbb cc"),
    "latex: \\verb is never split",
  );
  expectEqual(
    wrap(latexDoc("aa $x + y = z$ bb"), "latex", 6),
    latexDoc("aa\n$x + y = z$\nbb"),
    "latex: inline math is never split",
  );
  const chapter = "A chapter file\nwithout a preamble.\n";
  expectEqual(unwrap(chapter, "latex"), "A chapter file without a preamble.\n", "latex: an \\input chapter is all body");
}

// Markdown
expectEqual(unwrap("one\ntwo\nthree\n", "markdown"), "one two three\n", "markdown: a paragraph unwraps");
expectEqual(
  unwrap("hard  \nbreak\\\nkept\nend\n", "markdown"),
  "hard  \nbreak\\\nkept end\n",
  "markdown: two-space and backslash hard breaks are kept",
);
expectEqual(
  unwrap("- item one\n  continues\n- item two\n", "markdown"),
  "- item one continues\n- item two\n",
  "markdown: list items unwrap separately",
);
expectEqual(
  wrap("- alpha beta gamma delta epsilon\n", "markdown", 16),
  "- alpha beta\n  gamma delta\n  epsilon\n",
  "markdown: wrapped list continuation hangs under the text",
);
expectEqual(
  wrap("> - alpha beta gamma delta\n", "markdown", 14),
  "> - alpha beta\n>   gamma\n>   delta\n",
  "markdown: quote markers are repeated, list markers become spaces",
);
{
  const out = wrap("Count to ten: 1. then a list marker could appear - like this one here\n", "markdown", 14);
  const bad = linesOf(out).slice(1).filter((line) => /^\s*(?:\d+\.|-)(?:\s|$)/.test(line));
  check(bad.length === 0, "markdown: wrap never starts a line with a list marker", out);
  if (!bad.length) pass("markdown: wrap never starts a line with a list marker");
  const setext = wrap("A line of words then --- and === here\n", "markdown", 18);
  const created = linesOf(setext).slice(1).some((line) => /^\s*(?:=+|-+)\s*$/.test(line));
  check(!created, "markdown: wrap never creates a setext underline", setext);
  if (!created) pass("markdown: wrap never creates a setext underline");
}
{
  const fence = "Text\nabove.\n\n```\ncode   stays\nas is\n```\n";
  expectEqual(unwrap(fence, "markdown"), "Text above.\n\n```\ncode   stays\nas is\n```\n", "markdown: fences untouched");
  const front = "---\ntitle: x\nauthor: y\n---\n\nBody\ntext.\n";
  expectEqual(unwrap(front, "markdown"), "---\ntitle: x\nauthor: y\n---\n\nBody text.\n", "markdown: front matter untouched");
  const alert = "> [!NOTE]\n> Useful\n> information.\n";
  expectEqual(unwrap(alert, "markdown"), "> [!NOTE]\n> Useful information.\n", "markdown: alert marker stays on its own line");
  const math = "Before\n$$\nx = 1\n$$\n";
  expectEqual(unwrap(math, "markdown"), math, "markdown: $$ math paragraph is left alone");
  expectEqual(
    wrap("see `a b c d` and more\n", "markdown", 8),
    "see\n`a b c d`\nand more\n",
    "markdown: code spans are never split",
  );
  expectEqual(
    unwrap("- [ ] task item\n  that continues\n", "markdown"),
    "- [ ] task item that continues\n",
    "markdown: task items unwrap",
  );
  const heading = "# Heading\nText\nhere.\n";
  expectEqual(unwrap(heading, "markdown"), "# Heading\nText here.\n", "markdown: headings untouched");
}

// Typst
expectEqual(unwrap("one\ntwo\nthree\n", "typst"), "one two three\n", "typst: a paragraph unwraps");
expectEqual(
  unwrap("text // comment\nnext line\nmore\n", "typst"),
  "text // comment\nnext line more\n",
  "typst: a // comment keeps its newline",
);
expectEqual(
  unwrap("see https://example.com\nfor more\n", "typst"),
  "see https://example.com for more\n",
  "typst: a URL is not a comment",
);
expectEqual(unwrap("line break \\\nkept\nhere\n", "typst"), "line break \\\nkept here\n", "typst: \\ line break kept");
{
  const figure = "Prose\nhere.\n#figure(\n  image(\"a.png\"),\n  caption: [A\n  caption],\n)\n";
  expectEqual(unwrap(figure, "typst"), "Prose here.\n#figure(\n  image(\"a.png\"),\n  caption: [A\n  caption],\n)\n", "typst: a multi-line call is protected");
  const quote = "#quote[\nInside a\ncontent block.\n]\n";
  expectEqual(unwrap(quote, "typst"), "#quote[\nInside a content block.\n]\n", "typst: prose inside a content block reflows");
  expectEqual(
    unwrap("- item\n  continues\n+ enum\n  too\n/ Term: text\n  more\n", "typst"),
    "- item continues\n+ enum too\n/ Term: text more\n",
    "typst: list, enum and term items",
  );
  const raw = "```\nraw   text\nhere\n```\n";
  expectEqual(unwrap(raw, "typst"), raw, "typst: raw blocks untouched");
  const math = "$\n  x = 1\n$\n";
  expectEqual(unwrap(math, "typst"), math, "typst: multi-line math untouched");
  const inline = "Some #emph[words]\nand #link(\"https://x.org\")[a link]\ncontinue.\n";
  expectEqual(
    unwrap(inline, "typst"),
    "Some #emph[words] and #link(\"https://x.org\")[a link] continue.\n",
    "typst: inline calls on a line are prose",
  );
  const set = "#set text(size: 11pt)\nProse.\n";
  expectEqual(unwrap(set, "typst"), set, "typst: #set lines are protected");
}

// AsciiDoc
expectEqual(unwrap("one\ntwo\nthree\n", "asciidoc"), "one two three\n", "asciidoc: a paragraph unwraps");
expectEqual(
  unwrap("line one +\nline two\nline three\n", "asciidoc"),
  "line one +\nline two line three\n",
  "asciidoc: a trailing + hard break is kept",
);
{
  const hard = "[%hardbreaks]\nkeep\nthese\nlines\n";
  expectEqual(unwrap(hard, "asciidoc"), hard, "asciidoc: [%hardbreaks] paragraph is protected");
  const doc = "= Title\n:hardbreaks-option:\n\nkeep\nlines\n";
  expectEqual(unwrap(doc, "asciidoc"), doc, "asciidoc: document hardbreaks option protects everything");
  const verse = "[verse]\nRoses are red\nviolets are blue\n";
  expectEqual(unwrap(verse, "asciidoc"), verse, "asciidoc: a [verse] paragraph is protected");
  const source = "[source,python]\nprint(1)\nprint(2)\n";
  expectEqual(unwrap(source, "asciidoc"), source, "asciidoc: a [source] paragraph is protected");
  const literal = " indented literal\n paragraph\n";
  expectEqual(unwrap(literal, "asciidoc"), literal, "asciidoc: an indented literal paragraph is protected");
  const listing = "Text\nabove.\n\n----\ncode\n  stays\n----\n";
  expectEqual(unwrap(listing, "asciidoc"), "Text above.\n\n----\ncode\n  stays\n----\n", "asciidoc: listing untouched");
  expectEqual(
    unwrap("====\nExample\nprose.\n====\n", "asciidoc"),
    "====\nExample prose.\n====\n",
    "asciidoc: prose inside an example block reflows",
  );
  expectEqual(
    unwrap("* first\nitem\n* second\n. ordered\nstep\n", "asciidoc"),
    "* first item\n* second\n. ordered step\n",
    "asciidoc: list items",
  );
  expectEqual(
    unwrap("NOTE: An admonition\nparagraph.\n", "asciidoc"),
    "NOTE: An admonition paragraph.\n",
    "asciidoc: admonition paragraph",
  );
  expectEqual(
    unwrap("CPU:: The central\nprocessing unit.\n", "asciidoc"),
    "CPU:: The central processing unit.\n",
    "asciidoc: description list item",
  );
  const title = ".Block title\nParagraph\ntext.\n";
  expectEqual(unwrap(title, "asciidoc"), ".Block title\nParagraph text.\n", "asciidoc: block title stays");
  for (const [label, word] of [
    ["a block title", ".Note"],
    ["an attribute entry", ":attr:"],
    ["a description term", "term::"],
    ["an admonition", "NOTE:"],
    ["an ordered item", "1."],
  ]) {
    const out = wrap(`aaaa bbbb ${word} cccc dddd\n`, "asciidoc", 10);
    const bad = linesOf(out).slice(1).some((line) => line.trimStart().startsWith(word));
    check(!bad, `asciidoc: wrap never starts a line with ${label}`, out);
    if (!bad) pass(`asciidoc: wrap never starts a line with ${label}`);
  }
  // `--` alone on a line opens an open block; `-- text` is ordinary text.
  const open = wrap("aaaa bbbb cccc --\n", "asciidoc", 10);
  const delimiter = linesOf(open).some((line) => line.trim() === "--");
  check(!delimiter, "asciidoc: wrap never leaves -- alone on a line", open);
  if (!delimiter) pass("asciidoc: wrap never leaves -- alone on a line");
}

// Selection scope and cursor.
{
  const text = "first\nparagraph\n\nsecond\nparagraph\n";
  const atCursor = run(text, "markdown", "unwrap", 80, [{ from: 18, to: 18 }]).text;
  expectEqual(atCursor, "first\nparagraph\n\nsecond paragraph\n", "scope: the cursor's paragraph only");
  const nothing = run(text, "markdown", "unwrap", 80, [{ from: 16, to: 16 }]);
  check(nothing.result.paragraphs === 0, "scope: a blank line selects no paragraph");
  const note = run("```\na\nb\n```\n", "markdown", "unwrap", 80, [{ from: 5, to: 5 }]);
  check(note.result.paragraphs === 0, "scope: a fence selects no paragraph");
  const hard = run("[%hardbreaks]\nkeep\nthese\n", "asciidoc", "unwrap", 80, [{ from: 16, to: 16 }]);
  check(
    hard.result.skipped.some((entry) => /hardbreaks/.test(entry.reason)),
    "scope: a protected paragraph reports why",
  );
  pass("scope checks");
}

// Width measurement.
check(displayWidth("abc") === 3, "width: ASCII");
check(displayWidth("日本") === 4, "width: CJK counts two columns");
check(displayWidth("\tx", 0, 4) === 5, "width: tab advances to the next stop");
expectEqual(unwrap("日本語の\n文章です\n", "markdown"), "日本語の 文章です\n", "width: CJK lines join with the newline's space");

// ---------------------------------------------------------------------------
console.log("\n=== corpus invariants ===");

function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) collect(path, out);
    else if (LANGUAGES[extname(name)]) out.push(path);
  }
  return out;
}
const corpus = [...collect("samples"), "README.md", "docs/guide.md"];

/** Structure: the non-text lines, in order, as the classifier sees them. */
function structure(text, language) {
  const infos = reflowDialect(language).classify(text);
  const lines = linesOf(text);
  return infos.map((info, index) => (info.kind === "text" ? "¶" : `${info.kind}:${lines[index]}`)).join("\n")
    .replace(/(?:¶\n?)+/g, "¶\n");
}
/** Words: all text, whitespace-collapsed. */
// Markdown quote markers are line prefixes, repeated per line, not words.
const words = (text, language) =>
  (language === "markdown" ? text.replace(/^[ \t>]*/gm, "") : text).replace(/\s+/g, " ").trim();


async function asciidocHtml(text) {
  const html = await asciidoctor.convert(text, { safe: "secure", standalone: false });
  // Whitespace inside <pre> is content; elsewhere a newline is a space.
  return html
    .split(/(<pre[\s\S]*?<\/pre>)/)
    .map((part, index) => (index % 2 ? part : part.replace(/\s+/g, " ")))
    .join("")
    .replace(/> </g, "><");
}

function markdownSignature(text) {
  const tree = markdownLanguage.parser.parse(text);
  const parts = [];
  tree.iterate({
    enter(node) {
      parts.push(node.name);
      if (node.name === "Paragraph" || node.name === "Task") {
        parts.push(words(text.slice(node.from, node.to).replace(/^[ \t>]*/gm, "")));
        return false;
      }
    },
  });
  return parts.join("|");
}

function latexSignature(text) {
  // A comment eats its newline; everywhere else a newline inside a paragraph
  // is a space and a blank line is a paragraph break.
  return linesOf(text)
    .map((line) => {
      const at = commentStart(line);
      return at < 0 ? `${line}\n` : `${line.slice(0, at)}\u0000${line.slice(at)}\u0000`;
    })
    .join("")
    .replace(/\n[ \t]*\n\s*/g, "¶")
    .replace(/[ \t\n]+/g, " ")
    .replace(/ ?\u0000 ?/g, "\u0000");
}

for (const path of corpus) {
  const language = LANGUAGES[extname(path)];
  const source = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  let ok = true;
  const unwrapped = unwrap(source, language);
  ok &&= check(unwrap(unwrapped, language) === unwrapped, `${path}: unwrap is idempotent`);
  ok &&= check(structure(unwrapped, language) === structure(source, language), `${path}: unwrap keeps structure`);
  ok &&= check(words(unwrapped, language) === words(source, language), `${path}: unwrap keeps every word`);
  for (const column of [40, 80, 100]) {
    const wrapped = wrap(source, language, column);
    ok &&= check(wrap(wrapped, language, column) === wrapped, `${path}: wrap ${column} is idempotent`);
    ok &&= check(unwrap(wrapped, language) === unwrapped, `${path}: unwrap(wrap ${column}) equals unwrap`);
    ok &&= check(
      structure(wrapped, language) === structure(source, language),
      `${path}: wrap ${column} keeps structure`,
      diffLine(structure(source, language), structure(wrapped, language)),
    );
    ok &&= check(words(wrapped, language) === words(source, language), `${path}: wrap ${column} keeps every word`);
    if (language === "markdown") {
      ok &&= check(markdownSignature(wrapped) === markdownSignature(source), `${path}: wrap ${column} keeps the Markdown tree`,
        diffLine(markdownSignature(source).split("|").join("\n"), markdownSignature(wrapped).split("|").join("\n")));
    }
    if (language === "latex") {
      ok &&= check(latexSignature(wrapped) === latexSignature(source), `${path}: wrap ${column} keeps the LaTeX tokens`,
        diffLine(latexSignature(source).replace(/¶/g, "\n"), latexSignature(wrapped).replace(/¶/g, "\n")));
    }
    if (language === "asciidoc") {
      { const [a, b] = [await asciidocHtml(source), await asciidocHtml(wrapped)]; ok &&= check(a === b, `${path}: wrap ${column} keeps the Asciidoctor HTML`,
        diffLine(a.replace(/></g, ">\n<"), b.replace(/></g, ">\n<"))); }
    }
  }
  if (language === "markdown") ok &&= check(markdownSignature(unwrapped) === markdownSignature(source), `${path}: unwrap keeps the Markdown tree`);
  if (language === "latex") ok &&= check(latexSignature(unwrapped) === latexSignature(source), `${path}: unwrap keeps the LaTeX tokens`);
  if (language === "asciidoc") ok &&= check((await asciidocHtml(unwrapped)) === (await asciidocHtml(source)), `${path}: unwrap keeps the Asciidoctor HTML`);
  if (ok) pass(`${path} (${language})`);
}

function diffLine(a, b) {
  const left = a.split("\n");
  const right = b.split("\n");
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return `first difference at ${index}: ${JSON.stringify(left[index])} vs ${JSON.stringify(right[index])}`;
  }
  return "";
}

console.log(`\n${passes} checks passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
