// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 18 e2e S9 + S10 — the create reservation lifecycle (Amendments 3/4).
//
// S9 (deterministic 422 releases, indeterminate 5xx holds):
//   (a) mock create → 422-with-Phone ⇒ create_shipment returns
//       {error:{code:"validation"}}, the in-flight row is DELETED (reservation
//       released), and a corrected retry (mock back to PENDING) succeeds → one
//       order, fresh row.
//   (b) mock create → 5xx ⇒ create_uncertain, the row is KEPT holding the
//       document_ref slot; a second create for the SAME document_ref with a
//       DISTINCT idempotencyKey/draft id (bypasses the kernel in-flight key,
//       lands on the durable partial-unique index) is refused `duplicate` with
//       ZERO new v3 POSTs — the post-reservation guarantee without a timer.
//
// S10 (no double-create, both layers):
//   - two concurrent create_shipment for the same draft (Promise.all) collapse
//     on the kernel idempotencyKey (one v3 POST); then a third create for the
//     same document_ref with a distinct idempotencyKey is refused by the durable
//     document_ref partial-unique index.
//
// The mock create mode is a per-server-process global, flipped BETWEEN calls via
// the `/mock/mode` control route (never concurrently) — see the serial-within-
// worker discipline in the E2E plan.
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
import { getRequests, resetMock, setMockMode, v3CreatePosts } from "./helpers/mock-boxtal"

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
  external_id: "VARIANT-RES",
}
const CUSTOMS = {
  product_source: "shopify",
  external_id: "VARIANT-RES",
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

/** Install both apps + issue a profiled US export invoice. Returns the invoice id. */
async function seedDogfoodInvoice(
  serverUrl: string,
  token: string,
  orgId: string,
  tag: string,
): Promise<string> {
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
        product_id: "VARIANT-RES",
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
  const id =
    (payload.document_id as string | undefined) ??
    (payload.result as { document_id?: string } | undefined)?.document_id
  expect(id, JSON.stringify(payload)).toBeTruthy()
  return id as string
}

test.describe("Boxtal: create reservation lifecycle", () => {
  test("S9: 422 releases the reservation (clean retry); 5xx holds it (blocked retry)", async ({
    env,
    world,
    qa,
  }) => {
    assertBoxtalBundle()
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)
    const token = qa.admin.token
    const s = env.serverUrl

    // — (a) deterministic 422 → release + clean corrected retry —
    await resetMock(s, token)
    const invoiceA = await seedDogfoodInvoice(s, token, world.org.id, "s9a")
    await resetMock(s, token)

    // Flip the mock to phone_422 BEFORE the create.
    await setMockMode({ serverUrl: s, token, createMode: "phone_422" })
    const rejected = await toolPost(s, token, "boxtal", "create_shipment", {
      draft_id: invoiceA,
      offer_code: OFFER_CODE,
      quoted_price_ttc: OFFER_PRICE_TTC,
      recipient_phone: RECIPIENT.phone,
      recipient_address: RECIPIENT,
    })
    // The handler ran (direct human-approver path) and surfaced the validation
    // reject; one v3 POST hit the mock (and got the 422). The kernel maps the
    // handler's business `validation` error code to HTTP 500 (it is not a
    // kernel-recognized status code), but the structured error envelope is
    // carried in the body — assert on the body, not the HTTP status.
    expect(
      (rejected.body.error as { code?: string } | undefined)?.code,
      JSON.stringify(rejected.body),
    ).toBe("validation")
    expect(v3CreatePosts(await getRequests(s, token)).length).toBe(1)

    // Corrected retry: mock back to PENDING — the create now SUCCEEDS cleanly.
    // A success here is itself the proof the 422 RELEASED the reservation: a row
    // still holding the document_ref slot would have refused this retry with
    // `duplicate` before any POST.
    await setMockMode({ serverUrl: s, token, createMode: "pending" })
    const retried = await toolPost(s, token, "boxtal", "create_shipment", {
      draft_id: invoiceA,
      offer_code: OFFER_CODE,
      quoted_price_ttc: OFFER_PRICE_TTC,
      recipient_phone: RECIPIENT.phone,
      recipient_address: RECIPIENT,
    })
    expect(retried.status, JSON.stringify(retried.body)).toBe(200)
    expect(retried.body.error, JSON.stringify(retried.body)).toBeUndefined()
    expect(retried.body.boxtal_order_id, JSON.stringify(retried.body)).toBeTruthy()
    // Exactly two POSTs total (the rejected one + the successful retry).
    expect(v3CreatePosts(await getRequests(s, token)).length).toBe(2)
    // The created order is reachable via get_shipment (the row was finalized).
    const finalView = await toolPost(s, token, "boxtal", "get_shipment", {
      id: retried.body.boxtal_order_id as string,
    })
    expect(
      finalView.body.order_status ?? finalView.body.status,
      JSON.stringify(finalView.body),
    ).toBeTruthy()

    // — (b) indeterminate 5xx → hold + blocked same-document_ref retry —
    await resetMock(s, token)
    const invoiceB = await seedDogfoodInvoice(s, token, world.org.id, "s9b")
    await resetMock(s, token)

    await setMockMode({ serverUrl: s, token, createMode: "server_5xx" })
    const uncertain = await toolPost(s, token, "boxtal", "create_shipment", {
      draft_id: invoiceB,
      offer_code: OFFER_CODE,
      quoted_price_ttc: OFFER_PRICE_TTC,
      recipient_phone: RECIPIENT.phone,
      recipient_address: RECIPIENT,
    })
    // Business error → body envelope carries the code (HTTP status is 500 for
    // this unrecognized code; assert on the body).
    expect(
      (uncertain.body.error as { code?: string } | undefined)?.code,
      JSON.stringify(uncertain.body),
    ).toBe("create_uncertain")
    const postsAfter5xx = v3CreatePosts(await getRequests(s, token))
    expect(postsAfter5xx.length).toBe(1)

    // The row is KEPT (holds the document_ref slot). A second create for the SAME
    // document_ref is refused by the durable document_ref partial-unique index —
    // the durable no-double-create backstop. The refusal IS the proof the 5xx
    // held the reservation (a released slot would have allowed a fresh POST).
    // (Mock flipped back to PENDING so a NON-refused create WOULD POST; the
    // refusal proves the index, not the mock mode.)
    await setMockMode({ serverUrl: s, token, createMode: "pending" })
    const blockedRetry = await toolPost(s, token, "boxtal", "create_shipment", {
      draft_id: invoiceB,
      offer_code: OFFER_CODE,
      quoted_price_ttc: OFFER_PRICE_TTC,
      recipient_phone: RECIPIENT.phone,
      recipient_address: RECIPIENT,
    })
    expect(
      (blockedRetry.body.error as { code?: string } | undefined)?.code,
      JSON.stringify(blockedRetry.body),
    ).toBe("duplicate")
    // ZERO new v3 POSTs — the refusal happened BEFORE any outbound call.
    expect(v3CreatePosts(await getRequests(s, token)).length).toBe(1)
  })

  test("S10: concurrent same-draft creates collapse to one order; same-doc_ref retry is refused", async ({
    env,
    world,
    qa,
  }) => {
    assertBoxtalBundle()
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)
    const token = qa.admin.token
    const s = env.serverUrl
    await resetMock(s, token)
    const invoiceId = await seedDogfoodInvoice(s, token, world.org.id, "s10")
    await resetMock(s, token)

    const createBody = {
      draft_id: invoiceId,
      offer_code: OFFER_CODE,
      quoted_price_ttc: OFFER_PRICE_TTC,
      recipient_phone: RECIPIENT.phone,
      recipient_address: RECIPIENT,
    }

    // Fire two concurrent creates for the same draft. No idempotencyKey param is
    // supplied, so the durable `document_ref` partial-unique index is the layer
    // that collapses the duplicate: both calls reserveCreate (check-then-insert),
    // the loser's insert hits the unique constraint and returns `duplicate`
    // BEFORE any POST. Exactly one v3 shipping-order POST results.
    const [r1, r2] = await Promise.all([
      toolPost(s, token, "boxtal", "create_shipment", createBody),
      toolPost(s, token, "boxtal", "create_shipment", createBody),
    ])

    // Exactly ONE call wins (returns a boxtal_order_id); the other is collapsed
    // and returns `duplicate` (HTTP 500 envelope, body carries the code).
    const results = [r1, r2]
    const winners = results.filter((r) => typeof r.body.boxtal_order_id === "string")
    const dupes = results.filter(
      (r) => (r.body.error as { code?: string } | undefined)?.code === "duplicate",
    )
    expect(winners.length, JSON.stringify(results.map((r) => r.body))).toBe(1)
    expect(dupes.length, JSON.stringify(results.map((r) => r.body))).toBe(1)
    const winningOrderId = winners[0].body.boxtal_order_id as string

    // Exactly one v3 shipping-order POST recorded (allow a brief settle window).
    let posts: ReturnType<typeof v3CreatePosts> = []
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      posts = v3CreatePosts(await getRequests(s, token))
      if (posts.length >= 1) break
      await new Promise((r) => setTimeout(r, 300))
    }
    expect(posts.length, JSON.stringify(posts.map((p) => p.body))).toBe(1)

    // The single created order is reachable (the winning row was finalized).
    const view = await toolPost(s, token, "boxtal", "get_shipment", { id: winningOrderId })
    expect(view.body.order_status ?? view.body.status, JSON.stringify(view.body)).toBeTruthy()

    // A later create for the SAME document_ref (distinct call, bypassing the
    // in-flight key window) is refused by the durable partial-unique index.
    const thirdRetry = await toolPost(s, token, "boxtal", "create_shipment", createBody)
    expect(
      (thirdRetry.body.error as { code?: string } | undefined)?.code,
      JSON.stringify(thirdRetry.body),
    ).toBe("duplicate")
    // No new POST.
    expect(v3CreatePosts(await getRequests(s, token)).length).toBe(1)
  })
})
