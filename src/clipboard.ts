//! Clipboard access for the editor's context menu.
//!
//! The webview's Clipboard API comes first: it can carry HTML and images, and a
//! test can replace it. WebView2 gates `readText()` behind a permission the
//! application has no UI to request, so the official Tauri plugin is the
//! reliable fallback for plain text. Both paths are called from the menu's click
//! handler, which is the user gesture the web API requires.

import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

/** Write `text`, or report that both the web API and the plugin refused. */
export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the plugin */
  }
  try {
    await writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The clipboard as a paste payload, or null when every path failed or it held
 * nothing usable. The DataTransfer is what the editor's existing `paste`
 * handler reads, so rich conversion and image import keep working.
 */
export async function readClipboardData(): Promise<DataTransfer | null> {
  const rich = await readRichData();
  if (rich) return rich;
  const text = await readPlainText();
  if (text === null || text === "") return null;
  const data = new DataTransfer();
  data.setData("text/plain", text);
  return data;
}

async function readRichData(): Promise<DataTransfer | null> {
  try {
    if (!navigator.clipboard?.read) return null;
    const items = await navigator.clipboard.read();
    if (items.length === 0) return null;
    const data = new DataTransfer();
    for (const item of items) {
      for (const type of item.types) {
        const blob = await item.getType(type);
        if (type.startsWith("image/")) {
          const extension = type.slice("image/".length).replace("+xml", "") || "png";
          data.items.add(new File([blob], `pasted.${extension}`, { type }));
        } else {
          data.setData(type, await blob.text());
        }
      }
    }
    return data.items.length > 0 || data.types.length > 0 ? data : null;
  } catch {
    return null;
  }
}

async function readPlainText(): Promise<string | null> {
  try {
    if (navigator.clipboard?.readText) {
      const text = await navigator.clipboard.readText();
      if (text.length > 0) return text;
    }
  } catch {
    /* fall through to the plugin */
  }
  try {
    return await readText();
  } catch {
    return null;
  }
}
