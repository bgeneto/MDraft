# Integrate LaTeX as a first-class MDraft language

**Status:** draft

**Date:** 2026-11-06

**ADR:** none yet; write one for the adopted language, compiler and project boundaries before merging.

## Context and goal

The [LuaLaTeX PoC](2026-11-06-wasmtex-lualatex-poc.md) demonstrates local multi-file compilation, real BibTeX, PDF reuse and a warmed offline cache on Windows and Linux. It is still experimental: LaTeX currently has no syntax colouring, completion or formatter, markup commands are deferred, and its SyncTeX interaction is not yet equivalent to the other languages.

Make LaTeX a normal MDraft document language, with the same care for editor responsiveness, small installers, privacy, editing safety and predictable interactions as the existing languages. Keep LuaLaTeX explicit and reuse the existing PDF viewer and PoC work.

## Scope and non-scope

- Recognize and edit saved and new LaTeX documents; cover open/save filters, default extension, recovery, tabs, sidebar/outline, status, source highlighting, comment/folding support where accurate, accessibility and preferences as applicable.
- Provide useful command, environment, reference, citation, package and project-file completion, respecting CodeMirror selection, undo, keyboard and accessibility conventions. Work offline for local information; never trigger a network request merely by typing.
- Implement Format Document and LaTeX-aware Insert/Format actions, including headings, inline styles, lists, tables, links, images and equations. Preserve ordinary editing, source text, undo and safe stale-event handling across menus, context menus and shortcuts.
- Complete the PDF workflow, PDF export and the established click, selection, Escape and bidirectional Sync Scroll interactions. Preserve actual project-root ownership while navigating included files. Use SyncTeX for verified line/region identity; only claim exact word matches when the selected text can be verified unambiguously.
- Harden explicit setup, verified engine assets, bounded persistent package cache, project snapshots, diagnostics, multi-file unsaved changes and offline recompilation. Document cache management, source/licence notices, missing packages and failed or unsupported inputs.
- Test classic BibTeX and document the observed `biblatex-lite` failure. Full Biber, arbitrary TeX macro expansion for path discovery, full TeX Live installation, `tlmgr`, external services and universal compatibility remain out of scope.
- Keep product identifier and name unchanged. No merge, release, remote source upload or new background/startup network request is included.

## Approach and alternatives

**Recommendation: combine the existing CodeMirror sTeX mode for syntax highlighting with the already-pinned WasmTex editor-neutral language service for completion.** Load both only for LaTeX documents, connect them through the existing language compartment and CodeMirror completion APIs, and run nontrivial project indexing in a cancellable worker. Declare the existing transitive `@codemirror/legacy-modes` dependency directly when importing it; use `StreamLanguage.define(stex)` and add correct LaTeX comment metadata. Its stream tokenizer is not a complete semantic parser: verify highlighting and folding with representative LaTeX, and add bounded handling only where needed.

| Candidate | Fit and size evidence | Decision |
| --- | --- | --- |
| [CodeMirror legacy sTeX](https://github.com/codemirror/legacy-modes/blob/main/mode/stex.js) | MIT; already installed via `@codemirror/language-data`. This checkout already builds a 3,092-byte sTeX chunk (1,174 bytes gzip). It highlights, but does not by itself offer project-aware completion or a full syntax tree. | Use as the initial highlighter; test limitations before relying on it for folding. Incremental installer size may be close to zero, but must be measured. |
| [WasmTex LSP service](https://github.com/corca-ai/wasmtex) | The pinned SDK already exposes `LatexLanguageService`, `updateFile`, and neutral completion results without Monaco. A local probe of `\\doc` returned `\\documentclass`, a snippet and an exact replacement range without network. An isolated Vite bundle of the service measured 316,985 bytes JS / 81,146 bytes gzip; this is **not** the incremental installer delta because sharing and bundling differ. | Use for completion, with a small CodeMirror adapter, cancellable worker, explicit 1-based/UTF-16 range conversion and no network-backed catalog by default. |
| [codemirror-lang-latex 0.6.1](https://github.com/TeXlyre/codemirror-lang-latex) | Native CM6/Lezer highlighting, completion, folding and more; npm reports 1,044,865 bytes unpacked and multiple CM/Lezer peers. The package is AGPL-3.0-or-later, unlike MDraft's MIT licence. | Do not adopt without an explicit licensing decision and peer/bundle measurements. Its unpacked package size is not its installer impact. |
| [lang-tex / lezer-tex](https://github.com/mathematic-inc/codemirror-tex) | The published `lang-tex@0.0.3` is deprecated, GPL-3.0-or-later, and depends on pre-1.0 `@codemirror/next` and `lezer`. | Reject for the current CM6 codebase; modernization would be a fork and a licensing change. |
| [tree-sitter-latex](https://github.com/latex-lsp/tree-sitter-latex) | A separate parser ecosystem rather than a ready CodeMirror 6 language extension. | Keep as a fallback only if the small tokenizer demonstrably fails requirements; measure runtime, bridge and binary cost first. |

For formatting, first evaluate [tex-fmt](https://github.com/WGUNDERWOOD/tex-fmt): MIT, Rust, and its current library exposes `format_file(&str, ...)`. Integrate in Rust without spawning a shell or requiring a TeX installation **only after** proving the library API, compatibility, preservation behaviour and incremental release size. Configure no line wrapping by default and avoid implicit external configuration. Compare [Badness](https://badness.dev/development/architecture) if tex-fmt fails the corpus or size targets. WasmTex's upstream documentation lists formatting as planned, so do not present its LSP as a formatter. The installer cost of either Rust formatter is currently unknown; measure it on both platforms before choosing.

## Steps

- [ ] Start from the committed PoC branch; record the baseline and unresolved PoC items. Keep new product work on a new `codex/latex-product-integration` branch, unless the user specifies otherwise.
- [ ] Add lazy sTeX highlighting and a direct dependency declaration. Verify commands, braces, comments, inline/display math, Unicode and switching tabs; add comment/fold support only when correct.
- [ ] Adapt `wasmtex/lsp` completion to CodeMirror. Synchronize bounded project snapshots and unsaved buffers, preserve snippet and replacement ranges, reject stale requests, and keep package catalogs local unless the user separately authorizes network access.
- [ ] Evaluate and integrate a formatter through the existing Format Document lifecycle; preserve verbatim, comments, math, line endings and undo, and refuse unsafe or stale edits.
- [ ] Implement and test LaTeX menu/context-menu/shortcut commands and their availability; cover image syntax, paste/drop, links, tables, headings, lists and math. Restore other languages' commands when changing tabs.
- [ ] Complete and verify exact selection correspondence where provable, click blink, Escape and Sync Scroll in both directions using the shared PDF viewer; maintain cross-file ownership and fail closed on ambiguity.
- [ ] Finish project/input security, setup, cache limits and management, offline behaviour, error reporting, PDF save freshness, licence/source availability and the deferred PoC error/lifecycle tests.
- [ ] Integrate LaTeX into new/open/save, recovery, preferences, outline, status, reading/spelling where appropriate, documentation and user-facing help. Do not present unsupported actions as available.
- [ ] Measure input responsiveness, completion latency and incremental Windows/Linux artifacts against the PoC baseline. Run the targeted checks for each change and the applicable full suite once at the end, with hidden isolated test windows and no desktop focus changes.
- [ ] Record results, decisions, remaining limitations and an ADR; update documentation and this plan before proposing product adoption.

## Files and modules

- `src/editor.ts`, `src/typst-language.ts` as pattern, new LaTeX language/completion worker modules, `src/sessions.ts`, `src/api.ts`, `src/main.ts` and `src-tauri/src/latex.rs`: editor ownership, project indexing and the Rust boundary.
- `src/typst-pdf.ts`, scroll/word-sync adapters and new LaTeX correspondence module: share PDF rendering and preserve both directions of existing Typst interaction.
- `src/format/`, `src-tauri/Cargo.toml`, `src-tauri/src/`, `src-tauri/src/menu.rs`, `src/context-menu.ts`, paste/image/link and preferences modules: safe formatting, commands and complete language availability.
- `samples/latex-poc/`, focused tests in `scripts/`, `AGENTS.md`, `docs/` and release measurements: fixtures, documentation and validation. Index every new script.

## Risks and rollback

The sTeX stream mode is not a full parser; compare it against real documents and fall back to conservative behaviour. Completion can become expensive or stale in large multi-file projects; bound indexes, isolate work and reject old replies. Formatting can change TeX semantics or verbatim content; default to no wrap and fail safely when preservation cannot be established. SyncTeX can associate one region with several lines; never select a plausible but unverified source. Engine/mirror revisions, licences, cache integrity and platform WebView behaviour still require review. Roll back individual integrations on the product branch without removing user settings, files or caches.

## Tests and validation

Use small focused checks after each change, not the entire suite at every step:

1. App-free language/completion tests: syntax categories, incomplete commands, snippets and replacement ranges, comments, Unicode/UTF-16, project references, unsaved edits, cancellation, no network, tab ownership and responsiveness.
2. Formatter corpus: verbatim/minted/listings, comments, math, macros, TikZ, tables, CRLF/BOM, no wrapping by default, idempotence, malformed input, undo, stale output and representative real documents.
3. Menu and lifecycle tests: Insert/Format syntax, disabled/stale events, shortcuts/context menus, normal editing, save/recovery and switching between all supported formats.
4. Real hidden Tauri tests on Windows and Linux: main/included project, image, fontspec, real BibTeX, PDF save, failure preservation, SyncTeX and both-direction click/selection/scroll interactions. Test a warmed restart with external traffic blocked and an uncached positive control. Never steal desktop focus; report any test that requires an interactive window instead of showing one unexpectedly.
5. Benchmark an agreed representative project and a large document against the PoC: startup, first and warm completion, p95 typing latency, memory and before/after executable, installer and cache sizes. Target no noticeable input regression and roughly ≤1 MiB additional compressed installer size; if the measurements exceed this provisional target, report the causes and options.
6. Run applicable existing Typst/PDF, menu, paste, tab and lifecycle regressions, then the repository-wide suite once before completion. Record skipped/unsupported checks and exact environments.

## Acceptance criteria

- LaTeX editing, syntax colouring, completion, formatting and the applicable menu commands work through the same product surfaces as existing languages, with safe undo and tab ownership.
- Local multi-file LuaLaTeX and BibTeX output, PDF export and verified SyncTeX interactions work on Windows and Linux; offline behaviour is limited to cached inputs and tested after restart.
- Clicking and selection follow MDraft's established behaviour without taking selections or unexpectedly scrolling; Sync Scroll works both ways when enabled, and ambiguous correspondence paints nothing.
- The app does not upload document contents or request engine/package files before explicit enablement. Tests do not steal focus or alter the user's profile.
- The release-size and responsiveness comparison is recorded, licences are preserved, required focused and final regressions pass or are explicitly identified as unavailable.

## Open questions

- Is the MIT-preserving combination above acceptable, or should AGPL-3.0-or-later components be reviewed as an explicit alternative? Default: retain MIT for MDraft-owned code and use the existing separate engine distribution.
- What installer and memory budget should be a hard release gate? Default: measure first and aim for ≤1 MiB additional compressed installer bytes beyond the PoC.
- Full Biber and complete `biblatex` remain out of scope; consider separately after the documented `biblatex-lite` failure.
