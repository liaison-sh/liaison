// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Google Ads / Merchant Center config resolver. Reads the `google-config`
// credentials connection (MCC login-customer-id, operating customer id,
// Merchant Center id, and a legacy developer token some configs still carry) — the operator-entered strings the
// Google Ads REST API needs on every call but the paired `google` OAuth2
// connection cannot hold (see docs/sdk-gaps.md).
//
// Reads the connection's READABLE settings only (`getSettings`, both
// `ctx.connections` shapes): the ids are not secrets, and the OAuth token goes
// to Google host-side (`ctx.fetch` auth), never through this app.

import { readConnectionSettings } from "@liaison/app-sdk/connection-credentials"

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

/** Resolve the Google Ads / Merchant Center config from ctx.connections (its readable settings). */
export async function getGoogleConfig(ctx: GoogleCtx): Promise<GoogleConfig> {
  const read = await readConnectionSettings(ctx.connections, CONNECTION, REQUIRED_KEYS)
  if (!read.ok) {
    switch (read.reason) {
      case "not_connected":
        throw new GoogleConfigError(
          "Google not configured: enter the manager (login) customer id, the ad account's customer id and, optionally, the Merchant Center id in the Google Ads API settings connection",
        )
      case "unreadable":
        throw new GoogleConfigError(
          "Google Ads config could not be read: reconnect it in app settings",
        )
      case "empty":
        throw new GoogleConfigError("Google not configured: the Google Ads config is empty")
      case "incomplete":
        throw new GoogleConfigError(
          `Google Ads config incomplete, missing: ${read.missing.join(", ")}`,
        )
    }
  }
  const map = read.values
  return {
    loginCustomerId: stripDashes(map.loginCustomerId ?? ""),
    customerId: stripDashes(map.customerId ?? ""),
    merchantId: map.merchantId ?? "",
  }
}

// ─── google OAuth2 credential ─────────────────────────────────────────────────

const OAUTH_CONNECTION = "google"

/**
 * `ctx.fetch` auth for an OAuth2 connection: the host adds its access token
 * (refreshed host-side) as `Authorization: Bearer`, so the token never enters
 * the app.
 */
export interface GoogleAuth {
  connection: string
  scheme: "bearer"
}

/**
 * The credential of the `google` OAuth2 connection, or `null` when it has no
 * active account (`getAccounts`, both `ctx.connections` shapes) — callers turn
 * that into an actionable GoogleConfigError rather than an unauthenticated
 * call. A token Google refuses later answers that call with its own 401.
 */
export async function getGoogleAuth(ctx: GoogleCtx): Promise<GoogleAuth | null> {
  return connectedAuth(ctx, OAUTH_CONNECTION)
}

async function connectedAuth(ctx: GoogleCtx, connectionName: string): Promise<GoogleAuth | null> {
  const conns = ctx.connections as unknown
  const flat = conns as { getAccounts?: (name: string) => Promise<unknown> }
  let raw: unknown
  try {
    if (typeof flat.getAccounts === "function") {
      raw = await flat.getAccounts(connectionName)
    } else {
      const entry = (
        conns as Record<string, { getAccounts?: () => Promise<unknown> } | undefined>
      )?.[connectionName]
      if (!entry || typeof entry.getAccounts !== "function") return null
      raw = await entry.getAccounts()
    }
  } catch {
    return null
  }
  const accounts = (typeof raw === "string" ? JSON.parse(raw) : raw) as unknown[] | null
  return Array.isArray(accounts) && accounts.length > 0
    ? { connection: connectionName, scheme: "bearer" }
    : null
}

/**
 * The credential for MERCHANT CENTER calls. Prefers the dedicated, OPTIONAL
 * `merchant` OAuth2 connection (for orgs whose Merchant Center lives on a
 * DIFFERENT Google account than Google Ads — e.g. while a People-and-access
 * invitation is stuck), and falls back to the main `google` connection so
 * single-account orgs consent exactly once.
 */
export async function getMerchantAuth(ctx: GoogleCtx): Promise<GoogleAuth | null> {
  return (await connectedAuth(ctx, "merchant")) ?? connectedAuth(ctx, OAUTH_CONNECTION)
}

/**
 * Resolve the merchant-call credential + google-config settings. Same throw
 * contract as getGoogleClient; the credential may be the dedicated `merchant`
 * connection's (see getMerchantAuth).
 */
export async function getMerchantClient(
  ctx: GoogleCtx,
): Promise<{ auth: GoogleAuth; config: GoogleConfig }> {
  const auth = await getMerchantAuth(ctx)
  if (!auth) {
    throw new GoogleConfigError(
      "Google not connected: connect the Google account (adwords + content scopes) in app settings",
    )
  }
  const config = await getGoogleConfig(ctx)
  return { auth, config }
}

/**
 * Resolve BOTH the google OAuth2 credential AND the google-config settings in
 * one call — the shape every Google Ads / Merchant handler needs. Throws the
 * SAME GoogleConfigError for either a missing account or missing config, since
 * from the agent's perspective both mean "Google is not usable yet."
 */
export async function getGoogleClient(
  ctx: GoogleCtx,
): Promise<{ auth: GoogleAuth; config: GoogleConfig }> {
  const auth = await getGoogleAuth(ctx)
  if (!auth) {
    throw new GoogleConfigError(
      "Google not connected: connect the Google account (adwords + content scopes) in app settings",
    )
  }
  const config = await getGoogleConfig(ctx)
  return { auth, config }
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
