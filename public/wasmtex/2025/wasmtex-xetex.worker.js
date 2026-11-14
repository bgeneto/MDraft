const __mdraftBase =
  self.location.protocol === "tauri:"
    ? "mdraft-tex://localhost/"
    : `${self.location.protocol}//mdraft-tex.localhost/`;
// The year is the folder this script was loaded from, so every profile's folder holds
// the same file (docs/architecture.md).
const __mdraftYear = /\/wasmtex\/(\d{4})\//.exec(self.location.pathname)?.[1];
if (!__mdraftYear)
  throw new Error("The LaTeX worker cannot read its TeX Live year from " + self.location.href);
const __mdraftRoot = new URL(`wasmtex/${__mdraftYear}/`, __mdraftBase).href;
// XeLaTeX (stage 6.2 of docs/architecture.md), loaded the same
// way as the Lua engine shim beside it.
const __mdraftXhr = new XMLHttpRequest();
__mdraftXhr.open("GET", new URL("wasmtex-xetex.wasm", __mdraftRoot).href, false);
__mdraftXhr.responseType = "arraybuffer";
__mdraftXhr.send();
if (__mdraftXhr.status !== 200 || !__mdraftXhr.response)
  throw new Error("XeLaTeX WASM unavailable");
self.__wasmtexWasmBinary = __mdraftXhr.response;
const __mdraftImport = self.importScripts.bind(self);
self.importScripts = (...urls) =>
  __mdraftImport(...urls.map((url) => new URL(url, __mdraftRoot).href));
self.importScripts("wasmtex-xetex.worker.js");

// Local TEXMF libraries (docs/architecture.md). The host
// passes each captured library tree through the SDK's public `files` option as
// /work/.mdraft-texmf/<n>/<TDS path>, plus a versioned manifest. kpathsea searches
// MEMFS directories before the worker's mirror resolver, so a private name never
// meets the resolver's Bloom filter or negative cache. The order per root follows
// TeX Live's xelatex search: project (.), then roots 0..n-1, then the mirror cache.
const __mdraftLibraryPrefix = "/work/.mdraft-texmf";
const __mdraftLibraryDirs = {
  TEXINPUTS: ["tex/xelatex", "tex/latex", "tex/xetex", "tex/generic", "tex"],
  TEXFONTMAPS: ["fonts/map"],
  ENCFONTS: ["fonts/enc"],
  OPENTYPEFONTS: ["fonts/opentype"],
  TTFONTS: ["fonts/truetype"],
  T1FONTS: ["fonts/type1"],
  TFMFONTS: ["fonts/tfm"],
  VFFONTS: ["fonts/vf"],
};
/** Root count from the manifest text; a present but unsupported manifest fails loudly. */
self.mdraftLibraryRoots = (text) => {
  const manifest = JSON.parse(text);
  if (
    !manifest ||
    manifest.version !== 1 ||
    !Number.isInteger(manifest.roots) ||
    manifest.roots < 0 ||
    manifest.roots > 8
  )
    throw new Error("Unsupported local library manifest");
  return manifest.roots;
};
/** Insert the library directories after `.` in each search-path line of the cnf. */
self.mdraftLibraryCnf = (cnf, roots) => {
  let next = cnf;
  for (const [name, dirs] of Object.entries(__mdraftLibraryDirs)) {
    const paths = [];
    for (let root = 0; root < roots; root++)
      for (const dir of dirs) paths.push(`${__mdraftLibraryPrefix}/${root}/${dir}//`);
    const line = new RegExp(`^${name} = \\.;`, "m");
    if (!line.test(next)) throw new Error(`XeLaTeX search path ${name} has an unexpected form`);
    next = next.replace(line, `${name} = .;${paths.join(";")};`);
  }
  return next;
};
const __mdraftWriteTexmfCnf = self.writeTexmfCnf;
if (typeof __mdraftWriteTexmfCnf !== "function")
  throw new Error("XeLaTeX search-path hook unavailable");
self.writeTexmfCnf = (...args) => {
  __mdraftWriteTexmfCnf(...args);
  let manifest = null;
  try {
    manifest = FS.readFile(`${__mdraftLibraryPrefix}/manifest.json`, { encoding: "utf8" });
  } catch {
    return; // No libraries: the upstream configuration is used unchanged.
  }
  const roots = self.mdraftLibraryRoots(manifest);
  if (!roots) return;
  const cnf = FS.readFile("/work/texmf.cnf", { encoding: "utf8" });
  FS.writeFile("/work/texmf.cnf", self.mdraftLibraryCnf(cnf, roots));
};
