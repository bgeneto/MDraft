//! Refuse a commit whose staged files fail the formatting checks CI runs.
//!   npm run format:staged
//!
//! CI's Quality/Frontend job runs `npm run format:check`; checking at commit time
//! keeps a formatting-only failure from reaching a pull request. Staged Rust
//! files are held to rustfmt so the crate stays `cargo fmt` clean. The staged blobs are
//! checked, not the working tree, so a partially staged file is judged by what
//! the commit will contain.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** The same file set as `format:check` in package.json. */
const PRETTIER_PATHS = [
  /^src\/.+\.(?:ts|js|css)$/,
  /^site\/.+\.(?:html|css|js)$/,
  /^scripts\/.+\.mjs$/,
  /^[^/]+\.(?:json|ts|html)$/,
];
const RUST_PATH = /^src-tauri\/.+\.rs$/;
/** Must match `edition` in src-tauri/Cargo.toml. */
const RUST_EDITION = "2024";

function git(args, input) {
  const result = spawnSync("git", args, {
    cwd: root,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    input,
  });
  if (result.error || result.status !== 0)
    throw new Error(`git ${args[0]} failed: ${result.stderr?.toString().trim() ?? result.error}`);
  return result.stdout;
}

const staged = git(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"])
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const blob = (file) => git(["cat-file", "blob", `:${file}`]).toString("utf8");

const failures = [];
let checked = 0;

for (const file of staged.filter((f) => PRETTIER_PATHS.some((re) => re.test(f)))) {
  const absolute = path.join(root, file);
  const info = await prettier.getFileInfo(absolute, {
    ignorePath: path.join(root, ".prettierignore"),
  });
  if (info.ignored || !info.inferredParser) continue;
  const options = (await prettier.resolveConfig(absolute)) ?? {};
  checked++;
  if (!(await prettier.check(blob(file), { ...options, filepath: absolute })))
    failures.push({ file, fix: `npx prettier --write "${file}"` });
}

const rust = staged.filter((f) => RUST_PATH.test(f));
let rustSkipped = false;
for (const file of rust) {
  // `rustfmt --check` exits 0 on stdin even when it prints a diff, so compare
  // the formatted output with the staged text instead.
  const source = blob(file);
  const result = spawnSync("rustfmt", ["--edition", RUST_EDITION], {
    cwd: root,
    windowsHide: true,
    input: source,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    // A contributor without a Rust toolchain cannot have built this change;
    // CI still checks it, so say so instead of blocking the commit.
    rustSkipped = true;
    break;
  }
  checked++;
  const unix = (text) => text.replace(/\r\n/g, "\n");
  if (result.status !== 0 || unix(result.stdout.toString("utf8")) !== unix(source))
    failures.push({ file, fix: "cargo fmt --manifest-path src-tauri/Cargo.toml" });
}

if (rustSkipped) console.warn("WARN rustfmt not found; staged Rust files were not format-checked");
for (const { file, fix } of failures) console.error(`FAIL format: ${file}\n  fix: ${fix}`);
if (failures.length) {
  console.error("Format the files above, stage them again and commit.");
  process.exit(1);
}
console.log(`PASS format check: ${checked} staged files`);
