// SPDX-License-Identifier: FSL-1.1-ALv2
import Redis from "ioredis"
import { env, isTestEnv } from "~/lib/env"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ service: "redis" })

// ioredis 6 speaks RESP3 by default, which changes reply shapes (numbers,
// maps, booleans where RESP2 answered strings and flat arrays). Every reader
// here, BullMQ's Lua scripts included, was written against RESP2: pin it, on
// every client (`duplicate()` copies it).
export const RESP_PROTOCOL = 2

// REDIS_PREFIX for worker isolation in E2E tests (e.g. "w0:")
export const REDIS_PREFIX = process.env.REDIS_PREFIX ?? ""

// Main Redis client with keyPrefix for app-level key isolation
export const redis = new Redis(env.REDIS_URL, {
  keyPrefix: REDIS_PREFIX,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  protocol: RESP_PROTOCOL,
  retryStrategy(times) {
    const delay = Math.min(times * 200, 5000)
    log.warn({ attempt: times, delay }, "Redis reconnecting")
    return delay
  },
})

redis.on("error", (err) => log.error({ err }, "Redis error"))
redis.on("connect", () => log.info("Redis connected"))

// BullMQ-dedicated connection WITHOUT keyPrefix (BullMQ rejects ioredis keyPrefix).
// Uses BullMQ's own prefix option for isolation instead.
export const redisBullMQ = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  protocol: RESP_PROTOCOL,
  retryStrategy(times) {
    const delay = Math.min(times * 200, 5000)
    log.warn({ attempt: times, delay }, "Redis BullMQ reconnecting")
    return delay
  },
})

redisBullMQ.on("error", (err) => log.error({ err }, "Redis BullMQ error"))
redisBullMQ.on("connect", () => log.info("Redis BullMQ connected"))

// BullMQ prefix: includes REDIS_PREFIX for worker isolation
export const bullPrefix = REDIS_PREFIX ? `${REDIS_PREFIX}bull` : "bull"

// Dedicated subscriber connection for pub/sub with explicit reconnect handling
export const redisSub = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  protocol: RESP_PROTOCOL,
  retryStrategy(times) {
    const delay = Math.min(times * 200, 5000)
    log.warn({ attempt: times, delay }, "Redis subscriber reconnecting")
    return delay
  },
})

let redisPublishForTest: ((channel: string, payload: string) => Promise<number>) | undefined

/**
 * Publish wrapper used by sandbox RPC bridge methods (`realtime_publish`,
 * `agent_run` channel forwarding). Goes through the test seam when set,
 * otherwise delegates to the main ioredis publish.
 */
export function publishRedis(channel: string, payload: string): Promise<number> {
  if (redisPublishForTest) return redisPublishForTest(channel, payload)
  return redis.publish(channel, payload)
}

redisSub.on("error", (err) => log.error({ err }, "Redis subscriber error"))
redisSub.on("ready", () => {
  log.info("Redis subscriber connected/reconnected — verifying channel subscriptions")
  // ioredis autoResubscribe is true by default, but log for observability
})

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const RedisTestAccess = {
  setPublish(fn?: (channel: string, payload: string) => Promise<number>): void {
    if (!isTestEnv()) {
      throw new Error("RedisTestAccess.setPublish is only available in tests")
    }
    redisPublishForTest = fn
  },
}
