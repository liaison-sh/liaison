// SPDX-License-Identifier: FSL-1.1-ALv2
//
// VERIFYING A FIRST-PARTY APP'S UI BEFORE IT RUNS IN THE WINDOW'S PAGE (S13).
//
// The window's page holds the shell's bridge, so code the bound server chose
// never runs there on the server's word (D1). A first-party app's release
// artifact carries a statement signed with Liaison's app-signing key
// (packages/shared/src/app-signing/statement.ts); this module is the shell's
// own check of it, in Rust, so the bytes that later run are the bytes checked
// here (verified_apps.rs serves exactly them, by hash):
//
// - the statement is the canonical JSON of what it parses to (one byte string
//   per statement) and its Ed25519 signature verifies with a PINNED key, named
//   by its `keyId`;
// - the files at hand are the ones it names: app name and version as asked,
//   sha256 of `ui.js` and `manifest.json`, the manifest's own name, version
//   and `host` equal to the statement's;
// - the bundle is single-file ESM (no `import()`, no `import.meta`, imports
//   only from the host import map), so nothing else is loaded in its name;
// - the version is not revoked: not below or in the floor compiled into this
//   build, not in the latest signed revocation list this shell has seen.
//
// THE PINNED KEYS AND THE FLOOR are `packages/shared/src/app-signing/keys.json`,
// compiled in by `include_str!`: the one list the server, the signing tool and
// the web build read too. An empty list verifies nothing (every first-party app
// then runs in the sandbox frame).
//
// TEST KEYS. Every check below takes its keys as a parameter, and the only
// caller outside the tests (`verified_apps::verify_first_party_app`) passes
// `pinned()`, the compiled list. Tests sign with keys of their own inside
// `#[cfg(test)]`; no build of the shell has a way to add a key at run time.

use std::sync::OnceLock;

use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use regex::Regex;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// The shared key list, as committed.
const KEYS_JSON: &str = include_str!("../../../../packages/shared/src/app-signing/keys.json");

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PinnedKey {
    pub key_id: String,
    pub public: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RevocationEntry {
    pub name: String,
    pub below: Option<String>,
    pub versions: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RevocationList {
    pub seq: u64,
    pub entries: Vec<RevocationEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Statement {
    pub key_id: String,
    pub name: String,
    pub version: String,
    pub host_api: String,
    pub ui_sha256: String,
    pub manifest_sha256: String,
}

/// Why an artifact does not run in the page. The page only learns the code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    NoKeys,
    MalformedStatement,
    UnknownKey,
    BadSignature,
    Name,
    Version,
    UiHash,
    ManifestHash,
    ManifestIdentity,
    NotSingleFile,
    BelowFloor,
    Revoked,
}

impl Refusal {
    pub fn code(&self) -> &'static str {
        match self {
            Refusal::NoKeys => "no_keys",
            Refusal::MalformedStatement => "malformed_statement",
            Refusal::UnknownKey => "unknown_key",
            Refusal::BadSignature => "bad_signature",
            Refusal::Name => "name",
            Refusal::Version => "version",
            Refusal::UiHash => "ui_hash",
            Refusal::ManifestHash => "manifest_hash",
            Refusal::ManifestIdentity => "manifest_identity",
            Refusal::NotSingleFile => "not_single_file",
            Refusal::BelowFloor => "below_floor",
            Refusal::Revoked => "revoked",
        }
    }
}

/// `app-` + the first 16 hex of the raw public key's sha256 (sign-artifact.ts `keyIdFor`).
pub fn key_id_for(public: &[u8; 32]) -> String {
    format!("app-{}", &sha256_hex(public)[..16])
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Parses the committed key file. A key whose id is not the one its bytes give
/// is dropped: a statement could otherwise name it under a borrowed id.
pub fn parse_key_file(text: &str) -> (Vec<PinnedKey>, Vec<RevocationEntry>) {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return (Vec::new(), Vec::new());
    };
    let keys = value["keys"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|entry| {
                    let key_id = entry["keyId"].as_str()?;
                    let raw = decode_base64(entry["publicKey"].as_str()?)?;
                    let public: [u8; 32] = raw.try_into().ok()?;
                    (key_id_for(&public) == key_id).then(|| PinnedKey {
                        key_id: key_id.to_string(),
                        public,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let floor = value["revocationFloor"]
        .as_array()
        .map(|list| list.iter().filter_map(parse_entry).collect())
        .unwrap_or_default();
    (keys, floor)
}

/// The keys and floor compiled into this build.
pub fn pinned() -> &'static (Vec<PinnedKey>, Vec<RevocationEntry>) {
    static PINNED: OnceLock<(Vec<PinnedKey>, Vec<RevocationEntry>)> = OnceLock::new();
    PINNED.get_or_init(|| parse_key_file(KEYS_JSON))
}

/// Strict base64 (padded, standard alphabet), surrounding whitespace ignored.
pub fn decode_base64(text: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(text.trim())
        .ok()
}

/// JSON with object keys sorted (by UTF-16 code unit, as JavaScript sorts) at
/// every depth and no whitespace: statement.ts `canonicalJson`.
pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            let body = keys
                .iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        Value::String((*key).clone()),
                        canonical_json(&map[key.as_str()])
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{body}}}")
        }
        other => other.to_string(),
    }
}

/// The value these bytes hold, only when they are its canonical form.
fn canonical_value(bytes: &[u8]) -> Option<Value> {
    let text = std::str::from_utf8(bytes).ok()?;
    let value: Value = serde_json::from_str(text).ok()?;
    (canonical_json(&value) == text).then_some(value)
}

fn exact_keys(value: &Value, keys: &[&str]) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    map.len() == keys.len() && keys.iter().all(|key| map.contains_key(*key))
}

fn non_empty(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

fn hex64(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|s| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .map(str::to_string)
}

/// The statement these bytes hold, or None when they are not exactly one.
pub fn parse_statement(bytes: &[u8]) -> Option<Statement> {
    let value = canonical_value(bytes)?;
    let top = [
        "hostApi",
        "issuedAt",
        "keyId",
        "name",
        "sha256",
        "sourceDigest",
        "v",
        "version",
    ];
    if !exact_keys(&value, &top) || value["v"].as_u64() != Some(1) {
        return None;
    }
    non_empty(&value["issuedAt"])?;
    hex64(&value["sourceDigest"])?;
    let hashes = &value["sha256"];
    if !exact_keys(hashes, &["manifest", "package", "ui"]) {
        return None;
    }
    hex64(&hashes["package"])?;
    Some(Statement {
        key_id: non_empty(&value["keyId"])?,
        name: non_empty(&value["name"])?,
        version: non_empty(&value["version"])?,
        host_api: non_empty(&value["hostApi"])?,
        ui_sha256: hex64(&hashes["ui"])?,
        manifest_sha256: hex64(&hashes["manifest"])?,
    })
}

fn signature_holds(bytes: &[u8], sig_base64: &str, key: &PinnedKey) -> bool {
    let Some(raw) = decode_base64(sig_base64) else {
        return false;
    };
    let Ok(sig) = <[u8; 64]>::try_from(raw.as_slice()) else {
        return false;
    };
    let Ok(verifying) = VerifyingKey::from_bytes(&key.public) else {
        return false;
    };
    verifying
        .verify_strict(bytes, &Signature::from_bytes(&sig))
        .is_ok()
}

/// The statement, when its bytes are canonical and signed by the pinned key it names.
pub fn verify_statement(
    bytes: &[u8],
    sig_base64: &str,
    keys: &[PinnedKey],
) -> Result<Statement, Refusal> {
    if keys.is_empty() {
        return Err(Refusal::NoKeys);
    }
    let statement = parse_statement(bytes).ok_or(Refusal::MalformedStatement)?;
    let key = keys
        .iter()
        .find(|k| k.key_id == statement.key_id)
        .ok_or(Refusal::UnknownKey)?;
    if !signature_holds(bytes, sig_base64, key) {
        return Err(Refusal::BadSignature);
    }
    Ok(statement)
}

fn parse_entry(value: &Value) -> Option<RevocationEntry> {
    let map = value.as_object()?;
    if map
        .keys()
        .any(|k| !matches!(k.as_str(), "name" | "below" | "versions"))
    {
        return None;
    }
    let name = non_empty(&value["name"])?;
    let below = match map.get("below") {
        None => None,
        Some(v) => Some(non_empty(v)?),
    };
    let versions = match map.get("versions") {
        None => Vec::new(),
        Some(v) => v
            .as_array()?
            .iter()
            .map(non_empty)
            .collect::<Option<Vec<_>>>()?,
    };
    if below.is_none() && !map.contains_key("versions") {
        return None;
    }
    Some(RevocationEntry {
        name,
        below,
        versions,
    })
}

/// A revocation list (revocations.ts): canonical bytes, `{v:1, seq, issuedAt, entries}`.
pub fn parse_revocation_list(bytes: &[u8]) -> Option<RevocationList> {
    let value = canonical_value(bytes)?;
    if !exact_keys(&value, &["entries", "issuedAt", "seq", "v"]) || value["v"].as_u64() != Some(1) {
        return None;
    }
    non_empty(&value["issuedAt"])?;
    let seq = value["seq"].as_u64()?;
    let entries = value["entries"]
        .as_array()?
        .iter()
        .map(parse_entry)
        .collect::<Option<Vec<_>>>()?;
    Some(RevocationList { seq, entries })
}

/// The list names no key: any pinned key that verifies it vouches for it.
pub fn verify_revocation_list(
    bytes: &[u8],
    sig_base64: &str,
    keys: &[PinnedKey],
) -> Option<RevocationList> {
    let list = parse_revocation_list(bytes)?;
    keys.iter()
        .any(|key| signature_holds(bytes, sig_base64, key))
        .then_some(list)
}

fn parse_version(v: &str) -> (Vec<u64>, Option<&str>) {
    let (core, pre) = match v.split_once('-') {
        Some((core, pre)) => (core, Some(pre).filter(|p| !p.is_empty())),
        None => (v, None),
    };
    (
        core.split('.')
            .map(|n| n.parse::<u64>().unwrap_or(0))
            .collect(),
        pre,
    )
}

/// Numeric core first, then a pre-release sorts before its release (revocations.ts).
pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (na, pa) = parse_version(a);
    let (nb, pb) = parse_version(b);
    for i in 0..na.len().max(nb.len()) {
        let order = na.get(i).unwrap_or(&0).cmp(nb.get(i).unwrap_or(&0));
        if order != Ordering::Equal {
            return order;
        }
    }
    match (pa, pb) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) => compare_pre_release(x, y),
    }
}

/// Semver pre-release order: dot-separated identifiers compared left to right,
/// numeric ones numerically, a numeric one before an alphanumeric one, and a
/// shorter list first when every identifier it has is equal.
fn compare_pre_release(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let numeric = |id: &str| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit());
    let mut left = a.split('.');
    let mut right = b.split('.');
    loop {
        match (left.next(), right.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => {
                let order = match (numeric(x), numeric(y)) {
                    (true, true) => {
                        let (x, y) = (x.trim_start_matches('0'), y.trim_start_matches('0'));
                        x.len().cmp(&y.len()).then_with(|| x.cmp(y))
                    }
                    (true, false) => Ordering::Less,
                    (false, true) => Ordering::Greater,
                    (false, false) => x.cmp(y),
                };
                if order != Ordering::Equal {
                    return order;
                }
            }
        }
    }
}

fn listed(entries: &[RevocationEntry], name: &str, version: &str) -> bool {
    entries.iter().any(|entry| {
        entry.name == name
            && (entry
                .below
                .as_deref()
                .is_some_and(|below| compare_versions(version, below).is_lt())
                || entry.versions.iter().any(|v| v == version))
    })
}

pub fn revocation_for(
    name: &str,
    version: &str,
    floor: &[RevocationEntry],
    list: Option<&RevocationList>,
) -> Option<Refusal> {
    if listed(floor, name, version) {
        return Some(Refusal::BelowFloor);
    }
    if list.is_some_and(|list| listed(&list.entries, name, version)) {
        return Some(Refusal::Revoked);
    }
    None
}

/// Bare specifiers a bundle may import: the page's import map.
pub const BARE_IMPORTS: [&str; 3] = ["solid-js", "solid-js/web", "solid-js/store"];

/// Why `source` is not single-file ESM, or empty (verify.ts `singleFileBundleProblems`).
pub fn single_file_problems(source: &str) -> Vec<String> {
    static PATTERNS: OnceLock<[Regex; 4]> = OnceLock::new();
    let [dynamic, meta, from, bare] = PATTERNS.get_or_init(|| {
        [
            Regex::new(r"\bimport\s*\(").expect("pattern"),
            Regex::new(r"\bimport\s*\.\s*meta\b").expect("pattern"),
            Regex::new(
                r#"(?m)(?:^|[;}])\s*(?:import|export)\b[\w\s{},*$]*?\bfrom\s*["']([^"'\n]*)["']"#,
            )
            .expect("pattern"),
            Regex::new(r#"(?m)(?:^|[;}])\s*import\s*["']([^"'\n]*)["']"#).expect("pattern"),
        ]
    });
    let mut problems = Vec::new();
    if dynamic.is_match(source) {
        problems.push("dynamic import()".to_string());
    }
    if meta.is_match(source) {
        problems.push("import.meta".to_string());
    }
    let mut seen = std::collections::BTreeSet::new();
    for pattern in [from, bare] {
        for captures in pattern.captures_iter(source) {
            let spec = &captures[1];
            if !BARE_IMPORTS.contains(&spec) && seen.insert(spec.to_string()) {
                problems.push(format!("import \"{spec}\""));
            }
        }
    }
    problems
}

/// What the shell fetched for one app version.
pub struct Artifact<'a> {
    pub name: &'a str,
    pub version: &'a str,
    pub statement: &'a [u8],
    pub signature: &'a str,
    pub ui: &'a [u8],
    pub manifest: &'a [u8],
}

/// What runs in the page: the bytes' hash and the manifest they were signed with.
#[derive(Debug)]
pub struct Verified {
    pub ui_sha256: String,
    pub manifest: Value,
}

/// The whole check, in the order a refusal is cheapest to reach.
pub fn verify_artifact(
    artifact: &Artifact<'_>,
    keys: &[PinnedKey],
    floor: &[RevocationEntry],
    revocations: Option<&RevocationList>,
) -> Result<Verified, Refusal> {
    let statement = verify_statement(artifact.statement, artifact.signature, keys)?;
    if statement.name != artifact.name {
        return Err(Refusal::Name);
    }
    if statement.version != artifact.version {
        return Err(Refusal::Version);
    }
    if let Some(refusal) = revocation_for(artifact.name, artifact.version, floor, revocations) {
        return Err(refusal);
    }
    let ui_sha256 = sha256_hex(artifact.ui);
    if ui_sha256 != statement.ui_sha256 {
        return Err(Refusal::UiHash);
    }
    if sha256_hex(artifact.manifest) != statement.manifest_sha256 {
        return Err(Refusal::ManifestHash);
    }
    let manifest: Value =
        serde_json::from_slice(artifact.manifest).map_err(|_| Refusal::ManifestIdentity)?;
    if manifest["name"].as_str() != Some(statement.name.as_str())
        || manifest["version"].as_str() != Some(statement.version.as_str())
        || manifest["host"].as_str() != Some(statement.host_api.as_str())
    {
        return Err(Refusal::ManifestIdentity);
    }
    let source = std::str::from_utf8(artifact.ui).map_err(|_| Refusal::NotSingleFile)?;
    if !single_file_problems(source).is_empty() {
        return Err(Refusal::NotSingleFile);
    }
    Ok(Verified {
        ui_sha256,
        manifest,
    })
}

#[cfg(test)]
pub mod testing {
    //! Throwaway signing keys, test builds only.
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    pub struct TestKey {
        signing: SigningKey,
        pub pinned: PinnedKey,
    }

    impl TestKey {
        pub fn new(seed: u8) -> Self {
            let signing = SigningKey::from_bytes(&[seed; 32]);
            let public = signing.verifying_key().to_bytes();
            Self {
                pinned: PinnedKey {
                    key_id: key_id_for(&public),
                    public,
                },
                signing,
            }
        }

        pub fn sign(&self, bytes: &[u8]) -> String {
            base64::engine::general_purpose::STANDARD.encode(self.signing.sign(bytes).to_bytes())
        }
    }

    pub const UI: &str =
        "import { createSignal } from \"solid-js\"\nexport const Panel = () => createSignal(1)\n";

    pub fn manifest(name: &str, version: &str) -> Vec<u8> {
        format!(r#"{{"host":"^1","name":"{name}","version":"{version}","views":{{"tabs":[]}}}}"#)
            .into_bytes()
    }

    /// A statement for `ui` + `manifest`, canonical, under `key`'s id.
    pub fn statement(
        key: &TestKey,
        name: &str,
        version: &str,
        ui: &[u8],
        manifest: &[u8],
    ) -> Vec<u8> {
        let value = serde_json::json!({
            "v": 1,
            "keyId": key.pinned.key_id,
            "name": name,
            "version": version,
            "hostApi": "^1",
            "sha256": {
                "ui": sha256_hex(ui),
                "manifest": sha256_hex(manifest),
                "package": sha256_hex(b"package"),
            },
            "sourceDigest": sha256_hex(b"source"),
            "issuedAt": "2026-10-26T00:00:00.000Z",
        });
        canonical_json(&value).into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    struct Fixture {
        key: TestKey,
        statement: Vec<u8>,
        signature: String,
        ui: Vec<u8>,
        manifest: Vec<u8>,
    }

    fn fixture() -> Fixture {
        let key = TestKey::new(7);
        let ui = UI.as_bytes().to_vec();
        let manifest = manifest("boxtal", "1.2.0");
        let statement = statement(&key, "boxtal", "1.2.0", &ui, &manifest);
        let signature = key.sign(&statement);
        Fixture {
            key,
            statement,
            signature,
            ui,
            manifest,
        }
    }

    fn check(f: &Fixture, keys: &[PinnedKey]) -> Result<Verified, Refusal> {
        verify_artifact(
            &Artifact {
                name: "boxtal",
                version: "1.2.0",
                statement: &f.statement,
                signature: &f.signature,
                ui: &f.ui,
                manifest: &f.manifest,
            },
            keys,
            &[],
            None,
        )
    }

    #[test]
    fn a_correctly_signed_artifact_verifies_with_its_manifest() {
        let f = fixture();
        let verified = check(&f, std::slice::from_ref(&f.key.pinned)).expect("verifies");
        assert_eq!(verified.ui_sha256, sha256_hex(&f.ui));
        assert_eq!(verified.manifest["name"], "boxtal");
    }

    #[test]
    fn one_byte_changed_in_the_bundle_is_refused() {
        let mut f = fixture();
        f.ui[10] ^= 1;
        assert_eq!(
            check(&f, std::slice::from_ref(&f.key.pinned)).unwrap_err(),
            Refusal::UiHash
        );
    }

    #[test]
    fn one_byte_changed_in_the_manifest_or_statement_is_refused() {
        let mut f = fixture();
        f.manifest[3] ^= 1;
        assert_eq!(
            check(&f, std::slice::from_ref(&f.key.pinned)).unwrap_err(),
            Refusal::ManifestHash
        );
        let mut f = fixture();
        let at = f.statement.len() - 5;
        f.statement[at] = b'1';
        assert!(matches!(
            check(&f, std::slice::from_ref(&f.key.pinned)).unwrap_err(),
            Refusal::BadSignature | Refusal::MalformedStatement
        ));
    }

    #[test]
    fn a_correct_signature_by_an_unpinned_key_is_refused() {
        let f = fixture();
        let other = TestKey::new(9);
        assert_eq!(
            check(&f, std::slice::from_ref(&other.pinned)).unwrap_err(),
            Refusal::UnknownKey
        );
        // The same id with other bytes: the signature does not hold.
        let impostor = PinnedKey {
            key_id: f.key.pinned.key_id.clone(),
            public: other.pinned.public,
        };
        assert_eq!(check(&f, &[impostor]).unwrap_err(), Refusal::BadSignature);
    }

    #[test]
    fn no_pinned_key_verifies_nothing() {
        let f = fixture();
        assert_eq!(check(&f, &[]).unwrap_err(), Refusal::NoKeys);
    }

    #[test]
    fn a_statement_that_is_not_canonical_is_refused_even_when_signed() {
        let f = fixture();
        let pretty =
            serde_json::to_vec_pretty(&serde_json::from_slice::<Value>(&f.statement).unwrap())
                .unwrap();
        let signature = f.key.sign(&pretty);
        let result = verify_statement(&pretty, &signature, std::slice::from_ref(&f.key.pinned));
        assert_eq!(result.unwrap_err(), Refusal::MalformedStatement);
        // A trailing newline is another byte string too.
        let mut newline = f.statement.clone();
        newline.push(b'\n');
        let signature = f.key.sign(&newline);
        let result = verify_statement(&newline, &signature, std::slice::from_ref(&f.key.pinned));
        assert_eq!(result.unwrap_err(), Refusal::MalformedStatement);
    }

    #[test]
    fn a_statement_for_another_app_or_version_is_refused() {
        let f = fixture();
        let keys = std::slice::from_ref(&f.key.pinned);
        let run = |name: &str, version: &str| {
            verify_artifact(
                &Artifact {
                    name,
                    version,
                    statement: &f.statement,
                    signature: &f.signature,
                    ui: &f.ui,
                    manifest: &f.manifest,
                },
                keys,
                &[],
                None,
            )
            .unwrap_err()
        };
        assert_eq!(run("shopify", "1.2.0"), Refusal::Name);
        assert_eq!(run("boxtal", "1.3.0"), Refusal::Version);
    }

    #[test]
    fn a_manifest_naming_another_app_is_refused() {
        let key = TestKey::new(7);
        let ui = UI.as_bytes().to_vec();
        let manifest = manifest("shopify", "1.2.0");
        let statement = statement(&key, "boxtal", "1.2.0", &ui, &manifest);
        let result = verify_artifact(
            &Artifact {
                name: "boxtal",
                version: "1.2.0",
                statement: &statement,
                signature: &key.sign(&statement),
                ui: &ui,
                manifest: &manifest,
            },
            std::slice::from_ref(&key.pinned),
            &[],
            None,
        );
        assert_eq!(result.unwrap_err(), Refusal::ManifestIdentity);
    }

    #[test]
    fn a_bundle_that_loads_more_code_is_refused() {
        for ui in [
            "const m = await import(\"./x.js\")",
            "const u = import.meta.url",
            "import { x } from \"./chunk.js\"\nexport const a = x",
            "import \"https://evil.example/x.js\"",
            "export * from \"@liaison/host\"",
        ] {
            assert!(!single_file_problems(ui).is_empty(), "{ui}");
            let key = TestKey::new(7);
            let manifest = manifest("boxtal", "1.2.0");
            let statement = statement(&key, "boxtal", "1.2.0", ui.as_bytes(), &manifest);
            let result = verify_artifact(
                &Artifact {
                    name: "boxtal",
                    version: "1.2.0",
                    statement: &statement,
                    signature: &key.sign(&statement),
                    ui: ui.as_bytes(),
                    manifest: &manifest,
                },
                std::slice::from_ref(&key.pinned),
                &[],
                None,
            );
            assert_eq!(result.unwrap_err(), Refusal::NotSingleFile, "{ui}");
        }
        assert!(single_file_problems(UI).is_empty());
        assert!(
            single_file_problems("import { render } from 'solid-js/web';export const a=1")
                .is_empty()
        );
    }

    #[test]
    fn a_revoked_or_below_floor_version_is_refused() {
        let f = fixture();
        let keys = std::slice::from_ref(&f.key.pinned);
        let artifact = Artifact {
            name: "boxtal",
            version: "1.2.0",
            statement: &f.statement,
            signature: &f.signature,
            ui: &f.ui,
            manifest: &f.manifest,
        };
        let floor = vec![RevocationEntry {
            name: "boxtal".into(),
            below: Some("1.2.1".into()),
            versions: vec![],
        }];
        assert_eq!(
            verify_artifact(&artifact, keys, &floor, None).unwrap_err(),
            Refusal::BelowFloor
        );
        let list = RevocationList {
            seq: 3,
            entries: vec![RevocationEntry {
                name: "boxtal".into(),
                below: None,
                versions: vec!["1.2.0".into()],
            }],
        };
        assert_eq!(
            verify_artifact(&artifact, keys, &[], Some(&list)).unwrap_err(),
            Refusal::Revoked
        );
        // Another app's entry, or an older floor, leaves it alone.
        let other = vec![RevocationEntry {
            name: "shopify".into(),
            below: Some("9.0.0".into()),
            versions: vec![],
        }];
        assert!(verify_artifact(&artifact, keys, &other, None).is_ok());
    }

    #[test]
    fn versions_order_like_the_shared_comparison() {
        use std::cmp::Ordering::*;
        assert_eq!(compare_versions("1.2.0", "1.10.0"), Less);
        assert_eq!(compare_versions("1.2.0-beta", "1.2.0"), Less);
        assert_eq!(compare_versions("1.2.0", "1.2"), Equal);
        assert_eq!(compare_versions("2.0.0-b", "2.0.0-a"), Greater);
        // Semver pre-release identifiers: numeric parts numerically, numeric
        // before alphanumeric, a shorter list first.
        assert_eq!(compare_versions("1.0.0-rc.9", "1.0.0-rc.10"), Less);
        assert_eq!(compare_versions("1.0.0-alpha", "1.0.0-alpha.1"), Less);
        assert_eq!(compare_versions("1.0.0-1", "1.0.0-alpha"), Less);
        assert_eq!(compare_versions("1.0.0-beta.11", "1.0.0-beta.2"), Greater);
    }

    #[test]
    fn a_floor_below_a_later_release_candidate_revokes_an_earlier_one() {
        let floor = vec![RevocationEntry {
            name: "boxtal".into(),
            below: Some("1.0.0-rc.10".into()),
            versions: vec![],
        }];
        assert_eq!(
            revocation_for("boxtal", "1.0.0-rc.9", &floor, None),
            Some(Refusal::BelowFloor)
        );
        assert_eq!(revocation_for("boxtal", "1.0.0-rc.10", &floor, None), None);
    }

    #[test]
    fn a_signed_revocation_list_verifies_with_any_pinned_key_and_only_canonical() {
        let key = TestKey::new(7);
        let other = TestKey::new(9);
        let bytes = br#"{"entries":[{"name":"boxtal","versions":["1.2.0"]}],"issuedAt":"2026-10-26T00:00:00.000Z","seq":4,"v":1}"#;
        let sig = key.sign(bytes);
        let list = verify_revocation_list(bytes, &sig, &[other.pinned.clone(), key.pinned.clone()])
            .expect("verifies");
        assert_eq!(list.seq, 4);
        assert!(verify_revocation_list(bytes, &sig, std::slice::from_ref(&other.pinned)).is_none());
        let spaced = br#"{"entries":[], "issuedAt":"x","seq":4,"v":1}"#;
        assert!(verify_revocation_list(
            spaced,
            &key.sign(spaced),
            std::slice::from_ref(&key.pinned)
        )
        .is_none());
    }

    #[test]
    fn canonical_json_matches_the_shared_form() {
        let value: Value =
            serde_json::from_str(r#"{"b":1,"a":{"d":"é\n","c":[2,"x"]},"B":true}"#).unwrap();
        assert_eq!(
            canonical_json(&value),
            r#"{"B":true,"a":{"c":[2,"x"],"d":"é\n"},"b":1}"#
        );
    }

    #[test]
    fn the_committed_key_file_parses_and_a_key_under_a_borrowed_id_is_dropped() {
        // The production list compiled into this build parses (it may be empty).
        let committed: Value = serde_json::from_str(KEYS_JSON).expect("keys.json is JSON");
        assert_eq!(
            pinned().0.len(),
            committed["keys"].as_array().map_or(0, Vec::len),
            "every committed key carries the id its bytes give"
        );
        let key = TestKey::new(7);
        let public = base64::engine::general_purpose::STANDARD.encode(key.pinned.public);
        let good = format!(
            r#"{{"keys":[{{"keyId":"{}","publicKey":"{public}"}}],"revocationFloor":[{{"name":"a","below":"1.0.0"}}]}}"#,
            key.pinned.key_id
        );
        let (keys, floor) = parse_key_file(&good);
        assert_eq!(keys, vec![key.pinned.clone()]);
        assert_eq!(floor.len(), 1);
        let borrowed =
            format!(r#"{{"keys":[{{"keyId":"app-0000000000000000","publicKey":"{public}"}}]}}"#);
        assert!(parse_key_file(&borrowed).0.is_empty());
    }
}
