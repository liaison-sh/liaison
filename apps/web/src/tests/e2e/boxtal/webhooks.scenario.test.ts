// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 18 e2e S11 + S12 + S13 — inbound Boxtal webhooks (signed) against a
// created shipment.
//
// S11 (documents async): a freshly created order is PENDING with no label;
//   `get_documents` reports `generating:true`. A signed `document-created`
//   webhook flips the mock to CONFIRMED and persists url-stripped descriptors;
//   `get_documents` then returns a LABEL (+ CN23) with a freshly-minted signed
//   URL (never a stored URL), and the link order_status bumps to CONFIRMED.
//
// S12 (tracking freshness): a signed `tracking-changed` (IN_TRANSIT) advances
//   tracking_status within one request cycle; an OLDER event is ignored
//   (timestamp guard); a DUPLICATE (same x-bxt-delivery-id) is deduped.
//
// S13 (signature + dedup edges): a wrong signature is rejected (non-200, no
//   state change); a correct signature for an UNKNOWN orderId returns 200 (no-op,
//   never errors the sender); two DISTINCT status changes WITHOUT a delivery-id
//   header both apply (the fallback dedup key folds status+timestamp — the I3
//   regression).
import { existsSync } from "node:fs"
import { api, type WorkerEnv } from "@liaison/test-helpers"
import { installInvoicingApp } from "../invoicing/helpers/install-invoicing-app"
import {
  assertBoxtalBundle,
  BOXTAL_BUNDLE,
  expect,
  INVOICING_BUNDLE,
  test,
} from "./_boxtal-fixtures"
import { dispatchBoxtalWebhook } from "./helpers/dispatch-boxtal-webhook"
import { installBoxtalApp } from "./helpers/install-boxtal-app"
import { resetMock, setMockMode } from "./helpers/mock-boxtal"

function unwrap(body: unknown): Record<string, unknown> {
  const b = (body ?? {}) as Record<string, unknown>
  return "data" in b && b.data && typeof b.data === "object"
    ? (b.data as Record<string, unknown>)
    : b
}

const SENDER = {
  name: "Fabrikam SAS",
  // The carrier needs somewhere to send the collection notices, so staging requires a sender email.
  email: "ship@fabrikam.test",
  phone: "+33123456789",
  street: "12 Rue de la Paix",
  city: "Paris",
  postalCode: "75002",
  countryIsoCode: "FR",
}
const RECIPIENT = {
  name: "Globex US",
  phone: "+12125550001",
  email: "ship@globex.test",
  street: "1 Times Sq",
  city: "New York",
  postalCode: "10036",
  countryIsoCode: "US",
  // US and CA labels are refused by the carrier without a state code, so staging demands one.
  state: "NY",
}
// The recipient is in the US, so the mock serves the INTERNATIONAL cotation fixture, and the offer
// has to be one that fixture actually returns for the route. 49.56 is its tax-inclusive price.
const OFFER_CODE = "DPDI-InternationalClassic"
const OFFER_PRICE_TTC = 49.56

const LINE = {
  position: 1,
  description: "Kestrel 2 controller",
  quantity: "1",
  unit_price_minor: "25000",
  product_source: "shopify",
  external_id: "VARIANT-WH",
}
const CUSTOMS = {
  product_source: "shopify",
  external_id: "VARIANT-WH",
  hs_code: "92071000",
  country_of_origin: "CN",
  customs_description: "Electronic musical instrument controller",
}

async function toolPost(
  serverUrl: string,
  token: string,
  app: "boxtal" | "invoicing",
  tool: string,
  params: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const resp = await api(serverUrl, `/api/apps/${app}/tools/${tool}`, {
    method: "POST",
    token,
    body: { params },
  })
  return { status: resp.status, body: unwrap(resp.body) }
}

interface CreatedShipment {
  orderId: string
  webhookSecret: string
}

/**
 * Install both apps, issue a profiled US invoice, and create a PENDING shipment.
 * Returns the boxtal order id + the minted webhook secret for signing webhooks.
 */
async function seedCreatedShipment(
  serverUrl: string,
  token: string,
  orgId: string,
  tag: string,
): Promise<CreatedShipment> {
  await resetMock(serverUrl, token)
  const invoicing = await installInvoicingApp({
    serverUrl,
    token,
    orgId,
    bundlePath: INVOICING_BUNDLE,
    issuerCountry: "FR",
    additionalContacts: [
      {
        country: "US",
        name: "Globex US",
        email: `globex-${tag}@e2e.test`,
        customerKind: "business",
      },
    ],
  })
  const installed = await installBoxtalApp({
    serverUrl,
    token,
    orgId,
    bundlePath: BOXTAL_BUNDLE,
    seedSenderAddress: SENDER,
    seedShippingProfiles: [
      {
        product_source: "shopify",
        product_id: "VARIANT-WH",
        unit_weight: 0.8,
        solo_length: 30,
        solo_width: 20,
        solo_height: 12,
        content_category: "content:v1:10120",
      },
    ],
  })
  if (!installed.webhookSecret) {
    throw new Error("install did not return a minted webhook secret")
  }
  await toolPost(serverUrl, token, "invoicing", "hs_codes_assign", CUSTOMS)
  const issue = await api(serverUrl, "/api/apps/invoicing/tools/invoice_create_and_issue", {
    method: "POST",
    token,
    body: {
      params: {
        counterparty: {
          contact_id: invoicing.additionalContactIds[0],
          legal_name: "Globex US",
          country: "US",
          vat_id: null,
          address: "1 Times Sq, New York, NY 10036, US",
          email: `globex-${tag}@e2e.test`,
        },
        issuer_profile_id: invoicing.primaryIssuerProfileId,
        currency: "EUR",
        incoterm: "DAP",
        items: [LINE],
      },
    },
  })
  expect(issue.status, JSON.stringify(issue.body)).toBe(200)
  const payload = unwrap(issue.body)
  const invoiceId =
    (payload.document_id as string | undefined) ??
    (payload.result as { document_id?: string } | undefined)?.document_id
  expect(invoiceId, JSON.stringify(payload)).toBeTruthy()

  await resetMock(serverUrl, token)
  const create = await toolPost(serverUrl, token, "boxtal", "create_shipment", {
    draft_id: invoiceId,
    offer_code: OFFER_CODE,
    // The approval card must show the reviewer what the label costs, so create_shipment REQUIRES
    // the quoted price, in MAJOR units, and re-validates it against a live re-quote.
    quoted_price_ttc: OFFER_PRICE_TTC,
    quoted_currency: "EUR",
    recipient_phone: RECIPIENT.phone,
    recipient_address: RECIPIENT,
  })
  const orderId = create.body.boxtal_order_id as string | undefined
  expect(orderId, JSON.stringify(create.body)).toBeTruthy()
  return { orderId: orderId as string, webhookSecret: installed.webhookSecret }
}

test.describe("Boxtal: webhooks", () => {
  test("S11: documents are async — label appears only after the document-created webhook", async ({
    env,
    world,
    qa,
  }) => {
    assertBoxtalBundle()
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)
    const token = qa.admin.token
    const s = env.serverUrl
    const { orderId, webhookSecret } = await seedCreatedShipment(s, token, world.org.id, "s11")

    // PENDING → documents still generating, no label.
    const before = await toolPost(s, token, "boxtal", "get_documents", { id: orderId })
    expect(before.status, JSON.stringify(before.body)).toBe(200)
    expect(before.body.generating, JSON.stringify(before.body)).toBe(true)
    expect((before.body.documents as unknown[]).length).toBe(0)

    // Flip the mock order to CONFIRMED (so /shipping-document now returns a LABEL
    // + CN23), then dispatch the signed document-created webhook.
    await setMockMode({ serverUrl: s, token, confirmOrderId: orderId })
    const hook = await dispatchBoxtalWebhook({
      serverUrl: s,
      orgId: world.org.id,
      endpoint: "document-created",
      body: { eventType: "DOCUMENT_CREATED", orderId },
      secret: webhookSecret,
    })
    expect(hook.status, JSON.stringify(hook.body)).toBe(200)

    // Post-webhook: a LABEL is available, freshly re-fetched (signed URL present),
    // never a stored URL — the link store persists only {type,format} descriptors.
    const after = await toolPost(s, token, "boxtal", "get_documents", { id: orderId })
    expect(after.status, JSON.stringify(after.body)).toBe(200)
    expect(after.body.generating).toBe(false)
    const docs = after.body.documents as Array<{ type: string; format: string; url?: string }>
    expect(docs.length, JSON.stringify(docs)).toBeGreaterThanOrEqual(1)
    const label = docs.find((d) => d.type === "LABEL")
    expect(label, JSON.stringify(docs)).toBeTruthy()
    expect(typeof label?.url, "live document fetch re-mints a signed URL").toBe("string")
    // A CN23/PROFORMA descriptor accompanies the label for a non-EU route.
    expect(docs.some((d) => d.type === "CN23" || d.type === "PROFORMA")).toBe(true)

    // The link order_status bumped to CONFIRMED in the STORED row — assert via the
    // search index (which reads the local row directly), so this proves the
    // WEBHOOK persisted the status, not merely that a live re-fetch sees the
    // mock-flipped order.
    const storedStatus = await readOrderStatus(env, orderId)
    expect(storedStatus, "webhook persisted order_status to the stored row").toBe("CONFIRMED")
    // And the live merged view also reports CONFIRMED.
    const shipment = await toolPost(s, token, "boxtal", "get_shipment", { id: orderId })
    expect(shipment.body.order_status, JSON.stringify(shipment.body)).toBe("CONFIRMED")
  })

  test("S12: tracking-changed advances status; older ignored; duplicate deduped", async ({
    env,
    world,
    qa,
  }) => {
    assertBoxtalBundle()
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)
    const token = qa.admin.token
    const s = env.serverUrl
    const { orderId, webhookSecret } = await seedCreatedShipment(s, token, world.org.id, "s12")

    const deliveryFirst = "delivery-s12-first"
    // First event: IN_TRANSIT at a recent timestamp.
    const first = await dispatchBoxtalWebhook({
      serverUrl: s,
      orgId: world.org.id,
      endpoint: "tracking-changed",
      body: {
        eventType: "TRACKING_CHANGED",
        orderId,
        status: "IN_TRANSIT",
        trackingNumber: "1Z-S12",
        trackingDateTime: "2026-06-02T10:00:00Z",
      },
      secret: webhookSecret,
      deliveryId: deliveryFirst,
    })
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    const afterFirst = await readTrackingStatus(env, orderId)
    expect(afterFirst, "first event advances tracking_status").toBe("IN_TRANSIT")

    // Older event (earlier timestamp) → ignored by the timestamp guard.
    const older = await dispatchBoxtalWebhook({
      serverUrl: s,
      orgId: world.org.id,
      endpoint: "tracking-changed",
      body: {
        eventType: "TRACKING_CHANGED",
        orderId,
        status: "ANNOUNCED",
        trackingNumber: "1Z-S12",
        trackingDateTime: "2026-06-01T08:00:00Z",
      },
      secret: webhookSecret,
      deliveryId: "delivery-s12-older",
    })
    expect(older.status).toBe(200)
    expect(await readTrackingStatus(env, orderId), "older event ignored").toBe("IN_TRANSIT")

    // Duplicate of the FIRST (same delivery id) → deduped, no double-apply.
    const dup = await dispatchBoxtalWebhook({
      serverUrl: s,
      orgId: world.org.id,
      endpoint: "tracking-changed",
      body: {
        eventType: "TRACKING_CHANGED",
        orderId,
        status: "DELIVERED",
        trackingNumber: "1Z-S12",
        trackingDateTime: "2026-06-03T10:00:00Z",
      },
      secret: webhookSecret,
      deliveryId: deliveryFirst,
    })
    expect(dup.status).toBe(200)
    // Status stays IN_TRANSIT — the duplicate delivery id was deduped, so the
    // DELIVERED payload it carried was NOT applied.
    expect(await readTrackingStatus(env, orderId), "duplicate delivery deduped").toBe("IN_TRANSIT")
  })

  test("S13: bad signature rejected; unknown order 200 no-op; distinct fallback-keyed events both apply", async ({
    env,
    world,
    qa,
  }) => {
    assertBoxtalBundle()
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)
    const token = qa.admin.token
    const s = env.serverUrl
    const { orderId, webhookSecret } = await seedCreatedShipment(s, token, world.org.id, "s13")

    // (a) Wrong signature → non-200, no state change.
    const badSig = await dispatchBoxtalWebhook({
      serverUrl: s,
      orgId: world.org.id,
      endpoint: "tracking-changed",
      body: {
        eventType: "TRACKING_CHANGED",
        orderId,
        status: "IN_TRANSIT",
        trackingDateTime: "2026-06-02T10:00:00Z",
      },
      secret: webhookSecret,
      signatureOverride: "deadbeefdeadbeefdeadbeef",
    })
    expect(badSig.status, JSON.stringify(badSig.body)).not.toBe(200)
    // No state change — tracking_status untouched (still null on a fresh order).
    expect(await readTrackingStatus(env, orderId)).not.toBe("IN_TRANSIT")

    // (b) Correct signature, UNKNOWN order id → 200 no-op (never errors sender).
    const unknown = await dispatchBoxtalWebhook({
      serverUrl: s,
      orgId: world.org.id,
      endpoint: "tracking-changed",
      body: {
        eventType: "TRACKING_CHANGED",
        orderId: "boxtal-order-does-not-exist",
        status: "DELIVERED",
        trackingDateTime: "2026-06-02T10:00:00Z",
      },
      secret: webhookSecret,
    })
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(200)

    // (c) Two DISTINCT status changes WITHOUT a delivery-id header → both apply
    //     (the fallback dedup key folds status+timestamp so they don't collide).
    const e1 = await dispatchBoxtalWebhook({
      serverUrl: s,
      orgId: world.org.id,
      endpoint: "tracking-changed",
      body: {
        eventType: "TRACKING_CHANGED",
        orderId,
        status: "IN_TRANSIT",
        trackingDateTime: "2026-06-02T10:00:00Z",
      },
      secret: webhookSecret,
      deliveryId: null, // omit the x-bxt-delivery-id header
    })
    expect(e1.status).toBe(200)
    expect(await readTrackingStatus(env, orderId), "first fallback-keyed event applies").toBe(
      "IN_TRANSIT",
    )

    const e2 = await dispatchBoxtalWebhook({
      serverUrl: s,
      orgId: world.org.id,
      endpoint: "tracking-changed",
      body: {
        eventType: "TRACKING_CHANGED",
        orderId,
        status: "DELIVERED",
        trackingDateTime: "2026-06-03T10:00:00Z",
      },
      secret: webhookSecret,
      deliveryId: null,
    })
    expect(e2.status).toBe(200)
    // The SECOND distinct event ALSO applied — proving the fallback dedup key did
    // NOT collapse the two on `eventType:orderId` (the I3 regression).
    expect(await readTrackingStatus(env, orderId), "second fallback-keyed event applies").toBe(
      "DELIVERED",
    )
  })
})

/**
 * Read the stored shipment row for a Boxtal order id straight from the worker's
 * app schema (no live re-fetch: `track` would ask the mock and mask the webhook
 * effect).
 *
 * The webhook route runs the handler inside the request and commits before it
 * answers 200, so the row is authoritative as soon as the dispatch returns; that
 * 200 is the completion signal. These reads used to go through the `search`
 * tool, a sandboxed call whose failure envelope carries no `results`, so a
 * transient tool failure read back as null and failed the scenario as "event
 * not applied". Exactly one row is asserted, so a missing or duplicated
 * shipment fails loudly instead of silently picking a row.
 */
async function readShipmentRow(
  env: WorkerEnv,
  orderId: string,
): Promise<{ tracking_status: string | null; order_status: string | null }> {
  const schema = env.schemaPrefix ? `"${env.schemaPrefix}app_boxtal"` : "app_boxtal"
  const rows = (await env.db.sql.unsafe(
    `SELECT tracking_status, order_status FROM ${schema}.shipment WHERE boxtal_order_id = $1`,
    [orderId],
  )) as unknown as Array<{ tracking_status: string | null; order_status: string | null }>
  expect(rows.length, `exactly one shipment row for ${orderId}`).toBe(1)
  return rows[0]
}

async function readTrackingStatus(env: WorkerEnv, orderId: string): Promise<string | null> {
  return (await readShipmentRow(env, orderId)).tracking_status ?? null
}

async function readOrderStatus(env: WorkerEnv, orderId: string): Promise<string | null> {
  return (await readShipmentRow(env, orderId)).order_status ?? null
}
