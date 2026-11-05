// SPDX-License-Identifier: FSL-1.1-ALv2
//
// DEBUG BUILDS ONLY. The whole module is behind `cfg(debug_assertions)` at its
// declaration in `main.rs`, so `report_webview_diagnostic` does not exist in a
// release binary and is not in the release handler list.
//
// Why it exists: the debug app is driven by an operator (or by the pipeline's
// orchestrator) over the real apps/web build, and the two failures that matter
// there are invisible from outside the window. A content security policy
// refusal makes the page quietly not load something, and a page error is a
// stack trace nobody sees without a devtools window. The overlay forwards both
// (`src/diagnostics.ts`), this prints one line each to the shell's stderr, and
// the walk reads a log.
//
// It is a SINK, not a channel: it takes a kind and a string and prints them.
// The page can already print whatever it likes into its own console, so a page
// that can call this gains nothing it did not have, which is why a plain
// string command is acceptable here where the session control commands are
// typed (see "The threat model" in `src/session/sidecar-ipc-contract.md`).

/// The prefix every forwarded line carries, so an operator can grep one stream.
pub const DIAGNOSTIC_PREFIX: &str = "liaison-webview";

/// How much of a message is printed. A stack trace or a serialized payload has
/// no upper bound, and a walk's log is read by a human.
pub const MESSAGE_LIMIT: usize = 2000;

/// One line, exactly as it reaches stderr.
///
/// The message is truncated to `MESSAGE_LIMIT` CHARACTERS (never bytes: a cut
/// inside a UTF-8 sequence would panic) and flattened, because a diagnostic
/// carrying a stack trace is many lines and one report must stay one line.
pub fn diagnostic_line(kind: &str, message: &str, source: Option<&str>) -> String {
    let flat: String = message
        .chars()
        .take(MESSAGE_LIMIT)
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    match source {
        Some(source) if !source.is_empty() => {
            format!("{DIAGNOSTIC_PREFIX} {kind}: {flat} ({source})")
        }
        _ => format!("{DIAGNOSTIC_PREFIX} {kind}: {flat}"),
    }
}

/// Prints one webview diagnostic to the shell's stderr.
#[tauri::command]
pub fn report_webview_diagnostic(kind: String, message: String, source: Option<String>) {
    eprintln!("{}", diagnostic_line(&kind, &message, source.as_deref()));
}

#[cfg(test)]
mod diagnostic_tests {
    use super::*;

    #[test]
    fn a_report_reads_as_one_prefixed_line_with_its_source() {
        assert_eq!(
            diagnostic_line(
                "csp",
                "font-src blocked https://fonts.gstatic.com/x.woff2",
                Some("app.js:42")
            ),
            "liaison-webview csp: font-src blocked https://fonts.gstatic.com/x.woff2 (app.js:42)"
        );
    }

    #[test]
    fn a_report_with_no_source_carries_no_empty_parentheses() {
        assert_eq!(
            diagnostic_line("console", "failed to fetch", None),
            "liaison-webview console: failed to fetch"
        );
        assert_eq!(
            diagnostic_line("console", "failed to fetch", Some("")),
            "liaison-webview console: failed to fetch"
        );
    }

    #[test]
    fn a_long_message_is_truncated_to_the_limit() {
        let line = diagnostic_line("error", &"x".repeat(MESSAGE_LIMIT + 500), None);
        let printed = line.trim_start_matches("liaison-webview error: ");
        assert_eq!(printed.chars().count(), MESSAGE_LIMIT);
    }

    /// A truncation on bytes would panic on a multi byte character sitting on
    /// the boundary, which would take the whole command down mid walk.
    #[test]
    fn a_multi_byte_message_is_truncated_without_panicking() {
        let line = diagnostic_line("error", &"e\u{301}".repeat(MESSAGE_LIMIT), None);
        let printed = line.trim_start_matches("liaison-webview error: ");
        assert_eq!(printed.chars().count(), MESSAGE_LIMIT);
    }

    /// One report is one line, or the walk's log cannot be read line by line.
    #[test]
    fn a_multi_line_message_is_flattened() {
        let line = diagnostic_line("error", "boom\n  at foo\r\n  at bar", None);
        assert!(!line.contains('\n'), "the line is {line}");
        assert!(line.contains("boom   at foo"), "the line is {line}");
    }
}
