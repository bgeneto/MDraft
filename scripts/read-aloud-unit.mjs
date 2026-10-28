// Unit tests for Read Aloud: the sentence splitter, the voice choice and the
// queue that drives `speechSynthesis`.
//
//   node scripts/read-aloud-unit.mjs
//
// No application and no build: `src/read-aloud.ts` touches the DOM only inside
// the functions that need it, so Node can import it and exercise the pure half.
//
// What it is for: the three rules that are invisible until they are wrong. A
// sentence cut in the middle of `3.14` or `e.g.` makes the voice start again in
// the wrong place; `getVoices()` being empty on the first call makes the feature
// look broken on a machine that has voices; and a queue that trusts
// `speechSynthesis.speaking` hangs after a `cancel()` that never fires `onend`.
// The audible result cannot be asserted anywhere, so these are the parts that can.

import {
  MAX_RATE,
  MIN_RATE,
  chooseVoice,
  clampRate,
  createReadingQueue,
  splitSentences,
  voiceAvailabilityNote,
} from "../src/read-aloud.ts";

const checks = [];
function check(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A backend the test advances by hand, so ordering is never a race. */
function manualBackend() {
  return {
    calls: [],
    cancels: 0,
    events: null,
    speak(text, options, events) {
      this.calls.push({ text, options });
      this.events = events;
    },
    cancel() {
      this.cancels += 1;
      this.events = null;
    },
    /** Complete the utterance the queue is waiting on. */
    end() {
      const events = this.events;
      this.events = null;
      events?.onEnd();
    },
    fail(code) {
      const events = this.events;
      this.events = null;
      events?.onError(code);
    },
  };
}

const OPTIONS = { voiceName: "Microsoft Zira - English (United States)", rate: 1 };

// ---------------------------------------------------------------------------
console.log("=== splitSentences keeps sentences whole ===");
{
  const sentences = splitSentences("One. Two! Three?");
  check(sentences.length === 3, "three sentences", sentences.join(" | "));
  check(sentences[1] === "Two!", "punctuation stays with its sentence", sentences[1]);
}

{
  check(
    JSON.stringify(splitSentences("First line\nSecond line")) ===
      JSON.stringify(["First line", "Second line"]),
    "a newline is a sentence boundary, which is how list and table cells are read",
  );
}

{
  const sentences = splitSentences("The value is 3.14 exactly. Then it ends.");
  check(sentences.length === 2, "a decimal point does not split a sentence", sentences.join(" | "));
  check(sentences[0].includes("3.14"), "the decimal survives", sentences[0]);
}

{
  const sentences = splitSentences("Use e.g. this form. It is shorter.");
  check(sentences.length === 2, "an abbreviation does not split a sentence", sentences.join(" | "));
  check(sentences[0].includes("e.g. this"), "the abbreviation stays with its clause", sentences[0]);
}

{
  const sentences = splitSentences('He said "Stop." Then he left.');
  check(
    sentences.length === 2,
    "a quoted full stop still ends the sentence",
    sentences.join(" | "),
  );
  check(sentences[0].endsWith('"'), "the closing quote stays with the quotation", sentences[0]);
}

{
  const sentences = splitSentences("Really?! Yes.");
  check(sentences.length === 2, "a run of terminators is one boundary", sentences.join(" | "));
  check(sentences[0] === "Really?!", "the run is kept intact", sentences[0]);
}

{
  check(splitSentences("   \n\n  ").length === 0, "blank text produces nothing to say");
  check(splitSentences("— … ***").length === 0, "punctuation alone is not spoken");
}

{
  const source = Array.from({ length: 90 }, (_, index) => `word${index}`).join(" ");
  const chunks = splitSentences(source, 300);
  check(chunks.length > 1, "a long sentence is capped", `${chunks.length} chunks`);
  check(
    chunks.every((chunk) => chunk.length <= 300),
    "no chunk exceeds the cap",
    `longest ${Math.max(...chunks.map((chunk) => chunk.length))}`,
  );
  check(chunks.join(" ") === source, "capping never drops or duplicates a word");
  check(
    chunks.every((chunk) => /^word\d+/.test(chunk)),
    "a cut lands between words, not inside one",
  );
}

// ---------------------------------------------------------------------------
console.log("=== chooseVoice follows the saved name, then the language ===");
{
  const voices = [
    { name: "David", lang: "en-US", local: true, isDefault: true },
    { name: "Maria", lang: "pt-BR", local: true, isDefault: false },
    { name: "Daniel", lang: "pt-PT", local: true, isDefault: false },
  ];
  check(chooseVoice(voices, "Maria", "")?.name === "Maria", "a saved voice wins");
  check(
    chooseVoice(voices, "Gone", "pt-BR")?.name === "Maria",
    "an uninstalled voice falls back to the document's language",
  );
  check(chooseVoice(voices, "", "pt-BR")?.name === "Maria", "an exact language match is chosen");
  check(chooseVoice(voices, "", "pt")?.name === "Maria", "a base-language match is enough");
  check(
    chooseVoice(voices, "", "auto")?.name === "David",
    "auto falls back to the platform default",
  );
  check(chooseVoice(voices, "", "fr-FR")?.name === "David", "an unknown language falls back too");
  check(chooseVoice([], "Maria", "pt-BR") === null, "no voices chooses nothing");
  check(
    chooseVoice(voices, "Maria", "en-US")?.name === "Maria",
    "an explicit voice beats the document's language",
  );
}

{
  check(clampRate(0.1) === MIN_RATE, "a slow rate is clamped", String(clampRate(0.1)));
  check(clampRate(9) === MAX_RATE, "a fast rate is clamped", String(clampRate(9)));
  check(clampRate(Number.NaN) === 1, "a hand-edited file cannot produce NaN");
  check(clampRate(1.4) === 1.4, "a rate inside the range is kept");
}

// ---------------------------------------------------------------------------
console.log("=== the queue advances from its own index ===");
{
  const backend = manualBackend();
  const states = [];
  const errors = [];
  const queue = createReadingQueue(
    backend,
    (state) => states.push(state),
    (error) => errors.push(error),
  );

  queue.start(["one", "two", "three"], OPTIONS);
  check(backend.calls.length === 1, "only the first chunk is sent at start");
  check(backend.calls[0].text === "one", "the first chunk is the first sentence");
  check(
    queue.state().active && queue.state().index === 0 && queue.state().total === 3,
    "the state names the position",
    JSON.stringify(queue.state()),
  );

  backend.events.onStart();
  check(states.at(-1).active === true, "a started utterance re-publishes the state");

  backend.end();
  await tick();
  check(backend.calls.length === 2, "the next chunk follows the previous end");
  check(queue.state().index === 1, "the index moved", String(queue.state().index));

  backend.end();
  await tick();
  backend.end();
  await tick();
  check(queue.state().active === false, "the queue finishes after the last chunk");
  check(queue.state().total === 3, "the finished state still knows the total");
  check(errors.length === 0, "no error was reported");
}

{
  const backend = manualBackend();
  const queue = createReadingQueue(
    backend,
    () => {},
    () => {},
  );
  queue.start(["a", "b", "c"], OPTIONS);
  const pending = backend.events;
  queue.stop();
  check(queue.state().active === false, "stop clears the state immediately");
  check(backend.cancels >= 1, "stop cancels the synthesiser");
  pending.onEnd();
  await tick();
  check(backend.calls.length === 1, "a late onEnd after stop is ignored");
}

{
  const backend = manualBackend();
  const errors = [];
  const queue = createReadingQueue(
    backend,
    () => {},
    (error) => errors.push(error),
  );
  queue.start(["a"], OPTIONS);
  backend.fail("canceled");
  check(queue.state().active === true, "a cancellation reported by the backend is not a failure");
  queue.stop();
}

{
  const backend = manualBackend();
  const errors = [];
  const queue = createReadingQueue(
    backend,
    () => {},
    (error) => errors.push(error),
  );
  queue.start(["a", "b"], OPTIONS);
  backend.fail("synthesis-failed");
  check(queue.state().active === false, "a real failure stops the reading");
  check(errors.length === 1 && errors[0] === "synthesis-failed", "the failure is reported once");
  check(backend.calls.length === 1, "a failed chunk is not retried", String(backend.calls.length));
}

{
  const backend = manualBackend();
  const queue = createReadingQueue(
    backend,
    () => {},
    () => {},
  );
  queue.start(["a", "b"], OPTIONS);
  queue.start(["z"], OPTIONS);
  check(queue.state().total === 1 && queue.state().index === 0, "a new reading starts from zero");
  check(backend.calls.at(-1).text === "z", "the new text is what gets spoken");
  check(backend.cancels >= 1, "the previous reading was cancelled");
  queue.stop();
}

{
  // A backend that answers synchronously must not recurse once per chunk: the
  // queue defers the next step to the next task, so start() returns after one.
  let spoken = 0;
  const immediate = {
    speak(_text, _options, events) {
      spoken += 1;
      events.onStart();
      events.onEnd();
    },
    cancel() {},
  };
  const queue = createReadingQueue(
    immediate,
    () => {},
    () => {},
  );
  const chunks = Array.from({ length: 200 }, (_, index) => `sentence ${index}`);
  queue.start(chunks, OPTIONS);
  check(spoken <= 2, "a synchronous backend is advanced one chunk per task", `spoken ${spoken}`);
  queue.stop();
}

{
  const backend = manualBackend();
  const queue = createReadingQueue(
    backend,
    () => {},
    () => {},
  );
  queue.start([], OPTIONS);
  check(queue.state().active === false, "an empty reading never becomes active");
  check(backend.calls.length === 0, "an empty reading speaks nothing");
}

// ---------------------------------------------------------------------------
console.log("=== the Preferences note names the only way to add a voice ===");
{
  const windows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
  const voices = [{ name: "David", lang: "en-US", local: true, isDefault: true }];

  const normal = voiceAvailabilityNote(voices, "", windows);
  check(normal.includes("en-US"), "the installed languages are named", normal.slice(0, 60));
  check(normal.includes("Time & language"), "the Windows path is named");
  check(/offline/.test(normal), "it says the voices are the system's and offline");

  const removed = voiceAvailabilityNote(voices, "Maria", windows);
  check(removed.includes("no longer installed"), "an uninstalled saved voice is called out");
  check(removed.startsWith("The saved voice"), "the fallback is explained first");

  const none = voiceAvailabilityNote([], "", windows);
  check(none.includes("Read Aloud stays unavailable"), "no voices means no reading");
  check(none.includes("Nothing is downloaded"), "it does not promise a download");

  const linux = voiceAvailabilityNote(voices, "", "Mozilla/5.0 (X11; Linux x86_64)");
  check(linux.includes("speech-dispatcher"), "the Linux path names speech-dispatcher");
}

// ---------------------------------------------------------------------------
const failed = checks.filter((entry) => !entry.ok).length;
const passed = checks.length - failed;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
