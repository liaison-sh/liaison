// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Per-org app usage, counted as runs settle (workers/run-settled.ts). Two
// places, two purposes:
//  - Redis day counters (`orgcap:<kind>:<org>:<UTC day>`, modules/org/caps.ts)
//    that the per-day app caps are enforced from (app-day-cap.ts): runs and
//    bridge calls are added at once, per run, for an org with an app cap, so a
//    burst sees the count of the runs that settled before it on any replica.
//    Accepted: runs still in flight are not counted yet, so a burst can pass
//    the cap by the number of runs running at once;
//  - the reporting table `kernel.app_usage_daily` (migration 0282), one row
//    per (org, app, day, executor), batched: written every few seconds by one
//    upsert per batch that adds to the row. Best effort: a failed write is
//    logged and its counts are lost (reporting only; the caps never read it).
//
// What counts: every run through runApp is one run on the day it started, in
// the executor that ran it (a Workers run retried after a loader fault is one
// run: runApp settles once). Nested runs count like any other run. Runs of
// trusted platform code in-process are recorded in the table but never in the
// day counters (the caps are for the org's apps, not the platform). Bridge
// calls are those the cell counted for a Workers run; a QuickJS run reports
// none. CPU: a run on the instance's sandbox service (`workerd`) brings the
// CPU time the service measured for it, added here per run; the Workers
// loader's comes from its hourly pull (loader-usage.ts), never from here;
// QuickJS reports none (the row's cpu_ms stays null).

import { sql as drizzleSql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { type AppUsageExecutor, appUsageDaily } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { onRunSettled, type RunSettledInfo } from "~/modules/apps/workers/run-settled"
import { appDayKey, noteAppDayCount, utcDay } from "~/modules/org/caps"
import { appDayCapsOf } from "./app-day-cap"

const log = rootLogger.child({ module: "app-usage" })

/** How long a day counter outlives its day (the next day's reads still find yesterday's). */
const DAY_COUNTER_TTL_S = 2 * 86_400
/** A batch is written this often, or sooner once it holds this many rows. */
const FLUSH_INTERVAL_MS = 5_000
const FLUSH_MAX_ROWS = 500

interface PendingRow {
  orgId: string
  app: string
  day: string
  executor: AppUsageExecutor
  runs: number
  bridgeCalls: number
  wallMs: number
  /** Summed CPU of runs that reported one; null when none did. */
  cpuMs: number | null
}

const pending = new Map<string, PendingRow>()
let flushTimer: ReturnType<typeof setInterval> | null = null
let flushing: Promise<void> = Promise.resolve()
let unsubscribe: (() => void) | null = null

/** Add one settled run to the batch (and to the day counters, for a capped org). */
export function recordSettledRun(info: RunSettledInfo): void {
  const day = utcDay(info.at)
  const bridgeCalls = Math.max(0, Math.trunc(info.bridgeCalls ?? 0))
  const wallMs = Math.max(0, Math.trunc(info.ms))
  const cpuMs =
    info.cpuMs !== undefined && Number.isFinite(info.cpuMs)
      ? Math.max(0, Math.trunc(info.cpuMs))
      : null
  const key = `${info.orgId}|${info.app}|${day}|${info.executor}`
  const row = pending.get(key)
  if (row) {
    row.runs += 1
    row.bridgeCalls += bridgeCalls
    row.wallMs += wallMs
    if (cpuMs !== null) row.cpuMs = (row.cpuMs ?? 0) + cpuMs
  } else {
    pending.set(key, {
      orgId: info.orgId,
      app: info.app,
      day,
      executor: info.executor,
      runs: 1,
      bridgeCalls,
      wallMs,
      cpuMs,
    })
  }
  if (info.executor !== "inprocess") void countDay(info.orgId, day, bridgeCalls)
  if (pending.size >= FLUSH_MAX_ROWS) void flushAppUsage()
}

/** The day counters of a capped org. Never throws. */
async function countDay(orgId: string, day: string, bridgeCalls: number): Promise<void> {
  try {
    const caps = await appDayCapsOf(orgId)
    if (caps.appRunsPerDay === null && caps.appBridgeCallsPerDay === null) return
    const runsKey = appDayKey("appRunsPerDay", orgId, day)
    const callsKey = appDayKey("appBridgeCallsPerDay", orgId, day)
    const multi = redis.multi().incr(runsKey).expire(runsKey, DAY_COUNTER_TTL_S)
    if (bridgeCalls > 0) multi.incrby(callsKey, bridgeCalls).expire(callsKey, DAY_COUNTER_TTL_S)
    const res = (await multi.exec()) ?? []
    const runs = Number(res[0]?.[1] ?? 0)
    const calls = bridgeCalls > 0 ? Number(res[2]?.[1] ?? 0) : 0
    const at = Date.parse(`${day}T12:00:00.000Z`)
    if (caps.appRunsPerDay !== null && crossed(runs - 1, runs, caps.appRunsPerDay)) {
      void noteAppDayCount(orgId, "appRunsPerDay", runs, caps.appRunsPerDay, at)
    }
    if (
      caps.appBridgeCallsPerDay !== null &&
      bridgeCalls > 0 &&
      crossed(calls - bridgeCalls, calls, caps.appBridgeCallsPerDay)
    ) {
      void noteAppDayCount(orgId, "appBridgeCallsPerDay", calls, caps.appBridgeCallsPerDay, at)
    }
  } catch (err) {
    log.warn({ err, orgId }, "app usage: could not count the run in today's counters")
  }
}

/** True when going from `before` to `after` reaches 80 % or 100 % of `limit`. */
export function crossed(before: number, after: number, limit: number): boolean {
  const near = Math.ceil(limit * 0.8)
  return (before < near && after >= near) || (before < limit && after >= limit)
}

/** Write the batch: one upsert adding to each row. Never throws. */
export function flushAppUsage(): Promise<void> {
  flushing = flushing.then(writeUsageBatch)
  return flushing
}

async function writeUsageBatch(): Promise<void> {
  if (pending.size === 0) return
  const rows = [...pending.values()]
  pending.clear()
  try {
    await withSystemDb("app-usage-flush", (db) =>
      db
        .insert(appUsageDaily)
        .values(rows.map((r) => ({ ...r, updatedAt: new Date() })))
        .onConflictDoUpdate({
          target: [
            appUsageDaily.orgId,
            appUsageDaily.app,
            appUsageDaily.day,
            appUsageDaily.executor,
          ],
          set: {
            runs: drizzleSql`${appUsageDaily.runs} + excluded.runs`,
            bridgeCalls: drizzleSql`${appUsageDaily.bridgeCalls} + excluded.bridge_calls`,
            wallMs: drizzleSql`${appUsageDaily.wallMs} + excluded.wall_ms`,
            // Added per run (the sandbox service's measure); a batch without
            // one keeps what is there (the loader's pull writes its own).
            cpuMs: drizzleSql`CASE WHEN excluded.cpu_ms IS NULL THEN ${appUsageDaily.cpuMs}
              ELSE COALESCE(${appUsageDaily.cpuMs}, 0) + excluded.cpu_ms END`,
            updatedAt: drizzleSql`now()`,
          },
        }),
    )
  } catch (err) {
    log.warn(
      { err, rows: rows.length },
      "app usage: a batch could not be written; its counts are lost",
    )
  }
}

/** Subscribe to settled runs and write batches on a timer. Idempotent. */
export function startAppUsageRecorder(): void {
  if (unsubscribe) return
  unsubscribe = onRunSettled(recordSettledRun)
  flushTimer = setInterval(() => void flushAppUsage(), FLUSH_INTERVAL_MS)
  flushTimer.unref?.()
}

/** Stop recording and write what is pending (shutdown, tests). */
export async function stopAppUsageRecorder(): Promise<void> {
  unsubscribe?.()
  unsubscribe = null
  if (flushTimer) clearInterval(flushTimer)
  flushTimer = null
  await flushAppUsage()
}

/** Test seams of the app usage recorder. */
export const AppUsageTestAccess = {
  pendingRows(): PendingRow[] {
    return [...pending.values()]
  },
  clear(): void {
    pending.clear()
  },
}
