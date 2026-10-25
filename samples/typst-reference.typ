//! MDraft's built-in Typst reference.
//!
//! Opened by Help › Typst Reference. Every example outside a fenced block is
//! compiled by the same Typst the preview uses, so what this file says about the
//! syntax is what the application actually renders. A built-in document has no
//! folder of its own, so `#image` and `#include` are shown as source rather than
//! called with a path that could not resolve.

#set page(paper: "a4", margin: 2.2cm)
#set text(size: 10.5pt)
#set heading(numbering: "1.1")
#set math.equation(numbering: "(1)")

= Typst Reference

This document is a live sample. Typst is a programming language and a typesetting
system at once: the text below is markup, the lines beginning with `#` are code,
and the compiler evaluates both before it lays out a page. Edit any line and the
preview redraws.

The preview has two views. *Document* shows Typst's HTML export: flowing,
selectable prose in the application's typography. *Pages* shows the compiler's
PDF, with the real page size, margins and layout. This document starts in
Document; the last section explains when to switch.

#outline(title: [Contents], depth: 2)

== Headings and text

A heading is a line beginning with `=`. One equals sign is level one, two is
level two, and the `#set heading(numbering: "1.1")` above turns the sequence into
numbers automatically.

Paragraphs are separated by a blank line. A single newline
continues the same paragraph. A backslash at the end of a line forces a break,\
like this.

*Strong*, _emphasis_, `inline code`, #underline[underline],
#strike[strikethrough], H#sub[2]O and E = mc#super[2] are all part of the
markup. Backslash escapes a literal character: \# \* \$ \_ are text, not syntax.

Typst applies typographic conventions while it compiles: `...` becomes an
ellipsis, `--` an en dash, `---` an em dash, and straight quotes become curly
ones.

== Lists

Three list forms share the same indentation rules:

- A bullet
- Another bullet
  - A nested bullet
    - A third level

+ First numbered item
+ Second numbered item
  + A nested item

/ Term: The definition that follows it.
/ Typst: A typesetting system with its own expression language.

A list item can hold several paragraphs and any other block, including math and
code.

== Tables

#figure(
  table(
    columns: (auto, auto, 1fr),
    align: (left, center, left),
    stroke: none,
    table.header([*Feature*], [*Typst*], [*Where it comes from*]),
    table.hline(),
    [Scripting], [yes], [A full expression language],
    [Cross-references], [yes], [`@label` and automatic numbering],
    [Page layout], [yes], [The printed page, not a browser],
    table.cell(colspan: 3)[#emph[A single cell that spans all three columns.]],
    table.hline(),
  ),
  caption: [A table with a header row, aligned columns and one spanning cell.],
) <table-example>

The table is a `figure`, so its caption is numbered and can be referenced:
@table-example. `table.header` marks the header row, `table.hline` draws a rule,
and `table.cell(colspan: 3)` spans columns.

== Mathematics

Inline math lives between dollar signs: $a^2 + b^2 = c^2$, and display math puts
the dollars on their own lines:

$ integral_0^infinity e^(-x^2) dif x = sqrt(pi)/2 $

Typst writes symbols by name — `alpha`, `infinity`, `->`, `<=>`, `dif`, `sum`,
`lim` — rather than with LaTeX commands. Matrices, vectors and cases are part of
the language:

$ mat(1, 2; 3, 4) vec(x, y) = vec(5, 6) $

$ f(x) = cases(x^2 & "if" x >= 0, -x & "otherwise") $

$ sum_(i=1)^n i = (n(n+1))/2 quad "and" quad lim_(x -> 0) (sin x)/x = 1 $

An `&` marks an alignment point in a multi-line formula, and `"..."` switches
from math to text inside it.

An equation can be labelled and referenced like any other element:

$ E = m c^2 $ <mass-energy>

Equation @mass-energy is the one every reader knows. The number is printed in
Pages and in a PDF export; the HTML export leaves it to the page and still
resolves the reference.

== Code and raw text

A fenced block names its language for highlighting:

```rust
fn main() {
    let total: u32 = (1..=10).sum();
    println!("{total}");
}
```

Inline code sits between backticks: `let x = 1;`. A fenced block without a
language is raw text and keeps its indentation exactly:

```
= this is not a heading
  the spaces survive
```

== Quotes, figures and footnotes

#quote(block: true, attribution: [Ada Lovelace])[
  That brain of mine is something more than merely mortal, as time will show.
]

A footnote#footnote[Typst numbers footnotes, places the note and links it back
without any markup of your own.] sits in the flow of the paragraph. A figure can
wrap any block, not only a table:

#figure(
  block(fill: luma(240), inset: 12pt, radius: 3pt)[
    A boxed figure. Pages keeps the background and the rounding; Document keeps
    the text and drops the paint.
  ],
  caption: [A figure whose contents are a block rather than a table.],
) <boxed-figure>

The figure above is @boxed-figure; the caption is generated, not typed.

== Links and cross-references

#link("https://typst.app")[A Typst link] is written with `#link`. A bare address
such as https://typst.app becomes a link by itself.

Labels connect a figure or equation to a reference. The examples above are
reachable through `@table-example`, `@mass-energy` or `@boxed-figure`, and Typst
chooses the word and the number; the source never repeats them.

== Scripting

This is the part Markdown and AsciiDoc cannot do. A Typst document is a program.

`#set` rules change the defaults for everything that follows:

```typst
#set text(size: 10.5pt, lang: "en")
#set heading(numbering: "1.1")
#set page(paper: "a4", margin: 2.2cm)
```

`#let` names a value or a function. A function can return content, which is how
a document grows its own vocabulary:

```typst
#let accent = rgb("#ffe08a")
#let todo(body) = [*TODO:* #body]
```

#let accent = rgb("#ffe08a")
#let todo(body) = [*TODO:* #body]

The accent is used as the fill of #highlight(fill: accent)[a highlight], and
here is the function: #todo[Replace this paragraph with your own text.]

Conditions and loops run at compile time, before anything is laid out:

#for n in range(1, 4) [
  + Step #n
]

#if 2 + 2 == 4 [This branch is chosen while the document compiles.]

A show rule rewrites matching content. Scoped inside a block it affects only
that block:

#[
  #show "MDraft": [_MDraft_]
  The word MDraft is emphasised here, and only here.
]

Outside that block the rule is gone. Show rules are how a document restyles
every heading, every link or every occurrence of a word without editing them.

== Colours and text styling

`#text(fill: ...)` changes the colour, `#text(size: ...)` the size and
`#text(weight: "bold")` the weight. `#highlight` paints behind the text,
`#underline` and `#strike` decorate it, and `#block` groups content with a
background and padding. The Document view keeps the words and loses most of the
paint; Pages and PDF keep both.

#block(fill: luma(238), inset: 10pt, radius: 3pt)[
  A shaded block. In Pages it reads as a panel; in Document it is a plain
  paragraph. The words are identical, which is the point of having both views.
]

== Page and layout

Page setup is a Typst-only feature. The `#set page` rule at the top of this file
sets A4 paper and its margins; Pages applies it, while the Document view ignores
it. The rules below break the flow and position content. The Document view cannot
represent them: `#pagebreak`, `#v` and `#h` are ignored, and `#align`, `#columns`,
`#grid`, `#place`, `#rect`, `#pad` and `#stack` are dropped together with
everything inside them. The pane names the containers that take their contents
with them and offers *Show pages*; the spacing rules simply disappear.

```typst
#set page(paper: "a4", margin: 2.2cm, numbering: "1 / 1")
#pagebreak()
#align(center)[Centred on the page]
#columns(2)[Text flows into two columns.]
#grid(columns: (1fr, 1fr), [Left], [Right])
#place(center + horizon)[Positioned over the page]
#rect(width: 100%, height: 40pt, fill: luma(230))[A rule]
#pad(x: 1em)[Indented content]
#stack(dir: ltr, [one], [two])
```

Switch to *Pages* to see `#set page` and the layout rules applied. `#box` and
`#block` survive the HTML export as wrappers, which is why their text is still
readable in Document even though their paint and geometry are not.

== Generated content

#lorem(20)

`#lorem` invents placeholder words. Generated text has no source line, so the
word-level sync deliberately paints nothing when you select it. Counters generate
numbered content in the same way:

```typst
#let examples = counter("examples")
#examples.step()
#context [Example #examples.display().]
```

`#counter` objects can be stepped, read and formatted, and `#numbering` turns
their values into labels. Reading one inside text needs a `context` block,
because the value is only known once layout begins. Counters are why a Typst
document can number its own parts without a plugin.

== Images and includes

A built-in document has no folder of its own, so these two calls are shown as
source:

```typst
#image("diagram.png", width: 80%)
#include "chapter.typ"
```

In a saved `.typ` document both resolve against the document's folder, and the
preview confines them to it: a path outside that folder is refused. An
`#include` is compiled as if its text stood in place, so the included file can
define functions and set rules for the including document.

== Document, Pages and export

The view bar above the preview switches between the two renderings of the same
source:

- *Document* is Typst's HTML export: flowing, selectable prose styled like the
  rest of the application. It cannot show a page.
- *Pages* is the compiler's PDF drawn by PDF.js: the real page size, margins
  and layout, with a text layer that can be selected and clicked. It is what a
  PDF export contains.

The default is Document because a preview is for reading. When the HTML export
has to drop something the pane says so and offers *Show pages*. If the export
fails outright, the preview falls back to Pages and names the failure.

Typst is not bundled. *Help › Install Typst* downloads it into MDraft's own
data folder on Windows and Linux; on macOS install it with your package manager
or from https://typst.app/open-source/#download and put `typst` on `PATH`.
