// SPDX-License-Identifier: FSL-1.1-ALv2
//
// LAUNCH AT LOGIN (P1-T6, S4).
//
// The desktop app is the computer's notification channel only while it runs.
// So a release build starts at login by default (a LaunchAgent on macOS, the
// Run key on Windows, an XDG autostart entry on Linux, all through
// `tauri-plugin-autostart`), and Settings > Notifications offers the switch
// that turns it off. The user's choice is kept in a small file beside the
// server list and re-applied at every start, so an app that moved (an update,
// a drag to another folder) re-points its login item.
//
// A DEBUG build never registers itself on its own: a development .app that
// started at every login would be a surprise on the machine that built it. It
// does what the switch says once somebody sets it, under its own login item
// name, so it never touches the release app's.
//
// The plugin's own commands are not granted to the window (no capability):
// the page asks through `get_launch_at_login` / `set_launch_at_login`.

use std::path::Path;

use tauri::{AppHandle, Runtime};
use tauri_plugin_autostart::ManagerExt;

/// The user's choice, when there is one.
pub const LAUNCH_AT_LOGIN_FILE: &str = "liaison-launch-at-login.json";

/// The login item's name: the release app's, or a debug build's own.
pub fn login_item_name(release: bool) -> &'static str {
    if release {
        "Liaison"
    } else {
        "LiaisonDebug"
    }
}

/// What launch at login is when nobody chose: on, in a release build.
pub fn default_enabled(release: bool) -> bool {
    release
}

/// What the switch shows.
pub fn effective(saved: Option<bool>, release: bool) -> bool {
    saved.unwrap_or_else(|| default_enabled(release))
}

/// What to do with the OS login item at start: enable (Some(true)), disable
/// (Some(false)), or leave it alone (None: a debug build nobody configured).
pub fn startup_action(saved: Option<bool>, release: bool) -> Option<bool> {
    match saved {
        Some(choice) => Some(choice),
        None if default_enabled(release) => Some(true),
        None => None,
    }
}

pub fn read_saved_at(dir: &Path) -> Option<bool> {
    let body: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join(LAUNCH_AT_LOGIN_FILE)).ok()?).ok()?;
    body.get("enabled")?.as_bool()
}

pub fn write_saved_at(dir: &Path, enabled: bool) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let body = serde_json::json!({ "enabled": enabled });
    crate::sidecar::write_private(
        &dir.join(LAUNCH_AT_LOGIN_FILE),
        &serde_json::to_vec(&body).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

const RELEASE: bool = !cfg!(debug_assertions);

fn apply<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else if manager.is_enabled().unwrap_or(false) {
        manager.disable()
    } else {
        Ok(())
    };
    result.map_err(|e| e.to_string())
}

/// Re-applies the choice (or the release default) at start. Best effort: a
/// refused login item costs the login item, never the app.
pub fn apply_on_start<R: Runtime>(app: &AppHandle<R>) {
    let saved = crate::sidecar::app_config_dir(app)
        .as_deref()
        .and_then(read_saved_at);
    if let Some(enabled) = startup_action(saved, RELEASE) {
        if let Err(error) = apply(app, enabled) {
            eprintln!("liaison: launch at login could not be set ({error})");
        }
    }
}

/// What the Settings switch shows: the OS login item when it can be read.
#[tauri::command]
pub fn get_launch_at_login<R: Runtime>(app: AppHandle<R>) -> bool {
    if let Ok(on) = app.autolaunch().is_enabled() {
        return on;
    }
    let saved = crate::sidecar::app_config_dir(&app)
        .as_deref()
        .and_then(read_saved_at);
    effective(saved, RELEASE)
}

/// The Settings switch. Keeps the choice and applies it; answers the state.
#[tauri::command]
pub fn set_launch_at_login<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Result<bool, String> {
    let dir = crate::sidecar::app_config_dir(&app).ok_or("no application config directory")?;
    write_saved_at(&dir, enabled)?;
    apply(&app, enabled)?;
    Ok(get_launch_at_login(app))
}

#[cfg(test)]
mod autostart_tests {
    use super::*;
    use crate::servers::scratch_dir;

    #[test]
    fn a_release_build_launches_at_login_by_default() {
        assert!(default_enabled(true));
        assert!(effective(None, true));
        assert_eq!(startup_action(None, true), Some(true));
    }

    #[test]
    fn the_users_choice_wins_and_is_reapplied_at_every_start() {
        assert_eq!(startup_action(Some(false), true), Some(false));
        assert!(!effective(Some(false), true));
        assert_eq!(startup_action(Some(true), false), Some(true));
        assert!(effective(Some(true), false));
    }

    #[test]
    fn a_debug_build_never_registers_itself_on_its_own() {
        assert!(!default_enabled(false));
        assert_eq!(
            startup_action(None, false),
            None,
            "nobody chose: leave the OS alone"
        );
        assert_ne!(
            login_item_name(false),
            login_item_name(true),
            "a debug build never touches the release app's login item"
        );
    }

    #[test]
    fn the_choice_is_kept_on_disk() {
        let dir = scratch_dir("launch-at-login");
        assert_eq!(read_saved_at(&dir), None);
        write_saved_at(&dir, false).unwrap();
        assert_eq!(read_saved_at(&dir), Some(false));
        write_saved_at(&dir, true).unwrap();
        assert_eq!(read_saved_at(&dir), Some(true));
        std::fs::remove_dir_all(&dir).ok();
    }
}
