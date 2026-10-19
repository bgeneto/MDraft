//! Persisted application settings and the shared application state.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};

/// Maximum number of entries kept in the persisted "recent files" list.
///
/// The sidebar renders all of these and scrolls. The File › Open Recent submenu
/// shows only the newest entries; its smaller limit lives in `menu.rs`. Keeping
/// the history longer than the menu is deliberate: clearing the menu's limit
/// would throw away paths the sidebar can still offer.
pub(crate) const MAX_RECENT: usize = 100;

/// Maximum number of documents remembered as "the tabs that were open".
///
/// The frontend deduplicates and caps the list it writes; this is the second
/// line of defence for a hand-edited or older `settings.json`, the same way
/// [`MAX_RECENT`] guards the recent list. Twenty is the agreed ceiling: enough
/// for a realistic working set, small enough that restoring stays a few reads.
pub(crate) const MAX_LAST_TABS: usize = 20;

/// One pandoc export target: how to invoke pandoc, and what to do afterwards.
///
/// `arguments` is a token list, not a shell string, and four placeholders are
/// substituted before it runs:
///
/// | Placeholder | Expands to |
/// | --- | --- |
/// | `${inputPath}` | the document's path, empty for an untitled document |
/// | `${outputPath}` | the file the user chose to write |
/// | `${styleReference}` | the reference/style file, empty when unset |
/// | `${pdfEngine}` | `--pdf-engine=<path>` when a PDF engine was found, else empty |
///
/// **A token whose placeholder expanded to nothing is dropped entirely**, so
/// `--reference-doc=${styleReference}` simply disappears when no reference file
/// has been chosen. Without that rule the defaults would have to either omit the
/// option or pass an empty one, and pandoc rejects both.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportFormat {
    pub id: String,
    pub label: String,
    /// Without the dot, as the file dialog wants it.
    pub extension: String,
    pub arguments: String,
    /// Appended verbatim after `arguments`, for one-off tweaks.
    pub extra_arguments: String,
    pub style_reference: String,
}

impl Default for ExportFormat {
    fn default() -> Self {
        Self {
            id: String::new(),
            label: String::new(),
            extension: String::new(),
            arguments: "-s -o ${outputPath}".into(),
            extra_arguments: String::new(),
            style_reference: String::new(),
        }
    }
}

impl ExportFormat {
    fn new(id: &str, label: &str, extension: &str, arguments: &str) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            extension: extension.into(),
            arguments: arguments.into(),
            ..Self::default()
        }
    }
}

/// The markdown dialect the editor writes, as a pandoc `-f` value.
///
/// Pandoc's `markdown` reader has `tex_math_dollars` on by default but both
/// backslash forms off, and the difference is not cosmetic: with the extensions
/// missing, `\(a^2 + b^2 = c^2\)` does not come out as a formula, it comes out
/// as the escaped literal text `(a\^{}2 + b\^{}2 = c\^{}2)` — the backslash
/// reads as a Markdown escape rather than as a delimiter.
///
/// The editor renders `\(…\)` and `\[…\]` (see `markdown.ts`), so the exporter
/// has to accept them too, or a document would look right in the preview and
/// wrong in every file it produced.
const PANDOC_INPUT: &str = "-f markdown+tex_math_single_backslash+tex_math_double_backslash";

/// The export targets offered before the user edits anything.
///
/// Deliberately excludes HTML: that one is written by the application itself and
/// needs neither pandoc nor a LaTeX installation. The list mirrors what a
/// markdown editor is normally expected to produce, not the full set pandoc can
/// emit — the arguments are editable, so anything else is a few keystrokes away.
///
/// The text formats pass `--wrap=none`. Pandoc hard-wraps prose at 72 columns by
/// default, which is wrong for a writing tool: it puts line breaks inside
/// sentences, so every later edit shows as a spurious diff.
/// Serde helpers.
///
/// The typography font fields default to the empty string rather than to a stack,
/// because the stacks live in `src/fonts.ts` beside the reasoning for each one.
/// Empty means "whatever the built-in default for that role is", which is also
/// what makes a settings file written before a role existed still load.
/// The preview opens on the flowing document, not the printed page.
fn default_typst_view() -> String {
    "document".to_string()
}

/// The source pane's line spacing.
///
/// `normal` is the 1.5 established when the default was tightened; Compact and
/// Wide are opt-in adjustments chosen in Preferences. The names, not a
/// multiplier, are what a settings file stores, so a hand-edited value cannot
/// produce an invalid CSS line height.
fn default_editor_line_height() -> String {
    "normal".to_string()
}

fn default_true() -> bool {
    true
}

fn default_rich_paste_images() -> String {
    // A pasted page is content the reader asked to bring in; downloading it is
    // the default, and one select changes it to keeping the URL.
    "download".to_string()
}

fn default_body_font_size() -> u32 {
    16
}

fn default_spellcheck_language() -> String {
    "auto".to_string()
}

/// KaTeX draws every formula at 1.21em. The default scales that down to sit
/// with the prose; 100 is KaTeX's own ratio, kept as the upper bound's anchor.
fn default_math_font_scale() -> u32 {
    90
}

pub fn default_export_formats() -> Vec<ExportFormat> {    let args = |rest: &str| format!("{PANDOC_INPUT} {rest}");
    vec![
        ExportFormat::new(
            "pdf",
            "PDF (via Typst)",
            "pdf",
            &args("-s -o ${outputPath} ${pdfEngine}"),
        ),
        ExportFormat::new(
            "docx",
            "Word (.docx)",
            "docx",
            &args("-s -o ${outputPath} --reference-doc=${styleReference}"),
        ),
        ExportFormat::new(
            "odt",
            "LibreOffice / OpenDocument (.odt)",
            "odt",
            &args("-s -o ${outputPath} --reference-doc=${styleReference}"),
        ),
        ExportFormat::new("latex", "LaTeX", "tex", &args("-s -t latex -o ${outputPath} --wrap=none")),
        ExportFormat::new("rst", "reStructuredText", "rst", &args("-s -t rst -o ${outputPath} --wrap=none")),
        ExportFormat::new(
            "asciidoc",
            "AsciiDoc",
            "adoc",
            &args("-s -t asciidoc -o ${outputPath} --wrap=none"),
        ),
        ExportFormat::new("epub", "EPUB", "epub", &args("-s -o ${outputPath} --css=${styleReference}")),
        ExportFormat::new("rtf", "RTF", "rtf", &args("-s -o ${outputPath}")),
        ExportFormat::new(
            "textile",
            "Textile",
            "textile",
            &args("-s -t textile -o ${outputPath} --wrap=none"),
        ),
        ExportFormat::new(
            "mediawiki",
            "MediaWiki",
            "wiki",
            &args("-s -t mediawiki -o ${outputPath} --wrap=none"),
        ),
        ExportFormat::new("opml", "OPML", "opml", &args("-s -t opml -o ${outputPath}")),
    ]
}

/// Sizes remembered for one typography preset.
///
/// Editor font size, Preview font size and Math scale are reader adjustments,
/// not part of what identifies a preset. Any field may be absent; a missing
/// field means the preset has never been adjusted and its default applies.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PresetOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editor_font_size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_font_size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub math_font_scale: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// "system" | "light" | "dark"
    pub theme: String,
    /// "source" | "split" | "preview"
    pub view_mode: String,
    /// "outline" | "files" | "recent"
    pub sidebar_tab: String,
    pub sidebar_visible: bool,
    pub sync_scroll: bool,
    pub show_status_bar: bool,
    pub focus_mode: bool,
    pub typewriter_mode: bool,
    pub editor_font_size: u32,
    /// Maximum content width in pixels; 0 means full width.
    pub editor_max_width: u32,
    /// "compact" | "normal" | "wide"; line spacing in the source pane.
    #[serde(default = "default_editor_line_height")]
    pub editor_line_height: String,

    // ---- Preferences: Typography -----------------------------------------
    //
    // Each font value is a complete CSS font stack, not a family name, so a
    // reader can write `"Source Serif 4", Charter, Georgia, serif` and be
    // understood. The application never parses these; it publishes them as CSS
    // variables and lets the webview do the cascade. An empty string means
    // "use the built-in default for that role", which is what keeps an older
    // settings file working after a role is added.
    #[serde(default)]
    pub source_font: String,
    #[serde(default)]
    pub body_font: String,
    #[serde(default)]
    pub heading_font: String,
    #[serde(default)]
    pub code_font: String,
    /// Prose size in the preview, in pixels. The editor has its own, above.
    #[serde(default = "default_body_font_size")]
    pub body_font_size: u32,
    /// Scale applied to KaTeX's mathematics, as a percentage.
    ///
    /// KaTeX sets `.katex` at 1.21em of the surrounding text, so a formula is a
    /// fifth larger than the prose beside it; roughly 83% makes the two match,
    /// and 100 leaves KaTeX's own ratio alone. The Preferences field limits the
    /// range to 70–130. A hand-edited file is not clamped on load: silently
    /// rewriting a value the reader typed is worse than drawing it oddly, and
    /// the same rule applies to every other size in this struct.
    #[serde(default = "default_math_font_scale")]
    pub math_font_scale: u32,
    /// Sizes remembered per typography preset, keyed by preset id.
    ///
    /// The top-level `editor_font_size`, `body_font_size` and `math_font_scale`
    /// above are the active values. This map is only consulted when a preset is
    /// selected; a missing entry means the preset has never been adjusted and
    /// starts at its default.
    #[serde(default)]
    pub preset_overrides: BTreeMap<String, PresetOverride>,
    #[serde(default)]
    pub ligatures_in_code: bool,
    #[serde(default = "default_true")]
    pub tabular_figures: bool,
    #[serde(default)]
    pub oldstyle_figures: bool,

    /// How a `.typ` document is drawn in the preview.
    ///
    /// `document` shows the compiler's HTML export — flowing, styled, selectable —
    /// and `pages` shows the rendered pages. Neither is enough alone: the document
    /// view cannot express layout, and the page view cannot reflow or be read as
    /// text. Defaults to `document` because reading is what a preview is for.
    #[serde(default = "default_typst_view")]
    pub typst_view: String,
    #[serde(default)]
    pub slashed_zero: bool,
    /// Editor syntax palette id, or "auto" to follow the application theme.
    pub syntax_theme: String,
    pub recent_files: Vec<String>,
    pub last_directory: Option<String>,
    /// Paths of the tabs that were open when the window last closed.
    ///
    /// Written by the frontend whenever the saved set changes, and read at boot
    /// when `on_launch` is `"tabs"`. Only documents with a path appear here:
    /// an untitled buffer has nothing to remember. Order is the tab order.
    #[serde(default)]
    pub last_tabs: Vec<String>,
    /// The path of the tab that should come back active, or `None` for the first.
    #[serde(default)]
    pub last_active_tab: Option<String>,

    // ---- Preferences: Files ----------------------------------------------
    /// "welcome" | "new" | "last" | "tabs"
    pub on_launch: String,
    pub default_extension: String,
    pub record_recent: bool,
    pub auto_save: bool,
    pub show_hidden_files: bool,

    // ---- Preferences: Markdown -------------------------------------------
    pub enable_math: bool,
    pub enable_mermaid: bool,

    // ---- Preferences: HTML -----------------------------------------------
    /// Run the document's own scripts in the sandboxed HTML preview.
    ///
    /// On by default: an HTML document is expected to behave like one. Turning
    /// it off keeps the preview's bridge (and therefore scroll sync) but blocks
    /// the document's scripts with a nonce-only CSP.
    #[serde(default = "default_true")]
    pub html_preview_scripts: bool,

    // ---- Preferences: Spelling -------------------------------------------
    /// Underline misspellings while typing.
    ///
    /// On by default. A settings file written before the field existed must
    /// come back on too, which is what `default_true` does: the container's
    /// `#[serde(default)]` would otherwise use `bool::default()`, and that is
    /// false.
    #[serde(default = "default_true")]
    pub spellcheck: bool,
    /// `"auto"`, or a tag `spellcheck_languages` reports (`en`, `en-GB`, `pt-BR`).
    #[serde(default = "default_spellcheck_language")]
    pub spellcheck_language: String,
    /// Words the reader ignored or added.
    ///
    /// Stored here, not via `ISpellChecker::Add`. That call writes the Windows
    /// user dictionary and would change spelling in every other program.
    #[serde(default)]
    pub spellcheck_words: Vec<String>,

    // ---- Preferences: Image ----------------------------------------------
    /// "assetsFolder" | "assetsDir" | "custom" | "keepOriginal"
    pub image_rule: String,
    pub image_custom_dir: String,
    pub image_apply_local: bool,
    pub image_apply_online: bool,
    pub image_use_relative_path: bool,
    pub image_add_dot_slash: bool,
    pub image_auto_escape: bool,

    // ---- Preferences: Paste ----------------------------------------------
    /// Convert copied HTML/Markdown/Typst into the destination's syntax.
    ///
    /// On by default; an older settings file keeps loading because serde fills
    /// the field with `true` when it is absent.
    #[serde(default = "default_true")]
    pub rich_paste: bool,
    /// "download" | "url": what to do with remote images found in a pasted
    /// fragment. The explicit paste-an-URL path has its own switch above.
    #[serde(default = "default_rich_paste_images")]
    pub rich_paste_images: String,
    /// Insert the closing half of a bracket or quote while typing.
    #[serde(default = "default_true")]
    pub auto_close_pairs: bool,
    /// Insert the matching closing tag when the `>` of an opening tag is typed
    /// in an HTML, Markdown or AsciiDoc document.
    #[serde(default = "default_true")]
    pub auto_close_tags: bool,

    // ---- Preferences: Export ---------------------------------------------
    /// Pandoc export targets, in the order the menu shows them.
    pub export_formats: Vec<ExportFormat>,

    /// What to do after a **successful** export, for every format.
    ///
    /// These were once stored per pandoc format. That made the option look
    /// dead: a box ticked for Word did nothing when the user exported HTML,
    /// PDF (Print) or any other format. The choices are global now, and the
    /// three paths that write a file — pandoc, Typst and HTML — all run them.
    /// PDF (Print) is the one exception: the browser chooses where the PDF
    /// goes, so MDraft has no path to open.
    #[serde(default)]
    pub after_open_location: bool,
    #[serde(default)]
    pub after_open_file: bool,
    #[serde(default)]
    pub after_run_command: bool,
    /// The user's own command. `${outputPath}` is substituted into it.
    #[serde(default)]
    pub after_command: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            view_mode: "split".into(),
            sidebar_tab: "outline".into(),
            sidebar_visible: true,
            sync_scroll: true,
            show_status_bar: true,
            focus_mode: false,
            typewriter_mode: false,
            editor_font_size: 15,
            editor_max_width: 980,
            editor_line_height: default_editor_line_height(),
            // Empty means "the built-in default for that role"; see src/fonts.ts.
            source_font: String::new(),
            body_font: String::new(),
            heading_font: String::new(),
            code_font: String::new(),
            body_font_size: default_body_font_size(),
            math_font_scale: default_math_font_scale(),
            preset_overrides: BTreeMap::new(),
            ligatures_in_code: false,
            tabular_figures: true,
            oldstyle_figures: false,
            typst_view: default_typst_view(),
            slashed_zero: false,
            syntax_theme: "auto".into(),
            recent_files: Vec::new(),
            last_directory: None,
            last_tabs: Vec::new(),
            last_active_tab: None,

            on_launch: "welcome".into(),
            default_extension: "md".into(),
            record_recent: true,
            auto_save: false,
            show_hidden_files: false,

            enable_math: true,
            enable_mermaid: true,
            html_preview_scripts: true,

            spellcheck: true,
            spellcheck_language: default_spellcheck_language(),
            spellcheck_words: Vec::new(),

            image_rule: "assetsFolder".into(),
            image_custom_dir: String::new(),
            image_apply_local: true,
            image_apply_online: true,
            image_use_relative_path: true,
            image_add_dot_slash: true,
            image_auto_escape: false,
            rich_paste: true,
            rich_paste_images: default_rich_paste_images(),
            auto_close_pairs: true,
            auto_close_tags: true,

            export_formats: default_export_formats(),
            after_open_location: false,
            after_open_file: false,
            after_run_command: false,
            after_command: String::new(),
        }
    }
}

/// Whether the external tools an export needs are installed.
///
/// `None` means "not checked yet". The menu is built before the frontend has
/// asked, and disabling formats on a guess would hide working ones; the
/// frontend sends a definite answer once `pandoc_status`/`typst_status` return,
/// and a later menu rebuild reads the cached value instead of starting over.
#[derive(Debug, Clone, Copy, Default)]
pub struct ExportAvailability {
    pub pandoc: Option<bool>,
    pub typst: Option<bool>,
}

pub struct AppState {
    pub settings: Mutex<Settings>,
    pub config_file: PathBuf,
    pub export_availability: Mutex<ExportAvailability>,
}

/// Deserialize a settings file, carrying the old per-format after-export flags
/// forward to the global ones.
///
/// The flags used to live on each `ExportFormat`, which meant a box ticked for
/// Word did nothing when the user exported HTML or PDF. They are global now.
/// A file written before that change has no `afterOpenLocation` key at the top
/// level, so its per-format values are OR-ed together and the old keys are
/// removed. Once a top-level key exists the file belongs to the new shape and
/// is left alone: otherwise unchecking a global box would be undone on the next
/// start by the obsolete per-format value.
fn parse_settings(raw: &str) -> Option<Settings> {
    let mut value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let object = value.as_object_mut()?;
    let legacy = ![
        "afterOpenLocation",
        "afterOpenFile",
        "afterRunCommand",
        "afterCommand",
    ]
    .iter()
    .any(|key| object.contains_key(*key));

    let mut open_location = false;
    let mut open_file = false;
    let mut run_command = false;
    let mut command = String::new();

    if let Some(formats) = object
        .get_mut("exportFormats")
        .and_then(|v| v.as_array_mut())
    {
        for format in formats {
            let Some(format) = format.as_object_mut() else {
                continue;
            };
            if legacy {
                open_location |= format
                    .remove("afterOpenLocation")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                open_file |= format
                    .remove("afterOpenFile")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                run_command |= format
                    .remove("afterRunCommand")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let candidate = format
                    .remove("afterCommand")
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .unwrap_or_default();
                if command.is_empty() {
                    command = candidate;
                }
            } else {
                // A file already in the new shape must not keep a stale copy of
                // the old keys, or an older build could resurrect them.
                format.remove("afterOpenLocation");
                format.remove("afterOpenFile");
                format.remove("afterRunCommand");
                format.remove("afterCommand");
            }
        }
    }

    if legacy {
        object.insert("afterOpenLocation".into(), open_location.into());
        object.insert("afterOpenFile".into(), open_file.into());
        object.insert("afterRunCommand".into(), run_command.into());
        object.insert("afterCommand".into(), command.into());
    }

    let mut settings: Settings = serde_json::from_value(value).ok()?;
    // A hand-edited or older file can carry more than the stored limit. Cap it
    // here so a load cannot grow the settings file without bound; the menu then
    // takes its own smaller slice when it is built.
    settings.recent_files.truncate(MAX_RECENT);
    settings.last_tabs.truncate(MAX_LAST_TABS);
    Some(settings)
}

impl AppState {
    /// Load settings from the app config directory, falling back to defaults.
    ///
    /// A missing or corrupt settings file must never stop the app from starting.
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Self {
        let dir = app
            .path()
            .app_config_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        let _ = std::fs::create_dir_all(&dir);
        let config_file = dir.join("settings.json");

        let settings = std::fs::read_to_string(&config_file)
            .ok()
            .and_then(|raw| parse_settings(&raw))
            .unwrap_or_default();

        Self {
            settings: Mutex::new(settings),
            config_file,
            export_availability: Mutex::new(ExportAvailability::default()),
        }
    }

    pub fn save(&self, mut next: Settings) -> Result<Settings, String> {
        // Every route that writes settings goes through here, including the
        // frontend's whole-object save. Keeping the cap here means a stale or
        // hand-built payload cannot grow the stored history without bound.
        next.recent_files.truncate(MAX_RECENT);
        next.last_tabs.truncate(MAX_LAST_TABS);
        write_json(&self.config_file, &next)?;
        let mut guard = self.settings.lock().map_err(|e| e.to_string())?;
        *guard = next.clone();
        Ok(next)
    }
}

/// Write JSON to `path` through a temporary sibling so a crash cannot truncate
/// the existing file.
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let body = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_settings(state: tauri::State<'_, AppState>) -> Settings {
    state
        .settings
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default()
}

/// Save settings, rebuilding the native menu when the export targets changed.
///
/// The Export submenu is generated from this list, and a native menu cannot be
/// edited in place, so adding, removing or renaming a format means constructing
/// a fresh menu. Doing it only when the list actually differs keeps every other
/// preference save from churning the menu bar.
#[tauri::command]
pub fn save_settings<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    settings: Settings,
) -> Result<Settings, String> {
    let (formats_changed, recents_changed) = {
        let current = state.settings.lock().map_err(|e| e.to_string())?;
        (
            current.export_formats != settings.export_formats,
            current.recent_files != settings.recent_files,
        )
    };

    let saved = state.save(settings)?;

    // Two parts of the native menu are generated from settings: the Export
    // submenu and Open Recent. Rebuilding when either list changed keeps the
    // menu from keeping a stale copy. Recents normally arrive through
    // `add_recent`/`clear_recent`, but Preferences and the tests save the whole
    // settings object too, so the same guard belongs here.
    if formats_changed || recents_changed {
        crate::menu::rebuild(&app, &saved);
    }

    Ok(saved)
}

/// Move `path` to the front of the recent list.
///
/// One rule table for every route that records a file, kept separate from the
/// command so it can be tested without a running application: the same path is
/// removed before insertion (so reopening a file does not duplicate it), the
/// newest entry is first, the list is capped at [`MAX_RECENT`], and the parent
/// folder becomes the next Open dialog's starting point.
fn record_recent(settings: &mut Settings, path: &str) {
    settings.recent_files.retain(|p| !same_path(p, path));
    settings.recent_files.insert(0, path.to_string());
    settings.recent_files.truncate(MAX_RECENT);
    settings.last_directory = Path::new(path)
        .parent()
        .map(|p| p.to_string_lossy().to_string());
}

#[tauri::command]
pub fn add_recent<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<Settings, String> {
    let mut next = state
        .settings
        .lock()
        .map_err(|e| e.to_string())?
        .clone();

    let previous = next.recent_files.clone();
    record_recent(&mut next, &path);
    let changed = next.recent_files != previous;

    let saved = state.save(next)?;
    // The native submenu is built from this list, and a menu cannot be edited in
    // place. Rebuilding only when the order or contents changed keeps the common
    // case — reopening the file already at the top — from churning the menu bar.
    if changed {
        crate::menu::rebuild(&app, &saved);
    }
    Ok(saved)
}

#[tauri::command]
pub fn clear_recent<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
) -> Result<Settings, String> {
    let mut next = state
        .settings
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let had_recent = !next.recent_files.is_empty();
    next.recent_files.clear();
    let saved = state.save(next)?;
    if had_recent {
        crate::menu::rebuild(&app, &saved);
    }
    Ok(saved)
}

/// Compare two paths for equality, tolerating case and separator differences on
/// Windows while still being case-sensitive elsewhere.
pub fn same_path(a: &str, b: &str) -> bool {
    let normalize = |value: &str| {
        let unified = value.replace('\\', "/");
        let trimmed = unified.trim_end_matches('/').to_string();
        if cfg!(windows) {
            trimmed.to_lowercase()
        } else {
            trimmed
        }
    };
    normalize(a) == normalize(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_sane() {
        let s = Settings::default();
        assert_eq!(s.view_mode, "split");
        assert_eq!(s.editor_font_size, 15);
        assert_eq!(s.editor_max_width, 980);
        assert_eq!(s.editor_line_height, "normal");
        assert_eq!(s.syntax_theme, "auto");
        assert!(s.recent_files.is_empty());
        assert!(s.spellcheck);
        assert_eq!(s.spellcheck_language, "auto");
        assert!(s.spellcheck_words.is_empty());
    }

    #[test]
    fn a_settings_file_without_spellcheck_keys_comes_back_on() {
        // The container default would make a missing bool false. The field
        // default is what keeps an older file checking spelling.
        let settings = parse_settings("{}").expect("an empty object is still settings");
        assert!(settings.spellcheck);
        assert_eq!(settings.spellcheck_language, "auto");
        assert!(settings.spellcheck_words.is_empty());
    }

    #[test]
    fn typography_defaults_are_the_system_preset() {
        let s = Settings::default();
        // Empty means "the built-in default for that role", which lives in
        // src/fonts.ts beside the reasoning for each stack. Storing the stacks
        // here would be a second copy to keep in step.
        assert_eq!(s.source_font, "");
        assert_eq!(s.body_font, "");
        assert_eq!(s.heading_font, "");
        assert_eq!(s.code_font, "");
        assert_eq!(s.body_font_size, 16);
        // The System preset's own starting point; the preference opts into a change.
        assert_eq!(s.math_font_scale, 90);
        // The HTML guest runs the document's scripts unless the reader opts out.
        assert!(s.html_preview_scripts);
        // Sizes are per-preset adjustments, so a fresh profile has none yet.
        assert!(s.preset_overrides.is_empty());
        // Off by default, because whether `->` should render as an arrow is a
        // genuine disagreement and the conservative answer is the plain one.
        assert!(!s.ligatures_in_code);
        // On by default, because proportional figures in a table are one of the
        // few typographic choices with a right answer.
        assert!(s.tabular_figures);
        assert!(!s.oldstyle_figures);
        assert!(!s.slashed_zero);
        // Rich paste is on, and remote images are downloaded unless the reader
        // changes that one select.
        assert!(s.rich_paste);
        assert_eq!(s.rich_paste_images, "download");
        // The delimiters a writer types most: both are on, matching Typora.
        assert!(s.auto_close_pairs);
        assert!(s.auto_close_tags);
    }

    #[test]
    fn auto_close_settings_round_trip() {
        let mut settings = Settings::default();
        settings.auto_close_pairs = false;
        settings.auto_close_tags = false;
        let json = serde_json::to_string(&settings).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert!(!back.auto_close_pairs);
        assert!(!back.auto_close_tags);
    }

    #[test]
    fn rich_paste_settings_round_trip() {
        let mut settings = Settings::default();
        settings.rich_paste = false;
        settings.rich_paste_images = "url".into();
        let json = serde_json::to_string(&settings).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert!(!back.rich_paste);
        assert_eq!(back.rich_paste_images, "url");
    }

    #[test]
    fn editor_line_height_round_trips_as_a_name() {
        let mut settings = Settings::default();
        settings.editor_line_height = "compact".into();
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains(r#""editorLineHeight":"compact""#));
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.editor_line_height, "compact");
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let parsed: Settings = serde_json::from_str(r#"{"theme":"dark"}"#).unwrap();
        assert_eq!(parsed.theme, "dark");
        assert_eq!(parsed.view_mode, "split");
        assert!(parsed.sidebar_visible);
        // Settings written by an older build must still load.
        assert_eq!(parsed.on_launch, "welcome");
        assert_eq!(parsed.editor_line_height, "normal");
        assert!(parsed.enable_math);
        assert!(!parsed.auto_save);
        assert_eq!(parsed.image_rule, "assetsFolder");
        assert!(parsed.image_apply_online);
        assert!(!parsed.image_auto_escape);
        assert!(parsed.rich_paste);
        assert_eq!(parsed.rich_paste_images, "download");
        assert!(parsed.auto_close_pairs);
        assert!(parsed.auto_close_tags);
        assert!(parsed.preset_overrides.is_empty());
    }

    #[test]
    fn a_settings_file_written_before_typography_existed_still_loads() {
        // Every typography field is new, so this is the case that matters: a
        // reader upgrading must not lose their settings or see the application
        // refuse to start. The font fields default to empty rather than to a
        // stack, which is what makes "unset" distinguishable from "chosen".
        let parsed: Settings =
            serde_json::from_str(r#"{"theme":"dark","editorFontSize":21}"#).unwrap();
        assert_eq!(parsed.theme, "dark");
        assert_eq!(parsed.editor_font_size, 21);
        assert_eq!(parsed.body_font, "");
        assert_eq!(parsed.body_font_size, 16);
        assert_eq!(parsed.math_font_scale, 90);
        assert!(parsed.preset_overrides.is_empty());
        assert!(parsed.html_preview_scripts);
        // `tabular_figures` is `#[serde(default = "default_true")]`, so the
        // serde default and the struct default have to agree or an upgrade would
        // silently change how tables render.
        assert_eq!(
            parsed.tabular_figures,
            Settings::default().tabular_figures,
            "the serde default for tabular_figures disagrees with Settings::default()"
        );
    }

    #[test]
    fn preset_overrides_round_trip_and_may_be_partial() {
        // A preset may remember only a subset of the three sizes; the others
        // must stay absent so the preset's default continues to apply.
        let parsed: Settings = serde_json::from_str(
            r#"{"presetOverrides":{"superfamily":{"editorFontSize":18,"bodyFontSize":19,"mathFontScale":83},"system":{"bodyFontSize":18}}}"#,
        )
        .unwrap();
        assert_eq!(
            parsed.preset_overrides["superfamily"].editor_font_size,
            Some(18)
        );
        assert_eq!(
            parsed.preset_overrides["superfamily"].body_font_size,
            Some(19)
        );
        assert_eq!(
            parsed.preset_overrides["superfamily"].math_font_scale,
            Some(83)
        );
        assert_eq!(parsed.preset_overrides["system"].editor_font_size, None);
        assert_eq!(parsed.preset_overrides["system"].body_font_size, Some(18));
        assert_eq!(parsed.preset_overrides["system"].math_font_scale, None);

        let json = serde_json::to_value(&parsed).unwrap();
        assert_eq!(json["presetOverrides"]["superfamily"]["editorFontSize"], 18);
        assert_eq!(json["presetOverrides"]["superfamily"]["mathFontScale"], 83);
        assert!(
            json["presetOverrides"]["system"].get("editorFontSize").is_none(),
            "a missing size must stay absent rather than serialising as null"
        );
        assert!(
            json["presetOverrides"]["system"].get("mathFontScale").is_none(),
            "a missing size must stay absent rather than serialising as null"
        );
    }

    #[test]
    fn same_path_ignores_separators() {
        assert!(same_path(r"C:\Docs\a.md", "C:/Docs/a.md"));
        #[cfg(windows)]
        assert!(same_path(r"C:\Docs\a.md", r"c:\docs\A.MD"));
        #[cfg(not(windows))]
        assert!(!same_path("/Docs/a.md", "/docs/a.md"));
    }

    #[test]
    fn remembered_tabs_default_to_empty_and_come_back_from_old_files() {
        let s = Settings::default();
        assert!(s.last_tabs.is_empty());
        assert_eq!(s.last_active_tab, None);

        // A file written before the feature existed has neither key. It must
        // load, with the preference untouched and the list empty.
        let parsed: Settings =
            serde_json::from_str(r#"{"theme":"dark","onLaunch":"last"}"#).unwrap();
        assert_eq!(parsed.on_launch, "last");
        assert!(parsed.last_tabs.is_empty());
        assert_eq!(parsed.last_active_tab, None);
    }

    #[test]
    fn remembered_tabs_round_trip() {
        let mut settings = Settings::default();
        settings.on_launch = "tabs".into();
        settings.last_tabs = vec![
            "C:/Docs/a.md".into(),
            "C:/Docs/b.md".into(),
            "C:/Docs/c.md".into(),
        ];
        settings.last_active_tab = Some("C:/Docs/b.md".into());

        let json = serde_json::to_string(&settings).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.on_launch, "tabs");
        assert_eq!(
            back.last_tabs,
            vec!["C:/Docs/a.md", "C:/Docs/b.md", "C:/Docs/c.md"]
        );
        assert_eq!(back.last_active_tab.as_deref(), Some("C:/Docs/b.md"));
    }

    #[test]
    fn settings_load_caps_an_overlong_remembered_tab_list() {
        // Same guard as the recent list: a hand-edited file must not make the
        // next launch open hundreds of documents.
        let paths: Vec<String> = (0..=MAX_LAST_TABS)
            .map(|index| format!("C:/Docs/file{index}.md"))
            .collect();
        let raw = serde_json::json!({ "lastTabs": paths }).to_string();

        let parsed = parse_settings(&raw).expect("a tab list is still settings");
        assert_eq!(parsed.last_tabs.len(), MAX_LAST_TABS);
        assert_eq!(parsed.last_tabs[0], "C:/Docs/file0.md");
        assert_eq!(
            parsed.last_tabs[MAX_LAST_TABS - 1],
            format!("C:/Docs/file{}.md", MAX_LAST_TABS - 1)
        );
    }

    #[test]
    fn settings_load_caps_an_overlong_recent_list() {
        // A hand-edited file (or a future import) must not grow the sidebar
        // history without bound. The native submenu caps itself at 20
        // separately, so this test is about the store, not the menu.
        let paths: Vec<String> = (0..=MAX_RECENT)
            .map(|index| format!("C:/Docs/file{index}.md"))
            .collect();
        let raw = serde_json::json!({ "recentFiles": paths }).to_string();

        let parsed = parse_settings(&raw).expect("a recent list is still settings");
        assert_eq!(parsed.recent_files.len(), MAX_RECENT);
        assert_eq!(parsed.recent_files[0], "C:/Docs/file0.md");
        assert_eq!(
            parsed.recent_files[MAX_RECENT - 1],
            format!("C:/Docs/file{}.md", MAX_RECENT - 1)
        );
    }

    #[test]
    fn recent_files_are_newest_first_deduplicated_and_capped() {
        let mut settings = Settings::default();
        // One more than the limit, so the oldest entries must fall off.
        for index in 0..=MAX_RECENT {
            record_recent(&mut settings, &format!("C:/Docs/file{index}.md"));
        }

        assert_eq!(settings.recent_files.len(), MAX_RECENT);
        assert_eq!(
            settings.recent_files[0],
            format!("C:/Docs/file{MAX_RECENT}.md")
        );
        assert_eq!(settings.recent_files[MAX_RECENT - 1], "C:/Docs/file1.md");
        assert_eq!(settings.last_directory.as_deref(), Some("C:/Docs"));

        // Reopening an existing file moves it to the front instead of adding a
        // second copy, and the list stays at the cap.
        record_recent(&mut settings, "C:/Docs/file10.md");
        assert_eq!(settings.recent_files.len(), MAX_RECENT);
        assert_eq!(settings.recent_files[0], "C:/Docs/file10.md");
        assert_eq!(
            settings
                .recent_files
                .iter()
                .filter(|path| path.ends_with("file10.md"))
                .count(),
            1
        );

        // The same path under the platform's own identity is the same entry.
        #[cfg(windows)]
        {
            record_recent(&mut settings, r"c:\docs\FILE10.MD");
            assert_eq!(settings.recent_files.len(), MAX_RECENT);
            assert_eq!(settings.recent_files[0], r"c:\docs\FILE10.MD");
            assert_eq!(
                settings
                    .recent_files
                    .iter()
                    .filter(|path| path.to_lowercase().ends_with("file10.md"))
                    .count(),
                1
            );
        }
    }

    #[test]
    fn legacy_per_format_after_export_flags_become_global() {
        // The shape written by every release before the options moved out of
        // the format editor: the flags are on the formats, and no top-level
        // `afterOpenLocation` exists. The OR is deliberate — a user who ticked
        // one box on Word and another on PDF meant both actions.
        let legacy = r#"{
            "theme": "dark",
            "exportFormats": [
                {
                    "id": "docx", "label": "Word (.docx)", "extension": "docx",
                    "arguments": "-s -o ${outputPath}", "extraArguments": "",
                    "styleReference": "",
                    "afterOpenLocation": true, "afterOpenFile": true,
                    "afterRunCommand": false, "afterCommand": ""
                },
                {
                    "id": "pdf", "label": "PDF", "extension": "pdf",
                    "arguments": "-s -o ${outputPath}", "extraArguments": "",
                    "styleReference": "",
                    "afterOpenLocation": false, "afterOpenFile": false,
                    "afterRunCommand": true, "afterCommand": "echo ${outputPath}"
                }
            ]
        }"#;
        let parsed = parse_settings(legacy).expect("legacy settings should load");
        assert_eq!(parsed.theme, "dark");
        assert!(parsed.after_open_location);
        assert!(parsed.after_open_file);
        assert!(parsed.after_run_command);
        assert_eq!(parsed.after_command, "echo ${outputPath}");
        // The old keys are gone from the formats in memory, so saving cannot
        // bring them back for an older build to read.
        let json = serde_json::to_value(&parsed).unwrap();
        let formats = json["exportFormats"].as_array().unwrap();
        assert!(formats.iter().all(|f| f.get("afterOpenLocation").is_none()));
        assert!(formats.iter().all(|f| f.get("afterCommand").is_none()));
        // But the format itself survives untouched.
        assert_eq!(parsed.export_formats[0].id, "docx");
        assert_eq!(parsed.export_formats[0].label, "Word (.docx)");
    }

    #[test]
    fn explicit_global_after_export_flags_are_not_overwritten_by_legacy_ones() {
        // Once the file has a top-level key it belongs to the new shape. If the
        // user unticks the global box, the stale per-format true values must not
        // silently turn it back on at the next start.
        let current = r#"{
            "afterOpenLocation": false,
            "afterOpenFile": false,
            "afterRunCommand": false,
            "afterCommand": "",
            "exportFormats": [
                {
                    "id": "docx", "label": "Word (.docx)", "extension": "docx",
                    "arguments": "-s -o ${outputPath}", "extraArguments": "",
                    "styleReference": "",
                    "afterOpenLocation": true, "afterOpenFile": true,
                    "afterRunCommand": true, "afterCommand": "rm -rf /"
                }
            ]
        }"#;
        let parsed = parse_settings(current).expect("current settings should load");
        assert!(!parsed.after_open_location);
        assert!(!parsed.after_open_file);
        assert!(!parsed.after_run_command);
        assert_eq!(parsed.after_command, "");
    }

    #[test]
    fn after_export_defaults_are_off() {
        let settings = Settings::default();
        assert!(!settings.after_open_location);
        assert!(!settings.after_open_file);
        assert!(!settings.after_run_command);
        assert!(settings.after_command.is_empty());
    }
}

