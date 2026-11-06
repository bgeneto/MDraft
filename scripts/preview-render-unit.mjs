//! The pure preview pipeline, checked without an application or a DOM.
//!
//!   node scripts/preview-render-unit.mjs
//!
//! WebView2/WebKitGTK render the result, but the string work in
//! `src/preview-render.ts` is engine-independent. This catches a broken
//! fragment table, a lost math entry, a line list that no longer matches, or a
//! chunking path that duplicates content before either UI suite runs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderChunks } from "../src/preview-render.ts";
import * as sourceMap from "../src/source-map.ts";
import { legacyImageCandidate } from "../src/legacy-image-paths.ts";
import { marked } from "marked";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}${detail ? `  (${detail})` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ""}`);
  }
}

const feature = read("samples/feature-tour.md");
const wordSync = read("samples/word-sync.md");

for (const [label, raw, expected] of [
  [
    "drive and hidden folder",
    String.raw`![x](C:\Users\reader\.codex\.image.png)`,
    String.raw`C:\Users\reader\.codex\.image.png`,
  ],
  [
    "relative hidden folder",
    String.raw`![x](.\.images\image.png)`,
    String.raw`.\.images\image.png`,
  ],
  [
    "relative path without dot prefix",
    String.raw`![x](images\.hidden\image.png)`,
    String.raw`images\.hidden\image.png`,
  ],
  [
    "angle destination with spaces and parentheses",
    String.raw`![x](<C:\My Pictures\.hidden\(cover).png>)`,
    String.raw`C:\My Pictures\.hidden\(cover).png`,
  ],
  [
    "reference definition",
    String.raw`[img]: C:\Users\reader\.codex\image.png`,
    String.raw`C:\Users\reader\.codex\image.png`,
  ],
  ["UNC is not probed", String.raw`![x](\\server\share\.hidden\image.png)`, null],
  [
    "escaped separators need no fallback",
    String.raw`![x](C:\\Users\\reader\\.hidden\\image.png)`,
    null,
  ],
  ["remote URL is not probed", "![x](https://example.test/.hidden/image.png)", null],
  ["POSIX path is not reinterpreted", "![x](/home/reader/.hidden/image.png)", null],
]) {
  const token = marked.lexer(raw)[0];
  const image = token.type === "def" ? token : token.tokens?.[0];
  const candidate = image ? legacyImageCandidate(image.raw, image.href) : null;
  check(`legacy image: ${label}`, candidate === expected, JSON.stringify(candidate));
}

for (const [label, source] of [
  ["inline", String.raw`![x](C:\Users\reader\.hidden\image.png)`],
  [
    "reference",
    String.raw`![x][img]` + "\n\n" + String.raw`[img]: C:\Users\reader\.hidden\image.png`,
  ],
]) {
  for (const map of [false, true]) {
    const data = renderChunks(source, { map });
    const entries = Object.entries(data.legacyImages ?? {});
    check(
      `legacy image: ${label} keeps one opaque stamp (map=${map})`,
      entries.length === 1 &&
        data.chunks.join("").includes(`data-mdraft-legacy="${entries[0][0]}"`),
    );
  }
}

{
  const source = String.raw`![x](C:\Users\reader\.hidden\image.png)`;
  const first = Object.keys(renderChunks(source).legacyImages ?? {});
  const second = Object.keys(renderChunks(source).legacyImages ?? {});
  check(
    "legacy image stamps differ between renders",
    first.length === 1 && second.length === 1 && first[0] !== second[0],
  );
  const forged = renderChunks(`<img src="x" data-mdraft-legacy="${first[0]}">`);
  check(
    "raw HTML cannot create a legacy image candidate",
    Object.keys(forged.legacyImages ?? {}).length === 0,
  );
}

// ---------------------------------------------------------------------------
// A document with every construction the table depends on
// ---------------------------------------------------------------------------

for (const [name, source] of [
  ["feature-tour", feature],
  ["word-sync", wordSync],
]) {
  const mapped = renderChunks(source, { math: true, map: true });
  const plain = renderChunks(source, { math: true, map: false });
  check(`${name}: produces chunks`, mapped.chunks.length > 0, `${mapped.chunks.length}`);
  // The mapped path wraps text runs in `data-f` spans; the block structure,
  // and therefore the chunk count, must not change with the map.
  check(
    `${name}: chunking does not depend on the map`,
    mapped.chunks.length === plain.chunks.length,
  );
  check(
    `${name}: has fragments`,
    (mapped.fragments?.length ?? 0) > 0,
    `${mapped.fragments?.length}`,
  );
  check(`${name}: has block lines`, (mapped.lines?.length ?? 0) > 0, `${mapped.lines?.length}`);
  check(`${name}: plain has no fragments`, plain.fragments === undefined);
  const lineCount = source.split("\n").length;
  check(
    `${name}: every line is inside the document`,
    (mapped.lines ?? []).every((line) => line >= 1 && line <= lineCount),
  );
  const fragments = mapped.fragments ?? [];
  check(
    `${name}: every fragment covers a source range`,
    fragments.every((f) => f.src0 >= 0 && f.src0 <= f.src1 && f.src1 <= source.length),
  );
  check(
    `${name}: fragments stay in document order`,
    fragments.every((f, i) => i === 0 || f.src0 >= fragments[i - 1].src0),
  );
  const html = mapped.chunks.join("");
  const codeSlots = html.match(/@@CODE/g)?.length ?? 0;
  const mathSlots = html.match(/@@MATH/g)?.length ?? 0;
  check(
    `${name}: every code placeholder has an entry`,
    codeSlots === mapped.codes.length,
    `${codeSlots}/${mapped.codes.length}`,
  );
  check(
    `${name}: every math placeholder has an entry`,
    mathSlots === mapped.maths.length,
    `${mathSlots}/${mapped.maths.length}`,
  );
}

// ---------------------------------------------------------------------------
// Math, code and CRLF
// ---------------------------------------------------------------------------

const inline = renderChunks("Text $x^2 + y^2$ here.", { math: true, map: true });
check("inline math is one entry", inline.maths.length === 1, `${inline.maths.length}`);
check("inline math is not display", inline.maths[0]?.display === false);
check(
  "inline math carries KaTeX HTML",
  (inline.maths[0]?.html ?? "").includes("katex"),
  `${inline.maths[0]?.html?.length ?? 0} chars`,
);
check(
  "inline math keeps one placeholder for the DOM restore",
  (inline.chunks.join("").match(/@@MATH/g)?.length ?? 0) === inline.maths.length,
);

const display = renderChunks("Before\n\n$$x^2$$\n\nAfter", { math: true, map: true });
check("display math is display", display.maths[0]?.display === true);

const code = renderChunks("Use `x < y` here.", { map: true });
check("inline code is one entry", code.codes.length === 1, `${code.codes.length}`);
check("inline code keeps its text", code.codes[0]?.text === "x < y");

const reference = renderChunks("[label][ref]\n\n[ref]: https://example.com\n", { map: true });
check(
  "reference links resolve before per-token rendering",
  reference.chunks.join("").includes('href="https://example.com"'),
);

const fence = renderChunks("```mermaid\ngraph TD; A-->B\n```", { map: true });
check("a fence keeps its language class", fence.chunks.join("").includes("language-mermaid"));

const lf = renderChunks("one\n\ntwo\n", { map: true });
const crlf = renderChunks("one\r\n\r\ntwo\r\n", { map: true });
check("CRLF produces the same HTML", lf.chunks.join("") === crlf.chunks.join(""));
// marked normalizes CRLF while lexing, so the original-source line lookup may
// not find its raw slice. The mapping then fails safe (null) rather than
// pointing at a wrong line; that is the pre-existing behaviour.
check(
  "CRLF line anchors fail safe or match LF",
  crlf.lines === null || crlf.lines.join(",") === lf.lines?.join(","),
  `${lf.lines?.join(",")} / ${crlf.lines === null ? "null" : crlf.lines.join(",")}`,
);

const empty = renderChunks("", { map: true });
check("an empty document renders nothing", empty.chunks.length === 0 && empty.lines?.length === 0);

// Raw HTML can span top-level Markdown tokens. Such tokens must be sanitized
// together even when their combined output crosses the batch size.
for (const map of [false, true]) {
  const raw = renderChunks('<div class="box">\n\ninside\n\n</div>', { map });
  check(`raw HTML is marked for whole-context sanitizing (map=${map})`, raw.hasRawHtml === true);
  const inlineHtml = renderChunks("before <span>\n\ninside\n\n</span>", { map });
  check(`inline HTML crossing paragraphs is marked (map=${map})`, inlineHtml.hasRawHtml === true);
  const codeHtml = renderChunks("```html\n<div>\n```\n\nplain", { map });
  check(
    `HTML inside a code fence does not disable batching (map=${map})`,
    codeHtml.hasRawHtml === false,
  );
}

// An indexed translator must exactly preserve the original mapping contract at
// substitution boundaries, including adjacent substitutions and negative deltas.
check("indexed offset translator is available", typeof sourceMap.indexOffsets === "function");
if (typeof sourceMap.indexOffsets === "function") {
  const sets = [
    [],
    [{ p0: 2, p1: 3, o0: 2, o1: 4 }],
    [
      { p0: 0, p1: 3, o0: 0, o1: 1 },
      { p0: 3, p1: 4, o0: 1, o1: 3 },
      { p0: 7, p1: 11, o0: 6, o1: 6 },
    ],
    Array.from({ length: 1000 }, (_, index) => ({
      p0: index * 3,
      p1: index * 3 + 1,
      o0: index * 4,
      o1: index * 4 + 2,
    })),
  ];
  for (const [index, substitutions] of sets.entries()) {
    const indexed = sourceMap.indexOffsets(substitutions);
    const max = substitutions.at(-1)?.p1 ?? 10;
    const matches = Array.from({ length: max + 4 }, (_, offset) => offset).every(
      (offset) => indexed(offset) === sourceMap.translateOffset(substitutions, offset),
    );
    check(`indexed offsets match the original translator (${index})`, matches);
  }

  let seed = 0x72656e64;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  let generatedMatches = true;
  for (let sample = 0; sample < 120; sample += 1) {
    const substitutions = [];
    let position = 0;
    for (let index = 0; index < 80; index += 1) {
      position += next() % 4;
      const length = 1 + (next() % 6);
      const originalLength = next() % 9;
      substitutions.push({ p0: position, p1: position + length, o0: 0, o1: originalLength });
      position += length;
    }
    const indexed = sourceMap.indexOffsets(substitutions);
    for (let offset = 0; offset <= position + 1; offset += 1) {
      if (indexed(offset) !== sourceMap.translateOffset(substitutions, offset)) {
        generatedMatches = false;
        break;
      }
    }
    if (!generatedMatches) break;
  }
  check("indexed offsets match generated boundary and delta cases", generatedMatches);
}

for (const ending of ["\n", "\r\n", "\r"]) {
  const unicodeSource = `α 😀 \`x\` and $y$${ending}${ending}β cafe\u0301 next${ending}`;
  const unicodeResult = renderChunks(unicodeSource, { math: true, map: true });
  check(
    `${JSON.stringify(ending)} and Unicode fragments retain source ranges after code and math`,
    JSON.stringify(
      (unicodeResult.fragments ?? []).map((fragment) => ({
        kind: fragment.kind,
        source: unicodeSource.slice(fragment.src0, fragment.src1),
      })),
    ) ===
      JSON.stringify([
        { kind: "text", source: "α 😀 " },
        { kind: "code", source: "`x`" },
        { kind: "text", source: " and " },
        { kind: "math", source: "$y$" },
        { kind: "text", source: "β cafe\u0301 next" },
      ]),
  );
}

// ---------------------------------------------------------------------------
// Word sync in multiline containers
// ---------------------------------------------------------------------------

/** Every word a mapped document paints, located in the original source. */
function wordRanges(fragments, source) {
  const ranges = [];
  for (const fragment of fragments) {
    if (fragment.kind !== "text") continue;
    const slice = source.slice(fragment.src0, fragment.src1);
    // Line endings are the one character `marked` normalizes, and a container
    // that removed indentation is split into one fragment per line, so the run
    // still equals its source slice apart from CR.
    if (slice.replace(/\r\n?/g, "\n") !== fragment.raw) return null;
    for (const match of fragment.raw.matchAll(/[\p{L}\p{N}_]+/gu)) {
      ranges.push({
        word: match[0],
        from: fragment.src0 + match.index,
        to: fragment.src0 + match.index + match[0].length,
      });
    }
  }
  return ranges;
}

/** True when every mapped word equals the source text at its own range. */
function wordsAreExact(fragments, source) {
  const ranges = wordRanges(fragments, source);
  return !!ranges && ranges.every((range) => source.slice(range.from, range.to) === range.word);
}

/**
 * True when every prose line carries at least one mapped word.
 *
 * A whole-item failure — the reported symptom — leaves entire lines with no
 * fragment at all, which `wordsAreExact` alone cannot see: a shorter table is
 * still exact.
 */
function everyLineMaps(fragments, source) {
  const ranges = wordRanges(fragments, source);
  if (!ranges) return false;
  let at = 0;
  let fenced = false;
  for (const line of source.split("\n")) {
    const start = at;
    at += line.length + 1;
    if (/^\s*(?:>\s*)*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !/\p{L}/u.test(line)) continue;
    if (!ranges.some((range) => range.from >= start && range.from < start + line.length)) {
      return false;
    }
  }
  return true;
}

const visit = (html) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

/** Decode entities until nothing changes, for inputs that were escaped twice. */
function decodeFully(text) {
  let current = text;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = visit(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

// The built-in Markdown Reference is the document the reader reported. Its list
// below "How the delimiters are recognized" has a continuation line in every
// item, which is exactly the shape that used to produce no fragments at all.
const contentSource = read("src/content.ts");
const referenceLines = contentSource.match(/const REFERENCE_LINES: string\[\] = \[([\s\S]*?)\n\];/);
const markdownReference = referenceLines
  ? Function(`return [${referenceLines[1]}]`)().join("\n")
  : "";
check(
  "the Markdown Reference is readable from its source",
  markdownReference.includes("How the delimiters are recognized:") &&
    markdownReference.includes("Tight `$…$` pairs"),
);
{
  const start = markdownReference.indexOf("How the delimiters are recognized:");
  const end = markdownReference.indexOf("\n\n## Diagrams", start);
  const listSource = markdownReference.slice(start, end);
  const mapped = renderChunks(markdownReference, { math: true, map: true });
  // Rebase the list's fragments so the checks read against the list alone.
  const fragments = (mapped.fragments ?? [])
    .filter((fragment) => fragment.src0 >= start && fragment.src1 <= end)
    .map((fragment) => ({
      ...fragment,
      src0: fragment.src0 - start,
      src1: fragment.src1 - start,
    }));
  check(
    "the reference list maps every word exactly",
    wordsAreExact(fragments, listSource),
    `${fragments.length} fragments`,
  );
  const ranges = wordRanges(fragments, listSource) ?? [];
  check(
    "the reference list maps a word from every line",
    everyLineMaps(fragments, listSource),
    `${ranges.length} words mapped`,
  );
  // Both lines of the first item, with the code spans between them.
  for (const [label, word] of [
    ["the item's first line", "Tight"],
    ["the item's continuation line", "numeric"],
    ["a later item's continuation", "spelling"],
  ]) {
    const at = listSource.indexOf(word);
    const mappedAt = ranges.find((range) => range.from === at);
    check(`the reference list maps ${label} (${word})`, mappedAt?.word === word, `expected ${at}`);
  }
}

const listCases = {
  "unordered item with a continuation line": "- first line\n  second line\n- b\n",
  "four-space continuation": "- first line\n    second line\n",
  ordered: "1. one\n2. two\n   three\n",
  "ordered ten": "9. nine\n10. ten\n   more\n",
  "task list": "- [ ] todo\n  more\n- [x] done\n",
  "loose task list": "- [ ] todo\n\n- [x] done\n",
  loose: "- one\n\n- two\n  cont\n",
  nested: "- a\n  - b\n    - c\n  - d\n- e\n",
  "nested with continuation": "- a\n  - b line\n    continuation\n  - d\n",
  "block quote": "> - a\n>   b\n> - c\n",
  "star markers": "* a\n* b\n",
  "item with heading and fence": "- a\n  # h\n\n  ```\n  x\n  ```\n- b\n",
  "formatted across lines": "- **bold\n  across** lines\n",
  "link across lines": "- [label\n  text](https://example.com) tail\n",
  "image then text": "- ![alt](a.png) and text\n  second line\n",
  "table in a list item":
    "- intro line\n\n  | Left | Right |\n  | --- | --- |\n  | cell one | cell two |\n- after\n",
  "block quote inside an item": "- intro\n\n  > quoted line\n  > second quoted line\n- after\n",
  "unicode in a list": "- caf\u00e9 \ud83d\ude00 cafe\u0301 `code`\n  \\*escaped\\* tail\n",
  // The mapped path double-escapes an entity the author typed (`&amp;` becomes
  // `&amp;amp;`), which predates word sync; only the offsets are asserted here.
  "entities in a list":
    "- caf\u00e9 \ud83d\ude00 cafe\u0301 `code`\n  &amp; &copy; \\*escaped\\* tail\n",
  "emoji only line": "- \ud83d\ude00 \ud83d\ude00\n  \ud83d\ude00 second\n",
  "repeated item text": "- same words here\n  same words here\n- same words here\n",
  crlf: "- first\r\n  second\r\n- third\r\n",
  cr: "- first\r  second\r- third\r",
};

for (const [label, source] of Object.entries(listCases)) {
  const mapped = renderChunks(source, { math: true, map: true });
  const fragments = mapped.fragments ?? [];
  check(`${label}: every mapped word is the word at its source`, wordsAreExact(fragments, source));
  const ranges = wordRanges(fragments, source) ?? [];
  check(
    `${label}: every line carries a mapped word`,
    everyLineMaps(fragments, source),
    `${ranges.length} words mapped`,
  );
  const plain = renderChunks(source, { math: true, map: false });
  check(
    `${label}: mapping does not change the rendered text`,
    // Entities decode one level deeper in the mapped path; that divergence
    // predates word sync and is recorded in AGENTS.md, so the comparison here
    // decodes until stable for the case that contains one.
    (label === "entities in a list"
      ? decodeFully(visit(mapped.chunks.join("")))
      : visit(mapped.chunks.join(""))) ===
      (label === "entities in a list"
        ? decodeFully(visit(plain.chunks.join("")))
        : visit(plain.chunks.join(""))),
  );
  check(`${label}: the plain path emits no fragments`, plain.fragments === undefined);
}

{
  // A tab `marked` expanded cannot be located exactly. The line stays unmapped
  // and the rest of the item keeps its fragments — never a wrong occurrence.
  const source = "- first line\n\tsecond line\n";
  const mapped = renderChunks(source, { map: true });
  const fragments = mapped.fragments ?? [];
  check("tab continuation: the first line still maps", wordsAreExact(fragments, source));
  check(
    "tab continuation: the expanded line is not mapped",
    !fragments.some((fragment) => source.slice(fragment.src0, fragment.src1).includes("second")),
  );
  check(
    "tab continuation: the text is still rendered",
    visit(mapped.chunks.join("")).includes("second line"),
  );
}

{
  const source = "- same words here\n  same words here\n- same words here\n";
  const ranges = wordRanges(renderChunks(source, { map: true }).fragments ?? [], source) ?? [];
  const occurrences = ranges.filter((range) => range.word === "same").map((range) => range.from);
  check(
    "repeated words map to each of their own occurrences",
    occurrences.length === 3 && new Set(occurrences).size === 3,
    occurrences.join(","),
  );
}

{
  // A code span on a continuation line is an atomic fragment of its own.
  const source = "- Tight `$…$` pairs\n  `$5$` is numeric\n";
  const fragments = renderChunks(source, { map: true }).fragments ?? [];
  check(
    "a continuation-line code span keeps its exact source range",
    fragments.some(
      (fragment) =>
        fragment.kind === "code" && source.slice(fragment.src0, fragment.src1) === "`$5$`",
    ),
  );
}

{
  // `map: false` must not even build the table.
  const source = "- a\n  b\n";
  check(
    "mapping disabled skips the fragment build",
    renderChunks(source, { map: false }).fragments === undefined,
  );
}

// ---------------------------------------------------------------------------
// Scale: the chunk count is the top-level block count, not a word count
// ---------------------------------------------------------------------------

let big = "# Large\n\n";
for (let i = 0; i < 1200; i += 1) {
  big += `Paragraph ${i} with **bold** and $x_${i}^2$ and \`code\`.\n\n`;
}
const large = renderChunks(big, { math: true, map: true });
check("large: many chunks", large.chunks.length > 1000, `${large.chunks.length}`);
check("large: every non-silent chunk is non-empty", large.chunks.filter(Boolean).length > 1000);
check("large: line list matches the blocks", large.lines !== null && large.lines.length > 1000);
check(
  "large: every formula is rendered",
  large.maths.every((entry) => entry.html !== null),
);

const seconds = Number(process.env.MDRAFT_PREVIEW_PERF_SECONDS ?? "0");
if (seconds > 0) {
  const started = performance.now();
  renderChunks(big, { math: true, map: true });
  const elapsed = (performance.now() - started) / 1000;
  check(
    "large: render stays under the recorded budget",
    elapsed < seconds,
    `${elapsed.toFixed(2)}s`,
  );
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
