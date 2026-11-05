// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE CLAUDE ACCOUNT THE LOCAL SESSIONS RUN ON, and signing in to it from the
// app (the sidecar half is `sidecar/claude-auth.ts`).
//
// A local turn runs on the Claude Code CLI embedded in the sidecar, with that
// CLI's own stored credentials. A person who never signed in to Claude Code
// had no way to fix a failed turn from here. Now the window can ask for the
// account (`claude_auth_status`), start a sign-in (`claude_auth_login`), hand
// over the code Claude's page shows (`claude_auth_submit_code`), give up
// (`claude_auth_cancel`) and open the page again (`claude_auth_reopen`).
// SIGNING OUT is not the window's to do: it signs the whole computer out of
// Claude, the person's own Claude Code included, so it lives only behind the
// shell's native confirmation (`account.rs` `ask_claude_sign_out`),
// which calls `sign_out` here. Each is the sidecar binary again, in its
// `--claude-auth` mode, so the CLI is the very one the turns run and it writes
// the credential exactly where they read it.
//
// THE WINDOW NEVER SEES A URL OR A CODE COME BACK. The sign-in URL goes from
// the sidecar to this module, is checked to be one of Claude's own https
// pages, and is opened with the shell's opener; the window only hears the
// phase (`liaison-claude-auth`). The code goes the other way, once, as a
// control line this module composes, and is written nowhere else: not to the
// sidecar log, not to an event, not to an error.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use url::Url;

use crate::sidecar::sidecar_log;

/// The event the window follows a sign-in on: `{ phase, account?, reason?, detail? }`.
pub const CLAUDE_AUTH_EVENT: &str = "liaison-claude-auth";

/// The refusals, as variants: the window owns the sentence.
pub const SIGN_IN_NOT_RUNNING: &str = "ClaudeSignInNotRunning";
pub const CODE_REFUSED: &str = "ClaudeCodeRefused";
pub const SIGN_IN_URL_REFUSED: &str = "ClaudeSignInUrlRefused";
pub const AUTH_UNREADABLE: &str = "ClaudeAuthUnreadable";
pub const AUTH_TIMED_OUT: &str = "ClaudeAuthTimedOut";
pub const PAGE_NOT_OPENED: &str = "ClaudeSignInPageNotOpened";

/// What the log says when the opener failed. Fixed words on purpose: the
/// opener's own error quotes the command it ran, and that command is the URL,
/// state and code challenge included (`open` 5.4.4, "Launcher ... failed").
pub const OPEN_FAILED_NOTE: &str = "the sign-in page did not open in the browser";

/// How long a status or a logout may take, sidecar start included.
pub const QUICK_TIMEOUT: Duration = Duration::from_secs(30);

/// The longest code the window may hand over. Claude's is well under this.
pub const MAX_CODE_LEN: usize = 2048;

/// How long a cancelled login's sidecar is waited for before it is killed. The
/// cancel measured 467 to 982 ms in review (the sidecar kills the CLI and waits
/// for it), so a fixed 750 ms usually killed it mid cancel. It is a CEILING:
/// the wait ends the moment the sidecar exits.
pub const LOGIN_EXIT_CEILING: Duration = Duration::from_millis(3_000);

/// How often that wait looks.
const LOGIN_EXIT_POLL: Duration = Duration::from_millis(25);

/// What the shell writes to a login child to give up on it.
pub const CANCEL_LINE: &str = r#"{"type":"cancel"}"#;

/// The account the local sessions use, as far as the window shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAccount {
    pub logged_in: bool,
    pub email: Option<String>,
}

/// Whether a URL is one of Claude's own sign-in pages: https, on claude.com,
/// claude.ai or anthropic.com or a subdomain of one, with no credentials and
/// no port. It is the only kind of URL this module ever opens.
pub fn validate_claude_sign_in_url(raw: &str) -> Result<Url, &'static str> {
    let url = Url::parse(raw).map_err(|_| SIGN_IN_URL_REFUSED)?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err(SIGN_IN_URL_REFUSED);
    }
    let host = url
        .host_str()
        .ok_or(SIGN_IN_URL_REFUSED)?
        .to_ascii_lowercase();
    let allowed = ["claude.com", "claude.ai", "anthropic.com"]
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")));
    if allowed {
        Ok(url)
    } else {
        Err(SIGN_IN_URL_REFUSED)
    }
}

/// The account out of a sidecar `account` object, or None.
pub fn account_from(value: Option<&serde_json::Value>) -> Option<ClaudeAccount> {
    let value = value?;
    let logged_in = value.get("loggedIn")?.as_bool()?;
    let email = value
        .get("email")
        .and_then(|email| email.as_str())
        .map(str::trim)
        .filter(|email| !email.is_empty())
        .map(str::to_string);
    Some(ClaudeAccount { logged_in, email })
}

/// The control line that hands the CLI a code. One line, or a refusal: a
/// newline inside it would be a second answer, and an empty one is none.
pub fn code_line(code: &str) -> Result<String, &'static str> {
    let code = code.trim();
    if code.is_empty() || code.len() > MAX_CODE_LEN || code.chars().any(char::is_control) {
        return Err(CODE_REFUSED);
    }
    Ok(serde_json::json!({ "type": "code", "code": code }).to_string())
}

/// What one stdout line of a login child means.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoginLine {
    /// The page to open, and the one whose page shows a code (the fallback).
    Url {
        url: String,
        manual_url: String,
    },
    CodeSent,
    CodeRejected,
    Done {
        ok: bool,
        account: Option<ClaudeAccount>,
        reason: Option<String>,
        detail: Option<String>,
    },
    Other,
}

fn text_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|text| text.as_str())
        .map(str::to_string)
}

/// Reads one line. A URL that is not one of Claude's pages is not a URL here.
pub fn login_line(line: &str) -> LoginLine {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return LoginLine::Other;
    };
    match value.get("type").and_then(|kind| kind.as_str()) {
        Some("claude_auth_url") => {
            let url =
                text_field(&value, "url").filter(|url| validate_claude_sign_in_url(url).is_ok());
            let manual = text_field(&value, "manualUrl")
                .filter(|url| validate_claude_sign_in_url(url).is_ok());
            match (url, manual) {
                (Some(url), Some(manual_url)) => LoginLine::Url { url, manual_url },
                (Some(url), None) => LoginLine::Url {
                    manual_url: url.clone(),
                    url,
                },
                (None, Some(manual_url)) => LoginLine::Url {
                    url: manual_url.clone(),
                    manual_url,
                },
                (None, None) => LoginLine::Other,
            }
        }
        Some("claude_auth_code_sent") => LoginLine::CodeSent,
        Some("claude_auth_code_rejected") => LoginLine::CodeRejected,
        Some("claude_auth_done") => LoginLine::Done {
            ok: value.get("ok").and_then(|ok| ok.as_bool()) == Some(true),
            account: account_from(value.get("account")),
            reason: text_field(&value, "reason"),
            detail: text_field(&value, "detail"),
        },
        _ => LoginLine::Other,
    }
}

/// What the window hears. Never a URL and never a code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAuthEvent {
    pub phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<ClaudeAccount>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl ClaudeAuthEvent {
    fn phase(phase: &'static str) -> Self {
        ClaudeAuthEvent {
            phase,
            account: None,
            reason: None,
            detail: None,
        }
    }
}

/// The event one login line becomes, or None for a line the window has no
/// business with.
pub fn event_for(line: &LoginLine) -> Option<ClaudeAuthEvent> {
    match line {
        LoginLine::Url { .. } => Some(ClaudeAuthEvent::phase("waiting")),
        LoginLine::CodeSent => Some(ClaudeAuthEvent::phase("checking")),
        LoginLine::CodeRejected => Some(ClaudeAuthEvent::phase("codeRejected")),
        LoginLine::Done {
            ok: true, account, ..
        } => Some(ClaudeAuthEvent {
            account: account.clone(),
            ..ClaudeAuthEvent::phase("signedIn")
        }),
        LoginLine::Done {
            ok: false,
            reason,
            detail,
            ..
        } => Some(ClaudeAuthEvent {
            reason: Some(reason.clone().unwrap_or_else(|| "failed".into())),
            detail: detail.clone(),
            ..ClaudeAuthEvent::phase("failed")
        }),
        LoginLine::Other => None,
    }
}

/// The sign-in running now, if any.
struct LoginSlot {
    child: CommandChild,
    pid: u32,
    /// The page to open again: the one whose page shows a code, so a person
    /// whose first page could not finish on its own always has a way through.
    reopen_url: Option<String>,
    /// Set by the follower when the child's `Terminated` arrives.
    exited: Arc<AtomicBool>,
}

/// One sign-in at a time, for the life of the app.
#[derive(Default)]
pub struct ClaudeLogin(Mutex<Option<LoginSlot>>);

/// Takes the slot when it still holds this child. A newer sign-in, or a
/// cancel, already took it otherwise, and this child's news is nobody's.
fn take_if_current(slot: &Mutex<Option<LoginSlot>>, pid: u32) -> Option<LoginSlot> {
    let mut held = slot.lock().ok()?;
    if held.as_ref().map(|login| login.pid) == Some(pid) {
        held.take()
    } else {
        None
    }
}

fn is_current(slot: &Mutex<Option<LoginSlot>>, pid: u32) -> bool {
    slot.lock()
        .map(|held| held.as_ref().map(|login| login.pid) == Some(pid))
        .unwrap_or(false)
}

/// Opens a Claude sign-in page with `open`, and says NOTHING of how an
/// opener failed beyond `OPEN_FAILED_NOTE`: its error is never formatted,
/// because it carries the URL it was handed. Generic over the opener so the
/// rule is testable without a browser.
pub fn open_sign_in_page<O, E, N>(url: &str, open: O, mut note: N) -> Result<(), &'static str>
where
    O: FnOnce(&str) -> Result<(), E>,
    N: FnMut(&'static str),
{
    let target = validate_claude_sign_in_url(url)?;
    open(target.as_str()).map_err(|_| {
        note(OPEN_FAILED_NOTE);
        PAGE_NOT_OPENED
    })
}

fn open_in_browser<R: Runtime>(
    app: &AppHandle<R>,
    url: &str,
    note: impl FnMut(&'static str),
) -> Result<(), &'static str> {
    open_sign_in_page(
        url,
        |target| {
            // The same opener `open_oauth_url` uses (sidecar.rs), for the same reason.
            #[allow(deprecated)]
            app.shell().open(target, None)
        },
        note,
    )
}

/// Records the account the shell holds (`account.rs`): the start check's cached
/// sign-in and the sign-out question's email.
fn note_account<R: Runtime>(app: &AppHandle<R>, account: Option<ClaudeAccount>) {
    crate::account::set_claude_account(app, account);
}

fn emit<R: Runtime>(app: &AppHandle<R>, event: ClaudeAuthEvent) {
    let _ = app.emit(CLAUDE_AUTH_EVENT, event);
}

/// Runs one short `--claude-auth` mode and answers its line (`claude_auth_<mode>`).
async fn run_quick<R: Runtime>(
    app: &AppHandle<R>,
    mode: &str,
) -> Result<serde_json::Value, String> {
    run_one_line(
        app,
        &["--claude-auth", mode],
        &format!("claude_auth_{mode}"),
        QUICK_TIMEOUT,
    )
    .await
}

/// Runs the sidecar once with `args` and answers its first line of type `wanted`.
pub(crate) async fn run_one_line<R: Runtime>(
    app: &AppHandle<R>,
    args: &[&str],
    wanted: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let (mut receiver, child) = app
        .shell()
        .sidecar("liaison-sidecar")
        .map_err(|error| error.to_string())?
        .args(args)
        .spawn()
        .map_err(|error| error.to_string())?;
    let pid = child.pid();
    let log = sidecar_log(app);
    let collect = async {
        let mut answer = None;
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) {
                        if value.get("type").and_then(|kind| kind.as_str()) == Some(wanted) {
                            answer = Some(value);
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    if let Some(log) = log.as_ref() {
                        log.append(pid, String::from_utf8_lossy(&bytes).trim_end());
                    }
                }
                CommandEvent::Terminated(_) | CommandEvent::Error(_) => break,
                _ => {}
            }
        }
        answer
    };
    match tokio::time::timeout(timeout, collect).await {
        Ok(Some(value)) => Ok(value),
        Ok(None) => Err(AUTH_UNREADABLE.into()),
        Err(_) => {
            let _ = child.kill();
            Err(AUTH_TIMED_OUT.into())
        }
    }
}

/// How long the bundled SDK may take to say its models, sidecar and CLI start
/// included (about 5 s measured on SDK 0.3.296).
pub const LOCAL_MODELS_TIMEOUT: Duration = Duration::from_secs(60);

/// The models line's answer: the list as the sidecar said it, or the refusal.
/// Only a non-empty array of `{id, label}` rows counts; the window checks every
/// row again (`parseLocalModels`).
pub fn local_models_answer(line: &serde_json::Value) -> Result<serde_json::Value, String> {
    match line.get("models") {
        Some(serde_json::Value::Array(rows)) if !rows.is_empty() => {
            Ok(serde_json::Value::Array(rows.clone()))
        }
        _ => Err(LOCAL_MODELS_UNAVAILABLE.into()),
    }
}

/// The refusal when the bundled SDK did not say its models.
pub const LOCAL_MODELS_UNAVAILABLE: &str = "LocalModelsUnavailable";

/// THE MODELS THIS COMPUTER'S CLAUDE OFFERS, asked of the bundled Agent SDK
/// itself (`liaison-sidecar --local-models`), with no session and no turn. The
/// window asks once per launch, so a node publishes what the SDK it ships with
/// advertises, and an app update (a new SDK) is followed at its relaunch.
#[tauri::command]
pub async fn claude_local_models<R: Runtime>(
    app: AppHandle<R>,
) -> Result<serde_json::Value, String> {
    let line = run_one_line(
        &app,
        &["--local-models"],
        "local_models",
        LOCAL_MODELS_TIMEOUT,
    )
    .await
    .map_err(|_| LOCAL_MODELS_UNAVAILABLE.to_string())?;
    local_models_answer(&line)
}

/// The account a status call may answer without running the CLI: one the
/// shell already read as SIGNED IN (at launch, or by a sign-in), unless the
/// caller asked for a fresh read. A signed out answer is always read again:
/// the person may have signed in from a terminal since.
pub fn cached_sign_in(cached: Option<ClaudeAccount>, fresh: bool) -> Option<ClaudeAccount> {
    cached.filter(|account| account.logged_in && !fresh)
}

/// THE ACCOUNT THE LOCAL SESSIONS USE. `fresh` asks the CLI
/// whatever the shell knows; without it a signed in account the shell read at
/// launch is answered as is, so a launch's first local start does not pay for
/// a second `auth status`.
#[tauri::command]
pub async fn claude_auth_status<R: Runtime>(
    app: AppHandle<R>,
    fresh: Option<bool>,
) -> Result<ClaudeAccount, String> {
    if let Some(account) =
        cached_sign_in(crate::account::claude_account(&app), fresh.unwrap_or(false))
    {
        return Ok(account);
    }
    let value = run_quick(&app, "status").await?;
    let account = account_from(value.get("account")).ok_or(AUTH_UNREADABLE)?;
    note_account(&app, Some(account.clone()));
    Ok(account)
}

/// The account, asked for in the background at start.
pub fn refresh_account_in_background<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let _ = claude_auth_status(app, Some(true)).await;
    });
}

/// The account after a confirmed sign-out. A logout the CLI said it did is signed
/// out, whatever a status read after it says: the shell's cached sign-in must
/// not outlive it (the start check trusts a cached sign-in, `cached_sign_in`).
pub fn account_after_sign_out(logout: &serde_json::Value) -> ClaudeAccount {
    let signed_out = ClaudeAccount {
        logged_in: false,
        email: None,
    };
    if logout.get("ok").and_then(|ok| ok.as_bool()) == Some(true) {
        return signed_out;
    }
    account_from(logout.get("account")).unwrap_or(signed_out)
}

/// The account after a local turn failed to authenticate: signed out, the
/// email kept for the sign-in dialog. What the CLI's own status says is not asked: a
/// stored but dead token still reads as signed in there.
pub fn account_after_auth_failure(cached: Option<ClaudeAccount>) -> ClaudeAccount {
    ClaudeAccount {
        logged_in: false,
        email: cached.and_then(|account| account.email),
    }
}

/// A LOCAL TURN FAILED TO AUTHENTICATE (the window saw it). The cached sign-in
/// goes, so the next start's check is not answered "signed in" from it, and
/// Settings > Profile offers Sign in again. It can only make the app ask for a
/// sign-in, never skip one, so the window may call it freely.
#[tauri::command]
pub fn claude_auth_note_failure<R: Runtime>(app: AppHandle<R>) {
    let cached = crate::account::claude_account(&app);
    note_account(&app, Some(account_after_auth_failure(cached)));
}

/// SIGNS OUT OF CLAUDE on this computer: the CLI's own logout, then the
/// account as it now reads. The window hears `signedOut`. NOT a command: the
/// only caller is the shell's own native question (`account.rs`).
pub async fn sign_out<R: Runtime>(app: &AppHandle<R>) -> Result<ClaudeAccount, String> {
    let value = run_quick(app, "logout").await?;
    let account = account_after_sign_out(&value);
    note_account(app, Some(account.clone()));
    emit(
        app,
        ClaudeAuthEvent {
            account: Some(account.clone()),
            ..ClaudeAuthEvent::phase("signedOut")
        },
    );
    Ok(account)
}

/// STARTS A SIGN-IN. A sign-in already running is given up on first: the
/// person asked again, and one CLI waiting on a code is all there may be.
/// Returns once the sidecar runs; the rest arrives on `liaison-claude-auth`.
#[tauri::command]
pub fn claude_auth_login<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let state = app.try_state::<ClaudeLogin>().ok_or(SIGN_IN_NOT_RUNNING)?;
    if let Some(previous) = state.0.lock().ok().and_then(|mut held| held.take()) {
        stop_login(previous);
    }
    let (mut receiver, child) = app
        .shell()
        .sidecar("liaison-sidecar")
        .map_err(|error| error.to_string())?
        .args(["--claude-auth", "login"])
        .spawn()
        .map_err(|error| error.to_string())?;
    let pid = child.pid();
    let log = sidecar_log(&app);
    if let Some(log) = log.as_ref() {
        log.append(pid, "started: liaison-sidecar --claude-auth login");
    }
    let exited = Arc::new(AtomicBool::new(false));
    let exited_here = exited.clone();
    if let Ok(mut held) = state.0.lock() {
        *held = Some(LoginSlot {
            child,
            pid,
            reopen_url: None,
            exited,
        });
    }
    emit(&app, ClaudeAuthEvent::phase("starting"));
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut finished = false;
        while let Some(event) = receiver.recv().await {
            let Some(state) = handle.try_state::<ClaudeLogin>() else {
                return;
            };
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = login_line(String::from_utf8_lossy(&bytes).trim());
                    if let LoginLine::Done { ok, account, .. } = &line {
                        finished = true;
                        if *ok {
                            note_account(&handle, account.clone());
                        }
                        // Gone either way; a cancel took the slot already.
                        if take_if_current(&state.0, pid).is_none() {
                            continue;
                        }
                    } else if !is_current(&state.0, pid) {
                        continue;
                    }
                    if let LoginLine::Url { url, manual_url } = &line {
                        if let Ok(mut held) = state.0.lock() {
                            if let Some(login) = held.as_mut().filter(|login| login.pid == pid) {
                                login.reopen_url = Some(manual_url.clone());
                            }
                        }
                        // Belt and braces: the CLI may already have opened it.
                        let _ = open_in_browser(&handle, url, |note| {
                            if let Some(log) = log.as_ref() {
                                log.append(pid, note);
                            }
                        });
                    }
                    if let Some(event) = event_for(&line) {
                        emit(&handle, event);
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    if let Some(log) = log.as_ref() {
                        log.append(pid, String::from_utf8_lossy(&bytes).trim_end());
                    }
                }
                CommandEvent::Terminated(_) | CommandEvent::Error(_) => {
                    exited_here.store(true, Ordering::SeqCst);
                    if let Some(log) = log.as_ref() {
                        log.append(pid, "the Claude sign-in ended");
                    }
                    // Ended without saying how: still the current sign-in, so
                    // the window is told it failed rather than left waiting.
                    if !finished && take_if_current(&state.0, pid).is_some() {
                        emit(
                            &handle,
                            ClaudeAuthEvent {
                                reason: Some("failed".into()),
                                ..ClaudeAuthEvent::phase("failed")
                            },
                        );
                    }
                    return;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

fn stop_login(login: LoginSlot) {
    let exited = login.exited;
    let _ = end_login(
        login.child,
        cancel_writer,
        move || exited.load(Ordering::SeqCst),
        LOGIN_EXIT_CEILING,
        kill_child,
    );
}

fn cancel_writer(child: &mut CommandChild) {
    let _ = child.write(format!("{CANCEL_LINE}\n").as_bytes());
}

fn kill_child(child: CommandChild) {
    let _ = child.kill();
}

/// Ends a login child: the cancel line first, so the sidecar kills the CLI it
/// runs, then a wait for the sidecar to EXIT, and a kill only if it has not by
/// the ceiling. A kill straight after the line (what the exit hook first did),
/// and then one after a fixed 750 ms, took the sidecar down before it could
/// act, and the CLI, which ignores its stdin closing, lived on (the sidecar's
/// watchdog is the second line of defence, `sidecar/claude-auth.ts`). The wait
/// runs off the caller's thread; the handle is for a caller that has to wait.
pub fn end_login<T, W, D, K>(
    mut child: T,
    write_cancel: W,
    exited: D,
    ceiling: Duration,
    kill: K,
) -> std::thread::JoinHandle<()>
where
    T: Send + 'static,
    W: FnOnce(&mut T),
    D: Fn() -> bool + Send + 'static,
    K: FnOnce(T) + Send + 'static,
{
    write_cancel(&mut child);
    std::thread::spawn(move || {
        let started = Instant::now();
        while !exited() && started.elapsed() < ceiling {
            std::thread::sleep(LOGIN_EXIT_POLL);
        }
        if !exited() {
            kill(child);
        }
    })
}

/// Hands the running sign-in the code Claude's page showed.
#[tauri::command]
pub fn claude_auth_submit_code<R: Runtime>(app: AppHandle<R>, code: String) -> Result<(), String> {
    let line = code_line(&code).map_err(str::to_string)?;
    let state = app.try_state::<ClaudeLogin>().ok_or(SIGN_IN_NOT_RUNNING)?;
    let mut held = state
        .0
        .lock()
        .map_err(|_| SIGN_IN_NOT_RUNNING.to_string())?;
    let login = held.as_mut().ok_or(SIGN_IN_NOT_RUNNING)?;
    // The error is the variant alone: the write's own message could quote
    // what was being written.
    login
        .child
        .write(format!("{line}\n").as_bytes())
        .map_err(|_| SIGN_IN_NOT_RUNNING.to_string())
}

/// Gives up on the running sign-in: the CLI is told, then killed.
#[tauri::command]
pub fn claude_auth_cancel<R: Runtime>(app: AppHandle<R>) {
    if let Some(state) = app.try_state::<ClaudeLogin>() {
        if let Some(login) = state.0.lock().ok().and_then(|mut held| held.take()) {
            stop_login(login);
        }
    }
}

/// Opens the running sign-in's page again: the one that shows a code.
#[tauri::command]
pub fn claude_auth_reopen<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let state = app.try_state::<ClaudeLogin>().ok_or(SIGN_IN_NOT_RUNNING)?;
    let url = state
        .0
        .lock()
        .ok()
        .and_then(|held| held.as_ref().and_then(|login| login.reopen_url.clone()))
        .ok_or(SIGN_IN_NOT_RUNNING)?;
    let log = sidecar_log(&app);
    open_in_browser(&app, &url, |note| {
        if let Some(log) = log.as_ref() {
            log.append(0, note);
        }
    })
    .map_err(str::to_string)
}

/// The app is going away: a sign-in child is not left waiting on a code. The
/// grace is WAITED for here, as `stop_managed_session` waits for the session's:
/// the process is about to go, and the sidecar needs that time to end its CLI.
pub fn stop_on_exit<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<ClaudeLogin>() {
        if let Some(login) = state.0.lock().ok().and_then(|mut held| held.take()) {
            let exited = login.exited;
            let _ = end_login(
                login.child,
                cancel_writer,
                move || exited.load(Ordering::SeqCst),
                LOGIN_EXIT_CEILING,
                kill_child,
            )
            .join();
        }
    }
}

#[cfg(test)]
mod claude_auth_tests {
    use super::*;

    #[test]
    fn the_models_line_answers_its_list_or_a_refusal() {
        let listed = serde_json::json!({
            "type": "local_models",
            "models": [{ "id": "claude-sonnet-5-5", "label": "Claude Sonnet 5.5" }],
        });
        assert_eq!(
            local_models_answer(&listed),
            Ok(serde_json::json!([{ "id": "claude-sonnet-5-5", "label": "Claude Sonnet 5.5" }]))
        );
        for refused in [
            serde_json::json!({ "type": "local_models", "error": "unavailable" }),
            serde_json::json!({ "type": "local_models", "models": [] }),
            serde_json::json!({ "type": "local_models", "models": "claude-opus-5-5" }),
        ] {
            assert_eq!(
                local_models_answer(&refused),
                Err(LOCAL_MODELS_UNAVAILABLE.to_string())
            );
        }
    }

    const MANUAL: &str = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s";
    const AUTOMATIC: &str = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A5123%2Fcallback&state=s";

    #[test]
    fn only_claudes_own_https_pages_are_ever_opened() {
        assert!(validate_claude_sign_in_url(MANUAL).is_ok());
        assert!(
            validate_claude_sign_in_url("https://platform.claude.com/oauth/code/callback").is_ok()
        );
        assert!(validate_claude_sign_in_url("https://claude.ai/login").is_ok());
        for refused in [
            "http://claude.com/cai/oauth/authorize",
            "https://claude.com.evil.example/",
            "https://evilclaude.com/",
            "https://user:pw@claude.com/",
            "https://claude.com:8443/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "not a url",
        ] {
            assert_eq!(
                validate_claude_sign_in_url(refused),
                Err(SIGN_IN_URL_REFUSED),
                "{refused} was accepted"
            );
        }
    }

    #[test]
    fn a_url_line_carries_the_page_to_open_and_the_code_page_to_reopen() {
        let line =
            serde_json::json!({ "type": "claude_auth_url", "url": AUTOMATIC, "manualUrl": MANUAL })
                .to_string();
        assert_eq!(
            login_line(&line),
            LoginLine::Url {
                url: AUTOMATIC.into(),
                manual_url: MANUAL.into()
            }
        );
        // A page that is not Claude's is dropped, and the other one stands.
        let line = serde_json::json!({ "type": "claude_auth_url", "url": "https://evil.example/", "manualUrl": MANUAL })
            .to_string();
        assert_eq!(
            login_line(&line),
            LoginLine::Url {
                url: MANUAL.into(),
                manual_url: MANUAL.into()
            }
        );
        let line = serde_json::json!({ "type": "claude_auth_url", "url": "https://evil.example/" })
            .to_string();
        assert_eq!(login_line(&line), LoginLine::Other);
    }

    #[test]
    fn the_window_hears_the_phase_and_never_the_url() {
        let line = LoginLine::Url {
            url: AUTOMATIC.into(),
            manual_url: MANUAL.into(),
        };
        let event = serde_json::to_string(&event_for(&line).unwrap()).unwrap();
        assert_eq!(event, r#"{"phase":"waiting"}"#);
        assert!(!event.contains("claude.com"));
    }

    #[test]
    fn a_done_line_is_signed_in_with_the_account_or_failed_with_its_reason() {
        let ok = login_line(
            r#"{"type":"claude_auth_done","ok":true,"account":{"loggedIn":true,"email":"someone@example.com","authMethod":"claude.ai"}}"#,
        );
        let event = event_for(&ok).unwrap();
        assert_eq!(event.phase, "signedIn");
        assert_eq!(
            event.account,
            Some(ClaudeAccount {
                logged_in: true,
                email: Some("someone@example.com".into())
            })
        );
        let cancelled =
            login_line(r#"{"type":"claude_auth_done","ok":false,"reason":"cancelled"}"#);
        let event = event_for(&cancelled).unwrap();
        assert_eq!(event.phase, "failed");
        assert_eq!(event.reason.as_deref(), Some("cancelled"));
        assert_eq!(event_for(&login_line("not json")), None);
        assert_eq!(
            event_for(&login_line(r#"{"type":"claude_auth_code_rejected"}"#))
                .unwrap()
                .phase,
            "codeRejected"
        );
    }

    #[test]
    fn a_code_is_one_json_line_or_nothing() {
        let line = code_line("  abcd1234#efgh5678 ").unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&line).unwrap(),
            serde_json::json!({ "type": "code", "code": "abcd1234#efgh5678" })
        );
        assert!(!line.contains('\n'));
        assert_eq!(code_line(""), Err(CODE_REFUSED));
        assert_eq!(code_line("   "), Err(CODE_REFUSED));
        assert_eq!(code_line("abc\ndef"), Err(CODE_REFUSED));
        assert_eq!(code_line(&"x".repeat(MAX_CODE_LEN + 1)), Err(CODE_REFUSED));
    }

    #[test]
    fn an_account_reads_only_what_the_window_shows() {
        let value = serde_json::json!({ "loggedIn": false, "email": "  ", "authMethod": "none" });
        assert_eq!(
            account_from(Some(&value)),
            Some(ClaudeAccount {
                logged_in: false,
                email: None
            })
        );
        assert_eq!(
            account_from(Some(&serde_json::json!({ "email": "x" }))),
            None
        );
        assert_eq!(account_from(None), None);
        let wire = serde_json::to_value(ClaudeAccount {
            logged_in: true,
            email: Some("a@b.c".into()),
        })
        .unwrap();
        assert_eq!(
            wire,
            serde_json::json!({ "loggedIn": true, "email": "a@b.c" })
        );
    }

    /// REVIEW OF 74b97cd63, finding 2: the opener's error quotes the URL it ran
    /// (`open` 5.4.4: `Launcher "open" "<url>" failed with ...`), and it was
    /// formatted into the sidecar log. What is noted now is fixed words.
    #[test]
    fn an_opener_failure_never_writes_the_url_anywhere() {
        let url = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&code_challenge=CHALLENGE123&state=STATE456";
        let mut noted: Vec<String> = Vec::new();
        let outcome = open_sign_in_page(
            url,
            |target| {
                Err(format!(
                    "Launcher \"open\" [\"{target}\"] failed with ExitStatus(1)"
                ))
            },
            |note| noted.push(note.to_string()),
        );
        assert_eq!(outcome, Err(PAGE_NOT_OPENED));
        assert_eq!(noted, vec![OPEN_FAILED_NOTE.to_string()]);
        let everything = format!("{noted:?} {outcome:?}");
        for secret in [
            "claude.com",
            "CHALLENGE123",
            "STATE456",
            "code_challenge",
            "state=",
        ] {
            assert!(
                !everything.contains(secret),
                "{secret} reached the log or the error"
            );
        }
        // And a page that opened says nothing at all.
        let mut quiet: Vec<&str> = Vec::new();
        assert_eq!(
            open_sign_in_page(url, |_| Ok::<(), String>(()), |note| quiet.push(note)),
            Ok(())
        );
        assert!(quiet.is_empty());
        // No other opener or CLI error in this file is formatted into a log line.
        const SOURCE: &str = include_str!("claude_auth.rs");
        let shell = &SOURCE[..SOURCE.find("#[cfg(test)]").expect("a test module")];
        assert!(!shell.contains("did not open: {error}"));
        assert!(!shell.contains("could not open the browser: {error}"));
    }

    /// REVIEW OF 74b97cd63, finding 1, and of 52fecfa8d, finding 2: the exit
    /// hook killed the sidecar right after the cancel line, then after a fixed
    /// 750 ms while the cancel itself takes up to about a second. It now waits
    /// for the sidecar to exit, up to a ceiling, and kills only one that has not.
    fn run_end_login(
        exits_after: Option<Duration>,
        ceiling: Duration,
    ) -> Vec<(&'static str, u128)> {
        use std::sync::Mutex as StdMutex;
        let events: Arc<StdMutex<Vec<(&'static str, u128)>>> = Arc::default();
        let started = Instant::now();
        let written = events.clone();
        let killed = events.clone();
        end_login(
            (),
            move |_| {
                written
                    .lock()
                    .unwrap()
                    .push(("cancel", started.elapsed().as_millis()))
            },
            move || exits_after.is_some_and(|after| started.elapsed() >= after),
            ceiling,
            move |_| {
                killed
                    .lock()
                    .unwrap()
                    .push(("kill", started.elapsed().as_millis()))
            },
        )
        .join()
        .unwrap();
        let events = events.lock().unwrap().clone();
        events
    }

    #[test]
    fn a_cancel_that_takes_a_second_is_waited_for_and_not_killed() {
        let started = Instant::now();
        let events = run_end_login(Some(Duration::from_millis(1_000)), LOGIN_EXIT_CEILING);
        assert_eq!(
            events.iter().map(|(what, _)| *what).collect::<Vec<_>>(),
            vec!["cancel"]
        );
        // The wait ended with the exit, not at the ceiling.
        let waited = started.elapsed().as_millis();
        assert!((1_000..2_500).contains(&waited), "waited {waited} ms");
        assert!(LOGIN_EXIT_CEILING >= Duration::from_millis(2_000));
    }

    #[test]
    fn a_sidecar_that_never_exits_is_killed_at_the_ceiling_not_before() {
        let events = run_end_login(None, Duration::from_millis(300));
        assert_eq!(
            events.iter().map(|(what, _)| *what).collect::<Vec<_>>(),
            vec!["cancel", "kill"]
        );
        assert!(events[1].1 >= 300, "killed after {} ms", events[1].1);
    }

    #[test]
    fn the_exit_hook_waits_for_the_login_to_end() {
        const SOURCE: &str = include_str!("claude_auth.rs");
        let at = SOURCE
            .find("pub fn stop_on_exit")
            .expect("the exit hook exists");
        let body = &SOURCE[at..];
        let body = &body[..body.find("\n}\n").expect("closed")];
        assert!(body.contains("end_login(") && body.contains(".join()"));
        assert!(body.contains("LOGIN_EXIT_CEILING"));
        assert!(
            !body.contains(".kill()"),
            "the exit hook kills without the grace"
        );
        // And the wait is told when the sidecar exited.
        assert!(SOURCE.contains("exited_here.store(true, Ordering::SeqCst)"));
    }

    /// REVIEW OF 74b97cd63, finding 3: the page could sign the computer out of
    /// Claude with no confirmation. There is no command for it any more; the
    /// only way is the shell's own native question.
    #[test]
    fn the_page_cannot_sign_the_computer_out_of_claude() {
        assert!(!crate::RELEASE_COMMANDS
            .iter()
            .any(|command| command.contains("logout")));
        const SOURCE: &str = include_str!("claude_auth.rs");
        let shell = &SOURCE[..SOURCE.find("#[cfg(test)]").expect("a test module")];
        let at = shell
            .find("pub async fn sign_out")
            .expect("sign_out exists");
        let before = shell[..at].trim_end();
        assert!(
            !before.ends_with("#[tauri::command]"),
            "sign_out is a command"
        );
        assert!(!shell.contains("fn claude_auth_logout"));
        const MAIN_RS: &str = include_str!("main.rs");
        assert!(!MAIN_RS.contains("claude_auth::sign_out"));
        const ACCOUNT_RS: &str = include_str!("account.rs");
        let account = &ACCOUNT_RS[..ACCOUNT_RS.find("#[cfg(test)]").expect("a test module")];
        assert_eq!(account.matches("claude_auth::sign_out").count(), 1);
        let ask = account
            .find("fn ask_claude_sign_out")
            .expect("the question exists");
        let call = account.find("claude_auth::sign_out").expect("called");
        let confirmed = account[ask..]
            .find("if !confirmed")
            .expect("the answer is read")
            + ask;
        assert!(
            ask < confirmed && confirmed < call,
            "sign_out runs outside the confirmation"
        );
    }

    /// REVIEW OF 52fecfa8d, finding 3: after a turn failed to authenticate,
    /// the cached "signed in" kept answering the next start's check.
    #[test]
    fn an_auth_failure_and_a_sign_out_drop_the_cached_sign_in() {
        let signed_in = ClaudeAccount {
            logged_in: true,
            email: Some("a@b.c".into()),
        };
        let after = account_after_auth_failure(Some(signed_in));
        assert_eq!(
            after,
            ClaudeAccount {
                logged_in: false,
                email: Some("a@b.c".into())
            }
        );
        assert_eq!(cached_sign_in(Some(after), false), None);
        // A logout the CLI did is signed out, even if the status read after it
        // (a stale or unreadable one) says otherwise.
        let logout =
            serde_json::json!({ "ok": true, "account": { "loggedIn": true, "email": "a@b.c" } });
        assert!(!account_after_sign_out(&logout).logged_in);
        let refused =
            serde_json::json!({ "ok": false, "account": { "loggedIn": true, "email": "a@b.c" } });
        assert!(account_after_sign_out(&refused).logged_in);
        assert!(crate::RELEASE_COMMANDS.contains(&"claude_auth_note_failure"));
    }

    #[test]
    fn only_a_signed_in_account_is_answered_from_what_the_shell_knows() {
        let signed_in = ClaudeAccount {
            logged_in: true,
            email: Some("a@b.c".into()),
        };
        let signed_out = ClaudeAccount {
            logged_in: false,
            email: None,
        };
        assert_eq!(
            cached_sign_in(Some(signed_in.clone()), false),
            Some(signed_in.clone())
        );
        assert_eq!(cached_sign_in(Some(signed_in), true), None);
        assert_eq!(cached_sign_in(Some(signed_out), false), None);
        assert_eq!(cached_sign_in(None, false), None);
    }

    /// The code is written to the child and to nothing else: no log line, no
    /// event and no error in this file quotes it. Read from the source,
    /// because a running app is what would have to be watched otherwise.
    #[test]
    fn the_code_reaches_no_log_and_no_event() {
        const SOURCE: &str = include_str!("claude_auth.rs");
        let shell = &SOURCE[..SOURCE.find("#[cfg(test)]").expect("a test module")];
        let at = shell
            .find("pub fn claude_auth_submit_code")
            .expect("the command exists");
        let body = &shell[at..];
        let body = &body[..body.find("\n}\n").expect("closed")];
        for forbidden in ["log.append", "emit(", "format!(\"{error"] {
            assert!(!body.contains(forbidden), "submit_code does {forbidden}");
        }
    }
}
