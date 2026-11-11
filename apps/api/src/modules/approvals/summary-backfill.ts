// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE ONE-OFF BACKFILL OF STORED APPROVAL SUMMARIES.
//
// Serving an approval reads its stored summary and runs no summarizer
// (served-summary.ts). Rows written before that rule, or outside executeTool
// (an import, an older seed), may have none, or the raw tool id as their
// title: they are served the generic summary of their payload until this pass
// stores the real one, computed with the tool's summarizer as the requester,
// exactly like the summary written when a request is made.
//
// The leader runs one pass each time it takes the lease (boot-phase10.ts). A
// pass walks each org's rows with no usable summary once (keyset paging, so a
// row whose tool has no summarizer, or whose summarizer fails, does not hold
// it up) and is a single cheap query when nothing is missing.

import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { appsLogger as log } from "~/lib/logger"
import { type SummaryRunner, storeApprovalSummaries } from "~/modules/approvals/served-summary"

const K = () => sql.raw(schemaRef("kernel"))

/** Rows read per page. */
const PAGE = 200

/** A row the serving path would give the generic summary: none, or an unusable title. */
const missingSummary = () => sql`(
  summary IS NULL
  OR coalesce(btrim(summary ->> 'title'), '') = ''
  OR summary ->> 'title' = tool_name
)`

export interface SummaryBackfillDeps {
  /** Register the org's apps (and so its summarizers) in this process. */
  ensureOrgApps: (orgId: string) => Promise<void>
  /** Runs one summarizer; the default runs it as the row's requester. */
  run?: SummaryRunner
  /** Restrict the pass to these orgs (tests). */
  orgIds?: string[]
}

async function defaultEnsureOrgApps(orgId: string): Promise<void> {
  const { awaitOrgApps } = await import("~/modules/apps/init")
  await awaitOrgApps(orgId)
}

/**
 * One pass over every org's approvals with no usable stored summary: each is
 * computed by its tool's summarizer and stored. Returns how many orgs had such
 * rows and how many summaries were stored. Never throws for one org: a failure
 * is logged and the next org runs.
 */
export async function backfillApprovalSummaries(
  deps: Partial<SummaryBackfillDeps> = {},
): Promise<{ orgs: number; stored: number }> {
  const ensureOrgApps = deps.ensureOrgApps ?? defaultEnsureOrgApps
  const orgIds =
    deps.orgIds ??
    (await withSystemDb("approval-summary-backfill:orgs", async (tx) =>
      extractRows<{ org_id: string }>(
        await tx.execute(sql`
          SELECT DISTINCT org_id::text AS org_id FROM ${K()}.approval_requests
          WHERE ${missingSummary()}`),
      ).map((r) => r.org_id),
    ))
  let stored = 0
  for (const orgId of orgIds) {
    try {
      await ensureOrgApps(orgId)
      let after: string | null = null
      for (;;) {
        const cursor: string | null = after
        const ids: string[] = await withSystemDb("approval-summary-backfill:page", async (tx) =>
          extractRows<{ id: string }>(
            await tx.execute(sql`
              SELECT id::text AS id FROM ${K()}.approval_requests
              WHERE org_id = ${orgId}::uuid
                AND ${missingSummary()}
                ${cursor ? sql`AND id > ${cursor}::uuid` : sql``}
              ORDER BY id
              LIMIT ${PAGE}`),
          ).map((r) => r.id),
        )
        if (ids.length === 0) break
        stored += await storeApprovalSummaries(orgId, ids, deps.run)
        if (ids.length < PAGE) break
        after = ids[ids.length - 1] ?? null
      }
    } catch (err) {
      log.warn({ err, orgId }, "approval summary backfill: org failed, the next pass retries it")
    }
  }
  if (stored > 0) log.info({ orgs: orgIds.length, stored }, "approval summaries backfilled")
  return { orgs: orgIds.length, stored }
}
