// SPDX-License-Identifier: FSL-1.1-ALv2
//
// UNATTENDED NODE JOBS, THE SHELL'S HALF (P4 N-D T5; spec-node.md "Profiles and
// unattended mode", A15, A21, A27, A49, F10).
//
// The page claims a job from the server and asks the shell to run it. The shell
// decides, from what is on THIS computer, whether it may:
//
// - THE LEVEL (D24, D41, D42, P1-T37): an unattended job runs a session at a
//   level of the shared table (node-levels.json). The shell keeps one level
//   pin per agent and server; a start above the pin needs a level
//   confirmation the owner gave in the app, consumed here through the server
//   with the window's session and this node's credential.
// - STRICT AND STANDARD NEED THE OS SANDBOX, which Windows does not have (A15).
// - A JOB NEVER STARTS A DEVICE GRANT (F10). The agent's Liaison connection is
//   found in the token store, or minted with the window's session before the
//   claim (`ensure_node_agent_connection`, no dialog); My node chat's
//   recovery asks first (`confirm_node_connection`, D43). A job that finds
//   none fails `auth_required`.
// - No git host token is stored here (D17): git and gh in a session use this
//   computer's own logins, which the sidecar reads at job start. There is no
//   branch-protection check on any host (D20): the pre-push hook and the
//   guard refuse the default branch everywhere.
//
// The job runs in its OWN sidecar (`--unattended <job file>`), beside and never
// instead of an interactive local session. Sessions run side by side, one
// sidecar per live session, up to the node's cap (P3, node_runs.rs); My node
// chat stays one turn at a time.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_shell::ShellExt;

use crate::auth::{AuthError, StoredToken};
use crate::node_folders::{shared_folders_at, SharedFolder};
use crate::node_follow::{safe_subdir, safe_worktree_path};
use crate::node_runs::{
    control_line_ok, create_private_dir, is_uuid, read_ack, read_outbox, run_dir,
    run_key, write_ack, Caps, LiveRun, LiveRuns, Outbox, OUTBOX_READ_MAX,
};
use crate::permission_gate::{decide, record_prompt_line, retire_all, ShellAskBook};
use crate::sidecar::{
    app_config_dir, follow_child, resolve_base_url, resolve_mcp_url, save_token, token_key,
    token_store_path, write_private,
};
use crate::sidecar_watch::{BootOutcome, BOOT_TIMEOUT};

/// The confirmed profile hashes, per server and agent.
pub const NODE_PROFILES_FILE: &str = "liaison-node-profiles.json";
/// The level each session was last admitted at (P3-fix M2), apart from the
/// agents' pins so it is never published as one.
pub const NODE_SESSION_LEVELS_FILE: &str = "liaison-node-session-levels.json";
/// My node chat's job file (a session's is in its run directory).
pub const NODE_JOB_FILE: &str = "liaison-node-job.json";
/// My node chat's own --mcp-config (it carries a live token). A session run
/// has its own, named after its job, so parallel runs never share one.
pub const NODE_MCP_CONFIG_FILE: &str = "liaison-node-mcp-config.json";
/// A session run's job file, in its run directory.
pub const RUN_JOB_FILE: &str = "job.json";
/// One stdout line of the job's sidecar.
pub const NODE_JOB_LINE_EVENT: &str = "node-job-line";
/// The job's sidecar exited.
pub const NODE_JOB_EXIT_EVENT: &str = "node-job-exit";
/// The folder jobs run in, under the home directory.
pub const NODE_ROOT_NAME: &str = "Liaison Node";

/// The refusals `start_node_job` answers with: the server's fail codes
/// (job-routes.ts NODE_FAIL_CODES) where there is one.
/// A start above this computer's pin, without a confirmation it could consume (D24).
pub const LEVEL_UNCONFIRMED: &str = "level_unconfirmed";
/// The job's sidecar did not start in time (L25).
pub const TIMEOUT: &str = "timeout";
/// What a boot timeout means, in words.
pub const BOOT_TIMEOUT_TEXT: &str = "Claude Code did not start within 30 s";
pub const AUTH_REQUIRED: &str = "auth_required";
pub const SANDBOX_UNAVAILABLE: &str = "sandbox_unavailable";
pub const JOB_RUNNING: &str = "JobRunning";
pub const NO_SERVER: &str = "NoServer";

/// B2-1 (D52): a start claimed from another server than the shell's current one.
pub const SERVER_CHANGED: &str = "server_changed";

/// An address's origin (`scheme://host[:port]`), the form the page names its server in.
pub(crate) fn server_origin(address: &str) -> Option<String> {
    let parsed = url::Url::parse(address.trim()).ok()?;
    matches!(parsed.scheme(), "http" | "https").then(|| parsed.origin().ascii_serialization())
}

/// B2-1 (D52): a start (a run or a follow) names the server that answered
/// its claim. The page settles a server switch after the shell has moved, so
/// a start claimed from the server being left would otherwise run under the
/// next one: its folder resolved there, its level admitted there with the
/// old server's token. Refused unless the claim's server is the shell's
/// current one; a start that names none is refused too.
pub fn claimed_server(claimed: Option<&str>, current: &str) -> Result<(), &'static str> {
    match (claimed.and_then(server_origin), server_origin(current)) {
        (Some(claimed), Some(current)) if claimed == current => Ok(()),
        _ => Err(SERVER_CHANGED),
    }
}
pub const SPAWN_FAILED: &str = "SidecarSpawnFailed";
/// A24: a remotely driven node chat is never run bypassed.
pub const BYPASS_UNAVAILABLE_REMOTE: &str = "bypass_unavailable_remote";
pub const UNKNOWN_CHAT_MODE: &str = "UnknownChatMode";
/// The modes an interactive node chat may run in (S24): a local session's, without bypass.
pub const NODE_CHAT_MODES: [&str; 4] = ["auto", "manual", "edit", "plan"];

// ─── Levels (P1-T37, CAV9) ───────────────────────────────────────────────

/// The level table the server, the web and the sidecar read (one file).
const LEVELS: &str = include_str!("../../../../packages/shared/src/node-levels.json");

struct LevelRow {
    id: String,
    rank: u8,
    sandbox: bool,
}

fn level_rows() -> &'static [LevelRow] {
    static ROWS: std::sync::OnceLock<Vec<LevelRow>> = std::sync::OnceLock::new();
    ROWS.get_or_init(|| {
        let table: serde_json::Value =
            serde_json::from_str(LEVELS).expect("node-levels.json is JSON");
        table["levels"]
            .as_array()
            .expect("node-levels.json has levels")
            .iter()
            .map(|row| LevelRow {
                id: row["id"].as_str().expect("a level id").to_string(),
                rank: row["rank"].as_u64().expect("a level rank") as u8,
                sandbox: row["sandbox"].as_bool().expect("a level sandbox flag"),
            })
            .collect()
    })
}

/// A level's rank in the table; None for a name the table does not know.
pub fn level_rank(level: &str) -> Option<u8> {
    level_rows().iter().find(|r| r.id == level).map(|r| r.rank)
}

/// Whether every shell command of a session at this level runs in the OS
/// sandbox. An unknown level fails closed.
pub fn sandbox_required(level: &str) -> bool {
    level_rows()
        .iter()
        .find(|r| r.id == level)
        .map(|r| r.sandbox)
        .unwrap_or(true)
}

/// Strict and Standard need the OS sandbox, which Windows does not have (A15).
pub fn level_refused_on(os: &str, level: &str) -> bool {
    sandbox_required(level) && !matches!(os, "macos" | "linux")
}

/// The pin's floor: an agent never confirmed here runs Strict at most.
pub const DEFAULT_PIN: &str = "strict";

fn profiles_document(dir: &Path) -> serde_json::Map<String, serde_json::Value> {
    std::fs::read(dir.join(NODE_PROFILES_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn profile_key(server: &str, agent_id: &str) -> String {
    token_key(server, agent_id)
}

/// The level pinned for this agent on this server (D24): `{"level": …}`.
/// Absent, an old hash pin or an unknown level read as Strict.
pub fn pinned_level_at(dir: &Path, server: &str, agent_id: &str) -> String {
    profiles_document(dir)
        .get(&profile_key(server, agent_id))
        .and_then(|v| v.get("level"))
        .and_then(|v| v.as_str())
        .filter(|level| level_rank(level).is_some())
        .unwrap_or(DEFAULT_PIN)
        .to_string()
}

pub fn pin_level_at(dir: &Path, server: &str, agent_id: &str, level: &str) -> Result<(), String> {
    if level_rank(level).is_none() {
        return Err(format!("unknown level {level}"));
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut map = profiles_document(dir);
    map.insert(
        profile_key(server, agent_id),
        serde_json::json!({ "level": level }),
    );
    write_private(
        &dir.join(NODE_PROFILES_FILE),
        &serde_json::to_vec(&serde_json::Value::Object(map)).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

fn session_levels_document(dir: &Path) -> serde_json::Map<String, serde_json::Value> {
    std::fs::read(dir.join(NODE_SESSION_LEVELS_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn session_level_key(server: &str, agent_id: &str, session_id: &str) -> String {
    format!("{}#{session_id}", token_key(server, agent_id))
}

/// The level this session was last admitted at on this node, if any.
pub fn session_level_at(
    dir: &Path,
    server: &str,
    agent_id: &str,
    session_id: &str,
) -> Option<String> {
    session_levels_document(dir)
        .get(&session_level_key(server, agent_id, session_id))
        .and_then(|v| v.as_str())
        .filter(|level| level_rank(level).is_some())
        .map(str::to_string)
}

/// Records the level a session was admitted at: a later start of the same
/// session at or below it (a resume, a lowering restart) needs nothing more,
/// and a raise above it needs a confirmation again (D24).
pub fn pin_session_level_at(
    dir: &Path,
    server: &str,
    agent_id: &str,
    session_id: &str,
    level: &str,
) -> Result<(), String> {
    if level_rank(level).is_none() {
        return Err(format!("unknown level {level}"));
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut map = session_levels_document(dir);
    map.insert(
        session_level_key(server, agent_id, session_id),
        serde_json::Value::String(level.into()),
    );
    write_private(
        &dir.join(NODE_SESSION_LEVELS_FILE),
        &serde_json::to_vec(&serde_json::Value::Object(map)).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// Every agent's level pin on this server (D42), for the capabilities the
/// page publishes. Old hash pins are left out: they read as Strict.
pub fn level_pins_at(dir: &Path, server: &str) -> Vec<(String, String)> {
    let prefix = profile_key(server, "");
    profiles_document(dir)
        .iter()
        .filter_map(|(key, value)| {
            let agent = key.strip_prefix(&prefix)?;
            let level = value.get("level")?.as_str()?;
            (!agent.is_empty() && level_rank(level).is_some())
                .then(|| (agent.to_string(), level.to_string()))
        })
        .collect()
}

// ─── The job file ────────────────────────────────────────────────────────

/// The user's access token, for the consume call only (K25): it lives in the
/// shell's memory, never in a job file, the sidecar's env or a debug print.
#[derive(Clone, Default, Deserialize)]
#[serde(transparent)]
pub struct AccessToken(pub String);

impl std::fmt::Debug for AccessToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AccessToken(..)")
    }
}

/// What the page sends to run one claimed job. Kept with the run (without
/// the access token) so a reloaded page can restart it at a new level (T24).
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeJobRequest {
    pub job_id: String,
    pub agent_id: String,
    #[serde(default)]
    pub agent_name: String,
    pub model: String,
    /// `{level, liaisonTools}` (D18); a chat turn may still send a template.
    pub profile: serde_json::Value,
    pub prompt: String,
    #[serde(default)]
    pub trigger: Option<serde_json::Value>,
    #[serde(default)]
    pub hard_token_limit: Option<u64>,
    #[serde(default)]
    pub agent_definition: String,
    /// The MCP connection the job was CLAIMED with (A18).
    #[serde(default)]
    pub mcp_connection_id: Option<String>,
    /// `interactive` for a node chat turn (S24); anything else is unattended.
    #[serde(default)]
    pub kind: Option<String>,
    /// Interactive only: the chat's permission mode (never bypass, A24).
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// Interactive only: the SDK session this turn resumes.
    #[serde(default)]
    pub resume_session_id: Option<String>,
    /// P1 sessions (R7): the session this unattended job runs.
    #[serde(default)]
    pub session_id: Option<String>,
    /// The level this session runs at.
    #[serde(default)]
    pub level: Option<String>,
    /// The agent's profile level: the pin's baseline (D41).
    #[serde(default)]
    pub profile_level: Option<String>,
    /// D27: `owner` or `isolated`.
    #[serde(default)]
    pub config_kind: Option<String>,
    #[serde(default)]
    pub folder_path: Option<String>,
    #[serde(default)]
    pub folder_name: Option<String>,
    /// D49: a git URL or a shared repo name.
    #[serde(default)]
    pub repo: Option<String>,
    /// `dispatch`, `app`, `routine` or `agent_tag`.
    #[serde(default)]
    pub source: Option<String>,
    /// D41: an attached `profile_raise` to consume to raise the pin.
    #[serde(default)]
    pub profile_confirmation_id: Option<String>,
    /// D41: the `session_start` attached to this session.
    #[serde(default)]
    pub session_confirmation_id: Option<String>,
    /// The window's session, for the consume call only (K25). Never serialized.
    #[serde(default, skip_serializing)]
    pub access_token: Option<AccessToken>,
    /// P3 (D35): the node's live caps from the claim; absent, the defaults.
    #[serde(default)]
    pub caps: Option<Caps>,
    /// P3 (R7): the SDK session this run resumes, and why.
    #[serde(default)]
    pub resume: Option<ResumeRequest>,
    /// P3 (L3): the claim's lease generation, kept with the run so a reloaded
    /// page can fence its calls; never written into the job file.
    #[serde(default)]
    pub lease_generation: Option<u64>,
    /// P3-T24 (D34): a run restarted at a new level names the level it left.
    #[serde(default)]
    pub level_change: Option<LevelChange>,
    /// Walk D7: the models this node offers (what the owner picks from); a
    /// session may switch to one even when its own CLI lists it otherwise.
    #[serde(default)]
    pub offered_models: Option<Vec<String>>,
    /// S24: the session's reasoning level (one of `EFFORT_LEVELS`); none,
    /// the model's default.
    #[serde(default)]
    pub effort: Option<String>,
    /// S30: the session's autonomy (one of `AUTONOMY_LEVELS`); none, guided.
    #[serde(default)]
    pub autonomy: Option<String>,
    /// S57: how the session finishes (one of `FINISH_WITH`); none, a PR in a repo.
    #[serde(default)]
    pub finish_with: Option<String>,
    /// D43 F2: the node protocol the claiming server advertised (3 before
    /// wave 2), kept with the run so a reloaded page talks to it alike.
    #[serde(default)]
    pub server_protocol: Option<u32>,
    /// B2-1 (D52): the server that answered the claim (the page's address,
    /// by origin). The start is refused unless it is the shell's current
    /// server; a reattached run's kept request carries it on.
    #[serde(default)]
    pub server: Option<String>,
    /// A44 (W3): an import's recorded cwd below its shared folder, relative;
    /// written to the job file only when `safe_subdir` admits it.
    #[serde(default)]
    pub cwd_subdir: Option<String>,
    /// D53: the shared folder's own git worktree outside it that the import
    /// ran in (`cwd_subdir` is then relative to it). Written as given when its
    /// shape is safe, as "" otherwise, so the sidecar refuses the run
    /// (`unsafe_subdir`) rather than run in the folder; the sidecar accepts it
    /// only among the worktrees git lists for the folder.
    #[serde(default)]
    pub worktree_path: Option<String>,
    /// W2-D5: another in-place session holds the folder's checkout (one
    /// display line from the server); the sidecar then never switches the
    /// folder's branch for this run. Written without control characters,
    /// 200 characters at most.
    #[serde(default)]
    pub folder_held_by: Option<String>,
}

/// The SDK's reasoning levels (`Options.effort`, S24); any other value is dropped.
const EFFORT_LEVELS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// A session's autonomy levels (S30); any other value is dropped.
const AUTONOMY_LEVELS: [&str; 2] = ["guided", "autonomous"];

/// How a session finishes (S57); any other value is dropped.
const FINISH_WITH: [&str; 3] = ["pr", "commit", "none"];

/// The level a restarted session run left (D34).
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelChange {
    pub from: String,
}

/// A resume run (D36): the SDK session it continues, why, and the message
/// that woke it (`after: "message"`).
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeRequest {
    /// Walk D3: none when the server knows no SDK session; a message resume
    /// still carries its command, and the run starts fresh on it.
    #[serde(default)]
    pub sdk_session_id: Option<String>,
    pub after: String,
    #[serde(default)]
    pub command_id: Option<String>,
    /// S51 (D28): the owner sent the message confirmed while another Claude
    /// Code drove the session; the sidecar's driver check lets the run start.
    #[serde(default)]
    pub confirm_driven_elsewhere: bool,
    /// A62: a taken-over import's first resume: the transcript byte offset
    /// its replay reached; the sidecar replays from there first.
    #[serde(default)]
    pub catch_up_from: Option<u64>,
}

/// The reasons a session resumes (the server's `resume_after`).
pub const RESUME_REASONS: [&str; 5] = ["offline", "message", "crash", "level", "autonomy"];

/// The caps this start is admitted under: the claim's, else the defaults.
pub fn request_caps(request: &NodeJobRequest) -> Caps {
    request.caps.unwrap_or_default()
}

/// A routine's or an agent tag's session counts toward the background cap.
pub fn request_background(request: &NodeJobRequest) -> bool {
    matches!(request.source.as_deref(), Some("routine" | "agent_tag"))
}

/// The profile level a request names: the claim's, else the profile's own.
pub fn request_profile_level(request: &NodeJobRequest) -> Option<String> {
    request
        .profile_level
        .clone()
        .or_else(|| {
            request
                .profile
                .get("level")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
}

/// The level the session runs at: the claim's, else the profile level.
pub fn request_level(request: &NodeJobRequest) -> Option<String> {
    request.level.clone().or_else(|| request_profile_level(request))
}

/// The profile's Liaison tools toggle: on unless the profile says off (D21).
pub fn profile_liaison_tools(profile: &serde_json::Value) -> bool {
    profile
        .get("liaisonTools")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// The mode an INTERACTIVE node chat turn runs in, or None for an unattended
/// job. Bypass is refused here whatever the server sent (A24): the chat is
/// driven from the web or the phone and nobody is at this computer.
pub fn interactive_mode(request: &NodeJobRequest) -> Result<Option<String>, &'static str> {
    if request.kind.as_deref() != Some("interactive") {
        return Ok(None);
    }
    match request.permission_mode.as_deref().unwrap_or("manual") {
        "bypass" => Err(BYPASS_UNAVAILABLE_REMOTE),
        mode if NODE_CHAT_MODES.contains(&mode) => Ok(Some(mode.to_string())),
        _ => Err(UNKNOWN_CHAT_MODE),
    }
}

// ─── Remote Auto (G6) ────────────────────────────────────────────────────

/// The per-device switch, beside the shell's other settings.
pub const REMOTE_AUTO_FILE: &str = "liaison-node-remote-auto.json";

/// The modes a node chat runs in only once remote Auto is on: each lets the
/// agent act on this computer without asking every time.
pub const REMOTE_UNPROMPTED_MODES: [&str; 2] = ["auto", "edit"];

/// The mode a node chat actually runs in. A node chat is started from the web
/// or a phone, so nobody may be at this computer, and a script in the page
/// could start one with its own prompt: Auto and Edit become Manual unless the
/// person turned remote Auto on here (`set_node_remote_auto`).
pub fn remote_chat_mode(mode: &str, remote_auto: bool) -> &str {
    if !remote_auto && REMOTE_UNPROMPTED_MODES.contains(&mode) {
        "manual"
    } else {
        mode
    }
}

/// Rewrites an interactive request's mode by `remote_chat_mode`. Answers the
/// mode it asked for when that was lowered, None otherwise (an unattended job
/// is the level gate's, never this switch's).
pub fn apply_remote_auto(request: &mut NodeJobRequest, remote_auto: bool) -> Option<String> {
    if request.kind.as_deref() != Some("interactive") {
        return None;
    }
    let asked = request.permission_mode.clone()?;
    let runs = remote_chat_mode(&asked, remote_auto);
    if runs == asked {
        return None;
    }
    request.permission_mode = Some(runs.to_string());
    Some(asked)
}

pub fn read_remote_auto_at(dir: &Path) -> bool {
    std::fs::read(dir.join(REMOTE_AUTO_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|body| body.get("enabled").and_then(|v| v.as_bool()))
        .unwrap_or(false)
}

fn write_remote_auto_at(dir: &Path, enabled: bool) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let body = serde_json::json!({ "enabled": enabled });
    write_private(
        &dir.join(REMOTE_AUTO_FILE),
        &serde_json::to_vec(&body).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// The switch, with the shell's question injected: turning it on writes it
/// only once `confirm` (the native dialog) says yes; turning it off never
/// asks. Answers the state afterwards.
pub fn set_remote_auto_with<C>(dir: &Path, enabled: bool, confirm: C) -> Result<bool, String>
where
    C: FnOnce() -> bool,
{
    if enabled && !read_remote_auto_at(dir) && !confirm() {
        return Ok(false);
    }
    write_remote_auto_at(dir, enabled)?;
    Ok(read_remote_auto_at(dir))
}

/// What the native question says.
pub const REMOTE_AUTO_TITLE: &str = "Auto for chats started elsewhere";
pub const REMOTE_AUTO_MESSAGE: &str = "Chats with this computer that you start from the web or \
    your phone may then run in Auto or Edit: commands and file changes in the agent's folder \
    without asking each time (it still asks before ones that look destructive). Turn this on?";
pub const REMOTE_AUTO_ALLOW_LABEL: &str = "Turn on";
pub const REMOTE_AUTO_DENY_LABEL: &str = "Cancel";

/// Whether remote Auto is on for this computer.
#[tauri::command]
pub fn get_node_remote_auto<R: Runtime>(app: AppHandle<R>) -> bool {
    app_config_dir(&app)
        .as_deref()
        .map(read_remote_auto_at)
        .unwrap_or(false)
}

/// The Settings switch. Turning it on is the shell's own native question, so a
/// page script can ask for it but never answer it.
#[tauri::command]
pub async fn set_node_remote_auto<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
) -> Result<bool, String> {
    let dir = app_config_dir(&app).ok_or("no application config directory")?;
    let confirmed = if enabled && !read_remote_auto_at(&dir) {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        let dialog = app
            .dialog()
            .message(REMOTE_AUTO_MESSAGE)
            .title(REMOTE_AUTO_TITLE)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                REMOTE_AUTO_ALLOW_LABEL.into(),
                REMOTE_AUTO_DENY_LABEL.into(),
            ));
        tauri::async_runtime::spawn_blocking(move || dialog.blocking_show())
            .await
            .unwrap_or(false)
    } else {
        false
    };
    set_remote_auto_with(&dir, enabled, || confirmed)
}

/// The prompts My node chat's live turn is parked on (D11): the ones the page
/// may answer, and the shell commands and writes outside the node's folder,
/// whose allow stands only for a call shown whole (`node_chat_confirm`). The
/// page relays every prompt to the owner and writes their answer back, so it
/// holds every request id.
#[derive(Default)]
pub struct NodeChatPrompts {
    pub page: std::sync::Mutex<std::collections::HashSet<String>>,
    pub shell: std::sync::Mutex<ShellAskBook>,
}

impl NodeChatPrompts {
    pub fn retire(&self) {
        retire_all(&self.page, &self.shell);
    }
}

/// A node chat's prompt is answered by its owner, in the chat (an Allow /
/// Deny card on the web, the phone or the app): nobody is at this computer,
/// so no blocking dialog is shown here as well. The owner's allow stands for
/// a call the card showed whole; one too long to show whole is still never
/// allowed (`decide` denies it before asking), and an id this turn did not ask
/// is still refused.
pub fn node_chat_confirm(ask: &crate::permission_gate::ShellAsk) -> bool {
    ask.allowable
}

/// The owner's answer to a relayed permission prompt, as the one control line
/// the job's sidecar reads (node-interactive.ts). Only a plain request id is
/// written: nothing the page sends can smuggle a second line in.
pub fn permission_response_line(
    request_id: &str,
    allow: bool,
    message: Option<&str>,
) -> Result<String, &'static str> {
    let well_formed = !request_id.is_empty()
        && request_id.len() <= 64
        && request_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !well_formed {
        return Err("bad permission request id");
    }
    let mut line = serde_json::json!({
        "type": "permission_response",
        "requestId": request_id,
        "behavior": if allow { "allow" } else { "deny" },
    });
    if !allow {
        line["message"] = serde_json::Value::String(
            message
                .unwrap_or("denied by the owner")
                .chars()
                .take(500)
                .collect(),
        );
    }
    Ok(line.to_string())
}

/// Walk D7: a model id as a node offers it (`claude-sonnet-5`, `claude-opus-5-5[1m]`).
fn is_model_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '[' | ']'))
}

/// The job file the sidecar reads. No credential is in it: a session pushes
/// with this computer's own git logins, read by the sidecar (D17, D31).
pub fn job_document(
    request: &NodeJobRequest,
    server: &str,
    node_root: &Path,
    mcp_config: Option<&Path>,
    shared_folders: &[SharedFolder],
) -> serde_json::Value {
    let chat_mode = interactive_mode(request).ok().flatten();
    let interactive = chat_mode.is_some();
    let mut doc = serde_json::json!({
        "jobId": request.job_id,
        "server": server.trim_end_matches('/'),
        "agentId": request.agent_id,
        "agentName": request.agent_name,
        "model": request.model,
        "profile": {
            "level": request_profile_level(request)
                .filter(|l| level_rank(l).is_some())
                .unwrap_or_else(|| DEFAULT_PIN.to_string()),
            "liaisonTools": profile_liaison_tools(&request.profile),
        },
        "prompt": request.prompt,
        "trigger": request.trigger,
        "hardTokenLimit": request.hard_token_limit,
        "nodeRoot": node_root.to_string_lossy(),
        "mcpConfigPath": mcp_config.map(|p| p.to_string_lossy().to_string()),
        "agentDefinition": request.agent_definition,
        "kind": if interactive { "interactive" } else { "unattended" },
        "permissionMode": chat_mode,
        "resumeSessionId": if interactive { request.resume_session_id.clone() } else { None },
    });
    // R7: the session's fields, as the sidecar's readJobFile reads them. A
    // missing field is left out (the sidecar then refuses the job), never
    // guessed. The access token is never written (K25).
    if let (false, Some(id)) = (interactive, request.session_id.as_ref()) {
        let mut session = serde_json::Map::new();
        session.insert("id".into(), id.clone().into());
        let optional = [
            ("source", &request.source),
            ("folderPath", &request.folder_path),
            ("folderName", &request.folder_name),
            ("repo", &request.repo),
        ];
        for (key, value) in optional {
            if let Some(v) = value {
                session.insert(key.into(), v.clone().into());
            }
        }
        session.insert("model".into(), request.model.clone().into());
        if let Some(models) = request.offered_models.as_ref() {
            let models: Vec<serde_json::Value> = models
                .iter()
                .filter(|m| is_model_id(m))
                .take(64)
                .map(|m| m.clone().into())
                .collect();
            session.insert("offeredModels".into(), models.into());
        }
        if let Some(effort) = request
            .effort
            .as_deref()
            .filter(|e| EFFORT_LEVELS.contains(e))
        {
            session.insert("effort".into(), effort.into());
        }
        if let Some(autonomy) = request
            .autonomy
            .as_deref()
            .filter(|a| AUTONOMY_LEVELS.contains(a))
        {
            session.insert("autonomy".into(), autonomy.into());
        }
        if let Some(finish) = request
            .finish_with
            .as_deref()
            .filter(|f| FINISH_WITH.contains(f))
        {
            session.insert("finishWith".into(), finish.into());
        }
        // A44: the recorded cwd below the folder, only a relative path with no
        // `..`, empty or absolute segment (the sidecar re-checks it by real path).
        if let Some(sub) = request
            .cwd_subdir
            .as_deref()
            .filter(|s| !s.is_empty() && safe_subdir(s))
        {
            session.insert("cwdSubdir".into(), sub.into());
        }
        if let Some(worktree) = request.worktree_path.as_deref() {
            let kept = if safe_worktree_path(worktree) { worktree } else { "" };
            session.insert("worktreePath".into(), kept.into());
        }
        // W2-D5: display text only; control characters dropped, length capped.
        if let Some(held) = request.folder_held_by.as_deref() {
            let held: String = held
                .chars()
                .filter(|c| !c.is_control())
                .take(200)
                .collect();
            if !held.trim().is_empty() {
                session.insert("folderHeldBy".into(), held.into());
            }
        }
        // D43 F10: a server older than wave 2 gets no finish step enforced.
        if let Some(protocol) = request.server_protocol {
            session.insert("serverProtocol".into(), protocol.into());
        }
        if let Some(level) = request_level(request) {
            session.insert("level".into(), level.into());
        }
        if let Some(level) = request_profile_level(request) {
            session.insert("profileLevel".into(), level.into());
        }
        if let Some(kind) = &request.config_kind {
            session.insert("configKind".into(), kind.clone().into());
        }
        session.insert(
            "liaisonTools".into(),
            profile_liaison_tools(&request.profile).into(),
        );
        if let Some(resume) = request
            .resume
            .as_ref()
            .filter(|r| RESUME_REASONS.contains(&r.after.as_str()))
            .filter(|r| {
                r.sdk_session_id.as_deref().is_some_and(|id| !id.is_empty())
                    || r.command_id.is_some()
            })
        {
            let mut value = serde_json::json!({ "after": resume.after });
            if let Some(id) = resume.sdk_session_id.as_deref().filter(|id| !id.is_empty()) {
                value["sdkSessionId"] = id.into();
            }
            if let Some(id) = &resume.command_id {
                value["commandId"] = id.clone().into();
            }
            if resume.confirm_driven_elsewhere {
                value["confirmDrivenElsewhere"] = true.into();
            }
            if let Some(offset) = resume.catch_up_from {
                value["catchUpFrom"] = offset.into();
            }
            session.insert("resume".into(), value);
        }
        if let Some(change) = request
            .level_change
            .as_ref()
            .filter(|c| level_rank(&c.from).is_some())
        {
            session.insert(
                "levelChange".into(),
                serde_json::json!({ "from": change.from }),
            );
        }
        doc["session"] = serde_json::Value::Object(session);
        // The sidecar's readJobFile reads `sharedFolders` (name, path, kind):
        // their config files are write-denied (D25, D31).
        doc["sharedFolders"] = serde_json::to_value(shared_folders).unwrap_or_default();
    }
    doc
}

// ─── Level confirmations (D24, D41) ──────────────────────────────────────

/// Whether an id is one the server issues (a uuid), before it enters a URL.
fn confirmation_id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// The consume call: the window's session AND this node's credential (the
/// route checks the credential belongs to the session's user).
pub fn consume_request(
    server: &str,
    id: &str,
    access_token: &str,
    node_credential: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Request, String> {
    if !confirmation_id_ok(id) {
        return Err("bad confirmation id".into());
    }
    reqwest::Client::new()
        .post(format!(
            "{}/api/node/level-confirmations/{id}/consume",
            server.trim_end_matches('/')
        ))
        .bearer_auth(access_token)
        .header("X-Node-Credential", node_credential)
        .json(body)
        .build()
        .map_err(|e| e.to_string())
}

/// Uses up one level confirmation; answers its purpose.
pub trait LevelConsumer {
    fn consume(
        &self,
        id: &str,
        body: serde_json::Value,
    ) -> impl std::future::Future<Output = Result<String, String>> + Send;
}

/// The server's consume route.
pub struct HttpLevelConsumer {
    pub server: String,
    pub access_token: Option<String>,
    pub node_credential: Option<String>,
}

const CONSUME_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

impl LevelConsumer for HttpLevelConsumer {
    fn consume(
        &self,
        id: &str,
        body: serde_json::Value,
    ) -> impl std::future::Future<Output = Result<String, String>> + Send {
        let request = match (&self.access_token, &self.node_credential) {
            (Some(token), Some(credential)) => {
                consume_request(&self.server, id, token, credential, &body)
            }
            _ => Err("no session or node credential to consume a confirmation with".into()),
        };
        async move {
            let request = request?;
            let client = reqwest::Client::builder()
                .timeout(CONSUME_TIMEOUT)
                .build()
                .map_err(|e| e.to_string())?;
            let response = client.execute(request).await.map_err(|e| e.to_string())?;
            if !response.status().is_success() {
                return Err(format!("consume refused ({})", response.status()));
            }
            let answer: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
            answer["data"]["purpose"]
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "consume answered no purpose".into())
        }
    }
}

/// The level gate of an unattended start (D41), replacing the hash gate:
/// 1. a profile level below the pin lowers the pin (the safe direction);
/// 2. above it, an attached `profile_raise` is consumed and raises the pin;
/// 3. a session at or below the pin starts;
/// 4. a session already admitted at or above this level starts (a resume, a
///    lowering restart: P3-fix M2);
/// 5. else an attached `session_start` admits this start only, and so does a
///    `session_raise` (P3-T24, D34: a running or dormant session raised in
///    the app), both consumed for this session at this level;
/// 6. else `level_unconfirmed`.
/// Each admitted session start records its level for step 4.
pub async fn admit_level<C: LevelConsumer>(
    dir: &Path,
    server: &str,
    request: &NodeJobRequest,
    consumer: &C,
) -> Result<(), String> {
    let unconfirmed = || LEVEL_UNCONFIRMED.to_string();
    let profile_level = request_profile_level(request).ok_or_else(unconfirmed)?;
    let level = request_level(request).ok_or_else(unconfirmed)?;
    let profile_rank = level_rank(&profile_level).ok_or_else(unconfirmed)?;
    let rank = level_rank(&level).ok_or_else(unconfirmed)?;
    let agent = request.agent_id.as_str();
    let mut pin_rank = level_rank(&pinned_level_at(dir, server, agent)).unwrap_or(0);
    if profile_rank < pin_rank {
        pin_level_at(dir, server, agent, &profile_level)?;
        pin_rank = profile_rank;
    } else if profile_rank > pin_rank {
        if let Some(id) = request.profile_confirmation_id.as_deref() {
            let body = serde_json::json!({ "agentId": agent, "level": profile_level });
            if consumer.consume(id, body).await.as_deref() == Ok("profile_raise") {
                pin_level_at(dir, server, agent, &profile_level)?;
                pin_rank = profile_rank;
            }
        }
    }
    let session = request.session_id.as_deref();
    // Every admitted start of a session records its level, so the next one
    // compares against what was last admitted (a lowering lowers it).
    let admitted = |session: Option<&str>| -> Result<(), String> {
        match session {
            Some(sid) => pin_session_level_at(dir, server, agent, sid, &level),
            None => Ok(()),
        }
    };
    if rank <= pin_rank {
        return admitted(session);
    }
    // P3-fix M2: this session was already admitted at or above this level
    // (its confirmation used up then): a resume or a lowering restart.
    if let Some(sid) = session {
        let confirmed = session_level_at(dir, server, agent, sid)
            .and_then(|l| level_rank(&l))
            .is_some_and(|r| rank <= r);
        if confirmed {
            return admitted(session);
        }
    }
    if let (Some(id), Some(sid)) = (request.session_confirmation_id.as_deref(), session) {
        let body = serde_json::json!({ "sessionId": sid, "level": level });
        if matches!(
            consumer.consume(id, body).await.as_deref(),
            Ok("session_start" | "session_raise")
        ) {
            return admitted(session);
        }
    }
    Err(unconfirmed())
}

/// How waiting for the job's sidecar to boot ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootWait {
    Booted,
    Failed,
    TimedOut,
}

/// The start's answer (L25): a boot past BOOT_TIMEOUT is `timeout`, a boot
/// error stays SPAWN_FAILED.
pub fn boot_answer(wait: BootWait) -> Result<serde_json::Value, String> {
    match wait {
        BootWait::Booted => Ok(serde_json::json!({ "ok": true })),
        BootWait::Failed => Err(SPAWN_FAILED.into()),
        BootWait::TimedOut => {
            eprintln!("liaison: the node job: {BOOT_TIMEOUT_TEXT}");
            Err(TIMEOUT.into())
        }
    }
}

fn write_job_mcp_config(
    path: PathBuf,
    server: &str,
    agent_definition: &str,
    token: &StoredToken,
) -> Result<PathBuf, String> {
    let mut body = serde_json::json!({
        "liaisonMcpUrl": resolve_mcp_url(server, std::env::var("LIAISON_MCP_URL").ok()),
        "agentScopedToken": token.token,
        "tokenExpiresAtMs": token.expires_at_ms,
        "tokenUrl": crate::auth::token_url(server),
        "agentDefinition": agent_definition,
    });
    if let Some(refresh) = token.refresh_token.as_deref().filter(|t| !t.is_empty()) {
        body["refreshToken"] = serde_json::Value::String(refresh.into());
    }
    write_private(
        &path,
        &serde_json::to_vec(&body).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(path)
}

/// The agent's stored connection, renewed with its refresh token if it has to
/// be, NEVER minted (F10): a job that finds none fails `auth_required`.
async fn job_token(
    store: Option<&Path>,
    server: &str,
    agent_id: &str,
) -> Result<StoredToken, &'static str> {
    let stored = store.and_then(|p| crate::sidecar::load_token(p, &token_key(server, agent_id)));
    let refresh_base = server.to_string();
    let fresh =
        crate::auth::ensure_fresh_token_async(
            stored,
            crate::auth::now_ms(),
            |refresh_token: String| async move {
                crate::auth::refresh(&refresh_base, &refresh_token).await
            },
            || async { Err(AuthError::NotApproved) },
        )
        .await
        .map_err(|_| AUTH_REQUIRED)?;
    if let Some(path) = store {
        let _ = save_token(path, &token_key(server, agent_id), &fresh);
    }
    Ok(fresh)
}

/// The MCP connection a stored agent token belongs to: the `mcpConnectionId`
/// claim the server signs into every token it mints from that connection
/// (connection-service.ts), else the id half of its refresh token.
pub fn connection_id_of(token: &StoredToken) -> Option<String> {
    let claim = token
        .token
        .split('.')
        .nth(1)
        .and_then(crate::auth::base64url_decode)
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|claims| {
            claims
                .get("mcpConnectionId")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        });
    claim
        .or_else(|| {
            token
                .refresh_token
                .as_deref()
                .and_then(|r| r.split('.').next())
                .map(str::to_string)
        })
        .filter(|id| !id.is_empty() && id.len() <= 64)
}

const CONNECTIONS_KEY: &str = "connections";

/// The connection the owner's confirmation minted (or found) for this agent.
pub fn pinned_connection_at(dir: &Path, server: &str, agent_id: &str) -> Option<String> {
    profiles_document(dir)
        .get(CONNECTIONS_KEY)
        .and_then(|m| m.get(profile_key(server, agent_id)))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

pub fn pin_connection_at(
    dir: &Path,
    server: &str,
    agent_id: &str,
    connection_id: &str,
) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut map = profiles_document(dir);
    let mut connections = map
        .get(CONNECTIONS_KEY)
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    connections.insert(
        profile_key(server, agent_id),
        serde_json::Value::String(connection_id.into()),
    );
    map.insert(
        CONNECTIONS_KEY.into(),
        serde_json::Value::Object(connections),
    );
    write_private(
        &dir.join(NODE_PROFILES_FILE),
        &serde_json::to_vec(&serde_json::Value::Object(map)).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// A job with Liaison tools runs only on the connection it CLAIMED with (A18:
/// the server keys the job's taint by it), which must be the connection the
/// owner's confirmation pinned and the one the stored token belongs to.
/// Anything else is `auth_required`, never a quiet fall back to the agent's
/// window.
pub fn connection_gate(
    uses_liaison: bool,
    claimed: Option<&str>,
    token_connection: Option<&str>,
    pinned: Option<&str>,
) -> Result<(), &'static str> {
    if !uses_liaison {
        return Ok(());
    }
    match claimed {
        Some(id) if Some(id) == token_connection && Some(id) == pinned => Ok(()),
        _ => Err(AUTH_REQUIRED),
    }
}

// ─── The agent's Liaison connection (D43, CAV14, P1-T45) ─────────────────

/// The agent's Liaison connection on this computer: its stored token (renewed
/// with its refresh token if it has to be), else one minted with the window's
/// session and saved; its connection id is pinned so every job of this agent
/// claims with it (A18). None when there is neither. The load, the mint and
/// the save are passed in so a test can run it without a server.
pub async fn connect_agent_with<L, LF, M, MF, S>(
    dir: &Path,
    server: &str,
    agent_id: &str,
    load: L,
    mint: M,
    save: S,
) -> Result<Option<String>, String>
where
    L: FnOnce() -> LF,
    LF: std::future::Future<Output = Option<StoredToken>>,
    M: FnOnce() -> MF,
    MF: std::future::Future<Output = Option<StoredToken>>,
    S: FnOnce(&StoredToken),
{
    let token = match load().await {
        Some(token) => Some(token),
        None => {
            let minted = mint().await;
            if let Some(token) = minted.as_ref() {
                save(token);
            }
            minted
        }
    };
    match token.as_ref().and_then(connection_id_of) {
        Some(id) => {
            pin_connection_at(dir, server, agent_id, &id)?;
            Ok(Some(id))
        }
        None => Ok(None),
    }
}

/// `connect_agent_with` against this app's token store and server.
async fn connect_agent<R: Runtime>(
    app: &AppHandle<R>,
    agent_id: &str,
    access_token: Option<String>,
) -> Result<Option<String>, String> {
    let dir = app_config_dir(app).ok_or("no application config directory")?;
    let server = resolve_base_url(app).ok_or(NO_SERVER)?;
    let store = token_store_path(app);
    let session = access_token.filter(|t| !t.trim().is_empty());
    let (load_store, load_server, load_agent) = (store.clone(), server.clone(), agent_id.to_string());
    let (mint_server, mint_agent) = (server.clone(), agent_id.to_string());
    connect_agent_with(
        &dir,
        &server,
        agent_id,
        move || async move {
            job_token(load_store.as_deref(), &load_server, &load_agent)
                .await
                .ok()
        },
        move || async move {
            let session = session?;
            crate::auth::connect_with_session(&mint_server, &mint_agent, &session)
                .await
                .ok()
                .flatten()
        },
        |token| {
            if let Some(path) = store.as_ref() {
                let _ = save_token(path, &token_key(&server, agent_id), token);
            }
        },
    )
    .await
}

pub const CONNECTION_ALLOW_LABEL: &str = "Allow";
pub const CONNECTION_DENY_LABEL: &str = "Don't allow";

/// The title and body of My node chat's connection dialog (D43): today's
/// title, and no profile, level or repository in it.
pub fn connection_dialog(agent_name: &str) -> (String, String) {
    let name = if agent_name.trim().is_empty() {
        "This agent".to_string()
    } else {
        agent_name.trim().to_string()
    };
    (
        format!("Allow {name} on this computer?"),
        format!(
            "{name} will run Claude Code on this computer in My computer chat, where you answer its permission prompts. Allow it to connect to Liaison?"
        ),
    )
}

/// Asks, then connects only on Allow: `{confirmed, connected}`.
pub async fn confirm_connection_with<A, AF, C, CF>(
    ask: A,
    connect: C,
) -> Result<serde_json::Value, String>
where
    A: FnOnce() -> AF,
    AF: std::future::Future<Output = bool>,
    C: FnOnce() -> CF,
    CF: std::future::Future<Output = Result<Option<String>, String>>,
{
    if !ask().await {
        return Ok(serde_json::json!({ "confirmed": false, "connected": false }));
    }
    let connected = connect().await?.is_some();
    Ok(serde_json::json!({ "confirmed": true, "connected": connected }))
}

/// Every agent's level pin on this server, as the page publishes it (D42).
pub fn level_pins_answer(dir: &Path, server: &str) -> serde_json::Value {
    serde_json::Value::Array(
        level_pins_at(dir, server)
            .into_iter()
            .map(|(agent, level)| serde_json::json!({ "agentId": agent, "level": level }))
            .collect(),
    )
}

// ─── The node root ───────────────────────────────────────────────────────

/// The node's own settings (the node root).
pub const NODE_SETTINGS_FILE: &str = "liaison-node-settings.json";
pub const NODE_ROOT_REFUSED: &str = "NodeRootRefused";

fn settings_document(dir: &Path) -> serde_json::Map<String, serde_json::Value> {
    std::fs::read(dir.join(NODE_SETTINGS_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// Where jobs run: the chosen folder, else `~/Liaison Node`.
pub fn node_root_at(dir: &Path, home: &Path) -> (PathBuf, bool) {
    match settings_document(dir)
        .get("nodeRoot")
        .and_then(|v| v.as_str())
        .filter(|p| validate_node_root(p, home).is_ok())
    {
        Some(path) => (PathBuf::from(path), false),
        None => (home.join(NODE_ROOT_NAME), true),
    }
}

/// A node root is an absolute folder that is not the home folder, the root of
/// the disk, or inside a folder holding the owner's secrets.
pub fn validate_node_root(raw: &str, home: &Path) -> Result<PathBuf, &'static str> {
    let path = PathBuf::from(raw.trim());
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(NODE_ROOT_REFUSED);
    }
    if path.parent().is_none() || path == home {
        return Err(NODE_ROOT_REFUSED);
    }
    if home.starts_with(&path) {
        // A parent of the home folder would put every secret inside it.
        return Err(NODE_ROOT_REFUSED);
    }
    for secret in [
        ".ssh", ".claude", ".config", ".aws", ".gnupg", ".docker", ".kube", "Library",
    ] {
        if path.starts_with(home.join(secret)) {
            return Err(NODE_ROOT_REFUSED);
        }
    }
    Ok(path)
}

/// Changes (Some) or resets (None) the node root. Refused while a job runs:
/// the running job's folders would move under it.
pub fn set_node_root_at(
    dir: &Path,
    home: &Path,
    raw: Option<&str>,
    job_running: bool,
) -> Result<(PathBuf, bool), &'static str> {
    if job_running {
        return Err(JOB_RUNNING);
    }
    let mut map = settings_document(dir);
    match raw.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => {
            let path = validate_node_root(p, home)?;
            map.insert(
                "nodeRoot".into(),
                serde_json::Value::String(path.to_string_lossy().into()),
            );
        }
        None => {
            map.remove("nodeRoot");
        }
    }
    std::fs::create_dir_all(dir).map_err(|_| NODE_ROOT_REFUSED)?;
    write_private(
        &dir.join(NODE_SETTINGS_FILE),
        &serde_json::to_vec(&serde_json::Value::Object(map)).map_err(|_| NODE_ROOT_REFUSED)?,
    )
    .map_err(|_| NODE_ROOT_REFUSED)?;
    Ok(node_root_at(dir, home))
}

// ─── Commands ────────────────────────────────────────────────────────────

pub(crate) fn node_root<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let home = app.path().home_dir().ok()?;
    let dir = app_config_dir(app)?;
    Some(node_root_at(&dir, &home).0)
}

fn job_running<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<LiveRuns>()
        .map(|runs| runs.any_live())
        .unwrap_or(false)
}

/// The agent's Liaison connection for an UNATTENDED job, with no dialog
/// (CAV14): the stored one, else minted with the window's session. Answers the
/// connection id, None when the agent could not be connected.
#[tauri::command]
pub async fn ensure_node_agent_connection<R: Runtime>(
    app: AppHandle<R>,
    agent_id: String,
    access_token: Option<String>,
) -> Result<Option<String>, String> {
    connect_agent(&app, &agent_id, access_token).await
}

/// My node chat's `auth_required` recovery (D43): today's native "Allow
/// {agent} on this computer?" dialog, then the agent's connection. Answers
/// `{confirmed, connected}`; Don't allow connects nothing.
#[tauri::command]
pub async fn confirm_node_connection<R: Runtime>(
    app: AppHandle<R>,
    agent_id: String,
    agent_name: String,
    access_token: Option<String>,
) -> Result<serde_json::Value, String> {
    let (title, body) = connection_dialog(&agent_name);
    let dialog_app = app.clone();
    confirm_connection_with(
        move || async move {
            use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
            let dialog = dialog_app
                .dialog()
                .message(body)
                .title(title)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    CONNECTION_ALLOW_LABEL.into(),
                    CONNECTION_DENY_LABEL.into(),
                ));
            tauri::async_runtime::spawn_blocking(move || dialog.blocking_show())
                .await
                .unwrap_or(false)
        },
        || connect_agent(&app, &agent_id, access_token),
    )
    .await
}

/// Every agent's level pin on the current server (D42): `[{agentId, level}]`.
#[tauri::command]
pub fn node_level_pins<R: Runtime>(app: AppHandle<R>) -> serde_json::Value {
    match (app_config_dir(&app), resolve_base_url(&app)) {
        (Some(dir), Some(server)) => level_pins_answer(&dir, &server),
        _ => serde_json::json!([]),
    }
}

/// Runs one claimed job in its own sidecar, beside the node's other live
/// runs up to its cap (P3). Refuses (with the server's fail code where there
/// is one) before anything starts.
#[tauri::command]
pub async fn start_node_job<R: Runtime>(
    app: AppHandle<R>,
    request: NodeJobRequest,
) -> Result<serde_json::Value, String> {
    let dir = app_config_dir(&app).ok_or("no application config directory")?;
    let server = resolve_base_url(&app).ok_or(NO_SERVER)?;
    // B2-1 (D52): the server that answered the claim, before anything is used.
    claimed_server(request.server.as_deref(), &server)?;
    // An interactive chat turn (S24) is not run under the profile: the owner
    // drives it and answers its permission prompts. It always reaches Liaison,
    // like a local session, and is never bypassed (A24).
    let interactive = interactive_mode(&request)?.is_some();
    // G6: a chat started away from this computer runs in Manual unless remote
    // Auto is on here. The answer says so, for the page to tell the owner.
    let mut request = request;
    let lowered_from = apply_remote_auto(&mut request, read_remote_auto_at(&dir));
    let session_id = if interactive {
        None
    } else {
        request.session_id.clone()
    };
    if let Some(id) = session_id.as_deref() {
        if !is_uuid(id) || !is_uuid(&request.job_id) {
            return Err("bad session or job id".into());
        }
    }
    let key = run_key(session_id.as_deref(), &request.job_id);
    let caps = request_caps(&request);
    let background = request_background(&request);
    let runs = app.try_state::<LiveRuns>().ok_or("no live runs state")?;
    // Checked before a confirmation is used up or anything spawns; checked
    // again, atomically, when the run is held.
    runs.admit(&key, interactive, background, caps)?;
    if !interactive {
        // P1 (D24, D41): the level gate replaces the profile hash and the
        // GitHub protection check (D20). Windows has no sandbox for Strict
        // and Standard, checked first so no confirmation is used up for a
        // start that cannot run.
        let level = request_level(&request).unwrap_or_else(|| DEFAULT_PIN.to_string());
        if level_refused_on(std::env::consts::OS, &level) {
            return Err(SANDBOX_UNAVAILABLE.into());
        }
        let consumer = HttpLevelConsumer {
            server: server.clone(),
            access_token: request
                .access_token
                .as_ref()
                .map(|t| t.0.clone())
                .filter(|t| !t.trim().is_empty()),
            node_credential: crate::node::node_for_at(&dir, &server).map(|n| n.credential),
        };
        admit_level(&dir, &server, &request, &consumer).await?;
    }
    let root = node_root(&app).ok_or("no home directory")?;
    // A session run keeps its job file in its own run directory (owner only,
    // write-denied to the session, K8); My node chat keeps the one file.
    let run_directory = match session_id.as_deref() {
        Some(id) => {
            let at = run_dir(&root, id, &request.job_id)?;
            create_private_dir(&at).map_err(|e| e.to_string())?;
            Some(at)
        }
        None => None,
    };
    let mut secret: Option<String> = None;
    let needs_connection = interactive || profile_liaison_tools(&request.profile);
    let mcp_path = match run_directory {
        // The token's file stays under the app's config directory (never in
        // the node root a session may read), one per run.
        Some(_) => dir.join(format!("liaison-node-mcp-config-{}.json", request.job_id)),
        None => dir.join(NODE_MCP_CONFIG_FILE),
    };
    let mcp_config = if needs_connection {
        let store = token_store_path(&app);
        let token = job_token(store.as_deref(), &server, &request.agent_id).await?;
        connection_gate(
            true,
            request.mcp_connection_id.as_deref(),
            connection_id_of(&token).as_deref(),
            pinned_connection_at(&dir, &server, &request.agent_id).as_deref(),
        )?;
        secret = Some(token.token.clone());
        Some(write_job_mcp_config(
            mcp_path.clone(),
            &server,
            &request.agent_definition,
            &token,
        )?)
    } else {
        None
    };
    let job_path = match run_directory.as_ref() {
        Some(at) => at.join(RUN_JOB_FILE),
        None => dir.join(NODE_JOB_FILE),
    };
    // The folders this node advertises: the sidecar write-denies their
    // config files (D25, D31) and resolves a `repo` session against them.
    let folders = shared_folders_at(&dir, &server);
    let doc = job_document(&request, &server, &root, mcp_config.as_deref(), &folders);
    write_private(
        &job_path,
        &serde_json::to_vec(&doc).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    let command = app
        .shell()
        .sidecar("liaison-sidecar")
        .map_err(|e| e.to_string())?
        .args([
            "--unattended".to_string(),
            job_path.to_string_lossy().to_string(),
        ]);
    let (receiver, child) = command.spawn().map_err(|e| {
        eprintln!("liaison: the node job sidecar would not spawn ({e})");
        SPAWN_FAILED.to_string()
    })?;
    let pid = child.pid();
    let run = LiveRun {
        job_id: request.job_id.clone(),
        session_id: session_id.clone(),
        interactive,
        background,
        lease_generation: request.lease_generation,
        request: kept_request(&request),
        server: Some(server.trim_end_matches('/').to_string()),
        child: Box::new(child),
    };
    if let Err((code, run)) = runs.insert(key.clone(), run, caps) {
        // Another start took the slot while this one was admitted.
        run.child.stop();
        return Err(code.into());
    }
    let (boot_sender, boot) = tokio::sync::oneshot::channel();
    let lines = app.clone();
    let exits = app.clone();
    let job_id = request.job_id.clone();
    let line_tag = (session_id.clone(), request.job_id.clone());
    // A session run's event lines go to its outbox first (P3-T09, L3).
    let mut outbox = match run_directory.as_ref() {
        Some(at) => Some(Outbox::open(at).map_err(|e| e.to_string())?),
        None => None,
    };
    let exit_session = session_id.clone();
    let run_mcp = run_directory.as_ref().and(mcp_config.clone());
    // D11: the chat's prompts are recorded from the sidecar's own lines, the
    // previous turn's retired first.
    let prompts = if interactive {
        app.try_state::<NodeChatPrompts>().map(|state| {
            state.retire();
            app.clone()
        })
    } else {
        None
    };
    let prompt_root = root.clone();
    let exit_prompts = interactive.then(|| app.clone());
    tauri::async_runtime::spawn(follow_child(
        receiver,
        secret,
        boot_sender,
        move |line| {
            if let Some(state) = prompts
                .as_ref()
                .and_then(|a| a.try_state::<NodeChatPrompts>())
            {
                record_prompt_line(&state.page, &state.shell, Some(&prompt_root), &line);
            }
            let mut payload = line_payload(&line_tag.0, &line_tag.1, &line);
            if let Some(outbox) = outbox.as_mut() {
                match outbox.follow(&line) {
                    Ok(Some(index)) => payload["index"] = index.into(),
                    Ok(None) => {}
                    // Still emitted: the page posts it live; only a reload
                    // would miss it.
                    Err(e) => eprintln!("liaison node job: the outbox refused a line ({e})"),
                }
            }
            let _ = lines.emit(NODE_JOB_LINE_EVENT, payload);
        },
        |line| eprintln!("liaison node job: {line}"),
        move |exit, _| {
            if let Some(runs) = exits.try_state::<LiveRuns>() {
                runs.remove_if(&key, pid);
            }
            if let Some(state) = exit_prompts
                .as_ref()
                .and_then(|a| a.try_state::<NodeChatPrompts>())
            {
                state.retire();
            }
            // A session run's token file goes with its run.
            if let Some(path) = run_mcp {
                let _ = std::fs::remove_file(path);
            }
            let mut payload = serde_json::json!({ "jobId": job_id, "exit": exit });
            if let Some(id) = exit_session {
                payload["sessionId"] = id.into();
            }
            let _ = exits.emit(NODE_JOB_EXIT_EVENT, payload);
        },
    ));
    let mut answer = boot_answer(match tokio::time::timeout(BOOT_TIMEOUT, boot).await {
        Ok(Ok(BootOutcome::Booted)) => BootWait::Booted,
        Ok(_) => BootWait::Failed,
        Err(_) => BootWait::TimedOut,
    })?;
    // G6: the chat asked for Auto or Edit and runs in Manual here.
    if let Some(asked) = lowered_from {
        answer["permissionMode"] = "manual".into();
        answer["askedPermissionMode"] = asked.into();
        answer["remoteAuto"] = false.into();
    }
    Ok(answer)
}

/// The request kept with a run for a reloaded page (T24): never the access
/// token, nor the confirmations it already used up.
pub fn kept_request(request: &NodeJobRequest) -> Option<serde_json::Value> {
    let mut kept = request.clone();
    kept.access_token = None;
    kept.profile_confirmation_id = None;
    kept.session_confirmation_id = None;
    serde_json::to_value(&kept).ok()
}

/// One stdout line of a run, as the page hears it: `{sessionId?, jobId, line}`
/// (plus `index`, its outbox ordinal, for a `session_events` line).
pub fn line_payload(session_id: &Option<String>, job_id: &str, line: &str) -> serde_json::Value {
    let mut payload = serde_json::json!({ "jobId": job_id, "line": line });
    if let Some(id) = session_id {
        payload["sessionId"] = id.clone().into();
    }
    payload
}

/// Stops a run (the owner's Stop, a stale lease): its sidecar is told to
/// stop, then killed after a grace period. `sessionId` names a session's run,
/// `jobId` any run; neither stops every run (app quit, server switch). False
/// when nothing was running.
#[tauri::command]
pub fn stop_node_job<R: Runtime>(
    app: AppHandle<R>,
    session_id: Option<String>,
    job_id: Option<String>,
) -> bool {
    // Neither id (app quit, server switch): the follow host goes too (W3 T07).
    let follows = session_id.is_none()
        && job_id.is_none()
        && crate::node_follow::stop_all_follows(&app);
    let Some(runs) = app.try_state::<LiveRuns>() else {
        return follows;
    };
    stop_runs(&runs, session_id.as_deref(), job_id.as_deref()) || follows
}

/// `stop_node_job` over the live runs.
pub fn stop_runs(runs: &LiveRuns, session_id: Option<&str>, job_id: Option<&str>) -> bool {
    let taken: Vec<LiveRun> = match (session_id, job_id) {
        (None, None) => runs.drain(),
        (Some(session), job) => {
            let ours = job.is_none_or(|j| runs.key_of_job(j).as_deref() == Some(session));
            if ours {
                runs.take(session).into_iter().collect()
            } else {
                Vec::new()
            }
        }
        (None, Some(job)) => runs
            .key_of_job(job)
            .and_then(|key| runs.take(&key))
            .into_iter()
            .collect(),
    };
    let stopped = !taken.is_empty();
    for run in taken {
        run.child.stop();
    }
    stopped
}

/// A control line (a steering command, a restart) to ONE live session's
/// stdin (P3). Refused unless `control_line_ok`; false when the session has
/// no live run here.
#[tauri::command]
pub fn node_session_write<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    line: String,
) -> Result<bool, String> {
    if !is_uuid(&session_id) || !control_line_ok(&line) {
        return Err("refused control line".into());
    }
    let Some(runs) = app.try_state::<LiveRuns>() else {
        return Ok(false);
    };
    runs.write_line(&session_id, &line)
}

/// The owner's decision on a relayed permission prompt (S24, A24), written to
/// the running job's stdin. False when no job is running.
///
/// D11: the decision reaches the shell through the page, and any script in the
/// page could send it, so it is checked like a local session's answer: the id
/// must be one the chat asked and has not had answered, in the turn still
/// running, and an allow for a shell command or a write outside the node's
/// folder stands only for a call shown whole. No blocking dialog asks again on
/// this computer: the owner answered in the chat, and nobody is here.
#[tauri::command]
pub async fn answer_node_job_permission<R: Runtime>(
    app: AppHandle<R>,
    request_id: String,
    allow: bool,
    message: Option<String>,
) -> Result<bool, String> {
    // Shape first, before anything is asked.
    permission_response_line(&request_id, allow, message.as_deref())?;
    // My node chat's one live turn (G9), never a session: with none running
    // there is nothing to answer, and nothing to ask about.
    let Some(key) = app
        .try_state::<LiveRuns>()
        .and_then(|runs| runs.interactive_key())
    else {
        return Ok(false);
    };
    let prompts = app
        .try_state::<NodeChatPrompts>()
        .ok_or(crate::permission_gate::UNKNOWN_REQUEST)?;
    let decision = decide(
        &prompts.page,
        &prompts.shell,
        &request_id,
        allow,
        message,
        node_chat_confirm,
    )?;
    let line = match decision {
        crate::permission_gate::Decision::Allow => {
            permission_response_line(&request_id, true, None)?
        }
        crate::permission_gate::Decision::Deny(message) => {
            permission_response_line(&request_id, false, message.as_deref())?
        }
    };
    let Some(runs) = app.try_state::<LiveRuns>() else {
        return Ok(false);
    };
    runs.write_line(&key, &line)
}

/// Every live run, for a reloaded page to reattach (P3-T09, L3):
/// `[{sessionId, jobId, pid, interactive, lines}]`, then every live follow
/// (`kind: "follow"`, W3 T07, A53). D50: a run another server claimed is
/// stopped and never listed: its lines never reach the current server.
#[tauri::command]
pub fn node_live_sessions<R: Runtime>(app: AppHandle<R>) -> Vec<serde_json::Value> {
    match (
        app.try_state::<LiveRuns>(),
        app.try_state::<crate::node_follow::FollowHost>(),
        node_root(&app),
    ) {
        // D50, B2-1, B2-7: one path, with the follow host main.rs always
        // manages: only this server's runs and follows are re-adopted.
        (Some(runs), follows, Some(root)) => crate::node_follow::live_sessions_for_server(
            &runs,
            follows.as_deref(),
            &root,
            resolve_base_url(&app).as_deref(),
        ),
        _ => Vec::new(),
    }
}

/// A run's outbox lines from `fromIndex` (1-based), at most 200: `[{index, line}]`.
#[tauri::command]
pub fn node_session_outbox<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    job_id: String,
    from_index: u64,
    max: Option<usize>,
) -> Result<Vec<serde_json::Value>, String> {
    let root = node_root(&app).ok_or("no home directory")?;
    let lines = read_outbox(
        &root,
        &session_id,
        &job_id,
        from_index,
        max.unwrap_or(OUTBOX_READ_MAX),
    )?;
    Ok(lines
        .into_iter()
        .map(|(index, line)| serde_json::json!({ "index": index, "line": line }))
        .collect())
}

/// Persists how far the server acknowledged a run's outbox (G6).
#[tauri::command]
pub fn node_session_ack<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    job_id: String,
    index: u64,
    batch_no: u64,
) -> Result<(), String> {
    let root = node_root(&app).ok_or("no home directory")?;
    write_ack(&root, &session_id, &job_id, index, batch_no)
}

/// The persisted ack of a run: `{index, batchNo}` (`{0, 0}` when none).
#[tauri::command]
pub fn node_session_acked<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    job_id: String,
) -> Result<serde_json::Value, String> {
    let root = node_root(&app).ok_or("no home directory")?;
    let (index, batch_no) = read_ack(&root, &session_id, &job_id)?;
    Ok(serde_json::json!({ "index": index, "batchNo": batch_no }))
}

/// A cut tool output's full text from this computer (P3-T20, S7): None when
/// it is no longer here.
#[tauri::command]
pub fn node_session_spill<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    tool_use_id: String,
) -> Result<Option<String>, String> {
    let root = node_root(&app).ok_or("no home directory")?;
    crate::node_runs::read_spill(&root, &session_id, &tool_use_id)
}

/// The connection a job of this agent claims with (A18): the pinned one, only
/// while the stored token still belongs to it. None: the owner confirms again.
#[tauri::command]
pub async fn node_job_connection<R: Runtime>(
    app: AppHandle<R>,
    agent_id: String,
) -> Option<String> {
    let dir = app_config_dir(&app)?;
    let server = resolve_base_url(&app)?;
    let pinned = pinned_connection_at(&dir, &server, &agent_id)?;
    let store = token_store_path(&app);
    let token = job_token(store.as_deref(), &server, &agent_id).await.ok()?;
    (connection_id_of(&token).as_deref() == Some(pinned.as_str())).then_some(pinned)
}

fn root_answer((path, is_default): (PathBuf, bool)) -> serde_json::Value {
    serde_json::json!({ "path": path.to_string_lossy(), "isDefault": is_default })
}

#[tauri::command]
pub fn get_node_root<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    let dir = app_config_dir(&app).ok_or("no application config directory")?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(root_answer(node_root_at(&dir, &home)))
}

/// Changes the node root (None: back to `~/Liaison Node`). Refused while a job runs.
#[tauri::command]
pub fn set_node_root<R: Runtime>(
    app: AppHandle<R>,
    path: Option<String>,
) -> Result<serde_json::Value, String> {
    let dir = app_config_dir(&app).ok_or("no application config directory")?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    set_node_root_at(&dir, &home, path.as_deref(), job_running(&app))
        .map(root_answer)
        .map_err(str::to_string)
}

#[cfg(test)]
mod node_job_tests {
    use super::*;
    use std::sync::Mutex;
    use crate::servers::scratch_dir;
    use serde_json::json;

    /// B2-1 (D52): a start names the server that answered its claim. One
    /// claimed from another server than the shell's current one (the page
    /// settles a switch after the shell moved), or naming none, is refused
    /// before a token, a folder or a sidecar is used.
    #[test]
    fn b2_1_a_start_claimed_from_another_server_is_refused() {
        let b = "https://b.example";
        assert_eq!(claimed_server(Some("https://a.example"), b), Err(SERVER_CHANGED));
        assert_eq!(claimed_server(None, b), Err(SERVER_CHANGED));
        assert_eq!(claimed_server(Some(""), b), Err(SERVER_CHANGED));
        assert_eq!(claimed_server(Some("https://b.example.attacker.example"), b), Err(SERVER_CHANGED));
        assert_eq!(claimed_server(Some("http://b.example"), b), Err(SERVER_CHANGED));
        // The page names its server by origin; the shell may keep a slash.
        assert_eq!(claimed_server(Some("https://B.example"), "https://b.example/"), Ok(()));
        assert_eq!(claimed_server(Some(b), b), Ok(()));
        // Both commands check it before anything else is used.
        let source = include_str!("node_job.rs");
        let start = &source[source.find("pub async fn start_node_job").unwrap()..];
        let gate = start.find("claimed_server(").expect("start_node_job checks the claim's server");
        for later in ["admit(", "HttpLevelConsumer", "job_token(", ".spawn()"] {
            assert!(gate < start.find(later).unwrap(), "{later} comes after the server check");
        }
        let follow = include_str!("node_follow.rs");
        let start = &follow[follow.find("pub async fn start_node_follow").unwrap()..];
        let gate = start.find("claimed_server(").expect("start_node_follow checks the claim's server");
        assert!(gate < start.find("follow_folder_path(").unwrap());
        assert!(gate < start.find("host.add(").unwrap());
    }

    /// B2-7: the D50 filter was tested on a branch production never takes
    /// (main.rs always manages the follow host), while the production branch
    /// kept its own copy of the loop. `node_live_sessions` now has ONE path,
    /// the tested `live_sessions_for_server` (node_follow.rs), given the
    /// follow host when there is one. Read from the source: the command
    /// needs a running app.
    #[test]
    fn b2_7_node_live_sessions_takes_the_one_tested_path_with_the_follow_host() {
        let source = include_str!("node_job.rs");
        let at = source.find("pub fn node_live_sessions").expect("node_live_sessions exists");
        let body = &source[at..];
        let body = &body[..body.find("\n}\n").expect("closed")];
        assert_eq!(body.matches("live_sessions_for_server(").count(), 1, "{body}");
        assert!(body.contains("follows.as_deref()"), "the follow host is passed on");
        for own_copy in ["take_other_servers", "live_sessions(", "live_sessions_of_server", ".stop()"] {
            assert!(!body.contains(own_copy), "node_live_sessions keeps its own {own_copy}");
        }
        // Every state the app can be in reaches that one call.
        assert_eq!(body.matches("=>").count(), 2, "one arm for the call, one for no state");
    }

    #[test]
    fn a_pin_is_per_server_and_agent_and_owner_only() {
        let dir = scratch_dir("node-job-pins");
        pin_level_at(&dir, "https://a.example", "agent-1", "standard").unwrap();
        assert_eq!(pinned_level_at(&dir, "https://a.example", "agent-1"), "standard");
        assert_eq!(pinned_level_at(&dir, "https://b.example", "agent-1"), DEFAULT_PIN);
        assert_eq!(pinned_level_at(&dir, "https://a.example", "agent-2"), DEFAULT_PIN);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(NODE_PROFILES_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn no_credential_ever_enters_the_job_file() {
        let request = NodeJobRequest {
            job_id: "j".into(),
            agent_id: "a".into(),
            agent_name: "Dev".into(),
            model: "claude-haiku-4-5".into(),
            profile: json!({ "level": "standard", "liaisonTools": false }),
            prompt: "fix".into(),
            trigger: Some(json!({ "report": "x" })),
            hard_token_limit: Some(1000),
            agent_definition: String::new(),
            mcp_connection_id: None,
            kind: None,
            permission_mode: None,
            resume_session_id: None,
            ..Default::default()
        };
        let doc = job_document(
            &request,
            "https://liaison.example",
            Path::new("/tmp/root"),
            None,
            &[],
        );
        assert_eq!(doc["mcpConfigPath"], serde_json::Value::Null);
        // D17: no secrets file and no token: the sidecar reads gh's login itself.
        assert!(doc.get("secretsPath").is_none());
        let text = doc.to_string();
        assert!(!text.contains("githubToken") && !text.contains("secrets"));
    }

    fn chat_request(mode: Option<&str>) -> NodeJobRequest {
        NodeJobRequest {
            job_id: "j".into(),
            agent_id: "a".into(),
            agent_name: "Data".into(),
            model: "claude-haiku-4-5".into(),
            profile: json!({ "level": "standard", "liaisonTools": false }),
            prompt: "rebuild the report".into(),
            trigger: None,
            hard_token_limit: None,
            agent_definition: String::new(),
            mcp_connection_id: Some("conn-1".into()),
            kind: Some("interactive".into()),
            permission_mode: mode.map(String::from),
            resume_session_id: Some("sess-1".into()),
            ..Default::default()
        }
    }

    /// S24, A24, F9: an interactive node chat runs in the chat's own mode,
    /// never bypass (nobody is at the computer), whatever the server sent.
    #[test]
    fn an_interactive_chat_never_runs_bypassed() {
        assert_eq!(
            interactive_mode(&chat_request(Some("plan"))),
            Ok(Some("plan".into()))
        );
        assert_eq!(
            interactive_mode(&chat_request(None)),
            Ok(Some("manual".into()))
        );
        assert_eq!(
            interactive_mode(&chat_request(Some("bypass"))),
            Err(BYPASS_UNAVAILABLE_REMOTE)
        );
        assert_eq!(
            interactive_mode(&chat_request(Some("bypassPermissions"))),
            Err(UNKNOWN_CHAT_MODE)
        );
        let mut unattended = chat_request(Some("bypass"));
        unattended.kind = None;
        assert_eq!(interactive_mode(&unattended), Ok(None));
    }

    #[test]
    fn the_job_file_carries_the_chat_mode_and_the_session_to_resume() {
        let dir = scratch_dir("node-job-chat");
        let doc = job_document(
            &chat_request(Some("edit")),
            "https://liaison.example/",
            &dir.join("root"),
            Some(&dir.join("mcp.json")),
            &[],
        );
        assert_eq!(doc["kind"], "interactive");
        assert_eq!(doc["permissionMode"], "edit");
        assert_eq!(doc["resumeSessionId"], "sess-1");
        let mut unattended = chat_request(Some("edit"));
        unattended.kind = None;
        let doc = job_document(
            &unattended,
            "https://liaison.example/",
            &dir.join("root"),
            None,
            &[],
        );
        assert_eq!(doc["kind"], "unattended");
        assert_eq!(doc["permissionMode"], serde_json::Value::Null);
        assert_eq!(doc["resumeSessionId"], serde_json::Value::Null);
    }

    /// G6: a node chat is started from the web or the phone, so a page script
    /// could start one in Auto with its own prompt. Auto and Edit run only
    /// once the person turned on remote Auto at this computer; otherwise the
    /// chat runs in Manual, and every step asks.
    #[test]
    fn a_remote_chat_runs_in_manual_unless_remote_auto_is_on() {
        for mode in ["auto", "edit"] {
            assert_eq!(remote_chat_mode(mode, false), "manual", "{mode}");
            assert_eq!(remote_chat_mode(mode, true), mode, "{mode}");
        }
        for mode in ["manual", "plan"] {
            assert_eq!(remote_chat_mode(mode, false), mode, "{mode}");
            assert_eq!(remote_chat_mode(mode, true), mode, "{mode}");
        }

        let dir = scratch_dir("node-job-remote-auto");
        let mut request = chat_request(Some("auto"));
        assert_eq!(apply_remote_auto(&mut request, false), Some("auto".to_string()));
        let doc = job_document(&request, "https://liaison.example/", &dir.join("root"), None, &[]);
        assert_eq!(doc["permissionMode"], "manual");

        let mut allowed = chat_request(Some("auto"));
        assert_eq!(apply_remote_auto(&mut allowed, true), None);
        let doc = job_document(&allowed, "https://liaison.example/", &dir.join("root"), None, &[]);
        assert_eq!(doc["permissionMode"], "auto");

        // An unattended job is the level gate's, never this switch's.
        let mut unattended = chat_request(Some("auto"));
        unattended.kind = None;
        assert_eq!(apply_remote_auto(&mut unattended, false), None);
        assert_eq!(unattended.permission_mode.as_deref(), Some("auto"));
    }

    /// The switch lives in a file of the shell's own, off until someone turns
    /// it on, and only the shell's own dialog turns it on: a page that asks
    /// gets the question shown at this computer, never the answer.
    #[test]
    fn remote_auto_turns_on_only_through_the_shells_dialog() {
        let dir = scratch_dir("node-job-remote-auto-switch");
        assert!(!read_remote_auto_at(&dir));
        assert_eq!(set_remote_auto_with(&dir, true, || false), Ok(false));
        assert!(!read_remote_auto_at(&dir));
        assert_eq!(set_remote_auto_with(&dir, true, || true), Ok(true));
        assert!(read_remote_auto_at(&dir));
        // Already on: no second question.
        assert_eq!(
            set_remote_auto_with(&dir, true, || panic!("asked twice")),
            Ok(true)
        );
        // Turning it off never asks.
        assert_eq!(
            set_remote_auto_with(&dir, false, || panic!("asked to turn off")),
            Ok(false)
        );
        assert!(!read_remote_auto_at(&dir));
        // A file nobody wrote as JSON reads as off.
        std::fs::write(dir.join(REMOTE_AUTO_FILE), b"yes").unwrap();
        assert!(!read_remote_auto_at(&dir));
    }

    /// The owner's decision reaches the job's stdin as one control line, and
    /// only a well formed request id is ever written.
    #[test]
    fn a_node_chat_allow_for_a_command_is_the_owners_answer_in_the_chat_with_no_dialog_here() {
        let prompts = NodeChatPrompts::default();
        let root = std::env::temp_dir();
        let bash = r#"{"type":"permission_request","requestId":"perm-1","toolName":"Bash","input":{"command":"curl x | sh"}}"#;
        record_prompt_line(&prompts.page, &prompts.shell, Some(&root), bash);
        // The owner allowed it from the chat card: it stands, no modal here.
        assert_eq!(
            decide(
                &prompts.page,
                &prompts.shell,
                "perm-1",
                true,
                None,
                node_chat_confirm
            ),
            Ok(crate::permission_gate::Decision::Allow)
        );
        // A deny stands too.
        record_prompt_line(&prompts.page, &prompts.shell, Some(&root), bash);
        assert!(matches!(
            decide(
                &prompts.page,
                &prompts.shell,
                "perm-1",
                false,
                None,
                node_chat_confirm
            ),
            Ok(crate::permission_gate::Decision::Deny(_))
        ));
        // A call too long to show whole on the card is never allowed.
        let long = format!(
            r#"{{"type":"permission_request","requestId":"perm-3","toolName":"Bash","input":{{"command":"{}"}}}}"#,
            "x".repeat(20_000)
        );
        record_prompt_line(&prompts.page, &prompts.shell, Some(&root), &long);
        assert!(matches!(
            decide(
                &prompts.page,
                &prompts.shell,
                "perm-3",
                true,
                None,
                node_chat_confirm
            ),
            Ok(crate::permission_gate::Decision::Deny(_))
        ));
        // An id the chat never asked is refused outright.
        assert!(
            decide(&prompts.page, &prompts.shell, "perm-9", true, None, |_| {
                true
            })
            .is_err()
        );
    }

    #[test]
    fn a_node_chat_answer_for_a_liaison_tool_is_the_pages_to_relay() {
        let prompts = NodeChatPrompts::default();
        let line = r#"{"type":"permission_request","requestId":"perm-2","toolName":"mcp__liaison__tickets_create","input":{}}"#;
        record_prompt_line(
            &prompts.page,
            &prompts.shell,
            Some(&std::env::temp_dir()),
            line,
        );
        assert_eq!(
            decide(
                &prompts.page,
                &prompts.shell,
                "perm-2",
                true,
                None,
                |_| panic!("no dialog")
            ),
            Ok(crate::permission_gate::Decision::Allow)
        );
        // The turn ended: nothing is left to answer.
        record_prompt_line(
            &prompts.page,
            &prompts.shell,
            Some(&std::env::temp_dir()),
            line,
        );
        prompts.retire();
        assert!(
            decide(&prompts.page, &prompts.shell, "perm-2", true, None, |_| {
                true
            })
            .is_err()
        );
    }

    /// The command itself decides through the gate, never by writing the
    /// page's answer straight to the chat's stdin.
    #[test]
    fn answer_node_job_permission_goes_through_the_gate() {
        let source = include_str!("node_job.rs");
        let at = source
            .find("pub async fn answer_node_job_permission")
            .expect("the command answers a node chat's prompt");
        let body = &source[at..at + source[at..].find("\n}\n").unwrap()];
        // Through the gate, with the owner's answer in the chat as the
        // confirmation: never a blocking dialog on this computer.
        assert!(body.contains("decide(") && body.contains("node_chat_confirm"));
        assert!(!body.contains("ask_natively"));
    }

    #[test]
    fn a_permission_answer_is_one_control_line() {
        let allow: serde_json::Value =
            serde_json::from_str(&permission_response_line("perm-3", true, None).unwrap()).unwrap();
        assert_eq!(
            allow,
            json!({ "type": "permission_response", "requestId": "perm-3", "behavior": "allow" })
        );
        let deny: serde_json::Value = serde_json::from_str(
            &permission_response_line("perm-4", false, Some("No answer within 10 minutes"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(deny["behavior"], "deny");
        assert_eq!(deny["message"], "No answer within 10 minutes");
        assert!(!permission_response_line("perm-5", false, None)
            .unwrap()
            .contains('\n'));
        assert!(permission_response_line("", true, None).is_err());
        assert!(permission_response_line("perm\n{\"type\":\"shutdown\"}", true, None).is_err());
    }

    fn jwt(claims: serde_json::Value) -> String {
        let b64 = |bytes: &[u8]| {
            const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            let mut out = String::new();
            for chunk in bytes.chunks(3) {
                let n = chunk
                    .iter()
                    .enumerate()
                    .fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
                for i in 0..=chunk.len() {
                    out.push(T[((n >> (18 - 6 * i)) & 63) as usize] as char);
                }
            }
            out
        };
        format!("{}.{}.sig", b64(b"{}"), b64(claims.to_string().as_bytes()))
    }

    #[test]
    fn the_connection_id_is_read_from_the_token_the_server_signed() {
        let token = StoredToken {
            token: jwt(
                json!({ "mcpConnectionId": "11111111-2222-3333-4444-555555555555", "exp": 1 }),
            ),
            expires_at_ms: 1,
            refresh_token: Some("99999999-0000-0000-0000-000000000000.secret".into()),
        };
        assert_eq!(
            connection_id_of(&token).as_deref(),
            Some("11111111-2222-3333-4444-555555555555")
        );
        let refresh_only = StoredToken {
            token: "opaque".into(),
            expires_at_ms: 1,
            refresh_token: Some("99999999-0000-0000-0000-000000000000.secret".into()),
        };
        assert_eq!(
            connection_id_of(&refresh_only).as_deref(),
            Some("99999999-0000-0000-0000-000000000000")
        );
    }

    #[test]
    fn a_liaison_job_without_its_claimed_connection_is_auth_required() {
        let id = Some("c-1");
        // No Liaison tools: no connection needed.
        assert_eq!(connection_gate(false, None, None, None), Ok(()));
        // Claimed with no connection: refused, never a quiet fall back.
        assert_eq!(connection_gate(true, None, id, id), Err(AUTH_REQUIRED));
        // The stored token now belongs to another connection.
        assert_eq!(
            connection_gate(true, id, Some("c-2"), id),
            Err(AUTH_REQUIRED)
        );
        // Never confirmed (nothing pinned).
        assert_eq!(connection_gate(true, id, id, None), Err(AUTH_REQUIRED));
        assert_eq!(connection_gate(true, id, id, id), Ok(()));
    }

    #[test]
    fn the_confirmed_connection_is_kept_beside_the_pinned_profile() {
        let dir = scratch_dir("node-job-connections");
        pin_level_at(&dir, "https://a.example", "agent-1", "standard").unwrap();
        pin_connection_at(&dir, "https://a.example", "agent-1", "c-1").unwrap();
        assert_eq!(
            pinned_connection_at(&dir, "https://a.example", "agent-1").as_deref(),
            Some("c-1")
        );
        assert_eq!(pinned_level_at(&dir, "https://a.example", "agent-1"), "standard");
        assert_eq!(
            pinned_connection_at(&dir, "https://a.example", "agent-2"),
            None
        );
    }

    #[test]
    fn the_node_root_moves_only_to_a_safe_folder_and_never_during_a_job() {
        let dir = scratch_dir("node-job-root");
        let home = PathBuf::from("/Users/someone");
        assert_eq!(node_root_at(&dir, &home), (home.join(NODE_ROOT_NAME), true));
        let moved = set_node_root_at(&dir, &home, Some("/Volumes/Data/Jobs"), false).unwrap();
        assert_eq!(moved, (PathBuf::from("/Volumes/Data/Jobs"), false));
        assert_eq!(
            set_node_root_at(&dir, &home, Some("/Volumes/Other"), true),
            Err(JOB_RUNNING)
        );
        assert_eq!(
            node_root_at(&dir, &home).0,
            PathBuf::from("/Volumes/Data/Jobs")
        );
        for bad in [
            "relative/dir",
            "/",
            "/Users",
            "/Users/someone",
            "/Users/someone/.ssh/x",
            "/Users/someone/Library/Jobs",
            "/Volumes/a/../b",
        ] {
            assert_eq!(
                set_node_root_at(&dir, &home, Some(bad), false),
                Err(NODE_ROOT_REFUSED),
                "{bad}"
            );
        }
        assert_eq!(
            set_node_root_at(&dir, &home, None, false).unwrap(),
            (home.join(NODE_ROOT_NAME), true)
        );
    }

    // ─── P1-T37: level pins, consume, request shape ─────────────────────

    const SID: &str = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
    const PROFILE_CONF: &str = "11111111-aaaa-4bbb-8ccc-222222222222";
    const SESSION_CONF: &str = "33333333-dddd-4eee-8fff-444444444444";

    /// A consumer that records each call and answers the queued purposes.
    struct FakeConsumer {
        calls: Mutex<Vec<(String, serde_json::Value)>>,
        answers: Mutex<Vec<Result<String, String>>>,
    }

    impl FakeConsumer {
        fn answering(answers: Vec<Result<&str, &str>>) -> Self {
            FakeConsumer {
                calls: Mutex::new(Vec::new()),
                answers: Mutex::new(
                    answers
                        .into_iter()
                        .rev()
                        .map(|a| a.map(String::from).map_err(String::from))
                        .collect(),
                ),
            }
        }
        fn calls(&self) -> Vec<(String, serde_json::Value)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl LevelConsumer for FakeConsumer {
        fn consume(
            &self,
            id: &str,
            body: serde_json::Value,
        ) -> impl std::future::Future<Output = Result<String, String>> + Send {
            self.calls.lock().unwrap().push((id.to_string(), body));
            let answer = self
                .answers
                .lock()
                .unwrap()
                .pop()
                .unwrap_or(Err("no answer".into()));
            std::future::ready(answer)
        }
    }

    fn session_request(profile_level: &str, level: &str) -> NodeJobRequest {
        NodeJobRequest {
            job_id: "j-1".into(),
            agent_id: "agent-1".into(),
            agent_name: "Personal".into(),
            model: "claude-haiku-4-5".into(),
            profile: json!({ "level": profile_level, "liaisonTools": true }),
            prompt: "fix the flaky test".into(),
            session_id: Some(SID.into()),
            level: Some(level.into()),
            profile_level: Some(profile_level.into()),
            config_kind: Some("owner".into()),
            folder_path: Some("/Users/owner/code/my-repo".into()),
            folder_name: Some("my-repo".into()),
            source: Some("dispatch".into()),
            ..Default::default()
        }
    }

    fn admit(
        dir: &Path,
        request: &NodeJobRequest,
        consumer: &FakeConsumer,
    ) -> Result<(), String> {
        tokio::runtime::Runtime::new().unwrap().block_on(admit_level(
            dir,
            "https://a.example",
            request,
            consumer,
        ))
    }

    #[test]
    fn level_table_parses_and_ranks() {
        assert_eq!(level_rank("strict"), Some(0));
        assert_eq!(level_rank("standard"), Some(1));
        assert_eq!(level_rank("open"), Some(2));
        assert_eq!(level_rank("bypass"), None);
        assert!(sandbox_required("strict"));
        assert!(sandbox_required("standard"));
        assert!(!sandbox_required("open"));
        // Unknown: fail closed.
        assert!(sandbox_required("bypass"));
    }

    /// S29 (D25): the shell reads the same table; its sandbox fields are the
    /// probe's values (Standard binds locally, no Mach list anywhere).
    #[test]
    fn level_table_standard_row_has_sandbox_fields() {
        let table: serde_json::Value = serde_json::from_str(LEVELS).unwrap();
        let row = |id: &str| {
            table["levels"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["id"] == id)
                .unwrap()
                .clone()
        };
        assert_eq!(row("standard")["allowLocalBinding"], serde_json::json!(true));
        assert_eq!(row("strict")["allowLocalBinding"], serde_json::json!(false));
        for id in ["strict", "standard", "open"] {
            assert_eq!(row(id)["machLookups"], serde_json::json!([]), "{id}");
        }
    }

    #[test]
    fn a_start_at_or_below_the_pin_runs() {
        let dir = scratch_dir("node-level-at-pin");
        pin_level_at(&dir, "https://a.example", "agent-1", "standard").unwrap();
        let consumer = FakeConsumer::answering(vec![]);
        assert_eq!(admit(&dir, &session_request("standard", "standard"), &consumer), Ok(()));
        assert_eq!(admit(&dir, &session_request("standard", "strict"), &consumer), Ok(()));
        assert!(consumer.calls().is_empty());
        assert_eq!(pinned_level_at(&dir, "https://a.example", "agent-1"), "standard");
    }

    #[test]
    fn a_raise_without_confirmation_is_level_unconfirmed() {
        let dir = scratch_dir("node-level-raise");
        let consumer = FakeConsumer::answering(vec![]);
        assert_eq!(
            admit(&dir, &session_request("standard", "standard"), &consumer),
            Err(LEVEL_UNCONFIRMED.to_string())
        );
        assert_eq!(
            admit(&dir, &session_request("strict", "open"), &consumer),
            Err(LEVEL_UNCONFIRMED.to_string())
        );
        assert!(consumer.calls().is_empty());
        assert_eq!(pinned_level_at(&dir, "https://a.example", "agent-1"), "strict");
        // A level the table does not know is never admitted.
        assert_eq!(
            admit(&dir, &session_request("strict", "bypass"), &consumer),
            Err(LEVEL_UNCONFIRMED.to_string())
        );
    }

    #[test]
    fn a_profile_confirmation_raises_the_pin() {
        let dir = scratch_dir("node-level-profile-raise");
        let mut request = session_request("standard", "standard");
        request.profile_confirmation_id = Some(PROFILE_CONF.into());
        let consumer = FakeConsumer::answering(vec![Ok("profile_raise")]);
        assert_eq!(admit(&dir, &request, &consumer), Ok(()));
        assert_eq!(
            consumer.calls(),
            vec![(
                PROFILE_CONF.to_string(),
                json!({ "agentId": "agent-1", "level": "standard" })
            )]
        );
        assert_eq!(pinned_level_at(&dir, "https://a.example", "agent-1"), "standard");
        // A refused or other-purpose answer leaves the pin and refuses the start.
        let dir = scratch_dir("node-level-profile-refused");
        for answer in [Err("confirmation_consumed"), Ok("session_start")] {
            let consumer = FakeConsumer::answering(vec![answer]);
            assert_eq!(
                admit(&dir, &request, &consumer),
                Err(LEVEL_UNCONFIRMED.to_string())
            );
            assert_eq!(pinned_level_at(&dir, "https://a.example", "agent-1"), "strict");
        }
    }

    #[test]
    fn a_session_start_confirmation_leaves_the_pin() {
        let dir = scratch_dir("node-level-session-start");
        let mut request = session_request("strict", "open");
        request.session_confirmation_id = Some(SESSION_CONF.into());
        let consumer = FakeConsumer::answering(vec![Ok("session_start")]);
        assert_eq!(admit(&dir, &request, &consumer), Ok(()));
        assert_eq!(
            consumer.calls(),
            vec![(SESSION_CONF.to_string(), json!({ "sessionId": SID, "level": "open" }))]
        );
        assert_eq!(pinned_level_at(&dir, "https://a.example", "agent-1"), "strict");
        // The next session of that agent at Open is not admitted by it.
        let consumer = FakeConsumer::answering(vec![]);
        let mut next = session_request("strict", "open");
        next.session_id = Some("22222222-2222-4222-8222-222222222222".into());
        assert_eq!(admit(&dir, &next, &consumer), Err(LEVEL_UNCONFIRMED.to_string()));
        // A profile_raise answer does not admit a one-off start (a session
        // this node never admitted).
        let dir = scratch_dir("node-level-session-start-profile-answer");
        let consumer = FakeConsumer::answering(vec![Ok("profile_raise")]);
        assert_eq!(
            admit(&dir, &request, &consumer),
            Err(LEVEL_UNCONFIRMED.to_string())
        );
    }

    /// P3-T24 (D34, G10): a level raise of a running or dormant session is
    /// admitted by its `session_raise` confirmation, consumed for that session
    /// at that level; the pin is unchanged.
    #[test]
    fn a_session_raise_confirmation_admits_its_session_only() {
        let dir = scratch_dir("node-level-session-raise");
        let mut request = session_request("strict", "standard");
        request.session_confirmation_id = Some(SESSION_CONF.into());
        let consumer = FakeConsumer::answering(vec![Ok("session_raise")]);
        assert_eq!(admit(&dir, &request, &consumer), Ok(()));
        assert_eq!(
            consumer.calls(),
            vec![(SESSION_CONF.to_string(), json!({ "sessionId": SID, "level": "standard" }))]
        );
        assert_eq!(pinned_level_at(&dir, "https://a.example", "agent-1"), "strict");
        // Refused by the server (another session's, or used up): not admitted
        // (a session this node never admitted).
        let dir = scratch_dir("node-level-session-raise-refused");
        let consumer = FakeConsumer::answering(vec![Err("confirmation_mismatch")]);
        assert_eq!(
            admit(&dir, &request, &consumer),
            Err(LEVEL_UNCONFIRMED.to_string())
        );
        // A profile_raise answer is no session raise.
        let consumer = FakeConsumer::answering(vec![Ok("profile_raise")]);
        assert_eq!(
            admit(&dir, &request, &consumer),
            Err(LEVEL_UNCONFIRMED.to_string())
        );
    }

    /// P3-fix M2: a session confirmed at a level resumes at that level, and
    /// restarts lower, without a fresh confirmation; a raise back up needs one
    /// again (D24), and the confirmation never admits another session.
    #[test]
    fn a_confirmed_session_resumes_and_lowers_without_a_new_confirmation() {
        let dir = scratch_dir("node-level-session-resume");
        let mut first = session_request("strict", "open");
        first.session_confirmation_id = Some(SESSION_CONF.into());
        let consumer = FakeConsumer::answering(vec![Ok("session_start")]);
        assert_eq!(admit(&dir, &first, &consumer), Ok(()));
        // A resume at the same level: the confirmation is used up, none comes.
        let consumer = FakeConsumer::answering(vec![]);
        assert_eq!(admit(&dir, &session_request("strict", "open"), &consumer), Ok(()));
        // A level switch that lowers it restarts at once.
        assert_eq!(admit(&dir, &session_request("strict", "standard"), &consumer), Ok(()));
        assert!(consumer.calls().is_empty());
        // Back up to Open is a raise: confirmed again or refused.
        assert_eq!(
            admit(&dir, &session_request("strict", "open"), &consumer),
            Err(LEVEL_UNCONFIRMED.to_string())
        );
        // The agent's pin is untouched, and another session is not admitted.
        assert_eq!(pinned_level_at(&dir, "https://a.example", "agent-1"), "strict");
        let mut other = session_request("strict", "standard");
        other.session_id = Some("22222222-2222-4222-8222-222222222222".into());
        assert_eq!(admit(&dir, &other, &consumer), Err(LEVEL_UNCONFIRMED.to_string()));
    }

    #[test]
    fn the_kept_request_never_carries_the_access_token() {
        let mut request = session_request("standard", "standard");
        request.access_token = Some(AccessToken("lia_user_session_secret".into()));
        request.session_confirmation_id = Some(SESSION_CONF.into());
        let kept = kept_request(&request).unwrap();
        let text = kept.to_string();
        assert!(!text.contains("lia_user_session_secret"));
        assert!(!text.contains("accessToken") && !text.contains(SESSION_CONF));
        assert_eq!(kept["sessionId"], SID);
        assert_eq!(kept["level"], "standard");
        // It reads back as a request.
        let back: NodeJobRequest = serde_json::from_value(kept).unwrap();
        assert_eq!(back.folder_name.as_deref(), Some("my-repo"));
    }

    /// D43 F2: the protocol the claiming server advertised stays with the run,
    /// so a reloaded page talks to that server alike.
    #[test]
    fn the_kept_request_keeps_the_server_protocol() {
        for protocol in [3, 4] {
            let request: NodeJobRequest = serde_json::from_value(json!({
                "jobId": "j-1",
                "agentId": "agent-1",
                "model": "claude-haiku-4-5",
                "profile": { "level": "standard", "liaisonTools": true },
                "prompt": "fix the flaky test",
                "serverProtocol": protocol,
            }))
            .unwrap();
            let kept = kept_request(&request).unwrap();
            assert_eq!(kept["serverProtocol"], json!(protocol));
        }
    }

    /// P3-T24: a restarted run names the level it came from.
    #[test]
    fn job_document_carries_the_level_change() {
        let mut request = session_request("standard", "strict");
        request.level_change = Some(LevelChange { from: "standard".into() });
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert_eq!(doc["session"]["levelChange"], json!({ "from": "standard" }));
        request.level_change = Some(LevelChange { from: "bypass".into() });
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert!(doc["session"].get("levelChange").is_none());
    }

    #[test]
    fn a_profile_raise_then_a_session_start_in_one_claim_consumes_both_in_order() {
        let dir = scratch_dir("node-level-both");
        let mut request = session_request("standard", "open");
        request.profile_confirmation_id = Some(PROFILE_CONF.into());
        request.session_confirmation_id = Some(SESSION_CONF.into());
        let consumer = FakeConsumer::answering(vec![Ok("profile_raise"), Ok("session_start")]);
        assert_eq!(admit(&dir, &request, &consumer), Ok(()));
        let calls: Vec<String> = consumer.calls().into_iter().map(|(id, _)| id).collect();
        assert_eq!(calls, vec![PROFILE_CONF.to_string(), SESSION_CONF.to_string()]);
        assert_eq!(pinned_level_at(&dir, "https://a.example", "agent-1"), "standard");
    }

    #[test]
    fn a_lower_profile_level_lowers_the_pin() {
        let dir = scratch_dir("node-level-lower");
        pin_level_at(&dir, "https://a.example", "agent-1", "open").unwrap();
        let consumer = FakeConsumer::answering(vec![]);
        assert_eq!(admit(&dir, &session_request("standard", "standard"), &consumer), Ok(()));
        assert_eq!(pinned_level_at(&dir, "https://a.example", "agent-1"), "standard");
        assert_eq!(
            admit(&dir, &session_request("standard", "open"), &consumer),
            Err(LEVEL_UNCONFIRMED.to_string())
        );
        assert!(consumer.calls().is_empty());
    }

    #[test]
    fn an_old_hash_pin_reads_as_strict() {
        let dir = scratch_dir("node-level-old-hash");
        // As builds before P1 pinned a confirmed profile: its hash, a bare string.
        std::fs::write(
            dir.join(NODE_PROFILES_FILE),
            json!({ token_key("https://a.example", "agent-1"): "4850914f6ce24f3f" }).to_string(),
        )
        .unwrap();
        assert_eq!(pinned_level_at(&dir, "https://a.example", "agent-1"), "strict");
        let consumer = FakeConsumer::answering(vec![]);
        assert_eq!(
            admit(&dir, &session_request("standard", "standard"), &consumer),
            Err(LEVEL_UNCONFIRMED.to_string())
        );
        assert_eq!(admit(&dir, &session_request("strict", "strict"), &consumer), Ok(()));
    }

    #[test]
    fn level_pins_lists_every_agent_of_this_server() {
        let dir = scratch_dir("node-level-pins");
        pin_level_at(&dir, "https://a.example", "agent-1", "standard").unwrap();
        pin_level_at(&dir, "https://a.example/", "agent-2", "open").unwrap();
        pin_level_at(&dir, "https://b.example", "agent-3", "standard").unwrap();
        // An old hash pin (a bare string, as before P1) is not a level pin.
        let mut doc: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join(NODE_PROFILES_FILE)).unwrap()).unwrap();
        doc[token_key("https://a.example", "agent-4")] = json!("oldhash");
        std::fs::write(dir.join(NODE_PROFILES_FILE), doc.to_string()).unwrap();
        pin_connection_at(&dir, "https://a.example", "agent-1", "c-1").unwrap();
        let mut pins = level_pins_at(&dir, "https://a.example/");
        pins.sort();
        assert_eq!(
            pins,
            vec![
                ("agent-1".to_string(), "standard".to_string()),
                ("agent-2".to_string(), "open".to_string()),
            ]
        );
        assert_eq!(
            level_pins_at(&dir, "https://b.example"),
            vec![("agent-3".to_string(), "standard".to_string())]
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(NODE_PROFILES_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn consume_request_carries_both_credentials() {
        let request = consume_request(
            "https://a.example/",
            PROFILE_CONF,
            "user-session-token",
            "lnn_node_credential",
            &json!({ "agentId": "agent-1", "level": "standard" }),
        )
        .unwrap();
        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(
            request.url().as_str(),
            format!("https://a.example/api/node/level-confirmations/{PROFILE_CONF}/consume")
        );
        assert_eq!(
            request.headers().get("authorization").unwrap(),
            "Bearer user-session-token"
        );
        assert_eq!(
            request.headers().get("x-node-credential").unwrap(),
            "lnn_node_credential"
        );
        let body: serde_json::Value =
            serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
        assert_eq!(body, json!({ "agentId": "agent-1", "level": "standard" }));
        // An id that is not one the server issues never reaches a URL.
        assert!(consume_request("https://a.example", "../x", "t", "c", &json!({})).is_err());
    }

    #[test]
    fn windows_refuses_strict_without_sandbox() {
        assert!(level_refused_on("windows", "strict"));
        assert!(level_refused_on("windows", "standard"));
        assert!(!level_refused_on("windows", "open"));
        assert!(!level_refused_on("macos", "strict"));
        assert!(!level_refused_on("linux", "standard"));
    }

    #[test]
    fn job_document_carries_the_session() {
        let mut request = session_request("standard", "open");
        request.repo = Some("git@gitlab.com:example/sample-repo.git".into());
        let doc = job_document(
            &request,
            "https://liaison.example/",
            Path::new("/tmp/root"),
            None,
            &[],
        );
        assert_eq!(doc["kind"], "unattended");
        assert_eq!(doc["profile"], json!({ "level": "standard", "liaisonTools": true }));
        assert_eq!(
            doc["session"],
            json!({
                "id": SID,
                "source": "dispatch",
                "folderPath": "/Users/owner/code/my-repo",
                "folderName": "my-repo",
                "repo": "git@gitlab.com:example/sample-repo.git",
                "model": "claude-haiku-4-5",
                "level": "open",
                "profileLevel": "standard",
                "configKind": "owner",
                "liaisonTools": true,
            })
        );
        assert!(doc["profile"].get("template").is_none());
        // A chat turn carries no session.
        let doc = job_document(
            &chat_request(Some("edit")),
            "https://liaison.example/",
            Path::new("/tmp/root"),
            None,
            &[],
        );
        assert!(doc.get("session").is_none());
    }

    /// S51 (D28): a message the owner confirmed while another Claude Code
    /// drove the session reaches the sidecar; an unconfirmed one carries nothing.
    #[test]
    fn job_document_carries_the_driven_elsewhere_confirmation() {
        let mut request = session_request("standard", "standard");
        let confirmed: ResumeRequest = serde_json::from_value(json!({
            "sdkSessionId": "sdk-1",
            "after": "message",
            "commandId": "0b0c3e1a-2f4d-4e5f-8a6b-7c8d9e0f1a2b",
            "confirmDrivenElsewhere": true,
        }))
        .unwrap();
        request.resume = Some(confirmed);
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert_eq!(doc["session"]["resume"]["confirmDrivenElsewhere"], json!(true));
        let plain: ResumeRequest = serde_json::from_value(json!({
            "sdkSessionId": "sdk-1",
            "after": "message",
            "commandId": "0b0c3e1a-2f4d-4e5f-8a6b-7c8d9e0f1a2b",
        }))
        .unwrap();
        request.resume = Some(plain);
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert!(doc["session"]["resume"].get("confirmDrivenElsewhere").is_none());
    }

    /// A44 (W3 T12): a Take over import's recorded cwd below its shared
    /// folder reaches the sidecar as the claim names it.
    #[test]
    fn job_document_carries_cwd_subdir() {
        let mut request: NodeJobRequest = serde_json::from_value(json!({
            "jobId": "j-1", "agentId": "agent-1", "agentName": "Personal",
            "model": "claude-haiku-4-5", "profile": { "level": "standard", "liaisonTools": true },
            "prompt": "carry on", "sessionId": SID, "source": "import",
            "folderPath": "/Users/owner/code/my-repo", "folderName": "my-repo",
            "configKind": "owner", "cwdSubdir": "packages/app",
        }))
        .unwrap();
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert_eq!(doc["session"]["cwdSubdir"], json!("packages/app"));
        // The folder itself, or none: nothing to carry.
        request.cwd_subdir = Some(String::new());
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert!(doc["session"].get("cwdSubdir").is_none());
        request.cwd_subdir = None;
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert!(doc["session"].get("cwdSubdir").is_none());
    }

    /// D53: a Take over recorded in the shared repo's worktree outside the
    /// folder carries that worktree; an unsafe one is written empty so the
    /// sidecar refuses the run instead of running in the folder.
    #[test]
    fn job_document_carries_a_worktree_path_and_blanks_an_unsafe_one() {
        let mut request: NodeJobRequest = serde_json::from_value(json!({
            "jobId": "j-1", "agentId": "agent-1", "agentName": "Personal",
            "model": "claude-haiku-4-5", "profile": { "level": "standard", "liaisonTools": true },
            "prompt": "carry on", "sessionId": SID, "source": "import",
            "folderPath": "/Users/owner/code/my-repo", "folderName": "my-repo",
            "configKind": "owner", "cwdSubdir": "pkg", "worktreePath": "/tmp/my-repo-wt",
        }))
        .unwrap();
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert_eq!(doc["session"]["worktreePath"], json!("/tmp/my-repo-wt"));
        assert_eq!(doc["session"]["cwdSubdir"], json!("pkg"));
        for bad in ["rel/wt", "/a/../b", "/a/", "/a\0b"] {
            request.worktree_path = Some(bad.into());
            let doc =
                job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
            assert_eq!(doc["session"]["worktreePath"], json!(""), "{bad:?}");
        }
        request.worktree_path = None;
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert!(doc["session"].get("worktreePath").is_none());
    }

    /// W2-D5: the folder's holder reaches the sidecar as text, with control
    /// characters dropped and its length capped; absent or blank, nothing.
    #[test]
    fn job_document_carries_the_folder_holder_as_plain_text() {
        let mut request: NodeJobRequest = serde_json::from_value(json!({
            "jobId": "j-1", "agentId": "agent-1", "agentName": "Personal",
            "model": "claude-haiku-4-5", "profile": { "level": "standard", "liaisonTools": true },
            "prompt": "fix it", "sessionId": SID, "source": "dispatch",
            "folderPath": "/Users/owner/code/my-repo", "folderName": "my-repo",
            "configKind": "owner", "folderHeldBy": "\"Fix cart\nTotal\" (ac492ea4, waiting on you)",
        }))
        .unwrap();
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert_eq!(
            doc["session"]["folderHeldBy"],
            json!("\"Fix cartTotal\" (ac492ea4, waiting on you)")
        );
        request.folder_held_by = Some("x".repeat(500));
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert_eq!(doc["session"]["folderHeldBy"].as_str().unwrap().len(), 200);
        request.folder_held_by = Some(" \n ".into());
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert!(doc["session"].get("folderHeldBy").is_none());
        request.folder_held_by = None;
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert!(doc["session"].get("folderHeldBy").is_none());
    }

    /// A44: a subdir that climbs out, is absolute or is malformed is never
    /// written (the sidecar then has none to run in, and refuses nothing it
    /// was not given; the server's value is never trusted as a path).
    #[test]
    fn job_document_drops_an_unsafe_cwd_subdir() {
        let mut request = session_request("standard", "standard");
        for bad in ["../up", "/etc", "a/../b", "a//b", "./a", "a\\b", "a\0b"] {
            request.cwd_subdir = Some(bad.into());
            let doc =
                job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
            assert!(doc["session"].get("cwdSubdir").is_none(), "{bad:?} was written");
        }
        request.cwd_subdir = Some("a".repeat(1025));
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert!(doc["session"].get("cwdSubdir").is_none());
    }

    /// A62: the first resume after a Take over carries the byte offset its
    /// replay reached; the sidecar replays from there before the SDK starts.
    #[test]
    fn job_document_carries_catch_up_from() {
        let mut request = session_request("standard", "standard");
        let resume: ResumeRequest = serde_json::from_value(json!({
            "sdkSessionId": "5e0c1d2a-7b3f-4c8e-9a1d-2f3e4d5c6b7a",
            "after": "message",
            "commandId": "0b0c3e1a-2f4d-4e5f-8a6b-7c8d9e0f1a2b",
            "catchUpFrom": 1234,
        }))
        .unwrap();
        request.resume = Some(resume);
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert_eq!(doc["session"]["resume"]["catchUpFrom"], json!(1234));
        request.resume.as_mut().unwrap().catch_up_from = None;
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert!(doc["session"]["resume"].get("catchUpFrom").is_none());
    }

    /// R7, P3-T04: a resume run names the SDK session it resumes, why, and
    /// the message that woke it; a fresh run and a chat turn carry none.
    #[test]
    fn job_document_carries_the_resume() {
        let mut request = session_request("standard", "standard");
        request.resume = Some(ResumeRequest {
            sdk_session_id: Some("sdk-1".into()),
            after: "message".into(),
            command_id: Some("0b0c3e1a-2f4d-4e5f-8a6b-7c8d9e0f1a2b".into()),
            ..Default::default()
        });
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert_eq!(
            doc["session"]["resume"],
            json!({
                "sdkSessionId": "sdk-1",
                "after": "message",
                "commandId": "0b0c3e1a-2f4d-4e5f-8a6b-7c8d9e0f1a2b",
            })
        );
        request.resume = Some(ResumeRequest {
            sdk_session_id: Some("sdk-1".into()),
            after: "offline".into(),
            command_id: None,
            ..Default::default()
        });
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert_eq!(
            doc["session"]["resume"],
            json!({ "sdkSessionId": "sdk-1", "after": "offline" })
        );
        // An unknown reason is never passed on.
        request.resume = Some(ResumeRequest {
            sdk_session_id: Some("sdk-1".into()),
            after: "whenever".into(),
            command_id: None,
            ..Default::default()
        });
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert!(doc["session"].get("resume").is_none());
        // Walk D3: no SDK session but a message: the message still goes (a fresh run acks it).
        request.resume = Some(ResumeRequest {
            sdk_session_id: None,
            after: "message".into(),
            command_id: Some("0b0c3e1a-2f4d-4e5f-8a6b-7c8d9e0f1a2b".into()),
            ..Default::default()
        });
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert_eq!(
            doc["session"]["resume"],
            json!({ "after": "message", "commandId": "0b0c3e1a-2f4d-4e5f-8a6b-7c8d9e0f1a2b" })
        );
        // Neither a session nor a message: nothing to resume.
        request.resume = Some(ResumeRequest {
            sdk_session_id: None,
            after: "offline".into(),
            command_id: None,
            ..Default::default()
        });
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert!(doc["session"].get("resume").is_none());
        // The claim's null parses.
        let parsed: ResumeRequest =
            serde_json::from_value(json!({ "sdkSessionId": null, "after": "message", "commandId": "c" }))
                .unwrap();
        assert!(parsed.sdk_session_id.is_none());
        request.resume = None;
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert!(doc["session"].get("resume").is_none());
        let mut chat = chat_request(Some("edit"));
        chat.resume = Some(ResumeRequest {
            sdk_session_id: Some("sdk-1".into()),
            after: "offline".into(),
            command_id: None,
            ..Default::default()
        });
        let doc = job_document(&chat, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert!(doc.get("session").is_none());
    }

    /// Walk D7: the node's offered models reach the sidecar, ids only.
    #[test]
    fn job_document_carries_the_offered_models() {
        let mut request = session_request("strict", "strict");
        request.offered_models = Some(vec![
            "claude-haiku-4-5".into(),
            "claude-sonnet-5".into(),
            "claude-opus-5-5[1m]".into(),
            "bad id; rm".into(),
        ]);
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert_eq!(
            doc["session"]["offeredModels"],
            json!(["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5-5[1m]"])
        );
        request.offered_models = None;
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert!(doc["session"].get("offeredModels").is_none());
    }

    /// S24: the session's reasoning level reaches the sidecar.
    #[test]
    fn job_document_carries_effort() {
        let mut request = session_request("strict", "strict");
        for level in ["low", "medium", "high", "xhigh", "max"] {
            request.effort = Some(level.into());
            let doc =
                job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
            assert_eq!(doc["session"]["effort"], json!(level));
        }
        request.effort = None;
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert!(doc["session"].get("effort").is_none());
    }

    /// S24: a level the SDK does not name never reaches the sidecar.
    #[test]
    fn job_document_drops_an_unknown_effort() {
        let mut request = session_request("strict", "strict");
        request.effort = Some("ultra".into());
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert!(doc["session"].get("effort").is_none());
        // The page's JSON (`effort: null`) parses as none.
        let parsed: NodeJobRequest = serde_json::from_value(json!({
            "jobId": "j", "agentId": "a", "model": "claude-haiku-4-5",
            "profile": {}, "prompt": "p", "effort": null
        }))
        .unwrap();
        assert!(parsed.effort.is_none());
    }

    /// S30, S57: the session's autonomy and its finish step reach the sidecar.
    #[test]
    fn job_document_carries_autonomy_and_finish_with() {
        let mut request = session_request("standard", "standard");
        for autonomy in ["guided", "autonomous"] {
            for finish in ["pr", "commit", "none"] {
                request.autonomy = Some(autonomy.into());
                request.finish_with = Some(finish.into());
                let doc =
                    job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
                assert_eq!(doc["session"]["autonomy"], json!(autonomy));
                assert_eq!(doc["session"]["finishWith"], json!(finish));
            }
        }
        request.autonomy = None;
        request.finish_with = None;
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert!(doc["session"].get("autonomy").is_none());
        assert!(doc["session"].get("finishWith").is_none());
    }

    /// D43 F10: the claiming server's protocol reaches the sidecar, which runs
    /// no finish step for a server older than wave 2.
    #[test]
    fn job_document_carries_the_server_protocol() {
        let mut request = session_request("standard", "standard");
        for protocol in [3, 4] {
            request.server_protocol = Some(protocol);
            let doc =
                job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
            assert_eq!(doc["session"]["serverProtocol"], json!(protocol));
        }
        request.server_protocol = None;
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert!(doc["session"].get("serverProtocol").is_none());
    }

    /// S30: a value outside the allowlists never reaches the sidecar.
    #[test]
    fn job_document_drops_unknown_autonomy() {
        let mut request = session_request("standard", "standard");
        request.autonomy = Some("yolo".into());
        request.finish_with = Some("merge".into());
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert!(doc["session"].get("autonomy").is_none());
        assert!(doc["session"].get("finishWith").is_none());
        // The page's JSON (`finishWith: null`) parses as none.
        let parsed: NodeJobRequest = serde_json::from_value(json!({
            "jobId": "j", "agentId": "a", "model": "claude-haiku-4-5",
            "profile": {}, "prompt": "p", "autonomy": "autonomous", "finishWith": null
        }))
        .unwrap();
        assert_eq!(parsed.autonomy.as_deref(), Some("autonomous"));
        assert!(parsed.finish_with.is_none());
    }

    /// S33 (A28): a restart for an autonomy switch resumes the same SDK
    /// session; the reason is never filtered out (a fresh session would lose it).
    #[test]
    fn resume_reason_autonomy_is_kept() {
        let mut request = session_request("standard", "standard");
        request.resume = Some(ResumeRequest {
            sdk_session_id: Some("sdk-1".into()),
            after: "autonomy".into(),
            command_id: None,
            ..Default::default()
        });
        let doc = job_document(&request, "https://a.example", Path::new("/tmp/root"), None, &[]);
        assert_eq!(
            doc["session"]["resume"],
            json!({ "sdkSessionId": "sdk-1", "after": "autonomy" })
        );
    }

    /// L20: a Stop names one run; no name stops every run (app quit).
    #[test]
    fn stop_runs_stops_one_session_or_every_run() {
        use crate::node_runs::node_runs_tests::fake_run;
        let runs = LiveRuns::default();
        for (job, session, pid) in [("j-a", Some("s-a"), 1), ("j-b", Some("s-b"), 2), ("j-c", None, 3)] {
            let (run, _) = fake_run(job, session, session.is_none(), false, pid);
            let key = run_key(session, job);
            runs.insert(key, run, Caps::default()).ok().unwrap();
        }
        // A job id that is not this session's run stops nothing.
        assert!(!stop_runs(&runs, Some("s-a"), Some("j-b")));
        assert_eq!(runs.keys().len(), 3);
        assert!(stop_runs(&runs, Some("s-a"), Some("j-a")));
        assert!(stop_runs(&runs, None, Some("j-b")));
        assert_eq!(runs.keys(), vec!["job:j-c".to_string()]);
        assert!(!stop_runs(&runs, Some("s-none"), None));
        assert!(stop_runs(&runs, None, None));
        assert!(!runs.any_live());
        assert!(!stop_runs(&runs, None, None));
    }

    #[test]
    fn a_run_line_names_its_session_and_job() {
        assert_eq!(
            line_payload(&Some("s-1".into()), "j-1", "{}"),
            json!({ "sessionId": "s-1", "jobId": "j-1", "line": "{}" })
        );
        assert_eq!(line_payload(&None, "j-1", "x"), json!({ "jobId": "j-1", "line": "x" }));
    }

    /// D35: the request's caps, else the defaults; routines and agent tags
    /// are background runs.
    #[test]
    fn a_request_names_its_caps_and_background() {
        let mut request = session_request("standard", "standard");
        assert_eq!(request_caps(&request), crate::node_runs::Caps::default());
        assert!(!request_background(&request));
        request.caps = Some(crate::node_runs::Caps {
            max_live: 2,
            max_background: 1,
        });
        request.source = Some("routine".into());
        assert_eq!(request_caps(&request).max_live, 2);
        assert!(request_background(&request));
        request.source = Some("agent_tag".into());
        assert!(request_background(&request));
        let parsed: NodeJobRequest = serde_json::from_value(json!({
            "jobId": "j", "agentId": "a", "model": "m", "profile": {}, "prompt": "p",
            "caps": { "maxLive": 3, "maxBackground": 1 },
            "resume": { "sdkSessionId": "s", "after": "crash" },
        }))
        .unwrap();
        assert_eq!(parsed.caps.unwrap().max_live, 3);
        assert_eq!(parsed.resume.unwrap().after, "crash");
    }

    #[test]
    fn job_document_carries_the_shared_folders() {
        // The sidecar write-denies the config files of every advertised folder
        // (D25, D31): the shell must hand it the list it advertises.
        let base = scratch_dir("node-job-shared-folders");
        let config = base.join("config");
        let code = base.join("code");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::create_dir_all(code.join("app").join(".git")).unwrap();
        std::fs::write(
            config.join(NODE_SETTINGS_FILE),
            serde_json::to_vec(&json!({ "sharedRoots": [code.to_string_lossy()] })).unwrap(),
        )
        .unwrap();
        let folders = shared_folders_at(&config, "https://liaison.example");
        assert_eq!(folders.len(), 2);
        let doc = job_document(
            &session_request("standard", "standard"),
            "https://liaison.example",
            Path::new("/tmp/root"),
            None,
            &folders,
        );
        assert_eq!(
            doc["sharedFolders"],
            json!([
                { "name": "code", "path": code.to_string_lossy(), "kind": "root", "gitDefaultBranch": null },
                { "name": "app", "path": code.join("app").to_string_lossy(), "kind": "repo", "gitDefaultBranch": null },
            ])
        );
        // A chat turn is not a session: no folders.
        let chat = job_document(
            &chat_request(Some("edit")),
            "https://liaison.example",
            Path::new("/tmp/root"),
            None,
            &folders,
        );
        assert!(chat.get("sharedFolders").is_none());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn job_document_never_carries_the_access_token() {
        let mut request = session_request("standard", "standard");
        request.access_token = Some(AccessToken("lia_user_session_secret".into()));
        let text = job_document(
            &request,
            "https://liaison.example",
            Path::new("/tmp/root"),
            None,
            &[],
        )
        .to_string();
        assert!(!text.contains("lia_user_session_secret"));
        assert!(!text.contains("accessToken") && !text.contains("access_token"));
        // Nor does a debug print of the request.
        assert!(!format!("{request:?}").contains("lia_user_session_secret"));
    }

    #[test]
    fn a_boot_timeout_is_reported_as_timeout() {
        assert_eq!(boot_answer(BootWait::TimedOut), Err(TIMEOUT.to_string()));
        assert_eq!(boot_answer(BootWait::Failed), Err(SPAWN_FAILED.to_string()));
        assert_eq!(boot_answer(BootWait::Booted), Ok(json!({ "ok": true })));
        assert!(BOOT_TIMEOUT_TEXT.contains("30 s"));
    }

    // ─── P1-T45: the connection commands, and no GitHub protection left ──

    fn connected_token(connection: &str) -> StoredToken {
        StoredToken {
            token: jwt(json!({ "mcpConnectionId": connection, "exp": 1 })),
            expires_at_ms: 1,
            refresh_token: None,
        }
    }

    #[test]
    fn connect_agent_uses_a_stored_token_before_minting() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        // A stored token: no mint, and its connection is pinned for the claims.
        let dir = scratch_dir("node-connect-stored");
        let minted = std::cell::Cell::new(false);
        let saved = std::cell::Cell::new(false);
        let answer = runtime.block_on(connect_agent_with(
            &dir,
            "https://a.example",
            "agent-1",
            || async { Some(connected_token("11111111-aaaa-bbbb-cccc-000000000001")) },
            || {
                minted.set(true);
                async { None }
            },
            |_| saved.set(true),
        ));
        assert_eq!(answer, Ok(Some("11111111-aaaa-bbbb-cccc-000000000001".into())));
        assert!(!minted.get(), "a stored token is used before any mint");
        assert!(!saved.get());
        assert_eq!(
            pinned_connection_at(&dir, "https://a.example", "agent-1").as_deref(),
            Some("11111111-aaaa-bbbb-cccc-000000000001")
        );
        // None stored: minted with the window's session, saved, pinned.
        let dir = scratch_dir("node-connect-mint");
        let answer = runtime.block_on(connect_agent_with(
            &dir,
            "https://a.example",
            "agent-2",
            || async { None },
            || async { Some(connected_token("22222222-aaaa-bbbb-cccc-000000000002")) },
            |_| saved.set(true),
        ));
        assert_eq!(answer, Ok(Some("22222222-aaaa-bbbb-cccc-000000000002".into())));
        assert!(saved.get());
        assert_eq!(
            pinned_connection_at(&dir, "https://a.example", "agent-2").as_deref(),
            Some("22222222-aaaa-bbbb-cccc-000000000002")
        );
        // Neither: not connected, nothing pinned.
        let dir = scratch_dir("node-connect-none");
        let answer = runtime.block_on(connect_agent_with(
            &dir,
            "https://a.example",
            "agent-3",
            || async { None },
            || async { None },
            |_| {},
        ));
        assert_eq!(answer, Ok(None));
        assert_eq!(pinned_connection_at(&dir, "https://a.example", "agent-3"), None);
    }

    #[test]
    fn confirm_connection_does_nothing_when_refused() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let connected = std::cell::Cell::new(false);
        let refused = runtime.block_on(confirm_connection_with(
            || async { false },
            || {
                connected.set(true);
                async { Ok(Some("c-1".to_string())) }
            },
        ));
        assert_eq!(refused, Ok(json!({ "confirmed": false, "connected": false })));
        assert!(!connected.get(), "Don't allow connects nothing");
        let allowed = runtime.block_on(confirm_connection_with(
            || async { true },
            || async { Ok(Some("c-1".to_string())) },
        ));
        assert_eq!(allowed, Ok(json!({ "confirmed": true, "connected": true })));
        let unconnected = runtime.block_on(confirm_connection_with(
            || async { true },
            || async { Ok(None) },
        ));
        assert_eq!(unconnected, Ok(json!({ "confirmed": true, "connected": false })));
        // D43: today's dialog, for My node chat only, with no profile in it.
        let (title, body) = connection_dialog("Personal");
        assert_eq!(title, "Allow Personal on this computer?");
        assert_eq!(
            body,
            "Personal will run Claude Code on this computer in My computer chat, where you answer its permission prompts. Allow it to connect to Liaison?"
        );
        assert_eq!(connection_dialog("  ").0, "Allow This agent on this computer?");
        assert_eq!(CONNECTION_ALLOW_LABEL, "Allow");
        assert_eq!(CONNECTION_DENY_LABEL, "Don't allow");
    }

    #[test]
    fn no_github_protection_code_is_left() {
        let source = include_str!("node_job.rs");
        for needle in [
            ["recheck_branch", "_protection"].concat(),
            ["GITHUB", "_API"].concat(),
            ["api.github.com", "/repos"].concat(),
            ["profile", "_hash"].concat(),
            ["confirm_node", "_profile"].concat(),
            ["gate", "_profile"].concat(),
        ] {
            assert!(!source.contains(&needle), "node_job.rs still holds {needle}");
        }
    }

    #[test]
    fn level_pins_answer_agent_and_level() {
        let dir = scratch_dir("node-level-pins-answer");
        pin_level_at(&dir, "https://a.example", "agent-1", "standard").unwrap();
        assert_eq!(
            level_pins_answer(&dir, "https://a.example"),
            json!([{ "agentId": "agent-1", "level": "standard" }])
        );
    }
}
