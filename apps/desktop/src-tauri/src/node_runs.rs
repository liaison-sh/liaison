// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE NODE'S LIVE RUNS (P3-T04; C6, L2, L3, L20, D35, G9).
//
// The shell runs one sidecar per live session, side by side, up to the
// node's cap (D35: 4 live, 2 of them background by default). A run is keyed
// by its session id, or by `job:<jobId>` for a My node chat turn, which stays
// one at a time (G9) and counts toward the cap. Each run's stdout lines go to
// the page tagged with the run's session and job; the page writes control
// lines to ONE session's stdin, and only lines `control_line_ok` admits.
//
// The children are owned by this process, not by the page: a page reload
// keeps every run alive (L3).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Deserialize;
use tauri_plugin_shell::process::CommandChild;

/// A run of this session is already live here.
pub const SESSION_RUNNING: &str = "SESSION_RUNNING";
/// The node holds as many runs (or background runs) as its cap allows.
pub const NODE_AT_CAP: &str = "NODE_AT_CAP";
/// A My node chat turn is already live (G9: one at a time).
pub const INTERACTIVE_RUNNING: &str = "INTERACTIVE_RUNNING";

/// The node's live caps (D35; the claim answers them once the server has them).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Caps {
    pub max_live: usize,
    pub max_background: usize,
}

/// `NODE_SESSION_DEFAULT_CAPS` (packages/shared node-session-protocol.ts).
impl Default for Caps {
    fn default() -> Self {
        Caps {
            max_live: 4,
            max_background: 2,
        }
    }
}

/// A run's child process, as the live runs hold it (a test double stands in
/// for the sidecar).
pub trait RunChild: Send {
    fn write(&mut self, bytes: &[u8]) -> Result<(), String>;
    fn pid(&self) -> u32;
    /// Told to stop, then killed after a grace period.
    fn stop(self: Box<Self>);
}

impl RunChild for CommandChild {
    fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        CommandChild::write(self, bytes).map_err(|e| e.to_string())
    }
    fn pid(&self) -> u32 {
        CommandChild::pid(self)
    }
    fn stop(self: Box<Self>) {
        crate::sidecar::stop_child_detached(*self);
    }
}

/// One live run.
pub struct LiveRun {
    pub job_id: String,
    pub session_id: Option<String>,
    pub interactive: bool,
    /// A routine's or an agent tag's session (D35's background cap).
    pub background: bool,
    /// The claim's lease generation, for a reloaded page to fence its calls with.
    pub lease_generation: Option<u64>,
    /// The start request, without the access token (node_job.rs `kept_request`).
    pub request: Option<serde_json::Value>,
    /// D50: the server that claimed this run (its address, no trailing `/`).
    /// Only a page of that server re-adopts it and posts its lines.
    pub server: Option<String>,
    pub child: Box<dyn RunChild>,
}

/// A live run as the page lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunInfo {
    pub key: String,
    pub job_id: String,
    pub session_id: Option<String>,
    pub interactive: bool,
    pub background: bool,
    pub lease_generation: Option<u64>,
    pub request: Option<serde_json::Value>,
    pub pid: u32,
}

/// The key a run is held under: its session, else `job:<jobId>`.
pub fn run_key(session_id: Option<&str>, job_id: &str) -> String {
    match session_id {
        Some(id) => id.to_string(),
        None => format!("job:{job_id}"),
    }
}

/// Every live run of this node.
#[derive(Default)]
pub struct LiveRuns(pub Mutex<HashMap<String, LiveRun>>);

impl LiveRuns {
    fn refusal(
        runs: &HashMap<String, LiveRun>,
        key: &str,
        interactive: bool,
        background: bool,
        caps: Caps,
    ) -> Result<(), &'static str> {
        if runs.contains_key(key) {
            return Err(SESSION_RUNNING);
        }
        if interactive && runs.values().any(|r| r.interactive) {
            return Err(INTERACTIVE_RUNNING);
        }
        if runs.len() >= caps.max_live {
            return Err(NODE_AT_CAP);
        }
        if background && runs.values().filter(|r| r.background).count() >= caps.max_background {
            return Err(NODE_AT_CAP);
        }
        Ok(())
    }

    /// Whether a run under `key` may start now. Checked before anything is
    /// consumed or spawned; `insert` checks again, atomically.
    pub fn admit(
        &self,
        key: &str,
        interactive: bool,
        background: bool,
        caps: Caps,
    ) -> Result<(), &'static str> {
        let runs = self.0.lock().map_err(|_| NODE_AT_CAP)?;
        Self::refusal(&runs, key, interactive, background, caps)
    }

    /// Holds a started run. Refused (the run handed back) when another start
    /// took the slot meanwhile: the caller stops it.
    pub fn insert(
        &self,
        key: String,
        run: LiveRun,
        caps: Caps,
    ) -> Result<(), (&'static str, LiveRun)> {
        let Ok(mut runs) = self.0.lock() else {
            return Err((NODE_AT_CAP, run));
        };
        if let Err(code) = Self::refusal(&runs, &key, run.interactive, run.background, caps) {
            return Err((code, run));
        }
        runs.insert(key, run);
        Ok(())
    }

    /// Takes the run out when it is still the one with this pid (its exit).
    pub fn remove_if(&self, key: &str, pid: u32) -> Option<LiveRun> {
        let mut runs = self.0.lock().ok()?;
        if runs.get(key).is_some_and(|r| r.child.pid() == pid) {
            runs.remove(key)
        } else {
            None
        }
    }

    /// Writes one line (a newline added) to that run's stdin. False when the
    /// key has no live run.
    pub fn write_line(&self, key: &str, line: &str) -> Result<bool, String> {
        let mut runs = self
            .0
            .lock()
            .map_err(|_| "node runs lock poisoned".to_string())?;
        match runs.get_mut(key) {
            Some(run) => {
                run.child.write(format!("{line}\n").as_bytes())?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    pub fn take(&self, key: &str) -> Option<LiveRun> {
        self.0.lock().ok()?.remove(key)
    }

    /// The key of the run holding this job, if any.
    pub fn key_of_job(&self, job_id: &str) -> Option<String> {
        let runs = self.0.lock().ok()?;
        runs.iter()
            .find(|(_, r)| r.job_id == job_id)
            .map(|(k, _)| k.clone())
    }

    /// The live My node chat turn's key (G9: at most one).
    pub fn interactive_key(&self) -> Option<String> {
        let runs = self.0.lock().ok()?;
        runs.iter()
            .find(|(_, r)| r.interactive)
            .map(|(k, _)| k.clone())
    }

    #[cfg(test)]
    pub fn keys(&self) -> Vec<String> {
        self.0
            .lock()
            .map(|runs| runs.keys().cloned().collect())
            .unwrap_or_default()
    }

    pub fn any_live(&self) -> bool {
        self.0.lock().map(|runs| !runs.is_empty()).unwrap_or(false)
    }

    /// D50: takes out every run that another server claimed (or whose server
    /// is unknown), so a page of `current` never re-adopts it and never posts
    /// its saved lines there. The caller stops them.
    pub fn take_other_servers(&self, current: Option<&str>) -> Vec<LiveRun> {
        let Ok(mut runs) = self.0.lock() else {
            return Vec::new();
        };
        let current = current.map(|c| c.trim_end_matches('/'));
        let others: Vec<String> = runs
            .iter()
            .filter(|(_, r)| {
                current.is_none() || r.server.as_deref().map(|s| s.trim_end_matches('/')) != current
            })
            .map(|(k, _)| k.clone())
            .collect();
        others.iter().filter_map(|k| runs.remove(k)).collect()
    }

    /// Every live run, for the page's reattach.
    pub fn list(&self) -> Vec<RunInfo> {
        let Ok(runs) = self.0.lock() else {
            return Vec::new();
        };
        let mut out: Vec<RunInfo> = runs
            .iter()
            .map(|(key, r)| RunInfo {
                key: key.clone(),
                job_id: r.job_id.clone(),
                session_id: r.session_id.clone(),
                interactive: r.interactive,
                background: r.background,
                lease_generation: r.lease_generation,
                request: r.request.clone(),
                pid: r.child.pid(),
            })
            .collect();
        out.sort_by(|a, b| a.key.cmp(&b.key));
        out
    }

    /// Takes every run out (app quit, server switch).
    pub fn drain(&self) -> Vec<LiveRun> {
        self.0
            .lock()
            .map(|mut runs| runs.drain().map(|(_, r)| r).collect())
            .unwrap_or_default()
    }
}

// ─── Paths ───────────────────────────────────────────────────────────────

/// A server-issued id (a uuid), before it enters a path or a line.
pub fn is_uuid(id: &str) -> bool {
    id.len() == 36
        && id.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// A session's folder name on this computer: the alphanumerics of its id,
/// first 12 (the sidecar's `sessionShortName`, unattended.ts).
pub fn session_short_name(id: &str) -> String {
    let short: String = id.chars().filter(|c| c.is_ascii_alphanumeric()).take(12).collect();
    if short.is_empty() {
        "session".into()
    } else {
        short
    }
}

/// `<nodeRoot>/.sessions/<short>`.
pub fn session_dir(node_root: &Path, session_id: &str) -> PathBuf {
    node_root.join(".sessions").join(session_short_name(session_id))
}

/// `<session_dir>/runs/<jobId>`: one run's job file, outbox and ack. Both ids
/// must be uuids: nothing else is ever joined into the path.
pub fn run_dir(node_root: &Path, session_id: &str, job_id: &str) -> Result<PathBuf, String> {
    if !is_uuid(session_id) || !is_uuid(job_id) {
        return Err("bad session or job id".into());
    }
    Ok(session_dir(node_root, session_id).join("runs").join(job_id))
}

/// Creates a directory (and its parents) readable by the owner only.
pub fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

// ─── The run outbox and its posting position (P3-T09; L3, D36, G6) ───────
//
// Every `session_events` line a session's sidecar prints is appended to
// `<run dir>/outbox.jsonl` (fsynced) before the page hears it, so a page
// reloaded mid-run reads back what it missed. The page persists how far the
// server acknowledged (`acked.json`: the last outbox line fully stored and
// the batch number it went as), so the reloaded page posts on with no gap
// and no duplicate.

pub const OUTBOX_FILE: &str = "outbox.jsonl";
pub const ACK_FILE: &str = "acked.json";
/// The most outbox lines one read answers.
pub const OUTBOX_READ_MAX: usize = 200;

fn private_append(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn count_lines(path: &Path) -> u64 {
    match std::fs::read(path) {
        Ok(bytes) => bytes.iter().filter(|b| **b == b'\n').count() as u64,
        Err(_) => 0,
    }
}

/// Whether a sidecar line is a flushed batch of session events.
fn is_session_events(line: &str) -> bool {
    // Cheap first: a line that does not name the type is not parsed.
    line.contains("\"session_events\"")
        && serde_json::from_str::<serde_json::Value>(line)
            .ok()
            .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(|t| t == "session_events"))
            .unwrap_or(false)
}

/// One run's outbox, as its line follower writes it.
pub struct Outbox {
    path: PathBuf,
    count: u64,
}

impl Outbox {
    /// Opens (creating the run directory, owner only) and counts what is there.
    pub fn open(run_dir: &Path) -> std::io::Result<Outbox> {
        create_private_dir(run_dir)?;
        let path = run_dir.join(OUTBOX_FILE);
        let count = count_lines(&path);
        Ok(Outbox { path, count })
    }

    /// Appends a `session_events` line (fsynced) and answers its 1-based
    /// index; any other line is not kept (None).
    pub fn follow(&mut self, line: &str) -> std::io::Result<Option<u64>> {
        if line.contains('\n') || !is_session_events(line) {
            return Ok(None);
        }
        use std::io::Write;
        let mut file = private_append(&self.path)?;
        file.write_all(format!("{line}\n").as_bytes())?;
        file.sync_data()?;
        self.count += 1;
        Ok(Some(self.count))
    }
}

/// How many lines a run's outbox holds.
pub fn outbox_len(node_root: &Path, session_id: &str, job_id: &str) -> Result<u64, String> {
    Ok(count_lines(&run_dir(node_root, session_id, job_id)?.join(OUTBOX_FILE)))
}

/// Up to `max` (at most OUTBOX_READ_MAX) outbox lines from `from_index` (1-based).
pub fn read_outbox(
    node_root: &Path,
    session_id: &str,
    job_id: &str,
    from_index: u64,
    max: usize,
) -> Result<Vec<(u64, String)>, String> {
    let path = run_dir(node_root, session_id, job_id)?.join(OUTBOX_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let first = from_index.max(1);
    Ok(text
        .lines()
        .enumerate()
        .map(|(i, line)| (i as u64 + 1, line))
        .filter(|(index, _)| *index >= first)
        .take(max.min(OUTBOX_READ_MAX))
        .map(|(index, line)| (index, line.to_string()))
        .collect())
}

/// Persists how far the server acknowledged: `{index, batchNo}`, replaced atomically.
pub fn write_ack(
    node_root: &Path,
    session_id: &str,
    job_id: &str,
    index: u64,
    batch_no: u64,
) -> Result<(), String> {
    let dir = run_dir(node_root, session_id, job_id)?;
    create_private_dir(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(ACK_FILE);
    let tmp = dir.join(format!("{ACK_FILE}.tmp"));
    crate::sidecar::write_private(
        &tmp,
        serde_json::json!({ "index": index, "batchNo": batch_no })
            .to_string()
            .as_bytes(),
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

/// The persisted ack: `(index, batchNo)`, `(0, 0)` when none was written.
pub fn read_ack(node_root: &Path, session_id: &str, job_id: &str) -> Result<(u64, u64), String> {
    let file = run_dir(node_root, session_id, job_id)?.join(ACK_FILE);
    let Ok(bytes) = std::fs::read(&file) else {
        return Ok((0, 0));
    };
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
    Ok((
        value["index"].as_u64().unwrap_or(0),
        value["batchNo"].as_u64().unwrap_or(0),
    ))
}

/// D50: the runs a page of `current` may reattach to. A run another server
/// claimed is stopped here and never listed, so its saved lines never reach
/// `current`; the server that claimed it was told at the switch (account.rs
/// `leave_current`), and its lease sweep is the backstop.
pub fn live_sessions_of_server(
    runs: &LiveRuns,
    node_root: &Path,
    current: Option<&str>,
) -> Vec<serde_json::Value> {
    for run in runs.take_other_servers(current) {
        run.child.stop();
    }
    live_sessions(runs, node_root)
}

/// Every live run, as the reloaded page reattaches to it: `{sessionId, jobId,
/// pid, interactive, background, leaseGeneration, request, lines}` (sessions
/// first, by id).
pub fn live_sessions(runs: &LiveRuns, node_root: &Path) -> Vec<serde_json::Value> {
    let mut listed = runs.list();
    listed.sort_by_key(|r| (r.session_id.is_none(), r.key.clone()));
    listed
        .into_iter()
        .map(|r| {
            let lines = r
                .session_id
                .as_deref()
                .and_then(|id| outbox_len(node_root, id, &r.job_id).ok())
                .unwrap_or(0);
            serde_json::json!({
                "sessionId": r.session_id,
                "jobId": r.job_id,
                "pid": r.pid,
                "interactive": r.interactive,
                "background": r.background,
                "leaseGeneration": r.lease_generation,
                "request": r.request,
                "lines": lines,
            })
        })
        .collect()
}

// ─── Spill files (P3-T20; S7, D3) ────────────────────────────────────────
//
// A tool output cut at 64 KB in the session's events stays whole on this
// computer, in `<session_dir>/spill/<toolUseId>.txt` (the sidecar writes it,
// at most 20 MiB). The owner's "Show full output" reads it back here.

/** The most a spill file holds (the sidecar cuts it there, with a last line). */
pub const SPILL_MAX_BYTES: u64 = 20 * 1024 * 1024;

/** A Claude Code tool use id (`TOOL_USE_ID_RE` in node-session-protocol.ts). */
pub fn tool_use_id_ok(id: &str) -> bool {
    id.len() > "toolu_".len()
        && id.len() <= 200
        && id.starts_with("toolu_")
        && id["toolu_".len()..]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// A cut tool output's full text, None when this computer no longer has it.
pub fn read_spill(
    node_root: &Path,
    session_id: &str,
    tool_use_id: &str,
) -> Result<Option<String>, String> {
    if !is_uuid(session_id) || !tool_use_id_ok(tool_use_id) {
        return Err("bad session or tool use id".into());
    }
    let path = session_dir(node_root, session_id)
        .join("spill")
        .join(format!("{tool_use_id}.txt"));
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    use std::io::Read;
    let mut bytes = Vec::new();
    // The sidecar's own last line ("cut at 20 MiB") fits in the margin.
    file.take(SPILL_MAX_BYTES + 1024)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

// ─── Control lines ───────────────────────────────────────────────────────

/// The only lines the page may write to a session's stdin: one JSON object on
/// one line, a `command` with a uuid `commandId` (the sidecar validates the
/// rest, session-control.ts) or a `restart`.
pub fn control_line_ok(line: &str) -> bool {
    if line.contains('\n') || line.contains('\r') || line.len() > 256 * 1024 {
        return false;
    }
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(line) else {
        return false;
    };
    match map.get("type").and_then(|v| v.as_str()) {
        Some("command") => map
            .get("commandId")
            .and_then(|v| v.as_str())
            .is_some_and(is_uuid),
        Some("restart") => true,
        _ => false,
    }
}

#[cfg(test)]
pub(crate) mod node_runs_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    /// A child that records what it was written and whether it was stopped.
    pub struct FakeChild {
        pub pid: u32,
        pub written: Arc<Mutex<Vec<u8>>>,
        pub stopped: Arc<AtomicBool>,
    }

    impl RunChild for FakeChild {
        fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
            self.written.lock().unwrap().extend_from_slice(bytes);
            Ok(())
        }
        fn pid(&self) -> u32 {
            self.pid
        }
        fn stop(self: Box<Self>) {
            self.stopped.store(true, Ordering::SeqCst);
        }
    }

    pub fn fake_run(
        job: &str,
        session: Option<&str>,
        interactive: bool,
        background: bool,
        pid: u32,
    ) -> (LiveRun, Arc<Mutex<Vec<u8>>>) {
        let written = Arc::new(Mutex::new(Vec::new()));
        let run = LiveRun {
            job_id: job.into(),
            session_id: session.map(String::from),
            interactive,
            background,
            lease_generation: Some(u64::from(pid)),
            request: None,
            server: None,
            child: Box::new(FakeChild {
                pid,
                written: written.clone(),
                stopped: Arc::new(AtomicBool::new(false)),
            }),
        };
        (run, written)
    }

    fn put(runs: &LiveRuns, key: &str, interactive: bool, background: bool, pid: u32) {
        let session = (!key.starts_with("job:")).then_some(key);
        let (run, _) = fake_run(&format!("job-{pid}"), session, interactive, background, pid);
        runs.insert(key.into(), run, Caps::default())
            .map_err(|(code, _)| code)
            .unwrap();
    }

    #[test]
    fn two_sessions_hold_two_slots() {
        let runs = LiveRuns::default();
        put(&runs, "s-1", false, false, 1);
        put(&runs, "s-2", false, false, 2);
        let mut keys = runs.keys();
        keys.sort();
        assert_eq!(keys, vec!["s-1".to_string(), "s-2".to_string()]);
        assert!(runs.any_live());
        // Each exit takes out only its own run, and only while it is that pid.
        assert!(runs.remove_if("s-1", 99).is_none());
        assert!(runs.remove_if("s-1", 1).is_some());
        assert_eq!(runs.keys(), vec!["s-2".to_string()]);
    }

    #[test]
    fn a_second_run_of_a_live_session_is_refused() {
        let runs = LiveRuns::default();
        put(&runs, "s-1", false, false, 1);
        assert_eq!(runs.admit("s-1", false, false, Caps::default()), Err(SESSION_RUNNING));
        let (run, _) = fake_run("job-2", Some("s-1"), false, false, 2);
        let refused = runs.insert("s-1".into(), run, Caps::default());
        assert_eq!(refused.map_err(|(code, _)| code), Err(SESSION_RUNNING));
        // The first run is untouched.
        assert_eq!(runs.list()[0].pid, 1);
    }

    #[test]
    fn the_cap_refuses_a_fifth_session_and_a_third_background_one() {
        let runs = LiveRuns::default();
        let caps = Caps::default();
        put(&runs, "bg-1", false, true, 1);
        put(&runs, "bg-2", false, true, 2);
        assert_eq!(runs.admit("bg-3", false, true, caps), Err(NODE_AT_CAP));
        // An app session still has room.
        assert_eq!(runs.admit("s-3", false, false, caps), Ok(()));
        put(&runs, "s-3", false, false, 3);
        put(&runs, "s-4", false, false, 4);
        assert_eq!(runs.admit("s-5", false, false, caps), Err(NODE_AT_CAP));
        // A My node chat turn counts toward the cap (G9).
        assert_eq!(runs.admit("job:c", true, false, caps), Err(NODE_AT_CAP));
        // The claim's caps are the ones applied.
        let two = Caps {
            max_live: 2,
            max_background: 0,
        };
        let small = LiveRuns::default();
        assert_eq!(small.admit("bg", false, true, two), Err(NODE_AT_CAP));
        put(&small, "a", false, false, 1);
        put(&small, "b", false, false, 2);
        assert_eq!(small.admit("c", false, false, two), Err(NODE_AT_CAP));
    }

    #[test]
    fn a_second_interactive_turn_is_refused() {
        let runs = LiveRuns::default();
        put(&runs, "job:c-1", true, false, 1);
        assert_eq!(
            runs.admit("job:c-2", true, false, Caps::default()),
            Err(INTERACTIVE_RUNNING)
        );
        assert_eq!(runs.interactive_key().as_deref(), Some("job:c-1"));
        // A session runs beside it.
        assert_eq!(runs.admit("s-1", false, false, Caps::default()), Ok(()));
    }

    #[test]
    fn a_line_reaches_only_its_session() {
        let runs = LiveRuns::default();
        let (a, a_written) = fake_run("job-a", Some("s-a"), false, false, 1);
        let (b, b_written) = fake_run("job-b", Some("s-b"), false, false, 2);
        runs.insert("s-a".into(), a, Caps::default()).ok().unwrap();
        runs.insert("s-b".into(), b, Caps::default()).ok().unwrap();
        assert_eq!(runs.write_line("s-b", "{\"type\":\"restart\"}"), Ok(true));
        assert!(a_written.lock().unwrap().is_empty());
        assert_eq!(
            String::from_utf8(b_written.lock().unwrap().clone()).unwrap(),
            "{\"type\":\"restart\"}\n"
        );
        assert_eq!(runs.write_line("s-none", "x"), Ok(false));
        assert_eq!(runs.key_of_job("job-a").as_deref(), Some("s-a"));
    }

    #[test]
    fn a_control_line_with_a_newline_or_another_type_is_refused() {
        let id = "0b0c3e1a-2f4d-4e5f-8a6b-7c8d9e0f1a2b";
        let ok = format!(
            "{{\"type\":\"command\",\"commandId\":\"{id}\",\"seq\":1,\"command\":{{\"type\":\"stop\",\"payload\":{{}}}}}}"
        );
        assert!(control_line_ok(&ok));
        assert!(control_line_ok("{\"type\":\"restart\"}"));
        assert!(!control_line_ok(&format!("{ok}\n{{\"type\":\"shutdown\"}}")));
        assert!(!control_line_ok(&format!("{ok}\r")));
        assert!(!control_line_ok("{\"type\":\"shutdown\"}"));
        assert!(!control_line_ok("{\"type\":\"abort\"}"));
        assert!(!control_line_ok("{\"type\":\"set_permission_mode\",\"mode\":\"bypassPermissions\"}"));
        assert!(!control_line_ok("{\"type\":\"command\",\"commandId\":\"../x\"}"));
        assert!(!control_line_ok("{\"type\":\"command\"}"));
        assert!(!control_line_ok("[1]"));
        assert!(!control_line_ok("not json"));
    }

    const SID: &str = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
    const JOB: &str = "11111111-2222-4333-8444-555555555555";

    fn scratch_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("liaison-runs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn outbox_lines_are_appended_and_read_from_an_index() {
        let root = scratch_root("outbox");
        let dir = run_dir(&root, SID, JOB).unwrap();
        let mut outbox = Outbox::open(&dir).unwrap();
        let events = |n: u32| format!("{{\"type\":\"session_events\",\"sessionId\":\"{SID}\",\"n\":{n}}}");
        // Only session_events lines enter the outbox, numbered from 1.
        assert_eq!(outbox.follow(&events(1)).unwrap(), Some(1));
        assert_eq!(outbox.follow("{\"type\":\"job_done\"}").unwrap(), None);
        assert_eq!(outbox.follow("not json").unwrap(), None);
        assert_eq!(outbox.follow(&events(2)).unwrap(), Some(2));
        assert_eq!(outbox.follow(&events(3)).unwrap(), Some(3));
        assert_eq!(outbox_len(&root, SID, JOB).unwrap(), 3);
        let read = read_outbox(&root, SID, JOB, 2, 200).unwrap();
        assert_eq!(read, vec![(2, events(2)), (3, events(3))]);
        assert_eq!(read_outbox(&root, SID, JOB, 1, 1).unwrap(), vec![(1, events(1))]);
        assert!(read_outbox(&root, SID, JOB, 4, 200).unwrap().is_empty());
        // A reopened outbox (a page reload, the shell's follower) keeps counting.
        let mut again = Outbox::open(&dir).unwrap();
        assert_eq!(again.follow(&events(4)).unwrap(), Some(4));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(OUTBOX_FILE)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn outbox_reads_refuse_a_path_like_id() {
        let root = scratch_root("outbox-ids");
        assert!(read_outbox(&root, "../../etc", JOB, 1, 10).is_err());
        assert!(read_outbox(&root, SID, "../x", 1, 10).is_err());
        assert!(write_ack(&root, SID, "a/b", 1, 1).is_err());
        assert!(read_ack(&root, "x", JOB).is_err());
        // Nothing was created outside the node root's .sessions.
        assert!(!root.join("etc").exists());
        // An absent outbox reads empty.
        assert!(read_outbox(&root, SID, JOB, 1, 10).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ack_is_persisted_and_read_back() {
        let root = scratch_root("ack");
        create_private_dir(&run_dir(&root, SID, JOB).unwrap()).unwrap();
        write_ack(&root, SID, JOB, 3, 5).unwrap();
        assert_eq!(read_ack(&root, SID, JOB).unwrap(), (3, 5));
        write_ack(&root, SID, JOB, 4, 7).unwrap();
        assert_eq!(read_ack(&root, SID, JOB).unwrap(), (4, 7));
        let file = run_dir(&root, SID, JOB).unwrap().join(ACK_FILE);
        assert!(!file.with_extension("json.tmp").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ack_absent_reads_zero() {
        let root = scratch_root("ack-absent");
        assert_eq!(read_ack(&root, SID, JOB).unwrap(), (0, 0));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn live_sessions_list_each_run_with_its_line_count() {
        let root = scratch_root("live");
        let other = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        let other_job = "22222222-3333-4444-8555-666666666666";
        let runs = LiveRuns::default();
        let (a, _) = fake_run(JOB, Some(SID), false, false, 11);
        let (b, _) = fake_run(other_job, Some(other), false, true, 12);
        let (c, _) = fake_run("chat-job", None, true, false, 13);
        runs.insert(SID.into(), a, Caps::default()).ok().unwrap();
        runs.insert(other.into(), b, Caps::default()).ok().unwrap();
        runs.insert("job:chat-job".into(), c, Caps::default()).ok().unwrap();
        let mut outbox = Outbox::open(&run_dir(&root, SID, JOB).unwrap()).unwrap();
        outbox.follow("{\"type\":\"session_events\",\"events\":[]}").unwrap();
        outbox.follow("{\"type\":\"session_events\",\"events\":[]}").unwrap();
        let listed = live_sessions(&runs, &root);
        assert_eq!(
            listed,
            vec![
                serde_json::json!({ "sessionId": SID, "jobId": JOB, "pid": 11, "interactive": false, "background": false, "leaseGeneration": 11, "request": null, "lines": 2 }),
                serde_json::json!({ "sessionId": other, "jobId": other_job, "pid": 12, "interactive": false, "background": true, "leaseGeneration": 12, "request": null, "lines": 0 }),
                serde_json::json!({ "sessionId": null, "jobId": "chat-job", "pid": 13, "interactive": true, "background": false, "leaseGeneration": 13, "request": null, "lines": 0 }),
            ]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// D50: a run carried over a server switch is never re-adopted by the
    /// new server's page: it is stopped and left out of the reattach list.
    #[test]
    fn live_sessions_of_a_server_stop_and_leave_out_the_runs_of_another_server() {
        let root = scratch_root("live-server");
        let other = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        let other_job = "22222222-3333-4444-8555-666666666666";
        let runs = LiveRuns::default();
        let stopped_a = Arc::new(AtomicBool::new(false));
        let stopped_b = Arc::new(AtomicBool::new(false));
        let stopped_c = Arc::new(AtomicBool::new(false));
        let (mut a, _) = fake_run(JOB, Some(SID), false, false, 11);
        a.server = Some("https://a.example".into());
        a.child = Box::new(FakeChild { pid: 11, written: Default::default(), stopped: stopped_a.clone() });
        let (mut b, _) = fake_run(other_job, Some(other), false, false, 12);
        b.server = Some("https://b.example".into());
        b.child = Box::new(FakeChild { pid: 12, written: Default::default(), stopped: stopped_b.clone() });
        // A run whose server is unknown is never posted anywhere either.
        let (mut c, _) = fake_run("chat-job", None, true, false, 13);
        c.child = Box::new(FakeChild { pid: 13, written: Default::default(), stopped: stopped_c.clone() });
        runs.insert(SID.into(), a, Caps::default()).ok().unwrap();
        runs.insert(other.into(), b, Caps::default()).ok().unwrap();
        runs.insert("job:chat-job".into(), c, Caps::default()).ok().unwrap();
        let mut outbox = Outbox::open(&run_dir(&root, SID, JOB).unwrap()).unwrap();
        outbox.follow("{\"type\":\"session_events\",\"events\":[]}").unwrap();
        // The page now belongs to b (the address as the shell stores it may end in `/`).
        let listed = live_sessions_of_server(&runs, &root, Some("https://b.example/"));
        let jobs: Vec<_> = listed.iter().map(|r| r["jobId"].clone()).collect();
        assert_eq!(jobs, vec![serde_json::json!(other_job)]);
        assert!(stopped_a.load(Ordering::SeqCst), "a's run is stopped");
        assert!(stopped_c.load(Ordering::SeqCst), "the unknown server's run is stopped");
        assert!(!stopped_b.load(Ordering::SeqCst), "b's own run keeps running");
        assert_eq!(runs.keys(), vec![other.to_string()]);
        // No server at all: nothing is re-adopted.
        assert!(live_sessions_of_server(&runs, &root, None).is_empty());
        assert!(stopped_b.load(Ordering::SeqCst));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_spill_file_is_read_by_its_ids() {
        let root = scratch_root("spill");
        let dir = session_dir(&root, SID).join("spill");
        std::fs::create_dir_all(&dir).unwrap();
        let text = "line\n".repeat(30_000);
        std::fs::write(dir.join("toolu_01AbC-d_9.txt"), &text).unwrap();
        assert_eq!(read_spill(&root, SID, "toolu_01AbC-d_9").unwrap(), Some(text));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_spill_id_with_a_slash_is_refused() {
        let root = scratch_root("spill-ids");
        for bad in ["toolu_../../x", "toolu_a/b", "../toolu_a", "toolu_", "tool_a", "toolu_a.txt"] {
            assert!(read_spill(&root, SID, bad).is_err(), "{bad}");
        }
        assert!(read_spill(&root, "../x", "toolu_a").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_spill_is_none() {
        let root = scratch_root("spill-missing");
        assert_eq!(read_spill(&root, SID, "toolu_gone").unwrap(), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn session_short_name_matches_the_sidecar() {
        let id = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
        assert_eq!(session_short_name(id), "9f8e7d6c5b4a");
        assert_eq!(session_short_name("--"), "session");
        assert_eq!(
            session_dir(Path::new("/n"), id),
            PathBuf::from("/n/.sessions/9f8e7d6c5b4a")
        );
        let job = "11111111-2222-4333-8444-555555555555";
        assert_eq!(
            run_dir(Path::new("/n"), id, job).unwrap(),
            PathBuf::from(format!("/n/.sessions/9f8e7d6c5b4a/runs/{job}"))
        );
        assert!(run_dir(Path::new("/n"), id, "../../x").is_err());
        assert!(run_dir(Path::new("/n"), "a/b", job).is_err());
    }
}
