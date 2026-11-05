// SPDX-License-Identifier: FSL-1.1-ALv2
//
// DEBUG BUILDS ONLY. The whole module is behind `cfg(debug_assertions)` at its
// declaration in `main.rs`, exactly like `diagnostics`, so neither the command
// below nor the environment variable it reads exists in a release binary.
//
// WHY IT EXISTS: a driven walk judges the real window of the real debug app,
// and until now the only way to reach a control in it was synthetic input
// (CGEvent clicks, System Events keystrokes). That has two costs and both of
// them bit this slice. It steals the machine from whoever is sitting at it,
// which on a shared Mac is not acceptable; and it cannot reach anything the
// window does not have focus for.
//
// So the walk drives the DOM instead. A directory is named on the command
// line, the shell watches it, and every `<id>.js` dropped in it is evaluated
// in the webview through Tauri's own `eval`. The script's answer (or the error
// it threw) comes back as `<id>.json` beside it. A walk can therefore dispatch
// a real click on an element, type into the composer through the app's own
// input events, open a menu, read a rect or a computed style, with no focus
// steal and no pointer moved.
//
// IT IS NOT A WIDER DOOR THAN THE PAGE ALREADY IS. Whoever can write into that
// directory is whoever can start this process with that variable set, and a
// page script can already do everything a script in the page can do. What it
// is NOT is a channel the PAGE can open: the page cannot name the directory,
// cannot ask for a script to run, and the result command writes only a file
// named by a checked id inside the directory the OPERATOR named.
//
// The native dialogs stay out of reach: the folder picker and the Bypass
// confirmation are the shell's own, drawn by the OS, and no DOM reaches them.
// That is the point of them, and a walk records it as a bound.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};

/// The directory the shell watches for scripts. Read ONCE, at startup.
pub const DEBUG_DRIVER_ENV: &str = "LIAISON_DEBUG_DRIVER";

/// THE WINDOW STAYS OUT OF THE WAY, for a walk driven on a machine somebody is
/// working at. Set to `1` the app takes no dock icon and never becomes the
/// active application (accessory activation policy), and its window is built
/// unfocused and at the bottom of the stack. Nothing in this shell calls
/// `set_focus`, `show` or `activate` on a background window (the reconnect
/// path included, and the `oauth-complete` deep link checks the flag before it
/// raises anything), so there is nothing else that could raise it.
///
/// A capture of the window still works while it is covered, with one caveat a
/// walk has to know: an occluded webview is not repainted on every DOM change,
/// so a capture can be one frame behind what the DOM says. The driver above is
/// the reliable reader; the capture is the picture.
pub const DEBUG_BACKGROUND_ENV: &str = "LIAISON_DEBUG_BACKGROUND";

/// How often the directory is looked at. A walk writes a script and waits for
/// its answer, so this is the floor on one step.
pub const DRIVER_POLL_MS: u64 = 200;

/// The window the scripts are evaluated in, as `main.rs` builds it.
pub const DRIVER_WINDOW_LABEL: &str = "main";

/// The function the page exposes for a script to answer through
/// (`apps/desktop/src/driver-bridge.ts`).
pub const DRIVER_REPORT_GLOBAL: &str = "__LIAISON_DRIVER_REPORT__";

static DRIVER_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

/// The directory the variable names, when it names one that exists. Pure, so
/// the rule is readable from a test.
pub fn driver_dir_from(value: Option<String>) -> Option<PathBuf> {
    let raw = value?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if path.is_dir() {
        Some(path)
    } else {
        None
    }
}

static BACKGROUND_MODE: OnceLock<bool> = OnceLock::new();

/// Whether the variable asks for the background window. `1`, `true` and `yes`
/// all mean yes; anything else, including an unset variable, means no.
pub fn background_mode_from(value: Option<String>) -> bool {
    matches!(
        value.as_deref().map(str::trim).map(str::to_ascii_lowercase),
        Some(ref v) if v == "1" || v == "true" || v == "yes"
    )
}

/// Read ONCE, at startup. A RELEASE BUILD NEVER READS IT: this whole module is
/// compiled out there, so the variable does not exist in a shipped app and the
/// window is built exactly as it always was.
pub fn background_mode() -> bool {
    *BACKGROUND_MODE.get_or_init(|| background_mode_from(std::env::var(DEBUG_BACKGROUND_ENV).ok()))
}

/// The watched directory, read once at startup and remembered.
pub fn driver_dir() -> Option<&'static Path> {
    DRIVER_DIR
        .get_or_init(|| driver_dir_from(std::env::var(DEBUG_DRIVER_ENV).ok()))
        .as_deref()
}

/// WHAT A RESULT FILE MAY BE NAMED. The id comes back from the page, so it is
/// checked before it is joined to a path: no separator, no dot, nothing that
/// could walk out of the directory the operator named.
pub fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Where the answer to one script is written.
pub fn result_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

/// WHERE THE SHELL SAYS IT ASKED (P6d-FX7, SK-10).
///
/// The page can call `report_driver_result` with any id it likes, and a
/// `<id>.json` sitting in the directory made the watcher skip the operator's
/// `<id>.js` entirely: a driven walk would then read a fabricated answer as the
/// app's own, which means a driver result was not evidence about a page that is
/// itself the thing under suspicion. So the shell writes `<id>.req` BEFORE it
/// evaluates anything, and a result is only an answer if it came after the
/// request it claims to answer.
pub fn request_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.req"))
}

/// Records that this process is about to run `<id>.js`.
pub fn mark_requested(dir: &Path, id: &str) {
    let _ = fs::write(request_path(dir, id), b"requested");
}

/// Is the answer beside this script an answer to the request that was made,
/// or one that was already lying there? A result with no request at all is
/// never an answer: nothing asked for it.
pub fn result_answers_request(dir: &Path, id: &str) -> bool {
    let Ok(answered) = fs::metadata(result_path(dir, id)).and_then(|meta| meta.modified()) else {
        return false;
    };
    let Ok(asked) = fs::metadata(request_path(dir, id)).and_then(|meta| meta.modified()) else {
        return false;
    };
    answered >= asked
}

/// The scripts waiting to run: a `<id>.js` with no answer beside it that this
/// process has not already issued, oldest name first so a walk's numbering is
/// the order they run in.
pub fn pending_scripts(dir: &Path, issued: &HashSet<String>) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("js") {
                return None;
            }
            let id = path.file_stem()?.to_str()?.to_string();
            // A result that PREDATES its request is not an answer to it
            // (P6d-FX7, SK-10): it is either a leftover or something the page
            // wrote for a script nobody has run yet, and skipping the script
            // because of it is how a walk reads a fabrication as the app.
            if !safe_id(&id) || issued.contains(&id) || result_answers_request(dir, &id) {
                return None;
            }
            Some(id)
        })
        .collect();
    ids.sort();
    ids
}

/// The script the webview actually evaluates.
///
/// The operator's source becomes the body of an async function, so it may
/// `await` and may `return` a value; whatever it returns (or throws) is handed
/// back through the page's report global as one JSON object. A value that
/// cannot be serialized is reported as such rather than silently lost, which
/// is the difference between a step that did nothing and a step whose answer
/// did not fit.
pub fn wrap_script(id: &str, source: &str) -> String {
    let id_json = serde_json::to_string(id).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        "(function(){{var __id={id_json};\
function __done(ok,value){{var s;try{{s=JSON.stringify({{ok:ok,value:value===undefined?null:value}});}}\
catch(e){{s=JSON.stringify({{ok:false,value:'unserializable: '+String(e)}});}}\
try{{window.{DRIVER_REPORT_GLOBAL}(__id,s);}}catch(e){{}}}}\
try{{Promise.resolve((async function(){{\n{source}\n}})()).then(function(v){{__done(true,v);}},\
function(e){{__done(false,String((e&&e.stack)||e));}});}}\
catch(e){{__done(false,String((e&&e.stack)||e));}}}})()"
    )
}

/// One script's answer, written beside it. The page can reach this command, so
/// it decides nothing: an id it does not like is dropped, and the directory is
/// the operator's, never the page's.
#[tauri::command]
pub fn report_driver_result(id: String, payload: String) {
    let Some(dir) = driver_dir() else {
        return;
    };
    if !safe_id(&id) {
        return;
    }
    // AN ANSWER TO A QUESTION NOBODY ASKED IS NOT WRITTEN (P6d-FX7, SK-10).
    // The shell marks every script it is about to evaluate; a report for an id
    // it never issued comes from the page alone and lands nowhere.
    if fs::metadata(request_path(dir, &id)).is_err() {
        return;
    }
    let _ = fs::write(result_path(dir, &id), payload.as_bytes());
}

/// THE NOTIFICATION MATRIX'S HANDS (A2, P1-T6). A driven walk closes the
/// window to the tray, brings it back, and sets the OS permission the app
/// reports, without a pointer on the close button or a person in System
/// Settings. A driver script calls them through the page's own `invoke`. Like
/// everything in this module they do not exist in a release build.
///
/// `hide_to_tray` and `show_window` answer whether the tray activity
/// assertion (A13) is held afterwards.
#[tauri::command]
pub fn hide_to_tray<R: Runtime>(app: AppHandle<R>) -> bool {
    crate::tray::hide_to_tray(&app);
    crate::tray::activity_held()
}

#[tauri::command]
pub fn show_window<R: Runtime>(app: AppHandle<R>) -> bool {
    crate::tray::show_window(&app);
    crate::tray::activity_held()
}

/// `granted`, `denied` or `not_determined`, reported from now on whatever the
/// system says (the page hears the change at once).
#[tauri::command]
pub fn set_reported_notification_permission<R: Runtime>(
    app: AppHandle<R>,
    permission: String,
) -> Result<String, String> {
    let forced = crate::desktop_notifications::OsPermission::from_wire(&permission)
        .ok_or_else(|| format!("unknown permission {permission:?}"))?;
    crate::desktop_notifications::force_reported(&app, forced);
    Ok(forced.wire().to_string())
}

/// Starts watching, if the operator named a directory. A no op otherwise, and
/// in a release build this function is not compiled at all.
pub fn arm<R: Runtime>(app: &AppHandle<R>) {
    let Some(dir) = driver_dir() else {
        return;
    };
    eprintln!("liaison: debug DOM driver watching {}", dir.display());
    let handle = app.clone();
    let dir = dir.to_path_buf();
    std::thread::spawn(move || {
        let mut issued: HashSet<String> = HashSet::new();
        loop {
            for id in pending_scripts(&dir, &issued) {
                issued.insert(id.clone());
                // The marker goes down BEFORE the page is handed anything, so
                // every answer that arrives can be dated against it.
                mark_requested(&dir, &id);
                let source = fs::read_to_string(dir.join(format!("{id}.js"))).unwrap_or_default();
                match handle.get_webview_window(DRIVER_WINDOW_LABEL) {
                    Some(window) => {
                        if let Err(error) = window.eval(wrap_script(&id, &source)) {
                            let _ = fs::write(
                                result_path(&dir, &id),
                                serde_json::to_vec(&serde_json::json!({
                                    "ok": false,
                                    "value": format!("eval failed: {error}"),
                                }))
                                .unwrap_or_default(),
                            );
                        }
                    }
                    None => {
                        let _ = fs::write(
                            result_path(&dir, &id),
                            br#"{"ok":false,"value":"no window"}"#,
                        );
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(DRIVER_POLL_MS));
        }
    });
}

#[cfg(test)]
mod driver_tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("liaison-driver-{}-{name}", std::process::id()));
        fs::remove_dir_all(&dir).ok();
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_variable_names_a_directory_or_nothing() {
        let dir = scratch("dirs");
        fs::write(dir.join("a.js"), b"1").unwrap();
        assert_eq!(driver_dir_from(None), None);
        assert_eq!(driver_dir_from(Some(String::new())), None);
        assert_eq!(driver_dir_from(Some("  ".into())), None);
        assert_eq!(
            driver_dir_from(Some(dir.join("a.js").to_string_lossy().to_string())),
            None,
            "a file is not a directory of scripts"
        );
        assert_eq!(
            driver_dir_from(Some(dir.join("gone").to_string_lossy().to_string())),
            None
        );
        assert_eq!(
            driver_dir_from(Some(format!(" {} ", dir.display()))),
            Some(dir.clone())
        );
        fs::remove_dir_all(&dir).ok();
    }

    /// AN ID COMES BACK FROM THE PAGE, so it is a name and never a path. A
    /// result written outside the directory the operator named would be this
    /// hook turning into an arbitrary file write.
    #[test]
    fn a_result_id_is_a_plain_name_and_never_a_path() {
        assert!(safe_id("01-open-menu"));
        assert!(safe_id("step_2"));
        assert!(!safe_id(""));
        assert!(!safe_id(".."));
        assert!(!safe_id("../../etc/passwd"));
        assert!(!safe_id("a/b"));
        assert!(!safe_id("a.b"));
        assert!(!safe_id(&"x".repeat(65)));
    }

    /// Numbered scripts run in name order, each exactly once, and one that has
    /// already answered is finished rather than run again.
    #[test]
    fn pending_scripts_are_the_unanswered_ones_in_name_order() {
        let dir = scratch("pending");
        for name in ["02-second.js", "01-first.js", "03-third.js", "notes.txt"] {
            fs::write(dir.join(name), b"return 1").unwrap();
        }
        // The shell asked for it and the answer came back: that pair is what
        // finishes a script (P6d-FX7, SK-10), not a `.json` on its own.
        mark_requested(&dir, "01-first");
        fs::write(result_path(&dir, "01-first"), b"{}").unwrap();

        let issued = HashSet::new();
        assert_eq!(
            pending_scripts(&dir, &issued),
            vec!["02-second".to_string(), "03-third".to_string()]
        );

        let mut issued = HashSet::new();
        issued.insert("02-second".to_string());
        assert_eq!(pending_scripts(&dir, &issued), vec!["03-third".to_string()]);

        fs::remove_dir_all(&dir).ok();
    }

    /// The operator's source is a function BODY: it may await, and what it
    /// returns is what comes back. A wrapper that dropped the return value
    /// would make every read step answer null.
    #[test]
    fn the_wrapper_carries_the_source_and_reports_through_the_page_global() {
        let wrapped = wrap_script("01-step", "return document.title");
        assert!(wrapped.contains("return document.title"));
        assert!(wrapped.contains("\"01-step\""));
        assert!(wrapped.contains(DRIVER_REPORT_GLOBAL));
        assert!(wrapped.contains("async function"));
        // Both ends: a value and a throw are both answered.
        assert!(wrapped.contains("__done(true,v)"));
        assert!(wrapped.contains("__done(false,"));
    }

    #[test]
    fn the_background_mode_is_asked_for_explicitly_or_not_at_all() {
        assert!(
            !background_mode_from(None),
            "an unset variable leaves the window alone"
        );
        assert!(!background_mode_from(Some(String::new())));
        assert!(!background_mode_from(Some("0".into())));
        assert!(!background_mode_from(Some("no".into())));
        assert!(!background_mode_from(Some("please".into())));
        assert!(background_mode_from(Some("1".into())));
        assert!(background_mode_from(Some(" TRUE ".into())));
        assert!(background_mode_from(Some("yes".into())));
    }

    /// P6d-FX7 (SK-10): in a debug build a page script could call
    /// `report_driver_result` with any id, and a `<id>.json` already in the
    /// directory made the watcher skip the operator's `<id>.js` entirely. A
    /// driven walk would then read the page's own fabrication as the app's
    /// answer, which is the one thing a driver result must never be.
    #[test]
    fn a_result_that_predates_its_request_is_not_an_answer() {
        let dir = scratch("stale");
        fs::write(dir.join("01-step.js"), b"return 1").unwrap();
        // Planted before anything asked: no request marker exists at all.
        fs::write(
            result_path(&dir, "01-step"),
            br#"{"ok":true,"value":"forged"}"#,
        )
        .unwrap();
        assert!(
            !result_answers_request(&dir, "01-step"),
            "a result nobody asked for answers nothing"
        );
        assert_eq!(
            pending_scripts(&dir, &HashSet::new()),
            vec!["01-step".to_string()],
            "the operator's script still runs"
        );

        // The shell asks, and from then on the answer beside it is the answer.
        std::thread::sleep(Duration::from_millis(20));
        mark_requested(&dir, "01-step");
        assert!(!result_answers_request(&dir, "01-step"));
        std::thread::sleep(Duration::from_millis(20));
        fs::write(result_path(&dir, "01-step"), br#"{"ok":true,"value":1}"#).unwrap();
        assert!(result_answers_request(&dir, "01-step"));
        assert!(pending_scripts(&dir, &HashSet::new()).is_empty());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_result_is_written_beside_its_script() {
        let dir = scratch("result");
        assert_eq!(
            result_path(&dir, "01-step"),
            dir.join("01-step.json"),
            "the answer sits beside the script"
        );
        fs::remove_dir_all(&dir).ok();
    }
}
