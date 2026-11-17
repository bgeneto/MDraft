// Build the TeXpresso install archives from the pinned files and pin them.
//
//   node scripts/texpresso-archive.mjs --engine <engine release dir> \
//     --data <mirror dir> [--fetch [origin]] [--write]
//
// The install downloads two zip archives instead of a few hundred files, one
// per base of src-tauri/texpresso.json:
//
//   <engine>/install/engine-<sha16>.zip   every pinned engine asset
//   <data>/install/core-<sha16>.zip       the bundle list, digests.bin and the
//                                         format files of both engines
//
// The application checks each archive against its pin, then each member
// against the member's own pin, so the archive only carries bytes that were
// already trusted. This script refuses any input that differs from its pin.
//
// The archives are reproducible: entries sorted by name, one fixed timestamp,
// no extra fields, deflate level 9 (stored when deflate does not help). The
// same pins always give the same bytes and the same archive pin.
//
// --fetch  copy a pinned file that is missing locally from the origin (the one
//          in texpresso.json unless given), verified against its pin. Building
//          from what production already serves needs no local mirror.
// --write  replace "archives" in src-tauri/texpresso.json.
//
// Then upload both `install/` folders with scripts/texpresso-r2-upload.mjs and
// check them with scripts/texpresso-origin-check.mjs.
// No dependencies (Node 24: zlib.crc32).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, crc32, deflateRawSync } from "node:zlib";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};
const flag = (name) => args.includes(name);
const engineDir = option("--engine");
const dataDir = option("--data");
if (!engineDir || !dataDir) {
  console.error(
    "usage: texpresso-archive.mjs --engine <dir> --data <dir> [--fetch [origin]] [--write]",
  );
  process.exit(2);
}

const repo = fileURLToPath(new URL("..", import.meta.url));
const configPath = join(repo, "src-tauri", "texpresso.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const fetchAt = args.indexOf("--fetch");
const fetchOrigin =
  fetchAt < 0
    ? null
    : (args[fetchAt + 1] && !args[fetchAt + 1].startsWith("--")
        ? args[fetchAt + 1]
        : config.origin
      ).replace(/\/*$/, "/");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

/** The pinned bytes of `pin` at `file`, fetched from `url` when allowed. */
async function pinned(pin, file, url) {
  if (!existsSync(file)) {
    if (!fetchOrigin) fail(`${file} is missing (give --fetch to copy it from the origin)`);
    const response = await fetch(url);
    if (!response.ok) fail(`${url}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256)
      fail(`${url} does not match its pin`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  const bytes = readFileSync(file);
  if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256)
    fail(
      `${file} does not match its pin (${bytes.length} bytes, ${sha256(bytes)}; ` +
        `pinned ${pin.bytes} bytes, ${pin.sha256})`,
    );
  return bytes;
}

// 1980-01-01 00:00, the earliest DOS time: no build clock enters the bytes.
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

/** A zip of `entries` ([name, bytes], sorted here), as one Buffer. */
function zip(entries) {
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, bytes] of sorted) {
    const nameBytes = Buffer.from(name, "ascii");
    const deflated = deflateRawSync(bytes, { level: constants.Z_BEST_COMPRESSION });
    const stored = deflated.length >= bytes.length;
    const body = stored ? bytes : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(bytes) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // no extra field
    locals.push(local, nameBytes, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by: MS-DOS, 2.0, so no Unix mode
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    // extra, comment, disk, internal and external attributes stay 0.
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  if (sorted.length > 0xffff || offset > 0xffffffff) fail("the archive would need Zip64");
  return Buffer.concat([...locals, directory, end]);
}

const engineUrl = (path) => `${fetchOrigin}engine/${config.appRelease}/${path}`;
const dataUrl = (path) => `${fetchOrigin}texlive/${config.snapshot}/${path}`;

const engineEntries = [];
for (const pin of config.assets)
  engineEntries.push([
    pin.path,
    await pinned(pin, join(resolve(engineDir), pin.path), engineUrl(pin.path)),
  ]);

const digestsPin = {
  path: config.digests.path,
  bytes: config.digests.bytes,
  sha256: config.digests.sha256,
};
const dataEntries = [];
for (const pin of [config.bundle.list, digestsPin, ...config.bundle.files])
  dataEntries.push([
    pin.path,
    await pinned(pin, join(resolve(dataDir), pin.path), dataUrl(pin.path)),
  ]);

const archives = [];
for (const [base, stem, root, entries] of [
  ["engine", "engine", engineDir, engineEntries],
  ["data", "core", dataDir, dataEntries],
]) {
  const bytes = zip(entries);
  const hash = sha256(bytes);
  const path = `install/${stem}-${hash.slice(0, 16)}.zip`;
  const file = join(resolve(root), path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  const raw = entries.reduce((sum, [, member]) => sum + member.length, 0);
  console.log(
    `${base}: ${entries.length} files, ${(raw / 1e6).toFixed(1)} MB -> ` +
      `${(bytes.length / 1e6).toFixed(1)} MB at ${file}`,
  );
  archives.push({ path, bytes: bytes.length, sha256: hash, base });
}

if (flag("--write")) {
  config.archives = archives;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log("  wrote the archive pins to src-tauri/texpresso.json");
} else console.log(JSON.stringify(archives, null, 2));
