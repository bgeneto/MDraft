# A shared searchable combo for the AI Assistant's Translate target, and a language list worth searching

**Status:** in progress
**Date:** 2026-11-02
**ADR:** `../adr/2026-11-02-shared-combo.md`

## Context and goal

The AI Assistant's parameter row builds three different controls
(`buildParams`, `src/ai/assistant.ts:1255`):

| Action | Control | Popup |
| --- | --- | --- |
| Tone | native `<select>`, 6 items | OS-drawn, field matches `--border`/`--bg` |
| Convert | native `<select>`, 3 items | same |
| Translate | `<input list="ai-language-list">` (`:1278`) | **Chromium's `<datalist>` dropdown** |

The datalist popup is browser chrome and cannot be styled: it ignores the app's
type scale, row height, hover tint, scrollbar and any mark for the current value.
A reported screenshot of the panel shows five rows filling the popup, set in a
heavier, larger face than the panel's own rows, with a wide scrollbar and no
indication of which language is selected.

It is **not** the wrong colour: `:root` and `[data-theme="dark"]` set
`color-scheme` (`styles.css:6`, `:84`), so the popup already follows the app's
light/dark setting. The case therefore rests on typography, rhythm, hover and
selected state — not on palette — and a check that only compared backgrounds
would prove nothing. It is still the only dropdown in the application that does
not look like the application. The Preferences Model field had the same problem
and lost it to `src/model-combo.ts` on 2026-10-28.

The list itself is the second half of the problem. `LANGUAGES`
(`src/ai/actions.ts:54`) is ten hand-picked names: no Korean, Dutch, Polish,
Ukrainian, Turkish, Vietnamese, Hindi, Persian or Catalan. Two of the ten are
ambiguous in a way that reaches the model, because the value is interpolated into
the prompt verbatim:

- **"Portuguese"** — pt-BR or pt-PT? The model chooses. This repository already
  treats the two as distinct: the spelling path names a `pt-BR` dictionary, and
  Read Aloud resolves `pt-BR` from the document. MDraft's own vocabulary is more
  precise than its suggestion list.
- **"Chinese"** — Simplified or Traditional. **"Spanish"** — Spain or Latin
  America. The model guesses, and a reader gets the wrong variant.

**Goal:**

1. One searchable combobox engine in the app, used by both the Model field and
   the Translate target, so the language popup is the app's own control.
2. A language list grown from 10 to 34 entries with the ambiguous variants split,
   and a search that matches aliases — `pt-BR`, `brasil`, `mandarin`, `espanol` —
   which a `<datalist>` cannot do at all. Search then has a job beyond shortening
   a list.
3. Tone and Convert stay native `<select>`s. They are short closed lists, and a
   native select is this app's existing standard for that (`Row` has a `select`
   kind in `src/preferences.ts`). See the rejected alternatives.

## Scope and non-scope

**In scope**

- `src/combo.ts`: a generic editable combobox — pure `filterEntries`, plus
  `attachCombo` / `closeCombo` — extracted from `src/model-combo.ts`.
- `src/model-combo.ts` keeps its public names (`filterModelIds`,
  `attachModelCombo`, `closeModelCombo`) as thin wrappers, so
  `src/preferences.ts` and `scripts/ai-unit.mjs` do not change their imports.
- CSS: the structural `prefs-combo-*` rules become `combo-*`; `.prefs-combo`
  survives as the Preferences width context and a new `.ai-param-combo` sizes the
  panel's copy.
- `src/ai/languages.ts`: the 34-entry suggestion table with aliases and
  `filterLanguages`, replacing the ten strings exported from `ai/actions.ts`.
- `src/ai/assistant.ts`: the Translate branch builds the combo instead of a
  `datalist`; the datalist is deleted; `closeCombo()` is called wherever the row
  is rebuilt or the panel closes.
- Popup copy for languages: a no-match row that teaches the free-text path
  (`No match — press Enter to use "Catalan"`).
- Unit checks for the filter and the language search, UI checks for the popup,
  keyboard, Escape ordering and the typed-target path.
- The ADR, the AGENTS counts and code map, and this plan.

**Non-scope**

- No change to Tone or Convert; both stay native `<select>` (§ Approach).
- No change to the model picker's behaviour, reconcile rule, or the
  `ai.modelsEndpoint` bookkeeping.
- No change to `src/font-picker.ts`. It is a third lookup control but a different
  shape: button trigger, grouped two-line specimens, search inside the popup.
  Folding it in would double the change and is recorded as an open question, not
  as work.
- No new language *detection* or BCP-47 plumbing. The parameter is still free
  text interpolated into the prompt; `parameterIsValid("translate", …)` still
  accepts 1–60 characters.
- No memory of recently used targets (explicitly deferred, § Open questions).
- No settings-schema, Rust command or prompt-file change.
- No localisation of the language names; the UI is English.

## Approach and rejected alternatives

`filterEntries(entries, query)` folds diacritics (NFD, strip marks), lowercases,
trims, and matches a substring against an entry's `value`, `label` and
`keywords`. Caller order is preserved and there is no sorting: the ordered list
*is* the ranking. `attachCombo` is `attachModelCombo` generalised — same inset
caret, same body-appended `position: fixed` listbox, same
`pointerdown.preventDefault()` on options so the field keeps focus, same
`aria-*` contract, same close-on-scroll/resize/outside-pointerdown — with the
things the two callers differ in made explicit:

| Concern | Model field | Translate field |
| --- | --- | --- |
| Entry type | `{ value }` | `{ value, keywords }` |
| Empty list | "No models fetched yet. Use Fetch model list." | (never empty) |
| No match | `No fetched model matches "x".` | `No match — press Enter to use "x".` |
| List label | "Fetched models" | "Suggested languages" |
| Enter, no active row | commit the typed id (`change` event) | submit the request |
| Popup width | the field's width | the field's width or the longest label, whichever is wider |

Enter picks the highlighted row when one is highlighted; otherwise it calls the
caller's `accept`, which for the model row persists the typed id and for
Translate calls `startRequest()`. Escape closes the list and stops there on the
first press, because the panel's own Escape handler is a bubble-phase listener on
`panel` (`assistant.ts:2196`) and the stop happens below it. That is the same
one-press-per-layer behaviour the model picker already has inside Preferences.

The list is ordered in two blocks with no visible group heading (grouping is the
font picker's idiom and would add a second pattern here): a curated head of the
twelve most likely targets, then the rest alphabetically. The popup opens showing
everything — the same rule as the model picker, where the field's value is a
selection and not a filter — so the head is what a reader sees first.

`value` and `label` are the same string (`"Portuguese (Brazil)"`), not a BCP-47
tag. The value is sent verbatim into the prompt and becomes the History title
("Translate · Portuguese (Brazil)"), so a readable name is worth more than a
machine code; aliases carry the tags for search instead.

`<label class="ai-param">` wraps the control today, which is fine for a `select`
or an `input`. It cannot wrap the caret `<button>`: `<button>` is a labelable
element, so a label containing both an input and a button has two labelable
descendants and a click on the visible text may activate either. Translate
therefore becomes `<div class="ai-param"><label for="ai-target-language">` plus
the `.combo` wrapper. Tone and Convert keep the label-wrapped markup they have.

Rejected alternatives:

- **Keep the datalist and add a caret.** Its type, row height, hover, selected
  state and scrollbar are unreachable from CSS, so a caret would open the same
  foreign card. It leaves the reported complaint entirely in place.
- **Make the language field a `<select>` of 34 rows.** Removes the free text that
  `parameterIsValid` explicitly allows and that readers use for "Catalan" and
  "pt-BR" — the UI suite pins both today.
- **Move Tone and Convert to the same combo.** Six and three closed options need
  no search, and a native `<select>` is what every Preferences enumeration uses.
  Replacing them would make the panel *less* uniform, and costs OS keyboard
  behaviour (type-ahead, platform menus) for nothing.
- **Copy `model-combo.ts` into the AI panel.** A third copy of outside-click,
  scroll, resize, Escape and the positioning maths — this is the maintenance
  problem the extraction exists to prevent.
- **Put the long list behind group headings ("Common", "All").** Two visual
  idioms in one panel for 34 rows; the head/tail order already puts the likely
  rows first.
- **Use BCP-47 tags as the value.** Better for a machine, worse everywhere a
  human reads it: the prompt, the History title, and the field itself.
- **Sort alphabetically only.** Pushes English, Portuguese and Spanish into the
  middle of the first screenful and makes the default view worse.

## Steps

- [x] Add `src/combo.ts`: `ComboEntry`, pure `filterEntries`, `attachCombo`,
      `closeCombo`, and the module-level single-popup rule.
- [x] Reduce `src/model-combo.ts` to wrappers over `combo.ts`, keeping
      `filterModelIds`, `attachModelCombo` and `closeModelCombo` exported.
- [x] Update `src/preferences.ts` to `className = "combo prefs-combo"`; no
      behaviour change.
- [x] Rename the popup CSS from `.prefs-combo-*` to `.combo-*`, keep
      `.prefs-combo` for the 420 px context, add `.ai-param-combo`, and let the
      popup grow to its longest label up to the viewport margin.
- [x] Add `src/ai/languages.ts` with the 34 entries and `filterLanguages`; remove
      `LANGUAGES` from `src/ai/actions.ts` and update the import.
- [x] Rebuild the Translate branch in `buildParams` with `attachCombo`; delete the
      `datalist`; wire `choose → setParameter`, `accept → startRequest()`, and the
      no-match copy.
- [x] Call `closeCombo()` at the top of `buildParams`, in the panel's `close()`,
      and anywhere `paramsEl` is replaced.
- [x] Update the model-picker selectors in `scripts/ai-assistant-test.mjs`
      (`.prefs-combo*` → `.combo*`) and add the new translate-popup checks.
- [x] Add `filterEntries` / `filterLanguages` checks to `scripts/ai-unit.mjs`.
- [x] Write `docs/adr/2026-11-02-shared-combo.md`.
- [x] Update `AGENTS.md`: the five count rows and the release-checklist sum, the
      code map (`combo.ts`, `ai/languages.ts`, `model-combo.ts`), and the `ai`
      row's description of the target-language field.
- [ ] Run the gates in [Tests and validation](#tests-and-validation), record the
      real totals here, and set the status.

**Deviations**

- The popup's copy for a language that matches nothing reads
  `No match — press Enter to translate into “x”.`, not the planned
  `use “x”`: the verb is what the reader is about to do.
- `closeCombo()` is also called from `openPalette()` and `openHistory()`. Both
  hide the panel, and only a real pointerdown would otherwise dismiss a list left
  open by a keyboard route.
- The shared engine's keydown handler ignores `event.isComposing`. The old
  Translate field had that guard; moving Enter into the component dropped it, and
  an IME commit would have submitted the request.
- The popup grows through a `growToFit` option that measures `max-content` and
  clamps to the viewport margin. The Model field keeps its field-width popup, so
  its existing 420-versus-420 geometry check still holds.
- `.prefs-combo` keeps `border-radius: 4px` on its input, and `.combo` carries
  only the structure: the AI panel's field is a 30 px, 6 px-radius control and
  must not inherit the Preferences radius.
- **`bra` was the wrong probe.** Only "Portuguese (Brazil)" contains it, so the
  UI check types `port` and expects both Portuguese rows; the acceptance
  criterion below was corrected to match.
- **Enter moves from the selected row.** The list opens on the field's current
  value, so ArrowDown from "Portuguese (Brazil)" reaches
  "Portuguese (Portugal)", not "English (US)". The check now states that.


## The language list

Head, in display order (the twelve a reader is most likely to want):

| Value / label | Aliases (search only) |
| --- | --- |
| English (US) | `en`, `en-US`, `american`, `us english` |
| English (UK) | `en-GB`, `british`, `uk english` |
| Portuguese (Brazil) | `pt-BR`, `pt`, `brasil`, `brasileiro`, `brazilian` |
| Portuguese (Portugal) | `pt-PT`, `europeu`, `european` |
| Spanish (Spain) | `es-ES`, `castilian`, `castellano`, `español`, `espanol` |
| Spanish (Latin America) | `es-419`, `latinoamerica`, `latinoamérica`, `latin american` |
| French | `fr`, `français`, `francais` |
| German | `de`, `deutsch` |
| Italian | `it`, `italiano` |
| Chinese (Simplified) | `zh`, `zh-CN`, `zh-Hans`, `mandarin`, `simplified`, `简体` |
| Chinese (Traditional) | `zh-TW`, `zh-Hant`, `traditional`, `繁體` |
| Japanese | `ja`, `nihongo`, `日本語` |

Tail, alphabetical:

| Value / label | Aliases (search only) |
| --- | --- |
| Arabic | `ar`, `العربية` |
| Bengali | `bn`, `বাংলা` |
| Catalan | `ca`, `català`, `catala` |
| Czech | `cs`, `čeština`, `cestina` |
| Danish | `da`, `dansk` |
| Dutch | `nl`, `nederlands` |
| Finnish | `fi`, `suomi` |
| Greek | `el`, `ελληνικά` |
| Hebrew | `he`, `עברית` |
| Hindi | `hi`, `हिन्दी` |
| Indonesian | `id`, `bahasa indonesia` |
| Korean | `ko`, `한국어` |
| Norwegian | `no`, `norsk` |
| Persian | `fa`, `farsi`, `فارسی` |
| Polish | `pl`, `polski` |
| Romanian | `ro`, `română`, `romana` |
| Russian | `ru`, `русский` |
| Swedish | `sv`, `svenska` |
| Thai | `th`, `ไทย` |
| Turkish | `tr`, `türkçe`, `turkce` |
| Ukrainian | `uk`, `українська` |
| Vietnamese | `vi`, `tiếng việt` |

Two deliberate consequences:

- `zh` matches both Chinese entries, because either is a reasonable answer to
  "zh" and the labels disambiguate on screen. Same for `pt` (both Portuguese) and
  `es`.
- Diacritics fold, so `espanol`, `francais`, `turkce`, `catala`, `cestina` and
  `romana` all match — which is the whole point of folding instead of lowercasing.

## Files and modules

| File | Why |
| --- | --- |
| `src/combo.ts` | New engine: pure filter plus the caret/listbox component. No top-level DOM, so the Node unit suite can import it. |
| `src/model-combo.ts` | Keeps its exports as wrappers, so `preferences.ts` and `ai-unit.mjs` keep their imports. |
| `src/ai/languages.ts` | The 34-entry table and `filterLanguages`; keeps `actions.ts` free of a large data block. |
| `src/ai/actions.ts` | Loses `LANGUAGES` (only `assistant.ts` imported it). |
| `src/ai/assistant.ts` | The Translate branch, the `<label for>` restructure, `closeCombo()` on rebuild and close. |
| `src/preferences.ts` | One class name: `combo prefs-combo`. |
| `src/styles.css` | `.combo-*` rename, `.ai-param-combo` sizing, the wider popup rule. |
| `scripts/ai-unit.mjs` | Filter folding, aliases, tags, order, empty query, no match — no application. |
| `scripts/ai-assistant-test.mjs` | Selector renames plus the popup, keyboard, Escape and typed-target checks. |
| `docs/adr/2026-11-02-shared-combo.md` | The durable half: one combobox engine, and why the font picker stays out. |
| `AGENTS.md` | Counts are a contract: five rows plus the release-checklist sum. The code map gains `combo.ts` and `ai/languages.ts`. |
| `README.md` | No change expected: the AI bullet names Translate but neither its control nor its list. |
| `docs/plans/2026-11-02-ai-param-combobox.md` | This record. |

## Risks and rollback

- **A `<label>` wrapping both an input and a button.** Silently makes the visible
  label ambiguous for assistive technology and may toggle the popup instead of
  focusing the field. Avoided by the explicit `<label for>` structure; the plan's
  acceptance check is that clicking "Translate to" focuses the input.
- **A third `activeClose` singleton fighting the model picker.** There is one
  module-level popup owner, so opening one closes the other. Correct, but only if
  every teardown path calls `closeCombo()`: `buildParams`, the panel's `close()`,
  and a tab switch that re-renders the panel. A stale popup would float over the
  editor with its field detached.
- **The popup overlays the context summary.** It opens below the field when there
  is room and above otherwise, and closes on scroll, so the summary stays
  reachable; the mock suite asserts the popup is visible and above the panel.
- **Test selector churn.** `.prefs-combo*` is asserted in the model-picker
  section of `scripts/ai-assistant-test.mjs`; the rename touches eight selectors
  and nothing else. Missing one fails loudly as a zero-length option list, not
  silently.
- **Prompt text changes for readers who used the old list.** "Portuguese" now
  inserts "Portuguese (Brazil)" only when chosen; an earlier History entry keeps
  its old title. No migration is needed and nothing is rewritten on disk.
- **Count drift in AGENTS.** The counts appear in five rows plus the
  release-checklist sum. Take the numbers from the suites' own final lines.
- **Rollback.** Revert the commit. No settings, command or prompt-file change, so
  a rollback needs no migration; `LANGUAGES` returning as ten strings is the only
  thing an older build would notice.

## Tests and validation

- `npm run ai:unit` — `filterEntries`: case folding, diacritic folding, keyword
  and label matching, order preserved, empty query returns everything, no match
  returns nothing, and `filterModelIds` still behaves exactly as the existing
  checks require. `filterLanguages`: `brasil` → Portuguese (Brazil), `pt` → both
  Portuguese entries in table order, `espanol` → Spanish (Spain), `zh` → both
  Chinese entries, `mandarin` → Chinese (Simplified), `klingon` → nothing, and the
  head/tail order is the table's.
- `npm run ai` (mock) — the popup is the app's own element, not a datalist
  (`document.querySelector(".ai-params datalist")` is null and `.combo-popup`
  is not); the caret opens all 34 rows with the panel scrolled to the top; typing
  `bra` leaves two rows; clicking `Portuguese (Brazil)` writes it into the field,
  closes the popup, and the mock's system message contains
  `into Portuguese (Brazil)`; Enter with a row highlighted chooses it instead of
  submitting; Enter with no row highlighted submits; the first Escape closes only
  the popup and the panel is still open; the second closes the panel; the current
  value is marked `aria-selected="true"`; clicking "Translate to" focuses the
  field; and the existing typed-target checks (Catalan, retyping clears the
  answer) still pass with their selectors unchanged.
- The measurement that proves it: **the rows in the opened popup and the string in
  the mock's recorded system message**. A themed-looking list that never reaches
  the prompt, or a prompt that receives the alias instead of the label, would
  otherwise pass a check that only counted elements.
- `npm run build` — the `HTMLSelectElement | HTMLInputElement` union narrows, and
  the Row/DOM typings still compile.
- `npm run lint`, `npm run knip`, `npm run format:check`, and
  `cargo clippy --all-targets -- -D warnings` — the Quality gates, unchanged in
  their expectations; no Rust file is touched.
- Manual: Translate in light and dark, at the default panel width and after
  resizing, in Split and Preview-only, with the list opened from the caret, from
  typing, and from ArrowDown.
- **Recorded results:**
  - `npm run build` — passed on the combined tree.
  - `npm run ai:unit` — **153/153** from this change (+17); the tree then carried
    a concurrent *Most used* change, and the same suite reports **184/184** with
    both in place.
  - `npm run ai` — **307/307** against a disposable build with its own
    identifier, in a local mock run. The first attempt reported 302/307: two
    failures were the wrong expectations recorded under Deviations, and three
    (`the edited prompt is saved to disk`, `a file that does not parse is
    reported in the panel`, `the file parses again after Reset`) came from
    running under that disposable identifier — `scripts/ai-assistant-test.mjs`
    reads `%APPDATA%\<identifier>` through `MDRAFT_TEST_IDENTIFIER`, which was
    not set for the first run.
  - `npm run lint`, `npm run knip` — clean.
  - Not yet run on the tree that carries both changes: the full `npm run ai`
    layer, and `npm run format:check`.


## Acceptance criteria

- Translate's target field opens a popup drawn by the application: the panel's
  background, border, hover tint, scrollbar and a check mark on the current
  value, in both themes. No `<datalist>` exists in the panel.
- The popup lists 34 languages, the first twelve in the approved head order.
- Typing `port` leaves the two Portuguese entries; typing `pt-BR` leaves
  Portuguese (Brazil); typing `mandarin` leaves Chinese (Simplified); typing
  `espanol` leaves Spanish (Spain); typing `klingon` shows the no-match row and
  Enter still generates a translation into "klingon".
- Choosing a row inserts the readable label, and that exact label is what the
  model's system message contains.
- Enter with a highlighted row chooses; Enter with none submits; the first Escape
  closes only the list, the second closes the panel.
- Clicking the visible "Translate to" text focuses the field.
- Tone and Convert are unchanged native selects, with the same values and the
  same `change` behaviour.
- `npm run ai:unit` and `npm run ai` pass, and the counts quoted in `AGENTS.md`
  match their final lines.

## Open questions

1. **Exact set and order of the list.** The table above is the proposal; the owner
   may add or remove entries before approval. Default if unanswered: as tabled,
   with `French (Canada)` staying out on the grounds that one French entry is
   enough.
2. **Open the popup on a click into the field, or only from the caret, ArrowDown
   and typing?** Default: only those three, matching the Model field, because the
   caret is now a visible affordance and opening a 34-row list on every click
   into an empty field is noise.
3. **Should the chosen language auto-submit?** Default: no. Tone and Convert also
   wait for Generate, and changing a parameter deliberately clears a previous
   answer.
4. **Fold `src/font-picker.ts` into `combo.ts` later?** Default: not now; the ADR
   records the separation and the reason, so a later change has to argue with it.
5. **Remember the last three targets?** Default: deferred. It needs storage (a
   setting, or a session list like the fetched models) and its own reset story,
   and it would change the head order at runtime.
