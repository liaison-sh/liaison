// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 18 E2E harness — test-only Boxtal install route + mock-control route.
//
// Gated on `qaSeedRoutesEnabled` (NODE_ENV=test, or ENABLE_QA_SEED_ROUTES).
// Mounted at `/api/_test/boxtal`. Drives the full server-side install dance
// for the bundled Boxtal app from a single HTTP call so the Playwright worker
// (a different process from the API server) can install + wire the app without
// restarting the server.
//
// `POST /install-for-test`:
//   1. Resolve installer = first real user in the org (FK to kernel.users).
//   2. Clean-slate reset: drop the boxtal apps_installed row, TRUNCATE its
//      app_boxtal tables, clear its approvals — so every scenario starts fresh
//      (workers:1 shares the schema).
//   3. installAppFromTarball + reloadInstalledApps (same flow a 3rd-party app
//      uses). The re-frozen bundle declares `cross_app_calls:[invoicing:documents_get]`,
//      so the K4 envelope fires for the dogfood draft (see the E2E plan §9).
//   4. `createCredentialConnection` — inserts the 5-key credentials map
//      encrypted with `CryptoContext.connectedAccountCredentials`, MINTS
//      `boxtalWebhookSecret` into `apps.config` (the manifest declares
//      `webhookSecretConfigKey`), and queues the `connected_account:create`
//      event (carrying `kernelPublicBaseUrl=env.BASE_URL`) → `onConnectionEstablished`
//      validates creds + registers the two v3 subscriptions THROUGH THE MOCK.
//      This exercises the real K-CREDS + K-WEBHOOK-SECRET + K3 seams.
//   5. Poll `apps.config` for the minted `boxtalWebhookSecret` + the
//      `webhook_status` flag and return both.
//   6. Optional per-scenario seeds (body flags): sender address, shipping
//      profiles, content-category override.
//
// The mock-control sub-routes seed the per-server-process Boxtal mock mode and
// expose the recorder (see boxtal-mock-fetch.ts).

import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { qaSeedRoutesEnabled } from "~/lib/env"
import { zValidator } from "~/lib/validate"
import {
  createCredentialConnection,
  decryptConnectionConfigValue,
  disconnectConnection,
} from "~/modules/apps/connections/service"
import { reloadInstalledApps } from "~/modules/apps/init"
import { installAppFromTarball } from "~/modules/apps/install-service"
import { bakeIntoTestCatalog } from "~/tests/helpers/test-app-catalog"
import {
  boxtalMockAllRequests,
  boxtalMockClearRequests,
  resetBoxtalMockMode,
  setBoxtalMockMode,
} from "./boxtal-mock-fetch"
// boxtalMockAllRequests is consumed by the GET /mock/requests route below.

/**
 * M0.3 — resolve the install-time Boxtal credentials. Mock mode uses inert
 * literals (the sandbox-fetch mock ignores auth). Live mode (BOXTAL_E2E_LIVE=1)
 * pulls the real sandbox creds from env (the primary BOXTAL_V*_KEY/SECRET names,
 * aliased to the sandbox/TEST values per M0.1). Environment is always "sandbox"
 * — the e2e harness never targets production. A half-configured live run throws
 * a named error (→ the spec's hard-blocker path) rather than a confusing 401.
 */
// A `type` alias (not an `interface`) so it keeps an implicit index signature and
// stays assignable to `createCredentialConnection`'s `credentials: Record<string,
// string>` param (an interface would not be — and all five values are strings).
export type BoxtalInstallCredentials = {
  v1Key: string
  v1Secret: string
  v3Key: string
  v3Secret: string
  environment: "sandbox" | "production"
}

export function resolveBoxtalInstallCredentials(
  env: Record<string, string | undefined> = process.env,
  override?: BoxtalInstallCredentials,
): BoxtalInstallCredentials {
  // Chaos (Phase 3) passes the real sandbox creds EXPLICITLY in the install body —
  // they win over the env-based mock/live resolution the Phase-18 e2e harness uses.
  // This keeps chaos independent of the chaos API process carrying BOXTAL_E2E_LIVE.
  if (override) return override
  if (env.BOXTAL_E2E_LIVE !== "1") {
    return {
      v1Key: "mock-v1-key",
      v1Secret: "mock-v1-secret",
      v3Key: "mock-v3-key",
      v3Secret: "mock-v3-secret",
      environment: "sandbox",
    }
  }
  const v1Key = env.BOXTAL_V1_KEY
  const v1Secret = env.BOXTAL_V1_SECRET
  const v3Key = env.BOXTAL_V3_KEY
  const v3Secret = env.BOXTAL_V3_SECRET
  if (!v1Key || !v1Secret || !v3Key || !v3Secret) {
    const missing = [
      ["BOXTAL_V1_KEY", v1Key],
      ["BOXTAL_V1_SECRET", v1Secret],
      ["BOXTAL_V3_KEY", v3Key],
      ["BOXTAL_V3_SECRET", v3Secret],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k)
    throw new Error(`boxtal install: BOXTAL_E2E_LIVE=1 but missing creds: ${missing.join(", ")}`)
  }
  // After the guard, TS narrows all four to `string` — no assertions needed.
  return { v1Key, v1Secret, v3Key, v3Secret, environment: "sandbox" }
}

export const boxtalTestInstallRoutes = new Hono<AppEnv>()

const senderAddressSchema = z.object({
  name: z.string(),
  company: z.string().optional(),
  email: z.string().optional(),
  phone: z.string(),
  street: z.string(),
  city: z.string(),
  postalCode: z.string(),
  countryIsoCode: z.string(),
})

const shippingProfileSchema = z.object({
  product_source: z.string(),
  product_id: z.string(),
  unit_weight: z.number(),
  solo_length: z.number().optional(),
  solo_width: z.number().optional(),
  solo_height: z.number().optional(),
  content_category: z.string().optional(),
})

// A product profile WITH a short code, linked to one variant, written straight into the app's
// tables: the state the move of short codes onto products left behind (profiles hold codes, the
// kernel's product attributes do not yet), which the daily `sync-product-codes` job fills in.
// Written here rather than through the profile tools, whose write syncs the codes at once.
const productProfileSchema = z.object({
  label: z.string(),
  short_code: z.string(),
  unit_weight: z.number(),
  product_source: z.string(),
  product_id: z.string(),
})

// Seed a `shipment` link-store row directly (for ready_list / returns_list
// scenarios that need CONFIRMED outbound or return rows without driving the full
// gated-create + webhook flow).
const shipmentSeedSchema = z.object({
  document_ref: z.string().optional(),
  recipient_summary: z.string(),
  offer_code: z.string().optional(),
  tracking_number: z.string().optional(),
  declared_total: z.number().optional(),
  /** What the LABEL cost. The print station shows this, not the declared goods value. */
  label_cost_ttc: z.number().optional(),
  currency: z.string().optional(),
  order_status: z.enum(["PENDING", "REQUESTED", "CONFIRMED", "CANCELLED"]).optional(),
  tracking_status: z.string().optional(),
  documents: z.array(z.object({ type: z.string(), format: z.string() })).optional(),
  kind: z.enum(["outbound", "return"]).optional(),
  return_reason: z.string().optional(),
  created_by: z.enum(["agent", "user"]).optional(),
})

// Phase 3 (chaos): real sandbox creds passed explicitly so the chaos seed installs
// against the live Boxtal sandbox without the chaos API needing BOXTAL_E2E_LIVE.
const credentialsSchema = z.object({
  v1Key: z.string(),
  v1Secret: z.string(),
  v3Key: z.string(),
  v3Secret: z.string(),
  environment: z.enum(["sandbox", "production"]).default("sandbox"),
})

const installBodySchema = z.object({
  orgId: z.string().uuid(),
  bundlePath: z.string().optional(),
  grantedScopes: z.array(z.string()).optional(),
  credentials: credentialsSchema.optional(),
  seedSenderAddress: senderAddressSchema.optional(),
  seedShippingProfiles: z.array(shippingProfileSchema).optional(),
  seedProductProfiles: z.array(productProfileSchema).optional(),
  seedShipments: z.array(shipmentSeedSchema).optional(),
})

const disconnectBodySchema = z.object({ orgId: z.string().uuid() })

boxtalTestInstallRoutes.post(
  "/install-for-test",
  zValidator("json", installBodySchema),
  async (c) => {
    if (!qaSeedRoutesEnabled) {
      throw new HTTPException(404, { message: "Not found" })
    }
    const body = c.req.valid("json")
    const bundlePath = body.bundlePath ?? resolveDefaultBundlePath()
    const manifest = peekManifestFromTarball(bundlePath)
    const grantedScopes = body.grantedScopes ?? manifest.scopes

    // 1. Resolve installer — first real org user (connected_accounts.created_by FK).
    const installedBy = await withSystemDb("boxtal-test-install:resolve-installer", async (db) => {
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
          message: `boxtal install-for-test: org ${body.orgId} has no users; seed the org first`,
        })
      }
      return userId
    })

    // 2. Clean-slate reset.
    {
      const boxSchema = schemaRef("app_boxtal")
      const kerSchema = schemaRef("kernel")
      await withSystemDb("boxtal-test-install:reset", async (db) => {
        // Disconnect any prior active boxtal connection so the unique active
        // (org, app, connection, identifier) index does not collide.
        await db.execute(
          sql.raw(
            `DELETE FROM ${kerSchema}.connected_accounts WHERE org_id = '${body.orgId}' AND app_name = 'boxtal'`,
          ),
        )
        await db.execute(sql.raw(`DELETE FROM ${kerSchema}.apps_installed WHERE name = 'boxtal'`))
        // Clear ONLY the minted webhook secret from `kernel.apps.config` so the
        // mint re-runs fresh — but KEEP the `kernel.apps` row. The mint
        // (createCredentialConnection) only UPDATEs an existing apps row; deleting
        // the row makes the mint a no-op when in-process registration is idempotent
        // and does not recreate it (S0-after-prior-installs flaked on a null secret).
        await db.execute(
          sql.raw(
            `UPDATE ${kerSchema}.apps SET config = coalesce(config, '{}'::jsonb) - 'boxtalWebhookSecret', updated_at = now() WHERE org_id = '${body.orgId}' AND name = 'boxtal'`,
          ),
        )
        await db.execute(
          sql.raw(`DELETE FROM ${kerSchema}.approved_handler_executions
                 WHERE approval_request_id IN (
                   SELECT id FROM ${kerSchema}.approval_requests
                   WHERE tool_name LIKE 'boxtal:%')`),
        )
        await db.execute(
          sql.raw(`DELETE FROM ${kerSchema}.approval_requests WHERE tool_name LIKE 'boxtal:%'`),
        )
        await db.execute(
          sql.raw(`DO $$
          DECLARE r RECORD;
          BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = '${boxSchema}') THEN
              FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = '${boxSchema}' LOOP
                EXECUTE 'TRUNCATE TABLE ${boxSchema}.' || quote_ident(r.tablename) || ' CASCADE';
              END LOOP;
            END IF;
          END $$;`),
        )
      })
    }

    // 3. Install on disk + reload the in-process runtime registry.
    await installAppFromTarball({
      // Test harness: stands in for the admin approving the interface at install.
      approveUiFullAccess: true,
      tarballPath: bakeIntoTestCatalog(bundlePath),
      installedBy,
      grantedScopes,
      grantedConnections: ["boxtal"],
    })
    await reloadInstalledApps(body.orgId)

    // Defensive: confirm the runtime registry created the shipment table.
    const boxSchema = schemaRef("app_boxtal")
    const kerSchema = schemaRef("kernel")
    await withSystemDb("boxtal-test-install:verify-schema", async (db) => {
      const r = await db.execute(
        sql.raw(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = '${boxSchema}' AND table_name = 'shipment'`,
        ),
      )
      const rows =
        (r as unknown as { rows?: Array<{ table_name: string }> }).rows ??
        (r as unknown as Array<{ table_name: string }>)
      if (rows.length === 0) {
        // Surface the registration status (registerSingleApp records
        // `apps.status='error'` best-effort on a per-app registration throw —
        // the whole DDL transaction rolls back, so zero tables is expected on any
        // throw). Read it back so the failure is actionable in CI.
        const status = await withSystemDb("boxtal-test-install:verify-schema-diag", async (d) => {
          const r2 = await d.execute(
            sql.raw(
              `SELECT status FROM ${kerSchema}.apps WHERE org_id = '${body.orgId}' AND name = 'boxtal'`,
            ),
          )
          const rs =
            (r2 as unknown as { rows?: Array<{ status: string }> }).rows ??
            (r2 as unknown as Array<{ status: string }>)
          return rs[0]?.status ?? "unknown"
        })
        throw new HTTPException(500, {
          message: `boxtal schema '${boxSchema}' missing shipment table after reloadInstalledApps (apps.status=${status}) — check the spawned server log for the registration error`,
        })
      }
    })

    // 4. Create the credentials connection — this mints the webhook secret into
    //    apps.config AND queues the connected_account:create event (which the
    //    outbox worker delivers to onConnectionEstablished → subscribe via mock).
    // M0.3 — mock literals by default; real sandbox creds when BOXTAL_E2E_LIVE=1;
    // explicit body.credentials (chaos Phase 3) win over both.
    const credentials = resolveBoxtalInstallCredentials(process.env, body.credentials)
    const connection = await withPrivilegedDb(
      body.orgId,
      "boxtal-test-install:create-credential-connection",
      (tx) =>
        // Privileged (BYPASSRLS) tx — mirrors the production org-connection path
        // in connections/routes.ts:138 which casts to satisfy the RlsClient param.
        // biome-ignore lint/suspicious/noExplicitAny: privileged-tx bridge (prod parity)
        createCredentialConnection(tx as any, body.orgId, installedBy, "boxtal", "boxtal", {
          identifier: "boxtal-sandbox",
          credentials,
          displayName: "Boxtal (sandbox)",
          ownerType: "org",
        }),
    )

    // 5. Poll apps.config for the minted webhook secret + the onConnectionEstablished
    //    webhook_status flag (set by the async event handler via the mock subscribe).
    const webhookSecret = await pollWebhookSecret(body.orgId, kerSchema)
    const webhookStatus = await pollWebhookStatus(boxSchema)

    // 6. Optional seeds.
    if (body.seedSenderAddress) {
      const v = JSON.stringify(body.seedSenderAddress).replace(/'/g, "''")
      await withSystemDb("boxtal-test-install:seed-sender", (db) =>
        db.execute(
          sql.raw(
            `INSERT INTO ${boxSchema}.app_config (id, org_id, key, value, created_at, updated_at)
           VALUES (gen_random_uuid(), '${body.orgId}', 'sender_address', '${v}'::jsonb, now(), now())
           ON CONFLICT (org_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          ),
        ),
      )
    }
    const seededProfileIds: string[] = []
    if (body.seedShippingProfiles && body.seedShippingProfiles.length > 0) {
      await withSystemDb("boxtal-test-install:seed-profiles", async (db) => {
        for (const p of body.seedShippingProfiles ?? []) {
          const r = await db.execute(
            sql.raw(
              `INSERT INTO ${boxSchema}.shipping_profile
               (id, org_id, product_source, product_id, unit_weight, solo_length, solo_width, solo_height, content_category, created_at, updated_at)
             VALUES (gen_random_uuid(), '${body.orgId}',
                     '${p.product_source.replace(/'/g, "''")}', '${p.product_id.replace(/'/g, "''")}',
                     ${p.unit_weight},
                     ${p.solo_length ?? "NULL"}, ${p.solo_width ?? "NULL"}, ${p.solo_height ?? "NULL"},
                     ${p.content_category ? `'${p.content_category.replace(/'/g, "''")}'` : "NULL"},
                     now(), now())
             ON CONFLICT (org_id, product_source, product_id) DO UPDATE
               SET unit_weight = EXCLUDED.unit_weight, updated_at = now()
             RETURNING id`,
            ),
          )
          const rows =
            (r as unknown as { rows?: Array<{ id: string }> }).rows ??
            (r as unknown as Array<{ id: string }>)
          if (rows[0]?.id) seededProfileIds.push(rows[0].id)
        }
      })
    }

    if (body.seedProductProfiles && body.seedProductProfiles.length > 0) {
      await withSystemDb("boxtal-test-install:seed-product-profiles", async (db) => {
        for (const p of body.seedProductProfiles ?? []) {
          const r = await db.execute(
            sql`INSERT INTO ${sql.raw(boxSchema)}.product_profile
                  (id, org_id, label, unit_weight, solo_length, solo_width, solo_height, short_code, created_at, updated_at)
                VALUES (gen_random_uuid(), ${body.orgId}::uuid, ${p.label}, ${p.unit_weight}, 30, 20, 10, ${p.short_code}, now(), now())
                RETURNING id`,
          )
          const profileId = extractRows<{ id: string }>(r)[0]?.id
          if (!profileId) throw new Error("seedProductProfiles: no profile id returned")
          await db.execute(
            sql`INSERT INTO ${sql.raw(boxSchema)}.product_profile_link
                  (id, org_id, product_source, product_id, profile_id, created_at, updated_at)
                VALUES (gen_random_uuid(), ${body.orgId}::uuid, ${p.product_source}, ${p.product_id}, ${profileId}, now(), now())`,
          )
        }
      })
    }

    const seededShipmentIds: string[] = []
    if (body.seedShipments && body.seedShipments.length > 0) {
      const esc = (v?: string | null): string => (v != null ? `'${v.replace(/'/g, "''")}'` : "NULL")
      await withSystemDb("boxtal-test-install:seed-shipments", async (db) => {
        for (const s of body.seedShipments ?? []) {
          const docs = JSON.stringify(s.documents ?? []).replace(/'/g, "''")
          const r = await db.execute(
            sql.raw(
              `INSERT INTO ${boxSchema}.shipment
               (id, org_id, document_ref, recipient_summary, offer_code, tracking_number,
                declared_total, label_cost_ttc, currency, link_state, order_status, tracking_status,
                documents, kind, return_reason, created_by, created_at, updated_at)
             VALUES (gen_random_uuid(), '${body.orgId}',
                     ${esc(s.document_ref)}, ${esc(s.recipient_summary)}, ${esc(s.offer_code)}, ${esc(s.tracking_number)},
                     ${s.declared_total ?? "NULL"}, ${s.label_cost_ttc ?? "NULL"}, ${esc(s.currency)},
                     'created', ${esc(s.order_status)}, ${esc(s.tracking_status)},
                     '${docs}'::jsonb, ${esc(s.kind ?? "outbound")}, ${esc(s.return_reason)}, ${esc(s.created_by)},
                     now(), now())
             RETURNING id`,
            ),
          )
          const rows =
            (r as unknown as { rows?: Array<{ id: string }> }).rows ??
            (r as unknown as Array<{ id: string }>)
          if (rows[0]?.id) seededShipmentIds.push(rows[0].id)
        }
      })
    }

    return c.json({
      appName: "boxtal",
      connectionId: connection.id,
      webhookSecret,
      webhookStatus,
      seededProfileIds,
      seededShipmentIds,
    })
  },
)

// Phase 3 (chaos teardown): trigger the real `connected_account:disconnect` flow so
// the bundled app's `onConnectionDisconnected` DELETEs both v3 subscriptions on the
// live sandbox (no residue). Idempotent: no active connection → {disconnected:false}.
boxtalTestInstallRoutes.post(
  "/disconnect-for-test",
  zValidator("json", disconnectBodySchema),
  async (c) => {
    if (!qaSeedRoutesEnabled) {
      throw new HTTPException(404, { message: "Not found" })
    }
    const { orgId } = c.req.valid("json")
    const kerSchema = schemaRef("kernel")
    const conn = await withSystemDb("boxtal-test-disconnect:resolve", async (db) => {
      const r = await db.execute(
        sql.raw(
          `SELECT id, created_by FROM ${kerSchema}.connected_accounts
             WHERE org_id = '${orgId}' AND app_name = 'boxtal' AND status = 'active' LIMIT 1`,
        ),
      )
      const rows =
        (r as unknown as { rows?: Array<{ id: string; created_by: string }> }).rows ??
        (r as unknown as Array<{ id: string; created_by: string }>)
      return rows[0]
    })
    if (!conn) return c.json({ ok: true, disconnected: false })
    await withPrivilegedDb(orgId, "boxtal-test-disconnect", (tx) =>
      // Privileged (BYPASSRLS) tx — mirrors the install route's prod-parity bridge.
      // biome-ignore lint/suspicious/noExplicitAny: privileged-tx bridge (prod parity)
      disconnectConnection(tx as any, orgId, conn.created_by, conn.id),
    )
    return c.json({ ok: true, disconnected: true })
  },
)

// — mock-control sub-routes —

const mockModeSchema = z.object({
  cotationFixture: z.enum(["multi", "empty", "error", "dev"]).optional(),
  createMode: z.enum(["pending", "phone_422", "server_5xx"]).optional(),
  confirmOrderId: z.string().optional(),
  dispatchOrderId: z.string().optional(),
  cancelOrderId: z.string().optional(),
  trackingStatus: z
    .object({
      orderId: z.string(),
      status: z.string(),
      message: z.string().optional(),
      // ISO date — the relay/pickup-point collection deadline the carrier reports for a
      // REACHED_DELIVERY_PICKUP_POINT parcel (returned-to-sender after this date).
      pickupDeadline: z.string().optional(),
    })
    .optional(),
})

boxtalTestInstallRoutes.post("/mock/mode", zValidator("json", mockModeSchema), (c) => {
  if (!qaSeedRoutesEnabled) throw new HTTPException(404, { message: "Not found" })
  setBoxtalMockMode(c.req.valid("json"))
  return c.json({ ok: true })
})

boxtalTestInstallRoutes.post("/mock/reset", (c) => {
  if (!qaSeedRoutesEnabled) throw new HTTPException(404, { message: "Not found" })
  resetBoxtalMockMode()
  boxtalMockClearRequests()
  return c.json({ ok: true })
})

boxtalTestInstallRoutes.get("/mock/requests", (c) => {
  if (!qaSeedRoutesEnabled) throw new HTTPException(404, { message: "Not found" })
  return c.json({ requests: boxtalMockAllRequests() })
})

// — helpers —

async function pollWebhookSecret(orgId: string, kerSchema: string): Promise<string | null> {
  const start = Date.now()
  // 15s window: the secret is minted by the async `connected_account:create`
  // event (outbox worker), which can lag under cold-start / full-suite
  // contention — a 5s window flaked when S0 ran first amid the suite warmup.
  while (Date.now() - start < 15_000) {
    const secret = await withSystemDb("boxtal-test-install:poll-webhook-secret", async (db) => {
      const r = await db.execute(
        sql.raw(
          `SELECT config->>'boxtalWebhookSecret' AS secret FROM ${kerSchema}.apps WHERE org_id = '${orgId}' AND name = 'boxtal' LIMIT 1`,
        ),
      )
      const rows =
        (r as unknown as { rows?: Array<{ secret: string | null }> }).rows ??
        (r as unknown as Array<{ secret: string | null }>)
      return rows[0]?.secret ?? null
    })
    if (secret) {
      // `apps.config.boxtalWebhookSecret` is stored ENCRYPTED at rest (see
      // createCredentialConnection's mint comment) — the raw column value is
      // ciphertext, not the secret a caller can sign with. Both real config_get
      // bridges (the connect handler and the sandboxed webhook verifier)
      // decrypt through `decryptConnectionConfigValue` before using it; a test
      // harness that hands back the ciphertext instead of the plaintext makes
      // every dispatched webhook fail `signature_mismatch` no matter how
      // correctly it signs, because it is signing with the wrong bytes.
      return decryptConnectionConfigValue(orgId, "boxtal", "boxtalWebhookSecret", secret) as string
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}

async function pollWebhookStatus(boxSchema: string): Promise<string | null> {
  const start = Date.now()
  // Same async-event lag rationale as pollWebhookSecret — widen to 15s.
  while (Date.now() - start < 15_000) {
    const status = await withSystemDb("boxtal-test-install:poll-webhook-status", async (db) => {
      const r = await db.execute(
        sql.raw(`SELECT value->>0 AS status FROM (
                   SELECT value FROM ${boxSchema}.app_config WHERE key = 'webhook_status' LIMIT 1
                 ) t`),
      )
      const rows =
        (r as unknown as { rows?: Array<{ status: string | null }> }).rows ??
        (r as unknown as Array<{ status: string | null }>)
      // value is a json string ("active"/"degraded"); ->>0 fails for a scalar,
      // so fall back to reading the raw value.
      return rows[0]?.status ?? null
    }).catch(() => null)
    if (status) return status
    // Fallback: read the raw value column.
    const raw = await withSystemDb("boxtal-test-install:poll-webhook-status-raw", async (db) => {
      const r = await db.execute(
        sql.raw(`SELECT value FROM ${boxSchema}.app_config WHERE key = 'webhook_status' LIMIT 1`),
      )
      const rows =
        (r as unknown as { rows?: Array<{ value: unknown }> }).rows ??
        (r as unknown as Array<{ value: unknown }>)
      const v = rows[0]?.value
      return typeof v === "string" ? v : v != null ? JSON.stringify(v) : null
    }).catch(() => null)
    if (raw) return raw.replace(/"/g, "")
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}

/** The boxtal bundle to install for an e2e run: the tarball matching the app's
 *  CURRENT manifest version, falling back to the highest version present.
 *
 *  This used to be the hardcoded literal "boxtal-0.1.0.liaisonapp". That file
 *  stopped being built many releases ago, so every boxtal e2e case failed at
 *  install with a tar error and had been failing silently for a long time.
 *  Resolve it from the manifest so a version bump can never orphan the suite
 *  again. */
function resolveDefaultBundlePath(): string {
  const liaisonRoot = join(import.meta.dir, "..", "..", "..", "..")
  const appDir = join(liaisonRoot, "bundled-apps", "boxtal")
  const distDir = join(appDir, "dist")
  const manifestVersion = (() => {
    try {
      return (
        JSON.parse(readFileSync(join(appDir, "app.manifest.json"), "utf8")) as { version?: string }
      ).version
    } catch {
      return undefined
    }
  })()
  if (manifestVersion) {
    const exact = join(distDir, `boxtal-${manifestVersion}.liaisonapp`)
    if (existsSync(exact)) return exact
  }
  // Fall back to the highest version on disk so a not-yet-rebuilt bump still
  // installs something real rather than failing on a missing path.
  const parse = (name: string): number[] =>
    (name.match(/^boxtal-(\d+)\.(\d+)\.(\d+)\.liaisonapp$/)?.slice(1) ?? []).map(Number)
  const newest = readdirSync(distDir)
    .filter((f) => parse(f).length === 3)
    .sort((a, b) => {
      const [x, y] = [parse(a), parse(b)]
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
    })
    .pop()
  if (!newest) {
    throw new Error(
      `No boxtal bundle found in ${distDir}. Build the app before running the boxtal e2e cases.`,
    )
  }
  return join(distDir, newest)
}

function peekManifestFromTarball(tarballPath: string): {
  name: string
  version: string
  scopes: string[]
} {
  const dir = mkdtempSync(join(tmpdir(), "boxtal-bundle-peek-"))
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
