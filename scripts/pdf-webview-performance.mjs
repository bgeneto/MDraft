#!/usr/bin/env node
//! Measure a compiled LaTeX project's PDF map inside an isolated WebView.
//! The caller must launch an isolated MDraft instance with the engine enabled.
//! Usage: npm run pdf:map:webview -- <CDP port> <app PID> <WebView path marker> [paragraphs] [keystrokes]
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openPage, emitMenu, sleep } from "./cdp-page.mjs";

const port = Number(process.argv[2]);
const appPid = Number(process.argv[3]);
const marker = process.argv[4];
const paragraphs = Number(process.argv[5] ?? 180);
const requestedKeys = Number(process.argv[6] ?? 20);
if (
  process.platform !== "win32" ||
  !Number.isSafeInteger(port) ||
  port < 1 ||
  !Number.isSafeInteger(appPid) ||
  appPid < 1 ||
  !marker ||
  !/mdraft-(?:test-|pdfprobe)/i.test(marker) ||
  !Number.isSafeInteger(paragraphs) ||
  paragraphs < 10 ||
  paragraphs > 1000 ||
  !Number.isSafeInteger(requestedKeys) ||
  requestedKeys < 1 ||
  requestedKeys > 50
) {
  throw new Error(
    "Usage: npm run pdf:map:webview -- <CDP port> <app PID> <WebView path marker> [10..1000 paragraphs] [1..50 keystrokes]",
  );
}

// Never type into a user's app: the executable, its WebView profile and CDP port
// must all belong to the same explicitly staged test instance.
const verifyCode = [
  "$ErrorActionPreference = 'Stop'",
  "$probePid = [int]$env:MDRAFT_PDF_PROBE_PID",
  "$marker = $env:MDRAFT_PDF_PROBE_MARKER",
  "$port = $env:MDRAFT_PDF_PROBE_PORT",
  "$app = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $probePid)",
  "if (-not $app -or $app.Name -ine 'mdraft.exe' -or $app.ExecutablePath -notlike ('*' + $marker + '*')) { throw 'The PID is not the staged test application.' }",
  "$browser = @(Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | Where-Object { $_.ParentProcessId -eq $probePid -and $_.CommandLine -like ('*' + $marker + '*') -and $_.CommandLine -like ('*--remote-debugging-port=' + $port + '*') })",
  "if ($browser.Count -ne 1) { throw 'The staged WebView and requested CDP port do not match.' }",
].join("\n");
const verified = spawnSync(
  "pwsh",
  [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(verifyCode, "utf16le").toString("base64"),
  ],
  {
    env: {
      ...process.env,
      MDRAFT_PDF_PROBE_PID: String(appPid),
      MDRAFT_PDF_PROBE_MARKER: marker,
      MDRAFT_PDF_PROBE_PORT: String(port),
    },
    encoding: "utf8",
    windowsHide: true,
  },
);
if (verified.status !== 0)
  throw new Error("Isolated test app verification failed: " + verified.stderr);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdraft-pdf-webview-perf-"));
const root = path.join(dir, "performance.tex");
const chapterPath = path.join(dir, "chapter.tex");
const slash = String.fromCharCode(92);
const directive = slash + "synctex=1\n";
const chapter =
  Array.from({ length: paragraphs }, (_, index) => {
    const n = String(index + 1);
    return (
      "Paragraph " +
      n +
      " presents sample" +
      n +
      " in a distinctive passage about a reader following edited text across the pages. " +
      "The source and PDF should identify the same words while compilation and indexing remain responsive. " +
      "Equation $Q=" +
      n +
      "$ supplies a separate math region for the correspondence map."
    );
  }).join("\n\n") + "\n";
const main =
  slash +
  "documentclass{article}\n" +
  slash +
  "usepackage{graphicx}\n" +
  slash +
  "begin{document}\n" +
  "Opening benchmark text provides a distinctive source passage.\n\n" +
  slash +
  "includegraphics[width=12mm]{figure.png}\n\n" +
  slash +
  "input{chapter}\n" +
  slash +
  "end{document}\n";
fs.writeFileSync(root, main);
fs.writeFileSync(chapterPath, chapter);
fs.copyFileSync(
  path.join(process.cwd(), "samples", "latex-project", "figures", "diagram.png"),
  path.join(dir, "figure.png"),
);

const page = await openPage(port);
const evaluate = (fn, ...args) =>
  page.evaluate("(" + fn.toString() + ")(" + args.map(JSON.stringify).join(",") + ")");
const samples = [];
const samplerCode = [
  "$ErrorActionPreference = 'Stop'",
  "$probePid = [int]$env:MDRAFT_PDF_PROBE_PID",
  "$marker = $env:MDRAFT_PDF_PROBE_MARKER",
  "while ($true) {",
  "  $app = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $probePid) -ErrorAction SilentlyContinue",
  "  $web = @(Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | Where-Object { $_.CommandLine -like ('*' + $marker + '*') })",
  "  $items = @($app) + $web | Where-Object { $null -ne $_ }",
  "  $sum = ($items | Measure-Object -Property WorkingSetSize -Sum).Sum",
  "  if ($null -eq $sum) { $sum = 0 }",
  "  [Console]::WriteLine(([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).ToString() + ',' + [string][long]$sum + ',' + [string]@($items).Count)",
  "  Start-Sleep -Milliseconds 250",
  "}",
].join("\n");
let sampler = null;
let samplerError = "";
if (process.platform === "win32") {
  sampler = spawn(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(samplerCode, "utf16le").toString("base64"),
    ],
    {
      env: {
        ...process.env,
        MDRAFT_PDF_PROBE_PID: String(appPid),
        MDRAFT_PDF_PROBE_MARKER: marker,
      },
      windowsHide: true,
    },
  );
  let buffer = "";
  sampler.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      const match = line.match(/^(\d+),(\d+),(\d+)$/);
      if (match)
        samples.push({
          at: Number(match[1]),
          bytes: Number(match[2]),
          processes: Number(match[3]),
        });
    }
  });
  sampler.stderr.on("data", (chunk) => {
    samplerError += chunk.toString();
  });
}
function memoryDuring(start, end) {
  const before = samples.filter((sample) => sample.at <= start).at(-1) ?? null;
  const during = samples.filter((sample) => sample.at >= start && sample.at <= end);
  return {
    baseline: before?.bytes ?? null,
    peak: during.length ? Math.max(...during.map((sample) => sample.bytes)) : null,
    samples: during.length,
  };
}
async function waitFor(fn, label, timeout = 120000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await evaluate(fn);
    if (value) return value;
    const failure = await page.evaluate(
      'document.querySelector("#preview .typst-error")?.textContent ?? ""',
    );
    if (failure) throw new Error(label + ": " + String(failure).slice(0, 1000));
    await sleep(75);
  }
  throw new Error("Timed out waiting for " + label);
}
const state = () =>
  evaluate(() => {
    const host = document.querySelector(".typst-preview:not([style*=hidden])");
    return {
      token: document.querySelector("#preview")?.dataset.latexCurrent ?? "",
      map: host?.dataset.wordMap ?? "",
      mapMs: Number(host?.dataset.wordMapMs ?? 0),
      batchMs: Number(host?.dataset.wordMapBatchMs ?? 0),
      anchors: Number(host?.dataset.wordMapAnchors ?? 0),
      atomic: Number(host?.dataset.wordMapAtomicAnchors ?? 0),
      compileMs: Number(document.querySelector("#preview")?.dataset.latexMs ?? 0),
      pages: host?.querySelectorAll(".typst-page-shell").length ?? 0,
    };
  });
async function newPdf(previous, start) {
  let first;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const current = await state();
    if (current.token && current.token !== previous && !first)
      first = { at: Date.now(), state: current };
    if (first && current.token !== previous && current.map === "ready") {
      return { ...current, usableMs: first.at - start, totalMs: Date.now() - start };
    }
    const failure = await page.evaluate(
      'document.querySelector("#preview .typst-error")?.textContent ?? ""',
    );
    if (failure) throw new Error("PDF compile failed: " + String(failure).slice(0, 1000));
    await sleep(75);
  }
  throw new Error("Timed out waiting for the current PDF and word map");
}
async function exportBytes() {
  await evaluate(() => {
    window.__pdfPerf.exported = null;
  });
  await emitMenu(page, "export.pdf");
  await waitFor(() => window.__pdfPerf.exported, "captured compiled PDF");
  return evaluate(() => window.__pdfPerf.exported);
}
async function visualSnapshot() {
  const info = await evaluate(() => {
    const host = document.querySelector(".typst-preview:not([style*=hidden])");
    const shells = [...host.querySelectorAll(".typst-page-shell")];
    return {
      text: shells.map((shell) => shell.querySelector(".textLayer")?.textContent ?? "").join("\n"),
      geometry: shells.map((shell) => {
        const box = shell.getBoundingClientRect();
        return [Math.round(box.width * 100) / 100, Math.round(box.height * 100) / 100];
      }),
      pages: shells.length,
    };
  });
  const hashes = [];
  for (const index of [0, info.pages - 1]) {
    await evaluate((pageIndex) => {
      const host = document.querySelector(".typst-preview:not([style*=hidden])");
      host.querySelectorAll(".typst-page-shell")[pageIndex].scrollIntoView({ block: "center" });
    }, index);
    const deadline = Date.now() + 12000;
    let ready = false;
    while (Date.now() < deadline) {
      ready = await evaluate((pageIndex) => {
        const host = document.querySelector(".typst-preview:not([style*=hidden])");
        const canvas = host
          ?.querySelectorAll(".typst-page-shell")
          [pageIndex]?.querySelector("canvas");
        return Boolean(canvas && canvas.width > 0 && canvas.height > 0);
      }, index);
      if (ready) break;
      await sleep(75);
    }
    if (!ready) throw new Error("Canvas did not render for page " + (index + 1));
    await sleep(250);
    const png = await evaluate((pageIndex) => {
      const host = document.querySelector(".typst-preview:not([style*=hidden])");
      return host
        .querySelectorAll(".typst-page-shell")
        [pageIndex].querySelector("canvas")
        .toDataURL("image/png");
    }, index);
    hashes.push(createHash("sha256").update(png).digest("hex"));
  }
  return {
    pages: info.pages,
    geometry: info.geometry,
    textHash: createHash("sha256").update(info.text).digest("hex"),
    canvasHashes: hashes,
  };
}
async function insertDirective(enabled) {
  return evaluate(
    (on, value) => {
      const view = document.querySelector(".cm-content").cmTile.root.view;
      const text = view.state.doc.toString();
      const at = text.indexOf(value);
      if (on && at < 0)
        view.dispatch({ changes: { from: view.state.doc.line(1).to + 1, insert: value } });
      if (!on && at >= 0) view.dispatch({ changes: { from: at, to: at + value.length } });
      return view.state.doc.toString().includes(value) === on;
    },
    enabled,
    directive,
  );
}
let armed = false;
let attempts = 0;
let inFlight = false;
let inputError = "";
const maxAttempts = Math.max(40, requestedKeys * 2);
async function sendX() {
  const timestamp = Date.now() / 1000;
  const common = { key: "x", code: "KeyX", windowsVirtualKeyCode: 88, timestamp };
  await page.send("Input.dispatchKeyEvent", { ...common, type: "keyDown" });
  await page.send("Input.dispatchKeyEvent", {
    ...common,
    type: "char",
    text: "x",
    unmodifiedText: "x",
  });
  await page.send("Input.dispatchKeyEvent", { ...common, type: "keyUp" });
}
page.onConsole((_level, text) => {
  if (text !== "__PDF_MAP_START__" || !armed || inFlight || attempts >= maxAttempts) return;
  attempts += 1;
  inFlight = true;
  sendX()
    .catch((error) => {
      inputError = String(error);
    })
    .finally(() => {
      inFlight = false;
    });
  if (attempts % 5 === 0) console.log("  map-overlap typing attempts: " + attempts);
});
try {
  await evaluate(
    (outputPath) => {
      const p = (window.__pdfPerf = { active: new Set(), events: [], starts: 0, exported: null });
      const post = Worker.prototype.postMessage;
      const terminate = Worker.prototype.terminate;
      const observed = new WeakSet();
      Worker.prototype.postMessage = function (message, ...rest) {
        if (
          message &&
          typeof message.language === "string" &&
          Array.isArray(message.files) &&
          Array.isArray(message.lines) &&
          !observed.has(this)
        ) {
          observed.add(this);
          p.active.add(this);
          p.starts += 1;
          this.addEventListener("message", (event) => {
            if (event.data?.done) p.active.delete(this);
          });
          console.log("__PDF_MAP_START__");
        }
        return post.call(this, message, ...rest);
      };
      Worker.prototype.terminate = function () {
        p.active.delete(this);
        return terminate.call(this);
      };
      window.addEventListener(
        "keydown",
        (event) => {
          if (event.key !== "x" || !event.target?.closest?.(".cm-content")) return;
          p.events.push({
            age: Math.max(0, performance.now() - event.timeStamp),
            overlap: p.active.size > 0,
          });
        },
        true,
      );
      const original = window.fetch;
      window.fetch = async function (input, options) {
        const url = new URL(typeof input === "string" ? input : input.url, location.href);
        if (url.hostname !== "ipc.localhost") return original.call(this, input, options);
        const command = decodeURIComponent(url.pathname.slice(1));
        const respond = (value) =>
          new Response(JSON.stringify(value), {
            headers: { "Content-Type": "application/json", "Tauri-Response": "ok" },
          });
        if (command === "plugin:dialog|save") return respond(outputPath);
        if (command === "save_compiled_pdf") {
          const args = typeof options?.body === "string" ? JSON.parse(options.body) : {};
          const data = args.data ?? "";
          const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
          p.exported = { bytes: (data.length * 3) / 4 - padding, header: atob(data.slice(0, 8)) };
          return respond(null);
        }
        return original.call(this, input, options);
      };
    },
    path.join(dir, "ignored.pdf"),
  );
  if (sampler) {
    const until = Date.now() + 15000;
    while (!samples.length && Date.now() < until) await sleep(100);
    if (!samples.length) console.log("  memory sampler unavailable: " + samplerError.slice(0, 400));
  }
  console.log(
    "Fixture: " +
      Buffer.byteLength(main) +
      " + " +
      Buffer.byteLength(chapter) +
      " source bytes, " +
      paragraphs +
      " paragraphs, included file and image",
  );
  const before = (await state()).token;
  const initialStart = Date.now();
  await evaluate(
    (file) =>
      window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "open-files",
        payload: [file],
      }),
    root,
  );
  await emitMenu(page, "view.split");
  const initial = await newPdf(before, initialStart);
  initial.memory = memoryDuring(initialStart, Date.now());
  const offVisual = await visualSnapshot();
  initial.pdf = await exportBytes();
  console.log("  initial off: " + JSON.stringify(initial));

  const cycles = [];
  let onVisual = null;
  for (const enabled of [true, false, true, false]) {
    const previous = (await state()).token;
    const start = Date.now();
    assert.equal(await insertDirective(enabled), true);
    const current = await newPdf(previous, start);
    current.memory = memoryDuring(start, Date.now());
    current.pdf = await exportBytes();
    current.synctex = enabled;
    if (enabled && !onVisual) onVisual = await visualSnapshot();
    cycles.push(current);
    console.log("  " + (enabled ? "on" : "off") + ": " + JSON.stringify(current));
  }
  assert.deepEqual(
    onVisual,
    offVisual,
    "SyncTeX changes PDF text, page geometry, or first/last page pixels",
  );
  console.log("  on/off PDF text, page geometry, and first/last page pixels match");

  await evaluate(() => {
    const view = document.querySelector(".cm-content").cmTile.root.view;
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    view.focus();
    window.__pdfPerf.events = [];
  });
  const beforeTyping = (await state()).token;
  armed = true;
  await sendX();
  const deadline = Date.now() + 240000;
  let eventStats = { events: [], active: 0 };
  while (Date.now() < deadline && attempts < maxAttempts && !inputError) {
    eventStats = await evaluate(() => ({
      events: window.__pdfPerf.events,
      active: window.__pdfPerf.active.size,
    }));
    if (eventStats.events.filter((event) => event.overlap).length >= requestedKeys) break;
    await sleep(200);
  }
  armed = false;
  while (inFlight) await sleep(50);
  if (inputError) throw new Error(inputError);
  const final = await newPdf(beforeTyping, Date.now());
  eventStats = await evaluate(() => ({
    events: window.__pdfPerf.events,
    active: window.__pdfPerf.active.size,
  }));
  const ages = eventStats.events
    .filter((event) => event.overlap)
    .map((event) => event.age)
    .sort((a, b) => a - b);
  const p95 = ages.length
    ? ages[Math.min(ages.length - 1, Math.ceil(ages.length * 0.95) - 1)]
    : null;
  const max = ages.at(-1) ?? null;
  console.log(
    "  typing during PDF map work: " +
      JSON.stringify({
        attempts,
        events: eventStats.events.length,
        overlapping: ages.length,
        p95,
        max,
        final,
      }),
  );
  assert.ok(ages.length >= requestedKeys, "too few real keystrokes overlapped PDF mapping");
  assert.ok(p95 <= 100 && max <= 150, "typing exceeded the input-age thresholds");
  assert.equal(
    fs.readdirSync(dir).some((name) => /\.synctex(?:\.gz)?$/i.test(name)),
    false,
    "a SyncTeX file appeared in the project directory",
  );
  console.log("PASS: WebView PDF performance and on/off comparison");
} finally {
  armed = false;
  if (sampler) sampler.kill();
  page.close();
  console.log("Fixture retained in isolated test temp: " + dir);
}
