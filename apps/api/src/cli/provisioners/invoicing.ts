// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Invoicing provisioner. Configures the `invoicing` bundled app's Postgres
 * config tables (`app_invoicing.issuer_profiles` / `tax_regimes` /
 * `hs_code_library`) so an operator can set up billing headlessly — typically
 * right after Shopify is connected, but standalone too.
 *
 * Runs LAST in the canonical order (after `apps`), so:
 *  - the `apps` provisioner has already installed + enabled `invoicing`
 *    (its `app_invoicing` schema exists) in the SAME apply, and
 *  - a Shopify connection provisioned earlier in the same `apps[]` list is
 *    already an active `connected_accounts` row when `shopifyShop: "auto"`
 *    resolves it.
 *
 * shopify_shop_id semantics (the auto-invoicing linchpin): the
 * `onShopifyOrderPaid` handler resolves the issuer via
 * `issuer_profiles.shopify_shop_id = <shop_id>`, where `shop_id` is the
 * Shopify shop DOMAIN (`adaptShopifyOrderCreatedEvent` sets
 * `shop_id: String(event.shopDomain ?? "")`, and the shopify webhook adapter
 * populates `shopDomain` from the `x-shopify-shop-domain` header — see
 * `bundled-apps/invoicing/src/handlers/shopify-order-paid.ts` and
 * `bundled-apps/shopify/src/webhooks.ts`). The shopify app manifest declares
 * `identifierVar: "shop"` for its connection, so `connected_accounts.identifier`
 * for an active `shopify` connection already holds that SAME normalized
 * `<slug>.myshopify.com` domain (`templateVars.shop.appendSuffix`) — so
 * `shopifyShop: "auto"` just copies `connected_accounts.identifier` onto
 * `issuer_profiles.shopify_shop_id`.
 *
 * Preflight: if `app_invoicing.issuer_profiles` does not exist (app not
 * installed/enabled — the `apps` provisioner must run first and enable
 * `invoicing`), the whole `invoicing` section fails with an actionable
 * `ConfigError` rather than a raw SQL error.
 *
 * Idempotency:
 *  - issuer profiles ensure-key on (org_id, legal_name): update the row's
 *    supplied fields if present, else insert with the same COUNTRY_DEFAULTS-
 *    style fallbacks the E2E test harness uses.
 *  - tax regimes ensure-key on (issuer_country, treatment) (the table's own
 *    unique constraint).
 *  - hs codes ensure-key on `code` (the table's own unique constraint).
 * A re-run with identical input writes nothing and reports `unchanged`.
 */
import { randomUUID } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { ConfigError } from "~/cli/config/parse"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { readActorFile, statActorFile } from "~/cli/provisioners/actor-file"
import type {
  PendingItem,
  ProvisionContext,
  Provisioner,
  ProvisionPlan,
  ProvisionResult,
} from "~/cli/provisioners/types"
import { extractRows } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import {
  getObjectBuffer as defaultGetObjectBuffer,
  putObject as defaultPutObject,
} from "~/infra/storage/object-storage"
import { withOpenFile } from "~/lib/read-checked-file"
import { buildStorageKey } from "~/modules/files/service"

function invRel(name: string): ReturnType<typeof drizzleSql.raw> {
  return drizzleSql.raw(`${schemaRef("app_invoicing")}.${name}`)
}

function kernelRel(name: string): ReturnType<typeof drizzleSql.raw> {
  return drizzleSql.raw(`${schemaRef("kernel")}.${name}`)
}

const MAX_LOGO_BYTES = 2 * 1024 * 1024
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])

/** Injectable seams for the logo upload path — object storage + read/stat are
 *  swappable so the provisioner test doesn't need a real S3-compatible
 *  backend. Defaults wire the production storage helpers. */
export interface InvoicingLogoDeps {
  putObject: typeof defaultPutObject
  getObjectBuffer: typeof defaultGetObjectBuffer
}

const defaultLogoDeps: InvoicingLogoDeps = {
  putObject: defaultPutObject,
  getObjectBuffer: defaultGetObjectBuffer,
}

/** Resolve a config `logoPath` against the config dir, rejecting any path
 *  that escapes that dir (absolute paths or `../` traversal) — same
 *  discipline as `knowledge.documents[].contentFile`. Returns the safe
 *  absolute path, or throws a plain `Error` (caught by the caller and
 *  surfaced as a per-item `logoError`, never a hard apply failure). */
function resolveLocalFile(configDir: string, logoPath: string): string {
  if (isAbsolute(logoPath)) {
    throw new Error(
      `logoPath '${logoPath}' must be a path relative to the config file directory (absolute paths are rejected)`,
    )
  }
  const base = resolve(configDir)
  const target = resolve(base, logoPath)
  const rel = relative(base, target)
  if (
    rel === ".." ||
    rel.startsWith(`..${"/"}`) ||
    rel.startsWith(`..${"\\"}`) ||
    isAbsolute(rel)
  ) {
    throw new Error(
      `logoPath '${logoPath}' escapes the config file directory (path traversal rejected)`,
    )
  }
  return target
}

/** Sniff the mime type from magic bytes. Returns `null` for anything that
 *  isn't PNG or JPEG. */
function detectImageMime(bytes: Buffer): "image/png" | "image/jpeg" | null {
  if (bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return "image/png"
  if (bytes.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) return "image/jpeg"
  return null
}

/** Read + validate a logo file: exists, <= 2MB, PNG/JPEG magic bytes. Throws
 *  a plain `Error` with a clear message on any failure — the caller catches
 *  it and reports `logoError` instead of aborting the whole apply run. */
/** Where a logo's bytes come from: a file next to the config (CLI), or a
 *  file already uploaded to the org, read under the actor's own access. */
type LogoSource = { path: string } | { fileId: string }

async function readLogoSource(
  ctx: ProvisionContext,
  source: LogoSource,
): Promise<{ bytes: Buffer; mime: "image/png" | "image/jpeg" }> {
  if ("path" in source) return readAndValidateLogo(ctx.configDir, source.path)
  const file = await readActorFile(ctx, source.fileId, {
    what: `logoFileId '${source.fileId}'`,
    maxBytes: MAX_LOGO_BYTES,
  })
  const mime = detectImageMime(file.bytes)
  if (!mime) {
    throw new Error(
      `logoFileId '${source.fileId}' is not a PNG or JPEG file (magic bytes did not match)`,
    )
  }
  return { bytes: file.bytes, mime }
}

async function readAndValidateLogo(
  configDir: string,
  logoPath: string,
): Promise<{ bytes: Buffer; mime: "image/png" | "image/jpeg" }> {
  const path = resolveLocalFile(configDir, logoPath)
  // Checked and read through one descriptor: the file checked is the file read.
  let opened = false
  let bytes: Buffer
  try {
    bytes = await withOpenFile(path, (st, read) => {
      opened = true
      if (!st.isFile()) {
        throw new Error(`logoPath '${logoPath}' is not a regular file`)
      }
      if (st.size > MAX_LOGO_BYTES) {
        throw new Error(
          `logoPath '${logoPath}' is ${st.size} bytes, exceeds the ${MAX_LOGO_BYTES}-byte (2 MB) limit`,
        )
      }
      return read()
    })
  } catch (err) {
    if (opened) throw err
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`logoPath '${logoPath}' cannot be read: ${reason}`)
  }
  const mime = detectImageMime(bytes)
  if (!mime) {
    throw new Error(`logoPath '${logoPath}' is not a PNG or JPEG file (magic bytes did not match)`)
  }
  return { bytes, mime }
}

/** slug a legal name into a filesystem/URL-safe fragment for the stored
 *  filename, e.g. "Acme SAS" -> "acme-sas". */
function slugifyLegalName(legalName: string): string {
  return (
    legalName
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "issuer"
  )
}

/**
 * Ensure the issuer profile's logo matches `logoPath` (a local file). Mirrors
 * the PDF renderer's kernel.files write mechanism
 * (`modules/pdf/render.ts`): object storage `putObject` + a `kernel.files`
 * row insert, org-scoped, under `ctx.priv`.
 *
 * Idempotency: `kernel.files` has no checksum column, so identity is decided
 * by (a) a fast-path size compare against the existing file row, then (b) a
 * full byte compare against the stored object if the size matches. Matching
 * on both → "unchanged", no upload, no write. Any read/validation error is
 * caught by the caller and reported as `logoError` rather than thrown.
 */
async function ensureIssuerLogo(
  ctx: ProvisionContext,
  legalName: string,
  source: LogoSource,
  issuerId: string,
  existingLogoFileId: string | null,
  deps: InvoicingLogoDeps,
): Promise<"created" | "updated" | "unchanged"> {
  const { bytes, mime } = await readLogoSource(ctx, source)

  if (existingLogoFileId) {
    const existingFileRows = await ctx.priv("cli-invoicing-logo-file-read", (tx) =>
      tx.execute(drizzleSql`
        SELECT storage_key, size_bytes FROM ${kernelRel("files")}
        WHERE id = ${existingLogoFileId}::uuid AND org_id = ${ctx.orgId}::uuid
        LIMIT 1
      `),
    )
    const existingFile = extractRows<{ storage_key: string; size_bytes: number }>(
      existingFileRows,
    )[0]
    if (existingFile && Number(existingFile.size_bytes) === bytes.byteLength) {
      const stored = await deps.getObjectBuffer(existingFile.storage_key)
      if (Buffer.compare(stored, bytes) === 0) {
        ctx.log(`invoicing: issuer profile '${legalName}' logo already up to date`)
        return "unchanged"
      }
    }
  }

  const fileId = randomUUID()
  const filename = `issuer-logo-${slugifyLegalName(legalName)}.${mime === "image/png" ? "png" : "jpg"}`
  // entity_type/entity_id MUST match the invoicing manifest's `issuer_profile`
  // fileParent (joinOn issuer_profiles.id) — that registration is what lets the
  // kernel files routes authorize reads, so the Settings thumbnail (and any
  // /api/files/:id/inline fetch) 404s on any other identity.
  const storageKey = buildStorageKey({
    orgId: ctx.orgId,
    app: "invoicing",
    entityType: "issuer_profile",
    entityId: issuerId,
    filename,
  })

  await deps.putObject({ key: storageKey, body: bytes, contentType: mime })

  await ctx.priv("cli-invoicing-logo-file-insert", (tx) =>
    tx.execute(drizzleSql`
      INSERT INTO ${kernelRel("files")}
        (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key, uploaded_by)
      VALUES (${fileId}::uuid, ${ctx.orgId}::uuid, 'invoicing', 'issuer_profile', ${issuerId}, ${filename},
              ${mime}, ${bytes.byteLength}, ${storageKey}, NULL)
    `),
  )

  await ctx.priv("cli-invoicing-issuer-logo-link", (tx) =>
    tx.execute(drizzleSql`
      UPDATE ${invRel("issuer_profiles")}
      SET logo_file_id = ${fileId}::uuid
      WHERE id = ${issuerId}::uuid
    `),
  )

  ctx.log(
    `invoicing: issuer profile '${legalName}' logo ${existingLogoFileId ? "updated" : "created"}`,
  )
  return existingLogoFileId ? "updated" : "created"
}

/** Per-country fallback defaults, mirroring the E2E install harness's
 *  COUNTRY_DEFAULTS shape (`apps/api/test-support/harness/invoicing-install-routes.ts`)
 *  so a minimal config (just legalName + country) still inserts a sane row. A
 *  country outside this table falls back to the generic defaults below. */
const COUNTRY_DEFAULTS: Record<
  string,
  { defaultCurrency: string; defaultLanguage: "en" | "fr" | "de" }
> = {
  FR: { defaultCurrency: "EUR", defaultLanguage: "fr" },
  DE: { defaultCurrency: "EUR", defaultLanguage: "de" },
  GB: { defaultCurrency: "GBP", defaultLanguage: "en" },
  US: { defaultCurrency: "USD", defaultLanguage: "en" },
}

interface IssuerProfileResult {
  legalName: string
  country: string
  action: "created" | "updated" | "unchanged"
  shopifyMapping?: "set" | "unchanged" | "pending"
  /** Present when `logoPath` was supplied. Never fatal — a bad/oversized/
   *  unreadable logo file is reported as `logoError` and leaves any existing
   *  `logo_file_id` untouched; it does not fail the whole apply run. */
  logo?: "created" | "updated" | "unchanged"
  logoError?: string
}

interface TaxRegimeResult {
  issuerCountry: string
  treatment: string
  action: "created" | "updated" | "unchanged"
}

interface HsCodeResult {
  code: string
  action: "created" | "updated" | "unchanged"
}

interface InvoicingSection {
  issuerProfiles: IssuerProfileResult[]
  taxRegimes: TaxRegimeResult[]
  hsCodes: HsCodeResult[]
  einvoicing?: EinvoicingResult
}

async function preflightSchema(ctx: ProvisionContext): Promise<void> {
  const invSchema = schemaRef("app_invoicing")
  const rows = await ctx.sys("cli-invoicing-preflight", (db) =>
    db.execute(drizzleSql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${invSchema} AND table_name = 'issuer_profiles'
    `),
  )
  if (extractRows(rows).length === 0) {
    throw new ConfigError(
      "invoicing: app_invoicing.issuer_profiles does not exist — enable the invoicing app " +
        "first (add `{ name: invoicing, enable: true }` to the `apps` section) and re-run",
    )
  }
}

/** Resolve `shopifyShop: "auto"` against the org's active shopify connection.
 *  Returns the shop domain to write, or `null` when none is active yet
 *  (reported as `pending`, never a hard failure). */
async function resolveAutoShopifyShop(
  ctx: ProvisionContext,
): Promise<{ shopId: string } | { pending: true }> {
  const rows = await ctx.priv("cli-invoicing-shopify-lookup", (tx) =>
    tx.execute(drizzleSql`
      SELECT identifier FROM ${kernelRel("connected_accounts")}
      WHERE org_id = ${ctx.orgId}::uuid AND app_name = 'shopify' AND status = 'active'
      ORDER BY created_at ASC
      LIMIT 1
    `),
  )
  const row = extractRows<{ identifier: string }>(rows)[0]
  if (!row) return { pending: true }
  return { shopId: row.identifier }
}

async function ensureIssuerProfile(
  ctx: ProvisionContext,
  cfg: NonNullable<NonNullable<ProvisioningConfig["invoicing"]>["issuerProfiles"]>[number],
  changed: string[],
  unchanged: string[],
  pending: PendingItem[],
  logoDeps: InvoicingLogoDeps = defaultLogoDeps,
  /** Compute the action (created / updated / unchanged) and write nothing. */
  planOnly = false,
): Promise<IssuerProfileResult> {
  const existingRows = await ctx.priv("cli-invoicing-issuer-read", (tx) =>
    tx.execute(drizzleSql`
      SELECT id, country, vat_id, tax_registration_id, address, iban, swift_bic, bank_name,
             default_currency, default_language, default_payment_terms_days,
             auto_email_enabled, invoice_approval_threshold_minor, shopify_shop_id, logo_file_id,
             siren, siret, legal_form, share_capital, rcs_city, vat_on_debits_default,
             routing_address, address_line1, address_line2, postcode, city, country_code
      FROM ${invRel("issuer_profiles")}
      WHERE org_id = ${ctx.orgId}::uuid AND legal_name = ${cfg.legalName}
      LIMIT 1
    `),
  )
  const existing = extractRows<{
    id: string
    country: string
    vat_id: string | null
    tax_registration_id: string | null
    address: string | null
    iban: string | null
    swift_bic: string | null
    bank_name: string | null
    default_currency: string
    default_language: string
    default_payment_terms_days: number
    auto_email_enabled: boolean
    invoice_approval_threshold_minor: string | null
    shopify_shop_id: string | null
    logo_file_id: string | null
    siren: string | null
    siret: string | null
    legal_form: string | null
    share_capital: string | null
    rcs_city: string | null
    vat_on_debits_default: boolean | null
    routing_address: string | null
    address_line1: string | null
    address_line2: string | null
    postcode: string | null
    city: string | null
    country_code: string | null
  }>(existingRows)[0]

  const defaults = COUNTRY_DEFAULTS[cfg.country] ?? {
    defaultCurrency: "EUR",
    defaultLanguage: "en" as const,
  }
  const defaultCurrency =
    cfg.defaultCurrency ?? existing?.default_currency ?? defaults.defaultCurrency
  const defaultLanguage =
    cfg.defaultLanguage ??
    (existing?.default_language as "en" | "fr" | "de" | undefined) ??
    defaults.defaultLanguage
  const paymentTermsDays = cfg.paymentTermsDays ?? existing?.default_payment_terms_days ?? 30
  const autoEmail = cfg.autoEmail ?? existing?.auto_email_enabled ?? false
  const vatId = cfg.vatId ?? existing?.vat_id ?? null
  const taxRegistrationId = cfg.taxRegistrationId ?? existing?.tax_registration_id ?? null
  const address = cfg.address ?? existing?.address ?? null
  const iban = cfg.iban ?? existing?.iban ?? null
  const swiftBic = cfg.swiftBic ?? existing?.swift_bic ?? null
  const bankName = cfg.bankName ?? existing?.bank_name ?? null
  const siren = cfg.siren ?? existing?.siren ?? null
  const siret = cfg.siret ?? existing?.siret ?? null
  const legalForm = cfg.legalForm ?? existing?.legal_form ?? null
  const shareCapital = cfg.shareCapital ?? existing?.share_capital ?? null
  const rcsCity = cfg.rcsCity ?? existing?.rcs_city ?? null
  const vatOnDebits = cfg.vatOnDebits ?? existing?.vat_on_debits_default ?? null
  const routingAddress = cfg.routingAddress ?? existing?.routing_address ?? null
  const addressLine1 = cfg.addressLine1 ?? existing?.address_line1 ?? null
  const addressLine2 = cfg.addressLine2 ?? existing?.address_line2 ?? null
  const postcode = cfg.postcode ?? existing?.postcode ?? null
  const city = cfg.city ?? existing?.city ?? null
  const countryCode = cfg.countryCode ?? existing?.country_code ?? null
  const threshold =
    cfg.invoiceApprovalThresholdMinor !== undefined
      ? cfg.invoiceApprovalThresholdMinor
      : (existing?.invoice_approval_threshold_minor ?? null)

  // Resolve the shopify mapping intent BEFORE the diff so it's included in the
  // unchanged/changed comparison.
  let shopifyShopId: string | null | undefined = existing?.shopify_shop_id ?? null
  let shopifyMapping: IssuerProfileResult["shopifyMapping"]
  if (cfg.shopifyShop === "auto") {
    const resolved = await resolveAutoShopifyShop(ctx)
    if ("pending" in resolved) {
      shopifyMapping = "pending"
      pending.push({
        kind: "oauth",
        app: "invoicing",
        connection: "shopify-shop-mapping",
        action:
          "connect shopify (liaison connect shopify/shop or config apply with apps.shopify.connection), then re-run config apply",
        message: `Issuer '${cfg.legalName}' awaits a Shopify shop mapping — no active shopify connection found for the org yet.`,
      })
      // Do not touch shopify_shop_id — leave whatever is stored (nothing on insert).
      shopifyShopId = existing?.shopify_shop_id ?? null
    } else {
      shopifyShopId = resolved.shopId
      shopifyMapping = existing?.shopify_shop_id === resolved.shopId ? "unchanged" : "set"
    }
  } else if (cfg.shopifyShop !== undefined && cfg.shopifyShop !== null) {
    shopifyShopId = cfg.shopifyShop
    shopifyMapping = existing?.shopify_shop_id === cfg.shopifyShop ? "unchanged" : "set"
  } else {
    // omitted/null → no mapping intent; leave existing value untouched.
    shopifyShopId = existing?.shopify_shop_id ?? null
  }

  if (existing) {
    const isUnchanged =
      existing.country === cfg.country &&
      existing.vat_id === vatId &&
      existing.tax_registration_id === taxRegistrationId &&
      existing.address === address &&
      existing.iban === iban &&
      existing.swift_bic === swiftBic &&
      existing.bank_name === bankName &&
      existing.default_currency === defaultCurrency &&
      existing.default_language === defaultLanguage &&
      existing.default_payment_terms_days === paymentTermsDays &&
      existing.auto_email_enabled === autoEmail &&
      String(existing.invoice_approval_threshold_minor ?? "") === String(threshold ?? "") &&
      (existing.shopify_shop_id ?? null) === (shopifyShopId ?? null) &&
      existing.siren === siren &&
      existing.siret === siret &&
      existing.legal_form === legalForm &&
      existing.share_capital === shareCapital &&
      existing.rcs_city === rcsCity &&
      (existing.vat_on_debits_default ?? null) === vatOnDebits &&
      existing.routing_address === routingAddress &&
      existing.address_line1 === addressLine1 &&
      existing.address_line2 === addressLine2 &&
      existing.postcode === postcode &&
      existing.city === city &&
      existing.country_code === countryCode

    if (planOnly) {
      return {
        legalName: cfg.legalName,
        country: cfg.country,
        action: isUnchanged ? "unchanged" : "updated",
      }
    }
    if (isUnchanged) {
      ctx.log(`invoicing: issuer profile '${cfg.legalName}' already up to date`)
      unchanged.push(`invoicing.issuerProfiles.${cfg.legalName}`)
      const logoResult = await applyLogoIfConfigured(
        ctx,
        cfg,
        existing.id,
        existing.logo_file_id,
        changed,
        logoDeps,
      )
      return {
        legalName: cfg.legalName,
        country: cfg.country,
        action: "unchanged",
        ...(shopifyMapping ? { shopifyMapping } : {}),
        ...logoResult,
      }
    }

    await ctx.priv("cli-invoicing-issuer-update", (tx) =>
      tx.execute(drizzleSql`
        UPDATE ${invRel("issuer_profiles")}
        SET country = ${cfg.country},
            vat_id = ${vatId},
            tax_registration_id = ${taxRegistrationId},
            address = ${address},
            iban = ${iban},
            swift_bic = ${swiftBic},
            bank_name = ${bankName},
            default_currency = ${defaultCurrency},
            default_language = ${defaultLanguage},
            default_payment_terms_days = ${paymentTermsDays},
            auto_email_enabled = ${autoEmail},
            invoice_approval_threshold_minor = ${threshold},
            shopify_shop_id = ${shopifyShopId},
            siren = ${siren},
            siret = ${siret},
            legal_form = ${legalForm},
            share_capital = ${shareCapital},
            rcs_city = ${rcsCity},
            vat_on_debits_default = ${vatOnDebits},
            routing_address = ${routingAddress},
            address_line1 = ${addressLine1},
            address_line2 = ${addressLine2},
            postcode = ${postcode},
            city = ${city},
            country_code = ${countryCode}
        WHERE id = ${existing.id}::uuid
      `),
    )
    ctx.log(`invoicing: issuer profile '${cfg.legalName}' updated`)
    changed.push(`invoicing.issuerProfiles.${cfg.legalName}`)
    const logoResult = await applyLogoIfConfigured(
      ctx,
      cfg,
      existing.id,
      existing.logo_file_id,
      changed,
      logoDeps,
    )
    return {
      legalName: cfg.legalName,
      country: cfg.country,
      action: "updated",
      ...(shopifyMapping ? { shopifyMapping } : {}),
      ...logoResult,
    }
  }

  if (planOnly) return { legalName: cfg.legalName, country: cfg.country, action: "created" }
  const insertedRows = await ctx.priv("cli-invoicing-issuer-insert", (tx) =>
    tx.execute(drizzleSql`
      INSERT INTO ${invRel("issuer_profiles")}
        (org_id, legal_name, country, vat_id, tax_registration_id, address, iban,
         swift_bic, bank_name, default_currency, default_language,
         default_payment_terms_days, auto_email_enabled,
         invoice_approval_threshold_minor, shopify_shop_id,
         siren, siret, legal_form, share_capital, rcs_city, vat_on_debits_default,
         routing_address, address_line1, address_line2, postcode, city, country_code)
      VALUES (${ctx.orgId}::uuid, ${cfg.legalName}, ${cfg.country}, ${vatId}, ${taxRegistrationId},
              ${address}, ${iban}, ${swiftBic}, ${bankName}, ${defaultCurrency}, ${defaultLanguage},
              ${paymentTermsDays}, ${autoEmail}, ${threshold}, ${shopifyShopId},
              ${siren}, ${siret}, ${legalForm}, ${shareCapital}, ${rcsCity}, ${vatOnDebits},
              ${routingAddress}, ${addressLine1}, ${addressLine2}, ${postcode}, ${city},
              ${countryCode})
      RETURNING id
    `),
  )
  const insertedId = extractRows<{ id: string }>(insertedRows)[0]?.id
  ctx.log(`invoicing: issuer profile '${cfg.legalName}' created`)
  changed.push(`invoicing.issuerProfiles.${cfg.legalName}`)
  const logoResult = insertedId
    ? await applyLogoIfConfigured(ctx, cfg, insertedId, null, changed, logoDeps)
    : {}
  return {
    legalName: cfg.legalName,
    country: cfg.country,
    action: "created",
    ...(shopifyMapping ? { shopifyMapping } : {}),
    ...logoResult,
  }
}

/** Apply `cfg.logoPath` (if present) against the issuer row `issuerId`. Never
 *  throws — catches any validation/upload error and returns `logoError`
 *  instead, so a bad logo file never fails the whole `invoicing` section. */
async function applyLogoIfConfigured(
  ctx: ProvisionContext,
  cfg: { legalName: string; logoPath?: string; logoFileId?: string },
  issuerId: string,
  existingLogoFileId: string | null,
  changed: string[],
  logoDeps: InvoicingLogoDeps,
): Promise<Pick<IssuerProfileResult, "logo" | "logoError">> {
  const source: LogoSource | null = cfg.logoFileId
    ? { fileId: cfg.logoFileId }
    : cfg.logoPath
      ? { path: cfg.logoPath }
      : null
  if (!source) return {}
  try {
    const logoAction = await ensureIssuerLogo(
      ctx,
      cfg.legalName,
      source,
      issuerId,
      existingLogoFileId,
      logoDeps,
    )
    if (logoAction !== "unchanged") {
      changed.push(`invoicing.issuerProfiles.${cfg.legalName}.logo`)
    }
    return { logo: logoAction }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.log(`invoicing: issuer profile '${cfg.legalName}' logo error: ${reason}`)
    return { logoError: reason }
  }
}

async function ensureTaxRegime(
  ctx: ProvisionContext,
  cfg: NonNullable<NonNullable<ProvisioningConfig["invoicing"]>["taxRegimes"]>[number],
  changed: string[],
  unchanged: string[],
): Promise<TaxRegimeResult> {
  const existingRows = await ctx.priv("cli-invoicing-taxregime-read", (tx) =>
    tx.execute(drizzleSql`
      SELECT id, default_rate_bp, legal_mention_template_en, legal_mention_template_fr,
             legal_mention_template_de, requires_hs_code
      FROM ${invRel("tax_regimes")}
      WHERE org_id = ${ctx.orgId}::uuid AND issuer_country = ${cfg.issuerCountry} AND treatment = ${cfg.treatment}
      LIMIT 1
    `),
  )
  const existing = extractRows<{
    id: string
    default_rate_bp: number
    legal_mention_template_en: string | null
    legal_mention_template_fr: string | null
    legal_mention_template_de: string | null
    requires_hs_code: boolean
  }>(existingRows)[0]

  const legalMentionEn = cfg.legalMentionTemplateEn ?? existing?.legal_mention_template_en ?? null
  const legalMentionFr = cfg.legalMentionTemplateFr ?? existing?.legal_mention_template_fr ?? null
  const legalMentionDe = cfg.legalMentionTemplateDe ?? existing?.legal_mention_template_de ?? null
  const requiresHsCode = cfg.requiresHsCode ?? existing?.requires_hs_code ?? false

  if (existing) {
    const isUnchanged =
      existing.default_rate_bp === cfg.defaultRateBp &&
      existing.legal_mention_template_en === legalMentionEn &&
      existing.legal_mention_template_fr === legalMentionFr &&
      existing.legal_mention_template_de === legalMentionDe &&
      existing.requires_hs_code === requiresHsCode

    if (isUnchanged) {
      ctx.log(`invoicing: tax regime '${cfg.issuerCountry}/${cfg.treatment}' already up to date`)
      unchanged.push(`invoicing.taxRegimes.${cfg.issuerCountry}.${cfg.treatment}`)
      return { issuerCountry: cfg.issuerCountry, treatment: cfg.treatment, action: "unchanged" }
    }

    await ctx.priv("cli-invoicing-taxregime-update", (tx) =>
      tx.execute(drizzleSql`
        UPDATE ${invRel("tax_regimes")}
        SET default_rate_bp = ${cfg.defaultRateBp},
            legal_mention_template_en = ${legalMentionEn},
            legal_mention_template_fr = ${legalMentionFr},
            legal_mention_template_de = ${legalMentionDe},
            requires_hs_code = ${requiresHsCode}
        WHERE id = ${existing.id}::uuid
      `),
    )
    ctx.log(`invoicing: tax regime '${cfg.issuerCountry}/${cfg.treatment}' updated`)
    changed.push(`invoicing.taxRegimes.${cfg.issuerCountry}.${cfg.treatment}`)
    return { issuerCountry: cfg.issuerCountry, treatment: cfg.treatment, action: "updated" }
  }

  await ctx.priv("cli-invoicing-taxregime-insert", (tx) =>
    tx.execute(drizzleSql`
      INSERT INTO ${invRel("tax_regimes")}
        (org_id, issuer_country, treatment, default_rate_bp, legal_mention_template_en,
         legal_mention_template_fr, legal_mention_template_de, requires_hs_code)
      VALUES (${ctx.orgId}::uuid, ${cfg.issuerCountry}, ${cfg.treatment}, ${cfg.defaultRateBp},
              ${legalMentionEn}, ${legalMentionFr}, ${legalMentionDe}, ${requiresHsCode})
    `),
  )
  ctx.log(`invoicing: tax regime '${cfg.issuerCountry}/${cfg.treatment}' created`)
  changed.push(`invoicing.taxRegimes.${cfg.issuerCountry}.${cfg.treatment}`)
  return { issuerCountry: cfg.issuerCountry, treatment: cfg.treatment, action: "created" }
}

async function ensureHsCode(
  ctx: ProvisionContext,
  cfg: NonNullable<NonNullable<ProvisioningConfig["invoicing"]>["hsCodes"]>[number],
  changed: string[],
  unchanged: string[],
): Promise<HsCodeResult> {
  const existingRows = await ctx.priv("cli-invoicing-hscode-read", (tx) =>
    tx.execute(drizzleSql`
      SELECT id, description FROM ${invRel("hs_code_library")}
      WHERE org_id = ${ctx.orgId}::uuid AND code = ${cfg.code}
      LIMIT 1
    `),
  )
  const existing = extractRows<{ id: string; description: string | null }>(existingRows)[0]
  const description = cfg.description ?? existing?.description ?? null

  if (existing) {
    if ((existing.description ?? null) === description) {
      ctx.log(`invoicing: hs code '${cfg.code}' already up to date`)
      unchanged.push(`invoicing.hsCodes.${cfg.code}`)
      return { code: cfg.code, action: "unchanged" }
    }
    await ctx.priv("cli-invoicing-hscode-update", (tx) =>
      tx.execute(drizzleSql`
        UPDATE ${invRel("hs_code_library")} SET description = ${description} WHERE id = ${existing.id}::uuid
      `),
    )
    ctx.log(`invoicing: hs code '${cfg.code}' updated`)
    changed.push(`invoicing.hsCodes.${cfg.code}`)
    return { code: cfg.code, action: "updated" }
  }

  await ctx.priv("cli-invoicing-hscode-insert", (tx) =>
    tx.execute(drizzleSql`
      INSERT INTO ${invRel("hs_code_library")} (org_id, code, description)
      VALUES (${ctx.orgId}::uuid, ${cfg.code}, ${description})
    `),
  )
  ctx.log(`invoicing: hs code '${cfg.code}' created`)
  changed.push(`invoicing.hsCodes.${cfg.code}`)
  return { code: cfg.code, action: "created" }
}

interface EinvoicingResult {
  action: "created" | "updated" | "unchanged"
  gateMode: string
  cibsSwitchDate: string | null
  providerApp: string | null
  cutoverDate: string | null
  sendEnabled: boolean
  bookEnabled: boolean
}

/**
 * Whether `appName` is installed and active for the org at a version whose manifest implements
 * `einvoicing-pa@1` (a provider contract). Injectable for tests; the default reads the org's app
 * row, the active version, and that version's installed manifest.
 */
export type ContractProviderCheck = (
  ctx: ProvisionContext,
  appName: string,
) => Promise<{ ok: true } | { ok: false; reason: string }>

export const defaultContractProviderCheck: ContractProviderCheck = async (ctx, appName) => {
  const rows = await ctx.priv("cli-invoicing-provider-app", (tx) =>
    tx.execute(drizzleSql`
      SELECT a.status, v.version
      FROM ${drizzleSql.raw(`"${schemaRef("kernel")}".apps`)} a
      LEFT JOIN ${drizzleSql.raw(`"${schemaRef("kernel")}".apps_active_version`)} v ON v.name = a.name
      WHERE a.org_id = ${ctx.orgId}::uuid AND a.name = ${appName}
      LIMIT 1
    `),
  )
  const row = extractRows<{ status: string; version: string | null }>(rows)[0]
  if (!row) return { ok: false, reason: `${appName} is not installed for this organisation` }
  if (row.status !== "active")
    return { ok: false, reason: `${appName} is installed but ${row.status}` }
  const { discoverInstalledApps } = await import("~/modules/apps/discover-apps")
  const paths = (await discoverInstalledApps())
    .filter((a) => a.name === appName && (!row.version || a.version === row.version))
    .map((a) => a.manifestPath)
  // A development checkout runs bundled apps from source: their manifest sits in the repo.
  const fromSource = resolve(
    import.meta.dir,
    "..",
    "..",
    "..",
    "..",
    "..",
    "bundled-apps",
    appName,
    "app.manifest.json",
  )
  if (paths.length === 0 && (await stat(fromSource).catch(() => null))) paths.push(fromSource)
  for (const path of paths) {
    const manifest = JSON.parse(await readFile(path, "utf8")) as {
      implements?: Array<{ contract?: string; version?: number }>
    }
    if ((manifest.implements ?? []).some((i) => i.contract === "einvoicing-pa" && i.version === 1))
      return { ok: true }
  }
  return { ok: false, reason: `${appName} does not implement e-invoicing (einvoicing-pa@1)` }
}

/** Upsert the organisation's single `einvoicing_settings` row. A field left out
 *  of the config keeps its stored value; the first write must name a gate mode
 *  (the column has no default, and a guessed mode would silently decide whether
 *  incomplete invoices are refused). A provider is validated against the
 *  installed apps implementing the contract; changing it is audited and raises
 *  an attention item (switching the e-invoicing platform is legally relevant). */
async function ensureEinvoicingSettings(
  ctx: ProvisionContext,
  cfg: NonNullable<NonNullable<ProvisioningConfig["invoicing"]>["einvoicing"]>,
  changed: string[],
  unchanged: string[],
  checkProvider: ContractProviderCheck,
): Promise<EinvoicingResult> {
  const rows = await ctx.priv("cli-invoicing-einvoicing-read", (tx) =>
    tx.execute(drizzleSql`
      SELECT id, gate_mode, gate_mode_source, cibs_switch_date, provider_app, cutover_date, send_enabled, book_enabled
      FROM ${invRel("einvoicing_settings")}
      WHERE org_id = ${ctx.orgId}::uuid
      ORDER BY created_at ASC
      LIMIT 1
    `),
  )
  const existing = extractRows<{
    id: string
    gate_mode: string
    gate_mode_source: string
    cibs_switch_date: string | null
    provider_app: string | null
    cutover_date: string | null
    send_enabled: boolean | null
    book_enabled: boolean | null
  }>(rows)[0]

  const gateMode = cfg.gateMode ?? existing?.gate_mode
  if (!gateMode) {
    throw new ConfigError(
      "invoicing.einvoicing: gateMode (warn or enforce) is required the first time the e-invoicing settings are written",
    )
  }
  const cibsSwitchDate = cfg.cibsSwitchDate ?? existing?.cibs_switch_date ?? null
  const providerApp = cfg.providerApp ?? existing?.provider_app ?? null
  const cutoverDate = cfg.cutoverDate ?? existing?.cutover_date ?? null
  const sendEnabled = cfg.sendEnabled ?? existing?.send_enabled ?? false
  const bookEnabled = cfg.bookEnabled ?? existing?.book_enabled ?? false
  if ((sendEnabled || bookEnabled) && (!providerApp || !cutoverDate)) {
    throw new ConfigError(
      "invoicing.einvoicing: sendEnabled / bookEnabled need providerApp and cutoverDate",
    )
  }
  const previousProvider = existing?.provider_app ?? null
  if (cfg.providerApp && cfg.providerApp !== previousProvider) {
    const check = await checkProvider(ctx, cfg.providerApp)
    if (!check.ok) throw new ConfigError(`invoicing.einvoicing.providerApp: ${check.reason}`)
  }
  const result = { gateMode, cibsSwitchDate, providerApp, cutoverDate, sendEnabled, bookEnabled }

  const bindingChanged = providerApp !== previousProvider
  // The binding the kernel dispatches by lives in the kernel (no app can write it); the app row
  // mirrors it. Config apply is an administrator's path: it writes both, in one transaction.
  const { readKernelContractBinding, writeKernelContractBinding } = await import(
    "~/modules/apps/provider-contracts/binding"
  )
  const kernelInSync =
    (await readKernelContractBinding(ctx.orgId, "einvoicing-pa@1", "invoicing")) === providerApp
  const syncKernelBinding = async (tx: Parameters<Parameters<ProvisionContext["priv"]>[1]>[0]) => {
    if (kernelInSync) return
    await writeKernelContractBinding(tx as never, {
      orgId: ctx.orgId,
      contract: "einvoicing-pa@1",
      callerApp: "invoicing",
      provider: providerApp,
      actorId: ctx.actor.userId,
      actorType: "user",
      source: "config",
    })
  }
  const recordBindingChange = async (
    tx: Parameters<Parameters<ProvisionContext["priv"]>[1]>[0],
    settingsId: string,
  ) => {
    await syncKernelBinding(tx)
    if (!bindingChanged) return
    const data = {
      from: previousProvider ?? "none",
      to: providerApp ?? "none",
      by: ctx.actor.userId,
      source: "config",
    }
    await tx.queueEvent({
      app: "invoicing",
      entity: "einvoicing",
      action: "binding_changed",
      entityId: settingsId,
      orgId: ctx.orgId,
      actorId: ctx.actor.userId,
      actorType: "user",
      data,
    } as never)
    const { writeAuditLog } = await import("~/modules/audit/service")
    await writeAuditLog(tx, {
      orgId: ctx.orgId,
      actorId: ctx.actor.userId,
      actorType: "user",
      app: "invoicing",
      entityType: "einvoicing_settings",
      entityId: settingsId,
      action: "einvoicing.binding_changed",
      changes: { provider_app: { from: previousProvider, to: providerApp } },
      metadata: { source: "config" },
    })
  }

  if (existing) {
    if (
      existing.gate_mode === gateMode &&
      existing.gate_mode_source === "config" &&
      (existing.cibs_switch_date ?? null) === cibsSwitchDate &&
      (existing.provider_app ?? null) === providerApp &&
      (existing.cutover_date ?? null) === cutoverDate &&
      (existing.send_enabled ?? false) === sendEnabled &&
      (existing.book_enabled ?? false) === bookEnabled &&
      kernelInSync
    ) {
      ctx.log("invoicing: e-invoicing settings already up to date")
      unchanged.push("invoicing.einvoicing")
      return { action: "unchanged", ...result }
    }
    await ctx.priv("cli-invoicing-einvoicing-update", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE ${invRel("einvoicing_settings")}
        SET gate_mode = ${gateMode},
            gate_mode_source = 'config',
            cibs_switch_date = ${cibsSwitchDate},
            provider_app = ${providerApp},
            cutover_date = ${cutoverDate},
            send_enabled = ${sendEnabled},
            book_enabled = ${bookEnabled},
            changed_by = ${ctx.actor.userId},
            updated_at = now()
        WHERE id = ${existing.id}::uuid
      `)
      await recordBindingChange(tx, existing.id)
    })
    ctx.log("invoicing: e-invoicing settings updated")
    changed.push("invoicing.einvoicing")
    return { action: "updated", ...result }
  }

  await ctx.priv("cli-invoicing-einvoicing-insert", async (tx) => {
    const inserted = await tx.execute(drizzleSql`
      INSERT INTO ${invRel("einvoicing_settings")}
        (org_id, gate_mode, gate_mode_source, cibs_switch_date, provider_app, cutover_date, send_enabled, book_enabled, changed_by)
      VALUES (${ctx.orgId}::uuid, ${gateMode}, 'config', ${cibsSwitchDate}, ${providerApp}, ${cutoverDate}, ${sendEnabled}, ${bookEnabled}, ${ctx.actor.userId})
      RETURNING id
    `)
    await recordBindingChange(tx, extractRows<{ id: string }>(inserted)[0]!.id)
  })
  ctx.log("invoicing: e-invoicing settings created")
  changed.push("invoicing.einvoicing")
  return { action: "created", ...result }
}

type IssuerProfileInput = NonNullable<
  NonNullable<ProvisioningConfig["invoicing"]>["issuerProfiles"]
>[number]

/**
 * The legal identity an issuer profile change sets, as one line for the
 * approval card: ": legal form SAS; address 1 Rue X, 75001 Paris, FR; SIREN
 * 552032534; VAT FR..; IBAN ..", or "" when it sets none. Every field that is
 * printed on an invoice or sent with an e-invoice is named, so a person
 * approving the card sees each value instead of only the company name.
 */
export function issuerIdentitySummary(p: IssuerProfileInput): string {
  const address = [
    p.addressLine1,
    p.addressLine2,
    [p.postcode, p.city].filter(Boolean).join(" "),
    p.countryCode,
  ]
    .filter((part) => typeof part === "string" && part.trim() !== "")
    .join(", ")
  const parts = [
    p.legalForm ? `legal form ${p.legalForm}` : null,
    address ? `address ${address}` : p.address ? `address ${p.address}` : null,
    p.siren ? `SIREN ${p.siren}` : null,
    p.siret ? `SIRET ${p.siret}` : null,
    p.vatId ? `VAT ${p.vatId}` : null,
    p.taxRegistrationId ? `tax id ${p.taxRegistrationId}` : null,
    p.shareCapital ? `share capital ${p.shareCapital}` : null,
    p.rcsCity ? `RCS ${p.rcsCity}` : null,
    p.iban ? `IBAN ${p.iban}` : null,
    p.swiftBic ? `BIC ${p.swiftBic}` : null,
  ].filter((x): x is string => x !== null)
  return parts.length > 0 ? `: ${parts.join("; ")}` : ""
}

/**
 * Factory so the logo upload's storage seams (`putObject`/`getObjectBuffer`)
 * are injectable — mirrors `createByokProvisioner`. `invoicingProvisioner`
 * below is the production instance (real object storage).
 */
export function createInvoicingProvisioner(
  logoDeps: InvoicingLogoDeps = defaultLogoDeps,
  checkProvider: ContractProviderCheck = defaultContractProviderCheck,
): Provisioner<ProvisioningConfig> {
  return {
    key: "invoicing",

    async plan(ctx, config): Promise<ProvisionPlan> {
      const inv = config.invoicing
      if (!inv) return { actions: [] }
      const actions: string[] = []
      // Tool path: issuer profiles diff against the live org (by legal name);
      // tax regimes, HS codes and e-invoicing settings echo their params and
      // each counts as a possible change.
      let changes = 0
      if (ctx.toolPath) await preflightSchema(ctx)
      for (const p of inv.issuerProfiles ?? []) {
        if (ctx.toolPath) {
          const r = await ensureIssuerProfile(ctx, p, [], [], [], logoDeps, true)
          if (r.action !== "unchanged") changes++
          // A changed profile's card names every legal identity field it
          // carries: the approver checks what will be printed on invoices.
          const identity = r.action === "unchanged" ? "" : issuerIdentitySummary(p)
          actions.push(
            r.action === "unchanged"
              ? `issuer profile '${p.legalName}' unchanged`
              : r.action === "updated"
                ? `update issuer profile '${p.legalName}'${identity}`
                : `create issuer profile '${p.legalName}' (${p.country})${identity}`,
          )
        } else {
          actions.push(`ensure issuer profile '${p.legalName}' (${p.country})`)
        }
        if (p.logoFileId) changes++
        if (p.logoPath && p.logoFileId) {
          throw new ConfigError(
            `invoicing: issuer profile '${p.legalName}' sets both logoPath and logoFileId; keep one`,
          )
        }
        if (p.logoPath) actions.push(`ensure issuer profile '${p.legalName}' logo (${p.logoPath})`)
        if (p.logoFileId && ctx.orgId === "") {
          actions.push(
            `ensure issuer profile '${p.legalName}' logo (uploaded file ${p.logoFileId})`,
          )
        } else if (p.logoFileId) {
          // Read as the planning person: the requester at proposal and the
          // approver at execution must both be able to read it; the card names it.
          const file = await statActorFile(ctx, p.logoFileId, `logoFileId '${p.logoFileId}'`)
          actions.push(
            `ensure issuer profile '${p.legalName}' logo from uploaded file '${file.filename}' (${file.id})`,
          )
        }
      }
      for (const t of inv.taxRegimes ?? []) {
        actions.push(`ensure tax regime '${t.issuerCountry}/${t.treatment}'`)
      }
      for (const h of inv.hsCodes ?? []) {
        actions.push(`ensure hs code '${h.code}'`)
      }
      changes += (inv.taxRegimes ?? []).length + (inv.hsCodes ?? []).length
      if (inv.einvoicing) changes++
      if (inv.einvoicing) {
        const parts = [
          inv.einvoicing.gateMode ? `gate mode ${inv.einvoicing.gateMode}` : null,
          inv.einvoicing.cibsSwitchDate ? `switch date ${inv.einvoicing.cibsSwitchDate}` : null,
          inv.einvoicing.providerApp ? `platform ${inv.einvoicing.providerApp}` : null,
          inv.einvoicing.cutoverDate ? `cut-over ${inv.einvoicing.cutoverDate}` : null,
          inv.einvoicing.sendEnabled !== undefined
            ? `sending ${inv.einvoicing.sendEnabled ? "on" : "off"}`
            : null,
          inv.einvoicing.bookEnabled !== undefined
            ? `booking ${inv.einvoicing.bookEnabled ? "on" : "off"}`
            : null,
        ].filter((x) => x !== null)
        actions.push(`ensure e-invoicing settings (${parts.join(", ")})`)
      }
      return ctx.toolPath ? { actions, changes } : { actions }
    },

    async apply(ctx, _plan, config): Promise<ProvisionResult> {
      const inv = config.invoicing
      if (!inv) return {}
      const hasWork =
        (inv.issuerProfiles?.length ?? 0) > 0 ||
        (inv.taxRegimes?.length ?? 0) > 0 ||
        (inv.hsCodes?.length ?? 0) > 0 ||
        inv.einvoicing !== undefined
      if (!hasWork) return {}

      await preflightSchema(ctx)

      const changed: string[] = []
      const unchanged: string[] = []
      const pending: PendingItem[] = []

      const issuerProfiles: IssuerProfileResult[] = []
      for (const p of inv.issuerProfiles ?? []) {
        issuerProfiles.push(
          await ensureIssuerProfile(ctx, p, changed, unchanged, pending, logoDeps),
        )
      }

      const taxRegimes: TaxRegimeResult[] = []
      for (const t of inv.taxRegimes ?? []) {
        taxRegimes.push(await ensureTaxRegime(ctx, t, changed, unchanged))
      }

      const hsCodes: HsCodeResult[] = []
      for (const h of inv.hsCodes ?? []) {
        hsCodes.push(await ensureHsCode(ctx, h, changed, unchanged))
      }

      const einvoicing = inv.einvoicing
        ? await ensureEinvoicingSettings(ctx, inv.einvoicing, changed, unchanged, checkProvider)
        : undefined

      const section: InvoicingSection = {
        issuerProfiles,
        taxRegimes,
        hsCodes,
        ...(einvoicing ? { einvoicing } : {}),
      }
      return {
        section,
        ...(changed.length > 0 ? { changed } : {}),
        ...(unchanged.length > 0 ? { unchanged } : {}),
        ...(pending.length > 0 ? { pending } : {}),
      }
    },
  }
}

/** Production invoicing provisioner (real object storage). */
export const invoicingProvisioner = createInvoicingProvisioner()
