// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, eq, inArray } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { roleScopeGrants, userRoles, userScopeGrants, users } from "~/db/schema/kernel"

/**
 * Compute the hierarchical ancestor set that *satisfies* a scope. Granting an
 * ancestor implicitly grants every descendant, so a holder of `kernel`,
 * `kernel:*`, `kernel:scope_requests`, or `*` all satisfy
 * `kernel:scope_requests:admin`. We expand the set in TS (there is no generic
 * hierarchical SQL helper) and feed it to an `IN (...)` clause.
 *
 * For `kernel:scope_requests:admin` →
 *   ['*', 'kernel', 'kernel:*', 'kernel:scope_requests', 'kernel:scope_requests:*',
 *    'kernel:scope_requests:admin']
 * The trailing-`:*` forms mirror `hasScope` (a `<prefix>:*` grant matches children),
 * and the `scope_requests` RLS SELECT/UPDATE policies enumerate the same set, so a
 * holder of any satisfying scope is notified AND can read/decide the row.
 */
export function scopeAncestors(scope: string): string[] {
  const ancestors = new Set<string>(["*", scope])
  const parts = scope.split(":")
  // Every prefix of the scope path, plus a wildcard form of each prefix.
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join(":")
    ancestors.add(prefix)
    if (i < parts.length) ancestors.add(`${prefix}:*`)
  }
  return [...ancestors]
}

/**
 * Default `loadScopeHolders` for the attention translator. Returns the user ids
 * in `orgId` who hold a scope that *hierarchically satisfies* `scope` — via a
 * role grant OR a direct user grant. Runs under `withPrivilegedDb` because it
 * fires in the outbox/translator path, which has no request RLS context, and it
 * is a cross-user lookup. Prefix/ancestor matching is the intended semantics —
 * this also governs the existing Shopify/invoicing `scope_holders` translations.
 */
export async function defaultLoadScopeHolders(
  orgId: string,
  scope: string,
  _dimensionFilter?: Record<string, unknown>,
): Promise<string[]> {
  return withPrivilegedDb(orgId, "attention:scope-holders", (tx: PrivilegedDb) =>
    scopeHoldersInTx(tx, orgId, scope),
  )
}

/** `defaultLoadScopeHolders` inside a privileged transaction the caller holds. */
export async function scopeHoldersInTx(
  tx: PrivilegedDb,
  orgId: string,
  scope: string,
): Promise<string[]> {
  const satisfying = scopeAncestors(scope)
  {
    // Role-granted holders.
    const viaRoles = await tx
      .selectDistinct({ id: users.id })
      .from(users)
      .innerJoin(userRoles, eq(userRoles.userId, users.id))
      .innerJoin(roleScopeGrants, eq(roleScopeGrants.roleId, userRoles.roleId))
      .where(
        and(
          eq(users.orgId, orgId),
          eq(users.status, "active"),
          inArray(roleScopeGrants.scope, satisfying),
        ),
      )

    // Directly-granted holders.
    const viaDirect = await tx
      .selectDistinct({ id: users.id })
      .from(users)
      .innerJoin(
        userScopeGrants,
        and(eq(userScopeGrants.userId, users.id), eq(userScopeGrants.orgId, users.orgId)),
      )
      .where(
        and(
          eq(users.orgId, orgId),
          eq(users.status, "active"),
          inArray(userScopeGrants.scope, satisfying),
        ),
      )

    const ids = new Set<string>()
    for (const r of viaRoles) ids.add(r.id)
    for (const r of viaDirect) ids.add(r.id)
    return [...ids]
  }
}
