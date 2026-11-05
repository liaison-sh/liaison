// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Google Ads / Merchant Center config resolver. Reads the `google-config`
// credentials connection (MCC login-customer-id, operating customer id,
// Merchant Center id, and a legacy developer token some configs still carry) — the operator-entered strings the
// Google Ads REST API needs on every call but the paired `google` OAuth2
// connection cannot hold (see docs/sdk-gaps.md).
//
// Normalizes BOTH `ctx.connections` shapes (flat sandbox bridge + record SDK
// type) and string-or-object raw values — same dual-shape contract as
// get-client.ts's resolveMetaConnection.

const CONNECTION = "google-config"
// merchantId is OPTIONAL: Google Ads works without a Merchant Center account
// (Shopping/PMax feeds are a separate arm). Merchant read handlers must check
// for an empty merchantId and report not-configured instead of calling out.
// developerToken is OPTIONAL too: Google retired developer tokens on 2026-09-09
// (access levels now belong to the Cloud project of the OAuth client). A config
// that still carries one keeps working: the stored key is read without error and
// dropped here, so it never reaches the client (Google will reject the header in
// a future API version).
const REQUIRED_KEYS = ["loginCustomerId", "customerId"] as const

export interface GoogleConfig {
  loginCustomerId: string // digits only, dashes stripped
  customerId: string // digits only, dashes stripped
  /** Merchant Center account id — NOT a Google Ads customer id, never dash-stripped. Empty when no Merchant Center is configured. */
  merchantId: string
}

interface GoogleCtx {
  connections: unknown
}

export class GoogleConfigError extends Error {
  // Deliberate typed error (docs/conventions.md, error reporting): the
  // numeric `status` makes the kernel's execute-tool layer preserve this
  // message + code in the tool error envelope instead of flattening an
  // untrusted-handler throw to an opaque "Tool execution failed".
  status = 424
  code = "google_not_connected"
  constructor(message: string) {
    super(message)
    this.name = "GoogleConfigError"
  }
}

/** Strip dashes from a Google Ads customer id (e.g. "123-456-7890" -> "1234567890"). */
function stripDashes(raw: string): string {
  return raw.replace(/-/g, "")
}

/** Normalize dual ctx.connections shapes to a single getCredentials fn. */
function resolveGoogleConfigConnection(
  ctx: GoogleCtx,
): (() => Promise<Record<string, string>>) | null {
  const conns = ctx.connections as unknown
  // FLAT shape: { getCredentials(name, id?) } — the sandbox bridge group
  const flat = conns as {
    getCredentials?: (name: string, identifier?: string) => Promise<unknown>
  }
  if (typeof flat.getCredentials === "function") {
    return async () => {
      const raw = await flat.getCredentials!(CONNECTION)
      return (typeof raw === "string" ? JSON.parse(raw) : (raw ?? {})) as Record<string, string>
    }
  }
  // RECORD shape: { "google-config": { getCredentials() } } — the SDK type / unit-test mock
  const record = conns as Record<
    string,
    { getCredentials?: (identifier?: string) => Promise<unknown> } | undefined
  >
  const cfg = record?.[CONNECTION]
  if (cfg && typeof cfg.getCredentials === "function") {
    return async () => {
      const raw = await cfg.getCredentials!()
      return (typeof raw === "string" ? JSON.parse(raw) : (raw ?? {})) as Record<string, string>
    }
  }
  return null
}

/** Resolve the Google Ads / Merchant Center config from ctx.connections. */
export async function getGoogleConfig(ctx: GoogleCtx): Promise<GoogleConfig> {
  const accessor = resolveGoogleConfigConnection(ctx)
  if (!accessor) {
    throw new GoogleConfigError(
      "Google not configured: enter the manager (login) customer id, the ad account's customer id and, optionally, the Merchant Center id in the Google Ads API settings connection",
    )
  }

  let map: Record<string, string>
  try {
    map = await accessor()
  } catch (e) {
    throw new GoogleConfigError(
      `Google Ads config could not be read: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  if (!map || Object.keys(map).length === 0) {
    throw new GoogleConfigError("Google not configured: the Google Ads config is empty")
  }

  const missing = REQUIRED_KEYS.filter((k) => !map[k])
  if (missing.length > 0) {
    throw new GoogleConfigError(
      `Google Ads config incomplete, missing: ${missing.join(", ")}`,
    )
  }

  return {
    loginCustomerId: stripDashes(map.loginCustomerId!),
    customerId: stripDashes(map.customerId!),
    merchantId: map.merchantId ?? "",
  }
}

// ─── google OAuth2 token resolver ──────────────────────────────────────────────

const OAUTH_CONNECTION = "google"

/**
 * Resolve the `google` OAuth2 connection's access token. Mirrors
 * bundled-apps/social/src/connection.ts's resolveAccessToken — same dual
 * shape (FLAT `{ getToken(name, identifier?) }` sandbox bridge vs RECORD
 * `{ google: { getToken(identifier?) } }` SDK/unit-test mock).
 *
 * Returns `null` when no live token can be obtained (never connected, or the
 * host throws "No connected account" / "No access token stored") — callers
 * turn that into an actionable GoogleConfigError rather than an
 * unauthenticated call.
 */
export async function getGoogleToken(ctx: GoogleCtx): Promise<string | null> {
  return getOauthToken(ctx, OAUTH_CONNECTION)
}

async function getOauthToken(ctx: GoogleCtx, connectionName: string): Promise<string | null> {
  const conns = ctx.connections as unknown
  const flat = conns as {
    getToken?: (name: string, identifier?: string) => Promise<string>
  }
  let token: string | undefined
  try {
    if (typeof flat.getToken === "function") {
      token = await flat.getToken(connectionName)
    } else {
      const record = conns as Record<string, { getToken?: (identifier?: string) => Promise<string> } | undefined>
      const entry = record?.[connectionName]
      if (entry && typeof entry.getToken === "function") {
        token = await entry.getToken()
      }
    }
  } catch {
    return null
  }
  return token && token.length > 0 ? token : null
}

/**
 * Resolve the token for MERCHANT CENTER calls. Prefers the dedicated,
 * OPTIONAL `merchant` OAuth2 connection (for orgs whose Merchant Center
 * lives on a DIFFERENT Google account than Google Ads — e.g. while a
 * People-and-access invitation is stuck), and falls back to the main
 * `google` connection so single-account orgs consent exactly once.
 */
export async function getMerchantToken(ctx: GoogleCtx): Promise<string | null> {
  const dedicated = await getOauthToken(ctx, "merchant")
  if (dedicated) return dedicated
  return getOauthToken(ctx, OAUTH_CONNECTION)
}

/**
 * Resolve the merchant-call token + google-config credentials. Same throw
 * contract as getGoogleClient; the token may come from the dedicated
 * `merchant` connection (see getMerchantToken).
 */
export async function getMerchantClient(
  ctx: GoogleCtx,
): Promise<{ token: string; config: GoogleConfig }> {
  const token = await getMerchantToken(ctx)
  if (!token) {
    throw new GoogleConfigError(
      "Google not connected: connect the Google account (adwords + content scopes) in app settings",
    )
  }
  const config = await getGoogleConfig(ctx)
  return { token, config }
}

/**
 * Resolve BOTH the google OAuth2 token AND the google-config credentials in
 * one call — the shape every Google Ads / Merchant handler needs. Throws the
 * SAME GoogleConfigError for either a missing token or missing config, since
 * from the agent's perspective both mean "Google is not usable yet."
 */
export async function getGoogleClient(
  ctx: GoogleCtx,
): Promise<{ token: string; config: GoogleConfig }> {
  const token = await getGoogleToken(ctx)
  if (!token) {
    throw new GoogleConfigError(
      "Google not connected: connect the Google account (adwords + content scopes) in app settings",
    )
  }
  const config = await getGoogleConfig(ctx)
  return { token, config }
}

/**
 * Same contract as withMetaConnectionEnvelope (lib/get-client.ts): a google
 * tool answers "not connected" as a structured envelope, never as a throw the
 * tool route turns into HTTP 500. google_insights_query, google_account_info
 * and the merchant reads already build this envelope inline, so wrapping them
 * again is a no-op.
 */
export function withGoogleConnectionEnvelope<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R | { error: { code: string; message: string } }> {
  return async (...args: Args) => {
    try {
      return await fn(...args)
    } catch (err) {
      if (err instanceof GoogleConfigError) {
        return { error: { code: "google_not_connected", message: err.message } }
      }
      throw err
    }
  }
}
