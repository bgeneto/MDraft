//! Native application menu.
//!
//! The structure follows Typora's menu bar (File / Edit / Paragraph / Format /
//! View / Themes / Help). Every custom item carries a stable id; `on_event`
//! forwards that id to the frontend as the `menu` event so the UI owns the
//! actual behaviour.

use crate::settings::{default_export_formats, AppState};
use tauri::menu::{
    IsMenuItem, Menu, MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder, PredefinedMenuItem,
    SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Menu ids for the configured pandoc formats are prefixed with this, so
/// `on_event` and the frontend can tell them apart from built-in items.
pub const EXPORT_PREFIX: &str = "export.pandoc.";

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

/// A menu label safe to hand to the platform backends.
///
/// An `&` starts a keyboard mnemonic on Windows and Linux, so a label the user
/// typed containing one would silently swallow the next character.
fn plain_label(label: &str) -> String {
    label.replace('&', "&&")
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

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // The menu is rebuilt whenever the export formats change, so the registry is
    // reset here; appending would accumulate duplicates.
    if let Ok(mut list) = ACCELERATORS.lock() {
        list.clear();
    }

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
                if let Some(a) = accel {
                    if let Ok(mut list) = ACCELERATORS.lock() {
                        list.push((id.to_string(), a.to_string()));
                    }
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
        export = export.item(&item(
            &format!("{EXPORT_PREFIX}{}", format.id),
            &plain_label(&format.label),
            None,
        )?);
    }
    let export = export.build()?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&item("file.new", "New", Some("CmdOrCtrl+N"))?)
        .item(&item("file.open", "Open…", Some("CmdOrCtrl+O"))?)
        .separator()
        .item(&item("file.save", "Save", Some("CmdOrCtrl+S"))?)
        .item(&item("file.saveAs", "Save As…", Some("CmdOrCtrl+Shift+S"))?)
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
        .build()?;

    // ---- View -------------------------------------------------------------
    let view = SubmenuBuilder::new(app, "View")
        .item(&item(
            "view.source",
            "Source Code Mode",
            Some("CmdOrCtrl+/"),
        )?)
        .item(&item("view.split", "Split View", None)?)
        .item(&item("view.preview", "Preview Only", None)?)
        .separator()
        .item(&item(
            "view.sidebar",
            "Toggle Sidebar",
            Some("CmdOrCtrl+Shift+L"),
        )?)
        .item(&item("view.outline", "Outline", Some("CmdOrCtrl+Shift+1"))?)
        .item(&item("view.files", "File List", Some("CmdOrCtrl+Shift+2"))?)
        .item(&item(
            "view.recent",
            "Recent Files",
            Some("CmdOrCtrl+Shift+3"),
        )?)
        .item(&item("view.statusBar", "Toggle Status Bar", None)?)
        .separator()
        .item(&item("view.focus", "Focus Mode", Some("F8"))?)
        .item(&item("view.typewriter", "Typewriter Mode", Some("F9"))?)
        .item(&item("view.syncScroll", "Sync Scroll", None)?)
        .separator()
        .item(&item("view.zoomIn", "Zoom In", Some("CmdOrCtrl+Shift+="))?)
        .item(&item("view.zoomOut", "Zoom Out", Some("CmdOrCtrl+Shift+-"))?)
        .item(&item(
            "view.zoomReset",
            "Reset Zoom",
            Some("CmdOrCtrl+Shift+0"),
        )?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    // ---- Themes -----------------------------------------------------------
    let themes = SubmenuBuilder::new(app, "Themes")
        .item(&item("themes.system", "Follow System", None)?)
        .item(&item("themes.light", "Light", None)?)
        .item(&item("themes.dark", "Dark", None)?)
        .build()?;

    // ---- Help -------------------------------------------------------------
    let help = SubmenuBuilder::new(app, "Help")
        .item(&item("help.reference", "Markdown Reference", None)?)
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
    let mut items: Vec<&dyn IsMenuItem<R>> = Vec::new();

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

/// Forward a menu activation to the frontend.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref().to_string();
    // Predefined items are handled by the platform; their ids simply find no
    // listener on the frontend.
    let _ = app.emit("menu", id);
}
