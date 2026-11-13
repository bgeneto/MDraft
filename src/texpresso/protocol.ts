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
  | { type: "zoom"; factor: number }
  | { type: "theme"; theme: TexpressoTheme }
  | { type: "export" }
  | { type: "dispose" };

export interface TexpressoProblem {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  message: string;
}

export type FrameMessage =
  | { type: "ready"; engine: TexpressoEngine; jspi: boolean; missing: string[] }
  /** `length` is -1 when the frame cannot read the file back (not open). */
  | { type: "ack"; seq: number; file: string; length: number; hash: number }
  | { type: "status"; busy: boolean; problems: TexpressoProblem[] | null }
  | { type: "painted"; seq: number; done: boolean; pages: number }
  | {
      type: "viewport";
      scrollTop: number;
      file: string | null;
      line: number | null;
      gesture: boolean;
    }
  | { type: "scrolled"; seq: number; scrollTop: number | null }
  | { type: "source"; file: string | null; from: number; to: number; detail: number }
  | { type: "input" }
  | { type: "key"; key: "Escape" }
  | { type: "zoom-wheel"; deltaY: number }
  | { type: "pdf"; seq: number; pdf: ArrayBuffer; ms: number }
  | { type: "error"; seq?: number; message: string }
  | { type: "disposed"; seq: number };

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
        Array.isArray(m.missing) &&
        m.missing.every(str)
        ? { type: "ready", engine: m.engine, jspi: m.jspi, missing: m.missing }
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
    case "viewport":
      return num(m.scrollTop) &&
        nullable(m.file, str) &&
        nullable(m.line, num) &&
        typeof m.gesture === "boolean"
        ? {
            type: "viewport",
            scrollTop: m.scrollTop,
            file: m.file,
            line: m.line,
            gesture: m.gesture,
          }
        : null;
    case "scrolled":
      return int(m.seq) && nullable(m.scrollTop, num)
        ? { type: "scrolled", seq: m.seq, scrollTop: m.scrollTop }
        : null;
    case "source":
      return nullable(m.file, str) && int(m.from) && int(m.to) && m.to >= m.from && int(m.detail)
        ? { type: "source", file: m.file, from: m.from, to: m.to, detail: m.detail }
        : null;
    case "input":
      return { type: "input" };
    case "key":
      return m.key === "Escape" ? { type: "key", key: "Escape" } : null;
    case "zoom-wheel":
      return num(m.deltaY) ? { type: "zoom-wheel", deltaY: m.deltaY } : null;
    case "pdf":
      return int(m.seq) && m.pdf instanceof ArrayBuffer && num(m.ms)
        ? { type: "pdf", seq: m.seq, pdf: m.pdf, ms: m.ms }
        : null;
    case "error":
      return str(m.message) && (m.seq === undefined || int(m.seq))
        ? { type: "error", seq: m.seq as number | undefined, message: m.message }
        : null;
    case "disposed":
      return int(m.seq) ? { type: "disposed", seq: m.seq } : null;
    default:
      return null;
  }
}
