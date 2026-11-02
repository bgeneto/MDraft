# Document Statistics dialog and Preferences in File

**Status:** done
**Date:** 2026-11-02
**ADR:** `../adr/2026-11-02-preferences-in-file-menu.md`

## Context and goal

The status bar already reports the active buffer's words, characters and lines,
and it shows an estimated token count after typing pauses. There is no single
place to read the complete set, and the only selection breakdown is the cursor
chip. At the same time, Windows and Linux place **Preferences…** under **Tools**.
That is unusual: most desktop editors put it in **File** (VS Code) or in the
macOS application menu; Tools is otherwise about proofing and external programs.

The goal is to add **Tools › Document Statistics…**, opening a read-only themed
modal with the document's counts, and to move **Preferences…** to **File** on
Windows and Linux. The macOS application menu keeps Preferences, as platform
convention requires. Command ids and accelerators stay unchanged.

The dialog order is deliberate: **Tokens sits directly below Words**, followed
by Lines, Document length and the selection line.

## Scope and non-scope

**In scope**

- A new `tools.statistics` menu item and its frontend route.
- A modal dialog with these rows:
  - Characters (without line endings)
  - Words
  - Tokens
  - Lines
  - Document length (UTF-8 bytes)
  - Selection: selected characters, UTF-8 bytes and range count, only while the
    editor has a non-empty selection.
- Moving `file.preferences` from Tools to File on Windows and Linux. macOS keeps
  the existing application-menu item.
- Menu tests, documentation and an ADR recording the Preferences placement.

**Non-scope**

- Live-updating statistics while the dialog is open. It is a snapshot taken by
  the menu action.
- Reading time, paragraph or sentence counts, and per-selection token counts.
- Changing the status-bar tooltip or the existing token estimator.
- A Copy button, file metadata, or save/export actions inside the dialog.
- Duplicating Preferences in the macOS File menu.
- Any change to the Preferences panel itself.
- The reading-time tooltip part of GAP-023 remains open.

## Approach and rejected alternatives

**Chosen approach**

- **Menu.** In `src-tauri/src/menu.rs`, add `tools.statistics` after
  **Spelling Language…** in the first Tools group. Move the existing
  `file.preferences` item from the Tools tail to the File tail on non-macOS,
  separated from Close Tabs and immediately before Quit. The macOS application
  menu keeps its own `file.preferences` item. `enabled_for` returns `true` for
  `tools.statistics` so a menu-state sync never disables it.
- **Dialog.** A new `src/statistics-dialog.ts` creates a native
  `<dialog class="stats-dialog">` on demand and removes it on close, following
  the existing `unsaved-dialog.ts` pattern. It uses a `<dl>` with one row per
  statistic, a single **Close** button, Escape and backdrop dismissal, focus
  restoration to the previously focused element, and a `keydown` listener that
  stops the editor's handlers. `runMenuAction` also refuses to run a menu
  command while the statistics dialog is open, exactly as it already does for
  the unsaved-changes dialog.
- **Data.** `src/main.ts` builds a plain snapshot from the editor:
  - characters, words and lines from `editor.metrics()`, which is maintained
    incrementally on every change;
  - selection characters/ranges from `editor.view.state.selection.ranges`;
  - selection bytes from the selected text;
  - document length from `session.size` when the saved buffer is clean (exact
    disk bytes, O(1)), otherwise UTF-8 bytes of the buffer plus the document's
    CRLF and BOM overhead;
  - tokens from the existing `api.countTokens()` command, shown as
    "Estimating…" until the promise settles and "Unavailable" on failure.

  The dialog receives only numbers and strings, so it has no dependency on the
  editor or the Tauri API. Numbers use `Intl.NumberFormat`, matching the status
  bar, and CSS gives them tabular figures.

**Rejected alternatives**

- **Native `plugin-dialog` message.** It is OS-styled, cannot show a two-column
  layout or tabular numbers, is not themed with the editor, and makes the text
  harder to select. The screenshot and the existing unsaved dialog both call for
  an in-app modal.
- **A new Rust statistics command.** It would change the public command
  contract, duplicate the word/line caches the editor already maintains, and
  grow the Rust side for numbers JavaScript can read in O(1). The only O(n) work
  that must stay in Rust is the token estimator, which already exists.
- **Using `editor.metrics().chars` as Document length.** That counts UTF-16 code
  units of the normalized buffer, not UTF-8 bytes, and it excludes CRLF and BOM
  overhead, so it would contradict the "Characters" row.
- **Live updates.** A read-only snapshot is what a menu action promises; a live
  listener would add continuous work and a second source of truth for counts
  that already update in the status bar.
- **Reading time and paragraph counts.** Not in the requested minimum, their
  definitions vary by markup language, and they would add another full pass.
  They remain future work under GAP-023.

**Performance and binary size**

- Words, lines and characters are O(1) reads from the existing incremental cache.
- Document length costs one O(n) UTF-8 pass only when the buffer is dirty or
  untitled. A clean saved document uses `session.size`, so opening the dialog is
  O(1) for the document length.
- Tokens use the existing scan (about 4.6 ms/MB according to `src-tauri/src/tokens.rs`),
  the same cost the status bar already pays after a typing pause. The dialog
  opens immediately and fills that row when the answer arrives; no typing is
  blocked.
- Selection byte counts touch only the selected ranges.
- No new npm or Cargo dependency, no asset, no new command, no settings field.
  The frontend grows by one small module and a block of CSS (a few KB before
  gzip); the Rust binary grows only by the new menu label.

## Steps

- [x] `src-tauri/src/menu.rs`: add `tools.statistics` to Tools, move
  `file.preferences` to File on non-macOS, add the new id to `enabled_for`, and
  add a unit assertion for its availability.
- [x] Add `src/statistics-dialog.ts` with the snapshot type, row builder,
  Close/Escape/backdrop handling and focus restoration.
- [x] Add the `stats-dialog` styles to `src/styles.css`.
- [x] Wire `tools.statistics` in `src/main.ts`, gather the snapshot and token
  promise, import the module, and extend the `runMenuAction` modal guard.
- [x] Extend `scripts/menu-test.mjs`: Preferences parent/label/route, Statistics
  parent/label/route, dialog title and row order (Tokens below Words), values
  against the editor, the selection line, Escape closure and focus return; then
  update the printed check count.
- [x] Update `README.md` and `docs/guide.md` with the new command and the new
  Preferences location.
- [x] Update `AGENTS.md` menu-test counts, description and code map.
- [x] Write `docs/adr/2026-11-02-preferences-in-file-menu.md` and add a
  "Superseded in part by" pointer to the menu-information-architecture ADR.
- [x] Run the validation layers below and record the results here.

## Files and modules

| File | Why it must change |
| --- | --- |
| `src-tauri/src/menu.rs` | Adds the new Tools row, moves Preferences to File, and keeps `enabled_for` in agreement. |
| `src/main.ts` | Owns the menu route, the snapshot gathering and the modal guard. |
| `src/statistics-dialog.ts` | New presentation module for the snapshot dialog. |
| `src/styles.css` | The dialog's layout, themed surface, tabular numbers and responsive width. |
| `scripts/menu-test.mjs` | Proves the new menu route, the moved Preferences row and the dialog contents. |
| `AGENTS.md` | The menu suite count, its description and the code map. |
| `README.md`, `docs/guide.md` | User-facing documentation for both changes. |
| `docs/adr/2026-11-02-preferences-in-file-menu.md` | Records the durable menu-placement decision. |
| `docs/adr/2026-10-25-menu-information-architecture.md` | Points at the new ADR that supersedes one sentence of it. |
| `docs/plans/2026-11-02-document-statistics.md` | This record. |

## Risks and rollback

- **Character semantics.** Status-bar "characters" are UTF-16 code units. The
  dialog labels them as characters without line endings and labels the byte row
  separately, so the two numbers cannot be mistaken for each other.
- **CRLF and BOM.** A dirty CRLF document and a BOM file must add their overhead
  to the computed byte length or the "Document length" row will differ from a
  save. Clean saved files avoid the issue by using `session.size`. The menu test
  should cover at least one selection and the clean fixture; a manual CRLF/BOM
  check is recorded in validation.
- **Stale `session.size`.** It is only used when the session is clean; a dirty
  buffer always recomputes.
- **Modal keyboard leakage.** The window-level accelerator handler runs in the
  capture phase, before the dialog's own listener, so the `runMenuAction` guard
  is required; stopping propagation alone is not enough.
- **Menu test and documentation drift.** The check count appears in more than
  one place in `AGENTS.md`; update every occurrence after the suite prints the
  final number.
- **macOS.** The File menu must not gain a duplicate Preferences row; only the
  non-macOS block moves.
- **Rollback.** Revert the menu rows and the new module; no settings or file
  format changes are involved, so a checkout of the previous revision is enough.

## Tests and validation

- `npm run build` — typecheck and frontend bundle.
- `cargo check` / `npm run test:rust` through `scripts\cargo-vcvars.cmd` — menu
  availability unit test. On this host cargo must use the MSVC wrapper.
- `npm run menu` against `samples/feature-tour.md` — the native menu inventory
  and the new dialog route. The suite's count will rise from 105; the final
  number is recorded in `AGENTS.md`.
- `npm run shortcut` — proves the accelerator registry is unchanged and
  `Ctrl+,` still opens Preferences after the move.
- `npm run format:check`, `npm run lint`, `npm run knip`.
- `npm run smoke` if the dialog styles touch shared tokens; otherwise the menu
  suite is the cheaper layer.
- The one measurement that proves the feature: with `feature-tour.md` open, the
  dialog's Words, Lines and Characters equal the status bar's values for the
  same buffer, Tokens is directly below Words, selecting a range shows one
  selection line with the right character and byte counts, and Escape returns
  focus to the editor.

**Results**

- The plan's three-file threshold held and every step was implemented as written,
  with one deviation: the statistics dialog's focus restoration gained an
  optional editor fallback. The menu suite exposed it after Preferences had been
  opened and closed, when `document.activeElement` was `<body>`; a hidden
  Preferences control produced the same dead focus. The shell now passes
  `() => editor.focus()`, and body/documentElement are not treated as
  restorable.
- `npm run build` passed (typecheck plus Vite bundle).
- `.\scripts\cargo-vcvars.cmd check --manifest-path src-tauri\Cargo.toml` passed.
- `.\scripts\cargo-vcvars.cmd test --manifest-path src-tauri\Cargo.toml menu::`
  passed 13/13.
- `npm run lint` and `npm run knip` passed.
- `npm run format:check` passed for the whole tree.
- `npm run menu` passed **121/121** on a disposable build with its own
  identifier (the installed MDraft window was open, so the normal harness would
  have forwarded to it). The new checks cover Preferences in File, the
  statistics row order with Tokens below Words, the counts against the status
  bar, the selection line, the modal menu guard and Escape/focus restoration.
- A CRLF+BOM probe confirmed the byte calculation: a 27-byte saved file showed
  `Document length 27` while clean, and 28 after inserting one ASCII character
  into the dirty buffer.
- Dark and light screenshots of the dialog were inspected; both use the theme
  tokens, tabular figures and the intended row order.

## Acceptance criteria

- **Tools** shows **Document Statistics…** and no **Preferences…** on Windows
  and Linux; **File** shows **Preferences…** with `Ctrl+,`, and it opens the
  settings panel. The macOS application menu still owns Preferences and the
  File menu does not duplicate it.
- **Document Statistics…** opens a themed modal titled "Document Statistics"
  with rows in this order: Characters (without line endings), Words, Tokens,
  Lines, Document length (UTF-8 bytes).
- Words, Lines and Characters match the status bar for the active buffer.
- Document length matches the saved file size for a clean saved document and
  accounts for CRLF/BOM when the buffer is dirty; it is labelled as UTF-8 bytes.
- A non-empty selection adds one line with the selected character count, UTF-8
  byte count and range count. No empty selection line is shown.
- Escape, **Close** and a backdrop click close the dialog; focus returns to the
  editor; menu accelerators do not run behind the modal.
- No new dependency, asset, Rust command or settings field is added; the menu
  suite, typecheck and Rust check pass with the updated counts.

## Open questions

- **Document length label.** Default is "Document length (UTF-8 bytes)" because
  the bare label invites a comparison with the character count. If the reader
  prefers the screenshot's shorter label, the byte meaning can move to a note.
- **Selection row when empty.** Default is to hide it; showing "None" would keep
  the layout fixed but adds a line that says nothing.
- **Copy button.** Default is no. It would need clipboard-failure handling for a
  panel whose only job is to be read.
- **Accelerator for Document Statistics.** Default is none; no new accelerator
  is introduced by this change.
- **Reading time and paragraph count.** Default is out of scope; they remain
  candidates under GAP-023.
