// SPDX-License-Identifier: FSL-1.1-ALv2
//
// App-run health: always on, bounded memory. Every settled run
// (workers/run-settled.ts, the one sink runApp raises) is added to counters
// per (app, lane) in time buckets, in two places:
//
//  - this process: a minute bucket (the last 15 kept) and an hour bucket (the
//    last 24 kept), in memory. Each bucket holds at most MAX_SERIES series
//    (past it, the rest of a lane folds into `(other)`), so memory never grows
//    with the number of apps or orgs;
//  - the cell: the same counters added to Redis hashes every few seconds
//    (one pipeline per flush), cell-wide (`ah:m:<minute>`, `ah:h:<hour>`) and
//    per org (`ah:o:<org>:...`, what an org admin reads). Best effort: a
//    failed write is logged once and its counts are lost (diagnostics only).
//
// A series counts runs, errors and timeouts (by error kind), the wall time
// and the queue wait (the wait for a sandbox slot, when the executor reports
// one) as fixed-bucket histograms, and the bridge time of the runs that
// report one. Percentiles are bucket upper bounds (like the job wait
// histogram, infra/jobs/fairness.ts). The slowest runs are kept per bucket
// (app, entry, lane, wall, queue wait, error kind; never arguments or data).
//
// Pool occupancy: each executor that holds a bounded pool in this process
// registers a gauge (run-pool-gauges.ts); a 1 s sampler adds the occupancy
// and whether the pool was saturated (all slots busy and a run waiting) to
// the same buckets, and keeps the current saturated streak.
//
// Read by /diag (`appRuns`, modules/monitor), the admin read
// (GET /api/admin/app-health) and, opted in, the performance report to the
// Liaison team.

import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { entryKindOf } from "~/modules/apps/run-limits"
import {
  onRunSettled,
  type RunSettledInfo,
  TIMEOUT_ERROR_KINDS,
} from "~/modules/apps/workers/run-settled"

const log = rootLogger.child({ module: "app-run-health" })

/** `nested`: a run another run started (it holds no slot of its own). */
export type RunHealthLane = "interactive" | "background" | "nested"
export const RUN_HEALTH_LANES: readonly RunHealthLane[] = ["interactive", "background", "nested"]

/** The windows the health is read over. */
export type RunHealthWindow = "15m" | "24h"
const MINUTES = 15
const HOURS = 24

/** Wall and queue histogram upper bounds (ms); one more bucket holds what lies past the top. */
export const RUN_HEALTH_BUCKETS_MS = [
  25, 50, 100, 250, 500, 1_000, 2_000, 3_000, 5_000, 7_500, 10_000, 15_000, 20_000, 30_000, 60_000,
  120_000,
] as const
/** A percentile past the top bucket reads as one ms above it. */
export const RUN_HEALTH_ABOVE_TOP_MS = 120_001

const MAX_SERIES = 300
const MAX_KINDS = 16
const SLOW_PER_MINUTE = 5
const SLOW_PER_HOUR = 10
const SLOW_SHOWN = 10
/** Rows a window view lists (the busiest series first). */
const MAX_ROWS = 50
const FLUSH_INTERVAL_MS = 5_000
const SAMPLE_INTERVAL_MS = 1_000
const MINUTE_KEY_TTL_S = 20 * 60
const HOUR_KEY_TTL_S = 25 * 3600
const OTHER = "(other)"

// -- Lane ------------------------------------------------------------------------

/** Entry kinds nobody waits on (run-limits.ts entry kinds). */
const BACKGROUND_KINDS: ReadonlySet<string> = new Set([
  "webhook",
  "job",
  "event",
  "poll",
  "reconcile",
  "import",
  "import-transform",
  "knowledge-sync",
])

/**
 * The lane a run is counted in: `nested` for a run another run started,
 * else the lane the run reported (`lane`, when the executor sets one), else
 * its entry kind's: background for jobs, events, webhooks, polls, syncs and
 * imports, interactive for the rest (tools, attention, previews, ...).
 */
export function runHealthLaneOf(
  info: Pick<RunSettledInfo, "entry" | "nested"> & { lane?: string },
): RunHealthLane {
  if (info.nested) return "nested"
  if (info.lane === "interactive" || info.lane === "background") return info.lane
  const kind = entryKindOf(info.entry)
  return kind !== null && BACKGROUND_KINDS.has(kind) ? "background" : "interactive"
}

/**
 * The run's wait for a sandbox slot (ms), when its executor reported one:
 * the Workers admission's (`admissionMs`), the sandbox service's
 * (`loader.queueMs`) or a total (`queueMs`). Undefined when none did.
 */
export function runQueueWaitOf(info: RunSettledInfo): number | undefined {
  const i = info as RunSettledInfo & {
    queueMs?: number
    admissionMs?: number
    loader?: { queueMs?: number }
  }
  if (typeof i.queueMs === "number") return Math.max(0, i.queueMs)
  const parts = [i.admissionMs, i.loader?.queueMs].filter(
    (n): n is number => typeof n === "number" && Number.isFinite(n),
  )
  if (parts.length === 0) return undefined
  return Math.max(
    0,
    parts.reduce((a, b) => a + b, 0),
  )
}

// -- Counters --------------------------------------------------------------------
//
// One series is a flat map of additive counters, the same in memory and in a
// Redis hash (field `<app>|<lane>|<metric>`, pools `pool|<name>|<metric>`):
//   r runs, e errors, t timeouts, k.<kind> failures of a kind,
//   w<i> wall histogram, ws wall sum, q<i> queue histogram, qn runs with a
//   queue figure, qs queue sum, bn runs with a bridge figure, bw their wall,
//   bm their bridge ms, bc bridge calls;
//   pools: s samples, sat saturated samples, bs busy sum, cs capacity sum.

type Counters = Record<string, number>

export interface SlowRun {
  app: string
  entry: string
  lane: RunHealthLane
  executor: RunSettledInfo["executor"]
  ms: number
  queueMs?: number
  ok: boolean
  errorKind?: string
  at: number
}

interface Bucket {
  series: Map<string, Counters>
  slow: SlowRun[]
}

function bucketIndex(ms: number): number {
  for (let i = 0; i < RUN_HEALTH_BUCKETS_MS.length; i++) {
    if (ms <= (RUN_HEALTH_BUCKETS_MS[i] as number)) return i
  }
  return RUN_HEALTH_BUCKETS_MS.length
}

/** A name safe inside a counter field (no `|`, bounded). */
function fieldSafe(s: string): string {
  return s.replace(/[|\s]/g, "_").slice(0, 80)
}

/** The counters one settled run adds. */
export function countersOfRun(info: RunSettledInfo): Counters {
  const c: Counters = { r: 1 }
  const ms = Math.max(0, Math.trunc(info.ms))
  c[`w${bucketIndex(ms)}`] = 1
  c.ws = ms
  if (!info.ok) {
    c.e = 1
    const kind = fieldSafe(info.errorKind ?? "handler").slice(0, 40)
    c[`k.${kind}`] = 1
    if (TIMEOUT_ERROR_KINDS.has(kind)) c.t = 1
  }
  const q = runQueueWaitOf(info)
  if (q !== undefined) {
    const qms = Math.trunc(q)
    c.qn = 1
    c.qs = qms
    c[`q${bucketIndex(qms)}`] = 1
  }
  const bridgeMs = info.loader?.bridgeMsTotal
  if (typeof bridgeMs === "number" && Number.isFinite(bridgeMs)) {
    c.bn = 1
    c.bw = ms
    c.bm = Math.max(0, Math.trunc(bridgeMs))
  }
  const calls = info.bridgeCalls ?? info.loader?.bridgeCalls
  if (typeof calls === "number" && calls > 0) c.bc = Math.trunc(calls)
  return c
}

function addInto(target: Counters, add: Readonly<Counters>): void {
  let kinds = 0
  for (const k of Object.keys(target)) if (k.startsWith("k.")) kinds++
  for (const [k, n] of Object.entries(add)) {
    if (k.startsWith("k.") && target[k] === undefined && kinds >= MAX_KINDS) {
      target["k.other"] = (target["k.other"] ?? 0) + n
      continue
    }
    if (k.startsWith("k.") && target[k] === undefined) kinds++
    target[k] = (target[k] ?? 0) + n
  }
}

// -- This process ----------------------------------------------------------------

const minutes = new Map<number, Bucket>()
const hours = new Map<number, Bucket>()

const minuteOf = (ms: number) => Math.floor(ms / 60_000)
const hourOf = (ms: number) => Math.floor(ms / 3_600_000)

function bucketAt(map: Map<number, Bucket>, at: number, keep: number): Bucket {
  let b = map.get(at)
  if (!b) {
    b = { series: new Map(), slow: [] }
    map.set(at, b)
    for (const k of map.keys()) if (k <= at - keep) map.delete(k)
  }
  return b
}

function addSeries(b: Bucket, key: string, add: Readonly<Counters>, fold: string): void {
  let s = b.series.get(key)
  if (!s) {
    if (b.series.size >= MAX_SERIES) {
      s = b.series.get(fold) ?? {}
      b.series.set(fold, s)
    } else {
      s = {}
      b.series.set(key, s)
    }
  }
  addInto(s, add)
}

function keepSlow(list: SlowRun[], run: SlowRun, max: number): void {
  if (list.length >= max && (list[list.length - 1] as SlowRun).ms >= run.ms) return
  list.push(run)
  list.sort((a, b) => b.ms - a.ms)
  if (list.length > max) list.length = max
}

function slowOf(info: RunSettledInfo, lane: RunHealthLane): SlowRun {
  const q = runQueueWaitOf(info)
  return {
    app: info.app,
    entry: info.entry,
    lane,
    executor: info.executor,
    ms: Math.max(0, Math.trunc(info.ms)),
    ...(q !== undefined ? { queueMs: Math.trunc(q) } : {}),
    ok: info.ok,
    ...(!info.ok && info.errorKind ? { errorKind: info.errorKind } : {}),
    at: info.at,
  }
}

// -- Cell (Redis) ----------------------------------------------------------------

const pendingHashes = new Map<string, { ttl: number; fields: Counters }>()
const pendingSlow = new Map<string, SlowRun[]>()
let writeFailed = false

function stamp(ms: number, unit: "m" | "h"): string {
  const iso = new Date(ms).toISOString()
  return unit === "m"
    ? iso.slice(0, 16).replace(/[-T:]/g, "")
    : iso.slice(0, 13).replace(/[-T]/g, "")
}

export const RunHealthKeys = {
  minute: (at: number, orgId?: string) => `ah:${orgId ? `o:${orgId}:` : ""}m:${stamp(at, "m")}`,
  hour: (at: number, orgId?: string) => `ah:${orgId ? `o:${orgId}:` : ""}h:${stamp(at, "h")}`,
  slow: (at: number, orgId?: string) => `ah:${orgId ? `o:${orgId}:` : ""}s:${stamp(at, "h")}`,
}

function queueHash(key: string, ttl: number, prefix: string, add: Readonly<Counters>): void {
  let h = pendingHashes.get(key)
  if (!h) {
    h = { ttl, fields: {} }
    pendingHashes.set(key, h)
  }
  for (const [k, n] of Object.entries(add)) {
    const f = `${prefix}|${k}`
    h.fields[f] = (h.fields[f] ?? 0) + n
  }
}

function queueSlow(key: string, run: SlowRun): void {
  const list = pendingSlow.get(key) ?? []
  keepSlow(list, run, SLOW_PER_HOUR)
  pendingSlow.set(key, list)
}

/** Write the pending counters: one pipeline. Never throws. */
export async function flushRunHealth(): Promise<void> {
  if (pendingHashes.size === 0 && pendingSlow.size === 0) return
  const hashes = [...pendingHashes.entries()]
  const slow = [...pendingSlow.entries()]
  pendingHashes.clear()
  pendingSlow.clear()
  try {
    const pipe = redis.pipeline()
    for (const [key, { ttl, fields }] of hashes) {
      for (const [f, n] of Object.entries(fields)) pipe.hincrby(key, f, n)
      pipe.expire(key, ttl)
    }
    for (const [key, runs] of slow) {
      for (const r of runs) pipe.zadd(key, r.ms, JSON.stringify(r))
      pipe.zremrangebyrank(key, 0, -(SLOW_PER_HOUR + 1))
      pipe.expire(key, HOUR_KEY_TTL_S)
    }
    await pipe.exec()
    writeFailed = false
  } catch (err) {
    if (!writeFailed) {
      writeFailed = true
      log.warn({ err }, "app run health: counters could not be written to Redis; they are lost")
    }
  }
}

// -- Recording -------------------------------------------------------------------

/** Add one settled run (this process's buckets and the next Redis flush). */
export function recordRunHealth(info: RunSettledInfo): void {
  if (info.executor === "inprocess") return
  const lane = runHealthLaneOf(info)
  const app = fieldSafe(info.app)
  const add = countersOfRun(info)
  const key = `${app}|${lane}`
  const fold = `${OTHER}|${lane}`
  const at = info.at
  const m = bucketAt(minutes, minuteOf(at), MINUTES)
  const h = bucketAt(hours, hourOf(at), HOURS)
  addSeries(m, key, add, fold)
  addSeries(h, key, add, fold)
  const slow = slowOf(info, lane)
  keepSlow(m.slow, slow, SLOW_PER_MINUTE)
  keepSlow(h.slow, slow, SLOW_PER_HOUR)
  queueHash(RunHealthKeys.minute(at), MINUTE_KEY_TTL_S, key, add)
  queueHash(RunHealthKeys.hour(at), HOUR_KEY_TTL_S, key, add)
  queueSlow(RunHealthKeys.slow(at), slow)
  queueHash(RunHealthKeys.minute(at, info.orgId), MINUTE_KEY_TTL_S, key, add)
  queueHash(RunHealthKeys.hour(at, info.orgId), HOUR_KEY_TTL_S, key, add)
  queueSlow(RunHealthKeys.slow(at, info.orgId), slow)
}

// -- Pool gauges -----------------------------------------------------------------

export interface PoolGaugeReading {
  busy: number
  capacity: number
  /** All slots busy and at least one run waiting for one. */
  saturated: boolean
}

const gauges = new Map<string, () => PoolGaugeReading | null>()
const streaks = new Map<string, { since: number | null; longestSec: number }>()

/** Register a pool's gauge (a reading, or null while the pool does not exist). */
export function registerRunPoolGauge(name: string, read: () => PoolGaugeReading | null): void {
  gauges.set(fieldSafe(name), read)
}

/** One sample of every gauge (the sampler calls it every second). */
export function samplePools(now: number = Date.now()): void {
  for (const [name, read] of gauges) {
    let r: PoolGaugeReading | null = null
    try {
      r = read()
    } catch {
      r = null
    }
    if (!r) continue
    const add: Counters = {
      s: 1,
      bs: Math.max(0, r.busy),
      cs: Math.max(0, r.capacity),
      ...(r.saturated ? { sat: 1 } : {}),
    }
    const key = `pool|${name}`
    addSeries(bucketAt(minutes, minuteOf(now), MINUTES), key, add, key)
    addSeries(bucketAt(hours, hourOf(now), HOURS), key, add, key)
    queueHash(RunHealthKeys.minute(now), MINUTE_KEY_TTL_S, key, add)
    queueHash(RunHealthKeys.hour(now), HOUR_KEY_TTL_S, key, add)
    const st = streaks.get(name) ?? { since: null, longestSec: 0 }
    if (r.saturated) {
      st.since ??= now
      st.longestSec = Math.max(st.longestSec, Math.round((now - st.since) / 1000))
    } else {
      st.since = null
    }
    streaks.set(name, st)
  }
}

// -- Views -----------------------------------------------------------------------

export interface RunHealthSummary {
  runs: number
  errors: number
  timeouts: number
  errorRate: number
  timeoutRate: number
  /** Failures per error kind (runErrorKindOf, or the Workers loader's). */
  errorKinds: Record<string, number>
  p50Ms: number | null
  p95Ms: number | null
  p99Ms: number | null
  meanMs: number | null
  /** Runs whose executor reported a queue wait. */
  queuedRuns: number
  queueP95Ms: number | null
  /** Bridge time over wall time, for the runs that report their bridge time. */
  bridgeShare: number | null
  bridgeCalls: number
}

export interface RunHealthRow extends RunHealthSummary {
  app: string
  lane: RunHealthLane
}

export interface PoolHealth {
  /** Seconds the pool was saturated (summed over processes, cell-wide). */
  saturatedSec: number
  /** Mean busy slots over capacity, 0..1. */
  occupancy: number | null
  /** This process only: how long the pool has been saturated right now (0 when not). */
  saturatedNowSec?: number
}

export interface RunHealthWindowView {
  windowS: number
  total: RunHealthSummary
  lanes: Record<RunHealthLane, RunHealthSummary>
  /** The busiest (app, lane) series, at most 50. */
  apps: RunHealthRow[]
  appsTruncated: boolean
  slowest: SlowRun[]
  pools: Record<string, PoolHealth>
}

export type RunHealthView = Record<RunHealthWindow, RunHealthWindowView>

function percentile(
  c: Readonly<Counters>,
  prefix: "w" | "q",
  total: number,
  p: number,
): number | null {
  if (total <= 0) return null
  let acc = 0
  for (let i = 0; i <= RUN_HEALTH_BUCKETS_MS.length; i++) {
    acc += c[`${prefix}${i}`] ?? 0
    if (acc >= p * total) {
      return i === RUN_HEALTH_BUCKETS_MS.length
        ? RUN_HEALTH_ABOVE_TOP_MS
        : (RUN_HEALTH_BUCKETS_MS[i] as number)
    }
  }
  return null
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000

export function summaryOf(c: Readonly<Counters>): RunHealthSummary {
  const runs = c.r ?? 0
  const errors = c.e ?? 0
  const timeouts = c.t ?? 0
  const errorKinds: Record<string, number> = {}
  for (const [k, n] of Object.entries(c))
    if (k.startsWith("k.") && n > 0) errorKinds[k.slice(2)] = n
  const qn = c.qn ?? 0
  const bw = c.bw ?? 0
  return {
    runs,
    errors,
    timeouts,
    errorRate: runs > 0 ? round4(errors / runs) : 0,
    timeoutRate: runs > 0 ? round4(timeouts / runs) : 0,
    errorKinds,
    p50Ms: percentile(c, "w", runs, 0.5),
    p95Ms: percentile(c, "w", runs, 0.95),
    p99Ms: percentile(c, "w", runs, 0.99),
    meanMs: runs > 0 ? Math.round((c.ws ?? 0) / runs) : null,
    queuedRuns: qn,
    queueP95Ms: percentile(c, "q", qn, 0.95),
    bridgeShare: bw > 0 ? round4(Math.min(1, (c.bm ?? 0) / bw)) : null,
    bridgeCalls: c.bc ?? 0,
  }
}

/** A window's view from its summed series (`app|lane` and `pool|name` keys). */
export function viewOf(
  series: ReadonlyMap<string, Counters>,
  slow: readonly SlowRun[],
  windowS: number,
): RunHealthWindowView {
  const total: Counters = {}
  const lanes: Record<RunHealthLane, Counters> = { interactive: {}, background: {}, nested: {} }
  const rows: RunHealthRow[] = []
  const pools: Record<string, PoolHealth> = {}
  for (const [key, c] of series) {
    const cut = key.lastIndexOf("|")
    const head = key.slice(0, cut)
    const tail = key.slice(cut + 1)
    if (head === "pool") {
      const cs = c.cs ?? 0
      pools[tail] = {
        saturatedSec: c.sat ?? 0,
        occupancy: cs > 0 ? round4((c.bs ?? 0) / cs) : null,
      }
      continue
    }
    if (!(RUN_HEALTH_LANES as readonly string[]).includes(tail)) continue
    const lane = tail as RunHealthLane
    addInto(total, c)
    addInto(lanes[lane], c)
    rows.push({ app: head, lane, ...summaryOf(c) })
  }
  rows.sort((a, b) => b.runs - a.runs || (b.p95Ms ?? 0) - (a.p95Ms ?? 0))
  return {
    windowS,
    total: summaryOf(total),
    lanes: {
      interactive: summaryOf(lanes.interactive),
      background: summaryOf(lanes.background),
      nested: summaryOf(lanes.nested),
    },
    apps: rows.slice(0, MAX_ROWS),
    appsTruncated: rows.length > MAX_ROWS,
    slowest: [...slow].sort((a, b) => b.ms - a.ms).slice(0, SLOW_SHOWN),
    pools,
  }
}

function sumBuckets(
  buckets: Iterable<Bucket>,
  sinceMs: number,
): {
  series: Map<string, Counters>
  slow: SlowRun[]
} {
  const series = new Map<string, Counters>()
  const slow: SlowRun[] = []
  for (const b of buckets) {
    for (const [k, c] of b.series) {
      const s = series.get(k) ?? {}
      addInto(s, c)
      series.set(k, s)
    }
    for (const r of b.slow) if (r.at >= sinceMs) keepSlow(slow, r, SLOW_SHOWN)
  }
  return { series, slow }
}

/** This process's health over both windows. */
export function processRunHealth(now: number = Date.now()): RunHealthView {
  const m0 = minuteOf(now) - MINUTES
  const h0 = hourOf(now) - HOURS
  const m = sumBuckets(
    [...minutes.entries()].filter(([k]) => k > m0).map(([, b]) => b),
    now - MINUTES * 60_000,
  )
  const h = sumBuckets(
    [...hours.entries()].filter(([k]) => k > h0).map(([, b]) => b),
    now - HOURS * 3_600_000,
  )
  const v15 = viewOf(m.series, m.slow, MINUTES * 60)
  for (const [name, st] of streaks) {
    const pool = v15.pools[name]
    if (pool) pool.saturatedNowSec = st.since === null ? 0 : Math.round((now - st.since) / 1000)
  }
  return { "15m": v15, "24h": viewOf(h.series, h.slow, HOURS * 3600) }
}

function parseHash(h: Record<string, string>, into: Map<string, Counters>): void {
  for (const [field, raw] of Object.entries(h)) {
    const cut = field.lastIndexOf("|")
    if (cut <= 0) continue
    const key = field.slice(0, cut)
    const metric = field.slice(cut + 1)
    const n = Number(raw)
    if (!Number.isFinite(n)) continue
    const c = into.get(key) ?? {}
    c[metric] = (c[metric] ?? 0) + n
    into.set(key, c)
  }
}

/**
 * The cell's health over both windows, from Redis: the whole cell, or one
 * org's runs (`orgId`; no pools, those are the cell's). Throws when Redis
 * does not answer (the caller bounds the wait).
 */
export async function cellRunHealth(
  opts: { orgId?: string; now?: number } = {},
): Promise<RunHealthView> {
  const now = opts.now ?? Date.now()
  const pipe = redis.pipeline()
  for (let i = 0; i < MINUTES; i++) pipe.hgetall(RunHealthKeys.minute(now - i * 60_000, opts.orgId))
  for (let i = 0; i < HOURS; i++) pipe.hgetall(RunHealthKeys.hour(now - i * 3_600_000, opts.orgId))
  for (let i = 0; i < HOURS; i++) {
    pipe.zrevrange(RunHealthKeys.slow(now - i * 3_600_000, opts.orgId), 0, SLOW_SHOWN - 1)
  }
  const res = (await pipe.exec()) ?? []
  const m = new Map<string, Counters>()
  const h = new Map<string, Counters>()
  const slow15: SlowRun[] = []
  const slow24: SlowRun[] = []
  res.forEach(([err, value], i) => {
    if (err || !value) return
    if (i < MINUTES) parseHash(value as Record<string, string>, m)
    else if (i < MINUTES + HOURS) parseHash(value as Record<string, string>, h)
    else {
      for (const raw of value as string[]) {
        try {
          const r = JSON.parse(raw) as SlowRun
          keepSlow(slow24, r, SLOW_SHOWN)
          if (r.at >= now - MINUTES * 60_000) keepSlow(slow15, r, SLOW_SHOWN)
        } catch {
          // A member that is not ours: skipped.
        }
      }
    }
  })
  return {
    "15m": viewOf(m, slow15, MINUTES * 60),
    "24h": viewOf(h, slow24, HOURS * 3600),
  }
}

// -- Lifecycle -------------------------------------------------------------------

let unsubscribe: (() => void) | null = null
let flushTimer: ReturnType<typeof setInterval> | null = null
let sampleTimer: ReturnType<typeof setInterval> | null = null

/** Subscribe to settled runs, sample the pools and flush to Redis on timers. Idempotent. */
export function startRunHealth(): void {
  if (unsubscribe) return
  unsubscribe = onRunSettled(recordRunHealth)
  flushTimer = setInterval(() => void flushRunHealth(), FLUSH_INTERVAL_MS)
  flushTimer.unref?.()
  sampleTimer = setInterval(() => samplePools(), SAMPLE_INTERVAL_MS)
  sampleTimer.unref?.()
}

/** Stop and write what is pending (shutdown, tests). */
export async function stopRunHealth(): Promise<void> {
  unsubscribe?.()
  unsubscribe = null
  if (flushTimer) clearInterval(flushTimer)
  if (sampleTimer) clearInterval(sampleTimer)
  flushTimer = null
  sampleTimer = null
  await flushRunHealth()
}

/** Test seams. */
export const RunHealthTestAccess = {
  clear(): void {
    minutes.clear()
    hours.clear()
    pendingHashes.clear()
    pendingSlow.clear()
    streaks.clear()
    gauges.clear()
  },
  pendingKeys(): string[] {
    return [...pendingHashes.keys(), ...pendingSlow.keys()]
  },
}
