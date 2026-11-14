//! Literal LaTeX word candidates must not include hidden conditional text.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { latexSourceContent, latexSourceWords } from "../src/latex-word-map.ts";

const reference = readFileSync("samples/latex-reference.tex", "utf8");
const referenceWords = latexSourceWords(reference);
const draws = referenceWords.find((word) => word.from === reference.indexOf("draws"));
assert.equal(reference.slice(draws.from, draws.to), "draws");
const heading = referenceWords.find(
  (word) => word.from === reference.indexOf("heading is a command"),
);
assert.equal(reference.slice(heading.from, heading.to), "heading");

const source = String.raw`\documentclass{article}
\newcommand{\badge}{Copper rivers follow amber bridges}
\begin{document}
Visible \textbf{bold words} after. % hidden comment
\ifnum0=1 Copper rivers \iftrue nested hidden\fi \lstinline|\fi| follow amber bridges\fi
\verb|\ifnum ignored| regular
\begin{verbatim}
\ifnum verbatim
\end{verbatim}
\badge
\end{document}`;
const words = latexSourceWords(source);
const texts = words.map((word) => word.text);
for (const expected of ["Visible", "bold", "words", "after", "regular"])
  assert.ok(texts.includes(expected), expected);
for (const hidden of ["Copper", "rivers", "nested", "hidden", "amber", "bridges", "ignored"])
  assert.ok(!texts.includes(hidden), hidden);
const literalVerbatimOffset = source.indexOf(
  "verbatim",
  source.indexOf("\\begin{verbatim}") + "\\begin{verbatim}".length,
);
assert.ok(words.some((word) => word.from === literalVerbatimOffset));
for (const word of words) assert.equal(source.slice(word.from, word.to), word.text);
assert.deepEqual(latexSourceWords(String.raw`\catcode` + " `x=12 ordinary words"), []);
const preamble = String.raw`% \begin{document}
Secret preamble words.
\begin{document}
Visible body words.
\end{document}`;
assert.ok(!latexSourceWords(preamble).some((word) => word.text === "Secret"));
assert.ok(latexSourceWords(preamble).some((word) => word.text === "Visible"));
console.log("LaTeX prose candidate checks passed");
import { buildPdfWordAnchors } from "../src/pdf-page-build.ts";
import { PdfPageMap } from "../src/pdf-page-map.ts";
const lines = [
  { text: "The preview draws the PDF the compiler produced, with the real page", region: "1:0" },
  { text: "A heading is a command", region: "1:0" },
];
const anchors = await buildPdfWordAnchors(
  "latex",
  [{ path: "main.tex", source: reference }],
  lines,
);
const map = new PdfPageMap(lines, anchors, true);
const drawsOffset = lines[0].text.indexOf("draws");
const sourceDraws = reference.indexOf("draws");
assert.deepEqual(map.sourceRange(0, drawsOffset, 0, drawsOffset + 5), {
  file: "main.tex",
  from: sourceDraws,
  to: sourceDraws + 5,
});
assert.equal(map.partsForSource("main.tex", sourceDraws, sourceDraws + 5).length, 1);
const headingOffset = reference.indexOf("A heading is a command");
assert.deepEqual(map.sourceRange(1, 0, 1, lines[1].text.length), {
  file: "main.tex",
  from: headingOffset,
  to: headingOffset + lines[1].text.length,
});
const fake = [{ text: "Copper rivers follow amber bridges", region: "1:0" }];
const falseMap = new PdfPageMap(
  fake,
  await buildPdfWordAnchors("latex", [{ path: "main.tex", source }], fake),
  true,
);
assert.equal(falseMap.sourceRange(0, 0, 0, fake[0].text.length), null);
const formattedLines = [{ text: "Visible bold words after", region: "1:0" }];
const formatted = new PdfPageMap(
  formattedLines,
  await buildPdfWordAnchors("latex", [{ path: "main.tex", source }], formattedLines),
  true,
);
const formattedRange = formatted.sourceRange(0, 0, 0, formattedLines[0].text.length);
assert.ok(formattedRange);
assert.deepEqual(
  formatted
    .sourceSegments("main.tex", formattedRange.from, formattedRange.to, source)
    .map((range) => source.slice(range.from, range.to)),
  ["Visible", "bold words", "after"],
);
const chapter = String.raw`\begin{document}A remarkable chapter contains distinct words.\end{document}`;
const chapterLines = [{ text: "A remarkable chapter contains distinct words", region: "1:0" }];
const projectMap = new PdfPageMap(
  chapterLines,
  await buildPdfWordAnchors(
    "latex",
    [
      {
        path: "main.tex",
        source: reference.replace("\\end{document}", "\\input{chapter}\n\\end{document}"),
      },
      { path: "chapter.tex", source: chapter },
    ],
    chapterLines,
  ),
  true,
);
assert.deepEqual(projectMap.sourceRange(0, 0, 0, chapterLines[0].text.length), {
  file: "chapter.tex",
  from: chapter.indexOf("A remarkable"),
  to: chapter.indexOf("words") + 5,
});
console.log("PDF word correspondence checks passed");

const unreachable = new PdfPageMap(
  chapterLines,
  await buildPdfWordAnchors(
    "latex",
    [
      { path: "main.tex", source: reference },
      { path: "chapter.tex", source: chapter },
    ],
    chapterLines,
  ),
  true,
);
assert.equal(unreachable.sourceRange(0, 0, 0, chapterLines[0].text.length), null);
const hiddenInput = String.raw`\begin{document}\ifnum0=1 \input{chapter}\fi Visible ordinary main text.\end{document}`;
const hiddenProject = new PdfPageMap(
  chapterLines,
  await buildPdfWordAnchors(
    "latex",
    [
      { path: "main.tex", source: hiddenInput },
      { path: "chapter.tex", source: chapter },
    ],
    chapterLines,
  ),
  true,
);
assert.equal(hiddenProject.sourceRange(0, 0, 0, chapterLines[0].text.length), null);

const literal = String.raw`\begin{document}
\begin{verbatim}
\section{name} is a command used in verbatim.
\end{verbatim}
\end{document}`;
const literalWords = latexSourceWords(literal);
for (const expected of ["section", "name", "command", "used", "verbatim"])
  assert.ok(
    literalWords.some((word) => word.text === expected),
    expected,
  );
for (const word of literalWords) assert.equal(literal.slice(word.from, word.to), word.text);
const literalLine = {
  text: String.raw`\section{name} is a command used in verbatim.`,
  region: "1:0",
};
const literalMap = new PdfPageMap(
  [literalLine],
  await buildPdfWordAnchors("latex", [{ path: "main.tex", source: literal }], [literalLine]),
  true,
);
const literalPdfStart = literalLine.text.indexOf("command"),
  literalSourceStart = literal.indexOf("command");
assert.deepEqual(
  literalMap.sourceRange(0, literalPdfStart, 0, literalPdfStart + "command".length),
  { file: "main.tex", from: literalSourceStart, to: literalSourceStart + 7 },
);
assert.equal(
  literalMap.partsForSource("main.tex", literalSourceStart, literalSourceStart + 7).length,
  1,
);

const mathSource = String.raw`\begin{document}
Inline $E=mc^2$ and displayed \[x+y=z\].
\end{document}`;
const mathLine = { text: "Inline E = mc2 and displayed x + y = z.", region: "1:0" };
const mathContent = latexSourceContent(mathSource);
assert.deepEqual(
  mathContent.math.map((item) => item.tokens),
  [
    ["E", "mc", "2"],
    ["x", "y", "z"],
  ],
);
const mathAnchors = await buildPdfWordAnchors(
  "latex",
  [{ path: "main.tex", source: mathSource }],
  [mathLine],
);
assert.equal(mathAnchors.filter((anchor) => anchor.atomic).length, 2);
const mathMap = new PdfPageMap([mathLine], mathAnchors, true);
const inlineStart = mathLine.text.indexOf("E"),
  inlineEnd = mathLine.text.indexOf(" and displayed");
const inlineRange = mathMap.sourceRange(0, inlineStart, 0, inlineEnd);
assert.deepEqual(inlineRange, {
  file: "main.tex",
  from: mathSource.indexOf("$E"),
  to: mathSource.indexOf("$E") + "$E=mc^2$".length,
  atomic: true,
});
const displayStart = mathLine.text.indexOf("x + y"),
  displayEnd = mathLine.text.indexOf(".", displayStart);
const displayRange = mathMap.sourceRange(0, displayStart, 0, displayEnd);
assert.deepEqual(displayRange, {
  file: "main.tex",
  from: mathSource.indexOf("\\[x"),
  to: mathSource.indexOf("\\[x") + "\\[x+y=z\\]".length,
  atomic: true,
});
assert.deepEqual(mathMap.atomicAtSource("main.tex", mathSource.indexOf("mc")), inlineRange);
assert.deepEqual(
  mathMap
    .sourceSegments("main.tex", inlineRange.from, inlineRange.to, mathSource)
    .map((range) => mathSource.slice(range.from, range.to)),
  ["$E=mc^2$"],
);

const duplicateMath = String.raw`\begin{document}$x+y=z$ and \[x+y=z\].\end{document}`;
const duplicateLine = { text: "x + y = z", region: "1:0" };
assert.equal(
  (
    await buildPdfWordAnchors(
      "latex",
      [{ path: "main.tex", source: duplicateMath }],
      [duplicateLine],
    )
  ).filter((anchor) => anchor.atomic).length,
  0,
);
const unknownMath = String.raw`\begin{document}$\customsymbol{a}+b$\end{document}`;
assert.equal(latexSourceContent(unknownMath).math.length, 0);
const referenceWithStructures = reference.replace(
  "\\end{document}",
  String.raw`\section*{PDF correspondence fixtures}
\begin{verbatim}
\section{name} is a command used in verbatim.
\end{verbatim}
Inline equation: $E=mc^2$.
\[x+y=z\]
\end{document}`,
);
const extractedLines = [
  { text: String.raw`\section{name} is a command used in verbatim.`, region: "1:0" },
  { text: "Inline equation: E = mc2.", region: "1:0" },
  { text: "x + y = z5", region: "1:0" },
];
const extractedAnchors = await buildPdfWordAnchors(
  "latex",
  [{ path: "main.tex", source: referenceWithStructures }],
  extractedLines,
);
assert.equal(extractedAnchors.filter((anchor) => anchor.atomic).length, 2);
const extractedMap = new PdfPageMap(extractedLines, extractedAnchors, true);
const inlineLineAt = extractedLines[1].text.indexOf("E"),
  inlineLineEnd = extractedLines[1].text.indexOf(".", inlineLineAt);
assert.equal(extractedMap.sourceRange(1, inlineLineAt, 1, inlineLineEnd)?.atomic, true);
const displayLineAt = extractedLines[2].text.indexOf("x"),
  displayLineEnd = extractedLines[2].text.lastIndexOf("z") + 1;
assert.equal(extractedMap.sourceRange(2, displayLineAt, 2, displayLineEnd)?.atomic, true);
const scriptMathSource = String.raw`\begin{document}$Q=7r^3$ \[\lambda+\mu=\nu\]\end{document}`;
const scriptMathLines = [
  { text: "Inline equation: Q = 7 r 3.", region: "1:0" },
  { text: "λ + µ = ν", region: "1:0" },
];
const scriptMathAnchors = await buildPdfWordAnchors(
  "latex",
  [{ path: "main.tex", source: scriptMathSource }],
  scriptMathLines,
);
assert.equal(scriptMathAnchors.filter((anchor) => anchor.atomic).length, 2);
const referenceUniqueMath = reference.replace(
  "\\end{document}",
  String.raw`
Inline equation: $Q=7r^3$.
\[\lambda+\mu=\nu\]
\end{document}`,
);
const referenceUniqueLines = [
  { text: "Inline equation: Q = 7 r3.", region: "5:0" },
  { text: "λ + µ = ν", region: "5:0" },
];
const referenceUniqueAnchors = await buildPdfWordAnchors(
  "latex",
  [{ path: "main.tex", source: referenceUniqueMath }],
  referenceUniqueLines,
);
assert.equal(referenceUniqueAnchors.filter((anchor) => anchor.atomic).length, 2);
const splitScriptSource = String.raw`\begin{document}Inline equation: $Q=7r^3$.\end{document}`;
const splitScriptLines = [
  { text: "Inline equation: Q = 7 r", region: "5:0" },
  { text: "3", region: "5:0" },
];
const splitScriptAnchors = await buildPdfWordAnchors(
  "latex",
  [{ path: "main.tex", source: splitScriptSource }],
  splitScriptLines,
);
assert.equal(splitScriptAnchors.filter((anchor) => anchor.atomic).length, 2);
const splitScriptMap = new PdfPageMap(splitScriptLines, splitScriptAnchors, true);
const equationStart = splitScriptLines[0].text.indexOf("Q"),
  scriptEnd = splitScriptLines[1].text.length;
assert.deepEqual(splitScriptMap.sourceRange(0, equationStart, 1, scriptEnd), {
  file: "main.tex",
  from: splitScriptSource.indexOf("$Q"),
  to: splitScriptSource.indexOf("$Q") + "$Q=7r^3$".length,
  atomic: true,
});
const ambiguousSplitScript = await buildPdfWordAnchors(
  "latex",
  [{ path: "main.tex", source: splitScriptSource }],
  [splitScriptLines[0], { text: "3 3", region: "5:0" }],
);
assert.equal(ambiguousSplitScript.filter((anchor) => anchor.atomic).length, 0);

// Distinct source formulas can each match once and still claim the same PDF
// glyphs. Reject the whole overlapping chain, while keeping an unrelated one.
const overlappingMath = String.raw`\begin{document}$a+b+c$ $b+c$ $c+d$ $p+q$\end{document}`;
const overlappingAnchors = await buildPdfWordAnchors(
  "latex",
  [{ path: "main.tex", source: overlappingMath }],
  [{ text: "a+b+c+d p+q", region: "1:0" }],
);
assert.deepEqual(
  overlappingAnchors
    .filter((anchor) => anchor.atomic)
    .map((anchor) => overlappingMath.slice(anchor.from, anchor.to)),
  ["$p+q$"],
);

const sharedScript = String.raw`\begin{document}$Q=7r^3$ $X=4y^3$\end{document}`;
const sharedScriptAnchors = await buildPdfWordAnchors(
  "latex",
  [{ path: "main.tex", source: sharedScript }],
  [
    { text: "Q=7r", region: "1:0" },
    { text: "3", region: "1:0" },
    { text: "X=4y", region: "1:0" },
  ],
);
assert.equal(sharedScriptAnchors.filter((anchor) => anchor.atomic).length, 0);

const repeatedPdfMath = String.raw`\begin{document}$u+v$\end{document}`;
assert.equal(
  (
    await buildPdfWordAnchors(
      "latex",
      [{ path: "main.tex", source: repeatedPdfMath }],
      [{ text: "u+v and u+v", region: "1:0" }],
    )
  ).filter((anchor) => anchor.atomic).length,
  0,
);
