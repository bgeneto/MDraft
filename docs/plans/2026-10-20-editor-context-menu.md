# A complete editor context menu, with Format Document on tabs

**Status:** done
**Date:** 2026-10-20
**ADR:** `../adr/2026-10-20-editor-context-menu.md`

## Context and goal

`src/format/menu.ts` installed a `contextmenu` listener on `document` and, for
Markdown, HTML and Typst, called `event.preventDefault()` and opened a menu with
exactly one item, **Format Document**. That silently removed the webview's own
Cut, Copy, Paste, Delete and Select All entries. A right-click in the source pane
now shows one command, which is worse than the native menu it replaced.

The goal is one themed editor context menu that owns the whole surface: the
clipboard and selection commands a reader expects, case conversion, comments,
line operations, undo/redo and **Format Document**. The formatting item stays
disabled with a reason for AsciiDoc and read-only documents rather than making
the menu disappear. The same **Format Document** entry is added to a tab's
context menu and formats the document that was clicked, whether or not that tab
is on screen.

Spelling must keep its own menu: `src/spellcheck.ts` already calls
`preventDefault()` and `stopPropagation()` on `view.dom` when a misspelled word
is under the pointer, so the document-level editor menu never sees that click.

## Scope and non-scope

In scope:

- An editor source-pane context menu for Markdown, HTML, Typst and AsciiDoc,
  with keyboard navigation and disabled-state explanations.
- Undo/Redo, Cut/Copy/Paste/Delete/Select All, UPPERCASE/lowercase/Title Case,
  Toggle Single Line Comment, Duplicate Line, Move Line Up/Down and
  Format Document.
- A tab context-menu **Format Document** that works on the clicked tab,
  including an inactive tab, without changing which tab is active.
- A reliable text clipboard path. The webview Clipboard API is tried first for
  rich data; the official Tauri clipboard plugin is the fallback for plain text.
- Updating the CDP suite, README, AGENTS.md and the code map.

Out of scope:

- A context menu in the preview, sidebar or tab strip. The tab strip already has
  its own menu; the preview keeps the webview's native copy/select menu.
- Rich HTML or image clipboard data when the webview denies `clipboard.read()`.
  Ctrl+V continues to carry those through the existing paste pipeline; the menu
  can do so only when the web API grants access.
- Formatting AsciiDoc, Format Selection, or a formatter worker.
- New native menu entries or accelerators. The existing Edit menu and its
  predefined clipboard items are unchanged.
- Case conversion with an empty selection. Those items are disabled and say
  "Select some text first." rather than guessing a word or line.

## Approach and rejected alternatives

**Approach.** Add `src/context-menu.ts` and delete `src/format/menu.ts`. The new
module owns only the editor right-click surface: it builds the menu from the
current `EditorState`, uses the CodeMirror commands already in
`@codemirror/commands` (`undo`, `redo`, `selectAll`, `toggleComment`,
`copyLineDown`, `moveLineUp`, `moveLineDown`), and delegates the one action that
needs the shell's document lifecycle — formatting — through a callback. The
spelling plugin's `stopPropagation()` still wins, so its menu is untouched.

`src/main.ts` gains `formatSession(id)`, shared by the editor menu and the tab
menu. For the active tab it calls the existing `formatEditor(view, language)`;
for an inactive tab it formats the stored `session.editorState.doc` and applies
`formattedTransaction(state, formatted)` to that state. The stored `EditorState`
is compared by identity after the `await`; if the tab was activated, edited or
formatted meanwhile, the result is discarded as stale. Formatting an inactive
tab sets `session.dirty`, redraws the tab strip and leaves the active tab alone.

The menu is opened on `contextmenu`, on the editor content or gutter, only when
the event was not already handled. If the click is outside the current
selection, the caret moves to the click point first, so Paste lands where the
reader pointed. The menu closes on Escape, Tab, an outside press, a scroll,
resize or window blur; arrow/Home/End navigation follows the tab menu's existing
keyboard model.

Clipboard text goes through `src/clipboard.ts`:

1. `navigator.clipboard.writeText` when it exists, because it is the web
   platform's own path and a CDP test can replace it.
2. The official `@tauri-apps/plugin-clipboard-manager` `writeText`/`readText`
   when the web API is unavailable or denied. WebView2 gates clipboard reads
   behind a permission the application has no UI to request, so the plugin is
   the reliable path, not a convenience.
3. A toast when both fail.

Paste also prefers `navigator.clipboard.read()` so HTML and images survive when
the platform grants it. The resulting `DataTransfer` is dispatched as a
`ClipboardEvent("paste")` on `view.contentDOM`, which reuses the existing rich
paste and image pipeline instead of adding a second conversion path.

Comment toggling uses `toggleComment`, which uses line tokens where the language
has them and wraps selected lines in block tokens otherwise. Markdown and HTML
therefore get `<!-- … -->` on a single line; Typst and AsciiDoc get `// `. Typst
currently exposes no `commentTokens` language data, so
`src/typst-language.ts` adds `{ line: "//", block: { open: "/*", close: "*/" } }`
to the support it already loads.

`src/tabs.ts` gains a `format` callback and a `formatBlocked` callback. The entry
is disabled with the shell's reason (read-only, AsciiDoc, already formatting) and
formats in place. The tab menu's existing `choose()` focuses the clicked tab; it
must not activate the document just to format it.

Rejected alternatives:

- **Keep the native menu and add Format Document as a native item.** A native
  menu cannot merge with the spelling suggestions or the themed DOM menus, and
  the editor state needed to format is in the webview. It would also make the
  menu platform-dependent.
- **Do not intercept `contextmenu` at all.** That restores Cut/Copy/Paste but
  removes Format Document from the right-click menu, which is the feature that
  already shipped.
- **`navigator.clipboard` only.** `readText()` is permission-gated in WebView2;
  a Paste item that silently does nothing is a dead control. The official plugin
  is small and is the supported desktop path.
- **A third-party context-menu package.** The menu is DOM plus six CodeMirror
  commands; a dependency would not provide the format/tab integration or the
  spelling-menu interaction.
- **Format a tab by activating it first.** That changes the reader's active
  document and preview for a command they aimed at the strip. The stored
  `EditorState` is enough; activating is not.
- **Format Selection.** Prettier's range support is unreliable outside
  JavaScript/TypeScript and Typst's range formatting would give one language a
  different menu shape. The previous format plan already rejected it.

## Steps

- [x] 1. Add `@tauri-apps/plugin-clipboard-manager` to `package.json` and
      `tauri-plugin-clipboard-manager` to `src-tauri/Cargo.toml`; register the
      plugin in `src-tauri/src/lib.rs`; allow `clipboard-manager:allow-read-text`
      and `clipboard-manager:allow-write-text` in
      `src-tauri/capabilities/default.json`; update both lockfiles.
- [x] 2. Add `src/clipboard.ts` with `writeClipboardText(text)` and
      `readClipboardData()`; try the web API first, then the plugin, and return
      `null`/`false` on failure.
- [x] 3. Export `hasFormatter(language)` and `formattedTransaction(state, text)`
      from `src/format/formatters.ts`; keep `formatEditor` using the same
      caret/undo rule.
- [x] 4. Add `src/context-menu.ts` with the menu layout, commands, disabled
      reasons, placement, dismissal, keyboard navigation and the
      click-to-caret rule. Remove `src/format/menu.ts`.
- [x] 5. Add `commentTokens` for Typst in `src/typst-language.ts`.
- [x] 6. Add `formatSession(id)` and `formatUnavailableReason(session)` to
      `src/main.ts`; install the editor menu with those callbacks; pass
      `format`/`formatBlocked` to `installTabs()`.
- [x] 7. Add the `format`/`formatBlocked` callbacks, the **Format Document**
      entry and an optional disabled title to `src/tabs.ts`.
- [x] 8. Add `.editor-menu` styles to `src/styles.css` and remove the old
      `.format-menu` rules.
- [x] 9. Extend `scripts/format-document-test.mjs`: menu order and disabled
      states, case conversion, comment toggle, line operations, clipboard
      round-trip through a fake `navigator.clipboard`, AsciiDoc menu with
      Format disabled, tab-menu background formatting, and the existing format,
      undo, spelling and failure checks. Update `scripts/document-tabs-test.mjs`
      only if its tab-menu assertions need the new entry.
- [x] 10. Run `npm run build`, `npm run lint`, `npm run knip`,
      `npm run format:check`, `npm run format:document`, `npm run tabs`,
      `npm run spellcheck`, `npm run smoke`, and `npm run test:rust`.
- [x] 11. Build with `npm run dist` and record the staged executable/installer
      size delta from the clipboard plugin.
- [x] 12. Write `docs/adr/2026-10-20-editor-context-menu.md`, mark the menu
      ownership sentence in `docs/adr/2026-10-20-webview-formatters.md` as
      superseded, and update README.md, AGENTS.md (scripts, tests, code map and
      the regression trap) and this plan's status/deviations.

## Files and modules

- `package.json`, `package-lock.json` — the clipboard plugin's JavaScript API.
- `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` — the clipboard plugin's Rust
  side.
- `src-tauri/src/lib.rs` — register `tauri_plugin_clipboard_manager`.
- `src-tauri/capabilities/default.json` — read/write text permissions. Without
  them the plugin rejects every call and the menu looks broken.
- `src/clipboard.ts` — web API first, plugin fallback, booleans/null instead of
  leaking rejected promises to the menu.
- `src/context-menu.ts` — the editor's whole right-click menu.
- `src/format/menu.ts` — deleted; its formatting orchestration moves to
  `main.ts` and its one item becomes one action of the new menu.
- `src/format/formatters.ts` — `hasFormatter`, `formattedTransaction`; no
  formatter options change.
- `src/main.ts` — format-session lifecycle, menu installation, tab callbacks.
- `src/tabs.ts` — the tab **Format Document** entry and its disabled reason.
- `src/typst-language.ts` — Typst comment tokens.
- `src/styles.css` — `.editor-menu` styles; `.format-menu` removed.
- `scripts/format-document-test.mjs` — updated selectors and new checks.
- `scripts/document-tabs-test.mjs` — only if the tab-menu assertions need it.
- `README.md`, `AGENTS.md` — feature description, test counts, code map, trap.
- `docs/adr/2026-10-20-editor-context-menu.md`,
  `docs/adr/2026-10-20-webview-formatters.md` — the ownership decision and its
  supersession.
- `docs/plans/2026-10-20-editor-context-menu.md` — this file.

No settings key, `#[tauri::command]` name, `src/api.ts` wrapper, menu event,
accelerator or `settings.json` shape changes. The clipboard plugin adds commands
under its own plugin namespace; `default.json` gains permissions only.

## Risks and rollback

- **The clipboard plugin is not allowed by the capability set.** Every menu
  clipboard action falls back to the web API and then toasts. `npm run
  format:document` exercises the fake web API; manual Copy/Paste on Windows is
  the proof for the plugin. Rollback: remove the plugin and the two permissions;
  the menu still works where the web API is granted.
- **The real OS clipboard cannot be tested from the agent session.** The sandbox
  denies clipboard ownership, so the suite replaces `navigator.clipboard` and
  tests the menu's read/write wiring, not the operating system. Say so in the
  report; do not read a failing real-clipboard check as an application bug.
- **Formatting a background tab races a tab switch.** The stored state identity
  is checked after the formatter resolves, and the result is dropped if the tab
  became active or its state changed. The CDP suite formats an inactive tab and
  then activates it.
- **The menu becomes too tall on a small window.** It has `max-height` and
  scrolls; placement flips above the pointer when the bottom edge is close.
- **A new right-click menu hides the webview's one again.** The regression trap
  is recorded in AGENTS.md: a listener that calls `preventDefault()` owns the
  whole menu, so it must carry the clipboard commands.
- **The clipboard plugin grows the binary.** Measured in step 11. If the growth
  is unacceptable, the fallback is the web API alone plus a clear toast; that is
  a smaller but less reliable feature.

Rollback: revert the branch. The plugin is not persisted in settings, and no
existing file format changes.

## Tests and validation

Cheapest layers first:

1. `npm run build` — the new module, plugin import and callbacks typecheck.
2. `npm run lint`, `npm run knip`, `npm run format:check`.
3. `npm run format:document` against a freshly built app:
   - the editor menu appears with the expected labels and separators; with no
     selection Cut/Copy/Delete/case items are disabled, Paste/Select All and
     Format are enabled; with a selection the edit items become enabled;
   - UPPERCASE, lowercase and Title Case change exactly the selected text and
     one undo restores it;
   - Toggle Single Line Comment wraps a Markdown/HTML line in `<!-- -->` and
     prefixes a Typst/AsciiDoc line with `// `;
   - Duplicate Line, Move Line Up and Move Line Down change the buffer and undo;
   - Copy then Paste round-trips through a fake `navigator.clipboard`; Cut
     copies and deletes; Delete removes the selection;
   - right-clicking AsciiDoc opens the menu with Format disabled and the reason
     in its title; the other editing actions still work;
   - the preview still opens no editor menu, and a misspelled word still opens
     the spelling menu instead;
   - the tab menu's **Format Document** formats an inactive Markdown tab, marks
     it dirty, leaves the active tab alone, and one undo on the activated tab
     restores the original bytes after saving.
4. `npm run tabs`, `npm run spellcheck`, `npm run smoke` — regressions,
   especially the tab menu's focus and the spelling menu's priority.
5. `npm run test:rust` or `npm run test:rust` via `test-all.mjs` — the plugin
   builds and the existing Rust suite is unaffected.
6. `npm run dist` once; record the staged binary and installer size against the
   0.4.3 files.
7. Manual Windows clipboard check: select text, Copy, Paste into the same
   document; Cut; Paste. Manual Linux launch (CDP is unavailable there) to
   confirm the menu lays out and the plugin's text read/write works under
   WebKitGTK.

The measurement that proves the regression is gone is the menu's item list plus
the fake-clipboard round-trip, not the existence of a `.editor-menu` element.
The measurement that proves tab formatting is background-safe is the active-tab
name before and after the action and the saved bytes after undo.

## Deviations and measurements

- Implemented as planned. `npm test -- --only format-document` passes **80/80**
  checks, up from 42. The suite now covers the menu order and disabled states,
  three case conversions, Markdown and Typst comments, duplicate/move, a
  fake-clipboard Copy/Cut/Paste round trip, Delete, Select All, the tab menu
  formatting a background tab, AsciiDoc with Format disabled, and the existing
  formatter, undo, spelling and failure checks.
- `npm test -- --only tabs` passes 104/104, `npm test -- --only spellcheck`
  passes 3/3, and `npm test -- --only rust` passes 91 with 2 ignored.
- `npm run build`, `npm run lint`, `npm run knip` and `npm run format:check`
  pass.
- `smoke` passes 105/105 after aligning `scripts/dom-smoke.mjs` and
  `docs/typography.md` with the Serif math scale of **88**, which is the value
  `src/fonts.ts` already carried.
- The real operating-system clipboard cannot be driven from the agent session
  (see the clipboard trap in `AGENTS.md`). The suite replaces
  `navigator.clipboard` with an in-page fake and proves the menu's read/write
  wiring and the synthetic paste path; the Tauri plugin path still needs a
  manual Copy/Cut/Paste on a desktop session.
- Staged artefacts after `npm run dist`, against the 0.4.3 numbers recorded by
  the previous format plan:

  | Artefact | Before | After | Delta |
  | --- | ---: | ---: | ---: |
  | Portable `.exe` | 14,773,248 B | 15,101,440 B | +328,192 B (+320.5 KiB) |
  | NSIS setup | 9,228,543 B | 9,335,155 B | +106,612 B (+104.1 KiB) |
  | MSI | 10,514,432 B | 10,653,696 B | +139,264 B (+136.0 KiB) |

  The delta includes the clipboard plugin's `arboard`/image dependency chain and
  the working tree's unrelated typography edit. It is not attributed to the
  clipboard alone.

## Acceptance criteria

- Right-clicking the source editor shows one themed menu containing, in order,
  Undo, Redo, Cut, Copy, Paste, Delete, Select All, UPPERCASE, lowercase,
  Title Case, Toggle Single Line Comment, Duplicate Line, Move Line Up,
  Move Line Down and Format Document.
- Cut, Copy, Paste, Delete and Select All work from that menu; the shortcut
  hints name the platform's keys.
- Cut/Copy/Delete/case items are disabled without a selection and explain why;
  read-only documents keep the menu but disable every modifying action.
- Format Document is enabled for Markdown, HTML and Typst, and disabled with a
  reason for AsciiDoc, read-only documents and a format already in progress.
- A misspelled word still opens the spelling menu, and the preview, sidebar and
  non-editor surfaces never open the editor menu.
- A tab's context menu offers Format Document; it formats the clicked tab,
  including an inactive one, without switching to it, and one undo restores the
  original after switching to that tab.
- `README.md`, `AGENTS.md`, the ADR and this plan describe the menu, the plugin,
  the test count and the regression trap.
- The build, lint, knip, format check, the new suite and the named regressions
  pass; the clipboard plugin's size delta is measured, not assumed.

## Open questions

- **Should case conversion apply to the word under the caret when nothing is
  selected?** Default: no. Disabled with "Select some text first." is the
  predictable behavior; a word guess can surprise.
- **Should Delete remove the line when the selection is empty?** Default: no.
  That is what Delete Line would be; the menu does not add a second line command
  beyond Duplicate and Move.
- **Should the tab menu activate the tab before formatting?** Default: no. The
  stored `EditorState` is formatted in place; activating is a separate action.
- **Should the clipboard plugin be added at all, or should Paste be web-API
  only?** Default: add it. A context menu Paste that depends on a WebView2
  permission the app cannot request would be a dead control.
- **Should the menu also appear in the preview?** Default: no. The preview's
  native menu is the correct place for copying rendered content; the editor menu
  acts on source.
