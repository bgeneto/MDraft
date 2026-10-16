//! Image import: clipboard bitmaps, pasted paths, pasted URLs and dropped files.
//!
//! Which of these are acted on is governed by the Preferences › Image section,
//! mirroring Typora's "apply above rules to local/online images" split:
//!
//! - a clipboard bitmap has no original location, so it is always saved;
//! - a pasted local path obeys `imageApplyLocal`;
//! - a pasted or dropped URL obeys `imageApplyOnline`.

import * as api from "./api";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif|ico|svg)$/i;

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

/** `https://…/x.png` or the `src` of a pasted `<img>` tag. */
export function onlineImageFromText(text: string): string | null {
  const direct = imageUrlFromText(text);
  if (direct) return direct;
  const tag = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(text);
  if (tag && /^https?:\/\//i.test(tag[1])) return tag[1];
  return null;
}

/** Text that names a file on disk, e.g. `C:\pics\a.png` or `./a.png`. */
export function localImageFromText(text: string): string | null {
  const trimmed = text.trim().replace(/^file:\/\//i, "");
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (!isImagePath(trimmed)) return null;
  return trimmed;
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
  documentPath: string | null;
  /** Put markdown at the caret. */
  insert(markdown: string): void;
  notify(message: string, isError?: boolean): void;
}

function altTextFrom(markdownPath: string): string {
  const name = markdownPath.split(/[\\/]/).pop() ?? "image";
  return name.replace(/\.[^.]+$/, "");
}

async function saveClipboard(blob: Blob, ctx: ImageContext): Promise<void> {
  const options = imageOptions(ctx.settings);
  if (options.rule === "keepOriginal") {
    // A clipboard bitmap has no original location to keep.
    options.rule = "assetsFolder";
    ctx.notify("Clipboard images have no original location; saved to the document's assets folder.");
  }

  const data = await blobToBase64(blob);
  const hint = `image-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const saved = await api.saveClipboardImage(data, hint, ctx.documentPath, options);
  ctx.insert(`![${altTextFrom(saved.markdownPath)}](${saved.markdownPath})`);
  ctx.notify(`Image saved to ${saved.markdownPath}`);
}

async function saveOnline(url: string, ctx: ImageContext): Promise<void> {
  const saved = await api.downloadImage(url, ctx.documentPath, imageOptions(ctx.settings));
  ctx.insert(`![${altTextFrom(saved.markdownPath)}](${saved.markdownPath})`);
  // With the keepOriginal rule the command performs no request at all.
  ctx.notify(
    saved.bytes === 0
      ? `Linked to ${saved.markdownPath}`
      : `Image downloaded to ${saved.markdownPath}`,
  );
}

async function saveLocal(path: string, ctx: ImageContext): Promise<void> {
  const saved = await api.importImage(path, ctx.documentPath, imageOptions(ctx.settings));
  ctx.insert(`![${altTextFrom(saved.markdownPath)}](${saved.markdownPath})`);
  ctx.notify(
    saved.source === "local" && saved.bytes === 0
      ? `Linked to ${saved.markdownPath}`
      : `Image copied to ${saved.markdownPath}`,
  );
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

  // 2. A URL, if online images are in scope.
  const url = onlineImageFromText(text);
  if (url) {
    if (!ctx.settings.imageApplyOnline) return false;
    void saveOnline(url, ctx).catch((error) => ctx.notify(String(error), true));
    return true;
  }

  // 3. A path to a file on disk, if local images are in scope.
  const local = localImageFromText(text);
  if (!local) return false;
  if (!ctx.settings.imageApplyLocal) return false;

  void api
    .pathExists(local)
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
export async function handleImageDrop(
  paths: string[],
  ctx: ImageContext,
): Promise<string[]> {
  const images = paths.filter(isImagePath);
  if (images.length === 0) return paths;
  if (!ctx.settings.imageApplyLocal) return paths.filter((p) => !isImagePath(p));

  const parts: string[] = [];
  for (const path of images) {
    try {
      const saved = await api.importImage(path, ctx.documentPath, imageOptions(ctx.settings));
      parts.push(`![${altTextFrom(saved.markdownPath)}](${saved.markdownPath})`);
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
