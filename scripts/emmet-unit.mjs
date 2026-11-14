// Unit checks for Emmet abbreviation expansion.
//
//   node scripts/emmet-unit.mjs
//
// `src/emmet.ts` imports the editor packages but needs no DOM and no view: the
// context rules and the expansion are pure functions of an `EditorState`, and
// `emmet` itself is imported here exactly as `src/emmet-language.ts` imports it
// in the application. What this file pins is everything that can be decided
// without a window — where an abbreviation may expand, what it becomes, how the
// snippet indents it, and that the engine stays out of the main bundle. The Tab
// key itself, with a real popup, real undo and a release build, belongs to
// `emmet-test.mjs`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nextSnippetField, snippet } from "@codemirror/autocomplete";
import { languages } from "@codemirror/language-data";
import { html } from "@codemirror/lang-html";
import { indentUnit, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import * as emmet from "emmet";
import { emmetContext, expandAt } from "../src/emmet.ts";

const engine = { expand: emmet.default, extract: emmet.extract };

// CSS arrives the way the editor gets it, through the language catalog; it is
// not a direct dependency and importing it by name would be an unlisted one.
const cssSupport = await languages.find((entry) => entry.name === "CSS").load();
const css = () => cssSupport;

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

/** A state for a document with `|` marking the caret. */
function stateAt(language, marked, extra = []) {
  // CodeMirror reads `\r\n` as one line break, so the caret offset is counted in
  // the document it will actually hold.
  const normalised = marked.replace(/\r\n?/g, "\n");
  const pos = normalised.indexOf("|");
  const doc = normalised.replace("|", "");
  const extensions = language ? [language, ...extra] : extra;
  return { pos, state: EditorState.create({ doc, extensions }) };
}

const htmlAt = (marked) => stateAt(html(), marked);
const cssAt = (marked) => stateAt(css(), marked);

function expansion({ state, pos }) {
  return expandAt(state, pos, engine);
}

/** Apply an expansion the way Tab does and report the document and the caret. */
function applied(language, marked, indent = "  ") {
  let { state, pos } = stateAt(language, marked, [indentUnit.of(indent)]);
  state = state.update({ selection: { anchor: pos } }).state;
  const found = expandAt(state, pos, engine);
  if (!found) return null;
  const editor = {
    get state() {
      return state;
    },
    dispatch(transaction) {
      state = transaction.state;
    },
  };
  snippet(found.template)(editor, { label: found.abbreviation }, found.from, found.to);
  return {
    text: state.doc.toString(),
    before: state.doc.sliceString(0, state.selection.main.from),
    editor,
  };
}

function expands(label, source, expected) {
  const found = expansion(source);
  check(
    found !== null && found.template === expected,
    label,
    found ? JSON.stringify(found.template) : "no expansion",
  );
}

function declines(label, source) {
  const found = expansion(source);
  check(found === null, label, found ? JSON.stringify(found.template) : "");
}

console.log("=== markup in HTML ===");
{
  expands(
    "a list with a counter and a class",
    htmlAt("ul>li.item$*3|"),
    '<ul>\n\t<li class="item1">${1}</li>\n\t<li class="item2">${2}</li>\n\t<li class="item3">${3}</li>\n</ul>${0}',
  );
  expands("class and id", htmlAt("div.a#b|"), '<div class="a" id="b">${1}</div>${0}');
  expands("an attribute with a value", htmlAt("a[href=#]|"), '<a href="#">${1}</a>${0}');
  // Nothing to fill in, so no final stop: the caret simply follows the text.
  expands("text content has no tab stop and no final stop", htmlAt("p{Hello}|"), "<p>Hello</p>");
  expands(
    "a boolean attribute is written compactly",
    htmlAt("inp[disabled]|"),
    '<input type="${2:text}" name="${4}" id="${6}" disabled>${0}',
  );
  expands("lorem", htmlAt("lorem3|"), "Lorem, ipsum dolor.");

  const boilerplate = expansion(htmlAt("!|"));
  check(
    boilerplate !== null &&
      boilerplate.template.startsWith('<!DOCTYPE html>\n<html lang="en">') &&
      boilerplate.template.includes("${5:Document}"),
    "`!` is the HTML5 boilerplate with its tab stops",
  );

  // A literal brace in the output is escaped, or the snippet would read it as a
  // field and silently drop the text.
  expands(
    "braces typed as text are escaped for the snippet",
    htmlAt("p{#{x}}|"),
    "<p>#\\{x\\}</p>",
  );

  const inline = expansion(htmlAt("<div>ul>li|"));
  check(
    inline !== null && inline.abbreviation === "ul>li" && inline.from === 5 && inline.to === 10,
    "only the abbreviation after the tag is replaced",
    inline ? `${inline.from}-${inline.to} ${JSON.stringify(inline.abbreviation)}` : "none",
  );

  // `closeBrackets` types the `]` as soon as `[` is typed, so the caret sits in
  // front of it; the range has to take it along or it is left behind.
  const bracket = expansion(htmlAt("a[href=|]"));
  check(
    bracket !== null && bracket.abbreviation === "a[href=]" && bracket.to === 8,
    "an auto-closed bracket after the caret joins the abbreviation",
    bracket ? `${bracket.from}-${bracket.to} ${JSON.stringify(bracket.abbreviation)}` : "none",
  );

  const word = expansion(htmlAt("<p>Hello world|</p>"));
  check(
    word !== null && word.abbreviation === "world",
    "a word in text expands, as it does in every Emmet editor",
    word ? JSON.stringify(word.abbreviation) : "none",
  );
}

console.log("\n=== the enclosing element decides the implicit tag ===");
{
  expands(
    "`.item` in a list is an `li`",
    htmlAt("<ul>\n  .item|\n</ul>"),
    '<li class="item">${1}</li>${0}',
  );
  expands(
    "`.row` in a table is a `tr`",
    htmlAt("<table>\n  .row|\n</table>"),
    '<tr class="row">${1}</tr>${0}',
  );
  expands(
    "`.item` at the top level is a `div`",
    htmlAt(".item|"),
    '<div class="item">${1}</div>${0}',
  );
  expands(
    "just after an opening tag, the element is the parent",
    htmlAt("<ul>.item|</ul>"),
    '<li class="item">${1}</li>${0}',
  );
  expands(
    "just after a closing tag, the parent is the element outside",
    htmlAt("<ul><li></li>.x|</ul>"),
    '<li class="x">${1}</li>${0}',
  );
}

console.log("\n=== stylesheet abbreviations ===");
{
  expands("margin", cssAt("a { m10| }"), "margin: 10px;");
  expands("a colour", cssAt("a { bgc#f00| }"), "background-color: #f00;");
  expands("a keyword", cssAt("a { posa| }"), "position: absolute;");
  expands("a unitless number", cssAt("a { lh1.5| }"), "line-height: 1.5;");
  expands(
    "two declarations on separate lines",
    cssAt("a {\n  m10+p5|\n}"),
    "margin: 10px;\npadding: 5px;",
  );
  expands("a nested rule's block", cssAt(".foo { .bar { m10| } }"), "margin: 10px;");
  expands(
    "a block inside `@media`",
    cssAt("@media (min-width: 1px) { a { m10| } }"),
    "margin: 10px;",
  );
  expands("a keyframe's block", cssAt("@keyframes x { from { m10| } }"), "margin: 10px;");
  expands("`@font-face` holds declarations", cssAt("@font-face { m10| }"), "margin: 10px;");
  expands("`@page` holds declarations", cssAt("@page { m10| }"), "margin: 10px;");

  // A `@` snippet is the one thing that belongs outside every block.
  expands(
    "`@m` at the top level is a media query",
    cssAt("@m|"),
    "@media ${1:screen} \\{\n\t${0}\n\\}",
  );
  expands(
    "`@kf` is a keyframes rule",
    cssAt("@kf|"),
    "@keyframes ${1:identifier} \\{\n\t${2}\n\\}${0}",
  );
}

console.log("\n=== CSS inside HTML ===");
{
  expands("a `style` attribute", htmlAt('<p style="m10|">'), "margin: 10px;");
  expands(
    "a `style` attribute stays on one line",
    htmlAt('<p style="m10+p5|">'),
    "margin: 10px;padding: 5px;",
  );
  expands("after another declaration", htmlAt('<p style="color: red; m10|">'), "margin: 10px;");
  expands("a rule inside `<style>`", htmlAt("<style>\n  a { m10| }\n</style>"), "margin: 10px;");
  expands(
    "`@m` inside `<style>`",
    htmlAt("<style>\n  @m|\n</style>"),
    "@media ${1:screen} \\{\n\t${0}\n\\}",
  );
}

console.log("\n=== the shared tree's lookup cache ===");
{
  // `Tree.resolveInner` starts from the node it returned last time, so a lookup
  // elsewhere — completion, bracket matching, spelling — decides whether a later
  // one still enters the CSS inside `style="…"`. The editor makes such lookups
  // all the time; a fresh state in a test never does. Warm the cache the ways
  // that broke it in the real editor, then ask for the context.
  for (const [pos, side] of [
    [10, -1],
    [13, 1],
    [9, -1],
    [12, 0],
  ]) {
    const { state, pos: caret } = htmlAt('<p style="m10|"></p>');
    syntaxTree(state).resolveInner(pos, side);
    const context = emmetContext(state, caret);
    check(
      context?.type === "stylesheet" && context.inline === true,
      `a style attribute is still CSS after resolveInner(${pos}, ${side}) warmed the cache`,
      JSON.stringify(context),
    );
    const { state: again, pos: spot } = htmlAt('<p style="m10|"></p>');
    syntaxTree(again).resolveInner(pos, side);
    const found = expandAt(again, spot, engine);
    check(
      found?.template === "margin: 10px;",
      `and it still expands after resolveInner(${pos}, ${side})`,
      found ? JSON.stringify(found.template) : "no expansion",
    );
  }
}

console.log("\n=== where nothing expands: HTML ===");
{
  declines("inside an opening tag", htmlAt("<div cl|>"));
  declines("in an attribute value", htmlAt('<div class="ul>li|">'));
  declines("in an attribute with no quotes yet", htmlAt("<a href=a|>"));
  declines("in a comment", htmlAt("<!-- ul>li| -->"));
  declines("inside a script", htmlAt("<script>\nfoo|\n</script>"));
  declines("inside a textarea", htmlAt("<textarea>ul|</textarea>"));
  declines("in a doctype", htmlAt("<!DOCTYPE html|>"));
  declines("in a character reference", htmlAt("<p>a &amp|; b</p>"));
  declines("in an empty `<style>`, which holds code", htmlAt("<style>|</style>"));
  declines("in an empty `<script>`, which holds code", htmlAt("<script>|</script>"));
  declines("with nothing before the caret but a tag", htmlAt("<ul>|</ul>"));
  declines("after a space, where no abbreviation ends", htmlAt("ul>li |"));
  declines("on a blank line", htmlAt("<div>\n  |\n</div>"));
  declines("in an empty document", htmlAt("|"));
  declines("in an unterminated bracket", htmlAt("a[href=|"));
}

console.log("\n=== where nothing expands: CSS ===");
{
  declines("outside every rule, a word is a selector", cssAt("m10|"));
  declines("in a selector with its block already written", cssAt("a { b| { color: red } }"));
  declines("in a top-level selector", cssAt("a:hov|"));
  declines("in a comment", cssAt("a { /* m10| */ }"));
  declines("in a string", cssAt('a { content: "m1|" }'));
  declines("in a declaration's value", cssAt("a { color: re| }"));
  declines("in a custom property's value", cssAt("a { --x: m10| }"));
  declines("in the body of `@media`, which holds rules", cssAt("@media (min-width: 1px) { m10| }"));
  declines("in the body of `@layer`, which holds rules", cssAt("@layer x { m10| }"));
  declines("with nothing typed in an empty block", cssAt("a { | }"));
}

console.log("\n=== the editor's own conditions ===");
{
  declines("with no grammar loaded, nothing is known", stateAt(null, "ul>li|"));

  // The output is tab-indented and the snippet turns each leading tab into the
  // editor's own unit while adding the line's indentation, so the engine needs
  // no indent option of its own. A plan once claimed otherwise.
  const two = applied(html(), "<div>\n  ul>li|\n</div>", "  ");
  check(
    two !== null && two.text === "<div>\n  <ul>\n    <li></li>\n  </ul>\n</div>",
    "the expansion indents with the editor's two spaces and the line's indentation",
    two ? JSON.stringify(two.text) : "none",
  );
  const four = applied(html(), "<div>\n  ul>li|\n</div>", "    ");
  check(
    four !== null && four.text === "<div>\n  <ul>\n      <li></li>\n  </ul>\n</div>",
    "an editor set to four spaces gets four",
    four ? JSON.stringify(four.text) : "none",
  );
  const tab = applied(html(), "<div>\n\tul>li|\n</div>", "\t");
  check(
    tab !== null && tab.text === "<div>\n\t<ul>\n\t\t<li></li>\n\t</ul>\n</div>",
    "an editor set to tabs gets tabs",
    tab ? JSON.stringify(tab.text) : "none",
  );

  const crlf = applied(html(), "<div>\r\n  ul>li|\r\n</div>");
  check(
    crlf !== null && crlf.text.includes("<ul>"),
    "a CRLF document expands",
    crlf ? JSON.stringify(crlf.text) : "none",
  );

  // The caret ends in the first field, and Tab (nextSnippetField) walks the rest.
  const list = applied(html(), "ul>li*3|");
  check(
    list !== null && list.before === "<ul>\n  <li>",
    "the caret lands in the first tab stop",
    list ? JSON.stringify(list.before) : "none",
  );
  if (list) {
    const { editor } = list;
    nextSnippetField(editor);
    const second = editor.state.doc.sliceString(0, editor.state.selection.main.from);
    check(
      second === "<ul>\n  <li></li>\n  <li>",
      "Tab moves to the second tab stop",
      JSON.stringify(second),
    );
    nextSnippetField(editor);
    nextSnippetField(editor);
    const last = editor.state.doc.sliceString(0, editor.state.selection.main.from);
    check(
      last === "<ul>\n  <li></li>\n  <li></li>\n  <li></li>\n</ul>",
      "the last Tab leaves the caret after the whole expansion",
      JSON.stringify(last),
    );
  }

  const braces = applied(css(), "@m|");
  check(
    braces !== null && braces.text.startsWith("@media screen {\n  ") && braces.text.endsWith("\n}"),
    "escaped braces come out as plain braces",
    braces ? JSON.stringify(braces.text) : "none",
  );

  // `extract` sees a window, so a minified one-line file does not cost a copy.
  const prefix = "x ".repeat(30_000);
  const long = expansion(htmlAt(`${prefix}ul>li|`));
  check(
    long !== null && long.abbreviation === "ul>li" && long.to === prefix.length + 5,
    "an abbreviation at the end of a 60 KB line is found and placed correctly",
    long ? `${long.from}-${long.to}` : "none",
  );

  declines(
    "a repeat product that would freeze the editor is refused",
    htmlAt("div*1000>div*1000|"),
  );
  expands(
    "a large but sane repeat still expands",
    htmlAt("li*2|"),
    "<li>${1}</li>\n<li>${2}</li>${0}",
  );

  const context = emmetContext(...(([s]) => [s.state, s.pos])([htmlAt("ul>li|")]));
  check(context?.type === "markup", "the context of plain text is markup", JSON.stringify(context));
}

console.log("\n=== the engine stays out of the main bundle ===");
{
  const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const read = (file) => readFileSync(join(root, file), "utf8");
  const emmetSource = read("src/emmet.ts");
  const loader = read("src/emmet-language.ts");
  const editor = read("src/editor.ts");
  const main = read("src/main.ts");

  check(
    !/^\s*import\s+(?!type\b)[^;]*from\s+["']emmet["']/m.test(emmetSource),
    "src/emmet.ts imports the engine's types only",
  );
  check(
    /import\(\s*["']emmet["']\s*\)/.test(loader),
    "the loader reaches the engine through a dynamic import",
  );
  check(
    !/from\s+["']emmet["']/.test(editor) && !/from\s+["']emmet["']/.test(main),
    "neither the editor nor the shell imports the engine statically",
  );
  // Comments are not code: the loader's own comment says "failed load".
  const code = (source) =>
    source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
  check(
    !/\b(fetch|XMLHttpRequest|WebSocket|sendBeacon)\b/.test(code(emmetSource) + code(loader)),
    "neither module can reach the network",
  );
}

console.log("\n=== how Tab is wired ===");
{
  const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const read = (file) => readFileSync(join(root, file), "utf8");
  const emmetSource = read("src/emmet.ts");
  const editor = read("src/editor.ts");

  check(
    /Prec\.high\(\s*keymap\.of\(\[\{ key: "Tab"/.test(emmetSource),
    "the Tab binding is above the base keymap that holds indentWithTab",
  );
  const completion = editor.indexOf("completionCompartment.of(");
  const emmetSlot = editor.indexOf("emmetCompartment.of([])");
  check(
    completion > 0 && emmetSlot > completion,
    "Emmet is installed after completion, so an open popup accepts Tab first",
  );
  check(
    /syncEmmet\(kind\);/.test(editor),
    "every language change re-decides whether Emmet applies",
  );
  check(
    /kind !== "html" && kind !== "css"/.test(editor),
    "only HTML and CSS documents get the binding",
  );
}

console.log("\n=== the preference reaches every layer ===");
{
  const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const read = (file) => readFileSync(join(root, file), "utf8");
  check(/pub emmet: bool/.test(read("src-tauri/src/settings.rs")), "settings.rs holds the field");
  check(/emmet: true,/.test(read("src-tauri/src/settings.rs")), "it defaults on");
  check(/emmet: boolean;/.test(read("src/api.ts")), "the Settings type has it");
  check(
    /Expand Emmet abbreviations with Tab/.test(read("src/preferences.ts")),
    "Preferences has the row",
  );
  const main = read("src/main.ts");
  check(/patch\.emmet !== undefined/.test(main), "a change is applied without a restart");
  check(/emmet: settings\.emmet !== false/.test(main), "the editor starts with the saved value");
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
