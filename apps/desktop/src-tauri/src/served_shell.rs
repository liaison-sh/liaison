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
//
// LAST GOOD AND QUARANTINE (D9, S8). A served build that has not called
// `shell_ready` 20 s after it first loaded is reloaded once; a second miss
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
/// The most a build may weigh, every fetched file together.
pub const MAX_BUILD_BYTES: usize = 30 * 1024 * 1024;
/// A statement lists ~700 files: well under this.
const MAX_SMALL_BYTES: usize = 2 * 1024 * 1024;
/// A served build runs only on a revocation list this young (D7a, A1).
pub const REVOCATIONS_MAX_AGE: Duration = Duration::from_secs(72 * 3600);
/// How long a served build has to call `shell_ready` after it loaded.
pub const READY_WITHIN: Duration = Duration::from_secs(20);
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
    Mode,
    BuildId,
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
            Refusal::Mode => "mode",
            Refusal::BuildId => "build_id",
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
        return Err(Refusal::Mode);
    }
    if statement.build_id != build_id {
        return Err(Refusal::BuildId);
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

fn now_secs(now: SystemTime) -> u64 {
    now.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(tmp, path)
}

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

    pub fn save_pointer(&self, address: &str, pointer: &Pointer) -> std::io::Result<()> {
        let bytes = serde_json::to_vec(pointer).map_err(std::io::Error::other)?;
        write_atomically(&self.pointer_path(address), &bytes)
    }

    /// The stored statement and signature of a build.
    pub fn record(&self, build_id: &str) -> Option<(Vec<u8>, String)> {
        let bytes = std::fs::read(self.record_path(build_id)?).ok()?;
        let record: StatementRecord = serde_json::from_slice(&bytes).ok()?;
        Some((record.statement.into_bytes(), record.sig))
    }

    pub fn has_blob(&self, sha: &str) -> bool {
        is_hex(sha, 64) && self.blobs().join(sha).is_file()
    }

    /// A blob's bytes, only while they still hash to their name.
    pub fn read_blob(&self, sha: &str) -> Option<Vec<u8>> {
        if !is_hex(sha, 64) {
            return None;
        }
        let bytes = std::fs::read(self.blobs().join(sha)).ok()?;
        (app_signing::sha256_hex(&bytes) == sha).then_some(bytes)
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
                let target = self.blobs().join(sha);
                if !target.is_file() {
                    std::fs::rename(tmp.join(sha), target)?;
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

    /// The fleet flags last accepted, re-verified.
    pub fn flags(&self, keys: &[PinnedKey]) -> Option<Flags> {
        let stored: Value = serde_json::from_slice(&std::fs::read(self.flags_path()).ok()?).ok()?;
        verify_flags(
            stored["flags"].as_str()?.as_bytes(),
            stored["sig"].as_str()?,
            keys,
        )
    }

    /// Keeps newly read flags when they verify and do not go back in `seq`,
    /// and answers the flags to apply. `None` when there are none (on).
    pub fn offer_flags(&self, bytes: &[u8], sig: &str, keys: &[PinnedKey]) -> Option<Flags> {
        let stored = self.flags(keys);
        let Some(flags) = verify_flags(bytes, sig, keys) else {
            return stored;
        };
        if stored.is_some_and(|s| flags.seq < s.seq) {
            return stored;
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
    files: HashMap<String, String>,
    blobs: PathBuf,
    html_hashes: HashMap<String, Vec<String>>,
}

impl ServedBuild {
    /// A listed file's bytes, re-hashed: None for an unlisted path or a blob
    /// that no longer matches.
    pub fn read(&self, path: &str) -> Option<Vec<u8>> {
        let sha = self.files.get(path)?;
        let bytes = std::fs::read(self.blobs.join(sha)).ok()?;
        (app_signing::sha256_hex(&bytes) == *sha).then_some(bytes)
    }

    pub fn csp_hashes(&self, path: &str) -> Vec<String> {
        self.html_hashes.get(path).cloned().unwrap_or_default()
    }
}

/// Re-checks a stored build from disk alone (no network): its statement
/// against `trust` and every blob present.
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
    for (path, sha) in &statement.files {
        if !store.has_blob(sha) {
            return Err(Refusal::MissingFile);
        }
        if path.ends_with(".html") {
            let bytes = store.read_blob(sha).ok_or(Refusal::MissingFile)?;
            let html = String::from_utf8_lossy(&bytes);
            html_hashes.insert(path.clone(), inline_script_hashes(&html));
        }
    }
    Ok(ServedBuild {
        build_id: build_id.to_string(),
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
            Ok(build) => return Active::Served(Arc::new(build)),
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

// ───────────────────────────── fetching ─────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FetchError {
    NotFound,
    Failed,
    TooLarge,
}

/// One GET, its body refused past `limit` bytes.
pub trait Fetcher: Sync {
    fn get(
        &self,
        url: &str,
        limit: usize,
    ) -> impl Future<Output = Result<Vec<u8>, FetchError>> + Send;
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
    if !is_hex(build_id, 16) {
        return Err(Refusal::BuildId);
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
    let budget = Mutex::new(MAX_BUILD_BYTES);
    use futures_util::stream::{self, StreamExt, TryStreamExt};
    let fetched: Vec<(String, Vec<u8>)> = stream::iter(wanted)
        .map(|(url, sha)| {
            let budget = &budget;
            async move {
                let limit = budget
                    .lock()
                    .map(|left| *left)
                    .map_err(|_| Refusal::Cache)?;
                let bytes = fetcher.get(&url, limit).await.map_err(|e| match e {
                    FetchError::TooLarge => Refusal::TooLarge,
                    _ => Refusal::Fetch,
                })?;
                {
                    let mut left = budget.lock().map_err(|_| Refusal::Cache)?;
                    *left = left.checked_sub(bytes.len()).ok_or(Refusal::TooLarge)?;
                }
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
    let info_url = file_url(server, "api/shell/info").ok_or(Refusal::Fetch)?;
    let info = fetcher
        .get(&info_url, MAX_SMALL_BYTES)
        .await
        .ok()
        .and_then(|bytes| parse_shell_info(&bytes))
        .ok_or(Refusal::Fetch)?;
    let mut pointer = store.pointer(server);
    if pointer.served_shell != Some(info.served_shell) {
        pointer.served_shell = Some(info.served_shell);
        store
            .save_pointer(server, &pointer)
            .map_err(|_| Refusal::Cache)?;
    }
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
    pointer.current = Some(build_id.clone());
    pointer.misses.remove(&build_id);
    store
        .save_pointer(server, &pointer)
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
    /// The served build whose ready timer is running.
    armed: Option<String>,
    /// Builds that called `shell_ready` in this process.
    ready: HashSet<String>,
}

/// The main window's build, shared by the asset resolver and the commands.
pub struct ShellState {
    selection: RwLock<Selection>,
    /// Called (off the lock) with a served build's id when it starts its
    /// ready window.
    on_arm: OnceLock<Box<dyn Fn(String) + Send + Sync>>,
    /// CspHash borrows its string: the few distinct hashes ever served live
    /// for the process.
    interned: Mutex<HashSet<&'static str>>,
    refreshing: tokio::sync::Mutex<()>,
}

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
                armed: None,
                ready: HashSet::new(),
            }),
            on_arm: OnceLock::new(),
            interned: Mutex::new(HashSet::new()),
            refreshing: tokio::sync::Mutex::new(()),
        })
    }

    pub fn set_on_arm(&self, hook: Box<dyn Fn(String) + Send + Sync>) {
        let _ = self.on_arm.set(hook);
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

    /// The pending build id, when a served build is pending.
    pub fn pending_build(&self) -> Option<String> {
        let sel = self.selection.read().ok()?;
        sel.pending.as_ref()?.build_id().map(str::to_string)
    }

    pub fn active_build(&self) -> Option<String> {
        let sel = self.selection.read().ok()?;
        sel.active.build_id().map(str::to_string)
    }

    /// The page says it rendered. True when it is the active served build.
    pub fn note_ready(&self, build_id: &str) -> bool {
        let Ok(mut sel) = self.selection.write() else {
            return false;
        };
        if sel.active.build_id() != Some(build_id) {
            return false;
        }
        sel.ready.insert(build_id.to_string());
        true
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
            if path == "index.html" {
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
            if path == "index.html"
                && sel.armed.as_deref() != Some(build.build_id.as_str())
                && !sel.ready.contains(&build.build_id)
            {
                sel.armed = Some(build.build_id.clone());
                armed = Some(build.build_id.clone());
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
        if let (Some(build_id), Some(hook), true) = (armed, self.on_arm.get(), bytes.is_some()) {
            hook(build_id);
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
/// build's index.html, never to a bundled file (D15).
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

fn state_of<R: Runtime>(app: &AppHandle<R>) -> Option<Arc<ShellState>> {
    app.try_state::<Shell>().map(|shell| shell.0.clone())
}

/// The selection for `address` from disk alone.
fn select_from_disk<R: Runtime>(app: &AppHandle<R>, address: Option<&str>) -> Active {
    if !enabled() {
        return Active::Bundled("dev".into());
    }
    let Some(address) = address else {
        return Active::Bundled("no_server".into());
    };
    let (Some(store), Some(cache)) = (store_for(app), crate::verified_apps::cache_for(app)) else {
        return Active::Bundled(Refusal::Cache.code().into());
    };
    let (keys, floor) = app_signing::pinned();
    let Ok(list) = cache.stored_revocations(keys) else {
        return Active::Bundled(Refusal::RevocationsStale.code().into());
    };
    let local = Local {
        trust: Trust {
            keys,
            floor,
            list: list.as_ref(),
            bridge_version: DESKTOP_BRIDGE_VERSION,
        },
        fleet_enabled: store.flags(keys).map_or(true, |flags| flags.desktop),
        revocations_fresh: store.revocations_fresh(SystemTime::now()),
    };
    select(&store, address, &local)
}

fn log_active(address: Option<&str>, active: &Active) {
    let host = address.map(crate::servers::host_of).unwrap_or_default();
    match active {
        Active::Served(build) => eprintln!("liaison: shell for {host}: served {}", build.build_id),
        Active::Bundled(reason) => eprintln!("liaison: shell for {host}: bundled ({reason})"),
    }
}

/// At start, before the window is built: the current server's stored build
/// (or bundled), then a refresh in the background.
pub fn on_start<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = state_of(app) else {
        return;
    };
    let handle = app.clone();
    state.set_on_arm(Box::new(move |build_id| {
        arm_ready_timer(handle.clone(), build_id)
    }));
    let address = crate::sidecar::resolve_base_url(app);
    let active = select_from_disk(app, address.as_deref());
    log_active(address.as_deref(), &active);
    state.set_active(active);
    if let Some(address) = address {
        spawn_refresh(app.clone(), address);
    }
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
    if let Some(address) = address {
        spawn_refresh(app.clone(), address.to_string());
    }
}

fn spawn_refresh<R: Runtime>(app: AppHandle<R>, address: String) {
    if !enabled() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let _ = refresh(&app, &address).await;
    });
}

/// Reads the fleet flags and the revocation list fresh; answers whether the
/// list is fresh enough to verify with.
async fn refresh_lists<F: Fetcher>(
    fetcher: &F,
    store: &ShellStore,
    cache: &crate::verified_apps::VerifiedCache,
    keys: &[PinnedKey],
) {
    let flags_url = format!("{DOWNLOADS}/shell/flags.json");
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
    let url = crate::verified_apps::REVOCATIONS_URL;
    if let (Ok(bytes), Ok(sig)) = (
        fetcher.get(url, MAX_SMALL_BYTES).await,
        fetcher.get(&format!("{url}.sig"), MAX_SMALL_BYTES).await,
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

/// Asks `address` for its build, keeps it when it verifies, and stages the
/// new selection when `address` is still the window's server. Answers the
/// pending build id, if any.
async fn refresh<R: Runtime>(app: &AppHandle<R>, address: &str) -> Option<String> {
    let state = state_of(app)?;
    let _one_at_a_time = state.refreshing.lock().await;
    let store = store_for(app)?;
    let cache = crate::verified_apps::cache_for(app)?;
    let fetcher = HttpFetcher::new()?;
    let (keys, floor) = app_signing::pinned();
    refresh_lists(&fetcher, &store, &cache, keys).await;
    let list = cache.stored_revocations(keys).ok();
    let fresh = store.revocations_fresh(SystemTime::now());
    let trust = list.as_ref().filter(|_| fresh).map(|list| Trust {
        keys,
        floor,
        list: list.as_ref(),
        bridge_version: DESKTOP_BRIDGE_VERSION,
    });
    if let Err(refusal) = refresh_pointer(&fetcher, &store, DOWNLOADS, address, trust).await {
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
        let next = select_from_disk(app, Some(address));
        state.stage(next);
    }
    state.pending_build()
}

fn reload_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(crate::tray::MAIN_WINDOW) {
        let _ = window.reload();
    }
}

fn arm_ready_timer<R: Runtime>(app: AppHandle<R>, build_id: String) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(READY_WITHIN).await;
        let Some(state) = state_of(&app) else {
            return;
        };
        if state.is_ready(&build_id) || state.active_build().as_deref() != Some(build_id.as_str()) {
            return;
        }
        missed_ready(&app, &state, &build_id);
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

fn missed_ready<R: Runtime>(app: &AppHandle<R>, state: &ShellState, build_id: &str) {
    let address = crate::sidecar::resolve_base_url(app);
    let (Some(store), Some(address)) = (store_for(app), address) else {
        return;
    };
    let mut pointer = store.pointer(&address);
    let quarantined = note_miss(&mut pointer, build_id);
    let _ = store.save_pointer(&address, &pointer);
    if quarantined {
        eprintln!("liaison: served shell {build_id} never signalled ready twice: quarantined");
        let next = select_from_disk(app, Some(&address));
        log_active(Some(&address), &next);
        state.set_active(next);
    } else {
        eprintln!("liaison: served shell {build_id} did not signal ready in time: reloading once");
        state.disarm();
    }
    reload_main(app);
}

/// The page rendered (web startup.ts). Marks the build good for its server.
#[tauri::command]
pub fn shell_ready<R: Runtime>(app: AppHandle<R>, build_id: String) {
    let Some(state) = state_of(&app) else {
        return;
    };
    if !state.note_ready(&build_id) {
        return;
    }
    if let (Some(store), Some(address)) = (store_for(&app), crate::sidecar::resolve_base_url(&app))
    {
        let mut pointer = store.pointer(&address);
        if pointer.last_good.as_deref() != Some(build_id.as_str())
            || pointer.misses.contains_key(&build_id)
        {
            note_good(&mut pointer, &build_id);
            let _ = store.save_pointer(&address, &pointer);
        }
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

/// The page saw a newer server build: refresh now. Answers the build that
/// will run at the next load, when one is pending.
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

