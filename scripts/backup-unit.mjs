//! App-free checks for bounded capture of current unsaved text.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { captureBackupDocuments, textFromString } from "../src/backup.ts";
import { createRecoveredScheduler } from "../src/recovered-documents.ts";

let failures = 0;
async function check(name, test) {
  try {
    await test();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

const metadata = {
  id: "draft-1",
  name: "Draft.md",
  language: "markdown",
  path: null,
  lineEnding: "\n",
  hadBom: false,
  encoding: "UTF-8",
  lossy: false,
  readOnly: false,
  baseModifiedMs: 0,
  baseSize: 0,
  baseSha256: null,
};

function sink() {
  const chunks = [];
  let completed = null;
  return {
    chunks,
    get completed() {
      return completed;
    },
    async begin(_job, value) {
      assert.equal(value.id, metadata.id);
    },
    async append(_job, _id, sequence, bytes) {
      assert.equal(sequence, chunks.length);
      chunks.push(Buffer.from(bytes));
      return chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    },
    async finish(_job, _id, sequences, bytes) {
      completed = { sequences, bytes };
    },
  };
}

await check("captures Unicode across a chunk boundary", async () => {
  const text = `${"x".repeat(32767)}🌎 tail`;
  const output = sink();
  await captureBackupDocuments(
    "job",
    [{ metadata, text: textFromString(text) }],
    output,
    () => false,
  );
  assert.equal(Buffer.concat(output.chunks).toString("utf8"), text);
  assert.equal(output.completed.bytes, Buffer.byteLength(text));
  assert.ok(output.chunks.every((chunk) => chunk.length <= 256 * 1024));
});

await check("captures an empty dirty buffer", async () => {
  const output = sink();
  await captureBackupDocuments(
    "job",
    [{ metadata, text: textFromString("") }],
    output,
    () => false,
  );
  assert.deepEqual(output.completed, { sequences: 0, bytes: 0 });
});

await check("captures a dirty buffer beyond the recovery journal limit", async () => {
  const text = `${"a".repeat(16 * 1024 * 1024)}🌎 end`;
  const digest = createHash("sha256");
  let received = 0;
  let finished = 0;
  await captureBackupDocuments(
    "job",
    [{ metadata, text: textFromString(text) }],
    {
      async begin() {},
      async append(_job, _id, _sequence, bytes) {
        digest.update(bytes);
        received += bytes.length;
        return received;
      },
      async finish(_job, _id, _sequences, bytes) {
        finished = bytes;
      },
    },
    () => false,
  );
  assert.equal(finished, Buffer.byteLength(text));
  assert.equal(digest.digest("hex"), createHash("sha256").update(text).digest("hex"));
});

await check("captures more than 64 unsaved documents in order", async () => {
  const documents = Array.from({ length: 70 }, (_, index) => ({
    metadata: { ...metadata, id: `draft-${index}` },
    text: textFromString(`draft ${index}`),
  }));
  const finished = [];
  let received = 0;
  await captureBackupDocuments(
    "job",
    documents,
    {
      async begin() {
        received = 0;
      },
      async append(_job, _id, _sequence, bytes) {
        received += bytes.length;
        return received;
      },
      async finish(_job, id, _sequences, bytes) {
        finished.push({ id, bytes });
      },
    },
    () => false,
  );
  assert.deepEqual(
    finished,
    documents.map(({ metadata: item, text }) => ({ id: item.id, bytes: text.length })),
  );
});

await check("rejects unpaired surrogates without replacement", async () => {
  const output = sink();
  await assert.rejects(
    captureBackupDocuments(
      "job",
      [{ metadata, text: textFromString("bad\ud800") }],
      output,
      () => false,
    ),
    /cannot be saved as UTF-8/,
  );
  assert.equal(output.completed, null);
});

await check("rejects a mismatched acknowledgement", async () => {
  const output = sink();
  output.append = async () => 0;
  await assert.rejects(
    captureBackupDocuments(
      "job",
      [{ metadata, text: textFromString("text") }],
      output,
      () => false,
    ),
    /not captured completely/,
  );
  assert.equal(output.completed, null);
});

await check("stops before the next document on cancellation", async () => {
  const output = sink();
  await assert.rejects(
    captureBackupDocuments("job", [{ metadata, text: textFromString("text") }], output, () => true),
    /canceled/,
  );
  assert.equal(output.chunks.length, 0);
});

await check("a recovered revision finishes before its inbox entry is cleared", async () => {
  const events = [];
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const ordinary = {
    schedule() {},
    async flush() {},
    async forget() {},
    async flushAll() {},
    dispose() {},
  };
  const api = {
    async begin() {
      events.push("begin");
    },
    async append(_transfer, _sequence, bytes) {
      events.push("append");
      await wait;
      return bytes.length;
    },
    async finish() {
      events.push("finish");
    },
    async cancel() {
      events.push("cancel");
    },
    async forget() {
      events.push("forget");
    },
  };
  const scheduler = createRecoveredScheduler(
    ordinary,
    api,
    () => {},
    () => "safe-id",
  );
  const session = {
    ...metadata,
    id: "session",
    savedContent: "",
    modifiedMs: 0,
    size: 0,
    sha256: null,
  };
  scheduler.attach(session, { inboxId: "inbox", document: { ...metadata, id: "document" } });
  const writing = scheduler.flush(session, "new text");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const clearing = scheduler.forget(session);
  release();
  await Promise.all([writing, clearing]);
  assert.deepEqual(events, ["begin", "append", "finish", "forget"]);
  assert.equal(scheduler.has(session), false);
});

await check("failed recovered revisions keep the inbox item", async () => {
  const notices = [];
  const ordinary = {
    schedule() {},
    async flush() {},
    async forget() {},
    async flushAll() {},
    dispose() {},
  };
  const api = {
    async begin() {},
    async append() {
      throw new Error("disk full");
    },
    async finish() {},
    async cancel() {},
    async forget() {},
  };
  const scheduler = createRecoveredScheduler(
    ordinary,
    api,
    (text) => notices.push(text),
    () => "safe-id",
  );
  const session = {
    ...metadata,
    id: "session",
    savedContent: "",
    modifiedMs: 0,
    size: 0,
    sha256: null,
  };
  scheduler.attach(session, { inboxId: "inbox", document: { ...metadata, id: "document" } });
  await scheduler.flush(session, "new text");
  assert.equal(scheduler.has(session), true);
  assert.match(notices[0], /last verified revision was kept/);
});

if (failures) process.exitCode = 1;
