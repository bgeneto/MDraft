//! Pin the no-SyncTeX compilation contract and the chosen LuaLaTeX engine.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { compileDiagnostics, latexBuildFailed, openFileAt } from "../src/latex.ts";
const adapter = readFileSync("src/latex.ts", "utf8");
const compile = adapter.slice(adapter.indexOf("export async function compileLatex"));
// LuaLaTeX stays the default; another engine is only ever an explicit choice
// (stage 6.2), handed in by the caller and never picked here.
assert.match(compile, /const texEngine = options\.engine \?\? "lualatex";/);
assert.match(compile, /new WasmTexCompiler\(\{\s*engine: texEngine,/);
assert.doesNotMatch(
  compile,
  /wasmtex\/synctex|SynctexParser|synctexData|postMessageWithResponse|\\synctex=1/i,
);
assert.match(compile, /sources:\s*\[\.\.\.decoded\.entries\(\)\]/);
// The decode lives in `prepareInputs`, shared with the interactive preview, and
// the compile must go through it rather than decoding on its own.
const prepare = adapter.slice(
  adapter.indexOf("function prepareInputs"),
  adapter.indexOf("export async function compileLatex"),
);
assert.match(prepare, /encoding\.toUpperCase\(\) === "UTF-8" \? source : bytes/);
assert.match(compile, /prepareInputs\(snapshot\)/);
assert.match(compile, /mainFile:\s*snapshot\.mainFile/);
assert.match(readFileSync("samples/latex-project/main.tex", "utf8"), /\\usepackage\{fontspec\}/);

// The TeX Live year is one pinned unit read from one file
// (docs/adr/2026-11-12-engine-profile-config.md): `src-tauri/latex-engine.json` names the
// active year and one profile per year. Rust derives its URLs from it, `latex-engine.ts`
// hands the SDK the year, and each profile needs a `public/wasmtex/<year>/` folder of
// identical shims that read their year from their own URL. The `mdraft-tex` URL carries
// no year the SDK could check, so the pieces are checked against each other here; the
// Rust side is covered by `cargo test --lib latex::`.
const engine = JSON.parse(readFileSync("src-tauri/latex-engine.json", "utf8"));
const years = Object.keys(engine.profiles);
assert.ok(years.length >= 2, "both years stay switchable");
assert.ok(years.includes(engine.active), `"active" is ${engine.active}, which has no profile`);
assert.match(
  adapter,
  /texliveVersion:\s*LATEX_ENGINE_YEAR/,
  "latex.ts takes the year from the config",
);
assert.match(
  readFileSync("src/latex-engine.ts", "utf8"),
  /from "\.\.\/src-tauri\/latex-engine\.json"/,
  "latex-engine.ts reads the file the backend reads",
);
assert.deepEqual(
  readdirSync("public/wasmtex").sort(),
  [...years].sort(),
  "one shim folder per profile, and no other year's",
);
const shimNames = [
  "wasmtex-luatex.worker.js",
  "wasmtex-bibtex.worker.js",
  "wasmtex-pdftex.worker.js",
  "wasmtex-xetex.worker.js",
  "wasmtex-dvipdfm.worker.js",
];
const shims = {};
for (const shim of shimNames) {
  const texts = years.map((year) => readFileSync(`public/wasmtex/${year}/${shim}`, "utf8"));
  assert.ok(
    texts.every((text) => text === texts[0]),
    `${shim} is identical in every year folder`,
  );
  assert.doesNotMatch(texts[0], /wasmtex\/\d{4}\//, `${shim} names no year of its own`);
  shims[shim] = texts[0];
}
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
function bootstrap(
  year,
  shim = "wasmtex-luatex.worker.js",
  folder = `wasmtex/${year}`,
  search = "",
) {
  const urls = [];
  const runtime = createContext({
    URL,
    URLSearchParams,
    location: {
      protocol: "https:",
      pathname: `/${folder}/${shim}`,
      search,
      href: `https://mdraft.localhost/${folder}/${shim}${search}`,
    },
    XMLHttpRequest: class {
      status = 200;
      response = new ArrayBuffer(1);
      open(_method, url) {
        urls.push(url);
      }
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
  runInContext(shims[shim], runtime);
  return { runtime, urls };
}
// Each shim reads the engine from the folder it was loaded from, whatever the year, so
// one file serves every profile; without a year in its URL it refuses to guess.
for (const year of years) {
  for (const shim of shimNames) {
    const wasm = shim.replace(".worker.js", ".wasm");
    assert.deepEqual(
      bootstrap(year, shim).urls,
      [`https://mdraft-tex.localhost/wasmtex/${year}/${wasm}`],
      `${shim} loads ${year}'s engine`,
    );
  }
}
assert.throws(
  () => bootstrap("none", "wasmtex-luatex.worker.js", "elsewhere"),
  /cannot read its TeX Live year/,
);
// Heap checkpoints (stage 3.2): the SDK loads the worker with `?engine=checkpoint`
// and the upstream worker then imports the checkpoint glue, so the preloaded
// binary must be the checkpoint build too; the plain one would not instantiate.
for (const year of years) {
  assert.deepEqual(
    bootstrap(year, "wasmtex-luatex.worker.js", `wasmtex/${year}`, "?engine=checkpoint").urls,
    [`https://mdraft-tex.localhost/wasmtex/${year}/wasmtex-luatex-checkpoint.wasm`],
    `the LuaTeX shim preloads ${year}'s checkpoint binary for ?engine=checkpoint`,
  );
  assert.deepEqual(
    bootstrap(year, "wasmtex-luatex.worker.js", `wasmtex/${year}`, "?engine=plain").urls,
    [`https://mdraft-tex.localhost/wasmtex/${year}/wasmtex-luatex.wasm`],
    "any other engine query keeps the plain binary",
  );
}
const { runtime } = bootstrap(engine.active);
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
// Optional engines (stage 6.2): the pdfLaTeX and XeLaTeX shims rewrite their own
// workers' cnf lines, verbatim from the pinned 2025 workers, with their own TDS dirs.
{
  const pdftexCnf = [
    "TEXINPUTS = .;/tex//",
    "TFMFONTS = .;/tex//",
    "T1FONTS = .;/tex//",
    "AFMFONTS = .;/tex//",
    "TEXFONTMAPS = .;/tex//",
    "ENCFONTS = .;/tex//",
    "VFFONTS = .;/tex//",
    "TEXFORMATS = .;/tex//",
    "TEXPOOL = .;/tex//",
    "",
  ].join("\n");
  const pdftex = bootstrap(engine.active, "wasmtex-pdftex.worker.js").runtime;
  const rewritten = pdftex.mdraftLibraryCnf(pdftexCnf, 1);
  assert.match(
    rewritten,
    /^TEXINPUTS = \.;\/work\/\.mdraft-texmf\/0\/tex\/latex\/\/;\/work\/\.mdraft-texmf\/0\/tex\/generic\/\/;\/work\/\.mdraft-texmf\/0\/tex\/\/;\/tex\/\/$/m,
    "pdfLaTeX searches the libraries' tex/latex, then tex/generic",
  );
  assert.match(rewritten, /^AFMFONTS = \.;\/work\/\.mdraft-texmf\/0\/fonts\/afm\/\/;/m);
  assert.match(rewritten, /^TEXFORMATS = \.;\/tex\/\/$/m, "formats never come from a library");
  const xetexCnf = [
    "TEXMFCNF = .;/work",
    "TEXINPUTS = .;/tex//",
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
  const xetex = bootstrap(engine.active, "wasmtex-xetex.worker.js").runtime;
  assert.match(
    xetex.mdraftLibraryCnf(xetexCnf, 1),
    /^TEXINPUTS = \.;\/work\/\.mdraft-texmf\/0\/tex\/xelatex\/\/;/m,
    "XeLaTeX searches the libraries' tex/xelatex first",
  );
  // The Lua engine's table would throw on pdfTeX's cnf (it has no LUAINPUTS line).
  assert.throws(() => runtime.mdraftLibraryCnf(pdftexCnf, 1), /unexpected form/);
  // Every optional engine's files are pinned in every profile.
  for (const year of years) {
    const groups = engine.profiles[year].engines ?? {};
    assert.deepEqual(
      Object.keys(groups).sort(),
      ["pdftex", "xetex"],
      `${year} offers both engines`,
    );
    for (const [name, assets] of Object.entries(groups)) {
      assert.ok(
        assets.some((asset) => asset.name === `wasmtex-${name}.wasm`),
        `${year} ${name} wasm`,
      );
      for (const asset of assets) assert.match(asset.sha256, /^[0-9a-f]{64}$/, asset.name);
    }
    assert.ok(
      groups.pdftex.some((asset) => asset.name === "wasmtex-pdftex-checkpoint.wasm"),
      "pdfLaTeX ships its checkpoint build",
    );
    // XeLaTeX writes XDV; its dvipdfmx worker turns that into the PDF, so the
    // engine is unusable without it ("not available in this build").
    for (const name of ["wasmtex-dvipdfm.js", "wasmtex-dvipdfm.wasm", "wasmtex-dvipdfm.worker.js"])
      assert.ok(
        groups.xetex.some((asset) => asset.name === name),
        `${year} XeLaTeX ships ${name}`,
      );
  }
}
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
// The SDK reports LaTeX warnings with line 0; the line is in the message.
const reference = compileDiagnostics(
  {
    errors: [
      {
        severity: "warning",
        file: "main.tex",
        line: 0,
        message: "LaTeX Warning: Reference `missing' on page 1 undefined on input line 19.",
      },
    ],
    log: "",
  },
  new Map([["main.tex", sourceLines]]),
);
assert.equal(reference.diagnostics[0].line, 19);
assert.equal(reference.diagnostics[0].lineText, "\\header");
const summary = compileDiagnostics(
  {
    errors: [
      {
        severity: "warning",
        file: "main.tex",
        line: 0,
        message: "LaTeX Warning: There were undefined references.",
      },
    ],
    log: "",
  },
  new Map([["main.tex", sourceLines]]),
);
assert.equal(summary.diagnostics[0].line, 0, "a warning with no place stays unplaced");
// TeX wraps the log at 79 columns and the SDK keeps the first physical line,
// so the message is cut before its line number; the log has the rest.
const cut = "LaTeX Warning: Reference `mdraft-missing-label' on page 1 undefined on input li";
const wrapped = compileDiagnostics(
  {
    errors: [
      { severity: "warning", file: "main.tex", line: 0, message: cut },
      { severity: "warning", file: "main.tex", line: 0, message: cut },
    ],
    log: `${cut}\nne 3.\n\n${cut}\nne 19.\n`,
  },
  new Map([["main.tex", sourceLines]]),
);
assert.deepEqual(
  wrapped.diagnostics.map((diagnostic) => diagnostic.line),
  [3, 19],
  "a wrapped warning recovers its line, and a repeat gets its own",
);
// The SDK names the main file; the log shows which file TeX had open. This is
// the shape of the bundled engine's real log for a \ref in an \input chapter.
const chapterLog =
  '(./main.tex (/tex/article.cls (/tex/size10.clo)) (/tex/l3backend-luatex.def)\nNo file main.aux.\n("./Resumo executivo.tex"\n\n' +
  `${cut}\nne 4.\n\n) [1{/tex/pdftex.map}] (./main.aux)\n\nLaTeX Warning: There were undefined references.\n\n)\n`;
assert.equal(openFileAt(chapterLog, chapterLog.indexOf(cut)), "./Resumo executivo.tex");
assert.equal(
  openFileAt(chapterLog, chapterLog.indexOf("There were")),
  "./main.tex",
  "a closed chapter and a closed system file are popped",
);
const chapter = compileDiagnostics(
  {
    errors: [{ severity: "warning", file: "main.tex", line: 0, message: cut }],
    log: chapterLog,
  },
  new Map([
    ["main.tex", "\\documentclass{article}"],
    ["Resumo executivo.tex", "one\ntwo\nthree\nA reference: \\ref{mdraft-missing-label}."],
  ]),
);
assert.equal(chapter.diagnostics[0].file, "Resumo executivo.tex");
assert.equal(chapter.diagnostics[0].line, 4);
assert.equal(chapter.diagnostics[0].lineText, "A reference: \\ref{mdraft-missing-label}.");
console.log("35/35 LaTeX adapter checks passed");
