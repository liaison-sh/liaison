// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A dashboard source's rows, cached per VIEWER (a block's own source, a shared dataset, a
// filter's option source): blocks are mapped from them on every request (transform is cheap),
// so blocks sharing a dataset share one entry and one run. The key carries the org, the
// dashboard, the source (block, dataset or filter id), a hash of the source as
// run (filter and date tokens resolved, so a rolling range is a new key the day its dates move,
// and a filter value a param reads is a new key), the fields its blocks keep from each row,
// the range, the viewer
// and a hash of the viewer's scopes and dimension grants, so a revoked scope or
// grant is a new key and never serves what the viewer could read before. Never the dashboard's
// version: a layout, title or note edit leaves every source's key as it was, so it runs nothing
// again; only a change to what a source reads or keeps does. TTL: the block's refreshSec
// (spec.blockTtlSec, at most 900 s for any source).
//
// Bounds, per viewer: at most MAX_IN_FLIGHT block runs at once (the rest wait
// their turn), one forced refresh per block per REFRESH_WINDOW_SEC (a
// second one is refused, 429 for that block only), and a budget of runs the cache cannot
// absorb: a custom range, a filter value a param reads, and any read whose result could not be
// kept (too large, or Redis down). Each counts toward CUSTOM_WINDOW_RUNS per source and
// VIEWER_WINDOW_RUNS across all of the viewer's sources, per minute: a preset, the default and
// a cached read never count, so normal use never meets it, but a script walking day after day,
// or paging a large uncacheable read, does.
//
// Redis down: the block is computed uncached, with a warning. Every Redis call
// is bounded (REDIS_TIMEOUT_MS); the refresh limit, the budget and the "could not be kept"
// marks fall back to this process's own memory (bounded maps), so the runs stay budgeted.

import { createHash } from "node:crypto"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"

const log = rootLogger.child({ module: "dashboards-cache" })

export const MAX_IN_FLIGHT = 4
export const REFRESH_WINDOW_SEC = 30
export const REDIS_TIMEOUT_MS = 300
export const CUSTOM_WINDOW_RUNS = 12
export const VIEWER_WINDOW_RUNS = 60
export const CUSTOM_WINDOW_SEC = 60
/** At most this many keys in each in-process fallback map (the oldest go first). */
const LOCAL_MAX_KEYS = 10_000

/** The few Redis operations the cache needs; tests inject a fake. */
export interface BlockCacheStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSec: number): Promise<void>
  /** SET NX EX: true when the key was not there and is now set. */
  setIfAbsent(key: string, ttlSec: number): Promise<boolean>
  /** INCR, the key expiring `ttlSec` after its first count: the count now. */
  increment(key: string, ttlSec: number): Promise<number>
}

function bounded<T>(op: Promise<T>): Promise<T> {
  return Promise.race([
    op,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("redis call timed out")), REDIS_TIMEOUT_MS),
    ),
  ])
}

function ready(): void {
  // ioredis queues commands while disconnected (maxRetriesPerRequest: null): fail fast instead.
  if (redis.status !== "ready") throw new Error(`redis is ${redis.status}`)
}

export const redisBlockCacheStore: BlockCacheStore = {
  async get(key) {
    ready()
    return bounded(redis.get(key))
  },
  async set(key, value, ttlSec) {
    ready()
    await bounded(redis.set(key, value, "EX", ttlSec))
  },
  async setIfAbsent(key, ttlSec) {
    ready()
    return (await bounded(redis.set(key, "1", "EX", ttlSec, "NX"))) === "OK"
  },
  async increment(key, ttlSec) {
    ready()
    const n = await bounded(redis.incr(key))
    if (n === 1) await bounded(redis.expire(key, ttlSec))
    return n
  },
}

let store: BlockCacheStore = redisBlockCacheStore

/** Test seams for this module: swap the store (a fake, or one that throws as a Redis outage does). */
export const BlockCacheTestAccess = {
  setStore(next: BlockCacheStore | null): void {
    store = next ?? redisBlockCacheStore
  },
  /** Forgets this process's fallback counts and marks. */
  resetLocal(): void {
    localWindowRuns.clear()
    localUncacheable.clear()
  },
}

export interface CacheViewer {
  orgId: string
  userId: string
  scopes: string[]
  dimensionGrants: Record<string, string[]>
  /** The viewer's role ids: row policies read them (a record shared with a role). */
  roles?: string[]
}

/** A short, order-independent hash of what the viewer may read: scopes, dimension grants, roles. */
export function permissionHash(
  viewer: Pick<CacheViewer, "scopes" | "dimensionGrants" | "roles">,
): string {
  const grants = Object.keys(viewer.dimensionGrants)
    .sort()
    .map((k) => [k, [...(viewer.dimensionGrants[k] ?? [])].sort()])
  const material = JSON.stringify([
    [...new Set(viewer.scopes)].sort(),
    grants,
    [...new Set(viewer.roles ?? [])].sort(),
  ])
  return createHash("sha256").update(material).digest("hex").slice(0, 20)
}

/** JSON with object keys sorted, so the same source hashes the same whatever its key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

/** A short hash of a block's source as it runs: its date tokens already resolved. */
export function sourceHash(source: unknown): string {
  return createHash("sha256").update(canonicalJson(source)).digest("hex").slice(0, 16)
}

/** Which source of a dashboard: a block's own, a dataset, a filter's option source. */
export type SourceKey = `blk:${string}` | `ds:${string}` | `opt:${string}`

export function sourceCacheKey(
  viewer: CacheViewer,
  entry: {
    dashboardId: string
    sourceKey: SourceKey
    resolvedSource: unknown
    /** The fields kept from each row (the cached rows hold only these); null: whole rows. */
    fields: ReadonlySet<string> | null
    /** The dashboard range the run read (a source that follows it), else null. */
    range?: { from: string; to: string } | null
  },
): string {
  const range = entry.range ? `${entry.range.from}..${entry.range.to}` : "fixed"
  const fields = entry.fields ? sourceHash([...entry.fields].sort()) : "all"
  return `dash:src:${viewer.orgId}:${entry.dashboardId}:${entry.sourceKey}:${sourceHash(entry.resolvedSource)}:${fields}:${range}:${viewer.userId}:${permissionHash(viewer)}`
}

interface SharedRun {
  promise: Promise<unknown>
  /** Stops the shared run: only once every caller waiting on it has left. */
  controller: AbortController
  waiters: number
}

const inFlight = new Map<string, SharedRun>()

/** One caller joins `run`: its signal, when it aborts, leaves; the last to leave stops the run. */
function join(run: SharedRun, signal: AbortSignal | undefined): void {
  run.waiters++
  if (!signal) return
  const leave = () => {
    run.waiters--
    if (run.waiters <= 0) run.controller.abort(signal.reason)
  }
  if (signal.aborted) leave()
  else signal.addEventListener("abort", leave, { once: true })
}

/**
 * Runs `fn` once for concurrent callers of the same `key` in this process: blocks that share
 * a dataset load together, and the second waits on the first's run instead of starting its own.
 * The run has its own signal (passed to `fn`), stopped only when every caller that asked for it
 * has gone (each caller's `signal`): one viewer closing a tab never cancels another's read.
 * A caller without a signal never leaves.
 */
export async function singleFlight<T>(
  key: string,
  fn: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const running = inFlight.get(key)
  // A run every caller left is stopping: a new caller never joins it (it would get the
  // cancellation), it starts its own. The stopping run removes only its own entry when it settles.
  if (running && !running.controller.signal.aborted) {
    join(running, signal)
    return running.promise as Promise<T>
  }
  const run: SharedRun = {
    promise: Promise.resolve(),
    controller: new AbortController(),
    waiters: 0,
  }
  join(run, signal)
  run.promise = fn(run.controller.signal).finally(() => {
    if (inFlight.get(key) === run) inFlight.delete(key)
  })
  inFlight.set(key, run)
  return run.promise as Promise<T>
}

/**
 * Where a block's FAILED outcome is kept, beside its data key: a source that fails (a down
 * service, a map that no longer fits) is not re-run on every view, only after this short wait
 * or on a refresh. A separate key, so a release that reads only data entries never mistakes a
 * failure for data.
 */
export function failedBlockCacheKey(dataKey: string): string {
  return `${dataKey}:failed`
}

/** How long a failed outcome is kept: a refresh (once per 30 s) reads past it anyway. */
export const FAILED_BLOCK_TTL_SEC = 30

function refreshKey(viewer: CacheViewer, dashboardId: string, blockId: string): string {
  return `dash:refresh:${viewer.orgId}:${dashboardId}:${blockId}:${viewer.userId}`
}

/** The refresh limit's fallback while Redis is down: this process only. */
const localRefreshes = new Map<string, number>()

/**
 * May this viewer force a refresh of this block now? One per REFRESH_WINDOW_SEC;
 * a second inside the window is refused.
 */
export async function takeRefresh(
  viewer: CacheViewer,
  dashboardId: string,
  blockId: string,
): Promise<boolean> {
  const key = refreshKey(viewer, dashboardId, blockId)
  try {
    return await store.setIfAbsent(key, REFRESH_WINDOW_SEC)
  } catch (err) {
    log.warn(
      { err, dashboardId, blockId },
      "dashboard refresh limit: redis unavailable, limiting in this process",
    )
    const now = Date.now()
    for (const [k, until] of localRefreshes) if (until <= now) localRefreshes.delete(k)
    if ((localRefreshes.get(key) ?? 0) > now) return false
    localRefreshes.set(key, now + REFRESH_WINDOW_SEC * 1000)
    return true
  }
}

/** The budget's fallback while Redis is down: this process only. */
const localWindowRuns = new Map<string, { count: number; until: number }>()

function trim<V>(map: Map<string, V>): void {
  while (map.size > LOCAL_MAX_KEYS) map.delete(map.keys().next().value as string)
}

/** One more count on `key` this window: the count now (Redis, else this process). */
async function countRun(key: string): Promise<number> {
  try {
    return await store.increment(key, CUSTOM_WINDOW_SEC)
  } catch (err) {
    log.warn({ err, key }, "dashboard run budget: redis unavailable, counting in this process")
    const now = Date.now()
    for (const [k, v] of localWindowRuns) if (v.until <= now) localWindowRuns.delete(k)
    const entry = localWindowRuns.get(key) ?? { count: 0, until: now + CUSTOM_WINDOW_SEC * 1000 }
    entry.count++
    localWindowRuns.set(key, entry)
    trim(localWindowRuns)
    return entry.count
  }
}

/**
 * May this viewer make one more run the cache cannot absorb (a custom range, a filter value a
 * param reads, a read that could not be kept) of this source? At most CUSTOM_WINDOW_RUNS per
 * source and VIEWER_WINDOW_RUNS across every source of the viewer, a CUSTOM_WINDOW_SEC (a
 * comparison run counts too).
 */
export async function takeCustomWindowRun(
  viewer: CacheViewer,
  dashboardId: string,
  blockId: string,
): Promise<boolean> {
  const perSource = await countRun(
    `dash:windows:${viewer.orgId}:${dashboardId}:${blockId}:${viewer.userId}`,
  )
  if (perSource > CUSTOM_WINDOW_RUNS) return false
  return (await countRun(`dash:windows:${viewer.orgId}:${viewer.userId}`)) <= VIEWER_WINDOW_RUNS
}

/** Keys whose last result could not be kept, while Redis is down (this process only). */
const localUncacheable = new Map<string, number>()

/** Marks `key`'s result as one the cache could not keep: its next runs are budgeted. */
export async function markUncacheable(key: string, ttlSec: number): Promise<void> {
  const now = Date.now()
  for (const [k, until] of localUncacheable) if (until <= now) localUncacheable.delete(k)
  localUncacheable.set(key, now + ttlSec * 1000)
  trim(localUncacheable)
  try {
    await store.set(`${key}:uncached`, "1", ttlSec)
  } catch {
    // Redis down: the process's own mark stands.
  }
}

/** Was `key`'s last result one the cache could not keep (here, or in Redis)? */
export async function isUncacheable(key: string): Promise<boolean> {
  if ((localUncacheable.get(key) ?? 0) > Date.now()) return true
  try {
    return (await store.get(`${key}:uncached`)) !== null
  } catch {
    // Redis down: nothing it marked can be read, and every result is uncached here.
    return false
  }
}

export async function readCachedBlock<T>(key: string): Promise<T | null> {
  try {
    const raw = await store.get(key)
    return raw === null ? null : (JSON.parse(raw) as T)
  } catch (err) {
    log.warn({ err, key }, "dashboard block cache unavailable: computing uncached")
    return null
  }
}

/** Caches `value`: true when it was kept. */
export async function writeCachedBlock(
  key: string,
  value: unknown,
  ttlSec: number,
): Promise<boolean> {
  try {
    await store.set(key, JSON.stringify(value), ttlSec)
    return true
  } catch (err) {
    log.warn({ err, key }, "dashboard block cache unavailable: result not cached")
    return false
  }
}

/** A counting semaphore: at most `max` holders, the rest wait in arrival order. */
export class Semaphore {
  private active = 0
  private readonly waiters: (() => void)[] = []
  constructor(private readonly max: number) {}

  get inFlight(): number {
    return this.active
  }

  get waiting(): number {
    return this.waiters.length
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiters.push(resolve))
    else this.active++
    try {
      return await fn()
    } finally {
      const next = this.waiters.shift()
      if (next) next()
      else this.active--
    }
  }
}

const viewerSemaphores = new Map<string, Semaphore>()

/** Runs `fn` within the viewer's MAX_IN_FLIGHT block runs (in this process). */
export async function withViewerSlot<T>(viewer: CacheViewer, fn: () => Promise<T>): Promise<T> {
  const key = `${viewer.orgId}:${viewer.userId}`
  let sem = viewerSemaphores.get(key)
  if (!sem) {
    sem = new Semaphore(MAX_IN_FLIGHT)
    viewerSemaphores.set(key, sem)
  }
  try {
    return await sem.run(fn)
  } finally {
    if (sem.inFlight === 0 && sem.waiting === 0) viewerSemaphores.delete(key)
  }
}

/** Runs `tasks` with at most MAX_IN_FLIGHT at once, keeping their order (one request's blocks). */
export async function runBounded<T>(tasks: (() => Promise<T>)[]): Promise<T[]> {
  const sem = new Semaphore(MAX_IN_FLIGHT)
  return Promise.all(tasks.map((t) => sem.run(t)))
}
