// SPDX-License-Identifier: FSL-1.1-ALv2
import Redis from "ioredis"

export interface RedisClient {
  redis: Redis
  flushKeys(prefix?: string): Promise<void>
  close(): void
}

export function createRedisClient(redisUrl: string): RedisClient {
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // RESP2, like the app's clients (apps/api/src/lib/redis.ts).
    protocol: 2,
  })

  async function flushKeys(prefix?: string): Promise<void> {
    const pattern = prefix ? `${prefix}*` : "*"
    let cursor = "0"
    do {
      // SCAN walks the whole keyspace whatever the pattern: large pages keep a
      // teardown on a busy shared Redis to a handful of round trips.
      const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 10_000)
      cursor = next
      if (keys.length) await redis.del(...keys)
    } while (cursor !== "0")
  }

  return {
    redis,
    flushKeys,
    close: () => redis.disconnect(),
  }
}
