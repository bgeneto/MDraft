// Patch TeXpresso's ocaml-worker.js so the preview finds project files on
// demand and local TEXMF libraries.
//
//   node scripts/texpresso-patch-worker.mjs <upstream ocaml-worker.js> <output>
//   node scripts/texpresso-patch-worker.mjs <upstream ocaml-worker.js> --check
//
// The upstream worker resolves every file the engine opens by name: the
// project's files, then the TeX Live bundle. It has no search path. These edits
// insert, in TeX's order, the project manifest (worker.js) and MDraft's library
// index between the project table and the bundle, in both lookups. A manifest
// hit is fetched through the frame's capability and inserted into the project
// table, so later lookups answer synchronously and the main-thread renderer
// receives the bytes through the bridge.
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
  release: "release-0-133-g454f1bc",
  bytes: 210530,
  sha256: "b15bee9aaba43a4199ded3d15dd88e7a5f447970389b9ae57f7c1a506582c081",
};

// Names: `i10` is the lookup's project probe inside the host object; `cA`/`bz`
// the project table; `mdT` the TEXMF probe; `as`/`at` hashtable find/member;
// `n`/`m` JS string to and from an OCaml string; `j` the `Some` tag; `f10` the
// pending bytes; `pt` the "not found" answer; `b4` the project-class index.
// The `md*` locals avoid every name the surrounding minified code uses.
const PROBE =
  "function i10(a11){if(!c11)return cA(bz,a11);var b11=as(c11[1][11],a11);return b11?[j,b11[1]]:cA(bz,a11)}";

const EDITS = [
  {
    what: "exact lookup: project, then manifest, then library",
    from: PROBE,
    to:
      "function md10(mdN,mdI){return gz(pd({fut:globalThis.__mdraftProjectFetch(m(mdN)).then(function(mdB){if(!mdB)return 0;eP(bz,mdN,mdB);return[j,mdB]})}),function(a11){return a11?(f10[1]=[j,a11[1]],[b4,mdI]):pt})}" +
      "function mdT(a11){var mdG=globalThis.__mdraftTexmfLookup,mdP=mdG&&mdG(m(a11));if(!mdP)return 0;" +
      "var mdH=cA(bz,n(mdP));" +
      "if(mdH&&l10&&at(l10[1],a11)&&globalThis.__mdraftTexmfOverride)globalThis.__mdraftTexmfOverride(m(a11));" +
      "return mdH}" +
      "function i10(a11){return i10o(a11)}" +
      PROBE.replace("function i10(", "function i10o("),
  },
  {
    what: "the async lookup: manifest before the library and the bundle",
    from: "if(c12)a11=c12[1];else for(c12=0;;){if(c12===b11)b11=0;else{if(d11=as(B2,r(a11,c12)[c12+1]),!d11){c12=c12+1|0;continue}f10[1]=[j,d11[1]],b11=[j,[b4,b11+c12|0]]}if(b11){a11=b11[1];break}a11=k10(a11,0);break}",
    to:
      "if(c12)a11=c12[1];else{" +
      "var mdH=globalThis.__mdraftProjectHas;" +
      "if(mdH)for(var mdI=0;mdI<b11;mdI++){var mdN=r(a11,mdI)[mdI+1];if(mdH(m(mdN)))return j0(md10(mdN,mdI))}" +
      "for(var mdJ=0;mdJ<b11;mdJ++){var mdTv=mdT(r(a11,mdJ)[mdJ+1]);if(mdTv){f10[1]=[j,mdTv[1]];return j0([b4,mdJ])}}" +
      "for(c12=0;;){if(c12===b11)b11=0;else{if(d11=as(B2,r(a11,c12)[c12+1]),!d11){c12=c12+1|0;continue}f10[1]=[j,d11[1]],b11=[j,[b4,b11+c12|0]]}if(b11){a11=b11[1];break}a11=k10(a11,0);break}}",
  },
  {
    what: "case-insensitive lookup: project, then manifest, then library",
    from: "if(c12)b11=[j,c12[1]];else{if(c12=ar2[1],c12)",
    to:
      "if(!c12){var mdJ=globalThis.__mdraftProjectHasNocase;" +
      "if(mdJ)for(var mdI=1;mdI<b11.length;mdI++){var mdN=mdJ(m(b11[mdI]));if(mdN){c12=[j,n(mdN)];break}}}" +
      "if(!c12){var mdL=globalThis.__mdraftTexmfLookupNocase;" +
      "if(mdL)for(var mdI=1;mdI<b11.length;mdI++){var mdN=mdL(m(b11[mdI]));if(mdN){c12=[j,n(mdN)];break}}}" +
      "if(c12)b11=[j,c12[1]];else{if(c12=ar2[1],c12)",
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
