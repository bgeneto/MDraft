//! Preview freshness keys: inputs change a key, non-inputs cannot; no application.
//!
//!   node scripts/preview-freshness-unit.mjs
//!
//! A key that misses an input shows an old preview as current — the one failure
//! the freshness plan treats as unacceptable — so every input listed in
//! docs/architecture.md is changed one at a time
//! here and must change the key. The non-inputs (theme, palette, width, view
//! mode) have no parameter in `src/preview-freshness.ts`; that is checked by the
//! type signatures, not here.
import assert from "node:assert/strict";
import {
  htmlKey,
  latexKey,
  proseKey,
  textFingerprint,
  typstKey,
} from "../src/preview-freshness.ts";

let passed = 0;
function check(label, test) {
  test();
  passed++;
  console.log(`  PASS  ${label}`);
}

/** Each variant changes exactly one input; all keys must be pairwise distinct. */
function distinct(label, base, variants) {
  check(label, () => {
    const keys = [base(), ...variants.map((variant) => variant())];
    assert.equal(base(), base(), "the same inputs give the same key");
    assert.equal(
      new Set(keys).size,
      keys.length,
      `a changed input kept the key: ${keys.join(" | ")}`,
    );
  });
}

const doc = { id: "s1", incarnation: 2 };

check("the fingerprint is stable and length-prefixed", () => {
  assert.equal(textFingerprint("abc"), textFingerprint("abc"));
  assert.match(textFingerprint("abc"), /^3:[0-9a-f]{16}$/);
  assert.equal(textFingerprint(""), textFingerprint(""));
});

check("the fingerprint separates near-identical texts", () => {
  const seen = new Set();
  const base = "# Title\n\nSome paragraph text.\n";
  for (let i = 0; i < base.length; i += 1) {
    for (const replacement of ["x", " ", "\n", "é"]) {
      const text = base.slice(0, i) + replacement + base.slice(i + 1);
      if (text === base) continue;
      seen.add(textFingerprint(text));
    }
    seen.add(textFingerprint(base.slice(0, i) + base.slice(i + 1)));
  }
  seen.add(textFingerprint(base));
  // Every mutation above yields a different text; a collision would shrink the set.
  const texts = new Set();
  for (let i = 0; i < base.length; i += 1) {
    for (const replacement of ["x", " ", "\n", "é"])
      texts.add(base.slice(0, i) + replacement + base.slice(i + 1));
    texts.add(base.slice(0, i) + base.slice(i + 1));
  }
  texts.add(base);
  assert.equal(seen.size, texts.size);
});

check("swapped characters do not collide", () => {
  assert.notEqual(textFingerprint("ab"), textFingerprint("ba"));
  assert.notEqual(textFingerprint("\r\n"), textFingerprint("\n\r"));
});

const prose = { baseDir: "/d", documentPath: "/d/a.md", math: true, mermaid: true };
distinct(
  "Markdown: text, identity, folder, path, math and mermaid are inputs",
  () => proseKey("markdown", doc, "x", prose),
  [
    () => proseKey("markdown", doc, "y", prose),
    () => proseKey("markdown", { ...doc, id: "s2" }, "x", prose),
    () => proseKey("markdown", { ...doc, incarnation: 3 }, "x", prose),
    () => proseKey("markdown", doc, "x", { ...prose, baseDir: "/e" }),
    () => proseKey("markdown", doc, "x", { ...prose, documentPath: "/d/b.md" }),
    () => proseKey("markdown", doc, "x", { ...prose, math: false }),
    () => proseKey("markdown", doc, "x", { ...prose, mermaid: false }),
    () => proseKey("asciidoc", doc, "x", prose),
  ],
);

check("Markdown: an edit undone before the render gives the original key", () => {
  // The revision is deliberately not an input: the text is.
  assert.equal(proseKey("markdown", doc, "same", prose), proseKey("markdown", doc, "same", prose));
});

const html = { baseDir: "/d", name: "a.html", scripts: true, roots: ["/img"] };
distinct(
  "HTML: text, identity, folder, name, scripts and roots are inputs",
  () => htmlKey(doc, "x", html),
  [
    () => htmlKey(doc, "y", html),
    () => htmlKey({ ...doc, incarnation: 9 }, "x", html),
    () => htmlKey(doc, "x", { ...html, baseDir: null }),
    () => htmlKey(doc, "x", { ...html, name: "b.html" }),
    () => htmlKey(doc, "x", { ...html, scripts: false }),
    () => htmlKey(doc, "x", { ...html, roots: [] }),
  ],
);

const typDoc = { ...doc, revision: 4, path: "/d/a.typ" };
const typ = { mode: "document", imageRoot: null };
distinct(
  "Typst: text, revision, path, mode and image root are inputs",
  () => typstKey(typDoc, "x", typ),
  [
    () => typstKey(typDoc, "y", typ),
    () => typstKey({ ...typDoc, revision: 5 }, "x", typ),
    () => typstKey({ ...typDoc, path: "/e/a.typ" }, "x", typ),
    () => typstKey({ ...typDoc, incarnation: 7 }, "x", typ),
    () => typstKey(typDoc, "x", { ...typ, mode: "pages" }),
    () => typstKey(typDoc, "x", { ...typ, imageRoot: "/img" }),
  ],
);

const engine = {
  backend: "native",
  nativeRoot: "C:/texlive",
  nativeDistribution: "TeX Live",
  nativeEngine: "pdflatex",
  nativeWsl: null,
};
distinct(
  "LaTeX: root, digest and every engine field are inputs",
  () => latexKey(doc, "g1", engine),
  [
    () => latexKey(doc, "g2", engine),
    () => latexKey({ ...doc, id: "root2" }, "g1", engine),
    () => latexKey({ ...doc, incarnation: 5 }, "g1", engine),
    () => latexKey(doc, "g1", { ...engine, backend: "bundled" }),
    () => latexKey(doc, "g1", { ...engine, nativeRoot: "C:/miktex" }),
    () => latexKey(doc, "g1", { ...engine, nativeDistribution: "MiKTeX" }),
    () => latexKey(doc, "g1", { ...engine, nativeEngine: "lualatex" }),
    () => latexKey(doc, "g1", { ...engine, nativeWsl: "Ubuntu:/usr/bin" }),
    () => latexKey(doc, "g1", { ...engine, bundledEngine: "xelatex" }),
  ],
);

check("keys of different languages never compare equal", () => {
  const keys = [
    proseKey("markdown", doc, "x", prose),
    proseKey("asciidoc", doc, "x", prose),
    htmlKey(doc, "x", html),
    typstKey(typDoc, "x", typ),
    latexKey(doc, "x", engine),
  ];
  assert.equal(new Set(keys).size, keys.length);
});

console.log(`\n${passed}/${passed} checks passed`);
