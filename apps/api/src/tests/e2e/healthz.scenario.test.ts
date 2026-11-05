// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 14 A1 — /healthz returns 200 with version, migration head, and
// dependency status against real and degraded stacks (E2E plan
// 16-phase-14-e2e-plan.md). Two worker processes: one happy-path against the
// fully-provisioned `createWorkerEnv` stack, one with a deliberately
// unroutable Meilisearch host.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { setupScenario, teardownScenario } from "./setup"

interface HealthzBody {
  status: string
  version: string
  migrationHead: string
  schemaBaseline: string
  dependencies: { db: string; redis: string; meilisearch: string; objectStorage: string }
}

describe("/healthz (happy path against real stack)", () => {
  let env: WorkerEnv
  let world: TestWorld

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 141,
      org: { name: "Healthz Happy" },
      serverEnv: { LIAISON_VERSION: "v0.1.0-test" },
    })
    env = result.env
    world = result.world
  }, 120_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 15_000)

  it("returns 200, the configured version, a parseable migrationHead, and all deps OK", async () => {
    const r = await fetch(`${env.serverUrl}/healthz`)
    expect(r.status).toBe(200)
    const body = (await r.json()) as HealthzBody
    expect(body.status).toBe("ok")
    expect(body.version).toBe("v0.1.0-test")
    expect(body.migrationHead).toMatch(/^([0-9a-f]{64}|pending:\d+\/\d+)$/)
    expect(body.schemaBaseline).toBe("v0.1.0")
    for (const dep of ["db", "redis", "meilisearch", "objectStorage"] as const) {
      expect(body.dependencies[dep]).toBe("ok")
    }
  })
})

describe("/healthz (degraded dependency)", () => {
  let env: WorkerEnv
  let world: TestWorld

  beforeAll(async () => {
    // Point this worker at an unroutable object-storage endpoint. Unlike
    // MEILISEARCH_HOST (which gates Phase 10 boot via drift detection), the
    // object-storage client is lazy — boot survives and only the per-request
    // /healthz probe fails. Other workers' shared infra stays untouched.
    const result = await setupScenario({
      seed: 142,
      org: { name: "Healthz Degraded" },
      serverEnv: {
        LIAISON_VERSION: "v0.1.0-test",
        OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:1",
      },
    })
    env = result.env
    world = result.world
  }, 120_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 15_000)

  it("still answers 200 with `objectStorage` reported as error or timeout while other deps stay ok", async () => {
    const r = await fetch(`${env.serverUrl}/healthz`)
    expect(r.status).toBe(200)
    const body = (await r.json()) as HealthzBody
    expect(body.status).toBe("ok")
    expect(["error", "timeout"]).toContain(body.dependencies.objectStorage)
    // Other dependencies should not be collateral damage.
    expect(body.dependencies.db).toBe("ok")
    expect(body.dependencies.redis).toBe("ok")
    expect(body.dependencies.meilisearch).toBe("ok")
  })
})
