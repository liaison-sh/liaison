// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 16.5 — Generic test-only install + reload endpoints for the Playwright
// worker. The Shopify-specific `_test/shopify-install-routes.ts` exists for
// Phase 16's harness and stays as-is; this is the generic surface a future
// plugin-app test (or Phase 17/18 e2e) can call without dragging in
// Shopify-specific seeding (mock OAuth token, webhook secret, etc.).
//
// The route is mounted in `app.ts` when `qaSeedRoutesEnabled` (NODE_ENV=test, or
// ENABLE_QA_SEED_ROUTES on `bun run dev`), but each handler ALSO asserts it
// defensively so a stale build never serves this surface in prod (the env
// validator additionally refuses to boot with the flag on in production).
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { qaSeedRoutesEnabled } from "~/lib/env"
import { reloadInstalledApps } from "~/modules/apps/init"
import { installAppFromTarball } from "~/modules/apps/install-service"
import { bakeIntoTestCatalog } from "~/tests/helpers/test-app-catalog"

function assertTestEnv(): void {
  if (!qaSeedRoutesEnabled) {
    throw new HTTPException(404, { message: "Not found" })
  }
}

const reloadBody = z.object({ orgId: z.string().uuid() })
const bundledBody = z.object({
  orgId: z.string().uuid(),
  app: z.string().regex(/^[a-z][a-z0-9-]*$/),
})

// apps/api/test-support/harness → liaison
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
const runJobBody = z.object({
  orgId: z.string().uuid(),
  app: z.string().min(1),
  job: z.string().min(1),
})

export const appsTestRoutes = new Hono<AppEnv>()
  .post("/install", async (c) => {
    assertTestEnv()
    const form = await c.req.formData()
    const tarball = form.get("tarball")
    if (!(tarball instanceof Blob)) {
      throw new HTTPException(400, { message: "tarball missing or not a file" })
    }
    const grantedScopesRaw = form.get("grantedScopes")
    const grantedScopes = grantedScopesRaw ? (JSON.parse(String(grantedScopesRaw)) as string[]) : []

    const dir = mkdtempSync(join(tmpdir(), "test-install-"))
    const tarballPath = join(dir, "upload.liaisonapp")
    writeFileSync(tarballPath, new Uint8Array(await tarball.arrayBuffer()))
    try {
      const result = await installAppFromTarball({
        // Test harness: stands in for the admin approving the interface at install.
        approveUiFullAccess: true,
        tarballPath,
        installedBy: randomUUID(),
        grantedScopes,
        requireSignature: false,
      })
      return c.json({ data: result })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  // One first-party bundled app, from its frozen `.liaisonapp`, as the image installs it
  // (through the catalog, so its UI runs in the page), with the scopes its manifest asks.
  // Installed once per server (`apps_installed` is keyed by name), reloaded for the org.
  .post("/install-bundled", async (c) => {
    assertTestEnv()
    const body = bundledBody.parse(await c.req.json())
    const dir = join(REPO_ROOT, "bundled-apps", body.app)
    const manifest = JSON.parse(readFileSync(join(dir, "app.manifest.json"), "utf8")) as {
      version: string
      scopes?: string[]
    }
    const tarball = join(dir, "dist", `${body.app}-${manifest.version}.liaisonapp`)
    if (!existsSync(tarball)) {
      throw new HTTPException(500, {
        message: `install-bundled: no ${tarball}; run bash scripts/build-bundled-app.sh ${body.app} --skip-sign`,
      })
    }
    const installedBy = await withSystemDb("apps-test-install:resolve-installer", async (db) => {
      const r = (await db.execute(
        sql`SELECT id FROM ${sql.raw(schemaRef("kernel"))}.users WHERE org_id = ${body.orgId}
            ORDER BY created_at ASC LIMIT 1`,
      )) as unknown as { rows?: Array<{ id: string }> } | Array<{ id: string }>
      const rows = Array.isArray(r) ? r : (r.rows ?? [])
      return rows[0]?.id ?? null
    })
    if (!installedBy)
      throw new HTTPException(500, { message: "install-bundled: the org has no user" })
    const installed = await withSystemDb("apps-test-install:check", async (db) => {
      const r = (await db.execute(
        sql`SELECT version FROM ${sql.raw(schemaRef("kernel"))}.apps_installed WHERE name = ${body.app}`,
      )) as unknown as { rows?: unknown[] } | unknown[]
      return (Array.isArray(r) ? r : (r.rows ?? [])).length > 0
    })
    if (!installed) {
      await installAppFromTarball({
        // Test harness: stands in for the admin approving the interface at install.
        approveUiFullAccess: true,
        tarballPath: bakeIntoTestCatalog(tarball),
        installedBy,
        grantedScopes: manifest.scopes ?? [],
        grantedConnections: [],
      })
    }
    await reloadInstalledApps(body.orgId)
    return c.json({ data: { app: body.app, version: manifest.version } })
  })
  .post("/reload", async (c) => {
    assertTestEnv()
    const body = reloadBody.parse(await c.req.json())
    await reloadInstalledApps(body.orgId)
    return c.json({ data: { ok: true } })
  })
  // One run of an app's scheduled job for one org, NOW: enqueued on the real queue with the
  // payload the cron fan-out gives it (`{ orgId }`), so the real worker runs the real handler in
  // the sandbox. A test stands in for the clock, nothing else.
  .post("/run-job", async (c) => {
    assertTestEnv()
    const body = runJobBody.parse(await c.req.json())
    const jobId = await enqueueAppJob(body.app, body.job, { orgId: body.orgId })
    return c.json({ data: { jobId } })
  })
