# Read Aloud with the Operating System's Voices

**Status:** done
**Date:** 2026-10-28
**ADR:** none

## Context and goal

The editor cannot be heard. A reader who wants to proofread by ear, or listen to a
long document, has to leave the application.

The platform already provides the capability, and it was measured on this host on
2026-10-28 with the release binary inside WebView2: `window.speechSynthesis` and
`SpeechSynthesisUtterance` exist; `getVoices()` returns **0 on the first call** and
**3 after `voiceschanged`** (Microsoft David, Mark and Zira, all `localService:
true`); `speak()` starts in **116 ms**; a 56-character, two-sentence utterance
reports **9 word boundaries and 2 sentence boundaries** and ends after 5.2 s.

The same API in the Edge browser on the same machine reports **321 voices, every
one of them `localService: false`** — the cloud "Online (Natural)" catalogue,
including Francisca, Antônio and Thalita in pt-BR. Those voices belong to the Edge
product, are not exposed to an embedder, and would need the network. Chromium's
`content/browser/speech/tts_win.cc` enumerates exactly two sources: `ISpVoice`
(SAPI) and `HKLM\SOFTWARE\Microsoft\Speech_OneCore\Voices`. This machine has only
three en-US tokens installed, which is why the pt-BR voice the reader hears in Edge
cannot appear in this application.

Goal: read the rendered document aloud offline, from the editor's right-click
menu, with a visible way to stop — and tell the truth about voice quality instead
of promising Edge's.

## Scope and non-scope

In scope:

- Editor context menu: **Read Aloud from Here** (from the block at the caret to the
  end), **Read Aloud from the Beginning**, and **Stop Reading** while a reading is
  active.
- A **Reading…** status-bar chip with a Stop button, visible only while speaking.
- Preferences › Read Aloud: voice, rate, and a dynamic note with the Windows path
  for installing another language, shown when no installed voice matches the
  document.
- The spoken text is a **snapshot of the rendered preview**, block by block,
  through the existing `data-line` anchors — not the source buffer.
- Stops on: Stop, tab switch, document close or reload, window close, and starting
  another reading.

Out of scope (deliberate):

- **Any network.** No cloud voices, no download of voices or models.
- **Sentence highlighting** in preview or source. Phase 2; the boundary events
  measured above make it possible, but it needs the word map.
- **Per-sentence pause/resume** and resuming where a tab switch interrupted.
- **The HTML tab.** The guest is an opaque-origin iframe the parent cannot read;
  the two entries are disabled there with a reason, and the chip never appears.
- **A main-menu entry and a keyboard shortcut.** `tools.readAloud` is a small
  follow-up once the behaviour has been used.
- **Reading raw source.** `**bold**`, `|` table pipes and `$math$` are not spoken.

## Approach and rejected alternatives

A frontend-only `src/read-aloud.ts` owns a queue of sentences and drives
`window.speechSynthesis` one utterance at a time. The text comes from the preview,
because the preview is what the reader sees and it has already discarded the
markup; `previewAnchors` and `anchorIndexForLine` in `main.ts` already map a caret
line to its top-level block, so "from here" needs no new mapping code.

One utterance per sentence, capped at about 300 characters, because that gives Stop
an immediate effect, a progress count for the chip, and isolates the queue stalls
and dropped `onend` that `speechSynthesis` is known for. The module never treats
`speechSynthesis.speaking` as its own state. Voices load asynchronously — measured:
empty on the first call — so the module waits for `voiceschanged` before concluding
that a machine has no voices.

Rejected:

- **WinRT `Windows.Media.SpeechSynthesis` plus `MediaPlayer` in Rust.** The same
  local voice set with SSML, for 300–400 lines of Rust, a Cargo feature, playback
  ownership and platform stubs. Only worth it if SSML is ever required.
- **Edge's "Online (Natural)" voices.** They are exactly why Edge sounds better,
  they are cloud voices (`localService: false`), they are not offered to WebView2,
  and they would break the no-outbound-request rule.
- **Reading the source selection verbatim.** Free, but it speaks the markup.
- **Stripping markup from the source with the Lezer tree.** Tables, code fences,
  link destinations and formulas each become an edge case, when the rendered
  preview has already solved them.
- **Bundling a neural engine (Piper, Kokoro).** The best offline quality, but a
  model download, a model licence, tens of megabytes and an inference build — its
  own plan if phase 1 is not enough.

## Steps

- [x] `src/read-aloud.ts`: the pure layer first — sentence splitting with the
  length cap, voice choice (saved name → first exact language match → default), and
  the queue over an injected synthesiser interface — then the DOM binding to
  `window.speechSynthesis`.
- [x] `src/context-menu.ts`: the three entries; availability from the preview's
  text and the document language, with the reason as the item's `title`; Stop only
  while a reading is active.
- [x] `src/main.ts`: wire the callbacks, collect block text from
  `anchorIndexForLine(editor.cursorInfo().line)`, stop on `activateSession`, close,
  reload and window close, and drive the chip.
- [x] `index.html` and `src/styles.css`: `#status-reading` chip beside
  `#status-zoom`, `hidden` by default, with a Stop button and an accessible label.
- [x] `src-tauri/src/settings.rs`, `src/api.ts`, `src/preferences.ts`:
  `readAloudVoice` (string, `""` = automatic) and `readAloudRate` (number,
  0.5–2.0, step 0.1, default 1), plus the Read Aloud section and its note.
- [x] `scripts/read-aloud-unit.mjs`: splitting, the cap, voice choice, queue order,
  Stop mid-queue, `cancel()` races, a `not-allowed` error, and an empty voice list.
- [x] `scripts/read-aloud-test.mjs`: the real UI — menu entries and their enabled
  state per language, a click that starts and shows the chip, Stop that clears it,
  a tab switch that stops, and Preferences listing, saving and restoring the voice.
- [x] Register both suites in `scripts/test-all.mjs` and `package.json`, update the
  script tables and counts in `AGENTS.md`, and extend `scripts/dom-smoke.mjs` with the
  new Preferences rows.

## Files and modules

- `src/read-aloud.ts` — new: voice enumeration, sentence queue, state machine.
- `src/context-menu.ts` — three entries and their availability reasons.
- `src/main.ts` — lifecycle wiring, preview text extraction, chip updates.
- `index.html`, `src/styles.css` — the chip.
- `src/preferences.ts` — the Read Aloud section and the install-voices note.
- `src/api.ts`, `src-tauri/src/settings.rs` — two additive fields; `#[serde(default)]`
  keeps every existing `settings.json` loading.
- `scripts/read-aloud-unit.mjs`, `scripts/read-aloud-test.mjs` — new.
- `scripts/test-all.mjs`, `AGENTS.md` — registration, the script tables and the
  counts. `scripts/dom-smoke.mjs` and `scripts/format-document-test.mjs` also moved:
  the first asserts the Preferences section list and the second the exact editor menu
  order, so both name the new rows. `README.md` needed nothing — it quotes no counts.

No `#[tauri::command]`, no capability and no CSP change; the Web Speech API is
plain DOM.

## Risks and rollback

- **Voice quality is the system's.** This host has three en-US voices, so a
  Portuguese document is read with English phonemes. Preferences must name the
  Windows path and must not offer a voice that is not installed.
- **Linux.** Measured in the WSL2 image used for Linux builds: `libspeechd` absent
  and `libwebkit2gtk-4.1` not linked against it, so the API may exist with no
  voices. Every entry point must disable itself with a reason rather than throw.
- **Chromium queue quirks.** A `cancel()` racing an `onend` can leave a stale
  utterance; the queue advances from its own state and a failure stays local to one
  sentence.
- **The HTML tab** reads nothing: disabled with a reason, never a silent no-op.
- **Rollback:** revert the branch. The two settings fields are ignored by the
  previous build and by any other document type.

## Tests and validation

Recorded on 2026-10-28, Windows x64, release build:

- `npm run build` — typecheck and bundle, pass.
- `npm run read-aloud:unit` — **59/59**, no application.
- `npm run read-aloud` — **44/44**, run three times; 4.0 s per run. The measurement
  that proves it works: after choosing Read Aloud from Here the chip shows
  `Reading 1/N`, the synthesiser reports speaking, the chip reaches `Reading 2/N` on
  its own, and Stop makes both the chip and `speechSynthesis.speaking` false; on the
  HTML tab both entries are disabled and the tooltip names the reason.
- `npm run smoke` — **114/114** (was 113; the Preferences section list is one longer
  and the suite now names the Read Aloud rows).
- `npm run menu` — **101/101**: the native menu is untouched.
- `npm run format:document` — **141/141**; its expected editor-menu order gained the
  two new labels.
- `npm run preview:zoom` — **24/24**; the chip is a sibling of the zoom chip and
  hidden when idle.
- `npm run test:rust` — **199 passed, 2 ignored**.
- `npm run lint`, `npm run format:check`, `npm run knip` — clean.

Audio itself cannot be asserted over CDP. The suite asserts engine state and the
visible chip, and says so rather than implying it heard anything.

## Deviations

- **Formulas, diagrams and code fences are not spoken.** The preview is cloned per
  block and `.katex`, `.mermaid` and `pre` are dropped before the text is taken.
  KaTeX draws a hidden MathML copy beside the visual one, so the plan's "the
  preview's text" would have read every formula twice, and a fenced block read
  character by character is noise. Recorded in `SILENT_IN_PREVIEW` in `main.ts`.
- **The language hint is the spelling language.** The document's natural language
  comes from `settings.spellcheckLanguage`, the application's only existing statement
  about it; `"auto"` leaves the voice to the platform default. The plan said "the
  document's language" without naming a source.
- **The `number` preference row gained a `step`.** It rendered `step="1"`, which
  made the 0.1 rate granularity impossible; the row type now carries an optional
  step, defaulting to 1 for every existing row.
- **`dom-smoke.mjs` asserts the section count and names**, so it moved from ten to
  eleven sections and gained a check on the Read Aloud rows — the "Test" step of
  *Adding a preference, end to end* rather than a new decision.
- **`format-document-test.mjs` asserts the exact editor menu order**, so its
  expected list gained the two labels. Nothing else about that suite changed.
- **The window close guard stops the reading** before the lifecycle close runs, so a
  cancelled close leaves no voice talking over the dialog.

## Acceptance criteria

- Right-clicking in the editor offers Read Aloud; choosing it speaks from the block
  at the caret and the status bar shows a Reading chip with Stop.
- Stop silences the voice and removes the chip within one second; pressing it twice
  does not throw.
- Switching tabs, closing the document or closing the window stops the reading.
- On an HTML document both entries are disabled and the tooltip explains why; the
  same on a document with no rendered text.
- Preferences › Read Aloud lists the installed voices with their language, keeps the
  choice and the rate across a restart, and explains how to install another language
  when no voice matches the document.
- With no voices at all — the Linux case — the window opens, the entries are
  disabled with a reason, and nothing throws.
- No network request is made at any point.

## Open questions

- *Read Aloud from Here* continues to the end of the document — decided and shipped,
  as in Word and LibreOffice.
- The rate control is 0.5–2.0 in 0.1 steps — shipped, and no other pacing control.
- A Tools › Read Aloud entry and a shortcut are deferred. If the context menu proves
  undiscoverable, they are a small addition. The Preferences section is the one
  discoverable place today.
- Typst Pages has no `data-line` anchors, so *from Here* is disabled there with
  "This preview has no source positions." and only *from the Beginning* reads the PDF
  text layer in DOM order, page by page, so a running head or a page number can be
  spoken. Acceptable for phase 1; fixing it properly needs the source map.
