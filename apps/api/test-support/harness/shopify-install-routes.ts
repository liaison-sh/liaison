// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 E2E harness — test-only Shopify install route.
//
// Gated on `qaSeedRoutesEnabled` (NODE_ENV=test, or ENABLE_QA_SEED_ROUTES so the
// qa/ harness can install Shopify against the real dev store on `bun run dev`).
// Mounted at `/api/_test/shopify/install-for-test`. Drives the full server-side
// install dance from a single HTTP call so the Playwright worker (which
// runs in a different process from the API server) can install + wire
// the Shopify app without a real OAuth dance + without restarting the
// server.
//
// Steps performed:
//
//   1. `installAppFromTarball` — verifies the bundle, copies it to the
//      install root, records `apps_installed` + `apps_active_version`.
//   2. `reloadInstalledApps(orgId)` — refreshes the in-process runtime
//      registry so the freshly installed Shopify app is reachable
//      without a kernel restart.
//   3. Seed a `kernel.connected_accounts` row with a mock offline
//      token (encrypted with the kernel's ENCRYPTION_KEY) — stands in
//      for the OAuth callback.
//   4. Seed `apps.config.shopifyWebhookSecret` — H4. The shipped
//      bundle's webhook verifier reads this via the `config_get`
//      bridge in `apps/api/src/modules/webhooks/routes.ts:100`.
//   5. Rewrite the `connectionConfigRegistry` entry's
//      `authorizationUrl`/`tokenUrl` to point at the mock — any
//      real OAuth-flow start triggered by the test lands at the mock.
//   6. Dispatch the synthetic `kernel/connected_account:create` event
//      so the bundle's `onConnectionEstablished` writes its
//      `app_shopify.install_metadata` row.
//   7. Write `install_metadata.api_base_url` to the mock URL (P2a
//      override) so subsequent `getShopifyClient` calls route to it.
//
// Returns the connection id, the H4 webhook secret, the install
// metadata row id, and the shop domain.

import { spawnSync } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { and, eq, sql } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { apps as appsTbl } from "~/db/schema/kernel/apps"
import { connectedAccounts } from "~/db/schema/kernel/connected-accounts"
import { schemaRef } from "~/db/schema-ref"
import { _publishEventInternal } from "~/infra/events/event-bus"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env, qaSeedRoutesEnabled } from "~/lib/env"
import { zValidator } from "~/lib/validate"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import { reloadInstalledApps } from "~/modules/apps/init"
import { installAppFromTarball } from "~/modules/apps/install-service"
import { bakeIntoTestCatalog } from "~/tests/helpers/test-app-catalog"
import {
  clearShopifyMockOrders,
  resetShopifyMockMode,
  type SeedableOrderInput,
  type ShopifyMockMode,
  seedShopifyMockOrders,
  setShopifyMockMode,
  shopifyMockAllRequests,
  shopifyMockClearRequests,
  shopifyMockSeededOrders,
} from "./shopify-mock-fetch"

export const shopifyTestInstallRoutes = new Hono<AppEnv>()

const bodySchema = z.object({
  orgId: z.string().uuid(),
  // Optional mock URL — kept for tests that intentionally stub Shopify
  // (e.g. failure-injection scenarios). Real-Shopify mode OMITS this.
  mockShopifyUrl: z.string().url().optional(),
  // Real offline token + shop domain. When BOTH are set, this acts as a
  // real-Shopify install: no apiBaseUrl override, real OAuth token written
  // into connected_accounts so outbound bridge calls hit the live store.
  // Webhook secret can be passed explicitly (must match the value the
  // tests will sign with via dispatchTestWebhook); falls back to a random
  // value when omitted (works for tests that never exercise inbound webhooks).
  realOfflineToken: z.string().optional(),
  realWebhookSecret: z.string().optional(),
  bundlePath: z.string().optional(),
  shopDomain: z.string().optional(),
  grantedScopes: z.array(z.string()).optional(),
})

shopifyTestInstallRoutes.post("/install-for-test", zValidator("json", bodySchema), async (c) => {
  if (!qaSeedRoutesEnabled) {
    throw new HTTPException(404, { message: "Not found" })
  }
  const body = c.req.valid("json")
  const useRealShopify = Boolean(body.realOfflineToken)
  const shopDomain = body.shopDomain ?? (useRealShopify ? null : "mock-shop.myshopify.com")
  if (!shopDomain) {
    throw new HTTPException(400, {
      message:
        "shopDomain is required when realOfflineToken is set (no fallback for real-Shopify mode)",
    })
  }
  const webhookSecret =
    body.realWebhookSecret ?? `mock-webhook-secret-${randomBytes(8).toString("hex")}`
  const offlineToken = body.realOfflineToken ?? "mock-offline-token"
  // connected_accounts.created_by FKs kernel.users(id) (I-DB-1 secrets
  // hardening), so a random UUID violates `connected_accounts_created_by_fk`
  // and the seed 500s. Attribute the seeded connection to a REAL org user.
  const installedBy = await withSystemDb("shopify-test-install:resolve-installer", async (db) => {
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
        message: `shopify install-for-test: org ${body.orgId} has no users to attribute the seeded connection; seed the org first`,
      })
    }
    return userId
  })

  // 0: locate bundle. Default lives at
  // `liaison/bundled-apps/shopify/dist/shopify-0.1.0.liaisonapp`. The caller
  // passes an absolute path so the server (which may have a different cwd
  // than the Playwright worker) can find it.
  const bundlePath = body.bundlePath ?? resolveDefaultBundlePath()

  // 0b: peek into the bundle to read manifest name/version/scopes.
  const manifest = peekManifestFromTarball(bundlePath)
  const grantedScopes = body.grantedScopes ?? manifest.scopes

  // 1 + 2: install on disk + reload the in-process runtime registry.
  await installAppFromTarball({
    // Test harness: stands in for the admin approving the interface at install.
    approveUiFullAccess: true,
    tarballPath: bakeIntoTestCatalog(bundlePath),
    installedBy,
    grantedScopes,
    grantedConnections: ["shop"],
  })
  await reloadInstalledApps(body.orgId)

  // 3: drop any prior active connection + seed a fresh one.
  const connectionId = await withSystemDb("shopify-test-install:seed-connection", async (db) => {
    await db
      .update(connectedAccounts)
      .set({ status: "disconnected", disconnectedAt: new Date() })
      .where(
        and(
          eq(connectedAccounts.orgId, body.orgId),
          eq(connectedAccounts.appName, "shopify"),
          eq(connectedAccounts.status, "active"),
        ),
      )
    const [row] = await db
      .insert(connectedAccounts)
      .values({
        orgId: body.orgId,
        appName: "shopify",
        connectionName: "shop",
        ownerType: "org",
        ownerId: null,
        providerType: "oauth2",
        identifier: shopDomain,
        displayName: shopDomain,
        accessTokenEncrypted: encryptSecret(
          offlineToken,
          env.ENCRYPTION_KEY,
          CryptoContext.connectedAccountAccessToken,
        ),
        status: "active",
        createdBy: installedBy,
        metadata: { grantedOAuthScopes: grantedScopes },
      })
      .returning({ id: connectedAccounts.id })
    return row.id
  })

  // 4: H4 — seed the webhook secret in `apps.config`.
  await withSystemDb("shopify-test-install:seed-webhook-secret", async (db) => {
    const overlayJson = JSON.stringify({ shopifyWebhookSecret: webhookSecret })
    await db
      .insert(appsTbl)
      .values({
        orgId: body.orgId,
        name: "shopify",
        version: manifest.version,
        config: { shopifyWebhookSecret: webhookSecret },
      })
      .onConflictDoUpdate({
        target: [appsTbl.orgId, appsTbl.name],
        set: {
          version: manifest.version,
          config: sql`coalesce(${appsTbl.config}, '{}'::jsonb) || ${overlayJson}::jsonb`,
          updatedAt: new Date(),
        },
      })
  })

  // 5: rewrite the connection-config registry entry to point at the mock.
  //    SKIP for real-Shopify mode — the manifest's authorizationUrl already
  //    points at the real `{shop}.myshopify.com` and the offline token is
  //    already minted; nothing on the OAuth side runs.
  if (body.mockShopifyUrl) {
    const existing = connectionConfigRegistry.get([body.orgId, "shopify", "shop"])
    if (existing) {
      connectionConfigRegistry.set([body.orgId, "shopify", "shop"], {
        ...existing,
        authorizationUrl: `${body.mockShopifyUrl}/admin/oauth/authorize`,
        tokenUrl: `${body.mockShopifyUrl}/admin/oauth/access_token`,
      })
    }
  }

  // 6: dispatch synthetic connected_account:create event so the bundle's
  // `onConnectionEstablished` writes `install_metadata`.
  await _publishEventInternal({
    app: "kernel",
    entity: "connected_account",
    action: "create",
    entityId: connectionId,
    data: {
      id: connectionId,
      orgId: body.orgId,
      appName: "shopify",
      connectionName: "shop",
      ownerType: "org",
      ownerId: null,
      providerType: "oauth2",
      identifier: shopDomain,
      status: "active",
      grantedOAuthScopes: grantedScopes,
      kernelPublicBaseUrl: env.BASE_URL,
    },
    actorId: installedBy,
    actorType: "system",
    orgId: body.orgId,
    timestamp: new Date().toISOString(),
  })

  // 6b: poll for install_metadata row. The bundle's `onConnectionEstablished`
  // subscriber should pick up the event we just dispatched and INSERT the
  // row. If the subscriber misses (latent phase-16 event-routing bug — see
  // visual.scenario.test.ts), fall back to writing the row directly so
  // tests that drive the panel UI have a usable install_metadata.
  let installMetadataRowId = await pollInstallMetadataRowId(shopDomain)
  if (!installMetadataRowId) {
    const installMetaSchema = schemaRef("app_shopify")
    try {
      installMetadataRowId = await withSystemDb(
        "shopify-test-install:fallback-insert-install-metadata",
        async (db) => {
          const safeShop = shopDomain.replace(/'/g, "''")
          const safeConn = connectionId.replace(/'/g, "''")
          const result = await db.execute(
            sql.raw(
              `INSERT INTO ${installMetaSchema}.install_metadata
                 (org_id, shop_domain, connection_id, api_version, granted_o_auth_scopes,
                  connection_status, installed_at, inventory_location_allowlist,
                  unfulfilled_threshold_hours, consecutive_scope_mirror_failures)
               VALUES
                 ('${body.orgId.replace(/'/g, "''")}', '${safeShop}', '${safeConn}',
                  '${(process.env.SHOPIFY_API_VERSION ?? "2026-01").replace(/'/g, "''")}',
                  '${JSON.stringify(grantedScopes).replace(/'/g, "''")}'::jsonb,
                  'connected', now(), '[]'::jsonb, 24, 0)
               ON CONFLICT (org_id, shop_domain) DO UPDATE
                 SET connection_id = EXCLUDED.connection_id,
                     connection_status = 'connected'
               RETURNING id`,
            ),
          )
          const rows =
            (result as unknown as { rows?: Array<{ id: string }> }).rows ??
            (result as unknown as Array<{ id: string }>)
          return rows[0]?.id ?? null
        },
      )
    } catch (err) {
      // Surface the full postgres error to the response — the kernel's
      // default error formatter drops `error.message`, so embed it here.
      const e = err as Error & { cause?: unknown }
      const cause = e.cause as
        | {
            message?: string
            code?: string
            detail?: string
            severity?: string
            hint?: string
            where?: string
          }
        | undefined
      throw new Error(
        `install_metadata fallback INSERT failed: ${cause?.message ?? e.message ?? "(no message)"} / code=${cause?.code ?? "?"} / detail=${cause?.detail ?? "?"} / hint=${cause?.hint ?? "?"}`,
      )
    }
  }

  // 7: write apiBaseUrl override into install_metadata so subsequent
  // `getShopifyClient` calls resolve to the mock. Schema name is
  // SCHEMA_PREFIX-aware (Playwright workers run under `w<N>_app_shopify`).
  //
  // SKIP for real-Shopify mode — letting `apiBaseUrl` stay null lets
  // `get-client.ts` construct the natural `https://{shop}.myshopify.com`
  // from the shop domain (the install_metadata row already has the right
  // `shop_domain` from the connected_account:create event).
  if (installMetadataRowId && body.mockShopifyUrl) {
    const installMetaSchema = schemaRef("app_shopify")
    const mockUrl = body.mockShopifyUrl
    await withSystemDb("shopify-test-install:write-api-base-url", async (db) => {
      await db.execute(
        sql.raw(
          `UPDATE ${installMetaSchema}.install_metadata SET api_base_url = '${mockUrl.replace(/'/g, "''")}' WHERE id = '${installMetadataRowId}'`,
        ),
      )
    })
  }

  return c.json({
    appName: "shopify",
    connectionId,
    webhookSecret,
    shopDomain,
    installMetadataRowId,
  })
})

// — mock-control sub-routes (deep-week-sim analytics harness) —
//
// Seed the per-server-process Shopify Admin-API mock mode and expose its
// recorder (see shopify-mock-fetch.ts). Mounted under `/api/_test/shopify`.

const shopifyMockModeSchema = z.object({
  mode: z.enum(["shopifyql", "no_shopifyql"]),
})

shopifyTestInstallRoutes.post("/mock/mode", zValidator("json", shopifyMockModeSchema), (c) => {
  if (!qaSeedRoutesEnabled) {
    throw new HTTPException(404, { message: "Not found" })
  }
  const body = c.req.valid("json")
  setShopifyMockMode(body.mode as ShopifyMockMode)
  return c.json({ ok: true })
})

// Put OPEN orders in the mock store, so a scenario can drive the boxtal prep grid (whose worklist
// IS the set of open unfulfilled orders) without a live dev store. Additive: the analytics
// fixtures answer exactly as before while nothing is seeded.
const shopifyMockAddressSchema = z
  .object({
    name: z.string().nullish(),
    address1: z.string().nullish(),
    address2: z.string().nullish(),
    city: z.string().nullish(),
    province: z.string().nullish(),
    provinceCode: z.string().nullish(),
    zip: z.string().nullish(),
    country: z.string().nullish(),
    countryCode: z.string().nullish(),
    phone: z.string().nullish(),
  })
  .nullish()

const shopifyMockOrdersSchema = z.object({
  orders: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string(),
        email: z.string().nullish(),
        customerName: z.string().nullish(),
        createdAt: z.string().optional(),
        amount: z.string().optional(),
        currencyCode: z.string().optional(),
        tags: z.array(z.string()).optional(),
        financialStatus: z.string().optional(),
        fulfillmentStatus: z.string().optional(),
        cancelledAt: z.string().nullish(),
        cancelReason: z.string().nullish(),
        shippingAddress: shopifyMockAddressSchema,
        lineItems: z
          .array(
            z.object({
              id: z.string().optional(),
              title: z.string().optional(),
              quantity: z.number().optional(),
              sku: z.string().nullish(),
              variantId: z.string().nullish(),
              unitAmount: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .min(1),
})

shopifyTestInstallRoutes.post("/mock/orders", zValidator("json", shopifyMockOrdersSchema), (c) => {
  if (!qaSeedRoutesEnabled) {
    throw new HTTPException(404, { message: "Not found" })
  }
  const body = c.req.valid("json")
  const ids = seedShopifyMockOrders(body.orders as SeedableOrderInput[])
  return c.json({ ok: true, ids })
})

shopifyTestInstallRoutes.get("/mock/orders", (c) => {
  if (!qaSeedRoutesEnabled) {
    throw new HTTPException(404, { message: "Not found" })
  }
  return c.json({ orders: shopifyMockSeededOrders() })
})

shopifyTestInstallRoutes.post("/mock/reset", (c) => {
  if (!qaSeedRoutesEnabled) {
    throw new HTTPException(404, { message: "Not found" })
  }
  resetShopifyMockMode()
  shopifyMockClearRequests()
  clearShopifyMockOrders()
  return c.json({ ok: true })
})

shopifyTestInstallRoutes.get("/mock/requests", (c) => {
  if (!qaSeedRoutesEnabled) {
    throw new HTTPException(404, { message: "Not found" })
  }
  return c.json({ requests: shopifyMockAllRequests() })
})

function resolveDefaultBundlePath(): string {
  // This file lives at `liaison/apps/api/test-support/harness/`. Walk up four
  // levels (_test → modules → src → api → apps) to reach `liaison/`, then
  // into `bundled-apps/shopify/dist/`. The tarball is named for the manifest
  // version (`shopify-<version>.liaisonapp` — what build-bundled-app.sh emits),
  // so read the version rather than hardcode it: the version bumps over time
  // and a stale literal (e.g. 0.1.0) resolves to a nonexistent file.
  const liaisonRoot = join(import.meta.dir, "..", "..", "..", "..")
  const manifestPath = join(liaisonRoot, "bundled-apps", "shopify", "app.manifest.json")
  const version = (JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string }).version
  return join(liaisonRoot, "bundled-apps", "shopify", "dist", `shopify-${version}.liaisonapp`)
}

function peekManifestFromTarball(tarballPath: string): {
  name: string
  version: string
  scopes: string[]
} {
  const dir = mkdtempSync(join(tmpdir(), "shopify-bundle-peek-"))
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

async function pollInstallMetadataRowId(shopDomain: string): Promise<string | null> {
  const start = Date.now()
  // schemaRef("app_shopify") resolves to `w<N>_app_shopify` under Playwright
  // workers (SCHEMA_PREFIX=`w<N>_`) and bare `app_shopify` outside isolation.
  const installMetaSchema = schemaRef("app_shopify")
  while (Date.now() - start < 5_000) {
    const id = await withSystemDb("shopify-test-install:poll-install-metadata", async (db) => {
      const result = await db.execute(
        sql.raw(
          `SELECT id FROM ${installMetaSchema}.install_metadata WHERE shop_domain = '${shopDomain.replace(/'/g, "''")}' LIMIT 1`,
        ),
      )
      const rows =
        (result as unknown as { rows?: Array<{ id: string }> }).rows ??
        (result as unknown as Array<{ id: string }>)
      return rows[0]?.id ?? null
    })
    if (id) return id
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}
