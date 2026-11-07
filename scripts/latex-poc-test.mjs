//! Exercise the experimental LuaLaTeX preview in a running, isolated MDraft.
//! Start it with samples/latex-poc/main.tex and a WebView2 debugging port:
//!   node scripts/latex-poc-test.mjs 19341 [offline]
import process from "node:process";

const port = Number(process.argv[2] ?? 19341);
const offline = process.argv[3] === "offline";
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((target) => target.type === "page");
if (!page) throw new Error("No MDraft page on the debugging port.");
const socket = new WebSocket(page.webSocketDebuggerUrl);
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined && pending.has(message.id)) {
    const request = pending.get(message.id);
    clearTimeout(request.timer);
    pending.delete(message.id);
    request.resolve(message);
  }
});
socket.addEventListener("close", () => {
  for (const [id, request] of pending) {
    clearTimeout(request.timer);
    request.reject(new Error(`CDP connection closed with request ${id} pending.`));
  }
  pending.clear();
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP ${method} request timed out after 10 seconds.`));
    }, 10000);
    pending.set(id, { resolve, reject, timer });
    try {
      socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}
async function evaluate(expression) {
  const reply = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (reply.result?.exceptionDetails)
    throw new Error(JSON.stringify(reply.result.exceptionDetails));
  return reply.result.result.value;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(expression, timeout = 120000, ignoreErrors = false) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await evaluate(expression)) return true;
    const error = await evaluate(
      'document.querySelector("#preview .typst-error")?.textContent ?? ""',
    );
    if (error && !ignoreErrors) throw new Error(`Preview error: ${error}`);
    await delay(300);
  }
  return false;
}
let passed = 0;
let failed = 0;
function check(label, condition) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (condition) passed++;
  else failed++;
}
async function clickPdfText(text) {
  const point = await evaluate(`(() => {
    const span = [...document.querySelectorAll(".typst-page .textLayer span")]
      .find(s => s.textContent.includes(${JSON.stringify(text)}));
    if (!span) return null;
    span.scrollIntoView({block:"center"});
    const r=span.getBoundingClientRect();
    return {x:r.left+r.width/2,y:r.top+r.height/2};
  })()`);
  if (!point) return false;
  for (const type of ["mousePressed", "mouseReleased"])
    await send("Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
  await delay(500);
  return true;
}

try {
  await send("Runtime.enable");
  if (!(await waitFor('!!document.querySelector(".cm-content")', 30000)))
    throw new Error("Editor did not open.");
  if (
    !(await waitFor(
      '!!document.querySelector(".typst-note button, .typst-page .textLayer")',
      30000,
    ))
  )
    throw new Error("The LaTeX preview did not start.");
  const setup = await evaluate(
    '!![...document.querySelectorAll("button")].find(b => b.textContent.includes("Enable LuaLaTeX"))',
  );
  if (setup && offline) throw new Error("The offline run started without the warmed engine.");
  if (setup) {
    await evaluate(`(async () => {
      const open=document.getElementById("btn-prefs"); open?.click();
      await new Promise(r=>setTimeout(r,500));
      [...document.querySelectorAll(".prefs-section")].find(n=>n.textContent.trim()==="Export")?.click();
      await new Promise(r=>setTimeout(r,400));
      const row=[...document.querySelectorAll(".prefs-row")].find(n=>/Enable LuaLaTeX/i.test(n.querySelector(".prefs-label")?.textContent ?? ""));
      const box=row?.querySelector("input[type=checkbox]"); if(box && !box.checked) box.click();
      await new Promise(r=>setTimeout(r,900)); open?.click();
    })()`);
    if (!(await evaluate('window.__TAURI_INTERNALS__.invoke("latex_status")'))) {
      console.log("SKIP: the LaTeX engine is not installed in this test profile.");
      console.log("0/0 checks passed");
      socket.close();
      process.exit(0);
    }
    await evaluate(
      'window.__TAURI_INTERNALS__.invoke("plugin:event|emit",{event:"menu",payload:"view.split"})',
    );
  }
  const start = Date.now();
  const rendered = await waitFor(
    'document.querySelector(".typst-page .textLayer")?.textContent.includes("The TeXbook")',
  );
  check("LuaLaTeX renders the multi-file project", rendered);
  check(
    "The project word map is ready",
    await waitFor('document.querySelector(".typst-preview")?.dataset.wordMap === "ready"'),
  );
  console.log(
    `Wait after setup/launch: ${Date.now() - start} ms; compilation and page load: ${await evaluate('document.querySelector("#preview")?.dataset.latexMs ?? "unavailable"')} ms`,
  );
  const preview = await evaluate(
    'document.querySelector(".typst-page .textLayer")?.textContent ?? ""',
  );
  check("Main file is visible", preview.includes("main-file sentence"));
  check("Included chapter is visible", preview.includes("Included chapter"));
  check(
    "BibTeX citation and bibliography are resolved",
    preview.includes("[1]") && preview.includes("Knuth") && preview.includes("The TeXbook"),
  );
  check("PDF canvas exists", await evaluate('!!document.querySelector(".typst-page canvas")'));
  const stats = await evaluate("window.__TAURI_INTERNALS__.invoke('latex_stats')");
  check(
    "Worker requests use the local asset and package transport",
    stats.assetRequests > 0 && stats.cacheHits + stats.cacheMisses > 0,
  );

  const sourcePoint = await evaluate(`(() => {
    const v=document.querySelector(".cm-content").cmTile.root.view;
    const r=v.coordsAtPos(v.state.doc.line(9).from+1);
    return r ? {x:r.left,y:(r.top+r.bottom)/2} : null;
  })()`);
  const previewScroll = await evaluate('document.getElementById("preview-pane").scrollTop');
  if (sourcePoint) {
    for (const type of ["mousePressed", "mouseReleased"])
      await send("Input.dispatchMouseEvent", {
        type,
        x: sourcePoint.x,
        y: sourcePoint.y,
        button: "left",
        clickCount: 1,
      });
  }
  await delay(300);
  check(
    "Source click blinks the preview without scrolling",
    (await evaluate(
      '!!(CSS.highlights.get("mdraft-sync") || CSS.highlights.get("mdraft-sync-peak"))',
    )) &&
      Math.abs(
        (await evaluate('document.getElementById("preview-pane").scrollTop')) - previewScroll,
      ) < 2,
  );

  const caretBefore = await evaluate(`(() => {
    const v=document.querySelector(".cm-content").cmTile.root.view;
    v.dispatch({selection:{anchor:0}});
    return v.state.selection.main.head;
  })()`);
  await clickPdfText("This main-file sentence");
  check(
    "PDF click paints the main-file source",
    await evaluate('!!document.querySelector(".cm-content .cm-sync-word")'),
  );
  check(
    "PDF click preserves the source caret",
    caretBefore ===
      (await evaluate(
        'document.querySelector(".cm-content").cmTile.root.view.state.selection.main.head',
      )),
  );

  await evaluate(`(() => {
    const v=document.querySelector(".cm-content").cmTile.root.view;
    const at=v.state.doc.toString().indexOf("This main-file sentence");
    v.dispatch({changes:{from:at,insert:"Unsaved main edit marker. "}});
  })()`);
  check(
    "Unsaved main-file edits reach the PDF",
    await waitFor(
      'document.querySelector(".typst-page .textLayer")?.textContent.includes("Unsaved main edit marker")',
    ),
  );
  console.log(
    `Warm edit-to-PDF: ${await evaluate('document.querySelector("#preview")?.dataset.latexMs ?? "unavailable"')} ms (plus 800 ms debounce)`,
  );
  await evaluate(`(() => {
    const v=document.querySelector(".cm-content").cmTile.root.view;
    const at=v.state.doc.toString().indexOf("Unsaved main edit marker. ");
    v.dispatch({changes:{from:at,to:at+"Unsaved main edit marker. ".length}});
  })()`);
  await waitFor(
    'document.querySelector("#preview")?.dataset.latexCurrent && !document.querySelector(".typst-page .textLayer")?.textContent.includes("Unsaved main edit marker")',
  );

  if (offline) {
    const misses = (await evaluate("window.__TAURI_INTERNALS__.invoke('latex_stats')")).cacheMisses;
    await evaluate(`(() => {
      const v=document.querySelector(".cm-content").cmTile.root.view;
      const at=v.state.doc.line(1).to+1;
      v.dispatch({changes:{from:at,insert:"\\\\usepackage{qrcode}\\n"}});
    })()`);
    const deadline = Date.now() + 30000;
    let failure = "";
    while (Date.now() < deadline && !failure) {
      failure = await evaluate(
        'document.querySelector("#preview .typst-error")?.textContent ?? ""',
      );
      if (!failure) await delay(300);
    }
    const after = await evaluate("window.__TAURI_INTERNALS__.invoke('latex_stats')");
    console.log(
      `Uncached package: misses ${misses} → ${after.cacheMisses}; error: ${failure.slice(0, 300)}`,
    );
    check(
      "An uncached package fails with the test network blocked",
      /qrcode/i.test(failure) && after.cacheMisses > misses,
    );
    await evaluate(`(() => {
      const v=document.querySelector(".cm-content").cmTile.root.view;
      const line=v.state.doc.line(2);
      v.dispatch({changes:{from:line.from,to:line.to+1}});
    })()`);
    await waitFor(
      'document.querySelector("#preview")?.dataset.latexCurrent && document.querySelector(".typst-page .textLayer")?.textContent.includes("The TeXbook")',
      120000,
      true,
    );
  }

  const latexTokenBeforeSyncTeX = Number(
    await evaluate('document.querySelector("#preview")?.dataset.latexCurrent ?? 0'),
  );
  const authoredSyncTeXInserted = await evaluate(`(() => {
    const v=document.querySelector(".cm-content").cmTile.root.view;
    const directive="\\\\synctex=1\\n";
    const at=v.state.doc.line(1).to+1;
    v.dispatch({changes:{from:at,insert:directive}});
    return v.state.doc.toString().includes(directive);
  })()`);
  const authoredSyncTeXCompiled = await waitFor(
    `Number(document.querySelector("#preview")?.dataset.latexCurrent ?? 0) > ${latexTokenBeforeSyncTeX} && document.querySelector(".typst-preview")?.dataset.wordMap === "ready"`,
  );
  const authoredSyncTeXPreserved = await evaluate(
    'document.querySelector(".cm-content").cmTile.root.view.state.doc.toString().includes("\\\\synctex=1\\n")',
  );
  check(
    "An authored SyncTeX directive is preserved and the in-memory map still builds",
    authoredSyncTeXInserted && authoredSyncTeXCompiled && authoredSyncTeXPreserved,
  );

  await clickPdfText("independent SyncTeX navigation target");
  const chapter = await waitFor(
    'document.querySelector(".cm-content").cmTile.root.view.state.doc.toString().includes("independent SyncTeX navigation target")',
    15000,
  );
  check("PDF click opens the included chapter", chapter);
  if (chapter) {
    check(
      "The main file remains the compilation root",
      await waitFor(
        'document.querySelector("#preview")?.dataset.latexCurrent && document.querySelector(".typst-page .textLayer")?.textContent.includes("The TeXbook")',
      ),
    );
    await evaluate(`(() => {
      const el=document.querySelector(".cm-content"), v=el.cmTile.root.view;
      const at=v.state.doc.toString().indexOf("independent");
      v.dispatch({selection:{anchor:at,head:at+11}});
    })()`);
    check(
      "Source selection marks the included-file word",
      await waitFor(
        '!!(CSS.highlights.get("mdraft-sync") || CSS.highlights.get("mdraft-sync-peak"))',
        5000,
      ),
    );
    await evaluate(`(() => {
      const v=document.querySelector(".cm-content").cmTile.root.view;
      v.dispatch({changes:{from:v.state.doc.length,insert:"\\nUnsaved included edit marker.\\n"}});
    })()`);
    check(
      "Unsaved included-file edits reach the PDF",
      await waitFor(
        'document.querySelector(".typst-page .textLayer")?.textContent.includes("Unsaved included edit marker")',
      ),
    );
    await evaluate(`(() => {
      const v=document.querySelector(".cm-content").cmTile.root.view;
      const text=v.state.doc.toString(), suffix="\\nUnsaved included edit marker.\\n";
      const at=text.lastIndexOf(suffix);
      if(at>=0) v.dispatch({changes:{from:at,to:at+suffix.length}});
    })()`);
  }
} finally {
  socket.close();
}
console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exitCode = 1;
