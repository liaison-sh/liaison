// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A self-hosted instance with the sandbox service (real workerd processes,
// @liaison/sandbox-supervisor) and no loader: two organizations call the same
// app at the same version through the real tool route, and their runs land on
// separate workerd processes. One organization's second run reuses its own
// process; the other's never does.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Server } from "bun"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { reloadInstalledApps } from "~/modules/apps/init"
import { installAppFromTarball, uninstallApp } from "~/modules/apps/install-service"
import { clearInstalledIdentityCache } from "~/modules/apps/sandbox/run-app"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { freezeApp } from "../../../../../../scripts/freeze-app"
import { startWorkerdLoader, type WorkerdLoader } from "./__fixtures__/workerd-loader"
import { recentRunTimings } from "./timings"

const REPO = join(import.meta.dir, "../../../../../..")
const APP = "wparityb"
const ENV_KEYS = [
  "LIAISON_APP_LOADER_URL",
  "LIAISON_APP_LOADER_CELL_ID",
  "LIAISON_APP_LOADER_KEY",
  "LIAISON_APP_BRIDGE_BASE_URL",
  "LIAISON_SANDBOX_URL",
  "LIAISON_SANDBOX_BRIDGE_URL",
  "LIAISON_APP_RUNTIME",
] as const
type Mutable = Record<string, unknown>

describe("the sandbox service on a self-hosted instance: two orgs, one app@version", () => {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, env[k]]))
  const savedRole = env.LIAISON_ROLE
  const savedAppsDir = process.env.LIAISON_APPS_DIR
  let scratch = ""
  let cell: Server<undefined> | null = null
  let loader: WorkerdLoader | null = null
  const bearer: Record<"A" | "B", string> = { A: "", B: "" }
  const org: Record<"A" | "B", string> = { A: "", B: "" }

  beforeAll(async () => {
    await acquireTestLock()
    scratch = mkdtempSync(join(tmpdir(), "sandbox-orgs-"))
    process.env.LIAISON_APPS_DIR = join(scratch, "installed")
    ;(env as unknown as Mutable).LIAISON_ROLE = "all"
    await uninstallApp({ name: APP }).catch(() => undefined)
    org.A = (await createTestOrg()).id
    const admin = await minimal.orgAdmin(org.A)
    bearer.A = await minimal.token(admin.id)
    const second = await minimal.secondOrg()
    org.B = second.orgId
    bearer.B = await minimal.token(second.adminUserId)
    const { tarballPath, manifest } = await freezeApp({
      appName: APP,
      appDir: join(import.meta.dir, "__fixtures__", "apps", APP),
      repoRoot: REPO,
      outDir: join(scratch, "tarballs"),
    })
    await installAppFromTarball({
      tarballPath,
      installedBy: admin.id,
      grantedScopes: manifest.scopes ?? [],
      grantedConnections: [],
      grantedCapabilities: [],
      requireSignature: false,
      approveUiFullAccess: true,
    })
    await reloadInstalledApps(org.A)
    await reloadInstalledApps(org.B)

    cell = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => app.fetch(req) })
    const cellOrigin = `http://127.0.0.1:${cell.port}`
    loader = await startWorkerdLoader({ cellOrigin })
    // Self-hosted: no loader, the sandbox service only.
    const e = env as unknown as Mutable
    for (const k of ENV_KEYS) e[k] = undefined
    e.LIAISON_SANDBOX_URL = loader.url
    e.LIAISON_SANDBOX_BRIDGE_URL = cellOrigin
  }, 600_000)

  afterAll(async () => {
    const e = env as unknown as Mutable
    for (const k of ENV_KEYS) e[k] = saved[k]
    e.LIAISON_ROLE = savedRole
    await loader?.stop()
    cell?.stop(true)
    await uninstallApp({ name: APP }).catch(() => undefined)
    await sql.unsafe(`DROP SCHEMA IF EXISTS app_${APP} CASCADE`)
    clearInstalledIdentityCache()
    if (savedAppsDir === undefined) delete process.env.LIAISON_APPS_DIR
    else process.env.LIAISON_APPS_DIR = savedAppsDir
    rmSync(scratch, { recursive: true, force: true })
    await releaseTestLock()
  }, 120_000)

  async function echo(who: "A" | "B", v: string) {
    const res = await app.request(`http://localhost/api/apps/${APP}/tools/echo`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer[who]}`, "content-type": "application/json" },
      body: JSON.stringify({ params: { v } }),
    })
    const body = (await res.json()) as { data?: unknown }
    return { status: res.status, body }
  }

  /** The supervisor's record of the newest run of `orgId` (matched on the /run body). */
  function processOf(orgId: string): number {
    const runIds = (loader?.runs ?? [])
      .map((r) => JSON.parse(r.body) as { runId: string; orgId: string })
      .filter((b) => b.orgId === orgId)
      .map((b) => b.runId)
    const rec = loader?.supervisor.recent.filter((r) => runIds.includes(r.runId)).at(-1)
    if (!rec) throw new Error(`no sandbox run recorded for ${orgId}`)
    expect(rec.killed).toBeNull()
    return rec.proc
  }

  it("each org's run lands on its own workerd process, through the tool route", async () => {
    const a1 = await echo("A", "from-a")
    expect(a1).toEqual({ status: 200, body: { data: { echo: "from-a", from: APP } } })
    expect(
      recentRunTimings()
        .filter((r) => r.app === APP)
        .at(-1)?.executor,
    ).toBe("workerd")
    const procA = processOf(org.A)

    const b1 = await echo("B", "from-b")
    expect(b1).toEqual({ status: 200, body: { data: { echo: "from-b", from: APP } } })
    expect(
      recentRunTimings()
        .filter((r) => r.app === APP)
        .at(-1)?.executor,
    ).toBe("workerd")
    const procB = processOf(org.B)
    expect(procB).not.toBe(procA)

    // Same app, same version, same module: only the org differs.
    const bodies = (loader?.runs ?? []).map(
      (r) => JSON.parse(r.body) as { orgId: string; app: string; version: string; sha256: string },
    )
    const a = bodies.find((b) => b.orgId === org.A)
    const b = bodies.find((b) => b.orgId === org.B)
    expect(a && b && { app: a.app, version: a.version, sha256: a.sha256 }).toEqual(
      b && { app: b.app, version: b.version, sha256: b.sha256 },
    )

    // Org A again: its own process is reused, never B's.
    expect((await echo("A", "again")).status).toBe(200)
    expect(processOf(org.A)).toBe(procA)
    expect((await echo("B", "again")).status).toBe(200)
    expect(processOf(org.B)).toBe(procB)
  }, 120_000)
})
