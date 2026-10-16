// Capture a PNG of the running window over CDP.
//
//   node scripts/_shot.mjs 9222 <output.png> [setupExpression]
//
// The screenshot covers the webview (the document and the Preferences panel).
// The native menu bar and window frame live outside the page and are not part
// of a DevTools screenshot.
import { writeFileSync } from "node:fs";

const [port = "9222", out = "shot.png", setup = "1"] = process.argv.slice(2);

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) {
  console.error("no page target");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) => {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((r) => pending.set(id, r));
};

await new Promise((r) => ws.addEventListener("open", r));
await send("Page.enable");
await send("Runtime.enable");

const setupResult = await send("Runtime.evaluate", {
  expression: setup,
  returnByValue: true,
  awaitPromise: true,
});
if (setupResult.result?.exceptionDetails) {
  console.error("setup failed:", JSON.stringify(setupResult.result.exceptionDetails).slice(0, 400));
  process.exit(1);
}

await new Promise((r) => setTimeout(r, 1600));

const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
const data = shot.result?.data;
if (!data) {
  console.error("capture failed:", JSON.stringify(shot).slice(0, 400));
  process.exit(1);
}
writeFileSync(out, Buffer.from(data, "base64"));
console.log(`wrote ${out} (${Math.round(Buffer.from(data, "base64").length / 1024)} KB)`);

ws.close();
process.exit(0);
