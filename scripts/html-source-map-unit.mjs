// Unit tests for the HTML source map's offset rule.
//
//   node scripts/html-source-map-unit.mjs
//
// The guest reports a text-node index and a sample, never a source offset. The
// host turns that into a range through the table built from parse5. These checks
// pin the two places where the mapping can lie: entities (decoded and raw
// offsets differ) and a DOM that no longer matches the table (the sample check).
// No application and no browser are needed.

import {
  htmlDecodedOffsets,
  htmlRangesForSource,
  htmlSourceRange,
  rawOffsetForDecoded,
} from "../src/html-source-map.ts";
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

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
