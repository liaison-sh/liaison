// SPDX-License-Identifier: FSL-1.1-ALv2
//
// NOTIFICATIONS FROM EVERY SAVED SERVER, not only the one the window is on.
//
// The page holds ONE realtime connection, to the current server, and a server
// delivers a computer notification only over a live desktop connection
// (apps/api `notifications/desktop-emitter.ts`): with the window on A, B had no
// connection from this computer and its notifications reached nothing here
// until the user switched to B (whose replay then showed the last fifteen
// minutes at once).
//
// So the SHELL keeps one lightweight channel per signed-in server the window
// is NOT on: no webview, one WebSocket, no page. Per server, in order:
//
//   1. its stored refresh token is rotated through /api/auth/refresh (the same
//      header the page presents, from the app's own origin) and the rotated
//      token is filed back under that server (`servers.rs`
//      `store_background_refresh_token_at`, which refuses the current one);
//   2. the access token buys a single use ticket (/api/auth/ws-ticket);
//   3. /ws?ticket= is opened and the hello says what the page's would: this
//      install's device id, `desktop_app`, the OS permission, and no activity
//      (lastActiveAt 0, no viewing), so the server never thinks the user is
//      reading anything there;
//   4. every `notify` frame is raised natively, labelled with the server's
//      name, its click carrying the server so the window switches there first
//      (`desktop_notifications.rs`), and its receipt is posted with the
//      device's receipt credential for that server;
//   5. a ping and a presence heartbeat every 30 s keep it a live target; a
//      close reconnects with backoff, a refused refresh stops for good (the
//      session is over; the window's own sign in renews it).
//
// NOTHING OF ONE SERVER REACHES ANOTHER, and nothing reaches the page: the
// token, the ticket, the frames and the credential stay in this process, each
// under its own server.
//
// THE REFRESH TOKEN IS SINGLE USE, so the window and a channel never hold it
// at once: before a server becomes current (or is removed, or signed out of)
// its channel is RELEASED (`release`): stopped, after an exchange in flight
// has finished and filed its rotated token, so the page then reads the live
// one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use crate::servers::{self, ServerList};

/// The ping and presence heartbeat interval (the server's presence TTL is 60 s).
pub const HEARTBEAT: Duration = Duration::from_secs(30);
/// How long one HTTP exchange may take.
pub const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a switch waits for an exchange in flight to file its token.
pub const RELEASE_WAIT: Duration = Duration::from_secs(12);
/// The first and the longest wait between two connection attempts.
pub const RETRY_MIN: Duration = Duration::from_secs(5);
pub const RETRY_MAX: Duration = Duration::from_secs(300);

/// The origin the page is served from, which the server's refresh route
/// requires of a caller presenting the refresh header (LIAISON_APP_ORIGINS).
#[cfg(target_os = "windows")]
pub const APP_ORIGIN: &str = "http://tauri.localhost";
#[cfg(not(target_os = "windows"))]
pub const APP_ORIGIN: &str = "tauri://localhost";

/// Every saved server the window is NOT on that has a session here: the ones
/// that get a channel.
pub fn background_servers(list: &ServerList, signed_in: impl Fn(&str) -> bool) -> Vec<String> {
    list.servers
        .iter()
        .map(|server| server.address.clone())
        .filter(|address| list.current.as_deref() != Some(address.as_str()))
        .filter(|address| signed_in(address))
        .collect()
}

/// The same, read from the config directory.
pub fn background_servers_at(dir: &Path) -> Vec<String> {
    background_servers(&servers::load_list_at(dir), |address| {
        servers::stored_refresh_token_at(dir, address).is_some()
    })
}

/// The wait before attempt `failures + 1`: doubling from RETRY_MIN, capped.
pub fn retry_delay(failures: u32) -> Duration {
    let factor = 2u32.saturating_pow(failures.min(16));
    RETRY_MIN.saturating_mul(factor).min(RETRY_MAX)
}

/// What /api/auth/refresh answered.
#[derive(Debug, PartialEq, Eq)]
pub struct Tokens {
    pub access: String,
    pub refresh: Option<String>,
}

pub fn parse_tokens(body: &str) -> Option<Tokens> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Data {
        access_token: String,
        #[serde(default)]
        refresh_token: Option<String>,
    }
    #[derive(Deserialize)]
    struct Envelope {
        data: Data,
    }
    let parsed: Envelope = serde_json::from_str(body).ok()?;
    if parsed.data.access_token.is_empty() {
        return None;
    }
    Some(Tokens {
        access: parsed.data.access_token,
        refresh: parsed.data.refresh_token.filter(|token| !token.is_empty()),
    })
}

/// The ticket /api/auth/ws-ticket answered.
pub fn parse_ticket(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let ticket = value
        .get("data")
        .unwrap_or(&value)
        .get("ticket")?
        .as_str()?;
    (!ticket.is_empty()).then(|| ticket.to_string())
}

/// The realtime URL of a server, with its ticket.
pub fn socket_url(address: &str, ticket: &str) -> Option<String> {
    let mut url = url::Url::parse(address).ok()?;
    let scheme = match url.scheme() {
        "https" => "wss",
        "http" => "ws",
        _ => return None,
    };
    url.set_scheme(scheme).ok()?;
    url.set_path("/ws");
    url.query_pairs_mut().clear().append_pair("ticket", ticket);
    Some(url.to_string())
}

/// The hello: what the page's own would say, minus any activity.
pub fn hello_frame(device_id: Option<&str>, permission: &str) -> String {
    let mut hello = serde_json::json!({
        "type": "hello",
        "clientKind": "desktop_app",
        "lastActiveAt": 0,
        "notificationPermission": permission,
    });
    if let Some(id) = device_id {
        hello["deviceId"] = serde_json::Value::String(id.to_string());
    }
    hello.to_string()
}

pub fn presence_frame(permission: &str) -> String {
    serde_json::json!({
        "type": "presence",
        "lastActiveAt": 0,
        "notificationPermission": permission,
    })
    .to_string()
}

/// A `notify` frame the server sent (apps/api `infra/websocket.ts` NotifyFrame).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyFrame {
    pub notify_id: String,
    #[serde(default)]
    pub notification_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub route: Option<String>,
    /// The notification group (`direct` for a direct message or a mention,
    /// which plays a sound).
    #[serde(default)]
    pub group: Option<String>,
}

/// The frame, when `text` is a notify frame; anything else (entity events,
/// pongs, syncs) is not for this channel.
pub fn parse_notify(text: &str) -> Option<NotifyFrame> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    if value.get("type")?.as_str()? != "notify" {
        return None;
    }
    serde_json::from_value(value).ok()
}

/// The receipt body for one notification this channel raised (or did not).
pub fn receipt_body(notification_id: &str, device_id: &str, shown: bool) -> String {
    let mut body = serde_json::json!({
        "notificationId": notification_id,
        "deviceId": device_id,
        "surface": "desktop",
        "appState": "hidden",
        "outcome": if shown { "shown" } else { "suppressed" },
    });
    if !shown {
        body["reason"] = serde_json::Value::String("raise_failed".into());
    }
    body.to_string()
}

// ---------------------------------------------------------------------------
// The gate between a channel's token exchange and a switch.
// ---------------------------------------------------------------------------

#[derive(Default)]
struct GateState {
    stopped: bool,
    exchanging: bool,
}

/// One channel's stop flag, and whether it is mid exchange. A switch stops
/// the channel and waits out an exchange in flight (`stop_and_wait`); an
/// exchange starts only while the channel is not stopped (`begin_exchange`),
/// so the single use token is never presented by both.
pub struct Gate {
    state: Mutex<GateState>,
    idle: Condvar,
    stop_tx: watch::Sender<bool>,
}

impl Default for Gate {
    fn default() -> Self {
        Gate {
            state: Mutex::new(GateState::default()),
            idle: Condvar::new(),
            stop_tx: watch::channel(false).0,
        }
    }
}

impl Gate {
    pub fn begin_exchange(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.stopped {
            return false;
        }
        state.exchanging = true;
        true
    }

    pub fn end_exchange(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.exchanging = false;
        self.idle.notify_all();
    }

    pub fn stopped(&self) -> bool {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).stopped
    }

    /// Stops the channel without waiting (it is no longer wanted).
    pub fn stop(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.stopped = true;
        let _ = self.stop_tx.send(true);
    }

    /// Stops the channel and waits, at most `limit`, for an exchange in
    /// flight to have filed its token. True when none is left in flight.
    pub fn stop_and_wait(&self, limit: Duration) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.stopped = true;
        let _ = self.stop_tx.send(true);
        let (state, _) = self
            .idle
            .wait_timeout_while(state, limit, |state| state.exchanging)
            .unwrap_or_else(|e| e.into_inner());
        !state.exchanging
    }

    pub fn on_stop(&self) -> watch::Receiver<bool> {
        self.stop_tx.subscribe()
    }
}

// ---------------------------------------------------------------------------
// One channel.
// ---------------------------------------------------------------------------

/// Where a channel files and reads what it needs. The app's own is the config
/// directory; a test points it at a scratch one.
#[derive(Clone)]
pub struct ChannelConfig {
    pub dir: PathBuf,
    pub address: String,
    pub device_id: Option<String>,
    pub origin: String,
}

/// What a channel raises: the frame, from this server. Answers whether a
/// notification was shown.
pub type Raiser = Arc<
    dyn Fn(String, NotifyFrame) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>
        + Send
        + Sync,
>;

/// Why one connection ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Ended {
    /// The channel was stopped (a switch, a removal, the app quitting).
    Stopped,
    /// The server refused the session: nothing to retry with.
    SignedOut,
    /// The connection closed after it had been up: reconnect soon.
    Closed,
    /// It never came up: back off.
    Failed,
}

fn http() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(EXCHANGE_TIMEOUT)
        .build()
        .ok()
}

/// Steps 1 and 2: the rotated session and a ticket, or why not.
async fn ticket(config: &ChannelConfig, gate: &Gate) -> Result<String, Ended> {
    if !gate.begin_exchange() {
        return Err(Ended::Stopped);
    }
    let outcome = exchange(config).await;
    gate.end_exchange();
    let access = outcome?;
    let client = http().ok_or(Ended::Failed)?;
    let response = client
        .post(format!(
            "{}/api/auth/ws-ticket",
            config.address.trim_end_matches('/')
        ))
        .header("Origin", &config.origin)
        .bearer_auth(&access)
        .send()
        .await
        .map_err(|_| Ended::Failed)?;
    match response.status().as_u16() {
        200..=299 => {}
        401 | 403 => return Err(Ended::SignedOut),
        _ => return Err(Ended::Failed),
    }
    let body = response.text().await.map_err(|_| Ended::Failed)?;
    parse_ticket(&body).ok_or(Ended::Failed)
}

/// The refresh exchange, run inside the gate: the rotated token is filed
/// before the gate opens again.
async fn exchange(config: &ChannelConfig) -> Result<String, Ended> {
    let token =
        servers::stored_refresh_token_at(&config.dir, &config.address).ok_or(Ended::SignedOut)?;
    let client = http().ok_or(Ended::Failed)?;
    let response = client
        .post(format!(
            "{}/api/auth/refresh",
            config.address.trim_end_matches('/')
        ))
        .header("Origin", &config.origin)
        .header("X-Liaison-Refresh", &token)
        .header("Content-Type", "application/json")
        .body("{}")
        .send()
        .await
        .map_err(|_| Ended::Failed)?;
    match response.status().as_u16() {
        200..=299 => {}
        401 => return Err(Ended::SignedOut),
        _ => return Err(Ended::Failed),
    }
    let body = response.text().await.map_err(|_| Ended::Failed)?;
    let tokens = parse_tokens(&body).ok_or(Ended::Failed)?;
    if let Some(rotated) = tokens.refresh.as_deref() {
        if let Err(error) =
            servers::store_background_refresh_token_at(&config.dir, &config.address, rotated)
        {
            eprintln!(
                "liaison: the rotated session of {} was not filed ({error})",
                servers::host_of(&config.address)
            );
        }
    }
    Ok(tokens.access)
}

/// Posts a receipt with this device's credential for the server, best effort.
async fn post_receipt(config: &ChannelConfig, notification_id: &str, shown: bool) {
    let (Some(device), Some(credential)) = (
        config.device_id.as_deref(),
        crate::notification_device::stored_credential_at(&config.dir, &config.address),
    ) else {
        return;
    };
    let Some(client) = http() else { return };
    let _ = client
        .post(format!(
            "{}/api/notifications/receipts",
            config.address.trim_end_matches('/')
        ))
        .header("Origin", &config.origin)
        .header("Content-Type", "application/json")
        .bearer_auth(credential)
        .body(receipt_body(notification_id, device, shown))
        .send()
        .await;
}

/// One connection, from the token exchange to its close.
pub async fn connect_once(
    config: &ChannelConfig,
    gate: &Gate,
    permission: &(dyn Fn() -> String + Send + Sync),
    raiser: &Raiser,
) -> Ended {
    let ticket = match ticket(config, gate).await {
        Ok(ticket) => ticket,
        Err(ended) => return ended,
    };
    let Some(url) = socket_url(&config.address, &ticket) else {
        return Ended::Failed;
    };
    let Ok(mut request) = url.into_client_request() else {
        return Ended::Failed;
    };
    if let Ok(origin) = config.origin.parse() {
        request.headers_mut().insert("Origin", origin);
    }
    let mut stop = gate.on_stop();
    if *stop.borrow() {
        return Ended::Stopped;
    }
    let connected = tokio::select! {
        connected = tokio_tungstenite::connect_async(request) => connected,
        _ = stop.changed() => return Ended::Stopped,
    };
    let Ok((socket, _)) = connected else {
        return Ended::Failed;
    };
    let (mut sink, mut stream) = socket.split();
    if sink
        .send(Message::text(hello_frame(
            config.device_id.as_deref(),
            &permission(),
        )))
        .await
        .is_err()
    {
        return Ended::Failed;
    }
    let mut heartbeat = tokio::time::interval(HEARTBEAT);
    heartbeat.tick().await;
    loop {
        tokio::select! {
            _ = stop.changed() => {
                let _ = sink.send(Message::Close(None)).await;
                return Ended::Stopped;
            }
            _ = heartbeat.tick() => {
                let ping = sink.send(Message::text(r#"{"type":"ping"}"#)).await;
                let presence = sink.send(Message::text(presence_frame(&permission()))).await;
                if ping.is_err() || presence.is_err() {
                    return Ended::Closed;
                }
            }
            message = stream.next() => {
                let text = match message {
                    Some(Ok(Message::Text(text))) => text.to_string(),
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return Ended::Closed,
                    Some(Ok(_)) => continue,
                };
                let Some(frame) = parse_notify(&text) else { continue };
                let shown = raiser(config.address.clone(), frame.clone()).await;
                if let Some(id) = frame.notification_id.as_deref() {
                    post_receipt(config, id, shown).await;
                }
            }
        }
    }
}

/// A channel, until it is stopped or its session is refused.
pub async fn run(
    config: ChannelConfig,
    gate: Arc<Gate>,
    permission: Arc<dyn Fn() -> String + Send + Sync>,
    raiser: Raiser,
) {
    let mut failures: u32 = 0;
    loop {
        if gate.stopped() {
            return;
        }
        let wait = match connect_once(&config, &gate, permission.as_ref(), &raiser).await {
            Ended::Stopped | Ended::SignedOut => return,
            Ended::Closed => {
                failures = 0;
                RETRY_MIN
            }
            Ended::Failed => {
                let wait = retry_delay(failures);
                failures = failures.saturating_add(1);
                wait
            }
        };
        let mut stop = gate.on_stop();
        if *stop.borrow() {
            return;
        }
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = stop.changed() => return,
        }
    }
}

// ---------------------------------------------------------------------------
// The app's channels.
// ---------------------------------------------------------------------------

/// Every live channel, by server address.
#[derive(Default)]
pub struct Listeners(Mutex<HashMap<String, Arc<Gate>>>);

/// The OS permission, as last read: the hello and the heartbeat carry it.
static PERMISSION: Mutex<Option<&'static str>> = Mutex::new(None);

fn permission_word() -> String {
    PERMISSION
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .unwrap_or("not_determined")
        .to_string()
}

/// rustls needs ONE process-wide crypto provider for the socket's TLS; reqwest
/// picks its own, the WebSocket client uses the default.
fn install_crypto_provider() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
}

/// What a channel raises: the frame, labelled with its server's name, with the
/// server on the click so the window switches there first.
fn app_raiser<R: Runtime>(app: AppHandle<R>) -> Raiser {
    Arc::new(move |address: String, frame: NotifyFrame| {
        let app = app.clone();
        Box::pin(async move {
            let list = crate::sidecar::app_config_dir(&app)
                .map(|dir| servers::load_list_at(&dir))
                .unwrap_or_default();
            // Raced by a switch: the window is now on this server, whose page
            // has its own connection and raises this frame itself.
            if list.current.as_deref() == Some(address.as_str()) {
                return false;
            }
            let label = crate::desktop_notifications::server_label_for(&list, &address)
                .or_else(|| Some(servers::host_of(&address)));
            crate::desktop_notifications::raise(
                &app,
                crate::desktop_notifications::Raise {
                    title: frame.title,
                    body: frame.body,
                    tag: Some(format!(
                        "{}|{}",
                        servers::host_of(&address),
                        frame.notify_id
                    )),
                    sound: crate::desktop_notifications::plays_sound(frame.group.as_deref()),
                    route: frame.route,
                    label,
                    server: Some(address),
                },
            )
            .await
        })
    })
}

/// Brings the channels in line with the saved list: one per signed-in server
/// the window is not on, none for anything else. Called at start and after
/// every switch, removal and sign out.
pub fn sync<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<Listeners>() else {
        return;
    };
    let Some(dir) = crate::sidecar::app_config_dir(app) else {
        return;
    };
    let wanted = background_servers_at(&dir);
    let device_id = crate::notification_device::device_id_at(&dir).ok();
    let mut live = state.0.lock().unwrap_or_else(|e| e.into_inner());
    live.retain(|address, gate| {
        let keep = wanted.contains(address) && !gate.stopped();
        if !keep {
            gate.stop();
        }
        keep
    });
    let fresh: Vec<String> = wanted
        .into_iter()
        .filter(|address| !live.contains_key(address))
        .collect();
    if fresh.is_empty() {
        return;
    }
    install_crypto_provider();
    for address in fresh {
        let gate = Arc::new(Gate::default());
        live.insert(address.clone(), gate.clone());
        let config = ChannelConfig {
            dir: dir.clone(),
            address,
            device_id: device_id.clone(),
            origin: APP_ORIGIN.to_string(),
        };
        let raiser = app_raiser(app.clone());
        tauri::async_runtime::spawn(async move {
            let word = crate::desktop_notifications::current_permission()
                .await
                .wire();
            *PERMISSION.lock().unwrap_or_else(|e| e.into_inner()) = Some(word);
            run(config, gate, Arc::new(permission_word), raiser).await;
        });
    }
}

/// BEFORE `address` BECOMES CURRENT, or is removed, or signed out of: its
/// channel stops, after an exchange in flight has filed its rotated token, so
/// the page reads the live one (the token is single use).
pub fn release<R: Runtime>(app: &AppHandle<R>, address: &str) {
    let Some(state) = app.try_state::<Listeners>() else {
        return;
    };
    let gate = state
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(address);
    if let Some(gate) = gate {
        if !gate.stop_and_wait(RELEASE_WAIT) {
            eprintln!(
                "liaison: the notification channel of {} was still exchanging its session",
                servers::host_of(address)
            );
        }
    }
}

/// The system setting moved: channels report the new word on their next
/// heartbeat (and the server stops or resumes sending accordingly).
pub fn note_permission(word: &'static str) {
    *PERMISSION.lock().unwrap_or_else(|e| e.into_inner()) = Some(word);
}

#[cfg(test)]
mod server_listener_tests {
    use super::*;
    use crate::servers::{add_server_at, scratch_dir, switch_current_at, SavedServer};

    const A: &str = "https://acme.example.com";
    const B: &str = "https://globex.example.com";

    fn list(current: &str) -> ServerList {
        ServerList {
            current: Some(current.into()),
            servers: vec![
                SavedServer {
                    address: A.into(),
                    label: Some("Acme".into()),
                },
                SavedServer {
                    address: B.into(),
                    label: Some("Globex".into()),
                },
            ],
        }
    }

    /// Two servers, the window on A: B gets the channel. Switched to B: A
    /// does, and B's is gone (its page has the connection now).
    #[test]
    fn every_signed_in_server_but_the_current_one_gets_a_channel() {
        let signed_in = |_: &str| true;
        assert_eq!(background_servers(&list(A), signed_in), vec![B.to_string()]);
        assert_eq!(background_servers(&list(B), signed_in), vec![A.to_string()]);
        assert!(
            background_servers(&list(A), |address| address != B).is_empty(),
            "a server with no session here has nothing to connect with"
        );
    }

    #[test]
    fn the_channels_follow_the_files_across_a_switch() {
        let dir = scratch_dir("listeners-switch");
        let a = add_server_at(&dir, A, None).unwrap();
        let b = add_server_at(&dir, B, None).unwrap();
        switch_current_at(&dir, &a).unwrap();
        servers::store_refresh_token_for_at(&dir, &a, "rt-a").unwrap();
        switch_current_at(&dir, &b).unwrap();
        servers::store_refresh_token_for_at(&dir, &b, "rt-b").unwrap();
        assert_eq!(background_servers_at(&dir), vec![a.clone()]);
        switch_current_at(&dir, &a).unwrap();
        assert_eq!(background_servers_at(&dir), vec![b.clone()]);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The channel files the rotated token under its own server, never over
    /// the page's current one, and never brings a removed server back.
    #[test]
    fn a_rotated_token_is_filed_only_for_a_saved_server_the_window_is_not_on() {
        let dir = scratch_dir("listeners-rotate");
        let a = add_server_at(&dir, A, None).unwrap();
        let b = add_server_at(&dir, B, None).unwrap();
        switch_current_at(&dir, &a).unwrap();
        servers::store_refresh_token_for_at(&dir, &a, "rt-a").unwrap();
        servers::store_background_refresh_token_at(&dir, &b, "rt-b2").unwrap();
        assert_eq!(
            servers::stored_refresh_token_at(&dir, &b).as_deref(),
            Some("rt-b2")
        );
        assert!(servers::store_background_refresh_token_at(&dir, &a, "rt-x").is_err());
        assert_eq!(
            servers::stored_refresh_token_at(&dir, &a).as_deref(),
            Some("rt-a")
        );
        servers::remove_server_at(&dir, &b).unwrap();
        assert!(servers::store_background_refresh_token_at(&dir, &b, "rt-b3").is_err());
        assert_eq!(servers::stored_refresh_token_at(&dir, &b), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_wire_shapes_are_the_servers() {
        assert_eq!(
            parse_tokens(r#"{"data":{"accessToken":"at","refreshToken":"rt"}}"#),
            Some(Tokens {
                access: "at".into(),
                refresh: Some("rt".into())
            })
        );
        assert_eq!(
            parse_tokens(r#"{"data":{"accessToken":"at"}}"#),
            Some(Tokens {
                access: "at".into(),
                refresh: None
            })
        );
        assert_eq!(parse_tokens(r#"{"error":{"message":"no"}}"#), None);
        assert_eq!(
            parse_ticket(r#"{"data":{"ticket":"t1"}}"#).as_deref(),
            Some("t1")
        );
        assert_eq!(
            socket_url("https://acme.example.com/", "a b").as_deref(),
            Some("wss://acme.example.com/ws?ticket=a+b")
        );
        assert_eq!(
            socket_url("http://localhost:3000", "t").as_deref(),
            Some("ws://localhost:3000/ws?ticket=t")
        );
        let hello: serde_json::Value =
            serde_json::from_str(&hello_frame(Some("d.1"), "granted")).unwrap();
        assert_eq!(hello["clientKind"], "desktop_app");
        assert_eq!(hello["deviceId"], "d.1");
        assert_eq!(hello["notificationPermission"], "granted");
        assert_eq!(
            hello["lastActiveAt"], 0,
            "this channel never claims activity"
        );
        assert!(
            hello.get("viewing").is_none(),
            "nor that anything is on screen"
        );
        let frame = parse_notify(
            r#"{"type":"notify","notifyId":"message:m1","notificationId":"n1","group":"g","title":"Alice","body":"hi","route":"thread/t1","urgent":false}"#,
        )
        .unwrap();
        assert_eq!(frame.route.as_deref(), Some("thread/t1"));
        assert_eq!(frame.group.as_deref(), Some("g"));
        // Another server's direct message or mention plays the sound; the
        // group is carried through, and a frame without one stays silent.
        let direct = parse_notify(
            r#"{"type":"notify","notifyId":"message:m2","group":"direct","title":"Bob","body":"hey"}"#,
        )
        .unwrap();
        assert!(crate::desktop_notifications::plays_sound(direct.group.as_deref()));
        let bare = parse_notify(r#"{"type":"notify","notifyId":"x","title":"t"}"#).unwrap();
        assert!(!crate::desktop_notifications::plays_sound(bare.group.as_deref()));
        assert_eq!(parse_notify(r#"{"type":"entity","title":"x"}"#), None);
        let receipt: serde_json::Value =
            serde_json::from_str(&receipt_body("n1", "d.1", true)).unwrap();
        assert_eq!(receipt["outcome"], "shown");
        assert_eq!(receipt["surface"], "desktop");
    }

    #[test]
    fn retries_back_off_and_cap() {
        assert_eq!(retry_delay(0), RETRY_MIN);
        assert_eq!(retry_delay(1), RETRY_MIN * 2);
        assert_eq!(retry_delay(40), RETRY_MAX);
    }

    /// A switch waits for an exchange in flight, then no exchange starts.
    #[test]
    fn a_release_waits_out_an_exchange_in_flight_and_none_starts_after() {
        let gate = Arc::new(Gate::default());
        assert!(gate.begin_exchange());
        let finishing = gate.clone();
        let worker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            finishing.end_exchange();
        });
        let started = std::time::Instant::now();
        assert!(gate.stop_and_wait(Duration::from_secs(5)));
        assert!(started.elapsed() >= Duration::from_millis(100), "it waited");
        assert!(
            !gate.begin_exchange(),
            "a stopped channel never presents the token"
        );
        worker.join().unwrap();
    }

    // ---- end to end, against a fake Liaison on localhost ----

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    #[derive(Default, Debug)]
    struct Seen {
        refresh_presented: Vec<String>,
        origins: Vec<String>,
        ticket_bearer: Option<String>,
        hello: Option<serde_json::Value>,
        receipt_bearer: Option<String>,
        receipt: Option<serde_json::Value>,
    }

    fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
        head.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.trim().eq_ignore_ascii_case(name).then(|| value.trim())
        })
    }

    async fn answer_http(mut stream: TcpStream, seen: Arc<Mutex<Seen>>) {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        let (head, body) = loop {
            let n = stream.read(&mut chunk).await.unwrap_or(0);
            if n == 0 {
                return;
            }
            buf.extend_from_slice(&chunk[..n]);
            let text = String::from_utf8_lossy(&buf).to_string();
            if let Some(end) = text.find("\r\n\r\n") {
                let head = text[..end].to_string();
                let length: usize = header(&head, "content-length")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                if buf.len() >= end + 4 + length {
                    break (head, text[end + 4..end + 4 + length].to_string());
                }
            }
        };
        let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
        let answer = {
            let mut seen = seen.lock().unwrap();
            if let Some(origin) = header(&head, "origin") {
                seen.origins.push(origin.to_string());
            }
            match path.as_str() {
                "/api/auth/refresh" => {
                    seen.refresh_presented
                        .push(header(&head, "x-liaison-refresh").unwrap_or("").to_string());
                    r#"{"data":{"accessToken":"at-b","refreshToken":"rt-b-2"}}"#.to_string()
                }
                "/api/auth/ws-ticket" => {
                    seen.ticket_bearer = header(&head, "authorization").map(str::to_string);
                    r#"{"data":{"ticket":"tk-b"}}"#.to_string()
                }
                "/api/notifications/receipts" => {
                    seen.receipt_bearer = header(&head, "authorization").map(str::to_string);
                    seen.receipt = serde_json::from_str(&body).ok();
                    r#"{"data":{}}"#.to_string()
                }
                _ => "{}".to_string(),
            }
        };
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            answer.len(),
            answer
        );
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.shutdown().await;
    }

    async fn answer_socket(stream: TcpStream, seen: Arc<Mutex<Seen>>) {
        let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
            return;
        };
        if let Some(Ok(Message::Text(hello))) = socket.next().await {
            seen.lock().unwrap().hello = serde_json::from_str(&hello).ok();
        }
        // Realtime traffic that is not a notification, then the notification.
        let _ = socket
            .send(Message::text(
                r#"{"type":"entity","app":"kernel","entity":"message"}"#,
            ))
            .await;
        let _ = socket
            .send(Message::text(
                r#"{"type":"notify","notifyId":"message:m-b","notificationId":"n-b","group":"chat","title":"Bob","body":"the invoice is late","route":"thread/t-b","urgent":false}"#,
            ))
            .await;
        while let Some(Ok(_)) = socket.next().await {}
    }

    async fn fake_liaison(listener: TcpListener, seen: Arc<Mutex<Seen>>) {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let seen = seen.clone();
            tokio::spawn(async move {
                let mut peek = [0u8; 16];
                let mut got = 0;
                for _ in 0..50 {
                    got = stream.peek(&mut peek).await.unwrap_or(0);
                    if got >= 8 {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                if peek[..got].starts_with(b"GET /ws") {
                    answer_socket(stream, seen).await;
                } else {
                    answer_http(stream, seen).await;
                }
            });
        }
    }

    /// THE BUG, end to end: two servers, the window on A. A notification B
    /// sends reaches this computer through B's own channel, is raised for B
    /// (never A), and B is told it was shown; B's rotated session is filed
    /// under B and A's is untouched.
    #[test]
    fn a_notification_from_the_server_the_window_is_not_on_is_delivered_for_that_server() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let b_address = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
            let dir = scratch_dir("listeners-e2e");
            let a = add_server_at(&dir, A, Some("Acme".into())).unwrap();
            let b = add_server_at(&dir, &b_address, Some("Globex".into())).unwrap();
            switch_current_at(&dir, &b).unwrap();
            servers::store_refresh_token_for_at(&dir, &b, "rt-b-1").unwrap();
            crate::notification_device::store_credential_for_at(&dir, &b, "lnr_b").unwrap();
            switch_current_at(&dir, &a).unwrap();
            servers::store_refresh_token_for_at(&dir, &a, "rt-a").unwrap();
            assert_eq!(background_servers_at(&dir), vec![b.clone()]);

            let seen = Arc::new(Mutex::new(Seen::default()));
            tokio::spawn(fake_liaison(listener, seen.clone()));

            let raised: Arc<Mutex<Vec<(String, NotifyFrame)>>> = Arc::default();
            let into = raised.clone();
            let raiser: Raiser = Arc::new(move |server: String, frame: NotifyFrame| {
                let into = into.clone();
                Box::pin(async move {
                    into.lock().unwrap().push((server, frame));
                    true
                })
            });
            let gate = Arc::new(Gate::default());
            let config = ChannelConfig {
                dir: dir.clone(),
                address: b.clone(),
                device_id: Some("d.test".into()),
                origin: APP_ORIGIN.to_string(),
            };
            let permission = || "granted".to_string();
            let channel = {
                let gate = gate.clone();
                tokio::spawn(
                    async move { connect_once(&config, &gate, &permission, &raiser).await },
                )
            };
            for _ in 0..200 {
                if seen.lock().unwrap().receipt.is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(gate.stop_and_wait(Duration::from_secs(2)));
            assert_eq!(channel.await.unwrap(), Ended::Stopped);

            let raised = raised.lock().unwrap();
            assert_eq!(raised.len(), 1, "exactly the notification, nothing else");
            assert_eq!(raised[0].0, b, "raised for B, the server it came from");
            assert_eq!(raised[0].1.title, "Bob");
            assert_eq!(raised[0].1.route.as_deref(), Some("thread/t-b"));

            let seen = seen.lock().unwrap();
            assert_eq!(
                seen.refresh_presented,
                vec!["rt-b-1".to_string()],
                "B's own token"
            );
            assert!(seen.origins.iter().all(|origin| origin == APP_ORIGIN));
            assert_eq!(seen.ticket_bearer.as_deref(), Some("Bearer at-b"));
            let hello = seen.hello.as_ref().expect("a hello");
            assert_eq!(hello["clientKind"], "desktop_app");
            assert_eq!(hello["deviceId"], "d.test");
            assert_eq!(hello["notificationPermission"], "granted");
            assert_eq!(seen.receipt_bearer.as_deref(), Some("Bearer lnr_b"));
            let receipt = seen.receipt.as_ref().expect("a receipt");
            assert_eq!(receipt["notificationId"], "n-b");
            assert_eq!(receipt["outcome"], "shown");

            assert_eq!(
                servers::stored_refresh_token_at(&dir, &b).as_deref(),
                Some("rt-b-2"),
                "the rotated session is filed under B"
            );
            assert_eq!(
                servers::stored_refresh_token_at(&dir, &a).as_deref(),
                Some("rt-a")
            );
            std::fs::remove_dir_all(&dir).ok();
        });
    }
}
