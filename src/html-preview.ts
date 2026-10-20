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
import {
  htmlSourceRange,
  type HtmlSelection,
  type HtmlTextFragment,
} from "./html-source-map";
import bridgeTemplate from "./html-bridge.js?raw";

export type { HtmlSelection, HtmlTextFragment } from "./html-source-map";

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
  onSelection(selection: HtmlSelection): void;
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
  /** Translate a guest selection through the table built with the preview. */
  wordRange(selection: HtmlSelection): { from: number; to: number } | null;
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
  /** The word table this frame's copy was built with. */
  fragments: HtmlTextFragment[];
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

export interface HtmlPreviewBuild {
  html: string;
  fragments: HtmlTextFragment[];
}

/**
 * Build the preview copy: line anchors, word-node ids and the bridge, spliced
 * into the original text.
 *
 * The document is never reserialised. A DOM round trip can normalise quotes,
 * escape text inside `<script>` and `<style>`, and reorder malformed markup; a
 * `parse5` tree only supplies source offsets for a few small insertions.
 *
 * Both attributes are preview-only. The text-node table is the host's answer to
 * an opaque iframe: the guest can name a text node by its position under a
 * stamped block, but it cannot see a source offset.
 */
export async function buildHtmlPreview(
  source: string,
  token: string,
  bridgeNonce: string,
): Promise<HtmlPreviewBuild> {
  const { parse } = await loadParse5();
  const document: any = parse(source, { sourceCodeLocationInfo: true });
  const insertions: Insertion[] = [];
  const fragments: HtmlTextFragment[] = [];
  const counts = new Map<number, number>();
  let nextStamp = 0;

  const walk = (node: any, stamp: number | null): void => {
    if (!node) return;

    if (node.nodeName === "#text") {
      if (stamp === null) return;
      const location = node.sourceCodeLocation;
      if (
        !location ||
        !Number.isFinite(location.startOffset) ||
        !Number.isFinite(location.endOffset)
      ) {
        return;
      }
      const raw = source.slice(location.startOffset, location.endOffset);
      const index = counts.get(stamp) ?? 0;
      counts.set(stamp, index + 1);
      fragments.push({
        n: stamp,
        index,
        src0: location.startOffset,
        src1: location.endOffset,
        raw,
        text: node.value ?? "",
      });
      return;
    }

    if (node.tagName && addsCrossOrigin(node)) {
      const startTag = node.sourceCodeLocation?.startTag;
      if (startTag && Number.isFinite(startTag.endOffset)) {
        let at = startTag.endOffset - 1;
        if (at > startTag.startOffset && source[at - 1] === "/") at -= 1;
        insertions.push({ at, text: ' crossorigin="anonymous"' });
      }
    }

    if (node.tagName && SKIP_TAGS.has(node.tagName)) return;

    let childStamp = stamp;
    if (node.tagName && BLOCK_TAGS.has(node.tagName)) {
      const location = node.sourceCodeLocation;
      const startTag = location?.startTag;
      if (startTag && Number.isFinite(startTag.endOffset)) {
        const raw = source.slice(startTag.startOffset, startTag.endOffset);
        let at = startTag.endOffset - 1;
        // Insert before the optional `/` of `<img />`, never after it.
        if (at > startTag.startOffset && source[at - 1] === "/") at -= 1;
        if (!raw.includes("data-mdraft-line")) {
          const line = location.startLine || startTag.startLine || 1;
          insertions.push({ at, text: ` data-mdraft-line="${line}"` });
        }
        if (raw.includes("data-mdraft-n")) {
          // The document already uses the attribute; its value is not one of
          // ours. Leave the block unmapped rather than colliding with it.
          childStamp = null;
        } else {
          const id = nextStamp++;
          insertions.push({ at, text: ` data-mdraft-n="${id}"` });
          childStamp = id;
        }
      }
    }

    if (Array.isArray(node.childNodes)) {
      for (const child of node.childNodes) walk(child, childStamp);
    }
    if (node.content) walk(node.content, childStamp);
  };
  walk(document, null);

  const bridge = bridgeMarkup(token, bridgeNonce);
  insertions.push({ at: bridgeInsertOffset(document, source), text: bridge });
  insertions.sort((left, right) => right.at - left.at);

  let output = source;
  for (const insertion of insertions) {
    output = output.slice(0, insertion.at) + insertion.text + output.slice(insertion.at);
  }
  return { html: output, fragments };
}

/**
 * WebKitGTK refuses a local stylesheet, image or classic script from the preview
 * scheme unless the request is CORS-mode, even when the document did not ask for
 * `crossorigin`. Mark only the local subresources; a CDN URL is left exactly as
 * written, because many CDNs do not send CORS headers for images.
 *
 * The attribute is added to the preview copy, never to the saved source.
 */
function addsCrossOrigin(node: any): boolean {
  const attrs: Array<{ name: string; value: string }> = node.attrs ?? [];
  if (attrs.some((attr) => attr.name.toLowerCase() === "crossorigin")) return false;

  const value = (name: string): string | null => {
    const attr = attrs.find((candidate) => candidate.name.toLowerCase() === name);
    return attr ? attr.value : null;
  };
  const local = (url: string | null): boolean => {
    if (!url) return false;
    const trimmed = url.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return false;
    return true;
  };

  switch (node.tagName) {
    case "link": {
      const rel = (value("rel") ?? "").toLowerCase().split(/\s+/);
      return rel.includes("stylesheet") && local(value("href"));
    }
    case "script":
      return local(value("src"));
    case "img":
      return local(value("src")) || local(value("srcset"));
    case "source":
      return local(value("src")) || local(value("srcset"));
    case "video":
      return local(value("src")) || local(value("poster"));
    case "audio":
    case "track":
      return local(value("src"));
    default:
      return false;
  }
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
  let htmlFragments: HtmlTextFragment[] = [];

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
        // The table belongs to the frame that is now on screen, not to the one
        // that is still being built.
        htmlFragments = frame.fragments;
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
    if (data.type === "select") {
      const n = Number(data.n);
      const index = Number(data.index);
      const start = Number(data.start);
      const end = Number(data.end);
      if (
        Number.isInteger(n) &&
        Number.isInteger(index) &&
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        typeof data.sample === "string"
      ) {
        callbacks.onSelection({
          n,
          index,
          start,
          end,
          sample: data.sample,
          reveal: data.reveal === true,
        });
      }
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

  function makeFrame(
    url: string,
    token: string,
    fragments: HtmlTextFragment[],
  ): FrameState {
    const frame = document.createElement("iframe");
    frame.className = "html-preview-frame pending";
    frame.title = "HTML preview";
    frame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.src = `${url}?v=${generation}`;
    host.appendChild(frame);
    return { frame, token, generation, ready: false, timer: 0, fragments };
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
      // Bump the generation first so a render that is still building the
      // previous document cannot mount its frame after this tab has gone.
      generation += 1;
      dropFrames();
      nonce = randomToken();
      guestBase = null;
      htmlFragments = [];
    },

    async render(source, root, filename, scripts) {
      const mine = ++generation;
      // Captured now: reset() replaces `nonce` while this build is awaiting,
      // and a stale render must not publish the old document under the new one.
      const previewNonce = nonce;
      const bridgeNonce = randomToken();
      const token = randomToken();
      let built: HtmlPreviewBuild;
      try {
        built = await buildHtmlPreview(source, token, bridgeNonce);
      } catch (error) {
        if (mine !== generation) return;
        callbacks.onError(`Could not prepare the HTML preview: ${String(error)}`);
        return;
      }
      if (mine !== generation) return;

      let url: string;
      try {
        url = (
          await api.setHtmlPreview({
            nonce: previewNonce,
            bridgeNonce,
            source: built.html,
            root,
            filename,
            scripts,
          })
        ).url;
      } catch (error) {
        if (mine !== generation) return;
        callbacks.onError(`Could not start the HTML preview: ${String(error)}`);
        return;
      }
      if (mine !== generation) return;

      const next = makeFrame(url, token, built.fragments);
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
      generation += 1;
      dropFrames();
      guestBase = null;
      htmlFragments = [];
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

    wordRange(selection) {
      return htmlSourceRange(htmlFragments, selection);
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
