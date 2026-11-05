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
