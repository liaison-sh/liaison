// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 18 E2E — shared invoice/shipment seed helpers.
//
// Extracted from `search-and-tab.scenario.test.ts` so the S16 path and the
// cross-app slot visual scenario share ONE definition (the local copies in
// `cancel`/`webhooks` are out of scope for this gap). Two helpers split at the
// natural seam after `invoice_create_and_issue` returns the invoice id:
//
//   - `seedIssuedInvoice` — issue-only path (resetMock → install invoicing +
//     boxtal → hs_codes_assign → invoice_create_and_issue), returns `{ invoiceId }`.
//     The Boxtal "Shipment" tab on this invoice shows the EMPTY-state CTA (no
//     linked shipment yet).
//   - `seedCreatedShipment` — calls `seedIssuedInvoice`, then `resetMock` +
//     `create_shipment`, returns `{ orderId, invoiceId }`. The Shipment tab on
//     this invoice resolves the LINKED-shipment card (Boxtal indexes the
//     invoice id as `document_ref`, and `fetchLinked` searches by that ref).
import { api } from "@liaison/test-helpers"
import { installInvoicingApp } from "../../invoicing/helpers/install-invoicing-app"
import { BOXTAL_BUNDLE, expect, INVOICING_BUNDLE } from "../_boxtal-fixtures"
import { installBoxtalApp } from "./install-boxtal-app"
import { resetMock } from "./mock-boxtal"

export const SENDER = {
  name: "Fabrikam SAS",
  phone: "+33123456789",
  // Every party needs an email: Boxtal rejects a shipment whose sender contact
  // has none (422 ValidationException.NotBlank), which is why address.ts lists
  // it among the required fields.
  email: "shipping@fabrikam.test",
  street: "12 Rue de la Paix",
  city: "Paris",
  postalCode: "75002",
  countryIsoCode: "FR",
}

export const RECIPIENT = {
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
export const OFFER_CODE = "DPDI-InternationalClassic"
export const OFFER_PRICE_TTC = 49.56

export function unwrap(body: unknown): Record<string, unknown> {
  const b = (body ?? {}) as Record<string, unknown>
  return "data" in b && b.data && typeof b.data === "object"
    ? (b.data as Record<string, unknown>)
    : b
}

export async function toolPost(
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

/**
 * Issue-only seed path. Installs invoicing + boxtal, assigns the HS code, and
 * issues an invoice. Returns the invoice id. No shipment is created — the
 * Boxtal Shipment tab for this invoice renders the empty-state CTA.
 */
export async function seedIssuedInvoice(
  serverUrl: string,
  token: string,
  orgId: string,
  tag: string,
): Promise<{ invoiceId: string }> {
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
        product_id: "VARIANT-STAB",
        unit_weight: 0.8,
        solo_length: 30,
        solo_width: 20,
        solo_height: 12,
        content_category: "content:v1:10120",
      },
    ],
  })
  await toolPost(serverUrl, token, "invoicing", "hs_codes_assign", {
    product_source: "shopify",
    external_id: "VARIANT-STAB",
    hs_code: "92071000",
    country_of_origin: "CN",
    customs_description: "Electronic musical instrument controller",
  })
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
        items: [
          {
            position: 1,
            description: "Kestrel 2 controller",
            quantity: "1",
            unit_price_minor: "25000",
            product_source: "shopify",
            external_id: "VARIANT-STAB",
          },
        ],
      },
    },
  })
  expect(issue.status, JSON.stringify(issue.body)).toBe(200)
  const payload = unwrap(issue.body)
  const invoiceId =
    (payload.document_id as string | undefined) ??
    (payload.result as { document_id?: string } | undefined)?.document_id
  expect(invoiceId, JSON.stringify(payload)).toBeTruthy()
  return { invoiceId: invoiceId as string }
}

/**
 * Full seed path: issue an invoice, then create a Boxtal shipment for it.
 * Returns the Boxtal order id + the invoice id. The Boxtal Shipment tab for
 * this invoice resolves the linked-shipment card.
 */
export async function seedCreatedShipment(
  serverUrl: string,
  token: string,
  orgId: string,
  tag: string,
): Promise<{ orderId: string; invoiceId: string }> {
  const { invoiceId } = await seedIssuedInvoice(serverUrl, token, orgId, tag)
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
  return { orderId: orderId as string, invoiceId }
}

// ── Open Shopify orders (the order-driven prep worklist) ────────────────────
//
// The prep grid's rows are OPEN, UNFULFILLED Shopify orders, so a scenario has to be able to put
// one in the store. The offline Shopify mock holds them (apps/api/test-support/harness/
// shopify-mock-fetch.ts); these two helpers are the client for its seed route and for linking an
// issued invoice to a seeded order.

export interface OpenOrderSeed {
  /** Re-seeding the SAME id (or the same name) replaces that order, which is how a test says
   *  "and then Shopify reported this order fulfilled". */
  id?: string
  name: string
  email?: string
  /** The CUSTOMER's name, distinct from the ship-to name. Defaults to the shipping address name. */
  customerName?: string
  financialStatus?: string
  fulfillmentStatus?: string
  cancelledAt?: string | null
  tags?: string[]
  amount?: string
  shippingAddress?: {
    name?: string
    address1?: string
    city?: string
    zip?: string
    country?: string
    countryCode?: string
    phone?: string
  }
  lineItems?: Array<{
    title?: string
    sku?: string
    variantId?: string
    quantity?: number
    unitAmount?: string
  }>
}

/** Put open orders in the offline Shopify mock. Returns their gids, in the order given. */
export async function seedOpenOrders(
  serverUrl: string,
  token: string,
  orders: OpenOrderSeed[],
): Promise<string[]> {
  const resp = await api(serverUrl, "/api/_test/shopify/mock/orders", {
    method: "POST",
    token,
    body: { orders },
  })
  expect(resp.status, JSON.stringify(resp.body)).toBe(200)
  const ids = unwrap(resp.body).ids as string[] | undefined
  expect(ids?.length, JSON.stringify(resp.body)).toBe(orders.length)
  return ids as string[]
}

/** The numeric Shopify order id inside a gid. What `documents_for_orders` joins on. */
export function numericOrderId(gid: string): string {
  const m = String(gid).match(/(\d+)\s*$/)
  return m ? m[1]! : String(gid)
}

/**
 * Issue a goods invoice LINKED to a seeded Shopify order, which is what makes the prep row anchor
 * on it. Without `shopify_order_id` the document exists but no row can find it.
 */
export async function seedIssuedInvoiceForOrder(
  serverUrl: string,
  token: string,
  args: {
    issuerProfileId: string
    contactId: string
    shopifyOrderId: string
    counterpartyName: string
    counterpartyCountry: string
    /** Defaults to a synthetic but complete recipient — invoice_create_and_issue refuses to
     *  issue without a non-blank legal_name/country/address/email (counterpartyCompletenessError
     *  in bundled-apps/invoicing/src/issue.ts); it does NOT look these up from contactId. */
    counterpartyEmail?: string
    counterpartyAddress?: string
    items: Array<Record<string, unknown>>
  },
): Promise<string> {
  const issue = await api(serverUrl, "/api/apps/invoicing/tools/invoice_create_and_issue", {
    method: "POST",
    token,
    body: {
      params: {
        counterparty: {
          contact_id: args.contactId,
          legal_name: args.counterpartyName,
          country: args.counterpartyCountry,
          vat_id: null,
          address: args.counterpartyAddress ?? "1 Test Street, 75001 Paris, France",
          email:
            args.counterpartyEmail ??
            `${args.counterpartyName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@e2e.test`,
        },
        issuer_profile_id: args.issuerProfileId,
        currency: "EUR",
        incoterm: "DAP",
        shopify_order_id: args.shopifyOrderId,
        items: args.items,
      },
    },
  })
  expect(issue.status, JSON.stringify(issue.body)).toBe(200)
  const payload = unwrap(issue.body)
  const invoiceId =
    (payload.document_id as string | undefined) ??
    (payload.result as { document_id?: string } | undefined)?.document_id
  expect(invoiceId, JSON.stringify(payload)).toBeTruthy()
  return invoiceId as string
}
