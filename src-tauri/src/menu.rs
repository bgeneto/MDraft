//! Native application menu.
//!
//! The structure follows Typora's menu bar (File / Edit / Paragraph / Format /
//! View / Themes / Help). Every custom item carries a stable id; `on_event`
//! forwards that id to the frontend as the `menu` event so the UI owns the
//! actual behaviour.

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
    match availability.pandoc {
        Some(false) => format!("{base} — needs Pandoc"),
        Some(true) if format.id.eq_ignore_ascii_case("pdf") && availability.typst == Some(false) => {
            format!("{base} — needs Typst")
        }
        _ => base,
    }
}

/// Whether this format can run with the tools that are installed.
///
/// PDF is the one format that also needs Typst; every other pandoc target reads
/// Markdown and writes a file, so Pandoc alone is enough.
fn export_enabled(format: &ExportFormat, availability: ExportAvailability) -> bool {
    availability.pandoc.unwrap_or(true)
        && (!format.id.eq_ignore_ascii_case("pdf") || availability.typst.unwrap_or(true))
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
#[serde(rename_all = "camelCase")]
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
}

impl MenuState {
    /// The settings-backed part of the state.
    ///
    /// `fullscreen` is not a persisted setting, so a caller that can see the
    /// window must fill it in; the default is "not fullscreen", which is what a
    /// freshly built menu should show.
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
        }
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
    "view.sidebar",
    "view.outline",
    "view.files",
    "view.recent",
    "view.statusBar",
    "view.focus",
    "view.typewriter",
    "view.syncScroll",
    "view.fullscreen",
    "themes.system",
    "themes.light",
    "themes.dark",
];

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
        "view.sidebar" => state.sidebar_visible,
        "view.outline" => state.sidebar_tab == "outline",
        "view.files" => state.sidebar_tab == "files",
        "view.recent" => state.sidebar_tab == "recent",
        "view.statusBar" => state.show_status_bar,
        "view.focus" => state.focus_mode,
        "view.typewriter" => state.typewriter_mode,
        "view.syncScroll" => state.sync_scroll,
        "view.fullscreen" => state.fullscreen,
        "themes.system" => state.theme == "system",
        "themes.light" => state.theme == "light",
        "themes.dark" => state.theme == "dark",
        _ => false,
    }
}

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

    // ---- File -------------------------------------------------------------
    // The export submenu is built from settings, so the entries a user adds in
    // Preferences appear here without any further wiring. HTML and PDF come
    // first and are both native: HTML is written by the application from its own
    // preview pipeline, and PDF is printed from that same HTML by the system
    // browser. Neither needs pandoc, which is why they are separated from the
    // pandoc formats below them.
    let mut export = SubmenuBuilder::new(app, "Export")
        .item(&item("export.html", "HTML", None)?)
        .item(&item("export.pdf", "PDF (Print)", None)?)
        .separator();
    for format in export_formats(app) {
        let id = format!("{EXPORT_PREFIX}{}", format.id);
        let built = item(
            &id,
            &export_label(&format, availability),
            None,
        )?;
        if !export_enabled(&format, availability) {
            built.set_enabled(false)?;
        }
        export = export.item(&built);
    }
    let export = export
        .separator()
        .item(&item("export.installPandoc", "Install Pandoc…", None)?)
        .item(&item("export.installTypst", "Install Typst…", None)?)
        .build()?;

    let recent = recent_submenu(app)?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&item("file.new", "New", Some("CmdOrCtrl+N"))?)
        .item(&item("file.open", "Open…", Some("CmdOrCtrl+O"))?)
        .item(&recent)
        .separator()
        .item(&item("file.save", "Save", Some("CmdOrCtrl+S"))?)
        .item(&item("file.saveAs", "Save As…", Some("CmdOrCtrl+Shift+S"))?)
        .item(&item("file.close", "Close Tab", Some("CmdOrCtrl+W"))?)
        .item(&item("file.closeAll", "Close All Tabs", None)?)
        .separator()
        .item(&item("file.nextTab", "Next Tab", Some("CmdOrCtrl+Tab"))?)
        .item(&item("file.prevTab", "Previous Tab", Some("CmdOrCtrl+Shift+Tab"))?)
        .separator()
        .item(&check("file.autoSave", "Auto Save", None)?)
        .item(&item("file.reload", "Reload From Disk", None)?)
        .separator()
        .item(&export)
        .item(&item("file.reveal", "Reveal in File Manager", None)?)
        .separator()
        .item(&item("file.preferences", "Preferences…", Some("CmdOrCtrl+,"))?)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    // ---- Edit -------------------------------------------------------------
    // Undo/redo/cut/copy/paste/select-all are predefined so the webview handles
    // them natively; search is custom because the editor owns it.
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .separator()
        .item(&item("edit.find", "Find", Some("CmdOrCtrl+F"))?)
        .item(&item("edit.replace", "Find and Replace", Some("CmdOrCtrl+H"))?)
        .build()?;

    // ---- Paragraph (mirrors Typora's layout) ------------------------------
    let alert = SubmenuBuilder::new(app, "Alert")
        .item(&item("para.alertNote", "Note", None)?)
        .item(&item("para.alertTip", "Tip", None)?)
        .item(&item("para.alertImportant", "Important", None)?)
        .item(&item("para.alertWarning", "Warning", None)?)
        .item(&item("para.alertCaution", "Caution", None)?)
        .build()?;

    let task_status = SubmenuBuilder::new(app, "Task Status")
        .item(&item("para.taskDone", "Toggle Checked", None)?)
        .item(&item("para.taskTodo", "Toggle Unchecked", None)?)
        .item(&item("para.taskPlain", "Plain List Item", None)?)
        .build()?;

    let list_indent = SubmenuBuilder::new(app, "List Indentation")
        // No accelerators here: the editor already binds Tab / Shift+Tab, and a
        // window-level accelerator would steal Tab from every input in the UI.
        .item(&item("para.indent", "Indent", None)?)
        .item(&item("para.outdent", "Outdent", None)?)
        .build()?;

    let paragraph = SubmenuBuilder::new(app, "Paragraph")
        .item(&item("para.h1", "Heading 1", Some("CmdOrCtrl+1"))?)
        .item(&item("para.h2", "Heading 2", Some("CmdOrCtrl+2"))?)
        .item(&item("para.h3", "Heading 3", Some("CmdOrCtrl+3"))?)
        .item(&item("para.h4", "Heading 4", Some("CmdOrCtrl+4"))?)
        .item(&item("para.h5", "Heading 5", Some("CmdOrCtrl+5"))?)
        .item(&item("para.h6", "Heading 6", Some("CmdOrCtrl+6"))?)
        .separator()
        .item(&item("para.paragraph", "Paragraph", Some("CmdOrCtrl+0"))?)
        .separator()
        .item(&item(
            "para.increaseHeading",
            "Increase Heading Level",
            Some("CmdOrCtrl+="),
        )?)
        .item(&item(
            "para.decreaseHeading",
            "Decrease Heading Level",
            Some("CmdOrCtrl+-"),
        )?)
        .separator()
        .item(&item("para.table", "Table", Some("CmdOrCtrl+T"))?)
        .item(&item("para.mathBlock", "Math Block", Some("CmdOrCtrl+Shift+M"))?)
        .item(&item("para.codeBlock", "Code Fences", Some("CmdOrCtrl+Shift+K"))?)
        .item(&alert)
        .separator()
        .item(&item("para.quote", "Quote", Some("CmdOrCtrl+Shift+Q"))?)
        .separator()
        .item(&item("para.ol", "Ordered List", Some("CmdOrCtrl+Shift+["))?)
        .item(&item("para.ul", "Unordered List", Some("CmdOrCtrl+Shift+]"))?)
        .item(&item("para.task", "Task List", Some("CmdOrCtrl+Shift+X"))?)
        .item(&task_status)
        .item(&list_indent)
        .separator()
        .item(&item("para.insertBefore", "Insert Paragraph Before", None)?)
        .item(&item("para.insertAfter", "Insert Paragraph After", None)?)
        .separator()
        .item(&item("para.hr", "Horizontal Line", None)?)
        .item(&item("para.toc", "Table of Contents", None)?)
        .item(&item("para.yaml", "YAML Front Matter", None)?)
        .build()?;

    // ---- Format -----------------------------------------------------------
    let format = SubmenuBuilder::new(app, "Format")
        .item(&item("format.bold", "Strong", Some("CmdOrCtrl+B"))?)
        .item(&item("format.italic", "Emphasis", Some("CmdOrCtrl+I"))?)
        .item(&item(
            "format.strike",
            "Strikethrough",
            Some("Alt+Shift+5"),
        )?)
        .item(&item("format.code", "Inline Code", Some("CmdOrCtrl+Shift+`"))?)
        .separator()
        .item(&item("format.link", "Hyperlink", Some("CmdOrCtrl+K"))?)
        .item(&item("format.image", "Image", Some("CmdOrCtrl+Shift+I"))?)
        .separator()
        .item(&item("format.math", "Inline Math", None)?)
        .item(&item("format.displayMath", "Display Math", None)?)
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

    let view = SubmenuBuilder::new(app, "View")
        .item(&check(
            "view.source",
            "Source Code Mode",
            Some("CmdOrCtrl+/"),
        )?)
        .item(&check("view.split", "Split View", None)?)
        .item(&check("view.preview", "Preview Only", None)?)
        .separator()
        .item(&check(
            "view.sidebar",
            "Sidebar",
            Some("CmdOrCtrl+Shift+L"),
        )?)
        .item(&check("view.outline", "Outline", Some("CmdOrCtrl+Shift+1"))?)
        .item(&check("view.files", "File List", Some("CmdOrCtrl+Shift+2"))?)
        .item(&check(
            "view.recent",
            "Recent Files",
            Some("CmdOrCtrl+Shift+3"),
        )?)
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
        .item(&item("view.zoomIn", "Zoom In", Some("CmdOrCtrl+Shift+="))?)
        .item(&item("view.zoomOut", "Zoom Out", Some("CmdOrCtrl+Shift+-"))?)
        .item(&item(
            "view.zoomReset",
            "Reset Zoom",
            Some("CmdOrCtrl+Shift+0"),
        )?)
        .separator()
        .item(fullscreen.as_ref())
        .build()?;

    // ---- Themes -----------------------------------------------------------
    let themes = SubmenuBuilder::new(app, "Themes")
        .item(&check("themes.system", "Follow System", None)?)
        .item(&check("themes.light", "Light", None)?)
        .item(&check("themes.dark", "Dark", None)?)
        .build()?;

    // ---- Help -------------------------------------------------------------
    let help = SubmenuBuilder::new(app, "Help")
        .item(&item("help.reference", "Markdown Reference", None)?)
        .item(&item("help.asciidocReference", "AsciiDoc Reference", None)?)
        .item(&item("help.shortcuts", "Keyboard Shortcuts", None)?)
            .separator()
            .item(&item("help.licences", "Font Licences", None)?)
            .separator()
            .item(&item("help.installTypst", "Install Typst...", None)?)
        .separator()
        .item(&item("help.pandoc", "Install Pandoc…", None)?)
        .separator()
        .item(&item("help.about", "About MDraft", None)?)
        .build()?;

    // ---- Assemble ---------------------------------------------------------
    let mut items: Vec<&dyn IsMenuItem<R>> = Vec::with_capacity(8);

    // macOS expects a leading application submenu.
    #[cfg(target_os = "macos")]
    let app_menu = {
        let submenu = SubmenuBuilder::new(app, "MDraft")
            .item(&PredefinedMenuItem::about(app, None, None)?)
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
    items.push(&paragraph);
    items.push(&format);
    items.push(&view);
    items.push(&themes);
    items.push(&help);

    MenuBuilder::new(app).items(&items).build()
}

/// Replace the native menu from settings that affect its generated parts.
///
/// The Export submenu and Open Recent are both built from lists the reader can
/// change, and a native menu cannot be edited in place safely. One helper keeps
/// the two callers — a settings save and the recent-file commands — from
/// deriving the check-mark state differently. Fullscreen is not a setting, so
/// ask the window rather than assuming false.
pub fn rebuild<R: Runtime>(app: &AppHandle<R>, settings: &Settings) {
    let mut menu_state = MenuState::from_settings(settings);
    if let Some(window) = app.get_webview_window("main") {
        menu_state.fullscreen = window.is_fullscreen().unwrap_or(false);
    }
    match build(app, &menu_state) {
        Ok(menu) => {
            if let Err(error) = app.set_menu(menu) {
                eprintln!("[menu] could not replace the menu: {error}");
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

/// Apply a state to every checkable item.
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

    // Focus mode removes the sidebar from the layout. Now that the status bar
    // stays visible there, its sidebar button is visible too; leaving the four
    // sidebar items clickable would be a control that changes a setting nobody
    // can see. Disable them until focus mode is left.
    for id in ["view.sidebar", "view.outline", "view.files", "view.recent"] {
        let Some(item) = find_item(&menu, id) else {
            continue;
        };
        let Some(check) = item.as_check_menuitem() else {
            continue;
        };
        if let Err(error) = check.set_enabled(!state.focus_mode) {
            eprintln!("[menu] could not set the enabled state of {id}: {error}");
        }
    }
}

/// Let the frontend mirror its state onto the native menu.
#[tauri::command]
pub fn set_menu_state<R: Runtime>(app: AppHandle<R>, state: MenuState) {
    sync(&app, &state);
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
            sidebar_tab: "files".into(),
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
        assert!(is_checked(&state, "view.files"));
        assert!(!is_checked(&state, "view.outline"));
        assert!(!is_checked(&state, "view.statusBar"));
        assert!(is_checked(&state, "view.focus"));
        assert!(is_checked(&state, "view.typewriter"));
        assert!(!is_checked(&state, "view.syncScroll"));
        assert!(is_checked(&state, "themes.dark"));
        assert!(!is_checked(&state, "themes.system"));
        assert!(is_checked(&state, "file.autoSave"));
        assert!(!is_checked(&state, "view.fullscreen"));
    }

    #[test]
    fn exclusive_groups_check_exactly_one() {
        let state = MenuState::from_settings(&Settings::default());
        let checked = |ids: &[&str]| ids.iter().filter(|id| is_checked(&state, id)).count();

        assert_eq!(checked(&["view.source", "view.split", "view.preview"]), 1);
        assert_eq!(checked(&["view.outline", "view.files", "view.recent"]), 1);
        assert_eq!(checked(&["themes.system", "themes.light", "themes.dark"]), 1);
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
        assert_eq!(export_label(&docx, unknown), "Word (.docx)");

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
        assert_eq!(export_label(&pdf, installed), "PDF (via Typst)");
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
