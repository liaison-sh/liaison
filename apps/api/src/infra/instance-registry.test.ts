// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Instance liveness (A12): the heartbeat record, the readers that ignore a
// process without one, the leader's dead-instance sweep and the recovery hook
// an instance runs when its record comes back after a lapse. Real Redis under
// the run's non-empty REDIS_PREFIX; every test uses fresh instance ids and its
// own set key, so nothing collides with a server sharing the prefix.
import { afterEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import Redis from "ioredis"
import { InstanceRegistry, LIVE_INSTANCE_KEY, type RegistryRedis } from "~/infra/instance-registry"
import { LeadershipTestAccess, startLeadership, stopLeadership } from "~/infra/leadership"
import { env } from "~/lib/env"
import { REDIS_PREFIX, RESP_PROTOCOL, redis } from "~/lib/redis"

const TTL = 300
const HEARTBEAT = 100
const SWEEP = 100

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const start = Date.now()
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition never met")
    await sleep(10)
  }
}

/** A client whose commands can be made to hang, as Redis does during an outage. */
class HangableClient implements RegistryRedis {
  hang = false
  constructor(private readonly inner: Redis) {}
  private gate<T>(p: () => Promise<T>): Promise<T> {
    return this.hang ? new Promise<T>(() => {}) : p()
  }
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    return this.gate(() => this.inner.eval(script, numKeys, ...args))
  }
  smembers(key: string): Promise<string[]> {
    return this.gate(() => this.inner.smembers(key))
  }
  get(key: string): Promise<string | null> {
    return this.gate(() => this.inner.get(key))
  }
  exists(key: string): Promise<number> {
    return this.gate(() => this.inner.exists(key))
  }
}

const registries: InstanceRegistry[] = []
const extraClients: Redis[] = []

function makeRegistry(
  opts: { id?: string; setKey: string; client?: RegistryRedis; prefix?: string } & Partial<{
    ttlMs: number
    heartbeatMs: number
  }>,
): InstanceRegistry {
  const r = new InstanceRegistry({
    instanceId: opts.id ?? crypto.randomUUID(),
    client: opts.client ?? redis,
    prefix: opts.prefix ?? REDIS_PREFIX,
    setKey: opts.setKey,
    ttlMs: opts.ttlMs ?? TTL,
    heartbeatMs: opts.heartbeatMs ?? HEARTBEAT,
    sweepIntervalMs: SWEEP,
    commandTimeoutMs: 200,
  })
  registries.push(r)
  return r
}

const newSetKey = () => `live:instances:test:${crypto.randomUUID()}`
const leaseOpts = () => ({
  key: `instance-registry-test:${crypto.randomUUID()}`,
  ttlMs: 3_000,
  renewMs: 1_000,
  pollMs: 250,
})

afterEach(async () => {
  for (const r of registries.splice(0)) await r.stop({ releaseOwned: false })
  await LeadershipTestAccess.reset()
  for (const c of extraClients.splice(0)) c.disconnect()
})

describe("heartbeat", () => {
  it("a started instance is live, a stopped one is not", async () => {
    const setKey = newSetKey()
    const a = makeRegistry({ setKey })
    await a.start({ role: "api", pid: 4242 })
    expect(await a.isInstanceLive(a.instanceId)).toBe(true)
    const rec = await a.readInstance(a.instanceId)
    expect(rec?.role).toBe("api")
    expect(rec?.pid).toBe(4242)
    expect(typeof rec?.startedAt).toBe("number")
    expect(await redis.sismember(setKey, a.instanceId)).toBe(1)

    await a.stop({ releaseOwned: true })
    expect(await a.isInstanceLive(a.instanceId)).toBe(false)
    expect(await a.readInstance(a.instanceId)).toBeNull()
    expect(await redis.sismember(setKey, a.instanceId)).toBe(0)
  })

  it("a record that is not renewed reads dead after the TTL", async () => {
    const setKey = newSetKey()
    const a = makeRegistry({ setKey })
    await a.start({ role: "worker", pid: 1 })
    const reader = makeRegistry({ setKey })
    expect(await reader.isInstanceLive(a.instanceId)).toBe(true)
    // Stop renewing without deleting (a frozen or SIGKILLed process).
    await a.stop({ releaseOwned: false })
    const stoppedAt = Date.now()
    await waitFor(async () => !(await reader.isInstanceLive(a.instanceId)), 1_000)
    expect(Date.now() - stoppedAt).toBeLessThan(400)
  })

  it("declares its own record lost when no renew lands within TTL minus the interval", async () => {
    const setKey = newSetKey()
    const client = new HangableClient(redis)
    const a = makeRegistry({ setKey, client })
    await a.start({ role: "all", pid: 1 })
    expect(a.isOwnRecordLive()).toBe(true)
    client.hang = true
    const hungAt = Date.now()
    await waitFor(() => !a.isOwnRecordLive(), 1_000)
    // Deadline TTL - interval = 200 ms, checked on a 100 ms tick bounded at 100 ms.
    expect(Date.now() - hungAt).toBeLessThan(TTL + HEARTBEAT * 2)
    client.hang = false
    await waitFor(() => a.isOwnRecordLive(), 1_000)
  })

  it("reads are bounded: a hung Redis rejects instead of awaiting forever", async () => {
    const client = new HangableClient(redis)
    const a = makeRegistry({ setKey: newSetKey(), client })
    client.hang = true
    const t0 = Date.now()
    await expect(a.isInstanceLive("x")).rejects.toThrow(/did not answer/)
    await expect(a.liveInstanceSet(["x", "y"])).rejects.toThrow(/did not answer/)
    await expect(a.readInstance("x")).rejects.toThrow(/did not answer/)
    expect(Date.now() - t0).toBeLessThan(1_500)
  })
})

describe("liveInstanceSet", () => {
  it("answers liveness for many ids at once", async () => {
    const setKey = newSetKey()
    const a = makeRegistry({ setKey })
    const b = makeRegistry({ setKey })
    await a.start({ role: "api", pid: 1 })
    await b.start({ role: "api", pid: 2 })
    const ghost = crypto.randomUUID()
    const live = await a.liveInstanceSet([a.instanceId, ghost, b.instanceId])
    expect([...live].sort()).toEqual([a.instanceId, b.instanceId].sort())
    expect((await a.liveInstanceSet([])).size).toBe(0)
  })

  it("works under a key prefix", async () => {
    // The script builds each heartbeat key itself, which ioredis never
    // prefixes: it must prepend the prefix it receives in ARGV.
    const prefix = `${REDIS_PREFIX}t:`
    const client = new Redis(env.REDIS_URL, {
      keyPrefix: prefix,
      protocol: RESP_PROTOCOL,
      maxRetriesPerRequest: null,
    })
    extraClients.push(client)
    const setKey = newSetKey()
    const a = makeRegistry({ setKey, client, prefix })
    await a.start({ role: "api", pid: 1 })
    expect(await redis.exists(`t:${LIVE_INSTANCE_KEY(a.instanceId)}`)).toBe(1)
    expect([...(await a.liveInstanceSet([a.instanceId]))]).toEqual([a.instanceId])
    expect(await a.isInstanceLive(a.instanceId)).toBe(true)
    // Discriminator: a script that built the key without the prefix reads every
    // instance dead.
    const unprefixed = makeRegistry({ setKey, client, prefix: "" })
    expect((await unprefixed.liveInstanceSet([a.instanceId])).size).toBe(0)
  })
})

describe("dead-instance sweep", () => {
  it("runs each dead-instance hook once and forgets the instance", async () => {
    const setKey = newSetKey()
    const leader = makeRegistry({ setKey })
    const alive = makeRegistry({ setKey })
    await leader.start({ role: "all", pid: 1 })
    await alive.start({ role: "api", pid: 2 })
    const deadId = crypto.randomUUID()
    await redis.sadd(setKey, deadId)

    const calls: string[] = []
    const other: string[] = []
    leader.onDeadInstance("first", async (id) => {
      calls.push(id)
    })
    leader.onDeadInstance("second", async (id) => {
      other.push(id)
      throw new Error("a failing hook never stops the others")
    })
    leader.registerSweep()
    await startLeadership({ role: "all", lease: leaseOpts() })

    await waitFor(async () => (await redis.sismember(setKey, deadId)) === 0)
    await sleep(SWEEP * 3)
    expect(calls).toEqual([deadId])
    expect(other).toEqual([deadId])
    expect(await redis.sismember(setKey, alive.instanceId)).toBe(1)
    expect(await redis.sismember(setKey, leader.instanceId)).toBe(1)
  })

  it("runs only in the leader", async () => {
    const setKey = newSetKey()
    const leader = makeRegistry({ setKey })
    await leader.start({ role: "all", pid: 1 })
    const deadId = crypto.randomUUID()
    await redis.sadd(setKey, deadId)
    const calls: string[] = []
    leader.onDeadInstance("h", async (id) => {
      calls.push(id)
    })
    leader.registerSweep()

    // Not leading (an `api` process never is): no sweep.
    await startLeadership({ role: "api", lease: leaseOpts() })
    await sleep(SWEEP * 4)
    expect(calls).toEqual([])
    expect(await redis.sismember(setKey, deadId)).toBe(1)
    await stopLeadership()

    // Leading: the sweep runs.
    await startLeadership({ role: "all", lease: leaseOpts() })
    await waitFor(() => calls.length === 1)
    expect(calls).toEqual([deadId])
  })

  it("re-checks each instance right before firing its hooks", async () => {
    const setKey = newSetKey()
    const leader = makeRegistry({ setKey })
    await leader.start({ role: "all", pid: 1 })
    const first = crypto.randomUUID()
    const second = crypto.randomUUID()
    await redis.sadd(setKey, first, second)
    const calls: string[] = []
    leader.onDeadInstance("h", async (id) => {
      calls.push(id)
      // While the first dead instance's hooks run, the other one comes back.
      const other = id === first ? second : first
      await redis.set(LIVE_INSTANCE_KEY(other), "{}", "PX", 5_000)
    })
    leader.registerSweep()
    await startLeadership({ role: "all", lease: leaseOpts() })
    await waitFor(() => calls.length >= 1)
    await sleep(SWEEP * 3)
    expect(calls.length).toBe(1)
    const revived = calls[0] === first ? second : first
    expect(await redis.sismember(setKey, revived)).toBe(1)
    await redis.del(LIVE_INSTANCE_KEY(first), LIVE_INSTANCE_KEY(second))
  })
})

describe("recovery after a lapse (P2-1)", () => {
  it("heartbeat lapses, the sweep cleans up, the instance resumes and republishes", async () => {
    const setKey = newSetKey()
    const leader = makeRegistry({ setKey })
    await leader.start({ role: "all", pid: 1 })
    const client = new HangableClient(redis)
    const a = makeRegistry({ setKey, client })
    // The instance's own entry, which the dead hook removes and recovery rewrites.
    const entryKey = `instance-registry-test:entry:${a.instanceId}`
    const swept: string[] = []
    leader.onDeadInstance("entries", async (id) => {
      swept.push(id)
      await redis.del(`instance-registry-test:entry:${id}`)
    })
    const recovered: number[] = []
    a.onInstanceRecovered("entries", async () => {
      recovered.push(Date.now())
      await redis.set(entryKey, "online")
    })
    await a.start({ role: "api", pid: 2 })
    await redis.set(entryKey, "online")
    leader.registerSweep()
    await startLeadership({ role: "all", lease: leaseOpts() })
    await sleep(SWEEP * 2)
    expect(swept).toEqual([])

    client.hang = true // an outage: the heartbeat lapses, the record expires
    await waitFor(() => swept.includes(a.instanceId))
    expect(await redis.get(entryKey)).toBeNull()
    expect(await leader.isInstanceLive(a.instanceId)).toBe(false)
    expect(recovered).toEqual([])

    client.hang = false // back: the next renew sees the record gone
    await waitFor(() => recovered.length === 1)
    expect(await redis.get(entryKey)).toBe("online")
    expect(await leader.isInstanceLive(a.instanceId)).toBe(true)
    expect(a.isOwnRecordLive()).toBe(true)
    await sleep(SWEEP * 3)
    expect(swept.filter((id) => id === a.instanceId).length).toBe(1)
    expect(recovered.length).toBe(1)
    await redis.del(entryKey)
  })

  it("an instance that comes back while its hooks run republishes again afterwards", async () => {
    const setKey = newSetKey()
    const leader = makeRegistry({ setKey })
    await leader.start({ role: "all", pid: 1 })
    const client = new HangableClient(redis)
    const a = makeRegistry({ setKey, client })
    const recovered: number[] = []
    a.onInstanceRecovered("count", async () => {
      recovered.push(Date.now())
    })
    leader.onDeadInstance("slow", async (id) => {
      if (id !== a.instanceId) return
      // The instance resumes and republishes BEFORE this hook's deletes land.
      client.hang = false
      await waitFor(() => recovered.length === 1)
    })
    await a.start({ role: "api", pid: 2 })
    leader.registerSweep()
    await startLeadership({ role: "all", lease: leaseOpts() })
    client.hang = true
    // The hook's cleanup landed after the republish: the instance republishes once more.
    await waitFor(() => recovered.length === 2)
    await sleep(HEARTBEAT * 3)
    expect(recovered.length).toBe(2)
  })

  it("releasing its own records on shutdown runs this instance's cleanup hooks", async () => {
    const setKey = newSetKey()
    const a = makeRegistry({ setKey })
    const calls: string[] = []
    a.onDeadInstance("own", async (id) => {
      calls.push(id)
    })
    await a.start({ role: "api", pid: 1 })
    await a.stop({ releaseOwned: true })
    expect(calls).toEqual([a.instanceId])
    expect(await redis.exists(LIVE_INSTANCE_KEY(a.instanceId))).toBe(0)
  })
})
