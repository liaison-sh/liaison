// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE BACKFILL OF STORED APPROVAL SUMMARIES, FOR PENDING ROWS ONLY.
//
// Serving an approval reads its stored summary and runs no summarizer
// (served-summary.ts). Rows written before that rule, or outside executeTool
// (an import, an older seed), may have none, or the raw tool id as their
// title: they are served the generic summary of their payload.
//
// Only a row still awaiting a decision (`pending`) gets its real summary
// computed here, with the tool's summarizer, as the requester, exactly like
// the summary written when a request is made: it is the only row a person
// still reads to decide. A decided row (approved, auto-approved, denied,
// expired, ...) keeps what it has and is served the generic summary: running
// its summarizer now would read today's state and rewrite how a past decision
// reads, and auto-approved rows are written by the thousand.
//
// The work is a background job (`approval-summary-backfill`, the bulk class,
// yielding to the rest of it), never the boot path: the leader enqueues one
// pass each time it takes the lease, a little after boot. A job summarizes at
// most BATCH_CAP rows, then queues the next batch BATCH_PACE_MS later from its
// cursor, so a large history drains slowly instead of in one burst. A pass
// with nothing missing is one cheap query.

import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { enqueueAppJob, registerJobWorker } from "~/infra/jobs/jobs"
import { appsLogger as log } from "~/lib/logger"
import { type SummaryRunner, storeApprovalSummaries } from "~/modules/approvals/served-summary"

const K = () => sql.raw(schemaRef("kernel"))

/** The kernel job (queue-classes.ts: bulk, yielding). */
export const APPROVAL_SUMMARY_BACKFILL_JOB = "approval-summary-backfill"
/** Rows summarized per job at most. */
export const BATCH_CAP = 20
/** The wait before the next batch of a pass. */
export const BATCH_PACE_MS = 5_000
/** The wait between the leader taking the lease and the pass starting. */
export const KICK_DELAY_MS = 60_000

/** A row the serving path would give the generic summary: none, or an unusable title. */
const missingSummary = () => sql`(
  summary IS NULL
  OR coalesce(btrim(summary ->> 'title'), '') = ''
  OR summary ->> 'title' = tool_name
)`

/** Where a pass stands: the last row it looked at. */
export interface BackfillCursor {
  org: string
  id: string
}

export interface BackfillJob {
  jobId: string
  delay: number
  payload: { after?: BackfillCursor }
}

export interface SummaryBackfillDeps {
  /** Register the org's apps (and so its summarizers) in this process. */
  ensureOrgApps: (orgId: string) => Promise<void>
  /** Runs one summarizer; the default runs it as the row's requester. */
  run?: SummaryRunner
  /** Restrict the pass to these orgs (tests). */
  orgIds?: string[]
  /** Rows per batch (tests). */
  cap?: number
  /** Queue the next batch (default: the kernel job). */
  enqueue?: (job: BackfillJob) => Promise<void>
}

async function defaultEnsureOrgApps(orgId: string): Promise<void> {
  const { awaitOrgApps } = await import("~/modules/apps/init")
  await awaitOrgApps(orgId)
}

async function defaultEnqueue(job: BackfillJob): Promise<void> {
  await enqueueAppJob("kernel", APPROVAL_SUMMARY_BACKFILL_JOB, job.payload, {
    jobId: job.jobId,
    delay: job.delay,
    attempts: 1,
  })
}

/**
 * One batch: up to `cap` pending rows with no usable summary, after `after`
 * (ordered by org, then id), each computed by its tool's summarizer and
 * stored. `next` is the cursor of the next batch, null when this one was the
 * last. A row whose tool has no summarizer, or whose summarizer fails, keeps
 * the generic summary and is passed over. Never throws for one org.
 */
export async function backfillApprovalSummaryBatch(
  deps: Partial<SummaryBackfillDeps> & { after?: BackfillCursor } = {},
): Promise<{ stored: number; next: BackfillCursor | null }> {
  const ensureOrgApps = deps.ensureOrgApps ?? defaultEnsureOrgApps
  const cap = deps.cap ?? BATCH_CAP
  const after = deps.after
  const rows = await withSystemDb("approval-summary-backfill:batch", async (tx) =>
    extractRows<{ org_id: string; id: string }>(
      await tx.execute(sql`
        SELECT org_id::text AS org_id, id::text AS id FROM ${K()}.approval_requests
        WHERE status = 'pending'
          AND ${missingSummary()}
          ${
            deps.orgIds
              ? sql`AND org_id IN (${sql.join(
                  deps.orgIds.map((o) => sql`${o}::uuid`),
                  sql`, `,
                )})`
              : sql``
          }
          ${after ? sql`AND (org_id, id) > (${after.org}::uuid, ${after.id}::uuid)` : sql``}
        ORDER BY org_id, id
        LIMIT ${cap}`),
    ),
  )
  const byOrg = new Map<string, string[]>()
  for (const r of rows) {
    const ids = byOrg.get(r.org_id) ?? []
    ids.push(r.id)
    byOrg.set(r.org_id, ids)
  }
  let stored = 0
  for (const [orgId, ids] of byOrg) {
    try {
      await ensureOrgApps(orgId)
      stored += await storeApprovalSummaries(orgId, ids, deps.run)
    } catch (err) {
      log.warn({ err, orgId }, "approval summary backfill: org failed, the next pass retries it")
    }
  }
  const last = rows[rows.length - 1]
  const next = rows.length >= cap && last ? { org: last.org_id, id: last.id } : null
  return { stored, next }
}

/** The job: one batch, then the next one queued, paced, while rows remain. */
export async function processApprovalSummaryBackfillJob(
  payload: BackfillJob["payload"],
  deps: Partial<SummaryBackfillDeps> = {},
): Promise<void> {
  const { stored, next } = await backfillApprovalSummaryBatch({
    ...deps,
    ...(payload.after ? { after: payload.after } : {}),
  })
  if (stored > 0) log.info({ stored }, "approval summaries backfilled")
  if (!next) return
  await (deps.enqueue ?? defaultEnqueue)({
    jobId: `${APPROVAL_SUMMARY_BACKFILL_JOB}:${next.org}:${next.id}`,
    delay: BATCH_PACE_MS,
    payload: { after: next },
  })
}

/** Register the job's handler (every process; only a job host runs it). */
export function registerApprovalSummaryBackfillJob(): void {
  registerJobWorker<BackfillJob["payload"]>(
    "kernel",
    APPROVAL_SUMMARY_BACKFILL_JOB,
    async (payload) => {
      await processApprovalSummaryBackfillJob(payload ?? {})
    },
  )
}

/** Start a pass (the leader, on taking the lease): one job, a little later. */
export async function kickApprovalSummaryBackfill(): Promise<void> {
  await defaultEnqueue({
    jobId: `${APPROVAL_SUMMARY_BACKFILL_JOB}:start`,
    delay: KICK_DELAY_MS,
    payload: {},
  })
}
