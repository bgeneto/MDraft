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
} from "../docs/audits/preview-group-prototype.mjs";

const port = process.argv[2] ?? "9222";
const extreme = process.env.MDRAFT_PREVIEW_EXTREME === "1";

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
    const { resolve, reject } = pending.get(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message);
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
      long: [], longSupported: false, lastInput: null, expected: null, finalMs: null
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
    new MutationObserver(() => {
      if (!probe.expected || probe.lastInput === null || probe.finalMs !== null ||
          !preview.textContent.includes(probe.expected)) return;
      requestAnimationFrame(() => {
        if (probe.expected && preview.textContent.includes(probe.expected) && probe.lastInput !== null) {
          probe.finalMs = performance.now() - probe.lastInput;
        }
      });
    }).observe(preview, { childList: true });
    return true;
  })()`);
}

async function resetProbe(expected = null) {
  await evaluate(`(() => {
    const p = window.__previewPerf;
    p.events = []; p.inputs = 0; p.long = []; p.lastInput = null; p.finalMs = null;
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
      finalMs: p.finalMs };
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

console.log(`\n${passed}/${passed + failed} checks passed`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
