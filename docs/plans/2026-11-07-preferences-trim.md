# Trim the Preferences panel: no obvious headings, no prose, folder buttons instead of paths

**Status:** done
**Date:** 2026-11-07
**ADR:** none — the only contract added is one `#[tauri::command]` whose shape is
fixed by this plan, and no responsibility moves.

## Context and goal

The Preferences panel has grown a layer of explanation that the controls beneath
it already carry:

- **Files** has a `Recent Locations` group heading over *Record Recent Files* and
  *Clear Recent Files*, a `Favorites` heading, and a `Managing Favorites` note
  that explains right-clicking and the `×` on each row.
- **Editor** has `Auto-close`, `Completion` and `Spelling` group headings over
  rows whose labels already say exactly that (`Auto-close brackets and quotes`,
  `Suggest completions while typing`, `Check spelling while typing`).
- **Export** prints absolute install paths for pandoc, Typst and the LaTeX
  engine, plus four paragraphs about what each tool is and which export route
  uses which. The reader cannot act on any of it, and the paths are long enough
  to dominate the section.
- **AI Assistant** opens with a `Privacy` paragraph about endpoints, credential
  stores and what leaves the machine — documentation, not a setting.
- **General** contains no setting at all: a version string, a note about which
  formatter library is used, three buttons that open documents already reachable
  from **Help**, and a note about where `settings.json` lives.

Afterwards the panel should read as a list of controls: a heading only where it
groups things the rows do not name, no paragraph a reader has to skim past, no
absolute path printed anywhere, and a button that opens each tool's folder in the
OS file manager instead.

The information that is genuinely needed stays: whether pandoc/Typst/the LaTeX
engine is installed, the LaTeX cache size and ceiling, and every existing
install/update/reinstall/clear button.

## Scope and non-scope

**In scope**

1. Remove the `Recent Locations` heading, the `Favorites` heading and the
   `Managing Favorites` note from **Files**.
2. Remove the `Auto-close`, `Completion` and `Spelling` headings from **Editor**.
3. Rewrite **Export**: a one-line status per tool with no path, one folder
   button per tool, the LaTeX cache size without its explanation, and the four
   paragraphs removed.
4. Remove the `Privacy` note from **AI Assistant** and shorten the four longest
   `?` help texts (Base URL, API Key, Disable reasoning, Context limit) to one
   sentence each, leaving the rest for the guide.
5. Remove the **General** section, and with it `PreferencesHost.version()` and
   `PreferencesHost.openDocumentation()`.
6. Add `open_app_folder(folder)` to the Rust side and its `src/api.ts` wrapper,
   used by the three folder buttons.
7. Update the suites that assert the removed text, and the two documents that
   name a removed heading.

**Non-scope**

- No setting is added, renamed, removed or migrated. `settings.json` is
  untouched, so an existing file keeps loading.
- No export behaviour changes. The pandoc/Typst/LaTeX install flows, the format
  editor, the after-export options and the LaTeX cache commands are unchanged.
- The AI Assistant's controls and defaults are unchanged; only visible prose and
  help length change.
- **Help › Font Licences**, **Help › Markdown Reference** and **Help › Keyboard
  Shortcuts** are unchanged. Only their duplicate route from Preferences goes.
- The `?` help mechanism stays. It is the place for an explanation, and it is
  not what the screenshots show as clutter.

## Approach and rejected alternatives

**Chosen.** Delete the rows and headings outright, and replace the three path
paragraphs with one button each. A new command `open_app_folder` takes a
whitelisted name (`"pandoc"`, `"typst"`, `"latex"`) rather than a path, resolves
it under `app_data_dir()`, creates it when it does not exist, and hands it to
`tauri_plugin_opener::open_path`. The whitelist matters: the frontend cannot
touch the filesystem, and a command taking an arbitrary path would hand it that
ability through the back door. Calling the plugin's free function from Rust means
no capability change — `opener:default` does not grant `open_path` to the
webview, and it does not need to.

**Rejected: keep a heading but make it smaller.** The complaint is that the
heading repeats the row beneath it. Styling it differently leaves the redundancy.

**Rejected: move the removed paragraphs into `?` tooltips.** A tooltip on
`Pandoc` would still be a paragraph about what pandoc is, which the reader
already knows if they are looking at an export setting. The guide and
`docs/export.md` already carry that material.

**Rejected: have the frontend build the folder path from a `get_settings`-style
command.** It would still need a command to open it, so the whitelist command is
strictly smaller and cannot be pointed anywhere else.

**Rejected: keep **General** with just the version.** The version is in **Help ›
About**, which is where a reader looks for it; a one-row section is worse than no
section.

## Steps

- [x] `src/preferences.ts`: drop the `Recent Locations`, `Favorites`,
  `Auto-close`, `Completion` and `Spelling` headings and the `Managing Favorites`
  note; delete the `general` section object.
- [x] `src/preferences.ts`: rewrite `exportRows` — status lines without paths,
  `Open … folder` buttons, cache size without prose, no `HTML and PDF` note, no
  LaTeX explanation paragraph.
- [x] `src/preferences.ts`: remove `version()` and `openDocumentation()` from
  `PreferencesHost`; update the `filterSection` comment that names
  `Recent Locations`.
- [x] `src/preferences.ts`: remove the `Privacy` row from `aiRows` and shorten
  the four long help strings.
- [x] `src-tauri/src/documents.rs`: add `open_app_folder`, with a unit test for
  the whitelist (a rejected name must not resolve).
- [x] `src-tauri/src/lib.rs`: register `documents::open_app_folder`.
- [x] `src/api.ts`: add `openAppFolder(folder)`.
- [x] `src/main.ts`: drop the `version`/`openDocumentation` host wiring; add the
  `openAppFolder` wiring with a toast on failure.
- [x] `scripts/dom-smoke.mjs`: section count 11 → 10 and the new name order;
  replace the `locations`/`managing` search probes with terms that still exist;
  add one check per removed heading so it cannot come back.
- [x] `scripts/favorites-test.mjs`: invert the `Managing Favorites` assertion.
- [x] `scripts/licence-test.mjs`: open the licence document through
  `help.licences` instead of the removed Preferences button.
- [x] `scripts/ai-assistant-test.mjs`: assert the `Privacy` row is gone.
- [x] `docs/latex.md`: `Preferences › Editor › Completion` → the row's own label;
  mention the folder button beside the cache paragraph.
- [x] `docs/guide.md`: one sentence in **Export** naming the folder buttons.
- [x] `AGENTS.md`: correct the check counts for `smoke`, `favorites` and
  `licence` in the two tables that quote them.

### Deviations recorded during implementation

- **A Typst status line was added.** The plan's open question settled on keeping
  one status line per tool; the Typst row had prose but no status, so
  `PreferencesHost.typstStatus()` was added beside `pandocStatus()`. It reads the
  `typstCache` `main.ts` already maintained.
- **The search probes changed twice.** `latex` was tried as the heading probe and
  matched Editor as well, because the completion help text mentions LaTeX.
  `preferred image syntax` is unique to Image, so that is what the check uses.
- **`scripts/export-test.mjs` was added to the change.** The plan listed it only
  under "tests and validation"; two checks were added there (no install path is
  printed, and each tool has a folder button), so the file is part of the patch.
- **Counts:** smoke 114 → 116, export 73 → 75, AI 323 → 324. `favorites` and
  `licence` stayed at 56 and 4 because the assertions were inverted, not added.

## Files and modules

| File | Why it must change |
| --- | --- |
| `src/preferences.ts` | Every removed row, heading and note lives here, and it declares `PreferencesHost` |
| `src/main.ts` | It implements the two removed host methods and must supply the new one |
| `src/api.ts` | Typed wrapper for the new command, next to `openExternal` |
| `src-tauri/src/documents.rs` | The new command, beside `open_external`, which already opens folders |
| `src-tauri/src/lib.rs` | Command registration |
| `scripts/dom-smoke.mjs` | Owns the section inventory, the row inventory and the search probes |
| `scripts/favorites-test.mjs` | Asserts the removed note exists |
| `scripts/licence-test.mjs` | Reaches the licence document through the removed button |
| `scripts/ai-assistant-test.mjs` | Owns the AI section's row inventory |
| `docs/latex.md`, `docs/guide.md` | Name a heading and a route that change |
| `AGENTS.md` | Quotes the check counts, which are a contract |

## Risks and rollback

- **A reader loses a shortcut.** Three documents were reachable from Preferences
  and are still in **Help**; the licence suite is changed to prove the Help route
  works, so this cannot ship broken silently.
- **A folder button that does nothing.** `open_path` fails on a missing
  directory, so the command creates it first; a failure surfaces as a toast, not
  a silent no-op. The `latex` folder always exists once the engine was enabled.
- **The AI help text loses information a reader relied on.** The same material is
  in `docs/guide.md` § AI Assistant and `docs/export.md`; the shortened strings
  keep the one fact that changes an action (a key is optional for local servers,
  a refused reasoning field makes Generate fail).
- **Rollback:** revert the branch. No settings schema, file format or persisted
  value changes, so a reverted build reads the same `settings.json`.

## Tests and validation

| Layer | Command | What proves it |
| --- | --- | --- |
| Typecheck | `npm run build` | The removed host methods have no remaining caller |
| Rust unit | `npm run test:rust` | `open_app_folder` rejects an unknown name and resolves the three known ones |
| DOM smoke | `npm run smoke` | 10 sections, the removed headings absent, the folder buttons present |
| Favorites | `npm run favorites` | The `Managing Favorites` note is gone and the panel still works |
| Licence | `npm run licence` | The licences are still reachable, now through Help |
| AI Assistant | `npm run ai` | The `Privacy` row is gone; every control still works |
| LaTeX preview | `npm run latex:preview` | The Export section still reaches the engine switch |
| Quality gates | `npm run format:check`, `npm run lint`, `npm run knip` | Formatting, and no unused export left behind by the removals |

The measurement that matters is visual: open Preferences at each section and
confirm no paragraph is longer than a row, and no absolute path is printed.

## Acceptance criteria

1. **Files** shows *On Launch*, *Default File Extension*, *Auto Save*, *Record
   Recent Files*, *Clear Recent Files* — with no `Recent Locations` heading, no
   `Favorites` heading and no `Managing Favorites` note.
2. **Editor** shows *Convert Rich Text on Paste*, the two auto-close rows, the
   completion row, the layout rows and the two spelling rows, with no
   `Auto-close`, `Completion` or `Spelling` heading.
3. **Export** prints no filesystem path. Each of pandoc, Typst and LaTeX has one
   folder button that opens the corresponding directory in Explorer/Finder/the
   file manager, and the existing install/update/clear buttons remain.
4. **Export › LaTeX** still shows the cache size and the ceiling, without the
   sentence about least-recently-used eviction.
5. **AI Assistant** has no `Privacy` row, and its longest `?` help text is one
   sentence.
6. The section list is `Files, Editor, Image, Markdown, HTML, Export, Appearance,
   Typography, AI Assistant, Read Aloud`; **General** is gone.
7. **Help › Font Licences** still opens the licence document, and the licence
   suite proves it.
8. `npm run build`, `npm run test:rust`, `npm run smoke`, `npm run favorites`,
   `npm run licence` and `npm run ai` pass with the corrected counts.

## Open questions

- **Should the folder button appear when the tool is not installed?** Default:
  yes, and the command creates the folder, so the reader can see where MDraft
  would put it. The alternative is to hide it until the tool is found.
- **Is the one-line status (`Pandoc 3.12.1`, `Typst not found.`) wanted, or
  should the button label carry it alone?** Default: keep the line, because
  "installed" versus "not installed" is the fact that decides whether an export
  is available, and the button label only implies it.
