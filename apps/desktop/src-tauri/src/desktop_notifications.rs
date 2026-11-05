// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE REAL OS NOTIFICATION PERMISSION (P1-T6, A6).
//
// The server sends a computer notification to this app only while the app
// says the OS lets it show one (`granted`); otherwise it falls through to a
// browser tab or Web Push. So the answer has to be the system's own.
// `tauri-plugin-notification` cannot give it: on a desktop both of its
// permission commands answer "granted" whatever System Settings says (read
// from its source, 2.5.0 `src/desktop.rs`). The shell asks the system itself.
//
//   macOS    UNUserNotificationCenter: `getNotificationSettings` for the
//            state, `requestAuthorization` for the prompt. Both need a
//            signed .app bundle; a binary run outside one (cargo test, a bare
//            `target/debug/liaison-desktop`) has no notification center at all
//            and touching it raises, so outside a bundle the answer is
//            `not_determined`, never a guess.
//   Windows  no per-app query is wired yet: `granted` (the plugin's toast is
//   Linux    the only path, and the desktop has no permission concept).
//
// The page asks through `notification_os_permission`, asks the OS through
// `request_notification_os_permission`, and hears a change through the
// `NOTIFICATION_PERMISSION_EVENT`, which a watcher thread emits when the
// system setting moves (the user flipping Liaison off in System Settings).
//
// DEBUG BUILDS ONLY: `driver::set_reported_notification_permission` overrides
// what is reported, for the notification matrix (A2). The override and its
// command are compiled out of a release build.

use std::time::Duration;

use tauri::{AppHandle, Emitter, Runtime};

/// The event the page listens on for a changed permission. Its payload is the
/// wire word (`granted` | `denied` | `not_determined`).
pub const NOTIFICATION_PERMISSION_EVENT: &str = "liaison://notification-permission";

/// How often the watcher reads the system setting.
pub const PERMISSION_WATCH_INTERVAL: Duration = Duration::from_secs(5);

/// The OS permission, in the server's three words (A6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OsPermission {
    Granted,
    Denied,
    NotDetermined,
}

impl OsPermission {
    /// The word the WS hello, the device registration and the page carry.
    pub fn wire(self) -> &'static str {
        match self {
            OsPermission::Granted => "granted",
            OsPermission::Denied => "denied",
            OsPermission::NotDetermined => "not_determined",
        }
    }

    /// The word back to the permission, or None for anything else.
    pub fn from_wire(word: &str) -> Option<OsPermission> {
        match word.trim() {
            "granted" => Some(OsPermission::Granted),
            "denied" => Some(OsPermission::Denied),
            "not_determined" => Some(OsPermission::NotDetermined),
            _ => None,
        }
    }
}

/// UNAuthorizationStatus, raw, to the permission. Authorized (2), provisional
/// (3) and ephemeral (4) all let a notification show; denied (1) does not;
/// not determined (0) and anything a later OS adds are not a yes.
pub fn from_authorization_status(raw: isize) -> OsPermission {
    match raw {
        2..=4 => OsPermission::Granted,
        1 => OsPermission::Denied,
        _ => OsPermission::NotDetermined,
    }
}

/// Whether the watcher has something to say: a first reading, or a different one.
pub fn permission_changed(previous: Option<OsPermission>, next: OsPermission) -> bool {
    previous != Some(next)
}

/// Whether this executable runs from inside a macOS `.app` bundle, the only
/// place UNUserNotificationCenter exists.
pub fn is_inside_app_bundle(executable: &std::path::Path) -> bool {
    executable
        .to_string_lossy()
        .contains(".app/Contents/MacOS/")
}

#[cfg(debug_assertions)]
static REPORTED_OVERRIDE: std::sync::Mutex<Option<OsPermission>> = std::sync::Mutex::new(None);

// A CLICK OPENS THE ITEM (LIF-18).
//
// The plugin shows a macOS notification through NSUserNotification and never
// reports a click, so on macOS the shell raises it itself through
// UNUserNotificationCenter, with the item's `route` in the request's userInfo,
// and hears the click through the center's delegate (installed once, from
// setup, on the main thread). The click brings the window forward, keeps the
// route in ONE pending slot and emits `NOTIFICATION_CLICK_EVENT`; the page
// takes the route with `take_notification_click`, on the event and once when
// it starts listening, so a click that LAUNCHED the app (no page yet) opens
// its item as soon as the page is up, and a route is delivered once.
//
// Outside a bundle (a dev binary) there is no notification center: the raise
// goes through the plugin as before and `notification_click_support` answers
// false, so the page keeps offering the item itself. Windows and Linux too:
// the plugin's toast and notify-rust there report no activation either.

/// The event a click emits to the page. Its payload is `{ route }`; the page
/// still takes the route through `take_notification_click`, which is what
/// makes a delivery happen once.
pub const NOTIFICATION_CLICK_EVENT: &str = "liaison://notification-click";

/// The userInfo key the route travels under.
pub const ROUTE_KEY: &str = "route";

/// The userInfo key the server a notification came from travels under, when
/// it is not the server the window is on (`server_listeners.rs`).
pub const SERVER_KEY: &str = "server";

/// The event a click on ANOTHER server's notification emits: the window
/// switches to that server (its own switch, which parks the page storage and
/// starts the page again there), and the started page takes the route. Its
/// payload is `{ server }`; the window still asks `notification_click_server`.
pub const NOTIFICATION_SWITCH_EVENT: &str = "liaison://notification-switch";

/// The page's own bound (modules/notifications/open-route.ts MAX_ROUTE_LENGTH).
pub const MAX_ROUTE_LENGTH: usize = 512;

/// The action a plain click on the banner (or its entry in Notification
/// Center) reports: UNNotificationDefaultActionIdentifier.
pub const DEFAULT_ACTION: &str = "com.apple.UNNotificationDefaultActionIdentifier";

/// The route as the shell carries it, or None. The page parses it against its
/// two grammars and ignores anything else; the shell only refuses what is
/// plainly not a route (empty, too long, whitespace or control characters).
pub fn clean_route(raw: Option<&str>) -> Option<String> {
    let route = raw?.trim();
    if route.is_empty()
        || route.len() > MAX_ROUTE_LENGTH
        || !route.chars().all(|c| c.is_ascii_graphic())
    {
        return None;
    }
    Some(route.to_string())
}

/// What groups notifications in Notification Center: the route without its
/// query, so every message of one thread stacks together.
pub fn thread_identifier(route: &str) -> String {
    route.split('?').next().unwrap_or(route).to_string()
}

/// The request identifier: the page's tag (the notification id), so the same
/// notification raised twice replaces itself, or a fresh one.
pub fn request_identifier(tag: &str, fresh: impl FnOnce() -> String) -> String {
    let tag = tag.trim();
    if tag.is_empty() || tag.len() > 256 {
        fresh()
    } else {
        tag.to_string()
    }
}

/// Whether a response is a click that opens the item (not a dismissal or a
/// custom action, which this shell defines none of).
pub fn opens_item(action: &str) -> bool {
    action == DEFAULT_ACTION
}

/// A click the page has not taken yet: its route, and the server it came
/// from when that is not the server the window was on when it was raised.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingClick {
    pub route: String,
    pub server: Option<String>,
}

/// The click the page has not taken yet. One slot: the latest click wins.
static PENDING_CLICK: std::sync::Mutex<Option<PendingClick>> = std::sync::Mutex::new(None);

fn note_click(route: String, server: Option<String>) {
    *PENDING_CLICK.lock().unwrap_or_else(|e| e.into_inner()) = Some(PendingClick { route, server });
}

/// THE ROUTE GOES ONLY TO THE SERVER IT BELONGS TO: a click on the page's own
/// notification (no server) or on one from the server the window is now on is
/// taken; another server's stays pending until the window has switched to it,
/// so B's thread id is never opened against A.
pub fn take_click_for(current: Option<&str>) -> Option<String> {
    let mut slot = PENDING_CLICK.lock().unwrap_or_else(|e| e.into_inner());
    let deliverable = match slot.as_ref() {
        None => false,
        Some(PendingClick { server: None, .. }) => true,
        Some(PendingClick { server: Some(server), .. }) => {
            current.is_some_and(|current| crate::servers::same_server(current, server))
        }
    };
    if deliverable {
        slot.take().map(|click| click.route)
    } else {
        None
    }
}

/// The SAVED server a pending click came from, when the window is not on it:
/// the window switches there, then takes the route.
pub fn click_server_for(list: &crate::servers::ServerList) -> Option<String> {
    let slot = PENDING_CLICK.lock().unwrap_or_else(|e| e.into_inner());
    let server = slot.as_ref()?.server.as_deref()?;
    if list
        .current
        .as_deref()
        .is_some_and(|current| crate::servers::same_server(current, server))
    {
        return None;
    }
    list.servers
        .iter()
        .find(|saved| crate::servers::same_server(&saved.address, server))
        .map(|saved| saved.address.clone())
}

/// Whether a click may bring the window forward (false on a debug background
/// walk). Set once by `install_click_handler`; read by the Windows and Linux
/// click path, which has no delegate to capture it.
static MAY_RAISE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

// ANOTHER SERVER'S NOTIFICATIONS THAT NO CLICK OPENED (the fallback). Where a
// click is not reported (a Windows toast opened later from the Action Center,
// a Linux desktop without actions, an unbundled macOS build), the window,
// when it next comes forward, offers "New in <server>" for every saved server
// it is not on that notified since (`server_notices`); opening one is a click
// on its latest notification (`open_server_notice`). A click, or a switch to
// that server, clears it.

/// The latest unopened notification of one server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerNotice {
    pub server: String,
    pub route: Option<String>,
}

static SERVER_NOTICES: std::sync::Mutex<Vec<ServerNotice>> = std::sync::Mutex::new(Vec::new());

/// Keeps `server`'s latest notification for the fallback (one per server).
pub fn note_server_notice(server: &str, route: Option<String>) {
    let mut notices = SERVER_NOTICES.lock().unwrap_or_else(|e| e.into_inner());
    notices.retain(|notice| !crate::servers::same_server(&notice.server, server));
    notices.push(ServerNotice {
        server: server.to_string(),
        route: clean_route(route.as_deref()),
    });
}

/// Forgets `server`'s notice: it was clicked, opened or switched to.
pub fn forget_server_notices(server: &str) {
    SERVER_NOTICES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|notice| !crate::servers::same_server(&notice.server, server));
}

/// What the window offers: one entry per SAVED server it is not on that has
/// an unopened notification, with the name the banner shows.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct NoticeOffer {
    pub server: String,
    pub label: String,
}

pub fn server_notices_for(list: &crate::servers::ServerList) -> Vec<NoticeOffer> {
    let notices = SERVER_NOTICES.lock().unwrap_or_else(|e| e.into_inner());
    notices
        .iter()
        .filter(|notice| {
            !list
                .current
                .as_deref()
                .is_some_and(|current| crate::servers::same_server(current, &notice.server))
        })
        .filter_map(|notice| {
            let saved = list
                .servers
                .iter()
                .find(|saved| crate::servers::same_server(&saved.address, &notice.server))?;
            Some(NoticeOffer {
                server: saved.address.clone(),
                label: crate::servers::display_label(saved),
            })
        })
        .collect()
}

/// Opens a server's notice as a click on its latest notification: the route
/// waits for that server's page, and the saved address is answered for the
/// window to switch to. None for a server with no notice or not saved.
pub fn open_server_notice_for(list: &crate::servers::ServerList, server: &str) -> Option<String> {
    let offer = server_notices_for(list)
        .into_iter()
        .find(|offer| crate::servers::same_server(&offer.server, server))?;
    let route = {
        let notices = SERVER_NOTICES.lock().unwrap_or_else(|e| e.into_inner());
        notices
            .iter()
            .find(|notice| crate::servers::same_server(&notice.server, server))
            .and_then(|notice| notice.route.clone())
    };
    forget_server_notices(server);
    if let Some(route) = route {
        note_click(route, Some(offer.server.clone()));
    }
    Some(offer.server)
}

fn saved_list<R: Runtime>(app: &AppHandle<R>) -> crate::servers::ServerList {
    crate::sidecar::app_config_dir(app)
        .map(|dir| crate::servers::load_list_at(&dir))
        .unwrap_or_default()
}

/// The fallback banner's entries (see `ServerNotice`).
#[tauri::command]
pub fn server_notices<R: Runtime>(app: AppHandle<R>) -> Vec<NoticeOffer> {
    server_notices_for(&saved_list(&app))
}

/// The banner was clicked: answers the server to switch to.
#[tauri::command]
pub fn open_server_notice<R: Runtime>(app: AppHandle<R>, server: String) -> Option<String> {
    open_server_notice_for(&saved_list(&app), &server)
}

/// The banner was dismissed.
#[tauri::command]
pub fn dismiss_server_notice(server: String) {
    forget_server_notices(&server);
}

/// A response from a Windows toast or a Linux notification that opens the
/// item: a click on its body (XDG names it the `default` action).
pub fn response_opens_item(response: &notify_rust::NotificationResponse) -> bool {
    match response {
        notify_rust::NotificationResponse::Default => true,
        notify_rust::NotificationResponse::Action(key) => key == "default",
        _ => false,
    }
}

/// The AUMID a Windows toast is raised under: the app's identifier once
/// installed (the installer registers it, and only then does a click come
/// back to this process), the system's default for a bare dev binary.
#[cfg(target_os = "windows")]
fn installed_app_id<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.to_string_lossy().to_string();
    let sep = std::path::MAIN_SEPARATOR;
    let dev = dir.ends_with(&format!("{sep}target{sep}debug"))
        || dir.ends_with(&format!("{sep}target{sep}release"));
    (!dev).then(|| app.config().identifier.clone())
}

/// WINDOWS AND LINUX: another server's notification, raised through
/// notify-rust so its click is heard (the plugin's reports none). A plain
/// thread waits for the response; a click on the body is a click that opens
/// the item, the same as the macOS delegate's. True when it was shown.
#[cfg_attr(target_os = "macos", allow(dead_code))]
async fn raise_with_click<R: Runtime>(app: &AppHandle<R>, raise: &Raise) -> bool {
    let mut notification = notify_rust::Notification::new();
    notification
        .summary(&labelled_title(&raise.title, raise.label.as_deref()))
        .body(&raise.body)
        .auto_icon();
    if let Some(name) = sound_name(raise.sound) {
        notification.sound_name(name);
    }
    // XDG reports a body click only for a notification offering `default`.
    #[cfg(all(unix, not(target_os = "macos")))]
    notification.action("default", "Open");
    #[cfg(target_os = "windows")]
    if let Some(id) = installed_app_id(app) {
        notification.app_id(&id);
    }
    let handle = app.clone();
    let route = raise.route.clone();
    let server = raise.server.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || match notification.show() {
        Ok(shown) => {
            let _ = tx.send(true);
            let _ = shown.wait_for_response(move |response: &notify_rust::NotificationResponse| {
                if response_opens_item(response) {
                    let may_raise = MAY_RAISE.load(std::sync::atomic::Ordering::SeqCst);
                    on_click(&handle, route, server, may_raise);
                }
            });
        }
        Err(_) => {
            let _ = tx.send(false);
        }
    });
    rx.await.unwrap_or(false)
}

/// What a click does: the window comes forward (unless a debug background
/// walk forbids it), and the route waits for the page. A click on another
/// server's notification asks the window to switch there first.
fn on_click<R: Runtime>(
    app: &AppHandle<R>,
    route: Option<String>,
    server: Option<String>,
    may_raise: bool,
) {
    if may_raise {
        crate::tray::show_window(app);
    }
    let Some(route) = clean_route(route.as_deref()) else {
        return;
    };
    let server = server.filter(|server| crate::servers::origin_of(server).is_some());
    if let Some(server) = server.as_deref() {
        forget_server_notices(server);
    }
    note_click(route.clone(), server.clone());
    let list = crate::sidecar::app_config_dir(app)
        .map(|dir| crate::servers::load_list_at(&dir))
        .unwrap_or_default();
    match click_server_for(&list) {
        Some(server) => {
            let _ = app.emit(NOTIFICATION_SWITCH_EVENT, serde_json::json!({ "server": server }));
        }
        None => {
            let _ = app.emit(
                NOTIFICATION_CLICK_EVENT,
                serde_json::json!({ "route": route }),
            );
        }
    }
}

/// Installs the click delegate, once, from setup (the main thread, before the
/// app finishes launching, so a click that launched it is delivered). A no op
/// outside a macOS bundle.
pub fn install_click_handler<R: Runtime>(app: &AppHandle<R>, may_raise: bool) {
    MAY_RAISE.store(may_raise, std::sync::atomic::Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        mac::install_delegate(Box::new(move |route, server| {
            on_click(&handle, route, server, may_raise)
        }));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, may_raise);
    }
}

/// Whether a click on a notification this shell raises reaches the page
/// (macOS, bundled, delegate installed). False tells the page to offer the
/// item itself.
#[tauri::command]
pub fn notification_click_support() -> bool {
    #[cfg(target_os = "macos")]
    {
        mac::clicks_installed()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// The route of the last click the page has not taken, taken, when it
/// belongs to the server the window is on (`take_click_for`).
#[tauri::command]
pub fn take_notification_click<R: Runtime>(app: AppHandle<R>) -> Option<String> {
    let current = crate::sidecar::app_config_dir(&app)
        .and_then(|dir| crate::servers::current_address_at(&dir));
    take_click_for(current.as_deref())
}

/// The saved server the last click came from, when the window is not on it:
/// the window switches to it, and its started page takes the route.
#[tauri::command]
pub fn notification_click_server<R: Runtime>(app: AppHandle<R>) -> Option<String> {
    let list = crate::sidecar::app_config_dir(&app)
        .map(|dir| crate::servers::load_list_at(&dir))
        .unwrap_or_default();
    click_server_for(&list)
}

/// THE LABEL a notification carries when this install knows several servers:
/// the name of the server it comes from (its organisation's, else its host).
/// With one server there is nothing to tell apart, and none is added.
pub fn server_label_for(list: &crate::servers::ServerList, server: &str) -> Option<String> {
    if list.servers.len() < 2 {
        return None;
    }
    list.servers
        .iter()
        .find(|saved| crate::servers::same_server(&saved.address, server))
        .map(crate::servers::display_label)
}

/// Where the label goes where a notification has no subtitle (the plugin's
/// notification on Windows and Linux): ahead of the title.
pub fn labelled_title(title: &str, label: Option<&str>) -> String {
    match label.map(str::trim).filter(|label| !label.is_empty()) {
        Some(label) => format!("{label}: {title}"),
        None => title.to_string(),
    }
}

/// What a notification says and where its click goes.
#[derive(Debug, Clone, Default)]
pub struct Raise {
    pub title: String,
    pub body: String,
    pub tag: Option<String>,
    pub route: Option<String>,
    /// The server's name, shown as the subtitle (or ahead of the title).
    pub label: Option<String>,
    /// The server it came from, when the window is not on it: the click
    /// switches there first.
    pub server: Option<String>,
    /// Plays the system's default sound (a direct message or a mention).
    pub sound: bool,
}

/// THE SOUND. A notification with no sound named is SILENT on every
/// platform: UNNotificationContent's `sound` is nil by default, the plugin's
/// NSUserNotification has no `soundName`, and a Windows toast without one is
/// written `<audio silent="true"/>`. So a direct message or a mention names
/// the system's default sound; the user still turns it off for the app in the
/// system's notification settings, which every platform honours.
pub const NOTIFICATION_SOUND_GROUP: &str = "direct";

/// Whether a notification of this group plays a sound: only "direct"
/// (direct messages and mentions), never the rest.
pub fn plays_sound(group: Option<&str>) -> bool {
    group == Some(NOTIFICATION_SOUND_GROUP)
}

/// The default sound's name, as notify-rust (and so the plugin) takes it on
/// this platform, when the notification plays one. macOS's own center is
/// given `UNNotificationSound::defaultSound()` instead (`mac::raise`).
pub fn sound_name(sound: bool) -> Option<&'static str> {
    if !sound {
        return None;
    }
    #[cfg(target_os = "macos")]
    {
        Some("NSUserNotificationDefaultSoundName")
    }
    #[cfg(target_os = "windows")]
    {
        Some("Default")
    }
    // The freedesktop sound naming spec's name for an incoming message.
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Some("message-new-instant")
    }
}

/// Raises a notification. On macOS with the click delegate installed it goes
/// through UNUserNotificationCenter carrying `route` (and the server it came
/// from); otherwise (and if the center refuses) through the plugin. True when
/// one was shown.
pub async fn raise<R: Runtime>(app: &AppHandle<R>, raise: Raise) -> bool {
    // Another server's notification: kept for the fallback banner until a
    // click (or a switch there) clears it, wherever a click may go unheard.
    #[cfg(target_os = "macos")]
    let clicks_heard = mac::clicks_installed();
    #[cfg(not(target_os = "macos"))]
    let clicks_heard = false;
    if let Some(server) = raise.server.as_deref() {
        if !clicks_heard {
            note_server_notice(server, raise.route.clone());
        }
    }
    #[cfg(not(target_os = "macos"))]
    if raise.server.is_some() && raise_with_click(app, &raise).await {
        return true;
    }
    #[cfg(target_os = "macos")]
    if mac::clicks_installed() {
        let id = request_identifier(raise.tag.as_deref().unwrap_or(""), fresh_identifier);
        let route = clean_route(raise.route.as_deref());
        let shown = raise.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        std::thread::spawn(move || {
            let _ = tx.send(mac::raise(
                &shown.title,
                &shown.body,
                shown.label.as_deref(),
                &id,
                route.as_deref(),
                shown.server.as_deref(),
                shown.sound,
            ));
        });
        if rx.await.unwrap_or(false) {
            return true;
        }
    }
    use tauri_plugin_notification::NotificationExt;
    let mut builder = app
        .notification()
        .builder()
        .title(labelled_title(&raise.title, raise.label.as_deref()))
        .body(raise.body);
    if let Some(name) = sound_name(raise.sound) {
        builder = builder.sound(name);
    }
    builder.show().is_ok()
}

/// The page's notification, for the server the window is on. Labelled with
/// that server's name when the install knows several. `sound` is the page's
/// word that it is a direct message or a mention (absent from an older page:
/// silent, as before).
#[tauri::command]
pub async fn raise_notification<R: Runtime>(
    app: AppHandle<R>,
    title: String,
    body: String,
    tag: Option<String>,
    route: Option<String>,
    sound: Option<bool>,
) -> bool {
    let label = crate::sidecar::app_config_dir(&app).and_then(|dir| {
        let list = crate::servers::load_list_at(&dir);
        let current = list.current.clone()?;
        server_label_for(&list, &current)
    });
    raise(
        &app,
        Raise {
            title,
            body,
            tag,
            route,
            label,
            server: None,
            sound: sound == Some(true),
        },
    )
    .await
}

#[cfg(target_os = "macos")]
fn fresh_identifier() -> String {
    let mut bytes = [0u8; 8];
    let _ = getrandom::fill(&mut bytes);
    format!(
        "n.{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}

/// What is reported: the debug override when one is set (debug builds only),
/// else the system's answer.
pub fn reported(real: OsPermission) -> OsPermission {
    #[cfg(debug_assertions)]
    if let Some(forced) = *REPORTED_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()) {
        return forced;
    }
    real
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{from_authorization_status, OsPermission};
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::NSError;
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNNotificationSettings, UNUserNotificationCenter,
    };
    use std::ptr::NonNull;
    use std::sync::mpsc;
    use std::time::Duration;

    const ANSWER_TIMEOUT: Duration = Duration::from_secs(3);
    /// The prompt waits on a person.
    const PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

    fn bundled() -> bool {
        std::env::current_exe()
            .map(|path| super::is_inside_app_bundle(&path))
            .unwrap_or(false)
    }

    /// Blocking: call it off the main thread (the completion handler runs on
    /// a queue of the system's).
    pub fn query() -> OsPermission {
        if !bundled() {
            return OsPermission::NotDetermined;
        }
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let (tx, rx) = mpsc::channel::<isize>();
        let block = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            // SAFETY: the system hands a valid settings object for the call.
            let status = unsafe { settings.as_ref() }.authorizationStatus();
            let _ = tx.send(status.0);
        });
        center.getNotificationSettingsWithCompletionHandler(&block);
        rx.recv_timeout(ANSWER_TIMEOUT)
            .map(from_authorization_status)
            .unwrap_or(OsPermission::NotDetermined)
    }

    /// Asks the system (the prompt shows once; afterwards it answers at once),
    /// then reads the state back. Blocking, like `query`.
    pub fn request() -> OsPermission {
        if !bundled() {
            return OsPermission::NotDetermined;
        }
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let (tx, rx) = mpsc::channel::<()>();
        let block = RcBlock::new(move |_granted: Bool, _error: *mut NSError| {
            let _ = tx.send(());
        });
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &block,
        );
        let _ = rx.recv_timeout(PROMPT_TIMEOUT);
        query()
    }

    // ---- raising, and hearing the click (LIF-18) ----

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread};
    use objc2_foundation::{NSDictionary, NSObject, NSObjectProtocol, NSString};
    use objc2_user_notifications::{
        UNMutableNotificationContent, UNNotification, UNNotificationPresentationOptions,
        UNNotificationRequest, UNNotificationSound, UNNotificationResponse, UNUserNotificationCenterDelegate,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;

    type ClickHandler = Box<dyn Fn(Option<String>, Option<String>) + Send + Sync>;

    static CLICK_HANDLER: OnceLock<ClickHandler> = OnceLock::new();
    static CLICKS_INSTALLED: AtomicBool = AtomicBool::new(false);

    pub fn clicks_installed() -> bool {
        CLICKS_INSTALLED.load(Ordering::SeqCst)
    }

    /// The string a response carries under `key` in its request's userInfo.
    fn info_of(response: &UNNotificationResponse, key: &str) -> Option<String> {
        let info = response.notification().request().content().userInfo();
        let key = NSString::from_str(key);
        let key: &AnyObject = &key;
        let value = info.objectForKey(key)?;
        value.downcast::<NSString>().ok().map(|s| s.to_string())
    }

    /// The route a response carries, if any.
    fn route_of(response: &UNNotificationResponse) -> Option<String> {
        info_of(response, super::ROUTE_KEY)
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and this class
        // implements no Drop. It holds no state: the handler is a static.
        #[unsafe(super(NSObject))]
        #[name = "LiaisonNotificationCenterDelegate"]
        struct ClickDelegate;

        unsafe impl NSObjectProtocol for ClickDelegate {}

        unsafe impl UNUserNotificationCenterDelegate for ClickDelegate {
            /// A click (or Notification Center entry) the user opened.
            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion_handler: &block2::DynBlock<dyn Fn()>,
            ) {
                if super::opens_item(&response.actionIdentifier().to_string()) {
                    if let Some(handler) = CLICK_HANDLER.get() {
                        handler(route_of(response), info_of(response, super::SERVER_KEY));
                    }
                }
                completion_handler.call(());
            }

            /// With the app in front the system shows nothing unless told
            /// to: a banner (and its sound, when it has one), as the plugin's
            /// notification showed.
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion_handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                completion_handler.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }
        }
    );

    impl ClickDelegate {
        fn new() -> Retained<Self> {
            let this = Self::alloc().set_ivars(());
            // SAFETY: NSObject's init on a freshly allocated instance.
            unsafe { msg_send![super(this), init] }
        }
    }

    /// Installs the delegate once. Outside a bundle the center does not
    /// exist, so nothing is installed and raising stays with the plugin.
    pub fn install_delegate(handler: ClickHandler) {
        if !bundled() || CLICK_HANDLER.set(handler).is_err() {
            return;
        }
        let delegate = ClickDelegate::new();
        let center = UNUserNotificationCenter::currentNotificationCenter();
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // The center holds its delegate weakly: this one lives as long as
        // the process.
        std::mem::forget(delegate);
        CLICKS_INSTALLED.store(true, Ordering::SeqCst);
    }

    /// Adds the request and waits for the center's answer. Blocking: call it
    /// off the main thread. False when the center refused it (no permission,
    /// an error), so the caller can fall back to the plugin.
    pub fn raise(
        title: &str,
        body: &str,
        subtitle: Option<&str>,
        id: &str,
        route: Option<&str>,
        server: Option<&str>,
        sound: bool,
    ) -> bool {
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        // Without it the banner is silent: the content's sound is nil by
        // default, whatever the Sound authorization and the delegate's
        // presentation options allow.
        if sound {
            content.setSound(Some(&UNNotificationSound::defaultSound()));
        }
        if let Some(subtitle) = subtitle {
            content.setSubtitle(&NSString::from_str(subtitle));
        }
        content.setBody(&NSString::from_str(body));
        if let Some(route) = route {
            // Grouped per server too: two servers' thread ids never share a stack.
            let group = match server {
                Some(server) => format!("{server}|{}", super::thread_identifier(route)),
                None => super::thread_identifier(route),
            };
            content.setThreadIdentifier(&NSString::from_str(&group));
            let key = NSString::from_str(super::ROUTE_KEY);
            let value = NSString::from_str(route);
            let value: &AnyObject = &value;
            let server_key = NSString::from_str(super::SERVER_KEY);
            let server_value = NSString::from_str(server.unwrap_or(""));
            let server_value: &AnyObject = &server_value;
            let info = match server {
                Some(_) => NSDictionary::<NSString, AnyObject>::from_slices(
                    &[&*key, &*server_key],
                    &[value, server_value],
                ),
                None => NSDictionary::<NSString, AnyObject>::from_slices(&[&*key], &[value]),
            };
            // SAFETY: an NSDictionary's type parameters are erased at
            // runtime, and string keys and values are property list types,
            // which is what userInfo has to hold.
            unsafe {
                let info: Retained<NSDictionary> = Retained::cast_unchecked(info);
                content.setUserInfo(&info);
            }
        }
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(id),
            &content,
            None,
        );
        let (tx, rx) = mpsc::channel::<bool>();
        let block = RcBlock::new(move |error: *mut NSError| {
            let _ = tx.send(error.is_null());
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .addNotificationRequest_withCompletionHandler(&request, Some(&block));
        rx.recv_timeout(ANSWER_TIMEOUT).unwrap_or(false)
    }
}

/// The system's answer, blocking (macOS asks the notification center).
pub fn query_os() -> OsPermission {
    #[cfg(target_os = "macos")]
    {
        mac::query()
    }
    #[cfg(not(target_os = "macos"))]
    {
        OsPermission::Granted
    }
}

fn request_os() -> OsPermission {
    #[cfg(target_os = "macos")]
    {
        mac::request()
    }
    #[cfg(not(target_os = "macos"))]
    {
        OsPermission::Granted
    }
}

/// Runs a blocking read on a plain thread and awaits it, so a command never
/// blocks the main thread or an async worker on the system's completion queue.
async fn off_thread(read: fn() -> OsPermission) -> OsPermission {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let _ = tx.send(read());
    });
    rx.await.unwrap_or(OsPermission::NotDetermined)
}

/// The permission as reported, read off the main thread: what the page and
/// the shell's own notification channels (`server_listeners.rs`) tell servers.
pub async fn current_permission() -> OsPermission {
    reported(off_thread(query_os).await)
}

/// The permission the page reports to the server: `granted`, `denied` or
/// `not_determined`.
#[tauri::command]
pub async fn notification_os_permission() -> String {
    current_permission().await.wire().to_string()
}

/// Asks the OS for the permission (from a click in the page), and answers the
/// state that follows.
#[tauri::command]
pub async fn request_notification_os_permission<R: Runtime>(app: AppHandle<R>) -> String {
    let answer = reported(off_thread(request_os).await);
    let _ = app.emit(NOTIFICATION_PERMISSION_EVENT, answer.wire());
    answer.wire().to_string()
}

/// Watches the system setting and tells the page when it moves. Started once,
/// from setup.
pub fn watch<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut last: Option<OsPermission> = None;
        loop {
            let now = reported(query_os());
            if permission_changed(last, now) {
                // The first reading is only remembered: the page reads its
                // own at start, and an event then would be noise.
                if last.is_some() {
                    let _ = handle.emit(NOTIFICATION_PERMISSION_EVENT, now.wire());
                }
                crate::server_listeners::note_permission(now.wire());
                last = Some(now);
            }
            std::thread::sleep(PERMISSION_WATCH_INTERVAL);
        }
    });
}

/// DEBUG BUILDS ONLY (A2): what the app reports from now on, whatever the
/// system says, so the matrix can drive a denied or undecided desktop without
/// a person at System Settings. The page hears it at once. The command that
/// calls it is `driver::set_reported_notification_permission`.
#[cfg(debug_assertions)]
pub fn force_reported<R: Runtime>(app: &AppHandle<R>, forced: OsPermission) {
    *REPORTED_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()) = Some(forced);
    let _ = app.emit(NOTIFICATION_PERMISSION_EVENT, forced.wire());
}

#[cfg(test)]
mod permission_tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn every_authorization_status_maps_to_one_of_three_words() {
        assert_eq!(from_authorization_status(0), OsPermission::NotDetermined);
        assert_eq!(from_authorization_status(1), OsPermission::Denied);
        assert_eq!(from_authorization_status(2), OsPermission::Granted);
        assert_eq!(
            from_authorization_status(3),
            OsPermission::Granted,
            "provisional shows quietly"
        );
        assert_eq!(
            from_authorization_status(4),
            OsPermission::Granted,
            "ephemeral (App Clips)"
        );
        assert_eq!(
            from_authorization_status(9),
            OsPermission::NotDetermined,
            "a status a later OS adds is not a yes"
        );
        assert_eq!(from_authorization_status(-1), OsPermission::NotDetermined);
    }

    #[test]
    fn the_wire_words_are_the_servers_and_round_trip() {
        for permission in [
            OsPermission::Granted,
            OsPermission::Denied,
            OsPermission::NotDetermined,
        ] {
            assert_eq!(OsPermission::from_wire(permission.wire()), Some(permission));
        }
        assert_eq!(OsPermission::NotDetermined.wire(), "not_determined");
        assert_eq!(
            OsPermission::from_wire("default"),
            None,
            "the browser's word is not the wire's"
        );
        assert_eq!(OsPermission::from_wire("yes"), None);
    }

    #[test]
    fn a_change_is_a_first_reading_or_a_different_one() {
        assert!(permission_changed(None, OsPermission::Granted));
        assert!(permission_changed(
            Some(OsPermission::Granted),
            OsPermission::Denied
        ));
        assert!(!permission_changed(
            Some(OsPermission::Denied),
            OsPermission::Denied
        ));
    }

    #[test]
    fn only_a_bundled_executable_has_a_notification_center() {
        assert!(is_inside_app_bundle(Path::new(
            "/Applications/Liaison.app/Contents/MacOS/Liaison"
        )));
        assert!(!is_inside_app_bundle(Path::new(
            "/Users/x/liaison/apps/desktop/src-tauri/target/debug/liaison-desktop"
        )));
    }

    /// Outside a bundle (this test binary) the system is never asked, and the
    /// answer is not a guess: never `granted`.
    #[cfg(target_os = "macos")]
    #[test]
    fn an_unbundled_process_reports_not_determined_not_granted() {
        assert_eq!(query_os(), OsPermission::NotDetermined);
    }

    #[test]
    fn the_debug_override_wins_over_the_system_and_only_in_debug() {
        assert_eq!(reported(OsPermission::Granted), OsPermission::Granted);
        *REPORTED_OVERRIDE.lock().unwrap() = Some(OsPermission::Denied);
        assert_eq!(reported(OsPermission::Granted), OsPermission::Denied);
        *REPORTED_OVERRIDE.lock().unwrap() = None;
        const SOURCE: &str = include_str!("desktop_notifications.rs");
        let shell = &SOURCE[..SOURCE.find("#[cfg(test)]").expect("a test module")];
        let command = shell
            .find("pub fn force_reported")
            .expect("the debug override exists");
        assert!(
            shell[..command]
                .trim_end()
                .ends_with("#[cfg(debug_assertions)]"),
            "the override is not compiled out of a release build"
        );
        assert!(shell.contains("#[cfg(debug_assertions)]\nstatic REPORTED_OVERRIDE"));
    }
}

#[cfg(test)]
mod click_tests {
    use super::*;

    fn take_click() -> Option<PendingClick> {
        PENDING_CLICK
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
    }

    #[test]
    fn a_route_is_carried_as_is_and_only_when_it_looks_like_one() {
        assert_eq!(
            clean_route(Some("thread/t-1?replyRoot=r-1")).as_deref(),
            Some("thread/t-1?replyRoot=r-1")
        );
        assert_eq!(
            clean_route(Some("  attention/kernel/approval_request/a1 ")).as_deref(),
            Some("attention/kernel/approval_request/a1")
        );
        assert_eq!(clean_route(None), None);
        assert_eq!(clean_route(Some("")), None);
        assert_eq!(clean_route(Some("   ")), None);
        assert_eq!(clean_route(Some("thread/a b")), None, "whitespace inside");
        assert_eq!(clean_route(Some("thread/\u{0}x")), None, "a control character");
        assert_eq!(clean_route(Some("thread/é")), None, "not ASCII");
        let long = format!("thread/{}", "a".repeat(MAX_ROUTE_LENGTH));
        assert_eq!(clean_route(Some(&long)), None, "longer than the page accepts");
        let edge = "a".repeat(MAX_ROUTE_LENGTH);
        assert_eq!(clean_route(Some(&edge)).as_deref(), Some(edge.as_str()));
    }

    #[test]
    fn a_threads_messages_group_under_the_thread() {
        assert_eq!(thread_identifier("thread/t-1?replyRoot=r-1"), "thread/t-1");
        assert_eq!(thread_identifier("thread/t-1"), "thread/t-1");
        assert_eq!(
            thread_identifier("attention/projects/task/x"),
            "attention/projects/task/x"
        );
    }

    #[test]
    fn the_request_identifier_is_the_tag_or_a_fresh_one() {
        assert_eq!(request_identifier("attention:e1", || "fresh".into()), "attention:e1");
        assert_eq!(request_identifier("  ", || "fresh".into()), "fresh");
        assert_eq!(request_identifier(&"x".repeat(300), || "fresh".into()), "fresh");
    }

    #[test]
    fn only_the_default_action_opens_the_item() {
        assert!(opens_item("com.apple.UNNotificationDefaultActionIdentifier"));
        assert!(!opens_item("com.apple.UNNotificationDismissActionIdentifier"));
        assert!(!opens_item(""));
    }

    /// One slot, taken once: a click that launched the app waits for the
    /// page, the page's event-driven take and its start-up take never both
    /// deliver it, and the latest click wins.
    #[test]
    fn a_click_waits_for_the_page_and_is_taken_once() {
        let _guard = CLICK_SLOT.lock().unwrap_or_else(|e| e.into_inner());
        let _ = take_click();
        assert_eq!(take_click_for(None), None);
        note_click("thread/a".into(), None);
        note_click("thread/b".into(), None);
        assert_eq!(take_click_for(None).as_deref(), Some("thread/b"));
        assert_eq!(take_click_for(None), None);
    }

    /// The slot is process-wide: the tests that drive it take turns.
    static CLICK_SLOT: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// A click on server B's notification while the window is on A: the
    /// window is asked to switch to B, and the route is NOT handed to A's
    /// page; once B is current, B's page takes it, once.
    #[test]
    fn another_servers_click_switches_first_and_opens_only_on_that_server() {
        let _guard = CLICK_SLOT.lock().unwrap_or_else(|e| e.into_inner());
        let _ = take_click();
        let a = "https://a.example.com".to_string();
        let b = "https://b.example.com".to_string();
        let saved = |current: &str| crate::servers::ServerList {
            current: Some(current.to_string()),
            servers: vec![
                crate::servers::SavedServer { address: a.clone(), label: Some("Acme".into()) },
                crate::servers::SavedServer { address: b.clone(), label: None },
            ],
        };
        note_click("thread/t-b".into(), Some(format!("{b}/")));
        assert_eq!(click_server_for(&saved(&a)).as_deref(), Some(b.as_str()));
        assert_eq!(take_click_for(Some(&a)), None, "never opened on A");
        assert_eq!(click_server_for(&saved(&b)), None, "already there");
        assert_eq!(take_click_for(Some(&b)).as_deref(), Some("thread/t-b"));
        assert_eq!(take_click_for(Some(&b)), None);

        // A server that is not saved is never switched to.
        note_click("thread/x".into(), Some("https://stranger.example".into()));
        assert_eq!(click_server_for(&saved(&a)), None);
        let _ = take_click();
    }

    /// THE FALLBACK: a notification from B whose click nobody heard is
    /// offered as "New in Globex" while the window is on A; opening it is a
    /// click on it (switch to B, B's page takes the route); a click, a
    /// switch there or a dismissal clears it; an unsaved server is never offered.
    #[test]
    fn an_unopened_notification_from_another_server_is_offered_until_opened() {
        let _guard = CLICK_SLOT.lock().unwrap_or_else(|e| e.into_inner());
        let _ = take_click();
        let a = "https://a.example.com".to_string();
        let b = "https://b.example.com".to_string();
        let saved = |current: &str| crate::servers::ServerList {
            current: Some(current.to_string()),
            servers: vec![
                crate::servers::SavedServer { address: a.clone(), label: Some("Acme".into()) },
                crate::servers::SavedServer { address: b.clone(), label: Some("Globex".into()) },
            ],
        };
        forget_server_notices(&a);
        forget_server_notices(&b);
        note_server_notice(&b, Some("thread/old".into()));
        note_server_notice(&format!("{b}/"), Some("thread/new".into()));
        note_server_notice("https://stranger.example", Some("thread/x".into()));
        assert_eq!(
            server_notices_for(&saved(&a)),
            vec![NoticeOffer { server: b.clone(), label: "Globex".into() }],
            "one entry per saved server, the latest notification"
        );
        assert!(server_notices_for(&saved(&b)).is_empty(), "not offered on B itself");

        assert_eq!(open_server_notice_for(&saved(&a), &b).as_deref(), Some(b.as_str()));
        assert!(server_notices_for(&saved(&a)).is_empty(), "opened once");
        assert_eq!(take_click_for(Some(&a)), None, "never opened on A");
        assert_eq!(take_click_for(Some(&b)).as_deref(), Some("thread/new"));

        note_server_notice(&b, Some("thread/again".into()));
        dismiss_server_notice(b.clone());
        assert!(server_notices_for(&saved(&a)).is_empty(), "dismissed");
        assert_eq!(open_server_notice_for(&saved(&a), &b), None);
        forget_server_notices("https://stranger.example");
    }

    #[test]
    fn a_body_click_opens_the_item_and_a_dismissal_does_not() {
        use notify_rust::{CloseReason, NotificationResponse};
        assert!(response_opens_item(&NotificationResponse::Default));
        assert!(response_opens_item(&NotificationResponse::Action("default".into())));
        assert!(!response_opens_item(&NotificationResponse::Action("other".into())));
        assert!(!response_opens_item(&NotificationResponse::Closed(CloseReason::Dismissed)));
    }

    #[test]
    fn a_notification_names_its_server_only_when_there_are_several() {
        let one = crate::servers::ServerList {
            current: Some("https://a.example.com".into()),
            servers: vec![crate::servers::SavedServer {
                address: "https://a.example.com".into(),
                label: Some("Acme".into()),
            }],
        };
        assert_eq!(server_label_for(&one, "https://a.example.com"), None);
        let mut two = one.clone();
        two.servers.push(crate::servers::SavedServer {
            address: "https://b.example.com:8443".into(),
            label: None,
        });
        assert_eq!(server_label_for(&two, "https://a.example.com").as_deref(), Some("Acme"));
        assert_eq!(
            server_label_for(&two, "https://b.example.com:8443").as_deref(),
            Some("b.example.com:8443"),
            "a server that has not said its name is its host"
        );
        assert_eq!(labelled_title("Alice", Some("Acme")), "Acme: Alice");
        assert_eq!(labelled_title("Alice", None), "Alice");
    }

    /// Outside a bundle (this test binary) no delegate is installed, so the
    /// page is told clicks are not reported and keeps its own offer.
    #[test]
    fn an_unbundled_process_reports_no_click_support() {
        assert!(!notification_click_support());
    }

    /// The route travels under the key the delegate reads it back from, and
    /// the delegate answers both callbacks' completion handlers.
    #[test]
    fn the_route_is_written_and_read_under_one_key() {
        const SOURCE: &str = include_str!("desktop_notifications.rs");
        let shell = &SOURCE[..SOURCE.find("#[cfg(test)]").expect("a test module")];
        assert_eq!(ROUTE_KEY, "route");
        assert_eq!(shell.matches("NSString::from_str(super::ROUTE_KEY)").count(), 1);
        assert_eq!(shell.matches("info_of(response, super::ROUTE_KEY)").count(), 1);
        assert_eq!(shell.matches("NSString::from_str(super::SERVER_KEY)").count(), 1);
        assert_eq!(shell.matches("info_of(response, super::SERVER_KEY)").count(), 1);
        assert_eq!(shell.matches("completion_handler.call(").count(), 2);
        assert!(shell.contains("UNNotificationPresentationOptions::Banner"));
    }

    #[test]
    fn only_direct_messages_and_mentions_play_a_sound() {
        assert!(plays_sound(Some("direct")));
        for group in [None, Some("replies"), Some("approvals"), Some("work"), Some("mail"), Some("")] {
            assert!(!plays_sound(group), "{group:?}");
        }
    }

    #[test]
    fn a_sounding_notification_names_the_platforms_default_sound() {
        assert_eq!(sound_name(false), None);
        let name = sound_name(true).expect("a default sound on every desktop platform");
        #[cfg(target_os = "macos")]
        assert_eq!(name, "NSUserNotificationDefaultSoundName");
        #[cfg(target_os = "windows")]
        assert_eq!(name, "Default");
        #[cfg(all(unix, not(target_os = "macos")))]
        assert_eq!(name, "message-new-instant");
    }

    /// Every raising path carries the sound: the notification center's content
    /// (macOS), the notify-rust notification (another server's, Windows and
    /// Linux) and the plugin's fallback.
    #[test]
    fn every_raising_path_sets_the_sound() {
        const SOURCE: &str = include_str!("desktop_notifications.rs");
        let shell = &SOURCE[..SOURCE.find("#[cfg(test)]").expect("a test module")];
        assert!(shell.contains("content.setSound(Some(&UNNotificationSound::defaultSound()))"));
        assert!(shell.contains("notification.sound_name(name);"));
        assert!(shell.contains("builder = builder.sound(name);"));
        assert!(shell.contains("shown.sound,"));
    }
}
