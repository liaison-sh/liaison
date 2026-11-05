use std::path::PathBuf;

/// The overlay bundle the shell injects into the webview. Built by
/// `bun run build:overlay` in apps/desktop, never committed (it is generated),
/// and included into the binary at compile time by `main.rs`.
const OVERLAY_BUNDLE: &str = "../dist/overlay.js";

#[path = "sidecar_freshness.rs"]
mod sidecar_freshness;

fn main() {
    ensure_overlay_bundle();
    ensure_fresh_sidecar();
    tauri_build::build()
}

/// Refuses to build the shell over a sidecar older than its sources
/// (`sidecar_freshness.rs`). Cargo runs every build script before compiling,
/// so this holds for `tauri build`, `cargo build`, `cargo check` and
/// `cargo test` alike: none of them can bundle or run a stale sidecar.
fn ensure_fresh_sidecar() {
    let triple = std::env::var("TARGET").unwrap_or_default();
    let suffix = if triple.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let stamp = sidecar_freshness::stamp_path(
        &PathBuf::from("binaries"),
        &format!("liaison-sidecar-{triple}{suffix}"),
    );
    let sidecar_dir = PathBuf::from("../sidecar");
    let lockfile = PathBuf::from("../../../bun.lock");
    println!("cargo:rerun-if-changed={}", stamp.display());
    println!("cargo:rerun-if-changed={}", sidecar_dir.display());
    println!("cargo:rerun-if-changed={}", lockfile.display());
    let inputs = sidecar_freshness::sidecar_inputs(&sidecar_dir, &lockfile);
    if let Some(reason) = sidecar_freshness::stale_reason(&stamp, &inputs) {
        eprintln!("error: {}", sidecar_freshness::refusal(&reason));
        std::process::exit(1);
    }
}

/// `include_str!` of a missing file is a compiler error that names a path and
/// nothing else, which is a bad way to learn that a build step was skipped.
/// A placeholder is written instead, carrying the instruction in the file and
/// in a build warning, and saying so loudly in the running app rather than
/// shipping a silently empty overlay. Same ordering as prepare-sidecar.ts: the
/// JavaScript build runs before any Rust build of the shell.
fn ensure_overlay_bundle() {
    let path = PathBuf::from(OVERLAY_BUNDLE);
    println!("cargo:rerun-if-changed={OVERLAY_BUNDLE}");
    if path.exists() {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let message = "the Liaison desktop overlay bundle was not built: \
run `bun run build:overlay` in apps/desktop before building the shell";
    println!("cargo:warning={message}");
    let _ = std::fs::write(
        &path,
        format!("console.error({});\n", serde_json_escape(message)),
    );
}

/// A JSON string literal, without pulling a crate in for one escape.
fn serde_json_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            _ => out.push(character),
        }
    }
    out.push('"');
    out
}
