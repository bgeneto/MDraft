//! Pin the no-SyncTeX compilation contract and the chosen LuaLaTeX engine.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const adapter = readFileSync("src/latex.ts", "utf8");
const compile = adapter.slice(adapter.indexOf("export async function compileLatex"));
assert.match(compile, /engine:\s*["']lualatex["']/);
assert.doesNotMatch(
  compile,
  /wasmtex\/synctex|SynctexParser|synctexData|postMessageWithResponse|\\synctex=1/i,
);
assert.match(compile, /sources:\s*Object\.entries\(files\)/);
assert.match(compile, /mainFile:\s*snapshot\.mainFile/);
assert.match(readFileSync("samples/latex-poc/main.tex", "utf8"), /\\usepackage\{fontspec\}/);
console.log("5/5 no-SyncTeX adapter checks passed");
