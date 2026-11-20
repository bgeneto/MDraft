#!/usr/bin/env node
// Exercise the PhiTeX compatibility frame in a real WebKitGTK webview.
//
//   MDRAFT_PHITEX_FILES=~/.local/share/io.github.bgeneto.mdraft/latex/phitex/files \
//     node scripts/phitex-frame-test.mjs
//
// The engine files must be the installed archive (or an extracted copy). The
// script serves the frame and its files on loopback, proxies Shelf pack
// requests, drives MiniBrowser through WebKitWebDriver, and proves the protocol
// the host uses: fit width, two-way scrolling, Unicode source selection,
// edit batching, logs and PDF export. MDRAFT_PHITEX_TEST_TEX runs a
// document-only check (links, minted), as does MDRAFT_PHITEX_SKIP_GESTURES=1;
// MDRAFT_PHITEX_PDF_OUT saves the exported bytes for inspection. Linux only;
// SKIPs when WebKitWebDriver is absent.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";

const files = resolve(
  process.env.MDRAFT_PHITEX_FILES ??
    join(
      process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
      "io.github.bgeneto.mdraft",
      "latex",
      "phitex",
      "files",
    ),
);
const shell = resolve(process.cwd(), "src-tauri", "phitex-shell");
const driver = ["/usr/bin/WebKitWebDriver", "/usr/local/bin/WebKitWebDriver"].find(existsSync);
if (process.platform !== "linux" || !driver) {
  console.log("SKIP: the PhiTeX frame test needs Linux and WebKitWebDriver");
  process.exit(0);
}
if (
  !existsSync(join(files, "dist", "core1.wasm")) ||
  !existsSync(join(files, "formats", "names.txt"))
) {
  console.log(`SKIP: no PhiTeX engine files at ${files} (set MDRAFT_PHITEX_FILES)`);
  process.exit(0);
}
if (
  !existsSync(join(shell, "bundles", "main.js")) ||
  !existsSync(join(shell, "bundles", "engine-worker.js"))
) {
  console.log("SKIP: the frame bundles are missing; run npm run build:phitex");
  process.exit(0);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".gzdata": "application/octet-stream",
  ".otf": "font/otf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".sty": "text/plain; charset=utf-8",
};
const packs = new Map();

function fileFor(path) {
  if (path === "/phitex/" || path === "/phitex/index.html") return join(shell, "index.html");
  if (path === "/phitex/bundles/main.js" || path === "/phitex/dist/main.js")
    return join(shell, "bundles", "main.js");
  if (path === "/phitex/bundles/engine-worker.js" || path === "/phitex/dist/engine-worker.js")
    return join(shell, "bundles", "engine-worker.js");
  if (path === "/phitex/shelf/release.json") return join(files, "shelf-release.json");
  if (path.startsWith("/phitex/shelf/")) return null;
  if (!path.startsWith("/phitex/")) return null;
  const relative = path.slice("/phitex/".length);
  if (!relative || relative.includes("..") || relative.includes("\\")) return null;
  return join(files, relative);
}

const fixture = process.env.MDRAFT_PHITEX_TEST_TEX;
const mainSource = fixture
  ? readFileSync(fixture, "utf8")
  : String.raw`\documentclass{article}
\usepackage{amsmath}
% café 😀 before the source positions
\begin{document}
First page with a paragraph and $\int_0^1 x^2\,dx$.
\newpage
\noindent This sentence has matching words.\par
Below it another anchor to check scrolling.\par
The third anchor is on this same page.
\newpage
One final page to test navigation.
\end{document}`;
const skipGestures = !!fixture || process.env.MDRAFT_PHITEX_SKIP_GESTURES === "1";
const pdfOut = process.env.MDRAFT_PHITEX_PDF_OUT ?? null;

function exerciseFrame(source, skip) {
  const frame = document.getElementById("f");
  const replies = [];
  const checks = [];
  window.__checks = checks;
  let nextSeq = 1;
  const send = (message) => {
    const seq = nextSeq++;
    frame.contentWindow.postMessage({ v: 1, seq, ...message }, location.origin);
    return seq;
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(read, message, ms = 10000) {
    const deadline = performance.now() + ms;
    while (performance.now() < deadline) {
      const value = await read();
      if (value) return value;
      await wait(40);
    }
    throw new Error(message);
  }

  async function exercise(projectSeq) {
    const paint = await until(
      () => replies.find((m) => m.type === "painted" && m.seq === projectSeq && m.done && m.pages),
      "the original project did not finish painting",
      25000,
    );
    checks.push([paint.pages >= (skip ? 1 : 3), "the document was typeset", String(paint.pages)]);
    if (skip) {
      send({ type: "export" });
      return;
    }

    const doc = frame.contentDocument;
    const shadow = doc.querySelector("phitex-preview").shadowRoot;
    const stage = shadow.querySelector("#stage");
    const { session, panel } = frame.contentWindow.__phitex;
    const slot = await until(() => shadow.querySelector(".slot[data-k='1']"), "page 2 missing");
    const width = () => slot.getBoundingClientRect().width;
    const fits = (factor) => Math.abs(width() - (stage.clientWidth - 32) * factor) <= 2;
    await until(() => fits(1), "the first render did not fit the width");
    checks.push([true, "startup uses 16 px side gutters"]);
    send({ type: "zoom", factor: 1.25 });
    await until(() => fits(1.25), "125% did not use the pane's fit width");
    frame.style.width = "460px";
    await until(
      () => stage.clientWidth <= 460 && fits(1.25),
      "the zoom did not follow the resized pane",
    );
    checks.push([true, "relative zoom followed a pane resize"]);
    send({ type: "zoom", factor: 1 });
    await until(() => fits(1), "zoom reset did not restore fit width");
    checks.push([true, "zoom reset restored fit width"]);

    const word = "matching";
    const wordStart = source.indexOf(word);
    const wordEnd = wordStart + word.length;
    const byteAt = (offset) => new TextEncoder().encode(source.slice(0, offset)).length;
    const glyphs = await until(async () => {
      const result = await session.sourceGlyphs(1);
      return result.find((g) => g.file === "main.tex" && g.start === byteAt(wordStart)) && result;
    }, "the engine did not return the word's origins");
    const glyph = glyphs.find((g) => g.file === "main.tex" && g.start === byteAt(wordStart));
    const anchorY = 170;
    const points = () => panel.pixelsPerPoint() / frame.contentWindow.devicePixelRatio;
    const anchorLine = source.slice(0, wordStart).split("\n").length;
    const viewportStart = replies.length;
    const request = send({ type: "reveal", file: "main.tex", line: anchorLine, y: anchorY });
    const scrolled = await until(
      () => replies.find((m) => m.type === "scrolled" && m.seq === request),
      "source reveal was never acknowledged",
    );
    const pixelError = Math.abs(
      slot.getBoundingClientRect().top + (glyph.y - 8) * points() - anchorY,
    );
    checks.push([
      scrolled.scrollTop > 0 && pixelError <= 3,
      "source reveal used the requested pixel height",
      pixelError.toFixed(2),
    ]);
    checks.push([
      !replies.slice(viewportStart).some((m) => m.type === "viewport" && m.gesture),
      "source-driven scrolling did not echo as a gesture",
    ]);

    const canvas = await until(() => slot.querySelector("canvas"), "page 2 did not draw");
    const location = slot.getBoundingClientRect();
    canvas.dispatchEvent(
      new frame.contentWindow.MouseEvent("dblclick", {
        bubbles: true,
        composed: true,
        detail: 2,
        clientX: location.left + (glyph.x + 2.5) * points(),
        clientY: location.top + (glyph.y - 3) * points(),
      }),
    );
    const double = await until(
      () => replies.find((m) => m.type === "source" && m.detail === 2),
      "double-click did not resolve a source word",
    );
    checks.push([
      double.from === wordStart && double.to === wordEnd && double.y > 0,
      "double-click reported the UTF-16 word and its height",
      JSON.stringify(double),
    ]);

    const sentence = "This sentence has matching words.";
    const sentenceStart = source.indexOf(sentence);
    const text = await until(
      () => [...slot.querySelectorAll("text")].find((el) => el.textContent.includes(sentence)),
      "the selection text layer did not appear",
    );
    const at = text.textContent.indexOf("sentence has matching");
    const rangeText = "sentence has matching";
    const selection = frame.contentWindow.getSelection();
    text.dispatchEvent(
      new frame.contentWindow.PointerEvent("pointerdown", { bubbles: true, composed: true }),
    );
    selection.setBaseAndExtent(text.firstChild, at, text.firstChild, at + rangeText.length);
    text.dispatchEvent(
      new frame.contentWindow.PointerEvent("pointerup", { bubbles: true, composed: true }),
    );
    const drag = await until(
      () => replies.find((m) => m.type === "source" && m.drag),
      "drag could not resolve its source range",
    );
    const dragStart = sentenceStart + sentence.indexOf(rangeText);
    checks.push([
      drag.from === dragStart &&
        drag.to === dragStart + rangeText.length &&
        selection.toString() === rangeText,
      "WebKit drag reported the selected phrase and preserved native text selection",
      JSON.stringify(drag),
    ]);
    await until(() => slot.querySelector(".mark.seltext"), "the native selection had no highlight");

    const beforeMark = stage.scrollTop;
    send({ type: "select", file: "main.tex", from: wordStart, to: wordEnd, blink: true });
    await until(() => slot.querySelector(".mark.sel"), "the editor's word did not mark the page");
    checks.push([stage.scrollTop === beforeMark, "source selection highlighted without scrolling"]);
    send({ type: "clear" });
    await until(() => !slot.querySelector(".mark.sel"), "clear left a stale source mark");

    const nextAnchor = glyphs.find(
      (g) => g.file === "main.tex" && g.start === byteAt(source.indexOf("Below it")),
    );
    const nextHeight = slot.getBoundingClientRect().top + (nextAnchor.y - 8) * points();
    const reference = anchorY - 35;
    send({ type: "reference", y: reference });
    await wait(50);
    const viewStart = replies.length;
    const deltaY = nextHeight - reference;
    stage.dispatchEvent(new frame.contentWindow.WheelEvent("wheel", { bubbles: true, deltaY }));
    stage.scrollTop += deltaY;
    const viewport = await until(
      () => replies.slice(viewStart).find((m) => m.type === "viewport" && m.gesture && m.file),
      "wheel scroll did not report its source anchor",
    );
    checks.push([
      Math.abs(viewport.line - (anchorLine + 1)) < 0.2,
      "preview scroll used the updated reference height",
      JSON.stringify(viewport),
    ]);

    const jumpStart = replies.length;
    send({ type: "page", page: 3 });
    await until(
      () =>
        replies.slice(jumpStart).some((m) => m.type === "viewport" && m.page === 3 && m.gesture),
      "the last-page jump did not report its requested page",
    );
    checks.push([true, "page navigation reports a user landing"]);

    const workStart = replies.length;
    const builds = session.builds;
    const suffix = " Final input reaches export.";
    let from = source.indexOf("First page");
    let after = source;
    let lastEdit = 0;
    for (const char of suffix) {
      lastEdit = send({
        type: "edit",
        file: "main.tex",
        base: after.length,
        changes: [[from, from, char]],
      });
      after = after.slice(0, from) + char + after.slice(from);
      from += 1;
      await wait(27);
    }
    send({ type: "export" });
    await until(
      () => replies.find((m) => m.type === "painted" && m.done && m.seq === lastEdit),
      "final batch did not report its revision",
    );
    const scope = replies.slice(workStart);
    const status = scope.filter((m) => m.type === "status");
    const phases = status
      .map((m) => m.busy)
      .filter((busy, i, list) => i === 0 || busy !== list[i - 1]);
    checks.push([
      scope.some((m) => m.type === "ack" && m.seq === lastEdit && m.length === after.length) &&
        session.text("main.tex") === after,
      "all the edits were acknowledged and the last text reached the engine",
    ]);
    checks.push([
      session.builds - builds <= 5,
      "continuous input was batched",
      String(session.builds - builds),
    ]);
    checks.push([
      phases.length === 2 && phases[0] && !phases[1],
      "typesetting stayed active through the burst",
      JSON.stringify(phases),
    ]);
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (event.source !== frame.contentWindow || msg?.v !== 1) return;
    replies.push(msg);
    if (msg.type === "ready") {
      send({
        type: "init",
        theme: { dark: false, sync: "", peak: "", paper: "#fff", pane: "#e9edf2" },
        zoom: 1,
        reference: 12,
      });
      const project = send({
        type: "project",
        main: "main.tex",
        files: [{ path: "main.tex", text: source }],
        remove: [],
        replace: true,
        active: "main.tex",
        compile: true,
      });
      exercise(project).then(
        () => (window.__exercised = true),
        (error) => {
          const recent = replies.filter((reply) => reply.type !== "pdf").slice(-6);
          const session = frame.contentWindow.__phitex?.session;
          const trace = session?.trace?.slice(-8).map((entry) => entry.k);
          window.__error = String(error) + " " + JSON.stringify({ recent, trace });
        },
      );
    }
    if (msg.type === "pdf") {
      window.__pdfBytes = Array.from(new Uint8Array(msg.pdf));
      window.__logged = replies.some((m) => m.type === "trace" && /typeset/i.test(m.text));
    }
    if (msg.type === "error") window.__error = msg.message;
  });
}

const HOST = `<!doctype html><html><head><meta charset="utf-8"><title>PhiTeX frame test</title>
<style>html,body{margin:0;height:100%;overflow:hidden}#f{position:absolute;inset:0;width:100%;height:100%;border:0}</style>
</head><body><iframe id="f" src="/phitex/index.html?host=__HOST__&engine=xetex"></iframe>
<script>(${exerciseFrame.toString()})(__MAIN__,__SKIP__);</script></body></html>`;

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/host.html") {
    const html = HOST.replace("__HOST__", `http://127.0.0.1:${server.address().port}`)
      .replace("__MAIN__", () => JSON.stringify(mainSource).replaceAll("<", "\\u003c"))
      .replace("__SKIP__", String(skipGestures));
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  if (url.pathname.startsWith("/phitex/shelf/h/")) {
    const id = decodeURIComponent(url.pathname.slice("/phitex/shelf/h/".length)).replace(
      /\.pack$/,
      "",
    );
    try {
      let bytes = packs.get(id);
      if (!bytes) {
        const upstream = await fetch(
          `https://v1.shelf.phitex.org/tl2026/h/${encodeURIComponent(id)}.pack`,
        );
        if (!upstream.ok) throw new Error(`Shelf ${upstream.status}`);
        bytes = Buffer.from(await upstream.arrayBuffer());
        packs.set(id, bytes);
      }
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(bytes);
    } catch (error) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end(String(error));
    }
    return;
  }
  const path = fileFor(url.pathname);
  if (!path || !existsSync(path) || !statSync(path).isFile()) {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
    return;
  }
  response.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
  createReadStream(path).pipe(response);
});

const call = async (base, method, path, body) => {
  const response = await fetch(base + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json();
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;
let session;
let driverBase = "";
let failed = 0;
const check = (ok, label, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const driverPort = 9500 + Math.floor(Math.random() * 400);
  browser = spawn(driver, [`--port=${driverPort}`, "--host=127.0.0.1"], {
    stdio: "ignore",
    env: {
      ...process.env,
      GDK_BACKEND: "x11",
      LIBGL_ALWAYS_SOFTWARE: "1",
      WEBKIT_DISABLE_COMPOSITING_MODE: "1",
    },
  });
  const base = (driverBase = `http://127.0.0.1:${driverPort}`);
  for (let i = 0; i < 50; i += 1) {
    try {
      await call(base, "GET", "/status");
      break;
    } catch {
      await sleep(100);
    }
  }
  const created = await call(base, "POST", "/session", {
    capabilities: { alwaysMatch: { browserName: "MiniBrowser" } },
  });
  session = created.value.sessionId;
  await call(base, "POST", `/session/${session}/url`, {
    url: `http://127.0.0.1:${port}/host.html`,
  });
  let result = null;
  for (let i = 0; i < 90; i += 1) {
    await sleep(1000);
    const state = await call(base, "POST", `/session/${session}/execute/sync`, {
      script:
        "return {checks:window.__checks, exercised:window.__exercised, pdfBytes:window.__pdfBytes, logged:window.__logged, error:window.__error}",
      args: [],
    });
    if (state.value?.error && state.value.message) throw new Error(state.value.message);
    result = state.value;
    if (result?.error || (result?.exercised && result?.pdfBytes)) break;
  }
  for (const [ok, label, detail] of result?.checks ?? []) check(ok, label, detail);
  const pdf = result?.pdfBytes && Buffer.from(result.pdfBytes);
  check(
    pdf?.length > 1000 && pdf.subarray(0, 5).toString() === "%PDF-",
    "the frame exported a PDF",
    `${pdf?.length ?? 0} bytes`,
  );
  if (pdfOut && pdf?.length > 1000) {
    writeFileSync(pdfOut, pdf);
    console.log(`      saved PDF to ${pdfOut} (${pdf.length} bytes)`);
  }
  check(result?.logged, "the compiler log reached the host");
  check(result?.exercised && !result?.error, "the frame reported no error", result?.error ?? "");
} catch (error) {
  failed += 1;
  console.log(`FAIL  ${String(error?.stack ?? error)}`);
} finally {
  if (session) {
    try {
      await call(driverBase, "DELETE", `/session/${session}`);
    } catch {
      // The driver may already be gone.
    }
  }
  browser?.kill("SIGTERM");
  server.close();
}
console.log(failed ? `\n${failed} check(s) failed` : "\nPhiTeX frame checks passed");
process.exit(failed ? 1 : 0);
