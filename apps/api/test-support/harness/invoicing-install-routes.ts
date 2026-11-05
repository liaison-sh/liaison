// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 E2E harness — test-only Invoicing install route + numbering
// invariant check (I1 + I3 of the E2E plan).
//
// Gated on `qaSeedRoutesEnabled` (NODE_ENV=test, or ENABLE_QA_SEED_ROUTES so the
// qa/ harness can install Invoicing on `bun run dev`). Mounts:
//   POST /api/_test/invoicing/install-for-test  (I1)
//   POST /api/_test/invoicing/check-numbering   (I3)
//
// I1 drives the full server-side install dance for the bundled Invoicing
// app from a single HTTP call so the Playwright worker (which runs in a
// different process from the API server) can install + wire the app
// without restarting the server. It also seeds an issuer profile, a Mail
// connected_account, and any auxiliary fixtures the scenarios need
// (additional contacts for S4, customs library entries, optional Shopify
// shop_mapping).
//
// I3 runs `bundled-apps/invoicing/scripts/check-numbering.sql` against
// the worker's schema and returns any gap rows.
import { randomBytes, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { encryptSecret } from "~/lib/crypto"
import { env, qaSeedRoutesEnabled } from "~/lib/env"
import { zValidator } from "~/lib/validate"
import { reloadInstalledApps } from "~/modules/apps/init"
import { installAppFromTarball } from "~/modules/apps/install-service"
import { bakeIntoTestCatalog } from "~/tests/helpers/test-app-catalog"

export const invoicingTestInstallRoutes = new Hono<AppEnv>()

const COUNTRY_DEFAULTS: Record<
  string,
  {
    legal_name: string
    vat_id: string | null
    address: string
    iban: string | null
    default_currency: string
    default_language: "en" | "fr" | "de"
  }
> = {
  FR: {
    legal_name: "Test FR SAS",
    vat_id: "FR12345678901",
    address: "1 Rue de la Test, 75001 Paris",
    iban: "FR7612345678901234567890185",
    default_currency: "EUR",
    default_language: "fr",
  },
  DE: {
    legal_name: "Test DE GmbH",
    vat_id: "DE123456789",
    address: "Teststrasse 1, 10115 Berlin",
    iban: "DE89370400440532013000",
    default_currency: "EUR",
    default_language: "de",
  },
  GB: {
    legal_name: "Test UK Ltd",
    vat_id: "GB123456789",
    address: "1 Test Lane, London EC1A 1AA",
    iban: "GB29NWBK60161331926819",
    default_currency: "GBP",
    default_language: "en",
  },
  US: {
    legal_name: "Test US Inc",
    vat_id: null,
    address: "1 Test St, New York NY 10001",
    iban: null,
    default_currency: "USD",
    default_language: "en",
  },
}

const installBodySchema = z.object({
  orgId: z.string().uuid(),
  bundlePath: z.string().optional(),
  grantedScopes: z.array(z.string()).optional(),
  issuerCountry: z.enum(["FR", "DE", "GB", "US"]).default("FR"),
  issuerOverrides: z
    .object({
      invoice_approval_threshold_minor: z.number().int().nullable().optional(),
      po_approval_threshold_minor: z.number().int().nullable().optional(),
      require_two_eyes: z.boolean().optional(),
      auto_email_enabled: z.boolean().optional(),
      timezone: z.string().optional(),
    })
    .optional(),
  additionalIssuers: z.array(z.enum(["FR", "DE", "GB", "US"])).optional(),
  additionalContacts: z
    .array(
      z.object({
        country: z.string(),
        name: z.string(),
        email: z.string(),
        // E-invoicing: who the contact is. REQUIRED, no default: a French buyer's kind decides
        // whether its invoice is an e-invoice, so every scenario states it.
        customerKind: z.enum(["business", "individual", "public_entity", "non_registered_entity"]),
        // Optional registry-confirmed identity (fictional SIREN) for a French business buyer.
        identity: z
          .object({
            siren: z.string().regex(/^\d{9}$/),
            postcode: z.string(),
            city: z.string(),
          })
          .optional(),
      }),
    )
    .optional(),
  shopifyInstallHandle: z
    .object({
      shopDomain: z.string(),
      connectionId: z.string(),
    })
    .optional(),
  seedCustomsFixtures: z.boolean().optional(),
})

invoicingTestInstallRoutes.post(
  "/install-for-test",
  zValidator("json", installBodySchema),
  async (c) => {
    if (!qaSeedRoutesEnabled) {
      throw new HTTPException(404, { message: "Not found" })
    }
    const body = c.req.valid("json")
    // Seeded rows here (connected_accounts.created_by, etc.) FK to
    // kernel.users(id) — the I-DB-1 secrets hardening added
    // `connected_accounts_created_by_fk`, so a random UUID violates the FK and
    // the install 500s. Attribute the seeded rows to a REAL user in the org
    // (the world-builder / `bun run seed` creates one before install runs).
    const installedBy = await withSystemDb(
      "invoicing-test-install:resolve-installer",
      async (db) => {
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
            message: `install-for-test: org ${body.orgId} has no users to attribute seeded rows; seed the org before installing`,
          })
        }
        return userId
      },
    )
    const bundlePath = body.bundlePath ?? resolveDefaultBundlePath()
    const manifest = peekManifestFromTarball(bundlePath)
    const grantedScopes = body.grantedScopes ?? manifest.scopes

    // 0. Clean-slate reset. The Playwright worker-env is worker-scoped and the
    //    local config runs `workers: 1`, so multiple invoicing scenarios share
    //    this schema. Without a reset the second install duplicate-keys on
    //    `apps_installed` (500) and prior scenarios' documents/approvals bleed
    //    into the next scenario's "exactly N" assertions. Drop the prior
    //    invoicing install + truncate its app tables + clear its approvals so
    //    every scenario starts fresh. Test-only route — destructive by design.
    {
      const invSchemaReset = schemaRef("app_invoicing")
      const kerSchemaReset = schemaRef("kernel")
      await withSystemDb("invoicing-test-install:reset", async (db) => {
        await db.execute(
          sql.raw(`DELETE FROM ${kerSchemaReset}.apps_installed WHERE name = 'invoicing'`),
        )
        // Approval children first (FK), then the invoicing approval rows.
        await db.execute(
          sql.raw(`DELETE FROM ${kerSchemaReset}.approved_handler_executions
                   WHERE approval_request_id IN (
                     SELECT id FROM ${kerSchemaReset}.approval_requests
                     WHERE tool_name LIKE 'invoicing:%')`),
        )
        await db.execute(
          sql.raw(
            `DELETE FROM ${kerSchemaReset}.approval_requests WHERE tool_name LIKE 'invoicing:%'`,
          ),
        )
        // Truncate every app_invoicing table (if the schema exists from a prior install).
        await db.execute(
          sql.raw(`DO $$
            DECLARE r RECORD;
            BEGIN
              IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = '${invSchemaReset}') THEN
                FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = '${invSchemaReset}' LOOP
                  EXECUTE 'TRUNCATE TABLE ${invSchemaReset}.' || quote_ident(r.tablename) || ' CASCADE';
                END LOOP;
              END IF;
            END $$;`),
        )
      })
    }

    // 1. installAppFromTarball + 2. reloadInstalledApps
    await installAppFromTarball({
      // Test harness: stands in for the admin approving the interface at install.
      approveUiFullAccess: true,
      tarballPath: bakeIntoTestCatalog(bundlePath),
      installedBy,
      grantedScopes,
    })
    await reloadInstalledApps(body.orgId)

    const invSchema = schemaRef("app_invoicing")
    const kerSchema = schemaRef("kernel")

    // Defensive: confirm the runtime registry created the issuer_profiles
    // table. If a prior install attempt (in a different process or before
    // schema additions landed) left `registeredApps` flagged but the schema
    // empty, surface that immediately.
    await withSystemDb("invoicing-test-install:verify-schema", async (db) => {
      const r = await db.execute(
        sql.raw(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = '${invSchema}' AND table_name = 'issuer_profiles'`,
        ),
      )
      const rows =
        (r as unknown as { rows?: Array<{ table_name: string }> }).rows ??
        (r as unknown as Array<{ table_name: string }>)
      if (rows.length === 0) {
        throw new HTTPException(500, {
          message: `invoicing schema '${invSchema}' missing issuer_profiles after reloadInstalledApps — check apps/api manifest-schema for Phase 17 capability + cross_app_calls + pdf_templates support`,
        })
      }
    })

    // 4. Seed Mail connected_account first so we can stamp mail_account_id.
    const mailAccountId = await withSystemDb(
      "invoicing-test-install:seed-mail-connected-account",
      async (db) => {
        const id = randomUUID()
        const mailEmail = `phase17-mail-${randomBytes(4).toString("hex")}@e2e.test`
        await db.execute(
          sql.raw(
            `INSERT INTO ${kerSchema}.connected_accounts
              (id, org_id, app_name, connection_name, owner_type, owner_id,
               provider_type, identifier, display_name, status, created_by)
             VALUES ('${id}', '${body.orgId}', 'mail', 'gmail', 'org', NULL,
                     'oauth2', '${mailEmail}', '${mailEmail}', 'active', '${installedBy}')`,
          ),
        )
        return id
      },
    )

    const issuerOverrides = body.issuerOverrides ?? {}

    // 3. Insert primary issuer profile
    const primaryIssuerProfileId = await insertIssuerSafe({
      invSchema,
      orgId: body.orgId,
      country: body.issuerCountry,
      mailAccountId,
      overrides: issuerOverrides,
      legalNameSuffix: "",
    })

    // 3b. Additional issuers
    const additionalIssuerIds: string[] = []
    for (const country of body.additionalIssuers ?? []) {
      const id = await insertIssuerSafe({
        invSchema,
        orgId: body.orgId,
        country,
        mailAccountId,
        overrides: issuerOverrides,
        legalNameSuffix: ` (${country})`,
      })
      additionalIssuerIds.push(id)
    }

    // 5. Additional kernel.contacts (for S4 US counterparty).
    const additionalContactIds: string[] = []
    if (body.additionalContacts && body.additionalContacts.length > 0) {
      await withSystemDb("invoicing-test-install:seed-additional-contacts", async (db) => {
        for (const ct of body.additionalContacts ?? []) {
          const cid = randomUUID()
          const safeEmail = ct.email.replace(/'/g, "''")
          const safeName = ct.name.replace(/'/g, "''")
          const safeCountry = ct.country.replace(/'/g, "''")
          const handle = `e2e-${cid.slice(0, 8)}`
          // kernel.contacts shape: handle/name/email/phone/company + external_ids json.
          // Country is stamped into external_ids so scenarios can filter by it.
          await db.execute(
            sql.raw(
              `INSERT INTO ${kerSchema}.contacts
                  (id, org_id, handle, name, email, external_ids, created_by)
                 VALUES ('${cid}', '${body.orgId}', '${handle}',
                         '${safeName}', '${safeEmail}',
                         '{"test_seed": "${safeEmail}", "country": "${safeCountry}"}'::jsonb,
                         '${installedBy}')`,
            ),
          )
          additionalContactIds.push(cid)
          // The contact's e-invoicing identity: its kind, and for a French business buyer the
          // registry-confirmed SIREN when the scenario supplies one.
          const idn = ct.identity
          await db.execute(
            sql.raw(
              `INSERT INTO ${invSchema}.counterparty_identities
                  (id, org_id, contact_id, customer_kind, siren, registry_name, registry_postcode,
                   registry_city, registry_country_code, registry_status, source, confirmed_via, changed_at)
                 VALUES ('${randomUUID()}', '${body.orgId}', '${cid}', '${ct.customerKind}',
                         ${idn ? `'${idn.siren}'` : "NULL"}, '${safeName}',
                         ${idn ? `'${idn.postcode.replace(/'/g, "''")}'` : "NULL"},
                         ${idn ? `'${idn.city.replace(/'/g, "''")}'` : "NULL"},
                         ${idn ? `'${safeCountry}'` : "NULL"}, ${idn ? "'A'" : "NULL"},
                         '${idn ? "registry" : "manual"}', ${idn ? "'auto'" : "NULL"}, now())`,
            ),
          )
        }
      })
    }

    // 6. Shopify shop → issuer linkage (auto-flow scenarios).
    //
    // The `onShopifyOrderCreated` auto-flow resolves the issuer via
    // `issuer_profiles.shopify_shop_id = <order shop>`, and the Shopify event
    // carries the shop *domain* (from `x-shopify-shop-domain`). Stamp the
    // primary issuer's shopify_shop_id to that domain so `findIssuerByShopId`
    // resolves; without it the handler parks `awaiting_config`. (There is no
    // standalone `shop_mappings` table — the issuer column IS the mapping.)
    const shopMappingId: string | null = null
    if (body.shopifyInstallHandle) {
      const shop = body.shopifyInstallHandle.shopDomain.replace(/'/g, "''")
      await withSystemDb("invoicing-test-install:stamp-issuer-shop-id", (db) =>
        db.execute(
          sql.raw(
            `UPDATE ${invSchema}.issuer_profiles
                SET shopify_shop_id = '${shop}'
              WHERE id = '${primaryIssuerProfileId}'`,
          ),
        ),
      )
    }

    // 7. Customs fixtures (S4).
    if (body.seedCustomsFixtures) {
      await withSystemDb("invoicing-test-install:seed-customs-fixtures", async (db) => {
        const hsId = randomUUID()
        const overlayId = randomUUID()
        await db.execute(
          sql.raw(
            `INSERT INTO ${invSchema}.hs_code_library
                (id, org_id, code, description)
               VALUES ('${hsId}', '${body.orgId}', '9207.10', 'Instrument controllers')
               ON CONFLICT DO NOTHING`,
          ),
        )
        await db.execute(
          sql.raw(
            `INSERT INTO ${invSchema}.product_customs_overlay
                (id, org_id, source, external_id, hs_code, country_of_origin,
                 customs_description, updated_by_user_id)
               VALUES ('${overlayId}', '${body.orgId}', 'manual',
                       'test-product-customs', '9207.10', 'CN',
                       'Electronic pad controller', '${installedBy}')
               ON CONFLICT DO NOTHING`,
          ),
        )
      })
    }

    return c.json({
      appName: "invoicing",
      primaryIssuerProfileId,
      additionalIssuerIds,
      additionalContactIds,
      mailAccountId,
      shopMappingId,
    })
  },
)

interface InsertIssuerArgs {
  invSchema: string
  orgId: string
  country: "FR" | "DE" | "GB" | "US"
  mailAccountId: string
  overrides: {
    invoice_approval_threshold_minor?: number | null
    po_approval_threshold_minor?: number | null
    require_two_eyes?: boolean
    auto_email_enabled?: boolean
    timezone?: string
  }
  legalNameSuffix: string
}

async function insertIssuerSafe(args: InsertIssuerArgs): Promise<string> {
  try {
    return await insertIssuer(args)
  } catch (err) {
    const e = err as Error & { cause?: unknown }
    const cause = e.cause as
      | { message?: string; code?: string; detail?: string; hint?: string }
      | undefined
    throw new Error(
      `insertIssuer(${args.country}) failed: ${cause?.message ?? e.message ?? "(no message)"} / code=${cause?.code ?? "?"} / detail=${cause?.detail ?? "?"} / hint=${cause?.hint ?? "?"}`,
    )
  }
}

async function insertIssuer(args: InsertIssuerArgs): Promise<string> {
  const defaults = COUNTRY_DEFAULTS[args.country]
  const id = randomUUID()
  const legalName = `${defaults.legal_name}${args.legalNameSuffix}-${randomBytes(2).toString("hex")}`
  const vatId = defaults.vat_id ? `'${defaults.vat_id.replace(/'/g, "''")}'` : "NULL"
  const iban = defaults.iban ? `'${defaults.iban.replace(/'/g, "''")}'` : "NULL"
  const inv =
    args.overrides.invoice_approval_threshold_minor == null
      ? "NULL"
      : String(args.overrides.invoice_approval_threshold_minor)
  const po =
    args.overrides.po_approval_threshold_minor == null
      ? "NULL"
      : String(args.overrides.po_approval_threshold_minor)
  const twoEyes = args.overrides.require_two_eyes ? "true" : "false"
  const autoEmail = args.overrides.auto_email_enabled ? "true" : "false"
  const timezone = args.overrides.timezone ?? "UTC"
  return await withSystemDb("invoicing-test-install:insert-issuer", async (db) => {
    await db.execute(
      sql.raw(
        `INSERT INTO ${args.invSchema}.issuer_profiles
            (id, org_id, legal_name, country, vat_id, address, iban,
             default_currency, default_language,
             invoice_approval_threshold_minor, po_approval_threshold_minor,
             require_two_eyes, auto_email_enabled, mail_account_id, timezone)
           VALUES ('${id}', '${args.orgId}',
                   '${legalName.replace(/'/g, "''")}',
                   '${args.country}',
                   ${vatId},
                   '${defaults.address.replace(/'/g, "''")}',
                   ${iban},
                   '${defaults.default_currency}',
                   '${defaults.default_language}',
                   ${inv}, ${po},
                   ${twoEyes}, ${autoEmail},
                   '${args.mailAccountId}',
                   '${timezone.replace(/'/g, "''")}')`,
      ),
    )
    return id
  })
}

// ---------------------------------------------------------------------------
// I3 — numbering invariant SQL check
// ---------------------------------------------------------------------------

const checkNumberingBody = z.object({
  orgId: z.string().uuid(),
})

invoicingTestInstallRoutes.post(
  "/check-numbering",
  zValidator("json", checkNumberingBody),
  async (c) => {
    if (!qaSeedRoutesEnabled) {
      throw new HTTPException(404, { message: "Not found" })
    }
    const invSchema = schemaRef("app_invoicing")
    const kerSchema = schemaRef("kernel")
    const sqlPath = resolveCheckNumberingSqlPath()
    const rawSql = readFileSync(sqlPath, "utf8")
    const prefix = `SET search_path TO "${invSchema}", "${kerSchema}", public;`
    const composed = `${prefix}\n${rawSql}`
    const gapRows = await withSystemDb("invoicing-test-install:check-numbering", async (db) => {
      const r = await db.execute(sql.raw(composed))
      const rows = (r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])
      return rows ?? []
    })
    return c.json({ gap_rows: gapRows })
  },
)

function resolveDefaultBundlePath(): string {
  const liaisonRoot = join(import.meta.dir, "..", "..", "..", "..")
  const appDir = join(liaisonRoot, "bundled-apps", "invoicing")
  // Derive the tarball name from the app manifest's version so a version
  // bump doesn't strand this route pointing at a deleted tarball.
  const manifest = JSON.parse(readFileSync(join(appDir, "app.manifest.json"), "utf8")) as {
    version: string
  }
  return join(appDir, "dist", `invoicing-${manifest.version}.liaisonapp`)
}

function resolveCheckNumberingSqlPath(): string {
  const liaisonRoot = join(import.meta.dir, "..", "..", "..", "..")
  return join(liaisonRoot, "bundled-apps", "invoicing", "scripts", "check-numbering.sql")
}

function peekManifestFromTarball(tarballPath: string): {
  name: string
  version: string
  scopes: string[]
} {
  // Use a quick spawn — matches the Shopify route's pattern.
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
  const { mkdtempSync, rmSync, readFileSync: rfs } = require("node:fs") as typeof import("node:fs")
  const { tmpdir } = require("node:os") as typeof import("node:os")
  const dir = mkdtempSync(join(tmpdir(), "invoicing-bundle-peek-"))
  try {
    const r = spawnSync("tar", ["-xzf", tarballPath, "-C", dir, "app.manifest.json"], {
      stdio: "pipe",
    })
    if (r.status !== 0) {
      throw new Error(`tar -xzf failed: ${r.stderr?.toString() ?? "<no stderr>"}`)
    }
    const raw = rfs(join(dir, "app.manifest.json"), "utf8")
    return JSON.parse(raw) as { name: string; version: string; scopes: string[] }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Silence "encryptSecret/env imported but unused" linter when no encrypted
// secrets are seeded — kept available for future scenarios that need to
// mint an encrypted token.
void encryptSecret
void env
