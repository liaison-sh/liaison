// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The counters that say whether the cron fan-out and the fair job queues held
// under a stress run, read from the box's signed fan-out report
// (apps/api/src/infra/jobs/fanout-report.ts, POST /api/demo/harness/fanout-report).
// Shaped like deploy-counters.ts's report(): measured counters, `ok`, and a
// one-line summary.
//
//   missed       (load org, epoch) pairs whose fan-out job never started.
//   doubled      (load org, epoch) pairs whose job started a first attempt twice.
//   coalesced    (load org, epoch) pairs the tick skipped because the org's
//                previous job had not started yet (a slow queue, not a loss).
//   skipped      (load org, epoch) pairs the tick skipped on the job's runsFor
//                precondition: not due, so neither expected nor missed.
//   spread       the busiest tenth of an epoch's spread window, % of its runs.
//   schedulers   every job scheduler on the box: flat in the number of orgs.
//   quiet p95    the quiet orgs' job wait while one org floods, ms.
//
// Pure functions: the same counters run in tests and in a stress driver.
import type { FanoutReport } from "../../apps/api/src/infra/jobs/fanout-report"

export type { FanoutReport }

export interface FanoutBars {
  /** Most share (%) of an epoch's runs in one tenth of its window. */
  maxSlicePct: number
  /** Quiet orgs' job wait p95 must stay below this (ms). */
  quietP95Ms: number
  /** The scheduler count must equal this, when given (S15: same at every org count). */
  schedulers?: number
}

export const DEFAULT_FANOUT_BARS: FanoutBars = { maxSlicePct: 20, quietP95Ms: 5_000 }

export interface FanoutVerdict {
  window: { start: string; end: string }
  /** The span the waits were read over (at most the last 120 minutes of the window). */
  waitsWindow: { start: string; end: string }
  missed: number
  doubled: number
  coalesced: number
  skippedRunsFor: number
  notDue: number
  expected: number
  spreadMaxSlicePct: number | null
  schedulers: number
  quietP95Ms: number | null
  floodP95Ms: number | null
  /** Each bar that failed, in words; empty when all held. */
  failures: string[]
  ok: boolean
  summary: string
}

/** Judge one fan-out report against the bars. */
export function fanoutVerdict(
  report: FanoutReport,
  bars: FanoutBars = DEFAULT_FANOUT_BARS,
): FanoutVerdict {
  const t = report.totals
  const failures: string[] = []
  if (t.expected === 0) failures.push("no (org, epoch) was due in the window: nothing measured")
  if (t.missed > 0) failures.push(`${t.missed} missed`)
  if (t.doubled > 0) failures.push(`${t.doubled} doubled`)
  if (t.coalesced > 0) failures.push(`${t.coalesced} coalesced`)
  if (t.spreadMaxSlicePct !== null && t.spreadMaxSlicePct > bars.maxSlicePct) {
    failures.push(`spread ${t.spreadMaxSlicePct}% in one tenth (bar ${bars.maxSlicePct}%)`)
  }
  if (bars.schedulers !== undefined && report.schedulers !== bars.schedulers) {
    failures.push(`${report.schedulers} schedulers (expected ${bars.schedulers})`)
  }
  const quiet = report.waits.quiet.p95Ms
  if (quiet !== null && quiet >= bars.quietP95Ms) {
    failures.push(`quiet p95 ${quiet} ms (bar < ${bars.quietP95Ms} ms)`)
  }
  const ok = failures.length === 0
  const start = new Date(report.window.fromMs).toISOString()
  const end = new Date(report.window.toMs).toISOString()
  const waitsStart = new Date(report.waitsWindow.fromMs).toISOString()
  const waitsEnd = new Date(report.waitsWindow.toMs).toISOString()
  const summary =
    `Fan-out ${start} to ${end}, ${report.orgs} orgs: ${t.expected} due runs, ${t.missed} missed, ` +
    `${t.doubled} doubled, ${t.coalesced} coalesced, ${t.skippedRunsFor} skipped on runsFor, spread ${t.spreadMaxSlicePct ?? "n/a"}% max per tenth over ${t.spreadStarts} starts, ` +
    `${report.schedulers} schedulers, quiet p95 ${quiet ?? "n/a"} ms (waits read ${waitsStart} to ${waitsEnd}), flood p95 ${report.waits.flood?.p95Ms ?? "n/a"} ms. ` +
    (ok ? "Held." : `Failed: ${failures.join("; ")}.`)
  return {
    window: { start, end },
    waitsWindow: { start: waitsStart, end: waitsEnd },
    missed: t.missed,
    doubled: t.doubled,
    coalesced: t.coalesced,
    skippedRunsFor: t.skippedRunsFor,
    notDue: t.notDue,
    expected: t.expected,
    spreadMaxSlicePct: t.spreadMaxSlicePct,
    schedulers: report.schedulers,
    quietP95Ms: quiet,
    floodP95Ms: report.waits.flood?.p95Ms ?? null,
    failures,
    ok,
    summary,
  }
}
