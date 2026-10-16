// Exercise the image paste paths through the real UI.
//
//   node scripts/_test-images.mjs 9222 http://127.0.0.1:8791/served.png
const PORT = Number(process.argv[2] ?? 9222);
const IMAGE_URL = process.argv[3] ?? "http://127.0.0.1:8791/served.png";
const LOCAL_PATH = process.argv[4] ?? "";

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const consoleIssues = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method === "Runtime.exceptionThrown") {
    consoleIssues.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  }
});
const send = (method, params = {}) => {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((r) => pending.set(id, r));
};
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 700));
  }
  const v = r.result.result.value;
  return typeof v === "string" ? JSON.parse(v) : v;
};

await new Promise((r) => ws.addEventListener("open", r));
await send("Runtime.enable");

const report = {};
const pulse = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const content = document.querySelector('.cm-content');
  const editorText = () => document.querySelector('.cm-content').innerText;
  const toastText = () => document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent;
  const snapshot = () => ({
    images: document.querySelectorAll('#preview img').length,
    brokenImages: [...document.querySelectorAll('#preview img')].filter((i) => i.complete && i.naturalWidth === 0).length,
    toast: toastText(),
    tail: editorText().replace(/\\s+/g, ' ').slice(-220)
  });

  // ---- 1. a clipboard bitmap ------------------------------------------------
  const canvas = document.createElement('canvas');
  canvas.width = 6; canvas.height = 6;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#3b7ddd'; ctx.fillRect(0, 0, 6, 6);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const bitmapData = new DataTransfer();
  bitmapData.items.add(new File([blob], 'from-clipboard.png', { type: 'image/png' }));
  content.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData: bitmapData, bubbles: true, cancelable: true
  }));
  await sleep(2600);
  const afterBitmap = snapshot();

  // ---- 2. a pasted image URL ------------------------------------------------
  const urlData = new DataTransfer();
  urlData.setData('text/plain', ${JSON.stringify(IMAGE_URL)});
  content.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData: urlData, bubbles: true, cancelable: true
  }));
  await sleep(3200);
  const afterUrl = snapshot();

  // ---- 3. a pasted local file path ------------------------------------------
  const localData = new DataTransfer();
  localData.setData('text/plain', ${JSON.stringify(LOCAL_PATH)});
  content.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData: localData, bubbles: true, cancelable: true
  }));
  await sleep(2400);
  const afterLocalPath = snapshot();

  // ---- 4. the same URL with "apply to online images" turned off -------------
  document.getElementById('btn-prefs').click();
  await sleep(120);
  [...document.querySelectorAll('.prefs-section')].find((s) => s.textContent === 'Image').click();
  const onlineRow = [...document.querySelectorAll('.prefs-row')].find((r) =>
    (r.querySelector('.prefs-label')?.textContent ?? '').startsWith('Apply Above Rules to Online'));
  onlineRow.querySelector('input[type=checkbox]').click();
  await sleep(150);
  const onlineOff = onlineRow.querySelector('input[type=checkbox]').checked;
  const overlay = document.querySelector('.prefs-overlay');
  overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(200);

  const urlData2 = new DataTransfer();
  urlData2.setData('text/plain', ${JSON.stringify(IMAGE_URL)});
  content.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData: urlData2, bubbles: true, cancelable: true
  }));
  await sleep(1500);
  const afterOnlineOff = snapshot();

  // Restore the preference.
  document.getElementById('btn-prefs').click();
  await sleep(120);
  [...document.querySelectorAll('.prefs-section')].find((s) => s.textContent === 'Image').click();
  const restoreRow = [...document.querySelectorAll('.prefs-row')].find((r) =>
    (r.querySelector('.prefs-label')?.textContent ?? '').startsWith('Apply Above Rules to Online'));
  restoreRow.querySelector('input[type=checkbox]').click();
  await sleep(150);
  const restored = restoreRow.querySelector('input[type=checkbox]').checked;
  document.querySelector('.prefs-overlay').dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  return JSON.stringify({ afterBitmap, afterUrl, afterLocalPath, onlineOff, afterOnlineOff, restored });
})()`;

const result = await evaluate(pulse);
console.log("=== image paste paths ===");
for (const [step, value] of Object.entries(result)) {
  console.log(`  ${step}: ${JSON.stringify(value)}`);
}
if (consoleIssues.length > 0) {
  console.log("\n=== console exceptions ===");
  for (const line of consoleIssues.slice(0, 6)) console.log("  " + line.split("\n")[0]);
}
ws.close();
process.exit(0);
