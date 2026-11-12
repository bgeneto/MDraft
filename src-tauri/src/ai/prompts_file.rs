//! The user-editable prompt file.
//!
//! The action prompts are Rust constants ([`super::prompt`]); this module turns
//! them into one Markdown file beside `settings.json` and reads the reader's
//! version back. Markdown rather than a second format is deliberate: the file is
//! an ordinary `.md` document, so the editor already highlights it, previews it,
//! spell-checks it, saves it, journals it for crash recovery and polls it for
//! external changes, with no new dependency and no fifth document kind.
//!
//! The format is one `## <section id>` heading per prompt, its body in a fence
//! long enough to hold it. Everything outside a section is ignored, so the title
//! and the instructions at the top are free prose.
//!
//! Overrides are **sparse**: a section the file does not contain keeps the
//! built-in prompt. That keeps a partial file valid, keeps an older file working
//! when a new action ships, and makes "reset" a plain rewrite of the file.
//!
//! Two things a section may not do: name a section that is not an action (a
//! typo would otherwise silently do nothing) and use a placeholder the action
//! cannot fill (which would ship literal braces to the model). Both are errors
//! that name the line, and a file with an error is never half-applied.

use std::collections::HashMap;

use crate::ai::naming;
use crate::ai::prompt::AiAction;

/// The file's name, as the reader sees it in an error message.
pub const FILE_NAME: &str = "ai-prompts.md";

/// A ceiling on the whole file. A prompt is a paragraph or two; anything this
/// large is a copied document, and reading it is not worth the bound.
const MAX_FILE_BYTES: usize = 128 * 1024;

/// A ceiling on one prompt. The assembled system message is checked again:
/// this only stops one section from swallowing the model's whole window.
const MAX_PROMPT_CHARS: usize = 8_192;

/// The value of `{…}` placeholders the app substitutes.
const PLACEHOLDERS: &[&str] = &[
    "markup",
    "syntax_rule",
    "tone",
    "target_language",
    "target_markup",
    "target_syntax_rule",
];

/// The prompts a file may replace. A missing section means "use the built-in".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Overrides {
    prompts: HashMap<String, String>,
}

impl Overrides {
    /// The shared preamble, when the reader replaced it.
    pub fn preamble(&self) -> Option<&str> {
        self.prompts.get("preamble").map(String::as_str)
    }

    /// This action's prompt, when the reader replaced it.
    pub fn action(&self, action: AiAction) -> Option<&str> {
        self.prompts.get(action.id()).map(String::as_str)
    }

    /// The filename prompt, when the reader replaced it.
    pub fn suggest_file_name(&self) -> Option<&str> {
        self.prompts.get("suggestFileName").map(String::as_str)
    }

    /// How many sections are present, including ones identical to the built-in
    /// text (a reader may have looked and saved without changing anything).
    ///
    /// Test-only: what the panel reports is `customised()`, and a section count
    /// is `sections().len()`.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.prompts.len()
    }

    /// How many sections differ from the built-in prompt. This is what the
    /// Preferences note reports, so an untouched generated file reads as
    /// "built-in" rather than "16 customised".
    pub fn customised(&self) -> usize {
        self.prompts
            .iter()
            .filter(|(id, text)| builtin(id).is_none_or(|default| default != text.as_str()))
            .count()
    }

    fn insert(&mut self, id: &str, text: String) {
        self.prompts.insert(id.to_string(), text);
    }
}

/// Every section the file can contain, in the order the generator writes them.
pub fn sections() -> Vec<&'static str> {
    let mut ids = vec!["preamble"];
    ids.extend(AiAction::ALL.iter().map(|action| action.id()));
    ids.push("suggestFileName");
    ids
}

/// The built-in text for one section id.
fn builtin(id: &str) -> Option<&'static str> {
    if id == "preamble" {
        return Some(crate::ai::prompt::builtin_preamble());
    }
    if id == "suggestFileName" {
        return Some(naming::SYSTEM);
    }
    AiAction::from_id(id).map(crate::ai::prompt::builtin_action)
}

/// The placeholders a section may use. Anything else is an error, because the
/// render step would otherwise leave the braces visible to the model.
fn allowed_placeholders(id: &str) -> &'static [&'static str] {
    match id {
        "preamble" => &["markup", "syntax_rule"],
        // The only action whose prompt never mentions the document syntax.
        "suggestFileName" => &[],
        "tone" => &["markup", "syntax_rule", "tone"],
        "translate" => &["markup", "syntax_rule", "target_language"],
        "convert" => &[
            "markup",
            "syntax_rule",
            "target_markup",
            "target_syntax_rule",
        ],
        _ => &["markup", "syntax_rule"],
    }
}

/// `{name}` placeholders in a prompt, in the order they appear.
///
/// Only lower-case words count: a prompt that shows code such as `fn f() { }`
/// or `{x + 1}` must not be read as a placeholder.
fn placeholders(prompt: &str) -> Vec<String> {
    let mut found = Vec::new();
    let bytes = prompt.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'{' {
            index += 1;
            continue;
        }
        let start = index + 1;
        let mut end = start;
        while end < bytes.len() && (bytes[end].is_ascii_lowercase() || bytes[end] == b'_') {
            end += 1;
        }
        if end > start && end < bytes.len() && bytes[end] == b'}' {
            found.push(prompt[start..end].to_string());
            index = end + 1;
        } else {
            index += 1;
        }
    }
    found
}

/// Read one section body and validate it. `line` is where the body started.
fn validate(id: &str, body: &str, line: usize) -> Result<(), String> {
    if body.chars().count() > MAX_PROMPT_CHARS {
        return Err(format!(
            "{FILE_NAME} line {line}: `{id}` is longer than {MAX_PROMPT_CHARS} characters"
        ));
    }
    let allowed = allowed_placeholders(id);
    let list = if allowed.is_empty() {
        "this action takes no placeholders".to_string()
    } else {
        format!(
            "allowed here: {}",
            allowed
                .iter()
                .map(|name| format!("{{{name}}}"))
                .collect::<Vec<_>>()
                .join(" ")
        )
    };
    for placeholder in placeholders(body) {
        if !PLACEHOLDERS.contains(&placeholder.as_str()) {
            return Err(format!(
                "{FILE_NAME} line {line}: `{id}` uses {{{placeholder}}}, which is not a placeholder. {list}"
            ));
        }
        if !allowed.contains(&placeholder.as_str()) {
            return Err(format!(
                "{FILE_NAME} line {line}: `{id}` cannot fill {{{placeholder}}}: {list}"
            ));
        }
    }
    // The preamble is the only section that has to carry the markup contract:
    // without it the model is not told which syntax the answer must use.
    if id == "preamble" {
        for required in ["{markup}", "{syntax_rule}"] {
            if !body.contains(required) {
                return Err(format!(
                    "{FILE_NAME} line {line}: the preamble must keep {required}, because it is how the model learns the document's syntax"
                ));
            }
        }
    }
    Ok(())
}

/// A closing fence line: three or more of the same character, nothing else.
fn fence(line: &str) -> Option<(char, usize)> {
    let trimmed = line.trim_end();
    let character = trimmed.chars().next()?;
    if character != '`' && character != '~' {
        return None;
    }
    let length = trimmed.chars().take_while(|c| *c == character).count();
    if length < 3 || length != trimmed.chars().count() {
        return None;
    }
    Some((character, length))
}

/// An opening fence: the same rule, plus the info string the generator writes
/// (````text`). A line inside the body may also start with a fence and an info
/// string, which is why only [`fence`] closes a block.
fn opening_fence(line: &str) -> Option<(char, usize)> {
    let trimmed = line.trim();
    let character = trimmed.chars().next()?;
    if character != '`' && character != '~' {
        return None;
    }
    let length = trimmed.chars().take_while(|c| *c == character).count();
    if length < 3 {
        return None;
    }
    if trimmed[length..].contains(character) {
        return None;
    }
    Some((character, length))
}

/// Parse the file. An error always names the line; a file with any error is
/// refused whole rather than applied in part.
pub fn parse(raw: &str) -> Result<Overrides, String> {
    if raw.len() > MAX_FILE_BYTES {
        return Err(format!(
            "{FILE_NAME} is larger than {} KB. Keep the prompts as prose; a whole document does not belong here.",
            MAX_FILE_BYTES / 1024
        ));
    }
    let text = raw
        .strip_prefix('\u{feff}')
        .unwrap_or(raw)
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let lines: Vec<&str> = text.split('\n').collect();

    let mut overrides = Overrides::default();
    let mut index = 0;
    while index < lines.len() {
        let Some(heading) = lines[index].strip_prefix("## ") else {
            index += 1;
            continue;
        };
        let heading_line = index + 1;
        let id = heading.trim();
        if id.is_empty() {
            return Err(format!(
                "{FILE_NAME} line {heading_line}: a section heading needs a name"
            ));
        }
        if !sections().contains(&id) {
            return Err(format!(
                "{FILE_NAME} line {heading_line}: unknown action `{id}`. Use one of: {}",
                sections().join(", ")
            ));
        }
        if overrides.prompts.contains_key(id) {
            return Err(format!(
                "{FILE_NAME} line {heading_line}: `{id}` appears more than once"
            ));
        }
        index += 1;
        while index < lines.len() && lines[index].trim().is_empty() {
            index += 1;
        }
        let Some((character, length)) = lines.get(index).and_then(|line| opening_fence(line))
        else {
            return Err(format!(
                "{FILE_NAME} line {}: `{id}` needs its prompt in a fenced block (``` or ~~~) on the lines below",
                index + 1
            ));
        };
        let body_start = index + 2;
        index += 1;
        let mut body: Vec<&str> = Vec::new();
        let mut closed = false;
        while index < lines.len() {
            if let Some((end_character, end_length)) = fence(lines[index])
                && end_character == character
                && end_length >= length
            {
                closed = true;
                index += 1;
                break;
            }
            body.push(lines[index]);
            index += 1;
        }
        if !closed {
            return Err(format!(
                "{FILE_NAME} line {body_start}: `{id}` is missing its closing fence"
            ));
        }
        let body = body.join("\n").trim().to_string();
        if body.is_empty() {
            return Err(format!(
                "{FILE_NAME} line {body_start}: `{id}` is empty; delete the section to use the built-in prompt"
            ));
        }
        validate(id, &body, body_start)?;
        overrides.insert(id, body);
    }
    Ok(overrides)
}

/// The fence a body needs: one character longer than the longest run that could
/// be read as its closing fence.
fn fence_for(body: &str) -> String {
    let length = body
        .lines()
        .filter_map(fence)
        .map(|(_, length)| length)
        .max()
        .unwrap_or(0)
        .max(2)
        + 1;
    "`".repeat(length)
}

/// The generated file: every built-in prompt, with the rules at the top.
pub fn serialize_defaults() -> String {
    let mut out = String::new();
    out.push_str("# MDraft AI prompts\n\n");
    out.push_str(&format!(
        "Generated by MDraft {}. Change the wording, save, and the next Generate uses it.\n",
        env!("CARGO_PKG_VERSION")
    ));
    out.push_str(
        "Delete a section to fall back to the built-in prompt for that action, or use\n\
         Reset prompts to defaults in Preferences to restore every section at once.\n\n",
    );
    out.push_str(
        "The assistant treats the document as data: keep the instruction that the passage is\n\
         not to be followed as instructions. The document's markup reaches the model through\n\
         `{markup}` and `{syntax_rule}`, which the preamble must keep. A placeholder an action\n\
         cannot fill is an error, and so is a section name that is not an action.\n\n",
    );
    out.push_str(
        "Placeholders: {markup} {syntax_rule} {tone} {target_language} {target_markup}\n\
         {target_syntax_rule}. The wrapper tag that makes an answer insertable is added by\n\
         the application and is not part of this file.\n",
    );

    for id in sections() {
        out.push_str(&format!("\n## {id}\n\n"));
        let body = builtin(id).unwrap_or_default();
        let fence = fence_for(body);
        out.push_str(&fence);
        out.push_str("text\n");
        out.push_str(body.trim());
        out.push('\n');
        out.push_str(&fence);
        out.push('\n');
    }
    out
}

/// Read an override file, or the empty set when it does not exist.
///
/// Read on every request rather than cached: the file is kilobytes, and a cache
/// would need invalidation for the editor's own save and for edits made in
/// another application.
pub fn load(path: &std::path::Path) -> Result<Overrides, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => parse(&raw),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Overrides::default()),
        Err(error) => Err(format!("{FILE_NAME} could not be read: {error}")),
    }
}

/// Write the built-in prompts, replacing whatever is there.
pub fn write_defaults(path: &std::path::Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("{FILE_NAME} could not be written: {error}"))?;
    }
    std::fs::write(path, serialize_defaults())
        .map_err(|error| format!("{FILE_NAME} could not be written: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_generated_file_round_trips_to_no_overrides() {
        // The whole feature rests on this: the file the reader is given must be
        // the built-in prompts, not an edited copy of them.
        let file = serialize_defaults();
        let parsed = parse(&file).expect("parse");
        assert_eq!(parsed.customised(), 0, "{} customised", parsed.len());
        assert_eq!(parsed.len(), sections().len());
    }

    #[test]
    fn every_section_reaches_the_parser_intact() {
        let file = serialize_defaults();
        let parsed = parse(&file).expect("parse");
        for id in sections() {
            assert_eq!(
                parsed.prompts.get(id).map(String::as_str),
                builtin(id),
                "{id} changed in the round trip"
            );
        }
    }

    #[test]
    fn a_partial_file_overrides_one_section() {
        let parsed = parse("## summarize\n\n```text\nWrite three words.\n```\n").expect("parse");
        assert_eq!(
            parsed.action(AiAction::Summarize),
            Some("Write three words.")
        );
        assert_eq!(parsed.action(AiAction::Improve), None);
        assert_eq!(parsed.customised(), 1);
    }

    #[test]
    fn an_empty_file_is_valid_and_changes_nothing() {
        let parsed = parse("# nothing here\n").expect("parse");
        assert_eq!(parsed, Overrides::default());
    }

    #[test]
    fn unknown_sections_are_refused_with_their_line() {
        let error = parse(
            "## preamble\n\n```\nx {markup} {syntax_rule}\n```\n\n## summarise\n\n```\nx\n```\n",
        )
        .expect_err("unknown section");
        assert!(error.contains("line 7"), "{error}");
        assert!(error.contains("unknown action `summarise`"), "{error}");
    }

    #[test]
    fn a_duplicate_section_is_refused() {
        let error = parse("## summarize\n\n```\na\n```\n\n## summarize\n\n```\nb\n```\n")
            .expect_err("duplicate");
        assert!(error.contains("appears more than once"), "{error}");
    }

    #[test]
    fn a_section_without_a_fence_is_refused() {
        let error = parse("## summarize\n\nWrite three words.\n").expect_err("no fence");
        assert!(
            error.contains("needs its prompt in a fenced block"),
            "{error}"
        );
    }

    #[test]
    fn an_unterminated_fence_is_refused() {
        let error = parse("## summarize\n\n```text\nWrite three words.\n").expect_err("unclosed");
        assert!(error.contains("missing its closing fence"), "{error}");
    }

    #[test]
    fn an_empty_section_is_refused() {
        let error = parse("## summarize\n\n```\n\n```\n").expect_err("empty");
        assert!(error.contains("is empty"), "{error}");
    }

    #[test]
    fn placeholders_are_checked_against_the_action() {
        let error =
            parse("## summarize\n\n```\nUse {tone}.\n```\n").expect_err("wrong placeholder");
        assert!(error.contains("cannot fill {tone}"), "{error}");
        let unknown =
            parse("## summarize\n\n```\nUse {target_lenght}.\n```\n").expect_err("unknown");
        assert!(unknown.contains("not a placeholder"), "{unknown}");
    }

    #[test]
    fn the_preamble_must_keep_the_markup_contract() {
        let error = parse("## preamble\n\n```\nYou are helpful.\n```\n").expect_err("no markup");
        assert!(error.contains("must keep {markup}"), "{error}");
        assert!(
            parse("## preamble\n\n```\nMarkup {markup}. {syntax_rule}\nBe brief.\n```\n").is_ok()
        );
    }

    #[test]
    fn a_brace_in_code_is_not_a_placeholder() {
        let parsed = parse("## improve\n\n```\nKeep `fn f() { }` and { x } intact.\n```\n")
            .expect("code braces");
        assert!(parsed.action(AiAction::Improve).is_some());
    }

    #[test]
    fn the_language_specific_placeholders_are_allowed_where_they_exist() {
        assert!(parse("## tone\n\n```\nIn a {tone} tone. {markup}\n```\n").is_ok());
        assert!(parse("## translate\n\n```\nInto {target_language}. {markup}\n```\n").is_ok());
        assert!(
            parse("## convert\n\n```\nInto {target_markup}. {target_syntax_rule}\n```\n").is_ok()
        );
        assert!(parse("## ask\n\n```\nAnswer in {markup}.\n```\n").is_ok());
    }

    #[test]
    fn the_filename_prompt_takes_no_placeholders() {
        let error = parse("## suggestFileName\n\n```\nName it for {markup}.\n```\n")
            .expect_err("no placeholders");
        assert!(error.contains("takes no placeholders"), "{error}");
    }

    #[test]
    fn crlf_and_a_bom_are_accepted() {
        let file = "\u{feff}## summarize\r\n\r\n```text\r\nWrite three words.\r\n```\r\n";
        let parsed = parse(file).expect("parse");
        assert_eq!(
            parsed.action(AiAction::Summarize),
            Some("Write three words.")
        );
    }

    #[test]
    fn tilde_fences_and_longer_fences_are_accepted() {
        assert!(
            parse("## summarize\n\n~~~\nWrite `three` words.\n~~~\n")
                .expect("tilde")
                .action(AiAction::Summarize)
                .is_some()
        );
        let parsed = parse("## improve\n\n````\n```\nThree words.\n```\n````\n").expect("long");
        assert_eq!(
            parsed.action(AiAction::Improve),
            Some("```\nThree words.\n```")
        );
    }

    #[test]
    fn a_body_that_is_only_a_fence_gets_a_longer_fence() {
        // A line of backticks inside the body would close the block early, so
        // the generator has to grow the fence. A fence with prose around it is
        // not a closing fence and needs no change.
        assert_eq!(fence_for("Use ``` fences."), "```");
        assert_eq!(fence_for("Write:\n```\ncode\n```"), "````");
        assert_eq!(fence_for("No code here."), "```");
        let file = format!(
            "## improve\n\n{}\nWrite:\n```\ncode\n```\n{}\n",
            fence_for("Write:\n```\ncode\n```"),
            fence_for("Write:\n```\ncode\n```")
        );
        assert_eq!(
            parse(&file).expect("parse").action(AiAction::Improve),
            Some("Write:\n```\ncode\n```")
        );
    }

    #[test]
    fn prose_outside_the_sections_is_ignored() {
        let file = "# Title\n\nSome instructions.\n\n## summarize\n\n```\nShort.\n```\n\nBye.\n";
        let parsed = parse(file).expect("parse");
        assert_eq!(parsed.len(), 1);
    }

    #[test]
    fn an_oversized_prompt_is_refused() {
        let body = "word ".repeat(MAX_PROMPT_CHARS);
        let error = parse(&format!("## summarize\n\n```\n{body}\n```\n")).expect_err("too long");
        assert!(error.contains("longer than 8192 characters"), "{error}");
    }

    #[test]
    fn an_oversized_file_is_refused_before_parsing() {
        let error = parse(&"#".repeat(MAX_FILE_BYTES + 1)).expect_err("too large");
        assert!(error.contains("larger than 128 KB"), "{error}");
    }

    #[test]
    fn a_prettier_formatted_file_still_parses() {
        // Format Document must not break the prompts: Prettier reflows the prose
        // around a section and leaves fenced code alone.
        let file = serialize_defaults().replace("## summarize\n\n", "## summarize\n\n\n");
        let parsed = parse(&file).expect("parse");
        assert_eq!(parsed.customised(), 0);
    }

    #[test]
    fn the_generated_file_names_every_action() {
        let file = serialize_defaults();
        for action in AiAction::ALL {
            assert!(
                file.contains(&format!("## {}", action.id())),
                "{}",
                action.id()
            );
        }
        assert!(file.contains("## preamble"));
        assert!(file.contains("## suggestFileName"));
    }
}
