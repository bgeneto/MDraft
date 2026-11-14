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
//   - project preparation: LF normalisation, non-UTF-8 detection and the
//     local-library name rule;
//   - the scroll and selection mapping.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_LATEX_PREVIEW_BACKEND,
  latexPreviewBackend,
  setLatexPreviewBackend,
  texpressoEngineFor,
  texpressoFallback,
  texpressoFallbackText,
} from "../src/latex-backend.ts";
import { parseFrameMessage, PROTOCOL_VERSION, textHash } from "../src/texpresso/protocol.ts";
import { normaliseText, prepareProject } from "../src/texpresso/project.ts";
import { editorLineAt, editorScrollFor } from "../src/texpresso/scroll.ts";
import { projectRelativePath, rangeForPreviewGesture } from "../src/texpresso/selection.ts";

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
    DEFAULT_LATEX_PREVIEW_BACKEND === "texpresso",
    "the default backend is the incremental preview",
    DEFAULT_LATEX_PREVIEW_BACKEND,
  );
  check(
    DEFAULT_LATEX_PREVIEW_BACKEND !== "texpresso" || config.origin.startsWith("https://"),
    "a release whose default is incremental serves over https, never loopback",
    config.origin,
  );

  const before = latexPreviewBackend();
  check(setLatexPreviewBackend("wasmtex") === true, "the hidden hook switches");
  check(setLatexPreviewBackend("wasmtex") === false, "switching to the same backend is a no-op");
  check(latexPreviewBackend() === "wasmtex", "the switch is remembered");
  setLatexPreviewBackend(before);

  check(texpressoEngineFor("lualatex") === "luatex", "LuaLaTeX maps to TeXpresso's luatex");
  check(texpressoEngineFor("xelatex") === "xetex", "XeLaTeX maps to TeXpresso's xetex");
  check(texpressoEngineFor("pdflatex") === null, "pdfLaTeX has no TeXpresso engine");

  const base = {
    backend: "bundled",
    engine: "lualatex",
    year: "2026",
    jspi: true,
    nonUtf8: null,
    libraryConflict: null,
    failed: false,
  };
  check(texpressoFallback(base) === null, "a healthy project draws with TeXpresso");
  // Precedence: an installed distribution wins over every other reason, and an
  // engine change is reported before a stale watchdog verdict.
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
    "a webview without JSPI is reported",
  );
  check(texpressoFallback({ ...base, failed: true }) === "failed", "a failed frame is reported");
  check(
    texpressoFallback({ ...base, nonUtf8: "chapters/legacy.tex" }) === "encoding",
    "a non-UTF-8 text file is reported",
  );
  check(
    texpressoFallback({ ...base, libraryConflict: "mystyle.sty" }) === "library",
    "a local library that cannot be placed is reported",
  );
  // The order between the two project-level reasons: failed is reported first.
  check(
    texpressoFallback({ ...base, failed: true, nonUtf8: "x.tex" }) === "failed",
    "a broken frame outranks a project-level reason",
  );

  const reasons = ["native", "year", "jspi", "encoding", "library", "failed"];
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
    { v: 1, type: "viewport", scrollTop: 12.5, file: "main.tex", line: 3.25, gesture: false },
    { v: 1, type: "scrolled", seq: 5, scrollTop: null },
    { v: 1, type: "source", file: null, from: 0, to: 0, detail: 1 },
    { v: 1, type: "input" },
    { v: 1, type: "key", key: "Escape" },
    { v: 1, type: "zoom-wheel", deltaY: -120 },
    { v: 1, type: "error", seq: 6, message: "boom" },
    { v: 1, type: "error", message: "boom" },
    { v: 1, type: "disposed", seq: 7 },
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
    { v: 1, type: "viewport", scrollTop: "12", file: null, line: null, gesture: false },
    { v: 1, type: "source", file: "main.tex", from: 5, to: 2, detail: 1 },
    { v: 1, type: "pdf", seq: 1, pdf: [1, 2], ms: 10 },
    { v: 1, type: "unknown" },
  ];
  for (const message of invalid) {
    check(
      parseFrameMessage(message) === null,
      `a malformed message is dropped: ${JSON.stringify(message)?.slice(0, 60)}`,
    );
  }
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
        { path: "tex/latex/local/mystyle.sty", data: encode("\\NeedsTeXFormat{LaTeX2e}") },
        {
          path: "tex/latex/local/main.tex",
          data: encode("a library file that would shadow the project"),
        },
      ],
    },
  };
  const prepared = prepareProject(snapshot, () => null);
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
    prepared.libraryConflict === "mystyle.sty",
    "a local TEXMF library is reported by name, not flattened into the project",
    String(prepared.libraryConflict),
  );
  check(
    !prepared.files.has("mystyle.sty") && !prepared.files.has("main.tex.library"),
    "no library file is placed in the frame's project",
  );
  check(
    prepared.files.get("main.tex")?.text?.startsWith("\\documentclass"),
    "the project's own file is untouched by a library of the same name",
  );
  check(
    prepareProject({ ...snapshot, texmf: undefined }, () => null).libraryConflict === null,
    "a project without a library has no library fallback",
  );

  const live = prepareProject(snapshot, (path) =>
    path === "chapters/one.tex" ? "live text" : null,
  );
  check(
    live.files.get("chapters/one.tex")?.text === "live text",
    "an open tab's unsaved buffer wins over the snapshot",
  );
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

  const source = "First paragraph here.\n\nSecond paragraph.\n";
  const word = rangeForPreviewGesture(source, 0, 5, 2);
  check(
    word?.from === 0 && word?.to === 5,
    "a double-click marks the word it names",
    JSON.stringify(word),
  );
  const paragraph = rangeForPreviewGesture(source, 3, 3, 1);
  check(
    paragraph !== null && paragraph.from <= 3 && paragraph.to >= 20,
    "a click marks the paragraph around the caret",
    JSON.stringify(paragraph),
  );
  check(
    rangeForPreviewGesture(source, 9999, 9999, 1) === null,
    "a position past the end marks nothing",
  );
  check(rangeForPreviewGesture("", 0, 0, 1) === null, "an empty document marks nothing");

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

const failed = checks.filter((ok) => !ok).length;
console.log(
  `\n${checks.length - failed}/${checks.length} checks passed${failed ? `, ${failed} failed` : ""} (TeXpresso unit)`,
);
process.exit(failed ? 1 : 0);
