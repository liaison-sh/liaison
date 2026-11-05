// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Walk D37: the commerce scenario says the live order's invoice "was issued by
// the order event itself", but order #1097 never had one: the demo's issuer
// profile was not mapped to the demo store, so invoicing's order auto-flow
// parked the order (`issuer_mapping_missing`). The agent's Boxtal draft was
// then refused (a shipment draft is anchored to an issued invoice) and the
// agent asked Finance to issue one by hand, an extra paid turn.
//
// This drives the real path: the injector delivers the order to the Shopify
// app's own orders/create handler on the demo store, the event goes through
// the real outbox to invoicing's real subscriber, and the invoice is read back
// from Postgres. The issuer row is the demo seed's (seed/tiers/demo/seed-commerce,
// mapped to the demo store).
//
// Walk 5 (D41): the agent then could not stage the order's shipment. Its line
// matched no seeded shipping profile (no parcel, no customs weight), and every
// quote said "Boxtal not connected". The second case stages it the way the
// agent does, on the demo seed's Boxtal catalog and the demo Boxtal
// connection, whose carrier is answered in-process.
//
// Walk 6 (D47): the booking was refused for a recipient with no phone unless
// the model copied it from the Shopify order: the draft now carries the
// order's ship-to, phone included, and the label stages without it.
//
// Walk 2026-10-26: asked to book the order "from its prepared draft as it is,
// with the cheapest carrier offer", the agent found the order's prep row
// unquoted (no offers, no cheapest) and a parcel leaving the EU (customs
// paperwork, "a change"), and asked instead of booking. The order now ships
// inside the EU, and its invoice being issued prepares the shipment: the
// To-prepare row is synced and quoted, so the cheapest offer is one read away.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db"
import { DurableConsumersTestAccess } from "~/infra/events/durable-consumers"
import { flushEventHandlers } from "~/infra/events/event-bus"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { installDemoBoxtalConnection } from "~/modules/demo/boxtal"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { installDemoShopifyConnection } from "~/modules/demo/shopify/connection"
import { resetDemoShopifyOverlay } from "~/modules/demo/shopify/overlay"
import { DEMO_SHOP_DOMAIN } from "~/modules/demo/shopify/sentinel"
import {
  COMMERCE_WORLD_ORDER_NUMBER,
  commerceOrderInjector,
  worldOrder,
} from "~/modules/demo/world/commerce-order"
import { registerDemoWorldConsumer } from "~/modules/demo/world/consumer"
import { demoBoxtalSender, demoShippingProfiles } from "~/seed/tiers/demo/boxtal-catalog"
import { DEMO_WORLD } from "~/seed/world/fiction"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..")

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

// A fresh org per run: the store's webhook ids and the app's own dedupe are per org.
const ORG = randomUUID()
const USER = randomUUID()

interface DocRow {
  id: string
  type: string
  status: string
  shopify_order_number: string | null
}

const invoicesForWorldOrder = () =>
  sql<DocRow[]>`SELECT id, type, status, shopify_order_number FROM app_invoicing.documents
    WHERE org_id = ${ORG} AND shopify_order_number LIKE ${`%${COMMERCE_WORLD_ORDER_NUMBER}`}`

const quotesForWorldOrder = () =>
  sql<Array<{ document_ref: string }>>`SELECT q.document_ref FROM app_boxtal.prep_quote q
    JOIN app_invoicing.documents d ON d.id::text = q.document_ref::text
    WHERE q.org_id = ${ORG} AND d.shopify_order_number LIKE ${`%${COMMERCE_WORLD_ORDER_NUMBER}`}`

const parks = () =>
  sql<Array<{ status: string; reason: string }>>`SELECT status, reason
    FROM app_invoicing.deferred_events WHERE org_id = ${ORG}`

interface PrepRow {
  order_key: string
  document_ref: string | null
  state: string
  reason?: string
  parcels: unknown[]
  quote: { cheapest: { offer_code: string; price_ttc_minor: number } | null; offers: unknown[] }
}

const agentActor = () => ({
  actorType: "user" as const,
  userId: USER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
})

const runAsAgent = <T>(tool: string, params: Record<string, unknown>) =>
  executeTool<T>({
    toolName: tool,
    orgId: ORG,
    actor: agentActor(),
    params,
    origin: "in-app-agent",
  })

/** What the agent reads about the order: its invoice links, and its prep row. */
async function linksAndRow(orderId: string, orderKey: string) {
  const links = await runAsAgent<{ links: Array<{ order_id: string; invoice_id: string }> }>(
    "shopify:orders_invoice_links",
    { order_ids: [orderId] },
  )
  const prep = await runAsAgent<{ rows: PrepRow[] }>("boxtal:prep_list", { order_keys: [orderKey] })
  return { links: links.data?.links ?? [], row: prep.data?.rows[0] }
}

describe("the commerce scenario's live order (walk D37)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    DemoModeTestAccess.set(true)
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'D37 Demo Org', ${`d37-demo-${ORG.slice(0, 8)}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${USER}, ${ORG}, ${`d37-${ORG.slice(0, 8)}@test.com`}, 'hash', 'D37 Visitor', 'active')`
    // The demo world's consumer, which prepares the live order's shipment once
    // its invoice is issued (the outbox runs it, as on the demo box).
    registerDemoWorldConsumer()
    await markOrgAsDemo(ORG, visitorMarker(24))
    invalidateDemoMarker(ORG)
    await initSandboxPool()
    await initWorkerPool()
    await registerApps(
      [
        bundledDescriptor("shopify") as never,
        bundledDescriptor("invoicing") as never,
        bundledDescriptor("boxtal") as never,
      ],
      ORG,
    )
    await installDemoShopifyConnection({ orgId: ORG, createdByUserId: USER })
    await installDemoBoxtalConnection({ orgId: ORG, createdByUserId: USER })
    // The demo seed's Boxtal catalog (seed/tiers/demo/seed-commerce.ts seedBoxtal).
    for (const { sku: _sku, ...p } of demoShippingProfiles(DEMO_WORLD.catalog)) {
      await sql`INSERT INTO app_boxtal.shipping_profile
        (id, org_id, product_source, product_id, unit_weight, solo_length, solo_width,
         solo_height, content_category, accessory)
        VALUES (gen_random_uuid(), ${ORG}, ${p.product_source}, ${p.product_id}, ${p.unit_weight},
                ${p.solo_length}, ${p.solo_width}, ${p.solo_height}, ${p.content_category},
                ${p.accessory})`
    }
    await sql`INSERT INTO app_boxtal.app_config (id, org_id, key, value)
      VALUES (gen_random_uuid(), ${ORG}, 'sender_address', ${JSON.stringify(demoBoxtalSender())}::jsonb)`
    // The demo seed's issuer (seed/tiers/demo/seed-commerce.ts): French, EUR, an
    // approval threshold of EUR 5,000, and mapped to the demo store.
    await sql`INSERT INTO app_invoicing.issuer_profiles
      (id, org_id, legal_name, country, vat_id, default_currency, shopify_shop_id,
       invoice_approval_threshold_minor)
      VALUES (gen_random_uuid(), ${ORG}, 'Resonant Audio Labs SAS', 'FR', 'FR41903000008', 'EUR',
              ${DEMO_SHOP_DOMAIN}, 500000)`
  }, 120_000)

  afterAll(async () => {
    resetDemoShopifyOverlay(ORG)
    DurableConsumersTestAccess.reset()
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    DemoModeTestAccess.set(null)
    await releaseTestLock()
  })

  it("arrives with its invoice, issued by the order event, as the scenario says", async () => {
    await commerceOrderInjector.injectWorldEvent({
      orgId: ORG,
      ownerUserId: USER,
      tourId: "kernel.scenario-commerce",
      beatId: "live-order",
      run: 0,
      runStartedAt: new Date(),
    })
    // Read before the invoice is issued: no invoice yet. The reads after it
    // (the next case) must show it, whatever caches this first read filled.
    const order = worldOrder()
    const before = await linksAndRow(order.id, `so:${order.numericId}`)
    expect(before.links).toEqual([])
    expect(before.row?.document_ref ?? null).toBeNull()
    for (let i = 0; i < 10 && (await invoicesForWorldOrder()).length === 0; i++) {
      await processOutboxBatch()
      await flushEventHandlers()
    }
    // The issued event itself, which prepares the shipment.
    for (let i = 0; i < 5 && (await quotesForWorldOrder()).length === 0; i++) {
      await processOutboxBatch()
      await flushEventHandlers()
    }
    const docs = await invoicesForWorldOrder()
    expect(docs.length, `parked instead: ${JSON.stringify(await parks())}`).toBeGreaterThan(0)
    for (const doc of docs) {
      expect(doc.type).toBe("invoice")
      expect(doc.status).toBe("issued")
    }
    // Nothing waits on configuration or data. (The PDF of an issued invoice
    // renders through file storage this suite does not stand up: a
    // render_failed park is retried by the app's own job, and the issued
    // invoice is what the shipment draft anchors to.)
    const blocking = (await parks()).filter((p) => p.status !== "render_failed")
    expect(blocking).toEqual([])
  }, 120_000)

  // Walk 2026-10-26 (2): the agent read the order by its number, and both
  // reads said "no invoice issued" for an order whose invoice was issued 15 s
  // before: orders_invoice_links dropped every id that was not a gid, and a
  // prep row asked for as so:<number> or so:<gid> was looked up under that
  // key, so it found no invoice, no parcels and no quote. Every way the agent
  // names the order now reads the issued invoice and the prepared row.
  it("shows the issued invoice and its prepared row however the order is named", async () => {
    const [invoice] = await invoicesForWorldOrder()
    expect(invoice).toBeDefined()
    const order = worldOrder()
    const names = [
      order.id,
      String(order.numericId),
      order.name,
      String(COMMERCE_WORLD_ORDER_NUMBER),
      `gid://shopify/Order/${COMMERCE_WORLD_ORDER_NUMBER}`,
    ]
    for (const name of names) {
      const { links, row } = await linksAndRow(name, `so:${name}`)
      expect(links, `orders_invoice_links(${name})`).toEqual([
        expect.objectContaining({ order_id: name, invoice_id: invoice!.id }),
      ])
      expect(row?.order_key, `prep_list(so:${name})`).toBe(`so:${order.numericId}`)
      expect(row?.document_ref, `prep_list(so:${name}): ${row?.reason}`).toBe(invoice!.id)
      expect(row!.parcels.length).toBeGreaterThan(0)
      expect(row!.quote.offers.length).toBeGreaterThan(0)
    }
  }, 120_000)

  it("ships inside the EU, its shipment prepared and quoted, booked from the cheapest offer", async () => {
    const [invoice] = await invoicesForWorldOrder()
    expect(invoice).toBeDefined()
    const actor = {
      actorType: "user" as const,
      userId: USER,
      orgId: ORG,
      scopes: ["*"],
      dimensionGrants: {},
    }
    const run = <T>(tool: string, params: Record<string, unknown>) =>
      executeTool<T>({
        toolName: `${tool.includes(":") ? "" : "boxtal:"}${tool}`,
        orgId: ORG,
        actor,
        params,
        origin: "in-app-agent",
      })

    // The order reads by the number the visitor and the agent call it by, and
    // by a gid built from that number, not only by its id.
    const order = worldOrder()
    for (const id of [
      order.name,
      String(COMMERCE_WORLD_ORDER_NUMBER),
      `gid://shopify/Order/${COMMERCE_WORLD_ORDER_NUMBER}`,
    ]) {
      const got = (await run<{ id: string }>("shopify:orders_get", { id })).data
      expect(got.id, `orders_get(${id})`).toBe(order.id)
    }
    expect(order.shippingAddress.countryCode).toBe("DE")

    // The To-prepare row was synced when the invoice was issued: quoted, with
    // a cheapest offer, and nothing to fix.
    const listed = (
      await run<{ rows: PrepRow[] }>("prep_list", { order_keys: [`so:${order.numericId}`] })
    ).data
    const row = listed.rows.find((r) => r.order_key === `so:${order.numericId}`)
    expect(row, JSON.stringify(listed)).toBeDefined()
    expect(row!.state, row!.reason).toBe("ready")
    expect(row!.document_ref).toBe(invoice!.id)
    expect(row!.parcels.length).toBeGreaterThan(0)
    expect(row!.quote.offers.length).toBeGreaterThan(0)
    const cheapest = row!.quote.cheapest!
    expect(cheapest).toBeTruthy()

    interface Draft {
      draft_id: string
      parcels: Array<{ weight: number }>
      customsArticles: unknown[]
      unresolved: unknown[]
      recipient_address: Record<string, string | null> | null
    }
    // The issue-time sync above already wrote the order's ship-to onto the
    // recipient's contact (prep_sync does, by design, as a system job that
    // raises no approval). Take it off again so the assertion below proves
    // that staging the booking never writes it back.
    await sql`UPDATE kernel.contacts SET metadata = metadata - 'shipping_address'
      WHERE org_id = ${ORG} AND metadata ? 'shipping_address'`

    // Walk D47: the recipient's phone and full address are on the draft, read
    // from the order's ship-to: the agent stages the label without copying them.
    const draft = (await run<Draft>("shipment_draft_get", { draft_id: row!.document_ref })).data
    const address = order.shippingAddress
    expect(draft.recipient_address).toMatchObject({
      phone: address.phone,
      street: address.address1,
      city: address.city,
      postalCode: address.zip,
      countryIsoCode: address.countryCode,
    })
    expect(draft.unresolved).toEqual([])
    for (const p of draft.parcels) expect(p.weight).toBeGreaterThan(0)

    // Booked as it is, from the row's cheapest offer: one gated label.
    const staged = await run("create_shipment", {
      draft_id: row!.document_ref,
      offer_code: cheapest.offer_code,
      quoted_price_ttc: cheapest.price_ttc_minor / 100,
    })
    // The label is never bought inline: it waits for a person's approval.
    expect(staged.blocked?.approvalRequestId).toBeTruthy()
    // Walk D59: the booking is the scenario's one approval. Staging it never
    // writes the recipient's contact: every build of the draft (each quote,
    // rate check and staged booking) wrote the ship-to there, and in a
    // conversation whose writes park, each write was one more approval.
    const approvals = await sql<Array<{ tool_name: string }>>`SELECT tool_name
      FROM kernel.approval_requests WHERE org_id = ${ORG}`
    expect(approvals.map((a) => a.tool_name)).toEqual(["boxtal:create_shipment"])
    const written = await sql<Array<{ id: string }>>`SELECT id FROM kernel.contacts
      WHERE org_id = ${ORG} AND metadata ? 'shipping_address'`
    expect(written).toHaveLength(0)
  }, 120_000)

  // Last: a sync writes the order's ship-to onto its contact, which the
  // booking case above proves staging never does (it clears the address the
  // issue-time sync wrote, then stages).
  it("syncs the row prep_sync is asked for by the order's name", async () => {
    const [invoice] = await invoicesForWorldOrder()
    const synced = await runAsAgent<{ rows: Array<{ document_ref: string }> }>("boxtal:prep_sync", {
      order_keys: [`so:${worldOrder().name}`],
    })
    expect(synced.blocked ?? null).toBeNull()
    expect(synced.data?.rows.map((r) => r.document_ref)).toEqual([invoice!.id])
  }, 120_000)
})
