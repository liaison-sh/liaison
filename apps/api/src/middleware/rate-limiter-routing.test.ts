// SPDX-License-Identifier: FSL-1.1-ALv2
// The per-user limiter is composed onto the auth middleware in app.ts, and that
// composition is what a unit test of the middleware alone cannot see. These
// cases drive the REAL app with the limiter forced on (RATE_LIMIT_FORCE_ENABLED,
// the knob that exists so NODE_ENV=test does not leave the wiring untested).
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { app } from "~/app"
import {
  HARNESS_HEADER_NONCE,
  HARNESS_HEADER_SIGNATURE,
  HARNESS_HEADER_TIMESTAMP,
  LoadHarnessTestAccess,
  signHarnessRequest,
} from "~/lib/load-harness"
import { REDIS_PREFIX, redis } from "~/lib/redis"
import { bucketKey, RATE_LIMIT_DEFAULT, RATE_LIMIT_PER_USER } from "~/middleware/rate-limiter"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"

/**
 * A rate-limit bucket's key as the `redis` client names it. `bucketKey` is the
 * RAW key: the Lua script receives it through ARGV, so it carries REDIS_PREFIX
 * itself. The `redis` client prepends REDIS_PREFIX again through its keyPrefix,
 * so a test that reads or seeds the bucket through it passes the key minus that
 * prefix (under a namespaced run the prefix is never empty).
 */
function clientBucketKey(identifier: string, windowSeconds: number): string {
  return bucketKey(identifier, windowSeconds).slice(REDIS_PREFIX.length)
}

/** Fill a user's bucket to one below the ceiling, so the next call is the 601st. */
async function fillBucket(orgId: string, userId: string, upTo: number): Promise<string> {
  const key = clientBucketKey(`user:${orgId}:${userId}`, 60)
  const now = Date.now()
  const members: (string | number)[] = []
  for (let i = 0; i < upTo; i++) members.push(now - 1000, `seed:${i}`)
  await redis.del(key)
  if (members.length > 0) await redis.zadd(key, ...(members as [number, string]))
  return key
}

describe("per-user rate limiter wiring on the real app", () => {
  const keys: string[] = []

  const savedForceFlag = process.env.RATE_LIMIT_FORCE_ENABLED
  beforeAll(() => {
    process.env.RATE_LIMIT_FORCE_ENABLED = "1"
  })

  afterAll(async () => {
    if (savedForceFlag === undefined) delete process.env.RATE_LIMIT_FORCE_ENABLED
    else process.env.RATE_LIMIT_FORCE_ENABLED = savedForceFlag
    if (keys.length > 0) await redis.del(...keys)
  })

  it("429s the 601st authenticated call to an /api route, with Retry-After", async () => {
    const s = await minimal.adminSession((await createTestOrg()).id)
    keys.push(await fillBucket(s.orgId, s.userId, RATE_LIMIT_PER_USER - 1))
    const headers = { Authorization: `Bearer ${s.bearer}` }

    const r600 = await app.request("/api/user/preferences", { headers })
    expect(r600.status).not.toBe(429)

    const r601 = await app.request("/api/user/preferences", { headers })
    expect(r601.status).toBe(429)
    expect(Number(r601.headers.get("Retry-After"))).toBeGreaterThan(0)
  })

  it("exempts the long-lived agent chat stream from the per-user bucket", async () => {
    const s = await minimal.adminSession((await createTestOrg()).id)
    keys.push(await fillBucket(s.orgId, s.userId, RATE_LIMIT_PER_USER))
    const headers = { Authorization: `Bearer ${s.bearer}` }

    // Bucket is already full: any non-exempt route would 429 here.
    const blocked = await app.request("/api/user/preferences", { headers })
    expect(blocked.status).toBe(429)

    const stream = await app.request("/api/agent/chat", { headers })
    expect(stream.status).not.toBe(429)
  })

  it("limits /api/auth/ws-ticket, which mounts auth without authMw", async () => {
    const s = await minimal.adminSession((await createTestOrg()).id)
    keys.push(await fillBucket(s.orgId, s.userId, RATE_LIMIT_PER_USER))
    const r = await app.request("/api/auth/ws-ticket", {
      method: "POST",
      headers: { Authorization: `Bearer ${s.bearer}` },
    })
    expect(r.status).toBe(429)
  })

  it("charges one token for a path that matches two mounts", async () => {
    const s = await minimal.adminSession((await createTestOrg()).id)
    const key = await fillBucket(s.orgId, s.userId, 0)
    keys.push(key)
    // /api/apps/manifests/attention-axes matches both the /api/apps/* group and
    // its own line, so authMw plus the limiter run twice for the one request.
    const res = await app.request("/api/apps/manifests/attention-axes", {
      headers: { Authorization: `Bearer ${s.bearer}` },
    })
    expect(res.status).toBe(200)
    expect(await redis.zcard(key)).toBe(1)
  })

  it("does not user-limit an unauthenticated /api request", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await app.request("/api/user/preferences")
      expect(r.status).toBe(401)
    }
  })
})

describe("credential-recovery routes survive a Redis outage end to end", () => {
  // Both layers must agree: the per-IP limiter runs first on /api/*, so a
  // fail-open per-user limiter behind a fail-closed IP limiter would never be
  // reached during the outage it exists for.
  const savedForceFlag = process.env.RATE_LIMIT_FORCE_ENABLED
  beforeAll(() => {
    process.env.RATE_LIMIT_FORCE_ENABLED = "1"
  })
  afterAll(() => {
    if (savedForceFlag === undefined) delete process.env.RATE_LIMIT_FORCE_ENABLED
    else process.env.RATE_LIMIT_FORCE_ENABLED = savedForceFlag
  })

  it("ws-ticket answers while a general /api route 503s, with Redis throwing", async () => {
    const s = await minimal.adminSession((await createTestOrg()).id)
    const headers = { Authorization: `Bearer ${s.bearer}` }
    const broken = spyOn(redis, "eval").mockImplementation((() => {
      throw new Error("redis down")
    }) as unknown as typeof redis.eval)
    try {
      const ticket = await app.request("/api/auth/ws-ticket", { method: "POST", headers })
      expect(ticket.status).not.toBe(503)
      expect(ticket.status).toBe(200)

      const general = await app.request("/api/user/preferences", { headers })
      expect(general.status).toBe(503)
    } finally {
      broken.mockRestore()
    }
  })
})

describe("per-IP limiter and the load harness", () => {
  const savedForceFlag = process.env.RATE_LIMIT_FORCE_ENABLED
  const KEY = "k".repeat(40)
  const peer = "198.51.100.77"
  const ipKey = clientBucketKey(peer, 60)

  beforeAll(async () => {
    process.env.RATE_LIMIT_FORCE_ENABLED = "1"
    LoadHarnessTestAccess.setKey(KEY)
    // The peer's per-IP bucket is already full.
    const now = Date.now()
    const members: (string | number)[] = []
    for (let i = 0; i < RATE_LIMIT_DEFAULT; i++) members.push(now - 1000, `seed:${i}`)
    await redis.del(ipKey)
    await redis.zadd(ipKey, ...(members as [number, string]))
  })

  afterAll(async () => {
    if (savedForceFlag === undefined) delete process.env.RATE_LIMIT_FORCE_ENABLED
    else process.env.RATE_LIMIT_FORCE_ENABLED = savedForceFlag
    LoadHarnessTestAccess.setKey(undefined)
    await redis.del(ipKey)
  })

  function signed(path: string, key = KEY): Record<string, string> {
    const timestamp = Date.now()
    const nonce = crypto.randomUUID().replaceAll("-", "")
    const signature = signHarnessRequest({ method: "GET", path, timestamp, nonce, body: "" }, key)
    return {
      "x-bun-socket-ip": peer,
      [HARNESS_HEADER_TIMESTAMP]: String(timestamp),
      [HARNESS_HEADER_NONCE]: nonce,
      [HARNESS_HEADER_SIGNATURE]: signature,
    }
  }

  it("lets a request signed with the harness key past a full per-IP bucket, and only it", async () => {
    const plain = await app.request("/api/health", { headers: { "x-bun-socket-ip": peer } })
    expect(plain.status).toBe(429)

    const ok = await app.request("/api/health", { headers: signed("/api/health") })
    expect(ok.status).not.toBe(429)

    // A wrong key, or the same signature replayed, is limited like any request.
    const forged = await app.request("/api/health", {
      headers: signed("/api/health", "x".repeat(40)),
    })
    expect(forged.status).toBe(429)
    const once = signed("/api/health")
    expect((await app.request("/api/health", { headers: once })).status).not.toBe(429)
    expect((await app.request("/api/health", { headers: once })).status).toBe(429)
  })

  it("does nothing without the key: a signed request is limited", async () => {
    LoadHarnessTestAccess.setKey(null)
    try {
      const r = await app.request("/api/health", { headers: signed("/api/health") })
      expect(r.status).toBe(429)
    } finally {
      LoadHarnessTestAccess.setKey(KEY)
    }
  })
})
