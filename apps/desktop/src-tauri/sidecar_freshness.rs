// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE BUILD GUARD AGAINST A STALE SIDECAR (2026-09-23), shared by `build.rs`
// and the crate's own tests (`main.rs` includes it under `cfg(test)`).
//
// `prepare-sidecar.ts` decides whether a sidecar binary matches its sources by
// hash and writes a stamp beside every binary it installs. What it cannot do is
// make anybody run it: a `tauri build` or a `cargo` run that skipped it used to
// bundle whatever binary was on disk, and a long lived checkout shipped a
// sidecar compiled hours before the change it was built for. So the shell's
// build refuses to go on when any sidecar input is NEWER than the installed
// stamp, and says which one. Age is enough here, because the script rewrites
// the stamp on every run after checking the hash: a stamp younger than every
// input means the script ran after the last edit.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Build output and dependencies, which are not sources. prepare-sidecar.ts
/// skips the same.
pub const SKIPPED_DIRS: [&str; 3] = ["dist", ".entries", "node_modules"];

/// Where prepare-sidecar.ts keeps a binary's stamp: `.stamps/<name>.sha256`
/// beside it, out of the `liaison-sidecar-*` glob the release signs.
pub fn stamp_path(binaries: &Path, binary_name: &str) -> PathBuf {
    binaries
        .join(".stamps")
        .join(format!("{binary_name}.sha256"))
}

/// Every file a sidecar binary is built from: the sidecar directory minus
/// tests, build output and dependencies, plus the lockfile.
pub fn sidecar_inputs(sidecar_dir: &Path, lockfile: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if !SKIPPED_DIRS.contains(&name.as_str()) {
                    walk(&path, out);
                }
            } else if kind.is_file() && !name.ends_with(".test.ts") {
                out.push(path);
            }
        }
    }
    let mut inputs = Vec::new();
    walk(sidecar_dir, &mut inputs);
    if lockfile.is_file() {
        inputs.push(lockfile.to_path_buf());
    }
    inputs.sort();
    inputs
}

fn modified(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|meta| meta.modified()).ok()
}

/// Why the installed sidecar cannot be trusted to match its sources, or None.
pub fn stale_reason(stamp: &Path, inputs: &[PathBuf]) -> Option<String> {
    let Some(stamped) = modified(stamp) else {
        return Some(format!(
            "the sidecar carries no freshness stamp ({} is missing)",
            stamp.display()
        ));
    };
    let newer: Vec<String> = inputs
        .iter()
        .filter(|input| modified(input).is_some_and(|at| at > stamped))
        .map(|input| input.display().to_string())
        .collect();
    if newer.is_empty() {
        return None;
    }
    Some(format!(
        "the sidecar is older than its sources ({} changed after it was prepared)",
        newer.join(", ")
    ))
}

/// The whole message a stale build fails with.
pub fn refusal(reason: &str) -> String {
    format!(
        "{reason}. Run `bun prepare-sidecar.ts` in apps/desktop before building the shell: \
it rebuilds the sidecar whenever its sources changed, and a shell bundled over a stale one \
ships an assistant that dies on start"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "liaison-freshness-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(dir.join("sidecar/dist")).unwrap();
        fs::write(dir.join("sidecar/index.ts"), "export {}\n").unwrap();
        fs::write(dir.join("sidecar/index.test.ts"), "test\n").unwrap();
        fs::write(
            dir.join("sidecar/dist/liaison-sidecar-bun-darwin-arm64"),
            "bin",
        )
        .unwrap();
        fs::write(dir.join("bun.lock"), "lock\n").unwrap();
        dir
    }

    fn set_age(path: &Path, secs: u64) {
        let file = fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(UNIX_EPOCH + Duration::from_secs(secs))
            .unwrap();
    }

    #[test]
    fn the_inputs_are_the_sources_and_the_lockfile_only() {
        let dir = scratch("inputs");
        let inputs = sidecar_inputs(&dir.join("sidecar"), &dir.join("bun.lock"));
        let names: Vec<String> = inputs
            .iter()
            .map(|path| path.strip_prefix(&dir).unwrap().display().to_string())
            .collect();
        assert_eq!(names, vec!["bun.lock", "sidecar/index.ts"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_build_over_a_sidecar_older_than_its_sources_is_refused() {
        let dir = scratch("stale");
        let binaries = dir.join("binaries");
        let stamp = stamp_path(&binaries, "liaison-sidecar-aarch64-apple-darwin");
        let inputs = sidecar_inputs(&dir.join("sidecar"), &dir.join("bun.lock"));

        // No stamp at all: a binary an older prepare-sidecar.ts left.
        let missing = stale_reason(&stamp, &inputs).expect("an unstamped sidecar is refused");
        assert!(missing.contains("no freshness stamp"));

        fs::create_dir_all(stamp.parent().unwrap()).unwrap();
        fs::write(&stamp, "hash\n").unwrap();
        for input in &inputs {
            set_age(input, 1_000);
        }
        set_age(&stamp, 2_000);
        assert_eq!(stale_reason(&stamp, &inputs), None);

        // The 16:48 sidecar and the 17:30 edit.
        set_age(&dir.join("sidecar/index.ts"), 3_000);
        let stale = stale_reason(&stamp, &inputs).expect("a stale sidecar is refused");
        assert!(stale.contains("index.ts"));
        assert!(refusal(&stale).contains("bun prepare-sidecar.ts"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_stamp_is_out_of_the_signing_glob() {
        let stamp = stamp_path(
            Path::new("binaries"),
            "liaison-sidecar-x86_64-pc-windows-msvc.exe",
        );
        assert_eq!(
            stamp,
            Path::new("binaries/.stamps/liaison-sidecar-x86_64-pc-windows-msvc.exe.sha256")
        );
    }
}
