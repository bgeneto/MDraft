//! Spelling decorations for the source editor.
//!
//! The dictionaries live in the operating system. This module decides which
//! words are prose, which language to ask for, and where the underline goes.
//! Code, URLs and mathematics are not sent. A language the system does not
//! have is not guessed at: the paragraph stays clean.

import { ensureSyntaxTree, language as activeLanguage, syntaxTree } from "@codemirror/language";
import {
  Facet,
  RangeSetBuilder,
  StateEffect,
  type EditorState,
  type Extension,
  type Text,
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
import {
  declaredLanguage,
  normalizeLanguageTag,
  voteProse,
  type MarkupLanguage,
} from "./language.ts";
import {
  webSpellingPassages,
  type StringMode,
  type WebLanguage,
  type WebPassage,
} from "./spelling/web-passages.ts";
import { passageWords } from "./spelling/words.ts";
import { encodeReplacement } from "./spelling/replacement.ts";
import { ALLOWED, collectWords, type WordHit } from "./spelling/legacy-prose.ts";
import { TypstRangeClient } from "./spelling/typst-client.ts";

export interface SpellOptions {
  enabled: boolean;
  /** `"auto"`, or a tag returned by `spellcheck_languages`. */
  language: string;
  /** The buffer's markup. LaTeX needs more skips than the shared list. */
  documentLanguage?: string;
  /** Words the reader ignored or added. Compared case-insensitively. */
  words: readonly string[];
  stringMode?: StringMode;
  identifiers?: boolean;
  readOnly?: boolean;
  sessionKey?: string;
}

const spellError = Decoration.mark({ class: "cm-spell-error" });

interface Miss {
  from: number;
  to: number;
  word: string;
  raw: string;
  language: string;
  passage?: WebPassage;
}

interface Marks {
  deco: DecorationSet;
  misses: Miss[];
}

const setMarks = StateEffect.define<Marks>();

interface SpellConfig {
  language: string;
  documentLanguage: string;
  words: readonly string[];
  stringMode: StringMode;
  identifiers: boolean;
  readOnly: boolean;
  sessionKey: string;
}

const spellConfig = Facet.define<SpellConfig, SpellConfig>({
  combine(values) {
    return (
      values[0] ?? {
        language: "auto",
        documentLanguage: "markdown",
        words: [],
        stringMode: "human",
        identifiers: false,
        readOnly: false,
        sessionKey: "",
      }
    );
  },
});

let installed: string[] = [];
let installedKnown = false;
let installedError = false;
let installedRevision = 0;
let remember: (word: string) => void = () => {};
let ignore: (word: string) => void = () => {};
export type SpellingStatus = "pending" | "active" | "missing" | "error";
let reportStatus: (sessionKey: string, status: SpellingStatus) => void = () => {};

let committed: "en" | "pt-BR" | null = null;
let streakLang: "en" | "pt-BR" | null = null;
let streak = 0;

/** Drop the language lock when the buffer is replaced by another document. */
export function resetSpellLanguage(): void {
  committed = null;
  streakLang = null;
  streak = 0;
}

export function setInstalledLanguages(languages: readonly string[], failed = false): void {
  installed = [...languages];
  installedKnown = true;
  installedError = failed;
  installedRevision += 1;
}

export function installedLanguages(): readonly string[] {
  return installed;
}

export function setSpellRemember(callback: (word: string) => void): void {
  remember = callback;
}

export function setSpellIgnore(callback: (word: string) => void): void {
  ignore = callback;
}

export function setSpellStatus(
  callback: (sessionKey: string, status: SpellingStatus) => void,
): void {
  reportStatus = callback;
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
  if (installedError)
    return "The spelling service could not list dictionaries. Try restarting MDraft.";
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
  return [
    spellConfig.of({
      language: options.language,
      documentLanguage: options.documentLanguage ?? "markdown",
      words: options.words,
      stringMode: options.stringMode ?? "human",
      identifiers: options.identifiers ?? false,
      readOnly: options.readOnly ?? false,
      sessionKey: options.sessionKey ?? "",
    }),
    spellPlugin,
  ];
}

function normalize(word: string): string {
  return word.replace(/[\u2019\u2018\u02BC]/g, "'");
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

function sampleWords(
  state: EditorState,
  ignored: Set<string>,
  documentLanguage: string,
  typstRanges?: ReadonlyArray<readonly [number, number]>,
): string[] {
  const limit = Math.min(state.doc.length, 20_000);
  ensureSyntaxTree(state, limit, 100);
  if (isWebLanguage(documentLanguage)) {
    return webSpellingPassages(state, documentLanguage, 0, limit).flatMap((passage) =>
      passageWords(
        passage,
        (from, to) => state.sliceDoc(from, to),
        passage.language,
        state.doc.length,
      )
        .map((word) => word.word)
        .filter((word) => !ignored.has(word.toLowerCase())),
    );
  }
  if (documentLanguage === "typst")
    return typstWords(state, 0, limit, ignored, typstRanges ?? []).map((hit) => hit.form);
  return collectWords(state, 0, limit, ignored, documentLanguage).map((hit) => hit.form);
}

function typstWords(
  state: EditorState,
  from: number,
  to: number,
  ignored: Set<string>,
  ranges: ReadonlyArray<readonly [number, number]>,
): WordHit[] {
  const hits: WordHit[] = [];
  for (const [start, end] of ranges) {
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end > state.doc.length ||
      end <= start
    )
      continue;
    const lo = Math.max(start, from);
    const hi = Math.min(end, to);
    if (lo < hi) hits.push(...collectWords(state, lo, hi, ignored, "typst"));
  }
  return hits;
}

function isWebLanguage(value: string): value is WebLanguage {
  return value === "html" || value === "javascript" || value === "json" || value === "css";
}

function installedTag(raw: string): string | null {
  const tag = normalizeLanguageTag(raw);
  if (!tag) return null;
  const exact = installed.find((candidate) => candidate.toLowerCase() === tag.toLowerCase());
  if (exact) return exact;
  if (tag === "pt" && installed.includes("pt-PT")) return "pt-PT";
  return null;
}

function chosenLanguage(
  config: SpellConfig,
  state: EditorState,
  ignored: Set<string>,
  typstRanges?: ReadonlyArray<readonly [number, number]>,
): string | null {
  if (!installedKnown) return null;
  let requested = config.language;
  if (requested === "auto") {
    const markup = ["markdown", "typst", "html", "asciidoc", "latex"].includes(
      config.documentLanguage,
    )
      ? (config.documentLanguage as MarkupLanguage)
      : null;
    const declared = markup
      ? declaredLanguage(state.sliceDoc(0, Math.min(state.doc.length, 8_000)), markup)
      : null;
    if (declared) return installedTag(declared);
    requested =
      detectLanguage(sampleWords(state, ignored, config.documentLanguage, typstRanges)) ?? "";
  }
  if (!requested && config.language === "auto") {
    for (const locale of navigator.languages ?? []) {
      const found = installedTag(locale);
      if (found) return found;
    }
  }
  if (!requested) return null;
  if (requested === "en") {
    return installed.some((tag) => tag === "en" || tag === "en-GB") ? "en" : null;
  }
  return installedTag(requested);
}

class SpellPlugin implements PluginValue {
  deco: DecorationSet = Decoration.none;
  misses: Miss[] = [];
  private timer = 0;
  private request = 0;
  /** One extra pass after open, so a short document can confirm its language. */
  private followUp = false;
  private menu: HTMLDivElement | null = null;
  private menuGen = 0;
  private readonly onContext: (event: MouseEvent) => void;
  private view: EditorView;
  private typstClient: TypstRangeClient | null = null;
  private typstCache: { doc: Text; ranges: Array<[number, number]> } | null = null;
  private readonly wordCache = new Map<string, boolean>();
  private cacheRevision = -1;
  private cacheSettings = "";

  constructor(view: EditorView) {
    this.view = view;
    this.onContext = (event) => this.openMenu(event);
    view.dom.addEventListener("contextmenu", this.onContext);
    this.schedule();
  }

  update(update: ViewUpdate): void {
    this.view = update.view;
    const configChanged = update.startState.facet(spellConfig) !== update.state.facet(spellConfig);
    if (configChanged) {
      this.closeMenu();
      this.deco = Decoration.none;
      this.misses = [];
    }
    if (update.docChanged) {
      this.closeMenu();
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
    if (
      configChanged ||
      update.docChanged ||
      update.viewportChanged ||
      update.focusChanged ||
      syntaxTree(update.state) !== syntaxTree(update.startState)
    )
      this.schedule();
  }

  destroy(): void {
    this.request += 1;
    this.typstClient?.destroy();
    window.clearTimeout(this.timer);
    this.view.dom.removeEventListener("contextmenu", this.onContext);
    this.closeMenu();
  }

  private schedule(): void {
    this.request += 1;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.run(), 400);
  }

  private async checkWords(
    language: string,
    words: readonly string[],
    config: SpellConfig,
    request: number,
  ): Promise<number[]> {
    const settings = JSON.stringify([
      config.language,
      config.stringMode,
      config.identifiers,
      config.words,
    ]);
    if (this.cacheRevision !== installedRevision || this.cacheSettings !== settings) {
      this.wordCache.clear();
      this.cacheRevision = installedRevision;
      this.cacheSettings = settings;
    }
    const results = new Map<string, boolean>();
    const pending: string[] = [];
    for (const word of new Set(words)) {
      const cached = this.wordCache.get(`${language}\0${word}`);
      if (cached === undefined) pending.push(word);
      else results.set(word, cached);
    }
    for (let offset = 0; offset < pending.length; offset += 1_500) {
      if (request !== this.request) return [];
      const chunk = pending.slice(offset, offset + 1_500);
      const bad = new Set(await api.spellcheckCheck(language, chunk));
      if (request !== this.request) return [];
      for (let index = 0; index < chunk.length; index += 1) {
        if (this.wordCache.size >= 4_000)
          this.wordCache.delete(this.wordCache.keys().next().value!);
        this.wordCache.set(`${language}\0${chunk[index]}`, bad.has(index));
        results.set(chunk[index], bad.has(index));
      }
    }
    return words.flatMap((word, index) => (results.get(word) ? [index] : []));
  }

  private async run(): Promise<void> {
    const view = this.view;
    // The language list arrives after the first paint. Keep asking until it
    // does: one follow-up is not enough when the query is slower than 50 ms,
    // and a miss here leaves the document clean until the next keystroke.
    if (!installedKnown) {
      reportStatus(view.state.facet(spellConfig).sessionKey, "pending");
      this.timer = window.setTimeout(() => void this.run(), 100);
      return;
    }
    const config = view.state.facet(spellConfig);
    const ignored = new Set(config.words.map((word) => normalize(word).toLowerCase()));
    let typstRanges: Array<[number, number]> | undefined;
    if (config.documentLanguage === "typst") {
      const doc = view.state.doc;
      if (this.typstCache?.doc === doc) typstRanges = this.typstCache.ranges;
      else {
        reportStatus(config.sessionKey, "pending");
        const request = ++this.request;
        try {
          this.typstClient ??= new TypstRangeClient();
          const ranges = await this.typstClient.request(doc.toString());
          if (request !== this.request || view.state.doc !== doc || !ranges) {
            if (view.state.doc !== doc) this.schedule();
            return;
          }
          typstRanges = ranges;
          this.typstCache = { doc, ranges };
        } catch {
          if (request === this.request && view.state.doc === doc)
            reportStatus(config.sessionKey, "error");
          return;
        }
      }
    }
    const language = chosenLanguage(config, view.state, ignored, typstRanges);
    if (isWebLanguage(config.documentLanguage)) {
      await this.runWeb(config, ignored, language, config.documentLanguage);
      return;
    }
    const doc = view.state.doc;
    if (!language) {
      reportStatus(config.sessionKey, "missing");
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
      hits.push(
        ...(config.documentLanguage === "typst"
          ? typstWords(view.state, range.from, range.to, ignored, typstRanges ?? [])
          : collectWords(view.state, range.from, range.to, ignored, config.documentLanguage)),
      );
    }
    const request = ++this.request;
    let bad: number[];
    try {
      bad = await this.checkWords(
        language,
        hits.map((hit) => hit.form),
        config,
        request,
      );
    } catch {
      if (request === this.request && view.state.doc === doc)
        reportStatus(config.sessionKey, "error");
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
      misses.push({
        from: hit.from,
        to: hit.to,
        word: hit.form,
        raw: view.state.doc.sliceString(hit.from, hit.to),
        language,
      });
      builder.add(hit.from, hit.to, spellError);
    }
    view.dispatch({ effects: setMarks.of({ deco: builder.finish(), misses }) });
    reportStatus(config.sessionKey, "active");
  }

  private async runWeb(
    config: SpellConfig,
    ignored: Set<string>,
    fallback: string | null,
    documentLanguage: WebLanguage,
  ): Promise<void> {
    const view = this.view;
    const state = view.state;
    const doc = state.doc;
    if (state.facet(activeLanguage)?.name !== documentLanguage) {
      reportStatus(config.sessionKey, "pending");
      return;
    }
    const end = Math.max(0, ...view.visibleRanges.map((range) => range.to));
    if (!ensureSyntaxTree(state, end, 20)) {
      reportStatus(config.sessionKey, "pending");
      return;
    }
    const groups = new Map<string, ReturnType<typeof passageWords>>();
    let missing = config.language !== "auto" && !fallback;
    for (const range of view.visibleRanges) {
      const passages = webSpellingPassages(
        state,
        documentLanguage,
        range.from,
        range.to,
        config.stringMode,
        config.identifiers,
      );
      for (const passage of passages) {
        const language =
          config.language === "auto" && passage.language !== null
            ? installedTag(passage.language)
            : fallback;
        if (!language) {
          missing = true;
          continue;
        }
        if (!groups.has(language)) {
          groups.set(language, []);
        }
        const words = passageWords(
          passage,
          (from, to) => doc.sliceString(from, to),
          language,
          doc.length,
        );
        for (const word of words) {
          if (word.to <= range.from || word.from >= range.to) continue;
          if (ignored.has(word.word.toLowerCase()) || ALLOWED.has(word.word.toLowerCase()))
            continue;
          groups.get(language)!.push(word);
        }
      }
    }
    const request = ++this.request;
    const entries = [...groups];
    const replies: Array<
      PromiseSettledResult<{
        language: string;
        words: ReturnType<typeof passageWords>;
        bad: number[];
      }>
    > = [];
    for (let offset = 0; offset < entries.length; offset += 8) {
      if (request !== this.request || view.state.doc !== doc) return;
      replies.push(
        ...(await Promise.allSettled(
          entries.slice(offset, offset + 8).map(async ([language, words]) => ({
            language,
            words,
            bad: await this.checkWords(
              language,
              words.map((word) => word.word),
              config,
              request,
            ),
          })),
        )),
      );
    }
    if (request !== this.request || view.state.doc !== doc) {
      if (view.state.doc !== doc) this.schedule();
      return;
    }
    const misses: Miss[] = [];
    for (const reply of replies) {
      if (reply.status !== "fulfilled") continue;
      for (const index of reply.value.bad) {
        const hit = reply.value.words[index];
        if (!hit || hit.from >= hit.to) continue;
        misses.push({
          from: hit.from,
          to: hit.to,
          word: hit.word,
          raw: hit.raw,
          language: reply.value.language,
          passage: hit.passage,
        });
      }
    }
    misses.sort((a, b) => a.from - b.from || a.to - b.to);
    const accepted: Miss[] = [];
    const builder = new RangeSetBuilder<Decoration>();
    let previous = -1;
    for (const miss of misses) {
      if (miss.from < previous) continue;
      previous = miss.to;
      accepted.push(miss);
      builder.add(miss.from, miss.to, spellError);
    }
    view.dispatch({ effects: setMarks.of({ deco: builder.finish(), misses: accepted }) });
    reportStatus(
      config.sessionKey,
      replies.some((reply) => reply.status === "rejected")
        ? "error"
        : missing
          ? "missing"
          : "active",
    );
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
    const language = miss.language;
    if (!language) return;
    const gen = ++this.menuGen;
    const snapshot = this.view.state.doc;
    const sessionKey = this.view.state.facet(spellConfig).sessionKey;
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
    if (miss.passage?.kind === "identifier") {
      this.fillMenu(host, miss, [], snapshot, sessionKey);
      this.placeMenu(host, event.clientX, event.clientY);
      return;
    }
    void api
      .spellcheckSuggest(language, miss.word)
      .then((suggestions) => {
        if (this.menuGen !== gen || this.menu !== host) return;
        this.fillMenu(host, miss, suggestions, snapshot, sessionKey);
        this.placeMenu(host, event.clientX, event.clientY);
      })
      .catch(() => {
        if (this.menu === host) {
          this.fillMenu(host, miss, [], snapshot, sessionKey);
          const pending = host.querySelector<HTMLElement>(".spell-menu-pending");
          if (pending) pending.textContent = "Suggestions unavailable";
          reportStatus(sessionKey, "error");
        }
      });
  }

  private fillMenu(
    host: HTMLDivElement,
    miss: Miss,
    suggestions: readonly string[],
    snapshot: Text,
    sessionKey: string,
  ): void {
    host.replaceChildren();
    if (suggestions.length === 0 && miss.passage?.kind !== "identifier") {
      const empty = document.createElement("div");
      empty.className = "spell-menu-pending";
      empty.textContent = "No suggestions";
      host.appendChild(empty);
    }
    for (const suggestion of suggestions) {
      const replacement = miss.passage ? encodeReplacement(suggestion, miss.passage) : suggestion;
      if (
        replacement === null ||
        this.view.state.readOnly ||
        this.view.state.facet(spellConfig).readOnly
      )
        continue;
      host.appendChild(
        this.item(suggestion, () => {
          const view = this.view;
          const current = view.state.doc.sliceString(miss.from, miss.to);
          if (
            view.state.doc !== snapshot ||
            view.state.facet(spellConfig).sessionKey !== sessionKey ||
            current !== miss.raw ||
            view.state.readOnly ||
            view.state.facet(spellConfig).readOnly
          )
            return;
          view.dispatch({
            changes: { from: miss.from, to: miss.to, insert: replacement },
            selection: { anchor: miss.from + replacement.length },
          });
          view.focus();
        }),
      );
    }
    const rule = document.createElement("div");
    rule.className = "spell-menu-sep";
    host.appendChild(rule);
    host.appendChild(this.item("Ignore", () => ignore(miss.word)));
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
