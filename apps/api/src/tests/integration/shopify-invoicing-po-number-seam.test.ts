// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Cross-app seam: a customer's Shopify PO number must survive the trip from
// the Shopify webhook, through the outbox, into invoicing's persisted
// documents -- and it must survive with the RIGHT CASING at each boundary.
//
// The convention (agreed this session, after three prior cross-app breaks
// that unit tests alone could not catch because each app was tested alone
// and both suites stayed green):
//   - EVENT payloads (and the normalized shapes that feed them) are
//     camelCase: the shopify order and draft-order events carry `poNumber`.
//   - TOOL RESULTS, database columns and tool params are snake_case:
//     `orders_get` returns `po_number`, invoicing's column is `po_number`.
//
// This file follows shopify-invoicing-refund-seam.test.ts's approach: a raw
// Shopify webhook body, HMAC-signed and POSTed at the real
// `/webhooks/:orgId/shopify/...` route, through the real
// `shopifyWebhookVerifier` + the real topic handler (bundled-apps/shopify/
// src/webhooks.ts), so the emitted event is whatever production code
// actually produces -- never a hand-built envelope. The resulting
// `pending_events` row is drained through the real outbox
// (`processOutboxBatch`), which invokes invoicing's real subscribers
// (bundled-apps/invoicing/src/handlers/shopify-order-paid.ts and
// shopify-draft-order.ts). Every assertion reads persisted Postgres state
// (or the raw event envelope actually queued), never a hand-built fixture.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHmac, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { app } from "~/app"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { flushEventHandlers } from "~/infra/events/event-bus"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const WEBHOOK_SECRET = "shpss_po_seam_test_secret"
const SHOP_DOMAIN = "po-seam-test-store.myshopify.com"

// Read the manifest at call time (moving target -- two other agents are
// actively editing bundled-apps/shopify and bundled-apps/invoicing).
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

const ORG = "00000000-0000-4000-8000-0000000f8001"
const USER = "00000000-0000-4000-8000-0000000f8002"
const THREAD = "00000000-0000-4000-8000-0000000f8003"

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["invoicing:documents:read"],
  dimensionGrants: {},
}

interface SeamDocRow {
  id: string
  scope: string | null
  po_number: string | null
  shopify_order_id: string | null
  shopify_draft_order_id: string | null
  status: string
  regime: string | null
}

async function insertIssuerProfile(): Promise<string> {
  const id = randomUUID()
  await sql`INSERT INTO app_invoicing.issuer_profiles
    (id, org_id, legal_name, country, vat_id, default_currency, shopify_shop_id)
    VALUES (${id}, ${ORG}, 'PO Seam Issuer SAS', 'FR', 'FR41903000008', 'EUR', ${SHOP_DOMAIN})`
  return id
}

/** The French company buyers of the order journeys: each one's kernel contact exists before its
 *  order arrives (the webhook resolves it by email) with a registry-confirmed identity (fictional
 *  SIREN), so its invoice issues as an e-invoice. */
const SARL_BUYERS = [
  {
    email: "buyer1@po-seam.example",
    name: "PO Seam Buyer SARL",
    siren: "900000001",
    line1: "1 rue Seam",
  },
  {
    email: "buyer2@po-seam.example",
    name: "PO Seam Buyer2 SARL",
    siren: "902000009",
    line1: "2 rue Seam",
  },
  {
    email: "buyer3@po-seam.example",
    name: "PO Seam Buyer3 SARL",
    siren: "903000008",
    line1: "4 rue Seam",
  },
  {
    email: "buyer5@po-seam.example",
    name: "PO Seam Buyer5 SARL",
    siren: "904000007",
    line1: "5 rue Seam",
  },
] as const

async function seedConfirmedBuyers(): Promise<void> {
  for (const [i, b] of SARL_BUYERS.entries()) {
    // A rerun finds the contact an earlier run created (contacts outlive the run, as before).
    const existing = await sql<Array<{ id: string }>>`
      SELECT id FROM kernel.contacts WHERE org_id = ${ORG} AND LOWER(email) = ${b.email}`
    const contactId = existing[0]?.id ?? randomUUID()
    if (!existing[0]) {
      await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, email, company, created_by)
        VALUES (${contactId}, ${ORG}, ${`@po-seam-buyer-${i + 1}`}, ${b.name}, ${b.email}, ${b.name}, ${USER})`
    }
    await sql`DELETE FROM app_invoicing.counterparty_identities WHERE org_id = ${ORG} AND contact_id = ${contactId}`
    await sql`INSERT INTO app_invoicing.counterparty_identities
      (org_id, contact_id, customer_kind, siren, registry_name, registry_line1, registry_postcode,
       registry_city, registry_country_code, registry_status, registry_checked_at, source, confirmed_via, changed_at)
      VALUES (${ORG}, ${contactId}, 'business', ${b.siren}, ${b.name}, ${b.line1}, '75002',
       'Paris', 'FR', 'A', '2026-10-01', 'registry', 'auto', '2026-10-01')`
  }
}

async function docByOrder(
  shopifyOrderId: string,
  scope: "goods" | "software",
): Promise<SeamDocRow | null> {
  const rows = await sql<SeamDocRow[]>`
    SELECT id, scope, po_number, shopify_order_id, shopify_draft_order_id, status, regime
    FROM app_invoicing.documents
    WHERE org_id = ${ORG} AND shopify_order_id = ${shopifyOrderId} AND scope = ${scope}`
  return rows[0] ?? null
}

async function docByDraftOrder(draftOrderId: string): Promise<SeamDocRow | null> {
  const rows = await sql<SeamDocRow[]>`
    SELECT id, scope, po_number, shopify_order_id, shopify_draft_order_id, status, regime
    FROM app_invoicing.documents
    WHERE org_id = ${ORG} AND shopify_draft_order_id = ${draftOrderId}`
  return rows[0] ?? null
}

/** Sign `body` with the real HMAC-SHA256 base64 scheme shopifyWebhookVerifier checks. */
function signBody(body: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("base64")
}

/** POST a raw Shopify webhook body through the REAL route -> real verifier ->
 *  real topic handler. Returns the HTTP response. */
async function postWebhook(
  endpoint: string,
  payload: Record<string, unknown>,
  webhookId: string,
): Promise<Response> {
  const body = JSON.stringify(payload)
  const res = await app.request(`/webhooks/${ORG}/shopify/${endpoint}`, {
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

/** The RAW envelope actually queued to the outbox for one entity:action,
 *  keyed by entityId -- what a subscriber (or a regression) actually sees,
 *  not a hand-built fixture. */
async function queuedEventData(
  entity: string,
  action: string,
  entityId: string,
): Promise<Record<string, unknown>> {
  const rows = await sql<Array<{ payload: Record<string, unknown> }>>`
    SELECT payload FROM kernel.pending_events
    WHERE org_id = ${ORG}
      AND payload->>'entity' = ${entity}
      AND payload->>'action' = ${action}
      AND payload->>'entityId' = ${entityId}
    ORDER BY seq DESC LIMIT 1`
  if (!rows[0]) throw new Error(`no queued ${entity}:${action} event for entityId ${entityId}`)
  return (rows[0].payload.data as Record<string, unknown>) ?? {}
}

describe("shopify -> invoicing PO number seam (real webhook -> real outbox -> real subscriber)", () => {
  let issuerProfileId: string

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"

    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'PO Seam Org', 'po-seam-org')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${USER}, ${ORG}, 'po-seam@test.com', 'hash', 'PO Seam Tester', 'active')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'po-seam-thread', 'agent_chat', ${USER})
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${USER}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${USER}, ${ORG}, 'invoicing:documents:read') ON CONFLICT DO NOTHING`

    await initSandboxPool()
    await initWorkerPool()

    await registerApps(
      [bundledDescriptor("shopify") as never, bundledDescriptor("invoicing") as never],
      ORG,
    )

    // Persist the webhook signing secret ENCRYPTED at rest, exactly as the
    // real OAuth callback path does -- the sandboxed verifier's config_get
    // bridge decrypts it back to plaintext using the manifest's
    // `connections.shop.clientSecretConfigKey`.
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
    await seedConfirmedBuyers()
  }, 60_000)

  afterAll(async () => {
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await sql`DELETE FROM app_invoicing.documents WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.issuer_profiles WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.deferred_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.counterparty_identities WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_shopify.webhook_deliveries WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_shopify.install_metadata WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${ORG} AND app_name = 'shopify'`
    await releaseTestLock()
  }, 60_000)

  it("an orders webhook carrying a PO results in an invoice whose po_number column holds it", async () => {
    const shopifyOrderId = "po-seam-order-1"
    const res = await postWebhook(
      "orders-create",
      {
        id: shopifyOrderId,
        name: "#PO-SEAM-1",
        currency: "EUR",
        total_price: "50.00",
        financial_status: "paid",
        po_number: "PO-SEAM-0001",
        customer: {
          id: 71001,
          email: "buyer1@po-seam.example",
          first_name: "Seam",
          last_name: "Buyer1",
        },
        billing_address: {
          company: "PO Seam Buyer SARL",
          address1: "1 rue Seam",
          zip: "75002",
          city: "Paris",
          country_code: "FR",
        },
        line_items: [
          {
            id: 81001,
            variant_id: 91001,
            title: "Widget",
            quantity: 1,
            price: "50.00",
            requires_shipping: true,
          },
        ],
      },
      `po-seam-webhook-order-1-${randomUUID()}`,
    )
    expect(res.status).toBe(200)

    const processed = await processOutboxBatch()
    expect(processed).toBeGreaterThan(0)
    await flushEventHandlers()

    const doc = await docByOrder(shopifyOrderId, "goods")
    expect(doc).not.toBeNull()
    // RED today: the PO is dropped because the producer emits `po_number` on
    // the order event while invoicing's adapter reads `event.poNumber`.
    expect(doc?.po_number).toBe("PO-SEAM-0001")
    // A French company with a confirmed identity: the order-paid invoice is an e-invoice.
    expect(doc?.regime).toBe("e_invoice")
  })

  it("an orders webhook with no PO results in a document with a null po_number, not an empty string", async () => {
    const shopifyOrderId = "po-seam-order-2"
    const res = await postWebhook(
      "orders-create",
      {
        id: shopifyOrderId,
        name: "#PO-SEAM-2",
        currency: "EUR",
        total_price: "40.00",
        financial_status: "paid",
        customer: {
          id: 71002,
          email: "buyer2@po-seam.example",
          first_name: "Seam",
          last_name: "Buyer2",
        },
        billing_address: {
          company: "PO Seam Buyer2 SARL",
          address1: "2 rue Seam",
          zip: "75002",
          city: "Paris",
          country_code: "FR",
        },
        line_items: [
          {
            id: 81002,
            variant_id: 91002,
            title: "Widget",
            quantity: 1,
            price: "40.00",
            requires_shipping: true,
          },
        ],
      },
      `po-seam-webhook-order-2-${randomUUID()}`,
    )
    expect(res.status).toBe(200)

    const processed = await processOutboxBatch()
    expect(processed).toBeGreaterThan(0)
    await flushEventHandlers()

    const doc = await docByOrder(shopifyOrderId, "goods")
    expect(doc).not.toBeNull()
    expect(doc?.po_number).toBeNull()
  })

  it("a draft order webhook carrying a PO puts it on the quote, and a later update changes it", async () => {
    const draftOrderNumericId = 92001
    const draftOrderId = `gid://shopify/DraftOrder/${draftOrderNumericId}`

    const createRes = await postWebhook(
      "draft-orders-create",
      {
        id: draftOrderNumericId,
        name: "#D-PO-SEAM-1",
        status: "open",
        currency: "EUR",
        // A real draft_orders webhook states the presentment currency
        // alongside the shop currency, and the amounts below are presentment
        // amounts. Without it the consumer cannot know the label matches the
        // money, so it re-reads the draft over the Shopify connection this
        // fixture deliberately does not have, and no quote is ever created.
        presentment_currency: "EUR",
        po_number: "PO-DRAFT-0001",
        email: "quotebuyer@po-seam.example",
        customer: {
          id: 73001,
          email: "quotebuyer@po-seam.example",
          first_name: "Quote",
          last_name: "Buyer",
        },
        billing_address: {
          company: "PO Seam Quote Buyer SARL",
          address1: "3 rue Seam",
          zip: "75002",
          city: "Paris",
          country_code: "FR",
        },
        line_items: [
          { id: 94001, variant_id: 95001, title: "Widget", quantity: 1, price: "60.00" },
        ],
      },
      `po-seam-webhook-draft-create-${randomUUID()}`,
    )
    expect(createRes.status).toBe(200)

    let processed = await processOutboxBatch()
    expect(processed).toBeGreaterThan(0)
    await flushEventHandlers()

    const created = await docByDraftOrder(draftOrderId)
    expect(created).not.toBeNull()
    // RED today for TWO independent reasons: (1) the producer emits
    // `po_number`, not the `poNumber` invoicing's NormalizedDraftOrder
    // interface declares consuming; (2) even setting that aside, invoicing's
    // syncQuoteFromDraftOrder never reads draft.poNumber at all -- it is
    // declared on the interface (shopify-draft-order.ts:119) but never
    // passed to quoteCreateAndIssue's po_number param.
    expect(created?.po_number).toBe("PO-DRAFT-0001")

    const updateRes = await postWebhook(
      "draft-orders-update",
      {
        id: draftOrderNumericId,
        name: "#D-PO-SEAM-1",
        status: "open",
        currency: "EUR",
        // A real draft_orders webhook states the presentment currency
        // alongside the shop currency, and the amounts below are presentment
        // amounts. Without it the consumer cannot know the label matches the
        // money, so it re-reads the draft over the Shopify connection this
        // fixture deliberately does not have, and no quote is ever created.
        presentment_currency: "EUR",
        po_number: "PO-DRAFT-0002",
        email: "quotebuyer@po-seam.example",
        customer: {
          id: 73001,
          email: "quotebuyer@po-seam.example",
          first_name: "Quote",
          last_name: "Buyer",
        },
        billing_address: {
          company: "PO Seam Quote Buyer SARL",
          address1: "3 rue Seam",
          zip: "75002",
          city: "Paris",
          country_code: "FR",
        },
        line_items: [
          { id: 94001, variant_id: 95001, title: "Widget", quantity: 1, price: "60.00" },
        ],
      },
      `po-seam-webhook-draft-update-${randomUUID()}`,
    )
    expect(updateRes.status).toBe(200)

    processed = await processOutboxBatch()
    expect(processed).toBeGreaterThan(0)
    await flushEventHandlers()

    const updated = await docByDraftOrder(draftOrderId)
    expect(updated).not.toBeNull()
    expect(updated?.id).toBe(created!.id)
    // RED today, same root causes as the create case above.
    expect(updated?.po_number).toBe("PO-DRAFT-0002")
  })

  it("a split order (goods and services) carries the PO onto BOTH documents", async () => {
    const shopifyOrderId = "po-seam-order-split"
    const res = await postWebhook(
      "orders-create",
      {
        id: shopifyOrderId,
        name: "#PO-SEAM-SPLIT",
        currency: "EUR",
        total_price: "90.00",
        financial_status: "paid",
        po_number: "PO-SEAM-SPLIT-01",
        customer: {
          id: 71003,
          email: "buyer3@po-seam.example",
          first_name: "Seam",
          last_name: "Buyer3",
        },
        billing_address: {
          company: "PO Seam Buyer3 SARL",
          address1: "4 rue Seam",
          zip: "75002",
          city: "Paris",
          country_code: "FR",
        },
        line_items: [
          {
            id: 81003,
            variant_id: 91003,
            title: "Physical Widget",
            quantity: 1,
            price: "50.00",
            requires_shipping: true,
          },
          {
            id: 81004,
            variant_id: 91004,
            title: "License Key",
            quantity: 1,
            price: "40.00",
            requires_shipping: false,
          },
        ],
      },
      `po-seam-webhook-order-split-${randomUUID()}`,
    )
    expect(res.status).toBe(200)

    const processed = await processOutboxBatch()
    expect(processed).toBeGreaterThan(0)
    await flushEventHandlers()

    const goods = await docByOrder(shopifyOrderId, "goods")
    const software = await docByOrder(shopifyOrderId, "software")
    expect(goods).not.toBeNull()
    expect(software).not.toBeNull()
    // RED today, same producer bug as journey 1 -- both splits read from the
    // same OrderPaidPayload.po_number, so both are null together.
    expect(goods?.po_number).toBe("PO-SEAM-SPLIT-01")
    expect(software?.po_number).toBe("PO-SEAM-SPLIT-01")
  })

  it("REGRESSION GUARD: the emitted order:created event carries poNumber, never po_number", async () => {
    const shopifyOrderId = "po-seam-order-casing-guard"
    const res = await postWebhook(
      "orders-create",
      {
        id: shopifyOrderId,
        name: "#PO-SEAM-CASING",
        currency: "EUR",
        total_price: "10.00",
        po_number: "PO-SEAM-CASING-01",
        customer: {
          id: 71004,
          email: "buyer4@po-seam.example",
          first_name: "Seam",
          last_name: "Buyer4",
        },
        line_items: [
          { id: 81005, variant_id: 91005, title: "Widget", quantity: 1, price: "10.00" },
        ],
      },
      `po-seam-webhook-order-casing-${randomUUID()}`,
    )
    expect(res.status).toBe(200)

    const data = await queuedEventData("order", "created", shopifyOrderId)
    // Event payloads (and the normalized shapes feeding them) are camelCase.
    // RED today: webhooks.ts's normalizeOrder emits `po_number` (snake_case)
    // into this camelCase-convention event.
    expect("poNumber" in data).toBe(true)
    expect("po_number" in data).toBe(false)
    expect(data.poNumber).toBe("PO-SEAM-CASING-01")
  })

  it("REGRESSION GUARD: the emitted draft_order:created event carries poNumber, never po_number", async () => {
    const draftOrderNumericId = 92002
    const draftOrderId = `gid://shopify/DraftOrder/${draftOrderNumericId}`
    const res = await postWebhook(
      "draft-orders-create",
      {
        id: draftOrderNumericId,
        name: "#D-PO-SEAM-CASING",
        status: "open",
        currency: "EUR",
        po_number: "PO-DRAFT-CASING-01",
        email: "casingbuyer@po-seam.example",
        line_items: [
          { id: 94002, variant_id: 95002, title: "Widget", quantity: 1, price: "20.00" },
        ],
      },
      `po-seam-webhook-draft-casing-${randomUUID()}`,
    )
    expect(res.status).toBe(200)

    const data = await queuedEventData("draft_order", "created", draftOrderId)
    // RED today: normalizeDraftOrderWebhook (bundled-apps/shopify/src/lib/
    // draft-order.ts:332-334) emits `po_number` (snake_case) into this
    // camelCase-convention event, the same producer bug as the order side.
    expect("poNumber" in data).toBe(true)
    expect("po_number" in data).toBe(false)
    expect(data.poNumber).toBe("PO-DRAFT-CASING-01")
  })

  it("REGRESSION GUARD (mirror): the documents_get TOOL RESULT carries po_number, never poNumber", async () => {
    const shopifyOrderId = "po-seam-order-tool-result-mirror"
    const res = await postWebhook(
      "orders-create",
      {
        id: shopifyOrderId,
        name: "#PO-SEAM-MIRROR",
        currency: "EUR",
        total_price: "15.00",
        financial_status: "paid",
        customer: {
          id: 71005,
          email: "buyer5@po-seam.example",
          first_name: "Seam",
          last_name: "Buyer5",
        },
        billing_address: {
          company: "PO Seam Buyer5 SARL",
          address1: "5 rue Seam",
          zip: "75002",
          city: "Paris",
          country_code: "FR",
        },
        line_items: [
          {
            id: 81006,
            variant_id: 91006,
            title: "Widget",
            quantity: 1,
            price: "15.00",
            requires_shipping: true,
          },
        ],
      },
      `po-seam-webhook-order-mirror-${randomUUID()}`,
    )
    expect(res.status).toBe(200)

    const processed = await processOutboxBatch()
    expect(processed).toBeGreaterThan(0)
    await flushEventHandlers()

    const doc = await docByOrder(shopifyOrderId, "goods")
    expect(doc).not.toBeNull()

    const toolRes = await executeTool<Record<string, unknown>>({
      toolName: "invoicing:documents_get",
      orgId: ORG,
      actor,
      params: { id: doc!.id },
    })
    const result = ((toolRes as { data?: Record<string, unknown> }).data ??
      (toolRes as { result?: Record<string, unknown> }).result ??
      toolRes) as Record<string, unknown>
    // Tool results, database columns and tool params are snake_case.
    expect("po_number" in result).toBe(true)
    expect("poNumber" in result).toBe(false)
  })
})
