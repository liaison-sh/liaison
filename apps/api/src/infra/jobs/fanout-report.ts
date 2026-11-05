// SPDX-License-Identifier: FSL-1.1-ALv2
// The load harness's fan-out report: for a set of load orgs and a time window,
// did every cron fan-out run each org exactly once per epoch (S16), how evenly
// did the runs spread, how many schedulers exist (S15), and how long did each
// org's jobs wait (S17). Read by the signed harness route
// (modules/demo/harness-routes.ts); the counters it reads are written for load
// orgs only (fanout-keys.ts `countFanoutRun`, `countFanoutCoalesced`).
import { redis } from "~/lib/redis"
import { histogramP95Ms, readWaitHistogram, waitHistogramSpan } from "./fairness"
import {
  APP_CRON_FANOUT_JOB,
  expectedEpochs,
  maxSlicePct,
  nextGapMs,
  spreadWindowMs,
} from "./fanout"
import {
  fanoutCoalescedKey,
  fanoutRunAtKey,
  fanoutRunsKey,
  fanoutSkippedKey,
  fanoutSpreadOrgsKey,
  fanoutStartsKey,
  fanoutWatchKey,
  readJobMetrics,
} from "./fanout-keys"
import { enumerateFanoutOrgs, type FanoutTemplate } from "./fanout-runtime"
import { getJobQueue, getJobSchedulerTotal } from "./jobs"
import { type LoadSyntheticTiming, readLoadSyntheticStats } from "./load-synthetic"

/** An epoch whose spread window closed less than this ago is not judged yet. */
export const FANOUT_REPORT_GRACE_MS = 60_000
/** An epoch's spread is judged only with at least this many runs. */
const MIN_SPREAD_SAMPLE = 5
/** Each list of missed or doubled runs is cut at this length. */
const MAX_LISTED = 50

export interface FanoutReportInput {
  orgIds: readonly string[]
  fromMs: number
  toMs: number
  /** The org a flood ran for: its waits are reported apart from the quiet orgs'. */
  floodOrgId?: string
  /** Queues whose per-org wait histograms are read. */
  queues: readonly string[]
  now?: number
}

export interface FanoutJobReport {
  schedule: string
  epochs: number
  /** (org, epoch) pairs that had to run: eligible org, window closed. */
  expected: number
  runs: number
  missed: number
  doubled: number
  coalesced: number
  /** (org, epoch) pairs the tick skipped on the job's `runsFor` precondition: not due, not judged. */
  skippedRunsFor: number
  /** (org, epoch) pairs whose spread window has not closed yet: not judged. */
  notDue: number
  /** Over the epochs with enough runs: the busiest tenth of the window's share, %. */
  spreadMaxSlicePct: number | null
  /**
   * The starts the spread was judged on, over the judged epochs: every org the
   * tick ran (load or not) for a watched epoch, else the load orgs' own.
   */
  spreadStarts: number
}

export interface FanoutRunRef {
  app: string
  job: string
  orgId: string
  epoch: number
  runs: number
}

export interface OrgWait {
  count: number
  p95Ms: number | null
}

/**
 * How the orgs' synthetic jobs (load-synthetic.ts) drained in the window: the
 * rate, and where a worker slot's time went besides the job's own sleep.
 */
export interface SyntheticDrain {
  /** Synthetic runs completed in the window, over all the orgs. */
  runs: number
  /** Runs per second from the first to the last completion second in the window. */
  ratePerSec: number
  /** Worker took the job to its handler's start (gate, org checks, event-loop wait), ms. */
  dispatchP95Ms: number
  dispatchMaxMs: number
  /** How late the sleep's timer fired: the process's event loop was busy or paused, ms. */
  lagP95Ms: number
  lagMaxMs: number
}

export interface FanoutReport {
  window: { fromMs: number; toMs: number }
  /** The span the `waits` were read over: the last 120 minutes of `window` at most. */
  waitsWindow: { fromMs: number; toMs: number }
  generatedAt: number
  orgs: number
  /** Every job scheduler this process's queues hold (S15: flat in the org count). */
  schedulers: number
  fanoutSchedulers: number
  byJob: Record<string, FanoutJobReport>
  totals: Omit<FanoutJobReport, "schedule" | "epochs"> & { epochs: number }
  missedRuns: FanoutRunRef[]
  doubledRuns: FanoutRunRef[]
  metrics: Record<string, number>
  waits: {
    queues: string[]
    perOrg: Record<string, OrgWait>
    quiet: OrgWait
    flood: OrgWait | null
  }
  /** The synthetic jobs' drain in the window; null when none completed. */
  drain: SyntheticDrain | null
}

/** A fan-out scheduler as the report reads it. */
export interface ReportScheduler {
  template: Pick<FanoutTemplate, "app" | "job" | "cron" | "everyMs">
  nextMs?: number
}

/** The fan-out schedulers on `kernel-cron`, with their templates. */
async function readFanoutSchedulers(): Promise<ReportScheduler[]> {
  if (fanoutReportTestState.schedulers) return fanoutReportTestState.schedulers()
  const queue = getJobQueue("kernel", APP_CRON_FANOUT_JOB)
  const out: ReportScheduler[] = []
  for (const s of await queue.getJobSchedulers(0, -1)) {
    const id = s.key ?? s.id ?? ""
    if (!id.startsWith(`${APP_CRON_FANOUT_JOB}:`)) continue
    const data = (s.template?.data ?? (await queue.getJobScheduler(id))?.template?.data) as
      | Partial<FanoutTemplate>
      | undefined
    if (!data?.app || !data.job) continue
    out.push({
      template: {
        app: data.app,
        job: data.job,
        cron: data.cron ?? s.pattern ?? "",
        ...(s.every ? { everyMs: Number(s.every) } : {}),
      },
      ...(typeof s.next === "number" ? { nextMs: s.next } : {}),
    })
  }
  return out
}

function emptyJob(schedule: string): FanoutJobReport {
  return {
    schedule,
    epochs: 0,
    expected: 0,
    runs: 0,
    missed: 0,
    doubled: 0,
    coalesced: 0,
    skippedRunsFor: 0,
    notDue: 0,
    spreadMaxSlicePct: null,
    spreadStarts: 0,
  }
}

const p95 = (sorted: readonly number[]): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0

/** Summarise completed synthetic runs (the window's only). Exported for its unit test. */
export function summariseSyntheticDrain(
  timings: readonly LoadSyntheticTiming[],
  fromMs: number,
  toMs: number,
): SyntheticDrain | null {
  const lo = Math.floor(fromMs / 1000)
  const hi = Math.floor(toMs / 1000)
  const inWindow = timings.filter((t) => t.second >= lo && t.second <= hi)
  if (inWindow.length === 0) return null
  let first = Number.POSITIVE_INFINITY
  let last = Number.NEGATIVE_INFINITY
  for (const t of inWindow) {
    if (t.second < first) first = t.second
    if (t.second > last) last = t.second
  }
  const dispatch = inWindow.map((t) => t.dispatchMs).sort((a, b) => a - b)
  const lag = inWindow.map((t) => t.lagMs).sort((a, b) => a - b)
  return {
    runs: inWindow.length,
    ratePerSec: Math.round((inWindow.length / (last - first + 1)) * 100) / 100,
    dispatchP95Ms: p95(dispatch),
    dispatchMaxMs: dispatch[dispatch.length - 1] ?? 0,
    lagP95Ms: p95(lag),
    lagMaxMs: lag[lag.length - 1] ?? 0,
  }
}

async function readDrain(input: FanoutReportInput): Promise<SyntheticDrain | null> {
  const timings: LoadSyntheticTiming[] = []
  for (const orgId of input.orgIds) timings.push(...(await readLoadSyntheticStats(orgId)).timings)
  return summariseSyntheticDrain(timings, input.fromMs, input.toMs)
}

async function readWaits(input: FanoutReportInput): Promise<FanoutReport["waits"]> {
  const perOrg: Record<string, OrgWait> = {}
  const quietCounts: Record<string, number> = {}
  let flood: OrgWait | null = null
  for (const orgId of input.orgIds) {
    const counts: Record<string, number> = {}
    for (const q of input.queues) {
      const h = await readWaitHistogram(q, input.fromMs, input.toMs, orgId)
      for (const [b, n] of Object.entries(h)) counts[b] = (counts[b] ?? 0) + n
    }
    const row = {
      count: Object.values(counts).reduce((a, b) => a + b, 0),
      p95Ms: histogramP95Ms(counts),
    }
    perOrg[orgId] = row
    if (orgId === input.floodOrgId) flood = row
    else for (const [b, n] of Object.entries(counts)) quietCounts[b] = (quietCounts[b] ?? 0) + n
  }
  return {
    queues: [...input.queues],
    perOrg,
    quiet: {
      count: Object.values(quietCounts).reduce((a, b) => a + b, 0),
      p95Ms: histogramP95Ms(quietCounts),
    },
    flood,
  }
}

/**
 * Build the report. For each fan-out (app, job): the epochs its schedule fired
 * in the window; for each of the given orgs that the tick would run (app on, or
 * no row: the tick's own enumeration), each epoch whose spread window closed
 * is judged: no run is `missed` (or `coalesced`, when the tick coalesced the
 * org), more than one first-attempt start is `doubled`.
 */
export async function buildFanoutReport(input: FanoutReportInput): Promise<FanoutReport> {
  const now = input.now ?? Date.now()
  const wanted = new Set(input.orgIds)
  const schedulers = await readFanoutSchedulers()
  const byJob: Record<string, FanoutJobReport> = {}
  const missedRuns: FanoutRunRef[] = []
  const doubledRuns: FanoutRunRef[] = []
  const slicePcts: number[] = []
  let epochTotal = 0

  for (const { template: t, nextMs } of schedulers) {
    const row = emptyJob(t.everyMs ? `every ${t.everyMs} ms` : t.cron)
    byJob[`${t.app}:${t.job}`] = row
    const epochs = expectedEpochs(
      { cron: t.cron, everyMs: t.everyMs, nextMs },
      input.fromMs,
      input.toMs,
    )
    row.epochs = epochs.length
    epochTotal += epochs.length
    if (epochs.length === 0 || wanted.size === 0) continue
    const all = await enumerateFanoutOrgs(t.app)
    const eligibleAll = all.filter((o) => o.status === null || o.status === "active")
    const orgs = eligibleAll.map((o) => o.orgId).filter((id) => wanted.has(id))
    if (orgs.length === 0) continue

    let jobPct: number | null = null
    for (const epoch of epochs) {
      const gapMs = t.everyMs ?? nextGapMs(t.cron, epoch)
      // The tick sized its window on the orgs it ran (after `runsFor`); it
      // recorded that count. Without the record (a job with no `runsFor`):
      // every eligible org, as the tick does.
      // A watched epoch (the tick ran a load org) recorded that count and the
      // start of every org it ran, load or not.
      const [watchRaw, spreadRaw] = await redis.mget(
        fanoutWatchKey(t.app, t.job, epoch),
        fanoutSpreadOrgsKey(t.app, t.job, epoch),
      )
      const watchedOrgs = Number(watchRaw)
      const spreadOrgs =
        Number.isFinite(watchedOrgs) && watchedOrgs > 0 ? watchedOrgs : Number(spreadRaw)
      const windowMs = spreadWindowMs(
        gapMs,
        Number.isFinite(spreadOrgs) && spreadOrgs > 0 ? spreadOrgs : eligibleAll.length,
      )
      if (epoch + windowMs + FANOUT_REPORT_GRACE_MS > now) {
        row.notDue += orgs.length
        continue
      }
      const pipe = redis.pipeline()
      for (const orgId of orgs) {
        pipe.get(fanoutRunsKey(t.app, t.job, orgId, epoch))
        pipe.get(fanoutRunAtKey(t.app, t.job, orgId, epoch))
        pipe.exists(fanoutCoalescedKey(t.app, t.job, orgId, epoch))
        pipe.exists(fanoutSkippedKey(t.app, t.job, orgId, epoch))
      }
      const res = (await pipe.exec()) ?? []
      const offsets: number[] = []
      orgs.forEach((orgId, i) => {
        const [runsErr, runsRaw] = res[4 * i] ?? []
        if (runsErr) throw runsErr
        const runs = Number(runsRaw ?? 0)
        const runAt = res[4 * i + 1]?.[1]
        const coalesced = Number(res[4 * i + 2]?.[1] ?? 0) > 0
        const skipped = Number(res[4 * i + 3]?.[1] ?? 0) > 0
        if (skipped && runs === 0) {
          row.skippedRunsFor++
          return
        }
        row.expected++
        row.runs += runs
        if (runs === 0) {
          if (coalesced) row.coalesced++
          else {
            row.missed++
            if (missedRuns.length < MAX_LISTED)
              missedRuns.push({ app: t.app, job: t.job, orgId, epoch, runs })
          }
        } else if (runs > 1) {
          row.doubled++
          if (doubledRuns.length < MAX_LISTED)
            doubledRuns.push({ app: t.app, job: t.job, orgId, epoch, runs })
        }
        if (typeof runAt === "string") offsets.push(Number(runAt) - epoch)
      })
      // The spread is the tick's: judged on every org it ran when the epoch
      // was watched. The load orgs alone are a sample of its evenly spaced
      // ranks, and a sample of k of n ranks can hold 3 of its k in one tenth
      // where the tick holds ceil(n / 10) of n.
      const tickStarts =
        watchRaw === null ? [] : await redis.hvals(fanoutStartsKey(t.app, t.job, epoch))
      const starts =
        tickStarts.length >= offsets.length ? tickStarts.map((v) => Number(v) - epoch) : offsets
      if (starts.length >= MIN_SPREAD_SAMPLE) {
        row.spreadStarts += starts.length
        const pct = maxSlicePct(starts, windowMs)
        jobPct = Math.max(jobPct ?? 0, pct)
        slicePcts.push(pct)
      }
    }
    row.spreadMaxSlicePct = jobPct
  }

  const rows = Object.values(byJob)
  const sum = (
    k: "expected" | "runs" | "missed" | "doubled" | "coalesced" | "skippedRunsFor" | "notDue",
  ) => rows.reduce((a, r) => a + r[k], 0)
  const [schedulerTotal, metrics, waits, drain] = await Promise.all([
    fanoutReportTestState.schedulerTotal
      ? fanoutReportTestState.schedulerTotal()
      : getJobSchedulerTotal(),
    readJobMetrics(),
    readWaits(input),
    readDrain(input),
  ])
  return {
    window: { fromMs: input.fromMs, toMs: input.toMs },
    waitsWindow: waitHistogramSpan(input.fromMs, input.toMs),
    generatedAt: now,
    orgs: input.orgIds.length,
    schedulers: schedulerTotal,
    fanoutSchedulers: schedulers.length,
    byJob,
    totals: {
      epochs: epochTotal,
      expected: sum("expected"),
      runs: sum("runs"),
      missed: sum("missed"),
      doubled: sum("doubled"),
      coalesced: sum("coalesced"),
      skippedRunsFor: sum("skippedRunsFor"),
      notDue: sum("notDue"),
      spreadMaxSlicePct: slicePcts.length > 0 ? Math.max(...slicePcts) : null,
      spreadStarts: rows.reduce((a, r) => a + r.spreadStarts, 0),
    },
    missedRuns,
    doubledRuns,
    metrics,
    waits,
    drain,
  }
}

/** Test seams (tests only; production never sets them). */
const fanoutReportTestState: {
  schedulers?: () => Promise<ReportScheduler[]>
  schedulerTotal?: () => Promise<number>
} = {}

/** Test access to this module's sources. Production code never calls it. */
export const FanoutReportTestAccess = {
  /** Replace the scheduler read and the scheduler count; pass nothing to restore. */
  setSchedulers(
    schedulers?: () => Promise<ReportScheduler[]>,
    total?: () => Promise<number>,
  ): void {
    fanoutReportTestState.schedulers = schedulers
    fanoutReportTestState.schedulerTotal = total
  },
}
