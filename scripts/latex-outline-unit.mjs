// Unit checks for the LaTeX outline.
//
//   node scripts/latex-outline-unit.mjs
//
// No application: `src/latex-outline.ts` imports only the literal-region masker,
// so Node strips the types and runs the module directly.
//
// What it is for: the Outline panel is a source scan, and a `\section` that a
// document *shows* inside `\verb` or a verbatim block is sample text, not
// structure. The shipped LaTeX Reference demonstrates every command it
// documents, so without the masking the outline grew a heading for each one —
// four phantom rows between "Headings and text" and "Mathematics", which is what
// the screenshot that prompted this suite showed. The regression is pinned here
// against the real fixture, and the rule is then exercised on its own.

import { readFileSync } from "node:fs";
import { extractLatexHeadings } from "../src/latex-outline.ts";

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

/** The heading texts, in order, for a source string. */
function texts(source) {
  return extractLatexHeadings(source).map((heading) => heading.text);
}

console.log("=== the shipped LaTeX Reference ===");
{
  // The regression this file exists for. Every `\section` in the reference is a
  // real heading; the ones it *demonstrates* are inside `\verb` and must not be.
  const source = readFileSync("samples/latex-reference.tex", "utf8");
  const headings = extractLatexHeadings(source);
  const names = headings.map((heading) => heading.text);

  const expected = [
    "LaTeX Reference",
    "Introduction",
    "Headings and text",
    "Mathematics",
    "Lists and tables",
    "Quotes and verbatim",
    "Links, references and citations",
    "Including other files",
    "Exporting",
    "Completion",
    "When something fails",
  ];
  check(
    JSON.stringify(names) === JSON.stringify(expected),
    "the outline is exactly the document's own headings, in order",
    names.join(" | "),
  );

  // The four phantom rows the screenshot showed, named so a future failure says
  // which command leaked rather than only that a count changed.
  for (const phantom of ["...", "..", "."]) {
    check(!names.includes(phantom), `no phantom "${phantom}" heading from a \\verb example`);
  }
  check(
    !names.some((name) => name.includes("\\")),
    "no heading text still carries a command",
    names.filter((name) => name.includes("\\")).join(" | ") || "none",
  );

  // The line numbers are what the panel jumps to, and masking must not move them.
  const introduction = headings.find((heading) => heading.text === "Introduction");
  check(
    introduction?.line === 23,
    "a heading keeps its real source line",
    String(introduction?.line),
  );
  const last = headings[headings.length - 1];
  check(last.line === 171, "the last heading keeps its real source line", String(last.line));
  check(
    headings.every((heading, index) => index === 0 || heading.line > headings[index - 1].line),
    "the headings are in source order",
  );
}

console.log("\n=== literal regions are not headings ===");
{
  const cases = [
    ["\\verb|\\section{Not A Heading}|", "a \\verb argument"],
    ["\\verb*|\\section{Not A Heading}|", "a \\verb* argument"],
    ["\\verb!\\subsection{Not A Heading}! after", "a \\verb with a punctuation delimiter"],
    ["\\lstinline|\\section{Not A Heading}|", "a \\lstinline argument"],
    ["\\lstinline[language=TeX]|\\section{Not A Heading}|", "a \\lstinline with options"],
    ["\\mintinline{tex}|\\section{Not A Heading}|", "a \\mintinline argument"],
    ["\\mintinline{tex}{\\section{Not A Heading}}", "a \\mintinline brace argument"],
  ];
  for (const [source, label] of cases) {
    check(
      texts(source).length === 0,
      `${label} is not a heading`,
      texts(source).join(" | ") || "none",
    );
  }
}

console.log("\n=== verbatim bodies are not headings ===");
{
  for (const environment of [
    "verbatim",
    "verbatim*",
    "Verbatim",
    "lstlisting",
    "minted",
    "alltt",
  ]) {
    const source =
      environment === "minted"
        ? `\\begin{minted}{tex}\n\\section{Not A Heading}\n\\end{minted}`
        : `\\begin{${environment}}\n\\section{Not A Heading}\n\\end{${environment}}`;
    check(
      texts(source).length === 0,
      `a ${environment} body is not a heading`,
      texts(source).join(" | ") || "none",
    );
  }
}

console.log("\n=== dead code is not a heading ===");
{
  check(
    texts("\\iffalse\n\\section{Not A Heading}\n\\fi").length === 0,
    "an \\iffalse block is not a heading",
  );
  check(
    texts("% \\section{Commented Out}").length === 0,
    "a commented-out heading is not a heading",
  );
  check(
    texts("50\\% of the page\n\\section{Real}").join("|") === "Real",
    "a heading after an escaped percent is still real",
  );
}

console.log("\n=== real headings still work ===");
{
  const source = [
    "\\title{The Document}",
    "\\section{One}",
    "\\subsection{One A}",
    "\\subsubsection{One A i}",
    "\\section*{Starred}",
    "\\paragraph{A paragraph}",
    "\\subparagraph{A subparagraph}",
    "\\chapter{A chapter}",
  ].join("\n");
  const headings = extractLatexHeadings(source);
  check(
    headings.map((heading) => heading.text).join("|") ===
      "The Document|One|One A|One A i|Starred|A paragraph|A subparagraph|A chapter",
    "every sectioning command is found, starred forms included",
    headings.map((heading) => heading.text).join("|"),
  );
  check(
    headings.map((heading) => heading.level).join(",") === "0,1,2,3,1,4,5,1",
    "the nesting follows the command",
    headings.map((heading) => heading.level).join(","),
  );

  // The optional short title is what a table of contents shows, so it wins.
  check(
    texts("\\section[Short]{A much longer title}").join("|") === "Short",
    "the optional short title wins",
  );

  // Several headings on one line, which is how a reference document often reads.
  check(
    texts("\\section{First}\\section{Second}").join("|") === "First|Second",
    "two headings on one line are both found",
  );

  // A heading whose own text contains a literal keeps that text: the literal is
  // blanked for the command scan, not for the argument the reader sees.
  check(
    texts("\\section{Passing \\verb|--flag|}").join("|") === "Passing --flag",
    "a heading containing a \\verb keeps its literal text",
    texts("\\section{Passing \\verb|--flag|}").join("|"),
  );

  // A `%` inside a literal must not be read as the start of a comment, or the
  // heading after it on the same line would be lost.
  check(
    texts("\\verb|50%| and \\section{Real}").join("|") === "Real",
    "a percent inside a literal does not comment out the rest of the line",
    texts("\\verb|50%| and \\section{Real}").join("|"),
  );

  // The argument's extent is measured on the masked line, so an unbalanced brace
  // shown inside a literal cannot run the heading on into the next one. The
  // literal's own text keeps the brace; the argument's closing brace does not.
  check(
    texts("\\section{Passing \\verb|{|}\\section{Second}").join("|") === "Passing {|Second",
    "a brace inside a literal does not unbalance the argument",
    texts("\\section{Passing \\verb|{|}\\section{Second}").join("|"),
  );

  // The short title is cleaned like any other heading text.
  check(
    texts("\\section[\\verb|a|]{Long}").join("|") === "a",
    "a short title is cleaned like the long one",
    texts("\\section[\\verb|a|]{Long}").join("|"),
  );
}

console.log("\n=== an empty document offers nothing ===");
{
  check(extractLatexHeadings("").length === 0, "an empty source has no headings");
  check(
    extractLatexHeadings("\\documentclass{article}\n\\begin{document}\n\\end{document}").length ===
      0,
    "a document with no sections has no headings",
  );
  check(
    extractLatexHeadings("\\section{}").length === 0,
    "an empty heading argument is skipped rather than listed blank",
  );
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
