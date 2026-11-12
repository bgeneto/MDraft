# Preserve LaTeX source on paste

**Status:** done
**Date:** 2026-11-12
**ADR:** none

## Context and goal

Pasting `\usepackage[a4paper,margin=0.1in]{geometry}` into a saved or
content-detected LaTeX document can insert
`\textbackslash{}usepackage[a4paper,margin=0.1in]\{geometry\}` instead. The
paste handler sends plain text through the LaTeX literal-text escaper, and the
source classifier does not recognize LaTeX as a same-format clipboard source.
A syntax-highlighted HTML clipboard can instead be converted into a `verbatim`
environment. Source pasted into a LaTeX document should retain its characters,
whitespace, caret and native undo behavior.

## Scope and non-scope

Fix the choice and insertion of source text into saved, detected and default
LaTeX documents. Keep conversion of actual rich HTML and explicitly supplied
other formats available. Update the paste unit and UI checks and their catalog
entry. Do not change other destinations, image handling, settings, file formats,
or the LaTeX renderer used for genuinely converted prose.

## Approach and rejected alternatives

Treat a text-only clipboard as source when the destination is LaTeX, rather
than guessing that its special characters are prose needing escaping. When an
HTML representation accompanies the text, prefer the text for recognizably
LaTeX source or source-editor highlighting; retain rich conversion for ordinary
formatted content. An explicitly supplied `text/markdown` representation can
still request Markdown conversion. Make the classifier, conversion planner and
event handler agree, and allow source to take CodeMirror's native paste path so
leading and trailing newlines, multiple selections and undo retain native
semantics. As a consequence, Markdown syntax supplied only as plain text will
remain source in a LaTeX document; that ambiguity cannot be resolved reliably
by guessing the author's intent.

Escaping every plain clipboard string was rejected because valid source and
mathematics contain the same characters. Detecting only `\usepackage` was
rejected because other commands, partial snippets and math would remain
vulnerable. Disabling all rich paste for LaTeX was rejected because it would
remove the existing formatted-content conversion. A classifier cannot infer
intent perfectly from ambiguous HTML and text; prefer preserving recognizable
source and pin representative rich conversions in tests.

## Steps

- [x] Classify LaTeX source and text-only LaTeX pastes as native, including
      syntax-highlighted clipboard representations.
- [x] Align the conversion planner and paste handler with that decision; preserve
      exact native insertion behavior and keep rich conversion working.
- [x] Add unit and UI regressions for saved and detected LaTeX documents, source
      snippets, whitespace, undo and rich conversion.
- [x] Run the applicable checks, update the catalog and record results here.

## Files and modules

- `src/paste/detect.ts` — choose source versus rich clipboard content.
- `src/paste/index.ts` — honor native source and plain-text decisions without
  applying the LaTeX prose escaper.
- `src/main.ts` — let native LaTeX paste reach CodeMirror unchanged.
- `scripts/paste-convert-test.mjs` — cover the classifier and conversion matrix.
- `scripts/rich-paste-test.mjs` — cover the real paste event and undo paths.
- `docs/agent-guide/catalog/editor-and-documents.md` — update the paste-suite
  descriptions and measured check counts.
- `docs/plans/2026-11-12-latex-source-paste.md` — approval, progress and results.

## Risks and rollback

Formatted HTML and highlighted source can have indistinguishable clipboard
representations. Test representative instances of both, and preserve source
when there is evidence that the text is LaTeX. Text-only Markdown will no longer
be guessed and converted in a LaTeX document; explicit Markdown and rich HTML
representations remain convertible. Revert these files together to restore the
previous behavior, preserving any unrelated changes already present in them.

## Tests and validation

Run `npm run build` and `npm run paste:convert`, then the focused `paste` UI
layer through the repository harness when no user MDraft instance is running.
Verify exact source text for the reported command with and without syntax
highlighting; custom commands, math, comments, braces and underscores; leading
and trailing newlines; saved and detected LaTeX destinations; and a single undo.
Verify that an ordinary rich heading and emphasis still convert. Record any
environmental limitation without interrupting an existing user instance.

## Acceptance criteria

- The reported command pastes unchanged into saved and detected LaTeX buffers.
- Plain source and recognized highlighted LaTeX source are not escaped, wrapped,
  trimmed, or separated into blocks by the paste conversion pipeline.
- Actual rich HTML and explicitly represented Markdown can still be converted.
- The focused checks pass, or an environmental limitation is recorded precisely.

## Open questions

None. Where clipboard content is ambiguous, the default is to preserve source.

## Results

The frontend build and the focused Rust/Tauri application build passed.
`npm run paste:convert` passed **478/478** checks, and focused ESLint and
Prettier checks passed. The final `npm test -- --only paste` run passed
**96/96**; the session could not own the system clipboard, so nine native-key
checks were skipped. The immediately preceding run passed **104/104**, including
real Ctrl+V of the reported LaTeX command, before the final rich-HTML spacing
guard and its additional check were added. Both runs exercised the saved and
detected LaTeX documents, exact source insertion and undo.

The first application-build attempts encountered unrelated, concurrently edited
recovery and text-encoding code that was incomplete at the time; later retries
built successfully without changing that work.
