# AI Assistant: a real "Most used" group

**Status:** approved
**Date:** 2026-11-02
**ADR:** `../adr/2026-11-02-ai-action-usage.md`

## Context and goal

The palette's first section says **Most used** and always shows *Continue
writing*, *Improve writing* and *Ask AI…*, in that order, whatever the reader
actually uses. The heading is a lie: nothing is recorded, so the rows never
change.

The cause is structural, not a rendering bug. `mostUsed` is a real member of the
`AiGroup` union in `src/ai/actions.ts:10`, and those three actions carry
`group: "mostUsed"` (`actions.ts:65`, `:75`, `:85`). A group membership is
exclusive, so the same actions are **missing** from the categories they belong
to: *Continue writing* is not under *Write*, *Improve writing* is not under
*Refine*, *Ask AI…* is not under *Understand*. There is also nothing to count
with: the only record of a request is the in-memory, ten-entry session History
(`src/ai/history.ts`), which is discarded on close and skips stopped answers.

The goal: each action declares its one true category; *Most used* becomes a
derived shortcut section showing the three actions this reader actually reaches
for, most-frequent first, based on completed requests, persisted across
launches, with no timers, no network and no measurable cost on the palette.

## Scope and non-scope

### In scope

- Removing `mostUsed` from `AiGroup`. The three actions join their real
  categories: **Continue writing → Write**, **Improve writing → Refine**,
  **Ask AI… → Understand**.
- `Most used` becomes a virtual group computed at render time from per-action
  usage, ordered by a decaying score (see below), capped at
  `MOST_USED_LIMIT = 3`.
- A `src/ai/usage.ts` pure module: `sanitizeUsage`, `recordUsage`,
  `rankMostUsed`, `decay` — no Tauri, no DOM, no clock read unless a test leaves
  `now` out.
- A persisted `aiActionUsage` field in `settings.json`
  (`{ id, score, at }[]`), additive and defaulted so an existing file keeps
  loading.
- Recording a use when a request **completes** (`done`), once per opened panel:
  a successful or reader-stopped answer counts, a 401, an unreachable endpoint
  or a request abandoned before Generate does not. Regenerate and Retry inside
  the same panel do not count again.
- Cold-start fallback: while fewer than three actions have been recorded, the
  section fills from today's three defaults, so a fresh profile looks exactly
  as it does now and no heading appears empty.
- The search field hides *Most used*: filtered results must not contain the same
  action twice.
- Unique row ids (`ai-row-<group>-<action>`), because an action now renders in
  two places.
- Unit, Rust and UI coverage, plus the count updates in `AGENTS.md`/`README.md`.

### Non-scope

- Per-parameter statistics (Tone · Formal versus Tone · Casual, Translate ·
  French versus German). Usage is counted per action id.
- Reordering inside the four real categories, or learning what an action means.
- A user-visible counter, badge, "reset usage" control or Preferences row. This
  adds no new control, so it adds no dead control.
- Moving usage to a new file, a new Tauri command or `localStorage`.
- Personalising prompts, models or context sizes.
- The panel, History, streaming, credentials and the transport.

## Approach and rejected alternatives

**One store, two pure functions.** Usage lives in `settings.json` beside the
other assistant settings, because that is the only persistence the frontend has
(`Settings` in `src/api.ts`, `AppSettings` in `src-tauri/src/settings.rs`), it is
already written through the queued `persist()` path in `src/main.ts:1026`, it
survives a restart, and it is backed up and restored by `scripts/test-all.mjs`
like every other preference. Rust stays a dumb validator: it does not know
action ids and does not rank.

**Exponential decay, applied lazily.** Each entry is
`{ id, score, at }`. A use sets `score = score·0.5^(Δt / 30 days) + 1` with
`Δt = now − at`. Ranking decays every entry to *now* and sorts. This is a
one-shot O(n) computation over at most 32 entries with **no timer, no cron and
no background job**, so "most used" tracks the reader's current habits instead
of a lifetime total that a busy first week would dominate forever. A half-life
of 30 days keeps the order stable between sessions (it takes weeks of new
behaviour to overtake a habit), while a single use of something new climbs
above an entry that has not been touched for months.

**"Used" means a completed exchange.** `recordHistory` (`assistant.ts:1184`)
skips stopped answers and empty text; usage must not copy that rule, because a
reader who stopped a long Continue still used Continue. But `started` is too
early: `AiEvent::Started` is sent at `src-tauri/src/ai/mod.rs:370`, before the
HTTP request is made, so a 401 or an unreachable host would inflate a score.
`done` (`mod.rs:432`) is emitted only after a real answer, with
`stopped: true` included. The frontend therefore records in the `done` branch of
`onEvent` (`assistant.ts:1939`), guarded by one `usageCounted` flag that
`openPanel` clears — one panel session counts once, whatever Retry or Regenerate
does inside it.

**Duplication in the palette is intended.** An action appears once as a
shortcut under *Most used* and once in its own category, the way a launcher's
"recent" section repeats commands that are also in the full list. Categories
stay complete, and the empty-query view shows 14 catalog rows plus 3 shortcuts.
The alternative — removing the shortcut rows from their categories — leaves the
categories with holes and makes the unfiltered list disagree with a search for
the same action.

Rejected alternatives:

| Alternative | Why it lost |
| --- | --- |
| Lifetime counts, no decay | Freezes into an order a heavy first week sets, and never reflects a change of habit. |
| "Recently used" (last timestamp only) | Answers a different question, and one accidental click reorders the group. |
| `localStorage` | Outside the settings contract: not restored with a profile, invisible to Rust, not covered by the harness's backup, and a second persistence mechanism for one field. |
| A dedicated usage file and command | A new Rust module, atomic-write path, cap logic and migration for under a kilobyte of counters; no benefit over the file already written on every preference change. |
| Counting in `choose()` (the palette click) | Tone, Translate and Convert open a panel and may never be generated, so an abandoned choice would count as use. |
| Counting on `started` | Emitted before the network call, so failures and bad keys count. |
| Deriving usage from History | Ten entries, memory only, disappears on close, and excludes stopped answers. |
| Ranking in Rust | Rust has no action catalog; a second id list there would drift from `actions.ts`. |
| Hiding shortcut rows in their categories | Incomplete categories and an unfiltered list that disagrees with a search. |

## Steps

- [ ] **Rust: the store.** Add `AiActionUsage { id: String, score: f64, at: u64 }`
  and `#[serde(default)] pub ai_action_usage: Vec<AiActionUsage>` to `Settings`,
  plus a `MAX_AI_USAGE_ENTRIES: usize = 32`. In `parse_settings`, sanitise the
  raw JSON **before** deserialising (`normalize_ai_usage`, the same pattern as
  the `exportFormats` migration at `settings.rs:661`): drop a value that is not
  an array, entries that are not objects, empty or over-long ids, non-finite or
  negative scores, and timestamps in the future by more than a day; deduplicate
  ids keeping the higher score; sort by score then recency; truncate to the cap.
  Apply the same cap in `AppState::save`. A malformed `aiActionUsage` must never
  make `parse_settings` return `None`, because that resets every other setting
  in the file (`settings.rs:753`).
- [ ] **Rust tests**: default and legacy file load with an empty list; round
  trip through `save`; `{"aiActionUsage": "nope", "theme": "dark"}` still loads
  `theme` dark; a 40-entry payload is capped by score; negative/huge scores and
  future timestamps are dropped.
- [ ] **`src/api.ts`**: export `AiUsageEntry { id: AiActionId; score: number;
  at: number }` and add `aiActionUsage: AiUsageEntry[]` to `Settings`, with a
  comment naming the decay rule and that the backend only bounds it.
- [ ] **`src/ai/actions.ts`**: `AiGroup` becomes `"write" | "refine" |
  "understand" | "transform"`; add `AiGroupKey = "mostUsed" | AiGroup`;
  `GROUP_ORDER`/`GROUP_LABELS` are keyed by `AiGroupKey`; the three actions get
  their real group; add `DEFAULT_MOST_USED: AiActionId[] = ["continue",
  "improve", "ask"]` and `MOST_USED_LIMIT = 3`; `groupedActions(actions,
  mostUsed)` intersects the ranked list with `actions` by id and puts the
  virtual group first.
- [ ] **`src/ai/usage.ts`** (new, pure): `sanitizeUsage(value, now)` (unknown
  ids, duplicates, non-finite/negative scores, future timestamps, cap),
  `decay(score, elapsedMs)`, `recordUsage(entries, id, now)` (decay, +1, prune
  below 0.02, cap at 32, store sorted), `rankMostUsed(entries, now, limit)`
  (decay, sort by score desc → `at` desc → catalog order, fill from
  `DEFAULT_MOST_USED` then the catalog, return specs). Import with explicit
  `.ts` extensions, or `npm run ai:unit` fails to resolve.
- [ ] **`src/ai/assistant.ts`**: extend `AssistantHost` with
  `usage(): readonly AiUsageEntry[]` and `recordUsage(id: AiActionId): void`;
  in `renderPalette` compute
  `const mostUsed = search.value.trim() ? [] : rankMostUsed(host.usage())` and
  pass it to `groupedActions`; give each row a group-qualified id; reset
  `usageCounted` in `openPanel` and record once in the `done` branch, before
  `renderPanel()`.
- [ ] **`src/main.ts`**: implement the two host methods. `usage` returns
  `settings.aiActionUsage ?? []`; `recordUsage` mutates through
  `applySettingsPatch({ aiActionUsage: recordActionUsage(settings.aiActionUsage,
  id) }, { refreshUi: false })`, where the second argument is a new option that
  skips `applyTheme`/`applyLayout`/`assistant.sync()` — none of them can change
  because of a counter — while still assigning `settings` and calling
  `persist()`, so the queued whole-settings write stays the single write path.
- [ ] **Tests**: extend `scripts/ai-unit.mjs` and `scripts/ai-assistant-test.mjs`
  (below), update the two group assertions that currently expect the static
  three, and add `aiActionUsage: original.aiActionUsage` to the mock suite's
  restore list at `ai-assistant-test.mjs:3688`, or a standalone `npm run ai`
  leaves test usage in the developer's profile.
- [ ] **Docs**: `AGENTS.md` test counts and repository-script rows for
  `ai:unit`/`ai`, the `README.md` AI paragraph if it names the groups, and the
  ADR.

## Files and modules

| File | Why it must change |
| --- | --- |
| `src-tauri/src/settings.rs` | The persisted field, `MAX_AI_USAGE_ENTRIES`, `normalize_ai_usage` on load and the cap on save, plus tests. |
| `src/api.ts` | The wire shape of `Settings` the frontend reads and writes. |
| `src/ai/actions.ts` | Group membership, the virtual key, the defaults, `groupedActions`. |
| `src/ai/usage.ts` | New: sanitise, decay, record, rank. |
| `src/ai/assistant.ts` | Host contract, the palette's virtual group, the `done` hook, unique row ids. |
| `src/main.ts` | Wiring usage to `settings`/`persist`, and the quiet patch option. |
| `scripts/ai-unit.mjs` | Catalog assertions plus about 18 checks for `usage.ts`. |
| `scripts/ai-assistant-test.mjs` | About 10 UI checks and the settings restore list. |
| `docs/adr/2026-11-02-ai-action-usage.md` | The decision: where usage lives and where ranking lives. |
| `AGENTS.md`, `README.md` | Test counts and the description of the group. |

`src/styles.css` does not change: the section already renders through
`.ai-group`/`.ai-row`.

## Risks and rollback

- **A malformed `aiActionUsage` wipes the settings file.** `parse_settings`
  returns `None` on any deserialisation error and `AppState::load` then falls
  back to `Default`, so the field is sanitised at the `serde_json::Value` level
  before it reaches the struct. The Rust test with a non-array value and a
  surviving `theme` is the guard.
- **The group jumps around between sessions.** Decay plus the `at` tie-break
  and catalog-order fallback are deterministic; the unit tests inject `now`, so
  no assertion depends on the wall clock.
- **A mis-timed record inflates the top three.** Counted in `done` only, once
  per panel; Regenerate and Retry are inside that panel. A 401 test asserts zero
  usage, and a Regenerate test asserts the score did not grow.
- **The reader's profile keeps test data.** `scripts/test-all.mjs` already
  backs up and restores `settings.json`, but a standalone `npm run ai` restores
  only the fields it lists; `aiActionUsage` joins that list.
- **Palette height and keyboard order change** (17 rows instead of 14). The
  520 px cap and the internal scroll already handle it; the UI suite asserts
  both, and the first row is still Continue writing on a fresh profile.
- **Rollback:** revert the commit. The extra key in `settings.json` is ignored
  by the previous build (`#[serde(default)]` on the struct still tolerates the
  unknown field), so a reader's file needs no migration back.

## Tests and validation

- `npm run ai:unit` — about 18 new checks: fresh-profile order equals the
  defaults; one use of *Summarize* ranks it first; the action is still listed
  under *Understand*; the limit is three; a score halves after one half-life; a
  recent habit beats an older, equal count; equal scores fall back to catalog
  order; unknown ids, duplicates, negative/non-finite scores and future
  timestamps are dropped without throwing; `recordUsage` adds one, prunes, and
  caps; `undefined` (a file from before this change) is accepted; a search query
  hides the virtual group; every action has exactly one real group.
- `npm run test:rust` — the five settings checks above (271 → 276 on Windows).
- `npm run ai` — the suite's mock endpoint accepts requests, so one *Summarize*
  run is a real `done`. Checks: the fresh palette shows the three defaults; after
  Summarize, its row is the first `.ai-row` under the first `.ai-group`; the same
  action still appears under *Understand*; every `.ai-row` id is unique; typing
  `summ` hides the *Most used* heading and clearing the field restores it;
  Regenerate does not raise the stored score; a 401 leaves the score unchanged;
  `get_settings().aiActionUsage` and the on-disk `settings.json` both carry the
  entry (poll the file, do not sample once); the palette is still ≤ 520 px and
  the footer is unchanged.
- `npm run build`, `npm run lint`, `npm run format:check`, `npm run knip` — the
  new module is imported, exported and formatted.
- The measurement that proves it: use an action that is not one of the three
  defaults, reopen the palette, and see it first under *Most used* **while it is
  also still under its own category** — then read the same entry back from
  `settings.json`.

## Acceptance criteria

- A fresh profile shows exactly today's three rows under *Most used*, and
  *Continue writing* appears under *Write*, *Improve writing* under *Refine*,
  *Ask AI…* under *Understand*.
- After three uses of *Summarize* and none of the defaults, *Most used* lists
  *Summarize* first and the padding defaults have dropped out.
- The order survives a restart, and a 401, a failed connection or an abandoned
  panel leaves it unchanged.
- Typing in the search field removes the duplicate section; clearing it restores
  the section in the same order.
- No network request, timer or new dependency is added, and the palette opens
  with the same measured height and scroll behaviour as before.

## Open questions

- **Where does *Ask AI…* belong?** Default: *Understand*, whose description
  already says it answers questions about the selection. A fifth real group
  named *Ask* would need a new heading for one row; pinning Ask out of every
  category would break the "one true category" rule.
- **Should the shortcut rows be suppressed inside their categories?** Default:
  no, for the reasons above. If the palette ever loses its scroll cap, revisit.
- **Three or four shortcuts?** Default: three, matching what the section shows
  today and keeping the 520 px palette comfortable. `MOST_USED_LIMIT` is one
  constant if four proves better in use.
- **Half-life of 30 days.** Default: 30, exported as `USAGE_HALF_LIFE_MS` so it
  is one number to retune after real use.
- **Per-parameter statistics** stay out until someone asks; they would need a
  wider key and a rule for what the palette row then shows.
