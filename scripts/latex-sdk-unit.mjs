//! Pin the no-SyncTeX compilation contract and the chosen LuaLaTeX engine.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { compileDiagnostics, latexBuildFailed } from "../src/latex.ts";
const adapter = readFileSync("src/latex.ts", "utf8");
const compile = adapter.slice(adapter.indexOf("export async function compileLatex"));
assert.match(compile, /engine:\s*["']lualatex["']/);
assert.doesNotMatch(
  compile,
  /wasmtex\/synctex|SynctexParser|synctexData|postMessageWithResponse|\\synctex=1/i,
);
assert.match(compile, /sources:\s*Object\.entries\(files\)/);
assert.match(compile, /mainFile:\s*snapshot\.mainFile/);
assert.match(readFileSync("samples/latex-project/main.tex", "utf8"), /\\usepackage\{fontspec\}/);
const pdf = new Uint8Array([37, 80, 68, 70]);
assert.equal(
  latexBuildFailed({
    success: true,
    pdf,
    errors: [{ severity: "warning", message: "There were undefined references." }],
  }),
  false,
);
assert.equal(
  latexBuildFailed({
    success: true,
    pdf,
    errors: [{ severity: "error", message: "Undefined control sequence." }],
  }),
  true,
);
assert.equal(latexBuildFailed({ success: false, pdf, errors: [] }), true);
assert.equal(latexBuildFailed({ success: true, pdf: null, errors: [] }), true);
assert.equal(
  latexBuildFailed({
    success: true,
    pdf,
    errors: [],
    telemetry: { diagnostics: [{ severity: "error", message: "Failed." }] },
  }),
  true,
);

// Exercise the actual bootstrap against a classic-script worker: its function
// binding is also used by unqualified calls inside the verified remote worker.
const runtime = createContext({
  URL,
  location: { protocol: "https:" },
  XMLHttpRequest: class {
    status = 200;
    response = new ArrayBuffer(1);
    open() {}
    send() {}
  },
});
runtime.self = runtime;
runtime.importScripts = () =>
  runInContext(
    `
  function cacheFileName(format,name) {
    const suffix={3:'.tfm',33:'.vf'}[format];
    return suffix && !name.endsWith(suffix)?name+suffix:name;
  }
  function locate(format,name) {return '/tex/'+cacheFileName(format,name);}
  function writeTexmfCnf() {}
`,
    runtime,
  );
runInContext(readFileSync("public/wasmtex/2025/wasmtex-luatex.worker.js", "utf8"), runtime);
assert.equal(runtime.locate(26, "luavlna"), "/tex/luavlna.tex");
assert.equal(runtime.locate(51, "luavlna"), "/tex/luavlna.lua");
assert.notEqual(runtime.locate(26, "luavlna"), runtime.locate(51, "luavlna"));
assert.equal(runtime.locate("51", "luavlna"), "/tex/luavlna.lua");
assert.equal(runtime.locate(26, "geometry.cfg"), "/tex/geometry.cfg");
assert.equal(runtime.locate(26, "luavlna.sty"), "/tex/luavlna.sty");
assert.equal(runtime.locate(51, "luavlna.lua"), "/tex/luavlna.lua");
assert.equal(runtime.locate(3, "cmr12"), "/tex/cmr12.tfm");
assert.equal(runtime.locate(33, "ptmb8t"), "/tex/ptmb8t.vf");
assert.equal(runtime.locate(47, "example.otf"), "/tex/example.otf");

// Local TEXMF libraries: the upstream cnf lines the hook rewrites, verbatim from
// the pinned worker (SHA-256 9a065d4c…a084). A drift makes the hook throw.
const upstreamCnf = [
  "TEXMFCNF = .;/work",
  "TEXINPUTS = .;/tex//",
  "LUAINPUTS = .;/tex//",
  "CLUAINPUTS = .;/tex//",
  "TEXFORMATS = .;/tex//",
  "TEXFONTMAPS = .;/tex//",
  "ENCFONTS = .;/tex//",
  "OPENTYPEFONTS = .;/tex//",
  "TTFONTS = .;/tex//",
  "T1FONTS = .;/tex//",
  "TFMFONTS = .;/tex//",
  "VFFONTS = .;/tex//",
  "TEXPSHEADERS = .;/tex//",
  "",
].join("\n");
const withLibraries = runtime.mdraftLibraryCnf(upstreamCnf, 2);
assert.match(
  withLibraries,
  /^TEXINPUTS = \.;\/work\/\.mdraft-texmf\/0\/tex\/lualatex\/\/;\/work\/\.mdraft-texmf\/0\/tex\/latex\/\/;.*\/work\/\.mdraft-texmf\/1\/tex\/\/;\/tex\/\/$/m,
  "the project, then roots in order, then the mirror cache",
);
assert.match(withLibraries, /^LUAINPUTS = \.;\/work\/\.mdraft-texmf\/0\/scripts\/\/;/m);
assert.match(
  withLibraries,
  /^OPENTYPEFONTS = \.;\/work\/\.mdraft-texmf\/0\/fonts\/opentype\/\/;\/work\/\.mdraft-texmf\/1\/fonts\/opentype\/\/;\/tex\/\/$/m,
);
assert.match(
  withLibraries,
  /^TEXFORMATS = \.;\/tex\/\/$/m,
  "formats are never taken from a library",
);
assert.match(
  withLibraries,
  /^CLUAINPUTS = \.;\/tex\/\/$/m,
  "native Lua modules are never taken from a library",
);
assert.equal(runtime.mdraftLibraryRoots('{"version":1,"roots":3}'), 3);
assert.throws(
  () => runtime.mdraftLibraryRoots('{"version":2,"roots":1}'),
  /Unsupported local library manifest/,
);
assert.throws(() => runtime.mdraftLibraryRoots('{"version":1,"roots":9}'), /Unsupported/);
assert.throws(
  () => runtime.mdraftLibraryCnf("TEXINPUTS = /tex//\n", 1),
  /unexpected form/,
  "a changed upstream cnf fails loudly instead of ignoring the libraries",
);
const message = "LaTeX Error: File `image' not found.";
const sourceLines = Array.from({ length: 19 }, (_, index) =>
  index === 18 ? "\\header" : "content",
).join("\n");
const recovered = compileDiagnostics(
  {
    errors: [{ severity: "error", file: "/tex/main.tex", line: 0, message }],
    log: `! ${message}\n\nSee the LaTeX manual or LaTeX Companion for explanation.\nType H for help.\n ...\n\n\n\nl.19 \\header\n`,
  },
  new Map([["main.tex", sourceLines]]),
);
assert.equal(recovered.diagnostics[0].line, 19);
assert.equal(recovered.diagnostics[0].lineText, "\\header");
assert.equal(recovered.diagnostics[0].file, "main.tex");
const repeated = compileDiagnostics(
  {
    errors: [
      { severity: "error", file: "main.tex", line: 0, message: "Missing $ inserted." },
      { severity: "error", file: "main.tex", line: 0, message: "Missing $ inserted." },
    ],
    log: "! Missing $ inserted.\n\nl.3 first\n! Missing $ inserted.\n\nl.6 second\n",
  },
  new Map([["main.tex", sourceLines]]),
);
assert.deepEqual(
  repeated.diagnostics.map((diagnostic) => diagnostic.line),
  [3, 6],
);
const noPointer = compileDiagnostics(
  {
    errors: [{ severity: "error", file: "main.tex", line: 0, message }],
    log: `! ${message}\nLaTeX Warning: unrelated warning.\nl.19 \\header`,
  },
  new Map([["main.tex", sourceLines]]),
);
assert.equal(noPointer.diagnostics[0].line, 0);
const supplied = compileDiagnostics(
  {
    errors: [{ severity: "error", file: "main.tex", line: 7, message }],
    log: `! ${message}\nl.19 \\header`,
  },
  new Map([["main.tex", sourceLines]]),
);
assert.equal(supplied.diagnostics[0].line, 7);
console.log("26/26 LaTeX adapter checks passed");
