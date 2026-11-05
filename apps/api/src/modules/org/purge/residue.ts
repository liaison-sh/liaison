// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The residue scan: what is left of one org in every store. The purge's last
// check before it drops the org row, a deletion's dry run, and the tests' proof
// that a purge left nothing (and touched nothing of a neighbour).
import { sql as drizzleSql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { listOrgJobSchedulers, listOrgQueuedJobs } from "~/infra/jobs/jobs"
import { effectiveIndexName, getMeili } from "~/infra/search/client"
import {
  countOrgObjects,
  countOrgRedisKeys,
  type OrgExternalStateDeps,
  orgSearchFilter,
} from "~/modules/org/purge/external"
import { countOrgRows, resultRows } from "~/modules/org/purge/rows"
import { waitForIndexTasks } from "~/modules/search/index-writer"

export interface ResidueScan {
  /** Rows per `schema.table` still holding the org (non-zero only), `organizations` excluded. */
  rows: Record<string, number>
  /** The org's own `kernel.organizations` row is still there. */
  orgRow: boolean
  /** Search documents with `org_id` = the org. */
  searchDocuments: number
  /** Redis keys carrying the org uuid, BullMQ's own keys excluded (as the purge does). */
  redisKeys: number
  /** BullMQ job schedulers of the org. */
  jobSchedulers: number
  /** Objects under `orgs/<id>/`. */
  objects: number
  /**
   * Jobs still queued whose data names the org. Listed apart and not in
   * `total`: the purge leaves them to the dispatch, which drops them.
   */
  queuedJobs: Array<{ queue: string; id: string; name: string }>
  /** Queues read only in part (more waiting jobs than the scan reads): `queuedJobs` may miss some there. */
  queuedJobsTruncated: string[]
  /** Everything above but `orgRow` and `queuedJobs`. Zero after a complete purge. */
  total: number
}

/** Search documents of the org in the live index; a missing index holds none. */
async function countOrgSearchDocuments(orgId: string): Promise<number> {
  try {
    const page = await getMeili()
      .index(effectiveIndexName())
      .getDocuments({ filter: orgSearchFilter(orgId), limit: 1, fields: ["id"] })
    return Number(page.total ?? 0)
  } catch (err) {
    const code = (err as { cause?: { code?: string }; code?: string }).cause?.code
    if (code === "index_not_found" || (err as { code?: string }).code === "index_not_found") {
      return 0
    }
    throw err
  }
}

async function orgRowExists(orgId: string): Promise<boolean> {
  return withSystemDb("org-purge-residue-org", async (tx) => {
    const result = await tx.execute(
      drizzleSql`SELECT 1 FROM ${drizzleSql.raw(schemaRef("kernel"))}.organizations WHERE id = ${orgId}::uuid`,
    )
    return resultRows(result).length > 0
  })
}

/**
 * Count what is left of `orgId` everywhere. `pendingSearchTasks`: Meili task
 * uids to wait for first (a purge's filter delete), so the count reads the
 * index after them. Read-only.
 */
export async function residueScan(
  orgId: string,
  opts: { pendingSearchTasks?: number[]; deps?: Pick<OrgExternalStateDeps, "countObjects"> } = {},
): Promise<ResidueScan> {
  for (const uid of opts.pendingSearchTasks ?? []) {
    try {
      await waitForIndexTasks([uid])
    } catch (err) {
      // A filter delete against an index that does not exist yet deleted
      // nothing, which is what was asked.
      if (!/index .*not found/i.test(err instanceof Error ? err.message : String(err))) throw err
    }
  }
  const rows = await countOrgRows(orgId)
  const orgRow = await orgRowExists(orgId)
  const searchDocuments = await countOrgSearchDocuments(orgId)
  const redisKeys = await countOrgRedisKeys(orgId)
  const jobSchedulers = (await listOrgJobSchedulers(orgId)).length
  const objects = await (opts.deps?.countObjects ?? countOrgObjects)(orgId)
  const { jobs: queuedJobs, truncatedQueues: queuedJobsTruncated } = await listOrgQueuedJobs(orgId)
  const total =
    Object.values(rows).reduce((a, b) => a + b, 0) +
    searchDocuments +
    redisKeys +
    jobSchedulers +
    objects
  return {
    rows,
    orgRow,
    searchDocuments,
    redisKeys,
    jobSchedulers,
    objects,
    queuedJobs,
    queuedJobsTruncated,
    total,
  }
}
