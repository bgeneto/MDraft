// Favorites: the sidebar panel that replaced Files, and the two right-click
// routes that fill it.
//
//   node scripts/favorites-test.mjs [port]
//
// The point of the feature is its rules, not its row count: a favorite is
// appended where it was added, opening it never moves it, it is removed one at
// a time, and neither Recent's recency ordering nor its Clear All exists here.
//
// The suite owns its instance because it writes favorites to settings.json and
// creates a temporary document to delete while a favorite still points at it.

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

const json = async (expression) => JSON.parse(await evaluate(`JSON.stringify(${expression})`));
const invoke = (command, args = {}) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
  );
const settings = () => invoke("get_settings");
const emitMenu = (id) => invoke("plugin:event|emit", { event: "menu", payload: id });
const emitOpenFiles = (paths) =>
  invoke("plugin:event|emit", { event: "open-files", payload: paths });
const tabCount = () => evaluate(`document.querySelectorAll(".doc-tab").length`);
const activeTab = () =>
  evaluate(
    `document.querySelector('.doc-tab[aria-selected="true"] .doc-tab-name')?.textContent ?? ""`,
  );
const toast = () =>
  evaluate(
    `document.getElementById("toast").hidden ? "" : document.getElementById("toast").textContent`,
  );

async function pollFor(expression, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await sleep(150);
  }
  return false;
}

async function clickTab(name) {
  return evaluate(`(() => {
    const tab = [...document.querySelectorAll(".doc-tab")]
      .find((t) => t.querySelector(".doc-tab-name")?.textContent === ${JSON.stringify(name)});
    if (!tab) return "missing";
    tab.click();
    return "clicked";
  })()`);
}

async function closeTab(name) {
  return evaluate(`(() => {
    const tab = [...document.querySelectorAll(".doc-tab")]
      .find((t) => t.querySelector(".doc-tab-name")?.textContent === ${JSON.stringify(name)});
    if (!tab) return "missing";
    tab.querySelector(".doc-tab-close").click();
    return "clicked";
  })()`);
}

/** Right-click inside the source pane, at a point the editor can resolve. */
function rightClickEditor() {
  return evaluate(`(() => {
    const line = document.querySelector(".cm-line");
    if (!line) return "missing line";
    const rect = line.getBoundingClientRect();
    const x = rect.left + 30;
    const y = rect.top + Math.min(8, rect.height / 2);
    const target = document.elementFromPoint(x, y) ?? line;
    target.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
      button: 2, buttons: 2,
    }));
    return "ok";
  })()`);
}

const editorMenu = () =>
  evaluate(`(() => {
    const menu = document.querySelector(".editor-menu");
    if (!menu) return { open: false, items: [] };
    return {
      open: true,
      items: [...menu.querySelectorAll(".editor-menu-item")].map((button) => ({
        action: button.dataset.action,
        label: button.querySelector(".editor-menu-label")?.textContent ?? button.textContent,
        disabled: button.disabled,
        title: button.title,
      })),
    };
  })()`);

const chooseEditor = (action) =>
  evaluate(`(() => {
    const button = document.querySelector('.editor-menu-item[data-action="${action}"]');
    if (!button) return "missing";
    if (button.disabled) return "disabled";
    button.click();
    return "clicked";
  })()`);

function rightClickTab(name) {
  return evaluate(`(() => {
    const tab = [...document.querySelectorAll(".doc-tab")]
      .find((t) => t.querySelector(".doc-tab-name")?.textContent === ${JSON.stringify(name)});
    if (!tab) return "missing";
    const rect = tab.getBoundingClientRect();
    tab.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, button: 2,
      clientX: rect.left + 10, clientY: rect.top + 10,
    }));
    return "ok";
  })()`);
}

const tabMenu = () =>
  evaluate(`(() => {
    const menu = document.querySelector(".tab-menu");
    if (!menu || menu.hidden) return { open: false, items: [] };
    return {
      open: true,
      items: [...menu.querySelectorAll(".tab-menu-item")].map((button) => ({
        action: button.dataset.action,
        label: button.querySelector(".tab-menu-label")?.textContent ?? "",
        disabled: button.disabled,
        title: button.title,
      })),
    };
  })()`);

const chooseTab = (action) =>
  evaluate(`(() => {
    const button = document.querySelector('.tab-menu-item[data-action="${action}"]');
    if (!button) return "missing";
    if (button.disabled) return "disabled";
    button.click();
    return "clicked";
  })()`);

const closeMenus = () =>
  evaluate(`(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true, cancelable: true,
    }));
    return "ok";
  })()`);

const favorites = async () => (await settings()).favorites ?? [];

const favoriteRows = () =>
  json(`[...document.querySelectorAll("#sidebar-body .favorite-item")].map((row) => ({
    title: row.title,
    name: row.querySelector(".favorite-open .name")?.textContent ?? "",
    dir: row.querySelector(".favorite-open .dir")?.textContent ?? "",
    hasOpen: Boolean(row.querySelector(".favorite-open")),
    hasStar: Boolean(row.querySelector(".favorite-star")),
    hasRemove: Boolean(row.querySelector(".favorite-remove")),
  }))`);

const clickFavorite = (suffix) =>
  evaluate(`(() => {
    const row = [...document.querySelectorAll("#sidebar-body .favorite-item")]
      .find((entry) => (entry.title || "").endsWith(${JSON.stringify(suffix)}));
    if (!row) return "missing";
    row.querySelector(".favorite-open").click();
    return "clicked";
  })()`);

const removeFavorite = (suffix) =>
  evaluate(`(() => {
    const row = [...document.querySelectorAll("#sidebar-body .favorite-item")]
      .find((entry) => (entry.title || "").endsWith(${JSON.stringify(suffix)}));
    if (!row) return "missing";
    row.querySelector(".favorite-remove").click();
    return "clicked";
  })()`);

const featureTour = path.resolve("samples", "feature-tour.md");
const wordSync = path.resolve("samples", "word-sync.md");

const workDir = mkdtempSync(path.join(tmpdir(), "mdraft-favorites-"));
const missingPath = path.join(workDir, "missing.md");
let failed = 1;

try {
  // -------------------------------------------------------------------------
  // The pill and the empty state
  // -------------------------------------------------------------------------
  console.log("\n=== the pill ===");
  const pills = await json(`[...document.querySelectorAll("#sidebar .sidebar-tab")].map(
    (button) => ({ id: button.id, label: button.textContent.trim() }),
  )`);
  check(
    pills.map((pill) => pill.label).join("|") === "Outline|Favorites|Recent",
    "the sidebar offers Outline, Favorites and Recent",
    pills.map((pill) => pill.label).join(", "),
  );
  check(
    pills.every((pill) => pill.id !== "tab-files") &&
      (await evaluate(`document.getElementById("tab-files") === null`)),
    "there is no Files pill any more",
  );

  await evaluate(`document.getElementById("tab-favorites").click(); "ok"`);
  await sleep(300);
  const empty = await evaluate(
    `document.querySelector("#sidebar-body .sidebar-empty")?.textContent ?? ""`,
  );
  check(
    /No favorites yet/.test(empty) && /Right-click a document or its tab/.test(empty),
    "the empty state names both routes to Add to Favorites",
    empty,
  );
  check(
    (await evaluate(`document.querySelectorAll("#sidebar-body .sidebar-path").length`)) === 0 &&
      (await evaluate(`document.querySelectorAll("#sidebar-body .entry.dir").length`)) === 0,
    "the folder browser is gone: no path header and no folder rows",
  );
  check((await favorites()).length === 0, "a first-run profile has no favorites");

  // -------------------------------------------------------------------------
  // The editor's right-click menu
  // -------------------------------------------------------------------------
  console.log("\n=== the editor menu ===");
  check((await rightClickEditor()) === "ok", "right-clicking the source finds a line");
  await sleep(150);
  let menu = await editorMenu();
  const favoriteItem = (state) => state.items.find((item) => item.action === "favorite");
  check(menu.open, "the editor menu opens");
  check(
    favoriteItem(menu)?.label === "Add to Favorites" && favoriteItem(menu)?.disabled === false,
    "a saved document offers Add to Favorites",
    favoriteItem(menu)?.label ?? "missing",
  );
  check((await chooseEditor("favorite")) === "clicked", "the item is clickable");
  await sleep(700);
  check(
    /Added feature-tour\.md to Favorites/.test(await toast()),
    "adding shows a confirmation naming the file",
    await toast(),
  );
  let stored = await favorites();
  check(
    stored.length === 1 && stored[0].endsWith("feature-tour.md"),
    "the path is persisted",
    JSON.stringify(stored),
  );

  let rows = await favoriteRows();
  check(rows.length === 1, "the panel grows one row", `${rows.length}`);
  check(
    rows[0]?.name === "feature-tour.md" &&
      rows[0]?.dir.endsWith(path.join("MDraft", "samples")) &&
      rows[0]?.hasStar &&
      rows[0]?.hasOpen &&
      rows[0]?.hasRemove,
    "the row shows the name, the folder, a star, Open and a single ×",
    JSON.stringify(rows[0] ?? null),
  );
  const rowLayout = await evaluate(`(() => {
    const row = document.querySelector("#sidebar-body .favorite-item");
    if (!row) return null;
    const open = row.querySelector(".favorite-open")?.getBoundingClientRect();
    const remove = row.querySelector(".favorite-remove")?.getBoundingClientRect();
    const star = row.querySelector(".favorite-star")?.getBoundingClientRect();
    const sidebar = document.getElementById("sidebar").getBoundingClientRect();
    if (!open || !remove || !star) return null;
    return {
      open: open.width,
      remove: remove.width,
      starVisible: star.width > 0 && star.height > 0,
      overlap: open.right > remove.left + 0.5,
      inside: remove.right <= sidebar.right + 0.5,
    };
  })()`);
  check(
    rowLayout &&
      rowLayout.open > 80 &&
      rowLayout.remove >= 20 &&
      rowLayout.starVisible &&
      !rowLayout.overlap &&
      rowLayout.inside,
    "the row lays out the star, the open area and the × without overlap",
    JSON.stringify(rowLayout),
  );

  // -------------------------------------------------------------------------
  // Opening a favorite never reorders it
  // -------------------------------------------------------------------------
  check((await clickFavorite("feature-tour.md")) === "clicked", "the row is clickable");
  await sleep(700);
  check((await tabCount()) === 1, "opening the active document's own favorite leaves one tab");
  stored = await favorites();
  check(
    stored.length === 1 && stored[0].endsWith("feature-tour.md"),
    "opening a favorite does not move it",
    JSON.stringify(stored),
  );

  // -------------------------------------------------------------------------
  // The tab menu, including an inactive tab
  // -------------------------------------------------------------------------
  console.log("\n=== the tab menu ===");
  await emitOpenFiles([wordSync]);
  await sleep(1800);
  check((await tabCount()) === 2 && (await activeTab()) === "word-sync.md", "a second tab is open");

  check((await rightClickTab("feature-tour.md")) === "ok", "the inactive tab has a menu");
  await sleep(150);
  menu = await tabMenu();
  check(menu.open, "the tab menu opens");
  check(
    menu.items.find((item) => item.action === "favorite")?.label === "Remove from Favorites",
    "an already-favorited tab offers Remove from Favorites",
    menu.items.find((item) => item.action === "favorite")?.label ?? "missing",
  );
  await closeMenus();
  await sleep(150);

  check((await rightClickTab("word-sync.md")) === "ok", "the active tab has a menu");
  await sleep(150);
  check(
    (await tabMenu()).items.find((item) => item.action === "favorite")?.label ===
      "Add to Favorites",
    "the second file starts as Add to Favorites",
  );
  check((await chooseTab("favorite")) === "clicked", "the tab item is clickable");
  await sleep(700);
  stored = await favorites();
  check(
    stored.length === 2 &&
      stored[0].endsWith("feature-tour.md") &&
      stored[1].endsWith("word-sync.md"),
    "the clicked tab's path is appended after the first favorite",
    JSON.stringify(stored),
  );
  rows = await favoriteRows();
  check(
    rows.map((row) => row.name).join("|") === "feature-tour.md|word-sync.md",
    "the panel shows the same insertion order",
    rows.map((row) => row.name).join(", "),
  );

  check((await clickTab("feature-tour.md")) === "clicked", "the first tab can be activated");
  await sleep(700);
  stored = await favorites();
  check(
    stored[0].endsWith("feature-tour.md") && stored[1].endsWith("word-sync.md"),
    "activating a file does not reorder the list",
    JSON.stringify(stored),
  );

  // -------------------------------------------------------------------------
  // Toggle and de-duplication
  // -------------------------------------------------------------------------
  console.log("\n=== toggle and duplicates ===");
  check((await rightClickEditor()) === "ok", "right-clicking the favorite's source works");
  await sleep(150);
  menu = await editorMenu();
  check(
    favoriteItem(menu)?.label === "Remove from Favorites" && favoriteItem(menu)?.disabled === false,
    "the editor item toggles to Remove from Favorites",
  );
  check((await chooseEditor("favorite")) === "clicked", "the remove item is clickable");
  await sleep(700);
  stored = await favorites();
  check(
    stored.length === 1 && stored[0].endsWith("word-sync.md"),
    "removing from the editor leaves only the other favorite",
    JSON.stringify(stored),
  );

  await rightClickTab("feature-tour.md");
  await sleep(150);
  await chooseTab("favorite");
  await sleep(700);
  stored = await favorites();
  check(
    stored.length === 2 &&
      stored[0].endsWith("word-sync.md") &&
      stored[1].endsWith("feature-tour.md"),
    "re-adding appends at the end, not at the front",
    JSON.stringify(stored),
  );

  const duplicate = await invoke("add_favorite", { path: featureTour });
  check(
    Array.isArray(duplicate.favorites) &&
      duplicate.favorites.length === 2 &&
      duplicate.favorites[0].endsWith("word-sync.md") &&
      duplicate.favorites[1].endsWith("feature-tour.md"),
    "adding an existing path changes nothing",
    JSON.stringify(duplicate.favorites ?? []),
  );

  // -------------------------------------------------------------------------
  // Removal, one at a time
  // -------------------------------------------------------------------------
  console.log("\n=== removal ===");
  check((await removeFavorite("word-sync.md")) === "clicked", "the first row's × is clickable");
  await sleep(700);
  stored = await favorites();
  check(
    stored.length === 1 && stored[0].endsWith("feature-tour.md"),
    "× removes only that row",
    JSON.stringify(stored),
  );
  rows = await favoriteRows();
  check(rows.length === 1 && rows[0]?.name === "feature-tour.md", "the other row remains");

  await rightClickTab("word-sync.md");
  await sleep(150);
  await chooseTab("favorite");
  await sleep(700);
  check((await favorites()).length === 2, "the second favorite is back for the row menu");

  const rowMenu = await evaluate(`(() => {
    const row = [...document.querySelectorAll("#sidebar-body .favorite-item")]
      .find((entry) => (entry.title || "").endsWith("word-sync.md"));
    if (!row) return { open: false, items: [] };
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, button: 2,
      clientX: rect.left + 20, clientY: rect.top + 10,
    }));
    const menu = document.querySelector(".favorite-menu");
    return {
      open: Boolean(menu),
      items: menu
        ? [...menu.querySelectorAll(".favorite-menu-item")].map((button) => ({
            action: button.dataset.action,
            label: button.textContent,
          }))
        : [],
    };
  })()`);
  check(
    rowMenu.open &&
      rowMenu.items.map((item) => item.label).join("|") === "Open|Remove from Favorites",
    "right-clicking a row offers Open and Remove from Favorites",
    JSON.stringify(rowMenu.items),
  );
  const rowRemoved = await evaluate(`(() => {
    const button = document.querySelector('.favorite-menu-item[data-action="remove"]');
    if (!button) return "missing";
    button.click();
    return "clicked";
  })()`);
  await sleep(700);
  stored = await favorites();
  check(
    rowRemoved === "clicked" && stored.length === 1 && stored[0].endsWith("feature-tour.md"),
    "the row menu removes only the clicked entry",
    JSON.stringify(stored),
  );
  check(
    (await evaluate(`document.querySelector("#sidebar-body .sidebar-footer") === null`)) &&
      !(await evaluate(
        `[...document.querySelectorAll("#sidebar-body button")].some(
          (button) => /clear/i.test(button.textContent),
        )`,
      )),
    "the Favorites panel has no Clear All and no footer",
  );

  // -------------------------------------------------------------------------
  // A missing file stays, and explains itself
  // -------------------------------------------------------------------------
  console.log("\n=== a missing favorite ===");
  writeFileSync(missingPath, "# Missing\n\nbody\n");
  await emitOpenFiles([missingPath]);
  await sleep(1800);
  check((await activeTab()) === "missing.md", "the temporary document opens");
  await rightClickTab("missing.md");
  await sleep(150);
  await chooseTab("favorite");
  await sleep(700);
  check(
    (await favorites()).some((entry) => entry.endsWith("missing.md")),
    "the temporary document is favorited",
  );
  check((await closeTab("missing.md")) === "clicked", "its tab is closed again");
  await sleep(700);
  rmSync(missingPath);

  check((await clickFavorite("missing.md")) === "clicked", "the missing row is clickable");
  await sleep(900);
  stored = await favorites();
  check(
    stored.some((entry) => entry.endsWith("missing.md")) &&
      (await evaluate(`[...document.querySelectorAll("#sidebar-body .favorite-item")].some(
        (row) => (row.title || "").endsWith("missing.md"),
      )`)),
    "a missing file is kept in the list",
  );
  check((await toast()).length > 0, "opening it reports the failure in a toast", await toast());
  if ((await removeFavorite("missing.md")) === "clicked") await sleep(500);

  // -------------------------------------------------------------------------
  // Untitled documents cannot be favorited
  // -------------------------------------------------------------------------
  console.log("\n=== untitled ===");
  await emitMenu("file.new");
  await sleep(700);
  check((await activeTab()).startsWith("Untitled"), "Ctrl+N creates an untitled tab");
  check((await rightClickEditor()) === "ok", "its source can be right-clicked");
  await sleep(150);
  menu = await editorMenu();
  check(
    favoriteItem(menu)?.label === "Add to Favorites" &&
      favoriteItem(menu)?.disabled === true &&
      favoriteItem(menu)?.title === "Save the document first.",
    "the editor item is disabled and says why",
    JSON.stringify(favoriteItem(menu) ?? null),
  );
  await closeMenus();
  await sleep(150);
  const untitledName = await activeTab();
  check((await rightClickTab(untitledName)) === "ok", "the untitled tab has a menu");
  await sleep(150);
  menu = await tabMenu();
  check(
    menu.items.find((item) => item.action === "favorite")?.disabled === true &&
      menu.items.find((item) => item.action === "favorite")?.title === "Save the document first.",
    "the tab item is disabled and says why",
    JSON.stringify(menu.items.find((item) => item.action === "favorite") ?? null),
  );
  await closeMenus();
  await emitMenu("file.close");
  await sleep(700);

  // -------------------------------------------------------------------------
  // Preferences and the native menu
  // -------------------------------------------------------------------------
  console.log("\n=== preferences and the menu ===");
  await evaluate(`(() => {
    const overlay = document.querySelector(".prefs-overlay");
    if (!overlay || overlay.hidden) document.getElementById("btn-prefs").click();
    return "ok";
  })()`);
  check(
    await pollFor(
      `(() => {
        const overlay = document.querySelector(".prefs-overlay");
        return Boolean(overlay && !overlay.hidden && document.querySelector(".prefs-section"));
      })()`,
    ),
    "preferences opens",
  );

  await evaluate(`(() => {
    const section = [...document.querySelectorAll(".prefs-section")]
      .find((button) => button.textContent.trim() === "Files");
    section?.click();
    return "ok";
  })()`);
  const filesRows = await evaluate(`(() => {
    const rows = [...document.querySelectorAll(".prefs-row")];
    const label = (row) =>
      (row.querySelector(".prefs-label")?.textContent ?? "").replace("?", "").trim();
    return {
      labels: rows.map(label),
      showHidden: rows.some((row) => label(row) === "Show Hidden Folders and Files"),
    };
  })()`);
  check(
    filesRows.showHidden === false && filesRows.labels.includes("Managing Favorites"),
    "the dead Show Hidden row is gone and a Favorites note explains management",
    filesRows.labels.join(", "),
  );

  await evaluate(`(() => {
    const section = [...document.querySelectorAll(".prefs-section")]
      .find((button) => button.textContent.trim() === "Appearance");
    section?.click();
    return "ok";
  })()`);
  const panelOptions = await evaluate(`(() => {
    const row = [...document.querySelectorAll(".prefs-row")].find(
      (entry) =>
        (entry.querySelector(".prefs-label")?.textContent ?? "").replace("?", "").trim() ===
        "Default Sidebar Panel",
    );
    return row ? [...row.querySelectorAll("select option")].map((option) => option.value) : [];
  })()`);
  check(
    panelOptions.join(",") === "outline,favorites,recent",
    "Default Sidebar Panel offers Favorites instead of File list",
    panelOptions.join(", "),
  );
  await evaluate(`document.getElementById("btn-prefs").click(); "ok"`);
  await sleep(300);

  await evaluate(`document.getElementById("tab-favorites").click(); "ok"`);
  await sleep(500);
  const menuChecks = await invoke("menu_state");
  const favoritesCheck = menuChecks.find((item) => item.id === "view.favorites");
  check(
    favoritesCheck?.checked === true && !menuChecks.some((item) => item.id === "view.files"),
    "the native menu checks Favorites and no longer knows view.files",
    JSON.stringify(favoritesCheck ?? null),
  );

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  failed = checks.filter((entry) => !entry.ok).length;
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
