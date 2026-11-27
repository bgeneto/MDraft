//! Markdown preview DOM, sanitizer and worker/fallback parity without Tauri.
//! Starts a local Vite server and an isolated headless Chromium profile.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function browserPath() {
  if (process.env.MDRAFT_TEST_BROWSER) return process.env.MDRAFT_TEST_BROWSER;
  if (process.platform === "win32") {
    const candidates = [
      path.join(
        process.env.PROGRAMFILES ?? "C:/Program Files",
        "Google/Chrome/Application/chrome.exe",
      ),
      path.join(
        process.env["PROGRAMFILES(X86)"] ?? "C:/Program Files (x86)",
        "Microsoft/Edge/Application/msedge.exe",
      ),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
  }
  for (const name of ["google-chrome", "chromium", "chromium-browser", "microsoft-edge"]) {
    const found = spawnSync("which", [name], { encoding: "utf8" });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  return null;
}

const browser = browserPath();
if (!browser)
  throw new Error("A Chromium browser is required; set MDRAFT_TEST_BROWSER to its executable.");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No free port"));
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHttp(url, child) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Process exited before ${url}: ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // The server may still be starting.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}

const tempRoot = path.resolve(os.tmpdir());
const profile = fs.mkdtempSync(path.join(tempRoot, "mdraft-preview-dom-"));
const port = await freePort();
const pageUrl = `http://127.0.0.1:${port}/samples/scroll-sync/prose.html`;
const vite = spawn(
  process.execPath,
  [
    path.join(root, "node_modules/vite/bin/vite.js"),
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
  },
);
const chromeArgs = [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  "about:blank",
];
if (process.platform === "linux" && process.getuid?.() === 0) chromeArgs.push("--no-sandbox");
const chrome = spawn(browser, chromeArgs, { windowsHide: true, stdio: "ignore" });
let socket;
try {
  const pageResponse = await waitForHttp(pageUrl, vite);
  if (!(await pageResponse.text()).includes("Scroll correspondence"))
    throw new Error("Unexpected Vite fixture");
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < 300 && !fs.existsSync(portFile); attempt += 1) {
    if (chrome.exitCode !== null) throw new Error(`Browser exited: ${chrome.exitCode}`);
    await sleep(100);
  }
  const browserPort = Number(fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0]);
  if (!Number.isInteger(browserPort) || browserPort < 1) throw new Error("Invalid browser port");
  const browserBase = `http://127.0.0.1:${browserPort}`;
  await waitForHttp(`${browserBase}/json/version`, chrome);
  const targets = await (await fetch(`${browserBase}/json/list`)).json();
  const page = targets.find((target) => target.type === "page");
  if (!page) throw new Error("No browser page target");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!pending.has(message.id)) return;
    const [resolve, reject] = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, [resolve, reject]);
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await send("Runtime.enable");
  await send("Page.enable");
  async function navigate() {
    await send("Page.navigate", { url: pageUrl });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if (
          await evaluate(
            `location.href === ${JSON.stringify(pageUrl)} && document.readyState === 'complete'`,
          )
        )
          return;
      } catch {
        // The old execution context disappears during navigation.
      }
      await sleep(100);
    }
    throw new Error("The browser fixture did not load");
  }

  await navigate();
  await evaluate(`(() => {
    const NativeWorker=window.Worker;window.previewTestWorkers={created:0,ok:0,errors:0};
    window.Worker=class extends NativeWorker {constructor(...args){super(...args);window.previewTestWorkers.created++;
      this.addEventListener('message',e=>{if(e.data?.ok)window.previewTestWorkers.ok++;});
      this.addEventListener('error',()=>window.previewTestWorkers.errors++);}};
  })()`);
  await evaluate(`(async()=>{window.previewTest=await import('/src/markdown.ts');return true;})()`);

  for (const [map, prefix] of [
    [false, 65500],
    [true, 65475],
  ]) {
    const result = await evaluate(`(async()=>{
      const source='x'.repeat(${prefix})+'\\n\\n<div class="auditbox">\\n\\nINSIDE\\n\\n</div>\\n\\n'+'z'.repeat(310000);
      const opts={baseDir:null,math:false,mermaid:false,map:${map}};
      const sync=window.previewTest.renderPreview(source,opts);const syncHost=document.createElement('div');syncHost.innerHTML=sync.html;
      const host=document.createElement('div');document.body.replaceChildren(host);
      const live=await window.previewTest.renderPreviewInto(host,source,opts,()=>false);
      return {sync:syncHost.querySelector('.auditbox')?.textContent.includes('INSIDE') ?? false,
        live:host.querySelector('.auditbox')?.textContent.includes('INSIDE') ?? false,
        text:host.textContent.includes('INSIDE'), hasLiveHtml:Object.hasOwn(live,'html')};
    })()`);
    check(`raw HTML keeps its nested text in synchronous export (map=${map})`, result.sync);
    check(
      `raw HTML keeps its nested text in worker preview (map=${map})`,
      result.live && result.text,
    );
    check(
      `live preview does not serialize an unused HTML result (map=${map})`,
      !result.hasLiveHtml,
    );
  }

  const oversized = await evaluate(`(async()=>{
    const source='<div class="outer">\\n\\n'+'x'.repeat(1024*1024)+
      '\\n\\n<p class="nested">inside the large block</p>\\n\\n</div>';
    const opts={baseDir:null,math:false,mermaid:false,map:false};
    const syncStarted=performance.now();
    const sync=window.previewTest.renderPreview(source,opts);
    const syncMs=performance.now()-syncStarted;
    const syncHost=document.createElement('div');syncHost.innerHTML=sync.html;
    const liveHost=document.createElement('div');document.body.replaceChildren(liveHost);
    const liveStarted=performance.now();
    await window.previewTest.renderPreviewInto(liveHost,source,opts,()=>false);
    const liveMs=performance.now()-liveStarted;
    return {sync:!!syncHost.querySelector('.outer .nested'), live:!!liveHost.querySelector('.outer .nested'),
      length:liveHost.querySelector('.outer')?.textContent.length??0,syncMs,liveMs};
  })()`);
  check(
    "a raw HTML block larger than 1 MiB keeps its nested tree in export and live preview",
    oversized.sync && oversized.live && oversized.length > 1024 * 1024,
    `sync ${oversized.syncMs.toFixed(1)} ms, worker path ${oversized.liveMs.toFixed(1)} ms`,
  );

  const rawSync = await evaluate(`(async()=>{
    const sourceMap=await import('/src/source-map.ts');
    const source=await (await fetch('/samples/raw-html-sync.md')).text();
    const host=document.createElement('div');document.body.replaceChildren(host);
    const result=await window.previewTest.renderPreviewInto(host,source,
      {baseDir:null,math:true,mermaid:false,map:true},()=>false);
    const map=await sourceMap.bindWordMapAsync(host,{source,fragments:result.fragments},()=>false);
    const previewWord=(needle)=>{
      const walker=document.createTreeWalker(host,NodeFilter.SHOW_TEXT);
      for(let node=walker.nextNode();node;node=walker.nextNode()){
        const at=node.data.indexOf(needle);
        if(at<0)continue;
        const range=sourceMap.sourceRangeFor(map,node,at,at+needle.length);
        return range?source.slice(range.from,range.to):null;
      }
      return null;
    };
    const sourceRanges=(needle)=>{
      const from=source.indexOf(needle);
      return from<0?null:sourceMap.rangesForSource(map,from,from+needle.length).map(r=>r.toString());
    };
    const markup=source.indexOf('<div style="text-align: center;"><img src="html-tour/');
    return {
      linesMapped:result.linesMapped,
      anchors:host.querySelectorAll(':scope > [data-line]').length,
      children:host.children.length,
      table:previewWord('Calibration'),
      div:previewWord('signal!'),
      sourceTable:sourceRanges('Calibration'),
      sourceDiv:sourceRanges('signal!'),
      sourceMarkup:markup<0?null:sourceMap.rangesForSource(map,markup,markup+80).map(r=>r.toString()),
    };
  })()`);
  check(
    "cross-token raw HTML keeps every top-level element anchored",
    rawSync.linesMapped === true && rawSync.anchors === rawSync.children && rawSync.anchors >= 70,
    JSON.stringify({
      lines: rawSync.linesMapped,
      anchors: rawSync.anchors,
      children: rawSync.children,
    }),
  );
  check(
    "a raw HTML table cell maps preview to source",
    rawSync.table === "Calibration",
    String(rawSync.table),
  );
  check("Markdown inside a raw HTML div maps preview to source", rawSync.div === "signal!");
  check(
    "a raw HTML table cell maps source to preview",
    JSON.stringify(rawSync.sourceTable) === JSON.stringify(["Calibration"]),
    JSON.stringify(rawSync.sourceTable),
  );
  check(
    "Markdown inside a raw HTML div maps source to preview",
    JSON.stringify(rawSync.sourceDiv) === JSON.stringify(["signal!"]),
    JSON.stringify(rawSync.sourceDiv),
  );
  check(
    "raw HTML tag markup fails safe instead of painting the next block",
    JSON.stringify(rawSync.sourceMarkup) === JSON.stringify([]),
    JSON.stringify(rawSync.sourceMarkup),
  );

  const sameLine = await evaluate(`(async()=>{
    const sourceMap=await import('/src/source-map.ts');
    const source='**bold text** and more';
    const host=document.createElement('div');document.body.replaceChildren(host);
    const result=window.previewTest.renderPreview(source,{baseDir:null,math:false,mermaid:false,map:true});
    host.innerHTML=result.html;
    const map=await sourceMap.bindWordMapAsync(host,{source,fragments:result.fragments},()=>false);
    const close=source.indexOf('**',2)+2;
    const whole=sourceMap.rangeForSource(map,0,close)?.toString()??null;
    const marker=sourceMap.rangeForSource(map,0,2)?.toString()??null;
    return {whole,marker};
  })()`);
  check(
    "same-line Markdown syntax still snaps to its word",
    sameLine.whole === "bold text" && sameLine.marker === "bold text",
    JSON.stringify(sameLine),
  );

  const security = await evaluate(`(async()=>{
    const source='<div onclick="window.bad=1"><img onerror="window.bad=2"><a href="javascript:alert(1)">link</a><script>window.bad=3</script><p>safe</p></div>';
    const opts={baseDir:null,math:false,mermaid:false,map:true};
    const host=document.createElement('div');document.body.replaceChildren(host);
    await window.previewTest.renderPreviewInto(host,source,opts,()=>false);
    const badAttributes=[...host.querySelectorAll('*')].flatMap(e=>[...e.attributes]).filter(a=>/^on/i.test(a.name)||/javascript:/i.test(a.value));
    return {scripts:host.querySelectorAll('script').length,badAttributes:badAttributes.length,safe:host.textContent.includes('safe'),ran:window.bad??0};
  })()`);
  check(
    "the worker path strips scripts, event handlers and javascript URLs",
    security.scripts === 0 && security.badAttributes === 0 && security.ran === 0 && security.safe,
  );
  // Chat-assistant figures (samples/chat-figures.md): five render, one falls
  // back with its reason, and two genuine code samples stay code.
  const figures = await evaluate(`(async()=>{
    const source=await (await fetch('/samples/chat-figures.md')).text();
    const host=document.createElement('div');host.style.width='760px';document.body.replaceChildren(host);
    const live=await window.previewTest.renderPreviewInto(host,source,{baseDir:null,math:false,mermaid:false,map:true},()=>false);
    const sync=window.previewTest.renderPreview(source,{baseDir:null,math:false,mermaid:false});
    const exported=document.createElement('div');exported.innerHTML=sync.html;
    const figs=[...host.querySelectorAll('figure.md-widget')];
    const svgs=figs.map(f=>f.querySelector('svg'));
    const count=(f,sel)=>f?f.querySelectorAll(sel).length:-1;
    const bad=figs.flatMap(f=>[...f.querySelectorAll('*')]).flatMap(e=>[...e.attributes]).filter(a=>/^on/i.test(a.name)||a.name==='href'||a.name==='src'||/javascript:/i.test(a.value));
    const fallback=host.querySelector('.mdw-fallback');
    const gradient=figs[4]?.querySelector('linearGradient');
    const rectFill=figs[4]?.querySelector('rect')?.getAttribute('fill')??'';
    const label=figs[0]?.querySelector('text');
    host.style.color='rgb(10, 20, 30)';const darkFill=getComputedStyle(label).fill;
    host.style.color='rgb(240, 241, 242)';const lightFill=getComputedStyle(label).fill;
    const off=document.createElement('div');
    await window.previewTest.renderPreviewInto(off,source,{baseDir:null,math:false,mermaid:false,widgets:false,map:true},()=>false);
    return {
      figures:figs.length,exportFigures:exported.querySelectorAll('figure.md-widget').length,
      pres:host.querySelectorAll('pre').length,linesMapped:live.linesMapped,
      anchored:figs.every(f=>f.hasAttribute('data-f')),
      svgNamespace:svgs.filter(Boolean).every(s=>s instanceof SVGSVGElement),
      width:Math.round(svgs[0]?.getBoundingClientRect().width??0),
      rects1:count(figs[0],'rect'),rects3:count(figs[2],'rect'),paths3:count(figs[2],'path'),
      icons2:count(figs[1],'.mdw-icon svg'),
      text4:figs[3]?.textContent.replace(/\\s+/g,' ')??'',bold4:figs[3]?.querySelector('strong')?.textContent??'',
      controls:figs.reduce((n,f)=>n+f.querySelectorAll('input,button,select,textarea').length,0),
      bad:bad.length,styles:!!document.getElementById('mdraft-widget-styles'),
      note:fallback?.querySelector('.mdw-error')?.textContent??'',fallbackPre:!!fallback?.querySelector('pre'),
      gradientId:gradient?.id??'',rectFill,
      referenced:!!(gradient&&rectFill==='url(#'+gradient.id+')'),
      darkFill,lightFill,
      offFigures:off.querySelectorAll('figure.md-widget').length,offPres:off.querySelectorAll('pre').length,
    };
  })()`);
  check(
    "five chat figures render in the live preview",
    figures.figures === 5,
    String(figures.figures),
  );
  check("the export path renders the same figures", figures.exportFigures === 5);
  check("unsupported and ordinary code stays code", figures.pres === 3, String(figures.pres));
  check(
    "figures keep the block map",
    figures.linesMapped && figures.anchored,
    JSON.stringify({ linesMapped: figures.linesMapped, anchored: figures.anchored }),
  );
  check(
    "figure SVG is real SVG with a laid-out width",
    figures.svgNamespace && figures.width > 300,
    String(figures.width),
  );
  check(
    "{#each} expands in the DOM",
    figures.rects1 === 10 && figures.rects3 === 10 && figures.paths3 === 9,
  );
  check("layout icons draw", figures.icons2 === 5, String(figures.icons2));
  check(
    "interactive figure shows its starting values",
    figures.text4.includes("10,240") && figures.text4.includes("2.0×") && figures.bold4 === "20",
    figures.text4.slice(0, 120),
  );
  check("figures contain no form controls", figures.controls === 0);
  check(
    "figures carry no handler, link or source attribute",
    figures.bad === 0,
    String(figures.bad),
  );
  check("figure styles are installed", figures.styles);
  check(
    "an unsupported figure keeps its code and states the reason",
    figures.fallbackPre && /<tabs>.*line 2/.test(figures.note),
    figures.note,
  );
  check(
    "gradient ids are prefixed and still referenced",
    /^mdw\d+-fade$/.test(figures.gradientId) && figures.referenced,
    `${figures.gradientId} ${figures.rectFill}`,
  );
  check(
    "currentColor follows the preview text colour",
    figures.darkFill === "rgb(10, 20, 30)" && figures.lightFill === "rgb(240, 241, 242)",
    `${figures.darkFill} / ${figures.lightFill}`,
  );
  check(
    "the preference off leaves every fence as code",
    figures.offFigures === 0 && figures.offPres === 8,
    `${figures.offFigures}/${figures.offPres}`,
  );

  const empty =
    await evaluate(`(async()=>{const host=document.createElement('div');const opts={baseDir:null,math:false,mermaid:false,map:true};
    const sync=window.previewTest.renderPreview('',opts);const live=await window.previewTest.renderPreviewInto(host,'',opts,()=>false);
    return {sync:sync.linesMapped,live:live.linesMapped};})()`);
  check("an empty preview reports no mapped lines in either path", !empty.sync && !empty.live);
  for (const map of [false, true]) {
    const source = String.raw`![x](C:\Users\reader\.codex\.image.png)`;
    const legacy = await evaluate(`(async()=>{
      const source=${JSON.stringify(source)},opts={baseDir:null,math:false,mermaid:false,map:${map}};
      const sync=window.previewTest.renderPreview(source,opts), exported=document.createElement('div');
      exported.innerHTML=sync.html;
      const before=exported.querySelector('img')?.hasAttribute('data-mdraft-legacy');
      await window.previewTest.resolveLegacyImagesForExport(exported,sync.legacyImages,null);
      const liveHost=document.createElement('div');document.body.replaceChildren(liveHost);
      const live=await window.previewTest.renderPreviewInto(liveHost,source,opts,()=>false);
      return {before,exportStamp:exported.querySelector('img')?.hasAttribute('data-mdraft-legacy'),
        liveStamp:liveHost.querySelector('img')?.hasAttribute('data-mdraft-legacy'),
        candidates:Object.keys(live?.legacyImages??{}).length};
    })()`);
    check(
      `legacy image stamps stay internal (map=${map})`,
      legacy.before && !legacy.exportStamp && !legacy.liveStamp && legacy.candidates === 1,
      JSON.stringify(legacy),
    );
  }
  const forged = await evaluate(`(async()=>{
    const host=document.createElement('div');
    const html='<img src="/missing-preview-test.png" data-mdraft-legacy="constructor">';
    const result=window.previewTest.renderPreview(html,{baseDir:null,math:false,mermaid:false});
    host.innerHTML=result.html;
    await window.previewTest.resolveLegacyImagesForExport(host,result.legacyImages,null);
    return {stamp:host.querySelector('img')?.hasAttribute('data-mdraft-legacy'),candidates:Object.keys(result.legacyImages??{}).length};
  })()`);
  check("raw HTML cannot forge a legacy fallback stamp", !forged.stamp && forged.candidates === 0);
  const rawClass = await evaluate(`(async()=>{
    await new Promise((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';
      link.href='/src/styles.css';link.onload=resolve;link.onerror=reject;document.head.append(link);});
    const host=document.createElement('div');host.className='markdown-body';document.body.replaceChildren(host);
    await window.previewTest.renderPreviewInto(host,'<div class="md-preview-group"><p>raw</p></div>',
      {baseDir:null,math:false,mermaid:false,map:true},()=>false);
    return getComputedStyle(host.firstElementChild).contentVisibility;
  })()`);
  check(
    "raw HTML cannot opt itself into internal group containment",
    rawClass === "visible",
    String(rawClass),
  );
  const grouped = await evaluate(`(async()=>{
    const source=Array.from({length:10000},(_,i)=>'paragraph '+i).join('\\n\\n');
    const opts={baseDir:null,math:false,mermaid:false,map:true};
    const sync=window.previewTest.renderPreview(source,opts);
    const host=document.createElement('div');document.body.replaceChildren(host);
    const live=await window.previewTest.renderPreviewInto(host,source,opts,()=>false);
    const blocks=[...host.querySelectorAll('p')];
    const before=document.createElement('div');before.innerHTML=sync.html;
    return {groups:host.querySelectorAll(':scope > .md-preview-group').length,
      blocks:blocks.length,first:blocks[0]?.dataset.line,last:blocks.at(-1)?.dataset.line,
      text:host.textContent===before.textContent,mapped:live.linesMapped,
      exportGrouped:!!before.querySelector('.md-preview-group')};
  })()`);
  check(
    "large paragraph groups retain every sanitized block and anchor",
    grouped.groups === 157 &&
      grouped.blocks === 10000 &&
      grouped.first === "1" &&
      grouped.last === "19999" &&
      grouped.text &&
      grouped.mapped,
    JSON.stringify(grouped),
  );
  check("the synchronous export keeps its original ungrouped tree", !grouped.exportGrouped);
  const groupedCancel = await evaluate(`(async()=>{
    const host=document.createElement('div');host.textContent='previous';let checks=0;
    const source=Array.from({length:10000},(_,i)=>'paragraph '+i).join('\\n\\n');
    const result=await window.previewTest.renderPreviewInto(host,source,{baseDir:null,math:false,map:true},()=>++checks>4);
    return result===null && host.textContent==='previous';
  })()`);
  check("cancelling grouped construction preserves the previous live preview", groupedCancel);
  const mapBuild = await evaluate(`(async()=>{
    const maps=await import('/src/source-map.ts');
    const source='alpha bravo\\n\\nsecond paragraph';
    const opts={baseDir:null,math:false,mermaid:false,map:true};
    const host=document.createElement('div');document.body.replaceChildren(host);
    const result=await window.previewTest.renderPreviewInto(host,source,opts,()=>false);
    const map=await maps.bindWordMapAsync(host,{source,fragments:result.fragments},()=>false);
    const expected=maps.scrollTextAnchors(map);
    const actual=await maps.scrollTextAnchorsAsync(map,()=>false);
    const spans=items=>items.map(({from,to,start,end})=>[from,to,start,end]);
    let calls=0;
    const cancelled=await maps.bindWordMapAsync(host,{source,fragments:result.fragments},()=>++calls>1);
    return {parity:JSON.stringify(spans(expected))===JSON.stringify(spans(actual.anchors)),
      sorted:actual.sorted,count:actual.anchors.length,cancelled:cancelled===null};
  })()`);
  check(
    "cancelable word and scroll maps preserve source ranges",
    mapBuild.parity && mapBuild.sorted && mapBuild.count === 4,
    JSON.stringify(mapBuild),
  );
  check("canceling a map never publishes a partial result", mapBuild.cancelled);
  const listMap = await evaluate(`(async()=>{
    const maps=await import('/src/source-map.ts');
    const source='- alpha first item\\n  beta continuation line\\n- gamma second item\\n  delta continuation line\\n';
    const opts={baseDir:null,math:false,mermaid:false,map:true};
    const host=document.createElement('div');document.body.replaceChildren(host);
    const live=await window.previewTest.renderPreviewInto(host,source,opts,()=>false);
    const sync=window.previewTest.renderPreview(source,opts);
    const fragments=items=>(items??[]).map(({src0,src1,raw,kind})=>[src0,src1,raw,kind]);
    const map=await maps.bindWordMapAsync(host,{source,fragments:live.fragments},()=>false);
    let found=null;
    if(map){
      for(const nodes of map.fragNodes) for(const node of nodes){
        const at=node.data.indexOf('beta');
        if(at<0) continue;
        found=maps.sourceRangeFor(map,node,at,at+4);
      }
    }
    return {
      parity:JSON.stringify(fragments(live.fragments))===JSON.stringify(fragments(sync.fragments)),
      fragments:(live.fragments??[]).length,
      slice:found?source.slice(found.from,found.to):null,
      at:found?found.from:-1,
      expected:source.indexOf('beta'),
    };
  })()`);
  check(
    "a multiline list maps the same ranges through the worker and the synchronous path",
    listMap.parity && listMap.fragments >= 4,
    JSON.stringify(listMap),
  );
  check(
    "a continuation-line word resolves to its own source range in the DOM",
    listMap.slice === "beta" && listMap.at === listMap.expected,
    JSON.stringify(listMap),
  );
  const mapYield = await evaluate(`(async()=>{
    const maps=await import('/src/source-map.ts');
    const source=Array.from({length:10000},(_,i)=>'paragraph '+i).join('\\n\\n');
    const host=document.createElement('div');document.body.replaceChildren(host);
    const result=await window.previewTest.renderPreviewInto(host,source,{baseDir:null,math:false,map:true},()=>false);
    const now=performance.now.bind(performance);let tick=0;
    Object.defineProperty(performance,'now',{configurable:true,value:()=>now()+20*(++tick)});
    try {
      let cancelled=false;setTimeout(()=>{cancelled=true;},0);
      const map=await maps.bindWordMapAsync(host,{source,fragments:result.fragments},()=>cancelled);
      const bindingCancelled=cancelled && map===null;
      const complete=await maps.bindWordMapAsync(host,{source,fragments:result.fragments},()=>false);
      cancelled=false;setTimeout(()=>{cancelled=true;},0);
      const anchors=await maps.scrollTextAnchorsAsync(complete,()=>cancelled);
      return {bindingCancelled,indexCancelled:cancelled && anchors===null,fragments:result.fragments.length};
    } finally { delete performance.now; }
  })()`);
  check("a large map yields to a newer generation and stops", mapYield.bindingCancelled);
  check("a large scroll index yields to a newer generation and stops", mapYield.indexCancelled);
  const workers = await evaluate("window.previewTestWorkers");
  check(
    "the live cases actually used the worker",
    workers.created >= 1 && workers.created <= 2 && workers.ok >= 4 && workers.errors === 0,
    JSON.stringify(workers),
  );

  // Obsidian callouts and GitHub alerts from samples/markdown-extensions.md,
  // through the worker with the word map and through the synchronous export.
  const callouts = await evaluate(`(async()=>{
    const source=await (await fetch('/samples/markdown-extensions.md')).text();
    const opts={baseDir:null,math:true,mermaid:false,map:true};
    const host=document.createElement('div');document.body.replaceChildren(host);
    await window.previewTest.renderPreviewInto(host,source,opts,()=>false);
    const sync=document.createElement('div');document.body.appendChild(sync);
    sync.innerHTML=window.previewTest.renderPreview(source,{...opts,map:false}).html;
    const describe=(root)=>Array.from(root.querySelectorAll('blockquote.md-alert')).map(q=>{
      const title=q.querySelector(':scope > .md-alert-title, :scope > details > .md-alert-title');
      const fold=q.querySelector(':scope > details');
      return {cls:q.className,title:title?.innerText.trim(),strong:!!title?.querySelector('strong'),
        tag:title?.tagName,fold:fold?(fold.open?'open':'closed'):'none',
        titleF:!!title?.querySelector('[data-f]'),body:q.innerText.replace(title?.innerText??'','').trim()};
    });
    const firstBody=host.querySelector('blockquote.md-alert-note > p:not(.md-alert-title)');
    return {live:describe(host),sync:describe(sync),
      markerLeak:host.innerText.includes('[!')||sync.innerText.includes('[!'),
      noteBold:!!firstBody?.querySelector('strong'),noteF:!!firstBody?.querySelector('[data-f]'),
      markers:host.querySelectorAll('.md-alert-marker[hidden]').length};
  })()`);
  const byTitle = (list, title) => list.find((entry) => entry.title === title);
  check(
    "callouts: six alerts in the fixture",
    callouts.live.length === 6,
    JSON.stringify(callouts.live),
  );
  check(
    "callouts: worker and synchronous export agree",
    JSON.stringify(callouts.live.map(({ titleF, ...rest }) => rest)) ===
      JSON.stringify(callouts.sync.map(({ titleF, ...rest }) => rest)),
  );
  check("callouts: no marker text is visible", !callouts.markerLeak);
  check(
    "callouts: each marker is hidden in place",
    callouts.markers === 6,
    String(callouts.markers),
  );
  const note = byTitle(callouts.live, "Note");
  check(
    "callouts: a GitHub alert keeps its first-line formatting and fragments",
    note?.cls === "md-alert md-alert-note" && callouts.noteBold && callouts.noteF,
    JSON.stringify(note),
  );
  const tip = byTitle(callouts.live, "Custom title");
  check(
    "callouts: [!tip]- is a closed fold with a formatted, mapped title",
    tip?.tag === "SUMMARY" &&
      tip.fold === "closed" &&
      tip.strong &&
      tip.titleF &&
      tip.cls === "md-alert md-alert-tip",
    JSON.stringify(tip),
  );
  const faq = byTitle(callouts.live, "Open question");
  check(
    "callouts: [!faq]+ is an open fold coloured as a question",
    faq?.fold === "open" &&
      faq.cls === "md-alert md-alert-question" &&
      faq.body === "Expanded by default.",
    JSON.stringify(faq),
  );
  const example = byTitle(callouts.live, "Example");
  check(
    "callouts: a type without a title shows its name",
    example?.tag === "P" && example.fold === "none" && example.body === "No custom title.",
    JSON.stringify(example),
  );
  const inner = byTitle(callouts.live, "Inner");
  check(
    "callouts: a nested callout keeps its own kind",
    byTitle(callouts.live, "Nested")?.cls === "md-alert md-alert-quote" &&
      inner?.cls === "md-alert md-alert-warning" &&
      inner.body === "Inside the quote.",
    JSON.stringify(inner),
  );
  const calloutEdge = await evaluate(`(()=>{
    const render=(source)=>{const div=document.createElement('div');
      div.innerHTML=window.previewTest.renderPreview(source,{baseDir:null,math:false,mermaid:false}).html;document.body.appendChild(div);return div;};
    const unknown=render('> [!custom-thing] Mine\\n> Body');
    const plain=render('> [!not a marker]\\n> Body');
    const only=render('> [!WARNING] Just a title');
    const late=render('> Text first\\n> [!NOTE]');
    return {unknown:unknown.querySelector('blockquote')?.className+'|'+unknown.querySelector('.md-alert-title')?.innerText.trim(),
      plain:plain.querySelector('.md-alert')===null,
      only:only.querySelector('.md-alert-title')?.innerText.trim()+'|'+only.querySelectorAll('blockquote > p:not([hidden])').length,
      late:late.querySelector('.md-alert')===null};
  })()`);
  check(
    "callouts: an unknown type is a note under its own title",
    calloutEdge.unknown === "md-alert md-alert-note|Mine",
    calloutEdge.unknown,
  );
  check("callouts: a marker with spaces stays a plain quote", calloutEdge.plain);
  check(
    "callouts: a title-only callout has no empty body paragraph",
    calloutEdge.only === "Just a title|1",
    calloutEdge.only,
  );
  check("callouts: a marker after text is not a callout", calloutEdge.late);
  const referenceCallouts = await evaluate(`(async()=>{
    const { REFERENCE } = await import('/src/content.ts');
    const host=document.createElement('div');document.body.replaceChildren(host);
    const rendered=window.previewTest.renderPreview(REFERENCE,{baseDir:null,math:true,mermaid:false});
    host.innerHTML=rendered.html;
    if(!rendered.linesMapped) return 'lines not mapped';
    return [...host.querySelectorAll('blockquote.md-alert')].map(q=>q.className.split(' ')[1]+
      (q.querySelector(':scope > details')?(q.querySelector(':scope > details').open?'+':'-'):'')).join(',');
  })()`);
  check(
    "callouts: the Markdown Reference shows alerts, folds and a nested callout",
    referenceCallouts ===
      "md-alert-note,md-alert-warning,md-alert-tip-,md-alert-question+,md-alert-example",
    referenceCallouts,
  );

  // Footnotes, math fences and inline syntax from the same fixture: the
  // footnotes section is one more anchored top-level element in both paths.
  const notes = await evaluate(`(async()=>{
    const source=await (await fetch('/samples/markdown-extensions.md')).text();
    const opts={baseDir:null,math:true,mermaid:false,map:true,highlight:true,subscript:true,superscript:true};
    const host=document.createElement('div');document.body.replaceChildren(host);
    const live=await window.previewTest.renderPreviewInto(host,source,opts,()=>false);
    const sync=window.previewTest.renderPreview(source,{...opts,map:false});
    const syncHost=document.createElement('div');syncHost.innerHTML=sync.html;
    const strip=(html)=>html.replace(/ data-(?:f|line)="[^"]*"/g,'').replace(/<\\/?span>/g,'');
    const section=host.querySelector(':scope > section.footnotes');
    const raw='<div class="box">raw</div>\\n\\nCite[^r].\\n\\n[^r]: Raw path note with $x$.\\n';
    const rawHost=document.createElement('div');document.body.appendChild(rawHost);
    const rawLive=await window.previewTest.renderPreviewInto(rawHost,raw,opts,()=>false);
    const hrefOf=(a)=>a.getAttribute('data-href')??a.getAttribute('href')??'';
    const target=(a)=>host.querySelector('[id="'+hrefOf(a).slice(1)+'"]');
    return {
      liveMapped:live.linesMapped, syncMapped:sync.linesMapped,
      last:host.lastElementChild===section, sectionLine:section?.getAttribute('data-line') ?? null,
      items:[...(section?.querySelectorAll('li[id]')??[])].map(li=>li.id),
      refs:[...host.querySelectorAll('sup.footnote-ref a')].map(a=>hrefOf(a)+'>'+a.textContent),
      targets:[...host.querySelectorAll('sup.footnote-ref a')].every(target),
      backs:[...host.querySelectorAll('a.footnote-backref')].every(target),
      noteF:!!section?.querySelector('[data-f]'), noteCode:!!section?.querySelector('code'),
      parity:strip(syncHost.querySelector('section.footnotes')?.outerHTML??'x')===strip(section?.outerHTML??'y'),
      fence:!!host.querySelector('.katex-display') && !host.querySelector('code.language-math'),
      inline:['mark','sub',':not(.footnote-backref) > sup:not(.footnote-ref)'].map(sel=>host.querySelectorAll(sel).length).join(','),
      rawMapped:rawLive.linesMapped, rawNote:!!rawHost.querySelector('section.footnotes li .katex'),
    };
  })()`);
  check(
    "footnotes: every top-level element anchored in the worker and export paths",
    notes.liveMapped && notes.syncMapped,
    JSON.stringify([notes.liveMapped, notes.syncMapped]),
  );
  check(
    "footnotes: the section is the last element and anchored",
    notes.last && notes.sectionLine !== null,
  );
  check(
    "footnotes: cited notes listed in citation order, unused ones left out",
    JSON.stringify(notes.items) === JSON.stringify(["fn-boil", "fn-alt", "fn-code", "fn-long"]),
    JSON.stringify(notes.items),
  );
  check(
    "footnotes: references are numbered by first citation",
    JSON.stringify(notes.refs) ===
      JSON.stringify(["#fn-boil>1", "#fn-alt>2", "#fn-boil>1", "#fn-code>3", "#fn-long>4"]),
    JSON.stringify(notes.refs),
  );
  check(
    "footnotes: every reference and back-reference has its target",
    notes.targets && notes.backs,
  );
  check("footnotes: note text keeps word fragments and code", notes.noteF && notes.noteCode);
  check("footnotes: the worker and the export draw the same section", notes.parity);
  check("math fence: KaTeX display, no code block", notes.fence);
  check("inline syntax: mark, sub and sup drawn", notes.inline === "1,1,1", notes.inline);
  check(
    "footnotes: the raw-HTML path anchors the section and renders its math",
    notes.rawMapped && notes.rawNote,
  );

  // A separate page creates a fresh channel so the constructor failure really
  // exercises the synchronous fallback rather than an already-running worker.
  await navigate();
  await evaluate(`window.Worker=class {constructor(){throw new Error('worker blocked');}};`);
  await evaluate(`(async()=>{window.previewTest=await import('/src/markdown.ts');return true;})()`);
  const fallback = await evaluate(`(async()=>{
    const source='x'.repeat(65500)+'\\n\\n<div class="auditbox">\\n\\nINSIDE\\n\\n</div>\\n\\n'+'z'.repeat(310000);
    const host=document.createElement('div');document.body.replaceChildren(host);
    const result=await window.previewTest.renderPreviewInto(host,source,{baseDir:null,math:false,mermaid:false,map:false},()=>false);
    return !!result && !!host.querySelector('.auditbox')?.textContent.includes('INSIDE');
  })()`);
  check("worker startup failure falls back without corrupting raw HTML", fallback);
  const fallbackSecurity = await evaluate(`(async()=>{
    const source='<div onclick="window.bad=1"><iframe srcdoc="<script>window.bad=2</script>"></iframe>'+
      '<a href="java&#x73;cript:alert(1)">safe link</a><p>safe text</p></div>';
    const host=document.createElement('div');document.body.replaceChildren(host);
    const result=await window.previewTest.renderPreviewInto(host,source,{baseDir:null,math:false,mermaid:false,map:false},()=>false);
    return !!result && !host.querySelector('iframe,script,[onclick]') &&
      !/javascript:/i.test(host.innerHTML) && host.textContent.includes('safe text') && !window.bad;
  })()`);
  check("the synchronous fallback keeps the sanitizer policy", fallbackSecurity);
} finally {
  socket?.close();
  vite.kill();
  chrome.kill();
  await sleep(500);
  // The target is a directory created by this process directly under temp.
  if (
    path.dirname(profile) === tempRoot &&
    path.basename(profile).startsWith("mdraft-preview-dom-")
  ) {
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {}
  }
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
