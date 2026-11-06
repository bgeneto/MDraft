//! Native before/after probe: a key is queued shortly after a quiet edit.
//! Run through `npm test -- --only preview-compare --no-build --verbose`.
//! The fixture matches scripts/preview-performance-test.mjs (1.2 MB).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = process.argv[2] ?? "9222";
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((target) => target.type === "page");
if (!page) throw new Error("No WebView2 page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 0;
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id);
  if (message.error) item.reject(new Error(JSON.stringify(message.error)));
  else item.resolve(message.result);
});
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
await send("Runtime.enable");
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await sleep(100);
  }
  return false;
}
let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` (${detail})` : ""}`);
  if (condition) passed += 1;
  else failed += 1;
}

function documentFixture() {
  const words =
    "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu document editor preview source paragraph section heading formula table code".split(" ");
  const parts = ["# Preview performance\n\n"];
  for (let i = 0; i < 6000; i += 1) {
    let sentence = "";
    for (let w = 0; w < 30; w += 1) sentence += `${words[(i * 7 + w * 13) % words.length]} `;
    parts.push(`${sentence.trim().replace(/^./, (character) => character.toUpperCase())}.\n\n`);
    if (i % 25 === 0) parts.push(`## Section ${Math.floor(i / 25)}\n\n`);
    if (i % 120 === 0) parts.push("Inline math $a^2 + b^2 = c^2$ with **bold** and `code`.\n\n");
    if (i % 200 === 0) parts.push("```js\nconst value = items.map((item) => item * 2);\n```\n\n");
  }
  return parts.join("");
}

const tempRoot = path.resolve(os.tmpdir());
const directory = fs.mkdtempSync(path.join(tempRoot, "mdraft-preview-compare-"));
const file = path.join(directory, "preview-native-compare.md");
fs.writeFileSync(file, documentFixture(), "utf8");
const fixtureBytes = fs.statSync(file).size;

try {
  await evaluate(`(() => {
    const p=window.__nativeCompare={events:[],inputs:0,tasks:[],active:new Map()};
    const seen=new WeakSet(), post=Worker.prototype.postMessage, terminate=Worker.prototype.terminate;
    Worker.prototype.postMessage=function(message,...rest){
      if(typeof message?.id==='number' && typeof message.source==='string'){
        if(!seen.has(this)){seen.add(this);this.addEventListener('message',e=>{
          if(p.active.get(this)===e.data?.id)p.active.delete(this);
        });}
        p.active.set(this,message.id);
      }
      return post.call(this,message,...rest);
    };
    Worker.prototype.terminate=function(){p.active.delete(this);return terminate.call(this);};
    window.addEventListener('keydown',e=>{
      if(e.target?.closest?.('.cm-content'))p.events.push({key:e.key,at:e.timeStamp,
        age:Math.max(0,performance.now()-e.timeStamp),worker:p.active.size>0});
    },true);
    window.addEventListener('input',e=>{if(e.target?.closest?.('.cm-content'))p.inputs++;},true);
    p.longSupported=(PerformanceObserver.supportedEntryTypes??[]).includes('longtask');
    if(p.longSupported)new PerformanceObserver(list=>{
      for(const entry of list.getEntries())p.tasks.push({start:entry.startTime,duration:entry.duration});
    }).observe({entryTypes:['longtask']});
  })()`);
  const invoke = (command, args) =>
    evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
  const key = async (character) => {
    const timestamp = Date.now() / 1000;
    const common = { key: character, code: `Key${character.toUpperCase()}`,
      windowsVirtualKeyCode: character.toUpperCase().charCodeAt(0), timestamp };
    await Promise.all([
      send("Input.dispatchKeyEvent", { ...common, type: "keyDown" }),
      send("Input.dispatchKeyEvent", { ...common, type: "char", text: character, unmodifiedText: character }),
      send("Input.dispatchKeyEvent", { ...common, type: "keyUp" }),
    ]);
  };
  await invoke("plugin:event|emit", { event: "open-files", payload: [file] });
  check("the fixture opens", await waitFor(`document.title.includes('preview-native-compare.md')`, 30000));
  check("the initial preview is ready", await waitFor(`document.querySelectorAll('#preview > *').length > 500`, 30000));
  await sleep(900);
  await evaluate(`document.querySelector('.cm-content').focus();window.__nativeCompare.events=[];window.__nativeCompare.inputs=0;window.__nativeCompare.tasks=[]`);

  // Each 'a' begins a quiet period; 'b' is sent after the 200 ms Markdown
  // debounce. Explicit CDP timestamps expose time spent waiting in the UI queue.
  for (let i = 0; i < 20; i += 1) {
    await key("a");
    await sleep(220);
    await key("b");
  }
  await sleep(500);
  const result = await evaluate(`(() => {
    const p=window.__nativeCompare, victims=p.events.filter(e=>e.key==='b');
    const sorted=victims.map(e=>e.age).sort((a,b)=>a-b);
    const percentile=q=>sorted.length?sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*q)-1)]:null;
    const duringTask=victims.filter(e=>p.tasks.some(t=>e.at>=t.start&&e.at<t.start+t.duration)).length;
    return {samples:sorted.length, inputs:p.inputs, p50:percentile(.5),p95:percentile(.95),
      p99:percentile(.99),max:sorted.at(-1)??null,workerOverlap:victims.filter(e=>e.worker).length,
      longTaskOverlap:duringTask,longSupported:p.longSupported,
      longest:p.tasks.length?Math.max(...p.tasks.map(t=>t.duration)):null, ages:sorted};
  })()`);
  check("twenty delayed keys reached the editor", result.samples === 20 && result.inputs >= 40, JSON.stringify(result));
  check("Long Task timing is available", result.longSupported);
  const expected = "ab".repeat(20);
  check("the final preview contains the final edits", await waitFor(`document.querySelector('#preview')?.textContent.includes(${JSON.stringify(expected)})`, 120000));

  // Independent positive control verifies the wall-clock timestamp conversion.
  await invoke("plugin:event|emit", { event: "menu", payload: "view.source" });
  await evaluate(`document.querySelector('.cm-content').focus();window.__nativeCompare.events=[];window.__nativeCompare.inputs=0`);
  await evaluate(`setTimeout(()=>{const end=performance.now()+350;while(performance.now()<end){}},100);true`);
  await sleep(120);
  const controls = [];
  for (let i = 0; i < 20; i += 1) controls.push(key("c"));
  await Promise.all(controls);
  const control = await evaluate(`({count:window.__nativeCompare.events.length,inputs:window.__nativeCompare.inputs,
    max:Math.max(...window.__nativeCompare.events.map(e=>e.age))})`);
  check("the probe detects an intentional UI block", control.count >= 20 && control.inputs >= 20 && control.max >= 150, JSON.stringify(control));
  await invoke("plugin:event|emit", { event: "menu", payload: "file.save" });
  check("the temporary document is saved before closing", await waitFor(`!document.title.startsWith(String.fromCharCode(8226))`, 30000));
  console.log(`  RESULT  ${JSON.stringify({ bytes: fixtureBytes, delayMs: 220, ...result })}`);
} finally {
  ws.close();
  if (path.dirname(directory) === tempRoot && path.basename(directory).startsWith("mdraft-preview-compare-")) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
