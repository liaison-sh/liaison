// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The per-user concurrent-stream cap counted across the cell (S5, A12). Real
// Redis under a non-empty key prefix (`<run prefix>t:`): the take script builds
// each heartbeat key and the dead-instance and recovery scripts build each
// user's hash key inside Lua, so a script that dropped the prefix it receives
// in ARGV reads every other instance dead and sweeps nothing.
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import Redis from "ioredis"
import { InstanceRegistry, LIVE_INSTANCE_KEY, type RegistryRedis } from "~/infra/instance-registry"
import { LeadershipTestAccess, startLeadership } from "~/infra/leadership"
import { env } from "~/lib/env"
import { REDIS_PREFIX, RESP_PROTOCOL } from "~/lib/redis"
import { registerStreamSlotHooks, type SlotRedis, StreamSlots } from "./stream-slots"

const PREFIX = `${REDIS_PREFIX}t:`
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

function slots(instanceId: string, c: SlotRedis = client, timeoutMs?: number): StreamSlots {
  return new StreamSlots(c, instanceId, PREFIX, timeoutMs ? { commandTimeoutMs: timeoutMs } : {})
}

const field = (userId: string, inst: string) => client.hget(`agent:streams:${userId}`, inst)

/** Every command hangs until released, as Redis does during an outage. */
class HangableClient implements SlotRedis, RegistryRedis {
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

describe("StreamSlots", () => {
  it("the cap counts slots held on two instances", async () => {
    const [a, b] = [id(), id()]
    await markLive(a)
    await markLive(b)
    const sa = slots(a)
    const sb = slots(b)
    const user = id()
    const first = await sa.take(user, 2)
    const second = await sb.take(user, 2)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    // Discriminator: a per-process count allows 2 on each instance, so either
    // replica would take this third one.
    expect((await sb.take(user, 2)).ok).toBe(false)
    expect((await sa.take(user, 2)).ok).toBe(false)
    // Another user is unaffected.
    expect((await sa.take(id(), 2)).ok).toBe(true)

    if (first.ok) await first.release()
    const third = await sb.take(user, 2)
    expect(third.ok).toBe(true)
    expect(await field(user, a)).toBeNull()
    expect(await field(user, b)).toBe("2")
  })

  it("a dead instance's slots stop counting at once and are swept", async () => {
    const setKey = `live:instances:test:${id()}`
    const mk = (opts: { client?: RegistryRedis } = {}) => {
      const r = new InstanceRegistry({
        instanceId: id(),
        client: opts.client ?? client,
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
    const sa = slots(regA.instanceId)
    const sb = slots(leader.instanceId)
    registerStreamSlotHooks(leader, sb)

    const user = id()
    expect((await sa.take(user, 2)).ok).toBe(true)
    expect((await sa.take(user, 2)).ok).toBe(true)
    expect((await sb.take(user, 2)).ok).toBe(false)

    // A is SIGKILLed: its heartbeat stops without a release.
    await regA.stop({ releaseOwned: false })
    await waitFor(async () => (await client.exists(LIVE_INSTANCE_KEY(regA.instanceId))) === 0)
    // Before any sweep, the dead slots no longer count.
    expect(await field(user, regA.instanceId)).toBe("2")
    expect((await sb.take(user, 2)).ok).toBe(true)

    // The leader's sweep runs the hook: A's field and index are gone.
    leader.registerSweep(`stream-slots-test-sweep-${id()}`)
    await startLeadership({
      role: "all",
      lease: { key: `stream-slots-test:${id()}`, ttlMs: 3_000, renewMs: 1_000, pollMs: 250 },
    })
    await waitFor(async () => (await field(user, regA.instanceId)) === null)
    expect(await client.exists(`agent:streams:by-inst:${regA.instanceId}`)).toBe(0)
    expect(await field(user, leader.instanceId)).toBe("1")
  })

  it("a recovered instance rewrites its own slots after the sweep removed them (P2-1)", async () => {
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
    const sa = slots(regA.instanceId)
    const sb = slots(leader.instanceId)
    registerStreamSlotHooks(leader, sb)
    registerStreamSlotHooks(regA, sa)

    const user = id()
    const held = await sa.take(user, 2)
    expect(held.ok).toBe(true)
    leader.registerSweep(`stream-slots-test-sweep-${id()}`)
    await startLeadership({
      role: "all",
      lease: { key: `stream-slots-test:${id()}`, ttlMs: 3_000, renewMs: 1_000, pollMs: 250 },
    })

    hangable.hang = true // A's heartbeat lapses, the sweep removes its slots
    await waitFor(async () => (await field(user, regA.instanceId)) === null)
    hangable.hang = false // A is back: it rewrites the slot it still holds
    await waitFor(async () => (await field(user, regA.instanceId)) === "1")
    expect(await client.sismember(`agent:streams:by-inst:${regA.instanceId}`, user)).toBe(1)
    expect((await sb.take(user, 2)).ok).toBe(true)
    // The stream A still runs counts again: the cap holds at 2.
    expect((await sb.take(user, 2)).ok).toBe(false)
    if (held.ok) await held.release()
    expect(await field(user, regA.instanceId)).toBeNull()
  })

  it("release is idempotent and never goes negative", async () => {
    const a = id()
    await markLive(a)
    const sa = slots(a)
    const user = id()
    const one = await sa.take(user, 2)
    const two = await sa.take(user, 2)
    if (!one.ok || !two.ok) throw new Error("both takes must succeed")
    await one.release()
    await one.release()
    await one.release()
    expect(await field(user, a)).toBe("1")
    await two.release()
    await two.release()
    expect(await field(user, a)).toBeNull()
    expect(await client.exists(`agent:streams:by-inst:${a}`)).toBe(0)
    // A count that had gone negative would let a third stream through at cap 2.
    expect((await sa.take(user, 2)).ok).toBe(true)
    expect((await sa.take(user, 2)).ok).toBe(true)
    expect((await sa.take(user, 2)).ok).toBe(false)
  })

  it("fails open within the timeout when Redis hangs, and a late landing is released", async () => {
    const a = id()
    await markLive(a)
    const hangable = new HangableClient(client)
    const sa = slots(a, hangable, 200)
    const user = id()
    hangable.hang = true
    const t0 = Date.now()
    const res = await sa.take(user, 1)
    expect(res.ok).toBe(true)
    expect(Date.now() - t0).toBeLessThan(1_000)
    hangable.hang = false
    if (res.ok) await res.release()
    expect(await field(user, a)).toBeNull()
  })

  it("a take that lands after the timeout is counted, and released once it lands", async () => {
    const a = id()
    await markLive(a)
    // Takes answer only when the test lets them through; releases pass.
    let letThrough: () => void = () => {}
    const gate = new Promise<void>((r) => {
      letThrough = r
    })
    let held = 0
    const slow: SlotRedis = {
      eval: (script, numKeys, ...args) => {
        if (held >= 2) return client.eval(script, numKeys, ...args)
        held++
        return gate.then(() => client.eval(script, numKeys, ...args))
      },
    }
    const sa = slots(a, slow, 100)
    const early = id()
    const late = id()
    const r1 = await sa.take(early, 2)
    const r2 = await sa.take(late, 2)
    if (!r1.ok || !r2.ok) throw new Error("fail open expected")
    await r1.release() // released before its take landed
    letThrough()
    await waitFor(async () => (await field(late, a)) === "1")
    await sleep(100)
    // Without the late-landing release, `early` would keep a phantom slot forever.
    expect(await field(early, a)).toBeNull()
    await r2.release()
    expect(await field(late, a)).toBeNull()
  })
})
