//! Image import: clipboard pastes, local files and web downloads.
//!
//! Every path that reaches the filesystem goes through [`sanitize_stem`] and
//! [`unique_path`], so a hostile clipboard name cannot escape the target folder
//! and an existing file is never overwritten. Downloads are content-sniffed:
//! a URL that returns HTML is rejected rather than saved with a `.png` name.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::documents;

/// Refuse anything larger than this instead of filling the disk.
const MAX_DOWNLOAD_BYTES: u64 = 32 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(25);
const MAX_STEM_LEN: usize = 60;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageOptions {
    /// "assetsFolder" | "assetsDir" | "custom" | "keepOriginal"
    pub rule: String,
    pub custom_dir: Option<String>,
    pub relative: bool,
    pub dot_slash: bool,
    pub escape: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedImage {
    /// Where the bytes now live; empty when the original location was kept.
    pub absolute_path: String,
    /// The text to insert into the markdown.
    pub markdown_path: String,
    pub bytes: usize,
    /// "clipboard" | "local" | "remote"
    pub source: String,
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// Normalise separators so paths can be compared.
///
/// Windows accepts both separators, so backslashes become forward slashes. On
/// Unix a backslash is an ordinary character inside a filename and rewriting it
/// would corrupt the path.
fn normalize(path: &Path) -> String {
    let text = path.to_string_lossy();
    if cfg!(windows) {
        text.replace('\\', "/")
    } else {
        text.to_string()
    }
}

/// The rooted prefix of a normalised absolute path: `C:`, `//server/share`, `/`.
fn root_of(normalized: &str) -> Option<String> {
    if normalized.starts_with("//") {
        let mut parts = normalized.trim_start_matches('/').split('/');
        let server = parts.next()?;
        let share = parts.next()?;
        Some(format!("//{server}/{share}"))
    } else if normalized.len() >= 2 && normalized.as_bytes()[1] == b':' {
        Some(normalized[..2].to_uppercase())
    } else if normalized.starts_with('/') {
        Some("/".to_string())
    } else {
        None
    }
}

/// Components after the root.
fn tail_of(normalized: &str) -> Vec<String> {
    let rest = if normalized.starts_with("//") {
        let mut parts = normalized.trim_start_matches('/').splitn(3, '/');
        parts.next();
        parts.next();
        parts.next().unwrap_or("").to_string()
    } else if normalized.len() >= 2 && normalized.as_bytes()[1] == b':' {
        normalized[2..].to_string()
    } else {
        normalized[1..].to_string()
    };
    rest.split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect()
}

/// Relative path from `base_dir` to `target`, or `None` when they do not share
/// a root (different Windows drives, or a UNC path versus a local one).
fn relative_path(base_dir: &str, target: &str) -> Option<String> {
    let base = normalize(Path::new(base_dir));
    let targ = normalize(Path::new(target));
    if root_of(&base)? != root_of(&targ)? {
        return None;
    }

    let base_parts = tail_of(&base);
    let target_parts = tail_of(&targ);
    let mut common = 0;
    while common < base_parts.len()
        && common < target_parts.len()
        && base_parts[common].eq_ignore_ascii_case(&target_parts[common])
    {
        common += 1;
    }
    if common == 0 && base_parts.is_empty() && target_parts.is_empty() {
        return None;
    }

    let mut parts: Vec<String> = Vec::new();
    for _ in common..base_parts.len() {
        parts.push("..".to_string());
    }
    parts.extend(target_parts[common..].iter().cloned());
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

/// Percent-escape the characters that would break `![alt](path)` parsing.
fn escape_url(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for ch in path.chars() {
        match ch {
            ' ' => out.push_str("%20"),
            '(' => out.push_str("%28"),
            ')' => out.push_str("%29"),
            '<' => out.push_str("%3C"),
            '>' => out.push_str("%3E"),
            '"' => out.push_str("%22"),
            '\'' => out.push_str("%27"),
            '#' => out.push_str("%23"),
            '?' => out.push_str("%3F"),
            '[' => out.push_str("%5B"),
            ']' => out.push_str("%5D"),
            _ => out.push(ch),
        }
    }
    out
}

/// The text to put in the markdown for a saved file.
fn markdown_path(target: &Path, document_path: Option<&str>, options: &ImageOptions) -> String {
    let target_str = target.to_string_lossy().to_string();
    let doc_dir = document_path
        .map(PathBuf::from)
        .and_then(|p| p.parent().map(|d| d.to_string_lossy().to_string()));

    let mut value = if options.relative {
        doc_dir
            .as_deref()
            .and_then(|dir| relative_path(dir, &target_str))
            .unwrap_or(target_str)
    } else {
        target_str
    };

    if options.dot_slash && !value.starts_with("./") && !value.starts_with("../") && !Path::new(&value).is_absolute() {
        value = format!("./{value}");
    }
    if options.escape {
        value = escape_url(&value);
    }
    value
}

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

const RESERVED_STEMS: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Reduce any incoming name to something safe to join onto a directory.
///
/// Rules, in order: the directory part is discarded (so a hostile name such as
/// `../../etc/passwd` can only contribute its last segment); leading dots are
/// dropped (a dotfile contributes its name, never a bare `.`); the final
/// extension is removed because the real one is sniffed from the bytes; runs of
/// dots collapse so no `..` component can survive.
fn sanitize_stem(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let name = base.trim_start_matches(['.', '_', '-']);
    let without_ext = match name.rfind('.') {
        Some(at) if at > 0 => &name[..at],
        _ => name,
    };

    let mut out = String::with_capacity(without_ext.len());
    let mut last_dash = false;
    let mut last_dot = false;
    for ch in without_ext.chars() {
        if ch.is_alphanumeric() || ch == '_' || ch == '-' {
            out.push(ch);
            last_dash = false;
            last_dot = false;
        } else if ch == '.' {
            if !last_dot {
                out.push('.');
            }
            last_dot = true;
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
            last_dot = false;
        }
    }

    let trimmed = out.trim_matches(['.', '-', '_']).to_string();
    let capped: String = trimmed.chars().take(MAX_STEM_LEN).collect();
    let candidate = if capped.is_empty() {
        "image".to_string()
    } else {
        capped
    };

    if RESERVED_STEMS.contains(&candidate.to_ascii_lowercase().as_str()) {
        format!("{candidate}-image")
    } else {
        candidate
    }
}

/// First free `stem.ext`, `stem-1.ext`, … in `dir`.
fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    for n in 1..1000 {
        let candidate = dir.join(format!("{stem}-{n}.{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem}-{}.{ext}", std::process::id()))
}

// ---------------------------------------------------------------------------
// Content sniffing
// ---------------------------------------------------------------------------

/// Identify an image by its bytes, never by the URL or the clipboard's claim.
fn sniff_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 8 && bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("png");
    }
    if bytes.len() >= 3 && bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    if bytes.len() >= 6 && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        return Some("gif");
    }
    if bytes.len() >= 16 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        // The first chunk names the WebP variant. A RIFF file that merely
        // carries the `WEBP` fourcc is not an image the webview can draw.
        if matches!(&bytes[12..16], b"VP8 " | b"VP8L" | b"VP8X") {
            return Some("webp");
        }
    }
    if bytes.len() >= 2 && bytes.starts_with(b"BM") {
        return Some("bmp");
    }
    if bytes.len() >= 4 && bytes.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return Some("ico");
    }
    if let Some(ext) = isobmff_ext(bytes) {
        return Some(ext);
    }

    // SVG is text; only the first kilobyte can hold the opening tag.
    let head = &bytes[..bytes.len().min(1024)];
    if let Ok(text) = std::str::from_utf8(head) {
        let trimmed = text.trim_start_matches('\u{feff}').trim_start();
        if trimmed.starts_with("<svg") {
            return Some("svg");
        }
        if trimmed.starts_with("<?xml") && text.contains("<svg") {
            return Some("svg");
        }
    }
    None
}

/// The brand of an ISO base media file (AVIF, HEIC).
///
/// AVIF files commonly declare `mif1` as the major brand and only list `avif`
/// among the compatible brands, so the whole `ftyp` box has to be read. Reading
/// just the major brand labelled those files as HEIC and saved them with the
/// wrong extension.
fn isobmff_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 16 || &bytes[4..8] != b"ftyp" {
        return None;
    }
    let declared = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let end = declared.clamp(16, bytes.len());
    // The box is: major brand, minor version, then compatible brands.
    let mut heic = false;
    for (index, brand) in bytes[8..end].chunks_exact(4).enumerate() {
        if index == 1 {
            continue; // minor version, not a brand
        }
        match brand {
            b"avif" | b"avis" => return Some("avif"),
            b"heic" | b"heix" | b"heim" | b"heis" | b"mif1" => heic = true,
            _ => {}
        }
    }
    if heic {
        Some("heic")
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Destination
// ---------------------------------------------------------------------------

/// The sentence every rule that needs a document folder shows when there is
/// none. The process working directory is never a substitute: in an installed
/// build it is the application folder, which the user did not choose and
/// cannot necessarily write.
const NO_DOCUMENT_FOLDER: &str =
    "This document has no file yet. Save it first, or choose an absolute folder in Preferences › Image.";

fn document_dir(document_path: Option<&str>) -> Result<PathBuf, String> {
    let path = document_path.ok_or_else(|| NO_DOCUMENT_FOLDER.to_string())?;
    Ok(PathBuf::from(path)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default())
}

fn document_stem(document_path: &str) -> String {
    PathBuf::from(document_path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "document".to_string())
}

/// Expand the `${filename}` token promised by the Custom Folder preference.
///
/// A relative custom folder already needs the document's folder; a token in an
/// *absolute* path needs the document's name, which an untitled buffer does not
/// have. Both cases fail with the save-first sentence instead of creating a
/// literal `${filename}` directory.
fn expand_filename(value: &str, document_path: Option<&str>) -> Result<String, String> {
    if !value.contains("${filename}") {
        return Ok(value.to_string());
    }
    let path = document_path.ok_or_else(|| NO_DOCUMENT_FOLDER.to_string())?;
    Ok(value.replace("${filename}", &sanitize_stem(&document_stem(path))))
}

fn target_dir(options: &ImageOptions, document_path: Option<&str>) -> Result<PathBuf, String> {
    match options.rule.as_str() {
        "assetsDir" => Ok(document_dir(document_path)?.join("assets")),
        "custom" => {
            let raw = options
                .custom_dir
                .as_deref()
                .filter(|d| !d.trim().is_empty())
                .ok_or("No custom image folder is configured in Preferences.")?;
            let candidate = PathBuf::from(expand_filename(raw, document_path)?);
            Ok(if candidate.is_absolute() {
                candidate
            } else {
                document_dir(document_path)?.join(candidate)
            })
        }
        // "assetsFolder" is the default and the fallback for anything unknown.
        _ => {
            let base = document_dir(document_path)?;
            let stem = sanitize_stem(&document_stem(document_path.unwrap_or_default()));
            Ok(base.join(format!("{stem}.assets")))
        }
    }
}

fn write_unique(dir: &Path, stem: &str, ext: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let path = unique_path(dir, stem, ext);
    fs::write(&path, bytes).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    Ok(path)
}

fn build_result(
    source: &str,
    absolute: PathBuf,
    bytes: usize,
    document_path: Option<&str>,
    options: &ImageOptions,
) -> SavedImage {
    SavedImage {
        markdown_path: markdown_path(&absolute, document_path, options),
        absolute_path: absolute.to_string_lossy().to_string(),
        bytes,
        source: source.to_string(),
    }
}

/// Keep the original location: reference it as-is, never copy or download.
fn keep_original(reference: String, source: &str, options: &ImageOptions) -> SavedImage {
    let mut value = reference;
    if options.escape {
        value = escape_url(&value);
    }
    SavedImage {
        absolute_path: String::new(),
        markdown_path: value,
        bytes: 0,
        source: source.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Save image bytes that came from the clipboard.
#[tauri::command]
pub fn save_clipboard_image(
    data: String,
    name_hint: Option<String>,
    document_path: Option<String>,
    options: ImageOptions,
) -> Result<SavedImage, String> {
    let payload = data
        .split_once("base64,")
        .map(|(_, rest)| rest)
        .unwrap_or(&data);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| format!("The clipboard image could not be decoded: {e}"))?;

    if bytes.is_empty() {
        return Err("The clipboard image was empty.".to_string());
    }
    let ext = sniff_ext(&bytes)
        .ok_or("The clipboard contents are not a recognised image format.")?;
    if options.rule == "keepOriginal" {
        return Err(
            "Preferences ask images to keep their original location, but a clipboard image has none. Choose a folder rule in Preferences › Image."
                .to_string(),
        );
    }

    let stem = sanitize_stem(name_hint.as_deref().unwrap_or("image"));
    let dir = target_dir(&options, document_path.as_deref())?;
    let path = write_unique(&dir, &stem, ext, &bytes)?;
    Ok(build_result(
        "clipboard",
        path,
        bytes.len(),
        document_path.as_deref(),
        &options,
    ))
}

/// Copy an image that is already on disk into the configured folder.
#[tauri::command]
pub fn import_image(
    source_path: String,
    document_path: Option<String>,
    options: ImageOptions,
) -> Result<SavedImage, String> {
    // A pasted path is relative to the document being edited, not to the
    // process working directory. Resolve before touching the filesystem, or a
    // file beside the document is reported as missing.
    let source = documents::resolve_path(&source_path, document_path.as_deref());
    if !source.is_file() {
        return Err(format!("{source_path} is not a file."));
    }
    if options.rule == "keepOriginal" {
        // Keep the file untouched, but express a path that lies inside the
        // document's folder relatively: Typst rejects an absolute drive path,
        // and a relative one is also what survives moving the document. A
        // reference the reader typed as relative is left exactly as typed.
        let reference = if Path::new(&source_path).is_absolute() {
            document_path
                .as_deref()
                .and_then(|doc| {
                    Path::new(doc)
                        .parent()
                        .map(|dir| dir.to_string_lossy().to_string())
                })
                .and_then(|dir| relative_path(&dir, &source.to_string_lossy()))
                .filter(|rel| !rel.starts_with(".."))
                .unwrap_or_else(|| source_path.clone())
        } else {
            source_path.clone()
        };
        return Ok(keep_original(reference, "local", &options));
    }

    let bytes = fs::read(&source).map_err(|e| format!("Could not read {source_path}: {e}"))?;
    let ext = sniff_ext(&bytes).ok_or_else(|| {
        format!("{source_path} is not a recognised image format.")
    })?;

    let stem = sanitize_stem(
        &source
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "image".to_string()),
    );
    let dir = target_dir(&options, document_path.as_deref())?;

    // Importing a file onto itself would truncate it.
    let same_dir = source.parent().map(|p| p == dir.as_path()).unwrap_or(false);
    if same_dir {
        return Ok(build_result(
            "local",
            source,
            bytes.len(),
            document_path.as_deref(),
            &options,
        ));
    }

    let path = write_unique(&dir, &stem, ext, &bytes)?;
    Ok(build_result(
        "local",
        path,
        bytes.len(),
        document_path.as_deref(),
        &options,
    ))
}

/// Download an image from the web. The only outbound request this app makes,
/// and only because the user pasted/dropped a URL or a rich fragment containing
/// one. `timeout_ms` lets the rich-paste path cap a single image; the explicit
/// URL path keeps the 25-second default.
#[tauri::command]
pub fn download_image(
    url: String,
    document_path: Option<String>,
    options: ImageOptions,
    timeout_ms: Option<u64>,
) -> Result<SavedImage, String> {
    let target = url.trim();
    if !(target.starts_with("http://") || target.starts_with("https://")) {
        return Err(format!("Refusing to fetch a non-HTTP URL: {url}"));
    }
    if options.rule == "keepOriginal" {
        return Ok(keep_original(url, "remote", &options));
    }

    let timeout = timeout_ms
        .map(|ms| Duration::from_millis(ms.clamp(1_000, 60_000)))
        .unwrap_or(DOWNLOAD_TIMEOUT);
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .user_agent("MDraft")
        .build()
        .into();

    let mut response = agent
        .get(target)
        .call()
        .map_err(|e| download_error(&url, e))?;

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();

    let bytes = response
        .body_mut()
        .with_config()
        .limit(MAX_DOWNLOAD_BYTES)
        .read_to_vec()
        .map_err(|e| format!("Could not read the response body for {url}: {e}"))?;

    // The bytes decide. A URL ending in `.png` proves nothing: an expired
    // session, a login page or a JSON error can all answer 200 with a body that
    // is not an image, and writing it under an image extension produces a file
    // that only looks saved.
    let ext = sniff_ext(&bytes).ok_or_else(|| {
        let described = if content_type.is_empty() {
            "the response".to_string()
        } else {
            format!("the response ({content_type})")
        };
        format!(
            "{url} did not return an image: {described} is not a recognised image format. Save the image from the browser and paste the file instead."
        )
    })?;

    let stem = sanitize_stem(&url_name(&url));

    let dir = target_dir(&options, document_path.as_deref())?;
    let path = write_unique(&dir, &stem, ext, &bytes)?;
    Ok(build_result(
        "remote",
        path,
        bytes.len(),
        document_path.as_deref(),
        &options,
    ))
}

/// The last path segment of a URL, without its query or fragment.
fn url_name(url: &str) -> String {
    url.split(['?', '#'])
        .next()
        .unwrap_or(url)
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("image")
        .to_string()
}

/// A sentence a person can act on, rather than ureq's `http status: 401`.
fn download_error(url: &str, error: ureq::Error) -> String {
    match error {
        ureq::Error::StatusCode(code @ (401 | 403)) => format!(
            "{url} needs a sign-in (HTTP {code}); MDraft cannot use your browser's session. Save the image from the browser and paste the file instead."
        ),
        ureq::Error::StatusCode(code) => format!("{url} answered HTTP {code}."),
        ureq::Error::Timeout(_) => format!("{url} did not answer in time."),
        ureq::Error::HostNotFound => format!("Could not find the server for {url}."),
        ureq::Error::ConnectionFailed => format!("Could not connect to {url}."),
        ureq::Error::TooManyRedirects => format!("{url} redirected too many times."),
        other => format!("Download failed for {url}: {other}."),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    use super::*;

    fn opts(rule: &str) -> ImageOptions {
        ImageOptions {
            rule: rule.to_string(),
            custom_dir: None,
            relative: true,
            dot_slash: true,
            escape: false,
        }
    }

    #[test]
    fn sniffs_common_formats() {
        assert_eq!(sniff_ext(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]), Some("png"));
        assert_eq!(sniff_ext(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("jpg"));
        assert_eq!(sniff_ext(b"GIF89a...."), Some("gif"));
        assert_eq!(sniff_ext(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(sniff_ext(b"RIFF\0\0\0\0WEBPVP8L"), Some("webp"));
        assert_eq!(sniff_ext(b"RIFF\0\0\0\0WEBPVP8X"), Some("webp"));
        assert_eq!(
            sniff_ext(b"RIFF\0\0\0\0WEBPxxxx"),
            None,
            "a RIFF file with the WEBP fourcc but no WebP chunk is not an image"
        );
        assert_eq!(sniff_ext(b"BM6\0"), Some("bmp"));
        assert_eq!(sniff_ext(b"<svg xmlns=\"...\">"), Some("svg"));
        assert_eq!(sniff_ext(b"   \n<svg>"), Some("svg"));
        assert_eq!(
            sniff_ext(b"\0\0\0\x20ftypavif...."),
            Some("avif"),
            "avif brand at offset 8"
        );
    }

    /// An `ftyp` box with the given major brand and compatible brands.
    fn ftyp(major: &[u8; 4], compatible: &[&[u8; 4]]) -> Vec<u8> {
        let size = 16 + 4 * compatible.len();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(size as u32).to_be_bytes());
        bytes.extend_from_slice(b"ftyp");
        bytes.extend_from_slice(major);
        bytes.extend_from_slice(&0u32.to_be_bytes());
        for brand in compatible {
            bytes.extend_from_slice(*brand);
        }
        bytes
    }

    #[test]
    fn an_avif_is_recognised_from_its_compatible_brands() {
        // The sample from aviftools.net declares `avif` as the major brand.
        assert_eq!(sniff_ext(&ftyp(b"avif", &[b"mif1", b"avif", b"miaf"])), Some("avif"));
        // Other AVIF writers declare `mif1` and only list `avif` as compatible.
        assert_eq!(sniff_ext(&ftyp(b"mif1", &[b"avif", b"mif1"])), Some("avif"));
        assert_eq!(sniff_ext(&ftyp(b"heic", &[b"mif1", b"heic"])), Some("heic"));
        assert_eq!(
            sniff_ext(&ftyp(b"mif1", &[b"mif1"])),
            Some("heic"),
            "a generic HEIF stays labelled as HEIC"
        );
        assert_eq!(sniff_ext(&ftyp(b"isom", &[b"isom", b"mp41"])), None);
    }

    #[test]
    fn refuses_non_images() {
        assert_eq!(sniff_ext(b"<!DOCTYPE html><html>"), None);
        assert_eq!(sniff_ext(b"{\"json\":true}"), None);
        assert_eq!(sniff_ext(b""), None);
    }

    #[test]
    fn sanitizes_hostile_names() {
        assert_eq!(sanitize_stem("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_stem("..\\..\\windows\\system32\\cmd"), "cmd");
        assert_eq!(sanitize_stem("/absolute/path/shot.png"), "shot");
        assert_eq!(
            sanitize_stem("Screenshot 2026-10-16 at 14.31.02.png"),
            "Screenshot-2026-10-16-at-14.31.02"
        );
        assert_eq!(sanitize_stem(""), "image");
        assert_eq!(sanitize_stem("..."), "image");
        assert_eq!(sanitize_stem(".."), "image", "a bare traversal segment cannot survive");
        assert_eq!(
            sanitize_stem("..hidden"),
            "hidden",
            "a dotfile contributes its name, not a bare dot"
        );
        assert_eq!(sanitize_stem(".hidden.png"), "hidden");
        assert_eq!(sanitize_stem("CON"), "CON-image");
        assert_eq!(sanitize_stem("nul.png"), "nul-image");
        assert!(sanitize_stem(&"x".repeat(200)).len() <= MAX_STEM_LEN);
        assert!(!sanitize_stem("a/b\\c:d*e?f").contains(['/', '\\', ':', '*', '?']));
        assert_eq!(
            sanitize_stem("a.b.c"),
            "a.b",
            "only the final extension is removed, inner dots survive"
        );
        assert_eq!(
            sanitize_stem("Resolução 2026"),
            "Resolução-2026",
            "letters outside ASCII stay readable instead of becoming dashes"
        );
        // Only the final segment is ever used, so no name can escape a folder.
        assert!(!sanitize_stem("../../x.png").contains(".."));
    }

    #[test]
    fn unique_path_never_overwrites() {
        let dir = std::env::temp_dir().join(format!("tt-img-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let first = unique_path(&dir, "shot", "png");
        assert_eq!(first.file_name().unwrap(), "shot.png");
        fs::write(&first, b"x").unwrap();

        let second = unique_path(&dir, "shot", "png");
        assert_eq!(second.file_name().unwrap(), "shot-1.png");
        fs::write(&second, b"x").unwrap();

        let third = unique_path(&dir, "shot", "png");
        assert_eq!(third.file_name().unwrap(), "shot-2.png");

        let _ = fs::remove_dir_all(&dir);
    }

    // Path handling goes through std::path, whose notion of a separator, of a
    // parent and of "absolute" is platform-specific. These cases are therefore
    // split rather than written once with Windows strings, which would pass on
    // Windows while asserting nothing true about Linux.

    #[cfg(windows)]
    #[test]
    fn computes_relative_paths() {
        assert_eq!(
            relative_path("C:\\notes", "C:\\notes\\doc.assets\\a.png").as_deref(),
            Some("doc.assets/a.png")
        );
        assert_eq!(
            relative_path("C:\\notes\\sub", "C:\\notes\\doc.assets\\a.png").as_deref(),
            Some("../doc.assets/a.png")
        );
        assert_eq!(
            relative_path("c:\\NOTES", "C:\\notes\\a.png").as_deref(),
            Some("a.png"),
            "drive and directory comparison is case-insensitive"
        );
        assert_eq!(
            relative_path("C:\\notes", "D:\\other\\a.png"),
            None,
            "different drives have no relative path"
        );
    }

    #[cfg(unix)]
    #[test]
    fn computes_relative_paths() {
        assert_eq!(
            relative_path("/home/me/notes", "/home/me/notes/doc.assets/a.png").as_deref(),
            Some("doc.assets/a.png")
        );
        assert_eq!(
            relative_path("/home/me/notes/sub", "/home/me/notes/doc.assets/a.png").as_deref(),
            Some("../doc.assets/a.png")
        );
        assert_eq!(
            relative_path("/home/me/notes", "/srv/other/a.png").as_deref(),
            Some("../../../srv/other/a.png"),
            "three levels up: notes -> me -> home -> /"
        );
        assert_eq!(
            relative_path("/home/me", "/home/me/a\\b.png").as_deref(),
            Some("a\\b.png"),
            "a backslash is an ordinary character in a Unix filename"
        );
    }

    #[cfg(windows)]
    #[test]
    fn builds_markdown_paths() {
        let doc = Some("C:\\notes\\doc.md");
        let image = Path::new("C:\\notes\\doc.assets\\a.png");

        let mut o = opts("assetsFolder");
        assert_eq!(markdown_path(image, doc, &o), "./doc.assets/a.png");

        o.dot_slash = false;
        assert_eq!(markdown_path(image, doc, &o), "doc.assets/a.png");

        o.relative = false;
        assert_eq!(markdown_path(image, doc, &o), "C:\\notes\\doc.assets\\a.png");

        o.relative = true;
        o.dot_slash = true;
        o.escape = true;
        assert_eq!(
            markdown_path(
                Path::new("C:\\notes\\doc.assets\\my shot (1).png"),
                doc,
                &o
            ),
            "./doc.assets/my%20shot%20%281%29.png"
        );
    }

    #[cfg(unix)]
    #[test]
    fn builds_markdown_paths() {
        let doc = Some("/home/me/notes/doc.md");
        let image = Path::new("/home/me/notes/doc.assets/a.png");

        let mut o = opts("assetsFolder");
        assert_eq!(markdown_path(image, doc, &o), "./doc.assets/a.png");

        o.dot_slash = false;
        assert_eq!(markdown_path(image, doc, &o), "doc.assets/a.png");

        o.relative = false;
        assert_eq!(
            markdown_path(image, doc, &o),
            "/home/me/notes/doc.assets/a.png",
            "an absolute Unix path needs no ./ prefix even with dot_slash on"
        );

        o.relative = true;
        o.dot_slash = true;
        o.escape = true;
        assert_eq!(
            markdown_path(
                Path::new("/home/me/notes/doc.assets/my shot (1).png"),
                doc,
                &o
            ),
            "./doc.assets/my%20shot%20%281%29.png"
        );
    }

    #[cfg(windows)]
    #[test]
    fn resolves_target_folders() {
        let doc = Some("C:\\notes\\report.md");
        assert_eq!(
            target_dir(&opts("assetsFolder"), doc).unwrap(),
            PathBuf::from("C:\\notes\\report.assets")
        );
        assert_eq!(
            target_dir(&opts("assetsDir"), doc).unwrap(),
            PathBuf::from("C:\\notes\\assets")
        );
        assert_eq!(
            target_dir(&opts("unknown-rule"), doc).unwrap(),
            PathBuf::from("C:\\notes\\report.assets"),
            "an unrecognised rule falls back to the per-document folder"
        );

        let mut custom = opts("custom");
        custom.custom_dir = Some("media".to_string());
        assert_eq!(
            target_dir(&custom, doc).unwrap(),
            PathBuf::from("C:\\notes\\media"),
            "a relative custom folder resolves against the document"
        );
        custom.custom_dir = Some("C:\\pictures".to_string());
        assert_eq!(
            target_dir(&custom, doc).unwrap(),
            PathBuf::from("C:\\pictures")
        );

        custom.custom_dir = Some("media/${filename}".to_string());
        assert_eq!(
            target_dir(&custom, doc).unwrap(),
            PathBuf::from("C:\\notes\\media\\report"),
            "the token expands to the sanitised document stem"
        );
        custom.custom_dir = Some("C:\\pictures\\${filename}".to_string());
        assert_eq!(
            target_dir(&custom, doc).unwrap(),
            PathBuf::from("C:\\pictures\\report"),
            "an absolute custom folder expands the token too"
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolves_target_folders() {
        let doc = Some("/home/me/notes/report.md");
        assert_eq!(
            target_dir(&opts("assetsFolder"), doc).unwrap(),
            PathBuf::from("/home/me/notes/report.assets")
        );
        assert_eq!(
            target_dir(&opts("assetsDir"), doc).unwrap(),
            PathBuf::from("/home/me/notes/assets")
        );
        assert_eq!(
            target_dir(&opts("unknown-rule"), doc).unwrap(),
            PathBuf::from("/home/me/notes/report.assets"),
            "an unrecognised rule falls back to the per-document folder"
        );

        let mut custom = opts("custom");
        custom.custom_dir = Some("media".to_string());
        assert_eq!(
            target_dir(&custom, doc).unwrap(),
            PathBuf::from("/home/me/notes/media"),
            "a relative custom folder resolves against the document"
        );
        custom.custom_dir = Some("/opt/pictures".to_string());
        assert_eq!(
            target_dir(&custom, doc).unwrap(),
            PathBuf::from("/opt/pictures")
        );

        custom.custom_dir = Some("media/${filename}".to_string());
        assert_eq!(
            target_dir(&custom, doc).unwrap(),
            PathBuf::from("/home/me/notes/media/report"),
            "the token expands to the sanitised document stem"
        );
    }

    #[test]
    fn an_untitled_document_has_no_folder_to_write_into() {
        // The process working directory is not a destination: in an installed
        // build it is the application folder.
        for rule in ["assetsFolder", "assetsDir"] {
            let error = target_dir(&opts(rule), None).unwrap_err();
            assert!(
                error.contains("Save it first"),
                "{rule} produced: {error}"
            );
        }

        let mut relative = opts("custom");
        relative.custom_dir = Some("media".to_string());
        assert!(target_dir(&relative, None).unwrap_err().contains("Save it first"));

        let mut token = opts("custom");
        token.custom_dir = Some(format!(
            "{}{}",
            std::env::temp_dir().to_string_lossy(),
            "${filename}"
        ));
        assert!(
            target_dir(&token, None).unwrap_err().contains("Save it first"),
            "a token needs the document name even inside an absolute folder"
        );

        let mut absolute = opts("custom");
        absolute.custom_dir = Some(std::env::temp_dir().to_string_lossy().to_string());
        assert_eq!(
            target_dir(&absolute, None).unwrap(),
            std::env::temp_dir(),
            "an absolute custom folder is a real destination without a document"
        );
    }

    #[test]
    fn extracts_the_name_from_urls() {
        assert_eq!(url_name("https://a.test/x.PNG"), "x.PNG");
        assert_eq!(url_name("https://a.test/x.jpeg?v=2"), "x.jpeg");
        assert_eq!(url_name("https://a.test/x.png#frag"), "x.png");
        assert_eq!(url_name("https://a.test/image"), "image");
        assert_eq!(url_name("https://a.test/a.b.c.webp"), "a.b.c.webp");
        assert_eq!(
            url_name("https://a.test/api/files/0578/rk8_comparacao.png"),
            "rk8_comparacao.png"
        );
    }

    #[test]
    fn keep_original_never_copies() {
        let o = opts("keepOriginal");
        let saved = keep_original("C:\\pics\\a.png".to_string(), "local", &o);
        assert_eq!(saved.markdown_path, "C:\\pics\\a.png");
        assert!(saved.absolute_path.is_empty());
        assert_eq!(saved.bytes, 0);

        let mut escaped = opts("keepOriginal");
        escaped.escape = true;
        let saved = keep_original("https://a.test/a b.png".to_string(), "remote", &escaped);
        assert_eq!(saved.markdown_path, "https://a.test/a%20b.png");
    }

    /// A real 1x1 PNG, so the pipeline is exercised on genuine image bytes.
    fn tiny_png() -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==")
            .unwrap()
    }

    fn encode(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tt-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn saves_clipboard_images_into_the_document_folder() {
        let dir = scratch("clip");
        let doc = dir.join("notes.md");
        fs::write(&doc, "# hi").unwrap();
        let doc_path = Some(doc.to_string_lossy().to_string());

        let saved = save_clipboard_image(
            encode(&tiny_png()),
            Some("shot one".to_string()),
            doc_path.clone(),
            opts("assetsFolder"),
        )
        .unwrap();

        assert_eq!(saved.markdown_path, "./notes.assets/shot-one.png");
        assert_eq!(saved.source, "clipboard");
        assert_eq!(saved.bytes, tiny_png().len());
        assert_eq!(fs::read(&saved.absolute_path).unwrap(), tiny_png());

        let again = save_clipboard_image(
            encode(&tiny_png()),
            Some("shot one".to_string()),
            doc_path,
            opts("assetsFolder"),
        )
        .unwrap();
        assert_eq!(again.markdown_path, "./notes.assets/shot-one-1.png");
        assert_ne!(again.absolute_path, saved.absolute_path);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clipboard_rejects_non_images_and_the_keep_original_rule() {
        let dir = scratch("clip-bad");
        let doc = Some(dir.join("d.md").to_string_lossy().to_string());

        let html = encode(b"<!DOCTYPE html><html>not an image</html>");
        let err = save_clipboard_image(html, None, doc.clone(), opts("assetsFolder")).unwrap_err();
        assert!(err.contains("recognised image"), "got: {err}");

        // A clipboard bitmap has no original location to keep.
        let png = encode(&tiny_png());
        assert!(save_clipboard_image(png, None, doc, opts("keepOriginal")).is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn imports_a_local_file_and_leaves_the_source_alone() {
        let dir = scratch("import");
        let source = dir.join("picture.png");
        fs::write(&source, tiny_png()).unwrap();
        let doc = dir.join("notes.md");
        fs::write(&doc, "x").unwrap();

        let saved = import_image(
            source.to_string_lossy().to_string(),
            Some(doc.to_string_lossy().to_string()),
            opts("assetsDir"),
        )
        .unwrap();

        assert_eq!(saved.markdown_path, "./assets/picture.png");
        assert_eq!(saved.source, "local");
        assert!(Path::new(&saved.absolute_path).is_file());
        assert!(source.is_file(), "the original must survive the import");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn imports_a_relative_source_against_the_document_folder() {
        let dir = scratch("import-relative");
        let doc = dir.join("notes.md");
        fs::write(&doc, "x").unwrap();
        fs::write(dir.join("picture.png"), tiny_png()).unwrap();

        let saved = import_image(
            "picture.png".to_string(),
            Some(doc.to_string_lossy().to_string()),
            opts("assetsDir"),
        )
        .unwrap();

        assert_eq!(saved.markdown_path, "./assets/picture.png");
        assert_eq!(saved.source, "local");
        assert!(Path::new(&saved.absolute_path).is_file());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_relative_kept_image_stays_relative() {
        let dir = scratch("keep-relative");
        let doc = dir.join("notes.md");
        fs::write(&doc, "x").unwrap();
        fs::write(dir.join("picture.png"), tiny_png()).unwrap();

        let saved = import_image(
            "./picture.png".to_string(),
            Some(doc.to_string_lossy().to_string()),
            opts("keepOriginal"),
        )
        .unwrap();

        assert_eq!(saved.markdown_path, "./picture.png");
        assert_eq!(saved.bytes, 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_absolute_kept_path_inside_the_document_folder_becomes_relative() {
        let dir = scratch("keep-absolute-inside");
        let doc = dir.join("notes.md");
        fs::write(&doc, "x").unwrap();
        let source = dir.join("picture.png");
        fs::write(&source, tiny_png()).unwrap();

        let saved = import_image(
            source.to_string_lossy().to_string(),
            Some(doc.to_string_lossy().to_string()),
            opts("keepOriginal"),
        )
        .unwrap();

        assert_eq!(
            saved.markdown_path, "picture.png",
            "Typst can only read a relative path inside its root"
        );
        assert_eq!(saved.bytes, 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_absolute_kept_path_outside_the_document_folder_stays_absolute() {
        let dir = scratch("keep-absolute-outside");
        let doc = dir.join("notes").join("notes.md");
        fs::create_dir_all(doc.parent().unwrap()).unwrap();
        fs::write(&doc, "x").unwrap();
        let source = dir.join("pictures").join("a.png");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, tiny_png()).unwrap();

        let saved = import_image(
            source.to_string_lossy().to_string(),
            Some(doc.to_string_lossy().to_string()),
            opts("keepOriginal"),
        )
        .unwrap();

        assert_eq!(
            saved.markdown_path,
            source.to_string_lossy().to_string(),
            "a path outside the folder is not turned into ../, which would still be outside the root"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn importing_a_file_already_in_the_target_folder_does_not_truncate() {
        let dir = scratch("import-inplace");
        let doc = dir.join("notes.md");
        fs::write(&doc, "x").unwrap();
        let source = dir.join("notes.assets").join("already.png");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, tiny_png()).unwrap();

        let saved = import_image(
            source.to_string_lossy().to_string(),
            Some(doc.to_string_lossy().to_string()),
            opts("assetsFolder"),
        )
        .unwrap();

        assert_eq!(saved.absolute_path, source.to_string_lossy());
        assert_eq!(
            fs::read(&source).unwrap(),
            tiny_png(),
            "the file must still hold the original bytes"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn downloads_refuse_non_http_schemes() {
        for url in ["file:///etc/passwd", "ftp://host/x.png", "data:image/png;base64,AAAA"] {
            let err = download_image(url.to_string(), None, opts("assetsDir"), None).unwrap_err();
            assert!(err.contains("non-HTTP"), "{url} produced: {err}");
        }
    }

    /// One request, one response, then the listener closes.
    fn serve_once(status: &str, content_type: &str, body: &[u8]) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = body.to_vec();
        let status = status.to_string();
        let content_type = content_type.to_string();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = [0u8; 2048];
                let _ = stream.read(&mut request);
                let head = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        format!("http://{address}/image")
    }

    fn download_doc(tag: &str) -> (PathBuf, Option<String>) {
        let dir = scratch(tag);
        let doc = dir.join("notes.md");
        fs::write(&doc, "x").unwrap();
        (dir, Some(doc.to_string_lossy().to_string()))
    }

    #[test]
    fn downloads_accept_a_real_image() {
        let (dir, doc) = download_doc("download-png");
        let url = serve_once("200 OK", "image/png", &tiny_png());
        let saved = download_image(url, doc, opts("assetsDir"), Some(5000)).unwrap();

        assert_eq!(saved.source, "remote");
        assert_eq!(saved.markdown_path, "./assets/image.png");
        assert_eq!(fs::read(&saved.absolute_path).unwrap(), tiny_png());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn downloads_use_the_sniffed_modern_format() {
        let (dir, doc) = download_doc("download-webp");
        let webp = b"RIFF\x24\0\0\0WEBPVP8 \0\0\0\0";
        let url = serve_once("200 OK", "image/webp", webp);
        let saved = download_image(url, doc, opts("assetsDir"), Some(5000)).unwrap();
        assert!(
            saved.markdown_path.ends_with(".webp"),
            "got {}",
            saved.markdown_path
        );

        let (dir2, doc2) = download_doc("download-avif");
        let avif = ftyp(b"mif1", &[b"avif", b"mif1"]);
        let url = serve_once("200 OK", "image/avif", &avif);
        let saved = download_image(url, doc2, opts("assetsDir"), Some(5000)).unwrap();
        assert!(
            saved.markdown_path.ends_with(".avif"),
            "got {}",
            saved.markdown_path
        );

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&dir2);
    }

    #[test]
    fn a_200_that_is_not_an_image_is_refused() {
        let (dir, doc) = download_doc("download-html");
        let url = serve_once(
            "200 OK",
            "text/html",
            b"<!DOCTYPE html><html><body>Please sign in</body></html>",
        );
        let error = download_image(url, doc, opts("assetsDir"), Some(5000)).unwrap_err();

        assert!(error.contains("did not return an image"), "{error}");
        assert!(error.contains("text/html"), "{error}");
        assert!(
            !dir.join("assets").exists(),
            "a refused download must not create the folder"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_sign_in_failure_is_explained() {
        let (dir, doc) = download_doc("download-401");
        let url = serve_once(
            "401 Unauthorized",
            "application/json",
            br#"{"detail":"Not authenticated"}"#,
        );
        let error = download_image(url, doc, opts("assetsDir"), Some(5000)).unwrap_err();

        assert!(error.contains("needs a sign-in"), "{error}");
        assert!(error.contains("401"), "{error}");
        assert!(error.contains("Save the image from the browser"), "{error}");
        assert!(!dir.join("assets").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn other_status_codes_name_the_status() {
        let (dir, doc) = download_doc("download-404");
        let url = serve_once("404 Not Found", "text/plain", b"missing");
        let error = download_image(url, doc, opts("assetsDir"), Some(5000)).unwrap_err();
        assert!(error.contains("HTTP 404"), "{error}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_custom_folder_resolves_and_is_created() {
        let dir = scratch("custom");
        let doc = dir.join("notes.md");
        fs::write(&doc, "x").unwrap();

        let mut o = opts("custom");
        o.custom_dir = Some("media/pics".to_string());

        let saved = save_clipboard_image(
            encode(&tiny_png()),
            Some("chart".to_string()),
            Some(doc.to_string_lossy().to_string()),
            o,
        )
        .unwrap();

        assert_eq!(saved.markdown_path, "./media/pics/chart.png");
        assert!(Path::new(&saved.absolute_path).is_file());

        let _ = fs::remove_dir_all(&dir);
    }
}
