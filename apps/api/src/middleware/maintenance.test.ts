// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _resetMaintenanceCache } from "~/middleware/maintenance"
import { buildTestApp } from "~/tests/helpers/build-app"

describe("maintenance middleware", () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    delete process.env.MAINTENANCE_FLAG_PATH
    delete process.env.MAINTENANCE_VERSION_PATH
    // Reset the in-memory cache so each test starts from a clean state.
    _resetMaintenanceCache()
  })

  function makeDir(): string {
    const d = mkdtempSync(join(tmpdir(), "liaison-maint-"))
    dirs.push(d)
    return d
  }

  it("returns 503 with maintenance HTML and target version for non-/healthz routes when flag exists", async () => {
    const d = makeDir()
    const flagPath = join(d, "maintenance")
    const versionPath = join(d, "maintenance-version")
    writeFileSync(flagPath, "")
    writeFileSync(versionPath, "v0.1.1")
    process.env.MAINTENANCE_FLAG_PATH = flagPath
    process.env.MAINTENANCE_VERSION_PATH = versionPath
    const app = await buildTestApp()
    const r = await app.request("/api/threads")
    expect(r.status).toBe(503)
    const text = await r.text()
    expect(text).toContain("v0.1.1")
    expect(text).toContain("Liaison is upgrading")
  })

  it("includes Retry-After header in 503 response", async () => {
    const d = makeDir()
    const flagPath = join(d, "maintenance")
    writeFileSync(flagPath, "")
    process.env.MAINTENANCE_FLAG_PATH = flagPath
    const app = await buildTestApp()
    const r = await app.request("/api/threads")
    expect(r.status).toBe(503)
    expect(r.headers.get("retry-after")).toBe("30")
  })

  it("/healthz remains reachable during maintenance", async () => {
    const d = makeDir()
    const flagPath = join(d, "maintenance")
    writeFileSync(flagPath, "")
    process.env.MAINTENANCE_FLAG_PATH = flagPath
    const app = await buildTestApp()
    const r = await app.request("/healthz")
    expect(r.status).toBe(200)
  })

  it("passes through when no flag file exists", async () => {
    const d = makeDir()
    const flagPath = join(d, "absent-flag")
    process.env.MAINTENANCE_FLAG_PATH = flagPath
    const app = await buildTestApp()
    const r = await app.request("/api/health")
    // /api/health is a real route that returns 200 — not 503.
    expect(r.status).toBe(200)
  })

  it("renders maintenance page without version when version file is absent", async () => {
    const d = makeDir()
    const flagPath = join(d, "maintenance")
    writeFileSync(flagPath, "")
    process.env.MAINTENANCE_FLAG_PATH = flagPath
    // No version file set — versionPath points to a nonexistent file.
    process.env.MAINTENANCE_VERSION_PATH = join(d, "no-version")
    const app = await buildTestApp()
    const r = await app.request("/api/threads")
    expect(r.status).toBe(503)
    const text = await r.text()
    expect(text).toContain("Liaison is upgrading")
    // The version placeholder line should not appear when no version is set.
    expect(text).not.toContain("Upgrading to")
  })
})
