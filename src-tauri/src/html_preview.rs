//! The sandboxed HTML preview protocol.
//!
//! The guest document is served from a private scheme instead of being pasted
//! into the application's DOM. The scheme handler is not an HTTP server: no
//! socket is opened. It exists for three reasons:
//!
//! 1. the document must keep its own URL so relative CSS, images, scripts,
//!    modules and fonts load the way they do in a browser;
//! 2. the document must be a different origin from the application, so its
//!    scripts cannot read the editor or the IPC bridge;
//! 3. the source is only ever a string held for the current preview. It is
//!    never written beside the user's document.
//!
//! The guest iframe is sandboxed without `allow-same-origin`, so its origin is
//! opaque. That is why fonts, ES modules and — on WebKitGTK — local stylesheets,
//! images and classic scripts need CORS on the protocol even though the document
//! itself is served by the same scheme. The frontend marks those local assets
//! `crossorigin` in the preview copy; the handler answers with
//! `Access-Control-Allow-Origin` for static asset kinds. A `fetch()` is still
//! blocked by `connect-src`, and a request that identifies itself as `empty`
//! gets no header.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, State, UriSchemeResponder};

pub const SCHEME: &str = "mdraft-preview";
const HOST_SUFFIX: &str = ".invalid";
const MAX_ASSET_BYTES: u64 = 64 * 1024 * 1024;

/// The one preview currently allowed to load. A new document replaces the
/// state; an old iframe with an old nonce then gets a 404.
#[derive(Default)]
pub struct PreviewStore(Mutex<Option<PreviewState>>);

#[derive(Clone)]
struct PreviewState {
  nonce: String,
  bridge_nonce: String,
  source: Arc<str>,
  root: Option<PathBuf>,
  /// Folders the reader allowed for images, from Preferences › Image. A saved
  /// document's own folder is `root`; a custom image folder outside it is
  /// unreachable to the guest without this list.
  image_roots: Vec<PathBuf>,
  filename: String,
  scripts: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlPreviewRequest {
  pub nonce: String,
  pub bridge_nonce: String,
  pub source: String,
  pub root: Option<String>,
  /// Additional image folders. Absent from older callers, hence the default.
  #[serde(default)]
  pub image_roots: Vec<String>,
  pub filename: String,
  pub scripts: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlPreviewUrl {
  pub url: String,
}

/// The guest URL for the current platform.
///
/// Windows loads custom protocols through `http://<scheme>.localhost`. The
/// workaround in wry also routes `http://<scheme>.<anything>`, so the nonce is
/// placed after the scheme and the host ends in `.invalid`. A `*.localhost`
/// host would be classified as a **local** Tauri origin and the guest could
/// reach the IPC bridge.
fn guest_origin(nonce: &str) -> String {
  if cfg!(windows) {
    format!("http://{SCHEME}.{nonce}{HOST_SUFFIX}")
  } else {
    format!("{SCHEME}://{nonce}{HOST_SUFFIX}")
  }
}

fn is_safe_token(value: &str) -> bool {
  (8..=128).contains(&value.len())
    && value
      .bytes()
      .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn sanitize_filename(name: &str) -> String {
  let base = Path::new(name)
    .file_name()
    .and_then(|value| value.to_str())
    .unwrap_or("index.html");
  let lower = base.to_ascii_lowercase();
  if lower.ends_with(".html") || lower.ends_with(".htm") {
    base.to_string()
  } else {
    "index.html".to_string()
  }
}

fn encode_segment(value: &str) -> String {
  percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC).to_string()
}

/// Store the next guest document and return the URL the iframe should load.
///
/// The source is the preview copy prepared by the frontend: the original HTML
/// with `data-mdraft-line` attributes and the bridge script spliced in. It is
/// never written to disk and is replaced by the next render.
#[tauri::command]
pub fn set_html_preview(
  store: State<'_, PreviewStore>,
  request: HtmlPreviewRequest,
) -> Result<HtmlPreviewUrl, String> {
  if !is_safe_token(&request.nonce) || !is_safe_token(&request.bridge_nonce) {
    return Err("The HTML preview nonce is malformed.".into());
  }

  let filename = sanitize_filename(&request.filename);
  let root = request.root.as_deref().and_then(|raw| {
    let path = PathBuf::from(raw);
    if !path.is_dir() {
      return None;
    }
    path.canonicalize().ok()
  });
  let image_roots: Vec<PathBuf> = request
    .image_roots
    .iter()
    .filter_map(|raw| {
      let path = PathBuf::from(raw);
      if !path.is_dir() {
        return None;
      }
      path.canonicalize().ok()
    })
    .filter(|path| root.as_ref() != Some(path))
    .collect();

  let next = PreviewState {
    nonce: request.nonce.clone(),
    bridge_nonce: request.bridge_nonce,
    source: Arc::from(request.source),
    root,
    image_roots,
    filename: filename.clone(),
    scripts: request.scripts,
  };

  let mut slot = store
    .0
    .lock()
    .map_err(|_| "The HTML preview state is poisoned.".to_string())?;
  *slot = Some(next);
  drop(slot);

  Ok(HtmlPreviewUrl {
    url: format!("{}/{}", guest_origin(&request.nonce), encode_segment(&filename)),
  })
}

#[tauri::command]
pub fn clear_html_preview(store: State<'_, PreviewStore>) {
  if let Ok(mut slot) = store.0.lock() {
    *slot = None;
  }
}

/// Entry point used by `Builder::register_asynchronous_uri_scheme_protocol`.
pub fn serve(app: AppHandle, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
  tauri::async_runtime::spawn(async move {
    responder.respond(respond(&app, request).await);
  });
}

async fn respond(app: &AppHandle, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
  let method = request.method();
  if method != tauri::http::Method::GET && method != tauri::http::Method::HEAD {
    return text(
      StatusCode::METHOD_NOT_ALLOWED,
      "Only GET and HEAD are supported.",
    );
  }
  let head = method == tauri::http::Method::HEAD;

  let Some(host) = request.uri().host() else {
    return text(StatusCode::NOT_FOUND, "Not found.");
  };
  let Some(nonce) = host.strip_suffix(HOST_SUFFIX) else {
    return text(StatusCode::NOT_FOUND, "Not found.");
  };

  let state = app
    .try_state::<PreviewStore>()
    .and_then(|store| store.0.lock().ok().and_then(|slot| slot.clone()));
  let Some(state) = state else {
    return text(StatusCode::NOT_FOUND, "No HTML preview is active.");
  };
  if nonce != state.nonce {
    return text(StatusCode::NOT_FOUND, "This preview is no longer active.");
  }

  let path = request.uri().path().to_string();
  let document_path = format!("/{}", encode_segment(&state.filename));
  if path == "/" || path == document_path || path == "/index.html" {
    return html_response(&state, head);
  }
  if path.starts_with("/__mdraft/") {
    return text(StatusCode::NOT_FOUND, "Not found.");
  }

  serve_asset(&state, &path, &request, head).await
}

fn html_response(state: &PreviewState, head: bool) -> Response<Vec<u8>> {
  let source = if cfg!(windows) {
    format!("http://{SCHEME}.{}{HOST_SUFFIX}", state.nonce)
  } else {
    format!("{SCHEME}:")
  };
  let csp = csp_for(&source, state.scripts, &state.bridge_nonce);
  let bytes = state.source.as_bytes();
  let body = if head { Vec::new() } else { bytes.to_vec() };
  Response::builder()
    .status(StatusCode::OK)
    .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
    .header(header::CONTENT_SECURITY_POLICY, csp)
    .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
    .header(header::CACHE_CONTROL, "no-store")
    .header("Referrer-Policy", "no-referrer")
    .body(body)
    .unwrap_or_else(|_| Response::new(Vec::new()))
}

async fn serve_asset(
  state: &PreviewState,
  url_path: &str,
  request: &Request<Vec<u8>>,
  head: bool,
) -> Response<Vec<u8>> {
  let mut roots: Vec<&Path> = Vec::new();
  if let Some(root) = state.root.as_deref() {
    roots.push(root);
  }
  for root in &state.image_roots {
    roots.push(root.as_path());
  }
  if roots.is_empty() {
    return text(StatusCode::NOT_FOUND, "This document has no folder.");
  }
  let Some(relative) = safe_relative_path(url_path) else {
    return text(StatusCode::FORBIDDEN, "That path is not allowed.");
  };

  let file_path = match resolve_asset(&roots, &relative) {
    Some(path) => path,
    None => return text(StatusCode::NOT_FOUND, "Not found."),
  };
  let extension = file_path
    .extension()
    .map(|value| value.to_string_lossy().to_ascii_lowercase())
    .unwrap_or_default();
  if extension == "html" || extension == "htm" {
    // The guest must not navigate into another local page and lose the bridge.
    return text(StatusCode::NOT_FOUND, "Not found.");
  }

  let metadata = match fs::metadata(&file_path) {
    Ok(metadata) if metadata.is_file() => metadata,
    _ => return text(StatusCode::NOT_FOUND, "Not found."),
  };
  if metadata.len() > MAX_ASSET_BYTES {
    return text(StatusCode::PAYLOAD_TOO_LARGE, "That file is too large.");
  }

  let read_path = file_path.clone();
  let bytes = match tauri::async_runtime::spawn_blocking(move || fs::read(read_path)).await {
    Ok(Ok(bytes)) => bytes,
    _ => return text(StatusCode::NOT_FOUND, "Not found."),
  };

  let mime = mime_for(&extension);
  let cors = allows_cors(&extension, request);
  let mut builder = Response::builder()
    .status(StatusCode::OK)
    .header(header::CONTENT_TYPE, mime)
    .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
    .header(header::CACHE_CONTROL, "no-store");
  if cors {
    builder = builder.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
  }
  let body = if head { Vec::new() } else { bytes };
  builder
    .body(body)
    .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// Resolve a URL path below a canonical root, refusing every escape.
///
/// The URL path is decoded before it is inspected, so `%2e%2e` cannot pass as
/// ordinary text. Backslashes are rejected rather than treated as separators:
/// on Windows they are separators to the filesystem but not to the URL parser,
/// which is exactly the mismatch traversal bugs live in.
fn safe_relative_path(url_path: &str) -> Option<PathBuf> {
  let raw = url_path.trim_start_matches('/');
  let decoded = percent_encoding::percent_decode_str(raw).decode_utf8().ok()?;
  if decoded.is_empty() || decoded.contains('\0') || decoded.contains('\\') {
    return None;
  }

  let mut out = PathBuf::new();
  for segment in decoded.split('/') {
    if segment.is_empty() || segment == "." {
      continue;
    }
    if segment == ".." {
      return None;
    }
    if segment.contains(':')
      || segment.contains('?')
      || segment.contains('*')
      || segment.contains('"')
      || segment.contains('<')
      || segment.contains('>')
      || segment.contains('|')
    {
      return None;
    }
    if cfg!(windows) && is_windows_reserved(segment) {
      return None;
    }
    out.push(segment);
  }
  if out.as_os_str().is_empty() {
    None
  } else {
    Some(out)
  }
}

/// Resolve a URL path below any allowed root, refusing every escape.
///
/// A saved document has one root, its own folder. The reader may additionally
/// choose a custom image folder in Preferences; only that folder is added, and
/// each candidate is canonicalised and checked against every root, so a `..` or
/// a symlink that leaves all of them is still refused.
fn resolve_asset(roots: &[&Path], relative: &Path) -> Option<PathBuf> {
  for root in roots {
    let Ok(candidate) = root.join(relative).canonicalize() else {
      continue;
    };
    if candidate.starts_with(root) && candidate.is_file() {
      return Some(candidate);
    }
  }
  None
}

fn is_windows_reserved(segment: &str) -> bool {
  let stem = segment
    .split('.')
    .next()
    .unwrap_or(segment)
    .trim_end_matches(' ')
    .to_ascii_uppercase();
  matches!(
    stem.as_str(),
    "CON"
      | "PRN"
      | "AUX"
      | "NUL"
      | "COM1"
      | "COM2"
      | "COM3"
      | "COM4"
      | "COM5"
      | "COM6"
      | "COM7"
      | "COM8"
      | "COM9"
      | "LPT1"
      | "LPT2"
      | "LPT3"
      | "LPT4"
      | "LPT5"
      | "LPT6"
      | "LPT7"
      | "LPT8"
      | "LPT9"
  )
}

fn mime_for(extension: &str) -> &'static str {
  match extension {
    "html" | "htm" => "text/html; charset=utf-8",
    "css" => "text/css; charset=utf-8",
    "js" | "mjs" => "text/javascript; charset=utf-8",
    "json" => "application/json",
    "txt" | "md" | "typ" => "text/plain; charset=utf-8",
    "xml" => "application/xml",
    "svg" => "image/svg+xml",
    "png" => "image/png",
    "jpg" | "jpeg" => "image/jpeg",
    "gif" => "image/gif",
    "webp" => "image/webp",
    "avif" => "image/avif",
    "bmp" => "image/bmp",
    "ico" => "image/x-icon",
    "woff" => "font/woff",
    "woff2" => "font/woff2",
    "ttf" => "font/ttf",
    "otf" => "font/otf",
    "mp4" => "video/mp4",
    "webm" => "video/webm",
    "ogg" | "ogv" => "video/ogg",
    "mp3" => "audio/mpeg",
    "wav" => "audio/wav",
    "wasm" => "application/wasm",
    "pdf" => "application/pdf",
    _ => "application/octet-stream",
  }
}

/// CORS is needed by an opaque iframe for fonts, ES modules and WebKitGTK's
/// static assets.
///
/// Chromium identifies element requests (`script`, `style`, `image`, `font`) and
/// gets a header only for those; a `fetch()` reports `empty` and must not read a
/// local file. WebKitGTK omits the metadata entirely, so static asset kinds are
/// allowed there. `.json`, `.txt` and other data files never match, and the CSP's
/// `connect-src` independently blocks a local `fetch()` on every platform.
fn allows_cors(extension: &str, request: &Request<Vec<u8>>) -> bool {
  let static_asset = matches!(
    extension,
    "js"
      | "mjs"
      | "css"
      | "woff"
      | "woff2"
      | "ttf"
      | "otf"
      | "png"
      | "jpg"
      | "jpeg"
      | "gif"
      | "webp"
      | "avif"
      | "bmp"
      | "ico"
      | "svg"
      | "mp3"
      | "wav"
      | "ogg"
      | "mp4"
      | "webm"
  );
  match request
    .headers()
    .get("sec-fetch-dest")
    .and_then(|value| value.to_str().ok())
  {
    Some("script" | "style" | "image" | "font" | "audio" | "video" | "track") => true,
    // WebKitGTK does not send the Sec-Fetch metadata. It also refuses a
    // stylesheet, image or classic script from this scheme when the response
    // carries no CORS header, even though the document asked for it without
    // `crossorigin`. Allow the static asset kinds there; a `fetch()` is still
    // blocked by `connect-src`, and `.json`/`.txt` (not in this list) still get
    // no header.
    None => static_asset,
    _ => false,
  }
}

fn csp_for(source: &str, scripts: bool, bridge_nonce: &str) -> String {
  let script = if scripts {
    format!("script-src {source} https: data: blob: 'unsafe-inline' 'unsafe-eval';")
  } else {
    format!("script-src 'nonce-{bridge_nonce}';")
  };
  format!(
    "default-src 'none'; \
     {script} \
     style-src {source} https: data: blob: 'unsafe-inline'; \
     img-src {source} https: data: blob:; \
     font-src {source} https: data:; \
     media-src {source} https: data: blob:; \
     connect-src https: data: blob:; \
     frame-src {source} https:; \
     object-src 'none'; \
     worker-src 'none'; \
     base-uri {source} https:; \
     form-action {source} https:"
  )
}

fn text(status: StatusCode, message: &str) -> Response<Vec<u8>> {
  Response::builder()
    .status(status)
    .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
    .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
    .header(header::CACHE_CONTROL, "no-store")
    .body(message.as_bytes().to_vec())
    .unwrap_or_else(|_| Response::new(Vec::new()))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn tokens_are_ascii_and_bounded() {
    assert!(is_safe_token("0123456789abcdef"));
    assert!(is_safe_token("a-b_c-12345678"));
    assert!(!is_safe_token("short"));
    assert!(!is_safe_token("with space"));
    assert!(!is_safe_token("semi;colon"));
  }

  #[test]
  fn filename_is_a_basename_and_html_only() {
    assert_eq!(sanitize_filename("notes.html"), "notes.html");
    #[cfg(windows)]
    assert_eq!(sanitize_filename("a\\b\\notes.HTM"), "notes.HTM");
    #[cfg(not(windows))]
    assert_eq!(sanitize_filename("a/b/notes.HTM"), "notes.HTM");
    assert_eq!(sanitize_filename("notes.md"), "index.html");
    assert_eq!(sanitize_filename("../secret.html"), "secret.html");
  }

  #[test]
  fn relative_paths_refuse_traversal_and_windows_syntax() {
    assert_eq!(
      safe_relative_path("/assets/site.css"),
      Some(PathBuf::from("assets/site.css"))
    );
    assert_eq!(safe_relative_path("/a//b.png"), Some(PathBuf::from("a/b.png")));
    assert_eq!(safe_relative_path("/../secret.txt"), None);
    assert_eq!(safe_relative_path("/%2e%2e/secret.txt"), None);
    assert_eq!(safe_relative_path("/a%5cb.png"), None);
    assert_eq!(safe_relative_path("/C:/Windows/win.ini"), None);
    assert_eq!(safe_relative_path("/a%00b"), None);
    assert_eq!(safe_relative_path("/"), None);
  }

  #[test]
  fn windows_reserved_names_are_refused() {
    assert!(is_windows_reserved("CON"));
    assert!(is_windows_reserved("nul.txt"));
    assert!(is_windows_reserved("LPT1"));
    assert!(!is_windows_reserved("console.js"));
  }

  #[test]
  fn mime_table_covers_the_guest_assets() {
    assert!(mime_for("css").starts_with("text/css"));
    assert_eq!(mime_for("js"), "text/javascript; charset=utf-8");
    assert_eq!(mime_for("woff2"), "font/woff2");
    assert_eq!(mime_for("unknown"), "application/octet-stream");
  }

  #[test]
  fn webkit_static_assets_get_cors_without_fetch_metadata() {
    let bare = Request::builder().body(Vec::new()).unwrap();
    assert!(allows_cors("css", &bare));
    assert!(allows_cors("png", &bare));
    assert!(allows_cors("js", &bare));
    assert!(!allows_cors("json", &bare));

    let fetch = Request::builder()
      .header("sec-fetch-dest", "empty")
      .body(Vec::new())
      .unwrap();
    assert!(!allows_cors("css", &fetch));
    assert!(!allows_cors("js", &fetch));

    let style = Request::builder()
      .header("sec-fetch-dest", "style")
      .body(Vec::new())
      .unwrap();
    assert!(allows_cors("css", &style));
  }

  #[test]
  fn csp_switches_between_document_scripts_and_the_bridge_only() {
    let on = csp_for("http://mdraft-preview.abc.invalid", true, "bridge");
    assert!(on.contains("script-src http://mdraft-preview.abc.invalid"));
    assert!(on.contains("'unsafe-inline'"));
    assert!(!on.contains("nonce-bridge"));
    let connect = on
      .split("connect-src ")
      .nth(1)
      .and_then(|rest| rest.split(';').next())
      .unwrap_or("");
    assert!(!connect.contains("http:"));
    assert!(on.contains("object-src 'none'"));
    assert!(on.contains("worker-src 'none'"));

    let off = csp_for("http://mdraft-preview.abc.invalid", false, "bridge");
    assert!(off.contains("script-src 'nonce-bridge'"));
    let off_script = off
      .split("script-src ")
      .nth(1)
      .and_then(|rest| rest.split(';').next())
      .unwrap_or("");
    assert!(!off_script.contains("'unsafe-inline'"));
  }

  #[test]
  fn a_file_outside_every_root_is_not_resolved() {
    let dir = std::env::temp_dir().join(format!("mdraft-html-preview-{}", std::process::id()));
    let root = dir.join("site");
    let images = dir.join("pictures");
    let outside = dir.join("outside.txt");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&images).unwrap();
    fs::write(root.join("inside.txt"), b"inside").unwrap();
    fs::write(images.join("custom.png"), b"custom").unwrap();
    fs::write(&outside, b"outside").unwrap();

    let root = root.canonicalize().unwrap();
    let images = images.canonicalize().unwrap();
    let roots = [root.as_path(), images.as_path()];

    assert_eq!(
      resolve_asset(&roots, Path::new("inside.txt")),
      Some(root.join("inside.txt").canonicalize().unwrap())
    );
    assert_eq!(
      resolve_asset(&roots, Path::new("../pictures/custom.png")),
      Some(images.join("custom.png").canonicalize().unwrap()),
      "a custom image folder is reachable through .. when it is an allowed root"
    );
    assert_eq!(
      resolve_asset(&roots, Path::new("../outside.txt")),
      None,
      "a file outside every allowed root stays refused"
    );

    let _ = fs::remove_dir_all(&dir);
  }

  #[cfg(unix)]
  #[test]
  fn a_symlink_escaping_the_root_is_not_resolved() {
    use std::os::unix::fs::symlink;
    let dir = std::env::temp_dir().join(format!("mdraft-html-link-{}", std::process::id()));
    let root = dir.join("site");
    let outside = dir.join("outside.txt");
    fs::create_dir_all(&root).unwrap();
    fs::write(&outside, b"outside").unwrap();
    if symlink(&outside, root.join("escape.txt")).is_ok() {
      let root = root.canonicalize().unwrap();
      let roots = [root.as_path()];
      assert_eq!(resolve_asset(&roots, Path::new("escape.txt")), None);
    }
    let _ = fs::remove_dir_all(&dir);
  }
}
