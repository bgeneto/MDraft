# AI, accessibility and typography traps

The AI Assistant, Read Aloud and speech backends, and the bundled typefaces with their subsetting pipeline.

Part of [the trap record](../traps.md). Search across every domain with:

```powershell
rg -n "<literal error text>" docs/agent-guide/traps
```

**The prompts note still said "Using the built-in prompts" after a custom section had been saved**
`renderContent` refreshed the prompt file's status only when `ai.prompts === null`, so the panel kept the first answer for its whole life and reopening Preferences showed what the file held then; saving the file in its own tab does not touch the panel. Invalidate the cached answer in `open()`, not on every section render — an unconditional refetch there loops, because the fetch itself re-renders. The suite reported it as `the note counts the customised prompt (null)`, which names neither the panel nor the cache.

**Read Aloud says “No voice is installed” while `spd-say "Hello"` speaks**
Ubuntu's WebKitGTK 2.52.6 is built without the Web Speech synthesis backend, so
`'speechSynthesis' in window` is `false` even with speech-dispatcher and
espeak-ng installed; a minimal GTK/WebKit probe returned
`{"has":false,"n":-1}`. The app now uses speech-dispatcher through `spd-say` on
Linux (`src-tauri/src/speech.rs`). Do not tell the reader to install more
packages when `spd-say` already works, and do not try to make `getVoices()`
non-empty through Preferences: the API is absent, not empty.

**`The system credential store refused the key.` on a fresh Ubuntu session although gnome-keyring is running**
`keyring` 4.2's Secret Service store writes to the default collection. With no
default collection, `create_item("default")` catches the no-entry error, then
`create_collection("default")` calls `get_default_collection()` again and fails
the same way; it never creates one. `secret::keychain_available()` only proves
the D-Bus service initialized, not that a write can succeed. The fallback is
`ai-keys.json` beside `settings.json`, mode `0600`, separate from settings and
backups; the UI says it is not encrypted. Do not delete the file fallback to
keep a “keychain only” rule; that rule is the reported data loss.

**`document.fonts.check()` is false for a font that exists**
Web fonts load lazily. `check()` reports whether a face is *active*, not whether
it is declared. `await document.fonts.load('1em KaTeX_AMS')` first, then check.

**A font file is "missing" from `dist/`**
Vite inlines assets under 4 KB as data URIs and renames the rest with a content
hash. `KaTeX_Size3` is inlined; the other nineteen are hashed. Compare by base
name after stripping the hash, and verify an inlined font by decoding it and
comparing digests.

**A monospaced font makes width useless as a measurement**
Testing that a typography feature works by comparing text widths works for
proportional faces and silently fails for monospaced ones. Every glyph in a
monospace face has the same advance by definition, and a programming ligature
draws one glyph across two cells — so `->` measures identically whether or not it
is an arrow. `slashed-zero` likewise changes the glyph, never the width.
`canvas.measureText` is no better: `ctx.font` accepts only
style/variant/weight/size/family, so `font-variant-numeric` and
`font-variant-ligatures` are dropped without complaint and every comparison comes
back identical. `scripts/typography-test.mjs` therefore screenshots each sample
with the feature off and on and compares pixels; a feature that changes nothing
on screen fails there.

**`font-weight: 600` silently renders as Bold**
`font-weight: var(--weight-strong)` with 600 looks correct in the stylesheet and
computes to `600`, yet draws the 700 face: when a family declares only 400 and
700, CSS's weight-matching serves the nearest heavier face rather than
synthesising a lighter one. The rule works only if a Semibold face exists and is
declared. Source Serif 4 and Inter carry 600 on a variable axis; Source Sans 3 is
static, so `SourceSans3-Semibold.woff2` and its italic are bundled and listed in
`fonts.json`. Verify with `document.fonts` (`weight === "600"`) and by comparing
600 against 700 pixels — not by reading the computed style, which is 600 either
way.

**A test suite that replaces the document breaks the next suite, not itself**
The licence check opens a built-in document, which is correct behaviour — the
application asks before discarding — but it left the window holding the licence
text. `syntax` then failed three assertions about token colours that had nothing
to do with licences, and it passed in isolation. Attempts to restore the fixture
from inside the check (clicking a Recent entry, polling for the title) were
fragile enough to fail twice more. The licence checks live in their own suite
now. **Run each suite against its own freshly launched instance**; do not batch
them against one window unless they have been shown to compose.

**A face in a stack is not a face that will render**
Two separate traps. In an exported document, a family named by name gets a silent
system fallback, because a browser reading a temporary file cannot reach the
application's assets — so exports must embed the faces as data URLs. And in an
embedding pass, only the *first* bundled family in a stack can ever be used: the
default heading stack is `"Source Sans 3", Inter, …`, and embedding Inter as well
added nearly a megabyte per export for a face that could not render. Both are
guarded in `scripts/export-test.mjs`.

**`You cannot call a method on a null-valued expression` after downloading `EBGaramond[wght].ttf`**
The path contains `[wght]`, which PowerShell treats as a wildcard character
class. `Test-Path`, `Get-Item` and `Get-FileHash` then find nothing, `Get-FileHash`
returns `$null`, and `.Hash.ToLower()` throws. Use `-LiteralPath` (and
`Test-Path -LiteralPath`) for every font file whose name comes from Google
Fonts; the download itself succeeds, which is what makes the error misleading.

**A font subset from `fonts.googleapis.com` renders, but the OpenType switches do nothing**
Google's CSS woff2 files are already subset, and their subsetter strips layout
features the panel depends on: measured, the EB Garamond Latin file has no
`onum`, IBM Plex Mono's has no `zero`, and Google's static Recursive has no
`calt`/`liga`. The family loads, so the failure looks like a CSS bug. Download
the pinned upstream TTF and run `scripts/subset-fonts.py` with the feature list;
verify the cmap and features before committing.

**`required feature(s) missing after subset: onum` (or `tnum`/`zero`) for a font that has the feature**
`fontTools.subset` keeps a GSUB feature only when the glyphs its lookups consume
survive. EB Garamond's `tnum` maps the `.lf` alternates back to the default
figures; if `pnum`/`lnum` are not kept, those inputs are dropped and the feature
disappears with them. Per-family `layoutFeatures` in `scripts/font-sources.json`
are the fix. Require only the features a preset turns on, and do not require one
whose default already renders the desired shape: EB Garamond's figures are
tabular and Alegreya's are oldstyle by default, and Jost's `tnum` is a fullwidth
set, so Bauhaus leaves tabular figures off.

**Subsetting an OFL font whose licence declares a Reserved Font Name**
Not a build error: the file works, but the OFL forbids distributing a modified
version under the reserved name. IBM Plex ("Plex"), Lora ("Lora") and the Source
fonts ("Source") all declare one. Bundle the official woff2 unmodified, or
rename the subset. This repository keeps IBM Plex whole and uses Alegreya
instead of Lora.

**The first AI request panics the tokio worker with `No rustls crypto provider is configured`, and the panel sits on "Contacting the model…" forever**
`reqwest` is built with `rustls-no-provider` (see the dependency comment in `Cargo.toml`), and that feature deliberately installs nothing: `Client::builder().build()` panics unless a provider is already the process default. The panic kills the async task before any event is sent, so the frontend has no error to show. Install `rustls::crypto::ring::default_provider()` once (`install_crypto_provider` in `src-tauri/src/ai/provider.rs`) before the first AI client. The equivalent message names `aws_lc_rs`; do not "fix" it by enabling reqwest's default `rustls` feature, which re-enables aws-lc-rs and clashes with the ring provider `ureq` already brings.

**The AI palette measures 857 px although its placement code computes a 520 px cap**
The function set `maxHeight` from the cap, measured `offsetHeight`, and then a leftover second assignment at the end overwrote it with `pane height - 16`. The later assignment won, so the cap existed in the source and in the test description but not on screen. Search the function for every `style.maxHeight` assignment, not just the one you added; the same class of bug applies to any computed size whose measurement comes before a later unconditional write.

**A live-model answer is flagged as a leaked tag because it legitimately contains `<table>`**
The live suite checked the answer against every output tag in the catalog. A Markdown continuation that writes an HTML `<table>` example, or a prose sentence about a `<summary>`, is then reported as a filter failure even though the action's own `<continuation>` tag was stripped correctly. Check the expected action's tag (plus `<notes>` for Improve), not the whole catalog, or the test punishes the model for writing valid content.

**`The endpoint did not return a model list as JSON` although the same `/models` URL is valid JSON in a browser**
The gateway answers `Content-Encoding: gzip` when the request advertises `Accept-Encoding`; the reqwest build had `rustls-no-provider` and `json` but not `gzip`, `brotli` or `deflate`, so `.json()` parsed compressed bytes. Enable those features. Reproduce the compression with `curl -H 'Accept-Encoding: gzip, br, deflate'`: the headers gain `content-encoding: gzip` and the body starts `1F 8B`, while a request without the header is plain JSON. The same message also appeared for a **200 with an empty body** from the wrong Base URL (`llm.sistema.pro.br/v1`), so `list_models` now names an empty body or HTML page and the Base URL instead of only saying "not JSON".

**`Fetch model list` used the previous Base URL after a new one was typed**
The Preferences text row committed on `change` (blur/Enter), and the fetch read `settings.aiBaseUrl` instead of the field. Pressing Fetch while the field still had focus sent the old endpoint — in this report `llm.sistema.pro.br/v1`, whose `/models` was an empty 200, while the field showed the test endpoint. Read the controls and persist them before the request; set `rerender: false` on the Base URL and Model rows so the blur does not replace the button being clicked.

**`speechSynthesis.getVoices()` is empty on the first call, and `speak()` without sticky user activation reports `not-allowed`**
Measured in the release build inside WebView2: the first `getVoices()` returned 0, and three voices (David, Mark, Zira) appeared only after `voiceschanged`, so an utterance built in the same task as the first read has no voice to choose. Chromium's `SpeechSynthesis::IsAllowedToStartByAutoplay` asks `AutoplayPolicy::IsDocumentAllowedToPlay`, which is *sticky* activation: a `MouseEvent` dispatched from `Runtime.evaluate`, or `element.click()`, does not grant it, while one real `Input.dispatchMouseEvent` press does — `scripts/read-aloud-test.mjs` starts with that press for this reason, and `src/read-aloud.ts` re-reads the list after the event instead of believing the first answer. The Windows catalogue is only the SAPI/OneCore tokens enumerated by `content/browser/speech/tts_win.cc`; Edge's 321 "Online (Natural)" voices are all `localService: false` and are not offered to an embedder, so no local implementation can sound like Edge's Read Aloud.

**“The fetched model list appears empty although the status says 45 models found”**
The AI Model field was an `<input list>` backed by a `<datalist>`, and Chromium filters datalist options by the field's current value. A model id saved for the previous endpoint matched none of the new ids, so clicking the arrow opened an empty popup while the fetch had worked. A datalist cannot show all options while the input holds a non-matching value. The field is a custom combobox now (`src/combo.ts`, called through `src/model-combo.ts`): it opens the whole fetched list and filters only while the reader types. `loadModels` reconciles the saved id only when a successful fetch returned a non-empty list that does not contain it, and leaves a hand-typed id alone on a failure or an empty answer. Do not restore a datalist for a catalogue that changes with the endpoint.

**A Portuguese document is read aloud with the English default voice although Daniel and Maria are installed**
`src/main.ts` passed `""` as the language tag whenever `spellcheckLanguage` was the default `"auto"`, so `chooseVoice` skipped its language branch and returned the platform default (David) even though WebView2 listed Daniel and Maria at `pt-BR`. The spelling detector lived inside a CodeMirror `ViewPlugin`, Read Aloud never asked it, `lang:` in the document was ignored and `SpeechSynthesisUtterance.lang` was never set. Reproduce without audio: start Read Aloud and read the `title` of `#status-reading`, which names the chosen voice. Passing `pt-BR` to `chooseVoice` with the same list selected Daniel, which separated a missing tag from a broken match. The language now comes from a declared `lang`, the spoken text, the pinned Dictionary, the installed dictionaries and finally the platform default (`src/language.ts`), and the chosen voice's language goes on the utterance.

**Read Aloud is disabled with "Looking for installed voices…" although `speechSynthesis.getVoices()` already lists five**
`createReadAloud` believed only `voiceschanged`; `getVoices()` can fill between the boot read and the event, and a menu opened in that gap saw `loaded: false`. `availableReason`, `voices` and `start` now read the platform list synchronously (`syncVoices`) as well, so the command enables as soon as the platform answers. The read-aloud suite failed its first nine checks on this, not on the menu or the synthesiser.

**An HTML table answer from the AI Assistant ends at its first `</table>`**
The Convert to table action asked for `<table>…</table>` as its wrapper tag, and `<table>` is also a real HTML element. In an HTML document the stream filter found the model's inner `</table>` as the wrapper's close, emitted only the `<thead>` fragment and discarded the rest. `<summary>` had the same problem. The wrappers are namespaced now (`<mdraft-table>`, `<mdraft-summary>`, …): a wrapper must never share a name with an element the document itself can contain, and a test feeds an HTML table through `<mdraft-table>`.

**A translated line disappears because the AI answer cleaner guessed it was a preamble**
A tagged answer's first line is content. A translation can legitimately begin with "Here is the text of the treaty", and the source guard compares against the original language, so it cannot recognise the translated line. `clean_answer` removes a leading preamble only when the model ignored the wrapper; a tagged answer is cleaned for trailing summaries and notes only. Do not "fix" the leading case by stripping any line shaped like an introduction inside a wrapper.

**`no delta arrives after Stop` fails with `13: "<mdraft-expa\n"`**
The mock holds the first 12 characters of the streamed answer, which for the longer namespaced wrapper is a half-written opening tag. `TagFilter::finish` in `Seek` pushed any non-empty buffer, so a stopped request showed the wrapper fragment as the answer; the check's old 12-character threshold was calibrated to `<expanded>Ex`, whose unknown element DOMPurify shortened. Discard a buffer that is only a prefix of the expected opening tag, and measure the visible text after trimming the newline the Markdown renderer adds. Do not widen the threshold: the fix belongs in the filter.

**`KeyError: 'uni02C8'` (or `uni0329`, `CR`) from `fontTools/subset/__init__.py` when pinning Playfair's axes**
`subset-fonts.py --instance '{"opsz":17,"wdth":100}'` on `Playfair[opsz,wdth,wght].ttf` failed in `_dict_subset`: the `gvar` table of the instanced font has no variation entry for some glyphs the subset still requests. This is a fontTools instancing/subsetting order problem, not a bad source pin or a bad axis value. Subset first and instantiate afterwards (`--instance-after-subset`, which `fetch-fonts.ps1` passes when `font-sources.json` says `instanceAfterSubset: true`). The retained glyphs and the required features are the same.

**Two identical `subset-fonts.py` runs print different SHA-256 values, and the recorded pin looks wrong**
`fontTools` stamps `head.modified` with the current time on every save, so the same source, axes and features produce a few bytes' difference and a different digest; `fonts.json` then records a timestamp rather than the content. Set `font.recalcTimestamp = False` before saving, which keeps the source's timestamp. The script now does this, so a pin can be reproduced; existing files generated before the change still carry their original stamp and need no rewrite.
