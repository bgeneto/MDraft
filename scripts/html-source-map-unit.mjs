// Unit tests for the HTML source map's offset rule.
//
//   node scripts/html-source-map-unit.mjs
//
// The guest reports a text-node index and a sample, never a source offset. The
// host turns that into a range through the table built from parse5. These checks
// pin the places where the mapping can lie: entities (decoded and raw offsets
// differ), a DOM that no longer matches the table (the sample check), and the
// guest's alignment after a math renderer or highlighter split the text.
// No application and no browser are needed.

import {
  htmlDecodedOffsets,
  htmlRangesForSource,
  htmlSourceRange,
  rawOffsetForDecoded,
  htmlScrollAnchors,
  htmlTextTable,
  readHtmlScrollGeometry,
} from "../src/html-source-map.ts";
import { alignTextRuns } from "../src/html-text-align.js";
import { parseFragment } from "parse5";

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

console.log("\n=== decoded to raw offsets ===");
{
  const raw = "a &amp; b";
  check(rawOffsetForDecoded(raw, 0) === 0, "the first character maps to itself");
  check(rawOffsetForDecoded(raw, 2) === 2, "the entity start maps to the raw ampersand");
  check(
    rawOffsetForDecoded(raw, 3) === 7,
    "the character after the entity skips the whole entity",
    String(rawOffsetForDecoded(raw, 3)),
  );
  check(rawOffsetForDecoded(raw, 4) === 8, "the last character maps to the raw end");
  check(rawOffsetForDecoded(raw, 6) === null, "an offset past the end is rejected");
}

console.log("\n=== numeric entities and line endings ===");
{
  check(rawOffsetForDecoded("a&#65;b", 1) === 1, "a numeric entity starts at its ampersand");
  check(
    rawOffsetForDecoded("a&#65;b", 2) === 6,
    "the character after a numeric entity skips it",
    String(rawOffsetForDecoded("a&#65;b", 2)),
  );
  check(rawOffsetForDecoded("a\r\nb", 2) === 3, "a CRLF counts as one decoded character");
  check(rawOffsetForDecoded("a\r\nb", 3) === 4, "the character after a CRLF maps past both bytes");
}

console.log("\n=== the sample check ===");
{
  const fragment = {
    n: 1,
    index: 0,
    src0: 10,
    src1: 19,
    raw: "a &amp; b",
    text: "a & b",
  };
  const exact = htmlSourceRange([fragment], {
    n: 1,
    index: 0,
    start: 2,
    end: 3,
    sample: "&",
    reveal: false,
  });
  check(
    exact !== null && exact.from === 12 && exact.to === 17,
    "an ampersand maps to the whole raw entity",
    JSON.stringify(exact),
  );

  check(
    htmlSourceRange([fragment], {
      n: 1,
      index: 0,
      start: 2,
      end: 3,
      sample: "x",
      reveal: false,
    }) === null,
    "a sample that no longer matches paints nothing",
  );
  check(
    htmlSourceRange([fragment], {
      n: 1,
      index: 1,
      start: 0,
      end: 1,
      sample: "a",
      reveal: false,
    }) === null,
    "a wrong text-node index paints nothing",
  );
  check(
    htmlSourceRange([fragment], {
      n: 1,
      index: 0,
      start: 4,
      end: 99,
      sample: "b",
      reveal: false,
    }) === null,
    "an end past the text node paints nothing",
  );
}

console.log("\n=== two nodes under one stamp ===");
{
  const fragments = [
    { n: 7, index: 0, src0: 0, src1: 5, raw: "alpha", text: "alpha" },
    { n: 7, index: 1, src0: 6, src1: 11, raw: "bravo", text: "bravo" },
  ];
  const second = htmlSourceRange(fragments, {
    n: 7,
    index: 1,
    start: 0,
    end: 5,
    sample: "bravo",
    reveal: false,
  });
  check(
    second !== null && second.from === 6 && second.to === 11,
    "the index selects the right node",
    JSON.stringify(second),
  );
}

console.log("\n=== complete HTML entity boundaries and inverse ranges ===");
for (const raw of [
  "Caf&eacute; afterword.",
  "A &copy; afterword.",
  "A &NotEqualTilde; afterword.",
  "A &copycat afterword.",
  "A &#x80; afterword.",
  "A &#0; afterword.",
  "A &#x1f680; afterword.",
  "A &semi; afterword.",
  "A &#59; afterword.",
]) {
  const text = parseFragment(raw).childNodes[0].value;
  const start = text.indexOf("afterword");
  const fragment = {
    n: 1,
    index: 0,
    src0: 0,
    src1: raw.length,
    raw,
    text,
    offsets: htmlDecodedOffsets(raw, text),
  };
  const result = htmlSourceRange([fragment], {
    n: 1,
    index: 0,
    start,
    end: start + 9,
    sample: "afterword",
    reveal: false,
  });
  check(
    result && raw.slice(result.from, result.to) === "afterword",
    "word after " + raw.split(" ").slice(0, 2).join(" ") + " maps exactly",
    JSON.stringify(result),
  );
  const inverse = htmlRangesForSource(
    [fragment],
    raw.indexOf("afterword"),
    raw.indexOf("afterword") + 9,
  );
  check(
    inverse.length === 1 && inverse[0].sample === "afterword",
    "source maps back after entity: " + raw,
    JSON.stringify(inverse),
  );
}
check(
  htmlDecodedOffsets("a &NotEqualTilde; b")?.[3] === null,
  "inside a multi-codepoint entity is not a raw boundary",
);
check(
  htmlDecodedOffsets("alpha", "changed") === null,
  "a decoded-text mismatch invalidates the table",
);
{
  const fragments = [
    { n: 1, index: 0, src0: 3, src1: 9, raw: "alpha ", text: "alpha " },
    { n: 1, index: 1, src0: 17, src1: 22, raw: "bravo", text: "bravo" },
  ];
  const segments = [
    { n: 1, index: 0, start: 0, end: 5, sample: "alpha" },
    { n: 1, index: 1, start: 0, end: 5, sample: "bravo" },
  ];
  const range = htmlSourceRange(fragments, { ...segments[0], segments, reveal: false });
  check(
    range?.from === 3 && range?.to === 22,
    "a phrase spans inline text nodes",
    JSON.stringify(range),
  );
  check(
    htmlSourceRange(fragments, {
      ...segments[0],
      segments: [...segments].reverse(),
      reveal: false,
    }) === null,
    "reversed node identities fail closed",
  );
  check(
    htmlSourceRange(fragments, {
      ...segments[0],
      segments: [segments[0], { ...segments[1], sample: "changed" }],
      reveal: false,
    }) === null,
    "all endpoint samples are validated",
  );
  check(
    htmlSourceRange(fragments, { ...segments[0], segments: {}, reveal: false }) === null,
    "malformed segment payloads fail closed without throwing",
  );
}

{
  const raw = "Caf&eacute; afterword",
    text = "Café afterword";
  const anchors = htmlScrollAnchors([
    { n: 1, index: 0, src0: 10, src1: 10 + raw.length, raw, text },
  ]);
  check(
    anchors.length === 2 && anchors[1].from === 10 + raw.indexOf("afterword"),
    "scroll identities retain HTML entity boundaries",
  );
  check(
    anchors[0].range.sample === "Café" && !("from" in anchors[0].range),
    "guest scroll specs contain decoded identity, never source offsets",
  );
  const valid = {
    top: 100,
    epoch: 2,
    input: 3,
    points: [{ at: 0, top: 200, height: 20, sample: "Café" }],
  };
  check(
    readHtmlScrollGeometry(valid, anchors)?.points[0].top === 200,
    "requested geometry is accepted with matching samples",
  );
  const bad = [
    { ...valid, epoch: -1 },
    { ...valid, input: NaN },
    { ...valid, top: Infinity },
    { ...valid, points: [{ ...valid.points[0], at: anchors.length }] },
    { ...valid, points: [{ ...valid.points[0], sample: "different" }] },
    { ...valid, points: [{ ...valid.points[0], height: -1 }] },
    { ...valid, points: [valid.points[0], valid.points[0]] },
  ];
  check(
    bad.every((data) => readHtmlScrollGeometry(data, anchors) === null),
    "invalid epochs, geometry, identities, samples and duplicates fail closed",
  );
  check(
    readHtmlScrollGeometry(null, anchors) === null &&
      readHtmlScrollGeometry({ ...valid, points: {} }, anchors) === null,
    "malformed scroll replies do not throw",
  );
}

console.log("\n=== one text node split by a script ===");
{
  const raw = "mesma $x$, mas";
  const fragments = [{ n: 4, index: 0, src0: 30, src1: 30 + raw.length, raw, text: raw }];
  const pieces = (segments) => ({ ...segments[0], reveal: false, segments });
  const across = htmlSourceRange(
    fragments,
    pieces([
      { n: 4, index: 0, start: 0, end: 5, sample: "mesma" },
      { n: 4, index: 0, start: 9, end: 14, sample: ", mas" },
    ]),
  );
  check(
    across?.from === 30 && across?.to === 44,
    "pieces on both sides of a formula span the formula's source",
    JSON.stringify(across),
  );
  check(
    htmlSourceRange(
      fragments,
      pieces([
        { n: 4, index: 0, start: 9, end: 14, sample: ", mas" },
        { n: 4, index: 0, start: 0, end: 5, sample: "mesma" },
      ]),
    ) === null,
    "pieces of one node out of order are rejected",
  );
  check(
    htmlSourceRange(
      fragments,
      pieces([
        { n: 4, index: 0, start: 0, end: 5, sample: "mesma" },
        { n: 4, index: 0, start: 2, end: 5, sample: "sma" },
      ]),
    ) === null,
    "overlapping pieces of one node are rejected",
  );
}

console.log("\n=== the text table sent to the guest ===");
{
  const fragment = (n, index, text, p) => ({ n, index, src0: 0, src1: 0, raw: text, text, p });
  const table = htmlTextTable([
    fragment(0, 0, "lead", -1),
    fragment(2, 0, "a ", -1),
    fragment(2, 1, "b", 0),
    fragment(0, 1, "tail", -1),
  ]);
  check(
    JSON.stringify(table) ===
      JSON.stringify({
        texts: [["lead", "tail"], null, ["a ", "b"]],
        parents: [[-1, -1], null, [-1, 0]],
      }),
    "texts are grouped by stamp with their parent ordinals; a stamp without text is null",
    JSON.stringify(table),
  );
  check(
    htmlTextTable([fragment(0, 0, "x".repeat(10), -1)], 5) === null,
    "a table above the size limit is not sent",
  );
  check(
    htmlTextTable([fragment(0, 1, "skipped", -1)]) === null,
    "a gap in a stamp's indices refuses the table",
  );
}

console.log("\n=== guest alignment after a script rewrote the text ===");
{
  // `observed` mirrors what the bridge collects: text, parent ordinal, whether
  // an element was passed since the previous text node, and whether no later
  // text with visible characters shares the parent.
  const seen = (text, parent = -1, element = false, last = false) => ({
    text,
    parent,
    element,
    last,
  });
  const show = (result) => JSON.stringify(result);

  const same = alignTextRuns(["a ", "b"], [-1, 0], [seen("a "), seen("b", 0, true)]);
  check(
    show(same) ===
      show([
        { index: 0, base: 0 },
        { index: 1, base: 0 },
      ]),
    "an untouched stamp keeps its own positions",
    show(same),
  );

  const math = alignTextRuns(
    ["Em rotação, mesma $\\omega$, mas $v_i$ diferentes."],
    [-1],
    [seen("Em rotação, mesma "), seen(", mas ", -1, true), seen(" diferentes.", -1, true, true)],
  );
  check(
    show(math) ===
      show([
        { index: 0, base: 0 },
        { index: 0, base: 26 },
        { index: 0, base: 37 },
      ]),
    "pieces around inline formulas keep their offsets in the original text",
    show(math),
  );

  const leading = alignTextRuns(
    ["$x$ is a variable"],
    [-1],
    [seen(" is a variable", -1, true, true)],
  );
  check(
    show(leading) === show([{ index: 0, base: 3 }]),
    "text after a formula that opened the node is placed after it",
    show(leading),
  );

  // <tr><td>$\text{kg}$</td><td>kg</td></tr>: the first cell's text is gone.
  const cells = alignTextRuns(
    ["\n", "$\\text{kg}$", "\n", "kg", "\n"],
    [-1, 0, -1, 1, -1],
    [seen("\n"), seen("\n", -1, true), seen("kg", 1, true, true), seen("\n", -1, true)],
  );
  check(
    show(cells[2]) === show({ index: 3, base: 0 }),
    "a cell after a formula cell is not placed inside that formula",
    show(cells),
  );

  const suffix = alignTextRuns(["$e^x$e"], [-1], [seen("e", -1, true, true)]);
  check(
    show(suffix) === show([{ index: 0, base: 5 }]),
    "the last piece of a split node prefers the original text's end",
    show(suffix),
  );

  const tokens = alignTextRuns(
    ["const x = 1;"],
    [-1],
    [
      seen("const", 0, true),
      seen(" x ", -1, true),
      seen("=", 1, true),
      seen(" 1;", -1, true, true),
    ],
  );
  check(
    show(tokens) ===
      show([
        { index: 0, base: 0 },
        { index: 0, base: 5 },
        { index: 0, base: 8 },
        { index: 0, base: 9 },
      ]),
    "highlighter tokens in new spans map contiguously",
    show(tokens),
  );

  const replaced = alignTextRuns(
    ["standaloneword sample nextword."],
    [-1],
    [seen("mutatedword sample nextword.")],
  );
  check(show(replaced) === show([null]), "text a script replaced stays unmapped");

  const edited = alignTextRuns(["Hello dear world"], [-1], [seen("world")]);
  check(
    show(edited) === show([null]),
    "text skipped with nothing inserted in its place is not a renderer's work",
    show(edited),
  );

  const moved = alignTextRuns(["a $x$ b"], [0], [seen(" b", 3, true, true)]);
  check(
    show(moved) === show([null]),
    "a piece under a different parent after skipped text is refused",
    show(moved),
  );

  const generated = alignTextRuns(
    ["Slide title"],
    [-1],
    [seen("Slide title"), seen("3 / 36", -1, true)],
  );
  check(
    show(generated) === show([{ index: 0, base: 0 }, null]),
    "text a script added stays unmapped without moving the others",
    show(generated),
  );
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
