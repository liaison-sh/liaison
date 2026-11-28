// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SERVED index.html THROUGH TAURI'S OWN ASSET PATH (D15, review O1).
//
// The resolver hands Tauri bytes; Tauri's manager injects the window's CSP
// into every HTML response, with the hashes the resolver reports for that
// page. This drives that real path on the mock runtime: the CSP header of
// the served index.html is the pinned policy (tauri.conf.json, byte for byte
// the literal apps/desktop/src/csp-pin.test.ts holds), and the only sources
// added to `script-src` are the sha256 of exactly the page's inline scripts,
// computed here independently of the resolver's own scanner.
use std::collections::{BTreeMap, BTreeSet};

use base64::Engine;
use regex::Regex;
use sha2::{Digest, Sha256};

use super::*;
use crate::app_signing::testing::TestKey;
use crate::app_signing::{canonical_json, sha256_hex};

/// The real page source: its two inline scripts (the import map and the
/// pre-paint theme resolver) and one module script by `src`.
const WEB_INDEX: &str = include_str!("../../../../web/index.html");
const CONF: &str = include_str!("../../tauri.conf.json");
const CSP_PIN: &str = include_str!("../../../src/csp-pin.test.ts");

fn pinned_literal() -> String {
    let start = CSP_PIN.find("const SHIPPED_CSP =").expect("the pin");
    let rest = &CSP_PIN[start..];
    let open = rest.find('"').expect("a string") + 1;
    let close = rest[open..].find('"').expect("closed") + open;
    rest[open..close].to_string()
}

fn directives(policy: &str) -> BTreeMap<String, BTreeSet<String>> {
    policy
        .split(';')
        .filter_map(|d| {
            let mut parts = d.split_whitespace();
            let name = parts.next()?.to_string();
            Some((name, parts.map(str::to_string).collect()))
        })
        .collect()
}

/// The inline scripts' hashes, by a regex rather than the resolver's scanner.
fn expected_hashes(html: &str) -> BTreeSet<String> {
    let comments = Regex::new(r"(?s)<!--.*?-->").unwrap();
    let html = comments.replace_all(html, "");
    let script = Regex::new(r"(?is)<script\b[^>]*>(.*?)</script>").unwrap();
    script
        .captures_iter(&html)
        .map(|c| c[1].to_string())
        .filter(|body| !body.is_empty())
        .map(|body| {
            let digest = Sha256::digest(body.replace("\r\n", "\n").as_bytes());
            format!(
                "'sha256-{}'",
                base64::engine::general_purpose::STANDARD.encode(digest)
            )
        })
        .collect()
}

fn served_state(dir: &Path, key: &TestKey, index: &str) -> Arc<ShellState> {
    let store = ShellStore::new(dir.to_path_buf());
    let files = vec![
        ("index.html".to_string(), index.as_bytes().to_vec()),
        ("assets/app.js".to_string(), b"export {}\n".to_vec()),
    ];
    let listed: serde_json::Map<String, Value> = files
        .iter()
        .map(|(p, b)| (p.clone(), Value::String(sha256_hex(b))))
        .collect();
    let statement = canonical_json(&serde_json::json!({
        "v": 1, "kind": "shell", "keyId": key.pinned.key_id, "mode": "desktop",
        "buildId": "0123456789abcdef", "commit": "a".repeat(40), "seq": 1,
        "liaisonVersion": "test", "bridge": { "desktop": "^1", "ios": "^1", "android": "^1" },
        "settingsSchema": 1, "files": listed, "issuedAt": "2026-11-28T00:00:00.000Z",
    }));
    let fetched: Vec<(String, Vec<u8>)> = files
        .iter()
        .map(|(_, b)| (sha256_hex(b), b.clone()))
        .collect();
    store
        .install(
            "0123456789abcdef",
            statement.as_bytes(),
            &key.sign(statement.as_bytes()),
            &fetched,
        )
        .unwrap();
    let trust = Trust {
        keys: std::slice::from_ref(&key.pinned),
        floor: &[],
        list: None,
        bridge_version: DESKTOP_BRIDGE_VERSION,
    };
    let build = load_build(&store, "0123456789abcdef", trust).unwrap();
    let state = ShellState::new();
    state.set_active(Active::Served(Arc::new(build)));
    state
}

fn resolve_through_tauri(state: Arc<ShellState>) -> tauri::Asset {
    let conf: Value = serde_json::from_str(CONF).unwrap();
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().app.security.csp =
        Some(serde_json::from_value(conf["app"]["security"]["csp"].clone()).unwrap());
    install(&mut context, state);
    let app = tauri::test::mock_builder().build(context).unwrap();
    app.asset_resolver()
        .get("index.html".into())
        .expect("index.html resolves")
}

#[test]
fn the_conf_policy_is_the_pinned_one() {
    let conf: Value = serde_json::from_str(CONF).unwrap();
    assert_eq!(
        conf["app"]["security"]["csp"].as_str(),
        Some(pinned_literal().as_str())
    );
}

#[test]
fn the_served_index_carries_the_pinned_csp_and_allows_exactly_its_inline_scripts() {
    let dir = std::env::temp_dir().join(format!("liaison-served-csp-{}", random_hex()));
    let key = TestKey::new(3);
    let asset = resolve_through_tauri(served_state(&dir, &key, WEB_INDEX));
    // The served bytes, unchanged (no nonce token in the page).
    assert_eq!(asset.bytes(), WEB_INDEX.as_bytes());
    let header = directives(asset.csp_header().expect("a CSP header"));
    let pinned = directives(&pinned_literal());
    // Every directive of the pinned policy, with every one of its sources,
    // and no directive it does not have.
    assert_eq!(
        header.keys().collect::<Vec<_>>(),
        pinned.keys().collect::<Vec<_>>()
    );
    for (name, sources) in &pinned {
        assert!(sources.is_subset(&header[name]), "{name} lost a source");
        if name != "script-src" {
            assert_eq!(&header[name], sources, "{name} changed");
        }
    }
    // script-src gains exactly the page's inline script hashes.
    let added: BTreeSet<String> = header["script-src"]
        .difference(&pinned["script-src"])
        .cloned()
        .collect();
    let expected = expected_hashes(WEB_INDEX);
    assert_eq!(
        expected.len(),
        2,
        "the page's import map and theme resolver"
    );
    assert_eq!(added, expected);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_served_page_without_inline_scripts_adds_no_source() {
    let dir = std::env::temp_dir().join(format!("liaison-served-csp-{}", random_hex()));
    let key = TestKey::new(3);
    let page = "<!doctype html><script type=\"module\" src=\"/assets/app.js\"></script>";
    let asset = resolve_through_tauri(served_state(&dir, &key, page));
    let header = directives(asset.csp_header().unwrap());
    assert_eq!(header, directives(&pinned_literal()));
    let _ = std::fs::remove_dir_all(dir);
}
