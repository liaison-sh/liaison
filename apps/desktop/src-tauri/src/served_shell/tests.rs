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
            Refusal::Mode
        };
        assert_refused(&f, &fake, trust(&f.key), want);
    }
    // A statement for another build id.
    let mut value = statement_value(&f.key, &f.files);
    value["buildId"] = Value::String("fedcba9876543210".into());
    let fake = Fake::serving(&f, &value);
    assert_refused(&f, &fake, trust(&f.key), Refusal::BuildId);
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
fn a_malformed_shell_floor_refuses_the_whole_list_like_the_shared_parser() {
    let list = |entries: Value| {
        canonical_json(&serde_json::json!({
            "v": 1, "seq": 1, "issuedAt": "2026-11-28T00:00:00.000Z", "entries": entries,
        }))
    };
    let good = list(serde_json::json!([{ "name": "shell:desktop", "below": "1764300000" }]));
    assert!(app_signing::parse_revocation_list(good.as_bytes()).is_some());
    for bad in [
        serde_json::json!([{ "name": "shell:web", "below": "1" }]),
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
    // The next document load runs the staged build.
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
    state.set_on_arm(Box::new(move |id| seen.lock().unwrap().push(id)));
    state.set_active(select(&f.store, SERVER, &local(&f.key)));
    // First load arms the timer; a reload of the same build does not re-arm.
    state.resolve("index.html");
    state.resolve("index.html");
    assert_eq!(armed.lock().unwrap().len(), 1);
    // First miss: counted, the build is retried (re-armed on the next load).
    let mut pointer = f.store.pointer(SERVER);
    assert!(!note_miss(&mut pointer, BUILD));
    f.store.save_pointer(SERVER, &pointer).unwrap();
    state.disarm();
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
    state.set_on_arm(Box::new(move |_| *seen.lock().unwrap() += 1));
    state.set_active(select(&f.store, SERVER, &local(&f.key)));
    assert!(!state.note_ready("ffffffffffffffff"));
    assert!(state.note_ready(BUILD));
    assert!(state.is_ready(BUILD));
    state.resolve("index.html");
    assert_eq!(*armed.lock().unwrap(), 0);
}
