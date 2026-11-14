// Unwrap Paragraph and Wrap Paragraph through the real editor.
//
//   node scripts/reflow-test.mjs [port]
//
// Covers what the app-free reflow:unit cannot: the menu events reach the
// command, the right-click menu lists both items above Format Document, the
// edit is one undo step, the Wrap column preference is honoured, and a
// protected paragraph reports why it was left alone. The suite types into a
// new untitled tab and empties it before finishing, so it never touches a file.

import { emitMenu, openPage, sleep } from "./cdp-page.mjs";

const port = process.argv[2] ?? "9222";
const page = await openPage(port);
const { evaluate, send } = page;

let failed = 0;
let total = 0;
function check(ok, label, detail = "") {
  total += 1;
  if (!ok) failed += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? ` — ${detail}` : ""}`);
}

const view = `document.querySelector('.cm-content').cmTile.root.view`;
const docText = () => evaluate(`${view}.state.doc.toString()`);
const setText = (text, caret = 0) =>
  evaluate(`(() => { const v = ${view};
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: ${JSON.stringify(text)} }, selection: { anchor: ${caret} } });
    v.focus(); })()`);
const toastText = () =>
  evaluate(`document.getElementById('toast')?.textContent ?? ''`);

async function pollFor(expression, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await sleep(60);
  }
  return false;
}

console.log("=== a new Markdown tab ===");
await emitMenu(page, "file.new");
await sleep(600);

const wrapped = "This paragraph was\nwrapped by another\neditor at a narrow\ncolumn.\n\nSecond\nparagraph.\n";
await setText(wrapped, 3);

console.log("\n=== Unwrap Paragraph from the menu ===");
await emitMenu(page, "para.unwrap");
await sleep(200);
check(
  (await docText()) === "This paragraph was wrapped by another editor at a narrow column.\n\nSecond\nparagraph.\n",
  "the caret's paragraph is one line and the next paragraph is untouched",
  JSON.stringify(await docText()),
);
check(/Unwrapped 1 paragraph/.test(await toastText()), "the status says what changed", await toastText());

await send("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", modifiers: 2, windowsVirtualKeyCode: 90 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", modifiers: 2, windowsVirtualKeyCode: 90 });
check(await pollFor(`${view}.state.doc.toString() === ${JSON.stringify(wrapped)}`), "one Undo restores the original text");

console.log("\n=== Wrap Paragraph honours the Wrap column ===");
await setText("one two three four five six seven eight nine ten eleven twelve\n", 0);
// The harness starts from first-run settings, so the column is the default.
const savedColumn = await evaluate(`window.__TAURI_INTERNALS__.invoke("get_settings").then((s) => s.wrapColumn)`);
check(savedColumn === 80, "a first-run profile has a Wrap column of 80", String(savedColumn));
await emitMenu(page, "para.wrap");
await sleep(200);
const filled = await docText();
check(
  filled === "one two three four five six seven eight nine ten eleven twelve\n",
  "a line shorter than the column is already wrapped",
  JSON.stringify(filled),
);
const long = `${"word ".repeat(30).trim()}\n`;
await setText(long, 0);
// `runMenuAction` drops a repeat of the same menu id within 250 ms (a native
// accelerator can fire twice), so the second Wrap waits that out.
await sleep(300);
await emitMenu(page, "para.wrap");
await sleep(200);
const lines = (await docText()).split("\n").filter(Boolean);
check(
  lines.length > 1 && lines.every((line) => line.length <= 80),
  "a long line is filled to 80 columns",
  `${JSON.stringify(lines)} toast=${await toastText()}`,
);

console.log("\n=== the right-click menu ===");
await setText(wrapped, 3);
await evaluate(`(() => {
  const line = document.querySelector('.cm-line');
  const rect = line.getBoundingClientRect();
  const x = rect.left + 20, y = rect.top + rect.height / 2;
  (document.elementFromPoint(x, y) ?? line).dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, buttons: 2 }));
})()`);
await sleep(200);
const items = await evaluate(`[...document.querySelectorAll('.editor-menu .editor-menu-item')].map((b) => ({
  action: b.dataset.action, disabled: b.disabled,
  shortcut: b.querySelector('.editor-menu-shortcut')?.textContent ?? '' }))`);
const order = items.map((item) => item.action);
const at = order.indexOf("format");
check(
  at >= 2 && order[at - 2] === "unwrapParagraph" && order[at - 1] === "wrapParagraph",
  "Unwrap and Wrap Paragraph sit directly above Format Document",
  order.join(","),
);
const unwrapItem = items.find((item) => item.action === "unwrapParagraph");
check(unwrapItem && !unwrapItem.disabled, "the items are enabled in a Markdown document");
check(unwrapItem?.shortcut === "Shift+Alt+Q", "Unwrap shows its shortcut", unwrapItem?.shortcut);
await evaluate(`document.querySelector('.editor-menu-item[data-action="unwrapParagraph"]').click()`);
await sleep(200);
check(
  (await docText()).startsWith("This paragraph was wrapped by another editor at a narrow column.\n"),
  "the right-click item unwraps the paragraph",
);

console.log("\n=== a protected paragraph says why ===");
await emitMenu(page, "file.new");
await sleep(600);
await setText("```\ncode\nblock\n```\n", 5);
await emitMenu(page, "para.unwrap");
await sleep(200);
check((await docText()) === "```\ncode\nblock\n```\n", "a fenced code block is left alone");
check(/no paragraph of prose/.test(await toastText()), "the status says there is no paragraph", await toastText());

// Leave nothing dirty for the harness's shutdown.
await setText("");

console.log(`\n${total - failed}/${total} checks passed`);
page.close();
process.exit(failed ? 1 : 0);
