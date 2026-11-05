// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, mock } from "bun:test"
import { ConnectionPool } from "~/modules/mcp-client/pool"

describe("ConnectionPool", () => {
  it("single-flights concurrent first-calls", async () => {
    const dial = mock(async () => ({ id: "live-1", close: mock(async () => {}) }))
    const pool = new ConnectionPool({ dial, idleMs: 60_000, clock: () => Date.now() })
    const [a, b, c] = await Promise.all([
      pool.get("conn-1"),
      pool.get("conn-1"),
      pool.get("conn-1"),
    ])
    expect(dial).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it("re-dials after idle reap", async () => {
    let now = 1000
    const dial = mock(async () => ({ id: `live-${now}`, close: mock(async () => {}) }))
    const pool = new ConnectionPool({ dial, idleMs: 1000, clock: () => now })
    await pool.get("conn-1")
    now = 3000
    pool.reapIdle()
    await pool.get("conn-1")
    expect(dial).toHaveBeenCalledTimes(2)
  })

  it("backoff on dial failure caps at 5 attempts", async () => {
    const dial = mock(async () => {
      throw new Error("ECONNREFUSED")
    })
    const pool = new ConnectionPool({
      dial,
      idleMs: 1000,
      clock: () => Date.now(),
      backoffMs: [1, 1, 1, 1, 1],
    })
    await expect(pool.get("conn-1")).rejects.toThrow(/exhausted/)
    expect(dial).toHaveBeenCalledTimes(5)
  })

  it("an error the dial cannot fix by retrying (a 401) surfaces at once, as itself", async () => {
    class AuthError extends Error {}
    const dial = mock(async () => {
      throw new AuthError("401")
    })
    const pool = new ConnectionPool({
      dial,
      idleMs: 1000,
      clock: () => Date.now(),
      backoffMs: [1, 1, 1, 1, 1],
      retryable: (err) => !(err instanceof AuthError),
    })
    await expect(pool.get("conn-1")).rejects.toBeInstanceOf(AuthError)
    expect(dial).toHaveBeenCalledTimes(1)
  })

  it("concurrent dialers all reject when dial fails (single-flight shares failure)", async () => {
    const dial = mock(async () => {
      throw new Error("boom")
    })
    const pool = new ConnectionPool({
      dial,
      idleMs: 1000,
      clock: () => Date.now(),
      backoffMs: [1],
    })
    const calls = await Promise.allSettled([pool.get("conn-1"), pool.get("conn-1")])
    expect(calls.every((c) => c.status === "rejected")).toBe(true)
    expect(dial).toHaveBeenCalledTimes(1)
  })

  it("startReapTimer fires reapIdle on schedule and can be cleanly stopped", async () => {
    let now = 1000
    const closes: number[] = []
    const dial = mock(async () => ({
      id: `live-${now}`,
      close: async () => {
        closes.push(now)
      },
    }))
    const pool = new ConnectionPool({ dial, idleMs: 100, clock: () => now })
    await pool.get("conn-1")
    pool.startReapTimer(10)
    await new Promise((r) => setTimeout(r, 5))
    now = 1200
    await new Promise((r) => setTimeout(r, 60))
    expect(closes.length).toBeGreaterThanOrEqual(1)
    const closesAtStop = closes.length
    pool.stopReapTimer()
    await new Promise((r) => setTimeout(r, 30))
    expect(closes.length).toBe(closesAtStop)
  })

  it("double reapIdle on a freshly-reaped entry does not double-close", async () => {
    let now = 1000
    const close = mock(async () => {})
    const dial = mock(async () => ({ id: "live-1", close }))
    const pool = new ConnectionPool({ dial, idleMs: 100, clock: () => now })
    await pool.get("conn-1")
    now = 2000
    pool.reapIdle()
    pool.reapIdle()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("drop closes and removes an entry; subsequent get re-dials", async () => {
    const close = mock(async () => {})
    const dial = mock(async () => ({ id: "live", close }))
    const pool = new ConnectionPool({ dial, idleMs: 60_000, clock: () => Date.now() })
    await pool.get("conn-1")
    await pool.drop("conn-1")
    expect(close).toHaveBeenCalledTimes(1)
    await pool.get("conn-1")
    expect(dial).toHaveBeenCalledTimes(2)
  })
})
