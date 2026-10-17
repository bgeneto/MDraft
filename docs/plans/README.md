# Plans

A plan is written before the code, approved before the first edit, and left in
this directory with its final status.
[AGENTS.md](../../AGENTS.md#governance-and-workflow) says which changes need one;
everything below that line is implemented directly.

One file per plan, named `YYYY-MM-DD-short-slug.md` — the date it was written and
a slug that still means something in six months, such as
`2026-10-17-settings-migration.md`. Copy the template below and keep every
section: a section that does not apply says so in one line instead of
disappearing.

## Template

```markdown
# <Title>

**Status:** draft | approved | in progress | done
**Date:** YYYY-MM-DD
**ADR:** `../adr/YYYY-MM-DD-slug.md`, or "none"

## Context and goal

What is true today, what should be true afterwards, and why it matters now. Name
the symptom a user sees or the maintenance problem — not the solution.

## Scope and non-scope

What the change covers, and what a reader might assume it covers but it does
not. The non-scope is what keeps the change reviewable.

## Approach and rejected alternatives

The chosen approach in a paragraph, then each alternative and why it lost. This
is the section a reviewer reads first.

## Steps

- [ ] First step
- [ ] Second step

## Files and modules

Every file the change touches, and why each one must.

## Risks and rollback

What can break that the tests will not catch, and how to return to the current
state: the branch, the setting, the file to restore.

## Tests and validation

The layers from [Testing](../../AGENTS.md#testing) this change needs, and the one
measurement that proves it works.

## Acceptance criteria

Observable statements — "the window closes and `.window-state.json` is written",
not "close is fixed".

## Open questions

What still needs an answer, with the default if none arrives.
```
