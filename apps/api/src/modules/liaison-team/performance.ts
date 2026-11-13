// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The performance report to the Liaison team (`performance`, contract
// `performanceDataSchema`): the app-run health (modules/apps/usage/run-health.ts)
// as numbers per app name and lane, once an hour.
//
//   self-hosted   only when the operator turned on "Share app performance"
//                 (Settings > System, Liaison team; needs registration)
//   managed       always (a cell's sharing switches are always on)
//
// What it carries is exactly what `performanceData` builds, which the operator
// can read before turning it on (GET /api/admin/liaison-team/performance).
// No org id or name, no user, no content and no entry arguments: per app and
// lane, run counts, percentiles, rates and error kinds; the slowest runs as
// app, entry kind (`tool`, `job`, ...), lane and time; pool saturation. An
// app that is not in the release's app catalog (an org's custom app, an app
// the operator uploaded) is reported as `(custom)`, its name never sent.

import {
  type MessageData,
  PERFORMANCE_LANES,
  performanceDataSchema,
} from "@liaison/control-plane-contract"
import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { instanceSettings } from "~/db/schema/kernel"
import { isManagedEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { appsLogger as log } from "~/lib/logger"
import { listCatalog } from "~/modules/apps/catalog"
import { entryKindOf } from "~/modules/apps/run-limits"
import {
  cellRunHealth,
  processRunHealth,
  type RunHealthRow,
  type RunHealthSummary,
  type RunHealthView,
  type RunHealthWindowView,
} from "~/modules/apps/usage/run-health"
import { judgeRunHealth } from "~/modules/apps/usage/run-health-checks"
import { lockLiaisonTeam, readIdentity } from "./identity"
import { enqueue, liaisonTeamEndpoint } from "./outbox"
import { readSharing } from "./settings"

/** `kernel.instance_settings` key: when the last performance report was queued. */
export const LAST_PERFORMANCE_SETTING = "liaison_team.last_performance"
/** One report an hour. */
const PERFORMANCE_EVERY_MS = 60 * 60_000
const CELL_READ_BUDGET_MS = 2_000
const CUSTOM = "(custom)"
const OTHER = "(other)"
const KIND = /^[a-z0-9_]{1,40}$/

type PerformanceData = MessageData<"performance">
type PerfWindow = PerformanceData["windows"]["15m"]
type PerfSummary = PerfWindow["total"]

let catalogNames: () => ReadonlySet<string> = () => {
  try {
    return new Set(listCatalog().map((e) => e.name))
  } catch {
    return new Set()
  }
}

/** The name an app is reported under: its own for a catalog app, else `(custom)`. */
export function reportedAppName(app: string, catalog: ReadonlySet<string>): string {
  if (app === OTHER) return OTHER
  return catalog.has(app) && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(app) ? app : CUSTOM
}

const clampMs = (n: number | null) => (n === null ? null : Math.min(86_400_000, Math.round(n)))

function summary(s: RunHealthSummary): PerfSummary {
  const errorKinds: Record<string, number> = {}
  for (const [k, n] of Object.entries(s.errorKinds)) {
    const kind = KIND.test(k) ? k : "other"
    errorKinds[kind] = (errorKinds[kind] ?? 0) + n
  }
  return {
    runs: s.runs,
    errors: s.errors,
    timeouts: s.timeouts,
    errorRate: s.errorRate,
    timeoutRate: s.timeoutRate,
    errorKinds,
    p50Ms: clampMs(s.p50Ms),
    p95Ms: clampMs(s.p95Ms),
    p99Ms: clampMs(s.p99Ms),
    meanMs: clampMs(s.meanMs),
    queuedRuns: s.queuedRuns,
    queueP95Ms: clampMs(s.queueP95Ms),
    bridgeShare: s.bridgeShare,
    bridgeCalls: s.bridgeCalls,
  }
}

/**
 * Rows whose reported name is the same (several custom apps) are kept apart
 * as they are: the report lists the busiest 50 rows, never merges percentiles.
 */
function windowOf(v: RunHealthWindowView, catalog: ReadonlySet<string>): PerfWindow {
  const apps = v.apps.slice(0, 50).map((r: RunHealthRow) => ({
    app: reportedAppName(r.app, catalog),
    lane: r.lane,
    ...summary(r),
  }))
  const pools: PerfWindow["pools"] = {}
  for (const [name, p] of Object.entries(v.pools)) {
    if (!KIND.test(name)) continue
    pools[name] = { saturatedSec: p.saturatedSec, occupancy: p.occupancy }
  }
  return {
    windowS: v.windowS === 900 ? 900 : 86_400,
    total: summary(v.total),
    lanes: {
      interactive: summary(v.lanes.interactive),
      background: summary(v.lanes.background),
      nested: summary(v.lanes.nested),
    },
    apps,
    slowest: v.slowest.slice(0, 10).map((r) => {
      const kind = entryKindOf(r.entry) ?? "other"
      return {
        app: reportedAppName(r.app, catalog),
        entryKind: kind.replace(/-/g, "_"),
        lane: (PERFORMANCE_LANES as readonly string[]).includes(r.lane) ? r.lane : "interactive",
        ms: Math.min(86_400_000, r.ms),
        ...(r.queueMs !== undefined ? { queueMs: Math.min(86_400_000, r.queueMs) } : {}),
        ok: r.ok,
        ...(r.errorKind && KIND.test(r.errorKind) ? { errorKind: r.errorKind } : {}),
      }
    }),
    pools,
  }
}

/** The `performance` data for a health view, checked through the contract. */
export function performanceDataOf(
  view: RunHealthView,
  opts: { catalog?: ReadonlySet<string> } = {},
): PerformanceData {
  const catalog = opts.catalog ?? catalogNames()
  return performanceDataSchema.parse({
    version: env.LIAISON_VERSION,
    edition: isManagedEdition() ? "managed" : "self_hosted",
    windows: { "15m": windowOf(view["15m"], catalog), "24h": windowOf(view["24h"], catalog) },
    alerts: judgeRunHealth(view)
      .slice(0, 10)
      .map((a) => ({
        check: a.check,
        severity: a.severity,
        value: a.value,
        threshold: a.threshold,
      })),
  })
}

/** The report as it would be sent now: the cell's view, or this process's when Redis does not answer. */
export async function performanceData(): Promise<PerformanceData> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const cell = await Promise.race([
    cellRunHealth().catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), CELL_READ_BUDGET_MS)
    }),
  ])
  clearTimeout(timer)
  return performanceDataOf(cell ?? processRunHealth())
}

/**
 * The scheduled tick (with the heartbeat's, every 10 minutes): queue one
 * report when the last one is an hour old, for a registered server that
 * shares its app performance. Returns whether a row was queued. Never throws.
 */
export async function performanceTick(now: Date = new Date()): Promise<boolean> {
  if (!liaisonTeamEndpoint()) return false
  try {
    const pre = await withSystemDb("liaison-team:performance-check", async (tx) => ({
      sharing: await readSharing(tx),
      identity: await readIdentity(tx),
    }))
    if (!pre.sharing.sharePerformance || pre.identity?.state !== "registered") return false
    const data = await performanceData()
    return await withSystemDb("liaison-team:performance", async (tx) => {
      await lockLiaisonTeam(tx)
      const sharing = await readSharing(tx)
      const identity = await readIdentity(tx)
      if (!sharing.sharePerformance || identity?.state !== "registered") return false
      const [row] = await tx
        .select({ value: instanceSettings.value })
        .from(instanceSettings)
        .where(eq(instanceSettings.key, LAST_PERFORMANCE_SETTING))
      const last = Date.parse(String((row?.value as { at?: unknown } | undefined)?.at ?? ""))
      if (Number.isFinite(last) && now.getTime() - last < PERFORMANCE_EVERY_MS - 60_000)
        return false
      await enqueue(tx, "performance", data, { now })
      const value = { at: now.toISOString() }
      await tx
        .insert(instanceSettings)
        .values({ key: LAST_PERFORMANCE_SETTING, value, decidedAt: now })
        .onConflictDoUpdate({ target: instanceSettings.key, set: { value, decidedAt: now } })
      return true
    })
  } catch (err) {
    log.warn({ err }, "Liaison team performance report skipped")
    return false
  }
}

/** Test seams. */
export const PerformanceTestAccess = {
  setCatalogNames(names: ReadonlySet<string> | null): void {
    catalogNames = names
      ? () => names
      : () => {
          try {
            return new Set(listCatalog().map((e) => e.name))
          } catch {
            return new Set()
          }
        }
  },
}
