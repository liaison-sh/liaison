// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Provider-side grant revocation for OAuth2 connections.
//
// Disconnecting a connection (or erasing the user who owns it) must not leave a
// live grant at the provider: the stored tokens are deleted, and before that the
// provider is told to revoke them (RFC 7009 token revocation). A connection
// declares where with `revocationUrl` in its manifest; Google is
// `https://oauth2.googleapis.com/revoke`. A connection that declares none is not
// revoked (its tokens are still deleted).
//
// Revocation is best effort: a provider that is down, slow or answers an error
// never blocks the disconnect. The outcome is logged and returned.
//
// One grant, several connections: a provider such as Google keeps ONE grant per
// (user, OAuth client), and revoking any token of it revokes all of it. Mail,
// Tickets, Calendar and Drive connect the same Google account through the same
// client, so revoking on a Mail disconnect would silently cut the Calendar
// connection of the same address. `isGrantUsedElsewhere` finds those: while another
// active connection on this instance (any org) holds the same account at the same
// revocation endpoint, the grant is left in place (its own disconnect revokes
// it later).

import { and, sql as drizzleSql, eq, ne } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { connectedAccounts } from "~/db/schema/kernel"
import type { DurableEventContext } from "~/infra/events/durable-consumers"
import { registerDurableEventConsumer } from "~/infra/events/durable-consumers"
import { CryptoContext, decryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { appsLogger as log } from "~/lib/logger"
import { fetchWithRedirectValidation } from "~/lib/outbound-fetch"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"

const REVOKE_TIMEOUT_MS = 5_000

/** The columns revocation needs from a `kernel.connected_accounts` row. */
export interface RevocableConnection {
  id: string
  orgId: string
  appName: string
  connectionName: string
  providerType: string
  identifier: string
  accessTokenEncrypted: string | null
  refreshTokenEncrypted: string | null
}

export type RevokeOutcome =
  | { status: "revoked" }
  /** The provider says the token is already invalid (revoked or expired). */
  | { status: "already_invalid" }
  | {
      status: "skipped"
      reason: "not_oauth" | "no_revocation_url" | "no_token" | "grant_shared"
    }
  | { status: "failed"; reason: string }

/** The revocation endpoint a connection declares, or null. */
export function revocationUrlFor(
  orgId: string,
  appName: string,
  connectionName: string,
): string | null {
  const config = connectionConfigRegistry.get([orgId, appName, connectionName])
  return config?.revocationUrl ?? null
}

/**
 * Whether another ACTIVE OAuth2 connection, in ANY org of this instance, holds the
 * same provider account (identifier, case-insensitive) at the same revocation
 * endpoint: revoking would cut it too. `excludeIds` are the rows being disconnected
 * or deleted. A system read across orgs, so it answers only a boolean: no other
 * org's row, id or app leaves this function.
 *
 * The endpoint of another org's row comes from that org's registered connection
 * config, falling back to this org's config for the same app and connection when
 * that org's apps are not registered in this process (same manifest, same URL).
 */
export async function isGrantUsedElsewhere(
  conn: Pick<RevocableConnection, "orgId" | "identifier" | "appName" | "connectionName">,
  excludeIds: readonly string[],
): Promise<boolean> {
  const url = revocationUrlFor(conn.orgId, conn.appName, conn.connectionName)
  if (!url) return false
  const conditions = [
    eq(connectedAccounts.status, "active"),
    eq(connectedAccounts.providerType, "oauth2"),
    drizzleSql`lower(${connectedAccounts.identifier}) = lower(${conn.identifier})`,
  ]
  for (const id of excludeIds) conditions.push(ne(connectedAccounts.id, id))
  const rows = await withSystemDb("oauth-revoke-grant-in-use", (tx) =>
    tx
      .select({
        orgId: connectedAccounts.orgId,
        appName: connectedAccounts.appName,
        connectionName: connectedAccounts.connectionName,
      })
      .from(connectedAccounts)
      .where(and(...conditions)),
  )
  return rows.some(
    (r) =>
      (revocationUrlFor(r.orgId, r.appName, r.connectionName) ??
        revocationUrlFor(conn.orgId, r.appName, r.connectionName)) === url,
  )
}

function decryptOrNull(value: string | null, context: string): string | null {
  if (!value) return null
  try {
    return decryptSecret(value, process.env.ENCRYPTION_KEY ?? env.ENCRYPTION_KEY, context)
  } catch {
    return null
  }
}

/**
 * Ask the provider to revoke a connection's grant. Sends the refresh token when
 * one is stored (revoking it ends the whole grant, access tokens included), else
 * the access token. Never throws.
 */
export async function revokeConnectionGrant(conn: RevocableConnection): Promise<RevokeOutcome> {
  const logCtx = {
    orgId: conn.orgId,
    appName: conn.appName,
    connectionName: conn.connectionName,
    connectionId: conn.id,
  }
  if (conn.providerType !== "oauth2") return { status: "skipped", reason: "not_oauth" }
  const url = revocationUrlFor(conn.orgId, conn.appName, conn.connectionName)
  if (!url) return { status: "skipped", reason: "no_revocation_url" }

  const refresh = decryptOrNull(
    conn.refreshTokenEncrypted,
    CryptoContext.connectedAccountRefreshToken,
  )
  const access = refresh
    ? null
    : decryptOrNull(conn.accessTokenEncrypted, CryptoContext.connectedAccountAccessToken)
  const token = refresh ?? access
  if (!token) return { status: "skipped", reason: "no_token" }

  let res: Response
  try {
    res = await fetchWithRedirectValidation(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          token,
          token_type_hint: refresh ? "refresh_token" : "access_token",
        }).toString(),
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      },
      { requireHttps: true, allowPrivateHostsInTest: true },
    )
  } catch (err) {
    const reason = (err as Error).message
    log.warn({ ...logCtx, err: reason }, "OAuth grant revocation request failed")
    return { status: "failed", reason }
  }

  if (res.ok) {
    log.info(logCtx, "OAuth grant revoked at the provider")
    return { status: "revoked" }
  }
  const body = await res.text().catch(() => "")
  // RFC 7009 / Google: an already revoked or expired token answers 400
  // `invalid_token` (Google also says `invalid_grant`). The grant is gone either way.
  if (res.status === 400 && /invalid_token|invalid_grant/.test(body)) {
    log.info(logCtx, "OAuth grant was already invalid at the provider")
    return { status: "already_invalid" }
  }
  log.warn(
    { ...logCtx, status: res.status, body: body.slice(0, 256) },
    "OAuth grant revocation refused by the provider",
  )
  return { status: "failed", reason: `HTTP ${res.status}` }
}

/**
 * Revoke unless another active connection still uses the same grant. Never throws.
 */
export async function revokeUnlessShared(
  conn: RevocableConnection,
  excludeIds: readonly string[] = [conn.id],
): Promise<RevokeOutcome> {
  if (conn.providerType !== "oauth2") return { status: "skipped", reason: "not_oauth" }
  if (!revocationUrlFor(conn.orgId, conn.appName, conn.connectionName)) {
    return { status: "skipped", reason: "no_revocation_url" }
  }
  if (!conn.refreshTokenEncrypted && !conn.accessTokenEncrypted) {
    return { status: "skipped", reason: "no_token" }
  }
  let inUse: boolean
  try {
    inUse = await isGrantUsedElsewhere(conn, excludeIds)
  } catch (err) {
    // Unknown: keep the grant rather than risk cutting a connection still in use.
    log.warn(
      { orgId: conn.orgId, connectionId: conn.id, err: (err as Error).message },
      "OAuth grant revocation skipped: could not check for other connections using it",
    )
    return { status: "failed", reason: "sharer_check_failed" }
  }
  if (inUse) {
    log.info(
      {
        orgId: conn.orgId,
        appName: conn.appName,
        connectionName: conn.connectionName,
        connectionId: conn.id,
      },
      "OAuth grant kept: another active connection on this instance uses the same account",
    )
    return { status: "skipped", reason: "grant_shared" }
  }
  return revokeConnectionGrant(conn)
}

// ---------------------------------------------------------------------------
// After commit
// ---------------------------------------------------------------------------
//
// The revocation never runs inside the disconnect transaction: a rolled-back
// disconnect must not leave a live row with a grant Google already revoked, and
// a provider call must not hold a pool connection. `disconnectConnection` stages
// what the revocation needs (the encrypted tokens, the account) in memory and
// deletes the tokens in its transaction; once that commits, the grant is revoked
// by whichever comes first:
//   - the caller that owns the transaction, right after it returns
//     (`revokeStagedGrant`, the same after-commit shape as user erasure);
//   - the `connected_account:disconnect` outbox event, published only on commit
//     (`registerRevokeOnDisconnectConsumer`), for callers that do not own their
//     transaction (an app's sandboxed disconnect tool).
// A rolled-back disconnect publishes no event and its caller never calls in, so
// the staged entry is never used and expires. Best effort: a process restart
// between the commit and the event loses the revocation (logged nowhere, the
// tokens are already deleted, and the user can still revoke at the provider).

const STAGED_TTL_MS = 10 * 60 * 1000
const staged = new Map<string, { conn: RevocableConnection; expiresAt: number }>()

/** Stage a connection's revocation; it runs only once the disconnect has committed. */
export function stageGrantRevocation(conn: RevocableConnection): void {
  const now = Date.now()
  for (const [id, entry] of staged) if (entry.expiresAt <= now) staged.delete(id)
  if (conn.providerType !== "oauth2") return
  if (!conn.refreshTokenEncrypted && !conn.accessTokenEncrypted) return
  if (!revocationUrlFor(conn.orgId, conn.appName, conn.connectionName)) return
  staged.set(conn.id, { conn, expiresAt: now + STAGED_TTL_MS })
}

/**
 * Run a staged revocation once its disconnect has committed. The first caller
 * takes it; later calls (the outbox event after a direct call) find nothing.
 * Never throws.
 */
export async function revokeStagedGrant(connectionId: string): Promise<RevokeOutcome | null> {
  const entry = staged.get(connectionId)
  if (!entry) return null
  staged.delete(connectionId)
  if (entry.expiresAt <= Date.now()) return null
  try {
    return await revokeUnlessShared(entry.conn)
  } catch (err) {
    log.warn(
      { orgId: entry.conn.orgId, connectionId, err: (err as Error).message },
      "OAuth grant revocation failed after disconnect",
    )
    return { status: "failed", reason: (err as Error).message }
  }
}

/** The outbox side: a committed `kernel/connected_account:disconnect` runs its staged revocation. */
export async function revokeOnDisconnectEvent(event: {
  app?: string
  entity?: string
  action?: string
  entityId?: string | null
  ephemeral?: boolean
}): Promise<void> {
  if (event.ephemeral) return
  if (event.app !== "kernel" || event.entity !== "connected_account") return
  if (event.action !== "disconnect" || !event.entityId) return
  await revokeStagedGrant(event.entityId)
}

let consumerRegistered = false

/** Register the outbox consumer. Idempotent; called at boot. */
export function registerRevokeOnDisconnectConsumer(): void {
  if (consumerRegistered) return
  consumerRegistered = true
  registerDurableEventConsumer("oauth-revoke-on-disconnect", async (ctx: DurableEventContext) => {
    await revokeOnDisconnectEvent(ctx.event)
  })
}

export const RevokeTestAccess = {
  clearStaged: () => staged.clear(),
  isStaged: (id: string) => staged.has(id),
}
