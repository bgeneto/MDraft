# Simplify LaTeX Preferences around one local packages folder

**Status:** done
**Date:** 2026-11-11
**Approval:** User approved implementation on 2026-11-11; re-read sources after
the intervening pull (HEAD `b64a27e`) before editing.
**ADR:** [2026-11-11-latex-local-folder-default.md](../adr/2026-11-11-latex-local-folder-default.md).

## Context and goal

Preferences > LaTeX makes configuring local packages look like managing a
collection of installations. Every registered folder generates a separate
checkbox, format selector, and five full-width action rows. The personal folder
also has a global Open button that calls the same action as its per-folder Open
button. Empty labels leave isolated help icons in the left column. Explanatory
paragraphs push the settings farther down the page.

There is no compiler-level distinction between a personal library and an
external library: both supply captured package files to either backend. The
special kind currently controls path resolution, creation, and a forced TDS
layout. `local-texmf` in the screenshot is an external folder's basename, not a
different package feature.

The user should be able to open Preferences, find the folder used for custom
packages, open it or choose another folder, and select its layout. The standard
folder must already exist. Routine configuration must not require creating,
adding, checking, ordering, or removing a library.

## Scope and non-scope

In scope:

- One primary local-packages setting shared by bundled and installed engines.
- Automatic creation of `app_config_dir()/texmf/tex/latex/local`, without
  overwriting existing files, downloading assets, or enabling a compiler.
- The same folder terminology and compact controls for default and chosen
  locations; no visible "personal folder" category.
- Both existing layouts, automatic inspection, concise actionable errors, and
  preservation of existing registrations.
- Remove the Search order, Getting started, and Trust and network prose rows.
  Keep explanatory material in `docs/latex.md`.
- Compact the installed-engine actions and show discovery results only when
  relevant; preserve its actual enable/validate/discover behavior.

Out of scope: compiler search precedence, capture/sandbox rules, WSL execution,
engine downloads, package caches, dependencies, installers, other Preferences
sections, and relocating or copying the user's package files.

## Approach and rejected alternatives

### Normal view

Keep the application UI in English. The local packages block will read:

```text
Local packages

Use local packages    [x]
Folder                …/texmf/tex/latex/local
                      [Open]  [Choose folder…]
Layout                [Folder of packages                 v]
                      3 packages, 1 class
```

`Layout` offers `Folder of packages` and `TEXMF tree`. Use the existing help
mechanism for one short layout example if needed; do not add floating question
marks beside blank labels. The path is selectable and wraps within the panel.
Open is the only file-manager action for the primary folder. Choosing another
location replaces the primary registration atomically after inspection; cancel
or failure leaves the current configuration intact.

For new profiles, use the standard `texmf/tex/latex/local` directory with the
packages layout. For the standard hierarchy in TDS mode, the registered root is
`texmf`; both the displayed path and Open must use that root. This is the same
package hierarchy, not a second library. Chosen external directories always use
the displayed directory as the root for the selected layout. Changing layouts
never moves files. Existing personal TDS registrations keep their `texmf` root,
including bibliography and font directories outside `tex/latex/local`.

Create the standard hierarchy during per-user application initialization,
including upgrades and portable builds, before Preferences or compilation needs
it. This provides a ready folder without relying on a machine-wide installer to
know each user's profile. Resolve through Tauri's config directory at runtime.
A creation failure must leave the editor usable and produce a local setting
error when relevant. It must not cause a startup network request or popup.

Initialize a new profile's primary registration once. Preserve existing enabled
flags and intentionally empty lists; initialization must not re-enable a folder
the reader has disabled or removed. Use an additive initialization marker if
needed; missing fields in old settings must remain loadable.

### Existing multiple folders

Preserve every existing root, its layout, enabled state, and search order. The
first registered root becomes the primary control. Only when additional roots
already exist, show a collapsed `Additional folders (N)` disclosure. Expanding
it shows compact rows with path, enabled state, layout, and a per-row overflow
menu for ordering/removal. Do not repeat full-width Open/Check/Move/Remove
buttons. Do not silently merge directories or discard registrations. Fresh
profiles have neither this disclosure nor an Add folder action.

Inspection runs when the section opens or the folder/layout changes. Recheck on
return to the app after editing files externally. Expose Retry only when a check
fails; it is not a permanent full-width Check again button. Reuse the current
compile freshness checks and bounded indexing rather than polling the filesystem
continuously.

### Rest of the LaTeX page

Retain auto-compile and the two existing engine groups. Replace the installed
distribution's stacked Find/Browse/Validate actions with one wrapping action
row. Keep validation available for a selected installation and discovery/WSL
results conditional on the corresponding action. Shorten labels and help that
describe implementation rather than the user's task. Cache controls remain
available and distinct from the custom-packages folder.

Rejected alternatives:

- CSS-only compression: preserves duplicate concepts and actions.
- A new global engine selector: expands into compilation-backend behavior the
  user did not request.
- An empty default directory without registration: the folder would exist but
  its packages would still not compile.
- Copy all libraries into the default directory: risks collisions and breaks
  existing package maintenance workflows.
- Delete additional roots during migration: changes document output and loses
  configuration without the reader choosing to do so.
- A new general Preferences framework: unnecessary; add only the focused folder
  control and inline/disclosure rendering needed by this page.

## Steps

- [x] Implement idempotent standard-folder initialization and compatible primary
  configuration, preserving existing roots and handling failed writes.
- [x] Add atomic primary-folder replacement and allow both standard layouts;
  retain existing command variants for compatibility.
- [x] Replace the generated TEXMF button stack with the compact folder control
  and conditional legacy-folders disclosure.
- [x] Wire automatic inspection, busy/error states, cancel-safe selection, and
  focus restoration; remove redundant create/check/open handlers from the UI.
- [x] Remove explanatory paragraphs and compact the installed-engine actions.
- [x] Update regression checks and exercise actual compilation with both layouts
  and existing multiple-root configurations.
- [x] Inspect the real page at normal and narrow widths; record screenshots and
  verify keyboard operation before marking complete.
- [x] Update documentation and the focused ADR; record any qualifying traps and
  finish this plan with validation results and deviations.

## Files and modules

- `src/latex-texmf-preferences.ts`: primary-folder view, status, legacy disclosure.
- `src/preferences.ts`: focused row rendering, inline actions, search and focus;
  remove LaTeX prose rows and compact installed-engine actions.
- `src/styles.css`: compact folder/actions/disclosure layout and narrow widths.
- `src/main.ts`: folder selection/replacement and inspection lifecycle.
- `src/api.ts`: additive typed configure action if required by atomic replacement.
- `src-tauri/src/latex_texmf.rs`: default resolution, creation, replacement,
  layout support, compatibility and unit tests.
- `src-tauri/src/settings.rs`: per-user initialization and an additive marker
  only if needed to distinguish first setup from intentional removal; unit tests.
- `scripts/latex-texmf-test.mjs`: real UI/default/layout/replacement/migration
  behavior and compilation assertions; reuse existing fixtures and runner.
- `scripts/dom-smoke.mjs`: Preferences search, action-group and prose regressions.
- `docs/latex.md`: new configuration flow; retain technical material here.
- `README.md`: follow the renamed Local packages section.
- `docs/agent-guide/traps/test-harness.md` and its index: record the cold engine
  setup deadline and the false initial diagnosis.
- `docs/agent-guide/catalog/latex-and-formats.md`: updated existing test coverage.
- `docs/adr/2026-11-11-latex-local-folder-default.md`: focused decision after
  approval; link the superseded portions from the previous ADR.
- This plan: progress, deviations and validation results.

## Risks and rollback

The highest risk is changing which files an existing project resolves. Preserve
root order and layout; do not convert an existing TEXMF root into only its local
subdirectory. Test disabled and empty configurations, external directories,
spaces/non-ASCII paths, and portable config paths. Failed replacement must leave
the old registration active. Error states must not block the whole editor.

Roll back the code change while retaining the backwards-readable list and
additive marker. No rollback step deletes or moves a package directory.

## Tests and validation

Run the relevant layers in repository order: `npm run build`, Rust tests through
`scripts/cargo-vcvars.cmd`, `npm run latex:texmf:unit`, then the isolated
`smoke` and `latex-texmf` UI layers through the test harness. Run frontend
format/lint checks on changed sources. Use the existing native-distribution
checks for affected controls; do not rerun the full suite by habit.

Verify defaults are created before opening Preferences, files survive repeated
initialization, cancellation and replacement failure preserve the previous
folder, both layouts compile a custom class/package, and a restart retains the
chosen state. Existing multiple libraries must retain their precedence and
remain manageable through the disclosure. Test config-directory resolution for
portable builds as well as ordinary profiles.

Inspect screenshots at a normal desktop width and a narrow panel. Confirm no
horizontal overflow, no orphan help icons, a single primary Open action,
keyboard-accessible controls, useful accessible names, and search matches for
TEXMF/local/packages. A screenshot alone does not prove package resolution;
the compiler checks must assert the custom package's actual output.

## Acceptance criteria

- A fresh profile already has `texmf/tex/latex/local` and an enabled default
  local-packages registration, with compilation itself still opt-in.
- A normal profile shows one folder, one layout selector, one Open action and
  one Choose folder action; no Create/Add/Move/Remove/Check button stack.
- There is no visible personal-versus-external folder taxonomy.
- No Search order, Getting started or Trust and network paragraphs occupy the
  settings page.
- The displayed path and Open always identify the directory used by that layout.
- Default and external folders work with both compilation backends; an existing
  configuration keeps finding the same files in the same order.
- Busy, empty, unavailable and conflicting states are concise and actionable.
- The primary task is usable without expanding advanced or legacy controls.

## Open questions

None required before approval. Defaults are packages layout for new profiles,
existing registrations preserved, and automatic directory creation on first
per-user initialization rather than installer-specific hooks.

## Implementation notes

- Re-read the changed preview shell at HEAD `b64a27e` and retained its current
  library invalidation/focus paths. The pre-existing deletion of
  `package-lock.json` was left untouched.
- No initialization marker was needed: absence of the settings file or of the
  historical `latexTexmfRoots` key triggers initial registration; an explicit
  empty list or disabled root survives startup. Corrupt/unreadable existing
  files are not treated as new profiles.
- Removed the redundant Compilation heading above its only Auto-compile row.
  Blank-label buttons now carry their help on the button, eliminating orphan
  question marks; no help mechanism was removed.
- The cold-profile TEXMF suite had to report engine setup errors directly and
  synchronize the frontend switch afterwards. See the test-harness trap record.
- Clippy required equivalent simplification of the legacy engine-marker
  predicate in the already-touched settings module; behavior remains covered
  by its existing migration tests.
- The user subsequently requested committing everything and synchronizing the
  current branch. Include the pre-existing lockfile deletion in a separate
  commit rather than restoring it or mixing it into the UI change.

## Validation results

| Check | Result |
| --- | --- |
| Frontend build and release application build | Passed |
| Rust unit tests, final source | 403 passed, 6 explicitly ignored |
| `latex:texmf:unit` | 23/23 passed |
| Real `latex-texmf` UI/compiler layer, final source | 35/35 passed |
| Clippy `--all-targets -- -D warnings` | Passed |
| ESLint and Prettier, changed frontend/test files | Passed |
| Whitespace check with `core.whitespace=cr-at-eol` | Passed; settings.rs is CRLF in the index |
| Smoke | 119/120; repeated failure: `sync interpolates with a small preview font` |
| Installed-distribution layer | Skipped: `MDRAFT_TEST_TEX_BIN` is not configured |

The smoke failure concerns preview scroll interpolation; its logic was not
changed by this implementation. It is recorded as an outstanding validation
failure, not presented as a passing suite or asserted to be a proven baseline
failure. No unrelated scroll fix was added to this approved UI scope.

Actual WebView2 captures were inspected at normal and narrow widths, and with
legacy folders expanded. Working captures are under
`../screenshots/latex-preferences/` (intentionally ignored by repository policy).
Keyboard focus, real picker replacement/cancellation/failure, search by TEXMF,
absence of orphan help icons, default-root layout switching, and compiled
custom class/package output are asserted by the UI layer. Native/WSL and an
actual portable executable were not run; runtime config-relative paths and
preservation of existing registrations are covered by Rust tests.
