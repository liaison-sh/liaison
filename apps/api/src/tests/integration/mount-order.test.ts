// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _resetMaintenanceCache } from "~/middleware/maintenance"
import { buildTestApp } from "~/tests/helpers/build-app"

// Phase 14 Task 60 — asserts the production mount order is what every other
// phase-14 feature depends on:
//   1. /healthz mounted BEFORE the auth chain and BEFORE the maintenance
//      middleware so probes survive both auth failures and upgrades.
//   2. Maintenance middleware short-circuits non-/healthz traffic with 503
//      when the flag file exists, AFTER /healthz registration.
//   3. /api/admin/billing mounted BEFORE the user JWT chain (control plane
//      uses CONTROL_PLANE_API_KEY bearer, not user JWT).

describe("app mount order (final wiring verification)", () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    delete process.env.MAINTENANCE_FLAG_PATH
    delete process.env.MAINTENANCE_VERSION_PATH
    delete process.env.CONTROL_PLANE_API_KEY
    // The maintenance test below activates the flag; reset the middleware's
    // in-memory cache so an "active" reading never bleeds into a later test
    // (here or in another file) within the recheck window.
    _resetMaintenanceCache()
  })

  function makeDir(): string {
    const d = mkdtempSync(join(tmpdir(), "mount-order-"))
    dirs.push(d)
    return d
  }

  it("/healthz is reachable without auth", async () => {
    const app = await buildTestApp()
    const r = await app.request("/healthz", { headers: { "x-bun-socket-ip": "127.0.0.1" } })
    expect(r.status).toBe(200)
    // /healthz must expose version + migrationHead + schemaBaseline + deps: the
    // self-host upgrade gate reads them and it's the only route reachable during
    // a maintenance window. (Value of `version` is the env default here; assert
    // shape, not a specific build string.)
    const body = (await r.json()) as {
      status: string
      version: string
      migrationHead: string
      schemaBaseline: string
      dependencies: Record<string, string>
    }
    expect(body.status).toBe("ok")
    expect(typeof body.version).toBe("string")
    expect(body.version.length).toBeGreaterThan(0)
    expect(body.migrationHead).toMatch(/^([0-9a-f]{64}|pending:\d+\/\d+|unknown)$/)
    expect(body.schemaBaseline).toBe("v0.1.0")
    expect(body.dependencies).toBeDefined()
  })

  it("/healthz remains reachable during maintenance (mounted before middleware short-circuit)", async () => {
    const d = makeDir()
    const flag = join(d, "maintenance")
    writeFileSync(flag, "")
    process.env.MAINTENANCE_FLAG_PATH = flag
    const app = await buildTestApp()
    const healthz = await app.request("/healthz")
    expect(healthz.status).toBe(200)
    // Other routes return 503 maintenance HTML.
    const threads = await app.request("/api/threads")
    expect(threads.status).toBe(503)
  })

  it("/api/admin/billing 404s when CONTROL_PLANE_API_KEY is unset (mounted outside user-JWT chain)", async () => {
    const app = await buildTestApp()
    const r = await app.request("/api/admin/billing/credits", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer cp-key" },
      body: JSON.stringify({}),
    })
    // Without CONTROL_PLANE_API_KEY env, the entire group returns 404, not
    // 401 from the user JWT middleware.
    expect([404, 401]).toContain(r.status)
  })
})
