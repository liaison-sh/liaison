// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Cross-app seam: shopify (0.2.11) emits `refund_line_items` on refund:created
// (external_id = Admin GraphQL variant gid, amount_minor = a digit-string
// integer minor-unit total) and invoicing (0.13.5) consumes them, matching
// external_id against document_lines.external_id to credit the ONE document
// (goods or software) that actually carries the refunded line on a split
// order. Both halves were fixed independently by two different agents; the
// declared types are only structurally compatible (invoicing accepts bigint,
// number or string) — nothing before this file drove a real emit into a real
// consume.
//
// This test drives the REAL path: a raw Shopify refunds/create webhook body,
// HMAC-signed and POSTed at the real `/webhooks/:orgId/shopify/refunds-create`
// route, through the real `shopifyWebhookVerifier` + `refundsCreateHandler`
// (bundled-apps/shopify/src/webhooks.ts) so the emitted event is whatever
// production code actually produces — never a hand-built envelope. The
// resulting `pending_events` row is then drained through the real outbox
// (`processOutboxBatch`), which invokes invoicing's real
// `onShopifyRefundCreated` subscriber (bundled-apps/invoicing/src/handlers/
// shopify-refund-created.ts) with the real kernel-injected issue pipeline, so
// the reversing credit note(s) are issued for real. Every assertion reads
// persisted Postgres state, never a return value.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHmac, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { app } from "~/app"
import { sql } from "~/db"
import { flushEventHandlers } from "~/infra/events/event-bus"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const WEBHOOK_SECRET = "shpss_seam_test_secret"

// Read the manifest at call time (moving target — see invoicing-order-reissue-atomic.test.ts).
function bundledDescriptor(name: string): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", name, "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  const version = (manifest.version as string) ?? "0.1.0"
  return {
    ...manifest,
    trusted: false,
    _format: "manifest",
    _bundlePath: join(REPO_ROOT, "bundled-apps", name, version, "bundle.js"),
  }
}

const ORG = "00000000-0000-4000-8000-0000000f6001"
const USER = "00000000-0000-4000-8000-0000000f6002"
const SHOP_DOMAIN = "seam-test-store.myshopify.com"

const counterparty = {
  name: "Seam Buyer SARL",
  address: "1 rue Seam, 75002 Paris",
  email: "ap@seambuyer.example",
  country: "FR",
}

// The buyer is a French company: its registry-confirmed identity is on file (fictional SIREN)
// and the invoices carry its structured billing address, so its credit notes are e-invoices.
const CONFIRMED_CONTACT = "00000000-0000-4000-8000-0000000f6011"
// A French company whose identity nobody recorded: its credit note waits on it.
const UNIDENTIFIED_CONTACT = "00000000-0000-4000-8000-0000000f6012"

interface SeamDoc {
  id: string
  type: "invoice" | "credit_note"
  scope: string | null
  grand_total_minor: string
  payment_status: string
  external_refs: Record<string, unknown>
}

async function insertIssuerProfile(): Promise<string> {
  const id = randomUUID()
  await sql`INSERT INTO app_invoicing.issuer_profiles
    (id, org_id, legal_name, country, vat_id, default_currency)
    VALUES (${id}, ${ORG}, 'Seam Issuer SAS', 'FR', 'FR68900000001', 'EUR')`
  return id
}

/** Insert a live, issued invoice document directly (bypassing the
 *  one-invoice-per-order tool guard, which blocks a SECOND live invoice for
 *  the same shopify_order_id regardless of scope -- the real split-order
 *  issuance path, shopify-order-paid.ts, writes the two scoped documents
 *  directly for exactly this reason). One line per document, external_id =
 *  the Shopify variant gid, tax_rate_bp = 0 so the reversal math is exact. */
async function insertScopedInvoice(args: {
  issuerProfileId: string
  shopifyOrderId: string
  scope: "goods" | "software"
  unitPriceMinor: number
  externalId: string
  contactId?: string
}): Promise<string> {
  const id = randomUUID()
  await sql`INSERT INTO app_invoicing.documents
    (id, org_id, type, status, payment_status, currency, issuer_profile_id,
     shopify_order_id, scope, number, grand_total_minor, subtotal_minor, tax_total_minor,
     lifecycle_log, counterparty_contact_id, counterparty_name, counterparty_address,
     counterparty_email, counterparty_country, billing_line1, billing_postcode, billing_city,
     billing_country_code)
    VALUES (${id}, ${ORG}, 'invoice', 'issued', 'unpaid', 'EUR', ${args.issuerProfileId},
     ${args.shopifyOrderId}, ${args.scope}, ${`INV-SEAM-${args.scope}-${id.slice(0, 8)}`},
     ${args.unitPriceMinor}, ${args.unitPriceMinor}, 0, '[]'::jsonb,
     ${args.contactId ?? CONFIRMED_CONTACT}, ${counterparty.name}, ${counterparty.address},
     ${counterparty.email}, ${counterparty.country}, '1 rue Seam', '75002', 'Paris', 'FR')`
  await sql`INSERT INTO app_invoicing.document_lines
    (org_id, document_id, position, description, quantity, unit_price_minor, line_kind,
     tax_rate_bp, subtotal_minor, tax_minor, total_minor, external_id)
    VALUES (${ORG}, ${id}, 1, ${`${args.scope} item`}, 1, ${args.unitPriceMinor}, ${args.scope},
     0, ${args.unitPriceMinor}, 0, ${args.unitPriceMinor}, ${args.externalId})`
  return id
}

async function fetchDoc(id: string): Promise<SeamDoc> {
  const rows = await sql<
    Array<{
      id: string
      type: string
      scope: string | null
      grand_total_minor: string
      payment_status: string
      external_refs: Record<string, unknown>
    }>
  >`SELECT id, type, scope, grand_total_minor, payment_status, external_refs
     FROM app_invoicing.documents WHERE id = ${id}`
  if (!rows[0]) throw new Error(`document ${id} not found`)
  return rows[0] as SeamDoc
}

async function creditNotesForOriginal(originalDocumentId: string): Promise<SeamDoc[]> {
  const rows = await sql<
    Array<{
      id: string
      type: string
      scope: string | null
      grand_total_minor: string
      payment_status: string
      external_refs: Record<string, unknown>
    }>
  >`SELECT id, type, scope, grand_total_minor, payment_status, external_refs
     FROM app_invoicing.documents
     WHERE org_id = ${ORG} AND type = 'credit_note'
       AND external_refs->>'original_document_id' = ${originalDocumentId}`
  return rows as SeamDoc[]
}

async function deferredCountForOrder(shopifyOrderId: string): Promise<number> {
  const rows = await sql<Array<{ count: string }>>`
    SELECT count(*)::text AS count FROM app_invoicing.deferred_events
    WHERE org_id = ${ORG}
      AND blocked_on->>'shopify_order_id' = ${shopifyOrderId}
      AND reason = 'refund_line_item_unattributable'`
  return Number(rows[0]?.count ?? "0")
}

/** Sign `body` with the real HMAC-SHA256 base64 scheme shopifyWebhookVerifier checks. */
function signBody(body: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("base64")
}

/** POST a raw Shopify refunds/create webhook body through the REAL route ->
 *  real verifier -> real refundsCreateHandler. Returns the HTTP response. */
async function postRefundWebhook(payload: Record<string, unknown>, webhookId: string) {
  const body = JSON.stringify(payload)
  const res = await app.request(`/webhooks/${ORG}/shopify/refunds-create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-hmac-sha256": signBody(body),
      "x-shopify-webhook-id": webhookId,
      "x-shopify-shop-domain": SHOP_DOMAIN,
    },
    body,
  })
  return res
}

describe("shopify -> invoicing refund_line_items seam (real webhook -> real outbox -> real subscriber)", () => {
  let issuerProfileId: string

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"

    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Refund Seam Org', 'refund-seam-org')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${USER}, ${ORG}, 'refund-seam@test.com', 'hash', 'Refund Seam Tester', 'active')
      ON CONFLICT (id) DO NOTHING`

    await initSandboxPool()
    await initWorkerPool()

    await registerApps(
      [bundledDescriptor("shopify") as never, bundledDescriptor("invoicing") as never],
      ORG,
    )

    // Persist the webhook signing secret ENCRYPTED at rest, exactly as the
    // real OAuth callback path does (shopify-oauth-callback.test.ts) -- the
    // sandboxed verifier's config_get bridge decrypts it back to plaintext
    // using the manifest's `connections.shop.clientSecretConfigKey`.
    await sql`UPDATE kernel.apps
      SET config = ${JSON.stringify({
        shopifyWebhookSecret: encryptSecret(
          WEBHOOK_SECRET,
          env.ENCRYPTION_KEY,
          CryptoContext.appConfigConnectionSecret,
        ),
      })}::jsonb
      WHERE org_id = ${ORG} AND name = 'shopify'`

    // The webhook route accepts a delivery only from a shop this org has
    // CONNECTED (the shop-domain check of bundled-apps/shopify/src/webhooks.ts):
    // the org's active `shop` account, as the OAuth callback leaves it.
    await sql`DELETE FROM app_shopify.install_metadata WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${ORG} AND app_name = 'shopify'`
    await sql`INSERT INTO kernel.connected_accounts
      (org_id, app_name, connection_name, owner_type, provider_type, identifier, status, created_by)
      VALUES (${ORG}, 'shopify', 'shop', 'org', 'oauth2', ${SHOP_DOMAIN}, 'active', ${USER})`

    issuerProfileId = await insertIssuerProfile()
    // A rerun starts from the same state even when an earlier run's cleanup did not complete.
    await sql`DELETE FROM app_invoicing.einvoicing_settings WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.counterparty_identities WHERE org_id = ${ORG}`
    await sql`INSERT INTO app_invoicing.einvoicing_settings (org_id, gate_mode, gate_mode_source)
      VALUES (${ORG}, 'enforce', 'config')`
    await sql`INSERT INTO app_invoicing.counterparty_identities
      (org_id, contact_id, customer_kind, siren, registry_name, registry_line1, registry_postcode,
       registry_city, registry_country_code, registry_status, registry_checked_at, source, confirmed_via, changed_at)
      VALUES (${ORG}, ${CONFIRMED_CONTACT}, 'business', '902000009', 'SEAM BUYER', '1 rue Seam', '75002',
       'Paris', 'FR', 'A', '2026-10-01', 'registry', 'auto', '2026-10-01')`
  }, 60_000)

  afterAll(async () => {
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await sql`DELETE FROM app_invoicing.documents WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.issuer_profiles WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.deferred_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.counterparty_identities WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.einvoicing_settings WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_shopify.webhook_deliveries WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_shopify.install_metadata WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${ORG} AND app_name = 'shopify'`
    await releaseTestLock()
  }, 60_000)

  it("a software-only refund credits ONLY the software document, goods untouched", async () => {
    const shopifyOrderId = "seam-order-software-only"
    const goodsId = await insertScopedInvoice({
      issuerProfileId,
      shopifyOrderId,
      scope: "goods",
      unitPriceMinor: 5000,
      externalId: "gid://shopify/ProductVariant/1001",
    })
    const softwareId = await insertScopedInvoice({
      issuerProfileId,
      shopifyOrderId,
      scope: "software",
      unitPriceMinor: 3000,
      externalId: "gid://shopify/ProductVariant/1002",
    })

    const res = await postRefundWebhook(
      {
        id: 9100000001,
        order_id: shopifyOrderId,
        transactions: [{ amount: "30.00", currency: "EUR" }],
        refund_line_items: [
          {
            line_item_id: 5501,
            subtotal: "30.00",
            total_tax: "0.00",
            line_item: { variant_id: 1002 },
          },
        ],
      },
      `seam-webhook-software-only-${randomUUID()}`,
    )
    expect(res.status).toBe(200)

    const processed = await processOutboxBatch()
    expect(processed).toBeGreaterThan(0)
    await flushEventHandlers()

    const goods = await fetchDoc(goodsId)
    const software = await fetchDoc(softwareId)
    // Goods document: completely untouched.
    expect(goods.payment_status).toBe("unpaid")
    expect(await creditNotesForOriginal(goodsId)).toHaveLength(0)
    // Software document: fully refunded (the only line on it, 3000 minor).
    expect(software.payment_status).toBe("refunded")

    const softwareCreditNotes = await creditNotesForOriginal(softwareId)
    expect(softwareCreditNotes).toHaveLength(1)
    expect(softwareCreditNotes[0]!.grand_total_minor).toBe("-3000")
  })

  it("a refund spanning both halves credits BOTH documents, each its own credit note", async () => {
    const shopifyOrderId = "seam-order-spanning"
    const goodsId = await insertScopedInvoice({
      issuerProfileId,
      shopifyOrderId,
      scope: "goods",
      unitPriceMinor: 5000,
      externalId: "gid://shopify/ProductVariant/2001",
    })
    const softwareId = await insertScopedInvoice({
      issuerProfileId,
      shopifyOrderId,
      scope: "software",
      unitPriceMinor: 3000,
      externalId: "gid://shopify/ProductVariant/2002",
    })

    const res = await postRefundWebhook(
      {
        id: 9100000002,
        order_id: shopifyOrderId,
        transactions: [{ amount: "80.00", currency: "EUR" }],
        refund_line_items: [
          {
            line_item_id: 5502,
            subtotal: "50.00",
            total_tax: "0.00",
            line_item: { variant_id: 2001 },
          },
          {
            line_item_id: 5503,
            subtotal: "30.00",
            total_tax: "0.00",
            line_item: { variant_id: 2002 },
          },
        ],
      },
      `seam-webhook-spanning-${randomUUID()}`,
    )
    expect(res.status).toBe(200)

    const processed = await processOutboxBatch()
    expect(processed).toBeGreaterThan(0)
    await flushEventHandlers()

    const goods = await fetchDoc(goodsId)
    const software = await fetchDoc(softwareId)
    expect(goods.payment_status).toBe("refunded")
    expect(software.payment_status).toBe("refunded")

    const goodsCreditNotes = await creditNotesForOriginal(goodsId)
    const softwareCreditNotes = await creditNotesForOriginal(softwareId)
    expect(goodsCreditNotes).toHaveLength(1)
    expect(softwareCreditNotes).toHaveLength(1)
    expect(goodsCreditNotes[0]!.grand_total_minor).toBe("-5000")
    expect(softwareCreditNotes[0]!.grand_total_minor).toBe("-3000")
    // Two SEPARATE documents, never one combined note.
    expect(goodsCreditNotes[0]!.id).not.toBe(softwareCreditNotes[0]!.id)
  })

  it("an unattributable refund line defers: no credit note, no document mutated", async () => {
    const shopifyOrderId = "seam-order-unattributable"
    const goodsId = await insertScopedInvoice({
      issuerProfileId,
      shopifyOrderId,
      scope: "goods",
      unitPriceMinor: 5000,
      externalId: "gid://shopify/ProductVariant/3001",
    })
    const softwareId = await insertScopedInvoice({
      issuerProfileId,
      shopifyOrderId,
      scope: "software",
      unitPriceMinor: 3000,
      externalId: "gid://shopify/ProductVariant/3002",
    })

    const res = await postRefundWebhook(
      {
        id: 9100000003,
        order_id: shopifyOrderId,
        transactions: [{ amount: "30.00", currency: "EUR" }],
        refund_line_items: [
          {
            line_item_id: 5504,
            subtotal: "30.00",
            total_tax: "0.00",
            // Variant 9999 was never issued on either document of this order.
            line_item: { variant_id: 9999 },
          },
        ],
      },
      `seam-webhook-unattributable-${randomUUID()}`,
    )
    expect(res.status).toBe(200)

    const processed = await processOutboxBatch()
    expect(processed).toBeGreaterThan(0)
    await flushEventHandlers()

    const goods = await fetchDoc(goodsId)
    const software = await fetchDoc(softwareId)
    expect(goods.payment_status).toBe("unpaid")
    expect(software.payment_status).toBe("unpaid")
    expect(await creditNotesForOriginal(goodsId)).toHaveLength(0)
    expect(await creditNotesForOriginal(softwareId)).toHaveLength(0)
    // The deferral path actually fired (not just "nothing happened").
    expect(await deferredCountForOrder(shopifyOrderId)).toBe(1)
  })
  it("a credit note the e-invoicing gate refuses parks on the buyer's identity: refund recorded, no credit note", async () => {
    const shopifyOrderId = "seam-order-identity-missing"
    const goodsId = await insertScopedInvoice({
      issuerProfileId,
      shopifyOrderId,
      scope: "goods",
      unitPriceMinor: 5000,
      externalId: "gid://shopify/ProductVariant/4001",
      contactId: UNIDENTIFIED_CONTACT,
    })

    const res = await postRefundWebhook(
      {
        id: 9100000004,
        order_id: shopifyOrderId,
        transactions: [{ amount: "50.00", currency: "EUR" }],
        refund_line_items: [],
      },
      `seam-webhook-identity-missing-${randomUUID()}`,
    )
    expect(res.status).toBe(200)

    const processed = await processOutboxBatch()
    expect(processed).toBeGreaterThan(0)
    await flushEventHandlers()

    const goods = await fetchDoc(goodsId)
    expect(goods.payment_status).toBe("refunded")
    expect(await creditNotesForOriginal(goodsId)).toHaveLength(0)

    const parks = await sql<
      Array<{
        event_id: string
        status: string
        reason: string | null
        blocked_on: Record<string, unknown>
        event_payload_json: Record<string, unknown>
        contact_id: string | null
      }>
    >`SELECT event_id, status, reason, blocked_on, event_payload_json, contact_id
      FROM app_invoicing.deferred_events
      WHERE org_id = ${ORG} AND blocked_on->>'document_id' = ${goodsId}`
    expect(parks).toHaveLength(1)
    const park = parks[0]!
    expect(park.event_id).toBe(`cn:9100000004:${goodsId}`)
    expect(park.status).toBe("awaiting_data")
    expect(park.reason).toBe("customer_kind_missing")
    expect(park.blocked_on.kind).toBe("einvoice_identity")
    expect(park.blocked_on.contact_id).toBe(UNIDENTIFIED_CONTACT)
    // The contact is a column too: identity lookups on parks filter on it.
    expect(park.contact_id).toBe(UNIDENTIFIED_CONTACT)
    expect(park.event_payload_json.kind).toBe("parked_credit_note")
    expect(park.event_payload_json.source).toBe("refund")
    expect(park.event_payload_json.original_document_id).toBe(goodsId)
    expect(park.event_payload_json.amount_minor).toBe("5000")
  })
})
