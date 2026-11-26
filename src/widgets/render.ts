/**
 * Turn a parsed figure into a validated, DOM-free node tree.
 *
 * Everything that reaches the tree has passed an allowlist for its context:
 * SVG elements and presentation attributes inside `<svg>`, layout components
 * and their design-token props outside it. Values are checked as well (colours,
 * lengths, `url(#id)` references), so the DOM builder can create elements
 * without interpreting anything. Ids are marked with `\u0000` so the builder can
 * give each painted figure its own prefix.
 */

import {
  Budget,
  Scope,
  WidgetError,
  bindPattern,
  declare,
  evaluate,
  isHandler,
  isSetter,
  toText,
  truthy,
  type Value,
} from "./expr.ts";
import type { Attr, TNode } from "./template.ts";
import { ICONS } from "./icons.ts";

export type VNode =
  | { t: "el"; tag: string; svg: boolean; attrs: [string, string][]; children: VNode[] }
  | { t: "text"; text: string }
  /** A run of Markdown inside a layout component, rendered by the DOM builder. */
  | { t: "md"; text: string };

const MAX_ELEMENTS = 5_000;
const MAX_DEPTH = 64;
/** Marks ids and `url(#id)` references for per-figure prefixing. */
export const ID_MARK = "\u0000";

interface Ctx {
  elements: number;
  depth: number;
}

function el(
  ctx: Ctx,
  tag: string,
  svg: boolean,
  attrs: [string, string][],
  children: VNode[],
): VNode {
  ctx.elements += 1;
  if (ctx.elements > MAX_ELEMENTS) throw new WidgetError("figure has too many elements");
  return { t: "el", tag, svg, attrs, children };
}

/** Render a parsed figure. Declarations at the top level apply to the whole figure. */
export function renderFigure(nodes: TNode[], budget = new Budget()): VNode[] {
  const scope = new Scope(null, budget);
  const ctx: Ctx = { elements: 0, depth: 0 };
  return renderLayoutChildren(nodes, scope, ctx);
}

// ---------------------------------------------------------------------------
// Control flow shared by both contexts
// ---------------------------------------------------------------------------

type ChildRenderer = (nodes: TNode[], scope: Scope, ctx: Ctx) => VNode[];

/** Expand `{#each}`, `{#if}` and declarations; hand elements and text to `leaf`. */
function expand(
  nodes: TNode[],
  scope: Scope,
  ctx: Ctx,
  leaf: (node: Extract<TNode, { k: "el" } | { k: "text" }>, scope: Scope) => VNode[],
  again: ChildRenderer,
): VNode[] {
  const out: VNode[] = [];
  for (const node of nodes) {
    try {
      switch (node.k) {
        case "decl":
          declare(node.decl, scope);
          break;
        case "each": {
          const list = evaluate(node.list, scope);
          const items = eachItems(list);
          if (items.length === 0 && node.otherwise) {
            out.push(...again(node.otherwise, scope.child(), ctx));
          }
          for (let i = 0; i < items.length; i += 1) {
            scope.budget.tick();
            const inner = scope.child();
            bindPattern(node.pattern, items[i], inner);
            if (node.index) inner.define(node.index, i);
            out.push(...again(node.children, inner, ctx));
          }
          break;
        }
        case "if": {
          const branch = node.branches.find(
            (b) => b.test === null || truthy(evaluate(b.test, scope)),
          );
          if (branch) out.push(...again(branch.children, scope.child(), ctx));
          break;
        }
        default:
          out.push(...leaf(node, scope));
      }
    } catch (error) {
      if (error instanceof WidgetError && error.line === undefined) error.line = node.line;
      throw error;
    }
  }
  return out;
}

function eachItems(list: Value): Value[] {
  if (Array.isArray(list)) return list;
  if (typeof list === "string") return Array.from(list);
  if (list === null || list === undefined) return [];
  throw new WidgetError("{#each} needs a list");
}

function attrValue(attr: Attr, scope: Scope): Value {
  switch (attr.value.k) {
    case "str":
      return attr.value.v;
    case "bool":
      return true;
    case "expr":
      return evaluate(attr.value.e, scope);
  }
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

const SVG_ELEMENTS = new Map(
  [
    "svg",
    "g",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "path",
    "text",
    "tspan",
    "defs",
    "linearGradient",
    "radialGradient",
    "stop",
    "marker",
    "clipPath",
    "mask",
    "pattern",
    "title",
  ].map((name) => [name.toLowerCase(), name]),
);

// Present in real-world SVG, harmless to skip, and never rendered on their own.
const SVG_SKIPPED = new Set(["desc", "metadata", "sodipodi:namedview", "filter", "style"]);

const SVG_ATTRS_KEBAB = [
  "alignment-baseline",
  "baseline-shift",
  "clip-path",
  "clip-rule",
  "color",
  "dominant-baseline",
  "fill",
  "fill-opacity",
  "fill-rule",
  "font-family",
  "font-size",
  "font-style",
  "font-variant",
  "font-weight",
  "letter-spacing",
  "marker-end",
  "marker-mid",
  "marker-start",
  "mask",
  "opacity",
  "paint-order",
  "shape-rendering",
  "stop-color",
  "stop-opacity",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "text-anchor",
  "text-decoration",
  "text-rendering",
  "vector-effect",
  "visibility",
  "word-spacing",
  "writing-mode",
];

const SVG_ATTRS_PLAIN = [
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "fx",
  "fy",
  "dx",
  "dy",
  "d",
  "points",
  "width",
  "height",
  "transform",
  "rotate",
  "offset",
  "id",
  "role",
  "orient",
  "viewBox",
  "preserveAspectRatio",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "markerWidth",
  "markerHeight",
  "markerUnits",
  "refX",
  "refY",
  "clipPathUnits",
  "maskUnits",
  "maskContentUnits",
  "patternUnits",
  "patternContentUnits",
  "patternTransform",
  "textLength",
  "lengthAdjust",
  "pathLength",
  "aria-label",
  "aria-hidden",
];

/** Attribute names as written (camelCase JSX, kebab SVG, either case) → SVG name. */
const SVG_ATTR_NAMES = new Map<string, string>();
for (const name of SVG_ATTRS_KEBAB) {
  SVG_ATTR_NAMES.set(name, name);
  SVG_ATTR_NAMES.set(
    name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()),
    name,
  );
}
for (const name of SVG_ATTRS_PLAIN) {
  SVG_ATTR_NAMES.set(name, name);
  SVG_ATTR_NAMES.set(name.toLowerCase(), name);
}

const PAINT_ATTRS = new Set(["fill", "stroke", "stop-color", "color"]);
const REFERENCE_ATTRS = new Set(["clip-path", "mask", "marker-start", "marker-mid", "marker-end"]);
// Dropped without complaint: namespace declarations, editor metadata, JSX keys
// and anything a browser would have ignored anyway. Event handlers are dropped
// too; a static figure has nothing to run them.
const SVG_DROPPED =
  /^(xmlns(:.*)?|version|xml:.*|key|class|className|baseProfile|enable-background|data-.*|on.*|inkscape:.*|sodipodi:.*)$/i;

const ID = /^[A-Za-z_][\w.-]{0,100}$/;
const NAMED_COLORS = new Set(
  (
    "black white gray grey silver red maroon orange yellow olive lime green teal aqua cyan blue navy " +
    "purple fuchsia magenta pink brown gold indigo violet coral salmon crimson tomato orchid tan " +
    "khaki beige ivory lavender plum turquoise skyblue steelblue slategray slategrey darkgray darkgrey " +
    "lightgray lightgrey dimgray dimgrey darkblue darkgreen darkred lightblue lightgreen royalblue " +
    "seagreen forestgreen firebrick chocolate sienna peru goldenrod darkorange orangered hotpink " +
    "deeppink mediumpurple rebeccapurple slateblue dodgerblue cornflowerblue deepskyblue cadetblue " +
    "darkcyan lightseagreen mediumseagreen limegreen yellowgreen olivedrab darkslategray darkslategrey " +
    "gainsboro whitesmoke snow honeydew mintcream azure aliceblue ghostwhite seashell linen"
  ).split(/\s+/),
);

/** A CSS colour literal: hex, rgb()/hsl() with plain numbers, or a named colour. */
export function isColor(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(v)) return true;
  if (/^(?:rgb|rgba|hsl|hsla)\(\s*[-\d.%\s,/deg]+\)$/.test(v)) return true;
  if (v === "transparent" || v === "currentcolor") return true;
  return NAMED_COLORS.has(v);
}

function svgValue(name: string, raw: string): string | null {
  const value = raw.trim();
  if (value.length > 50_000) throw new WidgetError(`value of ${name} is too long`);
  // Control characters, including the id marker, never belong in a value.
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      throw new WidgetError(`bad value for ${name}`);
    }
  }
  if (name === "id") {
    if (!ID.test(value)) throw new WidgetError(`bad id "${value}"`);
    return ID_MARK + value;
  }
  if (PAINT_ATTRS.has(name)) {
    if (value === "none" || value === "inherit") return value;
    const ref = /^url\(\s*#([A-Za-z_][\w.-]*)\s*\)$/.exec(value);
    if (ref) return `url(#${ID_MARK}${ref[1]})`;
    if (isColor(value)) return value.toLowerCase() === "currentcolor" ? "currentColor" : value;
    throw new WidgetError(`bad colour for ${name}: "${value}"`);
  }
  if (REFERENCE_ATTRS.has(name)) {
    if (value === "none") return value;
    const ref = /^url\(\s*#([A-Za-z_][\w.-]*)\s*\)$/.exec(value);
    if (ref) return `url(#${ID_MARK}${ref[1]})`;
    throw new WidgetError(`${name} may only reference an element of the figure`);
  }
  if (name === "font-family") {
    if (!/^[\w\s,'"-]*$/.test(value)) throw new WidgetError("bad font-family");
    return value;
  }
  // Every remaining attribute is a number, a list of numbers, a keyword or path
  // data. None of them may smuggle in a reference, a script URL or markup.
  if (/url\s*\(|javascript:|expression\s*\(|[<>"\\]/i.test(value)) {
    throw new WidgetError(`bad value for ${name}`);
  }
  return value;
}

function svgAttrText(value: Value): string | null {
  if (value === null || value === undefined || value === false) return null;
  if (value === true) return "";
  return toText(value);
}

/** `style` on an SVG element: kept only for the presentation properties above. */
function svgStyle(value: Value): [string, string][] {
  const out: [string, string][] = [];
  const add = (prop: string, raw: Value) => {
    const name = SVG_ATTR_NAMES.get(prop.trim()) ?? SVG_ATTR_NAMES.get(prop.trim().toLowerCase());
    if (!name || !SVG_ATTRS_KEBAB.includes(name)) return;
    const text = svgAttrText(raw);
    if (text === null) return;
    const checked = svgValue(name, text);
    if (checked !== null) out.push([name, checked]);
  };
  if (typeof value === "string") {
    for (const decl of value.split(";")) {
      const colon = decl.indexOf(":");
      if (colon > 0) add(decl.slice(0, colon), decl.slice(colon + 1));
    }
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) add(k, v as Value);
  }
  return out;
}

function renderSvgElement(node: Extract<TNode, { k: "el" }>, scope: Scope, ctx: Ctx): VNode[] {
  const lower = node.tag.toLowerCase();
  if (SVG_SKIPPED.has(lower)) return [];
  const tag = SVG_ELEMENTS.get(lower);
  if (!tag) throw new WidgetError(`<${node.tag}> is not supported inside <svg>`, node.line);
  const attrs: [string, string][] = [];
  for (const attr of node.attrs) {
    if (SVG_DROPPED.test(attr.name)) continue;
    if (attr.name === "style") {
      attrs.push(...svgStyle(attrValue(attr, scope)));
      continue;
    }
    const name = SVG_ATTR_NAMES.get(attr.name) ?? SVG_ATTR_NAMES.get(attr.name.toLowerCase());
    if (!name) {
      if (/^(x?link:)?href$/i.test(attr.name)) {
        throw new WidgetError(
          "links and external references are not allowed in figures",
          node.line,
        );
      }
      // Unknown presentation attributes do nothing in a browser either.
      continue;
    }
    const text = svgAttrText(attrValue(attr, scope));
    if (text === null) continue;
    const value = svgValue(name, text);
    if (value !== null) attrs.push([name, value]);
  }
  const inText = tag === "text" || tag === "tspan" || tag === "title";
  ctx.depth += 1;
  if (ctx.depth > MAX_DEPTH) throw new WidgetError("figure is nested too deeply", node.line);
  const children = renderSvgChildren(node.children, scope, ctx, inText, tag);
  ctx.depth -= 1;
  return [el(ctx, tag, true, attrs, children)];
}

function renderSvgChildren(
  nodes: TNode[],
  scope: Scope,
  ctx: Ctx,
  inText: boolean,
  tag: string,
): VNode[] {
  return expand(
    nodes,
    scope,
    ctx,
    (child, s) => {
      if (child.k === "text") {
        const text = textOf(child, s, false);
        // Text outside <text> is never painted; whitespace between tags is layout.
        return inText && text ? [{ t: "text", text }] : [];
      }
      if (tag === "title") throw new WidgetError("<title> holds text only", child.line);
      return renderSvgElement(child, s, ctx);
    },
    (inner, s, c) => renderSvgChildren(inner, s, c, inText, tag),
  );
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

// Interpolated values are data, not Markdown: "a*b" from a list must not open
// emphasis. CommonMark lets any ASCII punctuation be backslash-escaped.
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~&]/g, "\\$&");
}

function textOf(node: Extract<TNode, { k: "text" }>, scope: Scope, markdown: boolean): string {
  let out = "";
  for (const part of node.parts) {
    if (typeof part === "string") out += part;
    else {
      const value = evaluate(part, scope);
      if (isSetter(value) || isHandler(value))
        throw new WidgetError("a function cannot be shown as text");
      const text = toText(value);
      out += markdown ? escapeMarkdown(text) : text;
    }
  }
  return out;
}

/** Remove the indentation the markup nesting gave a text run. */
function dedent(text: string): string {
  const lines = text.replace(/\t/g, "  ").split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return "";
  // The first line of a run often starts right after a tag, without indentation.
  const indents = lines
    .slice(1)
    .filter((l) => l.trim())
    .map((l) => /^ */.exec(l)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines
    .map((l, i) =>
      i === 0 ? l.trim() : l.slice(Math.min(cut, /^ */.exec(l)![0].length)).trimEnd(),
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// Layout components
// ---------------------------------------------------------------------------

/** Spacing steps (`padding={2}`, `gap={3}`) in CSS pixels. */
const SPACE_UNIT = 6;
const RADII: Record<string, string> = {
  none: "0",
  xs: "3px",
  sm: "4px",
  md: "8px",
  lg: "12px",
  xl: "16px",
  "2xl": "20px",
  full: "9999px",
};
const BACKGROUNDS: Record<string, string> = {
  surface: "var(--mdw-surface)",
  "surface-secondary": "var(--mdw-surface-2)",
  "surface-tertiary": "var(--mdw-surface-3)",
  "surface-elevated": "var(--mdw-surface-3)",
  transparent: "transparent",
  none: "transparent",
};
const TEXT_COLORS: Record<string, string> = {
  primary: "inherit",
  default: "inherit",
  secondary: "var(--mdw-muted)",
  tertiary: "var(--mdw-faint)",
  muted: "var(--mdw-muted)",
  success: "var(--mdw-success)",
  warning: "var(--mdw-warning)",
  danger: "var(--mdw-danger)",
  error: "var(--mdw-danger)",
  info: "var(--mdw-info)",
  accent: "var(--mdw-info)",
};
const FONT_SIZES: Record<string, string> = {
  xs: "0.75em",
  sm: "0.875em",
  md: "1em",
  base: "1em",
  lg: "1.15em",
  xl: "1.4em",
  "2xl": "1.75em",
  "3xl": "2.1em",
};
const WEIGHTS: Record<string, string> = {
  light: "300",
  normal: "400",
  regular: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
};
const ALIGN: Record<string, string> = {
  start: "flex-start",
  left: "flex-start",
  top: "flex-start",
  center: "center",
  middle: "center",
  end: "flex-end",
  right: "flex-end",
  bottom: "flex-end",
  stretch: "stretch",
  baseline: "baseline",
};
const JUSTIFY: Record<string, string> = {
  ...ALIGN,
  between: "space-between",
  "space-between": "space-between",
  around: "space-around",
  "space-around": "space-around",
  evenly: "space-evenly",
  "space-evenly": "space-evenly",
};
const TEXT_ALIGN: Record<string, string> = {
  left: "left",
  start: "start",
  center: "center",
  right: "right",
  end: "end",
  justify: "justify",
};

interface Out {
  classes: string[];
  style: string[];
  attrs: [string, string][];
}

type Prop = (value: Value, out: Out, name: string) => void;

function bad(name: string, value: Value): never {
  throw new WidgetError(
    `bad value for ${name}: ${JSON.stringify(typeof value === "object" ? toText(value) : value)}`,
  );
}

function keyword(table: Record<string, string>, cssProp: string): Prop {
  return (value, out, name) => {
    const css = typeof value === "string" ? table[value] : undefined;
    if (css === undefined) bad(name, value);
    out.style.push(`${cssProp}:${css}`);
  };
}

function number(value: Value, name: string, min: number, max: number): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n) || n < min || n > max) bad(name, value);
  return n;
}

function space(cssProp: string): Prop {
  return (value, out, name) => {
    out.style.push(`${cssProp}:${number(value, name, 0, 20) * SPACE_UNIT}px`);
  };
}

/** `width={120}`, `width="40%"`, `width={`${p}%`}`, `width="full"`. */
function length(cssProp: string): Prop {
  return (value, out, name) => {
    if (typeof value === "number") {
      out.style.push(`${cssProp}:${number(value, name, 0, 4000)}px`);
      return;
    }
    if (typeof value === "string") {
      const v = value.trim();
      if (v === "full") return void out.style.push(`${cssProp}:100%`);
      if (v === "auto") return void out.style.push(`${cssProp}:auto`);
      const m = /^(\d+(?:\.\d+)?)(px|%|em|rem)?$/.exec(v);
      if (m) {
        const n = Number(m[1]);
        const unit = m[2] ?? "px";
        const limit = unit === "%" ? 100 : unit === "px" ? 4000 : 200;
        out.style.push(`${cssProp}:${Math.min(n, limit)}${unit}`);
        return;
      }
    }
    bad(name, value);
  };
}

function flag(className: string): Prop {
  return (value, out) => {
    if (truthy(value)) out.classes.push(className);
  };
}

function paint(table: Record<string, string>, cssProp: string): Prop {
  return (value, out, name) => {
    if (typeof value !== "string") bad(name, value);
    const css = table[value] ?? (isColor(value) ? value : undefined);
    if (css === undefined) bad(name, value);
    out.style.push(`${cssProp}:${css}`);
  };
}

const BORDER: Prop = (value, out, name) => {
  if (value === true || value === "default" || value === "") {
    out.classes.push("mdw-bordered");
  } else if (value === "strong") {
    out.classes.push("mdw-bordered", "mdw-border-strong");
  } else if (typeof value === "string" && (TEXT_COLORS[value] || isColor(value))) {
    out.classes.push("mdw-bordered");
    out.style.push(`border-color:${TEXT_COLORS[value] ?? value}`);
  } else if (value === false || value === "none") {
    out.style.push("border:none");
  } else {
    bad(name, value);
  }
};

const RADIUS: Prop = (value, out, name) => {
  if (typeof value === "number") {
    out.style.push(`border-radius:${number(value, name, 0, 999)}px`);
    return;
  }
  const css = typeof value === "string" ? RADII[value] : undefined;
  if (css === undefined) bad(name, value);
  out.style.push(`border-radius:${css}`);
};

const FLEX: Prop = (value, out, name) => {
  if (value === true) return void out.style.push("flex:1 1 0", "min-width:0");
  out.style.push(`flex:${number(value, name, 0, 100)} 1 0`, "min-width:0");
};

const COMMON_TEXT: Record<string, Prop> = {
  weight: keyword(WEIGHTS, "font-weight"),
  size: keyword(FONT_SIZES, "font-size"),
  color: paint(TEXT_COLORS, "color"),
  textAlign: keyword(TEXT_ALIGN, "text-align"),
  align: keyword(TEXT_ALIGN, "text-align"),
  tabularNums: flag("mdw-tabular"),
  italic: flag("mdw-italic"),
  truncate: flag("mdw-truncate"),
  maxLines: () => {},
};

const CONTAINER: Record<string, Prop> = {
  gap: space("gap"),
  padding: space("padding"),
  paddingX: (v, out, n) => {
    const px = number(v, n, 0, 20) * SPACE_UNIT;
    out.style.push(`padding-left:${px}px`, `padding-right:${px}px`);
  },
  paddingY: (v, out, n) => {
    const px = number(v, n, 0, 20) * SPACE_UNIT;
    out.style.push(`padding-top:${px}px`, `padding-bottom:${px}px`);
  },
  background: paint(BACKGROUNDS, "background"),
  border: BORDER,
  radius: RADIUS,
  align: keyword(ALIGN, "align-items"),
  justify: keyword(JUSTIFY, "justify-content"),
  flex: FLEX,
  width: length("width"),
  height: length("height"),
  minWidth: length("min-width"),
  maxWidth: length("max-width"),
  minHeight: length("min-height"),
  color: paint(TEXT_COLORS, "color"),
  wrap: flag("mdw-wrap"),
};

/** `align="center"` on a box also centres its text, as the assistants render it. */
const BOX_ALIGN: Prop = (value, out, name) => {
  CONTAINER.align(value, out, name);
  if (value === "center") out.style.push("text-align:center");
  else if (value === "end" || value === "right") out.style.push("text-align:right");
};

interface Component {
  tag: string;
  cls: string;
  props: Record<string, Prop>;
  /** Children are inline text, not layout: no Markdown block parsing. */
  inline?: boolean;
  /** Takes no children. */
  empty?: boolean;
  render?: (props: Record<string, Value>, out: Out, ctx: Ctx, line: number) => VNode[];
}

const COMPONENTS: Record<string, Component> = {
  card: { tag: "div", cls: "mdw-card", props: { ...CONTAINER, align: BOX_ALIGN } },
  box: {
    tag: "div",
    cls: "mdw-box",
    props: {
      ...CONTAINER,
      align: BOX_ALIGN,
      direction: keyword({ row: "row", column: "column", col: "column" }, "flex-direction"),
    },
  },
  row: { tag: "div", cls: "mdw-row", props: CONTAINER },
  column: { tag: "div", cls: "mdw-col", props: { ...CONTAINER, align: BOX_ALIGN } },
  col: { tag: "div", cls: "mdw-col", props: { ...CONTAINER, align: BOX_ALIGN } },
  stack: { tag: "div", cls: "mdw-col", props: { ...CONTAINER, align: BOX_ALIGN } },
  grid: {
    tag: "div",
    cls: "mdw-grid",
    props: {
      ...CONTAINER,
      columns: (v, out, n) => {
        out.style.push(`grid-template-columns:repeat(${number(v, n, 1, 12)},minmax(0,1fr))`);
      },
    },
  },
  "grid-item": {
    tag: "div",
    cls: "mdw-grid-item",
    props: {
      ...CONTAINER,
      align: BOX_ALIGN,
      span: (v, out, n) => void out.style.push(`grid-column:span ${number(v, n, 1, 12)}`),
      colSpan: (v, out, n) => void out.style.push(`grid-column:span ${number(v, n, 1, 12)}`),
    },
  },
  text: { tag: "div", cls: "mdw-text", props: COMMON_TEXT },
  title: { tag: "div", cls: "mdw-title", props: COMMON_TEXT },
  heading: { tag: "div", cls: "mdw-title", props: COMMON_TEXT },
  label: { tag: "div", cls: "mdw-label", props: COMMON_TEXT },
  caption: { tag: "div", cls: "mdw-caption", props: COMMON_TEXT },
  badge: {
    tag: "span",
    cls: "mdw-badge",
    props: { ...COMMON_TEXT, color: paint(TEXT_COLORS, "--mdw-badge"), variant: () => {} },
    inline: true,
  },
  spacer: { tag: "div", cls: "mdw-spacer", props: { size: space("flex-basis") }, empty: true },
  divider: {
    tag: "div",
    cls: "mdw-divider",
    props: { spacing: space("margin-block") },
    empty: true,
  },
  icon: {
    tag: "span",
    cls: "mdw-icon",
    props: {
      name: () => {},
      color: paint(TEXT_COLORS, "color"),
      size: keyword({ xs: "12px", sm: "14px", md: "18px", lg: "22px", xl: "28px" }, "--mdw-icon"),
    },
    empty: true,
    render: (props, _out, ctx) => iconNodes(props.name, ctx),
  },
  slider: {
    tag: "div",
    cls: "mdw-slider",
    props: {
      value: () => {},
      min: () => {},
      max: () => {},
      step: () => {},
      onChange: handler,
      label: () => {},
      disabled: () => {},
    },
    empty: true,
    render: (props, out, ctx) => sliderNodes(props, out, ctx),
  },
  "segmented-control": {
    tag: "div",
    cls: "mdw-segmented",
    props: { value: () => {}, options: () => {}, onChange: handler, size: () => {} },
    empty: true,
    render: (props, out, ctx) => segmentedNodes(props, out, ctx),
  },
};

// Plain inline HTML that assistants mix into component text.
const INLINE_HTML = new Set([
  "strong",
  "b",
  "em",
  "i",
  "code",
  "span",
  "small",
  "sub",
  "sup",
  "br",
  "mark",
  "s",
  "u",
]);

/** `onChange` and friends: accepted only when they point at state, and inert. */
function handler(value: Value, _out: Out, name: string): void {
  if (isSetter(value) || isHandler(value)) return;
  throw new WidgetError(`${name} must name a state setter`);
}

const IGNORED_PROPS = new Set(["key", "id"]);

function renderComponent(node: Extract<TNode, { k: "el" }>, scope: Scope, ctx: Ctx): VNode[] {
  if (node.tag === "svg") return renderSvgElement(node, scope, ctx);
  if (INLINE_HTML.has(node.tag)) {
    if (node.attrs.length) throw new WidgetError(`<${node.tag}> takes no attributes`, node.line);
    const children = renderInlineChildren(node.children, scope, ctx);
    return [el(ctx, node.tag, false, [], children)];
  }
  const spec = COMPONENTS[node.tag];
  if (!spec) throw new WidgetError(`unknown component <${node.tag}>`, node.line);
  const out: Out = { classes: [spec.cls], style: [], attrs: [] };
  const values: Record<string, Value> = Object.create(null) as Record<string, Value>;
  for (const attr of node.attrs) {
    if (IGNORED_PROPS.has(attr.name)) continue;
    const prop = spec.props[attr.name];
    if (!prop) {
      if (/^on[A-Z]/.test(attr.name)) {
        handler(attrValue(attr, scope), out, attr.name);
        continue;
      }
      throw new WidgetError(`<${node.tag}> has no property "${attr.name}"`, node.line);
    }
    const value = attrValue(attr, scope);
    values[attr.name] = value;
    try {
      prop(value, out, attr.name);
    } catch (error) {
      if (error instanceof WidgetError && error.line === undefined) error.line = node.line;
      throw error;
    }
  }
  let children: VNode[];
  if (spec.render) {
    if (
      node.children.some(
        (c) => c.k !== "text" || c.parts.some((p) => typeof p !== "string" || p.trim()),
      )
    ) {
      throw new WidgetError(`<${node.tag}> takes no content`, node.line);
    }
    children = spec.render(values, out, ctx, node.line);
  } else if (spec.empty) {
    if (
      node.children.some(
        (c) => c.k !== "text" || c.parts.some((p) => typeof p !== "string" || p.trim()),
      )
    ) {
      throw new WidgetError(`<${node.tag}> takes no content`, node.line);
    }
    children = [];
  } else if (spec.inline) {
    children = renderInlineChildren(node.children, scope, ctx);
  } else {
    ctx.depth += 1;
    if (ctx.depth > MAX_DEPTH) throw new WidgetError("figure is nested too deeply", node.line);
    children = renderLayoutChildren(node.children, scope, ctx);
    ctx.depth -= 1;
  }
  const attrs: [string, string][] = [["class", out.classes.join(" ")]];
  if (out.style.length) attrs.push(["style", out.style.join(";")]);
  attrs.push(...out.attrs);
  return [el(ctx, spec.tag, false, attrs, children)];
}

function renderLayoutChildren(nodes: TNode[], scope: Scope, ctx: Ctx): VNode[] {
  const out = expand(
    nodes,
    scope,
    ctx,
    (node, s) => {
      if (node.k === "text") {
        const text = dedent(textOf(node, s, true));
        return text ? [{ t: "md", text }] : [];
      }
      return renderComponent(node, s, ctx);
    },
    renderLayoutChildren,
  );
  // `{#each}` splits a text run around its blocks; adjacent runs read as one.
  const merged: VNode[] = [];
  for (const node of out) {
    const last = merged[merged.length - 1];
    if (node.t === "md" && last?.t === "md") last.text += ` ${node.text}`;
    else merged.push(node);
  }
  return merged;
}

function renderInlineChildren(nodes: TNode[], scope: Scope, ctx: Ctx): VNode[] {
  return expand(
    nodes,
    scope,
    ctx,
    (node, s) => {
      if (node.k === "text") {
        const text = textOf(node, s, false).replace(/\s+/g, " ");
        return text ? [{ t: "text", text }] : [];
      }
      if (!INLINE_HTML.has(node.tag))
        throw new WidgetError(`<${node.tag}> cannot appear inside text`, node.line);
      return renderComponent(node, s, ctx);
    },
    renderInlineChildren,
  );
}

// ---------------------------------------------------------------------------
// Icons and static controls
// ---------------------------------------------------------------------------

function iconNodes(name: Value, ctx: Ctx): VNode[] {
  const paths = typeof name === "string" ? ICONS[name] : undefined;
  if (!paths) return [];
  const children = paths.map((d) => el(ctx, "path", true, [["d", d]], []));
  return [
    el(
      ctx,
      "svg",
      true,
      [
        ["viewBox", "0 0 24 24"],
        ["fill", "none"],
        ["stroke", "currentColor"],
        ["stroke-width", "2"],
        ["stroke-linecap", "round"],
        ["stroke-linejoin", "round"],
        ["aria-hidden", "true"],
      ],
      children,
    ),
  ];
}

function sliderNodes(props: Record<string, Value>, out: Out, ctx: Ctx): VNode[] {
  const min = props.min === undefined ? 0 : number(props.min, "min", -1e9, 1e9);
  const max = props.max === undefined ? 100 : number(props.max, "max", -1e9, 1e9);
  const value = props.value === undefined ? min : number(props.value, "value", -1e12, 1e12);
  const span = max - min;
  const pct = span > 0 ? Math.min(100, Math.max(0, ((value - min) / span) * 100)) : 0;
  const shown = Math.round(pct * 100) / 100;
  out.attrs.push(
    ["role", "img"],
    ["aria-label", `Slider at ${toText(value)} (${toText(min)} to ${toText(max)})`],
  );
  return [
    el(
      ctx,
      "div",
      false,
      [["class", "mdw-slider-track"]],
      [
        el(
          ctx,
          "div",
          false,
          [
            ["class", "mdw-slider-fill"],
            ["style", `width:${shown}%`],
          ],
          [],
        ),
        el(
          ctx,
          "div",
          false,
          [
            ["class", "mdw-slider-thumb"],
            ["style", `left:${shown}%`],
          ],
          [],
        ),
      ],
    ),
  ];
}

function segmentedNodes(props: Record<string, Value>, out: Out, ctx: Ctx): VNode[] {
  const options = props.options;
  if (!Array.isArray(options) || options.length === 0 || options.length > 20) {
    throw new WidgetError("segmented-control needs a list of options");
  }
  const selected = props.value;
  const items = options.map((option) => {
    let label: Value;
    let value: Value;
    if (option && typeof option === "object" && !Array.isArray(option)) {
      const record = option as Record<string, Value>;
      label = record.label ?? record.value;
      value = record.value ?? record.label;
    } else {
      label = option;
      value = option;
    }
    const isSelected =
      value === selected ||
      (value != null && selected != null && toText(value) === toText(selected));
    return el(
      ctx,
      "span",
      false,
      [["class", isSelected ? "mdw-segment mdw-segment-selected" : "mdw-segment"]],
      [{ t: "text", text: toText(label) }],
    );
  });
  out.attrs.push(["role", "img"], ["aria-label", `Options, ${toText(selected)} selected`]);
  return items;
}
