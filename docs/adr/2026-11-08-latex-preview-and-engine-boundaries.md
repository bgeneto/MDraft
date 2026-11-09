# LaTeX results belong to a document revision and engine

**Status:** accepted
**Date:** 2026-11-08

## Context

LaTeX compilation can take much longer than editing, and the compiler can
produce a PDF alongside warnings or errors. Showing diagnostics or a PDF from
an earlier revision as current misleads the reader. An installed TeX engine
also runs outside the bundled WebAssembly engine's execution environment.

## Decision

Every compile and its progress, diagnostics, PDF and cancellation belong to
the captured project revision and selected engine. A superseded result cannot
replace the active preview. Warning-only output remains usable, with visible
diagnostics. A failed build does not make a partial PDF a successful result.
Auto-compilation defaults on and can be disabled; manual compilation is
explicit. The bundled engine retains its existing opt-in and cache settings.

Installed-distribution execution is a separate opt-in and must satisfy the
repository's network policy for its complete process tree before being enabled
on a platform. Engine selection never silently falls back to a different
distribution. A temporary project copy and disabled shell escape do not, by
themselves, constitute a network or filesystem sandbox.

## Consequences

- Preview status, source navigation, export and print must respect revision
  ownership; old output must be labelled as such.
- Warning counts and failure state must not be inferred solely from whether a
  PDF exists or from a message substring.
- An installed engine needs platform-specific process isolation, validation,
  cancellation and bounded project staging. If that cannot meet the policy,
  the native option stays unavailable until the policy is separately reviewed.
