// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 16 Task A1 — `setUserScopes` is the kernel primitive an installed app
// calls (via the sandbox RPC bridge `grants_setUserScopes`) to grant Liaison-
// side scopes to a user. The function enforces:
//
//   1. Namespace ceiling — every scope in the call must be prefixed by the
//      calling app's name plus a colon (`<appName>:*`). The bridge forces
//      `callingApp` from the authenticated app-name context (not from the
//      app's own args), so an app cannot mint scopes outside its namespace.
//   2. Diff semantics — `setUserScopes` is a *set* operation scoped to the
//      app's namespace: scopes the user already has in the namespace but
//      that are not in the new list are removed; scopes outside the
//      namespace are never touched.
//   3. Audit row per call — one row in `kernel.app_scope_grant_audit` for
//      every invocation, including no-op calls (so an admin can see the
//      timeline). `scopes_added` / `scopes_removed` capture the diff.

import { and, eq, inArray, like, ne, sql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { appScopeGrantAudit, userScopeGrants, users } from "~/db/schema/kernel"
import { invalidateAuthCache } from "~/modules/auth/auth-state"

/**
 * Raised when `setUserScopes` is asked to grant scopes to a `userId` that is
 * not an (active) member of `orgId`. The target user always originates from
 * app-controlled data (staff_overrides rows, email lookups, or a caller-
 * supplied liaisonUserId), so without this check a buggy or hostile app could
 * write dangling grant rows for arbitrary/foreign UUIDs under the org.
 */
export class UserNotInOrgError extends Error {
  constructor(userId: string, orgId: string) {
    super(`target user '${userId}' is not an active member of org '${orgId}' — cannot grant scopes`)
    this.name = "UserNotInOrgError"
  }
}

export interface SetUserScopesArgs {
  orgId: string
  callingApp: string
  userId: string
  scopes: string[]
  /**
   * I9 — when supplied, every scope must also appear in `declaredScopes`.
   * The bridge populates this from the calling app's `manifest.scopes` so an
   * app cannot grant a scope it has not declared (catches snake/kebab drift
   * and other internal typos that would otherwise silently write grants the
   * kernel scope-check then rejects).
   */
  declaredScopes?: string[]
}

function isInNamespace(scope: string, app: string): boolean {
  return scope.startsWith(`${app}:`)
}

/**
 * Replace the user's set of scopes within the calling app's namespace.
 *
 * @throws if any scope is outside `${callingApp}:*`, or — when
 *   `declaredScopes` is supplied — if any scope is not in that list (I9), or
 *   if `userId` is not an active member of `orgId` ({@link UserNotInOrgError}).
 */
export async function setUserScopes(db: RlsClient, args: SetUserScopesArgs): Promise<void> {
  for (const s of args.scopes) {
    if (!isInNamespace(s, args.callingApp)) {
      throw new Error(`scope '${s}' is outside calling app's namespace '${args.callingApp}:*'`)
    }
  }
  if (args.declaredScopes && args.declaredScopes.length > 0) {
    const declared = new Set(args.declaredScopes)
    for (const s of args.scopes) {
      if (!declared.has(s)) {
        throw new Error(
          `scope '${s}' is not declared in app "${args.callingApp}" manifest.scopes — cannot grant`,
        )
      }
    }
  }

  await db.transaction(async (tx) => {
    // Membership validation — the target user must be an active member of this
    // org before we write any grant rows. `userId` is app-controlled data, so
    // without this an app could accumulate dangling grants for foreign UUIDs.
    // (A "deactivated" user is no longer a member; "suspended" is reserved for
    // future use and still counts as a member.)
    const member = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, args.userId),
          eq(users.orgId, args.orgId),
          ne(users.status, "deactivated"),
        ),
      )
      .limit(1)
    if (member.length === 0) {
      throw new UserNotInOrgError(args.userId, args.orgId)
    }

    const existing = await tx
      .select({ scope: userScopeGrants.scope })
      .from(userScopeGrants)
      .where(
        and(
          eq(userScopeGrants.userId, args.userId),
          eq(userScopeGrants.orgId, args.orgId),
          like(userScopeGrants.scope, `${args.callingApp}:%`),
        ),
      )

    const existingSet = new Set(existing.map((r) => r.scope))
    const targetSet = new Set(args.scopes)
    const toAdd = [...targetSet].filter((s) => !existingSet.has(s))
    const toRemove = [...existingSet].filter((s) => !targetSet.has(s))

    if (toAdd.length > 0) {
      await tx
        .insert(userScopeGrants)
        .values(toAdd.map((scope) => ({ userId: args.userId, orgId: args.orgId, scope })))
        .onConflictDoNothing()
    }

    if (toRemove.length > 0) {
      await tx
        .delete(userScopeGrants)
        .where(
          and(
            eq(userScopeGrants.userId, args.userId),
            eq(userScopeGrants.orgId, args.orgId),
            inArray(userScopeGrants.scope, toRemove),
          ),
        )
    }

    await tx.insert(appScopeGrantAudit).values({
      orgId: args.orgId,
      appName: args.callingApp,
      targetUserId: args.userId,
      scopesSet: args.scopes,
      scopesAdded: toAdd,
      scopesRemoved: toRemove,
    })

    // When the grant set actually changed, bump the target user's
    // `permission_version` in the SAME transaction so any access token minted
    // before this change is rejected by the auth check, and drop the in-process
    // auth-cache entry so the new version is observed without waiting for the
    // 15s TTL. No-op calls (no scopes added or removed) leave the version
    // untouched so an unchanged grant set doesn't force every session to
    // re-mint a token.
    if (toAdd.length > 0 || toRemove.length > 0) {
      await tx
        .update(users)
        .set({ permissionVersion: sql`permission_version + 1` })
        .where(and(eq(users.id, args.userId), eq(users.orgId, args.orgId)))
      invalidateAuthCache(args.userId)
      // Delivery carrier. `resolveGrantInvalidations` resolves the affected
      // user and their thread ids from this event plus the database at
      // delivery time, so queuing it here (inside the SAME transaction as the
      // grant) is what makes the invalidation reach the target user's own
      // sockets, exactly like the per-user grant paths in roles.ts. Without it
      // the invalidation waits for the org's next unrelated permission event,
      // or never arrives.
      await tx.queueEvent({
        app: "kernel",
        entity: "user_scope",
        action: toAdd.length > 0 ? "grant" : "revoke",
        entityId: args.userId,
        orgId: args.orgId,
        data: {
          targetUserId: args.userId,
          app: args.callingApp,
          scopesAdded: toAdd,
          scopesRemoved: toRemove,
        },
      })
    }
  })
}
