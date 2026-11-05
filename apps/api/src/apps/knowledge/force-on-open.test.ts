// SPDX-License-Identifier: FSL-1.1-ALv2
// Opening a stale synced document queues a sync, but the read must never wait
// on Redis: the BullMQ connection retries forever, so an outage would hang the
// GET. The wait is capped; a hung, failed or refused enqueue is deferred.
import { describe, expect, it } from "bun:test"
import { requestForceOnOpenSync } from "./force-on-open"

const stale = { syncedSourceId: "src-1", lastSyncedAt: new Date(Date.now() - 60_000).toISOString() }

describe("force-on-open sync", () => {
  it("returns within its cap when the enqueue hangs, and reports the sync deferred", async () => {
    const hanging = () => new Promise<string>(() => {})
    const started = Date.now()
    const result = await requestForceOnOpenSync(stale, "u1", { enqueue: hanging, waitMs: 50 })
    expect(result).toEqual({ deferred: true })
    expect(Date.now() - started).toBeLessThan(500)
  })

  it("reports a refused enqueue as deferred instead of failing the read", async () => {
    const refused = async () => {
      throw new Error("Queue app-knowledge refused a job (redis-memory)")
    }
    expect(await requestForceOnOpenSync(stale, "u1", { enqueue: refused, waitMs: 50 })).toEqual({
      deferred: true,
    })
  })

  it("queues the sync with its dedup id when stale, and nothing when fresh", async () => {
    const calls: unknown[][] = []
    const enqueue = async (...args: unknown[]) => {
      calls.push(args)
      return "ok"
    }
    expect(await requestForceOnOpenSync(stale, "u1", { enqueue, waitMs: 50 })).toEqual({
      deferred: false,
    })
    expect(calls[0]?.[3]).toEqual({ jobId: "sync:src-1" })
    const fresh = { syncedSourceId: "src-1", lastSyncedAt: new Date().toISOString() }
    await requestForceOnOpenSync(fresh, "u1", { enqueue, waitMs: 50 })
    await requestForceOnOpenSync({ syncedSourceId: null }, "u1", { enqueue, waitMs: 50 })
    expect(calls).toHaveLength(1)
  })
})
