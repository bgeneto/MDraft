//! Markdown → HTML.
//!
//! The pure pipeline — code/math masking, marked, KaTeX, the fragment table and
//! the block line list — lives in `preview-render.ts`, which also runs in the
//! module worker. This module owns the DOM half: DOMPurify, the decoration
//! passes, batched insertion and the live worker path. The synchronous
//! `renderPreview` is the export/print path and the fallback when a worker
//! cannot start.

import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import katex from "katex";
import { escapeHtml, renderChunks, type PreviewChunks, type RenderedMath } from "./preview-render";
import { batchesForChunks, settleMainThread } from "./preview-batches";
import { renderChunksAsync } from "./preview-worker-client";
import type { Fragment } from "./source-map";
// The stylesheet carries the Computer Modern faces AND the layout rules. Without
// it KaTeX still emits its DOM, but fractions collapse and radicals, integrals
// and large delimiters vanish, because those are drawn with the KaTeX_Size
// fonts. Vite rewrites the font URLs and emits the files next to the bundle.
import "katex/dist/katex.min.css";
import { convertFileSrc } from "@tauri-apps/api/core";
import { PRINT_READY_SCRIPT } from "./print-ready";
import { resolveLegacyLocalImage } from "./api";

/**
 * The KaTeX stylesheet, for exported documents that no longer live inside the
 * application.
 *
 * Vite's bundled copy carries the layout rules AND points at hashed font files
 * next to the bundle. A standalone file has no bundle to resolve those against,
 * so an exported document loads the published stylesheet instead, fonts
 * included.
 *
 * Omitting this is not a cosmetic loss: KaTeX still emits its DOM and reports no
 * error, but fractions collapse and radicals grow a bar across the whole page.
 * The editor itself still makes no network request — this is a link the reader's
 * browser follows, which the README documents.
 */
export const KATEX_STYLESHEET_URL = "https://cdn.jsdelivr.net/npm/katex@0.19.0/dist/katex.min.css";
export { escapeHtml };

export interface RenderOptions {
  /** Directory of the document being edited, used to resolve relative images. */
  baseDir: string | null;
  /** Saved document used to resolve a legacy relative image candidate. */
  documentPath?: string | null;
  /** Render `$…$` with KaTeX. When false the delimiters stay literal. */
  math?: boolean;
  /** Render `mermaid` fences as diagrams. When false they stay code blocks. */
  mermaid?: boolean;
  /**
   * Emit the source fragments word-level sync needs. Off for exports: they have
   * no source pane to point at, and the wrapper spans are only weight.
   */
  map?: boolean;
}

const PLACEHOLDER = /@@(CODE|MATH)(\d+)@@/g;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p) || p.startsWith("/");
}

function joinPath(base: string, relative: string): string {
  const windows = /^[A-Za-z]:/.test(base) || base.includes("\\");
  const sep = windows ? "\\" : "/";
  const parts = base.replace(/[\\/]+$/, "").split(/[\\/]/);
  for (const piece of relative.split(/[\\/]/)) {
    if (!piece || piece === ".") continue;
    if (piece === "..") {
      if (parts.length > 1) parts.pop();
      continue;
    }
    parts.push(piece);
  }
  return parts.join(sep);
}

function assetUrl(raw: string, baseDir: string | null): string {
  const src = raw.trim();
  if (!src || /^(https?:|data:|blob:|asset:|mailto:|#)/i.test(src)) return src;

  let path = src;
  try {
    path = decodeURI(src);
  } catch {
    /* keep the raw value */
  }
  if (/^file:\/\//i.test(path)) {
    try {
      path = decodeURIComponent(new URL(path).pathname).replace(/^\//, "");
    } catch {
      /* keep as-is */
    }
  }

  const absolute = isAbsolutePath(path) || !baseDir ? path : joinPath(baseDir, path);

  try {
    return convertFileSrc(absolute);
  } catch {
    return src;
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export interface PreviewDescription {
  /**
   * True when every top-level block carries an exact `data-line` anchor. When
   * false the panes cannot be aligned positionally and callers should fall back
   * to proportional scrolling.
   */
  linesMapped: boolean;
  /** Number of anchored blocks. */
  anchors: number;
  /** Word-level source fragments, present only when `map` was requested. */
  fragments?: Fragment[];
  legacyImages?: PreviewChunks["legacyImages"];
}

export interface RenderResult extends PreviewDescription {
  html: string;
}

/**
 * Render a document for the preview or an export.
 *
 * The pure work is in `preview-render.ts`; this function only builds the DOM.
 * Chunks are sanitised in batches so one huge document does not become one
 * long main-thread task; the worker path (`renderPreviewInto`) uses the same
 * batching with yields between batches.
 */
export function renderPreview(source: string, options: RenderOptions): RenderResult {
  const data = renderChunks(source, options);
  const host = document.createElement("div");
  insertChunks(host, data, options);
  return { ...describePreview(host, data), html: host.innerHTML };
}

/** Raw HTML may open and close across tokens, so it needs one HTML parse. */
function previewBatches(data: PreviewChunks): readonly (readonly string[])[] {
  if (data.hasRawHtml) return data.chunks.length > 0 ? [data.chunks] : [];
  return batchesForChunks(data.chunks);
}

/** Insert every batch synchronously; used by exports and by the fallback. */
function insertChunks(host: HTMLElement, data: PreviewChunks, options: RenderOptions): void {
  host.replaceChildren();
  for (const batch of previewBatches(data)) {
    insertBatch(host, batch, data, options);
  }
  finishPreview(host, data, options, true);
}

/**
 * Paint the preview from a worker result, yielding between batches.
 *
 * `cancelled` is checked before every batch; a newer render token means the
 * caller must stop and let that render own the pane.
 */
export async function renderPreviewInto(
  host: HTMLElement,
  source: string,
  options: RenderOptions,
  cancelled: () => boolean,
): Promise<PreviewDescription | null> {
  const outcome = await renderChunksAsync(source, options);
  // A superseded request must not run a second, synchronous render: the newer
  // render owns the pane. Only a worker that cannot run falls back.
  if (outcome.kind === "superseded") return null;
  if (outcome.kind === "fallback" && cancelled()) return null;
  const data = outcome.kind === "ok" ? outcome.data : renderChunks(source, options);
  if (cancelled()) return null;

  // Build the new preview in a detached container. Appending each batch to the
  // live pane forced a layout of a growing document per batch; one swap at the
  // end is a single layout and leaves the old preview visible while the worker
  // and the batches run.
  const staging = document.createElement("div");
  const grouping = canGroupParagraphs(data) ? new ParagraphGroups(staging, data.lines!) : null;
  let lastYield = performance.now();
  for (const batch of previewBatches(data)) {
    if (cancelled()) return null;
    insertBatch(staging, batch, data, options, grouping);
    lastYield = await settleMainThread(lastYield);
    if (cancelled()) return null;
  }
  const grouped = grouping?.finish() ?? false;
  finishPreview(staging, data, options, false, grouped);
  if (cancelled()) return null;
  const fragment = document.createDocumentFragment();
  while (staging.firstChild) fragment.appendChild(staging.firstChild);
  host.replaceChildren(fragment);
  return describePreview(host, data, grouped);
}

// Restrict grouping to independently parsed paragraphs with an exact line map.
// Raw HTML and complex blocks retain their existing whole-context treatment.
function canGroupParagraphs(data: PreviewChunks): boolean {
  if (
    data.hasRawHtml ||
    !data.lines ||
    data.lines.length < 10000 ||
    typeof CSS === "undefined" ||
    typeof CSS.supports !== "function" ||
    !CSS.supports("content-visibility", "auto")
  )
    return false;
  const chunks = data.chunks.filter((chunk) => chunk.length > 0);
  return chunks.length === data.lines.length && chunks.every((chunk) => chunk.startsWith("<p>"));
}

/** Group only sanitized nodes, while each detached batch is already yielding. */
class ParagraphGroups {
  private group: HTMLElement | null = null;
  private count = 0;
  private index = 0;
  private valid = true;

  constructor(
    private readonly host: HTMLElement,
    private readonly lines: number[],
  ) {}

  append(holder: HTMLElement): void {
    if (
      this.valid &&
      Array.from(holder.childNodes).some((node) =>
        node.nodeType === Node.ELEMENT_NODE
          ? (node as Element).tagName !== "P"
          : node.nodeType !== Node.TEXT_NODE || !!node.textContent?.trim(),
      )
    ) {
      this.flatten();
    }
    while (holder.firstChild) {
      const node = holder.firstChild;
      if (!this.valid) {
        this.host.appendChild(node);
      } else if (node.nodeType !== Node.ELEMENT_NODE) {
        (this.group ?? this.host).appendChild(node);
      } else {
        if (!this.group || this.count === 64) {
          this.group = document.createElement("div");
          this.group.className = "md-preview-group";
          this.group.style.contentVisibility = "auto";
          this.group.style.containIntrinsicSize = "auto 3072px";
          this.host.appendChild(this.group);
          this.count = 0;
        }
        if (this.index === 0) (node as HTMLElement).style.marginTop = "0";
        (node as HTMLElement).dataset.line = String(this.lines[this.index++]);
        this.group.appendChild(node);
        this.count++;
      }
    }
  }

  finish(): boolean {
    if (this.valid && this.index !== this.lines.length) this.flatten();
    return this.valid;
  }

  private flatten(): void {
    this.valid = false;
    const flat = document.createDocumentFragment();
    while (this.host.firstChild) {
      const node = this.host.firstChild;
      if (node instanceof HTMLElement && node.classList.contains("md-preview-group")) {
        while (node.firstChild) {
          const child = node.firstChild;
          if (child instanceof HTMLElement) {
            child.removeAttribute("data-line");
            if (child.style.marginTop === "0px") child.style.removeProperty("margin-top");
            if (!child.getAttribute("style")) child.removeAttribute("style");
          }
          flat.appendChild(child);
        }
        node.remove();
      } else flat.appendChild(node);
    }
    this.host.appendChild(flat);
    this.group = null;
  }
}

const SANITIZE_OPTIONS = {
  // DOMPurify's default URI rule treats `C:` as an unknown scheme and strips
  // the attribute. A drive path is a file the reader chose, so it is allow-
  // listed explicitly; `javascript:` and friends still fall through to the
  // rejection branch.
  ALLOWED_URI_REGEXP:
    /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|asset):|[A-Za-z]:[\\/%]|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  ADD_ATTR: [
    "align",
    "data-f",
    "data-mermaid",
    "data-href",
    "id",
    "colspan",
    "rowspan",
    "type",
    "checked",
    "disabled",
  ],
  // `input` has to survive sanitising so GFM task lists keep their checkbox;
  // normalizeInputs() then strips every input that is not a disabled checkbox.
  FORBID_TAGS: [
    "script",
    "iframe",
    "object",
    "embed",
    "form",
    "textarea",
    "select",
    "button",
    "base",
  ],
  USE_PROFILES: { html: true },
};

function insertBatch(
  host: HTMLElement,
  batch: readonly string[],
  data: PreviewChunks,
  options: RenderOptions,
  grouping: ParagraphGroups | null = null,
): void {
  const holder = document.createElement("div");
  holder.innerHTML = DOMPurify.sanitize(batch.join(""), SANITIZE_OPTIONS);
  normalizeInputs(holder);
  restorePlaceholders(holder, data.codes, data.maths);
  decorateCodeBlocks(holder, options.mermaid ?? true);
  if (grouping) grouping.append(holder);
  else while (holder.firstChild) host.appendChild(holder.firstChild);
}

/** Whole-host passes that need the final element set. */
function finishPreview(
  host: HTMLElement,
  data: PreviewChunks,
  options: RenderOptions,
  preserveLegacy = false,
  grouped = false,
): void {
  decorateLinks(
    host,
    options.baseDir,
    data.legacyImages,
    options.documentPath ?? null,
    preserveLegacy,
  );
  decorateAlerts(host);
  addHeadingIds(host);
  buildTableOfContents(host);
  // The line list belongs to the original source and is already in document
  // order; if a sanitised chunk produced a different number of top-level
  // elements, the annotation is dropped rather than pointing at a wrong line.
  const lines = data.lines;
  const blocks = Array.from(host.children) as HTMLElement[];
  if (!grouped && lines && lines.length === blocks.length) {
    for (let i = 0; i < blocks.length; i += 1) {
      blocks[i].setAttribute("data-line", String(lines[i]));
    }
  }
}

function describePreview(
  host: HTMLElement,
  data: PreviewChunks,
  grouped = false,
): PreviewDescription {
  const lines = data.lines;
  const mapped =
    lines !== null && lines.length > 0 && (grouped || lines.length === host.children.length);
  return {
    linesMapped: mapped,
    anchors: mapped && lines ? lines.length : 0,
    fragments: data.fragments,
    legacyImages: data.legacyImages,
  };
}

/** GitHub-style `> [!NOTE]` blockquotes get a class and a visible title. */
const ALERT_KINDS: Record<string, string> = {
  NOTE: "Note",
  TIP: "Tip",
  IMPORTANT: "Important",
  WARNING: "Warning",
  CAUTION: "Caution",
};

function decorateAlerts(host: HTMLElement): void {
  for (const quote of Array.from(host.querySelectorAll("blockquote"))) {
    const first = quote.querySelector("p");
    const text = first?.textContent ?? "";
    const match = /^\s*\[!(\w+)\]\s*/.exec(text);
    if (!match) continue;
    const kind = ALERT_KINDS[match[1].toUpperCase()];
    if (!kind) continue;

    quote.classList.add("md-alert", `md-alert-${kind.toLowerCase()}`);
    if (first) {
      const title = document.createElement("p");
      title.className = "md-alert-title";
      title.textContent = kind;
      // Drop the marker itself, keeping whatever followed it on that line.
      first.textContent = text.slice(match[0].length);
      if ((first.textContent ?? "").trim().length === 0) first.remove();
      quote.insertBefore(title, quote.firstChild);
    }
  }
}

/** Keep only disabled task-list checkboxes; drop every other form control. */
function normalizeInputs(host: HTMLElement): void {
  for (const input of Array.from(host.querySelectorAll("input"))) {
    const type = (input.getAttribute("type") ?? "").toLowerCase();
    if (type !== "checkbox") {
      input.remove();
      continue;
    }
    input.setAttribute("disabled", "");
    input.removeAttribute("tabindex");
  }
}

function restorePlaceholders(
  host: HTMLElement,
  codes: readonly { text: string }[],
  maths: readonly RenderedMath[],
): void {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (PLACEHOLDER.test((node as Text).nodeValue ?? "")) {
      PLACEHOLDER.lastIndex = 0;
      targets.push(node as Text);
    }
    PLACEHOLDER.lastIndex = 0;
  }

  for (const node of targets) {
    const text = node.nodeValue ?? "";
    const fragment = document.createDocumentFragment();
    let last = 0;
    PLACEHOLDER.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = PLACEHOLDER.exec(text)) !== null) {
      if (match.index > last) {
        fragment.appendChild(document.createTextNode(text.slice(last, match.index)));
      }
      const [, kind, indexRaw] = match;
      const index = Number(indexRaw);
      if (kind === "CODE") {
        const code = document.createElement("code");
        code.textContent = codes[index]?.text ?? "";
        fragment.appendChild(code);
      } else {
        fragment.appendChild(mathNode(maths[index]));
      }
      last = match.index + match[0].length;
    }
    if (last < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(last)));
    }
    node.parentNode?.replaceChild(fragment, node);
  }
}

export function mathNode(
  entry:
    | (Pick<RenderedMath, "body" | "display"> & Partial<Pick<RenderedMath, "html" | "error">>)
    | undefined,
): Node {
  const span = document.createElement("span");
  span.className = entry?.display ? "math-display" : "math-inline";
  if (!entry) {
    span.textContent = "";
    return span;
  }
  span.dataset.tex = entry.body;
  // The worker pre-renders the KaTeX markup; the export/AsciiDoc paths render
  // it here. Either way the generated HTML is inserted after sanitising.
  if (entry.html !== undefined && entry.html !== null) {
    span.innerHTML = entry.html;
    return span;
  }
  if (entry.error) {
    span.className = "math-error";
    span.textContent = `$${entry.body}$`;
    span.title = entry.error;
    return span;
  }
  try {
    span.innerHTML = katex.renderToString(entry.body, {
      displayMode: entry.display,
      throwOnError: false,
      strict: false,
      output: "html",
    });
  } catch (error) {
    span.className = "math-error";
    span.textContent = `$${entry.body}$`;
    span.title = String(error);
  }
  return span;
}

const MATH_IN_TEXT = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g;

/**
 * Draw the `\(…\)` and `\[…\]` delimiters Asciidoctor leaves in its HTML.
 *
 * The Markdown pipeline extracts mathematics from the *source* before `marked`,
 * so it has no DOM pass to reuse. AsciiDoc's converter emits inline LaTeX as
 * plain text and display LaTeX inside `.stemblock`; this walks the text nodes
 * and replaces only those delimiters. `$…$` is deliberately absent: AsciiDoc
 * puts AsciiMath there, and it is not TeX.
 */
export function renderMathIn(host: HTMLElement): number {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (!parent || parent.closest("pre, code, script, style, textarea")) {
        return NodeFilter.FILTER_REJECT;
      }
      const text = node.nodeValue ?? "";
      return /\\[([]/.test(text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  let count = 0;
  for (const node of nodes) {
    const text = node.nodeValue ?? "";
    MATH_IN_TEXT.lastIndex = 0;
    let match: RegExpExecArray | null;
    let last = 0;
    let replaced = false;
    const fragment = document.createDocumentFragment();
    while ((match = MATH_IN_TEXT.exec(text)) !== null) {
      replaced = true;
      if (match.index > last) {
        fragment.appendChild(document.createTextNode(text.slice(last, match.index)));
      }
      const display = match[2] !== undefined;
      fragment.appendChild(mathNode({ body: (display ? match[2] : match[1]) ?? "", display }));
      last = MATH_IN_TEXT.lastIndex;
      count += 1;
    }
    if (!replaced) continue;
    if (last < text.length) fragment.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode?.replaceChild(fragment, node);
  }
  return count;
}

/**
 * The AsciiDoc structure the preview stylesheet already applies.
 *
 * The HTML and print exports never load `styles.css`; they concatenate their
 * own rules. This is the copy those wrappers use. The preview keeps its copy in
 * `src/styles.css`, beside the rest of the preview rules.
 */
export const ASCIIDOC_CSS = `
.admonitionblock > table{display:table;width:100%;border-collapse:collapse;margin:0;background:none}
.admonitionblock > table tr,.admonitionblock > table td{border:0;background:none}
.admonitionblock > table td{padding:0;vertical-align:top}
.admonitionblock > table td.icon{width:4.5em;text-align:center;padding-right:.75em}
.admonitionblock > table td.icon .title{font-weight:600;text-transform:uppercase;font-size:.78em;letter-spacing:.04em}
.admonitionblock > table td.content{padding:.15em 0 .15em 1em;border-left:3px solid #d0d0d0;color:#555}
.admonitionblock.note > table td.content{border-left-color:#0969da}
.admonitionblock.tip > table td.content{border-left-color:#1a7f37}
.admonitionblock.important > table td.content{border-left-color:#8250df}
.admonitionblock.warning > table td.content{border-left-color:#9a6700}
.admonitionblock.caution > table td.content{border-left-color:#cf222e}
.admonitionblock.note > table td.icon .title{color:#0969da}
.admonitionblock.tip > table td.icon .title{color:#1a7f37}
.admonitionblock.important > table td.icon .title{color:#8250df}
.admonitionblock.warning > table td.icon .title{color:#9a6700}
.admonitionblock.caution > table td.icon .title{color:#cf222e}
.checklist{list-style:none;padding-left:1.4em}
.checklist > li > p:first-child{margin-left:-1.2em}
.title,div.title{font-weight:600;font-style:italic;margin:0 0 .35em}
#toc{border:1px solid #e0e0e0;background:#f7f7f8;padding:.75em 1em;margin:0 0 1.5em;border-radius:6px}
#toc #toctitle{font-weight:700;text-transform:uppercase;font-size:.78em;letter-spacing:.06em;margin-bottom:.4em}
#toc ul{list-style:none;padding-left:0;margin:0}
#toc ul ul{padding-left:1em}
#toc li{margin:.15em 0}
.quoteblock .attribution{text-align:right;font-style:italic;color:#666;margin-top:.25em}
.line-through{text-decoration:line-through}
.stemblock .content{text-align:center}
.asciidoc-error{background:#fff2f0;border:1px solid #ffccc7;border-radius:6px;padding:12px 14px;white-space:pre-wrap}
`;

/**
 * The GitHub alert colours an exported document must carry.
 *
 * The preview gets these from `src/styles.css`; the HTML, print and native PDF
 * wrappers never load that file, so without this copy an alert loses its tinted
 * background and coloured rule and reads as a plain blockquote. The rows are
 * deliberately duplicated rather than generated: the export has no stylesheet
 * import to share, exactly like `ASCIIDOC_CSS` above.
 */
export const GITHUB_ALERT_CSS = `
.markdown-body .md-alert{border-left-width:4px;border-radius:3px;padding:8px 14px;color:inherit}
.markdown-body .md-alert-title{margin:0 0 4px;font-weight:600}
.markdown-body .md-alert-note{border-left-color:#4a90d9;background:rgba(74,144,217,.09)}
.markdown-body .md-alert-tip{border-left-color:#3fb950;background:rgba(63,185,80,.09)}
.markdown-body .md-alert-important{border-left-color:#a371f7;background:rgba(163,113,247,.09)}
.markdown-body .md-alert-warning{border-left-color:#d29922;background:rgba(210,153,34,.1)}
.markdown-body .md-alert-caution{border-left-color:#f85149;background:rgba(248,81,73,.09)}
`;

export function decorateCodeBlocks(host: HTMLElement, mermaidEnabled = true): void {
  for (const pre of Array.from(host.querySelectorAll("pre"))) {
    const code = pre.querySelector("code");
    if (!code) continue;

    const language = Array.from(code.classList)
      .find((c) => c.startsWith("language-"))
      ?.slice("language-".length);

    if (language === "mermaid" && mermaidEnabled) {
      // Rendered asynchronously against the live element.
      const container = document.createElement("div");
      container.className = "mermaid";
      container.setAttribute("data-mermaid", code.textContent ?? "");
      pre.replaceWith(container);
      continue;
    }

    const source = code.textContent ?? "";
    try {
      if (language && hljs.getLanguage(language)) {
        code.innerHTML = hljs.highlight(source, { language, ignoreIllegals: true }).value;
      } else if (language) {
        code.innerHTML = hljs.highlightAuto(source).value;
      } else {
        code.innerHTML = escapeHtml(source);
      }
      code.classList.add("hljs");
    } catch {
      code.textContent = source;
    }
  }
}

export function decorateLinks(
  host: HTMLElement,
  baseDir: string | null,
  legacyImages?: PreviewChunks["legacyImages"],
  documentPath: string | null = null,
  preserveLegacy = false,
): void {
  const resolutions = new Map<string, Promise<string | null>>();
  for (const img of Array.from(host.querySelectorAll("img"))) {
    const src = img.getAttribute("src");
    const stamp = img.getAttribute("data-mdraft-legacy");
    const legacy =
      stamp && legacyImages && Object.prototype.hasOwnProperty.call(legacyImages, stamp)
        ? legacyImages[stamp]
        : undefined;
    if (!preserveLegacy) img.removeAttribute("data-mdraft-legacy");
    if (src) {
      // Keep the document's own address: `src` below is rewritten to an
      // `asset:` URL, and Ctrl+click (and the failed-image tooltip) need the
      // value the document actually wrote.
      img.dataset.src = src;
      img.setAttribute("src", assetUrl(src, baseDir));
      img.addEventListener(
        "error",
        () => {
          const addedTitle = !img.title;
          if (addedTitle) img.title = src;
          if (!legacy || !/Windows/i.test(navigator.userAgent)) return;
          let parsed: string;
          let expected: string;
          let candidate: string;
          try {
            parsed = decodeURI(src);
            expected = decodeURI(legacy.parsed);
            candidate = decodeURI(legacy.candidate);
          } catch {
            return;
          }
          if (parsed !== expected) return;
          const key = JSON.stringify([parsed, candidate]);
          let resolution = resolutions.get(key);
          if (!resolution) {
            resolution = resolveLegacyLocalImage(parsed, candidate, documentPath);
            resolutions.set(key, resolution);
          }
          void resolution
            .then((path) => {
              if (!path || !img.isConnected) return;
              img.addEventListener(
                "load",
                () => {
                  img.dataset.src = path;
                  if (addedTitle && img.title === src) img.removeAttribute("title");
                },
                { once: true },
              );
              img.setAttribute("src", assetUrl(path, null));
            })
            .catch(() => {
              /* preserve the original failed image */
            });
        },
        { once: true },
      );
    }
    img.setAttribute("loading", "lazy");
  }

  for (const anchor of Array.from(host.querySelectorAll("a"))) {
    const href = anchor.getAttribute("href") ?? "";
    anchor.setAttribute("data-href", href);
    if (/^https?:/i.test(href)) {
      anchor.classList.add("external-link");
    } else if (!href.startsWith("#")) {
      anchor.classList.add("local-link");
    }
    anchor.removeAttribute("href");
  }
}

/** Resolve candidates for static exports before their destinations are rewritten. */
export async function resolveLegacyImagesForExport(
  host: HTMLElement,
  legacyImages: PreviewChunks["legacyImages"],
  documentPath: string | null,
): Promise<void> {
  const pending: Array<{ img: HTMLImageElement; parsed: string; candidate: string }> = [];
  for (const img of Array.from(
    host.querySelectorAll<HTMLImageElement>("img[data-mdraft-legacy]"),
  )) {
    const stamp = img.getAttribute("data-mdraft-legacy");
    img.removeAttribute("data-mdraft-legacy");
    const legacy =
      stamp && legacyImages && Object.prototype.hasOwnProperty.call(legacyImages, stamp)
        ? legacyImages[stamp]
        : undefined;
    if (!legacy || !/Windows/i.test(navigator.userAgent)) continue;
    let parsed = img.dataset.src ?? "";
    let expected: string;
    let candidate: string;
    try {
      parsed = decodeURI(parsed);
      expected = decodeURI(legacy.parsed);
      candidate = decodeURI(legacy.candidate);
    } catch {
      continue;
    }
    if (parsed !== expected) continue;
    pending.push({ img, parsed, candidate });
  }
  const cache = new Map<string, Promise<string | null>>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < pending.length) {
      const { img, parsed, candidate } = pending[next++];
      const key = JSON.stringify([parsed, candidate]);
      let resolution = cache.get(key);
      if (!resolution) {
        resolution = resolveLegacyLocalImage(parsed, candidate, documentPath).catch(() => null);
        cache.set(key, resolution);
      }
      const path = await resolution;
      if (path) img.dataset.src = path;
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, () => worker()));
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

function addHeadingIds(host: HTMLElement): void {
  const seen = new Map<string, number>();
  for (const heading of Array.from(host.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
    const base = slugify(heading.textContent ?? "") || "section";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    heading.id = count === 0 ? base : `${base}-${count}`;
  }
}

export interface Heading {
  level: number;
  text: string;
  line: number;
}

/** Extract ATX headings, skipping fenced code blocks. */
export function extractHeadings(markdown: string): Heading[] {
  const headings: Heading[] = [];
  const lines = markdown.split("\n");
  let insideFence = false;
  let marker = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (!insideFence && fence) {
      insideFence = true;
      marker = fence[1][0];
      continue;
    }
    if (insideFence) {
      const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === marker) insideFence = false;
      continue;
    }

    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) {
      headings.push({ level: match[1].length, text: match[2].trim(), line: i + 1 });
    }
  }
  return headings;
}

/** Replace a literal `[TOC]` paragraph with links to the rendered headings. */
function buildTableOfContents(host: HTMLElement): void {
  const markers = Array.from(host.querySelectorAll("p")).filter(
    (p) => (p.textContent ?? "").trim() === "[TOC]",
  );
  if (markers.length === 0) return;

  const headings = Array.from(host.querySelectorAll("h1,h2,h3,h4,h5,h6"));
  const nav = document.createElement("nav");
  nav.className = "md-toc";

  if (headings.length === 0) {
    const empty = document.createElement("p");
    empty.className = "md-toc-empty";
    empty.textContent = "No headings yet.";
    nav.appendChild(empty);
  } else {
    const list = document.createElement("ul");
    const minLevel = Math.min(...headings.map((h) => Number(h.tagName.slice(1))));
    for (const heading of headings) {
      const item = document.createElement("li");
      item.style.paddingLeft = `${(Number(heading.tagName.slice(1)) - minLevel) * 14}px`;
      const link = document.createElement("a");
      link.className = "local-link";
      link.setAttribute("data-href", `#${heading.id}`);
      link.textContent = heading.textContent ?? "";
      item.appendChild(link);
      list.appendChild(item);
    }
    nav.appendChild(list);
  }

  for (const marker of markers) marker.replaceWith(nav.cloneNode(true));
}

// ---------------------------------------------------------------------------
// Mermaid (async, cached)
// ---------------------------------------------------------------------------

const mermaidCache = new Map<string, string>();
let mermaidSequence = 0;

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, code: string) => Promise<{ svg: string }>;
};

let mermaidApi: MermaidApi | null = null;

async function loadMermaid(isDark: boolean): Promise<MermaidApi> {
  if (!mermaidApi) {
    const mod = await import("mermaid");
    mermaidApi = (mod.default ?? mod) as unknown as MermaidApi;
  }
  mermaidApi.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: isDark ? "dark" : "default",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    flowchart: { useMaxWidth: true, htmlLabels: false },
    sequence: { useMaxWidth: true },
  });
  return mermaidApi;
}

export function renderMermaidError(container: HTMLElement, error: unknown): void {
  const box = document.createElement("div");
  box.className = "mermaid-error";
  const message = error instanceof Error ? error.message : String(error);
  box.textContent = `Diagram error: ${message.split("\n")[0]}`;
  container.replaceChildren(box);
}

/** Fill every `.mermaid[data-mermaid]` element inside `root`. */
export async function renderMermaidIn(root: HTMLElement, isDark: boolean): Promise<void> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>(".mermaid[data-mermaid]"));
  if (blocks.length === 0) return;

  let mermaid: MermaidApi;
  try {
    mermaid = await loadMermaid(isDark);
  } catch (error) {
    for (const block of blocks) renderMermaidError(block, error);
    return;
  }

  for (const block of blocks) {
    const code = block.getAttribute("data-mermaid") ?? "";
    const key = `${isDark ? "dark" : "light"}\u0000${code}`;

    const cached = mermaidCache.get(key);
    if (cached) {
      block.innerHTML = cached;
      continue;
    }

    try {
      const { svg } = await mermaid.render(`mmd-${++mermaidSequence}`, code);
      mermaidCache.set(key, svg);
      block.innerHTML = svg;
    } catch (error) {
      renderMermaidError(block, error);
    }
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * A print-ready standalone document.
 *
 * Built for the browser's own "print to PDF", which is the only PDF path that
 * needs nothing installed. The page is deliberately always light: token colours
 * chosen for a dark editor print as pale text on white paper whenever background
 * graphics are off, which is the default in most browsers.
 *
 * The document prints itself as soon as it loads, so the user's next action is
 * the one the browser is already asking for — choosing "Save as PDF" as the
 * destination — rather than having to find Ctrl+P first.
 *
 * `typographyCss` carries the reader's typeface choices as custom properties and
 * `fontCss` carries the bundled faces themselves as data URLs. Both are needed:
 * a family named in a stack means nothing to a browser reading a temporary file,
 * which cannot reach the application's assets and would quietly substitute a
 * system font — so the PDF would stop matching the preview exactly when the
 * reader had gone to the trouble of choosing a face.
 */
export function wrapPrintHtml(
  title: string,
  bodyHtml: string,
  tokenCss: string,
  typographyCss = "",
  fontCss = "",
  autoPrint = true,
  marker = false,
): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    marker ? '<meta name="mdraft-print" content="native">' : "",
    // Without this the mathematics collapses, exactly as it would in the
    // preview: KaTeX needs its layout rules, not just its DOM.
    `<link rel="stylesheet" href="${KATEX_STYLESHEET_URL}">`,
    fontCss ? `<style>${fontCss}</style>` : "",
    "<style>",
    ":root{color-scheme:light}",
    typographyCss,
    "html,body{background:#fff}",
    "@page{size:A4;margin:18mm 16mm}",
    "body{max-width:none;margin:0;padding:0;color:#1a1a1a;",
    "font-family:var(--font-body,Georgia,serif);",
    "line-height:1.65;",
    // Points rather than pixels: the page is a piece of paper, and the reader's
    // pixel size was chosen for a screen. 16px at 96dpi is 12pt.
    "font-size:calc(var(--body-size,16px) * 0.75)}",
    "font-kerning:normal;font-variant-numeric:var(--prose-figures,normal);",
    "font-variant-ligatures:common-ligatures contextual;font-optical-sizing:auto}",
    // A heading stranded at the foot of a page, or a table split across two, is
    // the commonest way an otherwise fine printout looks broken.
    "h1,h2,h3,h4,h5,h6{break-after:avoid;page-break-after:avoid;break-inside:avoid;",
    "font-family:var(--font-heading,inherit);font-variant-numeric:normal;",
    "font-weight:var(--weight-strong,600)}",
    // `break-after: avoid` alone lets WebView2 leave a heading at the foot of a
    // page and move only its paragraph, which is exactly the stranded heading
    // the rule is meant to prevent. Asking the following block not to break
    // before itself closes that gap.
    "h1+*,h2+*,h3+*,h4+*,h5+*,h6+*{break-before:avoid;page-break-before:avoid}",
    // A page whose last five lines are followed by two isolated lines on a new
    // sheet reads as a mistake. WebKitGTK honours widows and orphans even where
    // it ignores the newer `break-*` properties.
    "p,li,blockquote{orphans:3;widows:3}",
    "strong,b{font-weight:var(--weight-strong,600)}",
    // The divider independent of the one under h1/h2, which uses the table and
    // panel border colour and must stay lighter than this.
    "hr{border:none;border-top:1px solid #cfcfcf;margin:1.6em 0}",
    "table,pre,blockquote,figure{break-inside:avoid;page-break-inside:avoid}",
    // A diagram taller than the sheet must be scaled to fit; `max-width:100%`
    // alone leaves a wide Mermaid sequence diagram taller than A4, and the
    // printer then clips its top and bottom. The maximum is one printable page
    // (A4 minus the 18mm top and bottom margins), with a little room for the
    // surrounding blocks.
    "img,svg{max-width:100%;max-height:250mm;height:auto;break-inside:avoid}",
    "table{border-collapse:collapse;width:100%;font-variant-numeric:var(--table-figures,normal)}",
    "th,td{border:1px solid #c8c8c8;padding:5px 9px;text-align:left}",
    "th{background:#f2f2f2}",
    "pre{background:#f6f8fa;padding:10px 12px;border-radius:4px;overflow:visible;white-space:pre-wrap;",
    // The family and size belong on `pre`: a literal block is a bare `<pre>`
    // with no `<code>` in it, so `code`-only styling would print it in the
    // default monospace at full prose size. `--code-scale` is the reader's
    // Code scale; the ratios are the preview's, so one percentage means the
    // same size in the pane and on paper.
    "font-family:var(--font-code,monospace);font-size:calc(.86em * var(--code-scale,1));line-height:1.6;",
    "font-variant-ligatures:var(--code-ligatures,normal);",
    "font-variant-numeric:var(--code-figures,normal)}",
    "code{font-family:var(--font-code,monospace);font-size:calc(.88em * var(--code-scale,1));",
    "font-variant-ligatures:var(--code-ligatures,normal);",
    "font-variant-numeric:var(--code-figures,normal)}",
    "pre code{font-size:inherit;line-height:inherit}",
    "blockquote{margin:0;padding-left:12px;border-left:3px solid #d0d0d0;color:#444}",
    "a{color:#0b57d0;text-decoration:none}",
    // Long URLs and code lines must wrap rather than be clipped at the margin.
    "a[href^='http']{overflow-wrap:anywhere}",
    ".math-display{text-align:center;margin:1em 0}",
    ".print-keep{break-inside:avoid;page-break-inside:avoid}",
    // Mermaid's own SVG styles outrank the page's body rule. Let the diagram
    // inherit the document's face and keep a long label inside its node when
    // the reader chose a wider family than the one Mermaid measured with.
    "svg text,svg .label,svg .nodeLabel,svg foreignObject div{font-family:var(--font-body,sans-serif)!important}",
    "svg foreignObject{overflow:visible}",
    "</style>",
    `<style>${tokenCss}</style>`,
    "</head>",
    "<body>",
    bodyHtml,
    autoPrint ? `<script>${PRINT_READY_SCRIPT}</script>` : "",
    "</body>",
    "</html>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * The same article for the hidden native print surface.
 *
 * It carries no script: the host injects its own readiness check after
 * navigation, and document markup must not reach the Tauri bridge even though
 * the print window has no capability. The marker meta tag tells the host that
 * the intended document, not `about:blank`, has arrived.
 */
export function wrapNativePrintHtml(
  title: string,
  bodyHtml: string,
  tokenCss: string,
  typographyCss = "",
  fontCss = "",
): string {
  // The renderers already sanitise their HTML, but the native surface is the
  // last place a document script could reach a Tauri webview. Strip any script
  // element here as well, so a renderer regression cannot turn into code run
  // beside the unprivileged bridge.
  const body = bodyHtml.replace(/<script\b[\s\S]*?<\/script>/gi, "");
  return wrapPrintHtml(title, body, tokenCss, typographyCss, fontCss, false, true);
}

/** Wrap rendered body HTML into a standalone document for "Export as HTML". */
export function wrapStandaloneHtml(
  title: string,
  bodyHtml: string,
  isDark: boolean,
  headExtra = "",
): string {
  const background = isDark ? "#1e1e1e" : "#ffffff";
  const color = isDark ? "#d4d4d4" : "#333333";
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    "<style>",
    `:root{color-scheme:${isDark ? "dark" : "light"}}`,
    `body{max-width:820px;margin:40px auto;padding:0 24px;background:${background};color:${color};`,
    'font-family:var(--font-body,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif);',
    "font-size:var(--body-size,16px);",
    "font-variant-numeric:var(--prose-figures,normal);",
    "font-variant-ligatures:common-ligatures contextual;",
    "line-height:1.7}",
    "h1,h2,h3,h4,h5,h6{font-family:var(--font-heading,inherit);",
    "font-weight:var(--weight-strong,600);font-variant-numeric:normal}",
    "pre{background:rgba(127,127,127,.12);padding:12px 14px;border-radius:6px;overflow:auto;",
    // A literal block has no `<code>` child, so the face and size must be on
    // `pre` or the exported file shows it in the browser default at 100%. The
    // ratios are the preview's, and `--code-scale` carries the reader's Code
    // scale into a document that never loads `styles.css`.
    "font-family:var(--font-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:calc(.86em * var(--code-scale,1));",
    "font-variant-ligatures:var(--code-ligatures,normal);",
    "font-variant-numeric:var(--code-figures,normal)}",
    "code{font-family:var(--font-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:calc(.88em * var(--code-scale,1));",
    "font-variant-ligatures:var(--code-ligatures,normal);",
    "font-variant-numeric:var(--code-figures,normal)}",
    "pre code{font-size:inherit}",
    "table{border-collapse:collapse;font-variant-numeric:var(--table-figures,normal)}",
    "th,td{border:1px solid rgba(127,127,127,.35);padding:6px 10px}",
    "blockquote{margin:0;padding-left:14px;border-left:3px solid rgba(127,127,127,.4);opacity:.9}",
    // The same divider the preview draws: stronger than the panel border, so a
    // rule in the exported document does not disappear against white or black.
    `hr{border:none;border-top:1px solid ${isDark ? "#4a4a4a" : "#cfcfcf"};margin:1.6em 0}`,
    "img{max-width:100%}",
    "</style>",
    headExtra,
    "</head>",
    "<body>",
    bodyHtml,
    "</body>",
    "</html>",
  ].join("\n");
}
