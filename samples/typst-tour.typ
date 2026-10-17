//! A small tour of what MDraft does with a Typst document.
//!
//! The preview is drawn by the Typst compiler itself, so what the pane shows is
//! what an export will contain. Edit any line and it redraws.

#set page(paper: "a4", margin: 2.2cm)
#set text(size: 11pt, hyphenate: true)
#set heading(numbering: "1.1")

#align(center)[
  #text(size: 20pt, weight: "bold")[MDraft — Typst tour]
  #v(2pt)
  #text(size: 10pt)[Rendered by the compiler, not by a browser]
]

= Text

Regular text, *strong*, _emphasis_, `inline code`, and a
#link("https://typst.app")[link]. A footnote#footnote[Typst handles these
itself, which is one reason the LaTeX route was unnecessary.] sits inline.

== Lists

+ Ordered item
+ Another one
  - Nested bullet
  - Another nested bullet

= Mathematics

Inline math such as $a^2 + b^2 = c^2$ flows with the text. Display math gets its
own line:

$ integral_0^infinity e^(-x^2) dif x = sqrt(pi)/2 $

$ sum_(i=1)^n i = (n(n+1))/2 quad "and" quad lim_(x -> 0) (sin x)/x = 1 $

= Tables

#figure(
  table(
    columns: (auto, auto, 1fr),
    align: (left, center, left),
    stroke: none,
    table.header(
      [*Feature*], [*Status*], [*Notes*],
    ),
    table.hline(),
    [Syntax highlighting], [yes], [Typst grammar, lazily loaded],
    [Live preview], [yes], [The compiler's own pages],
    [PDF export], [yes], [pandoc drives Typst],
    table.hline(),
  ),
  caption: [What this document exercises.],
)

= Code

```rust
fn main() {
    let total: u32 = (1..=10).sum();
    println!("{total}");
}
```

= Colours and boxes

#block(fill: luma(240), inset: 10pt, radius: 3pt)[
  A shaded block. Typst draws it; the preview shows it exactly as it will print.
]

#text(fill: rgb("#b03030"))[Coloured text] is a normal part of the language.

= Page break

#pagebreak()

= Second page

This exists to prove the preview paginates: a `{p}`-numbered series of pages is
produced, and every one of them is shown.
