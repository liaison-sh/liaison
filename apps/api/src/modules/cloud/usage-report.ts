// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The daily usage report (spec S5d): once a day, after 00:10 UTC, a
// managed cell tells the control plane, per org, what the previous UTC day's
// billed usage cost the provider in USD (the sum of `raw_cost_usd` of the
// rows metered on the cell's own key) and how many rows that was. The control
// plane compares the cells' sum with what the provider billed the cell's key.
// One signed `usage.report` per org with billed rows, through the outbox. The
// request id is derived from (org, day), so a re-run of the job sends the
// same id and the control plane counts the day once; `computedAt` orders two
// reports of one day, so a late retry never replaces a newer one.
//
// AN ORG THAT MOVED (who reports which org-day). Each cell reports only what
// ITS key spent: the rows it metered itself. Rows an org brought with it from
// another cell carry `arrived_via` (set by the transfer import, migration
// 0270) and are never counted here; the cell that metered them reports them,
// from its held `moved` copy, and the control plane accepts that report from a
// cell the org left on or after that day (cloud/cell-billing.ts there). So a
// move just after midnight gives: the source reports the whole previous day,
// the target reports nothing for it, and on the move day each reports its own
// part.

import { createHash } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { isManagedEdition } from "~/lib/edition"
import { rootLogger } from "~/lib/logger"
import { enqueue } from "~/modules/liaison-team/outbox"

const log = rootLogger.child({ module: "usage-report" })

/**
 * Model calls billed on the instance key (a deduction), never BYOK monitoring
 * rows nor a tool's fixed-price call on another service's key: the report is
 * compared with what the model provider billed this cell's key.
 */
export const BILLED_USAGE_TYPES = ["usage"] as const

export interface DayUsage {
  orgId: string
  rawCostUsd: string
  rows: number
}

/** The UTC day before `now`, as `YYYY-MM-DD`. */
export function previousUtcDay(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))
  return d.toISOString().slice(0, 10)
}

/** A stable uuid for one org's report of one day. */
export function reportRequestId(orgId: string, day: string): string {
  const h = createHash("sha256").update(`usage.report:${orgId}:${day}`).digest("hex")
  // Shaped as a version-4/variant-1 uuid so it passes the contract's uuid check.
  const variant = ((Number.parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** Per org: the USD cost and row count of `day`'s billed usage metered here (UTC bounds). */
export async function usageOfDay(day: string): Promise<DayUsage[]> {
  const k = drizzleSql.raw(schemaRef("kernel"))
  const from = `${day}T00:00:00.000Z`
  const to = new Date(Date.parse(from) + 24 * 3600_000).toISOString()
  const types = drizzleSql.join(
    BILLED_USAGE_TYPES.map((t) => drizzleSql`${t}`),
    drizzleSql`, `,
  )
  const rows = await withSystemDb("cloud-usage-report-read", async (db) =>
    extractRows<{ org_id: string; usd: string; n: number }>(
      await db.execute(drizzleSql`
        SELECT org_id, COALESCE(SUM(raw_cost_usd), 0)::numeric(20, 8)::text AS usd, count(*)::int AS n
          FROM ${k}.credit_transactions
         WHERE type IN (${types})
           AND arrived_via IS NULL
           AND created_at >= ${from}::timestamptz
           AND created_at < ${to}::timestamptz
         GROUP BY org_id
         ORDER BY org_id`),
    ),
  )
  return rows.map((r) => ({ orgId: r.org_id, rawCostUsd: r.usd, rows: Number(r.n) }))
}

/** Queue yesterday's report for every org with billed usage. Managed edition only. */
export async function sendDailyUsageReports(now = new Date()): Promise<number> {
  if (!isManagedEdition()) return 0
  const day = previousUtcDay(now)
  const usage = await usageOfDay(day)
  await withSystemDb("cloud-usage-report-enqueue", async (db) => {
    for (const u of usage) {
      await enqueue(db, "usage.report", {
        requestId: reportRequestId(u.orgId, day),
        orgId: u.orgId,
        day,
        rawCostUsd: u.rawCostUsd,
        rows: u.rows,
        computedAt: now.toISOString(),
      })
    }
  })
  log.info({ day, orgs: usage.length }, "daily usage reports queued")
  return usage.length
}
