// Favorites across launches, one phase per process.
//
//   node scripts/favorites-restore-test.mjs <port> phase1 <launchDoc> <extra>
//   node scripts/favorites-restore-test.mjs <port> phase2 <launchDoc> <extra>
//
// The harness between the phases closes the window with WM_CLOSE — the message
// the title-bar X sends, so the close handler's flush runs — and starts the same
// binary again on the same settings directory, this time **without a document
// argument**, so a startup path cannot hide what was stored.
//
// Phase 1 adds two favorites through the two real routes: the editor's
// right-click menu for the document on screen, and the tab's menu for the
// other, inactive tab. It leaves the Favorites panel on screen and closes the
// active tab as its last act, so the close flush has a tab change to write.
// Phase 2 asserts the list and its order came back from disk, that the panel
// is still selected, that both rows render, and that a row opens its document.
//
// The suite reads the store through `get_settings` on a **fresh process**: that
// is the load path from settings.json, not the first instance's memory. This is
// what the single-launch Favorites suite cannot prove.

import path from "node:path";

const port = process.argv[2] ?? "9222";
const phase = process.argv[3] ?? "";
const launchDoc = process.argv[4] ?? "";
const extraDoc = process.argv[5] ?? "";

if (phase !== "phase1" && phase !== "phase2") {
  console.error(`unknown phase: ${phase || "(missing)"}`);
  process.exit(2);
}
if (!launchDoc || !extraDoc) {
  console.error("phase arguments need a launch document and one extra document");
  process.exit(2);
}

const basename = (value) => value.split(/[\\/]/).pop();

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

/** Call an application command the way the frontend does. */
const invoke = (command) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}).then(
       (value) => JSON.stringify(value),
       (error) => { throw new Error(String(error)); })`,
  ).then((text) => JSON.parse(text));

const tabs = () =>
  json(`[...document.querySelectorAll(".doc-tab-name")].map((e) => e.textContent)`);
const activeTab = () =>
  evaluate(
    `document.querySelector('.doc-tab[aria-selected="true"] .doc-tab-name')?.textContent ?? ""`,
  );
const toastText = () =>
  evaluate(
    `document.getElementById("toast").hidden ? "" : document.getElementById("toast").textContent`,
  );
const favoriteNames = async () =>
  (await invoke("get_settings")).favorites.map((entry) => basename(entry));

const favoriteRows = () =>
  json(`[...document.querySelectorAll("#sidebar-body .favorite-item")].map((row) => ({
    name: row.querySelector(".favorite-open .name")?.textContent ?? "",
    title: row.title ?? "",
    hasStar: Boolean(row.querySelector(".favorite-star")),
    hasOpen: Boolean(row.querySelector(".favorite-open")),
    hasRemove: Boolean(row.querySelector(".favorite-remove")),
  }))`);

/** Ask the window to open a path the way a second instance would. */
const emitOpenFiles = (paths) =>
  evaluate(
    `window.__TAURI_INTERNALS__
      .invoke("plugin:event|emit", { event: "open-files", payload: ${JSON.stringify(paths)} })
      .then(() => "ok", (error) => { throw new Error(String(error)); })`,
  );

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

const closeActiveTab = () =>
  evaluate(
    `(() => {
      const tab = document.querySelector('.doc-tab[aria-selected="true"]');
      if (!tab) return "missing";
      tab.querySelector(".doc-tab-close").click();
      return "clicked";
    })()`,
  );

/** Right-click the first visible source line and choose Add to Favorites. */
async function favoriteFromEditor() {
  const opened = await evaluate(`(() => {
    const line = document.querySelector(".cm-line");
    if (!line) return "missing line";
    const rect = line.getBoundingClientRect();
    const x = rect.left + 30;
    const y = rect.top + Math.min(8, rect.height / 2);
    (document.elementFromPoint(x, y) ?? line).dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, buttons: 2,
    }));
    return "ok";
  })()`);
  await sleep(200);
  const chosen = await evaluate(`(() => {
    const button = document.querySelector('.editor-menu-item[data-action="favorite"]');
    if (!button) return "missing";
    if (button.disabled) return "disabled";
    button.click();
    return "clicked";
  })()`);
  return opened === "ok" ? chosen : opened;
}

/** Right-click a tab and choose Add to Favorites for that tab's own file. */
async function favoriteFromTab(name, alsoPersist = false) {
  const opened = await evaluate(`(() => {
    const tab = [...document.querySelectorAll(".doc-tab")]
      .find((t) => t.querySelector(".doc-tab-name")?.textContent === ${JSON.stringify(name)});
    if (!tab) return "missing";
    const rect = tab.getBoundingClientRect();
    tab.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, button: 2,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
    }));
    return "ok";
  })()`);
  await sleep(200);
  const chosen = await evaluate(`(() => {
    const button = document.querySelector('.tab-menu-item[data-action="favorite"]');
    if (!button) return "missing";
    if (button.disabled) return "disabled";
    button.click();
    // The regression this catches: a whole-object save scheduled here, while
    // the favorite command is still in flight, must not carry the old list.
    if (${JSON.stringify(alsoPersist)}) document.getElementById("flag-sync").click();
    return "clicked";
  })()`);
  return opened === "ok" ? chosen : opened;
}

try {
  if (phase === "phase1") {
    // -----------------------------------------------------------------------
    console.log("=== phase 1: two favorites through the two menus ===");
    const booted = await pollFor(
      `document.title.endsWith(" — MDraft") && document.querySelectorAll(".cm-line").length > 0`,
      60000,
    );
    check(booted, "the window finished booting");
    check(
      (await tabs()).join(",") === basename(launchDoc),
      "the launch file is the only tab",
      (await tabs()).join(", "),
    );

    await emitOpenFiles([extraDoc]);
    const opened = await pollFor(`document.querySelectorAll(".doc-tab").length === 2`);
    check(opened, "the second document opened as a tab", String((await tabs()).length));
    check(
      (await activeTab()) === basename(extraDoc),
      "and it is the active tab",
      await activeTab(),
    );
    check((await favoriteNames()).length === 0, "the profile starts with no favorites");

    // The document on screen, through the editor's own menu.
    check((await favoriteFromEditor()) === "clicked", "the editor menu adds the active document");
    const firstSaved = await pollFor(
      `(async () => (await window.__TAURI_INTERNALS__.invoke("get_settings")).favorites.length === 1)()`,
    );
    check(firstSaved, "the first favorite reached the store");
    check(
      /Added .+ to Favorites/.test(await toastText()),
      "the add is confirmed",
      await toastText(),
    );

    // The other tab, without activating it, through the tab's own menu. The
    // same task also toggles a persisted status flag, so a whole-object save is
    // scheduled while the favorite command is still in flight. Queueing makes
    // that save read the list after the command; without it the save carries
    // the old list and erases the favorite both on disk and in memory.
    const syncBefore = (await invoke("get_settings")).syncScroll;
    check(
      (await favoriteFromTab(basename(launchDoc), true)) === "clicked",
      "the tab menu adds the inactive document while a save is scheduled",
    );
    const bothSaved = await pollFor(
      `(async () => (await window.__TAURI_INTERNALS__.invoke("get_settings")).favorites.length === 2)()`,
    );
    check(bothSaved, "the second favorite reached the store");
    const afterRace = await invoke("get_settings");
    check(
      afterRace.syncScroll === !syncBefore,
      "the status flag's queued save went through",
      String(afterRace.syncScroll),
    );
    const stored = afterRace.favorites.map((entry) => basename(entry));
    check(
      stored.join(",") === [basename(extraDoc), basename(launchDoc)].join(","),
      "and it kept the favorite it was scheduled after",
      stored.join(", "),
    );

    // -----------------------------------------------------------------------
    console.log("\n=== the panel is left on screen ===");
    await evaluate(`document.getElementById("tab-favorites").click(); "ok"`);
    await sleep(400);
    const rows = await favoriteRows();
    check(rows.length === 2, "the panel shows two rows", String(rows.length));
    check(
      rows.map((row) => row.name).join(",") === [basename(extraDoc), basename(launchDoc)].join(","),
      "the rows follow insertion order",
      rows.map((row) => row.name).join(", "),
    );
    check(
      rows.every((row) => row.hasStar && row.hasOpen && row.hasRemove),
      "each row has its star, Open and x",
    );

    // -----------------------------------------------------------------------
    // The last act: close the active tab and return immediately. The panel
    // choice and this tab change reach disk through the close flush; phase 2
    // is what proves the flush wrote the list, not a snapshot without it.
    console.log("\n=== the last change is left to the close flush ===");
    check((await closeActiveTab()) === "clicked", "the active tab is closed just before the close");
    const settled = await pollFor(`document.querySelectorAll(".doc-tab").length === 1`);
    check(settled, "the strip is down to the launch document", (await tabs()).join(", "));
    check((await favoriteNames()).length === 2, "closing the tab does not remove its favorite");
  } else {
    // -----------------------------------------------------------------------
    console.log("=== phase 2: the same binary, no document argument ===");
    const booted = await pollFor(
      `document.title.endsWith(" — MDraft") && document.querySelectorAll(".cm-line").length > 0`,
      60000,
    );
    check(booted, "the window finished booting");
    check((await tabs()).length === 1, "the launch opens a single welcome tab");

    const settings = await invoke("get_settings");
    const stored = settings.favorites.map((entry) => basename(entry));
    check(
      stored.join(",") === [basename(extraDoc), basename(launchDoc)].join(","),
      "both favorites came back from disk in order",
      stored.join(", "),
    );
    check(
      settings.favorites.every(
        (entry) => entry.endsWith(basename(extraDoc)) || entry.endsWith(basename(launchDoc)),
      ),
      "the stored entries are full paths, not names",
      JSON.stringify(settings.favorites),
    );
    check(
      settings.sidebarTab === "favorites",
      "the Favorites panel survived the restart",
      settings.sidebarTab,
    );

    const rows = await favoriteRows();
    check(rows.length === 2, "the panel renders both rows at boot", String(rows.length));
    check(
      rows.map((row) => row.name).join(",") === [basename(extraDoc), basename(launchDoc)].join(","),
      "the rendered order matches the stored order",
      rows.map((row) => row.name).join(", "),
    );

    // A row is only useful if it opens the file the path names.
    const openedRow = await evaluate(`(() => {
      const row = document.querySelector("#sidebar-body .favorite-item .favorite-open");
      if (!row) return "missing";
      row.click();
      return "clicked";
    })()`);
    check(openedRow === "clicked", "the first favorite row is clickable");
    const opened = await pollFor(`document.querySelectorAll(".doc-tab").length === 2`);
    check(opened, "clicking it opens a tab", String((await tabs()).length));
    check(
      (await activeTab()) === basename(extraDoc),
      "and the tab is the document the favorite names",
      await activeTab(),
    );
    check(
      (await favoriteNames()).join(",") === [basename(extraDoc), basename(launchDoc)].join(","),
      "opening a favorite never reorders the list",
      (await favoriteNames()).join(", "),
    );
    check(
      !/could not|not found|missing/i.test(await toastText()),
      "no favorite was reported missing",
      await toastText(),
    );
  }
} catch (error) {
  console.log(`  FAIL  the suite threw — ${error.message}`);
  checks.push({ ok: false, label: "suite completed", detail: error.message });
}

const passed = checks.filter((entry) => entry.ok).length;
console.log(`\n${phase} ${passed}/${checks.length} checks passed`);
ws.close();
process.exit(passed === checks.length ? 0 : 1);
