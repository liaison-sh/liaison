// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A config change to roles must not lock the org out of its own
 * administration. Checked at execute time against the real approver (A2):
 *  - it may not remove `kernel:roles:admin`, `kernel:users:admin` or
 *    `kernel:org:admin` from the approver themself (a person demotes
 *    themself in Settings, where the consequence is in front of them);
 *  - it may not leave the org with nobody holding `kernel:org:admin`.
 * The users section only invites, so it cannot demote anyone.
 */
import { eq, inArray } from "drizzle-orm"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { withPrivilegedDb } from "~/db/privileged"
import { roleScopeGrants, roles, userRoles, userScopeGrants } from "~/db/schema/kernel"
import { hasScope } from "~/modules/permissions/permissions"

const GUARDED_SCOPES = ["kernel:roles:admin", "kernel:users:admin", "kernel:org:admin"] as const

/** A refusal in words, or null when the change keeps the org administrable. */
export async function checkRoleChangeKeepsAdmins(
  orgId: string,
  approverUserId: string,
  desired: NonNullable<ProvisioningConfig["roles"]>,
): Promise<string | null> {
  if (desired.length === 0) return null
  const state = await withPrivilegedDb(orgId, "config-admin-guard", async (tx) => {
    const roleRows = await tx
      .select({ id: roles.id, name: roles.name })
      .from(roles)
      .where(eq(roles.orgId, orgId))
    const ids = roleRows.map((r) => r.id)
    const grants =
      ids.length === 0
        ? []
        : await tx
            .select({ roleId: roleScopeGrants.roleId, scope: roleScopeGrants.scope })
            .from(roleScopeGrants)
            .where(inArray(roleScopeGrants.roleId, ids))
    const members = await tx
      .select({ userId: userRoles.userId, roleId: userRoles.roleId })
      .from(userRoles)
      .where(eq(userRoles.orgId, orgId))
    const direct = await tx
      .select({ userId: userScopeGrants.userId, scope: userScopeGrants.scope })
      .from(userScopeGrants)
      .where(eq(userScopeGrants.orgId, orgId))
    return { roleRows, grants, members, direct }
  })

  const desiredByName = new Map(desired.map((r) => [r.name, r.scopes] as const))
  const before = new Map<string, string[]>()
  const after = new Map<string, string[]>()
  for (const r of state.roleRows) {
    const stored = state.grants.filter((g) => g.roleId === r.id).map((g) => g.scope)
    before.set(r.id, stored)
    after.set(r.id, desiredByName.get(r.name) ?? stored)
  }

  const userIds = new Set([
    ...state.members.map((m) => m.userId),
    ...state.direct.map((d) => d.userId),
  ])
  const scopesOf = (userId: string, byRole: Map<string, string[]>): string[] => [
    ...state.members.filter((m) => m.userId === userId).flatMap((m) => byRole.get(m.roleId) ?? []),
    ...state.direct.filter((d) => d.userId === userId).map((d) => d.scope),
  ]

  const approverBefore = scopesOf(approverUserId, before)
  const approverAfter = scopesOf(approverUserId, after)
  const lost = GUARDED_SCOPES.filter(
    (s) => hasScope(s, approverBefore) && !hasScope(s, approverAfter),
  )
  if (lost.length > 0) {
    return (
      `this change removes ${lost.join(", ")} from you, the approver: ` +
      "change your own access in Settings, or ask another admin to approve it"
    )
  }

  const adminsBefore = [...userIds].filter((u) => hasScope("kernel:org:admin", scopesOf(u, before)))
  const adminsAfter = [...userIds].filter((u) => hasScope("kernel:org:admin", scopesOf(u, after)))
  if (adminsBefore.length > 0 && adminsAfter.length === 0) {
    return "this change leaves the organization with nobody holding kernel:org:admin"
  }
  return null
}
