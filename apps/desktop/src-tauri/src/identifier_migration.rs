// SPDX-License-Identifier: FSL-1.1-ALv2

//! Carrying an install over from the app's PREVIOUS bundle identifier.
//!
//! WHY THIS EXISTS. Every per-user directory the shell and its webview use is
//! named after the bundle identifier: the config directory (saved servers,
//! refresh tokens, install salt), the log directory, and the webview's own
//! storage (localStorage, IndexedDB, cookies), which is where the page keeps
//! its session. The identifier moved from the legacy one below to the one in
//! tauri.conf.json, and an auto update replaces the binary in place, so the
//! first launch of the new build would otherwise find every one of those
//! directories empty: signed out, servers forgotten, as if freshly installed.
//!
//! WHAT MOVES, per OS (the new paths are Tauri's own resolvers; the legacy
//! path is the same directory with the identifier swapped):
//!
//! - every OS: `app_config_dir`, `app_data_dir`, `app_local_data_dir`,
//!   `app_log_dir` (whichever of them ends in the identifier; a duplicate is
//!   taken once). On Windows `app_local_data_dir` is `%LOCALAPPDATA%\<id>`,
//!   which holds WebView2's `EBWebView` user data folder; on Linux it is
//!   `~/.local/share/<id>`, WebKitGTK's data directory (cookies included).
//! - macOS only: WKWebView keeps its data under the bundle id itself, outside
//!   Tauri's resolvers: `~/Library/WebKit/<id>` (local storage, IndexedDB)
//!   and `~/Library/HTTPStorages/<id>` plus `<id>.binarycookies` (cookies).
//!
//! Caches are not carried (`~/Library/Caches/<id>`, `~/.cache/<id>`): they
//! rebuild themselves, and the shell keeps nothing there.
//!
//! THE RULES. The legacy directories are COPIED, never moved and never
//! deleted, so rolling back to a build with the legacy identifier still finds
//! its data. A copy works one top level entry at a time, into a staging name
//! that is renamed into place only once the whole entry has copied, so a
//! crash part way leaves no half-copied database behind. An entry that
//! already exists under the new identifier is KEPT, never overwritten or
//! merged into: on Windows the NEW build's installer has already written its
//! `logs\updater.log` there before the app first starts, and mixing two
//! WebView2 or WebKit stores file by file would corrupt both. When every
//! directory has been handled a marker is written in the new config
//! directory and the migration never runs again (without it, a token the user
//! signed out of would come back from the legacy copy on the next launch).
//! A failure leaves no marker, so the next launch tries the entries that are
//! still missing. Every step goes to `updater.log`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The identifier every build up to and including desktop 0.1.19 shipped
/// with.
pub const LEGACY_IDENTIFIER: &str = "com.embodme.liaison.desktop";

/// Written in the new config directory once the migration has run to the end.
pub const MARKER_FILE: &str = ".identifier-migrated";

/// A top level entry being copied lives under this name until it is complete.
const STAGING_SUFFIX: &str = ".liaison-migrating";

/// How often one entry's copy is tried before it is left for the next launch.
/// On Windows the old app's WebView2 processes can outlive it by a moment and
/// hold a file in the user data folder.
const COPY_ATTEMPTS: u32 = 4;

/// One directory (or, for the macOS cookie jar, one file) and where it lived
/// under the legacy identifier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pair {
    pub legacy: PathBuf,
    pub current: PathBuf,
}

/// What a run did, one line per step, and whether it got to the end.
#[derive(Debug, Default)]
pub struct Outcome {
    pub lines: Vec<String>,
    pub complete: bool,
}

/// The legacy twin of `path`: the same path with its last component's
/// identifier swapped. A component that is the identifier, or the identifier
/// followed by an extension (`<id>.binarycookies`), qualifies; anything else
/// (a directory nested BELOW the identifier, such as Windows' `<id>\logs`, or
/// a path that has nothing to do with it) gives None, and is covered by its
/// parent's pair or by nothing.
pub fn legacy_twin(path: &Path, current_id: &str, legacy_id: &str) -> Option<PathBuf> {
    let name = path.file_name()?.to_str()?;
    let rest = name.strip_prefix(current_id)?;
    if !(rest.is_empty() || rest.starts_with('.')) {
        return None;
    }
    Some(path.with_file_name(format!("{legacy_id}{rest}")))
}

/// The pairs for a list of new-identifier paths, duplicates (macOS resolves
/// config, data and local data to the same directory) taken once, and a path
/// nested inside another pair's directory dropped (it is copied with it).
pub fn pairs_for(paths: &[PathBuf], current_id: &str, legacy_id: &str) -> Vec<Pair> {
    let mut pairs: Vec<Pair> = Vec::new();
    for path in paths {
        let Some(legacy) = legacy_twin(path, current_id, legacy_id) else {
            continue;
        };
        if pairs.iter().any(|p| p.current == *path) {
            continue;
        }
        pairs.push(Pair {
            legacy,
            current: path.clone(),
        });
    }
    let all = pairs.clone();
    pairs.retain(|p| {
        !all.iter()
            .any(|q| q.current != p.current && p.current.starts_with(&q.current))
    });
    pairs
}

/// The macOS WebKit stores, keyed by the bundle id rather than by any Tauri
/// path resolver.
pub fn macos_webkit_paths(home: &Path, id: &str) -> Vec<PathBuf> {
    vec![
        home.join("Library/WebKit").join(id),
        home.join("Library/HTTPStorages").join(id),
        home.join("Library/HTTPStorages")
            .join(format!("{id}.binarycookies")),
    ]
}

/// Runs the migration over `pairs`, once: a `marker` already present means a
/// previous run finished, and nothing is touched. `retry_delay` is the pause
/// between attempts at an entry whose copy failed.
pub fn migrate(pairs: &[Pair], marker: &Path, retry_delay: Duration) -> Outcome {
    let mut outcome = Outcome::default();
    if marker.exists() {
        outcome.complete = true;
        return outcome;
    }
    let mut failed = false;
    for pair in pairs {
        if let Err(error) = migrate_pair(pair, retry_delay, &mut outcome.lines) {
            failed = true;
            outcome.lines.push(format!(
                "FAILED {} -> {}: {error}",
                pair.legacy.display(),
                pair.current.display()
            ));
        }
    }
    if failed {
        outcome
            .lines
            .push("incomplete, retried on the next launch".to_string());
        return outcome;
    }
    let written = marker
        .parent()
        .map_or(Ok(()), fs::create_dir_all)
        .and_then(|()| {
            fs::write(
                marker,
                format!(
                    "migrated from {LEGACY_IDENTIFIER} by shell {}\n",
                    env!("CARGO_PKG_VERSION")
                ),
            )
        });
    match written {
        Ok(()) => outcome.complete = true,
        Err(error) => outcome
            .lines
            .push(format!("could not write {}: {error}", marker.display())),
    }
    outcome
}

fn migrate_pair(pair: &Pair, retry_delay: Duration, lines: &mut Vec<String>) -> io::Result<()> {
    let Ok(meta) = fs::symlink_metadata(&pair.legacy) else {
        return Ok(()); // never existed: a fresh install, or a path this OS never used
    };
    if !meta.is_dir() {
        // A single file (the macOS cookie jar).
        if fs::symlink_metadata(&pair.current).is_ok() {
            lines.push(format!("kept existing {}", pair.current.display()));
            return Ok(());
        }
        if let Some(parent) = pair.current.parent() {
            fs::create_dir_all(parent)?;
        }
        copy_into_place(&pair.legacy, &pair.current, retry_delay)?;
        lines.push(format!(
            "copied {} -> {}",
            pair.legacy.display(),
            pair.current.display()
        ));
        return Ok(());
    }
    if !pair.current.exists() {
        fs::create_dir_all(&pair.current)?;
        let _ = fs::set_permissions(&pair.current, meta.permissions());
    }
    let mut first_error: Option<io::Error> = None;
    for entry in fs::read_dir(&pair.legacy)? {
        let entry = entry?;
        let target = pair.current.join(entry.file_name());
        if fs::symlink_metadata(&target).is_ok() {
            lines.push(format!("kept existing {}", target.display()));
            continue;
        }
        match copy_into_place(&entry.path(), &target, retry_delay) {
            Ok(()) => lines.push(format!(
                "copied {} -> {}",
                entry.path().display(),
                target.display()
            )),
            Err(error) => {
                lines.push(format!(
                    "FAILED {} -> {}: {error}",
                    entry.path().display(),
                    target.display()
                ));
                first_error.get_or_insert(error);
            }
        }
    }
    first_error.map_or(Ok(()), Err)
}

/// Copies `from` (a file, a directory or a link) to a staging name beside
/// `to` and renames it into place, so `to` exists only once it is whole.
fn copy_into_place(from: &Path, to: &Path, retry_delay: Duration) -> io::Result<()> {
    let mut staging = to.as_os_str().to_owned();
    staging.push(STAGING_SUFFIX);
    let staging = PathBuf::from(staging);
    let mut attempt = 1;
    loop {
        remove_any(&staging)?; // a leftover of a run that crashed part way
        let copied = copy_recursive(from, &staging).and_then(|()| fs::rename(&staging, to));
        match copied {
            Ok(()) => return Ok(()),
            Err(error) => {
                let _ = remove_any(&staging);
                if attempt >= COPY_ATTEMPTS {
                    return Err(error);
                }
                attempt += 1;
                std::thread::sleep(retry_delay);
            }
        }
    }
}

fn remove_any(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Err(_) => Ok(()),
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
    }
}

fn copy_recursive(from: &Path, to: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(from)?;
    let kind = meta.file_type();
    if kind.is_dir() {
        fs::create_dir(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &to.join(entry.file_name()))?;
        }
        // After the children: a read-only directory would refuse them.
        let _ = fs::set_permissions(to, meta.permissions());
        Ok(())
    } else if kind.is_file() {
        // fs::copy carries the permission bits, so a 0600 token file stays 0600.
        fs::copy(from, to).map(|_| ())
    } else if kind.is_symlink() {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(fs::read_link(from)?, to)
        }
        #[cfg(not(unix))]
        {
            Ok(()) // nothing Liaison or the webview writes; skipped
        }
    } else {
        Ok(()) // a socket or a fifo: runtime state of the old process, not data
    }
}

/// Runs the migration for this app. Called first thing in `setup`, before the
/// window (and so the webview's store) exists and before anything reads the
/// config directory. Best effort: whatever happens, the app starts.
pub fn run<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    let current_id = app.config().identifier.clone();
    if current_id == LEGACY_IDENTIFIER {
        return;
    }
    let resolver = app.path();
    let Ok(config_dir) = resolver.app_config_dir() else {
        return;
    };
    #[allow(unused_mut)]
    let mut paths: Vec<PathBuf> = [
        resolver.app_config_dir(),
        resolver.app_data_dir(),
        resolver.app_local_data_dir(),
        resolver.app_log_dir(),
    ]
    .into_iter()
    .filter_map(Result::ok)
    .collect();
    #[cfg(target_os = "macos")]
    if let Ok(home) = resolver.home_dir() {
        paths.extend(macos_webkit_paths(&home, &current_id));
    }
    let pairs = pairs_for(&paths, &current_id, LEGACY_IDENTIFIER);
    let outcome = migrate(
        &pairs,
        &config_dir.join(MARKER_FILE),
        Duration::from_millis(750),
    );
    if outcome.lines.is_empty() {
        return;
    }
    // Written AFTER the copy: the log directory is one of the pairs.
    let log = resolver
        .app_log_dir()
        .ok()
        .map(|dir| crate::updater::UpdateLog::in_dir(&dir));
    for line in &outcome.lines {
        let line = format!("identifier migration from {LEGACY_IDENTIFIER}: {line}");
        eprintln!("liaison: {line}");
        if let Some(log) = log.as_ref() {
            log.append(&line);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEW: &str = "sh.liaison.desktop";

    struct Temp(PathBuf);
    impl Temp {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "liaison-idmig-{name}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            Temp(dir)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn pair(root: &Path) -> Pair {
        Pair {
            legacy: root.join(LEGACY_IDENTIFIER),
            current: root.join(NEW),
        }
    }

    #[test]
    fn the_legacy_twin_swaps_the_identifier_in_the_last_component_only() {
        let base = Path::new("/home/u/.config");
        assert_eq!(
            legacy_twin(&base.join(NEW), NEW, LEGACY_IDENTIFIER),
            Some(base.join(LEGACY_IDENTIFIER))
        );
        let jar = Path::new("/Users/u/Library/HTTPStorages").join(format!("{NEW}.binarycookies"));
        assert_eq!(
            legacy_twin(&jar, NEW, LEGACY_IDENTIFIER),
            Some(jar.with_file_name(format!("{LEGACY_IDENTIFIER}.binarycookies")))
        );
        // Windows' log dir is <local>\<id>\logs: covered by the local data pair.
        assert_eq!(
            legacy_twin(&base.join(NEW).join("logs"), NEW, LEGACY_IDENTIFIER),
            None
        );
        assert_eq!(
            legacy_twin(&base.join("sh.liaison.desktopx"), NEW, LEGACY_IDENTIFIER),
            None
        );
        assert_eq!(
            legacy_twin(&base.join("other"), NEW, LEGACY_IDENTIFIER),
            None
        );
    }

    #[test]
    fn pairs_are_deduplicated_and_nested_paths_dropped() {
        let support = PathBuf::from("/Users/u/Library/Application Support").join(NEW);
        let local = PathBuf::from("C:/Users/u/AppData/Local").join(NEW);
        let paths = vec![
            support.clone(),
            support.clone(),
            support.clone(),
            local.clone(),
            local.join("logs"),
        ];
        let pairs = pairs_for(&paths, NEW, LEGACY_IDENTIFIER);
        assert_eq!(pairs.len(), 2);
        assert_eq!(pairs[0].current, support);
        assert_eq!(pairs[1].legacy, local.with_file_name(LEGACY_IDENTIFIER));
    }

    #[test]
    fn the_macos_webkit_stores_are_paired() {
        let home = Path::new("/Users/u");
        let pairs = pairs_for(&macos_webkit_paths(home, NEW), NEW, LEGACY_IDENTIFIER);
        assert_eq!(pairs.len(), 3);
        assert_eq!(
            pairs[0].legacy,
            home.join("Library/WebKit").join(LEGACY_IDENTIFIER)
        );
        assert_eq!(
            pairs[2].legacy,
            home.join("Library/HTTPStorages")
                .join(format!("{LEGACY_IDENTIFIER}.binarycookies"))
        );
    }

    #[test]
    fn copies_a_legacy_tree_and_leaves_the_legacy_one_in_place() {
        let t = Temp::new("copy");
        let p = pair(&t.0);
        write(&p.legacy.join("servers.json"), "[1]");
        write(
            &p.legacy
                .join("EBWebView/Default/Local Storage/leveldb/000003.log"),
            "session",
        );
        let marker = t.0.join("marker");

        let outcome = migrate(std::slice::from_ref(&p), &marker, Duration::ZERO);

        assert!(outcome.complete, "{:?}", outcome.lines);
        assert_eq!(
            fs::read_to_string(p.current.join("servers.json")).unwrap(),
            "[1]"
        );
        assert_eq!(
            fs::read_to_string(
                p.current
                    .join("EBWebView/Default/Local Storage/leveldb/000003.log")
            )
            .unwrap(),
            "session"
        );
        assert!(
            p.legacy.join("servers.json").exists(),
            "the legacy copy is never deleted"
        );
        assert!(marker.exists());
        assert!(outcome.lines.iter().any(|l| l.starts_with("copied ")));
        assert!(!fs::read_dir(&p.current).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(STAGING_SUFFIX)));
    }

    #[test]
    fn an_entry_already_under_the_new_identifier_is_kept_and_never_merged() {
        // The new build's NSIS installer writes <new>\logs\updater.log before
        // the app first starts.
        let t = Temp::new("keep");
        let p = pair(&t.0);
        write(&p.legacy.join("logs/updater.log"), "old log");
        write(&p.legacy.join("logs/sidecar.log"), "old sidecar");
        write(&p.legacy.join("EBWebView/Local State"), "old state");
        write(&p.current.join("logs/updater.log"), "installer line");

        let outcome = migrate(
            std::slice::from_ref(&p),
            &t.0.join("marker"),
            Duration::ZERO,
        );

        assert!(outcome.complete);
        assert_eq!(
            fs::read_to_string(p.current.join("logs/updater.log")).unwrap(),
            "installer line"
        );
        assert!(
            !p.current.join("logs/sidecar.log").exists(),
            "an existing entry is not merged into"
        );
        assert_eq!(
            fs::read_to_string(p.current.join("EBWebView/Local State")).unwrap(),
            "old state"
        );
        assert!(outcome
            .lines
            .iter()
            .any(|l| l.starts_with("kept existing ")));
    }

    #[test]
    fn runs_once_then_never_again() {
        // After the marker, a token the user removed must not come back.
        let t = Temp::new("once");
        let p = pair(&t.0);
        write(&p.legacy.join("token.json"), "refresh");
        let marker = t.0.join("cfg").join(MARKER_FILE);
        assert!(migrate(std::slice::from_ref(&p), &marker, Duration::ZERO).complete);
        fs::remove_file(p.current.join("token.json")).unwrap();

        let again = migrate(std::slice::from_ref(&p), &marker, Duration::ZERO);

        assert!(again.complete);
        assert!(again.lines.is_empty());
        assert!(!p.current.join("token.json").exists());
    }

    #[test]
    fn a_fresh_install_has_nothing_to_copy_and_is_marked_done() {
        let t = Temp::new("fresh");
        let p = pair(&t.0);
        let marker = t.0.join("marker");
        let outcome = migrate(std::slice::from_ref(&p), &marker, Duration::ZERO);
        assert!(outcome.complete);
        assert!(outcome.lines.is_empty());
        assert!(!p.current.exists());
        assert!(marker.exists());
    }

    #[test]
    fn a_single_file_pair_is_copied_once() {
        let t = Temp::new("file");
        let jar = Pair {
            legacy: t.0.join(format!("{LEGACY_IDENTIFIER}.binarycookies")),
            current: t.0.join(format!("{NEW}.binarycookies")),
        };
        write(&jar.legacy, "cookies");
        assert!(
            migrate(
                std::slice::from_ref(&jar),
                &t.0.join("marker"),
                Duration::ZERO
            )
            .complete
        );
        assert_eq!(fs::read_to_string(&jar.current).unwrap(), "cookies");
        assert!(jar.legacy.exists());
    }

    #[test]
    fn a_leftover_staging_copy_of_a_crashed_run_is_replaced() {
        let t = Temp::new("staging");
        let p = pair(&t.0);
        write(&p.legacy.join("EBWebView/Local State"), "whole");
        let mut staging = p.current.join("EBWebView").into_os_string();
        staging.push(STAGING_SUFFIX);
        write(&PathBuf::from(&staging).join("half"), "partial");

        assert!(
            migrate(
                std::slice::from_ref(&p),
                &t.0.join("marker"),
                Duration::ZERO
            )
            .complete
        );
        assert_eq!(
            fs::read_to_string(p.current.join("EBWebView/Local State")).unwrap(),
            "whole"
        );
        assert!(!p.current.join("EBWebView/half").exists());
        assert!(!PathBuf::from(&staging).exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_copy_leaves_no_marker_and_no_partial_entry_then_the_next_run_finishes() {
        use std::os::unix::fs::PermissionsExt;
        let t = Temp::new("fail");
        let p = pair(&t.0);
        write(&p.legacy.join("ok.json"), "ok");
        let locked = p.legacy.join("store");
        write(&locked.join("data"), "db");
        fs::set_permissions(locked.join("data"), fs::Permissions::from_mode(0o000)).unwrap();
        let marker = t.0.join("marker");

        let first = migrate(std::slice::from_ref(&p), &marker, Duration::ZERO);
        // Root reads anything; the property then holds trivially.
        if fs::read(locked.join("data")).is_err() {
            assert!(!first.complete);
            assert!(!marker.exists());
            assert!(!p.current.join("store").exists(), "no half-copied entry");
            assert!(first.lines.iter().any(|l| l.starts_with("FAILED ")));
            assert_eq!(fs::read_to_string(p.current.join("ok.json")).unwrap(), "ok");
        }

        fs::set_permissions(locked.join("data"), fs::Permissions::from_mode(0o600)).unwrap();
        let second = migrate(std::slice::from_ref(&p), &marker, Duration::ZERO);
        assert!(second.complete, "{:?}", second.lines);
        assert_eq!(
            fs::read_to_string(p.current.join("store/data")).unwrap(),
            "db"
        );
        assert!(marker.exists());
    }

    #[cfg(unix)]
    #[test]
    fn file_permissions_survive_the_copy() {
        use std::os::unix::fs::PermissionsExt;
        let t = Temp::new("mode");
        let p = pair(&t.0);
        write(&p.legacy.join("token.json"), "secret");
        fs::set_permissions(
            p.legacy.join("token.json"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        assert!(
            migrate(
                std::slice::from_ref(&p),
                &t.0.join("marker"),
                Duration::ZERO
            )
            .complete
        );
        let mode = fs::metadata(p.current.join("token.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
