//! Opening a file the window fetched (a shipping label, an invoice PDF) in the
//! system's default application.
//!
//! In a browser an app hands such bytes to a new tab as a `blob:` URL. In this
//! webview `window.open` does nothing and `open_external_url` refuses `blob:`,
//! so the button did nothing at all. The window sends the BYTES and a name
//! here instead; the shell writes them to a fresh folder under the system
//! temporary directory and opens that file, the way double clicking it would.
//!
//! THE WINDOW CHOOSES THE NAME AND THE BYTES, never a path. So:
//!
//! - the name is reduced to one plain file name ([`sanitize_file_name`]): no
//!   separators, no drive, no `..`, no control characters, no Windows reserved
//!   device name, bounded length;
//! - only the extensions in [`OPENABLE_EXTENSIONS`] are written and opened:
//!   documents whose default application shows them rather than runs them.
//!   No page (`html`, `svg`, `xml`), no script, no program: a name ending in
//!   anything else is refused before a byte is written;
//! - every file gets its own new folder, so two documents with the same name
//!   never overwrite each other (nor one a viewer still holds open).
//!
//! The path is never passed through a shell: the opener crate hands it to the
//! platform as one argument (`ShellExecuteW`, `open`, `xdg-open`).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// The request header carrying the file name, percent encoded by the window.
pub const FILE_NAME_HEADER: &str = "x-liaison-file-name";

/// Refusals `open_downloaded_file` answers with.
pub const DOWNLOAD_REFUSED: &str = "DownloadRefused";

/// The largest file the window may hand over (a merged batch of labels is a
/// few megabytes).
pub const MAX_DOWNLOAD_BYTES: usize = 64 * 1024 * 1024;

/// The longest file name written, in characters, extension included.
const MAX_NAME_CHARS: usize = 120;

/// THE ONLY FILE TYPES WRITTEN AND OPENED, compared case insensitively.
pub const OPENABLE_EXTENSIONS: &[&str] = &[
    "pdf", "png", "jpg", "jpeg", "gif", "webp", "csv", "txt", "docx", "xlsx", "odt", "ods", "zip",
];

/// Names Windows keeps for devices, whatever the extension after them.
const WINDOWS_RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// One plain file name from what the window sent, or `None` when nothing
/// usable is left or its extension is not an openable document.
///
/// Characters outside letters, digits, space, `.`, `-`, `_`, `(` and `)`
/// become `_`, path separators and drive colons included (an invoice number
/// `F/2026/7` stays readable as `F_2026_7`, and no name ever names a folder);
/// leading dots and spaces and the trailing ones Windows ignores are dropped;
/// a reserved device stem gets a `_` prefix; the stem is shortened so the name
/// stays within [`MAX_NAME_CHARS`].
pub fn sanitize_file_name(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, ' ' | '.' | '-' | '_' | '(' | ')') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned
        .trim_start_matches(['.', ' '])
        .trim_end_matches(['.', ' ']);
    let (stem, extension) = trimmed.rsplit_once('.')?;
    let extension = extension.to_ascii_lowercase();
    if !OPENABLE_EXTENSIONS.contains(&extension.as_str()) {
        return None;
    }
    let stem = stem.trim_end_matches(['.', ' ']);
    if stem.is_empty() {
        return None;
    }
    let budget = MAX_NAME_CHARS.saturating_sub(extension.chars().count() + 1);
    let mut stem: String = stem.chars().take(budget).collect();
    let device = stem
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_lowercase();
    if WINDOWS_RESERVED.contains(&device.as_str()) {
        stem.insert(0, '_');
    }
    Some(format!("{stem}.{extension}"))
}

/// The name as the window percent encoded it, decoded.
pub fn decode_header_name(encoded: &str) -> Option<String> {
    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = encoded.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A folder of its own under `root`, created now.
fn fresh_folder(root: &Path) -> std::io::Result<PathBuf> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let folder = root.join(format!("{nanos:x}-{}-{n}", std::process::id()));
    fs::create_dir_all(&folder)?;
    Ok(folder)
}

/// Writes `bytes` as `raw_name` (sanitized) in a new folder under `root` and
/// answers the file's path. Refused for an empty or oversized body, or a name
/// that is not an openable document.
pub fn write_download(root: &Path, raw_name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    if bytes.is_empty() || bytes.len() > MAX_DOWNLOAD_BYTES {
        return Err(DOWNLOAD_REFUSED.to_string());
    }
    let name = sanitize_file_name(raw_name).ok_or_else(|| DOWNLOAD_REFUSED.to_string())?;
    let folder = fresh_folder(root).map_err(|error| format!("could not save the file: {error}"))?;
    let path = folder.join(name);
    fs::write(&path, bytes).map_err(|error| format!("could not save the file: {error}"))?;
    // The bytes came from the server, often from an outside sender. Without
    // the operating system's downloaded-file mark the app that opens them
    // treats them as made on this computer and skips its own first open
    // checks (Gatekeeper for what an archive unpacks, Protected View for an
    // Office document). No mark, no open: a file that cannot carry it is
    // removed rather than opened unmarked.
    if let Err(error) = mark_as_downloaded(&path) {
        let _ = fs::remove_file(&path);
        return Err(format!("could not mark the file as downloaded: {error}"));
    }
    Ok(path)
}

/// The agent name the quarantine record carries, shown by macOS in its
/// "downloaded from" prompt.
const QUARANTINE_AGENT: &str = "Liaison";

/// The `com.apple.quarantine` value a browser download carries:
/// `<flags>;<seconds since 1970, hex>;<agent>;`. Flags 0081: quarantined, and
/// downloaded by an application (not created by the user).
pub fn quarantine_value(seconds: u64) -> String {
    format!("0081;{seconds:08x};{QUARANTINE_AGENT};")
}

/// The `Zone.Identifier` stream a browser download carries: zone 3, the
/// internet zone (SmartScreen and Office Protected View key on it).
#[cfg_attr(not(windows), allow(dead_code))]
pub const ZONE_IDENTIFIER: &str = "[ZoneTransfer]\r\nZoneId=3\r\n";

#[cfg(target_os = "macos")]
fn mark_as_downloaded(path: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let value = quarantine_value(seconds);
    let file = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::other("a path with a NUL byte"))?;
    let name = CString::new("com.apple.quarantine").expect("static name");
    // SAFETY: both strings are NUL terminated and outlive the call; the value
    // pointer and length describe one live buffer.
    let status = unsafe {
        libc::setxattr(
            file.as_ptr(),
            name.as_ptr(),
            value.as_ptr().cast(),
            value.len(),
            0,
            libc::XATTR_NOFOLLOW,
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn mark_as_downloaded(path: &Path) -> std::io::Result<()> {
    let mut stream = path.as_os_str().to_owned();
    stream.push(":Zone.Identifier");
    fs::write(PathBuf::from(stream), ZONE_IDENTIFIER)
}

/// Linux desktops have no system-wide mark their openers honour.
#[cfg(not(any(target_os = "macos", windows)))]
fn mark_as_downloaded(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Where downloaded files go: a folder of the system temporary directory.
fn downloads_root() -> PathBuf {
    std::env::temp_dir().join("Liaison downloads")
}

/// Saves the bytes the window sent (the raw request body) under the name in
/// the [`FILE_NAME_HEADER`] header and opens the file in its default
/// application. Answers `opened`; refuses with `DownloadRefused` for a body
/// that is not raw bytes, is empty or too large, or a name that is not an
/// openable document.
#[tauri::command]
pub fn open_downloaded_file(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(DOWNLOAD_REFUSED.to_string());
    };
    let name = request
        .headers()
        .get(FILE_NAME_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(decode_header_name)
        .ok_or_else(|| DOWNLOAD_REFUSED.to_string())?;
    let path = write_download(&downloads_root(), &name, bytes)?;
    tauri_plugin_opener::open_path(&path, None::<&str>)
        .map(|_| "opened".to_string())
        .map_err(|error| format!("could not open the file: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_pdf_name_is_kept() {
        assert_eq!(
            sanitize_file_name("label-1234.pdf").as_deref(),
            Some("label-1234.pdf")
        );
        assert_eq!(
            sanitize_file_name("Invoice F 2026 (copy).PDF").as_deref(),
            Some("Invoice F 2026 (copy).pdf")
        );
    }

    #[test]
    fn a_path_is_flattened_into_one_name_and_never_climbs() {
        assert_eq!(
            sanitize_file_name("../../etc/passwd.pdf").as_deref(),
            Some("_.._etc_passwd.pdf")
        );
        assert_eq!(
            sanitize_file_name("C:\\Windows\\x.pdf").as_deref(),
            Some("C__Windows_x.pdf")
        );
        assert_eq!(
            sanitize_file_name("F/2026/007.pdf").as_deref(),
            Some("F_2026_007.pdf")
        );
        for raw in ["../../a.pdf", "..\\..\\a.pdf", "/etc/a.pdf", "C:\\a.pdf"] {
            let name = sanitize_file_name(raw).unwrap();
            assert!(
                !name.contains(['/', '\\', ':']) && !name.starts_with('.'),
                "{raw} -> {name}"
            );
        }
    }

    #[test]
    fn separators_drives_and_control_characters_never_reach_the_name() {
        let name = sanitize_file_name("a:b*c?d\"e<f>g|h\u{0}i\nj.pdf").unwrap();
        assert_eq!(name, "a_b_c_d_e_f_g_h_i_j.pdf");
        assert!(!name.contains(['/', '\\', ':']));
    }

    #[test]
    fn a_name_that_is_not_an_openable_document_is_refused() {
        for name in [
            "setup.exe",
            "run.bat",
            "script.ps1",
            "page.html",
            "page.htm",
            "image.svg",
            "data.xml",
            "macro.docm",
            "label.pdf.exe",
            "label.pdf.",
            "noextension",
            ".pdf",
            "",
            "...",
        ] {
            let sanitized = sanitize_file_name(name);
            match name {
                // Windows drops the trailing dot: this is `label.pdf`, a PDF.
                "label.pdf." => assert_eq!(sanitized.as_deref(), Some("label.pdf")),
                _ => assert_eq!(sanitized, None, "{name}"),
            }
        }
    }

    #[test]
    fn a_reserved_windows_device_name_is_prefixed() {
        assert_eq!(sanitize_file_name("CON.pdf").as_deref(), Some("_CON.pdf"));
        assert_eq!(sanitize_file_name("nul.txt").as_deref(), Some("_nul.txt"));
        assert_eq!(
            sanitize_file_name("com1.backup.pdf").as_deref(),
            Some("_com1.backup.pdf")
        );
        assert_eq!(
            sanitize_file_name("console.pdf").as_deref(),
            Some("console.pdf")
        );
    }

    #[test]
    fn a_long_name_is_shortened_and_keeps_its_extension() {
        let long = format!("{}.pdf", "x".repeat(500));
        let name = sanitize_file_name(&long).unwrap();
        assert_eq!(name.chars().count(), MAX_NAME_CHARS);
        assert!(name.ends_with(".pdf"));
    }

    #[test]
    fn the_header_name_is_percent_decoded() {
        assert_eq!(
            decode_header_name("Facture%20F-12%C3%A9.pdf").as_deref(),
            Some("Facture F-12\u{e9}.pdf")
        );
        assert_eq!(decode_header_name("bad%2"), None);
        assert_eq!(decode_header_name("bad%zz.pdf"), None);
    }

    #[test]
    fn the_bytes_land_in_a_new_folder_under_the_root_and_nowhere_else() {
        let root =
            std::env::temp_dir().join(format!("liaison-download-test-{}", std::process::id()));
        let first = write_download(&root, "../label.pdf", b"%PDF-1.7").unwrap();
        let third = write_download(&root, "label.pdf", b"%PDF-1.5").unwrap();
        let second = write_download(&root, "label.pdf", b"%PDF-1.4").unwrap();
        assert!(first.starts_with(&root) && second.starts_with(&root));
        assert_ne!(first, second);
        assert_eq!(first.file_name().unwrap(), "_label.pdf");
        assert_eq!(first.parent().unwrap().parent().unwrap(), root);
        assert_ne!(second, third);
        assert_eq!(fs::read(&first).unwrap(), b"%PDF-1.7");
        assert_eq!(fs::read(&second).unwrap(), b"%PDF-1.4");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_empty_or_refused_download_writes_nothing() {
        let root =
            std::env::temp_dir().join(format!("liaison-download-refused-{}", std::process::id()));
        assert_eq!(
            write_download(&root, "label.pdf", b"").unwrap_err(),
            DOWNLOAD_REFUSED
        );
        assert_eq!(
            write_download(&root, "tool.exe", b"MZ").unwrap_err(),
            DOWNLOAD_REFUSED
        );
        assert!(!root.exists());
    }
}

/// A file the window hands over came from the server, often from an outside
/// sender (a mail attachment). Saved without the operating system's
/// downloaded-from-elsewhere mark, the apps that open it skip their own
/// guards (Gatekeeper for what an archive unpacks, Protected View on Windows).
#[cfg(test)]
mod page_script_boundary_tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn a_saved_download_carries_the_quarantine_mark() {
        let root = std::env::temp_dir().join(format!("liaison-dl-probe-{}", std::process::id()));
        let path = write_download(&root, "attachment.zip", b"PK\x03\x04").expect("saved");
        let output = std::process::Command::new("xattr")
            .arg("-p")
            .arg("com.apple.quarantine")
            .arg(&path)
            .output()
            .expect("xattr runs");
        let _ = std::fs::remove_dir_all(&root);
        assert!(
            output.status.success(),
            "the saved download has no com.apple.quarantine attribute"
        );
    }

    /// The mark says what a browser's says: quarantined, downloaded by an
    /// application, when, and by which agent.
    #[test]
    fn the_quarantine_record_has_the_browser_download_shape() {
        assert_eq!(quarantine_value(0x6543_21ab), "0081;654321ab;Liaison;");
        assert!(ZONE_IDENTIFIER.contains("ZoneId=3"));
    }

    /// Control: the bytes saved are the bytes sent, mark or no mark.
    #[test]
    fn a_marked_download_keeps_its_bytes() {
        let root = std::env::temp_dir().join(format!("liaison-dl-bytes-{}", std::process::id()));
        let path = write_download(&root, "label.pdf", b"%PDF-1.7").expect("saved");
        let bytes = std::fs::read(&path).expect("read back");
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(bytes, b"%PDF-1.7");
    }
}
