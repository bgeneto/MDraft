# Markdown dollar classification uses shared source ranges before markup parsing

**Status:** accepted
**Date:** 2026-10-21

## Context

Preview and clipboard conversion disagreed about padded equations and both
mistook adjacent currency amounts for tight math. Currency-specific body regexes
could not repair the parsing order: Markdown interpreted emphasis and escapes
inside formulas before the clipboard reader recognized them. Native paste also
carries whitespace, multiple selections and linewise-copy metadata that the
block-oriented rich-paste inserter does not preserve.

The pre-change fixture inventory contains 292 physics-paper formulas and five
feature-tour formulas, with exact bodies, ranges and display modes recorded in
`scripts/fixtures/math-inventory.json`. No closing dollar in those fixtures is
immediately followed by a digit.

## Decision

`src/math-delimiters.ts` owns dollar classification and original UTF-16 ranges.
`src/markdown-context.ts` uses the installed Markdown grammar to protect code,
destinations and markup without serializing source. Markdown preview and paste
protect accepted math before Markdown interprets its body; decoded HTML text
uses neighboring inline text context and keeps visible backslashes. Semantic
HTML math annotations retain priority over text heuristics. Native Typst and
AsciiDoc readers keep their own syntax.

Known complete currency prefixes and pairing barriers prevent monetary dollars
from consuming formula delimiters. Tight numeric `$5$` stays math, padded
`$ 5 $` stays literal, and padded TeX/arithmetic remains supported. `R$5$` is
prefixed currency; `$x$2` is deliberately not a dollar pair. Explicit `\(…\)`
requests mathematics when dollar syntax is ambiguous; `\$` requests literal
text. The approved plan records the complete ambiguity table.

Formatted Markdown paste inserts only currency escape characters. Source/MIME
selection precedes normalization. Native paste keeps CodeMirror's original
input: a clipboard filter records the normalized text, and a sequential paste
transaction filter inserts escapes after CodeMirror decides linewise and
multi-selection insertion. This preserves its original linewise metadata,
selection mapping and one undo transaction. Per-event arming excludes drops and
all bypasses. Protected destination selections retain native insertion.

## Consequences

There is one testable policy instead of separate preview/paste regexes. Literal
currency spelling and non-currency source bytes are preserved. The new dialect
choices are documented in the built-in reference and exercised as contract
tests. Source-range inventory and actual UI rendering are both checked; an
aggregate KaTeX count cannot prove preservation of every formula.

Not every dollar-containing sentence has an unambiguous interpretation.
`$50/day$` and `$5 + tax$` remain eligible tight math; literal money uses `\$`.
The policy deliberately avoids prose dictionaries and recursive recovery.
Native HTML/Print share the preview renderer, while Pandoc retains its own
Markdown reader and does not gain padded-dollar parity through this change.
