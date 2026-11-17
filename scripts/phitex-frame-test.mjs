#!/usr/bin/env node
// Exercise the PhiTeX compatibility frame in a real WebKitGTK webview.
//
//   MDRAFT_PHITEX_FILES=~/.local/share/io.github.bgeneto.mdraft/latex/phitex/files \
//     node scripts/phitex-frame-test.mjs
//
// The engine files must be the installed archive (or an extracted copy). The
// script serves the frame and its files on loopback, proxies Shelf pack
// requests, drives MiniBrowser through WebKitWebDriver, and proves the protocol
// the host uses: ready, page paint, single/double-click source, selection
// marks, logs and PDF export. Linux only; SKIPs when WebKitWebDriver is absent.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";

const files = resolve(
  process.env.MDRAFT_PHITEX_FILES ??
    join(
      process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
      "io.github.bgeneto.mdraft",
      "latex",
      "phitex",
      "files",
    ),
);
const shell = resolve(process.cwd(), "src-tauri", "phitex-shell");
const driver = ["/usr/bin/WebKitWebDriver", "/usr/local/bin/WebKitWebDriver"].find(existsSync);
if (process.platform !== "linux" || !driver) {
  console.log("SKIP: the PhiTeX frame test needs Linux and WebKitWebDriver");
  process.exit(0);
}
if (
  !existsSync(join(files, "dist", "core1.wasm")) ||
  !existsSync(join(files, "formats", "names.txt"))
) {
  console.log(`SKIP: no PhiTeX engine files at ${files} (set MDRAFT_PHITEX_FILES)`);
  process.exit(0);
}
if (
  !existsSync(join(shell, "bundles", "main.js")) ||
  !existsSync(join(shell, "bundles", "engine-worker.js"))
) {
  console.log("SKIP: the frame bundles are missing; run npm run build:phitex");
  process.exit(0);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".gzdata": "application/octet-stream",
  ".otf": "font/otf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".sty": "text/plain; charset=utf-8",
};
const packs = new Map();

function fileFor(path) {
  if (path === "/phitex/" || path === "/phitex/index.html") return join(shell, "index.html");
  if (path === "/phitex/bundles/main.js" || path === "/phitex/dist/main.js")
    return join(shell, "bundles", "main.js");
  if (path === "/phitex/bundles/engine-worker.js" || path === "/phitex/dist/engine-worker.js")
    return join(shell, "bundles", "engine-worker.js");
  if (path === "/phitex/shelf/release.json") return join(files, "shelf-release.json");
  if (path.startsWith("/phitex/shelf/")) return null;
  if (!path.startsWith("/phitex/")) return null;
  const relative = path.slice("/phitex/".length);
  if (!relative || relative.includes("..") || relative.includes("\\")) return null;
  return join(files, relative);
}

const HOST = `<!doctype html><html><head><meta charset="utf-8"><title>PhiTeX frame test</title>
<style>html,body{margin:0;height:100%;overflow:hidden}#f{position:absolute;inset:0;width:100%;height:100%;border:0}</style>
</head><body><iframe id="f" src="/phitex/index.html?host=__HOST__&engine=xetex"></iframe>
<script>
const f=document.getElementById('f');window.__result=null;window.__source=[];window.__marks=0;window.__painted=[];window.__trace=[];window.__viewport=[];window.__ack=[];
let seq=1;const send=(m)=>{const n=seq++;f.contentWindow.postMessage({v:1,seq:n,...m},location.origin);return n;};
const main=String.raw\`\\documentclass{article}
\\usepackage{amsmath}
\\begin{document}
Hello PhiTeX, $\\int_0^1 x^2\\,dx$.
\\section{A section}\\label{s}
Some text with a \\ref{s}.
\\end{document}\`;
window.addEventListener('message',(e)=>{const m=e.data;if(!m||m.v!==1)return;
  if(m.type==='ready'){send({type:'init',theme:{dark:false,sync:'',peak:'',paper:'#fff',pane:'#e9edf2'},zoom:1,reference:0});send({type:'project',main:'main.tex',files:[{path:'main.tex',text:main}],remove:[],replace:true,active:'main.tex',compile:true});}
  if(m.type==='painted'){window.__painted.push(m);if(m.pages>0&&!window.__clicked){window.__clicked=true;setTimeout(()=>{const d=f.contentDocument;const h=d.querySelector('phitex-preview');const r=h&&h.shadowRoot;const slot=r&&r.querySelector('.slot');if(!slot)return;const b=slot.getBoundingClientRect();const point=(x,y)=>{const el=r.elementFromPoint(x,y);if(el)el.dispatchEvent(new MouseEvent('dblclick',{clientX:x,clientY:y,bubbles:true,composed:true,detail:2}));};point(b.left+b.width*0.25,b.top+b.height*0.12);send({type:'select',file:'main.tex',from:61,to:66,blink:false});setTimeout(()=>{window.__marks=r.querySelectorAll('.mark,.sel,.seltext').length;send({type:'zoom',factor:1.25});setTimeout(()=>{const stage=r.querySelector('#stage');if(stage){stage.scrollTop=150;stage.dispatchEvent(new Event('scroll'));}window.__editSeq=send({type:'edit',file:'main.tex',base:main.length,changes:[[5,5,' ']]});window.__editLength=main.length+1;setTimeout(()=>{window.__zoom=f.contentWindow.__phitex?.panel?.state?.().zoom??null;send({type:'export'});},1400);},900);},800);},600);}}
  if(m.type==='source')window.__source.push(m);
  if(m.type==='viewport')window.__viewport.push(m);
  if(m.type==='ack')window.__ack.push(m);
  if(m.type==='trace')window.__trace.push(m.text);
  if(m.type==='pdf')window.__result={pdf:m.pdf.byteLength};
  if(m.type==='error')window.__error=m.message;
});
</script></body></html>`;

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/host.html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(HOST.replace("__HOST__", `http://127.0.0.1:${server.address().port}`));
    return;
  }
  if (url.pathname.startsWith("/phitex/shelf/h/")) {
    const id = decodeURIComponent(url.pathname.slice("/phitex/shelf/h/".length)).replace(
      /\.pack$/,
      "",
    );
    try {
      let bytes = packs.get(id);
      if (!bytes) {
        const upstream = await fetch(
          `https://v1.shelf.phitex.org/tl2026/h/${encodeURIComponent(id)}.pack`,
        );
        if (!upstream.ok) throw new Error(`Shelf ${upstream.status}`);
        bytes = Buffer.from(await upstream.arrayBuffer());
        packs.set(id, bytes);
      }
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(bytes);
    } catch (error) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end(String(error));
    }
    return;
  }
  const path = fileFor(url.pathname);
  if (!path || !existsSync(path) || !statSync(path).isFile()) {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
    return;
  }
  response.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
  createReadStream(path).pipe(response);
});

const call = async (base, method, path, body) => {
  const response = await fetch(base + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json();
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;
let session;
let driverBase = "";
let failed = 0;
const check = (ok, label, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const driverPort = 9500 + Math.floor(Math.random() * 400);
  browser = spawn(driver, [`--port=${driverPort}`, "--host=127.0.0.1"], {
    stdio: "ignore",
    env: {
      ...process.env,
      GDK_BACKEND: "x11",
      LIBGL_ALWAYS_SOFTWARE: "1",
      WEBKIT_DISABLE_COMPOSITING_MODE: "1",
    },
  });
  const base = (driverBase = `http://127.0.0.1:${driverPort}`);
  for (let i = 0; i < 50; i += 1) {
    try {
      await call(base, "GET", "/status");
      break;
    } catch {
      await sleep(100);
    }
  }
  const created = await call(base, "POST", "/session", {
    capabilities: { alwaysMatch: { browserName: "MiniBrowser" } },
  });
  session = created.value.sessionId;
  await call(base, "POST", `/session/${session}/url`, {
    url: `http://127.0.0.1:${port}/host.html`,
  });
  let result = null;
  for (let i = 0; i < 90; i += 1) {
    await sleep(1000);
    const state = await call(base, "POST", `/session/${session}/execute/sync`, {
      script:
        "return {result:window.__result,sources:window.__source,marks:window.__marks,zoom:window.__zoom,viewport:window.__viewport,painted:window.__painted,ack:window.__ack,editSeq:window.__editSeq,editLength:window.__editLength,trace:window.__trace,error:window.__error||null}",
      args: [],
    });
    result = state.value;
    if (result?.result?.pdf) break;
  }
  check(!!result?.painted?.some((p) => p.pages > 0), "a page was shipped");
  check(result?.sources?.length >= 1, "a page gesture reported its source");
  check(result?.marks >= 1, "a source selection marked the page");
  check(
    (result?.ack ?? []).some((a) => a.seq === result?.editSeq && a.length === result?.editLength),
    "an edit was acknowledged with the new length",
    JSON.stringify((result?.ack ?? []).slice(-2)),
  );
  check(
    (result?.painted ?? []).some((p) => p.done === true && p.seq === result?.editSeq),
    "the edit repainted",
  );
  check(result?.zoom === "1.25", "a zoom request reached the panel", String(result?.zoom));
  check(
    (result?.viewport ?? []).some((v) => v.file && v.line > 0),
    "a scroll reported its source line",
    JSON.stringify((result?.viewport ?? []).slice(-2)),
  );
  check(
    (result?.result?.pdf ?? 0) > 1000,
    "the frame exported a PDF",
    `${result?.result?.pdf ?? 0} bytes`,
  );
  check(
    (result?.trace ?? []).some((line) => /typeset/i.test(line)),
    "the compiler log reached the host",
  );
  check(!result?.error, "the frame reported no error", result?.error ?? "");
} catch (error) {
  failed += 1;
  console.log(`FAIL  ${String(error?.stack ?? error)}`);
} finally {
  if (session) {
    try {
      await call(driverBase, "DELETE", `/session/${session}`);
    } catch {
      // The driver may already be gone.
    }
  }
  browser?.kill("SIGTERM");
  server.close();
}
console.log(failed ? `\n${failed} check(s) failed` : "\nPhiTeX frame checks passed");
process.exit(failed ? 1 : 0);
