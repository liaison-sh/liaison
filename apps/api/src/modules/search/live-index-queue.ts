// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Live search indexing: a coalescing queue in Redis, one flusher, one sweep.
//
// WHY
// ---
// Every entity change used to be one `app-kernel` job doing one
// `addDocuments([doc])`, i.e. one Meili task per change, followed by a
// `search-task-verify` job re-arming itself while Meili was busy. On a large
// index Meili takes 27 to 50 s per batch whatever its size, so a burst (a mail
// backlog) put thousands of jobs in the queue shared with agent runs and
// routines, and a new chat message waited behind them for minutes.
//
// DESIGN
// ------
// 1. Recording. An index request (entity, message, brief row, upsert or
//    delete) is written to Redis under its Meili document id and returns:
//    `order` (sorted set, first-seen time) + `items` (hash, the latest
//    request). A second request for the same document before the flush
//    overwrites the payload and keeps its place, so N changes collapse into
//    one document and the latest operation wins (a delete then an upsert
//    indexes the row as it stands; an upsert then a delete deletes).
// 2. Flushing. A `search-index-flush` job on its OWN queue (`app-search-index`,
//    concurrency 1, and a Redis lock so two processes never flush at once)
//    claims up to FLUSH_BATCH requests, builds every document from the DB, and
//    sends ONE deleteDocuments (plus one per delete filter, a parent's
//    fragments) and ONE addDocuments for the lot, through index-writer.ts, the
//    one write path (vector opt-out, rebuild replay notes). It never
//    waits for Meili: the task uid goes to a ledger with the requests it
//    carried. Requests schedule a flush for the next FLUSH_INTERVAL_MS
//    boundary, so a change reaches Meili within about a second.
// 3. Failure detection. A `search-index-sweep` job, once a minute, asks Meili
//    for the ledger's tasks that have FINISHED (one GET /tasks?uids=...). A
//    succeeded task leaves the ledger; a failed or canceled one puts exactly
//    its requests back in the queue (unless a newer request for the same
//    document is already waiting), up to MAX_ATTEMPTS, then logs an error.
//    The sweep also returns requests a crashed flusher had claimed.
// 4. Durability. A claimed request moves to `processing` until its task uid
//    is in the ledger; nothing lives only in a process's memory.
//
// Direct callers (CLIs, imports, tests) keep their own batched paths that
// wait for Meili; only the live, event-driven path goes through here.

import { enqueueAppJob, registerJobWorker, upsertJobScheduler } from "~/infra/jobs/jobs"
import { effectiveIndexName, getMeili } from "~/infra/search/client"
import { searchLogger as log } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { rawDeleteItem, sendIndexWrite } from "~/modules/search/index-writer"

export { rawDeleteItem }

/** The dedicated queue: live indexing never occupies an `app-kernel` slot. */
export const LIVE_INDEX_QUEUE_APP = "search-index"
export const FLUSH_JOB = "search-index-flush"
export const SWEEP_JOB = "search-index-sweep"

/** A flush is scheduled on the next boundary of this interval. */
export const FLUSH_INTERVAL_MS = 1_000
/** Requests claimed per flush round (one Meili task each way per round). */
export const FLUSH_BATCH = 1_000
/** A flush drains rounds until the queue is empty or this budget is spent. */
const FLUSH_BUDGET_MS = 30_000
/** Meili tasks of this index still queued above which a flush holds back. */
export const MAX_PENDING_MEILI_TASKS = 20
/** Attempts per request before a failing document is given up on. */
export const MAX_ATTEMPTS = 4
/** A ledger entry Meili no longer knows about is dropped after this long. */
const LEDGER_MAX_AGE_MS = 24 * 60 * 60_000
/** Ledger task uids asked about per sweep. */
const SWEEP_UIDS = 500
const LOCK_TTL_MS = 60_000

const K = {
  order: "search:live-index:order",
  items: "search:live-index:items",
  processing: "search:live-index:processing",
  ledger: "search:live-index:ledger",
  lock: "search:live-index:flush-lock",
}

/** One recorded request. `key` is the Meili document id it produces. */
export interface LiveIndexItem {
  /** Resolver name: "entity", "message", "brief". */
  t: string
  key: string
  payload: Record<string, unknown> & { orgId: string; action: "upsert" | "delete" }
  /** Failed Meili tasks (or builds) this request has already been through. */
  attempt?: number
}

export interface LiveIndexResolution {
  /** Documents to add, final (vectors or the explicit opt-out attached). */
  docs: Record<string, unknown>[]
  /** Document ids to delete. */
  deleteIds: string[]
  /**
   * Meili filters whose matching documents are deleted (a parent's fragments,
   * whose ids nothing lists any more). Built by the resolvers from escaped ids,
   * never from event text.
   */
  deleteFilters?: string[]
  /** Requests that could not be built this time (retried like a failed task). */
  failed: LiveIndexItem[]
}

export type LiveIndexResolver = (items: LiveIndexItem[]) => Promise<LiveIndexResolution>

const resolvers = new Map<string, LiveIndexResolver>()

/** Each indexer registers how its requests turn into documents. */
export function registerLiveIndexResolver(t: string, resolver: LiveIndexResolver): void {
  resolvers.set(t, resolver)
}

registerLiveIndexResolver("raw", async (items) => {
  const out: LiveIndexResolution = { docs: [], deleteIds: [], deleteFilters: [], failed: [] }
  for (const item of items) {
    const ids = item.payload.ids
    const filter = item.payload.filter
    if (Array.isArray(ids))
      out.deleteIds.push(...ids.filter((v): v is string => typeof v === "string"))
    if (typeof filter === "string" && filter.length > 0) out.deleteFilters?.push(filter)
  }
  return out
})

/* -------------------------------------------------------------------------- */
/* Redis primitives                                                           */
/* -------------------------------------------------------------------------- */

// Claim the oldest `n` requests: remove them from the queue and park them in
// `processing` until their task is in the ledger. Atomic, so a request written
// while a flush runs is either in this claim or waits for the next one.
const CLAIM_LUA = `
local keys = redis.call('ZRANGE', KEYS[1], 0, tonumber(ARGV[1]) - 1)
if #keys == 0 then return {} end
local vals = redis.call('HMGET', KEYS[2], unpack(keys))
redis.call('ZREM', KEYS[1], unpack(keys))
redis.call('HDEL', KEYS[2], unpack(keys))
local out = {}
for i, k in ipairs(keys) do
  if vals[i] then
    redis.call('HSET', KEYS[3], k, vals[i])
    table.insert(out, vals[i])
  end
end
return out`

// Put requests back unless a newer request for the same document is already
// queued (that one re-reads the row anyway), and release them from processing.
const REQUEUE_LUA = `
local n = 0
for i = 2, #ARGV, 2 do
  local k = ARGV[i]
  if redis.call('HEXISTS', KEYS[2], k) == 0 then
    redis.call('HSET', KEYS[2], k, ARGV[i + 1])
    redis.call('ZADD', KEYS[1], 'NX', ARGV[1], k)
    n = n + 1
  end
  redis.call('HDEL', KEYS[3], k)
end
return n`

const RELEASE_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`

const EXTEND_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 0`

async function claim(n: number): Promise<LiveIndexItem[]> {
  const raw = (await redis.eval(CLAIM_LUA, 3, K.order, K.items, K.processing, n)) as string[]
  const out: LiveIndexItem[] = []
  for (const v of raw) {
    try {
      out.push(JSON.parse(v) as LiveIndexItem)
    } catch {
      log.error({ value: v.slice(0, 200) }, "Unreadable live search index request dropped")
    }
  }
  return out
}

async function requeue(items: LiveIndexItem[]): Promise<number> {
  if (items.length === 0) return 0
  const args: string[] = [String(Date.now())]
  for (const it of items) args.push(it.key, JSON.stringify(it))
  return (await redis.eval(REQUEUE_LUA, 3, K.order, K.items, K.processing, ...args)) as number
}

async function release(items: LiveIndexItem[]): Promise<void> {
  if (items.length === 0) return
  await redis.hdel(K.processing, ...items.map((i) => i.key))
}

/** Requests waiting for a flush (tests, the sweep, operators). */
export async function pendingLiveIndexCount(): Promise<number> {
  return await redis.zcard(K.order)
}

/* -------------------------------------------------------------------------- */
/* Recording                                                                  */
/* -------------------------------------------------------------------------- */

let lastScheduledBucket = -1

/**
 * Schedule a flush on the next FLUSH_INTERVAL_MS boundary. One job id per
 * boundary, so any number of requests in the same second make one job, and
 * this process skips the Redis round trip after the first.
 */
export async function scheduleLiveIndexFlush(extraDelayMs = 0): Promise<void> {
  const now = Date.now()
  const bucket = Math.floor((now + extraDelayMs) / FLUSH_INTERVAL_MS) + 1
  if (bucket === lastScheduledBucket) return
  await enqueueAppJob(
    LIVE_INDEX_QUEUE_APP,
    FLUSH_JOB,
    {},
    { jobId: `${FLUSH_JOB}:${bucket}`, delay: bucket * FLUSH_INTERVAL_MS - now, attempts: 1 },
  )
  lastScheduledBucket = bucket
}

/**
 * Record index requests and return. Durable once this resolves; a failure
 * throws (the caller decides whether indexing may fail its own work).
 * A missing flush schedule is not fatal: the sweep flushes what is waiting.
 */
export async function recordLiveIndex(items: LiveIndexItem[]): Promise<void> {
  if (items.length === 0) return
  const now = Date.now()
  const tx = redis.multi()
  for (const it of items) {
    tx.hset(K.items, it.key, JSON.stringify(it))
    tx.zadd(K.order, "NX", now, it.key)
  }
  const results = await tx.exec()
  const failed = results?.find(([err]) => err)
  if (failed) throw failed[0]
  try {
    await scheduleLiveIndexFlush()
  } catch (err) {
    log.warn({ err }, "Could not schedule a search flush; the sweep will pick the requests up")
  }
}

/* -------------------------------------------------------------------------- */
/* Flushing                                                                   */
/* -------------------------------------------------------------------------- */

type Meili = ReturnType<typeof getMeili>

async function meiliBacklog(meili: Meili, index: string): Promise<number> {
  const tasks = (meili as { tasks?: { getTasks?: Meili["tasks"]["getTasks"] } }).tasks
  if (typeof tasks?.getTasks !== "function") return 0
  const r = await tasks.getTasks({
    indexUids: [index],
    statuses: ["enqueued"],
    limit: MAX_PENDING_MEILI_TASKS + 1,
  })
  return Array.isArray(r?.results) ? r.results.length : 0
}

async function recordLedger(taskUid: unknown, items: LiveIndexItem[]): Promise<void> {
  if (typeof taskUid !== "number") return
  await redis.hset(K.ledger, String(taskUid), JSON.stringify({ at: Date.now(), items }))
}

function bumpAttempt(items: LiveIndexItem[], reason: string): LiveIndexItem[] {
  const again: LiveIndexItem[] = []
  for (const it of items) {
    const attempt = (it.attempt ?? 0) + 1
    if (attempt >= MAX_ATTEMPTS) {
      log.error(
        { key: it.key, t: it.t, orgId: it.payload.orgId, attempt, reason },
        "Search index request gave up after repeated failures",
      )
      continue
    }
    again.push({ ...it, attempt })
  }
  return again
}

/**
 * One flush round: claim, build, send. Returns the number of requests
 * claimed (0: the queue is empty). Exported for tests.
 *
 * A task Meili fails fails for every document in it, so a single bad document
 * must not take its batch down with it: requests on their first retry go in a
 * group of their own (never mixed with fresh ones), and from the second retry
 * each goes alone, so only the bad document is ever given up on.
 */
export async function flushLiveIndexOnce(batch = FLUSH_BATCH): Promise<number> {
  const items = await claim(batch)
  if (items.length === 0) return 0
  const fresh = items.filter((i) => !i.attempt)
  const retried = items.filter((i) => i.attempt === 1)
  const isolated = items.filter((i) => (i.attempt ?? 0) >= 2)
  for (const group of [fresh, retried, ...isolated.map((i) => [i])]) {
    if (group.length > 0) await sendGroup(group)
  }
  return items.length
}

/**
 * Turn requests into what they write, through each kind's resolver. Shared by
 * the flusher and the rebuild's replay, so both write exactly the same thing.
 */
export async function resolveLiveIndexItems(items: LiveIndexItem[]): Promise<{
  docs: Record<string, unknown>[]
  deleteIds: string[]
  deleteFilters: string[]
  failed: LiveIndexItem[]
}> {
  const byType = new Map<string, LiveIndexItem[]>()
  for (const it of items) {
    const list = byType.get(it.t) ?? []
    list.push(it)
    byType.set(it.t, list)
  }
  const docsById = new Map<string, Record<string, unknown>>()
  const deleteIds = new Set<string>()
  const deleteFilters = new Set<string>()
  const failed: LiveIndexItem[] = []
  for (const [t, list] of byType) {
    const resolver = resolvers.get(t)
    if (!resolver) {
      log.error({ t, count: list.length }, "No resolver for live search index requests; dropped")
      continue
    }
    try {
      const r = await resolver(list)
      for (const d of r.docs) docsById.set(String(d.id), d)
      for (const id of r.deleteIds) deleteIds.add(id)
      for (const f of r.deleteFilters ?? []) deleteFilters.add(f)
      failed.push(...r.failed)
    } catch (err) {
      log.warn({ err, t, count: list.length }, "Could not build search documents; retrying later")
      failed.push(...list)
    }
  }
  // A document built from the row as it stands wins over a delete of the
  // same id computed in the same round.
  for (const id of docsById.keys()) deleteIds.delete(id)
  return {
    docs: [...docsById.values()],
    deleteIds: [...deleteIds],
    deleteFilters: [...deleteFilters],
    failed,
  }
}

/** Build one group's documents and send them as one delete and one add task. */
async function sendGroup(items: LiveIndexItem[]): Promise<void> {
  const resolved = await resolveLiveIndexItems(items)
  const buildFailed = resolved.failed
  const failedKeys = new Set(buildFailed.map((i) => i.key))
  const sent = items.filter((i) => !failedKeys.has(i.key))
  try {
    // The filter deletes go before the adds (index-writer orders them), so a
    // fragment re-added in this round survives its parent's cleanup filter.
    const uids = await sendIndexWrite(resolved, { replay: sent })
    for (const uid of uids) await recordLedger(uid, sent)
  } catch (err) {
    // Meili refused the request outright (down, payload refused): nothing was
    // enqueued there, so the whole group goes back to the queue.
    log.warn({ err, count: items.length }, "Search flush could not reach Meili; requeued")
    await requeue(bumpAttempt(items, "meili_request_failed"))
    return
  }
  await requeue(bumpAttempt(buildFailed, "build_failed"))
  await release(sent)
}

async function acquireLock(token: string): Promise<boolean> {
  return (await redis.set(K.lock, token, "PX", LOCK_TTL_MS, "NX")) === "OK"
}

/** The `search-index-flush` job: drain the queue under the flush lock. */
export async function processLiveIndexFlushJob(): Promise<void> {
  const token = `${process.pid}:${Math.random().toString(36).slice(2)}`
  if (!(await acquireLock(token))) {
    // Another process is flushing. It drains until empty, but a request that
    // lands after its last claim must not wait for the sweep: look again soon.
    await scheduleLiveIndexFlush(FLUSH_INTERVAL_MS)
    return
  }
  let more = false
  try {
    const meili = getMeili()
    const started = Date.now()
    while (Date.now() - started < FLUSH_BUDGET_MS) {
      if ((await meiliBacklog(meili, effectiveIndexName())) >= MAX_PENDING_MEILI_TASKS) {
        // Meili is behind: leave the requests coalescing in Redis rather than
        // stack more tasks on it. They go in one round once it catches up.
        more = true
        break
      }
      const claimed = await flushLiveIndexOnce()
      if (claimed === 0) break
      await redis.eval(EXTEND_LOCK_LUA, 1, K.lock, token, LOCK_TTL_MS)
    }
  } finally {
    await redis.eval(RELEASE_LOCK_LUA, 1, K.lock, token)
  }
  if (more || (await pendingLiveIndexCount()) > 0) {
    await scheduleLiveIndexFlush(more ? 2 * FLUSH_INTERVAL_MS : 0)
  }
}

/* -------------------------------------------------------------------------- */
/* Sweep                                                                      */
/* -------------------------------------------------------------------------- */

interface LedgerEntry {
  at: number
  items: LiveIndexItem[]
}

/**
 * The `search-index-sweep` job: settle finished flush tasks, requeue the
 * requests of the ones Meili failed, return orphaned claims, and make sure
 * nothing waiting is left without a flush.
 */
export async function processLiveIndexSweepJob(): Promise<{
  succeeded: number
  failed: number
  requeued: number
}> {
  const out = { succeeded: 0, failed: 0, requeued: 0 }

  // Claims of a flusher that died: only when no flush holds the lock.
  if (!(await redis.exists(K.lock))) {
    const orphans = await redis.hvals(K.processing)
    if (orphans.length > 0) {
      const items = orphans.map((v) => JSON.parse(v) as LiveIndexItem)
      out.requeued += await requeue(items)
      log.warn({ count: items.length }, "Returned search index requests an interrupted flush held")
    }
  }

  const uids = (await redis.hkeys(K.ledger))
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
    .slice(0, SWEEP_UIDS)
  if (uids.length > 0) {
    const meili = getMeili()
    const res = await meili.tasks.getTasks({
      uids,
      statuses: ["succeeded", "failed", "canceled"],
      limit: uids.length,
    })
    const finished = new Map<number, { status: string; error?: { message?: string } | null }>()
    for (const t of res.results ?? []) finished.set(t.uid, t as never)
    for (const uid of uids) {
      const task = finished.get(uid)
      const raw = await redis.hget(K.ledger, String(uid))
      if (!raw) continue
      const entry = JSON.parse(raw) as LedgerEntry
      if (!task) {
        if (Date.now() - entry.at > LEDGER_MAX_AGE_MS) {
          log.warn({ taskUid: uid }, "Search flush task unknown to Meili after a day; forgotten")
          await redis.hdel(K.ledger, String(uid))
        }
        continue
      }
      if (task.status === "succeeded") {
        out.succeeded += 1
      } else {
        out.failed += 1
        log.error(
          {
            taskUid: uid,
            status: task.status,
            detail: task.error?.message,
            count: entry.items.length,
          },
          "Search flush task failed; requeueing its documents",
        )
        out.requeued += await requeue(bumpAttempt(entry.items, `task_${task.status}`))
      }
      await redis.hdel(K.ledger, String(uid))
    }
  }

  if ((await pendingLiveIndexCount()) > 0) await scheduleLiveIndexFlush()
  return out
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

let sweepScheduled = false

/** Register the flush and sweep workers. Every job-host process calls this. */
export function registerLiveIndexWorkers(): void {
  registerJobWorker(LIVE_INDEX_QUEUE_APP, FLUSH_JOB, processLiveIndexFlushJob, { concurrency: 1 })
  registerJobWorker(
    LIVE_INDEX_QUEUE_APP,
    SWEEP_JOB,
    async () => {
      await processLiveIndexSweepJob()
    },
    { concurrency: 1 },
  )
  if (sweepScheduled) return
  sweepScheduled = true
  upsertJobScheduler(LIVE_INDEX_QUEUE_APP, SWEEP_JOB, "* * * * *", {
    schedulerId: `${SWEEP_JOB}-scheduler`,
    attempts: 1,
  }).catch((err) => {
    sweepScheduled = false
    log.error({ err }, "Could not schedule the search index sweep")
  })
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const LiveIndexTestAccess = {
  keys: K,
  async clear(): Promise<void> {
    await redis.del(K.order, K.items, K.processing, K.ledger, K.lock)
    lastScheduledBucket = -1
  },
  async ledger(): Promise<Record<string, LedgerEntry>> {
    const all = await redis.hgetall(K.ledger)
    return Object.fromEntries(Object.entries(all).map(([k, v]) => [k, JSON.parse(v)]))
  },
  async pendingItems(): Promise<LiveIndexItem[]> {
    return (await redis.hvals(K.items)).map((v) => JSON.parse(v) as LiveIndexItem)
  },
}
