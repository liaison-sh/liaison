// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Shared e2e lanes: the owner side.
 *
 * Booting a worker used to be per FILE: clone every schema (~5 s), spawn the
 * API server and wait for it, bootstrap the org through the API, then drop it
 * all again. A file with a handful of sub-second tests spent 20-50 s on that.
 *
 * A lane does it once. scripts/test-e2e-parallel.ts creates one lane per
 * parallel slot; the lane clones the worker's schemas, boots the server,
 * registers the admin (which creates the org and lets the server register its
 * apps) and snapshots the data (worker-snapshot.ts). Every file the slot runs
 * then attaches through `createWorkerEnv` (worker-env.ts): on attach the lane
 * puts the database, the worker's Redis keys and its search indexes back to
 * the snapshot and drops the server's in-process caches
 * (`POST /api/_test/lane/reset`). The file sees what a fresh worker showed
 * it: one org, one admin, the default apps, nothing else.
 *
 * The server is restarted (still no schema clone) when the attaching file asks
 * for a different `serverEnv` than the server runs with, when the previous
 * file installed an app at runtime (that registration lives in the process
 * and survives a data reset), when the server died, and when a file restarts
 * it itself (`env.restart()` goes through the lane's stop/start).
 *
 * A file that needs a process nothing else touched (boot-time behaviour,
 * process-global state the reset does not cover) opts out with an
 * `e2e-own-server` marker comment and runs the old way after the lane is done.
 *
 * Same org id across a lane's files: objects a file put in the object store
 * under `orgs/<orgId>/` are still there for the next file. Scenarios that list
 * that prefix opt out (file-orphan-gc).
 */

import { mkdirSync, readdirSync, rmSync } from "node:fs"
import path from "node:path"
import type Redis from "ioredis"
import { bootstrap } from "./auth"
import { resolveTestCoordinates } from "./test-namespace"
import { createOwnedWorkerEnv, type LaneInfo, type OwnedWorkerEnv } from "./worker-env"
import {
  dropWorkerSnapshot,
  installedAppsFingerprint,
  restoreWorkerData,
  snapshotWorkerData,
} from "./worker-snapshot"

export interface E2eLaneOptions {
  /** Ports to reserve: [0] API, then whatever the caller runs beside it (Playwright: Vite, mocks). */
  portCount?: number
  /** Env the server boots with on top of the worker defaults; a file's `serverEnv` adds to it. */
  serverEnv?: Record<string, string | undefined>
  /** The instance's first account (it creates the org). Default: `bootstrap`'s e2e admin. */
  admin?: { email: string; password: string; name: string }
  /**
   * Data every file starts from, on top of the org: runs once, after the org
   * exists and the server is ready, and before the snapshot. Its result must be
   * JSON; every attach hands it back (a Playwright lane's QA world).
   */
  seed?: (env: OwnedWorkerEnv) => Promise<unknown>
}

export interface E2eLane {
  info: LaneInfo
  /** The `seed` option's result, as every attach returns it. */
  seed: unknown
  /** Stop the server and drop everything the lane created. */
  close(): Promise<void>
}

interface RedisSnapshotEntry {
  key: string
  dump: Buffer
  pttl: number
}

function stableKey(env: Record<string, string>): string {
  return JSON.stringify(
    Object.keys(env)
      .sort()
      .map((k) => [k, env[k]]),
  )
}

export async function createE2eLane(
  workerId: number,
  logDir: string,
  options: E2eLaneOptions = {},
): Promise<E2eLane> {
  mkdirSync(logDir, { recursive: true })
  const stdoutPath = path.join(logDir, `lane-${workerId}-stdout.log`)
  const stderrPath = path.join(logDir, `lane-${workerId}-stderr.log`)
  const env: OwnedWorkerEnv = await createOwnedWorkerEnv(workerId, {
    logFiles: { stdout: stdoutPath, stderr: stderrPath },
    portCount: options.portCount,
    serverEnv: options.serverEnv,
  })
  const sql = env.db.sql
  const redis = env.redis.redis
  const coords = resolveTestCoordinates()
  const bullPrefix = `${env.redisPrefix}bull:`
  // The lane holds its server's scheduled ticks while it builds the world it
  // snapshots (SCHEDULED_TICKS_HELD_KEY, apps/api/src/infra/jobs/jobs.ts): the
  // snapshot is what the bootstrap and the seed wrote, never also whichever
  // minute sweeps fired before it (the expiry of a seeded request already past
  // its deadline, the attention materializer's rows, a digest). It is let go
  // after the snapshot, before the lane's Redis keys are read back, so a reset
  // never puts it back.
  const ticksHeldKey = `${env.redisPrefix}test:scheduled-ticks-held`
  await redis.set(ticksHeldKey, "1")

  // The org + admin every file gets (what TestWorld.create's bootstrap made).
  await bootstrap(env.serverUrl, options.admin)
  await env.waitForReady(30_000)
  const t0 = performance.now()
  const seedResult = options.seed ? JSON.parse(JSON.stringify(await options.seed(env))) : null
  const tSeed = performance.now()
  // The bootstrap's and the seed's events (audit, timeline, search) land
  // before the snapshot, or the first file would find them half processed and
  // the rest never.
  await waitForOutboxDrained(sql, env.schemaPrefix)
  // The drained outbox has only QUEUED the search work: the flusher's jobs (a
  // second's debounce) and the boot rebuild (kernel-bulk, started when the
  // index was missing) still have to run. A snapshot taken before them held a
  // handful of documents, and every reset of the lane put that nearly empty
  // index back: palette, participant and phone search found nothing, or only
  // on a lane a restart had re-indexed.
  const tOutbox = performance.now()
  await waitForSearchJobsIdle(redis, bullPrefix)
  // A per-request timer the bootstrap or the seed armed and that is due soon
  // (a notification burst flushes 10 s after its last message) runs before
  // the snapshot, not on whichever side of it the build's speed puts it.
  await waitForDueJobsIdle(redis, bullPrefix)
  const tSearch = performance.now()
  const s1 = (ms: number) => `${(ms / 1000).toFixed(1)}s`
  process.stderr.write(
    `[e2e-lane w${workerId}] seed ${s1(tSeed - t0)}, outbox ${s1(tOutbox - tSeed)}, search ${s1(tSearch - tOutbox)}\n`,
  )

  // ── snapshot ──────────────────────────────────────────────────────────────
  await snapshotWorkerData(sql, workerId)
  const appsAtSnapshot = await installedAppsFingerprint(sql, workerId)
  await redis.del(ticksHeldKey)

  async function scanLaneKeys(): Promise<string[]> {
    const keys: string[] = []
    let cursor = "0"
    do {
      const [next, page] = await redis.scan(cursor, "MATCH", `${env.redisPrefix}*`, "COUNT", 10_000)
      cursor = next
      // BullMQ's queues belong to the running server (repeatable jobs are
      // registered at boot); a file's leftover jobs fail harmlessly against
      // the reset data.
      for (const k of page) if (!k.startsWith(bullPrefix)) keys.push(k)
    } while (cursor !== "0")
    return keys
  }

  const redisSnapshot: RedisSnapshotEntry[] = []
  for (const key of await scanLaneKeys()) {
    const [dump, pttl] = await Promise.all([redis.dumpBuffer(key), redis.pttl(key)])
    if (dump) redisSnapshot.push({ key, dump, pttl })
  }
  const snapshotKeys = new Set(redisSnapshot.map((e) => e.key))

  async function restoreRedis(): Promise<void> {
    const extra = (await scanLaneKeys()).filter((k) => !snapshotKeys.has(k))
    // One pipeline, one round trip: a key at a time cost a round trip each.
    const pipe = redis.pipeline()
    for (let i = 0; i < extra.length; i += 500) pipe.del(...extra.slice(i, i + 500))
    for (const e of redisSnapshot) {
      pipe.restore(e.key, e.pttl > 0 ? e.pttl : 0, e.dump, "REPLACE")
    }
    const results = (await pipe.exec()) ?? []
    const failed = results.find(([err]) => err)
    if (failed) throw failed[0]
  }

  const searchHeaders = { Authorization: `Bearer ${coords.meiliKey}` }
  // The Meili instance is shared by every run on the machine and can hold
  // thousands of indexes, so the listing is paged (a single `limit=1000` page
  // missed this lane's index on a busy instance) and done ONCE, here. A reset
  // then looks only at the indexes found here plus the search rebuild index the
  // server may create later (`<index>__rebuild`, search-reindex).
  async function listLaneIndexes(): Promise<string[]> {
    const uids: string[] = []
    for (let offset = 0; ; offset += 1000) {
      const res = await fetch(`${coords.meiliHost}/indexes?limit=1000&offset=${offset}`, {
        headers: searchHeaders,
      })
      if (!res.ok) break
      const body = (await res.json()) as { results?: Array<{ uid: string }> }
      const page = body.results ?? []
      for (const i of page) if (i.uid.startsWith(env.meiliIndexPrefix)) uids.push(i.uid)
      if (page.length < 1000) break
    }
    return uids
  }
  const knownIndexes = new Set(await listLaneIndexes())
  for (const uid of [...knownIndexes]) knownIndexes.add(`${uid}__rebuild`)
  const laneIndexes = async (): Promise<string[]> => [...knownIndexes]

  // The search documents at snapshot time (the bootstrap's, and the seed's
  // when there is one): the reset puts exactly these back, so a file searches
  // the same world a fresh worker showed it. Emptying the index instead left
  // the database and the index disagreeing about the org's own rows.
  const searchSnapshot = new Map<string, unknown[]>()
  {
    const uids = await laneIndexes()
    await waitForSearchIdle(coords.meiliHost, coords.meiliKey, uids)
    for (const uid of uids) {
      const docs: unknown[] = []
      for (let offset = 0; ; offset += 1000) {
        const res = await fetch(
          `${coords.meiliHost}/indexes/${uid}/documents?limit=1000&offset=${offset}`,
          { headers: searchHeaders },
        )
        if (!res.ok) break
        const page = (await res.json()) as { results?: unknown[] }
        docs.push(...(page.results ?? []))
        if ((page.results ?? []).length < 1000) break
      }
      if (docs.length > 0) searchSnapshot.set(uid, docs)
    }
  }

  async function indexUpdatedAt(uid: string): Promise<string | null> {
    const res = await fetch(`${coords.meiliHost}/indexes/${uid}`, { headers: searchHeaders })
    if (!res.ok) return null
    return ((await res.json()) as { updatedAt?: string }).updatedAt ?? null
  }

  async function waitForTask(taskUid: number): Promise<void> {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const t = await fetch(`${coords.meiliHost}/tasks/${taskUid}`, { headers: searchHeaders })
      const status = t.ok ? ((await t.json()) as { status: string }).status : "failed"
      if (status !== "enqueued" && status !== "processing") return
      await Bun.sleep(20)
    }
  }

  // Each index's `updatedAt` when it last held exactly the snapshot's
  // documents: an index no file wrote to since is left alone.
  const cleanAt = new Map<string, string>()
  for (const uid of searchSnapshot.keys()) {
    const at = await indexUpdatedAt(uid)
    if (at) cleanAt.set(uid, at)
  }

  async function resetIndex(uid: string): Promise<void> {
    const at = await indexUpdatedAt(uid)
    if (at === null) return // no such index (yet)
    if (cleanAt.get(uid) === at) return
    const docs = searchSnapshot.get(uid)
    if (!docs) {
      // An index with no documents and nothing being added needs no task (and
      // no wait for one); a pending addition would land after the reset.
      const stats = await fetch(`${coords.meiliHost}/indexes/${uid}/stats`, {
        headers: searchHeaders,
      })
      if (stats.ok) {
        const st = (await stats.json()) as { numberOfDocuments?: number; isIndexing?: boolean }
        if (st.numberOfDocuments === 0 && st.isIndexing === false) return
      }
    }
    // Documents only: the index settings (filterable attributes) were applied
    // at boot and the server will not apply them again.
    const del = await fetch(`${coords.meiliHost}/indexes/${uid}/documents`, {
      method: "DELETE",
      headers: searchHeaders,
    })
    if (del.ok) await waitForTask(((await del.json()) as { taskUid: number }).taskUid)
    if (docs) {
      const add = await fetch(`${coords.meiliHost}/indexes/${uid}/documents`, {
        method: "POST",
        headers: { ...searchHeaders, "content-type": "application/json" },
        body: JSON.stringify(docs),
      })
      if (add.ok) await waitForTask(((await add.json()) as { taskUid: number }).taskUid)
    }
    const after = await indexUpdatedAt(uid)
    if (after) cleanAt.set(uid, after)
  }

  async function clearSearch(): Promise<void> {
    await Promise.all((await laneIndexes()).map(resetIndex))
  }

  function clearAppsDir(): void {
    for (const entry of readdirSync(env.appsInstallDir)) {
      rmSync(path.join(env.appsInstallDir, entry), { recursive: true, force: true })
    }
  }

  const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`

  async function restoreAll(): Promise<string> {
    const t0 = performance.now()
    await restoreWorkerData(sql, workerId)
    const t1 = performance.now()
    let tRedis = 0
    let tSearch = 0
    await Promise.all([
      restoreRedis().then(() => {
        tRedis = performance.now() - t1
      }),
      clearSearch().then(() => {
        tSearch = performance.now() - t1
      }),
    ])
    return `data ${secs(t1 - t0)}, redis ${secs(tRedis)}, search ${secs(tSearch)}`
  }

  const baseEnv = env.currentEnv()
  // The env the running server was started with; null after a file changed it
  // through restart(), which forces the next attach to restart.
  let runningKey: string | null = stableKey(baseEnv)

  async function attach(serverEnv: Record<string, string>): Promise<void> {
    const t0 = performance.now()
    const wanted = { ...serverEnv }
    // What the server env would be: the base plus the file's overrides.
    const wantedKey = stableKey({ ...baseEnv, ...wanted })
    const appsChanged = (await installedAppsFingerprint(sql, workerId)) !== appsAtSnapshot
    const appsDirUsed = readdirSync(env.appsInstallDir).length > 0
    const why = !env.isRunning()
      ? "server down"
      : runningKey !== wantedKey
        ? "different serverEnv"
        : appsChanged || appsDirUsed
          ? "runtime app install"
          : null
    if (why) {
      await env.stopServer()
      const restored = await restoreAll()
      clearAppsDir()
      const t1 = performance.now()
      await env.startServer({ env: wanted, resetEnv: true, timeoutMs: 60_000 })
      runningKey = wantedKey
      console.log(
        `lane ${workerId}: attach restarted the server (${why}): ${restored}, boot ${secs(performance.now() - t1)}, total ${secs(performance.now() - t0)}`,
      )
      return
    }
    const restored = await restoreAll()
    const t1 = performance.now()
    const res = await fetch(`${env.serverUrl}/api/_test/lane/reset`, { method: "POST" })
    if (!res.ok) throw new Error(`lane reset failed: ${res.status} ${await res.text()}`)
    console.log(
      `lane ${workerId}: attach reset: ${restored}, caches ${secs(performance.now() - t1)}, total ${secs(performance.now() - t0)}`,
    )
  }

  // Calls are serialized: one file at a time per lane, but a file may restart
  // while a previous call's response is still in flight.
  let chain: Promise<unknown> = Promise.resolve()
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => {})
    return next
  }

  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const op = new URL(req.url).pathname.replace(/^\//, "")
      const body = (await req.json().catch(() => ({}))) as Record<string, any>
      try {
        if (op === "attach") {
          await serialize(() => attach((body.serverEnv ?? {}) as Record<string, string>))
        } else if (op === "stop") {
          await serialize(() => env.stopServer())
          runningKey = null
        } else if (op === "start") {
          const changes = Object.fromEntries(
            Object.entries((body.env ?? {}) as Record<string, string | null>).map(([k, v]) => [
              k,
              v ?? undefined,
            ]),
          )
          await serialize(() =>
            env.startServer({ env: changes, timeoutMs: body.timeoutMs ?? 30_000 }),
          )
          runningKey = null
        } else {
          return new Response("unknown op", { status: 404 })
        }
        return Response.json({ encryptionKey: env.encryptionKey, seed: seedResult })
      } catch (err) {
        return new Response(err instanceof Error ? (err.stack ?? err.message) : String(err), {
          status: 500,
        })
      }
    },
  })

  const info: LaneInfo = {
    workerId,
    serverUrl: env.serverUrl,
    ports: env.ports,
    schemaPrefix: env.schemaPrefix,
    redisPrefix: env.redisPrefix,
    meiliIndexPrefix: env.meiliIndexPrefix,
    controlUrl: `http://127.0.0.1:${control.port}`,
    stdoutPath,
    stderrPath,
  }

  return {
    info,
    seed: seedResult,
    async close() {
      control.stop(true)
      await dropWorkerSnapshot(sql, workerId).catch(() => {})
      await env.teardown()
    },
  }
}

async function waitForOutboxDrained(
  sql: OwnedWorkerEnv["db"]["sql"],
  schemaPrefix: string,
  timeoutMs = 90_000,
): Promise<boolean> {
  const table = `"${schemaPrefix}kernel".pending_events`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const [row] = (await sql.unsafe(
      `SELECT EXISTS (SELECT 1 FROM ${table} WHERE processed_at IS NULL AND failed_at IS NULL) AS pending`,
    )) as unknown as Array<{ pending: boolean }>
    if (!row?.pending) return true
    await Bun.sleep(100)
  }
  return false
}

async function waitForSearchIdle(
  host: string,
  key: string,
  uids: string[],
  timeoutMs = 30_000,
): Promise<void> {
  if (uids.length === 0) return
  const deadline = Date.now() + timeoutMs
  const headers = { Authorization: `Bearer ${key}` }
  const filter = `statuses=enqueued,processing&limit=1&indexUids=${uids.map(encodeURIComponent).join(",")}`
  while (Date.now() < deadline) {
    const res = await fetch(`${host}/tasks?${filter}`, { headers })
    if (!res.ok) return
    const body = (await res.json()) as { results?: unknown[] }
    if ((body.results ?? []).length === 0) return
    await Bun.sleep(50)
  }
}

/** The kernel queue of sweeps and short per-request timers (queue-classes.ts). */
const TIMER_QUEUES = ["kernel-cron"]
/** A delayed job due later than this is no part of the world being built (an approval's expiry, hours out). */
const DUE_HORIZON_MS = 90_000

/**
 * Waits until the timer queue has no job waiting or running and no delayed job
 * due within DUE_HORIZON_MS, scheduler ticks (`repeat:` ids, held while the
 * lane builds) aside. BullMQ scores a delayed job `timestamp * 0x1000 + n`.
 * Gives up after `timeoutMs` with a warning rather than failing the lane.
 */
async function waitForDueJobsIdle(
  redis: Redis,
  bullPrefix: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const busy = async (): Promise<boolean> => {
    for (const q of TIMER_QUEUES) {
      const key = `${bullPrefix}${q}`
      const waiting = await redis.lrange(`${key}:wait`, 0, -1)
      if (waiting.some((id) => !id.startsWith("repeat:"))) return true
      if ((await redis.llen(`${key}:active`)) > 0) return true
      const due = await redis.zrangebyscore(
        `${key}:delayed`,
        0,
        (Date.now() + DUE_HORIZON_MS) * 0x1000 + 0xfff,
      )
      if (due.some((id) => !id.startsWith("repeat:"))) return true
    }
    return false
  }
  let idleReads = 0
  while (Date.now() < deadline) {
    idleReads = (await busy()) ? 0 : idleReads + 1
    if (idleReads >= 2) return
    await Bun.sleep(200)
  }
  process.stderr.write(
    `[e2e-lane] timer jobs still due after ${timeoutMs / 1000}s; snapshotting anyway\n`,
  )
}

/** BullMQ queues whose jobs write the search index. */
const SEARCH_WRITE_QUEUES = ["app-search-index", "kernel-bulk"]

/**
 * Waits until no search-writing job is waiting, running or due: the queues'
 * wait, active and prioritized lists are empty and their delayed sets hold
 * only repeatable schedules (`repeat:` ids, the periodic sweeps). Gives up
 * after `timeoutMs` with a warning rather than failing the lane.
 */
async function waitForSearchJobsIdle(
  redis: Redis,
  bullPrefix: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const busy = async (): Promise<boolean> => {
    for (const q of SEARCH_WRITE_QUEUES) {
      const key = `${bullPrefix}${q}`
      if ((await redis.llen(`${key}:wait`)) > 0) return true
      if ((await redis.llen(`${key}:active`)) > 0) return true
      if ((await redis.zcard(`${key}:prioritized`)) > 0) return true
      const delayed = await redis.zrange(`${key}:delayed`, 0, "-1")
      if (delayed.some((id) => !id.startsWith("repeat:"))) return true
    }
    return false
  }
  // Two idle reads in a row: a finishing job can enqueue the next flush.
  let idleReads = 0
  while (Date.now() < deadline) {
    idleReads = (await busy()) ? 0 : idleReads + 1
    if (idleReads >= 2) return
    await Bun.sleep(200)
  }
  process.stderr.write(
    `[e2e-lane] search jobs still busy after ${timeoutMs / 1000}s; snapshotting anyway\n`,
  )
}
