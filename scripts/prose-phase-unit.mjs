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
  primeKatexCache,
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
  renderAsciidocChunksIncremental,
} from "../src/asciidoc-render.ts";
import { diffBlocks, fnv1aHash } from "../src/block-diff.ts";
import { renderChunks, renderChunksIncremental } from "../src/preview-render.ts";
import { PreviewWorkerChannel } from "../src/preview-worker-client.ts";
import { shiftAndPatchScrollAnchors, shiftAndPatchWordMap } from "../src/source-map.ts";

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

console.log("\n=== Phase 2: dual warm worker standby ping-pong & KaTeX rehydration ===");
{
  class FakeWarmWorker {
    onmessage = null;
    onerror = null;
    onmessageerror = null;
    messages = [];
    terminated = false;
    postMessage(msg) {
      this.messages.push(msg);
    }
    terminate() {
      this.terminated = true;
    }
    reply(msg) {
      this.onmessage?.({ data: msg });
    }
  }

  const created = [];
  const channel = new PreviewWorkerChannel(
    () => {
      const w = new FakeWarmWorker();
      created.push(w);
      return w;
    },
    undefined,
    { standbyWarmupMs: 5, standbyIdleReapMs: 500 },
  );

  // Render #1 finishes with maths; channel should retain maths and idle-warm a standby worker.
  const first = channel.request("doc v1", {});
  assert.equal(created.length, 1);
  created[0].reply({
    id: created[0].messages[0].id,
    ok: true,
    data: {
      chunks: ["<p>a</p>"],
      maths: [{ body: "x^2", display: false, html: "<span class='katex'>x2</span>", error: null }],
    },
  });
  await first;
  await new Promise((r) => setTimeout(r, 25));

  const warmupMsg = created[1]?.messages.find((m) => m.kind === "warmup");
  check(
    "idle completion pre-warms standby worker and transfers cached KaTeX formulas",
    created.length === 2 &&
      Boolean(warmupMsg) &&
      warmupMsg.primeKatex?.length === 1 &&
      warmupMsg.primeKatex[0].body === "x^2" &&
      channel.stats().hasStandby === true,
    `workers=${created.length}`,
  );

  // Now edit #2 starts on worker[0] and gets superseded by edit #3 while active.
  const second = channel.request("doc v2", {});
  const third = channel.request("doc v3", {});
  assert.equal((await second).kind, "superseded");
  // Wait? Promotion happens when idle standby is promoted instead of cold-creating worker[2]!
  check(
    "superseding an active job terminates busy worker[0] and promotes warm standby with zero cold spawn",
    created[0].terminated === true &&
      created.length === 2 &&
      created[1].messages.at(-1)?.source === "doc v3" &&
      channel.stats().standbyPromotions === 1,
    `workers=${created.length}, promotions=${channel.stats().standbyPromotions}`,
  );

  // Late warmup ack on promoted worker[1] must be ignored safely without failing the channel.
  created[1].reply({ id: 0, ok: true, kind: "warmed" });
  created[1].reply({
    id: created[1].messages.at(-1).id,
    ok: true,
    data: { chunks: ["<p>v3</p>"] },
  });
  const thirdOutcome = await third;
  check(
    "late warmup ack does not disrupt promoted active render",
    thirdOutcome.kind === "ok" && thirdOutcome.data.chunks[0] === "<p>v3</p>",
  );

  await new Promise((r) => setTimeout(r, 25));
  const spareBeforeCancel = created.at(-1);
  channel.cancel();
  check(
    "cancel() terminates any active/standby spare worker cleanly",
    spareBeforeCancel?.terminated === true && channel.stats().hasStandby === false,
  );

  clearKatexCache();
  primeKatexCache([
    { body: "\\alpha", display: false, html: "<span class='katex'>a</span>", error: null },
  ]);
  const hydrated = renderKatexCached("\\alpha", false);
  check(
    "primeKatexCache hydrates LRU directly without recomputation",
    hydrated.html === "<span class='katex'>a</span>" && katexCacheSize() === 1,
  );
  clearKatexCache();
}

console.log("\n=== Phase 3: keyed block diff & incremental Markdown/AsciiDoc ===");
{
  const prev = [
    { key: "p0", digest: "h0", lineStart: 1 },
    { key: "p1", digest: "h1", lineStart: 3 },
    { key: "p2", digest: "h2", lineStart: 5 },
    { key: "p3", digest: "h3", lineStart: 7 },
    { key: "p4", digest: "h4", lineStart: 9 },
  ];
  const next = [
    { key: "p0", digest: "h0", lineStart: 1 },
    { key: "p1", digest: "h1-edited", lineStart: 3 },
    { key: "p2", digest: "h2", lineStart: 6 },
    { key: "p3", digest: "h3", lineStart: 8 },
    { key: "p4", digest: "h4", lineStart: 10 },
  ];
  const diff = diffBlocks(prev, next);
  const shiftOp = diff.ops.find((op) => op.kind === "retain" && op.prevIndex === 2);
  check(
    "diffBlocks retains unchanged blocks and tracks positive lineDelta",
    diff.incremental &&
      diff.dirtyBlocks === 1 &&
      shiftOp?.kind === "retain" &&
      shiftOp.lineDelta === 1,
    `dirty=${diff.dirtyBlocks}, delta=${shiftOp?.lineDelta}`,
  );

  const mostlyDirty = diffBlocks(
    prev,
    next.map((b, i) => ({ ...b, digest: `changed-${i}` })),
  );
  check(
    "diffBlocks triggers full rebuild fallback when dirtyRatio exceeds 35%",
    mostlyDirty.incremental === false && mostlyDirty.reason === "high-dirty-ratio",
    `reason=${mostlyDirty.reason}, ratio=${mostlyDirty.dirtyRatio.toFixed(2)}`,
  );
  assert.ok(fnv1aHash("abc") !== fnv1aHash("abd"));
}

{
  const paras = Array.from({ length: 16 }, (_, i) => `Paragraph ${i} with $x_${i}$.`);
  const md1 = ["# Title", "", "[TOC]", "", ...paras].join("\n\n");
  const base = renderChunks(md1, { math: true, map: true });

  // Mid-document window edit.
  const mdEdit = md1.replace("Paragraph 8 with $x_8$.", "Paragraph 8 updated with $x_8 + 1$.");
  const incEdit = renderChunksIncremental(md1, base, mdEdit, { math: true, map: true });
  const freshEdit = renderChunks(mdEdit, { math: true, map: true });
  check(
    "renderChunksIncremental patches mid-doc Markdown via window with byte-identical parity",
    incEdit.incremental?.mode === "window" &&
      incEdit.incremental.dirtyBlocks === 1 &&
      JSON.stringify(incEdit.chunks) === JSON.stringify(freshEdit.chunks) &&
      JSON.stringify(incEdit.lines) === JSON.stringify(freshEdit.lines),
    `mode=${incEdit.incremental?.mode}, dirty=${incEdit.incremental?.dirtyBlocks}`,
  );

  // Fence body edit stays on fast path; fence header edit uses lex-diff block reuse with full parity.
  const mdFenced1 = `${md1}\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n\nTail.`;
  const fencedBase = renderChunks(mdFenced1, { math: true, map: true });
  const mdFenced2 = mdFenced1.replace("```ts", "```js");
  const incFence = renderChunksIncremental(mdFenced1, fencedBase, mdFenced2, {
    math: true,
    map: true,
  });
  const freshFence = renderChunks(mdFenced2, { math: true, map: true });
  check(
    "fenced code edit preserves trailing chunk identity via lex-diff reuse",
    incFence.incremental?.mode === "lex-diff" &&
      JSON.stringify(incFence.chunks) === JSON.stringify(freshFence.chunks),
    `mode=${incFence.incremental?.mode}`,
  );

  // Heading edit updates [TOC] signal.
  const mdHeading = md1.replace("# Title", "# Revised Title");
  const incHeading = renderChunksIncremental(md1, base, mdHeading, { math: true, map: true });
  check(
    "heading edit flags headingsChanged and hasToc for [TOC] refresh",
    incHeading.incremental?.headingsChanged === true && incHeading.incremental?.hasToc === true,
  );

  // Raw HTML & reference definition triggers fall back cleanly.
  const mdHtml = `${md1}\n\n<div>inline raw</div>`;
  const incHtml = renderChunksIncremental(md1, base, mdHtml, { math: true, map: true });
  check("raw HTML triggers full rebuild mode", incHtml.incremental?.mode === "full");

  const mdRef1 = `${md1}\n\nSee [site][home].\n\n[home]: https://example.org/v1`;
  const refBase = renderChunks(mdRef1, { math: true, map: true });
  const mdRef2 = mdRef1.replace("https://example.org/v1", "https://example.org/v2");
  const incRef = renderChunksIncremental(mdRef1, refBase, mdRef2, { math: true, map: true });
  const freshRef = renderChunks(mdRef2, { math: true, map: true });
  check(
    "link reference definition edit falls back cleanly to full rebuild with exact output",
    incRef.incremental?.mode === "full" &&
      incRef.incremental?.reason === "def-changed" &&
      JSON.stringify(incRef.chunks) === JSON.stringify(freshRef.chunks),
  );
}

{
  const adocParas = Array.from({ length: 24 }, (_, i) => `Body paragraph ${i} value.`);
  const adocSrc1 = ["= Book", "", "== Section One", "", ...adocParas].join("\n\n");
  const baseAdoc = await renderAsciidocChunks(adocSrc1, { baseDir: null, math: true });
  const adocSrc2 = adocSrc1.replace("Body paragraph 12 value.", "Body paragraph 12 UPDATED.");
  const incAdoc = await renderAsciidocChunksIncremental(adocSrc1, baseAdoc, adocSrc2, {
    baseDir: null,
    math: true,
  });
  const freshAdoc = await renderAsciidocChunks(adocSrc2, { baseDir: null, math: true });
  check(
    "renderAsciidocChunksIncremental keeps sub-sect1 dirtyRatio < 0.05 on body paragraph edit",
    incAdoc.incremental?.mode === "diff" &&
      incAdoc.incremental.dirtyBlocks === 1 &&
      incAdoc.incremental.dirtyRatio < 0.05 &&
      JSON.stringify(incAdoc.chunks) === JSON.stringify(freshAdoc.chunks),
    `dirty=${incAdoc.incremental?.dirtyBlocks}/${incAdoc.blocks?.length ?? 0}, ratio=${incAdoc.incremental?.dirtyRatio.toFixed(4)}`,
  );

  const adocToc = adocSrc1.replace("= Book", "= Book\n:toc:\n:sectnums:");
  const incToc = await renderAsciidocChunksIncremental(adocSrc1, baseAdoc, adocToc, {
    baseDir: null,
    math: true,
  });
  check(
    "AsciiDoc header/toc toggle triggers fail-safe full mode",
    incToc.incremental?.mode === "full",
    `reason=${incToc.incremental?.reason}`,
  );
}

console.log("\n=== Phase 3: incremental WordMap & ScrollAnchors shifting ===");
{
  const makeTextNode = (data, parentElement) => ({
    nodeType: 3,
    data,
    length: data.length,
    parentElement,
  });
  const makeFakeEl = (attrs = {}, children = []) => {
    const el = {
      nodeType: 1,
      dataset: attrs.dataset ?? {},
      children: [],
      childNodes: [],
      matches: (sel) => {
        if (sel === "[data-f]") return el.dataset.f !== undefined;
        if (sel === "[data-b]") return el.dataset.b !== undefined;
        return false;
      },
      closest: (sel) => {
        if (sel === "[data-b]" && el.dataset.b !== undefined) return el;
        return null;
      },
      contains: (other) => other === el || el.children.includes(other),
      querySelectorAll: (sel) => {
        const out = [];
        const visit = (node) => {
          for (const ch of node.children ?? []) {
            if (ch.nodeType === 1 && ch.matches(sel)) out.push(ch);
            visit(ch);
          }
        };
        visit(el);
        return out;
      },
    };
    for (const ch of children) {
      el.childNodes.push(ch);
      if (ch.nodeType === 1) el.children.push(ch);
    }
    return el;
  };

  const prevDoc = globalThis.document;
  const prevNodeFilter = globalThis.NodeFilter;
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.document = {
    createTreeWalker(root) {
      const list = [];
      const walk = (n) => {
        for (const ch of n.childNodes ?? []) {
          if (ch.nodeType === 3) list.push(ch);
          else walk(ch);
        }
      };
      walk(root);
      let idx = 0;
      return {
        nextNode() {
          return idx < list.length ? list[idx++] : null;
        },
      };
    },
  };

  try {
    // Markdown fragment retain + shift + dirty replace.
    const el0 = makeFakeEl({ dataset: { f: "0" } });
    const t0 = makeTextNode("alpha", el0);
    el0.childNodes.push(t0);

    const oldEl1 = makeFakeEl({ dataset: { f: "1" } });
    const oldT1 = makeTextNode("beta", oldEl1);
    oldEl1.childNodes.push(oldT1);

    const el2 = makeFakeEl({ dataset: { f: "2" } });
    const t2 = makeTextNode("gamma", el2);
    el2.childNodes.push(t2);

    const newEl1 = makeFakeEl({ dataset: { f: "0" } });
    const newT1 = makeTextNode("betaEdited", newEl1);
    newEl1.childNodes.push(newT1);

    const container = makeFakeEl({ dataset: { mdraftLocalFragments: "1" } });
    const prevFrags = [
      { src0: 0, src1: 5, raw: "alpha", kind: "text" },
      { src0: 7, src1: 11, raw: "beta", kind: "text" },
      { src0: 13, src1: 18, raw: "gamma", kind: "text" },
    ];
    const nextFrags = [
      { src0: 0, src1: 5, raw: "alpha", kind: "text" },
      { src0: 7, src1: 17, raw: "betaEdited", kind: "text" },
      { src0: 19, src1: 24, raw: "gamma", kind: "text" },
    ];
    const prevMap = {
      source: "alpha\n\nbeta\n\ngamma",
      fragments: prevFrags,
      blocks: [],
      text: new WeakMap([
        [t0, { fragment: 0, fragStart: 0, block: -1, blockStart: 0 }],
        [oldT1, { fragment: 1, fragStart: 0, block: -1, blockStart: 0 }],
        [t2, { fragment: 2, fragStart: 0, block: -1, blockStart: 0 }],
      ]),
      fragNodes: [[t0], [oldT1], [t2]],
      blockNodes: [],
      blockAllNodes: [],
      blockLayouts: [],
    };
    const nextSpec = { source: "alpha\n\nbetaEdited\n\ngamma", fragments: nextFrags, blocks: [] };
    const wmRes = shiftAndPatchWordMap(prevMap, container, nextSpec, {
      kind: "markdown",
      retained: [
        { prevStart: 0, prevEnd: 1, nextStart: 0, charDelta: 0, lineDelta: 0 },
        { prevStart: 2, prevEnd: 3, nextStart: 2, charDelta: 6, lineDelta: 1 },
      ],
      dirty: [{ nextStart: 1, nextEnd: 2, elements: [newEl1] }],
      removedPrevIndices: [1],
    });
    const prevAnchors = {
      anchors: [
        { from: 0, to: 5, node: t0, start: 0, end: 5, region: "f0" },
        { from: 7, to: 11, node: oldT1, start: 0, end: 4, region: "f1" },
        { from: 13, to: 18, node: t2, start: 0, end: 5, region: "2" },
      ],
      sorted: true,
    };
    const saRes = shiftAndPatchScrollAnchors(
      prevAnchors,
      wmRes.map,
      wmRes.retainedMeta,
      wmRes.droppedNodes,
      wmRes.dirtyTexts,
    );
    check(
      "shiftAndPatchWordMap + shiftAndPatchScrollAnchors retain unchanged Text nodes and shift trailing anchors",
      wmRes.map.fragNodes[0][0] === t0 &&
        wmRes.map.fragNodes[1][0] === newT1 &&
        wmRes.map.fragNodes[2][0] === t2 &&
        wmRes.droppedNodes.has(oldT1) &&
        saRes.sorted === true &&
        saRes.anchors.length === 3 &&
        saRes.anchors[1].node === newT1 &&
        saRes.anchors[2].from === 19 &&
        saRes.anchors[2].to === 24 &&
        saRes.anchors[2].region === "3",
      `anchors=${saRes.anchors.map((a) => `${a.from}-${a.to}:${a.region}`).join(",")}`,
    );

    // AsciiDoc block retain + dirty replace.
    const ab0 = makeFakeEl({ dataset: { b: "0" } });
    const at0 = makeTextNode("one", ab0);
    ab0.childNodes.push(at0);
    const oldAb1 = makeFakeEl({ dataset: { b: "1" } });
    const oldAt1 = makeTextNode("two", oldAb1);
    oldAb1.childNodes.push(oldAt1);
    const ab2 = makeFakeEl({ dataset: { b: "2" } });
    const at2 = makeTextNode("three", ab2);
    ab2.childNodes.push(at2);
    const newAb1 = makeFakeEl({ dataset: { b: "1" } });
    const newAt1 = makeTextNode("twoChanged", newAb1);
    newAb1.childNodes.push(newAt1);

    const prevAdocMap = {
      source: "one\n\ntwo\n\nthree",
      fragments: [],
      blocks: [
        { src0: 0, src1: 3 },
        { src0: 5, src1: 8 },
        { src0: 10, src1: 15 },
      ],
      text: new WeakMap([
        [at0, { fragment: -1, fragStart: 0, block: 0, blockStart: 0 }],
        [oldAt1, { fragment: -1, fragStart: 0, block: 1, blockStart: 0 }],
        [at2, { fragment: -1, fragStart: 0, block: 2, blockStart: 0 }],
      ]),
      fragNodes: [],
      blockNodes: [[at0], [oldAt1], [at2]],
      blockAllNodes: [[at0], [oldAt1], [at2]],
      blockLayouts: [undefined, undefined, undefined],
    };
    const nextAdocSpec = {
      source: "one\n\ntwoChanged\n\nthree",
      fragments: [],
      blocks: [
        { src0: 0, src1: 3 },
        { src0: 5, src1: 15 },
        { src0: 17, src1: 22 },
      ],
    };
    const adocWm = shiftAndPatchWordMap(prevAdocMap, makeFakeEl(), nextAdocSpec, {
      kind: "block",
      retained: [
        { prevStart: 0, prevEnd: 1, nextStart: 0, charDelta: 0, lineDelta: 0 },
        { prevStart: 2, prevEnd: 3, nextStart: 2, charDelta: 7, lineDelta: 0 },
      ],
      dirty: [{ nextStart: 1, nextEnd: 2, elements: [newAb1] }],
      removedPrevIndices: [1],
    });
    check(
      "shiftAndPatchWordMap handles AsciiDoc block retain/replace without re-walking retained blocks",
      adocWm.map.blockNodes[0][0] === at0 &&
        adocWm.map.blockNodes[1][0] === newAt1 &&
        adocWm.map.blockNodes[2][0] === at2 &&
        adocWm.droppedNodes.has(oldAt1) &&
        adocWm.retainedMeta.get(at2)?.charDelta === 7,
    );
  } finally {
    globalThis.document = prevDoc;
    globalThis.NodeFilter = prevNodeFilter;
  }
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
