//! Native application menu.
//!
//! The structure follows the user's intent rather than the implementation:
//! File / Edit / Insert / Format / Navigate / View / Tools / Help. Every custom
//! item carries a stable id; `on_event` forwards that id to the frontend as the
//! `menu` event so the UI owns the actual behaviour. Moving an item or changing
//! its label therefore does not rename its command or its accelerator.

use crate::settings::{
    default_export_formats, AppState, ExportAvailability, ExportFormat, Settings,
};
use tauri::menu::{
    CheckMenuItem, IsMenuItem, Menu, MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder,
    MenuItemKind, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Menu ids for the configured pandoc formats are prefixed with this, so
/// `on_event` and the frontend can tell them apart from built-in items.
pub const EXPORT_PREFIX: &str = "export.pandoc.";

/// Menu ids for recent files carry the path after this prefix.
///
/// The path travels in the id instead of an index: the list changes whenever a
/// file is opened, and a menu built a moment before that change must still open
/// the file whose label the reader clicked. `src/main.ts` has the same string.
pub const RECENT_PREFIX: &str = "recent.file:";

/// Stable id for the submenu, so the test probe can find it without knowing
/// where it sits in the menu tree.
const RECENT_SUBMENU_ID: &str = "file.openRecent";

/// Menu ids for the open tabs listed under Navigate carry the session id after
/// this prefix. The path travels in the id for the same reason the recent paths
/// do: the list changes while the menu is open, and the clicked row must name the
/// document it was built for, not its old position.
pub const OPEN_TAB_PREFIX: &str = "navigate.tab:";

const OPEN_TABS_SUBMENU_ID: &str = "navigate.openTabs";
const OPEN_TABS_EMPTY_ID: &str = "navigate.openTabs.empty";

/// The editor palettes offered under View › Code Colors.
///
/// Kept in step with `src/syntax-themes.ts`; the preference resolves unknown or
/// legacy ids to a concrete palette, so an added palette here is a menu entry and
/// not a settings migration.
const SYNTAX_THEMES: &[(&str, &str)] = &[
    ("auto", "Follow Theme"),
    ("paper", "Paper"),
    ("ink", "Ink"),
    ("catppuccin-latte", "Catppuccin Latte"),
    ("github-dark", "GitHub Dark"),
    ("one-dark", "One Dark"),
    ("solarized-light", "Solarized Light"),
    ("solarized-dark", "Solarized Dark"),
    ("nord", "Nord"),
];

/// Longest path shown in the menu, in characters.
///
/// Native menu items do not wrap. A path longer than this is middle-ellipsized
/// so the file name stays visible, which is the part a reader scans for.
const RECENT_LABEL_MAX: usize = 88;

/// Most recent paths the native submenu lists.
///
/// The persisted list and the sidebar keep a longer history; a menu is a
/// quick-pick, not a library, and a 100-row native popup is unusable.
const RECENT_MENU_LIMIT: usize = 20;

/// The export targets to list, falling back to the built-in set.
///
/// The menu is constructed while the application is still being built, which
/// may be before `AppState` is managed, so a missing state is expected rather
/// than exceptional. An empty list from a user who deleted every format is also
/// honoured: they get the HTML entry and nothing else.
fn export_formats<R: Runtime>(app: &AppHandle<R>) -> Vec<crate::settings::ExportFormat> {
    app.try_state::<AppState>()
        .and_then(|state| state.settings.lock().ok().map(|s| s.export_formats.clone()))
        .unwrap_or_else(default_export_formats)
}

/// The last tool availability the frontend reported.
///
/// `None` on both fields is the state before the first check: the menu keeps
/// every format enabled rather than guessing that a working tool is missing.
fn export_availability<R: Runtime>(app: &AppHandle<R>) -> ExportAvailability {
    app.try_state::<AppState>()
        .and_then(|state| {
            state
                .export_availability
                .lock()
                .ok()
                .map(|availability| *availability)
        })
        .unwrap_or_default()
}

/// A format label that says why the item is disabled.
///
/// The suffix is part of the label rather than a tooltip because a native menu
/// item does not show a tooltip reliably. It is deliberately short: the submenu
/// still has to fit the format's own name and its accelerator column.
fn export_label(format: &ExportFormat, availability: ExportAvailability) -> String {
    let base = plain_label(&format.label);
    // A default label gets the ellipsis the save dialog earns; a label the reader
    // wrote is left exactly as written. Appending punctuation to a custom name
    // would be a menu changing the reader's words.
    let default_label = default_export_formats()
        .into_iter()
        .any(|entry| entry.id == format.id && entry.label == format.label);
    let base = if default_label && !base.ends_with('…') && !base.ends_with("...") {
        format!("{base}…")
    } else {
        base
    };
    match availability.pandoc {
        Some(false) => format!("{base} — needs Pandoc"),
        Some(true) if is_pandoc_pdf(format) && availability.typst == Some(false) => {
            format!("{base} — needs Typst")
        }
        _ => base,
    }
}

/// Whether a configured export target is the built-in pandoc PDF.
///
/// The menu does not draw this row at the position the stored list gives it: it
/// belongs beside the two native PDF rows, where a reader looking for a PDF
/// expects it. The id, not the label, is what identifies it, so a renamed label
/// or custom arguments keep the row in the same place.
fn is_pandoc_pdf(format: &ExportFormat) -> bool {
    format.id.eq_ignore_ascii_case("pdf")
}

/// Whether this format can run with the tools that are installed.
///
/// PDF is the one format that also needs Typst; every other pandoc target reads
/// Markdown and writes a file, so Pandoc alone is enough.
fn export_enabled(format: &ExportFormat, availability: ExportAvailability) -> bool {
    availability.pandoc.unwrap_or(true)
        && (!is_pandoc_pdf(format) || availability.typst.unwrap_or(true))
}

/// A menu label safe to hand to the platform backends.
///
/// An `&` starts a keyboard mnemonic on Windows and Linux, so a label the user
/// typed containing one would silently swallow the next character.
fn plain_label(label: &str) -> String {
    label.replace('&', "&&")
}

// ---------------------------------------------------------------------------
// Open Recent
// ---------------------------------------------------------------------------

const RECENT_EMPTY_ID: &str = "recent.empty";
const RECENT_CLEAR_ID: &str = "recent.clear";

/// The persisted recent files, capped at the store's limit.
///
/// The sidebar keeps this longer list and scrolls; the menu applies its own
/// smaller slice in `recent_entries`. The menu is built while `AppState` may not
/// be managed yet, which is why the read is fallible.
fn recent_files<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    let mut files = app
        .try_state::<AppState>()
        .and_then(|state| {
            state
                .settings
                .lock()
                .ok()
                .map(|settings| settings.recent_files.clone())
        })
        .unwrap_or_default();
    files.truncate(crate::settings::MAX_RECENT);
    files
}

/// Middle-ellipsize a path, keeping its file name visible.
///
/// A native menu does not wrap, and a full path can easily be wider than the
/// screen. Truncating at the end would hide the one part that identifies the
/// document, so the tail (the file name) is preserved and the middle is cut.
fn ellipsize_path(path: &str, max: usize) -> String {
    if max <= 1 {
        return "…".to_string();
    }
    let chars: Vec<char> = path.chars().collect();
    if chars.len() <= max {
        return path.to_string();
    }

    let name_start = chars
        .iter()
        .rposition(|c| *c == '\\' || *c == '/')
        .map(|index| index + 1)
        .unwrap_or(0);
    let name_len = chars.len() - name_start;
    let keep = max - 1;

    if name_len >= keep {
        // The file name alone is at the limit; keep its tail rather than a head
        // that would consist only of a directory.
        let tail: String = chars[chars.len() - keep..].iter().collect();
        return format!("…{tail}");
    }

    let head: String = chars[..max - name_len - 1].iter().collect();
    let name: String = chars[name_start..].iter().collect();
    format!("{head}…{name}")
}

fn recent_label(path: &str) -> String {
    plain_label(&ellipsize_path(path, RECENT_LABEL_MAX))
}

/// One row of the generated submenu, before it is turned into a native item.
///
/// Kept pure so the id/label/enabled rules can be tested without a window.
#[derive(Debug, Clone, PartialEq)]
struct RecentEntry {
    id: String,
    label: String,
    enabled: bool,
}

fn recent_entries(files: &[String]) -> Vec<RecentEntry> {
    if files.is_empty() {
        return vec![RecentEntry {
            id: RECENT_EMPTY_ID.into(),
            label: "No Recent Files".into(),
            enabled: false,
        }];
    }

    let mut entries: Vec<RecentEntry> = files
        .iter()
        .take(RECENT_MENU_LIMIT)
        .map(|path| RecentEntry {
            id: format!("{RECENT_PREFIX}{path}"),
            label: recent_label(path),
            enabled: true,
        })
        .collect();
    entries.push(RecentEntry {
        id: RECENT_CLEAR_ID.into(),
        label: "Clear Items".into(),
        enabled: true,
    });
    entries
}

/// Build the submenu from the list as it is right now.
fn recent_submenu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    let entries = recent_entries(&recent_files(app));
    let mut builder = SubmenuBuilder::with_id(app, RECENT_SUBMENU_ID, "Open Recent");

    for entry in &entries {
        // The Clear row is set apart from the file rows; the empty row is not.
        if entry.id == RECENT_CLEAR_ID {
            builder = builder.separator();
        }
        let built = MenuItemBuilder::with_id(entry.id.as_str(), entry.label.as_str()).build(app)?;
        built.set_enabled(entry.enabled)?;
        builder = builder.item(&built);
    }

    builder.build()
}

use std::sync::Mutex;

/// Every accelerator the menu actually registered, as `(menu id, accelerator)`.
///
/// Collected while the menu is built rather than written out a second time, so
/// the list the window shows and the list the frontend honours cannot disagree.
///
/// Why the frontend needs it at all: **Tauri 2 does not translate menu
/// accelerators on Windows.** muda documents that the application's message loop
/// must call `TranslateAcceleratorW` with the menu's `haccel()`, and neither
/// `wry` 0.57 nor `tao` 0.37 nor `tauri-runtime-wry` 2.12 ever calls it. The
/// result is a menu that prints "Ctrl+N" beside *New* and does nothing when you
/// press it — while the Edit entries appear to work only because Ctrl+Z/X/C/V/A
/// are Chromium's own commands, handled inside the webview. The frontend
/// therefore binds the shortcuts itself, from this list.
static ACCELERATORS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

/// The registered accelerators, for the frontend's key handler.
#[tauri::command]
pub fn accelerators() -> Vec<Shortcut> {
    ACCELERATORS
        .lock()
        .map(|list| {
            list.iter()
                .map(|(id, accelerator)| Shortcut {
                    id: id.clone(),
                    accelerator: accelerator.clone(),
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(serde::Serialize)]
pub struct Shortcut {
    pub id: String,
    pub accelerator: String,
}

/// The state every checkable menu item mirrors.
///
/// The frontend owns this: it is the only side that knows whether the window is
/// fullscreen, and it already owns the settings-backed modes. It sends the whole
/// struct after every layout change instead of letting the two sides derive the
/// same booleans separately — a menu that is right at start-up and stale after
/// the first toggle is worse than no check mark at all.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MenuState {
    pub view_mode: String,
    pub sidebar_visible: bool,
    pub sidebar_tab: String,
    pub show_status_bar: bool,
    pub focus_mode: bool,
    pub typewriter_mode: bool,
    pub sync_scroll: bool,
    pub theme: String,
    pub auto_save: bool,
    pub fullscreen: bool,
    /// The document on screen. Drives which commands this dialect can run.
    pub document_language: String,
    pub read_only: bool,
    pub has_selection: bool,
    pub has_comment_syntax: bool,
    /// Empty when the caret is not on a target; otherwise a `LinkKind`
    /// (`external`, `anchor`, `file`, `image`).
    pub link_kind: String,
    pub can_format: bool,
    pub tab_count: usize,
    pub tab_index: usize,
    pub unchanged_other_tabs: usize,
    pub has_path: bool,
    pub is_favorite: bool,
    pub can_fold: bool,
    pub spellcheck: bool,
    pub spellcheck_available: bool,
    pub syntax_theme: String,
    pub typst_view: String,
    pub typst_available: bool,
}

impl Default for MenuState {
    fn default() -> Self {
        Self::from_settings(&Settings::default())
    }
}

impl MenuState {
    /// The settings-backed part of the state.
    ///
    /// `fullscreen` is not a persisted setting, so a caller that can see the
    /// window must fill it in; the default is "not fullscreen", which is what a
    /// freshly built menu should show. The document-dependent fields start from
    /// the safe defaults and are replaced by the frontend immediately after the
    /// first paint.
    pub fn from_settings(settings: &crate::settings::Settings) -> Self {
        Self {
            view_mode: settings.view_mode.clone(),
            sidebar_visible: settings.sidebar_visible,
            sidebar_tab: settings.sidebar_tab.clone(),
            show_status_bar: settings.show_status_bar,
            focus_mode: settings.focus_mode,
            typewriter_mode: settings.typewriter_mode,
            sync_scroll: settings.sync_scroll,
            theme: settings.theme.clone(),
            auto_save: settings.auto_save,
            fullscreen: false,
            document_language: "markdown".into(),
            read_only: false,
            has_selection: false,
            has_comment_syntax: false,
            link_kind: String::new(),
            can_format: true,
            tab_count: 1,
            tab_index: 0,
            unchanged_other_tabs: 0,
            has_path: false,
            is_favorite: false,
            can_fold: true,
            spellcheck: settings.spellcheck,
            spellcheck_available: true,
            syntax_theme: settings.syntax_theme.clone(),
            typst_view: settings.typst_view.clone(),
            typst_available: true,
        }
    }

    /// Merge settings that changed since this state was last reported.
    ///
    /// `rebuild` runs when export formats or recent files change, and those
    /// settings are saved from the frontend at the same time as this state. The
    /// document-dependent fields must survive that rebuild; the settings-backed
    /// ones must not be stale, which is why they are copied from `settings`
    /// rather than from the cached payload.
    fn with_settings(mut self, settings: &crate::settings::Settings) -> Self {
        let fresh = Self::from_settings(settings);
        self.view_mode = fresh.view_mode;
        self.sidebar_visible = fresh.sidebar_visible;
        self.sidebar_tab = fresh.sidebar_tab;
        self.show_status_bar = fresh.show_status_bar;
        self.focus_mode = fresh.focus_mode;
        self.typewriter_mode = fresh.typewriter_mode;
        self.sync_scroll = fresh.sync_scroll;
        self.theme = fresh.theme;
        self.auto_save = fresh.auto_save;
        self.spellcheck = fresh.spellcheck;
        self.syntax_theme = fresh.syntax_theme;
        self.typst_view = fresh.typst_view;
        self
    }
}

/// Every checkable id, in the order `menu_state` reports them.
///
/// `sync` walks this list; an item added to the menu but not here is built with
/// its start-up state and then never changes.
const CHECK_IDS: &[&str] = &[
    "file.autoSave",
    "view.source",
    "view.split",
    "view.preview",
    "view.typstDocument",
    "view.typstPages",
    "view.sidebar",
    "view.outline",
    "view.favorites",
    "view.recent",
    "view.statusBar",
    "view.focus",
    "view.typewriter",
    "view.syncScroll",
    "view.fullscreen",
    "view.syntax.auto",
    "view.syntax.paper",
    "view.syntax.ink",
    "view.syntax.catppuccin-latte",
    "view.syntax.github-dark",
    "view.syntax.one-dark",
    "view.syntax.solarized-light",
    "view.syntax.solarized-dark",
    "view.syntax.nord",
    "themes.system",
    "themes.light",
    "themes.dark",
    "tools.spellcheck",
];

/// A legacy palette id some `settings.json` files still carry.
fn normalized_syntax_theme(id: &str) -> &str {
    if id == "github-light" {
        "catppuccin-latte"
    } else {
        id
    }
}

/// Whether one checkable item is on.
///
/// One table for the initial menu and for every later update, so a mode cannot
/// be wired into the menu and forgotten by the synchroniser.
fn is_checked(state: &MenuState, id: &str) -> bool {
    match id {
        "file.autoSave" => state.auto_save,
        "view.source" => state.view_mode == "source",
        "view.split" => state.view_mode == "split",
        "view.preview" => state.view_mode == "preview",
        "view.typstDocument" => state.document_language == "typst" && state.typst_view == "document",
        "view.typstPages" => state.document_language == "typst" && state.typst_view == "pages",
        "view.sidebar" => state.sidebar_visible && !state.focus_mode,
        "view.outline" => {
            state.sidebar_visible && !state.focus_mode && state.sidebar_tab == "outline"
        }
        "view.favorites" => {
            state.sidebar_visible && !state.focus_mode && state.sidebar_tab == "favorites"
        }
        "view.recent" => {
            state.sidebar_visible && !state.focus_mode && state.sidebar_tab == "recent"
        }
        "view.statusBar" => state.show_status_bar,
        "view.focus" => state.focus_mode,
        "view.typewriter" => state.typewriter_mode,
        "view.syncScroll" => state.sync_scroll,
        "view.fullscreen" => state.fullscreen,
        "tools.spellcheck" => state.spellcheck,
        "themes.system" => state.theme == "system",
        "themes.light" => state.theme == "light",
        "themes.dark" => state.theme == "dark",
        other => {
            if let Some(theme) = other.strip_prefix("view.syntax.") {
                normalized_syntax_theme(&state.syntax_theme) == theme
            } else {
                false
            }
        }
    }
}

/// Whether one ordinary or check item is available in the current context.
///
/// Returning `None` leaves an item alone: predefined items are owned by the
/// platform, and an id this function does not know must not be disabled by
/// accident. The handler still validates the context, because a stale menu or a
/// keyboard route can outlive the state that disabled it.
fn enabled_for(state: &MenuState, id: &str) -> Option<bool> {
    let writable = !state.read_only;
    let html = state.document_language == "html";
    let typst = state.document_language == "typst";
    let markdown = state.document_language == "markdown";
    let asciidoc = state.document_language == "asciidoc";
    let task_language = !html && !typst;
    Some(match id {
        "file.reload" | "file.reveal" | "file.favorite" => state.has_path,
        // Native printing and the direct PDF writer have no article for Typst:
        // that language already compiles a PDF through Export › PDF (via
        // Typst). The browser route stays available for every language.
        "file.print" | "export.pdf" => !typst,
        "export.pdf.browser" => true,
        "file.close" | "file.closeAll" => true,
        "file.closeOthers" => state.tab_count > 1,
        "file.closeLeft" => state.tab_index > 0,
        "file.closeRight" => state.tab_index + 1 < state.tab_count,
        "file.closeUnchanged" => state.unchanged_other_tabs > 0,
        "edit.delete" | "edit.selectAllOccurrences" => writable && state.has_selection,
        "edit.selectNext" => writable,
        "edit.uppercase" | "edit.lowercase" | "edit.titleCase" => writable && state.has_selection,
        "edit.duplicateLine" | "edit.moveLineUp" | "edit.moveLineDown" => writable,
        "edit.comment" => writable && state.has_comment_syntax,
        "edit.pastePlain" => true,
        "edit.selectOccurrences" | "edit.convertSelection" | "edit.lines" => writable,
        "format.document" => state.can_format,
        "format.bold" | "format.italic" | "format.strike" | "format.code" | "format.link"
        | "format.image" => writable,
        "format.math" | "para.mathBlock" => writable && !html,
        "format.paragraphStyle" => writable && !html,
        "format.lists" => writable,
        "format.tasks" | "insert.alerts" => writable && task_language,
        "para.task" | "para.taskDone" | "para.taskTodo" | "para.taskPlain" => {
            writable && task_language
        }
        "para.alertNote" | "para.alertTip" | "para.alertImportant" | "para.alertWarning"
        | "para.alertCaution" => writable && task_language,
        "para.yaml" => writable && (markdown || asciidoc),
        "para.toc" => writable && !html,
        "para.h1" | "para.h2" | "para.h3" | "para.h4" | "para.h5" | "para.h6"
        | "para.paragraph" | "para.increaseHeading" | "para.decreaseHeading" => writable && !html,
        "para.quote" | "para.ol" | "para.ul" | "para.indent" | "para.outdent"
        | "para.insertBefore" | "para.insertAfter" | "para.table" | "para.codeBlock"
        | "para.hr" => writable,
        "view.zoomIn" | "view.zoomOut" | "view.zoomReset" | "view.editorTextSize" => true,
        "view.syncScroll" => state.view_mode == "split",
        "view.sidebar" | "view.outline" | "view.favorites" | "view.recent"
        | "view.sidebarPanel" => !state.focus_mode,
        "view.typstPreview" | "view.typstDocument" | "view.typstPages" => {
            typst && state.typst_available
        }
        "view.foldCurrent" | "view.unfoldCurrent" | "view.foldAll" | "view.unfoldAll"
        | "view.blocks" => state.can_fold,
        "navigate.moveTabLeft" => state.tab_index > 0,
        "navigate.moveTabRight" => state.tab_index + 1 < state.tab_count,
        "navigate.openTarget" => !state.link_kind.is_empty(),
        "tools.spellcheck" => !html && state.spellcheck_available,
        "file.new" | "file.open" | "file.save" | "file.saveAs" | "file.autoSave"
        | "file.export" | "file.closeTabs" | "file.preferences" | "file.nextTab"
        | "file.prevTab" | "file.openRecent" | "edit.find" | "edit.replace"
        | "edit.findNext" | "edit.findPrevious" | "view.source" | "view.split"
        | "view.preview" | "view.statusBar" | "view.focus" | "view.typewriter"
        | "view.fullscreen" | "view.interfaceTheme" | "view.codeColors"
        | "view.typography" | "navigate.gotoLine" | "navigate.openTabs"
        | "tools.spellLanguage" | "tools.exportConfig" | "tools.pandoc" | "tools.typst"
        | "tools.ai" => true,
        _ if id.starts_with("view.syntax.")
            || id.starts_with("themes.")
            || id.starts_with("help.") =>
        {
            true
        }
        // Export formats, recent rows and generated tab rows own their own
        // enabled state. Returning a value here would overwrite the tool check
        // or the list builder on the next menu-state sync.
        _ => return None,
    })
}

/// A label that depends on the document or on the reader's state.
///
/// Ordinary items keep the label they were built with; `None` means "leave it".
fn label_for(state: &MenuState, id: &str) -> Option<String> {
    let text = match id {
        "file.favorite" => {
            if state.is_favorite {
                "Remove from Favorites"
            } else {
                "Add to Favorites"
            }
        }
        "para.yaml" => match state.document_language.as_str() {
            "asciidoc" => "Document Attributes",
            "markdown" => "YAML Front Matter",
            _ => "Document Metadata",
        },
        "navigate.openTarget" => match state.link_kind.as_str() {
            "file" => "Open File Under Cursor",
            "image" => "Open Image Under Cursor",
            "anchor" => "Go to Heading Under Cursor",
            _ => "Open Link Under Cursor",
        },
        "file.print" if state.document_language == "typst" => {
            "Print… (use PDF via Typst)"
        }
        "export.pdf" if state.document_language == "typst" => {
            "PDF… (use PDF via Typst)"
        }
        "view.typstPreview"
            if state.document_language == "typst" && !state.typst_available =>
        {
            "Typst Preview — needs Typst"
        }
        _ => return None,
    };
    Some(text.to_string())
}

/// One row of Navigate › Open Tabs.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTabItem {
    pub id: String,
    pub label: String,
    pub checked: bool,
}

/// The frontend's latest menu state, kept across `rebuild`.
///
/// The menu is rebuilt when export formats or recent files change. Deriving the
/// document-dependent fields again from settings would lose them, so the cached
/// payload supplies those and `with_settings` refreshes the settings-backed ones.
static LAST_MENU_STATE: Mutex<Option<MenuState>> = Mutex::new(None);

/// The latest open-tab list, so a rebuild keeps Navigate › Open Tabs populated.
static OPEN_TABS: Mutex<Vec<OpenTabItem>> = Mutex::new(Vec::new());

pub fn build<R: Runtime>(app: &AppHandle<R>, state: &MenuState) -> tauri::Result<Menu<R>> {
    // The menu is rebuilt whenever the export formats change, so the registry is
    // reset here; appending would accumulate duplicates.
    if let Ok(mut list) = ACCELERATORS.lock() {
        list.clear();
    }

    // The frontend reports this once it has asked pandoc and typst. Until then
    // every format is enabled and unannotated, because hiding a working format
    // on a guess is worse than showing one that will explain itself on click.
    let availability = export_availability(app);

    // Accelerator strings are parsed by the platform menu backend; a name it does
    // not recognise would otherwise abort the whole build. Register the item
    // without a shortcut and report it instead.
    let item = |id: &str, label: &str, accel: Option<&str>| -> tauri::Result<MenuItem<R>> {
        let attempt = |with: Option<&str>| {
            let mut builder = MenuItemBuilder::with_id(id, label);
            if let Some(a) = with {
                builder = builder.accelerator(a);
            }
            builder.build(app)
        };
        match attempt(accel) {
            Ok(built) => {
                // Recorded only once the backend accepted it: a rejected string
                // means the menu carries no shortcut, and the frontend must not
                // pretend otherwise.
                if let Some(a) = accel
                    && let Ok(mut list) = ACCELERATORS.lock()
                {
                    list.push((id.to_string(), a.to_string()));
                }
                Ok(built)
            }
            Err(error) if accel.is_some() => {
                eprintln!(
                    "[menu] accelerator {accel:?} for {id} was rejected ({error}); registering without it"
                );
                attempt(None)
            }
            Err(error) => Err(error),
        }
    };

    // The same shape as `item`, plus a check state. The accelerator must still be
    // recorded in ACCELERATORS: F8, F9 and the sidebar and tab shortcuts are
    // carried by check items, and losing them here would silently kill the
    // frontend bindings that make those keys work on Windows.
    let check = |id: &str, label: &str, accel: Option<&str>| -> tauri::Result<CheckMenuItem<R>> {
        let attempt = |with: Option<&str>| {
            CheckMenuItem::with_id(app, id, label, true, is_checked(state, id), with)
        };
        match attempt(accel) {
            Ok(built) => {
                if let Some(a) = accel
                    && let Ok(mut list) = ACCELERATORS.lock()
                {
                    list.push((id.to_string(), a.to_string()));
                }
                Ok(built)
            }
            Err(error) if accel.is_some() => {
                eprintln!(
                    "[menu] accelerator {accel:?} for {id} was rejected ({error}); registering without it"
                );
                attempt(None)
            }
            Err(error) => Err(error),
        }
    };

    // Generated open-tab rows carry their own checked state: their ids are not in
    // CHECK_IDS (the session list is the source of truth), so `is_checked` must
    // not decide them.
    let check_raw = |id: &str, label: &str, checked: bool| -> tauri::Result<CheckMenuItem<R>> {
        CheckMenuItem::with_id(app, id, label, true, checked, None::<&str>)
    };

    // ---- File -------------------------------------------------------------
    // The export submenu is built from settings, so the entries a user adds in
    // Preferences appear here without any further wiring. HTML is native: it is
    // written by the application from its own preview pipeline. The other rows
    // are pandoc formats. PDF is the application's own article; the browser row
    // stays visible because a document whose scripts the native surface refuses
    // still has a working print route.
    let export_item = |format: &ExportFormat| -> tauri::Result<MenuItem<R>> {
        let id = format!("{EXPORT_PREFIX}{}", format.id);
        let built = item(&id, &export_label(format, availability), None)?;
        if !export_enabled(format, availability) {
            built.set_enabled(false)?;
        }
        Ok(built)
    };
    // The pandoc PDF is listed with the two native PDF rows rather than at its
    // stored position: a reader looking for a PDF then finds all three routes in
    // one place instead of scanning the whole pandoc list. Every other target
    // keeps the order arranged in Preferences.
    let (pandoc_pdf, other_formats): (Vec<ExportFormat>, Vec<ExportFormat>) =
        export_formats(app).into_iter().partition(is_pandoc_pdf);
    let mut export = SubmenuBuilder::with_id(app, "file.export", "Export")
        .item(&item("export.html", "HTML…", None)?);
    for format in &other_formats {
        export = export.item(&export_item(format)?);
    }
    let mut export = export
        .separator()
        .item(&item("export.pdf", "PDF…", None)?);
    for format in &pandoc_pdf {
        export = export.item(&export_item(format)?);
    }
    let export = export
        .item(&item("export.pdf.browser", "PDF (opens browser)…", None)?)
        .build()?;

    let close_tabs = SubmenuBuilder::with_id(app, "file.closeTabs", "Close Tabs")
        .item(&item("file.closeOthers", "Other Tabs", None)?)
        .item(&item("file.closeLeft", "Tabs to the Left", None)?)
        .item(&item("file.closeRight", "Tabs to the Right", None)?)
        .item(&item(
            "file.closeUnchanged",
            "Other Unchanged Tabs",
            None,
        )?)
        .separator()
        .item(&item("file.closeAll", "All Tabs", None)?)
        .build()?;

    let recent = recent_submenu(app)?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&item("file.new", "New Document", Some("CmdOrCtrl+N"))?)
        .item(&item("file.open", "Open…", Some("CmdOrCtrl+O"))?)
        .item(&recent)
        .separator()
        .item(&item("file.save", "Save", Some("CmdOrCtrl+S"))?)
        .item(&item("file.saveAs", "Save As…", Some("CmdOrCtrl+Shift+S"))?)
        .item(&check("file.autoSave", "Auto Save", None)?)
        .item(&item("file.reload", "Reload from Disk", None)?)
        .separator()
        .item(&item(
            "file.print",
            "Print…",
            Some("CmdOrCtrl+P"),
        )?)
        .item(&export)
        .separator()
        .item(&item("file.reveal", "Show in Folder", None)?)
        .item(&item("file.favorite", "Add to Favorites", None)?)
        .separator()
        .item(&item("file.close", "Close Tab", Some("CmdOrCtrl+W"))?)
        .item(&close_tabs)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None)?);

    #[cfg(not(target_os = "macos"))]
    let file = file.item(&PredefinedMenuItem::quit(app, None)?);
    let file = file.build()?;

    // ---- Edit -------------------------------------------------------------
    // Undo/redo/cut/copy/paste/select-all are predefined so the webview handles
    // them natively; the rest are custom because the editor owns them.
    let select_occurrences =
        SubmenuBuilder::with_id(app, "edit.selectOccurrences", "Select Occurrences")
            .item(&item(
                "edit.selectNext",
                "Select Next Occurrence",
                None,
            )?)
            .item(&item(
                "edit.selectAllOccurrences",
                "Select All Occurrences",
                None,
            )?)
            .build()?;

    let convert_selection =
        SubmenuBuilder::with_id(app, "edit.convertSelection", "Convert Selection")
            .item(&item("edit.uppercase", "UPPERCASE", None)?)
            .item(&item("edit.lowercase", "lowercase", None)?)
            .item(&item("edit.titleCase", "Title Case", None)?)
            .build()?;

    let lines = SubmenuBuilder::with_id(app, "edit.lines", "Lines")
        .item(&item("edit.duplicateLine", "Duplicate Line", None)?)
        .item(&item("edit.moveLineUp", "Move Line Up", None)?)
        .item(&item("edit.moveLineDown", "Move Line Down", None)?)
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&item("edit.pastePlain", "Paste without Formatting", None)?)
        .item(&item("edit.delete", "Delete Selection", None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .separator()
        .item(&item("edit.find", "Find", Some("CmdOrCtrl+F"))?)
        .item(&item("edit.replace", "Find and Replace", Some("CmdOrCtrl+H"))?)
        .item(&item("edit.findNext", "Find Next", None)?)
        .item(&item("edit.findPrevious", "Find Previous", None)?)
        .item(&select_occurrences)
        .separator()
        .item(&convert_selection)
        .item(&lines)
        .item(&item("edit.comment", "Toggle Comment", None)?)
        .build()?;

    // ---- Insert -----------------------------------------------------------
    let alert = SubmenuBuilder::with_id(app, "insert.alerts", "Alert Block")
        .item(&item("para.alertNote", "Note", None)?)
        .item(&item("para.alertTip", "Tip", None)?)
        .item(&item("para.alertImportant", "Important", None)?)
        .item(&item("para.alertWarning", "Warning", None)?)
        .item(&item("para.alertCaution", "Caution", None)?)
        .build()?;

    let insert = SubmenuBuilder::new(app, "Insert")
        .item(&item("format.link", "Link", Some("CmdOrCtrl+K"))?)
        .item(&item("format.image", "Image", Some("CmdOrCtrl+Shift+I"))?)
        .item(&item("para.table", "Table", Some("CmdOrCtrl+T"))?)
        .separator()
        .item(&item(
            "para.codeBlock",
            "Code Block",
            Some("CmdOrCtrl+Shift+K"),
        )?)
        .item(&item("format.math", "Inline Equation", None)?)
        .item(&item(
            "para.mathBlock",
            "Block Equation",
            Some("CmdOrCtrl+Shift+M"),
        )?)
        .item(&alert)
        .separator()
        .item(&item("para.hr", "Horizontal Line", None)?)
        .item(&item("para.toc", "Table of Contents", None)?)
        .item(&item("para.yaml", "Document Metadata", None)?)
        .separator()
        .item(&item("para.insertBefore", "Paragraph Before", None)?)
        .item(&item("para.insertAfter", "Paragraph After", None)?)
        .build()?;

    // ---- Format -----------------------------------------------------------
    let paragraph_style =
        SubmenuBuilder::with_id(app, "format.paragraphStyle", "Paragraph Style")
            .item(&item(
                "para.paragraph",
                "Normal",
                Some("CmdOrCtrl+0"),
            )?)
            .separator()
            .item(&item("para.h1", "Heading 1", Some("CmdOrCtrl+1"))?)
            .item(&item("para.h2", "Heading 2", Some("CmdOrCtrl+2"))?)
            .item(&item("para.h3", "Heading 3", Some("CmdOrCtrl+3"))?)
            .item(&item("para.h4", "Heading 4", Some("CmdOrCtrl+4"))?)
            .item(&item("para.h5", "Heading 5", Some("CmdOrCtrl+5"))?)
            .item(&item("para.h6", "Heading 6", Some("CmdOrCtrl+6"))?)
            .build()?;

    let lists = SubmenuBuilder::with_id(app, "format.lists", "Lists")
        .item(&item(
            "para.ul",
            "Bulleted List",
            Some("CmdOrCtrl+Shift+]"),
        )?)
        .item(&item(
            "para.ol",
            "Numbered List",
            Some("CmdOrCtrl+Shift+["),
        )?)
        .item(&item(
            "para.task",
            "Task List",
            Some("CmdOrCtrl+Shift+X"),
        )?)
        .build()?;

    let tasks = SubmenuBuilder::with_id(app, "format.tasks", "Tasks")
        .item(&item("para.taskDone", "Mark as Done", None)?)
        .item(&item("para.taskTodo", "Mark as Pending", None)?)
        .item(&item(
            "para.taskPlain",
            "Convert to Plain Text",
            None,
        )?)
        .build()?;

    let format = SubmenuBuilder::new(app, "Format")
        .item(&item("format.bold", "Bold", Some("CmdOrCtrl+B"))?)
        .item(&item("format.italic", "Italic", Some("CmdOrCtrl+I"))?)
        .item(&item(
            "format.strike",
            "Strikethrough",
            Some("Alt+Shift+5"),
        )?)
        .item(&item("format.code", "Inline Code", Some("CmdOrCtrl+Shift+`"))?)
        .separator()
        .item(&paragraph_style)
        .item(&item(
            "para.increaseHeading",
            "Promote Heading (H2 → H1)",
            Some("CmdOrCtrl+="),
        )?)
        .item(&item(
            "para.decreaseHeading",
            "Demote Heading (H1 → H2)",
            Some("CmdOrCtrl+-"),
        )?)
        .item(&item(
            "para.quote",
            "Blockquote",
            Some("CmdOrCtrl+Shift+Q"),
        )?)
        .separator()
        .item(&lists)
        .item(&tasks)
        .item(&item("para.indent", "Increase Indent", None)?)
        .item(&item("para.outdent", "Decrease Indent", None)?)
        .separator()
        .item(&item("format.document", "Format Document", None)?)
        .build()?;

    // ---- Navigate ---------------------------------------------------------
    let open_tabs = {
        let tabs = OPEN_TABS.lock().map(|list| list.clone()).unwrap_or_default();
        let mut builder = SubmenuBuilder::with_id(app, OPEN_TABS_SUBMENU_ID, "Open Tabs");
        if tabs.is_empty() {
            let empty = item(OPEN_TABS_EMPTY_ID, "No Open Tabs", None)?;
            empty.set_enabled(false)?;
            builder = builder.item(&empty);
        } else {
            for tab in &tabs {
                let id = format!("{OPEN_TAB_PREFIX}{}", tab.id);
                let built = check_raw(&id, &plain_label(&tab.label), tab.checked)?;
                builder = builder.item(&built);
            }
        }
        builder.build()?
    };

    let navigate = SubmenuBuilder::new(app, "Navigate")
        .item(&item("navigate.gotoLine", "Go to Line…", None)?)
        .separator()
        .item(&item("file.nextTab", "Next Tab", Some("CmdOrCtrl+Tab"))?)
        .item(&item(
            "file.prevTab",
            "Previous Tab",
            Some("CmdOrCtrl+Shift+Tab"),
        )?)
        .item(&open_tabs)
        .item(&item("navigate.moveTabLeft", "Move Tab Left", None)?)
        .item(&item("navigate.moveTabRight", "Move Tab Right", None)?)
        .separator()
        .item(&item(
            "navigate.openTarget",
            "Open Link Under Cursor",
            None,
        )?)
        .build()?;

    // ---- View -------------------------------------------------------------
    // Check items make the current mode legible when the menu is opened. There
    // is no radio control in Tauri/muda, so exclusive groups are still
    // checkmarks; `is_checked` and the frontend keep exactly one of each on.
    #[cfg(not(target_os = "macos"))]
    let fullscreen: Box<dyn IsMenuItem<R>> =
        Box::new(check("view.fullscreen", "Full Screen", Some("F11"))?);
    // macOS has a native full-screen item that integrates with Spaces and the
    // green button. A custom CheckMenuItem would lose that, and the platform
    // draws its own state, so keep the predefined one there.
    #[cfg(target_os = "macos")]
    let fullscreen: Box<dyn IsMenuItem<R>> =
        Box::new(PredefinedMenuItem::fullscreen(app, None)?);

    let typst_preview =
        SubmenuBuilder::with_id(app, "view.typstPreview", "Typst Preview")
            .item(&check("view.typstDocument", "Document", None)?)
            .item(&check("view.typstPages", "Pages", None)?)
            .build()?;

    let sidebar = SubmenuBuilder::with_id(app, "view.sidebarPanel", "Sidebar")
        .item(&check(
            "view.sidebar",
            "Show Sidebar",
            Some("CmdOrCtrl+Shift+L"),
        )?)
        .item(&check(
            "view.outline",
            "Document Outline",
            Some("CmdOrCtrl+Shift+1"),
        )?)
        .item(&check(
            "view.favorites",
            "Favorites",
            Some("CmdOrCtrl+Shift+2"),
        )?)
        .item(&check(
            "view.recent",
            "Recent Files",
            Some("CmdOrCtrl+Shift+3"),
        )?)
        .build()?;

    let editor_text_size =
        SubmenuBuilder::with_id(app, "view.editorTextSize", "Zoom")
            .item(&item(
                "view.zoomIn",
                "Zoom In",
                Some("CmdOrCtrl+Shift+="),
            )?)
            .item(&item(
                "view.zoomOut",
                "Zoom Out",
                Some("CmdOrCtrl+Shift+-"),
            )?)
            .item(&item(
                "view.zoomReset",
                "Reset Zoom",
                Some("CmdOrCtrl+Alt+0"),
            )?)
            .build()?;

    let interface_theme =
        SubmenuBuilder::with_id(app, "view.interfaceTheme", "Interface Theme")
            .item(&check("themes.system", "Follow System", None)?)
            .item(&check("themes.light", "Light", None)?)
            .item(&check("themes.dark", "Dark", None)?)
            .build()?;

    let mut code_colors =
        SubmenuBuilder::with_id(app, "view.codeColors", "Code Colors");
    for (id, label) in SYNTAX_THEMES {
        let menu_id = format!("view.syntax.{id}");
        code_colors = code_colors.item(&check(&menu_id, label, None)?);
    }
    let code_colors = code_colors.build()?;

    let blocks = SubmenuBuilder::with_id(app, "view.blocks", "Blocks and Sections")
        .item(&item("view.foldCurrent", "Collapse Current", None)?)
        .item(&item("view.unfoldCurrent", "Expand Current", None)?)
        .item(&item("view.foldAll", "Collapse All", None)?)
        .item(&item("view.unfoldAll", "Expand All", None)?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&check(
            "view.source",
            "Source Code Mode",
            Some("CmdOrCtrl+/"),
        )?)
        .item(&check("view.split", "Split View", None)?)
        .item(&check("view.preview", "Preview Only", None)?)
        .separator()
        .item(&typst_preview)
        .separator()
        .item(&sidebar)
        .item(&check("view.statusBar", "Status Bar", None)?)
        .separator()
        .item(&check("view.focus", "Focus Mode", Some("F8"))?)
        .item(&check(
            "view.typewriter",
            "Typewriter Mode",
            Some("F9"),
        )?)
        .item(&check("view.syncScroll", "Sync Scroll", None)?)
        .separator()
        .item(&editor_text_size)
        .item(&interface_theme)
        .item(&code_colors)
        .item(&item("view.typography", "Fonts and Reading…", None)?)
        .item(&blocks)
        .separator()
        .item(fullscreen.as_ref())
        .build()?;

    // ---- Tools ------------------------------------------------------------
    let tools = SubmenuBuilder::new(app, "Tools")
        .item(&check(
            "tools.spellcheck",
            "Check Spelling While Typing",
            None,
        )?)
        .item(&item(
            "tools.spellLanguage",
            "Spelling Language…",
            None,
        )?)
        .separator()
        .item(&item(
            "tools.exportConfig",
            "Configure Export…",
            None,
        )?)
        .item(&item(
            "tools.pandoc",
            "Check or Install Pandoc…",
            None,
        )?)
        .item(&item(
            "tools.typst",
            "Check or Install Typst…",
            None,
        )?)
        .separator()
        .item(&item(
            "tools.ai",
            "AI Assistant…",
            Some("CmdOrCtrl+Shift+Space"),
        )?);

    #[cfg(not(target_os = "macos"))]
    let tools = tools
        .separator()
        .item(&item(
            "file.preferences",
            "Preferences…",
            Some("CmdOrCtrl+,"),
        )?);
    let tools = tools.build()?;

    // ---- Help -------------------------------------------------------------
    let help = SubmenuBuilder::new(app, "Help")
        .item(&item("help.welcome", "Welcome and Examples", None)?)
        .separator()
        .item(&item("help.reference", "Markdown Reference", None)?)
        .item(&item("help.asciidocReference", "AsciiDoc Reference", None)?)
        .item(&item("help.typstReference", "Typst Reference", None)?)
        .item(&item("help.shortcuts", "Keyboard Shortcuts", None)?)
        .separator()
        .item(&item("help.licences", "Font Licences", None)?);

    #[cfg(not(target_os = "macos"))]
    let help = help
        .separator()
        .item(&item("help.about", "About MDraft", None)?);
    let help = help.build()?;

    // ---- Assemble ---------------------------------------------------------
    let mut items: Vec<&dyn IsMenuItem<R>> = Vec::with_capacity(9);

    // macOS expects a leading application submenu.
    #[cfg(target_os = "macos")]
    let app_menu = {
        let submenu = SubmenuBuilder::new(app, "MDraft")
            .item(&PredefinedMenuItem::about(app, None, None)?)
            .separator()
            .item(&item(
                "file.preferences",
                "Preferences…",
                Some("CmdOrCtrl+,"),
            )?)
            .separator()
            .item(&PredefinedMenuItem::services(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::hide(app, None)?)
            .item(&PredefinedMenuItem::hide_others(app, None)?)
            .item(&PredefinedMenuItem::show_all(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::quit(app, None)?)
            .build()?;
        items.push(&submenu);
    };

    items.push(&file);
    items.push(&edit);
    items.push(&insert);
    items.push(&format);
    items.push(&navigate);
    items.push(&view);
    items.push(&tools);
    items.push(&help);

    MenuBuilder::new(app).items(&items).build()
}

/// Replace the native menu from settings that affect its generated parts.
///
/// The Export submenu and Open Recent are both built from lists the reader can
/// change, and a native menu cannot be edited in place safely. One helper keeps
/// the two callers — a settings save and the recent-file commands — from
/// deriving the check-mark state differently. Fullscreen is not a setting, so
/// ask the window rather than assuming false. The document-dependent state comes
/// from the latest frontend report: rebuilding it from settings alone would lose
/// the language, selection, tab position and tool state.
pub fn rebuild<R: Runtime>(app: &AppHandle<R>, settings: &Settings) {
    let cached = LAST_MENU_STATE
        .lock()
        .ok()
        .and_then(|state| state.clone());
    let mut menu_state = cached
        .unwrap_or_else(|| MenuState::from_settings(settings))
        .with_settings(settings);
    if let Some(window) = app.get_webview_window("main") {
        menu_state.fullscreen = window.is_fullscreen().unwrap_or(false);
    }
    match build(app, &menu_state) {
        Ok(menu) => {
            if let Err(error) = app.set_menu(menu) {
                eprintln!("[menu] could not replace the menu: {error}");
            } else {
                sync(app, &menu_state);
            }
        }
        Err(error) => eprintln!("[menu] could not rebuild the menu: {error}"),
    }
}

/// Forward a menu activation to the frontend.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref().to_string();
    // Predefined items are handled by the platform; their ids simply find no
    // listener on the frontend.
    let _ = app.emit("menu", id);
}

/// Find an item anywhere in the menu tree.
///
/// `Menu::get` only looks at the direct children of the menu bar, which is the
/// menu itself. Every item that matters here lives one level down in a submenu,
/// so a recursive walk is required; `Menu::get("view.focus")` returns `None`.
fn find_item<R: Runtime>(menu: &Menu<R>, id: &str) -> Option<MenuItemKind<R>> {
    fn walk<R: Runtime>(items: Vec<MenuItemKind<R>>, id: &str) -> Option<MenuItemKind<R>> {
        for item in items {
            if item.id() == id {
                return Some(item);
            }
            if let MenuItemKind::Submenu(submenu) = &item
                && let Ok(children) = submenu.items()
                && let Some(found) = walk(children, id)
            {
                return Some(found);
            }
        }
        None
    }

    walk(menu.items().ok()?, id)
}

/// Apply a state to every checkable item and to the context-sensitive ones.
///
/// Check items are not exclusive by themselves: setting `view.preview` does not
/// clear `view.split`. Writing the whole group on every update is what keeps the
/// radio behaviour, and it also repairs a menu that was rebuilt with one stale
/// value.
pub fn sync<R: Runtime>(app: &AppHandle<R>, state: &MenuState) {
    let Some(menu) = app.menu() else {
        return;
    };
    for id in CHECK_IDS {
        let Some(item) = find_item(&menu, id) else {
            continue;
        };
        let Some(check) = item.as_check_menuitem() else {
            // On macOS the full-screen item is a predefined one; the platform
            // owns its state.
            continue;
        };
        if let Err(error) = check.set_checked(is_checked(state, id)) {
            eprintln!("[menu] could not set the check state of {id}: {error}");
        }
    }

    if let Ok(items) = menu.items() {
        apply_context(items, state);
    }
}

/// Walk every custom item and apply its enabled state and conditional label.
///
/// Submenus are visited too: disabling `format.tasks` in a Typst document keeps
/// the whole family out of reach even though each child also has its own rule.
fn apply_context<R: Runtime>(items: Vec<MenuItemKind<R>>, state: &MenuState) {
    for item in items {
        let id = item.id().as_ref().to_string();
        if let Some(enabled) = enabled_for(state, &id) {
            let result = match &item {
                MenuItemKind::Submenu(submenu) => submenu.set_enabled(enabled),
                MenuItemKind::Check(check) => check.set_enabled(enabled),
                MenuItemKind::MenuItem(normal) => normal.set_enabled(enabled),
                MenuItemKind::Icon(icon) => icon.set_enabled(enabled),
                MenuItemKind::Predefined(_) => Ok(()),
            };
            if let Err(error) = result {
                eprintln!("[menu] could not set the enabled state of {id}: {error}");
            }
        }
        if let Some(text) = label_for(state, &id) {
            let result = match &item {
                MenuItemKind::Submenu(submenu) => submenu.set_text(text),
                MenuItemKind::Check(check) => check.set_text(text),
                MenuItemKind::MenuItem(normal) => normal.set_text(text),
                MenuItemKind::Icon(icon) => icon.set_text(text),
                MenuItemKind::Predefined(_) => Ok(()),
            };
            if let Err(error) = result {
                eprintln!("[menu] could not set the label of {id}: {error}");
            }
        }
        if let MenuItemKind::Submenu(submenu) = &item
            && let Ok(children) = submenu.items()
        {
            apply_context(children, state);
        }
    }
}

/// Let the frontend mirror its state onto the native menu.
#[tauri::command]
pub fn set_menu_state<R: Runtime>(app: AppHandle<R>, state: MenuState) {
    if let Ok(mut cached) = LAST_MENU_STATE.lock() {
        *cached = Some(state.clone());
    }
    sync(&app, &state);
}

/// Replace the rows of Navigate › Open Tabs.
///
/// The submenu is rebuilt in place rather than by replacing the whole menu: a
/// tab switch is frequent, and `Menu::set_menu` would also reset the accelerator
/// registry and every other item's state. The frontend disambiguates equal file
/// names before sending them; this side only owns the native controls.
#[tauri::command]
pub fn set_open_tabs<R: Runtime>(app: AppHandle<R>, tabs: Vec<OpenTabItem>) {
    if let Ok(mut cached) = OPEN_TABS.lock() {
        *cached = tabs.clone();
    }
    apply_open_tabs(&app, &tabs);
}

fn apply_open_tabs<R: Runtime>(app: &AppHandle<R>, tabs: &[OpenTabItem]) {
    let Some(menu) = app.menu() else {
        return;
    };
    let Some(MenuItemKind::Submenu(submenu)) = find_item(&menu, OPEN_TABS_SUBMENU_ID) else {
        return;
    };
    if let Ok(items) = submenu.items() {
        for _ in 0..items.len() {
            if let Err(error) = submenu.remove_at(0) {
                eprintln!("[menu] could not clear the open-tab list: {error}");
                return;
            }
        }
    }

    if tabs.is_empty() {
        if let Ok(empty) = MenuItemBuilder::with_id(OPEN_TABS_EMPTY_ID, "No Open Tabs").build(app) {
            let _ = empty.set_enabled(false);
            if let Err(error) = submenu.append(&empty) {
                eprintln!("[menu] could not add the empty open-tab row: {error}");
            }
        }
        return;
    }

    for tab in tabs {
        let id = format!("{OPEN_TAB_PREFIX}{}", tab.id);
        let label = plain_label(&tab.label);
        match CheckMenuItem::with_id(app, &id, &label, true, tab.checked, None::<&str>) {
            Ok(item) => {
                if let Err(error) = submenu.append(&item) {
                    eprintln!("[menu] could not add the open-tab row {id}: {error}");
                }
            }
            Err(error) => eprintln!("[menu] could not build the open-tab row {id}: {error}"),
        }
    }
}

/// Apply a tool-availability report to the Export submenu.
///
/// `pandoc`/`typst` say whether each program was found. The answer is cached in
/// `AppState` so a rebuild caused by an export-format edit keeps the labels and
/// disabled states instead of briefly offering every format again.
#[tauri::command]
pub fn set_export_availability<R: Runtime>(app: AppHandle<R>, pandoc: bool, typst: bool) {
    let availability = ExportAvailability {
        pandoc: Some(pandoc),
        typst: Some(typst),
    };
    if let Some(state) = app.try_state::<AppState>()
        && let Ok(mut slot) = state.export_availability.lock()
    {
        *slot = availability;
    }
    apply_export_availability(&app, availability);
}

fn apply_export_availability<R: Runtime>(app: &AppHandle<R>, availability: ExportAvailability) {
    let Some(menu) = app.menu() else {
        return;
    };
    for format in export_formats(app) {
        let id = format!("{EXPORT_PREFIX}{}", format.id);
        let Some(item) = find_item(&menu, &id) else {
            continue;
        };
        let Some(menu_item) = item.as_menuitem() else {
            continue;
        };
        if let Err(error) = menu_item.set_text(export_label(&format, availability)) {
            eprintln!("[menu] could not set the label of {id}: {error}");
        }
        if let Err(error) = menu_item.set_enabled(export_enabled(&format, availability)) {
            eprintln!("[menu] could not set the enabled state of {id}: {error}");
        }
    }
}

#[derive(serde::Serialize)]
pub struct MenuCheck {
    pub id: String,
    pub checked: bool,
    pub enabled: bool,
}

/// Every checkable item and its state, for the test suites.
///
/// A native menu is not part of the webview, so `Page.captureScreenshot` and the
/// DOM probes cannot see a check mark. This command is the only way to prove
/// that the menu a person opens agrees with the state the application thinks it
/// is in.
#[tauri::command]
pub fn menu_state<R: Runtime>(app: AppHandle<R>) -> Vec<MenuCheck> {
    fn walk<R: Runtime>(items: Vec<MenuItemKind<R>>, out: &mut Vec<MenuCheck>) {
        for item in items {
            if let MenuItemKind::Check(check) = &item {
                out.push(MenuCheck {
                    id: check.id().as_ref().to_string(),
                    checked: check.is_checked().unwrap_or(false),
                    enabled: check.is_enabled().unwrap_or(true),
                });
            }
            if let MenuItemKind::Submenu(submenu) = &item
                && let Ok(children) = submenu.items()
            {
                walk(children, out);
            }
        }
    }

    let mut out = Vec::new();
    if let Some(menu) = app.menu()
        && let Ok(items) = menu.items()
    {
        walk(items, &mut out);
    }
    out
}

#[derive(serde::Serialize)]
pub struct MenuItemInfo {
    pub id: String,
    pub text: String,
    pub enabled: bool,
    pub checked: Option<bool>,
    pub kind: String,
    /// The label of the containing submenu, empty for a top-level item.
    pub parent: String,
}

/// Every menu item, including ordinary items and submenus, for the test suites.
///
/// `menu_state` answers only the check marks because that is what the UI suite
/// needs for modes. Availability and conditional labels live on ordinary items,
/// so a second probe is the only way to prove that a command is disabled in the
/// context the plan describes.
#[tauri::command]
pub fn menu_items<R: Runtime>(app: AppHandle<R>) -> Vec<MenuItemInfo> {
    fn walk<R: Runtime>(items: Vec<MenuItemKind<R>>, parent: &str, out: &mut Vec<MenuItemInfo>) {
        for item in items {
            let (text, enabled, checked, kind) = match &item {
                MenuItemKind::Submenu(submenu) => (
                    submenu.text().unwrap_or_default(),
                    submenu.is_enabled().unwrap_or(true),
                    None,
                    "submenu",
                ),
                MenuItemKind::Check(check) => (
                    check.text().unwrap_or_default(),
                    check.is_enabled().unwrap_or(true),
                    Some(check.is_checked().unwrap_or(false)),
                    "check",
                ),
                MenuItemKind::MenuItem(normal) => (
                    normal.text().unwrap_or_default(),
                    normal.is_enabled().unwrap_or(true),
                    None,
                    "item",
                ),
                MenuItemKind::Icon(icon) => (
                    icon.text().unwrap_or_default(),
                    icon.is_enabled().unwrap_or(true),
                    None,
                    "item",
                ),
                MenuItemKind::Predefined(predefined) => (
                    predefined.text().unwrap_or_default(),
                    true,
                    None,
                    "predefined",
                ),
            };
            out.push(MenuItemInfo {
                id: item.id().as_ref().to_string(),
                text: text.clone(),
                enabled,
                checked,
                kind: kind.to_string(),
                parent: parent.to_string(),
            });
            if let MenuItemKind::Submenu(submenu) = &item
                && let Ok(children) = submenu.items()
            {
                walk(children, &text, out);
            }
        }
    }

    let mut out = Vec::new();
    if let Some(menu) = app.menu()
        && let Ok(items) = menu.items()
    {
        walk(items, "", &mut out);
    }
    out
}

#[derive(serde::Serialize)]
pub struct RecentMenuItem {
    pub id: String,
    pub text: String,
    pub enabled: bool,
}

/// The rows currently in the Open Recent submenu, for the test suites.
///
/// The native menu is not part of the webview, so no DOM probe can read it.
/// This walks the menu the same way `menu_state` does and reports the normal
/// items; separators and the submenu itself are not rows a reader can click.
#[tauri::command]
pub fn recent_menu<R: Runtime>(app: AppHandle<R>) -> Vec<RecentMenuItem> {
    let Some(menu) = app.menu() else {
        return Vec::new();
    };
    let Some(MenuItemKind::Submenu(submenu)) = find_item(&menu, RECENT_SUBMENU_ID) else {
        return Vec::new();
    };
    let Ok(items) = submenu.items() else {
        return Vec::new();
    };

    items
        .into_iter()
        .filter_map(|item| {
            let normal = item.as_menuitem()?;
            Some(RecentMenuItem {
                id: normal.id().as_ref().to_string(),
                text: normal.text().unwrap_or_default(),
                enabled: normal.is_enabled().unwrap_or(true),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Settings;

    #[test]
    fn check_state_tracks_settings() {
        let settings = Settings {
            view_mode: "preview".into(),
            sidebar_visible: false,
            sidebar_tab: "favorites".into(),
            show_status_bar: false,
            focus_mode: true,
            typewriter_mode: true,
            sync_scroll: false,
            theme: "dark".into(),
            auto_save: true,
            ..Settings::default()
        };

        let state = MenuState::from_settings(&settings);

        assert!(is_checked(&state, "view.preview"));
        assert!(!is_checked(&state, "view.source"));
        assert!(!is_checked(&state, "view.sidebar"));
        // Focus mode and a hidden sidebar mean no panel is effectively visible.
        assert!(!is_checked(&state, "view.favorites"));
        assert!(!is_checked(&state, "view.outline"));
        assert!(!is_checked(&state, "view.statusBar"));
        assert!(is_checked(&state, "view.focus"));
        assert!(is_checked(&state, "view.typewriter"));
        assert!(!is_checked(&state, "view.syncScroll"));
        assert!(is_checked(&state, "themes.dark"));
        assert!(!is_checked(&state, "themes.system"));
        assert!(is_checked(&state, "file.autoSave"));
        assert!(!is_checked(&state, "view.fullscreen"));

        let visible = MenuState::from_settings(&Settings {
            sidebar_visible: true,
            focus_mode: false,
            sidebar_tab: "favorites".into(),
            syntax_theme: "auto".into(),
            ..Settings::default()
        });
        assert!(is_checked(&visible, "view.sidebar"));
        assert!(is_checked(&visible, "view.favorites"));
        assert!(is_checked(&visible, "view.syntax.auto"));
        assert!(!is_checked(&visible, "view.syntax.paper"));
    }

    #[test]
    fn typst_and_legacy_syntax_states_check_one_item() {
        let mut state = MenuState::from_settings(&Settings::default());
        state.document_language = "typst".into();
        state.typst_view = "pages".into();
        assert!(is_checked(&state, "view.typstPages"));
        assert!(!is_checked(&state, "view.typstDocument"));

        state.syntax_theme = "github-light".into();
        assert!(is_checked(&state, "view.syntax.catppuccin-latte"));
        assert!(!is_checked(&state, "view.syntax.paper"));
    }

    #[test]
    fn availability_follows_the_document_and_the_tab() {
        let mut state = MenuState {
            document_language: "typst".into(),
            has_selection: true,
            tab_count: 3,
            tab_index: 1,
            ..MenuState::default()
        };

        assert_eq!(enabled_for(&state, "format.math"), Some(true));
        assert_eq!(enabled_for(&state, "para.task"), Some(false));
        assert_eq!(enabled_for(&state, "para.alertWarning"), Some(false));
        assert_eq!(enabled_for(&state, "para.yaml"), Some(false));
        assert_eq!(enabled_for(&state, "para.toc"), Some(true));
        assert_eq!(enabled_for(&state, "file.closeLeft"), Some(true));
        assert_eq!(enabled_for(&state, "file.closeRight"), Some(true));
        assert_eq!(enabled_for(&state, "file.closeOthers"), Some(true));
        assert_eq!(enabled_for(&state, "file.closeUnchanged"), Some(false));
        assert_eq!(enabled_for(&state, "edit.comment"), Some(false));
        assert_eq!(enabled_for(&state, "edit.delete"), Some(true));
        assert_eq!(enabled_for(&state, "file.reveal"), Some(false));
        assert_eq!(enabled_for(&state, "navigate.openTarget"), Some(false));
        assert_eq!(enabled_for(&state, "view.typstPreview"), Some(true));
        assert_eq!(enabled_for(&state, "view.zoomIn"), Some(true));

        state.document_language = "html".into();
        state.link_kind = "file".into();
        state.has_path = true;
        assert_eq!(enabled_for(&state, "format.math"), Some(false));
        assert_eq!(enabled_for(&state, "para.toc"), Some(false));
        assert_eq!(enabled_for(&state, "para.yaml"), Some(false));
        assert_eq!(enabled_for(&state, "file.reveal"), Some(true));
        assert_eq!(enabled_for(&state, "navigate.openTarget"), Some(true));
        assert_eq!(enabled_for(&state, "view.typstPreview"), Some(false));

        state.read_only = true;
        assert_eq!(enabled_for(&state, "edit.delete"), Some(false));
        assert_eq!(enabled_for(&state, "format.bold"), Some(false));

        state.view_mode = "preview".into();
        // Document zoom applies to the active reading view, so it stays
        // available when the editor is hidden.
        assert_eq!(enabled_for(&state, "view.zoomIn"), Some(true));
        assert_eq!(enabled_for(&state, "view.syncScroll"), Some(false));

        // Tool-owned export rows and recent rows must not be re-enabled by a
        // menu-state sync; apply_export_availability owns them.
        assert_eq!(enabled_for(&state, "export.pandoc.pdf"), None);
        assert_eq!(enabled_for(&state, "recent.file:C:/a.md"), None);
        assert_eq!(enabled_for(&state, "navigate.tab:doc-1"), None);
    }

    #[test]
    fn conditional_labels_name_the_document_action() {
        let mut state = MenuState::default();
        assert_eq!(label_for(&state, "file.favorite").as_deref(), Some("Add to Favorites"));
        state.is_favorite = true;
        assert_eq!(
            label_for(&state, "file.favorite").as_deref(),
            Some("Remove from Favorites")
        );

        state.document_language = "markdown".into();
        assert_eq!(label_for(&state, "para.yaml").as_deref(), Some("YAML Front Matter"));
        state.document_language = "asciidoc".into();
        assert_eq!(
            label_for(&state, "para.yaml").as_deref(),
            Some("Document Attributes")
        );

        state.link_kind = "anchor".into();
        assert_eq!(
            label_for(&state, "navigate.openTarget").as_deref(),
            Some("Go to Heading Under Cursor")
        );
        state.link_kind = "file".into();
        assert_eq!(
            label_for(&state, "navigate.openTarget").as_deref(),
            Some("Open File Under Cursor")
        );
    }

    #[test]
    fn exclusive_groups_check_exactly_one() {
        let state = MenuState::from_settings(&Settings::default());
        let checked = |ids: &[&str]| ids.iter().filter(|id| is_checked(&state, id)).count();

        assert_eq!(checked(&["view.source", "view.split", "view.preview"]), 1);
        assert_eq!(checked(&["view.outline", "view.favorites", "view.recent"]), 1);
        assert_eq!(checked(&["themes.system", "themes.light", "themes.dark"]), 1);
        assert_eq!(
            checked(&[
                "view.syntax.auto",
                "view.syntax.paper",
                "view.syntax.ink",
                "view.syntax.catppuccin-latte",
                "view.syntax.github-dark",
                "view.syntax.one-dark",
                "view.syntax.solarized-light",
                "view.syntax.solarized-dark",
                "view.syntax.nord",
            ]),
            1
        );
    }

    #[test]
    fn export_availability_disables_and_annotates() {
        let docx = ExportFormat {
            id: "docx".into(),
            label: "Word (.docx)".into(),
            ..ExportFormat::default()
        };

        let pdf = ExportFormat {
            id: "pdf".into(),
            label: "PDF (via Typst)".into(),
            ..ExportFormat::default()
        };

        let unknown = ExportAvailability::default();
        assert!(export_enabled(&docx, unknown));
        assert_eq!(export_label(&docx, unknown), "Word (.docx)…");

        let custom = ExportFormat {
            id: "custom1".into(),
            label: "My Word Target".into(),
            ..ExportFormat::default()
        };
        assert_eq!(export_label(&custom, unknown), "My Word Target");

        let pandoc_missing = ExportAvailability {
            pandoc: Some(false),
            typst: Some(false),
        };
        assert!(!export_enabled(&docx, pandoc_missing));
        assert!(export_label(&docx, pandoc_missing).ends_with("— needs Pandoc"));

        // Pandoc alone is enough for every target but PDF.
        let typst_missing = ExportAvailability {
            pandoc: Some(true),
            typst: Some(false),
        };
        assert!(export_enabled(&docx, typst_missing));
        assert!(!export_enabled(&pdf, typst_missing));
        assert!(export_label(&pdf, typst_missing).ends_with("— needs Typst"));

        let installed = ExportAvailability {
            pandoc: Some(true),
            typst: Some(true),
        };
        assert!(export_enabled(&pdf, installed));
        assert_eq!(export_label(&pdf, installed), "PDF (via Typst)…");
    }

    #[test]
    fn only_the_built_in_pdf_is_drawn_with_the_native_pdf_rows() {
        // The menu partitions the stored formats on this predicate, so a second
        // match would duplicate a row and a miss would drop PDF (via Typst) back
        // into the pandoc list.
        let formats = default_export_formats();
        assert_eq!(
            formats.iter().filter(|format| is_pandoc_pdf(format)).count(),
            1,
            "exactly one default format is the pandoc PDF"
        );
        assert!(is_pandoc_pdf(&ExportFormat {
            id: "PDF".into(),
            label: "Typeset with Typst".into(),
            ..ExportFormat::default()
        }));
        assert!(!is_pandoc_pdf(&ExportFormat {
            id: "custom1".into(),
            label: "PDF (via Typst)".into(),
            ..ExportFormat::default()
        }));
    }

    #[test]
    fn an_empty_recent_list_offers_one_disabled_row() {
        let entries = recent_entries(&[]);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "recent.empty");
        assert_eq!(entries[0].label, "No Recent Files");
        assert!(!entries[0].enabled);
    }

    #[test]
    fn recent_rows_carry_the_path_and_end_with_clear_items() {
        let files = vec![
            r"C:\Docs\newer.md".to_string(),
            r"C:\Docs\older.md".to_string(),
        ];
        let entries = recent_entries(&files);

        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].id, r"recent.file:C:\Docs\newer.md");
        assert_eq!(entries[0].label, r"C:\Docs\newer.md");
        assert!(entries[0].enabled);
        assert_eq!(entries[1].id, r"recent.file:C:\Docs\older.md");
        assert_eq!(entries[2].id, "recent.clear");
        assert_eq!(entries[2].label, "Clear Items");
        assert!(entries[2].enabled);
    }

    #[test]
    fn the_menu_shows_only_the_newest_twenty_of_a_longer_history() {
        // The store and the sidebar keep up to 100 entries; the menu is a quick
        // pick and must not turn into a 100-row native popup.
        let files: Vec<String> = (0..100)
            .map(|index| format!("C:/Docs/file{index}.md"))
            .collect();
        let entries = recent_entries(&files);

        assert_eq!(entries.len(), RECENT_MENU_LIMIT + 1);
        assert_eq!(entries[0].id, "recent.file:C:/Docs/file0.md");
        assert_eq!(
            entries[RECENT_MENU_LIMIT - 1].id,
            format!("recent.file:C:/Docs/file{}.md", RECENT_MENU_LIMIT - 1)
        );
        assert_eq!(entries[RECENT_MENU_LIMIT].id, "recent.clear");
    }

    #[test]
    fn a_long_recent_path_is_middle_ellipsized_around_its_file_name() {
        let path = r"C:\Users\bernh\Documents\GitHub\MDraft\a-long-directory-name\another-long-directory-name\2026-10-18-open-recent-menu.md";
        let label = recent_label(path);

        assert_eq!(label.chars().count(), RECENT_LABEL_MAX);
        assert!(label.contains('…'), "the middle must be the part cut: {label}");
        assert!(
            label.ends_with("2026-10-18-open-recent-menu.md"),
            "the file name is the part a reader scans for: {label}"
        );
        assert!(label.starts_with("C:"), "the root stays visible: {label}");
    }

    #[test]
    fn recent_labels_cannot_become_a_windows_mnemonic() {
        // A raw `&` starts a mnemonic on Windows; `plain_label` doubles it so
        // the menu draws the folder name the reader actually has.
        assert_eq!(recent_label(r"C:\A&B\file.md"), r"C:\A&&B\file.md");
        let entries = recent_entries(&[r"C:\A&B\file.md".to_string()]);
        assert_eq!(entries[0].label, r"C:\A&&B\file.md");
    }
}
