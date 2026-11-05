//! The update checks the shell runs, and the decision behind them: one at
//! startup, one every six hours of wall clock while the app runs (a window
//! left open for days otherwise never hears of a release), and one whenever
//! the user picks "Check for Updates" in the macOS app menu or the tray.
//!
//! Three rules, and each one is a thing that goes wrong quietly:
//!
//!   1. A DEVELOPMENT build checks for nothing. A developer running against a
//!      local server would otherwise have the binary they are debugging
//!      replaced, mid session, by a release they did not build.
//!   2. Nothing installs without the user saying yes. An agent session holds a
//!      folder, a permission mode and a running sidecar; restarting it under
//!      the user is not a decision an updater gets to make.
//!   3. A failed check is a log line, not a dialog. The endpoint being
//!      unreachable is the ordinary state of a laptop on a train, and an app
//!      that interrupts for it is an app whose update prompts get dismissed
//!      unread.
//!
//! The decision is a pure function so all three can be tested without a
//! network, a window or a release build.
//!
//! And once the user has said yes, three more, from the 2026-09-28 incident: a
//! Windows user clicked OK, the window vanished, no installer ever appeared,
//! the version never changed, and Liaison would not open again until the
//! machine was rebooted. It happened again after a reboot with no local
//! session running at all.
//!
//!   4. The user SEES the update happen. The download is about 100 MB and the
//!      window title and the taskbar or dock icon show its progress; a
//!      download or an install that fails says so in a dialog, because on
//!      Windows nobody reads stderr.
//!   5. On Windows the shell starts the installer ITSELF and then quits the way
//!      a normal quit does. The plugin's own path hides the window, hands the
//!      installer to ShellExecuteW from a worker thread and calls
//!      `std::process::exit(0)`, which skips `RunEvent::Exit`: the local
//!      session and the sign in child were never stopped, the single instance
//!      mutex was never released, and nothing tells a failed launch from a
//!      launched one. Here the local work is stopped first, the installer is a
//!      plain child process whose start is checked, and the exit runs the same
//!      path a click on Quit runs, which is known to leave nothing behind.
//!   6. On macOS and Linux the plugin replaces the app and returns; restarting
//!      is the caller's job, so the shell restarts, as the prompt promised.
//!
//! And three for the checks that come after the first:
//!
//!   7. One prompt and one install at a time. A periodic check that lands
//!      while a prompt is open, or while a download runs, does nothing.
//!   8. A version the user declined is not offered again by the periodic
//!      check in this run. Asking every six hours is nagging; the manual
//!      check still offers it, because the user asked.
//!   9. Only the manual check speaks when there is nothing to do: "up to
//!      date", or a failure line. The periodic one follows rule 3.
//!
//! Every step goes to `updater.log` in the app's log directory, beside
//! `sidecar.log`, and the Windows installer appends its own lines to the same
//! file (windows/installer-hooks.nsi), so the next failure is readable.

// The install path after the yes is compiled into a release build only (a
// development build never updates), so on a debug build the helpers it calls
// are reached from the tests alone.
#![cfg_attr(debug_assertions, allow(dead_code))]

/// Which build is running. Carried as a value rather than read from `cfg!` at
/// the decision point, so the development rule is a test rather than a comment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuildKind {
    Dev,
    Release,
}

/// What the plugin came back with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateCheck {
    /// The endpoint answered and this build is current.
    UpToDate,
    /// The endpoint answered and names a newer build.
    Available { version: String },
    /// The check could not complete: offline, DNS, a 404 on the asset.
    Failed { error: String },
}

/// What the shell does about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateAction {
    /// Say nothing, do nothing.
    DoNothing,
    /// Write the failure to stderr and carry on.
    LogFailure { error: String },
    /// Ask the user, and install only on a yes.
    AskUser { version: String },
    /// A manual check found nothing: say so.
    TellUpToDate,
    /// A manual check failed: say so, in a dialog.
    ShowFailure { error: String },
}

/// The whole policy, in one place.
pub fn decide(build: BuildKind, check: UpdateCheck) -> UpdateAction {
    match (build, check) {
        // Rule 1, and it is checked FIRST: a development build reaches no
        // other arm, whatever the endpoint said.
        (BuildKind::Dev, _) => UpdateAction::DoNothing,
        (BuildKind::Release, UpdateCheck::UpToDate) => UpdateAction::DoNothing,
        (BuildKind::Release, UpdateCheck::Failed { error }) => UpdateAction::LogFailure { error },
        (BuildKind::Release, UpdateCheck::Available { version }) => {
            UpdateAction::AskUser { version }
        }
    }
}

/// What started a check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckTrigger {
    Startup,
    /// The six hourly recheck while the app runs.
    Periodic,
    /// "Check for Updates" in the app menu or the tray.
    Manual,
}

/// [`decide`] for one trigger: the startup policy, plus rules 8 and 9.
/// `declined` is the version the user said no to earlier in this run.
pub fn decide_for(
    trigger: CheckTrigger,
    build: BuildKind,
    check: UpdateCheck,
    declined: Option<&str>,
) -> UpdateAction {
    // Rule 1 holds for every trigger, the manual one included.
    if build == BuildKind::Dev {
        return UpdateAction::DoNothing;
    }
    match (trigger, decide(build, check)) {
        (CheckTrigger::Manual, UpdateAction::DoNothing) => UpdateAction::TellUpToDate,
        (CheckTrigger::Manual, UpdateAction::LogFailure { error }) => {
            UpdateAction::ShowFailure { error }
        }
        (CheckTrigger::Periodic, UpdateAction::AskUser { version })
            if declined == Some(version.as_str()) =>
        {
            UpdateAction::DoNothing
        }
        (_, action) => action,
    }
}

/// How long after a check the next periodic one is due.
pub const RECHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(6 * 60 * 60);

/// How often the periodic loop looks at the clock. Short, because the loop
/// sleeps on a monotonic timer, and on macOS that timer stops while the
/// machine sleeps: a plain six hour sleep would run late by every night the
/// lid was shut. Waking every few minutes and comparing WALL CLOCK times makes
/// a machine that slept past the interval check once, shortly after it wakes.
pub const RECHECK_TICK: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// Whether the periodic check is due. A clock set back since the last check
/// counts as due: the check resets `last`, so that happens once, not forever.
pub fn recheck_due(last: Option<std::time::SystemTime>, now: std::time::SystemTime) -> bool {
    match last {
        None => true,
        Some(last) => now
            .duration_since(last)
            .map_or(true, |elapsed| elapsed >= RECHECK_INTERVAL),
    }
}

/// Rule 7: held from the moment a check starts until its prompt is answered
/// and any install it led to has ended. A second check finds it held and
/// stops before it asks the network anything.
pub static UPDATE_IN_FLIGHT: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// The claim on a flag like [`UPDATE_IN_FLIGHT`], released when dropped, so
/// every way out of a check (an early return, an error) lets the next one in.
#[derive(Debug)]
pub struct InFlight<'a> {
    flag: &'a std::sync::atomic::AtomicBool,
}

impl<'a> InFlight<'a> {
    /// The claim, or None when another check holds it.
    pub fn try_begin(flag: &'a std::sync::atomic::AtomicBool) -> Option<Self> {
        use std::sync::atomic::Ordering;
        flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| InFlight { flag })
    }
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.flag.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// What a check that finds another one running does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BusyAnswer {
    /// The automatic checks: nothing, the running one covers them.
    Silent,
    /// The user clicked "Check for Updates": a click that does nothing reads
    /// as a broken menu item, so it says a check is already under way. A
    /// short informational note, not a second update prompt: it starts no
    /// check and no install.
    TellBusy,
}

pub fn when_busy(trigger: CheckTrigger) -> BusyAnswer {
    match trigger {
        CheckTrigger::Manual => BusyAnswer::TellBusy,
        CheckTrigger::Startup | CheckTrigger::Periodic => BusyAnswer::Silent,
    }
}

/// What it says. Customer copy: no dash punctuation.
pub fn busy_prompt() -> (String, String) {
    (
        "Already checking for updates".to_string(),
        "Liaison is already checking for updates or installing one. Any update it \
         finds is offered in its own window."
            .to_string(),
    )
}

/// What this run remembers between checks. In memory only: a restart forgets
/// a declined version, which is when the startup check has always asked.
#[derive(Debug, Default)]
pub struct RunMemory {
    pub last_check: Option<std::time::SystemTime>,
    pub declined: Option<String>,
}

pub static RUN_MEMORY: std::sync::Mutex<RunMemory> =
    std::sync::Mutex::new(RunMemory { last_check: None, declined: None });

fn remember<T>(read_or_write: impl FnOnce(&mut RunMemory) -> T) -> T {
    let mut memory = RUN_MEMORY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    read_or_write(&mut memory)
}

/// The build this binary is.
pub fn build_kind() -> BuildKind {
    if cfg!(debug_assertions) {
        BuildKind::Dev
    } else {
        BuildKind::Release
    }
}

/// What a manual check says when there is nothing newer. Customer copy: no
/// dash punctuation.
pub fn up_to_date_prompt(version: &str) -> (String, String) {
    (
        "Liaison is up to date".to_string(),
        format!("You're up to date (version {version})."),
    )
}

/// What a manual check says when it could not reach the update server.
pub fn check_failed_prompt(error: &str) -> (String, String) {
    (
        "Update check failed".to_string(),
        format!(
            "Liaison could not check for updates. You can keep working on this \
             version and try again later.\n\nDetails: {error}"
        ),
    )
}

/// The id of the "Check for Updates" item, in the macOS app menu and the
/// tray. One id for both, so one handler (main.rs) serves both.
pub const CHECK_FOR_UPDATES_ID: &str = "liaison-check-for-updates";
pub const CHECK_FOR_UPDATES_LABEL: &str = "Check for Updates\u{2026}";

/// What the confirmation says. Customer copy: no dash punctuation.
pub fn update_prompt(version: &str) -> (String, String) {
    (
        "Update Liaison".to_string(),
        format!(
            "Version {version} is available. Liaison will download it and restart. \
             Any local session running now is stopped first."
        ),
    )
}

/// Why this copy of Liaison cannot replace itself, found BEFORE the user is
/// asked and before 100 MB are downloaded (2026-10-30: a Mac user ran the app
/// from inside the mounted disk image, said yes, waited for the download, and
/// got "Read-only file system (os error 30)").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallBlock {
    /// macOS: the app runs from a read-only place, the mounted disk image or
    /// the read-only copy macOS makes of an app opened from Downloads without
    /// being moved (App Translocation). Moving it to Applications cures both.
    MoveToApplications,
    /// Linux: installed by a package manager (the .deb), which the updater
    /// cannot replace. The plugin would try to write the AppImage over the
    /// packaged binary and fail on permissions.
    PackageManaged,
    /// Linux: the AppImage file sits in a folder this user cannot write.
    AppImageNotWritable,
}

/// The decision, over the path the updater would replace and an injected
/// write probe of its folder, so every case is testable on any machine.
/// `target` is the .app bundle on macOS and the `$APPIMAGE` file on Linux
/// (None there means no AppImage: a packaged install).
pub fn install_block(
    platform: Platform,
    target: Option<&std::path::Path>,
    probe: impl Fn(&std::path::Path) -> std::io::Result<()>,
) -> Option<InstallBlock> {
    const EROFS: i32 = 30;
    match platform {
        Platform::Windows => None,
        Platform::MacOs => {
            let bundle = target?;
            if bundle.to_string_lossy().contains("/AppTranslocation/") {
                return Some(InstallBlock::MoveToApplications);
            }
            match probe(bundle.parent()?) {
                Err(error) if error.raw_os_error() == Some(EROFS) => {
                    Some(InstallBlock::MoveToApplications)
                }
                // A folder that is only not writable by this user (a standard
                // account and /Applications) is fine: the plugin asks for an
                // administrator's password there.
                _ => None,
            }
        }
        Platform::Linux => {
            let Some(appimage) = target else {
                return Some(InstallBlock::PackageManaged);
            };
            // The AppImage install has no privileged fallback: any refusal to
            // write beside the file fails the install.
            match probe(appimage.parent()?) {
                Ok(()) => None,
                Err(_) => Some(InstallBlock::AppImageNotWritable),
            }
        }
    }
}

/// Whether a new file can be created in `dir`, by creating one and removing it.
pub fn probe_writable(dir: &std::path::Path) -> std::io::Result<()> {
    let probe = dir.join(format!(".liaison-update-probe-{}", std::process::id()));
    std::fs::OpenOptions::new().write(true).create_new(true).open(&probe)?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

/// What the user is told instead of the update prompt when this copy cannot
/// replace itself. Customer copy: no dash punctuation, and it says what to do.
pub fn install_block_prompt(version: &str, block: InstallBlock) -> (String, String) {
    let message = match block {
        InstallBlock::MoveToApplications => format!(
            "Version {version} is available, but Liaison cannot update itself where it \
             is running now: from the disk image, or from a folder macOS keeps read \
             only. Quit Liaison, drag it into your Applications folder, and open it \
             from there. The update will then install."
        ),
        InstallBlock::PackageManaged => format!(
            "Version {version} is available. This copy of Liaison was installed from a \
             package, so it cannot update itself. Download the new package from \
             https://downloads.liaison.sh/desktop/latest/Liaison-linux.deb and install \
             it the same way."
        ),
        InstallBlock::AppImageNotWritable => format!(
            "Version {version} is available, but Liaison cannot replace its AppImage in \
             the folder it is in now. Move the AppImage to a folder you can write to, \
             such as your home folder, and open it from there. The update will then \
             install."
        ),
    };
    ("Update Liaison".to_string(), message)
}

/// The path the updater would replace: the .app bundle on macOS, the AppImage
/// on Linux. None on Windows, and on Linux when this is not an AppImage.
#[cfg(not(debug_assertions))]
fn update_target() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "macos")]
    {
        std::env::current_exe()
            .ok()
            .and_then(|exe| tauri_plugin_updater::extract_path_from_executable(&exe).ok())
    }
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("APPIMAGE").map(std::path::PathBuf::from)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

/// Which system the shell runs on. A value, like [`BuildKind`], so what
/// happens after an install is a test rather than a `cfg` nobody runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    MacOs,
    Linux,
}

/// The system this binary was built for.
pub fn platform() -> Platform {
    if cfg!(windows) {
        Platform::Windows
    } else if cfg!(target_os = "macos") {
        Platform::MacOs
    } else {
        Platform::Linux
    }
}

/// Who brings the new version up once it is installed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AfterInstall {
    /// The NSIS installer relaunches the app itself (`/R`), after the shell
    /// has quit so the files it replaces are free.
    InstallerRelaunches,
    /// The plugin replaced the app bundle or the AppImage and returned. The
    /// running copy is still the old one until the shell restarts, and the
    /// prompt said it would.
    RestartHere,
}

pub fn after_install(platform: Platform) -> AfterInstall {
    match platform {
        Platform::Windows => AfterInstall::InstallerRelaunches,
        Platform::MacOs | Platform::Linux => AfterInstall::RestartHere,
    }
}

/// What the shell passes the NSIS installer it starts: passive (a progress
/// window and no questions), update mode (no uninstall of the old version, no
/// new shortcuts), and relaunch when done. These are the flags tauri's own
/// updater passes, and the ones tauri's installer template reads.
pub const NSIS_UPDATE_ARGS: [&str; 3] = ["/P", "/UPDATE", "/R"];

/// Whether the verified payload is a Windows executable (the NSIS installer
/// this pipeline publishes) rather than an archive the plugin has to unpack.
pub fn is_windows_installer(bytes: &[u8]) -> bool {
    bytes.starts_with(b"MZ")
}

/// Where the installer is written: a directory of its own under the system's
/// temporary directory, named for the version so a half written earlier
/// attempt is never the file that runs.
pub fn installer_path(temp: &std::path::Path, version: &str) -> std::path::PathBuf {
    let version: String = version
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' { c } else { '_' })
        .collect();
    temp.join("liaison-update").join(format!("Liaison_{version}_setup.exe"))
}

/// Whether a Windows executable carries an Authenticode signature at all: the
/// PE security directory (data directory 4) is present and not empty. It says
/// nothing about whether the signature is valid; Windows judges that. What it
/// answers is the one question the shell has to ask before it quits for the
/// installer (see [`windows_install_gate`]).
pub fn has_authenticode_signature(pe: &[u8]) -> bool {
    fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
        Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
    }
    fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
        Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
    }
    let signed = || -> Option<bool> {
        if !pe.starts_with(b"MZ") {
            return Some(false);
        }
        let header = u32_at(pe, 0x3c)? as usize;
        if pe.get(header..header + 4)? != b"PE\0\0" {
            return Some(false);
        }
        // The optional header follows the 4 byte signature and the 20 byte
        // file header; its data directories start after 96 bytes in a PE32
        // (the NSIS installer) and 112 in a PE32+.
        let optional = header + 24;
        let directories = match u16_at(pe, optional)? {
            0x10b => optional + 96,
            0x20b => optional + 112,
            _ => return Some(false),
        };
        let count = u32_at(pe, directories - 4)?;
        if count <= 4 {
            return Some(false);
        }
        let security = directories + 4 * 8;
        Some(u32_at(pe, security)? != 0 && u32_at(pe, security + 4)? != 0)
    };
    signed().unwrap_or(false)
}

/// Smart App Control, from `VerifiedAndReputablePolicyState` under
/// `HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy`: 1 is on, 2 is the
/// evaluation mode (which watches and blocks nothing), anything else is off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub enum SmartAppControl {
    On,
    Evaluation,
    Off,
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn smart_app_control(value: Option<u32>) -> SmartAppControl {
    match value {
        Some(1) => SmartAppControl::On,
        Some(2) => SmartAppControl::Evaluation,
        _ => SmartAppControl::Off,
    }
}

/// Reads one REG_DWORD out of `reg query` output, which prints it as
/// `    Name    REG_DWORD    0x1`. Neither the name nor the type is
/// translated on a French or Polish Windows, only the surrounding messages.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn parse_reg_dword(output: &str, name: &str) -> Option<u32> {
    output.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        if fields.next()? != name || fields.next()? != "REG_DWORD" {
            return None;
        }
        u32::from_str_radix(fields.next()?.trim_start_matches("0x"), 16).ok()
    })
}

/// Whether the shell may quit for the installer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallGate {
    Proceed,
    /// Windows will refuse to start this installer. Quitting for it leaves the
    /// user with no app and no update, which is what happened on 2026-09-28:
    /// Smart App Control killed the unsigned 0.1.9 installer after the shell
    /// had already exited. The shell stays up and says why instead.
    BlockedBySmartAppControl,
}

pub fn windows_install_gate(control: SmartAppControl, signed: bool) -> InstallGate {
    match (control, signed) {
        (SmartAppControl::On, false) => InstallGate::BlockedBySmartAppControl,
        _ => InstallGate::Proceed,
    }
}

/// What the dialog says when Smart App Control would block the installer.
/// Customer copy: no dash punctuation.
pub fn blocked_prompt(version: &str) -> (String, String) {
    (
        "Update not installed".to_string(),
        format!(
            "Version {version} cannot be installed on this PC yet. Windows Smart App \
             Control blocks installers that are not signed, and this one is not. \
             Liaison keeps running on the version you have, and will install the \
             update once a signed version is available."
        ),
    )
}

/// The Smart App Control state of this machine. `reg.exe` rather than a
/// registry crate: one query at update time, and no new dependency in the
/// shell for it. CREATE_NO_WINDOW, or a console flashes up from a GUI app.
#[cfg(windows)]
pub fn read_smart_app_control() -> SmartAppControl {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const NAME: &str = "VerifiedAndReputablePolicyState";
    let value = std::process::Command::new("reg")
        .args(["query", r"HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy", "/v", NAME])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()
        .and_then(|out| parse_reg_dword(&String::from_utf8_lossy(&out.stdout), NAME));
    smart_app_control(value)
}

#[cfg(not(windows))]
pub fn read_smart_app_control() -> SmartAppControl {
    SmartAppControl::Off
}

/// Writes the installer, replacing any earlier attempt.
pub fn write_installer(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::remove_dir_all(dir);
        std::fs::create_dir_all(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    }
    std::fs::write(path, bytes).map_err(|error| format!("{}: {error}", path.display()))
}

/// Starts the installer as a plain child process and returns its pid. A start
/// that fails (a missing file, an application control policy, an antivirus
/// that quarantined it) is an error the caller shows, and the shell keeps
/// running: nothing has been stopped for good yet.
pub fn launch_installer(path: &std::path::Path, args: &[&str]) -> Result<u32, String> {
    std::process::Command::new(path)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|child| child.id())
        .map_err(|error| format!("could not start {}: {error}", path.display()))
}

/// Runs `work` on a plain thread and waits for it. The update runs on the
/// async runtime, and the exit work it has to do first (releasing the
/// conversation's lease) blocks on that same runtime: called from a runtime
/// thread, tokio panics with "Cannot start a runtime from within a runtime"
/// and the session is never stopped.
pub fn off_the_runtime<F>(work: F)
where
    F: FnOnce() + Send + 'static,
{
    let _ = std::thread::spawn(work).join();
}

/// A download's progress as a whole percent, when the size is known.
pub fn progress_percent(received: u64, total: Option<u64>) -> Option<u8> {
    match total {
        Some(total) if total > 0 => Some(((received.min(total) * 100) / total) as u8),
        _ => None,
    }
}

/// What the window title says while the update downloads. Customer copy: no
/// dash punctuation.
pub fn progress_title(version: &str, percent: Option<u8>, received: u64) -> String {
    match percent {
        Some(percent) => format!("Liaison (downloading version {version}: {percent}%)"),
        None => format!(
            "Liaison (downloading version {version}: {} MB)",
            received / (1024 * 1024)
        ),
    }
}

/// What the window title says once the download is done and the install runs.
pub fn installing_title(version: &str) -> String {
    format!("Liaison (installing version {version})")
}

/// The stretch of an update the window is covered for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdatePhase {
    Downloading,
    Installing,
}

/// One drawable state of an update: what the title, the taskbar or dock
/// progress, and the window's own update card all say.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateProgress {
    pub version: String,
    pub phase: UpdatePhase,
    /// None while the size is unknown, and for the whole install.
    pub percent: Option<u8>,
    /// Bytes so far, for a title with no percent to show.
    pub received: u64,
}

impl UpdateProgress {
    pub fn title(&self) -> String {
        match self.phase {
            UpdatePhase::Downloading => progress_title(&self.version, self.percent, self.received),
            UpdatePhase::Installing => installing_title(&self.version),
        }
    }
}

/// The event the page draws its update card from (apps/desktop/src/session
/// /sidecar-client.ts listens for it on every screen).
pub const UPDATE_PROGRESS_EVENT: &str = "liaison-update-progress";

/// The event's payload: `{ version, phase, percent }`, or JSON null when the
/// update stopped (a failure, or Smart App Control refusing the installer), so
/// the card comes down with the title.
pub fn update_progress_payload(progress: Option<&UpdateProgress>) -> serde_json::Value {
    match progress {
        None => serde_json::Value::Null,
        Some(progress) => serde_json::json!({
            "version": progress.version,
            "phase": match progress.phase {
                UpdatePhase::Downloading => "downloading",
                UpdatePhase::Installing => "installing",
            },
            "percent": progress.percent,
        }),
    }
}

/// Redraws only when the shown value changes: the callback fires once per
/// network chunk, thousands of times for one download, and each redraw is a
/// message to the main thread.
#[derive(Debug, Default)]
pub struct ProgressGate {
    received: u64,
    shown: Option<Option<u8>>,
    shown_mb: u64,
}

impl ProgressGate {
    /// Adds a chunk; returns the new percent (or none, for an unknown size)
    /// when it is worth drawing.
    pub fn chunk(&mut self, len: usize, total: Option<u64>) -> Option<Option<u8>> {
        self.received += len as u64;
        let percent = progress_percent(self.received, total);
        let mb = self.received / (1024 * 1024);
        let changed = match percent {
            Some(_) => self.shown != Some(percent),
            None => self.shown.is_none() || mb != self.shown_mb,
        };
        if changed {
            self.shown = Some(percent);
            self.shown_mb = mb;
            Some(percent)
        } else {
            None
        }
    }

    pub fn received(&self) -> u64 {
        self.received
    }
}

/// What the dialog says when the update could not be downloaded or installed.
/// Customer copy: no dash punctuation, and it says what state the app is in.
pub fn failure_prompt(version: &str, error: &str) -> (String, String) {
    (
        "Update not installed".to_string(),
        format!(
            "Liaison could not install version {version}. You can keep working on \
             this version, and Liaison will offer the update again the next time it \
             starts, or when you choose Check for Updates.\n\nDetails: {error}"
        ),
    )
}

/// The updater's own log, `updater.log` in the app's log directory. Every
/// write is best effort: a log that cannot be written is never the reason an
/// update does not happen.
#[derive(Debug, Clone)]
pub struct UpdateLog {
    path: std::path::PathBuf,
}

pub const UPDATE_LOG_FILE: &str = "updater.log";

impl UpdateLog {
    pub fn in_dir(dir: &std::path::Path) -> Self {
        UpdateLog { path: dir.join(UPDATE_LOG_FILE) }
    }

    pub fn append(&self, text: &str) {
        let _ = self.try_append(text);
    }

    fn try_append(&self, text: &str) -> std::io::Result<()> {
        use std::io::Write;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        // Rotated like sidecar.log, at the same size, so it never grows
        // without bound on a machine that fails every day.
        if std::fs::metadata(&self.path)
            .is_ok_and(|meta| meta.len() > crate::sidecar_watch::SIDECAR_LOG_MAX_BYTES)
        {
            let mut rotated = self.path.clone().into_os_string();
            rotated.push(".1");
            std::fs::rename(&self.path, std::path::PathBuf::from(rotated))?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        writeln!(
            file,
            "{} [shell {} pid {}] {}",
            crate::sidecar_watch::utc_timestamp(std::time::SystemTime::now()),
            env!("CARGO_PKG_VERSION"),
            std::process::id(),
            text.trim_end()
        )
    }
}

/// Registers the updater plugin, on a release build only. A development build
/// carries no updater at all, which is stronger than carrying one that is
/// never called.
#[cfg(not(debug_assertions))]
pub fn attach<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.plugin(tauri_plugin_updater::Builder::new().build())
}

#[cfg(debug_assertions)]
pub fn attach<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
}

#[cfg(not(debug_assertions))]
fn update_log(app: &tauri::AppHandle) -> Option<UpdateLog> {
    use tauri::Manager;
    app.path().app_log_dir().ok().map(|dir| UpdateLog::in_dir(&dir))
}

/// The startup check, then the periodic one for as long as the app runs.
/// Returns immediately; both run on the async runtime so the window is never
/// held up by a network round trip.
#[cfg(not(debug_assertions))]
pub fn check_on_start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        run_check(app.clone(), CheckTrigger::Startup).await;
        recheck_while_running(app).await;
    });
}

/// "Check for Updates", from the app menu or the tray.
#[cfg(not(debug_assertions))]
pub fn check_now(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(run_check(app, CheckTrigger::Manual));
}

/// The page's ask (`check_for_updates`): some app runs in compatibility mode
/// because the server moved past the web build this app carries, so the next
/// check should not wait six hours. Quiet like the periodic one (rule 9, rule 8 keeps a
/// declined version unoffered), so a deploy never raises a dialog with
/// nothing in it. Rule 2 still holds: nothing installs without a yes.
#[cfg(not(debug_assertions))]
pub fn check_quietly(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(run_check(app, CheckTrigger::Periodic));
}

/// Wakes every [`RECHECK_TICK`] and checks once the wall clock says the last
/// check is [`RECHECK_INTERVAL`] old (see `RECHECK_TICK` on why not one long
/// sleep). Never returns.
#[cfg(not(debug_assertions))]
async fn recheck_while_running(app: tauri::AppHandle) {
    loop {
        tokio::time::sleep(RECHECK_TICK).await;
        let last = remember(|memory| memory.last_check);
        if recheck_due(last, std::time::SystemTime::now()) {
            run_check(app.clone(), CheckTrigger::Periodic).await;
        }
    }
}

/// One check, whatever started it, through the one policy and the one
/// install flow.
#[cfg(not(debug_assertions))]
async fn run_check(app: tauri::AppHandle, trigger: CheckTrigger) {
    use tauri_plugin_updater::UpdaterExt;

    let log = update_log(&app);
    let note = |text: &str| {
        if let Some(log) = log.as_ref() {
            log.append(text);
        }
    };
    // Rule 7, before the network: a prompt already open or an install
    // already running is the answer to this check too.
    let Some(_in_flight) = InFlight::try_begin(&UPDATE_IN_FLIGHT) else {
        note(&format!("{trigger:?} check skipped: another check, prompt or install is running"));
        if when_busy(trigger) == BusyAnswer::TellBusy {
            use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
            let (title, message) = busy_prompt();
            app.dialog()
                .message(message)
                .title(title)
                .kind(MessageDialogKind::Info)
                .blocking_show();
        }
        return;
    };
    remember(|memory| memory.last_check = Some(std::time::SystemTime::now()));
    let checked = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };
    let (outcome, update) = match checked {
        Ok(Some(update)) => (
            UpdateCheck::Available { version: update.version.clone() },
            Some(update),
        ),
        Ok(None) => (UpdateCheck::UpToDate, None),
        Err(error) => (UpdateCheck::Failed { error: error.to_string() }, None),
    };
    note(&format!("{trigger:?} check: {outcome:?}"));
    let declined = remember(|memory| memory.declined.clone());
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    match decide_for(trigger, build_kind(), outcome, declined.as_deref()) {
        UpdateAction::DoNothing => {}
        UpdateAction::LogFailure { error } => {
            eprintln!("liaison: update check failed: {error}");
        }
        UpdateAction::AskUser { version } => {
            // Before the question: a copy that cannot replace itself says
            // what to do instead, rather than failing after the download.
            let target = update_target();
            if let Some(block) = install_block(platform(), target.as_deref(), probe_writable) {
                note(&format!("not offering {version}: {block:?} ({target:?})"));
                // Rule 8: the periodic check does not repeat it this run.
                remember(|memory| memory.declined = Some(version.clone()));
                let (title, message) = install_block_prompt(&version, block);
                app.dialog()
                    .message(message)
                    .title(title)
                    .kind(MessageDialogKind::Info)
                    .blocking_show();
                return;
            }
            let (title, message) = update_prompt(&version);
            let accepted = app
                .dialog()
                .message(message)
                .title(title)
                .buttons(MessageDialogButtons::OkCancel)
                .blocking_show();
            note(&format!("asked about {version}: accepted {accepted}"));
            if !accepted {
                // Rule 8: not offered again by the periodic check this run.
                remember(|memory| memory.declined = Some(version.clone()));
                return;
            }
            let Some(update) = update else { return };
            if let Err(error) = install_accepted(&app, &update, &note).await {
                note(&format!("FAILED: {error}"));
                eprintln!("liaison: update install failed: {error}");
                show_progress(&app, None);
                // The failure dialog promises the next offer at the next start
                // or on a manual check, not every six hours.
                remember(|memory| memory.declined = Some(version.clone()));
                let (title, message) = failure_prompt(&version, &error);
                app.dialog()
                    .message(message)
                    .title(title)
                    .kind(MessageDialogKind::Error)
                    .blocking_show();
            }
        }
        UpdateAction::TellUpToDate => {
            let (title, message) = up_to_date_prompt(&app.package_info().version.to_string());
            app.dialog()
                .message(message)
                .title(title)
                .kind(MessageDialogKind::Info)
                .blocking_show();
        }
        UpdateAction::ShowFailure { error } => {
            eprintln!("liaison: update check failed: {error}");
            let (title, message) = check_failed_prompt(&error);
            app.dialog()
                .message(message)
                .title(title)
                .kind(MessageDialogKind::Error)
                .blocking_show();
        }
    }
}

/// The window title, the taskbar or dock progress, and the page's update card.
/// `None` puts all three back.
#[cfg(not(debug_assertions))]
fn show_progress(app: &tauri::AppHandle, state: Option<UpdateProgress>) {
    use tauri::window::{ProgressBarState, ProgressBarStatus};
    use tauri::{Emitter, Manager};
    let _ = app.emit(UPDATE_PROGRESS_EVENT, update_progress_payload(state.as_ref()));
    let Some(window) = app.get_webview_window("main") else { return };
    match state {
        Some(progress) => {
            let percent = progress.percent;
            let _ = window.set_title(&progress.title());
            let _ = window.set_progress_bar(ProgressBarState {
                status: Some(if percent.is_some() {
                    ProgressBarStatus::Normal
                } else {
                    ProgressBarStatus::Indeterminate
                }),
                progress: percent.map(u64::from),
            });
        }
        None => {
            let _ = window.set_title("Liaison");
            let _ = window.set_progress_bar(ProgressBarState {
                status: Some(ProgressBarStatus::None),
                progress: None,
            });
        }
    }
}

/// Where the macOS install should put its temporary directories (D35).
///
/// tauri-plugin-updater 2.13.1 extracts the new bundle into a temp dir and
/// moves the old one into a backup temp dir, both with a plain `rename`, and
/// recovers only from a permission error. With TMPDIR on another volume than
/// the bundle (the owner's Mac keeps it on an external drive) the rename fails
/// with "Cross-device link (os error 18)" and the update never installs. The
/// plugin takes those dirs from `tempfile`, which reads `std::env::temp_dir()`
/// on every call, which reads TMPDIR on every call: so pointing TMPDIR at the
/// bundle's volume for the install is enough, and nothing about the download
/// or its signature check changes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallTempDir {
    /// The temp dir is on the bundle's volume, or a device could not be read:
    /// the plugin's own behaviour, unchanged.
    Keep,
    /// Install with TMPDIR set to this directory, on the bundle's volume.
    Use(std::path::PathBuf),
}

/// The decision, over an injected device lookup so it is testable without
/// two volumes. The caches folder when the home shares the bundle's volume,
/// otherwise a hidden sibling of the bundle.
pub fn install_temp_dir(
    temp: &std::path::Path,
    bundle: &std::path::Path,
    home: Option<&std::path::Path>,
    identifier: &str,
    device: impl Fn(&std::path::Path) -> Option<u64>,
) -> InstallTempDir {
    let (Some(temp_dev), Some(bundle_dev)) = (device(temp), device(bundle)) else {
        return InstallTempDir::Keep;
    };
    if temp_dev == bundle_dev {
        return InstallTempDir::Keep;
    }
    if let Some(home) = home.filter(|home| device(home) == Some(bundle_dev)) {
        return InstallTempDir::Use(
            home.join("Library/Caches").join(identifier).join("update-tmp"),
        );
    }
    match bundle.parent() {
        Some(parent) => InstallTempDir::Use(parent.join(format!(".{identifier}-update-tmp"))),
        None => InstallTempDir::Keep,
    }
}

/// The device a path lives on, or None when it cannot be read.
#[cfg(unix)]
pub fn device_of(path: &std::path::Path) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).ok().map(|metadata| metadata.dev())
}

/// TMPDIR pointed at a private directory for as long as this lives; dropping
/// it restores the previous value and removes the directory.
#[cfg(unix)]
pub struct TmpDirOverride {
    previous: Option<std::ffi::OsString>,
    dir: std::path::PathBuf,
}

#[cfg(unix)]
impl TmpDirOverride {
    pub fn apply(dir: &std::path::Path) -> std::io::Result<Self> {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
        // A directory left by an earlier run, or a symlink planted in its
        // place, is not trusted as is.
        let metadata = std::fs::symlink_metadata(dir)?;
        if !metadata.is_dir() {
            return Err(std::io::Error::other("update temp dir is not a directory"));
        }
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        let previous = std::env::var_os("TMPDIR");
        std::env::set_var("TMPDIR", dir);
        Ok(Self { previous, dir: dir.to_path_buf() })
    }
}

#[cfg(unix)]
impl Drop for TmpDirOverride {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(previous) => std::env::set_var("TMPDIR", previous),
            None => std::env::remove_var("TMPDIR"),
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Before the macOS install: keep the plugin's temp dirs on the bundle's
/// volume. The guard must outlive the install. Elsewhere it does nothing (the
/// plugin's Linux path already finds a same-volume dir on its own, Windows
/// runs an installer).
#[cfg(not(debug_assertions))]
fn same_volume_tmpdir_for_install(
    app: &tauri::AppHandle,
    note: &(dyn Fn(&str) + Sync),
) -> Option<Box<dyn std::any::Any + Send>> {
    #[cfg(target_os = "macos")]
    {
        let bundle = std::env::current_exe()
            .ok()
            .and_then(|exe| tauri_plugin_updater::extract_path_from_executable(&exe).ok())?;
        let temp = std::env::temp_dir();
        let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
        let identifier = app.config().identifier.clone();
        match install_temp_dir(&temp, &bundle, home.as_deref(), &identifier, device_of) {
            InstallTempDir::Keep => None,
            InstallTempDir::Use(dir) => match TmpDirOverride::apply(&dir) {
                Ok(guard) => {
                    note(&format!(
                        "temp dir {} is not on the volume of {}; installing through {}",
                        temp.display(),
                        bundle.display(),
                        dir.display()
                    ));
                    Some(Box::new(guard))
                }
                Err(error) => {
                    note(&format!("could not prepare {}: {error}", dir.display()));
                    None
                }
            },
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, note);
        None
    }
}

/// Everything after the yes. An error is for the failure dialog; `Ok` means
/// the process is on its way out (Windows) or restarting (macOS, Linux), or
/// that the user has already been told why it is not.
#[cfg(not(debug_assertions))]
async fn install_accepted(
    app: &tauri::AppHandle,
    update: &tauri_plugin_updater::Update,
    note: &(dyn Fn(&str) + Sync),
) -> Result<(), String> {
    let version = update.version.clone();
    let mut gate = ProgressGate::default();
    let progress_app = app.clone();
    let progress_version = version.clone();
    let on_chunk = move |len: usize, total: Option<u64>| {
        if let Some(percent) = gate.chunk(len, total) {
            show_progress(
                &progress_app,
                Some(UpdateProgress {
                    version: progress_version.clone(),
                    phase: UpdatePhase::Downloading,
                    percent,
                    received: gate.received(),
                }),
            );
        }
    };
    let finished_app = app.clone();
    let finished_version = version.clone();
    let on_finished = move || {
        show_progress(
            &finished_app,
            Some(UpdateProgress {
                version: finished_version.clone(),
                phase: UpdatePhase::Installing,
                percent: None,
                received: 0,
            }),
        );
    };
    show_progress(
        app,
        Some(UpdateProgress {
            version: version.clone(),
            phase: UpdatePhase::Downloading,
            percent: None,
            received: 0,
        }),
    );
    note(&format!("downloading {version} from {}", update.download_url));

    match after_install(platform()) {
        AfterInstall::InstallerRelaunches => {
            // The plugin still downloads, and still verifies the signature
            // against the public key in tauri.conf.json: only the launch is
            // the shell's own.
            let bytes = update
                .download(on_chunk, on_finished)
                .await
                .map_err(|error| format!("download: {error}"))?;
            note(&format!("downloaded and verified {} bytes", bytes.len()));
            if !is_windows_installer(&bytes) {
                // An archive (a future `.nsis.zip`): the plugin knows how to
                // unpack it, so it launches it, after the local work stops.
                note("payload is not an executable, handing it to the plugin");
                let stopping = app.clone();
                off_the_runtime(move || crate::stop_local_work(&stopping));
                return update.install(bytes).map_err(|error| format!("install: {error}"));
            }
            // BEFORE anything is stopped: an installer Windows will refuse to
            // start is not worth quitting for.
            let control = read_smart_app_control();
            let signed = has_authenticode_signature(&bytes);
            note(&format!("smart app control {control:?}, installer signed {signed}"));
            if windows_install_gate(control, signed) == InstallGate::BlockedBySmartAppControl {
                note("not installing: smart app control would block the installer");
                // Rule 8: the periodic check would download it again only to
                // be blocked again. The next start or a manual check retries.
                remember(|memory| memory.declined = Some(version.clone()));
                show_progress(app, None);
                use tauri_plugin_dialog::DialogExt;
                let (title, message) = blocked_prompt(&version);
                app.dialog()
                    .message(message)
                    .title(title)
                    .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
                    .blocking_show();
                return Ok(());
            }
            let path = installer_path(&std::env::temp_dir(), &version);
            write_installer(&path, &bytes)?;
            note(&format!("installer written to {}", path.display()));
            // THE LOCAL WORK STOPS FIRST, cleanly, while the shell is still
            // here to wait for it: the session's sidecar and a sign in child
            // hold liaison-sidecar.exe open, and the installer cannot replace
            // a file a running process was started from.
            let stopping = app.clone();
            off_the_runtime(move || crate::stop_local_work(&stopping));
            note("local session and sign in stopped");
            let pid = launch_installer(&path, &NSIS_UPDATE_ARGS)?;
            note(&format!("installer started, pid {pid}; quitting so it can replace the files"));
            // The same exit a click on Quit takes: RunEvent::Exit runs, the
            // single instance mutex is released, and the installer's own
            // check finds nothing left to kill.
            app.exit(0);
            Ok(())
        }
        AfterInstall::RestartHere => {
            // D35: the plugin renames the old bundle into a temp dir; across
            // volumes that is os error 18. Held until the install returns.
            let same_volume = same_volume_tmpdir_for_install(app, note);
            let installed = update
                .download_and_install(on_chunk, on_finished)
                .await
                .map_err(|error| format!("install: {error}"));
            drop(same_volume);
            installed?;
            note("installed; restarting");
            // Through the event loop, so RunEvent::Exit stops the local work
            // and the single instance socket is removed before the new copy
            // starts and looks for it.
            app.request_restart();
            Ok(())
        }
    }
}

/// A development build asks no endpoint anything.
///
/// The policy above is still compiled and still runs, over a synthetic "an
/// update exists" answer, so rule 1 is exercised by every debug launch rather
/// than only by the unit test below. It also means the decision cannot rot
/// into dead code on the build a developer spends the day in.
#[cfg(debug_assertions)]
pub fn check_on_start(_app: tauri::AppHandle) {
    let (title, _) = update_prompt("any");
    assert_dev_does_nothing(&[CheckTrigger::Startup, CheckTrigger::Periodic]);
    eprintln!("liaison: development build, no update check ({title} is release only)");
}

/// The menu item exists on a development build too; it checks nothing.
#[cfg(debug_assertions)]
pub fn check_now(_app: tauri::AppHandle) {
    assert_dev_does_nothing(&[CheckTrigger::Manual]);
    eprintln!("liaison: development build, Check for Updates checks nothing");
}

/// The page's quiet ask, on a development build: it checks nothing.
#[cfg(debug_assertions)]
pub fn check_quietly(_app: tauri::AppHandle) {
    assert_dev_does_nothing(&[CheckTrigger::Periodic]);
    eprintln!("liaison: development build, the page's update check checks nothing");
}

/// THE PAGE ASKS FOR A CHECK NOW: some app runs in compatibility mode because
/// the server moved past the web build this app carries (apps/web
/// `framework/compat-mode.ts`).
/// `manual` is a click on the page's "Check for updates", answered like the
/// menu item's; otherwise the quiet check. Both go through `run_check`, so
/// the one-at-a-time claim, the policy and the yes before any install apply.
#[tauri::command]
pub fn check_for_updates(app: tauri::AppHandle, manual: bool) {
    if manual {
        check_now(app);
    } else {
        check_quietly(app);
    }
}

/// Every answer the endpoint could have given, run through the policy: on a
/// development build all of them have to come out the same way.
#[cfg(debug_assertions)]
fn assert_dev_does_nothing(triggers: &[CheckTrigger]) {
    for &trigger in triggers {
        for pretend in [
            UpdateCheck::UpToDate,
            UpdateCheck::Failed { error: "no check was made".to_string() },
            UpdateCheck::Available { version: "any".to_string() },
        ] {
            match decide_for(trigger, build_kind(), pretend, None) {
                UpdateAction::DoNothing => {}
                other => unreachable!("a development build must do nothing, decided {other:?}"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn a_development_build_never_acts_on_an_available_update() {
        assert_eq!(
            decide(
                BuildKind::Dev,
                UpdateCheck::Available { version: "9.9.9".to_string() }
            ),
            UpdateAction::DoNothing
        );
    }

    #[test]
    fn a_development_build_stays_quiet_about_a_failed_check_too() {
        assert_eq!(
            decide(
                BuildKind::Dev,
                UpdateCheck::Failed { error: "offline".to_string() }
            ),
            UpdateAction::DoNothing
        );
    }

    #[test]
    fn a_current_release_build_does_nothing() {
        assert_eq!(decide(BuildKind::Release, UpdateCheck::UpToDate), UpdateAction::DoNothing);
    }

    #[test]
    fn a_failed_check_is_logged_and_never_shown() {
        assert_eq!(
            decide(
                BuildKind::Release,
                UpdateCheck::Failed { error: "dns".to_string() }
            ),
            UpdateAction::LogFailure { error: "dns".to_string() }
        );
    }

    #[test]
    fn an_available_update_asks_before_anything_else() {
        assert_eq!(
            decide(
                BuildKind::Release,
                UpdateCheck::Available { version: "0.2.0".to_string() }
            ),
            UpdateAction::AskUser { version: "0.2.0".to_string() }
        );
    }

    /// The action that installs is reachable from exactly one arm, and that
    /// arm is the one that asked. Read from the source rather than asserted
    /// about a mock, because the arm is compiled out of this test binary.
    /// Every call that downloads, installs or launches an installer counts:
    /// the Windows path downloads and launches on its own (2026-09-28), and a
    /// second caller of any of them would be an update nobody agreed to.
    #[test]
    fn the_install_call_sits_behind_the_confirmation() {
        const SOURCE: &str = include_str!("updater.rs");
        let production = &SOURCE[..SOURCE.find("#[cfg(test)]").expect("a test module")];
        // The only place that installs, and the only call to it.
        let flow_at = production
            .find("async fn install_accepted(")
            .expect("the install flow");
        let flow = &production[flow_at..];
        let flow_end = flow_at + flow.find("\n}\n").expect("the flow is closed");
        let caller = concat!("install_accepted", "(&app");
        assert_eq!(production.matches(caller).count(), 1, "more than one caller installs");
        let call = production.find(caller).unwrap();
        // The call sits behind the dialog's answer.
        let ask = production.find("blocking_show").expect("the confirmation is shown");
        let refused = production.find("if !accepted {").expect("a no is honoured");
        assert!(ask < refused && refused < call, "the install is not behind the confirmation");
        // Assembled rather than written out, so this test is not itself one of
        // the occurrences it counts.
        for needle in [
            concat!(".download_and", "_install("),
            concat!(".down", "load("),
            concat!("update.", "install("),
            concat!("launch_", "installer(&"),
        ] {
            let mut found = 0;
            for (at, _) in production.match_indices(needle) {
                found += 1;
                assert!(
                    flow_at < at && at < flow_end,
                    "{needle} is called outside the confirmed install flow"
                );
            }
            assert_eq!(found, 1, "{needle}: expected exactly one call");
        }
    }

    #[test]
    fn the_prompt_carries_no_dash_punctuation() {
        let (title, message) = update_prompt("0.2.0");
        for text in [title, message] {
            assert!(!text.contains('\u{2014}'), "em dash in customer copy");
            assert!(!text.contains('\u{2013}'), "en dash in customer copy");
            assert!(!text.contains("--"), "double hyphen in customer copy");
            assert!(text.is_ascii(), "customer copy is plain ascii");
        }
    }

    #[test]
    fn the_prompt_names_the_version_and_says_the_session_stops() {
        let (_, message) = update_prompt("1.2.3");
        assert!(message.contains("1.2.3"));
        assert!(message.contains("stopped"));
    }

    // ---- The checks after the first (rules 7 to 9) ---------------------------

    fn available(version: &str) -> UpdateCheck {
        UpdateCheck::Available { version: version.to_string() }
    }

    #[test]
    fn a_development_build_does_nothing_whatever_started_the_check() {
        for trigger in [CheckTrigger::Startup, CheckTrigger::Periodic, CheckTrigger::Manual] {
            for check in [
                UpdateCheck::UpToDate,
                UpdateCheck::Failed { error: "dns".to_string() },
                available("9.9.9"),
            ] {
                assert_eq!(
                    decide_for(trigger, BuildKind::Dev, check, None),
                    UpdateAction::DoNothing
                );
            }
        }
    }

    #[test]
    fn only_the_manual_check_speaks_when_there_is_nothing_to_install() {
        let release = BuildKind::Release;
        for trigger in [CheckTrigger::Startup, CheckTrigger::Periodic] {
            assert_eq!(decide_for(trigger, release, UpdateCheck::UpToDate, None), UpdateAction::DoNothing);
            assert_eq!(
                decide_for(trigger, release, UpdateCheck::Failed { error: "dns".into() }, None),
                UpdateAction::LogFailure { error: "dns".into() }
            );
        }
        assert_eq!(
            decide_for(CheckTrigger::Manual, release, UpdateCheck::UpToDate, None),
            UpdateAction::TellUpToDate
        );
        assert_eq!(
            decide_for(CheckTrigger::Manual, release, UpdateCheck::Failed { error: "dns".into() }, None),
            UpdateAction::ShowFailure { error: "dns".into() }
        );
    }

    #[test]
    fn a_declined_version_is_not_offered_again_by_the_periodic_check() {
        let release = BuildKind::Release;
        let ask = |version: &str| UpdateAction::AskUser { version: version.to_string() };
        assert_eq!(
            decide_for(CheckTrigger::Periodic, release, available("0.2.0"), Some("0.2.0")),
            UpdateAction::DoNothing
        );
        // A newer release than the one declined is news.
        assert_eq!(
            decide_for(CheckTrigger::Periodic, release, available("0.2.1"), Some("0.2.0")),
            ask("0.2.1")
        );
        // The user asked: the manual check offers it again.
        assert_eq!(
            decide_for(CheckTrigger::Manual, release, available("0.2.0"), Some("0.2.0")),
            ask("0.2.0")
        );
        assert_eq!(
            decide_for(CheckTrigger::Periodic, release, available("0.2.0"), None),
            ask("0.2.0")
        );
    }

    #[test]
    fn the_periodic_check_is_due_six_hours_of_wall_clock_after_the_last() {
        use std::time::{Duration, SystemTime};
        let now = SystemTime::now();
        assert!(recheck_due(None, now), "no check yet");
        assert!(!recheck_due(Some(now), now));
        assert!(!recheck_due(Some(now - Duration::from_secs(5 * 60 * 60 + 59 * 60)), now));
        assert!(recheck_due(Some(now - RECHECK_INTERVAL), now));
        // A machine that slept through the night: due at the first tick after.
        assert!(recheck_due(Some(now - Duration::from_secs(14 * 60 * 60)), now));
        // A clock set back: due, once (the check resets `last`).
        assert!(recheck_due(Some(now + Duration::from_secs(60)), now));
        assert_eq!(RECHECK_INTERVAL, Duration::from_secs(6 * 60 * 60));
        assert!(RECHECK_TICK < RECHECK_INTERVAL / 10);
    }

    #[test]
    fn one_check_at_a_time_and_the_claim_is_released_on_every_way_out() {
        static FLAG: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        let first = InFlight::try_begin(&FLAG).expect("free");
        assert!(InFlight::try_begin(&FLAG).is_none(), "a second check while one runs");
        drop(first);
        let again = InFlight::try_begin(&FLAG);
        assert!(again.is_some(), "released when the first ended");
        drop(again);
        // Across threads too: exactly one of many simultaneous checks wins.
        let wins = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let wins = wins.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let claim = InFlight::try_begin(&FLAG);
                    if claim.is_some() {
                        wins.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    }
                    // Held until every thread has tried.
                    barrier.wait();
                    drop(claim);
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(wins.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    /// Every trigger goes through the one flow: one policy call, one prompt,
    /// one install call (pinned above), and the claim is taken before the
    /// network is asked anything.
    #[test]
    fn every_check_runs_the_one_flow_behind_the_in_flight_claim() {
        let flow = body_of("async fn run_check(");
        let claim = flow.find("InFlight::try_begin(&UPDATE_IN_FLIGHT)").expect("the claim");
        let network = flow.find(".check().await").expect("the check");
        assert!(claim < network, "the network is asked before the claim");
        // One real policy call (the other is the development build's self check).
        assert_eq!(production().matches("decide_for(trigger, build_kind(), outcome").count(), 1);
        assert_eq!(production().matches(".check().await").count(), 1);
        for trigger in ["CheckTrigger::Startup", "CheckTrigger::Periodic", "CheckTrigger::Manual"] {
            assert!(
                production().contains(&format!("run_check(app.clone(), {trigger})"))
                    || production().contains(&format!("run_check(app, {trigger})")),
                "{trigger} does not run the flow"
            );
        }
        // A no is remembered, and so is a failed install (its dialog promises
        // the next start or a manual check, not six hours).
        let refused = &flow[flow.find("if !accepted {").unwrap()..];
        let refused = &refused[..refused.find("return;").unwrap()];
        assert!(refused.contains("memory.declined = Some(version.clone())"));
        let failed = &flow[flow.find("FAILED").unwrap()..flow.find("failure_prompt(").unwrap()];
        assert!(failed.contains("memory.declined = Some(version.clone())"));
        // The periodic loop reads the wall clock.
        let periodic = body_of("async fn recheck_while_running(");
        assert!(periodic.contains("recheck_due(last, std::time::SystemTime::now())"));
    }

    #[test]
    fn a_manual_click_while_a_check_runs_is_answered_and_the_others_stay_quiet() {
        assert_eq!(when_busy(CheckTrigger::Manual), BusyAnswer::TellBusy);
        assert_eq!(when_busy(CheckTrigger::Startup), BusyAnswer::Silent);
        assert_eq!(when_busy(CheckTrigger::Periodic), BusyAnswer::Silent);
        // The answer is given on the refused claim, before any network call.
        let flow = body_of("async fn run_check(");
        let refused = &flow[flow.find("InFlight::try_begin(&UPDATE_IN_FLIGHT) else {").unwrap()..];
        let refused = &refused[..refused.find("return;").unwrap()];
        assert!(refused.contains("when_busy(trigger) == BusyAnswer::TellBusy"));
        assert!(refused.contains("busy_prompt()") && refused.contains("blocking_show()"));
        assert!(!refused.contains(".check()"));
        for text in [busy_prompt().0, busy_prompt().1] {
            assert!(!text.contains('\u{2014}') && !text.contains('\u{2013}') && !text.contains("--"));
            assert!(text.is_ascii(), "customer copy is plain ascii: {text}");
        }
    }

    /// A version Smart App Control blocked is remembered like a declined one:
    /// otherwise the six hourly check downloads 100 MB again only to show
    /// "Update not installed" again.
    #[test]
    fn a_version_smart_app_control_blocked_is_not_offered_again_by_the_periodic_check() {
        let flow = body_of("async fn install_accepted");
        let gate = flow.find("InstallGate::BlockedBySmartAppControl").expect("the gate");
        let blocked = &flow[gate..];
        let blocked = &blocked[..blocked.find("return Ok(());").expect("returns")];
        assert!(blocked.contains("memory.declined = Some(version.clone())"));
        // And what is remembered is what the periodic policy reads.
        assert_eq!(
            decide_for(CheckTrigger::Periodic, BuildKind::Release, available("0.2.0"), Some("0.2.0")),
            UpdateAction::DoNothing
        );
    }

    #[test]
    fn the_manual_check_answers_up_to_date_and_failure_aloud() {
        let flow = body_of("async fn run_check(");
        for (arm, prompt) in [
            ("UpdateAction::TellUpToDate =>", "up_to_date_prompt("),
            ("UpdateAction::ShowFailure { error } =>", "check_failed_prompt("),
        ] {
            let body = &flow[flow.find(arm).unwrap_or_else(|| panic!("{arm}"))..];
            let shown = body.find("blocking_show()").expect("shown");
            assert!(body[..shown].contains(prompt), "{arm} shows {prompt}");
        }
        let (_, message) = up_to_date_prompt("0.1.23");
        assert_eq!(message, "You're up to date (version 0.1.23).");
        assert!(check_failed_prompt("dns").1.contains("Details: dns"));
        for text in [
            up_to_date_prompt("0.1.23").0,
            check_failed_prompt("dns").0,
            check_failed_prompt("dns").1,
        ] {
            assert!(!text.contains('\u{2014}') && !text.contains('\u{2013}') && !text.contains("--"));
            assert!(text.is_ascii(), "customer copy is plain ascii: {text}");
        }
    }

    // ---- After the yes (the 2026-09-28 incident) ----------------------------

    fn read_only(_: &Path) -> std::io::Result<()> {
        Err(std::io::Error::from_raw_os_error(30))
    }
    fn denied(_: &Path) -> std::io::Result<()> {
        Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
    }
    fn writable(_: &Path) -> std::io::Result<()> {
        Ok(())
    }

    #[test]
    fn a_mac_app_run_from_the_disk_image_is_told_to_move() {
        // 2026-10-30: the app opened inside the mounted DMG.
        let bundle = Path::new("/Volumes/Liaison/Liaison.app");
        assert_eq!(
            install_block(Platform::MacOs, Some(bundle), read_only),
            Some(InstallBlock::MoveToApplications)
        );
    }

    #[test]
    fn a_translocated_mac_app_is_told_to_move_whatever_the_probe_says() {
        let bundle = Path::new(
            "/private/var/folders/xy/abc/T/AppTranslocation/1234-ABCD/d/Liaison.app",
        );
        for probe in [read_only, denied, writable] {
            assert_eq!(
                install_block(Platform::MacOs, Some(bundle), probe),
                Some(InstallBlock::MoveToApplications)
            );
        }
    }

    #[test]
    fn a_mac_app_in_applications_installs_even_without_write_access() {
        // A standard account: the plugin asks for an administrator there.
        let bundle = Path::new("/Applications/Liaison.app");
        assert_eq!(install_block(Platform::MacOs, Some(bundle), writable), None);
        assert_eq!(install_block(Platform::MacOs, Some(bundle), denied), None);
        assert_eq!(install_block(Platform::MacOs, None, read_only), None);
    }

    #[test]
    fn a_linux_package_install_is_not_offered_the_appimage() {
        assert_eq!(
            install_block(Platform::Linux, None, writable),
            Some(InstallBlock::PackageManaged)
        );
    }

    #[test]
    fn a_linux_appimage_installs_only_where_it_can_be_replaced() {
        let appimage = Path::new("/home/user/Applications/Liaison.AppImage");
        assert_eq!(install_block(Platform::Linux, Some(appimage), writable), None);
        for probe in [read_only, denied] {
            assert_eq!(
                install_block(Platform::Linux, Some(appimage), probe),
                Some(InstallBlock::AppImageNotWritable)
            );
        }
    }

    #[test]
    fn windows_is_never_blocked_here() {
        assert_eq!(install_block(Platform::Windows, None, read_only), None);
    }

    #[test]
    fn the_write_probe_reports_a_writable_folder_and_leaves_nothing() {
        let dir = std::env::temp_dir().join(format!("liaison-probe-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(probe_writable(&dir).is_ok());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "the probe file is removed");
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(probe_writable(&dir).is_err(), "a missing folder is not writable");
    }

    #[test]
    fn the_install_block_copy_is_plain_and_names_the_version() {
        for block in [
            InstallBlock::MoveToApplications,
            InstallBlock::PackageManaged,
            InstallBlock::AppImageNotWritable,
        ] {
            let (title, message) = install_block_prompt("0.2.0", block);
            assert!(message.contains("0.2.0"));
            for text in [title, message] {
                assert!(!text.contains('\u{2014}') && !text.contains('\u{2013}') && !text.contains("--"));
                assert!(text.is_ascii(), "customer copy is plain ascii");
            }
        }
        let (_, mac) = install_block_prompt("0.2.0", InstallBlock::MoveToApplications);
        assert!(mac.contains("Applications"));
    }

    /// The check runs before the update question, so nobody says yes to an
    /// install that cannot happen.
    #[test]
    fn the_install_block_is_checked_before_the_question() {
        let check = body_of("async fn run_check(");
        let blocked = check.find("install_block(platform()").expect("the check runs");
        let asked = check.find("update_prompt(&version)").expect("the question");
        assert!(blocked < asked, "the block check comes after the question");
    }

    /// The production half of this file, which the source reads below look at.
    fn production() -> &'static str {
        const SOURCE: &str = include_str!("updater.rs");
        &SOURCE[..SOURCE.find("#[cfg(test)]").expect("a test module")]
    }

    /// The body of one production fn, up to its closing brace at column 0.
    fn body_of(signature: &str) -> &'static str {
        let source = production();
        let at = source
            .find(signature)
            .unwrap_or_else(|| panic!("updater.rs has no {signature}"));
        let body = &source[at..];
        &body[..body.find("\n}\n").expect("the fn is closed")]
    }

    #[test]
    fn macos_and_linux_restart_the_app_after_installing() {
        // The plugin's install replaces the bundle and RETURNS there: without
        // a restart the old copy keeps running and the prompt's "restart" was
        // a promise nobody kept.
        assert_eq!(after_install(Platform::MacOs), AfterInstall::RestartHere);
        assert_eq!(after_install(Platform::Linux), AfterInstall::RestartHere);
        assert_eq!(after_install(Platform::Windows), AfterInstall::InstallerRelaunches);
        let flow = body_of("async fn install_accepted");
        let arm = &flow[flow.find("AfterInstall::RestartHere =>").expect("the restart arm")..];
        let install = arm.find(concat!("download_and", "_install")).expect("installs");
        let restart = arm.find("request_restart()").expect("the restart arm restarts");
        assert!(install < restart, "restarts before the install finished");
    }

    #[test]
    fn the_windows_installer_is_passive_in_update_mode_and_relaunches() {
        assert_eq!(NSIS_UPDATE_ARGS, ["/P", "/UPDATE", "/R"]);
        // Never /S: a silent installer shows nothing, which is the failure.
        assert!(!NSIS_UPDATE_ARGS.contains(&"/S"));
    }

    #[test]
    fn on_windows_the_local_work_stops_before_the_installer_and_the_exit_comes_last() {
        let flow = body_of("async fn install_accepted");
        let arm = &flow[flow
            .find("AfterInstall::InstallerRelaunches =>")
            .expect("the windows arm")..flow.find("AfterInstall::RestartHere =>").unwrap()];
        let order = [
            ".download(",
            "windows_install_gate(",
            "write_installer(",
            "crate::stop_local_work(",
            "launch_installer(",
            "app.exit(0)",
        ];
        let mut last = 0;
        for step in order {
            let at = arm[last..]
                .find(step)
                .unwrap_or_else(|| panic!("{step} missing or out of order"))
                + last;
            last = at;
        }
        // The plugin's own path (ShellExecuteW then std::process::exit, which
        // skips RunEvent::Exit) is used only for a payload that is not an
        // executable, and only after the local work stopped too.
        let fallback = &arm[..arm.find("write_installer(").unwrap()];
        let stop = fallback.find("crate::stop_local_work(").expect("stops before the plugin installs");
        let install = fallback.find("update.install(").expect("the archive fallback");
        assert!(stop < install);
        // And the stop runs off the async runtime (see the test below).
        assert!(!arm.contains("\n            crate::stop_local_work("));
        assert_eq!(arm.matches("off_the_runtime(move || crate::stop_local_work").count(), 2);
    }

    #[test]
    fn the_exit_work_runs_off_the_async_runtime() {
        // The lease release blocks on tauri's runtime. Called from a task on a
        // runtime it panics ("Cannot start a runtime from within a runtime")
        // and nothing after it runs: the sidecar would never be stopped.
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let ran = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let seen = ran.clone();
        runtime.block_on(async move {
            off_the_runtime(move || {
                tauri::async_runtime::block_on(async {});
                seen.store(true, std::sync::atomic::Ordering::SeqCst);
            });
        });
        assert!(ran.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn a_failed_installer_start_is_an_error_and_a_started_one_a_pid() {
        let missing = std::env::temp_dir().join("liaison-no-such-installer.exe");
        let error = launch_installer(&missing, &NSIS_UPDATE_ARGS).unwrap_err();
        assert!(error.contains("could not start"), "{error}");
        // Any program that exits at once stands in for the installer.
        let program = if cfg!(windows) { "cmd" } else { "true" };
        let path = which(program);
        let args: &[&str] = if cfg!(windows) { &["/C", "exit"] } else { &[] };
        assert!(launch_installer(&path, args).unwrap() > 0);
    }

    fn which(program: &str) -> std::path::PathBuf {
        let path = std::env::var_os("PATH").unwrap();
        std::env::split_paths(&path)
            .map(|dir| dir.join(if cfg!(windows) { format!("{program}.exe") } else { program.to_string() }))
            .find(|candidate| candidate.is_file())
            .unwrap_or_else(|| panic!("{program} is not on PATH"))
    }

    #[test]
    fn the_installer_is_written_to_its_own_directory_named_for_the_version() {
        let temp = std::env::temp_dir().join(format!("liaison-updater-test-{}", std::process::id()));
        let path = installer_path(&temp, "0.2.0");
        assert_eq!(path, temp.join("liaison-update").join("Liaison_0.2.0_setup.exe"));
        // Nothing in a version string walks out of the directory.
        let hostile = installer_path(&temp, "../../x");
        assert_eq!(hostile.parent(), Some(temp.join("liaison-update").as_path()));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path.parent().unwrap().join("stale.exe"), b"old").unwrap();
        write_installer(&path, b"MZnew").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"MZnew");
        assert!(!path.parent().unwrap().join("stale.exe").exists());
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn only_an_executable_is_launched_directly() {
        assert!(is_windows_installer(b"MZ\x90\x00"));
        assert!(!is_windows_installer(b"PK\x03\x04"));
        assert!(!is_windows_installer(b""));
    }

    #[test]
    fn progress_is_a_percent_when_the_size_is_known() {
        assert_eq!(progress_percent(0, Some(200)), Some(0));
        assert_eq!(progress_percent(50, Some(200)), Some(25));
        assert_eq!(progress_percent(300, Some(200)), Some(100));
        assert_eq!(progress_percent(10, None), None);
        assert_eq!(progress_percent(10, Some(0)), None);
    }

    #[test]
    fn progress_redraws_once_per_percent_not_once_per_chunk() {
        let mut gate = ProgressGate::default();
        let total = Some(106_416_437);
        let mut draws = Vec::new();
        for _ in 0..(106_416_437 / 16_384 + 1) {
            if let Some(percent) = gate.chunk(16_384, total) {
                draws.push(percent);
            }
        }
        assert_eq!(draws.first(), Some(&Some(0)));
        assert_eq!(draws.last(), Some(&Some(100)));
        assert_eq!(draws.len(), 101, "one redraw per percent");
        // An unknown size redraws per megabyte.
        let mut gate = ProgressGate::default();
        let redraws = (0..64).filter(|_| gate.chunk(64 * 1024, None).is_some()).count();
        assert_eq!(redraws, 5, "the first chunk, then once per MB over 4 MB");
    }

    #[test]
    fn the_update_card_payload_names_the_version_the_phase_and_the_percent() {
        let downloading = UpdateProgress {
            version: "0.2.0".to_string(),
            phase: UpdatePhase::Downloading,
            percent: Some(42),
            received: 10,
        };
        assert_eq!(
            update_progress_payload(Some(&downloading)),
            serde_json::json!({ "version": "0.2.0", "phase": "downloading", "percent": 42 })
        );
        let unknown_size = UpdateProgress { percent: None, ..downloading.clone() };
        assert_eq!(
            update_progress_payload(Some(&unknown_size)),
            serde_json::json!({ "version": "0.2.0", "phase": "downloading", "percent": null })
        );
        let installing = UpdateProgress {
            phase: UpdatePhase::Installing,
            percent: None,
            ..downloading.clone()
        };
        assert_eq!(
            update_progress_payload(Some(&installing)),
            serde_json::json!({ "version": "0.2.0", "phase": "installing", "percent": null })
        );
        assert_eq!(update_progress_payload(None), serde_json::Value::Null);
        // The title keeps saying what it said before the card existed.
        assert_eq!(downloading.title(), progress_title("0.2.0", Some(42), 10));
        assert_eq!(installing.title(), installing_title("0.2.0"));
    }

    #[test]
    fn every_progress_change_reaches_the_page_as_an_event() {
        let show = body_of("fn show_progress(");
        assert!(
            show.contains(".emit(UPDATE_PROGRESS_EVENT, update_progress_payload(state.as_ref()))")
        );
        // Emitted before the window lookup, so a missing window cannot drop it.
        assert!(show.find(".emit(").unwrap() < show.find("get_webview_window").unwrap());
        assert_eq!(UPDATE_PROGRESS_EVENT, "liaison-update-progress");
        let flow = body_of("async fn install_accepted");
        assert!(flow.contains("phase: UpdatePhase::Downloading"));
        assert!(flow.contains("phase: UpdatePhase::Installing"));
    }

    #[test]
    fn the_progress_is_drawn_not_dropped() {
        // The callback used to be `|_, _| {}`: 106 MB downloaded with nothing
        // on screen, and the user concluded nothing was happening.
        let flow = body_of("async fn install_accepted");
        assert!(!flow.contains("|_, _| {}"));
        assert!(flow.contains("gate.chunk("));
        assert!(production().contains("set_progress_bar("));
        assert!(production().contains("set_title("));
    }

    #[test]
    fn a_failed_download_or_install_is_shown_not_only_logged() {
        // An eprintln is invisible in a Windows GUI app; the dialog is not.
        let check = body_of("async fn run_check(");
        let failed = &check[check.find("install_accepted(").expect("installs")..];
        let prompt = failed.find("failure_prompt(").expect("the failure is shown");
        assert!(failed[prompt..].contains("blocking_show()"));
        assert!(failed[..prompt].contains("note(&format!(\"FAILED"));
    }

    #[test]
    fn the_status_copy_carries_no_dash_punctuation() {
        let texts = [
            progress_title("0.2.0", Some(45), 0),
            progress_title("0.2.0", None, 5 * 1024 * 1024),
            installing_title("0.2.0"),
            failure_prompt("0.2.0", "network unreachable").0,
            failure_prompt("0.2.0", "network unreachable").1,
            blocked_prompt("0.2.0").0,
            blocked_prompt("0.2.0").1,
        ];
        for text in texts {
            assert!(!text.contains('\u{2014}'), "em dash in {text}");
            assert!(!text.contains('\u{2013}'), "en dash in {text}");
            assert!(!text.contains("--"), "double hyphen in {text}");
            assert!(!text.contains(" - "), "spaced hyphen in {text}");
            assert!(text.is_ascii(), "customer copy is plain ascii: {text}");
        }
        assert!(progress_title("0.2.0", Some(45), 0).contains("45%"));
        assert!(failure_prompt("0.2.0", "boom").1.contains("boom"));
    }

    /// A PE32 image with an empty or a filled security directory, the way
    /// the NSIS installer is laid out.
    fn pe32(signed: bool) -> Vec<u8> {
        let mut pe = vec![0u8; 0x200];
        pe[0..2].copy_from_slice(b"MZ");
        pe[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        pe[0x80..0x84].copy_from_slice(b"PE\0\0");
        let optional = 0x80 + 24;
        pe[optional..optional + 2].copy_from_slice(&0x10bu16.to_le_bytes());
        pe[optional + 92..optional + 96].copy_from_slice(&16u32.to_le_bytes());
        if signed {
            let security = optional + 96 + 4 * 8;
            pe[security..security + 4].copy_from_slice(&0x1000u32.to_le_bytes());
            pe[security + 4..security + 8].copy_from_slice(&0x2400u32.to_le_bytes());
        }
        pe
    }

    #[test]
    fn an_unsigned_installer_is_told_from_a_signed_one() {
        assert!(!has_authenticode_signature(&pe32(false)));
        assert!(has_authenticode_signature(&pe32(true)));
        // Truncated or foreign bytes are never "signed".
        assert!(!has_authenticode_signature(&pe32(true)[..0x90]));
        assert!(!has_authenticode_signature(b"PK\x03\x04"));
        assert!(!has_authenticode_signature(b""));
    }

    #[test]
    fn smart_app_control_reads_from_its_registry_value() {
        assert_eq!(smart_app_control(Some(1)), SmartAppControl::On);
        assert_eq!(smart_app_control(Some(2)), SmartAppControl::Evaluation);
        assert_eq!(smart_app_control(Some(0)), SmartAppControl::Off);
        assert_eq!(smart_app_control(None), SmartAppControl::Off);
        let output = "\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy\r\n    VerifiedAndReputablePolicyState    REG_DWORD    0x1\r\n\r\n";
        assert_eq!(parse_reg_dword(output, "VerifiedAndReputablePolicyState"), Some(1));
        assert_eq!(parse_reg_dword("ERREUR : impossible de trouver la clé", "VerifiedAndReputablePolicyState"), None);
    }

    #[test]
    fn an_unsigned_installer_under_smart_app_control_keeps_the_app_running() {
        // 2026-09-28: Smart App Control killed the unsigned 0.1.9 installer
        // AFTER the shell had quit for it. The user was left with no app.
        assert_eq!(
            windows_install_gate(SmartAppControl::On, false),
            InstallGate::BlockedBySmartAppControl
        );
        assert_eq!(windows_install_gate(SmartAppControl::On, true), InstallGate::Proceed);
        assert_eq!(windows_install_gate(SmartAppControl::Evaluation, false), InstallGate::Proceed);
        assert_eq!(windows_install_gate(SmartAppControl::Off, false), InstallGate::Proceed);
        // And the blocked arm returns before anything is stopped or started.
        let flow = body_of("async fn install_accepted");
        let gate = flow.find("InstallGate::BlockedBySmartAppControl").expect("the gate is read");
        let blocked = &flow[gate..];
        let returned = blocked.find("return Ok(());").expect("the blocked arm returns");
        assert!(blocked[..returned].contains("blocked_prompt("));
        assert!(!blocked[..returned].contains("stop_local_work"));
        assert!(!blocked[..returned].contains("app.exit"));
        assert!(gate < flow.find("launch_installer(").unwrap());
    }

    #[test]
    fn every_step_goes_to_the_update_log() {
        let dir = std::env::temp_dir().join(format!("liaison-update-log-{}", std::process::id()));
        let log = UpdateLog::in_dir(&dir);
        log.append("check: UpToDate");
        log.append("installer started, pid 42");
        let text = std::fs::read_to_string(dir.join(UPDATE_LOG_FILE)).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].ends_with("check: UpToDate"));
        assert!(lines[1].contains(concat!("[shell ", env!("CARGO_PKG_VERSION"))));
        let _ = std::fs::remove_dir_all(&dir);
        let flow = body_of("async fn install_accepted");
        for step in ["downloaded and verified", "installer written", "installer started", "restarting"] {
            assert!(flow.contains(step), "{step} is not logged");
        }
    }

    // D35, from the 0.1.28 walk: with TMPDIR on another volume than the
    // bundle, the plugin's rename of the old bundle into a backup under the
    // temp dir fails with "Cross-device link (os error 18)".

    fn fake_devices(map: &'static [(&'static str, u64)]) -> impl Fn(&Path) -> Option<u64> {
        move |path: &Path| {
            map.iter()
                .find(|(p, _)| Path::new(p) == path)
                .map(|(_, dev)| *dev)
        }
    }

    #[test]
    fn a_temp_dir_on_the_bundle_volume_is_kept() {
        let devices = fake_devices(&[("/tmp/x", 1), ("/Applications/Liaison.app", 1), ("/Users/m", 1)]);
        assert_eq!(
            install_temp_dir(
                Path::new("/tmp/x"),
                Path::new("/Applications/Liaison.app"),
                Some(Path::new("/Users/m")),
                "sh.liaison.desktop",
                devices,
            ),
            InstallTempDir::Keep
        );
    }

    #[test]
    fn a_temp_dir_on_another_volume_moves_to_the_caches_when_home_shares_the_bundle_volume() {
        let devices = fake_devices(&[
            ("/Volumes/Ext/tmp", 7),
            ("/Applications/Liaison.app", 1),
            ("/Users/m", 1),
        ]);
        assert_eq!(
            install_temp_dir(
                Path::new("/Volumes/Ext/tmp"),
                Path::new("/Applications/Liaison.app"),
                Some(Path::new("/Users/m")),
                "sh.liaison.desktop",
                devices,
            ),
            InstallTempDir::Use(PathBuf::from(
                "/Users/m/Library/Caches/sh.liaison.desktop/update-tmp"
            ))
        );
    }

    #[test]
    fn a_temp_dir_on_another_volume_moves_beside_the_bundle_when_home_is_elsewhere_too() {
        let devices = fake_devices(&[
            ("/Volumes/Ext/tmp", 7),
            ("/Applications/Liaison.app", 1),
            ("/Volumes/Ext/Users/m", 7),
        ]);
        assert_eq!(
            install_temp_dir(
                Path::new("/Volumes/Ext/tmp"),
                Path::new("/Applications/Liaison.app"),
                Some(Path::new("/Volumes/Ext/Users/m")),
                "sh.liaison.desktop",
                devices,
            ),
            InstallTempDir::Use(PathBuf::from("/Applications/.sh.liaison.desktop-update-tmp"))
        );
        // No home at all: beside the bundle as well.
        assert_eq!(
            install_temp_dir(
                Path::new("/Volumes/Ext/tmp"),
                Path::new("/Applications/Liaison.app"),
                None,
                "sh.liaison.desktop",
                fake_devices(&[("/Volumes/Ext/tmp", 7), ("/Applications/Liaison.app", 1)]),
            ),
            InstallTempDir::Use(PathBuf::from("/Applications/.sh.liaison.desktop-update-tmp"))
        );
    }

    #[test]
    fn an_unreadable_device_leaves_the_temp_dir_alone() {
        // Nothing to compare: the plugin's own behaviour, unchanged.
        assert_eq!(
            install_temp_dir(
                Path::new("/nowhere"),
                Path::new("/Applications/Liaison.app"),
                None,
                "sh.liaison.desktop",
                fake_devices(&[("/Applications/Liaison.app", 1)]),
            ),
            InstallTempDir::Keep
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_tmpdir_override_applies_for_the_install_and_is_restored_after() {
        use std::os::unix::fs::PermissionsExt;
        let before = std::env::var_os("TMPDIR");
        let dir = std::env::temp_dir()
            .join(format!("liaison-d35-{}", std::process::id()))
            .join("update-tmp");
        {
            let guard = TmpDirOverride::apply(&dir).expect("override applied");
            assert_eq!(std::env::var_os("TMPDIR"), Some(dir.clone().into_os_string()));
            assert_eq!(std::env::temp_dir(), dir);
            let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "the install dir is private");
            drop(guard);
        }
        assert_eq!(std::env::var_os("TMPDIR"), before, "TMPDIR restored");
        assert!(!dir.exists(), "the install dir is cleaned up");
        std::fs::remove_dir(dir.parent().unwrap()).ok();
    }

    #[test]
    fn the_restart_arm_installs_under_the_same_volume_temp_dir() {
        let flow = body_of("async fn install_accepted");
        let arm = &flow[flow.find("AfterInstall::RestartHere =>").expect("the restart arm")..];
        let guard = arm.find("same_volume_tmpdir_for_install(").expect("the temp dir is checked");
        let install = arm.find(concat!("download_and", "_install")).expect("installs");
        assert!(guard < install, "the temp dir is checked after the install");
    }
}
