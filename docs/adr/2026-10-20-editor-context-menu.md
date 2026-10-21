# The editor's right-click menu owns every source action, and formatting stays in the webview

**Status:** accepted
**Date:** 2026-10-20

## Context

A previous change installed a `contextmenu` listener that added **Format
Document** and called `event.preventDefault()`. That replaced the webview's
native menu with one item, so Cut, Copy, Paste, Delete and Select All
disappeared. A listener that prevents the default owns the whole menu; adding
one command cannot leave the native commands behind.

The editor also has to coexist with two other menus. `src/spellcheck.ts` owns a
right-click on a misspelled word and calls `preventDefault()` plus
`stopPropagation()` on `view.dom`, so its suggestions win. The tab strip owns
its own menu for tab actions. The editor menu must not take either surface.

Paste is a second constraint. `navigator.clipboard.readText()` is permission
gated in WebView2, and this application has no permission prompt to grant it. A
Paste item that silently depends on that permission is a dead control. The
official Tauri clipboard plugin provides a reliable text path on every desktop
target; the web API can still be tried first for HTML and images.

## Decision

- `src/context-menu.ts` owns the source editor's right-click menu. It builds
  Undo, Redo, Cut, Copy, Paste, Delete, Select All, UPPERCASE, lowercase, Title
  Case, Toggle Single Line Comment, Duplicate Line, Move Line Up, Move Line Down
  and Format Document from the current `EditorState`.
- Formatting remains in the webview. `src/format/formatters.ts` owns the lazy
  Prettier/Typstyle imports, the snapshot rule and the transaction that applies
  a formatted document. `src/context-menu.ts` receives the format action as a
  callback because only the shell knows the open sessions.
- `src/main.ts` formats a session through one function. The active tab uses its
  live view; an inactive tab uses the stored `EditorState`, and its identity is
  checked after the asynchronous formatter resolves. A tab's context menu calls
  the same function, so it can format a document that is not on screen without
  changing the active tab.
- Clipboard text tries `navigator.clipboard` first and falls back to
  `tauri-plugin-clipboard-manager`, allowed by `clipboard-manager:allow-read-text`
  and `clipboard-manager:allow-write-text`. Paste dispatches the resulting
  `DataTransfer` as a `ClipboardEvent` on the editor, reusing the rich paste and
  image pipeline.
- The spelling plugin keeps its priority by stopping the event before the
  document-level editor listener runs. The editor menu never appears in the
  preview, sidebar or tab strip.

This record supersedes the menu-ownership sentence of
`2026-10-20-webview-formatters.md`. Its formatter decision — webview, lazy
assets, one undoable transaction, AsciiDoc excluded — remains in force.

## Consequences

- A new editor command belongs in `src/context-menu.ts`, not in a document-level
  listener that intercepts `contextmenu` for one item. A new formattable
  language still belongs in `src/format/formatters.ts`; a new session operation
  that the menu needs goes through a shell callback.
- The editor menu can offer commands in every document language, including
  AsciiDoc, while Format Document stays disabled with a reason.
- The Tauri clipboard plugin adds a Rust dependency and two capability
  permissions. If it is removed, Copy and Cut still work where the web API is
  granted, but Paste stops being reliable in WebView2.
- Background formatting changes an `EditorState` that no view is holding. The
  dirty flag and tab strip must be updated by the shell; the formatter must
  never assume `editor.view` is the target.
