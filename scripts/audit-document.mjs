// Audit how a real document rendered in the running window.
//
//   node scripts/audit-document.mjs 9222 [label]
//
// Reports what the render pipeline produced and, more importantly, what it left
// behind: unconsumed `$` delimiters, unextracted LaTeX environments and KaTeX
// errors are the signals that matter on real-world documents.
const PORT = Number(process.argv[2] ?? 9222);
const LABEL = process.argv[3] ?? "document";

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) {
  console.error("no page target");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) => {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((r) => pending.set(id, r));
};
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 700));
  }
  const v = r.result.result.value;
  return typeof v === "string" ? JSON.parse(v) : v;
};

await new Promise((r) => ws.addEventListener("open", r));
await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 4000)); // let mermaid finish

const report = await evaluate(`(() => {
  const q = (sel) => document.querySelectorAll(sel).length;
  const preview = document.getElementById('preview');
  const text = preview.innerText ?? '';

  // Every text node, so leftovers can be located in context and classified by
  // whether they sit inside a code element.
  const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);

  const samples = (needle, limit) => {
    const out = [];
    for (const node of nodes) {
      const value = node.nodeValue ?? '';
      let at = value.indexOf(needle);
      while (at !== -1 && out.length < limit) {
        out.push(value.slice(Math.max(0, at - 45), at + 45).replace(/\\s+/g, ' ').trim());
        at = value.indexOf(needle, at + needle.length);
      }
      if (out.length >= limit) break;
    }
    return out;
  };

  const katexErrors = [...preview.querySelectorAll('.katex-error')]
    .slice(0, 4)
    .map((el) => (el.getAttribute('title') || el.textContent || '').slice(0, 160));

  // A dollar sign inside a code span or fence is correct output, not a failure:
  // it is a shell variable or a language sigil and must stay literal.
  const inCode = (node) => {
    for (let el = node.parentElement; el; el = el.parentElement) {
      if (el.tagName === 'CODE' || el.tagName === 'PRE') return true;
    }
    return false;
  };
  let strayInProse = 0;
  let strayInCode = 0;
  const proseSamples = [];
  for (const node of nodes) {
    const value = node.nodeValue ?? '';
    const count = (value.match(/\\$/g) ?? []).length;
    if (count === 0) continue;
    if (inCode(node)) {
      strayInCode += count;
    } else {
      strayInProse += count;
      if (proseSamples.length < 6) {
        const at = value.indexOf('$');
        proseSamples.push(value.slice(Math.max(0, at - 45), at + 45).replace(/\\s+/g, ' ').trim());
      }
    }
  }

  const anchors = [...preview.querySelectorAll('[data-line]')].map((a) => Number(a.dataset.line));
  let monotonic = true;
  for (let i = 1; i < anchors.length; i++) if (anchors[i] < anchors[i - 1]) monotonic = false;

  return JSON.stringify({
    title: document.title,
    previewChildren: preview.children.length,
    textChars: text.length,

    katexInline: q('#preview .math-inline .katex'),
    katexDisplay: q('#preview .math-display .katex'),
    ownMathErrors: q('#preview .math-error'),
    katexErrors: q('#preview .katex-error'),
    katexErrorSamples: katexErrors,

    strayDollarsInProse: strayInProse,
    proseSamples,
    strayDollarsInCode: strayInCode,
    strayBeginEnv: (text.match(/\\\\begin\\{/g) ?? []).length,
    beginSamples: samples('\\\\begin{', 3),
    strayBackslashParen: (text.match(/\\\\\\(/g) ?? []).length,

    mermaidBlocks: q('#preview .mermaid'),
    mermaidSvg: q('#preview .mermaid svg'),
    mermaidErrors: q('#preview .mermaid-error'),
    mermaidErrorSamples: [...preview.querySelectorAll('.mermaid-error')].slice(0, 2).map((e) => e.textContent.slice(0, 160)),

    tables: q('#preview table'),
    tableRows: q('#preview table tr'),
    codeBlocks: q('#preview pre code'),
    highlighted: q('#preview pre code.hljs'),

    anchors: anchors.length,
    anchorsMonotonic: monotonic,
    firstAnchor: anchors[0] ?? null,
    lastAnchor: anchors[anchors.length - 1] ?? null
  });
})()`);

console.log(`=== ${LABEL} ===`);
for (const [key, value] of Object.entries(report)) {
  if (Array.isArray(value)) {
    console.log(`  ${key}:`);
    if (value.length === 0) console.log("    (none)");
    for (const item of value) console.log(`    · ${item}`);
  } else {
    console.log(`  ${key.padEnd(20)} ${value}`);
  }
}

ws.close();
process.exit(0);
