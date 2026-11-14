//! Phase 0 & multi-phase prose rendering benchmark + golden equivalence oracle.
//!
//! Runs directly in Node 24 without Tauri or Vite, using zero extra npm packages:
//!   node scripts/prose-render-bench.mjs
//!   node scripts/prose-render-bench.mjs --verify-equivalence
//!   node scripts/prose-render-bench.mjs --json-only
//!
//! Prints a human-readable summary table and a single-line `PROSE_BENCH_JSON `
//! payload for cross-run MDE comparisons (`MDE = max(|L1 - L2|, 2 * MAD)`).

import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import * as previewRender from "../src/preview-render.ts";
import { analyzeMath } from "../src/math-delimiters.ts";
import { markdownCodeSpans } from "../src/markdown-context.ts";
import * as asciidocRender from "../src/asciidoc-render.ts";

const { renderChunks } = previewRender;
const { preloadAsciidocIncludes, renderAsciidocChunks } = asciidocRender;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const args = new Set(process.argv.slice(2));
const VERIFY_EQUIVALENCE = args.has("--verify-equivalence");
const JSON_ONLY = args.has("--json-only");

function parseIntArg(prefix, fallback) {
  for (const raw of process.argv.slice(2)) {
    if (raw.startsWith(prefix)) {
      const value = Number.parseInt(raw.slice(prefix.length), 10);
      if (Number.isFinite(value) && value >= 1) return value;
    }
  }
  return fallback;
}

const WARMUP_RUNS = parseIntArg("--warmup=", 5);
const BENCH_RUNS = parseIntArg("--runs=", 20);

function round(value, digits = 3) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function computeStats(coldMs, samples) {
  const p50 = median(samples);
  const p95 = percentile(samples, 95);
  const deviations = samples.map((x) => Math.abs(x - p50));
  const mad = median(deviations);
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  return {
    coldMs: round(coldMs),
    p50Ms: round(p50),
    p95Ms: round(p95),
    madMs: round(mad),
    minMs: round(min),
    maxMs: round(max),
    runs: samples.length,
  };
}

function measureSync(fn, warmup = WARMUP_RUNS, runs = BENCH_RUNS) {
  const tCold0 = performance.now();
  const coldResult = fn();
  const coldMs = performance.now() - tCold0;

  for (let i = 0; i < warmup; i++) {
    fn();
  }

  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return { stats: computeStats(coldMs, samples), lastResult: coldResult };
}

async function measureAsync(fn, warmup = WARMUP_RUNS, runs = BENCH_RUNS) {
  const tCold0 = performance.now();
  const coldResult = await fn();
  const coldMs = performance.now() - tCold0;

  for (let i = 0; i < warmup; i++) {
    await fn();
  }

  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return { stats: computeStats(coldMs, samples), lastResult: coldResult };
}

// ---------------------------------------------------------------------------
// Deterministic Phase 0 Corpus Generators / Loaders
// ---------------------------------------------------------------------------

const MATH_EXPRESSIONS = [
  "E = mc^2 + \\frac{\\hbar^2 k^2}{2m^*}",
  "\\int_{-\\infty}^{\\infty} e^{-\\alpha x^2} \\, dx = \\sqrt{\\frac{\\pi}{\\alpha}}",
  "\\sum_{n=1}^{\\infty} \\frac{(-1)^{n-1}}{n^s} = (1 - 2^{1-s})\\zeta(s)",
  "\\nabla \\times \\mathbf{B} = \\mu_0 \\mathbf{J} + \\mu_0 \\varepsilon_0 \\frac{\\partial \\mathbf{E}}{\\partial t}",
  "\\det(A - \\lambda I) = \\prod_{j=1}^{k} (\\lambda_j - \\lambda)^{m_j}",
  "G(k, \\omega) = \\frac{1}{\\omega - \\varepsilon_k - \\Sigma(k, \\omega) + i\\eta}",
];

function buildMarkdownWithMath({
  sections,
  eqPerSection,
  filler = "Calibration checks boundary stability and clean incremental chunk isolation.",
}) {
  const lines = [
    "# Deterministic Benchmark Manuscript",
    "",
    "Overview paragraph with **bold** and *italic* prose without raw HTML.",
    "",
  ];
  let eqCounter = 0;
  for (let s = 0; s < sections; s++) {
    lines.push(`## Section ${s + 1}: Estimate ${s + 1}`);
    lines.push("");
    for (let e = 0; e < eqPerSection; e++) {
      const expr = MATH_EXPRESSIONS[(s + e) % MATH_EXPRESSIONS.length];
      const isDisplay = e % 4 === 3;
      if (isDisplay) {
        lines.push(`Block ${eqCounter} introduces \`n_${s}_${e}\` at midanchor_${eqCounter}.`);
        lines.push("");
        lines.push(`$$\n${expr} + \\delta_{${s},${e}}\n$$`);
        lines.push("");
      } else {
        lines.push(
          `Block ${eqCounter} solves $${expr}$ near midanchor_${eqCounter} (\`k_${e}\`). ${filler}`,
        );
        lines.push("");
      }
      eqCounter++;
    }
  }
  return lines.join("\n");
}

function buildPlainProseMarkdown(paragraphs) {
  const lines = [
    "# Plain Prose Longform Corpus",
    "",
    "Introductory summary with **emphasis**, *cadence*, `inline_symbol`, and structured prose free of TeX delimiters.",
    "",
  ];
  const sampleSentences = [
    "Incremental reconciliation isolates untouched sibling blocks so local edits never rebuild unrelated DOM subtrees.",
    "Careful boundary scanning prevents cross-token state corruption when fenced code or reference links appear.",
    "Typographic rhythm relies on predictable paragraph spacing, crisp monospace tokens, and zero runtime telemetry.",
    "Scroll stabilization requires exact source-to-fragment line offsets before the first painted browser frame.",
  ];
  for (let i = 0; i < paragraphs; i++) {
    if (i % 12 === 0) {
      lines.push(`## Chapter ${Math.floor(i / 12) + 1}: Editorial Architecture`);
      lines.push("");
    }
    if (i % 25 === 5) {
      lines.push("```ts");
      lines.push(`export function blockKey${i}(index: number): string {`);
      lines.push(`  return \`block-\${index}-\${(index * 31) % 997}\`;`);
      lines.push("}");
      lines.push("```");
      lines.push("");
      continue;
    }
    const s0 = sampleSentences[i % sampleSentences.length];
    const s1 = sampleSentences[(i + 1) % sampleSentences.length];
    const s2 = sampleSentences[(i + 2) % sampleSentences.length];
    lines.push(
      `Paragraph ${i} with **bold_phrase_${i}** and midanchor_${i} notes \`sample_${i % 64}\`. ${s0} ${s1} ${s2}`,
    );
    lines.push("");
  }
  return lines.join("\n");
}

function buildExpandedAsciidocTour(baseTourText) {
  const blocks = [baseTourText.trimEnd(), ""];
  for (let i = 0; i < 42; i++) {
    blocks.push(`== Extended Section ${i + 1}: Stem, Code and Diagrams`);
    blocks.push("");
    blocks.push(
      `Section paragraph ${i} examines midanchor_${i} together with inline stem: latexmath:[\\alpha_${i} + \\beta^2 = \\gamma] and *strong emphasis*.`,
    );
    blocks.push("");
    blocks.push("[source,js]");
    blocks.push("----");
    blocks.push(`function verifyChunk${i}(line) {`);
    blocks.push(`  return \`sec-${i}:\${line}\`;`);
    blocks.push("}");
    blocks.push("----");
    blocks.push("");
    if (i % 4 === 0) {
      blocks.push("[source,mermaid]");
      blocks.push("----");
      blocks.push("flowchart LR");
      blocks.push(`  Edit${i} --> Parse${i} --> Patch${i}`);
      blocks.push("----");
      blocks.push("");
    }
    if (i % 2 === 0) {
      blocks.push("[stem]");
      blocks.push("++++");
      blocks.push(`\\sum_{k=1}^{${i + 3}} \\frac{1}{k^2} \\approx \\frac{\\pi^2}{6}`);
      blocks.push("++++");
      blocks.push("");
    }
  }
  return blocks.join("\n");
}

function buildLargeAsciidoc(paragraphs = 2050) {
  const lines = [
    "= Large AsciiDoc Performance Document",
    "MDraft Benchmark",
    ":stem: latexmath",
    "",
    "Introductory overview block containing midanchor_0 and *benchmark* text.",
    "",
  ];
  const sentences = [
    "AsciiDoc conversion wraps document sections while tree processors track source line positions for scroll syncing.",
    "Sub-section chunking shrinks edit blast radius from a whole section subtree down to individual blocks and paragraphs.",
    "Keyed patching preserves untouched DOM paragraphs, tables, and rendered diagram containers across edits.",
  ];
  for (let i = 0; i < paragraphs; i++) {
    if (i % 20 === 0) {
      lines.push(`== Section ${Math.floor(i / 20) + 1}: Subsystem Analysis`);
      lines.push("");
    }
    if (i % 80 === 15) {
      lines.push("[source,ts]");
      lines.push("----");
      lines.push(`const checksum${i} = (n: number) => (n * 2654435761) >>> 0;`);
      lines.push("----");
      lines.push("");
      continue;
    }
    if (i % 90 === 30) {
      lines.push(`Inline latexmath:[x_{${i}} = \\sqrt{a^2 + b^2}] sits mid-paragraph.`);
      lines.push("");
      continue;
    }
    lines.push(
      `Paragraph ${i} references midanchor_${i} in \`unit_${i % 100}\`. ${sentences[i % sentences.length]} ${sentences[(i + 1) % sentences.length]}`,
    );
    lines.push("");
  }
  return lines.join("\n");
}

async function createCorpus() {
  const samplesDir = path.join(REPO_ROOT, "samples");
  const physrevPath = path.join(samplesDir, "math-render.md");
  const tourPath = path.join(samplesDir, "asciidoc-tour.adoc");
  const includeSamplePath = path.join(samplesDir, "asciidoc-include.adoc");

  const [physrevText, rawTourText, rawIncludeSample] = await Promise.all([
    fsp.readFile(physrevPath, "utf8"),
    fsp.readFile(tourPath, "utf8"),
    fsp.readFile(includeSamplePath, "utf8"),
  ]);

  const mdSmallMath = buildMarkdownWithMath({
    sections: 10,
    eqPerSection: 6,
    filler:
      "Calibration checks boundary stability, repeatable step response, and incremental isolation.",
  });
  const mdPlainProse = buildPlainProseMarkdown(174);
  const mdLargeMath = buildMarkdownWithMath({
    sections: 80,
    eqPerSection: 15,
    filler:
      "Experimental calibration verifies stable boundary conditions and clean incremental chunk isolation across editorial edits.",
  });
  const adocTourExpanded = buildExpandedAsciidocTour(rawTourText);
  const adocLarge = buildLargeAsciidoc(2060);

  const includeTempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mdraft-prose-inc-"));
  const incNestedDir = path.join(includeTempDir, "chapters");
  await fsp.mkdir(incNestedDir, { recursive: true });
  await Promise.all([
    fsp.writeFile(path.join(includeTempDir, "asciidoc-include.adoc"), rawIncludeSample, "utf8"),
    fsp.writeFile(
      path.join(incNestedDir, "part-a.adoc"),
      [
        "== Nested Part A",
        "",
        "Paragraph inside nested chapter referencing `part-a` and midanchor_inc.",
        "",
        "include::leaf.adoc[]",
        "",
      ].join("\n"),
      "utf8",
    ),
    fsp.writeFile(
      path.join(incNestedDir, "leaf.adoc"),
      [
        "=== Leaf Section",
        "",
        "Leaf content with *nested* include semantics and stem latexmath:[y = mx + b].",
        "",
      ].join("\n"),
      "utf8",
    ),
  ]);

  const adocIncludesRoot = [
    "= Multi-Include Benchmark Document",
    ":stem: latexmath",
    ":toc:",
    "",
    "Lead paragraph referencing midanchor_root before included chapters.",
    "",
    "include::asciidoc-include.adoc[]",
    "",
    "include::chapters/part-a.adoc[]",
    "",
  ].join("\n");

  const items = [
    {
      id: "md-small-math",
      kind: "markdown",
      source: mdSmallMath,
      description: "Generated ~13.6 KB, 60 KaTeX equations",
    },
    {
      id: "md-math-dense",
      kind: "markdown",
      source: physrevText,
      sourcePath: path.relative(REPO_ROOT, physrevPath).replace(/\\/g, "/"),
      description: "samples/math-render.md (292 synthetic equations and raw HTML)",
    },
    {
      id: "md-plain-prose",
      kind: "markdown",
      source: mdPlainProse,
      description: "Generated ~67.8 KB, zero math delimiters",
    },
    {
      id: "md-large-math",
      kind: "markdown",
      source: mdLargeMath,
      description: "Generated ~274 KB, 1,200 KaTeX equations",
    },
    {
      id: "adoc-tour",
      kind: "asciidoc",
      source: adocTourExpanded,
      rawSampleBytes: Buffer.byteLength(rawTourText, "utf8"),
      baseDir: samplesDir,
      sourcePath: path.relative(REPO_ROOT, tourPath).replace(/\\/g, "/"),
      description:
        "samples/asciidoc-tour.adoc expanded to ~16 KB (stem + code + mermaid + include)",
    },
    {
      id: "adoc-includes",
      kind: "asciidoc",
      source: adocIncludesRoot,
      rawSampleBytes: Buffer.byteLength(rawIncludeSample, "utf8"),
      baseDir: includeTempDir,
      sourcePath: path.relative(REPO_ROOT, includeSamplePath).replace(/\\/g, "/"),
      description: "samples/asciidoc-include.adoc multi-include tree",
    },
    {
      id: "adoc-large",
      kind: "asciidoc",
      source: adocLarge,
      baseDir: null,
      description: "Generated ~555 KB AsciiDoc (~104 sections)",
    },
  ];

  return {
    items,
    cleanup: async () => {
      await fsp.rm(includeTempDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Chunk Invariance Diffing (Longest-Common-Prefix/Suffix + LCS on dirty span)
// ---------------------------------------------------------------------------

/** Compute longest common subsequence length of hash-ID'd string arrays. */
function lcsMatchedCount(a, b) {
  if (a.length === 0 || b.length === 0) return 0;
  // Map unique chunk strings to compact integers so DP compares scalars.
  const ids = new Map();
  let nextId = 1;
  const encode = (arr) =>
    arr.map((s) => {
      let id = ids.get(s);
      if (id === undefined) {
        id = nextId++;
        ids.set(s, id);
      }
      return id;
    });
  const aIds = encode(a);
  const bIds = encode(b);

  // If the dirty middle window is very large (e.g., Phase 0 global ripple),
  // hunt-style Patience / index-map DP avoids O(M*N) quadratic allocation.
  const bPositions = new Map();
  for (let j = bIds.length - 1; j >= 0; j--) {
    const id = bIds[j];
    let list = bPositions.get(id);
    if (!list) {
      list = [];
      bPositions.set(id, list);
    }
    list.push(j);
  }

  // O(matches * log(matches)) LIS over decreasing b-indices per a[i]
  const tails = [];
  for (let i = 0; i < aIds.length; i++) {
    const positions = bPositions.get(aIds[i]);
    if (!positions) continue;
    for (let p = 0; p < positions.length; p++) {
      const idx = positions[p];
      let lo = 0;
      let hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (tails[mid] < idx) lo = mid + 1;
        else hi = mid;
      }
      tails[lo] = idx;
    }
  }
  return tails.length;
}

/** Exact LCS indices on non-empty rendered chunks so dirty ratios exclude empty `"space"` tokens. */
function diffChunkStats(rawBeforeChunks, rawAfterChunks) {
  const beforeChunks = rawBeforeChunks.filter((c) => c.trim().length > 0);
  const afterChunks = rawAfterChunks.filter((c) => c.trim().length > 0);
  const totalChunks = Math.max(beforeChunks.length, afterChunks.length);
  const afterBytesPerChunk = afterChunks.map((c) => Buffer.byteLength(c, "utf8"));
  const totalAfterBytes = afterBytesPerChunk.reduce((sum, n) => sum + n, 0);

  if (totalChunks === 0) {
    return {
      beforeChunks: 0,
      afterChunks: 0,
      unchangedChunks: 0,
      dirtyChunks: 0,
      dirtyChunksRatio: 0,
      totalAfterBytes: 0,
      dirtyAfterBytes: 0,
      dirtyHtmlBytesRatio: 0,
    };
  }

  let prefix = 0;
  const minLen = Math.min(beforeChunks.length, afterChunks.length);
  while (prefix < minLen && beforeChunks[prefix] === afterChunks[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    beforeChunks.length - suffix > prefix &&
    afterChunks.length - suffix > prefix &&
    beforeChunks[beforeChunks.length - 1 - suffix] === afterChunks[afterChunks.length - 1 - suffix]
  ) {
    suffix++;
  }

  const midBefore = beforeChunks.slice(prefix, beforeChunks.length - suffix);
  const midAfter = afterChunks.slice(prefix, afterChunks.length - suffix);

  // Recover which exact indices in `midAfter` remain identical via LIS backtrack
  let preservedMidBytes = 0;
  let midMatches = 0;
  if (midBefore.length > 0 && midAfter.length > 0) {
    const midCount = lcsMatchedCount(midBefore, midAfter);
    midMatches = midCount;
    if (midCount > 0) {
      // Conservative matching of unique values for byte credit; prefix/suffix already captures 99%+.
      const beforeSet = new Map();
      for (const s of midBefore) beforeSet.set(s, (beforeSet.get(s) ?? 0) + 1);
      let credited = 0;
      for (const s of midAfter) {
        if (credited >= midCount) break;
        const avail = beforeSet.get(s) ?? 0;
        if (avail > 0) {
          beforeSet.set(s, avail - 1);
          preservedMidBytes += Buffer.byteLength(s, "utf8");
          credited++;
        }
      }
    }
  }

  const unchangedChunks = prefix + suffix + midMatches;
  const dirtyChunks = Math.max(0, totalChunks - unchangedChunks);

  let preservedBytes = preservedMidBytes;
  for (let i = 0; i < prefix; i++) preservedBytes += afterBytesPerChunk[i];
  for (let i = afterChunks.length - suffix; i < afterChunks.length; i++) {
    preservedBytes += afterBytesPerChunk[i];
  }
  const dirtyAfterBytes = Math.max(0, totalAfterBytes - preservedBytes);

  return {
    beforeChunks: beforeChunks.length,
    afterChunks: afterChunks.length,
    unchangedChunks,
    dirtyChunks,
    dirtyChunksRatio: round(dirtyChunks / totalChunks, 6),
    totalAfterBytes,
    dirtyAfterBytes,
    dirtyHtmlBytesRatio: totalAfterBytes > 0 ? round(dirtyAfterBytes / totalAfterBytes, 6) : 0,
  };
}

function makeMarkdownEdits(source) {
  const mid = Math.floor(source.length * 0.5);
  const lineStart = source.lastIndexOf("\n", mid) + 1;
  const lineEnd = source.indexOf("\n", mid);
  const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);

  // Pick a plain prose word inside the middle section, avoiding `$`/`\`/`[`/`]`/`*`
  let singleChar = source;
  let boldWrap = source;
  let newlineSplit = source;
  let codeInsert = source;

  const anchorMatch =
    /\b(midanchor_\d+|reference_\d+|boundary|conditions|spectral|system|electron|state)\b/i.exec(
      source.slice(lineStart),
    );
  if (anchorMatch) {
    const pos = lineStart + anchorMatch.index;
    const word = anchorMatch[0];
    singleChar = source.slice(0, pos + word.length) + "x" + source.slice(pos + word.length);
    boldWrap = source.slice(0, pos) + `**${word}**` + source.slice(pos + word.length);
    newlineSplit =
      source.slice(0, pos + word.length) + "\n\n" + source.slice(pos + word.length).trimStart();
    codeInsert = source.slice(0, pos + word.length) + " `v0`" + source.slice(pos + word.length);
  } else {
    const safeOffset = Math.min(source.length, lineStart + Math.floor(line.length / 2));
    singleChar = source.slice(0, safeOffset) + "x" + source.slice(safeOffset);
    boldWrap = source.slice(0, safeOffset) + " **bold** " + source.slice(safeOffset);
    newlineSplit = source.slice(0, safeOffset) + "\n\n" + source.slice(safeOffset);
    codeInsert = source.slice(0, safeOffset) + " `v0` " + source.slice(safeOffset);
  }

  return { singleChar, boldWrap, newlineSplit, codeInsert };
}

function makeAsciidocEdits(source) {
  const mid = Math.floor(source.length * 0.5);
  const searchAreaStart = Math.max(0, mid - 400);
  const anchorMatch = /\b(midanchor_\d+|midanchor_root|AsciiDoc|Section|paragraph|include)\b/.exec(
    source.slice(searchAreaStart),
  );
  let pos = mid;
  let len = 0;
  let word = "edit";
  if (anchorMatch) {
    pos = searchAreaStart + anchorMatch.index;
    word = anchorMatch[0];
    len = word.length;
  }
  const singleChar = source.slice(0, pos + len) + "x" + source.slice(pos + len);
  const newlineSplit = source.slice(0, pos + len) + "\n\n" + source.slice(pos + len).trimStart();
  return { singleChar, newlineSplit };
}

// ---------------------------------------------------------------------------
// Optional Proxy Breakdowns (when `blockLines` / `elementLinesFor` unexposed)
// ---------------------------------------------------------------------------

async function loadOptionalProxies() {
  const [markedMod, parse5Mod] = await Promise.all([
    import("marked").catch(() => null),
    import("parse5").catch(() => null),
  ]);
  return { markedMod, parse5Mod };
}

// ---------------------------------------------------------------------------
// Main Benchmark Runner
// ---------------------------------------------------------------------------

async function benchmarkCorpus(corpus, proxies) {
  const results = [];

  for (const doc of corpus) {
    const bytes = Buffer.byteLength(doc.source, "utf8");
    if (doc.kind === "markdown") {
      const codeSpansRes = measureSync(() => markdownCodeSpans(doc.source));
      const analyzeMathRes = measureSync(() => analyzeMath(doc.source, true, true));
      const renderBaseRes = measureSync(() =>
        renderChunks(doc.source, { math: false, map: false }),
      );
      const renderMathRes = measureSync(() => renderChunks(doc.source, { math: true, map: false }));
      const renderFullRes = measureSync(() => renderChunks(doc.source, { math: true, map: true }));

      // Direct breakdown hooks if exposed by Phase 0.5 / 1+, else null + explicit proxy timing
      const blockLinesExposed =
        typeof previewRender.blockLines === "function" ? previewRender.blockLines : null;
      const elementLinesExposed =
        typeof previewRender.elementLinesFor === "function" ? previewRender.elementLinesFor : null;

      let blockLinesStats = null;
      if (blockLinesExposed) {
        const tokens = proxies.markedMod ? new proxies.markedMod.Marked().lexer(doc.source) : null;
        if (tokens) {
          blockLinesStats = measureSync(() => blockLinesExposed(doc.source, tokens)).stats;
        }
      }

      let markedLexerProxyStats = null;
      if (proxies.markedMod) {
        const { Marked } = proxies.markedMod;
        markedLexerProxyStats = measureSync(() => new Marked().lexer(doc.source)).stats;
      }

      const full = renderFullRes.lastResult;
      const joinedHtml = full.chunks.join("\n");

      let elementLinesStats = null;
      if (elementLinesExposed && full.hasRawHtml) {
        elementLinesStats = measureSync(() =>
          elementLinesExposed(joinedHtml, full.lines ?? []),
        ).stats;
      }

      let parse5ProxyStats = null;
      if (proxies.parse5Mod && full.hasRawHtml) {
        parse5ProxyStats = measureSync(() =>
          proxies.parse5Mod.parseFragment(joinedHtml, { sourceCodeLocationInfo: true }),
        ).stats;
      }

      const edits = makeMarkdownEdits(doc.source);
      const afterSingle = renderChunks(edits.singleChar, { math: true, map: true });
      const afterBold = renderChunks(edits.boldWrap, { math: true, map: true });
      const afterSplit = renderChunks(edits.newlineSplit, { math: true, map: true });
      const afterCodeInsert = renderChunks(edits.codeInsert, { math: true, map: true });

      const renderIncRes =
        typeof previewRender.renderChunksIncremental === "function"
          ? measureSync(() =>
              previewRender.renderChunksIncremental(doc.source, full, edits.singleChar, {
                math: true,
                map: true,
              }),
            )
          : null;

      const renderedChunkCount = full.chunks.filter((c) => c.trim().length > 0).length;
      const mathCount = analyzeMathRes.lastResult.math.length;
      results.push({
        id: doc.id,
        kind: "markdown",
        sourcePath: doc.sourcePath ?? null,
        description: doc.description,
        bytes,
        equations: mathCount,
        hasRawHtml: full.hasRawHtml,
        rawChunkCount: full.chunks.length,
        chunkCount: renderedChunkCount,
        fragmentCount: full.fragments ? full.fragments.length : 0,
        incrementalMeta: renderIncRes
          ? {
              mode: renderIncRes.lastResult.incremental?.mode ?? null,
              dirtyRatio: renderIncRes.lastResult.incremental?.dirtyRatio ?? null,
              dirtyBlocks: renderIncRes.lastResult.incremental?.dirtyBlocks ?? null,
            }
          : null,
        timings: {
          renderFull: renderFullRes.stats,
          renderIncremental: renderIncRes ? renderIncRes.stats : null,
          renderMathOnly: renderMathRes.stats,
          renderBase: renderBaseRes.stats,
          analyzeMath: analyzeMathRes.stats,
          markdownCodeSpans: codeSpansRes.stats,
          blockLines: blockLinesStats,
          markedLexerProxy: markedLexerProxyStats,
          elementLinesFor: elementLinesStats,
          parse5Proxy: parse5ProxyStats,
        },
        invariance: {
          singleChar: diffChunkStats(full.chunks, afterSingle.chunks),
          boldWrap: diffChunkStats(full.chunks, afterBold.chunks),
          newlineSplit: diffChunkStats(full.chunks, afterSplit.chunks),
          codeInsert: diffChunkStats(full.chunks, afterCodeInsert.chunks),
        },
      });
    } else {
      let readCalls = 0;
      const readFile = async (requestedPath) => {
        readCalls++;
        const resolved = doc.baseDir
          ? path.isAbsolute(requestedPath)
            ? requestedPath
            : path.resolve(doc.baseDir, requestedPath)
          : requestedPath;
        return fsp.readFile(resolved, "utf8");
      };

      const preloadRes = await measureAsync(async () => {
        readCalls = 0;
        if (!doc.baseDir) return null;
        return preloadAsciidocIncludes(doc.source, { baseDir: doc.baseDir, readFile });
      });

      const preloadedIncludes = preloadRes.lastResult ?? {};
      const renderOpts = {
        baseDir: doc.baseDir,
        math: true,
        includes: preloadedIncludes,
      };
      const renderNoMathOpts = {
        baseDir: doc.baseDir,
        math: false,
        includes: preloadedIncludes,
      };

      const renderFullRes = await measureAsync(() => renderAsciidocChunks(doc.source, renderOpts));
      const renderBaseRes = await measureAsync(() =>
        renderAsciidocChunks(doc.source, renderNoMathOpts),
      );
      const full = renderFullRes.lastResult;

      const edits = makeAsciidocEdits(doc.source);
      const afterSingle = await renderAsciidocChunks(edits.singleChar, renderOpts);
      const afterSplit = await renderAsciidocChunks(edits.newlineSplit, renderOpts);
      const renderIncRes =
        typeof asciidocRender.renderAsciidocChunksIncremental === "function"
          ? await measureAsync(() =>
              asciidocRender.renderAsciidocChunksIncremental(
                doc.source,
                full,
                edits.singleChar,
                renderOpts,
              ),
            )
          : null;

      results.push({
        id: doc.id,
        kind: "asciidoc",
        sourcePath: doc.sourcePath ?? null,
        description: doc.description,
        bytes,
        rawSampleBytes: doc.rawSampleBytes ?? null,
        includeCount: Object.keys(preloadedIncludes).length,
        preloadReadCalls: readCalls,
        rawChunkCount: full.chunks.length,
        chunkCount: full.chunks.filter((c) => c.trim().length > 0).length,
        markCount: full.marks.length,
        hasHeader: full.hasHeader,
        incrementalMeta: renderIncRes
          ? {
              mode: renderIncRes.lastResult.incremental?.mode ?? null,
              dirtyRatio: renderIncRes.lastResult.incremental?.dirtyRatio ?? null,
              dirtyBlocks: renderIncRes.lastResult.incremental?.dirtyBlocks ?? null,
            }
          : null,
        timings: {
          renderFull: renderFullRes.stats,
          renderIncremental: renderIncRes ? renderIncRes.stats : null,
          renderBase: renderBaseRes.stats,
          preloadIncludes: doc.baseDir ? preloadRes.stats : null,
        },
        invariance: {
          singleChar: diffChunkStats(full.chunks, afterSingle.chunks),
          newlineSplit: diffChunkStats(full.chunks, afterSplit.chunks),
        },
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Deterministic Golden Equivalence Suite (--verify-equivalence)
// ---------------------------------------------------------------------------

function resolveChunkPlaceholders(chunksResult) {
  const blocks =
    Array.isArray(chunksResult.blocks) && !chunksResult.hasRawHtml ? chunksResult.blocks : null;
  return chunksResult.chunks.map((chunk, chunkIdx) => {
    const localCodes = blocks?.[chunkIdx]?.codes ?? chunksResult.codes;
    const localMaths = blocks?.[chunkIdx]?.maths ?? chunksResult.maths;
    return chunk
      .replace(/@@CODE(\d+)@@/g, (_, idx) => {
        const entry = localCodes[Number(idx)];
        return entry ? previewRender.escapeHtml(entry.text) : `@@MISSING_CODE_${idx}@@`;
      })
      .replace(/@@MATH(\d+)@@/g, (_, idx) => {
        const entry = localMaths[Number(idx)];
        if (!entry) return `@@MISSING_MATH_${idx}@@`;
        return entry.html ?? previewRender.escapeHtml(entry.body);
      });
  });
}

function assertValidMarkdownResult(result, label) {
  assert.ok(Array.isArray(result.chunks), `${label}: chunks must be an array`);
  const joinedResolved = resolveChunkPlaceholders(result).join("\n");
  assert.equal(
    /@@(?:CODE|MATH)\d+@@|@@MISSING_(?:CODE|MATH)_\d+@@/.test(joinedResolved),
    false,
    `${label}: unresolved code/math placeholders remain`,
  );
  if (result.lines) {
    assert.ok(
      result.lines.length > 0 || result.chunks.every((c) => c === ""),
      `${label}: empty lines`,
    );
    if (!result.hasRawHtml) {
      const visibleCount = result.chunks.filter((c) => c !== "").length;
      assert.equal(
        result.lines.length,
        visibleCount,
        `${label}: lines.length (${result.lines.length}) must match visible chunk count (${visibleCount})`,
      );
    }
    for (let i = 0; i < result.lines.length; i++) {
      assert.ok(result.lines[i] >= 1, `${label}: line numbers must be >= 1`);
      if (i > 0) {
        assert.ok(
          result.lines[i] >= result.lines[i - 1],
          `${label}: block line numbers must be non-decreasing`,
        );
      }
    }
  }
  if (result.fragments) {
    for (let i = 0; i < result.fragments.length; i++) {
      const f = result.fragments[i];
      assert.ok(f.src1 >= f.src0, `${label}: fragment ${i} invalid source range`);
    }
  }
  return joinedResolved;
}

async function runEquivalenceSuite() {
  const checks = [];
  let passed = 0;
  let failed = 0;

  async function runCheck(name, fn) {
    try {
      await fn();
      passed++;
      checks.push({ name, status: "PASS", error: null });
      if (!JSON_ONLY) console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : String(error);
      checks.push({ name, status: "FAIL", error: message });
      if (!JSON_ONLY) console.error(`FAIL  ${name}: ${message}`);
    }
  }

  // Optional Phase 3 incremental entry point hook (absent in Phase 0)
  const incrementalMd =
    typeof previewRender.renderChunksIncremental === "function"
      ? previewRender.renderChunksIncremental
      : null;

  const sampleDoc = buildMarkdownWithMath({
    sections: 6,
    eqPerSection: 5,
  });

  await runCheck(
    "eq-1: mid-doc insert preserves all placeholders, lines, fragments & Phase 3 parity",
    () => {
      const baseline = renderChunks(sampleDoc, { math: true, map: true });
      assertValidMarkdownResult(baseline, "baseline");
      const pos = sampleDoc.indexOf("midanchor_12") + "midanchor_12".length;
      const edited = sampleDoc.slice(0, pos) + "Z" + sampleDoc.slice(pos);
      const fresh = renderChunks(edited, { math: true, map: true });
      const freshHtml = assertValidMarkdownResult(fresh, "fresh-mid-insert");
      assert.ok(freshHtml.includes("midanchor_12Z"), "edited token visible in resolved HTML");
      if (incrementalMd) {
        const inc = incrementalMd(sampleDoc, baseline, edited, { math: true, map: true });
        const incHtml = assertValidMarkdownResult(inc, "inc-mid-insert");
        assert.equal(incHtml, freshHtml, "Phase 3 incremental resolved HTML matches fresh");
        assert.deepEqual(inc.lines, fresh.lines, "Phase 3 lines match fresh");
        assert.deepEqual(inc.fragments, fresh.fragments, "Phase 3 fragments match fresh");
      }
    },
  );

  await runCheck(
    "eq-2: bold wrap & paragraph split produce consistent blocks and monotonic lines",
    () => {
      const pos = sampleDoc.indexOf("midanchor_15");
      const boldEdited = sampleDoc.replace("midanchor_15", "**midanchor_15**");
      const splitEdited =
        sampleDoc.slice(0, pos + 12) + "\n\nSplit paragraph: " + sampleDoc.slice(pos + 12);

      const freshBold = renderChunks(boldEdited, { math: true, map: true });
      const boldHtml = assertValidMarkdownResult(freshBold, "bold-wrap");
      assert.match(
        boldHtml,
        /<strong>(?:<span data-f="\d+">)?midanchor_15(?:<\/span>)?<\/strong>/,
        "bold tag rendered",
      );

      const freshSplit = renderChunks(splitEdited, { math: true, map: true });
      const splitHtml = assertValidMarkdownResult(freshSplit, "newline-split");
      assert.ok(
        freshSplit.chunks.length > renderChunks(sampleDoc, { math: true, map: true }).chunks.length,
      );
      assert.ok(splitHtml.includes("Split paragraph:"), "split paragraph rendered");

      if (incrementalMd) {
        const base = renderChunks(sampleDoc, { math: true, map: true });
        const incSplit = incrementalMd(sampleDoc, base, splitEdited, { math: true, map: true });
        assert.equal(resolveChunkPlaceholders(incSplit).join("\n"), splitHtml);
        assert.deepEqual(incSplit.lines, freshSplit.lines);
      }
    },
  );

  await runCheck("eq-3: [TOC] + heading add/remove keeps TOC consistency", () => {
    const tocBefore = "# Alpha\n\n[TOC]\n\nText one.\n\n## Beta\n\nText two.\n";
    const tocAfter = `${tocBefore}\n## Gamma Added\n\nText three.\n`;
    const rBefore = renderChunks(tocBefore, { math: true, map: true });
    const rAfter = renderChunks(tocAfter, { math: true, map: true });
    assertValidMarkdownResult(rBefore, "toc-before");
    const htmlAfter = assertValidMarkdownResult(rAfter, "toc-after");
    assert.ok(htmlAfter.includes("Gamma Added"), "added heading appears in output");
    if (incrementalMd) {
      const inc = incrementalMd(tocBefore, rBefore, tocAfter, { math: true, map: true });
      assert.equal(resolveChunkPlaceholders(inc).join("\n"), htmlAfter);
    }
  });

  await runCheck("eq-4: cross-token raw HTML triggers hasRawHtml and tracks elementLines", () => {
    const rawHtmlDoc = [
      "# Raw HTML Wrapper",
      "",
      '<div class="callout">',
      "",
      "Inside div with **markdown** and $x^2$.",
      "",
      "</div>",
      "",
      "<table><tr><td>Cell A</td></tr></table>",
      "",
      "Trailing paragraph.",
    ].join("\n");
    const res = renderChunks(rawHtmlDoc, { math: true, map: true });
    const html = assertValidMarkdownResult(res, "raw-html");
    assert.equal(res.hasRawHtml, true, "hasRawHtml flagged true");
    assert.ok(
      Array.isArray(res.elementLines) && res.elementLines.length > 0,
      "elementLines populated",
    );
    assert.ok(html.includes('<div class="callout">') && html.includes("Trailing paragraph."));
  });

  await runCheck("eq-5: Markdown reference link definition edit updates earlier use site", () => {
    const refBefore =
      "See [spec guide][g1] for details.\n\nParagraph two.\n\n[g1]: https://example.org/v1\n";
    const refAfter =
      "See [spec guide][g1] for details.\n\nParagraph two.\n\n[g1]: https://example.org/v2\n";
    const before = renderChunks(refBefore, { math: true, map: true });
    const after = renderChunks(refAfter, { math: true, map: true });
    const beforeHtml = assertValidMarkdownResult(before, "ref-before");
    const afterHtml = assertValidMarkdownResult(after, "ref-after");
    assert.ok(beforeHtml.includes("https://example.org/v1"));
    assert.ok(afterHtml.includes("https://example.org/v2") && !afterHtml.includes("/v1"));
    if (incrementalMd) {
      const inc = incrementalMd(refBefore, before, refAfter, { math: true, map: true });
      assert.equal(resolveChunkPlaceholders(inc).join("\n"), afterHtml);
    }
  });

  await runCheck("eq-6: code span & display math delimiter edits re-mask cleanly", () => {
    const src1 = "Value `a + b` and display:\n\n$$\nc = \\sqrt{a^2 + b^2}\n$$\n\nEnd.";
    const src2 = "Value `a + b` edited and display:\n\n$$\nc = \\sqrt{a^2 + b^2 + 1}\n$$\n\nEnd.";
    const r1 = renderChunks(src1, { math: true, map: true });
    const r2 = renderChunks(src2, { math: true, map: true });
    assertValidMarkdownResult(r1, "math-code-1");
    const html2 = assertValidMarkdownResult(r2, "math-code-2");
    assert.equal(r2.codes.length, 1);
    assert.equal(r2.maths.length, 1);
    assert.ok(html2.includes("katex") || html2.includes("sqrt"), "math HTML rendered");
  });

  await runCheck(
    "eq-7: AsciiDoc attribute / ifdef / sectnums / toc toggles update full document",
    async () => {
      const adocBase = [
        "= Guide",
        ":feature-flag:",
        "",
        "== One",
        "",
        "ifdef::feature-flag[]",
        "Enabled feature branch.",
        "endif::[]",
        "",
        "Paragraph A.",
        "",
        "Paragraph B.",
        "",
        "Paragraph C.",
        "",
        "== Two",
        "",
        "Paragraph D.",
        "",
        "Paragraph E.",
        "",
        "Final line.",
      ].join("\n");
      const adocToggled = [
        "= Guide",
        ":!feature-flag:",
        ":sectnums:",
        ":toc:",
        "",
        "== One",
        "",
        "ifdef::feature-flag[]",
        "Enabled feature branch.",
        "endif::[]",
        "",
        "Paragraph A.",
        "",
        "Paragraph B.",
        "",
        "Paragraph C.",
        "",
        "== Two",
        "",
        "Paragraph D.",
        "",
        "Paragraph E.",
        "",
        "Final line.",
      ].join("\n");

      const rBase = await renderAsciidocChunks(adocBase, { baseDir: null, math: true });
      const rToggled = await renderAsciidocChunks(adocToggled, { baseDir: null, math: true });
      const htmlBase = rBase.chunks.join("\n");
      const htmlToggled = rToggled.chunks.join("\n");
      assert.ok(htmlBase.includes("Enabled feature branch."));
      assert.ok(!htmlToggled.includes("Enabled feature branch."));
      assert.ok(htmlToggled.includes("1. One"), "sectnums numbering applied");
      assert.ok(htmlToggled.includes("toc"), "toc generated");

      if (typeof asciidocRender.renderAsciidocChunksIncremental === "function") {
        const incToggled = await asciidocRender.renderAsciidocChunksIncremental(
          adocBase,
          rBase,
          adocToggled,
          { baseDir: null, math: true },
        );
        assert.equal(incToggled.incremental?.mode, "full");
        assert.equal(incToggled.chunks.join("\n"), htmlToggled);

        const adocEdited = adocBase.replace("Final line.", "Final edited line.");
        const freshEdited = await renderAsciidocChunks(adocEdited, { baseDir: null, math: true });
        const incEdited = await asciidocRender.renderAsciidocChunksIncremental(
          adocBase,
          rBase,
          adocEdited,
          { baseDir: null, math: true },
        );
        assert.equal(incEdited.incremental?.mode, "diff");
        assert.ok((incEdited.incremental?.dirtyRatio ?? 1) < 0.25);
        assert.equal(incEdited.chunks.join("\n"), freshEdited.chunks.join("\n"));
        assert.equal(incEdited.blocks?.length, freshEdited.blocks?.length);
      }
    },
  );

  return {
    passed,
    failed,
    total: checks.length,
    incrementalHooksDetected: Boolean(incrementalMd),
    incrementalAsciidocDetected:
      typeof asciidocRender.renderAsciidocChunksIncremental === "function",
    checks,
  };
}

// ---------------------------------------------------------------------------
// Table Printer & CLI Entry
// ---------------------------------------------------------------------------

function pad(value, width, alignRight = false) {
  const s = String(value);
  return alignRight ? s.padStart(width) : s.padEnd(width);
}

function printSummaryTable(results) {
  console.log("");
  console.log("Prose Rendering Pure-Node Benchmark");
  console.log(`Node ${process.version} | warmup=${WARMUP_RUNS} | runs=${BENCH_RUNS}`);
  console.log("-".repeat(129));
  console.log(
    [
      pad("Corpus", 16),
      pad("KB", 7, true),
      pad("Chunks", 7, true),
      pad("Cold(ms)", 9, true),
      pad("p50(ms)", 9, true),
      pad("Inc(ms)", 9, true),
      pad("p95(ms)", 9, true),
      pad("MAD(ms)", 9, true),
      pad("1ch Dirty", 11, true),
      pad("1ch Bytes", 11, true),
      pad("Split Dirty", 11, true),
    ].join("  "),
  );
  console.log("-".repeat(129));

  for (const r of results) {
    const full = r.timings.renderFull;
    const inc = r.timings.renderIncremental;
    const sc = r.invariance.singleChar;
    const sp = r.invariance.newlineSplit;
    console.log(
      [
        pad(r.id, 16),
        pad((r.bytes / 1024).toFixed(1), 7, true),
        pad(r.chunkCount, 7, true),
        pad(full.coldMs.toFixed(2), 9, true),
        pad(full.p50Ms.toFixed(2), 9, true),
        pad(inc ? inc.p50Ms.toFixed(2) : "-", 9, true),
        pad(full.p95Ms.toFixed(2), 9, true),
        pad(full.madMs.toFixed(2), 9, true),
        pad(`${sc.dirtyChunks}/${sc.afterChunks}`, 11, true),
        pad(`${(sc.dirtyHtmlBytesRatio * 100).toFixed(1)}%`, 11, true),
        pad(`${sp.dirtyChunks}/${sp.afterChunks}`, 11, true),
      ].join("  "),
    );
  }
  console.log("-".repeat(129));
  console.log("");
}

async function main() {
  if (VERIFY_EQUIVALENCE && !args.has("--with-bench")) {
    const eq = await runEquivalenceSuite();
    if (!JSON_ONLY) {
      console.log(`\n${eq.passed}/${eq.total} equivalence checks passed`);
    }
    console.log(`PROSE_EQUIV_JSON ${JSON.stringify(eq)}`);
    if (eq.failed > 0) process.exit(1);
    return;
  }

  const corpusHandle = await createCorpus();
  let results;
  let eq = null;
  try {
    const proxies = await loadOptionalProxies();
    results = await benchmarkCorpus(corpusHandle.items, proxies);
    if (VERIFY_EQUIVALENCE) {
      eq = await runEquivalenceSuite();
    }
  } finally {
    await corpusHandle.cleanup();
  }

  if (!JSON_ONLY) {
    printSummaryTable(results);
    if (eq) {
      console.log(`${eq.passed}/${eq.total} equivalence checks passed\n`);
    }
  }

  const payload = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    warmupRuns: WARMUP_RUNS,
    benchRuns: BENCH_RUNS,
    exposedHooks: {
      blockLines: typeof previewRender.blockLines === "function",
      elementLinesFor: typeof previewRender.elementLinesFor === "function",
      renderChunksIncremental: typeof previewRender.renderChunksIncremental === "function",
      renderAsciidocIncremental:
        typeof asciidocRender.renderAsciidocChunksIncremental === "function",
    },
    corpus: results,
    equivalence: eq,
  };

  console.log(`PROSE_BENCH_JSON ${JSON.stringify(payload)}`);
  if (eq && eq.failed > 0) process.exit(1);
}

await main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
