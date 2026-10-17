//! The HTML preview guest.
//!
//! The document is not drawn in the application's DOM. It is served by the Rust
//! `mdraft-preview` scheme and loaded in a sandboxed iframe whose origin is
//! opaque. This module prepares the preview copy (line attributes and bridge),
//! owns the iframe, and speaks a small `postMessage` protocol with the bridge.
//!
//! Nothing here sanitises the document. Sanitising HTML would remove the very
//! scripts and styles that make it HTML. The security boundary is the sandbox
//! and the fact that the iframe's URL host is not a local Tauri origin; the
//! parent still treats every message as untrusted.

import * as api from "./api";
import bridgeTemplate from "./html-bridge.js?raw";

interface Anchor {
  line: number;
  top: number;
}

export interface HtmlLayout {
  anchors: Anchor[];
  top: number;
  height: number;
  client: number;
  line: number;
}

export interface HtmlAccelerator {
  id: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  keys: string[];
}

export interface HtmlPreviewCallbacks {
  onLine(line: number): void;
  onLink(href: string, raw: string): void;
  onAction(id: string): void;
  onScroll(layout: HtmlLayout): void;
  onReady(layout: HtmlLayout): void;
  onError(message: string): void;
}

export interface HtmlPreviewHandle {
  /** Start a new document: new nonce, new origin, no stale state. */
  reset(): void;
  render(source: string, root: string | null, filename: string, scripts: boolean): Promise<void>;
  dispose(): void;
  setAccelerators(list: HtmlAccelerator[]): void;
  scrollTo(top: number): void;
  scrollToLine(line: number): void;
  blink(line: number): void;
  layout(): HtmlLayout | null;
  anchors(): Anchor[];
  baseUrl(): string | null;
}

interface FrameState {
  frame: HTMLIFrameElement;
  token: string;
  generation: number;
  ready: boolean;
  timer: number;
}

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "audio",
  "blockquote",
  "canvas",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "img",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tr",
  "ul",
  "video",
]);

const SKIP_TAGS = new Set([
  "head",
  "script",
  "style",
  "textarea",
  "title",
  "template",
  "svg",
  "math",
  "noscript",
]);

function randomToken(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

let parse5Promise: Promise<typeof import("parse5")> | null = null;

function loadParse5(): Promise<typeof import("parse5")> {
  parse5Promise ??= import("parse5");
  return parse5Promise;
}

interface Insertion {
  at: number;
  text: string;
}

/**
 * Build the preview copy: line anchors and the bridge, spliced into the
 * original text.
 *
 * The document is never reserialised. A DOM round trip can normalise quotes,
 * escape text inside `<script>` and `<style>`, and reorder malformed markup; a
 * `parse5` tree only supplies source offsets for two small insertions.
 */
export async function buildHtmlPreview(
  source: string,
  token: string,
  bridgeNonce: string,
): Promise<string> {
  const { parse } = await loadParse5();
  const document: any = parse(source, { sourceCodeLocationInfo: true });
  const insertions: Insertion[] = [];

  const walk = (node: any): void => {
    if (!node) return;
    if (node.tagName && SKIP_TAGS.has(node.tagName)) return;

    if (node.tagName && BLOCK_TAGS.has(node.tagName)) {
      const location = node.sourceCodeLocation;
      const startTag = location?.startTag;
      if (startTag && Number.isFinite(startTag.endOffset)) {
        const raw = source.slice(startTag.startOffset, startTag.endOffset);
        if (!raw.includes("data-mdraft-line")) {
          let at = startTag.endOffset - 1;
          // Insert before the optional `/` of `<img />`, never after it.
          if (at > startTag.startOffset && source[at - 1] === "/") at -= 1;
          const line = location.startLine || startTag.startLine || 1;
          insertions.push({ at, text: ` data-mdraft-line="${line}"` });
        }
      }
    }

    if (Array.isArray(node.childNodes)) {
      for (const child of node.childNodes) walk(child);
    }
    if (node.content) walk(node.content);
  };
  walk(document);

  const bridge = bridgeMarkup(token, bridgeNonce);
  insertions.push({ at: bridgeInsertOffset(document, source), text: bridge });
  insertions.sort((left, right) => right.at - left.at);

  let output = source;
  for (const insertion of insertions) {
    output = output.slice(0, insertion.at) + insertion.text + output.slice(insertion.at);
  }
  return output;
}

function bridgeMarkup(token: string, nonce: string): string {
  const code = bridgeTemplate.replace('"__MDRAFT_TOKEN__"', JSON.stringify(token));
  return `<script nonce="${escapeAttribute(nonce)}">\n${code}\n</script>`;
}

function bridgeInsertOffset(document: any, source: string): number {
  const head = findElement(document, "head");
  if (head?.sourceCodeLocation?.startTag) {
    const start = head.sourceCodeLocation.startTag.endOffset;
    const first = Array.isArray(head.childNodes)
      ? head.childNodes.find((node: any) => node?.tagName)
      : null;
    if (
      first?.tagName === "meta" &&
      first.sourceCodeLocation?.endOffset &&
      isCharsetMeta(first)
    ) {
      return first.sourceCodeLocation.endOffset;
    }
    return start;
  }
  // No head: after a doctype when there is one, so quirks mode is preserved.
  const doctype = /^\s*<!doctype[^>]*>/i.exec(source);
  return doctype ? doctype.index + doctype[0].length : 0;
}

function isCharsetMeta(node: any): boolean {
  const attrs: Array<{ name: string; value: string }> = node.attrs ?? [];
  return attrs.some(
    (attr) =>
      attr.name.toLowerCase() === "charset" ||
      (attr.name.toLowerCase() === "http-equiv" &&
        attr.value.toLowerCase() === "content-type"),
  );
}

function findElement(node: any, tagName: string): any | null {
  if (!node) return null;
  if (node.tagName === tagName) return node;
  if (Array.isArray(node.childNodes)) {
    for (const child of node.childNodes) {
      const found = findElement(child, tagName);
      if (found) return found;
    }
  }
  if (node.content) return findElement(node.content, tagName);
  return null;
}

/**
 * The print copy of an HTML document.
 *
 * The system browser cannot reach the preview scheme, but it can read a
 * `file:///` base. The source itself is left alone apart from that base and a
 * print-on-load script; local CSS, images and classic scripts then resolve the
 * way they do in the editor. Local fonts or modules may still be subject to the
 * browser's file-origin rules.
 */
export async function buildHtmlPrintDocument(
  source: string,
  directory: string | null,
): Promise<string> {
  const { parse } = await loadParse5();
  const document: any = parse(source, { sourceCodeLocationInfo: true });
  const head = findElement(document, "head");
  const base = directory ? `<base href="${escapeAttribute(fileUrl(directory))}">` : "";
  const print =
    "<script>window.addEventListener('load',function(){setTimeout(function(){window.print()},250)})</script>";
  const headStart = head?.sourceCodeLocation?.startTag?.endOffset;
  const headMatch = /<head\b[^>]*>/i.exec(source);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(source);
  let insertAt: number;
  let prefix: string;
  if (Number.isFinite(headStart)) {
    insertAt = headStart;
    prefix = base + print;
  } else if (headMatch) {
    insertAt = headMatch.index + headMatch[0].length;
    prefix = base + print;
  } else {
    insertAt = doctype ? doctype.index + doctype[0].length : 0;
    prefix = `<head>${base}${print}</head>`;
  }
  return source.slice(0, insertAt) + prefix + source.slice(insertAt);
}

function fileUrl(directory: string): string {
  let path = directory.replace(/\\/g, "/").replace(/\/+$/, "");
  const unc = path.startsWith("//");
  if (!unc && (/^[A-Za-z]:/.test(path) || !path.startsWith("/"))) path = `/${path}`;
  const encoded = path
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ":"))
    .join("/");
  return `${unc ? "file:" : "file://"}${encoded}/`;
}

/**
 * The live iframe controller.
 *
 * A render builds a new frame next to the old one and promotes it only when the
 * bridge sends `ready`. The old frame stays visible until then, so typing does
 * not flash a blank preview.
 */
export function createHtmlPreview(
  host: HTMLElement,
  callbacks: HtmlPreviewCallbacks,
): HtmlPreviewHandle {
  let nonce = randomToken();
  let generation = 0;
  let active: FrameState | null = null;
  let pending: FrameState | null = null;
  let currentLayout: HtmlLayout | null = null;
  let accelerators: HtmlAccelerator[] = [];
  let guestBase: string | null = null;

  const onMessage = (event: MessageEvent) => {
    const data = event.data as
      | { __mdraft?: string; type?: string; [key: string]: unknown }
      | null;
    if (!data || typeof data !== "object") return;

    const frame =
      active && event.source === active.frame.contentWindow
        ? active
        : pending && event.source === pending.frame.contentWindow
          ? pending
          : null;
    if (!frame || data.__mdraft !== frame.token) return;

    if (data.type === "ready") {
      const layout = readLayout(data);
      if (!layout) return;
      currentLayout = layout;
      window.clearTimeout(frame.timer);
      frame.timer = 0;
      frame.ready = true;
      if (frame === pending) {
        const old = active;
        active = pending;
        pending = null;
        frame.frame.classList.remove("pending");
        frame.frame.classList.add("active");
        if (old) {
          window.clearTimeout(old.timer);
          old.frame.remove();
        }
      }
      postTo(frame, { type: "keys", list: accelerators });
      callbacks.onReady(layout);
      return;
    }

    if (!frame.ready) return;

    if (data.type === "layout") {
      const layout = readLayout(data);
      if (layout) currentLayout = layout;
      return;
    }
    if (data.type === "scroll") {
      const layout = readLayout(data);
      if (layout) {
        currentLayout = layout;
        callbacks.onScroll(layout);
      }
      return;
    }
    if (data.type === "line" && typeof data.line === "number") {
      callbacks.onLine(data.line);
      return;
    }
    if (data.type === "link" && typeof data.href === "string") {
      callbacks.onLink(data.href, typeof data.raw === "string" ? data.raw : data.href);
      return;
    }
    if (data.type === "action" && typeof data.id === "string") {
      callbacks.onAction(data.id);
    }
  };

  window.addEventListener("message", onMessage);

  function postTo(frame: FrameState, payload: Record<string, unknown>): void {
    try {
      frame.frame.contentWindow?.postMessage(
        { ...payload, __mdraft: frame.token },
        "*",
      );
    } catch {
      /* the frame is going away */
    }
  }

  function readLayout(data: Record<string, unknown>): HtmlLayout | null {
    const anchors = Array.isArray(data.anchors)
      ? data.anchors
          .filter(
            (entry): entry is Anchor =>
              !!entry &&
              typeof entry === "object" &&
              Number.isFinite((entry as Anchor).line) &&
              Number.isFinite((entry as Anchor).top),
          )
          .slice(0, 20000)
      : currentLayout?.anchors ?? [];
    const top = Number(data.top);
    const height = Number(data.height);
    const client = Number(data.client);
    const line = Number(data.line);
    return {
      anchors,
      top: Number.isFinite(top) ? top : 0,
      height: Number.isFinite(height) ? height : 0,
      client: Number.isFinite(client) ? client : 0,
      line: Number.isFinite(line) ? line : 1,
    };
  }

  function makeFrame(url: string, token: string): FrameState {
    const frame = document.createElement("iframe");
    frame.className = "html-preview-frame pending";
    frame.title = "HTML preview";
    frame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.src = `${url}?v=${generation}`;
    host.appendChild(frame);
    return { frame, token, generation, ready: false, timer: 0 };
  }

  function dropFrames(): void {
    window.clearTimeout(pending?.timer ?? 0);
    window.clearTimeout(active?.timer ?? 0);
    pending?.frame.remove();
    active?.frame.remove();
    pending = null;
    active = null;
    currentLayout = null;
  }

  return {
    reset() {
      // A new document gets a new nonce and fresh frames. Do not clear the
      // backend here: the next render overwrites it, and an asynchronous clear
      // racing that write would 404 the new document.
      dropFrames();
      nonce = randomToken();
      guestBase = null;
    },

    async render(source, root, filename, scripts) {
      generation += 1;
      const bridgeNonce = randomToken();
      const token = randomToken();
      let html: string;
      try {
        html = await buildHtmlPreview(source, token, bridgeNonce);
      } catch (error) {
        callbacks.onError(`Could not prepare the HTML preview: ${String(error)}`);
        return;
      }

      let url: string;
      try {
        url = (
          await api.setHtmlPreview({
            nonce,
            bridgeNonce,
            source: html,
            root,
            filename,
            scripts,
          })
        ).url;
      } catch (error) {
        callbacks.onError(`Could not start the HTML preview: ${String(error)}`);
        return;
      }

      const next = makeFrame(url, token);
      guestBase = url;
      // A newer render supersedes a frame that has not become ready yet.
      if (pending) {
        window.clearTimeout(pending.timer);
        pending.frame.remove();
      }
      next.timer = window.setTimeout(() => {
        if (pending !== next) return;
        pending = null;
        next.frame.remove();
        callbacks.onError("The HTML preview did not finish loading.");
      }, 12_000);
      pending = next;
    },

    dispose() {
      dropFrames();
      guestBase = null;
      void api.clearHtmlPreview().catch(() => {});
    },

    setAccelerators(list) {
      accelerators = list;
      if (active) postTo(active, { type: "keys", list });
      if (pending) postTo(pending, { type: "keys", list });
    },

    scrollTo(top) {
      if (active) postTo(active, { type: "scrollTo", top });
    },

    scrollToLine(line) {
      if (active) postTo(active, { type: "scrollToLine", line });
    },

    blink(line) {
      if (active) postTo(active, { type: "blink", line });
    },

    layout() {
      return currentLayout;
    },

    anchors() {
      return currentLayout?.anchors ?? [];
    },

    baseUrl() {
      return guestBase;
    },
  };
}
