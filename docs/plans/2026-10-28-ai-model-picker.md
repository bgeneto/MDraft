# AI Assistant: a searchable model picker and a reconciled Model field

**Status:** done
**Date:** 2026-10-28
**ADR:** none

Approval: the reader asked for the reconcile rule and a searchable combobox in
the same request, after the diagnosis in the conversation. The plan records that
agreed scope; it adds no work the request did not name except the two cleanups
identified with it.

## Context and goal

The AI Assistant's Model row is a text field with a native `<datalist>`
(`src/preferences.ts`). Chromium filters datalist options by the input's current
value. After changing provider, Base URL or key, the field still holds the
previous endpoint's model id; the next Fetch returns a list that does not contain
that id, so clicking the field's arrow opens an **empty** popup even though the
status line reports "45 models found". The reader reads that as a failed fetch.

The opposite rule — "Fetch clears the Model field" — loses data: saving the API
key already fetches the list, endpoints without `/models` are supported by
typing an id, and a model list can be partial. Fetch must not delete a
hand-typed id on a failed or empty answer.

The goal is two changes that reinforce each other:

1. Replace the datalist with a searchable combobox that always opens the **full**
   fetched list, filters only while the reader types, and still accepts free
   text for endpoints that serve no model list.
2. Reconcile the saved id only when a successful, non-empty fetch proves it is
   not offered: clear it, and say so under the field. A failed or empty fetch
   keeps it.

Two small cleanups ride along: the status note no longer prints the same count
twice, and the Base URL and Model rows no longer re-render on blur, which was
replacing the Fetch button between mousedown and mouseup and swallowing the
first click.

## Scope and non-scope

**In scope**

- A new `src/model-combo.ts`: `filterModelIds` (pure) and `attachModelCombo`
  (input + caret + fixed-position listbox).
- Popup behaviour: open with every fetched model regardless of the current
  value; filter as the reader types; arrow-key navigation, Enter, Escape, Tab;
  click to choose; close on outside pointerdown, panel scroll, resize, section
  switch, Preferences close and re-render.
- Accessibility attributes (`combobox`, `listbox`, `option`, `aria-expanded`,
  `aria-controls`, `aria-activedescendant`, `aria-selected`).
- Reconcile rule: on a successful fetch with at least one model, if the saved id
  is absent, clear it and show a field note naming the old id and the endpoint's
  count. Failure or an empty list keeps the value.
- Model lists are remembered against the endpoint that returned them; changing
  the endpoint (including a typed Base URL not yet blurred) drops the old list
  before the request, and a reply for an endpoint that is no longer current is
  ignored.
- `rerender: false` on the Base URL and Model rows, per the existing trap.
- Status note prints the count once, not as both "45 models found" and "45
  models available from the last check".
- Unit checks for the filter, mock-UI checks for the picker, reconcile, free
  text, keyboard and the first-click fix; AGENTS counts and a trap entry.

**Non-scope**

- No new dependency, no Rust command or settings-schema change.
- No auto-selection of the first model; a model choice stays deliberate.
- No change to how the model list is fetched, sorted, capped or deduplicated.
- No change to the AI panel, its actions, or how `aiModel` is used.
- No persistence of fetched lists across launches; they remain session state.

## Approach and rejected alternatives

`attachModelCombo` builds an inset caret inside the field and appends a
`position: fixed` listbox to `document.body`. The caret is inside the same
420 px box as every other Preferences input, the way a native select's arrow is,
rather than a separate 30 px segment: a segmented control made the Model field
wider than Base URL and left the popup 30 px narrower than the field. Fixed
positioning keeps the popup out of `.prefs-content`'s `overflow-y: auto`
clipping; it is positioned from the input's `getBoundingClientRect`, opens below
when there is room and above otherwise, and closes when that geometry could go
stale (scroll, resize, outside pointerdown). Opening via the caret or ArrowDown
lists **all** models. The field's text is used only as the filter once the
reader types, which is the exact difference from the datalist.

The input stays a normal text field: an endpoint with no model list is still
usable, and a missing id can still be typed. Choosing an option writes the id
into the field and persists it through the row's existing setter; Enter with an
active option chooses it, while Enter with no active option persists the typed
text. The component reads `models()` on every open rather than capturing an
array at render time, so a Base URL change that clears the list cannot leave
stale options behind.

The reconcile lives in `loadModels`: after a reply for the current endpoint, a
non-empty list that lacks `s().aiModel` sets `ai.clearedModel`, clears
`aiModel` through `host.update`, and the re-render shows a `.prefs-field-note`
under the Model field. The note disappears as soon as the field is non-empty.
`ai.modelsEndpoint` records which endpoint produced `ai.models`; a fetch for a
different endpoint clears the list before the request, and a late reply for an
endpoint that changed in flight is ignored.

Rejected alternatives:

- **Clear the field on every Fetch.** Loses a hand-typed id on an endpoint with
  no list, an empty answer or a temporary failure, and silently changes the
  model when the key is saved (which also fetches). This was the original
  proposal and the reason for the reconcile rule instead.
- **Keep the datalist and only add a warning.** The warning could explain the
  empty popup, but the popup would still be empty and the reader would still
  have to clear the field by hand. It leaves the primary complaint in place.
- **Replace the text field with a `<select>`.** Fixes browsing but removes free
  text, which is required for local servers and partial lists.
- **Auto-pick the first fetched model when the saved id is absent.** Convenient
  for LM Studio, wrong for gateways where the first sorted id is an embedding or
  an expensive model. A model choice must stay deliberate.
- **Use the HTML Popover API.** It would escape clipping elegantly, but the
  Linux build's WebKitGTK support cannot be assumed from the Windows WebView2.
  Fixed positioning works in both.

## Steps

- [x] Add `src/model-combo.ts` with the pure filter and the popup component.
- [x] Wire the Model row to the component; add the field-note row support.
- [x] Add `ai.modelsEndpoint`, the reconcile rule and the race guard in
      `loadModels`.
- [x] Add `rerender: false` to Base URL and Model; reset the cleared-model state
      in the Provider/Base URL setters and when a model is set.
- [x] Deduplicate the status count.
- [x] Add picker, clear, free-text, keyboard, first-click and status checks to
      `scripts/ai-assistant-test.mjs`; add filter checks to `scripts/ai-unit.mjs`.
- [x] Add the popup CSS, using the existing panel variables in both themes.
- [x] Update `AGENTS.md` (counts, code map, trap), README and finish this plan.
- [x] Run `npm run build`, `npm run ai:unit`, the AI mock suite, `npm run lint`,
      `npm run knip` and `npm run format:check`.

## Files and modules

- `src/model-combo.ts` — new component and pure filter; no Tauri, CodeMirror or
  CSS import, so the Node unit suite can load it.
- `src/preferences.ts` — row type (`suggestions` becomes a live getter,
  `fieldNote` added), Model/Base URL rows, `AiUiState`, reconcile, status text,
  popup cleanup on render/close.
- `src/styles.css` — `.prefs-field`, `.prefs-field-note`, the caret and the
  fixed popup, light and dark.
- `scripts/ai-unit.mjs` — filter behaviour, no application.
- `scripts/ai-assistant-test.mjs` — the real picker, reconcile and first-click
  path against the mock endpoint.
- `AGENTS.md` — counts, code map, and the datalist trap.
- `README.md` — only if the AI feature text describes the old model control.
- `docs/plans/2026-10-28-ai-model-picker.md` — this record.

## Risks and rollback

- **Popup clipping or placement.** Fixed positioning avoids the content
  scroller, but the geometry must be recomputed per open. The fallback is to
  close on scroll/resize rather than drift; the mock suite asserts the popup is
  visible with options above the field.
- **Focus and blur races.** The input must not lose focus to an option before
  the click commits. `pointerdown.preventDefault()` on options and
  `rerender: false` on the row are the two guards; the real-pointer Fetch check
  covers the second.
- **Deleting a valid manual id.** The reconcile only runs on a successful,
  non-empty list for the current endpoint, and the field note names the id. A
  gateway with an incomplete list can still be typed by hand; a failed or empty
  answer does not touch it.
- **Count drift in AGENTS.** Update the `ai:unit` and `ai` numbers from the
  suites' own final lines, not by guessing.
- Rollback: revert the commit. No schema, command or file-format change, so a
  rollback needs no migration.

## Tests and validation

- `npm run build` — passed; the Row type and DOM typing compile.
- `npm run ai:unit` — 122/122; four of those are this plan's filter checks
  (order, case folding, trimming, no-match), beside the working tree's
  unsaved-buffer language checks, without the application.
- The AI mock suite — the model-picker section is all PASS, including
  `the Model field matches the other inputs' width (420 vs 420)` and
  `the picker spans the whole field (420/420)`, with a 194-check total currently
  at 191/194. The three failures are in the working tree's new
  `Translate without the wrapper` coverage: the extra Translate entry displaces
  `Key points` from the ten-entry History, which breaks the two assertions that
  look for it, and the existing Stop-delta timing check now fails as well. None
  of the three reaches the Model field, the picker, the reconcile or the Fetch
  button. They are recorded here rather than "fixed" inside this plan's scope.
  The model checks themselves are:
  the picker opens with every fetched id while the field holds a stale one (the
  reported bug), typing filters, ArrowDown+Enter and a click both choose, the
  field note appears after a reconcile and disappears on a choice, a failed or
  empty fetch keeps a typed id, the status counts once, and Fetch works on the
  first real click after typing.
- `npm run lint`, `npm run knip`, `npm run format:check` — `lint` and `knip`
  passed; the targeted Prettier check on every file this plan touched passed.
  The repository-wide `format:check` currently names `scripts/ai-live-test.mjs`,
  which is part of the working tree's concurrent AI work and was left untouched.
- **Deviation:** an installed MDraft window was open during the first
  `npm test -- --only ai`, so the single-instance plugin forwarded the staged
  launch to it and the harness saw exit code 0. The suite was run against a
  disposable build with `identifier: io.github.bernh.mdraft.aitest` and its own
  settings and WebView profile; both were deleted afterwards and the normal
  `src-tauri/target/release/mdraft.exe` was restored. The user's installed
  window was not closed or killed. A later `tauri build --no-bundle` for the
  last CSS tweak stopped at `src/main.ts(95,1): TS6192` — an unused import in
  the working tree's concurrent AI-language change — so that final release
  binary was not rebuilt; the source and `dist/` build themselves passed before
  that edit. The disposable build that ran the suite already contained the
  inset-caret geometry, which the 420-vs-420 checks pin.
- Manual: open Preferences › AI Assistant in light and dark, fetch from a local
  server, switch provider and fetch again; confirm the full list opens and the
  note explains a cleared id.

## Acceptance criteria

- With a model id from a previous endpoint still in the field, clicking the
  caret or pressing ArrowDown lists every model the last successful Fetch
  returned, without clearing the field first.
- Typing in the field filters that list; an exact id can still be typed and used
  on an endpoint with no model list.
- A successful non-empty Fetch that does not offer the saved id clears the field
  and prints a note under it naming the old id; a failed or empty Fetch leaves
  the id untouched.
- Saving a key (which fetches) never clears a model that the returned list
  contains.
- The status note reports one model count, not two.
- The native menu, the settings schema and the Rust command surface are
  unchanged.
- The model-picker checks in `npm run ai` and all of `npm run ai:unit` pass.
  The three unrelated working-tree checks noted under Tests and validation are
  outside this plan; the counts recorded in AGENTS match the script's total.

## Open questions

None. The default for a stale popup whose endpoint changed is to close and show
the empty state until the next successful fetch.
