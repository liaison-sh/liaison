// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Live runs counted across the cell (the untrusted-content reset, scopes/taint.ts). Real Redis
// under a non-empty key prefix (`<run prefix>lr:`): the read builds each heartbeat key and the
// dead-instance and recovery scripts build each thread's key inside Lua, so a script that dropped
// the prefix it receives in ARGV reads every other instance dead and sweeps nothing.
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import Redis from "ioredis"
import { InstanceRegistry, LIVE_INSTANCE_KEY, type RegistryRedis } from "~/infra/instance-registry"
import { LeadershipTestAccess, startLeadership } from "~/infra/leadership"
import { env } from "~/lib/env"
import { REDIS_PREFIX, RESP_PROTOCOL } from "~/lib/redis"
import { type LiveRunRedis, LiveRuns, registerLiveRunHooks, threadRunKey } from "./live-runs"

const PREFIX = `${REDIS_PREFIX}lr:`
const client = new Redis(env.REDIS_URL, {
  keyPrefix: PREFIX,
  protocol: RESP_PROTOCOL,
  maxRetriesPerRequest: null,
})

const registries: InstanceRegistry[] = []

afterEach(async () => {
  for (const r of registries.splice(0)) await r.stop({ releaseOwned: false })
  await LeadershipTestAccess.reset()
})

afterAll(async () => {
  const keys = await client.keys(`${PREFIX}*`)
  // `keys` answers full names; `del` would prefix them again.
  if (keys.length > 0) await client.del(...keys.map((k) => k.slice(PREFIX.length)))
  client.disconnect()
})

const id = () => crypto.randomUUID()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const start = Date.now()
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition never met")
    await sleep(10)
  }
}

/** A heartbeat record as the instance registry writes it. */
async function markLive(instanceId: string, ttlMs = 30_000): Promise<void> {
  await client.set(LIVE_INSTANCE_KEY(instanceId), "{}", "PX", ttlMs)
}

function runs(instanceId: string, c: LiveRunRedis = client, timeoutMs?: number): LiveRuns {
  return new LiveRuns(c, instanceId, PREFIX, timeoutMs ? { commandTimeoutMs: timeoutMs } : {})
}

const entries = (key: string) => client.zrange(`live-runs:${key}`, "0", "-1")

/** Every command hangs until released, as Redis does during an outage. */
class HangableClient implements LiveRunRedis, RegistryRedis {
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

/** Every write reaches Redis late, as on a loaded connection. */
class SlowClient implements LiveRunRedis {
  constructor(
    private readonly inner: Redis,
    private readonly delayMs: number,
  ) {}
  async eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    await sleep(this.delayMs)
    return await this.inner.eval(script, numKeys, ...args)
  }
}

describe("LiveRuns begin", () => {
  it("resolves only once another instance can see the run", async () => {
    const [a, b] = [id(), id()]
    await markLive(a)
    await markLive(b)
    const ra = runs(a, new SlowClient(client, 100))
    const key = threadRunKey(id())
    const end = await ra.begin(key, "run-a")
    expect(await runs(b).hasOther(key, "run-b")).toBe(true)
    await end()
  })

  it("never rejects and is bounded when Redis hangs; the local run still counts", async () => {
    const hung = new HangableClient(client)
    hung.hang = true
    const ra = runs(id(), hung, 100)
    const key = threadRunKey(id())
    const started = Date.now()
    const end = await ra.begin(key, "run-a")
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(await ra.hasOther(key, "typed")).toBe(true)
    await end()
  })

  it("the instance's key set expires no sooner than its newest run", async () => {
    const a = id()
    const ra = new LiveRuns(client, a, PREFIX, { ttlMs: 60_000 })
    const end = await ra.begin(threadRunKey(id()), "run-a")
    const ttl = await client.pttl(`live-runs:by-inst:${a}`)
    expect(ttl).toBeGreaterThan(55_000)
    expect(ttl).toBeLessThanOrEqual(60_000)
    await end()
  })
})

describe("LiveRuns", () => {
  it("a run begun by another instance holds the reset back", async () => {
    const [a, b] = [id(), id()]
    await markLive(a)
    await markLive(b)
    const ra = runs(a)
    const rb = runs(b)
    const key = threadRunKey(id())
    const end = await ra.begin(key, "run-a")
    // Discriminator: an in-process registry on B knows nothing of A's run and answers false.
    expect(await rb.hasOther(key, "run-b")).toBe(true)
    // A's own run is not "another" one for A.
    expect(await ra.hasOther(key, "run-a")).toBe(false)
    await end()
    expect(await rb.hasOther(key, "run-b")).toBe(false)
    expect(await entries(key)).toEqual([])
  })

  it("a run on this instance counts, other than the caller's own", async () => {
    const a = id()
    const ra = runs(a)
    const key = threadRunKey(id())
    const endBg = await ra.begin(key, "background")
    expect(await ra.hasOther(key, "typed")).toBe(true)
    expect(await ra.hasOther(key, "background")).toBe(false)
    await endBg()
    await endBg() // idempotent
    expect(await ra.hasOther(key, "typed")).toBe(false)
  })

  it("a dead instance's run does not", async () => {
    const [dead, b] = [id(), id()]
    await markLive(b)
    const key = threadRunKey(id())
    // The dead instance recorded its run, then its heartbeat record lapsed (never written here).
    await runs(dead).begin(key, "run-dead")
    await waitFor(async () => (await entries(key)).length === 1)
    expect(await runs(b).hasOther(key, "run-b")).toBe(false)
    // The read dropped the dead instance's entry.
    expect(await entries(key)).toEqual([])
  })

  it("an expired entry does not count and is dropped", async () => {
    const [a, b] = [id(), id()]
    await markLive(a)
    const key = threadRunKey(id())
    const ra = new LiveRuns(client, a, PREFIX, { ttlMs: 50 })
    await ra.begin(key, "run-a")
    await sleep(80)
    expect(await runs(b).hasOther(key)).toBe(false)
    expect(await entries(key)).toEqual([])
  })

  it("fails closed within the timeout when Redis hangs: the mark is kept", async () => {
    const hangable = new HangableClient(client)
    const rb = runs(id(), hangable, 100)
    hangable.hang = true
    const started = Date.now()
    expect(await rb.hasOther(threadRunKey(id()), "run-b")).toBe(true)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it("a dead instance's runs are swept by the leader", async () => {
    const setKey = `live:instances:test:${id()}`
    const mk = () => {
      const r = new InstanceRegistry({
        instanceId: id(),
        client,
        prefix: PREFIX,
        setKey,
        ttlMs: 300,
        heartbeatMs: 100,
        sweepIntervalMs: 100,
        commandTimeoutMs: 200,
      })
      registries.push(r)
      return r
    }
    const leader = mk()
    const regA = mk()
    await leader.start({ role: "all", pid: 1 })
    await regA.start({ role: "api", pid: 2 })
    const ra = runs(regA.instanceId)
    const rl = runs(leader.instanceId)
    registerLiveRunHooks(leader, rl)

    const key = threadRunKey(id())
    await ra.begin(key, "run-a")
    await rl.begin(key, "run-leader")
    expect(await rl.hasOther(key, "run-leader")).toBe(true)

    // A is SIGKILLed: its heartbeat stops without a release.
    await regA.stop({ releaseOwned: false })
    await waitFor(async () => (await client.exists(LIVE_INSTANCE_KEY(regA.instanceId))) === 0)
    leader.registerSweep(`live-runs-test-sweep-${id()}`)
    await startLeadership({
      role: "all",
      lease: { key: `live-runs-test:${id()}`, ttlMs: 3_000, renewMs: 1_000, pollMs: 250 },
    })
    await waitFor(async () => (await entries(key)).length === 1)
    expect(await entries(key)).toEqual([`run-leader|${leader.instanceId}`])
    expect(await client.exists(`live-runs:by-inst:${regA.instanceId}`)).toBe(0)
    expect(await rl.hasOther(key, "run-leader")).toBe(false)
  })

  it("a recovered instance rewrites its own runs after the sweep removed them (P2-1)", async () => {
    const setKey = `live:instances:test:${id()}`
    const hangable = new HangableClient(client)
    const mk = (c: RegistryRedis) => {
      const r = new InstanceRegistry({
        instanceId: id(),
        client: c,
        prefix: PREFIX,
        setKey,
        ttlMs: 300,
        heartbeatMs: 100,
        sweepIntervalMs: 100,
        commandTimeoutMs: 200,
      })
      registries.push(r)
      return r
    }
    const leader = mk(client)
    const regA = mk(hangable)
    await leader.start({ role: "all", pid: 1 })
    await regA.start({ role: "api", pid: 2 })
    const ra = runs(regA.instanceId)
    const rl = runs(leader.instanceId)
    registerLiveRunHooks(leader, rl)
    registerLiveRunHooks(regA, ra)

    const key = threadRunKey(id())
    const end = await ra.begin(key, "run-a")
    await waitFor(async () => (await entries(key)).length === 1)
    leader.registerSweep(`live-runs-test-sweep-${id()}`)
    await startLeadership({
      role: "all",
      lease: { key: `live-runs-test:${id()}`, ttlMs: 3_000, renewMs: 1_000, pollMs: 250 },
    })

    hangable.hang = true // A's heartbeat lapses, the sweep removes its run
    await waitFor(async () => (await entries(key)).length === 0)
    hangable.hang = false // A is back: it rewrites the run it still holds
    await waitFor(async () => (await entries(key)).length === 1)
    expect(await entries(key)).toEqual([`run-a|${regA.instanceId}`])
    expect(await client.sismember(`live-runs:by-inst:${regA.instanceId}`, key)).toBe(1)
    await waitFor(() => regA.isOwnRecordLive())
    expect(await rl.hasOther(key, "run-leader")).toBe(true)
    await end()
    expect(await entries(key)).toEqual([])
    expect(await client.exists(`live-runs:by-inst:${regA.instanceId}`)).toBe(0)
  })
})
