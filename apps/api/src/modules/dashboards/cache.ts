// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A dashboard block's data, cached per VIEWER: the key carries the org, the
// dashboard and its version, the block, a hash of its source as run (date tokens
// resolved, so a rolling range is a new key the day its dates move), the viewer
// and a hash of the viewer's scopes and dimension grants, so a revoked scope or
// grant is a new key and never serves what the viewer could read before. TTL: the block's refreshSec
// (spec.blockTtlSec, at most 900 s for any source).
//
// Bounds, per viewer: at most MAX_IN_FLIGHT block runs at once (the rest wait
// their turn), and one forced refresh per block per REFRESH_WINDOW_SEC (a
// second one is refused, 429 for that block only).
//
// Redis down: the block is computed uncached, with a warning. Every Redis call
// is bounded (REDIS_TIMEOUT_MS), and the refresh limit falls back to this
// process's own memory.

import { createHash } from "node:crypto"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"

const log = rootLogger.child({ module: "dashboards-cache" })

export const MAX_IN_FLIGHT = 4
export const REFRESH_WINDOW_SEC = 30
export const REDIS_TIMEOUT_MS = 300

/** The few Redis operations the cache needs; tests inject a fake. */
export interface BlockCacheStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSec: number): Promise<void>
  /** SET NX EX: true when the key was not there and is now set. */
  setIfAbsent(key: string, ttlSec: number): Promise<boolean>
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
}

let store: BlockCacheStore = redisBlockCacheStore

/** Test seams for this module: swap the store (a fake, or one that throws as a Redis outage does). */
export const BlockCacheTestAccess = {
  setStore(next: BlockCacheStore | null): void {
    store = next ?? redisBlockCacheStore
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

export function blockCacheKey(
  viewer: CacheViewer,
  block: { dashboardId: string; version: number; blockId: string; resolvedSource: unknown },
): string {
  return `dash:block:${viewer.orgId}:${block.dashboardId}:${block.version}:${block.blockId}:${sourceHash(block.resolvedSource)}:${viewer.userId}:${permissionHash(viewer)}`
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

export async function readCachedBlock<T>(key: string): Promise<T | null> {
  try {
    const raw = await store.get(key)
    return raw === null ? null : (JSON.parse(raw) as T)
  } catch (err) {
    log.warn({ err, key }, "dashboard block cache unavailable: computing uncached")
    return null
  }
}

export async function writeCachedBlock(key: string, value: unknown, ttlSec: number): Promise<void> {
  try {
    await store.set(key, JSON.stringify(value), ttlSec)
  } catch (err) {
    log.warn({ err, key }, "dashboard block cache unavailable: result not cached")
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
