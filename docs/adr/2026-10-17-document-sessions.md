# Each open document is a session; one editor view shows the active one

**Status:** accepted
**Date:** 2026-10-17

## Context

The editor held a single buffer in module-level variables in `src/main.ts`
(`currentPath`, `dirty`, `savedContent`, and the rest) and one CodeMirror view.
Opening a file called `setDoc`, which replaced the text and, on open, the undo
history. A second window is not a substitute: every instance of this identifier
shares one WebView2 profile, and a second process fails with
`HRESULT(0x800700AA)`.

The file commands in Rust already take a path and return a result. They do not
know which document is on screen. The HTML preview store is the exception: it
holds one nonce, and a new document replaces it.

## Decision

Open documents are sessions in `src/sessions.ts`. One session is one tab. The
shell keeps a single `EditorView` and a single preview pane.

- While a tab is on screen, the view is the authority for its text.
- When the tab is hidden, the session stores that view's `EditorState` (text,
  caret, undo history) plus the editor and preview scroll offsets. Scroll is
  not part of an `EditorState`.
- Showing the tab calls `EditorView.setState` and then reapplies the global
  chrome — font size, syntax palette, focus, typewriter, spelling — because the
  restored state still carries those from the moment it was snapshotted.
- The preview is rebuilt from the source. An HTML tab that is not visible has
  no guest iframe; `PreviewStore` stays a single slot. Coming back starts a new
  nonce. Scripts in the preview start over.
- View mode, zoom, theme, focus, typewriter and sync scroll stay process-wide.
  The tab list is not written to `settings.json`.

`setLanguage` carries a generation token. The HTML and Typst grammars load
asynchronously, and a token from a tab that has since been hidden does not
install its grammar into the buffer now on screen.

## Consequences

- New, Open, a sidebar click, a recent file, a drop and `open-files` add a tab
  or focus the one that already has that path. They do not discard the buffer
  the reader is in. The first document of a launch still occupies the initial
  tab, so startup does not leave an empty tab beside the file it opened.
- Closing the last tab leaves a fresh untitled document, so the rest of the
  shell always has a buffer.
- A background HTML document does not keep running. That is the cost of leaving
  the preview scheme as one nonce.
- Two editors on screen at once, and restoring the tab list after a restart,
  are a different change. They are not implied by this one.
