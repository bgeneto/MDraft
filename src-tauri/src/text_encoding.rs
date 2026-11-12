//! Text-file encoding ownership.
//!
//! A document is decoded for the editor and encoded back to the exact bytes the
//! reader opened. The original encoding is therefore part of the document's
//! identity, like its line endings and BOM.
//!
//! Acceptance is deliberately conservative: a legacy candidate is only used
//! when decoding and re-encoding reproduces every input byte. That is what makes
//! an unmodified Save byte-identical instead of merely "looks right".

use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::{Encoding, UTF_8, UTF_16BE, UTF_16LE};

#[derive(Debug)]
pub struct DecodedText {
    pub text: String,
    pub encoding: &'static Encoding,
    pub had_bom: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum EncodeError {
    /// The text contains a character the chosen encoding cannot store.
    Unmappable,
    /// The label is not a real text encoding (or is not one we can write).
    UnsuitableEncoding,
}

impl std::fmt::Display for EncodeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unmappable => formatter.write_str(
                "The text contains characters this document's encoding cannot store. \
                 Save it as a UTF-8 copy instead.",
            ),
            Self::UnsuitableEncoding => {
                formatter.write_str("The document's encoding is not supported for saving.")
            }
        }
    }
}

/// The canonical label a session and the status bar carry.
pub fn label(encoding: &'static Encoding) -> &'static str {
    encoding.name()
}

/// Resolve a label received from a session or the status bar.
///
/// `for_label_no_replacement` refuses the replacement pseudo-encoding. The
/// `x-user-defined` pseudo-encoding round-trips private-use code points but is
/// not a text encoding a reader can edit, so it is refused too.
pub fn for_label(label: &str) -> Result<&'static Encoding, String> {
    let encoding = Encoding::for_label_no_replacement(label.trim().as_bytes())
        .ok_or_else(|| format!("The document's encoding \"{label}\" is not supported."))?;
    if encoding == encoding_rs::X_USER_DEFINED {
        return Err("The document uses a character map, not a text encoding.".into());
    }
    Ok(encoding)
}

fn binary_error() -> String {
    "This is a binary/non-text file, or it uses a text encoding that cannot be reproduced safely. It cannot be edited as a document.".into()
}

fn invalid_utf16(encoding: &'static Encoding) -> String {
    format!(
        "The file has a {} byte-order mark but contains malformed text.",
        label(encoding)
    )
}

fn forbidden_control(text: &str) -> bool {
    text.chars().any(|character| {
        matches!(
            character,
            '\u{0}'..='\u{8}' | '\u{b}' | '\u{e}'..='\u{1f}' | '\u{7f}' | '\u{80}'..='\u{9f}'
        )
    })
}

fn validate_text(text: &str) -> Result<(), String> {
    if forbidden_control(text) {
        return Err(binary_error());
    }
    Ok(())
}

fn binary_signature(bytes: &[u8]) -> bool {
    let header = bytes
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(0);
    let prefix = &bytes[header..];
    prefix.starts_with(b"%PDF-")
        || bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
        || bytes.starts_with(b"PK\x03\x04")
        || bytes.starts_with(b"PK\x05\x06")
        || bytes.starts_with(b"PK\x07\x08")
        || bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(b"\xff\xd8\xff")
        || (bytes.starts_with(b"RIFF")
            && bytes
                .get(8..12)
                .is_some_and(|kind| kind == b"WEBP" || kind == b"WAVE" || kind == b"AVI "))
}

fn text_binary_signature(text: &str) -> bool {
    let prefix = text.trim_start_matches(|character: char| character.is_ascii_whitespace());
    prefix.starts_with("%PDF-")
        || text.starts_with("GIF87a")
        || text.starts_with("GIF89a")
        || text.starts_with("PK\x03\x04")
        || text.starts_with("PK\x05\x06")
        || text.starts_with("PK\x07\x08")
        || text.starts_with("\u{89}PNG\r\n\u{1a}\n")
        || (text.starts_with("RIFF")
            && text
                .get(8..12)
                .is_some_and(|kind| matches!(kind, "WEBP" | "WAVE" | "AVI ")))
}

/// Decode a text document without ever replacing a character.
pub fn decode(bytes: &[u8]) -> Result<DecodedText, String> {
    // UTF-32 is not implemented by encoding_rs. Identify it before the NUL
    // classifier so the reader gets an encoding explanation, not "binary".
    if bytes.starts_with(&[0xff, 0xfe, 0, 0]) || bytes.starts_with(&[0, 0, 0xfe, 0xff]) {
        return Err(
            "UTF-32 text is not supported yet. Convert a copy to UTF-8 before opening it.".into(),
        );
    }

    if let Some((encoding, bom_len)) = Encoding::for_bom(bytes) {
        let body = &bytes[bom_len..];
        if encoding == UTF_8 {
            let text = std::str::from_utf8(body).map_err(|_| {
                "The file has a UTF-8 byte-order mark but is not valid UTF-8.".to_string()
            })?;
            validate_text(text)?;
            if text_binary_signature(text) {
                return Err(binary_error());
            }
            return Ok(DecodedText {
                text: text.to_owned(),
                encoding,
                had_bom: true,
            });
        }
        let text = encoding
            .decode_without_bom_handling_and_without_replacement(body)
            .ok_or_else(|| invalid_utf16(encoding))?;
        validate_text(&text)?;
        if text_binary_signature(&text) {
            return Err(binary_error());
        }
        return Ok(DecodedText {
            text: text.into_owned(),
            encoding,
            had_bom: true,
        });
    }

    if binary_signature(bytes) {
        return Err(binary_error());
    }

    if let Ok(text) = std::str::from_utf8(bytes) {
        validate_text(text)?;
        return Ok(DecodedText {
            text: text.to_owned(),
            encoding: UTF_8,
            had_bom: false,
        });
    }

    // Valid UTF-8 was handled above, so the detector must not return it. A
    // BOM-less UTF-16 guess is not something Save can reproduce with a BOM.
    let mut detector = EncodingDetector::new(Iso2022JpDetection::Deny);
    detector.feed(bytes, true);
    let guessed = detector.guess(None, Utf8Detection::Deny);
    if guessed == UTF_16LE || guessed == UTF_16BE {
        return Err(
            "UTF-16 text without a byte-order mark is not supported yet. Convert a copy to UTF-8 before opening it.".into(),
        );
    }
    if guessed == encoding_rs::REPLACEMENT || guessed == encoding_rs::X_USER_DEFINED {
        return Err(binary_error());
    }

    let mut guessed = guessed;
    let mut text = guessed
        .decode_without_bom_handling_and_without_replacement(bytes)
        .ok_or_else(binary_error)?;
    // A Western European file can be guessed as Windows-1250 when every
    // non-ASCII byte happens to map to the same character in both encodings
    // (á, é, í and ú do; ã does not). Prefer the Western default in that case,
    // so an edit that later introduces ã is encoded as the reader expects.
    if guessed == encoding_rs::WINDOWS_1250
        && let Some(alternative) =
            encoding_rs::WINDOWS_1252.decode_without_bom_handling_and_without_replacement(bytes)
        && alternative == text
    {
        guessed = encoding_rs::WINDOWS_1252;
        text = alternative;
    }
    validate_text(&text)?;
    let encoded = encode_without_bom(&text, guessed).map_err(|_| binary_error())?;
    if encoded != bytes {
        // A guessed encoding that cannot reproduce the input may be a
        // multi-byte file with one malformed sequence. Opening it would make
        // the next Save able to change bytes the reader never edited.
        return Err(binary_error());
    }

    Ok(DecodedText {
        text: text.into_owned(),
        encoding: guessed,
        had_bom: false,
    })
}

fn push_bom(encoding: &'static Encoding, out: &mut Vec<u8>) {
    if encoding == UTF_8 {
        out.extend_from_slice(&[0xef, 0xbb, 0xbf]);
    } else if encoding == UTF_16LE {
        out.extend_from_slice(&[0xff, 0xfe]);
    } else if encoding == UTF_16BE {
        out.extend_from_slice(&[0xfe, 0xff]);
    }
}

fn append_encoded(
    text: &str,
    encoding: &'static Encoding,
    out: &mut Vec<u8>,
) -> Result<(), EncodeError> {
    if encoding == UTF_8 {
        out.extend_from_slice(text.as_bytes());
        return Ok(());
    }
    if encoding == UTF_16LE || encoding == UTF_16BE {
        // encoding_rs has no UTF-16 encoder: `encode` would apply the output
        // encoding rule and produce UTF-8. Encode the code units explicitly.
        for unit in text.encode_utf16() {
            if encoding == UTF_16LE {
                out.extend_from_slice(&unit.to_le_bytes());
            } else {
                out.extend_from_slice(&unit.to_be_bytes());
            }
        }
        return Ok(());
    }
    let (body, _, unmappable) = encoding.encode(text);
    if unmappable {
        return Err(EncodeError::Unmappable);
    }
    out.extend_from_slice(&body);
    Ok(())
}

fn encode_without_bom(text: &str, encoding: &'static Encoding) -> Result<Vec<u8>, EncodeError> {
    let mut out = Vec::new();
    append_encoded(text, encoding, &mut out)?;
    Ok(out)
}

/// Encode editor text with its document's BOM and line ending.
///
/// The editor always holds `\n`; the file's original `\r\n` is restored before
/// the bytes are encoded. UTF-16 always gets a BOM because a BOM-less UTF-16
/// file is not opened by this application in the first place.
pub fn encode_body(
    text: &str,
    encoding: &'static Encoding,
    had_bom: bool,
    line_ending: &str,
) -> Result<Vec<u8>, EncodeError> {
    if encoding == encoding_rs::X_USER_DEFINED {
        return Err(EncodeError::UnsuitableEncoding);
    }
    let normalized;
    let body = if line_ending == "\r\n" {
        normalized = text.replace('\n', "\r\n");
        normalized.as_str()
    } else {
        text
    };
    let mut out = Vec::new();
    if had_bom || encoding == UTF_16LE || encoding == UTF_16BE {
        push_bom(encoding, &mut out);
    }
    append_encoded(body, encoding, &mut out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PORTUGUESE: &[u8] =
        b"Tese apresentada ao Instituto de F\xedsica da Universidade de Bras\xedlia para obten\xe7\xe3o do t\xedtulo de Doutor em F\xedsica.";

    fn decoded(bytes: &[u8]) -> DecodedText {
        decode(bytes).unwrap()
    }

    #[test]
    fn windows_1252_opens_and_round_trips_exactly() {
        let document = decoded(PORTUGUESE);
        assert_eq!(document.encoding, encoding_rs::WINDOWS_1252);
        assert!(document.text.contains("Física"));
        assert!(document.text.contains("Brasília"));
        assert!(document.text.contains("obtenção"));
        assert!(!document.had_bom);
        assert_eq!(
            encode_body(&document.text, document.encoding, document.had_bom, "\n").unwrap(),
            PORTUGUESE
        );
    }

    #[test]
    fn utf16_le_and_be_with_bom_round_trip_and_keep_the_bom() {
        for encoding in [UTF_16LE, UTF_16BE] {
            let bytes = encode_body("Física\nAção", encoding, true, "\r\n").unwrap();
            assert_eq!(
                &bytes[..2],
                if encoding == UTF_16LE {
                    &[0xff, 0xfe]
                } else {
                    &[0xfe, 0xff]
                }
            );
            let document = decoded(&bytes);
            assert_eq!(document.encoding, encoding);
            assert!(document.had_bom);
            let normalized = document.text.replace("\r\n", "\n");
            assert_eq!(normalized, "Física\nAção");
            assert_eq!(
                encode_body(&normalized, encoding, true, "\r\n").unwrap(),
                bytes
            );
        }
    }

    #[test]
    fn utf8_bom_is_kept_and_plain_utf8_is_not_given_one() {
        let bom = b"\xef\xbb\xbf# T\xc3\xadtulo";
        let document = decoded(bom);
        assert_eq!(document.encoding, UTF_8);
        assert!(document.had_bom);
        assert_eq!(document.text, "# Título");
        assert_eq!(
            encode_body(&document.text, document.encoding, true, "\n").unwrap(),
            bom
        );

        let plain = b"# T\xc3\xadtulo";
        let document = decoded(plain);
        assert!(!document.had_bom);
        assert_eq!(
            encode_body(&document.text, document.encoding, false, "\n").unwrap(),
            plain
        );
    }

    #[test]
    fn western_text_is_not_left_in_a_central_european_encoding() {
        // These are the actual non-ASCII bytes of the reported bibliography's
        // header. cp1250 and cp1252 happen to agree on all of them, so a
        // detector may answer cp1250; the file is Portuguese and must be saved
        // as the Western encoding before a new ã can be typed.
        let bytes =
            b"%% $date: s\xe1bado, abril 14, 2007\n%% D\xe4weritz, L.\n%% An\xe1lise Num\xe9rica";
        let document = decoded(bytes);
        assert_eq!(document.encoding, encoding_rs::WINDOWS_1252);
        assert!(document.text.contains("sábado"));
        assert!(document.text.contains("Análise Numérica"));
        assert_eq!(
            encode_body(&document.text, document.encoding, false, "\n").unwrap(),
            bytes
        );
    }

    #[test]
    fn refuses_utf32_before_nul_classification() {
        for bytes in [b"\xff\xfe\0\0h\0\0\0".as_slice(), b"\0\0\xfe\xff\0\0\0h"] {
            let error = decode(bytes).unwrap_err();
            assert!(error.contains("UTF-32"), "{error}");
            assert!(!error.contains("binary/non-text"), "{error}");
        }
    }

    #[test]
    fn refuses_binary_signatures_and_controls() {
        for bytes in [
            b"%PDF-1.7\nplain-looking payload".as_slice(),
            b" \n%PDF-1.4\nobject",
            b"GIF89a123456789",
            b"PK\x03\x04document.xml",
            b"\x89PNG\r\n\x1a\n",
            b"RIFF1234WEBPpayload",
            b"\xff\xd8\xffimage",
            b"text\0with a NUL",
            b"bad\x1bcontrol",
            b"bad\x80\x81",
        ] {
            assert!(decode(bytes).is_err(), "{bytes:?}");
        }
    }

    #[test]
    fn accepts_utf8_unicode_whitespace_and_signature_like_prose() {
        for text in [
            "",
            "plain\ttext\r\n\u{c}page\n",
            "ação 日本語 😀",
            "A PDF begins with %PDF-1.7",
            "```\n%PDF-1.7\n```",
            "MZ is a word",
            "PK is text",
        ] {
            assert_eq!(decoded(text.as_bytes()).text, text);
        }
    }

    #[test]
    fn unmappable_text_is_refused_without_changing_bytes() {
        let error =
            encode_body("caf\u{1f600}", encoding_rs::WINDOWS_1252, false, "\n").unwrap_err();
        assert_eq!(error, EncodeError::Unmappable);
    }

    #[test]
    fn unknown_labels_are_refused() {
        assert!(for_label("not-an-encoding").is_err());
        assert!(for_label("replacement").is_err());
        assert_eq!(for_label("latin1").unwrap(), encoding_rs::WINDOWS_1252);
    }
}
