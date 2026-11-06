//! Regressions for LuaLaTeX SyncTeX geometry and ambiguous source ownership.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SynctexParser } from "wasmtex/synctex";
import { latexSourceAt, validateLatexReferences } from "../src/latex.ts";

const parser = new SynctexParser();
const mapping = await parser.parse(await readFile("samples/latex-poc/expected.synctex.gz"));
const result = { parser, mapping, files: new Set(["main.tex", "chapters/intro.tex"]) };

assert.equal(parser.forwardLookupDetailed(mapping, "main.tex", 8)?.match, "exact");
assert.equal(parser.forwardLookupDetailed(mapping, "chapters/intro.tex", 1)?.match, "exact");
assert.deepEqual(latexSourceAt(result, 1, 215, 170), { file: "main.tex", line: 8 });
assert.deepEqual(latexSourceAt(result, 1, 215, 294), {
  file: "chapters/intro.tex",
  line: 1,
});
assert.equal(latexSourceAt(result, 1, 215, 263), null);
assert.equal(latexSourceAt(result, 1, 10, 10), null);
assert.equal(latexSourceAt(result, 2, 215, 294), null);

const files = new Set(["main.tex", "chapters/intro.tex", "references.bib", "figures/a.png"]);
validateLatexReferences(
  new Map([
    [
      "main.tex",
      String.raw`\input{chapters/intro}
\includegraphics{figures/a}
\bibliography{references}
% \input{ignored}`,
    ],
  ]),
  files,
);
assert.throws(
  () => validateLatexReferences(new Map([["main.tex", String.raw`\input{../outside}`]]), files),
  /unsafe/,
);
assert.throws(
  () => validateLatexReferences(new Map([["main.tex", String.raw`\input{missing}`]]), files),
  /Missing project file/,
);
assert.throws(
  () => validateLatexReferences(new Map([["main.tex", String.raw`\input{\dynamic}`]]), files),
  /non-literal/,
);
assert.throws(
  () =>
    validateLatexReferences(new Map([["main.tex", String.raw`\includegraphics{missing}`]]), files),
  /Missing project file/,
);
assert.throws(
  () =>
    validateLatexReferences(new Map([["main.tex", String.raw`\input{\dynamic{nested}}`]]), files),
  /non-literal/,
);
validateLatexReferences(
  new Map([
    ["main.tex", "ok"],
    ["unused.tex", String.raw`\input{missing}`],
  ]),
  files,
);
console.log("14/14 LuaLaTeX SyncTeX and project-reference checks passed");
