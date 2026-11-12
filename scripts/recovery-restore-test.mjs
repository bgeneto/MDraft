// Crash recovery and the startup slot across a real restart (audit F1, F3).
//
//   node scripts/recovery-restore-test.mjs <port> phase1
//   node scripts/recovery-restore-test.mjs <port> phase2
//
// Run through `npm test -- --only recovery-restore`, which owns the settings
// directory and launches the binary twice. Between the phases it closes the
// window with WM_CLOSE and starts it again without a document argument.
//
// Phase 1 opens first.md, a.md and b.md, activates a.md, sets On Launch to
// "Reopen the last tabs" and writes two journal entries the way a crash leaves
// them: one for a.md, then a newer one for b.md. Last, it rewrites first.md
// with binary bytes, so the remembered set's first path still exists but cannot
// be read.
//
// Phase 2 is the state the audit described. a.md is restored on screen and
// b.md behind it, and the newest journal entry belongs to the hidden b.md, so
// recovery activates b.md first. The checks: neither draft is replaced by disk
// text, the tab strip and the store agree, the failed first path leaves no
// blank tab, and saving a.md writes its draft and removes only its own entry.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = process.argv[2] ?? "9222";
const phase = process.argv[3] ?? "";
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
async function pollFor(expression, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await sleep(150);
  }
  return false;
}
let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}
const invoke = (command, args = {}) =>
  evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
const emitMenu = (id) => invoke("plugin:event|emit", { event: "menu", payload: id });
const tab = (name) =>
  `[...document.querySelectorAll('.doc-tab')].find(t=>t.querySelector('.doc-tab-name')?.textContent===${JSON.stringify(name)})`;
const names = () =>
  evaluate(`[...document.querySelectorAll('.doc-tab-name')].map(t=>t.textContent)`);
const active = () =>
  evaluate(
    `document.querySelector('.doc-tab[aria-selected="true"] .doc-tab-name')?.textContent ?? ''`,
  );
const text = () =>
  evaluate(`document.querySelector('.cm-content').innerText.replace(/​/g,'').trimEnd()`);
const dirty = (name) => evaluate(`${tab(name)}?.classList.contains('is-dirty')??false`);
async function select(name) {
  await evaluate(`${tab(name)}?.click()`);
  await pollFor(`${tab(name)}?.getAttribute('aria-selected')==='true'`);
  await sleep(200);
}

// Both phases share the harness's per-suite TEMP, which is where the fixtures
// and the note telling phase 2 about them live.
const work = path.join(os.tmpdir(), "mdraft-recovery-restore");
const files = {
  first: path.join(work, "first.md"),
  a: path.join(work, "a.md"),
  b: path.join(work, "b.md"),
};

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

async function journalEntry(id, file, content) {
  const stat = await invoke("stat_document", { path: file });
  return {
    id,
    path: file,
    name: path.basename(file),
    language: "markdown",
    content,
    lineEnding: "\n",
    hadBom: false,
    encoding: "UTF-8",
    lossy: false,
    readOnly: false,
    baseModifiedMs: stat.modifiedMs,
    baseSize: stat.size,
    baseSha256: stat.sha256 ?? null,
    updatedMs: 0,
  };
}

try {
  await pollFor(
    `document.querySelector('.cm-content') && document.title.endsWith(' — MDraft')`,
    60000,
  );
  await sleep(600);

  if (phase === "phase1") {
    console.log("=== phase 1: open three documents and leave two journal entries ===");
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(files.first, "first on disk\n");
    fs.writeFileSync(files.a, "disk A\n");
    fs.writeFileSync(files.b, "disk B\n");
    for (const file of [files.first, files.a, files.b]) {
      await invoke("plugin:event|emit", { event: "open-files", payload: [file] });
      await pollFor(`${tab(path.basename(file))}?.getAttribute('aria-selected')==='true'`);
    }
    // The harness launches phase 1 with its own document; left open, it would
    // become the remembered set's first path instead of the unreadable first.md.
    const launched = await evaluate(
      `[...document.querySelectorAll('.doc-tab-name')].map(t=>t.textContent).find(n=>!['first.md','a.md','b.md'].includes(n)) ?? ''`,
    );
    if (launched) {
      await evaluate(`${tab(launched)}.querySelector('.doc-tab-close').click()`);
      await pollFor(`!${tab(launched)}`, 4000);
    }
    check(
      "only the three fixtures are remembered",
      JSON.stringify(await names()) === JSON.stringify(["first.md", "a.md", "b.md"]),
      JSON.stringify(await names()),
    );
    await select("a.md");
    check("a.md is the active remembered tab", (await active()) === "a.md", await active());
    check('On Launch holds "tabs"', (await setOnLaunch("tabs")) === "tabs");

    // Older first, newer second: Rust stamps `updatedMs` on write.
    await invoke("write_recovery", {
      entry: await journalEntry("restore-a", files.a, "draft A\n"),
    });
    await sleep(60);
    await invoke("write_recovery", {
      entry: await journalEntry("restore-b", files.b, "draft B\n"),
    });
    const journal = await invoke("list_recovery");
    check(
      "two journal entries are waiting, b.md the newer",
      journal.length === 2 &&
        journal.find((e) => e.id === "restore-b").updatedMs >
          journal.find((e) => e.id === "restore-a").updatedMs,
      JSON.stringify(journal.map((e) => [e.id, e.updatedMs])),
    );

    // Still present, so the remembered set keeps it, but no longer text.
    fs.writeFileSync(files.first, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02]));
    await sleep(1800); // one tab-memory interval, so the set is written before the close
  } else {
    console.log("=== phase 2: restore the tabs, then the journal ===");
    await pollFor(`document.querySelectorAll('.doc-tab').length >= 2`, 15000);
    await sleep(1200);
    check(
      "the unreadable first tab leaves no blank tab behind",
      JSON.stringify(await names()) === JSON.stringify(["a.md", "b.md"]),
      JSON.stringify(await names()),
    );
    check("the newest recovered tab is shown", (await active()) === "b.md", await active());
    check("b.md shows its recovered draft", (await text()) === "draft B", await text());
    check("both recovered tabs are dirty", (await dirty("a.md")) && (await dirty("b.md")));

    await select("a.md");
    check(
      "the tab that was on screen during recovery kept its draft, not disk text",
      (await text()) === "draft A",
      await text(),
    );
    await emitMenu("file.nextTab");
    await pollFor(`${tab("b.md")}?.getAttribute('aria-selected')==='true'`, 3000);
    check("Next Tab moves from the tab on screen", (await active()) === "b.md", await active());
    await select("a.md");
    await emitMenu("file.save");
    await pollFor(`!${tab("a.md")}?.classList.contains('is-dirty')`, 6000);
    check(
      "saving the recovered tab writes its draft",
      fs.readFileSync(files.a, "utf8") === "draft A\n",
      JSON.stringify(fs.readFileSync(files.a, "utf8")),
    );
    await sleep(400);
    const journal = await invoke("list_recovery");
    check(
      "the save removes only its own journal entry",
      !journal.some((e) => e.path === files.a) &&
        journal.some((e) => e.path === files.b && e.content === "draft B\n"),
      JSON.stringify(journal.map((e) => e.id)),
    );

    // Leave a clean profile: discard the remaining recovered draft.
    await evaluate(`${tab("b.md")}.querySelector('.doc-tab-close').click()`);
    if (await pollFor(`!!document.querySelector('.unsaved-dialog[open]')`, 3000)) {
      await evaluate(`document.querySelector('.unsaved-dialog [data-decision="discard"]').click()`);
    }
    await pollFor(`!${tab("b.md")}`, 4000);
    check(
      "discarding the other recovered tab clears the journal",
      (await invoke("list_recovery")).length === 0,
    );
    fs.rmSync(work, { recursive: true, force: true });
  }
} catch (error) {
  failed += 1;
  console.log(`  FAIL  ${phase} aborted: ${error?.message ?? error}`);
} finally {
  ws.close();
  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}
