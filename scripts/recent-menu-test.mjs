// The File › Open Recent submenu, and its agreement with the Recent sidebar.
//
//   node scripts/recent-menu-test.mjs [port]
//
// Why this suite exists: the native menu is not part of the webview, so no DOM
// probe can see its rows. `recent_menu` walks the actual submenu (the same way
// `menu_state` reads the check marks) and reports what a person opening File ›
// Open Recent would see. The suite then drives the same menu ids the native
// items emit, proving the frontend dispatch and the Rust list stay in step.
//
// This suite opens temporary documents and clears Recents, so it runs against
// its own freshly launched instance like every other stateful layer.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const port = process.argv[2] ?? "9222";

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

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const startedAt = Date.now();
const mark = (label) =>
  console.log(`  (${((Date.now() - startedAt) / 1000).toFixed(1)}s) ${label}`);

/** Tauri command through the same bridge the application's wrappers use. */
const invoke = (command, args = {}) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
  );

const recentMenu = () => invoke("recent_menu");
const settings = () => invoke("get_settings");
const emit = (event, payload) => invoke("plugin:event|emit", { event, payload });

const tabCount = () => evaluate(`document.querySelectorAll(".doc-tab").length`);

async function pollFor(expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await sleep(150);
  }
  return false;
}

/** Wait for the native submenu to reach a state; return its last reading. */
async function waitForMenu(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let rows = [];
  while (Date.now() < deadline) {
    rows = await recentMenu();
    if (predicate(rows)) return rows;
    await sleep(150);
  }
  return rows;
}

const nameOf = (file) => file.split(/[\\/]/).pop() ?? file;
const recentId = (file) => `recent.file:${file}`;

const workDir = mkdtempSync(path.join(tmpdir(), "mdraft-recent-menu-"));
const probePath = path.join(workDir, "recent-probe.md");
const againPath = path.join(workDir, "recent-again.md");

try {
  // -------------------------------------------------------------------------
  // The menu mirrors the list the window started with
  // -------------------------------------------------------------------------
  console.log("=== the submenu at launch ===");
  mark("connected to the page");
  const booted = await pollFor(
    `document.title.endsWith(" — MDraft") && document.querySelectorAll(".cm-line").length > 0`,
    60000,
  );
  check(booted, "the window finished booting");
  mark("window booted");

  const initial = await settings();
  mark("settings read");
  check(
    initial.recentFiles.length > 0,
    "the launch document was recorded in Recents",
    `recentFiles=${initial.recentFiles.length}`,
  );
  const bootPath = initial.recentFiles[0] ?? "";
  const bootName = nameOf(bootPath);

  let rows = await waitForMenu((list) => list.some((row) => row.id === recentId(bootPath)));
  mark("first recent_menu probe");
  const bootRow = rows.find((row) => row.id === recentId(bootPath));
  check(Boolean(bootRow), "Open Recent lists the launch document");
  check(
    Boolean(bootRow?.text.includes(bootName)),
    "the row keeps the file name visible",
    bootRow?.text ?? "missing row",
  );
  check(
    rows.at(-1)?.id === "recent.clear" && rows.at(-1)?.text === "Clear Items",
    "Clear Items is the last row when the list is not empty",
    rows.at(-1)?.text ?? "missing row",
  );

  // -------------------------------------------------------------------------
  // Opening a new file puts it first, without a restart
  // -------------------------------------------------------------------------
  console.log("\n=== a newly opened file reaches the menu ===");
  writeFileSync(probePath, "# Recent probe\n\nOpened by the recent-menu suite.\n");
  await emit("open-files", [probePath]);
  mark("probe document emitted");
  const probeOpened = await pollFor(
    `document.querySelector('.doc-tab[aria-selected="true"] .doc-tab-name')?.textContent === ${JSON.stringify(nameOf(probePath))}`,
    15000,
  );
  check(probeOpened, "the probe document opened in a tab");
  mark("probe document active");

  const afterOpen = await settings();
  check(
    afterOpen.recentFiles[0] === probePath,
    "the new file is first in settings.recentFiles",
    afterOpen.recentFiles[0] ?? "empty",
  );

  rows = await waitForMenu((list) => list[0]?.id === recentId(probePath));
  mark("menu shows the new file first");
  check(
    rows[0]?.id === recentId(probePath),
    "the native menu was rebuilt with the new file first",
    rows[0]?.id ?? "missing row",
  );
  check(
    Boolean(rows[0]?.text.includes(nameOf(probePath))),
    "the new row shows the file name",
    rows[0]?.text ?? "missing row",
  );

  // -------------------------------------------------------------------------
  // A menu id opens the document, and an already-open one is only focused
  // -------------------------------------------------------------------------
  console.log("\n=== choosing a recent file ===");
  await emit("menu", recentId(bootPath));
  mark("recent menu id emitted");
  const focused = await pollFor(
    `document.querySelector('.doc-tab[aria-selected="true"] .doc-tab-name')?.textContent === ${JSON.stringify(bootName)}`,
    8000,
  );
  check(focused, "choosing the recent id activates that document", bootName);
  check(
    (await tabCount()) === 2,
    "an already-open file is focused, not opened twice",
    String(await tabCount()),
  );

  // -------------------------------------------------------------------------
  // Clear Items empties the menu, the sidebar and the persisted list
  // -------------------------------------------------------------------------
  console.log("\n=== Clear Items ===");
  await evaluate(`document.getElementById("tab-recent").click(); "ok"`);
  mark("Recent tab clicked");
  await emit("menu", "recent.clear");
  mark("Clear Items emitted");

  let cleared = false;
  const clearDeadline = Date.now() + 8000;
  while (Date.now() < clearDeadline) {
    const current = await settings();
    if (current.recentFiles.length === 0) {
      cleared = true;
      break;
    }
    await sleep(150);
  }
  check(cleared, "Clear Items empties settings.recentFiles");

  rows = await waitForMenu((list) => list.length === 1 && list[0]?.id === "recent.empty");
  mark("menu shows the empty state");
  check(
    rows.length === 1 && rows[0]?.id === "recent.empty",
    "the menu falls back to one empty-state row",
    rows.map((row) => row.id).join(", ") || "no rows",
  );
  check(rows[0]?.text === "No Recent Files", "the empty row says No Recent Files", rows[0]?.text ?? "");
  check(rows[0]?.enabled === false, "the empty row cannot be clicked");
  check(
    await pollFor(
      `[...document.querySelectorAll("#sidebar-body .sidebar-empty")].some((node) => node.textContent.includes("No recent files yet."))`,
      8000,
    ),
    "the Recent sidebar shows its empty state too",
  );

  // -------------------------------------------------------------------------
  // The list can refill after a clear
  // -------------------------------------------------------------------------
  console.log("\n=== a file opened after a clear ===");
  writeFileSync(againPath, "# Recent again\n\nThe list refilled after Clear Items.\n");
  await emit("open-files", [againPath]);
  mark("refill document emitted");
  const againOpened = await pollFor(
    `document.querySelector('.doc-tab[aria-selected="true"] .doc-tab-name')?.textContent === ${JSON.stringify(nameOf(againPath))}`,
    15000,
  );
  check(againOpened, "a document opened after the clear becomes active");

  const refilled = await settings();
  check(
    refilled.recentFiles.length === 1 && refilled.recentFiles[0] === againPath,
    "the cleared list records the new file",
    refilled.recentFiles.join(", ") || "empty",
  );
  rows = await waitForMenu((list) => list[0]?.id === recentId(againPath));
  mark("menu refilled");
  check(
    rows[0]?.id === recentId(againPath),
    "the menu repopulates with the new file",
    rows[0]?.id ?? "missing row",
  );
  check(
    rows.at(-1)?.id === "recent.clear",
    "Clear Items returns with the first entry",
    rows.at(-1)?.id ?? "missing row",
  );

  // -------------------------------------------------------------------------
  // The store and the sidebar keep a longer history than the 20-row menu
  // -------------------------------------------------------------------------
  console.log("\n=== a history longer than the menu ===");
  // Direct command calls seed the store without opening 25 tabs. They do not
  // update the module's `settings` copy; opening one real file afterwards does,
  // through the same add_recent response every openPath uses.
  for (let index = 0; index < 25; index += 1) {
    await invoke("add_recent", {
      path: path.join(workDir, `history-${String(index).padStart(2, "0")}.md`),
    });
  }
  const finalPath = path.join(workDir, "recent-final.md");
  writeFileSync(finalPath, "# Final recent\n\nThe frontend settings refresh here.\n");
  await emit("open-files", [finalPath]);
  const finalOpened = await pollFor(
    `document.querySelector('.doc-tab[aria-selected="true"] .doc-tab-name')?.textContent === ${JSON.stringify(nameOf(finalPath))}`,
    15000,
  );
  check(finalOpened, "the last document opens after a long seeded history");

  const history = await settings();
  check(
    history.recentFiles.length === 27,
    "the store keeps more than the menu's 20 rows",
    String(history.recentFiles.length),
  );

  await evaluate(`document.getElementById("tab-recent").click(); "ok"`);
  const sidebarCount = await pollFor(
    `document.querySelectorAll("#sidebar-body .recent-item").length === 27`,
    8000,
  );
  check(sidebarCount, "the Recent sidebar renders the whole 27-row history");

  rows = await waitForMenu((list) => list[0]?.id === recentId(finalPath));
  check(
    rows[0]?.id === recentId(finalPath),
    "the menu starts with the newest row",
    rows[0]?.id ?? "missing row",
  );
  check(
    rows.length === 21,
    "the menu shows 20 files plus Clear Items",
    String(rows.length),
  );
  check(
    rows.at(-1)?.id === "recent.clear",
    "the menu still ends with Clear Items",
    rows.at(-1)?.id ?? "missing row",
  );
} finally {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* a still-open editor buffer must not fail the report */
  }
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.log("\nFailed:");
  for (const entry of failed) {
    console.log(`  - ${entry.label}${entry.detail ? `: ${entry.detail}` : ""}`);
  }
  process.exit(1);
}
