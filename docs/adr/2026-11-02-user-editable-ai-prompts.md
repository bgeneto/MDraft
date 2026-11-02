# The reader's AI prompts are a Markdown file, and the wrapper contract is not

**Status:** accepted
**Date:** 2026-11-02

## Context

The fourteen action prompts and the shared preamble were Rust constants. The
ADRs of 2026-10-28 made them one place on purpose — one request shape, one
output contract, one sanitizer — and the Summarize rewrite showed what that
costs: changing a sentence needs a code change, a rebuild and a release. A
reader writing in Portuguese, or with a better prompt for their discipline, had
no route at all.

Kiro-style prompt packs are usually YAML. This application has one markup
engine, one preview pipeline and a closed document-language union; a YAML file
would need a Rust YAML crate and a fifth document kind with no preview, no
outline and no word sync, or a second editor surface. The reader rejected the
binary-size cost of the crate outright.

## Decision

1. **`ai-prompts.md`**, beside `settings.json`, is a **Markdown document the
   application already knows how to edit**: one `## <action id>` section per
   prompt plus `## preamble` and `## suggestFileName`, each body in a fence long
   enough to contain it. Highlighting, preview, spellcheck, Find, Format
   Document, save, the recovery journal, remembered tabs and the disk poll come
   for free, because it is an ordinary document. No new npm or cargo dependency.
2. **Sparse overrides.** A missing section keeps the built-in prompt, so a
   partial file is valid, an old file keeps working when an action is added, and
   "reset" is a plain rewrite of the file.
3. **Strict validation, one error at a time.** Unknown section ids, duplicate
   sections, missing or unterminated fences, unknown placeholders, a placeholder
   the action cannot fill, and a preamble without `{markup}`/`{syntax_rule}` are
   refused with `ai-prompts.md line N: …`. A file with an error is never
   half-applied. The file is read on every request, so an external edit is picked
   up without a cache to invalidate.
4. **The task is editable; the protocol is not.** One fixed sentence naming the
   action's `mdraft-*` tag is appended to every system message, after the
   reader's text. Improve is exempt because its answer has two blocks
   (`mdraft-revised` + `mdraft-notes`) and a single-wrapper rule would contradict
   them. `TagFilter` already tolerates a missing tag; the appendix makes that
   path unnecessary rather than load-bearing.
5. **Reset is the recovery path.** `ai_export_prompts` writes the built-in
   prompts from the constants and never parses the file it replaces, so it works
   on a file that no longer parses. It is refused only while the prompts tab has
   unsaved changes, which is the one way it could lose work.
6. **Where the limits live.** 8,192 characters per section, 128 KB per file,
   32,000 characters for the assembled system message. The passage budget is
   unchanged and still does not count the system prompt; the caps bound what a
   file can add.

## Consequences

- A prompt change is a document edit, so the version in `prompt.rs` is the
  built-in default and the file is the override. A generated file records the
  version that wrote it; nothing migrates it, and a stale section keeps its old
  wording until Reset.
- Renaming an action id or the `suggestFileName` key is a **public contract
  change**: it silently stops matching the reader's file section.
- New actions must appear in `sections()`, otherwise their section is rejected as
  an unknown action when the reader regenerates the file.
- The prompt file is user state: `scripts/test-all.mjs` backs it up, resets it
  between suites and restores it, exactly like `settings.json` and the recovery
  journal.
- The assistant panel renders answers as Markdown regardless of the document's
  markup; that is unchanged and unrelated to where the prompts live.
