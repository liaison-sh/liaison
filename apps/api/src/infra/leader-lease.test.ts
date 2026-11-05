// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Redis leader lease that elects the one process running the singletons,
// against the real (per-run prefixed) Redis. Short timings: ttl 600 ms, renew
// 150 ms, poll 100 ms. Every test uses its own key.
import { afterEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { type LeaseRedis, RedisLeaderLease } from "~/infra/leader-lease"
import { redis } from "~/lib/redis"

const TTL = 600
const RENEW = 150
const POLL = 100

const leases: RedisLeaderLease[] = []

function lease(
  key: string,
  holderId: string,
  onChange: (held: boolean) => void | Promise<void> = () => {},
  extra: Partial<ConstructorParameters<typeof RedisLeaderLease>[0]> = {},
): RedisLeaderLease {
  const l = new RedisLeaderLease(
    { key, holderId, ttlMs: TTL, renewMs: RENEW, pollMs: POLL, ...extra },
    onChange,
  )
  leases.push(l)
  return l
}

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs: number): Promise<number> {
  const start = Date.now()
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition never met")
    await new Promise((r) => setTimeout(r, 10))
  }
  return Date.now() - start
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const newKey = () => `leader-lease-test:${crypto.randomUUID()}`

/** A client that forwards to Redis until `freeze()`, then never answers: a
 *  process that stopped (SIGKILL, frozen) without releasing anything. */
function freezable(): { client: LeaseRedis; freeze: () => void } {
  let frozen = false
  const never = new Promise<never>(() => {})
  return {
    client: {
      set: (k, v, px, ms, nx) => (frozen ? never : redis.set(k, v, px, ms, nx)),
      eval: (script, numKeys, ...args) => (frozen ? never : redis.eval(script, numKeys, ...args)),
    },
    freeze: () => {
      frozen = true
    },
  }
}

afterEach(async () => {
  await Promise.all(leases.splice(0).map((l) => l.stop()))
})

describe("RedisLeaderLease", () => {
  it("exactly one of two contenders holds the lease", async () => {
    const key = newKey()
    const a = lease(key, "a")
    const b = lease(key, "b")
    await Promise.all([a.start(), b.start()])
    await sleep(RENEW * 3)
    expect([a.held(), b.held()].filter(Boolean)).toHaveLength(1)
    const holder = a.held() ? "a" : "b"
    expect(await redis.get(key)).toBe(holder)
  })

  it("reports acquired once, with the key holding the holder id", async () => {
    const key = newKey()
    const changes: boolean[] = []
    const a = lease(key, "a", (h) => {
      changes.push(h)
    })
    await a.start()
    await sleep(RENEW * 3)
    expect(a.held()).toBe(true)
    expect(changes).toEqual([true])
    expect(await redis.get(key)).toBe("a")
  })

  it("the other takes over within ttl + 2 s after the holder stops renewing without release", async () => {
    const key = newKey()
    const frozenHolder = freezable()
    const a = lease(key, "a", () => {}, { client: frozenHolder.client })
    await a.start()
    expect(a.held()).toBe(true)
    const b = lease(key, "b")
    await b.start()
    expect(b.held()).toBe(false)
    frozenHolder.freeze() // SIGKILL-style: no renew, no release
    const elapsed = await waitFor(() => b.held(), TTL + 2_000)
    expect(elapsed).toBeLessThanOrEqual(TTL + 2_000)
    expect(await redis.get(key)).toBe("b")
  })

  it("a stolen key is noticed at the next renew", async () => {
    const key = newKey()
    const changes: boolean[] = []
    const a = lease(key, "a", (h) => {
      changes.push(h)
    })
    await a.start()
    expect(a.held()).toBe(true)
    await redis.set(key, "other", "PX", 60_000)
    await waitFor(() => changes.includes(false), RENEW * 2 + 100)
    expect(a.held()).toBe(false)
    // The thief's key is left alone.
    expect(await redis.get(key)).toBe("other")
  })

  it("a hung Redis declares loss before the TTL runs out", async () => {
    const key = newKey()
    let clock = 0
    const never = new Promise<never>(() => {})
    const client: LeaseRedis = {
      set: async () => "OK",
      eval: () => never,
    }
    const changes: boolean[] = []
    const a = lease(
      key,
      "a",
      (h) => {
        changes.push(h)
      },
      { client, now: () => clock },
    )
    await a.start()
    expect(a.held()).toBe(true)
    // The local clock says the last confirmed renew is a full TTL old.
    clock = TTL
    const started = Date.now()
    await waitFor(() => changes.includes(false), TTL)
    expect(Date.now() - started).toBeLessThan(TTL)
    expect(a.held()).toBe(false)
  })

  it("a hung renew counts as a failure after renewMs, even on a real clock", async () => {
    const key = newKey()
    const never = new Promise<never>(() => {})
    const client: LeaseRedis = { set: async () => "OK", eval: () => never }
    const changes: boolean[] = []
    const a = lease(
      key,
      "a",
      (h) => {
        changes.push(h)
      },
      { client },
    )
    const started = Date.now()
    await a.start()
    await waitFor(() => changes.includes(false), TTL)
    expect(Date.now() - started).toBeLessThan(TTL)
  })

  it("stop releases only its own key", async () => {
    const key = newKey()
    const a = lease(key, "a")
    await a.start()
    expect(await redis.get(key)).toBe("a")
    await a.stop()
    expect(a.held()).toBe(false)
    expect(await redis.get(key)).toBeNull()

    const key2 = newKey()
    const holder = lease(key2, "holder")
    const other = lease(key2, "other")
    await holder.start()
    await other.start()
    expect(other.held()).toBe(false)
    await other.stop()
    expect(await redis.get(key2)).toBe("holder")
  })

  it("stop: held flips false, the lost hook is awaited, then the key is released", async () => {
    const key = newKey()
    const seen: string[] = []
    let a: RedisLeaderLease | undefined
    a = lease(key, "a", async (h) => {
      if (h) return
      seen.push(`held=${a?.held()}`)
      await sleep(80)
      seen.push(`key-during-hook=${await redis.get(key)}`)
    })
    await a.start()
    await a.stop()
    seen.push(`key-after-stop=${await redis.get(key)}`)
    expect(seen).toEqual(["held=false", "key-during-hook=a", "key-after-stop=null"])
  })

  it("contends only while canContend() holds; losing it releases after the hook", async () => {
    const key = newKey()
    let eligible = false
    const seen: string[] = []
    const a = lease(
      key,
      "a",
      async (h) => {
        if (h) {
          seen.push("acquired")
          return
        }
        await sleep(50)
        seen.push(`lost, key=${await redis.get(key)}`)
      },
      { canContend: () => eligible },
    )
    await a.start()
    await sleep(POLL * 3)
    expect(a.held()).toBe(false)
    expect(await redis.get(key)).toBeNull()

    eligible = true
    await waitFor(() => a.held(), POLL * 3)
    expect(await redis.get(key)).toBe("a")

    eligible = false
    await waitFor(() => !a.held(), RENEW * 3)
    await waitFor(async () => (await redis.get(key)) === null, RENEW * 3)
    expect(seen).toEqual(["acquired", "lost, key=a"])
  })

  it("a slow acquire hook does not stall renewal: the lease outlives the TTL", async () => {
    const key = newKey()
    const changes: boolean[] = []
    const a = lease(key, "a", async (h) => {
      changes.push(h)
      if (h) await sleep(TTL + 400)
    })
    void a.start()
    await waitFor(() => a.held(), POLL * 3)
    // The hook is still running past the TTL: renewals kept the key.
    await sleep(TTL + 150)
    expect(await redis.get(key)).toBe("a")
    expect(a.held()).toBe(true)
    await sleep(400)
    expect(a.held()).toBe(true)
    expect(await redis.get(key)).toBe("a")
    expect(changes).toEqual([true])
  })

  it("a loss during a slow acquire hook: held false, lost after acquired settles, then release", async () => {
    const key = newKey()
    const seen: string[] = []
    let a: RedisLeaderLease | undefined
    a = lease(key, "a", async (h) => {
      if (h) {
        await sleep(300)
        seen.push(`acquired-done held=${a?.held()}`)
        return
      }
      seen.push(`lost key=${await redis.get(key)}`)
    })
    void a.start()
    await waitFor(() => a?.held() === true, POLL * 3)
    await a.stop()
    seen.push(`after-stop key=${await redis.get(key)}`)
    expect(seen).toEqual(["acquired-done held=false", "lost key=a", "after-stop key=null"])
  })

  it("an acquire that timed out but landed is adopted, not orphaned until the TTL", async () => {
    const key = newKey()
    let first = true
    const client: LeaseRedis = {
      set: async (k, v, px, ms, nx) => {
        if (first) {
          first = false
          await sleep(RENEW + 60) // answers after the lease gave up on it, and lands
        }
        return redis.set(k, v, px, ms, nx)
      },
      eval: (script, numKeys, ...args) => redis.eval(script, numKeys, ...args),
    }
    const a = lease(key, "a", () => {}, { client })
    await a.start()
    expect(a.held()).toBe(false)
    // Adopted at the next poll, long before the landed key's TTL ran out.
    await waitFor(() => a.held(), TTL / 2)
    expect(await redis.get(key)).toBe("a")
  })

  it("stop racing a successful acquire releases the key it just set", async () => {
    const key = newKey()
    const changes: boolean[] = []
    const client: LeaseRedis = {
      set: async (k, v, px, ms, nx) => {
        await sleep(50)
        return redis.set(k, v, px, ms, nx)
      },
      eval: (script, numKeys, ...args) => redis.eval(script, numKeys, ...args),
    }
    const a = lease(
      key,
      "a",
      (h) => {
        changes.push(h)
      },
      { client },
    )
    const starting = a.start()
    await sleep(10)
    await a.stop()
    await starting
    expect(a.held()).toBe(false)
    expect(await redis.get(key)).toBeNull()
    expect(changes).toEqual([])
  })

  it("a contender polls at pollMs, faster than the renew period", async () => {
    const key = newKey()
    const b = lease(key, "b", () => {}, { renewMs: 5_000, ttlMs: 15_000, pollMs: 50 })
    await redis.set(key, "someone", "PX", 60_000)
    await b.start()
    expect(b.held()).toBe(false)
    await redis.del(key)
    const elapsed = await waitFor(() => b.held(), 1_000)
    expect(elapsed).toBeLessThan(1_000)
  })
})
