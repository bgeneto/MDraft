# Preview jobs belong to a document generation and can be cancelled

**Status:** accepted

**Date:** 2026-11-05

## Context

The worker boundary in [the preview worker ADR](2026-11-04-preview-render-worker.md)
keeps conversion off the UI thread, but a stale conversion can still occupy a
worker and delay the latest edit. Typst also starts an external process: merely
discarding its result leaves that process running, and shared temporary output
lets concurrent renders interfere with each other. Source mode and tab switches
must invalidate work that no longer owns the visible document.

The review also found that separate HTML parses can change a raw HTML tree when
an opening and closing tag lie in different Markdown chunks. The sanitizer and
its existing trust boundary remain mandatory.

## Decision

Each Markdown and AsciiDoc worker has at most one active conversion. An edit,
document or mode change resolves the obsolete request as superseded and
terminates active work; a later actual render creates a fresh worker. A worker
failure uses the synchronous fallback, but superseded work never does.
Render and deferred word-map results belong to the generation that requested
them. When a current map becomes available, it reconciles the current selection.

Typst preview requests carry an increasing generation. A backend watermark
rejects old or duplicate requests even if IPC delivers them out of order; at
most one preview process compiles at a time. The idempotent Tauri command
`cancel_typst_preview(token: u64) -> Result<(), String>` cancels previews from
that generation or earlier. Newer previews and exports are independent. Stdin
writing and stdout/stderr draining run concurrently so cancellation and timeout
can terminate and reap a child that does not read its input. Each render owns a
distinct temporary output; cleanup never removes another job's output or an
export destination. Existing `render_typst` calls with no token stay supported.

When Markdown contains raw HTML tokens, the full generated document is passed
through DOMPurify as one context so tags spanning chunks keep their tree.
Otherwise the existing yieldable batches remain. The synchronous export path
still returns HTML; the live path returns metadata without serializing its DOM.

## Consequences

- Cancellation makes the latest edit independent of the duration of a stale
  conversion, at the cost of restarting a worker on a later render. Repeated
  keystrokes do not themselves start replacement workers.
- Raw HTML can require a large, synchronous sanitizer pass. The fallback
  preserves correctness and the sanitizer policy; its latency must be measured
  on large raw-HTML documents before choosing a more complex parser.
- Typst exports may run alongside a preview, but only the preview is governed by
  the generation watermark. Output ownership and the token contract must remain
  covered by subprocess and integration tests.
- A delayed map can temporarily make word sync unavailable; once built, the
  current selection is reconciled instead of requiring another gesture.
- On the review machine, indexing source substitutions reduced the median pure
  mapped conversion of a 10.8 MB CRLF / 72,000-paragraph fixture from 14,929.6 ms
  to 1,118.0 ms over three warm runs. This is not a native UI latency guarantee.
