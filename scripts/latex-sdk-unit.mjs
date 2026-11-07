// Unit checks for the SyncTeX route and the SDK shape it depends on.
//
//   node scripts/latex-sdk-unit.mjs
//
// The LaTeX adapter used to reach into the SDK's internals — a private
// `engine.tex.postMessageWithResponse({ cmd: "readfile" })` — to fetch
// `<job>.synctex.gz`, because the public result carried no SyncTeX. That route
// broke silently whenever the SDK changed its worker shape.
//
// The pinned SDK now exposes SyncTeX publicly, and documents the order to consume
// it in: `synctexData ?? parse(synctex)`. These checks pin that shape, so an SDK
// upgrade that removes or renames either field fails here rather than at runtime
// in a reader's document.
//
// No application: this reads the installed package's type declarations.

import { readFileSync } from "node:fs";

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

/** The installed SDK's declared CompileResult. */
function compileResultSource() {
  return readFileSync("node_modules/wasmtex/lib/types.d.ts", "utf8");
}

console.log("=== the SDK still exposes SyncTeX publicly ===");
{
  const types = compileResultSource();
  const block = /export interface CompileResult \{[\s\S]*?\n\}/.exec(types)?.[0] ?? "";
  check(block.length > 0, "CompileResult is declared", `${block.length} chars`);

  // `synctex` is the raw bytes from the engine; `synctexData` is the parsed form,
  // and for an incremental compile it is the only one that is populated.
  check(/\bsynctex\s*:\s*Uint8Array \| null/.test(block), "CompileResult carries raw `synctex`");
  check(
    /\bsynctexData\?\s*:/.test(block),
    "CompileResult carries parsed `synctexData`",
  );
  check(
    /synctexData \?\? parse\(synctex\)/.test(block),
    "the SDK documents the consumption order",
  );
}

console.log("\n=== the adapter uses the public route, not the worker internals ===");
{
  const source = readFileSync("src/latex.ts", "utf8");
  // Comments are stripped first: the adapter's own doc comment names the private
  // route it replaced, and matching that would be a false positive. What matters
  // is that no *code* reaches into the worker.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // The private read is what broke. Its absence is the assertion.
  check(
    !/postMessageWithResponse/.test(code),
    "the adapter no longer reaches into the worker protocol",
  );
  check(
    !/\.synctex\.gz/.test(code),
    "the adapter no longer names the internal SyncTeX file",
  );
  check(
    /result\.synctexData \?\?/.test(code),
    "the adapter prefers `synctexData`",
  );
  check(
    /result\.synctex \?/.test(code),
    "the adapter falls back to parsing `synctex`",
  );
  // An engine that produces neither must fail with a message rather than a
  // silent null mapping, which would make every click do nothing.
  check(
    /did not produce SyncTeX output/.test(code),
    "a missing SyncTeX fails with a named error",
  );
}

console.log("\n=== the parser is still imported from the SDK's own entry point ===");
{
  const source = readFileSync("src/latex.ts", "utf8");
  check(
    /import\("wasmtex\/synctex"\)/.test(source),
    "the SyncTeX parser comes from `wasmtex/synctex`",
  );
  check(
    /new SynctexParser\(\)/.test(source),
    "the parser is constructed for the fallback route",
  );
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
