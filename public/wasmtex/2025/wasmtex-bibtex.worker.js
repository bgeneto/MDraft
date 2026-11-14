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
const __mdraftXhr = new XMLHttpRequest();
__mdraftXhr.open("GET", new URL("wasmtex-bibtex.wasm", __mdraftRoot).href, false);
__mdraftXhr.responseType = "arraybuffer";
__mdraftXhr.send();
if (__mdraftXhr.status !== 200 || !__mdraftXhr.response) throw new Error("BibTeX WASM unavailable");
self.__wasmtexWasmBinary = __mdraftXhr.response;
const __mdraftImport = self.importScripts.bind(self);
self.importScripts = (...urls) =>
  __mdraftImport(...urls.map((url) => new URL(url, __mdraftRoot).href));
self.importScripts("wasmtex-bibtex.worker.js");
