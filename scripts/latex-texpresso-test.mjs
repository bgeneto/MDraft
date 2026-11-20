// The TeXpresso preview backend, through the real application (step 11 of
// docs/architecture.md).
//
//   node scripts/latex-texpresso-test.mjs <port>
//
// Opt-in layer `latex-texpresso`. It needs a local origin server, so the
// harness starts one when `MDRAFT_TEXPRESSO_MIRROR` and `MDRAFT_TEXPRESSO_ENGINE`
// name the mirror and the engine folder; otherwise the layer prints one SKIP
// line saying why and exits 0.
//
// What it proves, in order:
//   1. the backend switch mounts a frame of its own origin, and it boots;
//   2. the frame holds MDraft's project, not an example;
//   3. an edit repaints on the frame's own path, and the engine's copy agrees;
//   4. the frame's own `xdvipdfmx` export fills the PDF Export, Print and the menu read;
//   5. selection, caret, click and double-click follow the PDF conventions;
//   6. scroll correspondence works in both directions;
//   7. zoom, both themes and manual mode reach the frame;
//   8. the frame registers no service worker and requests nothing off-origin;
//   9. another tab hides the frame instead of restarting the engine, and a
//      return to another project keeps the page the reader left it at;
//  10. a click on a link follows it, never the source map: a destination scrolls
//      the preview, a web address goes to the (stubbed) system opener;

import { openPage, emitMenu, sleep } from "./cdp-page.mjs";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";

const port = process.argv[2] ?? "9222";

if (!process.env.MDRAFT_TEXPRESSO_MIRROR || !process.env.MDRAFT_TEXPRESSO_ENGINE) {
  console.log(
    "SKIP: the TeXpresso layer needs MDRAFT_TEXPRESSO_MIRROR (the TeX Live mirror) " +
      "and MDRAFT_TEXPRESSO_ENGINE (the engine folder) so the runner can start the origin server.",
  );
  process.exit(0);
}

const page = await openPage(port);

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const errors = [];
page.onException((text) => errors.push(text.split("\n")[1] ?? text.split("\n")[0]));
page.onConsole((level, text) => {
  if (level === "error") errors.push(text);
});

const evaluate = (expression) => page.evaluate(expression);
const invoke = (command, args = {}) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}).then(JSON.stringify)`,
  ).then(JSON.parse);

async function waitFor(expression, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return true;
    } catch {
      // The preview may be swapping its DOM.
    }
    await sleep(150);
  }
  console.log(`  (timed out after ${timeout / 1000}s waiting for ${label})`);
  return false;
}

const dataset = (name) => evaluate(`document.querySelector("#preview")?.dataset.${name} ?? null`);

let frame = null;
const frameEval = (expression) => frame.evaluate(expression);

async function findFrame() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return list.find((entry) => /mdraft-tex\.localhost\/texpresso\//.test(entry.url)) ?? null;
}

async function attachFrame() {
  const target = await findFrame();
  if (!target) return null;
  frame = await openPage(port, { type: "iframe", match: /mdraft-tex\.localhost/ });
  frame.onException((text) => errors.push(`[frame] ${text.split("\n")[0]}`));
  frame.onConsole((level, text) => {
    console.log(`[frame ${level}] ${text}`);
    if (level === "error") errors.push(`[frame] ${text}`);
  });
  return target;
}

/** Run a body against the editor's CodeMirror view. */
const editor = (body) =>
  evaluate(`(() => {
    const view = document.querySelector(".cm-content").cmTile.root.view;
    ${body}
  })()`);

const editorDoc = () => editor(`return view.state.doc.toString();`);

/** Open a fixture in a tab of its own and wait for it to be the active one. */
async function openFile(relative) {
  const absolute = `${process.env.MDRAFT_REPO ?? process.cwd()}\\${relative.replace(/\//g, "\\")}`;
  await evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "open-files", payload: ${JSON.stringify([absolute])} })`,
  );
  await waitFor(
    `document.getElementById("status-file")?.textContent?.includes(${JSON.stringify(relative.split("/").pop())})`,
    30_000,
    `the ${relative} tab`,
  );
  await sleep(500);
}

const enableAndCompile = () => {
  // The switch is a Preferences row, which also updates the frontend's copy.
  return evaluate(`(async () => {
    const status = await window.__TAURI_INTERNALS__.invoke("latex_engine_status");
    if (status.bundledEnabled && status.previewInstalled) return "already on";
    const open = document.getElementById("btn-prefs");
    open?.click();
    await new Promise((r) => setTimeout(r, 500));
    [...document.querySelectorAll(".prefs-section")]
      .find((node) => node.textContent.trim() === "LaTeX")?.click();
    await new Promise((r) => setTimeout(r, 400));
    const row = [...document.querySelectorAll(".prefs-row")].find((node) =>
      /Enable bundled TeX/i.test(node.querySelector(".prefs-label")?.textContent ?? ""));
    const box = row?.querySelector("input[type=checkbox]");
    if (box && !box.checked) box.click();
    await new Promise((r) => setTimeout(r, 1500));
    open?.click();
    return "enabled";
  })()`);
};

/** Sample the isolated app and descendants without instrumenting their renderers. */
function tabProbeProcesses() {
  const pid = Number(process.env.MDRAFT_TEST_PID);
  if (process.platform !== "win32" || !pid) return null;
  const query =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime,WorkingSetSize | ConvertTo-Json -Compress";
  try {
    const rows = JSON.parse(
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", query], {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
    const tree = [pid];
    for (const id of tree) {
      for (const child of rows)
        if (child.ParentProcessId === id && !tree.includes(child.ProcessId)) {
          tree.push(child.ProcessId);
        }
    }
    const processes = rows.filter((row) => tree.includes(row.ProcessId));
    return {
      cpuSeconds:
        processes.reduce(
          (sum, row) => sum + Number(row.KernelModeTime) + Number(row.UserModeTime),
          0,
        ) / 1e7,
      workingSetMiB: Math.round(
        processes.reduce((sum, row) => sum + Number(row.WorkingSetSize), 0) / 1048576,
      ),
    };
  } catch {
    return null;
  }
}

/** Exercise cache ownership independently of the large font/image fixture. */
async function tabCacheProbe() {
  const base = mkdtempSync(join(tmpdir(), "latex-tab-cache-"));
  const sub = join(base, "book");
  mkdirSync(sub);
  const source = (text) =>
    "\\documentclass{article}\n\\begin{document}\n" + text + "\n\\end{document}\n";
  const book = join(sub, "cache-book.tex");
  const parent = join(base, "cache-parent.tex");
  const bookPages = 299;
  // Separate main documents, with the book reachable from the parent's manifest.
  writeFileSync(
    book,
    source(Array.from({ length: bookPages }, (_, i) => `Book page ${i + 1}`).join("\n\\newpage\n")),
  );
  writeFileSync(parent, source("Parent document."));
  const paths = process.env.MDRAFT_LATEX_TAB_PROBE_FILES
    ? JSON.parse(process.env.MDRAFT_LATEX_TAB_PROBE_FILES)
    : [book, parent];
  const [bookName, parentName] = paths.map((file) => basename(file));
  const counts = () =>
    evaluate(`JSON.stringify({
    mounts: Number(document.getElementById("preview").dataset.texpressoSession || 0),
    work: window.__tabProbe.work,
  })`).then(JSON.parse);
  const current = `document.querySelector(".compiled-save-pdf")?.disabled === false &&
    Boolean(document.querySelector("#preview")?.dataset.latexCurrent)`;
  const field = `document.querySelector(".compiled-page-field")`;
  const names = `document.querySelector('.doc-tab[aria-selected="true"] .doc-tab-name')?.textContent`;
  const selected = (name) => `${names} === ${JSON.stringify(name)}`;
  const requireReady = async (condition, label, timeout = 120_000) => {
    if (!(await waitFor(condition, timeout, label))) throw Error(label);
  };
  async function open(absolute, name) {
    await evaluate(
      `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "open-files", payload: ${JSON.stringify([absolute])} })`,
    );
    await requireReady(selected(name), `open ${name}`, 20_000);
    await requireReady(current, `current PDF for ${name}`);
  }
  async function click(name, ready = current) {
    const xy = await evaluate(`(() => {
      const label = [...document.querySelectorAll(".doc-tab-name")].find(n => n.textContent === ${JSON.stringify(name)});
      label.scrollIntoView({block:"nearest",inline:"nearest"});
      const r = label.getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`);
    const start = performance.now();
    await page.send("Input.dispatchMouseEvent", {
      ...xy,
      type: "mousePressed",
      button: "left",
      clickCount: 1,
    });
    await page.send("Input.dispatchMouseEvent", {
      ...xy,
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
    });
    await requireReady(selected(name), `switch to ${name}`, 5_000);
    const tabMs = performance.now() - start;
    await requireReady(ready, `read ${name}`, 5_000);
    return [Math.round(tabMs), Math.round(performance.now() - start)];
  }
  await requireReady('Boolean(document.querySelector(".cm-content"))', "editor at startup", 30_000);
  if (!(await invoke("latex_engine_status")).previewInstalled) await invoke("install_texpresso");
  await enableAndCompile();
  await evaluate(`(() => {
    const probe = window.__tabProbe = {work:0, titles:[], long:[], snapshots:[]};
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) if (/^mdraft:latex:(texpresso-project-sync|typeset-start)$/.test(e.name)) probe.work++;
    }).observe({type:"mark"});
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        if (e.name === "mdraft:latex:window-title") probe.titles.push(Math.round(e.duration));
        if (e.name === "mdraft:latex:snapshot-ipc") probe.snapshots.push(Math.round(e.duration));
      }
    }).observe({type:"measure"});
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) probe.long.push(Math.round(e.duration));
    }).observe({type:"longtask"});
  })()`);
  await open(paths[0], bookName);
  // The PDF export and the frame's page count arrive independently.
  const pageTotal =
    'Number(document.querySelector(".compiled-page-total")?.textContent.match(/[0-9]+/)?.[0])';
  await requireReady(`${pageTotal} > 0`, "the book's page count");
  if (!process.env.MDRAFT_LATEX_TAB_PROBE_FILES) {
    await requireReady(`${pageTotal} === ${bookPages}`, "the full book's page count");
    const bookFrame = await openPage(port, { type: "iframe", match: /mdraft-tex\.localhost/ });
    const reportPages = (pages) =>
      bookFrame.evaluate(`parent.postMessage({v:1,type:"pages",pages:${pages}},
        new URLSearchParams(location.search).get("host"))`);
    try {
      const before = await counts();
      // Send the provisional and final totals from the frame with a tab switch
      // between them, independent of typesetting speed.
      await reportPages(bookPages - 1);
      await requireReady(`${pageTotal} === ${bookPages - 1}`, "the provisional total", 5_000);
      const note = join(base, "cache-note.md");
      writeFileSync(note, "A Markdown tab.\n");
      await invoke("plugin:event|emit", { event: "open-files", payload: [note] });
      await requireReady(
        `${selected(basename(note))} && document.querySelector(".texpresso-host")?.hidden`,
        "the Markdown tab to hide the book frame",
        5_000,
      );
      await evaluate(`(() => {
        const source = document.querySelector(".texpresso-frame").contentWindow;
        function receive(event) {
          if (event.source !== source || event.data?.type !== "pages" || event.data.pages !== ${bookPages}) return;
          window.removeEventListener("message", receive);
          window.__tabProbe.latePages = event.data.pages;
        }
        window.addEventListener("message", receive);
      })()`);
      await reportPages(bookPages);
      await requireReady(
        `window.__tabProbe.latePages === ${bookPages}`,
        "the hidden page report",
        5_000,
      );
      await click(bookName, `${current} && document.querySelector(".app.latex-texpresso")`);
      const total = await evaluate(pageTotal);
      check(
        (await counts()).mounts === before.mounts && total === bookPages,
        "an unchanged live frame restores the count it reported while hidden",
        `${total} of ${bookPages}`,
      );

      const line = "Book page 40";
      await editor(`
        const head = view.state.doc.toString().indexOf(${JSON.stringify(line)}) + ${line.length};
        view.dispatch({ selection: { anchor: head } });
        view.scrollDOM.scrollTop = view.lineBlockAt(head).top - 100;
      `);
      await requireReady(
        `document.querySelector(".cm-content").textContent.includes(${JSON.stringify(line)})`,
        "the later line in the editor viewport",
        5_000,
      );
      await editor(`view.contentDOM.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));`);
      await sleep(250);
      const scrollTop = () => bookFrame.evaluate('document.getElementById("pages").scrollTop');
      const alignedTop = await scrollTop();
      check(
        alignedTop > 1000,
        "the editor aligns the live preview on a later page",
        `${alignedTop}`,
      );
      check((await evaluate(`Number(${field}.value)`)) > 1, "the page field follows the preview");
      const stillAligned = async () =>
        (await evaluate(
          `Boolean(document.querySelector(".app.latex-texpresso.texpresso-painted"))`,
        )) &&
        (await counts()).mounts === before.mounts &&
        Math.abs((await scrollTop()) - alignedTop) < 2;

      const token = await dataset("latexCurrent");
      // Two real edit transactions return the buffer to an already cached PDF.
      await editor(`
        const from = view.state.selection.main.head;
        view.dispatch({ changes: { from, insert: "!" } });
        view.dispatch({ changes: { from, to: from + 1 } });
      `);
      await requireReady(
        `${current} && document.querySelector("#preview").dataset.latexCurrent !== ${JSON.stringify(token)}`,
        "the cached PDF for the restored text",
      );
      const kept = await stillAligned();
      check(kept, "a cached PDF leaves the live preview at the aligned position");
      if (!kept) return;

      const insert = (text) =>
        editor(`
        const from = view.state.selection.main.head;
        view.dispatch({ changes: { from, insert: ${JSON.stringify(text)} }, selection: { anchor: from + ${text.length} } });
      `);
      await insert(" saved text");
      await emitMenu(page, "file.save");
      await requireReady(
        `${current} && !document.querySelector('.doc-tab[aria-selected="true"]').classList.contains("is-dirty")`,
        "the edit to be saved and its PDF ready",
      );
      check(
        readFileSync(book, "utf8").includes(`${line} saved text`) && (await stillAligned()),
        "saving the edit and preparing its PDF keep the preview aligned",
      );

      const paint = Number(await dataset("texpressoPainted"));
      await insert(" and more typing");
      await requireReady(
        `${current} && Number(document.querySelector("#preview").dataset.texpressoPainted) > ${paint}`,
        "a live repaint after continuing to type",
      );
      check(
        (await stillAligned()) &&
          (await bookFrame.evaluate(
            'texpresso.editor.state.doc.toString().includes("saved text and more typing")',
          )),
        "typing after Save updates the same live preview at the aligned position",
      );
    } finally {
      bookFrame.close();
    }
  }
  // Capture the same bytes the Print menu would send. The stub keeps the test
  // inside the staged WebView and never opens a print dialog.
  await evaluate(`(() => {
    const fetch = window.fetch;
    window.fetch = async function (input, options) {
      const url = new URL(typeof input === "string" ? input : input.url, location.href);
      if (url.hostname === "ipc.localhost" && url.pathname === "/print_compiled_pdf") {
        const { data } = JSON.parse(options.body);
        const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
        window.__tabPrintHash = Array.from(new Uint8Array(hash)).join(",");
        return new Response(JSON.stringify("isolated-test.pdf"), {
          headers: { "Content-Type": "application/json", "Tauri-Response": "ok" },
        });
      }
      return fetch.call(window, input, options);
    };
  })()`);
  async function printHash() {
    await evaluate("window.__tabPrintHash = null");
    await emitMenu(page, "file.print");
    await requireReady("Boolean(window.__tabPrintHash)", "the current PDF bytes", 5_000);
    return evaluate("window.__tabPrintHash");
  }
  const problemText = () =>
    evaluate(`document.getElementById("compiler-problems")?.textContent ?? ""`);
  const expectedProblems = await problemText();
  const pdfHash = process.platform === "win32" ? await printHash() : null;
  const readingPage = Math.max(1, (await evaluate(pageTotal)) - 1);
  await evaluate(`(() => {
    const input = ${field};
    input.value = "${readingPage}";
    input.dispatchEvent(new Event("input", {bubbles:true}));
    input.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter",bubbles:true}));
  })()`);
  await requireReady(`${field}?.value === "${readingPage}"`, "the original reading page", 5_000);
  await open(paths[1], parentName);
  const before = await counts();
  const bookReady = `${current} && ${field}?.value === "${readingPage}" &&
    document.querySelectorAll("#preview .typst-page").length > 0`;
  const initialCounters = tabProbeProcesses();
  const first = await click(bookName, bookReady);
  if (initialCounters) await sleep(Math.max(0, 10_000 - first[1]));
  const settledCounters = tabProbeProcesses();
  if (pdfHash)
    check((await printHash()) === pdfHash, "cached return exposes the identical printable PDF");
  check(
    (await problemText()) === expectedProblems,
    "cached return restores the same compiler diagnostics",
  );
  await click(parentName);
  await evaluate(`Object.assign(window.__tabProbe,{titles:[],long:[],snapshots:[]})`);
  const metricsEnabled = process.env.MDRAFT_TEST_PID && process.platform === "win32";
  const metrics = async () => {
    if (!metricsEnabled) return {};
    const response = await page.send("Performance.getMetrics");
    return Object.fromEntries(
      response.result.metrics
        .filter(({ name }) =>
          /^(LayoutDuration|RecalcStyleDuration|ScriptDuration|TaskDuration)$/.test(name),
        )
        .map(({ name, value }) => [name, value]),
    );
  };
  if (metricsEnabled) await page.send("Performance.enable");
  const startMetrics = await metrics();
  const times = [];
  for (let pass = 0; pass < 10; pass++) {
    times.push(await click(bookName, bookReady), await click(parentName));
  }
  const finalMetrics = await metrics();
  const after = await counts();
  check(
    after.mounts === before.mounts && after.work === before.work,
    "twenty warm switches start no frame, project sync or PDF export",
    JSON.stringify({ before, after }),
  );
  const p95 = (values) => values.sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
  console.log(
    "TAB_CACHE_TIMINGS",
    JSON.stringify({
      firstMs: first,
      readingPage,
      tenSecondCpu:
        initialCounters && settledCounters
          ? Number((settledCounters.cpuSeconds - initialCounters.cpuSeconds).toFixed(2))
          : null,
      workingSetMiB: [initialCounters?.workingSetMiB, settledCounters?.workingSetMiB],
      tabP95Ms: p95(times.map((row) => row[0])),
      previewP95Ms: p95(times.map((row) => row[1])),
      browser: await evaluate("JSON.stringify(window.__tabProbe)").then(JSON.parse),
      rendererMs: Object.fromEntries(
        Object.entries(finalMetrics).map(([key, value]) => [
          key,
          Math.round((value - startMetrics[key]) * 1000),
        ]),
      ),
    }),
  );
  const auto = 'document.querySelector(".compiled-toolbar input[type=checkbox]")';
  await evaluate(`${auto}.click()`);
  await click(bookName, bookReady);
  check((await counts()).mounts === before.mounts, "manual mode restores the correct book PDF");
  await evaluate(`${auto}.click()`);
  if (!process.env.MDRAFT_LATEX_TAB_PROBE_FILES) {
    await editor('view.dispatch({changes:{from:view.state.doc.length, insert:"\\n% edited\\n"}})');
    await requireReady(
      `document.getElementById("preview").dataset.texpressoSession === "${before.mounts + 1}"`,
      "the edited book to start a frame",
      10_000,
    );
    await click(parentName);
    check(
      await evaluate(`Boolean(${selected(parentName)} && ${current})`),
      "a second click can leave the edited book during compilation",
    );
    await click(bookName, "true");
    const ready = await waitFor(
      `${current} && document.querySelector(".app.latex-texpresso") &&
      ${field}?.value === "${readingPage}"`,
      120_000,
      "the live book to restore its reading page",
    );
    let visible = false;
    if (ready) {
      const liveBook = await openPage(port, { type: "iframe", match: /mdraft-tex\.localhost/ });
      try {
        // A viewport write queued during startup can arrive after the jump.
        await sleep(300);
        visible = await liveBook.evaluate(`(() => {
          const pages = document.getElementById("pages");
          const viewport = pages.getBoundingClientRect();
          const page = pages.querySelectorAll(".page")[${readingPage - 1}]?.getBoundingClientRect();
          return Boolean(page && page.top < viewport.bottom && page.bottom > viewport.top);
        })()`);
      } finally {
        liveBook.close();
      }
    }
    check(visible, "the edited book hands back to live rendering at the same page");
  }
}

async function fullSuite() {
  console.log("=== the backend switch mounts its own frame ===");

  await waitFor(`Boolean(document.querySelector(".cm-content"))`, 30_000, "the editor");
  // A local TEXMF library is reader state that outlives the profile reset, and
  // the backend falls back visibly when one is registered (the plan's answer to
  // open question 4). This layer asserts the no-library path; the fallback has
  // its own check, so clear the roots the way Preferences does.
  const libraries = await invoke("latex_texmf_list");
  for (const root of libraries?.roots ?? []) {
    await evaluate(
      `window.__TAURI_INTERNALS__.invoke("latex_texmf_configure", { action: { type: "remove", id: ${JSON.stringify(root.id)} } })`,
    );
  }
  // Every text the compiled status line shows from here on, with its time. The
  // first export used to be asked before the frame had typeset a page; the
  // failure it left is only visible as a status the line once held.
  await evaluate(`(() => {
    const label = document.querySelector(".compiled-state-label");
    const box = label?.parentElement?.parentElement;
    window.__mdraftStatusLog = [];
    if (!box) return false;
    const read = () => {
      const text = [...box.querySelectorAll(".compiled-state-label, .compiled-state-detail")]
        .map((node) => node.textContent).filter(Boolean).join(" · ");
      const log = window.__mdraftStatusLog;
      if (log.length < 400 && log.at(-1)?.text !== text)
        log.push({ at: Math.round(performance.now()), text });
    };
    new MutationObserver(read).observe(box, { childList: true, characterData: true, subtree: true });
    read();
    return true;
  })()`);
  const statusLog = () =>
    evaluate(`JSON.stringify(window.__mdraftStatusLog ?? [])`).then(JSON.parse);
  // Every state of the waiting surface, with the paint count at that moment:
  // a cold frame owns the pane for minutes before its first page, and the
  // surface is the only thing that says so in the pane itself.
  await evaluate(`(() => {
    const pane = document.getElementById("preview-pane");
    window.__mdraftWaitLog = [];
    if (!pane) return false;
    const read = () => {
      const node = pane.querySelector(":scope > .preview-pending");
      const text = node
        ? [node.dataset.state, getComputedStyle(node).display,
           node.querySelector(".preview-pending-phase")?.textContent ?? ""].join("|")
        : "none";
      const log = window.__mdraftWaitLog;
      if (log.length < 400 && log.at(-1)?.text !== text)
        log.push({ at: Math.round(performance.now()), text,
          painted: document.querySelector("#preview")?.dataset.texpressoPainted ?? "" });
    };
    new MutationObserver(read).observe(pane, {
      childList: true, characterData: true, subtree: true,
      attributes: true, attributeFilter: ["data-state"],
    });
    read();
    return true;
  })()`);
  const waitLog = () => evaluate(`JSON.stringify(window.__mdraftWaitLog ?? [])`).then(JSON.parse);
  const shownWaits = (log) => log.filter((entry) => /^pending\|(?!none)/.test(entry.text));

  if (!(await invoke("latex_engine_status")).previewInstalled) {
    console.log("installing the preview engine from the local origin…");
    await evaluate("window.__TAURI_INTERNALS__.invoke('install_texpresso')");
  }
  check(
    (await invoke("latex_engine_status")).previewInstalled === true,
    "the preview engine and digest table are installed",
  );
  await enableAndCompile();
  if (!(await findFrame())) await emitMenu(page, "view.latexCompile");
  const booted = await waitFor(
    `document.querySelector("#preview")?.dataset.texpressoReady === "1"`,
    120_000,
    "the TeXpresso frame",
  );
  const target = booted ? await attachFrame() : null;
  check(booted, "the frame boots under the mdraft-tex origin");
  if (!target) throw new Error("the first TeXpresso frame did not boot");
  check(
    Boolean(target) && target.type === "iframe",
    "the frame is its own target on its own origin",
    target?.url ?? "no target",
  );
  check((await dataset("latexBackend")) === "texpresso", "the pane says which backend draws");
  const chip = await evaluate(
    `JSON.stringify((() => { const c = document.getElementById("status-latex-engine"); return { text: c.textContent, title: c.title, backend: c.dataset.previewBackend }; })())`,
  ).then(JSON.parse);
  check(
    chip.text === "XeLaTeX" && chip.backend === "texpresso",
    "the engine chip names the engine, not the backend",
    JSON.stringify(chip),
  );

  check(
    await waitFor(
      `document.querySelector("#preview")?.dataset.texpressoPainted ?? ""`,
      360_000,
      "the first paint",
    ),
    "the project typesets and reports a paint",
    await frame
      .evaluate(`document.documentElement.dataset.mdraftTrace ?? "(no trace)"`)
      .catch(() => "(no trace)"),
  );
  const bootWaits = await waitLog();
  const bootShown = shownWaits(bootWaits);
  const bootSummary = bootWaits.map((entry) => `${entry.at} ${entry.text}`).join(" | ");
  check(
    bootShown.length > 0,
    "the pane shows the waiting surface while the frame has no page",
    bootSummary,
  );
  check(
    bootWaits.every((entry) => !/export/i.test(entry.text)),
    "the waiting surface names the frame's work, never the export step",
    bootSummary,
  );
  check(
    await waitFor(
      `!document.querySelector("#preview-pane > .preview-pending") && Number(document.querySelector("#preview")?.dataset.texpressoPages ?? "0") > 0`,
      10_000,
      "the surface to leave once a page is drawn",
    ),
    "the frame's first page removes the waiting surface",
  );

  const paths = await frameEval(
    `JSON.stringify(globalThis.texpresso?.project?.paths?.() ?? [])`,
  ).then(JSON.parse);
  check(
    paths.includes("main.tex") &&
      paths.filter((path) => path.startsWith("chapters/")).length >= 10 &&
      !paths.includes("readme.md"),
    "the frame holds MDraft's project, not an example",
    `${paths.length} files`,
  );

  console.log("=== the shadow compile is the authority ===");
  const shadow = await waitFor(
    `(() => {
      const shadow = Number(document.querySelector("#preview")?.dataset.latexShadow ?? "0");
      const shown = Number(document.querySelector("#preview")?.dataset.latexShown ?? "0");
      return shadow > 0 && shadow >= shown && document.querySelector("#preview")?.dataset.latexCurrent;
    })()`,
    300_000,
    "the shadow compile",
  );
  check(shadow, "the idle shadow compile fills the PDF export reads");
  // No Compile was pressed: the first export must
  // have waited for the frame instead of failing and staying failed.
  const statuses = await statusLog();
  const failedExport = statuses.filter((entry) => /could not be produced/.test(entry.text));
  const frameErrors = await evaluate(
    `JSON.stringify(performance.getEntriesByName("mdraft:latex:texpresso-error").map((entry) => entry.detail))`,
  ).then(JSON.parse);
  check(
    statuses.length > 0 && failedExport.length === 0 && frameErrors.length === 0,
    "the first export waits for the frame instead of reporting a failure",
    `${statuses.map((entry) => `${entry.at} ${entry.text}`).join(" | ")} || errors: ${JSON.stringify(frameErrors)} || frame: ${await frameEval(
      `document.documentElement.dataset.mdraftTrace ?? "(no trace)"`,
    ).catch(() => "(no trace)")}`,
  );
  console.log("=== the page total follows the whole document ===");
  // The first paint is reported once the canvas count holds still briefly; a
  // long document keeps typesetting after that pause, and the toolbar's total
  // must follow it to the end instead of freezing at the first pause.
  const typesetDeadline = performance.now() + 180_000;
  while (
    performance.now() < typesetDeadline &&
    (await frameEval(`document.getElementById("status")?.classList.contains("busy") ?? false`))
  )
    await sleep(500);
  await sleep(1500);
  const pageTotals = {
    frame: await frameEval(`document.querySelectorAll("#pages .page").length`),
    host: await evaluate(
      `Number(document.querySelector("#preview")?.dataset.texpressoPages ?? "0")`,
    ),
    strip: await evaluate(`document.querySelector(".compiled-page-total")?.textContent ?? ""`),
  };
  check(
    pageTotals.frame > 1 &&
      pageTotals.host === pageTotals.frame &&
      pageTotals.strip.includes(String(pageTotals.frame)),
    "the page total is the frame's page count once typesetting ends",
    JSON.stringify(pageTotals),
  );
  // The stored PDF is the reader's document: a fresh export of the idle frame
  // has the same pages and the same text.
  await emitMenu(page, "view.latexTexpressoExport");
  const firstExport = await waitFor(
    `Boolean(document.querySelector("#preview")?.dataset.texpressoExport)`,
    120_000,
    "the first export comparison",
  ).then(async (done) => (done ? JSON.parse(await dataset("texpressoExport")) : null));
  await evaluate(`delete document.querySelector("#preview").dataset.texpressoExport`);
  check(
    firstExport?.compared === true &&
      firstExport.identicalText === true &&
      firstExport.pages?.[0] >= 10,
    "the first stored PDF is the document the frame typeset",
    JSON.stringify(firstExport),
  );
  const menu = await invoke("menu_items");
  check(
    ["export.pdf", "file.print"].every(
      (id) => menu.find((item) => item.id === id)?.enabled === true,
    ) && (await evaluate(`document.querySelector(".compiled-save-pdf")?.disabled`)) === false,
    "the first shadow enables PDF export, Save PDF and Print",
  );
  check(
    (await evaluate(`document.querySelectorAll(".typst-page").length`)) === 0,
    "the shadow PDF is never drawn over the frame",
  );

  console.log("=== an edit repaints on the frame's own path ===");
  await openFile("samples/latex-perf/book/chapters/ch06.tex");
  // The hidden editor must hold the file the reader is editing, or a caret
  // probe would measure the wrong text.
  const openName = await frameEval(`document.getElementById("file-title")?.textContent ?? ""`);
  check(
    openName.split("/").pop() === "ch06.tex",
    "the frame opens the file the reader edits",
    openName,
  );

  const beforePaint = Number((await dataset("texpressoPainted")) ?? "0");
  await editor(`
    const at = view.state.doc.length;
    view.dispatch({ changes: { from: at, insert: "\\n% texpresso edit probe\\n" } });
  `);
  const repainted = await waitFor(
    `Number(document.querySelector("#preview")?.dataset.texpressoPainted ?? "0") > ${beforePaint}`,
    60_000,
    "a painted edit",
  );
  check(
    repainted,
    "a keystroke repaints without waiting for a compile",
    await frameEval(`document.documentElement.dataset.mdraftTrace ?? "(no trace)"`),
  );
  const e2p = Number((await dataset("texpressoE2p")) ?? "0");
  check(
    Number.isFinite(e2p) && e2p > 0 && e2p < 10_000,
    "the edit-to-paint time is measured",
    `${e2p} ms`,
  );
  const hostText = await editorDoc();
  const frameText = await frameEval(`globalThis.texpresso.editor.state.doc.toString()`);
  check(
    hostText === frameText,
    "the engine's copy equals the reader's buffer, character for character",
    `${hostText.length} against ${frameText.length} characters`,
  );

  console.log("=== correspondence follows the PDF conventions ===");
  // Prose the chapter really typesets, so the source map has an answer.
  const prose = await editor(`
    for (let n = 6; n <= view.state.doc.lines; n += 1) {
      const text = view.state.doc.line(n).text;
      const at = text.search(/[A-Za-z]{6,}/);
      const trimmed = text.trimStart();
      if (at >= 0 && !trimmed.startsWith("%") && !trimmed.startsWith("\\\\")) {
        return { line: n, at };
      }
    }
    return null;
  `);
  await editor(`
    const line = view.state.doc.line(${prose?.line ?? 1});
    const from = line.from + ${prose?.at ?? 0};
    view.dispatch({ selection: { anchor: from, head: from + 8 } });
  `);
  const selectionPainted = await waitFor(
    `(async () => {
      const frame = document.querySelector(".texpresso-frame");
      return frame !== null;
    })() && true`,
    1,
    "noop",
  );
  void selectionPainted;
  let marks = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    marks = await frameEval(
      `JSON.stringify((() => {
        const box = document.querySelector("#pages .cursor-mark.selection");
        return {
          count: document.querySelectorAll("#pages .cursor-mark.selection").length,
          background: box ? getComputedStyle(box).backgroundColor : null,
          caretVisible: [...document.querySelectorAll("#pages .cursor-mark.caret")]
            .some((node) => getComputedStyle(node).display !== "none"),
          trace: document.documentElement.dataset.mdraftTrace ?? "",
        };
      })())`,
    ).then(JSON.parse);
    if (marks.count > 0) break;
    await sleep(500);
  }
  check(marks.count > 0, "a source selection paints boxes in the frame", JSON.stringify(marks));
  const syncColour = await frameEval(
    `getComputedStyle(document.documentElement).getPropertyValue("--mdraft-sync").trim()`,
  );
  check(
    Boolean(syncColour) && Boolean(marks.background) && marks.background !== "rgba(0, 0, 0, 0)",
    "the marks use MDraft's colour",
    `${syncColour} / ${marks.background}`,
  );
  check(!marks.caretVisible, "the engine's own caret mark stays hidden");

  const scrollBeforeCaret = await frameEval(`document.getElementById("pages")?.scrollTop ?? 0`);
  await editor(`
    const line = view.state.doc.line(${prose?.line ?? 1});
    view.dispatch({ selection: { anchor: line.from } });
  `);
  await sleep(1200);
  const afterCaret = await frameEval(
    `JSON.stringify({
      count: document.querySelectorAll("#pages .cursor-mark.selection").length,
      scrollTop: document.getElementById("pages")?.scrollTop ?? 0,
    })`,
  ).then(JSON.parse);
  check(afterCaret.count === 0, "a caret move paints nothing", JSON.stringify(afterCaret));
  check(
    afterCaret.scrollTop === scrollBeforeCaret,
    "a caret move scrolls nothing",
    `${scrollBeforeCaret} -> ${afterCaret.scrollTop}`,
  );

  console.log("=== a click in the preview marks the source ===");
  // The caret test above cleared the mark, and the engine only paints a
  // selection for text it has typeset. Try prose lines in order until the frame
  // reports marks>0 in its trace; clicking a page the engine has no mark for
  // would answer another file and prove nothing.
  const selectForMark = async () => {
    const candidates = await editor(`
      const out = [];
      for (let n = 2; n <= view.state.doc.lines; n += 1) {
        const text = view.state.doc.line(n).text;
        const trimmed = text.trimStart();
        if (trimmed.startsWith("%") || trimmed.startsWith("\\\\") || trimmed.length < 40) continue;
        const at = text.search(/[A-Za-z]{6,}/);
        if (at >= 0) out.push({ line: n, at, length: Math.min(24, text.length - at) });
        if (out.length >= 8) break;
      }
      return out;
    `);
    for (const candidate of candidates ?? []) {
      const before = await traceSelectMarks();
      await editor(`
        const line = view.state.doc.line(${candidate.line});
        view.dispatch({ selection: { anchor: line.from + ${candidate.at}, head: line.from + ${candidate.at} + ${candidate.length} } });
      `);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const now = await traceSelectMarks();
        if (now !== before && now > 0) return candidate;
        if (now !== before) break;
        await sleep(150);
      }
    }
    return null;
  };
  const traceSelectMarks = async () => {
    const trace = await frameEval(`document.documentElement.dataset.mdraftTrace ?? ""`);
    const matches = [...trace.matchAll(/select marks=(\d+)/g)];
    return matches.length ? Number(matches.at(-1)[1]) : -1;
  };
  const clickable = await selectForMark();
  if (!clickable) {
    console.log(
      "SKIP: the engine painted no selection mark for any prose line, so the click cannot be aimed at the active file.",
    );
  }
  // The click must make its own mark; the selection above is the target text.
  const decorationsBefore = await editor(
    `return document.querySelectorAll(".cm-sync-word").length;`,
  );
  const caretBefore = await editor(
    `const s = view.state.selection.main; return { anchor: s.anchor, head: s.head };`,
  );
  let clicked = Boolean(clickable);
  if (clickable) {
    await frameEval(
      `(() => {
        const mark = document.querySelector("#pages .cursor-mark.selection");
        mark?.scrollIntoView({ block: "center" });
        return Boolean(mark);
      })()`,
    );
    await sleep(400);
  }
  const box = await frameEval(
    `JSON.stringify((() => {
      const pages = document.getElementById("pages");
      const pagesRect = pages.getBoundingClientRect();
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      // The click must land where the reader sees the active file's text: the
      // engine's selection mark is that spot. It is positioned over #pages, not
      // inside a .page, so clicking page 1 would answer main.tex instead.
      const mark = document.querySelector("#pages .cursor-mark.selection");
      mark?.scrollIntoView({ block: "center" });
      const rect = mark?.getBoundingClientRect();
      return {
        x: clamp(rect ? rect.left + rect.width / 2 : pagesRect.left + pagesRect.width / 2,
          pagesRect.left + 20, pagesRect.right - 20),
        y: clamp(rect ? rect.top + rect.height / 2 : pagesRect.top + pagesRect.height / 2,
          pagesRect.top + 20, pagesRect.bottom - 20),
        hasMark: Boolean(mark),
        markTop: rect ? Math.round(rect.top) : null,
      };
    })())`,
  ).then(JSON.parse);
  await sleep(300);
  box.insidePages = await frameEval(
    `Boolean(document.elementFromPoint(${box.x}, ${box.y})?.closest("#pages"))`,
  );
  // Frame-local coordinates on the frame's own session: a point sent to the
  // host page could land in the editor if the pane layout differs.
  const traceSources = async () =>
    (await frameEval(`document.documentElement.dataset.mdraftTrace ?? ""`))
      .split("|")
      .filter((line) => line.includes(" source ")).length;
  const sourcesBefore = await traceSources();
  await frame.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: box.x,
    y: box.y,
    button: "left",
    buttons: 1,
    pointerType: "mouse",
    clickCount: 1,
  });
  await frame.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: box.x,
    y: box.y,
    button: "left",
    buttons: 0,
    pointerType: "mouse",
    clickCount: 1,
  });
  let sources = sourcesBefore;
  const clickDeadline = Date.now() + 8_000;
  while (Date.now() < clickDeadline) {
    sources = await traceSources();
    if (sources > sourcesBefore) break;
    await sleep(250);
  }
  if (sources <= sourcesBefore) {
    // The frame target may not receive a synthesised pointer press; the page
    // target routes it into the child frame. Try that before giving up.
    const frameRect = await evaluate(
      `JSON.stringify((() => { const r = document.querySelector(".texpresso-frame").getBoundingClientRect(); return { x: r.left, y: r.top }; })())`,
    ).then(JSON.parse);
    await page.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: frameRect.x + box.x,
      y: frameRect.y + box.y,
      button: "left",
      buttons: 1,
      pointerType: "mouse",
      clickCount: 1,
    });
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: frameRect.x + box.x,
      y: frameRect.y + box.y,
      button: "left",
      buttons: 0,
      pointerType: "mouse",
      clickCount: 1,
    });
    const retryDeadline = Date.now() + 8_000;
    while (Date.now() < retryDeadline) {
      sources = await traceSources();
      if (sources > sourcesBefore) break;
      await sleep(250);
    }
  }
  if (sources <= sourcesBefore) {
    console.log(
      "SKIP: the engine posted no source-map answer for a CDP-synthesised click, " +
        "so the click and double-click conventions are not asserted here; " +
        "they need a real pointer press (recorded in the plan's known limits).",
    );
    clicked = false;
  }
  await sleep(400);
  const afterClick = await editor(
    `const s = view.state.selection.main;
     return { anchor: s.anchor, head: s.head, decorations: document.querySelectorAll(".cm-sync-word").length };`,
  );
  if (clicked) {
    check(
      afterClick.decorations > decorationsBefore,
      "a click in the preview marks the source",
      `${JSON.stringify(afterClick)} source ${await dataset("texpressoSource")} drop ${await evaluate(
        `document.documentElement.dataset.texpressoDrop ?? "none"`,
      )} point ${JSON.stringify(box)} trace ${await frameEval(
        `document.documentElement.dataset.mdraftTrace ?? ""`,
      )}`,
    );
    // The click was aimed at the centre of the mark of the selected source
    // text, so a verified answer is a caret inside that text, and the mark is
    // the caret's own source line.
    const answer = JSON.parse((await dataset("texpressoSource")) ?? "null");
    const expected = await editor(
      `const line = view.state.doc.line(${clickable.line});
       const at = view.state.doc.lineAt(view.state.selection.main.head);
       return { from: line.from + ${clickable.at}, to: line.from + ${clickable.at} + ${clickable.length},
         lineFrom: at.from, lineTo: at.to };`,
    );
    check(
      answer?.precision === "exact" && answer.unit === "line",
      "the frame verifies the click against the clicked point",
      `${JSON.stringify(answer)} trace ${await frameEval(
        `document.documentElement.dataset.mdraftTrace ?? ""`,
      )}`,
    );
    check(
      afterClick.anchor === afterClick.head &&
        afterClick.head >= expected.from &&
        afterClick.head <= expected.to,
      "a click in the preview puts the caret in the clicked text",
      `${JSON.stringify(afterClick)} expected ${JSON.stringify(expected)}`,
    );
    check(
      answer?.range &&
        answer.range.from >= expected.lineFrom &&
        answer.range.to <= expected.lineTo &&
        answer.range.to > answer.range.from,
      "a click in the preview marks the caret's source line, not the paragraph",
      `${JSON.stringify(answer?.range)} line ${JSON.stringify(expected)}`,
    );
    // Gesture alignment (docs/architecture.md): the
    // clicked line's source comes to the clicked height. The engine's map is by
    // line, so the bound is one source row, not a pixel; at the start or end of
    // the editor's range the row only has to be in view.
    const answered = JSON.parse((await dataset("texpressoSource")) ?? "null");
    const level = await editor(
      `const from = Math.min(${Number(answered?.from) || 0}, view.state.doc.length);
       const r = view.coordsAtPos(from);
       const s = view.scrollDOM;
       return r ? { y:(r.top+r.bottom)/2, row:r.bottom-r.top, top:s.scrollTop, max:s.scrollHeight-s.clientHeight } : null;`,
    );
    const clickedY =
      (await evaluate(`document.querySelector(".texpresso-frame").getBoundingClientRect().top`)) +
      box.y;
    check(
      level !== null &&
        (Math.abs(level.y - clickedY) <= level.row + 2 ||
          level.top <= 1 ||
          level.top >= level.max - 1),
      "a click in the preview brings its source line level, within one row",
      JSON.stringify({ clickedY, level }),
    );
  }

  console.log("=== scroll correspondence, both directions ===");
  const frameTop = await frameEval(`document.getElementById("pages")?.scrollTop ?? 0`);
  // A wheel gesture inside the frame, dispatched on the frame's own session so
  // the coordinates are frame-local.
  await frame.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: box.x,
    y: box.y,
    deltaX: 0,
    deltaY: 300,
  });
  await sleep(1200);
  const frameScrolled = await frameEval(`document.getElementById("pages")?.scrollTop ?? 0`);
  check(
    frameScrolled !== frameTop,
    "a wheel gesture scrolls the frame's own pages",
    `${frameTop} -> ${frameScrolled}`,
  );
  const editorAfterGesture = await editor(`return view.scrollDOM.scrollTop;`);
  if (clicked) {
    check(
      editorAfterGesture > 0,
      "the source follows the frame's gesture",
      `editor scrollTop ${editorAfterGesture} trace ${await frameEval(
        `document.documentElement.dataset.mdraftTrace ?? ""`,
      )}`,
    );
  } else {
    console.log(
      "SKIP: the source-follow assertion rides on the same source-map answer as the click.",
    );
  }

  const frameBeforeSource = await frameEval(`document.getElementById("pages")?.scrollTop ?? 0`);
  await editor(`
    view.scrollDOM.scrollTop = Math.min(
      view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight,
      view.scrollDOM.scrollTop + 600,
    );
    view.scrollDOM.dispatchEvent(new Event("scroll"));
  `);
  await sleep(1200);
  const frameAfterSource = await frameEval(`document.getElementById("pages")?.scrollTop ?? 0`);
  check(
    frameAfterSource !== frameBeforeSource,
    "scrolling the source moves the frame",
    `${frameBeforeSource} -> ${frameAfterSource}`,
  );

  console.log("=== zoom, themes and manual mode ===");
  // The page's own width, not `preview.mode`: the app stores a mode without
  // laying anything out, and a comparison that included it passed while the
  // pages never changed.
  const pageBox = () =>
    frameEval(
      `JSON.stringify({ mode: globalThis.texpresso?.preview?.mode, scale: globalThis.texpresso?.preview?.scale, w: document.querySelector("#pages .page")?.offsetWidth ?? 0 })`,
    ).then(JSON.parse);
  const scaleBefore = await pageBox();
  await emitMenu(page, "view.zoomIn");
  await sleep(1200);
  const scaleAfter = await pageBox();
  const grown = scaleBefore.w > 0 ? scaleAfter.w / scaleBefore.w : 0;
  check(
    Math.abs(grown - 1.1) <= 0.022,
    "document zoom at 110% makes the page 1.1 times as wide",
    `${JSON.stringify(scaleBefore)} -> ${JSON.stringify(scaleAfter)}`,
  );
  await emitMenu(page, "view.zoomReset");
  await sleep(1200);
  const scaleReset = await pageBox();
  check(
    Math.abs(scaleReset.w - scaleBefore.w) <= Math.max(2, scaleBefore.w * 0.01),
    "zoom reset returns the page to its fit width",
    `${JSON.stringify(scaleBefore)} -> ${JSON.stringify(scaleReset)}`,
  );

  await emitMenu(page, "themes.dark");
  await sleep(800);
  const dark = await frameEval(
    `JSON.stringify({
      theme: document.documentElement.dataset.theme,
      paper: document.documentElement.style.getPropertyValue("--mdraft-paper"),
      page: getComputedStyle(document.querySelector("#pages .page")).backgroundColor,
      canvas: document.querySelector("#pages .page canvas")
        ? getComputedStyle(document.querySelector("#pages .page canvas")).filter
        : null,
    })`,
  ).then(JSON.parse);
  check(
    dark.theme === "dark" && Boolean(dark.paper) && dark.canvas && dark.canvas !== "none",
    "the dark theme paints the paper the PDF viewer uses",
    JSON.stringify(dark),
  );
  await emitMenu(page, "themes.light");
  await sleep(800);
  const light = await frameEval(
    `JSON.stringify({
      theme: document.documentElement.dataset.theme,
      page: getComputedStyle(document.querySelector("#pages .page")).backgroundColor,
      canvas: document.querySelector("#pages .page canvas")
        ? getComputedStyle(document.querySelector("#pages .page canvas")).filter
        : null,
    })`,
  ).then(JSON.parse);
  check(
    light.theme === "light" && (light.canvas === "none" || !light.canvas),
    "the light theme removes the inverted page",
    JSON.stringify(light),
  );

  const paintsBeforeHold = Number((await dataset("texpressoPainted")) ?? "0");
  await emitMenu(page, "view.latexAutoCompile");
  await sleep(400);
  await editor(`
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\\n% held while manual\\n" } });
  `);
  await sleep(2500);
  const heldPaint = Number((await dataset("texpressoPainted")) ?? "0");
  check(
    heldPaint === paintsBeforeHold,
    "manual mode holds the edit stream",
    `${paintsBeforeHold} -> ${heldPaint}`,
  );
  await emitMenu(page, "view.latexCompile");
  check(
    await waitFor(
      `Number(document.querySelector("#preview")?.dataset.texpressoPainted ?? "0") > ${heldPaint}`,
      60_000,
      "the flushed edit",
    ),
    "Compile sends what manual mode held",
  );
  await emitMenu(page, "view.latexAutoCompile");
  await sleep(400);

  console.log("=== export uses the frame's own PDF ===");
  await waitFor(
    `(() => {
      const source = document.querySelector(".cm-content").cmTile.root.view;
      return source && document.querySelector("#preview")?.dataset.latexCurrent;
    })()`,
    300_000,
    "a current exported result",
  );
  await emitMenu(page, "view.latexTexpressoExport");
  const comparison = await waitFor(
    `Boolean(document.querySelector("#preview")?.dataset.texpressoExport)`,
    120_000,
    "the export comparison",
  ).then(async (done) => (done ? JSON.parse(await dataset("texpressoExport")) : null));
  check(
    comparison?.ok === true && comparison.pages?.[0] > 0,
    "TeXpresso's own export produces a PDF",
    comparison ? `${comparison.pages?.[0]} pages, ${comparison.ms} ms` : "no comparison",
  );

  console.log("=== privacy ===");
  const registrations = await frameEval(
    `(async () => navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : -1)()`,
  );
  check(
    registrations === 0 || registrations === -1,
    "the frame registers no service worker",
    String(registrations),
  );
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  check(
    !targets.some((entry) => entry.type === "service_worker"),
    "no service-worker target exists",
  );
  const offOrigin = await frameEval(
    `JSON.stringify(performance.getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((url) => !url.startsWith(location.origin)))`,
  ).then(JSON.parse);
  check(
    offOrigin.length === 0,
    "every request the frame made stayed on its own origin",
    offOrigin.slice(0, 3).join(", "),
  );

  console.log("=== a tab switch stays warm ===");
  const pathsBeforeSwitch = await frameEval(`globalThis.texpresso?.project?.paths?.().length ?? 0`);
  await openFile("samples/feature-tour.md");
  check(
    (await evaluate(
      `document.querySelector(".texpresso-frame")?.closest(".texpresso-host")?.hidden ?? null`,
    )) === true,
    "another document hides the frame instead of destroying it",
  );
  await emitMenu(page, "file.nextTab");
  await sleep(1500);
  const stillThere = await findFrame();
  check(
    Boolean(stillThere) && stillThere.url === target?.url,
    "returning to the LaTeX tab keeps the same frame",
    stillThere?.url ?? "no frame",
  );
  const pathsAfterSwitch = await frameEval(`globalThis.texpresso?.project?.paths?.().length ?? 0`);
  check(
    pathsAfterSwitch >= pathsBeforeSwitch,
    "the frame kept its project across the switch",
    `${pathsBeforeSwitch} -> ${pathsAfterSwitch}`,
  );

  console.log("=== an unchanged cross-project return uses only the stored PDF ===");
  const bookPath = "samples/latex-perf/book/main.tex";
  // The parent project's manifest includes the book's path. It is still an
  // independent root, so it may never inherit the parent frame in manual mode.
  const parentPath = "samples/latex-perf/small.tex";
  const exportCurrent = `(() => {
  const d = document.querySelector("#preview")?.dataset;
  return Boolean(d?.latexCurrent) && document.querySelector(".compiled-save-pdf")?.disabled === false;
})()`;
  const pageField = `document.querySelector(".compiled-pages .compiled-page-field")`;
  const sessionCount = async () => Number((await dataset("texpressoSession")) ?? "0");
  await openFile(bookPath);
  check(
    await waitFor(exportCurrent, 180_000, "the book's PDF"),
    "the book is ready before leaving",
  );
  const readingPage = Number(
    await frameEval(`Math.max(1, document.querySelectorAll("#pages .page").length - 1)`),
  );
  await evaluate(`(() => {
  const field = ${pageField};
  field.focus();
  field.value = "${readingPage}";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  field.blur();
})()`);
  check(
    await waitFor(`${pageField}?.value === "${readingPage}"`, 5_000, "the book's reading page"),
    `the book is read at page ${readingPage}`,
  );
  const beforeParent = await sessionCount();
  await openFile(parentPath);
  check(
    await waitFor(
      `Number(document.querySelector("#preview")?.dataset.texpressoSession ?? 0) > ${beforeParent} && ${exportCurrent}`,
      180_000,
      "the parent project's PDF",
    ),
    "an independent project mounts and exports on its first open",
  );
  const parentSession = await sessionCount();
  await openFile(bookPath);
  check(
    await waitFor(
      `${exportCurrent} && ${pageField}?.value === "${readingPage}" &&
      document.querySelectorAll("#preview .typst-page").length > 0`,
      5_000,
      "the stored PDF at the reading page",
    ),
    "the stored PDF restores the reading page",
  );
  check((await sessionCount()) === parentSession, "the unchanged book starts no replacement frame");

  // An edit in the cached reader is what brings back a live frame. Keep the
  // cached page visible until the engine has reached the reader's place.
  await editor(
    `view.dispatch({ changes: {from: view.state.doc.length, insert: "\\n% warm return edit\\n"} });`,
  );
  check(
    await waitFor(
      `Number(document.querySelector("#preview")?.dataset.texpressoSession ?? 0) === ${parentSession + 1} &&
     ${exportCurrent} && document.querySelector(".app.latex-texpresso") && ${pageField}?.value === "${readingPage}"`,
      360_000,
      "the live frame at the saved page after an edit",
    ),
    "the first edit starts one frame and preserves the reading page",
  );
  await attachFrame();
  await openFile("samples/latex-perf/book/chapters/ch06.tex");

  console.log("=== recompile from scratch ===");
  const more = ".compiled-toolbar .compiled-compile-more";
  check(
    await waitFor(
      `(() => { const b=document.querySelector(${JSON.stringify(more)}); return !!b && !b.hidden && !b.disabled && b.getAttribute("aria-haspopup")==="menu"; })()`,
      60_000,
      "the split Compile button",
    ),
    "LaTeX's Compile is a split button with a dropdown half",
  );
  await evaluate(`document.querySelector(${JSON.stringify(more)}).click()`);
  const options = await evaluate(
    `JSON.stringify([...document.querySelectorAll(".compiled-compile-menu [role=menuitem] .editor-menu-label")].map(n=>n.textContent))`,
  ).then(JSON.parse);
  check(
    JSON.stringify(options) === JSON.stringify(["Compile", "Recompile from scratch"]),
    "the dropdown lists Compile and Recompile from scratch",
    JSON.stringify(options),
  );
  check(
    (await evaluate(
      `document.querySelector(${JSON.stringify(more)}).getAttribute("aria-expanded")`,
    )) === "true",
    "the open dropdown is announced as expanded",
  );
  await evaluate(
    `document.querySelector(".compiled-compile-menu").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))`,
  );
  check(
    await evaluate(
      `!document.querySelector(".compiled-compile-menu") && document.activeElement===document.querySelector(${JSON.stringify(more)})`,
    ),
    "Escape closes the dropdown and returns focus to the chevron",
  );

  // The session number and the log are read in the click's own turn: the
  // command must already have dropped the old frame and its output.
  const sessionBefore = Number((await dataset("texpressoSession")) ?? "0");
  await evaluate(`window.__mdraftWaitLog = []`);
  const cleanStart = await evaluate(`(() => {
    document.querySelector(${JSON.stringify(more)}).click();
    [...document.querySelectorAll(".compiled-compile-menu [role=menuitem]")]
      .find(b => b.textContent.includes("Recompile from scratch")).click();
    return {
      log: document.querySelector(".compiler-output")?.textContent ?? "",
      problems: document.querySelector("#compiler-problems")?.textContent ?? "",
    };
  })()`);
  check(
    cleanStart.log === "The compiler reported no messages.",
    "Recompile from scratch drops the old build's logs before it starts",
    cleanStart.log.slice(0, 60),
  );
  check(
    cleanStart.problems === "No problems reported.",
    "Recompile from scratch drops the old build's problems before it starts",
    cleanStart.problems.slice(0, 300),
  );
  check(
    await waitFor(
      `Number(document.querySelector("#preview")?.dataset.texpressoSession ?? 0) > ${sessionBefore}`,
      120_000,
      "a new TeXpresso session",
    ),
    "Recompile from scratch mounts a new TeXpresso session",
  );
  check(
    await waitFor(
      `document.querySelector(".compiled-toolbar .compiled-state-label")?.textContent === "Recompiled from scratch" && !document.querySelector(".compiled-toolbar .compiled-compile").classList.contains("latex-cancel")`,
      300_000,
      "the clean build's status",
    ),
    "the status names the build from scratch",
  );
  // The old frame was disposed but the project still owns the pane; the new
  // frame is blank until it draws, and that wait must be visible too.
  const cleanWaits = await waitLog();
  check(
    shownWaits(cleanWaits).length > 0,
    "Recompile from scratch shows the waiting surface until the new frame draws",
    cleanWaits.map((entry) => `${entry.at} ${entry.text}`).join(" | "),
  );
  check(
    await waitFor(
      `!document.querySelector("#preview-pane > .preview-pending")`,
      30_000,
      "the clean frame's first page",
    ),
    "the clean frame's first page removes the waiting surface",
  );
  check(
    (await evaluate(
      `(document.querySelector(".compiler-output")?.textContent.match(/Preview starting/g) ?? []).length`,
    )) === 1,
    "the log holds only the new run",
  );
  const menuSessionBefore = Number((await dataset("texpressoSession")) ?? "0");
  await emitMenu(page, "view.latexCompileClean");
  check(
    await waitFor(
      `Number(document.querySelector("#preview")?.dataset.texpressoSession ?? 0) > ${menuSessionBefore} && document.querySelector(".compiled-toolbar .compiled-state-label")?.textContent === "Recompiled from scratch" && !document.querySelector(".compiled-toolbar .compiled-compile").classList.contains("latex-cancel")`,
      300_000,
      "the menu command's clean build",
    ),
    "the Tools menu command runs the same action",
  );

  console.log("=== a link in the preview is followed, not mapped ===");
  // XeLaTeX whatever the profile's default, through the file's magic comment:
  // hyperref's xetex driver writes the `pdf:` link specials that the engine
  // draws and the export's xdvipdfmx reads. The links are typed, so they need
  // no auxiliary file (an unresolved `\ref` is no link at all), and the target
  // is two pages on. The harness puts the file back.
  const webUrl = "https://example.com/mdraft-link-probe";
  const probe = [
    "% !TeX program = xelatex",
    "\\documentclass{article}",
    "\\usepackage{fontspec}",
    "\\usepackage{hyperref}",
    "\\begin{document}",
    `\\hyperlink{mdraftlinkprobe}{LinkProbeJump} and \\href{${webUrl}}{LinkProbeWeb}.`,
    "\\newpage",
    // Source lines enough to scroll the editor: a link that moved the source
    // with the preview would take it to the target's line, far below.
    ...Array.from({ length: 80 }, (_, n) => `A line between the link and its target, ${n + 1}.`),
    "\\newpage",
    "\\hypertarget{mdraftlinkprobe}{LinkProbeTarget} closes the probe.",
    "\\end{document}",
    "",
  ].join("\n");
  frame?.close();
  frame = null;
  await openFile("samples/latex-engines/magic-xe.tex");
  const xetexFrame = await (async () => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (list.some((entry) => /mdraft-tex\.localhost\/texpresso\/.*engine=xetex/.test(entry.url)))
        return true;
      await sleep(500);
    }
    return false;
  })();
  check(xetexFrame, "the link probe runs in a XeLaTeX frame");
  if (!xetexFrame) throw new Error("no XeLaTeX frame for the link probe");
  frame = await openPage(port, { type: "iframe", match: /engine=xetex/ });
  await editor(
    `view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: ${JSON.stringify(probe)} } });`,
  );
  const probePainted = await (async () => {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      try {
        if (await frameEval(`document.querySelectorAll("#pages .page").length >= 3`)) return true;
      } catch {
        // The frame may still be booting.
      }
      await sleep(500);
    }
    return false;
  })();
  check(probePainted, "the typed links are painted, three pages");
  await sleep(1500);
  if (probePainted) {
    const hostPageStrip = () =>
      evaluate(`(() => {
        const group=document.querySelector('.compiled-pages');
        const field=group?.querySelector('.compiled-page-field');
        const total=group?.querySelector('.compiled-page-total');
        if (!group || !field || !total) return null;
        return { hidden: group.hidden, value: field.value, total: total.textContent };
      })()`);
    const liveStrip = await hostPageStrip();
    check(
      "the live LaTeX preview reports its page count",
      liveStrip !== null &&
        !liveStrip.hidden &&
        liveStrip.value === "1" &&
        /\b3\b/.test(liveStrip.total),
      JSON.stringify(liveStrip),
    );
    await evaluate(`document.querySelector('.compiled-pages [aria-label="Last page"]').click()`);
    await sleep(1500);
    const lastPage = {
      field: (await hostPageStrip())?.value,
      top: await frameEval(`document.getElementById("pages")?.scrollTop ?? 0`),
    };
    check(
      "Last page moves the live frame and the page field",
      lastPage.top > 0 && lastPage.field === "3",
      JSON.stringify(lastPage),
    );
    await evaluate(`document.querySelector('.compiled-pages [aria-label="First page"]').click()`);
    await sleep(1500);
    const firstPage = {
      field: (await hostPageStrip())?.value,
      top: await frameEval(`document.getElementById("pages")?.scrollTop ?? 0`),
    };
    check(
      "First page returns the live frame to the top",
      firstPage.top < 2 && firstPage.field === "1",
      JSON.stringify(firstPage),
    );
  }
  const pagesTop = () => frameEval(`document.getElementById("pages")?.scrollTop ?? 0`);
  /** The editor's selection and scroll, and the source marks a click paints. */
  const hostState = () =>
    editor(`const s = view.state.selection.main;
      const d = view.scrollDOM;
      return { anchor: s.anchor, head: s.head, scroll: Math.round(d.scrollTop),
        max: Math.round(d.scrollHeight - d.clientHeight),
        words: document.querySelectorAll(".cm-sync-word").length };`);
  /** Bridge trace entries after frame time `t0` that contain `needle`. */
  const traceSince = async (t0, needle) =>
    (await frameEval(`document.documentElement.dataset.mdraftTrace ?? ""`))
      .split(" | ")
      .filter((entry) => Number(entry.split(" ")[0]) >= t0 && entry.includes(needle));
  /**
   * The engine's mark for `text`, selected in the editor: the only geometry the
   * test has for a typed word. `reveal` scrolls it to the middle of the frame.
   */
  const markFor = async (text, reveal) => {
    const before = await traceSelectMarks();
    const found = await editor(`
      const at = view.state.doc.toString().indexOf(${JSON.stringify(text)});
      if (at < 0) return false;
      view.dispatch({ selection: { anchor: at, head: at + ${text.length} } });
      return true;
    `);
    if (!found) return null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const now = await traceSelectMarks();
      if (now !== before && now > 0) break;
      await sleep(150);
    }
    const mark = await frameEval(
      `JSON.stringify((() => {
        const pages = document.getElementById("pages");
        const mark = pages.querySelector(".cursor-mark.selection");
        if (!mark) return null;
        if (${reveal}) mark.scrollIntoView({ block: "center" });
        const r = mark.getBoundingClientRect();
        const box = pages.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        return { x, y, top: r.top, bottom: r.bottom, viewTop: box.top, viewBottom: box.bottom,
          inside: Boolean(document.elementFromPoint(x, y)?.closest("#pages")) };
      })())`,
    ).then(JSON.parse);
    // Let the reveal's own viewport report go out before anything is measured.
    if (reveal) await sleep(1000);
    return mark;
  };
  const linkUnder = (point) =>
    frameEval(
      `JSON.stringify(globalThis.texpresso?.preview?.linkAt?.(${point.x}, ${point.y})?.action ?? null)`,
    ).then((text) => JSON.parse(text ?? "null"));
  let pointerTarget = frame;
  let frameOffset = { x: 0, y: 0 };
  const mouse = (type, point, extra = {}) =>
    pointerTarget.send("Input.dispatchMouseEvent", {
      type,
      x: point.x + frameOffset.x,
      y: point.y + frameOffset.y,
      pointerType: "mouse",
      ...extra,
    });
  const click = async (point) => {
    await mouse("mouseMoved", point);
    await mouse("mousePressed", point, { button: "left", buttons: 1, clickCount: 1 });
    await mouse("mouseReleased", point, { button: "left", buttons: 0, clickCount: 1 });
  };
  /**
   * Click a link and wait for the bridge to take it. The frame's own session is
   * tried first; the page's session routes a press into the child frame.
   */
  const clickLink = async (point) => {
    for (const via of ["frame", "page"]) {
      pointerTarget = via === "frame" ? frame : page;
      frameOffset =
        via === "frame"
          ? { x: 0, y: 0 }
          : await evaluate(
              `JSON.stringify((() => { const r = document.querySelector(".texpresso-frame").getBoundingClientRect(); return { x: r.left, y: r.top }; })())`,
            ).then(JSON.parse);
      const t0 = await frameEval(`performance.now()`);
      await click(point);
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline) {
        if ((await traceSince(t0, " link ")).length) return { via, t0 };
        await sleep(150);
      }
    }
    return null;
  };

  const jump = await markFor("LinkProbeJump", true);
  const jumpAction = jump ? await linkUnder(jump) : null;
  check(
    jump?.inside === true && Boolean(jumpAction) && "dest" in jumpAction,
    "the engine reports the typed \\hyperlink as a destination link",
    JSON.stringify({ jump, jumpAction }),
  );
  if (jump?.inside && jumpAction) {
    await mouse("mouseMoved", jump);
    await sleep(300);
    const jumpTitle = await frameEval(`document.getElementById("pages")?.title ?? ""`);
    check(jumpTitle === "", "a destination link carries no double-click hint", jumpTitle);
    const hostBefore = await hostState();
    const topBefore = await pagesTop();
    const taken = await clickLink(jump);
    check(Boolean(taken), "the bridge takes a click on a link", JSON.stringify({ taken }));
    if (taken) {
      let topAfter = topBefore;
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        topAfter = await pagesTop();
        if (topAfter > topBefore + 100) break;
        await sleep(150);
      }
      check(
        topAfter > topBefore + 100,
        "a click on an internal link scrolls the preview towards its target",
        `${topBefore} -> ${topAfter} via ${taken.via}`,
      );
      // Long enough for any late source answer and the landing's viewport report.
      await sleep(1500);
      const sourced = await traceSince(taken.t0, " source ");
      const hostAfter = await hostState();
      check(
        sourced.length === 0 &&
          hostAfter.anchor === hostBefore.anchor &&
          hostAfter.head === hostBefore.head &&
          hostAfter.words === hostBefore.words,
        "a click on a link asks the source map nothing",
        JSON.stringify({ sourced, hostBefore, hostAfter }),
      );
      check(
        // The editor could have moved: the target's line is below its view.
        hostBefore.max > 100 && Math.abs(hostAfter.scroll - hostBefore.scroll) <= 1,
        "the source stays where it is when a link moves the preview",
        `${hostBefore.scroll} -> ${hostAfter.scroll} of ${hostBefore.max}`,
      );
      // Selecting the target in the editor paints its mark and moves nothing.
      const landed = await markFor("LinkProbeTarget", false);
      check(
        landed !== null &&
          landed.top >= landed.viewTop - 2 &&
          landed.bottom <= landed.viewBottom + 2,
        "the link lands with its target in view",
        JSON.stringify(landed),
      );
    }
  }

  // The web link: the opener command is answered here, so nothing leaves the
  // machine. Tauri's own `invoke` cannot be replaced, but its IPC posts every
  // command through the global `fetch`. A command this layer sends first proves
  // that route, or the click is skipped rather than open a browser.
  const stubbed = await evaluate(`(async () => {
    const realFetch = window.fetch;
    const seen = [];
    window.__mdraftOpened = [];
    window.__mdraftRestoreFetch = () => { window.fetch = realFetch; };
    window.fetch = function (input, init) {
      const url = String(input?.url ?? input);
      if (url.includes("plugin%3Aopener%7Copen_url")) {
        let body = null;
        try { body = JSON.parse(init?.body ?? "null"); } catch { body = null; }
        window.__mdraftOpened.push(body?.url ?? null);
        return Promise.resolve(new Response("null", {
          headers: { "Tauri-Response": "ok", "Content-Type": "application/json" },
        }));
      }
      if (url.includes("latex_engine_status")) seen.push(url);
      return realFetch.call(this, input, init);
    };
    await window.__TAURI_INTERNALS__.invoke("latex_engine_status");
    return seen.length > 0;
  })()`);
  const web = await markFor("LinkProbeWeb", true);
  const webAction = web ? await linkUnder(web) : null;
  check(
    web?.inside === true && webAction?.uri === webUrl,
    "the engine reports the typed \\href as a web link",
    JSON.stringify({ web, webAction }),
  );
  if (!stubbed) {
    console.log("  SKIP  commands do not travel through fetch, so the web link is not clicked");
  } else if (web?.inside && webAction) {
    await mouse("mouseMoved", web);
    await sleep(300);
    check(
      (await frameEval(`document.getElementById("pages")?.title ?? ""`)) === webUrl,
      "a web link's title is its address, with no double-click hint",
    );
    const hostBefore = await hostState();
    const taken = await clickLink(web);
    let opened = [];
    const deadline = Date.now() + 5_000;
    while (taken && Date.now() < deadline) {
      opened = await evaluate(`JSON.stringify(window.__mdraftOpened ?? [])`).then(JSON.parse);
      if (opened.length) break;
      await sleep(150);
    }
    check(
      opened.length === 1 && opened[0] === webUrl,
      "a click on a web link hands its address to the system once",
      JSON.stringify({ opened, via: taken?.via }),
    );
    await sleep(800);
    const sourced = taken ? await traceSince(taken.t0, " source ") : ["(not taken)"];
    const hostAfter = await hostState();
    check(
      sourced.length === 0 &&
        hostAfter.anchor === hostBefore.anchor &&
        hostAfter.head === hostBefore.head,
      "a click on a web link asks the source map nothing",
      JSON.stringify({ sourced, hostBefore, hostAfter }),
    );
  }
  await evaluate(`window.__mdraftRestoreFetch?.()`);

  console.log("=== engines and fallbacks ===");
  // LuaLaTeX restarts the frame with `luatex`: the app's engine is part of the
  // frame's URL, so a second target with `engine=luatex` is the proof (the
  // first frame ran XeLaTeX, the default).
  const lua = `${process.env.MDRAFT_REPO}\\samples\\latex-engines\\magic-lua.tex`;
  await evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "open-files", payload: ${JSON.stringify([lua])} })`,
  );
  const luaFrame = await (async () => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const hit = list.find((entry) => /mdraft-tex\.localhost\/texpresso\//.test(entry.url));
      if (hit && /engine=luatex/.test(hit.url)) return hit;
      const chipTitle = await evaluate(
        `document.getElementById("status-latex-engine")?.title ?? ""`,
      );
      if (/Preview unavailable/.test(chipTitle)) return null;
      await sleep(500);
    }
    return null;
  })();
  check(
    Boolean(luaFrame),
    "LuaLaTeX restarts the frame with luatex",
    luaFrame?.url ?? "no luatex frame",
  );
  if (luaFrame) {
    frame = await openPage(port, { type: "iframe", match: /engine=luatex/ });
    check(
      await waitFor(
        `document.querySelector("#preview")?.dataset.texpressoPainted ?? ""`,
        120_000,
        "the luatex paint",
      ),
      "the luatex frame typesets the document",
    );
  }

  // The bundled preview has no pdfTeX, so the menu must not offer it.
  await evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "open-files", payload: [${JSON.stringify(
      `${process.env.MDRAFT_REPO}\\samples\\latex-engines\\plain.tex`,
    )}] })`,
  );
  await sleep(1500);
  await evaluate(`document.getElementById("status-latex-engine").click()`);
  await sleep(600);
  const labels = await evaluate(
    `JSON.stringify([...document.querySelectorAll(".explorer-menu .favorite-menu-item")].map((b) => b.textContent))`,
  ).then(JSON.parse);
  check(
    !labels.some((label) => /pdfLaTeX/.test(label)),
    "the bundled engine menu offers no pdfLaTeX",
    JSON.stringify(labels),
  );
}

try {
  if (process.env.MDRAFT_LATEX_TAB_PROBE === "1") await tabCacheProbe();
  else await fullSuite();
} catch (error) {
  check(false, `uncaught: ${error.message}`);
} finally {
  page.close();
  frame?.close();
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(
  `\n${checks.length - failed}/${checks.length} checks passed${failed ? `, ${failed} failed` : ""}`,
);
process.exit(failed ? 1 : 0);
