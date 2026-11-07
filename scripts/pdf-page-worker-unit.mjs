//! A worker must not send an entire large index in one UI-thread message.
import assert from "node:assert/strict";

const messages = [];
globalThis.self = { postMessage: (message) => messages.push(message) };
await import("../src/pdf-page-map-worker.ts");
const source = Array.from({ length: 1200 }, (_, i) => `word${String(i).padStart(4, "0")}`).join(
  " ",
);
await self.onmessage({
  data: {
    language: "typst",
    files: [{ path: "test.typ", source }],
    lines: [{ text: source, region: "1:0" }],
  },
});
assert.equal(messages.length, 1);
assert.equal(messages[0].anchors.length, 512);
assert.equal(messages[0].done, false);
await self.onmessage({ data: { next: true } });
assert.equal(messages.length, 2);
assert.equal(messages[1].anchors.length, 512);
assert.equal(messages[1].done, false);
await self.onmessage({ data: { next: true } });
assert.equal(messages.length, 3);
assert.equal(messages[2].anchors.length, 176);
assert.equal(messages[2].done, true);
const anchors = messages.flatMap((message) => message.anchors);
assert.equal(anchors.length, 1200);
assert.ok(
  anchors.every(
    (anchor, i) => source.slice(anchor.from, anchor.to) === `word${String(i).padStart(4, "0")}`,
  ),
);
console.log("11/11 PDF worker batch protocol checks passed");
