// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { TestWorld } from "./test-world"
import { createWorkerEnv, type WorkerEnv } from "./worker-env"

describe("TestWorld", () => {
  let env: WorkerEnv
  let world: TestWorld

  beforeAll(async () => {
    env = await createWorkerEnv(50)
  }, 60_000)

  afterAll(async () => {
    if (world) await world.destroy()
    if (env) await env.teardown()
  }, 30_000)

  it("creates a world with admin and org", async () => {
    world = await TestWorld.create(env.serverUrl, env.db, {
      seed: 42,
      org: { name: "Test World Org" },
      schemaPrefix: env.schemaPrefix,
    })
    await env.waitForReady()

    expect(world.admin.id).toBeDefined()
    expect(world.admin.token).toBeDefined()
    expect(world.org.id).toBeDefined()
  }, 30_000)

  it("adds users via real API flow", async () => {
    const users = await world.addUsers([
      { scopes: ["kernel:threads:read", "kernel:threads:write"], name: "Alice" },
      { scopes: ["kernel:threads:read", "kernel:threads:write"], name: "Bob" },
    ])
    expect(users).toHaveLength(2)
    expect(users[0].name).toBe("Alice")
    expect(users[1].name).toBe("Bob")
    expect(users[0].id).not.toBe(users[1].id)
  })

  it("creates a thread and sends a message", async () => {
    const allUsers = world.users
    const thread = await world.threads.create(allUsers[1], {
      participantIds: [allUsers[2].id],
      title: "Test Thread",
    })
    expect(thread.id).toBeDefined()
    expect(thread.handle).toMatch(/^test-thread(-\d+)?$/)

    const msg = await world.threads.sendMessage(thread, allUsers[1], "Hello from the test world!")
    expect(msg.id).toBeDefined()
  })

  it("populates a realistic baseline", async () => {
    const summary = await world.populate({
      users: { count: 5 },
      threads: { count: 10, participants: "random(2-4)", messages: "random(1-5)" },
    })
    expect(summary.users).toBeGreaterThanOrEqual(2) // already have admin+2 users, so need 2 more
    expect(summary.threads).toBe(10)
    expect(summary.messages).toBeGreaterThan(0)
  }, 30_000)
})
