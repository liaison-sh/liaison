// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SERVERS THIS INSTALL KNOWS, and everything that belongs to one of them.
//
// An owner with several organisations (and a developer with a local server or
// two) signs in to more than one Liaison from one desktop app. The install used
// to be bound to ONE address, and moving it cleared every token, so going back
// meant signing in again. It now keeps a list, and a CURRENT entry, and every
// piece of state that belongs to a server is filed under that server:
//
//   liaison-servers.json          the list and which entry is current
//   liaison-refresh-token.json    one refresh token per server (the web
//                                 session the page signs in with)
//   liaison-mcp-token.json        one agent scoped token per (server, agent),
//                                 already keyed that way (`token_key`)
//   liaison-folders.json          the recent folders, per (server, agent)
//   liaison-webview-storage.json  the page's own storage, parked per server
//                                 while another server is current
//   liaison-mcp-config.json       written for the CURRENT server at each start,
//                                 and deleted whenever the current one changes
//
// THE RULE: nothing that belongs to server A is ever handed to server B. The
// refresh token is released only for the current server, and only when the
// caller names that same server; a start refuses to spawn once the current
// server is no longer the one it was started for; the MCP config (which
// carries a live bearer) does not outlive a switch.
//
// Every file is 0600 in the app's own config directory, like the files that
// were here before. The functions below take that directory as an argument so
// the whole rule is drivable from a test with no running app.

use std::fs;
use std::io;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use url::Url;

use crate::sidecar::{write_private, MCP_CONFIG_FILE, MCP_TOKEN_FILE, RECENT_FOLDERS_FILE};

/// The list, and which entry is current.
pub const SERVERS_FILE: &str = "liaison-servers.json";
/// The ONE address the install was bound to before it kept a list. Read once,
/// by the migration, and removed once its content lives in the list.
pub const LEGACY_SERVER_ADDRESS_FILE: &str = "liaison-server.json";
/// One refresh token per server. The file name is the one the single token
/// lived in, so an install that is migrated keeps one file and not two.
pub const REFRESH_TOKEN_FILE: &str = "liaison-refresh-token.json";
/// The page's own storage for every server that is not current.
pub const WEBVIEW_STORAGE_FILE: &str = "liaison-webview-storage.json";

/// A refresh token is opaque and short. Anything longer is not one.
pub const MAX_REFRESH_TOKEN_LEN: usize = 512;

/// How much of the page's storage one server may park. The webview's own quota
/// is about five megabytes per origin; anything larger than that is not the
/// page's storage, and writing it would only make this file a place to park
/// bytes.
pub const MAX_PARKED_STORAGE_BYTES: usize = 8 * 1024 * 1024;

/// One saved server. The ADDRESS is its identity: it is what the tokens, the
/// folders and the parked storage are filed under.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedServer {
    pub address: String,
    /// The organisation's own name, as the server answered it, or None until
    /// it has answered. The servers UI shows the host in its place.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// The whole list.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerList {
    #[serde(default)]
    pub current: Option<String>,
    #[serde(default)]
    pub servers: Vec<SavedServer>,
}

impl ServerList {
    pub fn contains(&self, address: &str) -> bool {
        self.servers.iter().any(|server| server.address == address)
    }
}

/// The origin of an address, or None when it is not an absolute http(s) URL.
/// Two addresses are the same server when their origins are equal: that is the
/// unit a browser, a cookie and the page's own storage all agree on.
pub fn origin_of(address: &str) -> Option<String> {
    let parsed = Url::parse(address.trim()).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return None;
    }
    Some(parsed.origin().ascii_serialization())
}

/// Whether two addresses name the same server.
pub fn same_server(left: &str, right: &str) -> bool {
    match (origin_of(left), origin_of(right)) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

/// What the shell calls a server (in the removal question): its organisation's name when the server said
/// it, otherwise its host (with the port when it has one, so two local servers
/// on one machine are two different lines).
pub fn display_label(server: &SavedServer) -> String {
    if let Some(label) = server.label.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
        return label.to_string();
    }
    host_of(&server.address)
}

/// The host (and port) of an address, or the address itself when it has none.
pub fn host_of(address: &str) -> String {
    match Url::parse(address) {
        Ok(parsed) => match (parsed.host_str(), parsed.port()) {
            (Some(host), Some(port)) => format!("{host}:{port}"),
            (Some(host), None) => host.to_string(),
            _ => address.to_string(),
        },
        Err(_) => address.to_string(),
    }
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn write_json(dir: &Path, file: &str, value: &serde_json::Value) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    write_private(&dir.join(file), &serde_json::to_vec(value)?)
}

/// The address the install was bound to before the list existed.
pub fn read_legacy_server_address_at(dir: &Path) -> Option<String> {
    let body = read_json(&dir.join(LEGACY_SERVER_ADDRESS_FILE))?;
    let url = body.get("baseUrl")?.as_str()?.trim().to_string();
    if url.is_empty() {
        None
    } else {
        Some(url)
    }
}

/// THE MIGRATION, run the first time a build with the list reads a directory
/// written by one without it: the address it was bound to becomes the first
/// saved server (and the current one), the refresh token that was stored for
/// it is filed under it, and the recent folders its agents ran in are filed
/// under it too. Nothing is lost and nothing is re-asked. Idempotent: a
/// directory that already has a list is left alone.
pub fn migrate_at(dir: &Path) -> io::Result<ServerList> {
    if let Some(list) = read_list_file(dir) {
        return Ok(list);
    }
    let legacy = read_legacy_server_address_at(dir);
    let list = ServerList {
        current: legacy.clone(),
        servers: legacy
            .iter()
            .map(|address| SavedServer {
                address: address.clone(),
                label: None,
            })
            .collect(),
    };

    // The single refresh token belonged to the single server. With no server
    // it belonged to nobody, and it is dropped rather than guessed at.
    let refresh = read_json(&dir.join(REFRESH_TOKEN_FILE));
    if let Some(token) = refresh
        .as_ref()
        .and_then(|body| body.get("refreshToken"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|token| !token.is_empty())
    {
        let mut servers = serde_json::Map::new();
        if let Some(address) = legacy.as_deref() {
            servers.insert(address.to_string(), serde_json::Value::String(token.into()));
        }
        write_json(
            dir,
            REFRESH_TOKEN_FILE,
            &serde_json::json!({ "servers": servers }),
        )?;
    }

    // The recent folders were filed by agent alone. An agent id means nothing
    // on another server, so every one of them is the legacy server's.
    if let Some(address) = legacy.as_deref() {
        if let Some(serde_json::Value::Object(document)) = read_json(&dir.join(RECENT_FOLDERS_FILE))
        {
            let mut next = serde_json::Map::new();
            for (key, value) in document {
                if key.contains('#') {
                    next.insert(key, value);
                } else {
                    next.insert(crate::sidecar::token_key(address, &key), value);
                }
            }
            write_json(dir, RECENT_FOLDERS_FILE, &serde_json::Value::Object(next))?;
        }
    }

    save_list_at(dir, &list)?;
    let _ = fs::remove_file(dir.join(LEGACY_SERVER_ADDRESS_FILE));
    Ok(list)
}

fn read_list_file(dir: &Path) -> Option<ServerList> {
    let value = read_json(&dir.join(SERVERS_FILE))?;
    let mut list: ServerList = serde_json::from_value(value).ok()?;
    // A current entry that is not in the list is no current entry at all.
    if let Some(current) = list.current.clone() {
        if !list.contains(&current) {
            list.current = None;
        }
    }
    Some(list)
}

/// The list, migrated on first read.
pub fn load_list_at(dir: &Path) -> ServerList {
    migrate_at(dir).unwrap_or_default()
}

pub fn save_list_at(dir: &Path, list: &ServerList) -> io::Result<()> {
    write_json(dir, SERVERS_FILE, &serde_json::to_value(list)?)
}

/// The address of the current server, if there is one.
pub fn current_address_at(dir: &Path) -> Option<String> {
    load_list_at(dir).current
}

/// Adds a server to the list, or refreshes the label of one already in it.
/// Answers the address as it is filed: an address naming the same ORIGIN as a
/// saved one is that saved one, not a second line in the list.
pub fn add_server_at(dir: &Path, address: &str, label: Option<String>) -> io::Result<String> {
    let mut list = load_list_at(dir);
    let filed = match list
        .servers
        .iter_mut()
        .find(|server| same_server(&server.address, address))
    {
        Some(existing) => {
            if label.is_some() {
                existing.label = label;
            }
            existing.address.clone()
        }
        None => {
            list.servers.push(SavedServer {
                address: address.to_string(),
                label,
            });
            address.to_string()
        }
    };
    save_list_at(dir, &list)?;
    Ok(filed)
}

/// Records the organisation name a server answered with. A server that is
/// not in the list is left out of it: a label is never how a server gets in.
pub fn set_label_at(dir: &Path, address: &str, label: &str) -> io::Result<bool> {
    let mut list = load_list_at(dir);
    let Some(server) = list.servers.iter_mut().find(|server| server.address == address) else {
        return Ok(false);
    };
    let label = label.trim();
    if label.is_empty() || server.label.as_deref() == Some(label) {
        return Ok(false);
    }
    server.label = Some(label.to_string());
    save_list_at(dir, &list)?;
    Ok(true)
}

/// The refusal a switch to a server that is not saved answers with.
pub const UNKNOWN_SERVER: &str = "UnknownServer";

/// Makes a SAVED server the current one. Whatever was current keeps every
/// token it had: going back to it is a switch, not a new sign in. The MCP
/// config goes, because it carries the previous server's live bearer and the
/// next start writes a fresh one for the new server.
pub fn switch_current_at(dir: &Path, address: &str) -> Result<(), String> {
    let mut list = load_list_at(dir);
    if !list.contains(address) {
        return Err(UNKNOWN_SERVER.into());
    }
    if list.current.as_deref() != Some(address) {
        forget_mcp_config_at(dir);
    }
    list.current = Some(address.to_string());
    save_list_at(dir, &list).map_err(|error| error.to_string())
}

/// Removes the session's MCP config: it carries a live bearer for one server.
pub fn forget_mcp_config_at(dir: &Path) {
    let _ = fs::remove_file(dir.join(MCP_CONFIG_FILE));
}

/// What removing a server took with it, for the caller to finish the job
/// (revoking the refresh token on the server, which needs the network).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Removed {
    /// The refresh token that was stored for it, so the server can be told.
    pub refresh_token: Option<String>,
    /// Whether it was the current server.
    pub was_current: bool,
    /// The server that is current now, if any.
    pub now_current: Option<String>,
}

/// FORGETS A SERVER: its entry, its refresh token, every agent token minted by
/// it, its agents' recent folders and the page storage parked for it. When it
/// was the current server the next saved one becomes current, or none.
pub fn remove_server_at(dir: &Path, address: &str) -> Result<Removed, String> {
    let mut list = load_list_at(dir);
    if !list.contains(address) {
        return Err(UNKNOWN_SERVER.into());
    }
    let was_current = list.current.as_deref() == Some(address);
    list.servers.retain(|server| server.address != address);
    if was_current {
        list.current = list.servers.first().map(|server| server.address.clone());
        forget_mcp_config_at(dir);
    }
    let refresh_token = take_refresh_token_at(dir, address);
    forget_agent_tokens_at(dir, address);
    forget_keyed_entries_at(dir, RECENT_FOLDERS_FILE, None, address);
    forget_keyed_entries_at(dir, WEBVIEW_STORAGE_FILE, Some("servers"), address);
    save_list_at(dir, &list).map_err(|error| error.to_string())?;
    Ok(Removed {
        refresh_token,
        was_current,
        now_current: list.current,
    })
}

/// Drops every entry of a keyed document that belongs to `address`: its own
/// key, or any `address#...` key (`token_key`).
fn forget_keyed_entries_at(dir: &Path, file: &str, nested: Option<&str>, address: &str) {
    let path = dir.join(file);
    let Some(mut document) = read_json(&path) else {
        return;
    };
    let prefix = format!("{}#", address.trim_end_matches('/'));
    let map = match nested {
        Some(key) => document.get_mut(key).and_then(|value| value.as_object_mut()),
        None => document.as_object_mut(),
    };
    let Some(map) = map else { return };
    let before = map.len();
    map.retain(|key, _| key != address && !key.starts_with(&prefix));
    if map.len() != before {
        let _ = write_json(dir, file, &document);
    }
}

/// Every agent scoped token minted by this server (`{ "agents": { key: .. } }`).
pub fn forget_agent_tokens_at(dir: &Path, address: &str) {
    forget_keyed_entries_at(dir, MCP_TOKEN_FILE, Some("agents"), address);
}

/// EVERY READ-MODIFY-WRITE OF THE REFRESH TOKEN FILE HOLDS THIS LOCK. The page
/// files the current server's rotation (a command thread) while a notification
/// channel files another server's (`server_listeners.rs`, a runtime thread),
/// and both rewrite the whole map: unserialised, the one that read first wrote
/// back the token the other had just replaced. For the current server that is
/// the token the server has already spent, and presenting it at the next
/// launch is a reuse the server answers by ending the session.
static REFRESH_TOKENS_LOCK: Mutex<()> = Mutex::new(());

fn refresh_tokens_lock() -> MutexGuard<'static, ()> {
    // A writer that panicked left the file whole (writes are replaced whole),
    // so the lock is still good to take.
    REFRESH_TOKENS_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn refresh_tokens_document(dir: &Path) -> serde_json::Map<String, serde_json::Value> {
    // A file still in the single token shape has not been migrated, which only
    // happens when the list was written by hand: its token belongs to nobody.
    read_json(&dir.join(REFRESH_TOKEN_FILE))
        .and_then(|body| body.get("servers").and_then(|v| v.as_object()).cloned())
        .unwrap_or_default()
}

fn write_refresh_tokens(dir: &Path, map: serde_json::Map<String, serde_json::Value>) -> io::Result<()> {
    write_json(dir, REFRESH_TOKEN_FILE, &serde_json::json!({ "servers": map }))
}

/// The refresh token stored for one server, whoever is current. For the
/// shell's own use (revoking it); the page is answered by `refresh_token_for_at`.
pub fn stored_refresh_token_at(dir: &Path, address: &str) -> Option<String> {
    refresh_tokens_document(dir)
        .get(address)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
}

fn take_refresh_token_at(dir: &Path, address: &str) -> Option<String> {
    let _lock = refresh_tokens_lock();
    let token = stored_refresh_token_at(dir, address);
    let mut map = refresh_tokens_document(dir);
    if map.remove(address).is_some() {
        let _ = write_refresh_tokens(dir, map);
    }
    token
}

/// THE ONE WAY A REFRESH TOKEN LEAVES THIS FILE FOR THE PAGE: the page names
/// the server it is about to present the token to, and it is answered only
/// when that server is the CURRENT one, with the token stored for it. A page
/// that is still pointed at the previous server (a stale mirror, a reload that
/// has not happened yet) gets nothing, so a token can never travel to a server
/// it was not minted by.
pub fn refresh_token_for_at(dir: &Path, server: &str) -> Option<String> {
    let current = current_address_at(dir)?;
    if !same_server(&current, server) {
        return None;
    }
    stored_refresh_token_at(dir, &current)
}

/// The refusal a token for a server that is not current answers with.
pub const NOT_CURRENT_SERVER: &str = "NotCurrentServer";

/// Stores (or, for an empty token, removes) the CURRENT server's refresh
/// token, on the same condition it is read on: the page names the server the
/// token came from, and it has to be the current one.
pub fn store_refresh_token_for_at(dir: &Path, server: &str, token: &str) -> Result<(), String> {
    let trimmed = token.trim();
    if trimmed.len() > MAX_REFRESH_TOKEN_LEN {
        return Err("the refresh token is longer than any this API issues".into());
    }
    let current = current_address_at(dir).ok_or(NOT_CURRENT_SERVER)?;
    if !same_server(&current, server) {
        return Err(NOT_CURRENT_SERVER.into());
    }
    let _lock = refresh_tokens_lock();
    let mut map = refresh_tokens_document(dir);
    if trimmed.is_empty() {
        if map.remove(&current).is_none() {
            return Ok(());
        }
    } else {
        map.insert(current, serde_json::Value::String(trimmed.into()));
    }
    write_refresh_tokens(dir, map).map_err(|error| error.to_string())
}

/// Files the token a NON-CURRENT server rotated for the shell's own
/// notification channel (`server_listeners.rs`), under that server only. The
/// page owns the current server's token (`store_refresh_token_for_at`), so a
/// server that is current, or no longer saved, is refused: the channel never
/// writes over the page's session, nor brings a removed server's back.
pub fn store_background_refresh_token_at(dir: &Path, address: &str, token: &str) -> Result<(), String> {
    let trimmed = token.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_REFRESH_TOKEN_LEN {
        return Err("not a refresh token this API issues".into());
    }
    let list = load_list_at(dir);
    if !list.contains(address) {
        return Err(UNKNOWN_SERVER.into());
    }
    if list.current.as_deref() == Some(address) {
        return Err("the current server's token belongs to the page".into());
    }
    let _lock = refresh_tokens_lock();
    let mut map = refresh_tokens_document(dir);
    map.insert(address.to_string(), serde_json::Value::String(trimmed.into()));
    write_refresh_tokens(dir, map).map_err(|error| error.to_string())
}

/// Removes one server's refresh token, whoever is current (a sign out the
/// shell performs itself).
pub fn clear_refresh_token_for_at(dir: &Path, address: &str) {
    let _ = take_refresh_token_at(dir, address);
}

/// The page's storage, as the page handed it over: string keys to string
/// values, and nothing else.
pub type PageStorage = serde_json::Map<String, serde_json::Value>;

fn only_strings(storage: PageStorage) -> PageStorage {
    storage
        .into_iter()
        .filter(|(_, value)| value.is_string())
        .collect()
}

/// PARKS the page's storage for a server that is being left, so the next
/// server's page starts on its own storage and this one gets its own back. A
/// server that is not saved parks nothing (there is nobody to give it back
/// to), and neither does a storage over the cap.
pub fn park_page_storage_at(dir: &Path, address: &str, storage: PageStorage) -> io::Result<bool> {
    if !load_list_at(dir).contains(address) {
        return Ok(false);
    }
    let storage = only_strings(storage);
    let size = serde_json::to_vec(&storage)?.len();
    if size > MAX_PARKED_STORAGE_BYTES {
        return Ok(false);
    }
    let path = dir.join(WEBVIEW_STORAGE_FILE);
    let mut servers = read_json(&path)
        .and_then(|body| body.get("servers").and_then(|v| v.as_object()).cloned())
        .unwrap_or_default();
    servers.insert(address.to_string(), serde_json::Value::Object(storage));
    write_json(dir, WEBVIEW_STORAGE_FILE, &serde_json::json!({ "servers": servers }))?;
    Ok(true)
}

/// TAKES a server's parked storage back, leaving nothing parked for it: the
/// page holds it now, and a second copy here would be a stale one.
pub fn take_page_storage_at(dir: &Path, address: &str) -> PageStorage {
    let path = dir.join(WEBVIEW_STORAGE_FILE);
    let Some(mut body) = read_json(&path) else {
        return PageStorage::new();
    };
    let taken = body
        .get_mut("servers")
        .and_then(|servers| servers.as_object_mut())
        .and_then(|servers| servers.remove(address));
    let Some(serde_json::Value::Object(storage)) = taken else {
        return PageStorage::new();
    };
    let _ = write_json(dir, WEBVIEW_STORAGE_FILE, &body);
    only_strings(storage)
}

/// The recent folder key for an agent on the current server.
pub fn folder_key(address: &str, agent_id: &str) -> String {
    crate::sidecar::token_key(address, agent_id)
}

/// Whether a recent folder key belongs to a server.
pub fn folder_key_is_for(key: &str, address: &str) -> bool {
    key.starts_with(&format!("{}#", address.trim_end_matches('/')))
}

/// A private directory for one test, emptied first.
#[cfg(test)]
pub fn scratch_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("liaison-servers-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("a scratch directory");
    dir
}

#[cfg(test)]
mod servers_tests {
    use super::*;

    const A: &str = "https://liaison.acme.example";
    const B: &str = "https://liaison.fabrikam.example";
    const LOCAL: &str = "http://localhost:3000";

    fn legacy_install(name: &str) -> PathBuf {
        let dir = scratch_dir(name);
        fs::write(
            dir.join(LEGACY_SERVER_ADDRESS_FILE),
            serde_json::to_vec(&serde_json::json!({ "baseUrl": A })).unwrap(),
        )
        .unwrap();
        fs::write(
            dir.join(REFRESH_TOKEN_FILE),
            serde_json::to_vec(&serde_json::json!({ "refreshToken": "rt-a" })).unwrap(),
        )
        .unwrap();
        fs::write(
            dir.join(RECENT_FOLDERS_FILE),
            serde_json::to_vec(&serde_json::json!({ "agent-1": ["/work"] })).unwrap(),
        )
        .unwrap();
        dir
    }

    #[test]
    fn an_existing_install_migrates_to_one_saved_server_that_keeps_its_session() {
        let dir = legacy_install("migrate");
        let list = load_list_at(&dir);
        assert_eq!(list.current.as_deref(), Some(A));
        assert_eq!(
            list.servers,
            vec![SavedServer {
                address: A.into(),
                label: None
            }]
        );
        assert_eq!(
            refresh_token_for_at(&dir, A).as_deref(),
            Some("rt-a"),
            "the migrated server lost its session"
        );
        let folders: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.join(RECENT_FOLDERS_FILE)).unwrap()).unwrap();
        assert_eq!(
            folders,
            serde_json::json!({ format!("{A}#agent-1"): ["/work"] }),
            "the recent folders were not filed under the migrated server"
        );
        assert!(
            !dir.join(LEGACY_SERVER_ADDRESS_FILE).exists(),
            "the legacy address file outlived the migration"
        );
        // Idempotent: a second read changes nothing.
        assert_eq!(load_list_at(&dir), list);
        assert_eq!(refresh_token_for_at(&dir, A).as_deref(), Some("rt-a"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_fresh_install_has_no_server_and_a_stray_token_belongs_to_nobody() {
        let dir = scratch_dir("fresh");
        fs::write(
            dir.join(REFRESH_TOKEN_FILE),
            serde_json::to_vec(&serde_json::json!({ "refreshToken": "orphan" })).unwrap(),
        )
        .unwrap();
        let list = load_list_at(&dir);
        assert_eq!(list, ServerList::default());
        assert_eq!(refresh_token_for_at(&dir, A), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn adding_the_same_origin_twice_is_one_server() {
        let dir = scratch_dir("dedupe");
        assert_eq!(add_server_at(&dir, A, None).unwrap(), A);
        assert_eq!(
            add_server_at(&dir, &format!("{A}/"), Some("Acme".into())).unwrap(),
            A
        );
        let list = load_list_at(&dir);
        assert_eq!(list.servers.len(), 1);
        assert_eq!(list.servers[0].label.as_deref(), Some("Acme"));
        assert_eq!(list.current, None, "adding a server is not switching to it");
        let _ = fs::remove_dir_all(&dir);
    }

    /// THE ISOLATION RULE. A token is released only to the current server,
    /// and only when the caller names that same server.
    #[test]
    fn a_refresh_token_for_one_server_is_never_released_for_another() {
        let dir = scratch_dir("isolation");
        add_server_at(&dir, A, None).unwrap();
        add_server_at(&dir, B, None).unwrap();
        switch_current_at(&dir, A).unwrap();
        store_refresh_token_for_at(&dir, A, "rt-a").unwrap();

        // The page still pointed at A after the shell moved to B asks for A's
        // token: nothing, because A is not current any more.
        switch_current_at(&dir, B).unwrap();
        assert_eq!(refresh_token_for_at(&dir, A), None);
        // And B, which never signed in, has none of its own: A's is not it.
        assert_eq!(refresh_token_for_at(&dir, B), None);
        // A token the page learned from A cannot be filed while B is current.
        assert_eq!(
            store_refresh_token_for_at(&dir, A, "rt-a2"),
            Err(NOT_CURRENT_SERVER.to_string())
        );
        store_refresh_token_for_at(&dir, B, "rt-b").unwrap();
        assert_eq!(refresh_token_for_at(&dir, B).as_deref(), Some("rt-b"));

        // Switching BACK needs no new sign in: A's token was kept.
        switch_current_at(&dir, A).unwrap();
        assert_eq!(refresh_token_for_at(&dir, A).as_deref(), Some("rt-a"));
        assert_eq!(refresh_token_for_at(&dir, B), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn signing_out_of_the_current_server_keeps_the_other_servers_sessions() {
        let dir = scratch_dir("sign-out");
        add_server_at(&dir, A, None).unwrap();
        add_server_at(&dir, B, None).unwrap();
        switch_current_at(&dir, B).unwrap();
        store_refresh_token_for_at(&dir, B, "rt-b").unwrap();
        switch_current_at(&dir, A).unwrap();
        store_refresh_token_for_at(&dir, A, "rt-a").unwrap();
        store_refresh_token_for_at(&dir, A, "").unwrap();
        assert_eq!(refresh_token_for_at(&dir, A), None);
        assert_eq!(stored_refresh_token_at(&dir, B).as_deref(), Some("rt-b"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn switching_to_a_server_that_is_not_saved_is_refused() {
        let dir = scratch_dir("unknown");
        add_server_at(&dir, A, None).unwrap();
        assert_eq!(
            switch_current_at(&dir, B),
            Err(UNKNOWN_SERVER.to_string())
        );
        assert_eq!(current_address_at(&dir), None);
        let _ = fs::remove_dir_all(&dir);
    }

    /// The MCP config carries the previous server's live bearer beside its MCP
    /// address, so it does not survive a switch. The agent tokens do: they are
    /// filed per server already, and going back must not ask again.
    #[test]
    fn a_switch_drops_the_mcp_config_and_keeps_every_servers_agent_tokens() {
        let dir = scratch_dir("mcp");
        add_server_at(&dir, A, None).unwrap();
        add_server_at(&dir, B, None).unwrap();
        switch_current_at(&dir, A).unwrap();
        fs::write(dir.join(MCP_CONFIG_FILE), b"{\"agentScopedToken\":\"a\"}").unwrap();
        fs::write(
            dir.join(MCP_TOKEN_FILE),
            serde_json::to_vec(&serde_json::json!({ "agents": {
                format!("{A}#agent-1"): { "token": "a" },
                format!("{B}#agent-1"): { "token": "b" },
            }}))
            .unwrap(),
        )
        .unwrap();
        switch_current_at(&dir, B).unwrap();
        assert!(!dir.join(MCP_CONFIG_FILE).exists(), "A's MCP config survived the switch");
        let tokens: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.join(MCP_TOKEN_FILE)).unwrap()).unwrap();
        assert_eq!(tokens["agents"].as_object().unwrap().len(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn removing_a_server_forgets_everything_filed_under_it_and_nothing_else() {
        let dir = scratch_dir("remove");
        add_server_at(&dir, A, None).unwrap();
        add_server_at(&dir, B, None).unwrap();
        switch_current_at(&dir, B).unwrap();
        store_refresh_token_for_at(&dir, B, "rt-b").unwrap();
        switch_current_at(&dir, A).unwrap();
        store_refresh_token_for_at(&dir, A, "rt-a").unwrap();
        fs::write(
            dir.join(MCP_TOKEN_FILE),
            serde_json::to_vec(&serde_json::json!({ "agents": {
                format!("{A}#agent-1"): { "token": "a" },
                format!("{B}#agent-1"): { "token": "b" },
            }}))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            dir.join(RECENT_FOLDERS_FILE),
            serde_json::to_vec(&serde_json::json!({
                format!("{A}#agent-1"): ["/a"],
                format!("{B}#agent-1"): ["/b"],
            }))
            .unwrap(),
        )
        .unwrap();
        let mut parked = PageStorage::new();
        parked.insert("liaison:tabs".into(), "[]".into());
        park_page_storage_at(&dir, B, parked.clone()).unwrap();
        park_page_storage_at(&dir, A, parked).unwrap();
        fs::write(dir.join(MCP_CONFIG_FILE), b"{}").unwrap();

        let removed = remove_server_at(&dir, A).unwrap();
        assert_eq!(
            removed,
            Removed {
                refresh_token: Some("rt-a".into()),
                was_current: true,
                now_current: Some(B.into()),
            }
        );
        let list = load_list_at(&dir);
        assert!(!list.contains(A));
        assert_eq!(list.current.as_deref(), Some(B));
        assert_eq!(stored_refresh_token_at(&dir, A), None);
        assert_eq!(stored_refresh_token_at(&dir, B).as_deref(), Some("rt-b"));
        let tokens: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.join(MCP_TOKEN_FILE)).unwrap()).unwrap();
        assert_eq!(
            tokens["agents"].as_object().unwrap().keys().collect::<Vec<_>>(),
            vec![&format!("{B}#agent-1")]
        );
        let folders: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.join(RECENT_FOLDERS_FILE)).unwrap()).unwrap();
        assert_eq!(
            folders.as_object().unwrap().keys().collect::<Vec<_>>(),
            vec![&format!("{B}#agent-1")]
        );
        assert!(take_page_storage_at(&dir, A).is_empty());
        assert!(!take_page_storage_at(&dir, B).is_empty());
        assert!(!dir.join(MCP_CONFIG_FILE).exists());

        // The last one leaves no current server at all.
        let removed = remove_server_at(&dir, B).unwrap();
        assert_eq!(removed.now_current, None);
        assert_eq!(current_address_at(&dir), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parked_page_storage_comes_back_once_and_only_to_its_own_server() {
        let dir = scratch_dir("park");
        add_server_at(&dir, A, None).unwrap();
        add_server_at(&dir, B, None).unwrap();
        let mut storage = PageStorage::new();
        storage.insert("liaison:desktop:thread-folder:t1".into(), "/work".into());
        storage.insert("not-a-string".into(), serde_json::json!(3));
        assert!(park_page_storage_at(&dir, A, storage).unwrap());
        assert!(take_page_storage_at(&dir, B).is_empty(), "B was handed A's storage");
        let back = take_page_storage_at(&dir, A);
        assert_eq!(back.len(), 1, "only string values are kept");
        assert_eq!(back["liaison:desktop:thread-folder:t1"], "/work");
        assert!(take_page_storage_at(&dir, A).is_empty(), "taken twice");
        // A server nobody saved parks nothing.
        assert!(!park_page_storage_at(&dir, LOCAL, PageStorage::new()).unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_menu_names_a_server_by_its_organisation_else_its_host() {
        assert_eq!(
            display_label(&SavedServer {
                address: A.into(),
                label: Some("Acme".into())
            }),
            "Acme"
        );
        assert_eq!(
            display_label(&SavedServer {
                address: A.into(),
                label: None
            }),
            "liaison.acme.example"
        );
        assert_eq!(
            display_label(&SavedServer {
                address: LOCAL.into(),
                label: Some("  ".into())
            }),
            "localhost:3000"
        );
    }

    #[test]
    fn two_addresses_are_one_server_when_their_origins_match() {
        assert!(same_server(A, &format!("{A}/")));
        assert!(same_server("https://Liaison.Acme.example", A));
        assert!(!same_server(A, B));
        assert!(!same_server("http://localhost:3000", "http://localhost:3001"));
        assert!(!same_server("javascript:alert(1)", "javascript:alert(1)"));
    }

    /// THE PAGE AND THE NOTIFICATION CHANNELS SHARE ONE FILE. The page files the
    /// current server's rotation while a channel files another server's, each
    /// on its own thread. A write that truncated the file before rewriting it,
    /// and a read-modify-write that was not serialised, let one writer read a
    /// half written (or old) map and write it back: the current server's token
    /// went back to the one it had just spent, the next launch presented that
    /// spent token, and the server treated it as a stolen one.
    #[test]
    fn concurrent_rotations_of_two_servers_never_lose_either_token() {
        let dir = scratch_dir("concurrent-rotations");
        add_server_at(&dir, A, None).unwrap();
        add_server_at(&dir, B, None).unwrap();
        switch_current_at(&dir, A).unwrap();
        store_refresh_token_for_at(&dir, A, "rt-a-0").unwrap();
        store_background_refresh_token_at(&dir, B, "rt-b-0").unwrap();

        const ROUNDS: usize = 400;
        let page_dir = dir.clone();
        let page = std::thread::spawn(move || {
            for round in 1..=ROUNDS {
                store_refresh_token_for_at(&page_dir, A, &format!("rt-a-{round}")).unwrap();
                // The page reads its token back before every refresh.
                assert!(
                    refresh_token_for_at(&page_dir, A).is_some(),
                    "the current server's token vanished in round {round}"
                );
            }
        });
        let channel_dir = dir.clone();
        let channel = std::thread::spawn(move || {
            for round in 1..=ROUNDS {
                store_background_refresh_token_at(&channel_dir, B, &format!("rt-b-{round}"))
                    .unwrap();
            }
        });
        page.join().expect("the page's rotations");
        channel.join().expect("the channel's rotations");

        assert_eq!(
            stored_refresh_token_at(&dir, A),
            Some(format!("rt-a-{ROUNDS}")),
            "the current server's last rotation was overwritten"
        );
        assert_eq!(
            stored_refresh_token_at(&dir, B),
            Some(format!("rt-b-{ROUNDS}")),
            "the background server's last rotation was overwritten"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn every_file_the_list_writes_is_readable_by_its_owner_alone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch_dir("modes");
        add_server_at(&dir, A, None).unwrap();
        switch_current_at(&dir, A).unwrap();
        store_refresh_token_for_at(&dir, A, "rt-a").unwrap();
        park_page_storage_at(&dir, A, PageStorage::new()).unwrap();
        for file in [SERVERS_FILE, REFRESH_TOKEN_FILE, WEBVIEW_STORAGE_FILE] {
            assert_eq!(
                fs::metadata(dir.join(file)).unwrap().permissions().mode() & 0o777,
                0o600,
                "{file} is readable by other accounts"
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
