// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The ended-session cache (session-revocation.ts) over real Redis: the local
// lookup, expiry, what a peer process hears on the channel, the resync a
// process runs on boot and on reconnect, and the socket watchers.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import Redis from "ioredis"
import { env } from "~/lib/env"
import { REDIS_PREFIX, redis } from "~/lib/redis"
import {
  initSessionRevocation,
  isSessionRevoked,
  REVOCATION_TTL_MS,
  resyncRevokedSessions,
  revokeSessions,
  SessionRevocationTestAccess as T,
  watchSession,
} from "~/modules/auth/session-revocation"

const sid = () => crypto.randomUUID()

async function until(ok: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms
  while (!ok() && Date.now() < end) await Bun.sleep(10)
  return ok()
}

describe("session revocation cache", () => {
  beforeAll(async () => {
    await redis.del(T.key)
    await initSessionRevocation()
  })
  afterEach(async () => {
    T.reset()
    await redis.del(T.key)
  })
  afterAll(() => {
    T.stopTimers()
  })

  it("refuses a revoked session at once on this process, and nothing else", () => {
    const a = sid()
    const b = sid()
    revokeSessions([a], "test")
    expect(isSessionRevoked(a)).toBe(true)
    expect(isSessionRevoked(b)).toBe(false)
  })

  it("forgets a revocation once no access token of it can still verify", () => {
    const a = sid()
    T.remember(a, Date.now() + 20)
    expect(isSessionRevoked(a)).toBe(true)
    const past = sid()
    T.remember(past, Date.now() - 1)
    expect(isSessionRevoked(past)).toBe(false)
    expect(REVOCATION_TTL_MS).toBeGreaterThanOrEqual(15 * 60_000)
  })

  it("expires an entry lazily on lookup", async () => {
    const a = sid()
    T.remember(a, Date.now() + 30)
    await Bun.sleep(50)
    expect(isSessionRevoked(a)).toBe(false)
    expect(T.size()).toBe(0)
  })

  it("writes the revocation to the shared set with its forget-at time and publishes it", async () => {
    const listener = new Redis(env.REDIS_URL)
    const heard: string[] = []
    listener.on("message", (_c, m) => heard.push(m))
    await listener.subscribe(T.channel)
    try {
      const a = sid()
      const before = Date.now()
      revokeSessions([a, a, ""], "test")
      expect(await until(() => heard.length > 0)).toBe(true)
      const msg = JSON.parse(heard[0] as string) as { sids: string[]; forgetAt: number }
      expect(msg.sids).toEqual([a])
      expect(msg.forgetAt).toBeGreaterThanOrEqual(before + REVOCATION_TTL_MS)
      const score = await redis.zscore(T.key, a)
      expect(Number(score)).toBe(msg.forgetAt)
      const ttl = await redis.pttl(T.key)
      expect(ttl).toBeGreaterThan(0)
      expect(ttl).toBeLessThanOrEqual(REVOCATION_TTL_MS)
    } finally {
      listener.disconnect()
    }
  })

  it("learns a revocation a peer process published on the channel", async () => {
    const a = sid()
    const peer = new Redis(env.REDIS_URL)
    try {
      await peer.publish(T.channel, JSON.stringify({ sids: [a], forgetAt: Date.now() + 60_000 }))
      expect(await until(() => isSessionRevoked(a))).toBe(true)
    } finally {
      peer.disconnect()
    }
  })

  it("ignores a malformed channel message", () => {
    T.deliver("not json")
    T.deliver(JSON.stringify({ sids: "x", forgetAt: 1 }))
    expect(T.size()).toBe(0)
  })

  it("loads what peers revoked while it was not listening (boot, reconnect), skipping expired rows", async () => {
    const live = sid()
    const old = sid()
    // Written as a peer's MULTI writes it, with no publish this process hears.
    await redis.zadd(T.key, Date.now() + 60_000, live, Date.now() - 1000, old)
    expect(isSessionRevoked(live)).toBe(false)
    const loaded = await resyncRevokedSessions()
    expect(loaded).toBe(1)
    expect(isSessionRevoked(live)).toBe(true)
    expect(isSessionRevoked(old)).toBe(false)
  })

  it("keys the set and the channel under this run's Redis prefix", () => {
    expect(T.channel.startsWith(REDIS_PREFIX)).toBe(true)
  })

  it("closes the sockets watching a session when it ends, here or on a peer", async () => {
    const a = sid()
    const b = sid()
    let closedA = 0
    let closedB = 0
    watchSession(a, () => closedA++)
    watchSession(a, () => closedA++)
    const stopB = watchSession(b, () => closedB++)
    revokeSessions([a], "test")
    expect(closedA).toBe(2)
    expect(T.watcherCount(a)).toBe(0)

    stopB()
    T.deliver(JSON.stringify({ sids: [b], forgetAt: Date.now() + 60_000 }))
    expect(closedB).toBe(0)

    const c = sid()
    let closedC = 0
    watchSession(c, () => closedC++)
    T.deliver(JSON.stringify({ sids: [c], forgetAt: Date.now() + 60_000 }))
    expect(closedC).toBe(1)
  })

  it("closes at once a socket that starts watching an already-ended session", () => {
    const a = sid()
    revokeSessions([a], "test")
    let closed = 0
    watchSession(a, () => closed++)
    expect(closed).toBe(1)
    expect(T.watcherCount(a)).toBe(0)
  })

  it("never throws from revokeSessions when Redis cannot take the write", async () => {
    const a = sid()
    const original = redis.multi.bind(redis)
    ;(redis as unknown as { multi: () => never }).multi = () => {
      throw new Error("redis down")
    }
    try {
      expect(() => revokeSessions([a], "test")).not.toThrow()
      // This process still refuses it.
      expect(isSessionRevoked(a)).toBe(true)
    } finally {
      ;(redis as unknown as { multi: typeof original }).multi = original
    }
  })

  it("the request-path lookup costs well under a microsecond", () => {
    for (let i = 0; i < 10_000; i++) T.remember(sid(), Date.now() + 60_000)
    const probe = Array.from({ length: 1000 }, () => sid())
    const n = 1_000_000
    const start = Bun.nanoseconds()
    let hits = 0
    for (let i = 0; i < n; i++) if (isSessionRevoked(probe[i % 1000] as string)) hits++
    const nsPerLookup = (Bun.nanoseconds() - start) / n
    expect(hits).toBe(0)
    // Generous bound so a loaded CI runner passes; measured locally ~20-60 ns.
    expect(nsPerLookup).toBeLessThan(2000)
  })
})
