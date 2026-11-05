// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Liaison MCP access from the desktop is an agent-scoped token minted through
// the same OAuth device-code grant the CLI uses: initiate with the agent id, a
// human approves in the browser, then poll (re-stating the agent id) for the
// token. Measured against a live box the token lives 15 minutes and carries
// (agentId, grantorUserId) in its claims, so it is checked before every spawn:
// a turn started with an expired one does not fail, it runs with an empty
// Liaison tool catalog, which looks like the agent forgetting everything it
// can do.

use std::fmt;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};

/// A minted token and the instant it stops being usable, in epoch millis.
///
/// The REFRESH TOKEN rides along. The device grant's poll answers with one
/// (`mcp/device-grant-routes.ts`) and it used to be dropped on the floor, so a
/// token that died after its fifteen minutes could only be replaced by sending
/// the user back to the browser to approve another code, and every approval
/// minted one more MCP connection row on the server. With it kept, an expired
/// token is renewed silently through `/mcp/oauth/token`, and the browser is
/// only asked for when the refresh itself is refused.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct StoredToken {
    pub token: String,
    pub expires_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum AuthError {
    /// The grant ran but produced no token.
    GrantFailed(String),
    /// A human never approved the pending device code.
    NotApproved,
    /// The Liaison server could not be reached at all.
    Unreachable(String),
    /// The server refused to start a device grant for this client at all: its
    /// `DEVICE_FLOW_CLIENTS` does not admit the desktop. Nothing the user does
    /// in this window changes that, so it is named apart from a grant that
    /// merely failed, and the window says who has to act.
    ClientNotAllowed(String),
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AuthError::GrantFailed(detail) => write!(f, "GrantFailed: {detail}"),
            AuthError::NotApproved => write!(f, "NotApproved"),
            AuthError::Unreachable(detail) => write!(f, "Unreachable: {detail}"),
            AuthError::ClientNotAllowed(detail) => write!(f, "DeviceClientNotAllowed: {detail}"),
        }
    }
}

impl AuthError {
    /// The variant name alone, which is what the UI renders as a reconnect
    /// reason. The detail can carry a URL or a server message and is not for
    /// the window.
    pub fn variant(&self) -> &'static str {
        match self {
            AuthError::GrantFailed(_) => "GrantFailed",
            AuthError::NotApproved => "NotApproved",
            AuthError::Unreachable(_) => "Unreachable",
            AuthError::ClientNotAllowed(_) => "DeviceClientNotAllowed",
        }
    }
}

/// Refresh a little before the token actually dies, so a turn that starts now
/// does not lose its catalog halfway through.
pub const REFRESH_MARGIN_MS: u64 = 60_000;

/// Returns a usable token. In order: the stored one while it is still worth
/// using; else a REFRESH of it, when it carries a refresh token; else a fresh
/// device grant. A refresh that fails for any reason (a revoked connection, a
/// server that forgot it, a network blip) FALLS BACK to the grant rather than
/// ending the start: the user can still approve a new code, and a dead end
/// with a Reconnect that re-runs the same refused refresh is the loop this
/// order exists to prevent. `refresh` and `mint` are closures so the decision
/// is testable without a network at all. Production drives the async twin.
#[cfg_attr(not(test), allow(dead_code))]
pub fn ensure_fresh_token<R, M>(
    stored: Option<StoredToken>,
    now_ms: u64,
    refresh: R,
    mint: M,
) -> Result<StoredToken, AuthError>
where
    R: FnOnce(&str) -> Result<StoredToken, AuthError>,
    M: FnOnce() -> Result<StoredToken, AuthError>,
{
    match next_step(stored, now_ms) {
        TokenStep::Use(token) => Ok(token),
        TokenStep::Refresh(refresh_token) => match refresh(&refresh_token) {
            Ok(token) => Ok(token),
            Err(error) => {
                eprintln!("liaison: the MCP token could not be refreshed ({error}), asking for a new approval");
                mint()
            }
        },
        TokenStep::Mint => mint(),
    }
}

/**
 * The same decision, when the refresh and the mint are NETWORK round trips.
 *
 * The device grant waits for a HUMAN, so the mint is minutes long and cannot
 * run on a thread the window needs: a synchronous wait froze the whole shell
 * for the life of the grant (driven walk, FX10). The sync version stays for the
 * tests that drive the decision without a network.
 */
pub async fn ensure_fresh_token_async<R, RF, M, MF>(
    stored: Option<StoredToken>,
    now_ms: u64,
    refresh: R,
    mint: M,
) -> Result<StoredToken, AuthError>
where
    R: FnOnce(String) -> RF,
    RF: std::future::Future<Output = Result<StoredToken, AuthError>>,
    M: FnOnce() -> MF,
    MF: std::future::Future<Output = Result<StoredToken, AuthError>>,
{
    // ONE rule for what to do with the stored token, shared with the sync
    // version: a second copy is how the two would come to disagree.
    match next_step(stored, now_ms) {
        TokenStep::Use(token) => Ok(token),
        TokenStep::Refresh(refresh_token) => match refresh(refresh_token).await {
            Ok(token) => Ok(token),
            Err(error) => {
                eprintln!("liaison: the MCP token could not be refreshed ({error}), asking for a new approval");
                mint().await
            }
        },
        TokenStep::Mint => mint().await,
    }
}

/// What to do with what is stored.
#[derive(Debug, PartialEq, Eq)]
pub enum TokenStep {
    /// Still worth using as it is.
    Use(StoredToken),
    /// Expired (or about to), but renewable without a human.
    Refresh(String),
    /// Nothing renewable: a human has to approve a new grant.
    Mint,
}

pub fn next_step(stored: Option<StoredToken>, now_ms: u64) -> TokenStep {
    let Some(stored) = stored else {
        return TokenStep::Mint;
    };
    if let Some(token) = usable_token(Some(stored.clone()), now_ms) {
        return TokenStep::Use(token);
    }
    match stored.refresh_token {
        Some(refresh_token) if !refresh_token.is_empty() => TokenStep::Refresh(refresh_token),
        _ => TokenStep::Mint,
    }
}

/// The stored token, when it is still worth using. `None` means mint.
pub fn usable_token(stored: Option<StoredToken>, now_ms: u64) -> Option<StoredToken> {
    stored.filter(|token| token.expires_at_ms > now_ms.saturating_add(REFRESH_MARGIN_MS))
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Decodes one base64url segment. The token's own expiry is inside its claims
/// and nowhere else in the grant response, so it is read from there rather
/// than guessed from a hardcoded lifetime that the server is free to change.
pub(crate) fn base64url_decode(input: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    let mut out = Vec::new();
    for byte in input.bytes() {
        if byte == b'=' {
            break;
        }
        let value = TABLE.iter().position(|candidate| *candidate == byte)? as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Some(out)
}

/// The `exp` claim of a JWT, in epoch millis.
pub fn expiry_from_jwt(token: &str) -> Option<u64> {
    let payload = token.split('.').nth(1)?;
    let decoded = base64url_decode(payload)?;
    let claims: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    claims.get("exp")?.as_u64().map(|seconds| seconds * 1000)
}

/// Where the device grant lives and which agent the token is bound to. The
/// agent id is stated at initiate AND again at poll: the server binds the
/// connection to the agent, and a poll that omits it gets a token for nobody.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceGrantConfig {
    pub base_url: String,
    pub client_id: String,
    pub agent_id: String,
}

#[derive(Deserialize)]
struct Envelope<T> {
    data: T,
}

#[derive(Deserialize)]
struct Initiated {
    #[serde(rename = "deviceCode")]
    device_code: String,
    #[serde(rename = "verificationUri")]
    verification_uri: String,
    #[serde(rename = "expiresIn")]
    expires_in: Option<u64>,
    interval: Option<u64>,
}

/// A started grant: the code to poll with, the URL a human approves, and the
/// two numbers that say how to wait for them. The server states both; the
/// defaults are here only for a server too old to send them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StartedGrant {
    pub device_code: String,
    pub verification_uri: String,
    /// How long the code stays approvable.
    pub expires_in_secs: u64,
    /// How long to wait between polls.
    pub interval_secs: u64,
}

/// The device flow's own defaults, used only when the server names neither.
pub const DEFAULT_GRANT_EXPIRY_SECS: u64 = 900;
pub const DEFAULT_POLL_INTERVAL_SECS: u64 = 5;

/// The poll route refuses more than one poll per second per device code
/// (`mcp/device-grant-routes.ts`), so an interval the server states as 0 or 1
/// would spend the whole window being rate limited rather than polling.
pub const MIN_POLL_INTERVAL_SECS: u64 = 2;

/// And never SLOWER than a person will wait. The server address is typed by
/// the user at first launch, so these two numbers come from wherever that
/// address points: a wrong or hostile one answering `interval: 86400` leaves
/// the shell sitting on a code nobody is polling for, with nothing to click.
pub const MAX_POLL_INTERVAL_SECS: u64 = 10;

/// The same for the window itself: a grant that claims to stay approvable for
/// a year is a wait that never ends. Fifteen minutes is the device flow's own
/// expiry (`mcp/device-grant-routes.ts`), and anything longer is not a grant
/// this shell will wait out.
pub const MAX_GRANT_EXPIRY_SECS: u64 = 900;

/// The interval actually slept between polls: what the server said, floored so
/// it is not rate limited and capped so it is not a wait with no end.
pub fn bounded_poll_interval(stated: u64) -> u64 {
    stated.clamp(MIN_POLL_INTERVAL_SECS, MAX_POLL_INTERVAL_SECS)
}

/// The window actually waited out, capped the same way.
pub fn bounded_grant_expiry(stated: u64) -> u64 {
    stated.clamp(1, MAX_GRANT_EXPIRY_SECS)
}

/// What one poll attempt says about what to do next.
#[derive(Debug, PartialEq, Eq)]
pub enum PollStep {
    /// The grant produced a token.
    Minted,
    /// Nobody has approved it yet, and there is still time.
    WaitAgain,
    /// The window closed. Reconnecting is the only way forward.
    Expired,
}

/// Whether there is any point polling again, given the clock. Pure, so the
/// deadline is provable without a server and without waiting 15 minutes.
pub fn poll_step(minted: bool, now_ms: u64, deadline_ms: u64) -> PollStep {
    if minted {
        return PollStep::Minted;
    }
    if now_ms >= deadline_ms {
        return PollStep::Expired;
    }
    PollStep::WaitAgain
}

#[derive(Deserialize)]
struct Polled {
    #[serde(rename = "accessToken")]
    access_token: Option<String>,
    #[serde(rename = "refreshToken")]
    refresh_token: Option<String>,
    status: Option<String>,
}

/// The server's own words from an error envelope (`{ error: { message } }`),
/// or the status alone when the body is not one.
fn server_message(status: u16, body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(|message| message.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| format!("HTTP {status}"))
}

/// What an initiate answer means, decided without a network.
///
/// THE STATUS IS READ FIRST. It used to be ignored: a 403 body is an error
/// envelope, not `{ data }`, so the parse failed and the refusal reached the
/// window as a bare `GrantFailed` ("error decoding response body"), which the
/// window could only render as "your connection needs to be renewed". The
/// production box answered every desktop initiate with 403 "Unregistered device
/// client" and the user was offered a Reconnect that re-ran the same refusal.
pub fn initiate_outcome(status: u16, body: &str) -> Result<StartedGrant, AuthError> {
    if status == 403 {
        return Err(AuthError::ClientNotAllowed(server_message(status, body)));
    }
    if !(200..300).contains(&status) {
        return Err(AuthError::GrantFailed(server_message(status, body)));
    }
    let body: Envelope<Initiated> =
        serde_json::from_str(body).map_err(|error| AuthError::GrantFailed(error.to_string()))?;
    Ok(StartedGrant {
        device_code: body.data.device_code,
        verification_uri: body.data.verification_uri,
        expires_in_secs: bounded_grant_expiry(
            body.data.expires_in.unwrap_or(DEFAULT_GRANT_EXPIRY_SECS),
        ),
        interval_secs: bounded_poll_interval(
            body.data.interval.unwrap_or(DEFAULT_POLL_INTERVAL_SECS),
        ),
    })
}

/// Starts the grant and returns everything needed to wait for it. Approval is a
/// browser step, so this never blocks on it.
pub async fn initiate(config: &DeviceGrantConfig) -> Result<StartedGrant, AuthError> {
    let response = reqwest::Client::new()
        .post(format!("{}/mcp/device/initiate", config.base_url))
        .json(&serde_json::json!({ "clientId": config.client_id, "agentId": config.agent_id }))
        .send()
        .await
        .map_err(|error| AuthError::Unreachable(error.to_string()))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|error| AuthError::Unreachable(error.to_string()))?;
    let outcome = initiate_outcome(status, &body);
    if let Err(error) = &outcome {
        eprintln!("liaison: the device grant could not be started ({error})");
    }
    outcome
}

/// The route that creates this install's agent connection from the session the
/// window is signed in with (`mcp/desktop-connection-routes.ts`).
pub fn session_connect_url(base_url: &str) -> String {
    format!("{}/mcp/desktop/connection", base_url.trim_end_matches('/'))
}

/// What the session connect answered, decided without a network. `Ok(None)` is
/// a server that predates the route (404): the only case the device grant is
/// still the way in. Anything else that is not a token is an error the window
/// shows, never a quiet fall back to the browser.
pub fn session_connect_outcome(status: u16, body: &str) -> Result<Option<StoredToken>, AuthError> {
    if status == 404 {
        return Ok(None);
    }
    if !(200..300).contains(&status) {
        return Err(AuthError::GrantFailed(server_message(status, body)));
    }
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "accessToken")]
        access_token: String,
        #[serde(rename = "refreshToken")]
        refresh_token: Option<String>,
    }
    #[derive(Deserialize)]
    struct Envelope {
        data: Data,
    }
    let body: Envelope =
        serde_json::from_str(body).map_err(|error| AuthError::GrantFailed(error.to_string()))?;
    let expires_at_ms = expiry_from_jwt(&body.data.access_token)
        .ok_or_else(|| AuthError::GrantFailed("no exp claim".into()))?;
    Ok(Some(StoredToken {
        token: body.data.access_token,
        expires_at_ms,
        refresh_token: body.data.refresh_token,
    }))
}

/// Creates the agent's connection with the signed in user's own access token:
/// no code, no browser. The user already proved who they are to this server
/// when they signed in to the window, and a second proof in a browser was the
/// approval prompt every new agent (and every lost connection) asked for.
pub async fn connect_with_session(
    base_url: &str,
    agent_id: &str,
    access_token: &str,
) -> Result<Option<StoredToken>, AuthError> {
    let response = reqwest::Client::new()
        .post(session_connect_url(base_url))
        .bearer_auth(access_token)
        .json(&serde_json::json!({ "agentId": agent_id }))
        .send()
        .await
        .map_err(|error| AuthError::Unreachable(error.to_string()))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|error| AuthError::Unreachable(error.to_string()))?;
    session_connect_outcome(status, &body)
}

/// How a new connection is obtained. With the window's session token, the
/// session connect, and the device grant only when the server has no such
/// route. Without one (a window that could not name its session), the grant.
/// Closures so the order is testable without a network.
pub async fn mint_agent_token<C, CF, G, GF>(
    session_token: Option<String>,
    connect: C,
    device_grant: G,
) -> Result<StoredToken, AuthError>
where
    C: FnOnce(String) -> CF,
    CF: std::future::Future<Output = Result<Option<StoredToken>, AuthError>>,
    G: FnOnce() -> GF,
    GF: std::future::Future<Output = Result<StoredToken, AuthError>>,
{
    match session_token.filter(|token| !token.trim().is_empty()) {
        Some(token) => match connect(token).await? {
            Some(minted) => Ok(minted),
            None => {
                eprintln!("liaison: this server has no session connect, asking for a device approval");
                device_grant().await
            }
        },
        None => device_grant().await,
    }
}

/// What a refresh answer means, decided without a network. The OAuth token
/// route answers in plain OAuth shape (`access_token`, `refresh_token`), not in
/// the API envelope.
pub fn refresh_outcome(
    status: u16,
    body: &str,
    presented_refresh_token: &str,
) -> Result<StoredToken, AuthError> {
    if !(200..300).contains(&status) {
        return Err(AuthError::GrantFailed(format!(
            "refresh refused (HTTP {status})"
        )));
    }
    #[derive(Deserialize)]
    struct Refreshed {
        access_token: String,
        refresh_token: Option<String>,
    }
    let refreshed: Refreshed =
        serde_json::from_str(body).map_err(|error| AuthError::GrantFailed(error.to_string()))?;
    let expires_at_ms = expiry_from_jwt(&refreshed.access_token)
        .ok_or_else(|| AuthError::GrantFailed("no exp claim".into()))?;
    Ok(StoredToken {
        token: refreshed.access_token,
        expires_at_ms,
        refresh_token: Some(
            refreshed
                .refresh_token
                .unwrap_or_else(|| presented_refresh_token.to_string()),
        ),
    })
}

/// The MCP OAuth token route of one server. The shell renews through it at
/// spawn, and hands it to the sidecar so a running session renews through the
/// very same route (`sidecar/mcp-token.ts`).
pub fn token_url(base_url: &str) -> String {
    format!("{}/mcp/oauth/token", base_url.trim_end_matches('/'))
}

/// Renews an expired agent-scoped token without a human: the MCP OAuth
/// `refresh_token` grant, which mints a new access token on the SAME
/// connection, so it stays bound to the same agent.
pub async fn refresh(base_url: &str, refresh_token: &str) -> Result<StoredToken, AuthError> {
    let response = reqwest::Client::new()
        .post(token_url(base_url))
        .header("content-type", "application/x-www-form-urlencoded")
        .body(format!(
            "grant_type=refresh_token&refresh_token={}",
            escape(refresh_token)
        ))
        .send()
        .await
        .map_err(|error| AuthError::Unreachable(error.to_string()))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|error| AuthError::Unreachable(error.to_string()))?;
    refresh_outcome(status, &body, refresh_token)
}

/// Everything outside the unreserved set is escaped. A device code, a client
/// id or an agent id is server supplied text, and one `&` or `=` inside any of
/// them rewrites the query the poll actually sends.
const UNRESERVED: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

fn escape(value: &str) -> String {
    utf8_percent_encode(value, UNRESERVED).to_string()
}

/// The poll URL for one device code, built in one place so the escaping is
/// provable without a server.
pub fn poll_url(config: &DeviceGrantConfig, device_code: &str) -> String {
    format!(
        "{}/mcp/device/poll/{}?client_id={}&agent_id={}",
        config.base_url,
        escape(device_code),
        escape(&config.client_id),
        escape(&config.agent_id)
    )
}

/// Where the client says it has GIVEN UP on a grant it started (P6d-FX7,
/// SK-7). Same secret as the poll: the device code is the initiating client's
/// own, and a headless client has no session to authenticate with.
pub fn cancel_url(config: &DeviceGrantConfig, device_code: &str) -> String {
    format!(
        "{}/mcp/device/{}?client_id={}",
        config.base_url,
        escape(device_code),
        escape(&config.client_id)
    )
}

/// THE GRANT THIS WINDOW IS WAITING ON (P6d-FX7, SK-7).
///
/// The dialog's Cancel used to set a page signal to null: the poll loop kept
/// running and, more to the point, the pending code stayed approvable for its
/// whole fifteen minutes. Whoever had the code could complete a flow the window
/// had forgotten it started. So the wait is registered here, the cancel stops
/// it, and the server is told the code is dead.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingGrant {
    pub config: DeviceGrantConfig,
    pub device_code: String,
}

static PENDING_GRANT: OnceLock<Mutex<Option<PendingGrant>>> = OnceLock::new();

fn pending_slot() -> &'static Mutex<Option<PendingGrant>> {
    PENDING_GRANT.get_or_init(|| Mutex::new(None))
}

/// A wait has started. Any earlier one is over by construction: the shell runs
/// one grant at a time.
pub fn remember_pending_grant(grant: PendingGrant) {
    if let Ok(mut slot) = pending_slot().lock() {
        *slot = Some(grant);
    }
}

/// The wait is over, whichever way it ended.
pub fn forget_pending_grant() {
    if let Ok(mut slot) = pending_slot().lock() {
        *slot = None;
    }
}

/// Takes the grant this window is waiting on, leaving none behind: the caller
/// is the one cancelling it, and a second cancel has nothing to cancel.
pub fn take_pending_grant() -> Option<PendingGrant> {
    pending_slot().lock().ok().and_then(|mut slot| slot.take())
}

/// Is this window still waiting on the code it started with? The poll loop
/// asks between polls, so a cancel ends the wait rather than being noticed
/// fifteen minutes later.
pub fn still_waiting_for(device_code: &str) -> bool {
    pending_slot()
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|grant| grant.device_code == device_code))
        .unwrap_or(false)
}

/// Tells the server the code will never be approved. Best effort by design:
/// the grant expires on its own, and a cancel that could not be delivered must
/// not keep the window sitting on a dialog it has already closed.
pub async fn cancel(config: &DeviceGrantConfig, device_code: &str) -> Result<(), AuthError> {
    let response = reqwest::Client::new()
        .delete(cancel_url(config, device_code))
        .send()
        .await
        .map_err(|error| AuthError::Unreachable(error.to_string()))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(AuthError::GrantFailed(format!(
            "the grant could not be cancelled ({})",
            response.status()
        )))
    }
}

/// What one poll answer means, decided without a network.
///
/// A 429 is the route's own once-per-second limit and means "ask again", never
/// a failure: parsing its error envelope as a token used to end a wait the
/// human was halfway through. A code the server has expired is final.
pub fn poll_outcome(status: u16, body: &str) -> Result<Option<StoredToken>, AuthError> {
    if status == 429 {
        return Ok(None);
    }
    if !(200..300).contains(&status) {
        return Err(AuthError::GrantFailed(server_message(status, body)));
    }
    let body: Envelope<Polled> =
        serde_json::from_str(body).map_err(|error| AuthError::GrantFailed(error.to_string()))?;
    let Some(token) = body.data.access_token else {
        return match body.data.status.as_deref() {
            Some("denied") | Some("expired") => Err(AuthError::NotApproved),
            _ => Ok(None),
        };
    };
    let expires_at_ms =
        expiry_from_jwt(&token).ok_or_else(|| AuthError::GrantFailed("no exp claim".into()))?;
    Ok(Some(StoredToken {
        token,
        expires_at_ms,
        refresh_token: body.data.refresh_token,
    }))
}

/// Polls once for the minted token. Returns Ok(None) while the human has not
/// approved yet, so the caller decides how long to wait rather than this
/// function holding the app open.
pub async fn poll_once(
    config: &DeviceGrantConfig,
    device_code: &str,
) -> Result<Option<StoredToken>, AuthError> {
    let response = reqwest::Client::new()
        .get(poll_url(config, device_code))
        .send()
        .await
        .map_err(|error| AuthError::Unreachable(error.to_string()))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|error| AuthError::Unreachable(error.to_string()))?;
    poll_outcome(status, &body)
}

#[cfg(test)]
mod auth_tests {
    use super::*;
    use std::cell::Cell;

    fn token(expires_at_ms: u64) -> StoredToken {
        StoredToken {
            token: "t".into(),
            expires_at_ms,
            refresh_token: None,
        }
    }

    #[test]
    fn ensure_fresh_token_skips_the_network_call_when_the_stored_token_has_not_expired() {
        let calls = Cell::new(0);
        let result = ensure_fresh_token(
            Some(token(10_000_000)),
            1_000,
            |_| unreachable!(),
            || {
                calls.set(calls.get() + 1);
                Ok(token(20_000_000))
            },
        );
        assert_eq!(calls.get(), 0);
        assert_eq!(result.unwrap().expires_at_ms, 10_000_000);
    }

    #[test]
    fn ensure_fresh_token_mints_when_nothing_is_stored() {
        let calls = Cell::new(0);
        let result = ensure_fresh_token(
            None,
            1_000,
            |_| unreachable!(),
            || {
                calls.set(calls.get() + 1);
                Ok(token(20_000_000))
            },
        );
        assert_eq!(calls.get(), 1);
        assert_eq!(result.unwrap().expires_at_ms, 20_000_000);
    }

    #[test]
    fn ensure_fresh_token_mints_inside_the_refresh_margin() {
        // Still valid for another 30 seconds, which is not enough to start a
        // turn on: the margin is the whole point of the check.
        let calls = Cell::new(0);
        let now = 1_000_000;
        let _ = ensure_fresh_token(
            Some(token(now + 30_000)),
            now,
            |_| unreachable!(),
            || {
                calls.set(calls.get() + 1);
                Ok(token(now + 3_600_000))
            },
        );
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn ensure_fresh_token_reports_the_grant_failure_rather_than_a_stale_token() {
        let result = ensure_fresh_token(
            Some(token(0)),
            1_000,
            |_| unreachable!(),
            || Err(AuthError::NotApproved),
        );
        assert_eq!(result.unwrap_err(), AuthError::NotApproved);
    }

    fn renewable(expires_at_ms: u64) -> StoredToken {
        StoredToken {
            token: "old".into(),
            expires_at_ms,
            refresh_token: Some("conn.secret".into()),
        }
    }

    /// THE DEAD END THIS PINS: an expired token that carries a refresh token is
    /// renewed without sending anybody to a browser.
    #[test]
    fn an_expired_token_with_a_refresh_token_is_refreshed_not_re_approved() {
        let minted = Cell::new(0);
        let result = ensure_fresh_token(
            Some(renewable(0)),
            1_000,
            |refresh| {
                assert_eq!(refresh, "conn.secret");
                Ok(token(20_000_000))
            },
            || {
                minted.set(minted.get() + 1);
                Ok(token(30_000_000))
            },
        );
        assert_eq!(minted.get(), 0);
        assert_eq!(result.unwrap().expires_at_ms, 20_000_000);
    }

    /// AND A REFUSED REFRESH IS NOT THE END: it falls back to a fresh device
    /// grant, which the user can approve.
    #[test]
    fn a_refused_refresh_falls_back_to_a_fresh_device_grant() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let minted = Cell::new(0);
        let result = runtime.block_on(ensure_fresh_token_async(
            Some(renewable(0)),
            1_000,
            |_: String| async { Err(AuthError::GrantFailed("refresh refused (HTTP 400)".into())) },
            || {
                minted.set(minted.get() + 1);
                async { Ok(token(30_000_000)) }
            },
        ));
        assert_eq!(minted.get(), 1);
        assert_eq!(result.unwrap().expires_at_ms, 30_000_000);
    }

    #[test]
    fn the_next_step_uses_refreshes_or_mints() {
        assert_eq!(next_step(None, 1_000), TokenStep::Mint);
        assert_eq!(next_step(Some(token(0)), 1_000), TokenStep::Mint);
        assert_eq!(
            next_step(Some(renewable(0)), 1_000),
            TokenStep::Refresh("conn.secret".into())
        );
        assert!(matches!(
            next_step(Some(renewable(10_000_000)), 1_000),
            TokenStep::Use(_)
        ));
    }

    /// THE PRODUCTION DEFECT (2026-09-23): liaison.acme.example answered every
    /// desktop initiate with this exact 403, the shell parsed the error body as
    /// a grant, and the window got a bare GrantFailed it could only render as
    /// "your connection needs to be renewed", with a Reconnect that re-ran it.
    #[test]
    fn an_initiate_refused_for_the_client_is_named_as_such() {
        let body = r#"{"error":{"message":"Unregistered device client","code":"FORBIDDEN"}}"#;
        let error = initiate_outcome(403, body).unwrap_err();
        assert_eq!(error.variant(), "DeviceClientNotAllowed");
        assert_eq!(
            error,
            AuthError::ClientNotAllowed("Unregistered device client".into())
        );
    }

    #[test]
    fn any_other_refused_initiate_carries_the_servers_message() {
        let body = r#"{"error":{"message":"agentId: Invalid UUID","code":"VALIDATION_ERROR"}}"#;
        assert_eq!(
            initiate_outcome(400, body).unwrap_err(),
            AuthError::GrantFailed("agentId: Invalid UUID".into())
        );
        assert_eq!(
            initiate_outcome(502, "<html>bad gateway</html>").unwrap_err(),
            AuthError::GrantFailed("HTTP 502".into())
        );
    }

    #[test]
    fn an_accepted_initiate_is_a_started_grant() {
        let body = r#"{"data":{"deviceCode":"dc","userCode":"ABCD","verificationUri":"https://box/auth/device?code=ABCD","expiresIn":900,"interval":5}}"#;
        let started = initiate_outcome(200, body).unwrap();
        assert_eq!(started.device_code, "dc");
        assert_eq!(
            started.verification_uri,
            "https://box/auth/device?code=ABCD"
        );
        assert_eq!(started.interval_secs, 5);
    }

    /// THE PROMPT THIS REMOVES: a window that is signed in never sees a device
    /// code. The session connect answers and the grant is never started.
    #[test]
    fn a_signed_in_window_gets_its_token_without_a_device_grant() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let result = runtime.block_on(mint_agent_token(
            Some("user.session.jwt".into()),
            |token: String| async move {
                assert_eq!(token, "user.session.jwt");
                Ok(Some(renewable(5_000_000)))
            },
            || async { panic!("a signed in window must not start a device grant") },
        ));
        assert_eq!(result, Ok(renewable(5_000_000)));
    }

    #[test]
    fn only_a_server_without_the_route_falls_back_to_the_device_grant() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let old_server = runtime.block_on(mint_agent_token(
            Some("user.session.jwt".into()),
            |_: String| async { Ok(None) },
            || async { Ok(renewable(7)) },
        ));
        assert_eq!(old_server, Ok(renewable(7)));
        let refused = runtime.block_on(mint_agent_token(
            Some("user.session.jwt".into()),
            |_: String| async { Err(AuthError::GrantFailed("unknown or foreign org agent".into())) },
            || async { panic!("a refusal is shown, not answered with a browser prompt") },
        ));
        assert_eq!(refused, Err(AuthError::GrantFailed("unknown or foreign org agent".into())));
        let no_session = runtime.block_on(mint_agent_token(
            Some("  ".into()),
            |_: String| async { panic!("no session, nothing to connect with") },
            || async { Ok(renewable(9)) },
        ));
        assert_eq!(no_session, Ok(renewable(9)));
    }

    #[test]
    fn the_session_connect_answer_is_read_from_the_api_envelope() {
        let jwt = jwt_expiring_at(2_000_000_000);
        let body = format!(r#"{{"data":{{"accessToken":"{jwt}","refreshToken":"conn.secret"}}}}"#);
        let token = session_connect_outcome(200, &body).unwrap().unwrap();
        assert_eq!(token.token, jwt);
        assert_eq!(token.expires_at_ms, 2_000_000_000_000);
        assert_eq!(token.refresh_token.as_deref(), Some("conn.secret"));
        assert_eq!(session_connect_outcome(404, "Not Found"), Ok(None));
        assert_eq!(
            session_connect_outcome(401, r#"{"error":{"message":"Unauthorized"}}"#),
            Err(AuthError::GrantFailed("Unauthorized".into()))
        );
        assert_eq!(
            session_connect_url("https://box.example/"),
            "https://box.example/mcp/desktop/connection"
        );
    }

    fn jwt_expiring_at(seconds: u64) -> String {
        // {"exp":<seconds>} base64url, no padding.
        let claims = format!("{{\"exp\":{seconds}}}");
        const TABLE: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let bytes = claims.as_bytes();
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let b = [
                chunk[0],
                *chunk.get(1).unwrap_or(&0),
                *chunk.get(2).unwrap_or(&0),
            ];
            let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
            let chars = chunk.len() + 1;
            for i in 0..chars {
                out.push(TABLE[((n >> (18 - 6 * i)) & 63) as usize] as char);
            }
        }
        format!("h.{out}.s")
    }

    /// The poll keeps the refresh token the server hands over: dropping it is
    /// what made every expiry a new browser approval.
    #[test]
    fn an_approved_poll_keeps_the_refresh_token() {
        let jwt = jwt_expiring_at(1_789_283_226);
        let body = format!(
            r#"{{"data":{{"status":"approved","accessToken":"{jwt}","refreshToken":"conn.secret"}}}}"#
        );
        let minted = poll_outcome(200, &body).unwrap().unwrap();
        assert_eq!(minted.expires_at_ms, 1_789_283_226_000);
        assert_eq!(minted.refresh_token.as_deref(), Some("conn.secret"));
    }

    #[test]
    fn a_rate_limited_poll_waits_again_and_an_expired_code_is_final() {
        let limited = r#"{"error":{"message":"slow_down"}}"#;
        assert_eq!(poll_outcome(429, limited).unwrap(), None);
        assert_eq!(
            poll_outcome(200, r#"{"data":{"status":"authorization_pending"}}"#).unwrap(),
            None
        );
        assert_eq!(
            poll_outcome(200, r#"{"data":{"status":"expired"}}"#).unwrap_err(),
            AuthError::NotApproved
        );
    }

    #[test]
    fn a_refresh_answer_is_a_renewed_token_on_the_same_connection() {
        let jwt = jwt_expiring_at(1_789_283_226);
        let body = format!(r#"{{"access_token":"{jwt}","token_type":"Bearer","expires_in":900}}"#);
        let renewed = refresh_outcome(200, &body, "conn.secret").unwrap();
        assert_eq!(renewed.token, jwt);
        assert_eq!(renewed.refresh_token.as_deref(), Some("conn.secret"));
        assert!(refresh_outcome(400, r#"{"error":"invalid_grant"}"#, "conn.secret").is_err());
    }

    #[test]
    fn the_variant_name_is_what_the_ui_gets_not_the_detail() {
        assert_eq!(
            AuthError::Unreachable("http://box:3000".into()).variant(),
            "Unreachable"
        );
    }

    #[test]
    fn expiry_is_read_from_the_token_claims() {
        // A real agent-scoped token's payload, claims trimmed to the two that
        // matter here. exp 1789283226 seconds is 1789283226000 millis.
        let payload = "eyJhZ2VudElkIjoiNjIwNjE1NmUiLCJleHAiOjE3ODkyODMyMjZ9";
        let jwt = format!("eyJhbGciOiJIUzI1NiJ9.{payload}.signature");
        assert_eq!(expiry_from_jwt(&jwt), Some(1_789_283_226_000));
    }

    #[test]
    fn a_token_with_no_claims_has_no_expiry() {
        assert_eq!(expiry_from_jwt("not-a-jwt"), None);
    }

    /// The async twin exists because the grant waits for a HUMAN, and a wait
    /// that long must not run where the window's own work runs. It must make
    /// the SAME decision as the sync one, or a fresh token would be thrown away
    /// (or a dead one used) depending on which path the caller took.
    #[test]
    fn the_async_wait_reuses_a_stored_token_and_never_opens_a_grant_for_it() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let minted = Cell::new(0);
        let result = runtime.block_on(ensure_fresh_token_async(
            Some(token(10_000_000)),
            1_000,
            |_: String| async { unreachable!() },
            || {
                minted.set(minted.get() + 1);
                async { Ok(token(20_000_000)) }
            },
        ));
        assert_eq!(minted.get(), 0);
        assert_eq!(result.unwrap().expires_at_ms, 10_000_000);
    }

    #[test]
    fn the_async_wait_opens_a_grant_when_the_stored_token_is_worthless() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let result = runtime.block_on(ensure_fresh_token_async(
            None,
            1_000,
            |_: String| async { unreachable!() },
            || async { Ok(token(20_000_000)) },
        ));
        assert_eq!(result.unwrap().expires_at_ms, 20_000_000);
    }

    /// Both paths ask the same question, in one place.
    #[test]
    fn the_two_paths_share_one_refresh_decision() {
        assert!(usable_token(Some(token(10_000_000)), 1_000).is_some());
        assert!(usable_token(Some(token(10_000_000)), 10_000_000 - REFRESH_MARGIN_MS).is_none());
        assert!(usable_token(None, 1_000).is_none());
    }

    /// THE DEFECT THIS PINS: the grant polled once, right after initiate, so a
    /// human who had not yet clicked anything (every human) got NotApproved,
    /// and the code panel could never be approved from the app at all.
    #[test]
    fn an_unapproved_grant_inside_its_window_is_waited_on_rather_than_refused() {
        assert_eq!(poll_step(false, 1_000, 900_000), PollStep::WaitAgain);
    }

    #[test]
    fn an_unapproved_grant_past_its_expiry_gives_up() {
        assert_eq!(poll_step(false, 900_000, 900_000), PollStep::Expired);
        assert_eq!(poll_step(false, 900_001, 900_000), PollStep::Expired);
    }

    #[test]
    fn a_minted_token_ends_the_wait_even_on_the_last_poll_of_the_window() {
        assert_eq!(poll_step(true, 900_001, 900_000), PollStep::Minted);
    }

    /// The poll route refuses more than one poll per second per device code, so
    /// an interval the server understates would spend the window being rate
    /// limited instead of polling.
    #[test]
    fn the_poll_interval_is_never_faster_than_the_server_will_answer() {
        let raw: u64 = 1;
        assert_eq!(raw.max(MIN_POLL_INTERVAL_SECS), MIN_POLL_INTERVAL_SECS);
        assert_eq!(
            DEFAULT_POLL_INTERVAL_SECS.max(MIN_POLL_INTERVAL_SECS),
            DEFAULT_POLL_INTERVAL_SECS
        );
    }

    /// The other direction, which nothing bounded: the address is typed by the
    /// user, so a server answering `interval: 86400, expiresIn: 10^9` left the
    /// window waiting forever with a code on screen.
    #[test]
    fn the_poll_interval_and_the_window_are_capped_as_well_as_floored() {
        assert_eq!(bounded_poll_interval(86_400), MAX_POLL_INTERVAL_SECS);
        assert_eq!(bounded_poll_interval(1), MIN_POLL_INTERVAL_SECS);
        assert_eq!(
            bounded_poll_interval(DEFAULT_POLL_INTERVAL_SECS),
            DEFAULT_POLL_INTERVAL_SECS
        );
        assert!(MAX_POLL_INTERVAL_SECS <= 10);

        assert_eq!(bounded_grant_expiry(1_000_000_000), MAX_GRANT_EXPIRY_SECS);
        assert_eq!(bounded_grant_expiry(60), 60);
        assert_eq!(bounded_grant_expiry(0), 1);
        assert!(MAX_GRANT_EXPIRY_SECS <= 15 * 60);
    }

    /// P6d-FX7 (SK-7): the dialog's Cancel released nothing, so the pending
    /// code stayed approvable for its whole window. There is now a wait to end
    /// and a code to kill, and both halves are here: the URL the cancel goes
    /// to, escaped like the poll's, and the slot the loop reads between polls.
    #[test]
    fn the_cancel_url_escapes_every_value_it_carries() {
        let config = DeviceGrantConfig {
            base_url: "http://box:3000".into(),
            client_id: "cli&x=1".into(),
            agent_id: "agent-1".into(),
        };
        assert_eq!(
            cancel_url(&config, "code&client_id=attacker"),
            "http://box:3000/mcp/device/code%26client_id%3Dattacker?client_id=cli%26x%3D1"
        );
    }

    #[test]
    fn a_cancelled_grant_stops_the_wait_and_is_handed_over_once() {
        let config = DeviceGrantConfig {
            base_url: "http://box:3000".into(),
            client_id: "liaison-desktop".into(),
            agent_id: "agent-1".into(),
        };
        forget_pending_grant();
        assert!(!still_waiting_for("code-1"), "no grant, nothing waited on");

        remember_pending_grant(PendingGrant {
            config: config.clone(),
            device_code: "code-1".into(),
        });
        assert!(still_waiting_for("code-1"));
        // Another code is not this window's wait, whatever a page claims.
        assert!(!still_waiting_for("code-2"));

        let taken = take_pending_grant().expect("the grant was there to cancel");
        assert_eq!(taken.device_code, "code-1");
        assert_eq!(taken.config, config);
        // The loop's own question, answered: the wait is over.
        assert!(!still_waiting_for("code-1"));
        // And a second cancel has nothing to release, so it tells no server a
        // code is dead twice.
        assert_eq!(take_pending_grant(), None);
    }

    #[test]
    fn the_poll_url_escapes_every_value_it_carries() {
        let config = DeviceGrantConfig {
            base_url: "http://box:3000".into(),
            client_id: "cli&x=1".into(),
            agent_id: "agent=2&admin".into(),
        };
        assert_eq!(
            poll_url(&config, "code&client_id=attacker"),
            "http://box:3000/mcp/device/poll/code%26client_id%3Dattacker\
             ?client_id=cli%26x%3D1&agent_id=agent%3D2%26admin"
        );
    }

    /// The grant is only proven against a real Liaison server: the agent id
    /// has to be stated at initiate AND again at poll, and the token that
    /// comes back has to be bound to that agent. Runs when a box is named.
    #[test]
    #[ignore = "needs LIAISON_BASE_URL, LIAISON_AGENT_ID and LIAISON_SESSION_TOKEN, run with --ignored"]
    fn device_grant_mints_an_agent_bound_token_against_a_live_box() {
        let (Ok(base_url), Ok(agent_id), Ok(session)) = (
            std::env::var("LIAISON_BASE_URL"),
            std::env::var("LIAISON_AGENT_ID"),
            std::env::var("LIAISON_SESSION_TOKEN"),
        ) else {
            eprintln!("no live box configured, skipping the device grant drive");
            return;
        };
        let config = DeviceGrantConfig {
            base_url,
            client_id: "mcp-cli".into(),
            agent_id: agent_id.clone(),
        };
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let started = initiate(&config).await.unwrap();
            assert!(started.verification_uri.contains("code="));
            assert!(started.expires_in_secs > 0);
            assert!(started.interval_secs >= MIN_POLL_INTERVAL_SECS);
            let device_code = started.device_code.clone();

            // The human half of the grant, driven here with the QA admin's own
            // session so the test is unattended.
            let user_code = started.verification_uri.split("code=").nth(1).unwrap().to_string();
            let approved = reqwest::Client::new()
                .post(format!(
                    "{}/api/auth/device-flow/approve/{}",
                    config.base_url, user_code
                ))
                .header("authorization", format!("Bearer {session}"))
                // Agent-bound, so not a full-access grant; the confirmation
                // would only be required (and is harmless) for an unbound one.
                .json(&serde_json::json!({ "confirmFullAccess": true }))
                .send()
                .await
                .unwrap();
            assert!(approved.status().is_success());

            let minted = poll_once(&config, &device_code).await.unwrap().unwrap();
            assert!(minted.expires_at_ms > now_ms());

            // Bound to the agent that was named, not to the user at large.
            let payload = minted.token.split('.').nth(1).unwrap();
            let claims: serde_json::Value =
                serde_json::from_slice(&base64url_decode(payload).unwrap()).unwrap();
            assert_eq!(claims.get("agentId").unwrap().as_str().unwrap(), agent_id);
            assert!(claims.get("grantorUserId").is_some());
        });
    }
}
