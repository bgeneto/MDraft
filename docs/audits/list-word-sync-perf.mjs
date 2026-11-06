//! Render time, fragment count and heap for list-heavy Markdown.
//!
//!   node docs/audits/list-word-sync-perf.mjs [paragraphs|prose|list|multiline]
//!
//! Word sync must not make a large list expensive. This measures the pure half
//! of the preview (`renderChunks`, which also runs in the worker). Run one case
//! per process so the sampled heap belongs to that document alone, then compare
//! `total`, `fragments`, `chunks` and `heap` before and after a change.
//!
//! It is a probe, not a test: it prints numbers and asserts nothing. The timing
//! gate for real input lives in `scripts/preview-performance-test.mjs`.

import { renderChunks } from "../../src/preview-render.ts";

function documentFor(name) {
  if (name === "paragraphs") {
    // The approved performance fixture shape: 72,000 CRLF paragraphs.
    let source = "";
    for (let i = 0; i < 72000; i += 1) {
      source += `Paragraph ${i} with ordinary prose and a second sentence that keeps wrapping.\r\n\r\n`;
    }
    return source;
  }
  if (name === "prose") {
    let source = "";
    for (let i = 0; i < 6000; i += 1) {
      source += `Paragraph ${i} with ordinary prose that wraps across one line.\n\n`;
    }
    return source;
  }
  if (name === "list") {
    let source = "";
    for (let i = 0; i < 6000; i += 1) {
      source += `- Item ${i} with \`code\` and **bold** text\n`;
    }
    return source;
  }
  let source = "";
  for (let i = 0; i < 6000; i += 1) {
    source += `- Item ${i} starts here\n  and continues with second-line prose\n`;
  }
  return source;
}

const name = process.argv[2] ?? "multiline";
const source = documentFor(name);
const times = [];
let result = null;
for (let run = 0; run < 4; run += 1) {
  const started = performance.now();
  result = renderChunks(source, { map: true });
  const elapsed = performance.now() - started;
  if (run > 0) times.push(elapsed);
}
times.sort((a, b) => a - b);
const fragments = result.fragments?.length ?? 0;
console.log(
  `${name.padEnd(12)} ${(Buffer.byteLength(source, "utf8") / 1024).toFixed(0).padStart(6)} KiB  ` +
    `median ${times[Math.floor(times.length / 2)].toFixed(0).padStart(4)} ms  ` +
    `chunks ${String(result.chunks.length).padStart(6)}  ` +
    `fragments ${String(fragments).padStart(6)}  ` +
    `heap ${(process.memoryUsage().heapUsed / (1024 * 1024)).toFixed(0).padStart(4)} MiB`,
);
