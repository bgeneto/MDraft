//! The project MDraft hands to the TeXpresso frame, decoded from a snapshot.
//!
//! Pure: no DOM, no IPC, no timers, so `scripts/texpresso-unit.mjs` imports it
//! directly (the type stripper refuses the parameter properties the session
//! class uses). The session owns the frame and the protocol; this file owns what
//! the frame's copies of the reader's files are.

import type * as api from "../api";
import { textHash } from "./protocol.ts";

/** A project text file, by extension or by a declared non-UTF-8 encoding. */
const TEXT = /\.(?:tex|bib|sty|cls|bst|clo|def|cfg|lua|bbl|ltx|dtx|ins|txt)$/i;

/** What the frame holds for one file. */
export interface Held {
  fingerprint: string;
}

/** A snapshot decoded for the frame. */
export interface PreparedProject {
  main: string;
  files: Map<string, { text?: string; bytes?: Uint8Array; fingerprint: string }>;
  /** A project text file that is not UTF-8, or null. */
  nonUtf8: string | null;
  /** A local library file that cannot be placed at the project's root, or null. */
  libraryConflict: string | null;
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
 * A local TEXMF library is **not** flattened into the frame's project. Its
 * files are named by their basename there, and a library that ships an
 * `article.cls` or a `main.tex` would silently change the document or shadow
 * the project's own file. The frame also cannot be told a search path, so it
 * would never find the files under their library names either. The build
 * therefore reports the library by name and draws with WasmTex
 * (docs/architecture.md, open question 4).
 */
export function prepareProject(
  snapshot: api.LatexProjectSnapshot,
  currentText: (path: string) => string | null,
): PreparedProject {
  const files: PreparedProject["files"] = new Map();
  let nonUtf8: string | null = null;
  for (const file of snapshot.files) {
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
  const library = snapshot.texmf?.files?.[0]?.path ?? null;
  return {
    main: snapshot.mainFile,
    files,
    nonUtf8,
    libraryConflict: library === null ? null : (library.split("/").pop() ?? library),
  };
}
