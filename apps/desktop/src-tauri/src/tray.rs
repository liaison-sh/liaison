// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE TRAY (P1-T6, S4, A13): closing the window does not end the app.
//
// The desktop app is the computer's notification channel (A6): while it runs
// and the OS lets it notify, the server sends computer notifications to it and
// nowhere else. An app that quit when its window closed would take that
// channel with it every time somebody tidied their screen. So:
//
//   - the window's close button (and Cmd+W) HIDES the window; the app keeps
//     its WebSocket and keeps notifying;
//   - a tray / menu bar icon brings the window back ("Open Liaison"), checks
//     for updates (updater.rs; the click is handled in main.rs, which serves
//     the macOS app menu's item of the same id), or ends the app ("Quit
//     Liaison", the one way out besides Cmd+Q);
//   - on macOS, while the window is hidden, AND while this computer is an
//     enabled node whatever the window does (minimised, covered, another app
//     in front), the app holds an NSProcessInfo activity (user initiated,
//     idle system sleep still allowed), so App Nap does not throttle the
//     timers that keep its presence alive (A13, A50); WebKit also throttles
//     or suspends a hidden page's timers on its own, so while this computer
//     is an enabled node the webview's background throttling is off (built so
//     at launch, switched by the node watcher after), and otherwise it is
//     throttled, never suspended (review finding 3: off for every user cost
//     the battery of every Mac that is not a node);
//   - a click on the Dock icon brings the window back (main.rs, Reopen).
//
// The decisions are pure functions below; the rest is Tauri calls.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime};

pub const TRAY_ID: &str = "liaison-tray";
pub const OPEN_ITEM_ID: &str = "liaison-tray-open";
pub const QUIT_ITEM_ID: &str = "liaison-tray-quit";
pub const MAIN_WINDOW: &str = "main";

/// The items' words until the page hands the shell its language
/// (`account::set_account_dialog_copy`).
pub const DEFAULT_OPEN_LABEL: &str = "Open Liaison";
pub const DEFAULT_QUIT_LABEL: &str = "Quit Liaison";

/// Set once the icon exists: without it, hiding the window would leave the
/// app with no way back but the Dock (and none at all on Windows or Linux).
static TRAY_READY: AtomicBool = AtomicBool::new(false);
/// Set by "Quit": from then on a close request is a close.
static QUITTING: AtomicBool = AtomicBool::new(false);

/// What a close request on the main window does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseDecision {
    HideToTray,
    Close,
}

/// Hide to the tray when there is a tray to come back from and the app is not
/// on its way out; otherwise let the window close.
pub fn close_decision(tray_ready: bool, quitting: bool) -> CloseDecision {
    if tray_ready && !quitting {
        CloseDecision::HideToTray
    } else {
        CloseDecision::Close
    }
}

/// The activity assertion's next step for a window that just became visible
/// or hidden.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityChange {
    Begin,
    End,
}

/// Whether the activity is wanted: the window is hidden, or this computer is
/// an enabled node (its presence and job heartbeats run on the page's timers).
pub fn activity_wanted(window_visible: bool, node_on: bool) -> bool {
    !window_visible || node_on
}

/// The step from what is held to what is wanted.
pub fn activity_change(held: bool, wanted: bool) -> Option<ActivityChange> {
    match (held, wanted) {
        (false, true) => Some(ActivityChange::Begin),
        (true, false) => Some(ActivityChange::End),
        _ => None,
    }
}

/// The current decision for the main window.
pub fn current_close_decision() -> CloseDecision {
    close_decision(
        TRAY_READY.load(Ordering::SeqCst),
        QUITTING.load(Ordering::SeqCst),
    )
}

#[cfg(target_os = "macos")]
mod activity {
    use objc2::rc::Retained;
    use objc2::runtime::{NSObjectProtocol, ProtocolObject};
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    /// The token NSProcessInfo hands back. It is an NSObject the system owns
    /// and is safe to end from any thread.
    pub struct Token(Retained<ProtocolObject<dyn NSObjectProtocol>>);
    // SAFETY: an activity token is an immutable NSObject; beginActivity and
    // endActivity are documented thread safe.
    unsafe impl Send for Token {}

    pub fn begin() -> Token {
        let reason = NSString::from_str(
            "Liaison keeps its connection (notifications, this computer's node) in the background",
        );
        Token(
            NSProcessInfo::processInfo().beginActivityWithOptions_reason(
                NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
                &reason,
            ),
        )
    }

    pub fn end(token: Token) {
        // SAFETY: the token came from beginActivity on this process.
        unsafe { NSProcessInfo::processInfo().endActivity(&token.0) };
    }
}

#[cfg(target_os = "macos")]
static ACTIVITY: Mutex<Option<activity::Token>> = Mutex::new(None);
#[cfg(not(target_os = "macos"))]
static ACTIVITY: Mutex<Option<()>> = Mutex::new(None);

/// Whether the tray activity is held right now (the smoke and a test read it).
pub fn activity_held() -> bool {
    ACTIVITY.lock().map(|held| held.is_some()).unwrap_or(false)
}

/// What the activity follows: the window's visibility and the node.
static WINDOW_VISIBLE: AtomicBool = AtomicBool::new(true);
static NODE_ON: AtomicBool = AtomicBool::new(false);

fn follow_visibility(window_visible: bool) {
    WINDOW_VISIBLE.store(window_visible, Ordering::SeqCst);
    refresh_activity();
}

/// The node watcher (node.rs) reports whether this computer is an enabled
/// node, at start and on every change.
pub fn follow_node(node_on: bool) {
    NODE_ON.store(node_on, Ordering::SeqCst);
    refresh_activity();
}

fn refresh_activity() {
    let Ok(mut held) = ACTIVITY.lock() else {
        return;
    };
    let wanted = activity_wanted(
        WINDOW_VISIBLE.load(Ordering::SeqCst),
        NODE_ON.load(Ordering::SeqCst),
    );
    match activity_change(held.is_some(), wanted) {
        Some(ActivityChange::Begin) => {
            #[cfg(target_os = "macos")]
            {
                *held = Some(activity::begin());
            }
            #[cfg(not(target_os = "macos"))]
            {
                *held = Some(());
            }
        }
        Some(ActivityChange::End) => {
            #[cfg(target_os = "macos")]
            if let Some(token) = held.take() {
                activity::end(token);
            }
            #[cfg(not(target_os = "macos"))]
            {
                *held = None;
            }
        }
        None => {}
    }
}

/// The main webview's background policy: off while this computer is an
/// enabled node (its presence and job heartbeats run on the page's timers),
/// throttled otherwise. Never suspended: a page hidden since launch would
/// then freeze its notification channel (walk 2026-10-12).
pub fn throttling_policy(node_on: bool) -> tauri::utils::config::BackgroundThrottlingPolicy {
    use tauri::utils::config::BackgroundThrottlingPolicy as P;
    if node_on {
        P::Disabled
    } else {
        P::Throttle
    }
}

/// WKPreferences.inactiveSchedulingPolicy for a policy (WKInactiveSchedulingPolicy).
pub fn inactive_scheduling_policy(
    policy: &tauri::utils::config::BackgroundThrottlingPolicy,
) -> isize {
    use tauri::utils::config::BackgroundThrottlingPolicy as P;
    match policy {
        P::Suspend => 0,
        P::Throttle => 1,
        P::Disabled => 2,
    }
}

/// The policy to apply when the node watcher reads `node_on`, given what it
/// read last (None before its first reading): only on a change.
pub fn throttling_step(
    last: Option<bool>,
    node_on: bool,
) -> Option<tauri::utils::config::BackgroundThrottlingPolicy> {
    (last != Some(node_on)).then(|| throttling_policy(node_on))
}

/// Switches the main webview's background policy at run time. Tauri only
/// sets it when the webview is built (wry writes WKPreferences
/// inactiveSchedulingPolicy at creation), so this writes the same preference
/// on the live WKWebView; WebKit applies a preference change to its page.
/// macOS 14+ only (the selector exists from there); a no-op elsewhere.
pub fn apply_throttling<R: Runtime>(app: &AppHandle<R>, node_on: bool) {
    #[cfg(target_os = "macos")]
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let value = inactive_scheduling_policy(&throttling_policy(node_on));
        let _ = window.with_webview(move |webview| {
            // SAFETY: with_webview runs on the main thread with the live
            // WKWebView; the selectors are checked before they are sent.
            unsafe { set_inactive_scheduling_policy(webview.inner(), value) };
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, node_on);
}

#[cfg(target_os = "macos")]
unsafe fn set_inactive_scheduling_policy(webview: *mut std::ffi::c_void, value: isize) {
    use objc2::runtime::{AnyObject, Sel};
    use objc2::{msg_send, sel};
    let webview = webview as *mut AnyObject;
    if webview.is_null() {
        return;
    }
    let configuration: *mut AnyObject = msg_send![webview, configuration];
    if configuration.is_null() {
        return;
    }
    // The configuration is a copy, but it shares the webview's WKPreferences.
    let preferences: *mut AnyObject = msg_send![configuration, preferences];
    if preferences.is_null() {
        return;
    }
    let setter: Sel = sel!(setInactiveSchedulingPolicy:);
    let supported: bool = msg_send![preferences, respondsToSelector: setter];
    if !supported {
        return;
    }
    let _: () = msg_send![preferences, setInactiveSchedulingPolicy: value];
    // Read back through a fresh configuration copy: the shared preferences
    // object is what the live page's policy is read from.
    let configuration: *mut AnyObject = msg_send![webview, configuration];
    let preferences: *mut AnyObject = msg_send![configuration, preferences];
    let read: isize = msg_send![preferences, inactiveSchedulingPolicy];
    eprintln!("liaison: webview background policy {value} (read back {read})");
}

/// Hides the main window; the app stays in the tray.
pub fn hide_to_tray<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.hide();
    }
    follow_visibility(false);
}

/// Brings the main window back from the tray (or the Dock).
pub fn show_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    follow_visibility(true);
}

/// "Quit": the one deliberate way out. The exit path (main.rs) stops the local
/// work as it always did.
pub fn quit<R: Runtime>(app: &AppHandle<R>) {
    QUITTING.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// The two items, kept so the page's language can relabel them.
pub struct TrayItems<R: Runtime> {
    open: MenuItem<R>,
    quit: MenuItem<R>,
}

/// Builds the icon and its menu. Called once from setup.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, OPEN_ITEM_ID, DEFAULT_OPEN_LABEL, true, None::<&str>)?;
    let check = MenuItem::with_id(
        app,
        crate::updater::CHECK_FOR_UPDATES_ID,
        crate::updater::CHECK_FOR_UPDATES_LABEL,
        true,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, QUIT_ITEM_ID, DEFAULT_QUIT_LABEL, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &check, &quit_item])?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Liaison")
        .menu(&menu)
        .show_menu_on_left_click(true)
        // The update check's click is NOT handled here: a tray's menu
        // handler is an app wide listener, and main.rs's one handler serves
        // the tray and the macOS app menu alike.
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN_ITEM_ID => show_window(app),
            QUIT_ITEM_ID => quit(app),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    app.manage(TrayItems {
        open,
        quit: quit_item,
    });
    TRAY_READY.store(true, Ordering::SeqCst);
    Ok(())
}

/// The items in the page's language.
pub fn relabel<R: Runtime>(app: &AppHandle<R>, open: &str, quit: &str) {
    if let Some(items) = app.try_state::<TrayItems<R>>() {
        let _ = items.open.set_text(open);
        let _ = items.quit.set_text(quit);
    }
}

#[cfg(test)]
mod tray_tests {
    use super::*;

    /// The tray offers the manual update check, between Open and Quit, under
    /// the id main.rs's handler answers (Windows and Linux have no app menu).
    #[test]
    fn the_tray_offers_a_manual_update_check() {
        const SOURCE: &str = include_str!("tray.rs");
        let shell = &SOURCE[..SOURCE.find("#[cfg(test)]").expect("a test module")];
        assert!(shell.contains("Menu::with_items(app, &[&open, &check, &quit_item])"));
        assert!(shell.contains("crate::updater::CHECK_FOR_UPDATES_ID"));
        assert_ne!(crate::updater::CHECK_FOR_UPDATES_ID, OPEN_ITEM_ID);
        assert_ne!(crate::updater::CHECK_FOR_UPDATES_ID, QUIT_ITEM_ID);
    }

    #[test]
    fn closing_the_window_hides_it_while_there_is_a_tray() {
        assert_eq!(close_decision(true, false), CloseDecision::HideToTray);
    }

    #[test]
    fn closing_the_window_closes_it_on_the_way_out_or_without_a_tray() {
        assert_eq!(
            close_decision(true, true),
            CloseDecision::Close,
            "Quit means quit"
        );
        assert_eq!(
            close_decision(false, false),
            CloseDecision::Close,
            "no tray icon: hiding would strand the app"
        );
    }

    #[test]
    fn the_activity_is_held_while_the_window_is_hidden_or_this_computer_is_a_node() {
        assert!(activity_wanted(false, false), "hidden window");
        assert!(activity_wanted(true, true), "visible window, node on");
        assert!(activity_wanted(false, true));
        assert!(!activity_wanted(true, false), "visible window, no node");
        assert_eq!(activity_change(false, true), Some(ActivityChange::Begin));
        assert_eq!(activity_change(true, true), None, "never twice");
        assert_eq!(activity_change(true, false), Some(ActivityChange::End));
        assert_eq!(activity_change(false, false), None);
    }

    #[test]
    fn hiding_showing_and_the_node_take_and_release_the_activity() {
        follow_visibility(false);
        assert!(activity_held());
        follow_visibility(false);
        assert!(activity_held());
        follow_visibility(true);
        assert!(!activity_held());
        // A node on keeps it with the window on screen: an occluded or
        // minimised window is App Nap's to throttle otherwise (walk 1012).
        follow_node(true);
        assert!(activity_held());
        follow_visibility(false);
        follow_visibility(true);
        assert!(activity_held(), "the node still wants it");
        follow_node(false);
        assert!(!activity_held());
    }

    /// The page's timers ARE the node's liveness and the notification
    /// channel's: the WS ping + presence frame every 30 s (server TTL 60 s),
    /// the job heartbeats and lease renewals. WebKit's default policy
    /// SUSPENDS a page hidden since launch (walk 2026-10-12, "Node stays
    /// online in the background": timers frozen 20 min). Review finding 3:
    /// switching the policy off for every user cost the battery of every Mac
    /// that is not a node, so it is off only while this computer is an enabled
    /// node, and otherwise throttled, never suspended.
    #[test]
    fn the_webview_is_unthrottled_only_while_this_computer_is_a_node() {
        use tauri::utils::config::BackgroundThrottlingPolicy as P;
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let windows = conf["app"]["windows"].as_array().expect("windows");
        assert!(!windows.is_empty());
        for window in windows {
            assert_eq!(
                window["backgroundThrottling"], "throttle",
                "a window is built throttled, never suspended; main.rs builds it unthrottled for a node"
            );
        }
        assert_eq!(throttling_policy(true), P::Disabled);
        assert_eq!(throttling_policy(false), P::Throttle);
        // WKInactiveSchedulingPolicy: Suspend 0, Throttle 1, None 2.
        assert_eq!(inactive_scheduling_policy(&P::Suspend), 0);
        assert_eq!(inactive_scheduling_policy(&P::Throttle), 1);
        assert_eq!(inactive_scheduling_policy(&P::Disabled), 2);
        // The watcher applies a policy at its first reading and on every change, never twice.
        assert_eq!(throttling_step(None, false), Some(P::Throttle));
        assert_eq!(throttling_step(None, true), Some(P::Disabled));
        assert_eq!(throttling_step(Some(true), true), None);
        assert_eq!(throttling_step(Some(true), false), Some(P::Throttle));
        assert_eq!(throttling_step(Some(false), true), Some(P::Disabled));
        assert_eq!(throttling_step(Some(false), false), None);
    }
}
