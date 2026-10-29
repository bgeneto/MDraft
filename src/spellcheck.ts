//! Spelling decorations for the source editor.
//!
//! The dictionaries live in the operating system. This module decides which
//! words are prose, which language to ask for, and where the underline goes.
//! Code, URLs and mathematics are not sent. A language the system does not
//! have is not guessed at: the paragraph stays clean.

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  Facet,
  RangeSetBuilder,
  StateEffect,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type PluginValue,
  type ViewUpdate,
} from "@codemirror/view";
import * as api from "./api";
import { voteProse } from "./language.ts";

export interface SpellOptions {
  enabled: boolean;
  /** `"auto"`, or a tag returned by `spellcheck_languages`. */
  language: string;
  /** Words the reader ignored or added. Compared case-insensitively. */
  words: readonly string[];
}

const ALLOWED = new Set([
  "mdraft",
  "tauri",
  "codemirror",
  "pandoc",
  "typst",
  "katex",
  "mermaid",
  "webview2",
  "github",
  "asciidoc",
  "asciidoctor",
  "asciimath",
  "latexmath",
]);

/** Nodes whose text is not prose. Link labels and image alt text stay. */
const SKIP_NODES = new Set([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "URL",
  "Autolink",
  "HTMLBlock",
  "HTMLTag",
  "Comment",
  // AsciiDoc stream token names.
  "monospace",
  "listing",
  "literal",
  "passthrough",
  "comment",
  "meta",
]);

const spellError = Decoration.mark({ class: "cm-spell-error" });

interface Miss {
  from: number;
  to: number;
  word: string;
}

interface Marks {
  deco: DecorationSet;
  misses: Miss[];
}

const setMarks = StateEffect.define<Marks>();

interface SpellConfig {
  language: string;
  words: readonly string[];
}

const spellConfig = Facet.define<SpellConfig, SpellConfig>({
  combine(values) {
    return values[0] ?? { language: "auto", words: [] };
  },
});

let installed: string[] = [];
let installedKnown = false;
let remember: (word: string) => void = () => {};

let committed: "en" | "pt-BR" | null = null;
let streakLang: "en" | "pt-BR" | null = null;
let streak = 0;

/** Drop the language lock when the buffer is replaced by another document. */
export function resetSpellLanguage(): void {
  committed = null;
  streakLang = null;
  streak = 0;
}

export function setInstalledLanguages(languages: readonly string[]): void {
  installed = [...languages];
  installedKnown = true;
}

export function installedLanguages(): readonly string[] {
  return installed;
}

export function setSpellRemember(callback: (word: string) => void): void {
  remember = callback;
}

export function languageLabel(tag: string): string {
  switch (tag) {
    case "auto":
      return "Automatic";
    case "en":
      return "English";
    case "en-GB":
      return "English (United Kingdom)";
    case "pt-BR":
      return "Português (Brasil)";
    case "pt-PT":
      return "Português (Portugal)";
    default:
      return tag;
  }
}

export function dictionaryOptions(current: string): [string, string][] {
  const options: [string, string][] = [["auto", "Automatic"]];
  for (const tag of installed) options.push([tag, languageLabel(tag)]);
  if (current !== "auto" && !options.some(([id]) => id === current)) {
    options.push([current, `${languageLabel(current)} (not installed)`]);
  }
  return options;
}

/**
 * Shown when English or Portuguese is missing. Null once both are present,
 * and null before the first reply, so the panel does not flash a warning
 * during start-up.
 */
export function spellcheckAvailabilityNote(): string | null {
  if (!installedKnown) return null;
  const hasEn = installed.some((tag) => tag === "en" || tag === "en-GB");
  const hasPt = installed.includes("pt-BR");
  if (hasEn && hasPt) return null;
  const missing = [!hasEn ? "English" : "", !hasPt ? "Portuguese (Brazil)" : ""].filter(Boolean);
  const agent = navigator.userAgent;
  let how: string;
  if (/Windows/i.test(agent)) {
    how = "Add it in Settings → Time & language → Language & region, then turn on Basic typing.";
  } else if (/Linux/i.test(agent)) {
    const packages = [!hasEn ? "hunspell-en-us" : "", !hasPt ? "hunspell-pt-br" : ""]
      .filter(Boolean)
      .join(" and ");
    how = `Install ${packages}.`;
  } else if (/Mac/i.test(agent)) {
    how = "Add it under System Settings → Keyboard → Text Input.";
  } else {
    how = "Install that language's spelling dictionary in the operating system.";
  }
  return `${missing.join(" and ")} spelling is not installed. ${how} Nothing is downloaded.`;
}

export function spellExtension(options: SpellOptions): Extension {
  return [spellConfig.of({ language: options.language, words: options.words }), spellPlugin];
}

function normalize(word: string): string {
  return word.replace(/[\u2019\u2018\u02BC]/g, "'");
}

function acceptedForm(word: string): string | null {
  const trimmed = word.replace(/^['\u2019\u2018-]+|['\u2019\u2018-]+$/gu, "");
  if ([...trimmed].length < 2) return null;
  let letters = 0;
  let uppers = 0;
  let seenLetter = false;
  let internalCapital = false;
  let normalized = "";
  for (const ch of trimmed) {
    if (/\p{N}/u.test(ch)) return null;
    const folded = ch === "\u2019" || ch === "\u2018" || ch === "\u02BC" ? "'" : ch;
    if (/\p{L}/u.test(folded)) {
      letters += 1;
      if (folded === folded.toUpperCase() && folded !== folded.toLowerCase()) uppers += 1;
      if (seenLetter && folded >= "A" && folded <= "Z") internalCapital = true;
      seenLetter = true;
    }
    normalized += folded;
  }
  if (letters < 2 || internalCapital || (uppers === letters && letters >= 2)) return null;
  if (ALLOWED.has(normalized.toLowerCase())) return null;
  return normalized;
}

function confirm(sample: "en" | "pt-BR"): "en" | "pt-BR" | null {
  if (sample === committed) {
    streak = 0;
    streakLang = null;
    return committed;
  }
  if (streakLang === sample) streak += 1;
  else {
    streakLang = sample;
    streak = 1;
  }
  if (streak >= 2) {
    committed = sample;
    streak = 0;
    streakLang = null;
  }
  return committed;
}

/**
 * Two slices of the same document have to agree before the language changes.
 * A short or mixed sample checks nothing: underlining every word is worse.
 */
function detectLanguage(words: readonly string[]): "en" | "pt-BR" | null {
  if (words.length < 40) return null;
  if (words.length >= 80) {
    const mid = Math.floor(words.length / 2);
    const left = voteProse(words.slice(0, mid));
    const right = voteProse(words.slice(mid));
    if (left && left === right) {
      committed = left;
      streak = 0;
      streakLang = null;
      return left;
    }
    if (left && right && left !== right) return null;
    const one = left ?? right;
    if (!one) return null;
    return confirm(one);
  }
  const sample = voteProse(words);
  if (!sample) return null;
  return confirm(sample);
}

function frontMatterEnd(state: EditorState): number {
  const text = state.doc.sliceString(0, Math.min(state.doc.length, 8_000));
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return 0;
  const lines = text.split(/\r?\n/);
  let offset = lines[0].length + (text.startsWith("---\r\n") ? 2 : 1);
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") return offset + lines[i].length + 1;
    offset += lines[i].length + 1;
  }
  return 0;
}

function extraSkips(text: string, base: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const patterns = [
    /\$\$[\s\S]*?\$\$/g,
    /\\\([\s\S]*?\\\)/g,
    /\\\[[\s\S]*?\\\]/g,
    /\$[^\s$][^$\n]*[^\s$]\$/g,
    /\$[^\s$\n]\$/g,
    /https?:\/\/\S+/g,
    /www\.\S+/g,
    /<[^>\n]{1,200}>/g,
    // AsciiDoc markup that is not prose.
    /image::?[^[\n]*\[[^\]]*\]/g,
    /(?:include|xref|link|footnote|kbd|btn|menu|latexmath|stem):[^\s[]*\[[^\]]*\]/g,
    /^:[A-Za-z0-9_-]+:.*$/gm,
    /<<[^>\n]+>>/g,
    /\[\[[^\]\n]+\]\]/g,
    /^\s{0,3}(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION):/gm,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match) {
      ranges.push([base + match.index, base + match.index + match[0].length]);
      match = pattern.exec(text);
    }
  }
  return ranges;
}

function covered(index: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([from, to]) => index >= from && index < to);
}

interface WordHit {
  from: number;
  to: number;
  form: string;
}

function collectWords(
  state: EditorState,
  from: number,
  to: number,
  ignored: Set<string>,
): WordHit[] {
  const tree = syntaxTree(state);
  const skipped: Array<[number, number]> = [];
  const matter = frontMatterEnd(state);
  if (matter > from) skipped.push([from, Math.min(matter, to)]);
  tree.iterate({
    from,
    to,
    enter(node) {
      if (SKIP_NODES.has(node.name)) {
        skipped.push([Math.max(node.from, from), Math.min(node.to, to)]);
        return false;
      }
    },
  });
  const slice = state.doc.sliceString(from, to);
  skipped.push(...extraSkips(slice, from));

  const hits: WordHit[] = [];
  let token = "";
  let tokenFrom = from;
  const flush = (at: number) => {
    if (!token) return;
    const parts = token.split("-");
    let cursor = tokenFrom;
    for (const part of parts) {
      const form = acceptedForm(part);
      const start = cursor;
      const end = cursor + part.length;
      if (form && !ignored.has(form.toLowerCase())) {
        hits.push({ from: start, to: end, form });
      }
      cursor = end + 1;
    }
    token = "";
    tokenFrom = at;
  };

  for (let index = from; index < to;) {
    const ch = state.doc.sliceString(index, index + 1);
    const size = ch.length || 1;
    if (covered(index, skipped) || ch === "\n" || ch === "\r") {
      flush(index + size);
      index += size;
      continue;
    }
    if (/\p{L}/u.test(ch) || ch === "'" || ch === "\u2019" || ch === "\u2018" || ch === "-") {
      if (!token) tokenFrom = index;
      token += ch;
    } else {
      flush(index + size);
    }
    index += size;
  }
  flush(to);
  return hits;
}

function sampleWords(state: EditorState, ignored: Set<string>): string[] {
  const limit = Math.min(state.doc.length, 20_000);
  ensureSyntaxTree(state, limit, 100);
  return collectWords(state, 0, limit, ignored).map((hit) => hit.form);
}

function chosenLanguage(
  config: SpellConfig,
  state: EditorState,
  ignored: Set<string>,
): string | null {
  if (!installedKnown) return null;
  const requested =
    config.language === "auto" ? detectLanguage(sampleWords(state, ignored)) : config.language;
  if (!requested) return null;
  if (requested === "en") {
    return installed.some((tag) => tag === "en" || tag === "en-GB") ? "en" : null;
  }
  return installed.includes(requested) ? requested : null;
}

class SpellPlugin implements PluginValue {
  deco: DecorationSet = Decoration.none;
  misses: Miss[] = [];
  private timer = 0;
  private request = 0;
  private language: string | null = null;
  /** One extra pass after open, so a short document can confirm its language. */
  private followUp = false;
  private menu: HTMLDivElement | null = null;
  private menuGen = 0;
  private readonly onContext: (event: MouseEvent) => void;
  private view: EditorView;

  constructor(view: EditorView) {
    this.view = view;
    this.onContext = (event) => this.openMenu(event);
    view.dom.addEventListener("contextmenu", this.onContext);
    this.schedule();
  }

  update(update: ViewUpdate): void {
    this.view = update.view;
    if (update.docChanged) {
      update.changes.iterChanges((fromA, toA) => {
        if (fromA === 0 && toA === update.startState.doc.length) this.followUp = false;
      });
      this.deco = this.deco.map(update.changes);
      this.misses = this.misses
        .map((miss) => ({
          ...miss,
          from: update.changes.mapPos(miss.from),
          to: update.changes.mapPos(miss.to, -1),
        }))
        .filter((miss) => miss.from < miss.to);
    }
    for (const transaction of update.transactions) {
      for (const effect of transaction.effects) {
        if (effect.is(setMarks)) {
          this.deco = effect.value.deco;
          this.misses = effect.value.misses;
        }
      }
    }
    if (update.docChanged || update.viewportChanged || update.focusChanged) this.schedule();
  }

  destroy(): void {
    window.clearTimeout(this.timer);
    this.view.dom.removeEventListener("contextmenu", this.onContext);
    this.closeMenu();
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.run(), 400);
  }

  private async run(): Promise<void> {
    const view = this.view;
    // The language list arrives after the first paint. Keep asking until it
    // does: one follow-up is not enough when the query is slower than 50 ms,
    // and a miss here leaves the document clean until the next keystroke.
    if (!installedKnown) {
      this.timer = window.setTimeout(() => void this.run(), 100);
      return;
    }
    const config = view.state.facet(spellConfig);
    const ignored = new Set(config.words.map((word) => normalize(word).toLowerCase()));
    const language = chosenLanguage(config, view.state, ignored);
    const doc = view.state.doc;
    this.language = language;
    if (!language) {
      if (this.deco.size) {
        view.dispatch({ effects: setMarks.of({ deco: Decoration.none, misses: [] }) });
      }
      // Automatic mode needs two samples before it will underline. The second
      // one has to happen without a keystroke, or opening a document would
      // wait until the reader typed.
      if (config.language === "auto" && !this.followUp) {
        this.followUp = true;
        this.timer = window.setTimeout(() => void this.run(), 50);
      }
      return;
    }
    this.followUp = false;
    const hits: WordHit[] = [];
    for (const range of view.visibleRanges) {
      hits.push(...collectWords(view.state, range.from, range.to, ignored));
      if (hits.length >= 1_500) break;
    }
    const request = ++this.request;
    let bad: number[];
    try {
      bad = await api.spellcheckCheck(
        language,
        hits.map((hit) => hit.form),
      );
    } catch {
      return;
    }
    if (request !== this.request || view.state.doc !== doc) {
      if (view.state.doc !== doc) this.schedule();
      return;
    }
    const misses: Miss[] = [];
    const builder = new RangeSetBuilder<Decoration>();
    const flagged = [...bad].sort((a, b) => a - b);
    let previous = -1;
    for (const index of flagged) {
      const hit = hits[index];
      if (!hit || hit.from >= hit.to || hit.from < previous) continue;
      previous = hit.to;
      misses.push({ from: hit.from, to: hit.to, word: hit.form });
      builder.add(hit.from, hit.to, spellError);
    }
    view.dispatch({ effects: setMarks.of({ deco: builder.finish(), misses }) });
  }

  private missAt(pos: number): Miss | null {
    return this.misses.find((miss) => pos >= miss.from && pos <= miss.to) ?? null;
  }

  private openMenu(event: MouseEvent): void {
    const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return;
    const miss = this.missAt(pos);
    if (!miss) return;
    event.preventDefault();
    event.stopPropagation();
    this.closeMenu();
    const language = this.language;
    if (!language) return;
    const gen = ++this.menuGen;
    const host = document.createElement("div");
    host.className = "spell-menu";
    host.setAttribute("role", "menu");
    host.style.left = `${event.clientX}px`;
    host.style.top = `${event.clientY}px`;
    const pending = document.createElement("div");
    pending.className = "spell-menu-pending";
    pending.textContent = "…";
    host.appendChild(pending);
    document.body.appendChild(host);
    this.menu = host;
    const close = () => {
      if (this.menuGen === gen) this.closeMenu();
    };
    const onPointer = (pointer: MouseEvent) => {
      if (host.contains(pointer.target as Node)) return;
      close();
    };
    const onKey = (key: KeyboardEvent) => {
      if (key.key === "Escape") close();
    };
    document.addEventListener("mousedown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    host.dataset.cleanup = "1";
    (host as HTMLDivElement & { cleanup?: () => void }).cleanup = () => {
      document.removeEventListener("mousedown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
    void api
      .spellcheckSuggest(language, miss.word)
      .then((suggestions) => {
        if (this.menuGen !== gen || this.menu !== host) return;
        this.fillMenu(host, miss, suggestions);
        this.placeMenu(host, event.clientX, event.clientY);
      })
      .catch(() => {
        if (this.menu === host) this.fillMenu(host, miss, []);
      });
  }

  private fillMenu(host: HTMLDivElement, miss: Miss, suggestions: readonly string[]): void {
    host.replaceChildren();
    if (suggestions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "spell-menu-pending";
      empty.textContent = "No suggestions";
      host.appendChild(empty);
    }
    for (const suggestion of suggestions) {
      host.appendChild(
        this.item(suggestion, () => {
          const view = this.view;
          const current = view.state.doc.sliceString(miss.from, miss.to);
          if (normalize(current).toLowerCase() !== miss.word.toLowerCase()) return;
          view.dispatch({
            changes: { from: miss.from, to: miss.to, insert: suggestion },
            selection: { anchor: miss.from + suggestion.length },
          });
          view.focus();
        }),
      );
    }
    const rule = document.createElement("div");
    rule.className = "spell-menu-sep";
    host.appendChild(rule);
    host.appendChild(this.item("Ignore", () => remember(miss.word)));
    host.appendChild(this.item("Add to dictionary", () => remember(miss.word)));
  }

  private item(label: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      action();
      this.closeMenu();
    });
    return button;
  }

  private placeMenu(host: HTMLElement, x: number, y: number): void {
    const rect = host.getBoundingClientRect();
    const left =
      x + rect.width > window.innerWidth ? Math.max(8, window.innerWidth - rect.width - 8) : x;
    const top = y + rect.height > window.innerHeight ? Math.max(8, y - rect.height) : y;
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
  }

  private closeMenu(): void {
    this.menuGen += 1;
    const menu = this.menu as (HTMLDivElement & { cleanup?: () => void }) | null;
    menu?.cleanup?.();
    menu?.remove();
    this.menu = null;
  }
}

const spellPlugin = ViewPlugin.fromClass(SpellPlugin, {
  decorations: (plugin) => plugin.deco,
});
