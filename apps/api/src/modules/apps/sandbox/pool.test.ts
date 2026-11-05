// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { createSandboxPool, type SandboxPool } from "~/modules/apps/sandbox/pool"

describe("SandboxPool", () => {
  let pool: SandboxPool
  const sandboxTimeout = 20_000

  afterEach(async () => {
    if (pool) {
      await pool.shutdown()
      pool = undefined as unknown as SandboxPool
    }
  })

  it(
    "creates a pool with default pre-warmed slots",
    async () => {
      pool = await createSandboxPool({ initialSize: 2, maxSize: 5 })
      const stats = pool.stats()
      expect(stats.total).toBe(2)
      expect(stats.available).toBe(2)
      expect(stats.inUse).toBe(0)
    },
    sandboxTimeout,
  )

  it(
    "acquires and releases a slot",
    async () => {
      pool = await createSandboxPool({ initialSize: 2, maxSize: 5 })
      const slot = await pool.acquire()
      expect(slot.id).toBeGreaterThanOrEqual(0)
      expect(pool.stats().inUse).toBe(1)
      expect(pool.stats().available).toBe(1)

      pool.release(slot)
      expect(pool.stats().inUse).toBe(0)
      expect(pool.stats().available).toBe(2)
    },
    sandboxTimeout,
  )

  it(
    "grows pool on demand when all slots are in use",
    async () => {
      pool = await createSandboxPool({ initialSize: 1, maxSize: 5 })
      const slot1 = await pool.acquire()
      const slot2 = await pool.acquire() // triggers growth
      expect(pool.stats().total).toBe(2)
      expect(pool.stats().inUse).toBe(2)
      pool.release(slot1)
      pool.release(slot2)
    },
    sandboxTimeout,
  )

  it(
    "respects maxSize ceiling: queues at cap and hands off on release",
    async () => {
      pool = await createSandboxPool({ initialSize: 1, maxSize: 2, acquireTimeoutMs: 5_000 })
      const slot1 = await pool.acquire()
      const slot2 = await pool.acquire()
      expect(pool.stats().inUse).toBe(2)
      // Third acquire queues (no overflow slot is spawned any more) and is
      // handed slot1 when it frees.
      const third = pool.acquire()
      let settled = false
      void third.then(() => {
        settled = true
      })
      await new Promise((r) => setTimeout(r, 50))
      expect(settled).toBe(false)
      expect(pool.stats().total).toBe(2)
      pool.release(slot1)
      const slot3 = await third
      expect(slot3.id).toBe(slot1.id)
      expect(pool.stats().inUse).toBe(2)
      pool.release(slot2)
      pool.release(slot3)
      expect(pool.stats().total).toBeLessThanOrEqual(2)
    },
    sandboxTimeout,
  )

  it(
    "queued acquire fails after acquireTimeoutMs when the pool stays saturated",
    async () => {
      pool = await createSandboxPool({ initialSize: 1, maxSize: 1, acquireTimeoutMs: 200 })
      const slot1 = await pool.acquire()
      await expect(pool.acquire()).rejects.toThrow(/saturated/)
      pool.release(slot1)
    },
    sandboxTimeout,
  )

  it(
    "destroys and replaces a slot",
    async () => {
      pool = await createSandboxPool({ initialSize: 2, maxSize: 5 })
      const slot = await pool.acquire()
      const originalId = slot.id
      pool.destroy(slot)
      // Wait a tick for replacement to be created
      await new Promise((r) => setTimeout(r, 50))
      expect(pool.stats().total).toBe(2) // replacement created
      expect(pool.stats().available).toBe(2)
      // Next acquire gives a different slot
      const newSlot = await pool.acquire()
      expect(newSlot.id).not.toBe(originalId)
      pool.release(newSlot)
    },
    sandboxTimeout,
  )

  it(
    "shutdown disposes all slots",
    async () => {
      pool = await createSandboxPool({ initialSize: 3, maxSize: 5 })
      await pool.shutdown()
      expect(pool.stats().total).toBe(0)
    },
    sandboxTimeout,
  )
})
