// SPDX-License-Identifier: FSL-1.1-ALv2
//
// V2 — behavioral proof of the E1 BullMQ retention fix against the REAL test
// Redis: draining N scheduler-style jobs (jobs added WITHOUT per-call
// retention opts, exactly what a job-scheduler template produces) leaves at
// most `removeOnComplete.count` completed records in Redis, instead of the
// pre-fix unbounded one-record-per-tick-forever growth.
//
// E1's own tests pin the CONFIG (queue defaultJobOptions / resolved job opts);
// this test pins the BEHAVIOR: N drains -> bounded completed set.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
  closeAllQueues,
  createAppQueue,
  registerJobWorker,
  setJobsLeadership,
} from "~/infra/jobs/jobs"

// Unique app name per run so leftover records from previous runs on the shared
// test Redis can never satisfy (or break) the bound.
const APP = `v2-retention-drain-${Date.now()}`
const JOB = "tick"
const TOTAL_JOBS = 120
const RETENTION_COUNT = 100 // must match DEFAULT_QUEUE_JOB_OPTIONS.removeOnComplete.count

let processedCount = 0

beforeAll(() => {
  setJobsLeadership(true)
  registerJobWorker(APP, JOB, async () => {
    processedCount++
  })
})

afterAll(async () => {
  const queue = createAppQueue(APP)
  try {
    await queue.obliterate({ force: true })
  } catch {
    /* best effort — closeAllQueues below still runs */
  }
  await closeAllQueues()
})

describe("scheduled-job retention drain (V2, real Redis)", () => {
  it(`draining ${TOTAL_JOBS} scheduler-style jobs leaves at most ${RETENTION_COUNT} completed records`, async () => {
    const queue = createAppQueue(APP)

    // Scheduler-template shape: no per-job opts, so the queue-level
    // defaultJobOptions (the E1 fix point) are what bound retention.
    for (let i = 0; i < TOTAL_JOBS; i++) {
      await queue.add(JOB, { tick: i })
    }

    // Drain: wait until the worker has processed every job.
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (processedCount >= TOTAL_JOBS) break
      await Bun.sleep(100)
    }
    expect(processedCount).toBe(TOTAL_JOBS)

    // Give BullMQ a beat to finalize the last completion bookkeeping.
    const settleDeadline = Date.now() + 10_000
    while (Date.now() < settleDeadline) {
      const counts = await queue.getJobCounts("active", "waiting", "delayed")
      if (counts.active === 0 && counts.waiting === 0 && counts.delayed === 0) break
      await Bun.sleep(100)
    }

    const counts = await queue.getJobCounts("completed", "failed", "active", "waiting")
    expect(counts.failed).toBe(0)
    expect(counts.active).toBe(0)
    expect(counts.waiting).toBe(0)
    // The bound: processed 120, but Redis keeps at most the retention count.
    // (Pre-E1, scheduler-produced jobs had NO removeOnComplete, so this would
    // read 120 and grow forever across cron ticks.)
    expect(counts.completed).toBeGreaterThan(0)
    expect(counts.completed).toBeLessThanOrEqual(RETENTION_COUNT)
  }, 90_000)
})
