// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who sees a dashboard: the generic sharing model (modules/sharing, migration 0293), exactly as
// Knowledge documents and contacts use it. A dashboard has an owner, `orgAccess` (none | viewer |
// editor: what every member of the org gets) and grants to people and roles, each viewer or
// editor. A dashboard restricted to some people or roles is invisible to everyone else, org
// admins included: the row policies decide every read (list, open, block data, drill rows,
// filter options, exports, history, snapshots, scheduled sends).
//
// Reading the sharing needs only read access (whoever sees it may see who else does). Changing
// it needs `kernel.can_manage_sharing`: editor access to the dashboard and
// kernel:dashboards:share (or :admin). The database enforces it (the grants table's write
// policy, the dashboards UPDATE policy); this module shapes the call, names people and roles,
// and turns a refusal into SCOPE_DENIED before any write.

import { and, eq, inArray } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { withRlsContext } from "~/db/rls"
import { dashboards, roles, users } from "~/db/schema/kernel"
import {
  DASHBOARD_RESOURCE,
  DashboardError,
  type DashboardViewer,
  dashboardAudience,
  loadWithAccess,
  queueSharingEvent,
} from "~/modules/dashboards/service"
import {
  canManageSharing,
  listGrants,
  type OrgAccess,
  replaceGrants,
  type ShareRole,
} from "~/modules/sharing/service"

export interface DashboardSharing {
  orgAccess: OrgAccess
  ownerUserId: string | null
  ownerName: string | null
  canManage: boolean
  users: Array<{ userId: string; role: ShareRole; name: string | null }>
  roles: Array<{ roleId: string; role: ShareRole; name: string | null }>
  /** Dimension grants are not offered for dashboards; always empty. */
  dimensions: never[]
}

export interface DashboardSharingInput {
  orgAccess?: OrgAccess
  /** Replaces the people it is shared with (omitted: unchanged). */
  users?: Array<{ userId: string; role: ShareRole }>
  /** Replaces the roles it is shared with (omitted: unchanged). */
  roles?: Array<{ roleId: string; role: ShareRole }>
}

function inTx<T>(
  viewer: DashboardViewer,
  tx: RlsClient | undefined,
  fn: (t: RlsClient) => Promise<T>,
) {
  return tx ? fn(tx) : withRlsContext(viewer, fn)
}

async function names(
  t: RlsClient,
  orgId: string,
  userIds: string[],
  roleIds: string[],
): Promise<{ users: Map<string, string>; roles: Map<string, string> }> {
  const u = userIds.length
    ? await t
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(and(eq(users.orgId, orgId), inArray(users.id, userIds)))
    : []
  const r = roleIds.length
    ? await t
        .select({ id: roles.id, name: roles.name })
        .from(roles)
        .where(and(eq(roles.orgId, orgId), inArray(roles.id, roleIds)))
    : []
  return {
    users: new Map(u.map((x) => [x.id, x.name])),
    roles: new Map(r.map((x) => [x.id, x.name])),
  }
}

/** Who sees the dashboard, with names. NOT_FOUND when the viewer cannot see it. */
export async function getDashboardSharing(
  viewer: DashboardViewer,
  id: string,
  tx?: RlsClient,
): Promise<DashboardSharing> {
  return inTx(viewer, tx, async (t) => {
    const { row } = await loadWithAccess(viewer, id, t)
    const grants = await listGrants(t, DASHBOARD_RESOURCE, id)
    const n = await names(
      t,
      viewer.orgId,
      [...grants.users.map((g) => g.userId), ...(row.ownerUserId ? [row.ownerUserId] : [])],
      grants.roles.map((g) => g.roleId),
    )
    return {
      orgAccess: row.orgAccess,
      ownerUserId: row.ownerUserId,
      ownerName: row.ownerUserId ? (n.users.get(row.ownerUserId) ?? null) : null,
      canManage: await canManageSharing(t, DASHBOARD_RESOURCE, id),
      users: grants.users.map((g) => ({ ...g, name: n.users.get(g.userId) ?? null })),
      roles: grants.roles.map((g) => ({ ...g, name: n.roles.get(g.roleId) ?? null })),
      dimensions: [],
    }
  })
}

/**
 * Changes who sees the dashboard: the org-wide access and/or the people and roles it is shared
 * with (each list given replaces that list). Refuses SCOPE_DENIED unless the viewer may manage
 * its sharing, INVALID_REQUEST for a person or role not in the org, and refuses a change that
 * would leave the viewer unable to see what they just restricted while it has no owner.
 */
export async function setDashboardSharing(
  viewer: DashboardViewer,
  id: string,
  input: DashboardSharingInput,
  tx?: RlsClient,
): Promise<DashboardSharing> {
  return inTx(viewer, tx, async (t) => {
    const { row } = await loadWithAccess(viewer, id, t)
    if (!(await canManageSharing(t, DASHBOARD_RESOURCE, id))) {
      throw new DashboardError(
        "SCOPE_DENIED",
        "changing who sees a dashboard needs editor access to it and kernel:dashboards:share",
      )
    }
    const userIds = [...new Set((input.users ?? []).map((g) => g.userId.toLowerCase()))]
    const roleIds = [...new Set((input.roles ?? []).map((g) => g.roleId.toLowerCase()))]
    const n = await names(t, viewer.orgId, userIds, roleIds)
    const unknownUsers = userIds.filter((u) => !n.users.has(u))
    const unknownRoles = roleIds.filter((r) => !n.roles.has(r))
    if (unknownUsers.length || unknownRoles.length) {
      throw new DashboardError("INVALID_REQUEST", "not a member or role of this organisation", [
        ...unknownUsers.map((u) => `user ${u}`),
        ...unknownRoles.map((r) => `role ${r}`),
      ])
    }
    const before = {
      visibility: row.visibility,
      audience: await dashboardAudience(viewer.orgId, row),
    }
    await replaceGrants(t, { orgId: viewer.orgId, userId: viewer.userId }, DASHBOARD_RESOURCE, id, {
      ...(input.users ? { users: input.users } : {}),
      ...(input.roles ? { roles: input.roles } : {}),
    })
    const orgAccess = input.orgAccess ?? row.orgAccess
    if (orgAccess !== row.orgAccess) {
      // A dashboard the whole org does not see always has an owner: whoever restricts one
      // nobody owns takes it.
      const ownerUserId = orgAccess === "none" && !row.ownerUserId ? viewer.userId : row.ownerUserId
      try {
        await t.transaction(async (sp) => {
          await sp.update(dashboards).set({ orgAccess, ownerUserId }).where(eq(dashboards.id, id))
        })
      } catch (err) {
        // The row policy refused: the viewer would no longer edit what they restricted.
        if (
          (err as { code?: string; cause?: { code?: string } }).code === "42501" ||
          (err as { cause?: { code?: string } }).cause?.code === "42501"
        ) {
          throw new DashboardError(
            "SCOPE_DENIED",
            "you would lose access to this dashboard: share it with yourself as editor first",
          )
        }
        throw err
      }
    }
    const [after] = await t.select().from(dashboards).where(eq(dashboards.id, id)).limit(1)
    if (after) await queueSharingEvent(t, viewer, after, before)
    return getDashboardSharing(viewer, id, t)
  })
}
