//! Ownership and failure recovery of the preview worker queue; no application.
//!
//! Run with Node 24: node scripts/preview-worker-unit.mjs

import * as preview from "../src/preview-worker-client.ts";

let passed = 0;
let failed = 0;
function check(label, ok) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (ok) passed += 1;
  else failed += 1;
}

class FakeWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  messages = [];
  terminated = false;

  constructor(throwOnPost = false) {
    this.throwOnPost = throwOnPost;
  }

  postMessage(message) {
    if (this.throwOnPost) throw new DOMException("cannot clone", "DataCloneError");
    this.messages.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  reply(message) {
    this.onmessage?.({ data: message });
  }
}

check(
  "worker channel can be tested independently",
  typeof preview.PreviewWorkerChannel === "function",
);
if (typeof preview.PreviewWorkerChannel === "function") {
  const workers = [];
  const channel = new preview.PreviewWorkerChannel(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  const first = channel.request("first", {});
  check(
    "first render is sent to one worker",
    workers.length === 1 && workers[0].messages.length === 1,
  );
  const second = channel.request("second", {});
  check("a newer render settles the old caller as superseded", (await first).kind === "superseded");
  check("a superseded active worker is terminated", workers[0].terminated);
  check(
    "the newest render starts in a fresh worker",
    workers.length === 2 && workers[1].messages[0].source === "second",
  );
  workers[0].reply({ id: workers[0].messages[0].id, ok: true, data: "old" });
  workers[1].reply({ id: workers[1].messages[0].id, ok: true, data: "new" });
  const secondResult = await second;
  check(
    "a late response cannot replace the newest result",
    secondResult.kind === "ok" && secondResult.data === "new",
  );

  const third = channel.request("third", {});
  channel.cancel();
  check("mode or tab cancellation settles the current caller", (await third).kind === "superseded");
  check("mode or tab cancellation stops active work", workers[1].terminated);
  const fourth = channel.request("fourth", {});
  check("a cancelled channel can start again", workers.length === 3);
  workers[2].reply({ id: workers[2].messages[0].id, ok: true, data: "restored" });
  check("the next render succeeds", (await fourth).kind === "ok");

  const throwing = new preview.PreviewWorkerChannel(() => new FakeWorker(true));
  check(
    "postMessage exceptions resolve as fallback",
    (await throwing.request("x", {})).kind === "fallback",
  );
  check(
    "a failed channel does not leave later callers pending",
    (await throwing.request("y", {})).kind === "fallback",
  );

  const badMessages = [];
  const invalid = new preview.PreviewWorkerChannel(() => {
    const worker = new FakeWorker();
    badMessages.push(worker);
    return worker;
  });
  const invalidResult = invalid.request("bad reply", {});
  badMessages[0].reply({ unexpected: true });
  check("malformed responses fail safely", (await invalidResult).kind === "fallback");
  check("malformed response terminates the worker", badMessages[0].terminated);

  let wrongDataWorker;
  const wrongData = new preview.PreviewWorkerChannel(
    () => (wrongDataWorker = new FakeWorker()),
    (value) => Array.isArray(value?.chunks),
  );
  const wrongDataResult = wrongData.request("wrong shape", {});
  wrongDataWorker.reply({ id: wrongDataWorker.messages[0].id, ok: true, data: { chunks: 7 } });
  check("a malformed successful payload falls back", (await wrongDataResult).kind === "fallback");
  check("a malformed payload terminates the worker", wrongDataWorker.terminated);

  let messageWorker;
  const messageError = new preview.PreviewWorkerChannel(() => (messageWorker = new FakeWorker()));
  const decoding = messageError.request("bad clone", {});
  messageWorker.onmessageerror?.({});
  check(
    "message deserialization failure resolves as fallback",
    (await decoding).kind === "fallback",
  );
  check("message deserialization failure terminates the worker", messageWorker.terminated);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
