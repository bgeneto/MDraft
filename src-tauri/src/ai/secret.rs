//! API key storage: the OS credential store with persistent and session-only
//! fallbacks.
//!
//! The key never enters `settings.json`, a recovery entry, a channel event or an
//! error message. The credential name includes the normalized endpoint, so two
//! gateways do not share a key by accident.
//!
//! Linux's Secret Service is the preferred store, but it is not always usable:
//! a fresh session can have no default collection, and `keyring`'s Secret
//! Service store cannot create one without a collection prompt. The second
//! fallback is a `0600` JSON file beside `settings.json`. It is deliberately
//! separate from the settings file so backups and sync do not copy it, and the
//! UI says plainly that it is not encrypted. A key written there is migrated
//! back to the credential store on the first successful keychain write.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Service name in the platform store. It is the application identifier, not a
/// product label, so a rename does not strand existing credentials.
const SERVICE: &str = "io.github.bgeneto.mdraft.ai";

/// The fallback file's name, beside `settings.json`.
pub(crate) const KEYS_FILE: &str = "ai-keys.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeySource {
    Keychain,
    File,
    Session,
    None,
}

impl KeySource {
    pub fn id(self) -> &'static str {
        match self {
            Self::Keychain => "keychain",
            Self::File => "file",
            Self::Session => "session",
            Self::None => "none",
        }
    }
}

/// The username field of the credential entry. The provider is part of it
/// because the same host can serve both protocols with different keys.
pub fn credential_id(provider: &str, base_url: &str) -> String {
    format!("{provider}|{base_url}")
}

/// The fallback file's path, derived from `settings.json`'s path.
pub fn keys_file(config_file: &Path) -> PathBuf {
    config_file.with_file_name(KEYS_FILE)
}

pub fn keychain_available() -> bool {
    keyring::Entry::store_status().is_ok()
}

pub fn keychain_get(provider: &str, base_url: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SERVICE, &credential_id(provider, base_url))
        .map_err(|_| "The system credential store is not available.".to_string())?;
    match entry.get_password() {
        Ok(key) if !key.is_empty() => Ok(Some(key)),
        Ok(_) => Ok(None),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("The system credential store could not be read.".to_string()),
    }
}

pub fn keychain_set(provider: &str, base_url: &str, key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, &credential_id(provider, base_url))
        .map_err(|_| "The system credential store is not available.".to_string())?;
    entry
        .set_password(key)
        .map_err(|_| "The system credential store refused the key.".to_string())
}

pub fn keychain_delete(provider: &str, base_url: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, &credential_id(provider, base_url))
        .map_err(|_| "The system credential store is not available.".to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("The system credential store could not delete the key.".to_string()),
    }
}

/// Read the whole fallback map. A missing or malformed file is an empty map;
/// a corrupt file must not make the assistant unusable.
fn read_keys_file(path: &Path) -> BTreeMap<String, String> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_keys_file(path: &Path, entries: &BTreeMap<String, String>) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The key file has no parent directory.".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "The key file could not be created.".to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // A directory readable by other users would expose the file name and
        // existence even when the file itself is 0600. Never chmod the current
        // directory or the filesystem root: `AppState::load` falls back to `"."`
        // when the platform config directory is unavailable.
        if parent != Path::new(".") && parent != Path::new("/") {
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
    }

    let body = serde_json::to_vec_pretty(entries)
        .map_err(|_| "The key could not be encoded.".to_string())?;
    let temporary = path.with_extension("json.tmp");
    {
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // Mode is applied at creation. An existing temporary file gets the
            // explicit set_permissions below as well.
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| "The key file could not be written.".to_string())?;
        file.write_all(&body)
            .map_err(|_| "The key file could not be written.".to_string())?;
        file.sync_all()
            .map_err(|_| "The key file could not be written.".to_string())?;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|_| "The key file permissions could not be set.".to_string())?;
    }

    fs::rename(&temporary, path).map_err(|_| "The key file could not be replaced.".to_string())
}

pub fn file_get(path: &Path, provider: &str, base_url: &str) -> Option<String> {
    let mut entries = read_keys_file(path);
    entries
        .remove(&credential_id(provider, base_url))
        .filter(|key| !key.is_empty())
}

pub fn file_set(path: &Path, provider: &str, base_url: &str, key: &str) -> Result<(), String> {
    let mut entries = read_keys_file(path);
    entries.insert(credential_id(provider, base_url), key.to_string());
    write_keys_file(path, &entries)
}

pub fn file_delete(path: &Path, provider: &str, base_url: &str) -> Result<(), String> {
    let mut entries = read_keys_file(path);
    if entries.remove(&credential_id(provider, base_url)).is_none() {
        return Ok(());
    }
    if entries.is_empty() {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("The key file could not be deleted.".to_string()),
        }
    } else {
        write_keys_file(path, &entries)
    }
}

pub fn session_get(
    keys: &Mutex<HashMap<String, String>>,
    provider: &str,
    base_url: &str,
) -> Option<String> {
    keys.lock()
        .ok()
        .and_then(|keys| keys.get(&credential_id(provider, base_url)).cloned())
        .filter(|key| !key.is_empty())
}

pub fn session_set(
    keys: &Mutex<HashMap<String, String>>,
    provider: &str,
    base_url: &str,
    key: &str,
) {
    if let Ok(mut keys) = keys.lock() {
        keys.insert(credential_id(provider, base_url), key.to_string());
    }
}

pub fn session_remove(keys: &Mutex<HashMap<String, String>>, provider: &str, base_url: &str) {
    if let Ok(mut keys) = keys.lock() {
        keys.remove(&credential_id(provider, base_url));
    }
}

/// The key to use and where it came from.
///
/// A session key wins over everything: it exists only because both persistent
/// stores failed during this session, so it is the key the reader just typed.
/// The file wins over the keychain when both have an entry. A file entry only
/// exists because a keychain write failed, so it is the newer key; a successful
/// keychain write deletes the file, which is what makes the keychain take over
/// again. Without this order, saving a new key while the keychain was refusing
/// writes would silently keep using the old keychain entry.
pub fn resolve(
    keys: &Mutex<HashMap<String, String>>,
    provider: &str,
    base_url: &str,
    keys_path: &Path,
) -> (Option<String>, KeySource) {
    if let Some(key) = session_get(keys, provider, base_url) {
        return (Some(key), KeySource::Session);
    }
    if let Some(key) = file_get(keys_path, provider, base_url) {
        return (Some(key), KeySource::File);
    }
    if let Ok(Some(key)) = keychain_get(provider, base_url) {
        return (Some(key), KeySource::Keychain);
    }
    (None, KeySource::None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "mdraft-secret-{}-{}-{name}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> PathBuf {
            self.0.join(KEYS_FILE)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn the_credential_name_includes_provider_and_endpoint() {
        assert_eq!(
            credential_id("openai", "http://127.0.0.1:11434/v1"),
            "openai|http://127.0.0.1:11434/v1"
        );
        assert_ne!(
            credential_id("openai", "https://api.openai.com/v1"),
            credential_id("anthropic", "https://api.openai.com/v1")
        );
    }

    #[test]
    fn session_keys_are_per_endpoint() {
        let keys = Mutex::new(HashMap::new());
        session_set(&keys, "openai", "http://a/v1", "key-a");
        session_set(&keys, "openai", "http://b/v1", "key-b");
        assert_eq!(
            session_get(&keys, "openai", "http://a/v1"),
            Some("key-a".into())
        );
        assert_eq!(
            session_get(&keys, "openai", "http://b/v1"),
            Some("key-b".into())
        );
        session_remove(&keys, "openai", "http://a/v1");
        assert_eq!(session_get(&keys, "openai", "http://a/v1"), None);
        assert_eq!(
            session_get(&keys, "openai", "http://b/v1"),
            Some("key-b".into())
        );
    }

    #[test]
    fn the_file_store_is_per_endpoint_and_round_trips() {
        let dir = TempDir::new("roundtrip");
        let path = dir.path();
        assert_eq!(file_get(&path, "openai", "http://a/v1"), None);
        file_set(&path, "openai", "http://a/v1", "key-a").unwrap();
        file_set(&path, "openai", "http://b/v1", "key-b").unwrap();
        assert_eq!(
            file_get(&path, "openai", "http://a/v1"),
            Some("key-a".into())
        );
        assert_eq!(
            file_get(&path, "openai", "http://b/v1"),
            Some("key-b".into())
        );
        file_delete(&path, "openai", "http://a/v1").unwrap();
        assert_eq!(file_get(&path, "openai", "http://a/v1"), None);
        assert_eq!(
            file_get(&path, "openai", "http://b/v1"),
            Some("key-b".into())
        );
        file_delete(&path, "openai", "http://b/v1").unwrap();
        assert!(!path.exists(), "the empty file is removed");
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_private_to_its_user() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new("permissions");
        let path = dir.path();
        file_set(&path, "openai", "http://a/v1", "key-a").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "the key file is readable only by its owner");
        let parent = fs::metadata(dir.0.as_path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(parent, 0o700, "the containing directory is private too");
    }

    #[test]
    fn a_malformed_file_reads_as_empty_and_does_not_block_a_write() {
        let dir = TempDir::new("malformed");
        let path = dir.path();
        fs::write(&path, "{not json").unwrap();
        assert_eq!(file_get(&path, "openai", "http://a/v1"), None);
        file_set(&path, "openai", "http://a/v1", "key-a").unwrap();
        assert_eq!(
            file_get(&path, "openai", "http://a/v1"),
            Some("key-a".into())
        );
    }

    #[test]
    fn an_empty_saved_key_is_not_returned() {
        let dir = TempDir::new("empty");
        let path = dir.path();
        file_set(&path, "openai", "http://a/v1", "").unwrap();
        assert_eq!(file_get(&path, "openai", "http://a/v1"), None);
    }

    #[test]
    fn the_file_fallback_is_used_when_the_keychain_has_no_entry() {
        let dir = TempDir::new("resolve");
        let path = dir.path();
        let keys = Mutex::new(HashMap::new());
        let endpoint = format!("http://mdraft-test-{}/v1", std::process::id());
        file_set(&path, "openai", &endpoint, "file-key").unwrap();
        let (key, source) = resolve(&keys, "openai", &endpoint, &path);
        assert_eq!(source, KeySource::File);
        assert_eq!(key.as_deref(), Some("file-key"));
    }
}
