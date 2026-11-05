// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The cell's concurrency on a queue (fairness.ts, D-P4-8): the sum of the
// worker slots every live job host publishes in its instance record. Real
// Redis; every test has its own instance set, so nothing collides.
import { afterEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { InstanceRegistry } from "~/infra/instance-registry"
import { REDIS_PREFIX, redis } from "~/lib/redis"
import { FairnessTestAccess, readCellJobSlots } from "./fairness"

const registries: InstanceRegistry[] = []
const newSetKey = () => `live:instances:test:${crypto.randomUUID()}`

function host(setKey: string): InstanceRegistry {
  const r = new InstanceRegistry({
    instanceId: crypto.randomUUID(),
    client: redis,
    prefix: REDIS_PREFIX,
    setKey,
    ttlMs: 300,
    heartbeatMs: 100,
    sweepIntervalMs: 100,
    commandTimeoutMs: 200,
  })
  registries.push(r)
  return r
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

afterEach(async () => {
  for (const r of registries.splice(0)) await r.stop({ releaseOwned: true })
  FairnessTestAccess.reset()
})

describe("cell concurrency from the instance records", () => {
  it("two hosts publishing agent=4 give C=8", async () => {
    const setKey = newSetKey()
    for (const h of [host(setKey), host(setKey)]) {
      h.setJobSlots({ "kernel-agent": 4, "kernel-cron": 3 })
      await h.start({ role: "worker", pid: 1 })
    }
    const slots = await readCellJobSlots({ client: redis, setKey })
    expect(slots["kernel-agent"]).toBe(8)
    expect(slots["kernel-cron"]).toBe(6)
  })

  it("a dead host's slots drop out", async () => {
    const setKey = newSetKey()
    const a = host(setKey)
    const b = host(setKey)
    a.setJobSlots({ "kernel-agent": 4 })
    b.setJobSlots({ "kernel-agent": 4 })
    await a.start({ role: "worker", pid: 1 })
    await b.start({ role: "worker", pid: 2 })
    // b stops renewing without releasing (a SIGKILL): its record expires.
    await b.stop({ releaseOwned: false })
    await sleep(450)
    expect((await readCellJobSlots({ client: redis, setKey }))["kernel-agent"]).toBe(4)
  })

  it("a draining host publishes none", async () => {
    const setKey = newSetKey()
    const a = host(setKey)
    a.setJobSlots({ "kernel-agent": 4 })
    await a.start({ role: "worker", pid: 1 })
    expect((await readCellJobSlots({ client: redis, setKey }))["kernel-agent"]).toBe(4)
    a.setJobSlots({})
    await sleep(250)
    expect((await readCellJobSlots({ client: redis, setKey }))["kernel-agent"]).toBeUndefined()
  })

  it("a live job host of an older release (no jobSlots) counts with the default slots", async () => {
    const setKey = newSetKey()
    const a = host(setKey)
    a.setJobSlots({ "kernel-agent": 4 })
    await a.start({ role: "worker", pid: 1 })
    const old = crypto.randomUUID()
    await redis.set(
      `live:inst:${old}`,
      JSON.stringify({ instanceId: old, role: "all", pid: 2, startedAt: Date.now() }),
      "PX",
      5_000,
    )
    await redis.sadd(setKey, old)
    // An api process of the older release runs no jobs.
    const api = crypto.randomUUID()
    await redis.set(
      `live:inst:${api}`,
      JSON.stringify({ instanceId: api, role: "api", pid: 3, startedAt: Date.now() }),
      "PX",
      5_000,
    )
    await redis.sadd(setKey, api)
    FairnessTestAccess.setSlotsSource({ client: redis, setKey })
    expect(await FairnessTestAccess.cellQueueConcurrency("kernel-agent")).toBe(4 + 4)
    expect(await FairnessTestAccess.cellQueueConcurrency("app-foo")).toBe(5)
    await redis.del(`live:inst:${old}`, `live:inst:${api}`)
  })

  it("a registry read error falls back to this process's own slots", async () => {
    FairnessTestAccess.setLocalSlots({ "kernel-agent": 4 })
    FairnessTestAccess.setSlotsSource({
      client: {
        smembers: () => Promise.reject(new Error("redis down")),
        mget: () => Promise.reject(new Error("redis down")),
      },
      setKey: newSetKey(),
    })
    expect(await FairnessTestAccess.cellQueueConcurrency("kernel-agent")).toBe(4)
  })

  it("a host before its first beat still sees its own slots", async () => {
    const setKey = newSetKey()
    const other = host(setKey)
    other.setJobSlots({ "kernel-agent": 2 })
    await other.start({ role: "worker", pid: 1 })
    // This process runs 6 slots but has not published them yet.
    FairnessTestAccess.setLocalSlots({ "kernel-agent": 6 })
    FairnessTestAccess.setSlotsSource({ client: redis, setKey })
    expect(await FairnessTestAccess.cellQueueConcurrency("kernel-agent")).toBe(6)
  })
})
