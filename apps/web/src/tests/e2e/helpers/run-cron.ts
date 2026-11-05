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
