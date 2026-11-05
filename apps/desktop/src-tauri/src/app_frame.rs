// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE DOCUMENT AN INSTALLED APP'S UI RUNS IN (D11).
//
// The window's page holds the shell's bridge (`generate_handler!` commands are
// reachable from any script in it), so an installed app's UI bundle that did
// not ship with the client build never runs in the page: apps/web renders it
// in a sandboxed iframe (`framework/isolated-app.tsx`, `sandbox="allow-scripts
// allow-forms"`, an opaque origin). This is that frame's document, served by
// the shell itself on its own scheme, so the frame is neither the page's
// origin nor a remote one, and the window's policy still frames nothing from
// the network:
//
// - one script: the frame runtime the web build emits beside its pages
//   (`app-frame-runtime.js`, read from the embedded assets), inlined under a
//   fresh nonce;
// - its own policy: no script but that one and the blobs it makes from the
//   bundle the page hands it, no image but data: and blob: (an image URL to a
//   remote host would carry data out), no network (`connect-src 'none'`: every call
//   goes through the page, which answers it for that app only), no forms, no
//   frames, framed only by the window.
//
// The shell's own scripts (`__TAURI_INTERNALS__`, the invoke key, the overlay)
// are main frame only (`initialization_script`), so nothing in this frame can
// address a command.

use std::borrow::Cow;

use tauri::http::{Request, Response, StatusCode};
use tauri::{Runtime, UriSchemeContext};

/// The scheme the frame is served on.
pub const APP_FRAME_SCHEME: &str = "liaison-frame";

/// The runtime file the web build writes beside index.html.
pub const APP_FRAME_RUNTIME: &str = "app-frame-runtime.js";

/// The frame's URL as the page reaches it: WebView2 has no custom schemes, so
/// Windows serves `http://<scheme>.localhost`, like the app's own pages.
pub fn app_frame_url() -> &'static str {
    if cfg!(windows) {
        "http://liaison-frame.localhost/"
    } else {
        "liaison-frame://localhost/"
    }
}

/// The page's origins, the only ones that may frame the document.
pub const FRAME_ANCESTORS: &str =
    "tauri://localhost http://tauri.localhost https://tauri.localhost http://localhost:*";

/// Published to the page before it loads, so apps/web knows where the frame
/// is (and that this shell isolates installed apps at all).
pub fn app_frame_url_script() -> String {
    format!(
        "Object.defineProperty(globalThis, \"__LIAISON_APP_FRAME_URL__\", {{ value: {}, writable: false, configurable: false }});",
        serde_json::Value::String(app_frame_url().to_string())
    )
}

pub fn frame_policy(nonce: &str) -> String {
    [
        "default-src 'none'".to_string(),
        format!("script-src 'nonce-{nonce}' blob:"),
        "style-src 'unsafe-inline'".to_string(),
        "img-src data: blob:".to_string(),
        "font-src data:".to_string(),
        "media-src data: blob:".to_string(),
        "connect-src 'none'".to_string(),
        "frame-src 'none'".to_string(),
        "worker-src 'none'".to_string(),
        "object-src 'none'".to_string(),
        "form-action 'none'".to_string(),
        "base-uri 'none'".to_string(),
        format!("frame-ancestors {FRAME_ANCESTORS}"),
    ]
    .join("; ")
}

pub fn frame_html(nonce: &str, runtime: &str) -> String {
    // `</script` inside the runtime would end the element early.
    let safe = runtime.replace("</script", "<\\/script");
    format!(
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\" />\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n\
         <meta name=\"referrer\" content=\"no-referrer\" />\n<title>App</title>\n</head>\n\
         <body>\n<div id=\"app\"></div>\n<script nonce=\"{nonce}\">{safe}</script>\n</body>\n</html>\n"
    )
}

/// A nonce for one response: 18 random bytes, hex.
fn nonce() -> Option<String> {
    let mut bytes = [0u8; 18];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn not_found() -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header("Content-Type", "text/plain")
        .body(Cow::Borrowed(&b"not found"[..]))
        .expect("a static response")
}

/// The answer for one request on the frame scheme, with the runtime injected
/// so the composition is drivable without a running app.
pub fn answer(path: &str, runtime: Option<&str>) -> Response<Cow<'static, [u8]>> {
    if path != "/" && path != "/index.html" {
        return not_found();
    }
    let (Some(runtime), Some(nonce)) = (runtime, nonce()) else {
        return not_found();
    };
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", frame_policy(&nonce))
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .header("X-Content-Type-Options", "nosniff")
        .body(Cow::Owned(frame_html(&nonce, runtime).into_bytes()))
        .expect("a well formed response")
}

/// The `register_uri_scheme_protocol` handler.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    let runtime = ctx
        .app_handle()
        .asset_resolver()
        .get(APP_FRAME_RUNTIME.to_string())
        .and_then(|asset| String::from_utf8(asset.bytes).ok());
    answer(request.uri().path(), runtime.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(response: &Response<Cow<'static, [u8]>>, name: &str) -> String {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string()
    }

    /// The frame runs the nonced runtime and the blobs it makes, reaches no
    /// network, and is framed only by the window.
    #[test]
    fn the_frame_document_runs_only_its_runtime_and_reaches_no_network() {
        let response = answer("/", Some("console.log(1)"));
        assert_eq!(response.status(), StatusCode::OK);
        let policy = header(&response, "Content-Security-Policy");
        let nonce = policy
            .split("'nonce-")
            .nth(1)
            .and_then(|rest| rest.split('\'').next())
            .expect("a nonce");
        assert!(policy.contains(&format!("script-src 'nonce-{nonce}' blob:;")));
        assert!(policy.contains("connect-src 'none'"));
        // An image is the bundle's own (data:, or a blob it made from what the page handed it):
        // an <img src> to a remote host would carry what the app read out of the frame.
        let img = policy
            .split(';')
            .map(str::trim)
            .find(|d| d.starts_with("img-src "))
            .expect("img-src");
        assert_eq!(img, "img-src data: blob:");
        assert!(policy.contains("default-src 'none'"));
        assert!(policy.contains("frame-ancestors tauri://localhost http://tauri.localhost"));
        assert!(!policy.contains("unsafe-eval") && !policy.contains("'self'"));
        let body = String::from_utf8(response.body().to_vec()).unwrap();
        assert!(body.contains(&format!(
            "<script nonce=\"{nonce}\">console.log(1)</script>"
        )));
        // Each response its own nonce.
        let again = header(&answer("/", Some("x")), "Content-Security-Policy");
        assert_ne!(again, policy);
    }

    #[test]
    fn the_runtime_cannot_close_its_own_script_element() {
        let html = frame_html("n", "a('</script><script>b()')");
        assert!(!html.contains("a('</script>"));
    }

    #[test]
    fn only_the_document_is_served() {
        assert_eq!(
            answer("/other.js", Some("x")).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(answer("/", None).status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn the_page_learns_the_frame_url_and_cannot_replace_it() {
        let script = app_frame_url_script();
        assert!(script.contains(app_frame_url()));
        assert!(script.contains("writable: false"));
    }

    /// THE BRIDGE NEVER REACHES A FRAME. Tauri's own scripts are main frame
    /// only; a script of ours registered for every frame would hand the shell's
    /// commands to an installed app's frame.
    #[test]
    fn no_script_of_the_shell_runs_in_a_sub_frame() {
        for (name, source) in [
            ("main.rs", include_str!("main.rs")),
            ("driver.rs", include_str!("driver.rs")),
            ("sidecar.rs", include_str!("sidecar.rs")),
        ] {
            for all_frames in [
                "initialization_script_for_all_frames",
                "js_init_script_on_all_frames",
            ] {
                assert!(!source.contains(all_frames), "{name} uses {all_frames}");
            }
        }
    }

    /// The window frames the shell's own frame scheme, and still nothing from
    /// the network.
    #[test]
    fn the_window_policy_frames_the_frame_scheme_and_nothing_remote() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = conf["app"]["security"]["csp"].as_str().unwrap();
        let frame = csp
            .split(';')
            .map(str::trim)
            .find(|d| d.starts_with("frame-src "))
            .expect("frame-src");
        assert!(
            frame.contains("liaison-frame:") && frame.contains("http://liaison-frame.localhost")
        );
        assert!(!frame.contains("https:") && !frame.contains('*'));
    }
}
