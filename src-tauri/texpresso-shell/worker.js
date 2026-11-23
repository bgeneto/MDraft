// Local TEXMF libraries. MDraft sends their files as project files under
// `.mdraft-texmf/<root>/<TDS path>`, plus `.mdraft-texmf/index.json`: which
// stored file answers each name TeX may ask for, highest priority first, in
// TeX Live's search order for this engine (src/texpresso/library.ts).
//
// The project's folders. MDraft sends `.mdraft-project.json` with the on-demand
// route capability and the listings it holds: the main file's folder and every
// folder an earlier build looked in, each without its subfolders' contents. A
// lookup the project table misses is answered from these listings before the
// libraries and the bundle, so a package or font name TeX tries in the project
// first costs no request. A folder below them is listed on demand, once, when
// TeX first names a file inside it; a name a complete listing rules out is
// never requested. A name that exists is fetched from the same origin and
// inserted into the project table, so the engine waits for it exactly as it
// waits for a bundle download. Nothing ever lists the project as a whole.
// A folder listed only in part (past its cap, or unreadable) cannot rule a
// name out, so a name the route did not find is remembered as missing until
// the index changes; a listing's digest covers every name in its folder, so a
// file added there changes the index.
//
// The app asks `texpresso_project_file(names)` for names its project misses
// and keeps the answer in the project table; it is defined below. The pinned
// ocaml-worker.js is patched (scripts/texpresso-patch-worker.mjs) to ask the
// other hooks for a name the project itself does not hold, before the TeX Live
// bundle (the export's xdvipdfmx reaches the case-insensitive ones through the
// patch's own fallback, since its WebAssembly never asks for them):
//   __mdraftProjectHas(name)        → false only when a listing rules the
//                                     name out; a name below a folder not
//                                     listed yet may exist, so it is asked;
//   __mdraftProjectHasNocase(name)  → the on-disk spelling from the listings,
//                                     or null;
//   __mdraftProjectFetch(name)      → a Promise<Uint8Array|null>;
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
const PROJECT_INDEX = ".mdraft-project.json";
let exact = new Map();
let folded = new Map();
const reported = new Set();
let channel = null;

/** The route capability, or null when no project is loaded. */
let project = null;
/**
 * Listed folders by project-relative path ("" is the main file's folder):
 * `names` maps each entry to whether it is a folder; `files`/`folders` map a
 * lower-cased name to its first on-disk spelling.
 */
let dirs = new Map();
/** Folder listings being fetched, so concurrent lookups share one request. */
let listing = new Map();
/** Names the route answered "not found" for since the index last changed. */
let missed = new Set();
const MISSED_MAX = 10_000;
let projectChannel = null;

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

function addListing(path, value) {
  if (typeof path !== "string" || !value || !Array.isArray(value.entries)) return;
  const names = new Map();
  const files = new Map();
  const folders = new Map();
  for (const entry of value.entries) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || entry[0].length === 0) continue;
    const folder = entry[1] === true;
    names.set(entry[0], folder);
    // Listings are sorted, so the first spelling wins, as it does on disk.
    const lower = entry[0].toLowerCase();
    const kind = folder ? folders : files;
    if (!kind.has(lower)) kind.set(lower, entry[0]);
  }
  dirs.set(path, { names, files, folders, complete: value.complete === true });
}

function loadProject(value) {
  project = null;
  dirs = new Map();
  listing = new Map();
  missed = new Set();
  if (value === null || value === undefined) return;
  try {
    const text = typeof value === "string" ? value : new TextDecoder().decode(value);
    const index = JSON.parse(text);
    if (index?.version !== 2 || typeof index.token !== "string") return;
    if (!index.dirs || typeof index.dirs !== "object") return;
    project = { token: index.token };
    for (const [path, entry] of Object.entries(index.dirs)) addListing(path, entry);
  } catch {
    // An index that does not parse answers nothing: TeX reports the missing
    // file rather than the worker guessing at a project path.
  }
}

/** The folders and the file name of a project-relative name, or null. */
function parts(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 4096) return null;
  if (name.startsWith("/") || name.includes("\\") || name.includes(":")) return null;
  const all = name.split("/");
  if (all.some((part) => part === "" || part === "." || part === "..")) return null;
  return { folders: all.slice(0, -1), file: all[all.length - 1] };
}

const join = (dir, name) => (dir ? `${dir}/${name}` : name);

/** The listed folder a name's folder resolves to, exactly or case-insensitively. */
function folderOf(split, nocase) {
  let dir = "";
  for (const folder of split.folders) {
    const known = dirs.get(dir);
    if (!known) return { dir, known: null };
    const next =
      known.names.get(folder) === true
        ? folder
        : nocase
          ? known.folders.get(folder.toLowerCase())
          : undefined;
    if (next === undefined) return { dir, known, missing: true };
    dir = join(dir, next);
  }
  return { dir, known: dirs.get(dir) ?? null };
}

/** "yes", "no", or "unknown" when a folder on the way is not listed in full. */
function lookup(name) {
  const split = parts(name);
  if (!split || missed.has(name)) return "no";
  const { known, missing } = folderOf(split, false);
  if (!known) return "unknown";
  if (missing) return known.complete ? "no" : "unknown";
  if (known.names.get(split.file) === false) return "yes";
  // A folder by that name is not a file TeX can open.
  return known.complete || known.names.has(split.file) ? "no" : "unknown";
}

/** List one folder through the route, once; false when it cannot be listed. */
function list(dir) {
  if (dirs.has(dir)) return Promise.resolve(true);
  if (project === null) return Promise.resolve(false);
  let pending = listing.get(dir);
  if (!pending) {
    const token = project.token;
    const relative = dir.split("/").map(encodeURIComponent).join("/");
    pending = fetch(`/project-dir/${token}/${relative}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((value) => {
        // A newer project replaced the listings while this one was in flight.
        if (project?.token !== token || !value) return false;
        addListing(dir, value);
        return true;
      })
      .catch(() => false)
      .finally(() => listing.delete(dir));
    listing.set(dir, pending);
  }
  return pending;
}

/**
 * List the folders on the way to `name`, following the exact spelling and,
 * failing that, the case-insensitive one: the exact lookup can then answer,
 * and so can the case-insensitive lookup the engine tries after every exact
 * source missed, which cannot wait for a request.
 */
async function listTowards(name) {
  const split = parts(name);
  if (!split) return;
  for (let depth = 0; depth <= split.folders.length; depth += 1) {
    const { dir, known, missing } = folderOf(split, true);
    if (missing) return;
    if (known) return; // every folder on the way is listed
    if (!(await list(dir))) return;
  }
}

function broadcast(message) {
  try {
    projectChannel ??= new BroadcastChannel("mdraft-project");
    projectChannel.postMessage(message);
  } catch {
    /* the engine already has its answer; only the host loses the notice */
  }
}

globalThis.__mdraftProjectHas = (name) => project !== null && lookup(name) !== "no";
globalThis.__mdraftProjectHasNocase = (name) => {
  const split = project === null ? null : parts(name);
  if (!split) return null;
  const { dir, known, missing } = folderOf(split, true);
  if (!known || missing) return null;
  const file =
    known.names.get(split.file) === false ? split.file : known.files.get(split.file.toLowerCase());
  return file === undefined ? null : join(dir, file);
};
globalThis.__mdraftProjectFetch = async (name) => {
  if (project === null || parts(name) === null) return null;
  const relative = name.split("/").map(encodeURIComponent).join("/");
  try {
    const response = await fetch(`/project/${project.token}/${relative}`);
    if (response.status === 403 || response.status === 413) {
      // The file exists and was not read: say why, by name, rather than let
      // TeX report a file it did not find.
      broadcast({ type: "refused", name, message: (await response.text()).slice(0, 500) });
      return null;
    }
    if (response.status === 404) {
      if (missed.size >= MISSED_MAX) missed.clear();
      missed.add(name);
      return null;
    }
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const stamp = response.headers.get("x-mdraft-stamp");
    broadcast({ type: "fetched", name, bytes, stamp });
    return bytes;
  } catch {
    return null;
  }
};

// The app's own on-demand hook: the first candidate the project holds, fetched.
globalThis.texpresso_project_file = async (names) => {
  for (const name of names) {
    if (project === null) return null;
    // List the folders on the way first, the case-insensitive spelling
    // included, so the engine's later case-insensitive fallback can answer.
    await listTowards(name);
    // Still unknown when a folder on the way cannot be listed in full: the
    // route answers for the file itself.
    if (lookup(name) === "no") continue;
    const data = await globalThis.__mdraftProjectFetch(name);
    if (data) return { path: name, data };
  }
  return null;
};

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.put && typeof data.put === "object") {
    if (Object.hasOwn(data.put, INDEX)) load(data.put[INDEX]);
    if (Object.hasOwn(data.put, PROJECT_INDEX)) loadProject(data.put[PROJECT_INDEX]);
  } else if (Array.isArray(data.remove)) {
    if (data.remove.includes(INDEX)) load(null);
    if (data.remove.includes(PROJECT_INDEX)) loadProject(null);
  }
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
