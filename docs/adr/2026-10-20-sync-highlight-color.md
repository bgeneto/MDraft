# The sync highlight takes its colour from the syntax palette

**Status:** accepted
**Date:** 2026-10-20

## Context

The word-level sync painted `.cm-sync-word` with `--word-sync`, a single
translucent yellow on `:root` and `[data-theme="dark"]`. That variable follows the
application chrome. The editor's writing surface belongs to a syntax palette and
can disagree with the chrome: Solarized Dark while the window is light, or Ink
while it is dark.

Measured against the real surfaces, the alpha is the failure:

- Paper (`#ffffff`): `rgba(255, 193, 7, 0.30)` blends to about `#ffecb5`. The
  mark is obvious.
- Ink (`#1e1e1e`): `rgba(255, 213, 79, 0.24)` blends to about `rgb(84, 74, 42)`,
  a faint brown under syntax-coloured text.
- Solarized Dark (`#002b36`): the same wash blends to about `rgb(61, 84, 60)`.
  The surface's green channel wins and the "yellow" is olive.

A dark theme cannot fix this by raising one alpha. A transparent yellow over teal
still mixes the teal into the band: even at 45% it lands around
`rgb(115, 112, 30)`, with red almost equal to green.

## Decision

The sync mark's colour is part of `SyntaxPalette`, published by
`buildChromeTheme` as `--editor-sync` (resting) and `--editor-sync-peak` (pulse),
and consumed by `.cm-sync-word`. The colours are opaque. The preview, which has no
syntax palette, keeps `--word-sync` on the application theme, but with enough
alpha to read on `--bg` and a separate `--word-sync-peak` for its pulse.

The resting colour stays a warm amber — R > G > B — and is dark enough on a dark
surface that the palette's text remains readable over it. The peak is lighter and
is used only during the pulse. The pulse is four beats of 500 ms; the element's
own background is the resting colour, so the mark remains after the animation
ends.

## Consequences

- A new palette must supply both colours. A palette that copies another inherits
  them correctly; a bespoke surface must be checked by screenshot, not by the
  hex alone.
- The editor mark and the preview wash no longer share a value. Changing one does
  not change the other, which is correct: they sit on different surfaces.
- The pulse ends by returning to the element's own background. Any future change
  that removes the class on a timer, or that clears the decoration when the
  animation finishes, reintroduces the bug this decision prevents: the reader
  asked for the mark to stay and stop moving, not for it to disappear.
