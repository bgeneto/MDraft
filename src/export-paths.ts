//! Where a local reference points when the document leaves MDraft.
//!
//! The preview rewrites local images to the application asset protocol and
//! removes anchor destinations; an exported file has neither. This module does
//! the path and URL arithmetic only, with no DOM and no Tauri, so the Windows
//! drive, UNC, POSIX, space and Unicode cases can all be checked in Node.

export interface PublicationTarget {
  /** Folder of the source document, used to resolve relative references. */
  documentDir: string | null;
  /** Folder of the exported file; null for a print document in the temp folder. */
  outputDir: string | null;
  /** Print documents need absolute file URLs; an exported page can stay relative. */
  absolute: boolean;
}

interface NormalizedPath {
  /** "", "/", "C:" or "//server/share". */
  root: string;
  segments: string[];
}

const DRIVE = /^([A-Za-z]):(?:[\\/]|$)/;
const UNC = /^\\\\([^\\/]+)\\([^\\/]+)(?:[\\/]|$)/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Split a query/fragment suffix from the path it belongs to. */
export function splitSuffix(value: string): { path: string; suffix: string } {
  const match = /^([^?#]*)([?#].*)?$/.exec(value);
  return { path: match?.[1] ?? value, suffix: match?.[2] ?? "" };
}

/**
 * True when the value names a local file rather than a URL or an in-page anchor.
 *
 * A Windows drive letter is not a URL scheme and must be tested first. A
 * protocol-relative `//host/path` is remote; a UNC path uses backslashes.
 */
export function isLocalReference(value: string): boolean {
  const v = value.trim();
  if (!v || v.startsWith("#")) return false;
  if (DRIVE.test(v) || v.startsWith("\\\\")) return true;
  if (v.startsWith("//")) return false;
  if (v.startsWith("/")) return true;
  if (SCHEME.test(v)) return v.toLowerCase().startsWith("file:");
  return true;
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A stray percent is a literal filename character, not an encoding error.
    return value;
  }
}

function normalize(path: string): NormalizedPath {
  let value = path.replace(/\\/g, "/");
  let root = "";

  const drive = DRIVE.exec(value);
  if (drive) {
    root = `${drive[1]}:`;
    value = value.slice(drive[0].length);
  } else {
    const unc = UNC.exec(path);
    const forwardUnc = /^\/\/([^/]+)\/([^/]+)(?:\/|$)/.exec(value);
    if (unc) {
      root = `//${unc[1]}/${unc[2]}`;
      value = path.replace(/\\/g, "/").slice(`//${unc[1]}/${unc[2]}`.length);
    } else if (forwardUnc) {
      root = `//${forwardUnc[1]}/${forwardUnc[2]}`;
      value = value.slice(forwardUnc[0].length);
    } else if (value.startsWith("/")) {
      root = "/";
      value = value.slice(1);
    }
  }

  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length && segments[segments.length - 1] !== "..") segments.pop();
      else if (!root) segments.push(segment);
      continue;
    }
    segments.push(segment);
  }
  return { root, segments };
}

function format(path: NormalizedPath): string {
  if (path.root === "/") return `/${path.segments.join("/")}`;
  if (path.root) return `${path.root}/${path.segments.join("/")}`.replace(/\/+$/, "");
  return path.segments.join("/");
}

/** Convert a `file://` URL to the local path it names. */
function fromFileUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    const decoded = decodeURIComponent(url.pathname);
    if (url.hostname) return `//${url.hostname}${decoded}`;
    // `/C:/x` is a Windows drive after the URL's leading slash.
    return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
  } catch {
    return null;
  }
}

/** Resolve a reference against the document folder, if it is relative. */
export function resolveLocalPath(reference: string, documentDir: string | null): string {
  const value = reference.startsWith("file:")
    ? (fromFileUrl(reference) ?? reference)
    : decodePath(reference);

  if (DRIVE.test(value) || value.startsWith("\\\\") || value.startsWith("/")) {
    return format(normalize(value));
  }
  if (!documentDir) return format(normalize(value));

  const base = normalize(documentDir);
  const relative = normalize(value);
  // Joining and re-normalising lets `..` cancel a base segment.
  const combined = normalize(`${format(base)}/${relative.segments.join("/")}`.replace(/\/+$/, ""));
  return format(combined);
}

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ":");
}

/** An absolute `file://` URL, encoded segment by segment. */
export function fileUrl(path: string): string {
  const normalized = normalize(path);
  if (normalized.root === "/") {
    return `file:///${normalized.segments.map(encodeSegment).join("/")}`;
  }
  if (normalized.root.startsWith("//")) {
    const [host, ...share] = normalized.root.slice(2).split("/");
    const parts = [...share, ...normalized.segments];
    return `file://${host}/${parts.map(encodeSegment).join("/")}`;
  }
  if (normalized.root) {
    return `file:///${normalized.root}/${normalized.segments.map(encodeSegment).join("/")}`;
  }
  return `file:///${normalized.segments.map(encodeSegment).join("/")}`;
}

function sameRoot(a: string, b: string): boolean {
  if (a === b) return true;
  return rootIsWindows(a) && a.toLowerCase() === b.toLowerCase();
}

function rootIsWindows(root: string): boolean {
  return Boolean(DRIVE.exec(root)) || root.startsWith("//");
}

/**
 * A URL from `fromDir` to `targetPath`, or null when they are on different
 * roots and no relative path exists.
 */
export function relativeUrl(fromDir: string, targetPath: string): string | null {
  const from = normalize(fromDir);
  const target = normalize(targetPath);
  if (!sameRoot(from.root, target.root)) return null;

  const fold = rootIsWindows(from.root);
  const compare = (value: string) => (fold ? value.toLowerCase() : value);
  const fromSegments = from.segments;
  const targetSegments = target.segments;
  let common = 0;
  while (
    common < fromSegments.length &&
    common < targetSegments.length &&
    compare(fromSegments[common]) === compare(targetSegments[common])
  ) {
    common += 1;
  }

  const parts = Array.from({ length: fromSegments.length - common }, () => "..");
  parts.push(...targetSegments.slice(common));
  return parts.length ? parts.map(encodeSegment).join("/") : ".";
}

/**
 * The URL a browser needs for a reference in an exported or printed document.
 *
 * Remote schemes, `data:`, `mailto:`, fragments and the application's `asset:`
 * protocol are returned untouched; only local references are resolved.
 */
export function publicationUrl(reference: string, target: PublicationTarget): string {
  const raw = reference.trim();
  if (!raw || raw.startsWith("#")) return raw;
  // A protocol-relative address belongs to a host, not to the local disk.
  if (raw.startsWith("//")) return raw;

  const isFile = raw.toLowerCase().startsWith("file:");
  if (!isFile) {
    if (DRIVE.test(raw)) {
      // A drive path is local; fall through to the path branch.
    } else if (SCHEME.test(raw)) {
      return raw;
    }
  }

  const { path, suffix } = splitSuffix(raw);
  if (!path) return raw;

  const resolved = resolveLocalPath(path, target.documentDir);
  const absolutePath =
    DRIVE.test(resolved) || resolved.startsWith("/") || resolved.startsWith("\\\\");
  // An untitled document has no folder to resolve against. Leaving the original
  // relative reference is the only honest answer; a broken link is visible.
  if (!absolutePath) return raw;

  const normalized = normalize(isFile ? (fromFileUrl(path) ?? resolved) : resolved);
  const absolute = format(normalized);
  if (target.absolute) return `${fileUrl(absolute)}${suffix}`;
  if (target.outputDir) {
    const relative = relativeUrl(target.outputDir, absolute);
    if (relative) return `${relative}${suffix}`;
  }
  return `${fileUrl(absolute)}${suffix}`;
}
