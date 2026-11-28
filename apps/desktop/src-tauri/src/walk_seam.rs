// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE WALK SEAM: where the served shell reads Liaison's downloads host and
// whether extra keys are pinned. A release build (no `walk` feature) has no
// seam at all: the host is the compiled DOWNLOADS, the keys the compiled
// keys.json, and no environment variable changes either. A WALK build
// (`cargo build --release --features walk`) is a release build for an
// edge-case walk on a private box: there LIAISON_WALK_DOWNLOADS names a
// downloads host of the walk's own (statements, flags, revocation list) and
// LIAISON_WALK_KEYS a keys.json-shaped file whose keys are pinned beside the
// compiled ones, so the walk can sign revoked, killed, tampered or broken
// shells with a throwaway key. No release workflow passes `--features walk`
// (pinned by a test below).

use crate::served_shell::DOWNLOADS;
use crate::verified_apps::REVOCATIONS_URL;

#[cfg(feature = "walk")]
fn walk_var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
}

/// The downloads host the served shell reads statements and flags from.
pub fn downloads() -> String {
    #[cfg(feature = "walk")]
    if let Some(base) = walk_var("LIAISON_WALK_DOWNLOADS") {
        return base;
    }
    DOWNLOADS.to_string()
}

/// The signed revocation list the served shell reads.
pub fn revocations_url() -> String {
    #[cfg(feature = "walk")]
    if let Some(base) = walk_var("LIAISON_WALK_DOWNLOADS") {
        return format!("{base}/apps/revocations.json");
    }
    REVOCATIONS_URL.to_string()
}

/// A walk build pins the keys of LIAISON_WALK_KEYS beside the compiled ones.
#[cfg(feature = "walk")]
pub fn add_walk_keys(
    pinned: &mut (
        Vec<crate::app_signing::PinnedKey>,
        Vec<crate::app_signing::RevocationEntry>,
    ),
) {
    let Some(path) = walk_var("LIAISON_WALK_KEYS") else {
        return;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        eprintln!("liaison: walk keys {path} unreadable");
        return;
    };
    let (keys, _) = crate::app_signing::parse_key_file(&text);
    eprintln!("liaison: walk build: {} extra pinned key(s)", keys.len());
    pinned.0.extend(keys);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(feature = "walk"))]
    #[test]
    fn a_release_build_ignores_the_walk_variables() {
        std::env::set_var("LIAISON_WALK_DOWNLOADS", "http://127.0.0.1:9");
        std::env::set_var("LIAISON_WALK_KEYS", "/nonexistent/keys.json");
        assert_eq!(downloads(), DOWNLOADS);
        assert_eq!(revocations_url(), REVOCATIONS_URL);
        let compiled = crate::app_signing::parse_key_file(include_str!(
            "../../../../packages/shared/src/app-signing/keys.json"
        ));
        assert_eq!(crate::app_signing::pinned().0, compiled.0);
    }

    #[cfg(feature = "walk")]
    #[test]
    fn a_walk_build_reads_its_downloads_host_from_the_environment() {
        std::env::set_var("LIAISON_WALK_DOWNLOADS", "http://127.0.0.1:8899/");
        assert_eq!(downloads(), "http://127.0.0.1:8899");
        assert_eq!(
            revocations_url(),
            "http://127.0.0.1:8899/apps/revocations.json"
        );
        std::env::remove_var("LIAISON_WALK_DOWNLOADS");
        assert_eq!(downloads(), DOWNLOADS);
    }

    #[test]
    fn no_workflow_builds_the_walk_feature() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut files = vec![root.join("apps/desktop/src-tauri/tauri.conf.json")];
        if let Ok(dir) = std::fs::read_dir(root.join(".github/workflows")) {
            files.extend(dir.flatten().map(|entry| entry.path()));
        }
        for file in files {
            let text = std::fs::read_to_string(&file).unwrap_or_default();
            assert!(
                !text.contains("features walk") && !text.contains("\"walk\""),
                "{} builds the walk feature",
                file.display()
            );
        }
    }
}
