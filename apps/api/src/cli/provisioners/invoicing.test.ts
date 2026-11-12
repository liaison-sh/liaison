// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Real-DB unit test for the invoicing provisioner.
 *
 * Covers:
 * - missing app_invoicing schema (app not installed) -> actionable ConfigError;
 * - fresh issuer profile insert;
 * - idempotent re-run -> unchanged, no write;
 * - update path (a changed field re-writes only what changed);
 * - shopifyShop "auto" resolution against a seeded shopify connected_account;
 * - shopifyShop "auto" with no shopify connection -> pending, no hard failure;
 * - tax regime + hs code ensure (insert, idempotent re-run);
 * - issuer profile logoPath: fresh upload sets logo_file_id; idempotent re-run
 *   with the same bytes -> unchanged; corrupt/oversized file -> per-item
 *   logoError, run continues; relative path resolution against configDir.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { ConfigError } from "~/cli/config/parse"
import type { ProvisioningConfig } from "~/cli/config/schema"
import {
  createInvoicingProvisioner,
  defaultContractProviderCheck,
  type InvoicingLogoDeps,
  invoicingProvisioner,
  issuerIdentitySummary,
} from "~/cli/provisioners/invoicing"
import { buildProvisionContext, type ProvisionContext } from "~/cli/provisioners/types"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { reloadInstalledApps } from "~/modules/apps/init"
import { installAppFromTarball } from "~/modules/apps/install-service"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { type AppInstallSnapshot, snapshotAppInstalls } from "~/tests/helpers/app-install-state"
import { firstPartyAppTarball } from "~/tests/helpers/test-app-catalog"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// installAppFromTarball writes into LIAISON_APPS_DIR (default `/var/lib/liaison`,
// not writable outside a container). Redirect it to a temp dir for this suite.
// Apps this file installs are instance-wide rows: put them back after it.
let installs: AppInstallSnapshot | null = null

let installRoot: string
let prevAppsDir: string | undefined

beforeAll(async () => {
  await acquireTestLock()
  installs = await snapshotAppInstalls()
  installRoot = mkdtempSync(join(tmpdir(), "invoicing-prov-install-root-"))
  prevAppsDir = process.env.LIAISON_APPS_DIR
  process.env.LIAISON_APPS_DIR = installRoot
})
afterAll(async () => {
  if (prevAppsDir === undefined) delete process.env.LIAISON_APPS_DIR
  else process.env.LIAISON_APPS_DIR = prevAppsDir
  rmSync(installRoot, { recursive: true, force: true })
  await installs?.restore()
  await releaseTestLock()
})

/** The built invoicing bundle for the version its source manifest declares,
 *  built on demand when the checkout has none (dist/ is a gitignored build
 *  output) — the bundled app's version bumps independently of this CLI work. */
function invoicingBundlePath(): string {
  return firstPartyAppTarball("invoicing")
}

/** The scopes the invoicing manifest requests at install. */
function invoicingManifestScopes(): string[] {
  const manifest = JSON.parse(
    readFileSync(
      join(import.meta.dir, "../../../../../bundled-apps/invoicing/app.manifest.json"),
      "utf8",
    ),
  ) as { scopes: string[] }
  return manifest.scopes
}

async function freshOrgWithAdmin(
  configDir?: string,
): Promise<{ ctx: ProvisionContext; orgId: string }> {
  const { orgId } = await ensureOrg({
    slug: `cli-inv-${crypto.randomUUID().slice(0, 12)}`,
    name: "InvoicingProvOrg",
  })
  const { userId } = await ensureUser({
    orgId,
    email: `admin-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`,
    name: "Owner",
    password: "pw-inv-1!",
    role: "admin",
  })
  const ctx = buildProvisionContext({ log: () => {}, validateByok: false, configDir })
  ctx.orgId = orgId
  ctx.actor.userId = userId
  ctx.actor.scopes = ["*"]
  return { ctx, orgId }
}

// --- logoPath fixtures --------------------------------------------------

/** A minimal-but-valid 1x1 PNG (real magic bytes + IHDR/IDAT/IEND chunks). */
const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000a49444154789c6360000002000100" +
    "056c8fd5e0000000049454e44ae426082",
  "hex",
)

/** Bytes carrying the JPEG magic prefix (FF D8 FF) — sufficient for the
 *  provisioner's magic-byte sniff, which is the full extent of its format
 *  validation (it does not decode the image). */
const JPEG_MINIMAL = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 0)])

const NOT_AN_IMAGE = Buffer.from("this is definitely not an image\n", "utf8")

/** In-memory `InvoicingLogoDeps` fake — no real object storage / network
 *  required. `store` exposes the uploaded bytes by storage key for
 *  assertions. */
function createFakeLogoDeps(): InvoicingLogoDeps & { store: Map<string, Buffer> } {
  const store = new Map<string, Buffer>()
  return {
    store,
    async putObject(args) {
      store.set(args.key, Buffer.from(args.body))
    },
    async getObjectBuffer(key) {
      const bytes = store.get(key)
      if (!bytes) throw new Error(`fake storage: no object at ${key}`)
      return bytes
    },
  }
}

async function readIssuerLogoFile(
  orgId: string,
  fileId: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      SELECT * FROM ${drizzleSql.raw(`${schemaRef("kernel")}.files`)}
      WHERE id = ${fileId}::uuid
    `),
  )
  return extractRows(rows)[0]
}

/** Install the real invoicing bundle so `app_invoicing.issuer_profiles` exists. */
async function installInvoicing(ctx: ProvisionContext): Promise<void> {
  await installAppFromTarball({
    tarballPath: invoicingBundlePath(),
    installedBy: ctx.actor.userId,
    // Exactly what the manifest requests, as an admin granting the install would:
    // a hand-kept list went stale the day the app requested a new scope.
    grantedScopes: invoicingManifestScopes(),
  })
  await reloadInstalledApps(ctx.orgId)
}

async function seedShopifyConnection(orgId: string, shopDomain: string): Promise<void> {
  const k = schemaRef("kernel")
  await withSystemDb("invoicing-test-seed-shopify", (db) =>
    db.execute(
      drizzleSql.raw(
        `INSERT INTO ${k}.connected_accounts
           (id, org_id, app_name, connection_name, owner_type, owner_id,
            provider_type, identifier, display_name, status, created_by)
         VALUES ('${crypto.randomUUID()}', '${orgId}', 'shopify', 'shop', 'org', NULL,
                 'oauth2', '${shopDomain}', '${shopDomain}', 'active',
                 (SELECT id FROM ${k}.users WHERE org_id = '${orgId}' LIMIT 1))`,
      ),
    ),
  )
}

async function readIssuer(
  orgId: string,
  legalName: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      SELECT * FROM ${drizzleSql.raw(`${schemaRef("app_invoicing")}.issuer_profiles`)}
      WHERE org_id = ${orgId}::uuid AND legal_name = ${legalName}
    `),
  )
  return extractRows(rows)[0]
}

describe("invoicing provisioner", () => {
  test("preflight: app_invoicing.issuer_profiles missing -> actionable ConfigError, no write", async () => {
    const { ctx } = await freshOrgWithAdmin()
    // `app_invoicing` is a GLOBAL Postgres schema (shared across every org, RLS-
    // scoped rows) — once ANY test in this process installs invoicing, the
    // schema exists for the rest of the run, so we cannot rely on process
    // ordering to observe "not installed" here. Simulate it deterministically by
    // pointing `schemaRef` (which the preflight's `information_schema.tables`
    // lookup uses) at a schema name that genuinely never exists, via
    // SCHEMA_PREFIX — this does NOT affect the live connection's search_path,
    // only the identifier the preflight query looks up, so it's a safe,
    // order-independent way to exercise the "missing" branch without dropping
    // the real schema out from under other tests in the same process.
    const prevPrefix = process.env.SCHEMA_PREFIX
    process.env.SCHEMA_PREFIX = "nonexistent_"
    try {
      const config: ProvisioningConfig = {
        org: { slug: "x", name: "X" },
        invoicing: { issuerProfiles: [{ legalName: "No App SAS", country: "FR" }] },
      }
      await expect(invoicingProvisioner.apply(ctx, { actions: [] }, config)).rejects.toThrow(
        ConfigError,
      )
      await expect(invoicingProvisioner.apply(ctx, { actions: [] }, config)).rejects.toThrow(
        /enable the invoicing app first/,
      )
    } finally {
      if (prevPrefix === undefined) delete process.env.SCHEMA_PREFIX
      else process.env.SCHEMA_PREFIX = prevPrefix
    }
  })

  test("tool path: the card line names every legal identity field (N19)", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    await installInvoicing(ctx)
    ctx.toolPath = true
    const profile = {
      legalName: "Northwind Audio SAS",
      country: "FR",
      legalForm: "SAS",
      addressLine1: "10 Rue de la Paix",
      postcode: "75002",
      city: "Paris",
      countryCode: "FR",
      siren: "552032534",
      vatId: "FR40552032534",
      iban: "FR7630006000011234567890189",
    }
    const plan = await invoicingProvisioner.plan(ctx, {
      org: { slug: "x", name: "X" },
      invoicing: { issuerProfiles: [profile] },
    })
    expect(plan.actions).toContain(
      "create issuer profile 'Northwind Audio SAS' (FR): legal form SAS; address 10 Rue de la Paix, 75002 Paris, FR; SIREN 552032534; VAT FR40552032534; IBAN FR7630006000011234567890189",
    )
    // A dry plan writes nothing.
    expect(await readIssuer(orgId, "Northwind Audio SAS")).toBeUndefined()
  })

  test("issuerIdentitySummary: only the fields set, nothing for a bare profile", () => {
    expect(issuerIdentitySummary({ legalName: "A", country: "FR" })).toBe("")
    expect(issuerIdentitySummary({ legalName: "A", country: "FR", siret: "73282932000074" })).toBe(
      ": SIRET 73282932000074",
    )
    expect(
      issuerIdentitySummary({ legalName: "A", country: "DE", address: "Hauptstr. 1, Berlin" }),
    ).toBe(": address Hauptstr. 1, Berlin")
  })

  test("fresh insert: issuer profile created with COUNTRY_DEFAULTS-style fallbacks", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    await installInvoicing(ctx)

    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      invoicing: {
        issuerProfiles: [
          {
            legalName: "Fabrikam SAS",
            country: "FR",
            vatId: "FR12345678901",
          },
        ],
      },
    }
    const plan = await invoicingProvisioner.plan(ctx, config)
    const result = await invoicingProvisioner.apply(ctx, plan, config)

    const row = await readIssuer(orgId, "Fabrikam SAS")
    expect(row).toBeDefined()
    expect(row?.country).toBe("FR")
    expect(row?.vat_id).toBe("FR12345678901")
    // Fallback defaults for an unset default_currency/default_language.
    expect(row?.default_currency).toBe("EUR")
    expect(row?.default_language).toBe("fr")
    expect(row?.default_payment_terms_days).toBe(30)

    expect(result.changed).toContain("invoicing.issuerProfiles.Fabrikam SAS")
    const section = result.section as { issuerProfiles: Array<{ action: string }> }
    expect(section.issuerProfiles[0]?.action).toBe("created")
  })

  test("IDEMPOTENT: re-run with the same config -> unchanged, no write", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    await installInvoicing(ctx)
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      invoicing: {
        issuerProfiles: [{ legalName: "Stable SAS", country: "FR", vatId: "FR99999999999" }],
      },
    }
    await invoicingProvisioner.apply(ctx, { actions: [] }, config)
    const before = await readIssuer(orgId, "Stable SAS")

    const result = await invoicingProvisioner.apply(ctx, { actions: [] }, config)
    const after = await readIssuer(orgId, "Stable SAS")
    expect(after).toEqual(before)
    expect(result.unchanged).toContain("invoicing.issuerProfiles.Stable SAS")
    expect(result.changed ?? []).not.toContain("invoicing.issuerProfiles.Stable SAS")
  })

  test("update path: a changed field re-writes only the supplied fields", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    await installInvoicing(ctx)
    const base: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      invoicing: {
        issuerProfiles: [
          { legalName: "Changing SAS", country: "FR", vatId: "FR11111111111", iban: "FR761234" },
        ],
      },
    }
    await invoicingProvisioner.apply(ctx, { actions: [] }, base)

    const updated: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      invoicing: {
        issuerProfiles: [{ legalName: "Changing SAS", country: "FR", vatId: "FR22222222222" }],
      },
    }
    const result = await invoicingProvisioner.apply(ctx, { actions: [] }, updated)
    const row = await readIssuer(orgId, "Changing SAS")
    expect(row?.vat_id).toBe("FR22222222222")
    // iban was not supplied in the update -> preserved from the existing row.
    expect(row?.iban).toBe("FR761234")
    expect(result.changed).toContain("invoicing.issuerProfiles.Changing SAS")
  })

  test("shopifyShop 'auto' resolves the org's active shopify connection identifier", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    await installInvoicing(ctx)
    await seedShopifyConnection(orgId, "acme-test.myshopify.com")

    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      invoicing: {
        issuerProfiles: [{ legalName: "Auto Mapped SAS", country: "FR", shopifyShop: "auto" }],
      },
    }
    const result = await invoicingProvisioner.apply(ctx, { actions: [] }, config)
    const row = await readIssuer(orgId, "Auto Mapped SAS")
    expect(row?.shopify_shop_id).toBe("acme-test.myshopify.com")
    expect(result.pending ?? []).toHaveLength(0)
    const section = result.section as {
      issuerProfiles: Array<{ shopifyMapping?: string }>
    }
    expect(section.issuerProfiles[0]?.shopifyMapping).toBe("set")
  })

  test("shopifyShop 'auto' with no shopify connection -> pending, not a hard failure", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    await installInvoicing(ctx)

    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      invoicing: {
        issuerProfiles: [{ legalName: "No Shopify SAS", country: "FR", shopifyShop: "auto" }],
      },
    }
    const result = await invoicingProvisioner.apply(ctx, { actions: [] }, config)
    const row = await readIssuer(orgId, "No Shopify SAS")
    expect(row?.shopify_shop_id ?? null).toBeNull()
    expect(result.pending ?? []).toHaveLength(1)
    expect(result.pending?.[0]?.kind).toBe("oauth")
    const section = result.section as {
      issuerProfiles: Array<{ shopifyMapping?: string }>
    }
    expect(section.issuerProfiles[0]?.shopifyMapping).toBe("pending")
  })

  test("explicit shopifyShop value sets shopify_shop_id verbatim", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    await installInvoicing(ctx)
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      invoicing: {
        issuerProfiles: [
          {
            legalName: "Explicit Shop SAS",
            country: "FR",
            shopifyShop: "explicit-shop.myshopify.com",
          },
        ],
      },
    }
    await invoicingProvisioner.apply(ctx, { actions: [] }, config)
    const row = await readIssuer(orgId, "Explicit Shop SAS")
    expect(row?.shopify_shop_id).toBe("explicit-shop.myshopify.com")
  })

  test("issuer identity fields are written, and a second apply is unchanged", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    await installInvoicing(ctx)
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      invoicing: {
        issuerProfiles: [
          {
            legalName: "Identity SAS",
            country: "FR",
            siren: "123456782",
            siret: "12345678200002",
            legalForm: "SAS",
            shareCapital: "10000",
            rcsCity: "Paris",
            vatOnDebits: true,
            routingAddress: "identity-routing",
            addressLine1: "1 Rue de la Paix",
            addressLine2: "Batiment B",
            postcode: "75001",
            city: "Paris",
            countryCode: "FR",
          },
        ],
      },
    }
    const r1 = await invoicingProvisioner.apply(ctx, { actions: [] }, config)
    expect(r1.changed).toContain("invoicing.issuerProfiles.Identity SAS")
    const row = await readIssuer(orgId, "Identity SAS")
    expect(row?.siren).toBe("123456782")
    expect(row?.siret).toBe("12345678200002")
    expect(row?.legal_form).toBe("SAS")
    expect(row?.share_capital).toBe("10000")
    expect(row?.rcs_city).toBe("Paris")
    expect(row?.vat_on_debits_default).toBe(true)
    expect(row?.routing_address).toBe("identity-routing")
    expect(row?.address_line1).toBe("1 Rue de la Paix")
    expect(row?.address_line2).toBe("Batiment B")
    expect(row?.postcode).toBe("75001")
    expect(row?.city).toBe("Paris")
    expect(row?.country_code).toBe("FR")

    const r2 = await invoicingProvisioner.apply(ctx, { actions: [] }, config)
    expect(r2.unchanged).toContain("invoicing.issuerProfiles.Identity SAS")
    expect(r2.changed ?? []).not.toContain("invoicing.issuerProfiles.Identity SAS")

    const changedConfig: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      invoicing: {
        issuerProfiles: [{ legalName: "Identity SAS", country: "FR", city: "Lyon" }],
      },
    }
    const r3 = await invoicingProvisioner.apply(ctx, { actions: [] }, changedConfig)
    expect(r3.changed).toContain("invoicing.issuerProfiles.Identity SAS")
    const after = await readIssuer(orgId, "Identity SAS")
    expect(after?.city).toBe("Lyon")
    expect(after?.siren).toBe("123456782")
  })

  async function readSettings(orgId: string): Promise<Record<string, unknown>[]> {
    const rows = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT * FROM ${drizzleSql.raw(`${schemaRef("app_invoicing")}.einvoicing_settings`)}
        WHERE org_id = ${orgId}::uuid
      `),
    )
    return extractRows(rows)
  }

  test("einvoicing section sets the gate mode once and a second apply is unchanged", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    await installInvoicing(ctx)
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      invoicing: { einvoicing: { gateMode: "enforce", cibsSwitchDate: "2027-01-01" } },
    }
    const plan = await invoicingProvisioner.plan(ctx, config)
    expect(plan.actions.join("\n")).toContain("e-invoicing settings")

    const r1 = await invoicingProvisioner.apply(ctx, { actions: [] }, config)
    expect(r1.changed).toContain("invoicing.einvoicing")
    const rows = await readSettings(orgId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.gate_mode).toBe("enforce")
    expect(rows[0]?.gate_mode_source).toBe("config")
    expect(rows[0]?.cibs_switch_date).toBe("2027-01-01")

    const r2 = await invoicingProvisioner.apply(ctx, { actions: [] }, config)
    expect(r2.unchanged).toContain("invoicing.einvoicing")
    expect(r2.changed ?? []).not.toContain("invoicing.einvoicing")
    expect(await readSettings(orgId)).toHaveLength(1)

    const r3 = await invoicingProvisioner.apply(
      ctx,
      { actions: [] },
      {
        org: { slug: "x", name: "X" },
        invoicing: { einvoicing: { gateMode: "warn" } },
      },
    )
    expect(r3.changed).toContain("invoicing.einvoicing")
    const after = await readSettings(orgId)
    expect(after).toHaveLength(1)
    expect(after[0]?.gate_mode).toBe("warn")
    expect(after[0]?.cibs_switch_date).toBe("2027-01-01")
  })

  test("einvoicing binding: provider validated, flags written, a change audited with an attention event, idempotent", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    await installInvoicing(ctx)
    // The default check reads the org's installed apps and their manifests.
    expect(await defaultContractProviderCheck(ctx, "pennylane")).toEqual({
      ok: false,
      reason: "pennylane is not installed for this organisation",
    })
    expect(await defaultContractProviderCheck(ctx, "invoicing")).toEqual({
      ok: false,
      reason: "invoicing does not implement e-invoicing (einvoicing-pa@1)",
    })
    const prov = createInvoicingProvisioner(undefined, async (_c, name) =>
      name === "pennylane"
        ? { ok: true }
        : { ok: false, reason: `${name} is not installed for this organisation` },
    )
    const base: ProvisioningConfig = { org: { slug: "x", name: "X" } }
    await expect(
      prov.apply(
        ctx,
        { actions: [] },
        { ...base, invoicing: { einvoicing: { gateMode: "enforce", providerApp: "nope" } } },
      ),
    ).rejects.toThrow(
      "invoicing.einvoicing.providerApp: nope is not installed for this organisation",
    )
    await expect(
      prov.apply(
        ctx,
        { actions: [] },
        { ...base, invoicing: { einvoicing: { gateMode: "enforce", sendEnabled: true } } },
      ),
    ).rejects.toThrow("need providerApp and cutoverDate")
    expect(await readSettings(orgId)).toHaveLength(0)

    const config: ProvisioningConfig = {
      ...base,
      invoicing: {
        einvoicing: {
          gateMode: "enforce",
          providerApp: "pennylane",
          cutoverDate: "2026-11-01",
          sendEnabled: false,
          bookEnabled: false,
        },
      },
    }
    const plan = await prov.plan(ctx, config)
    expect(plan.actions.join("\n")).toContain(
      "platform pennylane, cut-over 2026-11-01, sending off, booking off",
    )
    const r1 = await prov.apply(ctx, { actions: [] }, config)
    expect(r1.changed).toContain("invoicing.einvoicing")
    const [row] = await readSettings(orgId)
    expect(row).toMatchObject({
      provider_app: "pennylane",
      cutover_date: "2026-11-01",
      send_enabled: false,
      book_enabled: false,
    })
    const audits = async () =>
      extractRows<{ changes: unknown }>(
        await withPrivilegedDb(orgId, "t", (tx) =>
          tx.execute(
            drizzleSql`SELECT changes FROM kernel.audit_log WHERE org_id = ${orgId}::uuid AND action = 'einvoicing.binding_changed'`,
          ),
        ),
      )
    const events = async () =>
      extractRows<{ payload: Record<string, unknown> }>(
        await withPrivilegedDb(orgId, "t", (tx) =>
          tx.execute(
            drizzleSql`SELECT payload FROM kernel.pending_events WHERE org_id = ${orgId}::uuid AND payload->>'action' = 'binding_changed'`,
          ),
        ),
      )
    expect(await audits()).toEqual([{ changes: { provider_app: { from: null, to: "pennylane" } } }])
    const ev = await events()
    expect(ev).toHaveLength(1)
    expect(ev[0]!.payload).toMatchObject({
      app: "invoicing",
      entity: "einvoicing",
      data: { from: "none", to: "pennylane", source: "config" },
    })
    // The binding the kernel dispatches by is written in the kernel (no app can write it), audited.
    const { readKernelContractBinding } = await import("~/modules/apps/provider-contracts/binding")
    expect(await readKernelContractBinding(orgId, "einvoicing-pa@1", "invoicing")).toBe("pennylane")
    const kernelAudits = extractRows<{ changes: unknown }>(
      await withPrivilegedDb(orgId, "t", (tx) =>
        tx.execute(
          drizzleSql`SELECT changes FROM kernel.audit_log WHERE org_id = ${orgId}::uuid AND action = 'contract.binding_changed'`,
        ),
      ),
    )
    expect(kernelAudits).toEqual([
      { changes: { "einvoicing-pa@1:invoicing": { from: null, to: "pennylane" } } },
    ])

    const r2 = await prov.apply(ctx, { actions: [] }, config)
    expect(r2.unchanged).toContain("invoicing.einvoicing")
    expect(await audits()).toHaveLength(1)
    // Flags alone change nothing about the binding: no new audit row.
    const r3 = await prov.apply(
      ctx,
      { actions: [] },
      { ...base, invoicing: { einvoicing: { sendEnabled: true } } },
    )
    expect(r3.changed).toContain("invoicing.einvoicing")
    expect((await readSettings(orgId))[0]?.send_enabled).toBe(true)
    expect(await audits()).toHaveLength(1)
  })

  test("tax regime: fresh insert then idempotent re-run", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    await installInvoicing(ctx)
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      invoicing: {
        taxRegimes: [{ issuerCountry: "FR", treatment: "domestic", defaultRateBp: 2000 }],
      },
    }
    const r1 = await invoicingProvisioner.apply(ctx, { actions: [] }, config)
    expect(r1.changed).toContain("invoicing.taxRegimes.FR.domestic")

    const rows1 = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT * FROM ${drizzleSql.raw(`${schemaRef("app_invoicing")}.tax_regimes`)}
        WHERE org_id = ${orgId}::uuid AND issuer_country = 'FR' AND treatment = 'domestic'
      `),
    )
    expect(extractRows(rows1)).toHaveLength(1)

    const r2 = await invoicingProvisioner.apply(ctx, { actions: [] }, config)
    expect(r2.unchanged).toContain("invoicing.taxRegimes.FR.domestic")
    expect(r2.changed ?? []).not.toContain("invoicing.taxRegimes.FR.domestic")
  })

  test("hs code: fresh insert then idempotent re-run", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    await installInvoicing(ctx)
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      invoicing: {
        hsCodes: [{ code: "9207.10", description: "Instrument controllers" }],
      },
    }
    const r1 = await invoicingProvisioner.apply(ctx, { actions: [] }, config)
    expect(r1.changed).toContain("invoicing.hsCodes.9207.10")

    const r2 = await invoicingProvisioner.apply(ctx, { actions: [] }, config)
    expect(r2.unchanged).toContain("invoicing.hsCodes.9207.10")

    const rows = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT * FROM ${drizzleSql.raw(`${schemaRef("app_invoicing")}.hs_code_library`)}
        WHERE org_id = ${orgId}::uuid AND code = '9207.10'
      `),
    )
    expect(extractRows(rows)).toHaveLength(1)
  })

  test("no invoicing section -> no-op (no section, no writes)", async () => {
    const { ctx } = await freshOrgWithAdmin()
    const result = await invoicingProvisioner.apply(
      ctx,
      { actions: [] },
      { org: { slug: "x", name: "X" } },
    )
    expect(result.section).toBeUndefined()
    expect(result.changed).toBeUndefined()
  })

  describe("issuer profile logoPath", () => {
    test("fresh upload sets logo_file_id and reports action 'created'", async () => {
      const configDir = mkdtempSync(join(tmpdir(), "invoicing-logo-"))
      const logoFile = join(configDir, "logo.png")
      writeFileSync(logoFile, PNG_1X1)

      const { ctx, orgId } = await freshOrgWithAdmin(configDir)
      await installInvoicing(ctx)
      const deps = createFakeLogoDeps()
      const provisioner = createInvoicingProvisioner(deps)

      const config: ProvisioningConfig = {
        org: { slug: "x", name: "X" },
        invoicing: {
          issuerProfiles: [{ legalName: "Logo SAS", country: "FR", logoPath: "logo.png" }],
        },
      }
      const result = await provisioner.apply(ctx, { actions: [] }, config)

      const row = await readIssuer(orgId, "Logo SAS")
      expect(row?.logo_file_id).toBeTruthy()

      const fileRow = await readIssuerLogoFile(orgId, row?.logo_file_id as string)
      expect(fileRow?.mime_type).toBe("image/png")
      expect(Number(fileRow?.size_bytes)).toBe(PNG_1X1.byteLength)
      expect(fileRow?.app).toBe("invoicing")
      // Must match the invoicing manifest's `issuer_profile` fileParent (joinOn
      // issuer_profiles.id) — any other identity makes the kernel files routes
      // 404 the logo (Settings thumbnail, /api/files/:id/inline).
      expect(fileRow?.entity_type).toBe("issuer_profile")
      expect(fileRow?.entity_id).toBe(row?.id)
      expect((fileRow?.filename as string)?.startsWith("issuer-logo-")).toBe(true)

      const stored = deps.store.get(fileRow?.storage_key as string)
      expect(stored).toBeDefined()
      expect(Buffer.compare(stored as Buffer, PNG_1X1)).toBe(0)

      const section = result.section as { issuerProfiles: Array<{ logo?: string }> }
      expect(section.issuerProfiles[0]?.logo).toBe("created")
      expect(result.changed).toContain("invoicing.issuerProfiles.Logo SAS.logo")
    })

    test("IDEMPOTENT: re-run with the same file -> unchanged, no re-upload", async () => {
      const configDir = mkdtempSync(join(tmpdir(), "invoicing-logo-"))
      const logoFile = join(configDir, "logo.png")
      writeFileSync(logoFile, PNG_1X1)

      const { ctx, orgId } = await freshOrgWithAdmin(configDir)
      await installInvoicing(ctx)
      const deps = createFakeLogoDeps()
      const provisioner = createInvoicingProvisioner(deps)

      const config: ProvisioningConfig = {
        org: { slug: "x", name: "X" },
        invoicing: {
          issuerProfiles: [{ legalName: "Stable Logo SAS", country: "FR", logoPath: "logo.png" }],
        },
      }
      await provisioner.apply(ctx, { actions: [] }, config)
      const before = await readIssuer(orgId, "Stable Logo SAS")
      const storeSizeAfterFirst = deps.store.size

      const result = await provisioner.apply(ctx, { actions: [] }, config)
      const after = await readIssuer(orgId, "Stable Logo SAS")

      expect(after?.logo_file_id).toBe(before?.logo_file_id)
      expect(deps.store.size).toBe(storeSizeAfterFirst) // no new object uploaded

      const section = result.section as { issuerProfiles: Array<{ logo?: string }> }
      expect(section.issuerProfiles[0]?.logo).toBe("unchanged")
      expect(result.changed ?? []).not.toContain("invoicing.issuerProfiles.Stable Logo SAS.logo")
    })

    test("a changed logo file re-uploads and reports 'updated'", async () => {
      const configDir = mkdtempSync(join(tmpdir(), "invoicing-logo-"))
      const logoFile = join(configDir, "logo.png")
      writeFileSync(logoFile, PNG_1X1)

      const { ctx, orgId } = await freshOrgWithAdmin(configDir)
      await installInvoicing(ctx)
      const deps = createFakeLogoDeps()
      const provisioner = createInvoicingProvisioner(deps)

      const config: ProvisioningConfig = {
        org: { slug: "x", name: "X" },
        invoicing: {
          issuerProfiles: [{ legalName: "Changing Logo SAS", country: "FR", logoPath: "logo.png" }],
        },
      }
      await provisioner.apply(ctx, { actions: [] }, config)
      const before = await readIssuer(orgId, "Changing Logo SAS")

      // Overwrite with a different (still valid) PNG payload — same magic
      // bytes, different content, so size/byte compare must detect the diff.
      const differentPng = Buffer.concat([PNG_1X1, Buffer.from([0x00, 0x01, 0x02])])
      writeFileSync(logoFile, differentPng)

      const result = await provisioner.apply(ctx, { actions: [] }, config)
      const after = await readIssuer(orgId, "Changing Logo SAS")

      expect(after?.logo_file_id).not.toBe(before?.logo_file_id)
      const section = result.section as { issuerProfiles: Array<{ logo?: string }> }
      expect(section.issuerProfiles[0]?.logo).toBe("updated")
      expect(result.changed).toContain("invoicing.issuerProfiles.Changing Logo SAS.logo")
    })

    test("oversized file -> per-item logoError, run continues (profile still written)", async () => {
      const configDir = mkdtempSync(join(tmpdir(), "invoicing-logo-"))
      const logoFile = join(configDir, "logo.png")
      const oversized = Buffer.concat([PNG_1X1, Buffer.alloc(2 * 1024 * 1024 + 1, 0x41)])
      writeFileSync(logoFile, oversized)

      const { ctx, orgId } = await freshOrgWithAdmin(configDir)
      await installInvoicing(ctx)
      const deps = createFakeLogoDeps()
      const provisioner = createInvoicingProvisioner(deps)

      const config: ProvisioningConfig = {
        org: { slug: "x", name: "X" },
        invoicing: {
          issuerProfiles: [{ legalName: "Oversized SAS", country: "FR", logoPath: "logo.png" }],
        },
      }
      const result = await provisioner.apply(ctx, { actions: [] }, config)

      const row = await readIssuer(orgId, "Oversized SAS")
      expect(row).toBeDefined() // profile itself still created
      expect(row?.logo_file_id ?? null).toBeNull()
      expect(deps.store.size).toBe(0)

      const section = result.section as {
        issuerProfiles: Array<{ action: string; logoError?: string }>
      }
      expect(section.issuerProfiles[0]?.action).toBe("created")
      expect(section.issuerProfiles[0]?.logoError).toMatch(/exceeds the .* limit/)
    })

    test("corrupt (non-image) file -> per-item logoError, run continues", async () => {
      const configDir = mkdtempSync(join(tmpdir(), "invoicing-logo-"))
      const logoFile = join(configDir, "not-a-logo.png")
      writeFileSync(logoFile, NOT_AN_IMAGE)

      const { ctx, orgId } = await freshOrgWithAdmin(configDir)
      await installInvoicing(ctx)
      const deps = createFakeLogoDeps()
      const provisioner = createInvoicingProvisioner(deps)

      const config: ProvisioningConfig = {
        org: { slug: "x", name: "X" },
        invoicing: {
          issuerProfiles: [
            { legalName: "Corrupt Logo SAS", country: "FR", logoPath: "not-a-logo.png" },
          ],
        },
      }
      const result = await provisioner.apply(ctx, { actions: [] }, config)

      const row = await readIssuer(orgId, "Corrupt Logo SAS")
      expect(row).toBeDefined()
      expect(row?.logo_file_id ?? null).toBeNull()

      const section = result.section as {
        issuerProfiles: Array<{ action: string; logoError?: string }>
      }
      expect(section.issuerProfiles[0]?.action).toBe("created")
      expect(section.issuerProfiles[0]?.logoError).toMatch(/not a PNG or JPEG/)
    })

    test("missing file -> per-item logoError, run continues", async () => {
      const configDir = mkdtempSync(join(tmpdir(), "invoicing-logo-"))

      const { ctx, orgId } = await freshOrgWithAdmin(configDir)
      await installInvoicing(ctx)
      const deps = createFakeLogoDeps()
      const provisioner = createInvoicingProvisioner(deps)

      const config: ProvisioningConfig = {
        org: { slug: "x", name: "X" },
        invoicing: {
          issuerProfiles: [{ legalName: "Missing Logo SAS", country: "FR", logoPath: "nope.png" }],
        },
      }
      const result = await provisioner.apply(ctx, { actions: [] }, config)
      const row = await readIssuer(orgId, "Missing Logo SAS")
      expect(row).toBeDefined()

      const section = result.section as { issuerProfiles: Array<{ logoError?: string }> }
      expect(section.issuerProfiles[0]?.logoError).toMatch(/cannot be read/)
    })

    test("JPEG magic bytes accepted, stored with mime image/jpeg", async () => {
      const configDir = mkdtempSync(join(tmpdir(), "invoicing-logo-"))
      const logoFile = join(configDir, "logo.jpg")
      writeFileSync(logoFile, JPEG_MINIMAL)

      const { ctx, orgId } = await freshOrgWithAdmin(configDir)
      await installInvoicing(ctx)
      const deps = createFakeLogoDeps()
      const provisioner = createInvoicingProvisioner(deps)

      const config: ProvisioningConfig = {
        org: { slug: "x", name: "X" },
        invoicing: {
          issuerProfiles: [{ legalName: "Jpeg Logo SAS", country: "FR", logoPath: "logo.jpg" }],
        },
      }
      await provisioner.apply(ctx, { actions: [] }, config)
      const row = await readIssuer(orgId, "Jpeg Logo SAS")
      const fileRow = await readIssuerLogoFile(orgId, row?.logo_file_id as string)
      expect(fileRow?.mime_type).toBe("image/jpeg")
    })

    test("relative logoPath resolves against configDir; path traversal is rejected", async () => {
      const configDir = mkdtempSync(join(tmpdir(), "invoicing-logo-"))
      const subDir = join(configDir, "assets")
      mkdirSync(subDir, { recursive: true })
      writeFileSync(join(subDir, "logo.png"), PNG_1X1)

      const { ctx, orgId } = await freshOrgWithAdmin(configDir)
      await installInvoicing(ctx)
      const deps = createFakeLogoDeps()
      const provisioner = createInvoicingProvisioner(deps)

      const okConfig: ProvisioningConfig = {
        org: { slug: "x", name: "X" },
        invoicing: {
          issuerProfiles: [
            { legalName: "Relative Logo SAS", country: "FR", logoPath: "assets/logo.png" },
          ],
        },
      }
      const okResult = await provisioner.apply(ctx, { actions: [] }, okConfig)
      const okSection = okResult.section as { issuerProfiles: Array<{ logo?: string }> }
      expect(okSection.issuerProfiles[0]?.logo).toBe("created")

      const traversalConfig: ProvisioningConfig = {
        org: { slug: "x", name: "X" },
        invoicing: {
          issuerProfiles: [
            {
              legalName: "Traversal Logo SAS",
              country: "FR",
              logoPath: "../../../../../../etc/passwd",
            },
          ],
        },
      }
      const traversalResult = await provisioner.apply(ctx, { actions: [] }, traversalConfig)
      const row = await readIssuer(orgId, "Traversal Logo SAS")
      expect(row?.logo_file_id ?? null).toBeNull()
      const traversalSection = traversalResult.section as {
        issuerProfiles: Array<{ logoError?: string }>
      }
      expect(traversalSection.issuerProfiles[0]?.logoError).toMatch(
        /escapes the config file directory/,
      )
    })
  })
})
