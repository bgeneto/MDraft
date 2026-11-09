//! Pin the no-SyncTeX compilation contract and the chosen LuaLaTeX engine.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { latexBuildFailed } from "../src/latex.ts";
const adapter = readFileSync("src/latex.ts", "utf8");
const compile = adapter.slice(adapter.indexOf("export async function compileLatex"));
assert.match(compile, /engine:\s*["']lualatex["']/);
assert.doesNotMatch(
  compile,
  /wasmtex\/synctex|SynctexParser|synctexData|postMessageWithResponse|\\synctex=1/i,
);
assert.match(compile, /sources:\s*Object\.entries\(files\)/);
assert.match(compile, /mainFile:\s*snapshot\.mainFile/);
assert.match(readFileSync("samples/latex-project/main.tex", "utf8"), /\\usepackage\{fontspec\}/);
const pdf = new Uint8Array([37, 80, 68, 70]);
assert.equal(
  latexBuildFailed({
    success: true,
    pdf,
    errors: [{ severity: "warning", message: "There were undefined references." }],
  }),
  false,
);
assert.equal(
  latexBuildFailed({
    success: true,
    pdf,
    errors: [{ severity: "error", message: "Undefined control sequence." }],
  }),
  true,
);
assert.equal(latexBuildFailed({ success: false, pdf, errors: [] }), true);
assert.equal(latexBuildFailed({ success: true, pdf: null, errors: [] }), true);
assert.equal(
  latexBuildFailed({
    success: true,
    pdf,
    errors: [],
    telemetry: { diagnostics: [{ severity: "error", message: "Failed." }] },
  }),
  true,
);
console.log("10/10 LaTeX adapter checks passed");
