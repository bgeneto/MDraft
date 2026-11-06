// Where a pasted image goes, for every Preferences › Image rule and for an
// unsaved document.
//
//   node scripts/image-rules-test.mjs [port]
//
// The document starts open (samples/feature-tour.md); the suite opens a
// temporary `notes.md` and works only on copies. It serves four fixtures from
// a local port: a PNG, a WebP, a synthetic AVIF header, an HTML page behind a
// `.png` name, and a 401 answer. Nothing depends on the network.
//
// The failing addresses are the reported bug: the bytes never arrive, so the
// rule cannot copy anything; the app must say why and keep the address instead
// of writing a bogus `.png`.

import { createServer } from "node:http";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { marked } from "marked";

const port = Number(process.argv[2] ?? 9222);
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((target) => target.type === "page");
if (!page) {
  console.error("no page target; start the application with the debug port open");
  process.exit(1);
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n1cAAAAASUVORK5CYII=",
  "base64",
);
const WEBP = Buffer.from("UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=", "base64");
const AVIF = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x1c]),
  Buffer.from("ftypmif1"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("avifmif1miaf"),
]);
const server = createServer((request, response) => {
  if (request.url === "/signin.png") {
    const body = Buffer.from('{"detail":"Not authenticated"}');
    response.writeHead(401, { "Content-Type": "application/json", "Content-Length": body.length });
    response.end(body);
    return;
  }
  if (request.url === "/html.png") {
    const body = Buffer.from("<!DOCTYPE html><html><body>Please sign in</body></html>");
    response.writeHead(200, { "Content-Type": "text/html", "Content-Length": body.length });
    response.end(body);
    return;
  }
  const body = request.url === "/modern.webp" ? WEBP : request.url === "/modern.avif" ? AVIF : PNG;
  const type =
    request.url === "/modern.webp"
      ? "image/webp"
      : request.url === "/modern.avif"
        ? "image/avif"
        : "image/png";
  response.writeHead(200, { "Content-Type": type, "Content-Length": body.length });
  response.end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const pngUrl = `${base}/served.png`;
const signinUrl = `${base}/signin.png`;
const htmlUrl = `${base}/html.png`;

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
  const response = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.exception?.description ?? "evaluate failed");
  }
  return response.result.result.value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
let total = 0;
function check(ok, label, detail = "") {
  total += 1;
  if (ok) passed += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function pollFor(expression, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await sleep(120);
  }
  return false;
}

const invoke = (command, args = {}) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
  );
const emit = (event, payload) => invoke("plugin:event|emit", { event, payload });

const work = mkdtempSync(path.join(tmpdir(), "mdraft-image-rules-"));
const pictures = path.join(work, ".hidden", "pictures");
const media = path.join(work, "media");
const document = path.join(work, "notes.md");
const spaced = path.join(work, "a b.png");
const fileUrlImage = path.join(work, "c d.png");
mkdirSync(pictures, { recursive: true });
mkdirSync(path.join(work, "notes.assets"));
writeFileSync(path.join(work, "notes.assets", "seed.png"), PNG);
writeFileSync(document, "# Notes\n\n![seed](notes.assets/seed.png)\n\nStart.\n");
writeFileSync(spaced, PNG);
writeFileSync(fileUrlImage, PNG);

const activeName = `document.querySelector('.doc-tab[aria-selected="true"] .doc-tab-name')?.textContent`;
const lines = () =>
  evaluate(
    "JSON.stringify([...document.querySelectorAll('.cm-line')].map((line) => line.textContent))",
  ).then((raw) => JSON.parse(raw).join("\n"));
const listDir = (dir) => (existsSync(dir) ? readdirSync(dir) : []);

async function focusEditor() {
  await evaluate("document.querySelector('.cm-content').focus()");
}

async function pasteText(text) {
  await focusEditor();
  await evaluate(`(() => {
    const data = new DataTransfer();
    data.setData('text/plain', ${JSON.stringify(text)});
    document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: data, bubbles: true, cancelable: true
    }));
  })()`);
  await sleep(2600);
}

async function pasteBitmap() {
  await focusEditor();
  await evaluate(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 6; canvas.height = 6;
    const context = canvas.getContext('2d');
    context.fillStyle = '#3b7ddd';
    context.fillRect(0, 0, 6, 6);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const data = new DataTransfer();
    data.items.add(new File([blob], 'clipboard.png', { type: 'image/png' }));
    document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: data, bubbles: true, cancelable: true
    }));
  })()`);
  await sleep(2600);
}

async function newTab() {
  await focusEditor();
  await evaluate(`document.querySelector('.cm-content').dispatchEvent(new KeyboardEvent('keydown', {
    code: 'KeyN', key: 'n', ctrlKey: true, bubbles: true
  }))`);
  await sleep(700);
  await focusEditor();
}

async function openImageSection() {
  await evaluate("document.getElementById('btn-prefs').click()");
  await sleep(250);
  await evaluate(`(() => {
    const item = [...document.querySelectorAll('.prefs-section')].find((node) => node.textContent.trim() === 'Image');
    if (!item) throw new Error('missing Image section');
    item.click();
  })()`);
  await sleep(250);
}

const row = (label) => `[...document.querySelectorAll('.prefs-row')].find((node) =>
  (node.querySelector('.prefs-label')?.textContent ?? '').replace(/\\?$/, '').trim() === ${JSON.stringify(label)})`;

async function setRule(value) {
  await openImageSection();
  await evaluate(`(() => {
    const select = ${row("When Insert…")}?.querySelector('select');
    if (!select) throw new Error('missing When Insert row');
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  })()`);
  await sleep(300);
}

async function setCustomDir(value) {
  await evaluate(`(() => {
    const input = ${row("Custom Folder")}?.querySelector('input');
    if (!input) throw new Error('missing Custom Folder row');
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value;
  })()`);
  await sleep(300);
}

async function closePreferences() {
  await evaluate(
    "document.querySelector('.prefs-overlay').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
  );
  await sleep(250);
}

const toastHas = (part) =>
  pollFor(
    `(document.getElementById('toast')?.textContent ?? '').includes(${JSON.stringify(part)})`,
    6000,
  );

try {
  const opened = await (async () => {
    await emit("open-files", [document]);
    return pollFor(
      `${activeName} === 'notes.md' && document.querySelectorAll('.cm-line').length > 0`,
    );
  })();
  check(opened, "the temporary Markdown document opens");
  check(
    await pollFor(
      `(() => {
        const images = [...document.querySelectorAll('#preview img')];
        return images.some((img) => {
          const raw = img.getAttribute('data-src') ?? img.getAttribute('src') ?? '';
          return raw.includes('notes.assets/seed.png') && img.complete && img.naturalWidth > 0;
        });
      })()`,
      8000,
    ),
    "a relative image without ./ renders in the preview",
  );

  console.log("\n=== a saved document ===");
  await setRule("assetsFolder");
  await closePreferences();

  const assetsBefore = listDir(path.join(work, "notes.assets")).length;
  await pasteText(signinUrl);
  check(await toastHas("needs a sign-in"), "a 401 image is explained as a sign-in problem");
  check(await toastHas("401"), "the 401 status is named");
  check((await lines()).includes(signinUrl), "the protected address stays in the document");
  check(listDir(path.join(work, "notes.assets")).length === assetsBefore, "a 401 writes no file");

  await pasteText(htmlUrl);
  check(await toastHas("did not return an image"), "HTML behind a .png name is refused");
  check((await lines()).includes(htmlUrl), "the HTML address stays in the document");
  check(
    listDir(path.join(work, "notes.assets")).length === assetsBefore,
    "a non-image response writes no file",
    JSON.stringify(listDir(path.join(work, "notes.assets"))),
  );

  await pasteText(pngUrl);
  const downloaded = await lines();
  check(
    downloaded.includes("notes.assets/served.png"),
    "a PNG URL is copied to ./${filename}.assets",
    downloaded,
  );
  check(
    listDir(path.join(work, "notes.assets")).includes("served.png"),
    "the PNG file exists",
    JSON.stringify(listDir(path.join(work, "notes.assets"))),
  );

  console.log("\n=== the custom folder ===");
  await setRule("custom");
  await setCustomDir(pictures);
  await closePreferences();

  await pasteText(pngUrl);
  const custom = await lines();
  check(custom.includes("pictures/served.png"), "a custom folder is used", custom);
  check(
    listDir(pictures).filter((name) => name.startsWith("served")).length >= 1,
    "the file lands in the custom folder",
    JSON.stringify(listDir(pictures)),
  );
  check(
    await pollFor(
      `(() => {
        const images = [...document.querySelectorAll('#preview img')];
        return images.some((img) => {
          const raw = img.getAttribute('data-src') ?? img.getAttribute('src') ?? '';
          return raw.includes('pictures') && img.complete && img.naturalWidth > 0;
        });
      })()`,
      6000,
    ),
    "the custom-folder image renders in the preview",
  );

  // Opt-in live check against the three public images the report named. The
  // default suite is hermetic; this runs only when asked, because it needs the
  // network by definition.
  if (process.argv.includes("--live")) {
    const live = [
      [
        "https://noticias.unb.br/images/Noticias/2026/10-out/21102026_Peacartesmarciais_Divulgacao.jpeg",
        "21102026_Peacartesmarciais_Divulgacao.jpg",
        "JPEG",
      ],
      ["https://www.gstatic.com/webp/gallery/1.webp", "1.webp", "WebP"],
      ["https://www.aviftools.net/img/samples/sunset-beach.avif", "sunset-beach.avif", "AVIF"],
    ];
    for (const [url, name, label] of live) {
      await pasteText(url);
      const copied = await pollFor(
        `([...document.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\\n')).includes(${JSON.stringify(name)})`,
        25000,
      );
      check(copied, `live ${label}: the public image is copied to the custom folder`, name);
      check(
        listDir(pictures).includes(name),
        `live ${label}: the file exists`,
        JSON.stringify(listDir(pictures)),
      );
    }
  }

  await setRule("custom");
  await setCustomDir(path.join(media, "${filename}"));
  await closePreferences();

  await pasteBitmap();
  const token = await lines();
  check(token.includes("media/notes/"), "${filename} expands to the document name", token);
  check(listDir(path.join(media, "notes")).length >= 1, "the token folder receives the file");

  console.log("\n=== pasted forms ===");
  const beforeSpaced = listDir(path.join(media, "notes")).length;
  await pasteText(`"${spaced}"`);
  const quoted = await lines();
  check(quoted.includes("a-b.png"), "a quoted path with a space is imported", quoted);
  check(
    listDir(path.join(media, "notes")).length === beforeSpaced + 1,
    "the quoted source wrote one file",
    JSON.stringify(listDir(path.join(media, "notes"))),
  );

  const fileUrl = `file:///${fileUrlImage.replace(/\\/g, "/").replace(/ /g, "%20")}`;
  await pasteText(fileUrl);
  const decoded = await lines();
  check(decoded.includes("c-d.png"), "a file:// URL is percent-decoded and imported", decoded);

  const dataUrl = `data:image/png;base64,${PNG.toString("base64")}`;
  await pasteText(dataUrl);
  const embedded = await lines();
  check(embedded.includes("media/notes/image-"), "a data: URL is saved like a bitmap", embedded);

  console.log("\n=== an unsaved document ===");
  await newTab();
  check((await evaluate(activeName)) === "Untitled", "Ctrl+N opens an untitled tab");

  await setRule("assetsFolder");
  await closePreferences();
  await pasteText(pngUrl);
  const kept = await lines();
  check(kept.includes(pngUrl), "an untitled document keeps the image URL", kept);
  check(await toastHas("no folder yet"), "the kept address is explained");

  const beforeBitmap = await lines();
  await pasteBitmap();
  check((await lines()) === beforeBitmap, "an untitled bitmap inserts nothing");
  check(await toastHas("Save it first"), "the bitmap asks for a save");

  await setRule("custom");
  await setCustomDir(pictures);
  await closePreferences();
  await pasteBitmap();
  const absolute = await lines();
  check(
    absolute.includes(pictures.replace(/\\/g, "\\\\")),
    "an absolute custom folder works without a saved document",
    absolute,
  );
  const imageToken = marked
    .lexer(absolute)
    .flatMap((token) => token.tokens ?? [])
    .find((token) => token.type === "image" && token.href.includes("pictures"));
  check(
    imageToken?.href.startsWith(pictures + path.sep),
    "Markdown preserves the absolute path through a dot-prefixed folder",
    imageToken?.href ?? "no image token",
  );
  check(
    listDir(pictures).some((name) => name.startsWith("image-")),
    "the untitled bitmap landed in the custom folder",
    JSON.stringify(listDir(pictures)),
  );
  check(
    await pollFor(
      `(() => {
        const images = [...document.querySelectorAll('#preview img')];
        return images.some((img) => {
          const raw = img.getAttribute('data-src') ?? img.getAttribute('src') ?? '';
          return raw.includes('pictures') && img.complete && img.naturalWidth > 0;
        });
      })()`,
      6000,
    ),
    "the absolute-path image renders in the preview",
  );

  if (process.platform === "win32") {
    console.log("\n=== legacy Windows image destinations ===");
    const legacyDir = path.join(work, "legacy", ".codex");
    const ordinaryDir = path.join(work, "legacy.codex");
    const legacyImage = path.join(legacyDir, "image.png");
    const dotImage = path.join(legacyDir, ".image.png");
    const spacedLegacyDir = path.join(work, "legacy space", ".images");
    const spacedLegacyImage = path.join(spacedLegacyDir, "image.png");
    const ordinaryImage = path.join(ordinaryDir, "image.png");
    const ordinaryDotImage = path.join(work, "legacy.codex.image.png");
    const ordinarySpacedDir = path.join(work, "legacy space.images");
    const ordinarySpacedImage = path.join(ordinarySpacedDir, "image.png");
    const legacyDoc = path.join(work, "legacy-document.md");
    const collisionDoc = path.join(work, "legacy-collision.md");
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(spacedLegacyDir, { recursive: true });
    writeFileSync(legacyImage, PNG);
    writeFileSync(dotImage, PNG);
    writeFileSync(spacedLegacyImage, PNG);
    const legacySource = `![inline](${legacyImage})\n\n![reference][old]\n\n![relative](.\\legacy\\.codex\\image.png)\n\n![bare](legacy\\.codex\\image.png)\n\n![dot](${dotImage})\n\n![encoded](${spacedLegacyImage.replace(/ /g, "%20")})\n\n[old]: ${legacyImage}\n`;
    writeFileSync(legacyDoc, legacySource);
    await emit("open-files", [legacyDoc]);
    check(
      await pollFor(`${activeName} === 'legacy-document.md'`),
      "the legacy image document opens",
    );
    const legacyLoaded = await pollFor(
      `(() => {
        const images=[...document.querySelectorAll('#preview img')];
        return images.length===6 && images.every((img,index)=>img.complete && img.naturalWidth>0 && img.dataset.src===(index===5?${JSON.stringify(spacedLegacyImage)}:index===4?${JSON.stringify(dotImage)}:${JSON.stringify(legacyImage)}));
      })()`,
      20000,
    );
    check(
      legacyLoaded,
      "inline, reference and relative images recover the local legacy destination",
      legacyLoaded
        ? ""
        : JSON.stringify(
            await evaluate(
              `([...document.querySelectorAll('#preview img')]).map(img=>({src:img.dataset.src,loaded:img.complete,width:img.naturalWidth}))`,
            ),
          ),
    );
    check(
      (await evaluate(
        `document.querySelector('.cm-content').cmTile.root.view.state.doc.toString()`,
      )) === legacySource,
      "legacy image recovery leaves the document unchanged",
    );
    const exportFile = path.join(work, "legacy-export.html");
    await evaluate(`(() => {
      window.__legacyExportFetch=window.fetch;
      window.fetch=async function(input,options){
        const url=new URL(typeof input==='string'?input:input.url,location.href);
        if(url.hostname==='ipc.localhost' && decodeURIComponent(url.pathname.slice(1))==='plugin:dialog|save')
          return new Response(JSON.stringify(${JSON.stringify(exportFile)}),{headers:{'Content-Type':'application/json','Tauri-Response':'ok'}});
        return window.__legacyExportFetch.call(window,input,options);
      };
    })()`);
    await emit("menu", "export.html");
    const exportDeadline = Date.now() + 30000;
    while (!existsSync(exportFile) && Date.now() < exportDeadline) await sleep(100);
    const exported = existsSync(exportFile) ? readFileSync(exportFile, "utf8") : "";
    await evaluate(`window.fetch=window.__legacyExportFetch`);
    check(
      exported.includes("legacy/.codex/image.png") &&
        exported.includes("legacy/.codex/.image.png") &&
        exported.includes("legacy%20space/.images/image.png") &&
        !exported.includes("data-mdraft-legacy"),
      "HTML export preserves the recovered destination without internal stamps",
    );
    const autoWasOn = await evaluate(`(() => {
      const flag=document.getElementById('flag-auto-save'),wasOn=flag.dataset.on==='true';
      if(!wasOn) flag.click();
      const view=document.querySelector('.cm-content').cmTile.root.view;
      view.dispatch({selection:{anchor:0}});view.focus();return wasOn;
    })()`);
    const editMarker = "legacy-autosave-check\n";
    const waitForDisk = async (expected) => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (readFileSync(legacyDoc, "utf8") === expected) return true;
        await sleep(200);
      }
      return false;
    };
    const historyKey = async (key, code) => {
      await evaluate(`(() => {
        const target=document.querySelector('.cm-content');target.focus();
        target.dispatchEvent(new KeyboardEvent('keydown', {key:${JSON.stringify(key)},code:${JSON.stringify(code)},ctrlKey:true,bubbles:true}));
      })()`);
    };
    await send("Input.insertText", { text: editMarker });
    check(
      await waitForDisk(editMarker + legacySource),
      "Auto Save preserves a deliberate edit beside recovered legacy images",
    );
    await historyKey("z", "KeyZ");
    check(
      await pollFor(
        `document.querySelector('.cm-content').cmTile.root.view.state.doc.toString() === ${JSON.stringify(legacySource)}`,
      ),
      "undo restores the original legacy source",
    );
    await historyKey("y", "KeyY");
    check(
      await pollFor(
        `document.querySelector('.cm-content').cmTile.root.view.state.doc.toString() === ${JSON.stringify(editMarker + legacySource)}`,
      ),
      "redo restores the deliberate edit and legacy source",
    );
    await historyKey("z", "KeyZ");
    check(await waitForDisk(legacySource), "Auto Save persists the source restored by undo");
    if (!autoWasOn) await evaluate(`document.getElementById('flag-auto-save').click()`);
    const repeatedDoc = path.join(work, "legacy-repeated.md");
    writeFileSync(
      repeatedDoc,
      Array.from({ length: 100 }, () => `![repeated](${legacyImage})`).join("\n\n"),
    );
    await evaluate(`(() => {
      window.__legacyOriginalFetch=window.fetch;
      window.__legacyCalls=0;
      window.fetch=function(input,...args){
        const url=new URL(typeof input==='string'?input:input.url,location.href);
        if(url.hostname==='ipc.localhost' && decodeURIComponent(url.pathname.slice(1))==='resolve_legacy_local_image') window.__legacyCalls++;
        return window.__legacyOriginalFetch.call(this,input,...args);
      };
    })()`);
    const repeatedStarted = Date.now();
    await emit("open-files", [repeatedDoc]);
    await pollFor(`${activeName} === 'legacy-repeated.md'`);
    await pollFor(`document.querySelectorAll('#preview img').length === 100`);
    // Off-screen preview images are deliberately lazy; force this synthetic
    // stress case to request all of them before checking resolution sharing.
    await evaluate(
      `document.querySelectorAll('#preview img').forEach(img=>{img.loading='eager';})`,
    );
    const repeatedLoaded = await pollFor(
      `(() => {
      const images=[...document.querySelectorAll('#preview img')];
      return images.length===100 && images.every(img=>img.complete && img.naturalWidth>0);
    })()`,
      30000,
    );
    const repeatedCalls = await evaluate(`(() => {
      window.fetch=window.__legacyOriginalFetch;
      return window.__legacyCalls;
    })()`);
    const repeatedDiagnostics = repeatedLoaded
      ? null
      : await evaluate(`(() => {
      const images=[...document.querySelectorAll('#preview img')];
      return {count:images.length, loaded:images.filter(img=>img.complete&&img.naturalWidth>0).length,
        failed:images.filter(img=>img.complete&&img.naturalWidth===0).length,
        pending:images.filter(img=>!img.complete).length,
        examples:images.filter(img=>!img.complete||img.naturalWidth===0).slice(0,3).map(img=>({src:img.src,source:img.dataset.src}))};
    })()`);
    check(
      repeatedLoaded && repeatedCalls === 1,
      "100 repeated legacy images share one local resolution",
      `calls=${repeatedCalls}, elapsed=${Date.now() - repeatedStarted} ms, diagnostics=${JSON.stringify(repeatedDiagnostics)}`,
    );
    mkdirSync(ordinaryDir, { recursive: true });
    mkdirSync(ordinarySpacedDir, { recursive: true });
    writeFileSync(ordinaryImage, "not an image");
    writeFileSync(ordinaryDotImage, "not an image");
    writeFileSync(ordinarySpacedImage, "not an image");
    writeFileSync(collisionDoc, legacySource);
    await emit("open-files", [collisionDoc]);
    await pollFor(`${activeName} === 'legacy-collision.md'`);
    await pollFor(`document.querySelectorAll('#preview img').length===6`);
    await sleep(2000);
    check(
      await evaluate(
        `([...document.querySelectorAll('#preview img')]).every(img=>img.complete && img.naturalWidth===0 && img.dataset.src!==${JSON.stringify(legacyImage)} && img.dataset.src!==${JSON.stringify(dotImage)})`,
      ),
      "an existing ordinary destination wins even when it is not an image",
    );
    const validCollisionDoc = path.join(work, "legacy-valid-collision.md");
    writeFileSync(ordinaryImage, PNG);
    writeFileSync(ordinaryDotImage, PNG);
    writeFileSync(ordinarySpacedImage, PNG);
    writeFileSync(validCollisionDoc, legacySource);
    await emit("open-files", [validCollisionDoc]);
    await pollFor(`${activeName} === 'legacy-valid-collision.md'`);
    check(
      await pollFor(`(() => {
        const images=[...document.querySelectorAll('#preview img')];
        return images.length===6 && images.every(img=>img.complete && img.naturalWidth>0 && img.dataset.src!==${JSON.stringify(legacyImage)} && img.dataset.src!==${JSON.stringify(dotImage)} && img.dataset.src!==${JSON.stringify(spacedLegacyImage)});
      })()`),
      "an existing valid Markdown destination wins over the legacy candidate",
    );
    const junction = path.join(work, "legacy-junction");
    try {
      symlinkSync(legacyDir, junction, "junction");
      const viaJunction = await invoke("resolve_legacy_local_image", {
        primary: path.join(work, "missing-image.png"),
        candidate: path.join(junction, "image.png"),
        documentPath: null,
      });
      check(viaJunction === null, "legacy fallback refuses a junction");
    } finally {
      if (existsSync(junction)) unlinkSync(junction);
    }
    const unc = await invoke("resolve_legacy_local_image", {
      primary: path.join(work, "missing-image.png"),
      candidate: String.raw`\\server\share\image.png`,
      documentPath: null,
    });
    check(unc === null, "legacy fallback refuses UNC before querying it");
    const missing = await invoke("resolve_legacy_local_image", {
      primary: path.join(work, "not-found.png"),
      candidate: path.join(legacyDir, "not-found.png"),
      documentPath: null,
    });
    check(missing === null, "legacy fallback does not invent a missing image");
  }
} finally {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
  server.closeAllConnections?.();
  server.close();
  ws.close();
}

console.log(`\n${passed}/${total} checks passed`);
process.exit(passed === total ? 0 : 1);
