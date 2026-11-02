# Palette usage is a decaying per-action score in settings.json, ranked in the frontend

**Status:** accepted
**Date:** 2026-11-02

## Context

The AI Assistant's palette opened with a **Most used** section that was a fixed
group membership: three actions carried `group: "mostUsed"` in
`src/ai/actions.ts`. Nothing was recorded, so the heading was untrue, and
because a group membership is exclusive those three actions were missing from
the categories they belong to. The only record of a request was the in-memory,
ten-entry session History, which is discarded on close and deliberately skips
stopped answers — neither a usage record nor persisted.

Two questions followed: where the counter lives, and where the ranking lives.

The frontend has no filesystem access; every persisted preference goes through
`settings.json`, written by Rust and read by the webview. The action ids exist
only in the frontend catalog and in the Rust prompt builder, which knows them as
request variants rather than as palette rows.

## Decision

A palette use is one `{ id, score, at }` entry in a new additive
`aiActionUsage` field of `settings.json`, where `score` is a use count aged by a
30-day half-life and `at` the Unix millisecond timestamp that score belongs to.
The backend validates and bounds the list (32 entries, known shape, finite
non-negative scores, no far-future timestamps) but does not know action ids and
does not rank. `src/ai/usage.ts` owns the decay, the pruning floor and the
ordering; the palette asks it for the top three at render time, padding from the
previous fixed three while nothing has been recorded. A use is recorded when a
request reaches `done` — once per opened panel, so Retry and Regenerate do not
inflate it — because Rust emits `started` before the HTTP call and a rejected
key must not count.

## Consequences

- The section follows current habits instead of a lifetime total, and no timer,
  background job or network call is involved: ranking is O(n) over at most 32
  entries at palette open, and one small settings write per completed request.
- Rust stays a dumb store, so a new or removed action needs no Rust change. The
  cost is that an unknown id survives a load until the frontend drops it; that
  is the same rule that keeps an older build's file readable.
- The list is part of the settings contract: it must stay `#[serde(default)]`,
  sanitised before `Settings` is deserialised (a malformed value must not reset
  the rest of the file), and bounded on save.
- `Most used` is a virtual group, not a membership. Every action names exactly
  one real category, and the shortcut rows repeat their category by design —
  a search hides the virtual group so a result never lists one action twice.
- A future per-parameter statistic, a decay retune or a user-visible reset is a
  change to `usage.ts` and this format, not to the transport.
