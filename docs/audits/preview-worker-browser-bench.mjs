// Renderer-only audit: no MDraft process or MDraft profile is launched.
// Create `master` and `branch` snapshots and a shared node_modules directory
// under an isolated audit root, then run:
//   node docs/audits/preview-worker-browser-bench.mjs C:/path/to/mdraft-audit
// The snapshots must be disposable; the script creates audit-empty.html there.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "");
if (path.basename(root) !== "mdraft-audit")
  throw new Error("Expected a disposable mdraft-audit directory");
const chromeExe = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const vite = path.join(root, "node_modules", "vite", "bin", "vite.js");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () =>
  new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.on("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") return reject(new Error("No ephemeral port"));
      listener.close(() => resolve(address.port));
    });
  });
async function waitForHttp(url, child) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Process exited early: ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await sleep(100);
  }
  throw new Error(`Timed out: ${url}`);
}

for (const revision of ["master", "branch"]) {
  const file = path.join(root, revision, "audit-empty.html");
  const content = "<!doctype html><html><body></body></html>";
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") !== content) {
    throw new Error(`Refusing to overwrite ${file}`);
  }
  if (!fs.existsSync(file)) fs.writeFileSync(file, content);
}
const profile = fs.mkdtempSync(path.join(root, "chrome-audit-"));
const browser = spawn(
  chromeExe,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { windowsHide: true, stdio: "ignore" },
);
let server;
let socket;
try {
  const activePortFile = path.join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < 200 && !fs.existsSync(activePortFile); attempt += 1) {
    if (browser.exitCode !== null) throw new Error(`Browser exited early: ${browser.exitCode}`);
    await sleep(100);
  }
  const browserPort = Number(fs.readFileSync(activePortFile, "utf8").split(/\r?\n/)[0]);
  if (!Number.isInteger(browserPort) || browserPort < 1) throw new Error("Invalid browser port");
  const browserBase = `http://127.0.0.1:${browserPort}`;
  await waitForHttp(`${browserBase}/json/version`, browser);
  const version = await (await fetch(`${browserBase}/json/version`)).json();
  const pages = await (await fetch(`${browserBase}/json/list`)).json();
  const page = pages.find((target) => target.type === "page");
  if (!page) throw new Error("No browser page target");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const pending = new Map();
  let id = 0;
  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (!pending.has(msg.id)) return;
    const [resolve, reject] = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const next = ++id;
      pending.set(next, [resolve, reject]);
      socket.send(JSON.stringify({ id: next, method, params }));
    });
  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  await send("Runtime.enable");
  await send("Page.enable");
  const results = {
    browser: version.Browser,
    userAgent: version["User-Agent"],
    snapshots: {},
    cdpInput: null,
  };
  for (const revision of ["master", "branch"]) {
    const port = await freePort();
    let serverError = "";
    server = spawn(
      process.execPath,
      [vite, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
      { cwd: path.join(root, revision), windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    server.stderr.on("data", (part) => {
      serverError += part.toString().slice(0, 4000);
    });
    const url = `http://127.0.0.1:${port}/audit-empty.html`;
    try {
      const response = await waitForHttp(url, server);
      if (!(await response.text()).includes("<!doctype html>"))
        throw new Error("Unexpected audit page");
    } catch (error) {
      throw new Error(`${error}: ${serverError}`);
    }
    await send("Page.navigate", { url });
    for (let i = 0; i < 100; i += 1) {
      try {
        if (
          await evaluate(
            `location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`,
          )
        )
          break;
      } catch {}
      await sleep(100);
    }
    if (revision === "master") {
      await evaluate(`(() => { document.body.innerHTML = '<textarea id="audit-input"></textarea>';
        const counts = window.auditEvents = {keydown:0,keypress:0,input:0};
        for (const name of Object.keys(counts)) document.addEventListener(name, () => counts[name]++);
        document.querySelector('textarea').focus(); })()`);
      await send("Input.dispatchKeyEvent", {
        type: "char",
        text: "a",
        unmodifiedText: "a",
        key: "a",
      });
      results.cdpInput = await evaluate(
        "({events:window.auditEvents, value:document.querySelector('textarea').value})",
      );
    }
    await evaluate(`(() => { const NativeWorker=window.Worker; window.auditWorkers={created:0,success:0,errors:0};
      window.Worker=class extends NativeWorker { constructor(...args) { super(...args); window.auditWorkers.created++;
        this.addEventListener('message', e=>{if(e.data?.ok)window.auditWorkers.success++;});
        this.addEventListener('error', ()=>window.auditWorkers.errors++); } }; })()`);
    await evaluate(
      `(async () => { window.auditModule = await import('/src/markdown.ts'); return true; })()`,
    );
    const compare = await evaluate(`(async () => {
      const source = '# Title\\r\\n\\r\\nA **bold** line and [link](https://example.com).\\r\\n\\r\\n'
        + '<script>window.bad=1</script>\\r\\n\\r\\n- [x] item\\r\\n';
      const host = document.createElement('div'); document.body.append(host);
      const opts={baseDir:null, math:false, mermaid:false, map:true};
      const result=typeof window.auditModule.renderPreviewInto === 'function'
        ? await window.auditModule.renderPreviewInto(host,source,opts,()=>false)
        : window.auditModule.renderPreview(source,opts);
      return {html:result.html ?? host.innerHTML, fragments:result.fragments?.length, anchors:result.anchors};
    })()`);
    const boundaries = [];
    for (const [map, prefix] of [
      [false, 65500],
      [true, 65475],
    ]) {
      boundaries.push(
        await evaluate(`(async () => {
        const source='x'.repeat(${prefix})+'\\n\\n<div class="auditbox">\\n\\nINSIDE\\n\\n</div>\\n\\n'+'z'.repeat(310000);
        const host=document.createElement('div'); document.body.replaceChildren(host);
        const options={baseDir:null,math:false,mermaid:false,map:${map}};
        let result;
        if (typeof window.auditModule.renderPreviewInto === 'function') {
          result=await window.auditModule.renderPreviewInto(host,source,options,()=>false);
        } else { result=window.auditModule.renderPreview(source,options);host.innerHTML=result.html; }
        const sync=window.auditModule.renderPreview(source,options);
        const syncHost=document.createElement('div');syncHost.innerHTML=sync.html;
        return {map:${map}, sourceBytes:new TextEncoder().encode(source).length,
          boxContainsInside:host.querySelector('.auditbox')?.textContent.includes('INSIDE') ?? null,
          synchronousBoxContainsInside:syncHost.querySelector('.auditbox')?.textContent.includes('INSIDE') ?? null,
          insideExists:host.textContent.includes('INSIDE'), htmlLength:(result.html ?? host.innerHTML).length};
      })()`),
      );
    }
    const empty = await evaluate(`(() => {
      const r=window.auditModule.renderPreview('',{baseDir:null,math:false,mermaid:false,map:true});
      return {html:r.html, linesMapped:r.linesMapped, anchors:r.anchors};
    })()`);
    const rows = [];
    for (const paragraphs of [800, 6400]) {
      const expression = `(async () => {
        const text = ('alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima '.repeat(2) + '\\n\\n').repeat(${paragraphs});
        const host = document.createElement('div'); host.style.width='800px'; document.body.replaceChildren(host);
        const opts = {baseDir:null,math:false,mermaid:false,map:true};
        const samples=[];
        for(let run=0;run<4;run++) {
          const entries=[]; const observer=new PerformanceObserver(list=>entries.push(...list.getEntries().map(e=>e.duration)));
          observer.observe({entryTypes:['longtask']});
          let last=performance.now(), maxGap=0;
          const interval=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;},10);
          await new Promise(r=>setTimeout(r,30));
          const start=performance.now();
          if (typeof window.auditModule.renderPreviewInto === 'function') {
            await window.auditModule.renderPreviewInto(host,text,opts,()=>false);
          } else { const result=window.auditModule.renderPreview(text,opts); host.innerHTML=result.html; }
          const elapsed=performance.now()-start;
          await new Promise(r=>setTimeout(r,40)); clearInterval(interval); observer.disconnect();
          if(run>0) samples.push({elapsedMs:elapsed,maxTimerGapMs:maxGap,longestTaskMs:Math.max(0,...entries)});
        }
        return {sourceBytes:new TextEncoder().encode(text).length,children:host.children.length,samples};
      })()`;
      rows.push({ paragraphs, ...(await evaluate(expression)) });
    }
    const serialization = await evaluate(`(() => {
      const host=document.body.querySelector('div');const times=[];let length=0;
      for(let i=0;i<6;i++){const start=performance.now();length=host.innerHTML.length;
        const elapsed=performance.now()-start;if(i>0)times.push(elapsed);}
      return {htmlCharacters:length,samplesMs:times};
    })()`);
    await evaluate(
      `(async () => { window.auditAscii = await import('/src/asciidoc-preview.ts'); return true; })()`,
    );
    const asciidoc = await evaluate(`(async () => {
      const text='= Audit\\n\\n'+('alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima '.repeat(2)+'\\n\\n').repeat(4000);
      const host=document.createElement('div');host.style.width='800px';document.body.replaceChildren(host);
      const options={baseDir:null,math:false,mermaid:false,isDark:false};const samples=[];
      for(let run=0;run<4;run++){
        let last=performance.now(),maxGap=0;
        const interval=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;},10);
        await new Promise(r=>setTimeout(r,30));const start=performance.now();
        if(typeof window.auditAscii.renderAsciidocPreviewInto==='function'){
          await window.auditAscii.renderAsciidocPreviewInto(host,text,options,()=>false);
        }else{const result=await window.auditAscii.renderAsciidocPreview(text,options);host.innerHTML=result.html;}
        const elapsed=performance.now()-start;await new Promise(r=>setTimeout(r,40));clearInterval(interval);
        if(run>0)samples.push({elapsedMs:elapsed,maxTimerGapMs:maxGap});
      }
      return {sourceBytes:new TextEncoder().encode(text).length,children:host.children.length,samples};
    })()`);
    results.snapshots[revision] = {
      compare,
      boundaries,
      empty,
      rows,
      serialization,
      asciidoc,
      workers: await evaluate("window.auditWorkers"),
    };
    server.kill();
    await sleep(200);
    server = undefined;
  }
  results.htmlEqual =
    results.snapshots.master.compare.html === results.snapshots.branch.compare.html;
  fs.writeFileSync(path.join(root, "browser-results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  if (server) server.kill();
  if (socket) socket.close();
  browser.kill();
}
