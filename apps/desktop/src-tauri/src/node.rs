// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THIS COMPUTER AS THE USER'S NODE (P4 N-D T4, S19, A25, F11, F13).
//
// "Use this computer as my node" (Settings > This computer) registers this
// install with the server (POST /api/nodes, bound to the WS deviceId of
// P1-T6), and the server answers a NODE CREDENTIAL. The page hands it to the
// shell, which keeps it here, per server, in a 0600 file beside the
// notification credentials (F13: a file, as T6, not a keychain crate). The
// page reads it back for the current server only and presents it in the WS
// hello, which is what marks the node online.
//
// KEEP AWAKE WHILE ON POWER. A node that sleeps runs nothing. While the node
// is on for the current server and the user turned "keep awake" on, the shell
// holds an NSProcessInfo activity with idle SYSTEM sleep disabled (the display
// may still sleep), and only while the machine draws from AC power: on
// battery it lets the machine sleep as usual. The power source is read from
// `pmset -g ps` (no IOKit crate, F13); Windows uses SetThreadExecutionState
// and GetSystemPowerStatus from kernel32; Linux reports keep-awake as not
// available.
//
// One watcher thread owns the assertion (SetThreadExecutionState is per
// thread), re-evaluates every minute (a cable plugged or pulled) and on every
// change the page makes, and answers the fresh status to the command that
// asked.
//
// The decisions are pure functions below; the rest is file and OS calls.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use crate::servers::{current_address_at, same_server, NOT_CURRENT_SERVER};

/// The per-server node file: `{"servers": {address: NodeRecord}}`, 0600.
pub const NODE_FILE: &str = "liaison-node.json";
/// The keep-awake choice: `{"enabled": bool}`. Off until the checklist turns it on.
pub const KEEP_AWAKE_FILE: &str = "liaison-keep-awake.json";
/// Longer than any id or credential the API issues.
pub const MAX_FIELD_LEN: usize = 256;
/// How often the watcher re-reads the power source.
pub const POLL_INTERVAL: Duration = Duration::from_secs(60);

/// What the shell keeps for one server's node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRecord {
    pub node_id: String,
    pub credential: String,
    /// The switch: off keeps the credential (turning back on is a PATCH) but
    /// presents nothing and holds no assertion. Queued jobs wait (D11).
    pub enabled: bool,
}

/// Where the machine draws its power from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PowerSource {
    Ac,
    Battery,
    /// No reading (no battery to report, or the tool failed).
    Unknown,
}

/// What the page shows for keep-awake.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepAwakeStatus {
    /// The user's choice.
    pub enabled: bool,
    /// Whether this OS can hold a power assertion at all.
    pub supported: bool,
    /// Whether the node is on for the current server.
    pub node_on: bool,
    pub power: PowerSource,
    /// Whether the assertion is held right now.
    pub held: bool,
}

// ─── The node file ───────────────────────────────────────────────────────

fn valid_field(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= MAX_FIELD_LEN
}

fn node_document(dir: &Path) -> serde_json::Map<String, serde_json::Value> {
    std::fs::read(dir.join(NODE_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|body| body.get("servers").and_then(|v| v.as_object()).cloned())
        .unwrap_or_default()
}

fn write_node_document(
    dir: &Path,
    map: serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let body = serde_json::json!({ "servers": map });
    crate::sidecar::write_private(
        &dir.join(NODE_FILE),
        &serde_json::to_vec(&body).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// Stores (Some) or removes (None) the CURRENT server's node. A server that
/// is not current is refused, so a credential never lands under another one.
pub fn store_node_for_at(
    dir: &Path,
    server: &str,
    record: Option<NodeRecord>,
) -> Result<(), String> {
    if let Some(node) = &record {
        if !valid_field(&node.node_id) || !valid_field(&node.credential) {
            return Err("the node id or credential is not one this API issues".into());
        }
    }
    let current = current_address_at(dir).ok_or(NOT_CURRENT_SERVER)?;
    if !same_server(&current, server) {
        return Err(NOT_CURRENT_SERVER.into());
    }
    let mut map = node_document(dir);
    match record {
        None => {
            if map.remove(&current).is_none() {
                return Ok(());
            }
        }
        Some(node) => {
            map.insert(
                current,
                serde_json::to_value(NodeRecord {
                    node_id: node.node_id.trim().into(),
                    credential: node.credential.trim().into(),
                    enabled: node.enabled,
                })
                .map_err(|e| e.to_string())?,
            );
        }
    }
    write_node_document(dir, map)
}

fn record_of(
    map: &serde_json::Map<String, serde_json::Value>,
    address: &str,
) -> Option<NodeRecord> {
    map.get(address)
        .cloned()
        .and_then(|value| serde_json::from_value::<NodeRecord>(value).ok())
        .filter(|node| valid_field(&node.node_id) && valid_field(&node.credential))
}

/// The node for `server`, only when it is the current one.
pub fn node_for_at(dir: &Path, server: &str) -> Option<NodeRecord> {
    let current = current_address_at(dir)?;
    if !same_server(&current, server) {
        return None;
    }
    record_of(&node_document(dir), &current)
}

/// The current server's node, whatever it is.
pub fn current_node_at(dir: &Path) -> Option<NodeRecord> {
    let current = current_address_at(dir)?;
    record_of(&node_document(dir), &current)
}

/// Drops one server's node, whoever is current (a sign out, a removal).
pub fn forget_node_at(dir: &Path, address: &str) {
    let mut map = node_document(dir);
    if map.remove(address).is_some() {
        let _ = write_node_document(dir, map);
    }
}

// ─── Keep awake ──────────────────────────────────────────────────────────

pub fn read_keep_awake_at(dir: &Path) -> bool {
    std::fs::read(dir.join(KEEP_AWAKE_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|body| body.get("enabled").and_then(|v| v.as_bool()))
        .unwrap_or(false)
}

pub fn write_keep_awake_at(dir: &Path, enabled: bool) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let body = serde_json::json!({ "enabled": enabled });
    crate::sidecar::write_private(
        &dir.join(KEEP_AWAKE_FILE),
        &serde_json::to_vec(&body).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// The source `pmset -g ps` names on its first line ("Now drawing from 'AC
/// Power'" / "'Battery Power'" / "'UPS Power'").
pub fn power_source_from_pmset(output: &str) -> PowerSource {
    let first = output.lines().next().unwrap_or_default();
    if first.contains("'AC Power'") {
        PowerSource::Ac
    } else if first.contains("'Battery Power'") || first.contains("'UPS Power'") {
        PowerSource::Battery
    } else {
        PowerSource::Unknown
    }
}

/// Hold the assertion exactly while the node is on, the user asked for it,
/// and the machine is not on battery (a machine with no battery reading, a
/// Mac mini, counts as plugged in).
pub fn should_hold(node_on: bool, keep_awake: bool, power: PowerSource) -> bool {
    node_on && keep_awake && power != PowerSource::Battery
}

/// One OS power assertion: begin answers whether it is now held.
pub trait PowerAssertion: Send {
    fn supported(&self) -> bool;
    fn begin(&mut self) -> bool;
    fn end(&mut self);
}

/// The assertion and whether it is held: begun once, ended once.
pub struct KeepAwake<A: PowerAssertion> {
    assertion: A,
    held: bool,
}

impl<A: PowerAssertion> KeepAwake<A> {
    pub fn new(assertion: A) -> Self {
        Self {
            assertion,
            held: false,
        }
    }

    pub fn supported(&self) -> bool {
        self.assertion.supported()
    }

    /// Takes or releases the assertion to match `want`; answers `held`.
    pub fn apply(&mut self, want: bool) -> bool {
        match (self.held, want) {
            (false, true) => self.held = self.assertion.begin(),
            (true, false) => {
                self.assertion.end();
                self.held = false;
            }
            _ => {}
        }
        self.held
    }
}

/// One evaluation: read the choice and the node, read the power source only
/// when it matters, apply.
pub fn evaluate<A: PowerAssertion>(
    dir: &Path,
    keep: &mut KeepAwake<A>,
    read_power: impl FnOnce() -> PowerSource,
) -> KeepAwakeStatus {
    let enabled = read_keep_awake_at(dir);
    let node_on = current_node_at(dir).is_some_and(|node| node.enabled);
    let power = if node_on && enabled {
        read_power()
    } else {
        PowerSource::Unknown
    };
    let held = keep.apply(should_hold(node_on, enabled, power));
    KeepAwakeStatus {
        enabled,
        supported: keep.supported(),
        node_on,
        power,
        held,
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use objc2::rc::Retained;
    use objc2::runtime::{NSObjectProtocol, ProtocolObject};
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    use super::{PowerAssertion, PowerSource};

    /// An NSProcessInfo activity with idle system sleep disabled (F13). The
    /// display may still sleep; the machine does not.
    #[derive(Default)]
    pub struct Assertion(Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>);
    // SAFETY: an activity token is an immutable NSObject; beginActivity and
    // endActivity are documented thread safe.
    unsafe impl Send for Assertion {}

    impl PowerAssertion for Assertion {
        fn supported(&self) -> bool {
            true
        }
        fn begin(&mut self) -> bool {
            if self.0.is_none() {
                let reason = NSString::from_str("Liaison keeps this computer awake for its node");
                self.0 = Some(
                    NSProcessInfo::processInfo().beginActivityWithOptions_reason(
                        NSActivityOptions::IdleSystemSleepDisabled
                            | NSActivityOptions::UserInitiated,
                        &reason,
                    ),
                );
            }
            true
        }
        fn end(&mut self) {
            if let Some(token) = self.0.take() {
                // SAFETY: the token came from beginActivity on this process.
                unsafe { NSProcessInfo::processInfo().endActivity(&token) };
            }
        }
    }

    pub fn power_source() -> PowerSource {
        std::process::Command::new("/usr/bin/pmset")
            .args(["-g", "ps"])
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| super::power_source_from_pmset(&String::from_utf8_lossy(&out.stdout)))
            .unwrap_or(PowerSource::Unknown)
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{PowerAssertion, PowerSource};

    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;

    #[repr(C)]
    #[derive(Default)]
    struct SystemPowerStatus {
        ac_line_status: u8,
        battery_flag: u8,
        battery_life_percent: u8,
        system_status_flag: u8,
        battery_life_time: u32,
        battery_full_life_time: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn SetThreadExecutionState(flags: u32) -> u32;
        fn GetSystemPowerStatus(status: *mut SystemPowerStatus) -> i32;
    }

    /// SetThreadExecutionState is per THREAD: only the watcher thread calls it.
    #[derive(Default)]
    pub struct Assertion;

    impl PowerAssertion for Assertion {
        fn supported(&self) -> bool {
            true
        }
        fn begin(&mut self) -> bool {
            // SAFETY: a plain kernel32 call with documented flags.
            unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) != 0 }
        }
        fn end(&mut self) {
            // SAFETY: as above; clears the requirement for this thread.
            unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        }
    }

    pub fn power_source() -> PowerSource {
        let mut status = SystemPowerStatus::default();
        // SAFETY: the struct has the documented SYSTEM_POWER_STATUS layout.
        if unsafe { GetSystemPowerStatus(&mut status) } == 0 {
            return PowerSource::Unknown;
        }
        match status.ac_line_status {
            1 => PowerSource::Ac,
            0 => PowerSource::Battery,
            _ => PowerSource::Unknown,
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::{PowerAssertion, PowerSource};

    /// No assertion on this OS: keep-awake shows as not available.
    #[derive(Default)]
    pub struct Assertion;

    impl PowerAssertion for Assertion {
        fn supported(&self) -> bool {
            false
        }
        fn begin(&mut self) -> bool {
            false
        }
        fn end(&mut self) {}
    }

    pub fn power_source() -> PowerSource {
        PowerSource::Unknown
    }
}

// ─── The watcher ─────────────────────────────────────────────────────────

/// A request to re-evaluate now, with where to send the fresh status.
type Nudge = Option<SyncSender<KeepAwakeStatus>>;

static WATCHER: Mutex<Option<Sender<Nudge>>> = Mutex::new(None);

fn run_watcher(dir: PathBuf, nudges: Receiver<Nudge>, on_node: Box<dyn Fn(bool) + Send>) {
    let mut keep = KeepAwake::new(platform::Assertion::default());
    let mut last_node_on: Option<bool> = None;
    loop {
        let reply = match nudges.recv_timeout(POLL_INTERVAL) {
            Ok(reply) => reply,
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let status = evaluate(&dir, &mut keep, platform::power_source);
        // The App Nap activity follows the node whatever the window does
        // (tray.rs): the node's presence runs on the page's timers.
        crate::tray::follow_node(status.node_on);
        // So does the webview's background throttling (review finding 3).
        if crate::tray::throttling_step(last_node_on, status.node_on).is_some() {
            on_node(status.node_on);
        }
        last_node_on = Some(status.node_on);
        if let Some(reply) = reply {
            let _ = reply.try_send(status);
        }
    }
    keep.apply(false);
}

/// Starts the watcher once, from setup. It takes the assertion at start when
/// the node was on (an app relaunched at login keeps the machine awake).
pub fn spawn_watcher<R: Runtime>(app: &AppHandle<R>) {
    let Some(dir) = crate::sidecar::app_config_dir(app) else {
        return;
    };
    let Ok(mut slot) = WATCHER.lock() else {
        return;
    };
    if slot.is_some() {
        return;
    }
    let (tx, rx) = mpsc::channel::<Nudge>();
    let _ = tx.send(None);
    let handle = app.clone();
    let on_node = Box::new(move |node_on: bool| crate::tray::apply_throttling(&handle, node_on));
    if std::thread::Builder::new()
        .name("liaison-keep-awake".into())
        .spawn(move || run_watcher(dir, rx, on_node))
        .is_ok()
    {
        *slot = Some(tx);
    }
}

/// Asks the watcher to re-evaluate and waits (briefly) for its answer. Falls
/// back to a status without the assertion when there is no watcher.
fn reevaluate(dir: &Path) -> KeepAwakeStatus {
    let sender = WATCHER.lock().ok().and_then(|slot| slot.clone());
    if let Some(sender) = sender {
        let (reply, answer) = mpsc::sync_channel(1);
        if sender.send(Some(reply)).is_ok() {
            if let Ok(status) = answer.recv_timeout(Duration::from_secs(5)) {
                return status;
            }
        }
    }
    let node_on = current_node_at(dir).is_some_and(|node| node.enabled);
    KeepAwakeStatus {
        enabled: read_keep_awake_at(dir),
        supported: platform::Assertion::default().supported(),
        node_on,
        power: PowerSource::Unknown,
        held: false,
    }
}

/// A sign out or a server removal: the node of that server goes, and the
/// watcher lets the machine sleep again.
pub fn forget_and_release(dir: &Path, address: &str) {
    forget_node_at(dir, address);
    let sender = WATCHER.lock().ok().and_then(|slot| slot.clone());
    if let Some(sender) = sender {
        let _ = sender.send(None);
    }
}

// ─── Commands ────────────────────────────────────────────────────────────

/// The page stores the node the server answered (or, with `node: null`,
/// removes it), for the CURRENT server only. Answers the keep-awake status.
#[tauri::command]
pub fn store_node_credential<R: Runtime>(
    app: AppHandle<R>,
    server: String,
    node: Option<NodeRecord>,
) -> Result<KeepAwakeStatus, String> {
    let dir = crate::sidecar::app_config_dir(&app).ok_or("no application config directory")?;
    store_node_for_at(&dir, &server, node)?;
    Ok(reevaluate(&dir))
}

#[tauri::command]
pub fn load_node_credential<R: Runtime>(app: AppHandle<R>, server: String) -> Option<NodeRecord> {
    node_for_at(&crate::sidecar::app_config_dir(&app)?, &server)
}

#[tauri::command]
pub fn get_keep_awake<R: Runtime>(app: AppHandle<R>) -> Result<KeepAwakeStatus, String> {
    let dir = crate::sidecar::app_config_dir(&app).ok_or("no application config directory")?;
    Ok(reevaluate(&dir))
}

#[tauri::command]
pub fn set_keep_awake<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
) -> Result<KeepAwakeStatus, String> {
    let dir = crate::sidecar::app_config_dir(&app).ok_or("no application config directory")?;
    write_keep_awake_at(&dir, enabled)?;
    Ok(reevaluate(&dir))
}

#[cfg(test)]
mod node_tests {
    use super::*;
    use crate::servers::{add_server_at, scratch_dir, switch_current_at};

    fn record(id: &str, enabled: bool) -> NodeRecord {
        NodeRecord {
            node_id: id.into(),
            credential: format!("lnn_{id}"),
            enabled,
        }
    }

    #[test]
    fn a_node_is_kept_for_the_current_server_only() {
        let dir = scratch_dir("node-credential");
        let a = add_server_at(&dir, "https://a.example.com", None).unwrap();
        let b = add_server_at(&dir, "https://b.example.com", None).unwrap();
        switch_current_at(&dir, &a).unwrap();
        store_node_for_at(&dir, &a, Some(record("n-a", true))).unwrap();
        assert_eq!(node_for_at(&dir, &a), Some(record("n-a", true)));
        assert_eq!(
            store_node_for_at(&dir, &b, Some(record("n-b", true))).unwrap_err(),
            NOT_CURRENT_SERVER,
            "a node credential never lands under a server that is not current"
        );
        switch_current_at(&dir, &b).unwrap();
        assert_eq!(
            node_for_at(&dir, &a),
            None,
            "only the current server is answered"
        );
        assert_eq!(current_node_at(&dir), None);
        store_node_for_at(&dir, &b, Some(record("n-b", false))).unwrap();
        assert_eq!(current_node_at(&dir), Some(record("n-b", false)));
        switch_current_at(&dir, &a).unwrap();
        assert_eq!(
            node_for_at(&dir, &a),
            Some(record("n-a", true)),
            "per server"
        );

        store_node_for_at(&dir, &a, None).unwrap();
        assert_eq!(node_for_at(&dir, &a), None, "null removes it");
        forget_node_at(&dir, &b);
        switch_current_at(&dir, &b).unwrap();
        assert_eq!(node_for_at(&dir, &b), None, "a sign out forgets it");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_empty_or_oversized_credential_is_refused() {
        let dir = scratch_dir("node-credential-shape");
        let a = add_server_at(&dir, "https://a.example.com", None).unwrap();
        switch_current_at(&dir, &a).unwrap();
        let mut empty = record("n-a", true);
        empty.credential = " ".into();
        assert!(store_node_for_at(&dir, &a, Some(empty)).is_err());
        let mut long = record("n-a", true);
        long.credential = "x".repeat(MAX_FIELD_LEN + 1);
        assert!(store_node_for_at(&dir, &a, Some(long)).is_err());
        assert_eq!(node_for_at(&dir, &a), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn the_node_file_is_readable_by_its_owner_alone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch_dir("node-credential-mode");
        let a = add_server_at(&dir, "https://a.example.com", None).unwrap();
        switch_current_at(&dir, &a).unwrap();
        store_node_for_at(&dir, &a, Some(record("n-a", true))).unwrap();
        let mode = std::fs::metadata(dir.join(NODE_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        write_keep_awake_at(&dir, true).unwrap();
        let mode = std::fs::metadata(dir.join(KEEP_AWAKE_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn keep_awake_is_off_until_chosen_and_kept_on_disk() {
        let dir = scratch_dir("node-keep-awake");
        assert!(!read_keep_awake_at(&dir));
        write_keep_awake_at(&dir, true).unwrap();
        assert!(read_keep_awake_at(&dir));
        write_keep_awake_at(&dir, false).unwrap();
        assert!(!read_keep_awake_at(&dir));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_power_source_is_read_from_pmset() {
        assert_eq!(
            power_source_from_pmset(
                "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged;"
            ),
            PowerSource::Ac
        );
        assert_eq!(
            power_source_from_pmset("Now drawing from 'Battery Power'\n -InternalBattery-0 82%"),
            PowerSource::Battery
        );
        assert_eq!(
            power_source_from_pmset("Now drawing from 'UPS Power'\n"),
            PowerSource::Battery,
            "a UPS is a battery"
        );
        assert_eq!(power_source_from_pmset(""), PowerSource::Unknown);
    }

    #[test]
    fn the_machine_is_kept_awake_only_for_an_enabled_node_on_power() {
        assert!(should_hold(true, true, PowerSource::Ac));
        assert!(
            should_hold(true, true, PowerSource::Unknown),
            "no battery reading: a desktop, plugged in"
        );
        assert!(
            !should_hold(true, true, PowerSource::Battery),
            "never on battery"
        );
        assert!(
            !should_hold(true, false, PowerSource::Ac),
            "the user said no"
        );
        assert!(
            !should_hold(false, true, PowerSource::Ac),
            "no node, no assertion"
        );
    }

    #[derive(Default)]
    struct Fake {
        begins: usize,
        ends: usize,
        supported: bool,
    }
    impl PowerAssertion for Fake {
        fn supported(&self) -> bool {
            self.supported
        }
        fn begin(&mut self) -> bool {
            self.begins += 1;
            self.supported
        }
        fn end(&mut self) {
            self.ends += 1;
        }
    }

    fn fake() -> KeepAwake<Fake> {
        KeepAwake::new(Fake {
            supported: true,
            ..Fake::default()
        })
    }

    #[test]
    fn the_assertion_is_taken_once_and_released_once() {
        let mut keep = fake();
        assert!(keep.apply(true));
        assert!(keep.apply(true), "still held");
        assert_eq!(keep.assertion.begins, 1, "never taken twice");
        assert!(!keep.apply(false));
        assert!(!keep.apply(false));
        assert_eq!(keep.assertion.ends, 1, "never released twice");
        assert!(keep.apply(true));
        assert_eq!(keep.assertion.begins, 2);
    }

    #[test]
    fn an_os_without_assertions_never_holds_one() {
        let mut keep = KeepAwake::new(Fake::default());
        assert!(!keep.apply(true));
        assert!(!keep.held);
        assert_eq!(keep.assertion.ends, 0);
    }

    #[test]
    fn evaluation_follows_the_node_the_choice_and_the_cable() {
        let dir = scratch_dir("node-evaluate");
        let a = add_server_at(&dir, "https://a.example.com", None).unwrap();
        switch_current_at(&dir, &a).unwrap();
        let mut keep = fake();

        let status = evaluate(&dir, &mut keep, || {
            panic!("power is not read without a node")
        });
        assert!(!status.held && !status.node_on && !status.enabled);

        store_node_for_at(&dir, &a, Some(record("n-a", true))).unwrap();
        write_keep_awake_at(&dir, true).unwrap();
        let status = evaluate(&dir, &mut keep, || PowerSource::Ac);
        assert!(status.held && status.node_on && status.enabled && status.supported);
        assert_eq!(status.power, PowerSource::Ac);

        let status = evaluate(&dir, &mut keep, || PowerSource::Battery);
        assert!(!status.held, "the cable was pulled");
        assert_eq!(status.power, PowerSource::Battery);
        assert!(
            evaluate(&dir, &mut keep, || PowerSource::Ac).held,
            "plugged back in"
        );

        store_node_for_at(&dir, &a, Some(record("n-a", false))).unwrap();
        assert!(
            !evaluate(&dir, &mut keep, || PowerSource::Ac).held,
            "the switch is off"
        );
        store_node_for_at(&dir, &a, Some(record("n-a", true))).unwrap();
        write_keep_awake_at(&dir, false).unwrap();
        assert!(
            !evaluate(&dir, &mut keep, || PowerSource::Ac).held,
            "keep awake is off"
        );
        assert_eq!(keep.assertion.begins, 2);
        assert_eq!(keep.assertion.ends, 2);
        std::fs::remove_dir_all(&dir).ok();
    }
}
