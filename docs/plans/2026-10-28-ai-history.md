# AI Assistant: a session history of the last ten answers

**Status:** done
**Date:** 2026-10-28
**ADR:** `../adr/2026-10-28-ai-history-retention.md` (created on approval)

## Context and goal

The AI Assistant keeps a result only in its open panel. Applying an answer calls
`close()`, and opening another action replaces the panel state, so the question,
the captured context and the answer are gone. The Ask conversation survives only
while its panel is open. A reader who replaces a passage or inserts a block can
no longer re-read, copy or re-insert what the model returned.

The goal is a small, deliberately scoped **History** for the assistant: the last
ten successful requests of the current session, each with the action, parameter,
question, captured context, model/endpoint, document name, time and full answer.
History must be reachable from the palette, readable as a list and as a detail
view, and never become a second source of document edits. The reader can copy an
old answer or insert it below the current paragraph. Regenerate replaces the
same history entry instead of adding another one, because it is the same request
asked again.

History is **memory-only**. It is lost when MDraft closes, and it is never
written to `settings.json`, the recovery journal or any other file. This keeps
the existing privacy model: document excerpts and model answers do not persist
on disk.

## Scope and non-scope

**In scope**

- A `History` command in the palette footer, in the slot now occupied by
  `Reset button position`.
- A non-modal history popover with a list of at most ten successful requests,
  newest first, and a detail view for one entry.
- Recording every successful answer from the fourteen actions, with one entry
  per Ask exchange. Stopped, failed and empty responses are not recorded.
- Regenerate and Retry reuse the same entry id; a successful regenerate
  overwrites that entry (content and timestamp) without increasing the count.
- Detail actions: **Copy** and **Insert below** the current paragraph. No
  Replace: the original selection is not available and a stale answer must not
  overwrite unrelated text.
- **Clear history** at the list footer, plus an empty state that says history
  lives only for this session.
- Moving **Reset position** to Preferences › AI Assistant, so a button dragged
  into an awkward corner is still recoverable without cluttering the palette.
- Keyboard behaviour: arrow keys move through the list, Enter opens, Escape
  returns from detail or closes the list, and focus returns to the button.
- Unit and mock-UI coverage, documentation counts and an ADR for the retention
  decision.

**Non-scope**

- No disk persistence, settings field, recovery-journal field or database.
- No cross-launch or cross-window history.
- No history search, pinning, renaming or per-entry deletion. Ten entries are
  small enough that Clear history is the only maintenance control.
- No re-running an old Ask conversation with its original turns. History stores
  the question and answer for reading, not a resumable conversation.
- No Replace from history, and no automatic re-application of an old answer.
- No new native menu item or keyboard shortcut. History is reached through the
  existing palette.
- No Rust command, API contract or settings-schema change.

## Approach and rejected alternatives

Use a small in-memory store in `src/ai/history.ts` and a third popover inside the
existing `ai-assistant` root. The palette footer becomes **History** on the left
and **AI Assistant Settings…** on the right. History opens as a 440 px popover,
using the same `placePopover` geometry as the palette and panel, so it follows
the floating button and stays inside the source pane. The list shows action and
parameter, a one-line request summary, a one-line answer preview and the time.
Selecting a row opens a detail view in the same popover: question (for Ask),
collapsible exact context, rendered answer and a footer with Copy and Insert
below. A back arrow returns to the list.

Each successful request gets a stable entry id when the request starts. Initial
requests and Ask exchanges create an id; Regenerate and Retry keep it; changing
a parameter starts a new id. On `done`, only when the response is not stopped and
has non-whitespace text, the entry is inserted or replaced by id. The store
keeps the newest ten and drops the oldest. The detail view renders Markdown with
the existing `chatHtml` helper, so the same DOMPurify rules and link stripping
already used by Ask apply there too.

Rejected alternatives:

- **Persist the history in `settings.json` or a separate JSON file.** Rejected by
  the reader for this change: document excerpts and answers would be written in
  plain text, settings would grow by hundreds of kilobytes, and the settings
  schema would have to carry a UI cache. The existing in-memory Ask history and
  button position already establish a session-only precedent.
- **Reuse the Ask chat bubbles as the history model.** That history is
  conversation-scoped, exists only for Ask, and is cleared by New conversation.
  It cannot recover an Improve/Translate answer after the panel closes.
- **An accordion list where each row expands in place.** Cheaper to build, but a
  long answer makes the list unreadable and the row that was open scrolls away.
  A list plus a detail view gives the answer the full width and keeps one clear
  back path.
- **A modal overlay or a second window.** Both would interrupt writing and
  contradict the assistant's non-modal design. The popover stays attached to the
  button.
- **Append on Regenerate and rely on the ten-entry cap.** The cap would hide the
  duplicate only after ten requests, and the history would contain two answers
  for one request. The requirement is explicit: regenerate overwrites.
- **Store failed and stopped requests.** Rejected by the reader. A partial answer
  is still visible in the panel with Copy; only completed answers are history.
- **Remove Reset entirely.** Rejected by the reader: the button is session-only
  and can be dragged off its corner, so recovery belongs in Preferences.
- **History entries with Replace.** Rejected: the captured range belongs to a
  past revision, and replacing current text from an old answer is a silent
  document edit. Insert below is additive and undoable.

## Steps

- [x] **1. Add the pure history store.** Create `src/ai/history.ts` with
  `MAX_AI_HISTORY = 10`, the `AiHistoryEntry` shape, `rememberRequest` (insert
  newest first, replace by id in place, slice to the cap), `historyTitle`
  (action label plus tone/language/markup parameter), `previewText` (collapse
  whitespace, one-line ellipsis) and `formatHistoryAge` (Just now, N min ago,
  N h ago, date). It imports only types and the pure action catalog, so
  `scripts/ai-unit.mjs` can run it under Node.
- [x] **2. Add the history popover markup and state.** In `src/ai/assistant.ts`,
  add list and detail views inside a `.ai-history.ai-popover`, with a header
  (back button in detail, title, count chip, close), a scrollable list or detail
  body, and a footer. Keep the markup out of the existing panel so panel state
  and tests are unaffected. Use unique classes for the history close/back
  buttons.
- [x] **3. Record successes.** Add `entryId`, `requestContext` and
  `historyEntries` state. Create an id per request/exchange, keep it across
  Retry/Regenerate, and reset it when the parameter changes. On `done`, when the
  response is not stopped and has text, build an entry from the current action,
  parameter, question, context summary/preview, model/host, document name and
  answer, then call `rememberRequest`. Never record on error or stop.
- [x] **4. Render the list and detail.** List: action title plus parameter, time,
  request summary (quoted question for Ask, context summary otherwise), document
  name and answer preview. Detail: question block for Ask, context `<details>`,
  rendered Markdown answer, truncated badge, notes for Improve, and Copy /
  Insert below. Clear history and the empty state live in the list footer.
- [x] **5. Wire interaction and focus.** History opens from the palette footer,
  closes the palette/panel, uses `placePopover(history, PANEL_WIDTH)`, closes on
  outside click or Escape, and is included in `close()`, `sync()`,
  `onViewMode()` and `isOpen()`. Arrow Up/Down move through rows, Enter opens,
  Escape goes back from detail, and closing returns focus to the floating
  button. Insert below uses `blockInsertion` on the current paragraph, applies
  through `host.apply`, closes history, focuses the editor and toasts; Copy
  keeps the view open.
- [x] **6. Remove Reset from the palette and add it to Preferences.** Delete the
  palette reset command and its handler. Add `resetPosition()` to
  `AssistantHandle`, `resetAssistantPosition()` to `PreferencesHost`, and an AI
  section `button` row `Floating button` → `Reset position`. In `src/main.ts`,
  supply `documentName: () => doc.name` and a reset callback that also toasts.
  Update the Privacy note to say the last ten successful answers stay in memory
  for this session only.
- [x] **7. Style the history screen.** Add list rows, icons, titles, times,
  one-line summaries and previews, empty state, detail meta, question block,
  rendered answer and badges. Reuse the existing 8 px discreet scrollbar for the
  list, detail body and answer; extend every scrollbar selector group. Keep the
  popover inside the pane at every zoom and pane width.
- [x] **8. Extend the unit suite.** Assert newest-first insertion, the ten-entry
  cap, replacement by id without increasing the count or moving the row, title
  parameter labels, preview collapsing/ellipsis and the age thresholds.
- [x] **9. Extend the mock UI suite.** Check the palette now offers History and
  no Reset; an empty state before the first answer; the Reset row in Preferences
  returns the dragged button to 20 px; Regenerate re-requests without adding a
  history row; after ten successful requests the list is capped, keeps the
  oldest and contains no stopped Expand; the detail shows the Ask question,
  rendered Markdown, context, Copy and Insert below; back returns to the list;
  Insert below changes the buffer and one undo restores it; Clear history leaves
  the empty state. Keep the suite's own isolated identifier and cleanup.
- [x] **10. Verify and document.** Run the build, unit suite, mock suite and the
  frontend quality gates. Capture the list and detail in light and dark themes
  and inspect them. Update `AGENTS.md` counts/descriptions, the README assistant
  paragraph and the old AI plan's footer note; write the ADR; leave the plan at
  `done` with measured counts and any deviations.

## Files and modules

| File | Why it must change |
| --- | --- |
| `src/ai/history.ts` | New pure store, entry shape, title/preview/age helpers; testable without the app. |
| `src/ai/assistant.ts` | History popover, record-on-success, stable entry ids, list/detail rendering, keyboard/focus, reset removal, `resetPosition()`. |
| `src/main.ts` | Supply `documentName` and the Preferences reset callback that calls the assistant. |
| `src/preferences.ts` | Add the Reset position button row and update the Privacy note. |
| `src/styles.css` | History list/detail/empty/badge styling and the discreet scrollbar groups. |
| `scripts/ai-unit.mjs` | Cap, replace-by-id, titles, previews and ages. |
| `scripts/ai-assistant-test.mjs` | History UI, regenerate overwrite, success-only recording, Preferences reset, insert/undo, clear. |
| `AGENTS.md` | New counts and descriptions for the AI unit/mock layers, plus the test-table rows. |
| `README.md` | One sentence describing the session-only history. |
| `docs/plans/2026-10-28-ai-assistant.md` | Note that the palette footer/Reset description is superseded by this plan. |
| `docs/plans/2026-10-28-ai-history.md` | This plan, updated with measured counts and status. |
| `docs/adr/2026-10-28-ai-history-retention.md` | Durable decision: successful-only, ten entries, memory-only, no disk. |

No Rust, `src/api.ts`, `package.json`, menu, capability or settings-schema change.

## Risks and rollback

- **A duplicate on Regenerate** would be invisible until the cap hides one of the
  two entries. The mock suite counts rows after a regenerate before the list is
  full; the unit suite asserts replace-by-id.
- **A successful answer recorded against the wrong action/document** if an old
  channel delivers after another action opens. Reset `requestId` when a panel
  opens, guard the completion callback by id, and keep the entry id in the same
  closure as the request.
- **Memory growth.** Ten answers are capped at 32,000 characters each, plus
  captured context; the worst case is under a megabyte. No persistence and no
  unbounded list.
- **Markdown injection in the detail view.** Use `chatHtml` (marked + DOMPurify,
  links stripped) exactly as Ask does; assert rendered `<strong>` and no live
  `href`.
- **Popover off-screen or over the status bar.** Reuse `placePopover`, which
  clamps to the pane and re-places on resize; assert the history box stays inside
  the editor pane.
- **Focus loss after re-render/clear.** The list is rebuilt on every action;
  explicitly focus the first row, the back button, or the close button, and
  restore the floating button when the history closes.
- **Reset moved away from the palette.** If the Preferences callback is null
  before the assistant exists, optional-chain it; the row is still clickable and
  the next drag is unchanged. The mock suite proves the anchor after reset.
- **Rollback.** Remove the new module and markup, restore the palette reset
  command, revert the four touched frontend files, tests and docs. No data
  migration is needed because nothing is persisted.

## Tests and validation

Layers, cheapest first:

1. `npm run build` — TypeScript and the Vite bundle.
2. `npm run ai:unit` — pure store, titles, previews, ages; measured 114/114,
   twenty-one checks above the previous 93.
3. `npm test -- --only ai` or the same suite against an isolated test identifier —
   the mock endpoint suite; measured 155/155, forty-one checks above the previous
   114. The final harness run with a fresh build also reported 155/155. The
   panel's Markdown result later added six checks (lists, a table and the Source
   view), taking the suite to 161/161. The resizable panel added twelve more
   (the grip, corner anchoring, keyboard nudges, session layout, History sharing
   that layout and both reset routes), for 173/173.
4. `npm run lint`, `npm run format:check`, `npm run knip` — the frontend gates.
5. Manual visual check: with ten entries, open the list and a detail in light
   and dark themes; confirm the popover stays inside the pane, the list scrolls
   with the 8 px bar, long answers scroll inside the detail, and Escape/back and
   outside-click behave. The mock suite also measures the pane containment and
   the 8 px gutter.
6. A fresh launch after a session confirms the history is empty (session-only)
   and that `settings.json` gained no history field.

The measurement that proves the core requirement is the mock suite's row count
before and after Regenerate: the request count increases, the history count does
not, and the same row's answer is still present.

### Deviations recorded during implementation

- The unit suite landed at 114 checks rather than the estimated 102; the extra
  checks pin the cap, the in-place replacement, the title forms and the age
  thresholds individually.
- The mock suite landed at 155 rather than the estimated 132, adding the empty
  state, list geometry/scrollbar, keyboard navigation, Ask detail, Insert below
  plus undo, Clear and the post-Clear Regenerate proof.
- The suite reaches eleven successful answers before the History section, so the
  cap evicts the first Improve answer. The checks therefore assert that the
  oldest surviving row is Continue writing and that exactly one Improve remains,
  rather than expecting both. This is the cap working, not a lost entry.
- The held stale-target response ends after twelve characters, so that entry's
  answer is the partial `Imp`; the Insert-below check uses the full Ask answer
  instead. The held request is a fixture for the stale guard, not a History
  failure.
- The History close/back buttons use unique classes rather than the panel's
  `.ai-close`, so the existing panel tests keep selecting the panel's own close
  button.
- `recordHistory` runs even when the panel is hidden by the palette or History,
  so opening another surface mid-request no longer loses a completed answer.
  `close()` still cancels and clears the request id, so a discarded request is
  not recorded.

## Acceptance criteria

1. The palette footer reads **History** and **AI Assistant Settings…**; Reset is
   no longer there.
2. A successful answer appears in History without another request; the list is
   newest first and never exceeds ten entries.
3. Regenerate sends another request, keeps the list count unchanged and updates
   the same entry; Retry behaves the same after an error.
4. Stopped, failed and empty responses leave no history entry.
5. The list row shows the action and parameter, time, document name, a request
   summary (question for Ask, context for other actions) and an answer preview.
6. The detail shows the full answer as sanitized Markdown, the Ask question, the
   captured context, the model/host and the truncated badge when applicable.
7. Copy places the raw answer on the clipboard; Insert below adds it after the
   current paragraph, closes the view and is undone by one Ctrl/Cmd+Z.
8. Clear history empties the list and shows the session-only empty state; closing
   and reopening MDraft also starts empty.
9. History stays inside the editor pane at the default and a narrow width, uses
   the discreet 8 px scrollbar, and is operable by keyboard (arrows, Enter,
   Escape, back).
10. Preferences › AI Assistant offers **Reset position**, and using it returns
    the dragged button to 20 px from the right and bottom.
11. No file, setting, recovery entry or native contract is written; Rust tests
    and the settings schema are unchanged.
12. `npm run build`, `npm run ai:unit`, the mock AI suite, lint, format and knip
    pass, with the measured counts recorded in `AGENTS.md`.

## Open questions

None. The reader answered the four decisions before this plan:

- session-only, not persisted;
- Copy and Insert below, no Replace or history Regenerate;
- only successful answers, with Ask recorded per exchange;
- Reset position moves to Preferences, keeping palette History in its slot.

If an answer arrives that changes one of these, update this section and the plan
before implementation.
