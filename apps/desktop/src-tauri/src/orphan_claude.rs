//! "STOP IT" FOR AN ORPHANED CLAUDE (D33, batch-4 F3).
//!
//! An extension host restart leaves the old VS Code child running with parent
//! pid 1, still holding its session; so does `claude -p … &` from a closed
//! terminal. The node counts such an orphan as the session's driver and names
//! its pid; the session's header offers "Stop it". This is that click: the
//! shell signals the pid only when everything still ties it to the session:
//!
//! - the owner's Claude Code registry (`<config>/sessions/<pid>.json`, the
//!   CLI's own file) names this pid with this session id, or (W1-D3) the
//!   registry of one of the node's own per-session config dirs does (a
//!   runner killed outright leaves its claude registered there);
//! - the process table has that pid as a `claude` binary (its executable's
//!   name, not a script run by node or a shell) whose parent is launchd;
//! - it is the same process that wrote the entry: its start time
//!   (`ps -o lstart`, in UTC like the CLI's `procStart`) equals the entry's,
//!   or its arguments resume this session id; arguments naming another
//!   session id refuse it outright.
//!
//! Then SIGTERM, and SIGKILL after 5 s if the same process is still there.
//! The page passes the CLI's session id and the pid it was shown; neither is
//! trusted: a pid that fails any check is never signalled.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// How long the orphan has to exit on SIGTERM before SIGKILL.
pub const STOP_GRACE: Duration = Duration::from_secs(5);

/// What the CLI's registry entry says about one pid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryFacts {
    pub session_id: String,
    /// The process start the CLI recorded (`procStart`), when it did.
    pub proc_start: Option<String>,
}

/// What the process table says about one pid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessFacts {
    pub ppid: u32,
    /// `ps -o lstart=` under `LC_ALL=C TZ=UTC`.
    pub started: String,
    /// `ps -o comm=`: the executable's path.
    pub executable: String,
    pub args: String,
}

/// Why a pid is not signalled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    InvalidPid,
    NoRegistryEntry,
    SessionMismatch,
    NoProcess,
    NotClaude,
    NotOrphan,
    ArgsNameAnotherSession,
    NotSameProcess,
}

/// The owner's Claude config dir, as the node reads it (`CLAUDE_CONFIG_DIR`, else `~/.claude`).
pub fn owner_config_dir() -> Option<PathBuf> {
    if let Some(named) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        if !named.to_string_lossy().trim().is_empty() {
            return Some(PathBuf::from(named));
        }
    }
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".claude"))
}

/// Where the sidecar keeps each session's own Claude config dir
/// (`<app data>/session-config/<session id>`, session-config.ts
/// `sessionConfigDir`, config-isolation.ts `appDataDir`): the node's own runs
/// register there, never in the owner's config.
pub fn node_session_config_root() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let data = if cfg!(target_os = "macos") {
        home.join("Library").join("Application Support")
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local").join("share"))
    };
    Some(data.join("liaison-desktop").join("session-config"))
}

/// The registry entry naming this pid for this session: the owner's registry
/// first, then (W1-D3) the node's own per-session config dirs, where a runner
/// killed outright leaves its claude registered. An entry naming another
/// session is returned as it is (the check refuses it).
pub fn find_registry(
    owner: Option<&Path>,
    node_root: Option<&Path>,
    session_id: &str,
    pid: u32,
) -> Option<RegistryFacts> {
    let in_owner = owner.and_then(|dir| read_registry(dir, pid));
    if in_owner
        .as_ref()
        .is_some_and(|e| e.session_id == session_id)
    {
        return in_owner;
    }
    let from_node = node_root
        .and_then(|root| std::fs::read_dir(root).ok())
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|entry| read_registry(&entry.path(), pid))
        .find(|e| e.session_id == session_id);
    from_node.or(in_owner)
}

/// The registry entry of one pid, when the CLI wrote one naming that pid.
pub fn read_registry(config_dir: &Path, pid: u32) -> Option<RegistryFacts> {
    let file = config_dir.join("sessions").join(format!("{pid}.json"));
    let raw = std::fs::read_to_string(file).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    if value.get("pid")?.as_u64()? != u64::from(pid) {
        return None;
    }
    Some(RegistryFacts {
        session_id: value.get("sessionId")?.as_str()?.to_string(),
        proc_start: value
            .get("procStart")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}

fn ps_field(pid: u32, field: &str) -> Option<String> {
    let out = Command::new("/bin/ps")
        .args(["-ww", "-p", &pid.to_string(), "-o", &format!("{field}=")])
        .env("LC_ALL", "C")
        .env("TZ", "UTC")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// The process table's facts about one pid, or None when it is gone.
pub fn read_process(pid: u32) -> Option<ProcessFacts> {
    Some(ProcessFacts {
        ppid: ps_field(pid, "ppid")?.parse().ok()?,
        started: ps_field(pid, "lstart")?,
        executable: ps_field(pid, "comm")?,
        args: ps_field(pid, "args")?,
    })
}

fn normalized(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The session ids an argument list resumes or names (`--resume[= ]`, `-r`, `--session-id[= ]`).
fn named_sessions(args: &str) -> Vec<&str> {
    let words: Vec<&str> = args.split_whitespace().collect();
    let mut out = Vec::new();
    for (i, word) in words.iter().enumerate() {
        for flag in ["--resume=", "--session-id="] {
            if let Some(id) = word.strip_prefix(flag) {
                out.push(id);
            }
        }
        if matches!(*word, "--resume" | "-r" | "--session-id") {
            if let Some(id) = words.get(i + 1) {
                out.push(id);
            }
        }
    }
    out
}

fn is_session_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Whether the pid may be stopped as this session's orphan (the module's rules).
pub fn check_orphan(
    session_id: &str,
    pid: u32,
    entry: Option<&RegistryFacts>,
    process: Option<&ProcessFacts>,
) -> Result<(), Refusal> {
    if pid <= 1 {
        return Err(Refusal::InvalidPid);
    }
    if !is_session_id(session_id) {
        return Err(Refusal::SessionMismatch);
    }
    let entry = entry.ok_or(Refusal::NoRegistryEntry)?;
    if entry.session_id != session_id {
        return Err(Refusal::SessionMismatch);
    }
    let process = process.ok_or(Refusal::NoProcess)?;
    let name = Path::new(&process.executable)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if name != "claude" {
        return Err(Refusal::NotClaude);
    }
    if process.ppid != 1 {
        return Err(Refusal::NotOrphan);
    }
    let named = named_sessions(&process.args);
    if named.iter().any(|id| *id != session_id) {
        return Err(Refusal::ArgsNameAnotherSession);
    }
    let same_start = entry
        .proc_start
        .as_deref()
        .is_some_and(|start| normalized(start) == normalized(&process.started));
    if !same_start && !named.contains(&session_id) {
        return Err(Refusal::NotSameProcess);
    }
    Ok(())
}

/// SIGTERM, then SIGKILL after `grace` while `same()` says the pid is still
/// the process that was checked. True once it is gone.
#[cfg(unix)]
pub fn terminate(pid: u32, grace: Duration, same: impl Fn() -> bool) -> bool {
    let Ok(raw) = i32::try_from(pid) else {
        return false;
    };
    // SAFETY: kill(2) takes plain integers and touches no memory of ours.
    let alive = || unsafe { libc::kill(raw, 0) } == 0;
    // SAFETY: as above.
    if unsafe { libc::kill(raw, libc::SIGTERM) } != 0 {
        return !alive();
    }
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if !alive() || !same() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if alive() && same() {
        // SAFETY: as above.
        unsafe { libc::kill(raw, libc::SIGKILL) };
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline && alive() && same() {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    !alive() || !same()
}

/// The whole click: check, then stop. Ok(false) when the pid is refused.
#[cfg(unix)]
pub fn stop_orphan(session_id: &str, pid: u32) -> Result<bool, String> {
    let config = owner_config_dir();
    let node_root = node_session_config_root();
    if config.is_none() && node_root.is_none() {
        return Err("no Claude config directory".into());
    }
    let entry = find_registry(config.as_deref(), node_root.as_deref(), session_id, pid);
    let process = read_process(pid);
    if let Err(refusal) = check_orphan(session_id, pid, entry.as_ref(), process.as_ref()) {
        eprintln!("[orphan-claude] refused to stop pid {pid}: {refusal:?}");
        return Ok(false);
    }
    let started = process.map(|p| p.started).unwrap_or_default();
    let same = || read_process(pid).is_some_and(|p| p.started == started);
    Ok(terminate(pid, STOP_GRACE, same))
}

/// "Stop it" (D33): the owner's click on an orphaned Claude process holding
/// one of their sessions. False when the pid is refused (see the module).
#[tauri::command]
pub async fn stop_orphan_claude(session_id: String, pid: u32) -> Result<bool, String> {
    #[cfg(unix)]
    {
        tauri::async_runtime::spawn_blocking(move || stop_orphan(&session_id, pid))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(unix))]
    {
        let _ = (session_id, pid);
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "41173e76-dc0a-4f5f-8c7a-fde5d5329047";
    const OTHER: &str = "9d2c1f00-0000-4000-8000-000000000001";
    const START: &str = "Thu Oct 15 17:30:09 2026";
    const VSCODE: &str = "/Users/x/.vscode/extensions/anthropic.claude-code-2.1.296-darwin-arm64/resources/native-binary/claude";

    fn entry(session: &str) -> RegistryFacts {
        RegistryFacts {
            session_id: session.to_string(),
            proc_start: Some(START.to_string()),
        }
    }

    fn orphan(args: &str) -> ProcessFacts {
        ProcessFacts {
            ppid: 1,
            started: format!("{START}    "),
            executable: VSCODE.to_string(),
            args: args.to_string(),
        }
    }

    #[test]
    fn d33_an_orphaned_claude_tied_to_the_session_may_be_stopped() {
        let resumed = orphan(&format!("{VSCODE} --resume={ID}"));
        assert_eq!(check_orphan(ID, 5093, Some(&entry(ID)), Some(&resumed)), Ok(()));
        // A fresh session names no id: the start time ties it.
        let fresh = orphan(&format!("{VSCODE} --output-format stream-json"));
        assert_eq!(check_orphan(ID, 5093, Some(&entry(ID)), Some(&fresh)), Ok(()));
    }

    #[test]
    fn d33_a_registry_entry_for_another_session_id_is_refused() {
        let p = orphan(VSCODE);
        assert_eq!(
            check_orphan(ID, 5093, Some(&entry(OTHER)), Some(&p)),
            Err(Refusal::SessionMismatch)
        );
        assert_eq!(check_orphan(ID, 5093, None, Some(&p)), Err(Refusal::NoRegistryEntry));
        assert_eq!(
            check_orphan("../../etc", 5093, Some(&entry("../../etc")), Some(&p)),
            Err(Refusal::SessionMismatch)
        );
    }

    #[test]
    fn d33_arguments_naming_another_session_id_are_refused() {
        for args in [
            format!("{VSCODE} --resume={OTHER}"),
            format!("{VSCODE} --resume {OTHER}"),
            format!("{VSCODE} -r {OTHER}"),
            format!("{VSCODE} --session-id={OTHER}"),
        ] {
            assert_eq!(
                check_orphan(ID, 5093, Some(&entry(ID)), Some(&orphan(&args))),
                Err(Refusal::ArgsNameAnotherSession),
                "{args}"
            );
        }
    }

    #[test]
    fn d33_a_binary_that_is_not_claude_is_refused() {
        for executable in ["/usr/local/bin/node", "/bin/sh", "/opt/claude-tools/bin/claude-helper", ""] {
            let p = ProcessFacts {
                executable: executable.to_string(),
                ..orphan(&format!("{executable} /x/claude --resume={ID}"))
            };
            assert_eq!(
                check_orphan(ID, 5093, Some(&entry(ID)), Some(&p)),
                Err(Refusal::NotClaude),
                "{executable}"
            );
        }
    }

    #[test]
    fn d33_a_claude_with_a_live_parent_or_another_start_or_no_process_is_refused() {
        let live = ProcessFacts {
            ppid: 4100,
            ..orphan(&format!("{VSCODE} --resume={ID}"))
        };
        assert_eq!(
            check_orphan(ID, 5093, Some(&entry(ID)), Some(&live)),
            Err(Refusal::NotOrphan)
        );
        // The pid was reused by another claude since the entry was written.
        let reused = ProcessFacts {
            started: "Fri Oct 16 08:00:00 2026".to_string(),
            ..orphan(VSCODE)
        };
        assert_eq!(
            check_orphan(ID, 5093, Some(&entry(ID)), Some(&reused)),
            Err(Refusal::NotSameProcess)
        );
        assert_eq!(check_orphan(ID, 5093, Some(&entry(ID)), None), Err(Refusal::NoProcess));
        assert_eq!(
            check_orphan(ID, 1, Some(&entry(ID)), Some(&orphan(VSCODE))),
            Err(Refusal::InvalidPid)
        );
    }

    #[test]
    fn d33_the_registry_entry_is_read_for_its_pid_only() {
        let dir = std::env::temp_dir().join(format!("orphan-claude-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sessions")).unwrap();
        std::fs::write(
            dir.join("sessions").join("5093.json"),
            format!(r#"{{"pid":5093,"sessionId":"{ID}","procStart":"{START}"}}"#),
        )
        .unwrap();
        std::fs::write(
            dir.join("sessions").join("6000.json"),
            format!(r#"{{"pid":5093,"sessionId":"{ID}"}}"#),
        )
        .unwrap();
        assert_eq!(read_registry(&dir, 5093), Some(entry(ID)));
        // A file whose pid is not its name's names nothing.
        assert_eq!(read_registry(&dir, 6000), None);
        assert_eq!(read_registry(&dir, 7000), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn w1_d3_the_nodes_own_leftover_is_found_in_its_session_config_dir() {
        let base = std::env::temp_dir().join(format!("orphan-claude-node-{}", std::process::id()));
        let owner = base.join("owner");
        let node = base.join("session-config");
        let session = node.join("373bdeb2-0000-4000-8000-000000000000");
        std::fs::create_dir_all(owner.join("sessions")).unwrap();
        std::fs::create_dir_all(session.join("sessions")).unwrap();
        std::fs::create_dir_all(node.join("other").join("sessions")).unwrap();
        std::fs::write(
            node.join("other").join("sessions").join("20847.json"),
            format!(r#"{{"pid":20847,"sessionId":"{OTHER}"}}"#),
        )
        .unwrap();
        std::fs::write(
            session.join("sessions").join("20847.json"),
            format!(r#"{{"pid":20847,"sessionId":"{ID}","procStart":"{START}"}}"#),
        )
        .unwrap();
        // Not in the owner's registry: the node's own session dir names it.
        assert_eq!(
            find_registry(Some(&owner), Some(&node), ID, 20847),
            Some(entry(ID))
        );
        // Without the node's root, nothing names it (the refusal before W1-D3).
        assert_eq!(find_registry(Some(&owner), None, ID, 20847), None);
        // The node's own first-run child carries no --resume: its start time ties it.
        let first_run = ProcessFacts {
            ppid: 1,
            started: START.to_string(),
            executable: "/tmp/claude-501/abc/claude".to_string(),
            args: "/tmp/claude-501/abc/claude --output-format stream-json".to_string(),
        };
        let found = find_registry(Some(&owner), Some(&node), ID, 20847);
        assert_eq!(
            check_orphan(ID, 20847, found.as_ref(), Some(&first_run)),
            Ok(())
        );
        // The owner's entry still wins when it names the session.
        std::fs::write(
            owner.join("sessions").join("20847.json"),
            format!(r#"{{"pid":20847,"sessionId":"{ID}"}}"#),
        )
        .unwrap();
        assert_eq!(
            find_registry(Some(&owner), Some(&node), ID, 20847).map(|e| e.proc_start),
            Some(None)
        );
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn d33_terminate_sends_sigkill_after_the_grace_when_sigterm_is_ignored() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "trap '' TERM; while :; do sleep 0.05; done"])
            .spawn()
            .unwrap();
        let pid = child.id();
        std::thread::sleep(Duration::from_millis(200));
        // Reap it as soon as it exits (launchd does for a real orphan).
        let reaper = std::thread::spawn(move || child.wait().unwrap());
        let t0 = Instant::now();
        assert!(terminate(pid, Duration::from_millis(400), || true));
        assert!(t0.elapsed() >= Duration::from_millis(400));
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(reaper.join().unwrap().signal(), Some(libc::SIGKILL));
    }

    #[cfg(unix)]
    #[test]
    fn d33_terminate_stops_on_sigterm_without_sigkill() {
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let pid = child.id();
        // Reap it as soon as it exits, so `kill(pid, 0)` sees it gone.
        let reaper = std::thread::spawn(move || child.wait().unwrap());
        assert!(terminate(pid, Duration::from_secs(5), || true));
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(reaper.join().unwrap().signal(), Some(libc::SIGTERM));
    }
}
