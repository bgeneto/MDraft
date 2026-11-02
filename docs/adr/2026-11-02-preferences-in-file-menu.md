# Preferences belongs in File on Windows and Linux

**Status:** accepted
**Date:** 2026-11-02

## Context

The 2026-10-25 menu information architecture placed Preferences under Tools,
together with proofing and external programs. A reader looking for application
settings usually opens File first, as in VS Code and most Windows applications;
on macOS the platform convention is the application menu. Tools is otherwise
about the document and its toolchain, so configuration was the odd item there.

The command id, the `Ctrl+,` accelerator and the Preferences panel are already
stable. Only the menu address needs to change.

## Decision

On Windows and Linux, `file.preferences` lives at the foot of the **File** menu,
after Close Window and before Quit. On macOS it remains in the application menu
and the File menu does not duplicate it. The command id, accelerator and panel
stay unchanged.

`tools.statistics` is a document command, not configuration, so it belongs in
Tools alongside proofing and export helpers.

## Consequences

- The sentence "Tools owns proofing, external programs and preferences" in
  `2026-10-25-menu-information-architecture.md` is superseded in part by this
  record; the rest of that architecture stands.
- One primary address per command remains the rule: Preferences is not
  duplicated in File on macOS, and the menu test asserts that only one row
  exists.
- A future menu reorganization must not move Preferences back to Tools without
  superseding this record.
- The new Document Statistics item is placed by intent: it reports on the
  document, so it joins Tools rather than File's lifecycle commands.
