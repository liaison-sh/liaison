// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SERVED SHELL: THE CONNECTED SERVER'S OWN WEB BUILD, VERIFIED, IN THE MAIN
// WINDOW (S5, S6, S8, D7a, D8, D9, D15, D16).
//
// The window normally runs the web build compiled into this binary (the
// BUNDLED shell). A server ships its own build of apps/web, and Liaison signs
// every released build with its app-signing key: a shell statement
// (packages/shared/src/app-signing/shell-statement.ts) names the build id,
// the bridge range it needs from this host and the sha256 of every file. When
// the server's build has such a statement, this module:
//
// 1. asks the server which desktop build it serves (`GET /api/shell/info`,
//    which also carries the operator's kill switch `servedShell`), reads the
//    fleet-wide kill switch (`shell/flags.json` + `.sig` on Liaison's downloads
//    host, signed like the revocation list; absent = on) and the revocation
//    list;
// 2. fetches the statement from the downloads host and checks it: canonical
//    bytes, an Ed25519 signature by a PINNED key (keys.json, app_signing.rs),
//    `kind: "shell"` and `mode: "desktop"`, the build id asked for, a `seq`
//    not below the `shell:desktop` floor (compiled or listed), and a bridge
//    range that DESKTOP_BRIDGE_VERSION satisfies;
// 3. fetches every listed file from the server (no redirect, 15 s per
//    request, 30 MB for the build), checks each one's sha256, writes them to a
//    temporary folder and only then moves them into the content-addressed
//    store `<app data>/shells/blobs/<sha256>` (shared by every server), and
//    points the server's pointer file `<app data>/shells/servers/<sha256 of its
//    origin>.json` at the build;
// 4. serves the build on the app's OWN origin (D8) through the asset resolver
//    below, installed with `Context::set_assets` (review O1): ONLY the
//    statement's paths, each re-hashed on every read, never a bundled file in
//    their place, and Tauri's own CSP injection still applies to its HTML
//    (with the hashes of that HTML's inline scripts, computed here as Tauri's
//    codegen computes them for the bundled pages).
//
// A newer build is never swapped under a running page: it is STAGED and
// becomes the active build at the next document load (app start, a server
// switch, a reload), and the page asks for an idle reload itself (web side).
// The one exception is a SECURITY RELOAD: the lists and the server are read
// again at start (within START_DEADLINE, before a build is selected), every
// REFRESH_EVERY and when the window comes forward, and a running build that
// was revoked, fell below the floor or was switched off stops at once.
//
// LAST GOOD AND QUARANTINE (D9, S8). A served build that has not called
// `shell_ready` READY_WITHIN (45 s) after it first loaded is reloaded once; a second miss
// quarantines it for this install (never retried until the server serves
// another build id) and the window falls back to the server's last good build,
// else the bundled shell. The bundled shell is always there: any refusal, any
// missing file, a stale revocation list (older than 72 h) or either kill
// switch means the bundled shell, a log line and no dialog.
//
// Debug builds never serve a shell (the updater's rule 1): their window loads
// the dev server anyway.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{AppHandle, Assets, Manager, Runtime};

use crate::app_signing::{self, PinnedKey, RevocationEntry, RevocationList};

/// The bridge this host implements: apps/web's DESKTOP_BRIDGE_VERSION
/// (desktop-shell-contract.ts, pinned by a test below).
pub const DESKTOP_BRIDGE_VERSION: u64 = 1;
/// The statement mode this host runs.
pub const MODE: &str = "desktop";
/// Liaison's downloads host: statements and the fleet flags.
pub const DOWNLOADS: &str = "https://downloads.liaison.sh";

const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
/// The most one build's fetch may take, every file together.
pub const FETCH_DEADLINE: Duration = Duration::from_secs(120);
/// The most a build may weigh, every fetched file together.
pub const MAX_BUILD_BYTES: usize = 30 * 1024 * 1024;
/// A statement lists ~700 files: well under this.
const MAX_SMALL_BYTES: usize = 2 * 1024 * 1024;
/// A served build runs only on a revocation list this young (D7a, A1).
pub const REVOCATIONS_MAX_AGE: Duration = Duration::from_secs(72 * 3600);
/// How long a served build has to call `shell_ready` after it loaded.
///
/// 45 s, not D9's 20 s (review P6 #11): a page inside a shell awaits its
/// session restore before its first render (apps/web startup.ts
/// `initializeAuth`), and that wait is bounded at 30 s
/// (auth-store.ts `RESTORE_TIMEOUT_MS`), after which the page renders its
/// "try again" state and signals ready. A slow server must not get a good
/// build quarantined, so the window covers the whole bound plus 15 s for the
/// render itself; a test pins it above the web constant. A second signal
/// ("restore done") would have added a protocol message for the same result.
pub const READY_WITHIN: Duration = Duration::from_secs(45);
/// Missed readies before a build is quarantined.
pub const MISSES_TO_QUARANTINE: u32 = 2;
/// Files fetched at once.
const CONCURRENCY: usize = 6;
/// Blobs and statements no pointer references are deleted after this long.
const GC_AFTER: Duration = Duration::from_secs(30 * 24 * 3600);

// ───────────────────────────── statements ─────────────────────────────

/// The parts of a shell statement this host uses (shell-statement.ts).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellStatement {
    pub key_id: String,
    pub mode: String,
    pub build_id: String,
    pub commit: String,
    pub seq: u64,
    pub liaison_version: String,
    pub bridge_desktop: String,
    pub settings_schema: u64,
    pub files: BTreeMap<String, String>,
}

const TOP_KEYS: [&str; 12] = [
    "bridge",
    "buildId",
    "commit",
    "files",
    "issuedAt",
    "keyId",
    "kind",
    "liaisonVersion",
    "mode",
    "seq",
    "settingsSchema",
    "v",
];

/// JavaScript's Number.MAX_SAFE_INTEGER: the shared parser's `isCount` bound.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

fn is_hex(text: &str, len: usize) -> bool {
    text.len() == len
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn count(value: &Value) -> Option<u64> {
    value.as_u64().filter(|n| *n <= MAX_SAFE_INTEGER)
}

/// shell-statement.ts `isShellFilePath`: relative, `/`-separated, no empty,
/// `.` or `..` segment, no backslash, at most 512 UTF-16 code units.
pub fn is_shell_file_path(path: &str) -> bool {
    let units = path.encode_utf16().count();
    if units == 0 || units > 512 || path.contains('\\') {
        return false;
    }
    path.split('/')
        .all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

/// The shell statement these bytes hold, or None when they are not exactly
/// one in canonical form. An app statement (no `kind`) never parses here.
pub fn parse_shell_statement(bytes: &[u8]) -> Option<ShellStatement> {
    let value = app_signing::canonical_value(bytes)?;
    if !app_signing::exact_keys(&value, &TOP_KEYS)
        || value["v"].as_u64() != Some(1)
        || value["kind"].as_str() != Some("shell")
    {
        return None;
    }
    let mode = value["mode"].as_str()?;
    if mode != "desktop" && mode != "native" {
        return None;
    }
    app_signing::non_empty(&value["issuedAt"])?;
    let build_id = value["buildId"].as_str().filter(|s| is_hex(s, 16))?;
    let commit = value["commit"].as_str().filter(|s| is_hex(s, 40))?;
    let seq = count(&value["seq"])?;
    let settings_schema = count(&value["settingsSchema"])?;
    let bridge = &value["bridge"];
    if !app_signing::exact_keys(bridge, &["android", "desktop", "ios"]) {
        return None;
    }
    app_signing::non_empty(&bridge["ios"])?;
    app_signing::non_empty(&bridge["android"])?;
    let files_value = value["files"].as_object()?;
    if files_value.is_empty() {
        return None;
    }
    let mut files = BTreeMap::new();
    for (path, hash) in files_value {
        let hash = hash.as_str().filter(|h| is_hex(h, 64))?;
        if !is_shell_file_path(path) {
            return None;
        }
        files.insert(path.clone(), hash.to_string());
    }
    Some(ShellStatement {
        key_id: app_signing::non_empty(&value["keyId"])?,
        mode: mode.to_string(),
        build_id: build_id.to_string(),
        commit: commit.to_string(),
        seq,
        liaison_version: app_signing::non_empty(&value["liaisonVersion"])?,
        bridge_desktop: app_signing::non_empty(&bridge["desktop"])?,
        settings_schema,
        files,
    })
}

// ───────────────────────────── bridge ranges ─────────────────────────────

/// Whether the integer bridge `version` satisfies `range`, in the grammar
/// apps/web/src/lib/shell-bridge-range.ts `bridgeRangeAllows` shares: sets
/// joined by `||`, each a space-separated list of comparators that must all
/// hold, a comparator `^N`, `~N`, `=N`, `N` (all three: exactly N, N being a
/// major version), `>=N`, `>N`, `<=N` or `<N`. Anything else (an empty range,
/// a part it cannot read) allows nothing.
pub fn bridge_range_allows(range: &str, version: u64) -> bool {
    let mut sets = Vec::new();
    for set in range.split("||") {
        let mut comparators = Vec::new();
        for part in set.split_whitespace() {
            match parse_comparator(part) {
                Some(c) => comparators.push(c),
                None => return false,
            }
        }
        if comparators.is_empty() {
            return false;
        }
        sets.push(comparators);
    }
    sets.iter().any(|set| {
        set.iter().all(|(op, n)| match *op {
            ">=" => version >= *n,
            ">" => version > *n,
            "<=" => version <= *n,
            "<" => version < *n,
            _ => version == *n,
        })
    })
}

fn parse_comparator(part: &str) -> Option<(&'static str, u64)> {
    let (op, digits) = [">=", "<=", ">", "<", "=", "^", "~"]
        .iter()
        .find_map(|op| part.strip_prefix(op).map(|rest| (*op, rest)))
        .unwrap_or(("", part));
    let well_formed = !digits.is_empty()
        && digits.len() <= 9
        && digits.bytes().all(|b| b.is_ascii_digit())
        && (digits == "0" || !digits.starts_with('0'));
    if !well_formed {
        return None;
    }
    Some((op, digits.parse().ok()?))
}

// ───────────────────────────── verification ─────────────────────────────

/// Why a shell build does not run. Logged, and reported to the page as the
/// bundled reason; never shown in a dialog.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    NoKeys,
    MalformedStatement,
    UnknownKey,
    BadSignature,
    /// Not the mode and build id asked for (shell-statement.ts
    /// `verifyShellStatementFor`: `wrong_build`).
    WrongBuild,
    BelowFloor,
    Revoked,
    Bridge,
    NoStatement,
    Fetch,
    TooLarge,
    FileHash,
    MissingFile,
    RevocationsStale,
    Cache,
}

impl Refusal {
    pub fn code(&self) -> &'static str {
        match self {
            Refusal::NoKeys => "no_keys",
            Refusal::MalformedStatement => "malformed_statement",
            Refusal::UnknownKey => "unknown_key",
            Refusal::BadSignature => "bad_signature",
            Refusal::WrongBuild => "wrong_build",
            Refusal::BelowFloor => "below_floor",
            Refusal::Revoked => "revoked",
            Refusal::Bridge => "bridge",
            Refusal::NoStatement => "no_statement",
            Refusal::Fetch => "fetch",
            Refusal::TooLarge => "too_large",
            Refusal::FileHash => "file_hash",
            Refusal::MissingFile => "missing_file",
            Refusal::RevocationsStale => "revocations_stale",
            Refusal::Cache => "cache",
        }
    }
}

/// What a statement is checked against.
#[derive(Clone, Copy)]
pub struct Trust<'a> {
    pub keys: &'a [PinnedKey],
    pub floor: &'a [RevocationEntry],
    pub list: Option<&'a RevocationList>,
    pub bridge_version: u64,
}

/// The whole statement check, cheapest refusal first.
pub fn verify_shell_statement(
    bytes: &[u8],
    sig_base64: &str,
    trust: Trust<'_>,
    build_id: &str,
) -> Result<ShellStatement, Refusal> {
    if trust.keys.is_empty() {
        return Err(Refusal::NoKeys);
    }
    let statement = parse_shell_statement(bytes).ok_or(Refusal::MalformedStatement)?;
    let key = trust
        .keys
        .iter()
        .find(|k| k.key_id == statement.key_id)
        .ok_or(Refusal::UnknownKey)?;
    if !app_signing::signature_holds(bytes, sig_base64, key) {
        return Err(Refusal::BadSignature);
    }
    if statement.mode != MODE {
        return Err(Refusal::WrongBuild);
    }
    if statement.build_id != build_id {
        return Err(Refusal::WrongBuild);
    }
    if app_signing::below_shell_floor(trust.floor, MODE, statement.seq) {
        return Err(Refusal::BelowFloor);
    }
    if trust
        .list
        .is_some_and(|list| app_signing::below_shell_floor(&list.entries, MODE, statement.seq))
    {
        return Err(Refusal::Revoked);
    }
    if !bridge_range_allows(&statement.bridge_desktop, trust.bridge_version) {
        return Err(Refusal::Bridge);
    }
    Ok(statement)
}

// ───────────────────────────── fleet flags ─────────────────────────────

/// The fleet-wide kill switch, `shell/flags.json` on the downloads host:
/// canonical `{v:1, seq, issuedAt, servedShell:{desktop, native}}` signed by
/// any pinned key (like the revocation list), `seq` never going back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Flags {
    pub seq: u64,
    pub desktop: bool,
    pub native: bool,
}

pub fn parse_flags(bytes: &[u8]) -> Option<Flags> {
    let value = app_signing::canonical_value(bytes)?;
    if !app_signing::exact_keys(&value, &["issuedAt", "seq", "servedShell", "v"])
        || value["v"].as_u64() != Some(1)
    {
        return None;
    }
    app_signing::non_empty(&value["issuedAt"])?;
    let served = &value["servedShell"];
    if !app_signing::exact_keys(served, &["desktop", "native"]) {
        return None;
    }
    Some(Flags {
        seq: count(&value["seq"])?,
        desktop: served["desktop"].as_bool()?,
        native: served["native"].as_bool()?,
    })
}

pub fn verify_flags(bytes: &[u8], sig: &str, keys: &[PinnedKey]) -> Option<Flags> {
    let flags = parse_flags(bytes)?;
    keys.iter()
        .any(|key| app_signing::signature_holds(bytes, sig, key))
        .then_some(flags)
}

/// The fleet flags as kept on disk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StoredFlags {
    None,
    Verified(Flags),
    /// Kept, but no pinned key verifies them any more.
    Unverifiable {
        seq: u64,
    },
}

// ───────────────────────────── inline scripts ─────────────────────────────

fn find_ci(haystack: &str, needle: &str, from: usize) -> Option<usize> {
    let hay = haystack.as_bytes();
    let needle = needle.as_bytes();
    (from..hay.len().saturating_sub(needle.len() - 1))
        .find(|&i| hay[i..i + needle.len()].eq_ignore_ascii_case(needle))
}

/// The end (exclusive) of the start tag opened at `open`, quotes respected.
fn tag_end(html: &str, open: usize) -> Option<usize> {
    let mut quote: Option<u8> = None;
    for (i, b) in html.bytes().enumerate().skip(open) {
        match quote {
            Some(q) if b == q => quote = None,
            Some(_) => {}
            None if b == b'"' || b == b'\'' => quote = Some(b),
            None if b == b'>' => return Some(i + 1),
            None => {}
        }
    }
    None
}

/// The text of every non-empty `<script>` element of `html` (Tauri's codegen
/// hashes `script:not(:empty)`), comments and `<style>` text skipped. A
/// script's text runs to the first `</script`, as an HTML parser reads it.
pub fn inline_scripts(html: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(lt) = html[at..].find('<').map(|i| i + at) {
        let rest = &html[lt..];
        if rest.starts_with("<!--") {
            at = match rest.find("-->") {
                Some(end) => lt + end + 3,
                None => break,
            };
            continue;
        }
        let raw_text = ["script", "style"].into_iter().find(|name| {
            rest.len() > name.len() + 1
                && rest.as_bytes()[1..=name.len()].eq_ignore_ascii_case(name.as_bytes())
                && matches!(
                    rest.as_bytes()[name.len() + 1],
                    b'>' | b' ' | b'\t' | b'\n' | b'\r' | b'\x0c' | b'/'
                )
        });
        let Some(name) = raw_text else {
            at = lt + 1;
            continue;
        };
        let Some(body_start) = tag_end(html, lt) else {
            break;
        };
        let Some(close) = find_ci(html, &format!("</{name}"), body_start) else {
            break;
        };
        if name == "script" && close > body_start {
            out.push(&html[body_start..close]);
        }
        at = close + name.len() + 2;
    }
    out
}

/// `'sha256-<base64>'` of a script's text, line endings normalised to LF as
/// an HTML parser does (tauri-utils `normalize_script_for_csp`).
pub fn csp_hash(script: &str) -> String {
    let normalized = script.replace("\r\n", "\n").replace('\r', "\n");
    format!(
        "'sha256-{}'",
        base64::engine::general_purpose::STANDARD.encode(Sha256::digest(normalized.as_bytes()))
    )
}

pub fn inline_script_hashes(html: &str) -> Vec<String> {
    inline_scripts(html).into_iter().map(csp_hash).collect()
}

// ───────────────────────────── the store ─────────────────────────────

/// One server's record: the build it serves (verified), the last build that
/// signalled ready, the builds quarantined here, missed readies, and the
/// server's own kill switch as last read.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Pointer {
    pub current: Option<String>,
    pub last_good: Option<String>,
    pub quarantined: Vec<String>,
    pub misses: BTreeMap<String, u32>,
    pub served_shell: Option<bool>,
}

#[derive(Serialize, Deserialize)]
struct StatementRecord {
    statement: String,
    sig: String,
}

/// `<app data>/shells`: blobs by sha256, statements by build id, a pointer
/// per server, the accepted fleet flags and when the revocation list was
/// last read fresh.
pub struct ShellStore {
    root: PathBuf,
}

/// The bytes of `<blobs>/<sha>` while they hash to `sha`; a blob that does
/// not is deleted.
fn read_verified_blob(blobs: &Path, sha: &str) -> Option<Vec<u8>> {
    if !is_hex(sha, 64) {
        return None;
    }
    let path = blobs.join(sha);
    let bytes = std::fs::read(&path).ok()?;
    if app_signing::sha256_hex(&bytes) == sha {
        return Some(bytes);
    }
    eprintln!("liaison: shell blob {sha} no longer matches its hash: deleted");
    let _ = std::fs::remove_file(path);
    None
}

fn now_secs(now: SystemTime) -> u64 {
    now.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Writes `bytes` to a temporary file of its own beside `path`, then renames
/// it over `path`: a reader sees the old file or the new one, never half of
/// one, and two writers never share a temporary file (review P6 #4).
fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("tmp-{}", random_hex()));
    let result = std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Every read-modify-write of a pointer file holds this (review P6 #4): a
/// refresh that fetched for minutes, a missed ready and a ready never write
/// over each other's quarantine or last good build. One process holds the
/// store (the app runs as a single instance), so a process lock is enough.
static POINTER_WRITES: Mutex<()> = Mutex::new(());

fn random_hex() -> String {
    let mut bytes = [0u8; 8];
    let _ = getrandom::fill(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The pointer file name of a server: the sha256 of its origin, so two
/// spellings of one server share one pointer.
pub fn server_key(address: &str) -> String {
    let origin = crate::servers::origin_of(address).unwrap_or_else(|| address.trim().to_string());
    app_signing::sha256_hex(origin.as_bytes())
}

impl ShellStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn blobs(&self) -> PathBuf {
        self.root.join("blobs")
    }

    fn pointer_path(&self, address: &str) -> PathBuf {
        self.root
            .join("servers")
            .join(format!("{}.json", server_key(address)))
    }

    fn record_path(&self, build_id: &str) -> Option<PathBuf> {
        is_hex(build_id, 16).then(|| {
            self.root
                .join("statements")
                .join(format!("{build_id}.json"))
        })
    }

    pub fn pointer(&self, address: &str) -> Pointer {
        std::fs::read(self.pointer_path(address))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    /// Writes a whole pointer. Writers that start from the stored pointer go
    /// through `update_pointer`, which re-reads it under the lock.
    pub fn save_pointer(&self, address: &str, pointer: &Pointer) -> std::io::Result<()> {
        let bytes = serde_json::to_vec(pointer).map_err(std::io::Error::other)?;
        write_atomically(&self.pointer_path(address), &bytes)
    }

    /// Reads the pointer of `address` under the pointer lock, lets `change`
    /// edit it, and saves it when `change` answers true. Answers the pointer
    /// as it now is.
    pub fn update_pointer(
        &self,
        address: &str,
        change: impl FnOnce(&mut Pointer) -> bool,
    ) -> std::io::Result<Pointer> {
        let _one_writer = POINTER_WRITES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut pointer = self.pointer(address);
        if change(&mut pointer) {
            self.save_pointer(address, &pointer)?;
        }
        Ok(pointer)
    }

    /// The stored statement and signature of a build.
    pub fn record(&self, build_id: &str) -> Option<(Vec<u8>, String)> {
        let bytes = std::fs::read(self.record_path(build_id)?).ok()?;
        let record: StatementRecord = serde_json::from_slice(&bytes).ok()?;
        Some((record.statement.into_bytes(), record.sig))
    }

    /// Whether a blob is kept AND still hashes to its name (review P6 #3): a
    /// truncated or altered blob counts as absent, so it is fetched again.
    pub fn has_blob(&self, sha: &str) -> bool {
        self.read_blob(sha).is_some()
    }

    /// A blob's bytes, only while they still hash to their name. A blob that
    /// no longer does is deleted, never trusted: the next refresh fetches it.
    pub fn read_blob(&self, sha: &str) -> Option<Vec<u8>> {
        read_verified_blob(&self.blobs(), sha)
    }

    /// Keeps a verified build: every fetched file goes to a temporary folder
    /// first, is checked against its name there, and only then moves into the
    /// blobs; the statement record is written last.
    pub fn install(
        &self,
        build_id: &str,
        statement: &[u8],
        sig: &str,
        fetched: &[(String, Vec<u8>)],
    ) -> std::io::Result<()> {
        let record_path = self
            .record_path(build_id)
            .ok_or_else(|| std::io::Error::other("not a build id"))?;
        let text = std::str::from_utf8(statement).map_err(std::io::Error::other)?;
        let tmp = self.root.join("tmp").join(random_hex());
        std::fs::create_dir_all(&tmp)?;
        let result = (|| {
            for (sha, bytes) in fetched {
                if !is_hex(sha, 64) || app_signing::sha256_hex(bytes) != *sha {
                    return Err(std::io::Error::other("bytes do not match their hash"));
                }
                std::fs::write(tmp.join(sha), bytes)?;
            }
            std::fs::create_dir_all(self.blobs())?;
            for (sha, _) in fetched {
                // A blob already kept is replaced unless it still verifies
                // (read_blob deletes one that does not).
                if !self.has_blob(sha) {
                    std::fs::rename(tmp.join(sha), self.blobs().join(sha))?;
                }
            }
            let record = serde_json::to_vec(&StatementRecord {
                statement: text.to_string(),
                sig: sig.trim().to_string(),
            })
            .map_err(std::io::Error::other)?;
            write_atomically(&record_path, &record)
        })();
        let _ = std::fs::remove_dir_all(&tmp);
        result
    }

    fn flags_path(&self) -> PathBuf {
        self.root.join("flags.signed.json")
    }

    /// The fleet flags last accepted, re-verified against the keys pinned
    /// NOW (a key rotation drops the old key).
    pub fn stored_flags(&self, keys: &[PinnedKey]) -> StoredFlags {
        let Some(stored) = std::fs::read(self.flags_path())
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        else {
            return StoredFlags::None;
        };
        let (Some(text), Some(sig)) = (stored["flags"].as_str(), stored["sig"].as_str()) else {
            return StoredFlags::Unverifiable { seq: 0 };
        };
        match verify_flags(text.as_bytes(), sig, keys) {
            Some(flags) => StoredFlags::Verified(flags),
            None => StoredFlags::Unverifiable {
                seq: parse_flags(text.as_bytes()).map_or(0, |f| f.seq),
            },
        }
    }

    /// The fleet flags last accepted, when they still verify.
    pub fn flags(&self, keys: &[PinnedKey]) -> Option<Flags> {
        match self.stored_flags(keys) {
            StoredFlags::Verified(flags) => Some(flags),
            _ => None,
        }
    }

    /// Whether the fleet lets this host serve a desktop shell. No flags ever
    /// read: on. Kept flags that no longer verify against the pinned keys (a
    /// rotation dropped their key, or the file was altered): OFF until flags
    /// signed by a pinned key are read (review P6 #9), so a stored
    /// `desktop: false` never silently turns on.
    pub fn fleet_enabled(&self, keys: &[PinnedKey]) -> bool {
        match self.stored_flags(keys) {
            StoredFlags::None => true,
            StoredFlags::Verified(flags) => flags.desktop,
            StoredFlags::Unverifiable { .. } => false,
        }
    }

    /// Keeps newly read flags when they verify and do not go back in `seq`
    /// (the stored `seq` counts even when its signature no longer verifies),
    /// and answers the flags to apply. `None` when there are none.
    pub fn offer_flags(&self, bytes: &[u8], sig: &str, keys: &[PinnedKey]) -> Option<Flags> {
        let stored = self.stored_flags(keys);
        let (stored_flags, stored_seq) = match stored {
            StoredFlags::None => (None, None),
            StoredFlags::Verified(flags) => (Some(flags), Some(flags.seq)),
            StoredFlags::Unverifiable { seq } => (None, Some(seq)),
        };
        let Some(flags) = verify_flags(bytes, sig, keys) else {
            return stored_flags;
        };
        if stored_seq.is_some_and(|seq| flags.seq < seq) {
            return stored_flags;
        }
        if let Ok(text) = std::str::from_utf8(bytes) {
            let record = serde_json::json!({ "flags": text, "sig": sig.trim() });
            let _ = write_atomically(&self.flags_path(), record.to_string().as_bytes());
        }
        Some(flags)
    }

    fn fetched_path(&self) -> PathBuf {
        self.root.join("revocations.fetched")
    }

    /// The revocation list was read, verified and kept at `now`.
    pub fn mark_revocations_fetched(&self, now: SystemTime) {
        let _ = write_atomically(&self.fetched_path(), now_secs(now).to_string().as_bytes());
    }

    /// Whether the last fresh read is younger than REVOCATIONS_MAX_AGE. A
    /// time in the future (a clock set back) counts as stale.
    pub fn revocations_fresh(&self, now: SystemTime) -> bool {
        let Some(at) = std::fs::read_to_string(self.fetched_path())
            .ok()
            .and_then(|text| text.trim().parse::<u64>().ok())
        else {
            return false;
        };
        let now = now_secs(now);
        at <= now && now - at < REVOCATIONS_MAX_AGE.as_secs()
    }

    /// Drops blobs and statements that no server's current or last good build
    /// references and that are older than GC_AFTER.
    pub fn gc(&self, now: SystemTime) {
        let mut builds = HashSet::new();
        if let Ok(entries) = std::fs::read_dir(self.root.join("servers")) {
            for entry in entries.flatten() {
                let pointer: Option<Pointer> = std::fs::read(entry.path())
                    .ok()
                    .and_then(|b| serde_json::from_slice(&b).ok());
                if let Some(p) = pointer {
                    builds.extend(p.current);
                    builds.extend(p.last_good);
                }
            }
        }
        let mut shas = HashSet::new();
        for build in &builds {
            if let Some(statement) = self
                .record(build)
                .and_then(|(s, _)| parse_shell_statement(&s))
            {
                shas.extend(statement.files.into_values());
            }
        }
        let old = |path: &Path| {
            std::fs::metadata(path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|at| now.duration_since(at).ok())
                .is_some_and(|age| age >= GC_AFTER)
        };
        for (dir, keep) in [
            (self.blobs(), &shas),
            (self.root.join("statements"), &builds),
        ] {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let stem = name.strip_suffix(".json").unwrap_or(&name).to_string();
                if !keep.contains(&stem) && old(&entry.path()) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
}

// ───────────────────────────── a selected build ─────────────────────────────

/// A verified build the resolver may serve: its listed paths and their
/// hashes, and the inline script hashes of each of its HTML pages.
#[derive(Debug)]
pub struct ServedBuild {
    pub build_id: String,
    /// The server this build was selected for: a ready or a missed ready is
    /// recorded on that server's pointer, whatever the window shows when the
    /// timer fires (review P6 #5).
    pub server: String,
    files: HashMap<String, String>,
    blobs: PathBuf,
    html_hashes: HashMap<String, Vec<String>>,
}

impl ServedBuild {
    /// A listed file's bytes, re-hashed: None for an unlisted path or a blob
    /// that no longer matches.
    pub fn read(&self, path: &str) -> Option<Vec<u8>> {
        read_verified_blob(&self.blobs, self.files.get(path)?)
    }

    pub fn csp_hashes(&self, path: &str) -> Vec<String> {
        self.html_hashes.get(path).cloned().unwrap_or_default()
    }
}

/// Re-checks a stored build from disk alone (no network): its statement
/// against `trust` and every blob, RE-HASHED (review P6 #3): a blob that no
/// longer matches is deleted and the build counts as incomplete, so the
/// next refresh fetches what is missing instead of the build missing its
/// readies into quarantine.
pub fn load_build(
    store: &ShellStore,
    build_id: &str,
    trust: Trust<'_>,
) -> Result<ServedBuild, Refusal> {
    let (statement, sig) = store.record(build_id).ok_or(Refusal::NoStatement)?;
    let statement = verify_shell_statement(&statement, &sig, trust, build_id)?;
    if !statement.files.contains_key("index.html") {
        return Err(Refusal::MissingFile);
    }
    let mut html_hashes = HashMap::new();
    let mut checked = HashSet::new();
    for (path, sha) in &statement.files {
        let is_html = path.ends_with(".html");
        if !is_html && !checked.insert(sha.as_str()) {
            continue;
        }
        let bytes = store.read_blob(sha).ok_or(Refusal::MissingFile)?;
        if is_html {
            let html = String::from_utf8_lossy(&bytes);
            html_hashes.insert(path.clone(), inline_script_hashes(&html));
        }
    }
    Ok(ServedBuild {
        build_id: build_id.to_string(),
        server: String::new(),
        files: statement.files.into_iter().collect(),
        blobs: store.blobs(),
        html_hashes,
    })
}

/// What the main window runs.
#[derive(Clone, Debug)]
pub enum Active {
    /// The bundled shell, and why.
    Bundled(String),
    Served(Arc<ServedBuild>),
}

impl Active {
    pub fn build_id(&self) -> Option<&str> {
        match self {
            Active::Served(build) => Some(&build.build_id),
            Active::Bundled(_) => None,
        }
    }

    fn same_as(&self, other: &Active) -> bool {
        match (self, other) {
            (Active::Served(a), Active::Served(b)) => a.build_id == b.build_id,
            (Active::Bundled(a), Active::Bundled(b)) => a == b,
            _ => false,
        }
    }
}

/// What the store and the cached lists allow, with no network.
pub struct Local<'a> {
    pub trust: Trust<'a>,
    /// The fleet flag (true when none was ever read).
    pub fleet_enabled: bool,
    /// A revocation list read fresh within REVOCATIONS_MAX_AGE.
    pub revocations_fresh: bool,
}

/// The build to run for `address`: its current build, or its last good one
/// when the current one is quarantined or no longer verifies, else bundled.
pub fn select(store: &ShellStore, address: &str, local: &Local<'_>) -> Active {
    if !local.fleet_enabled {
        return Active::Bundled("fleet_off".into());
    }
    let pointer = store.pointer(address);
    if pointer.served_shell == Some(false) {
        return Active::Bundled("server_off".into());
    }
    let Some(current) = pointer.current.clone() else {
        return Active::Bundled("no_build".into());
    };
    if !local.revocations_fresh {
        return Active::Bundled(Refusal::RevocationsStale.code().into());
    }
    let mut candidates = Vec::new();
    if !pointer.quarantined.contains(&current) {
        candidates.push(current.clone());
    }
    if let Some(last_good) = pointer.last_good.clone() {
        if last_good != current && !pointer.quarantined.contains(&last_good) {
            candidates.push(last_good);
        }
    }
    let mut reason = "quarantined".to_string();
    for build_id in candidates {
        match load_build(store, &build_id, local.trust) {
            Ok(mut build) => {
                build.server = address.to_string();
                return Active::Served(Arc::new(build));
            }
            Err(refusal) => {
                eprintln!(
                    "liaison: stored shell {build_id} not used: {}",
                    refusal.code()
                );
                reason = refusal.code().to_string();
            }
        }
    }
    Active::Bundled(reason)
}

/// Why the build `build_id`, running now for `address`, must stop at once
/// (review P6 #1), or None when it may keep running until the next load:
/// either kill switch, or a statement that no longer verifies against the
/// pinned keys and the CURRENT revocation list and floor (revoked, below the
/// `shell:desktop` floor, its key unpinned). A stale list, a missing blob or
/// a newer build are not reasons: those wait for the next load.
pub fn must_leave(
    store: &ShellStore,
    address: &str,
    local: &Local<'_>,
    build_id: &str,
) -> Option<String> {
    if !local.fleet_enabled {
        return Some("fleet_off".into());
    }
    if store.pointer(address).served_shell == Some(false) {
        return Some("server_off".into());
    }
    let (statement, sig) = store.record(build_id)?;
    match verify_shell_statement(&statement, &sig, local.trust, build_id) {
        Err(
            refusal @ (Refusal::Revoked
            | Refusal::BelowFloor
            | Refusal::UnknownKey
            | Refusal::BadSignature
            | Refusal::NoKeys
            | Refusal::MalformedStatement
            | Refusal::WrongBuild),
        ) => Some(refusal.code().into()),
        _ => None,
    }
}

/// What a refresh does to the window of `address`.
#[derive(Debug)]
pub enum AfterRefresh {
    /// Run this from the next document load (S6: no reload forced).
    Stage(Active),
    /// The running build must not run any more: run this now and reload the
    /// window at once, whatever the page is doing (a security reload).
    Leave { next: Active, reason: String },
}

/// The decision after a refresh of `address`, whose window runs `active`.
pub fn after_refresh(
    store: &ShellStore,
    address: &str,
    local: &Local<'_>,
    active: Option<&ServedBuild>,
) -> AfterRefresh {
    let next = select(store, address, local);
    let running = active.filter(|build| crate::servers::same_server(&build.server, address));
    if let Some(build) = running {
        if let Some(reason) = must_leave(store, address, local, &build.build_id) {
            return AfterRefresh::Leave { next, reason };
        }
    }
    AfterRefresh::Stage(next)
}

// ───────────────────────────── fetching ─────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FetchError {
    NotFound,
    Failed,
    TooLarge,
}

/// The bytes a whole build may still take, shared by its concurrent
/// fetches: each one takes from it as its body arrives (review P6 #8), so the
/// build together never holds more than MAX_BUILD_BYTES.
pub struct Budget(std::sync::atomic::AtomicUsize);

impl Budget {
    pub fn new(bytes: usize) -> Self {
        Self(std::sync::atomic::AtomicUsize::new(bytes))
    }

    pub fn left(&self) -> usize {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Takes `bytes`, or nothing and false when fewer are left.
    pub fn take(&self, bytes: usize) -> bool {
        use std::sync::atomic::Ordering;
        let mut left = self.0.load(Ordering::SeqCst);
        loop {
            let Some(after) = left.checked_sub(bytes) else {
                return false;
            };
            match self
                .0
                .compare_exchange(left, after, Ordering::SeqCst, Ordering::SeqCst)
            {
                Ok(_) => return true,
                Err(now) => left = now,
            }
        }
    }
}

/// One GET, its body refused past `limit` bytes.
pub trait Fetcher: Sync {
    fn get(
        &self,
        url: &str,
        limit: usize,
    ) -> impl Future<Output = Result<Vec<u8>, FetchError>> + Send;

    /// One GET whose body is taken from `budget`. The default takes it once
    /// the body is in; the real fetcher takes it chunk by chunk.
    fn get_within(
        &self,
        url: &str,
        budget: &Budget,
    ) -> impl Future<Output = Result<Vec<u8>, FetchError>> + Send {
        async move {
            let bytes = self.get(url, budget.left()).await?;
            if budget.take(bytes.len()) {
                Ok(bytes)
            } else {
                Err(FetchError::TooLarge)
            }
        }
    }
}

/// The real one: no redirect followed, 15 s per request.
pub struct HttpFetcher {
    client: reqwest::Client,
}

impl HttpFetcher {
    pub fn new() -> Option<Self> {
        let client = reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .ok()?;
        Some(Self { client })
    }
}

impl Fetcher for HttpFetcher {
    async fn get(&self, url: &str, limit: usize) -> Result<Vec<u8>, FetchError> {
        let mut response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|_| FetchError::Failed)?;
        match response.status() {
            reqwest::StatusCode::OK => {}
            reqwest::StatusCode::NOT_FOUND => return Err(FetchError::NotFound),
            _ => return Err(FetchError::Failed),
        }
        if response
            .content_length()
            .is_some_and(|declared| declared > limit as u64)
        {
            return Err(FetchError::TooLarge);
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| FetchError::Failed)? {
            if body.len() + chunk.len() > limit {
                return Err(FetchError::TooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }

    async fn get_within(&self, url: &str, budget: &Budget) -> Result<Vec<u8>, FetchError> {
        let mut response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|_| FetchError::Failed)?;
        match response.status() {
            reqwest::StatusCode::OK => {}
            reqwest::StatusCode::NOT_FOUND => return Err(FetchError::NotFound),
            _ => return Err(FetchError::Failed),
        }
        if response
            .content_length()
            .is_some_and(|declared| declared > budget.left() as u64)
        {
            return Err(FetchError::TooLarge);
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| FetchError::Failed)? {
            if !budget.take(chunk.len()) {
                return Err(FetchError::TooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }
}

const SEGMENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// `<server>/<path>`, each segment percent-encoded. None for a server
/// address that is not http(s).
pub fn file_url(server: &str, path: &str) -> Option<String> {
    let parsed = url::Url::parse(server.trim()).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let encoded: Vec<String> = path
        .split('/')
        .map(|seg| percent_encoding::utf8_percent_encode(seg, SEGMENT).to_string())
        .collect();
    Some(format!(
        "{}/{}",
        server.trim().trim_end_matches('/'),
        encoded.join("/")
    ))
}

fn statement_url(downloads: &str, build_id: &str) -> String {
    format!("{downloads}/shell/{MODE}/{build_id}/statement.json")
}

/// Fetches, verifies and keeps one build of `server`. Nothing is written
/// unless every check passed; the caller moves the pointer.
pub async fn fetch_build<F: Fetcher>(
    fetcher: &F,
    store: &ShellStore,
    downloads: &str,
    server: &str,
    build_id: &str,
    trust: Trust<'_>,
) -> Result<ShellStatement, Refusal> {
    fetch_build_within(
        fetcher,
        store,
        downloads,
        server,
        build_id,
        trust,
        FETCH_DEADLINE,
    )
    .await
}

/// `fetch_build` with its whole-build deadline: past it, the build is
/// refused (`fetch`) and nothing is kept (review P6 #8: a server trickling
/// bytes must not hold the refresh for half an hour).
pub async fn fetch_build_within<F: Fetcher>(
    fetcher: &F,
    store: &ShellStore,
    downloads: &str,
    server: &str,
    build_id: &str,
    trust: Trust<'_>,
    deadline: Duration,
) -> Result<ShellStatement, Refusal> {
    tokio::time::timeout(
        deadline,
        fetch_build_unbounded(fetcher, store, downloads, server, build_id, trust),
    )
    .await
    .map_err(|_| Refusal::Fetch)?
}

async fn fetch_build_unbounded<F: Fetcher>(
    fetcher: &F,
    store: &ShellStore,
    downloads: &str,
    server: &str,
    build_id: &str,
    trust: Trust<'_>,
) -> Result<ShellStatement, Refusal> {
    if !is_hex(build_id, 16) {
        return Err(Refusal::WrongBuild);
    }
    let url = statement_url(downloads, build_id);
    let statement = fetcher
        .get(&url, MAX_SMALL_BYTES)
        .await
        .map_err(|e| match e {
            FetchError::NotFound => Refusal::NoStatement,
            _ => Refusal::Fetch,
        })?;
    let sig_url = format!("{downloads}/shell/{MODE}/{build_id}/statement.sig");
    let sig = fetcher
        .get(&sig_url, MAX_SMALL_BYTES)
        .await
        .map_err(|e| match e {
            FetchError::NotFound => Refusal::NoStatement,
            _ => Refusal::Fetch,
        })?;
    let sig = String::from_utf8(sig).map_err(|_| Refusal::BadSignature)?;
    let verified = verify_shell_statement(&statement, &sig, trust, build_id)?;
    let mut wanted: Vec<(String, String)> = Vec::new();
    let mut seen = HashSet::new();
    for (path, sha) in &verified.files {
        if !store.has_blob(sha) && seen.insert(sha.clone()) {
            wanted.push((file_url(server, path).ok_or(Refusal::Fetch)?, sha.clone()));
        }
    }
    let budget = Budget::new(MAX_BUILD_BYTES);
    use futures_util::stream::{self, StreamExt, TryStreamExt};
    let fetched: Vec<(String, Vec<u8>)> = stream::iter(wanted)
        .map(|(url, sha)| {
            let budget = &budget;
            async move {
                let bytes = fetcher
                    .get_within(&url, budget)
                    .await
                    .map_err(|e| match e {
                        FetchError::TooLarge => Refusal::TooLarge,
                        _ => Refusal::Fetch,
                    })?;
                if app_signing::sha256_hex(&bytes) != sha {
                    return Err(Refusal::FileHash);
                }
                Ok((sha, bytes))
            }
        })
        .buffer_unordered(CONCURRENCY)
        .try_collect()
        .await?;
    store
        .install(build_id, &statement, &sig, &fetched)
        .map_err(|_| Refusal::Cache)?;
    Ok(verified)
}

/// What `/api/shell/info` said about the desktop build.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerShell {
    pub build_id: Option<String>,
    pub served_shell: bool,
}

/// `{data: {desktop: {buildId}, servedShell}}` (shell-info-routes.ts).
pub fn parse_shell_info(bytes: &[u8]) -> Option<ServerShell> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let data = &value["data"];
    let served_shell = data["servedShell"].as_bool()?;
    let build_id = match &data["desktop"]["buildId"] {
        Value::Null => None,
        Value::String(id) if is_hex(id, 16) => Some(id.clone()),
        _ => return None,
    };
    Some(ServerShell {
        build_id,
        served_shell,
    })
}

/// Asks `server` which desktop build it serves and keeps its kill switch
/// (`servedShell`) on its pointer.
pub async fn read_server_shell<F: Fetcher>(
    fetcher: &F,
    store: &ShellStore,
    server: &str,
) -> Result<ServerShell, Refusal> {
    let info_url = file_url(server, "api/shell/info").ok_or(Refusal::Fetch)?;
    let info = fetcher
        .get(&info_url, MAX_SMALL_BYTES)
        .await
        .ok()
        .and_then(|bytes| parse_shell_info(&bytes))
        .ok_or(Refusal::Fetch)?;
    store
        .update_pointer(server, |pointer| {
            let changed = pointer.served_shell != Some(info.served_shell);
            pointer.served_shell = Some(info.served_shell);
            changed
        })
        .map_err(|_| Refusal::Cache)?;
    Ok(info)
}

/// One refresh of a server's pointer, pure apart from the fetcher and the
/// store: reads the server's build, fetches and verifies it when it is new,
/// and moves the pointer. A refusal leaves the pointer as it was.
pub async fn refresh_pointer<F: Fetcher>(
    fetcher: &F,
    store: &ShellStore,
    downloads: &str,
    server: &str,
    trust: Option<Trust<'_>>,
) -> Result<Pointer, Refusal> {
    let info = read_server_shell(fetcher, store, server).await?;
    let pointer = store.pointer(server);
    let Some(build_id) = info.build_id.filter(|_| info.served_shell) else {
        return Ok(pointer);
    };
    if pointer.quarantined.contains(&build_id) {
        return Ok(pointer);
    }
    let trust = trust.ok_or(Refusal::RevocationsStale)?;
    let stored_ok = pointer.current.as_deref() == Some(build_id.as_str())
        && load_build(store, &build_id, trust).is_ok();
    if stored_ok {
        return Ok(pointer);
    }
    fetch_build(fetcher, store, downloads, server, &build_id, trust).await?;
    // The fetch took a while: the pointer is read again and only `current`
    // and this build's misses move, so a quarantine or a last good build
    // recorded meanwhile is kept (review P6 #4).
    let pointer = store
        .update_pointer(server, |pointer| {
            if pointer.quarantined.contains(&build_id) {
                return false;
            }
            pointer.current = Some(build_id.clone());
            pointer.misses.remove(&build_id);
            true
        })
        .map_err(|_| Refusal::Cache)?;
    store.gc(SystemTime::now());
    Ok(pointer)
}

// ───────────────────────────── the resolver ─────────────────────────────

struct Selection {
    active: Active,
    /// The served build the page loaded before the active one: its listed
    /// non-HTML files stay servable, so a page that was already running when
    /// a newer build became active can still load its lazy chunks.
    previous: Option<Arc<ServedBuild>>,
    /// Becomes active at the next document load.
    pending: Option<Active>,
    /// A top-level document load of the main window was asked for (app
    /// start, a host reload, a server switch, a navigation of the main frame
    /// to the app's own origin): the next `index.html` the resolver is asked
    /// for is that document. Only that request swaps a staged build in and
    /// starts a ready window (review P6 #2). Tauri also answers `index.html`
    /// as the last fallback of ANY path a build does not list (a missing lazy
    /// chunk, an icon): without this flag, such a request would swap the
    /// build under the running page and arm a timer that page never answers.
    expect_document: bool,
    /// The served build whose ready timer is running.
    armed: Option<String>,
    /// Builds that called `shell_ready` in this process.
    ready: HashSet<String>,
}

/// The main window's build, shared by the asset resolver and the commands.
pub struct ShellState {
    selection: RwLock<Selection>,
    /// Called (off the lock) with a served build's id and its server when it
    /// starts its ready window.
    on_arm: OnceLock<Box<dyn Fn(String, String) + Send + Sync>>,
    /// CspHash borrows its string: the few distinct hashes ever served live
    /// for the process.
    interned: Mutex<HashSet<&'static str>>,
    refreshing: tokio::sync::Mutex<()>,
    /// When the lists and the server were last asked (any refresh).
    last_refresh: Mutex<Option<SystemTime>>,
}

/// The sentinel `refresh_shell` answers when the bundled shell is staged for
/// the next load (no build id to name).
pub const PENDING_BUNDLED: &str = "bundled";

enum Resolved {
    Bundled,
    Served(Option<Vec<u8>>),
}

/// What the page reports in `X-Liaison-Client` (S20).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellStatus {
    pub served: bool,
    pub build_id: Option<String>,
    pub reason: Option<String>,
    /// A newer selection waiting for the next load.
    pub pending: bool,
}

impl ShellState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            selection: RwLock::new(Selection {
                active: Active::Bundled("starting".into()),
                previous: None,
                pending: None,
                expect_document: false,
                armed: None,
                ready: HashSet::new(),
            }),
            on_arm: OnceLock::new(),
            interned: Mutex::new(HashSet::new()),
            refreshing: tokio::sync::Mutex::new(()),
            last_refresh: Mutex::new(None),
        })
    }

    pub fn set_on_arm(&self, hook: Box<dyn Fn(String, String) + Send + Sync>) {
        let _ = self.on_arm.set(hook);
    }

    /// The next `index.html` asked for is a document load of the main window.
    pub fn expect_document(&self) {
        if let Ok(mut sel) = self.selection.write() {
            sel.expect_document = true;
        }
    }

    /// Notes a refresh starting at `now`; answers whether one was due, the
    /// last one being `every` or more ago (or never, or in the future).
    pub fn refresh_due(&self, now: SystemTime, every: Duration) -> bool {
        let Ok(mut last) = self.last_refresh.lock() else {
            return true;
        };
        if !refresh_due(*last, now, every) {
            return false;
        }
        *last = Some(now);
        true
    }

    /// Runs `active` from now on (start, quarantine).
    pub fn set_active(&self, active: Active) {
        if let Ok(mut sel) = self.selection.write() {
            sel.previous = None;
            sel.pending = None;
            sel.armed = None;
            sel.active = active;
        }
    }

    /// Runs `active` from the next document load. Staging what already runs
    /// clears the pending one.
    pub fn stage(&self, active: Active) {
        if let Ok(mut sel) = self.selection.write() {
            sel.pending = (!sel.active.same_as(&active)).then_some(active);
        }
    }

    pub fn status(&self) -> ShellStatus {
        let Ok(sel) = self.selection.read() else {
            return ShellStatus {
                served: false,
                build_id: None,
                reason: Some("state".into()),
                pending: false,
            };
        };
        let pending = sel.pending.is_some();
        match &sel.active {
            Active::Served(build) => ShellStatus {
                served: true,
                build_id: Some(build.build_id.clone()),
                reason: None,
                pending,
            },
            Active::Bundled(reason) => ShellStatus {
                served: false,
                build_id: None,
                reason: Some(reason.clone()),
                pending,
            },
        }
    }

    /// What waits for the next load: a served build's id, PENDING_BUNDLED
    /// for the bundled shell, None when nothing does.
    pub fn pending_report(&self) -> Option<String> {
        let sel = self.selection.read().ok()?;
        match sel.pending.as_ref()? {
            Active::Served(build) => Some(build.build_id.clone()),
            Active::Bundled(_) => Some(PENDING_BUNDLED.to_string()),
        }
    }

    pub fn active_build(&self) -> Option<String> {
        let sel = self.selection.read().ok()?;
        sel.active.build_id().map(str::to_string)
    }

    /// The served build running now, if one does.
    pub fn active_served(&self) -> Option<Arc<ServedBuild>> {
        let sel = self.selection.read().ok()?;
        match &sel.active {
            Active::Served(build) => Some(build.clone()),
            Active::Bundled(_) => None,
        }
    }

    /// The page says it rendered. The server of the active served build
    /// when it is that build, else None. From now on the build the page
    /// loaded before it is not served any more (review P6 #6).
    pub fn note_ready(&self, build_id: &str) -> Option<String> {
        let mut sel = self.selection.write().ok()?;
        let Active::Served(build) = &sel.active else {
            return None;
        };
        if build.build_id != build_id {
            return None;
        }
        let server = build.server.clone();
        sel.ready.insert(build_id.to_string());
        sel.previous = None;
        Some(server)
    }

    pub fn is_ready(&self, build_id: &str) -> bool {
        self.selection
            .read()
            .is_ok_and(|sel| sel.ready.contains(build_id))
    }

    /// The next document load of the active build starts a new ready window.
    pub fn disarm(&self) {
        if let Ok(mut sel) = self.selection.write() {
            sel.armed = None;
        }
    }

    fn resolve(&self, path: &str) -> Resolved {
        let (active, previous, armed) = {
            let Ok(mut sel) = self.selection.write() else {
                return Resolved::Bundled;
            };
            // Only the document load the host expects swaps a staged build
            // in and starts a ready window; any other `index.html` (Tauri's
            // fallback for an unlisted path) is the running build's.
            let document = path == "index.html" && sel.expect_document;
            if document {
                sel.expect_document = false;
                if let Some(next) = sel.pending.take() {
                    sel.previous = match &sel.active {
                        Active::Served(build) => Some(build.clone()),
                        Active::Bundled(_) => None,
                    };
                    sel.active = next;
                    sel.armed = None;
                }
            }
            let Active::Served(build) = sel.active.clone() else {
                return Resolved::Bundled;
            };
            let mut armed = None;
            if document
                && sel.armed.as_deref() != Some(build.build_id.as_str())
                && !sel.ready.contains(&build.build_id)
            {
                sel.armed = Some(build.build_id.clone());
                armed = Some((build.build_id.clone(), build.server.clone()));
            }
            (build, sel.previous.clone(), armed)
        };
        let bytes = active.read(path).or_else(|| {
            if path.ends_with(".html") {
                None
            } else {
                previous.and_then(|p| p.read(path))
            }
        });
        if let (Some((build_id, server)), Some(hook), true) =
            (armed, self.on_arm.get(), bytes.is_some())
        {
            hook(build_id, server);
        }
        Resolved::Served(bytes)
    }

    /// The inline script hashes of `path` in the active served build; None
    /// while the bundled shell runs.
    fn csp_for(&self, path: &str) -> Option<Vec<String>> {
        let sel = self.selection.read().ok()?;
        match &sel.active {
            Active::Served(build) => Some(build.csp_hashes(path)),
            Active::Bundled(_) => None,
        }
    }

    fn intern(&self, hash: String) -> &'static str {
        let Ok(mut set) = self.interned.lock() else {
            return Box::leak(hash.into_boxed_str());
        };
        if let Some(existing) = set.get(hash.as_str()) {
            return existing;
        }
        let leaked: &'static str = Box::leak(hash.into_boxed_str());
        set.insert(leaked);
        leaked
    }
}

/// The asset provider of the `tauri` protocol: the active served build's
/// listed files, or the bundled assets while the bundled shell runs. Tauri's
/// own fallbacks (`<path>.html`, `<path>/index.html`, then `index.html`) ask
/// this again, so a path a served build does not list resolves to that
/// build's index.html, never to a bundled file. That is the one deviation
/// from D15's "unlisted -> 404", kept because the SPA's own routes reach
/// the page that way, exactly as with the bundled build; the CSP header is
/// on every response (`add_csp_header`).
pub struct ShellAssets<R: Runtime> {
    bundled: Box<dyn Assets<R>>,
    state: Arc<ShellState>,
}

fn asset_path(key: &AssetKey) -> &str {
    key.as_ref().trim_start_matches('/')
}

impl<R: Runtime> Assets<R> for ShellAssets<R> {
    fn setup(&self, app: &tauri::App<R>) {
        self.bundled.setup(app);
    }

    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        match self.state.resolve(asset_path(key)) {
            Resolved::Bundled => self.bundled.get(key),
            Resolved::Served(bytes) => bytes.map(Cow::Owned),
        }
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        self.bundled.iter()
    }

    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        match self.state.csp_for(asset_path(html_path)) {
            None => self.bundled.csp_hashes(html_path),
            Some(hashes) => {
                let interned: Vec<&'static str> =
                    hashes.into_iter().map(|h| self.state.intern(h)).collect();
                Box::new(interned.into_iter().map(CspHash::Script))
            }
        }
    }
}

/// Whether a refresh is due: never done, done `every` or more ago, or
/// recorded in the future (a clock set back). Wall-clock time, so a machine
/// that slept past `every` refreshes at the first tick after it wakes (the
/// runtime's own timers do not count the sleep).
pub fn refresh_due(last: Option<SystemTime>, now: SystemTime, every: Duration) -> bool {
    match last {
        None => true,
        Some(at) => now.duration_since(at).map_or(true, |age| age >= every),
    }
}

/// Whether a navigation of the main webview is a document load of the app's
/// own origin (the served or bundled shell), not a workspace frame
/// (`liaison-frame:`) or an outside page.
pub fn is_app_document(url: &url::Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

/// D15: every response of the app's own origin while a served build runs
/// carries the pinned CSP, not only its HTML (Tauri adds it, with the page's
/// script hashes, to HTML alone). A worker script served from a blob then
/// runs under the same policy. A response that has one keeps it.
pub fn add_csp_header(
    served: bool,
    csp: &str,
    response: &mut tauri::http::Response<Cow<'static, [u8]>>,
) {
    use tauri::http::header::{HeaderValue, CONTENT_SECURITY_POLICY};
    if !served || csp.is_empty() || response.headers().contains_key(CONTENT_SECURITY_POLICY) {
        return;
    }
    if let Ok(value) = HeaderValue::from_str(csp) {
        response
            .headers_mut()
            .insert(CONTENT_SECURITY_POLICY, value);
    }
}

/// A placeholder for the one moment `install` swaps the providers.
struct NoAssets;

impl<R: Runtime> Assets<R> for NoAssets {
    fn get(&self, _key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }

    fn csp_hashes(&self, _html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

/// Puts the resolver in front of the context's bundled assets. Called on the
/// generated context before the builder runs (review O1: Context::set_assets
/// is not stable API, so tauri is pinned exactly in Cargo.toml).
pub fn install<R: Runtime>(context: &mut tauri::Context<R>, state: Arc<ShellState>) {
    let bundled = context.set_assets(Box::new(NoAssets));
    context.set_assets(Box::new(ShellAssets { bundled, state }));
}

// ───────────────────────────── the app ─────────────────────────────

/// The managed handle on the state.
pub struct Shell(pub Arc<ShellState>);

/// Debug builds never serve a shell (updater.rs rule 1).
pub fn enabled() -> bool {
    !cfg!(debug_assertions)
}

fn store_for<R: Runtime>(app: &AppHandle<R>) -> Option<ShellStore> {
    Some(ShellStore::new(
        app.path().app_data_dir().ok()?.join("shells"),
    ))
}

/// The state the resolver reads, as the app manages it.
pub fn shared_state<R: Runtime>(app: &AppHandle<R>) -> Option<Arc<ShellState>> {
    state_of(app)
}

fn state_of<R: Runtime>(app: &AppHandle<R>) -> Option<Arc<ShellState>> {
    app.try_state::<Shell>().map(|shell| shell.0.clone())
}

/// The keys, floor and kept lists, as `select` and `must_leave` read them.
fn with_local<R: Runtime, T>(
    app: &AppHandle<R>,
    use_it: impl FnOnce(&ShellStore, &Local<'_>) -> T,
) -> Result<T, String> {
    let (Some(store), Some(cache)) = (store_for(app), crate::verified_apps::cache_for(app)) else {
        return Err(Refusal::Cache.code().into());
    };
    let (keys, floor) = app_signing::pinned();
    // A list accepted once that no pinned key verifies any more (a rotation,
    // an altered file) is refused here, never treated as no list.
    let Ok(list) = cache.stored_revocations(keys) else {
        return Err(Refusal::RevocationsStale.code().into());
    };
    let local = Local {
        trust: Trust {
            keys,
            floor,
            list: list.as_ref(),
            bridge_version: DESKTOP_BRIDGE_VERSION,
        },
        fleet_enabled: store.fleet_enabled(keys),
        revocations_fresh: store.revocations_fresh(SystemTime::now()),
    };
    Ok(use_it(&store, &local))
}

/// The selection for `address` from disk alone.
fn select_from_disk<R: Runtime>(app: &AppHandle<R>, address: Option<&str>) -> Active {
    if !enabled() {
        return Active::Bundled("dev".into());
    }
    let Some(address) = address else {
        return Active::Bundled("no_server".into());
    };
    with_local(app, |store, local| select(store, address, local)).unwrap_or_else(Active::Bundled)
}

fn log_active(address: Option<&str>, active: &Active) {
    let host = address.map(crate::servers::host_of).unwrap_or_default();
    match active {
        Active::Served(build) => eprintln!("liaison: shell for {host}: served {}", build.build_id),
        Active::Bundled(reason) => eprintln!("liaison: shell for {host}: bundled ({reason})"),
    }
}

/// How long the start waits for the fleet flags, the revocation list and the
/// server's kill switch before it selects a build (review P6 #1). Past it,
/// the kept copies decide (an offline start), within the 72 h rule.
pub const START_DEADLINE: Duration = Duration::from_secs(3);
/// A running window re-reads the lists and its server this often.
pub const REFRESH_EVERY: Duration = Duration::from_secs(15 * 60);
/// The window coming forward re-reads them when the last read is this old.
pub const FOCUS_REFRESH_AFTER: Duration = Duration::from_secs(60);
/// How often the periodic refresh looks at the wall clock.
const REFRESH_TICK: Duration = Duration::from_secs(60);

/// At start, before the window is built: the fleet flags, the revocation
/// list and the server's kill switch, read fresh when the network answers
/// within START_DEADLINE; then the current server's stored build (or
/// bundled); then a full refresh in the background and the periodic one.
pub fn on_start<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = state_of(app) else {
        return;
    };
    let handle = app.clone();
    state.set_on_arm(Box::new(move |build_id, server| {
        arm_ready_timer(handle.clone(), build_id, server)
    }));
    let address = crate::sidecar::resolve_base_url(app);
    if enabled() {
        if let Some(address) = address.as_deref() {
            let started = std::time::Instant::now();
            let read = block_on_within(START_DEADLINE, read_lists_and_server(app, address));
            if read.is_none() {
                eprintln!(
                    "liaison: shell lists not read within {} ms: the kept copies decide",
                    started.elapsed().as_millis()
                );
            }
        }
    }
    let active = select_from_disk(app, address.as_deref());
    log_active(address.as_deref(), &active);
    state.set_active(active);
    state.expect_document();
    if let Some(address) = address {
        spawn_refresh(app.clone(), address);
    }
    spawn_periodic_refresh(app.clone());
}

/// Runs `future` to its end or `deadline` from a thread outside any runtime
/// (the start path). The timer is made INSIDE the runtime `block_on` enters:
/// made outside it, tokio panics ("there is no reactor running").
pub fn block_on_within<T>(deadline: Duration, future: impl Future<Output = T>) -> Option<T> {
    tauri::async_runtime::block_on(async move { tokio::time::timeout(deadline, future).await.ok() })
}

/// The fleet flags, the revocation list and `address`'s kill switch, read
/// and kept (no build fetched).
async fn read_lists_and_server<R: Runtime>(app: &AppHandle<R>, address: &str) {
    let (Some(store), Some(cache), Some(fetcher)) = (
        store_for(app),
        crate::verified_apps::cache_for(app),
        HttpFetcher::new(),
    ) else {
        return;
    };
    let (keys, _) = app_signing::pinned();
    read_lists_then_server(
        &fetcher,
        &store,
        &cache,
        keys,
        &crate::walk_seam::downloads(),
        address,
    )
    .await;
}

/// `refresh_lists`, then the server's shell info (its kill switch kept on its
/// pointer). Pure apart from the fetcher and the stores.
pub async fn read_lists_then_server<F: Fetcher>(
    fetcher: &F,
    store: &ShellStore,
    cache: &crate::verified_apps::VerifiedCache,
    keys: &[PinnedKey],
    downloads: &str,
    server: &str,
) {
    refresh_lists(
        fetcher,
        store,
        cache,
        keys,
        downloads,
        &crate::walk_seam::revocations_url(),
    )
    .await;
    let _ = read_server_shell(fetcher, store, server).await;
}

/// The window moved to `address` and is about to reload: that server's
/// stored build applies at that load, and its server is asked for a newer one.
pub fn on_switch<R: Runtime>(app: &AppHandle<R>, address: Option<&str>) {
    let Some(state) = state_of(app) else {
        return;
    };
    let active = select_from_disk(app, address);
    log_active(address, &active);
    state.stage(active);
    state.expect_document();
    if let Some(address) = address {
        spawn_refresh(app.clone(), address.to_string());
    }
}

/// The main window came forward: the lists are read again when the last read
/// is over a minute old.
pub fn on_focus<R: Runtime>(app: &AppHandle<R>) {
    if !enabled() {
        return;
    }
    let Some(state) = state_of(app) else {
        return;
    };
    if !state.refresh_due(SystemTime::now(), FOCUS_REFRESH_AFTER) {
        return;
    }
    if let Some(address) = crate::sidecar::resolve_base_url(app) {
        spawn_refresh(app.clone(), address);
    }
}

/// The main webview is about to navigate to `url`: a document load of the
/// app's own origin is what may swap a staged build in (review P6 #2).
pub fn on_navigation(state: &ShellState, url: &url::Url) {
    if is_app_document(url) {
        state.expect_document();
    }
}

/// Re-reads the lists and the server every REFRESH_EVERY while the app
/// runs, by the wall clock, so a revocation or a kill switch reaches a
/// window that stays open (review P6 #1) and a machine waking from sleep
/// re-reads them within a minute.
fn spawn_periodic_refresh<R: Runtime>(app: AppHandle<R>) {
    if !enabled() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(REFRESH_TICK).await;
            let Some(state) = state_of(&app) else {
                return;
            };
            if !state.refresh_due(SystemTime::now(), REFRESH_EVERY) {
                continue;
            }
            if let Some(address) = crate::sidecar::resolve_base_url(&app) {
                let _ = refresh(&app, &address).await;
            }
        }
    });
}

fn spawn_refresh<R: Runtime>(app: AppHandle<R>, address: String) {
    if !enabled() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let _ = refresh(&app, &address).await;
    });
}

/// Reads the fleet flags and the revocation list fresh, and notes the list
/// fresh when the one read is the one kept.
pub async fn refresh_lists<F: Fetcher>(
    fetcher: &F,
    store: &ShellStore,
    cache: &crate::verified_apps::VerifiedCache,
    keys: &[PinnedKey],
    downloads: &str,
    revocations_url: &str,
) {
    let flags_url = format!("{downloads}/shell/flags.json");
    if let (Ok(bytes), Ok(sig)) = (
        fetcher.get(&flags_url, MAX_SMALL_BYTES).await,
        fetcher
            .get(&format!("{flags_url}.sig"), MAX_SMALL_BYTES)
            .await,
    ) {
        if let Ok(sig) = String::from_utf8(sig) {
            store.offer_flags(&bytes, &sig, keys);
        }
    }
    if let (Ok(bytes), Ok(sig)) = (
        fetcher.get(revocations_url, MAX_SMALL_BYTES).await,
        fetcher
            .get(&format!("{revocations_url}.sig"), MAX_SMALL_BYTES)
            .await,
    ) {
        if let Ok(sig) = String::from_utf8(sig) {
            let fresh = app_signing::verify_revocation_list(&bytes, &sig, keys);
            let applied = cache.offer_revocations(&bytes, &sig, keys);
            if let (Some(fresh), Ok(Some(applied))) = (fresh, applied) {
                if applied.seq == fresh.seq {
                    store.mark_revocations_fetched(SystemTime::now());
                }
            }
        }
    }
}

/// Asks `address` for its build, keeps it when it verifies, and, when
/// `address` is still the window's server, either stages the new selection
/// for the next load or, when the running build must not run any more,
/// switches and reloads at once. Answers what waits for the next load.
async fn refresh<R: Runtime>(app: &AppHandle<R>, address: &str) -> Option<String> {
    let state = state_of(app)?;
    let _one_at_a_time = state.refreshing.lock().await;
    if let Ok(mut last) = state.last_refresh.lock() {
        *last = Some(SystemTime::now());
    }
    let store = store_for(app)?;
    let cache = crate::verified_apps::cache_for(app)?;
    let fetcher = HttpFetcher::new()?;
    let (keys, floor) = app_signing::pinned();
    let downloads = crate::walk_seam::downloads();
    refresh_lists(
        &fetcher,
        &store,
        &cache,
        keys,
        &downloads,
        &crate::walk_seam::revocations_url(),
    )
    .await;
    let list = cache.stored_revocations(keys).ok();
    let fresh = store.revocations_fresh(SystemTime::now());
    let trust = list.as_ref().filter(|_| fresh).map(|list| Trust {
        keys,
        floor,
        list: list.as_ref(),
        bridge_version: DESKTOP_BRIDGE_VERSION,
    });
    if let Err(refusal) = refresh_pointer(&fetcher, &store, &downloads, address, trust).await {
        eprintln!(
            "liaison: shell for {}: refresh refused ({})",
            crate::servers::host_of(address),
            refusal.code()
        );
    }
    let current = crate::sidecar::resolve_base_url(app);
    if current
        .as_deref()
        .is_some_and(|c| crate::servers::same_server(c, address))
    {
        apply_refresh(app, &state, address);
    }
    state.pending_report()
}

fn apply_refresh<R: Runtime>(app: &AppHandle<R>, state: &ShellState, address: &str) {
    if !enabled() {
        return;
    }
    let active = state.active_served();
    let decision = with_local(app, |store, local| {
        after_refresh(store, address, local, active.as_deref())
    });
    match decision {
        Ok(AfterRefresh::Stage(next)) => state.stage(next),
        Ok(AfterRefresh::Leave { next, reason }) => {
            // A SECURITY RELOAD, the one exception to S6's "a newer build
            // waits for the next natural load or an idle, clean page": the
            // running build was revoked, fell below the shell floor, lost its
            // key, or a kill switch was flipped. It keeps the native bridge
            // for as long as it runs, so it stops NOW, even over a draft.
            eprintln!(
                "liaison: served shell {} must stop ({reason}): reloading",
                active.as_ref().map_or("?", |b| b.build_id.as_str())
            );
            log_active(Some(address), &next);
            state.set_active(next);
            reload_main(app, state);
        }
        // The stores cannot be read: the running build stays until the next
        // load, which then selects from disk (and falls back to bundled).
        Err(reason) => state.stage(Active::Bundled(reason)),
    }
}

/// Reloads the main window as a document load the resolver expects.
fn reload_main<R: Runtime>(app: &AppHandle<R>, state: &ShellState) {
    state.expect_document();
    if let Some(window) = app.get_webview_window(crate::tray::MAIN_WINDOW) {
        let _ = window.reload();
    }
}

fn arm_ready_timer<R: Runtime>(app: AppHandle<R>, build_id: String, server: String) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(READY_WITHIN).await;
        let Some(state) = state_of(&app) else {
            return;
        };
        let still_running = state
            .active_served()
            .is_some_and(|b| b.build_id == build_id && b.server == server);
        if state.is_ready(&build_id) || !still_running {
            return;
        }
        missed_ready(&app, &state, &build_id, &server);
    });
}

/// The pointer after one missed ready of `build_id`: counted, and the build
/// quarantined at the second miss (D9). True when it was quarantined.
pub fn note_miss(pointer: &mut Pointer, build_id: &str) -> bool {
    let misses = pointer.misses.entry(build_id.to_string()).or_insert(0);
    *misses += 1;
    if *misses < MISSES_TO_QUARANTINE {
        return false;
    }
    pointer.misses.remove(build_id);
    if !pointer.quarantined.iter().any(|q| q == build_id) {
        pointer.quarantined.push(build_id.to_string());
    }
    if pointer.last_good.as_deref() == Some(build_id) {
        pointer.last_good = None;
    }
    true
}

/// The pointer after `build_id` signalled ready.
pub fn note_good(pointer: &mut Pointer, build_id: &str) {
    pointer.last_good = Some(build_id.to_string());
    pointer.misses.remove(build_id);
}

fn missed_ready<R: Runtime>(app: &AppHandle<R>, state: &ShellState, build_id: &str, server: &str) {
    let Some(store) = store_for(app) else {
        return;
    };
    let mut quarantined = false;
    let _ = store.update_pointer(server, |pointer| {
        quarantined = note_miss(pointer, build_id);
        true
    });
    if quarantined {
        eprintln!("liaison: served shell {build_id} never signalled ready twice: quarantined");
        let next = select_from_disk(app, Some(server));
        log_active(Some(server), &next);
        state.set_active(next);
    } else {
        eprintln!("liaison: served shell {build_id} did not signal ready in time: reloading once");
        state.disarm();
    }
    reload_main(app, state);
}

/// The page rendered (web startup.ts). Marks the build good for the server
/// it was selected for.
#[tauri::command]
pub fn shell_ready<R: Runtime>(app: AppHandle<R>, build_id: String) {
    let Some(state) = state_of(&app) else {
        return;
    };
    let Some(server) = state.note_ready(&build_id) else {
        return;
    };
    if let Some(store) = store_for(&app) {
        let _ = store.update_pointer(&server, |pointer| {
            let changed = pointer.last_good.as_deref() != Some(build_id.as_str())
                || pointer.misses.contains_key(&build_id);
            if changed {
                note_good(pointer, &build_id);
            }
            changed
        });
    }
}

/// What the window runs: served (and which build) or bundled (and why).
#[tauri::command]
pub fn shell_status<R: Runtime>(app: AppHandle<R>) -> ShellStatus {
    state_of(&app)
        .map(|state| state.status())
        .unwrap_or(ShellStatus {
            served: false,
            build_id: None,
            reason: Some("state".into()),
            pending: false,
        })
}

/// The page saw a newer server build: refresh now. Answers what runs at the
/// next load when something is staged: a build id, or PENDING_BUNDLED.
#[tauri::command]
pub async fn refresh_shell<R: Runtime>(app: AppHandle<R>) -> Option<String> {
    if !enabled() {
        return None;
    }
    let address = crate::sidecar::resolve_base_url(&app)?;
    refresh(&app, &address).await
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod csp_tests;
