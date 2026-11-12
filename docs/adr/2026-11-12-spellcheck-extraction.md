# Spellchecking extracts syntax-aware passages in the editor

**Status:** accepted
**Date:** 2026-11-12

## Context

The operating-system spellchecker accepts words, but source documents mix prose
with markup, identifiers, code and machine values. Escapes and entities mean
the text presented to a dictionary does not always have the same offsets as the
source. Checking every token as prose produces noise and unsafe corrections.

## Decision

The editor extracts passages using the document grammar and conservative
format-specific rules. Each decoded passage carries boundaries mapping it back
to the source. Word checks are grouped by installed dictionary, and a correction
is offered only when its source mapping and current document snapshot are safe.
Language declarations and explicit document choices select dictionaries without
silently substituting an unavailable language. Existing local operating-system
backends remain responsible for spelling; no dictionary or text is sent over the
network. Typst structural parsing runs in a worker because its editor grammar
does not expose a structural syntax tree.

## Consequences

Adapters and mapping tests must accompany each newly supported syntax or escape
form. Ambiguous and incomplete syntax fails closed, and code string detection is
a heuristic rather than a semantic guarantee. Linux exposes only installed
UTF-8 Hunspell dictionaries supported by the backend. The settings retain a
bounded set of document-language overrides. Sentence-level and grammar checking
remain outside this decision.
