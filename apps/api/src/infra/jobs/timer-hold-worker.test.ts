// SPDX-License-Identifier: FSL-1.1-ALv2
// A long timer (ctx.timers.wakeIn past 15 min) through a real worker: the
// worker puts its job back as delayed, at most one hop at a time, unrun and
// without spending an attempt, under the same id, and runs it once at its wake
// time. The hop is shortened for the test (JobsTestAccess.setTimerHopMaxMs).
import { afterAll, describe, expect, it } from "bun:test"
import { closeAllQueues, enqueueAppJob, JobsTestAccess, registerJobWorker } from "~/infra/jobs/jobs"
import { waitFor } from "~/tests/helpers/wait-for"

const APP = "jobtest-timer"

describe("a long timer's job in the worker", () => {
  afterAll(async () => {
    JobsTestAccess.setTimerHopMaxMs()
    await closeAllQueues()
  })

  it("is held hop by hop, unrun and keeping its attempts, then runs once at its wake time", async () => {
    JobsTestAccess.setTimerHopMaxMs(300)
    const runs: Array<{ at: number; data: unknown }> = []
    registerJobWorker(APP, "wake", async (payload) => {
      runs.push({ at: Date.now(), data: payload })
    })
    const start = Date.now()
    const wakeAt = start + 3_000
    const jobId = `timer-${start}`
    await enqueueAppJob(APP, "wake", { n: 1, _wakeAt: wakeAt }, { jobId })

    // Several hops in, the job has not run: it waits, delayed, its attempts unspent.
    await Bun.sleep(1_200)
    expect(runs).toEqual([])
    const held = await JobsTestAccess.findJob(APP, "wake", jobId)
    expect(held).toBeDefined()
    expect(await held?.getState()).toBe("delayed")
    expect(held?.attemptsMade).toBe(0)
    // One hop at a time: the next look is at most a hop away, never the wake time itself.
    const nextLook = (held?.timestamp ?? 0) + (held?.delay ?? 0)
    expect(nextLook).toBeLessThan(wakeAt - 1_000)

    await waitFor(() => runs.length > 0, { timeoutMs: 10_000, label: "the timer to fire" })
    // Due within the worker's 1 s tolerance, never earlier.
    expect(runs[0]?.at ?? 0).toBeGreaterThanOrEqual(wakeAt - 1_000)
    expect(runs[0]?.data).toEqual({ n: 1, _wakeAt: wakeAt })
    await Bun.sleep(500)
    expect(runs).toHaveLength(1)
  }, 30_000)
})
