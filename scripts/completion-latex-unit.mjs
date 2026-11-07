// Unit checks for the LaTeX completion catalog and context table.
//
//   node scripts/completion-latex-unit.mjs
//
// Both modules are pure data and pure functions, so this runs without an
// application, a DOM or a parser. The CDP suite proves the popup opens in the
// real editor; this pins what it offers and — just as important — the positions
// where it must offer nothing.

import { latexCatalog, LATEX_ENVIRONMENT_NAMES, LATEX_PACKAGE_NAMES, LATEX_CLASS_NAMES } from "../src/completion/latex-catalog.ts";
import { filterByPrefix, latexContextAt } from "../src/completion/latex-context.ts";
import { bibliographyKeys, projectReferences } from "../src/completion/project-index.ts";
import {
  LATEX_ALIGN,
  LATEX_CODE,
  LATEX_DISPLAY_MATH,
  LATEX_QUOTE,
  LATEX_RULE,
  LATEX_TABLE,
  LATEX_TOC,
  latexInline,
} from "../src/latex-commands.ts";

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

console.log("=== the catalog ===");
{
  const rows = latexCatalog();
  check(rows.length > 100, "the catalog is substantial", `${rows.length} rows`);

  const labels = rows.map((row) => row.label);
  // The same name may appear in two sections — `tabularx` is both an environment
  // and a package — but never twice in one section, which reads as a bug.
  const keys = rows.map((row) => `${row.section}\u0000${row.label}`);
  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
  check(
    duplicates.length === 0,
    "no row appears twice in one section",
    duplicates.length ? [...new Set(duplicates)].map((k) => k.split("\u0000")[1]).join(", ") : "none",
  );

  // Every row needs a section, or the popup renders it under an empty heading.
  check(
    rows.every((row) => typeof row.section === "string" && row.section.length > 0),
    "every row has a section",
  );
  // And a detail, except for the snippets whose label is the whole construct.
  check(
    rows.every((row) => typeof row.detail === "string"),
    "every row has a detail string",
  );

  for (const command of ["\\section", "\\begin", "\\usepackage", "\\includegraphics", "\\cite", "\\frac"]) {
    check(labels.includes(command), `the catalog offers ${command}`);
  }
  for (const env of ["itemize", "equation", "tabular", "figure"]) {
    check(LATEX_ENVIRONMENT_NAMES.includes(env), `the catalog offers the ${env} environment`);
  }
  for (const pkg of ["amsmath", "graphicx", "hyperref"]) {
    check(LATEX_PACKAGE_NAMES.includes(pkg), `the catalog offers the ${pkg} package`);
  }
  for (const cls of ["article", "report", "book"]) {
    check(LATEX_CLASS_NAMES.includes(cls), `the catalog offers the ${cls} class`);
  }
}

console.log("\n=== snippets match what the Format menu inserts ===");
{
  // The rule from the plan: typing the construct and choosing it from Format
  // must produce the same bytes, so the two routes cannot disagree.
  const rows = latexCatalog();
  const labels = rows.map((row) => row.label);

  check(labels.includes(LATEX_RULE), "the rule snippet is the Format menu's string");
  check(labels.includes(LATEX_TOC), "the table-of-contents snippet is the Format menu's string");

  // The table snippet is the Format constant with a tab stop in the header.
  const table = rows.find((row) => row.detail === "table");
  check(Boolean(table), "a table snippet exists");
  if (table) {
    check(table.snippet === true, "the table snippet is a snippet");
    check(
      table.label.includes(LATEX_TABLE.text.split("\n")[0]),
      "the table snippet opens with the Format menu's first line",
      table.label.split("\n")[0],
    );
    check(
      table.label.includes("\\end{table}"),
      "the table snippet closes the table environment",
    );
  }

  // The block constructs reuse the Format constants' delimiters. Most are
  // `LatexInsertion` objects; `LATEX_DISPLAY_MATH` is a bare string, so both
  // shapes are normalised here rather than special-cased at each use.
  const bodyOf = (constant) => (typeof constant === "string" ? constant : constant.text);
  for (const [detail, constant] of [
    ["quote", LATEX_QUOTE],
    ["verbatim code", LATEX_CODE],
    ["aligned equations", LATEX_ALIGN],
    ["display mathematics", LATEX_DISPLAY_MATH],
  ]) {
    const row = rows.find((entry) => entry.detail === detail);
    check(Boolean(row), `a ${detail} snippet exists`);
    if (row) {
      const first = bodyOf(constant).split("\n")[0];
      check(
        row.label.startsWith(first),
        `the ${detail} snippet starts with the Format menu's opener`,
        row.label.split("\n")[0],
      );
    }
  }

  // Inline wrappers come from `latexInline`, so the delimiters agree too.
  const bold = latexInline("bold");
  const boldRow = rows.find((row) => row.detail === "strong text");
  check(Boolean(boldRow), "a strong-text snippet exists");
  if (boldRow) {
    check(
      boldRow.label.startsWith(bold.before) && boldRow.label.endsWith(bold.after),
      "the strong-text snippet uses latexInline's delimiters",
      boldRow.label,
    );
  }
}

console.log("\n=== snippets use real newlines, not escapes ===");
{
  // `Snippet.parse` splits a template on real newlines. A `\n` written as two
  // characters would be inserted literally and produce a broken document.
  const rows = latexCatalog().filter((row) => row.snippet);
  const escaped = rows.filter((row) => row.label.includes("\\n"));
  check(
    escaped.length === 0,
    "no snippet carries a literal backslash-n",
    escaped.length ? escaped.map((row) => row.detail).join(", ") : "none",
  );
  // And the multi-line ones really do span lines.
  const multiline = rows.filter((row) => row.label.includes("\n"));
  check(multiline.length > 0, "multi-line snippets contain real newlines", `${multiline.length} rows`);
}

console.log("\n=== the context table offers the right catalog ===");
{
  const at = (text) => latexContextAt(text, text.length);

  check(at("\\sec").kind === "command" && at("\\sec").prefix === "sec", "a partial command is a command context");
  check(at("\\").kind === "command" && at("\\").prefix === "", "a bare backslash offers every command");
  check(at("\\begin{ite").kind === "environment" && at("\\begin{ite").prefix === "ite", "inside \\begin{} is an environment context");
  check(at("\\end{ite").kind === "environment", "inside \\end{} is an environment context too");
  check(at("\\usepackage{ams").kind === "package" && at("\\usepackage{ams").prefix === "ams", "inside \\usepackage{} is a package context");
  check(at("\\usepackage[utf8]{ams").kind === "package", "an optional argument does not hide the package name");
  check(at("\\documentclass{art").kind === "class", "inside \\documentclass{} is a class context");
  check(at("\\ref{sec:").kind === "label", "inside \\ref{} is a label context");
  check(at("\\eqref{").kind === "label", "inside \\eqref{} is a label context");
  check(at("\\cite{knu").kind === "citation", "inside \\cite{} is a citation context");
  check(at("\\includegraphics{fig").kind === "image", "inside \\includegraphics{} is an image context");
  check(at("\\includegraphics[width=2cm]{fig").kind === "image", "an option does not hide the image path");
}

console.log("\n=== the context table offers nothing where nothing can follow ===");
{
  const at = (text) => latexContextAt(text, text.length);

  check(at("Some prose.").kind === "none", "prose offers nothing");
  check(at("A sentence with a \\section{prose} in it").kind === "none", "a closed command offers nothing");
  check(at("% a comment with \\sec").kind === "none", "a comment offers nothing");
  check(at("% a comment\n\\sec").kind === "command", "the line after a comment offers commands again");
  check(at("50\\% of the time \\sec").kind === "command", "an escaped percent does not start a comment");
  check(at("\\\\sec").kind === "none", "a line break followed by letters is not a command");
  check(
    at("\\begin{verbatim}\n\\sec").kind === "none",
    "a verbatim body offers nothing",
  );
  check(
    at("\\begin{verbatim}\n\\sec\n\\end{verbatim}\n\\sec").kind === "command",
    "the line after a verbatim body offers commands again",
  );
  check(
    at("\\begin{lstlisting}\n\\section{x}").kind === "none",
    "a listing body offers nothing",
  );
}

console.log("\n=== prefix filtering ===");
{
  const entries = [{ label: "section" }, { label: "subsection" }, { label: "sqrt" }, { label: "Section" }];
  check(filterByPrefix(entries, "s").length === 4, "a one-letter prefix matches all", String(filterByPrefix(entries, "s").length));
  check(filterByPrefix(entries, "sec").length === 2, "a prefix narrows the list", String(filterByPrefix(entries, "sec").length));
  check(filterByPrefix(entries, "SEC").length === 2, "filtering ignores case");
  check(filterByPrefix(entries, "zzz").length === 0, "no match yields an empty list");
  check(filterByPrefix(entries, "").length === 4, "an empty prefix keeps everything");
}

console.log("\n=== project references ===");
{
  const sources = new Map([
    [
      "main.tex",
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{Introduction}\\label{sec:intro}",
        "See \\ref{sec:intro} and \\eqref{eq:main}.",
        "\\begin{equation}\\label{eq:main} x = 1 \\end{equation}",
        "As shown in \\cite{knuth84,lamport94} and \\citep{knuth84}.",
        "\\includegraphics[width=2cm]{figures/plot}",
        "% \\label{commented:out} must not appear",
        "50\\% of \\label{after:percent} is real",
        "\\end{document}",
      ].join("\n"),
    ],
    ["chapter.tex", "\\label{sec:chapter}\n\\cite{extra2020}"],
  ]);

  const refs = projectReferences(sources);
  check(refs.labels.includes("sec:intro"), "a label is found");
  check(refs.labels.includes("eq:main"), "an equation label is found");
  check(refs.labels.includes("sec:chapter"), "a label in another file is found");
  check(refs.labels.includes("after:percent"), "a label after an escaped percent is real");
  check(!refs.labels.includes("commented:out"), "a commented-out label is not offered");
  // Order is document order, which is the order a reader expects.
  check(refs.labels[0] === "sec:intro", "labels keep document order", refs.labels.join(", "));
  // No duplicates even though `\ref{sec:intro}` also names it.
  check(
    refs.labels.filter((label) => label === "sec:intro").length === 1,
    "a label appears once",
  );

  check(refs.citations.includes("knuth84"), "a citation key is found");
  check(refs.citations.includes("lamport94"), "a comma-separated citation key is found");
  check(refs.citations.includes("extra2020"), "a citation in another file is found");
  check(
    refs.citations.filter((key) => key === "knuth84").length === 1,
    "a citation repeated across commands appears once",
  );

  check(refs.images.includes("figures/plot"), "an image path is found");
  check(refs.images.length === 1, "only one image is offered", String(refs.images.length));

  // An empty project offers nothing rather than throwing.
  const empty = projectReferences(new Map());
  check(
    empty.labels.length === 0 && empty.citations.length === 0 && empty.images.length === 0,
    "an empty project offers nothing",
  );
}

console.log("\n=== bibliography keys ===");
{
  const bib = new Map([
    [
      "references.bib",
      [
        "@article{knuth84,",
        "  author = {Donald Knuth},",
        "  title = {Literate Programming},",
        "}",
        "@book{lamport94, author = {Leslie Lamport}}",
        "@misc{knuth84, note = {duplicate}}",
      ].join("\n"),
    ],
  ]);
  const keys = bibliographyKeys(bib);
  check(keys.includes("knuth84"), "a bib key is found");
  check(keys.includes("lamport94"), "a second bib key is found");
  check(keys.filter((key) => key === "knuth84").length === 1, "a duplicate bib key appears once");
  check(bibliographyKeys(new Map()).length === 0, "an empty bibliography offers nothing");
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
