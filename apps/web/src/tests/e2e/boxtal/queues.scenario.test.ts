// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 18 e2e — the operational-queue read tools that back the redesigned
// BoxtalSidebar + queue views: `to_prepare_list`, `ready_list`, `returns_list`,
// `queue_counts`. These exercise the REAL surfaces (no UI mocks):
//
//   S-Q1  to_prepare_list + queue_counts — issue two real invoices (one with a
//         profiled hardware line, one unprofiled) and assert the cross-app
//         `invoicing:documents_search` enumeration + the ready/needs-fix
//         classification (via the live draft resolver). A shipment for one
//         invoice then EXCLUDES it from the queue (the "no live shipment" join).
//
//   S-Q2  ready_list + returns_list — seed `shipment` link-store rows (CONFIRMED
//         outbound w/ LABEL, PENDING, CANCELLED, and two returns) and assert each
//         tool filters + projects correctly, plus the `queue_counts` badges.
import { existsSync } from "node:fs"
import { api } from "@liaison/test-helpers"
import { installInvoicingApp } from "../invoicing/helpers/install-invoicing-app"
import { installShopifyApp } from "../shopify/helpers/install-shopify-app"
import {
  assertBoxtalBundle,
  BOXTAL_BUNDLE,
  expect,
  INVOICING_BUNDLE,
  test,
} from "./_boxtal-fixtures"
import { installBoxtalApp } from "./helpers/install-boxtal-app"
import { resetMock } from "./helpers/mock-boxtal"
import { numericOrderId, seedOpenOrders } from "./helpers/seed-shipment"

function unwrap(body: unknown): Record<string, unknown> {
  const b = (body ?? {}) as Record<string, unknown>
  return "data" in b && b.data && typeof b.data === "object"
    ? (b.data as Record<string, unknown>)
    : b
}

async function callTool(
  serverUrl: string,
  token: string,
  app: "boxtal" | "invoicing",
  tool: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const resp = await api(serverUrl, `/api/apps/${app}/tools/${tool}`, {
    method: "POST",
    token,
    body: { params },
  })
  return { status: resp.status, ...unwrap(resp.body) }
}

const LINE_A = {
  position: 1,
  description: "Kestrel 2 controller",
  quantity: "1",
  unit_price_minor: "25000",
  product_source: "shopify",
  external_id: "VARIANT-AAA",
}
const LINE_B = {
  position: 1,
  description: "Eurorack module",
  quantity: "1",
  unit_price_minor: "12000",
  product_source: "shopify",
  external_id: "VARIANT-BBB",
}
const CUSTOMS_AAA = {
  product_source: "shopify",
  external_id: "VARIANT-AAA",
  hs_code: "92071000",
  country_of_origin: "CN",
  customs_description: "Electronic musical instrument controller",
}
const CUSTOMS_BBB = {
  product_source: "shopify",
  external_id: "VARIANT-BBB",
  hs_code: "85437090",
  country_of_origin: "CN",
  customs_description: "Synthesizer module",
}

async function assignCustoms(s: string, token: string, overlay: typeof CUSTOMS_AAA): Promise<void> {
  const resp = await api(s, "/api/apps/invoicing/tools/hs_codes_assign", {
    method: "POST",
    token,
    body: { params: overlay },
  })
  expect(resp.status, JSON.stringify(resp.body)).toBe(200)
}

async function issueUsInvoice(
  s: string,
  token: string,
  issuerProfileId: string,
  contactId: string,
  lines: Array<Record<string, unknown>>,
  shopifyOrderId?: string,
): Promise<string> {
  const resp = await api(s, "/api/apps/invoicing/tools/invoice_create_and_issue", {
    method: "POST",
    token,
    body: {
      params: {
        counterparty: {
          contact_id: contactId,
          legal_name: "Globex US",
          country: "US",
          vat_id: null,
          address: "1 Times Sq, New York, NY 10036, US",
          email: "globex-us@e2e.test",
        },
        issuer_profile_id: issuerProfileId,
        currency: "EUR",
        incoterm: "DAP",
        // The worklist is ORDER-driven since boxtal 0.10.0: an invoice reaches it as the ANCHOR of
        // an open Shopify order, so it has to be linked to one.
        ...(shopifyOrderId ? { shopify_order_id: shopifyOrderId } : {}),
        items: lines,
      },
    },
  })
  expect(resp.status, JSON.stringify(resp.body)).toBe(200)
  const payload = unwrap(resp.body)
  const documentId =
    (payload.document_id as string | undefined) ??
    (payload.result as { document_id?: string } | undefined)?.document_id
  expect(documentId, JSON.stringify(payload)).toBeTruthy()
  return documentId as string
}

interface ToPrepareRow {
  id: string
  invoice_ref: string
  customer: string
  destination: string
  items: number
  weight: number | null
  prep_status: "ready_to_prepare" | "needs_fix"
  reason?: string
}
interface ReadyRow {
  id: string
  recipient: string
  carrier: string | null
  tracking_number: string | null
  cost: number | null
  order_status: string | null
  has_label: boolean
  invoice_ref: string | null
}
interface ReturnRow {
  id: string
  customer: string
  reason: string | null
  proforma_ref: string | null
  order_status: string | null
  tracking_status: string | null
  label_ready: boolean
  created_by: "agent" | "user"
}

test.describe("Boxtal: operational queue read tools", () => {
  // The to-prepare worklist is the set of OPEN SHOPIFY ORDERS since boxtal 0.10.0, so S-Q1 needs
  // the offline Shopify mock. This checkout's `.env.test` sets SHOPIFY_E2E_LIVE=1 for the
  // shopify and invoicing real-dev-store scenarios; unset it for this file and put it back afterwards.
  const LIVE_BEFORE = process.env.SHOPIFY_E2E_LIVE ?? "1"
  let offlineArmed = false
  async function useOfflineShopify(env: {
    restart: (o: Record<string, unknown>) => Promise<void>
  }) {
    if (offlineArmed) return
    await env.restart({ env: { SHOPIFY_E2E_LIVE: "0" }, timeoutMs: 180_000 })
    offlineArmed = true
  }
  test.afterAll(async ({ env }) => {
    if (!offlineArmed) return
    await env.restart({ env: { SHOPIFY_E2E_LIVE: LIVE_BEFORE }, timeoutMs: 180_000 })
  })

  test("S-Q1: to_prepare_list enumerates open orders, classifies ready vs needs-fix, and drops a fulfilled one", async ({
    env,
    world,
    qa,
  }) => {
    assertBoxtalBundle()
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)
    const token = qa.admin.token
    const s = env.serverUrl
    await useOfflineShopify(env as never)
    await resetMock(s, token)

    const invoicing = await installInvoicingApp({
      serverUrl: s,
      token,
      orgId: world.org.id,
      bundlePath: INVOICING_BUNDLE,
      issuerCountry: "FR",
      additionalContacts: [
        { country: "US", name: "Globex US", email: "globex-q1@e2e.test", customerKind: "business" },
      ],
    })
    const contactId = invoicing.additionalContactIds[0]

    // Profile VARIANT-AAA only → invoice A is resolvable (ready), invoice B (the
    // unprofiled VARIANT-BBB) is a physical line with no profile → needs-fix.
    await installBoxtalApp({
      serverUrl: s,
      token,
      orgId: world.org.id,
      bundlePath: BOXTAL_BUNDLE,
      seedSenderAddress: {
        name: "Fabrikam SAS",
        phone: "+33123456789",
        street: "12 Rue de la Paix",
        city: "Paris",
        postalCode: "75002",
        countryIsoCode: "FR",
      },
      seedShippingProfiles: [
        {
          product_source: "shopify",
          product_id: "VARIANT-AAA",
          unit_weight: 0.8,
          solo_length: 30,
          solo_width: 20,
          solo_height: 12,
        },
      ],
    })

    await installShopifyApp({ serverUrl: s, token, orgId: world.org.id })
    await assignCustoms(s, token, CUSTOMS_AAA)
    await assignCustoms(s, token, CUSTOMS_BBB)
    // One open, unfulfilled order per invoice: the row identity the worklist is built on.
    const US_SHIP_TO = {
      name: "Globex US",
      address1: "1 Times Sq",
      city: "New York",
      zip: "10036",
      country: "United States",
      countryCode: "US",
      phone: "+12125550001",
    }
    const [gidA, gidB] = await seedOpenOrders(s, token, [
      {
        name: "#Q1001",
        email: "globex-q1@e2e.test",
        customerName: "Globex US",
        shippingAddress: US_SHIP_TO,
      },
      {
        name: "#Q1002",
        email: "globex-q1@e2e.test",
        customerName: "Globex US",
        shippingAddress: US_SHIP_TO,
      },
    ])
    const invA = await issueUsInvoice(
      s,
      token,
      invoicing.primaryIssuerProfileId,
      contactId,
      [LINE_A],
      numericOrderId(gidA!),
    )
    const invB = await issueUsInvoice(
      s,
      token,
      invoicing.primaryIssuerProfileId,
      contactId,
      [LINE_B],
      numericOrderId(gidB!),
    )

    // to_prepare_list — REAL cross-app enumeration + resolver classification.
    const listResp = await callTool(s, token, "boxtal", "to_prepare_list", {})
    expect(listResp.status, JSON.stringify(listResp)).toBe(200)
    const rows = (listResp.rows as ToPrepareRow[]) ?? []
    const rowA = rows.find((r) => r.id === invA)
    const rowB = rows.find((r) => r.id === invB)
    expect(rowA, `invoice A in to_prepare: ${JSON.stringify(rows)}`).toBeTruthy()
    expect(rowB, `invoice B in to_prepare: ${JSON.stringify(rows)}`).toBeTruthy()
    // A: profiled → ready_to_prepare, resolved parcel weight present, no reason.
    expect(rowA?.prep_status).toBe("ready_to_prepare")
    expect(rowA?.customer).toBe("Globex US")
    expect(rowA?.destination).toBe("US")
    expect((rowA?.weight ?? 0) > 0).toBe(true)
    expect(rowA?.reason).toBeFalsy()
    // B: unprofiled physical line → needs-fix with a concrete reason.
    expect(rowB?.prep_status).toBe("needs_fix")
    expect(rowB?.reason, JSON.stringify(rowB)).toBeTruthy()

    // queue_counts reflects ≥2 to-prepare.
    const counts = await callTool(s, token, "boxtal", "queue_counts", {})
    expect(counts.status).toBe(200)
    expect((counts.to_prepare as number) >= 2).toBe(true)

    // Two ways a row leaves the worklist, in order. First: a live LOCAL shipment that fully
    // covers the invoice drops the row immediately (worklistCandidates in queues.ts drops on the
    // local shipment table, the authority this app controls, without waiting on Shopify). Second,
    // for a row with no shipment at all: Shopify reporting the order fulfilled.
    await installBoxtalApp({
      serverUrl: s,
      token,
      orgId: world.org.id,
      bundlePath: BOXTAL_BUNDLE,
      seedSenderAddress: {
        name: "Fabrikam SAS",
        phone: "+33123456789",
        email: "shipping@fabrikam.test",
        street: "12 Rue de la Paix",
        city: "Paris",
        postalCode: "75002",
        countryIsoCode: "FR",
      },
      seedShippingProfiles: [
        {
          product_source: "shopify",
          product_id: "VARIANT-AAA",
          unit_weight: 0.8,
          solo_length: 30,
          solo_width: 20,
          solo_height: 12,
        },
      ],
      seedShipments: [
        {
          document_ref: invA,
          recipient_summary: "Globex US",
          order_status: "PENDING",
          offer_code: "CHRP-Chrono13",
        },
      ],
    })
    const list2 = await callTool(s, token, "boxtal", "to_prepare_list", {})
    const rows2 = (list2.rows as ToPrepareRow[]) ?? []
    expect(
      rows2.find((r) => r.id === invA),
      "invoice A fully covered by a live local shipment, so its row leaves the worklist",
    ).toBeFalsy()
    expect(
      rows2.find((r) => r.id === invB),
      "invoice B has no shipment, so its row stays",
    ).toBeTruthy()

    await seedOpenOrders(s, token, [
      {
        id: gidB,
        name: "#Q1002",
        email: "globex-q1@e2e.test",
        customerName: "Globex US",
        shippingAddress: US_SHIP_TO,
        fulfillmentStatus: "FULFILLED",
      },
    ])
    const list3 = await callTool(s, token, "boxtal", "to_prepare_list", {})
    const rows3 = (list3.rows as ToPrepareRow[]) ?? []
    expect(
      rows3.find((r) => r.id === invB),
      "order B gone once Shopify reports it fulfilled",
    ).toBeFalsy()
  })

  test("S-Q2: ready_list + returns_list filter and project the link store; queue_counts badges match", async ({
    env,
    world,
    qa,
  }) => {
    assertBoxtalBundle()
    const token = qa.admin.token
    const s = env.serverUrl
    await resetMock(s, token)

    await installBoxtalApp({
      serverUrl: s,
      token,
      orgId: world.org.id,
      bundlePath: BOXTAL_BUNDLE,
      seedShipments: [
        // CONFIRMED outbound with a LABEL, ANNOUNCED to the carrier but not yet collected: the
        // only ready-to-ship row. (ANNOUNCED, not IN_TRANSIT: since 2026-07-31 ready_list drops
        // shipments the carrier has already taken, so an IN_TRANSIT parcel is no longer warehouse
        // work. `cost` is the LABEL price, which is why the seed sets label_cost_ttc.)
        {
          document_ref: "inv-ready",
          recipient_summary: "Globex US",
          offer_code: "CHRP-Chrono13",
          tracking_number: "CR2605…FR",
          declared_total: 899,
          label_cost_ttc: 25,
          currency: "EUR",
          order_status: "CONFIRMED",
          tracking_status: "ANNOUNCED",
          documents: [{ type: "LABEL", format: "PDF_A4" }],
        },
        // PENDING outbound: STILL warehouse work. A freshly bought label sits at PENDING until
        // Boxtal confirms the order, and the print station must see it (the regression where the
        // day's labels were invisible). It just has no label to print yet.
        {
          document_ref: "inv-pending",
          recipient_summary: "Acme SAS",
          offer_code: "POFR-ColissimoAccess",
          order_status: "PENDING",
        },
        // CANCELLED outbound → excluded everywhere.
        { document_ref: "inv-cancel", recipient_summary: "Void Co", order_status: "CANCELLED" },
        // Two returns (agent + user).
        {
          document_ref: "pro-220",
          recipient_summary: "Globex US",
          order_status: "CONFIRMED",
          tracking_status: "IN_TRANSIT",
          kind: "return",
          return_reason: "Defective unit",
          created_by: "agent",
          documents: [{ type: "LABEL", format: "PDF_A4" }],
        },
        {
          document_ref: "pro-221",
          recipient_summary: "Stark Labs",
          order_status: "PENDING",
          kind: "return",
          return_reason: "Wrong item",
          created_by: "user",
        },
      ],
    })

    // ready_list — the two WAREHOUSE-SIDE outbound rows (the CANCELLED one and the returns are
    // excluded), with has_label derived from the documents rather than from the order status.
    const ready = await callTool(s, token, "boxtal", "ready_list", {})
    expect(ready.status, JSON.stringify(ready)).toBe(200)
    const readyRows = (ready.rows as ReadyRow[]) ?? []
    expect(readyRows.map((r) => r.invoice_ref).sort()).toEqual(["inv-pending", "inv-ready"])
    expect(readyRows.find((r) => r.invoice_ref === "inv-ready")).toMatchObject({
      recipient: "Globex US",
      carrier: "CHRP-Chrono13",
      cost: 25,
      has_label: true,
    })
    // Bought but not yet printable: on the queue, honestly labelled as having no label.
    expect(readyRows.find((r) => r.invoice_ref === "inv-pending")).toMatchObject({
      recipient: "Acme SAS",
      has_label: false,
    })

    // returns_list — both returns, created_by + label_ready mapped, outbound rows absent.
    const returns = await callTool(s, token, "boxtal", "returns_list", {})
    expect(returns.status, JSON.stringify(returns)).toBe(200)
    const returnRows = (returns.rows as ReturnRow[]) ?? []
    expect(returnRows).toHaveLength(2)
    const agentRow = returnRows.find((r) => r.proforma_ref === "pro-220")
    const userRow = returnRows.find((r) => r.proforma_ref === "pro-221")
    expect(agentRow).toMatchObject({
      customer: "Globex US",
      reason: "Defective unit",
      created_by: "agent",
      label_ready: true,
    })
    expect(userRow).toMatchObject({
      customer: "Stark Labs",
      created_by: "user",
      label_ready: false,
    })

    // queue_counts — the badge agrees with the list it badges (to_prepare is 0: no invoicing and
    // no open orders in this scenario).
    const counts = await callTool(s, token, "boxtal", "queue_counts", {})
    expect(counts.status).toBe(200)
    expect(counts.ready).toBe(readyRows.length)
    expect(counts.returns).toBe(2)
  })
})
