// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The coalescing live index queue, against the real Redis and a real Meili:
// N changes become one Meili task, the latest operation per document wins, a
// failed flush task puts back exactly its requests, and a crashed flusher's
// claims come back.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { MeiliSearch } from "meilisearch"
import * as jobsModule from "~/infra/jobs/jobs"
import * as searchClientModule from "~/infra/search/client"
import { redis } from "~/lib/redis"
import {
  flushLiveIndexOnce,
  type LiveIndexItem,
  LiveIndexTestAccess,
  MAX_ATTEMPTS,
  pendingLiveIndexCount,
  processLiveIndexFlushJob,
  processLiveIndexSweepJob,
  recordLiveIndex,
  registerLiveIndexResolver,
} from "./live-index-queue"

const INDEX_NAME = `test_live_idx_${crypto.randomUUID().slice(0, 8)}`
const meili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})

/** Test resolver: payload.title is the document; action delete deletes. */
registerLiveIndexResolver("test", async (items) => {
  const out = { docs: [] as Record<string, unknown>[], deleteIds: [] as string[], failed: [] }
  for (const it of items) {
    if (it.payload.action === "delete") out.deleteIds.push(it.key)
    else out.docs.push({ id: it.key, title: it.payload.title })
  }
  return out
})

function item(key: string, action: "upsert" | "delete", title = key): LiveIndexItem {
  return { t: "test", key, payload: { action, orgId: "org", title } }
}

async function taskTotal(): Promise<number> {
  const r = (await meili.tasks.getTasks({ indexUids: [INDEX_NAME], limit: 1 })) as {
    total?: number
  }
  return r.total ?? 0
}

async function settleAll(): Promise<void> {
  const r = await meili.tasks.getTasks({
    indexUids: [INDEX_NAME],
    statuses: ["enqueued", "processing"],
    limit: 100,
  })
  for (const t of r.results) await meili.tasks.waitForTask(t.uid)
}

const spies: Array<{ mockRestore: () => void }> = []
const scheduled: string[] = []

beforeAll(async () => {
  const c = await meili.createIndex(INDEX_NAME, { primaryKey: "id" })
  await meili.tasks.waitForTask(c.taskUid)
})

afterAll(async () => {
  await LiveIndexTestAccess.clear()
  try {
    await meili.deleteIndex(INDEX_NAME)
  } catch {
    /* a test artifact */
  }
})

beforeEach(async () => {
  await LiveIndexTestAccess.clear()
  scheduled.length = 0
  spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(INDEX_NAME))
  spies.push(spyOn(searchClientModule, "getMeili").mockReturnValue(meili as never))
  // The flush job itself is driven by the test; only record what was scheduled.
  spies.push(
    spyOn(jobsModule, "enqueueAppJob").mockImplementation(async (app, name, _p, opts) => {
      scheduled.push(`${app}:${name}:${opts?.jobId}`)
      return opts?.jobId ?? "id"
    }),
  )
})

afterEach(() => {
  for (const s of spies) s.mockRestore()
  spies.length = 0
})

describe("live index queue: coalescing", () => {
  it("200 changes to 20 documents become ONE Meili task of 20 documents", async () => {
    const before = await taskTotal()
    for (let round = 0; round < 10; round++) {
      await recordLiveIndex(
        Array.from({ length: 20 }, (_, i) => item(`doc-${i}`, "upsert", `v${round} doc ${i}`)),
      )
    }
    expect(await pendingLiveIndexCount()).toBe(20)
    // Recording schedules a flush on its own queue, never on app-kernel.
    expect(scheduled.length).toBeGreaterThan(0)
    expect(scheduled.every((s) => s.startsWith("search-index:search-index-flush:"))).toBe(true)

    await processLiveIndexFlushJob()
    await settleAll()
    expect((await taskTotal()) - before).toBe(1)
    expect(await pendingLiveIndexCount()).toBe(0)
    const hit = await meili.index(INDEX_NAME).getDocument("doc-7")
    expect(hit.title).toBe("v9 doc 7")
    const ledger = Object.values(await LiveIndexTestAccess.ledger())
    expect(ledger).toHaveLength(1)
    expect(ledger[0]!.items).toHaveLength(20)
  })

  it("the latest operation per document wins, in both orders", async () => {
    await recordLiveIndex([item("keep", "upsert"), item("gone", "upsert")])
    await flushLiveIndexOnce()
    await settleAll()
    await recordLiveIndex([item("keep", "delete"), item("gone", "upsert")])
    await recordLiveIndex([item("keep", "upsert", "keep again"), item("gone", "delete")])
    expect(await pendingLiveIndexCount()).toBe(2)
    await flushLiveIndexOnce()
    await settleAll()
    expect((await meili.index(INDEX_NAME).getDocument("keep")).title).toBe("keep again")
    await expect(meili.index(INDEX_NAME).getDocument("gone")).rejects.toThrow()
  })
})

describe("live index queue: failure detection by the sweep", () => {
  it("a flush task Meili FAILED puts back exactly its requests; a succeeded one leaves the ledger", async () => {
    // A document id Meili rejects makes the whole task fail.
    await recordLiveIndex([item("ok-1", "upsert"), item("bad id!", "upsert")])
    await flushLiveIndexOnce()
    await recordLiveIndex([item("ok-2", "upsert")])
    await flushLiveIndexOnce()
    await settleAll()
    expect(Object.keys(await LiveIndexTestAccess.ledger())).toHaveLength(2)

    const r = await processLiveIndexSweepJob()
    expect(r).toEqual({ succeeded: 1, failed: 1, requeued: 2 })
    expect(Object.keys(await LiveIndexTestAccess.ledger())).toHaveLength(0)
    const pending = (await LiveIndexTestAccess.pendingItems()).map((i) => [i.key, i.attempt])
    expect(pending.sort()).toEqual([
      ["bad id!", 1],
      ["ok-1", 1],
    ])
    // The sweep made sure a flush will pick them up.
    expect(scheduled.some((s) => s.startsWith("search-index:search-index-flush:"))).toBe(true)
  })

  it("a newer request for the same document is kept over the failed one", async () => {
    await recordLiveIndex([item("bad id!", "upsert", "old")])
    await flushLiveIndexOnce()
    await settleAll()
    await recordLiveIndex([item("bad id!", "delete")])
    await processLiveIndexSweepJob()
    const pending = await LiveIndexTestAccess.pendingItems()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.payload.action).toBe("delete")
    expect(pending[0]!.attempt).toBeUndefined()
  })

  it("a request that keeps failing is given up after MAX_ATTEMPTS", async () => {
    await recordLiveIndex([{ ...item("bad id!", "upsert"), attempt: MAX_ATTEMPTS - 1 }])
    await flushLiveIndexOnce()
    await settleAll()
    const r = await processLiveIndexSweepJob()
    expect(r.failed).toBe(1)
    expect(await pendingLiveIndexCount()).toBe(0)
  })

  it("one bad document never takes its batch-mates down: they are isolated and land", async () => {
    await recordLiveIndex([
      item("mate-a", "upsert"),
      item("mate-b", "upsert"),
      item("bad id!", "upsert"),
    ])
    // Fresh group fails; then the retried group fails; then each goes alone.
    for (let round = 0; round < MAX_ATTEMPTS; round++) {
      await flushLiveIndexOnce()
      await settleAll()
      await processLiveIndexSweepJob()
    }
    expect((await meili.index(INDEX_NAME).getDocument("mate-a")).title).toBe("mate-a")
    expect((await meili.index(INDEX_NAME).getDocument("mate-b")).title).toBe("mate-b")
    expect(await pendingLiveIndexCount()).toBe(0)
    expect(Object.keys(await LiveIndexTestAccess.ledger())).toHaveLength(0)
  })

  it("claims held by a flusher that died come back once the lock is gone", async () => {
    await recordLiveIndex([item("orphan", "upsert")])
    // Simulate a crash between claim and send.
    await redis.eval(
      `local k = redis.call('ZRANGE', KEYS[1], 0, 0)
       local v = redis.call('HGET', KEYS[2], k[1])
       redis.call('ZREM', KEYS[1], k[1]); redis.call('HDEL', KEYS[2], k[1])
       redis.call('HSET', KEYS[3], k[1], v); return 1`,
      3,
      LiveIndexTestAccess.keys.order,
      LiveIndexTestAccess.keys.items,
      LiveIndexTestAccess.keys.processing,
    )
    expect(await pendingLiveIndexCount()).toBe(0)
    await processLiveIndexSweepJob()
    expect(await pendingLiveIndexCount()).toBe(1)
  })

  it("a flush that finds the lock held re-arms itself instead of racing", async () => {
    await recordLiveIndex([item("x", "upsert")])
    scheduled.length = 0
    await redis.set(LiveIndexTestAccess.keys.lock, "someone-else", "PX", 5_000)
    await processLiveIndexFlushJob()
    expect(await pendingLiveIndexCount()).toBe(1)
    expect(scheduled).toHaveLength(1)
    await redis.del(LiveIndexTestAccess.keys.lock)
  })
})
