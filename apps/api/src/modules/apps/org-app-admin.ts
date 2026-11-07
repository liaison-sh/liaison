// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Workspace app management (S24, A4, A6, A7, A12, A24-2, A24-6): what the
 * `/api/org/apps` routes and the `apps_set_enabled` / `apps_set_access` kernel
 * tools call. Validates each change, writes it through `org-app-service.ts`,
 * runs its side effects and audits it as `{app:"kernel", entity:"org_app"}`.
 *
 *  - add: a server-installed app not in this workspace (`removed`, or no row
 *    yet) is added, On. Instance install stays operator-only (install-routes).
 *  - remove: taken out of this workspace (status `removed`, data kept, its app
 *    routines paused); listed as Available again.
 *  - disable: Off (status `disabled`): everything stops, data kept, app
 *    routines paused.
 *  - enable: back On: state, then the app's registration for the org, its
 *    routines resumed, then each active connection reconciled one at a time
 *    (re-emits the connect event, which re-registers provider webhooks), and a
 *    `webhooks_repair` tool run when the app has one. Events received while Off
 *    are not replayed.
 *  - access: everyone, or the listed roles and people (only for an app that
 *    has scopes of its own to restrict).
 *
 * Refused: removing or turning Off `kernel`, `knowledge` or `contacts`; and an
 * app another On app requires (`dependencies.required`), naming the dependents.
 */
import { and, eq, inArray, ne } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { apps, connectedAccounts, roles, users } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { cancelApprovalsForSwitchedOffApp } from "~/modules/approvals/cancel"
import { listAppVersionStates, orgAppProblems } from "~/modules/apps/activation"
import { filterAppsVisibleToOrg } from "~/modules/apps/app-org-scope"
import { manifestRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { reconcileAppConnections } from "~/modules/apps/connections/service"
import { discoverInTreeApps } from "~/modules/apps/discover-apps"
import { ensureAppsForOrg, getDefaultApps } from "~/modules/apps/init"
import { isInstanceOperatorOrg } from "~/modules/apps/operator-org"
import { OrgAppError, setOrgAppAccess, setOrgAppStatus } from "~/modules/apps/org-app-service"
import {
  isOffStatus,
  listOrgAppStates,
  type OrgAppAccessMode,
  type OrgAppState,
  type OrgAppStatus,
} from "~/modules/apps/org-apps"
import { pauseAppRoutinesForOrg, resumeAppRoutinesForOrg } from "~/modules/apps/reconcile-assets"
import type { AppProblem } from "~/modules/apps/runtime"
import { writeAuditLog } from "~/modules/audit/service"
import { scopeBelongsToApp } from "~/modules/permissions/permissions"
import { getScopeCatalog } from "~/modules/permissions/scope-catalog"

const log = rootLogger.child({ module: "apps/org-app-admin" })

/** Apps the workspace cannot turn Off or remove: the platform depends on them (A6, A24-6). */
export const NON_DISABLEABLE_APPS: ReadonlySet<string> = new Set([
  "kernel",
  "knowledge",
  "contacts",
])

/** Who made the change, for the audit row. */
export interface OrgAppActor {
  actorId: string | null
  actorType: "user" | "agent" | "system"
}

/** One row of `GET /api/org/apps`. */
export interface OrgAppAdminView {
  name: string
  displayName: string | null
  version: string | null
  kind: string
  status: OrgAppStatus
  accessMode: OrgAppAccessMode
  principals: { roleIds: string[]; userIds: string[] }
  hasOwnScopes: boolean
  /**
   * False for an app the workspace depends on (kernel, knowledge, contacts):
   * it can be neither turned Off nor removed, so the header offers neither.
   */
  canDisable: boolean
  /** On apps of this workspace that require this one (`dependencies.required`). */
  dependents: string[]
  installSource: "in-tree" | "installed"
  listing: unknown
  /** The manifest's top-level SPDX licence (shown beside the listing). */
  license: string | null
  settings: { sections: unknown[] } | null
  /**
   * Why the app did not load here (manifest invalid, registration failed), else
   * null (STO-09). Persisted with the app's state, so it survives a restart.
   */
  problem: AppProblem | null
  /**
   * The last version this server tried to activate for an installed app and
   * switched back from (or refused), with the reason; the app still runs
   * `version`. Null when the latest activation took, and for in-tree apps.
   */
  upgradeFailed: {
    version: string
    reasonCode: string | null
    reasonMessage: string | null
  } | null
  /**
   * The workspace still has the app but its package is gone from this server
   * (neither built in nor installed, e.g. an app retired in favour of another):
   * it has no page, only a "no longer available" row an admin can remove.
   */
  retired: boolean
}

function readLicense(desc: object): string | null {
  return "license" in desc && typeof desc.license === "string" ? desc.license : null
}

function readListing(desc: object): unknown {
  return "listing" in desc ? (desc.listing ?? null) : null
}

function requiredDeps(desc: object): string[] {
  if (!("dependencies" in desc)) return []
  const deps = desc.dependencies
  if (!deps || typeof deps !== "object" || !("required" in deps)) return []
  const req = deps.required
  return Array.isArray(req) ? req.filter((d): d is string => typeof d === "string") : []
}

/** Does the app own at least one scope of its own (first segment = the app's scope prefix)? (A3) */
export function appHasOwnScopes(orgId: string, app: string): boolean {
  return getScopeCatalog(orgId).some((e) => scopeBelongsToApp(e.scope, app))
}

/** On apps of the workspace whose manifest requires `app`. */
async function onDependentsOf(app: string, states: OrgAppState[]): Promise<string[]> {
  const on = new Set(states.filter((s) => !isOffStatus(s.status)).map((s) => s.app))
  const descriptors = await getDefaultApps()
  return descriptors
    .filter((d) => d.name !== app && on.has(d.name) && requiredDeps(d).includes(app))
    .map((d) => d.name)
    .sort()
}

/** Every app of the workspace, Off and restricted included (A7), for admins. */
export async function listOrgAppsForAdmin(orgId: string): Promise<OrgAppAdminView[]> {
  await ensureAppsForOrg(orgId)
  const states = await filterAppsVisibleToOrg(await listOrgAppStates(orgId), orgId, (s) => s.app)
  const descriptors = new Map((await getDefaultApps()).map((d) => [d.name, d]))
  const inTree = new Set((await discoverInTreeApps()).map((a) => a.name))
  const problems = await orgAppProblems(orgId)
  const versionStates = new Map((await listAppVersionStates()).map((v) => [v.name, v]))
  const operator = await isInstanceOperatorOrg(orgId)
  const out: OrgAppAdminView[] = []
  for (const state of states) {
    const entry = manifestRegistry.get([orgId, state.app])
    const desc = descriptors.get(state.app)
    const persisted = problems.get(state.app)
    const problem = persisted
      ? { code: persisted.code as AppProblem["code"], message: persisted.message }
      : null
    const versionState = versionStates.get(state.app)
    const failed = versionState?.upgradeFailed ?? null
    out.push({
      name: state.app,
      displayName:
        entry?.displayName ?? (typeof desc?.displayName === "string" ? desc.displayName : null),
      version: entry?.version ?? desc?.version ?? null,
      kind: entry?.kind ?? "app",
      status: state.status,
      accessMode: state.accessMode,
      principals: { roleIds: [...state.roleIds], userIds: [...state.userIds] },
      hasOwnScopes: appHasOwnScopes(orgId, state.app),
      canDisable: !NON_DISABLEABLE_APPS.has(state.app),
      dependents: await onDependentsOf(state.app, states),
      installSource: inTree.has(state.app) ? "in-tree" : "installed",
      listing: desc ? readListing(desc) : null,
      license: desc ? readLicense(desc) : null,
      settings: entry?.settings ?? null,
      problem,
      upgradeFailed: failed
        ? {
            version: failed.version,
            reasonCode: failed.reasonCode,
            // The reason is instance-level: another org's registration error
            // can be in it. Only the operator org reads it (redacted, A14).
            reasonMessage: operator
              ? failed.reasonMessage
              : `Version ${failed.version} did not pass its health check; this server still runs ${versionState?.version}.`,
          }
        : null,
      retired: state.app !== "kernel" && !entry && !desc && !problem,
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

async function stateOf(orgId: string, app: string): Promise<OrgAppState> {
  const state = (await listOrgAppStates(orgId)).find((s) => s.app === app)
  if (!state)
    throw new OrgAppError(404, "NOT_FOUND", `App "${app}" is not installed on this server`)
  return state
}

async function assertMayStop(
  orgId: string,
  app: string,
  verb: "turn off" | "remove",
): Promise<void> {
  if (NON_DISABLEABLE_APPS.has(app)) {
    throw new OrgAppError(
      409,
      "app_required",
      `${app} cannot be ${verb === "remove" ? "removed" : "turned off"}: the workspace depends on it.`,
    )
  }
  const dependents = await onDependentsOf(app, await listOrgAppStates(orgId))
  if (dependents.length > 0) {
    throw new OrgAppError(
      409,
      "app_has_dependents",
      `${app} cannot be ${verb === "remove" ? "removed" : "turned off"} while ${dependents.join(", ")} ${dependents.length === 1 ? "needs" : "need"} it. Turn ${dependents.length === 1 ? "it" : "them"} off first.`,
      { dependents },
    )
  }
}

/**
 * Turning an app On (enable / add) needs every app it requires
 * (`dependencies.required`) On in the workspace: a required app that is Off or
 * removed refuses the change with 409, naming it.
 */
async function assertRequiredOn(
  app: string,
  states: OrgAppState[],
  verb: "turned on" | "added",
): Promise<void> {
  const desc = (await getDefaultApps()).find((d) => d.name === app)
  if (!desc) return
  const byName = new Map(states.map((s) => [s.app, s]))
  const missing = requiredDeps(desc)
    .filter((dep) => isOffStatus(byName.get(dep)?.status))
    .sort()
  if (missing.length === 0) return
  throw new OrgAppError(
    409,
    "app_requires",
    `${app} cannot be ${verb} while ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} off or not in this workspace. Turn ${missing.length === 1 ? "it" : "them"} on first.`,
    { requires: missing },
  )
}

async function audit(
  orgId: string,
  actor: OrgAppActor,
  app: string,
  action: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await withPrivilegedDb(orgId, "org-app-audit", (db) =>
    writeAuditLog(db, {
      orgId,
      actorId: actor.actorId,
      actorType: actor.actorType,
      app: "kernel",
      entityType: "org_app",
      entityId: app,
      action: `org_app.${action}`,
      metadata: { app, ...metadata },
    }),
  )
}

/** Turn the app Off for the workspace. */
export async function disableOrgApp(
  orgId: string,
  app: string,
  actor: OrgAppActor,
): Promise<OrgAppState> {
  if (NON_DISABLEABLE_APPS.has(app)) await assertMayStop(orgId, app, "turn off")
  const current = await stateOf(orgId, app)
  if (current.status === "removed") {
    throw new OrgAppError(409, "app_removed", `${app} is not in this workspace.`)
  }
  await assertMayStop(orgId, app, "turn off")
  const state = await setOrgAppStatus(orgId, app, "disabled")
  await pauseAppRoutinesForOrg(orgId, app)
  // Its pending requests can no longer run: they leave Home, cancelled with why (rows kept).
  await cancelApprovalsForSwitchedOffApp(orgId, app, actor)
  await audit(orgId, actor, app, "disable")
  return state
}

/** Take the app out of the workspace (data kept; listed as Available). */
export async function removeOrgApp(
  orgId: string,
  app: string,
  actor: OrgAppActor,
): Promise<OrgAppState> {
  if (NON_DISABLEABLE_APPS.has(app)) await assertMayStop(orgId, app, "remove")
  await stateOf(orgId, app)
  await assertMayStop(orgId, app, "remove")
  const state = await setOrgAppStatus(orgId, app, "removed")
  await pauseAppRoutinesForOrg(orgId, app)
  // Its pending requests can no longer run: they leave Home, cancelled with why (rows kept).
  await cancelApprovalsForSwitchedOffApp(orgId, app, actor)
  await audit(orgId, actor, app, "remove")
  return state
}

/**
 * Bring the app back after Off/removed: the registration for the org, the
 * app's routines, then its connections one at a time (the connect event is
 * queued after the handlers are registered, so the app re-registers its
 * provider webhooks), and its `webhooks_repair` tool when it has one.
 */
async function resumeOrgApp(orgId: string, app: string, actor: OrgAppActor): Promise<void> {
  await ensureAppsForOrg(orgId)
  await resumeAppRoutinesForOrg(orgId, app)
  const connections = await withPrivilegedDb(orgId, "org-app-resume-connections", (tx) =>
    tx
      .selectDistinct({ connectionName: connectedAccounts.connectionName })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.orgId, orgId),
          eq(connectedAccounts.appName, app),
          eq(connectedAccounts.status, "active"),
        ),
      ),
  )
  const userId = actor.actorType === "user" ? actor.actorId : null
  for (const { connectionName } of connections) {
    try {
      await reconcileAppConnections(orgId, userId, app, connectionName)
    } catch (err) {
      log.error({ err, orgId, app, connectionName }, "re-enable: connection reconcile failed")
    }
  }
  if (toolRegistry.get([orgId, app, "webhooks_repair"])) {
    try {
      const { executeTool } = await import("~/modules/apps/execute-tool")
      await executeTool({
        toolName: `${app}:webhooks_repair`,
        orgId,
        actor: { actorType: "system", orgId, purpose: "job", scopes: [`${app}:*`] },
        params: {},
        origin: "system",
      })
    } catch (err) {
      log.error(
        { err, orgId, app },
        "re-enable: webhooks_repair failed; the next health probe retries",
      )
    }
  }
}

/** Turn the app back On for the workspace. */
export async function enableOrgApp(
  orgId: string,
  app: string,
  actor: OrgAppActor,
): Promise<OrgAppState> {
  const current = await stateOf(orgId, app)
  if (current.status === "removed") {
    throw new OrgAppError(409, "app_removed", `${app} is not in this workspace: add it first.`)
  }
  if (current.status !== "active") {
    await assertRequiredOn(app, await listOrgAppStates(orgId), "turned on")
  }
  const state = await setOrgAppStatus(orgId, app, "active")
  if (current.status !== "active") await resumeOrgApp(orgId, app, actor)
  await audit(orgId, actor, app, "enable")
  return state
}

/**
 * Turn an app On for the workspace whatever its state, through the admin
 * page's own paths: a removed app is added back, an app turned Off (or in
 * error) is turned on. Returns whether it changed anything (false: already On).
 */
export async function turnOrgAppOn(
  orgId: string,
  app: string,
  actor: OrgAppActor,
): Promise<boolean> {
  // No row: never registered for the workspace, so never turned Off.
  const current = (await listOrgAppStates(orgId)).find((s) => s.app === app)
  if (!current || current.status === "active") return false
  if (current.status === "removed") await addOrgApp(orgId, app, actor)
  else await enableOrgApp(orgId, app, actor)
  return true
}

/** Add a server-installed app to the workspace, On. */
export async function addOrgApp(
  orgId: string,
  app: string,
  actor: OrgAppActor,
): Promise<OrgAppState> {
  if (app === "kernel") throw new OrgAppError(400, "INVALID_ARGUMENT", "The kernel is not an app")
  const current = await stateOf(orgId, app)
  if (current.status === "disabled") {
    throw new OrgAppError(
      409,
      "app_off",
      `${app} is already in this workspace: turn it on instead.`,
    )
  }
  if (current.status !== "active") {
    await assertRequiredOn(app, await listOrgAppStates(orgId), "added")
  }
  const state = await setOrgAppStatus(orgId, app, "active")
  if (current.status !== "active") await resumeOrgApp(orgId, app, actor)
  await audit(orgId, actor, app, "add")
  return state
}

/** Set who may use the app (S20). */
export async function setOrgAppAccessChecked(
  orgId: string,
  app: string,
  access: { mode: OrgAppAccessMode; roleIds: string[]; userIds: string[] },
  actor: OrgAppActor,
): Promise<OrgAppState> {
  await stateOf(orgId, app)
  if (access.mode === "restricted") {
    if (!appHasOwnScopes(orgId, app)) {
      throw new OrgAppError(422, "app_not_restrictable", "This app has no permissions to restrict")
    }
    const roleIds = [...new Set(access.roleIds)]
    const userIds = [...new Set(access.userIds)]
    const [foundRoles, foundUsers] = await withPrivilegedDb(
      orgId,
      "org-app-access-principals",
      async (tx) => [
        roleIds.length
          ? await tx
              .select({ id: roles.id })
              .from(roles)
              .where(and(eq(roles.orgId, orgId), inArray(roles.id, roleIds)))
          : [],
        userIds.length
          ? await tx
              .select({ id: users.id })
              .from(users)
              .where(and(eq(users.orgId, orgId), inArray(users.id, userIds)))
          : [],
      ],
    )
    if (foundRoles.length !== roleIds.length || foundUsers.length !== userIds.length) {
      throw new OrgAppError(
        400,
        "INVALID_ARGUMENT",
        "Every role and person must belong to this workspace",
      )
    }
  }
  const state = await setOrgAppAccess(orgId, app, {
    mode: access.mode,
    roleIds: access.mode === "restricted" ? access.roleIds : [],
    userIds: access.mode === "restricted" ? access.userIds : [],
  })
  await audit(orgId, actor, app, "access", {
    mode: access.mode,
    roleIds: state.roleIds,
    userIds: state.userIds,
  })
  return state
}

/**
 * Instance uninstall guard (A4): how many OTHER workspaces still have the app
 * added (status <> removed). The uninstall route refuses while this is > 0.
 */
export async function otherWorkspacesWithApp(orgId: string | null, app: string): Promise<number> {
  const rows = await withSystemDb("org-apps-uninstall-guard", (db) =>
    db
      .select({ orgId: apps.orgId })
      .from(apps)
      .where(
        and(
          eq(apps.name, app),
          ne(apps.status, "removed"),
          ...(orgId ? [ne(apps.orgId, orgId)] : []),
        ),
      ),
  )
  return rows.length
}
