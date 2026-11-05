// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SERVERS AND THE CLAUDE ACCOUNT, the shell's half: the commands that move
// the window between servers, and the two questions only the shell may ask.
//
// THERE IS NO ACCOUNT MENU, on any OS. The app's own UI is the one place a
// person moves between servers and signs out of Claude: the Servers icon in
// the sidebar and Settings > Profile (`list_servers` and the commands below).
// Windows and Linux never had a menu bar (Tauri draws one there as a strip
// inside the window), and macOS dropped its native "Account" menu so the same
// thing is not in two places. What macOS keeps is its STANDARD menu bar
// (`menu_bar.rs`): the Edit menu is what makes Cmd+C, Cmd+V and Cmd+Z work in
// the webview.
//
// The page cannot answer the two questions, and that is the point: removing a
// server signs out of it and forgets it (`ask_remove_server`), and signing out
// of Claude signs the whole computer out (`confirm_claude_sign_out`), so both
// are native dialogs. Their words are the page's, in the user's language, from
// the i18n catalogue (`set_account_dialog_copy`), because the copy a person
// reads belongs to the page (the same split as every refusal variant in
// `sidecar-ipc-contract.md`).
//
// A CHANGE OF SERVER GOES THROUGH THE WINDOW, and that is on purpose. Leaving a
// server is three things the shell cannot do alone: the local session's CLAIM
// on the conversation has to be released on the server being left (the window
// holds that lease and its bearer), the page's own storage has to be parked for
// that server and the next one's handed back, and the page has to start again
// against the new origin. So a confirmed removal is emitted on
// `liaison-account-menu` and the window calls `remove_server`, and every
// command below does the shell's half: stop the sidecar, forget the folders
// this window picked, drop the MCP config, switch the current entry, and give
// back the storage that was parked for the server now current.
//
// NOTHING OF ONE SERVER REACHES ANOTHER: the refresh token is filed per server
// and released only for the current one (`servers.rs`), the agent tokens and
// the recent folders are filed per server, the MCP config is deleted on every
// switch, a start that was waiting for a device grant spawns nothing once its
// server is no longer current (`sidecar.rs`, `still_current`), and a running
// local session is stopped before the current entry changes.

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::claude_auth::ClaudeAccount;
use crate::servers::{
    self, display_label, host_of, PageStorage, ServerList, NOT_CURRENT_SERVER, UNKNOWN_SERVER,
};
use crate::sidecar::{
    app_config_dir, clear_permissions, replace_running, stop_running, validate_server_address,
    PendingPermissions, PickedFolders, SessionFolder, SidecarSession,
};

/// The event a confirmed removal reaches the window on: `{ action: "remove",
/// address }`. The name is older than the in-app UI and kept as the wire name.
pub const ACCOUNT_MENU_EVENT: &str = "liaison-account-menu";

/// The refusals a new server address answers with, as VARIANTS: the window
/// owns the sentence.
pub const NOT_A_LIAISON_SERVER: &str = "NotALiaisonServer";
pub const SERVER_UNREACHABLE: &str = "ServerUnreachable";
/// A removal the user did not confirm in the shell's own dialog.
pub const REMOVAL_NOT_CONFIRMED: &str = "RemovalNotConfirmed";

/// The public route every Liaison answers without a session: the
/// organisation's name, logo, flags and BYOK models. The mobile shell validates
/// an address against the same route (apps/mobile onboarding/server-address.ts).
pub const BRANDING_PATH: &str = "/api/settings/branding";

/// How long an address may take to answer before it counts as unreachable.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
/// How long telling a server a session is over may take. Best effort: the
/// token is forgotten here whatever the server says.
pub const REVOKE_TIMEOUT: Duration = Duration::from_secs(5);

/// The words of the removal question, in the user's language. English until
/// the window says otherwise, so the question can be asked before the page
/// has handed anything over.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogCopy {
    pub remove_title: String,
    /// `{server}` is replaced with the server's name.
    pub remove_message: String,
    pub remove_confirm: String,
    pub cancel: String,
    /// The tray's two items (tray.rs), in the same language. Optional: an
    /// older page hands none and the tray keeps its English.
    #[serde(default)]
    pub tray_open: Option<String>,
    #[serde(default)]
    pub tray_quit: Option<String>,
}

impl Default for DialogCopy {
    fn default() -> Self {
        DialogCopy {
            remove_title: "Remove this server".into(),
            remove_message: "Remove {server}? You will be signed out of it, and this app will forget it.".into(),
            remove_confirm: "Remove".into(),
            cancel: "Cancel".into(),
            tray_open: None,
            tray_quit: None,
        }
    }
}

/// The longest string the window may hand over for one entry. A dialog title
/// or button is a few words, a message a sentence or two; anything longer is
/// not copy.
pub const MAX_COPY_LEN: usize = 300;

fn all_sane(texts: &[&String]) -> bool {
    texts
        .iter()
        .all(|text| !text.trim().is_empty() && text.len() <= MAX_COPY_LEN)
}

impl DialogCopy {
    fn is_sane(&self) -> bool {
        let tray: Vec<&String> = [&self.tray_open, &self.tray_quit]
            .into_iter()
            .flatten()
            .collect();
        all_sane(&[
            &self.remove_title,
            &self.remove_message,
            &self.remove_confirm,
            &self.cancel,
        ]) && all_sane(&tray)
    }
}

/// The words of the "Sign out of Claude" question (`claude_auth.rs`). Handed
/// over by the window beside `DialogCopy`, in the same language, and English
/// until then.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeDialogCopy {
    /// The account when the CLI names no email.
    pub signed_in: String,
    pub sign_out_title: String,
    /// `{email}` is replaced with the account's email, or `signed_in`.
    pub sign_out_message: String,
    pub sign_out_confirm: String,
}

impl Default for ClaudeDialogCopy {
    fn default() -> Self {
        ClaudeDialogCopy {
            signed_in: "Signed in to Claude".into(),
            sign_out_title: "Sign out of Claude".into(),
            sign_out_message: "Sign out of {email} on this computer? Local sessions, and Claude Code if you use it, will ask you to sign in again.".into(),
            sign_out_confirm: "Sign out".into(),
        }
    }
}

impl ClaudeDialogCopy {
    fn is_sane(&self) -> bool {
        all_sane(&[
            &self.signed_in,
            &self.sign_out_title,
            &self.sign_out_message,
            &self.sign_out_confirm,
        ])
    }
}

/// The shell's account state for this process.
#[derive(Default)]
pub struct AccountState {
    copy: Mutex<DialogCopy>,
    claude_copy: Mutex<ClaudeDialogCopy>,
    /// The Claude account the local sessions use, once the CLI has said.
    /// None until then.
    claude: Mutex<Option<ClaudeAccount>>,
    /// The ONE removal the user confirmed in the shell's own dialog, taken by
    /// `remove_server`. The window cannot remove a server nobody confirmed.
    confirmed_removal: Mutex<Option<String>>,
}

/// The Claude account the shell last read, if any.
pub fn claude_account<R: Runtime>(app: &AppHandle<R>) -> Option<ClaudeAccount> {
    app.try_state::<AccountState>()
        .and_then(|state| state.claude.lock().ok().and_then(|held| held.clone()))
}

/// Records the Claude account (`claude_auth.rs`).
pub fn set_claude_account<R: Runtime>(app: &AppHandle<R>, account: Option<ClaudeAccount>) {
    if let Some(state) = app.try_state::<AccountState>() {
        if let Ok(mut held) = state.claude.lock() {
            *held = account;
        }
    }
}

/// What the shell asks the window to do: only ever `remove`, once the user
/// confirmed the removal in the shell's own dialog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountAction {
    pub action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
}

/// The removal question, with the server named in it.
pub fn removal_message(copy: &DialogCopy, server_label: &str) -> String {
    copy.remove_message.replace("{server}", server_label)
}

/// Whether the branding route's answer is a Liaison's, and its organisation's
/// name when it is. The same shape the mobile shell checks: a name, a logo or
/// null, a flags object and a model list. Anything else (a 404 page, another
/// product's JSON, a captive portal) is not a Liaison server.
pub fn branding_outcome(status: u16, body: &str) -> Result<String, &'static str> {
    if status != 200 {
        return Err(NOT_A_LIAISON_SERVER);
    }
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|_| NOT_A_LIAISON_SERVER)?;
    let data = value.get("data").ok_or(NOT_A_LIAISON_SERVER)?;
    let name = data
        .get("orgName")
        .and_then(|name| name.as_str())
        .ok_or(NOT_A_LIAISON_SERVER)?;
    let logo_ok = matches!(
        data.get("logoUrl"),
        Some(serde_json::Value::Null) | Some(serde_json::Value::String(_))
    );
    let flags_ok = data.get("flags").is_some_and(|flags| flags.is_object());
    let models_ok = data.get("byokModelIds").is_some_and(|ids| ids.is_array());
    if !(logo_ok && flags_ok && models_ok) {
        return Err(NOT_A_LIAISON_SERVER);
    }
    Ok(name.trim().to_string())
}

/// Asks an address whether it is a Liaison, and for its organisation's name.
pub async fn probe_liaison(address: &str) -> Result<String, &'static str> {
    let client = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|_| SERVER_UNREACHABLE)?;
    let response = client
        .get(format!("{}{BRANDING_PATH}", address.trim_end_matches('/')))
        .send()
        .await
        .map_err(|_| SERVER_UNREACHABLE)?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|_| SERVER_UNREACHABLE)?;
    branding_outcome(status, &body)
}

/// Tells a server a session is over, presenting its refresh token the way the
/// page's own sign out does (`X-Liaison-Refresh`). Best effort and bounded: a
/// server that does not answer still loses the token here, and its session row
/// runs out on its own.
///
/// The body names this install's notification device (A44), so the server
/// revokes its receipt credential with the session.
pub async fn revoke_session(address: &str, refresh_token: &str, device_id: Option<&str>) {
    let Ok(client) = reqwest::Client::builder().timeout(REVOKE_TIMEOUT).build() else {
        return;
    };
    let result = client
        .post(format!("{}/api/auth/logout", address.trim_end_matches('/')))
        .header("X-Liaison-Refresh", refresh_token)
        .header("Content-Type", "application/json")
        .body(crate::notification_device::logout_body(device_id))
        .send()
        .await;
    if let Err(error) = result {
        eprintln!(
            "liaison: {} was not told the session ended ({error})",
            host_of(address)
        );
    }
}

/// What the window hands over when it leaves a server: which server its
/// storage belongs to (as the page recorded it) and the storage itself.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outgoing {
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub storage: PageStorage,
}

/// What the window gets back: the server it now talks to (None when there is
/// none left) and the storage parked for that server.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Switched {
    pub address: Option<String>,
    pub storage: PageStorage,
}

/// EVERYTHING THIS WINDOW HOLDS FOR THE SERVER IT IS LEAVING, dropped: the
/// sidecar (stopped, never merely dropped), the folder it may read, the prompts
/// it was waiting on, the folders this window picked (a folder chosen for one
/// organisation is not startable for the next), the device grant a start
/// may still be waiting on, and the node's runs and follows (D49 F9, D50).
pub fn leave_current<R: Runtime>(app: &AppHandle<R>) {
    // D49 F9: the node's follows belong to the server being left: each ends
    // `host_exit`, which the page posts there before it moves on.
    crate::node_follow::stop_all_follows(app);
    // D50: so do its node runs: each exit reaches the page, which posts the
    // run's end to the server being left (its saved lines are never posted to
    // the next server: `node_live_sessions` lists only that server's runs).
    if let Some(runs) = app.try_state::<crate::node_runs::LiveRuns>() {
        crate::node_job::stop_runs(&runs, None, None);
    }
    if let Some(session) = app.try_state::<SidecarSession>() {
        stop_running(&session.0, |child| {
            crate::sidecar::stop_child_detached(child);
        });
    }
    if let Some(folder) = app.try_state::<SessionFolder>() {
        replace_running(&folder.0, None);
    }
    if let Some(pending) = app.try_state::<PendingPermissions>() {
        clear_permissions(&pending.0);
    }
    if let Some(shell) = app.try_state::<crate::sidecar::ShellPermissions>() {
        if let Ok(mut book) = shell.0.lock() {
            book.retire_all();
        }
    }
    if let Some(picked) = app.try_state::<PickedFolders>() {
        if let Ok(mut set) = picked.0.lock() {
            set.clear();
        }
    }
    if let Some(grant) = crate::auth::take_pending_grant() {
        tauri::async_runtime::spawn(async move {
            let _ = crate::auth::cancel(&grant.config, &grant.device_code).await;
        });
    }
}

/// Parks what the window handed over under the server it belongs to.
fn park_outgoing(dir: &std::path::Path, outgoing: Option<Outgoing>) {
    let Some(outgoing) = outgoing else { return };
    let Some(owner) = outgoing.owner.filter(|owner| !owner.is_empty()) else {
        return;
    };
    if let Err(error) = servers::park_page_storage_at(dir, &owner, outgoing.storage) {
        eprintln!("liaison: the page storage could not be parked ({error})");
    }
}

/// The shell's half of a switch to a SAVED server.
fn switch_to<R: Runtime>(
    app: &AppHandle<R>,
    target: &str,
    outgoing: Option<Outgoing>,
) -> Result<Switched, String> {
    let dir = app_config_dir(app).ok_or("no application config directory")?;
    if !servers::load_list_at(&dir).contains(target) {
        return Err(UNKNOWN_SERVER.into());
    }
    leave_current(app);
    park_outgoing(&dir, outgoing);
    // The target's notification channel hands its session back first: the
    // page is about to present that server's single use refresh token.
    crate::server_listeners::release(app, target);
    servers::switch_current_at(&dir, target)?;
    // Its page shows what it notified; the fallback banner has nothing to add.
    crate::desktop_notifications::forget_server_notices(target);
    let storage = servers::take_page_storage_at(&dir, target);
    // The server being left keeps notifying this computer, through a channel
    // of its own (server_listeners.rs).
    crate::server_listeners::sync(app);
    refresh_labels(app.clone());
    Ok(Switched {
        address: Some(target.to_string()),
        storage,
    })
}

/// A NEW ADDRESS: the first run's address step, the connect card and a confirmed
/// `liaison://connect` link all end here. The address is checked for a scheme
/// that can carry a token, then ASKED whether it is a Liaison (an address that
/// does not answer as one is never saved), then filed in the list and made
/// current. No native confirmation (Avery, first Windows walk): the connect
/// card is the question, and nothing of the server being left reaches the new
/// one whoever asked.
#[tauri::command]
pub async fn set_server_address<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    outgoing: Option<Outgoing>,
) -> Result<Switched, String> {
    let address = validate_server_address(&url)?;
    let label = probe_liaison(&address).await.map_err(str::to_string)?;
    let dir = app_config_dir(&app).ok_or("no application config directory")?;
    let label = Some(label).filter(|label| !label.is_empty());
    let filed = servers::add_server_at(&dir, &address, label).map_err(|error| error.to_string())?;
    switch_to(&app, &filed, outgoing)
}

/// Switches the window to a server already in the list. No question: the list
/// is the user's own, and nothing of the server being left reaches this one.
#[tauri::command]
pub fn switch_server<R: Runtime>(
    app: AppHandle<R>,
    address: String,
    outgoing: Option<Outgoing>,
) -> Result<Switched, String> {
    switch_to(&app, &address, outgoing)
}

/// Whether the confirmed removal is this one, taking it either way: a ticket is
/// good for one removal.
pub fn take_confirmed(slot: &Mutex<Option<String>>, address: &str) -> bool {
    match slot.lock() {
        Ok(mut held) => held.take().as_deref() == Some(address),
        Err(_) => false,
    }
}

/// FORGETS A SERVER the user confirmed in the shell's own dialog: it is told
/// the session is over, then its tokens, its agents' tokens and folders and
/// its parked storage go, and the next saved server (or none) becomes current.
#[tauri::command]
pub async fn remove_server<R: Runtime>(
    app: AppHandle<R>,
    address: String,
) -> Result<Switched, String> {
    let confirmed = app
        .try_state::<AccountState>()
        .is_some_and(|state| take_confirmed(&state.confirmed_removal, &address));
    if !confirmed {
        return Err(REMOVAL_NOT_CONFIRMED.into());
    }
    let dir = app_config_dir(&app).ok_or("no application config directory")?;
    let was_current = servers::current_address_at(&dir).as_deref() == Some(address.as_str());
    if was_current {
        leave_current(&app);
    }
    crate::server_listeners::release(&app, &address);
    let removed = servers::remove_server_at(&dir, &address)?;
    crate::notification_device::forget_credential_at(&dir, &address);
    crate::node::forget_and_release(&dir, &address);
    if let Some(token) = removed.refresh_token.as_deref() {
        let device = crate::notification_device::device_id_at(&dir).ok();
        revoke_session(&address, token, device.as_deref()).await;
    }
    // The page's storage was the removed server's: nothing to park.
    if let Some(next) = removed.now_current.as_deref() {
        crate::server_listeners::release(&app, next);
    }
    crate::server_listeners::sync(&app);
    let storage = removed
        .now_current
        .as_deref()
        .map(|next| servers::take_page_storage_at(&dir, next))
        .unwrap_or_default();
    Ok(Switched {
        address: removed.now_current,
        storage,
    })
}

/// SIGNS OUT OF THE CURRENT SERVER and of nothing else: its session is revoked
/// and forgotten, and so are the agent tokens it minted for this machine, while
/// every other saved server keeps its own. The window starts again on that
/// server's sign in.
#[tauri::command]
pub async fn sign_out<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let dir = app_config_dir(&app).ok_or("no application config directory")?;
    let current = servers::current_address_at(&dir).ok_or(NOT_CURRENT_SERVER)?;
    leave_current(&app);
    let token = servers::stored_refresh_token_at(&dir, &current);
    servers::clear_refresh_token_for_at(&dir, &current);
    servers::forget_agent_tokens_at(&dir, &current);
    servers::forget_mcp_config_at(&dir);
    crate::notification_device::forget_credential_at(&dir, &current);
    crate::node::forget_and_release(&dir, &current);
    if let Some(token) = token {
        let device = crate::notification_device::device_id_at(&dir).ok();
        revoke_session(&current, &token, device.as_deref()).await;
    }
    crate::server_listeners::sync(&app);
    Ok(())
}

/// THE SAVED LIST, for the page's own servers UI: every server in the order it
/// was added, with its organisation's name when it has said it, and the
/// current one. The page draws the Servers switcher and Settings > Profile from
/// it, on every desktop OS: it is the only list there is.
#[tauri::command]
pub fn list_servers<R: Runtime>(app: AppHandle<R>) -> ServerList {
    app_config_dir(&app)
        .as_deref()
        .map(servers::load_list_at)
        .unwrap_or_default()
}

/// ASKS THE SHELL'S OWN REMOVAL QUESTION for a server the page's servers UI
/// offered to remove. The page cannot answer it: on a yes the shell files the
/// one-time confirmation and emits the `remove` action, and the window then
/// calls `remove_server`. An address the list does not
/// hold is refused rather than asked about.
#[tauri::command]
pub fn ask_remove_server<R: Runtime>(app: AppHandle<R>, address: String) -> Result<(), String> {
    let dir = app_config_dir(&app).ok_or("no application config directory")?;
    if !servers::load_list_at(&dir).contains(&address) {
        return Err(UNKNOWN_SERVER.into());
    }
    ask_removal(&app, address);
    Ok(())
}

/// ASKS THE SHELL'S OWN "SIGN OUT OF CLAUDE" QUESTION, for Settings > Profile,
/// the one place it is offered on every desktop OS. The page can only ask: signing out signs the whole computer out
/// of Claude, so it runs only on a yes in the native dialog
/// (`ask_claude_sign_out`), which a page script cannot answer.
#[tauri::command]
pub fn confirm_claude_sign_out<R: Runtime>(app: AppHandle<R>) {
    ask_claude_sign_out(&app);
}

/// The window's words for the two native questions, in the user's language.
/// Copy that is empty or too long to be a dialog's is refused, and the shell
/// keeps the words it had.
///
/// `claude` is the Claude sign-out question's words. Optional: the question
/// speaks English until the window hands them over.
#[tauri::command]
pub fn set_account_dialog_copy<R: Runtime>(
    app: AppHandle<R>,
    copy: DialogCopy,
    claude: Option<ClaudeDialogCopy>,
) -> Result<(), String> {
    if !copy.is_sane() || !claude.as_ref().map_or(true, ClaudeDialogCopy::is_sane) {
        return Err("the dialog copy is empty or too long".into());
    }
    if let (Some(open), Some(quit)) = (copy.tray_open.as_deref(), copy.tray_quit.as_deref()) {
        crate::tray::relabel(&app, open, quit);
    }
    if let Some(state) = app.try_state::<AccountState>() {
        if let Ok(mut held) = state.copy.lock() {
            *held = copy;
        }
        if let Some(claude) = claude {
            if let Ok(mut held) = state.claude_copy.lock() {
                *held = claude;
            }
        }
    }
    Ok(())
}

/// Asks every saved server for its organisation's name, off the main thread,
/// and files the ones that changed for `list_servers`. A server that does not
/// answer keeps the name it had (or its host).
pub fn refresh_labels<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let Some(dir) = app_config_dir(&app) else { return };
        for server in servers::load_list_at(&dir).servers {
            if let Ok(name) = probe_liaison(&server.address).await {
                let _ = servers::set_label_at(&dir, &server.address, &name);
            }
        }
    });
}

/// A `liaison://connect` link the OS handed the app: the server it names joins
/// the list once it has answered as a Liaison (a link is attacker reachable,
/// and a server that is not one is never saved). Switching to it is still the
/// window's confirmation, exactly as before.
pub fn note_connect_link<R: Runtime>(app: &AppHandle<R>, server: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(address) = validate_server_address(&server) else {
            return;
        };
        let Ok(name) = probe_liaison(&address).await else {
            return;
        };
        let Some(dir) = app_config_dir(&app) else { return };
        let label = Some(name).filter(|name| !name.is_empty());
        let _ = servers::add_server_at(&dir, &address, label);
    });
}

/// THE REMOVAL QUESTION THE SHELL ASKS ITSELF: removing a server signs out of
/// it and forgets it, so it is confirmed in a native dialog the page cannot
/// answer. Non blocking: a command may run on the main thread, which is the
/// thread a blocking dialog would wait on to paint itself.
fn ask_removal<R: Runtime>(app: &AppHandle<R>, address: String) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let Some(state) = app.try_state::<AccountState>() else {
        return;
    };
    let copy = state.copy.lock().map(|copy| copy.clone()).unwrap_or_default();
    let dir = app_config_dir(app);
    let label = dir
        .as_deref()
        .map(servers::load_list_at)
        .and_then(|list| {
            list.servers
                .iter()
                .find(|server| server.address == address)
                .map(display_label)
        })
        .unwrap_or_else(|| host_of(&address));
    let handle = app.clone();
    app.dialog()
        .message(removal_message(&copy, &label))
        .title(copy.remove_title.clone())
        .buttons(MessageDialogButtons::OkCancelCustom(
            copy.remove_confirm.clone(),
            copy.cancel.clone(),
        ))
        .show(move |confirmed| {
            if !confirmed {
                return;
            }
            if let Some(state) = handle.try_state::<AccountState>() {
                if let Ok(mut slot) = state.confirmed_removal.lock() {
                    *slot = Some(address.clone());
                }
            }
            let _ = handle.emit(
                ACCOUNT_MENU_EVENT,
                AccountAction {
                    action: "remove",
                    address: Some(address),
                },
            );
        });
}

/// SIGNING OUT OF CLAUDE is asked in a native dialog, like a removal: it signs
/// the whole computer out (the local sessions, and the person's own Claude
/// Code, which reads the same credential). The shell does it itself on a yes;
/// the window hears `signedOut` on `liaison-claude-auth`.
fn ask_claude_sign_out<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let Some(state) = app.try_state::<AccountState>() else {
        return;
    };
    let copy = state
        .claude_copy
        .lock()
        .map(|copy| copy.clone())
        .unwrap_or_default();
    let who = state
        .claude
        .lock()
        .ok()
        .and_then(|held| held.clone())
        .map(|account| account.email.unwrap_or_else(|| copy.signed_in.clone()))
        .unwrap_or_else(|| copy.signed_in.clone());
    let cancel = state
        .copy
        .lock()
        .map(|copy| copy.cancel.clone())
        .unwrap_or_default();
    let handle = app.clone();
    app.dialog()
        .message(copy.sign_out_message.replace("{email}", &who))
        .title(copy.sign_out_title.clone())
        .buttons(MessageDialogButtons::OkCancelCustom(
            copy.sign_out_confirm.clone(),
            cancel,
        ))
        .show(move |confirmed| {
            if !confirmed {
                return;
            }
            tauri::async_runtime::spawn(async move {
                if let Err(error) = crate::claude_auth::sign_out(&handle).await {
                    eprintln!("liaison: signing out of Claude did not complete ({error})");
                }
            });
        });
}

#[cfg(test)]
mod account_tests {
    use super::*;
    use crate::servers::SavedServer;

    const A: &str = "https://liaison.acme.example";
    const B: &str = "https://liaison.fabrikam.example";
    const LOCAL: &str = "http://localhost:3000";

    fn list(current: Option<&str>) -> ServerList {
        ServerList {
            current: current.map(str::to_string),
            servers: vec![
                SavedServer {
                    address: A.into(),
                    label: Some("Acme".into()),
                },
                SavedServer {
                    address: B.into(),
                    label: Some("Fabrikam".into()),
                },
                SavedServer {
                    address: LOCAL.into(),
                    label: None,
                },
            ],
        }
    }

    /// The two native questions speak the language the window handed over,
    /// and copy that cannot be a dialog's is refused.
    #[test]
    fn the_questions_speak_the_language_the_window_handed_over() {
        let french = DialogCopy {
            remove_title: "Retirer ce serveur".into(),
            remove_message: "Retirer {server} ?".into(),
            remove_confirm: "Retirer".into(),
            cancel: "Annuler".into(),
            tray_open: Some("Ouvrir Liaison".into()),
            tray_quit: Some("Quitter Liaison".into()),
        };
        assert_eq!(removal_message(&french, "Acme"), "Retirer Acme ?");
        let mut empty_tray = french.clone();
        empty_tray.tray_quit = Some(" ".into());
        assert!(!empty_tray.is_sane(), "an empty tray label was accepted");
        assert!(french.is_sane());
        assert!(DialogCopy::default().is_sane());
        let mut empty = french.clone();
        empty.cancel = " ".into();
        assert!(!empty.is_sane(), "an empty label was accepted");
        let mut long = french;
        long.remove_title = "x".repeat(MAX_COPY_LEN + 1);
        assert!(!long.is_sane(), "a label longer than any label was accepted");
        let claude = ClaudeDialogCopy::default();
        assert!(claude.is_sane());
        let mut empty = claude;
        empty.sign_out_confirm = " ".into();
        assert!(!empty.is_sane(), "an empty Claude label was accepted");
        // The window hands over the words by name; the shell reads camelCase.
        let parsed: DialogCopy = serde_json::from_value(serde_json::json!({
            "removeTitle": "t", "removeMessage": "m {server}", "removeConfirm": "c", "cancel": "x"
        }))
        .expect("the window's shape parses");
        assert_eq!(parsed.remove_message, "m {server}");
        assert_eq!(parsed.tray_open, None, "an older page hands no tray words");
        let with_tray: DialogCopy = serde_json::from_value(serde_json::json!({
            "removeTitle": "t", "removeMessage": "m", "removeConfirm": "c", "cancel": "x",
            "trayOpen": "Ouvrir Liaison", "trayQuit": "Quitter Liaison"
        }))
        .expect("the tray words parse");
        assert_eq!(with_tray.tray_quit.as_deref(), Some("Quitter Liaison"));
        let removal = serde_json::to_value(AccountAction {
            action: "remove",
            address: Some(B.into()),
        })
        .unwrap();
        assert_eq!(removal, serde_json::json!({ "action": "remove", "address": B }));
    }

    /// The window can call `remove_server`, so a removal nobody confirmed in
    /// the shell's own dialog is refused, and a confirmation is good once.
    #[test]
    fn a_removal_needs_the_shells_own_confirmation_and_it_is_good_once() {
        let slot = Mutex::new(None);
        assert!(!take_confirmed(&slot, A), "an unconfirmed removal went through");
        *slot.lock().unwrap() = Some(A.to_string());
        assert!(!take_confirmed(&slot, B), "A's confirmation removed B");
        *slot.lock().unwrap() = Some(A.to_string());
        assert!(take_confirmed(&slot, A));
        assert!(!take_confirmed(&slot, A), "one confirmation removed twice");
    }

    fn branding(data: serde_json::Value) -> String {
        serde_json::json!({ "data": data }).to_string()
    }

    #[test]
    fn an_address_is_a_liaison_only_when_its_branding_route_answers_as_one() {
        let good = branding(serde_json::json!({
            "orgName": "Acme", "logoUrl": null, "flags": {}, "byokModelIds": []
        }));
        assert_eq!(branding_outcome(200, &good), Ok("Acme".to_string()));
        assert_eq!(branding_outcome(404, &good), Err(NOT_A_LIAISON_SERVER));
        assert_eq!(
            branding_outcome(200, "<html>captive portal</html>"),
            Err(NOT_A_LIAISON_SERVER)
        );
        assert_eq!(
            branding_outcome(200, &branding(serde_json::json!({ "orgName": "x" }))),
            Err(NOT_A_LIAISON_SERVER),
            "a partial answer was taken for a Liaison"
        );
        assert_eq!(
            branding_outcome(200, r#"{"name":"another product"}"#),
            Err(NOT_A_LIAISON_SERVER)
        );
    }

    /// Nothing a switch leaves behind may reach the next server: the sidecar,
    /// the folder it may read, its prompts, the folders this window picked,
    /// and a device grant still being polled. Read from the source, because
    /// the managed state needs a running app to exist.
    #[test]
    fn leaving_a_server_stops_the_local_session_and_forgets_what_this_window_picked() {
        const ACCOUNT_RS: &str = include_str!("account.rs");
        let at = ACCOUNT_RS.find("pub fn leave_current").expect("leave_current exists");
        let body = &ACCOUNT_RS[at..];
        let body = &body[..body.find("\n}\n").expect("closed")];
        for needle in [
            "SidecarSession",
            "stop_running",
            "SessionFolder",
            "clear_permissions",
            "PickedFolders",
            "take_pending_grant",
            "stop_all_follows",
            // B2-7: D50's switch-time stop of the node's runs.
            "LiveRuns",
            "stop_runs",
        ] {
            assert!(body.contains(needle), "leave_current does not touch {needle}");
        }
        let switch = ACCOUNT_RS.find("fn switch_to").expect("switch_to exists");
        let switch = &ACCOUNT_RS[switch..];
        let switch = &switch[..switch.find("\n}\n").expect("closed")];
        let leave = switch.find("leave_current(app)").expect("a switch leaves first");
        let moved = switch
            .find("switch_current_at")
            .expect("a switch moves the current entry");
        assert!(leave < moved, "the current entry moves before the session is stopped");
    }

    /// NO ACCOUNT MENU, ON ANY OS (Avery, 2026-09-28: "do the same on mac,
    /// keep things consolidated"). Servers and the Claude account live in the
    /// app's own UI; the shell builds no menu of its own here and hears no
    /// menu click. Read from the source, because a menu needs a running app.
    #[test]
    fn the_shell_builds_no_account_menu_on_any_os() {
        const ACCOUNT_RS: &str = include_str!("account.rs");
        let shell = &ACCOUNT_RS[..ACCOUNT_RS.find("#[cfg(test)]").expect("a test module")];
        for needle in [
            "tauri::menu",
            "set_menu",
            "SubmenuBuilder",
            "on_menu_event",
            "refresh_menu",
            "MenuEvent",
        ] {
            assert!(!shell.contains(needle), "account.rs builds a menu again ({needle})");
        }
        // The confirmed removal is the only thing the shell emits.
        let mut emitted: Vec<&str> = shell
            .match_indices("action: \"")
            .map(|(at, _)| {
                let rest = &shell[at + 9..];
                &rest[..rest.find('"').expect("closed")]
            })
            .collect();
        emitted.dedup();
        assert_eq!(emitted, vec!["remove"], "the shell emits another account action");
    }

    /// The page's servers group reads the saved list as it is, and removing a
    /// server from the page still goes through the shell's own dialog.
    #[test]
    fn the_page_reads_the_list_and_asks_the_shell_to_confirm_a_removal() {
        const ACCOUNT_RS: &str = include_str!("account.rs");
        let at = ACCOUNT_RS
            .find("pub fn list_servers")
            .expect("list_servers exists");
        let body = &ACCOUNT_RS[at..];
        let body = &body[..body.find("\n}\n").expect("closed")];
        assert!(body.contains("load_list_at"));
        let at = ACCOUNT_RS
            .find("pub fn ask_remove_server")
            .expect("ask_remove_server exists");
        let body = &ACCOUNT_RS[at..];
        let body = &body[..body.find("\n}\n").expect("closed")];
        assert!(body.contains("ask_removal(&app"), "the removal skips the native dialog");
        assert!(body.contains("UNKNOWN_SERVER"), "an unknown address is asked about");
        let listed = serde_json::to_value(list(Some(A))).expect("serialises");
        assert_eq!(listed["current"], A);
        assert_eq!(listed["servers"][0]["address"], A);
        assert_eq!(listed["servers"][0]["label"], "Acme");
    }

    /// Settings > Profile offers "Sign out of Claude" on every desktop OS. The
    /// page can only ASK: the command opens the shell's native question, and
    /// the sign out runs only on its yes.
    #[test]
    fn the_page_can_ask_the_claude_sign_out_question_and_nothing_more() {
        assert!(crate::RELEASE_COMMANDS.contains(&"confirm_claude_sign_out"));
        const ACCOUNT_RS: &str = include_str!("account.rs");
        let at = ACCOUNT_RS
            .find("pub fn confirm_claude_sign_out")
            .expect("confirm_claude_sign_out exists");
        let body = &ACCOUNT_RS[at..];
        let body = &body[..body.find("\n}\n").expect("closed")];
        assert!(body.contains("ask_claude_sign_out(&app)"));
        assert!(!body.contains("claude_auth::sign_out"), "the page signs out unasked");
    }

    /// Re-binding the install asks NO native question (Avery, first Windows
    /// walk): the connect card is the question.
    #[test]
    fn a_new_address_asks_no_native_confirmation() {
        const ACCOUNT_RS: &str = include_str!("account.rs");
        let at = ACCOUNT_RS
            .find("pub async fn set_server_address")
            .expect("the command exists");
        let body = &ACCOUNT_RS[at..];
        let body = &body[..body.find("\n}\n").expect("the command is closed")];
        assert!(!body.contains("dialog()"), "set_server_address opens a dialog again");
        assert!(
            body.contains("probe_liaison"),
            "a new address is saved without asking it whether it is a Liaison"
        );
    }

    /// A44: EVERY SIGN OUT THE SHELL MAKES NAMES THIS INSTALL'S DEVICE, so
    /// the server revokes the device's receipt credential with the session,
    /// and the credential the shell kept for that server goes too.
    #[test]
    fn a_sign_out_names_the_notification_device_and_forgets_its_credential() {
        const SOURCE: &str = include_str!("account.rs");
        let shell = &SOURCE[..SOURCE.find("#[cfg(test)]").expect("a test module")];
        let revoke = &shell[shell.find("pub async fn revoke_session").expect("revoke")..];
        let revoke = &revoke[..revoke.find("\n}\n").expect("closed")];
        assert!(revoke.contains("device_id: Option<&str>"));
        assert!(revoke.contains(".body(crate::notification_device::logout_body(device_id))"));
        for caller in ["pub async fn sign_out", "pub async fn remove_server"] {
            let body = &shell[shell.find(caller).unwrap_or_else(|| panic!("{caller}"))..];
            let body = &body[..body.find("\n}\n").expect("closed")];
            assert!(
                body.contains("notification_device::device_id_at(&dir)")
                    && body.contains("device.as_deref()"),
                "{caller} does not name the device"
            );
            assert!(
                body.contains("notification_device::forget_credential_at(&dir"),
                "{caller} keeps the credential"
            );
        }
    }

    /// P4 N-D T4: a sign out or a removal also drops that server's NODE
    /// credential and lets the machine sleep again, so the next person to sign
    /// in on this computer never presents the previous owner's node.
    #[test]
    fn a_sign_out_forgets_the_node_and_releases_keep_awake() {
        const SOURCE: &str = include_str!("account.rs");
        let shell = &SOURCE[..SOURCE.find("#[cfg(test)]").expect("a test module")];
        for (caller, address) in [
            ("pub async fn sign_out", "&current"),
            ("pub async fn remove_server", "&address"),
        ] {
            let body = &shell[shell.find(caller).unwrap_or_else(|| panic!("{caller}"))..];
            let body = &body[..body.find("\n}\n").expect("closed")];
            assert!(
                body.contains(&format!("crate::node::forget_and_release(&dir, {address})")),
                "{caller} keeps the node credential"
            );
        }
    }
}
