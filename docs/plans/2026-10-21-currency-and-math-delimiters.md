# Currency Values and Inline Math Delimiters in Markdown and Paste

**Status:** done
**Date:** 2026-10-21
**ADR:** [Shared source-range dollar classification](../adr/2026-10-21-currency-and-math-delimiters.md)

**Approval:** User explicitly requested implementation on 2026-10-21, including
the documented ambiguity/compatibility decisions.

## Context and goal

Markdown uses `$` for money and inline TeX. Today, the preview accepts any tight
dollar pair, so `US$5 and US$7`, `R$50/dia, R$350/semana`, and
`C$5 → C$6 → C$7,50` can render intervening prose as math. A currency dollar
can also consume the opening delimiter of a later equation.

The goal is a consistent, documented policy for Markdown preview and paste:
literal monetary amounts, preserved tight and space-padded math, and minimal
currency escaping during formatted paste into Markdown. Amounts must never be
rounded, converted, localized, or reformatted.

### Review findings

Read-only probes and inspection found gaps beyond the reported examples:

- All six requested amounts match the old plan's prefix predicate. They need
  explicit tests in pairs and mixed lines; a standalone amount cannot expose
  incorrect pairing.
- That predicate also calls `f$2x+1$` currency: any preceding letter and first
  digit were enough. Its advertised `U$S100` and numberless `Cr$` cases do not
  match the proposed regex.
- `splitMath("$ a + b $")` currently produces text, unlike the preview.
- Markdown paste runs `marked` before `splitMath`. `$a*b*c$` is split into
  text/emphasis/text; `$\{x\}$` loses escape boundaries; `\(x + y\)` becomes
  escaped parentheses and text. `$E_{n}$` survives this particular tokenization.
  Sharing a scanner after tokenization does not repair these failures.
- HTML text containing `R\$50` contains a real visible backslash. Serializing it
  as `R\\\$50` preserves that backslash; deleting it globally in `splitMath`
  would lose content. Markdown source escapes and HTML characters are different.
- `editor.insertPasted` trims leading/trailing newlines, adds block spacing when
  requested, and uses the main selection. Routing previously native currency
  pastes through it would violate the promised minimal-change behavior.
- `npm run math` measures fonts/geometry and a threshold of more than 100 KaTeX
  elements. It does not prove that every original equation survived.

These findings drove the implementation below. Completed validation is recorded
under Tests and validation.

## Scope and non-scope

**In scope:**

- Shared source-range-based currency/math analysis for Markdown preview,
  Markdown paste reading, and unannotated HTML text in the paste reader.
- Tight and space-padded inline math, existing explicit/display forms, and the
  complete reviewed physics-paper and feature-tour equation inventories.
- Minimal escaping of currency dollars when formatted-pasting plain text,
  Markdown, or HTML into Markdown with rich paste enabled and an eligible
  insertion context.
- Native paste whitespace, selections, linewise behavior, caret and undo;
  format conversion, source maps, native HTML export, reference documentation,
  and an ADR for the durable policy.

**Out of scope:**

- Currency arithmetic or national numeric-format validation. Both `15.200,75`
  and `8,123.50` remain unchanged.
- Native Typst, AsciiDoc, or HTML preview syntax changes, dependencies, settings,
  Tauri contracts, network behavior, or a general paste refactor.
- Changing copied source, text drops, or existing files on open/save.
- Inferring every possible author intention from ambiguous dollars; use the
  precedence table below, `\$` for literal text, and `\(…\)` for explicit math.
- Changing Pandoc's Markdown dialect. Native HTML/PDF (Print) use the preview
  renderer; Pandoc currently receives Markdown source through its separate
  reader. Do not promise padded-math parity across these different pipelines.

`Ctrl+Shift+V`, rich paste off, protected insertion contexts, and other languages'
native paste retain their current behavior. Raw paste still benefits from the
preview fix independently of whether currency escaping was bypassed.

## Approach and rejected alternatives

### Shared ranges and source context

Create pure delimiter analysis in `src/math-delimiters.ts`, without DOM/Tauri
dependencies or the TeX-to-Typst translator. Return original-source ranges for
math and currency dollars. Preview, paste, `hasInlineMath` and currency escaping
derive decisions from the same analysis, not independent body regexes.

Extract/reuse raw Markdown context handling in `src/markdown-context.ts`.
Keep source mode explicit: raw Markdown has escape syntax; decoded HTML text
has literal characters. Recognize these protected ranges before dollar analysis:

- Backtick/tilde fences with matching marker and sufficient closing run length;
  nested list/quote fences, unclosed fences, and indented code.
- Inline code with matching backtick runs, including multiple backticks and
  multiline spans. Unmatched backticks must not hide all subsequent prose.
- Link/image destinations, reference-definition destinations, autolinks, HTML
  tag/attribute syntax, comments and raw code elements. Visible link labels
  remain eligible, while URLs, paths and attributes remain unchanged.
- Explicit `$$…$$`, `\[…\]` and `\(…\)` math. Preserve current explicit-form
  precedence and multiline/display behavior.

Use parser structure where available, without reserializing Markdown. The
preview's current fence/code helpers cannot be reused unchanged: their matching
and protected-region coverage are incomplete. Dollar pairs must not cross code,
HTML, explicit-math or block boundaries. Preserve original line endings and
UTF-16 offsets. Treat registered placeholders as boundaries; literal `@@` in
user math is not an invalid-expression marker.

### Currency tokens and precedence

Recognition preserves the numeric text rather than converting it to a number.

**Complete amounts:** cover integers, grouping/decimals with `.` and `,`,
leading fractions (`$.50`), signs (`-$5`, `$-5`, `R$ -10,50`), and accounting
punctuation (`($50)`). Horizontal spacing includes ordinary space, tab, U+00A0
and U+202F, never a newline. Preserve grouping spaces/apostrophes as written.
A numeric prefix followed by a variable, TeX command, exponent or subscript is
not sufficient evidence of a complete prefixed monetary amount (`R$2x+1$`).

**Known prefixes:** match complete prefixes with a boundary before them and
longest match; do not match an arbitrary preceding letter or an identifier's
suffix. Initially support `R`, `US`, `C`, `CA`, `A`, `AU`, `NZ`, `HK`, `S`,
`SG`, `NT`, `RD`, `Mex`, `MX`, `Ch`, `CLP`, `COL`, `COP`, `ARS`, `AR`, `Cr`,
and `Cz`. Also support `U$S100` and `U$S 100`, explicitly, without the old
incorrect word-boundary condition. Numberless `Cr$` is ordinary unmatched text.
Unknown prefixes are not automatically known currencies; bare-dollar rules
still apply.

Apply these decisions in order:

1. Protected regions and escaped dollars win. Determine escape status from the
   parity of the whole preceding backslash run: odd is escaped, even is not.
   Apply this to both openers and closers.
2. A known prefixed complete amount is literal currency; its dollar cannot open
   or close dollar math. Advancing past currency must never consume a later
   equation's opening dollar.
3. For a remaining single-dollar opener, inspect the next eligible dollar on
   the same line. A known currency dollar or a dollar immediately followed by a
   digit is a pairing barrier, not a closer to skip while searching farther.
   This protects currency chains, inequalities, ranges and ratios.
4. Accept nonempty tight math under those boundary rules, including numeric
   `$5$`. For padded math retain TeX indicators and a single unspaced non-amount
   token such as `L`; support arithmetic with operands on both sides of `+`,
   `-`, `*` and `/`. The added arithmetic-only branch must match a complete
   operand/operator chain, not merely find one operator inside prose:
   `50/day and ` is not such a chain, while `a / bc` is. Preserve the existing
   TeX-indicator branch and corpus, including
   `$ ^{1} $`, `$ E_{n} $`, `$ L $` and `$ 2\gamma\hbar\omega_x $`.
   A numeric amount followed only by a trailing arithmetic separator must not
   steal the next equation's opener (`$5 + $x$`).
5. Numeric amounts left outside accepted math are literal currency, including
   amounts before prose, punctuation, rates and scale suffixes. Do not use
   lists of prose words or units to override an otherwise accepted math span.
6. A rejected numeric currency/prose opener advances locally, leaving the next
   dollar available as an opener. A rejected nonnumeric pair (`$ foo bar $`)
   is consumed as a literal pair, preventing its closer from starting bogus
   math over following prose. Do not use recursive recovery from every dollar.

Do not blanket-ban Unicode arrows, primes, quotes, multi-letter denominators,
scale-looking letters, or literal `@@` inside math. Require monotonic, bounded
work on malformed input; avoid recursive lookahead and repeated suffix scans.

### Explicit ambiguity and compatibility decisions

These proposed dialect choices require approval with the plan. They are not
claims of perfect inference:

| Source | Interpretation |
| --- | --- |
| `$5`, `$ 5`, `US$5`, `R$ 15.200,75`, `C$8,123.50` | Literal money |
| `$5$`, `$2x + 1$`, `$10^6$`, `$1/2$`, `$2/ab$`, `$2M$` | Tight math |
| `$ 5 $` | Literal, retaining the current padded-amount convention |
| `$ -5 $`, `$ a - b $`, `$ a / bc $` | Math |
| `f$2x+1$`, `R$2x+1$`, `Al$_x$Ga$_{1-x}$As`, `assuming$^29$` | Attached math |
| `R$5$` | Prefixed money wins; final dollar is literal. Use `R\(5\)` for numeric math after `R` |
| `$50/day$`, `$5 + tax$` | Ambiguous but eligible tight math; escape the money dollar for prose |
| `$5 and $x$`, `$5 + $x$` | Literal amount followed by math |
| `$50/day and $x$` | Literal rate followed by math; the rejected padded prose must not satisfy the arithmetic-only branch |
| `$x$2` | Rejected by the digit-following-closer rule; use `\(x\)2`. This is an intentional compatibility restriction |
| `The symbol $ precedes $ a + b $` | Ambiguous: `$ precedes $` meets the padded-single-token rule. Write `The symbol \$ precedes $ a + b $` |

Do not promise universal stray-dollar recovery while also treating padded single
tokens as math. Any conflict between these decisions and the existing corpus
must return to plan review before implementation, rather than accumulate
phrase-specific exceptions.

### Preview and readers: recognize math before it can be damaged

- `src/markdown.ts` consumes shared ranges while preserving `protectedAt`,
  `translateOffset`, display precedence and original source ranges. Currency
  remains text; genuine formulas remain atomic source-map fragments. Math off
  retains literal delimiters; rendering never edits the source.
- `src/paste/read-markdown.ts` protects recognized math **before** `marked` can
  interpret emphasis, links or escapes inside it, then restores math IR nodes.
  Decode Markdown escapes once. Do not recover pairs from independent decoded
  text tokens or globally unescape `\$` in `splitMath`.
- `src/paste/read-html.ts` uses decoded-text context, preserving visible
  backslashes. Neighboring inline text must provide currency boundary context
  when transparent spans split a prefix/dollar/amount. Preserve formatting and
  code boundaries. Existing KaTeX/MathML/MathJax annotations are authoritative
  math, including formulas containing `\text{\$5}`; do not reclassify them.
  General equations crossing arbitrary formatted HTML nodes are not a new goal.
- `src/paste/math.ts` delegates delimiter analysis and retains IR/TeX-to-Typst
  responsibilities. Native Typst and AsciiDoc stem readers retain their syntax.
- `scoreTypst` may exclude currency from its weak math signal, while preserving
  native Typst math evidence. Test clipboard and unsaved-buffer detection near
  scoring thresholds, including genuine Typst/AsciiDoc documents.

### Paste: minimal edits with native insertion semantics

`escapeMarkdownCurrency` inserts a backslash only before eligible unescaped
currency dollars; its detection predicate uses the same ranges. It is
idempotent and preserves every other character, including unfinished emphasis,
code, math, reference links, whitespace and line endings. Check existing size
caps before expensive analysis and preserve fallback representation/notices.

Keep `chooseSource` responsible for selecting the representation. Respect
`fromText`: classification and transformation must inspect the exact text that
will be inserted, rather than inspect Markdown MIME and insert plain text or
switch to decorative HTML. Cover Markdown-only MIME, conflicting MIME flavors,
and ordinary text-only payloads. In `planPaste`, handle normalization before
native/same-syntax early returns where applicable; do not send `source: "plain"`
to the Typst reader. Report `converted` only when text changes.

For native plain/Markdown editor pastes, normalize within the native paste
path, rather than `applyRichPaste`/`insertPasted`. The installed CodeMirror
`EditorView.clipboardInputFilter` is a synchronous hook, but it also processes
drops: gate the transform to the actual eligible paste event. Keep the plain
paste bypass alive until the filter has run; clear per-event state reliably so
the next ordinary paste is unaffected.

Preserve multiple selections, replacement, caret, leading/trailing blank lines,
indentation, linewise copy and one-step undo. CodeMirror compares its remembered
linewise copy with the **filtered** input, so adding a text-changing facet alone
can defeat linewise behavior. The editor adapter must retain the original
linewise metadata and test the result, without changing copied source.

Only normalize in Markdown prose insertion contexts. Existing math/code,
link destinations/URLs, HTML attributes and mixed protected multi-selections
retain native/literal insertion. The current code-context guard alone does not
cover math or destinations. Inspect both the snippet and destination context.
Do not transform drops, plain-paste bypass, rich paste off, or native paste into
another language. Rich HTML conversion retains its existing semantic/image path.

### Rejected alternatives

- Forbid padded math: breaks an explicit requirement and existing documents.
- Any preceding letter plus a digit means currency: breaks attached math.
- Grow prose/unit/scale dictionaries or forbidden-character lists: creates
  language-specific exceptions and rejects valid mathematics.
- Only change a body regex or `splitMath`: misses tokenization, contexts,
  representation selection and native insertion.
- Universally unescape `\$`: loses literal HTML backslashes.
- Round-trip same-syntax Markdown through the AST: rewrites unrelated markup.
- Route all changed native pastes through `insertPasted`: changes whitespace,
  block boundaries and selections.
- Recursive delimiter recovery: creates false pairings and potentially
  quadratic work without resolving genuine ambiguity.

## Steps

- [x] Capture the **old** physics/feature-tour math inventory: exact source
  ranges, TeX bodies and inline/display kind. Review conflicts with the proposed
  policy before parser edits; do not derive the baseline from the new scanner.
- [x] Add table-driven contract tests for currency, math, escaping, contexts and
  format-reader/renderer results, with independent expected outputs.
- [x] Implement shared range analysis/context handling with exact offsets and
  bounded malformed-input work.
- [x] Integrate the preview and Markdown reader before tokenization; adapt HTML
  source-context and inline-boundary handling without changing native language
  math parsers.
- [x] Implement idempotent currency escaping and representation-correct
  `planPaste` handling, including early returns, plain source and size caps.
- [x] Integrate native paste normalization, destination context, event gating
  and bypasses; prove blank-line, multi-selection, linewise and undo behavior.
- [x] Update the weak Typst signal and validate the full source/destination
  detection/conversion matrix.
- [x] Add/run isolated UI, source-map, full-corpus and native HTML-export
  regressions; retain geometry checks and report Pandoc separately.
- [x] Write the ADR and reference changes, update affected test counts in both
  AGENTS.md/README, record qualifying traps, and mark done after acceptance.

## Files and modules

Execution notes: the independent pre-change inventory is stored in
`scripts/fixtures/math-inventory.json` (292 physics formulas, 5 feature-tour
formulas; source hashes included). This data fixture is an addition to the
listed test files, not a new parser or dependency. The native clipboard hook
records normalization while returning original input; a sequential transaction
filter inserts only the escapes after CodeMirror resolves linewise and
multi-selection insertion, preserving its original clipboard metadata.

Validation adjustment: Tauri's `invoke` property is non-writable and
non-configurable, so the native save dialog cannot be stubbed in the production
webview. The export regression obtains the real shared `buildExportArticle`
output through Print's HTML artifact, executes the actual pure
`wrapStandaloneHtml` function declarations in isolation, and saves through the
real Rust `write_document` command. It checks the resulting HTML bytes; no IPC
protection is weakened. The save-picker UI itself remains outside CDP coverage.
Pairing barriers also recognize immediate signed/leading-decimal amount starts,
consistent with the approved complete-amount grammar. The weak Typst signal
retains padded numeric Typst math without changing Markdown's `$ 5 $` rule.
The preview now prepares placeholders from original ranges directly, replacing
the old `extractMath`/`protectedAt` pass; it composes placeholder and CRLF
translations through `translateOffset`. The stored physics inventory is usable
without the ignored local paper source: unit tests then validate all pinned
formula bodies/display modes, while exact original ranges/hashes are checked
whenever that source is available. `--without-optional-corpus` exercises this
fresh-checkout path with the same assertion count.

- `src/math-delimiters.ts` (new): pure shared ranges and delimiter policy.
- `src/markdown-context.ts` (new): shared raw-source protected contexts.
- `src/markdown.ts`: preview integration preserving substitutions/source maps.
- `src/paste/math.ts`: IR adapter with source-specific escape semantics.
- `src/paste/read-markdown.ts`: math protection before Markdown tokenization.
- `src/paste/read-html.ts`: decoded text and neighboring currency context.
- `src/paste/detect.ts`: representation consistency and weak Typst signal.
- `src/paste/index.ts`: minimal transform, caps, early-return/plain-source
  handling; helpers here or in the shared pure module, without duplication.
- `src/editor.ts`: native paste integration, contexts, selections and metadata.
- `src/main.ts`: paste-event/bypass policy and transform wiring.
- `src/content.ts`: correct the reference's "tight dollar pairs are always math"
  claim and document currency precedence/explicit escapes.
- `scripts/paste-convert-test.mjs`: contract matrix, readers/renderers,
  detection, contexts, parity, idempotence and malformed-input limits.
- `scripts/rich-paste-test.mjs`: native/rich UI paste, MIME priority, contexts,
  selections, whitespace, bypass clearing, drops and undo.
- `scripts/dom-smoke.mjs`: exact currency text and mixed math rendering.
- `scripts/word-sync-test.mjs`: currency/formula/following-text source ranges.
- `scripts/math-render-check.mjs`: independent full-fixture equation inventory,
  retaining font and geometry assertions.
- `scripts/export-test.mjs`: native HTML currency/math output; retain and
  separately report existing Pandoc checks.
- `AGENTS.md` and `README.md`: affected suite counts/descriptions and syntax
  notes. Update every duplicated count when adding assertions.
- `docs/adr/2026-10-21-currency-and-math-delimiters.md` (after approval):
  precedence, ambiguity, context ownership and native paste responsibility.

No dependency, settings-schema or Tauri-contract change is planned. The
Markdown dialect change itself requires explicit plan approval.

## Risks and rollback

- **Compatibility/ambiguity:** especially `R$5$`, `$x$2` and stray symbols.
  Approve/document the table first; return corpus conflicts to plan review.
- **Context drift:** partial snippets differ from complete documents. Test both
  source and destination, nested/unclosed constructs and exact bytes.
- **Content loss:** Markdown escapes and HTML backslashes differ. Test actual
  readers/renderers and odd/even runs, not only classifier functions.
- **Native paste:** filters process drops and affect linewise metadata; the rich
  insertion path trims text. These need integration checks before completion.
- **Source maps:** use original UTF-16 positions, including accents, CRLF and
  non-BMP characters. Never locate repeated amounts by searching rewritten text.
- **Latency:** analysis runs synchronously; bound work on maximum-size clipboard
  and long malformed delimiter runs. Avoid recursive recovery/rescanning.
- **Exports:** native HTML/Print share the scanner; Pandoc does not. Report
  baseline dialect limitations. Broader parity needs a scope/approval update.
- **Rollback:** revert only scoped hunks/new modules, preserving unrelated work.
  No document/settings migration is needed. Already-inserted escapes are valid
  Markdown under the old renderer; rollback must not rewrite user documents.

## Tests and validation

### Required behavioral matrix

For each amount, test it alone, in pairs (including repeated identical amounts),
in one mixed line, and before/after genuine tight and padded equations:

| Amount | Currency-only Markdown paste output | Visible preview |
| --- | --- | --- |
| `R$50` | `R\$50` | `R$50` |
| `R$ 10.000` | `R\$ 10.000` | `R$ 10.000` |
| `R$ 15.200,75` | `R\$ 15.200,75` | `R$ 15.200,75` |
| `US$5` | `US\$5` | `US$5` |
| `US$5.00` | `US\$5.00` | `US$5.00` |
| `C$8,123.50` | `C\$8,123.50` | `C$8,123.50` |

Also cover:

- Both original reported snippets, including existing escapes and unfinished
  bold:
  - `Você está autorizando uma média de **R$50/dia, R$350/semana e ~R\$1.500/mês**, e aceitando disputar cliques oferecendo **até R\$13,50 por clique`
  - `Você pode subir gradualmente (em dólares canadenses): C$5 → C$6 → C$7,50 etc. Eu evitaria começar diretamente em C$13,50.`
- Mixed bare/prefixed currencies, rates/scales, ranges/ratios, punctuation and
  arithmetic: `US$5 and US$7`, `R$50 e R$40`, `$2.00 and $3.50`,
  `$2.00–$3.50`, `$2.00-$3.50`, `$2.00/$3.50`, `$5 + $7 = $12`,
  `$10 > $5`, `It costs $50 ($40 for members)`, `"$50" or "$40"`,
  `$350/week and ~$1,500/month`, `U$S100`, signs, accounting notation,
  NBSP/narrow-NBSP, grouping spaces/apostrophes and `$.50`.
- Every ambiguity-table case, currency→math and math→currency order, multiple
  equations, table/list/link-label contexts, Unicode arrows/primes/`@@`, and
  `$a*b*c$`, `$\{x\}$`, `\(x + y\)` through the actual Markdown reader.
  Include rates before real equations (`$50/day and $x$`) to distinguish a
  complete padded arithmetic expression from prose containing a slash.
- Odd/even backslash runs at both ends, mixed escaped/unescaped currency,
  explicit/display formulas containing `\$`, LF/CRLF, soft wraps and hard
  breaks including the trailing backslash used in the user's amount list.
- All protected regions above, longer fences containing shorter ones,
  multi-backtick/indented/unclosed code, nested lists/quotes, reference links,
  and insertion inside existing code/math/URL/attribute syntax.
- Realistic MIME combinations; HTML spans splitting prefixes/dollars/amounts;
  annotated math versus literal HTML backslashes; conversion into all existing
  destination languages and native Typst/AsciiDoc math detection.
- `escape(escape(source)) === escape(source)`, exact preservation outside
  inserted backslashes, no false `converted` result, oversized fallback/notices,
  and bounded malformed-input behavior.

### Validation layers

**During this plan review:** read-only parser probes and plan structure/link
checks; remove temporary probes. Do not implement or build the draft.

**After approval:**

1. Capture the old corpus inventory before changes; run `npm run build`,
   expanded `npm run paste:convert` and relevant block/source-map unit suites.
2. Run freshly built, isolated smoke/paste/word-sync/math UI suites through the
   existing orchestrator with their required documents. Never test a stale
   binary or wrong fixture. On Windows use the documented MSVC wrappers.
3. Assert exact visible currency text with zero currency math wrappers; assert
   intended math bodies/ranges and the full independently reviewed fixture
   inventory, not only aggregate counts. KaTeX errors must not increase from
   baseline. Retain fraction/radical/font geometry checks.
4. Exercise native selection replacement, multiple selections, linewise copy,
   whitespace, caret, undo/redo and typing around paste. After each bypass,
   perform a normal paste to prove state cleared. Test drops/other languages.
5. Check both sync directions after currency, code, explicit/display math,
   repeated values, Unicode and escapes. Formulas remain atomic; monetary text
   and later words map to their exact source occurrence.
6. Inspect native HTML exports containing currency plus math; run available
   real-converter export regressions. Report Pandoc's separate reader and
   baseline limitations, rather than imply preview parity.
7. Run affected quality gates (`format:check`, `lint`, `knip`) and required
   repository regression layers. Record actual counts and reasons for skips.

## Acceptance criteria

Completion record (2026-10-21):

- `npm test -- --all`: **31/31 layers passed**, including 97 Rust tests (the
  two existing opt-in download tests remain ignored), 369 paste conversion
  checks, 107 smoke checks, 39 word-sync checks, 12 physics math checks and
  38 real-converter/native export checks. Sessions, all source-map unit layers,
  auto-close, AsciiDoc, Typst Pages, HTML, spelling, formatting, shortcuts,
  typography, tabs, Favorites, two-launch restoration, Recents, licences,
  shutdown and image-path checks passed as well.
- A final rebuild and `--only paste-convert,paste` passed 369/369 and 64/64
  after the native fast-path and URL-start insertion-boundary adjustment.
  Additional explicit drop and other-language checks then passed **68/68**
  against that same final binary (`aa7052c53343`, SHA-256 prefix).
- The corpusless conversion run passed **369/369**, proving a fresh checkout
  does not require the ignored local physics-paper source to run unit tests.
- `format:check`, `lint`, `knip`, and scoped diff whitespace checks passed.
- The 292 physics and five feature-tour formulas preserve exact original
  bodies, source ranges and display modes. The real physics webview preserves
  the complete rendered inventory and its baseline KaTeX error count, while
  retaining font/fraction/radical geometry checks.
- Native HTML article/wrapper/writer output is checked; the unchanged native
  save-picker interaction remains manual. Pandoc keeps its separate dialect,
  as scoped; no padded-dollar parity or download-installation test is claimed.

1. The six-row table and original reported snippets preserve all monetary
   spelling, spaces, separators and decimal digits, with no currency-generated
   math wrappers or source edits during rendering.
2. Eligible paste escapes only required currency dollars once; existing
   Markdown escapes and visible HTML backslashes survive correctly. The
   transform is idempotent and preserves all other source characters.
3. Tight/padded math, explicit/display forms, attached math and the full
   independently reviewed corpus inventory pass, including emphasis-shaped
   math in Markdown paste. Ambiguous cases follow the documented table.
4. Native whitespace, selections/caret, linewise copy and undo survive;
   representations, contexts, bypasses, size/fallback behavior, other languages
   and drops follow the stated contracts.
5. Source ranges work in both directions; native HTML exports agree with the
   preview. Pandoc validation is reported under its existing separate dialect.
6. Relevant unit/UI/export checks and quality gates pass, with no corpus loss
   hidden behind a threshold. Reference, ADR and test-count documentation agree.

## Open questions

None outstanding. The user's explicit implementation approval included the
documented ambiguity choices (`$x$2` and prefixed `R$5$` among them). The
independent pre-change corpus inventory was captured and preserved with no
conflicts. Broader Pandoc/preview dialect parity remains outside this scope.
