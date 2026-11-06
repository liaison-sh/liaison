// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE ORG PURGE: delete one organisation and everything it owns, in every
// store. Shared by the demo reaper (modules/demo/demo-reset.ts, an expired
// visitor workspace) and an operator's org deletion, which runs it as a
// server-side job once the org is marked deleting (deleting.ts).
//
// Steps, in order (each one idempotent, so a crashed run is simply run again):
//   triggers     every immutability trigger carries the deleting exception
//                (immutable-triggers.ts); skipped by the demo reaper
//   disconnect   each app removes what it registered at its provider with the
//                still-valid token (Shopify webhooks); best effort, never throws
//   rows         every row of the org in `kernel` and `app_*` (rows.ts),
//                immutable legal records included
//   search       one filter delete `org_id = "<id>"` on the live index, noted
//                for a running rebuild's shadow (external.ts)
//   objects      everything under `orgs/<id>/` (files, avatars, exports)
//   redis        keys carrying the org uuid, BullMQ's own excluded
//   schedulers   the org's BullMQ job schedulers
//   verify       the rows and the search delete again (a straggler that wrote
//                after the first pass), then the residue scan: anything left
//                fails the purge and the org row stays for the re-run
//   org-row      `kernel.organizations`, and the stored reply of the cloud
//                create of its slug (modules/cloud/create-org.ts). A write that lands between the
//                verify step and this delete is not re-checked: a kernel row
//                holds a foreign key to the org, so it goes with the org row
//                (ON DELETE CASCADE) or makes the delete fail (the re-run
//                purges it); an `app_*` row (no foreign key) would stay
//                orphaned. The window is a few milliseconds after a settle of
//                ORG_DELETING_SETTLE_MS during which every process refuses the
//                org; work still running after the drain fails the verify step
//                instead (a liveness cost, the purge is simply run again).
//   release      the org's runtime in every process (org-runtime:release)
//
// What may call it is the caller's guard (`assertAllowed`), re-checked at the
// head of the row delete. For an operator deletion it is "the stored row
// carries deleting_at" (`assertOrgDeleting`), and the purge first waits until
// every process has seen that state (`settle`).
import { sql as drizzleSql, eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { appsInstalled } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { forgetOrgHostSlug } from "~/lib/org-host"
import { runBeforeDisconnectForOrg } from "~/modules/apps/connections/before-disconnect"
import { validateIdentifier } from "~/modules/apps/ddl"
import { uninstallApp } from "~/modules/apps/install-service"
import { forgetOrgApps } from "~/modules/apps/org-apps"
import { releaseOrgRuntimesEverywhere } from "~/modules/apps/org-runtime-release"
import { CLOUD_CREATE_ORG_ENDPOINT } from "~/modules/cloud/outcomes"
import {
  assertOrgDeleting,
  readOrgDeletion,
  waitForOrgDeletingToSettle,
} from "~/modules/org/purge/deleting"
import {
  deleteOrgJobSchedulersWith,
  deleteOrgObjectsWith,
  deleteOrgRedisKeysWith,
  deleteOrgSearchDocuments,
  type OrgExternalStateDeps,
} from "~/modules/org/purge/external"
import { ensureImmutableTriggersCurrent } from "~/modules/org/purge/immutable-triggers"
import { type ResidueScan, residueScan } from "~/modules/org/purge/residue"
import { deleteOrgRows, orgScopedTables } from "~/modules/org/purge/rows"

const log = rootLogger.child({ module: "org-purge" })

export const ORG_PURGE_STEPS = [
  "triggers",
  "disconnect",
  "custom-apps",
  "rows",
  "search",
  "objects",
  "redis",
  "schedulers",
  "verify",
  "org-row",
  "release",
] as const
export type OrgPurgeStep = (typeof ORG_PURGE_STEPS)[number]

/** Thrown by the verify step: the residue scan found something left. */
export class OrgPurgeResidueError extends Error {
  constructor(
    readonly orgId: string,
    readonly residue: ResidueScan,
  ) {
    super(
      `org purge: ${residue.total} item(s) of org ${orgId} remain after the purge (${JSON.stringify(
        {
          rows: residue.rows,
          searchDocuments: residue.searchDocuments,
          redisKeys: residue.redisKeys,
          jobSchedulers: residue.jobSchedulers,
          objects: residue.objects,
        },
      )}); the org row is kept so the purge can be run again`,
    )
    this.name = "OrgPurgeResidueError"
  }
}

export interface PurgeOrgOptions {
  /** Names the purge in logs and the privileged-pool audit reasons. */
  reason: string
  /**
   * The caller's guard, re-checked against the stored org row before any row is
   * deleted. Default: the org's deletion has started (`assertOrgDeleting`).
   */
  assertAllowed?: (orgId: string, what: string) => Promise<unknown>
  /**
   * Wait until every process has seen the deleting state (deleting_at +
   * ORG_DELETING_SETTLE_MS) before the first destructive step. Default true;
   * the demo reaper passes false (an expired workspace is refused by its own
   * gate already).
   */
  settle?: boolean
  /**
   * Re-purge and run the residue scan before dropping the org row, failing on
   * anything left. Default true.
   */
  verify?: boolean
  /**
   * Check every immutability trigger and regenerate a stale one (DDL) before
   * deleting. Default true. The demo reaper passes false: a demo workspace's
   * legal records go through the demo-marker branch, which every trigger body
   * already carries, so a reap runs no DDL and a trigger it cannot read back
   * never blocks reaping.
   */
  regenerateTriggers?: boolean
  /**
   * Run the apps' provider-side disconnect hooks (default true). An org
   * transfer passes false when it purges a copy it moved away (or an aborted
   * incoming one): the provider state belongs to the copy that stays live.
   */
  providerHooks?: boolean
  externalDeps?: OrgExternalStateDeps
  /** Called after each step with what it did (a deletion ledger records it). */
  onStep?: (step: OrgPurgeStep, detail: Record<string, unknown>) => Promise<void> | void
  /** Test seam for the settle wait. */
  sleep?: (ms: number) => Promise<void>
}

export interface PurgeOrgResult {
  /** False when the org row was already gone (a re-run after the org-row step). */
  orgRowDeleted: boolean
  /** Rows per table and counts per store. */
  deleted: Record<string, number>
  /** The verify step's scan (absent when `verify` is false or the org was already gone). */
  residue?: ResidueScan
}

/** Purge one org (see the header). Throws on a refusal or an incomplete step. */
export async function purgeOrg(orgId: string, opts: PurgeOrgOptions): Promise<PurgeOrgResult> {
  const { reason } = opts
  const assertAllowed = opts.assertAllowed ?? assertOrgDeleting
  const deps = opts.externalDeps ?? {}
  const step = async (name: OrgPurgeStep, detail: Record<string, unknown>) => {
    await opts.onStep?.(name, detail)
  }
  const deleted: Record<string, number> = {}

  const stored = await readOrgDeletion(orgId)
  if (!stored) {
    // A re-run after the org row went: only the release may be left to do.
    await releaseOrgRuntimesEverywhere([orgId])
    await step("release", { alreadyGone: true })
    return { orgRowDeleted: false, deleted }
  }
  await assertAllowed(orgId, reason)
  if (opts.settle !== false) {
    if (!stored.deletingAt) throw new Error(`${reason}: org ${orgId} is not marked deleting`)
    const waited = await waitForOrgDeletingToSettle(stored.deletingAt, { sleep: opts.sleep })
    if (waited > 0)
      log.info({ orgId, waitedMs: waited }, "org purge: waited for the deleting state")
  }

  const triggers =
    opts.regenerateTriggers === false ? { skipped: true } : await ensureImmutableTriggersCurrent()
  await step("triggers", triggers)

  if (opts.providerHooks !== false) await runBeforeDisconnectForOrg(orgId)
  await step("disconnect", opts.providerHooks === false ? { skipped: true } : {})

  // Before the rows: the org's own apps go whole (files, schema, schedulers),
  // not just their rows.
  const customApps = await purgeOrgCustomApps(orgId)
  await step("custom-apps", { apps: customApps })

  const allTables = (tx: Parameters<typeof orgScopedTables>[0]) => orgScopedTables(tx, "all")
  Object.assign(deleted, await deleteOrgRows(reason, orgId, allTables, assertAllowed))
  await step("rows", { deleted: { ...deleted } })

  const searchTasks = await deleteOrgSearchDocuments(orgId)
  await step("search", { tasks: searchTasks })

  // Objects before Redis, as the reaper always did (spec amendment A35):
  // storage is the step most likely to fail, and a failure here leaves the org
  // row for the re-run.
  deleted["object-storage.objects"] = await deleteOrgObjectsWith(deps)(orgId)
  await step("objects", { objects: deleted["object-storage.objects"] })
  deleted["redis.keys"] = await deleteOrgRedisKeysWith(deps)(orgId)
  await step("redis", { keys: deleted["redis.keys"] })
  deleted["redis.job-schedulers"] = await deleteOrgJobSchedulersWith(deps)(orgId)
  await step("schedulers", { schedulers: deleted["redis.job-schedulers"] })

  let residue: ResidueScan | undefined
  if (opts.verify !== false) {
    const again = await deleteOrgRows(`${reason}-verify`, orgId, allTables, assertAllowed)
    for (const [table, n] of Object.entries(again)) deleted[table] = (deleted[table] ?? 0) + n
    const verifyTasks = await deleteOrgSearchDocuments(orgId)
    residue = await residueScan(orgId, {
      pendingSearchTasks: [...searchTasks, ...verifyTasks],
      deps,
    })
    await step("verify", { residue })
    if (residue.total > 0) throw new OrgPurgeResidueError(orgId, residue)
  }

  await withSystemDb(`${reason}-drop-org`, async (tx) => {
    await tx.execute(
      drizzleSql`DELETE FROM ${drizzleSql.raw(schemaRef("kernel"))}.organizations WHERE id = ${orgId}::uuid`,
    )
    // The managed edition's stored create reply for the slug (keyed by slug,
    // no org_id, so the row sweep above does not see it): with the org gone it
    // would answer a later create of the slug with the deleted org's id, or
    // refuse another owner the slug forever.
    await tx.execute(
      drizzleSql`DELETE FROM ${drizzleSql.raw(schemaRef("kernel"))}.cloud_request_outcomes
                  WHERE endpoint = ${CLOUD_CREATE_ORG_ENDPOINT} AND idem_key = ${stored.slug}`,
    )
  })
  deleted["kernel.organizations"] = 1
  forgetOrgHostSlug(stored.slug)
  // The next gate reloads the org's state and finds it missing.
  forgetOrgApps(orgId)
  await step("org-row", {})

  await releaseOrgRuntimesEverywhere([orgId])
  await step("release", {})
  log.warn({ orgId, slug: stored.slug, reason, deleted }, "organization purged")
  return { orgRowDeleted: true, deleted, ...(residue ? { residue } : {}) }
}

/**
 * Uninstall every custom app the org owns (app-org-scope.ts): its
 * install and active-version rows, version files and stored packages, cron
 * schedulers and in-memory registrations (uninstallApp), then its `app_<name>`
 * schema. Idempotent; returns the names removed. No other org runs these apps,
 * so nothing outside the org changes.
 */
export async function purgeOrgCustomApps(orgId: string): Promise<string[]> {
  const rows = await withSystemDb("org-purge-custom-apps", (db) =>
    db
      .selectDistinct({ name: appsInstalled.name })
      .from(appsInstalled)
      .where(eq(appsInstalled.orgId, orgId)),
  )
  const names = rows.map((r) => r.name)
  for (const name of names) {
    await uninstallApp({ name })
    const schema = validateIdentifier(schemaRef(`app_${name.replace(/-/g, "_")}`))
    await withSystemDb("org-purge-custom-app-schema", (db) =>
      db.execute(drizzleSql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)),
    )
  }
  // Their bulk downloads (bulk-blob.ts custom scopes) go too.
  const { deleteOrgCustomBulkBlobs } = await import("~/modules/apps/sandbox/bulk-blob")
  await deleteOrgCustomBulkBlobs(orgId)
  if (names.length > 0) log.warn({ orgId, apps: names }, "organization's custom apps removed")
  return names
}
