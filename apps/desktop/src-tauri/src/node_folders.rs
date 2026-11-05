// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SHARED FOLDERS OF THIS NODE (P1-T38; spec C1, audit L21).
//
// What the node advertises to Liaison: the roots the owner chose in the node
// settings (`sharedRoots` in liaison-node-settings.json, written by the P2
// settings page), else the desktop's recent folders for the current server;
// and every git repository directly under a root. Computed from the disk
// without spawning git, at most `SHARED_FOLDERS_LIMIT` entries, and never
// following a symlink out of a root.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::node_job::NODE_SETTINGS_FILE;
use crate::sidecar::{all_recent_folders_at, app_config_dir, resolve_base_url, write_private};

/// No node advertises more than this many folders.
pub const SHARED_FOLDERS_LIMIT: usize = 500;

/// One writer at a time for the folder settings (shared roots, search roots):
/// every read-modify-write holds it, whoever asks (this window, the cloud, a
/// clone finishing), so no change is lost to another.
pub fn folders_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One folder the node advertises.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedFolder {
    /// The folder's basename, never a path.
    pub name: String,
    pub path: String,
    /// `root` (a chosen root that is not a repository) or `repo`.
    pub kind: &'static str,
    /// `origin`'s default branch, from `.git/refs/remotes/origin/HEAD`.
    pub git_default_branch: Option<String>,
}

/// The roots the owner chose, when the node settings name any.
fn chosen_roots(dir: &Path) -> Option<Vec<String>> {
    let bytes = fs::read(dir.join(NODE_SETTINGS_FILE)).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let roots: Vec<String> = value
        .get("sharedRoots")?
        .as_array()?
        .iter()
        .filter_map(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    Some(roots)
}

/// A `.git` folder or file (a worktree's, a submodule's) as the entry itself,
/// never through a symlink.
fn has_git(dir: &Path) -> bool {
    fs::symlink_metadata(dir.join(".git"))
        .map(|m| m.is_dir() || m.is_file())
        .unwrap_or(false)
}

/// `ref: refs/remotes/origin/<branch>` in `.git/refs/remotes/origin/HEAD`.
pub fn git_default_branch(repo: &Path) -> Option<String> {
    let head = repo
        .join(".git")
        .join("refs")
        .join("remotes")
        .join("origin")
        .join("HEAD");
    let meta = fs::symlink_metadata(&head).ok()?;
    if !meta.is_file() || meta.len() > 4096 {
        return None;
    }
    let text = fs::read_to_string(&head).ok()?;
    let branch = text
        .trim()
        .strip_prefix("ref:")?
        .trim()
        .strip_prefix("refs/remotes/origin/")?
        .to_string();
    (!branch.is_empty() && !branch.chars().any(char::is_whitespace)).then_some(branch)
}

fn basename(path: &Path) -> String {
    clean_name(
        &path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned()),
    )
}

/// A name as it may be shown anywhere (the card, an approval, the agent):
/// without control characters or bidirectional overrides, which could make
/// `app<RLO>gpj.exe` read as another name (review m4).
pub fn clean_name(name: &str) -> String {
    name.chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(
                    *c,
                    '\u{200e}' | '\u{200f}' | '\u{061c}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
                )
        })
        .collect()
}

fn folder(path: &Path, kind: &'static str) -> SharedFolder {
    SharedFolder {
        name: basename(path),
        path: path.to_string_lossy().into_owned(),
        kind,
        git_default_branch: if kind == "repo" {
            git_default_branch(path)
        } else {
            None
        },
    }
}

/// Every folder this node advertises for `server`, from the shell's config `dir`.
pub fn shared_folders_at(dir: &Path, server: &str) -> Vec<SharedFolder> {
    shared_folders_for(dir, &process_home(), server)
}

/// This user's home folder, as the shell's process knows it.
fn process_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// A root that confines nothing: the home folder, a folder above it (`/`,
/// `/Users`), or a link to one, once resolved. Such a root (an old recent
/// folder, say) is listed with a note, never offered, and dropped from the
/// list the next time it is saved (review m1).
pub fn confines_nothing(raw: &str, home: &Path) -> bool {
    let path = PathBuf::from(raw.trim());
    let real = fs::canonicalize(&path).unwrap_or(path);
    let real_home = fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    real_home.starts_with(&real) || home.starts_with(&real)
}

/// The shared folders offered to sessions, re-checked now: every root
/// resolved through its links, never the home folder or above it.
pub fn shared_folders_for(dir: &Path, home: &Path, server: &str) -> Vec<SharedFolder> {
    let roots: Vec<String> = shared_roots_at(dir, server)
        .roots
        .into_iter()
        .filter(|r| !confines_nothing(r, home))
        .collect();
    let mut out: Vec<SharedFolder> = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut push = |out: &mut Vec<SharedFolder>, entry: SharedFolder, path: PathBuf| {
        let path = fs::canonicalize(&path).unwrap_or(path);
        if out.len() < SHARED_FOLDERS_LIMIT && !seen.contains(&path) {
            seen.push(path);
            out.push(entry);
        }
    };
    for raw in roots {
        let root = PathBuf::from(raw.trim());
        // A root missing on disk is listed in the settings, never offered.
        if !root.is_absolute() || !root.is_dir() {
            continue;
        }
        let kind = if has_git(&root) { "repo" } else { "root" };
        push(&mut out, folder(&root, kind), root.clone());
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        let mut children: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            // A symlink is never followed out of a root.
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .filter(|p| has_git(p))
            .collect();
        children.sort();
        for child in children {
            push(&mut out, folder(&child, "repo"), child);
        }
    }
    out
}

/// The shared folders of this node, for the current server (C1, L21).
#[tauri::command]
pub fn node_shared_folders<R: Runtime>(app: AppHandle<R>) -> Vec<SharedFolder> {
    match (app_config_dir(&app), resolve_base_url(&app)) {
        (Some(dir), Some(server)) => match app.path().home_dir() {
            Ok(home) => shared_folders_for(&dir, &home, &server),
            Err(_) => Vec::new(),
        },
        _ => Vec::new(),
    }
}

// ─── The chosen roots (P2-T15, L21) ───────────────────────────────────────

/// A new root that is not an absolute path, or is named with `..`.
pub const SHARED_ROOT_REFUSED: &str = "SharedRootRefused";
/// A new root that does not exist, or is not a folder.
pub const SHARED_ROOT_MISSING: &str = "SharedRootMissing";
/// A new root that is the home folder or contains it.
pub const SHARED_ROOT_HOME: &str = "SharedRootHome";

/// The roots the node shares, whether they are the recent-folders default,
/// and which of them are missing on disk (listed so the owner can remove them;
/// never offered to sessions: `shared_folders_at` skips them).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedRoots {
    pub roots: Vec<String>,
    pub is_default: bool,
    pub missing: Vec<String>,
    /// Roots never offered: the home folder or above it (shown with a note).
    #[serde(default)]
    pub refused: Vec<String>,
    /// Roots the last save dropped for that reason (the note after a change).
    #[serde(default)]
    pub dropped: Vec<String>,
    /// The roots that are git repositories, each with `origin`'s default
    /// branch when known (the settings show "Git repository · main").
    #[serde(default)]
    pub repos: Vec<SharedRootRepo>,
}

/// A shared root that is a git repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedRootRepo {
    pub path: String,
    pub default_branch: Option<String>,
}

/// The view the settings show: with the roots that confine nothing marked.
pub fn shared_roots_view(
    dir: &Path,
    home: &Path,
    server: &str,
    dropped: Vec<String>,
) -> SharedRoots {
    let mut view = shared_roots_at(dir, server);
    view.refused = view
        .roots
        .iter()
        .filter(|r| confines_nothing(r, home))
        .cloned()
        .collect();
    view.dropped = dropped;
    view
}

/// What two spellings of one folder share: its real path when it exists
/// (`/tmp/x` and `/private/tmp/x`, `code` and `code/`, a link and its target),
/// else the path as named.
fn root_key(raw: &str) -> PathBuf {
    let path = PathBuf::from(raw.trim());
    fs::canonicalize(&path).unwrap_or(path)
}

/// `roots` without the second spelling of a folder already listed.
fn dedupe_roots(roots: Vec<String>) -> Vec<String> {
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut out = Vec::new();
    for raw in roots {
        let key = root_key(&raw);
        if !seen.contains(&key) {
            seen.push(key);
            out.push(raw);
        }
    }
    out
}

/// The chosen roots, else the recent folders for `server` (the default).
pub fn shared_roots_at(dir: &Path, server: &str) -> SharedRoots {
    let (roots, is_default) = match chosen_roots(dir) {
        Some(roots) => (roots, false),
        None => (all_recent_folders_at(dir, server), true),
    };
    let roots = dedupe_roots(roots);
    let missing = roots
        .iter()
        .filter(|r| !Path::new(r.trim()).is_dir())
        .cloned()
        .collect();
    let repos = roots
        .iter()
        .filter(|r| has_git(Path::new(r.trim())))
        .map(|r| SharedRootRepo {
            path: r.clone(),
            default_branch: git_default_branch(Path::new(r.trim())),
        })
        .collect();
    SharedRoots {
        roots,
        is_default,
        missing,
        refused: Vec::new(),
        dropped: Vec::new(),
        repos,
    }
}

/// A root is an existing absolute folder, named without `..`, that is not the
/// home folder or above it once links are resolved (P1-fix F5: such a folder
/// confines nothing). The error names the rule that failed.
pub fn validate_shared_root(raw: &str, home: &Path) -> Result<PathBuf, &'static str> {
    let path = PathBuf::from(raw.trim());
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(SHARED_ROOT_REFUSED);
    }
    let real = fs::canonicalize(&path).map_err(|_| SHARED_ROOT_MISSING)?;
    if !real.is_dir() {
        return Err(SHARED_ROOT_MISSING);
    }
    let real_home = fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    if real_home.starts_with(&real) || home.starts_with(&path) {
        return Err(SHARED_ROOT_HOME);
    }
    Ok(path)
}

/// Writes the chosen roots (Some) or goes back to the recent folders (None).
/// Only a root that is not already shared (the chosen roots, or the recent
/// folders of `server` while they are the default) is checked: a removal, or an
/// addition next to a folder since deleted, never fails because of a root the
/// owner did not just pick. One refused new root changes nothing. Editing the
/// default turns it into a chosen list, so a removed recent folder stays removed.
pub fn set_shared_roots_at(
    dir: &Path,
    home: &Path,
    server: &str,
    roots: Option<Vec<String>>,
) -> Result<Vec<String>, &'static str> {
    let mut dropped: Vec<String> = Vec::new();
    let mut map: serde_json::Map<String, serde_json::Value> =
        fs::read(dir.join(NODE_SETTINGS_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
    match roots {
        Some(list) => {
            // Already shared, spelled exactly as the settings list it.
            let current: Vec<String> = shared_roots_at(dir, server)
                .roots
                .iter()
                .map(|r| r.trim().to_string())
                .collect();
            let mut kept: Vec<String> = Vec::new();
            let mut keys: Vec<PathBuf> = Vec::new();
            for raw in list {
                let path = if current.contains(&raw.trim().to_string()) {
                    // Carried over without a check, except that a root that
                    // confines nothing never makes it into a chosen list.
                    if confines_nothing(&raw, home) {
                        dropped.push(raw.trim().to_string());
                        continue;
                    }
                    raw.trim().to_string()
                } else {
                    validate_shared_root(&raw, home)?
                        .to_string_lossy()
                        .into_owned()
                };
                let key = root_key(&path);
                if keys.contains(&key) {
                    continue;
                }
                keys.push(key);
                kept.push(path);
            }
            map.insert("sharedRoots".into(), serde_json::json!(kept));
        }
        None => {
            map.remove("sharedRoots");
        }
    }
    fs::create_dir_all(dir).map_err(|_| SHARED_ROOT_REFUSED)?;
    let bytes =
        serde_json::to_vec(&serde_json::Value::Object(map)).map_err(|_| SHARED_ROOT_REFUSED)?;
    write_private(&dir.join(NODE_SETTINGS_FILE), &bytes).map_err(|_| SHARED_ROOT_REFUSED)?;
    Ok(dropped)
}

/// The roots this node shares, for the current server (L21).
#[tauri::command]
pub fn node_shared_roots<R: Runtime>(app: AppHandle<R>) -> Result<SharedRoots, String> {
    let dir = app_config_dir(&app).ok_or("no application config directory")?;
    let server = resolve_base_url(&app).unwrap_or_default();
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(shared_roots_view(&dir, &home, &server, Vec::new()))
}

/// Sets the shared roots (None: back to the recent folders). A refused new
/// root answers the code of the rule it broke and changes nothing.
#[tauri::command]
pub fn set_node_shared_roots<R: Runtime>(
    app: AppHandle<R>,
    roots: Option<Vec<String>>,
) -> Result<SharedRoots, String> {
    let dir = app_config_dir(&app).ok_or("no application config directory")?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let server = resolve_base_url(&app).unwrap_or_default();
    let _writer = folders_lock();
    let dropped = set_shared_roots_at(&dir, &home, &server, roots).map_err(str::to_string)?;
    Ok(shared_roots_view(&dir, &home, &server, dropped))
}

// ─── Search roots and finding a folder by name ────────────────────────────
//
// The owner lists the folders Liaison may SEARCH in (the home folder is fine:
// a lookup only lists folder paths). A lookup walks only those, never shares
// anything: sharing keeps its own rules (validate_shared_root).

/// No lookup answers more than this many folders.
pub const LOOKUP_LIMIT: usize = 10;
/// How deep a lookup walks under each search root (its children are depth 1).
pub const LOOKUP_DEPTH: usize = 4;
/// How many folders one lookup reads at most, whatever it finds.
const LOOKUP_VISIT_BUDGET: usize = 30_000;
/// Folders a lookup never enters: bulky, generated or system ones.
const LOOKUP_SKIP: [&str; 9] = [
    "node_modules",
    "Library",
    "target",
    "dist",
    "build",
    "vendor",
    "Pods",
    "System",
    "Applications",
];
/// Bundles are files to the person, folders to the disk: never entered.
const LOOKUP_SKIP_SUFFIXES: [&str; 5] = [
    ".app",
    ".bundle",
    ".framework",
    ".photoslibrary",
    ".xcarchive",
];

/// A search root that is not an existing absolute folder named without `..`.
pub const SEARCH_ROOT_REFUSED: &str = "SearchRootRefused";
/// A search root above the home folder (`/`, `/Users`): too wide to walk.
pub const SEARCH_ROOT_ABOVE_HOME: &str = "SearchRootAboveHome";
/// A hidden folder, `~/Library` or a system folder: never searched.
pub const SEARCH_ROOT_SYSTEM: &str = "SearchRootSystem";

/// The folders Liaison may search in (`searchRoots` in the node settings).
/// With no `searchRoots` key at all (a fresh install), the home folder, so
/// "Add a folder" finds projects out of the box; a list the owner emptied
/// stays empty.
pub fn search_roots_at(dir: &Path, home: &Path) -> Vec<String> {
    let value = fs::read(dir.join(NODE_SETTINGS_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok());
    let Some(listed) = value
        .as_ref()
        .and_then(|v| v.get("searchRoots"))
        .and_then(|v| v.as_array())
    else {
        return vec![home.to_string_lossy().into_owned()];
    };
    dedupe_roots(
        listed
            .iter()
            .filter_map(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
    )
}

/// No `searchRoots` key at all: the roots are the implicit home default.
pub fn search_roots_are_default(dir: &Path) -> bool {
    fs::read(dir.join(NODE_SETTINGS_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v.get("searchRoots").map(|r| r.is_array()))
        != Some(true)
}

/// The search roots the import sidecar may read under although its own guard
/// would not (A4), as absolute paths from the owner's settings: a root
/// outside the home folder, one inside a protected home folder, and the home
/// folder itself when the owner listed it. The implicit default (the home
/// folder, without its protected folders) and a plain folder inside the home
/// folder add nothing: the sidecar reads those with its own checks.
pub fn import_search_roots(dir: &Path, home: &Path) -> Vec<String> {
    if search_roots_are_default(dir) {
        return Vec::new();
    }
    let real_home = fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    let mut out: Vec<String> = Vec::new();
    for raw in search_roots_at(dir, home) {
        let root = expand_home(&raw, home);
        if !root.is_absolute()
            || root
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            continue;
        }
        let in_home = root.starts_with(home) || root.starts_with(&real_home);
        let is_home = root == home || root == real_home;
        if !in_home || is_home || in_protected_home(&root, home, &real_home) {
            let s = root.to_string_lossy().into_owned();
            if !out.contains(&s) {
                out.push(s);
            }
        }
    }
    out
}

/// A path inside one of the home folder's protected folders (`~/Documents/x`).
fn in_protected_home(path: &Path, home: &Path, real_home: &Path) -> bool {
    [home, real_home].iter().any(|h| {
        path.strip_prefix(h).ok().and_then(|rest| rest.components().next()).is_some_and(|c| {
            PROTECTED_IN_HOME.contains(&c.as_os_str().to_string_lossy().as_ref())
        })
    })
}

/// `~` and `~/…` (typed on a phone) name the home folder and what is in it.
fn expand_home(raw: &str, home: &Path) -> PathBuf {
    let raw = raw.trim();
    if raw == "~" {
        return home.to_path_buf();
    }
    match raw.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(raw),
    }
}

/// A search root is an existing absolute folder, named without `..`, that is
/// the home folder or not above it.
pub fn validate_search_root(raw: &str, home: &Path) -> Result<PathBuf, &'static str> {
    let path = expand_home(raw, home);
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(SEARCH_ROOT_REFUSED);
    }
    let real = fs::canonicalize(&path).map_err(|_| SHARED_ROOT_MISSING)?;
    if !real.is_dir() {
        return Err(SHARED_ROOT_MISSING);
    }
    let real_home = fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    if real_home.starts_with(&real) && real != real_home {
        return Err(SEARCH_ROOT_ABOVE_HOME);
    }
    if hidden_or_system(&real, &real_home) {
        return Err(SEARCH_ROOT_SYSTEM);
    }
    Ok(path)
}

/// Top-level system folders Liaison never searches or shares.
const SYSTEM_TOP: [&str; 12] = [
    "System",
    "Library",
    "private",
    "usr",
    "bin",
    "sbin",
    "etc",
    "dev",
    "var",
    "opt",
    "cores",
    "Applications",
];

/// A hidden component anywhere (below the home for a home path), `~/Library`,
/// or a system folder of the disk.
pub fn hidden_or_system(real: &Path, real_home: &Path) -> bool {
    let below_home = real.strip_prefix(real_home).ok();
    let hidden = |p: &Path| {
        p.components()
            .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
    };
    match below_home {
        Some(rest) => {
            hidden(rest)
                || rest
                    .components()
                    .next()
                    .is_some_and(|c| c.as_os_str() == "Library")
        }
        None => {
            hidden(real)
                || real
                    .components()
                    .nth(1)
                    .is_some_and(|c| SYSTEM_TOP.contains(&c.as_os_str().to_string_lossy().as_ref()))
        }
    }
}

/// Writes the search roots. As with the shared roots, only a root not already
/// listed is checked, so removing one never fails on another since deleted.
pub fn set_search_roots_at(
    dir: &Path,
    home: &Path,
    roots: Vec<String>,
) -> Result<(), &'static str> {
    let current = search_roots_at(dir, home);
    let mut kept: Vec<String> = Vec::new();
    let mut keys: Vec<PathBuf> = Vec::new();
    for raw in roots {
        let path = if current.contains(&raw.trim().to_string()) {
            raw.trim().to_string()
        } else {
            validate_search_root(&raw, home)?
                .to_string_lossy()
                .into_owned()
        };
        let key = root_key(&path);
        if !keys.contains(&key) {
            keys.push(key);
            kept.push(path);
        }
    }
    let mut map: serde_json::Map<String, serde_json::Value> =
        fs::read(dir.join(NODE_SETTINGS_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
    map.insert("searchRoots".into(), serde_json::json!(kept));
    fs::create_dir_all(dir).map_err(|_| SEARCH_ROOT_REFUSED)?;
    let bytes =
        serde_json::to_vec(&serde_json::Value::Object(map)).map_err(|_| SEARCH_ROOT_REFUSED)?;
    write_private(&dir.join(NODE_SETTINGS_FILE), &bytes).map_err(|_| SEARCH_ROOT_REFUSED)
}

/// One folder a lookup found. `display` is the path with the home folder as
/// `~`; `path` stays on the owner's own rows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderCandidate {
    pub name: String,
    pub path: String,
    /// The node's own single-use proof that it found this folder: a share
    /// from the cloud must carry it (`share_at`).
    pub token: String,
    pub display: String,
    pub is_repo: bool,
    /// Already among the shared roots.
    pub shared: bool,
    /// Could be shared as it is (not the home folder or above it).
    pub shareable: bool,
}

/// A lookup's answer: how many search roots there are (none: nothing was
/// searched, and the owner is told to add one) and what was found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupAnswer {
    pub search_roots: usize,
    pub candidates: Vec<FolderCandidate>,
    /// The search stopped early (time or folder budget): there may be more.
    pub partial: bool,
    /// The places the OS refused to let Liaison read (`~/Documents` before
    /// the person allows it on a Mac): nothing in them was searched.
    pub denied: Vec<String>,
    /// The roots are the implicit home default, so the home folder's
    /// protected folders (Documents, Desktop, Downloads) were not searched.
    #[serde(default)]
    pub skipped_protected: bool,
}

/// How long one lookup walks, all search roots together.
pub const LOOKUP_TIME: std::time::Duration = std::time::Duration::from_secs(3);

/// A query is a folder name: 1 to 100 characters, no path separator, no
/// quote, no control character, not `.` or `..`.
pub fn lookup_query_ok(query: &str) -> bool {
    let q = query.trim();
    !q.is_empty()
        && q.chars().count() <= 100
        && q != "."
        && q != ".."
        && !q
            .chars()
            .any(|c| c == '/' || c == '\\' || c == '\'' || c == '"' || c.is_control())
}

fn skipped(name: &str) -> bool {
    name.starts_with('.')
        || LOOKUP_SKIP.contains(&name)
        || LOOKUP_SKIP_SUFFIXES.iter().any(|s| name.ends_with(s))
}

fn display_path(path: &Path, home: &Path, real_home: &Path) -> String {
    for h in [home, real_home] {
        if path == h {
            return "~".into();
        }
        if let Ok(rest) = path.strip_prefix(h) {
            return format!("~/{}", rest.to_string_lossy());
        }
    }
    path.to_string_lossy().into_owned()
}

/// How a found folder reads: `~/…` in the home folder, else from its search
/// root's name (`Data/work/x`): never an absolute path (review m4).
fn candidate_display(real: &Path, root: &Path, home: &Path, real_home: &Path) -> String {
    let text = if real.starts_with(real_home) || real.starts_with(home) {
        display_path(real, home, real_home)
    } else {
        let below = real.strip_prefix(root).unwrap_or(real);
        format!("{}/{}", basename(root), below.to_string_lossy())
    };
    clean_name(&text)
}

/// How well a folder name answers the query: 0 exact (ignoring case), 1 a
/// prefix, 2 contains it; None otherwise.
fn match_rank(name: &str, query: &str) -> Option<u8> {
    let n = name.to_lowercase();
    let q = query.trim().to_lowercase();
    if n == q {
        Some(0)
    } else if n.starts_with(&q) {
        Some(1)
    } else if n.contains(&q) {
        Some(2)
    } else {
        None
    }
}

/// The folders macOS asks the person before an app reads (TCC): entered only
/// when the search root is one of them or inside one, or the home folder the
/// owner chose explicitly (confirmed in the app). The implicit home default
/// (no `searchRoots` key) never enters them, so a lookup on an unattended
/// computer never raises a privacy prompt.
const PROTECTED_IN_HOME: [&str; 4] = ["Documents", "Desktop", "Downloads", "Library"];

/// How many links (symlinks, Windows junctions) one lookup follows at most.
const LOOKUP_LINK_LIMIT: usize = 32;

/// The device a folder is on, to never walk into another filesystem (a
/// network or external volume mounted inside a root) unless it is a root
/// itself, or a link leads there.
fn device_of(path: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        fs::metadata(path).ok().map(|m| m.dev())
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

/// Hidden or system to the OS itself: Windows marks `AppData` and the old
/// profile junctions (`Application Data`, `My Documents`) so, not with a dot.
fn os_hidden(entry: &fs::DirEntry) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        const SYSTEM: u32 = 0x4;
        entry
            .metadata()
            .map(|m| m.file_attributes() & (HIDDEN | SYSTEM) != 0)
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let _ = entry;
        false
    }
}

/// The OS refused to let Liaison read this folder (macOS privacy: Documents,
/// Desktop, Downloads, an external volume; or plain permissions).
pub fn access_denied(path: &Path) -> bool {
    matches!(fs::read_dir(path), Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied)
}

/// One place a lookup walks: a search root (`depth` 0), or the folder a link
/// inside one leads to (`~/Documents` on another volume, a Windows junction,
/// `depth` levels below its search root). `logical` is how the person reaches
/// it; `real` is where it is.
#[derive(Debug, Clone)]
struct WalkRoot {
    real: PathBuf,
    logical: PathBuf,
    depth: usize,
    device: Option<u64>,
}

/// What one walk saw: matches as `(rank, depth, logical path)`, the places it
/// walked, the folders the OS refused to open, and whether it finished.
struct Walk {
    found: Vec<(u8, usize, PathBuf)>,
    roots: Vec<WalkRoot>,
    denied: Vec<PathBuf>,
    complete: bool,
}

/// Folders `matcher` ranks (named like a lookup's query, or a repository for
/// a scan) under the search `roots` (real paths), at most `max_depth` levels down, never a hidden, a system folder or a bundle,
/// and never inside a repository. Breadth first across every root at once, so
/// one large root never starves the others. A link to a folder is followed
/// (macOS `~/Documents` moved to another disk, Linux XDG links, Windows
/// junctions) unless it leads to a hidden or system folder, the home folder
/// or above it, or somewhere already walked: each target is walked once, so a
/// loop of links ends.
fn walk_roots(
    roots: &[PathBuf],
    real_home: &Path,
    matcher: &dyn Fn(&Path) -> Option<u8>,
    max_depth: usize,
    budget: &mut usize,
    deadline: std::time::Instant,
    skip_protected: bool,
) -> Walk {
    let mut walk = Walk {
        found: Vec::new(),
        roots: roots
            .iter()
            .map(|r| WalkRoot {
                real: r.clone(),
                logical: r.clone(),
                depth: 0,
                device: device_of(r),
            })
            .collect(),
        denied: Vec::new(),
        complete: true,
    };
    // A protected folder is entered only from the home folder the owner
    // chose, never from the implicit default (`skip_protected`).
    let protected_ok = |root: &Path, child: &Path| {
        let Ok(rest) = child.strip_prefix(real_home) else {
            return true;
        };
        let first_level = rest.components().count() == 1;
        !(first_level
            && (root != real_home || skip_protected)
            && PROTECTED_IN_HOME.contains(&basename(child).as_str())
            && !root.starts_with(child))
    };
    // The links right inside each search root first, whatever the time: the
    // OS index is asked inside them too, so a slow walk still finds what
    // lies behind `~/Documents`.
    for i in 0..roots.len() {
        let Ok(entries) = fs::read_dir(&roots[i]) else {
            continue;
        };
        let mut links: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .filter(|e| !os_hidden(e) && e.file_type().is_ok_and(|t| t.is_symlink()))
            .map(|e| e.path())
            .filter(|p| !skipped(&basename(p)) && protected_ok(&roots[i], p))
            .collect();
        links.sort();
        for link in links {
            if walk.roots.len() >= roots.len() + LOOKUP_LINK_LIMIT {
                break;
            }
            if let Some(target) = link_target(&link, real_home, &walk.roots) {
                walk.roots.push(WalkRoot {
                    device: device_of(&target),
                    real: target,
                    logical: link,
                    depth: 1,
                });
            }
        }
    }
    // (folder to read, the walk root it belongs to)
    let mut level: Vec<(PathBuf, usize)> = (0..walk.roots.len())
        .map(|i| (walk.roots[i].logical.clone(), i))
        .collect();
    for depth in 1..=max_depth {
        let mut next = Vec::new();
        for (dir, at) in level {
            if std::time::Instant::now() >= deadline {
                walk.complete = false;
                return walk;
            }
            let entries = match fs::read_dir(&dir) {
                Ok(entries) => entries,
                Err(e) => {
                    if e.kind() == std::io::ErrorKind::PermissionDenied {
                        walk.denied.push(dir);
                    }
                    continue;
                }
            };
            let root = walk.roots[at].clone();
            let mut children: Vec<(PathBuf, bool)> = entries
                .filter_map(Result::ok)
                .filter(|e| !os_hidden(e))
                .filter_map(|e| {
                    let t = e.file_type().ok()?;
                    if t.is_dir() && !t.is_symlink() {
                        Some((e.path(), false))
                    } else if t.is_symlink() {
                        Some((e.path(), true))
                    } else {
                        None
                    }
                })
                .filter(|(p, _)| !skipped(&basename(p)) && !node_scratch(p, real_home))
                .filter(|(p, _)| protected_ok(&root.logical, p))
                .collect();
            children.sort();
            for (child, link) in children {
                let mut walk_in = !has_git(&child);
                let mut owner = at;
                if link {
                    // Only a link to a folder, followed to where it leads.
                    let Ok(target) = fs::canonicalize(&child) else {
                        continue;
                    };
                    if !target.is_dir()
                        || real_home.starts_with(&target)
                        || hidden_or_system(&target, real_home)
                    {
                        continue;
                    }
                    if let Some(i) = walk.roots.iter().position(|r| r.logical == child) {
                        // Found before the walk (right inside its search root).
                        owner = i;
                    } else if link_target(&child, real_home, &walk.roots).is_none()
                        || walk.roots.len() >= roots.len() + LOOKUP_LINK_LIMIT
                    {
                        // Its folders are (or would be) found from elsewhere.
                        walk_in = false;
                    } else if walk_in {
                        walk.roots.push(WalkRoot {
                            device: device_of(&target),
                            real: target,
                            logical: child.clone(),
                            depth,
                        });
                        owner = walk.roots.len() - 1;
                    }
                } else if root.device.is_some() && device_of(&child) != root.device {
                    // Never into another filesystem mounted inside (a network share).
                    continue;
                }
                if *budget == 0 {
                    walk.complete = false;
                    return walk;
                }
                *budget -= 1;
                if let Some(rank) = matcher(&child) {
                    walk.found.push((rank, depth, child.clone()));
                }
                if walk_in {
                    next.push((child, owner));
                }
            }
        }
        level = next;
    }
    walk
}

/// The node's own session worktrees (`~/Liaison Node/worktrees`): throwaway
/// copies a session works in, never a folder the person means.
fn node_scratch(path: &Path, real_home: &Path) -> bool {
    path.starts_with(
        real_home
            .join(crate::node_job::NODE_ROOT_NAME)
            .join("worktrees"),
    )
}

/// Where a link leads, when the lookup may walk there: an existing folder,
/// not the home folder or above it, not hidden or system, and not already
/// walked (a loop of links ends there).
fn link_target(link: &Path, real_home: &Path, walked: &[WalkRoot]) -> Option<PathBuf> {
    let target = fs::canonicalize(link).ok()?;
    let ok = target.is_dir()
        && !real_home.starts_with(&target)
        && !hidden_or_system(&target, real_home)
        && !walked.iter().any(|r| target.starts_with(&r.real));
    ok.then_some(target)
}

/// Where a folder (a real path) sits among the walked places: the place that
/// holds it most closely, how the person reaches it, and how deep it is below
/// its search root.
fn place_of<'a>(real: &Path, roots: &'a [WalkRoot]) -> Option<(&'a WalkRoot, PathBuf, usize)> {
    let root = roots
        .iter()
        .filter(|r| real.starts_with(&r.real) && (r.depth > 0 || real != r.real))
        .max_by_key(|r| r.real.components().count())?;
    let below = real.strip_prefix(&root.real).ok()?;
    Some((
        root,
        root.logical.join(below),
        root.depth + below.components().count(),
    ))
}

/// The search roots as listed, the real folders among them (each once), and
/// the ones the OS refused to open (shown as `~/…`).
fn resolve_search_roots(
    dir: &Path,
    home: &Path,
    real_home: &Path,
) -> (Vec<String>, Vec<PathBuf>, Vec<String>) {
    let listed = search_roots_at(dir, home);
    let mut denied: Vec<String> = Vec::new();
    let mut roots: Vec<PathBuf> = Vec::new();
    for raw in &listed {
        let path = expand_home(raw, home);
        match fs::canonicalize(&path) {
            Ok(real) if real.is_dir() => {
                if !roots.contains(&real) {
                    roots.push(real)
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                denied.push(display_path(&path, home, real_home))
            }
            _ => {}
        }
    }
    (listed, roots, denied)
}

/// A found folder that passed the walk's own rules, wherever it came from.
struct Placed {
    real: PathBuf,
    /// The way the person reaches it (the walk's own path when it has one).
    shown: PathBuf,
    search_root: PathBuf,
    below_root: usize,
}

/// Where a found folder sits, when the walk's rules allow it: inside a walked
/// place, below its search root, nothing hidden or skipped on the way, at most
/// `max_depth` below the search root, never inside a repository and never the
/// node's own scratch.
fn place_found(
    path: &Path,
    depth: usize,
    max_depth: usize,
    walked: &[WalkRoot],
    roots: &[PathBuf],
    real_home: &Path,
) -> Option<Placed> {
    let real = fs::canonicalize(path).ok()?;
    let (root, logical, below_root) = place_of(&real, walked)?;
    let below = real.strip_prefix(&root.real).unwrap_or(&real);
    if !real.is_dir()
        || node_scratch(&real, real_home)
        || below
            .components()
            .any(|c| skipped(&c.as_os_str().to_string_lossy()))
    {
        return None;
    }
    if below_root > max_depth
        || real
            .ancestors()
            .skip(1)
            .take_while(|a| *a != root.real.as_path())
            .any(has_git)
    {
        return None;
    }
    let shown = if depth <= max_depth {
        path.to_path_buf()
    } else {
        logical
    };
    let search_root = roots
        .iter()
        .find(|r| shown.starts_with(r))
        .cloned()
        .unwrap_or_else(|| root.real.clone());
    Some(Placed {
        real,
        shown,
        search_root,
        below_root,
    })
}

/// The folders named like `query` inside the search roots (owner's lookup,
/// from any client): a bounded walk of each root, plus `spotlight` (the OS
/// index, asked only inside the walked places). Exact names first,
/// repositories before plain folders, shallower first; never outside a search
/// root or a link inside one, never a hidden, system or bundle folder; at most
/// `LOOKUP_LIMIT`. Names and paths only: no file is read.
pub fn lookup_folders_at(
    dir: &Path,
    server: &str,
    home: &Path,
    query: &str,
    spotlight: &dyn Fn(&str, &[PathBuf]) -> Vec<String>,
    tokens: &CandidateTokens,
) -> LookupAnswer {
    lookup_folders_within(dir, server, home, query, spotlight, tokens, LOOKUP_TIME)
}

/// `lookup_folders_at`, walking for at most `time` (the rest is `partial`).
pub fn lookup_folders_within(
    dir: &Path,
    server: &str,
    home: &Path,
    query: &str,
    spotlight: &dyn Fn(&str, &[PathBuf]) -> Vec<String>,
    tokens: &CandidateTokens,
    time: std::time::Duration,
) -> LookupAnswer {
    let deadline = std::time::Instant::now() + time;
    let real_home = fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    let (listed, roots, mut denied) = resolve_search_roots(dir, home, &real_home);
    let skip_protected = search_roots_are_default(dir);
    if roots.is_empty() || !lookup_query_ok(query) {
        return LookupAnswer {
            search_roots: listed.len(),
            candidates: Vec::new(),
            partial: false,
            denied,
            skipped_protected: skip_protected && !roots.is_empty(),
        };
    }
    let shared: Vec<PathBuf> = shared_roots_at(dir, server)
        .roots
        .iter()
        .map(|r| root_key(r))
        .collect();
    let mut budget = LOOKUP_VISIT_BUDGET;
    let walk = walk_roots(
        &roots,
        &real_home,
        &|p: &Path| match_rank(&basename(p), query),
        LOOKUP_DEPTH,
        &mut budget,
        deadline,
        skip_protected,
    );
    for d in &walk.denied {
        let shown = display_path(d, home, &real_home);
        if !denied.contains(&shown) {
            denied.push(shown);
        }
    }
    let mut found = walk.found;
    let reals: Vec<PathBuf> = walk.roots.iter().map(|r| r.real.clone()).collect();
    for raw in spotlight(query.trim(), &reals) {
        let p = PathBuf::from(raw.trim());
        // The implicit default never touches a protected folder, not even to
        // check what the OS index answered (a stat there can prompt).
        if skip_protected && in_protected_home(&p, home, &real_home) {
            continue;
        }
        if let Some(rank) = match_rank(&basename(&p), query) {
            found.push((rank, LOOKUP_DEPTH + 1, p));
        }
    }
    let mut ranked: Vec<(u8, bool, usize, PathBuf, PathBuf, PathBuf)> = Vec::new();
    for (rank, depth, path) in found {
        let Some(placed) = place_found(&path, depth, LOOKUP_DEPTH, &walk.roots, &roots, &real_home)
        else {
            continue;
        };
        ranked.push((
            rank,
            !has_git(&placed.real),
            placed.below_root,
            placed.real,
            placed.shown,
            placed.search_root,
        ));
    }
    ranked.sort_by(|a, b| (a.0, a.1, a.2, &a.3).cmp(&(b.0, b.1, b.2, &b.3)));
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut candidates = Vec::new();
    for (_, not_repo, _, real, path, root) in ranked {
        if candidates.len() >= LOOKUP_LIMIT {
            break;
        }
        if seen.contains(&real) {
            continue;
        }
        seen.push(real.clone());
        candidates.push(FolderCandidate {
            token: tokens.issue(&path),
            name: basename(&path),
            display: candidate_display(&path, &root, home, &real_home),
            path: path.to_string_lossy().into_owned(),
            is_repo: !not_repo,
            shared: shared.contains(&real),
            shareable: !real_home.starts_with(&real),
        });
    }
    LookupAnswer {
        search_roots: listed.len(),
        candidates,
        partial: !walk.complete,
        denied,
        skipped_protected: skip_protected,
    }
}

// ─── Sharing from the cloud: only what this node found (M1) ───────────────

/// How long a lookup's proof stays good.
pub const CANDIDATE_TTL: std::time::Duration = std::time::Duration::from_secs(60 * 60);
/// A share from the cloud that carries no proof this node issued (or a used one).
pub const SHARE_NOT_ISSUED: &str = "ShareNotIssued";
/// A folder outside the search roots and the recent folders, hidden, or system.
pub const SHARE_OUTSIDE: &str = "ShareOutsideSearchRoots";

/// At most this many proofs are kept (a scan issues up to 500 at once).
pub const CANDIDATE_TOKENS_MAX: usize = 4000;

/// The proofs this node issued for its lookups: random, single use, an hour.
#[derive(Default)]
pub struct CandidateTokens {
    issued: std::sync::Mutex<Vec<(String, PathBuf, std::time::Instant)>>,
}

impl CandidateTokens {
    pub fn issue(&self, path: &Path) -> String {
        self.issue_for(path, CANDIDATE_TTL)
    }

    pub fn issue_for(&self, path: &Path, ttl: std::time::Duration) -> String {
        let mut bytes = [0u8; 16];
        let _ = getrandom::fill(&mut bytes);
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let now = std::time::Instant::now();
        if let Ok(mut issued) = self.issued.lock() {
            issued.retain(|(_, _, until)| *until > now);
            if issued.len() >= CANDIDATE_TOKENS_MAX {
                issued.remove(0);
            }
            issued.push((token.clone(), path.to_path_buf(), now + ttl));
        }
        token
    }

    /// A proof already issued for `path` that is still live, left in place
    /// (not consumed), so a listing repeated often reuses it rather than
    /// issuing another that pushes a scan's proofs out.
    pub fn live(&self, path: &Path) -> Option<String> {
        let issued = self.issued.lock().ok()?;
        let now = std::time::Instant::now();
        issued
            .iter()
            .rev()
            .find(|(_, p, until)| p == path && *until > now)
            .map(|(t, _, _)| t.clone())
    }

    /// The folder a proof was issued for, once: a used or expired one is gone.
    pub fn take(&self, token: &str) -> Option<PathBuf> {
        let mut issued = self.issued.lock().ok()?;
        let i = issued.iter().position(|(t, _, _)| t == token)?;
        let (_, path, until) = issued.remove(i);
        (until > std::time::Instant::now()).then_some(path)
    }
}

/// This app's proofs.
pub fn candidate_tokens() -> &'static CandidateTokens {
    static TOKENS: std::sync::OnceLock<CandidateTokens> = std::sync::OnceLock::new();
    TOKENS.get_or_init(CandidateTokens::default)
}

/// Whether the node itself would share `path`, whoever asks: an existing
/// folder, never the home folder or above it, nothing hidden, not `~/Library`
/// nor a system folder, and inside a search root or one of the recent folders
/// (outside the home folder: only inside a search root).
pub fn share_path_ok(
    dir: &Path,
    home: &Path,
    server: &str,
    path: &Path,
) -> Result<PathBuf, &'static str> {
    let path = validate_shared_root(&path.to_string_lossy(), home)?;
    let real = fs::canonicalize(&path).map_err(|_| SHARED_ROOT_MISSING)?;
    let real_home = fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    if hidden_or_system(&real, &real_home) {
        return Err(SHARE_OUTSIDE);
    }
    // Inside a search root where it is, or the way the person reaches it: a
    // link inside a search root (`~/Documents` on another disk) is followed
    // by the lookup, and what it found there is shared by that path.
    let in_root = search_roots_at(dir, home).iter().any(|r| {
        let listed = expand_home(r, home);
        let inside = |root: &Path, p: &Path| p.starts_with(root) && p != root;
        fs::canonicalize(&listed).is_ok_and(|r| inside(&r, &real))
            || (inside(&listed, &path) && !hidden_or_system(&path, home))
    });
    let recent = real.starts_with(&real_home)
        && all_recent_folders_at(dir, server)
            .iter()
            .any(|r| root_key(r) == real);
    if in_root || recent {
        Ok(path)
    } else {
        Err(SHARE_OUTSIDE)
    }
}

/// A share from the cloud: a proof this node issued (consumed), or the path
/// of one of its recent folders; checked again here, then added.
pub fn share_at(
    dir: &Path,
    home: &Path,
    server: &str,
    tokens: &CandidateTokens,
    token: Option<&str>,
    recent_path: Option<&str>,
) -> Result<PathBuf, &'static str> {
    let path = match (token, recent_path) {
        (Some(t), _) => tokens.take(t).ok_or(SHARE_NOT_ISSUED)?,
        (None, Some(p)) => {
            let real = fs::canonicalize(p.trim()).map_err(|_| SHARE_NOT_ISSUED)?;
            if !all_recent_folders_at(dir, server)
                .iter()
                .any(|r| root_key(r) == real)
            {
                return Err(SHARE_NOT_ISSUED);
            }
            PathBuf::from(p.trim())
        }
        (None, None) => return Err(SHARE_NOT_ISSUED),
    };
    let path = share_path_ok(dir, home, server, &path)?;
    let _writer = folders_lock();
    let mut roots = shared_roots_at(dir, server).roots;
    let s = path.to_string_lossy().into_owned();
    if !roots.iter().any(|r| root_key(r) == root_key(&s)) {
        roots.push(s);
    }
    set_shared_roots_at(dir, home, server, Some(roots))?;
    Ok(path)
}

/// Shares a folder this node found (a proof from its lookup) or a recent one.
#[tauri::command]
pub fn node_folder_share<R: Runtime>(
    app: AppHandle<R>,
    token: Option<String>,
    path: Option<String>,
) -> Result<SharedRoots, String> {
    let dir = app_config_dir(&app).ok_or("no application config directory")?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let server = resolve_base_url(&app).unwrap_or_default();
    share_at(
        &dir,
        &home,
        &server,
        candidate_tokens(),
        token.as_deref(),
        path.as_deref(),
    )
    .map_err(str::to_string)?;
    Ok(shared_roots_at(&dir, &server))
}

/// Spotlight's folders named `query` inside `roots` (macOS); none elsewhere
/// or on failure.
fn spotlight_folders(query: &str, roots: &[PathBuf]) -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        if !lookup_query_ok(query) || roots.is_empty() {
            return Vec::new();
        }
        let mut command = std::process::Command::new("/usr/bin/mdfind");
        for root in roots {
            command.arg("-onlyin").arg(root);
        }
        command.arg(format!(
            "kMDItemFSName == \"{}\"c && kMDItemContentType == \"public.folder\"",
            query.trim().replace('*', "\\*")
        ));
        let Ok(mut child) = command
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
        else {
            return Vec::new();
        };
        // A stuck index never holds the lookup: 3 s, then the walk alone answers.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(50))
                }
                _ => {
                    let _ = child.kill();
                    return Vec::new();
                }
            }
        }
        let Ok(output) = child.wait_with_output() else {
            return Vec::new();
        };
        return String::from_utf8_lossy(&output.stdout)
            .lines()
            .take(200)
            .map(str::to_string)
            .collect();
    }
    #[allow(unreachable_code)]
    {
        let _ = (query, roots);
        Vec::new()
    }
}

/// The owner's lookup of a folder by name inside the search roots.
#[tauri::command]
pub async fn node_folder_lookup<R: Runtime>(
    app: AppHandle<R>,
    query: String,
) -> Result<LookupAnswer, String> {
    let dir = app_config_dir(&app).ok_or("no application config directory")?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let server = resolve_base_url(&app).unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        lookup_folders_at(
            &dir,
            &server,
            &home,
            &query,
            &spotlight_folders,
            candidate_tokens(),
        )
    })
    .await
    .map_err(|e| e.to_string())
}

/// The search roots, how each reads (`~/Documents`), and the ones missing on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRoots {
    pub roots: Vec<String>,
    pub display: Vec<String>,
    pub missing: Vec<String>,
    /// The places the OS does not let Liaison read yet (`~/Documents`).
    pub denied: Vec<String>,
}

fn search_roots_view(dir: &Path, home: &Path) -> SearchRoots {
    let roots = search_roots_at(dir, home);
    let real_home = fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    let display = roots
        .iter()
        .map(|r| display_path(Path::new(r.trim()), home, &real_home))
        .collect();
    let missing = roots
        .iter()
        .filter(|r| !Path::new(r.trim()).is_dir() && !access_denied(Path::new(r.trim())))
        .cloned()
        .collect();
    SearchRoots {
        // The implicit default never reads a protected folder, so it reports none.
        denied: if search_roots_are_default(dir) {
            Vec::new()
        } else {
            denied_places(&roots, home, &real_home)
        },
        roots,
        display,
        missing,
    }
}

/// The places Liaison may search that the OS does not let it read yet: a
/// search root, or (for the home folder) the protected folders in it. Shown
/// as `~/…`, so the owner knows which one to allow.
fn denied_places(roots: &[String], home: &Path, real_home: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut note = |p: &Path| {
        let shown = display_path(p, home, real_home);
        if !out.contains(&shown) {
            out.push(shown);
        }
    };
    for raw in roots {
        let root = expand_home(raw, home);
        if access_denied(&root) {
            note(&root);
            continue;
        }
        if fs::canonicalize(&root).is_ok_and(|real| real == real_home) {
            for name in ["Desktop", "Documents", "Downloads"] {
                let p = root.join(name);
                if access_denied(&p) {
                    note(&p);
                }
            }
        }
    }
    out
}

/// The folders Liaison may search in on this computer.
#[tauri::command]
pub fn node_search_roots<R: Runtime>(app: AppHandle<R>) -> Result<SearchRoots, String> {
    let dir = app_config_dir(&app).ok_or("no application config directory")?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(search_roots_view(&dir, &home))
}

/// Sets the search roots; a refused new root answers its rule and changes nothing.
#[tauri::command]
pub fn set_node_search_roots<R: Runtime>(
    app: AppHandle<R>,
    roots: Vec<String>,
) -> Result<SearchRoots, String> {
    let dir = app_config_dir(&app).ok_or("no application config directory")?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let _writer = folders_lock();
    set_search_roots_at(&dir, &home, roots).map_err(str::to_string)?;
    Ok(search_roots_view(&dir, &home))
}

/// Adds one search root (the cloud's request), under the writers' lock.
pub fn add_search_root_at(dir: &Path, home: &Path, path: &str) -> Result<(), &'static str> {
    let _writer = folders_lock();
    let mut roots = search_roots_at(dir, home);
    roots.push(path.to_string());
    set_search_roots_at(dir, home, roots)
}

/// The OS settings page where the owner lets Liaison read protected folders
/// (`~/Documents` and the like): a fixed address per OS, never a path.
pub fn privacy_settings_url(os: &str) -> Option<&'static str> {
    match os {
        "macos" => {
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders")
        }
        "windows" => Some("ms-settings:windowsdefender"),
        _ => None,
    }
}

/// Opens that page ("Open System Settings"). False on an OS that has none.
#[tauri::command]
pub fn open_privacy_settings() -> Result<bool, String> {
    let Some(url) = privacy_settings_url(std::env::consts::OS) else {
        return Ok(false);
    };
    tauri_plugin_opener::open_url(url, None::<&str>)
        .map(|_| true)
        .map_err(|e| e.to_string())
}

// ─── Open in VS Code (S52, owner D13) ─────────────────────────────────────

/// What a path keeps unescaped in an editor link: letters, digits, the
/// separator and the few marks a file path carries; everything else (a space,
/// `#`, `?`, `%`) is percent-encoded so the link names the folder exactly.
const EDITOR_PATH: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'/')
    .remove(b':')
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

/// The `vscode://file/<abs path>` link of the ONE shared folder named `name`,
/// from the shell's own folder map. The page names a folder, never a path: an
/// unknown name, a name two shared folders carry, or a relative path opens
/// nothing.
pub fn editor_url_for(folders: &[SharedFolder], name: &str) -> Option<String> {
    if name.is_empty() {
        return None;
    }
    let mut named = folders.iter().filter(|f| f.name == name);
    let folder = named.next()?;
    if named.next().is_some() {
        return None;
    }
    let path = folder.path.replace('\\', "/");
    let bytes = path.as_bytes();
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] == b'/';
    if !path.starts_with('/') && !drive {
        return None;
    }
    let encoded = percent_encoding::utf8_percent_encode(&path, EDITOR_PATH).to_string();
    Some(if drive {
        format!("vscode://file/{encoded}")
    } else {
        format!("vscode://file{encoded}")
    })
}

/// The link of a folder BELOW the one shared folder named `name`: the shell
/// resolves the root from its own map, joins `relative`, and opens it only
/// when the real path (links resolved) is a directory inside that root. An
/// absolute `relative`, a `.` or `..` part, a missing folder or a link out of
/// the root opens nothing. An empty `relative` is the root itself.
pub fn editor_url_within(folders: &[SharedFolder], name: &str, relative: &str) -> Option<String> {
    if relative.is_empty() {
        return editor_url_for(folders, name);
    }
    // The root must be one this node shares, by the same rule as the root itself.
    editor_url_for(folders, name)?;
    let root = PathBuf::from(&folders.iter().find(|f| f.name == name)?.path);
    let rel = Path::new(relative);
    if relative.contains('\\')
        || !rel
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
        || relative.split('/').any(|part| part == "." || part == "..")
    {
        return None;
    }
    let real_root = fs::canonicalize(&root).ok()?;
    let real = fs::canonicalize(root.join(rel)).ok()?;
    if !real.starts_with(&real_root) || !real.is_dir() {
        return None;
    }
    let shown = SharedFolder {
        name: name.to_string(),
        // Windows canonical paths carry the verbatim prefix `\\?\`.
        path: real
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .to_string(),
        kind: "root",
        git_default_branch: None,
    };
    editor_url_for(std::slice::from_ref(&shown), name)
}

/// "Open in VS Code" (S52): opens the shared folder the page names in VS Code,
/// or a folder below it (`relativePath`, a session in a subfolder), confined
/// to that folder. False when this node shares no single folder of that name
/// or the path below it is not inside it.
#[tauri::command]
pub fn open_folder_in_editor<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    relative_path: Option<String>,
) -> Result<bool, String> {
    let relative = relative_path.unwrap_or_default();
    let Some(url) = editor_url_within(&node_shared_folders(app), &name, &relative) else {
        return Ok(false);
    };
    tauri_plugin_opener::open_url(url, None::<&str>)
        .map(|_| true)
        .map_err(|e| e.to_string())
}

/// Removes one search root (the cloud's request), under the writers' lock.
pub fn remove_search_root_at(dir: &Path, home: &Path, path: &str) -> Result<(), &'static str> {
    let _writer = folders_lock();
    let roots = search_roots_at(dir, home)
        .into_iter()
        .filter(|r| r != path.trim())
        .collect();
    set_search_roots_at(dir, home, roots)
}

/// Stops sharing one folder (the cloud's request), under the writers' lock;
/// a folder missing on disk is removed like any other.
pub fn unshare_at(dir: &Path, home: &Path, server: &str, path: &str) -> Result<bool, &'static str> {
    let _writer = folders_lock();
    let roots = shared_roots_at(dir, server).roots;
    let next: Vec<String> = roots
        .iter()
        .filter(|r| r.as_str() != path.trim())
        .cloned()
        .collect();
    if next.len() == roots.len() {
        return Ok(false);
    }
    set_shared_roots_at(dir, home, server, Some(next))?;
    Ok(true)
}

/// Adds a search root from the cloud.
#[tauri::command]
pub fn node_search_root_add<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<SearchRoots, String> {
    let dir = app_config_dir(&app).ok_or("no application config directory")?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    add_search_root_at(&dir, &home, &path).map_err(str::to_string)?;
    Ok(search_roots_view(&dir, &home))
}

/// Removes a search root from the cloud.
#[tauri::command]
pub fn node_search_root_remove<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<SearchRoots, String> {
    let dir = app_config_dir(&app).ok_or("no application config directory")?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    remove_search_root_at(&dir, &home, &path).map_err(str::to_string)?;
    Ok(search_roots_view(&dir, &home))
}

/// Stops sharing a folder from the cloud; answers whether anything changed.
#[tauri::command]
pub fn node_folder_unshare<R: Runtime>(app: AppHandle<R>, path: String) -> Result<bool, String> {
    let dir = app_config_dir(&app).ok_or("no application config directory")?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let server = resolve_base_url(&app).unwrap_or_default();
    unshare_at(&dir, &home, &server, &path).map_err(str::to_string)
}

// ─── Cloning a repository onto this node (owner's gesture, any client) ───
//
// The owner asks from any device; the node clones with its OWN git login (the
// owner's git config and credential helper, their ssh-agent), never a token
// carried by the server, into `<node root>/repos/<name>`, then shares it.

/// A URL that is not https, ssh:// or scp-like `user@host:path`.
pub const CLONE_URL_REFUSED: &str = "CloneUrlRefused";
/// A folder name that is not a plain name.
pub const CLONE_NAME_REFUSED: &str = "CloneNameRefused";
/// Something already sits where the clone would go.
pub const CLONE_TARGET_EXISTS: &str = "CloneTargetExists";
/// The host refused this computer's git login.
pub const CLONE_AUTH_FAILED: &str = "CloneAuthFailed";
/// The host could not be reached.
pub const CLONE_HOST_UNREACHABLE: &str = "CloneHostUnreachable";
/// The host answered that there is no such repository.
pub const CLONE_NOT_FOUND: &str = "CloneNotFound";
/// The folder a clone is made in before it is renamed into place.
pub const CLONE_TEMP_PREFIX: &str = ".clone-";
/// It took longer than `CLONE_TIMEOUT`.
pub const CLONE_TIMEOUT_CODE: &str = "CloneTimeout";
/// Anything else.
pub const CLONE_FAILED: &str = "CloneFailed";

/// A clone gives up after this long (the request it answers lives 10 minutes).
pub const CLONE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8 * 60);

/// A URL this node clones: `https://host/…`, `ssh://…` or scp-like
/// `user@host:path`. Never a local path, `file://`, a transport helper
/// (`ext::`), whitespace, or anything git would read as an option.
pub fn clone_url_ok(url: &str) -> bool {
    let u = url.trim();
    if u.is_empty() || u.len() > 2048 || u.starts_with('-') || u.contains("::") {
        return false;
    }
    if u.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    // A user may name an account (`git@`, a token user), never carry a
    // password (`user:secret@`) or read as an option (`-o…@`).
    let user_ok = |user: &str| !user.is_empty() && !user.starts_with('-') && !user.contains(':');
    for scheme in ["https://", "ssh://"] {
        if let Some(rest) = u.strip_prefix(scheme) {
            let authority = rest.split('/').next().unwrap_or("");
            let path = &rest[authority.len()..];
            let host_port = match authority.rsplit_once('@') {
                Some((user, host)) if user_ok(user) => host,
                Some(_) => return false,
                None => authority,
            };
            let host = if let Some(v6) = host_port.strip_prefix('[') {
                match v6.split_once(']') {
                    Some((h, _)) => h,
                    None => return false,
                }
            } else {
                host_port.split(':').next().unwrap_or("")
            };
            return clone_host_ok(host) && path.len() > 1;
        }
    }
    // scp-like: user@host:path (no scheme, a user, a host, then a path).
    if let Some((user_host, path)) = u.split_once(':') {
        if let Some((user, host)) = user_host.split_once('@') {
            return user_ok(user)
                && user
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
                && clone_host_ok(host)
                && !path.is_empty()
                && !path.starts_with('-')
                && !path.starts_with('/');
        }
    }
    false
}

/// A host a node may clone from: a name or a public address. Never
/// `localhost`, a loopback, link-local, private-network or unspecified
/// address, nor a number that is an address in disguise (`2130706433`).
pub fn clone_host_ok(host: &str) -> bool {
    use std::net::{IpAddr, Ipv4Addr};
    let h = host.trim();
    if h.is_empty()
        || h.starts_with('-')
        || !h
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
    {
        return false;
    }
    let lower = h.to_ascii_lowercase();
    if lower == "localhost" || lower.ends_with(".localhost") {
        return false;
    }
    let v4_private = |ip: Ipv4Addr| {
        ip.is_loopback()
            || ip.is_private()
            || ip.is_link_local()
            || ip.is_unspecified()
            || ip.is_broadcast()
            || ip.octets()[0] == 0
            || (ip.octets()[0] == 100 && (ip.octets()[1] & 0xc0) == 64)
    };
    if let Ok(ip) = lower.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => !v4_private(v4),
            IpAddr::V6(v6) => {
                let first = v6.segments()[0];
                !(v6.is_loopback()
                    || v6.is_unspecified()
                    || (first & 0xfe00) == 0xfc00
                    || (first & 0xffc0) == 0xfe80
                    || v6.to_ipv4_mapped().is_some_and(v4_private))
            }
        };
    }
    // Digits, dots and hex only, yet not an address: an address in disguise.
    let disguised = lower
        .split('.')
        .all(|part| part.chars().all(|c| c.is_ascii_hexdigit() || c == 'x'))
        && lower.chars().any(|c| c.is_ascii_digit());
    !disguised && !lower.contains(':')
}

/// The folder a URL clones into by default: its last path segment, `.git` off.
pub fn clone_name_from_url(url: &str) -> Option<String> {
    let u = url.trim().trim_end_matches('/');
    let last = u.rsplit(['/', ':']).next()?;
    let name = last.strip_suffix(".git").unwrap_or(last);
    clone_name_ok(name).then(|| name.to_string())
}

/// A folder name: a lookup query that is not hidden and not an option.
pub fn clone_name_ok(name: &str) -> bool {
    lookup_query_ok(name) && !name.starts_with('.') && !name.starts_with('-') && name.trim() == name
}

/// What git said, as one of the refusal codes.
pub fn clone_error_code(stderr: &str) -> &'static str {
    let e = stderr.to_lowercase();
    if e.contains("authentication failed")
        || e.contains("permission denied")
        || e.contains("could not read username")
        || e.contains("could not read password")
        || e.contains("terminal prompts disabled")
        || e.contains("access denied")
        || e.contains("http basic: access denied")
        || e.contains("403")
    {
        CLONE_AUTH_FAILED
    } else if e.contains("repository not found")
        || e.contains("not found")
        || e.contains("does not appear to be a git repository")
        || e.contains("does not exist")
    {
        CLONE_NOT_FOUND
    } else if e.contains("could not resolve host")
        || e.contains("could not resolve hostname")
        || e.contains("connection refused")
        || e.contains("connection timed out")
        || e.contains("operation timed out")
        || e.contains("network is unreachable")
        || e.contains("failed to connect")
        || e.contains("no route to host")
    {
        CLONE_HOST_UNREACHABLE
    } else {
        CLONE_FAILED
    }
}

/// How a clone runs git: `(args, cwd)` -> Ok, or Err(the code, from stderr).
pub type GitRunner<'a> = &'a dyn Fn(&[String], &Path) -> Result<(), &'static str>;

/// Clones `url` into `<node root>/repos/<name>` and shares it. Checks the URL
/// and the name first; a target that exists is refused (never overwritten);
/// a failed clone leaves nothing behind. Answers the folder it made.
pub fn clone_repo_at(
    dir: &Path,
    home: &Path,
    server: &str,
    url: &str,
    name: Option<&str>,
    git: GitRunner<'_>,
) -> Result<PathBuf, &'static str> {
    let url = url.trim();
    if !clone_url_ok(url) {
        return Err(CLONE_URL_REFUSED);
    }
    let name = match name.map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) if clone_name_ok(n) => n.to_string(),
        Some(_) => return Err(CLONE_NAME_REFUSED),
        None => clone_name_from_url(url).ok_or(CLONE_NAME_REFUSED)?,
    };
    let (root, _) = crate::node_job::node_root_at(dir, home);
    let repos = root.join("repos");
    let target = repos.join(&name);
    if fs::symlink_metadata(&target).is_ok() {
        return Err(CLONE_TARGET_EXISTS);
    }
    fs::create_dir_all(&repos).map_err(|_| CLONE_FAILED)?;
    // Cloned into a fresh folder of its own, then renamed into place: a
    // failure only ever deletes what this run made (M2), and a crash leaves a
    // `.clone-*` folder that the next start removes.
    let mut bytes = [0u8; 8];
    let _ = getrandom::fill(&mut bytes);
    let temp = repos.join(format!(
        "{CLONE_TEMP_PREFIX}{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ));
    let args: Vec<String> = vec![
        "-c".into(),
        "protocol.file.allow=never".into(),
        "-c".into(),
        "protocol.ext.allow=never".into(),
        "clone".into(),
        "--no-recurse-submodules".into(),
        "--".into(),
        url.to_string(),
        temp.to_string_lossy().into_owned(),
    ];
    if let Err(code) = git(&args, &repos) {
        let _ = fs::remove_dir_all(&temp);
        return Err(code);
    }
    if !has_git(&temp) {
        let _ = fs::remove_dir_all(&temp);
        return Err(CLONE_FAILED);
    }
    let _writer = folders_lock();
    // Someone made that folder while this cloned: theirs stays, ours goes.
    if fs::symlink_metadata(&target).is_ok() {
        let _ = fs::remove_dir_all(&temp);
        return Err(CLONE_TARGET_EXISTS);
    }
    if fs::rename(&temp, &target).is_err() {
        let _ = fs::remove_dir_all(&temp);
        return Err(CLONE_FAILED);
    }
    let mut roots = shared_roots_at(dir, server).roots;
    let target_s = target.to_string_lossy().into_owned();
    if !roots.contains(&target_s) {
        roots.push(target_s);
    }
    set_shared_roots_at(dir, home, server, Some(roots))?;
    Ok(target)
}

/// The git this computer has, as a GUI app sees it (Homebrew's, else the system's).
fn git_binary() -> PathBuf {
    for p in [
        "/opt/homebrew/bin/git",
        "/usr/local/bin/git",
        "/usr/bin/git",
    ] {
        if Path::new(p).is_file() {
            return PathBuf::from(p);
        }
    }
    PathBuf::from("git")
}

/// A clone grew past the node's size limit (`cloneMaxBytes`, 2 GB by default).
pub const CLONE_TOO_LARGE: &str = "CloneTooLarge";
/// The default size limit of one clone.
pub const CLONE_MAX_BYTES_DEFAULT: u64 = 2 * 1024 * 1024 * 1024;

/// The node's size limit for one clone (`cloneMaxBytes` in its settings).
pub fn clone_max_bytes(dir: &Path) -> u64 {
    fs::read(dir.join(NODE_SETTINGS_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v.get("cloneMaxBytes").and_then(|n| n.as_u64()))
        .filter(|n| *n > 0)
        .unwrap_or(CLONE_MAX_BYTES_DEFAULT)
}

/// The bytes under `path`, never through a link, stopping once past `stop`.
fn dir_size(path: &Path, stop: u64) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let Ok(meta) = entry.path().symlink_metadata() else {
                continue;
            };
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total += meta.len();
                if total > stop {
                    return total;
                }
            }
        }
    }
    total
}

/// Removes the `.clone-*` folders a crashed clone left in the repos folder
/// (only those: they are this node's own, never a repository). Run at start.
pub fn clean_stale_clones_at(dir: &Path, home: &Path) -> usize {
    let (root, _) = crate::node_job::node_root_at(dir, home);
    let Ok(entries) = fs::read_dir(root.join("repos")) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with(CLONE_TEMP_PREFIX)
        })
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|e| fs::remove_dir_all(e.path()).is_ok())
        .count()
}

/// Runs a clone, stopped when it outlives `timeout` or `watched` grows past
/// `max_bytes` (checked every second); a refusal maps git's words to a code.
pub fn run_guarded(
    mut command: std::process::Command,
    watched: &Path,
    max_bytes: u64,
    timeout: std::time::Duration,
) -> Result<(), &'static str> {
    use std::io::Read;
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    let mut child = command.spawn().map_err(|_| CLONE_FAILED)?;
    let mut stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(s) = stderr.as_mut() {
            let _ = s.take(64 * 1024).read_to_string(&mut text);
        }
        text
    });
    let started = std::time::Instant::now();
    let mut last_measure = started;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                let now = std::time::Instant::now();
                if now.duration_since(started) >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(CLONE_TIMEOUT_CODE);
                }
                if now.duration_since(last_measure) >= std::time::Duration::from_millis(500) {
                    last_measure = now;
                    if dir_size(watched, max_bytes) > max_bytes {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(CLONE_TOO_LARGE);
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(_) => {
                let _ = child.kill();
                return Err(CLONE_FAILED);
            }
        }
    };
    let text = reader.join().unwrap_or_default();
    if status.success() {
        Ok(())
    } else {
        Err(clone_error_code(&text))
    }
}

/// Runs git as the owner (their git config, credential helper and ssh-agent),
/// never prompting: a login it lacks fails, in words, instead of hanging.
/// The folder it clones into is the last argument, watched for its size.
fn run_owner_git(args: &[String], cwd: &Path, max_bytes: u64) -> Result<(), &'static str> {
    let mut command = std::process::Command::new(git_binary());
    command
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never");
    if std::env::var_os("GIT_SSH_COMMAND").is_none() {
        command.env(
            "GIT_SSH_COMMAND",
            "ssh -o BatchMode=yes -o ConnectTimeout=20",
        );
    }
    let watched = PathBuf::from(args.last().map(String::as_str).unwrap_or(""));
    run_guarded(command, &watched, max_bytes, CLONE_TIMEOUT)
}

/// Clones a repository onto this node and shares it (owner's gesture).
#[tauri::command]
pub async fn node_folder_clone<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    name: Option<String>,
) -> Result<SharedRoots, String> {
    let dir = app_config_dir(&app).ok_or("no application config directory")?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let server = resolve_base_url(&app).unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let max = clone_max_bytes(&dir);
        let git = |args: &[String], cwd: &Path| run_owner_git(args, cwd, max);
        clone_repo_at(&dir, &home, &server, &url, name.as_deref(), &git)
            .map(|_| shared_roots_at(&dir, &server))
            .map_err(str::to_string)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ─── Finding every repository, sharing several, the signed-in tools' repos ──
//
// A scan walks the search roots for git repositories (the lookup's walk and
// rules, deeper and longer). `shareMany` shares several folders a scan found,
// in one write. `remotes` asks the computer's signed-in `gh` and `glab` which
// repositories their account can reach, with a fixed command line and nothing
// taken from the request, and marks those already on this disk (by `origin`,
// read from `.git/config` as text: git never runs in a repository). The
// server only ever gets tokens for what it may share (S17).

/// How deep a scan walks under each search root.
pub const SCAN_DEPTH: usize = 6;
/// How many folders one scan reads at most.
pub const SCAN_VISIT_BUDGET: usize = 100_000;
/// How long one scan walks, all search roots together.
pub const SCAN_TIME: std::time::Duration = std::time::Duration::from_secs(8);
/// No scan answers more than this many repositories.
pub const SCAN_LIMIT: usize = 500;
/// A `shareMany` that would take the node past `SHARED_FOLDERS_LIMIT`.
pub const SHARED_ROOTS_FULL: &str = "SharedRootsFull";
/// At most this many tokens in one `shareMany`.
pub const SHARE_MANY_MAX: usize = 100;

/// Why a folder the node found cannot be shared as it is (A8).
pub const REFUSAL_HOME: &str = "home";
pub const REFUSAL_HIDDEN: &str = "hidden";
pub const REFUSAL_OUTSIDE: &str = "outside_search";

/// Whether the node would share a folder, in the words the owner reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Shareability {
    /// `share_path_ok` accepts it (the path it would share).
    Ok(PathBuf),
    /// It exists, and is refused for this reason (`REFUSAL_*`).
    Refused(&'static str),
    /// It is gone from the disk.
    Missing,
}

/// `share_path_ok`, read as a reason (A8): the home folder; hidden or system;
/// anything else outside the search roots. Changes nothing about what is
/// shareable.
pub fn shareability(dir: &Path, home: &Path, server: &str, path: &Path) -> Shareability {
    match share_path_ok(dir, home, server, path) {
        Ok(p) => Shareability::Ok(p),
        Err(SHARED_ROOT_MISSING) => Shareability::Missing,
        Err(SHARED_ROOT_HOME) => Shareability::Refused(REFUSAL_HOME),
        Err(_) => {
            let real_home = fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
            let hidden = fs::canonicalize(path).is_ok_and(|r| hidden_or_system(&r, &real_home));
            Shareability::Refused(if hidden { REFUSAL_HIDDEN } else { REFUSAL_OUTSIDE })
        }
    }
}

/// How a folder reads when it is not a scan's (A13): `~/…` inside the home
/// folder, else its own name. Never an absolute path.
pub fn short_display(path: &Path, home: &Path, real_home: &Path) -> String {
    if [home, real_home].iter().any(|h| path.starts_with(h)) {
        clean_name(&display_path(path, home, real_home))
    } else {
        basename(path)
    }
}

/// The real paths of every folder this node advertises (the chosen roots and
/// their repositories), as a scan compares them.
fn advertised_reals(dir: &Path, home: &Path, server: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = shared_folders_for(dir, home, server)
        .iter()
        .map(|f| root_key(&f.path))
        .collect();
    for r in shared_roots_at(dir, server).roots {
        let key = root_key(&r);
        if !out.contains(&key) {
            out.push(key);
        }
    }
    out
}

/// A folder holding sessions that is not shared, as the import listing shows
/// it (S13): a name, how it reads, and the node's token to share it or the
/// reason it cannot be. Never its path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsharedGroup {
    pub name: String,
    pub display: String,
    pub token: Option<String>,
    pub refusal: Option<&'static str>,
}

/// What the shell makes of one folder the sidecar grouped sessions under:
/// None when it is not shown (counted as skipped): not an absolute path, the
/// node's own scratch or worktree folders (A12), a protected home folder no
/// search root covers (A4, decided before anything is read there), or gone
/// from the disk (A8). A shareable group carries a live proof already issued
/// for it, else a new one only when `issue` (a listing without a folder or a
/// search), else none.
pub fn unshared_group_at(
    dir: &Path,
    home: &Path,
    server: &str,
    path: &Path,
    tokens: &CandidateTokens,
    issue: bool,
) -> Option<UnsharedGroup> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return None;
    }
    let (node_root, _) = crate::node_job::node_root_at(dir, home);
    if path.starts_with(&node_root) && !path.starts_with(node_root.join("repos")) {
        return None;
    }
    let real_home = fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    if node_scratch(path, &real_home) || node_scratch(path, home) {
        return None;
    }
    if in_protected_home(path, home, &real_home) {
        let explicit = !search_roots_are_default(dir);
        let covered = search_roots_at(dir, home).iter().any(|raw| {
            let root = expand_home(raw, home);
            path.starts_with(&root)
                && (in_protected_home(&root, home, &real_home)
                    || (explicit && (root == home || root == real_home)))
        });
        if !covered {
            return None;
        }
    }
    let (token, refusal) = match shareability(dir, home, server, path) {
        Shareability::Ok(p) => (
            tokens
                .live(&p)
                .or_else(|| issue.then(|| tokens.issue(&p))),
            None,
        ),
        Shareability::Refused(why) => (None, Some(why)),
        Shareability::Missing => return None,
    };
    let name = basename(path);
    Some(UnsharedGroup {
        name: if name.is_empty() { "/".into() } else { name },
        display: short_display(path, home, &real_home),
        token,
        refusal,
    })
}

/// One repository a scan found. A token only for one it may share and does
/// not yet (A3); `refusal` says why one cannot be shared (A16).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanCandidate {
    pub name: String,
    pub path: String,
    pub token: Option<String>,
    pub display: String,
    pub shared: bool,
    pub shareable: bool,
    pub refusal: Option<&'static str>,
}

/// A scan's answer (the lookup's shape, `parseNodeFolderScan`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanAnswer {
    pub search_roots: usize,
    pub candidates: Vec<ScanCandidate>,
    /// Stopped on its time or folder budget, or more than `SCAN_LIMIT` found.
    pub partial: bool,
    pub denied: Vec<String>,
    pub skipped_protected: bool,
}

/// A repository a scan found, before any token is issued.
#[derive(Debug, Clone)]
struct ScanRow {
    real: PathBuf,
    path: PathBuf,
    display: String,
    shared: bool,
    /// None: it may be shared as it is.
    refusal: Option<&'static str>,
}

struct Scanned {
    search_roots: usize,
    rows: Vec<ScanRow>,
    partial: bool,
    denied: Vec<String>,
    skipped_protected: bool,
}

/// Every git repository inside the search roots: the lookup's walk and rules
/// (skip lists, protected home folders, links, devices, hidden), at most
/// `SCAN_DEPTH` down, never inside a repository it found.
fn scan_rows(
    dir: &Path,
    server: &str,
    home: &Path,
    time: std::time::Duration,
    mut budget: usize,
) -> Scanned {
    let deadline = std::time::Instant::now() + time;
    let real_home = fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    let (listed, roots, mut denied) = resolve_search_roots(dir, home, &real_home);
    let skip_protected = search_roots_are_default(dir);
    if roots.is_empty() {
        return Scanned {
            search_roots: listed.len(),
            rows: Vec::new(),
            partial: false,
            denied,
            skipped_protected: skip_protected && !roots.is_empty(),
        };
    }
    let walk = walk_roots(
        &roots,
        &real_home,
        &|p: &Path| has_git(p).then_some(0),
        SCAN_DEPTH,
        &mut budget,
        deadline,
        skip_protected,
    );
    for d in &walk.denied {
        let shown = display_path(d, home, &real_home);
        if !denied.contains(&shown) {
            denied.push(shown);
        }
    }
    let advertised = advertised_reals(dir, home, server);
    let mut placed: Vec<Placed> = walk
        .found
        .iter()
        .filter_map(|(_, depth, path)| {
            place_found(path, *depth, SCAN_DEPTH, &walk.roots, &roots, &real_home)
        })
        .collect();
    placed.sort_by(|a, b| a.shown.cmp(&b.shown));
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut rows: Vec<ScanRow> = Vec::new();
    let mut partial = !walk.complete;
    for p in placed {
        if seen.contains(&p.real) {
            continue;
        }
        if rows.len() >= SCAN_LIMIT {
            partial = true;
            break;
        }
        seen.push(p.real.clone());
        let shared = advertised.contains(&p.real);
        let refusal = match shareability(dir, home, server, &p.shown) {
            Shareability::Ok(_) => None,
            Shareability::Refused(why) => Some(why),
            Shareability::Missing => continue,
        };
        rows.push(ScanRow {
            display: candidate_display(&p.shown, &p.search_root, home, &real_home),
            real: p.real,
            path: p.shown,
            shared,
            refusal,
        });
    }
    Scanned {
        search_roots: listed.len(),
        rows,
        partial,
        denied,
        skipped_protected: skip_protected,
    }
}

/// The scan the owner asks for (S1): tokens only for the rows it may share.
pub fn scan_repos_within(
    dir: &Path,
    server: &str,
    home: &Path,
    tokens: &CandidateTokens,
    time: std::time::Duration,
    budget: usize,
) -> ScanAnswer {
    let scanned = scan_rows(dir, server, home, time, budget);
    ScanAnswer {
        search_roots: scanned.search_roots,
        partial: scanned.partial,
        denied: scanned.denied,
        skipped_protected: scanned.skipped_protected,
        candidates: scanned
            .rows
            .into_iter()
            .map(|r| {
                let shareable = !r.shared && r.refusal.is_none();
                ScanCandidate {
                    name: basename(&r.path),
                    token: shareable.then(|| tokens.issue(&r.path)),
                    path: r.path.to_string_lossy().into_owned(),
                    display: r.display,
                    shared: r.shared,
                    shareable,
                    refusal: if r.shared { None } else { r.refusal },
                }
            })
            .collect(),
    }
}

/// `scan_repos_within` with the scan's own budget.
pub fn scan_repos_at(dir: &Path, server: &str, home: &Path, tokens: &CandidateTokens) -> ScanAnswer {
    scan_repos_within(dir, server, home, tokens, SCAN_TIME, SCAN_VISIT_BUDGET)
}

/// Every git repository in the search roots (S1).
#[tauri::command]
pub async fn node_folder_scan<R: Runtime>(app: AppHandle<R>) -> Result<ScanAnswer, String> {
    let dir = app_config_dir(&app).ok_or("no application config directory")?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let server = resolve_base_url(&app).unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        scan_repos_at(&dir, &server, &home, candidate_tokens())
    })
    .await
    .map_err(|e| e.to_string())
}

/// A token `shareMany` did not share, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareRefused {
    pub token: String,
    pub code: &'static str,
}

/// A `shareMany` answer: the shared roots afterwards, and the tokens refused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareManyAnswer {
    #[serde(flatten)]
    pub roots: SharedRoots,
    pub refused: Vec<ShareRefused>,
}

fn token_shaped(t: &str) -> bool {
    t.len() == 32 && t.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Shares several folders a scan found (S2, A15): the folder limit is checked
/// before any token is used; then each token is used once and its folder
/// checked again, and every accepted one is written in ONE change under the
/// writers' lock. A refused token is named with its code; the others are
/// shared all the same.
pub fn share_many_at(
    dir: &Path,
    home: &Path,
    server: &str,
    tokens: &CandidateTokens,
    asked: &[String],
) -> Result<ShareManyAnswer, &'static str> {
    if asked.is_empty() || asked.len() > SHARE_MANY_MAX {
        return Err(SHARE_NOT_ISSUED);
    }
    let mut unique: Vec<&str> = Vec::new();
    for t in asked {
        if !unique.contains(&t.as_str()) {
            unique.push(t.as_str());
        }
    }
    let _writer = folders_lock();
    if shared_folders_for(dir, home, server).len() + unique.len() > SHARED_FOLDERS_LIMIT {
        return Err(SHARED_ROOTS_FULL);
    }
    let mut roots = shared_roots_at(dir, server).roots;
    let mut refused: Vec<ShareRefused> = Vec::new();
    let mut added = false;
    for t in unique {
        let taken = if token_shaped(t) { tokens.take(t) } else { None };
        let Some(path) = taken else {
            refused.push(ShareRefused {
                token: t.to_string(),
                code: SHARE_NOT_ISSUED,
            });
            continue;
        };
        match share_path_ok(dir, home, server, &path) {
            Ok(p) => {
                let s = p.to_string_lossy().into_owned();
                if !roots.iter().any(|r| root_key(r) == root_key(&s)) {
                    roots.push(s);
                    added = true;
                }
            }
            Err(code) => refused.push(ShareRefused {
                token: t.to_string(),
                code,
            }),
        }
    }
    if added {
        set_shared_roots_at(dir, home, server, Some(roots))?;
    }
    Ok(ShareManyAnswer {
        roots: shared_roots_at(dir, server),
        refused,
    })
}

/// Shares several folders a scan found, in one change (S2).
#[tauri::command]
pub fn node_folder_share_many<R: Runtime>(
    app: AppHandle<R>,
    tokens: Vec<String>,
) -> Result<ShareManyAnswer, String> {
    let dir = app_config_dir(&app).ok_or("no application config directory")?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let server = resolve_base_url(&app).unwrap_or_default();
    share_many_at(&dir, &home, &server, candidate_tokens(), &tokens).map_err(str::to_string)
}

// The remote repositories (S3-S5, S17).

/// The whole `remotes` call ends within this, whatever the tools do (A6).
pub const REMOTES_TIME: std::time::Duration = std::time::Duration::from_secs(35);
/// One tool call ends within this.
pub const TOOL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// One tool call's output is read up to this.
pub const TOOL_OUTPUT_MAX: usize = 8 * 1024 * 1024;
/// At most this many pages of 100 per tool.
pub const REMOTE_PAGES: usize = 5;
/// No `remotes` answer lists more than this many repositories.
pub const REMOTES_LIMIT: usize = 1000;
/// A `.git/config` read for its origin is at most this large.
pub const GIT_CONFIG_MAX: u64 = 64 * 1024;
/// The environment every tool call runs with: never a prompt, an update
/// notice or colour codes.
pub const TOOL_ENV: [(&str, &str); 5] = [
    ("GH_PROMPT_DISABLED", "1"),
    ("GH_NO_UPDATE_NOTIFIER", "1"),
    ("NO_COLOR", "1"),
    ("GLAB_NO_PROMPT", "1"),
    ("GLAB_CHECK_UPDATE", "false"),
];
/// Where a GUI app finds the tools before its own PATH.
const TOOL_DIRS: [&str; 3] = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

/// How one tool call ended. Its stderr is never read: it stays on the node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolRun {
    /// Exit 0, with its stdout.
    Ok(Vec<u8>),
    /// A non-zero exit.
    Exit,
    Timeout,
    TooLarge,
    /// It could not start.
    Spawn,
}

/// How `remotes` finds and runs `gh` and `glab` (a fake in the tests).
pub trait ToolRunner {
    /// The tool's executable, or None when the computer has none.
    fn locate(&self, tool: &str) -> Option<PathBuf>;
    /// Runs it with exactly `args`, stopped after `timeout`.
    fn run(&self, program: &Path, args: &[String], timeout: std::time::Duration) -> ToolRun;
}

/// The tool's executable: the usual install folders first (a GUI app's PATH
/// is short), then `~/.local/bin`, then each absolute PATH entry.
pub fn find_tool(tool: &str, home: &Path, path_var: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    let name = if cfg!(windows) {
        format!("{tool}.exe")
    } else {
        tool.to_string()
    };
    let mut dirs: Vec<PathBuf> = TOOL_DIRS.iter().map(PathBuf::from).collect();
    dirs.push(home.join(".local").join("bin"));
    if let Some(var) = path_var {
        // A relative entry (`.`) would run whatever sits in the current folder.
        dirs.extend(std::env::split_paths(var).filter(|d| d.is_absolute()));
    }
    dirs.into_iter().map(|d| d.join(&name)).find(|p| executable(p))
}

fn executable(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

/// Runs a tool outside any sandbox, as the owner: stdin closed, stderr
/// dropped, stdout read up to `TOOL_OUTPUT_MAX`, killed after `timeout`.
pub fn run_tool(
    program: &Path,
    args: &[String],
    cwd: &Path,
    timeout: std::time::Duration,
) -> ToolRun {
    use std::io::Read;
    use std::sync::atomic::{AtomicBool, Ordering};
    let mut command = std::process::Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    for (k, v) in TOOL_ENV {
        command.env(k, v);
    }
    let Ok(mut child) = command.spawn() else {
        return ToolRun::Spawn;
    };
    let over = std::sync::Arc::new(AtomicBool::new(false));
    let mut stdout = child.stdout.take();
    let flag = over.clone();
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(s) = stdout.as_mut() {
            let _ = s.take(TOOL_OUTPUT_MAX as u64 + 1).read_to_end(&mut bytes);
        }
        if bytes.len() > TOOL_OUTPUT_MAX {
            flag.store(true, Ordering::SeqCst);
        }
        bytes
    });
    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if over.load(Ordering::SeqCst) || started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let bytes = reader.join().unwrap_or_default();
    if over.load(Ordering::SeqCst) || bytes.len() > TOOL_OUTPUT_MAX {
        return ToolRun::TooLarge;
    }
    match status {
        Some(s) if s.success() => ToolRun::Ok(bytes),
        Some(_) => ToolRun::Exit,
        None => ToolRun::Timeout,
    }
}

/// The computer's own tools.
pub struct SystemTools {
    pub home: PathBuf,
}

impl ToolRunner for SystemTools {
    fn locate(&self, tool: &str) -> Option<PathBuf> {
        find_tool(tool, &self.home, std::env::var_os("PATH").as_deref())
    }
    /// Run from a fresh empty folder, removed after: a tool that reads the
    /// repository around its working folder (`glab` reads `.git/config`) sees
    /// none, even when the home folder is a repository.
    fn run(&self, program: &Path, args: &[String], timeout: std::time::Duration) -> ToolRun {
        let Some(empty) = empty_tool_dir() else {
            return ToolRun::Spawn;
        };
        let run = run_tool(program, args, &empty, timeout);
        let _ = fs::remove_dir_all(&empty);
        run
    }
}

/// A new empty folder in the OS temp folder for one tool run.
fn empty_tool_dir() -> Option<PathBuf> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).ok()?;
    let name: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let dir = std::env::temp_dir().join(format!("liaison-tool-{name}"));
    fs::create_dir(&dir).ok()?;
    Some(dir)
}

/// One repository the signed-in tools list (`NodeRemoteRepo`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRepo {
    pub source: &'static str,
    pub full_name: String,
    pub host: String,
    pub clone_url: String,
    pub private: bool,
    pub pushed_at: Option<i64>,
    pub local: Option<RemoteLocal>,
}

/// A clone of a remote repository on this disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteLocal {
    pub display: String,
    pub shared: bool,
    pub token: Option<String>,
}

/// What became of one tool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSource {
    pub tool: &'static str,
    pub state: &'static str,
}

/// A `remotes` answer (`NodeRemotes`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotesAnswer {
    pub repos: Vec<RemoteRepo>,
    pub sources: Vec<RemoteSource>,
    pub dropped: usize,
}

/// Prefixes of the tokens GitHub and GitLab issue: a value carrying one is
/// never put in an answer, whatever field it came in.
const SECRET_MARKS: [&str; 8] = [
    "ghp_",
    "gho_",
    "ghs_",
    "ghu_",
    "ghr_",
    "github_pat_",
    "glpat-",
    "oauth_token",
];

fn looks_secret(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    SECRET_MARKS.iter().any(|m| lower.contains(m))
}

/// A remote's `host/owner/name`, as two spellings of one repository share it
/// (S5): any `user[:password]@` dropped, the host lowercased without its
/// port, `.git` and trailing slashes off; `https://host/`, `ssh://git@host/`
/// and `git@host:` alike. None for anything else.
pub fn remote_key(url: &str) -> Option<String> {
    let u = url.trim();
    let lower = u.to_ascii_lowercase();
    let (authority, path) = if let Some(i) = ["https://", "http://", "ssh://", "git://"]
        .iter()
        .find(|s| lower.starts_with(*s))
        .map(|s| s.len())
    {
        let rest = &u[i..];
        let slash = rest.find('/')?;
        (&rest[..slash], &rest[slash + 1..])
    } else {
        let (before, after) = u.split_once(':')?;
        if before.contains('/') {
            return None;
        }
        (before, after)
    };
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = host_port.split(':').next().unwrap_or("").to_ascii_lowercase();
    let mut path = path.trim_matches('/');
    path = path.strip_suffix(".git").unwrap_or(path).trim_end_matches('/');
    if host.is_empty()
        || !path.contains('/')
        || path.split('/').any(|p| p.is_empty() || p == "." || p == "..")
    {
        return None;
    }
    Some(format!("{host}/{}", path.to_ascii_lowercase()))
}

/// `origin`'s URL, read from `<repo>/.git/config` as text: `.git` must be a
/// real folder (a worktree's or submodule's `.git` file, or a link, is not
/// read), the file at most `GIT_CONFIG_MAX`. Git never runs in the repository.
pub fn origin_url(repo: &Path) -> Option<String> {
    let git = repo.join(".git");
    if !fs::symlink_metadata(&git).ok()?.is_dir() {
        return None;
    }
    let config = git.join("config");
    let meta = fs::symlink_metadata(&config).ok()?;
    if !meta.is_file() || meta.len() > GIT_CONFIG_MAX {
        return None;
    }
    let text = fs::read_to_string(&config).ok()?;
    let mut in_origin = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            let inner = line.trim_start_matches('[');
            let inner = inner.split(']').next().unwrap_or("");
            let mut words = inner.split_whitespace();
            in_origin = words
                .next()
                .is_some_and(|w| w.eq_ignore_ascii_case("remote"))
                && words.next() == Some("\"origin\"")
                && words.next().is_none();
            continue;
        }
        if !in_origin || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            if key.trim().eq_ignore_ascii_case("url") {
                return Some(value.trim().trim_matches('"').to_string());
            }
        }
    }
    None
}

/// A clone URL as an answer may carry it: an https one without any
/// `user[:password]@`, an ssh one only as `git@`; never a token, and only
/// what `clone_url_ok` accepts.
pub fn safe_clone_url(url: &str) -> Option<String> {
    let u = url.trim();
    let out = if let Some(rest) = u.strip_prefix("https://") {
        let slash = rest.find('/').unwrap_or(rest.len());
        let authority = &rest[..slash];
        let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
        format!("https://{host}{}", &rest[slash..])
    } else if let Some(rest) = u.strip_prefix("ssh://") {
        let authority = rest.split('/').next().unwrap_or("");
        match authority.rsplit_once('@') {
            Some(("git", _)) => u.to_string(),
            _ => return None,
        }
    } else {
        match u.split_once('@') {
            Some(("git", _)) => u.to_string(),
            _ => return None,
        }
    };
    (clone_url_ok(&out) && !looks_secret(&out)).then_some(out)
}

fn host_of(url: &str) -> Option<String> {
    remote_key(url).and_then(|k| k.split('/').next().map(str::to_string))
}

/// Days from 1970-01-01 to a civil date (proleptic Gregorian).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `2026-10-21T12:34:56Z` (fraction and offset allowed) as epoch milliseconds.
pub fn iso_millis(s: &str) -> Option<i64> {
    let s = s.trim();
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b' ') {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, se) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let mut rest = &s[19..];
    let mut millis = 0i64;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits: String = frac.chars().take_while(char::is_ascii_digit).collect();
        rest = &frac[digits.len()..];
        let ms: String = digits.chars().chain("000".chars()).take(3).collect();
        millis = ms.parse().ok()?;
    }
    let offset = match rest {
        "Z" | "z" | "" => 0,
        o if o.len() == 6 && matches!(&o[..1], "+" | "-") && &o[3..4] == ":" => {
            let sign = if o.starts_with('-') { -1 } else { 1 };
            sign * (o[1..3].parse::<i64>().ok()? * 60 + o[4..6].parse::<i64>().ok()?)
        }
        _ => return None,
    };
    let secs = days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + se - offset * 60;
    Some(secs * 1000 + millis)
}

/// What one tool call may still take: its own cap within the overall deadline.
fn time_left(deadline: std::time::Instant) -> Option<std::time::Duration> {
    let left = deadline.saturating_duration_since(std::time::Instant::now());
    (!left.is_zero()).then(|| left.min(TOOL_TIMEOUT))
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

/// One tool's repositories, page by page: a page that fails after the first
/// keeps the pages read (the state is `failed` only when page 1 failed).
fn tool_repos(
    runner: &dyn ToolRunner,
    tool: &'static str,
    deadline: std::time::Instant,
    repos: &mut Vec<RemoteRepo>,
    dropped: &mut usize,
) -> &'static str {
    let Some(program) = runner.locate(tool) else {
        return "missing";
    };
    let (status, protocol): (Vec<String>, Vec<String>) = if tool == "gh" {
        (
            args(&["auth", "status", "--hostname", "github.com"]),
            args(&["config", "get", "git_protocol", "-h", "github.com"]),
        )
    } else {
        (
            args(&["auth", "status"]),
            args(&["config", "get", "git_protocol"]),
        )
    };
    let Some(left) = time_left(deadline) else {
        return "failed";
    };
    match runner.run(&program, &status, left) {
        ToolRun::Ok(_) => {}
        ToolRun::Exit => return "signed_out",
        _ => return "failed",
    }
    let Some(left) = time_left(deadline) else {
        return "failed";
    };
    let ssh = matches!(runner.run(&program, &protocol, left), ToolRun::Ok(out)
        if String::from_utf8_lossy(&out).trim().eq_ignore_ascii_case("ssh"));
    for page in 1..=REMOTE_PAGES {
        let endpoint = if tool == "gh" {
            format!("user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page={page}")
        } else {
            format!("projects?membership=true&order_by=last_activity_at&per_page=100&page={page}")
        };
        let call: Vec<String> = if tool == "gh" {
            vec!["api".into(), "--hostname".into(), "github.com".into(), endpoint]
        } else {
            vec!["api".into(), endpoint]
        };
        let items = time_left(deadline)
            .map(|left| runner.run(&program, &call, left))
            .and_then(|run| match run {
                ToolRun::Ok(out) => serde_json::from_slice::<serde_json::Value>(&out).ok(),
                _ => None,
            })
            .and_then(|v| v.as_array().cloned());
        let Some(items) = items else {
            return if page == 1 { "failed" } else { "ok" };
        };
        for item in &items {
            if repos.len() >= REMOTES_LIMIT {
                return "ok";
            }
            match remote_repo(tool, item, ssh) {
                Some(repo) => repos.push(repo),
                None => *dropped += 1,
            }
        }
        if items.len() < 100 {
            break;
        }
    }
    "ok"
}

/// One listed repository, or None when its URL or name cannot be answered.
fn remote_repo(tool: &str, item: &serde_json::Value, ssh: bool) -> Option<RemoteRepo> {
    let text = |k: &str| item.get(k).and_then(|v| v.as_str());
    let (source, name, https, ssh_url, private, pushed) = if tool == "gh" {
        (
            "github",
            text("full_name")?,
            text("clone_url")?,
            text("ssh_url"),
            item.get("private").and_then(|v| v.as_bool()).unwrap_or(true),
            text("pushed_at"),
        )
    } else {
        (
            "gitlab",
            text("path_with_namespace")?,
            text("http_url_to_repo")?,
            text("ssh_url_to_repo"),
            text("visibility") != Some("public"),
            text("last_activity_at"),
        )
    };
    let chosen = if ssh { ssh_url.unwrap_or(https) } else { https };
    let clone_url = safe_clone_url(chosen)?;
    let full_name: String = clean_name(name).chars().take(300).collect();
    let host = host_of(&clone_url)?;
    if full_name.is_empty() || looks_secret(&full_name) || looks_secret(&host) {
        return None;
    }
    Some(RemoteRepo {
        source,
        full_name,
        host,
        clone_url,
        private,
        pushed_at: pushed.and_then(iso_millis),
        local: None,
    })
}

/// The repositories the signed-in tools list, each marked with its clone on
/// this disk (the shared repositories, then a scan's), by `origin` (S3-S5,
/// A6, A7). Takes no input; tokens only for a local clone it may share.
pub fn remotes_at(
    dir: &Path,
    server: &str,
    home: &Path,
    runner: &dyn ToolRunner,
    tokens: &CandidateTokens,
    scan_time: std::time::Duration,
    deadline: std::time::Instant,
) -> RemotesAnswer {
    let real_home = fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    // (key, real, path, display, shared, may share): shared first, then by path.
    let mut locals: Vec<(String, PathBuf, PathBuf, String, bool, bool)> = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();
    for f in shared_folders_for(dir, home, server)
        .into_iter()
        .filter(|f| f.kind == "repo")
    {
        let path = PathBuf::from(&f.path);
        let real = root_key(&f.path);
        if seen.contains(&real) {
            continue;
        }
        seen.push(real.clone());
        if let Some(key) = origin_url(&path).as_deref().and_then(remote_key) {
            let display = short_display(&path, home, &real_home);
            locals.push((key, real, path, display, true, false));
        }
    }
    let scanned = scan_rows(dir, server, home, scan_time, SCAN_VISIT_BUDGET);
    for row in scanned.rows {
        if seen.contains(&row.real) {
            continue;
        }
        seen.push(row.real.clone());
        if let Some(key) = origin_url(&row.path).as_deref().and_then(remote_key) {
            let may = !row.shared && row.refusal.is_none();
            locals.push((key, row.real, row.path, row.display, row.shared, may));
        }
    }
    locals.sort_by(|a, b| (!a.4, &a.2).cmp(&(!b.4, &b.2)));
    let mut repos: Vec<RemoteRepo> = Vec::new();
    let mut dropped = 0usize;
    let mut sources: Vec<RemoteSource> = Vec::new();
    for tool in ["gh", "glab"] {
        let state = tool_repos(runner, tool, deadline, &mut repos, &mut dropped);
        sources.push(RemoteSource { tool, state });
    }
    for repo in &mut repos {
        let Some(key) = remote_key(&repo.clone_url) else {
            continue;
        };
        if let Some(l) = locals.iter().find(|l| l.0 == key) {
            repo.local = Some(RemoteLocal {
                display: l.3.clone(),
                shared: l.4,
                token: l.5.then(|| tokens.issue(&l.2)),
            });
        }
    }
    RemotesAnswer {
        repos,
        sources,
        dropped,
    }
}

/// The repositories this computer's `gh` and `glab` can reach (S3).
#[tauri::command]
pub async fn node_folder_remotes<R: Runtime>(app: AppHandle<R>) -> Result<RemotesAnswer, String> {
    let dir = app_config_dir(&app).ok_or("no application config directory")?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let server = resolve_base_url(&app).unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = std::time::Instant::now() + REMOTES_TIME;
        let tools = SystemTools { home: home.clone() };
        remotes_at(&dir, &server, &home, &tools, candidate_tokens(), SCAN_TIME, deadline)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod node_folders_tests {
    use super::*;

    /// A scratch folder by its real path: the OS temp folder is often reached
    /// through a link (`/var` on macOS is `/private/var`), and the walk
    /// answers real paths.
    fn scratch_dir(name: &str) -> PathBuf {
        let dir = crate::servers::scratch_dir(name);
        fs::canonicalize(&dir).unwrap_or(dir)
    }
    use serde_json::json;

    const SERVER: &str = "https://liaison.acme.example";
    const OTHER: &str = "https://liaison.fabrikam.example";

    // S52 (owner D13): "Open in VS Code" opens only a folder this node shares.
    fn shared(name: &str, path: &str) -> SharedFolder {
        SharedFolder {
            name: name.into(),
            path: path.into(),
            kind: "repo",
            git_default_branch: None,
        }
    }

    #[test]
    fn s52_editor_url_is_built_from_the_shells_folder_map() {
        let folders = vec![
            shared("app", "/Users/o/code/app"),
            shared("My Notes", "/Users/o/My Notes"),
        ];
        assert_eq!(
            editor_url_for(&folders, "app").as_deref(),
            Some("vscode://file/Users/o/code/app")
        );
        assert_eq!(
            editor_url_for(&folders, "My Notes").as_deref(),
            Some("vscode://file/Users/o/My%20Notes")
        );
        assert_eq!(
            editor_url_for(&[shared("w", r"C:\Users\o\w")], "w").as_deref(),
            Some("vscode://file/C:/Users/o/w")
        );
    }

    #[test]
    fn s52_an_unknown_or_ambiguous_folder_name_opens_nothing() {
        let folders = vec![
            shared("app", "/Users/o/a/app"),
            shared("app", "/Users/o/b/app"),
            shared("site", "/Users/o/site"),
        ];
        assert_eq!(editor_url_for(&folders, "nope"), None);
        assert_eq!(editor_url_for(&folders, ""), None);
        assert_eq!(editor_url_for(&folders, "/Users/o/site"), None);
        assert_eq!(editor_url_for(&folders, "app"), None);
        assert_eq!(editor_url_for(&[shared("rel", "code/rel")], "rel"), None);
    }

    #[test]
    fn s52_a_subfolder_session_opens_through_its_shared_root_and_never_outside_it() {
        let dir = scratch_dir("editor-subfolder");
        let root = dir.join("shared");
        fs::create_dir_all(root.join("apps").join("web")).unwrap();
        fs::create_dir_all(dir.join("outside")).unwrap();
        let root_s = root.to_string_lossy().into_owned();
        let folders = vec![shared("shared", &root_s)];
        let real = fs::canonicalize(root.join("apps").join("web")).unwrap();
        let expected = format!("vscode://file{}", real.to_string_lossy());
        assert_eq!(
            editor_url_within(&folders, "shared", "apps/web").as_deref(),
            Some(expected.as_str())
        );
        // No relative path: the root itself, as before.
        assert_eq!(
            editor_url_within(&folders, "shared", ""),
            editor_url_for(&folders, "shared")
        );
        // Anything that leaves the root, or does not exist, opens nothing.
        for rel in ["../outside", "apps/../../outside", "/etc", "apps/missing", "./apps"] {
            assert_eq!(editor_url_within(&folders, "shared", rel), None, "{rel}");
        }
        // A link inside the root that points out of it opens nothing.
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("outside"), root.join("escape")).unwrap();
            assert_eq!(editor_url_within(&folders, "shared", "escape"), None);
        }
        // An unknown root name opens nothing whatever the relative path.
        assert_eq!(editor_url_within(&folders, "nope", "apps/web"), None);
        let _ = fs::remove_dir_all(&dir);
    }

    fn repo(path: &Path, default_branch: Option<&str>) {
        fs::create_dir_all(
            path.join(".git")
                .join("refs")
                .join("remotes")
                .join("origin"),
        )
        .unwrap();
        if let Some(b) = default_branch {
            fs::write(
                path.join(".git/refs/remotes/origin/HEAD"),
                format!("ref: refs/remotes/origin/{b}\n"),
            )
            .unwrap();
        }
    }

    fn recent(dir: &Path, doc: serde_json::Value) {
        fs::write(
            dir.join("liaison-folders.json"),
            serde_json::to_vec(&doc).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn roots_default_to_recent_folders() {
        let base = scratch_dir("node-folders-recent");
        let config = base.join("config");
        fs::create_dir_all(&config).unwrap();
        let code = base.join("code");
        let notes = base.join("notes");
        let elsewhere = base.join("elsewhere");
        for d in [&code, &notes, &elsewhere] {
            fs::create_dir_all(d).unwrap();
        }
        recent(
            &config,
            json!({
                format!("{SERVER}#agent-a"): [code.to_string_lossy()],
                format!("{SERVER}#agent-b"): [notes.to_string_lossy(), code.to_string_lossy()],
                format!("{OTHER}#agent-a"): [elsewhere.to_string_lossy()],
            }),
        );
        let mut paths: Vec<String> = shared_folders_at(&config, SERVER)
            .into_iter()
            .map(|f| {
                assert_eq!(f.kind, "root");
                f.path
            })
            .collect();
        paths.sort();
        let mut expected = vec![
            code.to_string_lossy().into_owned(),
            notes.to_string_lossy().into_owned(),
        ];
        expected.sort();
        assert_eq!(paths, expected);
        // The chosen roots win over the recent folders once the settings name them.
        fs::write(
            config.join(NODE_SETTINGS_FILE),
            serde_json::to_vec(&json!({ "sharedRoots": [elsewhere.to_string_lossy()] })).unwrap(),
        )
        .unwrap();
        let chosen = shared_folders_at(&config, SERVER);
        assert_eq!(chosen.len(), 1);
        assert_eq!(chosen[0].path, elsewhere.to_string_lossy());
        assert_eq!(chosen[0].name, "elsewhere");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn direct_child_repos_are_listed_with_default_branch() {
        let base = scratch_dir("node-folders-children");
        let config = base.join("config");
        fs::create_dir_all(&config).unwrap();
        let code = base.join("code");
        repo(&code.join("app"), Some("trunk2"));
        repo(&code.join("lib"), None);
        fs::create_dir_all(code.join("plain")).unwrap();
        // A worktree's or submodule's `.git` is a file.
        fs::create_dir_all(code.join("wt")).unwrap();
        fs::write(
            code.join("wt/.git"),
            "gitdir: /somewhere/.git/worktrees/wt\n",
        )
        .unwrap();
        // A root that is itself a repository is a repo.
        let solo = base.join("solo");
        repo(&solo, Some("main"));
        fs::write(
            config.join(NODE_SETTINGS_FILE),
            serde_json::to_vec(&json!({
                "sharedRoots": [code.to_string_lossy(), solo.to_string_lossy()]
            }))
            .unwrap(),
        )
        .unwrap();
        let folders = shared_folders_at(&config, SERVER);
        let find = |name: &str| folders.iter().find(|f| f.name == name).cloned();
        assert_eq!(find("code").unwrap().kind, "root");
        let app = find("app").unwrap();
        assert_eq!(app.kind, "repo");
        assert_eq!(app.path, code.join("app").to_string_lossy());
        assert_eq!(app.git_default_branch.as_deref(), Some("trunk2"));
        assert_eq!(find("lib").unwrap().git_default_branch, None);
        assert_eq!(find("wt").unwrap().kind, "repo");
        assert!(find("plain").is_none());
        let solo_entry = find("solo").unwrap();
        assert_eq!(solo_entry.kind, "repo");
        assert_eq!(solo_entry.git_default_branch.as_deref(), Some("main"));
        let wire = serde_json::to_value(&app).unwrap();
        assert_eq!(wire["gitDefaultBranch"], "trunk2");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn nested_repos_two_levels_down_are_not() {
        let base = scratch_dir("node-folders-nested");
        let config = base.join("config");
        fs::create_dir_all(&config).unwrap();
        let code = base.join("code");
        repo(&code.join("group").join("deep"), Some("main"));
        // A symlink to a repository outside the root is not followed.
        let outside = base.join("outside-repo");
        repo(&outside, Some("main"));
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, code.join("linked")).unwrap();
        fs::write(
            config.join(NODE_SETTINGS_FILE),
            serde_json::to_vec(&json!({ "sharedRoots": [code.to_string_lossy()] })).unwrap(),
        )
        .unwrap();
        let names: Vec<String> = shared_folders_at(&config, SERVER)
            .into_iter()
            .map(|f| f.name)
            .collect();
        assert_eq!(names, vec!["code".to_string()]);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_missing_root_is_skipped() {
        let base = scratch_dir("node-folders-missing");
        let config = base.join("config");
        fs::create_dir_all(&config).unwrap();
        let here = base.join("here");
        fs::create_dir_all(&here).unwrap();
        fs::write(
            config.join(NODE_SETTINGS_FILE),
            serde_json::to_vec(&json!({
                "sharedRoots": [base.join("gone").to_string_lossy(), "relative/path", here.to_string_lossy()]
            }))
            .unwrap(),
        )
        .unwrap();
        let folders = shared_folders_at(&config, SERVER);
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].path, here.to_string_lossy());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn at_most_the_limit_is_listed() {
        let base = scratch_dir("node-folders-limit");
        let config = base.join("config");
        fs::create_dir_all(&config).unwrap();
        let code = base.join("code");
        for i in 0..(SHARED_FOLDERS_LIMIT + 5) {
            fs::create_dir_all(code.join(format!("r{i:04}")).join(".git")).unwrap();
        }
        fs::write(
            config.join(NODE_SETTINGS_FILE),
            serde_json::to_vec(&json!({ "sharedRoots": [code.to_string_lossy()] })).unwrap(),
        )
        .unwrap();
        assert_eq!(
            shared_folders_at(&config, SERVER).len(),
            SHARED_FOLDERS_LIMIT
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn privacy_settings_open_a_fixed_page_per_os() {
        assert!(privacy_settings_url("macos")
            .unwrap()
            .contains("Privacy_FilesAndFolders"));
        assert_eq!(
            privacy_settings_url("windows"),
            Some("ms-settings:windowsdefender")
        );
        assert_eq!(privacy_settings_url("linux"), None);
    }

    #[test]
    fn search_roots_default_to_home_only_without_the_key() {
        let base = scratch_dir("node-folders-search-default");
        let config = base.join("config");
        let home = base.join("Users").join("owner");
        let code = home.join("code");
        for d in [&config, &code] {
            fs::create_dir_all(d).unwrap();
        }
        let s = |p: &Path| p.to_string_lossy().into_owned();
        // No settings file at all: the home folder.
        assert_eq!(search_roots_at(&config, &home), vec![s(&home)]);
        // A settings file without the key: still the home folder.
        fs::write(
            config.join(NODE_SETTINGS_FILE),
            serde_json::to_vec(&json!({ "nodeRoot": "/Volumes/Data/Jobs" })).unwrap(),
        )
        .unwrap();
        assert_eq!(search_roots_at(&config, &home), vec![s(&home)]);
        let view = search_roots_view(&config, &home);
        assert_eq!(view.display, vec!["~".to_string()]);
        // The default finds a folder in the home folder out of the box.
        let answer = lookup_folders_at(
            &config,
            SERVER,
            &home,
            "code",
            &|_, _| Vec::new(),
            &CandidateTokens::default(),
        );
        assert_eq!(answer.search_roots, 1);
        assert_eq!(answer.candidates.len(), 1);
        // A list the owner emptied stays empty.
        set_search_roots_at(&config, &home, vec![]).unwrap();
        assert!(search_roots_at(&config, &home).is_empty());
        // Removing the default home folder writes an empty list.
        fs::write(config.join(NODE_SETTINGS_FILE), b"{}").unwrap();
        remove_search_root_at(&config, &home, &s(&home)).unwrap();
        assert!(search_roots_at(&config, &home).is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn the_implicit_home_default_never_enters_protected_folders() {
        let base = scratch_dir("node-folders-implicit-protected");
        let config = base.join("config");
        let home = base.join("Users").join("owner");
        for d in [
            config.clone(),
            home.join("code").join("proj"),
            home.join("Documents").join("proj"),
            home.join("Downloads").join("proj"),
        ] {
            fs::create_dir_all(d).unwrap();
        }
        let in_docs = home.join("Documents").join("proj");
        let spotlight =
            |_: &str, _: &[PathBuf]| vec![in_docs.to_string_lossy().into_owned()];
        let names = |a: &LookupAnswer| -> Vec<String> {
            let mut v: Vec<String> = a.candidates.iter().map(|c| c.display.clone()).collect();
            v.sort();
            v
        };
        // No searchRoots key: the home folder, without Documents, Desktop or
        // Downloads, even when the OS index names a folder in one.
        let implicit =
            lookup_folders_at(&config, SERVER, &home, "proj", &spotlight, &CandidateTokens::default());
        assert!(implicit.skipped_protected);
        assert_eq!(names(&implicit), vec!["~/code/proj".to_string()]);
        assert!(search_roots_view(&config, &home).denied.is_empty());
        // The home folder chosen explicitly (confirmed in the app): searched whole.
        set_search_roots_at(&config, &home, vec!["~".into()]).unwrap();
        assert!(!search_roots_are_default(&config));
        let explicit =
            lookup_folders_at(&config, SERVER, &home, "proj", &spotlight, &CandidateTokens::default());
        assert!(!explicit.skipped_protected);
        assert_eq!(
            names(&explicit),
            vec![
                "~/Documents/proj".to_string(),
                "~/Downloads/proj".to_string(),
                "~/code/proj".to_string()
            ]
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn shared_roots_name_their_repositories_and_default_branch() {
        let base = scratch_dir("node-folders-root-repos");
        let config = base.join("config");
        let home = base.join("home");
        let app = home.join("app");
        let plain = home.join("notes");
        let bare = home.join("bare");
        for d in [&config, &plain] {
            fs::create_dir_all(d).unwrap();
        }
        repo(&app, Some("main"));
        repo(&bare, None);
        let s = |p: &Path| p.to_string_lossy().into_owned();
        set_shared_roots_at(&config, &home, SERVER, Some(vec![s(&app), s(&plain), s(&bare)]))
            .unwrap();
        assert_eq!(
            shared_roots_at(&config, SERVER).repos,
            vec![
                SharedRootRepo {
                    path: s(&app),
                    default_branch: Some("main".into())
                },
                SharedRootRepo {
                    path: s(&bare),
                    default_branch: None
                },
            ]
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn set_shared_roots_writes_and_none_restores_default() {
        let base = scratch_dir("node-folders-set-roots");
        let config = base.join("config");
        let home = base.join("home");
        fs::create_dir_all(&config).unwrap();
        let code = home.join("code");
        let notes = home.join("notes");
        let recent_one = home.join("recent");
        for d in [&code, &notes, &recent_one] {
            fs::create_dir_all(d).unwrap();
        }
        recent(
            &config,
            json!({ format!("{SERVER}#agent-a"): [recent_one.to_string_lossy()] }),
        );
        // Another setting in the same file survives every write.
        fs::write(
            config.join(NODE_SETTINGS_FILE),
            serde_json::to_vec(&json!({ "nodeRoot": "/Volumes/Data/Jobs" })).unwrap(),
        )
        .unwrap();
        assert_eq!(
            shared_roots_at(&config, SERVER),
            SharedRoots {
                roots: vec![recent_one.to_string_lossy().into_owned()],
                is_default: true,
                missing: vec![],
                refused: vec![],
                dropped: vec![],
                repos: vec![],
            }
        );
        let code_s = code.to_string_lossy().into_owned();
        let notes_s = notes.to_string_lossy().into_owned();
        set_shared_roots_at(
            &config,
            &home,
            SERVER,
            Some(vec![code_s.clone(), notes_s.clone(), code_s.clone()]),
        )
        .unwrap();
        assert_eq!(
            shared_roots_at(&config, SERVER),
            SharedRoots {
                roots: vec![code_s.clone(), notes_s.clone()],
                is_default: false,
                missing: vec![],
                refused: vec![],
                dropped: vec![],
                repos: vec![],
            }
        );
        let names: Vec<String> = shared_folders_at(&config, SERVER)
            .into_iter()
            .map(|f| f.name)
            .collect();
        assert_eq!(names, vec!["code".to_string(), "notes".to_string()]);
        let doc: serde_json::Value =
            serde_json::from_slice(&fs::read(config.join(NODE_SETTINGS_FILE)).unwrap()).unwrap();
        assert_eq!(doc["nodeRoot"], "/Volumes/Data/Jobs");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(config.join(NODE_SETTINGS_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // None: back to the recent folders.
        set_shared_roots_at(&config, &home, SERVER, None).unwrap();
        assert_eq!(
            shared_roots_at(&config, SERVER),
            SharedRoots {
                roots: vec![recent_one.to_string_lossy().into_owned()],
                is_default: true,
                missing: vec![],
                refused: vec![],
                dropped: vec![],
                repos: vec![],
            }
        );
        let doc: serde_json::Value =
            serde_json::from_slice(&fs::read(config.join(NODE_SETTINGS_FILE)).unwrap()).unwrap();
        assert!(doc.get("sharedRoots").is_none());
        assert_eq!(doc["nodeRoot"], "/Volumes/Data/Jobs");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn set_shared_roots_refuses_home_and_missing() {
        let base = scratch_dir("node-folders-refuse-roots");
        let config = base.join("config");
        let home = base.join("home");
        let code = home.join("code");
        fs::create_dir_all(&config).unwrap();
        fs::create_dir_all(&code).unwrap();
        let code_s = code.to_string_lossy().into_owned();
        set_shared_roots_at(&config, &home, SERVER, Some(vec![code_s.clone()])).unwrap();
        let refused = [
            (home.to_string_lossy().into_owned(), SHARED_ROOT_HOME),
            (base.to_string_lossy().into_owned(), SHARED_ROOT_HOME),
            ("/".to_string(), SHARED_ROOT_HOME),
            (
                home.join("gone").to_string_lossy().into_owned(),
                SHARED_ROOT_MISSING,
            ),
            ("relative/code".to_string(), SHARED_ROOT_REFUSED),
            (format!("{}/../code", code_s), SHARED_ROOT_REFUSED),
        ];
        for (bad, rule) in refused {
            assert_eq!(
                set_shared_roots_at(
                    &config,
                    &home,
                    SERVER,
                    Some(vec![code_s.clone(), bad.clone()])
                ),
                Err(rule),
                "{bad} must be refused by {rule}"
            );
        }
        // A file is not a folder.
        let file = home.join("a-file");
        fs::write(&file, "x").unwrap();
        assert_eq!(
            set_shared_roots_at(
                &config,
                &home,
                SERVER,
                Some(vec![file.to_string_lossy().into_owned()])
            ),
            Err(SHARED_ROOT_MISSING)
        );
        // A link to the home folder is the home folder.
        #[cfg(unix)]
        {
            let link = base.join("home-link");
            std::os::unix::fs::symlink(&home, &link).unwrap();
            assert_eq!(
                set_shared_roots_at(
                    &config,
                    &home,
                    SERVER,
                    Some(vec![link.to_string_lossy().into_owned()])
                ),
                Err(SHARED_ROOT_HOME)
            );
        }
        // A refused list changes nothing.
        assert_eq!(shared_roots_at(&config, SERVER).roots, vec![code_s]);
        let _ = fs::remove_dir_all(&base);
    }

    /// The owner's report: recent folders since deleted blocked every Remove
    /// and every Add (one refused root refused the whole list).
    #[test]
    fn stale_recent_folders_never_block_add_or_remove() {
        let base = scratch_dir("node-folders-stale");
        let config = base.join("config");
        let home = base.join("home");
        let kept = home.join("reports");
        let gone_a = home.join("walk-folder");
        let gone_b = base.join("tmp").join("workspace");
        let picked = home.join("picked");
        for d in [&config, &kept, &gone_a, &gone_b, &picked] {
            fs::create_dir_all(d).unwrap();
        }
        recent(
            &config,
            json!({ format!("{SERVER}#agent-a"): [
                gone_a.to_string_lossy(), kept.to_string_lossy(), gone_b.to_string_lossy()
            ] }),
        );
        fs::remove_dir_all(&gone_a).unwrap();
        fs::remove_dir_all(&gone_b).unwrap();
        let s = |p: &Path| p.to_string_lossy().into_owned();
        let before = shared_roots_at(&config, SERVER);
        assert!(before.is_default);
        assert_eq!(before.missing, vec![s(&gone_a), s(&gone_b)]);
        // The gone folders are never offered to sessions.
        let offered: Vec<String> = shared_folders_at(&config, SERVER)
            .into_iter()
            .map(|f| f.path)
            .collect();
        assert_eq!(offered, vec![s(&kept)]);
        // Add a valid folder next to the stale ones: accepted.
        let mut next = before.roots.clone();
        next.push(s(&picked));
        set_shared_roots_at(&config, &home, SERVER, Some(next)).unwrap();
        let after_add = shared_roots_at(&config, SERVER);
        assert!(!after_add.is_default);
        assert_eq!(
            after_add.roots,
            vec![s(&gone_a), s(&kept), s(&gone_b), s(&picked)]
        );
        // Remove a missing one, then a present one while another is missing.
        set_shared_roots_at(
            &config,
            &home,
            SERVER,
            Some(vec![s(&kept), s(&gone_b), s(&picked)]),
        )
        .unwrap();
        set_shared_roots_at(&config, &home, SERVER, Some(vec![s(&gone_b), s(&picked)])).unwrap();
        let after = shared_roots_at(&config, SERVER);
        assert_eq!(after.roots, vec![s(&gone_b), s(&picked)]);
        assert_eq!(after.missing, vec![s(&gone_b)]);
        // The removal sticks: the recent folders do not come back.
        recent(
            &config,
            json!({ format!("{SERVER}#agent-a"): [kept.to_string_lossy()] }),
        );
        assert_eq!(
            shared_roots_at(&config, SERVER).roots,
            vec![s(&gone_b), s(&picked)]
        );
        let _ = fs::remove_dir_all(&base);
    }

    /// Removing a recent folder from the default (no chosen roots yet) works
    /// even when every other recent folder is gone.
    #[test]
    fn removing_from_the_default_works_with_only_stale_neighbours() {
        let base = scratch_dir("node-folders-stale-default");
        let config = base.join("config");
        let home = base.join("home");
        let gone = home.join("gone");
        let kept = home.join("kept");
        for d in [&config, &gone, &kept] {
            fs::create_dir_all(d).unwrap();
        }
        recent(
            &config,
            json!({ format!("{SERVER}#agent-a"): [gone.to_string_lossy(), kept.to_string_lossy()] }),
        );
        fs::remove_dir_all(&gone).unwrap();
        set_shared_roots_at(
            &config,
            &home,
            SERVER,
            Some(vec![gone.to_string_lossy().into_owned()]),
        )
        .unwrap();
        let roots = shared_roots_at(&config, SERVER);
        assert!(!roots.is_default);
        assert_eq!(roots.roots, vec![gone.to_string_lossy().into_owned()]);
        let _ = fs::remove_dir_all(&base);
    }

    /// Two spellings of one folder (a trailing slash, a link to it) are listed
    /// once, in the settings and to the server.
    #[test]
    fn shared_roots_are_deduped_by_real_path() {
        let base = scratch_dir("node-folders-dedupe");
        let config = base.join("config");
        let home = base.join("home");
        let code = home.join("code");
        for d in [&config, &code] {
            fs::create_dir_all(d).unwrap();
        }
        let code_s = code.to_string_lossy().into_owned();
        let mut spellings = vec![code_s.clone(), format!("{code_s}/")];
        #[cfg(unix)]
        {
            let link = base.join("code-link");
            std::os::unix::fs::symlink(&code, &link).unwrap();
            spellings.push(link.to_string_lossy().into_owned());
        }
        recent(
            &config,
            json!({
                format!("{SERVER}#agent-a"): spellings.clone(),
                format!("{SERVER}#agent-b"): [code_s.clone()],
            }),
        );
        assert_eq!(shared_roots_at(&config, SERVER).roots, vec![code_s.clone()]);
        assert_eq!(shared_folders_at(&config, SERVER).len(), 1);
        set_shared_roots_at(&config, &home, SERVER, Some(spellings)).unwrap();
        assert_eq!(shared_roots_at(&config, SERVER).roots, vec![code_s]);
        let _ = fs::remove_dir_all(&base);
    }

    /// A pick outside the home folder (another volume) or through a link to a
    /// folder is valid.
    #[test]
    fn a_pick_on_another_volume_or_through_a_link_is_accepted() {
        let base = scratch_dir("node-folders-valid-picks");
        let config = base.join("config");
        let home = base.join("Users").join("owner");
        let volume = base.join("Volumes").join("Data").join("Projects");
        let target = home.join("Documents").join("Reports");
        for d in [&config, &volume, &target] {
            fs::create_dir_all(d).unwrap();
        }
        let mut picks = vec![
            volume.to_string_lossy().into_owned(),
            format!("{}/", target.to_string_lossy()),
        ];
        #[cfg(unix)]
        {
            let link = home.join("reports-link");
            std::os::unix::fs::symlink(&target, &link).unwrap();
            assert!(validate_shared_root(&link.to_string_lossy(), &home).is_ok());
            picks.push(
                base.join("Volumes")
                    .join("Data")
                    .to_string_lossy()
                    .into_owned(),
            );
        }
        for pick in picks {
            set_shared_roots_at(&config, &home, SERVER, Some(vec![pick.clone()]))
                .unwrap_or_else(|e| panic!("{pick} refused: {e}"));
        }
        let _ = fs::remove_dir_all(&base);
    }

    fn no_spotlight(_: &str, _: &[PathBuf]) -> Vec<String> {
        Vec::new()
    }

    fn search_roots(config: &Path, roots: &[&Path]) {
        let list: Vec<String> = roots
            .iter()
            .map(|r| r.to_string_lossy().into_owned())
            .collect();
        fs::write(
            config.join(NODE_SETTINGS_FILE),
            serde_json::to_vec(&json!({ "searchRoots": list })).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn lookup_without_search_roots_searches_nothing() {
        let base = scratch_dir("node-folders-lookup-none");
        let config = base.join("config");
        let home = base.join("home");
        fs::create_dir_all(home.join("Documents").join("proj")).unwrap();
        fs::create_dir_all(&config).unwrap();
        // The owner emptied the list (no key at all would mean the home folder).
        set_search_roots_at(&config, &home, vec![]).unwrap();
        let spotlight_called = std::cell::Cell::new(false);
        let spotlight = |_: &str, _: &[PathBuf]| {
            spotlight_called.set(true);
            vec![home.join("Documents/proj").to_string_lossy().into_owned()]
        };
        let answer = lookup_folders_at(
            &config,
            SERVER,
            &home,
            "proj",
            &spotlight,
            &CandidateTokens::default(),
        );
        assert_eq!(
            answer,
            LookupAnswer {
                search_roots: 0,
                candidates: vec![],
                partial: false,
                denied: vec![],
                skipped_protected: false,
            }
        );
        assert!(!spotlight_called.get());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn lookup_stays_inside_the_search_roots_and_ranks_exact_repos_first() {
        let base = scratch_dir("node-folders-lookup");
        let config = base.join("config");
        let home = base.join("home");
        fs::create_dir_all(&config).unwrap();
        let docs = home.join("Documents");
        // Exact name, a repository, four levels down: found first.
        let deep_repo = docs.join("a").join("b").join("c").join("liaison-monorepo");
        repo(&deep_repo, Some("main"));
        // Exact name, a plain folder, shallower: after the repository.
        let plain = docs.join("liaison-monorepo");
        fs::create_dir_all(&plain).unwrap();
        // A prefix match: after every exact one.
        let prefix = docs.join("liaison-monorepo-old");
        fs::create_dir_all(&prefix).unwrap();
        // Five levels down: not walked.
        fs::create_dir_all(docs.join("a/b/c/d/liaison-monorepo")).unwrap();
        // Outside every search root, even through the OS index: never.
        let outside = base.join("elsewhere").join("liaison-monorepo");
        fs::create_dir_all(&outside).unwrap();
        search_roots(&config, &[&docs]);
        let out = outside.clone();
        let spotlight = move |_: &str, roots: &[PathBuf]| {
            assert_eq!(
                roots.len(),
                1,
                "the OS index is asked only inside the roots"
            );
            vec![out.to_string_lossy().into_owned()]
        };
        let answer = lookup_folders_at(
            &config,
            SERVER,
            &home,
            "Liaison-Monorepo",
            &spotlight,
            &CandidateTokens::default(),
        );
        assert_eq!(answer.search_roots, 1);
        let paths: Vec<&str> = answer.candidates.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                deep_repo.to_str().unwrap(),
                plain.to_str().unwrap(),
                prefix.to_str().unwrap()
            ]
        );
        let first = &answer.candidates[0];
        assert_eq!(first.display, "~/Documents/a/b/c/liaison-monorepo");
        assert!(first.is_repo && first.shareable && !first.shared);
        assert!(!answer.candidates[1].is_repo);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn lookup_skips_hidden_system_and_bundle_folders() {
        let base = scratch_dir("node-folders-lookup-excl");
        let config = base.join("config");
        let home = base.join("Users").join("owner");
        fs::create_dir_all(&config).unwrap();
        for hidden in [
            home.join(".cache").join("widget"),
            home.join("code").join("node_modules").join("widget"),
            home.join("Library").join("widget"),
            home.join("Tools.app").join("widget"),
            home.join("repo").join(".git").join("widget"),
        ] {
            fs::create_dir_all(&hidden).unwrap();
        }
        repo(&home.join("repo"), None);
        let visible = home.join("Projects").join("widget");
        fs::create_dir_all(&visible).unwrap();
        // The home folder itself is a fine search root.
        search_roots(&config, &[&home]);
        let h = home.clone();
        let spotlight = move |_: &str, _: &[PathBuf]| {
            vec![
                h.join("Library/widget").to_string_lossy().into_owned(),
                h.join(".cache/widget").to_string_lossy().into_owned(),
            ]
        };
        let answer = lookup_folders_at(
            &config,
            SERVER,
            &home,
            "widget",
            &spotlight,
            &CandidateTokens::default(),
        );
        let paths: Vec<String> = answer.candidates.into_iter().map(|f| f.path).collect();
        assert_eq!(paths, vec![visible.to_string_lossy().into_owned()]);
        // The search root itself is never a candidate, nor anything above it.
        let owner = lookup_folders_at(
            &config,
            SERVER,
            &home,
            "owner",
            &no_spotlight,
            &CandidateTokens::default(),
        );
        assert!(owner.candidates.is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn lookup_marks_shared_folders_and_caps() {
        let base = scratch_dir("node-folders-lookup-cap");
        let config = base.join("config");
        let home = base.join("home");
        let code = home.join("code");
        fs::create_dir_all(&config).unwrap();
        for i in 0..(LOOKUP_LIMIT + 5) {
            fs::create_dir_all(code.join(format!("app-{i:02}"))).unwrap();
        }
        search_roots(&config, &[&code]);
        set_shared_roots_at(
            &config,
            &home,
            SERVER,
            Some(vec![code.join("app-00").to_string_lossy().into_owned()]),
        )
        .unwrap();
        let answer = lookup_folders_at(
            &config,
            SERVER,
            &home,
            "app",
            &no_spotlight,
            &CandidateTokens::default(),
        );
        assert_eq!(answer.candidates.len(), LOOKUP_LIMIT);
        assert!(answer.candidates[0].shared);
        assert!(!answer.candidates[1].shared);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn home_is_a_search_root_but_never_a_shared_root() {
        let base = scratch_dir("node-folders-search-roots");
        let config = base.join("config");
        let home = base.join("Users").join("owner");
        let gone = home.join("gone");
        for d in [&config, &gone] {
            fs::create_dir_all(d).unwrap();
        }
        let s = |p: &Path| p.to_string_lossy().into_owned();
        set_search_roots_at(&config, &home, vec![s(&home), s(&gone)]).unwrap();
        assert_eq!(search_roots_at(&config, &home), vec![s(&home), s(&gone)]);
        assert_eq!(
            set_shared_roots_at(&config, &home, SERVER, Some(vec![s(&home)])),
            Err(SHARED_ROOT_HOME)
        );
        for (bad, rule) in [
            (s(&base.join("Users")), SEARCH_ROOT_ABOVE_HOME),
            ("/".to_string(), SEARCH_ROOT_ABOVE_HOME),
            ("relative".to_string(), SEARCH_ROOT_REFUSED),
            (s(&home.join("nope")), SHARED_ROOT_MISSING),
        ] {
            assert_eq!(
                set_search_roots_at(&config, &home, vec![bad.clone()]),
                Err(rule),
                "{bad}"
            );
        }
        // A root since deleted never blocks removing another.
        fs::remove_dir_all(&gone).unwrap();
        set_search_roots_at(&config, &home, vec![s(&gone)]).unwrap();
        assert_eq!(search_roots_view(&config, &home).missing, vec![s(&gone)]);
        // Typed on a phone: `~` and `~/…` are the home folder and what is in it.
        let docs = home.join("Documents");
        fs::create_dir_all(&docs).unwrap();
        set_search_roots_at(&config, &home, vec!["~".into(), "~/Documents".into()]).unwrap();
        let view = search_roots_view(&config, &home);
        assert_eq!(view.roots, vec![s(&home), s(&docs)]);
        assert_eq!(
            view.display,
            vec!["~".to_string(), "~/Documents".to_string()]
        );
        // Shared roots survive a search-roots write, and the other way round.
        let code = home.join("code");
        fs::create_dir_all(&code).unwrap();
        set_shared_roots_at(&config, &home, SERVER, Some(vec![s(&code)])).unwrap();
        set_search_roots_at(&config, &home, vec![]).unwrap();
        assert_eq!(shared_roots_at(&config, SERVER).roots, vec![s(&code)]);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn lookup_refuses_a_query_that_is_not_a_name() {
        for bad in [
            "",
            "  ",
            "a/b",
            "..",
            ".",
            "x\"y",
            "x'y",
            "a\nb",
            &"x".repeat(101),
        ] {
            assert!(!lookup_query_ok(bad), "{bad:?}");
        }
        for good in ["liaison-monorepo", "Rapports Liaison", "é-dossier", "x.y"] {
            assert!(lookup_query_ok(good), "{good:?}");
        }
    }

    #[test]
    fn clone_urls_are_https_ssh_or_scp_only() {
        for good in [
            "https://github.com/acme/app.git",
            "https://gitlab.example.com:8443/group/sub/app",
            "ssh://git@github.com/acme/app.git",
            "ssh://git@host.example:2222/acme/app.git",
            "git@github.com:acme/app.git",
            "git@gitlab-alias:group/app",
        ] {
            assert!(clone_url_ok(good), "{good}");
        }
        for bad in [
            "",
            "file:///etc",
            "/Users/me/repo",
            "../repo",
            "-uhttps://x/y",
            "--upload-pack=touch /tmp/x",
            "ext::sh -c touch% /tmp/pwned",
            "fd::17",
            "http://example.com/a/b",
            "https://example.com/a b",
            "https://-oProxyCommand=x/a",
            "git@-oProxyCommand=x:a",
            "git@host:-u",
            "git@host:/abs",
            "host:path",
            "https://example.com",
        ] {
            assert!(!clone_url_ok(bad), "{bad}");
        }
        assert_eq!(
            clone_name_from_url("git@github.com:acme/liaison-monorepo.git").as_deref(),
            Some("liaison-monorepo")
        );
        assert_eq!(
            clone_name_from_url("https://example.com/a/app/").as_deref(),
            Some("app")
        );
        assert!(!clone_name_ok(".hidden") && !clone_name_ok("-x") && !clone_name_ok("a/b"));
    }

    #[test]
    fn clone_errors_are_words_not_stderr() {
        assert_eq!(
            clone_error_code("git@github.com: Permission denied (publickey)."),
            CLONE_AUTH_FAILED
        );
        assert_eq!(clone_error_code("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), CLONE_AUTH_FAILED);
        assert_eq!(clone_error_code("remote: Repository not found.\nfatal: repository 'https://github.com/a/b/' not found"), CLONE_NOT_FOUND);
        assert_eq!(
            clone_error_code(
                "ssh: Could not resolve hostname nope: nodename nor servname provided"
            ),
            CLONE_HOST_UNREACHABLE
        );
        assert_eq!(
            clone_error_code("fatal: unable to access 'https://x/': Could not resolve host: x"),
            CLONE_HOST_UNREACHABLE
        );
        assert_eq!(clone_error_code("fatal: something else"), CLONE_FAILED);
    }

    #[test]
    fn clone_goes_under_the_node_root_and_is_shared() {
        let base = scratch_dir("node-folders-clone");
        let config = base.join("config");
        let home = base.join("home");
        fs::create_dir_all(&config).unwrap();
        fs::create_dir_all(&home).unwrap();
        let seen: std::cell::RefCell<Vec<Vec<String>>> = Default::default();
        let ok = |args: &[String], _cwd: &Path| -> Result<(), &'static str> {
            seen.borrow_mut().push(args.to_vec());
            let target = PathBuf::from(args.last().unwrap());
            fs::create_dir_all(target.join(".git")).unwrap();
            Ok(())
        };
        let made = clone_repo_at(
            &config,
            &home,
            SERVER,
            "git@github.com:acme/liaison-monorepo.git",
            None,
            &ok,
        )
        .unwrap();
        assert_eq!(
            made,
            home.join(crate::node_job::NODE_ROOT_NAME)
                .join("repos")
                .join("liaison-monorepo")
        );
        let args = seen.borrow()[0].clone();
        // The URL comes after `--`: git never reads it as an option.
        let dash = args.iter().position(|a| a == "--").unwrap();
        assert_eq!(args[dash + 1], "git@github.com:acme/liaison-monorepo.git");
        assert!(args.contains(&"protocol.file.allow=never".to_string()));
        let roots = shared_roots_at(&config, SERVER);
        assert!(!roots.is_default);
        assert_eq!(roots.roots, vec![made.to_string_lossy().into_owned()]);
        let folders = shared_folders_at(&config, SERVER);
        assert_eq!(folders[0].name, "liaison-monorepo");
        assert_eq!(folders[0].kind, "repo");
        // The same again: the folder exists, nothing is overwritten.
        assert_eq!(
            clone_repo_at(
                &config,
                &home,
                SERVER,
                "git@github.com:acme/liaison-monorepo.git",
                None,
                &ok
            ),
            Err(CLONE_TARGET_EXISTS)
        );
        assert_eq!(seen.borrow().len(), 1);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_refused_or_failed_clone_leaves_nothing_and_shares_nothing() {
        let base = scratch_dir("node-folders-clone-fail");
        let config = base.join("config");
        let home = base.join("home");
        fs::create_dir_all(&config).unwrap();
        fs::create_dir_all(&home).unwrap();
        let never =
            |_: &[String], _: &Path| -> Result<(), &'static str> { panic!("git must not run") };
        for (url, name, code) in [
            ("file:///etc", None, CLONE_URL_REFUSED),
            ("-uhttps://x/y", None, CLONE_URL_REFUSED),
            (
                "https://example.com/a/app.git",
                Some("../escape"),
                CLONE_NAME_REFUSED,
            ),
            (
                "https://example.com/a/app.git",
                Some(".hidden"),
                CLONE_NAME_REFUSED,
            ),
        ] {
            assert_eq!(
                clone_repo_at(&config, &home, SERVER, url, name, &never),
                Err(code),
                "{url}"
            );
        }
        let half = |args: &[String], _: &Path| -> Result<(), &'static str> {
            fs::create_dir_all(PathBuf::from(args.last().unwrap()).join("partial")).unwrap();
            Err(CLONE_AUTH_FAILED)
        };
        assert_eq!(
            clone_repo_at(
                &config,
                &home,
                SERVER,
                "https://example.com/a/app.git",
                Some("app"),
                &half
            ),
            Err(CLONE_AUTH_FAILED)
        );
        assert!(!home
            .join(crate::node_job::NODE_ROOT_NAME)
            .join("repos")
            .join("app")
            .exists());
        assert!(shared_roots_at(&config, SERVER).roots.is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_cloud_share_needs_a_proof_this_node_issued_once() {
        let base = scratch_dir("node-folders-share-token");
        let config = base.join("config");
        let home = base.join("home");
        let docs = home.join("Documents");
        let app = docs.join("app");
        let other = docs.join("other");
        for d in [&config, &app, &other] {
            fs::create_dir_all(d).unwrap();
        }
        search_roots(&config, &[&docs]);
        let tokens = CandidateTokens::default();
        let answer = lookup_folders_at(&config, SERVER, &home, "app", &no_spotlight, &tokens);
        let token = answer.candidates[0].token.clone();
        assert_eq!(token.len(), 32);
        // A made-up proof, a path: refused; nothing shared.
        assert_eq!(
            share_at(&config, &home, SERVER, &tokens, Some("00ff"), None),
            Err(SHARE_NOT_ISSUED)
        );
        assert_eq!(
            share_at(
                &config,
                &home,
                SERVER,
                &tokens,
                None,
                Some(&other.to_string_lossy())
            ),
            Err(SHARE_NOT_ISSUED)
        );
        assert!(shared_roots_at(&config, SERVER).roots.is_empty());
        // The node's own proof: shared, once.
        let shared = share_at(&config, &home, SERVER, &tokens, Some(&token), None).unwrap();
        assert_eq!(
            fs::canonicalize(&shared).unwrap(),
            fs::canonicalize(&app).unwrap()
        );
        assert_eq!(
            share_at(&config, &home, SERVER, &tokens, Some(&token), None),
            Err(SHARE_NOT_ISSUED)
        );
        // An expired proof is no proof.
        let stale = tokens.issue_for(&other, std::time::Duration::from_secs(0));
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert_eq!(
            share_at(&config, &home, SERVER, &tokens, Some(&stale), None),
            Err(SHARE_NOT_ISSUED)
        );
        // A recent folder needs no proof.
        let recent_one = home.join("recent-one");
        fs::create_dir_all(&recent_one).unwrap();
        recent(
            &config,
            json!({ format!("{SERVER}#agent-a"): [recent_one.to_string_lossy()] }),
        );
        share_at(
            &config,
            &home,
            SERVER,
            &tokens,
            None,
            Some(&recent_one.to_string_lossy()),
        )
        .unwrap();
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn the_node_checks_a_shared_path_itself() {
        let base = scratch_dir("node-folders-share-rules");
        let config = base.join("config");
        let home = base.join("home");
        let docs = home.join("Documents");
        let outside = base.join("elsewhere").join("proj");
        for d in [
            &config,
            &docs.join("proj"),
            &home.join(".secret").join("proj"),
            &home.join("Library").join("proj"),
            &outside,
            &home.join("loose"),
        ] {
            fs::create_dir_all(d).unwrap();
        }
        search_roots(&config, &[&docs]);
        let ok = |p: &Path| share_path_ok(&config, &home, SERVER, p);
        assert!(ok(&docs.join("proj")).is_ok());
        assert_eq!(ok(&home), Err(SHARED_ROOT_HOME));
        assert_eq!(ok(&home.join(".secret").join("proj")), Err(SHARE_OUTSIDE));
        assert_eq!(ok(&home.join("Library").join("proj")), Err(SHARE_OUTSIDE));
        // Outside the home folder and every search root, or loose in the home: no.
        assert_eq!(ok(&outside), Err(SHARE_OUTSIDE));
        assert_eq!(ok(&home.join("loose")), Err(SHARE_OUTSIDE));
        // A proof issued for such a path does not help either.
        let tokens = CandidateTokens::default();
        let t = tokens.issue(&home.join("Library").join("proj"));
        assert_eq!(
            share_at(&config, &home, SERVER, &tokens, Some(&t), None),
            Err(SHARE_OUTSIDE)
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_search_root_is_never_hidden_or_system() {
        let base = scratch_dir("node-folders-search-system");
        let config = base.join("config");
        let home = base.join("home");
        for d in [
            &config,
            &home.join(".ssh"),
            &home.join("Library").join("Mail"),
            &home.join("code"),
        ] {
            fs::create_dir_all(d).unwrap();
        }
        for bad in [
            home.join(".ssh"),
            home.join("Library"),
            home.join("Library").join("Mail"),
        ] {
            assert_eq!(
                set_search_roots_at(&config, &home, vec![bad.to_string_lossy().into_owned()]),
                Err(SEARCH_ROOT_SYSTEM),
                "{}",
                bad.display()
            );
        }
        assert!(hidden_or_system(
            Path::new("/System/Library"),
            Path::new("/Users/me")
        ));
        assert!(hidden_or_system(
            Path::new("/private/var"),
            Path::new("/Users/me")
        ));
        assert!(!hidden_or_system(
            Path::new("/Volumes/Data/code"),
            Path::new("/Users/me")
        ));
        set_search_roots_at(&config, &home, vec!["~".into(), "~/code".into()]).unwrap();
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_clone_never_deletes_a_folder_it_did_not_make() {
        let base = scratch_dir("node-folders-clone-race");
        let config = base.join("config");
        let home = base.join("home");
        fs::create_dir_all(&config).unwrap();
        fs::create_dir_all(&home).unwrap();
        let repos = home.join(crate::node_job::NODE_ROOT_NAME).join("repos");
        let target = repos.join("app");
        // While git clones, someone else makes the same folder.
        let racing = |args: &[String], _: &Path| -> Result<(), &'static str> {
            let temp = PathBuf::from(args.last().unwrap());
            assert!(basename(&temp).starts_with(CLONE_TEMP_PREFIX));
            fs::create_dir_all(temp.join(".git")).unwrap();
            fs::create_dir_all(&target).unwrap();
            fs::write(target.join("theirs.txt"), "keep me").unwrap();
            Ok(())
        };
        assert_eq!(
            clone_repo_at(
                &config,
                &home,
                SERVER,
                "https://example.com/a/app.git",
                None,
                &racing
            ),
            Err(CLONE_TARGET_EXISTS)
        );
        assert_eq!(
            fs::read_to_string(target.join("theirs.txt")).unwrap(),
            "keep me"
        );
        let leftovers: Vec<_> = fs::read_dir(&repos)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with(CLONE_TEMP_PREFIX)
            })
            .collect();
        assert!(leftovers.is_empty());
        assert!(shared_roots_at(&config, SERVER).roots.is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn concurrent_changes_to_the_folder_settings_are_all_kept() {
        let base = scratch_dir("node-folders-lock");
        let config = base.join("config");
        let home = base.join("home");
        fs::create_dir_all(&config).unwrap();
        let dirs: Vec<PathBuf> = (0..16).map(|i| home.join(format!("d{i:02}"))).collect();
        for d in &dirs {
            fs::create_dir_all(d).unwrap();
        }
        // Start from an empty list rather than the home folder default.
        set_search_roots_at(&config, &home, vec![]).unwrap();
        std::thread::scope(|scope| {
            for d in &dirs {
                let (config, home) = (&config, &home);
                scope
                    .spawn(move || add_search_root_at(config, home, &d.to_string_lossy()).unwrap());
            }
        });
        assert_eq!(search_roots_at(&config, &home).len(), 16);
        // Shared roots too: unshare from many threads at once loses nothing either.
        let all: Vec<String> = dirs
            .iter()
            .map(|d| d.to_string_lossy().into_owned())
            .collect();
        set_shared_roots_at(&config, &home, SERVER, Some(all.clone())).unwrap();
        std::thread::scope(|scope| {
            for d in all.iter().take(8) {
                let (config, home) = (&config, &home);
                scope.spawn(move || unshare_at(config, home, SERVER, d).unwrap());
            }
        });
        assert_eq!(shared_roots_at(&config, SERVER).roots, all[8..].to_vec());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_root_that_confines_nothing_is_never_offered_and_is_dropped_with_a_note() {
        let base = scratch_dir("node-folders-confine");
        let config = base.join("config");
        let home = base.join("Users").join("owner");
        let code = home.join("code");
        for d in [&config, &code] {
            fs::create_dir_all(d).unwrap();
        }
        let link = base.join("home-link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&home, &link).unwrap();
        let s = |p: &Path| p.to_string_lossy().into_owned();
        recent(
            &config,
            json!({ format!("{SERVER}#agent-a"): [s(&home), "/", s(&link), s(&base.join("Users")), s(&code)] }),
        );
        // Offered: only the folder that confines something.
        let offered: Vec<String> = shared_folders_for(&config, &home, SERVER)
            .into_iter()
            .map(|f| f.path)
            .collect();
        assert_eq!(offered, vec![s(&code)]);
        let view = shared_roots_view(&config, &home, SERVER, Vec::new());
        // The home folder, `/` and `Users` (the link is the home folder, listed once).
        assert_eq!(view.refused.len(), 3);
        // The next save drops them, and says which.
        let dropped =
            set_shared_roots_at(&config, &home, SERVER, Some(view.roots.clone())).unwrap();
        assert_eq!(dropped.len(), 3);
        assert_eq!(shared_roots_at(&config, SERVER).roots, vec![s(&code)]);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn clone_urls_carry_no_credentials_and_reach_no_private_address() {
        for good in [
            "https://8.8.8.8/acme/app.git",
            "https://172.32.0.1/acme/app.git",
            "https://token@github.com/acme/app.git",
        ] {
            assert!(clone_url_ok(good), "{good}");
        }
        for bad in [
            "https://user:secret@github.com/acme/app.git",
            "ssh://git:pw@github.com/acme/app.git",
            "https://-oProxyCommand@github.com/acme/app.git",
            "ssh://-oProxyCommand=x@github.com/acme/app.git",
            "-u@github.com:acme/app.git",
            "https://localhost/acme/app.git",
            "https://127.0.0.1/acme/app.git",
            "https://[::1]/acme/app.git",
            "https://0.0.0.0/acme/app.git",
            "https://10.0.0.5/acme/app.git",
            "https://172.16.0.1/acme/app.git",
            "https://192.168.1.2/acme/app.git",
            "https://169.254.169.254/acme/app.git",
            "https://[fe80::1]/acme/app.git",
            "https://[fd00::1]/acme/app.git",
            "https://2130706433/acme/app.git",
            "https://0x7f000001/acme/app.git",
            "git@10.1.2.3:acme/app.git",
            "ssh://git@192.168.0.4/acme/app.git",
        ] {
            assert!(!clone_url_ok(bad), "{bad}");
        }
    }

    #[test]
    fn spotlight_answers_obey_the_depth_and_repository_rules() {
        let base = scratch_dir("node-folders-spotlight-rules");
        let config = base.join("config");
        let home = base.join("home");
        let docs = home.join("Documents");
        fs::create_dir_all(&config).unwrap();
        let deep = docs.join("a/b/c/d/e/widget");
        let in_repo = docs.join("repo").join("sub").join("widget");
        let fine = docs.join("x").join("widget");
        for d in [&deep, &in_repo, &fine] {
            fs::create_dir_all(d).unwrap();
        }
        repo(&docs.join("repo"), None);
        search_roots(&config, &[&docs]);
        let (d, r, f) = (deep.clone(), in_repo.clone(), fine.clone());
        let spotlight = move |_: &str, _: &[PathBuf]| {
            vec![
                d.to_string_lossy().into_owned(),
                r.to_string_lossy().into_owned(),
                f.to_string_lossy().into_owned(),
            ]
        };
        let answer = lookup_folders_at(
            &config,
            SERVER,
            &home,
            "widget",
            &spotlight,
            &CandidateTokens::default(),
        );
        let paths: Vec<String> = answer.candidates.into_iter().map(|c| c.path).collect();
        assert_eq!(paths, vec![fine.to_string_lossy().into_owned()]);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn candidates_outside_home_read_from_their_root_and_names_carry_no_bidi() {
        let base = scratch_dir("node-folders-display");
        let config = base.join("config");
        let home = base.join("home");
        let volume = base.join("Volumes").join("Data");
        let outside = volume.join("work").join("widget");
        let tricky = home.join("code").join("widget\u{202E}gpj.exe");
        for d in [&config, &outside, &tricky] {
            fs::create_dir_all(d).unwrap();
        }
        search_roots(&config, &[&volume, &home.join("code")]);
        let answer = lookup_folders_at(
            &config,
            SERVER,
            &home,
            "widget",
            &no_spotlight,
            &CandidateTokens::default(),
        );
        let outside_c = answer
            .candidates
            .iter()
            .find(|c| c.path == outside.to_string_lossy())
            .unwrap();
        assert_eq!(outside_c.display, "Data/work/widget");
        assert!(!outside_c.display.contains(&*base.to_string_lossy()));
        let tricky_c = answer
            .candidates
            .iter()
            .find(|c| c.path == tricky.to_string_lossy())
            .unwrap();
        assert_eq!(tricky_c.name, "widgetgpj.exe");
        assert!(!tricky_c.display.contains('\u{202E}'));
        // The names the node advertises too.
        set_shared_roots_at(
            &config,
            &home,
            SERVER,
            Some(vec![tricky.to_string_lossy().into_owned()]),
        )
        .unwrap();
        assert_eq!(
            shared_folders_for(&config, &home, SERVER)[0].name,
            "widgetgpj.exe"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_lookup_out_of_time_says_its_answer_is_partial() {
        let base = scratch_dir("node-folders-partial");
        let config = base.join("config");
        let home = base.join("home");
        let docs = home.join("Documents");
        fs::create_dir_all(docs.join("a").join("widget")).unwrap();
        fs::create_dir_all(&config).unwrap();
        search_roots(&config, &[&docs]);
        let tokens = CandidateTokens::default();
        let full = lookup_folders_within(
            &config,
            SERVER,
            &home,
            "widget",
            &no_spotlight,
            &tokens,
            LOOKUP_TIME,
        );
        assert!(!full.partial);
        assert_eq!(full.candidates.len(), 1);
        let cut = lookup_folders_within(
            &config,
            SERVER,
            &home,
            "widget",
            &no_spotlight,
            &tokens,
            std::time::Duration::ZERO,
        );
        assert!(cut.partial);
        assert!(cut.candidates.is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn stale_clone_folders_are_removed_and_nothing_else() {
        let base = scratch_dir("node-folders-stale-clones");
        let config = base.join("config");
        let home = base.join("home");
        let repos = home.join(crate::node_job::NODE_ROOT_NAME).join("repos");
        for d in [
            &config,
            &repos.join(".clone-0011").join(".git"),
            &repos.join("app").join(".git"),
        ] {
            fs::create_dir_all(d).unwrap();
        }
        assert_eq!(clean_stale_clones_at(&config, &home), 1);
        assert!(!repos.join(".clone-0011").exists());
        assert!(repos.join("app").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn a_clone_growing_past_the_size_limit_is_stopped() {
        let base = scratch_dir("node-folders-size-guard");
        let watched = base.join("clone");
        let mut command = std::process::Command::new("/bin/sh");
        command.arg("-c").arg(format!(
            "mkdir -p '{0}' && head -c 400000 /dev/zero > '{0}/big' && sleep 20",
            watched.display()
        ));
        let started = std::time::Instant::now();
        let outcome = run_guarded(
            command,
            &watched,
            100_000,
            std::time::Duration::from_secs(30),
        );
        assert_eq!(outcome, Err(CLONE_TOO_LARGE));
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        // Under the limit and quick: fine.
        let mut ok = std::process::Command::new("/bin/sh");
        ok.arg("-c").arg("true");
        assert_eq!(
            run_guarded(
                ok,
                &watched,
                100_000_000,
                std::time::Duration::from_secs(30)
            ),
            Ok(())
        );
        // The limit is the node's setting, 2 GB by default.
        let config = base.join("config");
        fs::create_dir_all(&config).unwrap();
        assert_eq!(clone_max_bytes(&config), CLONE_MAX_BYTES_DEFAULT);
        fs::write(
            config.join(NODE_SETTINGS_FILE),
            r#"{"cloneMaxBytes": 5000000}"#,
        )
        .unwrap();
        assert_eq!(clone_max_bytes(&config), 5_000_000);
        let _ = fs::remove_dir_all(&base);
    }

    /// `~/Documents` moved to another disk and linked back (the macOS way),
    /// an XDG link on Linux, a junction on Windows: the lookup follows it,
    /// shows the folder the way the person reaches it, asks the OS index
    /// where it really is, and the find can be shared.
    /// A scratch folder that reads as another disk would (`/Volumes/…`): not
    /// under a system folder. The OS temp folder on macOS is under `/private`,
    /// which the lookup rightly never walks, so there it is a folder in
    /// `/Users/Shared` (removed by the test); elsewhere the temp folder.
    fn disk_scratch_dir(name: &str) -> PathBuf {
        if cfg!(target_os = "macos") {
            let dir = PathBuf::from("/Users/Shared")
                .join(format!("liaison-test-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("a scratch folder in /Users/Shared");
            return fs::canonicalize(&dir).unwrap_or(dir);
        }
        scratch_dir(name)
    }

    #[cfg(unix)]
    #[test]
    fn lookup_follows_a_link_to_another_disk_and_shares_what_it_finds() {
        let base = disk_scratch_dir("node-folders-link-volume");
        let config = base.join("config");
        let home = base.join("Users").join("owner");
        let volume_docs = base
            .join("Volumes")
            .join("Data")
            .join("owner")
            .join("Documents");
        let real_repo = volume_docs.join("liaison-monorepo");
        repo(&real_repo, Some("main"));
        fs::create_dir_all(&config).unwrap();
        fs::create_dir_all(&home).unwrap();
        std::os::unix::fs::symlink(&volume_docs, home.join("Documents")).unwrap();
        search_roots(&config, &[&home]);
        let asked = std::cell::RefCell::new(Vec::<PathBuf>::new());
        let spotlight = |_: &str, roots: &[PathBuf]| {
            asked.borrow_mut().extend(roots.iter().cloned());
            Vec::new()
        };
        let tokens = CandidateTokens::default();
        let answer = lookup_folders_at(
            &config,
            SERVER,
            &home,
            "liaison-monorepo",
            &spotlight,
            &tokens,
        );
        assert!(!answer.partial);
        assert_eq!(answer.candidates.len(), 1, "{answer:?}");
        let found = &answer.candidates[0];
        assert_eq!(found.display, "~/Documents/liaison-monorepo");
        assert_eq!(
            found.path,
            home.join("Documents/liaison-monorepo").to_string_lossy()
        );
        assert!(found.is_repo && found.shareable && !found.shared);
        // The OS index indexes where folders are, not the links to them.
        let real_docs = fs::canonicalize(&volume_docs).unwrap();
        assert!(asked.borrow().contains(&real_docs), "{:?}", asked.borrow());
        // The OS index's own answer (the real path) reads the same.
        let r = real_repo.clone();
        let by_index = move |_: &str, _: &[PathBuf]| vec![r.to_string_lossy().into_owned()];
        let indexed = lookup_folders_within(
            &config,
            SERVER,
            &home,
            "liaison-monorepo",
            &by_index,
            &tokens,
            std::time::Duration::ZERO,
        );
        assert_eq!(indexed.candidates.len(), 1, "{indexed:?}");
        assert_eq!(
            indexed.candidates[0].display,
            "~/Documents/liaison-monorepo"
        );
        // Shared by its proof, under the path the person knows.
        let shared = share_at(&config, &home, SERVER, &tokens, Some(&found.token), None).unwrap();
        assert_eq!(shared, home.join("Documents/liaison-monorepo"));
        let names: Vec<String> = shared_folders_for(&config, &home, SERVER)
            .into_iter()
            .map(|f| f.name)
            .collect();
        assert_eq!(names, vec!["liaison-monorepo".to_string()]);
        let _ = fs::remove_dir_all(&base);
    }

    /// Links that loop, lead back to the home folder or above, or into a
    /// hidden folder are never walked; a link that leads to a folder already
    /// walked is not walked twice; a dangling one is nothing.
    #[cfg(unix)]
    #[test]
    fn lookup_never_loops_and_never_follows_a_link_home_or_into_hidden() {
        let base = scratch_dir("node-folders-link-loops");
        let config = base.join("config");
        let home = base.join("Users").join("owner");
        let code = home.join("code");
        fs::create_dir_all(code.join("widget")).unwrap();
        fs::create_dir_all(home.join(".secret").join("widget")).unwrap();
        fs::create_dir_all(&config).unwrap();
        let link = |to: &Path, at: PathBuf| std::os::unix::fs::symlink(to, at).unwrap();
        link(&code, code.join("again"));
        link(&home, code.join("home"));
        link(&base, home.join("up"));
        link(&home.join(".secret"), home.join("plain"));
        link(&code, home.join("code-link"));
        link(&base.join("nowhere"), home.join("dangling"));
        // The node's own session worktrees are never offered.
        repo(
            &home
                .join(crate::node_job::NODE_ROOT_NAME)
                .join("worktrees")
                .join("widget"),
            None,
        );
        search_roots(&config, &[&home]);
        let answer = lookup_folders_at(
            &config,
            SERVER,
            &home,
            "widget",
            &no_spotlight,
            &CandidateTokens::default(),
        );
        assert!(!answer.partial);
        let paths: Vec<String> = answer.candidates.into_iter().map(|f| f.path).collect();
        assert_eq!(
            paths,
            vec![code.join("widget").to_string_lossy().into_owned()]
        );
        let _ = fs::remove_dir_all(&base);
    }

    /// A folder the OS will not let Liaison read is named, never a silent
    /// "not found", and the search roots view says it too.
    #[cfg(unix)]
    #[test]
    fn a_folder_the_os_refuses_is_named_in_the_answer_and_the_view() {
        use std::os::unix::fs::PermissionsExt;
        let base = scratch_dir("node-folders-denied");
        let config = base.join("config");
        let home = base.join("Users").join("owner");
        let locked = home.join("Documents");
        fs::create_dir_all(locked.join("widget")).unwrap();
        fs::create_dir_all(&config).unwrap();
        search_roots(&config, &[&home]);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        // Root reads everything: nothing to observe then.
        if fs::read_dir(&locked).is_ok() {
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
            let _ = fs::remove_dir_all(&base);
            return;
        }
        let answer = lookup_folders_at(
            &config,
            SERVER,
            &home,
            "widget",
            &no_spotlight,
            &CandidateTokens::default(),
        );
        let view = search_roots_view(&config, &home);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(answer.candidates.is_empty());
        assert_eq!(answer.denied, vec!["~/Documents".to_string()]);
        assert_eq!(view.denied, vec!["~/Documents".to_string()]);
        assert!(view.missing.is_empty());
        // Allowed again: nothing is named any more.
        assert!(search_roots_view(&config, &home).denied.is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    /// One large search root never starves the next one: every root is
    /// walked level by level together.
    #[test]
    fn a_large_root_never_starves_the_next() {
        let base = scratch_dir("node-folders-fair");
        let config = base.join("config");
        let home = base.join("home");
        let big = home.join("big");
        let small = home.join("small");
        for i in 0..300 {
            fs::create_dir_all(big.join(format!("d{i:03}")).join("x").join("y")).unwrap();
        }
        fs::create_dir_all(small.join("widget")).unwrap();
        fs::create_dir_all(&config).unwrap();
        search_roots(&config, &[&big, &small]);
        let mut budget = 310;
        let roots = vec![
            fs::canonicalize(&big).unwrap(),
            fs::canonicalize(&small).unwrap(),
        ];
        let real_home = fs::canonicalize(&home).unwrap();
        let far = std::time::Instant::now() + std::time::Duration::from_secs(60);
        let walk = walk_roots(&roots, &real_home, &|p: &Path| match_rank(&basename(p), "widget"), LOOKUP_DEPTH, &mut budget, far, false);
        assert!(!walk.complete, "the budget ran out");
        assert_eq!(
            walk.found.len(),
            1,
            "the small root was walked at its first level"
        );
        let _ = fs::remove_dir_all(&base);
    }

    // ─── Scan, shareMany, remotes (session import S1-S5, S17) ─────────────

    fn settings(config: &Path, doc: serde_json::Value) {
        fs::write(config.join(NODE_SETTINGS_FILE), serde_json::to_vec(&doc).unwrap()).unwrap();
    }

    fn repo_with_origin(path: &Path, origin: &str) {
        repo(path, None);
        fs::write(
            path.join(".git/config"),
            format!(
                "[core]\n\tbare = false\n[remote \"upstream\"]\n\turl = https://github.com/else/where.git\n[remote \"origin\"]\n\turl = {origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n"
            ),
        )
        .unwrap();
    }

    #[test]
    fn scan_finds_nested_repos_never_inside_one_and_tokens_only_what_it_may_share() {
        let base = scratch_dir("node-folders-scan");
        let config = base.join("config");
        let home = base.join("home");
        let code = home.join("code");
        fs::create_dir_all(&config).unwrap();
        let top = code.join("app");
        repo(&top, Some("main"));
        // Inside a repository: never walked.
        repo(&top.join("packages").join("inner"), None);
        // Six levels down (code is the root): found; seven: not walked.
        let deep = code.join("a/b/c/d/e/deep");
        repo(&deep, None);
        repo(&code.join("a/b/c/d/e/f/deeper"), None);
        // Skipped and hidden folders are never entered.
        repo(&code.join("node_modules").join("dep"), None);
        repo(&code.join(".cache").join("tool"), None);
        // Already shared: listed, checked, no token.
        let shared_one = code.join("shared-one");
        repo(&shared_one, None);
        // The node's own session worktrees: never.
        repo(&home.join(crate::node_job::NODE_ROOT_NAME).join("worktrees").join("wt"), None);
        settings(
            &config,
            json!({
                "searchRoots": [code.to_string_lossy(), home.to_string_lossy()],
                "sharedRoots": [shared_one.to_string_lossy()],
            }),
        );
        let tokens = CandidateTokens::default();
        let answer = scan_repos_at(&config, SERVER, &home, &tokens);
        assert_eq!(answer.search_roots, 2);
        assert!(!answer.partial);
        let shown: Vec<&str> = answer.candidates.iter().map(|c| c.display.as_str()).collect();
        assert_eq!(shown, vec!["~/code/a/b/c/d/e/deep", "~/code/app", "~/code/shared-one"]);
        let app = &answer.candidates[1];
        assert_eq!(app.name, "app");
        assert!(app.shareable && !app.shared && app.refusal.is_none());
        let token = app.token.clone().expect("a token for a folder it may share");
        assert!(token_shaped(&token));
        let shared = &answer.candidates[2];
        assert!(shared.shared && !shared.shareable && shared.token.is_none() && shared.refusal.is_none());
        // The answer's JSON is the shared shape.
        let v = serde_json::to_value(&answer).unwrap();
        assert_eq!(v["searchRoots"], 2);
        assert_eq!(v["skippedProtected"], false);
        assert_eq!(v["candidates"][2]["token"], serde_json::Value::Null);
        assert_eq!(v["candidates"][2]["refusal"], serde_json::Value::Null);
        // The token shares what was found, once.
        share_at(&config, &home, SERVER, &tokens, Some(&token), None).unwrap();
        assert_eq!(
            share_at(&config, &home, SERVER, &tokens, Some(&token), None),
            Err(SHARE_NOT_ISSUED)
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_scan_out_of_budget_says_its_answer_is_partial() {
        let base = scratch_dir("node-folders-scan-budget");
        let config = base.join("config");
        let home = base.join("home");
        let code = home.join("code");
        fs::create_dir_all(&config).unwrap();
        for i in 0..5 {
            repo(&code.join(format!("r{i}")), None);
        }
        settings(&config, json!({ "searchRoots": [code.to_string_lossy()] }));
        let tokens = CandidateTokens::default();
        let full = scan_repos_within(&config, SERVER, &home, &tokens, SCAN_TIME, SCAN_VISIT_BUDGET);
        assert_eq!((full.candidates.len(), full.partial), (5, false));
        let short = scan_repos_within(&config, SERVER, &home, &tokens, SCAN_TIME, 2);
        assert!(short.partial);
        assert!(short.candidates.len() <= 2);
        let late = scan_repos_within(&config, SERVER, &home, &tokens, std::time::Duration::ZERO, SCAN_VISIT_BUDGET);
        assert!(late.partial);
        // No search roots: nothing walked.
        settings(&config, json!({ "searchRoots": [] }));
        let none = scan_repos_at(&config, SERVER, &home, &tokens);
        assert_eq!((none.search_roots, none.candidates.len(), none.partial), (0, 0, false));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn shareability_names_the_reason_and_changes_nothing_share_path_ok_decides() {
        let base = scratch_dir("node-folders-shareability");
        let config = base.join("config");
        let home = base.join("home");
        let docs = home.join("Documents");
        for d in [&config, &docs.join("proj"), &home.join(".secret/proj"), &home.join("loose")] {
            fs::create_dir_all(d).unwrap();
        }
        search_roots(&config, &[&docs]);
        let of = |p: &Path| shareability(&config, &home, SERVER, p);
        assert!(matches!(of(&docs.join("proj")), Shareability::Ok(_)));
        assert_eq!(of(&home), Shareability::Refused(REFUSAL_HOME));
        assert_eq!(of(&home.join(".secret/proj")), Shareability::Refused(REFUSAL_HIDDEN));
        assert_eq!(of(&home.join("loose")), Shareability::Refused(REFUSAL_OUTSIDE));
        assert_eq!(of(&docs.join("gone")), Shareability::Missing);
        for p in [docs.join("proj"), home.clone(), home.join(".secret/proj"), home.join("loose")] {
            assert_eq!(
                matches!(of(&p), Shareability::Ok(_)),
                share_path_ok(&config, &home, SERVER, &p).is_ok()
            );
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn share_many_shares_every_accepted_token_in_one_change_and_names_the_refused() {
        let base = scratch_dir("node-folders-share-many");
        let config = base.join("config");
        let home = base.join("home");
        let code = home.join("code");
        fs::create_dir_all(&config).unwrap();
        for n in ["one", "two", "three"] {
            repo(&code.join(n), None);
        }
        let loose = home.join("loose");
        fs::create_dir_all(&loose).unwrap();
        settings(&config, json!({ "searchRoots": [code.to_string_lossy()] }));
        let tokens = CandidateTokens::default();
        let scan = scan_repos_at(&config, SERVER, &home, &tokens);
        let by_name = |n: &str| {
            scan.candidates.iter().find(|c| c.name == n).and_then(|c| c.token.clone()).unwrap()
        };
        let t: Vec<String> = vec![by_name("one"), by_name("two"), by_name("three")];
        // A proof for a folder the node would not share: refused by the check.
        let outside = tokens.issue(&loose);
        // Used before: refused.
        assert!(tokens.take(&t[2]).is_some());
        let asked = vec![
            t[0].clone(),
            t[1].clone(),
            t[0].clone(),
            t[2].clone(),
            "f".repeat(32),
            "not-a-token".into(),
            outside.clone(),
        ];
        let answer = share_many_at(&config, &home, SERVER, &tokens, &asked).unwrap();
        let roots: Vec<String> = answer
            .roots
            .roots
            .iter()
            .map(|r| basename(Path::new(r)))
            .collect();
        assert_eq!(roots, vec!["one", "two"]);
        assert_eq!(
            answer.refused,
            vec![
                ShareRefused { token: t[2].clone(), code: SHARE_NOT_ISSUED },
                ShareRefused { token: "f".repeat(32), code: SHARE_NOT_ISSUED },
                ShareRefused { token: "not-a-token".into(), code: SHARE_NOT_ISSUED },
                ShareRefused { token: outside, code: SHARE_OUTSIDE },
            ]
        );
        let v = serde_json::to_value(&answer).unwrap();
        assert!(v["roots"].is_array() && v["refused"].is_array() && v["isDefault"] == false);
        // Nothing to share: no change, refusals only.
        let again = share_many_at(&config, &home, SERVER, &tokens, &[t[0].clone()]).unwrap();
        assert_eq!(again.roots.roots.len(), 2);
        assert_eq!(again.refused.len(), 1);
        // 0 or more than 100 tokens: refused whole.
        assert_eq!(share_many_at(&config, &home, SERVER, &tokens, &[]), Err(SHARE_NOT_ISSUED));
        let many: Vec<String> = (0..101).map(|i| format!("{i:032x}")).collect();
        assert_eq!(share_many_at(&config, &home, SERVER, &tokens, &many), Err(SHARE_NOT_ISSUED));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn share_many_checks_the_folder_limit_before_using_any_token() {
        let base = scratch_dir("node-folders-share-many-full");
        let config = base.join("config");
        let home = base.join("home");
        let big = home.join("big");
        let code = home.join("code");
        fs::create_dir_all(&config).unwrap();
        // The root and its repositories fill the limit.
        for i in 0..SHARED_FOLDERS_LIMIT - 1 {
            fs::create_dir_all(big.join(format!("r{i:03}")).join(".git")).unwrap();
        }
        repo(&code.join("next"), None);
        settings(
            &config,
            json!({ "searchRoots": [code.to_string_lossy()], "sharedRoots": [big.to_string_lossy()] }),
        );
        assert_eq!(shared_folders_for(&config, &home, SERVER).len(), SHARED_FOLDERS_LIMIT);
        let tokens = CandidateTokens::default();
        let scan = scan_repos_at(&config, SERVER, &home, &tokens);
        let token = scan.candidates[0].token.clone().unwrap();
        assert_eq!(
            share_many_at(&config, &home, SERVER, &tokens, &[token.clone()]),
            Err(SHARED_ROOTS_FULL)
        );
        // The token was not used.
        assert!(tokens.take(&token).is_some());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn candidate_tokens_keep_four_thousand() {
        let tokens = CandidateTokens::default();
        let first = tokens.issue(Path::new("/x/first"));
        for i in 0..CANDIDATE_TOKENS_MAX - 1 {
            tokens.issue(&PathBuf::from(format!("/x/{i}")));
        }
        assert_eq!(tokens.take(&first), Some(PathBuf::from("/x/first")));
        let second = tokens.issue(Path::new("/x/second"));
        for i in 0..CANDIDATE_TOKENS_MAX {
            tokens.issue(&PathBuf::from(format!("/y/{i}")));
        }
        assert_eq!(tokens.take(&second), None);
    }

    #[test]
    fn remote_urls_normalize_to_host_owner_name() {
        let key = Some("github.com/acme/widget".to_string());
        for url in [
            "https://github.com/acme/widget",
            "https://github.com/acme/widget.git",
            "https://github.com/Acme/Widget.git/",
            "HTTPS://GitHub.com/acme/widget",
            "ssh://git@github.com/acme/widget.git",
            "ssh://git@github.com:22/acme/widget",
            "git@github.com:acme/widget.git",
            "git@github.com:acme/widget/",
            "https://user:secret@github.com/acme/widget.git",
            "https://ghp_abcdef@github.com/acme/widget",
        ] {
            assert_eq!(remote_key(url), key, "{url}");
        }
        assert_eq!(
            remote_key("https://gitlab.com/group/sub/proj.git"),
            Some("gitlab.com/group/sub/proj".into())
        );
        for bad in ["", "widget", "/local/path/repo", "https://github.com/", "https://github.com/only", "git@github.com:../x"] {
            assert_eq!(remote_key(bad), None, "{bad}");
        }
        assert_ne!(remote_key("https://github.com/acme/widget"), remote_key("https://gitlab.com/acme/widget"));
    }

    #[test]
    fn origin_is_read_from_a_real_git_folder_only() {
        let base = scratch_dir("node-folders-origin");
        let a = base.join("a");
        repo_with_origin(&a, "git@github.com:acme/a.git");
        assert_eq!(origin_url(&a).as_deref(), Some("git@github.com:acme/a.git"));
        // A worktree's or submodule's `.git` file: not matched.
        let wt = base.join("wt");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), "gitdir: /elsewhere\n").unwrap();
        assert_eq!(origin_url(&wt), None);
        // A `.git` that is a link: not read.
        #[cfg(unix)]
        {
            let linked = base.join("linked");
            fs::create_dir_all(&linked).unwrap();
            std::os::unix::fs::symlink(a.join(".git"), linked.join(".git")).unwrap();
            assert_eq!(origin_url(&linked), None);
        }
        // Too large a config: not read.
        let big = base.join("big");
        repo(&big, None);
        let mut text = String::from("[remote \"origin\"]\n\turl = https://github.com/acme/big\n");
        text.push_str(&"#".repeat(GIT_CONFIG_MAX as usize));
        fs::write(big.join(".git/config"), text).unwrap();
        assert_eq!(origin_url(&big), None);
        // No origin: none.
        let plain = base.join("plain");
        repo(&plain, None);
        fs::write(plain.join(".git/config"), "[remote \"fork\"]\n\turl = https://github.com/x/y\n").unwrap();
        assert_eq!(origin_url(&plain), None);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn clone_urls_in_an_answer_carry_no_login() {
        assert_eq!(
            safe_clone_url("https://u:p@github.com/acme/w.git").as_deref(),
            Some("https://github.com/acme/w.git")
        );
        assert_eq!(
            safe_clone_url("https://oauth2:glpat-xyz@gitlab.com/g/p.git").as_deref(),
            Some("https://gitlab.com/g/p.git")
        );
        assert_eq!(safe_clone_url("git@github.com:acme/w.git").as_deref(), Some("git@github.com:acme/w.git"));
        assert_eq!(safe_clone_url("ssh://git@gitlab.com/g/p.git").as_deref(), Some("ssh://git@gitlab.com/g/p.git"));
        for bad in [
            "ghs_x@github.com:acme/w.git",
            "ssh://gho_abc@github.com/acme/w.git",
            "file:///etc/passwd",
            "ext::sh -c id",
            "https://127.0.0.1/acme/w.git",
            "https://github.com/ghp_x/w.git",
        ] {
            assert_eq!(safe_clone_url(bad), None, "{bad}");
        }
    }

    #[test]
    fn iso_times_read_as_epoch_millis() {
        assert_eq!(iso_millis("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_millis("2026-10-21T12:00:00Z"), Some(1_792_584_000_000));
        assert_eq!(iso_millis("2026-10-21T12:00:00.250Z"), Some(1_792_584_000_250));
        assert_eq!(iso_millis("2026-10-21T14:00:00.000+02:00"), Some(1_792_584_000_000));
        assert_eq!(iso_millis("yesterday"), None);
        assert_eq!(iso_millis("2026-13-01T00:00:00Z"), None);
    }

    /// The tools as a test sees them: which exist, and the answer to each
    /// command line (`"gh auth status --hostname github.com"`).
    struct FakeTools {
        tools: Vec<&'static str>,
        answers: std::collections::HashMap<String, ToolRun>,
        calls: std::cell::RefCell<Vec<String>>,
    }

    impl FakeTools {
        fn new(tools: &[&'static str]) -> Self {
            FakeTools {
                tools: tools.to_vec(),
                answers: Default::default(),
                calls: Default::default(),
            }
        }
        fn answer(mut self, line: &str, run: ToolRun) -> Self {
            self.answers.insert(line.to_string(), run);
            self
        }
    }

    impl ToolRunner for FakeTools {
        fn locate(&self, tool: &str) -> Option<PathBuf> {
            self.tools
                .contains(&tool)
                .then(|| PathBuf::from(format!("/fake/bin/{tool}")))
        }
        fn run(&self, program: &Path, args: &[String], timeout: std::time::Duration) -> ToolRun {
            assert!(timeout <= TOOL_TIMEOUT && !timeout.is_zero());
            let line = format!("{} {}", basename(program), args.join(" "));
            self.calls.borrow_mut().push(line.clone());
            self.answers.get(&line).cloned().unwrap_or(ToolRun::Exit)
        }
    }

    const GH_STATUS: &str = "gh auth status --hostname github.com";
    const GH_PROTOCOL: &str = "gh config get git_protocol -h github.com";
    const GLAB_STATUS: &str = "glab auth status";
    const GLAB_PROTOCOL: &str = "glab config get git_protocol";

    fn gh_page(n: usize) -> String {
        format!("gh api --hostname github.com user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page={n}")
    }

    fn glab_page(n: usize) -> String {
        format!("glab api projects?membership=true&order_by=last_activity_at&per_page=100&page={n}")
    }

    fn gh_item(name: &str, private: bool) -> serde_json::Value {
        json!({
            "full_name": format!("acme/{name}"),
            "clone_url": format!("https://github.com/acme/{name}.git"),
            "ssh_url": format!("git@github.com:acme/{name}.git"),
            "private": private,
            "pushed_at": "2026-10-21T12:00:00Z",
        })
    }

    fn json_run(v: serde_json::Value) -> ToolRun {
        ToolRun::Ok(serde_json::to_vec(&v).unwrap())
    }

    fn far() -> std::time::Instant {
        std::time::Instant::now() + REMOTES_TIME
    }

    #[test]
    fn remotes_lists_gh_marks_local_clones_and_says_glab_is_missing() {
        let base = scratch_dir("node-folders-remotes");
        let config = base.join("config");
        let home = base.join("home");
        let code = home.join("code");
        fs::create_dir_all(&config).unwrap();
        let shared_clone = home.join("work").join("widget");
        repo_with_origin(&shared_clone, "git@github.com:acme/widget.git");
        let local_clone = code.join("gadget");
        repo_with_origin(&local_clone, "https://github.com/Acme/Gadget");
        // A second clone of widget, not shared: the shared one wins.
        repo_with_origin(&code.join("widget-copy"), "https://github.com/acme/widget.git");
        settings(
            &config,
            json!({
                "searchRoots": [code.to_string_lossy()],
                "sharedRoots": [shared_clone.to_string_lossy()],
            }),
        );
        let tools = FakeTools::new(&["gh"])
            .answer(GH_STATUS, ToolRun::Ok(b"Logged in to github.com".to_vec()))
            .answer(GH_PROTOCOL, ToolRun::Ok(b"https\n".to_vec()))
            .answer(
                &gh_page(1),
                json_run(json!([
                    gh_item("widget", true),
                    gh_item("gadget", false),
                    gh_item("remote-only", false),
                    { "full_name": "acme/bad", "clone_url": "file:///etc/x", "private": false },
                ])),
            );
        let tokens = CandidateTokens::default();
        let answer = remotes_at(&config, SERVER, &home, &tools, &tokens, SCAN_TIME, far());
        assert_eq!(
            answer.sources,
            vec![
                RemoteSource { tool: "gh", state: "ok" },
                RemoteSource { tool: "glab", state: "missing" },
            ]
        );
        assert_eq!(answer.dropped, 1);
        let names: Vec<&str> = answer.repos.iter().map(|r| r.full_name.as_str()).collect();
        assert_eq!(names, vec!["acme/widget", "acme/gadget", "acme/remote-only"]);
        let widget = &answer.repos[0];
        assert_eq!((widget.source, widget.host.as_str(), widget.private), ("github", "github.com", true));
        assert_eq!(widget.clone_url, "https://github.com/acme/widget.git");
        assert_eq!(widget.pushed_at, Some(1_792_584_000_000));
        assert_eq!(
            widget.local,
            Some(RemoteLocal { display: "~/work/widget".into(), shared: true, token: None })
        );
        let gadget = answer.repos[1].local.clone().unwrap();
        assert_eq!((gadget.display.as_str(), gadget.shared), ("~/code/gadget", false));
        let token = gadget.token.unwrap();
        assert_eq!(tokens.take(&token).map(|p| fs::canonicalize(p).unwrap()), Some(fs::canonicalize(&local_clone).unwrap()));
        assert_eq!(answer.repos[2].local, None);
        // Exactly these command lines, one page (a short one), nothing else.
        assert_eq!(*tools.calls.borrow(), vec![GH_STATUS.to_string(), GH_PROTOCOL.to_string(), gh_page(1)]);
        let v = serde_json::to_value(&answer).unwrap();
        assert_eq!(v["repos"][0]["fullName"], "acme/widget");
        assert_eq!(v["repos"][0]["cloneUrl"], "https://github.com/acme/widget.git");
        assert_eq!(v["repos"][0]["pushedAt"], 1_792_584_000_000i64);
        assert!(!v.to_string().contains(&base.to_string_lossy().into_owned()));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn remotes_signed_out_failed_pages_ssh_protocol_and_the_deadline() {
        let base = scratch_dir("node-folders-remotes-states");
        let config = base.join("config");
        let home = base.join("home");
        fs::create_dir_all(&config).unwrap();
        settings(&config, json!({ "searchRoots": [] }));
        let tokens = CandidateTokens::default();
        // gh signed out; glab signed in with ssh, page 1 full and page 2 failing.
        let full: Vec<serde_json::Value> = (0..100)
            .map(|i| {
                json!({
                    "path_with_namespace": format!("group/p{i}"),
                    "http_url_to_repo": format!("https://gitlab.com/group/p{i}.git"),
                    "ssh_url_to_repo": format!("git@gitlab.com:group/p{i}.git"),
                    "visibility": if i == 0 { "public" } else { "private" },
                    "last_activity_at": "2026-10-21T12:00:00.000Z",
                })
            })
            .collect();
        let tools = FakeTools::new(&["gh", "glab"])
            .answer(GLAB_STATUS, ToolRun::Ok(Vec::new()))
            .answer(GLAB_PROTOCOL, ToolRun::Ok(b"ssh".to_vec()))
            .answer(&glab_page(1), json_run(serde_json::Value::Array(full)))
            .answer(&glab_page(2), ToolRun::Timeout);
        let answer = remotes_at(&config, SERVER, &home, &tools, &tokens, SCAN_TIME, far());
        assert_eq!(
            answer.sources,
            vec![
                RemoteSource { tool: "gh", state: "signed_out" },
                RemoteSource { tool: "glab", state: "ok" },
            ]
        );
        assert_eq!(answer.repos.len(), 100);
        assert_eq!(answer.repos[0].source, "gitlab");
        assert!(!answer.repos[0].private && answer.repos[1].private);
        assert_eq!(answer.repos[0].clone_url, "git@gitlab.com:group/p0.git");
        assert_eq!(answer.repos[0].host, "gitlab.com");
        // gh's page 1 failing is a failed source.
        let tools = FakeTools::new(&["gh"])
            .answer(GH_STATUS, ToolRun::Ok(Vec::new()))
            .answer(&gh_page(1), ToolRun::TooLarge);
        let answer = remotes_at(&config, SERVER, &home, &tools, &tokens, SCAN_TIME, far());
        assert_eq!(answer.sources[0], RemoteSource { tool: "gh", state: "failed" });
        assert!(answer.repos.is_empty());
        // Past the overall deadline: no tool runs, the source is failed.
        let tools = FakeTools::new(&["gh", "glab"]);
        let answer = remotes_at(&config, SERVER, &home, &tools, &tokens, SCAN_TIME, std::time::Instant::now());
        assert_eq!(
            answer.sources,
            vec![
                RemoteSource { tool: "gh", state: "failed" },
                RemoteSource { tool: "glab", state: "failed" },
            ]
        );
        assert!(tools.calls.borrow().is_empty());
        // Neither tool: both missing.
        let answer = remotes_at(&config, SERVER, &home, &FakeTools::new(&[]), &tokens, SCAN_TIME, far());
        assert_eq!(answer.sources[0].state, "missing");
        assert_eq!(answer.sources[1].state, "missing");
        let _ = fs::remove_dir_all(&base);
    }

    /// A11, S17: no token or login a tool prints, a host lists or a git
    /// config holds ever reaches an answer.
    #[test]
    fn no_token_or_login_reaches_a_remotes_or_scan_answer() {
        let base = scratch_dir("node-folders-remotes-leak");
        let config = base.join("config");
        let home = base.join("home");
        let code = home.join("code");
        fs::create_dir_all(&config).unwrap();
        repo_with_origin(&code.join("r1"), "https://x:gho_localsecret@github.com/acme/r1.git");
        repo_with_origin(&code.join("r2"), "https://ghp_localsecret@github.com/acme/r2.git");
        repo_with_origin(&code.join("p"), "https://oauth2:glpat-localsecret@gitlab.com/g/p.git");
        settings(&config, json!({ "searchRoots": [code.to_string_lossy()] }));
        let gh = json!([
            { "full_name": "acme/r1", "clone_url": "https://ghp_remote1@github.com/acme/r1.git",
              "ssh_url": "git@github.com:acme/r1.git", "private": true },
            { "full_name": "acme/r2", "clone_url": "https://u:p@github.com/acme/r2.git",
              "ssh_url": "ghs_remote2@github.com:acme/r2.git", "private": true },
            { "full_name": "acme/github_pat_remote3", "clone_url": "https://github.com/acme/r3.git", "private": false },
            { "full_name": "acme/r4", "clone_url": "https://github.com/gho_remote4/r4.git", "private": false },
            { "full_name": "acme/r5", "clone_url": "https://github.com/acme/r5.git", "private": false,
              "token": "ghp_remote5", "oauth_token": "gho_remote5" },
        ]);
        let glab = json!([
            { "path_with_namespace": "g/p", "http_url_to_repo": "https://oauth2:glpat-remote6@gitlab.com/g/p.git",
              "ssh_url_to_repo": "git@gitlab.com:g/p.git", "visibility": "private",
              "runners_token": "glpat-remote7" },
        ]);
        let tools = FakeTools::new(&["gh", "glab"])
            .answer(GH_STATUS, ToolRun::Ok(b"Token: gho_statussecret\noauth_token: gho_statussecret".to_vec()))
            .answer(GH_PROTOCOL, ToolRun::Ok(b"https".to_vec()))
            .answer(&gh_page(1), json_run(gh))
            .answer(GLAB_STATUS, ToolRun::Ok(b"Token: glpat-statussecret".to_vec()))
            .answer(GLAB_PROTOCOL, ToolRun::Ok(b"https".to_vec()))
            .answer(&glab_page(1), json_run(glab));
        let tokens = CandidateTokens::default();
        let answer = remotes_at(&config, SERVER, &home, &tools, &tokens, SCAN_TIME, far());
        let scan = scan_repos_at(&config, SERVER, &home, &tokens);
        let text = format!(
            "{}{}",
            serde_json::to_string(&answer).unwrap(),
            serde_json::to_string(&scan).unwrap()
        );
        for mark in ["ghp_", "github_pat_", "ghs_", "gho_", "glpat-", "oauth_token", "oauth2", "u:p@", "secret", "remote1", "remote5"] {
            assert!(!text.contains(mark), "{mark} reached an answer: {text}");
        }
        // What is safe is still there: the stripped URLs, matched to their clones.
        let names: Vec<&str> = answer.repos.iter().map(|r| r.full_name.as_str()).collect();
        assert_eq!(names, vec!["acme/r1", "acme/r2", "acme/r5", "g/p"]);
        assert_eq!(answer.dropped, 2);
        assert!(answer.repos.iter().filter(|r| r.full_name != "acme/r5").all(|r| r.local.is_some()));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn tools_are_found_in_the_usual_folders_then_absolute_path_entries_only() {
        let base = scratch_dir("node-folders-find-tool");
        let home = base.join("home");
        let local_bin = home.join(".local/bin");
        let on_path = base.join("path-bin");
        fs::create_dir_all(&local_bin).unwrap();
        fs::create_dir_all(&on_path).unwrap();
        let name = "liaison-fake-tool";
        let tool = on_path.join(name);
        fs::write(&tool, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&tool, fs::Permissions::from_mode(0o755)).unwrap();
            let path = std::env::join_paths([PathBuf::from("relative/dir"), on_path.clone()]).unwrap();
            assert_eq!(find_tool(name, &home, Some(&path)), Some(tool.clone()));
            // In ~/.local/bin: found before PATH.
            let mine = local_bin.join(name);
            fs::write(&mine, "#!/bin/sh\n").unwrap();
            fs::set_permissions(&mine, fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(find_tool(name, &home, Some(&path)), Some(mine.clone()));
            // Not executable: not a tool.
            fs::set_permissions(&mine, fs::Permissions::from_mode(0o644)).unwrap();
            assert_eq!(find_tool(name, &home, Some(&path)), Some(tool));
            // Only a relative PATH entry: none.
            let rel = std::env::join_paths([PathBuf::from(".")]).unwrap();
            assert_eq!(find_tool(name, &base, Some(&rel)), None);
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn a_tool_runs_without_stdin_or_stderr_within_its_time_and_size() {
        let sh = Path::new("/bin/sh");
        let cwd = std::env::temp_dir();
        let run = |script: &str, t: u64| {
            run_tool(sh, &["-c".to_string(), script.to_string()], &cwd, std::time::Duration::from_millis(t))
        };
        assert_eq!(run("echo out; echo err >&2", 5000), ToolRun::Ok(b"out\n".to_vec()));
        assert_eq!(
            run("printf %s \"$GH_PROMPT_DISABLED$GH_NO_UPDATE_NOTIFIER$NO_COLOR$GLAB_NO_PROMPT\"", 5000),
            ToolRun::Ok(b"1111".to_vec())
        );
        // stdin is closed: a read ends at once.
        assert_eq!(run("cat; echo done", 5000), ToolRun::Ok(b"done\n".to_vec()));
        assert_eq!(run("exit 3", 5000), ToolRun::Exit);
        assert_eq!(run("sleep 5", 300), ToolRun::Timeout);
        assert_eq!(run("head -c 9000000 /dev/zero", 10_000), ToolRun::TooLarge);
        assert_eq!(
            run_tool(Path::new("/nonexistent/tool"), &[], &cwd, std::time::Duration::from_secs(1)),
            ToolRun::Spawn
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_signed_in_tools_run_from_an_empty_folder_that_is_removed_after() {
        let base = scratch_dir("node-folders-tool-cwd");
        let home = base.join("home");
        fs::create_dir_all(home.join(".git")).unwrap();
        let tools = SystemTools { home: home.clone() };
        let ToolRun::Ok(out) = tools.run(
            Path::new("/bin/sh"),
            &["-c".to_string(), "pwd -P; ls -A | wc -l".to_string()],
            std::time::Duration::from_secs(5),
        ) else {
            panic!("the tool did not run");
        };
        let out = String::from_utf8(out).unwrap();
        let mut lines = out.lines();
        let cwd = PathBuf::from(lines.next().unwrap());
        assert_ne!(cwd, fs::canonicalize(&home).unwrap());
        assert!(!cwd.starts_with(&base), "{cwd:?}");
        assert_eq!(lines.next().unwrap().trim(), "0");
        assert!(!cwd.exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn the_import_sidecar_reads_only_under_search_roots_its_guard_would_refuse() {
        let base = scratch_dir("node-folders-import-roots");
        let config = base.join("config");
        let home = base.join("home");
        let docs = home.join("Documents").join("work");
        let code = home.join("code");
        let disk = base.join("disk");
        for d in [&config, &docs, &code, &disk] {
            fs::create_dir_all(d).unwrap();
        }
        // The implicit default (the home folder without its protected folders).
        assert!(import_search_roots(&config, &home).is_empty());
        settings(
            &config,
            json!({ "searchRoots": ["~", "~/code", docs.to_string_lossy(), disk.to_string_lossy()] }),
        );
        let s = |p: &Path| p.to_string_lossy().into_owned();
        assert_eq!(import_search_roots(&config, &home), vec![s(&home), s(&docs), s(&disk)]);
        settings(&config, json!({ "searchRoots": ["~/code"] }));
        assert!(import_search_roots(&config, &home).is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_live_proof_is_found_without_being_used() {
        let tokens = CandidateTokens::default();
        assert_eq!(tokens.live(Path::new("/x/a")), None);
        let t = tokens.issue(Path::new("/x/a"));
        let _ = tokens.issue_for(Path::new("/x/b"), std::time::Duration::from_secs(0));
        assert_eq!(tokens.live(Path::new("/x/a")), Some(t.clone()));
        assert_eq!(tokens.live(Path::new("/x/b")), None);
        assert_eq!(tokens.take(&t), Some(PathBuf::from("/x/a")));
        assert_eq!(tokens.live(Path::new("/x/a")), None);
    }

    #[test]
    fn an_unshared_session_folder_becomes_a_group_with_a_token_or_a_reason() {
        let base = scratch_dir("node-folders-unshared");
        let config = base.join("config");
        let home = base.join("home");
        let docs = home.join("Documents");
        let code = home.join("code");
        for d in [
            &config,
            &docs.join("notes"),
            &code.join("app"),
            &home.join(".config/tool"),
            &home.join("loose"),
            &home.join(crate::node_job::NODE_ROOT_NAME).join("worktrees/abc"),
            &home.join(crate::node_job::NODE_ROOT_NAME).join("jobs/x"),
        ] {
            fs::create_dir_all(d).unwrap();
        }
        let tokens = CandidateTokens::default();
        // The implicit default (the home folder): Documents is not read at all.
        let group = |p: &Path| unshared_group_at(&config, &home, SERVER, p, &tokens, true);
        assert_eq!(group(&docs.join("notes")), None);
        let app = group(&code.join("app")).unwrap();
        assert_eq!((app.name.as_str(), app.display.as_str(), app.refusal), ("app", "~/code/app", None));
        assert!(token_shaped(app.token.as_deref().unwrap()));
        assert_eq!(group(&home).unwrap().refusal, Some(REFUSAL_HOME));
        assert_eq!(group(&home).unwrap().display, "~");
        assert_eq!(group(&home.join(".config/tool")).unwrap().refusal, Some(REFUSAL_HIDDEN));
        assert_eq!(group(&code.join("gone")), None);
        assert_eq!(group(Path::new("relative/x")), None);
        // The node's own folders: never grouped.
        assert_eq!(group(&home.join(crate::node_job::NODE_ROOT_NAME).join("worktrees/abc")), None);
        assert_eq!(group(&home.join(crate::node_job::NODE_ROOT_NAME).join("jobs/x")), None);
        // A search root inside Documents covers it.
        settings(&config, json!({ "searchRoots": [docs.to_string_lossy()] }));
        let notes = group(&docs.join("notes")).unwrap();
        assert!(notes.token.is_some());
        assert_eq!(group(&home.join("loose")).unwrap().refusal, Some(REFUSAL_OUTSIDE));
        let _ = fs::remove_dir_all(&base);
    }
}
