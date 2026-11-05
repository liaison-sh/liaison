// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Writes of the per-workspace app state (S18–S20, S24, A4, A24): On/Off,
 * removed, and who may use a restricted app. The reader is `org-apps.ts`.
 *
 * Every write, in one transaction: the `kernel.apps` row (and the access list),
 * a `permission_version` bump for every member of the org (a token minted
 * before the change is refused and refreshed, S20/A24-5); then this process's
 * cache reloads, peers are told over Redis, the auth cache is invalidated, an
 * org-wide grant-invalidation event and the `kernel:org_app:update` WebSocket
 * event go out, and the personal-agent ceilings of the org are recomputed.
 */
import { and, eq } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { apps, orgAppAccess } from "~/db/schema/kernel"
import { broadcastEphemeral } from "~/infra/events/event-bus"
import { rootLogger } from "~/lib/logger"
import { recomputePersonalAgentCeiling } from "~/modules/agent/directory/personal-agent"
import {
  getOrgAppState,
  noteOrgAppsChanged,
  type OrgAppAccessMode,
  type OrgAppState,
} from "~/modules/apps/org-apps"
import { bumpOrgPermissionVersions } from "~/modules/auth/admin-second-factor"
import { invalidateAuthCache } from "~/modules/auth/auth-state"

const log = rootLogger.child({ module: "apps/org-app-service" })

/** A refused org-app write; `status` + `code` flow through the error handler. */
export class OrgAppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = "OrgAppError"
  }
}

export type WritableOrgAppStatus = "active" | "disabled" | "removed"

/**
 * The permission side effects of a committed change, each best effort: a
 * failed step is logged and the next one still runs.
 */
async function runAfterChangeSteps(
  orgId: string,
  label: { app?: string; scope?: string },
  userIds: string[],
): Promise<void> {
  // The auth cache answers the permission_version check: drop each member's
  // entry here and on peers, so the bump takes effect at once.
  try {
    for (const userId of userIds) invalidateAuthCache(userId)
  } catch (err) {
    log.error({ err, orgId, ...label }, "auth cache invalidation after an access change failed")
  }
  // A personal agent's ceiling is persisted: recompute it so a member a
  // restricted app was taken from loses its tools there too (S20).
  try {
    await recomputeMembersAgentCeilings(orgId, userIds)
  } catch (err) {
    log.error({ err, orgId, ...label }, "agent ceiling recompute after an access change failed")
  }
}

async function recomputeMembersAgentCeilings(orgId: string, userIds: string[]): Promise<void> {
  for (const userId of userIds) {
    await withRlsContext({ actorType: "system", orgId, purpose: "job" }, (tx) =>
      recomputePersonalAgentCeiling(tx, { userId, orgId }),
    )
  }
}

/**
 * Inside the write's transaction: every member's `permission_version` goes up
 * (a token minted before the change is refused and refreshed, A24-5) and one
 * permission event names them all, so their open sessions are invalidated
 * once the transaction commits (grant-invalidation.ts).
 */
async function bumpOrgMembers(
  tx: PrivilegedDb,
  orgId: string,
  app: string,
  action: string,
): Promise<string[]> {
  const userIds = await bumpOrgPermissionVersions(tx, orgId)
  await tx.queueEvent({
    app: "kernel",
    entity: "user_scope",
    action: "org_app",
    entityId: orgId,
    orgId,
    data: { targetUserIds: userIds, app, change: action },
  })
  return userIds
}

/**
 * After a committed access change the kernel does not store itself (who may use
 * an organization MCP server, apps/mcp-manager/service/access.ts): the same
 * org-wide steps as an app access change. Every member's `permission_version`
 * goes up with one `user_scope` event naming them, then each member's auth cache
 * entry is dropped here and on peers and their personal agent ceiling is
 * recomputed. Privileged because the bump touches every member's row, which an
 * RLS session may do only with `kernel:users:admin`. Returns the members.
 */
export async function afterOrgAccessChange(
  orgId: string,
  change: { scope: string; mode: string; actorId: string | null },
): Promise<string[]> {
  const userIds = await withPrivilegedDb(orgId, "org-access-change", async (tx) => {
    const bumped = await bumpOrgPermissionVersions(tx, orgId)
    await tx.queueEvent({
      app: "kernel",
      entity: "user_scope",
      action: "access",
      entityId: orgId,
      orgId,
      actorId: change.actorId ?? undefined,
      data: { targetUserIds: bumped, scope: change.scope, change: change.mode },
    })
    return bumped
  })
  await runAfterChangeSteps(orgId, { scope: change.scope }, userIds)
  return userIds
}

async function afterCommit(orgId: string, app: string, userIds: string[]): Promise<OrgAppState> {
  await noteOrgAppsChanged(orgId)
  await runAfterChangeSteps(orgId, { app }, userIds)
  const state = await getOrgAppState(orgId, app)
  if (!state) throw new OrgAppError(404, "NOT_FOUND", `App "${app}" is not in this workspace`)
  // Open sessions resync their manifest feed (restricted users lose the app's
  // navigation, admins update the Off badge) without a reload.
  void broadcastEphemeral({
    app: "kernel",
    entity: "org_app",
    action: "update",
    orgId,
    data: { app, status: state.status, accessMode: state.accessMode },
  }).catch((err) =>
    log.warn({ err, orgId, app }, "org_app broadcast failed; sessions converge on reload"),
  )
  return state
}

/**
 * Set the app's status for the org. The row must exist (the app is registered
 * in this org); callers validate the transition (non-disableable apps,
 * dependents). Idempotent.
 */
export async function setOrgAppStatus(
  orgId: string,
  app: string,
  status: WritableOrgAppStatus,
): Promise<OrgAppState> {
  if (app === "kernel") throw new OrgAppError(400, "INVALID_ARGUMENT", "The kernel is not an app")
  const userIds = await withPrivilegedDb(orgId, "org-app-status", async (tx) => {
    const updated = await tx
      .update(apps)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(apps.orgId, orgId), eq(apps.name, app)))
      .returning({ name: apps.name })
    if (updated.length === 0) {
      throw new OrgAppError(404, "NOT_FOUND", `App "${app}" is not installed in this workspace`)
    }
    return bumpOrgMembers(tx, orgId, app, status)
  })
  return afterCommit(orgId, app, userIds)
}

/**
 * Set who may use the app: everyone, or the listed roles and people. The list
 * is replaced as a whole. Callers validate that the app has scopes to restrict.
 */
export async function setOrgAppAccess(
  orgId: string,
  app: string,
  access: { mode: OrgAppAccessMode; roleIds: readonly string[]; userIds: readonly string[] },
): Promise<OrgAppState> {
  if (app === "kernel") throw new OrgAppError(400, "INVALID_ARGUMENT", "The kernel is not an app")
  const userIds = await withPrivilegedDb(orgId, "org-app-access", async (tx) => {
    const updated = await tx
      .update(apps)
      .set({ accessMode: access.mode, updatedAt: new Date() })
      .where(and(eq(apps.orgId, orgId), eq(apps.name, app)))
      .returning({ name: apps.name })
    if (updated.length === 0) {
      throw new OrgAppError(404, "NOT_FOUND", `App "${app}" is not installed in this workspace`)
    }
    await tx
      .delete(orgAppAccess)
      .where(and(eq(orgAppAccess.orgId, orgId), eq(orgAppAccess.app, app)))
    const principals = [
      ...[...new Set(access.roleIds)].map((id) => ({
        principalType: "role" as const,
        principalId: id,
      })),
      ...[...new Set(access.userIds)].map((id) => ({
        principalType: "user" as const,
        principalId: id,
      })),
    ]
    if (access.mode === "restricted" && principals.length > 0) {
      await tx.insert(orgAppAccess).values(principals.map((p) => ({ orgId, app, ...p })))
    }
    return bumpOrgMembers(tx, orgId, app, `access:${access.mode}`)
  })
  return afterCommit(orgId, app, userIds)
}
