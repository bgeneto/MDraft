//! Prepare a validated backup for a journaled, category-level restore.

use super::format::{self, Manifest};
use super::inbox;
use super::snapshot;
use super::transaction::{Replacement, Target};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

const MAX_SETTINGS: u64 = 16 * 1024 * 1024;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub settings: bool,
    pub prompts: bool,
    pub personal: bool,
    pub recovery: bool,
    pub downloads: bool,
    pub window: bool,
}

pub struct Prepared {
    pub replacements: Vec<Replacement>,
    pub recovered_documents: usize,
    pub salvaged_journals: usize,
    pub quarantined_downloads: usize,
    pub adjustments: Vec<String>,
}

fn is_selected(selection: &Selection, name: &str) -> bool {
    match name {
        "settings" => selection.settings,
        "prompts" => selection.prompts,
        "personal" => selection.personal,
        "recovery" | "session" => selection.recovery,
        "downloads" => selection.downloads,
        "window" => selection.window,
        _ => false,
    }
}

fn require_available(manifest: &Manifest, selection: &Selection) -> Result<(), String> {
    if !selection.settings
        && !selection.prompts
        && !selection.personal
        && !selection.recovery
        && !selection.downloads
        && !selection.window
    {
        return Err("Select at least one category to restore.".into());
    }
    for (name, category) in &manifest.categories {
        if is_selected(selection, name) && !category.included {
            return Err(format!(
                "The selected {name} category is not in this backup."
            ));
        }
    }
    if (selection.downloads || selection.window)
        && (manifest.source_os != std::env::consts::OS
            || manifest.source_arch != std::env::consts::ARCH)
    {
        return Err(
            "Downloaded tools and window placement are not compatible with this platform.".into(),
        );
    }
    Ok(())
}

fn retains_original_fields(original: &serde_json::Value, decoded: &serde_json::Value) -> bool {
    match (original, decoded) {
        (serde_json::Value::Object(left), serde_json::Value::Object(right)) => {
            left.iter().all(|(key, value)| {
                right
                    .get(key)
                    .is_some_and(|other| retains_original_fields(value, other))
            })
        }
        (serde_json::Value::Array(left), serde_json::Value::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(value, other)| retains_original_fields(value, other))
        }
        _ => original == decoded,
    }
}

fn create_private(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|error| error.to_string())
}

fn read_settings(path: &Path) -> Result<crate::settings::Settings, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Could not read backed-up settings: {error}"))?;
    if snapshot::is_link(&metadata) || !metadata.is_file() || metadata.len() > MAX_SETTINGS {
        return Err("The backed-up settings are invalid or too large.".into());
    }
    let mut file = snapshot::open_regular(
        path.parent().ok_or("Invalid settings path.")?,
        Path::new(path.file_name().ok_or("Invalid settings file.")?),
    )?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(MAX_SETTINGS + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_SETTINGS {
        return Err("The backed-up settings are too large.".into());
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("The backed-up settings are invalid: {error}"))?;
    if !value.is_object() {
        return Err("The backed-up settings are not an object.".into());
    }
    let settings: crate::settings::Settings = serde_json::from_value(value.clone())
        .map_err(|error| format!("The backed-up settings are invalid: {error}"))?;
    let decoded = serde_json::to_value(&settings).map_err(|error| error.to_string())?;
    if !retains_original_fields(&value, &decoded) {
        return Err("The backup contains settings from an unsupported application version.".into());
    }
    Ok(settings)
}

fn copy_download(
    extracted: &Path,
    destination: &Path,
    entry: &format::Entry,
    progress: &mut impl FnMut(u64) -> Result<(), String>,
) -> Result<(), String> {
    let relative = entry
        .path
        .strip_prefix("data/")
        .ok_or("An archived tool has an invalid path.")?;
    format::validate_name(relative)?;
    let target = destination.join(relative);
    fs::create_dir_all(target.parent().ok_or("Invalid archived tool path.")?)
        .map_err(|error| error.to_string())?;
    let mut source = snapshot::open_regular(extracted, Path::new(&entry.path))?;
    let mut output = create_private(&target)?;
    let (bytes, hash) = format::copy_hashed_with(&mut source, &mut output, entry.bytes, progress)?;
    if bytes != entry.bytes || hash != entry.sha256 {
        return Err(format!(
            "An archived tool changed after verification: {}",
            entry.path
        ));
    }
    output.sync_all().map_err(|error| error.to_string())
}

/// All output is staged; no application profile is changed by this function.
#[cfg(test)]
pub fn prepare(
    extracted: &Path,
    destination: &Path,
    manifest: &Manifest,
    selection: &Selection,
    existing: &HashSet<(String, String)>,
) -> Result<Prepared, String> {
    prepare_with(
        extracted,
        destination,
        manifest,
        selection,
        existing,
        &mut |_| Ok(()),
    )
}

pub fn prepare_with(
    extracted: &Path,
    destination: &Path,
    manifest: &Manifest,
    selection: &Selection,
    existing: &HashSet<(String, String)>,
    progress: &mut impl FnMut(u64) -> Result<(), String>,
) -> Result<Prepared, String> {
    require_available(manifest, selection)?;
    fs::create_dir(destination).map_err(|error| error.to_string())?;
    let mut prepared = Prepared {
        replacements: Vec::new(),
        recovered_documents: 0,
        salvaged_journals: 0,
        quarantined_downloads: 0,
        adjustments: Vec::new(),
    };
    if selection.settings {
        let mut settings = read_settings(&extracted.join("config/settings.json"))?;
        if settings.after_run_command {
            prepared
                .adjustments
                .push("The after-export command is off until you re-enable it.".into());
        }
        if settings.ai_enabled {
            prepared
                .adjustments
                .push("The AI Assistant is off until you re-enable it.".into());
        }
        if settings.on_launch != "new" {
            prepared.adjustments.push(format!(
                "On Launch was set to New to keep restored paths closed. Its previous value was {}.",
                settings.on_launch
            ));
            settings.on_launch = "new".into();
        }
        if settings.latex_native_enabled
            || settings.latex_native_root.is_some()
            || settings.latex_native_wsl.is_some()
        {
            prepared.adjustments.push(
                "Choose and validate the installed TeX distribution again before using it.".into(),
            );
            if let Some(root) = &settings.latex_native_root {
                prepared
                    .adjustments
                    .push(format!("Previous native TeX path: {root}"));
            }
            if let Some(distribution) = &settings.latex_native_wsl {
                prepared.adjustments.push(format!(
                    "Previous WSL TeX selection: {} ({})",
                    distribution.distro, distribution.bin
                ));
            }
        }
        settings.after_run_command = false;
        settings.ai_enabled = false;
        settings.latex_native_enabled = false;
        settings.latex_native_root = None;
        settings.latex_native_wsl = None;
        let bytes = serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?;
        let path = destination.join("settings.json");
        let mut file = create_private(&path)?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|error| error.to_string())?;
        prepared.replacements.push(Replacement {
            target: Target::Settings,
            source: Some(path),
        });
    }
    for (selected, name, target, relative) in [
        (
            selection.prompts,
            "prompts",
            Target::Prompts,
            "config/ai-prompts.md",
        ),
        (
            selection.personal,
            "personal",
            Target::Personal,
            "config/texmf",
        ),
        (
            selection.window,
            "window",
            Target::Window,
            "config/.window-state.json",
        ),
    ] {
        if !selected {
            continue;
        }
        let category = manifest
            .categories
            .get(name)
            .ok_or("The backup category is missing.")?;
        let source = if category.present {
            let path = extracted.join(relative);
            if !path.exists() && name == "personal" {
                // An included personal tree may have been empty.
                let empty = destination.join("empty-personal");
                fs::create_dir(&empty).map_err(|error| error.to_string())?;
                Some(empty)
            } else if path.exists() {
                Some(path)
            } else {
                return Err(format!("The backed-up {name} category is missing."));
            }
        } else {
            None
        };
        prepared.replacements.push(Replacement { target, source });
    }
    if selection.recovery || selection.downloads {
        let mut inbox_manifest = manifest.clone();
        if !selection.recovery {
            inbox_manifest
                .entries
                .retain(|entry| entry.category != "recovery" && entry.category != "session");
        }
        let path = destination.join("recovered");
        let index = inbox::build_with(extracted, &path, &inbox_manifest, existing, progress)?;
        prepared.recovered_documents = index.documents.len();
        prepared.salvaged_journals = index.salvaged_journals;
        if selection.downloads {
            let downloads = path.join("unverified-downloads");
            for entry in manifest
                .entries
                .iter()
                .filter(|entry| entry.category == "downloads")
            {
                if !downloads.exists() {
                    fs::create_dir(&downloads).map_err(|error| error.to_string())?;
                }
                progress(0)?;
                copy_download(extracted, &downloads, entry, progress)?;
                prepared.quarantined_downloads += 1;
            }
            if prepared.quarantined_downloads > 0 {
                prepared.adjustments.push("Downloaded tools were retained under the Settings Folder in recovered-backups/<restore-id>/unverified-downloads and need trusted setup before use.".into());
            }
        }
        if prepared.recovered_documents > 0
            || prepared.salvaged_journals > 0
            || index.preserved_files > 0
            || prepared.quarantined_downloads > 0
        {
            prepared.replacements.push(Replacement {
                target: Target::Recovered,
                source: Some(path),
            });
        }
    }
    if prepared.replacements.is_empty() {
        return Err("The selected categories contain nothing to restore.".into());
    }
    Ok(prepared)
}

/// The frontend receives a compact summary only after validation succeeded.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub format_version: u32,
    pub app_version: String,
    pub created_at_ms: u64,
    pub source_os: String,
    pub source_arch: String,
    pub portable: bool,
    pub total_bytes: u64,
    pub categories: std::collections::BTreeMap<String, format::Category>,
    pub compatible_platform: bool,
}

pub fn preview(manifest: &Manifest) -> Result<Preview, String> {
    let total_bytes = manifest
        .entries
        .iter()
        .try_fold(0_u64, |sum, entry| sum.checked_add(entry.bytes))
        .ok_or("The backup size is invalid.")?;
    Ok(Preview {
        format_version: manifest.format_version,
        app_version: manifest.app_version.clone(),
        created_at_ms: manifest.created_at_ms,
        source_os: manifest.source_os.clone(),
        source_arch: manifest.source_arch.clone(),
        portable: manifest.portable,
        total_bytes,
        categories: manifest.categories.clone(),
        compatible_platform: manifest.source_os == std::env::consts::OS
            && manifest.source_arch == std::env::consts::ARCH,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::format::{Category, Entry};
    use crate::backup::inbox::{Buffer, SessionSnapshot};
    use crate::backup::snapshot::Roots;
    use crate::backup::transaction;
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "mdraft-backup-restore-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            if self.0.parent() == Some(std::env::temp_dir().as_path())
                && self.0.file_name().is_some_and(|name| {
                    name.to_string_lossy().starts_with("mdraft-backup-restore-")
                })
            {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }

    fn manifest() -> Manifest {
        let names = [
            "settings",
            "prompts",
            "personal",
            "recovery",
            "session",
            "window",
            "downloads",
        ];
        Manifest {
            format: format::FORMAT.into(),
            format_version: 1,
            app_version: "0.9.1".into(),
            created_at_ms: 1,
            capture_started_ms: 1,
            capture_finished_ms: 2,
            source_os: std::env::consts::OS.into(),
            source_arch: std::env::consts::ARCH.into(),
            portable: false,
            component_versions: names.into_iter().map(|name| (name.into(), 1)).collect(),
            categories: names
                .into_iter()
                .map(|name| {
                    (
                        name.into(),
                        Category {
                            included: true,
                            present: true,
                        },
                    )
                })
                .collect::<BTreeMap<_, _>>(),
            directories: Vec::new(),
            entries: Vec::new(),
        }
    }

    fn add_file(root: &Path, manifest: &mut Manifest, name: &str, bytes: &[u8], category: &str) {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
        manifest.entries.push(Entry {
            path: name.into(),
            category: category.into(),
            bytes: bytes.len() as u64,
            sha256: crate::export::sha256_hex(bytes),
            executable: false,
        });
    }

    #[test]
    fn restores_preferences_and_writing_without_enabling_untrusted_code() {
        let temp = Scratch::new();
        let extracted = temp.0.join("extracted");
        let config = temp.0.join("config");
        fs::create_dir(&extracted).unwrap();
        fs::create_dir(&config).unwrap();
        fs::write(config.join("settings.json"), "previous settings").unwrap();
        fs::write(config.join("ai-keys.json"), "do not touch").unwrap();
        let mut manifest = manifest();
        let settings = crate::settings::Settings {
            theme: "dark".into(),
            after_run_command: true,
            after_command: "example command".into(),
            ai_enabled: true,
            latex_native_enabled: true,
            latex_native_root: Some("/example/tools".into()),
            ..Default::default()
        };
        add_file(
            &extracted,
            &mut manifest,
            "config/settings.json",
            &serde_json::to_vec(&settings).unwrap(),
            "settings",
        );
        add_file(
            &extracted,
            &mut manifest,
            "config/ai-prompts.md",
            b"custom prompt",
            "prompts",
        );
        add_file(
            &extracted,
            &mut manifest,
            "config/texmf/tex/latex/mine.sty",
            b"package",
            "personal",
        );
        let buffer = Buffer {
            id: "doc-1".into(),
            name: "Draft.md".into(),
            language: "markdown".into(),
            path: Some("/external/document.md".into()),
            line_ending: "\n".into(),
            had_bom: false,
            encoding: Some("UTF-8".into()),
            lossy: false,
            read_only: false,
            base_modified_ms: 1,
            base_size: 2,
            base_sha256: None,
        };
        let session = SessionSnapshot {
            version: 1,
            active_id: Some(buffer.id.clone()),
            buffers: vec![buffer],
        };
        add_file(
            &extracted,
            &mut manifest,
            "session/session.json",
            &serde_json::to_vec(&session).unwrap(),
            "session",
        );
        add_file(
            &extracted,
            &mut manifest,
            "session/buffers/doc-1.txt",
            b"unsaved text",
            "session",
        );
        add_file(
            &extracted,
            &mut manifest,
            "data/pandoc/tool.exe",
            b"untrusted binary",
            "downloads",
        );
        let selection = Selection {
            settings: true,
            prompts: true,
            personal: true,
            recovery: true,
            downloads: true,
            window: false,
        };
        let prepared = prepare(
            &extracted,
            &temp.0.join("prepared"),
            &manifest,
            &selection,
            &HashSet::new(),
        )
        .unwrap();
        assert_eq!(prepared.recovered_documents, 1);
        assert_eq!(prepared.quarantined_downloads, 1);
        assert!(
            prepared
                .adjustments
                .iter()
                .any(|item| item.contains("On Launch"))
        );
        let roots = Roots {
            config: config.clone(),
            data: config.clone(),
        };
        let mut journal =
            transaction::prepare(&roots, "test-restore", &prepared.replacements).unwrap();
        transaction::apply(&roots, &mut journal, || Ok(())).unwrap();
        let restored: crate::settings::Settings =
            serde_json::from_slice(&fs::read(config.join("settings.json")).unwrap()).unwrap();
        assert_eq!(restored.theme, "dark");
        assert_eq!(restored.on_launch, "new");
        assert_eq!(restored.after_command, "example command");
        assert!(
            !restored.after_run_command && !restored.ai_enabled && !restored.latex_native_enabled
        );
        assert!(restored.latex_native_root.is_none());
        assert_eq!(
            fs::read(config.join("ai-keys.json")).unwrap(),
            b"do not touch"
        );
        assert_eq!(
            fs::read(
                config.join("recovered-backups/test-restore/unverified-downloads/pandoc/tool.exe")
            )
            .unwrap(),
            b"untrusted binary"
        );
        assert!(!config.join("pandoc/tool.exe").exists());
    }

    #[test]
    fn rejects_unknown_nested_settings_without_silently_discarding_them() {
        let temp = Scratch::new();
        let path = temp.0.join("settings.json");
        let mut value = serde_json::to_value(crate::settings::Settings::default()).unwrap();
        value["presetOverrides"] = serde_json::json!({"custom": {"unknownFutureField": true}});
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(read_settings(&path).err().unwrap().contains("unsupported"));
    }

    #[test]
    fn rejects_platform_specific_categories_from_another_platform() {
        let mut manifest = manifest();
        manifest.source_os = "different-os".into();
        let selection = Selection {
            downloads: true,
            ..Default::default()
        };
        assert!(
            require_available(&manifest, &selection)
                .unwrap_err()
                .contains("not compatible")
        );
    }
}
