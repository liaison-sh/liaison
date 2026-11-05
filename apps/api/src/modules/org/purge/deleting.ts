// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The "deleting" state of an org: `organizations.deleting_at` (migration 0235).
//
// Set once, when an org's deletion starts, and never cleared by the purge (the
// org row goes last, with it). From then on:
//   * every request authenticated for the org answers 410 `ORG_DELETED`
//     (middleware/auth.ts, modules/mcp/mcp-auth-middleware.ts), and so does
//     a connection OAuth callback whose flow started before the mark (app.ts);
//   * its unauthenticated org-path routes serve nothing: every app counts as
//     Off (`isAppOffForPathOrg`), so an inbound webhook is acknowledged and
//     dropped (also when queued), and the tickets public routes answer 410;
//   * a WebSocket ticket opens no socket, every open socket of the org is
//     closed (4010) as soon as its process loads the deleting state
//     (`onOrgEnded`, lib/server.ts), and a frame on one still open is not
//     served: no presence or typing write lands after the purge;
//   * the job dispatch drops the org's jobs (infra/jobs/jobs.ts), counted with
//     the deleted orgs' and logged at info;
//   * the kernel immutability trigger lets the purge delete the org's legal
//     records (modules/apps/ddl.ts).
// Each process reads the state through the org-apps cache (org-apps.ts), so a
// peer learns it from the invalidation `markOrgDeleting` publishes, or at the
// latest after the cache TTL. The purge waits that TTL plus a drain window
// after the mark (`ORG_DELETING_SETTLE_MS`) before anything destructive, so a
// request or job that started just before the mark has finished. Work that
// runs longer than the drain (a long agent turn) may still write: the purge's
// verify step re-purges and fails on anything left, so that costs a re-run,
// never data left behind under a dropped org row.
//
// The purge itself is not subject to the guard: it runs on the privileged pool,
// outside any request, and a job that runs it carries the target org outside
// `data.orgId` so the dispatch does not treat it as one of the org's jobs.
import { sql as drizzleSql } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { isOrgDeletingAsync, noteOrgAppsChanged, ORG_APPS_TTL_MS } from "~/modules/apps/org-apps"
import { resultRows } from "~/modules/org/purge/rows"

const log = rootLogger.child({ module: "org-purge" })

const K = () => drizzleSql.raw(schemaRef("kernel"))

/** The error code of a request for an org being deleted. */
export const ORG_DELETED_CODE = "ORG_DELETED"

/** 410 `ORG_DELETED`: the org's deletion has started; nothing more is served for it. */
export class OrgDeletedError extends HTTPException {
  readonly code = ORG_DELETED_CODE
  constructor() {
    super(410, { message: "This workspace has been deleted." })
  }
}

/** The request guard: throws `OrgDeletedError` for an org being deleted. */
export async function assertOrgNotDeleting(orgId: string): Promise<void> {
  if (await isOrgDeletingAsync(orgId)) throw new OrgDeletedError()
}

/** How long, after the mark, a request or job that began before it may still run. */
export const ORG_DELETING_DRAIN_MS = 30_000

/**
 * Wait this long after `deleting_at` before the first destructive step: every
 * process's org-apps entry is then at most TTL old (so it says "deleting"), and
 * work admitted just before has drained.
 */
export const ORG_DELETING_SETTLE_MS = ORG_APPS_TTL_MS + ORG_DELETING_DRAIN_MS

export interface StoredOrgDeletion {
  slug: string
  deletingAt: Date | null
}

/** The org row's deletion state, read from Postgres; null when the row is gone. */
export async function readOrgDeletion(orgId: string): Promise<StoredOrgDeletion | null> {
  const row = await withSystemDb("org-purge-read", async (tx) => {
    const result = await tx.execute(drizzleSql`
      SELECT slug, deleting_at FROM ${K()}.organizations WHERE id = ${orgId}::uuid
    `)
    return resultRows<{ slug: string; deleting_at: Date | string | null }>(result)[0]
  })
  if (!row) return null
  return {
    slug: String(row.slug),
    deletingAt: row.deleting_at === null ? null : new Date(row.deleting_at),
  }
}

/** Thrown when the org purge is asked to delete an org whose deletion has not started. */
export class OrgNotDeletingError extends Error {
  constructor(
    readonly orgId: string,
    what: string,
  ) {
    super(`${what}: refused for org ${orgId} (its deletion has not started: deleting_at is null)`)
    this.name = "OrgNotDeletingError"
  }
}

/** The org purge's guard: the stored row exists and carries `deleting_at`. */
export async function assertOrgDeleting(orgId: string, what: string): Promise<void> {
  const stored = await readOrgDeletion(orgId)
  if (!stored?.deletingAt) throw new OrgNotDeletingError(orgId, what)
}

/**
 * Step 1 of a deletion: set `deleting_at` (kept when already set, so a re-run
 * keeps the first mark and its settle deadline), then tell every process
 * (org-apps invalidation). Returns the stored mark; throws when the org row is
 * gone.
 */
export async function markOrgDeleting(orgId: string, now: Date = new Date()): Promise<Date> {
  const row = await withSystemDb("org-purge-mark", async (tx) => {
    const result = await tx.execute(drizzleSql`
      UPDATE ${K()}.organizations
      SET deleting_at = COALESCE(deleting_at, ${now.toISOString()}::timestamptz)
      WHERE id = ${orgId}::uuid
      RETURNING deleting_at
    `)
    return resultRows<{ deleting_at: Date | string }>(result)[0]
  })
  if (!row) throw new Error(`markOrgDeleting: no organization ${orgId}`)
  await announceOrgDeleting(orgId)
  return new Date(row.deleting_at)
}

/** Reload this process's org-apps entry and invalidate the peers'. Never throws. */
export async function announceOrgDeleting(orgId: string): Promise<void> {
  try {
    await noteOrgAppsChanged(orgId)
  } catch (err) {
    log.warn({ err, orgId }, "org deleting state not announced; peers converge on the TTL")
  }
}

/**
 * Wait until `deletingAt + ORG_DELETING_SETTLE_MS`. Resumable: a re-run long
 * after the mark does not wait again.
 */
export async function waitForOrgDeletingToSettle(
  deletingAt: Date,
  opts: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<number> {
  const now = opts.now ?? Date.now
  const wait = deletingAt.getTime() + ORG_DELETING_SETTLE_MS - now()
  if (wait <= 0) return 0
  await (opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(wait)
  return wait
}
