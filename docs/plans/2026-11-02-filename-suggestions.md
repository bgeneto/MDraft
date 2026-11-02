# Filename suggestions for unsaved documents

**Status:** done
**Date:** 2026-11-02
**ADR:** none — the existing AI transport ADR (`docs/adr/2026-10-28-ai-assistant-transport.md`) still governs where a request lives; this plan adds one command, not a new transport.

## Context and goal

Saving a document for the first time opens the native Save dialog with
`untitled.<ext>` (`choosePath` in `src/main.ts`, lines 209–228). The extension is
already correct — `suggestSave` in `src/paste/detect-document.ts` detects whether
the buffer is Markdown, Typst, HTML or AsciiDoc — but the name is generic, so the
reader renames every new note by hand.

Every program that creates untitled documents solves this the same way:

- Microsoft Word, Apple Pages and Google Docs derive the name from the document's
  first line.
- Obsidian, Typora and Notion prefer the document's first heading, falling back
  to the first line.
- Editors that keep `Untitled 1` (LibreOffice, VS Code untitled editors) are the
  ones users complain about.

The requested examples are exactly the two shapes this has to handle:

- a leading H1: `# A Grande Mudança que se Aproxima nas Relações entre os Estados
  Unidos e a China na Era da Inteligência Artificial` (113 characters) →
  `A Grande Mudança que se Aproxima nas Relações entre os Estados Unidos e a China na Era da Inteligência Artificial.md`;
- a plain first paragraph: `Par de caixas torre Monitor Audio Silver 300 7G, no
  acabamento Natural Walnut.` (78 characters) →
  `Par de caixas torre Monitor Audio Silver 300 7G, no acabamento Natural Walnut.md`.

The goal is a Save dialog that opens with a readable, legal, format-correct name,
computed instantly and offline. An optional AI-assisted name is layered on top
for documents with no title, behind the existing assistant and a new explicit
setting, because it adds a network round-trip before the dialog can open.

The application's promise is unchanged in its default state: no new network
request, no new dependency, and nothing is sent anywhere unless the reader has
enabled the AI Assistant *and* enabled filename suggestions.

## Scope and non-scope

**In scope**

- Deterministic name derivation for an unsaved buffer, in all four markups:
  explicit title metadata, first heading, first prose line, then `untitled`.
- Inline-markup removal, HTML entity decoding and filename sanitisation
  (Windows-invalid characters, trailing dots/spaces, reserved device names,
  length caps by code point and UTF-8 byte).
- The name applies to Save and Save As of an untitled document, including the
  close-and-save path, which goes through the same `choosePath` callback.
- An opt-in setting in Preferences › AI Assistant, a new Rust command
  `ai_suggest_filename`, a timeout and a silent fallback.
- Documentation, privacy text and tests.

**Out of scope**

- Renaming the tab or window title while the document is still untitled. It keeps
  `Untitled 1` until the first save, as Word keeps `Document1`.
- Save As on an already saved document: it keeps starting from its own path.
- Export file names. They already derive from the saved stem in
  `documentStem`/`exportSuggestion`.
- Checking whether the target file already exists and appending ` (2)`. The
  native overwrite confirmation is the platform's contract, and a silent rename
  surprises the reader.
- Background/prefetch AI naming while typing. That would contact the endpoint
  without a user action and break the "no network except on an action" rule.
- A preference for the length cap. It is a single constant with a rationale.
- Translating the title. The name stays in the document's own language.

## Approach and rejected alternatives

### Deterministic name (always on, synchronous)

A new pure module `src/filename.ts` derives the stem. Its input is the buffer
text, the detected `DocumentLanguage` and the extension; its output is a stem,
never a path. `choosePath` joins it with `settings.lastDirectory` exactly as it
joins `untitled` today.

**1. Candidate extraction, in priority order.**

| Priority | Source | Rule |
| --- | --- | --- |
| 1 | Explicit metadata | Markdown YAML front matter `title:`; AsciiDoc `:title:`; Typst `#set document(title: "…")`; HTML `<title>` |
| 2 | First heading | Markdown `# …` (ATX) or a setext `===`/`---` underline; AsciiDoc `= …`; Typst `= …`; HTML `<h1>` — only within the first 120 non-empty lines, so a heading three pages in is not mistaken for the document title |
| 3 | First prose line | the first non-empty line in the same window that yields text after markup removal and is not a directive, fence, table row, comment, attribute line or an image/link definition only |
| 4 | Fallback | `untitled` |

Skipped line kinds, per markup:

- Markdown: `---`/`***`/`___` rules, fenced-code delimiters, `[TOC]`, `<!--`
  comments, `|` table rows, `[id]: url` reference definitions, `[^1]:` footnote
  definitions, image-only lines, bare URLs.
- AsciiDoc: `:attr:` lines, `//` comments, block attribute lines (`[…]`),
  `----`/`....`/`====` delimiters, `image::`, `include::`, `ifdef::`, `ifndef::`,
  `toc::`.
- Typst: `//` comments, `#set`, `#show`, `#import`, `#include`, `#let` lines;
  a `#text(…)[…]`/`#align(…)[…]` line still contributes its bracketed text, after
  removing the command and the brackets.
- HTML: doctype, `<html>`, `<head>`, `<meta>`, `<link>`, `<script>`, `<style>`,
  comments and an opening `<body>` tag.

**2. Inline cleanup.** Markdown links keep their text and images keep their alt
text; `**`, `*`, `_`, `` ` ``, `~~` are removed; HTML tags are dropped and the
five common entities (`&amp; &lt; &gt; &quot; &#39;`) plus numeric entities are
decoded. AsciiDoc `link:url[text]`, `image:src[alt]`, `<<id,text>>` and `{attr}`
are reduced to their readable part. Typst `*…*`, `_…_`, `` `…` ``, `$…$` and
`#command(…)[text]` are reduced the same way. A line with no letter or digit
after cleanup is skipped.

**3. Sanitisation.** One function, used for the deterministic name and for the AI
answer, so the two can never drift:

- control characters `U+0000`–`U+001F`, `U+007F` and zero-width
  `U+200B`–`U+200D`/`U+FEFF` become spaces;
- `< > : " / \ | ? *` become spaces (not deletions, so `A/B` reads `A B`, not
  `AB`);
- whitespace collapses to single spaces; surrounding whitespace and *trailing*
  dots are removed (Windows refuses a trailing dot or space). A leading dot is
  kept so a title such as `.NET 9` survives; a resulting hidden file is legal and
  visible in the dialog.
- trailing sentence punctuation `.,;:!?…` is removed, along with a wrapping pair
  of straight or curly quotes;
- a result without a letter or digit becomes `untitled`;
- Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`,
  `LPT1`–`LPT9`, with or without an extension) become `untitled`;
- the stem is capped at **120 code points and 180 UTF-8 bytes**, cut at the last
  word boundary at or before the cap, then stripped of trailing punctuation and
  hyphen. 120 covers the 113-character Portuguese example intact, while 180 bytes
  keeps CJK names inside NTFS's 255-unit and ext4/APFS's 255-byte component
  limits. Iteration is by code point, never by UTF-16 index, so an emoji or an
  astral character is never split.

The extension is appended last (`withExtension(stem, ext)`); no sanitisation runs
on it.

**4. AI answer cleaning.** `cleanAiSuggestion(raw, extension)` takes the first
non-empty line, strips code fences, XML-ish wrappers, a leading label
(`File name:`, `Filename:`, `Title:`, `Nome:`, `Nombre:`, `Dateiname:`), wrapping
quotes/backticks, and a trailing known document extension, then runs the same
sanitiser. If the result is empty or `untitled`, the deterministic stem wins.

### Optional AI name (opt-in)

- **Setting**: `aiSuggestFilename` (camelCase in `settings.json`), default
  `false`, additive with `#[serde(default)]`, so every existing file loads.
- **Preferences**: a checkbox "Suggest file names when saving" directly after
  "Enable AI Assistant", disabled while the assistant is off. Its help text says
  that it sends the document's opening to the endpoint before the Save dialog,
  that a slow or failed request falls back to the first line, and that the
  existing title always wins. The Privacy note gains the same sentence.
- **When it is consulted**: assistant enabled, a model is set, the option is on,
  the document is untitled, the buffer is not empty, and the deterministic
  candidate did **not** come from explicit metadata or a heading. An author's own
  title is authoritative; spending a request to rename it is waste and risk.
- **Command**: `ai_suggest_filename(id, text)` in the new
  `src-tauri/src/ai/naming.rs`, registered in `lib.rs` and wrapped in `api.ts`.
  It resolves the provider, base URL, model and key exactly as `ai_complete`
  does; it clones the settings, refuses when either toggle is off, takes the
  first 512 tokens of the opening through `take_first_tokens`, streams a
  one-message prompt through the existing `provider::stream` (so OpenAI and
  Anthropic keep their tested paths), registers its cancellation sender in
  `state.ai.running` under `id`, has a **5-second total timeout** and returns the
  raw answer capped at 400 characters. It returns text only: the Rust side never
  decides what a legal filename is.
- **Prompt**: one line of system text: answer with one file name stem only, no
  quotes, extension, label or explanation; use the document's language; at most
  12 words and 90 characters; never use `< > : " / \ | ? *`; prefer a title over
  a description.
- **Frontend**: `choosePath` calls the command before `saveDialog`, with its own
  **4-second** cap. The cap is a `Promise.race`, not only `aiCancel(id)`:
  cancellation is observed while the response streams, but a connection that has
  not answered yet cannot see the channel, and the dialog must not wait on it.
  `aiCancel(id)` still runs so the backend stops; its own 5-second timeout is the
  backstop. Failures and timeouts fall
  back silently to the deterministic stem; the dialog is never blocked beyond
  the cap. A toast "Asking the assistant for a file name…" appears only if the
  request is still running after 300 ms and is dismissed before the dialog opens.
- **Cache**: the cleaned AI stem is remembered per `session.id` and
  `session.revision`, so cancelling the dialog and saving again does not re-ask.
  Editing the document changes the revision and discards it.
- **Failure behaviour**: silent. The deterministic name is always ready, and the
  AI panel already reports an unreachable endpoint when the reader uses it.

### Rejected alternatives

- **AI-only naming** — nondeterministic, unusable offline, and every empty or
  broken endpoint would leave the reader with a delay and a bad name.
- **Prefetch while typing, then use the cached name at Save** — would contact the
  endpoint without a user action, contrary to the README's network promise, and
  spend tokens on documents that are never saved.
- **Open the dialog with `untitled` and rename afterwards** — a native Save
  dialog cannot be updated from the webview; the only name it ever sees is the
  one passed to `saveDialog`.
- **Reuse `ai_complete` with a hidden action** — it would enter the palette
  catalog, the tag filter, History and the apply modes, none of which apply, and
  the action-catalog contract tests would have to special-case it.
- **Slugify (spaces to hyphens, lowercase)** — enterprise editors keep the
  author's capitalisation and spacing; a filename is read, not fetched.
- **Deduplicate against existing files with ` (2)`** — that is the overwrite
  prompt's job; silently changing a name the reader just saw is worse.
- **A setting for the 120-character cap** — one more preference for a rule with
  a filesystem reason; 120 is a constant with a test.

## Steps

- [x] Create `src/filename.ts`: candidate extraction per markup, inline cleanup,
  `sanitizeFileStem`, `suggestFileStem`, `withExtension`, `cleanAiSuggestion`,
  `plainExcerpt`. No DOM, no runtime imports beyond `type DocumentLanguage`, so
  Node can load it directly.
- [x] Create `scripts/filename-unit.mjs` and the `filename:unit` npm script:
  title sources, skip rules, sanitisation, limits, reserved names, AI cleanup.
- [x] Register the suite in `scripts/test-all.mjs` near the other app-free unit
  layers.
- [x] Wire the deterministic stem into the `choosePath` callback in
  `src/main.ts`: only when `suggested`, `conflictCopyPath` and `session.path` are
  all absent, use `suggestFileStem(...)` + the extension from `suggestSave`, then
  join `settings.lastDirectory` as today. Leave saved-file Save As untouched.
- [x] Add settings support: `ai_suggest_filename: bool` in
  `src-tauri/src/settings.rs` (struct, `Default`, serde default) and
  `aiSuggestFilename` in the `api.Settings` interface.
- [x] Add the Preferences row and checkbox `disabled` support; update the Privacy
  note. Confirm the panel rerenders when "Enable AI Assistant" changes.
- [x] Add `src-tauri/src/ai/naming.rs`: the prompt, the 512-token excerpt, the
  settings gate, the 5-second timeout, the cancellation entry and unit tests for
  the pure helpers (first line, labels, quotes, extension, cap, empty answer).
- [x] Wire the module into `src-tauri/src/ai/mod.rs` and the command into
  `src-tauri/src/lib.rs`; add `aiSuggestFilename` to `src/api.ts`.
- [x] Add the frontend AI path in `choosePath`: gating, excerpt, 4-second cap,
  cancel, latency toast, revision-keyed cache, silent fallback.
- [x] Extend `scripts/p0-lifecycle-test.mjs` with the deterministic dialog checks
  (heading, plain line, saved-file Save As unchanged).
- [x] Extend `scripts/ai-assistant-test.mjs`: a mock branch for the filename
  prompt, a save-dialog stub, option-off makes no request, option-on uses the
  cleaned answer, invalid characters are repaired, failure falls back.
- [x] Update `README.md` (the AI bullet and "Quiet by design") and `AGENTS.md`
  (network rule, repository scripts, testing table, every quoted count).
- [x] Run the validation set below and correct the documented counts.

### Deviations recorded during implementation

- **Only trailing dots are stripped.** A leading dot is legal on every platform
  and is the first character of a real title such as `.NET 9`; removing it would
  turn a name into a different word. The plan said "leading and trailing".
- **Typst `#set`/`#show`/`#import`/`#include`/`#let` lines are structural.** They
  are statements whose arguments follow a space, not `#command(...)` calls, so
  the inline cleaner alone left `#set page(paper: "a4")` looking like prose. The
  first implementation did exactly that and the unit suite caught it.
- **The Rust answer cleaner also drops a label-only first line.** The frontend's
  colon rule could never see the second line once Rust had returned only the
  first, so a model that answers "File name:" then the name would have produced a
  fallback. Rust now takes the next non-empty line in that one case.
- **The AI answer cleaner strips wrapping emphasis.** A model may answer
  `**A Name**`; `*` is a legal filename character, so without this the dialog
  would have shown asterisks.
- **The frontend cap is a race, not only cancellation.** A request stuck before
  the first chunk cannot observe the cancellation channel; the dialog therefore
  waits on `Promise.race` and still asks the backend to stop.
- **New test counts.** 76 filename unit checks, 39 P0 lifecycle checks (35 + 4),
  266 AI-mock checks (255 + 11), and 246 Windows / 245 Linux Rust tests (241 + 5).

## Files and modules

| File | Why |
| --- | --- |
| `src/filename.ts` (new) | The single source of the naming rules; pure and app-free |
| `src/main.ts` | `choosePath` calls the deterministic builder and the optional AI path; the cache and toast live here |
| `src/api.ts` | `aiSuggestFilename` wrapper and the `aiSuggestFilename` settings field |
| `src/preferences.ts` | The AI section row, its help text and the Privacy note; checkbox `disabled` support |
| `src-tauri/src/settings.rs` | The new persisted field and its default |
| `src-tauri/src/ai/naming.rs` (new) | The command, prompt, timeout, cancel registration and unit tests |
| `src-tauri/src/ai/mod.rs` | `pub mod naming;` |
| `src-tauri/src/lib.rs` | Register `ai::naming::ai_suggest_filename` |
| `scripts/filename-unit.mjs` (new) | Unit coverage for extraction, sanitisation and AI cleanup |
| `scripts/p0-lifecycle-test.mjs` | The real Save/Save As route pre-fills the right `defaultPath` |
| `scripts/ai-assistant-test.mjs` | The mock endpoint, the opt-in gate and the fallback |
| `package.json`, `scripts/test-all.mjs` | The new layer |
| `README.md`, `AGENTS.md` | Network promise, scripts, testing table, counts |
| `docs/plans/2026-11-02-filename-suggestions.md` | This record |

No new npm, cargo or bundled-font dependency. `settings.json` stays backward
compatible; removing the field later is also safe because serde ignores unknown
keys.

## Risks and rollback

- **A suggested name collides with an existing file.** The native overwrite
  confirmation still runs; nothing is written before the reader answers. No
  deduplication is added, by design.
- **Path length.** The 120-code-point/180-byte cap keeps the component legal; a
  deeply nested `lastDirectory` could still approach `MAX_PATH`, which the
  dialog's own error reports. The cap is the mitigation.
- **Privacy.** With the option on, the document's opening leaves the machine on
  Save. It is off by default, disabled while the assistant is off, stated in the
  Privacy note, the row help and the README.
- **Delay.** At most 4 seconds, only on the first save of an untitled document
  with no title, only when opted in. The dialog's name is usable without it.
- **Endpoint errors.** Silent fallback; the reader still gets a good name and is
  never blocked by an unreachable server.
- **Prompt drift.** Rust returns raw text and TypeScript owns sanitisation, so a
  model that ignores the prompt cannot produce an illegal filename.
- **Cache staleness.** Keyed by session id and revision; an edit discards it.
- **Rollback.** Revert `choosePath` to `untitled.<ext>`; the setting and command
  can stay dormant, or be removed. Existing settings files need no migration.

## Tests and validation

| Layer | Command | What it proves |
| --- | --- | --- |
| New unit suite | `npm run filename:unit` | All extraction rules, sanitisation, limits, reserved names, AI cleanup — no application |
| Typecheck/build | `npm run build` | The new module and settings field compile; no unused imports |
| Rust | `npm run test:rust` | The command's pure helpers and the settings default; the new tests are reflected in the documented counts |
| Lifecycle | `npm run p0:lifecycle` | The real Save route passes the derived `defaultPath` to the dialog; saved-file Save As keeps its name |
| AI mock | `npm run ai` | With the option off no filename request is made; with it on the request is shaped correctly and its answer becomes the default path; a malformed answer is repaired; a failure falls back |
| Style | `npm run format:check`, `npm run lint` | House style |

Run on 2026-11-02 against a release build: `filename:unit` 76/76,
`p0:lifecycle` 39/39, `ai` 266/266, `cargo test` 246 passed with 2 ignored,
`format:check` and `lint` clean. The AI run used a disposable build with its own
identifier because an installed MDraft was open; its appdata and WebView2 profile
were removed afterwards, and the ordinary binary was rebuilt and restaged.

The one manual measurement is the dialog itself, because the name is native and
invisible to the DOM: save a new Markdown tab containing the Portuguese heading
and confirm the field shows the 113-character stem with its accents, then repeat
with the product paragraph and with a title containing `:` and `/`. Also open
Preferences and confirm the row is disabled with the assistant off and its help
text names the network request.

## Acceptance criteria

1. A new Markdown tab whose first line is
   `# A Grande Mudança que se Aproxima nas Relações entre os Estados Unidos e a China na Era da Inteligência Artificial`
   opens Save with
   `A Grande Mudança que se Aproxima nas Relações entre os Estados Unidos e a China na Era da Inteligência Artificial.md`
   in the File name field, `.md` included and the rest of the name selected as
   today.
2. A new tab beginning `Par de caixas torre Monitor Audio Silver 300 7G, no
   acabamento Natural Walnut.` opens Save with the sentence minus its final
   period, with `.md` appended.
3. AsciiDoc `= Title`, Typst `= Title` / `#set document(title: "…")` and HTML
   `<title>` all pre-fill the title, with the language's own extension.
4. A name never contains `< > : " / \ | ? *`, never ends in a dot or space, is
   never a Windows reserved device name, and is at most 120 code points and 180
   UTF-8 bytes, cut at a word boundary.
5. An empty or directive-only document still pre-fills `untitled.<ext>`.
6. Save As on a saved document still starts from its own path and name.
7. With the AI Assistant off (the default), saving an untitled document makes no
   network request and opens the dialog immediately.
8. With the option on, a document that has a heading still opens instantly with
   the heading and sends no request; a heading-less document asks the endpoint
   once, and its answer (after cleaning) becomes the name.
9. A timeout, 401 or malformed answer falls back to the deterministic name
   within about four seconds and the dialog still opens.
10. An existing `settings.json` loads unchanged, and the new option defaults to
    off.

## Open questions

Resolved by the approval on 2026-11-02: the defaults below were accepted (120
characters, skip the AI when a heading exists, a 4-second wait, silent fallback,
no deduplication).

1. **Cap.** 120 code points / 180 bytes keeps the Portuguese example whole.
   Default: keep 120; an 80-character cap would truncate it.
2. **AI versus a real heading.** Default: skip the request when an explicit title
   or heading exists. If the reader wants the model to override their own
   heading, that is a second setting, not a default.
3. **AI wait.** Default: 4 seconds at the frontend, 5 seconds in Rust. A local
   model that is still loading will fall back to the first line.
4. **Reporting failures.** Default: silent fallback, documented in the row help.
   A toast on every unreachable endpoint would interrupt the Save it is trying to
   help.
5. **Deduplication.** Default: rely on the dialog's overwrite confirmation. Say
   so if a ` (2)` suffix is preferred.
6. **Date-only first lines.** Default: not special-cased; `Nov. 2, 2026` alone
   would become a name, but a document with a heading never reaches that rule.
