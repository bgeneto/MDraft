// Build the TeXpresso digest table: what lets MDraft verify any of the 163,011
// bundle files without shipping 163,011 hashes in the executable.
//
//   node scripts/texpresso-digest-table.mjs --mirror <dir> [--out <file>]
//        [--list tt2026/v3.lst]
//
// Input: the mirror's SHA256SUMS and its bundle list. Output: `digests.bin`,
// the first 16 bytes of SHA-256(content) of every file, in the order of the
// list. The position in the list is the key, so the table stores no names.
// Rust (src-tauri/src/latex_texpresso.rs) reads the same list, which is pinned
// by a full SHA-256, and the table itself is pinned by the SHA-256 this prints:
// paste it into "digests" in src-tauri/texpresso.json.
//
// The list format (TeXpresso's ocaml/src/prefetch.ml): the first line is
// `# <bundle> <hash> <suffix>`, an `@folder` line names the folder of the
// names after it, and a name is stored at `files/<folder>/<name><suffix>`.
//
// Reads only. Fails, writing nothing, when a listed file has no SHA256SUMS
// line or SHA256SUMS names a file the list does not.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at < 0 ? fallback : args[at + 1];
};
const mirror = option("--mirror");
if (!mirror) {
  console.error("usage: node scripts/texpresso-digest-table.mjs --mirror <dir> [--out <file>]");
  process.exit(2);
}
const listPath = option("--list", "tt2026/v3.lst");
const out = path.resolve(option("--out", path.join(mirror, "digests.bin")));

/** The `files/…` paths a bundle list names, in its order. */
function listedFiles(text) {
  const lines = text.split("\n");
  const header = /^# \S+ \S+ (\S+)$/.exec(lines[0] ?? "");
  if (!header) throw new Error("The list has no `# <bundle> <hash> <suffix>` first line.");
  const suffix = header[1];
  const files = [];
  let folder = null;
  for (const line of lines.slice(1)) {
    if (line === "") continue;
    if (line.startsWith("@")) folder = line.slice(1);
    else if (folder === null) throw new Error(`"${line}" comes before any @folder line.`);
    else files.push(`files/${folder}/${line}${suffix}`);
  }
  return files;
}

const sums = new Map();
for (const line of readFileSync(path.join(mirror, "SHA256SUMS"), "utf8").split("\n")) {
  if (line === "") continue;
  const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
  if (!match) throw new Error(`Not a SHA256SUMS line: ${line.slice(0, 80)}`);
  sums.set(match[2], match[1]);
}
const list = readFileSync(path.join(mirror, listPath));
const files = listedFiles(list.toString("utf8"));

const table = Buffer.alloc(files.length * 16);
const missing = [];
const seen = new Set();
files.forEach((file, index) => {
  const hex = sums.get(file);
  if (!hex) return missing.push(file);
  if (seen.has(file)) throw new Error(`The list names ${file} twice.`);
  seen.add(file);
  table.write(hex.slice(0, 32), index * 16, "hex");
});
const unlisted = [...sums.keys()].filter((name) => name.startsWith("files/") && !seen.has(name));
if (missing.length || unlisted.length) {
  for (const name of missing.slice(0, 10)) console.error(`no SHA256SUMS line: ${name}`);
  for (const name of unlisted.slice(0, 10)) console.error(`not in the list: ${name}`);
  console.error(
    `FAIL ${missing.length} listed files without a digest, ${unlisted.length} unlisted`,
  );
  process.exit(1);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
writeFileSync(out, table);
console.log(`list     ${listPath}  ${list.length} bytes  sha256 ${sha256(list)}`);
console.log(`entries  ${files.length}`);
console.log(`table    ${out}  ${table.length} bytes  sha256 ${sha256(table)}`);
