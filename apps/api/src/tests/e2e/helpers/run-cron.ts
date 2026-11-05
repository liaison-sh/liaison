// SPDX-License-Identifier: FSL-1.1-ALv2
import type { WorkerEnv } from "@liaison/test-helpers"
import { Queue } from "bullmq"
import IORedis from "ioredis"

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379"

export async function triggerCronJob(
  env: WorkerEnv,
  queueName: string,
  jobName: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  // Use a dedicated short-lived ioredis connection so closing the Queue tears it down
  // without disturbing the worker's BullMQ connection (which lives in the spawned server).
  const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, protocol: 2 })
  const queue = new Queue(queueName, {
    connection,
    prefix: `${env.redisPrefix}bull`,
  })
  try {
    await queue.add(jobName, payload, { removeOnComplete: true, removeOnFail: true })
  } finally {
    await queue.close()
    connection.disconnect()
  }
}

/**
 * Like `triggerCronJob`, but returns only once the spawned server's worker has
 * finished the job (completed or failed), so a test can assert what the run
 * did (or did not) change without sleeping for it. Throws if the job is not
 * finished within `timeoutMs`.
 */
export async function runCronJobToCompletion(
  env: WorkerEnv,
  queueName: string,
  jobName: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 15_000,
): Promise<"completed" | "failed"> {
  const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, protocol: 2 })
  const queue = new Queue(queueName, {
    connection,
    prefix: `${env.redisPrefix}bull`,
  })
  try {
    const job = await queue.add(jobName, payload, { removeOnComplete: false, removeOnFail: false })
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const state = await job.getState()
      if (state === "completed" || state === "failed") {
        await job.remove().catch(() => {})
        return state
      }
      await Bun.sleep(20)
    }
    throw new Error(`${queueName}:${jobName} did not finish within ${timeoutMs}ms`)
  } finally {
    await queue.close()
    connection.disconnect()
  }
}
