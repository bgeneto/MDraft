//! The messages between MDraft and the TeXpresso frame, protocol 1.
//!
//! The frame side is `src-tauri/texpresso-shell/mdraft-bridge.js`. Every message
//! carries the protocol version and a sequence number; replies name the sequence
//! they answer. Positions are UTF-16 offsets into LF-normalised text, or
//! fractional 1-based lines. Nothing here touches the DOM, so the validation is
//! unit-testable in Node.

export const PROTOCOL_VERSION = 1;

/** TeXpresso's two engines; it has no pdfTeX. */
export type TexpressoEngine = "luatex" | "xetex";

/** The frame payload: TeXpresso's JSPI app, or PhiTeX's single-thread app. */
export type TexpressoBackend = "texpresso" | "phitex";

export interface TexpressoTheme {
  dark: boolean;
  /** `--word-sync` and `--word-sync-peak`: the correspondence colours. */
  sync: string;
  peak: string;
  /** The page surface and the pane around it, as the PDF viewer paints them. */
  paper: string;
  pane: string;
}

export interface SyncFile {
  path: string;
  text?: string;
  /** Transferred, never copied. */
  bytes?: ArrayBuffer;
}

/** A change against the document before the edit: [from, to, insert]. */
export type EditChange = [number, number, string];

export type HostMessage =
  | { type: "init"; theme: TexpressoTheme; zoom: number; reference: number }
  | {
      type: "project";
      main: string;
      files: SyncFile[];
      remove: string[];
      /** The first sync: anything not in `files` goes. */
      replace: boolean;
      active: string | null;
      compile: boolean;
    }
  | { type: "edit"; file: string; base: number; changes: EditChange[] }
  | { type: "text"; file: string; text: string }
  | { type: "open"; file: string }
  | { type: "select"; file: string; from: number; to: number; blink: boolean }
  | { type: "clear" }
  /** Bring fractional `line` of `file` to `y` pixels below the frame's top. */
  | { type: "reveal"; file: string; line: number; y: number }
  /** The sync line is now `y` pixels below the frame's top; nothing scrolls. */
  | { type: "reference"; y: number }
  /** Bring 1-based `page` to the top of the frame; the frame reports the landing. */
  | { type: "page"; page: number }
  | { type: "zoom"; factor: number }
  | { type: "theme"; theme: TexpressoTheme }
  | { type: "export" }
  | { type: "dispose" };

/**
 * "exact": `from` maps back to the clicked point. "line": only its source line
 * is typeset there. "none": nothing was verified.
 */
export type ClickPrecision = "exact" | "line" | "none";

export interface TexpressoProblem {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  message: string;
}

/**
 * The engine gave up before the end of the document: the pages of the PDF it
 * came with stop there. `memory` when it ran out of memory (its WebAssembly
 * heap and its rollback record are bounded), `engine` for any other abandoned run. `pages`: how many the
 * frame drew.
 */
export interface EngineFailure {
  reason: "memory" | "engine";
  message: string;
  pages: number;
}

export type FrameMessage =
  | {
      type: "ready";
      engine: TexpressoEngine;
      jspi: boolean;
      missing: string[];
      /** Only the PhiTeX shell sends it; the pinned TeXpresso shell does not. */
      backend?: TexpressoBackend;
    }
  /** `length` is -1 when the frame cannot read the file back (not open). */
  | { type: "ack"; seq: number; file: string; length: number; hash: number }
  | { type: "status"; busy: boolean; problems: TexpressoProblem[] | null }
  | { type: "painted"; seq: number; done: boolean; pages: number }
  /**
   * The frame's page count changed after its paint was reported: a long
   * document keeps typesetting past the pause that ended the paint wait.
   */
  | { type: "pages"; pages: number }
  | {
      type: "viewport";
      scrollTop: number;
      /** The 1-based page at the top of the frame, or null before a page is laid out. */
      page: number | null;
      file: string | null;
      line: number | null;
      /** A host page jump asks for source sync just as a reader gesture does. */
      gesture: boolean;
    }
  | { type: "scrolled"; seq: number; scrollTop: number | null }
  /**
   * `y`: the clicked height below the frame's top, when the frame knows it.
   * `drag`: an update while the button is still down; nothing may scroll.
   * `precision`: how far the frame verified a single click against the pixel
   * that was clicked (see `resolveClick` in mdraft-bridge.js).
   */
  | {
      type: "source";
      file: string | null;
      from: number;
      to: number;
      detail: number;
      y: number | null;
      drag: boolean;
      precision: ClickPrecision;
    }
  | { type: "input" }
  /**
   * A link to a URI the reader clicked on a page. It is the document's own
   * target, unvetted: the host decides whether it may leave the app.
   */
  | { type: "link"; uri: string }
  | { type: "key"; key: "Escape" }
  | { type: "zoom-wheel"; deltaY: number }
  /** `failure`: the export holds only what was typeset before the engine gave up. */
  | { type: "pdf"; seq: number; pdf: ArrayBuffer; ms: number; failure?: EngineFailure }
  | { type: "error"; seq?: number; message: string }
  | { type: "disposed"; seq: number }
  /** The engine loaded a local library file in place of TeX Live's `name`. */
  | { type: "library-override"; name: string }
  /** The engine fetched a project file the snapshot had not sent eagerly. */
  | { type: "project-fetched"; name: string }
  /** One line of the bridge's compile activity, for Logs. */
  | { type: "trace"; text: string };

/** FNV-1a over UTF-16 code units; the bridge computes the same. */
export function textHash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const num = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const int = (value: unknown): value is number => Number.isInteger(value);
const str = (value: unknown): value is string => typeof value === "string";
const nullable = <T>(value: unknown, test: (v: unknown) => v is T): value is T | null =>
  value === null || test(value);

function engineFailure(value: unknown): value is EngineFailure {
  return (
    isObject(value) &&
    (value.reason === "memory" || value.reason === "engine") &&
    str(value.message) &&
    value.message.length > 0 &&
    value.message.length <= 200 &&
    int(value.pages) &&
    value.pages >= 0
  );
}

function problem(value: unknown): value is TexpressoProblem {
  return (
    isObject(value) &&
    str(value.file) &&
    int(value.line) &&
    int(value.column) &&
    (value.severity === "error" || value.severity === "warning") &&
    str(value.message)
  );
}

/**
 * A message from the frame, or null when any field is missing or of the wrong
 * type. The frame is pinned code, but it renders the reader's documents: a
 * malformed message is dropped, never half-applied.
 */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (!isObject(data) || data.v !== PROTOCOL_VERSION || !str(data.type)) return null;
  const m = data;
  switch (m.type) {
    case "ready":
      return (m.engine === "luatex" || m.engine === "xetex") &&
        typeof m.jspi === "boolean" &&
        (m.backend === undefined || m.backend === "texpresso" || m.backend === "phitex") &&
        Array.isArray(m.missing) &&
        m.missing.every(str)
        ? {
            type: "ready",
            engine: m.engine,
            jspi: m.jspi,
            missing: m.missing,
            backend: m.backend as TexpressoBackend | undefined,
          }
        : null;
    case "ack":
      return int(m.seq) && str(m.file) && int(m.length) && int(m.hash)
        ? { type: "ack", seq: m.seq, file: m.file, length: m.length, hash: m.hash }
        : null;
    case "status":
      return typeof m.busy === "boolean" &&
        (m.problems === null || (Array.isArray(m.problems) && m.problems.every(problem)))
        ? { type: "status", busy: m.busy, problems: m.problems as TexpressoProblem[] | null }
        : null;
    case "painted":
      return int(m.seq) && typeof m.done === "boolean" && int(m.pages)
        ? { type: "painted", seq: m.seq, done: m.done, pages: m.pages }
        : null;
    case "pages":
      return int(m.pages) && m.pages >= 0 ? { type: "pages", pages: m.pages } : null;
    case "viewport": {
      // Older frames predate `page`; their reports stay usable without it.
      const page =
        m.page === undefined || m.page === null
          ? null
          : int(m.page) && m.page >= 1
            ? m.page
            : undefined;
      if (page === undefined) return null;
      return num(m.scrollTop) &&
        nullable(m.file, str) &&
        nullable(m.line, num) &&
        typeof m.gesture === "boolean"
        ? {
            type: "viewport",
            scrollTop: m.scrollTop,
            page,
            file: m.file,
            line: m.line,
            gesture: m.gesture,
          }
        : null;
    }
    case "scrolled":
      return int(m.seq) && nullable(m.scrollTop, num)
        ? { type: "scrolled", seq: m.seq, scrollTop: m.scrollTop }
        : null;
    case "source":
      return nullable(m.file, str) && int(m.from) && int(m.to) && m.to >= m.from && int(m.detail)
        ? {
            type: "source",
            file: m.file,
            from: m.from,
            to: m.to,
            detail: m.detail,
            y: num(m.y) ? m.y : null,
            drag: m.drag === true,
            precision: m.precision === "exact" || m.precision === "line" ? m.precision : "none",
          }
        : null;
    case "input":
      return { type: "input" };
    case "link":
      return str(m.uri) && m.uri.length > 0 && m.uri.length <= 8192
        ? { type: "link", uri: m.uri }
        : null;
    case "key":
      return m.key === "Escape" ? { type: "key", key: "Escape" } : null;
    case "zoom-wheel":
      return num(m.deltaY) ? { type: "zoom-wheel", deltaY: m.deltaY } : null;
    case "pdf":
      if (!int(m.seq) || !(m.pdf instanceof ArrayBuffer) || !num(m.ms)) return null;
      if (m.failure === undefined) return { type: "pdf", seq: m.seq, pdf: m.pdf, ms: m.ms };
      return engineFailure(m.failure)
        ? {
            type: "pdf",
            seq: m.seq,
            pdf: m.pdf,
            ms: m.ms,
            failure: {
              reason: m.failure.reason,
              message: m.failure.message,
              pages: m.failure.pages,
            },
          }
        : null;
    case "error":
      return str(m.message) && (m.seq === undefined || int(m.seq))
        ? { type: "error", seq: m.seq as number | undefined, message: m.message }
        : null;
    case "disposed":
      return int(m.seq) ? { type: "disposed", seq: m.seq } : null;
    case "library-override":
      return str(m.name) && m.name.length > 0 && m.name.length <= 1024
        ? { type: "library-override", name: m.name }
        : null;
    case "project-fetched":
      return str(m.name) && m.name.length > 0 && m.name.length <= 4096
        ? { type: "project-fetched", name: m.name }
        : null;
    case "trace":
      // Bounded: the text goes straight into the Logs panel.
      return str(m.text) && m.text.length <= 500 ? { type: "trace", text: m.text } : null;
    default:
      return null;
  }
}
