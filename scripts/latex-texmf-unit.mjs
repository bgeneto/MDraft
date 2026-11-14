// Unit checks for local TEXMF libraries on the frontend.
//
//   node scripts/latex-texmf-unit.mjs
//
// The library snapshot comes from Rust; these checks pin what the frontend does
// with it, without an application: the bundled engine's namespaced files and
// manifest, the narrow bibliography handoff (project copies win), the names the
// reference check may treat as resolvable, the reserved prefix, the origin of a
// library diagnostic, and the editor-scoped local completion.

import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import {
  bundledLibraryFiles,
  LIBRARY_PREFIX,
  libraryLookupNames,
  libraryNames,
  libraryOrigin,
  requestedBibliography,
  reservedProjectPath,
} from "../src/latex-texmf.ts";
import { collectLatexReferences } from "../src/latex-references.ts";
import {
  latexCompletionSource,
  localLatexNames,
  setLocalLatexNames,
} from "../src/completion/latex-source.ts";

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
const snapshot = {
  revision: "r1",
  roots: [
    { id: "a", label: "Personal folder", layout: "tds", path: "C:/cfg/texmf" },
    { id: "b", label: "thesis-kit", layout: "packages", path: "D:/kit" },
  ],
  files: [
    {
      root: 0,
      path: "tex/latex/house/house.cls",
      origin: "C:/cfg/texmf/tex/latex/house/house.cls",
      data: b64("\\LoadClass{article}\\bibliographystyle{housestyle}\n"),
    },
    {
      root: 0,
      path: "tex/latex/house/part.tex",
      origin: "C:/cfg/texmf/tex/latex/house/part.tex",
      data: b64("x"),
    },
    {
      root: 0,
      path: "tex/latex/shared/shared.sty",
      origin: "C:/cfg/texmf/tex/latex/shared/shared.sty",
      data: b64("% root 0"),
    },
    {
      root: 0,
      path: "bibtex/bst/house/housestyle.bst",
      origin: "C:/cfg/texmf/bibtex/bst/house/housestyle.bst",
      data: b64("ENTRY{}{}{}"),
    },
    {
      root: 0,
      path: "bibtex/bib/refs/refs.bib",
      origin: "C:/cfg/texmf/bibtex/bib/refs/refs.bib",
      data: b64("@misc{x}"),
    },
    {
      root: 0,
      path: "fonts/opentype/f/Brand.otf",
      origin: "C:/cfg/texmf/fonts/opentype/f/Brand.otf",
      data: Buffer.from([0, 255, 1]).toString("base64"),
    },
    { root: 1, path: "tex/latex/shared.sty", origin: "D:/kit/shared.sty", data: b64("% root 1") },
    { root: 1, path: "tex/latex/kit.cls", origin: "D:/kit/kit.cls", data: b64("") },
    {
      root: 1,
      path: "bibtex/bst/housestyle.bst",
      origin: "D:/kit/housestyle.bst",
      data: b64("lower priority"),
    },
  ],
};

console.log("=== bundled engine inputs ===");
{
  const main = "\\documentclass{house}\\bibliography{refs,missing}\n";
  const { files, handedOff } = bundledLibraryFiles(snapshot, new Set(["main.tex"]), [main]);
  check(
    files[`${LIBRARY_PREFIX}/0/tex/latex/house/house.cls`] instanceof Uint8Array,
    "library files are namespaced bytes, never project text",
  );
  check(
    JSON.parse(files[`${LIBRARY_PREFIX}/manifest.json`]).roots === 2 &&
      JSON.parse(files[`${LIBRARY_PREFIX}/manifest.json`]).version === 1,
    "the versioned manifest names the root count",
  );
  check(
    Array.from(files[`${LIBRARY_PREFIX}/0/fonts/opentype/f/Brand.otf`]).join(",") === "0,255,1",
    "binary library files keep their exact bytes",
  );
  check(
    !Object.keys(files).some((path) => path.startsWith(`${LIBRARY_PREFIX}/0/bibtex/`)),
    "bibliography files are not duplicated into the TeX namespace",
  );
  check(
    files["housestyle.bst"] === "ENTRY{}{}{}" && handedOff.includes("housestyle.bst"),
    "a style a library class requests is handed off from the first root",
    String(files["housestyle.bst"]),
  );
  check(files["refs.bib"] === "@misc{x}", "a requested library database is handed off");
  check(!("missing.bib" in files), "a name no library provides is not invented");
  const withOwn = bundledLibraryFiles(snapshot, new Set(["main.tex", "refs.bib"]), [main]);
  check(!("refs.bib" in withOwn.files), "a project file of the same name always wins");
  check(
    Object.keys(bundledLibraryFiles(undefined, new Set(), [main]).files).length === 0 &&
      Object.keys(bundledLibraryFiles({ ...snapshot, roots: [], files: [] }, new Set(), []).files)
        .length === 0,
    "no libraries: nothing is added, not even a manifest",
  );
}

console.log("=== bibliography requests ===");
{
  const found = requestedBibliography([
    "\\bibliographystyle{plainx}\n% \\bibliography{commented}\n\\bibliography{a, b ,c}\n\\bibliography{\\computed}\n",
  ]);
  check(found.styles.join() === "plainx", "a literal style name is requested");
  check(
    found.databases.join() === "a,b,c",
    "literal databases are requested; comments and macros are not",
  );
}

console.log("=== reference check and reserved names ===");
{
  const names = libraryLookupNames(snapshot);
  check(
    names.has("house/part.tex") && names.has("part.tex"),
    "a library input resolves by name and by subpath",
  );
  check(names.has("refs.bib"), "a library database is a known name");
  const sources = new Map([["main.tex", "\\input{part}\\bibliography{refs}\\input{absent}"]]);
  const scan = collectLatexReferences(sources, new Set(["main.tex", ...names]), "main.tex");
  check(
    scan.diagnostics.length === 1 && scan.diagnostics[0].message.includes("absent"),
    "library inputs are not reported missing; a real absence still is",
    scan.diagnostics.map((d) => d.message).join(" | "),
  );
  check(
    reservedProjectPath(".mdraft-texmf/manifest.json") &&
      reservedProjectPath("./.MDRAFT-TEXMF/x") &&
      !reservedProjectPath("chapters/mdraft-texmf.tex"),
    "only the reserved prefix is refused",
  );
}

console.log("=== origins ===");
{
  check(
    libraryOrigin(snapshot, "../texmf/1/tex/latex/kit.cls") === "D:/kit/kit.cls",
    "a staged native path maps to the reader's file",
  );
  check(
    libraryOrigin(snapshot, "/work/.mdraft-texmf/0/tex/latex/house/house.cls") ===
      "C:/cfg/texmf/tex/latex/house/house.cls",
    "a bundled MEMFS path maps to the reader's file",
  );
  check(
    libraryOrigin(snapshot, "chapters/one.tex") === null,
    "a project path has no library origin",
  );
}

console.log("=== local completion ===");
{
  const names = libraryNames(snapshot);
  check(
    names.packages.find((entry) => entry.name === "shared")?.origin === "Personal folder",
    "a shadowed name is credited to the first root, as TeX resolves it",
  );
  check(
    names.classes.map((entry) => entry.name).join() === "house,kit",
    "local classes are listed once each",
  );
  const complete = (text, local) => {
    let state = EditorState.create({ doc: text, extensions: [localLatexNames] });
    if (local) state = state.update({ effects: setLocalLatexNames.of(local) }).state;
    return latexCompletionSource(new CompletionContext(state, text.length, true));
  };
  const withLocal = complete("\\documentclass{ho", names);
  check(
    withLocal?.options[0]?.label === "house" &&
      withLocal.options[0].detail.startsWith("Local: Personal folder"),
    "a local class is offered first with its origin",
    JSON.stringify(withLocal?.options?.slice(0, 2)),
  );
  const pkg = complete("\\usepackage{shar", names);
  check(
    pkg?.options.some((option) => option.label === "shared"),
    "a local package is offered",
  );
  const elsewhere = complete("\\documentclass{ho", null);
  check(
    !elsewhere?.options?.some((option) => option.label === "house"),
    "another editor state without the effect sees no local names",
  );
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);
