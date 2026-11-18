// Patch TeXpresso's ocaml-worker.js so the preview finds project files on
// demand and local TEXMF libraries.
//
//   node scripts/texpresso-patch-worker.mjs <upstream ocaml-worker.js> <output>
//   node scripts/texpresso-patch-worker.mjs <upstream ocaml-worker.js> --check
//
// The upstream worker resolves every file the engine opens by name: the
// project's files, then the TeX Live bundle. Since release 0.2 it also asks
// `globalThis.texpresso_project_file(names)` for a name the project misses,
// and keeps what it answers in the project table; MDraft's worker.js answers
// from the project manifest, so on-demand project files need no edit of their
// own. These edits add what the hook does not cover:
//   - a name the current manifest holds is always offered to the hook, even
//     after an earlier miss (upstream remembers misses until the name is put);
//   - the local TEXMF libraries, after the project and the manifest and before
//     the bundle, in TeX's order, reporting a library file that replaces a
//     TeX Live one;
//   - the manifest, then the libraries, in the case-insensitive lookup;
//   - the export's xdvipdfmx, which shares the lookup but never asks for the
//     case-insensitive one, gets the engine's case-insensitive answer after an
//     exact miss everywhere.
//
// The input must be the release's upstream file, byte for byte; each edit must
// match exactly once; the result must parse. `--check` writes nothing and
// compares the result with the pin in src-tauri/texpresso.json, which is what
// the application verifies before it runs the file. The patched file is what
// the origin serves; see docs/architecture.md for publishing it.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM = {
  release: "release-0.2-13-g6a91b6a",
  bytes: 234715,
  sha256: "f30c189f6e88e951605eb2920b1a146e5aa02f83c0087df1a397140574c88630",
};

// Names inside the host table builder `ak2(u2,l10,c11)`: `c11` the session (0
// for the export's xdvipdfmx), `l10` the bundle index (`l10[1]` its table),
// `h10` the project probe, `d11` the pending bytes, `bs` the project table,
// `M2` the bundle files already loaded, `hD` the names the hook already
// missed; `cS`/`ah` table find, `ar` table member, `k` the `Some` tag, `bU` a
// hit by candidate index, `o`/`n` a JS string to and from an OCaml one. The
// `md*` locals avoid every name the surrounding minified code uses.
const EDITS = [
  {
    what: "the project hook: a name the manifest holds is always asked",
    from: "var g10=bD(function(a13){return 1-ar(hD,a13)},e0(c12)),a11=qF(0);",
    to:
      "var g10=bD(function(a13){var mdH=globalThis.__mdraftProjectHas;" +
      "return 1-ar(hD,a13)||(mdH&&mdH(n(a13))?1:0)},e0(c12)),a11=qF(0);",
  },
  {
    what: "exact lookup: the libraries after the project and manifest, before the bundle",
    from: "function e11(a13){for(a13=0;;){if(a13===f11)a13=0;else{var b12=ah(M2,",
    to: "function e11(a13){var mdV=mdLib(c12,f11);if(mdV)return mdV;for(a13=0;;){if(a13===f11)a13=0;else{var b12=ah(M2,",
  },
  {
    // `mdLib` answers a library file from the project table, where MDraft
    // stores it under `.mdraft-texmf/`. `mdQ` is true when no candidate name
    // matches exactly anywhere: project table, manifest, library index,
    // loaded bundle, or bundle index. Only then does the export take the
    // case-insensitive answer (`mdNC`, the record's second function), so an
    // exact match still wins, as it does for TeX. TeX's own lookups have a
    // session and are unchanged.
    what: "the export's lookup: the engine's case-insensitive fallback",
    from: "return[481420544,function(a11,b11){d11[1]=0;var c12=ac2(a11,b11),f11=c12.length-1;",
    to:
      "function mdLib(mdC,mdF){var mdG=globalThis.__mdraftTexmfLookup;if(!mdG)return 0;" +
      "for(var mdI=0;mdI<mdF;mdI++){var mdN=mdC[mdI+1],mdP=mdG(n(mdN));if(!mdP)continue;" +
      "var mdH=cS(bs,o(mdP));if(!mdH)continue;" +
      "if(l10&&ar(l10[1],mdN)&&globalThis.__mdraftTexmfOverride)globalThis.__mdraftTexmfOverride(n(mdN));" +
      "d11[1]=[k,mdH[1]];return[bU,mdI]}return 0}" +
      "function mdQ(mdC){var mdQh=globalThis.__mdraftProjectHas,mdQt=globalThis.__mdraftTexmfLookup;" +
      "for(var mdI=1;mdI<mdC.length;mdI++){var mdN=mdC[mdI],mdS=n(mdN);" +
      "if(h10(mdN)||mdQh&&mdQh(mdS)||mdQt&&mdQt(mdS)||ah(M2,mdN)||l10&&ar(l10[1],mdN))return 0}return 1}" +
      "var mdNC;" +
      "return[481420544,function(a11,b11){" +
      "if(!c11&&mdNC&&mdQ(ac2(a11,b11))){var mdS=mdNC(a11,b11);if(mdS){a11=mdS[1];b11=[0]}}" +
      "d11[1]=0;var c12=ac2(a11,b11),f11=c12.length-1;",
  },
  {
    what: "the case-insensitive lookup, named for the export's fallback",
    from: "},function(a11,b11){a11=eZ(X2,ac2(a11,b11)),b11=ag(ad,16);",
    to: "},mdNC=function(a11,b11){a11=eZ(X2,ac2(a11,b11)),b11=ag(ad,16);",
  },
  {
    what: "case-insensitive lookup: project, then manifest, then libraries",
    from: "if(c12)return[k,c12[1]];if(c12=af2[1],c12)",
    to:
      "if(!c12){var mdJ=globalThis.__mdraftProjectHasNocase;" +
      "if(mdJ)for(var mdI=1;mdI<a11.length;mdI++){var mdN=mdJ(n(a11[mdI]));if(mdN){c12=[k,o(mdN)];break}}}" +
      "if(!c12){var mdL=globalThis.__mdraftTexmfLookupNocase;" +
      "if(mdL)for(var mdI=1;mdI<a11.length;mdI++){var mdN=mdL(n(a11[mdI]));if(mdN){c12=[k,o(mdN)];break}}}" +
      "if(c12)return[k,c12[1]];if(c12=af2[1],c12)",
  },
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const [input, target] = process.argv.slice(2);
if (!input || !target) {
  console.error("usage: texpresso-patch-worker.mjs <upstream ocaml-worker.js> <output|--check>");
  process.exit(2);
}

const upstream = readFileSync(input);
if (upstream.length !== UPSTREAM.bytes || sha256(upstream) !== UPSTREAM.sha256) {
  console.error(`FAIL: ${input} is not ${UPSTREAM.release}'s upstream ocaml-worker.js`);
  process.exit(1);
}

let text = upstream.toString("utf8");
for (const edit of EDITS) {
  const count = text.split(edit.from).length - 1;
  if (count !== 1) {
    console.error(`FAIL: ${edit.what}: the anchor matches ${count} times, not once`);
    process.exit(1);
  }
  text = text.replace(edit.from, () => edit.to);
}
const patched = Buffer.from(text, "utf8");
// The worker is an ES module (it reads import.meta), so Node checks it as one.
const scratch = mkdtempSync(join(tmpdir(), "mdraft-texpresso-"));
try {
  const probe = join(scratch, "ocaml-worker.mjs");
  writeFileSync(probe, patched);
  const parsed = spawnSync(process.execPath, ["--check", probe], { encoding: "utf8" });
  if (parsed.status !== 0) {
    console.error(`FAIL: the patched worker does not parse: ${parsed.stderr.trim()}`);
    process.exit(1);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const result = { bytes: patched.length, sha256: sha256(patched) };
console.log(`patched ocaml-worker.js: ${result.bytes} bytes, sha256 ${result.sha256}`);
// The application verifies the pin before it runs the file; a local change that
// was not re-pinned would otherwise only fail at the first preview.
if (target === "--check") {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const pins = JSON.parse(readFileSync(join(repo, "src-tauri", "texpresso.json"), "utf8"));
  const pin = pins.assets.find((asset) => asset.path === "ocaml-worker.js");
  const ok = pin && pin.bytes === result.bytes && pin.sha256 === result.sha256;
  console.log(`  ${ok ? "PASS" : "FAIL"}  src-tauri/texpresso.json pins the patched worker`);
  process.exit(ok ? 0 : 1);
}
writeFileSync(target, patched);
