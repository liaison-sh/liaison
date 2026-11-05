// SPDX-License-Identifier: FSL-1.1-ALv2
// [Phase 10 BE-5] Unified surface — Phase 10 must not accidentally expose a
// parallel notification API. /api/notifications is reserved as 404; the only
// valid attention surface is /api/attention-items.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api } from "@liaison/test-helpers"
import { setupScenario, teardownScenario } from "./setup"

describe("Unified-surface guardrail", () => {
  let env: WorkerEnv
  let world: TestWorld

  beforeAll(async () => {
    const result = await setupScenario({ seed: 105 })
    env = result.env
    world = result.world
  }, 120_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 15_000)

  it("GET /api/notifications returns 404 (no parallel notification API)", async () => {
    const res = await api(env.serverUrl, "/api/notifications", { token: world.admin.token })
    expect(res.status).toBe(404)
  })

  it("GET /api/attention-items returns the unified attention envelope", async () => {
    const res = await api(env.serverUrl, "/api/attention-items", { token: world.admin.token })
    expect(res.status).toBe(200)
    // Standard success envelope { data, meta? } — aggregator returns
    // { items: AttentionItem[], errors: AttentionProviderError[] }.
    expect(res.body).toHaveProperty("data")
    expect(Array.isArray(res.body.data.items)).toBe(true)
    expect(Array.isArray(res.body.data.errors)).toBe(true)
  })
})
