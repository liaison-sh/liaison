// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The daily app usage report (`apps.usage`, cell->Control, contract
// money.ts): once a day, with the usage report, a managed cell tells Control,
// per org it holds a billing state for (an org Control placed here), the
// previous UTC day's app usage from kernel.app_usage_daily, per (app,
// executor): runs, bridge calls, wall and CPU milliseconds. It also carries
// the caps version this cell accepts (CAPS_CONTRACT_VERSION): Control sends
// the app cap kinds to a cell only once it reported version 2, so the report
// goes out for every such org, with `rows` empty when nothing ran.
//
// A message of its own, never inside `usage.report`: a Control that predates
// it refuses the type (the outbox records that row as refused) and the
// billing report is untouched. The request id is derived from (org, day), so
// a re-run of the job sends the same id. Yesterday's CPU is pulled from the
// loader first (loader-usage.ts), so the report carries the final CPU.

import { createHash } from "node:crypto"
import { CAPS_CONTRACT_VERSION } from "@liaison/control-plane-contract"
import { asc, eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { type AppUsageExecutor, appUsageDaily, orgBillingState } from "~/db/schema/kernel"
import { isManagedEdition } from "~/lib/edition"
import { rootLogger } from "~/lib/logger"
import { pullLoaderUsage } from "~/modules/apps/usage/loader-usage"
import { enqueue } from "~/modules/liaison-team/outbox"
import { previousUtcDay } from "./usage-report"

const log = rootLogger.child({ module: "apps-usage-report" })

/** The most rows one org's report carries (the contract's bound). */
const MAX_ROWS = 1000

export interface AppsUsageRow {
  app: string
  executor: AppUsageExecutor
  runs: number
  bridgeCalls: number
  wallMs: number
  cpuMs: number | null
}

/** A stable uuid for one org's app usage report of one day. */
export function appsUsageRequestId(orgId: string, day: string): string {
  const h = createHash("sha256").update(`apps.usage:${orgId}:${day}`).digest("hex")
  const variant = ((Number.parseInt(h[16] ?? "0", 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** Per org: `day`'s app usage rows, as the report carries them. */
export async function appsUsageOfDay(day: string): Promise<Map<string, AppsUsageRow[]>> {
  const rows = await withSystemDb("apps-usage-report-read", (db) =>
    db
      .select()
      .from(appUsageDaily)
      .where(eq(appUsageDaily.day, day))
      .orderBy(asc(appUsageDaily.orgId), asc(appUsageDaily.app), asc(appUsageDaily.executor)),
  )
  const out = new Map<string, AppsUsageRow[]>()
  for (const r of rows) {
    const list = out.get(r.orgId) ?? []
    if (list.length < MAX_ROWS) {
      list.push({
        app: r.app,
        executor: r.executor,
        runs: Number(r.runs),
        bridgeCalls: Number(r.bridgeCalls),
        wallMs: Number(r.wallMs),
        cpuMs: r.cpuMs === null ? null : Number(r.cpuMs),
      })
    }
    out.set(r.orgId, list)
  }
  return out
}

/** Queue yesterday's app usage report for every org Control placed here. Managed only. */
export async function sendDailyAppsUsageReports(now = new Date()): Promise<number> {
  if (!isManagedEdition()) return 0
  const day = previousUtcDay(now)
  await pullLoaderUsage(now)
  const usage = await appsUsageOfDay(day)
  const orgs = await withSystemDb("apps-usage-report-orgs", (db) =>
    db.select({ orgId: orgBillingState.orgId }).from(orgBillingState),
  )
  await withSystemDb("apps-usage-report-enqueue", async (db) => {
    for (const { orgId } of orgs) {
      await enqueue(db, "apps.usage", {
        requestId: appsUsageRequestId(orgId, day),
        orgId,
        day,
        capsVersion: CAPS_CONTRACT_VERSION,
        rows: usage.get(orgId) ?? [],
        computedAt: now.toISOString(),
      })
    }
  })
  log.info({ day, orgs: orgs.length, withRows: usage.size }, "daily app usage reports queued")
  return orgs.length
}
