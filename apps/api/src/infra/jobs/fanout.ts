// SPDX-License-Identifier: FSL-1.1-ALv2
// Cron fan-out: one scheduler per (app, job), never one per workspace.
//
// A manifest job with a `schedule` is one BullMQ scheduler on `kernel-cron`
// (`app-cron-fanout:<app>:<job>`), whatever the number of workspaces. Each of
// its ticks lists the workspaces with the app on and enqueues one job per
// workspace on `app-<app>`, spread over a window so they do not all start on
// the cron boundary.
//
// EXACTLY ONCE PER (ORG, EPOCH). The epoch is the tick's scheduled fire time.
// A per-org job's BullMQ id is `fo.<app>.<job>.<orgId>.<epoch>`: BullMQ's add
// ignores an id that exists in any state, so a tick re-run after a crash (or a
// second worker running the same tick) adds nothing new. A marker written
// after the add only saves that re-run the add round trip.
//
// COALESCE. An org whose previous job of the same (app, job) has not started
// yet gets no second one: a cron is catch-up work and must not pile up.
import { CronExpressionParser } from "cron-parser"

/** The one kernel job every fan-out tick runs under (its data names the app and job). */
export const APP_CRON_FANOUT_JOB = "app-cron-fanout"
/** The spread window never exceeds 5 min, so a daily job keeps its time of day. */
export const FANOUT_MAX_WINDOW_MS = 300_000
/** Each org adds at most this much to the window: one org starts within 2 s. */
export const FANOUT_WINDOW_PER_ORG_MS = 2_000
/** Retained finished fan-out jobs (and markers) never live less than this. */
export const FANOUT_MIN_RETENTION_MS = 600_000

/**
 * FNV-1a over a string -> unsigned 32-bit. Stable across runs and processes,
 * so an org always takes the same place in a job's spread.
 */
export function fnv1a(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** The part of a scheduler-minted BullMQ job the epoch is read from. */
export interface FanoutTickJob {
  id?: string
  opts?: { prevMillis?: number }
}

/**
 * The tick's epoch: its scheduled fire time. BullMQ stamps it as
 * `opts.prevMillis`; the scheduler's job id `repeat:<schedulerId>:<millis>`
 * carries it too. Throws for a job no scheduler minted.
 */
export function fanoutEpoch(job: FanoutTickJob): number {
  const prev = job.opts?.prevMillis
  if (typeof prev === "number" && Number.isFinite(prev) && prev > 0) return prev
  const id = job.id ?? ""
  if (id.startsWith("repeat:")) {
    const millis = Number(id.slice(id.lastIndexOf(":") + 1))
    if (Number.isSafeInteger(millis) && millis > 0) return millis
  }
  throw new Error(`fan-out tick ${id || "(no id)"} carries no scheduled fire time`)
}

/** The tick's epoch, or undefined for a job no scheduler minted. */
export function fanoutEpochOrUndefined(job: FanoutTickJob): number | undefined {
  try {
    return fanoutEpoch(job)
  } catch {
    return undefined
  }
}

/** Time from `epoch` to the cron's next fire after it, in UTC. */
export function nextGapMs(cron: string, epoch: number): number {
  const it = CronExpressionParser.parse(cron, { tz: "UTC", currentDate: new Date(epoch) })
  return it.next().getTime() - epoch
}

/** The spread window: min(80 % of the gap, 5 min, 2 s per org). */
export function spreadWindowMs(gapMs: number, orgCount: number): number {
  return Math.max(
    0,
    Math.floor(Math.min(0.8 * gapMs, FANOUT_MAX_WINDOW_MS, orgCount * FANOUT_WINDOW_PER_ORG_MS)),
  )
}

/** How long a finished fan-out job and its marker stay: max(2 × gap, 10 min). */
export function retentionMs(gapMs: number): number {
  return Math.max(2 * gapMs, FANOUT_MIN_RETENTION_MS)
}

/**
 * Each org's start delay within the window, by rank: orgs ordered by a hash of
 * (org, app, job), org i of n starts at floor((i + φ) / n × W), φ a per-job
 * phase. Evenly spaced by construction (no hash clumps), stable for a given
 * set, and a new org moves every other one by at most W / n.
 */
export function spreadDelays(
  orgIds: readonly string[],
  app: string,
  job: string,
  windowMs: number,
): Map<string, number> {
  const out = new Map<string, number>()
  const n = orgIds.length
  if (n === 0) return out
  const phase = fnv1a(`${app}:${job}`) / 2 ** 32
  const ranked = orgIds
    .map((orgId) => ({ orgId, key: fnv1a(`${orgId}:${app}:${job}`) }))
    .sort((a, b) => a.key - b.key || (a.orgId < b.orgId ? -1 : a.orgId > b.orgId ? 1 : 0))
  ranked.forEach(({ orgId }, i) => {
    out.set(orgId, Math.min(windowMs - 1, Math.floor(((i + phase) / n) * windowMs)))
  })
  if (windowMs <= 0) for (const k of out.keys()) out.set(k, 0)
  return out
}

const ID_PART = /^[A-Za-z0-9_-]+$/

function assertIdPart(kind: string, value: string): void {
  if (!ID_PART.test(value)) throw new Error(`fan-out ${kind} "${value}" cannot form a job id`)
}

/** The per-org job's BullMQ id. No `:` (BullMQ refuses it in a custom id). */
export function fanoutJobId(app: string, job: string, orgId: string, epoch: number): string {
  assertIdPart("app", app)
  assertIdPart("job", job)
  assertIdPart("org", orgId)
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error(`fan-out epoch ${epoch} invalid`)
  return `fo.${app}.${job}.${orgId}.${epoch}`
}

/** The parts of a fan-out job id, or null for any other id. */
export function parseFanoutJobId(
  id: string,
): { app: string; job: string; orgId: string; epoch: number } | null {
  const parts = id.split(".")
  if (parts.length !== 5 || parts[0] !== "fo") return null
  const [, app, job, orgId, epochRaw] = parts as [string, string, string, string, string]
  const epoch = Number(epochRaw)
  if (!ID_PART.test(app) || !ID_PART.test(job) || !ID_PART.test(orgId)) return null
  if (!Number.isSafeInteger(epoch) || epoch < 0) return null
  return { app, job, orgId, epoch }
}

/** The one scheduler of an (app, job) on `kernel-cron`. */
export function fanoutSchedulerId(app: string, job: string): string {
  return `${APP_CRON_FANOUT_JOB}:${app}:${job}`
}

/** A pre-fan-out per-org scheduler id: `<job>-scheduler-<orgId>`. */
export const LEGACY_PER_ORG_SCHEDULER_RE =
  /-scheduler-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// --- The load harness's fan-out report (fanout-report.ts) -------------------

/** Most epochs one (app, job) report enumerates (an every-minute cron over a day is 1 440). */
const MAX_REPORT_EPOCHS = 2_000

/**
 * The epochs a fan-out scheduler fired (or will fire) in `[fromMs, toMs]`: the
 * cron's fire times in UTC, or, for an interval scheduler (the test seam's
 * `every`), its next fire stepped back by the interval.
 */
export function expectedEpochs(
  s: { cron?: string; everyMs?: number; nextMs?: number },
  fromMs: number,
  toMs: number,
): number[] {
  const out: number[] = []
  if (toMs < fromMs) return out
  if (s.everyMs && s.everyMs > 0) {
    if (s.nextMs === undefined) return out
    const k0 = Math.ceil((s.nextMs - toMs) / s.everyMs)
    for (let t = s.nextMs - Math.max(0, k0) * s.everyMs; t >= fromMs; t -= s.everyMs) {
      if (t <= toMs) out.unshift(t)
      if (out.length >= MAX_REPORT_EPOCHS) break
    }
    return out
  }
  if (!s.cron) return out
  const it = CronExpressionParser.parse(s.cron, { tz: "UTC", currentDate: new Date(fromMs - 1) })
  for (;;) {
    const t = it.next().getTime()
    if (t > toMs || out.length >= MAX_REPORT_EPOCHS) break
    out.push(t)
  }
  return out
}

/**
 * S16's spread figure for one epoch: the share (%) of its runs that started in
 * the busiest tenth of the spread window, from each run's start offset after
 * the epoch. A start past the window counts in the last tenth. 0 with no runs.
 */
export function maxSlicePct(offsetsMs: readonly number[], windowMs: number): number {
  if (offsetsMs.length === 0) return 0
  if (windowMs <= 0) return 100
  const slices = new Array<number>(10).fill(0)
  for (const o of offsetsMs) {
    const i = Math.min(9, Math.max(0, Math.floor((o / windowMs) * 10)))
    slices[i] = (slices[i] ?? 0) + 1
  }
  return Math.round((Math.max(...slices) / offsetsMs.length) * 1000) / 10
}
