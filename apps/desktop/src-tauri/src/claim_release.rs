// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE CONVERSATION IS HANDED BACK WHEN THE APP GOES AWAY (2026-09-23).
//
// A local session holds a lease on its conversation (A32) and the page
// releases it on every exit the page can see. Quitting the app is not one of
// them: Cmd+Q ends the event loop without a `pagehide`, the shell then kills
// the sidecar, and no page script runs again. The lease was left live for up
// to a minute, and the app relaunched inside that minute was refused its own
// conversation (409, "another machine").
//
// So the page tells the shell which lease it holds, with the URL that releases
// it and the token of the moment (renewed with every heartbeat, because a
// token lives fifteen minutes), and the shell sends that one DELETE on its way
// out, bounded, before the process is gone. Best effort: the lease's TTL is
// still the backstop, and the server now lets the same install supersede its
// previous life at once.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Runtime};
use url::Url;

/// How long the exit waits for the server. The app is quitting: a second and a
/// half is noticeable only on a server that is not answering anyway.
pub const RELEASE_ON_EXIT_TIMEOUT: Duration = Duration::from_millis(1500);

/// The lease the page holds, as it last told the shell.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldClaim {
    pub release_url: String,
    pub token: String,
}

static HELD: Mutex<Option<HeldClaim>> = Mutex::new(None);

/// A URL that releases ONE lease on the bound server, or a refusal.
///
/// The page is not trusted with where the shell sends a bearer token: the URL
/// must be the bound server's own origin and the claims release route, so a
/// script in the page cannot turn the exit into a request to anywhere else.
pub fn validate_release_url(release_url: &str, server: &str) -> Result<String, String> {
    let parsed = Url::parse(release_url).map_err(|error| error.to_string())?;
    let bound = Url::parse(server).map_err(|error| error.to_string())?;
    if parsed.origin() != bound.origin() {
        return Err("the release URL is not on the bound server".into());
    }
    let segments: Vec<&str> = parsed
        .path_segments()
        .map(|s| s.collect())
        .unwrap_or_default();
    let shaped = segments.len() == 5
        && segments[0] == "api"
        && segments[1] == "agents"
        && segments[3] == "local-claims"
        && !segments[2].is_empty()
        && !segments[4].is_empty();
    let has_holder = parsed
        .query_pairs()
        .any(|(key, value)| key == "holderKey" && !value.is_empty());
    if !shaped || !has_holder {
        return Err("the release URL is not a local claim release".into());
    }
    Ok(parsed.to_string())
}

/// Records (or, with `None`, forgets) the lease the page holds.
pub fn note(claim: Option<HeldClaim>) {
    if let Ok(mut held) = HELD.lock() {
        *held = claim;
    }
}

/// The lease on record, taken: an exit releases it at most once.
pub fn take() -> Option<HeldClaim> {
    HELD.lock().ok().and_then(|mut held| held.take())
}

/// Sends the release, bounded. Never fails loudly: the TTL is the backstop.
pub async fn release(claim: &HeldClaim, timeout: Duration) -> bool {
    let Ok(client) = reqwest::Client::builder().timeout(timeout).build() else {
        return false;
    };
    match client
        .delete(&claim.release_url)
        .bearer_auth(&claim.token)
        .send()
        .await
    {
        Ok(response) => response.status().is_success(),
        Err(error) => {
            eprintln!("liaison: the conversation was not released on exit ({error})");
            false
        }
    }
}

/// THE EXIT PATH: releases the lease on record, if any, and waits for it.
/// Called from the run loop's exit events, which run outside the async
/// runtime, so blocking here is what makes the request leave before the
/// process does.
pub fn release_held_on_exit() {
    if let Some(claim) = take() {
        tauri::async_runtime::block_on(release(&claim, RELEASE_ON_EXIT_TIMEOUT));
    }
}

/// `note_local_claim`: the page's record of the lease it holds. Both absent
/// forgets it (the page released it itself).
#[tauri::command]
pub fn note_local_claim<R: Runtime>(
    app: AppHandle<R>,
    release_url: Option<String>,
    token: Option<String>,
) -> Result<(), String> {
    let (Some(release_url), Some(token)) = (release_url, token) else {
        note(None);
        return Ok(());
    };
    let server = crate::sidecar::get_server_address(app).ok_or("no server is bound")?;
    let release_url = validate_release_url(&release_url, &server)?;
    note(Some(HeldClaim { release_url, token }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    const SERVER: &str = "https://liaison.example.com";
    const RELEASE: &str =
        "https://liaison.example.com/api/agents/a1/local-claims/t1?holderKey=d.abc.window";

    #[test]
    fn a_release_url_on_the_bound_server_is_accepted() {
        assert!(validate_release_url(RELEASE, SERVER).is_ok());
    }

    #[test]
    fn a_release_url_anywhere_else_is_refused() {
        let elsewhere = RELEASE.replace("liaison.example.com", "evil.example.com");
        assert!(validate_release_url(&elsewhere, SERVER).is_err());
        let other_route = "https://liaison.example.com/api/auth/logout?holderKey=x";
        assert!(validate_release_url(other_route, SERVER).is_err());
        let no_holder = "https://liaison.example.com/api/agents/a1/local-claims/t1";
        assert!(validate_release_url(no_holder, SERVER).is_err());
    }

    /// THE QUIT (2026-09-23): the lease the page noted is released by the
    /// shell's exit path, as a DELETE carrying the token, and only once.
    #[test]
    fn the_exit_path_releases_the_noted_claim_once() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 4096];
            let read = stream.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n");
            request
        });
        let base = format!("http://127.0.0.1:{port}");
        let url = validate_release_url(
            &format!("{base}/api/agents/a1/local-claims/t1?holderKey=d.abc.window"),
            &base,
        )
        .unwrap();
        note(Some(HeldClaim {
            release_url: url,
            token: "tok-123".into(),
        }));
        release_held_on_exit();
        let request = server.join().unwrap();
        assert!(
            request.starts_with("DELETE /api/agents/a1/local-claims/t1?holderKey=d.abc.window ")
        );
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer tok-123"));
        assert_eq!(take(), None, "an exit releases the lease at most once");
    }
}
