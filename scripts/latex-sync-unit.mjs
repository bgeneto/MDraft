//! LaTeX project reference safety, independent of PDF correspondence.
import assert from "node:assert/strict";
import { validateLatexReferences } from "../src/latex.ts";

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
console.log("14/14 LuaLaTeX project-reference checks passed");
