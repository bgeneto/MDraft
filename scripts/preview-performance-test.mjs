//! Typing latency while a large preview render is in flight.
//!
//! Run against a running instance (a fresh profile is best):
//!
//!   node scripts/preview-performance-test.mjs [port]
//!
//! Sends real keydown/char/keyup sequences with explicit timestamps, samples
//! keys that overlap worker conversions, and measures the final correct paint.
//! An intentional main-thread block proves the latency detector can fail.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  installGroupPrototype,
  installGroupedChunksPrototype,
} from "./preview-group-prototype.mjs";

const cliArgs = process.argv.slice(2);
const port = cliArgs.find((arg) => !arg.startsWith("--")) ?? "9222";
const extreme = process.env.MDRAFT_PREVIEW_EXTREME === "1" || cliArgs.includes("--extreme");

// ---------------------------------------------------------------------------
// CDP, the same shape every script here uses.
// ---------------------------------------------------------------------------

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((target) => target.type === "page");
if (!page) throw new Error(`no page target on ${port}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const eventHandlers = new Map();
const addCdpListener = (method, handler) => {
  let set = eventHandlers.get(method);
  if (!set) {
    set = new Set();
    eventHandlers.set(method, set);
  }
  set.add(handler);
  return () => set.delete(handler);
};
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message);
    pending.delete(message.id);
  } else if (message.method && eventHandlers.has(message.method)) {
    for (const handler of eventHandlers.get(message.method)) {
      Promise.resolve(handler(message.params)).catch(() => {});
    }
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
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
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

function bigAsciidoc() {
  const words =
    "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu document editor preview source paragraph section heading formula table code".split(
      " ",
    );
  const parts = ["= Large AsciiDoc fixture\n:nofooter:\n\n"];
  for (let i = 0; i < 3000; i += 1) {
    let sentence = "";
    for (let w = 0; w < 30; w += 1) sentence += `${words[(i * 7 + w * 13) % words.length]} `;
    parts.push(`${sentence.trim().replace(/^./, (c) => c.toUpperCase())}.\n\n`);
    if (i % 25 === 0) parts.push(`== Section ${Math.floor(i / 25)}\n\n`);
    if (i % 120 === 0) parts.push("Inline math stem:[a^2 + b^2 = c^2] with *bold* and `code`.\n\n");
    if (i % 200 === 0)
      parts.push("[source,js]\n----\nconst value = items.map((item) => item * 2);\n----\n\n");
  }
  return parts.join("");
}

function extremeCrlfDocument() {
  const paragraph =
    "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima ".repeat(2);
  return (paragraph + "\r\n\r\n").repeat(72000);
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mdraft-preview-perf-"));
const file = path.join(directory, "preview-performance.md");
fs.writeFileSync(file, extreme ? extremeCrlfDocument() : bigDocument(), "utf8");
const adocFile = path.join(directory, "preview-performance.adoc");
fs.writeFileSync(adocFile, bigAsciidoc(), "utf8");

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

async function installProbe() {
  await evaluate(`(() => {
    const probe = window.__previewPerf = {
      events: [], inputs: 0, active: new Map(), starts: 0, baselineStarts: 0,
      long: [], longSupported: false, lastInput: null, expected: null, finalMs: null,
      trackMutations: false, mutationNodes: 0
    };
    const observed = new WeakSet();
    const nativePost = Worker.prototype.postMessage;
    const nativeTerminate = Worker.prototype.terminate;
    Worker.prototype.postMessage = function(message, ...rest) {
      if (typeof message?.id === "number" && typeof message.source === "string") {
        if (!observed.has(this)) {
          observed.add(this);
          this.addEventListener("message", (event) => {
            const id = probe.active.get(this);
            if (id === event.data?.id) probe.active.delete(this);
          });
        }
        probe.starts += 1;
        probe.active.set(this, message.id);
      }
      return nativePost.call(this, message, ...rest);
    };
    Worker.prototype.terminate = function() {
      probe.active.delete(this);
      return nativeTerminate.call(this);
    };
    window.addEventListener("keydown", (event) => {
      if (!event.target?.closest?.(".cm-content")) return;
      const age = performance.now() - event.timeStamp;
      probe.events.push({ age: Math.max(0, age), overlap: probe.active.size > 0 });
    }, true);
    window.addEventListener("input", (event) => {
      if (!event.target?.closest?.(".cm-content")) return;
      probe.inputs += 1;
      probe.lastInput = performance.now();
    }, true);
    const supported = PerformanceObserver.supportedEntryTypes ?? [];
    if (supported.includes("longtask")) {
      probe.longSupported = true;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) probe.long.push({start:entry.startTime,duration:entry.duration});
      }).observe({ entryTypes: ["longtask"] });
    }
    const preview = document.querySelector("#preview");
    if (!preview) throw new Error("No preview element");
    new MutationObserver((records) => {
      if (probe.trackMutations) {
        for (const record of records) {
          if (record.type === "characterData") {
            probe.mutationNodes += 1;
          } else {
            probe.mutationNodes += record.addedNodes.length + record.removedNodes.length;
          }
        }
      }
      if (!probe.expected || probe.lastInput === null || probe.finalMs !== null ||
          !preview.textContent.includes(probe.expected)) return;
      requestAnimationFrame(() => {
        if (probe.expected && preview.textContent.includes(probe.expected) && probe.lastInput !== null) {
          probe.finalMs = performance.now() - probe.lastInput;
        }
      });
    }).observe(preview, { childList: true, subtree: true, characterData: true });
    return true;
  })()`);
}

async function resetProbe(expected = null, trackMutations = false) {
  await evaluate(`(() => {
    const p = window.__previewPerf;
    p.events = []; p.inputs = 0; p.long = []; p.lastInput = null; p.finalMs = null;
    p.trackMutations = ${Boolean(trackMutations)}; p.mutationNodes = 0;
    if ('mapFirst' in p) { p.mapFirst=null; p.mapLast=null; }
    p.expected = ${JSON.stringify(expected)}; p.baselineStarts = p.starts;
  })()`);
}

async function readProbe() {
  return evaluate(`(() => {
    const p = window.__previewPerf;
    const summarize = (events) => {
      const ages = events.map((event) => event.age).sort((a, b) => a - b);
      const pick = (fraction) => ages.length
        ? ages[Math.min(ages.length - 1, Math.ceil(ages.length * fraction) - 1)] : null;
      return { count: ages.length, p50: pick(0.50), p95: pick(0.95),
        p99: pick(0.99), max: ages.length ? ages.at(-1) : null };
    };
    return { all: summarize(p.events), overlap: summarize(p.events.filter((event) => event.overlap)),
      inputs: p.inputs, active: p.active.size, starts: p.starts - p.baselineStarts,
      longSupported: p.longSupported, longCount: p.long.length,
      longest: p.long.length ? Math.max(...p.long.map((entry)=>entry.duration)) : null,
      longEvents: p.long.map((entry)=>({...entry, relativeToLastInput:entry.start-p.lastInput})),
      finalMs: p.finalMs,
      mutationNodes: p.mutationNodes ?? 0 };
  })()`);
}

function describe(sample) {
  const value = (number) => (number === null ? "unavailable" : number.toFixed(1));
  return `n=${sample.count} p50=${value(sample.p50)} p95=${value(sample.p95)} p99=${value(sample.p99)} max=${value(sample.max)} ms`;
}

async function typeText(text, delayMs = 0) {
  const replies = [];
  for (const character of text) {
    const timestamp = Date.now() / 1000;
    const code = character === " " ? "Space" : `Key${character.toUpperCase()}`;
    const windowsVirtualKeyCode = character === " " ? 32 : character.toUpperCase().charCodeAt(0);
    const common = { key: character, code, windowsVirtualKeyCode, timestamp };
    replies.push(send("Input.dispatchKeyEvent", { ...common, type: "keyDown" }));
    replies.push(
      send("Input.dispatchKeyEvent", {
        ...common,
        type: "char",
        text: character,
        unmodifiedText: character,
      }),
    );
    replies.push(send("Input.dispatchKeyEvent", { ...common, type: "keyUp" }));
    if (delayMs) await sleep(delayMs);
  }
  await Promise.all(replies);
}

async function focusEditor() {
  await evaluate(`document.querySelector(".cm-content")?.focus()`);
}

async function waitForWorker(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate("window.__previewPerf.active.size > 0")) return true;
    await sleep(20);
  }
  return false;
}

const prosePerfReport = {
  mode: extreme ? "extreme" : "standard",
  firstPaintE2PMs: null,
  wordMapReadyMs: null,
  domMutationNodesCount: null,
  unchangedSubtreeIdentityRate: null,
  includeIpcCallsPerEdit: null,
  mermaidBlockingPaintMs: null,
  proseMarks: null,
  samples: {},
};

async function waitQuiet(expression, timeoutMs = 15000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await sleep(intervalMs);
  }
  return false;
}

/**
 * Snapshot element identity across `#preview` `<p>`, `<pre>`, and `<img>` siblings
 * using a `WeakSet` + tag counts before a single-char mid-document edit.
 */
async function captureSubtreeSnapshot() {
  return evaluate(`(() => {
    const preview = document.querySelector("#preview");
    if (!preview) return null;
    const nodes = [...preview.querySelectorAll("p, pre, img")];
    const byTag = { P: 0, PRE: 0, IMG: 0 };
    for (const node of nodes) {
      if (node.tagName in byTag) byTag[node.tagName] += 1;
    }
    window.__mdraftSubtreeSnap = {
      set: new WeakSet(nodes),
      total: nodes.length,
      byTag,
    };
    return { total: nodes.length, byTag };
  })()`);
}

async function diffSubtreeIdentity() {
  return evaluate(`(() => {
    const snap = window.__mdraftSubtreeSnap;
    const preview = document.querySelector("#preview");
    delete window.__mdraftSubtreeSnap;
    if (!snap || !preview) return null;
    const after = [...preview.querySelectorAll("p, pre, img")];
    let reused = 0;
    const reusedByTag = { P: 0, PRE: 0, IMG: 0 };
    const afterByTag = { P: 0, PRE: 0, IMG: 0 };
    for (const node of after) {
      if (node.tagName in afterByTag) afterByTag[node.tagName] += 1;
      if (snap.set.has(node)) {
        reused += 1;
        if (node.tagName in reusedByTag) reusedByTag[node.tagName] += 1;
      }
    }
    const denom = Math.max(snap.total, after.length);
    return {
      beforeTotal: snap.total,
      afterTotal: after.length,
      reused,
      beforeByTag: snap.byTag,
      afterByTag,
      reusedByTag,
      unchangedSubtreeIdentityRate:
        denom > 0 ? Math.round((reused / denom) * 1000000) / 1000000 : null,
    };
  })()`);
}

async function readProsePerfMarks(sinceTime = 0) {
  return evaluate(`(() => {
    const names = [...new Set(
      performance
        .getEntries()
        .filter((entry) => entry.name.startsWith("mdraft:prose:"))
        .map((entry) => entry.name),
    )];
    const entries = [];
    const byName = {};
    for (const name of names) {
      const matched = performance
        .getEntriesByName(name)
        .filter((entry) => entry.startTime >= ${sinceTime})
        .map((entry) => ({
          name: entry.name,
          entryType: entry.entryType,
          startTime: Math.round(entry.startTime * 1000) / 1000,
          duration: Math.round(entry.duration * 1000) / 1000,
        }));
      if (matched.length > 0) {
        byName[name] = matched;
        entries.push(...matched);
      }
    }
    return entries.length > 0 ? { count: entries.length, byName, entries } : null;
  })()`);
}

/**
 * Count `read_document` Tauri IPC calls via CDP `Fetch.enable` (safe on non-writable
 * `__TAURI_INTERNALS__`, falling back to `null` if interception is unavailable).
 */
async function countIncludeIpcDuring(asyncFn) {
  let ipcCalls = 0;
  let enabled = false;
  const off = addCdpListener("Fetch.requestPaused", async (params) => {
    if (params.request?.url?.includes("read_document")) {
      ipcCalls += 1;
    }
    await send("Fetch.continueRequest", { requestId: params.requestId }).catch(() => {});
  });
  try {
    await send("Fetch.enable", {
      patterns: [
        { urlPattern: "http://ipc.localhost/read_document*" },
        { urlPattern: "ipc://localhost/read_document*" },
      ],
    });
    enabled = true;
  } catch {
    off();
    await asyncFn();
    return null;
  }
  try {
    await asyncFn();
    return ipcCalls;
  } finally {
    off();
    if (enabled) {
      await send("Fetch.disable").catch(() => {});
    }
  }
}

/**
 * Helper ready for Phase 0/1 Mermaid (`adoc-tour`) CDP runs: measures long-task
 * blocking and rAF settle around rendered `#preview` Mermaid SVGs, or `null` when absent.
 */
async function measureMermaidBlockingPaintMs(timeoutMs = 5000) {
  const diagramCount = await evaluate(
    `document.querySelectorAll('#preview svg[id^="mermaid"], #preview .mermaid svg, #preview [data-mermaid]').length`,
  );
  if (!diagramCount) return null;
  const beforeLongCount = await evaluate(`window.__previewPerf?.long?.length ?? 0`);
  const t0 = await evaluate(`performance.now()`);
  await evaluate(
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
  );
  const afterInfo = await evaluate(`(() => {
    const p = window.__previewPerf;
    const recent = (p?.long ?? []).slice(${beforeLongCount});
    return {
      rAFSettleMs: Math.round((performance.now() - ${t0}) * 1000) / 1000,
      blockingLongTaskMaxMs: recent.length
        ? Math.round(Math.max(...recent.map((e) => e.duration)) * 1000) / 1000
        : 0,
    };
  })()`);
  void timeoutMs;
  return { diagramCount, ...afterInfo };
}

/**
 * Observational single-char mid-document edit probe capturing first-paint E2P,
 * wordMapReadyMs (`null`-safe before coordinator hooks), DOM mutation nodes,
 * WeakSet subtree identity rate, and `mdraft:prose:*` marks. Never alters `failed`.
 */
async function measureSingleCharProseSnapshot(label, waitTimeoutMs = 20000) {
  const markBaseline = await evaluate(`performance.now()`);
  const setup = await evaluate(`(() => {
    const view = document.querySelector('.cm-content')?.cmTile?.root?.view;
    if (!view) return null;
    const doc = view.state.doc.toString();
    const mid = Math.floor(doc.length * 0.5);
    const matches = [...doc.matchAll(/^(?:##|==) Section \\d+$/gm)];
    let match = null;
    let bestDist = Infinity;
    for (const m of matches) {
      const dist = Math.abs(m.index - mid);
      if (dist < bestDist) {
        bestDist = dist;
        match = m;
      }
    }
    let anchorPos = null;
    let baseToken = null;
    if (match) {
      baseToken = match[0].replace(/^(?:##|==)\\s+/, "");
      anchorPos = match.index + match[0].length;
    } else {
      const sliceStart = Math.max(0, mid - 200);
      const wordMatch = /\\b[A-Za-z][A-Za-z0-9_]{5,}\\b/.exec(doc.slice(sliceStart));
      if (!wordMatch) return null;
      baseToken = wordMatch[0];
      anchorPos = sliceStart + wordMatch.index + wordMatch[0].length;
    }
    const expected = baseToken + "z";
    if (doc.includes(expected)) return null;
    view.dispatch({ selection: { anchor: anchorPos }, scrollIntoView: true });
    return { expected, anchorPos };
  })()`);

  if (!setup) {
    return {
      label,
      skipped: true,
      firstPaintE2PMs: null,
      wordMapReadyMs: null,
      domMutationNodesCount: null,
      unchangedSubtreeIdentityRate: null,
      subtreeDetail: null,
      proseMarks: null,
    };
  }

  await evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  await sleep(100);
  await focusEditor();
  await captureSubtreeSnapshot();
  await resetProbe(setup.expected, true);
  await typeText("z");

  const painted = await waitQuiet("window.__previewPerf.finalMs !== null", waitTimeoutMs, 25);
  const firstPaintE2PMs = painted ? await evaluate("window.__previewPerf.finalMs") : null;

  let wordMapReadyMs = null;
  if (painted) {
    const hasHooks = await evaluate(
      `Boolean(window.__mdraftDebug || ('mapLast' in (window.__previewPerf ?? {}) && window.__previewPerf.mapLast !== null))`,
    );
    const pollBudget = hasHooks ? 2500 : 150;
    const deadline = Date.now() + pollBudget;
    while (Date.now() < deadline) {
      const candidate = await evaluate(`(() => {
        const dbg = window.__mdraftDebug;
        const p = window.__previewPerf;
        if (dbg && typeof dbg.wordMapReadyMs === "number") return dbg.wordMapReadyMs;
        if (dbg && typeof dbg.lastWordMapMs === "number") return dbg.lastWordMapMs;
        if (dbg && typeof dbg.wordMapDoneAt === "number" && p?.lastInput !== null) {
          return Math.max(0, dbg.wordMapDoneAt - p.lastInput);
        }
        if (typeof p?.mapLast === "number" && p.lastInput !== null && p.mapLast >= p.lastInput) {
          return p.mapLast - p.lastInput;
        }
        return null;
      })()`);
      if (typeof candidate === "number") {
        wordMapReadyMs = Math.round(candidate * 1000) / 1000;
        break;
      }
      await sleep(50);
    }
  }

  const [probe, subtreeDetail, proseMarks] = await Promise.all([
    readProbe(),
    diffSubtreeIdentity(),
    readProsePerfMarks(markBaseline),
  ]);

  return {
    label,
    skipped: false,
    firstPaintE2PMs: firstPaintE2PMs === null ? null : Math.round(firstPaintE2PMs * 1000) / 1000,
    wordMapReadyMs,
    domMutationNodesCount: probe.mutationNodes ?? null,
    unchangedSubtreeIdentityRate: subtreeDetail?.unchangedSubtreeIdentityRate ?? null,
    subtreeDetail,
    proseMarks,
  };
}

async function measureVisibleRender(label, marker, enforceBudget) {
  await focusEditor();
  // A quiet-period render gives every sample a live conversion to interrupt.
  // The app intentionally cancels it on the first edit, so a rapid burst alone
  // cannot honestly supply 20 independent in-flight samples.
  await typeText("w");
  await resetProbe();
  for (let index = 0; index < 20; index += 1) {
    if (!(await waitForWorker())) break;
    await typeText("a");
  }
  const repeated = await readProbe();
  check(
    `${label}: at least 20 input events overlap an active worker`,
    repeated.overlap.count >= 20 && repeated.inputs >= 20,
    `${describe(repeated.overlap)}, ${repeated.inputs} input events`,
  );
  if (enforceBudget) {
    check(
      `${label}: in-flight p95 <= 100 ms and max <= 150 ms`,
      repeated.overlap.count >= 20 && repeated.overlap.p95 <= 100 && repeated.overlap.max <= 150,
      describe(repeated.overlap),
    );
  } else {
    console.log(`  INFO  ${label} in-flight input: ${describe(repeated.overlap)}`);
  }

  await resetProbe(marker);
  const started = await waitForWorker();
  const sampleLayoutKeys = extreme && process.env.MDRAFT_PREVIEW_LAYOUT_KEYS === "1";
  let layoutTimer;
  const layoutReplies = [];
  if (sampleLayoutKeys) {
    await evaluate(`(() => {
      const events = window.__previewLayoutKeys = [];
      window.addEventListener('keydown', event => {
        if (event.key === 'ArrowRight' && event.target?.closest?.('.cm-content'))
          events.push({at:event.timeStamp, age:Math.max(0,performance.now()-event.timeStamp)});
      }, true);
    })()`);
  }
  const profiling = extreme && process.env.MDRAFT_PREVIEW_CPU_PROFILE === "1";
  if (profiling) {
    await send("Profiler.enable");
    await send("Profiler.setSamplingInterval", { interval: 1000 });
    await send("Profiler.start");
  }
  await typeText(`rapidtypingduringrender${marker}`, 15);
  if (sampleLayoutKeys) {
    layoutTimer = setInterval(() => {
      const common = {
        key: "ArrowRight",
        code: "ArrowRight",
        windowsVirtualKeyCode: 39,
        timestamp: Date.now() / 1000,
      };
      layoutReplies.push(send("Input.dispatchKeyEvent", { ...common, type: "keyDown" }));
      layoutReplies.push(send("Input.dispatchKeyEvent", { ...common, type: "keyUp" }));
    }, 30);
    // A busy renderer may delay the final frame; never keep injecting input
    // indefinitely or turn the probe itself into sustained user activity.
    setTimeout(() => clearInterval(layoutTimer), 8000);
  }
  check(
    `${label}: final edited text reaches the preview`,
    await waitFor(`${label}: final preview`, "window.__previewPerf.finalMs !== null", 120000),
  );
  if (layoutTimer) {
    clearInterval(layoutTimer);
    await Promise.all(layoutReplies);
    const layout = await evaluate(`(() => {
      const events = window.__previewLayoutKeys, tasks = window.__previewPerf.long;
      const ages = events.map(e => e.age).sort((a,b)=>a-b);
      const at = q => ages.length ? ages[Math.min(ages.length-1,Math.ceil(ages.length*q)-1)] : null;
      return {count:ages.length,p50:at(.5),p95:at(.95),p99:at(.99),max:ages.at(-1) ?? null,
        taskOverlap:events.filter(e=>tasks.some(t=>e.at>=t.start&&e.at<t.start+t.duration)).length};
    })()`);
    check(
      `${label}: layout input sampling received events`,
      layout.count >= 20,
      JSON.stringify(layout),
    );
    if (process.env.MDRAFT_PREVIEW_VERIFY_GROUPS === "1") {
      check(
        `${label}: layout p95 <= 100 ms and max <= 150 ms`,
        layout.count >= 20 && layout.p95 <= 100 && layout.max <= 150,
        JSON.stringify(layout),
      );
    }
  }
  const burst = await readProbe();
  if (profiling) {
    const profile = await send("Profiler.stop");
    const profilePath = path.join(os.tmpdir(), "mdraft-preview-extreme-cpu.cpuprofile");
    fs.writeFileSync(profilePath, JSON.stringify(profile.result.profile));
    console.log(`  INFO  CPU profile: ${profilePath}`);
  }
  check(
    `${label}: rapid input has a nonempty sample and overlaps rendering`,
    started && burst.all.count >= 30 && burst.inputs >= 30 && burst.overlap.count >= 1,
    `${describe(burst.all)}, overlap=${burst.overlap.count}, inputs=${burst.inputs}`,
  );
  if (enforceBudget) {
    check(
      `${label}: rapid input p95 <= 100 ms and max <= 150 ms`,
      burst.all.count >= 30 && burst.all.p95 <= 100 && burst.all.max <= 150,
      describe(burst.all),
    );
  }
  console.log(
    `  INFO  ${label} last input to matching preview frame: ${burst.finalMs?.toFixed(1) ?? "unavailable"} ms`,
  );
  console.log(
    `  INFO  ${label} Long Tasks: ${
      burst.longSupported
        ? `${burst.longCount} observed, longest ${burst.longest?.toFixed(1) ?? "none"} ms`
        : "unavailable"
    }`,
  );
  if (extreme && burst.longSupported) {
    console.log(`  INFO  Long Tasks relative to final input: ${JSON.stringify(burst.longEvents)}`);
  }
}

// ---------------------------------------------------------------------------
// Markdown, Source mode, positive control, and AsciiDoc
// ---------------------------------------------------------------------------

await installProbe();
if (extreme && process.env.MDRAFT_PREVIEW_VERIFY_GROUPS === "1") {
  await evaluate(`(() => {
    const original=document.createTreeWalker.bind(document),p=window.__previewPerf;
    p.mapFirst=null;p.mapLast=null;
    document.createTreeWalker=(root,...args)=>{
      if(root instanceof Element && (root.hasAttribute('data-f') || root.hasAttribute('data-b'))){
        const now=performance.now();p.mapFirst??=now;p.mapLast=now;
      }
      return original(root,...args);
    };
  })()`);
}
if (extreme && process.env.MDRAFT_PREVIEW_GROUP_SIZE) {
  const groupSize = Number(process.env.MDRAFT_PREVIEW_GROUP_SIZE);
  if (!Number.isInteger(groupSize) || groupSize < 1 || groupSize > 10000)
    throw new Error("MDRAFT_PREVIEW_GROUP_SIZE must be an integer from 1 to 10000");
  const install =
    process.env.MDRAFT_PREVIEW_GROUP_PHASE === "worker"
      ? installGroupedChunksPrototype
      : installGroupPrototype;
  const supported = await evaluate(`(${install.toString()})(${groupSize})`);
  if (!supported) throw new Error("The webview does not support content-visibility");
  console.log(`  INFO  test-only grouping enabled: ${groupSize} blocks per group`);
}
const openStarted = Date.now();
await invoke("plugin:event|emit", { event: "open-files", payload: [file] });
await waitFor(
  "the large document opens",
  `document.title.includes("preview-performance.md")`,
  30000,
);
console.log(
  `  INFO  file open to title: ${Date.now() - openStarted} ms, ${fs.statSync(file).size} bytes`,
);
await invoke("plugin:event|emit", { event: "menu", payload: "view.split" });
if (extreme) {
  const marker = "extremefinalpreviewmarker";
  await measureVisibleRender("Markdown 10.8 MB CRLF on disk", marker, false);
  if (
    process.env.MDRAFT_PREVIEW_VERIFY_GROUPS === "1" &&
    process.env.MDRAFT_PREVIEW_LAYOUT_KEYS === "1"
  ) {
    await focusEditor();
    await evaluate(`window.__previewLayoutKeys.length=0`);
    const replies = [];
    const timer = setInterval(() => {
      const common = {
        key: "ArrowRight",
        code: "ArrowRight",
        windowsVirtualKeyCode: 39,
        timestamp: Date.now() / 1000,
      };
      replies.push(send("Input.dispatchKeyEvent", { ...common, type: "keyDown" }));
      replies.push(send("Input.dispatchKeyEvent", { ...common, type: "keyUp" }));
    }, 30);
    await sleep(4000);
    clearInterval(timer);
    await Promise.all(replies);
    const mapInput = await evaluate(`(() => {
      const ages=window.__previewLayoutKeys.map(e=>e.age).sort((a,b)=>a-b);
      const at=q=>ages.length?ages[Math.min(ages.length-1,Math.ceil(ages.length*q)-1)]:null;
      const p=window.__previewPerf,events=window.__previewLayoutKeys;
      return {count:ages.length,p95:at(.95),p99:at(.99),max:ages.at(-1)??null,
        mapOverlap:events.filter(e=>e.at>=p.mapFirst&&e.at<=p.mapLast).length,mapFirst:p.mapFirst,mapLast:p.mapLast};
    })()`);
    check(
      "extreme: post-paint input samples cover deferred work",
      mapInput.count >= 20 && mapInput.mapOverlap > 0,
      JSON.stringify(mapInput),
    );
    check(
      "extreme: post-paint input p95 <= 100 ms and max <= 150 ms",
      mapInput.count >= 20 && mapInput.p95 <= 100 && mapInput.max <= 150,
      JSON.stringify(mapInput),
    );
  }
  if (process.env.MDRAFT_PREVIEW_GROUP_SIZE) {
    console.log(
      `  INFO  group prototype: ${JSON.stringify(await evaluate("window.__previewGroupPrototype"))}`,
    );
  }

  // The map may legitimately take longer than the first paint. Check both
  // directions after the current render instead of imposing the old 600 ms cap.
  const mapStarted = Date.now();
  const sourceSelected = await evaluate(`(() => {
    const view = document.querySelector('.cm-content')?.cmTile?.root?.view;
    if (!view) return false;
    const index = view.state.doc.toString().indexOf(${JSON.stringify(marker)});
    if (index < 0) return false;
    view.dispatch({selection:{anchor:index,head:index+${marker.length}}});
    return true;
  })()`);
  const poll = async (expression, timeoutMs = 60000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return true;
      await sleep(100);
    }
    return false;
  };
  const sourceToPreview =
    sourceSelected &&
    (await poll(`(() => {
      const highlight = CSS.highlights?.get('mdraft-sync') ?? CSS.highlights?.get('mdraft-sync-peak');
      return Boolean(highlight && [...highlight].some(range => range.toString().includes(${JSON.stringify(marker)})));
    })()`));
  check("extreme: word sync returns from source to preview", sourceToPreview);

  const previewSelected = await evaluate(`(() => {
    const host = document.getElementById('preview');
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.data.indexOf(${JSON.stringify(marker)});
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + ${marker.length});
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      host.dispatchEvent(new MouseEvent('dblclick', {bubbles:true}));
      return true;
    }
    return false;
  })()`);
  const previewToSource =
    previewSelected &&
    (await poll(
      `([...document.querySelectorAll('.cm-sync-word')].map(node => node.textContent).join('')).includes(${JSON.stringify(marker)})`,
    ));
  check("extreme: word sync returns from preview to source", previewToSource);
  console.log(`  INFO  extreme word sync after the preview: ${Date.now() - mapStarted} ms`);
  if (process.env.MDRAFT_PREVIEW_GROUP_SIZE || process.env.MDRAFT_PREVIEW_VERIFY_GROUPS === "1") {
    const groupLabel =
      process.env.MDRAFT_PREVIEW_VERIFY_GROUPS === "1" ? "production grouping" : "group prototype";
    if (process.env.MDRAFT_PREVIEW_VERIFY_GROUPS === "1") {
      const groups = await evaluate(
        `document.querySelectorAll('#preview > .md-preview-group').length`,
      );
      check(
        "production: large independent paragraphs use grouped layout",
        groups === 1125,
        String(groups),
      );
    }
    const scroll = await evaluate(`(() => {
      const pane=document.getElementById('preview-pane');
      const target=document.querySelector('#preview [data-line="72001"]');
      if(!target)return null;
      target.scrollIntoView({block:'center'});
      const box=target.getBoundingClientRect(),outer=pane.getBoundingClientRect();
      return {top:pane.scrollTop,visible:box.bottom>outer.top&&box.top<outer.bottom,
        text:target.textContent?.slice(0,20)};
    })()`);
    check(
      `${groupLabel}: a middle paragraph can be revealed`,
      scroll?.top > 0 && scroll.visible,
      JSON.stringify(scroll),
    );
    const selection = await evaluate(`(() => {
      const nodes=document.querySelectorAll('#preview [data-line]');
      const a=nodes[63]?.querySelector('[data-f]')?.firstChild;
      const b=nodes[64]?.querySelector('[data-f]')?.firstChild;
      if(!a||!b)return '';
      const range=document.createRange();range.setStart(a,0);range.setEnd(b,Math.min(5,b.length));
      const selected=window.getSelection();selected.removeAllRanges();selected.addRange(range);
      return selected.toString();
    })()`);
    check(
      `${groupLabel}: selection crosses a group boundary`,
      selection.includes("alpha") && selection.length > 100,
    );
    const gaps = await evaluate(`(() => {
      const nodes=document.querySelectorAll('#preview [data-line]');
      const a=nodes[62]?.getBoundingClientRect(),b=nodes[63]?.getBoundingClientRect(),c=nodes[64]?.getBoundingClientRect();
      return a&&b&&c?{inside:b.top-a.bottom,boundary:c.top-b.bottom}:null;
    })()`);
    check(
      `${groupLabel}: paragraph spacing survives a group boundary`,
      gaps && Math.abs(gaps.inside - gaps.boundary) < 1,
      JSON.stringify(gaps),
    );
    check(
      `${groupLabel}: browser find sees the edited marker`,
      await evaluate(`window.find(${JSON.stringify(marker)}, false, false, true)`),
    );
    if (process.env.MDRAFT_PREVIEW_VERIFY_GROUPS === "1") {
      await evaluate(`(() => {window.__previewPerf.long=[];
        const pane=document.getElementById('preview-pane');pane.scrollTop=pane.scrollHeight;
      })()`);
      await sleep(1000);
      const scrollTasks = await evaluate(`window.__previewPerf.long.map(task=>task.duration)`);
      console.log(`  INFO  long tasks after scrolling to the end: ${JSON.stringify(scrollTasks)}`);
    }
    for (const zoom of [0.5, 1.5, 3]) {
      const result = await evaluate(`(() => {
        const host=document.getElementById('preview'),pane=document.getElementById('preview-pane');
        host.style.zoom=${zoom};
        const target=host.querySelector('[data-line="72001"]');
        target.scrollIntoView({block:'center'});
        const box=target.getBoundingClientRect(),outer=pane.getBoundingClientRect();
        return {visible:box.bottom>outer.top&&box.top<outer.bottom,top:pane.scrollTop};
      })()`);
      check(
        `${groupLabel}: middle paragraph remains reachable at ${zoom * 100}%`,
        result.visible && result.top > 0,
        JSON.stringify(result),
      );
    }
    await evaluate(`(async()=>{document.getElementById('preview').style.removeProperty('zoom');
      document.querySelector('#preview [data-line="72001"]').scrollIntoView({block:'center'});
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()`);
    const axTarget = await send("Runtime.evaluate", {
      expression: `document.querySelector('#preview [data-line="72001"]')`,
    });
    const ax = await send("Accessibility.getPartialAXTree", {
      objectId: axTarget.result.result.objectId,
      fetchRelatives: false,
    });
    check(
      `${groupLabel}: visible paragraph is in the accessibility tree`,
      ax.result.nodes.some((node) => !node.ignored && node.role?.value === "paragraph"),
    );
  }
  const extremeSample = await measureSingleCharProseSnapshot("md-extreme-single-char", 60000);
  prosePerfReport.samples.markdownExtreme = extremeSample;
  prosePerfReport.firstPaintE2PMs = extremeSample.firstPaintE2PMs;
  prosePerfReport.wordMapReadyMs = extremeSample.wordMapReadyMs;
  prosePerfReport.domMutationNodesCount = extremeSample.domMutationNodesCount;
  prosePerfReport.unchangedSubtreeIdentityRate = extremeSample.unchangedSubtreeIdentityRate;
  prosePerfReport.proseMarks = extremeSample.proseMarks;
} else {
  await measureVisibleRender("Markdown 1.2 MB", "markdownfinalpreviewmarker", true);

  await invoke("plugin:event|emit", { event: "menu", payload: "view.source" });
  await sleep(300);
  await focusEditor();
  await resetProbe();
  await typeText("sourcemodetypinghasnopreviewwork", 15);
  await sleep(700);
  const source = await readProbe();
  check(
    "Source mode receives the actual typing",
    source.all.count >= 30 && source.inputs >= 30,
    `${describe(source.all)}, inputs=${source.inputs}`,
  );
  check(
    "Source mode starts no worker render",
    source.starts === 0 && source.active === 0,
    `${source.starts} starts, ${source.active} active`,
  );

  // Deliberately hold the UI for 350 ms while a burst is queued. Without this
  // control, clock-domain mistakes and empty samples can make every budget pass.
  await resetProbe();
  await evaluate(`setTimeout(() => {
  const until = performance.now() + 350;
  while (performance.now() < until) {}
}, 100); true`);
  await sleep(120);
  await typeText("detectanintentionalblockingburst", 10);
  await sleep(150);
  const control = await readProbe();
  check(
    "latency probe detects an intentional 350 ms main-thread block",
    control.all.count >= 20 &&
      control.inputs >= 20 &&
      control.all.p95 >= 100 &&
      control.all.max >= 150,
    describe(control.all),
  );

  await invoke("plugin:event|emit", { event: "menu", payload: "view.split" });
  await sleep(100);
  await focusEditor();
  await typeText("returnsplitmarker");
  check(
    "returning to Split renders the current source",
    await waitFor(
      "Split preview",
      `document.querySelector("#preview")?.textContent.includes("returnsplitmarker")`,
      120000,
    ),
  );

  const mdSample = await measureSingleCharProseSnapshot("md-single-char", 20000);
  prosePerfReport.samples.markdown = mdSample;
  prosePerfReport.firstPaintE2PMs = mdSample.firstPaintE2PMs;
  prosePerfReport.wordMapReadyMs = mdSample.wordMapReadyMs;
  prosePerfReport.domMutationNodesCount = mdSample.domMutationNodesCount;
  prosePerfReport.unchangedSubtreeIdentityRate = mdSample.unchangedSubtreeIdentityRate;
  prosePerfReport.proseMarks = mdSample.proseMarks;

  await invoke("plugin:event|emit", { event: "menu", payload: "file.save" });
  await waitFor(
    "the Markdown document saves",
    `!document.title.includes(String.fromCharCode(8226))`,
    10000,
  );
  await invoke("plugin:event|emit", { event: "open-files", payload: [adocFile] });
  await waitFor(
    "the large AsciiDoc document opens",
    `document.title.includes("preview-performance.adoc")`,
    30000,
  );
  await measureVisibleRender("AsciiDoc 600 KB", "asciidocfinalpreviewmarker", false);

  let adocSample = null;
  const includeIpc = await countIncludeIpcDuring(async () => {
    adocSample = await measureSingleCharProseSnapshot("adoc-single-char", 20000);
  });
  prosePerfReport.includeIpcCallsPerEdit = includeIpc;
  prosePerfReport.mermaidBlockingPaintMs = await measureMermaidBlockingPaintMs();
  prosePerfReport.samples.asciidoc = adocSample;

  // Compare the same real keyboard events with spelling off and on. Keep the
  // editor in Source mode so preview conversion does not obscure this cost.
  await invoke("plugin:event|emit", { event: "menu", payload: "file.save" });
  await waitFor(
    "the AsciiDoc document saves",
    `!document.title.includes(String.fromCharCode(8226))`,
    10000,
  );
  const spellFiles = [
    ["Markdown", file],
    ["HTML", path.join(directory, "spell-performance.html")],
    ["JavaScript", path.join(directory, "spell-performance.js")],
    ["JSON", path.join(directory, "spell-performance.json")],
  ];
  const sentence = "This ordinary paragraph contains several words for local spelling checks.";
  fs.writeFileSync(
    spellFiles[1][1],
    `<html><body>\n${`<p>${sentence}</p>\n`.repeat(15000)}</body></html>`,
  );
  fs.writeFileSync(spellFiles[2][1], `// ${sentence}\n`.repeat(15000));
  fs.writeFileSync(
    spellFiles[3][1],
    `{\n${Array.from({ length: 12000 }, (_, index) => `"description${index}": "${sentence}"`).join(",\n")}\n}`,
  );
  const languages = await invoke("spellcheck_languages");
  if (!languages.length) {
    console.log("  SKIP  spelling performance comparison: no installed dictionary");
  } else {
    const dictionary = languages.includes("en") ? "en" : languages[0];
    async function setSpelling(enabled) {
      return evaluate(`(() => {
        document.getElementById('btn-prefs').click();
        [...document.querySelectorAll('.prefs-section')].find(section => section.textContent === 'Editor')?.click();
        const row = label => [...document.querySelectorAll('.prefs-row')].find(item => item.textContent.includes(label));
        const select = row('Dictionary')?.querySelector('select');
        if (select) { select.value = ${JSON.stringify(dictionary)}; select.dispatchEvent(new Event('change', {bubbles:true})); }
        const box = row('Check spelling while typing')?.querySelector('input[type=checkbox]');
        if (box && box.checked !== ${enabled}) { box.checked = ${enabled}; box.dispatchEvent(new Event('change', {bubbles:true})); }
        const ok = Boolean(box && box.checked === ${enabled} && select?.value === ${JSON.stringify(dictionary)});
        document.querySelector('.prefs-close')?.click();
        return ok;
      })()`);
    }
    await invoke("plugin:event|emit", { event: "menu", payload: "view.source" });
    for (const [label, sourceFile] of spellFiles) {
      await invoke("plugin:event|emit", { event: "open-files", payload: [sourceFile] });
      if (
        !(await waitFor(
          `${label} spelling fixture opens`,
          `document.title.includes(${JSON.stringify(path.basename(sourceFile))})`,
          30000,
        ))
      )
        continue;
      const samples = { off: [], on: [] };
      for (const enabled of [false, true]) {
        const mode = enabled ? "on" : "off";
        if (!(await setSpelling(enabled))) {
          check(`${label}: spelling ${mode} can be selected`, false);
          continue;
        }
        await sleep(900);
        if (
          enabled &&
          !(await waitFor(
            `${label}: spelling becomes active`,
            `document.getElementById('flag-spellcheck')?.title.includes('Underlines words')`,
            30000,
          ))
        )
          continue;
        for (let run = 1; run <= 3; run += 1) {
          const positioned = await evaluate(`(() => {
            const view = document.querySelector('.cm-content')?.cmTile?.root?.view;
            if (!view) return false;
            const text = view.state.doc.toString();
            const at = ${JSON.stringify(label)} === 'Markdown' ? 100 : text.indexOf(${JSON.stringify(sentence)});
            if (at < 0) return false;
            view.dispatch({selection: {anchor: at + 5}});
            return true;
          })()`);
          if (!positioned) {
            check(`${label}: spelling ${mode} run ${run} positions the caret in prose`, false);
            continue;
          }
          await focusEditor();
          await resetProbe();
          await typeText("ordinaryspellingperformancesample", 15);
          await sleep(500);
          const sample = await readProbe();
          const memory = await evaluate(`performance.memory?.usedJSHeapSize ?? null`);
          samples[mode].push(sample.all.p95);
          check(
            `${label}: spelling ${mode} run ${run} input budget`,
            sample.all.count >= 30 && sample.all.p95 <= 100 && sample.all.max <= 150,
            `${describe(sample.all)}, heap=${memory === null ? "unavailable" : `${(memory / 1048576).toFixed(1)} MB`}`,
          );
        }
      }
      if (samples.on.length === 3 && samples.off.length === 3) {
        const median = (values) => [...values].sort((a, b) => a - b)[1];
        console.log(
          `  INFO  ${label} spelling median p95 difference: ${(median(samples.on) - median(samples.off)).toFixed(1)} ms`,
        );
      }
      await invoke("plugin:event|emit", { event: "menu", payload: "file.save" });
      await waitFor(
        `${label} spelling fixture saves`,
        `!document.title.includes(String.fromCharCode(8226))`,
        10000,
      );
    }
  }
}

try {
  const tempRoot = path.resolve(os.tmpdir());
  if (
    path.dirname(directory) === tempRoot &&
    path.basename(directory).startsWith("mdraft-preview-perf-")
  ) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
} catch {
  // The OS temp directory can clean an open fixture later.
}

console.log(`PROSE_PERF_JSON ${JSON.stringify(prosePerfReport)}`);
console.log(`\n${passed}/${passed + failed} checks passed`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
