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
import { afterAll, afterEach, beforeAll, describe, expect, it, setSystemTime } from "bun:test"
import { createHmac, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { app } from "~/app"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { flushEventHandlers } from "~/infra/events/event-bus"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import { dispatchAppJobWithContext } from "~/infra/jobs/job-context"
import { JobsTestAccess } from "~/infra/jobs/jobs"
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

    // The webhook is only accepted from a shop this org connected.
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${ORG} AND app_name = 'shopify'`
    await sql`INSERT INTO kernel.connected_accounts (
        id, org_id, app_name, connection_name, owner_type, owner_id,
        provider_type, identifier, status, created_by, access_token_encrypted
      ) VALUES (
        ${randomUUID()}, ${ORG}, 'shopify', 'shop', 'org', NULL,
        'oauth2', ${SHOP_DOMAIN}, 'active', ${USER}, 'encrypted-token'
      )`

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
    await releaseTestLock()
  }, 60_000)

  // Handlers run in QuickJS, which has no `Intl`: only this path, the real one, could tell that the
  // order flow's year was always UTC. The webhook arrives under the real clock, then the clock moves
  // to the instant the outbox hands the order to invoicing.
  describe("the issue date of an order is the issuer's", () => {
    const orderBody = (id: string, suffix: string) => ({
      id,
      name: `#TZ-${suffix}`,
      currency: "EUR",
      total_price: "50.00",
      financial_status: "paid",
      customer: {
        id: 71000,
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
          id: 81900,
          variant_id: 91900,
          title: "Widget",
          quantity: 1,
          price: "50.00",
          requires_shipping: true,
        },
      ],
    })
    const setIssuerZone = (zone: string) =>
      sql`UPDATE app_invoicing.issuer_profiles SET timezone = ${zone} WHERE org_id = ${ORG} AND shopify_shop_id = ${SHOP_DOMAIN}`

    afterEach(async () => {
      setSystemTime()
      await setIssuerZone("UTC")
    })

    it("00:20 on 1 January in Paris: the order's invoice is dated 2027 and numbered in 2027", async () => {
      const orderId = "tz-seam-order-1"
      await setIssuerZone("Europe/Paris")
      expect(
        (await postWebhook("orders-create", orderBody(orderId, "1"), `tz-seam-1-${randomUUID()}`))
          .status,
      ).toBe(200)

      setSystemTime(new Date("2026-12-31T23:20:00Z"))
      expect(await processOutboxBatch()).toBeGreaterThan(0)
      await flushEventHandlers()

      const [row] = await sql<Array<{ d: string; year_of_issue: number; number: string }>>`
        SELECT to_char(issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d, year_of_issue, number
        FROM app_invoicing.documents WHERE org_id = ${ORG} AND shopify_order_id = ${orderId}`
      expect(row).toMatchObject({ d: "2027-01-01", year_of_issue: 2027 })
      expect(row?.number).toContain("2027")
    })

    const paidDate = async (orderId: string) => {
      const [row] = await sql<Array<{ paid: string | null; issued: string }>>`
        SELECT to_char(paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS paid,
               to_char(issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS issued
        FROM app_invoicing.documents WHERE org_id = ${ORG} AND shopify_order_id = ${orderId}`
      return row
    }

    it("a paid order placed at 00:20 on 1 January in Paris is paid on 1 January", async () => {
      const orderId = "tz-seam-order-3"
      await setIssuerZone("Europe/Paris")
      const body = { ...orderBody(orderId, "3"), created_at: "2026-12-31T23:20:00Z" }
      expect((await postWebhook("orders-create", body, `tz-seam-3-${randomUUID()}`)).status).toBe(
        200,
      )
      setSystemTime(new Date("2026-12-31T23:20:00Z"))
      expect(await processOutboxBatch()).toBeGreaterThan(0)
      await flushEventHandlers()
      expect(await paidDate(orderId)).toEqual({ paid: "2027-01-01", issued: "2027-01-01" })
    })

    it("a paid order with no date of its own is paid on the issuer's date", async () => {
      const orderId = "tz-seam-order-4"
      await setIssuerZone("Europe/Paris")
      expect(
        (await postWebhook("orders-create", orderBody(orderId, "4"), `tz-seam-4-${randomUUID()}`))
          .status,
      ).toBe(200)
      setSystemTime(new Date("2026-12-31T23:20:00Z"))
      expect(await processOutboxBatch()).toBeGreaterThan(0)
      await flushEventHandlers()
      expect(await paidDate(orderId)).toEqual({ paid: "2027-01-01", issued: "2027-01-01" })
    })

    describe("a draft order refused for its zone waits, and is not lost", () => {
      const draftBody = (id: number, name: string, price: string, po?: string) => ({
        id,
        name,
        status: "open",
        currency: "EUR",
        presentment_currency: "EUR",
        ...(po ? { po_number: po } : {}),
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
        line_items: [{ id: id + 1, variant_id: 95001, title: "Widget", quantity: 1, price }],
      })
      const deliver = async (topic: string, body: unknown) => {
        expect((await postWebhook(topic, body, `tz-draft-${randomUUID()}`)).status).toBe(200)
        expect(await processOutboxBatch()).toBeGreaterThan(0)
        await flushEventHandlers()
      }
      const parksOf = (gid: string) =>
        sql<
          Array<{
            status: string
            reason: string | null
            event_payload_json: {
              kind?: string
              order_number?: string
              draft?: { lineItems?: Array<{ unitPrice?: string }> }
            }
            blocked_on: { kind?: string }
          }>
        >`SELECT status, reason, event_payload_json, blocked_on FROM app_invoicing.deferred_events
          WHERE org_id = ${ORG} AND event_id = ${gid}`
      const runDeferredRetry = async () => {
        const handler = JobsTestAccess.getHandler("invoicing", "deferred-retry")
        if (!handler) throw new Error("deferred-retry job handler not registered")
        await dispatchAppJobWithContext(
          handler,
          { orgId: ORG },
          { actorType: "system", orgId: ORG, purpose: "job", scopes: ["invoicing:*"] },
          "ambient",
        )
      }
      /**
       * A sweep at this instant of the host's clock, which is the one the issue date reads. The
       * job's own clock, in the sandbox, stays real, so a park tried before is made due by hand.
       */
      const sweepAt = async (iso: string, gid: string) => {
        await sql`UPDATE app_invoicing.deferred_events SET retried_at = now() - interval '1 day'
          WHERE org_id = ${ORG} AND event_id = ${gid}`
        setSystemTime(new Date(iso))
        await runDeferredRetry()
      }
      const quotes = (gid: string) =>
        sql<
          Array<{ number: string; year_of_issue: number; po_number: string | null; total: string }>
        >`
          SELECT number, year_of_issue, po_number, subtotal_minor::text AS total
          FROM app_invoicing.documents WHERE org_id = ${ORG} AND shopify_draft_order_id = ${gid}`
      const quoteSequences = () =>
        sql<Array<{ key: string; value: string }>>`
          SELECT key, value::text FROM kernel.app_sequences
          WHERE org_id = ${ORG} AND key LIKE 'invoicing:doc_number:%:quote:%' ORDER BY key`

      it("parks with its arguments, takes no number, and becomes a quote once the zone is fixed", async () => {
        const gid = "gid://shopify/DraftOrder/92101"
        const before = await quoteSequences()
        await setIssuerZone("Europe/Atlantis")
        await deliver("draft-orders-create", draftBody(92101, "#D-TZ-1", "60.00", "PO-TZ-1"))

        expect((await quotes(gid)).length).toBe(0)
        expect(await quoteSequences()).toEqual(before)
        const [park, ...others] = await parksOf(gid)
        expect(others).toEqual([])
        expect(park).toMatchObject({
          status: "awaiting_config",
          reason: "issuer_timezone_invalid",
          blocked_on: { kind: "issuer_timezone" },
          event_payload_json: { order_number: "#D-TZ-1" },
        })

        // Still broken: a sweep keeps it waiting, and still no number.
        await sweepAt("2026-12-01T10:00:00Z", gid)
        expect((await parksOf(gid))[0]?.status).toBe("awaiting_config")
        expect((await quotes(gid)).length).toBe(0)

        await setIssuerZone("Europe/Paris")
        await sweepAt("2026-12-31T23:20:00Z", gid)
        const [quote, ...more] = await quotes(gid)
        expect(more).toEqual([])
        expect(quote).toMatchObject({ year_of_issue: 2027, po_number: "PO-TZ-1" })
        expect(quote?.number).toContain("2027")
        expect((await parksOf(gid))[0]?.status).toBe("resolved")

        // A later sweep has nothing left to do: one quote stays one quote.
        await sweepAt("2027-02-01T10:00:00Z", gid)
        expect((await quotes(gid)).length).toBe(1)
      })

      it("a later update while it waits refreshes the one park, and the quote has the last lines", async () => {
        const gid = "gid://shopify/DraftOrder/92102"
        await setIssuerZone("Europe/Atlantis")
        await deliver("draft-orders-create", draftBody(92102, "#D-TZ-2", "60.00"))
        await deliver("draft-orders-update", draftBody(92102, "#D-TZ-2", "75.00"))
        const parks = await parksOf(gid)
        expect(parks.length).toBe(1)
        expect(parks[0]?.event_payload_json.draft?.lineItems?.[0]?.unitPrice).toBe("75.00")

        await setIssuerZone("Europe/Paris")
        await sweepAt("2026-12-01T10:00:00Z", gid)
        const [quote] = await quotes(gid)
        expect(quote?.total).toBe("7500")
      })

      it("a draft order deleted while it waits closes the park, and no quote appears", async () => {
        const gid = "gid://shopify/DraftOrder/92103"
        await setIssuerZone("Europe/Atlantis")
        await deliver("draft-orders-create", draftBody(92103, "#D-TZ-3", "60.00"))
        expect((await parksOf(gid))[0]?.status).toBe("awaiting_config")
        await deliver("draft-orders-delete", { id: 92103 })
        expect((await parksOf(gid))[0]?.status).toBe("resolved")

        await setIssuerZone("Europe/Paris")
        await sweepAt("2026-12-01T10:00:00Z", gid)
        expect((await quotes(gid)).length).toBe(0)
      })

      it("an update after the zone was fixed makes the quote, and the sweep does not overwrite it", async () => {
        const gid = "gid://shopify/DraftOrder/92104"
        await setIssuerZone("Europe/Atlantis")
        await deliver("draft-orders-create", draftBody(92104, "#D-TZ-4", "60.00"))
        await setIssuerZone("Europe/Paris")
        await deliver("draft-orders-update", draftBody(92104, "#D-TZ-4", "80.00"))
        expect((await quotes(gid))[0]?.total).toBe("8000")
        await sweepAt("2026-12-01T10:00:00Z", gid)
        expect((await quotes(gid)).map((q) => q.total)).toEqual(["8000"])
      })
    })

    it("an unknown zone parks the order on the config and takes no number", async () => {
      const orderId = "tz-seam-order-2"
      await setIssuerZone("Europe/Atlantis")
      expect(
        (await postWebhook("orders-create", orderBody(orderId, "2"), `tz-seam-2-${randomUUID()}`))
          .status,
      ).toBe(200)
      expect(await processOutboxBatch()).toBeGreaterThan(0)
      await flushEventHandlers()

      const docs =
        await sql`SELECT id FROM app_invoicing.documents WHERE org_id = ${ORG} AND shopify_order_id = ${orderId}`
      expect(docs.length).toBe(0)
      const parks = await sql`
        SELECT status, reason FROM app_invoicing.deferred_events WHERE org_id = ${ORG} AND event_id = ${orderId}`
      expect([...parks]).toEqual([{ status: "awaiting_config", reason: "issuer_timezone_invalid" }])
    })

    it("an order parked on an unknown zone issues once the zone is fixed", async () => {
      const orderId = "tz-seam-order-5"
      await setIssuerZone("Europe/Atlantis")
      expect(
        (await postWebhook("orders-create", orderBody(orderId, "5"), `tz-seam-5-${randomUUID()}`))
          .status,
      ).toBe(200)
      expect(await processOutboxBatch()).toBeGreaterThan(0)
      await flushEventHandlers()
      await setIssuerZone("Europe/Paris")

      const handler = JobsTestAccess.getHandler("invoicing", "deferred-retry")
      if (!handler) throw new Error("deferred-retry job handler not registered")
      setSystemTime(new Date("2026-12-31T23:20:00Z"))
      await dispatchAppJobWithContext(
        handler,
        { orgId: ORG },
        { actorType: "system", orgId: ORG, purpose: "job", scopes: ["invoicing:*"] },
        "ambient",
      )
      const parks = await sql`
        SELECT status, reason FROM app_invoicing.deferred_events WHERE org_id = ${ORG} AND event_id = ${orderId}`
      expect([...parks]).toContainEqual({ status: "resolved", reason: "issuer_timezone_invalid" })
      expect(await paidDate(orderId)).toEqual({ paid: "2027-01-01", issued: "2027-01-01" })
    })
  })

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
