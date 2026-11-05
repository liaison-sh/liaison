//! Opening a file or folder an agent's message named, the way double clicking
//! it in the file manager would.
//!
//! THE AGENT'S TEXT CHOOSES THE PATH, and that makes this a security boundary.
//! The window turns every absolute path it finds in a message into a link, and
//! the message can come from anywhere: a turn that ran on the server, a prompt
//! injected through a mail or a ticket the agent read, a path the agent was
//! simply wrong about. Handing such a path to the operating system's "open"
//! (ShellExecute, `open`, `xdg-open`) RUNS it when it is a program, and any
//! installed runtime can register itself as the program for one more
//! extension. One click on a line of prose must never start a program.
//!
//! So the rule is an ALLOWLIST, decided by [`decide`] and pinned by the tests
//! below. A click OPENS only:
//!
//! - a folder that is not a bundle (it opens in the file manager);
//! - a file whose extension is in [`DOCUMENT_EXTENSIONS`], with no unix
//!   execute bit, where BOTH the name as written (trailing dots and spaces
//!   stripped, as Windows does) AND the name of the file it resolves to (a
//!   symlink's target; on Windows the canonical long name, not an 8.3 alias)
//!   pass.
//!
//! EVERYTHING ELSE IS REVEALED, selected in Explorer, Finder or the file
//! manager, and never opened: programs, scripts, installers, shortcuts, macro
//! enabled Office files, disk images, certificates and profiles, bundles, a
//! file with no extension, an extension nobody listed. Revealing a harmless
//! file costs one more click; opening a harmful one costs the machine.
//!
//! NETWORK PATHS ARE REFUSED BEFORE ANY FILE SYSTEM CALL ([`path_from_text`]).
//! `\\host\share`, `\\?\UNC\...`, `//host/...`, `file://host/...` and device
//! paths (`\\.\`, `\\?\`) never reach `canonicalize`: on Windows merely asking
//! whether such a path exists opens an SMB or WebDAV connection to a host the
//! message chose, and hands it the user's NTLM hash. Revealing would not help,
//! the connection comes first. A drive letter the user mapped to a share is
//! the user's own choice and stays allowed.
//!
//! The path is never passed through a shell: the opener crate hands it to the
//! platform as one argument (`ShellExecuteW`, `open`, `xdg-open`), and a path
//! is absolute before it gets there, so it can never read as an option.
//!
//! What this does not defend against, on purpose: a local agent that can
//! already run commands on this machine swapping the file between the check
//! and the open. That agent needs no link to run a program; the boundary here
//! is the click, not the agent.

use std::fs;
use std::path::{Path, PathBuf};

/// What a click does with a path that exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalPathAction {
    /// Hand it to the operating system: a folder opens in the file manager, a
    /// document in its default application.
    Open,
    /// Show it selected in its folder, and run nothing.
    Reveal,
}

/// The refusals `open_local_path` answers with.
pub const LOCAL_PATH_NOT_FOUND: &str = "NotFound";
pub const LOCAL_PATH_REFUSED: &str = "PathRefused";
pub const LOCAL_PATH_NETWORK: &str = "NetworkPath";

/// THE ONLY FILE TYPES A CLICK OPENS, compared case insensitively. Documents
/// whose default application shows them rather than runs them.
///
/// - `html`/`htm` open in the default browser, as a local file under its
///   `file://` sandbox: that is where a deck or a report the agent built is
///   meant to be read. The gap left open, knowingly: a page that loads a
///   subresource from a network host (`<img src="file://host/x">`) can make
///   Windows attempt an SMB connection to that host. It needs an HTML file an
///   attacker already wrote to this disk, which is a foothold this click does
///   not give.
/// - `svg` is NOT here: its default application is usually a browser, where
///   it is a document that may carry script, with no page around it to say so.
/// - Only the macro free Office formats are here. `docm`, `xlsm`, `pptm` and
///   the legacy `doc`, `xls`, `ppt` (which carry macros the same way) are not,
///   nor `rtf` (a history of exploits that need no prompt), nor `xml` (on
///   Windows the Office XML handler can hand it to Word).
/// - `zip` is the only archive: opening one lists it, it runs nothing.
pub const DOCUMENT_EXTENSIONS: &[&str] = &[
    "pdf", // Office documents without macros.
    "docx", "xlsx", "pptx", "odt", "ods", "odp", // Images.
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", // Audio and video.
    "mp3", "m4a", "wav", "flac", "ogg", "mp4", "mov", "m4v", "avi", "mkv", "webm",
    // Text and data.
    "txt", "md", "csv", "tsv", "json", "log", "yaml", "yml", // Archives.
    "zip", // Pages, which open in the browser.
    "html", "htm",
];

/// Directory extensions macOS treats as ONE thing to launch or install rather
/// than a folder to browse, beyond the `Contents/Info.plist` check.
const BUNDLE_EXTENSIONS: &[&str] = &[
    "app",
    "pkg",
    "mpkg",
    "workflow",
    "action",
    "prefpane",
    "kext",
    "bundle",
    "framework",
    "plugin",
    "appex",
    "xpc",
    "scptd",
    "osax",
    "saver",
    "qlgenerator",
    "mdimporter",
];

/// The extension of a file name, lower case, with the trailing dots and spaces
/// Windows ignores stripped first: `setup.exe.` and `setup.exe ` both open as
/// `setup.exe` there.
fn extension_of(name: &str) -> Option<String> {
    let trimmed = name.trim_end_matches(['.', ' ']);
    let (stem, extension) = trimmed.rsplit_once('.')?;
    if extension.is_empty() || stem.is_empty() {
        return None;
    }
    Some(extension.to_ascii_lowercase())
}

/// Whether a NAME is a document a click may open: its extension is allowlisted.
pub fn is_document_name(name: &str) -> bool {
    extension_of(name).is_some_and(|extension| DOCUMENT_EXTENSIONS.contains(&extension.as_str()))
}

fn is_bundle_name(name: &str) -> bool {
    extension_of(name).is_some_and(|extension| BUNDLE_EXTENSIONS.contains(&extension.as_str()))
}

/// What a click does, from the facts about the resolved path.
///
/// - `is_dir`: the path is a directory;
/// - `names`: the name as the message wrote it AND the name it resolves to
///   (they differ through a symlink, or an 8.3 alias on Windows); a file opens
///   only when EVERY one of them is an allowlisted document;
/// - `executable_bit`: a unix file with any execute permission bit;
/// - `is_bundle`: a directory with `Contents/Info.plist`, which opening would
///   LAUNCH rather than browse.
///
/// Pure, so the security rule is testable without a file system.
pub fn decide(
    is_dir: bool,
    names: &[&str],
    executable_bit: bool,
    is_bundle: bool,
) -> LocalPathAction {
    if is_dir {
        return if is_bundle || names.iter().any(|name| is_bundle_name(name)) {
            LocalPathAction::Reveal
        } else {
            LocalPathAction::Open
        };
    }
    if executable_bit || names.is_empty() || !names.iter().all(|name| is_document_name(name)) {
        return LocalPathAction::Reveal;
    }
    LocalPathAction::Open
}

/// Whether the text names an NTFS alternate data stream (`report.pdf:payload`)
/// rather than a file: a colon anywhere after the drive. Only meaningful on
/// Windows, where it is refused; a colon is an ordinary character in a unix
/// file name.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn names_a_stream(text: &str) -> bool {
    let rest = match text.as_bytes() {
        [letter, b':', ..] if letter.is_ascii_alphabetic() => &text[2..],
        _ => text,
    };
    rest.contains(':')
}

/// Whether a path, as text, reaches past this machine's own disks: anything
/// that starts with two separators (`\\host\share`, `//host/share`, the
/// `\\?\` and `\\.\` device and verbatim forms, `\\?\UNC\...`). Checked on the
/// text and again on the path it becomes, never on the file system.
pub fn is_network_or_device_path(text: &str) -> bool {
    let bytes = text.trim_start().as_bytes();
    bytes.len() >= 2 && matches!(bytes[0], b'\\' | b'/') && matches!(bytes[1], b'\\' | b'/')
}

/// The path a message's text names, as an absolute path on this machine.
///
/// PURE: no file system call happens here, so a network path is refused
/// (`NetworkPath`) before anything could reach out for it.
///
/// Accepts a `file://` URL with no host or `localhost` (percent decoding and a
/// Windows drive included), a `~` path against `home`, and an absolute path.
/// Anything else is refused: a relative path would be resolved against
/// whatever this process's working directory happens to be, and the page
/// resolves the ones it can against the session's own folder before it asks.
pub fn path_from_text(text: &str, home: Option<&Path>) -> Result<PathBuf, &'static str> {
    let text = text.trim();
    if text.is_empty() || text.contains('\0') {
        return Err(LOCAL_PATH_REFUSED);
    }
    if is_network_or_device_path(text) {
        return Err(LOCAL_PATH_NETWORK);
    }
    let path = if text.len() >= 7 && text[..7].eq_ignore_ascii_case("file://") {
        let url = url::Url::parse(text).map_err(|_| LOCAL_PATH_REFUSED)?;
        match url.host_str() {
            None | Some("") => {}
            Some(host) if host.eq_ignore_ascii_case("localhost") => {}
            Some(_) => return Err(LOCAL_PATH_NETWORK),
        }
        // `file:////host/share/...`: an empty host and a UNC path behind it,
        // which the URL parser folds away but Windows would still dial.
        if is_network_or_device_path(&text[7..]) || is_network_or_device_path(url.path()) {
            return Err(LOCAL_PATH_NETWORK);
        }
        url.to_file_path().map_err(|_| LOCAL_PATH_REFUSED)?
    } else if text == "~" {
        home.ok_or(LOCAL_PATH_REFUSED)?.to_path_buf()
    } else if let Some(rest) = text.strip_prefix("~/").or_else(|| text.strip_prefix("~\\")) {
        home.ok_or(LOCAL_PATH_REFUSED)?.join(rest)
    } else {
        PathBuf::from(text)
    };
    // Again on the result: `file:////host/share`, a home folder on a share.
    if is_network_or_device_path(&path.to_string_lossy()) {
        return Err(LOCAL_PATH_NETWORK);
    }
    if !path.is_absolute() {
        return Err(LOCAL_PATH_REFUSED);
    }
    Ok(path)
}

/// A Windows verbatim path (`\\?\C:\x`, `\\?\UNC\server\share\x`) in the form
/// every application understands. `canonicalize` answers verbatim paths on
/// Windows, and some default applications refuse them as an argument.
pub fn plain_windows_path(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        let bytes = rest.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            return rest.to_string();
        }
    }
    path.to_string()
}

fn home_dir() -> Option<PathBuf> {
    let variable = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(variable)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

#[cfg(unix)]
fn has_executable_bit(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn has_executable_bit(_metadata: &fs::Metadata) -> bool {
    false
}

/// Everything [`decide`] needs, read from the file system. Not found is the
/// answer for a path that does not exist on this machine.
fn inspect(requested: &Path) -> Result<(PathBuf, LocalPathAction), &'static str> {
    #[cfg(windows)]
    if names_a_stream(&requested.to_string_lossy()) {
        return Err(LOCAL_PATH_REFUSED);
    }
    // A LOCAL symlink (or junction) that points at a share is still followed
    // here, and on Windows resolving it reaches out to that host. Accepted:
    // planting such a link on this disk already takes a local foothold, and
    // the network refusal above is about paths a MESSAGE can name.
    let resolved = fs::canonicalize(requested).map_err(|_| LOCAL_PATH_NOT_FOUND)?;
    let metadata = fs::metadata(&resolved).map_err(|_| LOCAL_PATH_NOT_FOUND)?;
    let written = requested
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let target = resolved
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let is_dir = metadata.is_dir();
    let is_bundle = is_dir && resolved.join("Contents").join("Info.plist").is_file();
    let action = decide(
        is_dir,
        &[written.as_str(), target.as_str()],
        !is_dir && has_executable_bit(&metadata),
        is_bundle,
    );
    let resolved = PathBuf::from(plain_windows_path(&resolved.to_string_lossy()));
    Ok((resolved, action))
}

/// Opens, or reveals, one path an agent's message named. Answers `opened` or
/// `revealed`; refuses with `NotFound` for a path that is not on this
/// computer, `NetworkPath` for a network or device path (refused before any
/// file system call), `PathRefused` for one that is not an absolute local
/// path, and the platform's own error when it could not be shown.
#[tauri::command]
pub fn open_local_path(path: String) -> Result<String, String> {
    let requested = path_from_text(&path, home_dir().as_deref()).map_err(str::to_string)?;
    let (resolved, action) = inspect(&requested).map_err(str::to_string)?;
    match action {
        LocalPathAction::Open => tauri_plugin_opener::open_path(&resolved, None::<&str>)
            .map(|_| "opened".to_string())
            .map_err(|error| format!("could not open the path: {error}")),
        LocalPathAction::Reveal => tauri_plugin_opener::reveal_item_in_dir(&resolved)
            .map(|_| "revealed".to_string())
            .map_err(|error| format!("could not reveal the path: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Everything a reviewer found opening under the old deny list, and the
    /// classics. None of them is a document, so none of them opens.
    const DANGEROUS: &[&str] = &[
        "tool.pyz",
        "tool.pyzw",
        "macro.ahk",
        "macro.au3",
        "script.rbw",
        "sandbox.wsb",
        "update.msu",
        "addin.vsto",
        "desk.rdp",
        "app.jnlp",
        "app.xbap",
        "setup.exe",
        "script.ps1",
        "Shortcut.lnk",
        "link.url",
        "Page.hta",
        "installer.msi",
        "archive.jar",
        "screen.scr",
        "import.reg",
        "report.docm",
        "budget.xlsm",
        "deck.pptm",
        "disk.iso",
        "disk.img",
        "disk.vhd",
        "disk.vhdx",
        "disk.dmg",
        "look.theme",
        "query.search-ms",
        "cert.cer",
        "id.pfx",
        "old.doc",
        "old.xls",
        "old.ppt",
        "letter.rtf",
        "data.xml",
        "profile.mobileconfig",
        "run.bat",
        "run.cmd",
        "tool.com",
        "a.vbs",
        "a.js",
        "build.sh",
        "start.command",
        "Launcher.desktop",
        "tool.AppImage",
        "script.py",
        "Package.pkg",
        "place.webloc",
        "drawing.svg",
        "archive.tar.gz",
        "archive.7z",
        "README",
        "Makefile",
        ".bashrc",
        "noextension.",
    ];

    #[test]
    fn only_an_allowlisted_document_opens_every_other_file_is_revealed() {
        for name in DANGEROUS {
            assert_eq!(
                decide(false, &[name], false, false),
                LocalPathAction::Reveal,
                "{name}"
            );
        }
    }

    #[test]
    fn every_allowlisted_document_opens_in_any_case() {
        for extension in DOCUMENT_EXTENSIONS {
            for name in [
                format!("report.{extension}"),
                format!("REPORT.{}", extension.to_ascii_uppercase()),
                format!("Hub X report 2026-08.{extension}"),
            ] {
                assert_eq!(
                    decide(false, &[name.as_str(), name.as_str()], false, false),
                    LocalPathAction::Open,
                    "{name}"
                );
            }
        }
        assert!(!DOCUMENT_EXTENSIONS.contains(&"svg"));
    }

    #[test]
    fn the_trailing_dots_and_spaces_windows_ignores_do_not_hide_a_program() {
        for name in [
            "setup.exe.",
            "setup.exe ",
            "setup.exe . .",
            "report.pdf.exe.",
        ] {
            assert_eq!(
                decide(false, &[name], false, false),
                LocalPathAction::Reveal,
                "{name}"
            );
        }
        // The same stripping lets a real document through.
        assert_eq!(
            decide(false, &["report.pdf."], false, false),
            LocalPathAction::Open
        );
    }

    #[test]
    fn both_the_written_name_and_the_resolved_name_must_be_documents() {
        // `report.pdf` -> `payload.sh` through a symlink, or an 8.3 alias
        // whose long name is not a document.
        assert_eq!(
            decide(false, &["report.pdf", "payload.sh"], false, false),
            LocalPathAction::Reveal
        );
        assert_eq!(
            decide(false, &["REPORT~1.PDF", "report.pdf.lnk"], false, false),
            LocalPathAction::Reveal
        );
        assert_eq!(
            decide(false, &["payload.sh", "report.pdf"], false, false),
            LocalPathAction::Reveal
        );
        assert_eq!(decide(false, &[], false, false), LocalPathAction::Reveal);
    }

    #[test]
    fn a_folder_opens_in_the_file_manager_but_a_bundle_is_revealed() {
        assert_eq!(
            decide(true, &["Reports"], false, false),
            LocalPathAction::Open
        );
        assert_eq!(
            decide(true, &["Hub X"], false, false),
            LocalPathAction::Open
        );
        // A bundle opened is a program launched.
        assert_eq!(
            decide(true, &["Calculator.app"], false, true),
            LocalPathAction::Reveal
        );
        assert_eq!(
            decide(true, &["Something"], false, true),
            LocalPathAction::Reveal
        );
        assert_eq!(
            decide(true, &["Tool.app"], false, false),
            LocalPathAction::Reveal
        );
    }

    #[test]
    fn a_file_with_its_executable_bit_is_revealed_whatever_its_name() {
        assert_eq!(
            decide(false, &["report.pdf"], true, false),
            LocalPathAction::Reveal
        );
        assert_eq!(
            decide(false, &["runme"], true, false),
            LocalPathAction::Reveal
        );
    }

    #[test]
    fn text_becomes_an_absolute_path_or_is_refused() {
        let home = Path::new(if cfg!(windows) {
            r"C:\Users\someone"
        } else {
            "/home/someone"
        });
        assert_eq!(
            path_from_text("~/Reports/a.pdf", Some(home)).unwrap(),
            home.join("Reports/a.pdf")
        );
        assert_eq!(path_from_text("~", Some(home)).unwrap(), home.to_path_buf());
        assert_eq!(path_from_text("~/a", None), Err(LOCAL_PATH_REFUSED));
        assert_eq!(
            path_from_text("relative/a.pdf", Some(home)),
            Err(LOCAL_PATH_REFUSED)
        );
        assert_eq!(path_from_text("", Some(home)), Err(LOCAL_PATH_REFUSED));
        assert_eq!(path_from_text("/a\0b", Some(home)), Err(LOCAL_PATH_REFUSED));
        assert_eq!(
            path_from_text("https://example.com/a.pdf", Some(home)),
            Err(LOCAL_PATH_REFUSED)
        );
        if cfg!(windows) {
            assert_eq!(
                path_from_text("file:///C:/Users/someone/Hub%20X/a.pdf", None).unwrap(),
                PathBuf::from(r"C:\Users\someone\Hub X\a.pdf")
            );
            assert!(path_from_text(r"C:\Users\someone\a.pdf", None).is_ok());
        } else {
            assert_eq!(
                path_from_text("file:///home/someone/Hub%20X/a.pdf", None).unwrap(),
                PathBuf::from("/home/someone/Hub X/a.pdf")
            );
            assert_eq!(
                path_from_text("FILE:///tmp/a.pdf", None).unwrap(),
                PathBuf::from("/tmp/a.pdf")
            );
            assert_eq!(
                path_from_text("/tmp/a b.pdf", None).unwrap(),
                PathBuf::from("/tmp/a b.pdf")
            );
        }
    }

    #[test]
    fn an_alternate_data_stream_is_recognised() {
        assert!(names_a_stream(r"C:\x\report.pdf:payload.exe"));
        assert!(!names_a_stream(r"C:\x\report.pdf"));
        assert!(!names_a_stream(r"\\server\share\report.pdf"));
    }

    #[test]
    fn a_network_or_device_path_is_refused_before_any_file_system_call() {
        // `path_from_text` is pure: these are refused as text, on every OS.
        for text in [
            r"\\attacker.example\share\report.pdf",
            r"\\attacker.example@SSL\DavWWWRoot\report.pdf",
            r"\\?\UNC\attacker.example\share\report.pdf",
            r"\\?\C:\Users\someone\report.pdf",
            r"\\.\PhysicalDrive0",
            "//attacker.example/share/report.pdf",
            r"\/attacker.example/share/report.pdf",
            "file://attacker.example/share/report.pdf",
            "FILE://attacker.example/share/report.pdf",
            "file:////attacker.example/share/report.pdf",
        ] {
            assert_eq!(
                path_from_text(text, None),
                Err(LOCAL_PATH_NETWORK),
                "{text}"
            );
        }
        // A home folder on a share is refused the same way.
        assert_eq!(
            path_from_text("~/a.pdf", Some(Path::new(r"\\server\home\someone"))),
            Err(LOCAL_PATH_NETWORK)
        );
        // The command answers the refusal, not NotFound: it never looked.
        assert_eq!(
            open_local_path("//attacker.example/share/report.pdf".into()).unwrap_err(),
            LOCAL_PATH_NETWORK
        );
        // Local forms are still accepted.
        let local = if cfg!(windows) {
            "file://localhost/C:/Users/someone/a.pdf"
        } else {
            "file://localhost/home/someone/a.pdf"
        };
        assert!(path_from_text(local, None).is_ok());
        if cfg!(windows) {
            assert!(path_from_text(r"Z:\mapped\report.pdf", None).is_ok());
        }
    }

    #[test]
    fn a_verbatim_windows_path_is_given_back_in_its_plain_form() {
        assert_eq!(
            plain_windows_path(r"\\?\C:\Users\a\b.pdf"),
            r"C:\Users\a\b.pdf"
        );
        assert_eq!(
            plain_windows_path(r"\\?\UNC\server\share\b.pdf"),
            r"\\server\share\b.pdf"
        );
        assert_eq!(plain_windows_path("/home/a/b.pdf"), "/home/a/b.pdf");
    }

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("liaison-local-path-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_missing_path_is_not_found() {
        let dir = scratch("missing");
        assert_eq!(
            inspect(&dir.join("nope.pdf")).unwrap_err(),
            LOCAL_PATH_NOT_FOUND
        );
        assert_eq!(
            open_local_path(dir.join("nope.pdf").to_string_lossy().into_owned()).unwrap_err(),
            "NotFound"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_file_system_facts_reach_the_decision() {
        let dir = scratch("facts");
        let document = dir.join("report.pdf");
        fs::write(&document, b"%PDF").unwrap();
        assert_eq!(inspect(&document).unwrap().1, LocalPathAction::Open);
        assert_eq!(inspect(&dir).unwrap().1, LocalPathAction::Open);
        let program = dir.join("setup.exe");
        fs::write(&program, b"MZ").unwrap();
        assert_eq!(inspect(&program).unwrap().1, LocalPathAction::Reveal);
        let bundle = dir.join("Thing");
        fs::create_dir_all(bundle.join("Contents")).unwrap();
        fs::write(bundle.join("Contents").join("Info.plist"), b"<plist/>").unwrap();
        assert_eq!(inspect(&bundle).unwrap().1, LocalPathAction::Reveal);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let script = dir.join("notes");
            fs::write(&script, b"#!/bin/sh\n").unwrap();
            fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(inspect(&script).unwrap().1, LocalPathAction::Reveal);
            // A harmless name linked to a program is the program.
            let link = dir.join("innocent.pdf");
            std::os::unix::fs::symlink(&program, &link).unwrap();
            assert_eq!(inspect(&link).unwrap().1, LocalPathAction::Reveal);
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
