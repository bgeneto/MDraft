// Initial labelled corpus for syntax-aware spelling. These checks validate the
// fixtures and fake dictionary; adapter assertions are added with the pipeline.
import { readFileSync } from "node:fs";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { StreamLanguage } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { asciidocLanguage } from "../src/asciidoc-language.ts";
import { typstLanguage } from "../src/typst-language.ts";
import { typstParser } from "codemirror-lang-typst/lezer";
import { collectWords } from "../src/spelling/legacy-prose.ts";
import { webSpellingPassages } from "../src/spelling/web-passages.ts";
import { decodeEscapedText, sourceRange } from "../src/spelling/escaped-text.ts";
import { encodeReplacement } from "../src/spelling/replacement.ts";
import { passageWords } from "../src/spelling/words.ts";
import { latexSkipRanges } from "../src/spelling/latex.ts";
import { typstTextRanges } from "../src/spelling/typst-ranges.ts";
import { TypstRangeClient } from "../src/spelling/typst-client.ts";
import { pathSpellingChoice, rememberPathSpellingChoice } from "../src/spelling/document-choice.ts";

const corpus = JSON.parse(
  readFileSync(new URL("./fixtures/spellcheck-corpus.json", import.meta.url), "utf8"),
);
let failures = 0;
function check(ok, label) {
  console.log((ok ? "PASS " : "FAIL ") + label);
  if (!ok) failures += 1;
}

const expectedLanguages = [
  "markdown",
  "typst",
  "asciidoc",
  "latex",
  "html",
  "javascript",
  "json",
  "css",
];
check(
  JSON.stringify(corpus.map((entry) => entry.language)) === JSON.stringify(expectedLanguages),
  "corpus covers the eight document languages",
);
for (const entry of corpus) {
  const labels = [...entry.check, ...entry.skip];
  check(
    labels.every((label) => entry.source.includes(label)) &&
      new Set(labels).size === labels.length &&
      entry.check.length > 0 &&
      entry.skip.length > 0,
    entry.language + ": labelled spans exist and do not conflict",
  );
  const rejected = new Set(entry.check.map((word) => word.toLowerCase()));
  const fakeDictionary = (words) =>
    words.flatMap((word, index) => (rejected.has(word.toLowerCase()) ? [index] : []));
  if (["html", "javascript", "json", "css"].includes(entry.language)) {
    const grammar =
      entry.language === "html"
        ? html()
        : await languages
            .find(
              (item) =>
                item.name ===
                { javascript: "JavaScript", json: "JSON", css: "CSS" }[entry.language],
            )
            .load();
    const state = EditorState.create({ doc: entry.source, extensions: [grammar] });
    const passages = webSpellingPassages(state, entry.language);
    const covers = (word) => {
      const pos = entry.source.indexOf(word);
      return passages.some((passage) => passage.from <= pos && passage.to >= pos + word.length);
    };
    check(entry.check.every(covers), entry.language + ": extracts labelled prose");
    check(
      entry.skip.every((word) => !covers(word)),
      entry.language + ": excludes labelled code",
    );
    const words = passages.flatMap((passage) => passage.text.match(/\p{L}+/gu) ?? []);
    const rejectedWords = fakeDictionary(words).map((index) => words[index]);
    check(
      entry.check.every((word) => rejectedWords.includes(word)) &&
        entry.skip.every((word) => !rejectedWords.includes(word)),
      entry.language + ": extracted words reach the fake dictionary",
    );
  } else {
    const grammar =
      entry.language === "markdown"
        ? markdown()
        : entry.language === "asciidoc"
          ? asciidocLanguage()
          : entry.language === "typst"
            ? await typstLanguage()
            : StreamLanguage.define(stex);
    const state = EditorState.create({ doc: entry.source, extensions: [grammar] });
    ensureSyntaxTree(state, state.doc.length, 1000);
    const parsed = entry.language === "typst" ? typstParser.parse(entry.source) : undefined;
    const words = collectWords(state, 0, state.doc.length, new Set(), entry.language, parsed);
    const covered = (label) => {
      const from = entry.source.indexOf(label);
      return words.some((word) => word.from < from + label.length && word.to > from);
    };
    check(entry.check.every(covered), entry.language + ": extracts labelled prose");
    check(
      entry.skip.every((word) => !covered(word)),
      entry.language + ": excludes labelled code",
    );
    const forms = words.map((word) => word.form);
    const rejectedWords = fakeDictionary(forms).map((index) => forms[index]);
    check(
      entry.check.every((word) => rejectedWords.includes(word)) &&
        entry.skip.every((word) => !rejectedWords.includes(word)),
      entry.language + ": extracted words reach the fake dictionary",
    );
  }
}
{
  const source =
    '<div lang="en" spellcheck="false"><span lang="pt-BR" spellcheck="true">misspeling</span><p>excludedword</p></div>';
  const state = EditorState.create({ doc: source, extensions: [html()] });
  const passages = webSpellingPassages(state, "html");
  const enabled = passages.find(
    (passage) => source.slice(passage.from, passage.to) === "misspeling",
  );
  check(
    enabled?.language === "pt-BR",
    "HTML child may re-enable checking and inherit its language",
  );
  check(
    !passages.some((passage) => source.slice(passage.from, passage.to).includes("excludedword")),
    "HTML inherited spellcheck=false excludes prose",
  );
}
{
  const source = '<style>/* misspeling */ p::before { content: "Welcomm"; }</style>';
  const state = EditorState.create({ doc: source, extensions: [html()] });
  const passages = webSpellingPassages(state, "html");
  check(
    ["misspeling", "Welcomm"].every((word) =>
      passages.some((passage) => source.slice(passage.from, passage.to).includes(word)),
    ),
    "HTML embedded CSS uses the CSS passage rules",
  );
  check(
    webSpellingPassages(state, "javascript").length === 0,
    "checking waits for the requested grammar instead of using the previous tab's grammar",
  );
}
{
  const source =
    "<textarea>misspeling</textarea><script>// Welcomm\nconst path = '/codeerro';</script>";
  const state = EditorState.create({ doc: source, extensions: [html()] });
  const passages = webSpellingPassages(state, "html");
  const contains = (word) => passages.some((passage) => passage.text.includes(word));
  check(contains("misspeling"), "HTML textarea text is checkable prose");
  check(
    contains("Welcomm") && !contains("codeerro"),
    "embedded JavaScript uses code and path rules",
  );
}
{
  const source = "<span style='content:\"Welcomm\"; /* misspeling */'>ok</span>";
  const state = EditorState.create({ doc: source, extensions: [html()] });
  const tree = ensureSyntaxTree(state, source.length, 1000);
  tree.resolveInner(source.indexOf("style"), -1);
  tree.resolveInner(source.indexOf("content") + 3, 1);
  const passages = webSpellingPassages(state, "html");
  check(
    ["misspeling", "Welcomm"].every((word) =>
      passages.some((passage) => passage.text.includes(word)),
    ),
    "HTML style attribute enters its CSS overlay after the tree cache is warmed",
  );
}
{
  const raw = "caf\\u00e9";
  const decoded = decodeEscapedText(raw, "json");
  check(decoded?.text === "café", "JSON unicode escapes are decoded");
  check(
    JSON.stringify(sourceRange(decoded, 0, 4)) === JSON.stringify({ from: 0, to: raw.length }),
    "decoded JSON word maps to its complete source spelling",
  );
  const emoji = decodeEscapedText("\\uD83D\\uDE00x", "json");
  check(emoji?.text === "😀x", "surrogate escapes decode to the original character");
  check(sourceRange(emoji, 0, 1) === null, "a surrogate pair cannot be split by a correction");
  check(
    JSON.stringify(sourceRange(emoji, 0, 2)) === JSON.stringify({ from: 0, to: 12 }),
    "a whole surrogate pair maps to both escapes",
  );
  check(decodeEscapedText("\\x65", "json") === null, "JSON rejects JavaScript-only hex escapes");
  check(decodeEscapedText("\\x65", "javascript")?.text === "e", "JavaScript hex escapes decode");
  check(
    decodeEscapedText("\\u{1f600}", "javascript")?.text === "😀",
    "JavaScript braced unicode decodes",
  );
  check(decodeEscapedText("\\u12", "json") === null, "incomplete unicode escapes are rejected");
}
{
  const source = '{"title":"Welc\\u006fmm","url":"/do-not-chek"}';
  const grammar = await languages.find((item) => item.name === "JSON").load();
  const state = EditorState.create({ doc: source, extensions: [grammar] });
  const passages = webSpellingPassages(state, "json");
  const title = passages.find((passage) => passage.text === "Welcomm");
  const mapped = title && sourceRange(title, 0, title.text.length);
  check(Boolean(title), "escaped JSON prose is extracted decoded");
  check(
    Boolean(mapped) &&
      source.slice(title.from + mapped.from, title.from + mapped.to) === "Welc\\u006fmm",
    "escaped JSON prose maps back to its exact source",
  );
  if (title && mapped) {
    const replacement = encodeReplacement('Welcome "friend"', title);
    const result =
      source.slice(0, title.from + mapped.from) +
      replacement +
      source.slice(title.from + mapped.to);
    check(
      JSON.parse(result).title === 'Welcome "friend"',
      "JSON replacement preserves valid quoting and decodes correctly",
    );
    const words = passageWords(title, (from, to) => source.slice(from, to), "en");
    check(
      words.length === 1 && words[0].word === "Welcomm" && words[0].raw === "Welc\\u006fmm",
      "word segmentation preserves escaped source and decoded dictionary spelling",
    );
  }
  check(
    !passages.some((passage) => passage.text.includes("do-not-chek")),
    "escaped extraction keeps JSON paths excluded",
  );
}
{
  const source = `<p>${"ordinary ".repeat(3000)}Welc&#111;mm ${"ordinary ".repeat(3000)}</p>`;
  const state = EditorState.create({ doc: source, extensions: [html()] });
  const position = source.indexOf("&#111;");
  const passages = webSpellingPassages(state, "html", position, position + 6);
  const words = passages.flatMap((passage) =>
    passageWords(passage, (from, to) => source.slice(from, to), "en", source.length),
  );
  check(
    words.some((word) => word.word === "Welcomm" && word.raw === "Welc&#111;mm"),
    "a long HTML text node retains visible entity-spelled words and source offsets",
  );
  check(
    passages.every((passage) => passage.to - passage.from < 16_384),
    "long HTML text is bounded around the viewport",
  );
}
{
  const source = `{"description":"${"ordinary ".repeat(3000)}Welc\\u006fmm ${"ordinary ".repeat(3000)}"}`;
  const grammar = await languages.find((item) => item.name === "JSON").load();
  const state = EditorState.create({ doc: source, extensions: [grammar] });
  const position = source.indexOf("\\u006f");
  const passages = webSpellingPassages(state, "json", position, position + 6);
  const words = passages.flatMap((passage) =>
    passageWords(passage, (from, to) => source.slice(from, to), "en", source.length),
  );
  check(
    words.some((word) => word.word === "Welcomm" && word.raw === "Welc\\u006fmm"),
    "a long JSON string retains visible escaped words and source offsets",
  );
}
{
  const source = '<p title="Welc&#111;mm">Welc&#111;mm</p>';
  const state = EditorState.create({ doc: source, extensions: [html()] });
  const passages = webSpellingPassages(state, "html");
  const found = passages.filter((passage) => passage.text === "Welcomm");
  check(found.length === 2, "HTML text and attributes decode entity-spelled words");
  check(
    found.every((passage) => {
      const range = sourceRange(passage, 0, passage.text.length);
      return (
        range && source.slice(passage.from + range.from, passage.from + range.to) === "Welc&#111;mm"
      );
    }),
    "HTML entity-spelled words map back to their exact source",
  );
  const entityAt = source.lastIndexOf("&#111;");
  check(
    webSpellingPassages(state, "html", entityAt, entityAt + 6).some(
      (passage) => passage.text === "Welcomm",
    ),
    "a viewport inside an entity still extracts the complete word",
  );
  const attribute = found.find((passage) => passage.encoding === "html-attribute");
  check(
    attribute && encodeReplacement('welcome "friend"', attribute) === "welcome &quot;friend&quot;",
    "HTML attribute replacement escapes its quote",
  );
  check(
    attribute && encodeReplacement("line\nbreak", attribute) === null,
    "multiline replacement is refused",
  );
}
{
  const source = '{"title":"Cafe\\u0301 misspeling"}';
  const grammar = await languages.find((item) => item.name === "JSON").load();
  const state = EditorState.create({ doc: source, extensions: [grammar] });
  const [passage] = webSpellingPassages(state, "json");
  const words = passageWords(passage, (from, to) => source.slice(from, to), "fr");
  check(
    words[0]?.word === "Café" && words[0]?.raw === "Cafe\\u0301",
    "combining marks normalize for checking without losing source offsets",
  );
  const descriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
  try {
    Object.defineProperty(Intl, "Segmenter", { configurable: true, value: undefined });
    const fallback = passageWords(passage, (from, to) => source.slice(from, to), "fr");
    check(
      fallback[0]?.word === "Café" && fallback[0]?.raw === "Cafe\\u0301",
      "word segmentation fallback preserves combining marks and source offsets",
    );
  } finally {
    if (descriptor) Object.defineProperty(Intl, "Segmenter", descriptor);
  }
}
{
  const tick = String.fromCharCode(96);
  const source =
    "import thing from 'bad module'; const label = " +
    tick +
    "Welcomm $" +
    "{user} here" +
    tick +
    "; const other = tag" +
    tick +
    "skipword here" +
    tick +
    "; /** @param {SomeType} user - misspeling */";
  const grammar = await languages.find((item) => item.name === "JavaScript").load();
  const state = EditorState.create({ doc: source, extensions: [grammar] });
  const passages = webSpellingPassages(state, "javascript");
  const contains = (word) => passages.some((passage) => passage.text.includes(word));
  check(contains("Welcomm") && contains("here"), "JavaScript template literals expose their prose");
  check(
    !contains("user}") && !contains("skipword") && !contains("bad module"),
    "template expressions, tagged templates and imports stay excluded",
  );
  check(
    contains("misspeling") && !contains("@param") && !contains("SomeType"),
    "JSDoc prose excludes tags and types",
  );
  const template = passages.find((passage) => passage.encoding === "template");
  check(
    template && encodeReplacement("x$" + "{y}" + tick, template) === "x\\$" + "{y}\\" + tick,
    "template replacement cannot create an interpolation or end the literal",
  );
}
{
  const source = "// misspeling https://example.invalid/typoo mail@test.invalid /tmp/skipword";
  const grammar = await languages.find((item) => item.name === "JavaScript").load();
  const state = EditorState.create({ doc: source, extensions: [grammar] });
  const [passage] = webSpellingPassages(state, "javascript");
  const words = passageWords(passage, (from, to) => source.slice(from, to), "en").map(
    (word) => word.word,
  );
  check(
    words.includes("misspeling") &&
      !words.includes("typoo") &&
      !words.includes("example") &&
      !words.includes("mail") &&
      !words.includes("skipword"),
    "comment tokenization excludes URLs, email addresses and paths",
  );
  const clipped = webSpellingPassages(state, "javascript", source.indexOf("peling"), source.length);
  const clippedWords = clipped.flatMap((item) =>
    passageWords(item, (from, to) => source.slice(from, to), "en", source.length),
  );
  check(
    !clippedWords.some((word) => word.word === "peling"),
    "a viewport boundary does not check half of a word",
  );
}
{
  const source = "const userNmae = other_value;";
  const grammar = await languages.find((item) => item.name === "JavaScript").load();
  const state = EditorState.create({ doc: source, extensions: [grammar] });
  check(
    !webSpellingPassages(state, "javascript").some((passage) => passage.kind === "identifier"),
    "identifier checking is off by default",
  );
  const passages = webSpellingPassages(state, "javascript", 0, source.length, "human", true);
  const identifier = passages.find(
    (passage) => passage.kind === "identifier" && passage.text === "userNmae",
  );
  const words = identifier
    ? passageWords(identifier, (from, to) => source.slice(from, to), "en")
    : [];
  check(
    words.map((word) => word.word).join(",") === "user,Nmae" && words[1]?.raw === "Nmae",
    "opt-in identifier checking splits camelCase with exact offsets",
  );
  check(
    identifier && encodeReplacement("Name", identifier) === null,
    "identifiers do not offer replacements",
  );
}
{
  const source =
    "\\section{Welcomm \\textbf{misspeling}} \\cite{citekey} " +
    "\\href{https://example.invalid}{linklabell} \\verb|codeerro| % commenterro\n";
  const ranges = latexSkipRanges(source, 0);
  const covered = (word) => {
    const at = source.indexOf(word);
    return ranges.some(([from, to]) => from <= at && to >= at + word.length);
  };
  check(
    ["Welcomm", "misspeling", "linklabell"].every((word) => !covered(word)),
    "LaTeX heading, nested formatting and link labels retain prose",
  );
  check(
    ["citekey", "example.invalid", "codeerro", "commenterro"].every(covered),
    "LaTeX citation keys, URLs, inline verbatim and comments are skipped",
  );
  const incomplete = "\\section{unfinished prose";
  const skipped = latexSkipRanges(incomplete, 0);
  check(
    skipped.some(
      ([from, to]) => from <= incomplete.indexOf("unfinished") && to === incomplete.length,
    ),
    "an incomplete LaTeX prose argument fails closed",
  );
}
{
  const source = "#let secretvalue = 1\n#strong[Welcomm] `codeerro` $mathword$ //commenterro";
  const ranges = typstTextRanges(source);
  const covers = (word) => {
    const at = source.indexOf(word);
    return ranges.some(([from, to]) => from <= at && to >= at + word.length);
  };
  check(covers("Welcomm"), "Typst structural parsing includes literal content");
  check(
    ["secretvalue", "strong", "codeerro", "mathword", "commenterro"].every((word) => !covers(word)),
    "Typst structural parsing excludes definitions, commands, raw code, math and comments",
  );
}
{
  const sent = [];
  const worker = {
    onmessage: null,
    onerror: null,
    postMessage: (message) => sent.push(message),
    terminate() {},
  };
  const client = new TypstRangeClient(() => worker);
  const first = client.request("first");
  const replaced = client.request("second");
  const latest = client.request("latest");
  check((await replaced) === null, "Typst worker drops an obsolete queued request");
  worker.onmessage({ data: { id: sent[0].id, ranges: [[0, 5]] } });
  check(
    (await first)?.[0][1] === 5 && sent[1]?.source === "latest",
    "Typst worker dispatches only the newest queued document",
  );
  worker.onmessage({ data: { id: sent[1].id, ranges: [[0, 99]] } });
  let rejected = false;
  try {
    await latest;
  } catch {
    rejected = true;
  }
  check(rejected, "Typst worker rejects out-of-bounds ranges");
  const overlap = client.request("overlapping");
  worker.onmessage({
    data: {
      id: sent[2].id,
      ranges: [
        [0, 5],
        [3, 7],
      ],
    },
  });
  rejected = false;
  try {
    await overlap;
  } catch {
    rejected = true;
  }
  check(rejected, "Typst worker rejects overlapping ranges");
  client.destroy();
}
{
  const original = [{ path: "C:/docs/a.md", language: "pt-BR" }];
  const copied = rememberPathSpellingChoice(original, "C:\\docs\\b.md", "pt-BR");
  check(
    pathSpellingChoice(copied, "C:/docs/a.md") === "pt-BR" &&
      pathSpellingChoice(copied, "C:/docs/b.md") === "pt-BR",
    "Save As can copy a document dictionary without removing the original",
  );
  const reset = rememberPathSpellingChoice(copied, "C:/docs/b.md", "follow");
  check(
    pathSpellingChoice(reset, "C:/docs/b.md") === "follow",
    "Follow global removes a path override",
  );
  let bounded = [];
  for (let index = 0; index < 101; index += 1)
    bounded = rememberPathSpellingChoice(bounded, "/docs/" + index, "auto");
  check(
    bounded.length === 100 &&
      pathSpellingChoice(bounded, "/docs/0") === "follow" &&
      pathSpellingChoice(bounded, "/docs/100") === "auto",
    "path-specific choices evict the least-recently-set entry",
  );
}
if (failures) process.exitCode = 1;
