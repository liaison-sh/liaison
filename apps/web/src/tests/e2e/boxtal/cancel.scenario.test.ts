// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 18 e2e S14 — gated cancel_shipment, status-guarded.
//
// A cancellable (PENDING, no dispatch) shipment cancels: gated for a human
// approver it runs directly, records exactly one v3 DELETE, and the link row
// flips to CANCELLED. A re-cancel is an idempotent no-op success. A dispatched
// (IN_TRANSIT) shipment is REFUSED with `already_dispatched` and NO DELETE.
import { existsSync } from "node:fs"
import { api } from "@liaison/test-helpers"
import { installInvoicingApp } from "../invoicing/helpers/install-invoicing-app"
import {
  assertBoxtalBundle,
  BOXTAL_BUNDLE,
  expect,
  INVOICING_BUNDLE,
  test,
} from "./_boxtal-fixtures"
import { installBoxtalApp } from "./helpers/install-boxtal-app"
import { getRequests, resetMock, setMockMode, v3CancelDeletes } from "./helpers/mock-boxtal"

function unwrap(body: unknown): Record<string, unknown> {
  const b = (body ?? {}) as Record<string, unknown>
  return "data" in b && b.data && typeof b.data === "object"
    ? (b.data as Record<string, unknown>)
    : b
}

const SENDER = {
  name: "Fabrikam SAS",
  phone: "+33123456789",
  // Every party needs an email: Boxtal rejects a shipment whose sender contact
  // has none (422 ValidationException.NotBlank), so staging refuses it first.
  email: "shipping@fabrikam.test",
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
// The recipient is in the US, so the route quotes the INTERNATIONAL offers; a
// domestic French relay offer is refused as `offer_not_quoted`. The TTC price
// rides along because create_shipment requires the quoted price verbatim: the
// approval card shows what the label will cost.
const OFFER_CODE = "DPDI-InternationalClassic"
const OFFER_PRICE_TTC = 49.56

const LINE = {
  position: 1,
  description: "Kestrel 2 controller",
  quantity: "1",
  unit_price_minor: "25000",
  product_source: "shopify",
  external_id: "VARIANT-CXL",
}
const CUSTOMS = {
  product_source: "shopify",
  external_id: "VARIANT-CXL",
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

/** Install both apps, issue a profiled US invoice, create a PENDING shipment. */
async function seedCreatedShipment(
  serverUrl: string,
  token: string,
  orgId: string,
  tag: string,
): Promise<string> {
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
  await installBoxtalApp({
    serverUrl,
    token,
    orgId,
    bundlePath: BOXTAL_BUNDLE,
    seedSenderAddress: SENDER,
    seedShippingProfiles: [
      {
        product_source: "shopify",
        product_id: "VARIANT-CXL",
        unit_weight: 0.8,
        solo_length: 30,
        solo_width: 20,
        solo_height: 12,
        content_category: "content:v1:10120",
      },
    ],
  })
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
    quoted_price_ttc: OFFER_PRICE_TTC,
    recipient_phone: RECIPIENT.phone,
    recipient_address: RECIPIENT,
  })
  const orderId = create.body.boxtal_order_id as string | undefined
  expect(orderId, JSON.stringify(create.body)).toBeTruthy()
  return orderId as string
}

/** Read the stored row's order_status via the search index (no live re-fetch). */
async function readOrderStatus(
  serverUrl: string,
  token: string,
  orderId: string,
): Promise<string | null> {
  const resp = await toolPost(serverUrl, token, "boxtal", "search", { query: orderId, limit: 5 })
  const results = (resp.body.results as Array<{ attributes: Record<string, unknown> }>) ?? []
  if (results.length === 0) return null
  return (results[0].attributes.order_status as string | null) ?? null
}

test.describe("Boxtal: gated cancel", () => {
  test("cancellable shipment cancels (one DELETE, row CANCELLED, idempotent re-cancel); dispatched is refused", async ({
    env,
    world,
    qa,
  }) => {
    assertBoxtalBundle()
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)
    const token = qa.admin.token
    const s = env.serverUrl

    // — cancellable (PENDING, no dispatch) —
    const cancellable = await seedCreatedShipment(s, token, world.org.id, "s14a")
    await resetMock(s, token)
    // The mock's order is PENDING and tracking defaults to ANNOUNCED → cancellable.
    const cancel = await toolPost(s, token, "boxtal", "cancel_shipment", { id: cancellable })
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200)
    expect(cancel.body.order_status, JSON.stringify(cancel.body)).toBe("CANCELLED")
    // Exactly one v3 DELETE recorded.
    expect(v3CancelDeletes(await getRequests(s, token)).length).toBe(1)
    // The stored link row flipped to CANCELLED.
    expect(await readOrderStatus(s, token, cancellable)).toBe("CANCELLED")

    // Re-cancel: idempotent no-op success. Flip the mock order GET to report
    // CANCELLED so the handler's live pre-check short-circuits — NO additional
    // DELETE is recorded.
    await resetMock(s, token)
    await setMockMode({ serverUrl: s, token, cancelOrderId: cancellable })
    const recancel = await toolPost(s, token, "boxtal", "cancel_shipment", { id: cancellable })
    expect(recancel.status, JSON.stringify(recancel.body)).toBe(200)
    expect(recancel.body.order_status, JSON.stringify(recancel.body)).toBe("CANCELLED")
    // No new DELETE — the handler short-circuited on the live CANCELLED status.
    expect(v3CancelDeletes(await getRequests(s, token)).length).toBe(0)
    expect(await readOrderStatus(s, token, cancellable)).toBe("CANCELLED")

    // — dispatched (IN_TRANSIT) → refused, no DELETE —
    const dispatched = await seedCreatedShipment(s, token, world.org.id, "s14b")
    await resetMock(s, token)
    // Drive the mock's /tracking for this order to IN_TRANSIT so the cancel
    // pre-check refuses it.
    await setMockMode({
      serverUrl: s,
      token,
      trackingStatus: { orderId: dispatched, status: "IN_TRANSIT" },
    })
    const refused = await toolPost(s, token, "boxtal", "cancel_shipment", { id: dispatched })
    // Business refusal rides the body (kernel maps the unknown `already_dispatched`
    // code to HTTP 500; assert on the body code).
    expect(
      (refused.body.error as { code?: string } | undefined)?.code,
      JSON.stringify(refused.body),
    ).toBe("already_dispatched")
    // No v3 DELETE was recorded for the dispatched order.
    expect(v3CancelDeletes(await getRequests(s, token)).length).toBe(0)
    // The row stays non-CANCELLED.
    expect(await readOrderStatus(s, token, dispatched)).not.toBe("CANCELLED")
  })
})
