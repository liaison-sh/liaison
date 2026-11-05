// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { closeAllQueues, createAppQueue, enqueueAppJob, registerJobWorker } from "~/infra/jobs/jobs"
import { bullPrefix, redisBullMQ } from "~/lib/redis"

describe("jobs runtime", () => {
  const results: any[] = []

  async function pollUntil(
    check: () => boolean | Promise<boolean>,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await check()) return
      await Bun.sleep(50)
    }
    throw new Error("pollUntil timed out")
  }

  beforeAll(async () => {
    // Clean stale BullMQ keys
    const keys = await redisBullMQ.keys(`${bullPrefix}:app-test-*`)
    if (keys.length > 0) await redisBullMQ.del(...keys)

    // Set up workers upfront — gives BullMQ time to connect before tests run
    createAppQueue("test-jobs")
    registerJobWorker("test-jobs", "process-item", async (payload) => {
      results.push(payload)
    })

    createAppQueue("test-fail")
    registerJobWorker("test-fail", "will-fail", async () => {
      throw new Error("intentional failure")
    })
  })

  afterAll(async () => {
    await Promise.race([closeAllQueues(), Bun.sleep(2000)])
    const keys = await redisBullMQ.keys(`${bullPrefix}:app-test-*`)
    if (keys.length > 0) await redisBullMQ.del(...keys)
  })

  it("enqueues and processes an on-demand job", async () => {
    await enqueueAppJob("test-jobs", "process-item", { itemId: "123" })

    await pollUntil(() => results.length > 0)

    expect(results).toHaveLength(1)
    expect(results[0].itemId).toBe("123")
  }, 15_000)

  it("failed job is marked as failed with correct attempts config", async () => {
    const jobId = await enqueueAppJob(
      "test-fail",
      "will-fail",
      {},
      {
        attempts: 3,
        backoff: { type: "exponential", delay: 100 },
      },
    )

    const queue = createAppQueue("test-fail")
    await pollUntil(async () => {
      const job = await queue.getJob(jobId)
      return job !== undefined && job.attemptsMade >= 1
    })

    const job = await queue.getJob(jobId)
    expect(job).toBeDefined()
    expect(job!.attemptsMade).toBeGreaterThanOrEqual(1)
    expect(job!.opts.attempts).toBe(3)
    expect(job!.opts.backoff).toEqual({ type: "exponential", delay: 100 })
  }, 15_000)

  it("kernel maintenance queue exists", () => {
    const queue = createAppQueue("kernel-maintenance")
    expect(queue).toBeDefined()
  })
})
