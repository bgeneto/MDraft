//! Read aloud, with the voices the operating system already has.
//!
//! The Web Speech API is the only text-to-speech a webview exposes, and what it
//! offers is the platform's own catalogue: on Windows, Chromium's content layer
//! (`tts_win.cc`) enumerates the SAPI and OneCore voice tokens. The neural
//! "Online (Natural)" list the Edge browser shows is a service of that product,
//! marked `localService: false`, and is absent here — measured: 3 local voices
//! in this application against 321 cloud voices in Edge on the same machine.
//! The UI therefore promises "the system's voices", never a particular quality.
//!
//! Two measured behaviours shape this module. `getVoices()` is **empty on the
//! first call** and fills after `voiceschanged`, so availability is never
//! decided from the first read. And `speechSynthesis.speaking` is not a state
//! machine: a `cancel()` racing an `onend` leaves it false while an utterance is
//! still queued. The queue below advances from its own index and treats the
//! synthesiser as a speaker that may or may not answer.
//!
//! Nothing here is imported at build time from the DOM: the pure half
//! (`splitSentences`, `chooseVoice`, `createReadingQueue`) runs under Node for
//! `scripts/read-aloud-unit.mjs`.

export interface VoiceOption {
  name: string;
  lang: string;
  /** The voice ships with the machine, as opposed to a network service. */
  local: boolean;
  /** The platform's suggested voice for its own language. */
  isDefault: boolean;
}

export interface ReadingState {
  active: boolean;
  /** Zero-based index of the chunk being spoken. */
  index: number;
  total: number;
  voice: string;
}

export interface SpeakOptions {
  voiceName: string;
  rate: number;
}

export interface SpeakEvents {
  onStart: () => void;
  onEnd: () => void;
  onError: (error: string) => void;
}

/** The part of `SpeechSynthesis` the queue needs; injectable for the unit test. */
export interface SpeechBackend {
  speak(text: string, options: SpeakOptions, events: SpeakEvents): void;
  cancel(): void;
}

export interface ReadingQueue {
  start(chunks: string[], options: SpeakOptions): void;
  stop(): void;
  state(): ReadingState;
}

/** Longest text sent as one utterance. */
export const MAX_CHUNK = 300;
export const MIN_RATE = 0.5;
export const MAX_RATE = 2;

const TERMINATORS = ".!?…";
const CLOSERS = "\"'”’)]}";

export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
}

function hasWords(text: string): boolean {
  return /[0-9\p{L}]/u.test(text);
}

/**
 * Split a paragraph into sentences, then cap each one.
 *
 * A sentence ends at `.`, `!`, `?` or `…` followed by whitespace and something
 * that does not look like a continuation — a lower-case letter or a digit, which
 * keeps `e.g. this` and `3.14` in one piece. A newline ends a sentence too: the
 * rendered preview gives one block per line inside lists and tables, and a block
 * boundary is a better pause than any punctuation rule.
 *
 * The cap exists because one utterance per sentence is what makes Stop instant
 * and progress visible; a paragraph with a single full stop would otherwise be
 * one long utterance. Cuts happen at a space, comma, semicolon or dash, never
 * inside a word.
 */
export function splitSentences(text: string, maxLength = MAX_CHUNK): string[] {
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
  if (!normalized) return [];

  const sentences: string[] = [];
  const chars = Array.from(normalized);
  let buffer = "";

  const flush = (): void => {
    const sentence = buffer.trim();
    buffer = "";
    if (hasWords(sentence)) sentences.push(sentence);
  };

  for (let i = 0; i < chars.length; i++) {
    const character = chars[i];
    if (character === "\n") {
      flush();
      continue;
    }
    buffer += character;
    if (!TERMINATORS.includes(character)) continue;

    // Absorb `...`, `?!` and the closing quote or bracket that follows them, so
    // a quotation is not left with a stray `"` at the start of the next chunk.
    let j = i + 1;
    while (j < chars.length && TERMINATORS.includes(chars[j])) {
      buffer += chars[j];
      j += 1;
    }
    while (j < chars.length && CLOSERS.includes(chars[j])) {
      buffer += chars[j];
      j += 1;
    }

    const next = chars[j];
    if (next !== undefined && next !== " " && next !== "\n") continue;
    const after = chars.slice(j).find((c) => c !== " " && c !== "\n");
    if (after !== undefined && /[\p{Ll}\d]/u.test(after)) continue;

    flush();
    i = j - 1;
  }
  flush();

  return sentences.flatMap((sentence) => capChunk(sentence, maxLength));
}

function capChunk(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxLength) {
    let cut = -1;
    for (let i = maxLength; i > maxLength * 0.4; i--) {
      if (/[ ,;:—–-]/.test(rest[i])) {
        cut = i;
        break;
      }
    }
    if (cut <= 0) cut = maxLength;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces.filter(hasWords);
}

/**
 * The saved voice, else the document's language, else the platform's default.
 *
 * The saved name wins even when its language differs: choosing a voice is a
 * deliberate act, and a Portuguese document read by an English voice is still
 * what the reader asked for. Only when that voice has been uninstalled does the
 * language take over, so removing a language pack does not silence the feature.
 */
export function chooseVoice(
  voices: VoiceOption[],
  savedName: string,
  languageTag: string,
): VoiceOption | null {
  if (voices.length === 0) return null;

  if (savedName) {
    const saved = voices.find((voice) => voice.name === savedName);
    if (saved) return saved;
  }

  const tag = languageTag.trim().toLowerCase();
  if (tag && tag !== "auto") {
    const exact = voices.find((voice) => voice.lang.toLowerCase() === tag);
    if (exact) return exact;
    const base = tag.split("-")[0];
    const sameLanguage = voices.find((voice) => voice.lang.toLowerCase().split("-")[0] === base);
    if (sameLanguage) return sameLanguage;
  }

  return voices.find((voice) => voice.isDefault) ?? voices[0];
}

function idleState(voice = ""): ReadingState {
  return { active: false, index: 0, total: 0, voice };
}

/**
 * One utterance at a time, advanced by our own index.
 *
 * `stop()` is synchronous from the caller's point of view: it clears the state
 * and cancels, and every callback that arrives afterwards is ignored because the
 * utterance it belongs to is no longer current.
 */
export function createReadingQueue(
  backend: SpeechBackend,
  onChange: (state: ReadingState) => void,
  onError: (error: string) => void,
): ReadingQueue {
  let chunks: string[] = [];
  let index = 0;
  let active = false;
  let options: SpeakOptions = { voiceName: "", rate: 1 };

  const emit = (): void => {
    onChange({ active, index, total: chunks.length, voice: options.voiceName });
  };

  const step = (): void => {
    if (!active) return;
    if (index >= chunks.length) {
      active = false;
      emit();
      return;
    }

    backend.speak(chunks[index], options, {
      onStart: () => {
        if (active) emit();
      },
      onEnd: () => {
        if (!active) return;
        index += 1;
        // Deferred: a backend that answers synchronously (the unit test's fake)
        // would otherwise recurse once per chunk and overflow the stack.
        setTimeout(step, 0);
      },
      onError: (error) => {
        if (!active) return;
        // Our own `cancel()` reports itself this way; it is not a failure.
        if (error === "interrupted" || error === "canceled") return;
        active = false;
        emit();
        onError(error);
      },
    });
  };

  return {
    start(nextChunks, nextOptions) {
      // A second reading replaces the first; the cancel it sends reports itself
      // as `interrupted` and is ignored above.
      active = false;
      backend.cancel();
      chunks = nextChunks;
      index = 0;
      options = nextOptions;
      active = chunks.length > 0;
      emit();
      step();
    },
    stop() {
      if (!active) return;
      active = false;
      chunks = [];
      index = 0;
      backend.cancel();
      emit();
    },
    state() {
      return { active, index, total: chunks.length, voice: options.voiceName };
    },
  };
}

/** The browser's synthesiser, or null where the webview has none. */
export function browserBackend(): SpeechBackend | null {
  if (typeof window === "undefined") return null;
  if (!("speechSynthesis" in window)) return null;
  if (typeof SpeechSynthesisUtterance === "undefined") return null;

  const synthesis = window.speechSynthesis;
  let current: SpeechSynthesisUtterance | null = null;

  return {
    speak(text, options, events) {
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = options.voiceName
        ? synthesis.getVoices().find((entry) => entry.name === options.voiceName)
        : undefined;
      // A saved voice that has since been uninstalled falls back to the
      // platform's default rather than muting the reader.
      if (voice) utterance.voice = voice;
      utterance.rate = clampRate(options.rate);

      utterance.onstart = () => {
        if (current === utterance) events.onStart();
      };
      utterance.onend = () => {
        if (current !== utterance) return;
        current = null;
        events.onEnd();
      };
      utterance.onerror = (event) => {
        if (current !== utterance) return;
        current = null;
        events.onError(event.error ?? "error");
      };

      current = utterance;
      synthesis.speak(utterance);
    },
    cancel() {
      current = null;
      synthesis.cancel();
    },
  };
}

export function readVoices(): VoiceOption[] {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
  return window.speechSynthesis.getVoices().map((voice) => ({
    name: voice.name,
    lang: voice.lang,
    local: voice.localService,
    isDefault: voice.default,
  }));
}

export interface ReadAloudOptions {
  rate: () => number;
  /** The saved voice name, or "" for automatic. */
  voiceName: () => string;
  /** The document's language hint (`"pt-BR"`), or "" / `"auto"` for none. */
  languageTag: () => string;
  onChange: (state: ReadingState) => void;
  onError: (message: string) => void;
}

export interface ReadAloudHandle {
  /** Start reading `text`; false when there is nothing to say. */
  start(text: string): boolean;
  stop(): void;
  isActive(): boolean;
  state(): ReadingState;
  /** Why reading cannot start, or null when it can. */
  availableReason(): string | null;
  voices(): VoiceOption[];
  refreshVoices(): Promise<VoiceOption[]>;
}

/** How long to wait for `voiceschanged` before believing the list is empty. */
const VOICE_WAIT_MS = 2500;

function explain(error: string): string {
  if (error === "not-allowed") {
    return "The webview blocked audio until the window has been clicked.";
  }
  if (error === "audio-busy" || error === "audio-hardware") {
    return "The audio device is not available.";
  }
  return `Reading aloud failed: ${error}.`;
}

export function createReadAloud(options: ReadAloudOptions): ReadAloudHandle {
  const backend = browserBackend();
  const queue = backend
    ? createReadingQueue(backend, options.onChange, (error) => options.onError(explain(error)))
    : null;

  let list: VoiceOption[] = [];
  let loaded = false;

  return {
    start(text) {
      if (!queue) {
        options.onError("This webview has no speech synthesis.");
        return false;
      }
      const chunks = splitSentences(text);
      if (chunks.length === 0) return false;
      const voice = chooseVoice(list, options.voiceName(), options.languageTag());
      queue.start(chunks, { voiceName: voice?.name ?? "", rate: clampRate(options.rate()) });
      return true;
    },
    stop() {
      queue?.stop();
    },
    isActive() {
      return queue?.state().active ?? false;
    },
    state() {
      return queue?.state() ?? idleState();
    },
    availableReason() {
      if (!queue) return "This webview has no speech synthesis.";
      if (!loaded) return "Looking for installed voices…";
      if (list.length === 0) {
        return "No voices are installed. Add one in the operating system's speech settings.";
      }
      return null;
    },
    voices() {
      return list;
    },
    async refreshVoices() {
      list = readVoices();
      if (list.length === 0 && backend && typeof window !== "undefined") {
        // Measured: `getVoices()` is empty on the first call, even on a machine
        // with voices installed. Waiting for the event is the only reliable
        // answer; the timeout keeps a webview that never fires it from hanging.
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            window.speechSynthesis.removeEventListener("voiceschanged", finish);
            resolve();
          };
          const timer = window.setTimeout(finish, VOICE_WAIT_MS);
          window.speechSynthesis.addEventListener("voiceschanged", finish, { once: true });
        });
        list = readVoices();
      }
      loaded = true;
      return list;
    },
  };
}

/**
 * The sentence Preferences shows under the voice picker.
 *
 * It names the platform's own path, because the application cannot install a
 * voice for the reader and must not pretend otherwise. A saved voice that has
 * been removed is called out separately: that is a silent fallback otherwise.
 */
export function voiceAvailabilityNote(
  voices: VoiceOption[],
  savedName: string,
  userAgent: string,
): string {
  const agent = userAgent;
  let how: string;
  if (/Windows/i.test(agent)) {
    how =
      "Add one in Settings → Time & language → Language & region: add the language, " +
      "then turn on its Speech optional feature.";
  } else if (/Linux/i.test(agent)) {
    how =
      "Install speech-dispatcher and a synthesiser for that language; the Linux build " +
      "speaks through the system's speech service.";
  } else if (/Mac/i.test(agent)) {
    how =
      "Add one in System Settings → Accessibility → Spoken Content → System Voice → Manage Voices.";
  } else {
    how = "Install that language's voice in the operating system.";
  }

  if (voices.length === 0) {
    return `No voice is installed, so Read Aloud stays unavailable. ${how} Nothing is downloaded by MDraft.`;
  }

  const missing = savedName && !voices.some((voice) => voice.name === savedName);
  const languages = [...new Set(voices.map((voice) => voice.lang))].join(", ");
  const prefix = missing
    ? `The saved voice “${savedName}” is no longer installed, so the default is used instead. `
    : "";
  return `${prefix}MDraft reads with the voices the system already has (${languages}), offline — they sound like the operating system, not like a neural web service. ${how}`;
}
