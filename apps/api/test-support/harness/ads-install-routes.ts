// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ads E2E harness (Meta arm) — test-only install route.
//
// Gated on `qaSeedRoutesEnabled` (NODE_ENV=test, or ENABLE_QA_SEED_ROUTES).
// Mounted at `/api/_test/ads/install-for-test`. Drives the full server-side
// install of the ads bundled app + writes the `meta` credentials
// connection from a single HTTP call so the chaos world-harness can install +
// wire the ads app's Meta arm without a real System-User-token flow.
//
// A dedicated route (vs the generic `_test/apps/install`) is justified because:
//   1. the credentials connection write needs the server's ENCRYPTION_KEY
//      (which the route has and the seed-slice ctx does not), and
//   2. connected_accounts.created_by is a NOT-NULL FK to kernel.users, so the
//      seeded connection must be attributed to a real org user.
//
// Steps:
//   1. installAppFromTarball — verifies + installs the ads tarball
//      (app_ads.pause_ledger exists; tools register).
//      grantedConnections:["meta"] so the meta connection is grantable.
//   2. reloadInstalledApps(orgId) — refresh the in-process runtime registry so
//      the freshly installed ads app + tools are reachable without restart.
//   3. seed a kernel.connected_accounts row (provider_type='credentials',
//      credentials_encrypted = encrypt({accessToken, adAccountId, defaultPageId})).

import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { and, eq, sql } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { connectedAccounts } from "~/db/schema/kernel/connected-accounts"
import { schemaRef } from "~/db/schema-ref"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env, qaSeedRoutesEnabled } from "~/lib/env"
import { zValidator } from "~/lib/validate"
import { reloadInstalledApps } from "~/modules/apps/init"
import { installAppFromTarball } from "~/modules/apps/install-service"
import { bakeIntoTestCatalog } from "~/tests/helpers/test-app-catalog"
import { metaMockAllRequests, resetMetaMockState, setMetaMockMode } from "./meta-mock-fetch"

export const adsTestInstallRoutes = new Hono<AppEnv>()

const bodySchema = z.object({
  orgId: z.string().uuid(),
  /** Fake System-User token (the mock never validates it). */
  accessToken: z.string().default("fixture-system-user-token"),
  /** Ad-account id (normalized to act_* by the resolver). */
  adAccountId: z.string().default("act_FIXTURE"),
  defaultPageId: z.string().optional(),
  bundlePath: z.string().optional(),
})

adsTestInstallRoutes.post("/install-for-test", zValidator("json", bodySchema), async (c) => {
  if (!qaSeedRoutesEnabled) {
    throw new HTTPException(404, { message: "Not found" })
  }
  const body = c.req.valid("json")

  // connected_accounts.created_by FKs kernel.users(id) — attribute the seeded
  // connection to a REAL org user or hit a NOT-NULL/FK violation.
  const installedBy = await withSystemDb("ads-test-install:resolve-installer", async (db) => {
    const r = await db.execute(
      sql.raw(
        `SELECT id FROM ${schemaRef("kernel")}.users WHERE org_id = '${body.orgId}' ORDER BY created_at ASC LIMIT 1`,
      ),
    )
    const rows =
      (r as unknown as { rows?: Array<{ id: string }> }).rows ??
      (r as unknown as Array<{ id: string }>)
    const userId = rows?.[0]?.id
    if (!userId) {
      throw new HTTPException(500, {
        message: `ads install-for-test: org ${body.orgId} has no users to attribute the seeded connection; seed the org first`,
      })
    }
    return userId
  })

  const bundlePath = body.bundlePath ?? resolveDefaultBundlePath()
  const manifest = peekManifestFromTarball(bundlePath)
  const grantedScopes = manifest.scopes

  // 1 + 2: install on disk + reload the in-process runtime registry.
  await installAppFromTarball({
    // Test harness: stands in for the admin approving the interface at install.
    approveUiFullAccess: true,
    tarballPath: bakeIntoTestCatalog(bundlePath),
    installedBy,
    grantedScopes,
    grantedConnections: ["meta"],
  })
  await reloadInstalledApps(body.orgId)

  // 3: drop any prior active meta connection + seed a fresh credentials row.
  const adAccountId = body.adAccountId.startsWith("act_")
    ? body.adAccountId
    : `act_${body.adAccountId}`
  const credentialsJson = JSON.stringify({
    accessToken: body.accessToken,
    adAccountId,
    ...(body.defaultPageId ? { defaultPageId: body.defaultPageId } : { defaultPageId: "page_1" }),
  })

  const connectionId = await withSystemDb("ads-test-install:seed-connection", async (db) => {
    await db
      .update(connectedAccounts)
      .set({ status: "disconnected", disconnectedAt: new Date() })
      .where(
        and(
          eq(connectedAccounts.orgId, body.orgId),
          eq(connectedAccounts.appName, "ads"),
          eq(connectedAccounts.status, "active"),
        ),
      )
    const [row] = await db
      .insert(connectedAccounts)
      .values({
        orgId: body.orgId,
        appName: "ads",
        connectionName: "meta",
        ownerType: "org",
        ownerId: null,
        providerType: "credentials",
        identifier: adAccountId,
        displayName: adAccountId,
        credentialsEncrypted: encryptSecret(
          credentialsJson,
          env.ENCRYPTION_KEY,
          CryptoContext.connectedAccountCredentials,
        ),
        status: "active",
        createdBy: installedBy,
      })
      .returning({ id: connectedAccounts.id })
    return row.id
  })

  return c.json({
    appName: "ads",
    connectionId,
    adAccountId,
  })
})

// — mock-control sub-routes (per-scenario currency + failure-arm lever) —
//
// Seed the per-server-process Meta Graph mock state. The per-scenario seed slice
// POSTs `/mock/mode` to set the account currency (e.g. USD for the A/B-sequencer
// minor-units witness — the default is EUR) or the failure-arm lever (force a
// 613+subcode-1487632 body for the budget-rate-cap arm). Process-global, so
// ads scenarios run serially within a worker (the chaos default).

const mockModeSchema = z.object({
  accountCurrency: z.string().optional(),
  forceStatus: z.number().int().optional(),
  forceErrorBody: z.string().optional(),
})

adsTestInstallRoutes.post("/mock/mode", zValidator("json", mockModeSchema), (c) => {
  if (!qaSeedRoutesEnabled) {
    throw new HTTPException(404, { message: "Not found" })
  }
  setMetaMockMode(c.req.valid("json"))
  return c.json({ ok: true })
})

adsTestInstallRoutes.post("/mock/reset", (c) => {
  if (!qaSeedRoutesEnabled) {
    throw new HTTPException(404, { message: "Not found" })
  }
  resetMetaMockState()
  return c.json({ ok: true })
})

adsTestInstallRoutes.get("/mock/requests", (c) => {
  if (!qaSeedRoutesEnabled) {
    throw new HTTPException(404, { message: "Not found" })
  }
  return c.json({ requests: metaMockAllRequests() })
})

function resolveDefaultBundlePath(): string {
  // This file lives at `liaison/apps/api/test-support/harness/`. Walk up four
  // levels to reach `liaison/`, then into `bundled-apps/ads/dist/`.
  const liaisonRoot = join(import.meta.dir, "..", "..", "..", "..")
  // The version comes from the manifest, never a literal: build-bundled-app.sh
  // emits `ads-<manifest version>.liaisonapp`, so a hardcoded 0.1.0 resolved to a
  // nonexistent tarball the moment the app was bumped (what social-install-routes
  // already does).
  const manifestPath = join(liaisonRoot, "bundled-apps", "ads", "app.manifest.json")
  const { version } = JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string }
  return join(liaisonRoot, "bundled-apps", "ads", "dist", `ads-${version}.liaisonapp`)
}

function peekManifestFromTarball(tarballPath: string): {
  name: string
  version: string
  scopes: string[]
} {
  const dir = mkdtempSync(join(tmpdir(), "ads-bundle-peek-"))
  try {
    const r = spawnSync("tar", ["-xzf", tarballPath, "-C", dir, "app.manifest.json"], {
      stdio: "pipe",
    })
    if (r.status !== 0) {
      throw new Error(`tar -xzf failed: ${r.stderr?.toString() ?? "<no stderr>"}`)
    }
    const raw = readFileSync(join(dir, "app.manifest.json"), "utf8")
    return JSON.parse(raw) as { name: string; version: string; scopes: string[] }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
