# Document tabs

**Status:** done
**Date:** 2026-10-17
**ADR:** `../adr/2026-10-17-document-sessions.md`

## Context and goal

The window showed one document. Opening another replaced it, including its undo
history. Readers working across a Markdown note, a Typst source and an HTML file
had to close one to see the next.

## Scope and non-scope

Tabs for several open documents, one of them visible. Not two editors side by
side, not a saved tab list, not per-tab view mode or zoom, not a live HTML guest
for a hidden tab, not drag-reordering the strip.

## Approach and rejected alternatives

One session list and one `EditorView`. Each hidden tab keeps an `EditorState`.
The alternatives — a hidden view per tab, and a window per file — lost because
the preview scheme is one nonce and a second process collides on the WebView2
profile. Recorded in the ADR.

## Steps

- [x] `captureState` / `restoreState`, and a generation token on `setLanguage`
- [x] `src/sessions.ts`
- [x] Open, New, drop, recents and `open-files` add or focus a tab
- [x] Auto-save, the disk poll and window close walk the list
- [x] `.doc-tabs` row
- [x] Close, next and previous in the menu
- [x] Smoke, shortcuts, HTML guest, ADR, AGENTS.md, README

## Files and modules

`src/sessions.ts`, `src/editor.ts`, `src/main.ts`, `src/html-preview.ts`,
`index.html`, `src/styles.css`, `src/content.ts`, `src-tauri/src/menu.rs`, the
three UI scripts, the ADR, the README and AGENTS.md.

## Risks and rollback

`setState` restores chrome from the moment a tab was hidden; `displayDoc`
reapplies the global settings afterwards. `reset` and `dispose` bump the HTML
preview generation so a guest that is still building cannot mount after the
tab that started it has been left. Removing `src/sessions.ts` and the tab
strip returns the single-buffer shell. Nothing on disk changed format.

## Tests and validation

`npm run build`. `cargo check` for the menu. Smoke 92/92, HTML guest 42/42 and
shortcuts 39/39, each on a freshly launched window.

## Acceptance criteria

See the ADR. A path that is already open is focused, not read again. The HTML
guest exists only for the visible HTML tab.

## Open questions

None. Per-tab view mode and a persisted tab list stay out of scope.

## Audit follow-up

A later audit re-ran the suites and found one defect this plan's validation
missed. Switching away from a large document left its CodeMirror parse context
(`Language.state`) attached to the restored `EditorState`; the next text change
mapped that context's skipped ranges through a much smaller changeset and threw
`RangeError: Position 30262 is out of range for changeset of length 2532`.
`runMenuAction` turns a handler rejection into a toast, so the visible symptom was
"Ctrl+N does nothing" — no suite caught it because every fixture is small.
`editor.ts` now drops the grammar compartment before a buffer swap and after
`view.setState()`, and `displayDoc`/`showInEditor` reinstall it for the document on
screen. Verified by the suites (smoke 92, syntax 7, html 42, spellcheck 3,
shortcuts 39, close 4) and by two suites added for the gaps this plan left:
`scripts/document-tabs-test.mjs` (68 checks — sidebar click, recents focus,
`open-files`, caret and scroll per tab, dirty dot, close buttons, middle-click,
next/previous, the disk poll, Auto Save across tabs, last-tab replacement) and
`scripts/sessions-test.mjs` (43 checks of the store, with no application).

