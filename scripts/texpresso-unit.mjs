// The TeXpresso backend's pure half (step 11 of
// docs/architecture.md).
//
//   node scripts/texpresso-unit.mjs
//
// Default layer `texpresso-unit`: no application, no DOM, no network. It pins
// what the CDP layer cannot reach cheaply and what must never regress:
//
//   - the default backend, and the rule that keeps a loopback origin out of a
//     release whose default is TeXpresso;
//   - the engine mapping and every fallback's precedence and sentence;
//   - the message validation the frame's bytes pass through;
//   - the hash both sides compute, so an acknowledgement means something;
//   - the pins in src-tauri/texpresso.json, and the absence of any TeXpresso
//     service host in shipped bytes;
//   - project preparation: LF normalisation, non-UTF-8 detection, and how
//     local libraries reach the frame (reserved folder, manifest, TeX Live's
//     per-engine search order, project files first);
//   - the scroll and selection mapping;
//   - the bounded wait an export uses before it asks the frame for a PDF.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  BUNDLED_TEXLIVE_YEAR,
  engineFailureHolds,
  engineFailureText,
  latexPreviewBackend,
  previewEngineFor,
  selectLatexPreviewBackend,
  texpressoEngineFor,
  texpressoFallback,
  texpressoFallbackText,
} from "../src/latex-backend.ts";
import { parseFrameMessage, PROTOCOL_VERSION, textHash } from "../src/texpresso/protocol.ts";
import { libraryIndex } from "../src/texpresso/library.ts";
import { normaliseText, prepareProject } from "../src/texpresso/project.ts";
import { editorLineAt, editorScrollFor } from "../src/texpresso/scroll.ts";
import {
  lineRangeAt,
  markForPreviewGesture,
  projectRelativePath,
} from "../src/texpresso/selection.ts";
import { waitUntil } from "../src/texpresso/wait.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");

const checks = [];
function check(ok, label, detail = "") {
  checks.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const config = JSON.parse(read("src-tauri/texpresso.json"));

// --- the backend and its fallback rules ---------------------------------------
{
  check(
    selectLatexPreviewBackend({ linux: false, jspi: false, phitex: true }) === "texpresso",
    "Windows/macOS keep TeXpresso even without JSPI",
  );
  check(
    selectLatexPreviewBackend({ linux: true, jspi: false, phitex: true }) === "phitex",
    "a Linux webview without JSPI selects the compatibility engine",
  );
  check(
    selectLatexPreviewBackend({ linux: true, jspi: true, phitex: true }) === "texpresso",
    "a Linux webview with JSPI keeps TeXpresso",
  );
  check(
    selectLatexPreviewBackend({ linux: true, jspi: false, phitex: false }) === "texpresso",
    "a webview without the compatibility engine keeps the honest TeXpresso fallback",
  );
  check(
    latexPreviewBackend() === "texpresso" || latexPreviewBackend() === "phitex",
    "a backend is selected",
  );
  check(
    latexPreviewBackend() !== "texpresso" || config.origin.startsWith("https://"),
    "a release whose default is incremental serves over https, never loopback",
    config.origin,
  );

  check(texpressoEngineFor("lualatex") === "luatex", "LuaLaTeX maps to TeXpresso's luatex");
  check(texpressoEngineFor("xelatex") === "xetex", "XeLaTeX maps to TeXpresso's xetex");
  check(texpressoEngineFor("pdflatex") === null, "pdfLaTeX has no TeXpresso engine");
  check(
    previewEngineFor("phitex", "xelatex") === "xetex",
    "PhiTeX's XeLaTeX maps to the xetex frame engine",
  );
  check(previewEngineFor("phitex", "lualatex") === null, "PhiTeX has no LuaLaTeX frame engine");

  const base = {
    backend: "bundled",
    preview: "texpresso",
    engine: "lualatex",
    year: BUNDLED_TEXLIVE_YEAR,
    jspi: true,
    phitex: true,
    nonUtf8: null,
    libraryConflict: null,
    failed: false,
  };
  check(texpressoFallback(base) === null, "a healthy project draws with TeXpresso");
  check(
    texpressoFallback({ ...base, backend: "native" }) === "native",
    "an installed TeX keeps its own compiler",
  );
  check(
    texpressoFallback({ ...base, backend: "none" }) === "native",
    "no engine backend means no frame",
  );
  check(
    texpressoFallback({ ...base, year: "2025" }) === "year",
    "an older TeX Live profile is reported",
  );
  check(
    texpressoFallback({ ...base, jspi: false }) === "jspi",
    "a TeXpresso webview without JSPI is reported",
  );
  check(
    texpressoFallback({ ...base, preview: "phitex", engine: "xelatex", jspi: false }) === null,
    "PhiTeX needs no JSPI",
  );
  check(
    texpressoFallback({ ...base, preview: "phitex", engine: "lualatex" }) === "lua",
    "PhiTeX names LuaLaTeX as unavailable",
  );
  check(
    texpressoFallback({ ...base, preview: "phitex", phitex: false }) === "jspi",
    "a webview without the compatibility engine is reported",
  );
  check(texpressoFallback({ ...base, failed: true }) === "failed", "a failed frame is reported");
  check(
    texpressoFallback({ ...base, nonUtf8: "chapters/legacy.tex" }) === "encoding",
    "a non-UTF-8 text file is reported",
  );
  check(
    texpressoFallback({ ...base, libraryConflict: ".mdraft-texmf/x.sty" }) === "library",
    "a project file in the reserved library folder is reported",
  );
  check(
    texpressoFallback({ ...base, failed: true, nonUtf8: "x.tex" }) === "failed",
    "a broken frame outranks a project-level reason",
  );

  const reasons = ["native", "year", "jspi", "lua", "encoding", "library", "failed"];
  const sentences = reasons.map((reason) =>
    texpressoFallbackText(reason, { file: "chapters/one.tex" }),
  );
  check(
    sentences.every((sentence) => sentence.length > 10 && !sentence.includes("undefined")),
    "every fallback has a sentence for the chip",
  );
  check(new Set(sentences).size === reasons.length, "no two fallbacks share a sentence");
  check(
    /chapters\/one\.tex/.test(texpressoFallbackText("encoding", { file: "chapters/one.tex" })),
    "a fallback names the file when it has one",
  );
}

// --- the protocol -------------------------------------------------------------
{
  check(PROTOCOL_VERSION === 1, "the protocol version is pinned");
  const hash = (text) => {
    let value = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      value ^= text.charCodeAt(i);
      value = Math.imul(value, 0x01000193);
    }
    return value >>> 0;
  };
  check(textHash("") === hash(""), "the empty string hashes to the FNV offset basis");
  check(textHash("mdraft") === hash("mdraft"), "the host and the bridge hash alike");
  check(textHash("a") !== textHash("b"), "different text hashes differently");
  check(Number.isInteger(textHash("x")) && textHash("x") >= 0, "the hash is an unsigned integer");

  const valid = [
    { v: 1, type: "ready", engine: "luatex", jspi: true, missing: [] },
    { v: 1, type: "ack", seq: 3, file: "main.tex", length: 10, hash: 7 },
    { v: 1, type: "status", busy: false, problems: null },
    {
      v: 1,
      type: "status",
      busy: true,
      problems: [
        {
          file: "main.tex",
          line: 2,
          column: 1,
          severity: "error",
          message: "Undefined control sequence",
        },
      ],
    },
    { v: 1, type: "painted", seq: 4, done: true, pages: 12 },
    {
      v: 1,
      type: "viewport",
      scrollTop: 12.5,
      page: 2,
      file: "main.tex",
      line: 3.25,
      gesture: false,
    },
    // A frame with no page laid out still reports its scroll position.
    { v: 1, type: "viewport", scrollTop: 0, page: null, file: null, line: null, gesture: true },
    { v: 1, type: "scrolled", seq: 5, scrollTop: null },
    // The page count after the paint, as a long document keeps typesetting.
    { v: 1, type: "pages", pages: 412 },
    { v: 1, type: "source", file: null, from: 0, to: 0, detail: 1 },
    {
      v: 1,
      type: "source",
      file: "a.tex",
      from: 4,
      to: 4,
      detail: 1,
      drag: false,
      precision: "exact",
    },
    { v: 1, type: "input" },
    { v: 1, type: "link", uri: "https://example.com/a?b=c" },
    // The protocol carries the document's target as it is; the host vets it.
    { v: 1, type: "link", uri: "javascript:void(0)" },
    { v: 1, type: "key", key: "Escape" },
    { v: 1, type: "zoom-wheel", deltaY: -120 },
    { v: 1, type: "error", seq: 6, message: "boom" },
    { v: 1, type: "error", message: "boom" },
    { v: 1, type: "disposed", seq: 7 },
    { v: 1, type: "library-override", name: "size10.clo" },
    { v: 1, type: "trace", text: "compile asked" },
  ];
  for (const message of valid) {
    check(parseFrameMessage(message) !== null, `a valid ${message.type} message parses`);
  }
  const invalid = [
    null,
    "ready",
    { v: 2, type: "ready", engine: "luatex", jspi: true, missing: [] },
    { type: "ready", engine: "luatex", jspi: true, missing: [] },
    { v: 1, type: "ready", engine: "pdftex", jspi: true, missing: [] },
    { v: 1, type: "ready", engine: "luatex", jspi: "yes", missing: [] },
    { v: 1, type: "ready", engine: "luatex", jspi: true, missing: [1] },
    { v: 1, type: "ack", seq: 1.5, file: "main.tex", length: 10, hash: 7 },
    { v: 1, type: "ack", seq: 1, file: "main.tex", length: 10 },
    { v: 1, type: "status", busy: false, problems: [{ file: "main.tex" }] },
    {
      v: 1,
      type: "status",
      busy: false,
      problems: [{ file: "m", line: 1, column: 1, severity: "info", message: "x" }],
    },
    { v: 1, type: "painted", seq: 1, done: true },
    { v: 1, type: "pages", pages: -1 },
    { v: 1, type: "pages", pages: "27" },
    { v: 1, type: "pages" },
    { v: 1, type: "viewport", scrollTop: "12", file: null, line: null, gesture: false },
    { v: 1, type: "viewport", scrollTop: 0, page: 0, file: null, line: null, gesture: false },
    { v: 1, type: "viewport", scrollTop: 0, page: 1.5, file: null, line: null, gesture: false },
    { v: 1, type: "viewport", scrollTop: 0, page: "2", file: null, line: null, gesture: false },
    { v: 1, type: "source", file: "main.tex", from: 5, to: 2, detail: 1 },
    { v: 1, type: "pdf", seq: 1, pdf: [1, 2], ms: 10 },
    { v: 1, type: "link" },
    { v: 1, type: "link", uri: "" },
    { v: 1, type: "link", uri: 7 },
    { v: 1, type: "link", uri: `https://example.com/${"x".repeat(8192)}` },
    { v: 1, type: "library-override", name: "" },
    { v: 1, type: "library-override", name: 7 },
    { v: 1, type: "trace", text: 7 },
    { v: 1, type: "trace", text: "x".repeat(501) },
    { v: 1, type: "unknown" },
  ];
  for (const message of invalid) {
    check(
      parseFrameMessage(message) === null,
      `a malformed message is dropped: ${JSON.stringify(message)?.slice(0, 60)}`,
    );
  }
  const pageViewport = parseFrameMessage(valid.find((message) => message.page === 2));
  check(
    pageViewport?.type === "viewport" && pageViewport.page === 2,
    "a viewport page number survives the frame boundary",
  );
  const legacyViewport = parseFrameMessage({
    v: 1,
    type: "viewport",
    scrollTop: 1,
    file: null,
    line: null,
    gesture: false,
  });
  check(
    legacyViewport?.type === "viewport" && legacyViewport.page === null,
    "a viewport from before the page field parses without it",
  );
}

// --- an export the engine abandoned -------------------------------------------
{
  const pdf = (failure) => ({ v: 1, type: "pdf", seq: 9, pdf: new ArrayBuffer(4), ms: 3, failure });
  const memory = { reason: "memory", message: "The engine ran out of memory", pages: 218 };
  const plain = parseFrameMessage(pdf(undefined));
  check(
    plain?.type === "pdf" && plain.failure === undefined,
    "a pdf without a verdict is a finished export",
  );
  const failed = parseFrameMessage(pdf(memory));
  check(
    failed?.type === "pdf" &&
      failed.failure?.reason === "memory" &&
      failed.failure.pages === 218 &&
      failed.failure.message === memory.message,
    "a pdf carries the engine's failure verdict",
  );
  check(
    parseFrameMessage(pdf({ ...memory, extra: "<b>" }))?.failure?.extra === undefined,
    "only the verdict's known fields reach the host",
  );
  for (const failure of [
    null,
    { ...memory, reason: "oom" },
    { ...memory, message: "" },
    { ...memory, message: "x".repeat(201) },
    { ...memory, message: 7 },
    { ...memory, pages: -1 },
    { ...memory, pages: 1.5 },
    { reason: "engine", message: "stopped" },
  ]) {
    check(
      parseFrameMessage(pdf(failure)) === null,
      `a pdf with a malformed verdict is dropped whole: ${JSON.stringify(failure)?.slice(0, 50)}`,
    );
  }

  const oom = engineFailureText(memory);
  check(
    oom.status === "The preview engine ran out of memory after page 218.",
    "an out-of-memory stop names the last page in the status",
    oom.status,
  );
  check(
    /table of contents/.test(oom.detail) &&
      /memory is limited/.test(oom.detail) &&
      /installed TeX distribution/.test(oom.detail),
    "its detail says what is missing, why, and the way out",
  );
  check(
    /no longer start a build/.test(oom.detail) && /select Compile/.test(oom.detail),
    "its detail says edits wait for Compile",
  );
  check(
    engineFailureHolds(memory) &&
      !engineFailureHolds({ reason: "engine", message: "Worker crashed", pages: 3 }),
    "only running out of memory releases the frame and holds the project",
  );
  check(
    engineFailureText({ ...memory, pages: 0 }).status === "The preview engine ran out of memory.",
    "no page count is invented when the frame drew none",
  );
  const other = engineFailureText({ reason: "engine", message: "Worker crashed", pages: 3 });
  check(
    other.status === "The preview engine stopped after page 3: Worker crashed" &&
      /Recompile from scratch/.test(other.detail),
    "any other abandoned build quotes the engine and offers a fresh start",
    other.status,
  );
}

// --- the bridge's verdict and font tap ----------------------------------------
{
  const bridge = read("src-tauri/texpresso-shell/mdraft-bridge.js");
  // The app's status titles, captured from the pinned release (2026-11-17).
  const titles = {
    failed: "Failed after 55223 ms: The engine ran out of memory",
    done: "1 page(s) in 378 ms",
    errors: "1 page(s) in 378 ms, with errors: Undefined control sequence (line 5)",
    stopped:
      "Stopped after 369 ms: LaTeX Error: File `x.tex' not found. (line 5); waiting for an edit",
  };
  const verdict = /\/\^Failed after \[\^:\]\*: \(\[\\s\\S\]\+\)\$\//.test(bridge)
    ? /^Failed after [^:]*: ([\s\S]+)$/
    : null;
  check(verdict !== null, "the bridge reads the app's `Failed after …:` status title");
  check(
    verdict?.exec(titles.failed)?.[1] === "The engine ran out of memory" &&
      !verdict.test(titles.done) &&
      !verdict.test(titles.errors) &&
      !verdict.test(titles.stopped),
    "only an abandoned run is a failure; document errors and stops stay problems",
  );
  check(
    /\^renderer: missing \(font file\|native font\)/.test(bridge) &&
      /warn\.apply\(this, args\)/.test(bridge),
    "the bridge's console tap matches the renderer's missing-font lines and forwards every call",
  );
}

// --- the pins -----------------------------------------------------------------
{
  check(
    /^https:\/\//.test(config.origin) ||
      /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+\/$/.test(config.origin),
    "the origin is https or loopback http",
    config.origin,
  );
  check(config.origin.endsWith("/"), "the origin ends with / so paths concatenate");
  const pins = [...config.assets, config.bundle.list, ...config.bundle.files];
  check(pins.length >= 16, "the engine and the bundle metadata are pinned", `${pins.length} pins`);
  check(
    pins.every((pin) => /^[0-9a-f]{64}$/.test(pin.sha256)),
    "every pin is a full lowercase SHA-256",
  );
  check(
    pins.every((pin) => Number.isInteger(pin.bytes) && pin.bytes > 0),
    "every pin has a real byte count",
  );
  check(new Set(pins.map((pin) => pin.path)).size === pins.length, "no file is pinned twice");
  check(
    config.digests.entries * 16 === config.digests.bytes,
    "the digest table is 16 bytes per bundle file",
    `${config.digests.entries} entries, ${config.digests.bytes} bytes`,
  );
  const shell = readdirSync(join(root, "src-tauri", "texpresso-shell"));
  check(
    !config.assets.some((pin) => shell.includes(pin.path)),
    "no pinned engine file shadows a shell file",
  );
  check(
    shell.includes("index.html") &&
      shell.includes("mdraft-bridge.js") &&
      shell.includes("config.js"),
    "the shell ships the frame, the bridge and the configuration",
  );
  check(!shell.includes("sw.js"), "the service worker is not shipped");
}

// --- no host of TeXpresso's own -----------------------------------------------
{
  const offenders = [];
  const allowed = new Set(["docs/architecture.md"]);
  // Built from parts: this file is one of the shipped scripts the check scans,
  // and a literal host in its source would make it report itself.
  const HOST = ["texpresso", "app"].join("\\.");
  const pattern = new RegExp(HOST);
  const walk = (directory) => {
    for (const entry of readdirSync(join(root, directory))) {
      if (entry === "node_modules" || entry === "target" || entry === "dist") continue;
      const path = `${directory}/${entry}`;
      const stats = statSync(join(root, path));
      if (stats.isDirectory()) walk(path);
      else if (/\.(ts|js|mjs|json|html|css|md|rs|toml)$/.test(entry)) {
        const text = readFileSync(join(root, path), "utf8");
        if (pattern.test(text) && !allowed.has(path)) offenders.push(path);
      }
    }
  };
  for (const directory of ["src", "src-tauri/texpresso-shell", "scripts"]) walk(directory);
  check(
    offenders.length === 0,
    "no shipped file names the TeXpresso host as a URL",
    offenders.join(", "),
  );
  const shipped = ["src-tauri/texpresso.json", "src-tauri/texpresso-shell/config.js"].map(read);
  check(
    shipped.every((text) => !pattern.test(text)),
    "the configuration and the pins name no TeXpresso host",
  );
}

// --- project preparation ------------------------------------------------------
{
  check(normaliseText("a\r\nb\rc") === "a\nb\nc", "CRLF and CR become LF");
  const bom = String.fromCharCode(0xfeff);
  check(normaliseText(`${bom}text`) === "text", "a leading byte-order mark is removed");
  check(normaliseText("text") === "text", "plain text is unchanged");

  const encode = (text) => Buffer.from(text, "utf8").toString("base64");
  const snapshot = {
    mainFile: "main.tex",
    projectToken: "test-token",
    manifest: {
      version: 1,
      files: [
        { path: "main.tex", size: 60, modified: 0 },
        { path: "chapters/one.tex", size: 13, modified: 0 },
        { path: "figures/plot.png", size: 4, modified: 0 },
      ],
      digest: "test-digest",
    },
    files: [
      {
        path: "main.tex",
        data: encode("\\documentclass{article}\r\n\\begin{document}\r\nx\r\n\\end{document}\r\n"),
        language: "latex",
      },
      { path: "chapters/one.tex", data: encode("chapter text\r\n"), language: "latex" },
      {
        path: "figures/plot.png",
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
        language: "latex",
      },
      {
        path: "legacy.tex",
        data: Buffer.from([0xff, 0xfe, 0x41]).toString("base64"),
        encoding: "UTF-16LE",
        language: "latex",
      },
    ],
    texmf: {
      files: [
        {
          root: 0,
          path: "tex/latex/local/mystyle.sty",
          origin: "local/mystyle.sty",
          data: encode("\\NeedsTeXFormat{LaTeX2e}"),
        },
        {
          root: 0,
          path: "tex/latex/local/main.tex",
          origin: "local/main.tex",
          data: encode("a library file that would shadow the project"),
        },
      ],
    },
  };
  const prepared = prepareProject(snapshot, () => null, "luatex");
  check(prepared.main === "main.tex", "the main document comes from the snapshot");
  check(
    prepared.files.get("main.tex")?.text ===
      "\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n",
    "a text file reaches the frame LF-normalised",
  );
  check(
    prepared.files.get("figures/plot.png")?.bytes?.length === 4,
    "a binary file travels as bytes",
  );
  check(
    prepared.nonUtf8 === null || prepared.nonUtf8 === "legacy.tex",
    "a declared non-UTF-8 file is reported",
  );
  check(!prepared.files.has("legacy.tex"), "a non-UTF-8 text file is not sent as UTF-8");
  check(
    prepared.libraryConflict === null,
    "a local TEXMF library is not a conflict",
    String(prepared.libraryConflict),
  );
  check(
    prepared.files.get(".mdraft-texmf/0/tex/latex/local/mystyle.sty")?.bytes?.length === 24,
    "a library file travels as bytes under the reserved prefix",
  );
  check(
    !prepared.files.has("mystyle.sty") && !prepared.files.has("tex/latex/local/mystyle.sty"),
    "no library file is flattened into the project's own names",
  );
  check(
    prepareProject(
      {
        ...snapshot,
        files: [...snapshot.files, { path: ".mdraft-texmf/notes.txt", data: encode("x") }],
      },
      () => null,
      "luatex",
    ).libraryConflict === ".mdraft-texmf/notes.txt",
    "a project file inside the reserved prefix is reported as a conflict",
  );
  check(
    prepared.files.get("main.tex")?.text?.startsWith("\\documentclass"),
    "the project's own file is untouched by a library of the same name",
  );
  const onDemand = JSON.parse(prepared.files.get(".mdraft-project.json")?.text ?? "null");
  check(
    onDemand?.version === 1 &&
      onDemand.token === "test-token" &&
      onDemand.names.includes("main.tex") &&
      onDemand.names.includes("figures/plot.png"),
    "the project manifest reaches the frame with its capability",
    JSON.stringify(onDemand),
  );
  const manifest = JSON.parse(prepared.files.get(".mdraft-texmf/index.json")?.text ?? "null");
  const answers = new Map(manifest?.names ?? []);
  check(
    manifest?.version === 1 &&
      answers.get("mystyle.sty") === ".mdraft-texmf/0/tex/latex/local/mystyle.sty" &&
      answers.get("local/mystyle.sty") === ".mdraft-texmf/0/tex/latex/local/mystyle.sty",
    "the manifest answers a library name and its path below tex/<format>/",
    JSON.stringify(manifest),
  );
  check(
    !answers.has("main.tex") &&
      prepared.library.shadowed.length === 1 &&
      prepared.library.shadowed[0].name === "main.tex" &&
      prepared.library.shadowed[0].origin === "local/main.tex",
    "a name the project holds is left to the project and reported",
    JSON.stringify(prepared.library.shadowed),
  );
  const bare = prepareProject({ ...snapshot, texmf: undefined }, () => null, "luatex");
  check(
    bare.libraryConflict === null && !bare.files.has(".mdraft-texmf/index.json"),
    "a project without a library has no library fallback and no manifest",
  );

  const live = prepareProject(
    snapshot,
    (path) => (path === "chapters/one.tex" ? "live text" : null),
    "luatex",
  );
  check(
    live.files.get("chapters/one.tex")?.text === "live text",
    "an open tab's unsaved buffer wins over the snapshot",
  );

  // A missing font must not make luaotfload rebuild its index from every
  // bundle font (2026-11-15: ~1 GB per compile for one missing font).
  const conf = prepared.files.get("luaotfload.conf")?.text ?? "";
  check(
    /^\[db\]$/m.test(conf) && /^update-live = false$/m.test(conf),
    "a LuaLaTeX project turns luaotfload's live font-index rebuild off",
  );
  check(
    !prepareProject(snapshot, () => null, "xetex").files.has("luaotfload.conf"),
    "a XeLaTeX project gets no luaotfload configuration",
  );
  const own = prepareProject(
    {
      ...snapshot,
      files: [...snapshot.files, { path: "luaotfloadrc", data: encode("[run]\nlog-level = 1\n") }],
    },
    () => null,
    "luatex",
  );
  check(
    !own.files.has("luaotfload.conf") && own.files.has("luaotfloadrc"),
    "a project's own luaotfload configuration is kept and not overridden",
  );
}

// --- the local library index ----------------------------------------------------
{
  const file = (root, path) => ({ root, path, origin: `r${root}:${path}`, data: "" });
  const snapshot = {
    revision: "r",
    roots: [],
    files: [
      file(0, "tex/latex/pkg/foo.sty"),
      file(0, "tex/lualatex/pkg/foo.sty"),
      file(0, "tex/xelatex/pkg/foo.sty"),
      file(0, "tex/generic/both/two.sty"),
      file(0, "tex/lualatex/both/two.sty"),
      file(0, "tex/plain/misc/three.tex"),
      file(0, "tex/generic/misc/three.tex"),
      file(1, "tex/lualatex/x/bar.sty"),
      file(0, "tex/generic/x/bar.sty"),
      file(0, "tex/latex/mod/mod.lua"),
      file(0, "scripts/mod/mod.lua"),
      file(0, "fonts/opentype/vendor/Fam-Regular.otf"),
      file(0, "bibtex/bst/abntex/abnt-alf.bst"),
      file(0, "tex/latex/abntex/abnt.cls"),
      file(0, "tex/latex/a/Case.sty"),
      file(1, "tex/latex/b/case.sty"),
    ],
  };
  const lua = libraryIndex(snapshot, "luatex", new Set());
  const xe = libraryIndex(snapshot, "xetex", new Set());
  const answer = (index, name) => new Map(index.names).get(name);
  check(
    answer(lua, "foo.sty") === ".mdraft-texmf/0/tex/lualatex/pkg/foo.sty" &&
      answer(xe, "foo.sty") === ".mdraft-texmf/0/tex/xelatex/pkg/foo.sty",
    "each engine finds its own format directory before tex/latex",
  );
  check(
    answer(lua, "two.sty") === ".mdraft-texmf/0/tex/lualatex/both/two.sty" &&
      answer(xe, "two.sty") === ".mdraft-texmf/0/tex/generic/both/two.sty",
    "another engine's format directory comes after tex/generic",
  );
  check(
    answer(lua, "three.tex") === ".mdraft-texmf/0/tex/generic/misc/three.tex",
    "a directory outside the engine's formats is searched last",
  );
  check(
    answer(lua, "bar.sty") === ".mdraft-texmf/0/tex/generic/x/bar.sty",
    "an earlier root wins over a later one whatever the directory",
  );
  check(
    answer(lua, "mod.lua") === ".mdraft-texmf/0/scripts/mod/mod.lua",
    "a Lua file follows LUAINPUTS: scripts/ first",
  );
  check(
    answer(lua, "Fam-Regular.otf") === ".mdraft-texmf/0/fonts/opentype/vendor/Fam-Regular.otf" &&
      !answer(lua, "vendor/Fam-Regular.otf") &&
      answer(lua, "abnt-alf.bst") === ".mdraft-texmf/0/bibtex/bst/abntex/abnt-alf.bst",
    "fonts and BibTeX files answer their file name only",
  );
  check(
    answer(lua, "abnt.cls") === answer(lua, "abntex/abnt.cls") &&
      answer(lua, "latex/abntex/abnt.cls") === ".mdraft-texmf/0/tex/latex/abntex/abnt.cls",
    "a class answers its name and every path below tex/",
  );
  const order = lua.names.map(([name]) => name);
  check(
    order.indexOf("Case.sty") >= 0 && order.indexOf("Case.sty") < order.indexOf("case.sty"),
    "the manifest lists higher priority first, so a case-folded match takes the earlier root",
  );
  check(
    lua.origins.get("abnt.cls") === "r0:tex/latex/abntex/abnt.cls",
    "a name maps back to the reader's own file for messages",
  );
  const shadow = libraryIndex(snapshot, "luatex", new Set(["abnt.cls", "abntex/abnt.cls"]));
  check(
    !answer(shadow, "abnt.cls") &&
      !answer(shadow, "abntex/abnt.cls") &&
      shadow.shadowed.length === 1 &&
      shadow.shadowed[0].name === "abnt.cls",
    "project files are left out of the manifest and a shadowed file is reported once",
    JSON.stringify(shadow.shadowed),
  );
  check(libraryIndex(undefined, "luatex", new Set()).names.length === 0, "no library, no names");
}

// --- scroll and selection mapping ---------------------------------------------
{
  const editor = {
    offsetAtScreenY: (y) => Math.max(0, (y - 100) * 2),
    lineOfOffset: (offset) => Math.floor(offset / 20) + 1,
    lineCount: () => 100,
    lineScrollTop: (line) => (line - 1) * 20,
    scrollTop: () => 0,
    scrollerTop: () => 100,
  };
  const line = editorLineAt(editor, 140);
  check(Math.abs(line - 5) < 0.001, "a viewport position maps to a fractional line", String(line));
  check(line >= 1 && line <= editor.lineCount(), "the line stays inside the document");
  const top = editorScrollFor(editor, line, 100);
  check(
    Math.abs(top - 80) < 0.001,
    "the fractional line maps back to a scroll offset",
    String(top),
  );
  check(
    editorLineAt({ ...editor, lineScrollTop: () => 0 }, 140) >= 1,
    "a degenerate layout still yields a line",
  );

  // 0         1         2         3         4         5         6
  // 0123456789012345678901234567890123456789012345678901234567890123
  const source = "First paragraph here,\n  wrapped onto two lines.\n\nSecond paragraph.\n";
  const word = markForPreviewGesture(source, 0, 5, 2);
  check(
    word?.range.from === 0 && word?.range.to === 5 && word?.caret === null,
    "a double-click marks the word it names and leaves the caret",
    JSON.stringify(word),
  );
  check(
    markForPreviewGesture(source, 3, 3, 2, "none") === null &&
      markForPreviewGesture(source, 31, 31, 2, "exact") === null,
    "a double-click without a word marks nothing, never its paragraph or line",
  );
  const exact = markForPreviewGesture(source, 31, 31, 1, "exact");
  check(
    exact?.unit === "line" &&
      source.slice(exact.range.from, exact.range.to) === "wrapped onto two lines." &&
      exact.caret === 31,
    "a verified click marks its source line and puts the caret on the character",
    JSON.stringify(exact),
  );
  const indent = markForPreviewGesture(source, 22, 22, 1, "exact");
  check(
    indent?.caret === 24,
    "a caret answered in the indentation moves to the line's first character",
    JSON.stringify(indent),
  );
  const byLine = markForPreviewGesture(source, 31, 31, 1, "line");
  check(
    byLine?.unit === "line" && byLine.caret === byLine.range.from && byLine.range.from === 24,
    "a click verified only by line puts the caret at the line's start",
    JSON.stringify(byLine),
  );
  const paragraph = markForPreviewGesture(source, 3, 3, 1, "none");
  check(
    paragraph?.unit === "paragraph" &&
      paragraph.range.from === 0 &&
      paragraph.range.to === 47 &&
      paragraph.caret === null,
    "an unverified click marks the paragraph and leaves the caret",
    JSON.stringify(paragraph),
  );
  const blank = markForPreviewGesture("One.\n   \nTwo.\n", 6, 6, 1, "exact");
  check(
    blank === null || blank.unit === "paragraph",
    "a click answered on a blank line never marks a line",
    JSON.stringify(blank),
  );
  const drag = markForPreviewGesture(source, 8, 18, 1);
  check(
    drag?.unit === "range" &&
      source.slice(drag.range.from, drag.range.to) === "paragraph here" &&
      drag.caret === null,
    "a drag marks the dragged range, widened to whole words",
    JSON.stringify(drag),
  );
  check(
    markForPreviewGesture(source, 9999, 9999, 1, "exact") === null,
    "a position past the end marks nothing",
  );
  check(markForPreviewGesture("", 0, 0, 1, "exact") === null, "an empty document marks nothing");
  const trimmed = lineRangeAt("a\n  bc  \nd", 5);
  check(
    trimmed.from === 4 && trimmed.to === 6,
    "a line range drops its blanks",
    JSON.stringify(trimmed),
  );

  const key = (path) => path.replace(/\\/g, "/").toLowerCase();
  check(
    projectRelativePath("C:\\project", "C:\\project\\chapters\\one.tex", key) ===
      "chapters/one.tex",
    "a project file becomes project-relative with forward slashes",
  );
  check(
    projectRelativePath("C:\\project", "C:\\elsewhere\\one.tex", key) === null,
    "a file outside the project has no relative path",
  );
  check(projectRelativePath("C:\\project", null, key) === null, "no path, no relative path");
}

// --- the wait before an export -------------------------------------------------
{
  // A clock that only moves when the wait sleeps: no real time, no DOM.
  const clock = () => {
    const state = { now: 0, sleeps: 0 };
    return {
      state,
      now: () => state.now,
      sleep: async (ms) => {
        state.now += ms;
        state.sleeps += 1;
      },
    };
  };
  const never = () => false;

  let c = clock();
  check(
    (await waitUntil(() => true, 1000, never, c.now, c.sleep)) === true && c.state.sleeps === 0,
    "a frame that is already idle adds no wait",
    `${c.state.sleeps} sleeps`,
  );

  c = clock();
  check(
    (await waitUntil(() => c.state.sleeps >= 3, 1000, never, c.now, c.sleep)) === true &&
      c.state.sleeps === 3,
    "the wait ends when the frame finishes typesetting",
    `${c.state.sleeps} sleeps`,
  );

  c = clock();
  check(
    (await waitUntil(never, 1000, () => c.state.sleeps >= 2, c.now, c.sleep)) === false &&
      c.state.sleeps === 2,
    "a broken or superseded wait ends without a result",
    `${c.state.sleeps} sleeps`,
  );

  c = clock();
  check(
    (await waitUntil(
      () => true,
      1000,
      () => true,
      c.now,
      c.sleep,
    )) === false,
    "a superseded wait does not export even when the frame is idle",
  );

  c = clock();
  check(
    (await waitUntil(never, 1000, never, c.now, c.sleep, 50)) === false && c.state.now === 1000,
    "the wait is bounded",
    `gave up at ${c.state.now} ms after ${c.state.sleeps} sleeps`,
  );
}

// Exercise the session's real export method with a fake frame, without a DOM.
// Node cannot strip the session's parameter properties, so transpile it using
// the project's existing TypeScript compiler and substitute only its frame.
{
  const moduleUrl = (name) => new URL(`../src/texpresso/${name}.ts`, import.meta.url).href;
  let source = ts.transpileModule(read("src/texpresso/session.ts"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const [name, url] of [
    ["frame", "data:text/javascript,export class TexpressoFrame {}"],
    ["project", moduleUrl("project")],
    ["protocol", moduleUrl("protocol")],
    ["wait", moduleUrl("wait")],
  ]) {
    source = source.replaceAll(`from "./${name}"`, `from "${url}"`);
  }
  const { TexpressoSession } = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );
  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout };
  try {
    const session = Object.assign(Object.create(TexpressoSession.prototype), {
      exports: 0,
      busy: true,
      broken: false,
      outstanding: new Map([[1, {}]]),
      whenReady: async () => true,
    });
    let requests = 0;
    session.request = async () => {
      requests += 1;
      return { type: "pdf", pdf: new Uint8Array([1]).buffer, ms: 1 };
    };
    const results = [session.exportPdf(), session.exportPdf(), session.exportPdf()];
    await new Promise((resolve) => setTimeout(resolve, 75));
    check(requests === 0, "no export is requested while the frame is busy");
    session.busy = false;
    await new Promise((resolve) => setTimeout(resolve, 75));
    check(requests === 0, "an unacknowledged change still blocks export after idle");
    session.outstanding.clear();
    const replies = await Promise.all(results);
    check(
      requests === 1 && replies[0] === null && replies[1] === null && replies[2]?.pdf[0] === 1,
      "only the latest waiting export requests a PDF",
      `${requests} request(s)`,
    );
    session.request = async () => ({ type: "error", message: "no page" });
    check((await session.exportPdf()) === null, "a frame that produces no PDF reports failure");
    session.busy = true;
    const interrupted = session.exportPdf();
    session.broken = true;
    check((await interrupted) === null, "a broken session releases its waiting export");

    // A file the worker fetched is not in the host's `files` map. A changed
    // stamp or a disappearance must therefore be an explicit remove, or the
    // worker keeps serving the old bytes forever.
    const sent = [];
    const invalidated = Object.assign(Object.create(TexpressoSession.prototype), {
      files: new Map(),
      dirty: new Set(),
      held: false,
      active: null,
      projectToken: "token",
      projectFetched: new Set(["changed.png", "gone.png", "same.png"]),
      fetchedStamps: new Map([
        ["changed.png", { size: 4, modified: 1 }],
        ["gone.png", { size: 4, modified: 1 }],
        ["same.png", { size: 4, modified: 1 }],
      ]),
      outstanding: new Map(),
      frame: { post: (message) => (sent.push(message), sent.length) },
    });
    invalidated.sendProject(
      {
        main: "main.tex",
        projectToken: "token",
        files: new Map(),
        manifest: new Map([
          ["changed.png", { size: 5, modified: 2 }],
          ["same.png", { size: 4, modified: 1 }],
        ]),
      },
      false,
    );
    const update = sent.find((message) => message.type === "project");
    check(
      update?.remove.includes("changed.png") &&
        update.remove.includes("gone.png") &&
        !update.remove.includes("same.png"),
      "a changed or vanished fetched file is removed for the next lookup",
      JSON.stringify(update?.remove),
    );
    check(
      !invalidated.projectFetched.has("changed.png") &&
        !invalidated.projectFetched.has("gone.png") &&
        invalidated.projectFetched.has("same.png"),
      "the fetched-file set forgets only what was invalidated",
    );
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

const failed = checks.filter((ok) => !ok).length;
console.log(
  `\n${checks.length - failed}/${checks.length} checks passed${failed ? `, ${failed} failed` : ""} (TeXpresso unit)`,
);
process.exit(failed ? 1 : 0);
