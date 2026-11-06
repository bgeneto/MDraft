# Resolve ambiguous legacy Markdown image paths only on verified local drives

**Status:** accepted

**Date:** 2026-11-06

## Context

Older Markdown can contain Windows image paths with unescaped backslashes. The
Markdown parser interprets a backslash before punctuation as an escape, so a
component such as `.codex` can lose its separator. That syntax is ambiguous:
the ordinary Markdown destination may also be intentional. A frontend path
prefix check cannot establish whether a Windows drive is local or whether a
directory is a junction.

## Decision

The renderer retains an opaque, per-render association between recognized
image tokens and at most one literal candidate. Reference definitions are
eligible only when their parsed destination identifies a unique candidate.
The ordinary Markdown destination takes precedence. The asynchronous Tauri
command `resolve_legacy_local_image(primary, candidate, document_path)` returns
an alternative only when the ordinary path is absent and the candidate is an
existing file on a fixed Windows drive with no reparse point in its checked
components. The command returns no alternative on other platforms. It performs
filesystem work on a blocking worker, rejects UNC and mapped drives, and does
not modify the document. Live preview tries it only after an image error;
export applies the same decision before rewriting paths. New Markdown image
destinations escape literal backslashes instead of depending on the fallback.

## Consequences

The fallback is intentionally incomplete: ambiguous or unrecognized syntax,
remote shares and paths traversing junctions retain ordinary Markdown
behavior. Existing valid destinations, including corrupt files, win. Checks and
the later asset load are separate filesystem operations, so another process
with access to the filesystem can change a component between them; this is not
a race-proof filesystem confinement primitive. Asset protocol permissions and
sanitization remain unchanged. Rollback removes this command and association;
the corrected serializer can be retained independently.
