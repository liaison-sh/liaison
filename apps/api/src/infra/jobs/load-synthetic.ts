// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The load harness's synthetic job (`kernel` / `load-synthetic`, class
 * `agent`): what a fairness flood enqueues instead of real agent work. It
 * holds a worker slot for `sleepMs` (at most 2 s, cut short by the shutdown
 * abort) and counts each run per org in Redis, so a run can read per org how
 * many ran, how many ran at once and how long each waited in the queue.
 *
 * It runs only for a load org (lib/load-harness.ts): any other org's job is
 * refused before it sleeps or counts anything, so no ordinary workspace can be
 * made to burn worker slots through it.
 *
 * Counters (24 h TTL), per org:
 * - `load:synthetic:<orgId>` hash: `runs`, `failed`, `inflight`, `maxInflight`, and
 *   `enqueued` (what the harness flood reserved; outstanding = enqueued - runs).
 *   A run that fails for good (not one handed back by a drain, which reruns)
 *   counts in `runs` and `failed` too, so it never stays outstanding; a job
 *   removed from its queue does, until the flood's `reset`.
 * - `load:synthetic:waits:<orgId>` list: each run's wait (start - `queuedAt`), ms.
 * - `load:synthetic:done:<orgId>` hash: completions per epoch second.
 * - `load:synthetic:timing:<orgId>` list: per completed run, `<second>:<dispatch>:<lag>`:
 *   its completion second, the ms from the worker taking the job (BullMQ
 *   `processedOn`) to the handler's start (the fairness gate, the org checks and
 *   any event-loop wait in between), and the ms its sleep overran (a timer late
 *   by this much: the process's event loop was busy or paused, e.g. by GC). The
 *   fan-out report reads them to say where a slot's time went (`drain`).
 */
import { isLoadOrg } from "~/lib/load-harness"
import { redis } from "~/lib/redis"
import { registerJobWorker } from "./jobs"

export const LOAD_SYNTHETIC_JOB = "load-synthetic"
export const LOAD_SYNTHETIC_MAX_SLEEP_MS = 2_000
const TTL_S = 24 * 3600

export interface LoadSyntheticPayload {
  orgId: string
  sleepMs: number
  /** When the job was enqueued (ms): its wait is measured from here. */
  queuedAt: number
}

export interface LoadSyntheticStats {
  runs: number
  /** Runs that failed for good (also counted in `runs`). */
  failed: number
  inflight: number
  maxInflight: number
  waitsMs: number[]
  /** Completions per epoch second. */
  donePerSecond: Record<string, number>
  /** Per completed run: completion second, dispatch ms, sleep overrun ms (see the header). */
  timings: LoadSyntheticTiming[]
}

export interface LoadSyntheticTiming {
  /** Epoch second the run completed in. */
  second: number
  /** Worker took the job (BullMQ `processedOn`) to the handler's start, ms. */
  dispatchMs: number
  /** How late the sleep's timer fired, ms. */
  lagMs: number
}

const statsKey = (orgId: string) => `load:synthetic:${orgId}`
const waitsKey = (orgId: string) => `load:synthetic:waits:${orgId}`
const doneKey = (orgId: string) => `load:synthetic:done:${orgId}`
const timingKey = (orgId: string) => `load:synthetic:timing:${orgId}`

// KEYS[1] stats hash. Raise inflight and keep its peak.
const START_LUA = `
local n = redis.call('HINCRBY', KEYS[1], 'inflight', 1)
local m = tonumber(redis.call('HGET', KEYS[1], 'maxInflight') or '0')
if n > m then redis.call('HSET', KEYS[1], 'maxInflight', n) end
redis.call('EXPIRE', KEYS[1], ARGV[1])
return n
`

// KEYS[1] stats hash. ARGV: count, cap, ttl. Reserve `count` more jobs unless
// the outstanding ones (enqueued - runs) would pass the cap.
const RESERVE_LUA = `
local e = tonumber(redis.call('HGET', KEYS[1], 'enqueued') or '0')
local r = tonumber(redis.call('HGET', KEYS[1], 'runs') or '0')
if e - r + tonumber(ARGV[1]) > tonumber(ARGV[2]) then return 0 end
redis.call('HINCRBY', KEYS[1], 'enqueued', ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
`

/**
 * Reserve `count` synthetic jobs for a flood of this org, unless its
 * outstanding jobs (reserved, not yet run to the end) would pass `cap`.
 */
export async function reserveLoadSyntheticJobs(
  orgId: string,
  count: number,
  cap: number,
): Promise<boolean> {
  return (await redis.eval(RESERVE_LUA, 1, statsKey(orgId), count, cap, TTL_S)) === 1
}

/**
 * Forget this org's outstanding synthetic jobs (the flood route's `reset`):
 * the enqueued count drops to the runs counted so far. For jobs that left
 * their queue without running (removed, drained away).
 */
export async function resetLoadSyntheticOutstanding(orgId: string): Promise<void> {
  const runs = (await redis.hget(statsKey(orgId), "runs")) ?? "0"
  await redis.hset(statsKey(orgId), "enqueued", runs)
}

/** Give back a reservation's jobs that were never enqueued. */
export async function releaseLoadSyntheticReservation(orgId: string, count: number): Promise<void> {
  if (count > 0) await redis.hincrby(statsKey(orgId), "enqueued", -count)
}

/** This org's synthetic jobs reserved and not yet run to the end. */
export async function loadSyntheticOutstanding(orgId: string): Promise<number> {
  const [e, r] = await redis.hmget(statsKey(orgId), "enqueued", "runs")
  return Math.max(0, Number(e ?? 0) - Number(r ?? 0))
}

let loadOrgCheck: (orgId: string) => Promise<boolean> = isLoadOrg

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("aborted"))
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(signal.reason ?? new Error("aborted"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * One synthetic run: refuse a non-load org, else count, sleep, count.
 * `activeAt` is when the worker took the job (BullMQ `processedOn`), if known.
 */
export async function runLoadSynthetic(
  payload: LoadSyntheticPayload,
  signal: AbortSignal,
  activeAt?: number,
): Promise<void> {
  const { orgId } = payload
  if (!(await loadOrgCheck(orgId))) {
    // A refusal is final: the job is done, not outstanding.
    await redis
      .multi()
      .hincrby(statsKey(orgId), "runs", 1)
      .hincrby(statsKey(orgId), "failed", 1)
      .exec()
    throw new Error(`load-synthetic: org ${orgId} is not a load org; refused`)
  }
  const startedAt = Date.now()
  const waitMs = Math.max(0, startedAt - payload.queuedAt)
  const sleepMs = Math.min(Math.max(0, payload.sleepMs), LOAD_SYNTHETIC_MAX_SLEEP_MS)
  await redis
    .multi()
    .eval(START_LUA, 1, statsKey(orgId), TTL_S)
    .rpush(waitsKey(orgId), String(waitMs))
    .expire(waitsKey(orgId), TTL_S)
    .exec()
  let completed = false
  let failed = false
  let lagMs = 0
  try {
    const sleptFrom = Date.now()
    await sleep(sleepMs, signal)
    lagMs = Math.max(0, Date.now() - sleptFrom - sleepMs)
    completed = true
  } catch (err) {
    // An abort is a drain handing the job back: it reruns, so it is not done.
    // Any other failure is final.
    failed = !signal.aborted
    throw err
  } finally {
    const m = redis.multi().hincrby(statsKey(orgId), "inflight", -1)
    if (failed) m.hincrby(statsKey(orgId), "runs", 1).hincrby(statsKey(orgId), "failed", 1)
    if (completed) {
      const second = Math.floor(Date.now() / 1000)
      const dispatchMs = activeAt === undefined ? 0 : Math.max(0, startedAt - activeAt)
      m.hincrby(statsKey(orgId), "runs", 1)
        .hincrby(doneKey(orgId), String(second), 1)
        .expire(doneKey(orgId), TTL_S)
        .rpush(timingKey(orgId), `${second}:${dispatchMs}:${lagMs}`)
        .expire(timingKey(orgId), TTL_S)
    }
    await m.exec()
  }
}

/** This org's synthetic-run counters. */
export async function readLoadSyntheticStats(orgId: string): Promise<LoadSyntheticStats> {
  const [h, waits, done, timing] = await Promise.all([
    redis.hgetall(statsKey(orgId)),
    redis.lrange(waitsKey(orgId), 0, -1),
    redis.hgetall(doneKey(orgId)),
    redis.lrange(timingKey(orgId), 0, -1),
  ])
  const donePerSecond: Record<string, number> = {}
  for (const [s, n] of Object.entries(done)) donePerSecond[s] = Number(n)
  return {
    runs: Number(h.runs ?? 0),
    failed: Number(h.failed ?? 0),
    inflight: Number(h.inflight ?? 0),
    maxInflight: Number(h.maxInflight ?? 0),
    waitsMs: waits.map(Number),
    donePerSecond,
    timings: timing.flatMap((t) => {
      const [second, dispatchMs, lagMs] = t.split(":").map(Number)
      return Number.isFinite(second) && Number.isFinite(dispatchMs) && Number.isFinite(lagMs)
        ? [{ second: second as number, dispatchMs: dispatchMs as number, lagMs: lagMs as number }]
        : []
    }),
  }
}

/** Register the job's handler in this process (the load harness's routes do, on demand). */
export function registerLoadSyntheticWorker(): void {
  registerJobWorker<LoadSyntheticPayload>(
    "kernel",
    LOAD_SYNTHETIC_JOB,
    async (payload, ctx) =>
      runLoadSynthetic(payload, ctx?.signal ?? new AbortController().signal, ctx?.activeAt),
    // No ambient transaction: the run sleeps and must not hold a database connection.
    { txMode: "session" },
  )
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const LoadSyntheticTestAccess = {
  /** Replace the load-org check; pass nothing to restore `isLoadOrg`. */
  setLoadOrgCheck(fn?: (orgId: string) => Promise<boolean>): void {
    loadOrgCheck = fn ?? isLoadOrg
  },
  /** Drop this org's counters. */
  async forget(orgId: string): Promise<void> {
    await redis.del(statsKey(orgId), waitsKey(orgId), doneKey(orgId), timingKey(orgId))
  },
}
