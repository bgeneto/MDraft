# Menus are organized by user intent, with one primary address per command

**Status:** accepted
**Date:** 2026-10-25

## Context

The native menu had seven top-level menus: File, Edit, Paragraph, Format, View,
Themes and Help. Paragraph combined block structure, insertion, metadata and
lists; Format combined character styling with links, images and mathematics;
File carried tab navigation and Preferences; Themes held three items while the
rest of the visual choices lived in Preferences. Pandoc and Typst installation
appeared in both Help and Export, and `Math Block` and `Display Math` exposed
two nearly identical commands whose behaviour actually differed when text was
selected. The tab strip also had asymmetric context menus: `entriesForBar()`
offered Close All Tabs while `entriesForTab()` did not.

A menu is the only discovery surface for several existing commands, so an
action that lives only in a context menu, a preference panel or an undisclosed
keyboard shortcut is effectively hidden. At the same time, a native menu cannot
show a tooltip reliably, and an enabled item that only explains after a click
that it cannot run has little discovery value.

## Decision

The menu bar has eight top-level menus, ordered by intent: File, Edit, Insert,
Format, Navigate, View, Tools and Help.

- **Insert** adds content: links, images, tables, code blocks, equations,
  callouts, rules, a table of contents, metadata and paragraphs.
- **Format** changes the role or appearance of existing text: inline emphasis,
  paragraph styles, headings, quotes, lists, task states, indentation and
  Format Document.
- **Navigate** moves between positions and destinations: line, tabs, open-tab
  list, tab order and the link or file under the cursor.
- **View** controls what is visible and how it is presented: modes, Typst
  preview, sidebar, status bar, focus/typewriter/sync, editor text size, theme,
  code colours, typography, folding and full screen.
- **Tools** owns proofing, external programs and preferences.
- **Help** owns documentation, welcome material, licences and About.
- **File** owns document lifecycle, including favorites, and **Print (opens
  browser)…** is distinct from **Export › PDF…**.

The command IDs remain stable even when an item moves or is relabelled. Every
existing accelerator stays on its command; no new accelerator is introduced by
this change. The tab context menu offers the same close family as File › Close
Tabs, including Close All Tabs, and each context keeps its own reference tab.

The menu's check marks, enabled state and conditional labels are derived from
one frontend-owned state payload. The document language, read-only flag,
selection, link under the cursor, tab position and tool availability are part
of that payload. A native `Open Tabs` submenu is repopulated from the session
store; the latest state and tab list are cached in Rust so a menu rebuild caused
by export or recent-file changes does not lose them.

Preference deep links open the existing Preferences panel at the named section.
They do not create a second settings surface.

## Consequences

Every new menu route must share execution and safety guards with the surface it
came from; a menu event is not a second implementation. Context menus remain
local shortcuts, not the primary address.

The frontend must synchronize menu state after tab changes, mode changes,
settings changes, selection changes (debounced) and menu rebuilds. Native menu
tests need an inventory probe for ordinary items, not only check items.

The Insert/Format boundary is a product rule: a future command is placed by the
user's intent, not by whether the implementation inserts a template or wraps a
selection. HTML and Typst still expose less than Markdown and AsciiDoc; the menu
disables what the current dialect cannot do rather than offering a dead action.

No localization is introduced. The interface remains English; translation is
GAP-024. macOS uses the application menu for Preferences, About and Quit; the
same commands are not duplicated in Tools and Help there.
