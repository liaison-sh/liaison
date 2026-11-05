// SPDX-License-Identifier: FSL-1.1-ALv2
// The load harness's synthetic job (load-synthetic.ts): it runs only for a load
// org, sleeps its time honouring the abort, and counts each run per org.
import { afterEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import {
  LoadSyntheticTestAccess,
  loadSyntheticOutstanding,
  readLoadSyntheticStats,
  reserveLoadSyntheticJobs,
  resetLoadSyntheticOutstanding,
  runLoadSynthetic,
} from "./load-synthetic"

afterEach(() => {
  LoadSyntheticTestAccess.setLoadOrgCheck(undefined)
})

describe("load-synthetic", () => {
  it("load-synthetic refuses a non-load org", async () => {
    LoadSyntheticTestAccess.setLoadOrgCheck(async () => false)
    const orgId = crypto.randomUUID()
    await expect(
      runLoadSynthetic({ orgId, sleepMs: 0, queuedAt: Date.now() }, new AbortController().signal),
    ).rejects.toThrow(/not a load org/)
    expect((await readLoadSyntheticStats(orgId)).failed).toBe(1)
  })

  it("a load org's run is counted with its wait, and the abort cuts its sleep", async () => {
    LoadSyntheticTestAccess.setLoadOrgCheck(async () => true)
    const orgId = crypto.randomUUID()
    await runLoadSynthetic(
      { orgId, sleepMs: 10, queuedAt: Date.now() - 250 },
      new AbortController().signal,
      Date.now() - 30,
    )
    const ac = new AbortController()
    const started = Date.now()
    const cut = runLoadSynthetic({ orgId, sleepMs: 60_000, queuedAt: Date.now() }, ac.signal)
    ac.abort()
    await expect(cut).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(5_000)
    const stats = await readLoadSyntheticStats(orgId)
    expect(stats.runs).toBe(1)
    expect(stats.inflight).toBe(0)
    expect(stats.maxInflight).toBeGreaterThanOrEqual(1)
    expect(stats.waitsMs[0]).toBeGreaterThanOrEqual(250)
    // Only the completed run is timed: the worker took it 30 ms before its handler started.
    expect(stats.timings).toHaveLength(1)
    expect(stats.timings[0]?.dispatchMs).toBeGreaterThanOrEqual(30)
    expect(stats.timings[0]?.lagMs).toBeGreaterThanOrEqual(0)
    await LoadSyntheticTestAccess.forget(orgId)
  })

  it("a refused run is final (not outstanding); a drain's abort is not; reset forgets the rest", async () => {
    const orgId = crypto.randomUUID()
    expect(await reserveLoadSyntheticJobs(orgId, 3, 100)).toBe(true)
    LoadSyntheticTestAccess.setLoadOrgCheck(async () => false)
    await expect(
      runLoadSynthetic({ orgId, sleepMs: 0, queuedAt: Date.now() }, new AbortController().signal),
    ).rejects.toThrow(/not a load org/)
    expect(await loadSyntheticOutstanding(orgId)).toBe(2)
    expect((await readLoadSyntheticStats(orgId)).failed).toBe(1)
    // Handed back by a drain: it reruns, so it stays outstanding.
    LoadSyntheticTestAccess.setLoadOrgCheck(async () => true)
    const ac = new AbortController()
    const cut = runLoadSynthetic({ orgId, sleepMs: 60_000, queuedAt: Date.now() }, ac.signal)
    ac.abort()
    await expect(cut).rejects.toThrow()
    expect(await loadSyntheticOutstanding(orgId)).toBe(2)
    // Jobs removed from their queue never run: reset drops them.
    await resetLoadSyntheticOutstanding(orgId)
    expect(await loadSyntheticOutstanding(orgId)).toBe(0)
    await LoadSyntheticTestAccess.forget(orgId)
  })
})
