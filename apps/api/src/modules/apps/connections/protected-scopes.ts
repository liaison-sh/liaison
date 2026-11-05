// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Protected scopes: OAuth scopes a provider grants only after it has approved the
 * app for them (Shopify's `read_all_orders`). A connection declares them in its
 * manifest as `protectedScopes: [{ scope, setting }]`, never in `scopes`:
 *
 * - the generated provider app configuration (shopify.app.toml) lists one only once
 *   the org turned on `setting` (`loadOptedInScopes`), since the provider refuses a
 *   release naming a scope the app is not approved for; under Shopify-managed
 *   installation the store gets only the scopes of the released configuration, so
 *   the file is generated again and released once the setting is on;
 * - the authorize request asks for one only when the org turned on `setting` (a
 *   toggle in the app's org settings) or the account being re-authorized already
 *   holds it, so a reconnect never drops a scope the account has;
 * - connection health always flags a grant without one, saying to request it from
 *   the provider, turn on `setting`, add it to the app's configuration when the
 *   provider grants that configuration (`scopesFromAppConfiguration`), and reconnect.
 */
import { and, eq } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { connectedAccounts } from "~/db/schema/kernel"
import { readOrgAppNamespace, settingAtPath } from "~/lib/settings"

export interface ProtectedScope {
  /** The provider scope. */
  scope: string
  /** The org settings key (dot path) of the app's toggle that opts in. */
  setting: string
}

/** The declared protected scopes of a connection config (empty when none). */
export function protectedScopesOf(connConfig: { protectedScopes?: ProtectedScope[] } | undefined) {
  return connConfig?.protectedScopes ?? []
}

/** The protected scopes whose opt-in setting is on in the app's org settings namespace. */
export function optedInScopes(
  declared: readonly ProtectedScope[],
  namespace: Record<string, unknown>,
): string[] {
  return declared
    .filter((p) => settingAtPath(namespace, p.setting.split(".")) === true)
    .map((p) => p.scope)
}

/** The protected scopes the org opted in to, read from its settings of `appName`. */
export async function loadOptedInScopes(
  tx: PrivilegedDb,
  orgId: string,
  appName: string,
  declared: readonly ProtectedScope[],
): Promise<string[]> {
  if (declared.length === 0) return []
  return optedInScopes(declared, await readOrgAppNamespace(tx, orgId, appName))
}

/**
 * The scopes an authorize request asks for: the base scopes, plus each protected
 * scope that is opted in or that the existing grant holds. `existingGrant` is the
 * recorded grant of the account being re-authorized: `null` when there is no such
 * account, `"unknown"` when it exists but its grant was never recorded (a
 * connection older than grant tracking). An unknown grant keeps every protected
 * scope: the account may hold it, and a reconnect must never drop a scope.
 */
export function authorizeScopes(
  base: readonly string[],
  declared: readonly ProtectedScope[],
  optedIn: readonly string[],
  existingGrant: readonly string[] | "unknown" | null,
): string[] {
  const out = [...base]
  for (const { scope } of declared) {
    if (out.includes(scope)) continue
    const held =
      existingGrant === "unknown" || (existingGrant !== null && existingGrant.includes(scope))
    if (held || optedIn.includes(scope)) out.push(scope)
  }
  return out
}

/** The recorded grant of a connected account's metadata, `"unknown"` when none was recorded. */
export function recordedGrant(metadata: unknown): string[] | "unknown" {
  const granted =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).grantedOAuthScopes
      : undefined
  if (!Array.isArray(granted) || granted.length === 0) return "unknown"
  return granted.filter((s): s is string => typeof s === "string")
}

/**
 * The recorded grant of the account an OAuth start re-authorizes: the latest row
 * of this connection for `identifier` when the connection names its accounts by a
 * template variable (Shopify: the store), otherwise the latest row of the same
 * owner. `null` when there is none.
 */
export async function existingAccountGrant(
  tx: PrivilegedDb,
  where: {
    orgId: string
    appName: string
    connectionName: string
    identifier?: string
    ownerType: "user" | "org"
    ownerId: string | null
  },
): Promise<string[] | "unknown" | null> {
  const rows = await tx
    .select({
      metadata: connectedAccounts.metadata,
      updatedAt: connectedAccounts.updatedAt,
      ownerType: connectedAccounts.ownerType,
      ownerId: connectedAccounts.ownerId,
      identifier: connectedAccounts.identifier,
    })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.orgId, where.orgId),
        eq(connectedAccounts.appName, where.appName),
        eq(connectedAccounts.connectionName, where.connectionName),
      ),
    )
  const matching = rows.filter((r) =>
    where.identifier !== undefined
      ? r.identifier === where.identifier
      : r.ownerType === where.ownerType && (r.ownerId ?? null) === where.ownerId,
  )
  if (matching.length === 0) return null
  const latest = matching.reduce((a, b) => (b.updatedAt.getTime() > a.updatedAt.getTime() ? b : a))
  return recordedGrant(latest.metadata)
}
