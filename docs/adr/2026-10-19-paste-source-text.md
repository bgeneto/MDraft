# The clipboard's text is converted for the destination, and pasted only when it is the destination's own markup

**Status:** accepted
**Date:** 2026-10-19

## Context

Copying `<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/reveal.js/5.2.1/reset.min.css">`
from a code editor with syntax highlighting and pasting it into a saved HTML
document inserted the *highlighting*:

```
<div style="color: #d4d4d4; white-space: pre"><div><span style="color: #808080">&lt;</span>
<span style="color: #9CDCFE">link</span><span style="color: #9CDCFE"> rel</span>…
```

When the clipboard's HTML representation was the bare tag, pasting inserted
**nothing**, because `sanitizeHtmlFragment` drops `link`, `meta`, `style` and
`script`; and pasting the same snippet into a Markdown document produced
`\<linkrel="stylesheet"href="…"\>` — escaped, spaces gone.

The rich-paste decision
([`2026-10-17-rich-paste.md`](2026-10-17-rich-paste.md)) already says "plain text
that already matches the destination wins". The gap was the fragment case:
`scoreHtml` refuses an HTML fragment on a clipboard on purpose ("a code snippet
starting with `<div>` must not be eaten by the parser"), so `chooseSource`
skipped the plain-text branch and fell through to the HTML representation — the
same parser, one step later, with a sanitizer at the end of it.

The first attempt at a fix made the plain text win whenever it *was* markup, for
every destination. That repaired HTML and broke the other direction: pasting

```
<p>Enviar sua chave Pix … como <strong>CPF, e-mail ou telefone</strong> … <a href="/blog/…">doxing</a> …</p>
```

into a Markdown document inserted the literal tags, when the reader expects

```
Enviar sua chave Pix … como **CPF, e-mail ou telefone** … [doxing](/blog/…) …
```

The clipboard is the same in both reports. Only the destination differs, and it
is the destination that says what the paste means.

## Decision

Two rules, one for each direction.

- **The text flavour decides the source format when it is markup we recognise:**
  HTML source (`isHtmlSource`), a confident Typst or AsciiDoc document, or text
  carrying Markdown's own syntax (any signal, or a visible fence — a bullet list
  cannot classify a document, but the destination already knows it is Markdown;
  a confident other syntax still wins, so a Typst document with bullets stays
  Typst). If that format **is** the destination, the text is pasted
  byte-for-byte. Otherwise the **text** is converted into the destination — not
  the HTML representation, which for a copy made from source is only the same
  characters decorated.
- **When the text is not markup** it is a copy from a rendered surface, so the
  **HTML representation** is the content: convert it, and sanitise it when the
  destination is HTML. Then the Markdown representation, and finally plain text.

The destination decides the intent, and it has to. The same `<p>…</p>` clipboard
means "keep this markup" in an HTML document and "convert this into my format"
in a Markdown, Typst or AsciiDoc one. A rule keyed on the clipboard alone pastes
literal HTML into Markdown; a rule keyed on the destination alone loses the
snippet in HTML.

A snippet the reader keeps nothing of — `<link>`, `<meta>`, a `<style>` block —
is still the characters the reader copied, so it is rendered as literal text for
the destination: escaped where the destination needs it (`<link>` is a label
reference in Typst and would vanish).

## Consequences

- The same clipboard lands correctly in every format: the HTML article above
  becomes Markdown, AsciiDoc and Typst in their own syntax; the `<link>` snippet
  stays byte-for-byte in an HTML document and becomes escaped literal text
  elsewhere.
- Sanitisation keeps applying whenever the HTML representation *is* the source:
  a copy from a rendered page, a word processor or a preview. HTML→HTML is still
  lossy for rendered content; the sanitizer's drop list is unchanged.
- Whitespace at the edge of an inline element is significant and survives:
  `como <strong>x</strong> a` keeps both spaces, even when the copy wraps each
  text run in its own element. Only a block's outer edges are trimmed, through
  wrappers. The HTML reader used to trim inside every element, which glued words
  to bold text and links copied from a page (`como**x**a`).
- A whole HTML document copied as text is inserted verbatim into an HTML
  document (the text is the author's markup), and converted when the destination
  is another format.
- `detectTextSyntax` still requires a two-point lead for **destination
  detection**; the looser Markdown rule is only a source decision and never
  reclassifies a buffer.
- Typst and AsciiDoc destinations keep their escaped literal form for HTML
  source text, so a pasted tag is visible rather than swallowed by the language.
