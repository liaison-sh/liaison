// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The pool's lanes: background runs (jobs, events, syncs) may hold only their
// share of the pool, so interactive runs (tool calls, attention computes)
// still start while a burst of long background runs is on.
import { describe, expect, test } from "bun:test"
import { laneCaps, readSupervisorConfig } from "../src/config"
import { QUEUE_HEADER } from "../src/supervisor"
import { startSandbox } from "./helpers"

// A 2 GiB, 2 CPU service (the compose defaults), so the sizes do not follow this machine.
const ORIGIN = {
  SANDBOX_BRIDGE_ORIGIN: "http://127.0.0.1:9",
  SANDBOX_SERVICE_MEM_LIMIT: "2g",
  SANDBOX_SERVICE_CPUS: "2",
}

describe("lane caps", () => {
  test("defaults: a pool of 6 runs 2 background runs and keeps 2 for interactive ones", () => {
    const cfg = readSupervisorConfig(ORIGIN)
    expect(cfg.reservedInteractive).toBe(2)
    expect(laneCaps(cfg)).toEqual({ interactive: 4, background: 2 })
  })

  test("SANDBOX_POOL_RESERVED_INTERACTIVE sets the reserve; a small pool keeps one of each", () => {
    const cfg = readSupervisorConfig({
      ...ORIGIN,
      SANDBOX_POOL_SIZE: "10",
      SANDBOX_POOL_RESERVED: "2",
      SANDBOX_POOL_RESERVED_INTERACTIVE: "3",
    })
    expect(laneCaps(cfg)).toEqual({ interactive: 8, background: 5 })
    expect(laneCaps({ poolSize: 2, reserved: 1, reservedInteractive: 2 })).toEqual({
      interactive: 1,
      background: 1,
    })
    expect(() =>
      readSupervisorConfig({ ...ORIGIN, SANDBOX_POOL_RESERVED_INTERACTIVE: "-1" }),
    ).toThrow(/SANDBOX_POOL_RESERVED_INTERACTIVE/)
  })
})

describe("lanes", () => {
  test("background runs fill their share; an interactive run still starts at once", async () => {
    const sb = await startSandbox() // 6 processes, 2 reserved nested, 2 reserved interactive
    try {
      const background = [1, 2, 3, 4].map((i) =>
        // The last two outlive the first two, so they start once those are over.
        sb.run(i <= 2 ? "hang" : "echo", i, {
          orgId: `org-b${i}`,
          deadlineMs: i <= 2 ? 2_000 : 8_000,
          lane: "background",
        }),
      )
      await Bun.sleep(400)
      const mid = sb.sup.pool.stats().lanes
      expect(mid.caps).toEqual({ interactive: 4, background: 2 })
      // The converse limit: background runs never hold more than their share.
      expect(mid.busy.background).toBe(2)
      expect(mid.waiting.background).toBe(2)

      const t0 = Date.now()
      const tool = await sb.run("echo", 7, { orgId: "org-tool", deadlineMs: 1_000 })
      expect(tool.body).toMatchObject({ ok: true, result: 7 })
      expect(Date.now() - t0).toBeLessThan(900)
      expect(Number(tool.headers.get(QUEUE_HEADER))).toBeLessThan(500)
      const rec = sb.sup.recent.find((r) => r.lane === "interactive")
      expect(rec?.queueMs ?? -1).toBeLessThan(500)

      // A background run whose deadline passes in the queue never started.
      const late = await sb.run("echo", 1, {
        orgId: "org-late",
        deadlineMs: 300,
        lane: "background",
      })
      expect(late.body.error).toMatchObject({ kind: "timeout", code: "queue_timeout" })
      expect(Number(late.headers.get(QUEUE_HEADER))).toBeGreaterThanOrEqual(250)

      // The queued background runs start once the first two are over.
      await Promise.all(background)
      const lanes = sb.sup.pool.stats().counters.lanes
      expect(lanes.background.started).toBe(4)
      expect(lanes.background.waited).toBe(2)
      expect(lanes.background.queueTimeouts).toBe(1)
      expect(lanes.interactive.started).toBe(1)
      expect(lanes.interactive.waited).toBe(0)
    } finally {
      await sb.stop()
    }
  }, 30_000)

  test("interactive runs may use the background share; a fifth top-level run queues", async () => {
    const sb = await startSandbox()
    try {
      const hangs = [1, 2, 3, 4].map((i) =>
        sb.run("hang", null, { orgId: `org-i${i}`, deadlineMs: 2_000, lane: "interactive" }),
      )
      await Bun.sleep(400)
      expect(sb.sup.pool.stats().lanes.busy.interactive).toBe(4)
      // Background has no room either: the interactive runs hold the top-level share.
      const bg = await sb.run("echo", 1, { orgId: "org-b", deadlineMs: 300, lane: "background" })
      expect(bg.body.error).toMatchObject({ kind: "timeout" })
      const tool = await sb.run("echo", 1, { orgId: "org-t", deadlineMs: 300 })
      expect(tool.body.error).toMatchObject({ kind: "timeout" })
      await Promise.all(hangs)
    } finally {
      await sb.stop()
    }
  }, 30_000)

  test("a queued interactive run passes queued background runs", async () => {
    const sb = await startSandbox({ poolSize: 3, reserved: 1, reservedInteractive: 1 })
    try {
      // Caps: interactive 2, background 1. One background run holds its share,
      // one waits behind it; an interactive run holds the other process.
      const b1 = sb.run("hang", null, { orgId: "org-b1", deadlineMs: 3_000, lane: "background" })
      await Bun.sleep(200)
      const b2 = sb.run("echo", 2, { orgId: "org-b2", deadlineMs: 6_000, lane: "background" })
      const i1 = sb.run("hang", null, { orgId: "org-i1", deadlineMs: 800 })
      await Bun.sleep(200)
      // A second interactive run waits for i1's process, not for b1's lane.
      const i2 = sb.run("echo", 3, { orgId: "org-i2", deadlineMs: 6_000 })
      await i1
      const r2 = await i2
      expect(r2.body).toMatchObject({ ok: true, result: 3 })
      // b2 still waits for b1 (its lane's share), then starts.
      expect(sb.sup.pool.stats().lanes.waiting.background).toBe(1)
      await b1
      expect((await b2).body).toMatchObject({ ok: true, result: 2 })
    } finally {
      await sb.stop()
    }
  }, 30_000)
})
