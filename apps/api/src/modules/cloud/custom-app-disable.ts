// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The operator's kill switch for an org's custom app (managed edition),
// `PUT /api/cloud/orgs/:id/custom-apps/:name/state`, signed by Control. During
// an incident (a busy-looping webhook, egress abuse) the operator stops ONE
// tenant's app without suspending or purging the org and without SQL:
//   - disabled: the install rows keep the app, its files and its data, and
//     `disabled_at` (0265) makes the tenant boundary refuse it everywhere
//     (`appVisibleToOrg` answers false, its owner included), so no tool,
//     webhook, event, job, MCP tool or interface of it runs; its schedulers and
//     this process's registrations go at once, other processes drop it on
//     their next read of the owner rows (announced). Its owner can neither
//     upgrade nor uninstall it (409 `custom_app_disabled`).
//   - enabled: the column is cleared and the app registers again.
// Every change is written to the org's audit log with the operator's reason.
// Nothing changes for any other org: the app must be this org's own.

import {
  CLOUD_ERROR_CODES,
  type CloudCustomAppStateReply,
  type CloudCustomAppStateRequest,
  type CloudErrorReply,
} from "@liaison/control-plane-contract"
import { and, eq, sql } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { appsInstalled } from "~/db/schema/kernel/apps-installed"
import { rootLogger } from "~/lib/logger"
import { announceActiveVersions } from "~/modules/apps/activation"
import { appOwnerOrg, invalidateAppOrgScope } from "~/modules/apps/app-org-scope"
import { writeAuditLog } from "~/modules/audit/service"

const log = rootLogger.child({ service: "cloud-custom-app-state" })

export async function setCustomAppState(
  req: CloudCustomAppStateRequest,
  messageId: string | undefined,
): Promise<
  { status: 200; reply: CloudCustomAppStateReply } | { status: 404; reply: CloudErrorReply }
> {
  invalidateAppOrgScope()
  if ((await appOwnerOrg(req.name)) !== req.orgId) {
    return { status: 404, reply: { ok: false, code: CLOUD_ERROR_CODES.notFound } }
  }
  await withSystemDb("cloud-custom-app-state", (db) =>
    db
      .update(appsInstalled)
      .set(
        req.disabled
          ? {
              disabledAt: sql`coalesce(${appsInstalled.disabledAt}, now())`,
              disabledReason: req.reason ?? null,
            }
          : { disabledAt: null, disabledReason: null },
      )
      .where(and(eq(appsInstalled.name, req.name), eq(appsInstalled.orgId, req.orgId))),
  )
  invalidateAppOrgScope()
  if (req.disabled) {
    const { removeAppCronFanout } = await import("~/infra/jobs/fanout-runtime")
    await removeAppCronFanout(req.name).catch((err: unknown) =>
      log.warn({ err, app: req.name }, "removing a disabled app's schedulers failed"),
    )
    const { unregisterAppEverywhere } = await import("~/modules/apps/runtime")
    await unregisterAppEverywhere(req.name).catch((err: unknown) =>
      log.warn({ err, app: req.name }, "unregistering a disabled app failed"),
    )
  } else {
    const { reloadInstalledApps } = await import("~/modules/apps/init")
    await reloadInstalledApps(req.orgId)
  }
  // Every other process re-reads the owner rows (and the disabled names) now.
  announceActiveVersions(req.name)
  await withPrivilegedDb(req.orgId, "cloud-custom-app-state-audit", (db) =>
    writeAuditLog(db, {
      orgId: req.orgId,
      actorId: null,
      actorType: "system",
      app: req.name,
      entityType: "app_install",
      action: req.disabled ? "app.custom.disabled" : "app.custom.enabled",
      metadata: { by: "operator", reason: req.reason ?? null, messageId: messageId ?? null },
    }),
  )
  log.warn(
    { orgId: req.orgId, app: req.name, disabled: req.disabled, reason: req.reason },
    req.disabled ? "custom app disabled by the operator" : "custom app enabled by the operator",
  )
  return { status: 200, reply: { ok: true, name: req.name, disabled: req.disabled } }
}
