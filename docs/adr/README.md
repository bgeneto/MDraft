# Architecture decision records

An ADR records a decision that outlives the change that made it: where a
responsibility lives (Rust or the webview), the shape of a command or event, a
persisted format, a dependency that is now part of the product. Reasoning that
matters only until the change lands belongs in the plan, not here.

One file per decision, named `YYYY-MM-DD-short-slug.md`. ADRs are append-only:
to change a decision, write a new ADR that supersedes the old one, and add
`Superseded by` to the old one. Do not rewrite a decision to match the present.

[AGENTS.md](../../AGENTS.md#governance-and-workflow) says when one is needed.

## Template

```markdown
# <The decision, stated as a sentence>

**Status:** accepted | superseded by `YYYY-MM-DD-slug.md`
**Date:** YYYY-MM-DD

## Context

What forced a decision: the constraint, the failure, the thing that could not be
done the old way. Include what was measured — a later reader will want to check
the numbers.

## Decision

What was chosen, in the present tense.

## Consequences

What follows from it: the cost accepted, the option closed, the rule a future
change has to respect.
```
