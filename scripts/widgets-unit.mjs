// Unit tests for chat-assistant figures in fenced code blocks.
//
//   node scripts/widgets-unit.mjs
//
// `src/widgets/` compiles a fence to a validated node tree without touching the
// DOM, so Node 24 runs it directly. The fixtures in samples/chat-figures.md are
// read by position; hostile inputs are inline so the attack is visible here.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileWidget, figureMode } from "../src/widgets/index.ts";

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const sample = readFileSync(
  fileURLToPath(new URL("../samples/chat-figures.md", import.meta.url)),
  "utf8",
);
const fences = Array.from(sample.matchAll(/^```(\w*)\r?\n([\s\S]*?)^```\r?$/gm)).map((m) => ({
  lang: m[1],
  src: m[2],
}));

function walk(nodes, visit) {
  for (const node of nodes) {
    visit(node);
    if (node.t === "el") walk(node.children, visit);
  }
}
function count(nodes, pred) {
  let n = 0;
  walk(nodes, (node) => {
    if (pred(node)) n += 1;
  });
  return n;
}
function texts(nodes) {
  const out = [];
  walk(nodes, (node) => {
    if (node.t !== "el") out.push(node.text);
  });
  return out;
}
function attrs(nodes) {
  const out = [];
  walk(nodes, (node) => {
    if (node.t === "el") for (const [name, value] of node.attrs) out.push([node.tag, name, value]);
  });
  return out;
}
const tag = (name) => (node) => node.t === "el" && node.tag === name;
const fixture = (n) => compileWidget(fences[n - 1].src, fences[n - 1].lang);
function errorOf(src, lang = "") {
  const r = compileWidget(src, lang);
  return r.kind === "error" ? r : null;
}

console.log("Fixtures");
check(fences.length === 8, "sample has eight fences", String(fences.length));

{
  const r = fixture(1);
  check(r.kind === "ok", "template SVG renders", r.message);
  if (r.kind === "ok") {
    check(
      count(r.nodes, tag("rect")) === 10,
      "each expands to 10 rects",
      String(count(r.nodes, tag("rect"))),
    );
    check(count(r.nodes, tag("path")) === 7, "each expands to 7 paths");
    const ys = attrs(r.nodes)
      .filter(([t, n]) => t === "rect" && n === "y")
      .map(([, , v]) => v);
    check(ys.includes("76") && ys.includes("123"), "y={29+i*47} evaluates per item", ys.join(","));
    const names = new Set(attrs(r.nodes).map(([, n]) => n));
    check(
      names.has("fill-opacity") && names.has("text-anchor") && names.has("stroke-dasharray"),
      "camelCase attributes become SVG names",
    );
    check(!names.has("fillOpacity") && !names.has("textAnchor"), "no camelCase attribute survives");
    const d = attrs(r.nodes)
      .filter(([t, n]) => t === "path" && n === "d")
      .map(([, , v]) => v);
    check(d.includes("M170 106 v13 m-4 -4 l4 4 4 -4"), "template literal path data", d[1]);
  }
}
{
  const r = fixture(2);
  check(r.kind === "ok", "layout components render", r.message);
  if (r.kind === "ok") {
    check(
      count(r.nodes, (n) => n.t === "el" && /\bmdw-icon\b/.test(n.attrs[0]?.[1] ?? "")) === 5,
      "five arrow icons",
    );
    check(
      texts(r.nodes).includes("**Dense retrieval**"),
      "Markdown text run is kept for the builder",
    );
    const grid = attrs(r.nodes).find(
      ([, n, v]) => n === "style" && v.includes("grid-template-columns"),
    );
    check(!!grid && grid[2].includes("repeat(2,"), "grid columns={2}", grid?.[2]);
    check(
      attrs(r.nodes).some(([, n, v]) => n === "style" && v.includes("padding:18px")),
      "padding={3} is three spacing steps",
    );
  }
}
{
  const r = fixture(3);
  check(r.kind === "ok", "template SVG with caption renders", r.message);
  if (r.kind === "ok") {
    check(
      count(r.nodes, tag("rect")) === 10,
      "3 + 6 boxes + header = 10 rects",
      String(count(r.nodes, tag("rect"))),
    );
    check(
      count(r.nodes, tag("path")) === 9,
      "{#if i<5} draws 5 arrows (9 paths)",
      String(count(r.nodes, tag("path"))),
    );
    const strokes = attrs(r.nodes)
      .filter(([t, n]) => t === "rect" && n === "stroke")
      .map(([, , v]) => v);
    check(strokes.includes("#d97706"), "stroke={b.c} from an object list");
    check(
      texts(r.nodes).some((t) => t.startsWith("Proposed multistage")),
      "caption after the svg",
    );
  }
}
{
  const r = fixture(4);
  check(r.kind === "ok", "interactive block renders as a snapshot", r.message);
  if (r.kind === "ok") {
    const t = texts(r.nodes);
    check(
      t.includes("10,240"),
      "original context 20 × 512",
      t.find((x) => x.includes("240")),
    );
    check(t.filter((x) => x === "5,120").length === 2, "pruned and saved tokens 5,120");
    check(t.includes("2\\.0×"), "compression 2.0× (Markdown-escaped)");
    check(t.includes("**20**") && t.includes("**50%**"), "state values in bold labels");
    const selected = count(
      r.nodes,
      (n) =>
        n.t === "el" &&
        n.attrs.some(([a, v]) => a === "class" && v.includes("mdw-segment-selected")),
    );
    check(selected === 1, "one segment selected");
    const thumb = attrs(r.nodes).find(([, n, v]) => n === "style" && v.startsWith("left:"));
    check(thumb?.[2] === "left:15.79%", "slider thumb at (20-5)/(100-5)", thumb?.[2]);
    check(
      attrs(r.nodes).some(([, n, v]) => n === "style" && v.includes("width:50%")),
      "bar width from template literal",
    );
    const tags = new Set();
    walk(r.nodes, (n) => n.t === "el" && tags.add(n.tag));
    check(!tags.has("input") && !tags.has("button"), "no form controls in the output");
    check(!attrs(r.nodes).some(([, n]) => /^on/i.test(n)), "no event attribute in the output");
  }
}
{
  const r = fixture(5);
  check(r.kind === "ok", "plain svg fence renders", r.message);
  if (r.kind === "ok") {
    const all = attrs(r.nodes);
    check(
      all.some(([t, n, v]) => t === "linearGradient" && n === "id" && v === "\u0000fade"),
      "id is marked for prefixing",
    );
    check(
      all.some(([t, n, v]) => t === "rect" && n === "fill" && v === "url(#\u0000fade)"),
      "url(#id) follows the prefix",
    );
    check(
      texts(r.nodes).some((x) => x.includes("{braces stay}")),
      "braces are text in an svg fence",
    );
    check(!all.some(([, n]) => n.startsWith("xmlns")), "xmlns dropped");
  }
}
{
  const r = fixture(6);
  check(
    r.kind === "error" && r.message.includes("<tabs>") && r.line === 2,
    "unknown component reports name and line",
    `${r.message} @${r.line}`,
  );
}
check(fixture(7).kind === "none", "Svelte source starting with <script> stays code");
check(fixture(8).kind === "none", "JSX source stays code");

console.log("Detection");
check(figureMode("<card>x</card>", "python") === null, "other languages are never figures");
check(figureMode("<div>x</div>", "") === null, "unknown first tag stays code");
check(figureMode("  <!-- c -->\n<box/>", "") === "template", "comment before the root");
check(figureMode("<svg/>", "SVG") === "svg", "language is case-insensitive");
check(figureMode("<card/>", "svg") === null, "svg fence must hold svg");
check(figureMode("<grid columns={2}></grid>", "widget") === "template", "widget language");

console.log("Expressions");
function value(expr, decls = "") {
  const r = compileWidget(`${decls}<box><text>{${expr}}</text></box>`, "");
  if (r.kind !== "ok") return `ERR ${r.message}`;
  return texts(r.nodes)[0];
}
check(value("1+2*3") === "7", "precedence");
check(value("2**3**2") === "512", "right-associative power");
check(value("`a${1+1}b`") === "a2b", "template literal");
check(value("[1,2,3].length") === "3", "array length");
check(value("({a:{b:4}}).a.b") === "4", "nested member");
check(value("x ?? 'd'", "{@const x = null}") === "d", "nullish coalescing");
check(value("1 < 2 ? 'y' : 'n'") === "y", "ternary");
check(value("(1234.5).toLocaleString('de-DE')") === "1\\.234,5", "toLocaleString with locale");
check(value("Math.max(1, 9, 3)") === "9", "Math.max");
check(value("Array.from({length: 3}).length") === "3", "Array.from({length})");
check(value("o?.missing?.deep ?? 'none'", "{@const o = {}}") === "none", "optional chaining");

console.log("Hostile input");
const hostile = [
  ["constructor access", "<box>{[].constructor}</box>", /constructor/],
  ["__proto__ access", "<box>{({}).__proto__}</box>", /__proto__/],
  ["computed constructor", "<box>{({})['constructor']}</box>", /constructor/],
  ["function call", "<box>{alert(1)}</box>", /alert/],
  ["fetch call", "<box>{fetch('https://example.invalid')}</box>", /fetch/],
  ["unknown method", "<box>{'x'.constructor('y')}</box>", /not (allowed|supported)/],
  ["new", "<box>{new Date()}</box>", /new/],
  ["arrow with block body", "<box>{() => { return 1 }}</box>", /block body/],
  [
    "arrow calling a non-setter",
    "{@body const [a,setA]=DIL.useState(1)}<card><slider onChange={v => alert(v)}/></card>",
    /setter/,
  ],
  ["calling a setter", "{@body const [a,setA]=DIL.useState(1)}<box>{setA(2)}</box>", /static/],
  ["script tag", "<card><script>alert(1)</script></card>", /not allowed/],
  ["style tag", "<card><style>*{}</style></card>", /not allowed/],
  ["foreignObject", "<svg><foreignObject><div/></foreignObject></svg>", /not supported/],
  ["image", '<svg><image href="https://example.invalid/x.png"/></svg>', /not supported/],
  ["use", '<svg><use href="#a"/></svg>', /not supported/],
  ["href on path", '<svg><path href="https://example.invalid"/></svg>', /links/],
  ["external url() paint", '<svg><rect fill="url(https://example.invalid/#x)"/></svg>', /colour/],
  ["javascript in transform", '<svg><g transform="javascript:alert(1)"/></svg>', /bad value/],
  ["markup in attribute", '<svg><rect x="1&quot;&gt;"/></svg>', /bad value/],
  ["CSS injection in width", '<box width="10px;background:url(x)"/>', /bad value/],
  ["CSS injection in colour", '<box background="red;position:fixed"/>', /bad value/],
  ["unknown prop", '<box onclick="x" tooltip="t"/>', /setter|no property/],
  [
    "huge each",
    "<svg>{#each Array.from({length: 10000}) as _}{#each Array.from({length: 10000}) as _}<rect/>{/each}{/each}</svg>",
    /too (many|expensive)/,
  ],
  ["huge string", "<box>{'x'.padStart(1000).padStart(1000)}{`${'y'.padEnd(1000)}`}</box>", null],
  ["deep nesting", `${"<box>".repeat(100)}${"</box>".repeat(100)}`, /deeply/],
  ["unclosed tag", "<card><box></card>", /does not close/],
  ["unbalanced braces", "<box>{1+</box>", /./],
];
for (const [label, src, pattern] of hostile) {
  const r = compileWidget(src, "");
  if (pattern === null) {
    check(r.kind === "ok", `${label} stays bounded`, r.message);
    continue;
  }
  check(
    r.kind === "error" && pattern.test(r.message),
    `${label} is refused`,
    r.kind === "error" ? r.message : r.kind,
  );
}
{
  const r = compileWidget('<svg><rect onload="alert(1)" onclick="x" fill="red"/></svg>', "");
  const names = r.kind === "ok" ? attrs(r.nodes).map(([, n]) => n) : [];
  check(
    r.kind === "ok" && !names.some((n) => /^on/i.test(n)),
    "event attributes on SVG are dropped",
    names.join(","),
  );
}
{
  const r = compileWidget('<box>{"**not bold** <b>x</b>"}</box>', "");
  check(
    r.kind === "ok" && texts(r.nodes)[0] === "\\*\\*not bold\\*\\* \\<b\\>x\\</b\\>",
    "interpolated text is escaped for Markdown",
    r.kind === "ok" ? texts(r.nodes)[0] : r.message,
  );
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
