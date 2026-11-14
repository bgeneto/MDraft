//! Stage 6.2: which bundled engine compiles a project, and why
//! (docs/plans/2026-11-12-latex-compile-cost.md). App-free; Node 24 strips the types.
import assert from "node:assert/strict";
import {
  detectTexEngine,
  engineMismatch,
  magicProgram,
  resolveTexEngine,
} from "../src/latex-engine-choice.ts";

const B = String.fromCharCode(92);
let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`PASS  ${name}`);
};
const doc = (preamble, body = "Hello.") =>
  `${B}documentclass{article}\n${preamble}\n${B}begin{document}\n${body}\n${B}end{document}\n`;

check("the magic comment is read in its common spellings", () => {
  assert.equal(magicProgram("% !TeX program = pdflatex\n"), "pdflatex");
  assert.equal(magicProgram("%!TEX TS-program = xelatex\n"), "xelatex");
  assert.equal(magicProgram("% !tex program=LuaLaTeX\n"), "lualatex");
  assert.equal(magicProgram("% !TeX program = context\n"), null);
  assert.equal(magicProgram("no comment"), null);
});
check("magic comment, then project, then default", () => {
  const magic = `% !TeX program = xelatex\n${doc("")}`;
  assert.deepEqual(resolveTexEngine(magic, "pdflatex", "lualatex"), {
    engine: "xelatex",
    source: "magic",
    reason: "magic comment",
  });
  assert.deepEqual(resolveTexEngine(doc(""), "pdflatex", "lualatex"), {
    engine: "lualatex",
    source: "project",
    reason: "project (pdfLaTeX is not available; LuaLaTeX used)",
  });
  const pdfMagic = resolveTexEngine(`% !TeX program = pdflatex\n${doc("")}`, null, null);
  assert.equal(pdfMagic.engine, "lualatex");
  assert.match(pdfMagic.reason, /pdfLaTeX is not available/);
  assert.equal(resolveTexEngine(doc(""), null, "lualatex").engine, "lualatex");
  assert.equal(resolveTexEngine(doc(""), null, undefined).source, "auto", "an old file: detect");
});
check("auto follows the SDK's precedence", () => {
  assert.equal(detectTexEngine(doc(`${B}usepackage{luacode}`)).engine, "lualatex");
  assert.equal(detectTexEngine(doc("", `${B}directlua{tex.print(1)}`)).engine, "lualatex");
  assert.equal(detectTexEngine(doc(`${B}usepackage{xeCJK}`)).engine, "xelatex");
  assert.equal(detectTexEngine(doc(`${B}usepackage[no-math]{fontspec}`)).engine, "xelatex");
  assert.equal(detectTexEngine(doc(`${B}setmainfont{Libertinus Serif}`)).engine, "xelatex");
  assert.equal(detectTexEngine(doc(`${B}usepackage{amsmath,graphicx}`)).engine, "lualatex");
  assert.equal(
    detectTexEngine(doc(`% ${B}usepackage{fontspec}`)).engine,
    "lualatex",
    "a commented-out package is not a requirement",
  );
  assert.equal(detectTexEngine(doc("", `fontspec is mentioned in the body`)).engine, "lualatex");
});
check("only certain incompatibilities are reported", () => {
  assert.match(engineMismatch(doc(`${B}usepackage{luacode}`), "pdflatex"), /only LuaLaTeX/);
  assert.match(engineMismatch(doc(`${B}usepackage{fontspec}`), "pdflatex"), /XeLaTeX or LuaLaTeX/);
  assert.equal(engineMismatch(doc(`${B}usepackage{fontspec}`), "xelatex"), null);
  assert.equal(engineMismatch(doc(`${B}usepackage{amsmath}`), "pdflatex"), null);
  assert.equal(engineMismatch(doc(`${B}usepackage{luacode}`), "lualatex"), null);
});
console.log(`\n${passed}/4 checks passed (engine choice)`);
