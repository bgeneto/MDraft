// Audit-only probes. Run on Node 24 from the repository root:
//   node --expose-gc docs/audits/preview-worker-probes.mjs scale
//   node --expose-gc docs/audits/preview-worker-probes.mjs extreme LF
//   node --expose-gc docs/audits/preview-worker-probes.mjs extreme CRLF
//   node docs/audits/preview-worker-probes.mjs offsets
//   node docs/audits/preview-worker-probes.mjs includes
//   node --experimental-transform-types docs/audits/preview-worker-probes.mjs channel
// These probes do not launch MDraft or write the application's settings.

import { performance } from "node:perf_hooks";

const mode = process.argv[2];

if (mode === "scale") {
  const { renderChunks } = await import("../../src/preview-render.ts");
  const { batchesForChunks } = await import("../../src/preview-batches.ts");
  const paragraph =
    "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima ".repeat(2);
  const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  // Warm the parser and KaTeX imports once before timed samples.
  renderChunks("warm up\n\ntext", { math: false, map: true });
  const rows = [];
  for (const count of [400, 800, 1600, 3200, 6400]) {
    for (const endings of ["LF", "CRLF"]) {
      const eol = endings === "LF" ? "\n\n" : "\r\n\r\n";
      const source = (paragraph + eol).repeat(count);
      for (const map of [false, true]) {
        const times = [];
        let chunks = 0;
        for (let run = 0; run < 3; run += 1) {
          globalThis.gc?.();
          const start = performance.now();
          const result = renderChunks(source, { math: false, map });
          times.push(performance.now() - start);
          chunks = result.chunks.length;
        }
        rows.push({
          paragraphs: count,
          endings,
          map,
          bytes: Buffer.byteLength(source),
          chunks,
          medianMs: Number(median(times).toFixed(1)),
          samplesMs: times.map((x) => Number(x.toFixed(1))),
        });
      }
    }
  }
  const single = "x".repeat(1024 * 1024);
  const batches = batchesForChunks([single]);
  console.log(
    JSON.stringify(
      {
        node: process.version,
        rows,
        oversizedChunk: {
          configuredTarget: 64 * 1024,
          actualCharacters: batches[0][0].length,
          batches: batches.length,
        },
      },
      null,
      2,
    ),
  );
} else if (mode === "extreme") {
  const { renderChunks } = await import("../../src/preview-render.ts");
  const endings = process.argv[3] === "CRLF" ? "CRLF" : "LF";
  const eol = endings === "LF" ? "\n\n" : "\r\n\r\n";
  const paragraph =
    "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima ".repeat(2);
  const source = (paragraph + eol).repeat(72000);
  globalThis.gc?.();
  const before = process.memoryUsage();
  const start = performance.now();
  const result = renderChunks(source, { math: false, map: true });
  console.log(
    JSON.stringify(
      {
        endings,
        sourceBytes: Buffer.byteLength(source),
        elapsedMs: Number((performance.now() - start).toFixed(1)),
        chunks: result.chunks.length,
        fragments: result.fragments?.length,
        heapBeforeBytes: before.heapUsed,
        heapAfterBytes: process.memoryUsage().heapUsed,
        maxRssKiB: process.resourceUsage().maxRSS,
      },
      null,
      2,
    ),
  );
} else if (mode === "offsets") {
  const { translateOffset } = await import("../../src/source-map.ts");
  const substitutions = Array.from({ length: 12800 }, (_, i) => ({
    p0: 2 * i,
    p1: 2 * i + 1,
    o0: 3 * i,
    o1: 3 * i + 2,
  }));
  const offsets = Array.from({ length: 6400 }, (_, i) => 4 * i + 2);
  const prefix = [0];
  for (const s of substitutions) prefix.push(prefix.at(-1) + s.o1 - s.o0 - (s.p1 - s.p0));
  const indexed = (value) => {
    let left = 0,
      right = substitutions.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (substitutions[middle].p1 <= value) left = middle + 1;
      else right = middle;
    }
    return value + prefix[left];
  };
  const time = (fn) => {
    const start = performance.now();
    const out = offsets.map(fn);
    return { ms: Number((performance.now() - start).toFixed(1)), out };
  };
  const linear = time((offset) => translateOffset(substitutions, offset));
  const binary = time(indexed);
  const same = linear.out.every((value, i) => value === binary.out[i]);
  console.log(
    JSON.stringify(
      {
        substitutions: substitutions.length,
        lookups: offsets.length,
        linearMs: linear.ms,
        indexedMs: binary.ms,
        same,
      },
      null,
      2,
    ),
  );
} else if (mode === "includes") {
  const { preloadAsciidocIncludes, renderAsciidocChunks } =
    await import("../../src/asciidoc-render.ts");
  const source = "= Audit\n\nifdef::missing[]\ninclude::unused.adoc[]\nendif::[]\n\nVisible.\n";
  const reads = { preload: [], actual: [] };
  await preloadAsciidocIncludes(source, {
    baseDir: "C:/audit",
    readFile: async (path) => {
      reads.preload.push(path);
      return "SHOULD NOT BE INCLUDED";
    },
  });
  const result = await renderAsciidocChunks(source, {
    baseDir: "C:/audit",
    math: false,
    readFile: async (path) => {
      reads.actual.push(path);
      return "SHOULD NOT BE INCLUDED";
    },
  });
  const count = 25;
  const simulated =
    "= Audit\n\nifdef::missing[]\n" +
    Array.from({ length: count }, (_, i) => `include::unused-${i}.adoc[]\n`).join("") +
    "endif::[]\n\nVisible.\n";
  const start = performance.now();
  let simulatedReads = 0;
  await preloadAsciidocIncludes(simulated, {
    baseDir: "C:/audit",
    readFile: async () => {
      simulatedReads += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "unused";
    },
  });
  console.log(
    JSON.stringify(
      {
        reads,
        includedUnexpectedText: result.chunks.join("").includes("SHOULD NOT"),
        simulated: {
          count,
          delayPerReadMs: 5,
          reads: simulatedReads,
          elapsedMs: Number((performance.now() - start).toFixed(1)),
        },
      },
      null,
      2,
    ),
  );
} else if (mode === "channel") {
  globalThis.Worker = class {
    postMessage() {
      throw new DOMException("synthetic postMessage failure", "DataCloneError");
    }
    terminate() {}
  };
  const { renderChunksAsync } = await import("../../src/preview-worker-client.ts");
  let first;
  try {
    await renderChunksAsync("first", { math: false });
    first = "resolved";
  } catch (error) {
    first = `${error.name}: ${error.message}`;
  }
  const second = await Promise.race([
    renderChunksAsync("second", { math: false }).then((result) => result.kind),
    new Promise((resolve) => setTimeout(() => resolve("unresolved after 250 ms"), 250)),
  ]);
  console.log(JSON.stringify({ first, second }, null, 2));
} else {
  console.error("Choose scale, extreme, offsets, includes or channel");
  process.exitCode = 2;
}
