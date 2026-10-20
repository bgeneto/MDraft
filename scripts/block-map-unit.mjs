// Unit tests for block-record offset translation and word-run alignment.
//
//   node scripts/block-map-unit.mjs
//
// `src/source-map.ts` exports the pure folding and alignment helpers used by
// AsciiDoc and Typst Document, so Node 24 runs them directly without a browser
// or the application.

import {
  alignBlockNodes,
  alignedNodeSourceRange,
  foldWhitespace,
  rawNodeOffsetToSource,
  sourceOffsetToRawNode,
} from "../src/source-map.ts";

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

function selectWordInAligned(blockSource, nodeTexts, nodeIndex, word, occurrence = 0) {
  const aligned = alignBlockNodes(blockSource, 0, nodeTexts);
  const nodeText = nodeTexts[nodeIndex];
  let fromIndex = 0;
  let at = -1;
  for (let i = 0; i <= occurrence; i += 1) {
    at = nodeText.indexOf(word, fromIndex);
    if (at < 0) return null;
    fromIndex = at + 1;
  }
  const range = alignedNodeSourceRange(aligned, nodeIndex, at, at + word.length);
  if (!range) return null;
  return {
    ...range,
    slice: blockSource.slice(range.from, range.to),
  };
}

console.log("\n=== folded offset translation ===");
{
  const source = "one\n    two three";
  const dom = "one two three";
  const blockFolded = foldWhitespace(source);
  const nodeFolded = foldWhitespace(dom);
  const startInDom = dom.indexOf("three");
  const endInDom = startInDom + "three".length;
  const from = rawNodeOffsetToSource(nodeFolded, blockFolded, startInDom, "start");
  const to = rawNodeOffsetToSource(nodeFolded, blockFolded, endInDom, "end");
  check(
    source.slice(from, to) === "three",
    "a word after an indented line break maps to its exact source slice",
    `${from}..${to} = ${JSON.stringify(source.slice(from, to))}`,
  );

  const crlfSource = "alpha  \r\n  bravo   charlie";
  const crlfDom = "alpha  \n  bravo charlie";
  const crlfBlock = foldWhitespace(crlfSource);
  const crlfNode = foldWhitespace(crlfDom);
  const cStart = crlfDom.indexOf("charlie");
  const cFrom = rawNodeOffsetToSource(crlfNode, crlfBlock, cStart, "start");
  const cTo = rawNodeOffsetToSource(crlfNode, crlfBlock, cStart + "charlie".length, "end");
  check(
    crlfSource.slice(cFrom, cTo) === "charlie",
    "a selection after double spaces and CRLF maps to the word after them",
    `${cFrom}..${cTo} = ${JSON.stringify(crlfSource.slice(cFrom, cTo))}`,
  );

  // Starting inside the collapsed whitespace run (`"  \n  "` at index 7 in `crlfDom`)
  // must advance cleanly to the start of `"bravo"`.
  const midWsFrom = rawNodeOffsetToSource(crlfNode, crlfBlock, 7, "start");
  const bEnd = crlfDom.indexOf("bravo") + "bravo".length;
  const midWsTo = rawNodeOffsetToSource(crlfNode, crlfBlock, bEnd, "end");
  check(
    crlfSource.slice(midWsFrom, midWsTo) === "bravo",
    "a selection starting inside collapsed whitespace snaps to the next word boundary",
    `${midWsFrom}..${midWsTo} = ${JSON.stringify(crlfSource.slice(midWsFrom, midWsTo))}`,
  );

  const srcTwoStart = source.indexOf("two");
  const srcTwoEnd = srcTwoStart + "two".length;
  const domTwoStart = sourceOffsetToRawNode(nodeFolded, blockFolded, srcTwoStart, "start");
  const domTwoEnd = sourceOffsetToRawNode(nodeFolded, blockFolded, srcTwoEnd, "end");
  check(
    dom.slice(domTwoStart, domTwoEnd) === "two",
    "sourceOffsetToRawNode maps a source word back to the DOM text node",
    `${domTwoStart}..${domTwoEnd} = ${JSON.stringify(dom.slice(domTwoStart, domTwoEnd))}`,
  );
}

console.log("\n=== attribute substitution inside one text node ===");
{
  const source = "Um parágrafo com {atributo} que não deve ser localizado pelo texto.";
  const dom = "Um parágrafo com substituído que não deve ser localizado pelo texto.";

  const before = selectWordInAligned(source, [dom], 0, "parágrafo");
  check(
    before?.slice === "parágrafo",
    "a word before {atributo} in the same text node maps to itself",
    JSON.stringify(before),
  );

  const after = selectWordInAligned(source, [dom], 0, "localizado");
  check(
    after?.slice === "localizado",
    "a word after {atributo} in the same text node maps to itself",
    JSON.stringify(after),
  );

  const substituted = selectWordInAligned(source, [dom], 0, "substituído");
  check(
    substituted === null,
    "the substituted word itself returns null so the block fallback can fire",
    JSON.stringify(substituted),
  );

  // Guard against a substituted word jumping ahead to a later repeated occurrence
  // in the same paragraph.
  const repeatSource = "Um parágrafo com {atributo} que não deve repetir substituído no fim.";
  const repeatDom = "Um parágrafo com substituído que não deve repetir substituído no fim.";
  const firstSub = selectWordInAligned(repeatSource, [repeatDom], 0, "substituído", 0);
  const middleQue = selectWordInAligned(repeatSource, [repeatDom], 0, "que", 0);
  const secondSub = selectWordInAligned(repeatSource, [repeatDom], 0, "substituído", 1);
  check(
    firstSub === null && middleQue?.slice === "que" && secondSub?.slice === "substituído",
    "a substituted word does not jump past closer words to a later repeat",
    JSON.stringify({ firstSub, middleQue, secondSub }),
  );
}

console.log("\n=== smart punctuation, numbered prefixes and inline calls ===");
{
  const punctSource = "The compiler's output -- fast... and reliable.";
  const punctDom = "The compiler\u2019s output \u2014 fast\u2026 and reliable.";
  const apostrophe = selectWordInAligned(punctSource, [punctDom], 0, "compiler\u2019s");
  const afterDash = selectWordInAligned(punctSource, [punctDom], 0, "fast");
  const afterEllipsis = selectWordInAligned(punctSource, [punctDom], 0, "reliable");
  check(
    apostrophe?.slice === "compiler's" &&
      afterDash?.slice === "fast" &&
      afterEllipsis?.slice === "reliable",
    "smart apostrophes, em-dashes and ellipses keep surrounding words aligned",
    JSON.stringify({ apostrophe, afterDash, afterEllipsis }),
  );

  const heading = selectWordInAligned("== Lists", ["1.1 Lists"], 0, "Lists");
  check(
    heading?.slice === "Lists",
    "a numbered heading prefix is skipped and the heading title maps",
    JSON.stringify(heading),
  );

  const typstCallSource =
    '#text(fill: rgb("#b03030"))[Coloured text] is a normal part of the language.';
  const typstCallDom = "Coloured text is a normal part of the language.";
  const coloured = selectWordInAligned(typstCallSource, [typstCallDom], 0, "Coloured");
  const textWord = selectWordInAligned(typstCallSource, [typstCallDom], 0, "text");
  const languageWord = selectWordInAligned(typstCallSource, [typstCallDom], 0, "language");
  check(
    coloured?.slice === "Coloured" &&
      textWord?.slice === "text" &&
      textWord.from > typstCallSource.indexOf("[") &&
      languageWord?.slice === "language",
    "a stripped #text(...)[...] call aligns [Coloured text] rather than #text",
    JSON.stringify({ coloured, textWord, languageWord }),
  );

  const multiNodeSource = "NOTE: A note admonition with prose after the label.";
  const multiNodeDom = ["Note", "A note admonition with prose after the label."];
  const afterUnmatchedNode = selectWordInAligned(multiNodeSource, multiNodeDom, 1, "admonition");
  check(
    afterUnmatchedNode?.slice === "admonition",
    "an unmatched leading text node does not abort the rest of the block",
    JSON.stringify(afterUnmatchedNode),
  );
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
