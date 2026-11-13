// The Explorer in the running application (Track W, GAP-006 slice 1).
//
//   node scripts/workspace-explorer-test.mjs <port>
//
// The harness launches MDraft with samples/latex-perf/huge/main.tex. The native
// folder picker is stubbed at the IPC transport (window.fetch), the same way
// latex-preview stubs the save dialog; everything after it runs for real:
// `workspace_open`, `workspace_list`, settings, the sidebar tab and the menu
// state. Read-only: the fixture is never written.

import { join } from "node:path";
import { openPage, sleep } from "./cdp-page.mjs";

const port = process.argv[2] ?? "9222";
const page = await openPage(port);
const evaluate = (expression) => page.evaluate(expression);
let failed = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
async function waitFor(expression, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return true;
    } catch {
      // The sidebar may be redrawing.
    }
    await sleep(100);
  }
  console.log(`  (timed out after ${timeout / 1000}s waiting for ${label})`);
  return false;
}
const emitMenu = (id) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit",{event:"menu",payload:${JSON.stringify(id)}})`,
  );
const project = join(process.cwd(), "samples", "latex-perf", "huge");

try {
  await waitFor('!!document.querySelector(".cm-content")', 30_000, "the editor");
  await evaluate(`(() => {
    const state = (window.__explorerTest = { original: window.fetch, folder: null, picks: 0 });
    window.fetch = async function (input, options) {
      const url = new URL(typeof input === "string" ? input : input.url, location.href);
      if (url.hostname !== "ipc.localhost") return state.original.call(window, input, options);
      const command = decodeURIComponent(url.pathname.slice(1));
      if (command === "plugin:dialog|open") {
        state.picks += 1;
        return new Response(JSON.stringify(state.folder), {
          headers: { "Content-Type": "application/json", "Tauri-Response": "ok" },
        });
      }
      return state.original.call(window, input, options);
    };
  })()`);

  // Before any folder: the Explorer explains how to open one.
  await evaluate(`document.getElementById("tab-explorer").click()`);
  check(
    "the Explorer tab without a folder offers Open Folder",
    await waitFor(
      `/No folder is open/.test(document.getElementById("sidebar-body")?.textContent ?? "")`,
      5000,
      "the empty state",
    ),
  );

  // File › Open Folder… with the picker stubbed to the fixture project.
  await evaluate(`window.__explorerTest.folder = ${JSON.stringify(project)}`);
  await emitMenu("file.openFolder");
  const listed = await waitFor(
    `[...document.querySelectorAll("#sidebar-body .explorer-item")].some((e) => e.textContent.includes("chapters"))`,
    10_000,
    "the folder listing",
  );
  check("File › Open Folder lists the project", listed);
  const names = await evaluate(
    `JSON.stringify([...document.querySelectorAll("#sidebar-body .explorer-item")].map((e) => e.textContent.trim().slice(1)))`,
  ).then(JSON.parse);
  check(
    "folders come first, then files",
    names[0] === "chapters" && names[1] === "figures" && names.includes("main.tex"),
    JSON.stringify(names),
  );
  check(
    "the active document is highlighted",
    await evaluate(
      `document.querySelector("#sidebar-body .explorer-item.active")?.textContent.includes("main.tex") ?? false`,
    ),
  );
  const settings = await evaluate(
    `window.__TAURI_INTERNALS__.invoke("get_settings").then(JSON.stringify)`,
  ).then(JSON.parse);
  check(
    "the folder and the Explorer tab are remembered in settings",
    settings.sidebarTab === "explorer" &&
      /latex-perf[\\/]huge$/i.test(settings.workspaceFolder ?? ""),
    `${settings.sidebarTab} ${settings.workspaceFolder}`,
  );
  const menu = await evaluate(
    `window.__TAURI_INTERNALS__.invoke("menu_items").then(JSON.stringify)`,
  ).then(JSON.parse);
  const closeItem = menu.find((item) => item.id === "file.closeFolder");
  const explorerItem = menu.find((item) => item.id === "view.explorer");
  check(
    "File › Close Folder is enabled with a folder open",
    closeItem?.enabled === true,
    JSON.stringify(closeItem),
  );
  check("View › Explorer is checked", explorerItem?.checked === true, JSON.stringify(explorerItem));

  // Expand chapters with the keyboard and open a chapter with Enter.
  await evaluate(`(() => {
    const item = [...document.querySelectorAll("#sidebar-body .explorer-item")].find((e) => e.textContent.includes("chapters"));
    item.focus();
    item.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  })()`);
  check(
    "ArrowRight expands a folder lazily",
    await waitFor(
      `[...document.querySelectorAll("#sidebar-body .explorer-item")].some((e) => e.textContent.includes("ch06.tex"))`,
      5000,
      "the chapters listing",
    ),
  );
  const order = await evaluate(
    `JSON.stringify([...document.querySelectorAll("#sidebar-body .explorer-item[aria-level='2']")].map((e) => e.textContent.trim().slice(1)))`,
  ).then(JSON.parse);
  check(
    "chapter names sort by number",
    order.indexOf("ch02.tex") < order.indexOf("ch10.tex"),
    order.slice(0, 4).join(", "),
  );
  await evaluate(`(() => {
    const item = [...document.querySelectorAll("#sidebar-body .explorer-item")].find((e) => e.textContent.includes("ch06.tex"));
    item.focus();
    item.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  })()`);
  check(
    "Enter opens the chapter in a tab",
    await waitFor(
      `document.querySelector(".cm-content")?.cmTile?.root?.view?.state.doc.toString().includes("probe paragraph C06") ?? false`,
      10_000,
      "the chapter in the editor",
    ),
  );
  check(
    "the opened chapter becomes the highlighted row",
    await waitFor(
      `document.querySelector("#sidebar-body .explorer-item.active")?.textContent.includes("ch06.tex") ?? false`,
      5000,
      "the highlight to move",
    ),
  );

  // Build output stays hidden unless asked for.
  const hidden = await evaluate(
    `[...document.querySelectorAll("#sidebar-body .explorer-item")].every((e) => !/\\.(aux|log|synctex\\.gz)$/.test(e.textContent.trim()))`,
  );
  check("TeX auxiliary files are not listed by default", hidden);

  // A path outside the workspace is refused by the command itself.
  const refused = await evaluate(
    `window.__TAURI_INTERNALS__.invoke("workspace_list", { root: ${JSON.stringify(project)}, relative: "..", showAll: false }).then(() => "listed", (e) => String(e))`,
  );
  check("listing outside the workspace is refused", /outside the workspace/.test(refused), refused);
  const driveRoot = process.platform === "win32" ? "C:\\" : "/";
  const rootRefused = await evaluate(
    `window.__TAURI_INTERNALS__.invoke("workspace_open", { path: ${JSON.stringify(driveRoot)} }).then(() => "opened", (e) => String(e))`,
  );
  check("a drive root cannot be a workspace", /root/.test(rootRefused), rootRefused);

  // Main-document rule 4: the include graph names main.tex for a chapter.
  const chapter = join(project, "chapters", "ch06.tex");
  const candidates = await evaluate(
    `window.__TAURI_INTERNALS__.invoke("workspace_main_candidates", { root: ${JSON.stringify(project)}, path: ${JSON.stringify(chapter)} }).then(JSON.stringify)`,
  ).then(JSON.parse);
  check(
    "the include graph finds the chapter's one main document",
    candidates.length === 1 && /main\.tex$/.test(candidates[0]),
    JSON.stringify(candidates),
  );

  // Main-document rule 2: Set as Main Document from the row menu.
  await evaluate(`(() => {
    const item = [...document.querySelectorAll("#sidebar-body .explorer-item")].find((e) => e.textContent.trim().endsWith("main.tex"));
    item.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 80 }));
  })()`);
  const menuItems = await evaluate(
    `JSON.stringify([...document.querySelectorAll(".explorer-menu .favorite-menu-item")].map((b) => b.textContent))`,
  ).then(JSON.parse);
  check(
    "a .tex row offers Set as Main Document",
    menuItems.includes("Set as Main Document"),
    JSON.stringify(menuItems),
  );
  await evaluate(
    `[...document.querySelectorAll(".explorer-menu .favorite-menu-item")].find((b) => b.textContent === "Set as Main Document")?.click()`,
  );
  check(
    "the Explorer names the folder's main document",
    await waitFor(
      `/Main document: main\\.tex/.test(document.querySelector("#sidebar-body .explorer-main")?.textContent ?? "")`,
      5000,
      "the main-document line",
    ),
  );
  const chosen = await evaluate(
    `window.__TAURI_INTERNALS__.invoke("get_settings").then(JSON.stringify)`,
  ).then(JSON.parse);
  check(
    "the choice is remembered per folder",
    (chosen.latexMainDocuments ?? []).some((entry) => /main\.tex$/.test(entry.path)),
    JSON.stringify(chosen.latexMainDocuments),
  );
  await evaluate(`document.querySelector("#sidebar-body .explorer-main .explorer-link")?.click()`);
  check(
    "Clear forgets the main document",
    await waitFor(
      `!document.querySelector("#sidebar-body .explorer-main")`,
      5000,
      "the line to go",
    ),
  );

  // Track W2: a Typst chapter inside the workspace imports `../template.typ`,
  // which only resolves when Typst's root is the workspace folder.
  const typst = await evaluate(
    `window.__TAURI_INTERNALS__.invoke("typst_status").then(JSON.stringify)`,
  ).then(JSON.parse);
  if (!typst.found) {
    console.log("SKIP  Typst workspace root (Typst is not installed)");
  } else {
    const typstProject = join(process.cwd(), "samples", "workspace-typst");
    await evaluate(`window.__explorerTest.folder = ${JSON.stringify(typstProject)}`);
    await emitMenu("file.openFolder");
    await waitFor(
      `[...document.querySelectorAll("#sidebar-body .explorer-item")].some((e) => e.textContent.includes("template.typ"))`,
      10_000,
      "the Typst workspace",
    );
    await evaluate(
      `window.__TAURI_INTERNALS__.invoke("plugin:event|emit",{event:"open-files",payload:${JSON.stringify([join(typstProject, "chapters", "one.typ")])}})`,
    );
    const rendered = await waitFor(
      `/Greeting from the template, chapter one/.test(document.getElementById("preview")?.textContent ?? "")`,
      60_000,
      "the chapter rendered with its template",
    );
    // On failure, say what was on screen: the tab, the status line and the preview.
    const seen = rendered
      ? ""
      : await evaluate(
          `JSON.stringify({ tab: document.querySelector(".doc-tab.active, .doc-tab[aria-selected=true]")?.textContent, status: document.getElementById("statusbar")?.textContent?.replace(/\\s+/g, " ").slice(0, 300), preview: document.getElementById("preview")?.textContent?.replace(/\\s+/g, " ").slice(0, 400) })`,
        );
    check("a Typst chapter imports the workspace's template", rendered, seen);
  }

  // File › Close Folder.
  await emitMenu("file.closeFolder");
  check(
    "Close Folder returns the Explorer to its empty state",
    await waitFor(
      `/No folder is open/.test(document.getElementById("sidebar-body")?.textContent ?? "")`,
      5000,
      "the empty state",
    ),
  );
  const after = await evaluate(
    `window.__TAURI_INTERNALS__.invoke("get_settings").then(JSON.stringify)`,
  ).then(JSON.parse);
  check(
    "the folder is forgotten in settings",
    !after.workspaceFolder,
    String(after.workspaceFolder),
  );
} catch (error) {
  failed += 1;
  console.log(`FAIL  ${error.message}`);
} finally {
  await evaluate("window.__explorerTest && (window.fetch = window.__explorerTest.original)").catch(
    () => {},
  );
  page.close();
}
console.log(`\n${failed ? "some" : "all"} checks done; ${failed} failed`);
process.exit(failed ? 1 : 0);
