//! Install the checked-in publication hooks without overwriting a custom setup.
//!   npm run security:hooks
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const current = spawnSync("git", ["config", "--get", "core.hooksPath"], {
  cwd: root,
  windowsHide: true,
  encoding: "utf8",
});
if (current.error || ![0, 1].includes(current.status))
  throw new Error("Cannot read the existing hook configuration");
if (current.stdout.trim() && current.stdout.trim() !== ".githooks")
  throw new Error(
    "A custom core.hooksPath is already configured; integrate the publication checks there",
  );
for (const name of ["pre-commit", "pre-push"]) {
  const hook = path.join(root, ".githooks", name);
  if (!existsSync(hook)) throw new Error(`Missing checked-in ${name} hook`);
  if (process.platform !== "win32") chmodSync(hook, 0o755);
}
const result = spawnSync("git", ["config", "--local", "core.hooksPath", ".githooks"], {
  cwd: root,
  windowsHide: true,
});
if (result.error || result.status !== 0)
  throw new Error("Cannot install repository publication hooks");
console.log(
  "PASS repository hooks installed; commit scans the index, push scans every outgoing ref and its history",
);
