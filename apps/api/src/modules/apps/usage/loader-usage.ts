// SPDX-License-Identifier: FSL-1.1-ALv2
//
// CPU time of this cell's Workers runs, pulled from the app loader. The loader
// meters each dynamic worker's run from an inline tail (its cpuTime) and keeps
// per (cell, org, app, UTC day) totals; the cell asks for one day over a v2
// signed GET (`GET <loaderUrl>/usage?day=YYYY-MM-DD`, direction cell->loader,
// the signed path including the query, empty body), answered with
// `{ok, cellId, day, rows: [{orgId, app, runs, cpuMs, wallMs, unattributedRuns}]}`.
//
// Pulled every hour for today (a running total) and yesterday (final once the
// day is over; the tail lands about 20 ms after a run answers): each pulled
// `cpuMs` REPLACES the stored one on the (org, app, day, "workers") row of
// kernel.app_usage_daily, and the org's sum for the day is written to its
// Redis CPU counter, which the `appCpuMsPerDay` cap reads (app-day-cap.ts). So
// the CPU cap takes effect from the first run after the pull that shows it
// crossed. Without a Workers configuration nothing is pulled.

import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { withSystemDb } from "~/db/privileged"
import { appUsageDaily } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { readWorkersConfig, type WorkersConfig } from "~/modules/apps/workers/config"
import { signCellRequestV2 } from "~/modules/apps/workers/sign"
import { appDayKey, noteAppDayCount, utcDay } from "~/modules/org/caps"
import { movingOrgIds } from "~/modules/org/transfer-state/state"
import { appDayCapsOf } from "./app-day-cap"

const log = rootLogger.child({ module: "app-loader-usage" })

const DAY = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CPU_COUNTER_TTL_S = 2 * 86_400
const PULL_TIMEOUT_MS = 20_000

const usageReplySchema = z.object({
  ok: z.literal(true),
  day: z.string(),
  rows: z
    .array(
      z.object({
        orgId: z.string(),
        app: z.string(),
        runs: z.number().nonnegative().optional(),
        cpuMs: z.number().nonnegative(),
        wallMs: z.number().nonnegative().optional(),
      }),
    )
    .max(100_000),
})

export interface LoaderUsageRow {
  orgId: string
  app: string
  cpuMs: number
}

type LoaderFetch = (url: string, init: RequestInit) => Promise<Response>
let loaderFetch: LoaderFetch = (url, init) => fetch(url, init)

/** One day's per (org, app) CPU from the loader. Throws on a refused or malformed answer. */
export async function fetchLoaderUsage(
  config: WorkersConfig,
  day: string,
): Promise<LoaderUsageRow[]> {
  if (!DAY.test(day)) throw new Error(`loader usage: bad day ${day}`)
  const url = `${config.loaderUrl}/usage?day=${day}`
  const u = new URL(url)
  const headers = signCellRequestV2({
    cellId: config.cellId,
    cellKey: config.loaderKey,
    direction: "cell->loader",
    method: "GET",
    path: `${u.pathname}${u.search}`,
    body: "",
  })
  const res = await loaderFetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(PULL_TIMEOUT_MS),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(
      `loader usage: GET /usage?day=${day} answered ${res.status}: ${text.slice(0, 300)}`,
    )
  }
  const parsed = usageReplySchema.safeParse(JSON.parse(text))
  if (!parsed.success) {
    throw new Error(`loader usage: malformed answer: ${parsed.error.issues[0]?.message ?? "?"}`)
  }
  const out: LoaderUsageRow[] = []
  for (const r of parsed.data.rows) {
    // The loader answers only this cell's meter; an id that is not an org's is skipped.
    if (!UUID.test(r.orgId)) continue
    out.push({ orgId: r.orgId, app: r.app.slice(0, 128), cpuMs: Math.round(r.cpuMs) })
  }
  return out
}

/** Store one day's pulled CPU: per row in the table, per org in the CPU counter. */
export async function storeLoaderUsage(day: string, rows: LoaderUsageRow[]): Promise<void> {
  if (rows.length === 0) return
  // Orgs of another server (a moved org's tail rows) have no organizations row:
  // the foreign key refuses them, so the write is per org and a refusal is skipped.
  // An org moving to another server is left alone (its rows are frozen); the
  // next pull, on whichever cell holds it then, writes its CPU.
  const moving = new Set(await movingOrgIds())
  const byOrg = new Map<string, LoaderUsageRow[]>()
  for (const r of rows) {
    if (!moving.has(r.orgId)) byOrg.set(r.orgId, [...(byOrg.get(r.orgId) ?? []), r])
  }
  for (const [orgId, orgRows] of byOrg) {
    try {
      await withSystemDb("app-loader-usage-store", (db) =>
        db
          .insert(appUsageDaily)
          .values(
            orgRows.map((r) => ({
              orgId,
              app: r.app,
              day,
              executor: "workers" as const,
              cpuMs: r.cpuMs,
              updatedAt: new Date(),
            })),
          )
          .onConflictDoUpdate({
            target: [
              appUsageDaily.orgId,
              appUsageDaily.app,
              appUsageDaily.day,
              appUsageDaily.executor,
            ],
            set: { cpuMs: drizzleSql`excluded.cpu_ms`, updatedAt: drizzleSql`now()` },
          }),
      )
    } catch (err) {
      log.warn({ err, orgId, day }, "loader usage: could not store an org's CPU; skipped")
      continue
    }
    const total = orgRows.reduce((n, r) => n + r.cpuMs, 0)
    try {
      await redis.set(
        appDayKey("appCpuMsPerDay", orgId, day),
        String(total),
        "EX",
        CPU_COUNTER_TTL_S,
      )
      const limit = (await appDayCapsOf(orgId)).appCpuMsPerDay
      if (limit !== null && day === utcDay(Date.now()) && total >= Math.ceil(limit * 0.8)) {
        await noteAppDayCount(orgId, "appCpuMsPerDay", total, limit)
      }
    } catch (err) {
      log.warn({ err, orgId, day }, "loader usage: could not write an org's CPU counter")
    }
  }
}

/**
 * Pull today's and yesterday's CPU from the loader (the hourly job). Without a
 * Workers configuration: nothing. Returns the rows stored. Never throws: a
 * failed pull is logged and the next hour tries again.
 */
export async function pullLoaderUsage(now = new Date()): Promise<number> {
  const config = readWorkersConfig()
  if (!config) return 0
  const today = utcDay(now.getTime())
  const yesterday = utcDay(now.getTime() - 86_400_000)
  let stored = 0
  for (const day of [yesterday, today]) {
    try {
      const rows = await fetchLoaderUsage(config, day)
      await storeLoaderUsage(day, rows)
      stored += rows.length
    } catch (err) {
      log.warn({ err, day }, "loader usage: the pull failed; the next hour tries again")
    }
  }
  return stored
}

/** Test seams of the loader usage pull. */
export const LoaderUsageTestAccess = {
  /** Answer the loader's GET with `fn` (null restores fetch). */
  setFetch(fn: LoaderFetch | null): void {
    loaderFetch = fn ?? ((url, init) => fetch(url, init))
  },
}
