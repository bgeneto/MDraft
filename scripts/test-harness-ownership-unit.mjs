//! A test run must never close another run's staged application.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  otherTestHarnesses,
  ownsStagedExecutable,
  suspendTestProfileEngineLink,
} from "./test-harness-ownership.mjs";

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

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mdraft-harness-link-"));
const profile = path.join(scratch, "profile");
const engine = path.join(scratch, "engine");
const link = path.join(profile, "latex");
fs.mkdirSync(profile);
fs.mkdirSync(engine);
assert.doesNotThrow(() => suspendTestProfileEngineLink(profile)());
fs.mkdirSync(link);
suspendTestProfileEngineLink(profile)();
assert.equal(fs.lstatSync(link).isDirectory(), true);
fs.rmdirSync(link);
fs.symlinkSync(engine, link, process.platform === "win32" ? "junction" : "dir");
const restore = suspendTestProfileEngineLink(profile);
assert.equal(!fs.existsSync(link) && fs.existsSync(engine), true);
fs.writeFileSync(link, "collision");
assert.throws(restore, /preserved at/);
fs.unlinkSync(link);
restore();
assert.equal(
  fs.lstatSync(link).isSymbolicLink() && fs.realpathSync(link) === fs.realpathSync(engine),
  true,
);
restore();
assert.deepEqual(fs.readdirSync(scratch).sort(), ["engine", "profile"]);
fs.unlinkSync(link);
fs.rmdirSync(profile);
fs.rmdirSync(engine);
fs.rmdirSync(scratch);
console.log("16/16 checks passed");
