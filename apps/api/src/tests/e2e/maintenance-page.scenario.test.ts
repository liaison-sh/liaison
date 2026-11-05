// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 14 A5 — Maintenance page is served from the API/static origin, not
// Vite (E2E plan 16-phase-14-e2e-plan.md). Asserts that:
//   1. The Bun.serve maintenance gate (lib/server.ts) short-circuits non-/healthz
//      requests BEFORE the static SPA fallback.
//   2. /healthz stays reachable so load balancers and upgrade health gates
//      can still probe liveness while the flag is set.
//   3. The maintenance HTML carries the target version from the version file.
//   4. Clearing the flag returns the API to normal serving.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import {
  clearMaintenanceFlag,
  maintenanceFlagPaths,
  setMaintenanceFlag,
} from "./helpers/maintenance-flag"
import { setupScenario, teardownScenario } from "./setup"

describe("maintenance page is served by the API origin", () => {
  let env: WorkerEnv
  let world: TestWorld
  let adminToken: string
  let workerKey: string

  beforeAll(async () => {
    // Worker key must be unique per test process so parallel scenarios don't
    // clobber each other's flag files under /tmp/liaison-test/.
    workerKey = `a5-${process.env.WORKER_ID ?? Date.now()}`
    const paths = maintenanceFlagPaths(workerKey)
    // Defensive: ensure no leftover flag from a previous aborted run.
    clearMaintenanceFlag(workerKey)

    const result = await setupScenario({
      seed: 145,
      org: { name: "Maintenance Page E2E" },
      serverEnv: {
        LIAISON_VERSION: "v0.1.0",
        MAINTENANCE_FLAG_PATH: paths.flagPath,
        MAINTENANCE_VERSION_PATH: paths.versionPath,
      },
    })
    env = result.env
    world = result.world
    adminToken = world.admin.token
  }, 120_000)

  afterAll(async () => {
    clearMaintenanceFlag(workerKey)
    await teardownScenario(env, world)
  }, 15_000)

  it("returns 200 on /healthz before the flag is set", async () => {
    const r = await fetch(`${env.serverUrl}/healthz`)
    expect(r.status).toBe(200)
    const body = (await r.json()) as { status: string }
    expect(body.status).toBe("ok")
  })

  it("returns 503 + HTML maintenance page on / when the flag is set; /healthz remains 200", async () => {
    setMaintenanceFlag(workerKey, "v0.1.1")
    try {
      const root = await fetch(`${env.serverUrl}/`)
      expect(root.status).toBe(503)
      expect(root.headers.get("content-type") ?? "").toMatch(/text\/html/)
      const html = await root.text()
      expect(html).toMatch(/Liaison is upgrading/)
      expect(html).toMatch(/v0\.1\.1/)

      // Static SPA routes get the same gate (covers the Bun.serve static-SPA
      // path in lib/server.ts that runs BEFORE Hono).
      const sub = await fetch(`${env.serverUrl}/settings/system`)
      expect(sub.status).toBe(503)
      expect((await sub.text()).includes("Liaison is upgrading")).toBe(true)

      // /healthz remains reachable — load balancers and upgrade CLI depend on it.
      const health = await fetch(`${env.serverUrl}/healthz`)
      expect(health.status).toBe(200)
      const body = (await health.json()) as { status: string }
      expect(body.status).toBe("ok")
    } finally {
      clearMaintenanceFlag(workerKey)
    }
  })

  it("blocks Hono API routes too — maintenance middleware fires before auth", async () => {
    setMaintenanceFlag(workerKey, "v0.1.1")
    try {
      const api = await fetch(`${env.serverUrl}/api/threads`, {
        headers: { authorization: `Bearer ${adminToken}` },
      })
      expect(api.status).toBe(503)
      const body = await api.text()
      expect(body).toMatch(/Liaison is upgrading/)
    } finally {
      clearMaintenanceFlag(workerKey)
    }
  })

  it("returns to normal serving once the flag is removed", async () => {
    setMaintenanceFlag(workerKey, "v0.1.1")
    const blocked = await fetch(`${env.serverUrl}/api/threads`, {
      headers: { authorization: `Bearer ${adminToken}` },
    })
    expect(blocked.status).toBe(503)
    clearMaintenanceFlag(workerKey)
    const r = await fetch(`${env.serverUrl}/api/threads`, {
      headers: { authorization: `Bearer ${adminToken}` },
    })
    expect(r.status).toBe(200)
  })
})
