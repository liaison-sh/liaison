// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * T3 — real-boundary test helper.
 *
 * The systemic finding behind a startling number of confirmed criticals: tests
 * mock away the very boundary that contains the bug. Indexer tests stub
 * `withPrivilegedDb`; bridge tests use `withPrivilegedDb` instead of
 * `withRlsContext` (B14, I-SBX-3, I-PERM-5) — so an RLS gap ships GREEN because
 * the privileged connection bypasses every policy.
 *
 * The rule (review §7, theme T3): a test for a privilege/RLS boundary must run
 * THROUGH that boundary — the real `liaison_rls` role, with `SET LOCAL ROLE
 * liaison_rls` and the real `set_config('app.current_*')` GUCs that the
 * production request path sets. `withRlsContext` (db/rls.ts) is exactly that
 * path; `withPrivilegedDb` is NOT (it runs as the privileged owner and is RLS-
 * exempt). These helpers make the right path the easy path and the wrong one
 * obvious at the call site.
 *
 * Use `withRlsBoundary` (not `withPrivilegedDb`) for any test asserting that a
 * policy blocks/permits a query. Seed data with `withPrivilegedDb`/`withSystemDb`
 * (setup is legitimately privileged); make the ASSERTION run through the role.
 */
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"

/**
 * Build a `UserContext` from the user's REAL persisted scopes + dimension
 * grants (resolved via `loadEffectivePermissions`), NOT a fabricated
 * `scopes: ["*"]`. Scope-sensitive assertions are only genuine when the actor
 * carries the grants the user actually holds.
 */
export async function realUserContext(userId: string, orgId: string): Promise<UserContext> {
  const perms = await withPrivilegedDb(orgId, "test-rls-boundary-perms", (tx) =>
    loadEffectivePermissions(tx, userId, orgId),
  )
  return {
    actorType: "user",
    userId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
  }
}

/**
 * Convenience: resolve `userId`'s real persisted permissions for `orgId`, then
 * run `fn` through the `liaison_rls` boundary as that user. The common shape for
 * "does this user, with the grants they actually hold, see/not-see this row?".
 */
export async function withRlsBoundaryAs<T>(
  userId: string,
  orgId: string,
  fn: (tx: RlsClient) => Promise<T>,
): Promise<T> {
  const ctx = await realUserContext(userId, orgId)
  return withRlsContext(ctx, fn)
}
