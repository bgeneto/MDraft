//! What a preview's output depends on, as one comparable value.
//!
//! The pane used to learn that it was out of date only as a side effect of a
//! render token: anything that called `scheduleRender` — a theme change, a save
//! of a buffer the preview already showed, a return to a chapter of the same
//! LaTeX project — rebuilt it, and a LaTeX rebuild is a whole compile. A key
//! names the inputs instead. Each function below takes exactly what its
//! language's output depends on and nothing else, so a value that is not an
//! input (theme, editor palette, content width, view mode) cannot reach a key
//! by accident: there is no parameter for it.
//!
//! Keys are plain strings: equal inputs give equal strings, and a key is only
//! ever compared with another key built by the same function. No DOM and no
//! timing state, so Node can test it.

/**
 * A 64-bit fingerprint of `text`, with its length.
 *
 * Two independent 32-bit FNV-1a passes (different offset bases) over the UTF-16
 * code units. A collision would show an older preview as current, so one 32-bit
 * hash was not enough; a cryptographic hash would put an async digest of the
 * whole buffer on every render. The length is part of the value, so the hashes
 * only ever separate texts of equal length.
 */
export function textFingerprint(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    a = Math.imul(a ^ unit, 0x01000193);
    b = Math.imul(b ^ unit, 0x01000193) ^ (b >>> 15);
  }
  return `${text.length}:${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

/** A document identity: a session at one incarnation. */
export interface DocumentIdentity {
  id: string;
  incarnation: number;
}

/**
 * Markdown and AsciiDoc.
 *
 * Keyed on the text rather than the revision: an edit that is undone before
 * the render runs leaves the output unchanged, and the revision counter would
 * still call it new. The word map is not part of the key — a render made for
 * Split carries one and serves Preview Only as well; the caller compares
 * `previewSyncReady` for the opposite direction.
 */
export function proseKey(
  language: "markdown" | "asciidoc",
  doc: DocumentIdentity,
  source: string,
  options: { baseDir: string | null; documentPath: string | null; math: boolean; mermaid: boolean },
): string {
  return JSON.stringify([
    language,
    doc.id,
    doc.incarnation,
    textFingerprint(source),
    options.baseDir,
    options.documentPath,
    options.math,
    options.mermaid,
  ]);
}

/** The HTML guest: the document, where it resolves from, and whether scripts run. */
export function htmlKey(
  doc: DocumentIdentity,
  source: string,
  options: { baseDir: string | null; name: string; scripts: boolean; roots: readonly string[] },
): string {
  return JSON.stringify([
    "html",
    doc.id,
    doc.incarnation,
    textFingerprint(source),
    options.baseDir,
    options.name,
    options.scripts,
    [...options.roots],
  ]);
}

/**
 * Typst.
 *
 * Unlike the others, the revision stays in the key. A `.typ` file can import
 * other files and images from disk, and nothing reports when those change, so
 * the counter is the conservative choice until the compiler's own dependency
 * list is fingerprinted (see the freshness plan's open question 1). The path
 * is an input: the compiler resolves imports and images against it, and a Save
 * As moves it without a new incarnation.
 */
export function typstKey(
  doc: DocumentIdentity & { revision: number; path: string | null },
  source: string,
  options: { mode: "document" | "pages"; imageRoot: string | null },
): string {
  return JSON.stringify([
    "typst",
    doc.id,
    doc.incarnation,
    doc.revision,
    doc.path,
    textFingerprint(source),
    options.mode,
    options.imageRoot,
  ]);
}

/** Which compiler produced a LaTeX PDF. A different engine is a different PDF. */
export interface LatexEngineIdentity {
  backend: string;
  nativeRoot: string | null;
  nativeDistribution: string | null;
  nativeEngine: string;
  nativeWsl: string | null;
  /** The bundled TeX engine (stage 6.2): a pdfLaTeX PDF is not a LuaLaTeX one. */
  bundledEngine?: string | null;
}

/**
 * LaTeX.
 *
 * `generation` comes from `latex_project_snapshot`: SHA-256 over the path and
 * content of every file the compile reads, with the open buffers overlaid, plus
 * the local library revision. It is the compile's input, so it is the key; the
 * revisions of the tabs are not, which is what lets a save of an already
 * compiled buffer, or an edit that was undone, skip the compile.
 */
export function latexKey(
  root: DocumentIdentity,
  generation: string,
  engine: LatexEngineIdentity,
): string {
  return JSON.stringify([
    "latex",
    root.id,
    root.incarnation,
    generation,
    engine.backend,
    engine.nativeRoot,
    engine.nativeDistribution,
    engine.nativeEngine,
    engine.nativeWsl,
    engine.bundledEngine ?? null,
  ]);
}
