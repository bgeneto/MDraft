//! File-aware PDF/source correspondence fails closed on incomplete ownership.
import assert from "node:assert/strict";
import { PdfPageMap } from "../src/pdf-page-map.ts";
const lines = [
  { text: "alpha beta gamma", region: "page:column" },
  { text: "delta omega", region: "page:column" },
];
const anchors = [
  { file: "main.tex", from: 10, to: 15, line: 0, start: 0, end: 5, region: "page:column" },
  { file: "main.tex", from: 16, to: 20, line: 0, start: 6, end: 10, region: "page:column" },
  { file: "main.tex", from: 21, to: 26, line: 0, start: 11, end: 16, region: "page:column" },
  { file: "chapter.tex", from: 2, to: 7, line: 1, start: 0, end: 5, region: "page:column" },
];
const map = new PdfPageMap(lines, anchors, true);
assert.deepEqual(map.sourceRange(0, 0, 0, 10), { file: "main.tex", from: 10, to: 20 });
assert.equal(map.sourceRange(0, 0, 1, 5), null);
assert.equal(map.sourceRange(1, 0, 1, 11), null);
assert.equal(map.sourceRange(0, 6, 0, 5), null);
assert.deepEqual(map.partsForSource("main.tex", 16, 20), [anchors[1]]);
assert.deepEqual(map.partsForSource("chapter.tex", 16, 20), []);
const reordered = new PdfPageMap(
  lines,
  [anchors[0], { ...anchors[1], from: 20, to: 24 }, { ...anchors[2], from: 16, to: 26 }],
  true,
);
assert.equal(reordered.sourceRange(0, 0, 0, 16), null);
console.log("7/7 file-aware correspondence checks passed");
