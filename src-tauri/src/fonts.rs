//! Installed font families for the Typography picker.
//!
//! The webview already renders an installed family when a CSS stack names it:
//! `font-family: "Segoe UI"` reaches DirectWrite on Windows, CoreText on macOS
//! and fontconfig on Linux. What the web platform does not expose is the list of
//! names. This module asks the same native text stack for that list and returns
//! names only. No font file is read, copied, served or embedded, so there is no
//! TTC face-index problem, no new URL scheme, no extra CSP entry and no
//! font-licensing question.
//!
//! `fontique` is used rather than a directory scan because a font can be
//! installed outside the standard folders and still be registered with the OS.
//! One canonical name is taken per family id; `family_names()` also yields
//! localized aliases and RBIZ names, which would fill the picker with
//! near-duplicates.

use std::sync::{Arc, Mutex};

/// A real family name is short. A malformed font must not be able to send an
/// unbounded string over IPC or into the search field.
const MAX_FAMILY_NAME: usize = 256;

/// CSS generic families are keywords, not installed fonts. Listing one as a
/// selectable family would look like a font choice while the cascade actually
/// resolves the keyword.
const GENERIC_FAMILIES: &[&str] = &[
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-serif",
    "ui-sans-serif",
    "ui-monospace",
    "ui-rounded",
    "emoji",
    "math",
    "fangsong",
];

/// Session cache for the installed family list.
///
/// A successful scan is reused: opening and closing Preferences should not walk
/// the OS font collection again. A failed or empty scan is not cached, so the
/// next visit retries rather than hiding a transient problem.
#[derive(Clone, Default)]
pub struct FontCatalog {
    cache: Arc<Mutex<Option<Vec<String>>>>,
}

impl FontCatalog {
    fn cached(&self) -> Option<Vec<String>> {
        self.cache.lock().ok().and_then(|cache| cache.clone())
    }

    fn store(&self, families: Vec<String>) {
        if let Ok(mut cache) = self.cache.lock() {
            *cache = Some(families);
        }
    }
}

/// Return the installed font families, in a stable alphabetical order.
///
/// The scan runs on a blocking worker: on a large Linux font set the first
/// call can take most of a second cold, and it must never hold up the editor.
/// The frontend calls this only when the Typography section is first shown.
#[tauri::command]
pub async fn system_fonts(
    state: tauri::State<'_, FontCatalog>,
) -> Result<Vec<String>, String> {
    if let Some(families) = state.cached() {
        return Ok(families);
    }

    let scanned = tauri::async_runtime::spawn_blocking(scan_system_families)
        .await
        .map_err(|error| format!("could not read the installed fonts: {error}"))?;
    let families = normalize_families(scanned);
    if families.is_empty() {
        return Err("the operating system reported no installed font families".into());
    }

    state.store(families.clone());
    Ok(families)
}

/// Ask the platform text stack for its families.
///
/// `Collection::new` registers the system fonts lazily; `family_ids()` plus
/// `family_name()` reads only the name map, not font files. If the platform
/// library is missing (fontique's fontconfig `dlopen` path), the collection is
/// empty and the caller returns a readable error instead of failing the app.
fn scan_system_families() -> Vec<String> {
    let mut collection = fontique::Collection::new(fontique::CollectionOptions::default());
    let ids: Vec<fontique::FamilyId> = collection.family_ids().collect();
    ids.into_iter()
        .filter_map(|id| collection.family_name(id).map(str::to_owned))
        .collect()
}

/// Clean, deduplicate and sort the names before they cross the IPC boundary.
///
/// Exposed to tests because the native scan is host-dependent but these rules
/// are not: hidden macOS/CJK names start with `.` or `@`, CSS keywords are not
/// families, and Windows matches family names case-insensitively.
pub(crate) fn normalize_families(raw: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::BTreeMap::<String, String>::new();
    for name in raw {
        let name = name.trim();
        if name.is_empty()
            || name.starts_with('.')
            || name.starts_with('@')
            || name.chars().count() > MAX_FAMILY_NAME
            || name.chars().any(|character| character.is_control())
            || GENERIC_FAMILIES
                .iter()
                .any(|generic| name.eq_ignore_ascii_case(generic))
        {
            continue;
        }

        // The first spelling wins; the key is what makes `Georgia` and
        // `georgia` one entry.
        seen.entry(name.to_lowercase())
            .or_insert_with(|| name.to_string());
    }

    let mut families: Vec<String> = seen.into_values().collect();
    families.sort_by_cached_key(|name| name.to_lowercase());
    families
}

#[cfg(test)]
mod tests {
    use super::{MAX_FAMILY_NAME, normalize_families};

    #[test]
    fn normalize_drops_hidden_generic_control_and_oversized_names() {
        let raw = vec![
            "Georgia".into(),
            "georgia".into(),
            ".Hidden System Face".into(),
            "@Vertical CJK".into(),
            "monospace".into(),
            "Sans-Serif".into(),
            "Arial\u{7}".into(),
            format!("A{}", "b".repeat(MAX_FAMILY_NAME)),
            "  Charter  ".into(),
            "Segoe UI".into(),
        ];

        assert_eq!(
            normalize_families(raw),
            vec!["Charter", "Georgia", "Segoe UI"]
        );
    }

    #[test]
    fn normalize_is_case_insensitive_in_its_sort() {
        let raw = vec!["zeta".into(), "Alpha".into(), "beta".into()];
        assert_eq!(normalize_families(raw), vec!["Alpha", "beta", "zeta"]);
    }

    #[test]
    fn normalize_keeps_the_first_spelling_of_a_duplicate() {
        let raw = vec!["SEGOE UI".into(), "Segoe UI".into()];
        assert_eq!(normalize_families(raw), vec!["SEGOE UI"]);
    }

    #[test]
    fn an_empty_or_fully_filtered_list_stays_empty() {
        assert!(normalize_families(Vec::new()).is_empty());
        assert!(normalize_families(vec!["  ".into(), "serif".into()]).is_empty());
    }
}
