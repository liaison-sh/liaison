// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The app-run health checks, judged on a health view (run-health.ts) and
// reported in /diag `appRuns.alerts`, so any watchdog that reads /diag pages
// on them without knowing the thresholds. All four look at the last 15
// minutes, which a watchdog polling every 5 minutes sees three times:
//
//   interactive_timeouts  interactive runs that timed out (their wall clock,
//                         the wait for a sandbox slot, a Workers deadline):
//                         at least LIAISON_APP_HEALTH_TIMEOUTS_MIN (10) and
//                         LIAISON_APP_HEALTH_TIMEOUT_RATE (2 %) of the
//                         interactive runs. Critical: people saw failures.
//   interactive_queue     the interactive queue wait p95 above
//                         LIAISON_APP_HEALTH_QUEUE_P95_MS (2000 ms), over 20
//                         queued runs at least. Warning.
//   pool_saturated        a pool saturated (every slot busy, a run waiting)
//                         LIAISON_APP_HEALTH_SATURATED_S (60 s) without a
//                         break in this process, or twice that in all.
//                         Warning.
//   interactive_p95       the interactive p95 at least
//                         LIAISON_APP_HEALTH_P95_REGRESSION (2) times its
//                         24-hour p95 and 1 s above it, over 30 runs (and 200
//                         in the 24 hours). Warning.
//
// Defaults: a burst of 30 to 45 interactive timeouts every half hour fires
// the first one at every burst; a quiet day (a stray timeout, no queue)
// fires none.

import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { cellRunHealth, processRunHealth, type RunHealthView } from "./run-health"

const log = rootLogger.child({ module: "app-run-health" })

export type RunHealthCheck =
  | "interactive_timeouts"
  | "interactive_queue"
  | "pool_saturated"
  | "interactive_p95"

export interface RunHealthAlert {
  check: RunHealthCheck
  severity: "warning" | "critical"
  /** The measure that crossed its threshold. */
  value: number
  threshold: number
  /** The worst apps, or the pool, behind it. */
  subjects: string[]
  message: string
}

export interface RunHealthThresholds {
  timeoutsMin: number
  timeoutRate: number
  queueP95Ms: number
  saturatedS: number
  p95Regression: number
}

const QUEUE_MIN_RUNS = 20
const P95_MIN_RUNS = 30
const P95_MIN_BASELINE_RUNS = 200
const P95_MIN_RISE_MS = 1_000

export function runHealthThresholds(): RunHealthThresholds {
  return {
    timeoutsMin: env.LIAISON_APP_HEALTH_TIMEOUTS_MIN,
    timeoutRate: env.LIAISON_APP_HEALTH_TIMEOUT_RATE,
    queueP95Ms: env.LIAISON_APP_HEALTH_QUEUE_P95_MS,
    saturatedS: env.LIAISON_APP_HEALTH_SATURATED_S,
    p95Regression: env.LIAISON_APP_HEALTH_P95_REGRESSION,
  }
}

/** The checks that fail on a view (the cell's when it could be read, else this process's). */
export function judgeRunHealth(
  view: RunHealthView,
  t: RunHealthThresholds = runHealthThresholds(),
): RunHealthAlert[] {
  const alerts: RunHealthAlert[] = []
  const now = view["15m"]
  const day = view["24h"]
  const inter = now.lanes.interactive
  const interApps = now.apps.filter((a) => a.lane === "interactive")

  if (inter.timeouts >= t.timeoutsMin && inter.timeoutRate >= t.timeoutRate) {
    alerts.push({
      check: "interactive_timeouts",
      severity: "critical",
      value: inter.timeouts,
      threshold: t.timeoutsMin,
      subjects: interApps
        .filter((a) => a.timeouts > 0)
        .sort((a, b) => b.timeouts - a.timeouts)
        .slice(0, 5)
        .map((a) => a.app),
      message: `${inter.timeouts} of ${inter.runs} interactive app runs timed out in 15 minutes`,
    })
  }

  if (inter.queuedRuns >= QUEUE_MIN_RUNS && (inter.queueP95Ms ?? 0) > t.queueP95Ms) {
    alerts.push({
      check: "interactive_queue",
      severity: "warning",
      value: inter.queueP95Ms ?? 0,
      threshold: t.queueP95Ms,
      subjects: interApps
        .filter((a) => (a.queueP95Ms ?? 0) > t.queueP95Ms)
        .slice(0, 5)
        .map((a) => a.app),
      message: `Interactive app runs waited ${inter.queueP95Ms} ms (p95) for a sandbox slot in 15 minutes`,
    })
  }

  const saturated = Object.entries(now.pools).filter(
    ([, p]) => (p.saturatedNowSec ?? 0) >= t.saturatedS || p.saturatedSec >= 2 * t.saturatedS,
  )
  if (saturated.length > 0) {
    const worst = Math.max(
      ...saturated.map(([, p]) => Math.max(p.saturatedNowSec ?? 0, p.saturatedSec)),
    )
    alerts.push({
      check: "pool_saturated",
      severity: "warning",
      value: worst,
      threshold: t.saturatedS,
      subjects: saturated.map(([name]) => name),
      message: `App sandbox pool saturated (${saturated.map(([n, p]) => `${n}: ${p.saturatedSec} s`).join(", ")}) in 15 minutes`,
    })
  }

  const base = day.lanes.interactive
  if (
    inter.runs >= P95_MIN_RUNS &&
    base.runs >= P95_MIN_BASELINE_RUNS &&
    inter.p95Ms !== null &&
    base.p95Ms !== null &&
    inter.p95Ms >= t.p95Regression * base.p95Ms &&
    inter.p95Ms - base.p95Ms >= P95_MIN_RISE_MS
  ) {
    const baseOf = new Map(
      day.apps.filter((a) => a.lane === "interactive").map((a) => [a.app, a.p95Ms ?? 0]),
    )
    alerts.push({
      check: "interactive_p95",
      severity: "warning",
      value: inter.p95Ms,
      threshold: Math.round(t.p95Regression * base.p95Ms),
      subjects: interApps
        .filter((a) => (a.p95Ms ?? 0) > (baseOf.get(a.app) ?? 0))
        .sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0))
        .slice(0, 5)
        .map((a) => a.app),
      message: `Interactive app runs p95 ${inter.p95Ms} ms in 15 minutes, ${base.p95Ms} ms over 24 hours`,
    })
  }
  return alerts
}

const firing = new Set<RunHealthCheck>()

/**
 * Log a check when it starts to fail, once until it clears. Warn, never
 * error, whatever its severity: the watchdog treats a log line at error
 * level as a page of its own, and it already pages on `appRuns.alerts`.
 */
export function noteRunHealthAlerts(alerts: readonly RunHealthAlert[]): void {
  const now = new Set(alerts.map((a) => a.check))
  for (const a of alerts) {
    if (firing.has(a.check)) continue
    log.warn(
      { check: a.check, value: a.value, threshold: a.threshold, subjects: a.subjects },
      `App run health: ${a.message}`,
    )
  }
  firing.clear()
  for (const c of now) firing.add(c)
}

export interface AppRunsDiag {
  /** Which view the alerts were judged on. */
  judgedOn: "cell" | "process"
  alerts: RunHealthAlert[]
  thresholds: RunHealthThresholds
  /** This process's runs. */
  process: RunHealthView
  /** Every process of the cell (Redis); null when Redis did not answer in time. */
  cell: RunHealthView | null
}

/** /diag `appRuns`: both views and the checks, the cell read bounded by `budgetMs`. */
export async function appRunsDiag(budgetMs: number): Promise<AppRunsDiag> {
  const process = processRunHealth()
  let timer: ReturnType<typeof setTimeout> | undefined
  const cell = await Promise.race([
    cellRunHealth().catch((err: unknown) => {
      log.warn({ err }, "app run health: the cell view could not be read from Redis")
      return null
    }),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), budgetMs)
    }),
  ])
  clearTimeout(timer)
  const thresholds = runHealthThresholds()
  const view = cell ?? process
  // The cell view has no saturated streak (a per-process measure): carry this process's.
  if (cell) {
    for (const [name, p] of Object.entries(process["15m"].pools)) {
      const c = cell["15m"].pools[name]
      if (c && p.saturatedNowSec !== undefined) c.saturatedNowSec = p.saturatedNowSec
    }
  }
  const alerts = judgeRunHealth(view, thresholds)
  noteRunHealthAlerts(alerts)
  return { judgedOn: cell ? "cell" : "process", alerts, thresholds, process, cell }
}
