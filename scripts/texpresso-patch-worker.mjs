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
// from the folder listings and the project route, so on-demand project files
// need no edit of their own. These edits add what the hook does not cover:
//   - a name the folder listings do not rule out is offered to the hook again
//     after an earlier miss (upstream remembers misses until the name is put),
//     so a file that appears later is found; the worker keeps its own misses;
//   - the local TEXMF libraries, after the project and its folders and before
//     the bundle, in TeX's order, reporting a library file that replaces a
//     TeX Live one;
//   - the folder listings, then the libraries, in the case-insensitive lookup;
//   - the export's xdvipdfmx, which shares the lookup but never asks for the
//     case-insensitive one, gets the engine's case-insensitive answer after an
//     exact miss everywhere.
// One more edit is about memory, not files:
//   - after `retcon_trail: the arena is full` the worker reports the failure
//     instead of restarting from scratch, a retry that stops at the same page
//     while the first engine's memory is still held.
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
  release: "log-based-completion-2-ga271257",
  bytes: 235346,
  sha256: "0e840408510145e0299343320492e12d2bfc0fe62b7002f3c19dc221fe362fc0",
};

// Names inside the host table builder `al2(u2,l10,c11)`: `c11` the session (0
// for the export's xdvipdfmx), `l10` the bundle index (`l10[1]` its table),
// `h10` the project probe, `d11` the pending bytes, `bt` the project table,
// `M2` the bundle files already loaded, `hF` the names the hook already
// missed; `cU`/`aj` table find, `ar` table member, `k` the `Some` tag, `bV` a
// hit by candidate index, `o`/`n` a JS string to and from an OCaml one. The
// `md*` locals avoid every name the surrounding minified code uses.
const EDITS = [
  {
    what: "the project hook: a name the listings do not rule out is asked again",
    from: "var g10=bm(function(a13){return 1-ar(hF,a13)},e1(c12)),a11=qI(0);",
    to:
      "var g10=bm(function(a13){var mdH=globalThis.__mdraftProjectHas;" +
      "return 1-ar(hF,a13)||(mdH&&mdH(n(a13))?1:0)},e1(c12)),a11=qI(0);",
  },
  {
    what: "exact lookup: the libraries after the project and its folders, before the bundle",
    from: "function e11(a13){for(a13=0;;){if(a13===f11)a13=0;else{var b12=aj(M2,",
    to: "function e11(a13){var mdV=mdLib(c12,f11);if(mdV)return mdV;for(a13=0;;){if(a13===f11)a13=0;else{var b12=aj(M2,",
  },
  {
    // `mdLib` answers a library file from the project table, where MDraft
    // stores it under `.mdraft-texmf/`. `mdQ` is true when no candidate name
    // matches exactly anywhere: project table, folder listings, library index,
    // loaded bundle, or bundle index. Only then does the export take the
    // case-insensitive answer (`mdNC`, the record's second function), so an
    // exact match still wins, as it does for TeX. TeX's own lookups have a
    // session and are unchanged.
    what: "the export's lookup: the engine's case-insensitive fallback",
    from: "return[481420544,function(a11,b11){d11[1]=0;var c12=ad2(a11,b11),f11=c12.length-1;",
    to:
      "function mdLib(mdC,mdF){var mdG=globalThis.__mdraftTexmfLookup;if(!mdG)return 0;" +
      "for(var mdI=0;mdI<mdF;mdI++){var mdN=mdC[mdI+1],mdP=mdG(n(mdN));if(!mdP)continue;" +
      "var mdH=cU(bt,o(mdP));if(!mdH)continue;" +
      "if(l10&&ar(l10[1],mdN)&&globalThis.__mdraftTexmfOverride)globalThis.__mdraftTexmfOverride(n(mdN));" +
      "d11[1]=[k,mdH[1]];return[bV,mdI]}return 0}" +
      "function mdQ(mdC){var mdQh=globalThis.__mdraftProjectHas,mdQt=globalThis.__mdraftTexmfLookup;" +
      "for(var mdI=1;mdI<mdC.length;mdI++){var mdN=mdC[mdI],mdS=n(mdN);" +
      "if(h10(mdN)||mdQh&&mdQh(mdS)||mdQt&&mdQt(mdS)||ah(M2,mdN)||l10&&ar(l10[1],mdN))return 0}return 1}" +
      "var mdNC;" +
      "return[481420544,function(a11,b11){" +
      "if(!c11&&mdNC&&mdQ(ad2(a11,b11))){var mdS=mdNC(a11,b11);if(mdS){a11=mdS[1];b11=[0]}}" +
      "d11[1]=0;var c12=ad2(a11,b11),f11=c12.length-1;",
  },
  {
    what: "the case-insensitive lookup, named for the export's fallback",
    from: "},function(a11,b11){a11=e0(X2,ad2(a11,b11)),b11=ah(ae,16);",
    to: "},mdNC=function(a11,b11){a11=e0(X2,ad2(a11,b11)),b11=ah(ae,16);",
  },
  {
    what: "case-insensitive lookup: project, then folder listings, then libraries",
    from: "if(c12)return[k,c12[1]];if(c12=ag2[1],c12)",
    to:
      "if(!c12){var mdJ=globalThis.__mdraftProjectHasNocase;" +
      "if(mdJ)for(var mdI=1;mdI<a11.length;mdI++){var mdN=mdJ(n(a11[mdI]));if(mdN){c12=[k,o(mdN)];break}}}" +
      "if(!c12){var mdL=globalThis.__mdraftTexmfLookupNocase;" +
      "if(mdL)for(var mdI=1;mdI<a11.length;mdI++){var mdN=mdL(n(a11[mdI]));if(mdN){c12=[k,o(mdN)];break}}}" +
      "if(c12)return[k,c12[1]];if(c12=ag2[1],c12)",
  },
  {
    // Names inside the engine's failure handler: `B2` the queue of the
    // engine's last console lines (`[length, first cell]`, a cell is
    // `[0, line, next]`), `a22` the `^retcon_trail: (out of memory|the arena is
    // full)` pattern, `O2` true on the run that is already the retry, `cT` the
    // worker's log, `I2(1, …)` the restart from scratch, `sa` the restart
    // message.
    //
    // The trail arena is a fixed build setting, so the retry after it fills
    // stops at the same page (every run measured on infdesc, both engines).
    // Meanwhile the first engine's memory, up to 4 GiB, is garbage V8 does
    // not collect while the worker runs WebAssembly, and the frame's process
    // holds two engine heaps: 11.1 GB at peak instead of 7.4 GB, with the
    // verdict after about 115 s instead of 55 s. Out of memory at the heap cap
    // still retries once.
    what: "no restart from scratch after the trail arena fills",
    from:
      "for(p11=0,m11=B2[2];m11;){var v4=m11[2],m11=m11[1];p11||(p11=a8(a22,m11)),m11=v4}" +
      'if(m11=1048576,m11=w3[0]&i?kY(w3[1],"heapLength",[0])/m11|0:w3[1].HEAPU8.length/m11|0,' +
      "p11&&!O2)return cT(j(t(sa),m11)),I2(1,b11,c11,d11);",
    to:
      "var mdArena=0;" +
      "for(p11=0,m11=B2[2];m11;){var v4=m11[2],m11=m11[1];p11||(p11=a8(a22,m11))," +
      "mdArena||(mdArena=/^retcon_trail: the arena is full/.test(m11)?1:0),m11=v4}" +
      'if(m11=1048576,m11=w3[0]&i?kY(w3[1],"heapLength",[0])/m11|0:w3[1].HEAPU8.length/m11|0,' +
      "p11&&!O2&&(!mdArena||(cT(" +
      '"Worker: the trail arena is full; a restart from scratch would stop at the same page"' +
      "),0)))return cT(j(t(sa),m11)),I2(1,b11,c11,d11);",
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
