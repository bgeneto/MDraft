// Tab restore across launches, one phase per process.
//
//   node scripts/tabs-restore-test.mjs <port> phase1 <launchDoc> <extra…>
//   node scripts/tabs-restore-test.mjs <port> phase2
//
// The harness between the phases: it closes the window with WM_CLOSE — the
// message the title-bar X sends, so the close handler's flush runs — and starts
// the same binary again on the same settings directory, this time **without a
// document argument**, because an explicit path would win over the remembered
// set and hide what this suite exists to see.
//
// Phase 1 opens two more documents, reorders the strip, activates one of them,
// sets On Launch to "Reopen the last tabs" through the Preferences panel, and
// closes a tab as its last act so the close flush has something to record.
// Phase 2 asserts the tab names, their order, the active tab and the preference.

import path from "node:path";

const port = process.argv[2] ?? "9222";
const phase = process.argv[3] ?? "";
const extras = process.argv.slice(5);
const basename = (value) => value.split(/[\\/]/).pop();

if (phase !== "phase1" && phase !== "phase2") {
  console.error(`unknown phase: ${phase || "(missing)"}`);
  process.exit(2);
}

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) {
  console.error("no page target; start the application with the debug port open");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const resolve = pending.get(message.id);
  if (resolve) {
    pending.delete(message.id);
    resolve(message);
  }
});
await new Promise((resolve) => ws.addEventListener("open", resolve));
await send("Runtime.enable");

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.result?.exceptionDetails) {
    throw new Error(result.result.exceptionDetails.exception?.description ?? "evaluate failed");
  }
  return result.result.result.value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = async (expression) => JSON.parse(await evaluate(`JSON.stringify(${expression})`));

async function pollFor(expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await sleep(200);
  }
  return false;
}

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const tabs = () => json(`[...document.querySelectorAll(".doc-tab-name")].map((e) => e.textContent)`);
const activeTab = () =>
  evaluate(`document.querySelector('.doc-tab[aria-selected="true"] .doc-tab-name')?.textContent ?? ""`);
const title = () => evaluate(`document.title`);
const toastText = () => evaluate(`document.getElementById("toast").hidden ? "" : document.getElementById("toast").textContent`);

/** Call an application command the way the frontend does. */
const invoke = (command) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}).then(
       (value) => JSON.stringify(value),
       (error) => { throw new Error(String(error)); })`,
  ).then((text) => JSON.parse(text));

const clickTab = (name) =>
  evaluate(
    `(() => {
      const tab = [...document.querySelectorAll(".doc-tab")]
        .find((t) => t.querySelector(".doc-tab-name")?.textContent === ${JSON.stringify(name)});
      if (!tab) return "missing";
      tab.click();
      return "clicked";
    })()`,
  );

const clickClose = (name) =>
  evaluate(
    `(() => {
      const tab = [...document.querySelectorAll(".doc-tab")]
        .find((t) => t.querySelector(".doc-tab-name")?.textContent === ${JSON.stringify(name)});
      if (!tab) return "missing";
      tab.querySelector(".doc-tab-close").click();
      return "clicked";
    })()`,
  );

/** Ask the window to open paths the way a second instance would. */
const emitOpenFiles = (paths) =>
  evaluate(
    `window.__TAURI_INTERNALS__
      .invoke("plugin:event|emit", { event: "open-files", payload: ${JSON.stringify(paths)} })
      .then(() => "ok", (error) => { throw new Error(String(error)); })`,
  );

/** Drag a tab so it lands at the right edge of `before` — the strip's own gesture. */
const dragTabAfter = (name, before) =>
  evaluate(
    `(() => {
      const bar = document.getElementById("doc-tabs");
      const find = (label) => [...bar.querySelectorAll(".doc-tab")].find(
        (tab) => tab.querySelector(".doc-tab-name")?.textContent === label,
      );
      const from = find(${JSON.stringify(name)});
      const to = find(${JSON.stringify(before)});
      if (!from || !to) return "missing";
      const data = typeof DataTransfer === "function" ? new DataTransfer() : null;
      const fromRect = from.getBoundingClientRect();
      from.dispatchEvent(new DragEvent("dragstart", {
        bubbles: true, cancelable: true, dataTransfer: data,
        clientX: fromRect.left + fromRect.width / 2, clientY: fromRect.top + fromRect.height / 2,
      }));
      const target = to.getBoundingClientRect();
      const x = target.right - 2;
      const y = target.top + target.height / 2;
      bar.dispatchEvent(new DragEvent("dragover", {
        bubbles: true, cancelable: true, dataTransfer: data, clientX: x, clientY: y,
      }));
      bar.dispatchEvent(new DragEvent("drop", {
        bubbles: true, cancelable: true, dataTransfer: data, clientX: x, clientY: y,
      }));
      from.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: data }));
      return "sent";
    })()`,
  );

async function setOnLaunch(value) {
  await evaluate(`document.getElementById("btn-prefs").click()`);
  await sleep(250);
  await evaluate(`(() => {
    const item = [...document.querySelectorAll(".prefs-section")].find((node) => node.textContent.trim() === "Files");
    if (!item) throw new Error("missing Files section");
    item.click();
  })()`);
  await sleep(250);
  const selected = await evaluate(`(() => {
    const row = [...document.querySelectorAll(".prefs-row")].find((node) =>
      (node.querySelector(".prefs-label")?.textContent ?? "").replace(/\\?$/, "").trim() === "On Launch");
    if (!row) throw new Error("missing On Launch preference");
    const select = row.querySelector("select");
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return select.value;
  })()`);
  await sleep(250);
  await evaluate(
    `document.querySelector(".prefs-overlay").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
  );
  await sleep(250);
  return selected;
}

try {
  if (phase === "phase1") {
    // -----------------------------------------------------------------------
    console.log("=== phase 1: open documents, reorder, pick the preference ===");
    const booted = await pollFor(
      `document.title.endsWith(" — MDraft") && document.querySelectorAll(".cm-line").length > 0`,
      60000,
    );
    check(booted, "the window finished booting");
    check((await tabs()).length === 1, "the launch file is the only tab", (await tabs()).join(", "));
    check((await activeTab()) === basename(process.argv[4]), "and it is the active tab", await activeTab());

    await emitOpenFiles(extras);
    const opened = await pollFor(`document.querySelectorAll(".doc-tab").length === ${extras.length + 1}`);
    const afterOpen = await tabs();
    check(opened, `${extras.length} more documents opened as tabs`, String(afterOpen.length));
    check(
      afterOpen.join(",") === [basename(process.argv[4]), ...extras.map(basename)].join(","),
      "the tabs are in open order",
      afterOpen.join(", "),
    );
    check((await activeTab()) === basename(extras[extras.length - 1]), "the last opened document is active", await activeTab());

    // -----------------------------------------------------------------------
    console.log("\n=== the strip is reordered ===");
    const dragged = await dragTabAfter(basename(process.argv[4]), basename(extras[extras.length - 1]));
    await sleep(500);
    const afterDrag = await tabs();
    check(dragged === "sent", "the drag reached the strip");
    check(
      afterDrag[afterDrag.length - 1] === basename(process.argv[4]),
      "the launch file moved to the end",
      afterDrag.join(", "),
    );
    check(afterDrag.length === extras.length + 1, "no tab was lost", String(afterDrag.length));
    check((await activeTab()) !== basename(process.argv[4]), "dragging does not activate the dragged tab");

    await clickTab(basename(extras[0]));
    await sleep(300);
    check((await activeTab()) === basename(extras[0]), "a click picks the active tab", await activeTab());

    // -----------------------------------------------------------------------
    console.log("\n=== the preference is set through the panel ===");
    const selected = await setOnLaunch("tabs");
    check(selected === "tabs", 'the On Launch select holds "tabs"', selected);
    const savedPreference = await pollFor(
      `(async () => (await window.__TAURI_INTERNALS__.invoke("get_settings")).onLaunch === "tabs")()`,
      8000,
    );
    check(savedPreference, "the preference reached the settings file");

    const remembered = await pollFor(
      `(async () => {
        const settings = await window.__TAURI_INTERNALS__.invoke("get_settings");
        return settings.lastTabs.length === ${extras.length + 1};
      })()`,
      8000,
    );
    const savedTabs = (await invoke("get_settings")).lastTabs.map(basename);
    check(remembered, "the open tabs reached the remembered list", savedTabs.join(", "));
    check(
      (await invoke("get_settings")).lastActiveTab?.endsWith(basename(extras[0])) === true,
      "with the active tab recorded",
    );

    // -----------------------------------------------------------------------
    // The last act: close a tab and return immediately. The interval may not
    // fire again before the harness's WM_CLOSE, so phase 2 seeing two tabs is
    // what proves the close handler flushed the change.
    console.log("\n=== the final change is left to the close flush ===");
    check((await clickClose(basename(extras[1]))) === "clicked", "a tab was closed just before the close");
    const settled = await pollFor(`document.querySelectorAll(".doc-tab").length === ${extras.length}`);
    check(settled, "the strip is down to the remembered set", (await tabs()).join(", "));
  } else {
    // -----------------------------------------------------------------------
    console.log("=== phase 2: the same binary, no document argument ===");
    const restored = await pollFor(`document.querySelectorAll(".doc-tab").length === 2`, 60000);
    const restoredTabs = await tabs();
    check(restored, "two tabs came back", String(restoredTabs.length));
    check(
      restoredTabs.join(",") === [basename(extras[0]), basename(process.argv[4])].join(","),
      "the documents and the order the strip was left in",
      restoredTabs.join(", "),
    );
    check((await activeTab()) === basename(extras[0]), "the remembered tab is active", await activeTab());
    check((await title()).startsWith(basename(extras[0])), "the window names the active document", await title());

    const settings = await invoke("get_settings");
    check(settings.onLaunch === "tabs", "the launch preference survived the restart", settings.onLaunch);
    check(
      settings.lastTabs.map(basename).join(",") === [basename(extras[0]), basename(process.argv[4])].join(","),
      "the flushed list holds exactly the documents that were open",
      settings.lastTabs.map(basename).join(", "),
    );
    check(
      settings.lastActiveTab?.endsWith(basename(extras[0])) === true,
      "and the remembered active tab",
      settings.lastActiveTab ?? "null",
    );
    check((await toastText()) === "", "no file was reported missing", await toastText());
  }
} catch (error) {
  console.log(`  FAIL  the suite threw — ${error.message}`);
  checks.push({ ok: false, label: "suite completed", detail: error.message });
}

const passed = checks.filter((entry) => entry.ok).length;
console.log(`\n${phase} ${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
