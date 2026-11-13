use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FramingMode {
    Packet,
    Ndjson,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum RequestMethod {
    Compile(CompileParams),
    SetVfsOverlay(SetVfsOverlayParams),
    ClearVfsOverlay,
    LocationToSpans(LocationToSpansParams),
    PointToLocation(PointToLocationParams),
    EvictCache(EvictCacheParams),
    Stats,
    Ping,
    Shutdown,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: u64,
    #[serde(flatten)]
    pub call: RequestMethod,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VfsOverlayEntry {
    pub path: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub content_base64: Option<String>,
    #[serde(default)]
    pub remove: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetVfsOverlayParams {
    #[serde(default)]
    pub root: Option<String>,
    #[serde(default)]
    pub replace_all: bool,
    #[serde(default)]
    pub entries: Vec<VfsOverlayEntry>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompileParams {
    pub main_path: String,
    #[serde(default)]
    pub root: Option<String>,
    #[serde(default = "default_target")]
    pub target: CompileTarget,
    #[serde(default)]
    pub source_text: Option<String>,
    #[serde(default)]
    pub vfs_overlays: Vec<VfsOverlayEntry>,
    #[serde(default)]
    pub clear_unspecified_overlays: bool,
    #[serde(default)]
    pub fallback_to_pages_if_ignored: bool,
    #[serde(default)]
    pub tagged_pdf: bool,
    #[serde(default)]
    pub include_span_map: bool,
}

fn default_target() -> CompileTarget {
    CompileTarget::Pages
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum CompileTarget {
    #[default]
    Pages,
    Document,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationToSpansParams {
    pub file: String,
    pub line: usize,
    pub column: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PointToLocationParams {
    /// 1-based physical page index.
    pub page: usize,
    pub x_pt: f64,
    pub y_pt: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvictCacheParams {
    #[serde(default = "default_max_age")]
    pub max_age: usize,
}

fn default_max_age() -> usize {
    0
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub protocol_version: u32,
    pub id: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compile: Option<CompileResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spans: Option<Vec<PdfBoxLocation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_location: Option<SourceLocation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats: Option<ServiceStats>,
    /// Populated only in `--framing ndjson` mode; omitted in binary packet mode.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload_base64: Option<String>,
    pub payload_bytes: usize,
}

impl Response {
    pub fn success(id: u64) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            id,
            ok: true,
            error: None,
            compile: None,
            spans: None,
            source_location: None,
            stats: None,
            payload_base64: None,
            payload_bytes: 0,
        }
    }

    pub fn err(id: u64, message: impl Into<String>) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            id,
            ok: false,
            error: Some(message.into()),
            compile: None,
            spans: None,
            source_location: None,
            stats: None,
            payload_base64: None,
            payload_bytes: 0,
        }
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DependencyInfo {
    pub path: String,
    pub mtime_ms: u64,
    pub size: u64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompactSpanAnchor {
    pub file: String,
    pub line: usize,
    pub column: usize,
    pub byte_offset: usize,
    pub utf16_start: usize,
    pub utf16_end: usize,
    pub page: usize,
    pub x_pt: f64,
    pub y_pt: f64,
    pub width_pt: f64,
    pub height_pt: f64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompileResult {
    pub kind: &'static str,
    pub fell_back_from_document: bool,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
    pub ignored: Vec<String>,
    pub diagnostics: Vec<DiagnosticInfo>,
    pub page_count: usize,
    pub page_hashes: Vec<String>,
    /// 1-based first page index whose hash differs from the previous compile
    /// in the same session, or `None` when zero pages changed.
    pub first_changed_page: Option<usize>,
    pub changed_pages: Vec<usize>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deps: Vec<DependencyInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub span_map: Vec<CompactSpanAnchor>,
    pub timings: CompileTimings,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticInfo {
    pub severity: &'static str,
    pub message: String,
    pub file: Option<String>,
    pub line: Option<usize>,
    pub column: Option<usize>,
    pub hints: Vec<String>,
}

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompileTimings {
    pub vfs_sync_ms: f64,
    pub typst_compile_ms: f64,
    pub export_ms: f64,
    pub page_hash_ms: f64,
    pub total_ms: f64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PdfBoxLocation {
    pub page: usize,
    pub x_pt: f64,
    pub y_pt: f64,
    pub width_pt: f64,
    pub height_pt: f64,
    pub distance: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SourceLocation {
    pub file: String,
    pub line: usize,
    pub column: usize,
    pub byte_offset: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStats {
    pub protocol_version: u32,
    pub typst_version: &'static str,
    pub compile_count: u64,
    pub max_cache_age: usize,
    pub font_families: usize,
    pub overlay_entries: usize,
    pub last_page_count: usize,
    pub rss_bytes: Option<u64>,
}

const MAX_HEADER_BYTES: usize = 32 * 1024 * 1024;
const MAX_BODY_BYTES: usize = 128 * 1024 * 1024;

/// Read a binary-framed packet:
/// `[u32 BE json_len][json_bytes][u32 BE body_len][body_bytes]`.
/// Returns `Ok(None)` on clean EOF at packet boundary.
pub fn read_packet<R: Read>(reader: &mut R) -> io::Result<Option<(Vec<u8>, Vec<u8>)>> {
    let mut len_buf = [0u8; 4];
    match reader.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let header_len = u32::from_be_bytes(len_buf) as usize;
    if header_len == 0 || header_len > MAX_HEADER_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid packet header length {header_len}"),
        ));
    }
    let mut header = vec![0u8; header_len];
    reader.read_exact(&mut header)?;

    reader.read_exact(&mut len_buf)?;
    let body_len = u32::from_be_bytes(len_buf) as usize;
    if body_len > MAX_BODY_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid packet body length {body_len}"),
        ));
    }
    let mut body = vec![0u8; body_len];
    if body_len > 0 {
        reader.read_exact(&mut body)?;
    }
    Ok(Some((header, body)))
}

/// Write a binary-framed packet:
/// `[u32 BE json_len][json_bytes][u32 BE payload_len][payload_bytes]`.
pub fn write_packet<W: Write>(writer: &mut W, header: &[u8], payload: &[u8]) -> io::Result<()> {
    let h_len = u32::try_from(header.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "header too large"))?;
    let p_len = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "payload too large"))?;
    writer.write_all(&h_len.to_be_bytes())?;
    writer.write_all(header)?;
    writer.write_all(&p_len.to_be_bytes())?;
    if !payload.is_empty() {
        writer.write_all(payload)?;
    }
    writer.flush()
}

const B64_TABLE: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn encode_base64(input: &[u8]) -> String {
    if input.is_empty() {
        return String::new();
    }
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_TABLE[((triple >> 18) & 0x3F) as usize] as char);
        out.push(B64_TABLE[((triple >> 12) & 0x3F) as usize] as char);
        out.push(if chunk.len() > 1 {
            B64_TABLE[((triple >> 6) & 0x3F) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64_TABLE[(triple & 0x3F) as usize] as char
        } else {
            '='
        });
    }
    out
}

pub fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let bytes: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    if !bytes.len().is_multiple_of(4) {
        return Err("invalid base64 length".into());
    }
    let decode_char = |c: u8| -> Result<u8, String> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(format!("invalid base64 byte: {}", c as char)),
        }
    };
    let mut out = Vec::with_capacity((bytes.len() / 4) * 3);
    for chunk in bytes.as_chunks::<4>().0 {
        let pad = chunk.iter().rev().take_while(|&&b| b == b'=').count();
        if pad > 2 {
            return Err("invalid base64 padding".into());
        }
        let a = decode_char(chunk[0])?;
        let b = decode_char(chunk[1])?;
        let c = if chunk[2] == b'=' { 0 } else { decode_char(chunk[2])? };
        let d = if chunk[3] == b'=' { 0 } else { decode_char(chunk[3])? };
        let triple = ((a as u32) << 18) | ((b as u32) << 12) | ((c as u32) << 6) | (d as u32);
        out.push(((triple >> 16) & 0xFF) as u8);
        if chunk[2] != b'=' {
            out.push(((triple >> 8) & 0xFF) as u8);
        }
        if chunk[3] != b'=' {
            out.push((triple & 0xFF) as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn packet_round_trip() {
        let mut wire = Vec::new();
        let hdr = br#"{"id":7,"ok":true}"#;
        let pdf = b"%PDF-1.7 test";
        write_packet(&mut wire, hdr, pdf).unwrap();

        let mut cursor = Cursor::new(wire);
        let (read_hdr, read_pdf) = read_packet(&mut cursor).unwrap().unwrap();
        assert_eq!(read_hdr, hdr);
        assert_eq!(read_pdf, pdf);
        assert!(read_packet(&mut cursor).unwrap().is_none());
    }

    #[test]
    fn base64_round_trip() {
        for sample in [b"".as_slice(), b"f", b"fo", b"foo", b"%PDF-1.7 binary\x00\xff"] {
            let encoded = encode_base64(sample);
            let decoded = decode_base64(&encoded).unwrap();
            assert_eq!(decoded, sample);
        }
    }
}
