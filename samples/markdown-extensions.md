# Markdown extensions

Synthetic fixture for footnotes, highlight, subscript, superscript, Obsidian
callouts and math fences. `npm run md-extensions:unit` and the preview DOM
suite read it; keep the cases in this order.

## Footnotes

Water boils at 100 °C at sea level[^boil]. Altitude lowers that point[^alt],
and the first note is cited again here[^boil]. An undefined label stays
literal: [^missing].

Notes can hold code `x = 1`[^code] and run over several paragraphs[^long].

[^boil]: At a pressure of one standard atmosphere.
[^alt]: Roughly one degree for every 300 metres.
[^code]: A note with `inline code` and **bold** text.
[^long]: The first paragraph of a long note.

    A second paragraph, indented four spaces.

[^unused]: Never referenced, so it is not listed.

## Highlight, subscript and superscript

The ==key result== is H~2~O at 10^3^ pascals. ~~Struck~~ text still strikes,
2^10 without a closing caret stays literal, and ~a b~ with a space stays
literal too. Code keeps its markers: `==x== H~2~O`.

## Callouts

> [!NOTE]
> A GitHub alert keeps its **formatting** on the first line.

> [!tip]- Custom **title**
> Collapsed by default.

> [!faq]+ Open question
> Expanded by default.

> [!example]
> No custom title.

> [!quote] Nested
> > [!warning] Inner
> > Inside the quote.

## Math fence

```math
E = mc^2
```

Inline $a^2$ still works.
