//! Journaled replacement of selected application-data categories.
//!
//! Targets are fixed by the application. Neither archive paths nor paths stored
//! in a journal can select an arbitrary destination.

use super::format;
use super::snapshot::{self, Roots};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const JOURNAL_VERSION: u32 = 1;
const MAX_JOURNAL_BYTES: u64 = 1024 * 1024;
const MAX_TREE_DEPTH: usize = 64;
const MAX_TREE_ENTRIES: usize = 100_000;
const MAX_TREE_BYTES: u64 = 128 * 1024 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum Target {
    Settings,
    Prompts,
    Personal,
    Window,
    Recovered,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Preparing,
    Prepared,
    Applying,
    Committed,
    RollingBack,
    RolledBack,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Phase {
    Pending,
    OldMoved,
    NewInstalled,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Operation {
    target: Target,
    old_hash: Option<String>,
    new_hash: Option<String>,
    phase: Phase,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Journal {
    version: u32,
    id: String,
    state: State,
    operations: Vec<Operation>,
}

/// A selected category and an optional prepared replacement. None explicitly
/// restores the absence of that category, as for a missing prompts file.
pub struct Replacement {
    pub target: Target,
    pub source: Option<PathBuf>,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

fn target_path(roots: &Roots, id: &str, target: Target) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("The restore transaction has an invalid identifier.".into());
    }
    Ok(match target {
        Target::Settings => roots.config.join("settings.json"),
        Target::Prompts => roots.config.join("ai-prompts.md"),
        Target::Personal => roots.config.join("texmf"),
        Target::Window => roots.config.join(".window-state.json"),
        Target::Recovered => roots.config.join("recovered-backups").join(id),
    })
}

fn journal_directory(roots: &Roots, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("The restore transaction has an invalid identifier.".into());
    }
    Ok(roots.config.join("restore-transactions").join(id))
}

fn staged_path(roots: &Roots, id: &str, target: Target, kind: &str) -> Result<PathBuf, String> {
    if !matches!(kind, "old" | "new") {
        return Err("Invalid restore staging kind.".into());
    }
    let name = match target {
        Target::Settings => "settings",
        Target::Prompts => "prompts",
        Target::Personal => "personal",
        Target::Window => "window",
        Target::Recovered => "recovered",
    };
    Ok(journal_directory(roots, id)?.join(kind).join(name))
}

impl Journal {
    pub fn state(&self) -> State {
        self.state
    }
}

fn safe_metadata(path: &Path) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if snapshot::is_link(&meta) => {
            Err(format!("A restore path is a link: {}", path.display()))
        }
        Ok(meta) if meta.is_file() || meta.is_dir() => Ok(Some(meta)),
        Ok(_) => Err(format!(
            "A restore path is not a regular file or directory: {}",
            path.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not inspect {}: {error}", path.display())),
    }
}

fn validate_parents(root: &Path, path: &Path) -> Result<(), String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Restore target is outside application data.")?;
    if !root.is_absolute() || !safe_metadata(root)?.is_some_and(|meta| meta.is_dir()) {
        return Err("The application settings folder is unavailable or unsafe.".into());
    }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            return Err("The restore target has an unsafe path.".into());
        };
        current.push(name);
        if current == path {
            break;
        }
        if !safe_metadata(&current)?.is_some_and(|meta| meta.is_dir()) {
            return Err(format!(
                "A restore folder is unavailable: {}",
                current.display()
            ));
        }
    }
    Ok(())
}

fn sync_parent(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        let parent = path.parent().ok_or("A restore path has no parent.")?;
        File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn create_private(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|error| format!("Could not create {}: {error}", path.display()))
}

fn sync_json(path: &Path, data: &Journal) -> Result<(), String> {
    let bytes = serde_json::to_vec(data).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_JOURNAL_BYTES {
        return Err("The restore journal is too large.".into());
    }
    let next = path.with_extension("json.next");
    if safe_metadata(&next)?.is_some() {
        fs::remove_file(&next).map_err(|error| error.to_string())?;
    }
    let mut file = create_private(&next)?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| error.to_string())?;
    fs::rename(&next, path)
        .map_err(|error| format!("Could not update the restore journal: {error}"))?;
    sync_parent(path)
}

pub(super) fn tree_digest(path: &Path) -> Result<Option<String>, String> {
    tree_digest_with(path, &mut |_| Ok(()))
}

pub(super) fn tree_digest_with(
    path: &Path,
    progress: &mut impl FnMut(u64) -> Result<(), String>,
) -> Result<Option<String>, String> {
    tree_digest_inner(path, progress, 0, &mut 0, &mut 0)
}

fn tree_digest_inner(
    path: &Path,
    progress: &mut impl FnMut(u64) -> Result<(), String>,
    depth: usize,
    entries: &mut usize,
    bytes: &mut u64,
) -> Result<Option<String>, String> {
    progress(0)?;
    if depth > MAX_TREE_DEPTH {
        return Err("A restore folder is nested too deeply.".into());
    }
    let Some(meta) = safe_metadata(path)? else {
        return Ok(None);
    };
    *entries = entries.checked_add(1).ok_or("Too many restore files.")?;
    if *entries > MAX_TREE_ENTRIES {
        return Err("There are too many restore files and folders.".into());
    }
    let mut digest = Sha256::new();
    if meta.is_file() {
        *bytes = bytes
            .checked_add(meta.len())
            .ok_or("Restore data is too large.")?;
        if *bytes > MAX_TREE_BYTES {
            return Err("Restore data is too large.".into());
        }
        let root = path.parent().ok_or("Invalid file path.")?;
        let name = path.file_name().ok_or("Invalid file name.")?;
        let mut file = snapshot::open_regular(root, Path::new(name))?;
        let (size, hash) =
            format::copy_hashed_with(&mut file, &mut std::io::sink(), u64::MAX, progress)?;
        digest.update(b"file\0");
        digest.update(size.to_le_bytes());
        digest.update(hash.as_bytes());
    } else {
        digest.update(b"directory\0");
        let mut children = fs::read_dir(path)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        children.sort_by_key(|entry| entry.file_name());
        for entry in children {
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or("A restored file has a non-UTF-8 name.")?;
            format::validate_name(name)?;
            let child = tree_digest_inner(&entry.path(), progress, depth + 1, entries, bytes)?
                .ok_or("A restore file disappeared.")?;
            digest.update((name.len() as u64).to_le_bytes());
            digest.update(name.as_bytes());
            digest.update(child.as_bytes());
        }
    }
    let bytes = digest.finalize();
    let mut result = String::with_capacity(64);
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    for byte in bytes {
        result.push(DIGITS[(byte >> 4) as usize] as char);
        result.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    Ok(Some(result))
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    let meta = safe_metadata(source)?.ok_or("A staged restore source is missing.")?;
    if meta.is_dir() {
        fs::create_dir(destination).map_err(|error| error.to_string())?;
        let mut entries = fs::read_dir(source)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name();
            format::validate_name(name.to_str().ok_or("Invalid staged file name.")?)?;
            copy_tree(&entry.path(), &destination.join(name))?;
        }
        sync_parent(destination)?;
    } else {
        let mut input = snapshot::open_regular(
            source.parent().ok_or("Invalid source.")?,
            Path::new(source.file_name().ok_or("Invalid source name.")?),
        )?;
        let mut output = create_private(destination)?;
        format::copy_hashed(&mut input, &mut output, meta.len())?;
        output.sync_all().map_err(|error| error.to_string())?;
        sync_parent(destination)?;
    }
    Ok(())
}

fn remove_matching(path: &Path, expected: &str) -> Result<(), String> {
    let Some(meta) = safe_metadata(path)? else {
        return Ok(());
    };
    if tree_digest(path)?.as_deref() != Some(expected) {
        return Err(format!(
            "A restore file changed and was preserved: {}",
            path.display()
        ));
    }
    if meta.is_dir() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())?;
    } else {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    sync_parent(path)
}

/// Prepare every replacement on the same volume as its final target. All
/// partial copies stay inside the owned journal directory, so interruption
/// before the final checkpoint cannot leave untracked files beside live data.
pub fn prepare(roots: &Roots, id: &str, replacements: &[Replacement]) -> Result<Journal, String> {
    let dir = journal_directory(roots, id)?;
    if replacements.is_empty() || replacements.len() > 5 {
        return Err("Select at least one category to restore.".into());
    }
    let mut selected = HashSet::new();
    if replacements
        .iter()
        .any(|replacement| !selected.insert(replacement.target))
    {
        return Err("A restore category was selected twice.".into());
    }
    if !safe_metadata(&roots.config)?.is_some_and(|meta| meta.is_dir()) {
        return Err("The application settings folder is unavailable or unsafe.".into());
    }
    let base = roots.config.join("restore-transactions");
    let created_base = !base.exists();
    if !base.exists() {
        super::private_fs::create_dir(&base)?;
    }
    validate_parents(&roots.config, &dir)?;
    super::private_fs::create_dir(&dir)?;
    let mut created_inbox = false;
    let result = (|| {
        fs::create_dir(dir.join("new")).map_err(|error| error.to_string())?;
        fs::create_dir(dir.join("old")).map_err(|error| error.to_string())?;
        let mut journal = Journal {
            version: JOURNAL_VERSION,
            id: id.into(),
            state: State::Preparing,
            operations: Vec::new(),
        };
        sync_json(&dir.join("journal.json"), &journal)?;
        for replacement in replacements {
            if replacement.target == Target::Recovered {
                let inbox = roots.config.join("recovered-backups");
                if !inbox.exists() {
                    super::private_fs::create_dir(&inbox)?;
                    created_inbox = true;
                }
            }
            let target = target_path(roots, id, replacement.target)?;
            validate_parents(&roots.config, &target)?;
            let old = staged_path(roots, id, replacement.target, "old")?;
            let new = staged_path(roots, id, replacement.target, "new")?;
            if safe_metadata(&old)?.is_some() || safe_metadata(&new)?.is_some() {
                return Err("A restore staging name is already in use.".into());
            }
            let old_hash = tree_digest(&target)?;
            if replacement.target == Target::Recovered && old_hash.is_some() {
                return Err("Recovered documents with this identity already exist.".into());
            }
            let new_hash = if let Some(source) = &replacement.source {
                let before = tree_digest(source)?.ok_or("A restore category is missing.")?;
                journal.operations.push(Operation {
                    target: replacement.target,
                    old_hash: old_hash.clone(),
                    new_hash: Some(before.clone()),
                    phase: Phase::Pending,
                });
                sync_json(&dir.join("journal.json"), &journal)?;
                copy_tree(source, &new)?;
                if tree_digest(&new)?.as_deref() != Some(&before)
                    || tree_digest(source)?.as_deref() != Some(&before)
                {
                    return Err("A restore category changed during staging.".into());
                }
                Some(before)
            } else {
                None
            };
            if new_hash.is_none() {
                journal.operations.push(Operation {
                    target: replacement.target,
                    old_hash,
                    new_hash,
                    phase: Phase::Pending,
                });
                sync_json(&dir.join("journal.json"), &journal)?;
            }
        }
        journal.state = State::Prepared;
        sync_json(&dir.join("journal.json"), &journal)?;
        Ok(journal)
    })();
    if let Err(error) = result {
        let mut cleanup_errors = Vec::new();
        match tree_digest(&dir) {
            Ok(Some(hash)) => {
                if let Err(cleanup) = remove_matching(&dir, &hash) {
                    cleanup_errors.push(cleanup);
                }
            }
            Ok(None) => {}
            Err(cleanup) => cleanup_errors.push(cleanup),
        }
        if created_inbox {
            let _ = fs::remove_dir(roots.config.join("recovered-backups"));
        }
        if created_base {
            let _ = fs::remove_dir(&base);
        }
        if !cleanup_errors.is_empty() {
            return Err(format!(
                "{error} Temporary restore data was preserved: {}",
                cleanup_errors.join("; ")
            ));
        }
        return Err(error);
    }
    result
}

pub fn load(roots: &Roots, id: &str) -> Result<Journal, String> {
    let path = journal_directory(roots, id)?.join("journal.json");
    validate_parents(&roots.config, &path)?;
    let meta = safe_metadata(&path)?.ok_or("The restore journal is missing.")?;
    if !meta.is_file() || meta.len() > MAX_JOURNAL_BYTES {
        return Err("The restore journal is invalid.".into());
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let journal: Journal = serde_json::from_slice(&bytes)
        .map_err(|error| format!("The restore journal is invalid: {error}"))?;
    let mut targets = HashSet::new();
    if journal.version != JOURNAL_VERSION
        || journal.id != id
        || (journal.operations.is_empty() && journal.state != State::Preparing)
        || journal.operations.len() > 5
        || journal.operations.iter().any(|op| {
            let valid_hash = |hash: &Option<String>| {
                hash.as_ref().is_none_or(|value| {
                    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
            };
            !targets.insert(op.target) || !valid_hash(&op.old_hash) || !valid_hash(&op.new_hash)
        })
    {
        return Err("The restore journal is not supported or has invalid targets.".into());
    }
    Ok(journal)
}

fn checkpoint(roots: &Roots, journal: &Journal) -> Result<(), String> {
    sync_json(
        &journal_directory(roots, &journal.id)?.join("journal.json"),
        journal,
    )
}

/// Failure hook is called after every durable transition for crash-injection tests.
pub fn apply(
    roots: &Roots,
    journal: &mut Journal,
    mut after_step: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    if journal.state != State::Prepared {
        return Err("The restore transaction is not ready to apply.".into());
    }
    journal.state = State::Applying;
    checkpoint(roots, journal)?;
    after_step()?;
    for index in 0..journal.operations.len() {
        let target = target_path(roots, &journal.id, journal.operations[index].target)?;
        validate_parents(&roots.config, &target)?;
        let old = staged_path(roots, &journal.id, journal.operations[index].target, "old")?;
        let new = staged_path(roots, &journal.id, journal.operations[index].target, "new")?;
        validate_parents(&roots.config, &old)?;
        validate_parents(&roots.config, &new)?;
        if tree_digest(&target)? != journal.operations[index].old_hash {
            return Err(format!(
                "Application data changed before restore: {}",
                target.display()
            ));
        }
        if safe_metadata(&old)?.is_some() {
            return Err("A previous-data staging path is already occupied.".into());
        }
        if journal.operations[index].old_hash.is_some() {
            fs::rename(&target, &old).map_err(|error| error.to_string())?;
            sync_parent(&target)?;
            after_step()?;
        }
        journal.operations[index].phase = Phase::OldMoved;
        checkpoint(roots, journal)?;
        after_step()?;
        if let Some(expected) = &journal.operations[index].new_hash {
            if tree_digest(&new)?.as_ref() != Some(expected) {
                return Err("A staged restore category changed.".into());
            }
            fs::rename(&new, &target).map_err(|error| error.to_string())?;
            sync_parent(&target)?;
            after_step()?;
        }
        journal.operations[index].phase = Phase::NewInstalled;
        checkpoint(roots, journal)?;
        after_step()?;
    }
    journal.state = State::Committed;
    checkpoint(roots, journal)?;
    after_step()
}

/// Roll back an interrupted restore, refusing to delete unrecognized changes.
pub fn rollback(roots: &Roots, journal: &mut Journal) -> Result<(), String> {
    if matches!(journal.state, State::Committed | State::RolledBack) {
        return Err("This restore transaction cannot be rolled back automatically.".into());
    }
    if journal.state == State::Preparing {
        return Err(
            "The restore was interrupted during preparation; its temporary data was preserved."
                .into(),
        );
    }
    journal.state = State::RollingBack;
    checkpoint(roots, journal)?;
    for operation in journal.operations.iter().rev() {
        let target = target_path(roots, &journal.id, operation.target)?;
        validate_parents(&roots.config, &target)?;
        let old = staged_path(roots, &journal.id, operation.target, "old")?;
        let new = staged_path(roots, &journal.id, operation.target, "new")?;
        validate_parents(&roots.config, &old)?;
        validate_parents(&roots.config, &new)?;
        let old_actual = tree_digest(&old)?;
        let target_actual = tree_digest(&target)?;
        if old_actual.is_some() {
            if old_actual != operation.old_hash {
                return Err("The previous application data changed during rollback.".into());
            }
            if let Some(actual) = target_actual {
                if operation.new_hash.as_deref() != Some(&actual) {
                    return Err("A restore target changed; it was preserved for recovery.".into());
                }
                remove_matching(&target, &actual)?;
            }
            fs::rename(&old, &target).map_err(|error| error.to_string())?;
            sync_parent(&target)?;
        } else if operation.old_hash.is_some() {
            if target_actual != operation.old_hash {
                return Err(
                    "The previous application data is unavailable; automatic rollback stopped."
                        .into(),
                );
            }
        } else if let Some(actual) = target_actual {
            if operation.new_hash.as_deref() != Some(&actual) {
                return Err("An unexpected restore target was preserved for recovery.".into());
            }
            remove_matching(&target, &actual)?;
        }
        if let Some(expected) = &operation.new_hash {
            remove_matching(&new, expected)?;
        }
    }
    journal.state = State::RolledBack;
    checkpoint(roots, journal)
}

/// A preparing journal never renames a live target. Its unique directory can
/// contain incomplete copies, so verify the entire owned tree before removal.
pub fn abandon_preparing(roots: &Roots, journal: &Journal) -> Result<(), String> {
    if journal.state != State::Preparing
        || journal
            .operations
            .iter()
            .any(|op| op.phase != Phase::Pending)
    {
        return Err("The restore preparation cannot be abandoned safely.".into());
    }
    let dir = journal_directory(roots, &journal.id)?;
    validate_parents(&roots.config, &dir.join("journal.json"))?;
    let old = dir.join("old");
    if fs::read_dir(&old)
        .map_err(|error| error.to_string())?
        .next()
        .is_some()
    {
        return Err("Unexpected previous data was preserved for recovery.".into());
    }
    let hash = tree_digest(&dir)?.ok_or("The restore preparation disappeared.")?;
    remove_matching(&dir, &hash)?;
    let _ = fs::remove_dir(roots.config.join("restore-transactions"));
    Ok(())
}

/// Before the first journal checkpoint only empty staging directories and an
/// incomplete journal file can exist; no live target has been touched.
pub fn abandon_unjournaled(roots: &Roots, id: &str) -> Result<bool, String> {
    let dir = journal_directory(roots, id)?;
    validate_parents(&roots.config, &dir.join("journal.json"))?;
    if safe_metadata(&dir.join("journal.json"))?.is_some() {
        return Ok(false);
    }
    for entry in fs::read_dir(&dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let name = name
            .to_str()
            .ok_or("Unexpected restore preparation data was preserved.")?;
        let path = entry.path();
        let meta = safe_metadata(&path)?.ok_or("Restore preparation data disappeared.")?;
        match name {
            "new" | "old" if meta.is_dir() => {
                if fs::read_dir(&path)
                    .map_err(|error| error.to_string())?
                    .next()
                    .is_some()
                {
                    return Err("Unjournaled restore staging was preserved for inspection.".into());
                }
            }
            "journal.json.next" if meta.is_file() && meta.len() <= MAX_JOURNAL_BYTES => {}
            _ => return Err("Unexpected restore preparation data was preserved.".into()),
        }
    }
    let hash = tree_digest(&dir)?.ok_or("Restore preparation data disappeared.")?;
    remove_matching(&dir, &hash)?;
    let _ = fs::remove_dir(roots.config.join("restore-transactions"));
    Ok(true)
}

/// Enumerate only application-owned transaction directories. An unknown item
/// is an error rather than permission to skip possible recovery state.
pub fn list(roots: &Roots) -> Result<Vec<String>, String> {
    let base = roots.config.join("restore-transactions");
    let Some(meta) = safe_metadata(&base)? else {
        return Ok(Vec::new());
    };
    if !meta.is_dir() {
        return Err("The restore transaction folder is unsafe.".into());
    }
    validate_parents(&roots.config, &base.join("placeholder"))?;
    let mut ids = Vec::new();
    for entry in fs::read_dir(&base).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let name = name
            .to_str()
            .ok_or("An invalid restore transaction was preserved.")?;
        if matches!(
            name,
            "pending.json" | "report.json" | "pending.json.next" | "report.json.next"
        ) {
            continue;
        }
        if !valid_id(name) || !safe_metadata(&entry.path())?.is_some_and(|value| value.is_dir()) {
            return Err("An unrecognized restore transaction was preserved.".into());
        }
        ids.push(name.to_string());
    }
    ids.sort();
    Ok(ids)
}

/// Remove only the recognized, hash-checked remnants of a terminal transaction.
pub fn cleanup(roots: &Roots, journal: &Journal) -> Result<(), String> {
    if !matches!(journal.state, State::Committed | State::RolledBack) {
        return Err("The restore transaction has not finished.".into());
    }
    let dir = journal_directory(roots, &journal.id)?;
    validate_parents(&roots.config, &dir.join("journal.json"))?;
    for op in &journal.operations {
        for (kind, expected) in [("old", &op.old_hash), ("new", &op.new_hash)] {
            let path = staged_path(roots, &journal.id, op.target, kind)?;
            if safe_metadata(&dir.join(kind))?.is_none() {
                continue;
            }
            validate_parents(&roots.config, &path)?;
            match (safe_metadata(&path)?, expected) {
                (Some(_), Some(hash)) => remove_matching(&path, hash)?,
                (Some(_), None) => return Err("Unexpected restore staging was preserved.".into()),
                (None, _) => {}
            }
        }
    }
    for kind in ["new", "old"] {
        let path = dir.join(kind);
        if safe_metadata(&path)?.is_some() {
            fs::remove_dir(path).map_err(|error| {
                format!("Restore staging could not be removed and was preserved: {error}")
            })?;
        }
    }
    for name in [
        "request.json.next",
        "request.json",
        "journal.json.next",
        "journal.json",
    ] {
        let path = dir.join(name);
        if let Some(meta) = safe_metadata(&path)? {
            if !meta.is_file() {
                return Err("Unexpected restore journal data was preserved.".into());
            }
            fs::remove_file(&path).map_err(|error| error.to_string())?;
        }
    }
    fs::remove_dir(&dir).map_err(|error| error.to_string())?;
    let _ = fs::remove_dir(roots.config.join("restore-transactions"));
    sync_parent(&dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "mdraft-backup-transaction-{}-{}",
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
                    name.to_string_lossy()
                        .starts_with("mdraft-backup-transaction-")
                })
            {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }

    fn fixture(temp: &Scratch) -> (Roots, Vec<Replacement>) {
        let config = temp.0.join("config");
        let source = temp.0.join("source");
        fs::create_dir(&config).unwrap();
        fs::create_dir(&source).unwrap();
        fs::write(config.join("settings.json"), "old settings").unwrap();
        fs::write(config.join("ai-prompts.md"), "old prompts").unwrap();
        fs::write(config.join("ai-keys.json"), "secret stays").unwrap();
        fs::create_dir(config.join("texmf")).unwrap();
        fs::write(config.join("texmf/old.sty"), "old package").unwrap();
        fs::write(source.join("settings.json"), "new settings").unwrap();
        fs::write(source.join("window.json"), "new window").unwrap();
        fs::create_dir(source.join("texmf")).unwrap();
        fs::write(source.join("texmf/new.sty"), "new package").unwrap();
        (
            Roots {
                config: config.clone(),
                data: config,
            },
            vec![
                Replacement {
                    target: Target::Settings,
                    source: Some(source.join("settings.json")),
                },
                Replacement {
                    target: Target::Prompts,
                    source: None,
                },
                Replacement {
                    target: Target::Personal,
                    source: Some(source.join("texmf")),
                },
                Replacement {
                    target: Target::Window,
                    source: Some(source.join("window.json")),
                },
            ],
        )
    }

    fn assert_old(roots: &Roots) {
        assert_eq!(
            fs::read_to_string(roots.config.join("settings.json")).unwrap(),
            "old settings"
        );
        assert_eq!(
            fs::read_to_string(roots.config.join("ai-prompts.md")).unwrap(),
            "old prompts"
        );
        assert_eq!(
            fs::read_to_string(roots.config.join("texmf/old.sty")).unwrap(),
            "old package"
        );
        assert!(!roots.config.join(".window-state.json").exists());
        assert_eq!(
            fs::read_to_string(roots.config.join("ai-keys.json")).unwrap(),
            "secret stays"
        );
    }

    fn assert_new(roots: &Roots) {
        assert_eq!(
            fs::read_to_string(roots.config.join("settings.json")).unwrap(),
            "new settings"
        );
        assert!(!roots.config.join("ai-prompts.md").exists());
        assert_eq!(
            fs::read_to_string(roots.config.join("texmf/new.sty")).unwrap(),
            "new package"
        );
        assert_eq!(
            fs::read_to_string(roots.config.join(".window-state.json")).unwrap(),
            "new window"
        );
        assert_eq!(
            fs::read_to_string(roots.config.join("ai-keys.json")).unwrap(),
            "secret stays"
        );
    }

    #[test]
    fn applies_selected_categories_and_preserves_excluded_data() {
        let temp = Scratch::new();
        let (roots, replacements) = fixture(&temp);
        let mut journal = prepare(&roots, "restore-one", &replacements).unwrap();
        assert_old(&roots);
        apply(&roots, &mut journal, || Ok(())).unwrap();
        assert_eq!(load(&roots, "restore-one").unwrap().state, State::Committed);
        assert_new(&roots);
        cleanup(&roots, &journal).unwrap();
        assert!(!roots.config.join("restore-transactions").exists());
        assert_new(&roots);
    }

    #[test]
    fn interruption_at_each_transition_restores_the_old_profile() {
        for stop in 1..=20 {
            let temp = Scratch::new();
            let (roots, replacements) = fixture(&temp);
            let mut journal = prepare(&roots, "restore-one", &replacements).unwrap();
            let mut step = 0;
            let result = apply(&roots, &mut journal, || {
                step += 1;
                if step == stop {
                    Err("simulated interruption".into())
                } else {
                    Ok(())
                }
            });
            let mut loaded = load(&roots, "restore-one").unwrap();
            if loaded.state == State::Committed {
                assert_new(&roots);
            } else {
                assert!(result.is_err());
                rollback(&roots, &mut loaded).unwrap();
                assert_old(&roots);
                assert_eq!(
                    load(&roots, "restore-one").unwrap().state,
                    State::RolledBack
                );
            }
        }
    }

    #[test]
    fn rollback_preserves_an_unrecognized_external_change() {
        let temp = Scratch::new();
        let (roots, replacements) = fixture(&temp);
        let mut journal = prepare(&roots, "restore-one", &replacements).unwrap();
        let mut step = 0;
        let result = apply(&roots, &mut journal, || {
            step += 1;
            if step == 4 {
                fs::write(roots.config.join("settings.json"), "external change").unwrap();
                Err("simulated interruption".into())
            } else {
                Ok(())
            }
        });
        assert!(result.is_err());
        let mut loaded = load(&roots, "restore-one").unwrap();
        assert!(
            rollback(&roots, &mut loaded)
                .unwrap_err()
                .contains("preserved")
        );
        assert_eq!(
            fs::read_to_string(roots.config.join("settings.json")).unwrap(),
            "external change"
        );
        assert_eq!(
            fs::read_to_string(
                roots
                    .config
                    .join("restore-transactions/restore-one/old/settings")
            )
            .unwrap(),
            "old settings"
        );
    }

    #[test]
    fn refuses_duplicate_targets_and_untrusted_transaction_ids() {
        let temp = Scratch::new();
        let (roots, _) = fixture(&temp);
        assert!(
            prepare(
                &roots,
                "../outside",
                &[Replacement {
                    target: Target::Settings,
                    source: None
                }]
            )
            .is_err()
        );
        let duplicated = [
            Replacement {
                target: Target::Settings,
                source: None,
            },
            Replacement {
                target: Target::Settings,
                source: None,
            },
        ];
        assert!(
            prepare(&roots, "duplicate", &duplicated)
                .unwrap_err()
                .contains("twice")
        );
        assert!(!roots.config.join("restore-transactions").exists());
    }

    #[test]
    fn failed_preparation_cleans_its_staging_and_preserves_existing_data() {
        let temp = Scratch::new();
        let (roots, mut replacements) = fixture(&temp);
        replacements[1].source = Some(temp.0.join("missing"));
        assert!(prepare(&roots, "incomplete", &replacements).is_err());
        assert_old(&roots);
        assert!(
            !roots
                .config
                .join(".settings.json.mdraft-new-incomplete")
                .exists()
        );
        assert!(
            !roots
                .config
                .join("restore-transactions/incomplete")
                .exists()
        );
    }

    #[test]
    fn refuses_to_replace_an_existing_recovery_inbox() {
        let temp = Scratch::new();
        let (roots, _) = fixture(&temp);
        let existing = roots.config.join("recovered-backups/already");
        fs::create_dir_all(&existing).unwrap();
        fs::write(existing.join("draft.txt"), "keep").unwrap();
        let replacement = Replacement {
            target: Target::Recovered,
            source: None,
        };
        assert!(
            prepare(&roots, "already", &[replacement])
                .unwrap_err()
                .contains("already exist")
        );
        assert_eq!(
            fs::read_to_string(existing.join("draft.txt")).unwrap(),
            "keep"
        );
    }
}
