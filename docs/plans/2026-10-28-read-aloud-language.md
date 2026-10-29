# Read Aloud: choose the voice from the document's language

**Status:** done
**Date:** 2026-10-28
**ADR:** none

## Context and goal

Read Aloud picks the English default voice for Portuguese documents. Reproduced
on 2026-10-28 with the installed 0.6.1 build (Windows x64, WebView2 156) and
`C:\Users\bernh\Documents\backlog.md`: the status chip's own title read
`Reading aloud with Microsoft David - English (United States)`. The machine has
five local voices — David, Mark and Zira (`en-US`, David default) and Daniel and
Maria (`pt-BR`) — and `settings.json` holds `readAloudVoice: ""` (Automatic) and
`spellcheckLanguage: "auto"` (the default).

The root cause is in `src/main.ts`, not in the synthesiser and not in
`chooseVoice`:

```ts
languageTag: () => (settings.spellcheckLanguage === "auto" ? "" : settings.spellcheckLanguage),
```

With the default `"auto"` the tag is empty, so `chooseVoice` skips its language
branch and returns `voices.find((voice) => voice.isDefault) ?? voices[0]` —
David. Passing `pt-BR` explicitly chooses Daniel with the same five voices, which
proves the rest of the chain is sound. Three further facts make the bug worse:

- Nothing reads a language the document declares (`lang:` in YAML front matter,
  `:lang:` in AsciiDoc, `#set text(lang: …)` in Typst).
- The spoken preview text is never inspected, although the spelling feature
  already has an English/Portuguese detector (`vote` in `src/spellcheck.ts`).
  That detector lives inside a CodeMirror `ViewPlugin`, needs two samples and is
  unreachable from Read Aloud.
- `browserBackend` never sets `SpeechSynthesisUtterance.lang`, so even a caller
  that knows the language cannot tell the engine when no voice name matches.

Goal: **Automatic** voice selection follows the document's language. A language
the document declares wins; otherwise a confident English/Portuguese detection
from the spoken text; otherwise the pinned Dictionary setting; otherwise the
operating system's dictionaries vote; otherwise the platform default. The chosen
voice's language is always put on the utterance. No new dependency, no new
setting, no network.

## Scope and non-scope

**In scope**

- A new pure module `src/language.ts`:
  - the English/Portuguese function-word lists and Portuguese diacritic rule
    moved out of `src/spellcheck.ts`, so spelling and reading share one source;
  - `proseWords`, `voteProse`, `detectProseLanguage`;
  - `normalizeLanguageTag`;
  - `declaredLanguage(source, markup)` for Markdown front matter, AsciiDoc
    attributes, Typst `#set text(lang:)` and HTML `<html lang="…">`;
  - `voteInstalledLanguage(words, candidates, check, timeoutMs)`, a bounded,
    injected-checker vote over the installed dictionaries.
- `src/spellcheck.ts` imports the shared lists/vote; underlining behaviour is
  unchanged.
- `src/read-aloud.ts`:
  - `chooseVoice` normalises `_`/case, prefers an exact region then the base
    language, prefers local voices within a language, and never picks a remote
    voice automatically (the application promises offline reading);
  - `SpeakOptions` carries `lang`;
  - `start(text, languageTag?)` takes the resolved tag;
  - `browserBackend` sets `utterance.lang` (the chosen voice's language, or the
    resolved tag) before `utterance.voice`.
- `src/main.ts`:
  - `resolveDocumentLanguage(spokenText)` with the precedence below, cached per
    session revision and spelling-language setting;
  - `startReadAloud` awaits the probe with a request token, so Stop, a tab
    switch or a second start cancels a pending probe;
  - the existing `languageTag` callback remains as the fallback for callers that
    pass no explicit tag.
- `src/context-menu.ts`: the `readAloud` callback may return `Promise<void>`
  (the menu already handles and reports a rejected promise).
- `src/preferences.ts`: the Voice row's help names the sources in order and says
  that a document can declare `lang`.
- Tests, the counts in `AGENTS.md`, and a trap entry.

**Non-scope**

- No new npm, cargo or font dependency.
- No new settings field or schema change; older `settings.json` files keep
  loading unchanged.
- No new Preferences row. The existing Voice picker's explicit choice, and its
  first option “Follow the document language”, remain the override.
- No change to spelling underlines, only the shared word lists.
- No sentence highlighting, resume, main-menu entry or shortcut; the HTML tab
  still cannot be read.
- No cloud/remote voices. A manually chosen remote voice is still honoured —
  that is a deliberate act — but Automatic only considers local voices.
- Does not address the unrelated observation that a raw
  `speechSynthesis.cancel()` from outside the application leaves the chip up;
  the application's Stop path clears it.

## Approach and rejected alternatives

Resolution order, strongest evidence first:

1. **The saved voice** (`readAloudVoice`) — a deliberate choice, unchanged.
2. **A language the document declares**: `lang`/`language` in YAML front matter,
   `:lang:`/`:language:` in an AsciiDoc header, `#set text(lang: "…")` in Typst,
   `<html lang="…">` in HTML. The author's statement is authoritative.
3. **A confident prose detection** from the text about to be read
   (`previewReadAloudText(true)`), using the existing 40-word, 1.5×-margin
   function-word + diacritic vote. The preview already excludes code, formulas
   and diagrams.
4. **The pinned Dictionary** (`spellcheckLanguage !== "auto"`). This is a
   spelling setting, so it is a hint for reading, not a veto: a clearly
   Portuguese document is read in Portuguese even when the dictionary is pinned
   to English.
5. **The installed dictionaries vote**: lowercase and deduplicate up to ~600
   prose words, ask `spellcheck_check` for each installed tag in parallel, and
   accept the best only when it rejects at most ~35 % of the sample and beats
   the runner-up by at least ~15 points. All calls race a short timeout (about
   800 ms). Any failure or timeout returns null and never blocks the reading.
   This covers a French or Spanish document on a machine with those dictionaries
   even though the pure detector only knows English and Portuguese.
6. **The platform default**, as today.

The exact vote thresholds were checked on this host's `en` and `pt-BR`
dictionaries. A 28-word Portuguese note, deliberately below the pure detector's
40-word floor, selected `pt-BR` through the real `spellcheck_check` vote, so the
35 % absolute and 15-point margin hold for the two installed languages. The
fixtures themselves are long enough for the faster pure detector; the vote is
the fallback measured by the unit test and that note.

`chooseVoice` also gets a `best` helper: within a matching language, prefer
local + platform default, then local, then platform default, then the first.
An exact region (`pt-BR`) beats the base (`pt`), and `pt-PT` with only `pt-BR`
installed still uses the Portuguese voice rather than English. A saved voice
that is no longer installed falls back to the language, as today.

Rejected:

- **Keep using only `spellcheckLanguage`.** That is the bug: Automatic is the
  default and supplies no tag.
- **Read the spelling plugin's committed language.** It needs two samples, is
  disabled when spelling is off, is global across tabs, and is not available to
  the pure unit test. A direct pure detector has none of those races.
- **Follow `navigator.language`.** The WebView is started with `--lang=en-US`
  regardless of the document; it would reproduce the bug.
- **Add `franc`, `tinyld` or a WASM detector.** A new dependency, bundle and
  licence review for languages the app does not claim to detect. A declared
  `lang` already covers them, and the dictionary vote covers installed ones.
  Revisit if readers ask for automatic Spanish/French detection without a
  declared language.
- **A new “Reading language” preference.** Another control to explain; the
  Voice picker and the document's `lang` are enough.
- **Choose the voice from the dictionary setting only when spelling is on.**
  Reading should not depend on the spelling feature.
- **Force the English default when no voice matches the language.** That is the
  current silent behaviour; the chip will still name the fallback voice and the
  Preferences note explains how to install another language.

## Steps

- [x] `src/language.ts`: shared word lists, `proseWords`, `voteProse`,
  `detectProseLanguage`, `normalizeLanguageTag`, `declaredLanguage` and
  `voteInstalledLanguage`, with the why-comments the surrounding modules use.
- [x] `src/spellcheck.ts`: delete the local copies and import the shared vote;
  behaviour, thresholds and the two-sample confirmation stay exactly as they
  are.
- [x] `src/read-aloud.ts`: normalise and rank tags in `chooseVoice`; add `lang`
  to `SpeakOptions`; accept an optional tag in `start`; set `utterance.lang` in
  `browserBackend`; keep the saved-name rule first.
- [x] `src/main.ts`: supply the live source, markup, pinned setting, dictionary
  list and checker to `resolveDocumentLanguage` in `language.ts`; add the cache;
  make `startReadAloud` async with a request token; pass the resolved tag to
  `start`; reset the token in `stopReadAloud`; leave the existing callback as the
  fallback.
- [x] `src/context-menu.ts`: widen the `readAloud` type to
  `void | Promise<void>`.
- [x] `src/preferences.ts`: update the Voice help text.
- [x] `scripts/read-aloud-unit.mjs`: detection and metadata cases; the exact
  five-voice host list; remote-voice avoidance; `utterance.lang` through a fake
  `speechSynthesis`; the dictionary vote with a fake checker.
- [x] `scripts/read-aloud-test.mjs`: open `samples/word-sync.md`, start from the
  beginning, and require the chip title to name an installed `pt` voice when one
  exists; otherwise report a visible skip. Return to the Markdown fixture.
- [x] Run the validation below; update the two counts and the Testing table in
  `AGENTS.md`; add the trap.

## Files and modules

- `src/language.ts` — new; the pure language layer, no DOM and no imports, so
  Node can test it directly.
- `src/spellcheck.ts` — imports the shared vote instead of owning a second copy
  of the word lists.
- `src/read-aloud.ts` — voice ranking, the language on the utterance, the
  optional explicit tag.
- `src/main.ts` — the live-buffer inputs to the resolver, the per-revision
  cache, the async start and its cancellation token.
- `src/context-menu.ts` — the callback type only.
- `src/preferences.ts` — the Voice row's help sentence.
- `scripts/read-aloud-unit.mjs` — the pure checks and the fake backend.
- `scripts/read-aloud-test.mjs` — the real Portuguese document check.
- `AGENTS.md` — the Read Aloud counts in the script table and the Testing table,
  plus the trap.
- `docs/plans/2026-10-28-read-aloud-language.md` — this plan.

No Tauri command, capability, CSP or settings-schema change. `README.md` quotes
no Read Aloud count and has no Read Aloud bullet to update.

## Risks and rollback

- **Misdetection on a short or mixed document.** The pure vote returns null
  below 40 words or without a 1.5× margin; the pinned setting, dictionary vote
  and default follow. The explicit Voice picker always wins. A wrong automatic
  choice is one click away from fixed, and the chip names the voice.
- **A bilingual document.** The whole preview is sampled, so the dominant
  language wins; the explicit picker covers a per-section need. Recorded as an
  open question, not a blocker.
- **The dictionary vote delays the first sentence.** It only runs when the
  faster signals are inconclusive, and is bounded by a JS timeout; a timeout is
  a fallback, not an error.
- **The Rust spellcheck worker is a single STA thread.** A vote queues behind an
  underline check. The timeout keeps that from becoming a stuck menu command;
  the worker's own 3 s timeout still applies.
- **The shared word-list move could change spelling.** The functions are moved
  verbatim; `npm run spellcheck`, `npm run read-aloud:unit` and `npm run smoke`
  are the guard. If a difference appears, the move is reverted without touching
  the reading fix.
- **A remote voice accidentally chosen.** Automatic prefers a local voice; a
  machine with only remote voices can still fall back to the platform's list,
  and a saved remote voice is still honoured. A matching remote voice is never
  chosen over a local one.
- **`utterance.lang` on a platform that ignores it.** Harmless; `voice` is still
  set when a match exists, which is the mechanism that already works.
- **Rollback:** revert the branch. There is no data migration, no new setting
  and no schema change; an older build ignores the extra `lang` on the
  utterance.

## Tests and validation

- `npm run read-aloud:unit` — **99/99**. The exact host voice list
  (`""`/`auto` → David, `pt-BR`/`pt`/`pt-PT` → a `pt-BR` voice), the saved-voice
  rule, local-over-remote, normalized tags, the English/Portuguese detector,
  declared metadata in all four markups, the dictionary vote's confidence,
  failure and timeout behaviour, the resolver's precedence, and a fake
  `speechSynthesis` proving `utterance.lang` and `utterance.voice`.
- `npm run read-aloud` — **49/49**, run three times on a fresh instance. The five
  new checks open `samples/word-sync.md`, start from the beginning and require
  the chip title to name `Microsoft Daniel - Portuguese (Brazil)` (or Maria) when
  a `pt` voice exists; a machine with none reports a visible skip. The suite now
  waits for the first preview render before opening the menu.
- `npm test -- --only spellcheck,smoke --no-build` — **3/3** and **114/114**;
  the shared word-list move did not change underlines, and the Preferences
  section labels are untouched.
- `npm run build` — typecheck and bundle, pass.
- `npm run lint` — pass.
- `npx prettier --check` on the touched sources — pass. The repository-wide
  `npm run format:check` still names `scripts/ai-live-test.mjs`, a pre-existing
  file this change does not touch.
- `npm run test:rust` is not required (no Rust change). The direct-PDF and
  pandoc layers are unrelated.
- The UI layer ran through `npm test -- --only read-aloud`, which stages the
  binary, backs up and restores the real profile and uses a disposable settings
  directory. A separate build with identifier `io.github.bernh.mdraft.langtest`
  was used for the measurements below and then deleted; the user's profile was
  never opened by it.

Measured on this host, in that isolated build:

- `C:\Users\bernh\Documents\backlog.md` → `Microsoft Daniel - Portuguese (Brazil)`.
- `T:\proofreader.md` → `Microsoft Daniel - Portuguese (Brazil)`.
- `samples/feature-tour.md` → `Microsoft David - English (United States)`.
- A 28-word Portuguese note, below the 40-word pure detector, → Daniel through
  the installed `en`/`pt-BR` dictionary vote.
- A short English note declaring `lang: pt-BR` in front matter → Daniel, so the
  declaration beats the text.

## Deviations

- **The precedence resolver lives in `src/language.ts`.** `main.ts` supplies the
  live buffer, markup, pinned setting, dictionary tags and checker to
  `resolveDocumentLanguage`; keeping the decision out of the shell lets
  `read-aloud-unit.mjs` prove declaration > detection > pinned > vote without an
  application.
- **`createReadAloud` reads the voice list synchronously again.** The UI suite
  exposed the gap between `getVoices()` filling and `voiceschanged` reaching the
  app: the menu was disabled with "Looking for installed voices…" while the
  browser listed five. `availableReason`, `voices` and `start` now call
  `syncVoices`, so the command enables as soon as the platform answers. This is
  user-facing, not test timing.
- **Automatic selection prefers a local voice but does not refuse a machine
  with only remote voices.** A matching local voice always wins; a machine with
  no local voice at all still gets an automatic choice. The host's five local
  voices make the result unchanged.
- **The UI suite gained five checks, not one**, for 49 total: fixture open,
  command, start, voice, and return to the Markdown fixture. It also waits for
  the first preview render; a cold start could otherwise reach the menu while the
  pane was empty and report "There is nothing to read."
- **The unit suite grew from 59 to 99 checks**, including the resolver
  precedence and the exact host voice list.
- **`src/main.ts` keeps the old `languageTag` callback** as the fallback for a
  caller that passes no explicit tag; the shell always passes the resolved one.
- **The repository-wide format gate is red on `scripts/ai-live-test.mjs`**, a
  pre-existing file outside this change. The touched files pass
  `prettier --check`.

## Acceptance criteria

- A Portuguese document read with Automatic uses an installed Portuguese voice,
  and the chip names that voice.
- An English document keeps the platform default (David here).
- A document that declares `lang: pt-BR`, `:lang: pt-BR` or
  `#set text(lang: "pt-BR")` selects a Portuguese voice even when it is too
  short to detect.
- A clearly Portuguese document is read in Portuguese when the Dictionary is
  pinned to English; the pin is a fallback, not a veto.
- A saved voice still beats every automatic rule, and an uninstalled saved voice
  falls back to the document's language.
- Stop, a tab switch or a second Read Aloud while the probe is running starts
  nothing afterwards.
- Spelling underlines, the Preferences section and the menu inventory are
  unchanged.
- No new dependency, no settings-schema change, no network request and no
  cloud voice.

## Open questions

- Should a pinned Dictionary override text detection? Recommended: no; the
  document's own text is better evidence for how to read it, and the pin is
  labelled Dictionary. If the reviewer prefers the setting first, swap steps 3
  and 4 and update the help text.
- Should a toast warn when no voice matches the resolved language (for example
  “No voice for French is installed; reading with David”)? Recommended: not in
  this change; the chip already names the voice and Preferences explains how to
  install one. It is a small follow-up if readers ask.
- Should the dictionary vote run for very long documents? Recommended: yes, but
  on the first ~600 words; the language does not change at the end of a book.
- Should the detected language be displayed in the chip? Recommended: no; the
  voice name includes its language on Windows and the Preferences picker shows
  it everywhere.
