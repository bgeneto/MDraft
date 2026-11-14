//! Content-pair geometry, both scroll directions in every preview adapter.
//! Run through `npm test -- --only sync`. MDRAFT_SYNC_BASELINE=1 records a
//! baseline and skips the precision/lifecycle assertions.
import fs from "node:fs";
import path from "node:path";

const port = process.argv[2] ?? "9222";
const baseline = process.env.MDRAFT_SYNC_BASELINE === "1";
// MDRAFT_SYNC_MODES=pages,html narrows the run to those adapters and prints
// every sample: the loop for working on one adapter without the other four.
const onlyModes = (process.env.MDRAFT_SYNC_MODES ?? "").split(",").filter(Boolean);
const repo = process.env.MDRAFT_REPO ?? process.cwd();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const REQUEST_TIMEOUT_MS = 15_000;

class Client {
  next = 0;
  pending = new Map();
  closed = false;
  constructor(ws) {
    this.ws = ws;
    ws.addEventListener("message", ({ data }) => {
      let reply;
      try {
        reply = JSON.parse(data);
      } catch {
        return;
      }
      // An exception in a page handler is otherwise silent here: the click that
      // caused it simply appears to do nothing.
      if (reply.method === "Runtime.exceptionThrown") {
        const thrown = reply.params?.exceptionDetails;
        console.log(
          `  EXCEPTION ${thrown?.exception?.description ?? thrown?.text ?? "unknown"}`.slice(
            0,
            600,
          ),
        );
        return;
      }
      const entry = this.pending.get(reply.id);
      if (!entry) return;
      this.pending.delete(reply.id);
      clearTimeout(entry.timer);
      entry.resolve(reply);
    });
    const fail = () => {
      if (this.closed) return;
      this.closed = true;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("CDP target closed"));
      }
      this.pending.clear();
    };
    ws.addEventListener("close", fail);
    ws.addEventListener("error", fail);
  }
  static async connect(target) {
    if (!target) throw new Error(`No CDP target on port ${port}`);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out opening CDP socket")), 15_000);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("The CDP socket failed to open"));
        },
        { once: true },
      );
    });
    const client = new Client(ws);
    await client.send("Runtime.enable");
    return client;
  }
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP target closed"));
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async evaluate(expression) {
    const reply = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (reply.error || reply.result?.exceptionDetails)
      throw new Error(JSON.stringify(reply.error ?? reply.result.exceptionDetails));
    return reply.result?.result?.value;
  }
}

const checks = [];
function check(ok, label, detail = "") {
  checks.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

/** Nearest-rank percentile; for 20 samples p95 is the 19th, not the maximum. */
function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

const installProbe = `window.__scrollProbe = (word, root = document.body) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('script,style')) continue;
    const at = node.data.indexOf(word);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at); range.setEnd(node, at + word.length);
    const r = range.getBoundingClientRect();
    if (r.width && r.height) return { top:r.top, left:r.left, height:r.height, centre:(r.top+r.bottom)/2 };
  }
  return null;
}; 'ok'`;

const view = `document.querySelector('.cm-content').cmTile.root.view`;
let page = null;
let guest = null;
let currentMode = "";

const targets = () => fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());

async function wait(expression, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.evaluate(expression)) return;
    await sleep(100);
  }
  throw new Error(`Timed out: ${expression}`);
}

async function invoke(command, args = {}) {
  return page.evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`,
  );
}

async function menu(id) {
  await invoke("plugin:event|emit", { event: "menu", payload: id });
  await sleep(320);
}

/**
 * Connect to the active guest. With `expectedSrc`, wait for a different frame —
 * but only for `graceMs`: an unchanged document keeps its guest (the freshness
 * key skips the rebuild), so after the grace period the same frame is accepted.
 */
async function connectGuest(expectedSrc = null, graceMs = Infinity) {
  const started = Date.now();
  for (let i = 0; i < 120; i += 1) {
    const src = await page.evaluate(
      `document.querySelector('.html-preview-frame.active')?.src ?? null`,
    );
    if (src && (!expectedSrc || src !== expectedSrc || Date.now() - started > graceMs)) {
      const target = (await targets()).find(
        (candidate) => candidate.type === "iframe" && candidate.url.startsWith(src),
      );
      if (target) {
        try {
          guest?.ws.close();
        } catch {
          /* already gone */
        }
        guest = await Client.connect(target);
        return guest;
      }
    }
    await sleep(100);
  }
  throw new Error("Timed out waiting for the HTML guest target");
}

function previewClient() {
  if (currentMode === "html") {
    if (!guest) throw new Error("The HTML guest is not connected");
    return guest;
  }
  return page;
}

function probeRoot(mode) {
  return mode === "html" ? "document.body" : "document.getElementById('preview')";
}

async function previewTop() {
  if (currentMode === "html") return guest.evaluate("window.scrollY");
  return page.evaluate("document.getElementById('preview-pane').scrollTop");
}

async function frameGeometry() {
  return page.evaluate(`(() => {
    const frame = document.querySelector('.html-preview-frame.active');
    if (!frame) return null;
    const rect = frame.getBoundingClientRect();
    const zoom = parseFloat(getComputedStyle(frame).zoom || '1');
    return { top: rect.top, scale: Number.isFinite(zoom) && zoom > 0 ? zoom : 1 };
  })()`);
}

async function measureWord(word, mode) {
  const a = await page.evaluate(`(() => {
    const v=${view};
    const pos=v.state.doc.toString().indexOf(${JSON.stringify(word)});
    const r=v.coordsAtPos(pos);
    return r ? { top:r.top, height:r.bottom-r.top } : null;
  })()`);
  const b = await previewClient().evaluate(
    `window.__scrollProbe(${JSON.stringify(word)}, ${probeRoot(mode)})`,
  );
  if (!a || !b) return null;
  let frameTop = 0;
  let scale = 1;
  if (mode === "html") {
    const frame = await frameGeometry();
    if (!frame) return null;
    frameTop = frame.top;
    scale = frame.scale;
  }
  // Row centres: the solver levels the rows, and two rows of different font
  // sizes that are level do not share a top.
  const previewTopAt =
    (mode === "html" ? frameTop + (b.top + b.height / 2) * scale : b.top + b.height / 2) -
    a.height / 2;
  return {
    error: Math.abs(a.top - previewTopAt),
    height: Math.max(a.height, b.height * (mode === "html" ? scale : 1)),
    sourceTop: a.top,
    sourceHeight: a.height,
    previewTop: previewTopAt,
    previewHeight: b.height * (mode === "html" ? scale : 1),
    scale,
  };
}

/**
 * A scroll correction that crosses a column, page or lazy page can take more
 * than one frame. Poll until it has been small twice, so a transient during the
 * transition is not reported as the settled error, and never wait forever.
 */
async function settle(word, mode, timeout = 1200) {
  const end = Date.now() + timeout;
  let last = null;
  let stable = 0;
  while (Date.now() < end) {
    const measured = await measureWord(word, mode);
    if (!measured) {
      stable = 0;
    } else {
      last = measured;
      const threshold = Math.min(4, last.height * 0.5);
      stable = last.error <= threshold ? stable + 1 : 0;
      if (stable >= 2) break;
    }
    await sleep(50);
  }
  return last;
}

async function scrollSourceTo(word) {
  await page.evaluate(`(() => {
    const v=${view};
    const pos=v.state.doc.toString().indexOf(${JSON.stringify(word)});
    v.scrollDOM.scrollTop=Math.max(0,v.lineBlockAt(pos).top-100);
  })()`);
  await sleep(120);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const point = await page.evaluate(`(() => {
      const v=${view};
      const pos=v.state.doc.toString().indexOf(${JSON.stringify(word)});
      const r=v.coordsAtPos(pos);
      // Compiler chrome reserves space above the preview, so source top is not
      // necessarily visible in both panes. Probe the same shared reference as
      // the solver rather than demanding a word behind the toolbar align.
      const commonTop=Math.max(v.scrollDOM.getBoundingClientRect().top,document.getElementById('preview-pane').getBoundingClientRect().top);
      return r ? { top:(r.top+r.bottom)/2, paneTop:commonTop } : null;
    })()`);
    if (point) {
      const delta = point.top - point.paneTop - 12;
      if (Math.abs(delta) < 1) break;
      await page.evaluate(`${view}.scrollDOM.scrollTop += ${delta}`);
    } else {
      await page.evaluate(`${view}.scrollDOM.scrollTop += 200`);
    }
    await sleep(60);
  }
}

async function scrollPreviewTo(word, mode) {
  const preview = previewClient();
  const target = await preview.evaluate(
    `window.__scrollProbe(${JSON.stringify(word)}, ${probeRoot(mode)})`,
  );
  if (!target) return false;
  if (mode === "html") {
    await preview.evaluate(`window.scrollTo(0, window.scrollY + ${target.centre} - 12)`);
  } else {
    await page.evaluate(`(() => {
      const p=document.getElementById('preview-pane');
      p.dispatchEvent(new WheelEvent('wheel',{clientX:${target.left + 2},clientY:p.getBoundingClientRect().top+12,bubbles:true}));
      p.scrollTop += ${target.centre} - p.getBoundingClientRect().top - 12;
    })()`);
  }
  return true;
}

// --- Gesture probe (docs/architecture.md) ----------
// A real click on a word in one pane, then the vertical distance between that
// word's row centre and its counterpart's row centre in the other pane. Row
// centres, in screen pixels, because that is what "side by side" means when
// the two panes use different font sizes.

const installBoxProbe = `window.__scrollBox = (word, root = document.body) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('script,style')) continue;
    const at = node.data.indexOf(word);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at); range.setEnd(node, at + word.length);
    const r = range.getBoundingClientRect();
    if (r.width && r.height) return { top:r.top, bottom:r.bottom, left:r.left, right:r.right };
  }
  return null;
}; 'ok'`;

/** The band both panes show, and each pane's own scroll offset. */
async function paneState() {
  const state = await page.evaluate(`(() => {
    const v=${view};
    const s=v.scrollDOM.getBoundingClientRect();
    const p=document.getElementById('preview-pane').getBoundingClientRect();
    const pane=document.getElementById('preview-pane');
    return { top:Math.max(s.top,p.top), bottom:Math.min(s.bottom,p.bottom), source:v.scrollDOM.scrollTop,
      sourceMax:v.scrollDOM.scrollHeight-v.scrollDOM.clientHeight, previewMax:pane.scrollHeight-pane.clientHeight };
  })()`);
  state.preview = await previewTop();
  if (currentMode === "html")
    state.previewMax = await guest.evaluate(
      "Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - window.innerHeight",
    );
  return state;
}

/**
 * The word's row in the editor. A line outside CodeMirror's rendered range has
 * no coordinates; its block gives an estimate, flagged so a caller can tell a
 * measured row from a guessed one.
 */
async function sourceBox(word) {
  return page.evaluate(`(() => {
    const v=${view};
    const pos=v.state.doc.toString().indexOf(${JSON.stringify(word)});
    if (pos < 0) return null;
    const a=v.coordsAtPos(pos), b=v.coordsAtPos(pos+${word.length},-1);
    if (a) return { top:a.top, bottom:a.bottom, left:a.left, right:b && b.top===a.top ? b.right : a.left+8, exact:true };
    const block=v.lineBlockAt(pos);
    return { top:v.documentTop+block.top, bottom:v.documentTop+block.bottom, left:0, right:0, exact:false };
  })()`);
}

/** The word's row in the preview, in the host's screen pixels. */
async function previewBox(word, mode) {
  const box = await previewClient().evaluate(
    `window.__scrollBox(${JSON.stringify(word)}, ${probeRoot(mode)})`,
  );
  if (!box || mode !== "html") return box;
  const frame = await page.evaluate(`(() => {
    const frame = document.querySelector('.html-preview-frame.active');
    if (!frame) return null;
    const rect = frame.getBoundingClientRect();
    const zoom = parseFloat(getComputedStyle(frame).zoom || '1');
    return { top: rect.top, left: rect.left, scale: Number.isFinite(zoom) && zoom > 0 ? zoom : 1 };
  })()`);
  if (!frame) return null;
  return {
    top: frame.top + box.top * frame.scale,
    bottom: frame.top + box.bottom * frame.scale,
    left: frame.left + box.left * frame.scale,
    right: frame.left + box.right * frame.scale,
    scale: frame.scale,
  };
}

const centre = (box) => (box.top + box.bottom) / 2;

/** Scroll one pane, as a reader would, until the word's row centre is at `y`. */
async function placeWord(direction, word, mode, y) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const box = direction === "source" ? await sourceBox(word) : await previewBox(word, mode);
    if (!box) return false;
    const delta = centre(box) - y;
    if (Math.abs(delta) < 1 && box.exact !== false) return true;
    if (direction === "source")
      await page.evaluate(`(() => {
        const v=${view};
        document.getElementById('editor-pane').dispatchEvent(new WheelEvent('wheel',{bubbles:true}));
        v.scrollDOM.scrollTop += ${delta};
      })()`);
    else if (mode === "html")
      await guest.evaluate(`window.scrollTo(0, window.scrollY + ${delta / (box.scale ?? 1)})`);
    else
      await page.evaluate(`(() => {
        const p=document.getElementById('preview-pane');
        p.dispatchEvent(new WheelEvent('wheel',{clientX:${box.left + 2},clientY:${y},bubbles:true}));
        p.scrollTop += ${delta};
      })()`);
    await sleep(80);
  }
  // A word near either end of the document cannot reach every height; the
  // probe then clicks it wherever the pane stopped.
  return true;
}

/** A trusted click: handlers that read the pointer position need a real one. */
async function clickAt(x, y) {
  const at = { x, y, button: "left", clickCount: 1 };
  await page.send("Input.dispatchMouseEvent", { ...at, type: "mouseMoved", button: "none" });
  await page.send("Input.dispatchMouseEvent", { ...at, type: "mousePressed", buttons: 1 });
  await page.send("Input.dispatchMouseEvent", { ...at, type: "mouseReleased", buttons: 0 });
}

/** Adapters whose gestures level the other pane; the rest are only recorded. */
const LEVEL_MODES = new Set(["markdown", "asciidoc", "document", "pages", "html"]);

async function probeGestures(mode) {
  if (mode === "html") await guest.evaluate(installBoxProbe);
  else await page.evaluate(installBoxProbe);
  const result = { mode, gestures: {} };
  if (mode === "pages") {
    // The PDF's anchors are rebuilt after a re-render; a click before that has
    // nothing to measure. Wait for them, and say how long it took.
    const started = Date.now();
    let state = null;
    while (Date.now() - started < 10_000) {
      state = await page.evaluate(`window.__mdraftDebug?.syncState?.() ?? null`);
      if (state?.rows > 0) break;
      await sleep(250);
    }
    console.log(`  PAGES-ANCHORS after ${Date.now() - started} ms: ${JSON.stringify(state)}`);
  }
  for (const direction of ["source", "preview"]) {
    const samples = [];
    let unplaced = 0;
    for (let i = 0; i < 40; i += 1) {
      const word = `syncprobe${String(8 + i * 2).padStart(3, "0")}`;
      const band = await paneState();
      // Three heights, so the probe is not a measurement of one lucky line.
      const y = band.top + (band.bottom - band.top) * [0.3, 0.55, 0.8][i % 3];
      await sleep(200);
      if (!(await placeWord(direction, word, mode, y))) {
        unplaced += 1;
        continue;
      }
      // Follow-scrolling answers the placement; measure the click on its own.
      await sleep(350);
      const own = direction === "source" ? await sourceBox(word) : await previewBox(word, mode);
      if (
        !own ||
        own.exact === false ||
        centre(own) < band.top + 4 ||
        centre(own) > band.bottom - 4
      ) {
        unplaced += 1;
        continue;
      }
      const before = await paneState();
      await clickAt(Math.min(own.left + 6, (own.left + own.right) / 2), centre(own));
      await sleep(400);
      const after = await paneState();
      const state = onlyModes.length
        ? await page.evaluate(`window.__mdraftDebug?.syncState?.() ?? null`)
        : undefined;
      const a = await sourceBox(word);
      const b = await previewBox(word, mode);
      const other = direction === "source" ? b : a;
      const otherPane = direction === "source" ? "preview" : "source";
      // A second identical click has nothing left to do.
      let repeatMoved = null;
      // One wheel tick in the clicked pane: the other pane may follow by the
      // local slope, and must not jump back to an older alignment.
      let tick = null;
      if (i % 4 === 0) {
        await clickAt(Math.min(own.left + 6, (own.left + own.right) / 2), centre(own));
        await sleep(300);
        const again = await paneState();
        repeatMoved = Math.abs(again[otherPane] - after[otherPane]);
        const wheelX = Math.min(own.left + 6, (own.left + own.right) / 2);
        await page.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: wheelX,
          y: centre(own),
          deltaX: 0,
          deltaY: 60,
        });
        await sleep(450);
        const ticked = await paneState();
        // A second tick is the reference: it shows what one tick does here when
        // nothing is left over from the click.
        await page.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: wheelX,
          y: centre(own),
          deltaX: 0,
          deltaY: 60,
        });
        await sleep(450);
        const twice = await paneState();
        tick = {
          own: ticked[direction] - again[direction],
          other: ticked[otherPane] - again[otherPane],
          nextOwn: twice[direction] - ticked[direction],
          nextOther: twice[otherPane] - ticked[otherPane],
        };
      }
      samples.push({
        state,
        repeatMoved,
        tick,
        word,
        height: Math.round(centre(own) - band.top),
        // Null when the counterpart is not laid out at all (an unpainted page).
        error: a && b ? Math.abs(centre(a) - centre(b)) : null,
        // The other pane is at the start or end of its range: the exact height
        // may be out of reach, and the counterpart only has to be on screen.
        clamped: after[otherPane] <= 1 || after[otherPane] >= after[`${otherPane}Max`] - 1,
        visible: !!other && centre(other) >= after.top && centre(other) <= after.bottom,
        ownMoved: Math.abs(after[direction] - before[direction]),
        otherMoved: Math.abs(after[otherPane] - before[otherPane]),
      });
    }
    const reachable = samples.filter((sample) => !sample.clamped);
    const errors = reachable.map((sample) => sample.error).filter((error) => error !== null);
    const summary = {
      count: samples.length,
      unplaced,
      unmeasured: reachable.length - errors.length,
      clamped: samples.length - reachable.length,
      clampedHidden: samples.filter((sample) => sample.clamped && !sample.visible).length,
      median: percentile(errors, 0.5),
      p95: percentile(errors, 0.95),
      max: errors.length ? Math.max(...errors) : null,
      counterpartVisible: samples.filter((sample) => sample.visible).length,
      ownPaneMoved: samples.filter((sample) => sample.ownMoved > 0.5).length,
      otherPaneMoved: samples.filter((sample) => sample.otherMoved > 0.5).length,
      repeatMoved: samples.filter((sample) => sample.repeatMoved > 0.5).length,
      // The first tick after a click must do what the next tick does: the
      // local slope, which is 3.5 source pixels per preview pixel in the
      // two-column PDF and under 1 in prose. A first tick that does much more,
      // or moves the other pane backwards, is the snap back to an older
      // alignment. The allowance covers the bounded levelling of a clamped click.
      tickJumps: samples.filter(
        (sample) =>
          sample.tick &&
          Math.abs(sample.tick.own) > 1 &&
          (Math.abs(sample.tick.other - sample.tick.nextOther) >
            0.5 * Math.abs(sample.tick.nextOther) + 20 ||
            sample.tick.other * sample.tick.own < -2),
      ).length,
      ticks: samples.filter((sample) => sample.tick && Math.abs(sample.tick.own) > 1).length,
    };
    console.log(`  GESTURE ${mode} ${direction}: ${JSON.stringify(summary)}`);
    if (onlyModes.length)
      console.log(
        `  SYNC-STATE ${mode} ${direction}: ${JSON.stringify(
          await page.evaluate(`window.__mdraftDebug?.syncState?.() ?? null`),
        )}`,
      );
    for (const sample of samples)
      if (onlyModes.length || sample.error === null || sample.error > 1 || sample.repeatMoved > 0.5)
        console.log(`  GESTURE-SAMPLE ${mode} ${direction}: ${JSON.stringify(sample)}`);
    result.gestures[direction] = { ...summary, samples };
    if (baseline || !LEVEL_MODES.has(mode)) continue;
    const label = `${mode}: a click in the ${direction}`;
    check(
      summary.count >= 36 && summary.unmeasured === 0 && errors.length >= 30,
      `${label} is measurable at every probe`,
      JSON.stringify({
        count: summary.count,
        unplaced,
        unmeasured: summary.unmeasured,
        clamped: summary.clamped,
      }),
    );
    check(
      summary.clampedHidden === 0,
      `${label} whose exact height is out of reach still shows its counterpart`,
      JSON.stringify({ clamped: summary.clamped, hidden: summary.clampedHidden }),
    );
    check(
      summary.median !== null && summary.median <= 0.5 && summary.p95 <= 1,
      `${label} puts its counterpart level (median <= 0.5px, p95 <= 1px)`,
      JSON.stringify({ median: summary.median, p95: summary.p95, max: summary.max }),
    );
    check(
      summary.ownPaneMoved === 0,
      `${label} never scrolls that pane`,
      `${summary.ownPaneMoved}`,
    );
    check(
      summary.repeatMoved === 0,
      `${label}, repeated, writes nothing`,
      `${summary.repeatMoved}`,
    );
    // Two columns: a tick that carries the sync line across a column or page
    // boundary moves the other pane by a column, click or no click. One such
    // crossing in ten ticks is the fixture, not a regression.
    check(
      summary.ticks >= 5 && summary.tickJumps <= (mode === "pages" ? 1 : 0),
      `${label} leaves scrolling continuous: the next wheel tick does not jump`,
      JSON.stringify({ ticks: summary.ticks, jumps: summary.tickJumps }),
    );
  }
  return result;
}

async function zoomTo(level) {
  await menu("view.zoomReset");
  if (level > 100) for (let value = 100; value < level; value += 10) await menu("view.zoomIn");
  else for (let value = 100; value > level; value -= 10) await menu("view.zoomOut");
  await sleep(450);
}

async function checkZoom(mode, level) {
  await zoomTo(level);
  // Two source pairs per zoom keep the matrix bounded. Near the document ends
  // CodeMirror's virtualised source can make the probe word unmeasurable at
  // 300%, so the two mid-document words are the stable declared pairs. The 100%
  // matrix exercises both directions; the reverse pair at a zoom is selected
  // inside the guest probe and is not exposed to this Node harness.
  const probes = [
    ["source", "syncprobe060"],
    ["source", "syncprobe080"],
  ];
  const errors = [];
  const detail = [];
  for (const [direction, word] of probes) {
    await sleep(200);
    if (direction === "source") await scrollSourceTo(word);
    else if (!(await scrollPreviewTo(word, mode))) {
      detail.push(`${direction}:${word}:missing-target`);
      continue;
    }
    const measured = await settle(word, mode);
    if (measured) {
      errors.push(measured.error);
      detail.push(`${direction}:${word}:${measured.error.toFixed(2)}`);
    } else detail.push(`${direction}:${word}:missing`);
  }
  console.log(`  ZOOM ${mode} ${level}%: ${detail.join(" ")}`);
  const p95 = percentile(errors, 0.95);
  const max = errors.length ? Math.max(...errors) : null;
  check(
    errors.length === probes.length && p95 !== null && p95 <= 4,
    `${mode} at ${level}%: the settled correspondence stays within 4px`,
    JSON.stringify({ count: `${errors.length}/${probes.length}`, p95, max }),
  );
  await zoomTo(100);
}

async function checkResize(mode) {
  for (const [width, height] of [
    [1000, 800],
    [1600, 1000],
  ]) {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(650);
    const errors = [];
    const detail = [];
    for (const word of ["syncprobe060", "syncprobe080"]) {
      await sleep(200);
      await scrollSourceTo(word);
      const measured = await settle(word, mode);
      if (measured) {
        errors.push(measured.error);
        detail.push(`${word}:${measured.error.toFixed(2)}`);
      } else detail.push(`${word}:missing`);
    }
    console.log(`  RESIZE ${mode} ${width}x${height}: ${detail.join(" ")}`);
    const p95 = percentile(errors, 0.95);
    const max = errors.length ? Math.max(...errors) : null;
    check(
      errors.length === 2 && p95 !== null && p95 <= 4,
      `${mode} at ${width}x${height}: the settled correspondence stays within 4px`,
      JSON.stringify({ count: `${errors.length}/2`, p95, max }),
    );
  }
  await page.send("Emulation.clearDeviceMetricsOverride");
  await sleep(500);
}

const evidence = [];
try {
  page = await Client.connect((await targets()).find((target) => target.type === "page"));
  await wait(`Boolean(document.querySelector('.cm-content')?.cmTile?.root?.view)`);

  const initial = await invoke("get_settings");
  if (!initial.syncScroll) await menu("view.syncScroll");
  await menu("view.split");

  for (const [file, mode] of [
    ["prose.md", "markdown"],
    ["prose.adoc", "asciidoc"],
    ["single-column.typ", "document"],
    ["two-columns.typ", "pages"],
    ["prose.html", "html"],
  ]) {
    if (onlyModes.length && !onlyModes.includes(mode)) continue;
    currentMode = mode;
    await invoke("plugin:event|emit", {
      event: "open-files",
      payload: [path.join(repo, "samples/scroll-sync", file)],
    });
    await wait(`document.title.includes(${JSON.stringify(file)})`);
    if (mode === "document" || mode === "pages")
      await menu(`view.typst${mode === "pages" ? "Pages" : "Document"}`);
    await wait(
      mode === "html"
        ? `Boolean(document.querySelector('.html-preview-frame.active'))`
        : mode === "pages"
          ? `document.querySelectorAll('.typst-page .textLayer').length > 2`
          : `document.getElementById('preview').textContent.includes('syncprobe095')`,
    );
    await sleep(500);
    if (mode === "html") {
      await connectGuest();
      await guest.evaluate(installProbe);
    } else {
      await page.evaluate(installProbe);
    }
    await page.evaluate(`${view}.focus()`);
    await sleep(250);
    const snapshot = await page.evaluate(
      `(() => { const v=${view}; return { source:v.state.doc.toString(), selection:v.state.selection.toJSON(), focus:document.activeElement === v.contentDOM }; })()`,
    );
    const metrics = { mode, samples: [], missing: 0 };
    for (const direction of ["source", "preview"]) {
      for (let i = 0; i < 20; i += 1) {
        const word = `syncprobe${String(8 + i * 4).padStart(3, "0")}`;
        // Let the 150ms programmatic-scroll guard of the previous probe expire.
        await sleep(200);
        if (direction === "source") await scrollSourceTo(word);
        else if (!(await scrollPreviewTo(word, mode))) {
          metrics.missing += 1;
          continue;
        }
        const measured = await settle(word, mode);
        if (!measured) {
          metrics.missing += 1;
          continue;
        }
        metrics.samples.push({
          direction,
          word,
          error: measured.error,
          height: measured.height,
        });
        if (onlyModes.length)
          console.log(`  SAMPLE ${mode} ${direction} ${word}: ${JSON.stringify(measured)}`);
      }
    }
    const after = await page.evaluate(
      `(() => { const v=${view}; return { source:v.state.doc.toString(), selection:v.state.selection.toJSON(), focus:document.activeElement === v.contentDOM }; })()`,
    );
    check(
      JSON.stringify(snapshot) === JSON.stringify(after),
      `${mode}: scrolling preserves source, caret, selection and focus`,
      JSON.stringify({
        sameText: snapshot.source === after.source,
        before: snapshot.selection,
        after: after.selection,
        focus: [snapshot.focus, after.focus],
      }),
    );
    const errors = metrics.samples.map((sample) => sample.error);
    const ratios = metrics.samples.map((sample) => sample.error / sample.height);
    metrics.median = percentile(errors, 0.5);
    metrics.p95 = percentile(errors, 0.95);
    metrics.max = errors.length ? Math.max(...errors) : null;
    metrics.p95Lines = percentile(ratios, 0.95);
    metrics.maxLines = ratios.length ? Math.max(...ratios) : null;
    console.log(
      `  METRIC ${mode}: ${JSON.stringify({ median: metrics.median, p95: metrics.p95, max: metrics.max, p95Lines: metrics.p95Lines, maxLines: metrics.maxLines, missing: metrics.missing })}`,
    );
    if (!baseline) {
      check(
        metrics.missing === 0,
        `${mode}: all declared content pairs are measurable`,
        `${metrics.samples.length}/40`,
      );
      check(
        metrics.p95Lines !== null && metrics.p95Lines <= 1,
        `${mode}: p95 correspondence error is within one visual line`,
        String(metrics.p95Lines),
      );
      check(
        metrics.maxLines !== null && metrics.maxLines <= 1,
        `${mode}: no settled probe exceeds one visual line`,
        String(metrics.maxLines),
      );
      check(
        metrics.p95 !== null && metrics.p95 <= 4,
        `${mode}: settled p95 correspondence error is within 4px`,
        String(metrics.p95),
      );
    }
    evidence.push(metrics);

    // The gesture probe runs on the preview the precision loop just measured,
    // before the lifecycle checks below re-render it. The baseline records what
    // a click did before gesture alignment; otherwise the result is asserted.
    // A click leaves the sync line at the clicked height, and the checks that
    // follow measure at the default line: a resize is one of its reset points.
    metrics.gestures = (await probeGestures(mode)).gestures;
    await page.evaluate(`window.dispatchEvent(new Event('resize'))`);
    await sleep(200);

    if (!baseline && (mode === "markdown" || mode === "html")) {
      for (const level of [50, 150, 300]) await checkZoom(mode, level);
    }
    if (!baseline) await checkResize(mode);

    if (!baseline) {
      await sleep(350);
      const quiet = [await page.evaluate(`${view}.scrollDOM.scrollTop`), await previewTop()];
      await sleep(250);
      check(
        Math.abs(quiet[0] - (await page.evaluate(`${view}.scrollDOM.scrollTop`))) < 1 &&
          Math.abs(quiet[1] - (await previewTop())) < 1,
        `${mode}: idle panes do not oscillate`,
      );
      await menu("view.syncScroll");
      const disabled = await previewTop();
      await page.evaluate(`${view}.scrollDOM.scrollTop += 80`);
      await sleep(220);
      check(
        Math.abs((await previewTop()) - disabled) < 1,
        `${mode}: disabled sync does not move the preview`,
      );
      // The Sync toggle is the off switch for gesture alignment too.
      const offBefore = await paneState();
      const editorBox = await page.evaluate(
        `(() => { const r=${view}.contentDOM.getBoundingClientRect(); return { x:r.left+60, y:(Math.max(r.top,${offBefore.top})+${offBefore.bottom})/2 }; })()`,
      );
      await clickAt(editorBox.x, editorBox.y);
      await sleep(350);
      const offAfter = await paneState();
      check(
        Math.abs(offAfter.preview - offBefore.preview) < 1 &&
          Math.abs(offAfter.source - offBefore.source) < 1,
        `${mode}: with sync off a source click moves neither pane`,
        JSON.stringify({ preview: offAfter.preview - offBefore.preview }),
      );
      await menu("view.syncScroll");
      await menu("view.source");
      await sleep(250);
      const hidden = await previewTop();
      await page.evaluate(`${view}.scrollDOM.scrollTop += 40`);
      await sleep(220);
      check(
        Math.abs((await previewTop()) - hidden) < 1,
        `${mode}: source-only view does not follow scrolling`,
      );
      const previousSrc =
        mode === "html"
          ? await page.evaluate(`document.querySelector('.html-preview-frame.active')?.src ?? null`)
          : null;
      await menu("view.split");
      await sleep(350);
      if (mode === "html") {
        // Returning to Split keeps an unchanged guest (its freshness key
        // matches) and replaces a changed one; follow whichever is active.
        guest = await connectGuest(previousSrc, 1500);
        await sleep(400);
      }
      const oldTop = await previewTop();
      await page.evaluate(
        `(() => {document.getElementById('editor-pane').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));const v=${view};v.dispatch({changes:{from:0,insert:'\\n'}});v.scrollDOM.scrollTop+=20;})()`,
      );
      await sleep(30);
      check(
        Math.abs((await previewTop()) - oldTop) < 1,
        `${mode}: editing invalidates correspondence before the render debounce`,
      );
      await page.evaluate(`${view}.dispatch({changes:{from:0,to:1,insert:''}})`);
      await sleep(400);
    }

    if (!baseline && mode === "pages") {
      const before = await previewTop();
      await invoke("plugin:event|emit", {
        event: "open-files",
        payload: [path.join(repo, "samples/word-sync.md")],
      });
      await wait(`document.title.includes('word-sync.md')`);
      await sleep(400);
      await page.evaluate(
        `[...document.querySelectorAll('.doc-tab')].find((tab) => tab.textContent.includes('two-columns.typ'))?.click()`,
      );
      await wait(`document.title.includes('two-columns.typ')`);
      await wait(`document.querySelectorAll('.typst-page .textLayer').length > 2`);
      // Text layers appear before the entire PDF map and scroll restoration
      // finish. Wait for the observable result instead of a fixed 800 ms.
      const restoreDeadline = Date.now() + 8000;
      while (Date.now() < restoreDeadline && Math.abs((await previewTop()) - before) >= 40) {
        await sleep(100);
      }
      const after = await previewTop();
      check(
        Math.abs(after - before) < 40,
        "pages: a tab switch restores the preview place",
        JSON.stringify({ before, after }),
      );
    }

    guest?.ws.close();
    guest = null;
  }

  const out = path.join(repo, "node_modules/.cache/mdraft-scroll");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(
    path.join(out, baseline ? "baseline.json" : "after.json"),
    JSON.stringify(evidence, null, 2),
  );
} catch (error) {
  console.error(error.stack ?? error);
  check(false, "the scroll sync suite completed", String(error));
} finally {
  try {
    guest?.ws.close();
  } catch {
    /* already gone */
  }
  try {
    page?.ws.close();
  } catch {
    /* already gone */
  }
}
const failed = checks.filter((ok) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
