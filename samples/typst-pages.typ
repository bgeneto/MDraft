//! A package-free Typst fixture for the PDF.js Pages view.
//!
//! It is deliberately two columns and two pages, with plain prose, a repeated
//! word (`pendulum`), one unique word (`gyroscope`) and generated text
//! (`#lorem`) that has no source word to map back to.

#set page(paper: "a4", margin: 2cm, columns: 2)
#set text(size: 10pt, hyphenate: true)

#align(center)[
  #text(size: 18pt, weight: "bold")[A Two-Column Pendulum Paper]
  #v(4pt)
  A. Researcher \
  Department of Physics
]

#v(8pt)

*Abstract*—This example paper describes a simple pendulum and a gyroscope
measurement. The values below are illustrative; they exist to give the page
view enough prose, columns and pages to exercise the PDF text layer.

= Introduction

The simple pendulum is a useful model for periodic motion. For small
oscillations its period depends primarily on the pendulum length and the local
gravitational acceleration. The word pendulum appears again here so a search
has more than one candidate, while gyroscope appears exactly once in the
document.

#lorem(35)

= Method

A pendulum was modeled as a small mass on a light string. Its length was taken
as 0.500 m and its period as 1.421 s. The time for twenty oscillations was
measured three times and divided by twenty.

#lorem(28)

#colbreak()

= Results

Substituting the illustrative values gives an estimate of gravitational
acceleration. The estimate differs from the reference value by about 0.4
percent, which is smaller than the estimated uncertainty.

#lorem(30)

#pagebreak()

= Discussion

The agreement with $T = 2 pi sqrt(L / g)$ is reasonable for a simple
measurement. Timing several oscillations reduces the effect of reaction-time
error, while measuring the
length carefully matters because the calculated value is proportional to it.
The small-angle approximation also matters: larger release angles make the
period slightly longer than the model predicts.

No instante $t = 2,0$ s, uma partícula passa \
com velocidade
$v = (2,0, -9,0)$ m/s. As coordenadas estão registradas para comparar o
movimento circular com a aceleração centrípeta.
