# Keep one document window and forward launches through a queued path boundary

**Status:** accepted
**Date:** 2026-10-25

## Context

Two launches sharing an application identifier cannot safely create independent
WebView2 environments/profiles. Explorer and command-line opening must deliver
every requested document without losing dirty buffers or startup-time events.
The approved handoff plan implemented this boundary; this record documents the
delivered architecture, not a new association-registration decision.

## Decision

Register `tauri-plugin-single-instance` before other plugins. Rust `launch.rs`
normalizes paths relative to the launching process's cwd, deduplicates them with
platform path identity, queues them before emitting `open-files`, and focuses
the existing window. `startup_files` supplies all initial paths;
`take_forwarded_paths` drains launches received before the frontend listener.

The frontend serializes path opening, focuses existing tabs and reports missing
paths without blocking valid ones. Receiving the same path from queue and event
is safe because session identity prevents duplicate tabs. A launch without paths
still focuses the existing window. Optional OS associations remain a separate
approved scope; this does not implement multi-window editing.

## Consequences

Settings, recovery and single-instance ownership share the app identifier. A
private CDP port or webview directory alone does not isolate a test executable.
The shared-identifier harness must refuse a running user instance before any
state mutation, regardless of its installation path. Concurrent audit builds
need a distinct identifier as well as a private profile. Windows's 12-check
handoff suite verifies the delivered launch behavior; it does not prove OS
association registration or a Linux native-window interaction.
