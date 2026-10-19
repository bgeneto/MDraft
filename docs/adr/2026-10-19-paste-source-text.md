# The clipboard's own markup text wins over its HTML representation

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
that already matches the destination wins", and that conversion applies to HTML
representations of *rendered* content. The gap was the fragment case:
`scoreHtml` refuses an HTML fragment on a clipboard on purpose ("a code snippet
starting with `<div>` must not be eaten by the parser"), so `chooseSource`
skipped the plain-text branch and fell through to the HTML representation — the
same parser, one step later, with a sanitizer at the end of it.

Measured with `planPaste` before the change: the highlighted payload above
returned the highlighted `<div>`, the bare-`<link>` payload returned `""`, and a
Markdown bullet-list snippet from the same editor returned `\- one\` — one
escaped line, not two.

## Decision

The plain-text representation of a paste is used when it is markup *written out*,
for an HTML or Markdown destination — the two whose text can carry HTML as-is —
and it is not converted:

- `isHtmlSource(text)` (`src/paste/detect.ts`) names an HTML fragment: text at
  the top level may only be tags and whitespace, text inside an element is
  content, void elements do not open a level, and a fragment that ends with an
  opening tag (`<div>`) counts. `Use the <div> tag` and `<div> is how you group`
  do not; `link`, `p`, `style` and whole documents do.
- A Markdown destination additionally takes any text carrying Markdown syntax
  (`scoreMarkdown > 0`, or a visible code fence), because a bullet list or a
  fence is Markdown but cannot classify a *document* — the destination is the
  one place that already knows the text. A confident other syntax still wins, so
  a Typst document with a bullet list is not hijacked.
- Typst and AsciiDoc still convert HTML source text to their escaped literal
  form. `<link>` is a *label* in Typst, so the verbatim tag would be invisible
  and its attributes would shift into the prose; escaping makes the snippet
  display as the characters the reader copied.

Sanitisation keeps applying whenever the HTML representation *is* the source: a
copy from a rendered page, a word processor or a preview. What changed is which
representation is chosen, not what the sanitizer allows.

## Consequences

- A pasted code snippet — HTML, Markdown, or an HTML snippet going into Markdown
  — is byte-for-byte what the clipboard's text held. `link`, `meta` and `style`
  in the user's own markup survive; the editor's highlighting never does.
- A whole HTML document copied as text is inserted verbatim rather than
  sanitised in an HTML document. Deliberate: it is the user's markup, not a
  page's resources, and typing the same tags by hand was always possible.
- A rendered copy whose visible text is entirely a tag (an inline `<div>` on a
  documentation page, selected alone) now inserts the characters, so the preview
  renders the tag instead of showing the text. The alternative is the reported
  failure for every code snippet.
- Rendered prose that merely mentions a tag keeps converting to escaped text,
  and `chooseSource`'s HTML-representation path is still the one used for
  headings, tables, links and bold from a browser.
- Typst and AsciiDoc destinations still convert HTML source text to their
  escaped literal form: `<` is meaningful syntax in Typst, and their low-score
  signals (`@ref`, `$5$`, `<label>`) occur in prose, so a loose "carries syntax"
  rule would suppress real conversions.
