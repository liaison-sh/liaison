// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The per-org registration queue (registration-lane.ts): nothing registers at
// boot; an org registers on its first touch. In-memory registrations of
// different orgs run side by side (up to `memoryConcurrency`), only the
// persistent half goes through the serial lane, a failed org is retried by its
// next demand, and concurrent touches of one org share one registration.

import { describe, expect, it } from "bun:test"
import { OrgRegistrationQueue, RegistrationLane } from "~/modules/apps/registration-lane"

function deferred() {
  let resolve!: () => void
  let reject!: (err: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

/**
 * A queue over a fake registration. An org in `persistent` takes the serial
 * lane (a stale stamp); the others register in memory only.
 */
function harness(
  opts: { fail?: Set<string>; persistent?: Set<string>; memoryConcurrency?: number } = {},
) {
  const registered = new Set<string>()
  const gates = new Map<string, ReturnType<typeof deferred>>()
  let memoryRunning = 0
  let memoryMax = 0
  let persistentRunning = 0
  let persistentMax = 0
  const calls = new Map<string, number>()
  const queue = new OrgRegistrationQueue<undefined>({
    registered,
    inFlight: new Map(),
    concurrency: 1,
    memoryConcurrency: opts.memoryConcurrency ?? 8,
    registerOrgApps: async (orgId, _opts, serialize) => {
      calls.set(orgId, (calls.get(orgId) ?? 0) + 1)
      const body = async () => {
        await (gates.get(orgId)?.promise ?? tick())
        if (opts.fail?.has(orgId)) throw new Error(`register ${orgId} failed`)
        registered.add(orgId)
      }
      memoryRunning++
      memoryMax = Math.max(memoryMax, memoryRunning)
      try {
        if (opts.persistent?.has(orgId)) {
          await serialize(async () => {
            persistentRunning++
            persistentMax = Math.max(persistentMax, persistentRunning)
            try {
              await body()
            } finally {
              persistentRunning--
            }
          })
        } else {
          await body()
        }
      } finally {
        memoryRunning--
      }
    },
  })
  return {
    queue,
    registered,
    gates,
    calls,
    stats: () => ({ memoryMax, persistentMax }),
  }
}

describe("RegistrationLane", () => {
  it("runs at most `concurrency` tasks at once, in order", async () => {
    const lane = new RegistrationLane(1)
    const order: string[] = []
    const gate = deferred()
    const a = lane.run("a", async () => {
      order.push("a")
      await gate.promise
    })
    const b = lane.run("b", async () => {
      order.push("b")
    })
    await tick()
    expect(order).toEqual(["a"])
    gate.resolve()
    await Promise.all([a, b])
    expect(order).toEqual(["a", "b"])
  })

  it("runs a task's own nested registration inline instead of deadlocking", async () => {
    const lane = new RegistrationLane(1)
    const result = await lane.run("outer", async () => {
      const inner = await lane.run("inner", async () => "inner-done")
      return `outer+${inner}`
    })
    expect(result).toBe("outer+inner-done")
  })

  it("a failed task frees its slot for the next", async () => {
    const lane = new RegistrationLane(1)
    await expect(
      lane.run("a", async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(await lane.run("b", async () => "ok")).toBe("ok")
  })
})

describe("OrgRegistrationQueue", () => {
  it("in-memory registrations of different orgs run side by side, up to the cap", async () => {
    const h = harness({ memoryConcurrency: 3 })
    for (const id of ["a", "b", "c", "d", "e"]) h.gates.set(id, deferred())
    const all = ["a", "b", "c", "d", "e"].map((id) => h.queue.ensure(id))
    await tick()
    expect(h.stats().memoryMax).toBe(3)
    for (const g of h.gates.values()) g.resolve()
    await Promise.all(all)
    expect([...h.registered].sort()).toEqual(["a", "b", "c", "d", "e"])
    expect(h.stats().memoryMax).toBe(3)
  })

  it("only the persistent half is serialized", async () => {
    const h = harness({ persistent: new Set(["p1", "p2"]) })
    for (const id of ["p1", "p2", "m1"]) h.gates.set(id, deferred())
    const p1 = h.queue.ensure("p1")
    const p2 = h.queue.ensure("p2")
    const m1 = h.queue.ensure("m1")
    await tick()
    // m1 (stamp matches) does not wait behind the persistent lane.
    h.gates.get("m1")?.resolve()
    await m1
    expect(h.registered.has("m1")).toBe(true)
    expect(h.registered.has("p1")).toBe(false)
    h.gates.get("p1")?.resolve()
    h.gates.get("p2")?.resolve()
    await Promise.all([p1, p2])
    expect(h.stats().persistentMax).toBe(1)
  })

  it("concurrent first touches of one org share one registration", async () => {
    const h = harness()
    h.gates.set("x", deferred())
    const touches = Array.from({ length: 5 }, () => h.queue.ensure("x"))
    await tick()
    h.gates.get("x")?.resolve()
    await Promise.all(touches)
    expect(h.calls.get("x")).toBe(1)
  })

  it("a failed org is not remembered: its next demand retries it", async () => {
    const fail = new Set(["bad"])
    const h = harness({ fail })
    await expect(h.queue.ensure("bad")).rejects.toThrow("register bad failed")
    fail.delete("bad")
    await h.queue.ensure("bad")
    expect(h.calls.get("bad")).toBe(2)
    expect(h.registered.has("bad")).toBe(true)
  })

  it("costs no registration for an org already registered", async () => {
    const h = harness()
    await h.queue.ensure("x")
    await h.queue.ensure("x")
    expect(h.calls.get("x")).toBe(1)
  })
})

describe("OrgRegistrationQueue: a catalog change during registration", () => {
  it("refreshes an org whose registration read the old catalog, once the change lands", async () => {
    let generation = 1
    const refreshed: Array<{ orgId: string; generation: number }> = []
    const registered = new Set<string>()
    const queue = new OrgRegistrationQueue<undefined>({
      registered,
      inFlight: new Map(),
      concurrency: 1,
      memoryConcurrency: 8,
      registerOrgApps: async (orgId) => {
        // An activation bumps the generation while this org registers.
        generation++
        await tick()
        registered.add(orgId)
      },
      catalog: {
        generation: () => generation,
        refreshOrgApps: async (orgId) => {
          refreshed.push({ orgId, generation })
        },
      },
    })
    await queue.ensure("org-a")
    expect(refreshed).toEqual([{ orgId: "org-a", generation: 2 }])
  })

  it("no change, no refresh", async () => {
    const refreshed: string[] = []
    const registered = new Set<string>()
    const queue = new OrgRegistrationQueue<undefined>({
      registered,
      inFlight: new Map(),
      concurrency: 1,
      memoryConcurrency: 8,
      registerOrgApps: async (orgId) => {
        registered.add(orgId)
      },
      catalog: {
        generation: () => 7,
        refreshOrgApps: async (orgId) => {
          refreshed.push(orgId)
        },
      },
    })
    await queue.ensure("org-b")
    expect(refreshed).toEqual([])
  })
})
