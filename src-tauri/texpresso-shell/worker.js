// The data base is same-origin, so config.js needs no global set first.
const { BUNDLES, DEFAULT_BUNDLE } = await import("./config.js");
await import("./ocaml-worker.js");
globalThis.texpresso_ocaml.worker.main(BUNDLES, DEFAULT_BUNDLE);
