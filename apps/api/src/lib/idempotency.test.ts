// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import {
  IdempotencyConflictError,
  IdempotencyInFlightError,
  IdempotencyTestAccess,
  idempotencyContentHash,
  withIdempotency,
} from "~/lib/idempotency"
import { redis } from "~/lib/redis"

const freshKey = () => `idem:test:${crypto.randomUUID()}`

/** Phases that count how often the write and the replay ran. */
function counted(opts: { commitThrows?: boolean; afterThrows?: boolean } = {}) {
  const calls = { commit: 0, after: 0, replay: 0 }
  return {
    calls,
    phases: {
      commit: async () => {
        calls.commit++
        if (opts.commitThrows) throw new Error("commit failed")
        return { id: `row-${calls.commit}` }
      },
      after: async (r: { id: string }) => {
        calls.after++
        if (opts.afterThrows) throw new Error("after failed")
        return { id: r.id, replayed: false }
      },
      replay: async (r: { id: string }) => {
        calls.replay++
        return { id: r.id, replayed: true }
      },
    },
  }
}

afterEach(() => IdempotencyTestAccess.setStore())

describe("withIdempotency", () => {
  it("runs the write once and replays the stored result for a retry", async () => {
    const key = freshKey()
    const { calls, phases } = counted()
    const first = await withIdempotency(key, "h1", phases)
    const second = await withIdempotency(key, "h1", phases)
    expect(first).toEqual({ id: "row-1", replayed: false })
    expect(second).toEqual({ id: "row-1", replayed: true })
    expect(calls).toEqual({ commit: 1, after: 1, replay: 1 })
    await redis.del(key)
  })

  it("refuses the same key with a different payload", async () => {
    const key = freshKey()
    const { calls, phases } = counted()
    await withIdempotency(key, "h1", phases)
    await expect(withIdempotency(key, "h2", phases)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    )
    expect(calls.commit).toBe(1)
    await redis.del(key)
  })

  it("a failed first run frees the key", async () => {
    const key = freshKey()
    const failing = counted({ commitThrows: true })
    await expect(withIdempotency(key, "h1", failing.phases)).rejects.toThrow("commit failed")
    expect(await redis.get(key)).toBeNull()
    const ok = counted()
    expect(await withIdempotency(key, "h1", ok.phases)).toEqual({ id: "row-1", replayed: false })
    expect(ok.calls.commit).toBe(1)
    await redis.del(key)
  })

  it("a throw after the commit keeps the key: the retry replays and never writes again", async () => {
    const key = freshKey()
    const { calls, phases } = counted({ afterThrows: true })
    await expect(withIdempotency(key, "h1", phases)).rejects.toThrow("after failed")
    const replay = await withIdempotency(key, "h1", phases)
    expect(replay).toEqual({ id: "row-1", replayed: true })
    expect(calls.commit).toBe(1)
    await redis.del(key)
  })

  it("concurrent duplicates run the write once", async () => {
    const key = freshKey()
    let commits = 0
    const phases = {
      commit: async () => {
        commits++
        await new Promise((r) => setTimeout(r, 150))
        return { id: "only" }
      },
      after: async (r: { id: string }) => r.id,
      replay: async (r: { id: string }) => r.id,
    }
    const [a, b] = await Promise.all([
      withIdempotency(key, "h1", phases),
      withIdempotency(key, "h1", phases),
    ])
    expect([a, b]).toEqual(["only", "only"])
    expect(commits).toBe(1)
    await redis.del(key)
  })

  it("a duplicate that outwaits a still-running first request answers in flight", async () => {
    const key = freshKey()
    await redis.set(key, JSON.stringify({ state: "pending", contentHash: "h1" }), "EX", 10)
    const { calls, phases } = counted()
    await expect(withIdempotency(key, "h1", phases, { waitMs: 250 })).rejects.toBeInstanceOf(
      IdempotencyInFlightError,
    )
    expect(calls.commit).toBe(0)
    await redis.del(key)
  })

  it("Redis not answering: the write proceeds without dedup, within the bound", async () => {
    const hang = () => new Promise<never>(() => {})
    IdempotencyTestAccess.setStore({ claim: hang, get: hang, put: hang, del: hang })
    const { calls, phases } = counted()
    const started = Date.now()
    await withIdempotency(freshKey(), "h1", phases, { redisTimeoutMs: 100 })
    await withIdempotency(freshKey(), "h1", phases, { redisTimeoutMs: 100 })
    expect(calls.commit).toBe(2)
    expect(calls.replay).toBe(0)
    // claim (100 ms) + put (100 ms) per call, never an unbounded wait.
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it("hashes payloads independently of key order", () => {
    expect(idempotencyContentHash({ a: 1, b: { c: 2, d: 3 } })).toBe(
      idempotencyContentHash({ b: { d: 3, c: 2 }, a: 1 }),
    )
    expect(idempotencyContentHash({ a: 1 })).not.toBe(idempotencyContentHash({ a: 2 }))
  })
})
