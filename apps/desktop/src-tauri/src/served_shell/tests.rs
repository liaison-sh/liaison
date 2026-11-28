// SPDX-License-Identifier: FSL-1.1-ALv2
use super::*;
use crate::app_signing::testing::TestKey;
use crate::app_signing::{canonical_json, sha256_hex};

const SERVER: &str = "https://shell.example";
const DL: &str = "https://downloads.example";
const BUILD: &str = "0123456789abcdef";
const INDEX: &str = "<!doctype html><html><head><script>window.x=1</script>\
<script type=\"module\" src=\"/assets/app.js\"></script></head><body></body></html>";
const APP_JS: &str = "export const app = 1\n";

fn temp_dir(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!("liaison-served-shell-{label}-{}", random_hex()))
}

struct Fixture {
    key: TestKey,
    store: ShellStore,
    dir: PathBuf,
    files: Vec<(String, Vec<u8>)>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn fixture(label: &str) -> Fixture {
    let dir = temp_dir(label);
    Fixture {
        key: TestKey::new(1),
        store: ShellStore::new(dir.clone()),
        dir,
        files: vec![
            ("index.html".into(), INDEX.as_bytes().to_vec()),
            ("assets/app.js".into(), APP_JS.as_bytes().to_vec()),
        ],
    }
}

fn statement_value(key: &TestKey, files: &[(String, Vec<u8>)]) -> Value {
    let listed: serde_json::Map<String, Value> = files
        .iter()
        .map(|(p, b)| (p.clone(), Value::String(sha256_hex(b))))
        .collect();
    serde_json::json!({
        "v": 1,
        "kind": "shell",
        "keyId": key.pinned.key_id,
        "mode": "desktop",
        "buildId": BUILD,
        "commit": "a".repeat(40),
        "seq": 1_764_300_000u64,
        "liaisonVersion": "nightly-20261128",
        "bridge": { "desktop": "^1", "ios": "^1", "android": "^1" },
        "settingsSchema": 1,
        "files": listed,
        "issuedAt": "2026-11-28T00:00:00.000Z",
    })
}

fn signed(key: &TestKey, value: &Value) -> (Vec<u8>, String) {
    let bytes = canonical_json(value).into_bytes();
    let sig = key.sign(&bytes);
    (bytes, sig)
}

/// An in-memory fetcher: the URLs it knows, every other one 404.
#[derive(Default)]
struct Fake {
    answers: HashMap<String, Result<Vec<u8>, FetchError>>,
    /// Every answer waits this long first.
    delay: Option<Duration>,
    /// Runs on every GET of a URL under SERVER other than its shell info.
    on_file: Option<Box<dyn Fn() + Send + Sync>>,
}

impl Fake {
    fn put(&mut self, url: impl Into<String>, body: impl Into<Vec<u8>>) {
        self.answers.insert(url.into(), Ok(body.into()));
    }

    /// Statement, signature, server info and every file of `f`.
    fn serving(f: &Fixture, value: &Value) -> Self {
        let (bytes, sig) = signed(&f.key, value);
        let mut fake = Fake::default();
        fake.put(format!("{DL}/shell/desktop/{BUILD}/statement.json"), bytes);
        fake.put(format!("{DL}/shell/desktop/{BUILD}/statement.sig"), sig);
        fake.put(
            format!("{SERVER}/api/shell/info"),
            format!(
                r#"{{"data":{{"desktop":{{"buildId":"{BUILD}"}},"native":null,"liaisonVersion":"x","settingsSchema":1,"servedShell":true}}}}"#
            ),
        );
        for (path, body) in &f.files {
            fake.put(format!("{SERVER}/{path}"), body.clone());
        }
        fake
    }
}

impl Fetcher for Fake {
    async fn get(&self, url: &str, limit: usize) -> Result<Vec<u8>, FetchError> {
        if let Some(delay) = self.delay {
            tokio::time::sleep(delay).await;
        }
        if url.starts_with(SERVER) && !url.ends_with("api/shell/info") {
            if let Some(hook) = &self.on_file {
                hook();
            }
        }
        match self.answers.get(url) {
            Some(Ok(body)) if body.len() > limit => Err(FetchError::TooLarge),
            Some(answer) => answer.clone(),
            None => Err(FetchError::NotFound),
        }
    }
}

fn trust(key: &TestKey) -> Trust<'_> {
    Trust {
        keys: std::slice::from_ref(&key.pinned),
        floor: &[],
        list: None,
        bridge_version: DESKTOP_BRIDGE_VERSION,
    }
}

fn run<T>(future: impl Future<Output = T>) -> T {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}

fn refresh_with(f: &Fixture, fake: &Fake, trust: Trust<'_>) -> Result<Pointer, Refusal> {
    run(refresh_pointer(fake, &f.store, DL, SERVER, Some(trust)))
}

fn no_blobs(f: &Fixture) -> bool {
    std::fs::read_dir(f.dir.join("blobs")).map_or(true, |mut d| d.next().is_none())
}

// ── T1: fetch, verify, cache ──

#[test]
fn a_correctly_signed_build_is_fetched_kept_by_hash_and_pointed_at() {
    let f = fixture("happy");
    let fake = Fake::serving(&f, &statement_value(&f.key, &f.files));
    let pointer = refresh_with(&f, &fake, trust(&f.key)).unwrap();
    assert_eq!(pointer.current.as_deref(), Some(BUILD));
    assert_eq!(f.store.pointer(SERVER), pointer);
    for (_, body) in &f.files {
        assert_eq!(
            f.store.read_blob(&sha256_hex(body)).as_deref(),
            Some(&body[..])
        );
    }
    assert!(f.store.record(BUILD).is_some());
    // The same server spelt with a trailing slash shares the pointer.
    assert_eq!(f.store.pointer(&format!("{SERVER}/")), pointer);
    // Nothing left in the temporary folder.
    assert!(std::fs::read_dir(f.dir.join("tmp")).map_or(true, |mut d| d.next().is_none()));
}

fn assert_refused(f: &Fixture, fake: &Fake, trust: Trust<'_>, refusal: Refusal) {
    let before = f.store.pointer(SERVER);
    assert_eq!(refresh_with(f, fake, trust), Err(refusal));
    let after = Pointer {
        served_shell: before.served_shell.or(Some(true)),
        ..before
    };
    assert_eq!(
        f.store.pointer(SERVER),
        after,
        "pointer moved on {refusal:?}"
    );
    assert!(
        f.store.record(BUILD).is_none(),
        "statement kept on {refusal:?}"
    );
}

#[test]
fn a_tampered_file_is_refused_and_nothing_is_kept() {
    let f = fixture("tampered");
    let mut fake = Fake::serving(&f, &statement_value(&f.key, &f.files));
    fake.put(format!("{SERVER}/assets/app.js"), "export const app = 2\n");
    assert_refused(&f, &fake, trust(&f.key), Refusal::FileHash);
    assert!(no_blobs(&f));
}

#[test]
fn a_statement_signed_by_another_key_or_tampered_is_refused() {
    let f = fixture("wrong-key");
    let other = TestKey::new(2);
    let value = statement_value(&f.key, &f.files);
    // Signed by an unpinned key under the pinned key's id.
    let mut fake = Fake::serving(&f, &value);
    fake.put(
        format!("{DL}/shell/desktop/{BUILD}/statement.sig"),
        other.sign(canonical_json(&value).as_bytes()),
    );
    assert_refused(&f, &fake, trust(&f.key), Refusal::BadSignature);
    // Naming a key that is not pinned.
    let fake = Fake::serving(&f, &statement_value(&other, &f.files));
    assert_refused(&f, &fake, trust(&f.key), Refusal::UnknownKey);
    // One byte of the statement changed after signing.
    let mut fake = Fake::serving(&f, &value);
    let mut bytes = canonical_json(&value).into_bytes();
    let at = bytes.iter().position(|b| *b == b'1').unwrap();
    bytes[at] = b'2';
    fake.put(format!("{DL}/shell/desktop/{BUILD}/statement.json"), bytes);
    assert_refused(&f, &fake, trust(&f.key), Refusal::BadSignature);
}

#[test]
fn a_build_below_the_floor_or_revoked_is_refused() {
    let f = fixture("revoked");
    let fake = Fake::serving(&f, &statement_value(&f.key, &f.files));
    // The statement's seq is 1764300000 (10 digits); a floor one above it.
    let floor = vec![RevocationEntry {
        name: "shell:desktop".into(),
        below: Some("1764300001".into()),
        versions: vec![],
    }];
    let t = Trust {
        floor: &floor,
        ..trust(&f.key)
    };
    assert_refused(&f, &fake, t, Refusal::BelowFloor);
    let list = RevocationList {
        seq: 3,
        entries: floor.clone(),
    };
    let t = Trust {
        list: Some(&list),
        ..trust(&f.key)
    };
    assert_refused(&f, &fake, t, Refusal::Revoked);
    // The other mode's floor does not apply.
    let native = vec![RevocationEntry {
        name: "shell:native".into(),
        below: Some("9999999999".into()),
        versions: vec![],
    }];
    let t = Trust {
        floor: &native,
        ..trust(&f.key)
    };
    assert!(refresh_with(&f, &fake, t).is_ok());
}

#[test]
fn a_floor_is_compared_as_a_number_never_as_text() {
    let entry = |below: &str| RevocationEntry {
        name: "shell:desktop".into(),
        below: Some(below.into()),
        versions: vec![],
    };
    // As text "999" sorts after "1000"; as numbers it is below.
    assert!(app_signing::below_shell_floor(
        &[entry("1000")],
        "desktop",
        999
    ));
    assert!(!app_signing::below_shell_floor(
        &[entry("1000")],
        "desktop",
        1000
    ));
    assert!(!app_signing::below_shell_floor(
        &[entry("999")],
        "desktop",
        1000
    ));
    assert!(!app_signing::below_shell_floor(
        &[entry("1000")],
        "native",
        999
    ));
}

#[test]
fn a_bridge_range_this_host_does_not_satisfy_is_refused() {
    let f = fixture("bridge");
    let mut value = statement_value(&f.key, &f.files);
    value["bridge"]["desktop"] = Value::String("^2".into());
    let fake = Fake::serving(&f, &value);
    assert_refused(&f, &fake, trust(&f.key), Refusal::Bridge);
}

#[test]
fn a_missing_statement_is_refused() {
    let f = fixture("missing");
    let mut fake = Fake::serving(&f, &statement_value(&f.key, &f.files));
    fake.answers
        .remove(&format!("{DL}/shell/desktop/{BUILD}/statement.json"));
    assert_refused(&f, &fake, trust(&f.key), Refusal::NoStatement);
    assert!(no_blobs(&f));
}

#[test]
fn an_app_statement_or_another_mode_never_passes_as_a_desktop_shell() {
    let f = fixture("kind");
    // An app statement, correctly signed by the pinned key.
    let app = app_signing::testing::statement(
        &f.key,
        "boxtal",
        "1.0.0",
        b"ui",
        &app_signing::testing::manifest("boxtal", "1.0.0"),
    );
    let mut fake = Fake::serving(&f, &statement_value(&f.key, &f.files));
    fake.put(
        format!("{DL}/shell/desktop/{BUILD}/statement.sig"),
        f.key.sign(&app),
    );
    fake.put(
        format!("{DL}/shell/desktop/{BUILD}/statement.json"),
        app.clone(),
    );
    assert_refused(&f, &fake, trust(&f.key), Refusal::MalformedStatement);
    // And the app parser refuses a shell statement.
    let (shell, _) = signed(&f.key, &statement_value(&f.key, &f.files));
    assert!(app_signing::parse_statement(&shell).is_none());
    // kind "app", or a native statement.
    for (field, v) in [("kind", "app"), ("mode", "native")] {
        let mut value = statement_value(&f.key, &f.files);
        value[field] = Value::String(v.into());
        let fake = Fake::serving(&f, &value);
        let want = if field == "kind" {
            Refusal::MalformedStatement
        } else {
            Refusal::WrongBuild
        };
        assert_refused(&f, &fake, trust(&f.key), want);
    }
    // A statement for another build id.
    let mut value = statement_value(&f.key, &f.files);
    value["buildId"] = Value::String("fedcba9876543210".into());
    let fake = Fake::serving(&f, &value);
    assert_refused(&f, &fake, trust(&f.key), Refusal::WrongBuild);
}

#[test]
fn a_build_over_thirty_megabytes_is_refused() {
    let mut f = fixture("oversize");
    let big = vec![b'a'; MAX_BUILD_BYTES / 2 + 1];
    f.files.push(("assets/big-1.js".into(), big.clone()));
    let mut other = big;
    other[0] = b'b';
    f.files.push(("assets/big-2.js".into(), other));
    let fake = Fake::serving(&f, &statement_value(&f.key, &f.files));
    assert_refused(&f, &fake, trust(&f.key), Refusal::TooLarge);
    assert!(no_blobs(&f));
}

#[test]
fn stale_revocations_verify_nothing_new() {
    let f = fixture("stale");
    let fake = Fake::serving(&f, &statement_value(&f.key, &f.files));
    assert_eq!(
        run(refresh_pointer(&fake, &f.store, DL, SERVER, None)),
        Err(Refusal::RevocationsStale)
    );
    assert!(f.store.pointer(SERVER).current.is_none());
}

#[test]
fn the_server_switch_off_and_a_quarantined_build_fetch_nothing() {
    let f = fixture("server-off");
    let mut fake = Fake::serving(&f, &statement_value(&f.key, &f.files));
    fake.put(
        format!("{SERVER}/api/shell/info"),
        format!(r#"{{"data":{{"desktop":{{"buildId":"{BUILD}"}},"servedShell":false}}}}"#),
    );
    let pointer = refresh_with(&f, &fake, trust(&f.key)).unwrap();
    assert_eq!(pointer.served_shell, Some(false));
    assert!(pointer.current.is_none() && no_blobs(&f));

    let f = fixture("quarantined");
    let fake = Fake::serving(&f, &statement_value(&f.key, &f.files));
    f.store
        .save_pointer(
            SERVER,
            &Pointer {
                quarantined: vec![BUILD.into()],
                ..Pointer::default()
            },
        )
        .unwrap();
    let pointer = refresh_with(&f, &fake, trust(&f.key)).unwrap();
    assert!(pointer.current.is_none() && no_blobs(&f));
}

/// A one-file HTTP server answering every connection from `routes`
/// (path -> raw response), until the test ends.
async fn serve(routes: HashMap<String, String>) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let routes = routes.clone();
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut buf = [0u8; 1024];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match socket.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => request.extend_from_slice(&buf[..n]),
                    }
                }
                let line = String::from_utf8_lossy(&request).to_string();
                let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
                let response = routes.get(&path).cloned().unwrap_or_else(|| {
                    "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        .into()
                });
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    base
}

fn ok(body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

#[test]
fn a_redirect_is_never_followed() {
    let f = fixture("redirect");
    let value = statement_value(&f.key, &f.files);
    let (statement, sig) = signed(&f.key, &value);
    run(async {
        let mut routes = HashMap::new();
        routes.insert(
            format!("/shell/desktop/{BUILD}/statement.json"),
            ok(std::str::from_utf8(&statement).unwrap()),
        );
        routes.insert(format!("/shell/desktop/{BUILD}/statement.sig"), ok(&sig));
        routes.insert(
            "/api/shell/info".into(),
            ok(&format!(
                r#"{{"data":{{"desktop":{{"buildId":"{BUILD}"}},"servedShell":true}}}}"#
            )),
        );
        routes.insert("/index.html".into(), ok(INDEX));
        // The script moved elsewhere, with the right bytes waiting there.
        routes.insert(
            "/assets/app.js".into(),
            "HTTP/1.1 302 Found\r\nLocation: /elsewhere/app.js\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .into(),
        );
        routes.insert("/elsewhere/app.js".into(), ok(APP_JS));
        let base = serve(routes.clone()).await;
        let fetcher = HttpFetcher::new().unwrap();
        let refused = refresh_pointer(&fetcher, &f.store, &base, &base, Some(trust(&f.key))).await;
        assert_eq!(refused, Err(Refusal::Fetch));
        assert!(f.store.pointer(&base).current.is_none());
        // Served in place, the same build is accepted over real HTTP.
        routes.insert("/assets/app.js".into(), ok(APP_JS));
        let base = serve(routes).await;
        let pointer = refresh_pointer(&fetcher, &f.store, &base, &base, Some(trust(&f.key)))
            .await
            .unwrap();
        assert_eq!(pointer.current.as_deref(), Some(BUILD));
    });
}

// ── parsing, ranges, flags ──

#[test]
fn the_shell_statement_parser_mirrors_the_shared_one() {
    let key = TestKey::new(1);
    let files = vec![("index.html".to_string(), b"x".to_vec())];
    let good = statement_value(&key, &files);
    assert!(parse_shell_statement(canonical_json(&good).as_bytes()).is_some());
    let reparse = |edit: &dyn Fn(&mut Value)| {
        let mut v = good.clone();
        edit(&mut v);
        parse_shell_statement(canonical_json(&v).as_bytes())
    };
    assert!(reparse(&|v| v["extra"] = Value::from(1)).is_none());
    assert!(reparse(&|v| v["bridge"]["web"] = Value::from("^1")).is_none());
    assert!(reparse(&|v| v["mode"] = Value::from("web")).is_none());
    assert!(reparse(&|v| v["buildId"] = Value::from("XYZ")).is_none());
    assert!(reparse(&|v| v["commit"] = Value::from("abc")).is_none());
    assert!(reparse(&|v| v["seq"] = Value::from(1.5)).is_none());
    assert!(reparse(&|v| v["seq"] = Value::from(-1)).is_none());
    assert!(reparse(&|v| v["seq"] = Value::from(1u64 << 53)).is_none());
    assert!(reparse(&|v| v["settingsSchema"] = Value::from("1")).is_none());
    assert!(reparse(&|v| v["files"] = serde_json::json!({})).is_none());
    for bad in ["../etc/passwd", "/index.html", "a//b", "a/./b", "a\\b", ""] {
        assert!(
            reparse(&|v| v["files"] = serde_json::json!({ bad: "b".repeat(64) })).is_none(),
            "{bad}"
        );
    }
    assert!(
        reparse(&|v| v["files"] = serde_json::json!({ "index.html": "B".repeat(64) })).is_none()
    );
    assert!(reparse(&|v| {
        v.as_object_mut().unwrap().remove("kind");
    })
    .is_none());
    // Not canonical (whitespace) is not a statement.
    let pretty = serde_json::to_string_pretty(&good).unwrap();
    assert!(parse_shell_statement(pretty.as_bytes()).is_none());
}

#[test]
fn bridge_ranges_read_like_the_web_side() {
    let cases: [(&str, u64, bool); 22] = [
        ("^1", 1, true),
        ("^1", 2, false),
        ("^1", 0, false),
        ("^2", 1, false),
        ("~1", 1, true),
        ("1", 1, true),
        ("=1", 1, true),
        (">=1", 3, true),
        (">=2", 1, false),
        (">1", 1, false),
        ("<2", 1, true),
        ("<=1", 1, true),
        (">=1 <3", 2, true),
        (">=1 <3", 3, false),
        ("^1 || ^2", 2, true),
        ("^1 || ^3", 2, false),
        ("", 1, false),
        ("^", 1, false),
        ("^01", 1, false),
        ("^1.0.0", 1, false),
        ("^1 || garbage", 1, false),
        ("^1 ||", 1, false),
    ];
    for (range, version, want) in cases {
        assert_eq!(
            bridge_range_allows(range, version),
            want,
            "{range} @ {version}"
        );
    }
}

#[test]
fn this_host_speaks_the_bridge_version_the_web_build_declares_and_accepts_its_own_range() {
    let contract = include_str!("../../../../web/src/lib/desktop-shell-contract.ts");
    assert!(
        contract.contains(&format!(
            "export const DESKTOP_BRIDGE_VERSION = {DESKTOP_BRIDGE_VERSION}\n"
        )),
        "DESKTOP_BRIDGE_VERSION differs between the host and apps/web"
    );
    let ranges = include_str!("../../../../web/src/lib/shell-bridge-range.ts");
    let at = ranges.find("desktop: \"").expect("a desktop range") + "desktop: \"".len();
    let range = &ranges[at..at + ranges[at..].find('"').unwrap()];
    assert!(
        bridge_range_allows(range, DESKTOP_BRIDGE_VERSION),
        "{range}"
    );
}

#[test]
fn fleet_flags_verify_keep_and_never_go_back() {
    let f = fixture("flags");
    let keys = [f.key.pinned.clone()];
    let flags = |seq: u64, desktop: bool| {
        let value = serde_json::json!({
            "v": 1, "seq": seq, "issuedAt": "2026-11-28T00:00:00.000Z",
            "servedShell": { "desktop": desktop, "native": true },
        });
        signed(&f.key, &value)
    };
    assert!(f.store.flags(&keys).is_none());
    let (off, off_sig) = flags(5, false);
    assert_eq!(
        f.store
            .offer_flags(&off, &off_sig, &keys)
            .map(|f| f.desktop),
        Some(false)
    );
    // A replayed older "on" is ignored.
    let (on, on_sig) = flags(4, true);
    assert_eq!(
        f.store.offer_flags(&on, &on_sig, &keys).map(|f| f.seq),
        Some(5)
    );
    // A bad signature changes nothing.
    assert_eq!(
        f.store.offer_flags(&on, &off_sig, &keys).map(|f| f.seq),
        Some(5)
    );
    let (on, on_sig) = flags(6, true);
    assert_eq!(
        f.store.offer_flags(&on, &on_sig, &keys).map(|f| f.desktop),
        Some(true)
    );
    assert_eq!(f.store.flags(&keys).map(|f| f.seq), Some(6));
}

#[test]
fn a_shell_entry_for_an_unknown_mode_is_dropped_whatever_its_fields() {
    let list = canonical_json(&serde_json::json!({
        "v": 1, "seq": 1, "issuedAt": "2026-11-28T00:00:00.000Z",
        "entries": [
            { "name": "shell:web", "below": "1" },
            { "name": "shell:watch", "floor": 3, "extra": true },
            { "name": "shell:desktop", "below": "1764300000" },
        ],
    }));
    let parsed = app_signing::parse_revocation_list(list.as_bytes()).expect("the list parses");
    assert_eq!(parsed.entries.len(), 1);
    assert_eq!(parsed.entries[0].name, "shell:desktop");
}

#[test]
fn a_malformed_shell_floor_refuses_the_whole_list_like_the_shared_parser() {
    let list = |entries: Value| {
        canonical_json(&serde_json::json!({
            "v": 1, "seq": 1, "issuedAt": "2026-11-28T00:00:00.000Z", "entries": entries,
        }))
    };
    let good = list(serde_json::json!([{ "name": "shell:desktop", "below": "1764300000" }]));
    assert!(app_signing::parse_revocation_list(good.as_bytes()).is_some());
    for bad in [
        serde_json::json!([{ "name": "shell:desktop", "below": "1.0.0" }]),
        serde_json::json!([{ "name": "shell:desktop", "below": "1234567890123456" }]),
        serde_json::json!([{ "name": "shell:desktop", "versions": ["1"] }]),
    ] {
        assert!(
            app_signing::parse_revocation_list(list(bad.clone()).as_bytes()).is_none(),
            "{bad}"
        );
    }
}

#[test]
fn the_cross_language_vector_verifies_here() {
    let vector: Value = serde_json::from_str(include_str!(
        "../../../../../packages/shared/src/app-signing/shell-statement.vector.json"
    ))
    .unwrap();
    // The vector's key is the Rust test key of seed 7: same key id rule.
    let key = TestKey::new(7);
    assert_eq!(vector["key"]["keyId"], key.pinned.key_id.as_str());
    let encoded = base64::engine::general_purpose::STANDARD.encode(key.pinned.public);
    assert_eq!(vector["key"]["publicKey"], encoded.as_str());
    let keys = [key.pinned.clone()];
    let statement = vector["statement"].as_str().unwrap().as_bytes();
    let sig = vector["statementSig"].as_str().unwrap();
    // The signature is deterministic: Rust signs the same bytes the same way.
    assert_eq!(key.sign(statement), sig);
    let t = Trust {
        keys: &keys,
        floor: &[],
        list: None,
        bridge_version: 1,
    };
    let parsed = verify_shell_statement(statement, sig, t, "0123456789abcdef").unwrap();
    for (path, body) in vector["files"].as_object().unwrap() {
        assert_eq!(
            parsed.files[path],
            sha256_hex(body.as_str().unwrap().as_bytes())
        );
    }
    let list = app_signing::verify_revocation_list(
        vector["revocations"].as_str().unwrap().as_bytes(),
        vector["revocationsSig"].as_str().unwrap(),
        &keys,
    )
    .expect("the list verifies");
    // 999999999 is below "1000000000" numerically (not as text).
    let t = Trust {
        list: Some(&list),
        ..t
    };
    assert_eq!(
        verify_shell_statement(statement, sig, t, "0123456789abcdef"),
        Err(Refusal::Revoked)
    );
    // The app floor in the same list still parses as an app entry.
    assert!(app_signing::revocation_for("invoicing", "0.1.9", &[], Some(&list)).is_some());
}

// ── T2: selection and the resolver ──

fn local(key: &TestKey) -> Local<'_> {
    Local {
        trust: trust(key),
        fleet_enabled: true,
        revocations_fresh: true,
    }
}

fn installed(label: &str) -> Fixture {
    let f = fixture(label);
    let fake = Fake::serving(&f, &statement_value(&f.key, &f.files));
    refresh_with(&f, &fake, trust(&f.key)).unwrap();
    f
}

#[test]
fn selection_serves_the_verified_build_and_falls_back_to_bundled_with_a_reason() {
    let f = installed("select");
    let served = select(&f.store, SERVER, &local(&f.key));
    assert_eq!(served.build_id(), Some(BUILD));
    let reason = |a: Active| match a {
        Active::Bundled(r) => r,
        Active::Served(b) => panic!("served {}", b.build_id),
    };
    let off = Local {
        fleet_enabled: false,
        ..local(&f.key)
    };
    assert_eq!(reason(select(&f.store, SERVER, &off)), "fleet_off");
    let stale = Local {
        revocations_fresh: false,
        ..local(&f.key)
    };
    assert_eq!(
        reason(select(&f.store, SERVER, &stale)),
        "revocations_stale"
    );
    assert_eq!(
        reason(select(&f.store, "https://other.example", &local(&f.key))),
        "no_build"
    );
    // A host update raising the bridge version past the stored range.
    let newer = Local {
        trust: Trust {
            bridge_version: 2,
            ..trust(&f.key)
        },
        ..local(&f.key)
    };
    assert_eq!(reason(select(&f.store, SERVER, &newer)), "bridge");
    // A blob deleted from disk.
    let js = sha256_hex(APP_JS.as_bytes());
    std::fs::remove_file(f.dir.join("blobs").join(&js)).unwrap();
    assert_eq!(
        reason(select(&f.store, SERVER, &local(&f.key))),
        "missing_file"
    );
}

#[test]
fn the_resolver_serves_only_listed_paths_rehashed_and_never_a_bundled_file() {
    let f = installed("resolve");
    let state = ShellState::new();
    assert!(matches!(state.resolve("index.html"), Resolved::Bundled));
    state.set_active(select(&f.store, SERVER, &local(&f.key)));
    let served = |path: &str| match state.resolve(path) {
        Resolved::Served(bytes) => bytes,
        Resolved::Bundled => panic!("bundled for {path}"),
    };
    assert_eq!(served("index.html").as_deref(), Some(INDEX.as_bytes()));
    assert_eq!(served("assets/app.js").as_deref(), Some(APP_JS.as_bytes()));
    assert_eq!(served("assets/other.js"), None);
    assert_eq!(served("favicon.svg"), None);
    // A blob changed on disk after verification is not served.
    std::fs::write(
        f.dir.join("blobs").join(sha256_hex(APP_JS.as_bytes())),
        "alert(1)",
    )
    .unwrap();
    assert_eq!(served("assets/app.js"), None);
    assert_eq!(state.status().build_id.as_deref(), Some(BUILD));
    // The CSP hashes are the inline script's, not the module script's.
    assert_eq!(
        state.csp_for("index.html"),
        Some(vec![csp_hash("window.x=1")])
    );
}

#[test]
fn a_staged_build_waits_for_the_next_document_load() {
    let f = installed("stage");
    let state = ShellState::new();
    state.set_active(Active::Bundled("no_build".into()));
    state.stage(select(&f.store, SERVER, &local(&f.key)));
    assert!(state.status().pending);
    // A lazy chunk of the running page: still bundled.
    assert!(matches!(state.resolve("assets/app.js"), Resolved::Bundled));
    // Tauri's last fallback for a path no build lists is `index.html`: with
    // no document load expected it is the running (bundled) page's.
    assert!(matches!(state.resolve("index.html"), Resolved::Bundled));
    assert!(state.status().pending);
    // The next document load runs the staged build.
    state.expect_document();
    assert!(matches!(
        state.resolve("index.html"),
        Resolved::Served(Some(_))
    ));
    assert_eq!(state.status().build_id.as_deref(), Some(BUILD));
    assert!(!state.status().pending);
    // Staging what already runs leaves nothing pending.
    state.stage(select(&f.store, SERVER, &local(&f.key)));
    assert!(!state.status().pending);
}

#[test]
fn inline_scripts_are_found_like_an_html_parser_reads_them() {
    let html = "<!-- <script>no</script> --><SCRIPT type=\"importmap\">{\"a\":1}</SCRIPT>\
        <script src=\"/x.js\"></script><style>p{content:\"<script>\"}</style>\
        <script data-x='a>b'>\r\nlet y = \"</scr\" + \"ipt>\"\r\n</script>";
    let found = inline_scripts(html);
    assert_eq!(
        found,
        vec!["{\"a\":1}", "\r\nlet y = \"</scr\" + \"ipt>\"\r\n"]
    );
    // CRLF hashed as LF.
    assert_eq!(csp_hash("a\r\nb"), csp_hash("a\nb"));
}

// ── T3: ready, last good, quarantine ──

#[test]
fn two_missed_readies_quarantine_a_build_and_the_last_good_one_runs() {
    let mut pointer = Pointer {
        current: Some("bbbbbbbbbbbbbbbb".into()),
        last_good: Some("aaaaaaaaaaaaaaaa".into()),
        ..Pointer::default()
    };
    assert!(!note_miss(&mut pointer, "bbbbbbbbbbbbbbbb"));
    assert!(pointer.quarantined.is_empty());
    assert!(note_miss(&mut pointer, "bbbbbbbbbbbbbbbb"));
    assert_eq!(pointer.quarantined, vec!["bbbbbbbbbbbbbbbb".to_string()]);
    assert_eq!(pointer.last_good.as_deref(), Some("aaaaaaaaaaaaaaaa"));
    assert!(pointer.misses.is_empty());
    note_good(&mut pointer, "aaaaaaaaaaaaaaaa");
    assert_eq!(pointer.last_good.as_deref(), Some("aaaaaaaaaaaaaaaa"));
}

#[test]
fn a_build_that_never_signals_ready_ends_on_the_bundled_shell_and_is_not_retried() {
    let f = installed("quarantine");
    let state = ShellState::new();
    let armed = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = armed.clone();
    state.set_on_arm(Box::new(move |id, server| {
        assert_eq!(server, SERVER);
        seen.lock().unwrap().push(id)
    }));
    state.set_active(select(&f.store, SERVER, &local(&f.key)));
    // First load arms the timer; a reload of the same build does not re-arm.
    state.expect_document();
    state.resolve("index.html");
    state.expect_document();
    state.resolve("index.html");
    assert_eq!(armed.lock().unwrap().len(), 1);
    // First miss: counted, the build is retried (re-armed on the next load).
    let mut pointer = f.store.pointer(SERVER);
    assert!(!note_miss(&mut pointer, BUILD));
    f.store.save_pointer(SERVER, &pointer).unwrap();
    state.disarm();
    state.expect_document();
    state.resolve("index.html");
    assert_eq!(armed.lock().unwrap().len(), 2);
    // Second miss: quarantined; no last good build, so bundled.
    let mut pointer = f.store.pointer(SERVER);
    assert!(note_miss(&mut pointer, BUILD));
    f.store.save_pointer(SERVER, &pointer).unwrap();
    let next = select(&f.store, SERVER, &local(&f.key));
    assert!(matches!(&next, Active::Bundled(reason) if reason == "quarantined"));
    state.set_active(next);
    assert!(matches!(state.resolve("index.html"), Resolved::Bundled));
    // The same build id from the server is not fetched again.
    let fake = Fake::serving(&f, &statement_value(&f.key, &f.files));
    let pointer = refresh_with(&f, &fake, trust(&f.key)).unwrap();
    assert!(pointer.quarantined.contains(&BUILD.to_string()));
    assert!(matches!(
        select(&f.store, SERVER, &local(&f.key)),
        Active::Bundled(_)
    ));
}

#[test]
fn a_ready_build_is_never_armed_again_and_ready_from_another_build_counts_for_nothing() {
    let f = installed("ready");
    let state = ShellState::new();
    let armed = Arc::new(Mutex::new(0usize));
    let seen = armed.clone();
    state.set_on_arm(Box::new(move |_, _| *seen.lock().unwrap() += 1));
    state.set_active(select(&f.store, SERVER, &local(&f.key)));
    assert_eq!(state.note_ready("ffffffffffffffff"), None);
    assert_eq!(state.note_ready(BUILD).as_deref(), Some(SERVER));
    assert!(state.is_ready(BUILD));
    state.expect_document();
    state.resolve("index.html");
    assert_eq!(*armed.lock().unwrap(), 0);
}

// ── review P6 fixes ──

const OTHER: &str = "fedcba9876543210";

/// Installs a second build `OTHER` of SERVER with its own files.
fn install_other(f: &Fixture, files: &[(String, Vec<u8>)]) {
    let mut value = statement_value(&f.key, files);
    value["buildId"] = Value::String(OTHER.into());
    let (bytes, sig) = signed(&f.key, &value);
    let fetched: Vec<(String, Vec<u8>)> = files
        .iter()
        .map(|(_, b)| (sha256_hex(b), b.clone()))
        .collect();
    f.store.install(OTHER, &bytes, &sig, &fetched).unwrap();
}

fn other_files() -> Vec<(String, Vec<u8>)> {
    vec![
        (
            "index.html".into(),
            b"<!doctype html><title>other</title>".to_vec(),
        ),
        (
            "assets/other.js".into(),
            b"export const other = 2\n".to_vec(),
        ),
    ]
}

fn served_of(store: &ShellStore, build_id: &str, key: &TestKey) -> Active {
    let mut build = load_build(store, build_id, trust(key)).unwrap();
    build.server = SERVER.into();
    Active::Served(Arc::new(build))
}

#[test]
fn an_unlisted_path_while_a_build_is_staged_serves_the_running_build_and_arms_nothing() {
    let f = installed("fallback");
    install_other(&f, &other_files());
    let state = ShellState::new();
    let armed = Arc::new(Mutex::new(0usize));
    let seen = armed.clone();
    state.set_on_arm(Box::new(move |_, _| *seen.lock().unwrap() += 1));
    state.set_active(served_of(&f.store, BUILD, &f.key));
    state.stage(served_of(&f.store, OTHER, &f.key));
    // Tauri asks `missing.js`, then its `.html` and `/index.html` forms, then
    // `index.html`: the running build's page, no swap, no ready window.
    for path in ["missing.js", "missing.js.html", "missing.js/index.html"] {
        assert!(matches!(state.resolve(path), Resolved::Served(None)));
    }
    let Resolved::Served(Some(body)) = state.resolve("index.html") else {
        panic!("the running index.html");
    };
    assert_eq!(body, INDEX.as_bytes());
    assert_eq!(state.active_build().as_deref(), Some(BUILD));
    assert_eq!(state.pending_report().as_deref(), Some(OTHER));
    assert_eq!(*armed.lock().unwrap(), 0);
    // The explicit load swaps and arms once.
    state.expect_document();
    assert!(matches!(
        state.resolve("index.html"),
        Resolved::Served(Some(_))
    ));
    assert_eq!(state.active_build().as_deref(), Some(OTHER));
    assert_eq!(*armed.lock().unwrap(), 1);
    // The page that was running may still load its own chunks...
    assert_eq!(
        match state.resolve("assets/app.js") {
            Resolved::Served(b) => b,
            Resolved::Bundled => None,
        }
        .as_deref(),
        Some(APP_JS.as_bytes())
    );
    // ...until the new build signals ready: then only the new build serves.
    assert_eq!(state.note_ready(OTHER).as_deref(), Some(SERVER));
    assert!(matches!(
        state.resolve("assets/app.js"),
        Resolved::Served(None)
    ));
}

#[test]
fn only_a_main_frame_load_of_the_app_origin_is_a_document_load() {
    for (url, yes) in [
        ("tauri://localhost/", true),
        ("tauri://localhost/tickets/12", true),
        ("http://tauri.localhost/", true),
        ("https://tauri.localhost/x", true),
        ("liaison-frame://app/index.html", false),
        ("http://liaison-frame.localhost/", false),
        ("https://example.com/", false),
        ("tauri://evil/", false),
    ] {
        assert_eq!(
            is_app_document(&url::Url::parse(url).unwrap()),
            yes,
            "{url}"
        );
    }
    let state = ShellState::new();
    on_navigation(&state, &url::Url::parse("liaison-frame://app/").unwrap());
    assert!(!state.selection.read().unwrap().expect_document);
    on_navigation(&state, &url::Url::parse("tauri://localhost/").unwrap());
    assert!(state.selection.read().unwrap().expect_document);
}

fn list_text(key: &TestKey, seq: u64, entries: Value) -> (Vec<u8>, String) {
    signed(
        key,
        &serde_json::json!({
            "v": 1, "seq": seq, "issuedAt": "2026-11-28T00:00:00.000Z", "entries": entries,
        }),
    )
}

fn revocations_url() -> &'static str {
    crate::verified_apps::REVOCATIONS_URL
}

/// The Local the app builds from its stores.
fn read_local<'a>(
    f: &'a Fixture,
    cache: &crate::verified_apps::VerifiedCache,
    list: &'a mut Option<RevocationList>,
) -> Local<'a> {
    let keys = std::slice::from_ref(&f.key.pinned);
    *list = cache.stored_revocations(keys).unwrap();
    Local {
        trust: Trust {
            keys,
            floor: &[],
            list: list.as_ref(),
            bridge_version: DESKTOP_BRIDGE_VERSION,
        },
        fleet_enabled: f.store.fleet_enabled(keys),
        revocations_fresh: f.store.revocations_fresh(SystemTime::now()),
    }
}

#[test]
fn a_revocation_or_kill_switch_read_while_running_stops_the_build_at_once() {
    let f = installed("leave");
    let cache = crate::verified_apps::VerifiedCache::new(f.dir.join("verified"));
    let keys = [f.key.pinned.clone()];
    // A first list (nothing revoked) is read: the build runs.
    let mut fake = Fake::serving(&f, &statement_value(&f.key, &f.files));
    let (list, sig) = list_text(&f.key, 1, serde_json::json!([]));
    fake.put(revocations_url(), list);
    fake.put(format!("{}.sig", revocations_url()), sig);
    run(read_lists_then_server(
        &fake, &f.store, &cache, &keys, DL, SERVER,
    ));
    let mut held = None;
    let running = select(&f.store, SERVER, &read_local(&f, &cache, &mut held));
    let Active::Served(build) = running.clone() else {
        panic!("served");
    };
    let mut held = None;
    let local = read_local(&f, &cache, &mut held);
    assert!(matches!(
        after_refresh(&f.store, SERVER, &local, Some(&build)),
        AfterRefresh::Stage(_)
    ));
    // Liaison raises the shell floor over this build (seq 1_764_300_000).
    let (list, sig) = list_text(
        &f.key,
        2,
        serde_json::json!([{ "name": "shell:desktop", "below": "1764300001" }]),
    );
    fake.put(revocations_url(), list);
    fake.put(format!("{}.sig", revocations_url()), sig);
    run(read_lists_then_server(
        &fake, &f.store, &cache, &keys, DL, SERVER,
    ));
    let mut held = None;
    let local = read_local(&f, &cache, &mut held);
    match after_refresh(&f.store, SERVER, &local, Some(&build)) {
        AfterRefresh::Leave { next, reason } => {
            assert_eq!(reason, "revoked");
            assert!(matches!(next, Active::Bundled(r) if r == "revoked"));
        }
        other => panic!("{other:?}"),
    }
    // The window applies it: the bundled shell, at once, no staged leftover.
    let state = ShellState::new();
    state.set_active(running);
    state.set_active(Active::Bundled("revoked".into()));
    assert_eq!(state.status().reason.as_deref(), Some("revoked"));
    assert_eq!(state.pending_report(), None);
}

#[test]
fn a_kill_switch_flipped_while_running_stops_the_build_at_once() {
    let f = installed("kill");
    let cache = crate::verified_apps::VerifiedCache::new(f.dir.join("verified"));
    let keys = [f.key.pinned.clone()];
    f.store.mark_revocations_fetched(SystemTime::now());
    let mut held = None;
    let Active::Served(build) = select(&f.store, SERVER, &read_local(&f, &cache, &mut held)) else {
        panic!("served");
    };
    // The server's own switch.
    let mut fake = Fake::default();
    fake.put(
        format!("{SERVER}/api/shell/info"),
        format!(r#"{{"data":{{"desktop":{{"buildId":"{BUILD}"}},"servedShell":false}}}}"#),
    );
    run(read_lists_then_server(
        &fake, &f.store, &cache, &keys, DL, SERVER,
    ));
    let mut held = None;
    let local = read_local(&f, &cache, &mut held);
    assert!(matches!(
        after_refresh(&f.store, SERVER, &local, Some(&build)),
        AfterRefresh::Leave { reason, .. } if reason == "server_off"
    ));
    // The fleet's.
    f.store
        .update_pointer(SERVER, |p| {
            p.served_shell = Some(true);
            true
        })
        .unwrap();
    let (off, off_sig) = signed(
        &f.key,
        &serde_json::json!({
            "v": 1, "seq": 3, "issuedAt": "2026-11-28T00:00:00.000Z",
            "servedShell": { "desktop": false, "native": true },
        }),
    );
    fake.put(format!("{DL}/shell/flags.json"), off);
    fake.put(format!("{DL}/shell/flags.json.sig"), off_sig);
    fake.put(
        format!("{SERVER}/api/shell/info"),
        format!(r#"{{"data":{{"desktop":{{"buildId":"{BUILD}"}},"servedShell":true}}}}"#),
    );
    run(read_lists_then_server(
        &fake, &f.store, &cache, &keys, DL, SERVER,
    ));
    let mut held = None;
    let local = read_local(&f, &cache, &mut held);
    assert!(matches!(
        after_refresh(&f.store, SERVER, &local, Some(&build)),
        AfterRefresh::Leave { reason, .. } if reason == "fleet_off"
    ));
    // A build of another server is not this server's to stop.
    let mut elsewhere = load_build(&f.store, BUILD, trust(&f.key)).unwrap();
    elsewhere.server = "https://other.example".into();
    assert!(matches!(
        after_refresh(&f.store, SERVER, &local, Some(&elsewhere)),
        AfterRefresh::Stage(_)
    ));
}

#[test]
fn a_start_whose_lists_do_not_answer_in_time_selects_from_the_kept_copies() {
    let f = installed("deadline");
    let cache = crate::verified_apps::VerifiedCache::new(f.dir.join("verified"));
    let keys = [f.key.pinned.clone()];
    f.store.mark_revocations_fetched(SystemTime::now());
    let mut fake = Fake::serving(&f, &statement_value(&f.key, &f.files));
    let (list, sig) = list_text(
        &f.key,
        2,
        serde_json::json!([{ "name": "shell:desktop", "below": "1764300001" }]),
    );
    fake.put(revocations_url(), list);
    fake.put(format!("{}.sig", revocations_url()), sig);
    fake.delay = Some(Duration::from_millis(500));
    let started = std::time::Instant::now();
    let read = run(async {
        tokio::time::timeout(
            Duration::from_millis(50),
            read_lists_then_server(&fake, &f.store, &cache, &keys, DL, SERVER),
        )
        .await
    });
    assert!(read.is_err());
    assert!(started.elapsed() < Duration::from_millis(400));
    let mut held = None;
    assert!(matches!(
        select(&f.store, SERVER, &read_local(&f, &cache, &mut held)),
        Active::Served(_)
    ));
    // Answered in time, the raised floor decides before the build is chosen.
    fake.delay = None;
    run(async {
        tokio::time::timeout(
            START_DEADLINE,
            read_lists_then_server(&fake, &f.store, &cache, &keys, DL, SERVER),
        )
        .await
    })
    .unwrap();
    let mut held = None;
    assert!(matches!(
        select(&f.store, SERVER, &read_local(&f, &cache, &mut held)),
        Active::Bundled(r) if r == "revoked"
    ));
}

#[test]
fn a_staged_bundled_shell_is_reported_to_the_page() {
    let f = installed("pending-bundled");
    let state = ShellState::new();
    state.set_active(served_of(&f.store, BUILD, &f.key));
    assert_eq!(state.pending_report(), None);
    state.stage(Active::Bundled("no_build".into()));
    assert_eq!(state.pending_report().as_deref(), Some(PENDING_BUNDLED));
    assert!(state.status().pending);
}

#[test]
fn refreshes_are_due_by_the_wall_clock() {
    let t = UNIX_EPOCH + Duration::from_secs(1_000_000);
    assert!(refresh_due(None, t, REFRESH_EVERY));
    assert!(!refresh_due(
        Some(t),
        t + Duration::from_secs(60),
        REFRESH_EVERY
    ));
    assert!(refresh_due(Some(t), t + REFRESH_EVERY, REFRESH_EVERY));
    // A clock set back counts as due.
    assert!(refresh_due(
        Some(t),
        t - Duration::from_secs(1),
        REFRESH_EVERY
    ));
    let state = ShellState::new();
    assert!(state.refresh_due(t, FOCUS_REFRESH_AFTER));
    assert!(!state.refresh_due(t + Duration::from_secs(10), FOCUS_REFRESH_AFTER));
    assert!(state.refresh_due(t + FOCUS_REFRESH_AFTER, FOCUS_REFRESH_AFTER));
}

#[test]
fn a_corrupted_blob_is_deleted_never_trusted_and_fetched_again() {
    let f = installed("corrupt");
    let js = sha256_hex(APP_JS.as_bytes());
    let blob = f.dir.join("blobs").join(&js);
    std::fs::write(&blob, "export const app = 1").unwrap(); // truncated
    assert!(matches!(
        select(&f.store, SERVER, &local(&f.key)),
        Active::Bundled(r) if r == "missing_file"
    ));
    assert!(
        !blob.exists(),
        "a blob that does not match its name is deleted"
    );
    // The next refresh fetches it again and the build runs.
    let fake = Fake::serving(&f, &statement_value(&f.key, &f.files));
    refresh_with(&f, &fake, trust(&f.key)).unwrap();
    assert_eq!(std::fs::read(&blob).unwrap(), APP_JS.as_bytes());
    assert_eq!(
        select(&f.store, SERVER, &local(&f.key)).build_id(),
        Some(BUILD)
    );
    // install replaces a kept blob that no longer verifies.
    std::fs::write(&blob, "alert(1)").unwrap();
    let (statement, sig) = f.store.record(BUILD).unwrap();
    f.store
        .install(BUILD, &statement, &sig, &[(js, APP_JS.as_bytes().to_vec())])
        .unwrap();
    assert_eq!(std::fs::read(&blob).unwrap(), APP_JS.as_bytes());
}

#[test]
fn pointer_writes_never_lose_a_quarantine_or_a_last_good_build() {
    let f = fixture("pointer");
    // A quarantine and a last good build recorded while a fetch runs.
    let dir = f.dir.clone();
    let mut fake = Fake::serving(&f, &statement_value(&f.key, &f.files));
    fake.on_file = Some(Box::new(move || {
        ShellStore::new(dir.clone())
            .update_pointer(SERVER, |p| {
                if !p.quarantined.contains(&"cccccccccccccccc".to_string()) {
                    p.quarantined.push("cccccccccccccccc".into());
                }
                p.last_good = Some("aaaaaaaaaaaaaaaa".into());
                true
            })
            .unwrap();
    }));
    let pointer = refresh_with(&f, &fake, trust(&f.key)).unwrap();
    assert_eq!(pointer.current.as_deref(), Some(BUILD));
    assert_eq!(pointer, f.store.pointer(SERVER));
    assert_eq!(pointer.quarantined, vec!["cccccccccccccccc".to_string()]);
    assert_eq!(pointer.last_good.as_deref(), Some("aaaaaaaaaaaaaaaa"));
    // Concurrent writers: every one of them lands.
    let threads: Vec<_> = (0..8)
        .map(|i| {
            let dir = f.dir.clone();
            std::thread::spawn(move || {
                ShellStore::new(dir)
                    .update_pointer(SERVER, |p| {
                        p.quarantined.push(format!("{i:016x}"));
                        true
                    })
                    .unwrap();
            })
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
    assert_eq!(f.store.pointer(SERVER).quarantined.len(), 9);
    // No temporary file is left behind.
    let leftovers = std::fs::read_dir(f.dir.join("servers"))
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().contains("tmp"))
        .count();
    assert_eq!(leftovers, 0);
}

#[test]
fn a_build_fetch_has_one_deadline_and_one_budget() {
    let f = fixture("slow");
    let mut fake = Fake::serving(&f, &statement_value(&f.key, &f.files));
    fake.delay = Some(Duration::from_millis(200));
    let refused = run(fetch_build_within(
        &fake,
        &f.store,
        DL,
        SERVER,
        BUILD,
        trust(&f.key),
        Duration::from_millis(300),
    ));
    assert_eq!(refused, Err(Refusal::Fetch));
    assert!(no_blobs(&f));
    assert!(f.store.record(BUILD).is_none());
    let budget = Budget::new(10);
    assert!(budget.take(6));
    assert!(!budget.take(5));
    assert_eq!(budget.left(), 4);
    assert!(budget.take(4));
    assert_eq!(budget.left(), 0);
}

#[test]
fn every_served_response_carries_the_pinned_csp() {
    use tauri::http::header::CONTENT_SECURITY_POLICY;
    let csp = "default-src 'self'";
    let response = || tauri::http::Response::new(Cow::Borrowed(&b"x"[..]));
    let mut js = response();
    add_csp_header(true, csp, &mut js);
    assert_eq!(js.headers()[CONTENT_SECURITY_POLICY], csp);
    // An HTML response keeps Tauri's own (with its script hashes).
    let mut html = response();
    html.headers_mut().insert(
        CONTENT_SECURITY_POLICY,
        "default-src 'self'; script-src 'self' 'sha256-x'"
            .parse()
            .unwrap(),
    );
    add_csp_header(true, csp, &mut html);
    assert!(html.headers()[CONTENT_SECURITY_POLICY]
        .to_str()
        .unwrap()
        .contains("sha256-x"));
    // The bundled shell is unchanged.
    let mut bundled = response();
    add_csp_header(false, csp, &mut bundled);
    assert!(!bundled.headers().contains_key(CONTENT_SECURITY_POLICY));
}

#[test]
fn kept_flags_no_pinned_key_verifies_turn_the_served_shell_off_until_new_ones_verify() {
    let f = fixture("rotation");
    let old = TestKey::new(1);
    let new = TestKey::new(2);
    let flags = |key: &TestKey, seq: u64, desktop: bool| {
        signed(
            key,
            &serde_json::json!({
                "v": 1, "seq": seq, "issuedAt": "2026-11-28T00:00:00.000Z",
                "servedShell": { "desktop": desktop, "native": true },
            }),
        )
    };
    assert!(f.store.fleet_enabled(std::slice::from_ref(&new.pinned)));
    let (off, sig) = flags(&old, 9, false);
    f.store
        .offer_flags(&off, &sig, std::slice::from_ref(&old.pinned));
    assert!(!f.store.fleet_enabled(std::slice::from_ref(&old.pinned)));
    // The rotation drops the old key: the stored "off" no longer verifies,
    // and that is OFF, never "no flags".
    let rotated = std::slice::from_ref(&new.pinned);
    assert_eq!(
        f.store.stored_flags(rotated),
        StoredFlags::Unverifiable { seq: 9 }
    );
    assert!(!f.store.fleet_enabled(rotated));
    // Flags under the new key below the kept seq are refused...
    let (on, on_sig) = flags(&new, 8, true);
    assert_eq!(f.store.offer_flags(&on, &on_sig, rotated), None);
    assert!(!f.store.fleet_enabled(rotated));
    // ...at or above it, they apply.
    let (on, on_sig) = flags(&new, 10, true);
    assert_eq!(
        f.store
            .offer_flags(&on, &on_sig, rotated)
            .map(|f| f.desktop),
        Some(true)
    );
    assert!(f.store.fleet_enabled(rotated));
}

#[test]
fn the_ready_window_covers_the_pages_bounded_session_restore() {
    let auth = include_str!("../../../../web/src/modules/auth/auth-store.ts");
    let line = auth
        .lines()
        .find(|l| l.starts_with("const RESTORE_TIMEOUT_MS ="))
        .expect("the restore bound");
    let ms: u64 = line
        .trim_start_matches("const RESTORE_TIMEOUT_MS =")
        .trim()
        .replace('_', "")
        .parse()
        .unwrap();
    assert!(READY_WITHIN >= Duration::from_millis(ms) + Duration::from_secs(10));
}
