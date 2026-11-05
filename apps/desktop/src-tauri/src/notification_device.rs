// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THIS INSTALL AS A NOTIFICATION DEVICE (P1-T6, F1, A7, A44).
//
// The server keys desktop deliveries, receipts and the Settings device list on
// a `deviceId` the app sends in its WS hello. It has to be STABLE for the
// install: a new id on every launch would make every launch a new device, and
// replay (A5) and the device list would both forget the old one.
//
// It is derived from the install salt local sessions already keep
// (`sidecar::install_salt_at`, 32 random bytes, 0600, created once), as
// `d.<first 32 hex of sha256(DOMAIN || salt)>`. A digest, never the salt: the
// salt is what makes this install's folder digests unguessable, and the server
// must not learn it. It does NOT live in the page's localStorage, which a web
// sign out clears key by key (`liaison:*`) and an update that moves the data
// directory loses.
//
// The device's RECEIPT CREDENTIAL (`lnr_...`, receipt writes for this device
// and nothing else) is kept here too, per server, in a 0600 file beside the
// refresh tokens, answered to the page only for the CURRENT server, exactly
// like the refresh token (`servers.rs`).

use std::path::Path;

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Runtime};

use crate::servers::{current_address_at, same_server, NOT_CURRENT_SERVER};

/// What every desktop install id starts with.
pub const DEVICE_ID_PREFIX: &str = "d.";

/// Domain separation: the same salt hashes folders elsewhere.
const DEVICE_ID_DOMAIN: &[u8] = b"liaison-notification-device\0";

/// The page global the id is published under, by an initialization script
/// that runs before the overlay (main.rs), so it exists synchronously when the
/// page builds its first WS hello.
pub const DEVICE_ID_GLOBAL: &str = "__LIAISON_NOTIFICATION_DEVICE_ID__";

/// The per-server credentials file.
pub const NOTIFICATION_CREDENTIALS_FILE: &str = "liaison-notification-credentials.json";

/// Longer than any credential the API issues.
pub const MAX_CREDENTIAL_LEN: usize = 256;

/// The install id, from the install salt.
pub fn device_id_from_salt(salt: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(DEVICE_ID_DOMAIN);
    hasher.update(salt.as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().take(16).map(|b| format!("{b:02x}")).collect();
    format!("{DEVICE_ID_PREFIX}{hex}")
}

/// The install id of the install whose config lives in `dir` (the salt is
/// created there on first use).
pub fn device_id_at(dir: &Path) -> Result<String, String> {
    crate::sidecar::install_salt_at(dir).map(|salt| device_id_from_salt(&salt))
}

/// The initialization script that publishes the id to the page.
pub fn device_id_script(device_id: &str) -> String {
    let literal = serde_json::to_string(device_id).unwrap_or_else(|_| "null".into());
    format!("window.{DEVICE_ID_GLOBAL}={literal};")
}

/// The body of `POST /api/auth/logout` (A44): the device signing out names
/// itself, so the server revokes its receipt credential with the session.
pub fn logout_body(device_id: Option<&str>) -> String {
    match device_id.map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => serde_json::json!({ "deviceId": id }).to_string(),
        None => "{}".to_string(),
    }
}

fn credentials_document(dir: &Path) -> serde_json::Map<String, serde_json::Value> {
    std::fs::read(dir.join(NOTIFICATION_CREDENTIALS_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|body| body.get("servers").and_then(|v| v.as_object()).cloned())
        .unwrap_or_default()
}

fn write_credentials(
    dir: &Path,
    map: serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let body = serde_json::json!({ "servers": map });
    crate::sidecar::write_private(
        &dir.join(NOTIFICATION_CREDENTIALS_FILE),
        &serde_json::to_vec(&body).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// Stores (or, for an empty credential, removes) the CURRENT server's
/// credential. The page names the server it registered with; a server that is
/// not current is refused, so a credential never lands under another server.
pub fn store_credential_for_at(dir: &Path, server: &str, credential: &str) -> Result<(), String> {
    let trimmed = credential.trim();
    if trimmed.len() > MAX_CREDENTIAL_LEN {
        return Err("the credential is longer than any this API issues".into());
    }
    let current = current_address_at(dir).ok_or(NOT_CURRENT_SERVER)?;
    if !same_server(&current, server) {
        return Err(NOT_CURRENT_SERVER.into());
    }
    let mut map = credentials_document(dir);
    if trimmed.is_empty() {
        if map.remove(&current).is_none() {
            return Ok(());
        }
    } else {
        map.insert(current, serde_json::Value::String(trimmed.into()));
    }
    write_credentials(dir, map)
}

/// The credential for `server`, only when it is the current one.
pub fn credential_for_at(dir: &Path, server: &str) -> Option<String> {
    let current = current_address_at(dir)?;
    if !same_server(&current, server) {
        return None;
    }
    credentials_document(dir)
        .get(&current)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|c| !c.is_empty())
}

/// The credential stored for `server`, whoever is current. For the shell's
/// own notification channel to a server the page is not on
/// (`server_listeners.rs`), which posts its receipts itself; never answered
/// to the page.
pub fn stored_credential_at(dir: &Path, address: &str) -> Option<String> {
    credentials_document(dir)
        .get(address)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|c| !c.is_empty())
}

/// Drops one server's credential, whoever is current (a sign out, a removal).
pub fn forget_credential_at(dir: &Path, address: &str) {
    let mut map = credentials_document(dir);
    if map.remove(address).is_some() {
        let _ = write_credentials(dir, map);
    }
}

#[tauri::command]
pub fn store_notification_credential<R: Runtime>(
    app: AppHandle<R>,
    server: String,
    credential: String,
) -> Result<(), String> {
    let dir = crate::sidecar::app_config_dir(&app).ok_or("no application config directory")?;
    store_credential_for_at(&dir, &server, &credential)
}

#[tauri::command]
pub fn load_notification_credential<R: Runtime>(
    app: AppHandle<R>,
    server: String,
) -> Option<String> {
    credential_for_at(&crate::sidecar::app_config_dir(&app)?, &server)
}

#[cfg(test)]
mod notification_device_tests {
    use super::*;
    use crate::servers::{add_server_at, scratch_dir, switch_current_at};

    #[test]
    fn the_device_id_is_stable_prefixed_and_hides_the_salt() {
        let salt = "ab".repeat(32);
        let id = device_id_from_salt(&salt);
        assert_eq!(id, device_id_from_salt(&salt), "one install, one id");
        assert!(id.starts_with("d."), "{id}");
        assert_eq!(id.len(), 2 + 32);
        assert!(id[2..].chars().all(|c| c.is_ascii_hexdigit()));
        assert!(!id.contains(&salt[..16]), "the salt itself never leaves");
        assert_ne!(
            id,
            device_id_from_salt(&"cd".repeat(32)),
            "two installs, two ids"
        );
    }

    #[test]
    fn the_install_id_survives_a_restart_of_the_app() {
        let dir = scratch_dir("notif-device-id");
        let first = device_id_at(&dir).unwrap();
        assert_eq!(device_id_at(&dir).unwrap(), first);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_page_script_publishes_the_id_as_a_string_literal() {
        assert_eq!(
            device_id_script("d.0123"),
            format!("window.{DEVICE_ID_GLOBAL}=\"d.0123\";")
        );
        // Whatever it holds, it stays one literal.
        assert!(device_id_script("x\";alert(1);//").contains("\\\""));
    }

    #[test]
    fn the_logout_body_names_the_device_or_nothing() {
        assert_eq!(logout_body(Some("d.abc")), r#"{"deviceId":"d.abc"}"#);
        assert_eq!(logout_body(Some("  ")), "{}");
        assert_eq!(logout_body(None), "{}");
    }

    #[test]
    fn a_credential_is_kept_for_the_current_server_only() {
        let dir = scratch_dir("notif-credential");
        let a = add_server_at(&dir, "https://a.example.com", None).unwrap();
        let b = add_server_at(&dir, "https://b.example.com", None).unwrap();
        switch_current_at(&dir, &a).unwrap();
        store_credential_for_at(&dir, &a, "lnr_a").unwrap();
        assert_eq!(credential_for_at(&dir, &a).as_deref(), Some("lnr_a"));
        assert_eq!(
            store_credential_for_at(&dir, &b, "lnr_b").unwrap_err(),
            NOT_CURRENT_SERVER,
            "a credential never lands under a server that is not current"
        );
        assert_eq!(credential_for_at(&dir, &b), None);

        switch_current_at(&dir, &b).unwrap();
        assert_eq!(
            credential_for_at(&dir, &a),
            None,
            "only the current server is answered"
        );
        store_credential_for_at(&dir, &b, "lnr_b").unwrap();
        switch_current_at(&dir, &a).unwrap();
        assert_eq!(
            credential_for_at(&dir, &a).as_deref(),
            Some("lnr_a"),
            "per server"
        );

        store_credential_for_at(&dir, &a, "").unwrap();
        assert_eq!(
            credential_for_at(&dir, &a),
            None,
            "an empty credential removes it"
        );
        forget_credential_at(&dir, &b);
        switch_current_at(&dir, &b).unwrap();
        assert_eq!(credential_for_at(&dir, &b), None);

        assert!(store_credential_for_at(&dir, &b, &"x".repeat(MAX_CREDENTIAL_LEN + 1)).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn the_credentials_file_is_readable_by_its_owner_alone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch_dir("notif-credential-mode");
        let a = add_server_at(&dir, "https://a.example.com", None).unwrap();
        switch_current_at(&dir, &a).unwrap();
        store_credential_for_at(&dir, &a, "lnr_a").unwrap();
        let mode = std::fs::metadata(dir.join(NOTIFICATION_CREDENTIALS_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        std::fs::remove_dir_all(&dir).ok();
    }
}
