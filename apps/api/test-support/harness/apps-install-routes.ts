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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { qaSeedRoutesEnabled } from "~/lib/env"
import { reloadInstalledApps } from "~/modules/apps/init"
import { installAppFromTarball } from "~/modules/apps/install-service"

function assertTestEnv(): void {
  if (!qaSeedRoutesEnabled) {
    throw new HTTPException(404, { message: "Not found" })
  }
}

const reloadBody = z.object({ orgId: z.string().uuid() })
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
