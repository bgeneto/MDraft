//! Phase-by-phase unit checks for prose preview optimizations (Phases 1–3).
//!
//! Run with Node 24: node scripts/prose-phase-unit.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearKatexCache,
  katexCacheSize,
  MAX_KATEX_LRU,
  renderKatexCached,
} from "../src/katex-cache.ts";
import { analyzeMath, hasMathDelimiters } from "../src/math-delimiters.ts";
import { markdownScanProtectedAndCode } from "../src/markdown-context.ts";
import {
  adaptiveProseDelay,
  PROSE_DELAY_BOUNDS,
  ProseDelayTracker,
} from "../src/prose-scheduler.ts";
import {
  AsciidocIncludeCache,
  preloadAsciidocIncludes,
  renderAsciidocChunks,
} from "../src/asciidoc-render.ts";

let passed = 0;
let failed = 0;

function check(label, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}

console.log("=== Phase 1: adaptive prose scheduler ===");
check(
  "Markdown bounds clamp to 60..200 ms",
  PROSE_DELAY_BOUNDS.markdown.minMs === 60 &&
    PROSE_DELAY_BOUNDS.markdown.maxMs === 200 &&
    adaptiveProseDelay("markdown", 1) === 60 &&
    adaptiveProseDelay("markdown", 500) === 200,
);
check(
  "AsciiDoc bounds clamp to 60..250 ms",
  PROSE_DELAY_BOUNDS.asciidoc.minMs === 60 &&
    PROSE_DELAY_BOUNDS.asciidoc.maxMs === 250 &&
    adaptiveProseDelay("asciidoc", 2) === 60 &&
    adaptiveProseDelay("asciidoc", 500) === 250,
);
{
  const tracker = new ProseDelayTracker();
  const coldMd = tracker.delay("markdown");
  tracker.record("markdown", 10);
  const fastMd = tracker.delay("markdown");
  tracker.record("asciidoc", 120);
  const slowAdoc = tracker.delay("asciidoc");
  const backToMd = tracker.delay("markdown");
  check(
    "ProseDelayTracker tracks EMA per language and lowers fast-render quiet delay",
    coldMd === 200 && fastMd < coldMd && slowAdoc >= 200 && backToMd === fastMd,
    `cold=${coldMd}, fast=${fastMd}, adoc=${slowAdoc}`,
  );
  tracker.reset("markdown");
  check("reset clears tracked language EMA back to initial", tracker.delay("markdown") === 200);
}

console.log("\n=== Phase 1: math delimiter guard & single-lex scan ===");
check(
  "hasMathDelimiters rejects plain prose",
  !hasMathDelimiters("Hello plain prose without delimiters."),
);
check(
  "hasMathDelimiters detects $, \\(, and \\[",
  hasMathDelimiters("$x$") && hasMathDelimiters("\\(x\\)") && hasMathDelimiters("\\[x\\]"),
);
{
  const src = "Plain `inline code` with no math and ```\nfenced\n``` block.";
  const scan = markdownScanProtectedAndCode(src, true);
  const analysis = analyzeMath(src, { singleDollar: true }, undefined, scan.protectedRanges);
  check(
    "analyzeMath skips delimiter work while preserving protected code spans",
    analysis.math.length === 0 && scan.codeSpans.length === 1 && scan.protectedRanges.length >= 2,
    `codeSpans=${scan.codeSpans.length}, protected=${scan.protectedRanges.length}`,
  );
}

console.log("\n=== Phase 1: bounded KaTeX LRU memoization ===");
clearKatexCache();
{
  const a = renderKatexCached("x^2 + y^2", false);
  const b = renderKatexCached("x^2 + y^2", false);
  const c = renderKatexCached("x^2 + y^2", true);
  check(
    "KaTeX cache returns identical markup for repeat formulas and separates inline/display",
    a.html !== null &&
      a.html === b.html &&
      c.html !== null &&
      c.html !== a.html &&
      katexCacheSize() === 2,
  );
  for (let i = 0; i < MAX_KATEX_LRU + 50; i += 1) {
    renderKatexCached(`x_{${i}}`, false);
  }
  assert.equal(katexCacheSize(), MAX_KATEX_LRU);
  check(
    "KaTeX LRU never exceeds MAX_KATEX_LRU",
    katexCacheSize() === MAX_KATEX_LRU,
    `${katexCacheSize()}`,
  );
  clearKatexCache();
}

console.log("\n=== Phase 1: AsciiDoc F09 include cache & worker math pre-rendering ===");
{
  const dir = mkdtempSync(join(tmpdir(), "mdraft-phase1-unit-"));
  try {
    const partPath = join(dir, "part.adoc").replace(/\\/g, "/");
    writeFileSync(partPath, "== Included\n\nBody text.\n");
    const doc = "= Doc\n\ninclude::part.adoc[]\n\n////\ninclude::ignored.adoc[]\n////\n";
    let reads = 0;
    const cache = new AsciidocIncludeCache();
    const readFile = async (p) => {
      reads += 1;
      assert.equal(p.replace(/\\/g, "/"), partPath);
      return "== Included\n\nBody text.\n";
    };
    const first = await preloadAsciidocIncludes(doc, { baseDir: dir, readFile, cache });
    const second = await preloadAsciidocIncludes(doc, { baseDir: dir, readFile, cache });
    const third = await preloadAsciidocIncludes(doc, { baseDir: dir, readFile, cache });
    check(
      "F09 include cache avoids repeat readFile IPC across unchanged edits (0 extra reads)",
      reads === 1 &&
        first !== null &&
        second !== null &&
        third !== null &&
        cache.stats().hits === 2,
      `reads=${reads}, hits=${cache.stats().hits}`,
    );
    cache.invalidate(partPath);
    await preloadAsciidocIncludes(doc, { baseDir: dir, readFile, cache });
    check(
      "F09 cache invalidation triggers a fresh read on next pass",
      reads === 2,
      `reads=${reads}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const asciidoc = [
    "= Math Test",
    ":stem: asciimath",
    "",
    "Inline stem:[sqrt(9) = 3], latexmath:[a < b], raw \\(x + y\\).",
    "",
    "[stem]",
    "++++",
    "x^2 + 1",
    "sqrt(4) = 2",
    "++++",
    "",
    "[source,latex]",
    "----",
    "\\(should_not_render\\)",
    "----",
    "",
  ].join("\n");
  const chunks = await renderAsciidocChunks(asciidoc, { baseDir: null, math: true, includes: {} });
  const joined = chunks.chunks.join("\n");
  check(
    "AsciiDoc worker marks mathRendered and pre-renders stems + raw text TeX into maths table",
    chunks.mathRendered === true &&
      Array.isArray(chunks.maths) &&
      chunks.maths.length === 5 &&
      chunks.maths.every((m) => typeof m.html === "string" && m.html.includes("katex")) &&
      joined.includes('data-mdraft-math="0"') &&
      joined.includes("\\(should_not_render\\)"),
    `maths=${chunks.maths?.length ?? 0}`,
  );
  check(
    "latexmath inequality preserves literal '<' after entity decoding",
    chunks.maths?.some((m) => m.body.trim() === "a < b") ?? false,
    JSON.stringify(chunks.maths?.map((m) => m.body)),
  );
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
