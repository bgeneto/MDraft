# System fonts, a selectable Custom preset, and per-preset typography state

**Status:** done
**Date:** 2026-10-29
**ADR:** two, to be written with the implementation:
[`../adr/2026-10-29-system-font-enumeration.md`](../adr/2026-10-29-system-font-enumeration.md)
and
[`../adr/2026-10-29-preset-state.md`](../adr/2026-10-29-preset-state.md).
The second supersedes `2026-10-18-editor-font-size-per-preset.md` (and, through
it, `2026-10-17-preset-size-memory.md`) and amends the "Custom until a new preset
is chosen" consequence of `2026-10-18-typography-presets.md`.

## Context and goal

The Typography panel offers a hard-coded list of about twenty families:
`FONT_SUGGESTIONS` in `src/fonts.ts`. The screenshot in the report shows the
**Preview text** dropdown open: it contains the thirteen bundled families and a
short list of faces likely to be installed, and nothing else. A reader who owns
a font outside that list cannot select it, even though the webview can render
any installed family by name.

Two related behaviours make the panel worse:

1. **Custom is not a choice.** The pill appears only because `activePreset()`
   compares the live values with each preset's `values`; when a face, an
   OpenType switch or a hand edit no longer matches, the picker falls through to
   `"custom"`. The `set` handler then looks for a preset with that id, finds
   none, and returns, so clicking Custom does nothing. Editing any face of, say,
   Serif silently turns the panel into Custom.
2. **There is no per-preset place to keep an edited face or OpenType switch.**
   `presetOverrides` remembers only the four sizes. Faces and OpenType booleans
   are the preset's *identity*, so a change to either makes the preset stop
   matching. There is also no way back except choosing another preset and
   choosing the original again, which cannot restore a face the reader changed.

Goal:

- Every family the operating system's text engine exposes is offered in each of
  the four role pickers, searchable and with a specimen, alongside the bundled
  families.
- **Custom is a real, selectable preset.** It is based on System, is fully
  editable, and is remembered like the others.
- Editing a face, an OpenType switch or a size in **any** preset keeps that
  preset selected. A per-preset **Reset** restores its built-in values.
- Switching away and back restores each preset's own edits.
- An older `settings.json` keeps loading and rendering exactly as before.

The important simplification: MDraft already renders installed fonts correctly.
The System preset's `system-ui` and every curated suggestion are resolved by the
OS text stack through CSS `font-family`; nothing loads a font file. The missing
piece is **enumeration**, not font loading. That keeps this change out of the
CSP, the asset protocol, the export embedding path and the font-file parser.

## Scope and non-scope

**In scope**

- A Tauri command that returns the canonical family names installed on the
  machine, using the same native APIs the webview uses: DirectWrite on Windows,
  CoreText on macOS, fontconfig on Linux. It runs only when Typography is first
  shown, returns names only, and caches the successful result for the session.
- A searchable font picker for each role:
  - a trigger that looks like the current control and shows the selected family;
  - a popup with a search field, grouped Bundled / Installed entries, and each
    family name drawn in its own face;
  - keyboard navigation, ARIA roles, click-outside and Escape handling;
  - a warning entry for a saved family that is not installed, instead of
    silently showing a face that falls back.
- `CUSTOM_PRESET` in `src/fonts.ts`, always offered as the seventh pill. Its
  built-in values are the System preset's values, and its note says so.
- A persisted `typographyPreset` id and a widened `PresetOverride`:
  - `sourceFont`, `bodyFont`, `headingFont`, `codeFont`;
  - `editorFontSize`, `bodyFontSize`, `mathFontScale`, `codeFontScale`;
  - `ligaturesInCode`, `tabularFigures`, `oldstyleFigures`, `slashedZero`.
  Every field is optional; a missing field means "use this preset's built-in
  value", which is the existing contract for the four sizes. The top-level
  settings remain the active values every consumer already reads.
- Editing any typography field writes the top-level value and that preset's
  diff. Selecting a preset captures the outgoing preset's diffs, then applies
  the incoming preset's built-ins plus its own diffs. Reset removes the active
  preset's entry and applies its built-ins. Custom resets to System's values.
- A per-preset **Reset** row, disabled when the preset is already at its
  defaults, with a two-click confirmation so a custom setup is not lost by a
  stray click.
- CSS stack helpers that quote and parse family names safely, in a new pure
  module `src/font-stacks.ts`, with an app-free unit suite.
- Backward-compatible settings and Rust tests, plus UI tests for the picker,
  Custom, per-preset edits, round trips and Reset.
- Documentation, ADRs, test counts, and the code map entries for the new module
  and command.

**Non-scope**

- Loading an arbitrary font file from disk (a "Choose a font file…" button).
  The request is installed fonts; a file path raises its own questions about
  caching, persistence between machines and redistribution.
- Embedding a system font file in exported HTML. Exported documents name the
  family and use the stack's fallbacks; only the bundled OFL families are
  embedded as data URLs. A printed PDF embeds glyphs the same way the OS print
  path always has.
- Applying the typography to the sandboxed HTML guest, Typst Pages, pandoc
  exports, the AI Assistant panel or the editor chrome. Those boundaries are
  documented today and do not change.
- Per-document typography. The preferences remain global.
- A free-form text field for a whole CSS stack. The picker offers family names;
  a hand-edited stack stays visible and selectable.
- Replacing the bundled fonts, changing the preset families, or changing the
  font subsetting pipeline.
- Hot-reloading a font installed while MDraft is running. The list is read once
  per session; the panel says a restart is needed. On Windows, DirectWrite's
  collection is cached anyway.

## Approach and rejected alternatives

**Chosen: enumerate family names, let the OS/webview resolve them.**

A CSS stack already names a family; no `@font-face` is needed for a system
font. The command returns one canonical name per family id, not one per
localized alias, and the picker writes the usual
`"Chosen Family", <role fallback tail>` stack. The webview resolves the name
through DirectWrite, CoreText or fontconfig, so weights, italics, variable
axes, collections and fallback all behave exactly as they do for the current
curated names.

Enumeration uses `fontique` (Apache-2.0 OR MIT, MSRV 1.88, version 0.12), which
wraps the platform APIs instead of scanning font directories. Its
`Collection::new(CollectionOptions::default())` registers the system fonts;
`family_ids()` plus `family_name(id)` yields the canonical name per family and
avoids the localized aliases that `family_names()` also exposes. The command
runs on a blocking worker through `tauri::async_runtime::spawn_blocking`, so the
first scan (a few milliseconds warm, usefully under a second cold on a large
Linux font set) never blocks the UI. The successful list is cached behind a
`Mutex<Option<Vec<String>>>`; the frontend also caches it for the session, so
reopening Preferences costs nothing. An empty or failed scan is not cached, so
the next visit retries.

On Linux, `fontique`'s `fontconfig-dlopen` feature loads the system
`libfontconfig` at runtime through `dlib`, so `pkg-config` does not gain a new
build dependency; fontconfig is already a GTK dependency on every desktop where
the app runs. If the library is missing, fontique returns an empty collection
rather than aborting.

The picker uses the family name as its key and the full stack as the stored
value. A saved family that is no longer installed gets an explicit
`Family (not installed)` entry, with the saved stack kept so the fallback tail
still renders. The picker's own search is the place to find a font; the
Preferences global search deliberately does not index hundreds of family names,
or every query would match the Typography section.

**Preset state: a stored id plus per-field diffs.**

`typographyPreset` records the active id. An empty value is the migration case:
the frontend detects a matching built-in from the live values (the old
`activePreset` logic), or falls back to Custom. Once the reader edits or
switches, the id is written. `presetOverrides[id]` stores only fields that
differ from the preset's built-in values; setting a field back removes the key,
and an empty entry is removed entirely. That keeps future releases able to
change an untouched part of a preset while preserving the parts the reader
actually changed.

`Custom` is the seventh entry in the picker but not in `TYPOGRAPHY_PRESETS`:
detection only ever matches the six built-ins, so a fresh System setup cannot
be mistaken for Custom. Its built-in values and defaults are a copy of System's.
Selecting it the first time therefore starts from System; afterwards its diff
entry is restored. Reset on Custom removes that entry and returns to System.
This follows the reader's suggestion and gives Reset one consistent meaning on
every preset.

Selecting a preset captures the **outgoing** preset's live differences before
applying the incoming one. That also preserves a pre-existing hand-edited setup:
the first time its values do not match a built-in, the active id is detected as
Custom, and moving to a named preset stores the whole old setup under Custom.
It can be selected again; nothing is silently discarded.

**Rejected: `@font-face` with the system font file as a URL or data URL.**
Chromium can use only the first face of a TTC collection, many Windows and
macOS families ship as TTC, and each weight and italic is a separate file. It
would need a new asset protocol or CSP `font-src` entry, copy or serve font
bytes from arbitrary system paths, double memory for large families, and raise
redistribution questions for every installed font. It would also duplicate what
the webview already does correctly. Bundled WOFF2 keeps its current `@font-face`
path because those files are the application's own assets.

**Rejected: `fontdb` and directory scanning.** `fontdb` is small and pure Rust,
but it scans predefined folders and parses files rather than asking the OS. A
font installed in a non-standard but registered location, or one whose family
name differs from the parsed name table, would be missing. It is the documented
fallback if `fontique` ever becomes unusable, not the first choice.

**Rejected: `queryLocalFonts` (Local Font Access API).** It is Chromium-only,
requires a permission prompt, is absent from WKWebView and WebKitGTK, and
WebView2's permission surface is not something Tauri exposes reliably. It also
returns files rather than the family-name contract this change needs.

**Rejected: keeping the derived preset identity and adding only a Custom
button.** That leaves the core complaint: editing a face still silently leaves
the preset, and there is nowhere to remember the edit. It also cannot restore
the edited face after a round trip.

**Rejected: immutable named presets and a Custom-only editing surface.** It is
simpler but does not meet the request to edit each preset and reset it, and it
would force a reader who wants one change in Serif to rebuild the whole system
in Custom.

**Rejected: full snapshots per preset.** Storing every field on every edit
freezes built-in values that the reader never touched, so a later release could
not improve a preset without overwriting choices. Per-field diffs keep that
ability and match the existing `PresetOverride` shape.

**Rejected: separate native enumeration code per OS.** It is the same APIs
`fontique` already wraps, with three times the surface to test and maintain. If
the dependency is ever removed, the command boundary stays and only its
implementation changes.

**Rejected: `fc-list` / PowerShell / registry subprocesses.** They flash a
console window on Windows for every call, parse locale-dependent output, and
have no single cross-platform answer.

## Steps

- [x] Add `fontique = { version = "0.12", features = ["fontconfig-dlopen"] }`
      to `src-tauri/Cargo.toml`, with a comment naming the native backend per
      platform and why no font bytes are loaded.
- [x] Add `src-tauri/src/fonts.rs`: a `FontCatalog` cache, the async
      `system_fonts` command, a pure `normalize_families` function (trim, drop
      hidden `.`/`@` names, drop CSS generic keywords, drop control characters,
      cap length, case-insensitive dedupe, deterministic sort) and its tests.
- [x] Register the module, the managed cache and the command in
      `src-tauri/src/lib.rs`; add `systemFonts()` to `src/api.ts`.
- [x] Extend `PresetOverride` and add `typography_preset` in
      `src-tauri/src/settings.rs`, with the `Default` value, documentation and
      round-trip tests (old size-only entries keep loading; unknown fields are
      ignored by an older build).
- [x] Mirror both shapes in `src/api.ts` and document that `typographyPreset`
      is empty for a legacy file and that every override field is optional.
- [x] Add `CUSTOM_PRESET` and `PRESET_CHOICES` to `src/fonts.ts`; keep
      `TYPOGRAPHY_PRESETS` as the six detections and update the comments about
      "four sizes" to "faces, sizes and OpenType".
- [x] Add `src/font-stacks.ts` (`parseFamilies`, `firstFamily`, `cssFamily`,
      `stackWith`) and `scripts/typography-unit.mjs` for quoting, escapes,
      commas inside quoted names, generic keywords, tail rebuilding and
      duplicate removal.
- [x] Add `src/font-picker.ts`: the trigger, the body-level popup with a search
      field and grouped options, specimens in each option's own stack, ARIA and
      keyboard handling, a selected/missing option, and `closeFontPicker()` for
      panel redraws.
- [x] Add the picker and popup styles to `src/styles.css`, reusing the popup
      surface colours and scrollbar treatment already used by the model combo.
- [x] Rework the typography rows in `src/preferences.ts`:
      `presetId`/`presetById`/detect, capture/apply/reset helpers, the seven
      pills, the adjusted note, the two-click Reset row, the installed-font
      status note, and one `font` row per role.
      Lazily load the catalog in `renderContent` when Typography is shown, and
      close the font popup in `render()`/`close()` like `closeModelCombo()`.
- [x] Update the face-row section of `scripts/dom-smoke.mjs` for pickers instead
      of `<select>` controls, preserving its role order and the "Editor font
      size immediately above Source Editor" check.
- [x] Extend `scripts/typography-test.mjs` with the catalog, picker, Custom,
      per-preset edit, round-trip, Reset and persistence checks; keep the
      existing preset matrix and pixel checks.
- [x] Register `typography:unit` in `package.json` and `scripts/test-all.mjs`;
      update every check count in `AGENTS.md` after the suites report their real
      totals.
- [x] Update `docs/typography.md`, `README.md`, `AGENTS.md` (scripts, code map,
      counts, the preference recipe) and write the two ADRs; mark the old
      preset-size ADR superseded.
- [x] Validate: typecheck/build, Rust tests, the new unit suite, smoke,
      typography, export HTML/Print, and manual checks on Windows plus a Linux
      run. Record what could not be run (macOS).

## Files and modules

| File | Why it must change |
| --- | --- |
| `src-tauri/Cargo.toml` | The new `fontique` dependency and its Linux `dlopen` feature |
| `src-tauri/src/fonts.rs` | New: native family enumeration, cache, normalisation, tests |
| `src-tauri/src/lib.rs` | Module registration, managed cache, command table |
| `src-tauri/src/settings.rs` | Active preset id, widened per-preset diffs, defaults, tests |
| `src/api.ts` | Typed mirror of the settings and the `systemFonts()` wrapper |
| `src/fonts.ts` | `CUSTOM_PRESET`, `PRESET_CHOICES`, updated preset comments |
| `src/font-stacks.ts` | New: safe CSS family quoting/parsing and stack rebuilding |
| `src/font-picker.ts` | New: the searchable, specimen-bearing family picker |
| `src/preferences.ts` | The preset state machine, Custom pill, Reset, catalog load, four picker rows |
| `src/styles.css` | Trigger, popup, search, group, specimen and warning styling |
| `package.json` | The `typography:unit` script |
| `scripts/typography-unit.mjs` | New: app-free stack helper checks |
| `scripts/test-all.mjs` | Register the new unit layer |
| `scripts/dom-smoke.mjs` | Face rows are pickers, not selects |
| `scripts/typography-test.mjs` | End-to-end system fonts, Custom, per-preset edits, Reset |
| `scripts/export-browser-test.mjs` | Not changed: the system-family export assertion is deferred to the next export pass (open question 5) |
| `docs/typography.md` | User-facing picker, formats, Custom, Reset, export behaviour |
| `README.md` | Feature bullet: installed system fonts and editable presets |
| `AGENTS.md` | Scripts, test counts, code map, any trap found while implementing |
| `docs/adr/2026-10-29-system-font-enumeration.md` | The enumeration and no-font-bytes decision |
| `docs/adr/2026-10-29-preset-state.md` | The stored-id plus per-field-diff decision |
| `docs/adr/2026-10-18-editor-font-size-per-preset.md` | Status line: superseded by the new preset ADR |

## Risks and rollback

- **`fontique` behaves differently per platform.** DirectWrite, CoreText and
  fontconfig expose slightly different name sets; a localized or alias name may
  not resolve in the webview. Mitigation: use the canonical name per family id,
  keep the role's fallback tail behind every choice, show a "not installed"
  warning for a saved family the current list does not contain, and check one
  Latin, one CJK, one monospaced, one TTC and one variable family on each OS.
- **The first scan is slow on a large Linux font set.** It runs on a blocking
  worker only when Typography is opened; the panel shows the bundled and
  suggested faces with a "Looking…" note meanwhile. Measure the first open on
  the Linux test machine and record it.
- **A huge font collection makes a huge popup.** Only names are transferred,
  not files; names are capped at 256 characters and deduplicated. The list is
  scrollable and searchable with no rendered-option cap, because a cap would
  make some installed fonts unreachable.
- **A panel-wide redraw when the catalog arrives can disturb a field being
  edited.** The load starts on first display of Typography; the model combo's
  AI status refresh has the same shape. If it proves disruptive, refresh only
  the face rows instead of the whole panel.
- **Reset is destructive.** The two-click confirmation plus the disabled state
  on an unadjusted preset is the guard. No native dialog is used, so the UI
  suite can exercise it.
- **Settings compatibility.** All new fields are additive with serde defaults;
  an old file loads with an empty preset id and existing overrides. A downgrade
  ignores the new fields, still reads the top-level active values, and still
  reads the old size fields inside each override.
- **A pre-existing face-edited setup is labelled Custom**, as it is today. The
  first preset switch stores the whole old setup under Custom, so it is not
  lost; this is a behaviour improvement, not a migration guarantee for the
  original preset's name.
- **Exported HTML naming a system font falls back on another machine.** This is
  intentional and must be said in the panel and the documentation. Bundled
  families keep their current data-URL embedding; printed PDF embeds glyphs as
  before.
- **Windows hot-install does not appear until restart.** DirectWrite's shared
  collection is cached; the note says so rather than shipping a Reload button
  that appears to work and does not.
- Rollback: remove the `typographyPreset` and widened override fields (old
  builds ignore them), remove the picker rows and the command, and drop
  `fontique`. The top-level settings still hold the active values, so a
  settings file written by this version opens in the previous one with the
  current faces and sizes; only the per-preset memory of faces/OpenType is
  inert.

## Tests and validation

- **Rust unit:** `normalize_families` (hidden names, generic keywords, control
  characters, length cap, case-insensitive duplicates, sort); settings
  defaults; a size-only override from an old file; a full override round trip
  with faces/booleans; `typographyPreset` empty by default and preserved when
  present.
- **TypeScript build and quality:** `npm run build`, `npm run lint`,
  `npm run format:check`, `npm run knip`.
- **App-free stack suite (`npm run typography:unit`):** quoting a spaced name,
  escaping a quote and a backslash, leaving generic keywords unquoted, parsing
  the first family out of a quoted name containing a comma, rebuilding the tail
  from the preset's built-in stack, removing the chosen family from the tail,
  and keeping `stackWith` idempotent for the built-in family.
- **DOM smoke (real UI):** the four face rows are one picker each, with a
  selected label and at least ten choices; the existing per-preset size and
  default checks still pass; the Editor font size row remains directly above
  Source Editor.
- **Typography (real UI):**
  - the catalog note reports a non-zero number of installed families;
  - a system family from the Installed group appears, can be searched for, and
    selecting it changes the published `--font-*` variable and the preview's
    computed font family;
  - two different installed families render different pixels;
  - Custom is always a pill, can be selected, starts with System's faces, and
    keeps a face/OpenType/size edit across a round trip;
  - editing Serif's body face leaves Serif active, the note says "Adjusted",
    and switching to System and back restores the edited face;
  - Reset on Serif (two clicks) restores the built-in faces, sizes and OpenType
    values and clears the adjusted note; Reset on Custom returns to System's
    values;
  - `get_settings` after the panel settles reports `typographyPreset` and the
    expected `presetOverrides` entry;
  - a saved family that is not installed is labelled rather than silently
    showing the fallback.
- **Export (real UI):** set Preview text to an installed system family, export a
  native HTML document, and assert the file names the family and contains no
  `@font-face` data URL for it; the bundled-family export check keeps passing.
- **Manual:** Windows (host), Linux under WSLg, and macOS by the owner. Check a
  Latin family, a CJK family, a monospaced family, a TTC-only family and a
  variable family; confirm the editor, preview, typography preview, export and
  a printed PDF. Check that the panel documents the system-font export
  boundary and the restart note.
- The one measurement that proves the feature: a family that was absent from
  the old hard-coded list is selected from the picker, the published
  `font-family` variable starts with that name, and the rendered preview pixels
  change.

## Acceptance criteria

- Each of the four face pickers lists every installed family the OS text engine
  exposes, grouped with the bundled families, searchable by name, and each
  option shows its own face. The old hard-coded list is only a fallback for a
  failed scan.
- Selecting a system family changes the editor/preview/export stack, and the
  preview and a printed PDF render it; a family that is missing is labelled.
- Custom is always visible, selectable, starts from System, keeps its own full
  state, and can be reset to System.
- Editing a face, an OpenType option or a size in any preset keeps that preset
  selected; switching away and back restores the edit; Reset restores the
  built-in values for that preset only.
- A fresh installation still reports System; an older settings file loads with
  its current faces and sizes, and no value is silently discarded.
- Exported HTML names system families but does not embed their files; bundled
  families still embed exactly as before.
- The scan runs only when Typography is shown, makes no network request, and
  does not block the editor; a failed scan leaves the bundled and suggested
  faces usable with an explanation.
- TypeScript build/quality, Rust tests, the new unit suite, smoke, typography
  and the export check pass. Anything not run is named in the final report.

## Open questions

1. **Custom's first state.** The plan starts it from System, as the request
   describes. The alternative is to clone whichever preset is active the first
   time Custom is chosen. Default: System.
2. **Reset confirmation.** The plan uses a two-click confirmation with a
   four-second window. The alternative is an immediate reset because the button
   is already disabled on an unadjusted preset. Default: two clicks.
3. **Hot-installed fonts.** The plan caches the scan and documents a restart
   because DirectWrite's shared collection is cached on Windows. A Reload
   button would work on Linux/macOS but not reliably on Windows. Default: no
   button, restart note.
4. **Generic keywords in the picker.** Only the ones already in
   `FONT_SUGGESTIONS` (`system-ui`) stay selectable; the rest are represented by
   the role fallbacks. Default: keep it that way.
5. **The export assertion.** One check in `export-browser-test.mjs` is planned
   to lock "named, not embedded". If that suite's fixture interaction proves
   disproportionate, the documentation and the picker note remain, and the
   check moves to the next export pass.

## Implementation record

Implemented on 2026-10-29 as version **0.7.0**. The five open questions were
resolved with their defaults: Custom starts from System, Reset is a two-click
confirmation, there is no Reload button (the panel says a restart is needed),
generic keywords are represented by the role fallbacks plus the current choice,
and the export-browser assertion is deferred (the structural guarantee is that
`embeddedFontCss` only walks `BUNDLED_FAMILIES`; the panel and
`docs/typography.md` state the behaviour).

Measurements and validation actually run:

| Layer | Result |
| --- | --- |
| Windows Rust tests | 228 passed, 2 ignored (pandoc/Typst downloads) |
| Linux Rust tests (WSL cache) | 227 passed, 3 ignored (the two downloads and the display-owned print probe) |
| TypeScript build, lint, format, knip | pass |
| Rust Clippy, `--all-targets -D warnings` | pass |
| Typography stacks unit | 27/27 |
| DOM smoke | 114/114, including four picker rows and a 211-choice list |
| Typography | 60/60, against 197 installed Windows families |
| Missing-family warning | Manually checked with a hand-edited profile: the trigger read `No Such Font 987654 (not installed)` and the selected option's tag was `Not installed` |
| Linux compile | `cargo check` and the Rust library tests pass with `fontconfig-dlopen`; no new apt package. The UI suite is Windows-only because WebKitGTK has no CDP, so a manual Linux launch is still outstanding |
| macOS | Not run; the CoreText backend is the one manual check still outstanding |

Deviations and lessons:

- **System and Custom's built-in stacks are the role fallback stacks, not empty
  strings.** The first UI pass treated only `""` as "System default", so a
  freshly applied System preset displayed `system-ui` and the typography suite
  failed four expectations. The picker now treats a live stack equal to the role
  fallback as the same **System default** entry; a named preset's own stack is
  never mistaken for it. This is recorded in the preset ADR.
- **Focus and scroll were refined after the first passing suite.** Choosing a
  family returns focus to the rebuilt trigger, and opening the list scrolls the
  selected family into view. Both are covered by the same suite.
- **The new test initially had its `check` arguments reversed** (`check(label,
  condition)` instead of `check(condition, label)`), so it printed `PASS false`
  and the block returned a JSON string that the caller read as an object. It
  was corrected before the passing run; the suite now returns its object
  directly.
- **The disposable build was used because the installed MDraft was open.** Its
  identifier was `io.github.bernh.mdraft.fontstest`, and its settings/WebView
  profile were removed afterwards. `Copy-Item` failed once because the old test
  process had not exited and the single-instance plugin forwarded the new launch
  to it; the trap is recorded in `AGENTS.md`.
- **Installers were not staged.** `npm run dist` refuses while the reader's
  installed copy is running, so the release binary was rebuilt with
  `tauri build --no-bundle` under the ordinary identifier after the disposable
  copy and its profile were removed. The staged `bin/` artifacts remain a
  release-time action.
- **Counts changed:** Rust 223/222 → 228/227, typography 48 → 60, a new 27-check
  app-free layer, and the default `test-all` layer count 46 → 47. `AGENTS.md`,
  the README and the code map reflect them.

