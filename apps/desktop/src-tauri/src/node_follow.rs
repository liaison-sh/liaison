// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE NODE'S FOLLOW HOST AND THE SESSION IMPORT CALL (W3 T07; D28 b, A45,
// A47, A53, A57, D47).
//
// - ONE long-lived `liaison-sidecar --follow` per node holds every follow
//   (an imported Claude Code session, a Take over's one-shot replay, the
//   read-only follow of an in-place session while VS Code drives). The shell
//   starts it lazily on the first follow and stops it 60 s after its last one
//   (shutdown line, then a kill after the grace period: the shell cannot close
//   a child's stdin, A57). Follows have their own cap (8) and never count
//   toward the live runs' (GF-72).
// - A follow's folder is resolved HERE, by name, among the shell's own shared
//   folders for the current server: no server or page value ever becomes a
//   path. The host re-validates everything again (follow-host.ts).
// - The host's lines are routed like a run's: a `session_events` line of a
//   live follow goes to that follow's outbox, then to the page; `follow_done`
//   ends the follow (`NODE_JOB_EXIT_EVENT` with `follow.why`); anything else is
//   dropped. A host exit ends every live follow `host_exit`.
// - Live follows are reported with the live runs (`node_live_sessions`,
//   `kind: "follow"`, their lease generation), so a reconnect or a reloaded
//   page never takes them for dead runs (A53).
// - `node_import` runs one `--import` sidecar at a time; a newer call replaces
//   the pending one, whose caller hears `superseded` (D47).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::node_folders::{shared_folders_at, SharedFolder};
use crate::node_job::{line_payload, NODE_JOB_EXIT_EVENT, NODE_JOB_LINE_EVENT, NO_SERVER, SPAWN_FAILED};
use crate::node_runs::{is_uuid, outbox_len, run_dir, LiveRuns, Outbox};
use crate::sidecar::{app_config_dir, kill_after_grace, resolve_base_url, sidecar_log, write_private, SHUTDOWN_LINE};

/// The node already holds `FOLLOWS_PER_NODE` follows.
pub const FOLLOW_AT_CAP: &str = "FOLLOW_AT_CAP";
/// A follow of this session is already live here.
pub const FOLLOW_RUNNING: &str = "FOLLOW_RUNNING";
/// The folder name is not one of this node's shared folders for the current server.
pub const FOLDER_NOT_SHARED: &str = "FOLDER_NOT_SHARED";
/// The recorded cwd is not a safe relative path (`safeSubdir`, node-import.ts).
pub const UNSAFE_SUBDIR: &str = "unsafe_subdir";
/// A follow request with a bad id or start position.
pub const BAD_FOLLOW: &str = "bad follow request";
/// An import op the shell does not pass on.
pub const BAD_IMPORT_OP: &str = "bad import op";
/// A pending import call replaced by a newer one (D47).
pub const SUPERSEDED: &str = "superseded";
/// The import sidecar answered nothing in time.
pub const IMPORT_TIMED_OUT: &str = "timeout";
/// The import sidecar answered nothing usable.
pub const IMPORT_FAILED: &str = "failed";

/// `NODE_IMPORT_LIMITS.followsPerNode` (packages/shared node-import.ts).
pub const FOLLOWS_PER_NODE: usize = 8;
/// The host stops this long after its last follow ended.
pub const HOST_IDLE_STOP: Duration = Duration::from_secs(60);
/// The longest an import listing or check may take.
pub const IMPORT_TIMEOUT: Duration = Duration::from_secs(30);
/// The import's request file, in the app's config directory (owner only).
pub const IMPORT_REQUEST_FILE: &str = "liaison-node-import.json";

const FOLLOW_FLAG: &str = "--follow";
const IMPORT_FLAG: &str = "--import";
const IMPORT_ANSWER: &str = "import_answer";
/// `NODE_FOLLOW_WHY` (node-import.ts).
const FOLLOW_WHYS: [&str; 5] = ["owner", "replayed", "driver_left", "transcript_gone", "host_exit"];
/// The codes a refused `follow_add` may carry (logged, never forwarded).
const FOLLOW_REFUSAL_CODES: [&str; 2] = ["not_found", "already_liaison"];
/// The most an import op may weigh (a listing query is 100 characters).
const IMPORT_OP_MAX_BYTES: usize = 4096;

/// `safeSubdir` (packages/shared node-import.ts), mirrored: POSIX separators,
/// no empty, `.` or `..` segment, no leading slash, no NUL or backslash, at
/// most 1024 characters. `""` is the folder itself.
pub fn safe_subdir(s: &str) -> bool {
    if s.chars().count() > 1024 || s.contains('\0') || s.contains('\\') {
        return false;
    }
    s.is_empty() || s.split('/').all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

/// D53: `safeWorktreePath` (packages/shared node-import.ts), mirrored: an
/// absolute path (POSIX `/…` or Windows `C:\…`) with no empty, `.` or `..`
/// segment, no trailing separator, no NUL, at most 4096 characters. A shape
/// only: the sidecar accepts it only among the worktrees its own `git
/// worktree list` names for the shared folder.
pub fn safe_worktree_path(s: &str) -> bool {
    let len = s.chars().count();
    if !(2..=4096).contains(&len) || s.contains('\0') {
        return false;
    }
    let bytes = s.as_bytes();
    let posix = s.starts_with('/');
    let windows = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] == b'\\';
    if !posix && !windows {
        return false;
    }
    let sep = if posix { '/' } else { '\\' };
    s.split(sep)
        .skip(1)
        .all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

/// A follow job, as the page starts it from the claim answer (and as the
/// shell keeps it for a reloaded page).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowRequest {
    pub session_id: String,
    pub job_id: String,
    #[serde(default)]
    pub lease_generation: Option<u64>,
    pub folder_name: String,
    /// D53: the shared folder's own git worktree outside it that `cwd_subdir`
    /// is relative to; the follow host re-checks it against git's list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    pub cwd_subdir: String,
    pub sdk_session_id: String,
    pub start_at: String,
    pub once: bool,
    pub in_place: bool,
    /// B2-1 (D52): the server that answered the claim. The start is refused
    /// unless it is the shell's current one, and a reloaded page re-adopts
    /// only the follows of its own server.
    #[serde(default)]
    pub server: Option<String>,
}

/// Ids, start position and the recorded cwd, before anything is used.
pub fn validate_request(request: &FollowRequest) -> Result<(), &'static str> {
    if !is_uuid(&request.session_id)
        || !is_uuid(&request.job_id)
        || !is_uuid(&request.sdk_session_id)
        || !matches!(request.start_at.as_str(), "window" | "end")
        || request.folder_name.is_empty()
        || request.folder_name.chars().count() > 200
    {
        return Err(BAD_FOLLOW);
    }
    if !safe_subdir(&request.cwd_subdir) {
        return Err(UNSAFE_SUBDIR);
    }
    if request.worktree_path.as_deref().is_some_and(|w| !safe_worktree_path(w)) {
        return Err(UNSAFE_SUBDIR);
    }
    Ok(())
}

/// The shell's own path of the shared folder `name` for `server`: exactly one
/// shared folder of that name, else `FOLDER_NOT_SHARED`.
pub fn follow_folder_path(dir: &Path, server: &str, name: &str) -> Result<String, &'static str> {
    folder_path_among(&shared_folders_at(dir, server), name)
}

fn folder_path_among(folders: &[SharedFolder], name: &str) -> Result<String, &'static str> {
    let mut named = folders.iter().filter(|f| f.name == name);
    match (named.next(), named.next()) {
        (Some(folder), None) => Ok(folder.path.clone()),
        _ => Err(FOLDER_NOT_SHARED),
    }
}

/// The follow host's child, as the shell holds it (a test double stands in).
pub trait HostChild: Send {
    fn write(&mut self, bytes: &[u8]) -> Result<(), String>;
    fn kill(self: Box<Self>);
}

impl HostChild for CommandChild {
    fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        CommandChild::write(self, bytes).map_err(|e| e.to_string())
    }
    fn kill(self: Box<Self>) {
        let _ = CommandChild::kill(*self);
    }
}

/// Stops the host as `stop_child_detached` stops a sidecar (sidecar.rs): the
/// shutdown line (the host flushes and exits 0), then a kill after the grace
/// period, on another thread.
pub fn stop_host(mut child: Box<dyn HostChild>) -> std::thread::JoinHandle<()> {
    let _ = child.write(format!("{SHUTDOWN_LINE}\n").as_bytes());
    kill_after_grace(child, |child| child.kill())
}

struct LiveFollow {
    request: FollowRequest,
    outbox: Outbox,
}

struct HostSlot {
    child: Box<dyn HostChild>,
    generation: u64,
}

#[derive(Default)]
pub struct FollowState {
    host: Option<HostSlot>,
    /// Keyed by job id.
    follows: HashMap<String, LiveFollow>,
    next_generation: u64,
    /// Moves on every add and end: an idle stop scheduled before is void.
    epoch: u64,
}

/// The node's follow host and its live follows (managed state).
#[derive(Default)]
pub struct FollowHost(pub Mutex<FollowState>);

/// Where one host stdout line goes.
#[derive(Debug, PartialEq)]
pub enum Routed {
    /// A live follow's events: `line_payload` plus its outbox `index`.
    Line(serde_json::Value),
    /// A follow ended: the exit payload, and a refusal code to log.
    Done(serde_json::Value, Option<String>),
    Dropped,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostLine {
    #[serde(rename = "type")]
    kind: String,
    session_id: Option<String>,
    job_id: Option<String>,
    why: Option<String>,
    end_offset: Option<u64>,
    code: Option<String>,
}

fn exit_payload(session_id: &str, job_id: &str, why: &str, end_offset: Option<u64>) -> serde_json::Value {
    let mut follow = serde_json::json!({ "why": why });
    if let Some(offset) = end_offset.filter(|_| matches!(why, "replayed" | "owner")) {
        follow["endOffset"] = offset.into();
    }
    serde_json::json!({ "jobId": job_id, "sessionId": session_id, "follow": follow })
}

impl FollowHost {
    /// Holds a new follow: checks, opens its outbox, spawns the host when
    /// none runs (answering its generation and the spawner's extra, for the
    /// caller to watch), then writes its `follow_add` line. `server` is the
    /// shell's own current server (D49 F6: the host follows a liaison-node
    /// session in place only for the server that ran it).
    pub fn add<T, S>(
        &self,
        request: FollowRequest,
        folder_path: &str,
        server: &str,
        root: &Path,
        spawn: S,
    ) -> Result<Option<(u64, T)>, String>
    where
        S: FnOnce() -> Result<(Box<dyn HostChild>, T), String>,
    {
        validate_request(&request)?;
        let mut state = self.0.lock().map_err(|_| "follow host lock poisoned".to_string())?;
        if state.follows.values().any(|f| f.request.session_id == request.session_id)
            || state.follows.contains_key(&request.job_id)
        {
            return Err(FOLLOW_RUNNING.into());
        }
        if state.follows.len() >= FOLLOWS_PER_NODE {
            return Err(FOLLOW_AT_CAP.into());
        }
        let outbox = Outbox::open(&run_dir(root, &request.session_id, &request.job_id)?)
            .map_err(|e| e.to_string())?;
        let mut line = serde_json::json!({
            "type": "follow_add",
            "sessionId": request.session_id,
            "jobId": request.job_id,
            "folderPath": folder_path,
            "cwdSubdir": request.cwd_subdir,
            "sdkSessionId": request.sdk_session_id,
            "startAt": request.start_at,
            "once": request.once,
            "inPlace": request.in_place,
            "server": server.trim_end_matches('/'),
        });
        if let Some(worktree) = request.worktree_path.as_deref() {
            line["worktreePath"] = worktree.into();
        }
        let mut spawned = None;
        if state.host.is_none() {
            let (child, extra) = spawn()?;
            state.next_generation += 1;
            let generation = state.next_generation;
            state.host = Some(HostSlot { child, generation });
            spawned = Some((generation, extra));
        }
        let host = state.host.as_mut().ok_or(SPAWN_FAILED)?;
        host.child.write(format!("{line}\n").as_bytes())?;
        state.epoch += 1;
        state.follows.insert(
            request.job_id.clone(),
            LiveFollow { request, outbox },
        );
        Ok(spawned)
    }

    /// Asks the host to end a follow (`follow_remove`): by session, by job, or
    /// both. The follow stays live until its `follow_done`. False when no
    /// live follow matches.
    pub fn remove(&self, session_id: Option<&str>, job_id: Option<&str>) -> bool {
        let Ok(mut state) = self.0.lock() else {
            return false;
        };
        let found = state
            .follows
            .values()
            .find(|f| {
                session_id.is_none_or(|s| f.request.session_id == s)
                    && job_id.is_none_or(|j| f.request.job_id == j)
                    && (session_id.is_some() || job_id.is_some())
            })
            .map(|f| (f.request.session_id.clone(), f.request.job_id.clone()));
        let Some((session, job)) = found else {
            return false;
        };
        let line = serde_json::json!({ "type": "follow_remove", "sessionId": session, "jobId": job });
        match state.host.as_mut() {
            Some(host) => host.child.write(format!("{line}\n").as_bytes()).is_ok(),
            None => false,
        }
    }

    /// Routes one stdout line of the host of `generation`.
    pub fn route(&self, generation: u64, line: &str) -> Routed {
        let Ok(head) = serde_json::from_str::<HostLine>(line) else {
            return Routed::Dropped;
        };
        let (Some(session), Some(job)) = (head.session_id.as_deref(), head.job_id.as_deref()) else {
            return Routed::Dropped;
        };
        let Ok(mut state) = self.0.lock() else {
            return Routed::Dropped;
        };
        if state.host.as_ref().map(|h| h.generation) != Some(generation) {
            return Routed::Dropped;
        }
        let ours = state
            .follows
            .get(job)
            .is_some_and(|f| f.request.session_id == session);
        if !ours {
            return Routed::Dropped;
        }
        match head.kind.as_str() {
            "session_events" => {
                let tag = Some(session.to_string());
                let mut payload = line_payload(&tag, job, line);
                if let Some(follow) = state.follows.get_mut(job) {
                    match follow.outbox.follow(line) {
                        Ok(Some(index)) => payload["index"] = index.into(),
                        Ok(None) => return Routed::Dropped,
                        // Still emitted: the page posts it live; only a reload would miss it.
                        Err(e) => eprintln!("liaison follow: the outbox refused a line ({e})"),
                    }
                }
                Routed::Line(payload)
            }
            "follow_done" => {
                state.follows.remove(job);
                state.epoch += 1;
                let why = head
                    .why
                    .as_deref()
                    .filter(|w| FOLLOW_WHYS.contains(w))
                    .unwrap_or("host_exit");
                let code = head
                    .code
                    .filter(|c| FOLLOW_REFUSAL_CODES.contains(&c.as_str()));
                Routed::Done(exit_payload(session, job, why, head.end_offset), code)
            }
            _ => Routed::Dropped,
        }
    }

    /// The host of `generation` exited: every follow it held ends `host_exit`.
    pub fn host_exited(&self, generation: u64) -> Vec<serde_json::Value> {
        let Ok(mut state) = self.0.lock() else {
            return Vec::new();
        };
        if state.host.as_ref().map(|h| h.generation) != Some(generation) {
            return Vec::new();
        }
        state.host = None;
        state.epoch += 1;
        state
            .follows
            .drain()
            .map(|(job, f)| exit_payload(&f.request.session_id, &job, "host_exit", None))
            .collect()
    }

    /// The epoch to stop the host at, when a host runs with no follow left.
    pub fn idle_epoch(&self) -> Option<u64> {
        let state = self.0.lock().ok()?;
        (state.host.is_some() && state.follows.is_empty()).then_some(state.epoch)
    }

    /// Takes the host out when it is still idle since `epoch`.
    pub fn take_if_idle(&self, epoch: u64) -> Option<Box<dyn HostChild>> {
        let mut state = self.0.lock().ok()?;
        if state.follows.is_empty() && state.epoch == epoch {
            state.host.take().map(|h| h.child)
        } else {
            None
        }
    }

    /// Takes the host and every follow out (app quit, server switch), with
    /// one `host_exit` exit per follow (D49 F9: the page posts each to the
    /// server that owned it before it leaves that server).
    pub fn drain(&self) -> (Option<Box<dyn HostChild>>, Vec<serde_json::Value>) {
        let Ok(mut state) = self.0.lock() else {
            return (None, Vec::new());
        };
        let exits = state
            .follows
            .drain()
            .map(|(job, f)| exit_payload(&f.request.session_id, &job, "host_exit", None))
            .collect();
        state.epoch += 1;
        (state.host.take().map(|h| h.child), exits)
    }

    /// B2-1 (D52): ends every follow another server claimed (or that names
    /// none) with `follow_remove`, and drops it here so none of its lines,
    /// nor its end, reaches the page of `current`. Answers how many ended.
    pub fn take_other_servers(&self, current: Option<&str>) -> usize {
        let Ok(mut state) = self.0.lock() else {
            return 0;
        };
        let current = current.and_then(crate::node_job::server_origin);
        let others: Vec<String> = state
            .follows
            .iter()
            .filter(|(_, f)| {
                current.is_none()
                    || f.request.server.as_deref().and_then(crate::node_job::server_origin) != current
            })
            .map(|(job, _)| job.clone())
            .collect();
        for job in &others {
            if let Some(f) = state.follows.remove(job) {
                let line = serde_json::json!({
                    "type": "follow_remove",
                    "sessionId": f.request.session_id,
                    "jobId": job,
                });
                if let Some(host) = state.host.as_mut() {
                    let _ = host.child.write(format!("{line}\n").as_bytes());
                }
            }
        }
        if !others.is_empty() {
            state.epoch += 1;
        }
        others.len()
    }

    /// Every live follow, as a reloaded page re-adopts it:
    /// `{sessionId, jobId, kind: "follow", leaseGeneration, request, lines}`.
    pub fn list(&self, root: &Path) -> Vec<serde_json::Value> {
        let Ok(state) = self.0.lock() else {
            return Vec::new();
        };
        let mut follows: Vec<&FollowRequest> = state.follows.values().map(|f| &f.request).collect();
        follows.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        follows
            .into_iter()
            .map(|r| {
                serde_json::json!({
                    "sessionId": r.session_id,
                    "jobId": r.job_id,
                    "kind": "follow",
                    "leaseGeneration": r.lease_generation,
                    "request": r,
                    "lines": outbox_len(root, &r.session_id, &r.job_id).unwrap_or(0),
                })
            })
            .collect()
    }
}

/// The live runs, then the live follows (C1, A53), as the page of `current`
/// re-adopts them: D50, B2-1 (D52), B2-7: the ONE path `node_live_sessions`
/// takes. A run or a follow another server claimed (or that names none) is
/// stopped and left out, so its saved lines never reach `current`.
pub fn live_sessions_for_server(
    runs: &LiveRuns,
    follows: Option<&FollowHost>,
    root: &Path,
    current: Option<&str>,
) -> Vec<serde_json::Value> {
    let mut out = crate::node_runs::live_sessions_of_server(runs, root, current);
    if let Some(follows) = follows {
        follows.take_other_servers(current);
        out.extend(follows.list(root));
    }
    out
}

// ─── Commands ────────────────────────────────────────────────────────────

/// Stops the host once it has been idle `HOST_IDLE_STOP`.
fn schedule_idle_stop<R: Runtime>(app: &AppHandle<R>) {
    let Some(epoch) = app.try_state::<FollowHost>().and_then(|h| h.idle_epoch()) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(HOST_IDLE_STOP).await;
        if let Some(child) = app.try_state::<FollowHost>().and_then(|h| h.take_if_idle(epoch)) {
            stop_host(child);
        }
    });
}

/// Reads the host's events until it exits: lines routed, stderr to the
/// sidecar log (never the page), every live follow ended on exit.
async fn watch_host<R: Runtime>(
    app: AppHandle<R>,
    generation: u64,
    pid: u32,
    mut receiver: tauri::async_runtime::Receiver<CommandEvent>,
) {
    let log = sidecar_log(&app);
    while let Some(event) = receiver.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                let line = line.trim_end();
                if line.is_empty() {
                    continue;
                }
                let Some(host) = app.try_state::<FollowHost>() else {
                    continue;
                };
                match host.route(generation, line) {
                    Routed::Line(payload) => {
                        let _ = app.emit(NODE_JOB_LINE_EVENT, payload);
                    }
                    Routed::Done(payload, code) => {
                        if let (Some(code), Some(log)) = (code, log.as_ref()) {
                            log.append(pid, &format!("follow refused: {code}"));
                        }
                        let _ = app.emit(NODE_JOB_EXIT_EVENT, payload);
                        schedule_idle_stop(&app);
                    }
                    Routed::Dropped => {}
                }
            }
            CommandEvent::Stderr(bytes) => {
                if let Some(log) = log.as_ref() {
                    log.append(pid, String::from_utf8_lossy(&bytes).trim_end());
                }
            }
            CommandEvent::Terminated(_) | CommandEvent::Error(_) => break,
            _ => {}
        }
    }
    if let Some(host) = app.try_state::<FollowHost>() {
        for payload in host.host_exited(generation) {
            let _ = app.emit(NODE_JOB_EXIT_EVENT, payload);
        }
    }
}

/// Starts a claimed follow job in the node's follow host (D28 b, A45).
#[tauri::command]
pub async fn start_node_follow<R: Runtime>(
    app: AppHandle<R>,
    request: FollowRequest,
) -> Result<serde_json::Value, String> {
    validate_request(&request)?;
    let dir = app_config_dir(&app).ok_or("no application config directory")?;
    let server = resolve_base_url(&app).ok_or(NO_SERVER)?;
    // B2-1 (D52): the server that answered the claim, before anything is used.
    crate::node_job::claimed_server(request.server.as_deref(), &server)?;
    let folder_path = follow_folder_path(&dir, &server, &request.folder_name)?;
    let root = crate::node_job::node_root(&app).ok_or("no home directory")?;
    let host = app.try_state::<FollowHost>().ok_or("no follow host state")?;
    let spawner = app.clone();
    let spawned = host.add(request, &folder_path, &server, &root, move || {
        let (receiver, child) = spawner
            .shell()
            .sidecar("liaison-sidecar")
            .map_err(|e| e.to_string())?
            .args([FOLLOW_FLAG])
            .spawn()
            .map_err(|e| {
                eprintln!("liaison: the follow host would not spawn ({e})");
                SPAWN_FAILED.to_string()
            })?;
        let pid = child.pid();
        Ok((Box::new(child) as Box<dyn HostChild>, (pid, receiver)))
    })?;
    if let Some((generation, (pid, receiver))) = spawned {
        tauri::async_runtime::spawn(watch_host(app.clone(), generation, pid, receiver));
    }
    Ok(serde_json::json!({ "started": true }))
}

/// The owner's Stop of a follow (or a stale lease): `follow_remove`. False
/// when no such follow is live.
#[tauri::command]
pub fn stop_node_follow<R: Runtime>(
    app: AppHandle<R>,
    session_id: Option<String>,
    job_id: Option<String>,
) -> bool {
    app.try_state::<FollowHost>()
        .is_some_and(|host| host.remove(session_id.as_deref(), job_id.as_deref()))
}

/// Stops the host and ends every follow `host_exit` (app quit, server
/// switch): the exits go to the page first, so each follow's `/result`
/// reaches the server it belongs to while the page still talks to it.
pub fn stop_all_follows<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(host) = app.try_state::<FollowHost>() else {
        return false;
    };
    let (child, exits) = host.drain();
    for payload in exits {
        let _ = app.emit(NODE_JOB_EXIT_EVENT, payload);
    }
    match child {
        Some(child) => {
            stop_host(child);
            true
        }
        None => false,
    }
}

// ─── The import call (S40, A42, A47, D47) ────────────────────────────────

/// Only `{kind:"list", query?, folder?, detail?}` or `{kind:"check",
/// sdkSessionId, folderName, worktreePath?, cwdSubdir}` (`nodeImportOpSchema`,
/// which the sidecar applies in full). `folder` is a shared folder's name (1
/// to 200 characters), `detail` only ever `true` (A1, A2).
pub fn validate_import_op(op: &serde_json::Value) -> Result<(), &'static str> {
    let Some(map) = op.as_object() else {
        return Err(BAD_IMPORT_OP);
    };
    let allowed: &[&str] = match map.get("kind").and_then(|k| k.as_str()) {
        Some("list") => &["kind", "query", "folder", "detail"],
        Some("check") => &["kind", "sdkSessionId", "folderName", "worktreePath", "cwdSubdir"],
        _ => return Err(BAD_IMPORT_OP),
    };
    if map.keys().any(|k| !allowed.contains(&k.as_str())) || op.to_string().len() > IMPORT_OP_MAX_BYTES {
        return Err(BAD_IMPORT_OP);
    }
    if let Some(folder) = map.get("folder") {
        let ok = folder.as_str().is_some_and(|f| (1..=200).contains(&f.chars().count()));
        if !ok {
            return Err(BAD_IMPORT_OP);
        }
    }
    if map.get("detail").is_some_and(|d| d != &serde_json::Value::Bool(true)) {
        return Err(BAD_IMPORT_OP);
    }
    Ok(())
}

/// At most this many unshared groups in one listing (`NODE_UNSHARED_GROUPS`).
pub const UNSHARED_GROUPS_MAX: usize = 50;

/// A list answer's `unsharedPaths` (the sidecar's) become `unshared` groups
/// here (S13): a name, how it reads, a count, and a token or the reason it
/// cannot be shared. A folder the shell does not show (gone, the node's own
/// scratch, a protected folder no search root covers, not a path) adds its
/// sessions to `skipped`. No path leaves the shell. Any other answer is left
/// as it is.
pub fn map_unshared_paths(
    answer: &mut serde_json::Value,
    dir: &Path,
    home: &Path,
    server: &str,
    tokens: &crate::node_folders::CandidateTokens,
    issue: bool,
) {
    let Some(map) = answer.as_object_mut() else {
        return;
    };
    let Some(paths) = map.remove("unsharedPaths") else {
        return;
    };
    let mut skipped = map.get("skipped").and_then(|v| v.as_u64()).unwrap_or(0);
    let mut groups: Vec<serde_json::Value> = Vec::new();
    for entry in paths.as_array().map(Vec::as_slice).unwrap_or_default() {
        let sessions = entry.get("sessions").and_then(|v| v.as_u64()).unwrap_or(0);
        let last = entry.get("lastModified").and_then(|v| v.as_u64()).unwrap_or(0);
        let group = entry
            .get("path")
            .and_then(|v| v.as_str())
            .filter(|_| sessions > 0)
            .and_then(|p| crate::node_folders::unshared_group_at(dir, home, server, Path::new(p), tokens, issue));
        match group {
            Some(g) if groups.len() < UNSHARED_GROUPS_MAX => groups.push(serde_json::json!({
                "name": g.name.chars().take(200).collect::<String>(),
                "display": g.display.chars().take(4096).collect::<String>(),
                "token": g.token,
                "sessions": sessions,
                "lastModified": last,
                "refusal": g.refusal,
            })),
            Some(_) => {}
            None => skipped += sessions,
        }
    }
    map.insert("unshared".into(), serde_json::Value::Array(groups));
    map.insert("skipped".into(), serde_json::json!(skipped));
}

/// The request file's content: the op, the shell's own shared folders
/// (names and paths) and the search roots the sidecar may read under (A4,
/// `import_search_roots`, the owner's settings), never a config dir or a path
/// from the page.
pub fn import_request_document(
    op: &serde_json::Value,
    folders: &[SharedFolder],
    search_roots: &[String],
) -> serde_json::Value {
    serde_json::json!({
        "op": op,
        "folders": folders
            .iter()
            .map(|f| serde_json::json!({ "name": f.name, "path": f.path }))
            .collect::<Vec<_>>(),
        "searchRoots": search_roots,
    })
}

/// A listing issues new share proofs for its unshared groups only when it
/// is the whole listing (no folder, no search): a filtered one, repeated as
/// the person types, reuses the live ones and issues none.
pub fn import_issues_tokens(op: &serde_json::Value) -> bool {
    op.get("folder").is_none()
        && op
            .get("query")
            .and_then(|q| q.as_str())
            .is_none_or(|q| q.trim().is_empty())
}

/// Writes the request file (0600) in the app's config dir.
pub fn write_import_request(dir: &Path, doc: &serde_json::Value) -> Result<PathBuf, String> {
    let path = dir.join(IMPORT_REQUEST_FILE);
    write_private(&path, &serde_json::to_vec(doc).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(path)
}

/// The sidecar's `{type:"import_answer", answer|error}` line as the answer or
/// its error code.
pub fn import_answer(line: Result<serde_json::Value, String>) -> Result<serde_json::Value, String> {
    match line {
        Ok(mut value) => match value.get_mut("answer").map(serde_json::Value::take) {
            Some(answer) if !answer.is_null() => Ok(answer),
            _ => Err(value
                .get("error")
                .and_then(|e| e.as_str())
                .unwrap_or(IMPORT_FAILED)
                .to_string()),
        },
        Err(e) if e == crate::claude_auth::AUTH_TIMED_OUT => Err(IMPORT_TIMED_OUT.into()),
        Err(_) => Err(IMPORT_FAILED.into()),
    }
}

enum Turn {
    Go,
    Superseded,
}

#[derive(Default)]
struct GateState {
    running: bool,
    pending: Option<tokio::sync::oneshot::Sender<Turn>>,
}

/// One `--import` sidecar at a time; at most one call waits, the newest.
#[derive(Default)]
pub struct ImportGate(Mutex<GateState>);

/// The running call's turn: handed to the pending call when it ends.
struct GateTurn<'a>(&'a ImportGate);

impl Drop for GateTurn<'_> {
    fn drop(&mut self) {
        let Ok(mut state) = self.0 .0.lock() else {
            return;
        };
        while let Some(next) = state.pending.take() {
            if next.send(Turn::Go).is_ok() {
                return;
            }
        }
        state.running = false;
    }
}

impl ImportGate {
    pub async fn run<F, Fut>(&self, work: F) -> Result<serde_json::Value, String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<serde_json::Value, String>>,
    {
        let wait = {
            let mut state = self.0.lock().map_err(|_| IMPORT_FAILED.to_string())?;
            if state.running {
                let (sender, receiver) = tokio::sync::oneshot::channel();
                if let Some(replaced) = state.pending.replace(sender) {
                    let _ = replaced.send(Turn::Superseded);
                }
                Some(receiver)
            } else {
                state.running = true;
                None
            }
        };
        if let Some(receiver) = wait {
            match receiver.await {
                Ok(Turn::Go) => {}
                _ => return Err(SUPERSEDED.into()),
            }
        }
        let _turn = GateTurn(self);
        work().await
    }

    #[cfg(test)]
    pub fn has_pending(&self) -> bool {
        self.0.lock().map(|s| s.pending.is_some()).unwrap_or(false)
    }
}

/// The import relay's call (S40, A42): lists the owner's sessions in the
/// shared folders, or checks one, in a one-shot `--import` sidecar.
#[tauri::command]
pub async fn node_import<R: Runtime>(
    app: AppHandle<R>,
    op: serde_json::Value,
) -> Result<serde_json::Value, String> {
    validate_import_op(&op)?;
    let dir = app_config_dir(&app).ok_or("no application config directory")?;
    let server = resolve_base_url(&app).ok_or(NO_SERVER)?;
    let gate = app.try_state::<ImportGate>().ok_or("no import state")?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    gate.run(|| async {
        let folders = shared_folders_at(&dir, &server);
        let roots = crate::node_folders::import_search_roots(&dir, &home);
        let path = write_import_request(&dir, &import_request_document(&op, &folders, &roots))?;
        let arg = path.to_string_lossy().to_string();
        let line = crate::claude_auth::run_one_line(&app, &[IMPORT_FLAG, &arg], IMPORT_ANSWER, IMPORT_TIMEOUT).await;
        let _ = std::fs::remove_file(&path);
        let mut answer = import_answer(line)?;
        map_unshared_paths(
            &mut answer,
            &dir,
            &home,
            &server,
            crate::node_folders::candidate_tokens(),
            import_issues_tokens(&op),
        );
        Ok(answer)
    })
    .await
}

#[cfg(test)]
mod node_follow_tests {
    use super::*;
    use crate::node_runs::node_runs_tests::fake_run;
    use crate::node_runs::{Caps, LiveRuns};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    const SID: &str = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
    const JOB: &str = "11111111-2222-4333-8444-555555555555";
    const SDK: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const SERVER: &str = "https://liaison.example";
    const OTHER: &str = "https://other.example";

    /// A host child that records, in order, what it was written and its kill.
    struct FakeHost {
        log: Arc<Mutex<Vec<String>>>,
    }

    impl HostChild for FakeHost {
        fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
            self.log
                .lock()
                .unwrap()
                .push(format!("write {}", String::from_utf8_lossy(bytes)));
            Ok(())
        }
        fn kill(self: Box<Self>) {
            self.log.lock().unwrap().push("kill".into());
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("liaison-follow-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The nth uuid-shaped id (distinct per n).
    fn uuid(n: u32) -> String {
        format!("{n:08x}-0000-4000-8000-000000000000")
    }

    fn request(session: &str, job: &str) -> FollowRequest {
        FollowRequest {
            session_id: session.into(),
            job_id: job.into(),
            lease_generation: Some(3),
            folder_name: "code".into(),
            worktree_path: None,
            cwd_subdir: "".into(),
            sdk_session_id: SDK.into(),
            start_at: "window".into(),
            once: false,
            in_place: false,
            server: Some(SERVER.into()),
        }
    }

    /// A host with one fake child spawned on first need; answers the host's log.
    fn add(host: &FollowHost, root: &Path, req: FollowRequest, log: &Arc<Mutex<Vec<String>>>) -> Result<Option<u64>, String> {
        let log = log.clone();
        host.add(req, "/shared/code", "https://liaison.example/", root, move || {
            Ok((Box::new(FakeHost { log }) as Box<dyn HostChild>, ()))
        })
        .map(|spawned| spawned.map(|(generation, ())| generation))
    }

    fn written(log: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
        log.lock().unwrap().clone()
    }

    #[test]
    fn follow_start_refuses_a_folder_not_shared_for_this_server() {
        let base = scratch("not-shared");
        let config = base.join("config");
        let code = base.join("code");
        let elsewhere = base.join("elsewhere");
        for d in [&config, &code, &elsewhere] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(
            config.join(crate::sidecar::RECENT_FOLDERS_FILE),
            serde_json::to_vec(&serde_json::json!({
                format!("{SERVER}#agent-a"): [code.to_string_lossy()],
                format!("{OTHER}#agent-a"): [elsewhere.to_string_lossy()],
            }))
            .unwrap(),
        )
        .unwrap();
        // The current server's folder resolves to the shell's own path.
        assert_eq!(
            follow_folder_path(&config, SERVER, "code"),
            Ok(code.to_string_lossy().into_owned())
        );
        // Another server's folder, an unknown name or a path is not shared here.
        assert_eq!(follow_folder_path(&config, SERVER, "elsewhere"), Err(FOLDER_NOT_SHARED));
        assert_eq!(follow_folder_path(&config, SERVER, "nope"), Err(FOLDER_NOT_SHARED));
        assert_eq!(
            follow_folder_path(&config, SERVER, &code.to_string_lossy()),
            Err(FOLDER_NOT_SHARED)
        );
        assert_eq!(follow_folder_path(&config, OTHER, "code"), Err(FOLDER_NOT_SHARED));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn follow_start_refuses_unsafe_subdir() {
        for bad in ["/abs", "..", "a/../b", "a//b", "./a", "a/", "a\\b", "a\0b"] {
            let mut r = request(SID, JOB);
            r.cwd_subdir = bad.into();
            assert_eq!(validate_request(&r), Err(UNSAFE_SUBDIR), "{bad:?}");
        }
        let mut long = request(SID, JOB);
        long.cwd_subdir = "a".repeat(1025);
        assert_eq!(validate_request(&long), Err(UNSAFE_SUBDIR));
        for good in ["", "sub", "sub/dir", "a.b/c-d"] {
            let mut r = request(SID, JOB);
            r.cwd_subdir = good.into();
            assert_eq!(validate_request(&r), Ok(()), "{good:?}");
        }
        // Ids and the start position are checked too.
        let mut r = request("../x", JOB);
        assert_eq!(validate_request(&r), Err(BAD_FOLLOW));
        r = request(SID, JOB);
        r.sdk_session_id = "x".into();
        assert_eq!(validate_request(&r), Err(BAD_FOLLOW));
        r = request(SID, JOB);
        r.start_at = "start".into();
        assert_eq!(validate_request(&r), Err(BAD_FOLLOW));
        // A refused request spawns nothing and writes nothing.
        let root = scratch("unsafe");
        let host = FollowHost::default();
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut bad = request(SID, JOB);
        bad.cwd_subdir = "../up".into();
        assert_eq!(add(&host, &root, bad, &log), Err(UNSAFE_SUBDIR.to_string()));
        assert!(written(&log).is_empty());
        assert!(host.list(&root).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// D53: a follow may name the shared repo's worktree outside the folder;
    /// the shell checks its shape and passes it on to the host (which checks
    /// it against git's own list); a relative or climbing path is refused.
    #[test]
    fn follow_start_passes_a_worktree_path_on_and_refuses_an_unsafe_one() {
        for bad in ["", "/", "rel/wt", "/a/../b", "/a/./b", "/a//b", "/a/", "/a\0b", "C:wt"] {
            let mut r = request(SID, JOB);
            r.worktree_path = Some(bad.into());
            assert_eq!(validate_request(&r), Err(UNSAFE_SUBDIR), "{bad:?}");
        }
        let mut long = request(SID, JOB);
        long.worktree_path = Some(format!("/{}", "a".repeat(4096)));
        assert_eq!(validate_request(&long), Err(UNSAFE_SUBDIR));
        for good in ["/tmp/repo-wt", "C:\\Users\\me\\wt"] {
            let mut r = request(SID, JOB);
            r.worktree_path = Some(good.into());
            assert_eq!(validate_request(&r), Ok(()), "{good:?}");
        }
        // The claim's camelCase field reaches the request.
        let parsed: FollowRequest = serde_json::from_value(serde_json::json!({
            "sessionId": SID, "jobId": JOB, "folderName": "code", "cwdSubdir": "pkg",
            "worktreePath": "/tmp/repo-wt", "sdkSessionId": SDK, "startAt": "window",
            "once": false, "inPlace": false,
        }))
        .unwrap();
        assert_eq!(parsed.worktree_path.as_deref(), Some("/tmp/repo-wt"));
        let root = scratch("worktree");
        let host = FollowHost::default();
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut r = request(SID, JOB);
        r.worktree_path = Some("/tmp/repo-wt".into());
        r.cwd_subdir = "pkg".into();
        add(&host, &root, r, &log).unwrap();
        let line = written(&log)
            .into_iter()
            .find(|l| l.contains("follow_add"))
            .unwrap();
        let value: serde_json::Value =
            serde_json::from_str(line.trim_start_matches("write ").trim()).unwrap();
        assert_eq!(value["worktreePath"], serde_json::json!("/tmp/repo-wt"));
        assert_eq!(value["folderPath"], serde_json::json!("/shared/code"));
        assert_eq!(value["cwdSubdir"], serde_json::json!("pkg"));
        // None: no key at all (the folder itself).
        let host = FollowHost::default();
        let log = Arc::new(Mutex::new(Vec::new()));
        add(&host, &root, request(SID, JOB), &log).unwrap();
        assert!(!written(&log).iter().any(|l| l.contains("worktreePath")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn follow_cap_is_eight_and_not_counted_in_live_runs() {
        let root = scratch("cap");
        let host = FollowHost::default();
        let log = Arc::new(Mutex::new(Vec::new()));
        let spawns = Arc::new(AtomicUsize::new(0));
        for n in 0..FOLLOWS_PER_NODE as u32 {
            let counted = spawns.clone();
            let log = log.clone();
            host.add(request(&uuid(n), &uuid(100 + n)), "/shared/code", "https://liaison.example", &root, move || {
                counted.fetch_add(1, Ordering::SeqCst);
                Ok((Box::new(FakeHost { log }) as Box<dyn HostChild>, ()))
            })
            .unwrap();
        }
        // One host process for all eight.
        assert_eq!(spawns.load(Ordering::SeqCst), 1);
        assert_eq!(
            add(&host, &root, request(&uuid(50), &uuid(150)), &log),
            Err(FOLLOW_AT_CAP.to_string())
        );
        // A second follow of a live session replaces nothing.
        assert_eq!(
            add(&host, &root, request(&uuid(0), &uuid(151)), &log),
            Err(FOLLOW_RUNNING.to_string())
        );
        // The live runs keep their whole cap: four runs still start.
        let runs = LiveRuns::default();
        for n in 0..4u32 {
            let (run, _) = fake_run(&uuid(200 + n), Some(&uuid(300 + n)), false, false, n + 1);
            runs.insert(uuid(300 + n), run, Caps::default()).ok().unwrap();
        }
        assert_eq!(host.list(&root).len(), FOLLOWS_PER_NODE);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn follow_lines_route_by_session_and_job() {
        let root = scratch("route");
        let host = FollowHost::default();
        let log = Arc::new(Mutex::new(Vec::new()));
        let generation = add(&host, &root, request(SID, JOB), &log).unwrap().unwrap();
        let other = uuid(9);
        let other_job = uuid(10);
        assert_eq!(add(&host, &root, request(&other, &other_job), &log), Ok(None));
        // Each follow_add line names the shell's own folder path.
        let lines = written(&log);
        assert_eq!(lines.len(), 2);
        let first: serde_json::Value =
            serde_json::from_str(lines[0].trim_start_matches("write ").trim_end()).unwrap();
        assert_eq!(
            first,
            serde_json::json!({ "type": "follow_add", "sessionId": SID, "jobId": JOB, "folderPath": "/shared/code", "cwdSubdir": "", "sdkSessionId": SDK, "startAt": "window", "once": false, "inPlace": false, "server": "https://liaison.example" })
        );
        let events = |s: &str, j: &str| {
            format!("{{\"type\":\"session_events\",\"sessionId\":\"{s}\",\"jobId\":\"{j}\",\"events\":[]}}")
        };
        match host.route(generation, &events(SID, JOB)) {
            Routed::Line(payload) => assert_eq!(
                payload,
                serde_json::json!({ "jobId": JOB, "sessionId": SID, "line": events(SID, JOB), "index": 1 })
            ),
            other => panic!("not routed: {other:?}"),
        }
        match host.route(generation, &events(&other, &other_job)) {
            Routed::Line(payload) => {
                assert_eq!(payload["sessionId"], other.as_str());
                assert_eq!(payload["index"], 1);
            }
            other => panic!("not routed: {other:?}"),
        }
        // The line went to that follow's outbox, as a run's does.
        assert_eq!(crate::node_runs::outbox_len(&root, SID, JOB).unwrap(), 1);
        // A line naming an unknown follow, a crossed pair, or from an old host is dropped.
        assert_eq!(host.route(generation, &events(SID, &other_job)), Routed::Dropped);
        assert_eq!(host.route(generation, &events(&uuid(77), JOB)), Routed::Dropped);
        assert_eq!(host.route(generation + 1, &events(SID, JOB)), Routed::Dropped);
        assert_eq!(host.route(generation, "not json"), Routed::Dropped);
        assert_eq!(crate::node_runs::outbox_len(&root, SID, JOB).unwrap(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn follow_done_emits_exit_with_why() {
        let root = scratch("done");
        let host = FollowHost::default();
        let log = Arc::new(Mutex::new(Vec::new()));
        let generation = add(&host, &root, request(SID, JOB), &log).unwrap().unwrap();
        let second = uuid(5);
        let second_job = uuid(6);
        add(&host, &root, request(&second, &second_job), &log).unwrap();
        let done = format!(
            "{{\"type\":\"follow_done\",\"sessionId\":\"{SID}\",\"jobId\":\"{JOB}\",\"why\":\"replayed\",\"endOffset\":4096}}"
        );
        assert_eq!(
            host.route(generation, &done),
            Routed::Done(
                serde_json::json!({ "jobId": JOB, "sessionId": SID, "follow": { "why": "replayed", "endOffset": 4096 } }),
                None
            )
        );
        // The follow is gone: a second done for it is dropped.
        assert_eq!(host.route(generation, &done), Routed::Dropped);
        // A refused follow_add's code is tolerated (logged), never forwarded,
        // and an endOffset beside any other why is not forwarded either.
        let refused = format!(
            "{{\"type\":\"follow_done\",\"sessionId\":\"{second}\",\"jobId\":\"{second_job}\",\"why\":\"transcript_gone\",\"code\":\"already_liaison\",\"endOffset\":9}}"
        );
        assert_eq!(
            host.route(generation, &refused),
            Routed::Done(
                serde_json::json!({ "jobId": second_job, "sessionId": second, "follow": { "why": "transcript_gone" } }),
                Some("already_liaison".into())
            )
        );
        assert!(host.list(&root).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn follow_host_exit_ends_every_follow_with_host_exit() {
        let root = scratch("host-exit");
        let host = FollowHost::default();
        let log = Arc::new(Mutex::new(Vec::new()));
        let generation = add(&host, &root, request(SID, JOB), &log).unwrap().unwrap();
        add(&host, &root, request(&uuid(5), &uuid(6)), &log).unwrap();
        // An older host's exit ends nothing.
        assert!(host.host_exited(generation + 1).is_empty());
        let mut ended = host.host_exited(generation);
        ended.sort_by_key(|p| p["jobId"].as_str().unwrap_or("").to_string());
        assert_eq!(
            ended,
            vec![
                serde_json::json!({ "jobId": uuid(6), "sessionId": uuid(5), "follow": { "why": "host_exit" } }),
                serde_json::json!({ "jobId": JOB, "sessionId": SID, "follow": { "why": "host_exit" } }),
            ]
        );
        assert!(host.list(&root).is_empty());
        // The next follow starts a new host.
        assert!(add(&host, &root, request(SID, &uuid(7)), &log).unwrap().is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn server_switch_drain_ends_every_follow_with_host_exit() {
        let root = scratch("drain");
        let host = FollowHost::default();
        let log = Arc::new(Mutex::new(Vec::new()));
        let generation = add(&host, &root, request(SID, JOB), &log).unwrap().unwrap();
        add(&host, &root, request(&uuid(5), &uuid(6)), &log).unwrap();
        let (child, mut ended) = host.drain();
        assert!(child.is_some());
        ended.sort_by_key(|p| p["jobId"].as_str().unwrap_or("").to_string());
        assert_eq!(
            ended,
            vec![
                serde_json::json!({ "jobId": uuid(6), "sessionId": uuid(5), "follow": { "why": "host_exit" } }),
                serde_json::json!({ "jobId": JOB, "sessionId": SID, "follow": { "why": "host_exit" } }),
            ]
        );
        assert!(host.list(&root).is_empty());
        // The drained host's own exit ends nothing twice.
        assert!(host.host_exited(generation).is_empty());
        let (none, again) = host.drain();
        assert!(none.is_none() && again.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn follow_host_stops_after_idle() {
        let root = scratch("idle");
        let host = FollowHost::default();
        let log = Arc::new(Mutex::new(Vec::new()));
        let generation = add(&host, &root, request(SID, JOB), &log).unwrap().unwrap();
        // Busy: no idle stop is due.
        assert_eq!(host.idle_epoch(), None);
        // The owner's Stop writes follow_remove; the follow stays until its done line.
        assert!(host.remove(Some(SID), None));
        let last: serde_json::Value = serde_json::from_str(
            written(&log).last().unwrap().trim_start_matches("write ").trim_end(),
        )
        .unwrap();
        assert_eq!(
            last,
            serde_json::json!({ "type": "follow_remove", "sessionId": SID, "jobId": JOB })
        );
        assert!(host.idle_epoch().is_none());
        let done = format!(
            "{{\"type\":\"follow_done\",\"sessionId\":\"{SID}\",\"jobId\":\"{JOB}\",\"why\":\"owner\",\"endOffset\":12}}"
        );
        assert!(matches!(host.route(generation, &done), Routed::Done(..)));
        let epoch = host.idle_epoch().expect("idle once the last follow ended");
        // A follow added meanwhile cancels that stop.
        add(&host, &root, request(&uuid(5), &uuid(6)), &log).unwrap();
        assert!(host.take_if_idle(epoch).is_none());
        let done = format!(
            "{{\"type\":\"follow_done\",\"sessionId\":\"{}\",\"jobId\":\"{}\",\"why\":\"owner\"}}",
            uuid(5),
            uuid(6)
        );
        assert!(matches!(host.route(generation, &done), Routed::Done(..)));
        let epoch = host.idle_epoch().unwrap();
        let child = host.take_if_idle(epoch).expect("the idle host is taken");
        stop_host(child).join().unwrap();
        let lines = written(&log);
        let n = lines.len();
        assert_eq!(lines[n - 2], format!("write {}\n", crate::sidecar::SHUTDOWN_LINE));
        assert_eq!(lines[n - 1], "kill");
        // Taken once.
        assert!(host.take_if_idle(epoch).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn import_request_file_carries_the_shells_folders_and_no_config_dir() {
        let folders = vec![
            crate::node_folders::SharedFolder {
                name: "code".into(),
                path: "/shared/code".into(),
                kind: "repo",
                git_default_branch: Some("main".into()),
            },
            crate::node_folders::SharedFolder {
                name: "notes".into(),
                path: "/shared/notes".into(),
                kind: "root",
                git_default_branch: None,
            },
        ];
        let op = serde_json::json!({ "kind": "list", "configDir": "/tmp/evil", "folders": [{ "name": "x", "path": "/" }] });
        // A page op carrying anything but the op's own fields is refused.
        assert_eq!(validate_import_op(&op), Err(BAD_IMPORT_OP));
        let op = serde_json::json!({ "kind": "check", "sdkSessionId": SDK, "folderName": "code", "cwdSubdir": "sub" });
        assert_eq!(validate_import_op(&op), Ok(()));
        // D53: a check may name the worktree the row was listed in.
        let op = serde_json::json!({ "kind": "check", "sdkSessionId": SDK, "folderName": "code", "worktreePath": "/tmp/code-wt", "cwdSubdir": "" });
        assert_eq!(validate_import_op(&op), Ok(()));
        assert_eq!(validate_import_op(&serde_json::json!({ "kind": "delete" })), Err(BAD_IMPORT_OP));
        assert_eq!(validate_import_op(&serde_json::json!("list")), Err(BAD_IMPORT_OP));
        let roots = vec!["/Volumes/Disk/code".to_string()];
        let doc = import_request_document(&op, &folders, &roots);
        assert_eq!(
            doc,
            serde_json::json!({
                "op": op,
                "folders": [
                    { "name": "code", "path": "/shared/code" },
                    { "name": "notes", "path": "/shared/notes" },
                ],
                "searchRoots": ["/Volumes/Disk/code"],
            })
        );
        assert!(!doc.to_string().contains("configDir"));
        // The file is the owner's only.
        let dir = scratch("import-file");
        let path = write_import_request(&dir, &doc).unwrap();
        assert!(path.starts_with(&dir));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let back: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(back, doc);
        // The answer line becomes the answer, or its error code.
        assert_eq!(
            import_answer(Ok(serde_json::json!({ "type": "import_answer", "answer": { "rows": [], "truncated": false } }))),
            Ok(serde_json::json!({ "rows": [], "truncated": false }))
        );
        assert_eq!(
            import_answer(Ok(serde_json::json!({ "type": "import_answer", "error": "invalid_request" }))),
            Err("invalid_request".to_string())
        );
        assert_eq!(
            import_answer(Err(crate::claude_auth::AUTH_TIMED_OUT.into())),
            Err(IMPORT_TIMED_OUT.to_string())
        );
        assert_eq!(import_answer(Err("other".into())), Err(IMPORT_FAILED.to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// B2-1 (D52), B2-7: what a reloaded page re-adopts goes through ONE
    /// function, the one `node_live_sessions` calls with the follow host the
    /// app always manages: the runs AND the follows another server claimed
    /// (or that name no server) are stopped and left out.
    #[test]
    fn b2_1_live_sessions_for_a_server_stop_and_leave_out_another_servers_runs_and_follows() {
        use crate::node_runs::node_runs_tests::FakeChild;
        use std::sync::atomic::AtomicBool;
        let root = scratch("live-for-server");
        let runs = LiveRuns::default();
        let stopped_other = Arc::new(AtomicBool::new(false));
        let stopped_ours = Arc::new(AtomicBool::new(false));
        let (mut theirs, _) = fake_run(&uuid(51), Some(&uuid(50)), false, false, 21);
        theirs.server = Some(OTHER.into());
        theirs.child = Box::new(FakeChild { pid: 21, written: Default::default(), stopped: stopped_other.clone() });
        let (mut ours, _) = fake_run(&uuid(53), Some(&uuid(52)), false, false, 22);
        ours.server = Some(format!("{SERVER}/"));
        ours.child = Box::new(FakeChild { pid: 22, written: Default::default(), stopped: stopped_ours.clone() });
        runs.insert(uuid(50), theirs, Caps::default()).ok().unwrap();
        runs.insert(uuid(52), ours, Caps::default()).ok().unwrap();
        let host = FollowHost::default();
        let log = Arc::new(Mutex::new(Vec::new()));
        add(&host, &root, request(SID, JOB), &log).unwrap();
        let mut other_follow = request(&uuid(60), &uuid(61));
        other_follow.server = Some(OTHER.into());
        add(&host, &root, other_follow, &log).unwrap();
        let mut untagged = request(&uuid(62), &uuid(63));
        untagged.server = None;
        add(&host, &root, untagged, &log).unwrap();

        let listed = live_sessions_for_server(&runs, Some(&host), &root, Some(&format!("{SERVER}/")));
        let jobs: Vec<String> = listed.iter().map(|r| r["jobId"].as_str().unwrap().to_string()).collect();
        assert_eq!(jobs, vec![uuid(53), JOB.to_string()]);
        assert!(stopped_other.load(Ordering::SeqCst), "the other server's run is stopped");
        assert!(!stopped_ours.load(Ordering::SeqCst), "this server's run keeps running");
        // The other server's follow and the untagged one are ended in the host.
        let removes: Vec<String> = written(&log).into_iter().filter(|l| l.contains("follow_remove")).collect();
        assert_eq!(removes.len(), 2, "{removes:?}");
        assert!(removes.iter().any(|l| l.contains(&uuid(61))));
        assert!(removes.iter().any(|l| l.contains(&uuid(63))));
        // Their lines are never routed to the page again.
        let line = format!("{{\"type\":\"session_events\",\"sessionId\":\"{}\",\"jobId\":\"{}\",\"events\":[]}}", uuid(60), uuid(61));
        assert_eq!(host.route(1, &line), Routed::Dropped);
        // With no follow host (never in production, main.rs manages one) the runs are still filtered.
        assert!(live_sessions_for_server(&runs, None, &root, Some(OTHER)).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn live_sessions_lists_live_follows_with_kind_and_lease_generation() {
        let root = scratch("live");
        let runs = LiveRuns::default();
        let run_session = uuid(40);
        let run_job = uuid(41);
        let (mut run, _) = fake_run(&run_job, Some(&run_session), false, false, 11);
        run.server = Some(SERVER.into());
        runs.insert(run_session.clone(), run, Caps::default()).ok().unwrap();
        let host = FollowHost::default();
        let log = Arc::new(Mutex::new(Vec::new()));
        let generation = add(&host, &root, request(SID, JOB), &log).unwrap().unwrap();
        let line = format!("{{\"type\":\"session_events\",\"sessionId\":\"{SID}\",\"jobId\":\"{JOB}\",\"events\":[]}}");
        host.route(generation, &line);
        host.route(generation, &line);
        let listed = live_sessions_for_server(&runs, Some(&host), &root, Some(SERVER));
        assert_eq!(listed.len(), 2);
        // The run is listed as before.
        assert_eq!(listed[0]["jobId"], run_job.as_str());
        assert!(listed[0].get("kind").is_none());
        assert_eq!(
            listed[1],
            serde_json::json!({
                "sessionId": SID,
                "jobId": JOB,
                "kind": "follow",
                "leaseGeneration": 3,
                "request": {
                    "sessionId": SID, "jobId": JOB, "leaseGeneration": 3, "folderName": "code",
                    "cwdSubdir": "", "sdkSessionId": SDK, "startAt": "window", "once": false, "inPlace": false,
                    "server": SERVER,
                },
                "lines": 2,
            })
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn node_import_runs_one_sidecar_at_a_time_and_supersedes_the_pending_call() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async {
            let gate = Arc::new(ImportGate::default());
            let spawned = Arc::new(AtomicUsize::new(0));
            let live = Arc::new(AtomicUsize::new(0));
            let most = Arc::new(AtomicUsize::new(0));
            let (release, released) = tokio::sync::oneshot::channel::<()>();
            let released = Arc::new(tokio::sync::Mutex::new(Some(released)));
            let call = |name: &'static str| {
                let gate = gate.clone();
                let spawned = spawned.clone();
                let live = live.clone();
                let most = most.clone();
                let released = released.clone();
                tokio::spawn(async move {
                    gate.run(|| async move {
                        spawned.fetch_add(1, Ordering::SeqCst);
                        let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                        most.fetch_max(now, Ordering::SeqCst);
                        // The first sidecar holds until released.
                        if name == "a" {
                            if let Some(wait) = released.lock().await.take() {
                                let _ = wait.await;
                            }
                        }
                        live.fetch_sub(1, Ordering::SeqCst);
                        Ok(serde_json::json!(name))
                    })
                    .await
                })
            };
            let a = call("a");
            while spawned.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            let b = call("b");
            while !gate.has_pending() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            let c = call("c");
            // The pending call is replaced: its caller hears superseded.
            assert_eq!(b.await.unwrap(), Err(SUPERSEDED.to_string()));
            assert_eq!(spawned.load(Ordering::SeqCst), 1);
            release.send(()).unwrap();
            assert_eq!(a.await.unwrap(), Ok(serde_json::json!("a")));
            assert_eq!(c.await.unwrap(), Ok(serde_json::json!("c")));
            assert_eq!(spawned.load(Ordering::SeqCst), 2);
            assert_eq!(most.load(Ordering::SeqCst), 1);
            // The gate is free again.
            assert!(!gate.has_pending());
            assert_eq!(gate.run(|| async { Ok(serde_json::json!(1)) }).await, Ok(serde_json::json!(1)));
        });
    }

    /// A2: a list may name one shared folder and ask for the detail; nothing else.
    #[test]
    fn a_list_op_may_carry_a_folder_and_detail_and_nothing_else() {
        let ok = |v: serde_json::Value| validate_import_op(&v);
        assert_eq!(ok(serde_json::json!({ "kind": "list" })), Ok(()));
        assert_eq!(ok(serde_json::json!({ "kind": "list", "query": "fix", "folder": "code", "detail": true })), Ok(()));
        assert_eq!(ok(serde_json::json!({ "kind": "list", "folder": "x".repeat(200) })), Ok(()));
        for bad in [
            serde_json::json!({ "kind": "list", "folder": "" }),
            serde_json::json!({ "kind": "list", "folder": "x".repeat(201) }),
            serde_json::json!({ "kind": "list", "folder": 3 }),
            serde_json::json!({ "kind": "list", "detail": false }),
            serde_json::json!({ "kind": "list", "detail": "yes" }),
            serde_json::json!({ "kind": "list", "path": "/etc" }),
            serde_json::json!({ "kind": "check", "sdkSessionId": SDK, "folderName": "code", "cwdSubdir": "", "detail": true }),
        ] {
            assert_eq!(ok(bad.clone()), Err(BAD_IMPORT_OP), "{bad}");
        }
    }

    /// S13, A4, A8, A12, A13: the sidecar's paths become groups with a token
    /// or a reason; what is not shown counts as skipped; no path leaves.
    #[test]
    fn unshared_paths_become_groups_and_no_path_leaves_the_shell() {
        let base = std::fs::canonicalize(scratch("unshared-map")).unwrap();
        let config = base.join("config");
        let home = base.join("home");
        let code = home.join("code");
        let node_root = home.join(crate::node_job::NODE_ROOT_NAME);
        for d in [
            &config,
            &code.join("app"),
            &home.join("loose"),
            &home.join(".hidden/tool"),
            &home.join("Documents/private"),
            &node_root.join("worktrees/wt1"),
        ] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(
            config.join(crate::node_job::NODE_SETTINGS_FILE),
            serde_json::to_vec(&serde_json::json!({ "searchRoots": [code.to_string_lossy()] })).unwrap(),
        )
        .unwrap();
        let entry = |p: &std::path::Path, n: u64| {
            serde_json::json!({ "path": p.to_string_lossy(), "sessions": n, "lastModified": 1000 + n })
        };
        let mut answer = serde_json::json!({
            "rows": [],
            "truncated": false,
            "folders": [{ "name": "shared", "sessions": 4 }],
            "skipped": 1,
            "unsharedPaths": [
                entry(&code.join("app"), 3),
                entry(&home.join("loose"), 2),
                entry(&home, 5),
                entry(&home.join(".hidden/tool"), 1),
                entry(&code.join("gone"), 7),
                entry(&node_root.join("worktrees/wt1"), 11),
                entry(&home.join("Documents/private"), 13),
                serde_json::json!({ "path": "relative/x", "sessions": 17, "lastModified": 0 }),
            ],
        });
        let tokens = crate::node_folders::CandidateTokens::default();
        map_unshared_paths(&mut answer, &config, &home, "https://liaison.acme.example", &tokens, true);
        assert!(answer.get("unsharedPaths").is_none());
        // 1 before + gone 7 + scratch 11 + protected 13 + relative 17.
        assert_eq!(answer["skipped"], 49);
        assert_eq!(answer["folders"][0]["sessions"], 4);
        let groups = answer["unshared"].as_array().unwrap();
        let view: Vec<(String, String, u64, serde_json::Value)> = groups
            .iter()
            .map(|g| {
                (
                    g["name"].as_str().unwrap().to_string(),
                    g["display"].as_str().unwrap().to_string(),
                    g["sessions"].as_u64().unwrap(),
                    g["refusal"].clone(),
                )
            })
            .collect();
        assert_eq!(
            view,
            vec![
                ("app".into(), "~/code/app".into(), 3, serde_json::Value::Null),
                ("loose".into(), "~/loose".into(), 2, serde_json::json!("outside_search")),
                ("home".into(), "~".into(), 5, serde_json::json!("home")),
                ("tool".into(), "~/.hidden/tool".into(), 1, serde_json::json!("hidden")),
            ]
        );
        assert_eq!(groups[0]["lastModified"], 1003);
        let token = groups[0]["token"].as_str().unwrap();
        assert_eq!(token.len(), 32);
        assert!(groups[1..].iter().all(|g| g["token"].is_null()));
        // A listing repeated reuses the live proof; a filtered one issues none.
        let mut again = serde_json::json!({ "unsharedPaths": [entry(&code.join("app"), 3)] });
        map_unshared_paths(&mut again, &config, &home, "https://liaison.acme.example", &tokens, true);
        assert_eq!(again["unshared"][0]["token"], groups[0]["token"]);
        let fresh = crate::node_folders::CandidateTokens::default();
        let mut filtered = serde_json::json!({ "unsharedPaths": [entry(&code.join("app"), 3)] });
        map_unshared_paths(&mut filtered, &config, &home, "https://liaison.acme.example", &fresh, false);
        assert!(filtered["unshared"][0]["token"].is_null());
        assert_eq!(filtered["unshared"][0]["refusal"], serde_json::Value::Null);
        let mut filtered = serde_json::json!({ "unsharedPaths": [entry(&code.join("app"), 3)] });
        map_unshared_paths(&mut filtered, &config, &home, "https://liaison.acme.example", &tokens, false);
        assert_eq!(filtered["unshared"][0]["token"], groups[0]["token"]);
        // The token shares that folder, through the node's own check.
        let shared = crate::node_folders::share_at(&config, &home, "https://liaison.acme.example", &tokens, Some(token), None).unwrap();
        assert_eq!(shared, code.join("app"));
        // Every group matches the shared schema's keys, and no path is in the answer.
        for g in groups {
            let mut keys: Vec<&String> = g.as_object().unwrap().keys().collect();
            keys.sort();
            assert_eq!(keys, vec!["display", "lastModified", "name", "refusal", "sessions", "token"]);
        }
        let text = answer.to_string();
        assert!(!text.contains(&base.to_string_lossy().into_owned()), "{text}");
        assert!(!text.contains("relative/x"));
        // An answer without unsharedPaths (an older sidecar, a check) is left as it is.
        let mut plain = serde_json::json!({ "rows": [], "truncated": false });
        map_unshared_paths(&mut plain, &config, &home, "https://liaison.acme.example", &tokens, true);
        assert_eq!(plain, serde_json::json!({ "rows": [], "truncated": false }));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn only_a_whole_listing_issues_share_proofs() {
        let list = |v: serde_json::Value| import_issues_tokens(&v);
        assert!(list(serde_json::json!({ "kind": "list", "detail": true })));
        assert!(list(serde_json::json!({ "kind": "list", "query": "  ", "detail": true })));
        assert!(!list(serde_json::json!({ "kind": "list", "query": "fix", "detail": true })));
        assert!(!list(serde_json::json!({ "kind": "list", "folder": "code", "detail": true })));
    }

    /// At most 50 groups; the rest are not counted as skipped (they are not
    /// refused, only beyond the cap the sidecar already applies).
    #[test]
    fn unshared_groups_are_capped() {
        let base = std::fs::canonicalize(scratch("unshared-cap")).unwrap();
        let config = base.join("config");
        let home = base.join("home");
        let code = home.join("code");
        std::fs::create_dir_all(&config).unwrap();
        let mut paths = Vec::new();
        for i in 0..60 {
            let p = code.join(format!("p{i:02}"));
            std::fs::create_dir_all(&p).unwrap();
            paths.push(serde_json::json!({ "path": p.to_string_lossy(), "sessions": 1, "lastModified": i }));
        }
        std::fs::write(
            config.join(crate::node_job::NODE_SETTINGS_FILE),
            serde_json::to_vec(&serde_json::json!({ "searchRoots": [code.to_string_lossy()] })).unwrap(),
        )
        .unwrap();
        let mut answer = serde_json::json!({ "rows": [], "truncated": false, "unsharedPaths": paths });
        let tokens = crate::node_folders::CandidateTokens::default();
        map_unshared_paths(&mut answer, &config, &home, "https://liaison.acme.example", &tokens, true);
        assert_eq!(answer["unshared"].as_array().unwrap().len(), UNSHARED_GROUPS_MAX);
        assert_eq!(answer["skipped"], 0);
        let _ = std::fs::remove_dir_all(&base);
    }
}
