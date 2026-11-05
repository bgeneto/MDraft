//! Typing latency while a large preview render is in flight.
//!
//! Run against a running instance (a fresh profile is best):
//!
//!   node scripts/preview-performance-test.mjs [port]
//!
//! The script opens a generated 1.2 MB Markdown document, types while the
//! initial render is running, and measures the age of each key event
//! (`timeStamp` to the capture listener). Before the worker split, those keys
//! waited about a second and then appeared in a burst; the check fails above
//! 150 ms. It also proves Source mode does not start a render.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = process.argv[2] ?? "9222";

// ---------------------------------------------------------------------------
// CDP, the same shape every script here uses.
// ---------------------------------------------------------------------------

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((target) => target.type === "page");
if (!page) throw new Error(`no page target on ${port}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("CDP socket did not open")), 8000);
  ws.addEventListener(
    "open",
    () => {
      clearTimeout(timer);
      resolve();
    },
    { once: true },
  );
});
await new Promise((resolve) => setTimeout(resolve, 300));

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

await send("Runtime.enable");

async function evaluate(expression) {
  const response = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.result.exceptionDetails) {
    throw new Error(JSON.stringify(response.result.exceptionDetails));
  }
  return response.result.result.value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const invoke = (command, args) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
  );

async function waitFor(label, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await sleep(100);
  }
  console.log(`  FAIL  ${label} (timed out)`);
  failed += 1;
  return false;
}

// ---------------------------------------------------------------------------
// The fixture: big enough that a render overlaps several keystrokes
// ---------------------------------------------------------------------------

function bigDocument() {
  const words =
    "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu document editor preview source paragraph section heading formula table code".split(
      " ",
    );
  const parts = ["# Preview performance\n\n"];
  for (let i = 0; i < 6000; i += 1) {
    let sentence = "";
    for (let w = 0; w < 30; w += 1) sentence += `${words[(i * 7 + w * 13) % words.length]} `;
    parts.push(`${sentence.trim().replace(/^./, (c) => c.toUpperCase())}.\n\n`);
    if (i % 25 === 0) parts.push(`## Section ${Math.floor(i / 25)}\n\n`);
    if (i % 120 === 0) parts.push("Inline math $a^2 + b^2 = c^2$ with **bold** and `code`.\n\n");
    if (i % 200 === 0) parts.push("```js\nconst value = items.map((item) => item * 2);\n```\n\n");
  }
  return parts.join("");
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mdraft-preview-perf-"));
const file = path.join(directory, "preview-performance.md");
fs.writeFileSync(file, bigDocument(), "utf8");

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

async function installProbe() {
  await evaluate(`(() => {
    window.__previewPerf = { ages: [], long: [] };
    window.addEventListener("keydown", (event) => {
      window.__previewPerf.ages.push(Math.max(0, performance.now() - event.timeStamp));
    }, true);
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > 50) window.__previewPerf.long.push({ duration: entry.duration });
        }
      }).observe({ entryTypes: ["longtask"] });
    } catch {
      /* WebKit may not expose longtask; the key age is the contract */
    }
    return true;
  })()`);
}

async function resetProbe() {
  await evaluate("window.__previewPerf.ages = []; window.__previewPerf.long = []");
}

async function readProbe() {
  return evaluate(`(() => {
    const ages = window.__previewPerf.ages.slice().sort((a, b) => a - b);
    const long = window.__previewPerf.long.map((entry) => entry.duration);
    const pick = (p) => ages.length ? ages[Math.min(ages.length - 1, Math.floor(ages.length * p))] : 0;
    return { count: ages.length, p50: pick(0.5), p95: pick(0.95), max: ages.at(-1) ?? 0,
      long: long.length, longest: long.length ? Math.max(...long) : 0 };
  })()`);
}

async function typeText(text, delayMs) {
  for (const character of text) {
    await send("Input.dispatchKeyEvent", {
      type: "char",
      text: character,
      unmodifiedText: character,
      key: character,
    });
    if (delayMs) await sleep(delayMs);
  }
}

async function focusEditor() {
  await evaluate(`document.querySelector(".cm-content")?.focus()`);
}

// ---------------------------------------------------------------------------
// Open the document and type into the initial render
// ---------------------------------------------------------------------------

await invoke("plugin:event|emit", { event: "open-files", payload: [file] });
await waitFor("the large document opens", `document.title.includes("preview-performance")`, 30000);
await focusEditor();
await installProbe();

// The initial render starts as soon as the document is installed. Type into it
// while the worker is still producing chunks and the main thread is inserting
// them; this is the keystroke queue the old synchronous render created.
await resetProbe();
await typeText("overlap typing during the first render", 15);
await sleep(250);
const duringRender = await readProbe();
check(
  "keys arrive while the preview renders",
  duringRender.count >= 30,
  `${duringRender.count} keys`,
);
check(
  "no key waits more than 150 ms for the editor",
  duringRender.max < 150,
  `p95 ${duringRender.p95.toFixed(1)} ms, max ${duringRender.max.toFixed(1)} ms`,
);
check(
  "the median key stays under one frame",
  duringRender.p50 < 50,
  `${duringRender.p50.toFixed(1)} ms`,
);
check(
  "no main-thread task lasts longer than 150 ms",
  duringRender.longest < 150,
  `${duringRender.long} over 50 ms, longest ${duringRender.longest.toFixed(1)} ms`,
);

await waitFor(
  "the preview paints its blocks",
  `document.querySelectorAll("#preview > *").length > 500`,
);

// ---------------------------------------------------------------------------
// Idle typing: the same document, after the preview settled
// ---------------------------------------------------------------------------

await sleep(800);
await focusEditor();
await resetProbe();
await typeText("idle typing is immediate", 30);
await sleep(250);
const idle = await readProbe();
check(
  "idle keys are immediate",
  idle.max < 50,
  `p95 ${idle.p95.toFixed(1)} ms, max ${idle.max.toFixed(1)} ms`,
);

// ---------------------------------------------------------------------------
// Source mode must not start a preview render
// ---------------------------------------------------------------------------

await invoke("plugin:event|emit", { event: "menu", payload: "view.source" });
await sleep(400);
await focusEditor();
await resetProbe();
await typeText("source mode typing has no preview work", 20);
await sleep(900);
const source = await readProbe();
check(
  "Source mode keys are immediate",
  source.max < 50,
  `p95 ${source.p95.toFixed(1)} ms, max ${source.max.toFixed(1)} ms`,
);
check(
  "Source mode starts no long render task",
  source.longest < 100,
  `${source.long} over 50 ms, longest ${source.longest.toFixed(1)} ms`,
);

// ---------------------------------------------------------------------------
// Returning to Split renders once, and typing during that render stays prompt
// ---------------------------------------------------------------------------

await invoke("plugin:event|emit", { event: "menu", payload: "view.split" });
await sleep(80);
await focusEditor();
await resetProbe();
await typeText("switching back to split", 20);
await sleep(300);
const restored = await readProbe();
check(
  "the switch back to Split does not block typing",
  restored.max < 150,
  `p95 ${restored.p95.toFixed(1)} ms, max ${restored.max.toFixed(1)} ms`,
);
check(
  "the switch back to Split has no long task",
  restored.longest < 150,
  `${restored.long} over 50 ms, longest ${restored.longest.toFixed(1)} ms`,
);
check(
  "Split has a rendered preview again",
  await evaluate(`document.querySelectorAll("#preview > *").length > 500`),
);

try {
  fs.rmSync(directory, { recursive: true, force: true });
} catch {
  /* the application may still hold the tab; the OS temp directory will clean it */
}

console.log(`\n${passed}/${passed + failed} checks passed`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
