// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 18 e2e S17 — tool-surface breadth net.
//
// Calls every free read + catalog + settings tool end-to-end against the real
// kernel and asserts each RESOLVES with a non-error envelope + correct scope
// wiring (catches a renamed handler export / missing manifest scope). Depth is
// scoped to resolution + scope; the deep value assertions live in the dedicated
// scenarios (S1 sorted offers, S3 sender round-trip, S4 catalog, S11 documents).
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
import { resetMock, setMockMode } from "./helpers/mock-boxtal"

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

async function tool(
  serverUrl: string,
  token: string,
  app: "boxtal" | "invoicing",
  name: string,
  params: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const resp = await api(serverUrl, `/api/apps/${app}/tools/${name}`, {
    method: "POST",
    token,
    body: { params },
  })
  return { status: resp.status, body: unwrap(resp.body) }
}

/** A tool resolved if it returned 200 AND the body has no `error` envelope. */
function resolved(r: { status: number; body: Record<string, unknown> }): boolean {
  return r.status === 200 && !("error" in r.body && r.body.error)
}

test.describe("Boxtal: tool-surface", () => {
  test("every read / catalog / settings tool resolves against the real kernel", async ({
    env,
    world,
    qa,
  }) => {
    assertBoxtalBundle()
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)
    const token = qa.admin.token
    const s = env.serverUrl
    await resetMock(s, token)

    // Install both apps + create one shipment so the order-scoped reads resolve.
    const invoicing = await installInvoicingApp({
      serverUrl: s,
      token,
      orgId: world.org.id,
      bundlePath: INVOICING_BUNDLE,
      issuerCountry: "FR",
      additionalContacts: [
        {
          country: "US",
          name: "Globex US",
          email: "globex-s17@e2e.test",
          customerKind: "business",
        },
      ],
    })
    await installBoxtalApp({
      serverUrl: s,
      token,
      orgId: world.org.id,
      bundlePath: BOXTAL_BUNDLE,
      seedSenderAddress: SENDER,
      seedShippingProfiles: [
        {
          product_source: "shopify",
          product_id: "VARIANT-S17",
          unit_weight: 0.8,
          solo_length: 30,
          solo_width: 20,
          solo_height: 12,
          content_category: "content:v1:10120",
        },
      ],
    })
    await tool(s, token, "invoicing", "hs_codes_assign", {
      product_source: "shopify",
      external_id: "VARIANT-S17",
      hs_code: "92071000",
      country_of_origin: "CN",
      customs_description: "Electronic musical instrument controller",
    })
    const issue = await api(s, "/api/apps/invoicing/tools/invoice_create_and_issue", {
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
            email: "globex-s17@e2e.test",
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
              external_id: "VARIANT-S17",
            },
          ],
        },
      },
    })
    expect(issue.status, JSON.stringify(issue.body)).toBe(200)
    const invoiceId =
      (unwrap(issue.body).document_id as string | undefined) ??
      (unwrap(issue.body).result as { document_id?: string } | undefined)?.document_id
    expect(invoiceId).toBeTruthy()
    await resetMock(s, token)
    const create = await tool(s, token, "boxtal", "create_shipment", {
      draft_id: invoiceId,
      offer_code: OFFER_CODE,
      quoted_price_ttc: OFFER_PRICE_TTC,
      recipient_phone: RECIPIENT.phone,
      recipient_address: RECIPIENT,
    })
    const orderId = create.body.boxtal_order_id as string
    expect(orderId, JSON.stringify(create.body)).toBeTruthy()

    // — content categories (light value check: the mock's recorded ids surface) —
    const cats = await tool(s, token, "boxtal", "list_content_categories", {})
    expect(resolved(cats), JSON.stringify(cats)).toBe(true)
    const catIds = (cats.body.categories as Array<{ id: string }>).map((c) => c.id)
    expect(catIds.some((id) => id.startsWith("content:v1:"))).toBe(true)

    // — quote (resolves; S1 owns the sorted-offers value check) —
    await setMockMode({ serverUrl: s, token, cotationFixture: "multi" })
    const quote = await tool(s, token, "boxtal", "quote", {
      // v1 cotation requires the French party vocabulary ("entreprise"/"particulier")
      // — see quote.scenario.test.ts. "BUSINESS"/"RESIDENTIAL" is the v3 shipment
      // address vocabulary and is rejected by the boxtal:quote manifest enum.
      from: { country: "FR", postalCode: "75001", city: "Paris", type: "entreprise" },
      to: { country: "FR", postalCode: "13001", city: "Marseille", type: "entreprise" },
      parcels: [{ weight: 3, length: 30, width: 20, height: 15 }],
      content_code: "10120",
    })
    expect(resolved(quote), JSON.stringify(quote)).toBe(true)
    expect(Array.isArray(quote.body.offers)).toBe(true)

    // — catalog (resolves; S4 owns the round-trip) —
    const packages = await tool(s, token, "boxtal", "packages_list", {})
    expect(resolved(packages), JSON.stringify(packages)).toBe(true)
    const profileUpsert = await tool(s, token, "boxtal", "product_profile_upsert", {
      product_source: "shopify",
      product_id: "VARIANT-S17b",
      unit_weight: 0.5,
      solo_length: 10,
      solo_width: 10,
      solo_height: 5,
    })
    expect(resolved(profileUpsert), JSON.stringify(profileUpsert)).toBe(true)
    const packUpsert = await tool(s, token, "boxtal", "pack_upsert", {
      name: "S17 box",
      length: 40,
      width: 30,
      height: 20,
      gross_weight: 0.3,
      components: [{ product_source: "shopify", product_id: "VARIANT-S17b", quantity: 1 }],
    })
    expect(resolved(packUpsert), JSON.stringify(packUpsert)).toBe(true)
    const packId =
      (packUpsert.body.id as string | undefined) ?? (packUpsert.body.pack_id as string | undefined)
    if (packId) {
      const packDelete = await tool(s, token, "boxtal", "pack_delete", { id: packId })
      expect(resolved(packDelete), JSON.stringify(packDelete)).toBe(true)
    }
    const localProduct = await tool(s, token, "boxtal", "local_product_upsert", {
      sku: "LOCAL-S17",
      label: "Local widget",
    })
    expect(resolved(localProduct), JSON.stringify(localProduct)).toBe(true)

    // — settings (resolves; S3 owns the round-trip) —
    const senderGet = await tool(s, token, "boxtal", "settings_sender_address_get", {})
    expect(resolved(senderGet), JSON.stringify(senderGet)).toBe(true)
    const senderSet = await tool(s, token, "boxtal", "settings_sender_address_set", SENDER)
    expect(resolved(senderSet), JSON.stringify(senderSet)).toBe(true)

    // — order-scoped reads (resolve against the created shipment) —
    const track = await tool(s, token, "boxtal", "track", { id: orderId })
    expect(resolved(track), JSON.stringify(track)).toBe(true)
    const getShipment = await tool(s, token, "boxtal", "get_shipment", { id: orderId })
    expect(resolved(getShipment), JSON.stringify(getShipment)).toBe(true)
    const getDocs = await tool(s, token, "boxtal", "get_documents", { id: orderId })
    expect(resolved(getDocs), JSON.stringify(getDocs)).toBe(true)

    // — local search index —
    const search = await tool(s, token, "boxtal", "search", { query: orderId, limit: 5 })
    expect(resolved(search), JSON.stringify(search)).toBe(true)
    expect(Array.isArray(search.body.results)).toBe(true)
  })
})
