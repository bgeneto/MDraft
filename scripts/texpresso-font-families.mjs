// Build src/texpresso/font-families.json from the pinned TeX Live snapshot.
//
//   node scripts/texpresso-font-families.mjs [--from <origin-url|data-dir>]... [--check]
//
// The XeLaTeX preview has no system font index (the engine is built without
// fontconfig), so `\setmainfont{Latin Modern Roman}` cannot be found there,
// while LuaLaTeX finds the same name through the luaotfload names database the
// preview ships. This script reads that database out of the pinned
// `.luatex-cache` archive and writes, for each TeX Live family, the files
// luaotfload would pick for its regular, bold, italic and bold italic styles
// at 10 pt. src/texpresso/fontspec-families.ts turns an entry into the
// `<Family>.fontspec` file fontspec reads before it looks a name up.
//
// `--from` may repeat. An http(s) value is an origin (data under
// `texlive/<snapshot>/`); anything else is a local directory laid out like the
// data root (`tt2026/v4.lst`). Each pinned file comes from the first source
// that has it and must match its SHA-256 in src-tauri/texpresso.json. Without
// `--from` the pinned origin is used (about 20 MB).
//
// `--check` regenerates in memory and fails if the committed table differs.
// The table records the pins it was built from, and scripts/texpresso-unit.mjs
// fails when they no longer match texpresso.json, so a snapshot bump cannot
// ship a stale table.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const args = process.argv.slice(2);
const check = args.includes("--check");
const sources = args.flatMap((arg, i) => (args[i - 1] === "--from" ? [arg] : []));

const config = JSON.parse(
  readFileSync(new URL("../src-tauri/texpresso.json", import.meta.url), "utf8"),
);
const output = new URL("../src/texpresso/font-families.json", import.meta.url);
if (!sources.length) sources.push(config.origin);

/** luaotfload's `format_precedence` without the Type 1 formats XeTeX's fontspec cannot load. */
const FORMATS = ["otf", "ttc", "ttf"];
const STYLES = ["r", "b", "i", "bi"];
/** The size every style is picked at: 10 pt in scaled points, as TeX asks. */
const ASKED = 10 * 65536;
const NAMES_MEMBER = "luatex-cache/luatex-cache/generic/names/luaotfload-names.lua.gz";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function pinned(pin) {
  for (const source of sources) {
    let bytes = null;
    if (/^https?:\/\//i.test(source)) {
      const url = `${source.replace(/\/*$/, "/")}texlive/${config.snapshot}/${pin.path}`;
      const response = await fetch(url, { redirect: "error" });
      if (response.ok) bytes = Buffer.from(await response.arrayBuffer());
    } else if (existsSync(join(source, pin.path))) {
      bytes = readFileSync(join(source, pin.path));
    }
    if (!bytes) continue;
    if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256) {
      throw new Error(`${pin.path} from ${source} does not match its pin`);
    }
    return bytes;
  }
  throw new Error(`${pin.path} is in none of: ${sources.join(", ")}`);
}

/** One member of a POSIX tar archive. */
function tarMember(archive, wanted) {
  for (let at = 0; at + 512 <= archive.length;) {
    const header = archive.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString("latin1")
        .replace(/\0.*$/s, "");
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = parseInt(field(124, 12).trim() || "0", 8);
    if (name.replace(/^\.\//, "") === wanted) return archive.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${wanted} is not in the luatex cache`);
}

/**
 * Parse the Lua table literal luaotfload writes (`return { ... }`): strings,
 * numbers (including hexadecimal floats), booleans, and keyed or positional
 * fields. Positional fields become arrays.
 */
function parseLua(text) {
  let at = text.indexOf("{");
  const fail = (what) => {
    throw new Error(`names database: ${what} at offset ${at}`);
  };
  const space = () => {
    while (at < text.length && /\s/.test(text[at])) at += 1;
  };
  const string = () => {
    const quote = text[at++];
    let out = "";
    while (text[at] !== quote) {
      if (at >= text.length) fail("unterminated string");
      if (text[at] !== "\\") {
        out += text[at++];
        continue;
      }
      at += 1;
      const escape = text[at];
      if (/\d/.test(escape)) {
        const digits = /^\d{1,3}/.exec(text.slice(at))[0];
        out += String.fromCharCode(Number(digits));
        at += digits.length;
      } else {
        out += { n: "\n", t: "\t", r: "\r" }[escape] ?? escape;
        at += 1;
      }
    }
    at += 1;
    return out;
  };
  const value = () => {
    space();
    const char = text[at];
    if (char === "{") return table();
    if (char === '"' || char === "'") return string();
    const word = /^[-+0-9a-zA-Z_.]+/.exec(text.slice(at, at + 64));
    if (!word) fail("unexpected character");
    at += word[0].length;
    if (word[0] === "true") return true;
    if (word[0] === "false") return false;
    if (word[0] === "nil") return null;
    const number = Number(word[0]);
    if (!Number.isNaN(number)) return number;
    // Hexadecimal floats such as -0x1.6p+3 (italic angles); nothing here reads them.
    if (/^-?0x[0-9a-f.]+p[-+]?\d+$/i.test(word[0])) return 0;
    return fail(`unexpected word ${word[0]}`);
  };
  const table = () => {
    at += 1;
    const keyed = {};
    const list = [];
    for (;;) {
      space();
      if (text[at] === "}") {
        at += 1;
        break;
      }
      if (text[at] === "[") {
        at += 1;
        space();
        const key = text[at] === '"' ? string() : value();
        space();
        if (text[at] !== "]") fail("expected ]");
        at += 1;
        space();
        if (text[at] !== "=") fail("expected =");
        at += 1;
        keyed[key] = value();
      } else {
        list.push(value());
      }
      space();
      if (text[at] === "," || text[at] === ";") at += 1;
    }
    return list.length && !Object.keys(keyed).length ? list : Object.assign(list, keyed);
  };
  return value();
}

/**
 * luaotfload's `choose_size`: an exact design size, else the closest design
 * size whose range holds the asked size, else the closest range, else the
 * entry without size information.
 */
function chooseSize(sizes) {
  const inRange = [];
  const outside = [];
  for (const entry of Array.isArray(sizes) ? sizes : []) {
    const [design, high, low, index] = entry;
    if (design === ASKED) return index;
    if (ASKED <= low) outside.push([low - ASKED, index]);
    else if (ASKED > high) outside.push([ASKED - high, index]);
    else {
      const middle = design > low && design < high ? design : (low + high) / 2;
      inRange.push([Math.abs(middle - ASKED), index]);
    }
  }
  const closest = (list) => list.reduce((best, item) => (item[0] < best[0] ? item : best))[1];
  if (inRange.length) return closest(inRange);
  if (outside.length) return closest(outside);
  return sizes.default ?? null;
}

const listPin = config.bundle.list;
const cachePin = config.bundle.files.find((file) => file.path.endsWith(".luatex-cache"));
if (!cachePin) throw new Error("texpresso.json pins no .luatex-cache file");

const list = (await pinned(listPin)).toString("utf8");
const names = parseLua(
  gunzipSync(tarMember(await pinned(cachePin), NAMES_MEMBER)).toString("latin1"),
);

// TeX Live's own `<Name>.fontspec` files win: they can carry features (small
// caps, ligatures) a generated file would drop.
const shipped = [
  ...new Set(
    list
      .split("\n")
      .map((line) => line.trim().replace(/^=/, ""))
      .filter((line) => line.endsWith(".fontspec"))
      .map((line) => line.slice(0, -".fontspec".length)),
  ),
].sort();

const families = {};
const texmf = names.families.texmf;
const keys = new Set(FORMATS.flatMap((format) => Object.keys(texmf[format] ?? {})));
for (const key of [...keys].sort()) {
  if (!/^[a-z0-9]+$/.test(key)) continue;
  const styles = STYLES.map((style) => {
    // luaotfload's `lookup_familyname`: the first format that has the style.
    for (const format of FORMATS) {
      const sizes = texmf[format]?.[key]?.[style];
      if (!sizes) continue;
      const index = chooseSize(sizes);
      const mapping = index === null ? undefined : names.mappings[index - 1];
      if (!mapping) return null;
      // A collection member needs a font index fontspec's Extension form
      // cannot express; the first member of a collection is the file itself.
      if (mapping.subfont !== false && mapping.subfont !== 0) return null;
      return mapping.basename;
    }
    return null;
  });
  const extension = /\.[^.]+$/.exec(styles[0] ?? "")?.[0];
  if (!extension) continue;
  // One `Extension` covers every style, so a style in another format is left
  // to fontspec's usual fallback rather than loaded under the wrong name.
  families[key] = styles.map((file) => (file?.endsWith(extension) ? file : null));
}

const table = {
  note: "Generated by scripts/texpresso-font-families.mjs from the pinned TeX Live snapshot; do not edit. Each family lists its regular, bold, italic and bold italic files at 10 pt.",
  snapshot: config.snapshot,
  sources: { [listPin.path]: listPin.sha256, [cachePin.path]: cachePin.sha256 },
  shipped,
  families,
};
const text = `${JSON.stringify(table, null, 0)
  .replace(/^\{/, "{\n")
  .replace(/,"(snapshot|sources|shipped|families)":/g, ',\n"$1":')
  .replace(/\]\}$/, "]\n}")
  .replace(/\],"/g, '],\n"')}\n`;

if (check) {
  const current = existsSync(output) ? readFileSync(output, "utf8") : "";
  const ok = current === text;
  console.log(`${ok ? "PASS" : "FAIL"} font-families.json matches the pinned snapshot`);
  process.exit(ok ? 0 : 1);
}
writeFileSync(output, text);
console.log(
  `wrote ${Object.keys(families).length} families, ${shipped.length} TeX Live .fontspec names, ${text.length} bytes`,
);
