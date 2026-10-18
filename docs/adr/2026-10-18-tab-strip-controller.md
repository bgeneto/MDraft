# The tab strip owns its gestures; the session store owns tab order

**Status:** accepted
**Date:** 2026-10-18

## Context

A crowded strip needs overflow arrows, a right-click menu, drag reordering and
keyboard navigation. Putting those in `main.ts` would mix DOM gesture code with
the document lifecycle that file already owns, and it would leave the order
rules untestable without an application. The old renderer also rebuilt the tabs
inline and had no way to move one.

## Decision

`src/tabs.ts` owns the tab strip: rendering, overflow scrolling, the context
menu, drag and keyboard reordering, and the empty-strip menu. It receives the
session store, a callback for the active id, and callbacks for the document
actions (`activate`, `close`, `closeMany`, `save`, `saveAs`, `reveal`, `newTab`).
It never reaches into the editor.

The store gains two list operations: `move(id, index)` places a tab in its final
position, and `removeMany(ids)` removes a set and returns the survivor when the
active tab was among them. Both keep the active session valid.

## Consequences

- The shell keeps document policy: prompts, Save As, and which tab is on screen.
- The strip can be tested through the DOM without a Tauri command for every
  action, and the order rules stay in the unit suite.
- A new tab action must be added to the callbacks; the strip does not invent
  one.
- Pinning is deliberately absent, because the application has no pinned state.
  The menu offers only operations the shell can carry out.
