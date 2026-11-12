# Edit web source files

**Status:** in progress
**Date:** 2026-11-11
**ADR:** none

## Context and goal

MDraft previews HTML, but JavaScript and CSS files currently fall back to Markdown. Readers working on a web page need to open and edit its companion files with appropriate syntax highlighting, without presenting their contents as a Markdown preview.

## Scope and non-scope

Support JavaScript (`.js`, `.mjs`, `.cjs`), CSS (`.css`), and JSON (`.json`) as source documents. JSON is common in web projects and is included as a useful companion format. Display a centered warning and explanation in the preview pane; retain the normal source, split, and preview view choices. Preserve ordinary open, save, Save As, tab, recent-file, and recovery behavior.

Do not execute scripts, compile styles, synthesize a web page, or add a project preview. TypeScript, JSX, SCSS, JSON with comments, SVG, and other formats are outside this change; they have distinct syntax or preview expectations.

## Approach and rejected alternatives

Extend the document language and extension mapping, and load the matching CodeMirror language support through the existing `@codemirror/language-data` catalog, which already includes JavaScript, CSS, and JSON. Verify its loading and bundle behavior during implementation; do not add a dependency. Treat these as source-only languages throughout the shell, showing a static warning using the existing centered preview-pending styling. Clear old preview content and cancel or invalidate pending work on tab and language changes. Disable or appropriately guard preview-dependent, markup-only, formatting, export, spellcheck, paste, and assistant operations where their existing behavior would be misleading or modify code as Markdown; keep normal text editing available.

Rendering source as Markdown was rejected because it is misleading. Automatically previewing the associated HTML was rejected because there is no reliable way to infer the intended page or represent unsaved changes across files. A standalone source view without the preview pane was rejected because the requested explanation and existing view choices should remain visible.

## Steps

- [x] Extend language and extension classification, dialog filters, labels, save suggestions, and recovery handling for the three formats.
- [x] Install the appropriate CodeMirror grammars with the existing async generation guard; check highlighting and language-specific editor behavior.
- [x] Add the centered source-only preview state and clear/cancel stale previews safely across edits, view modes, tab switches, and Save As.
- [x] Audit and guard source-inappropriate menu commands, export, printing, spellcheck, rich paste, assistant actions, and other language-dependent paths, including backend menu enablement and recovery.
- [ ] Extend focused tests, run the appropriate build and app-free and UI checks, and update relevant user documentation.

## Files and modules

- `src/api.ts`: document-language union and any associated typed interfaces.
- `src/paste/detect-document.ts`, `src/main.ts`: extension mapping, file filters, document lifecycle, preview state, and relevant command guards.
- `src/editor.ts`: CodeMirror language loading and source-specific editor behavior.
- `src/styles.css`: warning appearance consistent with the centered preview state.
- `src-tauri/src/menu.rs`: disable inapplicable native menu actions and add focused menu tests.
- Language-dependent modules under `src/` (including `src/ai/`, `src/paste/`, formatting, filenames and spellcheck), and backend recovery or command modules, only where the audit shows explicit handling is needed.
- Existing focused unit and UI test scripts and relevant README/help documentation: extend coverage and describe the supported formats. If an additional script proves necessary, document it in the appropriate script catalog.
- This plan: record progress and any deviations.

## Risks and rollback

An overlooked Markdown fallback could mutate source or show an unrelated preview. Async grammar loads and in-flight preview renders could paint over a different tab. Recovery, native menus, rich paste and Save As require particular attention. Keep the changes isolated and revert the implementation and documentation together if needed; existing document formats and settings must continue to load unchanged.

## Tests and validation

Implementation validation so far: frontend production build and focused Rust menu test passed; ESLint passed on the changed TypeScript files. The paste suite passed its new extension check, but two existing math-inventory checks failed because `samples/feature-tour.md` is checked out with CRLF while the pinned inventory uses LF; the normalized SHA-256 matches. Full ESLint reports existing control-character errors in `src/latex-outline.ts` and `src/paste/render-latex.ts`. The HTML UI suite passed the five new source highlighting and warning checks, but two existing nested HTML text-selection checks failed. The menu UI suite passed 166/172 checks; failures concerned Pandoc export availability and link detection. Further UI coverage of save, recovery and view transitions remains outstanding.

Run `npm run build` and focused app-free tests for extension classification, save/paste behavior, and language-specific guards; extend existing tests where practical. Exercise backend menu changes with the targeted Rust tests using the Windows MSVC wrapper. Run focused UI checks for syntax highlighting, centered warning in split/preview modes, opening and saving each extension, source editing, recovery, and switching among web source and existing previewable documents, including a pending render. Run relevant HTML and menu regression checks when a test application is available. Verify no new startup network activity or dependency is introduced.

## Acceptance criteria

- Opening `.js`, `.mjs`, `.cjs`, `.css`, or `.json` selects the corresponding syntax highlighting, and editing and saving preserves the file contents and extension.
- Split and preview modes show a centered warning explaining that a preview is unavailable for the current file type, with no stale document visible.
- Switching tabs or renaming through Save As updates the grammar and preview correctly; restored sessions identify the format correctly.
- Source-inappropriate actions cannot silently apply Markdown transformations or produce a misleading preview/export; supported text editing remains usable.
- Existing Markdown and HTML behavior continues to work.

## Open questions

The proposed default includes JSON because it is a frequent web-project companion. TypeScript and stylesheet preprocessors can be added separately if desired; their extensions must not be treated as ordinary JavaScript or CSS without checking their grammar and behavior.
