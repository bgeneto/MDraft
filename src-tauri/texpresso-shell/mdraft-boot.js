// MDraft: start the app from nothing, with the engine the host asked for.
//
// TeXpresso keeps its projects in IndexedDB (`texstation`), and a project here
// is a copy of the reader's files. Whatever an earlier session left is deleted
// before the app opens, so no document outlives the frame that showed it
// (mdraft-bridge.js empties the project on dispose as well). The engine's own
// font cache, `texpresso-luatex-caches`, holds no document and is kept: it
// saves seconds on every start.
//
// The worker takes its Wasm binary, format and font cache from the project's
// engine, and a new project takes DEFAULT_ENGINE from config.js, which reads
// this global; an engine change is therefore a new frame, never a setting.
const engine = new URLSearchParams(location.search).get("engine") === "xetex" ? "xetex" : "luatex";
globalThis.__TEXPRESSO_ENGINE__ = engine;
await new Promise((resolve) => {
  try {
    const request = indexedDB.deleteDatabase("texstation");
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  } catch {
    resolve();
  }
});
try {
  localStorage.clear();
  localStorage.setItem("texpresso.welcomed", "1");
  // The caret marks are the source map's output that MDraft reads; the
  // scrolling the app attaches to them is dropped by the bridge.
  localStorage.setItem(
    "texpresso.settings",
    JSON.stringify({ cursor: true, darkPages: false, crashes: false, theme: "light" }),
  );
} catch {
  // Storage refused: the app's defaults apply, and the bridge sets the same.
}
const cm = await import("./vendor/codemirror/codemirror.js");
const config = await import("./config.js");
await import("./ocaml.js");
globalThis.texpresso_ocaml.codemirror(cm);
globalThis.texpresso_ocaml.config(config);
await globalThis.texpresso_ocaml.app.main();
