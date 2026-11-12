// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, test } from "bun:test"
import { ensureRunOwnerReachable, type RunOwnerDeps, RunOwnerTestAccess } from "./run-owner"

function deps(o: {
  cli: boolean
  running: boolean
  fail?: number
}): RunOwnerDeps & { starts: number } {
  const d = {
    starts: 0,
    isCli: () => o.cli,
    heartbeatRunning: () => o.running,
    start: async () => {
      d.starts++
      if ((o.fail ?? 0) >= d.starts) throw new Error("listener refused")
      o.running = true
    },
  }
  return d
}

afterEach(() => RunOwnerTestAccess.reset())

describe("ensureRunOwnerReachable", () => {
  test("a CLI process without a heartbeat starts its listener and record once", async () => {
    const d = deps({ cli: true, running: false })
    await Promise.all([ensureRunOwnerReachable(d), ensureRunOwnerReachable(d)])
    await ensureRunOwnerReachable(d)
    expect(d.starts).toBe(1)
  })
  test("the server, which started both at boot, starts nothing", async () => {
    const d = deps({ cli: false, running: true })
    await ensureRunOwnerReachable(d)
    expect(d.starts).toBe(0)
  })
  test("a CLI process whose heartbeat already runs starts nothing", async () => {
    const d = deps({ cli: true, running: true })
    await ensureRunOwnerReachable(d)
    expect(d.starts).toBe(0)
  })
  test("a failed start fails the run and is tried again by the next one", async () => {
    const d = deps({ cli: true, running: false, fail: 1 })
    await expect(ensureRunOwnerReachable(d)).rejects.toThrow("listener refused")
    await ensureRunOwnerReachable(d)
    expect(d.starts).toBe(2)
  })
})
