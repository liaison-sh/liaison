// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE MACOS MENU BAR: the platform's standard menus and nothing of the app's.
//
// There is no Account menu on any OS: servers and the Claude account live in
// the app's own UI (`account.rs`). What macOS still needs is its standard menu
// bar, and not for looks: a WKWebView gets Cmd+C, Cmd+V, Cmd+X, Cmd+Z and
// Cmd+A from the Edit menu's items, so a window without one cannot copy or
// paste by keyboard. Cmd+Q, Cmd+H and Cmd+W come from the app and Window menus
// the same way.
//
// The menus are the ones Tauri installs by default on macOS (`Menu::default`),
// written out here so they are this app's decision and a test can read them,
// plus ONE item of the app's own: "Check for Updates", under About, where
// macOS apps keep it (updater.rs; its click is handled in main.rs).
// The View menu also carries Reload (Cmd+R) and Force reload (Cmd+Shift+R),
// the two items of the app's own besides "Check for Updates": the page can get
// stuck and a wrapped web app has no browser chrome to reload from. A click
// calls the page's `__LIAISON_RELOAD__` (src/reload.ts), which keeps the
// session: the sign-in is in the shell's store, not in page memory.
// Windows and Linux get no menu at all: Tauri draws one there as a strip inside
// the window, and the app never had one.

#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
#[cfg(target_os = "macos")]
use tauri::{AppHandle, Runtime};

/// The ids of the two reload items; `main.rs` hands their clicks to
/// `handle_click`.
pub const RELOAD_ID: &str = "view-reload";
pub const FORCE_RELOAD_ID: &str = "view-force-reload";
const RELOAD_LABEL: &str = "Reload";
const FORCE_RELOAD_LABEL: &str = "Force reload";

/// The script a reload click evaluates in the window: the page's own entry
/// point (src/reload.ts, which also clears caches on a force reload), or a
/// plain reload when the overlay is not there.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn reload_script(force: bool) -> String {
    format!(
        "(globalThis.__LIAISON_RELOAD__ ?? (() => globalThis.location.reload()))({force});"
    )
}

/// Runs a click on one of the reload items against the main window. Returns
/// whether the id was one of them.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn handle_click<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str) -> bool {
    use tauri::Manager;
    let force = match id {
        RELOAD_ID => false,
        FORCE_RELOAD_ID => true,
        _ => return false,
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(&reload_script(force));
    }
    true
}

/// One item of a standard menu. Every one but `CheckForUpdates` is a
/// PREDEFINED item: macOS wires its shortcut and its action (the responder
/// chain), and the app handles none of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum Standard {
    About,
    /// The app's own item: a manual update check (updater.rs).
    CheckForUpdates,
    /// View > Reload (Cmd+R) and Force reload (Cmd+Shift+R): the app's own.
    Reload,
    ForceReload,
    Services,
    Hide,
    HideOthers,
    Quit,
    CloseWindow,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Fullscreen,
    Minimize,
    Maximize,
    Separator,
}

/// THE MENU BAR, AS DATA: each menu's title and items, in order. The first
/// menu is the application menu, which macOS titles with the app's name.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn macos_menus(app_name: &str) -> Vec<(String, Vec<Standard>)> {
    use Standard::*;
    vec![
        (
            app_name.to_string(),
            vec![About, CheckForUpdates, Separator, Services, Separator, Hide, HideOthers, Separator, Quit],
        ),
        ("File".into(), vec![CloseWindow]),
        (
            "Edit".into(),
            vec![Undo, Redo, Separator, Cut, Copy, Paste, SelectAll],
        ),
        ("View".into(), vec![Reload, ForceReload, Separator, Fullscreen]),
        (
            "Window".into(),
            vec![Minimize, Maximize, Separator, CloseWindow],
        ),
        // Empty on purpose: macOS adds its own search field to a Help menu.
        ("Help".into(), vec![]),
    ]
}

/// Builds the menu bar from `macos_menus`. Set as the app menu on macOS only
/// (`main.rs`).
#[cfg(target_os = "macos")]
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let info = app.package_info();
    let about = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        authors: app.config().bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let menu = Menu::new(app)?;
    for (title, items) in macos_menus(&info.name) {
        let submenu = Submenu::new(app, title, true)?;
        for item in items {
            let item = match item {
                Standard::About => PredefinedMenuItem::about(app, None, Some(about.clone()))?,
                Standard::CheckForUpdates => {
                    let item = MenuItem::with_id(
                        app,
                        crate::updater::CHECK_FOR_UPDATES_ID,
                        crate::updater::CHECK_FOR_UPDATES_LABEL,
                        true,
                        None::<&str>,
                    )?;
                    submenu.append(&item)?;
                    continue;
                }
                Standard::Reload | Standard::ForceReload => {
                    let (id, label, accelerator) = if item == Standard::Reload {
                        (RELOAD_ID, RELOAD_LABEL, "CmdOrCtrl+R")
                    } else {
                        (FORCE_RELOAD_ID, FORCE_RELOAD_LABEL, "CmdOrCtrl+Shift+R")
                    };
                    let item = MenuItem::with_id(app, id, label, true, Some(accelerator))?;
                    submenu.append(&item)?;
                    continue;
                }
                Standard::Services => PredefinedMenuItem::services(app, None)?,
                Standard::Hide => PredefinedMenuItem::hide(app, None)?,
                Standard::HideOthers => PredefinedMenuItem::hide_others(app, None)?,
                Standard::Quit => PredefinedMenuItem::quit(app, None)?,
                Standard::CloseWindow => PredefinedMenuItem::close_window(app, None)?,
                Standard::Undo => PredefinedMenuItem::undo(app, None)?,
                Standard::Redo => PredefinedMenuItem::redo(app, None)?,
                Standard::Cut => PredefinedMenuItem::cut(app, None)?,
                Standard::Copy => PredefinedMenuItem::copy(app, None)?,
                Standard::Paste => PredefinedMenuItem::paste(app, None)?,
                Standard::SelectAll => PredefinedMenuItem::select_all(app, None)?,
                Standard::Fullscreen => PredefinedMenuItem::fullscreen(app, None)?,
                Standard::Minimize => PredefinedMenuItem::minimize(app, None)?,
                Standard::Maximize => PredefinedMenuItem::maximize(app, None)?,
                Standard::Separator => PredefinedMenuItem::separator(app)?,
            };
            submenu.append(&item)?;
        }
        menu.append(&submenu)?;
    }
    Ok(menu)
}

#[cfg(test)]
mod menu_bar_tests {
    use super::*;

    /// NO ACCOUNT MENU, and nothing but the platform's standard menus.
    #[test]
    fn the_macos_menu_bar_has_no_account_menu() {
        let titles: Vec<String> = macos_menus("Liaison").into_iter().map(|(t, _)| t).collect();
        assert_eq!(titles, ["Liaison", "File", "Edit", "View", "Window", "Help"]);
        assert!(!titles.iter().any(|title| title == "Account" || title == "Compte"));
    }

    /// THE EDIT MENU IS WHAT MAKES THE CLIPBOARD WORK in the webview on macOS:
    /// without its items Cmd+C, Cmd+V, Cmd+X, Cmd+Z and Cmd+A do nothing.
    #[test]
    fn the_macos_edit_menu_keeps_every_clipboard_item() {
        let menus = macos_menus("Liaison");
        let (_, edit) = menus
            .iter()
            .find(|(title, _)| title == "Edit")
            .expect("the Edit menu exists");
        for item in [
            Standard::Undo,
            Standard::Redo,
            Standard::Cut,
            Standard::Copy,
            Standard::Paste,
            Standard::SelectAll,
        ] {
            assert!(edit.contains(&item), "the Edit menu lost {item:?}");
        }
        let (_, app_menu) = &menus[0];
        for item in [Standard::About, Standard::Hide, Standard::Quit] {
            assert!(app_menu.contains(&item), "the app menu lost {item:?}");
        }
    }

    /// Every entry of the model is built, so the data above is the menu bar.
    #[test]
    fn the_builder_builds_every_standard_item() {
        const SOURCE: &str = include_str!("menu_bar.rs");
        let shell = &SOURCE[..SOURCE.find("#[cfg(test)]").expect("a test module")];
        for item in [
            "About", "CheckForUpdates", "Services", "Hide", "HideOthers", "Quit", "CloseWindow", "Undo", "Redo",
            "Cut", "Copy", "Paste", "SelectAll", "Fullscreen", "Minimize", "Maximize",
            "Separator",
        ] {
            assert!(
                shell.contains(&format!("Standard::{item} =>")),
                "Standard::{item} is not built"
            );
        }
        assert!(
            shell.contains("Standard::Reload | Standard::ForceReload =>"),
            "the reload items are not built"
        );
        // Nothing but predefined items, and the app's own: the updater's item
        // (its id is the updater's) and the two reload items.
        assert!(!shell.contains("MenuItemBuilder"));
        assert_eq!(shell.matches("with_id(").count(), 2);
        assert!(shell.contains("crate::updater::CHECK_FOR_UPDATES_ID"));
    }

    /// "Check for Updates" sits right under About, in the app menu.
    #[test]
    fn the_app_menu_offers_a_manual_update_check_under_about() {
        let menus = macos_menus("Liaison");
        let (_, app_menu) = &menus[0];
        assert_eq!(&app_menu[..2], &[Standard::About, Standard::CheckForUpdates]);
        let elsewhere = menus[1..]
            .iter()
            .any(|(_, items)| items.contains(&Standard::CheckForUpdates));
        assert!(!elsewhere, "the update check is in one menu only");
    }

    /// THE VIEW MENU HAS RELOAD AND FORCE RELOAD, above Fullscreen, with the
    /// browser's accelerators.
    #[test]
    fn the_view_menu_offers_reload_and_force_reload() {
        let menus = macos_menus("Liaison");
        let (_, view) = menus.iter().find(|(t, _)| t == "View").expect("a View menu");
        assert_eq!(
            view,
            &[Standard::Reload, Standard::ForceReload, Standard::Separator, Standard::Fullscreen]
        );
        const SOURCE: &str = include_str!("menu_bar.rs");
        assert!(SOURCE.contains("\"CmdOrCtrl+R\""));
        assert!(SOURCE.contains("\"CmdOrCtrl+Shift+R\""));
        assert_ne!(RELOAD_ID, FORCE_RELOAD_ID);
    }

    /// The click evaluates the page's own entry point, whose name src/reload.ts
    /// publishes, and says whether it is a force reload.
    #[test]
    fn a_reload_click_calls_the_pages_reload_entry_point() {
        const PAGE: &str = include_str!("../../src/reload.ts");
        assert!(PAGE.contains("\"__LIAISON_RELOAD__\""));
        assert!(reload_script(false).contains("__LIAISON_RELOAD__"));
        assert!(reload_script(false).ends_with("(false);"));
        assert!(reload_script(true).ends_with("(true);"));
    }
}
