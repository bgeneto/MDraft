// Unit checks for the project-wide LaTeX outline (Track W2).
//
//   node scripts/latex-outline-project-unit.mjs
//
// Headings follow document order across \input/\include, names resolve with
// `.tex` implied, commented or verbatim includes are ignored, and a cycle or a
// missing file cannot hang or break the outline. No application.

import { projectLatexOutline } from "../src/latex-outline.ts";

const checks = [];
function check(ok, label, detail = "") {
  checks.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
const bs = "\\";
const sources = new Map([
  [
    "main.tex",
    [
      `${bs}documentclass{book}`,
      `${bs}begin{document}`,
      `${bs}chapter{Introduction}`,
      `${bs}include{chapters/one}`,
      `% ${bs}include{chapters/commented}`,
      `${bs}section{Between}`,
      `${bs}input{chapters/two.tex}`,
      `${bs}begin{verbatim}`,
      `${bs}input{chapters/shown}`,
      `${bs}end{verbatim}`,
      `${bs}include{chapters/missing}`,
      `${bs}end{document}`,
    ].join("\n"),
  ],
  ["chapters/one.tex", `${bs}chapter{One}\n${bs}section{One A}\n${bs}input{chapters/nested}`],
  ["chapters/nested.tex", `${bs}subsection{Nested}`],
  ["chapters/two.tex", `${bs}chapter{Two}\n${bs}input{main}`],
  ["chapters/commented.tex", `${bs}chapter{Commented}`],
  ["chapters/shown.tex", `${bs}chapter{Shown}`],
]);
const outline = projectLatexOutline("main.tex", sources);
const order = outline.map((h) => h.text);
check(
  JSON.stringify(order) ===
    JSON.stringify(["Introduction", "One", "One A", "Nested", "Between", "Two"]),
  "headings follow document order across includes",
  JSON.stringify(order),
);
check(
  outline.find((h) => h.text === "Nested")?.file === "chapters/nested.tex",
  "each heading names its file",
);
check(outline.find((h) => h.text === "One A")?.line === 2, "each heading keeps its own line");
check(!order.includes("Commented"), "a commented include is ignored");
check(!order.includes("Shown"), "an include shown in verbatim is ignored");
check(
  order.filter((t) => t === "Introduction").length === 1,
  "an include cycle does not repeat or hang",
);
check(
  projectLatexOutline("absent.tex", sources).length === 0,
  "a missing main file gives an empty outline",
);

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
