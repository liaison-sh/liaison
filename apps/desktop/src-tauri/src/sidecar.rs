// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shell owns the sidecar process: it spawns it as a Tauri sidecar (argv
// passthrough, piped stdio, no shell), writes CONTROL LINES to its stdin, and
// forwards every stdout line to the webview as a Tauri event. The sidecar
// frames one JSON object per line in both directions, so the forwarding side
// is a line splitter and nothing more.
//
// Protocol 2: the sidecar is a session, not a turn. The window does NOT compose
// control JSON: every control line the shell will write is composed here, from
// a TYPED command, and the shell checks what the window asked for before it is
// written. See "The threat model" in `src/session/sidecar-ipc-contract.md`.

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use url::Url;

use crate::auth::{AuthError, StoredToken};
use crate::permission_gate::{
    ask_natively, decide, prompt_effect, record_prompt_line, Decision, PromptEffect, ShellAskBook,
};
use crate::sidecar_watch::{
    boot_settled, exit_log_line, take_if, BootOutcome, SidecarExit, SidecarLog, SidecarWatch,
    BOOT_TIMEOUT, SIDECAR_EXITED_EVENT,
};

/// The Tauri event carrying one raw stdout line from the sidecar.
pub const SIDECAR_LINE_EVENT: &str = "sidecar-line";
/// The Tauri event carrying one raw stderr line from the sidecar.
pub const SIDECAR_STDERR_EVENT: &str = "sidecar-stderr";
/// The Tauri event the UI renders as a visible reconnect state.
pub const RECONNECT_EVENT: &str = "liaison-reconnect-required";
/// The Tauri event carrying one `liaison://` URL the OS handed the app.
pub const DEEP_LINK_EVENT: &str = "liaison-deep-link";

/// The permission modes a session may run in. The window sends one as a
/// string, so anything outside this list is either a typo that would reach the
/// SDK as an unknown flag or a value somebody chose from outside the UI.
/// Auto is first because it is the default (sidecar/auto-policy.ts).
pub const PERMISSION_MODES: [&str; 5] = ["auto", "manual", "edit", "plan", "bypass"];

/// The start refusals. They are variants rather than sentences because the
/// window renders the copy.
pub const UNKNOWN_PERMISSION_MODE: &str = "UnknownPermissionMode";
pub const CWD_NOT_A_DIRECTORY: &str = "CwdNotADirectory";
pub const BYPASS_DECLINED: &str = "BypassDeclined";
/// The window named a folder the SHELL never chose (P6d-FX2, SK-1).
pub const FOLDER_NOT_CHOSEN: &str = "FolderNotChosen";

/// What the bypass confirmation asks. The folder is named in it because that
/// is the whole of what is being handed over.
pub fn bypass_prompt(cwd: &str) -> String {
    format!("This session may change anything in {cwd} without asking first. Start it?")
}

/// The title that dialog carries.
pub const BYPASS_TITLE: &str = "Bypass permissions";

/// A start (or a switch) into Auto or Edit the person did not confirm in the
/// shell's own dialog (D11).
pub const MODE_DECLINED: &str = "ModeDeclined";

/// The modes that let the agent act on this computer without asking each
/// time: Auto runs every command it does not judge destructive, Edit changes
/// files, Bypass anything. A page script must not be able to hand one over
/// (D11), so each is the shell's own question, against the folder it covers.
pub const UNPROMPTED_MODES: [&str; 3] = ["auto", "edit", "bypass"];

/// What the shell asks before a session runs in one of `UNPROMPTED_MODES`.
pub fn unprompted_mode_question(mode: &str, cwd: &str) -> Option<(String, String)> {
    if !UNPROMPTED_MODES.contains(&mode) {
        return None;
    }
    match mode {
        "bypass" => Some((BYPASS_TITLE.to_string(), bypass_prompt(cwd))),
        "auto" => Some((
            "Auto mode".to_string(),
            format!(
                "This session may run commands in {cwd} without asking first (it still asks \
                 before ones that look destructive). Start it?"
            ),
        )),
        "edit" => Some((
            "Edit mode".to_string(),
            format!("This session may change files in {cwd} without asking first. Start it?"),
        )),
        _ => None,
    }
}

/// The refusal a declined question answers with.
fn declined(mode: &str) -> String {
    if mode == "bypass" {
        BYPASS_DECLINED.into()
    } else {
        MODE_DECLINED.into()
    }
}

/// Everything that has to be true before a child is spawned, with the
/// confirmation injected so both answers are drivable without a window.
///
/// Order matters: the mode is checked first, so an unknown one never reaches
/// the dialog, and the folder is checked before the user is asked about it,
/// so the question is never asked about a path that does not exist.
pub fn validate_start_request<C>(
    permission_mode: &str,
    cwd: &str,
    folder_chosen: bool,
    confirm_bypass: C,
) -> Result<(), String>
where
    C: FnOnce(&str, &str) -> bool,
{
    if !PERMISSION_MODES.contains(&permission_mode) {
        return Err(UNKNOWN_PERMISSION_MODE.into());
    }
    // WHERE THE FOLDER CAME FROM, before anything about the folder itself
    // (P6d-FX2, SK-1). The window is not a boundary: any script in apps/web
    // reaches `__TAURI_INTERNALS__`, so a session whose root the CALLER named
    // was a session rooted wherever that script liked, and `read_local_file`
    // is bounded by exactly that root. A folder the shell itself chose (the
    // native picker, or the recent list the shell persists) is the only kind
    // that starts one.
    if !folder_chosen {
        return Err(FOLDER_NOT_CHOSEN.into());
    }
    if !Path::new(cwd).is_dir() {
        return Err(CWD_NOT_A_DIRECTORY.into());
    }
    if let Some((title, message)) = unprompted_mode_question(permission_mode, cwd) {
        if !confirm_bypass(&title, &message) {
            return Err(declined(permission_mode));
        }
    }
    Ok(())
}

/// EVERYTHING THAT HAS TO BE TRUE BEFORE A RUNNING SESSION CHANGES MODE.
///
/// The window is not a boundary: any script in apps/web reaches
/// `__TAURI_INTERNALS__`, so `setPermissionMode("bypass")` from a page script
/// was a silent removal of every permission prompt the user was relying on.
/// The same two checks `start_session` makes are made here, in the same order,
/// and the native confirmation is the shell's own rather than a dialog the
/// page draws and can therefore skip.
///
/// `cwd` is the folder the running session holds, or none when nothing is
/// running: a mode chosen before a session starts is a preference, and the
/// folder it would hand over is not known yet, so the question is asked at
/// `start_session` instead.
pub fn validate_permission_mode_change<C>(
    permission_mode: &str,
    cwd: Option<&str>,
    confirm_bypass: C,
) -> Result<(), String>
where
    C: FnOnce(&str, &str) -> bool,
{
    if !PERMISSION_MODES.contains(&permission_mode) {
        return Err(UNKNOWN_PERMISSION_MODE.into());
    }
    let Some(cwd) = cwd else {
        return Ok(());
    };
    if let Some((title, message)) = unprompted_mode_question(permission_mode, cwd) {
        if !confirm_bypass(&title, &message) {
            return Err(declined(permission_mode));
        }
    }
    Ok(())
}

/// The one deep link shape the shell acts on: `liaison://connect?server=<url>`
/// with the server an http(s) URL that names a host. Everything else is
/// dropped, because the value goes straight into "which box does this install
/// talk to" and a `javascript:` or `file:` server, or a `liaison://` URL
/// pointing at some other host, is an attacker choosing that for the user.
/// Returns the server URL the link carries.
pub fn validate_deep_link(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    if parsed.scheme() != "liaison" {
        return None;
    }
    if parsed.host_str() != Some("connect") {
        return None;
    }
    let pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    let [(key, server)] = pairs.as_slice() else {
        return None;
    };
    if key != "server" {
        return None;
    }
    let target = Url::parse(server).ok()?;
    if target.scheme() != "http" && target.scheme() != "https" {
        return None;
    }
    if target.host_str().unwrap_or("").is_empty() {
        return None;
    }
    Some(server.clone())
}

/// `liaison://oauth-complete?code=<hex>&state=<s>` or `?error=<e>&state=<s>`:
/// the end of a system-browser sign-in (RFC 8252). The server's handoff page
/// sends the browser there and the OS hands the link to this app. It is attacker
/// reachable like every `liaison://` link, and what makes it harmless is not
/// this check but the PKCE verifier the WINDOW holds: a code redeemed without
/// it releases nothing, and the window ignores a `state` it did not mint. This
/// check only keeps anything that is not that exact shape out of the page.
pub fn validate_oauth_complete_link(url: &str) -> bool {
    let Ok(parsed) = Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "liaison" || parsed.host_str() != Some("oauth-complete") {
        return false;
    }
    if !matches!(parsed.path(), "" | "/") || parsed.fragment().is_some() {
        return false;
    }
    let mut code = None;
    let mut error = None;
    let mut state = None;
    for (key, value) in parsed.query_pairs() {
        let slot = match key.as_ref() {
            "code" => &mut code,
            "error" => &mut error,
            "state" => &mut state,
            _ => return false,
        };
        if slot.replace(value.into_owned()).is_some() {
            return false;
        }
    }
    let Some(state) = state else {
        return false;
    };
    let state_ok = (16..=128).contains(&state.len())
        && state
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !state_ok {
        return false;
    }
    match (code, error) {
        (Some(code), None) => {
            code.len() == 64 && code.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        }
        (None, Some(error)) => !error.is_empty() && error.len() <= 200,
        _ => false,
    }
}

/// What the shell does with one `liaison://` link the OS handed it.
#[derive(Debug, PartialEq, Eq)]
pub enum DeepLinkRoute {
    /// `liaison://connect?server=...`: forwarded, and the window asks before
    /// it applies anything. Unchanged.
    Connect,
    /// `liaison://oauth-complete?...`: forwarded, and the window is brought
    /// to the front, because the user is in their browser and the sign-in
    /// they just finished is in this window.
    OAuthComplete,
}

impl DeepLinkRoute {
    /// Whether the window comes forward for this link.
    pub fn raises_window(&self) -> bool {
        matches!(self, DeepLinkRoute::OAuthComplete)
    }
}

/// The route for a link, or None to drop it. Every accepted link reaches the
/// window on `DEEP_LINK_EVENT` as it arrived; the window re-checks the shape.
pub fn route_deep_link(url: &str) -> Option<DeepLinkRoute> {
    if validate_deep_link(url).is_some() {
        return Some(DeepLinkRoute::Connect);
    }
    if validate_oauth_complete_link(url) {
        return Some(DeepLinkRoute::OAuthComplete);
    }
    None
}

/// Refusals `open_oauth_url` answers with.
pub const OAUTH_URL_NOT_BOUND: &str = "no server address is bound to this install";
pub const OAUTH_URL_REFUSED: &str = "not this server's desktop sign-in route";

/// THE ONE KIND OF URL THE WINDOW MAY HAVE OPENED IN THE SYSTEM BROWSER: this
/// install's own server's `/api/auth/oauth/<provider>/authorize`, asking for
/// the desktop flow with an S256 challenge. The page is on the other side of a
/// boundary and anything in it could call the command, so an arbitrary URL
/// here would be the page launching whatever the OS opens for a scheme (a
/// `file:` path, another app's handler). The server re-validates every
/// parameter; this is the shell's half.
pub fn validate_oauth_authorize_url(url: &str, bound: Option<&str>) -> Result<Url, &'static str> {
    let bound = bound.ok_or(OAUTH_URL_NOT_BOUND)?;
    let bound = Url::parse(bound).map_err(|_| OAUTH_URL_NOT_BOUND)?;
    let parsed = Url::parse(url).map_err(|_| OAUTH_URL_REFUSED)?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(OAUTH_URL_REFUSED);
    }
    if parsed.origin() != bound.origin()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(OAUTH_URL_REFUSED);
    }
    if parsed.fragment().is_some() {
        return Err(OAUTH_URL_REFUSED);
    }
    let segments: Vec<&str> = parsed
        .path_segments()
        .map(|s| s.collect())
        .unwrap_or_default();
    let [api, auth, oauth, provider, authorize] = segments.as_slice() else {
        return Err(OAUTH_URL_REFUSED);
    };
    if (*api, *auth, *oauth, *authorize) != ("api", "auth", "oauth", "authorize")
        || provider.is_empty()
    {
        return Err(OAUTH_URL_REFUSED);
    }
    let query: Vec<(String, String)> = parsed
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let has = |key: &str, value: Option<&str>| {
        query
            .iter()
            .any(|(k, v)| k == key && value.map_or(!v.is_empty(), |want| v == want))
    };
    if !has("client", Some("desktop"))
        || !has("code_challenge_method", Some("S256"))
        || !has("code_challenge", None)
        || !has("state", None)
    {
        return Err(OAUTH_URL_REFUSED);
    }
    Ok(parsed)
}

/// Opens this install's desktop sign-in in the user's SYSTEM browser (RFC
/// 8252). The identity provider's page must never run in this app's own
/// webview: Google refuses embedded user agents, and its passkey sign-in cannot
/// reach the platform passkey store from one. Opened from Rust, so the window
/// holds no shell permission of its own (capabilities/default.json grants none).
#[tauri::command]
pub fn open_oauth_url<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    let bound = resolve_base_url(&app);
    let target = validate_oauth_authorize_url(&url, bound.as_deref()).map_err(str::to_string)?;
    // `Shell::open` is deprecated in favour of the opener plugin; it is the
    // same `open` crate underneath and adding a plugin for one call is not
    // worth the new permission surface.
    #[allow(deprecated)]
    app.shell()
        .open(target.as_str(), None)
        .map_err(|error| format!("could not open the browser: {error}"))
}

/// The client id the desktop's device grant is initiated under. The server
/// admits it whenever its MCP device flow is enabled at all
/// (`mcp/device-client-policy.ts`), so the two must agree byte for byte.
pub const DESKTOP_DEVICE_CLIENT_ID: &str = "liaison-desktop";

/// Refusals `open_device_approval_url` answers with.
pub const APPROVAL_URL_REFUSED: &str = "ApprovalUrlRefused";

/// The approval page of this install's OWN server, and nothing else: same
/// origin as the bound address, path `/auth/device`, a single non-empty `code`
/// parameter, no credentials and no fragment. The window can call the command,
/// so an unchecked URL here would be the page launching whatever the OS opens.
pub fn validate_device_approval_url(url: &str, bound: Option<&str>) -> Result<Url, &'static str> {
    let bound = bound.ok_or(OAUTH_URL_NOT_BOUND)?;
    let bound = Url::parse(bound).map_err(|_| OAUTH_URL_NOT_BOUND)?;
    let parsed = Url::parse(url).map_err(|_| APPROVAL_URL_REFUSED)?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.origin() != bound.origin()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/auth/device"
    {
        return Err(APPROVAL_URL_REFUSED);
    }
    let query: Vec<(String, String)> = parsed
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    match query.as_slice() {
        [(key, value)] if key == "code" && !value.is_empty() => Ok(parsed),
        _ => Err(APPROVAL_URL_REFUSED),
    }
}

fn open_device_approval_page<R: Runtime>(app: &AppHandle<R>, url: &str) -> Result<(), String> {
    let bound = resolve_base_url(app);
    let target = validate_device_approval_url(url, bound.as_deref()).map_err(str::to_string)?;
    #[allow(deprecated)]
    app.shell()
        .open(target.as_str(), None)
        .map_err(|error| format!("could not open the browser: {error}"))
}

/// Opens the device approval page in the SYSTEM browser: the window's own
/// "Open the approval page" button. A link with `target=_blank` does nothing in
/// this webview, so the button has to come through the shell.
#[tauri::command]
pub fn open_device_approval_url<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    open_device_approval_page(&app, &url)
}

/// Refusals `open_external_url` answers with.
pub const EXTERNAL_URL_REFUSED: &str = "ExternalUrlRefused";

/// A link the user clicked in the window, to be opened by the system: an
/// `http`, `https`, `mailto` or `tel` URL and nothing else, with no credentials in
/// it. The window can call the command, so an unchecked URL here would be the
/// page launching whatever the OS opens (`file:`, custom schemes, an app's
/// own URL handler). A web URL also needs a host.
pub fn validate_external_url(url: &str) -> Result<Url, &'static str> {
    let parsed = Url::parse(url.trim()).map_err(|_| EXTERNAL_URL_REFUSED)?;
    match parsed.scheme() {
        "http" | "https" => {
            if parsed.host_str().map_or(true, str::is_empty)
                || !parsed.username().is_empty()
                || parsed.password().is_some()
            {
                return Err(EXTERNAL_URL_REFUSED);
            }
            Ok(parsed)
        }
        "mailto" => {
            if parsed.path().is_empty() && parsed.query().is_none() {
                return Err(EXTERNAL_URL_REFUSED);
            }
            Ok(parsed)
        }
        // A phone number for the system dialer (Contacts' call action). Only
        // dial characters, so nothing but a number reaches the handler (spaces
        // stay literal or arrive as `%20`).
        "tel" => {
            let number = parsed.path();
            let dial_char =
                |c: char| c.is_ascii_digit() || matches!(c, '+' | '-' | '.' | '(' | ')' | ' ' | '%');
            let dialable =
                number.chars().any(|c| c.is_ascii_digit()) && number.chars().all(dial_char);
            if !dialable || parsed.query().is_some() {
                return Err(EXTERNAL_URL_REFUSED);
            }
            Ok(parsed)
        }
        _ => Err(EXTERNAL_URL_REFUSED),
    }
}

/// Opens a link the user clicked in the SYSTEM browser (or mail client, for
/// `mailto:`). A `target=_blank` link and `window.open` do nothing in this
/// webview, so every external link in the window comes through here. Opened
/// from Rust, so the window holds no shell permission of its own.
#[tauri::command]
pub fn open_external_url<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    let target = validate_external_url(&url).map_err(str::to_string)?;
    #[allow(deprecated)]
    app.shell()
        .open(target.as_str(), None)
        .map_err(|error| format!("could not open the browser: {error}"))
}

/// Writes one control line. The sidecar splits stdin on newlines, so a line
/// without its terminator is a hang, not an error.
pub fn send_line<W: Write>(stdin: &mut W, line: &str) -> io::Result<()> {
    stdin.write_all(line.as_bytes())?;
    stdin.write_all(b"\n")?;
    stdin.flush()
}

/// S59 (D36): the server's credential for the person's message this turn
/// answers, 32 random bytes in base64url without padding.
pub fn is_turn_credential(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The one control line the shell composes on the window's behalf: the
/// `turn` line, carrying the turn's credential when it has the server's
/// shape. Anything else is dropped rather than refused: the turn still runs,
/// and its gateway calls are refused as they are without one.
pub fn turn_line_with_credential(prompt: &str, turn_credential: Option<&str>) -> String {
    match turn_credential.filter(|value| is_turn_credential(value)) {
        Some(credential) => serde_json::json!({
            "type": "turn",
            "prompt": prompt,
            "turnCredential": credential,
        })
        .to_string(),
        None => serde_json::json!({ "type": "turn", "prompt": prompt }).to_string(),
    }
}

/// The control line that changes a RUNNING session's permission mode. Composed
/// here, like every other line, because the window may not write one.
pub fn permission_mode_line(mode: &str) -> String {
    serde_json::json!({ "type": "set_permission_mode", "mode": mode }).to_string()
}

/// The line that ends the session cleanly, so the SDK query closes rather than
/// the child being killed mid turn.
pub const SHUTDOWN_LINE: &str = r#"{"type":"shutdown"}"#;

/// The line that stops the running turn.
pub const INTERRUPT_LINE: &str = r#"{"type":"interrupt"}"#;

/// The refusals the two checked control commands answer with.
pub const UNKNOWN_PERMISSION_REQUEST: &str = "UnknownPermissionRequest";
pub const UNKNOWN_PERMISSION_BEHAVIOR: &str = "UnknownPermissionBehavior";
pub const MCP_TOOL_NOT_ALLOWED: &str = "McpToolNotAllowed";

/// The Liaison MCP tools the WINDOW may drive through the shell, each with the
/// reason it is here. The relay runs on the session's AGENT SCOPED bearer, so
/// an open `mcp_call` would let any script in the page spend that token on any
/// tool the agent holds. A tool earns a line here when a desktop surface has to
/// poll it and the answer is only a status; anything that writes belongs to the
/// agent's own turn, where the permission path covers it.
pub const MCP_TOOL_ALLOWLIST: [(&str, &str); 1] = [(
    "liaison_approval_status",
    "the approval banner polls it to say whether a gated call is still waiting",
)];

pub fn mcp_tool_allowed(tool: &str) -> bool {
    MCP_TOOL_ALLOWLIST.iter().any(|(name, _)| *name == tool)
}

/// The permission requests the sidecar has asked and nobody has answered yet.
///
/// It is the whole of the authority `respond_permission` has: the window may
/// answer an id that is OUTSTANDING, once. A request id travels to the window
/// on a broadcast event, so it is public to every script in the page; what is
/// not public is whether it is still open, and that lives here.
#[derive(Default)]
pub struct PendingPermissions(pub Mutex<HashSet<String>>);

/// What one sidecar stdout line does to the outstanding set.
#[derive(Debug, PartialEq, Eq)]
// Kept for the page set's own tests; the running shell records through
// `permission_gate::record_prompt_line` and answers through `decide`.
#[cfg_attr(not(test), allow(dead_code))]
pub enum LineEffect {
    /// A `permission_request` the SDK is parked on, which the page may answer.
    Outstanding(String),
    /// A `permission_request` only the shell's own dialog may allow (D11): a
    /// shell command, a write outside the folder (`permission_gate.rs`). It is
    /// never in the page's set, so an id heard on the broadcast answers nothing.
    ShellConfirmed(String),
    /// The turn (or the process) ended: nothing can still be answered.
    RetireAll,
    Nothing,
}

/// Reads one protocol 2 line for its effect on the outstanding set. The shell
/// parses every line on its way to the webview anyway, so the record is made
/// from the sidecar's own words and never from the window's.
// Kept for the page set's own tests; the running shell records through
// `permission_gate::record_prompt_line` and answers through `decide`.
#[cfg_attr(not(test), allow(dead_code))]
pub fn line_effect(line: &str) -> LineEffect {
    line_effect_in(line, None)
}

/// `line_effect` for a session running in `folder`, which decides whether a
/// file write is inside it.
// Kept for the page set's own tests; the running shell records through
// `permission_gate::record_prompt_line` and answers through `decide`.
#[cfg_attr(not(test), allow(dead_code))]
pub fn line_effect_in(line: &str, folder: Option<&Path>) -> LineEffect {
    match prompt_effect(line, folder) {
        PromptEffect::PageAnswerable(id) => LineEffect::Outstanding(id),
        PromptEffect::ShellConfirmed(id, _) => LineEffect::ShellConfirmed(id),
        // A parked tool call cannot outlive its turn: once the turn is done or
        // the process is finished, an answer would be answering nothing.
        PromptEffect::RetireAll => LineEffect::RetireAll,
        PromptEffect::Nothing => LineEffect::Nothing,
    }
}

/// The page's set only: what `respond_permission` lets the page answer on its
/// own. A shell-confirmed prompt is recorded by `record_prompt_line` into the
/// shell's book instead, and never here.
// Kept for the page set's own tests; the running shell records through
// `permission_gate::record_prompt_line` and answers through `decide`.
#[cfg_attr(not(test), allow(dead_code))]
pub fn apply_line_effect(pending: &Mutex<HashSet<String>>, line: &str) {
    match line_effect(line) {
        LineEffect::Outstanding(id) => {
            if let Ok(mut open) = pending.lock() {
                open.insert(id);
            }
        }
        LineEffect::RetireAll => clear_permissions(pending),
        LineEffect::ShellConfirmed(_) | LineEffect::Nothing => {}
    }
}

/// The prompts only the shell's own dialog may allow (`permission_gate.rs`).
#[derive(Default)]
pub struct ShellPermissions(pub Mutex<ShellAskBook>);

/// Retires every prompt of the running session, the page's and the shell's.
fn retire_prompts<R: Runtime>(app: &AppHandle<R>) {
    if let Some(pending) = app.try_state::<PendingPermissions>() {
        clear_permissions(&pending.0);
    }
    if let Some(shell) = app.try_state::<ShellPermissions>() {
        if let Ok(mut book) = shell.0.lock() {
            book.retire_all();
        }
    }
}

/// The folder the running session holds, if any.
fn held_folder<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.try_state::<SessionFolder>()
        .and_then(|folder| folder.0.lock().ok().and_then(|held| held.clone()))
}

/// Retires one id, answering whether it was open. Once: a second answer for
/// the same request finds nothing, which is what makes a replayed allow a
/// refusal rather than a second execution.
// Kept for the page set's own tests; the running shell records through
// `permission_gate::record_prompt_line` and answers through `decide`.
#[cfg_attr(not(test), allow(dead_code))]
pub fn take_permission(pending: &Mutex<HashSet<String>>, request_id: &str) -> bool {
    match pending.lock() {
        Ok(mut open) => open.remove(request_id),
        Err(_) => false,
    }
}

pub fn clear_permissions(pending: &Mutex<HashSet<String>>) {
    if let Ok(mut open) = pending.lock() {
        open.clear();
    }
}

/// The running sidecar, so a turn sent from the window reaches the same child
/// the setup hook started.
#[derive(Default)]
pub struct SidecarSession(pub Mutex<Option<CommandChild>>);

/// A `Write` view of the child's stdin, so the framing lives in one place
/// (`send_prompt`) and is testable against a plain byte sink.
struct ChildStdin<'a>(&'a mut CommandChild);

impl Write for ChildStdin<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0
            .write(buf)
            .map(|_| buf.len())
            .map_err(|error| io::Error::other(error.to_string()))
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Writes one control line the SHELL composed to the running sidecar. Private:
/// there is no command that writes a line the window handed over, because the
/// window is not a boundary (an XSS in apps/web reaches `__TAURI_INTERNALS__`)
/// and a free channel to the sidecar's stdin is a free channel to the agent.
fn write_control(session: &SidecarSession, line: &str) -> Result<(), String> {
    let mut running = session.0.lock().map_err(|error| error.to_string())?;
    let child = running.as_mut().ok_or("the sidecar is not running")?;
    send_line(&mut ChildStdin(child), line).map_err(|error| error.to_string())
}

/// Sends one turn's prompt to the running sidecar.
#[tauri::command]
pub fn send_turn(
    session: State<'_, SidecarSession>,
    prompt: String,
    turn_credential: Option<String>,
) -> Result<(), String> {
    write_control(
        &session,
        &turn_line_with_credential(&prompt, turn_credential.as_deref()),
    )
}

/// Interrupts the running turn. It carries nothing, so there is nothing to
/// check: the worst an unwanted interrupt does is stop a turn the user can
/// start again.
#[tauri::command]
pub fn interrupt_turn(session: State<'_, SidecarSession>) -> Result<(), String> {
    write_control(&session, INTERRUPT_LINE)
}

/// Answers ONE outstanding permission request.
///
/// The id has to be one the sidecar asked for and has not been answered yet:
/// the request id rides a broadcast event, so every script in the page sees it,
/// and without this check a forged `allow` would run a tool the user never
/// approved. `updatedInput` is not accepted at all: the window has no editor
/// for it, and an input the shell forwards unread is an arbitrary tool call.
///
/// D11: a prompt for a call that acts on this computer outside Liaison (a shell
/// command, a write outside the folder) is never the page's to allow. Its id is
/// not in the page's set at all; an allow for it is written only after the
/// shell's own native dialog says yes, and a no there is written as a deny.
/// Answers the decision actually written, `"allow"` or `"deny"`, so the window
/// shows what happened rather than what it asked for.
#[tauri::command]
pub async fn respond_permission<R: Runtime>(
    app: AppHandle<R>,
    request_id: String,
    behavior: String,
    message: Option<String>,
) -> Result<String, String> {
    if behavior != "allow" && behavior != "deny" {
        return Err(UNKNOWN_PERMISSION_BEHAVIOR.into());
    }
    let pending = app
        .try_state::<PendingPermissions>()
        .ok_or(UNKNOWN_PERMISSION_REQUEST)?;
    let shell = app
        .try_state::<ShellPermissions>()
        .ok_or(UNKNOWN_PERMISSION_REQUEST)?;
    let decision = decide(
        &pending.0,
        &shell.0,
        &request_id,
        behavior == "allow",
        message,
        |ask| ask_natively(&app, ask),
    )
    .map_err(|_| UNKNOWN_PERMISSION_REQUEST.to_string())?;
    let session = app
        .try_state::<SidecarSession>()
        .ok_or("the sidecar is not running")?;
    let (line, written) = permission_response(&request_id, &decision);
    write_control(&session, &line)?;
    Ok(written.to_string())
}

/// The control line for one decision, and the behavior it carries.
pub fn permission_response(request_id: &str, decision: &Decision) -> (String, &'static str) {
    let mut line = serde_json::json!({
        "type": "permission_response",
        "requestId": request_id,
    });
    let behavior = match decision {
        Decision::Allow => "allow",
        Decision::Deny(message) => {
            if let Some(message) = message {
                line["message"] = serde_json::Value::String(message.clone());
            }
            "deny"
        }
    };
    line["behavior"] = serde_json::Value::String(behavior.into());
    (line.to_string(), behavior)
}

/// Changes the permission mode, for the session that is RUNNING and for the
/// one that starts next.
///
/// Two defects in one command. The mode never reached a live session at all:
/// it was consumed once, at `start_session`, so a user who switched to Manual
/// mid session saw "Manual" and got no prompts, and a user who switched to
/// Bypass saw "Bypass" and still got them. And it was reachable from the page
/// with no confirmation of any kind, which made every prompt the user relied
/// on removable by a script.
///
/// Answering `Ok` with nothing running is deliberate: the window is choosing
/// the mode the NEXT session starts in, which is a preference and not an
/// escalation. The bypass question is asked again at `start_session`, against
/// the folder actually being handed over.
#[tauri::command]
pub async fn set_permission_mode<R: Runtime>(
    app: AppHandle<R>,
    mode: String,
) -> Result<(), String> {
    let running_folder = held_folder(&app).map(|path| path.to_string_lossy().into_owned());
    validate_permission_mode_change(&mode, running_folder.as_deref(), |title, message| {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
        app.dialog()
            .message(message)
            .title(title)
            .buttons(MessageDialogButtons::OkCancel)
            .blocking_show()
    })?;
    let Some(session) = app.try_state::<SidecarSession>() else {
        return Ok(());
    };
    // Nothing running is not a refusal: the mode is remembered by the window
    // and applied at the next start.
    if session
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .is_none()
    {
        return Ok(());
    }
    write_control(&session, &permission_mode_line(&mode))?;
    // The person just said, in the shell's own dialog, that this session may
    // change anything without asking: the shell prompts it is still parked on
    // are answered by that, not by a second dialog each.
    if mode == "bypass" {
        if let Some(shell) = app.try_state::<ShellPermissions>() {
            let parked = shell
                .0
                .lock()
                .map(|mut book| book.drain())
                .unwrap_or_default();
            for id in parked {
                let (line, _) = permission_response(&id, &Decision::Allow);
                write_control(&session, &line)?;
            }
        }
    }
    Ok(())
}

/// Relays ONE allowlisted Liaison MCP tool call through the sidecar's own
/// client. The allowlist is the point: the relay spends the session's agent
/// scoped bearer, and the window may only spend it on tools that read a status.
#[tauri::command]
pub fn call_mcp_tool(
    session: State<'_, SidecarSession>,
    request_id: String,
    tool: String,
    args: serde_json::Value,
) -> Result<(), String> {
    if !mcp_tool_allowed(&tool) {
        return Err(MCP_TOOL_NOT_ALLOWED.into());
    }
    let line = serde_json::json!({
        "type": "mcp_call",
        "requestId": request_id,
        "tool": tool,
        "args": if args.is_object() { args } else { serde_json::json!({}) },
    });
    write_control(&session, &line.to_string())
}

/// GIVING UP ON THE DEVICE CODE, ON THE SERVER TOO (P6d-FX7, SK-7).
///
/// The dialog's Cancel used to take the code off a page signal and nothing
/// else: the poll loop kept running and the pending grant stayed approvable
/// for its whole window, so a user who cancelled and then followed the link
/// they had already copied completed a flow this window had forgotten it
/// started. The grant is taken off the slot (which ends the wait on the next
/// pass) and the server is told the code is dead.
///
/// Answers whether there was anything to release, so a window can say so. A
/// failed round trip is not an error the user can act on: the code is already
/// unreachable from here and the grant expires on its own.
#[tauri::command]
pub async fn cancel_device_approval() -> bool {
    let Some(grant) = crate::auth::take_pending_grant() else {
        return false;
    };
    if let Err(error) = crate::auth::cancel(&grant.config, &grant.device_code).await {
        eprintln!("liaison: the device grant could not be cancelled on the server ({error})");
    }
    true
}

/// Ends the session: the shutdown line first, so the SDK query closes and the
/// transcript is written, then the kill for a child that does not go.
#[tauri::command]
pub fn stop_session<R: Runtime>(
    app: AppHandle<R>,
    session: State<'_, SidecarSession>,
    folder: State<'_, SessionFolder>,
) -> Result<(), String> {
    // Nothing to read once nothing is running: the folder goes with the child,
    // and so does every prompt that was still waiting for an answer.
    replace_running(&folder.0, None);
    retire_prompts(&app);
    let child = {
        let mut running = session.0.lock().map_err(|error| error.to_string())?;
        running.take()
    };
    let Some(child) = child else { return Ok(()) };
    stop_child(child);
    Ok(())
}

/// How long a sidecar is given to act on its shutdown line before it is killed.
const SHUTDOWN_GRACE: std::time::Duration = std::time::Duration::from_millis(750);

/// Waits out the grace period somewhere OTHER than the caller's thread, then
/// kills. A `stop_session` invoke runs on Tauri's IPC thread, and sleeping
/// three quarters of a second there stalls every other command the window
/// sends, including the `start_session` that is usually right behind it. The
/// join handle is returned so a caller that must not outlive the child (the
/// exit hook) can wait for it; every other caller drops it.
pub fn kill_after_grace<T, K>(child: T, kill: K) -> std::thread::JoinHandle<()>
where
    T: Send + 'static,
    K: FnOnce(T) + Send + 'static,
{
    std::thread::spawn(move || {
        std::thread::sleep(SHUTDOWN_GRACE);
        kill(child);
    })
}

/// Asks a child to end, then makes sure it did. `kill` consumes the handle, so
/// there is nothing left to leak whichever way it went.
/// The same stop, for a caller that does not wait for it (a server switch).
pub(crate) fn stop_child_detached(child: CommandChild) {
    let _ = stop_child(child);
}

fn stop_child(mut child: CommandChild) -> std::thread::JoinHandle<()> {
    let _ = send_line(&mut ChildStdin(&mut child), SHUTDOWN_LINE);
    kill_after_grace(child, |child| {
        let _ = child.kill();
    })
}

/// Takes whatever is in the slot and stops it, leaving the slot empty. The
/// stop is injected so the exit hook's own wiring is drivable without a child.
pub fn stop_running<T, S>(slot: &Mutex<Option<T>>, stop: S) -> bool
where
    S: FnOnce(T),
{
    match replace_running(slot, None) {
        Some(child) => {
            stop(child);
            true
        }
        None => false,
    }
}

/// What the app's exit hook runs. The sidecar is a child process of the shell,
/// so a window closed without this leaves a Bun process holding the session's
/// bearer token alive with nothing reading its stdout. The wait is joined here
/// and nowhere else: the process is about to go, so the child has to be gone
/// first.
pub fn stop_managed_session<R: Runtime>(app: &AppHandle<R>) {
    if let Some(session) = app.try_state::<SidecarSession>() {
        stop_running(&session.0, |child| {
            let _ = stop_child(child).join();
        });
    }
}

/// What the window needs to know about the machine it is running on: the
/// Windows shell-tool notice, and the path separator a folder name is drawn
/// with. Nothing here is a capability decision; it is a rendering one.
#[derive(serde::Serialize)]
pub struct PlatformInfo {
    pub os: &'static str,
    pub arch: &'static str,
}

pub fn platform_info_value() -> PlatformInfo {
    PlatformInfo {
        os: match std::env::consts::OS {
            "macos" => "macos",
            "windows" => "windows",
            _ => "linux",
        },
        arch: std::env::consts::ARCH,
    }
}

#[tauri::command]
pub fn platform_info() -> PlatformInfo {
    platform_info_value()
}

/// THE FOLDERS THE SHELL ITSELF CHOSE, for this window's lifetime.
///
/// It is the whole of the authority `start_session` has over where a session
/// is rooted. A folder gets in here two ways and no other: the user walked the
/// native picker to it, or it was already in the recent list the shell
/// persists (which only the picker ever writes). Kept beside `SessionFolder`
/// for the same reason that one is: the window must not be able to name the
/// set its own request is checked against.
#[derive(Default)]
pub struct PickedFolders(pub Mutex<HashSet<PathBuf>>);

/// Whether two paths name the same directory. Canonicalized, so a `.` walk or
/// a trailing separator is the same folder rather than a second one; a path
/// that cannot be canonicalized (it went away) falls back to a literal
/// comparison, which can only ever be stricter.
pub fn same_folder(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

/// Whether this folder is one the shell chose, from the window's picks and
/// from the persisted recent list together.
pub fn folder_is_chosen(picked: &HashSet<PathBuf>, remembered: &[String], cwd: &str) -> bool {
    let requested = Path::new(cwd);
    picked.iter().any(|known| same_folder(known, requested))
        || remembered
            .iter()
            .any(|known| same_folder(Path::new(known), requested))
}

pub fn remember_picked(picked: &Mutex<HashSet<PathBuf>>, folder: &str) {
    if let Ok(mut set) = picked.lock() {
        set.insert(PathBuf::from(folder));
    }
}

/// The file the recent folders live in, beside the token and the server
/// address, and owner-only for the same reason: it is the set a session may be
/// rooted in, so a list the page could write would be no check at all. This is
/// why the list is NOT in the webview's `localStorage`, which every script in
/// apps/web can edit.
pub const RECENT_FOLDERS_FILE: &str = "liaison-folders.json";

/// How many folders one agent is remembered in. Five, as the window's own list
/// showed five.
pub const RECENT_FOLDERS_LIMIT: usize = 5;

/// The list after a folder was chosen: newest first, deduplicated, capped.
pub fn recent_after_pick(existing: &[String], folder: &str, limit: usize) -> Vec<String> {
    let folder = folder.trim();
    if folder.is_empty() {
        return existing.to_vec();
    }
    let mut next = vec![folder.to_string()];
    for entry in existing {
        if entry != folder && next.len() < limit {
            next.push(entry.clone());
        }
    }
    next.truncate(limit);
    next
}

fn recent_folders_document(dir: &Path) -> serde_json::Map<String, serde_json::Value> {
    fs::read(dir.join(RECENT_FOLDERS_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn folders_of(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(|entry| entry.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// The folders this agent has run in, newest first. Filed by SERVER and agent
/// (`token_key`, the same key the agent's token is filed under): two agents on
/// one machine are two working lives, and an agent id means nothing on another
/// server, so one server's folders are never offered on the next.
pub fn read_recent_folders_at(dir: &Path, key: &str) -> Vec<String> {
    folders_of(recent_folders_document(dir).get(key))
}

/// Every folder remembered for ONE server, whichever of its agents remembered
/// it. This is the set `start_session` checks against, because an agent is not
/// a boundary (the window names the agent too), but a server is.
pub fn all_recent_folders_at(dir: &Path, server: &str) -> Vec<String> {
    let mut all = Vec::new();
    for (key, value) in recent_folders_document(dir) {
        if !crate::servers::folder_key_is_for(&key, server) {
            continue;
        }
        for folder in folders_of(Some(&value)) {
            if !all.contains(&folder) {
                all.push(folder);
            }
        }
    }
    all
}

pub fn record_recent_folder_at(
    dir: &Path,
    agent_id: &str,
    folder: &str,
) -> io::Result<Vec<String>> {
    let mut document = recent_folders_document(dir);
    let next = recent_after_pick(
        &folders_of(document.get(agent_id)),
        folder,
        RECENT_FOLDERS_LIMIT,
    );
    document.insert(
        agent_id.to_string(),
        serde_json::Value::Array(
            next.iter()
                .map(|entry| serde_json::Value::String(entry.clone()))
                .collect(),
        ),
    );
    fs::create_dir_all(dir)?;
    write_private(
        &dir.join(RECENT_FOLDERS_FILE),
        &serde_json::to_vec(&serde_json::Value::Object(document))?,
    )?;
    Ok(next)
}

/// EVERYTHING THAT MAKES A FOLDER STARTABLE, in one place.
///
/// `pick_folder` performed exactly this after the user walked the native
/// dialog: the folder joins this window's `PickedFolders`, and when an agent is
/// named it joins that agent's persisted recent list. It is a function now
/// because the debug seed below has to go in through this door and no other
/// (P6d-FX3): a seeded folder is a SHELL chosen folder, so `start_session`'s
/// check stays exactly the check it was.
fn adopt_chosen_folder<R: Runtime>(app: &AppHandle<R>, agent_id: Option<&str>, chosen: &str) {
    if let Some(picked) = app.try_state::<PickedFolders>() {
        remember_picked(&picked.0, chosen);
    }
    if let (Some(agent_id), Some(dir), Some(server)) = (
        agent_id.map(str::trim).filter(|id| !id.is_empty()),
        config_dir(app),
        resolve_base_url(app),
    ) {
        // A list that could not be written costs the user a folder they have
        // to pick again, never a start that should have been refused.
        let _ = record_recent_folder_at(&dir, &crate::servers::folder_key(&server, agent_id), chosen);
    }
}

/// DEBUG BUILDS ONLY (P6d-FX3): the variable a driven walk seeds one recent
/// folder with, documented beside the DOM probe in `sidecar-ipc-contract.md`.
///
/// Why it exists: the native Open panel takes no synthetic input on macOS, and
/// the recent list is empty on a fresh install, so a walk that may not forge
/// the recent file (that file IS the check) has no way to reach a live local
/// session at all. This gives it one folder, chosen by whoever launched the
/// app, through the picker's own recording path.
pub const DEBUG_SEED_RECENT_FOLDER_ENV: &str = "LIAISON_DEBUG_SEED_RECENT_FOLDER";

/// The folder the variable names, when it names a directory that exists. Pure,
/// so the rule is the same in both arms below and readable from a test.
pub fn seed_folder_from(value: Option<String>) -> Option<PathBuf> {
    let raw = value?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if path.is_dir() {
        Some(path)
    } else {
        None
    }
}

/// Read ONCE, at startup, and remembered for the life of the process.
static DEBUG_SEED_FOLDER: OnceLock<Option<PathBuf>> = OnceLock::new();

/// The seeded folder on a DEBUG build.
///
/// A RELEASE BUILD READS NOTHING. The release arm below is the whole of the
/// release behaviour: the variable's name does not appear in it, so a shipped
/// app is inert whatever the environment says, and the source test in
/// `sidecar_tests` pins that.
#[cfg(debug_assertions)]
pub fn debug_seed_folder() -> Option<&'static Path> {
    DEBUG_SEED_FOLDER
        .get_or_init(|| seed_folder_from(std::env::var(DEBUG_SEED_RECENT_FOLDER_ENV).ok()))
        .as_deref()
}

/// Nothing, on a release build.
#[cfg(not(debug_assertions))]
pub fn debug_seed_folder() -> Option<&'static Path> {
    None
}

/// Reads the seed at startup, so the answer is fixed before any window can ask
/// and a variable changed later changes nothing. A no op on a release build.
pub fn arm_debug_seed() {
    if let Some(folder) = debug_seed_folder() {
        eprintln!("liaison: debug recent folder seed {}", folder.display());
    }
}

/// Puts the seeded folder in this agent's recent list, once, the first time the
/// window asks about that agent. Answers whether the list was written.
fn seed_recent_folder<R: Runtime>(app: &AppHandle<R>, agent_id: &str, existing: &[String]) -> bool {
    let Some(seed) = debug_seed_folder() else {
        return false;
    };
    if existing
        .iter()
        .any(|entry| same_folder(Path::new(entry), seed))
    {
        return false;
    }
    adopt_chosen_folder(app, Some(agent_id), &seed.to_string_lossy());
    true
}

/// The folders this agent has run in, for the window to offer. Reading is all
/// it does: the list is written by the picker and by nothing else, and on a
/// debug build by the seed above, which goes through the picker's own path.
#[tauri::command]
pub fn recent_folders<R: Runtime>(app: AppHandle<R>, agent_id: String) -> Vec<String> {
    let (Some(dir), Some(server)) = (config_dir(&app), resolve_base_url(&app)) else {
        return Vec::new();
    };
    let key = crate::servers::folder_key(&server, &agent_id);
    let existing = read_recent_folders_at(&dir, &key);
    if seed_recent_folder(&app, &agent_id, &existing) {
        return read_recent_folders_at(&dir, &key);
    }
    existing
}

/// The folder a local session runs in. A DIRECTORY picker and nothing else:
/// the dialog plugin has no scope of its own, so the only file dialog the
/// shell exposes is this one.
///
/// It is also the ONLY way a folder becomes startable (P6d-FX2, SK-1): what
/// the user walked to is recorded in `PickedFolders` and, when an agent is
/// named, in that agent's recent list, and `start_session` refuses anything
/// that is in neither.
///
/// `async`, like every command that opens a blocking dialog: a synchronous
/// command runs on the main thread, and `blocking_pick_folder` waits on that
/// same thread to paint the dialog. On Windows that is a deadlock with the
/// window frozen and no dialog, found on the first real install
/// (`blocking_dialogs_are_never_called_from_a_synchronous_command`).
#[tauri::command]
pub async fn pick_folder<R: Runtime>(app: AppHandle<R>, agent_id: Option<String>) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let chosen = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .map(|folder| folder.to_string())?;
    adopt_chosen_folder(&app, agent_id.as_deref(), &chosen);
    Some(chosen)
}

/// Puts the new child in the slot and hands back whoever was there, so the
/// caller can stop the previous session. Generic over the child so the swap is
/// drivable in a test without a real process.
pub fn replace_running<T>(slot: &Mutex<Option<T>>, next: Option<T>) -> Option<T> {
    match slot.lock() {
        Ok(mut running) => std::mem::replace(&mut *running, next),
        Err(_) => None,
    }
}

/// The same swap, for a slot whose content is a PROCESS: whoever was there is
/// stopped rather than dropped.
///
/// Dropping a `CommandChild` closes this side of its pipes and leaves the
/// process running, with nothing holding its handle: `stop_session` can no
/// longer reach it, and it keeps going on the user's machine in whatever
/// permission mode it was started in. That is what a second start landing on
/// top of a first one used to do, and the grant wait is minutes long, so there
/// was plenty of time for one. Answers whether something was stopped.
pub fn replace_running_stopping<T, S>(slot: &Mutex<Option<T>>, next: Option<T>, stop: S) -> bool
where
    S: FnOnce(T),
{
    match replace_running(slot, next) {
        Some(previous) => {
            stop(previous);
            true
        }
        None => false,
    }
}

/// What a redacted secret reads as in a forwarded diagnostic.
pub const REDACTED: &str = "[redacted]";

/// One stderr line on its way to the webview, or nothing if it carries nothing.
/// The sidecar's stderr is forwarded verbatim, and the SDK and the Claude Code
/// CLI under it are free to print an MCP config or an Authorization header into
/// a diagnostic. The device code is meant to reach the window; the bearer token
/// never is, so it is struck out of every line before it leaves.
pub fn stderr_line_for_webview(raw: &str, secret: Option<&str>) -> Option<String> {
    let line = raw.trim_end();
    if line.is_empty() {
        return None;
    }
    Some(match secret {
        Some(secret) if !secret.is_empty() => line.replace(secret, REDACTED),
        _ => line.to_string(),
    })
}

/// A child that was just spawned: the handle for the session slot, its pid (how
/// its own exit recognises it in that slot), and what it says first.
pub struct SpawnedSidecar {
    pub child: CommandChild,
    pub pid: u32,
    /// `Booted` on the child's `boot` line, or `Exited` when it died first.
    pub boot: tokio::sync::oneshot::Receiver<BootOutcome>,
}

/// Follows one child's output to its end. Generic over what is done with each
/// piece so the whole of it is drivable in a test from a plain channel.
///
/// - every stdout line goes to `on_line`, and the `boot` line also settles the
///   start that is waiting on `boot`;
/// - every stderr line is redacted, kept for the exit report and handed to
///   `on_stderr`;
/// - the exit goes to `on_exit` with whether a start was still waiting for
///   `boot` and took the report: that start refuses with it, so the window is
///   told once, by the refusal, rather than twice.
pub async fn follow_child<L, S, X>(
    mut receiver: tauri::async_runtime::Receiver<CommandEvent>,
    secret: Option<String>,
    boot: tokio::sync::oneshot::Sender<BootOutcome>,
    mut on_line: L,
    mut on_stderr: S,
    on_exit: X,
) where
    L: FnMut(String),
    S: FnMut(String),
    X: FnOnce(SidecarExit, bool),
{
    let mut watch = SidecarWatch::default();
    let mut boot = Some(boot);
    let finish = |watch: &SidecarWatch,
                  boot: Option<tokio::sync::oneshot::Sender<BootOutcome>>,
                  code: Option<i32>,
                  signal: Option<i32>| {
        let exit = watch.exit(code, signal);
        let taken_by_start = match boot {
            Some(waiting) => waiting.send(BootOutcome::Exited(exit.clone())).is_ok(),
            None => false,
        };
        on_exit(exit, taken_by_start);
    };
    while let Some(event) = receiver.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim_end().to_string();
                if line.is_empty() {
                    continue;
                }
                if watch.on_stdout(&line) {
                    if let Some(waiting) = boot.take() {
                        let _ = waiting.send(BootOutcome::Booted);
                    }
                }
                on_line(line);
            }
            CommandEvent::Stderr(bytes) => {
                let raw = String::from_utf8_lossy(&bytes);
                if let Some(line) = stderr_line_for_webview(&raw, secret.as_deref()) {
                    watch.on_stderr(&line);
                    on_stderr(line);
                }
            }
            CommandEvent::Terminated(payload) => {
                finish(&watch, boot.take(), payload.code, payload.signal);
                return;
            }
            // Waiting on the child failed: nothing more will come from it.
            CommandEvent::Error(message) => {
                let line = format!("the shell lost track of the sidecar: {message}");
                watch.on_stderr(&line);
                on_stderr(line);
                finish(&watch, boot.take(), None, None);
                return;
            }
            _ => {}
        }
    }
}

/// Takes a child that exited on its own out of the session slot, with the
/// folder and the prompts that went with it. Answers false, and touches
/// nothing, when the slot already holds something else: the shell stopped this
/// child itself, or a newer start replaced it.
fn retire_exited<R: Runtime>(app: &AppHandle<R>, pid: u32) -> bool {
    let Some(session) = app.try_state::<SidecarSession>() else {
        return false;
    };
    if take_if(&session.0, |child| child.pid() == pid).is_none() {
        return false;
    }
    if let Some(folder) = app.try_state::<SessionFolder>() {
        replace_running(&folder.0, None);
    }
    retire_prompts(app);
    true
}

/// The sidecar's log, in the app's own log directory, or None where the
/// platform names none.
pub fn sidecar_log<R: Runtime>(app: &AppHandle<R>) -> Option<SidecarLog> {
    app.path()
        .app_log_dir()
        .ok()
        .map(|dir| SidecarLog::in_dir(&dir))
}

/// Spawns the compiled sidecar and forwards its stdout lines to the webview.
/// Every argument the sidecar gets is built here, never taken from the window.
///
/// Its stderr goes to the webview AND to `sidecar.log` in the app's log
/// directory: a release build has no terminal, and the webview's copy dies
/// with the window. Its exit is watched: a child that dies while it is still
/// the running session is taken out of the slot and reported to the window on
/// `SIDECAR_EXITED_EVENT`, with its stderr tail.
pub fn spawn_sidecar<R: Runtime>(
    app: &AppHandle<R>,
    args: Vec<String>,
    secret: Option<String>,
    on_token_refused: Option<Box<dyn Fn() + Send + Sync + 'static>>,
) -> Result<SpawnedSidecar, String> {
    let command = app
        .shell()
        .sidecar("liaison-sidecar")
        .map_err(|error| error.to_string())?
        .args(args.clone());
    let (receiver, child) = command.spawn().map_err(|error| error.to_string())?;
    let pid = child.pid();
    let log = sidecar_log(app);
    if let Some(log) = log.as_ref() {
        log.append(pid, &format!("started: liaison-sidecar {}", args.join(" ")));
    }
    let (boot_sender, boot) = tokio::sync::oneshot::channel();

    let lines = app.clone();
    let errors = app.clone();
    let exits = app.clone();
    let error_log = log.clone();
    tauri::async_runtime::spawn(follow_child(
        receiver,
        secret,
        boot_sender,
        move |line| {
            // Parsed BEFORE it is broadcast: the outstanding permission
            // requests are recorded from the sidecar's own words, so
            // `respond_permission` has something to check the window's answer
            // against.
            // D11: a shell command or a write outside the folder goes to the
            // shell's own book, never the page's set.
            if let (Some(pending), Some(shell)) = (
                lines.try_state::<PendingPermissions>(),
                lines.try_state::<ShellPermissions>(),
            ) {
                let folder = held_folder(&lines);
                record_prompt_line(&pending.0, &shell.0, folder.as_deref(), &line);
            }
            if reports_token_refused(&line) {
                if let Some(refused) = on_token_refused.as_ref() {
                    refused();
                }
            }
            let _ = lines.emit(SIDECAR_LINE_EVENT, line);
        },
        move |line| {
            if let Some(log) = error_log.as_ref() {
                log.append(pid, &line);
            }
            let _ = errors.emit(SIDECAR_STDERR_EVENT, line);
        },
        move |exit, taken_by_start| {
            let current = retire_exited(&exits, pid);
            if let Some(log) = log.as_ref() {
                log.append(pid, &exit_log_line(&exit, !current && !taken_by_start));
            }
            // A start that was waiting for `boot` refuses with this exit
            // itself; anything else that was still the running session is
            // news to the window, which has a turn or a claim to settle.
            if current && !taken_by_start {
                let _ = exits.emit(SIDECAR_EXITED_EVENT, exit);
            }
        },
    ));
    Ok(SpawnedSidecar { child, pid, boot })
}

/// Whether this session runs on a PRIVATE Claude Code config directory (A29).
/// A personal agent keeps the operator's own connectors, because a personal
/// agent is meant to reach what its owner reaches; everything else is the
/// cloud's rule, so it runs isolated. A kind the shell does not recognise
/// isolates too: the only unsafe answer is the one that keeps the connectors.
pub fn isolates_config(agent_kind: &str) -> bool {
    agent_kind != "personal"
}

/// The argv one turn runs with. The sidecar refuses to start without a model,
/// so the shell always names one rather than letting a default through.
pub fn turn_args(
    mcp_config_path: &str,
    model: &str,
    cwd: &str,
    permission_mode: &str,
    resume_session_id: Option<&str>,
    isolate_config: bool,
) -> Vec<String> {
    let mut args = vec![
        "--mcp-config".into(),
        mcp_config_path.into(),
        "--model".into(),
        model.into(),
        "--cwd".into(),
        cwd.into(),
        "--permission-mode".into(),
        permission_mode.into(),
    ];
    // Resuming is the SDK's own: the id came out of a `session` event and goes
    // back in unchanged, so the shell never reconstructs a transcript.
    if let Some(session_id) = resume_session_id {
        args.push("--resume".into());
        args.push(session_id.into());
    }
    if isolate_config {
        args.push("--isolate-config".into());
    }
    args
}

/// The refusals `read_local_file` answers with. Variants, like the start
/// refusals, because the window renders the copy.
pub const NO_SESSION: &str = "NoSession";
pub const OUTSIDE_SESSION_FOLDER: &str = "OutsideSessionFolder";
pub const TOO_LARGE: &str = "TooLarge";

/// The largest file the window may pull through the shell. An attachment is
/// read into the webview's memory whole and posted from there, so the cap is
/// the point at which that stops being reasonable rather than a policy.
pub const MAX_LOCAL_FILE_BYTES: u64 = 50 * 1024 * 1024;

/// The folder the RUNNING session was started in. It is the whole of the
/// authority `read_local_file` has: the window names a path, and a path that
/// does not canonicalize inside this folder is refused. Kept beside the child
/// rather than derived from it, because the window must not be able to name
/// the folder it is checked against.
#[derive(Default)]
pub struct SessionFolder(pub Mutex<Option<PathBuf>>);

/// One file on its way to the window.
pub struct LocalFile {
    pub bytes: Vec<u8>,
    pub mime: String,
}

/// The content type a name suggests. A guess, and named as one: the window
/// sends it on to the upload route, which is free to disagree.
pub fn guess_mime(path: &Path) -> String {
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "txt" | "log" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "json" => "application/json",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "zip" => "application/zip",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// Opens one file WITHOUT following a symlink at the final component, so the
/// handle the checks are made against is the file that will be read.
///
/// `O_NOFOLLOW` is the whole mechanism on unix: the kernel refuses the open if
/// the name is a link, so there is no window between deciding a path is
/// acceptable and reading something else through it. Windows has no equivalent
/// flag here, so the link is caught by asking the NAME first (a check, not a
/// guarantee: it is the weaker of the two and it is recorded as such).
fn open_no_follow(path: &Path) -> Result<fs::File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(not(unix))]
    {
        if fs::symlink_metadata(path)
            .map(|meta| meta.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err(OUTSIDE_SESSION_FOLDER.into());
        }
    }
    options.open(path).map_err(|error| {
        // A link at the final component comes back as ELOOP (and as EMLINK on
        // some BSDs). It is the same refusal as a link pointing out of the
        // folder: the window may read files, not links.
        #[cfg(unix)]
        if matches!(error.raw_os_error(), Some(libc::ELOOP) | Some(libc::EMLINK)) {
            return OUTSIDE_SESSION_FOLDER.to_string();
        }
        error.to_string()
    })
}

/// Reads one file for the window, and only inside the running session's own
/// folder.
///
/// The check is made against an OPEN HANDLE, not against a path. Canonicalizing
/// a path, deciding it is acceptable and then opening it is two lookups of the
/// same name: anything that can write in the folder (the agent itself, which is
/// running commands in there) can swap the name between them and be read out of
/// somewhere else. So the DIRECTORY is canonicalized (which is what makes a
/// `..` walk and a symlinked parent the same refusal), the file is opened with
/// no symlink followed at the final component, and the size and the "is this a
/// file at all" question are then asked of the handle rather than of the name.
///
/// A symlink is refused even when it points back inside the folder: a name the
/// window may read is a file, and a link is a second lookup whose answer can
/// change after it is checked.
pub fn read_local_file_at(folder: Option<&Path>, path: &str) -> Result<LocalFile, String> {
    use std::io::Read;

    let folder = folder.ok_or(NO_SESSION)?;
    let root = folder.canonicalize().map_err(|_| OUTSIDE_SESSION_FOLDER)?;
    let requested = Path::new(path);
    let name = requested.file_name().ok_or(OUTSIDE_SESSION_FOLDER)?;
    let parent = match requested.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    let parent = parent.canonicalize().map_err(|error| error.to_string())?;
    if !parent.starts_with(&root) {
        return Err(OUTSIDE_SESSION_FOLDER.into());
    }
    let target = parent.join(name);
    let mut file = open_no_follow(&target)?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err(OUTSIDE_SESSION_FOLDER.into());
    }
    if metadata.len() > MAX_LOCAL_FILE_BYTES {
        return Err(TOO_LARGE.into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let mime = guess_mime(&target);
    Ok(LocalFile { bytes, mime })
}

/// Base64, written out rather than pulled in: the one encoding the shell needs
/// is this, on one buffer, and a dependency for it would be a dependency in
/// the trust path of every file the window reads.
pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(triple >> 18) as usize & 63] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(triple >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[triple as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// One file from the session's own folder, as base64 and a content type guess.
/// The bytes are framed rather than streamed because the window posts them
/// whole to the upload route, and the 50 MB cap is what keeps that honest.
#[tauri::command]
pub fn read_local_file(
    folder: State<'_, SessionFolder>,
    path: String,
) -> Result<serde_json::Value, String> {
    let running = folder.0.lock().map_err(|error| error.to_string())?;
    let file = read_local_file_at(running.as_deref(), &path)?;
    Ok(serde_json::json!({
        "base64": base64(&file.bytes),
        "mime": file.mime,
        "sizeBytes": file.bytes.len(),
    }))
}

/// Everything one session needs that the shell has to know before it can
/// start. 6b replaces the environment reads with the picked agent and folder.
pub struct SessionConfig {
    pub base_url: String,
    pub agent_id: String,
    pub mcp_url: String,
    pub agent_definition: String,
    /// `personal` | `role` | `system`, as the agents route names it. It decides
    /// one thing only: whether the session's Claude Code config is isolated.
    pub agent_kind: String,
    pub model: String,
    pub cwd: String,
    pub permission_mode: String,
    /// A session id from an earlier `session` event, resumed by the SDK.
    pub resume_session_id: Option<String>,
    /// The window's own signed in access token, used for ONE thing: creating
    /// the agent's MCP connection when none is stored (`auth::connect_with_session`),
    /// so a signed in user is never sent to a browser to approve a code. It is
    /// never written to disk and never handed to the sidecar.
    pub session_token: Option<String>,
}

/// Everything the WINDOW names when it asks for a session. It is one struct
/// rather than seven arguments because every one of them is the window's and
/// the shell adds nothing to them: what the shell decides (the MCP URL, the
/// token, the config isolation) is decided from these, never taken from them.
pub struct StartRequest {
    pub agent_id: String,
    pub cwd: String,
    pub permission_mode: String,
    pub model: String,
    pub resume_session_id: Option<String>,
    /// The composed definition the window fetched from the definition route.
    /// The shell never composes or re-fetches it: two sources for one prompt
    /// is how they drift, and the checksum the sidecar reports is the checksum
    /// of THIS text.
    pub agent_definition: String,
    pub agent_kind: String,
    /// The window's access token (`SessionConfig::session_token`).
    pub session_token: Option<String>,
}

/// The MCP endpoint the sidecar is handed. `LIAISON_MCP_URL` exists so a
/// session can be pointed at a box's own gateway path, never at another
/// origin: the config file it lands in carries the live bearer token, so an
/// override that changes scheme, host or port would hand that token to whoever
/// answers there. Anything off the Liaison origin is dropped for the base
/// URL's own `/mcp`.
pub fn resolve_mcp_url(base_url: &str, override_url: Option<String>) -> String {
    let fallback = format!("{base_url}/mcp");
    let Some(candidate) = override_url else {
        return fallback;
    };
    match (Url::parse(base_url), Url::parse(&candidate)) {
        (Ok(base), Ok(over)) if base.origin().is_tuple() && base.origin() == over.origin() => {
            candidate
        }
        _ => {
            eprintln!(
                "liaison: ignoring LIAISON_MCP_URL {candidate}, it is not on the Liaison origin {base_url}"
            );
            fallback
        }
    }
}

fn config_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_config_dir().ok()
}

/// The shell's config directory, for the account module.
pub(crate) fn app_config_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    config_dir(app)
}

/// The deployment the window talks to. The environment still wins, which is
/// how a test box and the packaging smoke run point the shell somewhere
/// without a first-run dialog; otherwise it is the CURRENT entry of the saved
/// server list (`servers.rs`), migrated from the single address a build before
/// the list kept.
pub fn resolve_base_url<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    if let Ok(from_env) = std::env::var("LIAISON_BASE_URL") {
        if !from_env.trim().is_empty() {
            return Some(from_env);
        }
    }
    crate::servers::current_address_at(&config_dir(app)?)
}

#[tauri::command]
pub fn get_server_address<R: Runtime>(app: AppHandle<R>) -> Option<String> {
    resolve_base_url(&app)
}

/// The refusal a scheme that cannot carry a bearer token answers with.
pub const SERVER_ADDRESS_NOT_HTTP: &str = "the server address must be an http or https URL";

/// EVERYTHING THAT HAS TO BE TRUE BEFORE THIS INSTALL IS RE-BOUND: the scheme.
///
/// There is no native confirmation any more (Avery, on the first Windows
/// walk: the user has just typed the address into the connect card and pressed
/// Connect, and a second question in an OS dialog on top of that is noise).
/// What the confirmation was for (P6d-FX2, SK-2: `setServerAddress` is on the
/// window, so a script in apps/web could point the install elsewhere) is
/// covered by the in page confirmation the deep link path already asks and by
/// the device grant that follows any re-binding, which the user still approves
/// in a browser of their own. Answers the address as it will be stored.
pub fn validate_server_address(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    // Anything that is not an http(s) origin cannot carry a bearer token to a
    // Liaison box, and a `file:` or `javascript:` value has no business being
    // persisted at all.
    let parsed = Url::parse(trimmed).map_err(|error| error.to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(SERVER_ADDRESS_NOT_HTTP.into());
    }
    Ok(trimmed.trim_end_matches('/').to_string())
}

/// The MCP token this install minted for its server, beside the address.
pub const MCP_TOKEN_FILE: &str = "liaison-mcp-token.json";

/// The per-session `--mcp-config` the sidecar reads (it carries a live token).
pub const MCP_CONFIG_FILE: &str = "liaison-mcp-config.json";

/// Where one agent's token is filed: by SERVER and agent. An agent id means
/// nothing on another server, and a token minted by one server is refused by
/// every other, so a store that outlived a re-binding (an older build, a file
/// restored from a backup) must never hand the new server the old one's token.
pub fn token_key(base_url: &str, agent_id: &str) -> String {
    format!("{}#{agent_id}", base_url.trim_end_matches('/'))
}

impl SessionConfig {
    /// The session the window asked for, with nothing read from the machine.
    /// Separated from `resolve` so the whole composition is drivable without a
    /// running app: the definition is the one the window fetched, and there is
    /// no environment fallback left for a stale value to win from.
    pub fn compose(base_url: String, mcp_override: Option<String>, request: StartRequest) -> Self {
        SessionConfig {
            mcp_url: resolve_mcp_url(&base_url, mcp_override),
            agent_definition: request.agent_definition,
            agent_kind: request.agent_kind,
            model: request.model,
            cwd: request.cwd,
            permission_mode: request.permission_mode,
            resume_session_id: request.resume_session_id,
            base_url,
            agent_id: request.agent_id,
            session_token: request.session_token,
        }
    }

    /// The same composition against a running app: the only thing the app is
    /// asked for is which deployment this install talks to.
    pub fn resolve<R: Runtime>(app: &AppHandle<R>, request: StartRequest) -> Result<Self, String> {
        let base_url = resolve_base_url(app).ok_or("no Liaison server address configured")?;
        Ok(SessionConfig::compose(
            base_url,
            std::env::var("LIAISON_MCP_URL").ok(),
            request,
        ))
    }
}

/// Starts a local session for the agent and folder the window picked. A second
/// start stops the first: one window, one running sidecar, and a stale child
/// writing into the same event stream would be indistinguishable from the new
/// one in the webview.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_session<R: Runtime>(
    app: AppHandle<R>,
    agent_id: String,
    cwd: String,
    permission_mode: String,
    model: String,
    resume_session_id: Option<String>,
    agent_definition: String,
    agent_kind: String,
    access_token: Option<String>,
) -> Result<serde_json::Value, String> {
    // Before anything is stopped or spawned: the window sends the mode and the
    // folder, and a session that runs with neither checked is a session that
    // runs wherever and however whoever reached `invoke` asked.
    // WHERE THE FOLDER CAME FROM (P6d-FX2, SK-1). The shell's own picks in this
    // window, plus the recent list the shell persists: a `cwd` in neither was
    // named by the caller and nothing else, and the caller is the page.
    let folder_chosen = {
        let picked = app
            .try_state::<PickedFolders>()
            .and_then(|state| state.0.lock().ok().map(|set| set.clone()))
            .unwrap_or_default();
        let remembered = match (config_dir(&app), resolve_base_url(&app)) {
            (Some(dir), Some(server)) => all_recent_folders_at(&dir, &server),
            _ => Vec::new(),
        };
        folder_is_chosen(&picked, &remembered, &cwd)
    };
    validate_start_request(&permission_mode, &cwd, folder_chosen, |title, message| {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
        app.dialog()
            .message(message)
            .title(title)
            .buttons(MessageDialogButtons::OkCancel)
            .blocking_show()
    })?;
    if let Some(session) = app.try_state::<SidecarSession>() {
        if let Some(previous) = replace_running(&session.0, None) {
            stop_child(previous);
        }
    }
    // The previous session's prompts belong to a child that is gone.
    retire_prompts(&app);
    // The folder is remembered from the VALIDATED request, so `read_local_file`
    // is scoped to the folder this session actually runs in and not to one the
    // window names later.
    if let Some(folder) = app.try_state::<SessionFolder>() {
        replace_running(&folder.0, Some(PathBuf::from(&cwd)));
    }
    let config = SessionConfig::resolve(
        &app,
        StartRequest {
            agent_id,
            cwd,
            permission_mode,
            model,
            resume_session_id,
            agent_definition,
            agent_kind,
            session_token: access_token,
        },
    )?;
    let outcome = start(&app, config).await;
    // The folder was armed before the spawn, because the spawn consumes the
    // request. A start that did not spawn leaves NOTHING running, so the
    // folder has to go with it or `read_local_file` keeps answering out of a
    // session that never existed.
    if let Some(folder) = app.try_state::<SessionFolder>() {
        settle_folder(&folder.0, &outcome);
    }
    match outcome {
        SpawnOutcome::Spawned => Ok(serde_json::json!({ "ok": true })),
        SpawnOutcome::ReconnectRequired(reason) => Err(reason),
        SpawnOutcome::SpawnFailed(reason) => Err(reason),
    }
}

/// Keeps the armed folder only when a child is actually running. Generic over
/// the slot's content so the decision is drivable without a real path or a
/// running app. Answers whether the folder survived.
pub fn settle_folder<T>(slot: &Mutex<Option<T>>, outcome: &SpawnOutcome) -> bool {
    if matches!(outcome, SpawnOutcome::Spawned) {
        return true;
    }
    replace_running(slot, None);
    false
}

/// The reconnect payloads for the two ways a start dies once the token is
/// already live. They reach the window on the same event as a failed refresh,
/// because to the user they are the same thing: no session.
pub const CONFIG_UNWRITABLE: &str = "ConfigUnwritable";
pub const SIDECAR_SPAWN_FAILED: &str = "SidecarSpawnFailed";
/// The user switched to another server while this start was waiting (a device
/// grant is minutes long): nothing is spawned for the server that was left.
pub const SERVER_CHANGED: &str = "ServerChanged";

/// Whether a start may still spawn: the server it was started for is still
/// the current one. A session is a bearer for one server running on this
/// machine, and a window that has moved on to another server must never end
/// up with the previous one's session running underneath it.
pub fn still_current(current: Option<&str>, started_for: &str) -> bool {
    current.is_some_and(|current| crate::servers::same_server(current, started_for))
}

#[derive(Debug, PartialEq, Eq)]
pub enum SpawnOutcome {
    Spawned,
    /// The token could not be refreshed, so nothing was spawned at all.
    ReconnectRequired(String),
    /// The token was live but the start still failed: the MCP config could not
    /// be written, or the child would not spawn. Nothing is running.
    SpawnFailed(String),
}

/// The spawn decision, with the token refresh, the child spawn and the event
/// emit all injected. A sidecar started without a live token does not fail: it
/// runs with an empty Liaison catalog and looks like an agent that forgot its
/// tools. So a failed refresh must never fall through to a spawn, and the user
/// has to see why. A spawn that dies AFTER the refresh is the same silence from
/// the window's side, so it reports its own variant rather than `Spawned`.
pub fn spawn_guarded<T, S, E>(ensure_token: T, spawn_child: S, emit: E) -> SpawnOutcome
where
    T: FnOnce() -> Result<StoredToken, AuthError>,
    S: FnOnce(&StoredToken) -> Result<(), &'static str>,
    E: FnOnce(&str, &str),
{
    match ensure_token() {
        Ok(token) => match spawn_child(&token) {
            Ok(()) => SpawnOutcome::Spawned,
            Err(variant) => {
                emit(RECONNECT_EVENT, variant);
                SpawnOutcome::SpawnFailed(variant.to_string())
            }
        },
        Err(error) => {
            emit(RECONNECT_EVENT, error.variant());
            SpawnOutcome::ReconnectRequired(error.variant().to_string())
        }
    }
}

/// Starts the session's sidecar: refresh the token, write the per-session MCP
/// config the sidecar reads, then spawn. Nothing here comes from the window.
/// Starts the session's sidecar. ASYNC, and it has to be: the device grant
/// waits for a human to approve a code in a browser, which is minutes, and the
/// first version of that wait ran inside a synchronous command and froze the
/// whole window for its duration (driven walk, FX10). The window has to stay
/// alive to SHOW the code it is waiting on.
pub async fn start<R: Runtime>(app: &AppHandle<R>, config: SessionConfig) -> SpawnOutcome {
    let store = token_store_path(app);
    let app_for_spawn = app.clone();
    let app_for_emit = app.clone();
    let store_for_mint = store.clone();
    let minted = {
        let stored = store
            .as_ref()
            .and_then(|path| load_token(path, &token_key(&config.base_url, &config.agent_id)));
        let grant = crate::auth::DeviceGrantConfig {
            base_url: config.base_url.clone(),
            client_id: DESKTOP_DEVICE_CLIENT_ID.into(),
            agent_id: config.agent_id.clone(),
        };
        let refresh_base = config.base_url.clone();
        let connect_base = config.base_url.clone();
        let connect_agent = config.agent_id.clone();
        let session_token = config.session_token.clone();
        crate::auth::ensure_fresh_token_async(
            stored,
            crate::auth::now_ms(),
            |refresh_token: String| async move {
                crate::auth::refresh(&refresh_base, &refresh_token).await
            },
            || crate::auth::mint_agent_token(
                session_token,
                |access_token: String| async move {
                    crate::auth::connect_with_session(&connect_base, &connect_agent, &access_token)
                        .await
                },
                || {
                let grant = grant.clone();
                async move {
                    // A HUMAN HAS TO WALK TO A BROWSER. The first version polled
                    // ONCE, immediately after initiate, so the grant was refused
                    // before the code it emitted had finished being painted: the
                    // approval panel was unapprovable by construction, and the
                    // driven walk could only get a token by polling the API by
                    // hand. So the wait is the device flow's own: poll on the
                    // interval the server states, until the server's own expiry.
                    let started = crate::auth::initiate(&grant).await?;
                    // REGISTERED BEFORE IT IS SHOWN (P6d-FX7, SK-7). The window is
                    // about to draw a code somebody can approve, so from here on
                    // there is something for a Cancel to release, and the loop
                    // below asks every pass whether it is still wanted.
                    crate::auth::remember_pending_grant(crate::auth::PendingGrant {
                        config: grant.clone(),
                        device_code: started.device_code.clone(),
                    });
                    let _ = app_for_emit
                        .emit("liaison-device-approval", started.verification_uri.clone());
                    // THE BROWSER IS OPENED FOR THE USER. The step is drawn in the
                    // window too, with the code and a button that opens the page
                    // again, but the approval itself happens in the system browser
                    // (where the user is already signed in), so the shell takes them
                    // there rather than leaving a send parked on a dialog they may
                    // not know how to act on. Same validation as the button.
                    if let Err(error) =
                        open_device_approval_page(&app_for_emit, &started.verification_uri)
                    {
                        eprintln!("liaison: the approval page could not be opened ({error})");
                    }
                    let deadline_ms = crate::auth::now_ms()
                        .saturating_add(started.expires_in_secs.saturating_mul(1000));
                    let interval = std::time::Duration::from_secs(started.interval_secs);
                    loop {
                        // THE USER GAVE UP (P6d-FX7, SK-7). `cancel_device_approval`
                        // took the grant off the slot and told the server the code
                        // is dead; this window stops waiting for it rather than
                        // holding a session in `starting` for the rest of the
                        // grant's window.
                        if !crate::auth::still_waiting_for(&started.device_code) {
                            return Err(AuthError::NotApproved);
                        }
                        // `poll_once` answers None while nobody has approved, and
                        // errors only on a refusal or an unreachable server: both
                        // are final, and neither is worth another 15 minutes.
                        let minted = crate::auth::poll_once(&grant, &started.device_code).await?;
                        match crate::auth::poll_step(
                            minted.is_some(),
                            crate::auth::now_ms(),
                            deadline_ms,
                        ) {
                            crate::auth::PollStep::Minted => {
                                crate::auth::forget_pending_grant();
                                return Ok(minted.expect("a minted step carries its token"));
                            }
                            // ONLY here. The code stays on screen for the whole
                            // window; Reconnect is offered when it can no longer
                            // be approved, never while it still can.
                            crate::auth::PollStep::Expired => {
                                crate::auth::forget_pending_grant();
                                return Err(AuthError::NotApproved);
                            }
                            crate::auth::PollStep::WaitAgain => {
                                tokio::time::sleep(interval).await;
                            }
                        }
                    }
                }
            },
            ),
        )
        .await
    };
    let minted = minted.map(|fresh| {
        if let Some(path) = store_for_mint.as_ref() {
            let _ = save_token(path, &token_key(&config.base_url, &config.agent_id), &fresh);
        }
        fresh
    });
    // What the child says first, handed out of the spawn so the start can wait
    // for it: a child that dies before its `boot` line is a start that did not
    // happen, and the window has to be told so instead of `ok`.
    let mut boot_wait: Option<(u32, tokio::sync::oneshot::Receiver<BootOutcome>)> = None;
    let outcome = spawn_guarded(
        || minted,
        |token| {
            if !still_current(resolve_base_url(&app_for_spawn).as_deref(), &config.base_url) {
                return Err(SERVER_CHANGED);
            }
            let path = write_mcp_config(&app_for_spawn, &config, token).ok_or(CONFIG_UNWRITABLE)?;
            let args = turn_args(
                &path.to_string_lossy(),
                &config.model,
                &config.cwd,
                &config.permission_mode,
                config.resume_session_id.as_deref(),
                isolates_config(&config.agent_kind),
            );
            let refused_store = token_store_path(&app_for_spawn);
            let refused_key = token_key(&config.base_url, &config.agent_id);
            let refused_app = app_for_spawn.clone();
            let on_refused: Box<dyn Fn() + Send + Sync> = Box::new(move || {
                on_token_refused(refused_store.as_deref(), &refused_key, |event, payload| {
                    let _ = refused_app.emit(event, payload.to_string());
                });
            });
            let spawned = spawn_sidecar(
                &app_for_spawn,
                args,
                Some(token.token.clone()),
                Some(on_refused),
            )
            .map_err(|error| {
                eprintln!("liaison: the sidecar would not spawn ({error})");
                SIDECAR_SPAWN_FAILED
            })?;
            boot_wait = Some((spawned.pid, spawned.boot));
            if let Some(session) = app_for_spawn.try_state::<SidecarSession>() {
                // A session may have been started while this one was waiting
                // for its device grant: whoever is in the slot is stopped, not
                // dropped, or it keeps running with nobody able to reach it.
                replace_running_stopping(&session.0, Some(spawned.child), |previous| {
                    stop_child(previous);
                });
            }
            Ok(())
        },
        |event, payload| {
            let _ = app.emit(event, payload.to_string());
        },
    );
    let Some((pid, boot)) = boot_wait else {
        return outcome;
    };
    let learned = match tokio::time::timeout(BOOT_TIMEOUT, boot).await {
        Ok(Ok(first)) => Some(first),
        _ => None,
    };
    settle_boot(outcome, learned, || {
        retire_exited(app, pid);
    })
}

/// The start's answer once the child said something, or did not. A child that
/// exited before its `boot` line refuses the start with what it wrote to
/// stderr (`SidecarExited: <reason>`), and is taken out of the session slot so
/// nothing writes a turn into its closed pipe.
pub fn settle_boot<F: FnOnce()>(
    outcome: SpawnOutcome,
    learned: Option<BootOutcome>,
    retire: F,
) -> SpawnOutcome {
    if outcome != SpawnOutcome::Spawned {
        return outcome;
    }
    match boot_settled(learned) {
        Ok(()) => SpawnOutcome::Spawned,
        Err(refusal) => {
            retire();
            SpawnOutcome::SpawnFailed(refusal)
        }
    }
}

/// Writes a file only its owner can read. The minted bearer token and the MCP
/// config that carries it are secrets, and the default 0644 hands them to every
/// other account on the machine. The mode is set at creation AND again on the
/// open handle, because a create-time mode does nothing to a file that already
/// exists. Windows keeps the directory's inherited ACL.
///
/// AND IT IS REPLACED WHOLE. The bytes go to a sibling file that is flushed to
/// disk and then renamed over the target, so a reader never sees the file
/// truncated or half written and a quit, crash or power cut mid write leaves
/// the previous content rather than an empty file. Truncating in place let a
/// concurrent read of the refresh token file come back empty, and its
/// read-modify-write then wrote back a map without the token just rotated.
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let staging = path.with_file_name(format!(
        ".{name}.{}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let written =
        write_private_in_place(&staging, bytes).and_then(|()| fs::rename(&staging, path));
    match written {
        Ok(()) => {
            // The rename itself is made durable too: without the directory's
            // flush a power cut can bring the old entry back.
            #[cfg(unix)]
            if let Some(parent) = path.parent() {
                if let Ok(dir) = fs::File::open(parent) {
                    let _ = dir.sync_all();
                }
            }
            Ok(())
        }
        Err(_) => {
            // A rename can be refused where the target is held open (Windows):
            // the write in place is still better than no write at all.
            let _ = fs::remove_file(&staging);
            write_private_in_place(path, bytes)
        }
    }
}

fn write_private_in_place(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = file.metadata()?.permissions();
        permissions.set_mode(0o600);
        file.set_permissions(permissions)?;
    }
    file.write_all(bytes)?;
    file.sync_all()
}

/// The per-session `--mcp-config` file. Written under the app's own config
/// directory and never committed: it carries a live token.
fn write_mcp_config<R: Runtime>(
    app: &AppHandle<R>,
    config: &SessionConfig,
    token: &StoredToken,
) -> Option<PathBuf> {
    write_mcp_config_at(&app.path().app_config_dir().ok()?, config, token)
}

/// The same write, against a named directory, so the failure path (a config
/// directory that cannot be written) is drivable without a running app.
fn write_mcp_config_at(dir: &Path, config: &SessionConfig, token: &StoredToken) -> Option<PathBuf> {
    fs::create_dir_all(dir).ok()?;
    let path = dir.join(MCP_CONFIG_FILE);
    // The token AND what renews it (`sidecar/mcp-token.ts`). The token lives
    // 15 minutes and a session can run for hours: the sidecar's headers helper
    // renews it through the server's MCP OAuth route with this server's and
    // this agent's refresh token, the same one `auth::refresh` presents here at
    // spawn. The file is owner-only, like the token store it is copied from.
    let mut body = serde_json::json!({
        "liaisonMcpUrl": config.mcp_url,
        "agentScopedToken": token.token,
        "tokenExpiresAtMs": token.expires_at_ms,
        "tokenUrl": crate::auth::token_url(&config.base_url),
        "agentDefinition": config.agent_definition,
    });
    if let Some(refresh_token) = token.refresh_token.as_deref().filter(|t| !t.is_empty()) {
        body["refreshToken"] = serde_json::Value::String(refresh_token.to_string());
    }
    write_private(&path, &serde_json::to_vec(&body).ok()?).ok()?;
    Some(path)
}

/// The file this install keeps its folder hashing salt in.
pub const INSTALL_SALT_FILE: &str = "liaison-install-salt.json";

/// How many random bytes the salt is. 32 because the digest it salts is a
/// sha256: a shorter salt is the weakest half of the pair.
pub const INSTALL_SALT_BYTES: usize = 32;

/// A fresh salt, hex. The randomness is the OS's: a salt drawn from the clock
/// or the process id is a salt the server can guess, and a guessable salt is no
/// salt at all.
pub fn random_salt() -> Result<String, String> {
    let mut bytes = [0u8; INSTALL_SALT_BYTES];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// This install's folder hashing salt, created ONCE and kept 0600 beside the
/// token.
///
/// The audit trail carries a digest of the folder and never its path (A20), but
/// an unsalted sha256 of a path is a dictionary lookup: the server, or anyone
/// who reads the rows, recovers `/Users/alice/acme-acquisition` by hashing the
/// paths people have. A per install salt the server never sees makes the digest
/// meaningful only to this machine, which is all the trail needs it to be: it
/// has to tell two folders apart, not name them.
///
/// It is STABLE for the install, because the same digest keys the resume store:
/// a salt that changed would silently forget every session ever started here.
pub fn install_salt_at(dir: &Path) -> Result<String, String> {
    let path = dir.join(INSTALL_SALT_FILE);
    if let Some(existing) = read_install_salt_at(&path) {
        return Ok(existing);
    }
    let salt = random_salt()?;
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let body = serde_json::json!({ "salt": salt });
    write_private(
        &path,
        &serde_json::to_vec(&body).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(salt)
}

/// The stored salt, if there is one that is the right shape. A file that is
/// unreadable or malformed is treated as no salt: the caller writes a fresh
/// one rather than hashing with something half read.
fn read_install_salt_at(path: &Path) -> Option<String> {
    let body: serde_json::Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let salt = body.get("salt")?.as_str()?.to_string();
    let expected = INSTALL_SALT_BYTES * 2;
    if salt.len() == expected && salt.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(salt)
    } else {
        None
    }
}

/// THE WRAPPED SESSION'S REFRESH TOKEN, one per saved server.
///
/// The page is served from `tauri://localhost`, so every call it makes to the
/// user's Liaison is cross site and the `liaison_rt` cookie (SameSite=Strict)
/// is attached to none of them: the session died at the first access-token
/// expiry. The API answers one of the shells' own origins with the refresh
/// token in the body instead (apps/api/src/lib/response.ts), and this is where
/// the overlay keeps it: a 0600 file beside the MCP token and the server list,
/// rather than the webview's storage, which an update that moves the data
/// directory clears.
///
/// PER SERVER (`servers.rs`). The window NAMES the server it is about to
/// present the token to (or that just handed it one), and the shell answers
/// only when that is the current server: a page still pointed at the server it
/// is leaving can neither read the next one's token nor file its own under it.
/// The file and its cap live in `servers.rs` (`REFRESH_TOKEN_FILE`).

/// Stores the token, or REMOVES it when the window passes an empty string,
/// which is how the overlay signs out.
#[tauri::command]
pub fn store_refresh_token<R: Runtime>(
    app: AppHandle<R>,
    server: String,
    token: String,
) -> Result<(), String> {
    let dir = config_dir(&app).ok_or("no application config directory")?;
    crate::servers::store_refresh_token_for_at(&dir, &server, &token)?;
    Ok(())
}

#[tauri::command]
pub fn load_refresh_token<R: Runtime>(app: AppHandle<R>, server: String) -> Option<String> {
    crate::servers::refresh_token_for_at(&config_dir(&app)?, &server)
}

#[tauri::command]
pub fn get_install_salt<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let dir = config_dir(&app).ok_or("no application config directory")?;
    install_salt_at(&dir)
}

/// Where this install keeps its minted token between runs.
pub fn token_store_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(MCP_TOKEN_FILE))
}

/// The whole store: one token PER AGENT (`{ "agents": { id: token } }`).
///
/// It used to be ONE token for the install. The token is bound to the agent it
/// was granted for, so a session started for another agent inside the first
/// one's fifteen minutes ran with the first agent's catalog and identity. A
/// file in the old single-token shape reads as empty: its agent is unknown, so
/// it is worth nothing to anybody, and the next start asks again.
fn read_token_store(path: &Path) -> serde_json::Map<String, serde_json::Value> {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| {
            value
                .get("agents")
                .and_then(|agents| agents.as_object())
                .cloned()
        })
        .unwrap_or_default()
}

pub fn load_token(path: &Path, agent_id: &str) -> Option<StoredToken> {
    let agents = read_token_store(path);
    serde_json::from_value(agents.get(agent_id)?.clone()).ok()
}

/// Forgets one stored token, leaving every other server's and agent's alone.
pub fn forget_token(path: &Path, key: &str) -> io::Result<()> {
    let mut agents = read_token_store(path);
    if agents.remove(key).is_none() {
        return Ok(());
    }
    write_private(
        path,
        &serde_json::to_vec(&serde_json::json!({ "agents": agents }))?,
    )
}

/// The sidecar's line when the server REFUSED to renew the running session's
/// MCP token (`sidecar/index.ts` `MCP_TOKEN_REFUSED`): the connection behind it
/// was revoked.
pub const MCP_TOKEN_REFUSED: &str = "mcp_token_refused";

/// The reconnect reason a refused renewal is reported with. The window already
/// words it ("Your Liaison connection expired and could not be renewed.
/// Reconnect to sign in again.") and offers the Reconnect that runs a new
/// device approval.
pub const TOKEN_REFRESH_FAILED: &str = "TokenRefreshFailed";

pub fn reports_token_refused(line: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|parsed| {
            parsed
                .get("type")
                .and_then(|value| value.as_str())
                .map(|kind| kind == MCP_TOKEN_REFUSED)
        })
        .unwrap_or(false)
}

/// A RUNNING SESSION'S TOKEN CAN NO LONGER BE RENEWED. The stored token for
/// this server and agent is forgotten, because its refresh token is dead and
/// its access token is about to be: the next start must go straight to a new
/// device approval instead of spawning on a token the server already refuses.
/// Then the window is told, on the same event a refused start uses, so the
/// user sees "your connection needs to be renewed" rather than a model
/// reporting 401s as Liaison being down.
pub fn on_token_refused<E: FnOnce(&str, &str)>(store: Option<&Path>, key: &str, emit: E) {
    if let Some(path) = store {
        if let Err(error) = forget_token(path, key) {
            eprintln!("liaison: the refused MCP token could not be forgotten ({error})");
        }
    }
    emit(RECONNECT_EVENT, TOKEN_REFRESH_FAILED);
}

pub fn save_token(path: &Path, agent_id: &str, token: &StoredToken) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut agents = read_token_store(path);
    agents.insert(agent_id.to_string(), serde_json::to_value(token)?);
    write_private(
        path,
        &serde_json::to_vec(&serde_json::json!({ "agents": agents }))?,
    )
}

#[cfg(test)]
mod sidecar_tests {
    use super::*;

    const SERVER_A: &str = "https://liaison.acme.example";
    const SERVER_B: &str = "https://liaison.fabrikam.example";
    use std::cell::Cell;

    /// This file read as text, so the RELEASE arm of the debug seed can be
    /// asserted from a test binary that is itself a debug build. Same idiom as
    /// the handler arms in `main.rs`: only a source read sees both arms of a
    /// cfg pair at once.
    const SIDECAR_RS: &str = include_str!("sidecar.rs");

    /// A BLOCKING DIALOG IS NEVER OPENED FROM A SYNCHRONOUS COMMAND. Tauri
    /// runs a synchronous command on the main thread, and the dialog plugin's
    /// `blocking_*` calls park the calling thread until the main thread has
    /// shown the dialog and the user has answered: from the main thread that
    /// is a deadlock, the window stops responding and no dialog ever appears.
    /// It held on macOS by accident and froze the first Windows install at
    /// "Connect". An `async` command runs off the main thread, which is the
    /// whole fix, so every command whose body reaches a `blocking_` call has
    /// to be one.
    #[test]
    fn blocking_dialogs_are_never_called_from_a_synchronous_command() {
        let shell = &SIDECAR_RS[..SIDECAR_RS
            .find("#[cfg(test)]")
            .expect("this file has a test module")];
        let mut checked = 0;
        let mut at = 0;
        while let Some(found) = shell[at..].find("#[tauri::command]") {
            let start = at + found;
            let rest = &shell[start..];
            // The command's body runs to the next command attribute or, for the
            // last one, to the end of the shell's own source.
            let end = rest[1..]
                .find("#[tauri::command]")
                .map(|next| next + 1)
                .unwrap_or(rest.len());
            let command = &rest[..end];
            let signature = command
                .lines()
                .find(|line| line.starts_with("pub "))
                .expect("a command declares a pub fn");
            if command.contains(".blocking_") {
                assert!(
                    signature.starts_with("pub async fn"),
                    "{signature} opens a blocking dialog from a synchronous command"
                );
                checked += 1;
            }
            at = start + end;
        }
        assert!(
            checked >= 3,
            "expected at least the three commands that open a dialog, found {checked}"
        );
    }

    /// A DEBUG ONLY HOOK IS ONLY DEBUG ONLY IF THE RELEASE ARM IGNORES IT
    /// (P6d-FX3). The seed exists so a driven walk can reach a live local
    /// session on a machine whose native Open panel takes no synthetic input.
    /// It must not be a way to root a shipped app's session from the
    /// environment, so the release arm reads nothing at all.
    #[test]
    fn the_release_build_ignores_the_debug_recent_folder_seed() {
        let release_start = SIDECAR_RS
            .find("#[cfg(not(debug_assertions))]\npub fn debug_seed_folder()")
            .expect("sidecar.rs has a release arm for debug_seed_folder");
        let release_arm = &SIDECAR_RS[release_start..];
        let release_end = release_arm
            .find("\n}\n")
            .expect("the release arm is closed")
            + 3;
        let release_arm = &release_arm[..release_end];
        assert!(
            release_arm.contains("None"),
            "the release arm answers something other than None: {release_arm}"
        );
        assert!(
            !release_arm.contains("env::var"),
            "the release arm reads the environment: {release_arm}"
        );
        assert!(
            !release_arm.contains(DEBUG_SEED_RECENT_FOLDER_ENV),
            "the release arm names the seed variable: {release_arm}"
        );
        // And the variable is read in exactly one place, under the debug arm,
        // so a second reader cannot appear without this failing. The shell's
        // own source is everything above this test module, which quotes the
        // same strings it is looking for.
        let shell = &SIDECAR_RS[..SIDECAR_RS
            .find("#[cfg(test)]")
            .expect("this file has a test module")];
        let reads = shell
            .matches("env::var(DEBUG_SEED_RECENT_FOLDER_ENV)")
            .count();
        assert_eq!(
            reads, 1,
            "the seed variable is read {reads} times, expected 1"
        );
        let read_at = shell
            .find("env::var(DEBUG_SEED_RECENT_FOLDER_ENV)")
            .expect("the debug arm reads the variable");
        let debug_arm_at = SIDECAR_RS
            .find("#[cfg(debug_assertions)]\npub fn debug_seed_folder()")
            .expect("sidecar.rs has a debug arm for debug_seed_folder");
        assert!(
            debug_arm_at < read_at && read_at < release_start,
            "the read is outside the debug arm"
        );
    }

    /// What the variable has to say before it names a folder. A walk hands a
    /// directory; anything else is ignored rather than guessed at, so a typo
    /// leaves the recent list exactly as empty as it was.
    #[test]
    fn the_seed_names_a_directory_or_nothing() {
        let dir = std::env::temp_dir().join(format!("liaison-seed-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("README.md");
        fs::write(&file, b"hello").unwrap();

        assert_eq!(
            seed_folder_from(None),
            None,
            "an unset variable names nothing"
        );
        assert_eq!(
            seed_folder_from(Some(String::new())),
            None,
            "an empty value names nothing"
        );
        assert_eq!(
            seed_folder_from(Some("   ".into())),
            None,
            "blank names nothing"
        );
        assert_eq!(
            seed_folder_from(Some(dir.join("gone").to_string_lossy().to_string())),
            None,
            "a folder that is not there names nothing"
        );
        assert_eq!(
            seed_folder_from(Some(file.to_string_lossy().to_string())),
            None,
            "a FILE is not a folder a session can be rooted in"
        );
        assert_eq!(
            seed_folder_from(Some(format!("  {}  ", dir.display()))),
            Some(dir.clone()),
            "a directory that exists is the seed, trimmed"
        );

        fs::remove_dir_all(&dir).ok();
    }

    /// The seed goes in through the picker's own recording path, so what the
    /// window is offered is a list `start_session` already accepts. Driven at
    /// the file level, which is the half of that path a test can run without a
    /// Tauri app handle.
    #[test]
    fn a_seeded_folder_is_a_folder_start_session_accepts() {
        let dir = std::env::temp_dir().join(format!("liaison-seed-list-{}", std::process::id()));
        fs::remove_dir_all(&dir).ok();
        fs::create_dir_all(&dir).unwrap();
        let folder = dir.join("walk-folder2");
        fs::create_dir_all(&folder).unwrap();
        let folder = folder.to_string_lossy().to_string();

        assert!(
            !folder_is_chosen(&HashSet::new(), &all_recent_folders_at(&dir, SERVER_A), &folder),
            "nothing is startable before the seed"
        );
        record_recent_folder_at(&dir, &token_key(SERVER_A, "agent-1"), &folder).unwrap();

        assert_eq!(
            read_recent_folders_at(&dir, &token_key(SERVER_A, "agent-1")),
            vec![folder.clone()]
        );
        assert!(
            folder_is_chosen(&HashSet::new(), &all_recent_folders_at(&dir, SERVER_A), &folder),
            "the seeded folder is one start_session accepts"
        );

        fs::remove_dir_all(&dir).ok();
    }

    /// The exit hook has one job: whatever is in the managed slot is stopped,
    /// once. A second exit must find nothing rather than stop a child twice.
    #[test]
    fn the_exit_hook_stops_whatever_is_in_the_slot_and_empties_it() {
        let slot: Mutex<Option<String>> = Mutex::new(Some("child".into()));
        let stopped: Cell<Option<String>> = Cell::new(None);
        assert!(stop_running(&slot, |child| stopped.set(Some(child))));
        assert_eq!(stopped.into_inner(), Some("child".to_string()));
        assert_eq!(*slot.lock().unwrap(), None);
        assert!(
            !stop_running(&slot, |_| panic!("nothing is left to stop")),
            "a second exit stops nothing"
        );
    }

    /// `stop_session` runs on the IPC thread, so the grace period must not be
    /// spent there: a caller that sleeps it out blocks every other command the
    /// window sends for as long as it lasts.
    #[test]
    fn the_shutdown_grace_is_waited_out_off_the_calling_thread() {
        let started = std::time::Instant::now();
        let handle = kill_after_grace((), |()| {});
        let returned = started.elapsed();
        assert!(
            returned < SHUTDOWN_GRACE / 2,
            "the caller waited {returned:?} of the {SHUTDOWN_GRACE:?} grace"
        );
        handle.join().unwrap();
        assert!(
            started.elapsed() >= SHUTDOWN_GRACE,
            "the kill still waits its turn"
        );
    }

    #[test]
    fn an_unknown_permission_mode_is_refused_before_anything_is_asked_or_spawned() {
        for bad in ["", "acceptEdits", "bypassPermissions", "yolo", "MANUAL"] {
            assert_eq!(
                validate_start_request(bad, ".", true, |_, _| panic!("nothing is asked for {bad}")),
                Err(UNKNOWN_PERMISSION_MODE.to_string()),
                "mode {bad} must be refused"
            );
        }
    }

    /// Control: a mode that asks before every call starts with no question.
    #[test]
    fn a_mode_that_asks_before_each_call_starts_without_a_question() {
        for mode in ["manual", "plan"] {
            assert_eq!(
                validate_start_request(mode, ".", true, |_, _| panic!("{mode} asks nothing")),
                Ok(())
            );
        }
    }

    /// D11: Auto and Edit act without asking each time, so the shell asks
    /// first, names the folder, and a no starts nothing.
    #[test]
    fn auto_and_edit_start_only_after_the_shells_own_confirmation() {
        for mode in ["auto", "edit"] {
            let asked: Cell<Option<String>> = Cell::new(None);
            assert_eq!(
                validate_start_request(mode, ".", true, |title, message| {
                    asked.set(Some(format!("{title}|{message}")));
                    false
                }),
                Err(MODE_DECLINED.to_string()),
                "{mode}"
            );
            let question = asked.take().expect("the shell asked");
            assert!(question.contains("without asking first"), "{question}");
            assert!(question.contains('.'), "the folder is named");
            assert_eq!(
                validate_start_request(mode, ".", true, |_, _| true),
                Ok(()),
                "{mode} starts once confirmed"
            );
        }
    }

    #[test]
    fn a_cwd_that_is_not_a_directory_is_refused() {
        let file = std::env::temp_dir().join("liaison-cwd-not-a-dir");
        fs::write(&file, b"x").unwrap();
        assert_eq!(
            validate_start_request("manual", &file.to_string_lossy(), true, |_, _| true),
            Err(CWD_NOT_A_DIRECTORY.to_string())
        );
        assert_eq!(
            validate_start_request("manual", "/no/such/folder/here", true, |_, _| true),
            Err(CWD_NOT_A_DIRECTORY.to_string())
        );
        let _ = fs::remove_file(&file);
    }

    /// P6d-FX1 (SK-2, SK-6): a page script must not be able to switch the
    /// running session to Bypass, and a mode change must actually reach the
    /// session it claims to change.
    #[test]
    fn a_mode_change_on_a_running_session_asks_before_it_bypasses() {
        let asked: Cell<Option<String>> = Cell::new(None);
        assert_eq!(
            validate_permission_mode_change("bypass", Some("/work/repo"), |title, message| {
                asked.set(Some(format!("{title}|{message}")));
                false
            }),
            Err(BYPASS_DECLINED.to_string()),
            "a refused confirmation is a refused mode change"
        );
        let question = asked.take().expect("the confirmation was asked");
        assert!(
            question.starts_with(BYPASS_TITLE),
            "the shell's own dialog asks it"
        );
        assert!(
            question.contains("/work/repo"),
            "and it names the folder being handed over"
        );
        assert_eq!(
            validate_permission_mode_change("bypass", Some("/work/repo"), |_, _| true),
            Ok(())
        );
    }

    /// D11: a page script must not turn a running Manual session into one that
    /// runs commands unasked. Switching a running session to Auto or Edit is
    /// the shell's question; to Manual or Plan it is not.
    #[test]
    fn switching_a_running_session_to_auto_or_edit_asks_the_shell() {
        assert_eq!(PERMISSION_MODES[0], "auto");
        for mode in ["auto", "edit"] {
            let asked = Cell::new(false);
            assert_eq!(
                validate_permission_mode_change(mode, Some("/work/repo"), |_, message| {
                    asked.set(message.contains("/work/repo"));
                    false
                }),
                Err(MODE_DECLINED.to_string())
            );
            assert!(asked.get(), "{mode}: the shell asked, naming the folder");
        }
        for mode in ["manual", "plan"] {
            assert_eq!(
                validate_permission_mode_change(mode, Some("/work/repo"), |_, _| panic!(
                    "{mode} asks nothing"
                )),
                Ok(())
            );
        }
    }

    #[test]
    fn a_mode_change_refuses_a_mode_nobody_ships() {
        for bad in ["", "bypassPermissions", "yolo", "MANUAL"] {
            assert_eq!(
                validate_permission_mode_change(bad, Some("/work/repo"), |_, _| panic!(
                    "nothing is asked for {bad}"
                )),
                Err(UNKNOWN_PERMISSION_MODE.to_string())
            );
        }
    }

    #[test]
    fn choosing_the_next_sessions_mode_asks_nothing_because_no_folder_is_held_yet() {
        for mode in ["auto", "manual", "edit", "plan", "bypass"] {
            assert_eq!(
                validate_permission_mode_change(mode, None, |_, _| panic!("{mode} asks nothing")),
                Ok(())
            );
        }
    }

    #[test]
    fn the_mode_change_line_is_the_one_the_sidecar_reads() {
        assert_eq!(
            permission_mode_line("plan"),
            r#"{"mode":"plan","type":"set_permission_mode"}"#
        );
    }

    /// Bypass is the mode with no permission prompts at all, so the one place
    /// it can still be refused is before it starts.
    #[test]
    fn bypass_starts_only_when_the_confirmation_is_accepted() {
        let asked: Cell<Option<String>> = Cell::new(None);
        assert_eq!(
            validate_start_request("bypass", ".", true, |title, message| {
                asked.set(Some(format!("{title}|{message}")));
                false
            }),
            Err(BYPASS_DECLINED.to_string())
        );
        let seen = asked.into_inner().unwrap();
        assert!(seen.starts_with(BYPASS_TITLE), "the dialog is titled");
        assert!(seen.contains('.'), "the message names the folder");
        assert_eq!(
            validate_start_request("bypass", ".", true, |_, _| true),
            Ok(())
        );
    }

    #[test]
    fn a_connect_deep_link_carrying_an_http_server_is_accepted() {
        assert_eq!(
            validate_deep_link("liaison://connect?server=https://box.example"),
            Some("https://box.example".to_string())
        );
        assert_eq!(
            validate_deep_link("liaison://connect?server=http%3A%2F%2Flocalhost%3A3000"),
            Some("http://localhost:3000".to_string())
        );
    }

    /// The value is the box this install will send its bearer token to, so
    /// every one of these has to die before the event is emitted at all.
    #[test]
    fn a_deep_link_that_is_not_a_plain_connect_link_is_dropped() {
        for bad in [
            "liaison://connect?server=javascript:alert(1)",
            "liaison://connect?server=file:///etc/passwd",
            "liaison://connect?server=",
            "liaison://connect?server=not-a-url",
            "liaison://connect?server=https://",
            "liaison://connect",
            "liaison://connect?server=https://a&server=https://b",
            "liaison://connect?other=https://box.example",
            "liaison://other?server=https://box.example",
            "https://connect?server=https://box.example",
            "not a url at all",
        ] {
            assert_eq!(validate_deep_link(bad), None, "{bad} must be dropped");
        }
    }

    const OAUTH_STATE: &str = "Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg";

    #[test]
    fn an_oauth_complete_link_is_routed_to_the_window_and_raises_it() {
        let code = "0123456789abcdef".repeat(4);
        let with_code = format!("liaison://oauth-complete?code={code}&state={OAUTH_STATE}");
        let with_error =
            format!("liaison://oauth-complete?error=Account+deactivated&state={OAUTH_STATE}");
        for link in [&with_code, &with_error] {
            let route = route_deep_link(link);
            assert_eq!(route, Some(DeepLinkRoute::OAuthComplete), "{link}");
            assert!(
                route.unwrap().raises_window(),
                "{link} does not bring the window forward"
            );
        }
    }

    #[test]
    fn a_connect_link_is_routed_as_before_and_raises_nothing() {
        let route = route_deep_link("liaison://connect?server=https://box.example");
        assert_eq!(route, Some(DeepLinkRoute::Connect));
        assert!(!route.unwrap().raises_window());
        assert_eq!(
            route_deep_link("liaison://connect?server=javascript:alert(1)"),
            None
        );
    }

    #[test]
    fn an_oauth_complete_link_of_any_other_shape_is_dropped() {
        let code = "0123456789abcdef".repeat(4);
        for bad in [
            format!("liaison://oauth-complete?code={code}"),
            format!("liaison://oauth-complete?state={OAUTH_STATE}"),
            format!("liaison://oauth-complete?code={code}&error=x&state={OAUTH_STATE}"),
            format!("liaison://oauth-complete?code=NOTHEX&state={OAUTH_STATE}"),
            format!("liaison://oauth-complete?code={code}&state=short"),
            format!("liaison://oauth-complete?code={code}&state={OAUTH_STATE}&extra=1"),
            format!("liaison://oauth-complete?code={code}&code={code}&state={OAUTH_STATE}"),
            format!("liaison://oauth-complete/path?code={code}&state={OAUTH_STATE}"),
            format!("liaison://oauth-complete?code={code}&state={OAUTH_STATE}#frag"),
            format!("liaison://other?code={code}&state={OAUTH_STATE}"),
            format!("https://oauth-complete?code={code}&state={OAUTH_STATE}"),
        ] {
            assert_eq!(route_deep_link(&bad), None, "{bad} must be dropped");
        }
    }

    fn authorize_url(origin: &str) -> String {
        format!(
            "{origin}/api/auth/oauth/google/authorize?state={OAUTH_STATE}&client=desktop&code_challenge={OAUTH_STATE}&code_challenge_method=S256"
        )
    }

    #[test]
    fn the_bound_servers_desktop_authorize_route_may_be_opened() {
        let bound = Some("https://liaison.example");
        assert!(
            validate_oauth_authorize_url(&authorize_url("https://liaison.example"), bound).is_ok()
        );
        assert!(validate_oauth_authorize_url(
            &authorize_url("http://localhost:3000"),
            Some("http://localhost:3000")
        )
        .is_ok());
    }

    #[test]
    fn nothing_else_is_opened_in_the_browser() {
        let bound = Some("https://liaison.example");
        let good = authorize_url("https://liaison.example");
        for bad in [
            authorize_url("https://evil.example"),
            authorize_url("http://liaison.example"),
            good.replace("client=desktop", "client=web"),
            good.replace("S256", "plain"),
            good.replace("/authorize", "/callback"),
            good.replace("/api/auth/oauth/google", "/api/auth/oauth/google/x"),
            format!("{good}#x"),
            good.replace("https://", "https://user:pw@"),
            "file:///etc/passwd".to_string(),
            "javascript:alert(1)".to_string(),
        ] {
            assert!(
                validate_oauth_authorize_url(&bad, bound).is_err(),
                "{bad} must be refused"
            );
        }
        assert_eq!(
            validate_oauth_authorize_url(&good, None).unwrap_err(),
            OAUTH_URL_NOT_BOUND
        );
    }

    /// The webview sees every request id (they ride a broadcast event), so the
    /// only thing that makes an answer legitimate is that the request is still
    /// OPEN. A second answer for the same id is a replay: the tool already ran
    /// or was already denied, and running it again is running a tool the user
    /// approved once and never again.
    #[test]
    fn a_permission_answer_is_accepted_once_and_the_replay_is_refused() {
        let pending: Mutex<HashSet<String>> = Mutex::new(HashSet::new());
        apply_line_effect(
            &pending,
            r#"{"type":"permission_request","requestId":"perm-1","toolName":"Read","input":{}}"#,
        );
        assert!(
            take_permission(&pending, "perm-1"),
            "the open request answers"
        );
        assert!(
            !take_permission(&pending, "perm-1"),
            "the same id must not answer twice"
        );
    }

    /// An id the sidecar never asked about is a forged one: nothing in the
    /// session is waiting for it, so there is nothing it could legitimately do.
    #[test]
    fn a_permission_answer_for_an_unknown_request_is_refused() {
        let pending: Mutex<HashSet<String>> = Mutex::new(HashSet::new());
        assert!(!take_permission(&pending, "perm-1"));
        apply_line_effect(
            &pending,
            r#"{"type":"permission_request","requestId":"perm-1","toolName":"Read"}"#,
        );
        assert!(
            !take_permission(&pending, "perm-2"),
            "another id is not this one"
        );
    }

    /// The prompt dies with its turn: the SDK is no longer parked on it, so an
    /// answer arriving afterwards is answering nothing and must be refused.
    #[test]
    fn a_finished_turn_retires_every_outstanding_permission_request() {
        let pending: Mutex<HashSet<String>> = Mutex::new(HashSet::new());
        apply_line_effect(
            &pending,
            r#"{"type":"permission_request","requestId":"perm-1","toolName":"Read"}"#,
        );
        apply_line_effect(
            &pending,
            r#"{"type":"permission_request","requestId":"perm-2","toolName":"Read"}"#,
        );
        apply_line_effect(&pending, r#"{"type":"turn_done"}"#);
        assert!(!take_permission(&pending, "perm-1"));
        assert!(!take_permission(&pending, "perm-2"));
        apply_line_effect(
            &pending,
            r#"{"type":"permission_request","requestId":"perm-3","toolName":"Read"}"#,
        );
        apply_line_effect(&pending, r#"{"type":"done"}"#);
        assert!(!take_permission(&pending, "perm-3"));
    }

    /// Only the lines that say something about a prompt count, and a line that
    /// is not protocol JSON at all changes nothing.
    #[test]
    fn only_a_permission_request_line_opens_a_request() {
        assert_eq!(
            line_effect(r#"{"type":"permission_request","requestId":"perm-1","toolName":"Read"}"#),
            LineEffect::Outstanding("perm-1".to_string())
        );
        assert_eq!(
            line_effect(r#"{"type":"permission_request","requestId":"perm-2","toolName":"Bash"}"#),
            LineEffect::ShellConfirmed("perm-2".to_string()),
            "a shell command is the shell's to confirm"
        );
        assert_eq!(
            line_effect(r#"{"type":"turn_done"}"#),
            LineEffect::RetireAll
        );
        for quiet in [
            r#"{"type":"message","event":"text"}"#,
            r#"{"type":"permission_request"}"#,
            r#"{"type":"permission_request","requestId":"","toolName":"Read"}"#,
            "not json at all",
            "",
        ] {
            assert_eq!(
                line_effect(quiet),
                LineEffect::Nothing,
                "{quiet} opens nothing"
            );
        }
    }

    #[test]
    fn the_answer_written_is_the_decision_not_the_request() {
        let (allow, behavior) = permission_response("perm-1", &Decision::Allow);
        assert_eq!(behavior, "allow");
        assert_eq!(
            allow,
            r#"{"behavior":"allow","requestId":"perm-1","type":"permission_response"}"#
        );
        let (deny, behavior) =
            permission_response("perm-2", &Decision::Deny(Some("denied here".into())));
        assert_eq!(behavior, "deny");
        assert!(
            deny.contains(r#""message":"denied here""#) && deny.contains(r#""behavior":"deny""#)
        );
    }

    /// The relay spends the session's agent scoped bearer, so the window may
    /// drive exactly the tools the shell named and no others.
    #[test]
    fn only_an_allowlisted_mcp_tool_may_be_called_through_the_shell() {
        assert!(mcp_tool_allowed("liaison_approval_status"));
        for refused in [
            "kernel__threads_reply",
            "shopify__order_cancel",
            "liaison_tool_search",
            "liaison_approval_status ",
            "",
        ] {
            assert!(!mcp_tool_allowed(refused), "{refused} must be refused");
        }
    }

    /// Every entry carries the reason it is there: an allowlist nobody has to
    /// justify an addition to grows back into an open channel.
    #[test]
    fn every_allowlisted_tool_names_why_it_is_allowed() {
        for (tool, reason) in MCP_TOOL_ALLOWLIST {
            assert!(!tool.is_empty());
            assert!(reason.len() > 20, "{tool} needs a reason, not a label");
        }
    }

    /// The session folder is armed BEFORE the spawn, and it is the whole of
    /// the authority `read_local_file` has. A start that failed leaves nothing
    /// running, so a folder left behind is a window still reading files out of
    /// a session that never started.
    #[test]
    fn a_start_that_did_not_spawn_leaves_no_session_folder_behind() {
        for outcome in [
            SpawnOutcome::SpawnFailed(SIDECAR_SPAWN_FAILED.to_string()),
            SpawnOutcome::SpawnFailed(CONFIG_UNWRITABLE.to_string()),
            SpawnOutcome::ReconnectRequired("TokenRefreshFailed".to_string()),
            SpawnOutcome::ReconnectRequired("NotApproved".to_string()),
        ] {
            let slot: Mutex<Option<String>> = Mutex::new(Some("/work".into()));
            assert!(
                !settle_folder(&slot, &outcome),
                "{outcome:?} keeps no folder"
            );
            assert_eq!(
                *slot.lock().unwrap(),
                None,
                "{outcome:?} must empty the slot"
            );
        }
    }

    #[test]
    fn a_spawned_session_keeps_the_folder_it_was_started_in() {
        let slot: Mutex<Option<String>> = Mutex::new(Some("/work".into()));
        assert!(settle_folder(&slot, &SpawnOutcome::Spawned));
        assert_eq!(*slot.lock().unwrap(), Some("/work".to_string()));
    }

    /// The salt is what keeps the audited folder digest from being a
    /// dictionary lookup, so it has to be 32 random bytes and it has to be the
    /// SAME 32 bytes for the life of the install: the resume store is keyed by
    /// the digest, and a salt that rolled would forget every session.
    #[test]
    fn the_install_salt_is_created_once_and_then_read_back() {
        let dir = std::env::temp_dir().join("liaison-install-salt-once");
        let _ = fs::remove_dir_all(&dir);
        let first = install_salt_at(&dir).unwrap();
        assert_eq!(first.len(), INSTALL_SALT_BYTES * 2);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(
            install_salt_at(&dir).unwrap(),
            first,
            "a second read is the same salt"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_installs_do_not_share_a_salt() {
        let a = std::env::temp_dir().join("liaison-install-salt-a");
        let b = std::env::temp_dir().join("liaison-install-salt-b");
        let _ = fs::remove_dir_all(&a);
        let _ = fs::remove_dir_all(&b);
        assert_ne!(install_salt_at(&a).unwrap(), install_salt_at(&b).unwrap());
        let _ = fs::remove_dir_all(&a);
        let _ = fs::remove_dir_all(&b);
    }

    /// A malformed file must not be hashed with: a truncated or edited salt
    /// would silently change every digest this install produces.
    #[test]
    fn a_salt_file_that_is_not_a_salt_is_replaced_rather_than_used() {
        let dir = std::env::temp_dir().join("liaison-install-salt-broken");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(INSTALL_SALT_FILE), br#"{"salt":"nope"}"#).unwrap();
        let salt = install_salt_at(&dir).unwrap();
        assert_eq!(salt.len(), INSTALL_SALT_BYTES * 2);
        assert_eq!(install_salt_at(&dir).unwrap(), salt);
        let _ = fs::remove_dir_all(&dir);
    }

    /// It sits beside the token and the MCP config, and it is the one secret
    /// that makes the audited digests unreadable to the server.
    #[cfg(unix)]
    #[test]
    fn the_install_salt_is_readable_by_its_owner_alone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join("liaison-install-salt-mode");
        let _ = fs::remove_dir_all(&dir);
        install_salt_at(&dir).unwrap();
        let mode = fs::metadata(dir.join(INSTALL_SALT_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn send_line_appends_newline() {
        let mut sink: Vec<u8> = Vec::new();
        send_line(&mut sink, "list my threads").unwrap();
        assert_eq!(sink, b"list my threads\n");
    }

    #[test]
    fn send_line_writes_nothing_beyond_the_single_line() {
        let mut sink: Vec<u8> = Vec::new();
        send_line(&mut sink, "a").unwrap();
        send_line(&mut sink, "b").unwrap();
        assert_eq!(String::from_utf8(sink).unwrap(), "a\nb\n");
    }

    /// A turn is a control line on protocol 2, not a bare prompt: a raw prompt
    /// written to the session's stdin is an unreadable control line and the
    /// turn never runs.
    #[test]
    fn a_turn_is_composed_as_a_control_line_with_the_prompt_escaped() {
        let line = turn_line_with_credential("say \"hi\"\nplease", None);
        assert!(!line.contains('\n'), "a control line is one line");
        let parsed: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed["type"], "turn");
        assert_eq!(parsed["prompt"], "say \"hi\"\nplease");
    }

    /// S59 (D36): the turn's credential rides the turn line only when it has
    /// the server's shape; anything else is dropped, never passed on.
    #[test]
    fn turn_line_carries_a_valid_credential_and_drops_a_malformed_one() {
        let credential = format!("{}_-9", "Q".repeat(40));
        let line = turn_line_with_credential("hi", Some(&credential));
        let parsed: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed["type"], "turn");
        assert_eq!(parsed["prompt"], "hi");
        assert_eq!(parsed["turnCredential"], credential.as_str());

        for bad in [
            "short".to_string(),
            format!("{}=", "Q".repeat(42)),
            format!("{}\n", "Q".repeat(42)),
            "Q".repeat(44),
            format!("{}\"}}", "Q".repeat(41)),
        ] {
            let line = turn_line_with_credential("hi", Some(&bad));
            let parsed: serde_json::Value = serde_json::from_str(&line).unwrap();
            assert!(
                parsed.get("turnCredential").is_none(),
                "{bad:?} must be dropped"
            );
            assert_eq!(parsed["prompt"], "hi");
        }
        let none: serde_json::Value =
            serde_json::from_str(&turn_line_with_credential("hi", None)).unwrap();
        assert!(none.get("turnCredential").is_none());
    }

    fn token() -> StoredToken {
        StoredToken {
            token: "fresh-token".into(),
            expires_at_ms: 10_000_000,
            refresh_token: Some("conn.secret".into()),
        }
    }

    #[test]
    fn spawn_sidecar_never_spawns_a_child_when_token_refresh_fails() {
        let spawned = Cell::new(0);
        let emitted: Cell<Option<String>> = Cell::new(None);
        let outcome = spawn_guarded(
            || Err(AuthError::NotApproved),
            |_| {
                spawned.set(spawned.get() + 1);
                Ok(())
            },
            |event, payload| {
                assert_eq!(event, RECONNECT_EVENT);
                emitted.set(Some(payload.to_string()));
            },
        );
        assert_eq!(spawned.get(), 0);
        assert_eq!(
            outcome,
            SpawnOutcome::ReconnectRequired("NotApproved".into())
        );
        assert_eq!(emitted.into_inner().unwrap(), "NotApproved");
    }

    #[test]
    fn spawn_sidecar_passes_the_fresh_token_to_the_child_when_refresh_succeeds() {
        let seen: Cell<Option<String>> = Cell::new(None);
        let outcome = spawn_guarded(
            || Ok(token()),
            |fresh| {
                seen.set(Some(fresh.token.clone()));
                Ok(())
            },
            |_, _| panic!("no reconnect event on a successful refresh"),
        );
        assert_eq!(outcome, SpawnOutcome::Spawned);
        assert_eq!(seen.into_inner().unwrap(), "fresh-token");
    }

    #[test]
    fn a_stored_token_survives_a_round_trip_through_the_store() {
        let path = std::env::temp_dir().join("liaison-token-roundtrip.json");
        let _ = fs::remove_file(&path);
        save_token(&path, "agent-a", &token()).unwrap();
        assert_eq!(load_token(&path, "agent-a").unwrap(), token());
        let _ = fs::remove_file(&path);
    }

    /// A TOKEN IS THE AGENT'S IT WAS GRANTED FOR. The store held one token for
    /// the whole install, so a second agent's session reused the first agent's
    /// live token and ran with its catalog.
    #[test]
    fn a_token_granted_for_one_agent_is_never_handed_to_another() {
        let path = std::env::temp_dir().join("liaison-token-per-agent.json");
        let _ = fs::remove_file(&path);
        save_token(&path, "agent-a", &token()).unwrap();
        assert_eq!(load_token(&path, "agent-b"), None);
        let other = StoredToken {
            token: "b-token".into(),
            ..token()
        };
        save_token(&path, "agent-b", &other).unwrap();
        assert_eq!(load_token(&path, "agent-a").unwrap(), token());
        assert_eq!(load_token(&path, "agent-b").unwrap(), other);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_token_is_filed_by_server_as_well_as_by_agent() {
        assert_ne!(
            token_key("http://127.0.0.1:18080", "agent-a"),
            token_key("https://liaison.example.com", "agent-a")
        );
        assert_eq!(
            token_key("https://liaison.example.com/", "agent-a"),
            token_key("https://liaison.example.com", "agent-a")
        );
    }

    /// The single-token file an older build wrote names no agent, so it is
    /// nobody's: read as empty rather than handed to whoever asks first.
    #[test]
    fn a_token_file_in_the_old_single_token_shape_is_nobodys() {
        let path = std::env::temp_dir().join("liaison-token-old-shape.json");
        fs::write(&path, br#"{"token":"t","expires_at_ms":99999999999999}"#).unwrap();
        assert_eq!(load_token(&path, "agent-a"), None);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn the_bound_servers_approval_page_may_be_opened_and_nothing_else() {
        let bound = Some("https://liaison.example.com");
        assert!(validate_device_approval_url(
            "https://liaison.example.com/auth/device?code=ABCD2345",
            bound
        )
        .is_ok());
        for refused in [
            "https://evil.example.com/auth/device?code=ABCD2345",
            "http://liaison.example.com/auth/device?code=ABCD2345",
            "https://liaison.example.com/auth/device?code=",
            "https://liaison.example.com/auth/device?code=A&next=https://evil",
            "https://liaison.example.com/auth/devices?code=A",
            "https://liaison.example.com/auth/device?code=A#x",
            "https://user@liaison.example.com/auth/device?code=A",
            "file:///etc/passwd",
        ] {
            assert_eq!(
                validate_device_approval_url(refused, bound),
                Err(APPROVAL_URL_REFUSED),
                "{refused}"
            );
        }
        assert_eq!(
            validate_device_approval_url("https://liaison.example.com/auth/device?code=A", None),
            Err(OAUTH_URL_NOT_BOUND)
        );
    }

    #[test]
    fn external_url_opens_web_and_mail_links() {
        for allowed in [
            "https://example.com",
            "https://example.com/a/b?c=d#frag",
            "http://example.org:8080/path",
            "mailto:someone@example.com",
            "mailto:someone@example.com?subject=Hi",
            "tel:+33612345678",
            "tel:+1 (555) 010-2030",
        ] {
            assert!(validate_external_url(allowed).is_ok(), "{allowed}");
        }
    }

    #[test]
    fn external_url_refuses_other_schemes_and_credentials() {
        for refused in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<script>x</script>",
            "liaison://connect?server=https://evil.example.com",
            "ftp://example.com/file",
            "smb://share/x",
            "https://user:pass@example.com/",
            "https://user@example.com/",
            "http://:secret@example.com/",
            "mailto:",
            "tel:",
            "tel:call-me",
            "tel:+33612345678?x=1",
            "not a url",
            "",
            "/relative/path",
        ] {
            assert_eq!(
                validate_external_url(refused),
                Err(EXTERNAL_URL_REFUSED),
                "{refused}"
            );
        }
    }

    /// The live half: an agent grant that is never approved (the shape a
    /// revoked or dropped connection takes on the next refresh) must reach the
    /// user as a reconnect state, with no sidecar started behind it. Runs when
    /// a box is named.
    #[test]
    #[ignore = "needs LIAISON_BASE_URL and LIAISON_AGENT_ID, run with --ignored"]
    fn an_unapproved_grant_surfaces_as_a_reconnect_state_against_a_live_box() {
        let (Ok(base_url), Ok(agent_id)) = (
            std::env::var("LIAISON_BASE_URL"),
            std::env::var("LIAISON_AGENT_ID"),
        ) else {
            eprintln!("no live box configured, skipping the reconnect drive");
            return;
        };
        let config = crate::auth::DeviceGrantConfig {
            base_url,
            client_id: "mcp-cli".into(),
            agent_id,
        };
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let spawned = Cell::new(0);
        let emitted: Cell<Option<String>> = Cell::new(None);
        let outcome = spawn_guarded(
            || {
                runtime.block_on(async {
                    let started = crate::auth::initiate(&config).await?;
                    match crate::auth::poll_once(&config, &started.device_code).await? {
                        Some(token) => Ok(token),
                        None => Err(AuthError::NotApproved),
                    }
                })
            },
            |_| {
                spawned.set(spawned.get() + 1);
                Ok(())
            },
            |event, payload| emitted.set(Some(format!("{event}:{payload}"))),
        );
        assert_eq!(spawned.get(), 0);
        assert_eq!(
            outcome,
            SpawnOutcome::ReconnectRequired("NotApproved".into())
        );
        assert_eq!(
            emitted.into_inner().unwrap(),
            "liaison-reconnect-required:NotApproved"
        );
    }

    #[test]
    fn an_mcp_override_on_the_liaison_origin_is_honoured() {
        assert_eq!(
            resolve_mcp_url(
                "http://box:3000",
                Some("http://box:3000/gateway/mcp".into())
            ),
            "http://box:3000/gateway/mcp"
        );
    }

    #[test]
    fn an_mcp_override_is_dropped_when_it_leaves_the_liaison_origin() {
        // The config this URL lands in carries the live bearer token, so a
        // host, port or scheme change is a token handed to a stranger.
        for away in [
            "http://evil.example/mcp",
            "http://box:3001/mcp",
            "https://box:3000/mcp",
            "not-a-url",
        ] {
            assert_eq!(
                resolve_mcp_url("http://box:3000", Some(away.into())),
                "http://box:3000/mcp",
                "override {away} must not be honoured"
            );
        }
    }

    #[test]
    fn no_mcp_override_means_the_base_urls_own_mcp_path() {
        assert_eq!(
            resolve_mcp_url("http://box:3000", None),
            "http://box:3000/mcp"
        );
    }

    /// The half of a start that runs after the token is already live: if the
    /// MCP config cannot be written, the child must not start AND the outcome
    /// must not read as `Spawned`, or main.rs and the window both believe a
    /// session is running that never existed.
    #[cfg(unix)]
    #[test]
    fn an_unwritable_config_dir_gives_a_non_spawned_outcome_and_never_spawns() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join("liaison-mcp-config-readonly");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        let spawned = Cell::new(0);
        let emitted: Cell<Option<String>> = Cell::new(None);
        let outcome = spawn_guarded(
            || Ok(token()),
            |fresh| {
                let _path =
                    write_mcp_config_at(&dir, &session_config(), fresh).ok_or(CONFIG_UNWRITABLE)?;
                spawned.set(spawned.get() + 1);
                Ok(())
            },
            |event, payload| emitted.set(Some(format!("{event}:{payload}"))),
        );
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o755));
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(spawned.get(), 0);
        assert_eq!(outcome, SpawnOutcome::SpawnFailed(CONFIG_UNWRITABLE.into()));
        assert_eq!(
            emitted.into_inner().unwrap(),
            format!("{RECONNECT_EVENT}:{CONFIG_UNWRITABLE}")
        );
    }

    #[test]
    fn a_stderr_line_reaches_the_webview_without_the_bearer_token() {
        let secret = "eyJhbGciOiJIUzI1NiJ9.payload.signature";
        let line = format!("MCP connect failed: Authorization: Bearer {secret} (401)\n");
        let forwarded = stderr_line_for_webview(&line, Some(secret)).unwrap();
        assert!(
            !forwarded.contains(secret),
            "the token must not reach the window"
        );
        assert_eq!(
            forwarded,
            "MCP connect failed: Authorization: Bearer [redacted] (401)"
        );
    }

    #[test]
    fn a_stderr_line_with_no_secret_in_it_is_forwarded_as_is() {
        assert_eq!(
            stderr_line_for_webview("sidecar: catalog ready\n", Some("a-token")),
            Some("sidecar: catalog ready".to_string())
        );
        assert_eq!(stderr_line_for_webview("   \n", Some("a-token")), None);
    }

    fn session_config() -> SessionConfig {
        SessionConfig {
            base_url: "http://box:3000".into(),
            agent_id: "agent-1".into(),
            mcp_url: "http://box:3000/mcp".into(),
            agent_definition: String::new(),
            agent_kind: "role".into(),
            model: "claude-haiku-4-5".into(),
            cwd: ".".into(),
            permission_mode: "manual".into(),
            resume_session_id: None,
            session_token: None,
        }
    }

    /// Both files carry the bearer token verbatim, so neither may sit at the
    /// default 0644 where every other account on the machine can read it. An
    /// already existing file has to be narrowed too: a create-time mode does
    /// nothing to a file that is already there.
    #[cfg(unix)]
    #[test]
    fn a_saved_token_is_readable_by_its_owner_alone() {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join("liaison-token-mode.json");
        let _ = fs::remove_file(&path);
        fs::write(&path, b"{}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        save_token(&path, "agent-a", &token()).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = fs::remove_file(&path);
    }

    /// The definition the WINDOW fetched is the definition the session runs
    /// with. The shell composes nothing and reads nothing from the machine, so
    /// an environment value left over from an earlier build must not be able
    /// to decide what the agent is: the checksum the sidecar reports on every
    /// turn is the checksum of THIS text and of nothing else.
    #[test]
    fn the_written_config_carries_the_definition_the_window_passed() {
        std::env::set_var("LIAISON_AGENT_DEFINITION", "a stale environment definition");
        let config = SessionConfig::compose(
            "http://box:3000".into(),
            None,
            StartRequest {
                agent_id: "agent-1".into(),
                cwd: ".".into(),
                permission_mode: "manual".into(),
                model: "claude-haiku-4-5".into(),
                resume_session_id: None,
                agent_definition: "the definition the window fetched".into(),
                agent_kind: "role".into(),
                session_token: Some("the.window.session".into()),
            },
        );
        let dir = std::env::temp_dir().join("liaison-mcp-config-definition");
        let _ = fs::remove_dir_all(&dir);
        let path = write_mcp_config_at(&dir, &config, &token()).unwrap();
        let body: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(body["agentDefinition"], "the definition the window fetched");
        // The window's own session token creates the connection and goes
        // nowhere else: the config file is read by the sidecar and the CLI.
        assert!(!fs::read_to_string(&path).unwrap().contains("the.window.session"));
        let _ = fs::remove_dir_all(&dir);
        std::env::remove_var("LIAISON_AGENT_DEFINITION");
    }

    #[cfg(unix)]
    #[test]
    fn the_written_mcp_config_is_readable_by_its_owner_alone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join("liaison-mcp-config-mode");
        let _ = fs::remove_dir_all(&dir);
        let path = write_mcp_config_at(&dir, &session_config(), &token()).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// A SESSION OUTLIVES ITS TOKEN. The token lives 15 minutes and used to be
    /// the only thing in the config, so a turn past that met a 401 on every
    /// Liaison call (2026-09-23: spawned 19:13, first turn 19:45). The config
    /// now carries what the sidecar renews it with: this server's token route
    /// and this agent's refresh token, and when the token dies.
    #[test]
    fn the_written_config_carries_what_renews_the_token() {
        let dir = std::env::temp_dir().join("liaison-mcp-config-renewal");
        let _ = fs::remove_dir_all(&dir);
        let path = write_mcp_config_at(&dir, &session_config(), &token()).unwrap();
        let body: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(body["agentScopedToken"], "fresh-token");
        assert_eq!(body["tokenExpiresAtMs"], 10_000_000);
        assert_eq!(body["refreshToken"], "conn.secret");
        assert_eq!(body["tokenUrl"], "http://box:3000/mcp/oauth/token");
        // And a token with nothing to renew it writes no empty refresh token.
        let bare = StoredToken {
            refresh_token: None,
            ..token()
        };
        let path = write_mcp_config_at(&dir, &session_config(), &bare).unwrap();
        let body: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(body.get("refreshToken").is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_token_route_is_the_one_the_spawn_refresh_uses() {
        assert_eq!(
            crate::auth::token_url("https://liaison.acme.example/"),
            "https://liaison.acme.example/mcp/oauth/token"
        );
    }

    #[test]
    fn only_the_refused_line_reports_a_refused_renewal() {
        assert!(reports_token_refused(r#"{"type":"mcp_token_refused"}"#));
        assert!(!reports_token_refused(r#"{"type":"turn_done"}"#));
        assert!(!reports_token_refused(r#"{"type":"message","event":"text"}"#));
        assert!(!reports_token_refused("not json"));
    }

    /// A REFUSED RENEWAL SURFACES THE APPROVAL FLOW. The stored token of THIS
    /// server and agent is forgotten (so the Reconnect goes straight to a new
    /// device approval instead of spawning on a revoked token), every other
    /// one is kept, and the window hears `TokenRefreshFailed` on the reconnect
    /// event, not a model reporting 401s.
    #[test]
    fn a_refused_renewal_forgets_that_token_and_asks_for_a_reconnect() {
        let dir = std::env::temp_dir().join("liaison-token-refused");
        let _ = fs::remove_dir_all(&dir);
        let store = dir.join(MCP_TOKEN_FILE);
        let refused = token_key(SERVER_A, "agent-1");
        let other_agent = token_key(SERVER_A, "agent-2");
        let other_server = token_key(SERVER_B, "agent-1");
        for key in [&refused, &other_agent, &other_server] {
            save_token(&store, key, &token()).unwrap();
        }
        let mut emitted: Vec<(String, String)> = Vec::new();
        on_token_refused(Some(&store), &refused, |event, payload| {
            emitted.push((event.to_string(), payload.to_string()));
        });
        assert_eq!(
            emitted,
            vec![(RECONNECT_EVENT.to_string(), TOKEN_REFRESH_FAILED.to_string())]
        );
        assert!(load_token(&store, &refused).is_none());
        assert!(load_token(&store, &other_agent).is_some());
        assert!(load_token(&store, &other_server).is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn turn_args_always_name_a_model() {
        let args = turn_args(
            "/tmp/mcp.json",
            "claude-haiku-4-5",
            "/tmp/work",
            "manual",
            None,
            false,
        );
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--model" && pair[1] == "claude-haiku-4-5"));
        assert!(args.windows(2).any(|pair| pair[0] == "--mcp-config"));
        assert!(!args.iter().any(|arg| arg == "--resume"));
    }

    /// Resuming is the SDK's own, and the only way the shell reaches it is the
    /// flag: a session id carried anywhere else is a session that starts fresh
    /// and silently loses the conversation it claimed to continue.
    #[test]
    fn turn_args_carry_the_resumed_session_id_when_one_is_given() {
        let args = turn_args(
            "/tmp/mcp.json",
            "claude-haiku-4-5",
            "/tmp/work",
            "manual",
            Some("session-abc"),
            false,
        );
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--resume" && pair[1] == "session-abc"));
    }

    /// A29: everything except a personal agent runs on a private Claude Code
    /// config, so a role agent's local session sees the Liaison catalog and not
    /// the operator's own claude.ai connectors. A personal agent keeps them on
    /// purpose, and that is the ONE case the flag is absent for.
    #[test]
    fn the_config_is_isolated_for_every_kind_except_a_personal_agent() {
        for kind in ["role", "system", "", "something-new"] {
            assert!(isolates_config(kind), "kind {kind} must run isolated");
            let args = turn_args(
                "/tmp/mcp.json",
                "m",
                "/tmp/work",
                "manual",
                None,
                isolates_config(kind),
            );
            assert!(
                args.iter().any(|arg| arg == "--isolate-config"),
                "kind {kind} must carry the flag"
            );
        }
        assert!(!isolates_config("personal"));
        let personal = turn_args("/tmp/mcp.json", "m", "/tmp/work", "manual", None, false);
        assert!(!personal.iter().any(|arg| arg == "--isolate-config"));
    }

    /// One window, one running sidecar. A start that leaves the previous child
    /// alive puts two sessions on the same event stream, and the webview cannot
    /// tell whose line is whose.
    #[test]
    fn a_second_start_hands_the_first_child_back_to_be_stopped() {
        let slot: Mutex<Option<String>> = Mutex::new(None);
        assert_eq!(replace_running(&slot, Some("first".to_string())), None);
        assert_eq!(
            replace_running(&slot, Some("second".to_string())),
            Some("first".to_string())
        );
        assert_eq!(
            replace_running(&slot, None),
            Some("second".to_string()),
            "stopping must empty the slot"
        );
    }

    /// The swap a spawn actually does. Dropping the previous child leaves a
    /// Claude Code process running on the user's machine that `stop_session`
    /// can no longer reach, in whatever permission mode it was started in.
    #[test]
    fn replacing_a_running_child_stops_it_rather_than_dropping_it() {
        let slot: Mutex<Option<String>> = Mutex::new(None);
        let stopped: std::cell::RefCell<Vec<String>> = std::cell::RefCell::new(Vec::new());

        assert!(!replace_running_stopping(
            &slot,
            Some("first".to_string()),
            |child| { stopped.borrow_mut().push(child) }
        ));
        assert!(stopped.borrow().is_empty(), "nothing was there to stop");

        assert!(replace_running_stopping(
            &slot,
            Some("second".to_string()),
            |child| { stopped.borrow_mut().push(child) }
        ));
        assert_eq!(stopped.borrow().as_slice(), &["first".to_string()]);
        assert_eq!(
            slot.lock().unwrap().clone(),
            Some("second".to_string()),
            "the new child is the one in the slot"
        );
    }

    /// A local session may read the folder it was started in, and the window
    /// gets the bytes plus a content type guess.
    #[test]
    fn a_file_inside_the_session_folder_is_read() {
        let root = std::env::temp_dir().join("liaison-read-inside");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("notes/plan.md"), b"the plan").unwrap();
        let file =
            read_local_file_at(Some(&root), &root.join("notes/plan.md").to_string_lossy()).unwrap();
        assert_eq!(file.bytes, b"the plan");
        assert_eq!(file.mime, "text/markdown");
        assert_eq!(base64(&file.bytes), "dGhlIHBsYW4=");
        let _ = fs::remove_dir_all(&root);
    }

    /// The session folder is the WHOLE of the authority: a path outside it, a
    /// `..` walk out of it and a directory whose name merely starts with it
    /// are one refusal.
    #[test]
    fn a_file_outside_the_session_folder_is_refused() {
        let base = std::env::temp_dir().join("liaison-read-outside");
        let _ = fs::remove_dir_all(&base);
        let root = base.join("session");
        fs::create_dir_all(&root).unwrap();
        fs::write(base.join("secret.txt"), b"not yours").unwrap();
        let sibling = base.join("session-notes");
        fs::create_dir_all(&sibling).unwrap();
        fs::write(sibling.join("secret.txt"), b"not yours either").unwrap();
        for away in [
            base.join("secret.txt"),
            root.join("../secret.txt"),
            sibling.join("secret.txt"),
        ] {
            assert_eq!(
                read_local_file_at(Some(&root), &away.to_string_lossy())
                    .err()
                    .unwrap(),
                OUTSIDE_SESSION_FOLDER,
                "{away:?} must be refused"
            );
        }
        let _ = fs::remove_dir_all(&base);
    }

    /// A symlink is the interesting case: the NAME is inside the folder and
    /// the file is not, so a check on the string rather than on the resolved
    /// path hands out whatever the link points at.
    #[cfg(unix)]
    #[test]
    fn a_symlink_that_escapes_the_session_folder_is_refused() {
        let base = std::env::temp_dir().join("liaison-read-symlink");
        let _ = fs::remove_dir_all(&base);
        let root = base.join("session");
        fs::create_dir_all(&root).unwrap();
        fs::write(base.join("secret.txt"), b"not yours").unwrap();
        std::os::unix::fs::symlink(base.join("secret.txt"), root.join("innocent.txt")).unwrap();
        assert_eq!(
            read_local_file_at(Some(&root), &root.join("innocent.txt").to_string_lossy())
                .err()
                .unwrap(),
            OUTSIDE_SESSION_FOLDER
        );
        let _ = fs::remove_dir_all(&base);
    }

    /// A link is refused whichever way it points. The path check resolves the
    /// DIRECTORY, so a link at the final component is the one name that could
    /// still be swapped between the check and the read: it is refused outright
    /// rather than resolved and trusted.
    #[cfg(unix)]
    #[test]
    fn a_symlink_inside_the_session_folder_is_refused_even_when_it_points_inside() {
        let root = std::env::temp_dir().join("liaison-read-symlink-inside");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("real.txt"), b"mine").unwrap();
        std::os::unix::fs::symlink(root.join("real.txt"), root.join("link.txt")).unwrap();
        // The file it points at is readable, so the refusal is about the LINK.
        assert!(read_local_file_at(Some(&root), &root.join("real.txt").to_string_lossy()).is_ok());
        assert_eq!(
            read_local_file_at(Some(&root), &root.join("link.txt").to_string_lossy())
                .err()
                .unwrap(),
            OUTSIDE_SESSION_FOLDER
        );
        let _ = fs::remove_dir_all(&root);
    }

    /// With no session there is no folder, so there is nothing that may be
    /// read: the answer is not "no such file", it is that nothing is running.
    #[test]
    fn nothing_is_readable_when_no_session_is_running() {
        assert_eq!(
            read_local_file_at(None, "/etc/hosts").err().unwrap(),
            NO_SESSION
        );
    }

    /// The bytes cross into the webview whole, so the cap is checked from the
    /// file's METADATA, before anything is read into memory.
    #[test]
    fn a_file_over_the_cap_is_refused_without_being_read() {
        let root = std::env::temp_dir().join("liaison-read-too-large");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("huge.bin");
        let file = fs::File::create(&path).unwrap();
        file.set_len(MAX_LOCAL_FILE_BYTES + 1).unwrap();
        drop(file);
        assert_eq!(
            read_local_file_at(Some(&root), &path.to_string_lossy())
                .err()
                .unwrap(),
            TOO_LARGE
        );
        // One byte under it is still a file the window may have.
        let small = root.join("ok.bin");
        let file = fs::File::create(&small).unwrap();
        file.set_len(MAX_LOCAL_FILE_BYTES).unwrap();
        drop(file);
        assert!(read_local_file_at(Some(&root), &small.to_string_lossy()).is_ok());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn base64_encodes_every_padding_case() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(&[0xff, 0xfe, 0xfd]), "//79");
    }

    #[test]
    fn platform_info_names_one_of_the_three_shipped_operating_systems() {
        let info = platform_info_value();
        assert!(["macos", "windows", "linux"].contains(&info.os));
        assert!(!info.arch.is_empty());
    }

    /// A scratch directory of this test's own, removed by the caller.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("liaison-fx2-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// P6d-FX2 (SK-1): the page named the folder, so the page named the root
    /// `read_local_file` is bounded by. A folder the SHELL never chose starts
    /// nothing, whatever mode is asked for.
    #[test]
    fn a_folder_the_shell_never_chose_starts_no_session() {
        let root = scratch("unchosen");
        for mode in ["auto", "manual", "edit", "plan", "bypass"] {
            assert_eq!(
                validate_start_request(mode, &root.to_string_lossy(), false, |_, _| panic!(
                    "{mode} is refused before any question is asked"
                )),
                Err(FOLDER_NOT_CHOSEN.to_string()),
                "mode {mode} must be refused on a folder nobody picked"
            );
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_folder_the_picker_returned_is_the_one_a_session_may_start_in() {
        let root = scratch("picked");
        let picked: Mutex<HashSet<PathBuf>> = Mutex::default();
        assert!(
            !folder_is_chosen(&picked.lock().unwrap(), &[], &root.to_string_lossy()),
            "nothing is chosen before the picker ran"
        );
        remember_picked(&picked, &root.to_string_lossy());
        assert!(folder_is_chosen(
            &picked.lock().unwrap(),
            &[],
            &root.to_string_lossy()
        ));
        // The same folder under a different spelling is the same folder, and a
        // sibling of it is not.
        let dotted = root.join(".").to_string_lossy().into_owned();
        assert!(folder_is_chosen(&picked.lock().unwrap(), &[], &dotted));
        assert!(!folder_is_chosen(&picked.lock().unwrap(), &[], "/"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_remembered_folder_is_startable_and_a_neighbour_of_it_is_not() {
        let dir = scratch("recents");
        let work = dir.join("work");
        let other = dir.join("other");
        fs::create_dir_all(&work).unwrap();
        fs::create_dir_all(&other).unwrap();
        record_recent_folder_at(&dir, &token_key(SERVER_A, "agent-1"), &work.to_string_lossy())
            .unwrap();
        let remembered = all_recent_folders_at(&dir, SERVER_A);
        let empty: HashSet<PathBuf> = HashSet::new();
        assert!(folder_is_chosen(
            &empty,
            &remembered,
            &work.to_string_lossy()
        ));
        assert!(!folder_is_chosen(
            &empty,
            &remembered,
            &other.to_string_lossy()
        ));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_recent_list_is_newest_first_deduplicated_and_capped() {
        assert_eq!(recent_after_pick(&[], "/a", 5), vec!["/a".to_string()]);
        assert_eq!(
            recent_after_pick(&["/a".into()], "/b", 5),
            vec!["/b".to_string(), "/a".to_string()]
        );
        assert_eq!(
            recent_after_pick(&["/a".into(), "/b".into()], "/a", 5),
            vec!["/a".to_string(), "/b".to_string()]
        );
        let many: Vec<String> = (1..=5).map(|n| format!("/{n}")).collect();
        let next = recent_after_pick(&many, "/6", RECENT_FOLDERS_LIMIT);
        assert_eq!(next.len(), RECENT_FOLDERS_LIMIT);
        assert_eq!(next[0], "/6");
        assert!(!next.contains(&"/5".to_string()), "the oldest falls off");
        assert_eq!(
            recent_after_pick(&["/a".into()], "  ", 5),
            vec!["/a".to_string()]
        );
    }

    #[test]
    fn the_recent_list_is_scoped_by_agent_and_checked_across_every_agent() {
        let dir = scratch("recents-per-agent");
        record_recent_folder_at(&dir, &token_key(SERVER_A, "agent-1"), "/one").unwrap();
        record_recent_folder_at(&dir, &token_key(SERVER_A, "agent-2"), "/two").unwrap();
        assert_eq!(
            read_recent_folders_at(&dir, &token_key(SERVER_A, "agent-1")),
            vec!["/one".to_string()]
        );
        assert_eq!(
            read_recent_folders_at(&dir, &token_key(SERVER_A, "agent-2")),
            vec!["/two".to_string()]
        );
        assert_eq!(
            read_recent_folders_at(&dir, &token_key(SERVER_A, "agent-3")),
            Vec::<String>::new()
        );
        let all = all_recent_folders_at(&dir, SERVER_A);
        assert!(all.contains(&"/one".to_string()) && all.contains(&"/two".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }

    /// ONE SERVER'S FOLDERS ARE NOT ANOTHER'S. The same agent id on a second
    /// server is a different agent, and a folder chosen while working for one
    /// organisation is not a folder a session for the next may start in.
    #[test]
    fn the_recent_list_of_one_server_is_neither_offered_nor_startable_on_another() {
        let dir = scratch("recents-per-server");
        let work = dir.join("work");
        fs::create_dir_all(&work).unwrap();
        let work = work.to_string_lossy().to_string();
        record_recent_folder_at(&dir, &token_key(SERVER_A, "agent-1"), &work).unwrap();
        assert_eq!(
            read_recent_folders_at(&dir, &token_key(SERVER_B, "agent-1")),
            Vec::<String>::new(),
            "server B was offered server A's folder"
        );
        assert!(
            !folder_is_chosen(&HashSet::new(), &all_recent_folders_at(&dir, SERVER_B), &work),
            "a session for server B may start in a folder chosen for server A"
        );
        assert!(folder_is_chosen(
            &HashSet::new(),
            &all_recent_folders_at(&dir, SERVER_A),
            &work
        ));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupted_recent_list_reads_as_empty_rather_than_throwing() {
        let dir = scratch("recents-corrupt");
        fs::write(dir.join(RECENT_FOLDERS_FILE), b"{not json").unwrap();
        assert_eq!(
            read_recent_folders_at(&dir, &token_key(SERVER_A, "agent-1")),
            Vec::<String>::new()
        );
        assert_eq!(all_recent_folders_at(&dir, SERVER_A), Vec::<String>::new());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_accepted_address_is_stored_without_its_trailing_separator() {
        assert_eq!(
            validate_server_address("https://box.example/"),
            Ok("https://box.example".to_string())
        );
    }

    /// A device grant is minutes long, and the user may switch servers while it
    /// waits. The grant's session belongs to the server it was started for, so
    /// once that server is no longer current nothing is spawned for it.
    #[test]
    fn a_start_whose_server_is_no_longer_current_spawns_nothing() {
        assert!(still_current(Some(SERVER_A), SERVER_A));
        assert!(still_current(Some("https://liaison.acme.example/"), SERVER_A));
        assert!(!still_current(Some(SERVER_B), SERVER_A));
        assert!(!still_current(None, SERVER_A));
        let shell = &SIDECAR_RS[..SIDECAR_RS
            .find("#[cfg(test)]")
            .expect("this file has a test module")];
        let spawn = shell
            .find("return Err(SERVER_CHANGED);")
            .expect("the spawn closure checks the current server");
        let config_write = shell
            .find("write_mcp_config(&app_for_spawn")
            .expect("the spawn writes the MCP config");
        assert!(
            spawn < config_write,
            "the MCP config is written before the current server is checked"
        );
    }

    #[test]
    fn a_server_address_that_cannot_carry_a_token_is_refused() {
        for bad in ["javascript:alert(1)", "file:///etc", "ftp://box.example"] {
            assert_eq!(
                validate_server_address(bad),
                Err(SERVER_ADDRESS_NOT_HTTP.to_string())
            );
        }
        assert!(validate_server_address("not a url").is_err());
    }

    // A SIDECAR THAT DIES IS NEVER SILENT (2026-09-23). The stale sidecar of
    // the walk printed its refusal and its usage and exited 2 before its boot
    // line; the shell answered the start with `ok` and the turn hung.

    use tauri_plugin_shell::process::TerminatedPayload;

    /// Feeds a child's events through `follow_child` and says what came out.
    struct Followed {
        lines: Vec<String>,
        stderr: Vec<String>,
        exit: Option<(SidecarExit, bool)>,
        boot: Option<BootOutcome>,
    }

    fn follow(events: Vec<CommandEvent>, start_waiting: bool) -> Followed {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async move {
            let (sender, receiver) = tauri::async_runtime::channel(16);
            for event in events {
                sender.send(event).await.unwrap();
            }
            drop(sender);
            let (boot_sender, boot) = tokio::sync::oneshot::channel();
            let boot = if start_waiting {
                Some(boot)
            } else {
                drop(boot);
                None
            };
            let lines = std::sync::Mutex::new(Vec::new());
            let stderr = std::sync::Mutex::new(Vec::new());
            let exit = std::sync::Mutex::new(None);
            follow_child(
                receiver,
                Some("secret-token".into()),
                boot_sender,
                |line| lines.lock().unwrap().push(line),
                |line| stderr.lock().unwrap().push(line),
                |report, taken| *exit.lock().unwrap() = Some((report, taken)),
            )
            .await;
            let boot = match boot {
                Some(receiver) => receiver.await.ok(),
                None => None,
            };
            Followed {
                lines: lines.into_inner().unwrap(),
                stderr: stderr.into_inner().unwrap(),
                exit: exit.into_inner().unwrap(),
                boot,
            }
        })
    }

    fn stderr(text: &str) -> CommandEvent {
        CommandEvent::Stderr(text.as_bytes().to_vec())
    }

    fn stdout(text: &str) -> CommandEvent {
        CommandEvent::Stdout(text.as_bytes().to_vec())
    }

    fn exited(code: i32) -> CommandEvent {
        CommandEvent::Terminated(TerminatedPayload {
            code: Some(code),
            signal: None,
        })
    }

    #[test]
    fn a_child_that_exits_before_boot_refuses_the_start_with_its_stderr() {
        let followed = follow(
            vec![
                stderr("unknown permission mode: auto\n"),
                stderr("usage: liaison-sidecar --mcp-config <path> --model <model>\n"),
                exited(2),
            ],
            true,
        );
        // The start that was waiting is the one told, so the window is not
        // told a second time on the exit event.
        let (exit, taken_by_start) = followed.exit.expect("the exit is reported");
        assert!(taken_by_start);
        assert!(!exit.booted);
        assert_eq!(exit.code, Some(2));
        let learned = followed.boot.expect("the start learned something");
        assert_eq!(learned, BootOutcome::Exited(exit));
        let mut retired = false;
        let outcome = settle_boot(SpawnOutcome::Spawned, Some(learned), || retired = true);
        assert_eq!(
            outcome,
            SpawnOutcome::SpawnFailed("SidecarExited: unknown permission mode: auto".into())
        );
        // Out of the slot, so no turn is written into its closed pipe.
        assert!(retired);
    }

    #[test]
    fn a_child_that_booted_starts_and_its_later_death_is_the_windows_to_hear() {
        let followed = follow(
            vec![
                stdout("{\"type\":\"boot\",\"protocolVersion\":2}\n"),
                stderr("panic: the SDK went away, token secret-token\n"),
                exited(1),
            ],
            true,
        );
        assert_eq!(followed.boot, Some(BootOutcome::Booted));
        let (exit, taken_by_start) = followed.exit.expect("the exit is reported");
        assert!(!taken_by_start);
        assert!(exit.booted);
        assert_eq!(exit.reason, "panic: the SDK went away, token [redacted]");
        assert_eq!(followed.lines.len(), 1);
        // The bearer never reaches the webview, the report or the log.
        assert!(followed
            .stderr
            .iter()
            .all(|line| !line.contains("secret-token")));
        let mut retired = false;
        assert_eq!(
            settle_boot(SpawnOutcome::Spawned, followed.boot, || retired = true),
            SpawnOutcome::Spawned
        );
        assert!(!retired);
    }

    #[test]
    fn an_exit_nobody_is_waiting_for_is_still_reported() {
        // The start gave up waiting (the boot timeout): the exit is the
        // window's news, not a refusal nobody reads.
        let followed = follow(
            vec![stderr("killed by the OOM killer\n"), exited(137)],
            false,
        );
        let (exit, taken_by_start) = followed.exit.expect("the exit is reported");
        assert!(!taken_by_start);
        assert_eq!(exit.reason, "killed by the OOM killer");
    }

    #[test]
    fn a_start_that_already_failed_is_not_overwritten_by_the_boot_wait() {
        let outcome = settle_boot(
            SpawnOutcome::ReconnectRequired("NotApproved".into()),
            None,
            || panic!("nothing was spawned, so nothing is retired"),
        );
        assert_eq!(
            outcome,
            SpawnOutcome::ReconnectRequired("NotApproved".into())
        );
    }
}

/// The page is not a boundary (any script in apps/web reaches the invoke
/// bridge and hears every broadcast event). What a page script can do with a
/// local session must therefore stop at a question the shell itself asks.
#[cfg(test)]
mod page_script_boundary_tests {
    use super::*;

    /// A session in a mode where shell commands run without a per call prompt
    /// is handed over only after the shell's own confirmation, like bypass.
    #[test]
    fn a_mode_that_runs_commands_unprompted_needs_the_shells_own_confirmation() {
        let folder = std::env::temp_dir();
        let cwd = folder.to_string_lossy().into_owned();
        // Positive control: bypass is confirmed by the shell.
        let mut asked = false;
        let bypass = validate_start_request("bypass", &cwd, true, |_, _| {
            asked = true;
            false
        });
        assert!(asked && bypass.is_err(), "bypass is not confirmed by the shell");
        // Auto runs every non destructive shell command without asking.
        let mut asked = false;
        let auto = validate_start_request("auto", &cwd, true, |_, _| {
            asked = true;
            false
        });
        assert!(
            asked || auto.is_err(),
            "a page script starts an Auto session (unprompted shell) with no question from the shell"
        );
    }

    /// The id a pending permission is answered with is broadcast to the page
    /// verbatim; an answer carrying only that id is a page answer, not the
    /// user's.
    #[test]
    fn an_allow_carrying_only_the_broadcast_request_id_is_refused() {
        let pending = Mutex::new(HashSet::new());
        let line = r#"{"type":"permission_request","requestId":"req-1","toolName":"Bash","input":{"command":"id"}}"#;
        // What follow_child does with the line: record it, then emit the SAME
        // line on SIDECAR_LINE_EVENT, which every page script can listen to.
        apply_line_effect(&pending, line);
        let heard: serde_json::Value = serde_json::from_str(line).unwrap();
        let id_seen_by_page = heard["requestId"].as_str().unwrap();
        // Positive control: an id nobody asked for is refused.
        assert!(!take_permission(&pending, "forged"));
        assert!(
            !take_permission(&pending, id_seen_by_page),
            "an allow built from the broadcast event alone is accepted as the user's answer"
        );
    }
}
