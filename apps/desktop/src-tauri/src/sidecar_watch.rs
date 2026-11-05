// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A SIDECAR THAT DIES IS NEVER SILENT (2026-09-23).
//
// A stale sidecar refused `--permission-mode auto`, printed its usage to stderr
// and exited before its first line. The shell forwarded that stderr to an event
// nothing listened to, ignored the exit, kept the dead child in its slot and
// answered `start_session` with `ok`: the window sent a turn into a closed
// pipe, the claim heartbeat kept the conversation away from the server, and the
// turn hung with no error anywhere. A release build logged nothing at all.
//
// This module is the pure half of the fix, so it is testable without a child:
//
// - `SidecarWatch` follows one child's output: whether it said `boot`, and the
//   last lines it wrote to stderr (already redacted by the caller).
// - `SidecarExit` is what an exit is reported as, to the start that is waiting
//   for the boot line (`boot_settled`) or to the window (`SIDECAR_EXITED_EVENT`)
//   for a session that was running.
// - `SidecarLog` is the file the sidecar's stderr goes to, in the app's log
//   directory (`~/Library/Logs/sh.liaison.desktop/sidecar.log` on
//   macOS), so support has something to read after the fact.

/// The build guard against a stale sidecar (`build.rs` runs it), compiled
/// into the crate for its tests only. Declared here rather than in `main.rs`,
/// whose tests read that file up to its first `cfg(test)`.
#[cfg(test)]
#[path = "../sidecar_freshness.rs"]
mod sidecar_freshness;

use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// The Tauri event a RUNNING session's unexpected exit reaches the window on.
pub const SIDECAR_EXITED_EVENT: &str = "sidecar-exited";

/// The `start_session` refusal for a sidecar that exited before its `boot`
/// line. The window reads the text after `": "` as the reason.
pub const SIDECAR_EXITED: &str = "SidecarExited";

/// How many stderr lines an exit report carries.
pub const STDERR_TAIL_LINES: usize = 20;

/// Longest stderr line kept, in characters. A minified stack frame can be
/// megabytes on one line.
pub const MAX_LINE_CHARS: usize = 2000;

/// How long a start waits for the child's `boot` line. The line is written
/// right after the arguments are parsed, so a healthy child answers in well
/// under a second; the margin is for a first launch extracting its CLI. A child
/// still silent after this is left running, and its exit is reported later.
pub const BOOT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// The log file's name inside the app's log directory.
pub const SIDECAR_LOG_FILE: &str = "sidecar.log";

/// When the log is rotated to `sidecar.log.1`.
pub const SIDECAR_LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// One sidecar exit, as the window is told about it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarExit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    /// Whether the child had written its `boot` line.
    pub booted: bool,
    /// One line a person can read: what the sidecar said last, or how it ended.
    pub reason: String,
    /// The last stderr lines, oldest first, secrets already struck out.
    pub stderr_tail: Vec<String>,
}

/// What the start waiting on a child learns first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootOutcome {
    Booted,
    Exited(SidecarExit),
}

/// Whether a stdout line is the sidecar's handshake.
pub fn is_boot_line(line: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|value| {
            value
                .get("type")
                .and_then(|kind| kind.as_str())
                .map(|kind| kind == "boot")
        })
        .unwrap_or(false)
}

fn clipped(line: &str) -> String {
    if line.chars().count() <= MAX_LINE_CHARS {
        return line.to_string();
    }
    let mut kept: String = line.chars().take(MAX_LINE_CHARS).collect();
    kept.push_str(" [...]");
    kept
}

/// The line an exit is summed up by. The sidecar prints its refusal and then
/// its usage, and Bun prints an error and then its stack, so the last line is
/// rarely the one that says what went wrong: usage lines and stack frames are
/// skipped, and the last line left is the reason.
pub fn exit_reason(tail: &[String], code: Option<i32>, signal: Option<i32>) -> String {
    let said = tail.iter().rev().find(|line| {
        let trimmed = line.trim();
        !trimmed.is_empty() && !trimmed.starts_with("usage:") && !trimmed.starts_with("at ")
    });
    if let Some(line) = said {
        return line.trim().to_string();
    }
    match (code, signal) {
        (_, Some(signal)) => format!("it was ended by signal {signal}"),
        (Some(code), None) => format!("it exited with code {code}"),
        (None, None) => "it exited".to_string(),
    }
}

/// One child's output, followed for as long as it runs.
#[derive(Debug, Default)]
pub struct SidecarWatch {
    booted: bool,
    tail: VecDeque<String>,
}

impl SidecarWatch {
    /// Answers true exactly once: on the line that is the child's `boot`.
    pub fn on_stdout(&mut self, line: &str) -> bool {
        if self.booted || !is_boot_line(line) {
            return false;
        }
        self.booted = true;
        true
    }

    /// Keeps a stderr line for the exit report. The caller has redacted it.
    pub fn on_stderr(&mut self, line: &str) {
        if self.tail.len() == STDERR_TAIL_LINES {
            self.tail.pop_front();
        }
        self.tail.push_back(clipped(line));
    }

    /// The report for the child's exit.
    pub fn exit(&self, code: Option<i32>, signal: Option<i32>) -> SidecarExit {
        let stderr_tail: Vec<String> = self.tail.iter().cloned().collect();
        SidecarExit {
            code,
            signal,
            booted: self.booted,
            reason: exit_reason(&stderr_tail, code, signal),
            stderr_tail,
        }
    }
}

/// What a start does with what it learned while waiting for `boot`. Nothing
/// learned (the wait timed out, or the child's stream closed without an exit)
/// is not a refusal: the child is running, and an exit later is reported on
/// `SIDECAR_EXITED_EVENT`.
pub fn boot_settled(outcome: Option<BootOutcome>) -> Result<(), String> {
    match outcome {
        Some(BootOutcome::Exited(exit)) => Err(format!("{SIDECAR_EXITED}: {}", exit.reason)),
        Some(BootOutcome::Booted) | None => Ok(()),
    }
}

/// Takes the slot's content when it is the one `is_it` recognises, and leaves
/// anything else where it is. A child that exited on its own is retired from
/// the session slot this way, and a child that was already replaced by a newer
/// start leaves the newer one alone.
pub fn take_if<T, F>(slot: &std::sync::Mutex<Option<T>>, is_it: F) -> Option<T>
where
    F: FnOnce(&T) -> bool,
{
    let mut held = slot.lock().ok()?;
    if held.as_ref().is_some_and(is_it) {
        held.take()
    } else {
        None
    }
}

/// `2026-09-23T17:40:00Z`, without a date crate.
pub fn utc_timestamp(now: SystemTime) -> String {
    let secs = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        (rem % 3_600) / 60,
        rem % 60
    )
}

/// The sidecar's log file. Every write is best effort: a log that cannot be
/// written must never be the reason a session does not run.
#[derive(Debug, Clone)]
pub struct SidecarLog {
    path: PathBuf,
}

impl SidecarLog {
    pub fn in_dir(dir: &Path) -> Self {
        SidecarLog {
            path: dir.join(SIDECAR_LOG_FILE),
        }
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// One line, stamped with the time and the child's pid. Rotates to
    /// `sidecar.log.1` once the file passes `SIDECAR_LOG_MAX_BYTES`.
    pub fn append(&self, pid: u32, text: &str) {
        let _ = self.try_append(pid, text);
    }

    fn try_append(&self, pid: u32, text: &str) -> std::io::Result<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        if fs::metadata(&self.path).is_ok_and(|meta| meta.len() > SIDECAR_LOG_MAX_BYTES) {
            let mut rotated = self.path.clone().into_os_string();
            rotated.push(".1");
            fs::rename(&self.path, PathBuf::from(rotated))?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        writeln!(
            file,
            "{} [pid {pid}] {}",
            utc_timestamp(SystemTime::now()),
            clipped(text.trim_end())
        )
    }
}

/// How an exit reads in the log.
pub fn exit_log_line(exit: &SidecarExit, expected: bool) -> String {
    let how = match (exit.code, exit.signal) {
        (_, Some(signal)) => format!("signal {signal}"),
        (Some(code), None) => format!("code {code}"),
        (None, None) => "no code".to_string(),
    };
    let when = if exit.booted {
        "after boot"
    } else {
        "BEFORE boot"
    };
    let why = if expected {
        "stopped by the shell"
    } else {
        "UNEXPECTED"
    };
    format!("exited ({how}, {when}, {why}): {}", exit.reason)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// The exact stderr of the stale sidecar the 2026-09-23 walk hit.
    fn stale_sidecar(watch: &mut SidecarWatch) {
        watch.on_stderr("unknown permission mode: auto");
        watch.on_stderr(
            "usage: liaison-sidecar --mcp-config <path> --model <model> [--cwd <path>] \
             [--permission-mode manual|edit|plan|bypass] [--resume <sessionId>]",
        );
    }

    #[test]
    fn a_child_that_exits_before_boot_refuses_the_start_with_what_it_said() {
        let mut watch = SidecarWatch::default();
        stale_sidecar(&mut watch);
        let exit = watch.exit(Some(2), None);
        assert!(!exit.booted);
        assert_eq!(exit.reason, "unknown permission mode: auto");
        assert_eq!(exit.stderr_tail.len(), 2);
        let refused = boot_settled(Some(BootOutcome::Exited(exit)));
        assert_eq!(
            refused,
            Err("SidecarExited: unknown permission mode: auto".to_string())
        );
    }

    #[test]
    fn a_child_that_booted_starts_and_a_silent_one_is_left_running() {
        assert_eq!(boot_settled(Some(BootOutcome::Booted)), Ok(()));
        assert_eq!(boot_settled(None), Ok(()));
    }

    #[test]
    fn only_the_boot_line_counts_as_boot_and_only_once() {
        let mut watch = SidecarWatch::default();
        assert!(!watch.on_stdout(r#"{"type":"ready"}"#));
        assert!(!watch.on_stdout("not json"));
        assert!(watch.on_stdout(r#"{"type":"boot","protocolVersion":2}"#));
        assert!(!watch.on_stdout(r#"{"type":"boot","protocolVersion":2}"#));
        assert!(watch.exit(Some(0), None).booted);
    }

    #[test]
    fn an_exit_with_nothing_on_stderr_still_says_how_it_ended() {
        let watch = SidecarWatch::default();
        assert_eq!(watch.exit(Some(1), None).reason, "it exited with code 1");
        assert_eq!(watch.exit(None, Some(9)).reason, "it was ended by signal 9");
        assert_eq!(watch.exit(None, None).reason, "it exited");
    }

    #[test]
    fn a_stack_trace_is_summed_up_by_its_error_not_its_last_frame() {
        let mut watch = SidecarWatch::default();
        watch.on_stderr("error: Native CLI binary for win32-x64 not found");
        watch.on_stderr("    at extract (/$bunfs/root/index.js:10:5)");
        watch.on_stderr("    at main (/$bunfs/root/index.js:99:1)");
        assert_eq!(
            watch.exit(Some(1), None).reason,
            "error: Native CLI binary for win32-x64 not found"
        );
    }

    #[test]
    fn the_tail_keeps_the_last_lines_and_clips_a_huge_one() {
        let mut watch = SidecarWatch::default();
        for index in 0..(STDERR_TAIL_LINES + 5) {
            watch.on_stderr(&format!("line {index}"));
        }
        watch.on_stderr(&"x".repeat(MAX_LINE_CHARS * 3));
        let exit = watch.exit(Some(1), None);
        assert_eq!(exit.stderr_tail.len(), STDERR_TAIL_LINES);
        assert_eq!(exit.stderr_tail[0], "line 6");
        assert!(exit.stderr_tail.last().unwrap().chars().count() < MAX_LINE_CHARS + 10);
    }

    #[test]
    fn an_exit_is_reported_to_the_window_in_the_shape_it_reads() {
        let mut watch = SidecarWatch::default();
        stale_sidecar(&mut watch);
        let payload = serde_json::to_value(watch.exit(Some(2), None)).unwrap();
        assert_eq!(payload["code"], 2);
        assert_eq!(payload["booted"], false);
        assert_eq!(payload["reason"], "unknown permission mode: auto");
        assert!(payload["stderrTail"].is_array());
    }

    #[test]
    fn a_child_that_exited_is_retired_from_the_slot_and_a_newer_one_is_not() {
        let slot = Mutex::new(Some(41u32));
        assert_eq!(take_if(&slot, |pid| *pid == 40), None);
        assert_eq!(*slot.lock().unwrap(), Some(41));
        assert_eq!(take_if(&slot, |pid| *pid == 41), Some(41));
        assert_eq!(*slot.lock().unwrap(), None);
        assert_eq!(take_if(&slot, |pid: &u32| *pid == 41), None);
    }

    #[test]
    fn the_log_is_written_where_support_looks_and_rotates() {
        let dir = std::env::temp_dir().join(format!(
            "liaison-sidecar-log-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let log = SidecarLog::in_dir(&dir);
        assert_eq!(log.path(), dir.join("sidecar.log"));
        log.append(7, "unknown permission mode: auto\n");
        let written = fs::read_to_string(log.path()).unwrap();
        assert!(written.ends_with("[pid 7] unknown permission mode: auto\n"));
        assert!(written.starts_with("20"));
        fs::write(log.path(), vec![b'x'; (SIDECAR_LOG_MAX_BYTES + 1) as usize]).unwrap();
        log.append(7, "after rotation");
        assert!(dir.join("sidecar.log.1").exists());
        assert!(fs::read_to_string(log.path())
            .unwrap()
            .contains("after rotation"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_timestamp_is_utc_iso() {
        let at = UNIX_EPOCH + std::time::Duration::from_secs(1_790_185_200);
        assert_eq!(utc_timestamp(at), "2026-09-23T17:40:00Z");
        assert_eq!(utc_timestamp(UNIX_EPOCH), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn the_log_line_says_whether_the_exit_was_expected() {
        let mut watch = SidecarWatch::default();
        stale_sidecar(&mut watch);
        let line = exit_log_line(&watch.exit(Some(2), None), false);
        assert_eq!(
            line,
            "exited (code 2, BEFORE boot, UNEXPECTED): unknown permission mode: auto"
        );
    }
}
