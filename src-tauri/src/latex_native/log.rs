//! What a compiler's log actually says.
//!
//! TeX has no structured diagnostic channel: an error, a warning and a
//! font-substitution note are all lines of one transcript. The rules here are
//! deliberately conservative — a line becomes a diagnostic only when the
//! compiler's own wording identifies it, so an ordinary sentence containing
//! "error" never becomes a problem the reader is told to fix.
//!
//! `-file-line-error` is passed to every engine, which gives errors a precise
//! `file:line: message` shape. Warnings keep the classic TeX wording and are
//! attributed to the file the log is currently reading.

use std::collections::BTreeMap;

/// The most diagnostics a result carries.
///
/// The preview list stops being usable long before this, and a runaway package
/// can otherwise make one compile allocate unboundedly. The remainder is
/// reported as truncated, with the full log still available.
pub const MAX_DIAGNOSTICS: usize = 200;

/// The bytes of log kept. TeX logs can reach several megabytes; the tail holds
/// the failure, while the head is package noise.
pub const MAX_LOG: usize = 400_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawDiagnostic {
    pub file: String,
    pub line: u32,
    pub severity: Severity,
    pub message: String,
    pub code: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warning => "warning",
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ParsedLog {
    pub diagnostics: Vec<RawDiagnostic>,
    pub truncated: bool,
    /// The compiler asked for another pass.
    pub rerun: bool,
    /// The bibliography tool should run after this pass.
    pub bibliography: Bibliography,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Bibliography {
    #[default]
    None,
    Bibtex,
    Biber,
}

/// The tail of `text`, cut on a line boundary, and whether it was cut.
pub fn bounded_log(text: &str) -> (String, bool) {
    if text.len() <= MAX_LOG {
        return (text.to_string(), false);
    }
    let mut start = text.len() - MAX_LOG;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let start = text[start..]
        .find('\n')
        .map(|at| start + at + 1)
        .unwrap_or(start);
    (
        format!("Earlier compiler output was omitted.\n\n{}", &text[start..]),
        true,
    )
}

/// Whether a line opens a file group in the transcript (`(./main.tex`).
///
/// TeX's log is a tree of parenthesised file opens, but the parentheses are not
/// reliable — a package can print one. Only a `(` immediately followed by a
/// path-like token naming a source counts, which is the shape the distribution's
/// own classes produce.
fn opened_file(line: &str) -> Option<String> {
    let at = line.find('(')?;
    let rest = line[at + 1..].trim_start();
    let mut end = 0;
    for (index, ch) in rest.char_indices() {
        if ch.is_whitespace() || ch == ')' || ch == '(' {
            break;
        }
        end = index + ch.len_utf8();
    }
    let token = &rest[..end];
    let name = token.trim_matches('"');
    let lower = name.to_ascii_lowercase();
    if !(lower.ends_with(".tex")
        || lower.ends_with(".sty")
        || lower.ends_with(".cls")
        || lower.ends_with(".bib")
        || lower.ends_with(".aux"))
    {
        return None;
    }
    Some(normalise(name))
}

/// A log path in the snapshot's forward-slash form, without a leading `./`.
fn normalise(value: &str) -> String {
    value
        .replace('\\', "/")
        .trim_start_matches("./")
        .to_string()
}

/// The source map's name for a log path, when the snapshot holds it.
fn source_name(value: &str, sources: &BTreeMap<String, String>) -> String {
    let name = normalise(value);
    if sources.contains_key(&name) {
        return name;
    }
    for key in sources.keys() {
        if name.ends_with(&format!("/{key}")) {
            return key.clone();
        }
    }
    name
}

fn parse_line_number(value: &str) -> u32 {
    value.trim().parse().unwrap_or(0)
}

/// The first `l.<n>` after an old-style error.
fn old_style_line(lines: &[&str], from: usize) -> u32 {
    for line in lines.iter().skip(from).take(8) {
        if let Some(rest) = line.trim_start().strip_prefix("l.") {
            let digits: String = rest.chars().take_while(|ch| ch.is_ascii_digit()).collect();
            if !digits.is_empty() {
                return parse_line_number(&digits);
            }
        }
    }
    0
}

/// A warning's line number: `on input line 12.` on the same or next line.
fn warning_line(lines: &[&str], from: usize) -> u32 {
    for line in lines.iter().skip(from).take(3) {
        if let Some(at) = line.find("on input line ") {
            let digits: String = line[at + "on input line ".len()..]
                .chars()
                .take_while(|ch| ch.is_ascii_digit())
                .collect();
            if !digits.is_empty() {
                return parse_line_number(&digits);
            }
        }
    }
    0
}

#[allow(clippy::too_many_arguments)] // one diagnostic row, every field named at the call site
fn push(
    out: &mut Vec<RawDiagnostic>,
    seen: &mut std::collections::HashSet<(String, u32, String)>,
    truncated: &mut bool,
    file: &str,
    line: u32,
    severity: Severity,
    code: &str,
    message: String,
) {
    let message = message.trim().to_string();
    if message.is_empty() {
        return;
    }
    if !seen.insert((file.to_string(), line, message.clone())) {
        return;
    }
    if out.len() >= MAX_DIAGNOSTICS {
        *truncated = true;
        return;
    }
    out.push(RawDiagnostic {
        file: file.to_string(),
        line,
        severity,
        message,
        code: code.to_string(),
    });
}

/// Parse one compiler transcript.
pub fn parse(log: &str, sources: &BTreeMap<String, String>) -> ParsedLog {
    let mut parsed = ParsedLog::default();
    let mut seen = std::collections::HashSet::new();
    let mut current = String::new();
    let lines: Vec<&str> = log.lines().collect();

    for (index, raw) in lines.iter().enumerate() {
        let line = raw.trim_end_matches('\r');
        let trimmed = line.trim_start();

        if let Some(file) = opened_file(line) {
            current = source_name(&file, sources);
        }

        // `-file-line-error`: `./chapter.tex:12: Undefined control sequence.`
        if let Some((file, number, message)) = file_line_error(trimmed) {
            let name = source_name(&file, sources);
            let severity = if message.starts_with("warning") {
                Severity::Warning
            } else {
                Severity::Error
            };
            push(
                &mut parsed.diagnostics,
                &mut seen,
                &mut parsed.truncated,
                &name,
                number,
                severity,
                "compile",
                strip_severity_prefix(&message).to_string(),
            );
            continue;
        }

        // The classic error shape, with the line on a following `l.N`.
        if let Some(message) = trimmed.strip_prefix("! ") {
            if message.starts_with("==> Fatal error occurred") {
                continue;
            }
            push(
                &mut parsed.diagnostics,
                &mut seen,
                &mut parsed.truncated,
                &current,
                old_style_line(&lines, index + 1),
                Severity::Error,
                "compile",
                message.to_string(),
            );
            continue;
        }

        // `LaTeX Warning:`, `Package xyz Warning:` and `Class xyz Warning:`.
        let warning = ["LaTeX Warning: ", "LaTeX Font Warning: "]
            .iter()
            .find_map(|prefix| trimmed.strip_prefix(prefix))
            .or_else(|| {
                let rest = trimmed.strip_prefix("Package ")?;
                let (_, tail) = rest.split_once(" Warning: ")?;
                Some(tail)
            })
            .or_else(|| {
                let rest = trimmed.strip_prefix("Class ")?;
                let (_, tail) = rest.split_once(" Warning: ")?;
                Some(tail)
            });
        if let Some(message) = warning {
            push(
                &mut parsed.diagnostics,
                &mut seen,
                &mut parsed.truncated,
                &current,
                warning_line(&lines, index),
                Severity::Warning,
                "warning",
                message.to_string(),
            );
            continue;
        }

        // Boxes and missing glyphs are warnings too; they are the categories
        // readers most often need and the ones a coarse severity filter loses.
        if let Some((line_number, message)) = box_warning(trimmed) {
            push(
                &mut parsed.diagnostics,
                &mut seen,
                &mut parsed.truncated,
                &current,
                line_number,
                Severity::Warning,
                "box",
                message,
            );
            continue;
        }
        if let Some(message) = trimmed.strip_prefix("Missing character: ") {
            let line_number = warning_line(&lines, index);
            push(
                &mut parsed.diagnostics,
                &mut seen,
                &mut parsed.truncated,
                &current,
                line_number,
                Severity::Warning,
                "font",
                format!("Missing character: {message}"),
            );
        }
    }

    parsed.rerun = log.contains("Rerun to get")
        || log.contains("Label(s) may have changed")
        || log.contains("Please rerun LaTeX")
        || log.contains("Please (re)run Biber")
        || log.contains("rerunfilecheck");
    parsed.bibliography = bibliography_needed(log);
    parsed
}

fn strip_severity_prefix(message: &str) -> &str {
    message
        .strip_prefix("error: ")
        .or_else(|| message.strip_prefix("warning: "))
        .unwrap_or(message)
}

fn file_line_error(line: &str) -> Option<(String, u32, String)> {
    // Windows paths contain a colon, so try each colon from the left and accept
    // the first one followed by digits and `: `.
    for (at, _) in line.match_indices(':') {
        let rest = &line[at + 1..];
        let digits: String = rest.chars().take_while(|ch| ch.is_ascii_digit()).collect();
        if digits.is_empty() {
            continue;
        }
        let after = &rest[digits.len()..];
        let Some(message) = after.strip_prefix(": ") else {
            continue;
        };
        let file = &line[..at];
        if file.is_empty() || message.is_empty() {
            continue;
        }
        let lower = file.to_ascii_lowercase();
        if !(lower.ends_with(".tex") || lower.ends_with(".sty") || lower.ends_with(".cls")) {
            continue;
        }
        return Some((
            file.to_string(),
            parse_line_number(&digits),
            message.to_string(),
        ));
    }
    None
}

fn box_warning(line: &str) -> Option<(u32, String)> {
    let kind = if line.starts_with("Overfull \\") {
        "Overfull"
    } else if line.starts_with("Underfull \\") {
        "Underfull"
    } else {
        return None;
    };
    let at = line.find(" at line")?;
    let rest = &line[at + " at line".len()..];
    let rest = rest.strip_prefix('s').unwrap_or(rest).trim_start();
    let digits: String = rest.chars().take_while(|ch| ch.is_ascii_digit()).collect();
    let line_number = parse_line_number(&digits);
    // The useful half is the box: `Overfull \hbox (3.2pt too wide) in paragraph`.
    let head = line
        .split(" at line")
        .next()
        .unwrap_or(line)
        .trim_end_matches('.');
    Some((line_number, format!("{kind}: {head}")))
}

fn bibliography_needed(log: &str) -> Bibliography {
    if log.contains("Please (re)run Biber") || log.contains("biblatex") && log.contains("biber") {
        return Bibliography::Biber;
    }
    if log.contains("Please (re)run BibTeX")
        || log.contains("There were undefined references")
        || log.contains("Citation")
    {
        return Bibliography::Bibtex;
    }
    Bibliography::None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sources() -> BTreeMap<String, String> {
        let mut map = BTreeMap::new();
        map.insert("main.tex".into(), String::new());
        map.insert("chapters/intro.tex".into(), String::new());
        map
    }

    #[test]
    fn a_file_line_error_names_its_file_and_line() {
        let log = "./main.tex:12: Undefined control sequence.\n";
        let parsed = parse(log, &sources());
        assert_eq!(parsed.diagnostics.len(), 1);
        assert_eq!(parsed.diagnostics[0].file, "main.tex");
        assert_eq!(parsed.diagnostics[0].line, 12);
        assert_eq!(parsed.diagnostics[0].severity, Severity::Error);
    }

    #[test]
    fn a_windows_path_keeps_its_drive_colon() {
        let log = "C:\\work\\main.tex:7: Missing $ inserted.\n";
        let parsed = parse(log, &sources());
        assert_eq!(parsed.diagnostics[0].line, 7);
        assert_eq!(parsed.diagnostics[0].message, "Missing $ inserted.");
    }

    #[test]
    fn the_classic_error_shape_finds_the_line_below_it() {
        let log = "! Undefined control sequence.\nl.42 \\badcommand\n";
        let parsed = parse(log, &sources());
        assert_eq!(parsed.diagnostics[0].line, 42);
    }

    #[test]
    fn a_warning_is_a_warning_not_an_error() {
        let log = "LaTeX Warning: Citation `x' on page 1 undefined on input line 9.\n";
        let parsed = parse(log, &sources());
        assert_eq!(parsed.diagnostics.len(), 1);
        assert_eq!(parsed.diagnostics[0].severity, Severity::Warning);
        assert_eq!(parsed.diagnostics[0].line, 9);
    }

    #[test]
    fn package_warnings_are_kept() {
        let log = "Package hyperref Warning: Rerun to get outlines right\n";
        let parsed = parse(log, &sources());
        assert_eq!(parsed.diagnostics[0].severity, Severity::Warning);
        assert!(parsed.rerun);
    }

    #[test]
    fn overfull_and_underfull_boxes_are_warnings_with_lines() {
        let log = "Overfull \\hbox (3.2pt too wide) in paragraph at lines 4--5\n\
                   Underfull \\vbox (badness 10000) has occurred while \\output is active at line 9\n";
        let parsed = parse(log, &sources());
        assert_eq!(parsed.diagnostics.len(), 2);
        assert_eq!(parsed.diagnostics[0].line, 4);
        assert_eq!(parsed.diagnostics[1].line, 9);
        assert!(parsed.diagnostics[0].message.starts_with("Overfull"));
    }

    #[test]
    fn a_file_on_the_log_line_attributes_the_warning() {
        let log =
            "(./chapters/intro.tex\nLaTeX Warning: Reference `x' undefined on input line 3.\n)\n";
        let parsed = parse(log, &sources());
        assert_eq!(parsed.diagnostics[0].file, "chapters/intro.tex");
        assert_eq!(parsed.diagnostics[0].line, 3);
    }

    #[test]
    fn ordinary_prose_that_mentions_an_error_is_not_a_diagnostic() {
        let log = "This document discusses every error message in the module.\n";
        assert!(parse(log, &sources()).diagnostics.is_empty());
    }

    #[test]
    fn duplicates_collapse_but_distinct_lines_do_not() {
        let log = "LaTeX Warning: same on input line 1.\nLaTeX Warning: same on input line 1.\nLaTeX Warning: same on input line 2.\n";
        let parsed = parse(log, &sources());
        assert_eq!(parsed.diagnostics.len(), 2);
    }

    #[test]
    fn the_cap_is_reported_as_truncated() {
        let log: String = (1..=MAX_DIAGNOSTICS + 5)
            .map(|n| format!("LaTeX Warning: w{n} on input line {n}.\n"))
            .collect();
        let parsed = parse(&log, &sources());
        assert_eq!(parsed.diagnostics.len(), MAX_DIAGNOSTICS);
        assert!(parsed.truncated);
    }

    #[test]
    fn a_long_log_keeps_its_tail_and_says_so() {
        let log = format!("{}THE END", "x".repeat(MAX_LOG + 100));
        let (bounded, truncated) = bounded_log(&log);
        assert!(truncated);
        assert!(bounded.ends_with("THE END"));
    }

    #[test]
    fn a_citation_failure_asks_for_bibtex() {
        let parsed = parse("LaTeX Warning: Citation `a' undefined\n", &sources());
        assert_eq!(parsed.bibliography, Bibliography::Bibtex);
    }
}
