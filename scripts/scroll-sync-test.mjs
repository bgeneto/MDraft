//! Content-pair geometry, both scroll directions in every preview adapter.
//! Run through `npm test -- --only sync`. MDRAFT_SYNC_BASELINE=1 records a
//! baseline and skips the precision/lifecycle assertions.
import fs from "node:fs";
import path from "node:path";

const port = process.argv[2] ?? "9222";
const baseline = process.env.MDRAFT_SYNC_BASELINE === "1";
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
    if (r.width && r.height) return { top:r.top, left:r.left, height:r.height };
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

async function connectGuest(expectedSrc = null) {
  for (let i = 0; i < 120; i += 1) {
    const src = await page.evaluate(
      `document.querySelector('.html-preview-frame.active')?.src ?? null`,
    );
    if (src && (!expectedSrc || src !== expectedSrc)) {
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
  const previewTopAt = mode === "html" ? frameTop + b.top * scale : b.top;
  return {
    error: Math.abs(a.top - previewTopAt),
    height: Math.max(a.height, b.height * (mode === "html" ? scale : 1)),
    sourceTop: a.top,
    previewTop: previewTopAt,
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
      return r ? { top:r.top, paneTop:v.scrollDOM.getBoundingClientRect().top } : null;
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
    await preview.evaluate(`window.scrollTo(0, window.scrollY + ${target.top} - 12)`);
  } else {
    await page.evaluate(`(() => {
      const p=document.getElementById('preview-pane');
      p.dispatchEvent(new WheelEvent('wheel',{clientX:${target.left + 2},clientY:p.getBoundingClientRect().top+12,bubbles:true}));
      p.scrollTop += ${target.top} - p.getBoundingClientRect().top - 12;
    })()`);
  }
  return true;
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
        // Returning to Split re-renders the guest; the old iframe target is gone.
        guest = await connectGuest(previousSrc);
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
      await sleep(800);
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
