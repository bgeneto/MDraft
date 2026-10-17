//! Persisted application settings and the shared application state.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};

/// Maximum number of entries kept in the "recent files" list.
const MAX_RECENT: usize = 20;

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
    pub after_open_location: bool,
    pub after_open_file: bool,
    pub after_run_command: bool,
    /// The user's own command. `${outputPath}` is substituted into it.
    pub after_command: String,
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
            after_open_location: false,
            after_open_file: false,
            after_run_command: false,
            after_command: String::new(),
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
fn default_true() -> bool {
    true
}

fn default_body_font_size() -> u32 {
    16
}

pub fn default_export_formats() -> Vec<ExportFormat> {    let args = |rest: &str| format!("{PANDOC_INPUT} {rest}");
    vec![
        ExportFormat::new(
            "pdf",
            "PDF (via LaTeX)",
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
    #[serde(default)]
    pub ligatures_in_code: bool,
    #[serde(default = "default_true")]
    pub tabular_figures: bool,
    #[serde(default)]
    pub oldstyle_figures: bool,
    #[serde(default)]
    pub slashed_zero: bool,
    /// Editor syntax palette id, or "auto" to follow the application theme.
    pub syntax_theme: String,
    pub recent_files: Vec<String>,
    pub last_directory: Option<String>,

    // ---- Preferences: Files ----------------------------------------------
    /// "welcome" | "new" | "last"
    pub on_launch: String,
    pub default_extension: String,
    pub record_recent: bool,
    pub auto_save: bool,
    pub show_hidden_files: bool,

    // ---- Preferences: Markdown -------------------------------------------
    pub enable_math: bool,
    pub enable_mermaid: bool,

    // ---- Preferences: Image ----------------------------------------------
    /// "assetsFolder" | "assetsDir" | "custom" | "keepOriginal"
    pub image_rule: String,
    pub image_custom_dir: String,
    pub image_apply_local: bool,
    pub image_apply_online: bool,
    pub image_use_relative_path: bool,
    pub image_add_dot_slash: bool,
    pub image_auto_escape: bool,

    // ---- Preferences: Export ---------------------------------------------
    /// Pandoc export targets, in the order the menu shows them.
    pub export_formats: Vec<ExportFormat>,
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
            editor_font_size: 16,
            editor_max_width: 980,
            // Empty means "the built-in default for that role"; see src/fonts.ts.
            source_font: String::new(),
            body_font: String::new(),
            heading_font: String::new(),
            code_font: String::new(),
            body_font_size: default_body_font_size(),
            ligatures_in_code: false,
            tabular_figures: true,
            oldstyle_figures: false,
            slashed_zero: false,
            syntax_theme: "auto".into(),
            recent_files: Vec::new(),
            last_directory: None,

            on_launch: "welcome".into(),
            default_extension: "md".into(),
            record_recent: true,
            auto_save: false,
            show_hidden_files: false,

            enable_math: true,
            enable_mermaid: true,

            image_rule: "assetsFolder".into(),
            image_custom_dir: String::new(),
            image_apply_local: true,
            image_apply_online: true,
            image_use_relative_path: true,
            image_add_dot_slash: true,
            image_auto_escape: false,

            export_formats: default_export_formats(),
        }
    }
}

pub struct AppState {
    pub settings: Mutex<Settings>,
    pub config_file: PathBuf,
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
            .and_then(|raw| serde_json::from_str::<Settings>(&raw).ok())
            .unwrap_or_default();

        Self {
            settings: Mutex::new(settings),
            config_file,
        }
    }

    pub fn save(&self, next: Settings) -> Result<Settings, String> {
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
    let formats_changed = {
        let current = state.settings.lock().map_err(|e| e.to_string())?;
        current.export_formats != settings.export_formats
    };

    let saved = state.save(settings)?;

    if formats_changed {
        match crate::menu::build(&app) {
            Ok(menu) => {
                if let Err(error) = app.set_menu(menu) {
                    eprintln!("[menu] could not be rebuilt after an export change: {error}");
                }
            }
            Err(error) => eprintln!("[menu] could not be rebuilt after an export change: {error}"),
        }
    }

    Ok(saved)
}

#[tauri::command]
pub fn add_recent(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<Settings, String> {
    let mut next = state
        .settings
        .lock()
        .map_err(|e| e.to_string())?
        .clone();

    next.recent_files.retain(|p| !same_path(p, &path));
    next.recent_files.insert(0, path.clone());
    next.recent_files.truncate(MAX_RECENT);
    next.last_directory = Path::new(&path)
        .parent()
        .map(|p| p.to_string_lossy().to_string());

    state.save(next)
}

#[tauri::command]
pub fn clear_recent(state: tauri::State<'_, AppState>) -> Result<Settings, String> {
    let mut next = state
        .settings
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    next.recent_files.clear();
    state.save(next)
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
        assert_eq!(s.editor_font_size, 16);
        assert_eq!(s.editor_max_width, 980);
        assert_eq!(s.syntax_theme, "auto");
        assert!(s.recent_files.is_empty());
    }

    #[test]
    fn typography_defaults_are_the_literary_preset() {
        let s = Settings::default();
        // Empty means "the built-in default for that role", which lives in
        // src/fonts.ts beside the reasoning for each stack. Storing the stacks
        // here would be a second copy to keep in step.
        assert_eq!(s.source_font, "");
        assert_eq!(s.body_font, "");
        assert_eq!(s.heading_font, "");
        assert_eq!(s.code_font, "");
        assert_eq!(s.body_font_size, 16);
        // Off by default, because whether `->` should render as an arrow is a
        // genuine disagreement and the conservative answer is the plain one.
        assert!(!s.ligatures_in_code);
        // On by default, because proportional figures in a table are one of the
        // few typographic choices with a right answer.
        assert!(s.tabular_figures);
        assert!(!s.oldstyle_figures);
        assert!(!s.slashed_zero);
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let parsed: Settings = serde_json::from_str(r#"{"theme":"dark"}"#).unwrap();
        assert_eq!(parsed.theme, "dark");
        assert_eq!(parsed.view_mode, "split");
        assert!(parsed.sidebar_visible);
        // Settings written by an older build must still load.
        assert_eq!(parsed.on_launch, "welcome");
        assert!(parsed.enable_math);
        assert!(!parsed.auto_save);
        assert_eq!(parsed.image_rule, "assetsFolder");
        assert!(parsed.image_apply_online);
        assert!(!parsed.image_auto_escape);
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
    fn same_path_ignores_separators() {
        assert!(same_path(r"C:\Docs\a.md", "C:/Docs/a.md"));
        #[cfg(windows)]
        assert!(same_path(r"C:\Docs\a.md", r"c:\docs\A.MD"));
        #[cfg(not(windows))]
        assert!(!same_path("/Docs/a.md", "/docs/a.md"));
    }
}
