// Add pdf.js to a TeXpresso engine folder and pin it.
//
//   node scripts/texpresso-pdfjs-assets.mjs <engine release dir> [--write]
//
// The preview's renderer draws a PDF image with pdf.js, loaded from
// `vendor/pdfjs/` next to `ocaml.js`: `pdf.min.mjs`, the worker it names, and the
// `cmaps/`, `standard_fonts/`, `wasm/` and `iccs/` data it passes to
// `getDocument`. The release ships only `pdf.min.mjs`. That file is pdf.js
// 6.4.299, byte for byte the build in `pdfjs-dist` 6.4.299, so the worker and
// the data come from that package: a different version would pair one pdf.js
// API with another worker.
//
// The script refuses unless `node_modules/pdfjs-dist` is that version and its
// `pdf.min.mjs` equals the release's. It copies the files into
// `<dir>/vendor/pdfjs/` and prints their pins; `--write` replaces the
// `vendor/pdfjs/` pins in src-tauri/texpresso.json. Then upload the folder with
// scripts/texpresso-r2-upload.mjs.

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "6.4.299";
// Scripting (quickjs) is never enabled by the renderer, and the sandbox and
// source maps are not loaded by it.
const DATA = ["cmaps", "standard_fonts", "wasm", "iccs"];
const SKIP = /^quickjs-eval\./;

const [engine, flag] = process.argv.slice(2);
if (!engine || (flag && flag !== "--write")) {
  console.error("usage: texpresso-pdfjs-assets.mjs <engine release dir> [--write]");
  process.exit(2);
}

const repo = fileURLToPath(new URL("..", import.meta.url));
const dist = join(repo, "node_modules", "pdfjs-dist");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

const version = JSON.parse(readFileSync(join(dist, "package.json"), "utf8")).version;
if (version !== VERSION) fail(`node_modules/pdfjs-dist is ${version}, not ${VERSION}`);
const target = join(engine, "vendor", "pdfjs");
const released = join(target, "pdf.min.mjs");
if (!existsSync(released)) fail(`${released} is missing; is this the release folder?`);
if (sha256(readFileSync(released)) !== sha256(readFileSync(join(dist, "build", "pdf.min.mjs"))))
  fail("the release's pdf.min.mjs is not pdfjs-dist's build; find the matching pdf.js version");

const files = [["build/pdf.worker.min.mjs", "pdf.worker.min.mjs"]];
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
for (const folder of DATA)
  for (const file of walk(join(dist, folder))) {
    const name = relative(dist, file).replaceAll("\\", "/");
    if (!SKIP.test(name.split("/").pop())) files.push([name, name]);
  }

for (const [from, to] of files) {
  mkdirSync(dirname(join(target, to)), { recursive: true });
  copyFileSync(join(dist, from), join(target, to));
}
const pins = ["pdf.min.mjs", ...files.map(([, to]) => to).sort()].map((name) => {
  const bytes = readFileSync(join(target, name));
  return { path: `vendor/pdfjs/${name}`, bytes: bytes.length, sha256: sha256(bytes) };
});
const total = pins.reduce((sum, pin) => sum + pin.bytes, 0);
console.log(
  `pdf.js ${VERSION}: ${pins.length} files, ${(total / 1048576).toFixed(1)} MiB in ${target}`,
);

if (flag === "--write") {
  const path = join(repo, "src-tauri", "texpresso.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.assets = [
    ...config.assets.filter((asset) => !asset.path.startsWith("vendor/pdfjs/")),
    ...pins,
  ];
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`  wrote ${pins.length} pins to src-tauri/texpresso.json`);
} else console.log(JSON.stringify(pins, null, 2));
