// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, describe, expect, it } from "bun:test"
import { createDbClient } from "./db"
import { createRedisClient } from "./redis"
import { createWorkerEnv, type WorkerEnv } from "./worker-env"

describe("worker environment isolation", () => {
  // Use high IDs to avoid collision with E2E runs using 0-3
  let env0: WorkerEnv
  let env1: WorkerEnv

  afterAll(async () => {
    if (env0) await env0.teardown()
    if (env1) await env1.teardown()
  }, 30_000)

  it("spawns two isolated worker envs with independent schemas", async () => {
    ;[env0, env1] = await Promise.all([createWorkerEnv(50), createWorkerEnv(51)])

    expect(env0.serverUrl).not.toBe(env1.serverUrl)
    expect(env0.schemaPrefix).toBe("w50_")
    expect(env1.schemaPrefix).toBe("w51_")
  }, 60_000)

  it("Redis keys are isolated between workers", async () => {
    const key0 = `${env0.redisPrefix}test-isolation`
    const key1 = `${env1.redisPrefix}test-isolation`
    await env0.redis.redis.set(key0, "worker0-value")
    await env1.redis.redis.set(key1, "worker1-value")

    const val0 = await env0.redis.redis.get(key0)
    const val1 = await env1.redis.redis.get(key1)
    expect(val0).toBe("worker0-value")
    expect(val1).toBe("worker1-value")

    await env0.redis.flushKeys(env0.redisPrefix)
    const afterFlush = await env1.redis.redis.get(key1)
    expect(afterFlush).toBe("worker1-value")

    await env1.redis.redis.del(key1)
  })

  it("C5 — teardown: no leaked schemas or Redis keys", async () => {
    const tmpEnv = await createWorkerEnv(99)

    // Verify schemas exist before teardown
    const beforeSchemas = await tmpEnv.db.sql`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name LIKE ${`w99_%`}
    `
    expect(beforeSchemas.length).toBeGreaterThan(0)

    // Set a Redis key
    await tmpEnv.redis.redis.set(`${tmpEnv.redisPrefix}leak-test`, "value")

    // Teardown
    await tmpEnv.teardown()

    // Verify schemas are gone (need new connection since tmpEnv.db is closed)
    const checkDb = createDbClient(
      process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/liaison_test",
    )
    try {
      const afterSchemas = await checkDb.sql`
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name LIKE ${`w99_%`}
      `
      expect(afterSchemas.length).toBe(0)
    } finally {
      await checkDb.close()
    }

    // Verify Redis keys are gone
    const checkRedis = createRedisClient(process.env.REDIS_URL ?? "redis://localhost:6379")
    const keys = await checkRedis.redis.keys(`w99:*`)
    expect(keys.length).toBe(0)
    checkRedis.close()
  }, 60_000)

  it("worker 0 data is invisible to worker 1", async () => {
    const res0 = await fetch(`${env0.serverUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@e2e.test", password: "SecurePass1!", name: "Admin 0" }),
    })
    expect(res0.status).toBe(200)

    const res1 = await fetch(`${env1.serverUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@e2e.test", password: "SecurePass1!", name: "Admin 1" }),
    })
    expect(res1.status).toBe(200)

    const body0 = (await res0.json()) as any
    const me0 = (await (
      await fetch(`${env0.serverUrl}/api/users/me`, {
        headers: { Authorization: `Bearer ${body0.data.accessToken}` },
      })
    ).json()) as any
    expect(me0.data.name).toBe("Admin 0")

    const body1 = (await res1.json()) as any
    const me1 = (await (
      await fetch(`${env1.serverUrl}/api/users/me`, {
        headers: { Authorization: `Bearer ${body1.data.accessToken}` },
      })
    ).json()) as any
    expect(me1.data.name).toBe("Admin 1")
  }, 30_000)
})
