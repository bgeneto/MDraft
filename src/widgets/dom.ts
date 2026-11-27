/**
 * Paint a compiled figure (`index.ts`) into the preview DOM.
 *
 * Elements are created with DOM APIs from an already validated tree; no markup
 * string is ever parsed except Markdown text runs, which go through the same
 * DOMPurify settings as the rest of the preview. The finished figure is passed
 * through DOMPurify once more with the HTML and SVG profiles, so a gap in the
 * allowlists cannot by itself put script or a remote reference on the page.
 */

import DOMPurify from "dompurify";
import { Marked } from "marked";
import { PREVIEW_FORBID_TAGS } from "../preview-render.ts";
import { ID_MARK, type VNode } from "./render.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

const marked = new Marked({ gfm: true, breaks: false });

let figureSequence = 0;

/**
 * Figure styles. Colours derive from `currentColor`, so one stylesheet serves
 * the light and dark preview and every export theme without knowing which is
 * active. Exports embed the same string (see `exportTypographyCss`).
 */
export const WIDGET_CSS = `
.md-widget{--mdw-border:color-mix(in srgb,currentColor 18%,transparent);--mdw-border-strong:color-mix(in srgb,currentColor 34%,transparent);--mdw-surface:color-mix(in srgb,currentColor 9%,transparent);--mdw-surface-2:color-mix(in srgb,currentColor 4%,transparent);--mdw-surface-3:color-mix(in srgb,currentColor 14%,transparent);--mdw-muted:color-mix(in srgb,currentColor 70%,transparent);--mdw-faint:color-mix(in srgb,currentColor 50%,transparent);--mdw-success:#1f9d55;--mdw-warning:#d97706;--mdw-danger:#dc2626;--mdw-info:#3b82f6;margin:1.2em 0;line-height:1.45;break-inside:avoid}
.md-widget svg{max-width:100%;height:auto;overflow:visible}
.md-widget svg:not([width]),.md-widget svg[width="100%"]{display:block;width:100%;max-width:680px;margin-inline:auto}
.md-widget .mdw-card{display:flex;flex-direction:column;gap:12px;padding:18px;border:1px solid var(--mdw-border);border-radius:12px;background:var(--mdw-surface-2)}
.md-widget .mdw-box,.md-widget .mdw-col,.md-widget .mdw-grid-item{display:flex;flex-direction:column;min-width:0}
.md-widget .mdw-row{display:flex;flex-direction:row;align-items:center;gap:12px;min-width:0}
.md-widget .mdw-wrap{flex-wrap:wrap}
.md-widget .mdw-grid{display:grid;gap:12px;grid-template-columns:repeat(2,minmax(0,1fr))}
.md-widget .mdw-bordered{border:1px solid var(--mdw-border)}
.md-widget .mdw-border-strong{border-color:var(--mdw-border-strong)}
.md-widget .mdw-title{font-weight:650;font-size:1.05em;line-height:1.3}
.md-widget .mdw-label{font-weight:600;font-size:.9em}
.md-widget .mdw-caption{font-size:.85em;color:var(--mdw-muted)}
.md-widget .mdw-tabular{font-variant-numeric:tabular-nums}
.md-widget .mdw-italic{font-style:italic}
.md-widget .mdw-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.md-widget .mdw-spacer{flex:1 1 0}
.md-widget .mdw-divider{align-self:stretch;border-top:1px solid var(--mdw-border)}
.md-widget .mdw-icon{display:inline-flex;align-items:center;justify-content:center;line-height:0}
.md-widget .mdw-icon svg{width:var(--mdw-icon,18px);height:var(--mdw-icon,18px);margin:0}
.md-widget .mdw-badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:.8em;color:var(--mdw-badge,inherit);background:color-mix(in srgb,var(--mdw-badge,currentColor) 15%,transparent)}
.md-widget .mdw-slider{padding:8px 0}
.md-widget .mdw-slider-track{position:relative;height:6px;border-radius:999px;background:var(--mdw-surface-3)}
.md-widget .mdw-slider-fill{position:absolute;top:0;bottom:0;left:0;border-radius:inherit;background:color-mix(in srgb,var(--mdw-info) 55%,transparent)}
.md-widget .mdw-slider-thumb{position:absolute;top:50%;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;background:#fff;box-shadow:0 0 0 1px var(--mdw-border-strong),0 1px 2px rgba(0,0,0,.25)}
.md-widget .mdw-segmented{display:inline-flex;align-self:flex-start;gap:2px;padding:2px;border-radius:8px;background:var(--mdw-surface-2)}
.md-widget .mdw-segment{padding:4px 12px;border-radius:6px;font-size:.9em;color:var(--mdw-muted)}
.md-widget .mdw-segment-selected{background:var(--mdw-surface-3);color:inherit;font-weight:600}
.md-widget .mdw-md{min-width:0}
.md-widget .mdw-md>:first-child{margin-top:0}
.md-widget .mdw-md>:last-child{margin-bottom:0}
.md-widget .mdw-md p{margin:.3em 0}
.mdw-fallback>pre{margin-bottom:.3em}
.mdw-error{margin:0 0 1em;font-size:12px;color:#cc4444}
`;

let stylesInstalled = false;

/** Put the figure stylesheet in the application document once. */
function ensureStyles(): void {
  if (stylesInstalled || typeof document === "undefined") return;
  stylesInstalled = true;
  const style = document.createElement("style");
  style.id = "mdraft-widget-styles";
  style.textContent = WIDGET_CSS;
  document.head.appendChild(style);
}

const SANITIZE_MARKDOWN = {
  FORBID_TAGS: [...PREVIEW_FORBID_TAGS, "input", "img", "video", "audio", "picture", "source"],
  USE_PROFILES: { html: true },
};

/**
 * A Markdown run inside a component. A single paragraph is unwrapped so short
 * labels (`**Dense retrieval**`) sit inline like the assistant renders them.
 * Images are refused: a figure must not reach outside itself.
 */
function markdownNode(text: string): HTMLElement {
  const html = marked.parse(text, { async: false }) as string;
  const holder = document.createElement("div");
  holder.innerHTML = DOMPurify.sanitize(html, SANITIZE_MARKDOWN) as string;
  const only = holder.children.length === 1 ? holder.firstElementChild : null;
  if (only && only.tagName === "P" && holder.childNodes.length <= 3) {
    const span = document.createElement("span");
    span.className = "mdw-md";
    span.append(...Array.from(only.childNodes));
    return span;
  }
  holder.className = "mdw-md";
  return holder;
}

function buildNode(node: VNode, prefix: string): Node {
  if (node.t === "text") return document.createTextNode(node.text);
  if (node.t === "md") return markdownNode(node.text);
  const element = node.svg
    ? document.createElementNS(SVG_NS, node.tag)
    : document.createElement(node.tag);
  for (const [name, value] of node.attrs) {
    element.setAttribute(name, value.split(ID_MARK).join(prefix));
  }
  for (const child of node.children) element.appendChild(buildNode(child, prefix));
  return element;
}

/** Build the `<figure>` for a compiled figure. */
export function buildWidget(nodes: readonly VNode[]): HTMLElement {
  ensureStyles();
  const prefix = `mdw${++figureSequence}-`;
  const figure = document.createElement("figure");
  figure.className = "md-widget";
  for (const node of nodes) figure.appendChild(buildNode(node, prefix));
  DOMPurify.sanitize(figure, {
    IN_PLACE: true,
    USE_PROFILES: { html: true, svg: true },
    FORBID_TAGS: [...PREVIEW_FORBID_TAGS, "foreignObject", "image", "use", "a", "img"],
    FORBID_ATTR: ["href", "xlink:href", "src"],
  });
  return figure;
}

/** The code block with the reason it could not be drawn underneath. */
export function buildWidgetFallback(pre: HTMLElement, message: string, line?: number): HTMLElement {
  ensureStyles();
  const wrapper = document.createElement("div");
  wrapper.className = "mdw-fallback";
  pre.replaceWith(wrapper);
  wrapper.appendChild(pre);
  const note = document.createElement("p");
  note.className = "mdw-error";
  note.textContent = `Figure not rendered: ${message}${line ? ` (line ${line})` : ""}`;
  wrapper.appendChild(note);
  return wrapper;
}
