const __mdraftBase =
  self.location.protocol === "tauri:"
    ? "mdraft-tex://localhost/"
    : `${self.location.protocol}//mdraft-tex.localhost/`;
const __mdraftRoot = new URL("wasmtex/2025/", __mdraftBase).href;
const __mdraftXhr = new XMLHttpRequest();
__mdraftXhr.open("GET", new URL("wasmtex-luatex.wasm", __mdraftRoot).href, false);
__mdraftXhr.responseType = "arraybuffer";
__mdraftXhr.send();
if (__mdraftXhr.status !== 200 || !__mdraftXhr.response)
  throw new Error("LuaLaTeX WASM unavailable");
self.__wasmtexWasmBinary = __mdraftXhr.response;
const __mdraftImport = self.importScripts.bind(self);
self.importScripts = (...urls) =>
  __mdraftImport(...urls.map((url) => new URL(url, __mdraftRoot).href));
self.importScripts("wasmtex-luatex.worker.js");

// Lua `require "name"` and TeX `\input name` share the worker's flat /tex cache.
// Keep their real extensions or loading luavlna.lua overwrites luavlna.tex,
// after which Lua code is typeset as TeX and every source location is misleading.
const __mdraftCacheFileName = self.cacheFileName;
if (typeof __mdraftCacheFileName !== "function")
  throw new Error("LuaLaTeX cache-name compatibility hook unavailable");
self.cacheFileName = (format, name) => {
  const suffix = { 26: ".tex", 51: ".lua" }[format];
  return suffix && !name.includes(".") ? `${name}${suffix}` : __mdraftCacheFileName(format, name);
};
