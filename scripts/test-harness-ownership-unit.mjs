//! A test run must never close another run's staged application.
import assert from "node:assert/strict";
import { otherTestHarnesses, ownsStagedExecutable } from "./test-harness-ownership.mjs";

const own = String.raw`C:\Temp\mdraft-test-abc\mdraft.exe`;
assert.equal(ownsStagedExecutable(own, own, "win32"), true);
assert.equal(ownsStagedExecutable("c:/TEMP/mdraft-test-abc/MDRAFT.EXE", own, "win32"), true);
assert.equal(
  ownsStagedExecutable(String.raw`C:\Temp\mdraft-test-other\mdraft.exe`, own, "win32"),
  false,
);
assert.equal(
  ownsStagedExecutable(String.raw`C:\Program Files\MDraft\mdraft.exe`, own, "win32"),
  false,
);
assert.equal(ownsStagedExecutable(`${own}.backup`, own, "win32"), false);
assert.equal(ownsStagedExecutable("", own, "win32"), false);
assert.equal(ownsStagedExecutable(own, undefined, "win32"), false);
assert.equal(
  ownsStagedExecutable(
    "/tmp/mdraft-test-a/mdraft /tmp/input.md",
    "/tmp/mdraft-test-a/mdraft",
    "linux",
  ),
  true,
);
assert.equal(
  ownsStagedExecutable("/tmp/mdraft-test-a/mdraft-other", "/tmp/mdraft-test-a/mdraft", "linux"),
  false,
);
const processes = [
  { pid: 1, command: "node scripts/test-all.mjs --only rust" },
  { pid: 2, command: 'node "C:\\work tree\\scripts\\test-all.mjs"' },
  { pid: 3, command: "node scripts/not-test-all.mjs" },
  { pid: 4, command: "node scripts/test-all.mjs.extra" },
];
assert.deepEqual(
  otherTestHarnesses(processes, 1).map(({ pid }) => pid),
  [2],
);
console.log("10/10 checks passed");
