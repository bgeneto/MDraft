// Local TEXMF libraries. MDraft sends their files as project files under
// `.mdraft-texmf/<root>/<TDS path>`, plus `.mdraft-texmf/index.json`: which
// stored file answers each name TeX may ask for, highest priority first, in
// TeX Live's search order for this engine (src/texpresso/library.ts).
//
// The pinned ocaml-worker.js is patched (scripts/texpresso-patch-worker.mjs) to
// ask these hooks for a name the project itself does not hold, before the TeX
// Live bundle:
//   __mdraftTexmfLookup(name)       → the stored path, or null;
//   __mdraftTexmfLookupNocase(name) → the indexed name that differs only in
//                                     case, or null (the engine then looks
//                                     that name up exactly);
//   __mdraftTexmfOverride(name)     → the engine loaded a library file in
//                                     place of TeX Live's copy.
//
// The listener is added before any await, so it precedes ocaml-worker.js's own
// and sees every `put`/`remove` first. It only reads the message.
const INDEX = ".mdraft-texmf/index.json";
let exact = new Map();
let folded = new Map();
const reported = new Set();
let channel = null;

function load(value) {
  exact = new Map();
  folded = new Map();
  reported.clear();
  if (value === null || value === undefined) return;
  try {
    const text = typeof value === "string" ? value : new TextDecoder().decode(value);
    const manifest = JSON.parse(text);
    if (manifest?.version !== 1 || !Array.isArray(manifest.names)) return;
    for (const entry of manifest.names) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string")
        continue;
      const [name, stored] = entry;
      if (!stored.startsWith(".mdraft-texmf/") || exact.has(name)) continue;
      exact.set(name, stored);
      const lower = name.toLowerCase();
      // The index is in priority order, so the first spelling wins.
      if (!folded.has(lower)) folded.set(lower, name);
    }
  } catch {
    // A manifest that does not parse answers nothing: TeX then reports the
    // missing file, as it would without a library.
  }
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.put && typeof data.put === "object" && Object.hasOwn(data.put, INDEX))
    load(data.put[INDEX]);
  else if (Array.isArray(data.remove) && data.remove.includes(INDEX)) load(null);
});

globalThis.__mdraftTexmfLookup = (name) => exact.get(name) ?? null;
globalThis.__mdraftTexmfLookupNocase = (name) => folded.get(name.toLowerCase()) ?? null;
globalThis.__mdraftTexmfOverride = (name) => {
  if (reported.has(name)) return;
  reported.add(name);
  // The worker belongs to ocaml.js; a channel reaches the bridge in the page
  // without passing an unknown message through the application's own handler.
  try {
    channel ??= new BroadcastChannel("mdraft-texmf");
    channel.postMessage({ type: "override", name });
  } catch {
    /* a notice is not worth failing a lookup for */
  }
};

// The data base is same-origin, so config.js needs no global set first.
const { BUNDLES, DEFAULT_BUNDLE } = await import("./config.js");
await import("./ocaml-worker.js");
globalThis.texpresso_ocaml.worker.main(BUNDLES, DEFAULT_BUNDLE);
