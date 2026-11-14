// Prove that an origin serves exactly the bytes src-tauri/texpresso.json pins.
//
//   node scripts/texpresso-origin-check.mjs [origin] [--all] [--sample <n>]
//        [--concurrency <n>]
//
// `origin` defaults to the one in texpresso.json. Run it against the local
// origin server while developing, and against the bucket before the origin
// string is switched: the application refuses any byte that differs, so a
// bucket that fails here is a preview that cannot start.
//
// Checked: every engine file, the list and the four format and metadata
// files (full SHA-256 and size), the digest table (full SHA-256), and bundle
// files against the table. Without --all that is an evenly spread sample
// (500 unless --sample says otherwise) plus every name that differs from
// another only by case, which is what a case-insensitive disk gets wrong.
// --all fetches all 163,011 files (3.8 GB).
//
// Reads only. One PASS or FAIL line per check, non-zero exit on any FAIL.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at < 0 ? fallback : args[at + 1];
};
const valued = new Set(["--sample", "--concurrency"]);
const positional = args.filter((arg, i) => !arg.startsWith("--") && !valued.has(args[i - 1]));

const config = JSON.parse(
  readFileSync(new URL("../src-tauri/texpresso.json", import.meta.url), "utf8"),
);
const origin = (positional[0] ?? config.origin).replace(/\/*$/, "/");
const all = flag("--all");
const sample = Number(option("--sample", 500));
const concurrency = Number(option("--concurrency", 32));
const engine = `${origin}engine/${config.appRelease}/`;
const data = `${origin}texlive/${config.snapshot}/`;

let failed = 0;
const check = (ok, name, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest();

async function get(url) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "error" });
      if (!response.ok) return { status: response.status };
      return {
        status: 200,
        bytes: Buffer.from(await response.arrayBuffer()),
        type: response.headers.get("content-type"),
        cache: response.headers.get("cache-control"),
      };
    } catch (error) {
      // A dropped connection is retried; a wrong byte never is.
      if (attempt === 3) return { status: 0, error: String(error.cause ?? error) };
      await new Promise((wake) => setTimeout(wake, 300 * attempt));
    }
  }
}

/** Fetch `url` and compare it with a full pin. Returns the bytes when they match. */
async function pinned(url, pin, label) {
  const got = await get(url);
  if (got.status !== 200) {
    check(false, label, `HTTP ${got.status}${got.error ? ` ${got.error}` : ""}`);
    return null;
  }
  const hex = sha256(got.bytes).toString("hex");
  const ok = got.bytes.length === pin.bytes && hex === pin.sha256;
  check(ok, label, ok ? `${pin.bytes} bytes` : `got ${got.bytes.length} bytes, sha256 ${hex}`);
  return ok ? got : null;
}

console.log(`origin   ${origin}`);
console.log(`engine   ${config.appRelease}`);
console.log(`snapshot ${config.snapshot}`);

const headers = [];
for (const asset of config.assets) {
  const got = await pinned(engine + asset.path, asset, `engine ${asset.path}`);
  if (got) headers.push([asset.path, got]);
}
const list = await pinned(
  data + config.bundle.list.path,
  config.bundle.list,
  `bundle ${config.bundle.list.path}`,
);
for (const file of config.bundle.files) {
  const got = await pinned(data + file.path, file, `bundle ${file.path}`);
  if (got) headers.push([file.path, got]);
}
const table = await pinned(
  data + config.digests.path,
  config.digests,
  `digest table ${config.digests.path}`,
);

// What the bucket should say about itself. A wrong type on a .wasm stops
// streaming compilation; the rest is advice, because Rust re-serves the bytes
// with its own headers.
const wanted = { ".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript" };
for (const [name, got] of headers) {
  const extension = /\.[a-z]+$/.exec(name)?.[0];
  const type = wanted[extension];
  if (type && !(got.type ?? "").startsWith(type))
    console.log(`NOTE ${name}: Content-Type is ${got.type}, expected ${type}`);
  if (!/immutable/.test(got.cache ?? ""))
    console.log(`NOTE ${name}: Cache-Control is ${got.cache ?? "absent"}, expected immutable`);
}

if (list && table) {
  // The list format is described in scripts/texpresso-digest-table.mjs.
  const lines = list.bytes.toString("utf8").split("\n");
  const suffix = /^# \S+ \S+ (\S+)$/.exec(lines[0])?.[1];
  const files = [];
  let folder = null;
  for (const line of lines.slice(1)) {
    if (line === "") continue;
    if (line.startsWith("@")) folder = line.slice(1);
    else files.push(`files/${folder}/${line}${suffix}`);
  }
  check(
    suffix !== undefined && files.length === config.digests.entries,
    "the list names as many files as the table has entries",
    `${files.length} against ${config.digests.entries}`,
  );

  let chosen;
  if (all) chosen = files.map((_, index) => index);
  else {
    const picked = new Set();
    const step = Math.max(1, Math.floor(files.length / Math.max(1, sample)));
    for (let index = 0; index < files.length; index += step) picked.add(index);
    const byLower = new Map();
    files.forEach((file, index) => {
      const key = file.toLowerCase();
      byLower.set(key, [...(byLower.get(key) ?? []), index]);
    });
    let collisions = 0;
    for (const group of byLower.values())
      if (group.length > 1) {
        collisions += group.length;
        for (const index of group) picked.add(index);
      }
    console.log(`INFO ${collisions} names differ from another only by case`);
    chosen = [...picked].sort((a, b) => a - b);
  }

  const bad = [];
  let done = 0;
  let total = 0;
  let next = 0;
  const started = Date.now();
  const worker = async () => {
    while (next < chosen.length) {
      const index = chosen[next];
      next += 1;
      const got = await get(data + files[index]);
      if (got.status !== 200)
        bad.push(`${files[index]}: HTTP ${got.status}${got.error ? ` ${got.error}` : ""}`);
      else if (
        !sha256(got.bytes)
          .subarray(0, 16)
          .equals(table.bytes.subarray(index * 16, index * 16 + 16))
      )
        bad.push(`${files[index]}: digest differs from the table`);
      else total += got.bytes.length;
      done += 1;
      if (done % 10000 === 0) console.log(`INFO ${done}/${chosen.length} files, ${bad.length} bad`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  for (const line of bad.slice(0, 20)) console.log(`  ${line}`);
  check(
    bad.length === 0,
    all
      ? "every bundle file matches the digest table"
      : "the sampled bundle files match the digest table",
    `${chosen.length - bad.length}/${chosen.length} files, ${(total / 1048576).toFixed(1)} MB, ${Math.round((Date.now() - started) / 1000)} s`,
  );

  // The origin must not answer a name it does not hold with a neighbour's bytes.
  const probe = files[0].replace(/[A-Za-z]/, (letter) =>
    letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase(),
  );
  if (!files.includes(probe)) {
    const got = await get(data + probe);
    check(
      got.status === 404,
      "a name in the wrong case is not found",
      `HTTP ${got.status} for ${probe}`,
    );
  }
}

console.log(failed ? `FAIL ${failed} check(s) failed` : "PASS the origin serves the pinned bytes");
process.exit(failed ? 1 : 0);
