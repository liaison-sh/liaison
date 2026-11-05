// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
// 6-level relative — `liaison/tsconfig.json` has no alias to `scripts/`.
import { freezeApp } from "../../../../scripts/freeze-app"

const ORG = "00000000-0000-4000-8000-0000000ad001"

beforeAll(async () => {
  await acquireTestLock()
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'AppsTest Org', 'apps-test-org')`
})

afterAll(async () => {
  await withSystemDb("apps-test-cleanup", async (db) => {
    await db.delete(appsInstalled).where(eq(appsInstalled.name, "noop-fixture"))
    await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, "noop-fixture"))
  })
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await releaseTestLock()
})

describe("/api/_test/apps/install + /api/_test/apps/reload", () => {
  it("installs a tarball from multipart upload + reloads runtime for the given org", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "test-install-route-"))
    const appDir = join(workspace, "src-app")
    mkdirSync(appDir, { recursive: true })
    writeFileSync(
      join(appDir, "app.manifest.json"),
      JSON.stringify({
        name: "noop-fixture",
        version: "1.0.0",
        packageFormat: 1,
        license: "MIT",
        scopes: ["noop-fixture:noop"],
      }),
    )
    writeFileSync(join(appDir, "handlers.ts"), `export const noop = async () => ({})`)
    const { tarballPath } = await freezeApp({
      appName: "noop-fixture",
      appDir,
      outDir: join(workspace, "dist"),
    })

    process.env.LIAISON_APPS_DIR = join(workspace, "install-root")
    mkdirSync(process.env.LIAISON_APPS_DIR, { recursive: true })
    try {
      const fd = new FormData()
      fd.append("tarball", new Blob([readFileSync(tarballPath)]), "noop-fixture.liaisonapp")
      fd.append("grantedScopes", JSON.stringify(["noop-fixture:noop"]))
      const installRes = await app.request("/api/_test/apps/install", {
        method: "POST",
        body: fd,
      })
      expect(installRes.status).toBe(200)

      const reloadRes = await app.request("/api/_test/apps/reload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: ORG }),
      })
      expect(reloadRes.status).toBe(200)
    } finally {
      delete process.env.LIAISON_APPS_DIR
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  // NOTE: there is intentionally no "404 when NODE_ENV flips to production at
  // runtime" test here. Production gating for the _test seed routes is NOT
  // per-request — it is frozen at module load (`qaSeedRoutesEnabled` in
  // ~/lib/env, evaluated once at import) and enforced at TWO points that a
  // runtime `process.env.NODE_ENV` flip cannot exercise:
  //   1. boot guard: env.ts hard-exits the process if ENABLE_QA_SEED_ROUTES is
  //      set under NODE_ENV=production (the route never even mounts), and
  //   2. mount-time: app.ts only mounts these routes when qaSeedRoutesEnabled
  //      was true at import.
  // Mutating NODE_ENV after the ~/app graph has loaded re-gates nothing, so the
  // old runtime-flip assertion tested an impossible contract and is removed.
})
