// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// Some native paths (notification permission, the downloaded-file quarantine
// flag, the identifier migration) are macOS-only, so their helpers are unused
// on the other targets; the Mac build still reports real dead code, and
// scaffold.test.ts demands a warning-free `cargo check` wherever it runs.
#![cfg_attr(
    not(target_os = "macos"),
    allow(dead_code, unused_imports, unused_variables)
)]

/// The commands that move the window between servers, and the two native
/// questions (removing a server, signing out of Claude). No menu.
mod account;
/// The sandboxed frame an installed app's UI runs in (D11).
mod app_frame;
mod app_signing;
mod auth;
/// Launch at login: on by default in a release build, a setting turns it off.
mod autostart;
mod claim_release;
/// The Claude account the local sessions run on, and signing in to it.
mod claude_auth;
/// The REAL OS notification permission (the plugin answers granted whatever
/// the system says), reported to the server and watched for changes.
mod desktop_notifications;
/// The app icon's unread badge: direct messages and mentions (dock, launcher,
/// Windows taskbar overlay).
mod dock_badge;
/// Carrying the per-user data over from the legacy bundle identifier, once.
mod identifier_migration;
/// Opening a file the window fetched (a label, an invoice) in its default
/// application, since the webview cannot open a `blob:` tab.
mod downloaded_file;
/// Opening a path an agent's message named, and never running a program.
mod local_path;
/// The macOS menu bar: the standard menus only (Edit is what makes the
/// clipboard shortcuts work in the webview). No Account menu on any OS.
mod menu_bar;
/// This install as a notification device: its stable id and the receipt
/// credential the server issued it.
mod notification_device;
/// This computer as the user's node: the node credential per server, and the
/// keep-awake assertion while the node is on and the machine is on power.
mod node;
/// Unattended node jobs: level pins and confirmations, each run's own
/// sidecar, its outbox and steering lines (P4 N-D T5, P3).
mod node_job;
/// The node's live runs: one sidecar per live session, up to the cap (P3).
mod node_runs;
// The node's one follow host and the session import call (W3 T07).
mod node_follow;
/// The folders this node advertises: the chosen roots (else the recent
/// folders) and the repositories directly under them (P1-T38).
mod node_folders;
/// D33: "Stop it" for an orphaned Claude process holding a session.
mod orphan_claude;
/// DEBUG BUILDS ONLY: the webview diagnostic sink a driven walk reads. It is
/// not compiled into a release binary at all, so its command cannot be in the
/// release handler list.
#[cfg(debug_assertions)]
mod diagnostics;
/// DEBUG BUILDS ONLY: the DOM driver a walk reaches the page's own controls
/// through, so nothing has to steal the machine's pointer and keyboard. Like
/// `diagnostics` it is not compiled into a release binary at all, so neither
/// its command nor the environment variable it reads exists there.
#[cfg(debug_assertions)]
mod driver;
/// The saved servers, and everything filed under each one.
mod server_listeners;
mod servers;
/// Which permission answers the page may give and which only the shell's own
/// dialog may (D11).
mod permission_gate;
mod sidecar;
/// Following a running sidecar: its boot line, its stderr tail, its exit and
/// its log file.
mod sidecar_watch;
/// The tray icon, close-to-tray, and the activity assertion while hidden.
mod tray;
/// The update checks: at startup, every six hours, and "Check for Updates".
/// Release builds only: the module's own `attach`, `check_on_start` and
/// `check_now` are no-ops on a development build, so no cfg attribute is
/// needed here and the handler arms below stay the only two.
mod updater;
mod verified_apps;

/// Every command a RELEASE build registers. Pinned as a list so a debug only
/// command that leaked into the release arm is a failing test rather than a
/// command shipped to every user.
pub const RELEASE_COMMANDS: [&str; 94] = [
    "start_session",
    "stop_session",
    "cancel_device_approval",
    "send_turn",
    "interrupt_turn",
    "respond_permission",
    "set_permission_mode",
    "call_mcp_tool",
    "platform_info",
    "pick_folder",
    "recent_folders",
    "read_local_file",
    "get_server_address",
    "set_server_address",
    "get_install_salt",
    "store_refresh_token",
    "load_refresh_token",
    "open_oauth_url",
    "open_device_approval_url",
    "open_external_url",
    "switch_server",
    "remove_server",
    "sign_out",
    "set_account_dialog_copy",
    "list_servers",
    "ask_remove_server",
    "confirm_claude_sign_out",
    "note_local_claim",
    "claude_auth_status",
    "claude_auth_login",
    "claude_auth_submit_code",
    "claude_auth_cancel",
    "claude_auth_reopen",
    "claude_auth_note_failure",
    "claude_local_models",
    "open_local_path",
    "open_downloaded_file",
    "notification_os_permission",
    "request_notification_os_permission",
    "raise_notification",
    "set_unread_badge",
    "notification_click_support",
    "take_notification_click",
    "notification_click_server",
    "server_notices",
    "open_server_notice",
    "dismiss_server_notice",
    "store_notification_credential",
    "load_notification_credential",
    "get_launch_at_login",
    "set_launch_at_login",
    "store_node_credential",
    "load_node_credential",
    "get_keep_awake",
    "set_keep_awake",
    "ensure_node_agent_connection",
    "confirm_node_connection",
    "node_level_pins",
    "node_shared_folders",
    "start_node_job",
    "get_node_remote_auto",
    "set_node_remote_auto",
    "stop_node_job",
    "answer_node_job_permission",
    "node_session_write",
    "node_live_sessions",
    "start_node_follow",
    "stop_node_follow",
    "node_import",
    "node_session_outbox",
    "node_session_ack",
    "node_session_acked",
    "node_session_spill",
    "node_job_connection",
    "get_node_root",
    "set_node_root",
    "node_shared_roots",
    "set_node_shared_roots",
    "node_folder_lookup",
    "node_folder_scan",
    "node_folder_share_many",
    "node_folder_remotes",
    "node_search_roots",
    "set_node_search_roots",
    "node_folder_clone",
    "node_folder_share",
    "node_folder_unshare",
    "node_search_root_add",
    "node_search_root_remove",
    "open_privacy_settings",
    "open_folder_in_editor",
    "stop_orphan_claude",
    "check_for_updates",
    "verify_first_party_app",
];

/// What a debug build adds on top.
pub const DEBUG_ONLY_COMMANDS: [&str; 5] = [
    "report_webview_diagnostic",
    "report_driver_result",
    "hide_to_tray",
    "show_window",
    "set_reported_notification_permission",
];

/// The desktop overlay, built by `bun run build:overlay` in apps/desktop and
/// compiled in here. It is INJECTED into apps/web's page as an initialization
/// script rather than served as a frontend of its own: apps/web stays frozen
/// and the desktop's own surfaces render on top of it.
const OVERLAY_BUNDLE: &str = include_str!("../../dist/overlay.js");

/// A dropped link as it is logged: scheme and host only. An `oauth-complete`
/// link carries a one-time code and a connect link a server address, and
/// neither belongs in a log line.
fn redact_link(raw: &str) -> String {
    match url::Url::parse(raw) {
        Ok(parsed) => format!("{}://{}", parsed.scheme(), parsed.host_str().unwrap_or("")),
        Err(_) => "<unparseable>".to_string(),
    }
}

fn main() {
    let builder = tauri::Builder::default();
    // ONE RUNNING COPY, release builds only, and FIRST (the plugin's own
    // documented requirement): a second launch has to be caught before the
    // rest of the shell has set anything up. On Windows and Linux that second
    // launch is how the OS delivers a `liaison://` link to a running app; the
    // plugin's deep-link feature re-reads the arguments into the running
    // copy's deep link plugin, so `on_open_url` below sees them. What is left
    // to do here is bring the window forward, because a link that connects a
    // window nobody can see connects nothing. Not in a debug build: a driven
    // walk runs several copies beside each other on purpose and its background
    // window must never take the machine.
    let builder = if cfg!(debug_assertions) {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                // show() as well: a copy still running with its window HIDDEN
                // (the updater's old exit path hid it first, 2026-09-28)
                // otherwise swallows every later launch, and the user sees
                // nothing at all until the machine restarts.
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
    };
    let builder = builder
        // The document an installed app's UI runs in, on the shell's own
        // scheme (app_frame.rs, D11).
        .register_uri_scheme_protocol(app_frame::APP_FRAME_SCHEME, app_frame::handle)
        // A first-party app's UI bundle the shell verified, by its sha256 only
        // (verified_apps.rs, S13): the one script source the window's policy
        // adds beside its own pages.
        .register_uri_scheme_protocol(verified_apps::APP_SCHEME, verified_apps::handle)
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        // Native OS notifications (S7): the page raises them through the
        // shell's `raise_notification` (desktop_notifications.rs), which
        // shows them through UNUserNotificationCenter on a bundled macOS app
        // (so a click opens the item) and through this plugin otherwise. The
        // window is granted none of the plugin's commands.
        .plugin(tauri_plugin_notification::init())
        // Launch at login (autostart.rs), driven from Rust only: the window
        // is granted none of the plugin's commands.
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name(autostart::login_item_name(!cfg!(debug_assertions)))
                .build(),
        )
        // CLOSE TO THE TRAY (tray.rs): the window's close button hides it,
        // and the app keeps its connection and keeps notifying. Quit (the
        // tray's, or Cmd+Q) still quits.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == tray::MAIN_WINDOW
                    && tray::current_close_decision() == tray::CloseDecision::HideToTray
                {
                    use tauri::Manager;
                    api.prevent_close();
                    tray::hide_to_tray(window.app_handle());
                }
            }
        })
        .manage(sidecar::SidecarSession::default())
        .manage(node_runs::LiveRuns::default())
        .manage(node_job::NodeChatPrompts::default())
        .manage(node_follow::FollowHost::default())
        .manage(node_follow::ImportGate::default())
        .manage(sidecar::SessionFolder::default())
        .manage(sidecar::PendingPermissions::default())
        .manage(sidecar::ShellPermissions::default())
        .manage(sidecar::PickedFolders::default())
        .manage(account::AccountState::default())
        .manage(server_listeners::Listeners::default())
        .manage(claude_auth::ClaudeLogin::default())
        .manage(verified_apps::VerifiedApps::default());
    // THE MACOS MENU BAR: the standard menus and no Account menu, which the
    // app's own Servers and Claude account UI replaced on every OS. Windows
    // and Linux get no menu (Tauri would draw it as a strip in the window).
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu_bar::build);
    // THE MENU CLICKS THE SHELL HANDLES: "Check for Updates" and the View menu's
    // reload items (menu_bar.rs), from the
    // macOS app menu or the tray (a tray's own menu handler is app wide too,
    // so this one listener serves both). Every other item is predefined or
    // the tray's own.
    let builder = builder.on_menu_event(|app, event| {
        if event.id().as_ref() == updater::CHECK_FOR_UPDATES_ID {
            updater::check_now(app.clone());
        } else {
            // View > Reload / Force reload (menu_bar.rs).
            menu_bar::handle_click(app, event.id().as_ref());
        }
    });
    let builder = updater::attach(builder);

    // The two arms differ by ONE command, and the difference is the whole
    // point: `report_webview_diagnostic` is a stderr sink for a driven walk
    // and has no business in a shipped app. `generate_handler!` takes a list
    // literal and no attributes inside it, so the list is written twice and
    // `RELEASE_COMMANDS` plus the test below pin the pair.
    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        sidecar::start_session,
        sidecar::stop_session,
        sidecar::cancel_device_approval,
        sidecar::send_turn,
        sidecar::interrupt_turn,
        sidecar::respond_permission,
        sidecar::set_permission_mode,
        sidecar::call_mcp_tool,
        sidecar::platform_info,
        sidecar::pick_folder,
        sidecar::recent_folders,
        sidecar::read_local_file,
        sidecar::get_server_address,
        account::set_server_address,
        sidecar::get_install_salt,
        sidecar::store_refresh_token,
        sidecar::load_refresh_token,
        sidecar::open_oauth_url,
        sidecar::open_device_approval_url,
        sidecar::open_external_url,
        account::switch_server,
        account::remove_server,
        account::sign_out,
        account::set_account_dialog_copy,
        account::list_servers,
        account::ask_remove_server,
        account::confirm_claude_sign_out,
        claim_release::note_local_claim,
        claude_auth::claude_auth_status,
        claude_auth::claude_auth_login,
        claude_auth::claude_auth_submit_code,
        claude_auth::claude_auth_cancel,
        claude_auth::claude_auth_reopen,
        claude_auth::claude_auth_note_failure,
        claude_auth::claude_local_models,
        local_path::open_local_path,
        downloaded_file::open_downloaded_file,
        desktop_notifications::notification_os_permission,
        desktop_notifications::request_notification_os_permission,
        desktop_notifications::raise_notification,
        dock_badge::set_unread_badge,
        desktop_notifications::notification_click_support,
        desktop_notifications::take_notification_click,
        desktop_notifications::notification_click_server,
        desktop_notifications::server_notices,
        desktop_notifications::open_server_notice,
        desktop_notifications::dismiss_server_notice,
        notification_device::store_notification_credential,
        notification_device::load_notification_credential,
        autostart::get_launch_at_login,
        autostart::set_launch_at_login,
        updater::check_for_updates,
        node::store_node_credential,
        node::load_node_credential,
        node::get_keep_awake,
        node::set_keep_awake,
        node_job::ensure_node_agent_connection,
        node_job::confirm_node_connection,
        node_job::node_level_pins,
        node_folders::node_shared_folders,
        node_job::start_node_job,
        node_job::get_node_remote_auto,
        node_job::set_node_remote_auto,
        node_job::stop_node_job,
        node_job::answer_node_job_permission,
        node_job::node_session_write,
        node_job::node_live_sessions,
        node_follow::start_node_follow,
        node_follow::stop_node_follow,
        node_follow::node_import,
        node_job::node_session_outbox,
        node_job::node_session_ack,
        node_job::node_session_acked,
        node_job::node_session_spill,
        node_job::node_job_connection,
        node_job::get_node_root,
        node_job::set_node_root,
        node_folders::node_shared_roots,
        node_folders::set_node_shared_roots,
        node_folders::node_folder_lookup,
        node_folders::node_folder_scan,
        node_folders::node_folder_share_many,
        node_folders::node_folder_remotes,
        node_folders::node_search_roots,
        node_folders::set_node_search_roots,
        node_folders::node_folder_clone,
        node_folders::node_folder_share,
        node_folders::node_folder_unshare,
        node_folders::node_search_root_add,
        node_folders::node_search_root_remove,
        node_folders::open_privacy_settings,
        node_folders::open_folder_in_editor,
        orphan_claude::stop_orphan_claude,
        verified_apps::verify_first_party_app,
    ]);
    #[cfg(debug_assertions)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        sidecar::start_session,
        sidecar::stop_session,
        sidecar::cancel_device_approval,
        sidecar::send_turn,
        sidecar::interrupt_turn,
        sidecar::respond_permission,
        sidecar::set_permission_mode,
        sidecar::call_mcp_tool,
        sidecar::platform_info,
        sidecar::pick_folder,
        sidecar::recent_folders,
        sidecar::read_local_file,
        sidecar::get_server_address,
        account::set_server_address,
        sidecar::get_install_salt,
        sidecar::store_refresh_token,
        sidecar::load_refresh_token,
        sidecar::open_oauth_url,
        sidecar::open_device_approval_url,
        sidecar::open_external_url,
        account::switch_server,
        account::remove_server,
        account::sign_out,
        account::set_account_dialog_copy,
        account::list_servers,
        account::ask_remove_server,
        account::confirm_claude_sign_out,
        claim_release::note_local_claim,
        claude_auth::claude_auth_status,
        claude_auth::claude_auth_login,
        claude_auth::claude_auth_submit_code,
        claude_auth::claude_auth_cancel,
        claude_auth::claude_auth_reopen,
        claude_auth::claude_auth_note_failure,
        claude_auth::claude_local_models,
        local_path::open_local_path,
        downloaded_file::open_downloaded_file,
        desktop_notifications::notification_os_permission,
        desktop_notifications::request_notification_os_permission,
        desktop_notifications::raise_notification,
        dock_badge::set_unread_badge,
        desktop_notifications::notification_click_support,
        desktop_notifications::take_notification_click,
        desktop_notifications::notification_click_server,
        desktop_notifications::server_notices,
        desktop_notifications::open_server_notice,
        desktop_notifications::dismiss_server_notice,
        notification_device::store_notification_credential,
        notification_device::load_notification_credential,
        autostart::get_launch_at_login,
        autostart::set_launch_at_login,
        updater::check_for_updates,
        node::store_node_credential,
        node::load_node_credential,
        node::get_keep_awake,
        node::set_keep_awake,
        node_job::ensure_node_agent_connection,
        node_job::confirm_node_connection,
        node_job::node_level_pins,
        node_folders::node_shared_folders,
        node_job::start_node_job,
        node_job::get_node_remote_auto,
        node_job::set_node_remote_auto,
        node_job::stop_node_job,
        node_job::answer_node_job_permission,
        node_job::node_session_write,
        node_job::node_live_sessions,
        node_follow::start_node_follow,
        node_follow::stop_node_follow,
        node_follow::node_import,
        node_job::node_session_outbox,
        node_job::node_session_ack,
        node_job::node_session_acked,
        node_job::node_session_spill,
        node_job::node_job_connection,
        node_job::get_node_root,
        node_job::set_node_root,
        node_folders::node_shared_roots,
        node_folders::set_node_shared_roots,
        node_folders::node_folder_lookup,
        node_folders::node_folder_scan,
        node_folders::node_folder_share_many,
        node_folders::node_folder_remotes,
        node_folders::node_search_roots,
        node_folders::set_node_search_roots,
        node_folders::node_folder_clone,
        node_folders::node_folder_share,
        node_folders::node_folder_unshare,
        node_folders::node_search_root_add,
        node_folders::node_search_root_remove,
        node_folders::open_privacy_settings,
        node_folders::open_folder_in_editor,
        orphan_claude::stop_orphan_claude,
        verified_apps::verify_first_party_app,
        diagnostics::report_webview_diagnostic,
        driver::report_driver_result,
        driver::hide_to_tray,
        driver::show_window,
        driver::set_reported_notification_permission,
    ]);

    builder
        .setup(|app| {
            // FIRST, before anything reads the config directory and before
            // the webview (whose store lives under the bundle identifier) is
            // created: the data of a build that shipped under the legacy
            // identifier is copied across once (identifier_migration.rs).
            identifier_migration::run(app.handle());
            // A clone a crash interrupted left its `.clone-*` folder: removed
            // now, off the start path (node_folders.rs, review m9).
            if let Some(dir) = sidecar::app_config_dir(app.handle()) {
                if let Ok(home) = tauri::Manager::path(app.handle()).home_dir() {
                    std::thread::spawn(move || {
                        let _ = node_folders::clean_stale_clones_at(&dir, &home);
                    });
                }
            }
            // The window is declared in tauri.conf.json with `create: false`
            // and built here instead, because an initialization script can
            // only be attached while the webview is being created and it has
            // to run BEFORE the page's own scripts.
            let window_config = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .expect("tauri.conf.json declares no window");
            // THE WINDOW NEVER TAKES THE MACHINE (debug builds only). With
            // `LIAISON_DEBUG_BACKGROUND=1` the app takes the accessory
            // activation policy (no dock icon, never the active application)
            // and its window is built unfocused and at the bottom of the
            // stack, so a driven walk can run beside somebody working here.
            // Nothing in a background window calls `set_focus`, `show` or
            // `activate` on any path: the second launch handler above focuses
            // in release builds only, and the `oauth-complete` deep link below
            // raises the window only when it is not in background mode.
            #[cfg(debug_assertions)]
            let background = driver::background_mode();
            #[cfg(not(debug_assertions))]
            let background = false;
            #[cfg(all(debug_assertions, target_os = "macos"))]
            if background {
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            // THIS INSTALL'S NOTIFICATION DEVICE ID (notification_device.rs),
            // published BEFORE the overlay so the page has it synchronously
            // for its first WS hello. Derived from the install salt; never in
            // the page's localStorage, which a sign out clears.
            let device_script = sidecar::app_config_dir(app.handle())
                .and_then(|dir| notification_device::device_id_at(&dir).ok())
                .map(|id| notification_device::device_id_script(&id))
                .unwrap_or_default();
            // Background throttling off only while this computer is an
            // enabled node (tray.rs, review finding 3): built so at launch,
            // so a node started hidden is never suspended before the node
            // watcher's first reading; the watcher switches it after.
            let node_on = sidecar::app_config_dir(app.handle())
                .and_then(|dir| node::current_node_at(&dir))
                .is_some_and(|node| node.enabled);
            let mut window =
                tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?
                    .background_throttling(tray::throttling_policy(node_on))
                    .initialization_script(&device_script)
                    .initialization_script(app_frame::app_frame_url_script())
                    .initialization_script(OVERLAY_BUNDLE);
            if background {
                window = window.focused(false).always_on_bottom(true);
            }
            window.build()?;

            // The tray icon the closed window comes back from. Without it the
            // close button closes, as it did before (tray.rs).
            if let Err(error) = tray::install(app.handle()) {
                eprintln!("liaison: no tray icon ({error}); closing the window will close it");
            }
            // Launch at login, as the user chose or the release default.
            autostart::apply_on_start(app.handle());
            // The system's notification setting, watched so a change reaches
            // the server (desktop_notifications.rs).
            desktop_notifications::watch(app.handle());
            // A click on a notification opens its item (LIF-18): the center's
            // delegate, set here on the main thread before launching ends so
            // a click that launched the app is heard too. A background walk's
            // window is not raised by it.
            desktop_notifications::install_click_handler(app.handle(), !background);
            // Keep awake while the node is on and the machine is on power
            // (node.rs): taken again at start for a node that was on.
            node::spawn_watcher(app.handle());

            // The saved servers' names, asked for in the background (the
            // servers UI shows each host until its server answers).
            account::refresh_labels(app.handle().clone());
            // Every signed-in server the window is not on keeps notifying
            // this computer, through a channel of its own (server_listeners.rs).
            server_listeners::sync(app.handle());
            // The Claude account the local sessions use, asked of the CLI in
            // the background (claude_auth.rs).
            claude_auth::refresh_account_in_background(app.handle().clone());

            // DEBUG BUILDS ONLY, and read once, here, before any window can
            // ask: the driven walk's recent folder seed (sidecar.rs). A
            // release build's `debug_seed_folder` answers None whatever the
            // environment says, so this is a no op in a shipped app.
            sidecar::arm_debug_seed();

            // DEBUG BUILDS ONLY: the DOM driver, armed after the window exists
            // because that is what it evaluates scripts in.
            #[cfg(debug_assertions)]
            driver::arm(app.handle());

            // No session starts on its own any more. A local session runs in a
            // folder, as an agent, in a permission mode: all three are the
            // user's to choose, and an environment driven autostart silently
            // decided them before the window could ask.
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                // A background walk's window never takes the machine, whatever
                // link arrives (the flag is false in a release build).
                let may_raise = !background;
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        // A link the OS hands the app is attacker reachable:
                        // any page can navigate to `liaison://...`. Only two
                        // shapes reach the window: a well formed connect link
                        // naming an http(s) server, which the window still
                        // asks about before it is applied, and the
                        // `oauth-complete` link that ends a system-browser
                        // sign-in, which the window redeems only with the
                        // PKCE verifier it holds and a state it minted.
                        let raw = url.to_string();
                        // The LINK is forwarded, not what it carries: the
                        // window applies the same rule again on its side, and
                        // a payload it cannot re-check is a payload it has to
                        // trust.
                        match sidecar::route_deep_link(&raw) {
                            Some(route) => {
                                // A connect link's server joins the saved list
                                // once it answers as a Liaison; switching to it
                                // is still the window's confirmation.
                                if route == sidecar::DeepLinkRoute::Connect {
                                    if let Some(server) = sidecar::validate_deep_link(&raw) {
                                        account::note_connect_link(&handle, server);
                                    }
                                }
                                let _ = tauri::Emitter::emit(
                                    &handle,
                                    sidecar::DEEP_LINK_EVENT,
                                    raw.clone(),
                                );
                                // The user finished signing in in their
                                // browser; the app they came from comes back.
                                if route.raises_window() && may_raise {
                                    use tauri::Manager;
                                    if let Some(window) = handle.get_webview_window("main") {
                                        let _ = window.unminimize();
                                        let _ = window.show();
                                        let _ = window.set_focus();
                                    }
                                }
                            }
                            None => eprintln!("liaison: dropping deep link {}", redact_link(&raw)),
                        }
                    }
                });
            }
            // Last in setup, and it returns immediately: the check runs on the
            // async runtime, so a slow endpoint never delays the window.
            updater::check_on_start(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Liaison desktop shell")
        .run(|app, event| {
            // The sidecar is a child of this process holding the session's
            // bearer token. A window closed without this leaves it running
            // with nothing reading its stdout, so the exit path stops it and
            // waits for it to be gone.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                stop_local_work(app);
            }
            // A click on the Dock icon brings a window closed to the tray back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                tray::show_window(app);
            }
        });
}

/// Everything local that has to end before this process does. The
/// conversation first: the lease the page holds is released while the network
/// is still there (claim_release.rs), then the session's sidecar goes, then a
/// Claude sign in child. Each slot is emptied as it goes, so a second call is
/// a no op. The exit path runs it, and so does the Windows update BEFORE it
/// starts the installer (updater.rs): the installer cannot replace
/// liaison-sidecar.exe while a sidecar started from it is running. Blocking:
/// call it from the event loop or a plain thread, never from the async
/// runtime, which the lease release blocks on.
pub fn stop_local_work<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    claim_release::release_held_on_exit();
    sidecar::stop_managed_session(app);
    // A node job's sidecar holds the agent's token too: every live run goes
    // with the app (the server pauses them, then resumes them on relaunch).
    node_job::stop_node_job(app.clone(), None, None);
    claude_auth::stop_on_exit(app);
}

#[cfg(test)]
mod handler_registration_tests {
    use super::*;

    /// The file registering the commands, read as text: what has to hold is
    /// not that a list exists but that the RELEASE arm and the DEBUG arm say
    /// what they are supposed to say, and only a source read can see both
    /// arms at once (one of them is always compiled out).
    const MAIN_RS: &str = include_str!("main.rs");

    /// The text from a cfg attribute up to the end of the handler list under
    /// it, so an assertion cannot accidentally read the other arm.
    fn handler_arm(attribute: &str) -> &'static str {
        let start = MAIN_RS
            .find(attribute)
            .unwrap_or_else(|| panic!("main.rs has no {attribute} handler arm"));
        let arm = &MAIN_RS[start..];
        let list = arm
            .find("generate_handler!")
            .expect("the arm registers a handler list");
        let end = arm[list..].find("]);").expect("the handler list is closed") + list + 3;
        &arm[..end]
    }

    #[test]
    fn the_release_build_registers_no_webview_diagnostic_command() {
        for command in DEBUG_ONLY_COMMANDS {
            assert!(
                !RELEASE_COMMANDS.contains(&command),
                "{command} is a debug only command and is in the release list"
            );
            assert!(
                !handler_arm("#[cfg(not(debug_assertions))]").contains(command),
                "{command} is registered in the release handler arm"
            );
        }
    }

    /// THE RELEASE BUILD NEVER READS THE BACKGROUND VARIABLE. `background` is
    /// a `false` literal in the release arm and the accessory policy is not
    /// compiled at all, so a shipped app builds exactly the window it always
    /// built whatever the environment says. Only a source read sees both arms.
    #[test]
    fn the_release_build_ignores_the_background_window_variable() {
        let at = MAIN_RS
            .find("#[cfg(not(debug_assertions))]\n            let background")
            .expect("main.rs has a release arm for the background flag");
        let arm = &MAIN_RS[at..];
        let end = arm.find(';').expect("the release arm is a statement") + 1;
        assert!(
            arm[..end].contains("= false"),
            "the release arm reads something: {}",
            &arm[..end]
        );
        // The shell's own source is everything above this test module, which
        // quotes the strings it is looking for.
        let shell = &MAIN_RS[..MAIN_RS
            .find("#[cfg(test)]")
            .expect("this file has a test module")];
        assert!(
            !shell.contains("env::var"),
            "main.rs reads the environment itself instead of asking the debug only module"
        );
        assert!(
            MAIN_RS.contains("#[cfg(all(debug_assertions, target_os = \"macos\"))]"),
            "the accessory policy is not gated on a debug build"
        );
    }

    /// ONE RUNNING COPY, REGISTERED FIRST, RELEASE ONLY. The single instance
    /// plugin only catches a second launch if nothing ran before it, and the
    /// deep link feature is what turns that second launch into a link the
    /// running copy hears: without it a Windows deep link opened a second,
    /// unconnected window. A debug build keeps its several copies for the
    /// driven walk.
    #[test]
    fn the_single_instance_plugin_is_first_and_forwards_deep_links() {
        let shell = &MAIN_RS[..MAIN_RS
            .find("#[cfg(test)]")
            .expect("this file has a test module")];
        let first_plugin = shell.find(".plugin(").expect("a plugin is registered");
        let single = shell
            .find(".plugin(tauri_plugin_single_instance::init(")
            .expect("the single instance plugin is registered");
        assert_eq!(single, first_plugin, "the single instance plugin is not first");
        let callback = &shell[single..];
        let callback = &callback[..callback.find("}))").expect("the callback closes")];
        assert!(callback.contains("set_focus"), "a second launch does not bring the window forward");
        let gate = &shell[..single];
        assert!(
            gate.trim_end().ends_with("if cfg!(debug_assertions) {\n        builder\n    } else {\n        builder"),
            "the single instance plugin is not release only"
        );
        const CARGO_TOML: &str = include_str!("../Cargo.toml");
        let dependency = CARGO_TOML
            .lines()
            .find(|line| line.starts_with("tauri-plugin-single-instance"))
            .expect("Cargo.toml depends on the single instance plugin");
        assert!(
            dependency.contains("\"deep-link\""),
            "the single instance plugin does not forward deep links: {dependency}"
        );
    }

    /// A SECOND LAUNCH SHOWS THE WINDOW, not only focuses it (2026-09-28). The
    /// updater's old exit path hid the window before quitting; a copy left
    /// running that way took every later launch through this callback, and
    /// focusing a hidden window shows nothing. The user saw an app that would
    /// not open until the machine restarted.
    #[test]
    fn a_second_launch_shows_a_hidden_window() {
        let shell = &MAIN_RS[..MAIN_RS
            .find("#[cfg(test)]")
            .expect("this file has a test module")];
        let single = shell
            .find(".plugin(tauri_plugin_single_instance::init(")
            .expect("the single instance plugin is registered");
        let callback = &shell[single..];
        let callback = &callback[..callback.find("}))").expect("the callback closes")];
        let show = callback.find("window.show()").expect("a second launch does not show the window");
        let focus = callback.find("window.set_focus()").expect("focuses");
        assert!(show < focus, "focus before show focuses nothing");
    }

    /// ONE LIST OF WHAT HAS TO STOP BEFORE THE PROCESS GOES, used by the exit
    /// path and by the Windows update (updater.rs), so the two cannot drift:
    /// the update used to leave through std::process::exit, which skips the
    /// exit path, and every sidecar outlived the app.
    #[test]
    fn the_exit_path_and_the_update_stop_the_same_local_work() {
        let shell = &MAIN_RS[..MAIN_RS
            .find("#[cfg(test)]")
            .expect("this file has a test module")];
        let run = &shell[shell.find(".run(|app, event|").expect("the run loop")..];
        let run = &run[..run.find("});").expect("the run loop closes")];
        assert!(run.contains("stop_local_work(app)"));
        let work = &shell[shell.find("pub fn stop_local_work").expect("the shared stop")..];
        let work = &work[..work.find("\n}\n").expect("closed")];
        let lease = work.find("claim_release::release_held_on_exit()").expect("the lease");
        let session = work.find("sidecar::stop_managed_session(app)").expect("the session");
        let login = work.find("claude_auth::stop_on_exit(app)").expect("the sign in");
        assert!(lease < session && session < login);
        const UPDATER_RS: &str = include_str!("updater.rs");
        assert!(UPDATER_RS.contains("crate::stop_local_work(&stopping)"));
    }

    /// The DEBUG ONLY MODULES ARE NOT COMPILED AT ALL in a release build, so
    /// the environment variables they read do not exist there whatever is set.
    /// Only a source read can see that: in a release build the modules are
    /// gone and there is nothing left to assert about.
    #[test]
    fn the_debug_only_modules_are_declared_behind_a_cfg() {
        for module in ["mod diagnostics;", "mod driver;"] {
            let at = MAIN_RS
                .find(module)
                .unwrap_or_else(|| panic!("main.rs does not declare {module}"));
            let before = &MAIN_RS[..at];
            assert!(
                before.trim_end().ends_with("#[cfg(debug_assertions)]"),
                "{module} is not declared behind #[cfg(debug_assertions)]"
            );
        }
    }

    /// A `liaison://connect` link ADDS its server to the saved list (once the
    /// server answers as a Liaison, account.rs), and the link still reaches the
    /// window, where switching to it is the user's confirmation.
    #[test]
    fn a_connect_link_adds_its_server_to_the_list_and_still_reaches_the_window() {
        let shell = &MAIN_RS[..MAIN_RS
            .find("#[cfg(test)]")
            .expect("this file has a test module")];
        let at = shell
            .find("route == sidecar::DeepLinkRoute::Connect")
            .expect("the connect route is told apart");
        let branch = &shell[at..];
        let branch = &branch[..branch.find("raises_window").expect("the route continues")];
        assert!(
            branch.contains("account::note_connect_link(&handle, server)"),
            "a connect link does not add its server to the saved list"
        );
        assert!(
            branch.contains("sidecar::DEEP_LINK_EVENT"),
            "a connect link no longer reaches the window"
        );
    }

    /// NO ACCOUNT MENU ON ANY OS: servers and the Claude account live in the
    /// app's own UI. macOS keeps its standard menu bar (`menu_bar.rs`), set
    /// on macOS only, and the shell handles one menu click: the update check.
    #[test]
    fn no_account_menu_is_built_and_macos_keeps_its_standard_menus() {
        let shell = &MAIN_RS[..MAIN_RS
            .find("#[cfg(test)]")
            .expect("this file has a test module")];
        assert_eq!(shell.matches("on_menu_event").count(), 1, "a second menu click is handled");
        let handler = &shell[shell.find("on_menu_event").unwrap()..];
        let handler = &handler[..handler.find("});").expect("the handler closes")];
        assert!(handler.contains("== updater::CHECK_FOR_UPDATES_ID"));
        assert!(handler.contains("updater::check_now(app.clone())"));
        assert!(!shell.contains("refresh_menu"), "an Account menu is built again");
        assert!(!shell.contains("set_menu"), "a menu is set outside menu_bar.rs");
        assert!(
            !shell.contains("enable_macos_default_menu(false)"),
            "macOS lost its standard menus (and with them Cmd+C and Cmd+V)"
        );
        let at = shell
            .find("builder.menu(menu_bar::build)")
            .expect("macOS sets its standard menu bar");
        assert!(
            shell[..at]
                .trim_end()
                .ends_with("#[cfg(target_os = \"macos\")]\n    let builder ="),
            "the menu bar is not macOS only"
        );
        assert!(shell.contains(".manage(account::AccountState::default())"));
    }

    /// W3 T07: the follow host's and the import's commands ship in both arms.
    #[test]
    fn commands_registered_in_release_and_debug_lists() {
        let release_arm = handler_arm("#[cfg(not(debug_assertions))]");
        let debug_arm = handler_arm("#[cfg(debug_assertions)]\n    let builder");
        for command in ["start_node_follow", "stop_node_follow", "node_import"] {
            assert!(RELEASE_COMMANDS.contains(&command), "{command}");
            let named = format!("node_follow::{command},");
            assert!(release_arm.contains(&named), "{command} is missing from the release arm");
            assert!(debug_arm.contains(&named), "{command} is missing from the debug arm");
        }
        let shell = &MAIN_RS[..MAIN_RS.find("#[cfg(test)]").expect("this file has a test module")];
        assert!(shell.contains(".manage(node_follow::FollowHost::default())"));
        assert!(shell.contains(".manage(node_follow::ImportGate::default())"));
    }

    #[test]
    fn the_debug_build_registers_the_webview_diagnostic_command() {
        let debug_arm = handler_arm("#[cfg(debug_assertions)]\n    let builder");
        for command in DEBUG_ONLY_COMMANDS {
            assert!(
                debug_arm.contains(command),
                "{command} is not in the debug handler arm"
            );
        }
    }

    /// The two arms are written out twice because `generate_handler!` takes a
    /// list literal. This is what stops them drifting: everything the release
    /// build registers is registered by the debug build too, and both arms
    /// match the pinned list.
    #[test]
    fn both_arms_register_every_release_command() {
        let release_arm = handler_arm("#[cfg(not(debug_assertions))]");
        let debug_arm = handler_arm("#[cfg(debug_assertions)]\n    let builder");
        // P3-T09: the backlog dialog is gone; the reattach commands are in.
        assert!(!RELEASE_COMMANDS.contains(&"node_backlog_prompt"));
        for command in ["node_session_write", "node_live_sessions", "node_session_outbox", "node_session_ack", "node_session_acked", "node_session_spill"] {
            assert!(RELEASE_COMMANDS.contains(&command), "{command}");
        }
        for command in RELEASE_COMMANDS {
            let named = [
                format!("sidecar::{command},"),
                format!("account::{command},"),
                format!("claim_release::{command},"),
                format!("claude_auth::{command},"),
                format!("local_path::{command},"),
                format!("downloaded_file::{command},"),
                format!("desktop_notifications::{command},"),
                format!("dock_badge::{command},"),
                format!("notification_device::{command},"),
                format!("autostart::{command},"),
                format!("node::{command},"),
                format!("node_job::{command},"),
                format!("node_follow::{command},"),
                format!("node_folders::{command},"),
                format!("orphan_claude::{command},"),
                format!("updater::{command},"),
                format!("verified_apps::{command},"),
            ];
            assert!(
                named.iter().any(|name| release_arm.contains(name)),
                "{command} is missing from the release arm"
            );
            assert!(
                named.iter().any(|name| debug_arm.contains(name)),
                "{command} is missing from the debug arm"
            );
        }
        // And nothing beyond the pinned set: one entry per line, so the line
        // count of each arm is the size of its list.
        let entries = |arm: &str| {
            arm.lines()
                .filter(|line| line.trim().ends_with(','))
                .count()
        };
        assert_eq!(entries(release_arm), RELEASE_COMMANDS.len());
        assert_eq!(
            entries(debug_arm),
            RELEASE_COMMANDS.len() + DEBUG_ONLY_COMMANDS.len()
        );
    }
}
