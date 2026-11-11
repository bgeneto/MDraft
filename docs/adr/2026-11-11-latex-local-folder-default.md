# Local packages use one primary folder with an automatically created default

**Status:** accepted
**Date:** 2026-11-11
**Supersedes:** Only the default-folder setup and Preferences UI decisions in
[2026-11-10-local-texmf-libraries.md](2026-11-10-local-texmf-libraries.md).

## Context

The local-library UI exposed the backend's personal/folder distinction and
generated five action rows per root, plus a duplicate global Open action.
Configuring one custom package folder required understanding an ordered library
manager. The user approved the
[simplification plan](../plans/2026-11-11-latex-preferences-simplification.md).

## Decision

- Initialize `app_config_dir()/texmf/tex/latex/local` during per-user startup.
  New profiles and settings predating the local-library key register it with
  packages layout. Existing root lists, including an empty list, remain
  authoritative; no additional migration marker is necessary because the file
  and the presence of `latexTexmfRoots` distinguish initial setup.
- Retain the serialized `personal` kind for backwards compatibility and portable
  path resolution. It resolves to `texmf` in TDS mode and `texmf/tex/latex/local`
  in packages mode. The UI uses the same folder terminology for both kinds and
  always opens the displayed root.
- Add `setPrimary` to the existing configure action. Validate a replacement
  against the additional roots before changing the list, preserve the primary
  id and enabled state, and keep the remaining roots in order. Selecting the
  standard location retains dynamic config-relative resolution.
- The normal UI contains an enable checkbox, path, Open and Choose folder,
  layout selector and short status. Existing extra roots remain manageable in
  a collapsed disclosure; no normal Add/Create/Check/Move/Remove stack remains.
- Inspection is driven by opening the panel, configuration changes and return
  to the application, with Retry after errors. Compiler capture, freshness,
  precedence, file bounds and per-distribution wiring retain the earlier ADR.

## Consequences

The folder is ready without installer-specific per-user hooks or startup
network traffic. Startup creation errors do not block the editor; inspection
reports an unavailable default folder. Changing layout can change the default
root displayed to the reader but never moves files. Existing complete TEXMF
trees retain access to their bibliography and fonts. Additional folders are a
compatibility surface, while the common task has one visible folder.
