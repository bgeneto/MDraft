// The preview pane belongs to the active document.
//
//   node scripts/preview-ownership-test.mjs [port]
//
// Why this suite exists: every renderer builds off-screen and swaps on success,
// which is right while one document is being rebuilt and wrong across a tab
// switch. The Markdown preview of the tab just left stayed on screen for the
// whole LaTeX build of the tab just entered. This suite holds the render at a
// command the frontend awaits, so the switch can be sampled in the real window:
//
//   1. Markdown -> LaTeX: the previous marker is gone synchronously after the
//      click and in every sample; a spinner names the new file and its phase;
//      the status strip does not move; Cancel leaves an idle surface;
//   2. the same under prefers-reduced-motion: no animation, counter from 1 s;
//   3. Markdown -> Typst (Document and Pages) and -> AsciiDoc;
//   4. LaTeX -> Markdown leaves no PDF view or Typst controls behind;
//   5. Markdown -> Markdown never shows the waiting surface;
//   6. a switch made in Source mode, then Source -> Split, never shows the
//      previous document;
//   7. five rapid switches among four languages never name the wrong document;
//   8. a manual-compile .tex tab shows an idle surface, not a spinner;
//   9. HTML keeps its own guest and never gets the waiting surface.
//
// The LaTeX and Typst waits are held at `latex_engine_status` and
// `render_typst`, which the render awaits before it can commit, so the
// ownership cases run on a host with no engine installed. Checks that need a
// real PDF are skipped cleanly when none is available.
//
// Fixtures are written to the harness's temporary directory, never the repo.

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { emitMenu, openPage, sleep } from "./cdp-page.mjs";

const port = process.argv[2] ?? "9222";
const page = await openPage(port);

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
function skip(label, detail = "") {
  console.log(`  SKIP  ${label}${detail ? ` — ${detail}` : ""}`);
}

const errors = [];
page.onException((text) => errors.push(text.split("\n")[0]));

// The Math.ceil boundary keeps a slow first paint from becoming a failure.
for (let attempt = 0; attempt < 240; attempt += 1) {
  if (await page.evaluate(`Boolean(document.querySelector(".cm-content"))`)) break;
  await sleep(250);
}

const json = async (expression) => JSON.parse(await page.evaluate(`JSON.stringify(${expression})`));

const activeTab = () =>
  page.evaluate(
    `document.querySelector('.doc-tab[aria-selected="true"] .doc-tab-name')?.textContent ?? ""`,
  );

const paneText = () => page.evaluate(`document.getElementById("preview-pane")?.textContent ?? ""`);

const hasPending = () =>
  page.evaluate(`Boolean(document.querySelector("#preview-pane > .preview-pending"))`);

async function waitFor(expression, timeoutMs = 10000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(expression)) return true;
    await sleep(stepMs);
  }
  return false;
}

/** Click a tab and report whether a marker survived synchronously. */
async function clickTab(name, markers = {}) {
  return json(`(() => {
    const name = ${JSON.stringify(name)};
    const tab = [...document.querySelectorAll(".doc-tab")]
      .find((entry) => entry.querySelector(".doc-tab-name")?.textContent === name);
    if (!tab) return { clicked: false, staleAfter: false, active: "" };
    const pane = document.getElementById("preview-pane");
    const before = pane?.textContent ?? "";
    window.__expectedActive = name;
    tab.click();
    const after = pane?.textContent ?? "";
    return {
      clicked: true,
      at: performance.now(),
      staleBefore: Object.keys(${JSON.stringify(markers)}).some((marker) => before.includes(marker)),
      staleAfter: Object.entries(${JSON.stringify(markers)}).some(([marker, owner]) => owner !== name && after.includes(marker)),
      targetAfter: Object.entries(${JSON.stringify(markers)}).some(([marker, owner]) => owner === name && after.includes(marker)),
      active: document.querySelector('.doc-tab[aria-selected="true"] .doc-tab-name')?.textContent ?? "",
    };
  })()`);
}

async function emitOpenFiles(paths) {
  await page.evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "open-files", payload: ${JSON.stringify(paths)} })`,
  );
}

const autoCompile = () =>
  page.evaluate(
    `window.__TAURI_INTERNALS__.invoke("get_settings").then((s) => s.latexAutoCompile !== false)`,
  );

/** Set the one shell setting this suite needs, and wait until the shell agrees. */
async function setAutoCompile(on) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if ((await autoCompile()) === on) return;
    await emitMenu(page, "view.latexAutoCompile");
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if ((await autoCompile()) === on) return;
      await sleep(100);
    }
  }
  throw new Error(`could not set latexAutoCompile=${on}`);
}

// ---------------------------------------------------------------------------
// Instrumentation: command holds at the IPC boundary and a sampler that
// survives a hidden window.
//
// The page cannot wrap `invoke`: `__TAURI_INTERNALS__` is non-writable and
// non-configurable, so an assignment silently does nothing. Every command is an
// HTTP request to `http://ipc.localhost/<command>` instead, and CDP can pause
// those; a held request keeps the render awaiting it, which is what a slow build
// does. requestAnimationFrame may not fire while the harness keeps the window
// hidden, so the sampler uses an interval and a MutationObserver.
// ---------------------------------------------------------------------------
const heldCommands = new Set();
const pausedRequests = [];
page.onEvent((method, params) => {
  if (method !== "Fetch.requestPaused") return;
  const command = decodeURIComponent(new URL(params.request.url).pathname.replace(/^\//, ""));
  if (heldCommands.has(command)) {
    pausedRequests.push({ command, requestId: params.requestId });
    return;
  }
  void page
    .send("Fetch.continueRequest", { requestId: params.requestId })
    .catch((error) => console.error(`[ownership] could not release ${command}: ${error}`));
});
await page.send("Fetch.enable", {
  patterns: [
    { urlPattern: "http://ipc.localhost/latex_engine_status", requestStage: "Request" },
    { urlPattern: "http://ipc.localhost/render_typst", requestStage: "Request" },
    { urlPattern: "http://ipc.localhost/render_typst_binary", requestStage: "Request" },
  ],
});

function hold(command) {
  heldCommands.add(command);
}

async function release(command) {
  heldCommands.delete(command);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const index = pausedRequests.findIndex((entry) => entry.command === command);
    if (index < 0) break;
    const [entry] = pausedRequests.splice(index, 1);
    await page.send("Fetch.continueRequest", { requestId: entry.requestId });
  }
}

async function releaseAll() {
  for (const command of [...heldCommands]) await release(command);
}

await page.evaluate(`(() => {
  window.__ownerSamples = {
    timer: 0,
    observer: null,
    markers: {},
    target: "",
    records: 0,
    hits: 0,
    violations: 0,
    pending: 0,
    firstPendingAt: null,
    firstEmptyAt: null,
    targetAt: null,
    lastPendingAt: null,
  };
  const holder = window.__ownerSamples;
  const take = () => {
    const now = performance.now();
    const pane = document.getElementById("preview-pane");
    const preview = document.getElementById("preview");
    if (!pane) return;
    const text = pane.textContent ?? "";
    const active =
      window.__expectedActive ||
      document.querySelector('.doc-tab[aria-selected="true"] .doc-tab-name')?.textContent ||
      "";
    const found = [];
    for (const [marker, name] of Object.entries(holder.markers)) {
      if (text.includes(marker)) found.push(name);
    }
    holder.records += 1;
    holder.hits += found.length;
    holder.violations += found.filter((name) => name !== active).length;
    if (pane.querySelector(":scope > .preview-pending")) {
      holder.pending += 1;
      holder.lastPendingAt = now;
      if (holder.firstPendingAt === null) holder.firstPendingAt = now;
    }
    if (holder.target && text.includes(holder.target) && holder.targetAt === null) {
      holder.targetAt = now;
    }
    if (holder.firstEmptyAt === null && (preview?.childElementCount ?? 0) === 0) {
      holder.firstEmptyAt = now;
    }
  };
  window.__ownerSampleStart = (markers, target = "") => {
    window.__ownerSampleStop();
    holder.markers = markers;
    holder.target = target;
    holder.records = 0;
    holder.hits = 0;
    holder.violations = 0;
    holder.pending = 0;
    holder.firstPendingAt = null;
    holder.firstEmptyAt = null;
    holder.targetAt = null;
    holder.lastPendingAt = null;
    take();
    holder.timer = window.setInterval(take, 10);
    holder.observer = new MutationObserver(take);
    holder.observer.observe(document.getElementById("preview-pane"), {
      childList: true,
      subtree: true,
      characterData: true,
    });
  };
  window.__ownerSampleStop = () => {
    if (holder.timer) window.clearInterval(holder.timer);
    holder.timer = 0;
    holder.observer?.disconnect();
    holder.observer = null;
    return {
      records: holder.records,
      hits: holder.hits,
      violations: holder.violations,
      pending: holder.pending,
      firstPendingAt: holder.firstPendingAt,
      targetSeen: holder.targetAt !== null,
      emptyWindowMs:
        holder.firstEmptyAt !== null && holder.targetAt !== null
          ? holder.targetAt - holder.firstEmptyAt
          : null,
    };
  };
  return "installed";
})()`);

async function sampleStart(markers, target = "") {
  await page.evaluate(
    `window.__ownerSampleStart(${JSON.stringify(markers)}, ${JSON.stringify(target)})`,
  );
}
const sampleStop = () => json(`window.__ownerSampleStop()`);

const pendingInfo = () =>
  json(`(() => {
    const node = document.querySelector("#preview-pane > .preview-pending");
    if (!node) return null;
    const paneRect = document.getElementById("preview-pane").getBoundingClientRect();
    const spinner = node.querySelector(".preview-pending-spinner");
    const spinRect = spinner?.getBoundingClientRect() ?? null;
    const strip = document.querySelector("#compiled-controls");
    const stripRect = strip?.getBoundingClientRect() ?? null;
    return {
      state: node.dataset.state ?? "",
      title: node.querySelector(".preview-pending-title")?.textContent ?? "",
      phase: node.querySelector(".preview-pending-phase")?.textContent ?? "",
      elapsed: node.querySelector(".preview-pending-elapsed")?.textContent ?? "",
      animation: spinner ? getComputedStyle(spinner).animationName : "",
      spinnerDisplay: spinner ? getComputedStyle(spinner).display : "",
      spinnerCenterX: spinRect ? spinRect.left + spinRect.width / 2 : null,
      paneCenterX: paneRect.left + paneRect.width / 2,
      spinnerInside:
        spinRect !== null &&
        spinRect.left >= paneRect.left - 1 &&
        spinRect.right <= paneRect.right + 1 &&
        spinRect.top >= paneRect.top - 1 &&
        spinRect.bottom <= paneRect.bottom + 1,
      strip: stripRect ? { left: stripRect.left, width: stripRect.width } : null,
    };
  })()`);

async function waitForPending(timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await pendingInfo();
    if (info) return info;
    await sleep(20);
  }
  return null;
}

async function waitForCommit(timeoutMs = 30000) {
  return waitFor(
    `!document.querySelector("#preview-pane > .preview-pending") && (document.getElementById("preview")?.childElementCount ?? 0) > 0`,
    timeoutMs,
    120,
  );
}

// Strip geometry before the surface can appear. It is read in the first 150 ms
// after the switch, while the LaTeX status strip exists but the pane is empty.
async function earlyStrip() {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const info = await pendingInfo();
    const strip = await json(
      `(() => { const s = document.querySelector("#compiled-controls"); if (!s) return null; const r = s.getBoundingClientRect(); return { left: r.left, width: r.width }; })()`,
    );
    if (strip) return { strip, pending: Boolean(info) };
    await sleep(5);
  }
  return { strip: null, pending: false };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const workDir = mkdtempSync(join(tmpdir(), "mdraft-preview-owner-"));
const fixture = (name, text) => {
  const path = join(workDir, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
};

const markdownA = fixture(
  "a.md",
  "# OWNER-MARKER-MD-A\n\nA paragraph that belongs to the first Markdown document.\n",
);
const markdownB = fixture(
  "b.md",
  "# OWNER-MARKER-MD-B\n\nA paragraph that belongs to the second Markdown document.\n",
);
const latexDoc = fixture(
  "doc.tex",
  "\\documentclass{article}\n\\begin{document}\nOWNER-MARKER-TEX\n\\end{document}\n",
);
const typstDoc = fixture("a.typ", "= OWNER-MARKER-TYPST\n\nA Typst paragraph.\n");
const asciidocDoc = fixture("a.adoc", "= OWNER-MARKER-ADOC\n\nAn AsciiDoc paragraph.\n");
const htmlDoc = fixture(
  "a.html",
  "<!doctype html><html><body><p>OWNER-MARKER-HTML</p></body></html>\n",
);
const manualDoc = fixture(
  "manual.tex",
  "\\documentclass{article}\n\\begin{document}\nOWNER-MARKER-MANUAL\n\\end{document}\n",
);
const packageDoc = fixture(
  "example.sty",
  "\\ProvidesPackage{example}\n% source comment\n\\newcommand{\\foo@bar}{x}\n",
);
const classDoc = fixture(
  "example.CLS",
  "\\ProvidesClass{example}\n% source comment\n\\LoadClass{article}\n",
);
const projectDir = join(workDir, "latex-project");
cpSync(resolve("samples", "latex-project"), projectDir, { recursive: true });
const projectMain = join(projectDir, "main.tex");
const projectChapter = join(projectDir, "chapters", "intro.tex");

const MARKERS = {
  "OWNER-MARKER-MD-B": "b.md",
  "OWNER-MARKER-MD-A": "a.md",
  "OWNER-MARKER-TEX": "doc.tex",
  "OWNER-MARKER-TYPST": "a.typ",
  "OWNER-MARKER-ADOC": "a.adoc",
  "OWNER-MARKER-MANUAL": "manual.tex",
};
const MD = { "OWNER-MARKER-MD-A": "a.md" };
const MD_B = { "OWNER-MARKER-MD-B": "b.md" };
const TEX = { "OWNER-MARKER-TEX": "doc.tex" };
const TYPST = { "OWNER-MARKER-TYPST": "a.typ" };
const ADOC = { "OWNER-MARKER-ADOC": "a.adoc" };

try {
  // -------------------------------------------------------------------------
  // Boot and fixtures
  // -------------------------------------------------------------------------
  console.log("\n=== the tab set is ready ===");
  const booted = await waitFor(
    `document.title.endsWith(" — MDraft") && Boolean(document.querySelector(".cm-content"))`,
    60000,
  );
  check(booted, "the window finished booting");
  await emitOpenFiles([markdownA, markdownB, latexDoc, typstDoc, asciidocDoc, htmlDoc]);
  const opened = await waitFor(
    `${JSON.stringify(
      ["a.md", "b.md", "doc.tex", "a.typ", "a.adoc", "a.html"].map(
        (name) =>
          `[...document.querySelectorAll(".doc-tab-name")].some((node) => node.textContent === ${JSON.stringify(name)})`,
      ),
    )}.every(Boolean)`,
    30000,
    150,
  );
  check(opened, "the six fixture tabs are open");

  await clickTab("a.md", MARKERS);
  await waitFor(
    `(document.getElementById("preview")?.textContent ?? "").includes("OWNER-MARKER-MD-A")`,
    10000,
  );

  const engine = await page.evaluate(
    `window.__TAURI_INTERNALS__.invoke("latex_status").then(String).catch(() => "error")`,
  );
  const hasEngine = engine === "true";
  const typstViewBefore = await page.evaluate(
    `window.__TAURI_INTERNALS__.invoke("get_settings").then((s) => s.typstView ?? "document")`,
  );
  const viewModeBefore = await page.evaluate(
    `window.__TAURI_INTERNALS__.invoke("get_settings").then((s) => s.viewMode ?? "split")`,
  );
  const autoBefore = await autoCompile();
  if (viewModeBefore !== "split") await emitMenu(page, "view.split");
  // The ownership cases below measure an automatic LaTeX build. A profile left
  // in manual mode would show the idle surface instead.
  await setAutoCompile(true);

  // -------------------------------------------------------------------------
  // 1. Markdown -> LaTeX, held at latex_engine_status for five seconds
  // -------------------------------------------------------------------------
  console.log("\n=== Markdown -> LaTeX, the build held ===");
  hold("latex_engine_status");
  const switchedAt = Date.now();
  const switched = await clickTab("doc.tex", MARKERS);
  check(switched.clicked, "the LaTeX tab is clickable");
  check(
    await waitFor(
      `document.querySelector('.doc-tab[aria-selected="true"] .doc-tab-name')?.textContent === "doc.tex"`,
      2000,
      20,
    ),
    "the LaTeX tab becomes active",
  );
  check(
    !switched.staleAfter,
    "the Markdown preview is gone synchronously after the click",
    switched.staleAfter
      ? "OWNER-MARKER-MD-A survived the click"
      : "retired before the click returned",
  );

  await sampleStart(MARKERS, "OWNER-MARKER-TEX");

  const early = await earlyStrip();
  check(Boolean(early.strip), "the LaTeX status strip is present", JSON.stringify(early.strip));

  const pending = await waitForPending(2500);
  check(Boolean(pending), "a waiting surface appears within 250 ms of the switch");
  if (pending) {
    check(pending.state === "pending", "the surface is in its pending state", pending.state);
    check(pending.title === "doc.tex", "the surface names the new document", pending.title);
    check(pending.phase.length > 0, "the surface names a phase", pending.phase);
    check(
      pending.animation !== "none",
      "the spinner is animating",
      pending.animation || "no computed animation",
    );
    check(
      pending.spinnerCenterX !== null &&
        Math.abs(pending.spinnerCenterX - pending.paneCenterX) <= 2,
      "the spinner is centred horizontally in the pane",
      `spinner ${pending.spinnerCenterX}, pane ${pending.paneCenterX}`,
    );
    check(pending.spinnerInside, "the spinner sits inside the pane");
    if (early.strip && pending.strip) {
      check(
        Math.abs(early.strip.left - pending.strip.left) < 1 &&
          Math.abs(early.strip.width - pending.strip.width) < 1,
        "the surface does not shift the status strip",
        `before ${JSON.stringify(early.strip)} after ${JSON.stringify(pending.strip)}`,
      );
    }
  }

  // The elapsed counter appears only after the threshold, so read it twice.
  await sleep(Math.max(0, 5600 - (Date.now() - switchedAt)));
  const late = await pendingInfo();
  check(
    Boolean(late && late.elapsed.length > 0),
    "the elapsed counter appears after five seconds",
    late?.elapsed ?? "no surface",
  );

  await release("latex_engine_status");
  const committed = await waitForCommit(40000);
  check(committed, "the surface clears when the build commits");
  const afterCommit = await paneText();
  check(
    !afterCommit.includes("OWNER-MARKER-MD-A"),
    "the committed pane still does not show the Markdown document",
  );

  const sampled = await sampleStop();
  check(sampled.records > 0, "the sampler observed the wait", `${sampled.records} records`);
  check(
    sampled.violations === 0,
    "no sample showed the previous document",
    `${sampled.violations} violations in ${sampled.records} samples`,
  );
  check(sampled.pending > 0, "the sampler saw the waiting surface", `${sampled.pending} samples`);
  const appearedMs = sampled.firstPendingAt === null ? null : sampled.firstPendingAt - switched.at;
  check(
    appearedMs !== null && appearedMs <= 250,
    "the surface appears within 250 ms of the switch",
    appearedMs === null ? "never sampled" : `${Math.round(appearedMs)} ms`,
  );

  const pdfSeen = await page.evaluate(`Boolean(document.querySelector("#preview .typst-preview"))`);
  if (!hasEngine) {
    skip("a real PDF replaces the surface", "no LaTeX engine on this host");
  } else {
    check(pdfSeen, "a real PDF replaces the surface");
  }

  // -------------------------------------------------------------------------
  // 2. The same under reduced motion
  // -------------------------------------------------------------------------
  console.log("\n=== reduced motion ===");
  await page.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await clickTab("a.md", MARKERS);
  await waitFor(
    `(document.getElementById("preview")?.textContent ?? "").includes("OWNER-MARKER-MD-A")`,
    10000,
  );
  hold("latex_engine_status");
  const reducedSwitch = await clickTab("doc.tex", MARKERS);
  check(!reducedSwitch.staleAfter, "the switch retires the Markdown preview under reduced motion");
  const reducedPending = await waitForPending(2500);
  check(Boolean(reducedPending), "the surface still appears under reduced motion");
  if (reducedPending) {
    check(
      reducedPending.animation === "none",
      "the spinner does not animate under reduced motion",
      reducedPending.animation,
    );
  }
  await sleep(1250);
  const reducedLate = await pendingInfo();
  check(
    Boolean(reducedLate && reducedLate.elapsed.length > 0),
    "the elapsed counter appears from about one second under reduced motion",
    reducedLate?.elapsed ?? "no surface",
  );
  await page.send("Emulation.setEmulatedMedia", { features: [] });
  await release("latex_engine_status");
  await waitForCommit(40000);

  // -------------------------------------------------------------------------
  // 3. Cancel during the hold
  // -------------------------------------------------------------------------
  console.log("\n=== Cancel leaves an idle surface ===");
  await clickTab("a.md", MARKERS);
  await waitFor(
    `(document.getElementById("preview")?.textContent ?? "").includes("OWNER-MARKER-MD-A")`,
    10000,
  );
  hold("latex_engine_status");
  const cancelSwitch = await clickTab("doc.tex", MARKERS);
  check(!cancelSwitch.staleAfter, "the switch retires the Markdown preview before Cancel");
  check(Boolean(await waitForPending(2500)), "the surface appears before Cancel");
  const cancelClicked = await page.evaluate(`(() => {
    const button = document.querySelector("#compiled-controls .latex-cancel");
    if (!button || button.hidden) return "missing";
    button.click();
    return "clicked";
  })()`);
  check(cancelClicked === "clicked", "the status strip offers Cancel during the build");
  const cancelled = await pendingInfo();
  check(cancelled?.state === "idle", "Cancel turns the surface idle", cancelled?.state ?? "none");
  check(
    Boolean(cancelled && cancelled.phase.includes("Compilation cancelled")),
    "Cancel says the compilation was cancelled",
    cancelled?.phase ?? "no phase",
  );
  check(
    cancelled?.spinnerDisplay === "none",
    "the idle surface has no spinner",
    cancelled?.spinnerDisplay,
  );
  await release("latex_engine_status");
  await sleep(500);

  // -------------------------------------------------------------------------
  // 4. Typst, both views, and AsciiDoc
  // -------------------------------------------------------------------------
  console.log("\n=== Markdown -> Typst and AsciiDoc ===");
  await clickTab("a.md", MARKERS);
  await waitFor(
    `(document.getElementById("preview")?.textContent ?? "").includes("OWNER-MARKER-MD-A")`,
    10000,
  );
  hold("render_typst");
  hold("render_typst_binary");
  const typstSwitch = await clickTab("a.typ", MARKERS);
  check(!typstSwitch.staleAfter, "the Markdown preview is retired before the Typst document");
  await sampleStart(MARKERS, "OWNER-MARKER-TYPST");
  check(Boolean(await waitForPending(2500)), "the Typst wait shows the surface");
  await release("render_typst");
  await release("render_typst_binary");
  check(await waitForCommit(30000), "the Typst document commits and the surface clears");
  const typstSample = await sampleStop();
  check(
    typstSample.violations === 0,
    "no Typst sample showed the Markdown document",
    `${typstSample.hits} hits`,
  );

  await emitMenu(page, "view.typstPages");
  await waitFor(`!document.querySelector("#preview-pane > .preview-pending")`, 30000, 150);
  await clickTab("a.md", MARKERS);
  await waitFor(
    `(document.getElementById("preview")?.textContent ?? "").includes("OWNER-MARKER-MD-A")`,
    10000,
  );
  hold("render_typst");
  hold("render_typst_binary");
  const pagesSwitch = await clickTab("a.typ", MARKERS);
  check(!pagesSwitch.staleAfter, "the Markdown preview is retired before Typst Pages");
  await sampleStart(MARKERS, "OWNER-MARKER-TYPST");
  check(Boolean(await waitForPending(2500)), "the Typst Pages wait shows the surface");
  await release("render_typst");
  await release("render_typst_binary");
  check(await waitForCommit(30000), "Typst Pages commits and the surface clears");
  const pagesSample = await sampleStop();
  check(
    pagesSample.violations === 0,
    "no Typst Pages sample showed the Markdown document",
    `${pagesSample.hits} hits`,
  );

  await clickTab("a.md", MARKERS);
  await waitFor(
    `(document.getElementById("preview")?.textContent ?? "").includes("OWNER-MARKER-MD-A")`,
    10000,
  );
  const adocSwitch = await clickTab("a.adoc", MARKERS);
  check(!adocSwitch.staleAfter, "the Markdown preview is retired before AsciiDoc");
  await sampleStart(MARKERS, "OWNER-MARKER-ADOC");
  check(
    await waitFor(
      `(document.getElementById("preview")?.textContent ?? "").includes("OWNER-MARKER-ADOC")`,
      15000,
    ),
    "the AsciiDoc preview commits",
  );
  const adocSample = await sampleStop();
  check(
    adocSample.violations === 0,
    "no AsciiDoc sample showed the Markdown document",
    `${adocSample.violations} violations`,
  );

  // -------------------------------------------------------------------------
  // 5. LaTeX -> Markdown leaves no PDF view or Typst controls
  // -------------------------------------------------------------------------
  console.log("\n=== LaTeX -> Markdown disposes the PDF view ===");
  await clickTab("doc.tex", MARKERS);
  await waitForCommit(40000);
  const hadPdf = await page.evaluate(`Boolean(document.querySelector("#preview .typst-preview"))`);
  await clickTab("a.md", MARKERS);
  await waitFor(
    `(document.getElementById("preview")?.textContent ?? "").includes("OWNER-MARKER-MD-A")`,
    10000,
  );
  const leftovers = await json(`(() => ({
    view: document.querySelectorAll(".typst-preview").length,
    canvases: document.querySelectorAll("#preview canvas").length,
    bar: document.querySelectorAll("#compiled-controls:not([hidden])").length,
    pending: document.querySelectorAll("#preview-pane > .preview-pending").length,
  }))()`);
  check(leftovers.view === 0, "no PDF view element remains", String(leftovers.view));
  check(leftovers.canvases === 0, "no PDF canvas remains", String(leftovers.canvases));
  check(leftovers.bar === 0, "no Typst view bar remains", String(leftovers.bar));
  check(leftovers.pending === 0, "the outgoing surface is gone once Markdown commits");
  if (!hadPdf)
    skip(
      "a PDF was on screen before the switch",
      hasEngine ? "the build did not produce one" : "no LaTeX engine",
    );

  // -------------------------------------------------------------------------
  // 6. Markdown -> Markdown never shows the surface
  // -------------------------------------------------------------------------
  console.log("\n=== Markdown -> Markdown ===");
  await clickTab("a.md", MD);
  await waitFor(
    `(document.getElementById("preview")?.textContent ?? "").includes("OWNER-MARKER-MD-A")`,
    10000,
  );
  await sampleStart(MARKERS, "OWNER-MARKER-MD-B");
  const mdSwitch = await clickTab("b.md", MARKERS);
  check(!mdSwitch.staleAfter, "the previous Markdown preview is retired at the click");
  await waitFor(
    `(document.getElementById("preview")?.textContent ?? "").includes("OWNER-MARKER-MD-B")`,
    10000,
  );
  const mdSample = await sampleStop();
  check(mdSample.pending === 0, "no waiting surface appears between two Markdown tabs");
  check(
    mdSample.violations === 0,
    "no sample showed the other Markdown document",
    `${mdSample.violations} violations`,
  );
  check(
    (mdSample.emptyWindowMs !== null && mdSample.emptyWindowMs < 150) ||
      (mdSample.emptyWindowMs === null && mdSwitch.targetAfter && mdSample.targetSeen),
    "the next preview is immediate or the empty pane stays under the grace delay",
    mdSample.emptyWindowMs === null
      ? mdSwitch.targetAfter
        ? "the cached preview was restored during the click"
        : "no empty pane was sampled and the preview was not immediate"
      : `${Math.round(mdSample.emptyWindowMs)} ms`,
  );

  // -------------------------------------------------------------------------
  // 7. A switch made in Source mode, then Source -> Split
  // -------------------------------------------------------------------------
  console.log("\n=== Source -> Split ===");
  await clickTab("a.md", MARKERS);
  await emitMenu(page, "view.source");
  await sleep(300);
  hold("latex_engine_status");
  const sourceSwitch = await clickTab("doc.tex", MARKERS);
  check(
    !sourceSwitch.staleAfter,
    "the switch retires the Markdown preview while the pane is hidden",
  );
  await sampleStart(MARKERS, "OWNER-MARKER-TEX");
  await emitMenu(page, "view.split");
  check(Boolean(await waitForPending(2500)), "leaving Source mode shows the waiting surface");
  await sleep(400);
  const sourceSample = await sampleStop();
  check(
    sourceSample.violations === 0,
    "no sample showed the Markdown document after Source -> Split",
    `${sourceSample.hits} hits`,
  );
  await release("latex_engine_status");
  await waitForCommit(40000);

  // -------------------------------------------------------------------------
  // 8. Five rapid switches among four languages
  // -------------------------------------------------------------------------
  console.log("\n=== five rapid switches ===");
  await clickTab("a.md", MARKERS);
  await waitFor(
    `(document.getElementById("preview")?.textContent ?? "").includes("OWNER-MARKER-MD-A")`,
    10000,
  );
  hold("latex_engine_status");
  hold("render_typst");
  hold("render_typst_binary");
  await sampleStart(MARKERS);
  for (const [name, markers] of [
    ["doc.tex", TEX],
    ["a.typ", TYPST],
    ["a.adoc", ADOC],
    ["b.md", MD_B],
  ]) {
    const result = await clickTab(name, markers);
    if (!result.staleAfter) await sleep(40);
    else break;
  }
  await releaseAll();
  check(
    await waitFor(
      `(document.getElementById("preview")?.textContent ?? "").includes("OWNER-MARKER-MD-B")`,
      20000,
    ),
    "the final Markdown tab commits",
  );
  const rapidSample = await sampleStop();
  check(
    rapidSample.violations === 0,
    "the pane never showed a document other than the active one",
    `${rapidSample.violations} violations in ${rapidSample.records} samples`,
  );
  check(!(await hasPending()), "no waiting surface outlives the final commit");
  await sleep(500);
  check(!(await hasPending()), "no waiting timer re-creates the surface after the commit");

  // -------------------------------------------------------------------------
  // 9. A project's root and a chapter
  // -------------------------------------------------------------------------
  console.log("\n=== a project's root and chapter ===");
  if (!hasEngine) {
    skip(
      "moving between a project's root and a chapter keeps the PDF",
      "no LaTeX engine on this host",
    );
  } else {
    await emitOpenFiles([projectMain, projectChapter]);
    check(
      await waitFor(
        `["main.tex", "intro.tex"].every((name) => [...document.querySelectorAll(".doc-tab-name")].some((node) => node.textContent === name))`,
        30000,
        150,
      ),
      "the project's root and chapter tabs are open",
    );
    const rootClick = await clickTab("main.tex", MARKERS);
    check(rootClick.clicked, "the project root becomes active");
    const projectPdf = await waitFor(
      `Boolean(document.querySelector("#preview .typst-preview"))`,
      180000,
      500,
    );
    check(projectPdf, "the project's root compiles to a PDF");
    if (projectPdf) {
      const chapter = await clickTab("intro.tex", MARKERS);
      check(!chapter.staleAfter, "the chapter switch retires no project content");
      check(
        await page.evaluate(`Boolean(document.querySelector("#preview .typst-preview"))`),
        "the project PDF stays when the chapter opens",
      );
      check(!(await hasPending()), "no waiting surface appears inside one project");

      await setAutoCompile(false);
      await clickTab("main.tex", MARKERS);
      check(
        await page.evaluate(`Boolean(document.querySelector("#preview .typst-preview"))`),
        "manual mode keeps the PDF on the root",
      );
      await clickTab("intro.tex", MARKERS);
      check(
        await page.evaluate(`Boolean(document.querySelector("#preview .typst-preview"))`),
        "manual mode keeps the PDF on the chapter",
      );

      const unrelated = await page.evaluate(`(() => {
        const tab = [...document.querySelectorAll(".doc-tab")]
          .find((entry) => entry.querySelector(".doc-tab-name")?.textContent === "doc.tex");
        if (!tab) return { clicked: false, view: true };
        tab.click();
        return {
          clicked: true,
          view: Boolean(document.querySelector("#preview .typst-preview")),
          pending: Boolean(document.querySelector("#preview-pane > .preview-pending")),
        };
      })()`);
      check(unrelated.clicked, "the unrelated .tex tab is available");
      check(
        !unrelated.view,
        "an unrelated .tex retires the project PDF before its build can finish",
      );
      check(Boolean(await waitForPending(1500)), "the unrelated .tex gets the waiting surface");
      await setAutoCompile(autoBefore);
    }
  }

  // -------------------------------------------------------------------------
  // 10. Manual-compile .tex, never compiled
  // -------------------------------------------------------------------------
  console.log("\n=== a manual-compile LaTeX tab before its first build ===");
  await setAutoCompile(false);
  await clickTab("a.md", MARKERS);
  await emitOpenFiles([manualDoc]);
  const manualOpened = await waitFor(
    `[...document.querySelectorAll(".doc-tab-name")].some((node) => node.textContent === "manual.tex")`,
    20000,
  );
  check(manualOpened, "the manual-compile .tex tab opens");
  const idle = await waitForPending(2000);
  check(Boolean(idle), "an idle surface appears without compiling");
  if (idle) {
    check(idle.state === "idle", "the first surface for a manual .tex tab is idle", idle.state);
    check(idle.title === "manual.tex", "the idle surface names the file", idle.title);
    check(
      idle.phase.includes("Not compiled yet") && idle.phase.includes("Compile"),
      "the idle surface tells the reader to Compile",
      idle.phase,
    );
    check(idle.spinnerDisplay === "none", "the idle surface has no spinner", idle.spinnerDisplay);
    check(idle.elapsed === "", "the idle surface shows no elapsed counter", idle.elapsed);
  }
  const idleMarker = await paneText();
  check(
    !idleMarker.includes("OWNER-MARKER-MD-A"),
    "the idle surface replaced the previous document",
  );
  await clickTab("a.md", MARKERS);
  await setAutoCompile(autoBefore);

  // -------------------------------------------------------------------------
  // 10. HTML
  // -------------------------------------------------------------------------
  console.log("\n=== HTML keeps its own guest ===");
  await clickTab("a.md", MARKERS);
  await waitFor(
    `(document.getElementById("preview")?.textContent ?? "").includes("OWNER-MARKER-MD-A")`,
    10000,
  );
  await clickTab("a.html", MARKERS);
  check(
    await waitFor(`Boolean(document.querySelector(".html-preview-frame"))`, 15000),
    "the HTML guest appears",
  );
  check(!(await hasPending()), "an HTML tab never gets the waiting surface");
  await clickTab("a.md", MD);
  await waitFor(
    `(document.getElementById("preview")?.textContent ?? "").includes("OWNER-MARKER-MD-A")`,
    10000,
  );
  check(
    (await page.evaluate(`document.querySelectorAll(".html-preview-frame").length`)) === 0,
    "leaving HTML disposes the guest",
  );
  check(!(await hasPending()), "no waiting surface survives the return to Markdown");

  // -------------------------------------------------------------------------
  // LaTeX package and class syntax
  // -------------------------------------------------------------------------
  console.log("\n=== LaTeX package and class highlighting ===");
  await emitMenu(page, "view.source");
  const highlighted = (command) => `(() => {
    const lines = [...document.querySelectorAll('.cm-line')];
    const command = lines.find(line => line.textContent.includes(${JSON.stringify(command)}));
    const comment = lines.find(line => line.textContent.includes('% source comment'));
    return !!command && !!comment &&
      [...command.querySelectorAll('span[class]')].some(span => span.textContent.includes(${JSON.stringify(command)})) &&
      [...comment.querySelectorAll('span[class]')].some(span => span.textContent.includes('% source comment'));
  })()`;
  for (const [path, name, command] of [
    [packageDoc, "example.sty", "\\ProvidesPackage"],
    [classDoc, "example.CLS", "\\ProvidesClass"],
  ]) {
    await emitOpenFiles([path]);
    const active = await waitFor(
      `document.querySelector('.doc-tab[aria-selected="true"] .doc-tab-name')?.textContent === ${JSON.stringify(name)}`,
      20000,
    );
    check(
      active && (await waitFor(highlighted(command))),
      `${name} highlights commands and comments`,
    );
    if (name === "example.sty") {
      check(
        active && (await waitFor(highlighted("\\foo@bar"))),
        "package macros containing @ are highlighted as a single command",
      );
    }
  }
  await clickTab("example.sty", MARKERS);
  check(
    await waitFor(
      `document.querySelector('.doc-tab[aria-selected="true"] .doc-tab-name')?.textContent === "example.sty" && ${highlighted("\\ProvidesPackage")}`,
    ),
    "returning to a package tab restores LaTeX highlighting",
  );
  await clickTab("a.md", MARKERS);
  check(
    await waitFor(
      `document.querySelector('.doc-tab[aria-selected="true"] .doc-tab-name')?.textContent === "a.md" && !![...document.querySelectorAll('.cm-line span[class]')].find(span => span.textContent.includes('OWNER-MARKER-MD-A'))`,
    ),
    "returning to Markdown restores its highlighting",
  );

  // -------------------------------------------------------------------------
  // 11. The startup-slot incarnation rule
  // -------------------------------------------------------------------------
  console.log("\n=== the untitled startup slot ===");
  skip(
    "the first file into the untitled startup tab does not inherit its preview",
    "the harness launches with a document argument, so the slot is already consumed; the unit layer pins the incarnation rule",
  );

  // Leave the shell as it was found: a suite that runs against an installed
  // copy must not change what the next launch shows.
  await emitMenu(page, typstViewBefore === "pages" ? "view.typstPages" : "view.typstDocument");
  await emitMenu(
    page,
    viewModeBefore === "source"
      ? "view.source"
      : viewModeBefore === "preview"
        ? "view.preview"
        : "view.split",
  );
  await sleep(300);

  if (errors.length) console.log(`\npage errors:\n  ${errors.join("\n  ")}`);
} finally {
  await releaseAll().catch(() => {});
  await page.send("Fetch.disable").catch(() => {});
  await page.evaluate(`window.__ownerSampleStop?.(); "clean"`).catch(() => {});
  rmSync(workDir, { recursive: true, force: true });
  page.close();
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
