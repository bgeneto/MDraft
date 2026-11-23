//! The project MDraft hands to the TeXpresso frame, decoded from a snapshot.
//!
//! Pure: no DOM, no IPC, no timers, so `scripts/texpresso-unit.mjs` imports it
//! directly (the type stripper refuses the parameter properties the session
//! class uses). The session owns the frame and the protocol; this file owns what
//! the frame's copies of the reader's files are.

import type * as api from "../api";
import { LIBRARY_PREFIX, reservedProjectPath } from "../latex-texmf.ts";
import { type FontFamilies, fontspecFiles } from "./fontspec-families.ts";
import { LIBRARY_INDEX, type LibraryIndex, libraryIndex } from "./library.ts";
import { LUAOTFLOAD_CONFIG, luaotfloadConfig } from "./luaotfload.ts";
import { type TexpressoEngine, textHash } from "./protocol.ts";

/** A project text file, by extension or by a declared non-UTF-8 encoding. */
const TEXT = /\.(?:tex|bib|sty|cls|bst|clo|def|cfg|lua|bbl|ltx|dtx|ins|txt)$/i;

/** Where a XeLaTeX project may name its fonts for fontspec. */
const FONT_SOURCES = /\.(?:tex|sty|cls|ltx)$/i;

/**
 * The `.fontspec` files an edited XeLaTeX source names, for a frame whose
 * project holds `taken`. The frame gets them before the edit: the engine never
 * looks again for a file it once missed, so a family typed live would stay
 * "cannot be found" until the next snapshot started a new frame.
 */
export function editedFontspecs(
  path: string,
  text: string,
  taken: Iterable<string>,
  fontFamilies: FontFamilies,
): Map<string, string> {
  return FONT_SOURCES.test(path) ? fontspecFiles([text], taken, fontFamilies) : new Map();
}

/** The special project file the frame's worker reads for on-demand names. */
export const PROJECT_INDEX = ".mdraft-project.json";

/** What the frame holds for one file. */
export interface Held {
  fingerprint: string;
}

/** A snapshot decoded for the frame. */
export interface PreparedProject {
  main: string;
  /** The capability the frame presents on its on-demand route. */
  projectToken: string;
  /** Names, sizes and stamps the frame may fetch on demand. */
  manifest: Map<string, { size: number; modified: number }>;
  files: Map<string, { text?: string; bytes?: Uint8Array; fingerprint: string }>;
  /** A project text file that is not UTF-8, or null. */
  nonUtf8: string | null;
  /** A project file inside the name reserved for local libraries, or null. */
  libraryConflict: string | null;
  /** Which library file answers each name, and what the project replaces. */
  library: LibraryIndex;
}

export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** MDraft's editor text: no byte-order mark, LF line ends. */
export function normaliseText(text: string): string {
  // A literal U+FEFF inside a regex is rejected by the linter, and the escape
  // was rewritten into the byte itself once; the code point comparison cannot
  // be mangled by an editor.
  const mark = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  return text.slice(mark).replace(/\r\n?/g, "\n");
}

export const textPrint = (text: string): string => `t${text.length}:${textHash(text)}`;
export const bytesPrint = (data: string): string => `b${data.length}:${textHash(data)}`;

/**
 * Decode a project snapshot for the frame. Text travels as LF-normalised
 * strings so offsets match the editor; images and fonts as bytes.
 *
 * A local TEXMF library is **not** flattened into the frame's project, where a
 * library `main.tex` would shadow the project's own file. Its files travel
 * under the reserved `.mdraft-texmf/<root>/<TDS path>` with a manifest of the
 * names they answer (library.ts); the frame's worker resolves a name the
 * project does not hold against it before TeX Live. Only a project file inside
 * that reserved prefix is a conflict.
 *
 * Under XeLaTeX, `fontFamilies` (fontspec-families.ts) adds a `.fontspec` file
 * for each TeX Live family the sources name; without it none is added.
 */
export function prepareProject(
  snapshot: api.LatexProjectSnapshot,
  currentText: (path: string) => string | null,
  engine: TexpressoEngine,
  fontFamilies: FontFamilies | null = null,
): PreparedProject {
  const files: PreparedProject["files"] = new Map();
  let nonUtf8: string | null = null;
  let libraryConflict: string | null = null;
  for (const file of snapshot.files) {
    if (reservedProjectPath(file.path)) {
      libraryConflict ??= file.path;
      continue;
    }
    const text = TEXT.test(file.path) || file.encoding !== undefined;
    if (!text) {
      files.set(file.path, { bytes: decodeBase64(file.data), fingerprint: bytesPrint(file.data) });
      continue;
    }
    if (file.encoding && file.encoding.toUpperCase() !== "UTF-8") {
      nonUtf8 ??= file.path;
      continue;
    }
    const live = currentText(file.path);
    let source: string;
    if (live !== null) source = live;
    else {
      try {
        source = normaliseText(
          new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64(file.data)),
        );
      } catch {
        nonUtf8 ??= file.path;
        continue;
      }
    }
    files.set(file.path, { text: source, fingerprint: textPrint(source) });
  }
  const fontConfig = luaotfloadConfig(engine, files.keys());
  if (fontConfig !== null) {
    files.set(LUAOTFLOAD_CONFIG, { text: fontConfig, fingerprint: textPrint(fontConfig) });
  }
  if (engine === "xetex" && fontFamilies) {
    const sources = [...files].flatMap(([path, file]) =>
      file.text !== undefined && FONT_SOURCES.test(path) ? [file.text] : [],
    );
    // A name the project fetches on demand, or a local library answers, is
    // the reader's own file and is never shadowed.
    const taken = [...files.keys(), ...snapshot.manifest.files.map((file) => file.path)];
    for (const file of snapshot.texmf?.files ?? []) {
      taken.push(file.path.slice(file.path.lastIndexOf("/") + 1));
      // A library style can set the fonts too.
      if (FONT_SOURCES.test(file.path)) {
        sources.push(new TextDecoder("utf-8").decode(decodeBase64(file.data)));
      }
    }
    for (const [path, text] of fontspecFiles(sources, taken, fontFamilies)) {
      files.set(path, { text, fingerprint: textPrint(text) });
    }
  }
  // The worker's membership table and capability. It is a project file so the
  // existing put/remove/ack protocol carries it; TeX never asks for the name.
  const project = JSON.stringify({
    version: 1,
    token: snapshot.projectToken,
    names: snapshot.manifest.files.map((file) => file.path),
  });
  files.set(PROJECT_INDEX, { text: project, fingerprint: textPrint(project) });
  const library = libraryIndex(snapshot.texmf, engine, new Set(files.keys()));
  if (snapshot.texmf?.files.length) {
    for (const file of snapshot.texmf.files) {
      files.set(`${LIBRARY_PREFIX}/${file.root}/${file.path}`, {
        bytes: decodeBase64(file.data),
        fingerprint: bytesPrint(file.data),
      });
    }
    const manifest = JSON.stringify({ version: 1, names: library.names });
    files.set(LIBRARY_INDEX, { text: manifest, fingerprint: textPrint(manifest) });
  }
  return {
    main: snapshot.mainFile,
    projectToken: snapshot.projectToken,
    manifest: new Map(
      snapshot.manifest.files.map((file) => [
        file.path,
        { size: file.size, modified: file.modified },
      ]),
    ),
    files,
    nonUtf8,
    libraryConflict,
    library,
  };
}
