// Real editor regressions for delayed IO, explicit close decisions and file refusal.
// Run through test-all for an owned profile, or: node scripts/p0-lifecycle-test.mjs [port]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const port = Number(process.argv[2] ?? 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw Error("No page target for P0 lifecycle tests");
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 0;
ws.addEventListener("message", (e) => {
  const response = JSON.parse(e.data),
    resolve = pending.get(response.id);
  if (resolve) {
    pending.delete(response.id);
    resolve(response);
  }
});
await new Promise((resolve) => ws.addEventListener("open", resolve));
function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
await send("Runtime.enable");
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.error || result.result?.exceptionDetails)
    throw Error(
      result.result?.exceptionDetails?.exception?.description ?? JSON.stringify(result.error),
    );
  return result.result.result.value;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(expression, limit = 10000) {
  const until = Date.now() + limit;
  while (Date.now() < until) {
    if (await evaluate(expression)) return true;
    await sleep(80);
  }
  throw Error(`Timed out: ${expression}`);
}
const checks = [];
function check(ok, label, detail = "") {
  checks.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
const invoke = (command, args = {}) =>
  evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
async function action(id) {
  await sleep(280);
  await invoke("plugin:event|emit", { event: "menu", payload: id });
}
const tab = (name) =>
  `[...document.querySelectorAll('.doc-tab')].find(t=>t.querySelector('.doc-tab-name')?.textContent===${JSON.stringify(name)})`;
const text = () =>
  evaluate(`document.querySelector('.cm-content').innerText.replace(/\u200b/g,'').trimEnd()`);
const dirty = (name) => evaluate(`${tab(name)}?.classList.contains('is-dirty')??false`);
const names = () =>
  evaluate(`[...document.querySelectorAll('.doc-tab-name')].map(t=>t.textContent)`);
async function select(name) {
  await evaluate(`${tab(name)}?.click()`);
  await wait(`${tab(name)}?.getAttribute('aria-selected')==='true'`);
}
async function type(value) {
  await sleep(280);
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    modifiers: 2,
    windowsVirtualKeyCode: 65,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    modifiers: 0,
    windowsVirtualKeyCode: 65,
  });
  await send("Input.insertText", { text: value });
}
async function open(file) {
  await invoke("plugin:event|emit", { event: "open-files", payload: [file] });
  await wait(`${tab(path.basename(file))}?.getAttribute('aria-selected')==='true'`);
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), "mdraft-p0-"));
const a = path.join(work, "a.md"),
  b = path.join(work, "b.md"),
  copy = path.join(work, "copy.md"),
  exported = path.join(work, "exported.html");
const pdf = path.join(work, "binary.pdf"),
  utf16 = path.join(work, "utf16.txt"),
  mixed = path.join(work, "mixed.md");
fs.writeFileSync(a, "original A");
fs.writeFileSync(b, "original B");
fs.writeFileSync(pdf, Buffer.from("%PDF-1.7\noriginal\0bytes"));
fs.writeFileSync(utf16, Buffer.from([255, 254, 104, 0, 105, 0]));
fs.writeFileSync(mixed, "Safe document after a binary drop");
let hooksInstalled = false;
try {
  await wait(
    `document.querySelector('.cm-content') && document.title.endsWith(' — MDraft')`,
    60000,
  );
  // All interception lives in this test. Production has no test globals or commands.
  await evaluate(`(() => {
    const state=window.__p0TestOnly={original:window.fetch,messages:[],calls:[],block:null,nextSave:null,failPath:null};
    window.fetch=async function(input,options){
      const url=new URL(typeof input==='string'?input:input.url,location.href);
      if(url.hostname!=='ipc.localhost') return state.original.call(window,input,options);
      const command=decodeURIComponent(url.pathname.slice(1));
      const args=typeof options?.body==='string'?JSON.parse(options.body):{};
      const response=(value,ok=true)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json','Tauri-Response':ok?'ok':'error'}});
      state.calls.push({command,path:args?.path});
      if(command==='plugin:dialog|save') {
        if(state.block?.command===command&&!state.block.entered) {
          state.block.entered=true; await new Promise(resolve=>{state.block.release=resolve});
        }
        const chosen=state.nextSave; state.nextSave=null; return response(chosen);
      }
      if(command==='plugin:dialog|message') { state.messages.push(args.message); return response(args.buttons==='YesNo'?'Yes':'Ok'); }
      if((command==='write_document'||command==='write_document_checked')&&args.path===state.failPath) return response('Injected write failure',false);
      const block=state.block;
      if(block&&command===block.command&&args?.path===block.path&&!block.entered){
        const value=block.after?await state.original.call(window,input,options):undefined;
        block.entered=true; await new Promise(resolve=>{block.release=resolve});
        return block.after?value:state.original.call(window,input,options);
      }
      return state.original.call(window,input,options);
    };
  })()`);
  hooksInstalled = true;
  async function block(command, file, after = false) {
    await evaluate(
      `window.__p0TestOnly.block={command:${JSON.stringify(command)},path:${JSON.stringify(file)},after:${after},entered:false}`,
    );
  }
  const entered = () => wait(`window.__p0TestOnly.block?.entered`);
  const release = () =>
    evaluate(`window.__p0TestOnly.block.release();window.__p0TestOnly.block=null`);
  const journal = () => invoke("list_recovery");
  const dialog = () => wait(`document.querySelector('.unsaved-dialog[open]')`);
  const decide = async (choice) => {
    await evaluate(
      `document.querySelector('.unsaved-dialog [data-decision=${JSON.stringify(choice)}]').click()`,
    );
    if (choice === "cancel") await sleep(280);
  };

  await open(a);
  await type("saved snapshot");
  await block("write_document_checked", a);
  await action("file.save");
  await entered();
  await type("newer typing during save");
  await release();
  await wait(
    `${tab("a.md")}?.classList.contains('is-dirty') && document.getElementById('toast').textContent==='Saved'`,
  );
  check(
    fs.readFileSync(a, "utf8") === "saved snapshot",
    "pending save writes only its captured bytes",
  );
  check((await text()) === "newer typing during save", "typing during save stays visible");
  check(await dirty("a.md"), "newer typing remains marked dirty");
  check(
    (await journal()).some((e) => e.path === a && e.content === "newer typing during save"),
    "newer typing remains in recovery",
  );
  await action("file.save");
  await wait(`!${tab("a.md")}?.classList.contains('is-dirty')`);
  check(
    fs.readFileSync(a, "utf8") === "newer typing during save",
    "second save persists the newest text",
  );
  check(
    !(await journal()).some((e) => e.path === a),
    "saving the current revision removes its recovery entry",
  );

  await block("read_document", a, true);
  fs.writeFileSync(a, "external disk replacement with a different size");
  await entered();
  await type("local typing during reload");
  await release();
  await wait(`document.getElementById('notice-text').textContent.includes('changed on disk')`);
  check(
    (await text()) === "local typing during reload" && (await dirty("a.md")),
    "automatic reload preserves newer local typing",
  );
  await sleep(800);
  check(
    (await journal()).some((e) => e.path === a && e.content === "local typing during reload"),
    "stale reload retains the latest recovery text",
  );
  await evaluate(
    `[...document.querySelectorAll('#notice-actions button')].find(b=>b.textContent==='Keep my version').click()`,
  );
  await wait(
    `document.getElementById('notice-bar').hidden || !document.getElementById('notice-text').textContent.includes('changed on disk')`,
  );
  await action("file.save");
  await wait(`!${tab("a.md")}?.classList.contains('is-dirty')`);

  await open(b);
  await select("a.md");
  await type("A copied snapshot");
  await evaluate(`window.__p0TestOnly.nextSave=${JSON.stringify(copy)}`);
  await block("write_document_checked", copy);
  await action("file.saveAs");
  await entered();
  await select("b.md");
  await type("B independent edits");
  await select("a.md");
  await type("A newer typing during Save As");
  await select("b.md");
  await release();
  await wait(`${tab("copy.md")} && document.getElementById('toast').textContent==='Saved'`);
  check(
    (await text()) === "B independent edits" && (await dirty("b.md")),
    "Save As cannot replace the newly active buffer",
  );
  check(
    await evaluate(`${tab("b.md")}?.getAttribute('aria-selected')==='true'`),
    "Save As keeps the user's active tab",
  );
  check(
    fs.readFileSync(copy, "utf8") === "A copied snapshot",
    "Save As writes A's snapshot, not B's text",
  );
  await select("copy.md");
  check(
    (await text()) === "A newer typing during Save As" && (await dirty("copy.md")),
    "Save As retains newer A text and dirty state",
  );
  check(
    (await journal()).some((e) => e.path === copy && e.content === "A newer typing during Save As"),
    "Save As recovery follows the new path",
  );

  await evaluate(`window.__p0TestOnly.nextSave=${JSON.stringify(exported)}`);
  await block("plugin:dialog|save", undefined);
  await action("export.html");
  await entered();
  await select("b.md");
  await release();
  await wait(`document.getElementById('toast').textContent==='Exported HTML'`);
  const output = fs.readFileSync(exported, "utf8");
  check(
    output.includes("A newer typing during Save As") &&
      output.includes("<title>copy.md</title>") &&
      !output.includes("B independent edits"),
    "HTML export keeps the initiating source and title across a picker tab switch",
  );
  check(
    (await text()) === "B independent edits" && (await dirty("b.md")),
    "export completion preserves the newly active buffer and its dirty state",
  );

  await select("b.md");
  await evaluate(`${tab("b.md")}.querySelector('.doc-tab-close').click()`);
  await dialog();
  check(
    await evaluate(`document.activeElement?.dataset.decision==='cancel'`),
    "unsaved dialog defaults focus to Cancel",
  );
  check(
    await evaluate(
      `[...document.querySelectorAll('.unsaved-dialog button')].map(b=>b.textContent).sort().join(',')==='Cancel,Discard,Save'`,
    ),
    "close offers three explicit choices",
  );
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await wait(`!document.querySelector('.unsaved-dialog')`);
  check(await dirty("b.md"), "Escape cancels tab close without discarding");

  // The cancelled close still flushes recovery before releasing its close gate.
  await sleep(280);
  await evaluate(`${tab("b.md")}.querySelector('.doc-tab-close').click()`);
  await dialog();
  await invoke("plugin:window|close", { label: "main" });
  await wait(`!document.querySelector('.unsaved-dialog')`);
  check(await dirty("b.md"), "native window close dismisses an existing prompt as Cancel");
  await sleep(280);
  await invoke("plugin:window|close", { label: "main" });
  await dialog();
  await decide("cancel");
  await wait(`!document.querySelector('.unsaved-dialog')`);
  check(
    (await dirty("b.md")) && (await journal()).some((e) => e.path === b),
    "Cancel keeps a dirty native window and its recovery open",
  );

  const before = await names();
  await action("file.closeAll");
  await dialog();
  await decide("discard");
  await dialog();
  await decide("cancel");
  await wait(`!document.querySelector('.unsaved-dialog')`);
  check(
    JSON.stringify(await names()) === JSON.stringify(before),
    "bulk Cancel keeps every tab after an earlier Discard choice",
  );
  check(
    (await journal()).some((e) => e.path === copy),
    "bulk Cancel does not commit earlier recovery removal",
  );

  await evaluate(
    `window.__p0TestOnly.failPath=${JSON.stringify(b)};${tab("b.md")}.querySelector('.doc-tab-close').click()`,
  );
  await dialog();
  await decide("save");
  await wait(
    `window.__p0TestOnly.messages.some(m=>m.includes('Injected write failure')) || document.getElementById('toast').textContent.includes('Injected write failure')`,
  );
  check(
    (await dirty("b.md")) && fs.readFileSync(b, "utf8") === "original B",
    "failed close-save preserves the buffer and disk bytes",
  );
  await evaluate(`window.__p0TestOnly.failPath=null`);

  const tabCount = (await names()).length;
  await invoke("plugin:event|emit", { event: "open-files", payload: [pdf] });
  await wait(
    `document.getElementById('toast').textContent.includes('binary/non-text') || window.__p0TestOnly.messages.some(m=>m.includes('binary/non-text'))`,
  );
  check((await names()).length === tabCount, "opening a PDF cannot create an editable text tab");
  const refused = await evaluate(
    `window.__TAURI_INTERNALS__.invoke('write_document',${JSON.stringify({ path: pdf, content: "replacement", lineEnding: "\n", hadBom: false })}).then(()=>'',e=>String(e))`,
  );
  check(
    refused.includes("Refusing to overwrite") && fs.readFileSync(pdf).includes(0),
    "binary destination refuses replacement without changing bytes",
  );
  const encoding = await evaluate(
    `window.__TAURI_INTERNALS__.invoke('read_document',{path:${JSON.stringify(utf16)}}).then(()=>'',e=>String(e))`,
  );
  check(
    encoding.includes("UTF-16") && !encoding.includes("binary/non-text"),
    "UTF-16 gets an encoding explanation before NUL classification",
  );
  await invoke("plugin:event|emit", {
    event: "tauri://drag-drop",
    payload: { paths: [pdf, mixed], position: { x: 100, y: 100 } },
  });
  await wait(`${tab("mixed.md")}?.getAttribute('aria-selected')==='true'`);
  check(
    (await text()) === "Safe document after a binary drop" &&
      !(await names()).includes("binary.pdf") &&
      (await dirty("b.md")),
    "mixed native drop refuses binary input and opens the valid document",
  );

  // The stat guard cannot see a same-size rewrite whose timestamp was put back.
  // The content guard must refuse it and offer the normal conflict actions.
  const beforeStat = await invoke("stat_document", { path: mixed });
  const replacement = Buffer.alloc(fs.statSync(mixed).size, 0x58);
  fs.writeFileSync(mixed, replacement);
  fs.utimesSync(mixed, new Date(beforeStat.modifiedMs), new Date(beforeStat.modifiedMs));
  const afterStat = await invoke("stat_document", { path: mixed });
  check(
    afterStat.size === beforeStat.size && afterStat.modifiedMs === beforeStat.modifiedMs,
    "the external rewrite preserved both size and modification time",
  );
  await type("local text after a same-metadata rewrite");
  await action("file.save");
  await wait(`document.getElementById('notice-text').textContent.includes('changed on disk')`);
  check(
    fs.readFileSync(mixed).equals(replacement),
    "a same-size same-mtime rewrite is refused, not overwritten",
  );
  check(await dirty("mixed.md"), "the refused save keeps the buffer dirty");
  await sleep(3200);
  check(
    await evaluate(
      `!document.getElementById('notice-bar').hidden && document.getElementById('notice-text').textContent.includes('changed on disk')`,
    ),
    "the hash conflict survives the next unchanged-stat poll",
  );
  await evaluate(
    `[...document.querySelectorAll('#notice-actions button')].find(b=>b.textContent==='Keep my version').click()`,
  );
  await wait(
    `document.getElementById('notice-bar').hidden || !document.getElementById('notice-text').textContent.includes('changed on disk')`,
  );
  await action("file.save");
  await wait(`!${tab("mixed.md")}?.classList.contains('is-dirty')`);
  check(
    fs.readFileSync(mixed, "utf8") === "local text after a same-metadata rewrite",
    "Keep my version adopts the observed revision and the next save writes",
  );

  await action("file.closeAll");
  for (let n = 0; n < 10; n++) {
    if (await evaluate(`!!document.querySelector('.unsaved-dialog[open]')`))
      await decide("discard");
    if ((await names()).length === 1 && (await names())[0] === "Untitled") break;
    await sleep(100);
  }
  await wait(
    `document.querySelector('.cm-content')===document.activeElement && !document.body.inert`,
  );
  check(true, "closing the final dirty tabs restores keyboard focus to the editor");
  await action("help.licences");
  await wait(`document.querySelector('.cm-line')?.textContent==='# Bundled typefaces'`);
  await sleep(800);
  check(
    !(await evaluate(`!!document.querySelector('.doc-tab.is-dirty')`)) &&
      (await journal()).length === 0,
    "bundled CRLF documents open clean without creating recovery work",
  );
} catch (error) {
  try {
    console.error(
      "diagnostics",
      await evaluate(
        `JSON.stringify({calls:window.__p0TestOnly?.calls.slice(-25),messages:window.__p0TestOnly?.messages,block:window.__p0TestOnly?.block,title:document.title,text:document.querySelector('.cm-content')?.innerText,tabs:[...document.querySelectorAll('.doc-tab')].map(t=>({name:t.textContent,path:t.title,dirty:t.classList.contains('is-dirty')})),toast:document.getElementById('toast').textContent})`,
      ),
    );
  } catch {}
  console.error(error.stack ?? error);
  check(false, "P0 lifecycle suite completed", String(error));
} finally {
  if (hooksInstalled) {
    try {
      await evaluate(
        `window.__p0TestOnly.block?.release?.();window.__p0TestOnly.block=null;window.__p0TestOnly.failPath=null`,
      );
      await sleep(300);
      await action("file.closeAll");
      for (let n = 0; n < 20; n++) {
        if (await evaluate(`!!document.querySelector('.unsaved-dialog[open]')`))
          await evaluate(
            `document.querySelector('.unsaved-dialog [data-decision="discard"]').click()`,
          );
        await sleep(100);
      }
      await evaluate(`window.fetch=window.__p0TestOnly.original;delete window.__p0TestOnly`);
    } catch (error) {
      console.error("cleanup:", String(error));
    }
  }
  if (checks.every(Boolean)) {
    let closed = false;
    ws.addEventListener("close", () => {
      closed = true;
    });
    await evaluate(`(() => {
      window.__closeTrace=[];
      window.__closeOriginal=window.fetch;
      const original=window.fetch;
      window.fetch=async (...args)=>{
        window.__closeTrace.push(String(args[0]));
        return original(...args);
      };
      void window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'});
    })()`);
    for (let n = 0; n < 100 && !closed; n++) await sleep(100);
    if (!closed)
      console.error(
        "close diagnostics",
        await evaluate(
          `JSON.stringify({calls:window.__closeTrace,inert:document.body.inert,dialog:document.querySelector('.unsaved-dialog')?.textContent,toast:document.getElementById('toast').textContent})`,
        ),
      );
    if (!closed)
      await evaluate(
        `window.fetch=window.__closeOriginal;delete window.__closeOriginal;delete window.__closeTrace`,
      );
    check(closed, "clean native window close completes after lifecycle checks");
  }
  ws.close();
  const resolved = path.resolve(work),
    root = path.resolve(os.tmpdir());
  if (resolved.startsWith(root + path.sep) && path.basename(resolved).startsWith("mdraft-p0-"))
    fs.rmSync(resolved, { recursive: true, force: true });
}
const passed = checks.filter(Boolean).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
