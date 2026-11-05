// SPDX-License-Identifier: FSL-1.1-ALv2
//
// VERIFIED FIRST-PARTY APP UIs, SERVED TO THE PAGE BY HASH (S13, A8).
//
// apps/web asks `verify_first_party_app(name, version)` for an app the server
// lists as `signed: true`. The shell then, on its own:
//
// 1. fetches `ui.js`, `statement.json`, `statement.sig` and `manifest.json` of
//    that version from the BOUND server (`/api/apps/<name>/<version>/…`, no
//    redirect followed), never from an address the page names;
// 2. checks them against the keys and floor compiled into this build and the
//    latest signed revocation list it has seen (app_signing.rs);
// 3. keeps the verified bundle in a content-addressed cache in the app data
//    folder (`verified-apps/<sha256>.js`, the last 3 versions per app);
// 4. answers the `liaison-app:` URL of those bytes and the verified manifest.
//
// The page then `import()`s that URL: the window's `script-src` names the
// `liaison-app:` scheme and nothing remote, and the scheme serves a file only
// by its sha256 (a 64-hex name the cache index holds, re-hashed on every read),
// 404 for anything else. So the bytes that run in the page are bytes this shell
// verified, whatever the server sends afterwards. Any refusal answers an error
// and the page runs the app in the sandbox frame instead (never a broken app).
//
// Revocations: `apps/revocations.json` + `.sig` on Liaison's downloads host,
// read at most once an hour, kept only when signed by a pinned key and its
// `seq` is not older than the one stored (a replayed list cannot un-revoke a
// version). Unreachable: the stored list and the compiled floor still apply.

use std::borrow::Cow;
use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext};

use crate::app_signing::{self, Artifact, RevocationList};

/// The scheme verified bundles are served on.
pub const APP_SCHEME: &str = "liaison-app";

/// The scheme's base URL as the page reaches it (WebView2 has no custom
/// schemes: Windows serves `http://<scheme>.localhost`, like liaison-frame).
pub fn app_url_base() -> &'static str {
    if cfg!(windows) {
        "http://liaison-app.localhost/"
    } else {
        "liaison-app://localhost/"
    }
}

/// Bundles of the last few versions of each app stay; older ones are deleted.
pub const KEEP_VERSIONS: usize = 3;

const REVOCATIONS_URL: &str = "https://downloads.liaison.sh/apps/revocations.json";
const REVOCATIONS_EVERY: Duration = Duration::from_secs(3600);
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_UI_BYTES: usize = 16 * 1024 * 1024;
const MAX_SMALL_BYTES: usize = 512 * 1024;

fn is_sha256_hex(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && name.len() <= 100
}

/// `\d+\.\d+\.\d+(-[\w.]+)?`, as the server's route accepts.
fn valid_version(version: &str) -> bool {
    let (core, pre) = match version.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (version, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        && pre.map_or(true, |p| {
            !p.is_empty()
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.')
        })
        && version.len() <= 64
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
struct CachedVersion {
    version: String,
    sha256: String,
}

/// The cache index: per app, its kept versions, newest first.
#[derive(Serialize, Deserialize, Default, Debug)]
struct CacheIndex {
    apps: std::collections::BTreeMap<String, Vec<CachedVersion>>,
}

/// The content-addressed store of verified bundles.
pub struct VerifiedCache {
    dir: PathBuf,
}

impl VerifiedCache {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn index_path(&self) -> PathBuf {
        self.dir.join("index.json")
    }

    fn read_index(&self) -> CacheIndex {
        std::fs::read(self.index_path())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn write_atomically(&self, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(tmp, path)
    }

    /// Keeps verified `bytes` (whose sha256 is `sha256`) as `name@version`, and
    /// prunes the app to its last `KEEP_VERSIONS` versions.
    pub fn store(
        &self,
        name: &str,
        version: &str,
        sha256: &str,
        bytes: &[u8],
    ) -> std::io::Result<()> {
        if !is_sha256_hex(sha256) || app_signing::sha256_hex(bytes) != sha256 {
            return Err(std::io::Error::other("bytes do not match their hash"));
        }
        std::fs::create_dir_all(&self.dir)?;
        let file = self.dir.join(format!("{sha256}.js"));
        if !file.exists() {
            self.write_atomically(&file, bytes)?;
        }
        let mut index = self.read_index();
        let versions = index.apps.entry(name.to_string()).or_default();
        versions.retain(|v| v.version != version);
        versions.insert(
            0,
            CachedVersion {
                version: version.to_string(),
                sha256: sha256.to_string(),
            },
        );
        versions.truncate(KEEP_VERSIONS);
        let kept: BTreeSet<String> = index
            .apps
            .values()
            .flatten()
            .map(|v| v.sha256.clone())
            .collect();
        self.write_atomically(
            &self.index_path(),
            &serde_json::to_vec(&index).map_err(std::io::Error::other)?,
        )?;
        for entry in std::fs::read_dir(&self.dir)?.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if let Some(sha) = file_name.strip_suffix(".js") {
                if !kept.contains(sha) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        Ok(())
    }

    /// The bytes stored under `sha256`, only when this process verified that
    /// hash (`verified`), the index holds it and the file still hashes to it. A
    /// hash on disk from an earlier run, or written there by anything else, is
    /// not served until `verify_first_party_app` checks its statement again.
    pub fn read(&self, sha256: &str, verified: &HashSet<String>) -> Option<Vec<u8>> {
        if !is_sha256_hex(sha256) || !verified.contains(sha256) {
            return None;
        }
        let index = self.read_index();
        if !index.apps.values().flatten().any(|v| v.sha256 == sha256) {
            return None;
        }
        let bytes = std::fs::read(self.dir.join(format!("{sha256}.js"))).ok()?;
        (app_signing::sha256_hex(&bytes) == sha256).then_some(bytes)
    }

    fn revocations_path(&self) -> PathBuf {
        self.dir.join("revocations.signed.json")
    }

    fn highest_seq_path(&self) -> PathBuf {
        self.dir.join("revocations.seq")
    }

    /// The highest revocation `seq` this install ever accepted (0 when none).
    fn highest_seq(&self) -> u64 {
        std::fs::read_to_string(self.highest_seq_path())
            .ok()
            .and_then(|text| text.trim().parse().ok())
            .unwrap_or(0)
    }

    /// The stored signed list (list and signature in ONE file), re-verified.
    fn stored_list(&self, keys: &[app_signing::PinnedKey]) -> Option<RevocationList> {
        let stored: Value =
            serde_json::from_slice(&std::fs::read(self.revocations_path()).ok()?).ok()?;
        let list = stored["list"].as_str()?;
        let sig = stored["sig"].as_str()?;
        app_signing::verify_revocation_list(list.as_bytes(), sig, keys)
    }

    /// The list to apply: the stored one when it verifies and is the highest
    /// ever accepted. `Err` when a list was accepted once and no valid list at
    /// that `seq` or above is held any more (tampered or lost): the caller
    /// then refuses, rather than run a version that list may revoke.
    pub fn stored_revocations(
        &self,
        keys: &[app_signing::PinnedKey],
    ) -> Result<Option<RevocationList>, ()> {
        let highest = self.highest_seq();
        match self.stored_list(keys) {
            Some(list) if list.seq >= highest => Ok(Some(list)),
            _ if highest > 0 => Err(()),
            _ => Ok(None),
        }
    }

    /// Keeps `bytes` when they verify and their `seq` is not below the highest
    /// ever accepted (a replayed list cannot un-revoke a version), and answers
    /// the list to apply.
    pub fn offer_revocations(
        &self,
        bytes: &[u8],
        sig: &str,
        keys: &[app_signing::PinnedKey],
    ) -> Result<Option<RevocationList>, ()> {
        let Some(list) = app_signing::verify_revocation_list(bytes, sig, keys) else {
            return self.stored_revocations(keys);
        };
        if list.seq < self.highest_seq() {
            return self.stored_revocations(keys);
        }
        let Ok(text) = std::str::from_utf8(bytes) else {
            return self.stored_revocations(keys);
        };
        let record = serde_json::json!({ "list": text, "sig": sig.trim() });
        let saved = std::fs::create_dir_all(&self.dir).is_ok()
            && self
                .write_atomically(&self.revocations_path(), record.to_string().as_bytes())
                .is_ok()
            && self
                .write_atomically(&self.highest_seq_path(), list.seq.to_string().as_bytes())
                .is_ok();
        // Unsaved, it still applies for this run.
        let _ = saved;
        Ok(Some(list))
    }
}

/// This run's state: when the revocation list was last asked for, and the
/// hashes verified in THIS process (the only ones the scheme serves).
#[derive(Default)]
pub struct VerifiedApps {
    revocations_checked: Mutex<Option<Instant>>,
    store: Mutex<()>,
    verified: Mutex<HashSet<String>>,
}

fn cache_for<R: Runtime>(app: &AppHandle<R>) -> Option<VerifiedCache> {
    let dir = app.path().app_data_dir().ok()?.join("verified-apps");
    Some(VerifiedCache::new(dir))
}

/// What the page imports, and the manifest to register the app from.
#[derive(Serialize, Debug)]
pub struct VerifiedApp {
    pub url: String,
    pub sha256: String,
    pub manifest: serde_json::Value,
}

/// GETs `url` and answers its body, refused past `limit` bytes: a declared
/// length over the cap is refused before any of the body is read, and a body
/// without one is read chunk by chunk and abandoned the moment it passes it.
async fn fetch(client: &reqwest::Client, url: &str, limit: usize) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "fetch".to_string())?;
    if response.status() != reqwest::StatusCode::OK {
        return Err("fetch".into());
    }
    if response
        .content_length()
        .is_some_and(|declared| declared > limit as u64)
    {
        return Err("too_large".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "fetch".to_string())? {
        if body.len() + chunk.len() > limit {
            return Err("too_large".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// The bound server's API base for one app version: built here, from the
/// shell's own record of the server, never from a URL the page hands in.
pub fn artifact_base(server: &str, name: &str, version: &str) -> Option<String> {
    let parsed = url::Url::parse(server.trim()).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    if !valid_name(name) || !valid_version(version) {
        return None;
    }
    Some(format!(
        "{}/api/apps/{name}/{version}/",
        server.trim().trim_end_matches('/')
    ))
}

async fn current_revocations<R: Runtime>(
    app: &AppHandle<R>,
    cache: &VerifiedCache,
    client: &reqwest::Client,
    keys: &[app_signing::PinnedKey],
) -> Result<Option<RevocationList>, ()> {
    let due = {
        let state = app.state::<VerifiedApps>();
        let mut checked = state.revocations_checked.lock().map_err(|_| ())?;
        let due = checked.map_or(true, |at| at.elapsed() >= REVOCATIONS_EVERY);
        if due {
            *checked = Some(Instant::now());
        }
        due
    };
    if due && !keys.is_empty() {
        let list = fetch(client, REVOCATIONS_URL, MAX_SMALL_BYTES).await;
        let sig = fetch(client, &format!("{REVOCATIONS_URL}.sig"), MAX_SMALL_BYTES).await;
        if let (Ok(list), Ok(sig)) = (list, sig) {
            if let Ok(sig) = String::from_utf8(sig) {
                return cache.offer_revocations(&list, &sig, keys);
            }
        }
    }
    cache.stored_revocations(keys)
}

/// Verifies one first-party app version from the bound server and answers
/// where its verified bundle is served. An `Err` is a refusal code; the page
/// then runs the app in the sandbox frame.
#[tauri::command]
pub async fn verify_first_party_app<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    version: String,
) -> Result<VerifiedApp, String> {
    let (keys, floor) = app_signing::pinned();
    if keys.is_empty() {
        return Err(app_signing::Refusal::NoKeys.code().into());
    }
    let server = crate::sidecar::resolve_base_url(&app).ok_or("no_server")?;
    let base = artifact_base(&server, &name, &version).ok_or("invalid_app")?;
    let cache = cache_for(&app).ok_or("no_cache")?;
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        // The files come from the bound server, or not at all.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "fetch".to_string())?;
    let statement = fetch(&client, &format!("{base}statement.json"), MAX_SMALL_BYTES).await?;
    let signature =
        String::from_utf8(fetch(&client, &format!("{base}statement.sig"), MAX_SMALL_BYTES).await?)
            .map_err(|_| app_signing::Refusal::BadSignature.code().to_string())?;
    let manifest = fetch(&client, &format!("{base}manifest.json"), MAX_SMALL_BYTES).await?;
    let ui = fetch(&client, &format!("{base}ui.js"), MAX_UI_BYTES).await?;
    let revocations = current_revocations(&app, &cache, &client, keys)
        .await
        .map_err(|_| "revocations_unavailable".to_string())?;
    let verified = app_signing::verify_artifact(
        &Artifact {
            name: &name,
            version: &version,
            statement: &statement,
            signature: &signature,
            ui: &ui,
            manifest: &manifest,
        },
        keys,
        floor,
        revocations.as_ref(),
    )
    .map_err(|refusal| refusal.code().to_string())?;
    {
        let state = app.state::<VerifiedApps>();
        let _guard = state.store.lock().map_err(|_| "cache".to_string())?;
        cache
            .store(&name, &version, &verified.ui_sha256, &ui)
            .map_err(|_| "cache".to_string())?;
        state
            .verified
            .lock()
            .map_err(|_| "cache".to_string())?
            .insert(verified.ui_sha256.clone());
    }
    Ok(VerifiedApp {
        url: format!("{}{}.js", app_url_base(), verified.ui_sha256),
        sha256: verified.ui_sha256,
        manifest: verified.manifest,
    })
}

fn not_found() -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header("Content-Type", "text/plain")
        .header("Access-Control-Allow-Origin", "*")
        .body(Cow::Borrowed(&b"not found"[..]))
        .expect("a static response")
}

/// The answer for one request on the scheme: `/<sha256>.js` from the cache, else 404.
pub fn answer(
    path: &str,
    cache: Option<&VerifiedCache>,
    verified: &HashSet<String>,
) -> Response<Cow<'static, [u8]>> {
    let Some(sha) = path
        .strip_prefix('/')
        .and_then(|rest| rest.strip_suffix(".js"))
    else {
        return not_found();
    };
    let Some(bytes) = cache.and_then(|cache| cache.read(sha, verified)) else {
        return not_found();
    };
    Response::builder()
        .status(StatusCode::OK)
        // A module script needs a JavaScript MIME type, and the page's origin
        // (tauri://localhost) is not this scheme's: CORS has to allow it. The
        // bytes are public, verified code.
        .header("Content-Type", "text/javascript; charset=utf-8")
        .header("Access-Control-Allow-Origin", "*")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-cache")
        .body(Cow::Owned(bytes))
        .expect("a well formed response")
}

/// The `register_uri_scheme_protocol` handler.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    if request.method() != tauri::http::Method::GET {
        return not_found();
    }
    let cache = cache_for(ctx.app_handle());
    let state = ctx.app_handle().state::<VerifiedApps>();
    let Ok(verified) = state.verified.lock() else {
        return not_found();
    };
    answer(request.uri().path(), cache.as_ref(), &verified)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_signing::testing::TestKey;

    fn temp_dir(label: &str) -> PathBuf {
        let mut bytes = [0u8; 8];
        getrandom::fill(&mut bytes).unwrap();
        let suffix: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        std::env::temp_dir().join(format!("liaison-verified-apps-{label}-{suffix}"))
    }

    fn body(response: &Response<Cow<'static, [u8]>>) -> Vec<u8> {
        response.body().to_vec()
    }

    fn set(hashes: &[&String]) -> HashSet<String> {
        hashes.iter().map(|h| (*h).clone()).collect()
    }

    #[test]
    fn a_verified_bundle_is_served_by_its_hash_and_nothing_else_is() {
        let dir = temp_dir("serve");
        let cache = VerifiedCache::new(dir.clone());
        let ui = b"export const Panel = 1\n";
        let sha = app_signing::sha256_hex(ui);
        cache.store("boxtal", "1.0.0", &sha, ui).unwrap();
        let verified = set(&[&sha]);
        let ok = answer(&format!("/{sha}.js"), Some(&cache), &verified);
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(body(&ok), ui);
        assert!(ok
            .headers()
            .get("Content-Type")
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("text/javascript"));
        // An unknown hash, a name that is not a hash, another path: 404.
        let unknown = app_signing::sha256_hex(b"other");
        for path in [
            format!("/{unknown}.js"),
            format!("/{}.js", sha.to_uppercase()),
            format!("/{sha}"),
            "/index.json".to_string(),
            "/../index.json".to_string(),
            "/".to_string(),
        ] {
            assert_eq!(
                answer(&path, Some(&cache), &verified).status(),
                StatusCode::NOT_FOUND,
                "{path}"
            );
        }
        // A file changed on disk after it was verified is not served.
        std::fs::write(dir.join(format!("{sha}.js")), b"export const Panel = 2\n").unwrap();
        assert_eq!(
            answer(&format!("/{sha}.js"), Some(&cache), &verified).status(),
            StatusCode::NOT_FOUND
        );
        // A file dropped into the folder without passing verification is not served.
        let dropped = b"alert(1)";
        let dropped_sha = app_signing::sha256_hex(dropped);
        std::fs::write(dir.join(format!("{dropped_sha}.js")), dropped).unwrap();
        assert_eq!(
            answer(&format!("/{dropped_sha}.js"), Some(&cache), &verified).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            answer(&format!("/{sha}.js"), None, &verified).status(),
            StatusCode::NOT_FOUND
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn bytes_that_do_not_match_their_hash_are_never_stored() {
        let dir = temp_dir("mismatch");
        let cache = VerifiedCache::new(dir.clone());
        let sha = app_signing::sha256_hex(b"a");
        assert!(cache.store("boxtal", "1.0.0", &sha, b"b").is_err());
        assert!(cache.read(&sha, &set(&[&sha])).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_cache_keeps_the_last_three_versions_of_each_app() {
        let dir = temp_dir("bound");
        let cache = VerifiedCache::new(dir.clone());
        let mut shas = Vec::new();
        for minor in 0..5 {
            let ui = format!("export const v = {minor}\n");
            let sha = app_signing::sha256_hex(ui.as_bytes());
            cache
                .store("boxtal", &format!("1.{minor}.0"), &sha, ui.as_bytes())
                .unwrap();
            shas.push(sha);
        }
        let other = b"export const s = 1\n";
        let other_sha = app_signing::sha256_hex(other);
        cache.store("shopify", "2.0.0", &other_sha, other).unwrap();
        let all: Vec<&String> = shas.iter().chain([&other_sha]).collect();
        let verified = set(&all);
        assert!(
            cache.read(&shas[0], &verified).is_none() && cache.read(&shas[1], &verified).is_none()
        );
        for sha in &shas[2..] {
            assert!(cache.read(sha, &verified).is_some());
        }
        assert!(cache.read(&other_sha, &verified).is_some());
        let files = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".js"))
            .count();
        assert_eq!(files, 4, "pruned bundles are deleted from disk");
        // Storing a kept version again does not grow the list.
        cache
            .store("boxtal", "1.4.0", &shas[4], b"export const v = 4\n")
            .unwrap();
        assert_eq!(cache.read_index().apps["boxtal"].len(), 3);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_revocation_list_is_kept_only_signed_and_never_older() {
        let dir = temp_dir("revocations");
        let cache = VerifiedCache::new(dir.clone());
        let key = TestKey::new(7);
        let keys = std::slice::from_ref(&key.pinned);
        let list = |seq: u64| {
            format!(
                r#"{{"entries":[{{"name":"boxtal","versions":["1.0.{seq}"]}}],"issuedAt":"2026-10-26T00:00:00.000Z","seq":{seq},"v":1}}"#
            )
        };
        let five = list(5);
        assert_eq!(
            cache
                .offer_revocations(five.as_bytes(), &key.sign(five.as_bytes()), keys)
                .unwrap()
                .unwrap()
                .seq,
            5
        );
        // An older list (a replay) does not replace it.
        let two = list(2);
        assert_eq!(
            cache
                .offer_revocations(two.as_bytes(), &key.sign(two.as_bytes()), keys)
                .unwrap()
                .unwrap()
                .seq,
            5
        );
        // An unsigned one neither.
        let nine = list(9);
        let other = TestKey::new(9);
        assert_eq!(
            cache
                .offer_revocations(nine.as_bytes(), &other.sign(nine.as_bytes()), keys)
                .unwrap()
                .unwrap()
                .seq,
            5
        );
        assert_eq!(cache.stored_revocations(keys).unwrap().unwrap().seq, 5);
        assert_eq!(
            cache
                .offer_revocations(nine.as_bytes(), &key.sign(nine.as_bytes()), keys)
                .unwrap()
                .unwrap()
                .seq,
            9
        );
        assert_eq!(cache.stored_revocations(keys).unwrap().unwrap().seq, 9);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_hash_on_disk_is_not_served_until_this_process_verified_it() {
        let dir = temp_dir("unverified");
        let cache = VerifiedCache::new(dir.clone());
        // Written by hand: a bundle file and an index entry naming it.
        let ui = b"export const Panel = 1\n";
        let sha = app_signing::sha256_hex(ui);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{sha}.js")), ui).unwrap();
        std::fs::write(
            dir.join("index.json"),
            format!(r#"{{"apps":{{"boxtal":[{{"version":"1.0.0","sha256":"{sha}"}}]}}}}"#),
        )
        .unwrap();
        let none = HashSet::new();
        assert_eq!(
            answer(&format!("/{sha}.js"), Some(&cache), &none).status(),
            StatusCode::NOT_FOUND
        );
        // Once verify_first_party_app checked it in this run, it is served.
        assert_eq!(
            answer(&format!("/{sha}.js"), Some(&cache), &set(&[&sha])).status(),
            StatusCode::OK
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_rolled_back_revocation_list_is_refused_even_when_the_stored_one_is_corrupt() {
        let dir = temp_dir("rollback");
        let cache = VerifiedCache::new(dir.clone());
        let key = TestKey::new(7);
        let keys = std::slice::from_ref(&key.pinned);
        let list = |seq: u64| {
            format!(
                r#"{{"entries":[{{"name":"boxtal","versions":["1.0.{seq}"]}}],"issuedAt":"2026-10-26T00:00:00.000Z","seq":{seq},"v":1}}"#
            )
        };
        let five = list(5);
        cache
            .offer_revocations(five.as_bytes(), &key.sign(five.as_bytes()), keys)
            .unwrap();
        // List and signature live in one file; corrupt it.
        assert!(!dir.join("revocations.json.sig").exists());
        std::fs::write(dir.join("revocations.signed.json"), b"{}").unwrap();
        let three = list(3);
        assert!(cache
            .offer_revocations(three.as_bytes(), &key.sign(three.as_bytes()), keys)
            .is_err());
        assert!(cache.stored_revocations(keys).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.join("revocations.seq")).unwrap(),
            "5"
        );
        // A newer signed list restores it.
        let six = list(6);
        assert_eq!(
            cache
                .offer_revocations(six.as_bytes(), &key.sign(six.as_bytes()), keys)
                .unwrap()
                .unwrap()
                .seq,
            6
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A one-shot HTTP server on localhost answering `head` then `body_len`
    /// bytes; answers how many body bytes it managed to write.
    async fn serve_once(head: String, body_len: usize) -> (String, tokio::task::JoinHandle<usize>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/ui.js", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).await;
            if socket.write_all(head.as_bytes()).await.is_err() {
                return 0;
            }
            let chunk = vec![b'a'; 64 * 1024];
            let mut written = 0;
            while written < body_len {
                if socket.write_all(&chunk).await.is_err() {
                    break;
                }
                written += chunk.len();
            }
            written
        });
        (url, task)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_body_over_the_cap_is_refused_without_reading_it_whole() {
        let client = reqwest::Client::new();
        // Declared too large: refused from the header, the body never read.
        let huge = 1usize << 30;
        let (url, _server) = serve_once(
            format!("HTTP/1.1 200 OK\r\nContent-Length: {huge}\r\nConnection: close\r\n\r\n"),
            0,
        )
        .await;
        assert_eq!(fetch(&client, &url, 1024).await.unwrap_err(), "too_large");
        // No declared length: read in chunks, abandoned once past the cap,
        // long before the server finished sending.
        let (url, server) = serve_once(
            "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_string(),
            256 * 1024 * 1024,
        )
        .await;
        assert_eq!(
            fetch(&client, &url, 128 * 1024).await.unwrap_err(),
            "too_large"
        );
        let written = tokio::time::timeout(Duration::from_secs(10), server)
            .await
            .expect("the server stops once the client hangs up")
            .unwrap();
        assert!(written < 256 * 1024 * 1024, "the whole body was never read");
        // Under the cap: the body comes back.
        let (url, _server) = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Length: 65536\r\nConnection: close\r\n\r\n".to_string(),
            65536,
        )
        .await;
        assert_eq!(fetch(&client, &url, 128 * 1024).await.unwrap().len(), 65536);
    }

    #[test]
    fn the_files_come_from_the_bound_server_for_a_well_formed_app_only() {
        assert_eq!(
            artifact_base("https://liaison.example.com/", "boxtal", "1.2.0").as_deref(),
            Some("https://liaison.example.com/api/apps/boxtal/1.2.0/")
        );
        assert_eq!(
            artifact_base("http://localhost:3000", "boxtal", "1.2.0-beta.1").as_deref(),
            Some("http://localhost:3000/api/apps/boxtal/1.2.0-beta.1/")
        );
        for (name, version) in [
            ("../x", "1.0.0"),
            ("boxtal", "1.0"),
            ("boxtal", "1.0.0/../../x"),
            ("Boxtal", "1.0.0"),
            ("boxtal", "1.0.0-"),
            ("boxtal?x", "1.0.0"),
        ] {
            assert!(
                artifact_base("https://a.example", name, version).is_none(),
                "{name} {version}"
            );
        }
        assert!(artifact_base("file:///etc", "boxtal", "1.0.0").is_none());
    }

    #[test]
    fn the_page_reaches_the_scheme_at_the_url_the_window_policy_names() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = conf["app"]["security"]["csp"].as_str().unwrap();
        let script = csp
            .split(';')
            .map(str::trim)
            .find(|d| d.starts_with("script-src "))
            .expect("script-src");
        assert!(script.contains("liaison-app:") && script.contains("http://liaison-app.localhost"));
        assert!(!script.contains("blob:") && !script.contains("https:") && !script.contains('*'));
        assert!(
            app_url_base().starts_with("liaison-app://")
                || app_url_base().starts_with("http://liaison-app.localhost")
        );
    }
}
