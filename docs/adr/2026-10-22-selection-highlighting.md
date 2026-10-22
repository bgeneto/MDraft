# Selection correspondence belongs to an immutable render snapshot

**Status:** accepted
**Date:** 2026-10-22
**Supersedes in part:** `2026-10-18-word-level-sync.md` (single-range painting and map lifetime), `2026-10-18-typst-pdf-pages.md` (caret-assisted line matching), `2026-10-20-html-word-sync.md` (one-node, one-direction limit).

## Context

In the two-column physics exam, selecting `velocidade` beside a formula could
choose a numeric source window and paint nothing. Column origins drifted into
indented paragraphs, and separate formula spans could be assigned to the other
column. Source selection had no inverse Pages route. Shared DOM endpoint code
ignored element child offsets; reverse block mapping omitted later paragraphs.
HTML decoded only a handful of entities and used inconsistent nested-node
ownership. Equal source offsets could outlive their decoration after editing.

The expanded reproducers and validation record live in
`../plans/2026-10-22-typst-pages-word-sync.md`.

## Decision

Each correspondence map belongs to the source text and render generation that
created its DOM. Editing invalidates it immediately, before the render debounce.
An asynchronous render cannot reactivate an obsolete map. Clearing and Escape
cancel pending selection/pulse work; the same source offsets must recreate a
decoration if an edit removed it. Reduced motion uses a steady resting mark.

DOM Range intersections resolve element endpoints and trim browser-added
whitespace. Source selections collect all verified fragments across blocks and
paint separate CSS Highlight ranges without including unrelated DOM gaps.
Existing anchored AsciiDoc/Typst Document block fallback remains available when
no exact text spans resolve a substitution or formula.

Pages owns PDF geometry and one bidirectional prose index. PDF baselines and
leftmost column starts define reading regions independently of CSS fit. Literal
Typst markup comes from the existing syntax parser; definitions, rules, comments,
raw code and math are excluded. Unique two-to-six-word windows establish links;
small gaps require compatible anchors on both sides. Unknown formula tokens
never shift subsequent prose offsets. Both directions use the same accepted
links. Ligatures, combining accents, soft hyphens and verified broken words
retain original UTF-16 boundaries and separate DOM fragments. The editor caret
does not decide an occurrence. Duplicate/indistinguishable origins stay unmapped.

HTML retains source offsets exclusively in the host. The existing parse5
dependency supplies HTML5 entity decoding and a decoded-to-raw boundary table,
including invalid interior boundaries of multi-codepoint entities. Host and
guest enumerate only text owned by the nearest stamped ancestor. The guest
reports bounded, ordered text segments; the host validates every identity and
sample. Reverse messages carry identities, decoded offsets and expected text,
which the guest validates before creating CSS Highlights. Frames must be active
and current; delayed selection messages cannot reclaim editor focus. No extra
spans are injected, and the opaque-origin sandbox/IPC authentication stays intact.

## Consequences

Literal prose works in both directions in all five preview modes, including
Pages text beside formulas and HTML text after entities. Editing temporarily
suspends correspondence until the fresh render is ready. Selection and copying
remain browser/editor operations; paint never changes their ranges.

Pages remains a bounded text correspondence heuristic, not compiler provenance.
Generated labels, macro expansions, formulas, identical repeated passages and
selections across unrelated regions may have no word mapping. Exact navigation
for those cases needs a separately designed compiler integration. There is no
new dependency, Rust command, persisted schema or background network request.
