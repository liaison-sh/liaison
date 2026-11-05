// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The HTTP access log: a 503 relayed from an outside upstream logs at warn, a 503
// because one of our own dependencies is down (not ready, maintenance) at error.
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { type AppEnv, responseFailure } from "~/app"
import type { FailureSeverity } from "~/lib/failure-severity"
import { ReadinessTestAccess } from "~/lib/readiness"
import { _resetMaintenanceCache, maintenanceMiddleware } from "~/middleware/maintenance"
import { readyzRoutes } from "~/modules/healthz/readyz"

function harness(mount: (app: Hono<AppEnv>) => void) {
  const seen: FailureSeverity[] = []
  const app = new Hono<AppEnv>()
  app.use(async (c, next) => {
    await next()
    seen.push(responseFailure(c))
  })
  mount(app)
  return { app, seen }
}

describe("access log severity of a 503", () => {
  const dirs: string[] = []
  afterEach(() => {
    ReadinessTestAccess.reset()
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    delete process.env.MAINTENANCE_FLAG_PATH
    _resetMaintenanceCache()
  })

  it("a 503 relayed from an outside upstream is a warn", async () => {
    const { app, seen } = harness((a) => a.get("/relay", (c) => c.json({ error: {} }, 503)))
    expect((await app.request("/relay")).status).toBe(503)
    expect(seen).toEqual([{ level: "warn", reason: "upstream_unavailable" }])
  })

  it("/readyz not ready (this process booting) is an error", async () => {
    const { app, seen } = harness((a) => a.route("/readyz", readyzRoutes))
    expect((await app.request("/readyz")).status).toBe(503)
    expect(seen).toEqual([{ level: "error" }])
  })

  it("the maintenance page is an error", async () => {
    const d = mkdtempSync(join(tmpdir(), "liaison-own-dep-"))
    dirs.push(d)
    writeFileSync(join(d, "maintenance"), "")
    process.env.MAINTENANCE_FLAG_PATH = join(d, "maintenance")
    const { app, seen } = harness((a) => {
      a.use(maintenanceMiddleware())
      a.get("/x", (c) => c.text("ok"))
    })
    expect((await app.request("/x")).status).toBe(503)
    expect(seen).toEqual([{ level: "error" }])
  })
})
