#!/usr/bin/env node
// Build the PhiTeX frame's two bundles.
//
//   node scripts/build-phitex-frame.mjs
//
// `main.js` is built from `src-tauri/phitex-shell/main.ts` and the vendored
// viewer. `engine-worker.js` is the pinned frontends worker: set
// PHITEX_WORKER to a built `engine-worker.js`, or PHITEX_FRONTENDS to a
// frontends checkout whose `build/overleaf/dist/engine-worker.js` exists.
// Without either, the committed worker is kept as is (the ordinary app build
// does not need the frontends checkout).
//
// The worker's Shelf hosts are rewritten to the frame's own `/phitex/shelf/`
// origin: the frame policy is `connect-src 'self'`, and Rust fetches and caches
// the packs.

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shell = join(root, "src-tauri", "phitex-shell");
const bundles = join(shell, "bundles");
mkdirSync(bundles, { recursive: true });

// esbuild is not a runtime dependency: the bundles are committed and an
// ordinary build never regenerates them. Prefer a local install; otherwise
// fetch the pinned version through npx, as the README says.
const local = join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "esbuild.cmd" : "esbuild",
);
const esbuild = existsSync(local) ? local : process.platform === "win32" ? "npx.cmd" : "npx";
const esbuildArgs = existsSync(local) ? [] : ["--yes", "esbuild@0.28.2"];

const main = join(bundles, "main.js");
execFileSync(
  esbuild,
  [
    ...esbuildArgs,
    join(shell, "main.ts"),
    "--bundle",
    "--format=iife",
    "--target=es2022",
    "--platform=browser",
    "--outfile=" + main,
    "--log-level=warning",
  ],
  { stdio: "inherit", cwd: root },
);
console.log(`main.js      ${(statSync(main).size / 1024).toFixed(0)} KiB`);

function patchWorker(source) {
  return source
    .split("https://v1.shelf.phitex.org/tl2026/")
    .join("/phitex/shelf/")
    .split("https://shelf-phitex-v1.pages.dev/tl2026/")
    .join("/phitex/shelf/")
    .split("https://v1.shelf.phitex.org/")
    .join("/phitex/shelf/")
    .split("https://shelf-phitex-v1.pages.dev/")
    .join("/phitex/shelf/");
}

const candidates = [
  process.env.PHITEX_WORKER,
  process.env.PHITEX_FRONTENDS &&
    join(process.env.PHITEX_FRONTENDS, "build", "overleaf", "dist", "engine-worker.js"),
].filter(Boolean);
const source = candidates.find((path) => existsSync(path));
if (source) {
  const worker = join(bundles, "engine-worker.js");
  const text = patchWorker(readFileSync(source, "utf8"));
  if (/shelf\.phitex|pages\.dev/.test(text)) {
    console.error("the worker still names a remote Shelf host");
    process.exit(1);
  }
  writeFileSync(worker, text);
  console.log(`engine-worker.js ${(statSync(worker).size / 1024).toFixed(0)} KiB (from ${source})`);
} else {
  const worker = join(bundles, "engine-worker.js");
  if (!existsSync(worker)) {
    console.error(
      "no engine-worker.js: set PHITEX_WORKER or PHITEX_FRONTENDS, or restore the committed bundle",
    );
    process.exit(1);
  }
  console.log(`engine-worker.js ${(statSync(worker).size / 1024).toFixed(0)} KiB (committed)`);
}
