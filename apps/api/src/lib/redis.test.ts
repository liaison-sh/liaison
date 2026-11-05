// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { redis } from "~/lib/redis"

describe("Redis connection", () => {
  it("can set and get a value", async () => {
    await redis.set("test:key", "hello")
    const value = await redis.get("test:key")
    expect(value).toBe("hello")
    await redis.del("test:key")
  })

  it("supports TTL-based expiry", async () => {
    await redis.set("test:ttl", "expires", "EX", 1)
    const value = await redis.get("test:ttl")
    expect(value).toBe("expires")
  })
})
