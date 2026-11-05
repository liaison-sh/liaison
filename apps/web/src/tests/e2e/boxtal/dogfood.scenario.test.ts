// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 18 e2e S5 + S6 — the dogfood killer path: invoice → shipment with ZERO
// re-entry of customs metadata, and its negative (an unprofiled line blocks).
//
// S5 installs BOTH Invoicing + Boxtal, issues a non-EU (US) invoice whose lines
// carry hs_code / country_of_origin / customs_description / product_source /
// external_id, seeds a Boxtal shipping_profile for every line's product (keyed
// (product_source, product_id) = the line's (product_source, external_id)),
// then opens a Boxtal shipment draft for the invoice. The draft is built by
// `shipment_draft_create`, which performs the REAL cross-app
// `invoicing:documents_get` K4 read (gated on the boxtal manifest's
// `cross_app_calls`). The killer assertion: every customs article's tariffNumber
// equals the invoice line's hs_code (a real value flowed), 0 mandatory-empty
// customs fields, and `unresolved == []`.
//
// S6 is the negative: drop ONE line's profile → that line surfaces in
// `unresolved` and the draft blocks create (zero-re-entry is honestly scoped to
// profiled products, Amendment 2).
import { existsSync } from "node:fs"
import { api } from "@liaison/test-helpers"
import { loginAs } from "../fixtures/test"
import { installInvoicingApp } from "../invoicing/helpers/install-invoicing-app"
import {
  assertBoxtalBundle,
  BOXTAL_BUNDLE,
  expect,
  INVOICING_BUNDLE,
  test,
} from "./_boxtal-fixtures"
import { installBoxtalApp } from "./helpers/install-boxtal-app"
import { resetMock } from "./helpers/mock-boxtal"

function unwrap(body: unknown): Record<string, unknown> {
  const b = (body ?? {}) as Record<string, unknown>
  return "data" in b && b.data && typeof b.data === "object"
    ? (b.data as Record<string, unknown>)
    : b
}

interface DraftCustomsArticle {
  line_id: string
  description: string
  quantity: number
  unitWeight: number | null
  unitValue: { value: number; currency: string }
  originCountry: string | null
  tariffNumber: string | null
  blocked?: boolean
  incomplete?: boolean
}
interface ShipmentDraft {
  document_ref: string
  parcels: Array<{ length: number; width: number; height: number; weight: number }>
  customsArticles: DraftCustomsArticle[]
  unresolved: Array<{ line: { id: string }; reason: string }>
  recipient: string
  route: string
  recipient_country: string | null
  customs_required: boolean
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

// Two profiled US-export lines (Shopify-sourced). The customs metadata
// (hs_code / country_of_origin / customs_description) is NOT carried inline on
// the invoice line — invoicing derives it at issue time from the
// `product_customs_overlay` keyed by (product_source, external_id), seeded via
// `hs_codes_assign` below. HS codes are digit-only (4–10 digits) per the
// invoicing validator.
const LINE_A = {
  position: 1,
  description: "Kestrel 2 controller — Black",
  quantity: "1",
  unit_price_minor: "25000",
  product_source: "shopify",
  external_id: "VARIANT-AAA",
}
const LINE_B = {
  position: 2,
  description: "USB-C cable",
  quantity: "2",
  unit_price_minor: "1500",
  product_source: "shopify",
  external_id: "VARIANT-BBB",
}

// The customs overlay each line's product resolves to at issue time.
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
  hs_code: "85444290",
  country_of_origin: "VN",
  customs_description: "Insulated USB-C data cable",
}

async function assignCustoms(
  serverUrl: string,
  token: string,
  overlay: typeof CUSTOMS_AAA,
): Promise<void> {
  const resp = await api(serverUrl, "/api/apps/invoicing/tools/hs_codes_assign", {
    method: "POST",
    token,
    body: { params: overlay },
  })
  expect(resp.status, JSON.stringify(resp.body)).toBe(200)
  const payload = unwrap(resp.body)
  expect(payload.status, JSON.stringify(payload)).not.toBe("error")
}

async function issueUsInvoice(
  serverUrl: string,
  token: string,
  issuerProfileId: string,
  contactId: string,
  lines: Array<Record<string, unknown>>,
): Promise<string> {
  const resp = await api(serverUrl, "/api/apps/invoicing/tools/invoice_create_and_issue", {
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
        items: lines,
      },
    },
  })
  expect(resp.status, JSON.stringify(resp.body)).toBe(200)
  const payload = unwrap(resp.body)
  // Below threshold → issues directly. The MutationResult carries the issued
  // document id + number flat on the success envelope; assert NOT pending/error.
  expect(payload.status, JSON.stringify(payload)).not.toBe("pending_approval")
  expect(payload.status, JSON.stringify(payload)).not.toBe("error")
  const documentId =
    (payload.document_id as string | undefined) ??
    (payload.result as { document_id?: string } | undefined)?.document_id
  expect(documentId, JSON.stringify(payload)).toBeTruthy()
  return documentId as string
}

test.describe("Boxtal: invoice -> shipment dogfood", () => {
  test("S5: profiled US invoice opens a draft with the invoice customs values, 0 mandatory-empty fields", async ({
    page,
    env,
    world,
    qa,
  }) => {
    assertBoxtalBundle()
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)
    const token = qa.admin.token
    const s = env.serverUrl
    await resetMock(s, token)

    // 1. Install Invoicing (FR issuer) + a US contact for the export invoice.
    const invoicing = await installInvoicingApp({
      serverUrl: s,
      token,
      orgId: world.org.id,
      bundlePath: INVOICING_BUNDLE,
      issuerCountry: "FR",
      additionalContacts: [
        { country: "US", name: "Globex US", email: "globex-s5@e2e.test", customerKind: "business" },
      ],
    })
    const contactId = invoicing.additionalContactIds[0]

    // 2. Install Boxtal + seed a sender + a shipping_profile for EVERY line's
    //    product (join key (product_source, product_id) = line (product_source,
    //    external_id)), each carrying the unit_weight (which lives in no upstream
    //    source) + solo dims.
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
          content_category: "content:v1:10120",
        },
        {
          product_source: "shopify",
          product_id: "VARIANT-BBB",
          unit_weight: 0.1,
          solo_length: 15,
          solo_width: 10,
          solo_height: 4,
        },
      ],
    })

    // 3. Seed the invoicing customs overlay for both products (the cross-app
    //    customs source the export invoice snapshots at issue time), then issue
    //    the US export invoice (both lines profiled).
    await assignCustoms(s, token, CUSTOMS_AAA)
    await assignCustoms(s, token, CUSTOMS_BBB)
    const invoiceId = await issueUsInvoice(s, token, invoicing.primaryIssuerProfileId, contactId, [
      LINE_A,
      LINE_B,
    ])

    // 4. Open the Boxtal draft — this performs the REAL cross-app
    //    invoicing:documents_get K4 read.
    const draftResp = await callTool(s, token, "boxtal", "shipment_draft_create", {
      document_ref: invoiceId,
    })
    expect(draftResp.status, JSON.stringify(draftResp)).toBe(200)
    const draft = draftResp as unknown as ShipmentDraft

    // --- The dogfood proof: real invoice values flowed across the K4 boundary. ---
    // US route ⇒ customs required.
    expect(draft.customs_required).toBe(true)
    expect(draft.route).toBe("US")
    expect(draft.recipient).toBe("Globex US")
    expect(draft.recipient_country).toBe("US")
    // Every line resolved (both profiled).
    expect(draft.unresolved).toEqual([])
    // Two customs articles, one per invoice line, mapping the invoice metadata.
    expect(draft.customsArticles.length).toBe(2)

    const byTariff = new Map(draft.customsArticles.map((a) => [a.tariffNumber, a]))
    const artA = byTariff.get("92071000")
    const artB = byTariff.get("85444290")
    expect(artA, "line A HS code flowed into tariffNumber").toBeTruthy()
    expect(artB, "line B HS code flowed into tariffNumber").toBeTruthy()
    // hs_code → tariffNumber, country_of_origin → originCountry,
    // customs_description → description, unit_weight from the profile.
    expect(artA?.originCountry).toBe("CN")
    expect(artA?.description).toBe("Electronic musical instrument controller")
    // unitWeight comes back as a numeric string from the bridge — coerce.
    expect(Number(artA?.unitWeight)).toBeCloseTo(0.8, 3)
    expect(Number(artA?.quantity)).toBe(1)
    expect(artB?.originCountry).toBe("VN")
    expect(artB?.description).toBe("Insulated USB-C data cable")
    expect(Number(artB?.unitWeight)).toBeCloseTo(0.1, 3)
    expect(Number(artB?.quantity)).toBe(2)

    // ZERO re-entry: no article is blocked (missing weight) or incomplete
    // (missing hs_code/origin) — every mandatory customs field is pre-filled.
    const mandatoryEmpty = draft.customsArticles.filter((a) => a.blocked || a.incomplete).length
    expect(mandatoryEmpty).toBe(0)
    expect(draft.customsArticles.every((a) => !a.blocked)).toBe(true)
    expect(draft.customsArticles.every((a) => !a.incomplete)).toBe(true)
    // Parcels resolved from the profiles. No pack covers these lines and the org
    // set no packaging policy, so every leftover item STACKS into ONE parcel
    // (resolver.ts): length = max length, width = max width, height = the sum of
    // the thicknesses, weight = the sum of the weights.
    expect(draft.parcels.length).toBe(1)
    const stacked = draft.parcels[0] as {
      length: number
      width: number
      height: number
      weight: number
    }
    expect(Number(stacked.length)).toBe(30)
    expect(Number(stacked.width)).toBe(20)
    expect(Number(stacked.height)).toBe(12 + 4 + 4)
    expect(Number(stacked.weight)).toBeCloseTo(0.8 + 0.1 * 2, 3)

    // 5. UI: the standalone Create-draft surface opens the same draft through the
    //    host bridge and pre-fills the recipient (name + country from the invoice).
    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/boxtal/create/${invoiceId}`)
    await page.waitForLoadState("networkidle")
    await expect(page.locator('[data-testid="boxtal-create-draft"]')).toBeVisible({
      timeout: 15_000,
    })
    // Click "Open draft" → loadDraft() runs shipment_draft_create via the bridge.
    await page.getByRole("button", { name: "Open draft" }).click()
    // The recipient form mounts with the invoice-derived name + country pre-filled.
    await expect(page.locator('[data-testid="boxtal-recipient-form"]')).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.locator('[data-testid="boxtal-recipient-name"]')).toHaveValue("Globex US")
    await expect(page.locator('[data-testid="boxtal-recipient-country"]')).toHaveValue("US")
    // A fully resolved draft shows no unresolved block.
    await expect(page.locator('[data-testid="boxtal-unresolved-block"]')).toHaveCount(0)
  })

  test("S6: an unprofiled line surfaces in unresolved and blocks the draft", async ({
    page,
    env,
    world,
    qa,
  }) => {
    assertBoxtalBundle()
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)
    const token = qa.admin.token
    const s = env.serverUrl
    await resetMock(s, token)

    const invoicing = await installInvoicingApp({
      serverUrl: s,
      token,
      orgId: world.org.id,
      bundlePath: INVOICING_BUNDLE,
      issuerCountry: "FR",
      additionalContacts: [
        { country: "US", name: "Globex US", email: "globex-s6@e2e.test", customerKind: "business" },
      ],
    })
    const contactId = invoicing.additionalContactIds[0]

    // Seed a profile for line A ONLY — line B's product is unprofiled.
    await installBoxtalApp({
      serverUrl: s,
      token,
      orgId: world.org.id,
      bundlePath: BOXTAL_BUNDLE,
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

    await assignCustoms(s, token, CUSTOMS_AAA)
    await assignCustoms(s, token, CUSTOMS_BBB)
    const invoiceId = await issueUsInvoice(s, token, invoicing.primaryIssuerProfileId, contactId, [
      LINE_A,
      LINE_B,
    ])

    const draftResp = await callTool(s, token, "boxtal", "shipment_draft_create", {
      document_ref: invoiceId,
    })
    expect(draftResp.status, JSON.stringify(draftResp)).toBe(200)
    const draft = draftResp as unknown as ShipmentDraft

    // Line B (VARIANT-BBB, no profile) is unresolved with reason no_profile.
    expect(draft.unresolved.length).toBe(1)
    expect(draft.unresolved[0].reason).toBe("no_profile")

    // UI: the create-draft surface shows the unresolved block + submit stays
    // disabled. Run this BEFORE the create_shipment refusal so the UI loads a
    // clean draft with no gating side effects on the document_ref.
    const consoleErrors: string[] = []
    page.on("pageerror", (e) => consoleErrors.push(e.message))
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text())
    })
    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/boxtal/create/${invoiceId}`)
    await page.waitForLoadState("networkidle")
    await expect(page.locator('[data-testid="boxtal-create-draft"]')).toBeVisible({
      timeout: 15_000,
    })
    await page.getByRole("button", { name: "Open draft" }).click()
    // The draft loaded and is BLOCKED: the unresolved block renders, and the
    // resolved body (recipient form, parcels, quotes) is gated off until every
    // line resolves ("Resolve every line before this draft can be quoted"). The
    // submit button stays present-but-disabled (asserted next).
    await expect(page.locator('[data-testid="boxtal-unresolved-block"]')).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.locator('[data-testid="boxtal-recipient-form"]')).toHaveCount(0)
    // Submit is gated/disabled while the draft has unresolved lines.
    await expect(page.locator('[data-testid="boxtal-create-submit"]')).toBeDisabled()
    const bridgeErrors = consoleErrors.filter((m) =>
      /window\.__liaisonHost|Failed to fetch dynamically imported module|does not provide an export named/.test(
        m,
      ),
    )
    expect(bridgeErrors).toEqual([])

    // create_shipment refuses an unresolved draft BEFORE any outbound POST.
    const createResp = await callTool(s, token, "boxtal", "create_shipment", {
      draft_id: invoiceId,
      // A US recipient quotes the INTERNATIONAL offers; create_shipment refuses a
      // code the route's own quote never returned, and needs its TTC price verbatim.
      offer_code: "DPDI-InternationalClassic",
      quoted_price_ttc: 49.56,
      recipient_phone: "+12125550000",
      recipient_address: {
        name: "Globex US",
        phone: "+12125550000",
        street: "1 Times Sq",
        city: "New York",
        postalCode: "10036",
        countryIsoCode: "US",
      },
    })
    // The gate fires first (create_shipment is gated) OR the handler returns the
    // unresolved error — either way no order is created. Accept both gating shapes.
    const blocked = createResp.blocked as { approvalRequestId?: string } | undefined
    const error = createResp.error as { code?: string } | undefined
    if (!blocked) {
      // If the kernel did not gate first, the handler refused the unresolved draft.
      expect(error?.code).toBe("unresolved_lines")
    }
  })
})
