//! Reproducible app-free probe of PDF correspondence construction.
//!
//!   npm run pdf:map:perf -- math 8000 3
//!   npm run pdf:map:perf -- prose 10000 3
//!
//! Each run gets a fresh process and Node worker. RSS is sampled for the entire
//! child process; the result is not a WebView or UI-latency measurement. Set
//! MDRAFT_PDF_MAP_MODULE to a relative module URL to compare another checkout.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

if (!isMainThread) {
  const { scenario, count } = workerData;
  const lines = Array.from({ length: count }, (_, index) => {
    if (scenario === "math") return { text: `Q = ${index + 1}`, region: `${index >> 7}:0` };
    const suffix = String(index).padStart(5, "0");
    const text = [
      "entry",
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
      "foxtrot",
      "golf",
      "hotel",
      "india",
      "juliet",
    ]
      .map((word) => word + suffix)
      .join(" ");
    return { text, region: `${index >> 7}:0` };
  });
  const body = lines.map((line, index) => (scenario === "math" ? `$Q=${index + 1}$` : line.text));
  const source = `\\begin{document}\n${body.join("\n")}\n\\end{document}`;
  const { buildPdfWordAnchors } = await import(
    process.env.MDRAFT_PDF_MAP_MODULE ?? "../src/pdf-page-build.ts"
  );
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  const anchors = await buildPdfWordAnchors("latex", [{ path: "main.tex", source }], lines);
  parentPort.postMessage({
    scenario,
    lines: count,
    sourceBytes: Buffer.byteLength(source),
    anchors: anchors.length,
    mapMs: performance.now() - start,
    heapBefore,
    heapAfter: process.memoryUsage().heapUsed,
  });
} else if (process.argv[2] === "--single") {
  const scenario = process.argv[3];
  const count = Number(process.argv[4]);
  const rssBefore = process.memoryUsage().rss;
  let rssPeak = rssBefore;
  const sampler = setInterval(() => {
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }, 10);
  try {
    const result = await new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { scenario, count } });
      let message;
      worker.once("message", (value) => {
        message = value;
        rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
      });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0 || !message)
          reject(new Error(`PDF map worker exited ${code} without a result`));
        else resolve(message);
      });
    });
    console.log(JSON.stringify({ ...result, rssBefore, rssPeak, rssGrowth: rssPeak - rssBefore }));
  } finally {
    clearInterval(sampler);
  }
} else {
  const scenario = process.argv[2] ?? "math";
  const count = Number(process.argv[3] ?? (scenario === "math" ? 8000 : 10000));
  const repetitions = Number(process.argv[4] ?? 3);
  if (
    !["math", "prose"].includes(scenario) ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 50000 ||
    !Number.isSafeInteger(repetitions) ||
    repetitions < 1 ||
    repetitions > 10
  ) {
    throw new Error("Usage: npm run pdf:map:perf -- [math|prose] [1..50000 lines] [1..10 runs]");
  }
  const timings = [];
  for (let run = 1; run <= repetitions; run += 1) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        ...process.execArgv,
        fileURLToPath(import.meta.url),
        "--single",
        scenario,
        String(count),
      ]);
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== 0) return reject(new Error(`PDF map probe exited ${code}: ${stderr}`));
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(error);
        }
      });
    });
    timings.push(result.mapMs);
    console.log(JSON.stringify({ run, ...result }));
  }
  timings.sort((a, b) => a - b);
  const middle = Math.floor(timings.length / 2);
  const median = timings.length % 2 ? timings[middle] : (timings[middle - 1] + timings[middle]) / 2;
  console.log(`Median map time: ${median.toFixed(1)} ms`);
}
