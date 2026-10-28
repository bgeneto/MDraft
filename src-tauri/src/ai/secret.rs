//! API key storage: the OS credential store with a session-only fallback.
//!
//! The key never enters `settings.json`, a recovery entry, a channel event or an
//! error message. The credential name includes the normalized endpoint, so two
//! gateways do not share a key by accident.

use std::collections::HashMap;
use std::sync::Mutex;

/// Service name in the platform store. It is the application identifier, not a
/// product label, so a rename does not strand existing credentials.
const SERVICE: &str = "io.github.bernh.mdraft.ai";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeySource {
    Keychain,
    Session,
    None,
}

impl KeySource {
    pub fn id(self) -> &'static str {
        match self {
            Self::Keychain => "keychain",
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

pub fn session_remove(
    keys: &Mutex<HashMap<String, String>>,
    provider: &str,
    base_url: &str,
) {
    if let Ok(mut keys) = keys.lock() {
        keys.remove(&credential_id(provider, base_url));
    }
}

/// The key to use and where it came from.
///
/// A session key wins over the keychain: it exists only because the keychain
/// write failed during this session, so it is the key the reader just typed.
pub fn resolve(
    keys: &Mutex<HashMap<String, String>>,
    provider: &str,
    base_url: &str,
) -> (Option<String>, KeySource) {
    if let Some(key) = session_get(keys, provider, base_url) {
        return (Some(key), KeySource::Session);
    }
    match keychain_get(provider, base_url) {
        Ok(Some(key)) => (Some(key), KeySource::Keychain),
        _ => (None, KeySource::None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
