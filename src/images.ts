//! Image import: clipboard bitmaps, pasted paths, pasted URLs and dropped files.
//!
//! Which of these are acted on is governed by the Preferences › Image section,
//! mirroring Typora's "apply above rules to local/online images" split:
//!
//! - a clipboard bitmap has no original location, so it is always saved;
//! - a pasted local path obeys `imageApplyLocal`;
//! - a pasted or dropped URL obeys `imageApplyOnline`.
//!
//! A rule is applied only when it names a folder that exists without the
//! document. An untitled buffer has no folder, so the image keeps its original
//! address; an image with no address (a bitmap) is refused with a message
//! instead of being written into the process working directory.

import * as api from "./api";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif|ico|svg)$/i;

/** Typst reads these formats; anything else cannot be compiled. */
const TYPST_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

/** Mirrors `NO_DOCUMENT_FOLDER` in `src-tauri/src/images.rs`. */
const SAVE_FIRST =
  "This document has no folder yet. Save it first, or choose an absolute folder in Preferences › Image.";

const KEEP_ORIGINAL = "The image keeps its original location (Preferences › Image).";

/** Why an untitled document kept a remote or local address instead of copying. */
export const NO_FOLDER_KEPT =
  "This document has no folder yet, so the image kept its original address. Save the document to copy it.";

export function isImagePath(path: string): boolean {
  return IMAGE_EXT.test(path.split(/[?#]/)[0]);
}

export function imageOptions(settings: api.Settings): api.ImageOptions {
  const custom = settings.imageCustomDir?.trim();
  return {
    rule: settings.imageRule,
    customDir: custom ? custom : null,
    relative: settings.imageUseRelativePath,
    dotSlash: settings.imageAddDotSlash,
    escape: settings.imageAutoEscape,
  };
}

/**
 * True when the chosen rule names a folder that can be written without the
 * document being saved.
 *
 * A saved document always has its own folder. An untitled one only has the
 * absolute Custom Folder, and Typst/HTML cannot reach a local image there
 * because both resolve images against a root that only a saved document has.
 * `${filename}` needs the document's name, so it is not a destination either.
 */
export function hasImageDestination(
  language: api.DocumentLanguage,
  documentPath: string | null,
  rule: api.ImageRule,
  customDir: string | null | undefined,
): boolean {
  if (rule === "keepOriginal") return false;
  if (documentPath !== null) return true;
  if (language === "typst" || language === "html") return false;
  if (rule !== "custom") return false;
  const dir = customDir?.trim() ?? "";
  if (!dir || dir.includes("${filename}")) return false;
  return /^[A-Za-z]:[\\/]/.test(dir) || dir.startsWith("\\\\") || dir.startsWith("/");
}

/** The rule that will actually write, with a clipboard bitmap's fallback. */
function effectiveRule(ctx: ImageContext): api.ImageRule {
  return ctx.settings.imageRule === "keepOriginal" ? "assetsFolder" : ctx.settings.imageRule;
}

function writesToFolder(ctx: ImageContext): boolean {
  return hasImageDestination(
    ctx.language,
    ctx.documentPath,
    effectiveRule(ctx),
    ctx.settings.imageCustomDir,
  );
}

/** The extension of a reference, ignoring a query or fragment. */
function extensionOf(reference: string): string {
  const clean = reference.split(/[?#]/)[0];
  const base = clean.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function isAbsoluteReference(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("/");
}

function isInside(documentPath: string | null, reference: string): boolean {
  if (!documentPath || !isAbsoluteReference(reference)) return false;
  const dir = documentPath.replace(/[\\/][^\\/]*$/, "");
  const fold = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const base = fold(dir);
  const target = fold(reference);
  return target === base || target.startsWith(`${base}/`);
}

/**
 * Why Typst cannot display this reference, or null when it can.
 *
 * Typst reads a single `--root` and has no network access, so a URL and an
 * absolute path outside the document folder never compile. The format set is
 * Typst's own; AVIF in particular is decodable by the webview and not by the
 * compiler.
 */
export function typstImageProblem(
  language: api.DocumentLanguage,
  reference: string,
  documentPath: string | null,
): string | null {
  if (language !== "typst") return null;
  if (/^data:/i.test(reference)) {
    return "Typst cannot display an image embedded as a data URI. Save the image as a file and reference it instead.";
  }
  if (/^https?:/i.test(reference)) {
    return "Typst cannot load an image from a URL. Choose a folder rule in Preferences › Image to download it.";
  }
  const extension = extensionOf(reference);
  if (extension && !TYPST_EXT.has(extension)) {
    return `Typst cannot display ${extension.toUpperCase()} images. Convert it to PNG, JPEG, GIF, WebP or SVG.`;
  }
  if (isAbsoluteReference(reference) && !isInside(documentPath, reference)) {
    return "Typst can only read an image inside the document's folder. Save it there, or choose a folder rule in Preferences › Image.";
  }
  return null;
}

/** True when the text is a bare URL whose path looks like an image. */
function imageUrlFromText(text: string): string | null {
  const trimmed = text.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (IMAGE_EXT.test(parsed.pathname)) return trimmed;
    if (/[?&](format|ext|type)=(png|jpe?g|gif|webp|avif)/i.test(parsed.search)) return trimmed;
  } catch {
    return null;
  }
  return null;
}

function stripBrackets(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed.slice(1, -1).trim();
  return trimmed;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' || first === "'") && last === first) return trimmed.slice(1, -1);
  return trimmed;
}

/** `file:///C:/My%20Pictures/a.png` -> `C:/My Pictures/a.png`. */
function fileUrlToPath(value: string): string {
  try {
    const url = new URL(value);
    const path = decodeURIComponent(url.pathname);
    if (url.host) return `//${url.host}${path}`;
    return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
  } catch {
    return value.replace(/^file:\/\//i, "");
  }
}

/** `https://…/x.png`, the `src` of a pasted `<img>`, or a `data:` bitmap. */
export function onlineImageFromText(text: string): string | null {
  const direct = imageUrlFromText(stripBrackets(text));
  if (direct) return direct;
  const tag = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(text);
  if (tag && /^https?:\/\//i.test(tag[1])) return tag[1];
  return null;
}

/** A `data:image/…;base64,…` payload pasted as text. */
export function dataImageFromText(text: string): string | null {
  const value = stripBrackets(text);
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(value) ? value : null;
}

/** Text that names a file on disk, e.g. `C:\pics\a.png`, `"./a b.png"` or `file:///C:/a.png`. */
export function localImageFromText(text: string): string | null {
  let value = unquote(stripBrackets(text));
  if (/^file:\/\//i.test(value)) value = unquote(fileUrlToPath(value));
  if (!value || /[\r\n]/.test(value)) return null;
  if (!isImagePath(value)) return null;
  // A path may contain spaces. A sentence that happens to end in `.png` does
  // not contain a separator and does contain other words, so it is left to the
  // editor.
  if (/\s/.test(value) && !/[\\/]/.test(value)) return null;
  return value;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the clipboard image."));
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

export interface ImageContext {
  settings: api.Settings;
  /** The document's language, for the syntax and Typst's format limits. */
  language: api.DocumentLanguage;
  documentPath: string | null;
  /**
   * True when the paste lands on a non-empty editor selection. Such a paste is
   * an edit of the selected text (usually an image URL), not an insertion.
   */
  hasSelection: boolean;
  /** Put markdown at the caret. */
  insert(markdown: string): void;
  /**
   * Turn an imported image into the document's syntax.
   *
   * The default is Markdown's `![alt](path)`; the HTML preview passes a tag
   * builder so an image never turns into Markdown inside an HTML document.
   */
  imageSyntax?: (alt: string, src: string) => string;
  notify(message: string, isError?: boolean): void;
}

function altTextFrom(reference: string): string {
  const clean = reference.split(/[?#]/)[0];
  const name = clean.split(/[\\/]/).pop() ?? "image";
  return name.replace(/\.[^.]+$/, "");
}

function imageMarkup(ctx: ImageContext, alt: string, src: string): string {
  return ctx.imageSyntax ? ctx.imageSyntax(alt, src) : `![${alt}](${src})`;
}

/**
 * Insert a reference without copying it, or explain why the document's format
 * cannot display it. Used by keepOriginal and by the untitled fallback.
 */
function keepReference(ctx: ImageContext, reference: string, why: string): void {
  const problem = typstImageProblem(ctx.language, reference, ctx.documentPath);
  if (problem) {
    ctx.notify(problem, true);
    return;
  }
  ctx.insert(imageMarkup(ctx, altTextFrom(reference), reference));
  ctx.notify(why);
}

/** The insert for a saved file, refusing a format the destination cannot show. */
function insertSaved(ctx: ImageContext, saved: api.SavedImage, message: string): void {
  const problem = typstImageProblem(ctx.language, saved.markdownPath, ctx.documentPath);
  if (problem) {
    ctx.notify(`${problem} Saved to ${saved.markdownPath}.`, true);
    return;
  }
  ctx.insert(imageMarkup(ctx, altTextFrom(saved.markdownPath), saved.markdownPath));
  ctx.notify(message);
}

async function saveClipboardBase64(data: string, hint: string, ctx: ImageContext): Promise<void> {
  if (!writesToFolder(ctx)) {
    ctx.notify(SAVE_FIRST, true);
    return;
  }
  const options = imageOptions(ctx.settings);
  // A bitmap has no original location to keep; the rule that writes wins.
  if (options.rule === "keepOriginal") options.rule = "assetsFolder";
  const saved = await api.saveClipboardImage(data, hint, ctx.documentPath, options);
  insertSaved(
    ctx,
    saved,
    ctx.settings.imageRule === "keepOriginal"
      ? `Clipboard images have no original location; saved to ${saved.markdownPath}.`
      : `Image saved to ${saved.markdownPath}`,
  );
}

async function saveClipboard(blob: Blob, ctx: ImageContext): Promise<void> {
  const data = await blobToBase64(blob);
  const hint = `image-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  await saveClipboardBase64(data, hint, ctx);
}

/** A failed copy keeps the address, so the paste is not lost, and says why. */
function keepAfterFailure(ctx: ImageContext, reference: string, error: unknown): void {
  const problem = typstImageProblem(ctx.language, reference, ctx.documentPath);
  if (!problem) ctx.insert(imageMarkup(ctx, altTextFrom(reference), reference));
  ctx.notify(String(error), true);
}

async function saveOnline(url: string, ctx: ImageContext): Promise<void> {
  if (ctx.settings.imageRule === "keepOriginal") {
    keepReference(ctx, url, KEEP_ORIGINAL);
    return;
  }
  if (!writesToFolder(ctx)) {
    keepReference(ctx, url, SAVE_FIRST);
    return;
  }
  try {
    const saved = await api.downloadImage(url, ctx.documentPath, imageOptions(ctx.settings));
    insertSaved(ctx, saved, `Image downloaded to ${saved.markdownPath}`);
  } catch (error) {
    keepAfterFailure(ctx, url, error);
  }
}

async function saveLocal(path: string, ctx: ImageContext): Promise<void> {
  const keeping = ctx.settings.imageRule === "keepOriginal";
  if (!keeping && !writesToFolder(ctx)) {
    keepReference(ctx, path, SAVE_FIRST);
    return;
  }
  try {
    const saved = await api.importImage(path, ctx.documentPath, imageOptions(ctx.settings));
    if (saved.bytes === 0) {
      // keepOriginal. Rust has already made a path inside the document folder
      // relative, which is what Typst can read.
      keepReference(ctx, saved.markdownPath, keeping ? KEEP_ORIGINAL : SAVE_FIRST);
      return;
    }
    insertSaved(ctx, saved, `Image copied to ${saved.markdownPath}`);
  } catch (error) {
    keepAfterFailure(ctx, path, error);
  }
}

/**
 * Decide synchronously whether this paste is an image, so the caller can call
 * `preventDefault()` in the same turn — a decision deferred to a promise is too
 * late and the pasted text would also land in the buffer. The work itself
 * continues asynchronously.
 *
 * Returns true when the paste was consumed.
 */
export function handleImagePaste(event: ClipboardEvent, ctx: ImageContext): boolean {
  const clipboard = event.clipboardData;
  if (!clipboard) return false;

  // 1. Real image data on the clipboard.
  for (const item of Array.from(clipboard.items ?? [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const blob = item.getAsFile();
    if (!blob) continue;
    void saveClipboard(blob, ctx).catch((error) => ctx.notify(String(error), true));
    return true;
  }

  const text = clipboard.getData("text/plain");
  if (!text) return false;

  // A paste over a selection is an edit of that selection: typically the
  // `./image.png` placeholder or an existing image URL. Importing would append
  // a second block and leave the selected text in place, so let the editor
  // paste the text normally. Real image data above still wins: there is no
  // text to replace.
  if (ctx.hasSelection) return false;

  // 2. A data URI, if the clipboard carries one as text. Unlike a bitmap it
  // has a location of its own, so keepOriginal can honour it.
  const data = dataImageFromText(text);
  if (data) {
    if (ctx.settings.imageRule === "keepOriginal") {
      keepReference(ctx, data, KEEP_ORIGINAL);
      return true;
    }
    const hint = `image-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
    void saveClipboardBase64(data, hint, ctx).catch((error) => ctx.notify(String(error), true));
    return true;
  }

  // 3. A URL, if online images are in scope.
  const url = onlineImageFromText(text);
  if (url) {
    if (!ctx.settings.imageApplyOnline) return false;
    void saveOnline(url, ctx).catch((error) => ctx.notify(String(error), true));
    return true;
  }

  // 4. A path to a file on disk, if local images are in scope.
  const local = localImageFromText(text);
  if (!local) return false;
  if (!ctx.settings.imageApplyLocal) return false;

  void api
    .pathExists(local, ctx.documentPath)
    .catch(() => false)
    .then((exists) => {
      if (!exists) {
        // Not actually a file: put the text back rather than swallowing it.
        ctx.insert(text.trim());
        ctx.notify(`${local} was not found, so it was inserted as plain text.`);
        return;
      }
      return saveLocal(local, ctx);
    })
    .catch((error) => ctx.notify(String(error), true));
  return true;
}

/**
 * Import dropped files. Returns the paths that were NOT images, so the caller
 * can still open a dropped document.
 */
export async function handleImageDrop(paths: string[], ctx: ImageContext): Promise<string[]> {
  const images = paths.filter(isImagePath);
  if (images.length === 0) return paths;
  if (!ctx.settings.imageApplyLocal) return paths.filter((p) => !isImagePath(p));

  if (!writesToFolder(ctx) && ctx.settings.imageRule !== "keepOriginal") {
    ctx.notify(SAVE_FIRST, true);
    return paths.filter((p) => !isImagePath(p));
  }

  const parts: string[] = [];
  for (const path of images) {
    try {
      const saved = await api.importImage(path, ctx.documentPath, imageOptions(ctx.settings));
      if (saved.bytes === 0) {
        const problem = typstImageProblem(ctx.language, saved.markdownPath, ctx.documentPath);
        if (problem) {
          ctx.notify(problem, true);
          continue;
        }
        parts.push(imageMarkup(ctx, altTextFrom(saved.markdownPath), saved.markdownPath));
        continue;
      }
      const problem = typstImageProblem(ctx.language, saved.markdownPath, ctx.documentPath);
      if (problem) {
        ctx.notify(`${problem} Saved to ${saved.markdownPath}.`, true);
        continue;
      }
      parts.push(imageMarkup(ctx, altTextFrom(saved.markdownPath), saved.markdownPath));
    } catch (error) {
      ctx.notify(String(error), true);
    }
  }
  if (parts.length > 0) {
    ctx.insert(parts.join("\n"));
    ctx.notify(`${parts.length} image${parts.length === 1 ? "" : "s"} imported`);
  }
  return paths.filter((p) => !isImagePath(p));
}
