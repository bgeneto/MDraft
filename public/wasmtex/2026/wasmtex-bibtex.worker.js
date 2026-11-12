const __mdraftBase =
  self.location.protocol === "tauri:"
    ? "mdraft-tex://localhost/"
    : `${self.location.protocol}//mdraft-tex.localhost/`;
const __mdraftRoot = new URL("wasmtex/2026/", __mdraftBase).href;
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
