// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Leadership: the fail-closed `isLeader()` (role eligible AND lease held AND
// Patroni leader or gate off), the singleton hooks run on its transitions, and
// the jobs gate driven by Patroni alone. Real Redis (per-run prefixed), a live
// local HTTP server standing in for the node's Patroni REST /leader (200 =
// leader, 503 = replica). Every test uses its own lease key.
import { afterEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { INSTANCE_ID } from "~/infra/instance-id"
import {
  hasLeadershipMonitorStarted,
  isLeader,
  LeadershipTestAccess,
  registerSingleton,
  startLeadership,
  stopLeadership,
} from "~/infra/leadership"
import { redis } from "~/lib/redis"

// The test env's lease timings (P1-12).
const TTL = 3_000
const RENEW = 1_000
const POLL = 250

const newKey = () => `leadership-test:${crypto.randomUUID()}`
const leaseOpts = (key: string) => ({ key, ttlMs: TTL, renewMs: RENEW, pollMs: POLL })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const start = Date.now()
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition never met")
    await new Promise((r) => setTimeout(r, 10))
  }
}

function fakePatroni(initial: number): { url: string; set: (s: number) => void; stop: () => void } {
  let status = initial
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(status === 200 ? "ok" : "not leader", { status }),
  })
  return {
    url: `http://localhost:${server.port}/leader`,
    set: (s) => {
      status = s
    },
    stop: () => server.stop(true),
  }
}

afterEach(async () => {
  await LeadershipTestAccess.reset()
})

describe("isLeader fails closed", () => {
  it("is false before leadership starts", () => {
    expect(hasLeadershipMonitorStarted()).toBe(false)
    expect(isLeader()).toBe(false)
  })

  it("an api process is never leader and takes no lease", async () => {
    const key = newKey()
    const gate: boolean[] = []
    await startLeadership({ role: "api", onJobsGate: (v) => gate.push(v), lease: leaseOpts(key) })
    expect(hasLeadershipMonitorStarted()).toBe(true)
    await sleep(POLL * 2)
    expect(isLeader()).toBe(false)
    expect(await redis.get(key)).toBeNull()
    expect(gate).toEqual([])
  })

  it("a lease-ineligible job host opens its jobs gate but never leads", async () => {
    const key = newKey()
    const gate: boolean[] = []
    await startLeadership({
      role: "all",
      leaseEligible: false,
      onJobsGate: (v) => gate.push(v),
      lease: leaseOpts(key),
    })
    await sleep(POLL * 2)
    expect(isLeader()).toBe(false)
    expect(await redis.get(key)).toBeNull()
    expect(gate).toEqual([true])
  })

  it("is false again after stop, and the lease is released", async () => {
    const key = newKey()
    await startLeadership({ role: "all", lease: leaseOpts(key) })
    expect(isLeader()).toBe(true)
    await stopLeadership()
    expect(isLeader()).toBe(false)
    expect(hasLeadershipMonitorStarted()).toBe(false)
    expect(await redis.get(key)).toBeNull()
  })
})

describe("lease-eligible roles", () => {
  it("role all with the Patroni gate off leads at boot, announcing the jobs gate open once", async () => {
    const key = newKey()
    const gate: boolean[] = []
    await startLeadership({ role: "all", onJobsGate: (v) => gate.push(v), lease: leaseOpts(key) })
    expect(isLeader()).toBe(true)
    expect(gate).toEqual([true])
    expect(await redis.get(key)).toBe(INSTANCE_ID)
  })

  it("a worker leads once it holds the lease", async () => {
    const key = newKey()
    await startLeadership({ role: "worker", lease: leaseOpts(key) })
    expect(isLeader()).toBe(true)
    expect(await redis.get(key)).toBe(INSTANCE_ID)
  })

  it("a worker whose lease another process holds does not lead until the key frees", async () => {
    const key = newKey()
    await redis.set(key, "someone-else", "PX", 60_000)
    await startLeadership({ role: "worker", lease: leaseOpts(key) })
    await sleep(POLL * 2)
    expect(isLeader()).toBe(false)
    await redis.del(key)
    await waitFor(() => isLeader(), POLL * 4)
    expect(await redis.get(key)).toBe(INSTANCE_ID)
  })
})

describe("Patroni gate (P1-3)", () => {
  it("a Patroni replica neither holds the lease nor runs singletons; the leader node takes the lease", async () => {
    const key = newKey()
    const patroni = fakePatroni(503)
    const gate: boolean[] = []
    const seq: string[] = []
    registerSingleton({
      name: "probe",
      onAcquired: () => {
        seq.push("+")
      },
      onLost: () => {
        seq.push("-")
      },
    })
    try {
      await startLeadership({
        role: "all",
        onJobsGate: (v) => gate.push(v),
        patroni: { url: patroni.url, probeIntervalMs: 25, probeTimeoutMs: 500 },
        lease: leaseOpts(key),
      })
      // Replica: several polls pass, nobody takes the lease, nothing runs.
      await sleep(POLL * 3)
      expect(isLeader()).toBe(false)
      expect(await redis.get(key)).toBeNull()
      expect(gate).toEqual([false])
      expect(seq).toEqual([])

      // Promoted: the jobs gate opens, the lease is taken, the hook runs once.
      patroni.set(200)
      await waitFor(() => isLeader())
      expect(gate.at(-1)).toBe(true)
      expect(await redis.get(key)).toBe(INSTANCE_ID)
      await waitFor(() => seq.length === 1)
      expect(seq).toEqual(["+"])

      // Demoted: singletons stop at once, the lease is released at the next renew.
      patroni.set(503)
      await waitFor(() => !isLeader())
      expect(gate.at(-1)).toBe(false)
      await waitFor(() => seq.length === 2)
      expect(seq).toEqual(["+", "-"])
      await waitFor(async () => (await redis.get(key)) === null, RENEW * 3)
    } finally {
      patroni.stop()
    }
  })

  it("fails safe to NOT leader when the Patroni endpoint is unreachable", async () => {
    const key = newKey()
    const gate: boolean[] = []
    await startLeadership({
      role: "all",
      onJobsGate: (v) => gate.push(v),
      patroni: { url: "http://127.0.0.1:1/leader", probeIntervalMs: 25, probeTimeoutMs: 300 },
      lease: leaseOpts(key),
    })
    await sleep(POLL * 2)
    expect(isLeader()).toBe(false)
    expect(gate[0]).toBe(false)
    expect(await redis.get(key)).toBeNull()
  })

  it("a probe still in flight when leadership stops never reaches the next start", async () => {
    let requests = 0
    let release: () => void = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        // The first probe answers so the start returns; the next one hangs.
        if (++requests === 1) return new Response("ok")
        await held
        return new Response("not leader", { status: 503 })
      },
    })
    try {
      await startLeadership({
        role: "worker",
        patroni: {
          url: `http://localhost:${server.port}/leader`,
          probeIntervalMs: 10,
          probeTimeoutMs: 5_000,
        },
        lease: leaseOpts(newKey()),
      })
      await waitFor(() => requests >= 2)
      await stopLeadership()

      await startLeadership({ role: "worker", lease: leaseOpts(newKey()) })
      expect(isLeader()).toBe(true)
      release()
      await sleep(POLL)
      expect(isLeader()).toBe(true)
    } finally {
      release()
      server.stop(true)
    }
  })
})

describe("singleton hooks", () => {
  it("acquired once, lost before re-acquire, in order", async () => {
    const key = newKey()
    const seq: string[] = []
    for (const name of ["a", "b"]) {
      registerSingleton({
        name,
        onAcquired: async () => {
          await sleep(5)
          seq.push(`${name}+`)
        },
        onLost: async () => {
          await sleep(5)
          seq.push(`${name}-`)
        },
      })
    }
    await startLeadership({ role: "worker", lease: leaseOpts(key) })
    expect(seq).toEqual(["a+", "b+"])

    // Another process takes the key: the holder notices at its next renew.
    await redis.set(key, "thief", "PX", POLL * 2)
    await waitFor(() => seq.length === 4, RENEW * 3)
    expect(isLeader()).toBe(false)
    // The thief's key expires: re-acquired at the next poll.
    await waitFor(() => seq.length === 6, POLL * 8)
    expect(isLeader()).toBe(true)
    expect(seq).toEqual(["a+", "b+", "a-", "b-", "a+", "b+"])
  })

  it("registerSingleton after acquire runs onAcquired immediately", async () => {
    const key = newKey()
    await startLeadership({ role: "worker", lease: leaseOpts(key) })
    expect(isLeader()).toBe(true)
    let acquired = 0
    registerSingleton({
      name: "late",
      onAcquired: () => {
        acquired++
      },
      onLost: () => {},
    })
    await waitFor(() => acquired === 1, 500)
    await sleep(POLL * 2)
    expect(acquired).toBe(1)
  })

  it("registerSingleton in a process that does not lead runs nothing", async () => {
    let acquired = 0
    registerSingleton({
      name: "idle",
      onAcquired: () => {
        acquired++
      },
      onLost: () => {},
    })
    await startLeadership({ role: "api", lease: leaseOpts(newKey()) })
    await sleep(POLL * 2)
    expect(acquired).toBe(0)
  })

  it("a throwing hook is logged and does not stop the others", async () => {
    const key = newKey()
    const seq: string[] = []
    registerSingleton({
      name: "bad",
      onAcquired: () => {
        throw new Error("boom")
      },
      onLost: () => {},
    })
    registerSingleton({
      name: "good",
      onAcquired: () => {
        seq.push("good+")
      },
      onLost: () => {},
    })
    await startLeadership({ role: "worker", lease: leaseOpts(key) })
    expect(seq).toEqual(["good+"])
    expect(isLeader()).toBe(true)
  })

  it("loss order: isLeader false, then onLost hooks awaited, then the lease released (P1-5)", async () => {
    const key = newKey()
    const seen: { leaderDuringLost: boolean; keyDuringLost: string | null }[] = []
    registerSingleton({
      name: "slow",
      onAcquired: () => {},
      onLost: async () => {
        const leaderDuringLost = isLeader()
        await sleep(200)
        seen.push({ leaderDuringLost, keyDuringLost: await redis.get(key) })
      },
    })
    await startLeadership({ role: "worker", lease: leaseOpts(key) })
    expect(isLeader()).toBe(true)
    await stopLeadership()
    expect(seen).toEqual([{ leaderDuringLost: false, keyDuringLost: INSTANCE_ID }])
    expect(await redis.get(key)).toBeNull()
  })
})
