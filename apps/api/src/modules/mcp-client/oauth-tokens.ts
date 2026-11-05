// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Token requests for MCP OAuth connections: the authorization-code exchange
// (the sign-in callback) and the refresh. Both go through the SDK v1
// building blocks (`exchangeAuthorization`, `refreshAuthorization`) with
// `oauthFetch` injected, the client authenticated the way it was registered,
// and `resource` (RFC 8707) sent verbatim on every request.
//
// The refresh is single-flight ACROSS processes (S27, A15): it holds a
// transaction-scoped advisory lock on the connection for the whole POST and
// re-reads the row under it. Rotating refresh tokens (Notion rotates on every
// refresh) are good for one use, so a second process replaying the old one
// would be refused and lose the sign-in; under the lock it finds the token
// already replaced and adopts it instead. The rotated pair is written in the
// same transaction. Only a refused refresh means "sign in again"; a token
// endpoint that is down is retried with backoff and reported as transient.

import { refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  OAuthClientInformationFull,
  OAuthMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { eq } from "drizzle-orm"
import type { ConnectionRow } from "~/apps/mcp-manager/types"
import { advisoryXactLock } from "~/db/advisory-lock"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { mcpConnections } from "~/db/schema/app_mcp_manager"
import { rootLogger } from "~/lib/logger"
import type { OAuthRefreshResult, RefreshFailureKind } from "./call"
import { tokenFingerprint } from "./credentials"
import { oauthFetch, UnsafeOAuthUrlError } from "./oauth-fetch"
import {
  decryptSecretsBlob,
  encryptSecretsBlob,
  type McpOAuthMetadata,
  type McpSecretsBlob,
  metadataOf,
} from "./secrets"

const log = rootLogger.child({ module: "mcp-client/oauth-tokens" })

/**
 * The AS metadata a token request needs, rebuilt from what the connection
 * stored at sign-in (the token endpoint the tokens came from — refresh tokens
 * only ever go back to it). `token_endpoint_auth_methods_supported` is left
 * out on purpose: the client's own stored method then decides.
 */
export function tokenRequestMetadata(meta: McpOAuthMetadata): OAuthMetadata {
  const tokenEndpoint = meta.tokenEndpoint ?? ""
  return {
    issuer: meta.issuer ?? new URL(tokenEndpoint).origin,
    authorization_endpoint: meta.authorizationEndpoint ?? tokenEndpoint,
    token_endpoint: tokenEndpoint,
    response_types_supported: ["code"],
  }
}

/** The client as the token endpoint knows it, with its registered auth method. */
export function clientInformationFor(
  meta: McpOAuthMetadata,
  secrets: McpSecretsBlob,
): OAuthClientInformationFull {
  const secret = secrets.oauthClientSecret
  return {
    client_id: meta.clientId ?? "",
    redirect_uris: [],
    ...(secret ? { client_secret: secret } : {}),
    // Connections signed in before the method was recorded sent the secret
    // in the form body; keep doing that for them.
    token_endpoint_auth_method:
      meta.tokenEndpointAuthMethod ?? (secret ? "client_secret_post" : "none"),
  }
}

/** The AS URL for the SDK calls (only used when metadata lacks an endpoint). */
export function authorizationServerUrlOf(meta: McpOAuthMetadata): string {
  return meta.authorizationServerUrl ?? meta.issuer ?? new URL(meta.tokenEndpoint ?? "").origin
}

/**
 * `oauthFetch`, remembering the last response's status and JSON body: the SDK
 * strips fields it does not model (`sub`) and an OAuth error loses its HTTP
 * status, both of which Liaison needs.
 */
export function recordingOAuthFetch() {
  const last: { status: number; body: Record<string, unknown> | null } = { status: 0, body: null }
  const fetchFn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    last.status = 0
    last.body = null
    const res = await oauthFetch(url, init)
    last.status = res.status
    try {
      const parsed: unknown = await res.clone().json()
      last.body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
    } catch {
      last.body = null
    }
    return res
  }
  return { fetchFn, last }
}

/** The token fields Liaison persists from a token response. */
export function persistedTokenFields(
  tokens: OAuthTokens,
  previousRefreshToken: string | null | undefined,
  now = Date.now(),
): { accessToken: string; refreshToken: string | null; expiresAt?: string; scope?: string } {
  return {
    accessToken: tokens.access_token,
    // A refresh that returns no new refresh token keeps the old one.
    refreshToken: tokens.refresh_token ?? previousRefreshToken ?? null,
    ...(typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)
      ? { expiresAt: new Date(now + tokens.expires_in * 1000).toISOString() }
      : {}),
    ...(tokens.scope ? { scope: tokens.scope } : {}),
  }
}

// ── Refresh ────────────────────────────────────────────────────────────────

const DEFAULT_BACKOFF_MS = [500, 2000]

export interface TokenRefresher {
  /**
   * Refresh the connection's access token. `seenTokenFingerprint` names the
   * token the caller holds: when the stored one already differs, another
   * caller refreshed meanwhile and it is adopted without a POST.
   */
  refresh(
    connectionId: string,
    opts?: { seenTokenFingerprint?: string | null },
  ): Promise<OAuthRefreshResult>
}

type Attempt =
  | { ok: true; row: ConnectionRow }
  | { ok: false; kind: RefreshFailureKind; reason: string }

function classify(err: unknown, status: number): { kind: RefreshFailureKind; reason: string } {
  const message = (err as Error)?.message ?? String(err)
  if (err instanceof UnsafeOAuthUrlError) {
    return { kind: "config", reason: `unsafe token endpoint: ${message}` }
  }
  const oauthCode = (err as { errorCode?: unknown }).errorCode
  if (oauthCode === "invalid_grant" || status === 400 || status === 401) {
    return {
      kind: "invalid_grant",
      reason: `refresh refused${status ? ` (HTTP ${status})` : ""}: ${typeof oauthCode === "string" && oauthCode !== "server_error" ? oauthCode : message}`,
    }
  }
  // Network failures, timeouts, 5xx, 429 and anything else: try again later.
  return { kind: "transient", reason: `${status ? `HTTP ${status}: ` : ""}${message}` }
}

/**
 * One refresh attempt under the connection's lock;
 * `makeTokenRefresher` adds the in-process single flight and the backoff.
 */
async function attemptRefresh(
  connectionId: string,
  orgId: string,
  seen: string | null | undefined,
): Promise<Attempt> {
  return withPrivilegedDb(
    orgId,
    "mcp-oauth-refresh",
    async (db) => {
      await db.execute(advisoryXactLock(`mcp-oauth-refresh:${connectionId}`))
      const [row] = await db
        .select()
        .from(mcpConnections)
        .where(eq(mcpConnections.id, connectionId))
      if (!row) return { ok: false, kind: "config", reason: "connection_not_found" }
      const blob = decryptSecretsBlob(row.secretsEncrypted)
      const meta = metadataOf(row.oauthMetadata)
      const current = blob.accessToken
      if (seen !== undefined && current && tokenFingerprint(current) !== seen) {
        // Another process (or an earlier caller) refreshed while we waited.
        return { ok: true, row }
      }
      if (!blob.refreshToken) {
        return { ok: false, kind: "invalid_grant", reason: "no refresh token: sign in again" }
      }
      if (!meta.tokenEndpoint || !meta.clientId) {
        return { ok: false, kind: "config", reason: "missing token endpoint or client id" }
      }
      const recording = recordingOAuthFetch()
      let fields: ReturnType<typeof persistedTokenFields>
      try {
        const tokens = await refreshAuthorization(authorizationServerUrlOf(meta), {
          metadata: tokenRequestMetadata(meta),
          clientInformation: clientInformationFor(meta, blob),
          refreshToken: blob.refreshToken,
          ...(meta.resource ? { resource: meta.resource } : {}),
          fetchFn: recording.fetchFn,
        })
        fields = persistedTokenFields(tokens, blob.refreshToken)
      } catch (err) {
        const failure = classify(err, recording.last.status)
        log.warn(
          { connectionId, kind: failure.kind, status: recording.last.status },
          `MCP OAuth refresh failed: ${failure.reason}`,
        )
        return { ok: false, ...failure }
      }
      const newBlob: McpSecretsBlob = {
        ...blob,
        accessToken: fields.accessToken,
        refreshToken: fields.refreshToken,
      }
      const newMeta: McpOAuthMetadata = {
        ...meta,
        expiresAt: fields.expiresAt,
        scope: fields.scope ?? meta.scope,
      }
      const [updated] = await db
        .update(mcpConnections)
        .set({
          secretsEncrypted: encryptSecretsBlob(newBlob),
          oauthMetadata: newMeta as Record<string, unknown>,
          updatedAt: new Date(),
        })
        .where(eq(mcpConnections.id, connectionId))
        .returning()
      return { ok: true, row: updated ?? row }
    },
    // The lock is held across the token POST: keep it off the privileged pool,
    // whose slots serve short reads nested in interactive transactions.
    { pool: "jobs" },
  )
}

export function makeTokenRefresher(
  opts: {
    backoffMs?: number[]
    /** The row after a successful refresh (or adoption): update caches. */
    onRefreshed?: (row: ConnectionRow) => void
  } = {},
): TokenRefresher {
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS
  const inflight = new Map<string, Promise<OAuthRefreshResult>>()

  async function run(
    connectionId: string,
    seen: string | null | undefined,
  ): Promise<OAuthRefreshResult> {
    const [head] = await withSystemDb("mcp-oauth-refresh-load", (db) =>
      db
        .select({ orgId: mcpConnections.orgId, authFlavor: mcpConnections.authFlavor })
        .from(mcpConnections)
        .where(eq(mcpConnections.id, connectionId)),
    )
    if (!head) return { ok: false, kind: "config", reason: "connection_not_found" }
    if (head.authFlavor !== "oauth_dcr" && head.authFlavor !== "oauth_static") {
      return { ok: false, kind: "not_oauth", reason: "the server refused the connection's token" }
    }
    let last: Attempt = { ok: false, kind: "transient", reason: "not attempted" }
    for (let i = 0; i <= backoff.length; i++) {
      last = await attemptRefresh(connectionId, head.orgId, seen)
      if (last.ok) {
        opts.onRefreshed?.(last.row)
        return { ok: true }
      }
      if (last.kind !== "transient") return last
      if (i < backoff.length) await new Promise((r) => setTimeout(r, backoff[i]))
    }
    return last
  }

  return {
    refresh(connectionId, refreshOpts = {}) {
      // In-process single flight; the advisory lock covers other processes.
      const existing = inflight.get(connectionId)
      if (existing) return existing
      const p = run(connectionId, refreshOpts.seenTokenFingerprint).finally(() => {
        inflight.delete(connectionId)
      })
      inflight.set(connectionId, p)
      return p
    },
  }
}
