// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 Task E2 — onShopifyOrderPaid handler tests.
//
// Drives the full 13-step §6 auto-flow at the bundled-app boundary against
// the shared `createMockDb` generic-CRUD surface. Issuer-to-shop mapping is
// stored as `issuer_profiles.shopify_shop_id`; documents store the shopify
// order id under `external_refs.shopify_order_id`. Deferred rows go to
// `deferred_events`.

import { testTime } from "../test-time"
import { describe, expect, setSystemTime, test } from "bun:test"
import type { CrossAppEnvelope } from "../cross-app"
import { creditNoteCreateAndIssue, documentsSendToCustomer, type MutationsCtx } from "../mutations"
import { deferredRetryJobHandler } from "./deferred-dispatch"
import {
  adaptShopifyOrderCreatedEvent,
  onShopifyOrderCreated,
  onShopifyOrderPaid,
  type IssuerProfileRow,
  type OrderPaidCtx,
  type OrderPaidPayload,
  shopifyTaxMismatches,
} from "./shopify-order-paid"
import { deferredTaxOverride, deferredTaxOverridePreflight } from "./tax-override"
import { deferredList } from "../reads"
import { createMockDb, type MockDb } from "../test-db"
import { LedgerDouble } from "../test-effects"
import { onShopifyOrderUpdated } from "../handlers"
import { bt23 } from "../einvoicing/classify-operation"
import { FR_SELLER_IDENTITY, seedConfirmedIdentity } from "../einvoicing/test-fixtures"

interface MockExtras {
  threadPosts: Array<{
    contact_id: string
    body: string
    attachment_file_ids: string[]
  }>
  renderCalls: Array<{ template_kind: string; data: unknown }>
  approvalsFiled: Array<{
    tool_name: string
    summary: string
    summary_detail?: {
      subtitle?: string
      lines?: string[]
      links?: Array<{ label: string; app: string; entityType: string; entityId: string }>
    }
    current_payload: unknown
  }>
  executeToolCalls: Array<{ name: string; args: string | Record<string, unknown> }>
  resolveContactCalls: Array<{ email?: string; name?: string; externalId?: string }>
}

interface OverlaySeed {
  source: string
  external_id: string
  hs_code: string | null
  country_of_origin: string | null
  customs_description: string | null
}

function issuerProfileToRow(
  profile: IssuerProfileRow,
  shopifyShopId: string | null,
): Record<string, unknown> {
  return {
    id: profile.id,
    legal_name: profile.legal_name,
    country: profile.country,
    vat_id: profile.vat_id,
    address: profile.address,
    iban: profile.iban,
    swift_bic: profile.swift_bic,
    bank_name: profile.bank_name,
    default_language: profile.default_language,
    prefix_invoice: profile.prefix_invoice,
    prefix_quote: profile.prefix_quote,
    prefix_proforma: profile.prefix_proforma,
    prefix_po: profile.prefix_po,
    invoice_approval_threshold_minor:
      profile.invoice_approval_threshold_minor != null
        ? String(profile.invoice_approval_threshold_minor)
        : null,
    auto_email_enabled: profile.auto_email_enabled ?? false,
    mail_account_id: profile.mail_account_id ?? null,
    timezone: profile.timezone ?? null,
    email_templates: profile.email_templates ?? {},
    siren: profile.siren ?? null,
    routing_address: profile.routing_address ?? null,
    address_line1: profile.address_line1 ?? null,
    postcode: profile.postcode ?? null,
    city: profile.city ?? null,
    country_code: profile.country_code ?? null,
    shopify_shop_id: shopifyShopId,
  }
}

/** contact-1's registry-confirmed identity (fictional SIREN, matches the basePayload VAT id). */
const CONTACT_1_IDENTITY: Record<string, unknown> = {
  id: "identity-contact-1",
  contact_id: "contact-1",
  customer_kind: "business",
  siren: "900000001",
  registry_name: "Acme France SAS",
  registry_line1: "10 rue Domestic",
  registry_postcode: "75001",
  registry_city: "Paris",
  registry_country_code: "FR",
  registry_status: "A",
  source: "registry",
  confirmed_via: "auto",
  changed_at: "2026-10-01T00:00:00Z",
}

function makeCtx(opts?: {
  overlay?: OverlaySeed[]
  failRenderTimes?: number
  failThreadPost?: boolean
  /** Issuer profiles to seed. Each profile may carry a `shopify_shop_id` link. */
  issuerProfiles?: Array<{ profile: IssuerProfileRow; shopify_shop_id: string | null }>
  approval?: { approvalRequestId: string; approvalDeciderId: string; toolName: string } | null
  executeToolResult?: CrossAppEnvelope
  executeToolByName?: Record<string, CrossAppEnvelope>
  /** Contact id the mocked `resolveContact` returns (default contact-resolved-1). */
  resolveContactId?: string
  /** Skip the default registry-confirmed identity of contact-1. */
  noDefaultIdentity?: boolean
}): { ctx: OrderPaidCtx; db: MockDb; extras: MockExtras } {
  const seed: Record<string, Array<Record<string, unknown>>> = {}
  if (opts?.overlay && opts.overlay.length > 0) {
    seed.product_customs_overlay = opts.overlay.map((o) => ({ ...o }))
  }
  if (opts?.issuerProfiles && opts.issuerProfiles.length > 0) {
    seed.issuer_profiles = opts.issuerProfiles.map((p) =>
      issuerProfileToRow(p.profile, p.shopify_shop_id),
    )
  }
  // The default buyer (basePayload, contact-1) is a French company: a registry-confirmed identity.
  if (!opts?.noDefaultIdentity) seed.counterparty_identities = [CONTACT_1_IDENTITY]
  const db = createMockDb({ seed })

  let failRenderRemaining = opts?.failRenderTimes ?? 0
  const failThreadPost = !!opts?.failThreadPost
  const extras: MockExtras = {
    threadPosts: [],
    renderCalls: [],
    approvalsFiled: [],
    executeToolCalls: [],
    resolveContactCalls: [],
  }
  const defaultExecuteToolResult: CrossAppEnvelope =
    opts?.executeToolResult ?? {
      status: "completed",
      result: { message_id: "mail-1" },
    }

  const ctx: OrderPaidCtx = {
    getUserId: async () => "user-1",
    approval: opts?.approval ?? null,
    db,
    time: testTime(),
    sequences: {
      async allocate({ key }) {
        const existing = await db.findMany("__sequences", {
          where: { key },
          limit: 1,
        })
        const current = existing[0] as { value?: number; id?: string } | undefined
        const next = (current?.value ?? 0) + 1
        if (current?.id) {
          await db.update("__sequences", String(current.id), { value: next })
        } else {
          await db.insert("__sequences", { key, value: next })
        }
        return { value: next }
      },
    },
    pdf: {
      async render(p) {
        extras.renderCalls.push(p)
        if (failRenderRemaining > 0) {
          failRenderRemaining -= 1
          throw Object.assign(new Error("render boom"), { code: "render_failed" })
        }
        return {
          file_id: `file-${extras.renderCalls.length}`,
          byte_size: 1024,
          page_count: 1,
          sha256: "0".repeat(64),
          parent_entity_id: crypto.randomUUID(),
        }
      },
    },
    messages: {
      async post(p) {
        if (failThreadPost) {
          throw Object.assign(new Error("thread boom"), {
            code: "thread_post_failed",
          })
        }
        extras.threadPosts.push(p)
        return { message_id: `msg-${extras.threadPosts.length}` }
      },
    },
    async executeTool(name, args) {
      extras.executeToolCalls.push({ name, args })
      const byName = opts?.executeToolByName?.[name]
      if (byName) return byName
      // Phase 17 fix C8 — default cross-app shopify:orders_get returns
      // 'completed' with no customer so the webhook payload remains
      // authoritative. Mail calls fall through to the generic result.
      if (name === "shopify:orders_get") {
        return { status: "completed", result: { customer: null } }
      }
      return defaultExecuteToolResult
    },
    async requestApproval(input) {
      extras.approvalsFiled.push({
        tool_name: input.tool_name,
        summary: input.summary,
        summary_detail: input.summary_detail,
        current_payload: input.current_payload,
      })
      return { approval_id: `approval-${extras.approvalsFiled.length}` }
    },
    async resolveContact(params) {
      extras.resolveContactCalls.push(params)
      // Mirror the kernel bridge: resolve-or-create returns the contact row.
      return { id: opts?.resolveContactId ?? "contact-resolved-1" }
    },
  }
  return { ctx, db, extras }
}

// ── Fixtures ────────────────────────────────────────────────────────────

const issuerFR: IssuerProfileRow = {
  id: "issuer-1",
  legal_name: "Société Générale Test SARL",
  country: "FR",
  vat_id: "FR12345678901",
  address: "1 rue de Test, 75001 Paris",
  iban: "FR7630006000011234567890189",
  swift_bic: "BNPAFRPP",
  bank_name: "BNP Test",
  default_language: "en",
  prefix_invoice: "INV-{YYYY}-",
  prefix_quote: "QUO-{YYYY}-",
  prefix_proforma: "PRO-{YYYY}-",
  prefix_po: "PO-{YYYY}-",
  invoice_approval_threshold_minor: null,
  auto_email_enabled: false,
  mail_account_id: "mail-account-1",
  email_templates: {},
  // The seller identity a French e-invoice (Factur-X) needs.
  ...FR_SELLER_IDENTITY,
}

const issuerES: IssuerProfileRow = {
  ...issuerFR,
  id: "issuer-2",
  legal_name: "Acme España SL",
  country: "ES", // not configured in tax.classify
  vat_id: "ESB12345678",
}

function basePayload(overrides?: Partial<OrderPaidPayload>): OrderPaidPayload {
  return {
    id: "shopify-order-1",
    shop_id: "shop-1",
    createdAt: "2026-05-15T10:00:00Z",
    total_price_minor: 12000n,
    currency: "EUR",
    customer: {
      id: "shopify-customer-1",
      email: "buyer@example.com",
      contact_id: "contact-1",
      country: "FR",
      legal_name: "Acme France SAS",
      vat_id: "FR68900000001",
      address: "10 rue Domestic, 75001 Paris",
      // Structured billing for the e-invoicing snapshot; the country code follows `country`.
      billing: {
        company: "Acme France SAS",
        line1: "10 rue Domestic",
        line2: null,
        postcode: "75001",
        city: "Paris",
        country_code: null,
      },
    },
    line_items: [
      {
        id: "shopify-product-1",
        description: "Widget A",
        quantity: "1",
        unit_price_minor: 10000n,
      },
    ],
    ...overrides,
  }
}

/** The default buyer relocated to the US: a US billing address and no French VAT id (an export). */
function usBuyer(): NonNullable<OrderPaidPayload["customer"]> {
  return {
    ...basePayload().customer!,
    country: "US",
    vat_id: null,
    address: "1 Export Road\nNew York, NY 10001",
    billing: {
      company: "Acme France SAS",
      line1: "1 Export Road",
      line2: null,
      postcode: "10001",
      city: "New York",
      country_code: "US",
    },
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("onShopifyOrderPaid auto-flow (E2)", () => {
  test("end-to-end: paid order with mapped issuer → issued invoice + PDF in contact thread", async () => {
    const { ctx, db, extras } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    const result = await onShopifyOrderPaid(basePayload(), ctx)
    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("unreachable")
    expect(result.number).toBe("INV-2026-0001")
    const docs = db.__all("documents")
    expect(docs).toHaveLength(1)
    const lines = db.__all("document_lines")
    expect(lines).toHaveLength(1)
    expect(extras.threadPosts).toHaveLength(1)
    expect(extras.threadPosts[0]!.attachment_file_ids).toEqual(["file-1"])
    expect(docs[0]!.external_refs).toEqual({
      shopify_order_id: "shopify-order-1",
      scope: "goods",
      shopify_shop_domain: "shop-1",
    })
    // The order carried only physical lines → a single goods-scope document.
    expect(docs[0]!.scope).toBe("goods")
    expect(result.documents).toHaveLength(1)
    // Counterparty snapshot carries the customer's email + address (both were
    // silently dropped pre-fix — the staging invoice had blank Bill-to fields).
    expect(docs[0]!.counterparty_email).toBe("buyer@example.com")
    expect(docs[0]!.counterparty_address).toBe("10 rue Domestic, 75001 Paris")
  })

  test("the order's HUMAN name reaches external_refs, the indexed column, and the PDF", async () => {
    // red: drop the order_number threading -> the invoice records only the numeric
    // order id, so nobody can find it by "#1149" and the PDF shows no order.
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    const result = await onShopifyOrderPaid(basePayload({ order_number: "#1149" }), ctx)
    expect(result.status).toBe("ok")
    const doc = db.__all("documents")[0]!
    expect((doc.external_refs as Record<string, unknown>).shopify_order_number).toBe("#1149")
    expect(doc.shopify_order_number).toBe("#1149")
  })

  test("an issuer zone the host does not know parks the order on the config: no document, no number", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    const issuerRow = db.__all("issuer_profiles")[0]!
    await db.update("issuer_profiles", String(issuerRow.id), { timezone: "Europe/Atlantis" })

    const res = await onShopifyOrderPaid(basePayload(), ctx)

    expect(res).toMatchObject({ status: "deferred", reason: "awaiting_config" })
    expect(db.__all("documents")).toHaveLength(0)
    expect(db.__all("__sequences")).toHaveLength(0)
    const [park] = db.__all("deferred_events")
    expect(park).toMatchObject({
      status: "awaiting_config",
      reason: "issuer_timezone_invalid",
      blocked_on: { kind: "issuer_timezone", issuer_profile_id: issuerRow.id },
    })

    // Fixed on the profile: the same order issues on the retry.
    await db.update("issuer_profiles", String(issuerRow.id), { timezone: "Europe/Paris" })
    expect((await onShopifyOrderPaid(basePayload(), ctx)).status).not.toBe("deferred")
    expect(db.__all("documents")).toHaveLength(1)
  })

  test("the issue date of an order follows the issuer's zone, on the bill and in the number year", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    const issuerRow = db.__all("issuer_profiles")[0]!
    await db.update("issuer_profiles", String(issuerRow.id), { timezone: "Europe/Paris" })
    setSystemTime(new Date("2026-12-31T23:20:00Z"))
    try {
      await onShopifyOrderPaid(basePayload(), ctx)
    } finally {
      setSystemTime()
    }
    const doc = db.__all("documents")[0]!
    expect(String(doc.issued_at)).toBe("2027-01-01")
    expect(doc.year_of_issue).toBe(2027)
    expect(String(doc.number)).toContain("2027")
  })

  test("no order name on the payload -> no order number recorded (never synthesised from the id)", async () => {
    // An older shopify-app build emits no `name`. Inventing "#shopify-order-1"
    // would print a reference that matches nothing in the store.
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    await onShopifyOrderPaid(basePayload(), ctx)
    const doc = db.__all("documents")[0]!
    expect((doc.external_refs as Record<string, unknown>).shopify_order_number).toBeUndefined()
    expect(doc.shopify_order_number).toBeNull()
  })

  test("a payload with no order name falls back to the enrichment fetch's order name", async () => {
    // Deferred rows written before order_number existed replay through this path,
    // as do payloads adapted by an older shopify-app build. `orders_get` returns
    // the order's `name`, so the reference is still recovered.
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
      executeToolByName: {
        "shopify:orders_get": { status: "completed", result: { name: "#2357", customer: null } },
      },
    })
    await onShopifyOrderPaid(basePayload(), ctx)
    expect(db.__all("documents")[0]!.shopify_order_number).toBe("#2357")
  })

  test("the ship to reaches the issued document's own columns, leaving the billing snapshot alone", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    const payload = basePayload()
    payload.customer = {
      ...payload.customer!,
      shipping_address: "Am Hafen 12\n21079 Hamburg\nDE",
      shipping_name: "Spedition Nord KG",
    }
    const result = await onShopifyOrderPaid(payload, ctx)
    expect(result.status).toBe("ok")
    const doc = db.__all("documents")[0]!
    expect(doc.counterparty_address).toBe("10 rue Domestic, 75001 Paris")
    expect(doc.counterparty_shipping_address).toBe("Am Hafen 12\n21079 Hamburg\nDE")
    expect(doc.counterparty_shipping_name).toBe("Spedition Nord KG")
    // HARD CONSTRAINT: the ship to is render only. The billing country still decides the tax.
    expect(doc.counterparty_country).toBe("FR")
    expect(doc.tax_treatment).toBe("eu_domestic")
  })

  test("the enrichment fetch fills a MISSING ship to instead of using it as the billing address", async () => {
    // This path used to take shippingAddress and hand it back AS `address`, with no ship to of
    // its own, so an enriched order printed the destination where the billing address belongs.
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
      executeToolByName: {
        "shopify:orders_get": {
          status: "completed",
          result: {
            name: "#2357",
            customer: null,
            shippingAddress: {
              name: "Spedition Nord KG",
              address1: "Am Hafen 12",
              zip: "21079",
              city: "Hamburg",
              countryCode: "DE",
            },
          },
        },
      },
    })
    await onShopifyOrderPaid(basePayload(), ctx)
    const doc = db.__all("documents")[0]!
    // The webhook's billing address wins, exactly as before.
    expect(doc.counterparty_address).toBe("10 rue Domestic, 75001 Paris")
    expect(doc.counterparty_shipping_address).toBe("Am Hafen 12\n21079 Hamburg\nDE")
    expect(doc.counterparty_shipping_name).toBe("Spedition Nord KG")
    expect(doc.counterparty_country).toBe("FR")
  })

  test("paid order → invoice recorded PAID (payment_status/paid_at) while staying status='issued'", async () => {
    const { ctx, db, extras } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    const result = await onShopifyOrderPaid(
      basePayload({ financial_status: "paid" }),
      ctx,
    )
    expect(result.status).toBe("ok")
    const docs = db.__all("documents")
    expect(docs).toHaveLength(1)
    const doc = docs[0]!
    // Payment side settled…
    expect(doc.payment_status).toBe("paid")
    expect(doc.paid_at).toBe("2026-05-15") // order createdAt date
    // …but the invoice stays a live, shippable issued document (boxtal reads
    // status='issued'; flipping to 'paid' here would drop it from shipping).
    expect(doc.status).toBe("issued")
    const log = (doc.lifecycle_log ?? []) as Array<Record<string, unknown>>
    expect(log.map((e) => e.event)).toContain("issued")
    expect(log.map((e) => e.event)).toContain("marked_paid")
    expect(log.find((e) => e.event === "marked_paid")?.source).toBe("shopify_order_paid")
    // The settlement is threaded through issuance, so the FIRST (and only) render already carries
    // payment_status="paid" — the PDF reads "Amount paid" with no stale "Total due" pass. This is
    // the crux of the field report: a paid Shopify invoice must not render as owed.
    expect(extras.renderCalls).toHaveLength(1)
    const renderDoc = (extras.renderCalls[0]!.data as { document: Record<string, unknown> }).document
    expect(renderDoc.payment_status).toBe("paid")
    expect(renderDoc.paid_at).toBe("2026-05-15")
  })

  test("unpaid/pending order → invoice left UNPAID (no paid reconciliation)", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    const result = await onShopifyOrderPaid(
      basePayload({ financial_status: "pending" }),
      ctx,
    )
    expect(result.status).toBe("ok")
    const doc = db.__all("documents")[0]!
    expect(doc.payment_status ?? "unpaid").toBe("unpaid")
    expect(doc.status).toBe("issued")
    const log = (doc.lifecycle_log ?? []) as Array<Record<string, unknown>>
    expect(log.map((e) => e.event)).not.toContain("marked_paid")
  })

  test("adaptShopifyOrderCreatedEvent carries financial_status + shop domain onto the payload", () => {
    const payload = adaptShopifyOrderCreatedEvent({
      orderId: "9001",
      shopDomain: "acme.myshopify.com",
      createdAt: "2026-06-01T09:00:00Z",
      financialStatus: "paid",
      totalPrice: { amount: "120.00", currencyCode: "EUR" },
      customer: { id: "c1", email: "b@example.com" },
      lineItems: [
        { id: "l1", title: "Widget", quantity: 1, priceSet: { amount: "120.00", currencyCode: "EUR" } },
      ],
    })
    expect(payload.financial_status).toBe("paid")
    expect(payload.shop_id).toBe("acme.myshopify.com")
  })

  test("customs-required export + retryable Shopify throttle → deferred, no incomplete invoice issued", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
      executeToolByName: {
        "shopify:variants_get": {
          status: "error",
          error: { code: "RATE_LIMIT", message: "Shopify 429 (rate limit) after 3 retries", retryable: true },
        },
      },
    })
    // FR issuer → US customer = eu_export_non_eu (requires_hs_code: true). A
    // retryable throttle on the live customs fetch must NOT yield a
    // customs-incomplete export invoice — it defers for retry instead.
    const base = basePayload()
    const result = await onShopifyOrderPaid(
      basePayload({ customer: usBuyer() }),
      ctx,
    )
    expect(result.status).toBe("deferred")
    if (result.status !== "deferred") throw new Error("unreachable")
    expect(result.reason).toBe("awaiting_dependency")
    // Nothing persisted — the bail happens before number allocation + insert.
    expect(db.__all("documents")).toHaveLength(0)
    const deferred = db.__all("deferred_events")
    expect(deferred).toHaveLength(1)
    expect(deferred[0]!.status).toBe("awaiting_dependency")
    expect(deferred[0]!.reason).toBe("awaiting_customs_dependency")
  })

  test("domestic order → issue-time customs fetch SKIPPED (HS codes not legally required) → issued, no variants_get call", async () => {
    const { ctx, db, extras } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
      executeToolByName: {
        // Were the customs fetch (wrongly) attempted for a domestic invoice it would
        // hit this mock; assert below it is NOT called.
        "shopify:variants_get": {
          status: "error",
          error: { code: "RATE_LIMIT", message: "throttled", retryable: true },
        },
      },
    })
    // FR issuer → FR customer = eu_domestic (requires_hs_code: false). The issue-time
    // live customs fetch only runs when the invoice legally needs HS codes (extra-EU
    // export). For a domestic invoice it is skipped entirely — so a custom line / a
    // since-deleted variant (no resolvable variant) can't spam errors or block
    // issuance. The persisted overlay, if any, is still applied.
    const result = await onShopifyOrderPaid(basePayload(), ctx)
    expect(result.status).toBe("ok")
    const docs = db.__all("documents")
    expect(docs).toHaveLength(1)
    expect(extras.executeToolCalls.some((c) => c.name === "shopify:variants_get")).toBe(false)
    const log = (docs[0]!.lifecycle_log ?? []) as Array<Record<string, unknown>>
    expect(log.find((e) => e.event === "customs_fetch_failed")).toBeUndefined()
  })

  test("missing issuer mapping → parks awaiting_config", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: null }],
    })
    const result = await onShopifyOrderPaid(basePayload(), ctx)
    expect(result.status).toBe("deferred")
    const deferred = db.__all("deferred_events")
    expect(deferred).toHaveLength(1)
    expect(deferred[0]!.status).toBe("awaiting_config")
    expect(deferred[0]!.blocked_on).toEqual({
      kind: "issuer_mapping",
      shop_id: "shop-1",
    })
    expect(db.__all("documents")).toHaveLength(0)
  })

  test("missing contact email → parks awaiting_data", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    const result = await onShopifyOrderPaid(
      basePayload({
        customer: {
          id: "shopify-customer-1",
          email: null,
          contact_id: "contact-1",
          country: "FR",
        },
      }),
      ctx,
    )
    expect(result.status).toBe("deferred")
    const deferred = db.__all("deferred_events")
    expect(deferred[0]!.status).toBe("awaiting_data")
    expect(deferred[0]!.reason).toBe("customer_email_missing")
    expect(db.__all("documents")).toHaveLength(0)
  })

  test("total_price = 0 → no-op, no document created", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    const result = await onShopifyOrderPaid(
      basePayload({ total_price_minor: 0n }),
      ctx,
    )
    expect(result.status).toBe("skipped")
    if (result.status !== "skipped") throw new Error("unreachable")
    expect(result.reason).toBe("zero_total")
    expect(db.__all("documents")).toHaveLength(0)
    expect(db.__all("deferred_events")).toHaveLength(0)
  })

  test("amount > threshold → returns pending_approval (no document yet)", async () => {
    const issuerWithThreshold: IssuerProfileRow = {
      ...issuerFR,
      invoice_approval_threshold_minor: 5000n,
    }
    const { ctx, db, extras } = makeCtx({
      issuerProfiles: [{ profile: issuerWithThreshold, shopify_shop_id: "shop-1" }],
    })
    const result = await onShopifyOrderPaid(basePayload(), ctx)
    expect(result.status).toBe("pending_approval")
    if (result.status !== "pending_approval") throw new Error("unreachable")
    expect(result.approval_id).toMatch(/^approval-/)
    expect(db.__all("documents")).toHaveLength(0)
    expect(extras.approvalsFiled).toHaveLength(1)
    expect(extras.approvalsFiled[0]!.tool_name).toBe(
      "invoicing:onShopifyOrderPaid",
    )
    // The effect in one sentence; the order's API id is never shown (it has no store name here).
    expect(extras.approvalsFiled[0]!.summary).toBe("Issue invoice for Acme France SAS, 120.00 EUR")
    const detail = extras.approvalsFiled[0]!.summary_detail!
    expect([extras.approvalsFiled[0]!.summary, ...(detail.lines ?? [])].join("\n")).not.toContain("shopify-order-1")
    expect(detail.subtitle).toContain("Acme France SAS")
    expect(detail.lines).toContain("Customer: Acme France SAS")
    expect(detail.lines).toContain("Line: Widget A x 1 @ 100.00 EUR")
    expect(detail.lines).toContain("Total: 120.00 EUR")
  })

  test("re-invocation post-approval: ctx.approval populated → threshold skipped, document issued", async () => {
    const issuerWithThreshold: IssuerProfileRow = {
      ...issuerFR,
      invoice_approval_threshold_minor: 5000n,
    }
    const { ctx, db, extras } = makeCtx({
      issuerProfiles: [{ profile: issuerWithThreshold, shopify_shop_id: "shop-1" }],
      approval: {
        approvalRequestId: "approval-1",
        approvalDeciderId: "user-2",
        toolName: "invoicing:shopify_order_paid",
      },
    })
    const result = await onShopifyOrderPaid(basePayload(), ctx)
    expect(result.status).toBe("ok")
    expect(extras.approvalsFiled).toHaveLength(0)
    expect(db.__all("documents")).toHaveLength(1)
  })

  test("auto-email with a malformed error envelope (no .code) → invoice survives (no rollback), email deferred", async () => {
    // Regression: `composeResult.error.code` was read UNGUARDED. A cross-app mail
    // dispatch that returns an error status WITHOUT a populated `error` (e.g. mail
    // uninstalled / an unexpected dispatch shape) made `.code` throw — AFTER the
    // invoice issued — rolling back the whole ambient transaction (issued invoice +
    // its number vanished). The invoice is the primary artifact; a failed auto-email
    // must only DEFER. The guard (`error?.code`) keeps issuance intact.
    const issuerAutoEmail: IssuerProfileRow = {
      ...issuerFR,
      auto_email_enabled: true,
      mail_account_id: "mail-account-1",
    }
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerAutoEmail, shopify_shop_id: "shop-1" }],
      executeToolByName: {
        // A runtime contract violation TypeScript's union forbids but the dispatch
        // can produce: status "error" with no `error` object. Inject it to prove the
        // handler no longer crashes on it.
        "mail:composeForApp": { status: "error" } as unknown as CrossAppEnvelope,
      },
    })
    const result = await onShopifyOrderPaid(basePayload(), ctx)
    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("unreachable")
    expect(result.document_id).toBeTruthy()
    // The invoice persisted (NOT rolled back by the email-step crash)…
    expect(db.__all("documents")).toHaveLength(1)
    // …and the failed auto-email is recorded as a deferred email_failed row.
    const deferred = db.__all("deferred_events")
    expect(deferred.some((d) => d.reason === "email_failed")).toBe(true)
  })

  test("enrichment fetch uses a Shopify GID (orders_get), not the bare numeric order id", async () => {
    // Regression: tryFetchShopifyOrder passed the webhook's bare numeric order id to
    // `shopify:orders_get`, which expects a GID — Shopify rejected every fetch
    // ("Variable $id ... invalid value"), silently disabling customer enrichment and
    // spamming server-error logs (chaos server_error_rate probe). Assert the call is
    // GID-normalized.
    const { ctx, extras } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    await onShopifyOrderPaid(basePayload({ id: "12777498083494" }), ctx)
    const ordersGet = extras.executeToolCalls.find((c) => c.name === "shopify:orders_get")
    expect(ordersGet).toBeDefined()
    const args = ordersGet!.args as { id?: string }
    expect(args.id).toBe("gid://shopify/Order/12777498083494")
  })

  test("step 6: unconfigured issuer regime (ES) → parks awaiting_config until admin adds rule", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerES, shopify_shop_id: "shop-1" }],
    })
    const result = await onShopifyOrderPaid(
      basePayload({
        customer: {
          id: "c1",
          email: "buyer@example.com",
          contact_id: "contact-1",
          country: "ES",
          legal_name: "Spanish customer",
          vat_id: null,
        },
      }),
      ctx,
    )
    expect(result.status).toBe("deferred")
    const deferred = db.__all("deferred_events")
    expect(deferred[0]!.status).toBe("awaiting_config")
    expect(deferred[0]!.reason).toBe("tax_regime_unconfigured")
    expect(db.__all("documents")).toHaveLength(0)
  })

  test("step 7: product missing from customs overlay → line hs_code = null; document still issues", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
      overlay: [],
    })
    const result = await onShopifyOrderPaid(basePayload(), ctx)
    expect(result.status).toBe("ok")
    expect(db.__all("documents")).toHaveLength(1)
    const lines = db.__all("document_lines")
    expect(lines).toHaveLength(1)
    expect(lines[0]!.hs_code).toBeNull()
    expect(lines[0]!.country_of_origin).toBeNull()
  })

  test("step 11: render_failed → document persists with pdf_status='failed'; deferred row created", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
      failRenderTimes: 1,
    })
    const result = await onShopifyOrderPaid(basePayload(), ctx)
    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("unreachable")
    expect(result.pdf_file_id).toBeNull()
    const docs = db.__all("documents")
    expect(docs).toHaveLength(1)
    expect(docs[0]!.pdf_status).toBe("failed")
    expect(
      db.__all("deferred_events").find((d) => d.status === "render_failed"),
    ).toBeDefined()
  })

  test("step 12: thread post failure → document persists; lifecycle log records failure; no inline retry", async () => {
    const { ctx, db, extras } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
      failThreadPost: true,
    })
    const result = await onShopifyOrderPaid(basePayload(), ctx)
    expect(result.status).toBe("ok")
    const docs = db.__all("documents")
    expect(docs).toHaveLength(1)
    expect(extras.threadPosts).toHaveLength(0)
    const log = docs[0]!.lifecycle_log as Array<Record<string, unknown>>
    expect(log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "thread_post_failed" }),
      ]),
    )
  })

  test("step 13: auto_email_enabled=true → mail:composeForApp called once; no mail:compose call", async () => {
    const issuerEmailOn: IssuerProfileRow = {
      ...issuerFR,
      auto_email_enabled: true,
    }
    const { ctx, extras } = makeCtx({
      issuerProfiles: [{ profile: issuerEmailOn, shopify_shop_id: "shop-1" }],
    })
    const result = await onShopifyOrderPaid(basePayload(), ctx)
    expect(result.status).toBe("ok")
    const composeForAppCalls = extras.executeToolCalls.filter(
      (c) => c.name === "mail:composeForApp",
    )
    const composeCalls = extras.executeToolCalls.filter(
      (c) => c.name === "mail:compose",
    )
    expect(composeForAppCalls).toHaveLength(1)
    expect(composeCalls).toHaveLength(0)
    // Phase 17 fix Q2 — handler passes plain objects to executeTool now.
    const args = composeForAppCalls[0]!.args as Record<string, unknown>
    expect(args.accountId).toBe("mail-account-1")
    expect(args.to).toEqual(["buyer@example.com"])
    expect(args.textBody).toMatch(/invoice/i)
    expect(args.attachments).toEqual(["file-1"])
  })

  test("step 13: the auto email attaches each invoice's LEGAL ORIGINAL (its recorded file)", async () => {
    const issuerEmailOn: IssuerProfileRow = { ...issuerFR, auto_email_enabled: true }
    const { ctx, db, extras } = makeCtx({ issuerProfiles: [{ profile: issuerEmailOn, shopify_shop_id: "shop-1" }] })
    await onShopifyOrderPaid(basePayload(), ctx)
    const legal = db.__all("legal_originals") as Array<Record<string, unknown>>
    expect(legal).toHaveLength(1)
    expect(legal[0]?.kind).toBe("facturx")
    const args = extras.executeToolCalls.find((c) => c.name === "mail:composeForApp")!.args as Record<string, unknown>
    expect(args.attachments).toEqual([legal[0]!.file_id])
  })

  test("step 13: auto_email_enabled=false → no mail tool call", async () => {
    const { ctx, extras } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    await onShopifyOrderPaid(basePayload(), ctx)
    // Phase 17 fix C8 — cross-app shopify:orders_get fetch may fire; mail calls
    // must NOT.
    const mailCalls = extras.executeToolCalls.filter((c) =>
      c.name.startsWith("mail:"),
    )
    expect(mailCalls).toHaveLength(0)
  })

  test("step 13: mail target_app_unavailable → parks awaiting_dependency; document persists", async () => {
    const issuerEmailOn: IssuerProfileRow = {
      ...issuerFR,
      auto_email_enabled: true,
    }
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerEmailOn, shopify_shop_id: "shop-1" }],
      executeToolByName: {
        "mail:composeForApp": {
          status: "error",
          error: { code: "target_app_unavailable", message: "mail not installed" },
        },
      },
    })
    const result = await onShopifyOrderPaid(basePayload(), ctx)
    expect(result.status).toBe("ok") // document still persists
    expect(db.__all("documents")).toHaveLength(1)
    const def = db
      .__all("deferred_events")
      .find((d) => d.reason === "awaiting_email_dependency")
    expect(def).toBeDefined()
    expect(def!.status).toBe("awaiting_dependency")
  })

  test("idempotency: same shopify order_id processed twice → exactly one document", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    const r1 = await onShopifyOrderPaid(basePayload(), ctx)
    expect(r1.status).toBe("ok")
    const r2 = await onShopifyOrderPaid(basePayload(), ctx)
    expect(r2.status).toBe("skipped")
    if (r2.status !== "skipped") throw new Error("unreachable")
    expect(r2.reason).toBe("duplicate_document")
    expect(db.__all("documents")).toHaveLength(1)
  })

  test("idempotency holds when the org has more documents than any bounded slice", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    const r1 = await onShopifyOrderPaid(basePayload(), ctx)
    expect(r1.status).toBe("ok")

    // Bury the issued invoice under noise documents that do NOT match the
    // order id, exceeding the old unordered 200-row lookup window. The
    // indexed equality lookup must still find the prior invoice and skip.
    const noise: Array<Record<string, unknown>> = []
    for (let i = 0; i < 250; i++) {
      noise.push({
        id: `noise-${i}`,
        status: "issued",
        external_refs: {},
        shopify_order_id: null,
      })
    }
    db.__seed("documents", noise)

    const r2 = await onShopifyOrderPaid(basePayload(), ctx)
    expect(r2.status).toBe("skipped")
    if (r2.status !== "skipped") throw new Error("unreachable")
    expect(r2.reason).toBe("duplicate_document")
    // Only the original invoice — no duplicate among the noise.
    expect(
      db.__all("documents").filter((d) => d.shopify_order_id === "shopify-order-1"),
    ).toHaveLength(1)
  })

  // PO number inheritance: convertViaShopifyDraftOrder (mutations.ts) writes shopify_order_id
  // back onto the quote once its draft order completes, so the resulting order-paid invoice can
  // find its way back to the quote it came from and borrow the PO the order itself lost.
  test("order paid with NO po_number, but the mapped quote it converted from carries one -> the invoice inherits it, lifecycle_log names the quote", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    const quote = await db.insert("documents", {
      type: "quote",
      status: "invoiced",
      number: "QUO-2026-0001",
      po_number: "PO-8842",
      shopify_order_id: "shopify-order-1",
      external_refs: { shopify_order_id: "shopify-order-1" },
      lifecycle_log: [],
      created_at: "2026-05-01T00:00:00Z",
    })
    const result = await onShopifyOrderPaid(basePayload(), ctx)
    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("unreachable")
    const doc = db.__all("documents").find((d) => d.id !== quote.id)!
    expect(doc.po_number).toBe("PO-8842")
    expect((doc.external_refs as Record<string, unknown>).po_number).toBe("PO-8842")
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    const inherited = log.find((e) => e.event === "po_number_inherited")
    expect(inherited).toBeDefined()
    expect(inherited?.po_number).toBe("PO-8842")
    expect(inherited?.from_quote_id).toBe(quote.id)
    expect(inherited?.from_quote_number).toBe("QUO-2026-0001")
  })

  test("order paid WITH its own po_number -> the order's PO wins, no inheritance even though the quote carries a different one", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    await db.insert("documents", {
      type: "quote",
      status: "invoiced",
      number: "QUO-2026-0001",
      po_number: "PO-8842",
      shopify_order_id: "shopify-order-1",
      external_refs: { shopify_order_id: "shopify-order-1" },
      lifecycle_log: [],
      created_at: "2026-05-01T00:00:00Z",
    })
    const result = await onShopifyOrderPaid(
      basePayload({ po_number: "PO-order-own" }),
      ctx,
    )
    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("unreachable")
    const doc = db.__all("documents").find((d) => d.type !== "quote")!
    expect(doc.po_number).toBe("PO-order-own")
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    expect(log.find((e) => e.event === "po_number_inherited")).toBeUndefined()
  })
})

// The Shopify app publishes order events with its OWN normalized shape
// (bundled-apps/shopify/src/webhooks.ts normalizeOrder). The adapter maps that
// into OrderPaidPayload. These pin the cross-app contract.
describe("adaptShopifyOrderCreatedEvent (cross-app contract)", () => {
  const normalizedEvent = {
    orderId: "7775256",
    shopDomain: "acme.myshopify.com",
    totalPrice: { amount: "120.00", currencyCode: "EUR" },
    customer: { id: "8888545", email: "buyer@example.com", first_name: "Auto", last_name: "Flow" },
    billingAddress: {
      address1: "10 rue Domestic",
      zip: "75001",
      city: "Paris",
      country_code: "FR",
    },
    lineItems: [
      {
        id: "li-1",
        title: "Auto-flow widget",
        quantity: 2,
        priceSet: { amount: "60.00", currencyCode: "EUR" },
        variant: { id: "5550001" },
      },
    ],
  }

  test("maps the normalized shopify shape → OrderPaidPayload", () => {
    const p = adaptShopifyOrderCreatedEvent(normalizedEvent)
    expect(p.id).toBe("7775256")
    expect(p.shop_id).toBe("acme.myshopify.com")
    expect(p.currency).toBe("EUR")
    // Major decimal string → integer minor units, as a STRING (bridge-safe).
    expect(p.total_price_minor).toBe("12000")
    expect(typeof p.total_price_minor).toBe("string")
    expect(p.customer?.email).toBe("buyer@example.com")
    expect(p.customer?.legal_name).toBe("Auto Flow")
    expect(p.line_items).toHaveLength(1)
    expect(p.line_items[0]).toMatchObject({
      // Numeric webhook variant_id → gid (matches the gid-keyed customs overlay
      // + shopify:variants_get). Variant id preferred over line id.
      id: "gid://shopify/ProductVariant/5550001",
      description: "Auto-flow widget",
      quantity: "2",
      unit_price_minor: "6000",
    })
  })

  test("the order's human name (`name`) is carried onto the payload as order_number", () => {
    const p = adaptShopifyOrderCreatedEvent({ ...normalizedEvent, name: " #1149 " })
    expect(p.order_number).toBe("#1149")
  })

  test("an event with no `name` yields a null order_number, not the numeric id", () => {
    const p = adaptShopifyOrderCreatedEvent(normalizedEvent)
    expect(p.order_number).toBeNull()
  })

  // Cross-app contract seam: the shopify app's order:created event carries the PO number as
  // `poNumber` (camelCase, event-shape convention); this reads it and normalizes it onto
  // `OrderPaidPayload.po_number` (snake_case, tool/column convention).
  test("the order's PO number (`poNumber`) is carried onto the payload as po_number", () => {
    const p = adaptShopifyOrderCreatedEvent({ ...normalizedEvent, poNumber: " PO-4471 " })
    expect(p.po_number).toBe("PO-4471")
  })

  test("an event with no poNumber yields a null po_number, never fabricated", () => {
    const p = adaptShopifyOrderCreatedEvent(normalizedEvent)
    expect(p.po_number).toBeNull()
  })

  // Requested by Priya: an order billed to one address and shipped to another used to keep only
  // the billing address, so the ship to was read (as a billing FALLBACK) and then discarded.
  test("the shipping address is captured as its OWN field, not swallowed by the billing fallback", () => {
    const p = adaptShopifyOrderCreatedEvent({
      ...normalizedEvent,
      shippingAddress: {
        name: "Spedition Nord KG",
        address1: "Am Hafen 12",
        zip: "21079",
        city: "Hamburg",
        country_code: "DE",
      },
    })
    // Billing untouched: the existing `billingAddress ?? shippingAddress` fallback still wins.
    expect(p.customer?.address).toBe("10 rue Domestic\n75001 Paris")
    expect(p.customer?.country).toBe("FR")
    // ...and the ship to now survives, country folded in (it prints no separate country line).
    expect(p.customer?.shipping_address).toBe("Am Hafen 12\n21079 Hamburg\nDE")
    expect(p.customer?.shipping_name).toBe("Spedition Nord KG")
  })

  test("an order with no shipping address yields a null ship to, never a copy of the billing one", () => {
    const p = adaptShopifyOrderCreatedEvent(normalizedEvent)
    expect(p.customer?.shipping_address).toBeNull()
    expect(p.customer?.shipping_name).toBeNull()
  })

  // The ship to is RENDER ONLY. classify() keys off counterparty_country, which comes from the
  // BILLING address; a ship to in another country must not move the tax treatment one inch.
  test("a ship to in another country keeps the PRINTED billing country, and is the tax country", () => {
    const p = adaptShopifyOrderCreatedEvent({
      ...normalizedEvent,
      shippingAddress: { address1: "1 Export Road", city: "New York", country_code: "US" },
    })
    // Printed under the billing address: the billing country.
    expect(p.customer?.country).toBe("FR")
    expect(p.customer?.shipping_address).toContain("US")
    // Classified on where the goods go (what the shopify app already resolved as the destination).
    expect(p.customer?.tax_country).toBe("US")
  })

  test("an already-gid variant id passes through unchanged", () => {
    const p = adaptShopifyOrderCreatedEvent({
      ...normalizedEvent,
      lineItems: [
        {
          id: "li-1",
          title: "Widget",
          quantity: 1,
          priceSet: { amount: "10.00", currencyCode: "EUR" },
          variant: { id: "gid://shopify/ProductVariant/9001" },
        },
      ],
    })
    expect(p.line_items[0]?.id).toBe("gid://shopify/ProductVariant/9001")
  })

  test("JPY (zero-decimal) amounts are not scaled by 100", () => {
    const p = adaptShopifyOrderCreatedEvent({
      ...normalizedEvent,
      totalPrice: { amount: "1200", currencyCode: "JPY" },
    })
    expect(p.total_price_minor).toBe("1200")
  })

  test("a buyer VAT number on an EU cross-border order triggers reverse charge without any lookup", async () => {
    // The buyer's VAT number is the buyer's own declaration: no registry check sits between it and
    // the reverse-charge treatment, and the handler makes no network call for it.
    let fetched = false
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    const result = await onShopifyOrderPaid(
      basePayload({
        customer: {
          id: "c-eu",
          email: "buyer@example.com",
          contact_id: "contact-1",
          country: "DE",
          legal_name: "EU Buyer GmbH",
          vat_id: "DE123456789",
          address: "Hauptstrasse 5, 10115 Berlin",
        },
        line_items: [{ id: "prod-1", description: "Software", quantity: "1", unit_price_minor: 10000n }],
      }),
      {
        ...ctx,
        fetch: async () => {
          fetched = true
          return { status: 200, headers: {}, body: JSON.stringify({ isValid: false }) }
        },
      } as typeof ctx,
    )
    expect(result.status).toBe("ok")
    expect(fetched).toBe(false)
    const docs = db.__all("documents") as Array<Record<string, unknown>>
    expect(docs.some((d) => d.tax_treatment === "eu_reverse_charge")).toBe(true)
  })

  test("threshold gate uses computed invoice total from line items, not Shopify gross total", async () => {
    // Shopify total_price_minor is 15000n but the computed invoice total is
    // 10000n (1 line × 10000n at 0% — EU B2B reverse charge).
    // Threshold is 12000n. Gate should NOT fire (computed 10000n < 12000n)
    // even though Shopify gross (15000n) would exceed it.
    const issuerWithThreshold: IssuerProfileRow = {
      ...issuerFR,
      invoice_approval_threshold_minor: 12000n,
    }
    const { ctx, db, extras } = makeCtx({
      issuerProfiles: [{ profile: issuerWithThreshold, shopify_shop_id: "shop-1" }],
    })
    const result = await onShopifyOrderPaid(
      basePayload({
        total_price_minor: 15000n, // Shopify gross differs from recomputed total
        customer: {
          id: "c-eu",
          email: "buyer@example.com",
          contact_id: "contact-1",
          country: "DE", // EU B2B → reverse charge → 0% VAT
          legal_name: "EU Buyer GmbH",
          vat_id: "DE123456789", // has_vat_id = true → reverse charge
          address: "Hauptstrasse 5, 10115 Berlin",
        },
        line_items: [
          {
            id: "prod-1",
            description: "Software",
            quantity: "1",
            unit_price_minor: 10000n,
          },
        ],
      }),
      ctx,
    )
    // Computed invoice total = 10000n (0% reverse charge). Threshold 12000n → no gate.
    expect(result.status).toBe("ok")
    expect(extras.approvalsFiled).toHaveLength(0)
    expect(db.__all("documents")).toHaveLength(1)
    // Verify the persisted grand_total equals the computed 10000n (not 15000n).
    const doc = db.__all("documents")[0]!
    expect(BigInt(String(doc.grand_total_minor))).toBe(10000n)
  })

  test("onShopifyOrderCreated unwraps the kernel event envelope and resolves contact_id", async () => {
    const { ctx, db, extras } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "acme.myshopify.com" }],
      resolveContactId: "kernel-contact-9",
    })
    // The kernel passes the FULL envelope; the normalized order is under `.data`.
    const result = await onShopifyOrderCreated(
      { entity: "order", action: "created", data: normalizedEvent } as never,
      ctx,
    )
    expect(result.status).toBe("ok")
    expect(extras.resolveContactCalls[0]?.externalId).toBe("8888545")
    // The issued document is filed against the resolved kernel contact.
    expect(db.__all("documents")[0]?.counterparty_contact_id).toBe("kernel-contact-9")
  })
})

describe("deferred-retry dispatch (cron re-drive)", () => {
  test("re-issues a parked customs throttle once the variants fetch succeeds", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
      // The throttle has cleared — the customs fetch now returns the HS triple.
      executeToolByName: {
        "shopify:variants_get": {
          status: "completed",
          result: {
            attributes: {
              hs_code: "92071000",
              country_of_origin: "FR",
              customs_description: "Widget",
            },
          },
        },
      },
    })
    // The cron ctx is the full bridge: augment the test OrderPaidCtx with the two
    // extra MutationsCtx channels so it satisfies the dispatch's ctx type.
    // `db` (full MockDb) overrides ctx.db (typed as the narrower IssueDb) so the
    // augmented ctx satisfies the MutationsCtx surface the dispatch needs.
    const cronCtx = {
      ...ctx,
      db,
      emit: async () => {},
      decideApproval: async () => ({ status: "ok" as const }),
    }

    // A customs-required export, parked at issue time by a retryable throttle —
    // nothing was persisted (the bail happens before the document insert).
    const base = basePayload({ customer: usBuyer() })
    await db.insert("deferred_events", {
      event_id: base.id,
      event_payload_json: base,
      status: "awaiting_dependency",
      reason: "awaiting_customs_dependency",
      blocked_on: { kind: "customs", code: "RATE_LIMIT" },
      retry_count: 0,
      retried_at: null,
      created_at: "2026-05-15T10:00:00Z",
    })

    const result = await deferredRetryJobHandler(undefined, cronCtx, {
      now: new Date("2026-05-15T10:05:00Z"),
    })

    // The drain re-issued the parked order…
    expect(result.succeeded).toBe(1)
    expect(db.__all("documents")).toHaveLength(1)
    // …and the previously-throttled HS code now carries onto the line.
    expect((db.__all("document_lines")[0] as Record<string, unknown>).hs_code).toBe("92071000")
    // …and the deferred row is resolved (won't be swept again).
    expect((db.__all("deferred_events")[0] as Record<string, unknown>).status).toBe("resolved")
  })

  test("the deferred email retry sends the LEGAL ORIGINAL, not a later management copy", async () => {
    const byName: Record<string, CrossAppEnvelope> = {
      "mail:composeForApp": { status: "error", error: { code: "send_failed", message: "smtp down" } } as CrossAppEnvelope,
    }
    const issuerEmailOn: IssuerProfileRow = { ...issuerFR, auto_email_enabled: true }
    const { ctx, db, extras } = makeCtx({
      issuerProfiles: [{ profile: issuerEmailOn, shopify_shop_id: "shop-1" }],
      executeToolByName: byName,
    })
    await onShopifyOrderPaid(basePayload(), ctx)
    const park = (db.__all("deferred_events") as Array<Record<string, unknown>>).find(
      (r) => (r.blocked_on as { kind?: string }).kind === "email_send",
    )
    expect(park).toBeTruthy()
    const legal = (db.__all("legal_originals") as Array<Record<string, unknown>>)[0]!
    const doc = (db.__all("documents") as Array<Record<string, unknown>>)[0]!
    // A later mark-paid / edit re-rendered a management copy onto pdf_file_id.
    await db.update("documents", String(doc.id), { pdf_file_id: "management-copy" })
    delete byName["mail:composeForApp"]
    extras.executeToolCalls.length = 0
    const cronCtx = { ...ctx, db, emit: async () => {}, decideApproval: async () => ({ status: "ok" as const }) }
    await deferredRetryJobHandler(undefined, cronCtx, { now: new Date("2030-01-01T00:00:00Z") })
    const sent = extras.executeToolCalls.find((c) => c.name === "mail:composeForApp")
    expect((sent?.args as Record<string, unknown>).attachments).toEqual([legal.file_id])
  })

  // S11: the automatic mail is claimed in the kernel's effect ledger (`ctx.effects`) before it
  // is sent, so a sweep that stopped between the send and the park's `resolved` mark (a deploy,
  // a crash) does not send it again on the next sweep.
  describe("the deferred email retry sends once through ctx.effects", () => {
    async function parkedEmail(ledger: LedgerDouble) {
      const byName: Record<string, CrossAppEnvelope> = {
        "mail:composeForApp": { status: "error", error: { code: "send_failed", message: "smtp down" } } as CrossAppEnvelope,
      }
      const issuerEmailOn: IssuerProfileRow = { ...issuerFR, auto_email_enabled: true }
      const { ctx, db, extras } = makeCtx({
        issuerProfiles: [{ profile: issuerEmailOn, shopify_shop_id: "shop-1" }],
        executeToolByName: byName,
      })
      await onShopifyOrderPaid(basePayload(), ctx)
      const park = (db.__all("deferred_events") as Array<Record<string, unknown>>).find(
        (r) => (r.blocked_on as { kind?: string }).kind === "email_send",
      )!
      expect(park).toBeTruthy()
      delete byName["mail:composeForApp"]
      extras.executeToolCalls.length = 0
      const cronCtx = {
        ...ctx,
        db,
        effects: ledger,
        emit: async () => {},
        decideApproval: async () => ({ status: "ok" as const }),
      }
      const sends = () => extras.executeToolCalls.filter((c) => c.name === "mail:composeForApp").length
      const parkRow = () =>
        (db.__all("deferred_events") as Array<Record<string, unknown>>).find((r) => r.id === park.id)!
      /** The sweep's bookkeeping never committed: the park is open again, as before the sweep. */
      const reopen = () =>
        db.update("deferred_events", String(park.id), {
          status: park.status,
          retry_count: park.retry_count,
          retried_at: park.retried_at ?? null,
        })
      return { db, byName, cronCtx, sends, parkRow, reopen }
    }

    test("a sweep re-run after the send but before the park was marked sends the mail once", async () => {
      const ledger = new LedgerDouble()
      const t = await parkedEmail(ledger)
      await deferredRetryJobHandler(undefined, t.cronCtx, { now: new Date("2030-01-01T00:00:00Z") })
      expect(t.sends()).toBe(1)
      await t.reopen()
      const again = await deferredRetryJobHandler(undefined, t.cronCtx, { now: new Date("2030-01-01T00:10:00Z") })
      expect(t.sends()).toBe(1)
      expect(again.succeeded).toBe(1)
      expect(t.parkRow().status).toBe("resolved")
    })

    test("a send whose sweep died before storing it is unknown: not sent again, the park stays open", async () => {
      const ledger = new LedgerDouble()
      const t = await parkedEmail(ledger)
      ledger.crashBeforeComplete = true
      await deferredRetryJobHandler(undefined, t.cronCtx, { now: new Date("2030-01-01T00:00:00Z") }).catch(() => {})
      expect(t.sends()).toBe(1)
      ledger.crashBeforeComplete = false
      ledger.die()
      await t.reopen()
      const again = await deferredRetryJobHandler(undefined, t.cronCtx, { now: new Date("2030-01-01T00:10:00Z") })
      expect(t.sends()).toBe(1)
      expect(again.succeeded).toBe(0)
      expect(t.parkRow().status).not.toBe("resolved")
      expect(t.parkRow().reason).toBe("email_outcome_unknown")
    })

    test("an unknown mail stays unsent by the sweep even once the ledger forgot the key; a person's send closes the park", async () => {
      const ledger = new LedgerDouble()
      const t = await parkedEmail(ledger)
      ledger.crashBeforeComplete = true
      await deferredRetryJobHandler(undefined, t.cronCtx, { now: new Date("2030-01-01T00:00:00Z") }).catch(() => {})
      ledger.crashBeforeComplete = false
      ledger.die()
      await t.reopen()
      await deferredRetryJobHandler(undefined, t.cronCtx, { now: new Date("2030-01-01T00:10:00Z") })
      expect(t.parkRow().reason).toBe("email_outcome_unknown")
      // The ledger's retention dropped the unknown key: the sweep still never sends it blind.
      ledger.rows.clear()
      await deferredRetryJobHandler(undefined, t.cronCtx, { now: new Date("2030-01-05T00:00:00Z") })
      expect(t.sends()).toBe(1)
      expect(t.parkRow().status).not.toBe("resolved")
      // The person checked the sent folder and sends the document again: it goes, the park closes.
      const documentId = String((t.parkRow().blocked_on as { document_id: string }).document_id)
      const sent = await documentsSendToCustomer(t.cronCtx, { document_id: documentId })
      expect(sent.status).toBe("completed")
      expect(t.sends()).toBe(2)
      expect(t.parkRow().status).toBe("resolved")
      await deferredRetryJobHandler(undefined, t.cronCtx, { now: new Date("2030-01-06T00:00:00Z") })
      expect(t.sends()).toBe(2)
    })

    test("a refused send releases its claim: the next sweep sends it", async () => {
      const ledger = new LedgerDouble()
      const t = await parkedEmail(ledger)
      t.byName["mail:composeForApp"] = { status: "error", error: { code: "send_failed", message: "smtp down" } } as CrossAppEnvelope
      const first = await deferredRetryJobHandler(undefined, t.cronCtx, { now: new Date("2030-01-01T00:00:00Z") })
      expect(first.succeeded).toBe(0)
      expect(t.parkRow().reason).toBe("send_failed")
      expect(ledger.rows.size).toBe(0)
      delete t.byName["mail:composeForApp"]
      const second = await deferredRetryJobHandler(undefined, t.cronCtx, { now: new Date("2030-01-02T00:00:00Z") })
      expect(second.succeeded).toBe(1)
      expect(t.sends()).toBe(2)
      expect(t.parkRow().status).toBe("resolved")
    })
  })

  test("a still-throttled customs fetch stays parked (not falsely resolved)", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
      executeToolByName: {
        "shopify:variants_get": {
          status: "error",
          error: { code: "RATE_LIMIT", message: "still throttled", retryable: true },
        },
      },
    })
    // `db` (full MockDb) overrides ctx.db (typed as the narrower IssueDb) so the
    // augmented ctx satisfies the MutationsCtx surface the dispatch needs.
    const cronCtx = {
      ...ctx,
      db,
      emit: async () => {},
      decideApproval: async () => ({ status: "ok" as const }),
    }
    const base = basePayload({ customer: usBuyer() })
    await db.insert("deferred_events", {
      event_id: base.id,
      event_payload_json: base,
      status: "awaiting_dependency",
      reason: "awaiting_customs_dependency",
      blocked_on: { kind: "customs", code: "RATE_LIMIT" },
      retry_count: 0,
      retried_at: null,
      created_at: "2026-05-15T10:00:00Z",
    })

    const result = await deferredRetryJobHandler(undefined, cronCtx, {
      now: new Date("2026-05-15T10:05:00Z"),
    })

    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(1)
    expect(db.__all("documents")).toHaveLength(0)
    expect((db.__all("deferred_events")[0] as Record<string, unknown>).status).toBe("awaiting_dependency")
  })
})

// ── Split issuance + tax-inclusive pricing (customs separation) ──────────
//
// Modeled on the real Shopify order that exposed the breakage: a French B2C
// order with tax-INCLUSIVE prices (taxes_included: true), a shipping line,
// four physical products, and a Tessera-Sound-style digital license
// (requires_shipping: false). The pre-fix flow (a) added 20% VAT on top of
// the already-VAT-inclusive prices, (b) dropped the shipping line, (c) dropped
// the customer's email + billing address, and (d) mixed the software license
// into the goods invoice (customs then tariffs the combined total).
describe("order split + tax-inclusive pricing", () => {
  const fullEvent = {
    orderId: "order-real-1",
    shopDomain: "shop-1",
    createdAt: "2026-07-03T13:38:00Z",
    totalPrice: { amount: "1336.99", currencyCode: "EUR" },
    taxesIncluded: true,
    billingAddress: {
      name: "Pascal Client",
      address1: "11 Bis route Exemple",
      zip: "78110",
      city: "Le Vesinet",
      country_code: "FR",
    },
    shippingAddress: {
      address1: "11 Bis route Exemple",
      zip: "78110",
      city: "Le Vesinet",
      country_code: "FR",
    },
    customer: {
      id: "cust-real-1",
      email: "pascal@example.com",
      first_name: "Pascal",
      last_name: "Client",
      country: "FR",
    },
    lineItems: [
      { id: "li-1", title: "Black Silicone Skin", quantity: 1, priceSet: { amount: "155.00", currencyCode: "EUR" }, requiresShipping: true, taxLines: [{ rate: 0.2, amount: "25.83" }], variant: { id: "53337545703755" } },
      { id: "li-2", title: "Mounting plate", quantity: 1, priceSet: { amount: "107.00", currencyCode: "EUR" }, requiresShipping: true, taxLines: [{ rate: 0.2, amount: "17.83" }], variant: { id: "50464471744843" } },
      { id: "li-3", title: "USB-C Cable", quantity: 1, priceSet: { amount: "17.00", currencyCode: "EUR" }, requiresShipping: true, taxLines: [{ rate: 0.2, amount: "2.83" }], variant: { id: "50778599915851" } },
      { id: "li-4", title: "Tessera Sound", quantity: 1, priceSet: { amount: "79.00", currencyCode: "EUR" }, requiresShipping: false, taxLines: [{ rate: 0.2, amount: "13.17" }], variant: { id: "57467363623243" } },
      { id: "li-5", title: "Tessera 2", quantity: 1, priceSet: { amount: "949.00", currencyCode: "EUR" }, requiresShipping: true, taxLines: [{ rate: 0.2, amount: "158.17" }], variant: { id: "47748313416011" } },
    ],
    shippingLines: [
      { title: "DHL Express", priceSet: { amount: "29.99", currencyCode: "EUR" }, taxLines: [{ rate: 0.2, amount: "5.00" }] },
    ],
  }

  test("adapter de-taxes gross prices, classifies digital lines, appends the shipping line, formats the billing address", () => {
    const payload = adaptShopifyOrderCreatedEvent(fullEvent)
    expect(payload.customer?.email).toBe("pascal@example.com")
    expect(payload.customer?.address).toBe("11 Bis route Exemple\n78110 Le Vesinet")
    expect(payload.customer?.country).toBe("FR")

    // 5 product lines + 1 shipping line, all NET of the included 20% VAT.
    expect(payload.line_items).toHaveLength(6)
    const byDesc = Object.fromEntries(payload.line_items.map((l) => [l.description, l]))
    expect(String(byDesc["Tessera 2"]!.unit_price_minor)).toBe("79083") // 949.00 / 1.2
    expect(String(byDesc["Black Silicone Skin"]!.unit_price_minor)).toBe("12917")
    expect(String(byDesc["Mounting plate"]!.unit_price_minor)).toBe("8917")
    expect(String(byDesc["USB-C Cable"]!.unit_price_minor)).toBe("1417")
    expect(String(byDesc["Tessera Sound"]!.unit_price_minor)).toBe("6583")
    expect(String(byDesc["Shipping (DHL Express)"]!.unit_price_minor)).toBe("2499")
    // Shopify's charged rate rides along as the per-line override.
    for (const l of payload.line_items) expect(l.tax_rate_bp).toBe(2000)
    // The digital license is software; carriage is shipping; the rest goods.
    expect(byDesc["Tessera Sound"]!.line_kind).toBe("software")
    expect(byDesc["Shipping (DHL Express)"]!.line_kind).toBe("shipping")
    expect(byDesc["Tessera 2"]!.line_kind).toBe("goods")
  })

  test("mixed order → TWO invoices: goods (physical merchandise ONLY) and services (software + shipping); totals reproduce the Shopify payment", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    const result = await onShopifyOrderCreated(fullEvent, ctx)
    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("unreachable")
    expect(result.documents).toHaveLength(2)

    const docs = db.__all("documents") as Array<Record<string, unknown>>
    expect(docs).toHaveLength(2)
    const goods = docs.find((d) => d.scope === "goods")!
    const software = docs.find((d) => d.scope === "software")!
    expect(goods).toBeDefined()
    expect(software).toBeDefined()

    // Goods invoice: ONLY the 4 physical merchandise lines — no carriage, no
    // software. Net 1023.34, VAT 204.66, total 1228.00. This is the customs
    // value of the shipment, nothing else.
    expect(String(goods.subtotal_minor)).toBe("102334")
    expect(String(goods.tax_total_minor)).toBe("20466")
    expect(String(goods.grand_total_minor)).toBe("122800")

    // Services invoice: the software license + the shipping charge. Net 90.82,
    // VAT 18.17, total 108.99 — on its own document customs never sees.
    expect(String(software.subtotal_minor)).toBe("9082")
    expect(String(software.tax_total_minor)).toBe("1817")
    expect(String(software.grand_total_minor)).toBe("10899")

    // The two documents together reproduce the Shopify payment to the cent.
    const combined = BigInt(String(goods.grand_total_minor)) + BigInt(String(software.grand_total_minor))
    expect(combined).toBe(133699n) // 1336.99 EUR

    // Counterparty snapshot complete on BOTH documents.
    for (const d of [goods, software]) {
      expect(d.counterparty_email).toBe("pascal@example.com")
      expect(d.counterparty_address).toBe("11 Bis route Exemple\n78110 Le Vesinet")
      expect(d.counterparty_country).toBe("FR")
    }

    // Line kinds persisted; the goods document carries ONLY merchandise lines,
    // the services document carries the software license AND the carriage.
    const lines = db.__all("document_lines") as Array<Record<string, unknown>>
    expect(lines).toHaveLength(6)
    const softwareLines = lines.filter((l) => l.document_id === software.id)
    expect(softwareLines).toHaveLength(2)
    expect(softwareLines.map((l) => l.line_kind).sort()).toEqual(["shipping", "software"])
    const goodsLines = lines.filter((l) => l.document_id === goods.id)
    expect(goodsLines).toHaveLength(4)
    expect(goodsLines.every((l) => l.line_kind === "goods")).toBe(true)
    // Two sequential invoice numbers were allocated.
    expect(new Set(docs.map((d) => d.number)).size).toBe(2)
  })

  // red: drop the po_number merge from buildIssueInput's shared external_refs closure ->
  // ASSERT (never assume) that the split-order case carries the PO number to BOTH halves,
  // since they are produced by the same handler but from two separate document rows.
  test("a PO number on the order reaches BOTH split halves (goods AND software)", async () => {
    const withPo = { ...fullEvent, orderId: "order-po-split", poNumber: "PO-4471" }
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    const result = await onShopifyOrderCreated(withPo, ctx)
    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("unreachable")
    expect(result.documents).toHaveLength(2)
    const docs = db.__all("documents") as Array<Record<string, unknown>>
    const goods = docs.find((d) => d.scope === "goods")!
    const software = docs.find((d) => d.scope === "software")!
    expect(goods.po_number).toBe("PO-4471")
    expect(software.po_number).toBe("PO-4471")
    const goodsLog = goods.lifecycle_log as Array<Record<string, unknown>>
    const softwareLog = software.lifecycle_log as Array<Record<string, unknown>>
    for (const log of [goodsLog, softwareLog]) {
      const change = log.find((e) => e.event === "po_number_changed")
      expect(change?.to).toBe("PO-4471")
      expect(change?.source).toBe("shopify_sync")
    }
  })

  test("software-only order → a single software-scope invoice", async () => {
    const softwareOnly = {
      ...fullEvent,
      orderId: "order-sw-only",
      totalPrice: { amount: "79.00", currencyCode: "EUR" },
      lineItems: [fullEvent.lineItems[3]!],
      shippingLines: [],
    }
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    const result = await onShopifyOrderCreated(softwareOnly, ctx)
    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("unreachable")
    expect(result.documents).toHaveLength(1)
    expect(result.documents[0]!.scope).toBe("software")
    const docs = db.__all("documents") as Array<Record<string, unknown>>
    expect(docs).toHaveLength(1)
    expect(String(docs[0]!.grand_total_minor)).toBe("7900")
  })

  test("retry after a partial issuance only issues the missing scope", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    // First pass issues both.
    const first = await onShopifyOrderCreated(fullEvent, ctx)
    expect(first.status).toBe("ok")
    // Simulate a partial state: drop the software document, keep goods.
    const docs = db.__all("documents") as Array<Record<string, unknown>>
    const software = docs.find((d) => d.scope === "software")!
    await db.delete("documents", String(software.id))
    // Re-delivery issues ONLY the software scope — no duplicate goods invoice.
    const second = await onShopifyOrderCreated(fullEvent, ctx)
    expect(second.status).toBe("ok")
    if (second.status !== "ok") throw new Error("unreachable")
    expect(second.documents).toHaveLength(1)
    expect(second.documents[0]!.scope).toBe("software")
    expect((db.__all("documents") as Array<Record<string, unknown>>).filter((d) => d.scope === "goods")).toHaveLength(1)
  })

  test("a deferred split half is still issued after the other half is credit noted", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    // First pass issues both the goods and the software invoice.
    const first = await onShopifyOrderCreated(fullEvent, ctx)
    expect(first.status).toBe("ok")
    const docsAfterFirst = db.__all("documents") as Array<Record<string, unknown>>
    const goods = docsAfterFirst.find((d) => d.scope === "goods")!
    const software = docsAfterFirst.find((d) => d.scope === "software")!
    expect(goods).toBeDefined()
    expect(software).toBeDefined()
    // Simulate the software half never having gone through (deferred on a
    // customs throttle, as in "retry after a partial issuance"): drop it.
    await db.delete("documents", String(software.id))
    // Credit note the GOODS invoice in full -- the real-world trigger for the
    // regression: the physical half gets reversed while the digital half is
    // still outstanding. Mirror each of the goods invoice's OWN lines negated,
    // each keeping its own tax rate -- the same full-mirror shape the real
    // auto credit-note paths use (shopify-refund-created.ts, orderReissueApply)
    // -- rather than one combined line: combining every net amount into a
    // single line before re-deriving tax rounds differently than the sum of
    // the original per-line taxes, which would overshoot the invoice's own
    // total by a cent and trip the over-credit guard on an artifact of the
    // test's own construction, not a real over-credit.
    const goodsLines = (db.__all("document_lines") as Array<Record<string, unknown>>).filter(
      (l) => l.document_id === goods.id,
    )
    // creditNoteCreateAndIssue's kernel audit trail calls ctx.emit unconditionally
    // (the real kernel-injected ctx always carries it); makeCtx's OrderPaidCtx
    // does not declare emit, so augment it here the same way the cron ctx does above.
    const cn = await creditNoteCreateAndIssue(
      {
        ...ctx,
        // No invoice threshold is set, and credit notes then always park an approval: run as the
        // post-approval re-entry.
        approval: { approvalRequestId: "appr-1", approvalDeciderId: "u-2", toolName: "invoicing:test" },
        emit: async () => {},
      } as unknown as MutationsCtx,
      {
        counterparty: {
          contact_id: (goods.counterparty_contact_id as string | null) ?? null,
          legal_name: String(goods.counterparty_name ?? ""),
          country: String(goods.counterparty_country ?? ""),
          vat_id: (goods.counterparty_vat_id as string | null) ?? null,
          address: (goods.counterparty_address as string | null) ?? null,
          email: (goods.counterparty_email as string | null) ?? null,
          // A French consumer checkout: the manual credit note states the kind explicitly.
          customer_kind: "individual",
        },
        issuer_profile_id: String(goods.issuer_profile_id),
        currency: String(goods.currency),
        original_document_id: String(goods.id),
        items: goodsLines.map((l, i) => ({
          position: i + 1,
          description: String(l.description ?? "Full reversal"),
          quantity: String(l.quantity ?? "1"),
          unit_price_minor: -BigInt(String(l.unit_price_minor)),
          tax_rate_bp_override: Number(l.tax_rate_bp ?? 0),
          product_source: null,
          external_id: null,
        })),
      },
    )
    expect(cn.status).toBe("completed")

    // The retry of orders/paid (Shopify re-delivers the same webhook) must still
    // issue the still-missing software invoice. BEFORE the fix, the credit note
    // (issued with scope: null, inheriting the goods invoice's shopify_order_id)
    // satisfied the private `existingDocs.some(d => d.scope === null)` check, so
    // the retry returned { status: "skipped", reason: "duplicate_document" } and
    // the software invoice was never issued -- a real regression (this used to
    // work before credit notes inherited the order id).
    const retry = await onShopifyOrderCreated(fullEvent, ctx)
    expect(retry.status).toBe("ok")
    if (retry.status !== "ok") throw new Error("unreachable")
    expect(retry.documents).toHaveLength(1)
    expect(retry.documents[0]!.scope).toBe("software")

    const finalDocs = db.__all("documents") as Array<Record<string, unknown>>
    expect(finalDocs.filter((d) => d.scope === "software")).toHaveLength(1)
    expect(finalDocs.filter((d) => d.scope === "goods")).toHaveLength(1)
    expect(finalDocs.filter((d) => d.type === "credit_note")).toHaveLength(1)
  })

  test("fully-invoiced order re-delivery → skipped duplicate_document", async () => {
    const { ctx } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    const first = await onShopifyOrderCreated(fullEvent, ctx)
    expect(first.status).toBe("ok")
    const second = await onShopifyOrderCreated(fullEvent, ctx)
    expect(second.status).toBe("skipped")
    if (second.status !== "skipped") throw new Error("unreachable")
    expect(second.reason).toBe("duplicate_document")
  })

  test("taxes NOT included (US-style) → prices pass through, Shopify's rate still overrides", () => {
    const payload = adaptShopifyOrderCreatedEvent({
      ...fullEvent,
      taxesIncluded: false,
      lineItems: [
        { id: "li-1", title: "Widget", quantity: 2, priceSet: { amount: "100.00", currencyCode: "EUR" }, requiresShipping: true, taxLines: [{ rate: 0.0875, amount: "17.50" }], variant: { id: "1" } },
      ],
    })
    expect(String(payload.line_items[0]!.unit_price_minor)).toBe("10000")
    expect(payload.line_items[0]!.tax_rate_bp).toBe(875)
  })

  test("legacy event shape (no tax facts) → pre-fix passthrough, classifier default applies", () => {
    const payload = adaptShopifyOrderCreatedEvent({
      orderId: "order-legacy",
      shopDomain: "shop-1",
      totalPrice: { amount: "120.00", currencyCode: "EUR" },
      customer: { id: "c1", email: "x@example.com" },
      lineItems: [{ id: "li-1", title: "Widget", quantity: 1, priceSet: { amount: "100.00", currencyCode: "EUR" }, variant: { id: "1" } }],
    })
    expect(String(payload.line_items[0]!.unit_price_minor)).toBe("10000")
    expect(payload.line_items[0]!.tax_rate_bp).toBeUndefined()
    expect(payload.line_items[0]!.line_kind).toBe("goods")
  })

  describe("order:updated catch-up for a paid order that never got its invoice", () => {
    test("a PAID order with no billing document is invoiced on its next order:updated", async () => {
      const { ctx, db } = makeCtx({
        issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
      })
      const updatedCtx = { ...ctx, emit: async () => {} }
      const updated = { ...fullEvent, financialStatus: "paid" }
      const result = await onShopifyOrderUpdated(updated, updatedCtx)
      expect(result.status).toBe("ok")
      const docs = db.__all("documents") as Array<Record<string, unknown>>
      expect(docs.length).toBeGreaterThan(0)
      expect(docs.every((d) => d.shopify_order_id === "order-real-1")).toBe(true)
      // Idempotent: a second update after the catch-up issues nothing more.
      const again = await onShopifyOrderUpdated(updated, updatedCtx)
      expect(again.status).toBe("ok")
      expect((db.__all("documents") as unknown[]).length).toBe(docs.length)
    })

    test("an UNPAID order with no billing document is left alone", async () => {
      const { ctx, db } = makeCtx({
        issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
      })
      const result = await onShopifyOrderUpdated(
        { ...fullEvent, financialStatus: "pending" },
        { ...ctx, emit: async () => {} },
      )
      expect(result).toEqual({ status: "skipped", reason: "not_paid" })
      expect(db.__all("documents")).toHaveLength(0)
    })

    test("an order already parked in deferred_events is left to the deferred-retry cron", async () => {
      const { ctx, db } = makeCtx({
        issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
      })
      db.__seed("deferred_events", [
        {
          event_id: "order-real-1",
          event_payload_json: {},
          status: "awaiting_data",
          reason: "awaiting_customer_data",
          blocked_on: {},
          retry_count: 0,
          retried_at: null,
        },
      ])
      const result = await onShopifyOrderUpdated(
        { ...fullEvent, financialStatus: "paid" },
        { ...ctx, emit: async () => {} },
      )
      expect(result).toEqual({ status: "skipped", reason: "already_parked" })
      expect(db.__all("documents")).toHaveLength(0)
      expect(db.__all("deferred_events")).toHaveLength(1)
    })
  })
})

// document_lines.unit_price_minor must always be stored NET of tax. This flow nets
// independently of the mutations.ts write paths, keyed off the ORDER's own taxesIncluded
// flag rather than the issuer's prices_include_tax, then feeds issueDocument already netted.
// Pins the stored document_lines row (not the intermediate adapter payload) at a rate (FR
// domestic 20%, 2000 bp) where net and gross visibly differ: 100.00 typed/gross -> 8333
// stored, never 10000. Both flag states are covered because a flipped taxesIncluded would
// silently store gross under inclusive pricing, or wrongly divide an already-net US price.
describe("order paid auto flow stores document_lines NET of tax (own taxesIncluded flag)", () => {
  const singleItemEvent = {
    orderId: "order-net-pin-1",
    shopDomain: "shop-1",
    createdAt: "2026-07-03T13:38:00Z",
    totalPrice: { amount: "100.00", currencyCode: "EUR" },
    customer: { id: "cust-net-1", email: "net@example.com", first_name: "Net", last_name: "Payer", country: "FR" },
    billingAddress: {
      address1: "1 rue Net",
      zip: "75001",
      city: "Paris",
      country_code: "FR",
    },
    lineItems: [
      {
        id: "li-net-1",
        title: "Widget",
        quantity: 1,
        priceSet: { amount: "100.00", currencyCode: "EUR" },
        requiresShipping: true,
        taxLines: [{ rate: 0.2, amount: "16.67" }],
        variant: { id: "1" },
      },
    ],
    shippingLines: [],
  }

  test("taxesIncluded true nets 100.00 gross down to 8333 in the stored document_lines row", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    const result = await onShopifyOrderCreated({ ...singleItemEvent, taxesIncluded: true }, ctx)
    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("unreachable")
    const lines = db.__all("document_lines") as Array<Record<string, unknown>>
    expect(lines).toHaveLength(1)
    expect(String(lines[0]!.unit_price_minor)).toBe("8333")
  })

  test("taxesIncluded false stores the typed 100.00 price unchanged at 10000", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    // Tax exclusive: Shopify charges 20% ON TOP of 100.00, so it reports 20.00 (the 16.67 above is
    // the tax INCLUDED in a 100.00 gross price, only true when taxesIncluded is set).
    const result = await onShopifyOrderCreated(
      {
        ...singleItemEvent,
        taxesIncluded: false,
        lineItems: singleItemEvent.lineItems.map((li) => ({
          ...li,
          taxLines: [{ rate: 0.2, amount: "20.00" }],
        })),
      },
      ctx,
    )
    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("unreachable")
    const lines = db.__all("document_lines") as Array<Record<string, unknown>>
    expect(lines).toHaveLength(1)
    expect(String(lines[0]!.unit_price_minor)).toBe("10000")
  })
})

// A software-only EXPORT (US customer buying just the license): digital lines
// are not customs goods, so issuance must NOT demand HS codes or hit the live
// variants_get fetch — pre-fix this parked every such order on a customs
// dependency (or issued with bogus customs from the product overlay).
describe("software lines are never customs goods", () => {
  test("software-only export order issues with no customs fetch and blank customs fields", async () => {
    const { ctx, db, extras } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
      executeToolByName: {
        "shopify:variants_get": {
          status: "error",
          error: { code: "RATE_LIMIT", message: "would-throttle", retryable: true },
        },
      },
    })
    const result = await onShopifyOrderCreated(
      {
        orderId: "order-sw-export",
        shopDomain: "shop-1",
        totalPrice: { amount: "79.00", currencyCode: "EUR" },
        taxesIncluded: false,
        customer: { id: "c-us", email: "us@example.com", first_name: "Sam", last_name: "Buyer", country: "US" },
        billingAddress: { address1: "1 Main St", zip: "10001", city: "New York", country_code: "US" },
        lineItems: [
          { id: "li-sw", title: "Tessera Sound", quantity: 1, priceSet: { amount: "79.00", currencyCode: "EUR" }, requiresShipping: false, taxLines: [], variant: { id: "57467363623243" } },
        ],
      },
      ctx,
    )
    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("unreachable")
    expect(result.documents[0]!.scope).toBe("software")
    // No live customs fetch was attempted for the digital line.
    expect(extras.executeToolCalls.filter((c) => c.name === "shopify:variants_get")).toHaveLength(0)
    const lines = db.__all("document_lines") as Array<Record<string, unknown>>
    expect(lines).toHaveLength(1)
    expect(lines[0]!.hs_code).toBeNull()
    expect(lines[0]!.line_kind).toBe("software")
    // Export classification (0% VAT) still applies to the money.
    const docs = db.__all("documents") as Array<Record<string, unknown>>
    expect(String(docs[0]!.tax_total_minor)).toBe("0")
  })
})

// Physical-only order WITH carriage: the goods invoice must still contain ONLY
// merchandise — the shipping charge is a service and moves to its own document.
describe("shipping never rides on the goods invoice", () => {
  test("hardware-only order with shipping → goods invoice (merchandise) + services invoice (carriage)", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    const result = await onShopifyOrderCreated(
      {
        orderId: "order-hw-ship",
        shopDomain: "shop-1",
        totalPrice: { amount: "978.99", currencyCode: "EUR" },
        taxesIncluded: true,
        customer: { id: "c-hw", email: "hw@example.com", first_name: "Ha", last_name: "Buyer", country: "FR" },
        billingAddress: { address1: "2 rue Test", zip: "75001", city: "Paris", country_code: "FR" },
        lineItems: [
          { id: "li-hw", title: "Tessera 2", quantity: 1, priceSet: { amount: "949.00", currencyCode: "EUR" }, requiresShipping: true, taxLines: [{ rate: 0.2, amount: "158.17" }], variant: { id: "47748313416011" } },
        ],
        shippingLines: [
          { title: "Colissimo", priceSet: { amount: "29.99", currencyCode: "EUR" }, taxLines: [{ rate: 0.2, amount: "5.00" }] },
        ],
      },
      ctx,
    )
    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("unreachable")
    expect(result.documents).toHaveLength(2)
    const docs = db.__all("documents") as Array<Record<string, unknown>>
    const goods = docs.find((d) => d.scope === "goods")!
    const services = docs.find((d) => d.scope === "software")!
    expect(String(goods.grand_total_minor)).toBe("94900") // merchandise only
    expect(String(services.grand_total_minor)).toBe("2999") // carriage only
    const serviceLines = (db.__all("document_lines") as Array<Record<string, unknown>>).filter(
      (l) => l.document_id === services.id,
    )
    expect(serviceLines).toHaveLength(1)
    expect(serviceLines[0]!.line_kind).toBe("shipping")
  })
})

// Discounts must be VISIBLE on the invoice — kept as an explicit per-line
// reduction, never folded into the unit price.
describe("explicit line discounts", () => {
  test("tax-inclusive order with a 50% line discount → full unit price + explicit discount, payment reproduced", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    const result = await onShopifyOrderCreated(
      {
        orderId: "order-discount",
        shopDomain: "shop-1",
        totalPrice: { amount: "344.50", currencyCode: "EUR" },
        taxesIncluded: true,
        customer: { id: "c-d", email: "d@example.com", first_name: "Deal", last_name: "Buyer", country: "FR" },
        billingAddress: { address1: "3 rue Promo", zip: "75002", city: "Paris", country_code: "FR" },
        lineItems: [
          {
            id: "li-d",
            title: "Tessera 2 (B-stock)",
            quantity: 1,
            priceSet: { amount: "689.00", currencyCode: "EUR" },
            requiresShipping: true,
            taxLines: [{ rate: 0.2, amount: "57.42" }],
            discountAllocations: [{ amount: "344.50", currencyCode: "EUR" }],
            variant: { id: "999001" },
          },
        ],
      },
      ctx,
    )
    expect(result.status).toBe("ok")
    const lines = db.__all("document_lines") as Array<Record<string, unknown>>
    expect(lines).toHaveLength(1)
    const l = lines[0]!
    // Full net shelf price stays on the line; the reduction is explicit.
    expect(String(l.unit_price_minor)).toBe("57417") // 689.00 / 1.2
    expect(String(l.discount_minor)).toBe("28709") // 344.50 gross discount, net
    expect(String(l.subtotal_minor)).toBe("28708") // 344.50 / 1.2
    // Line total reproduces the discounted gross the customer paid.
    expect(String(l.total_minor)).toBe("34450")
    const docs = db.__all("documents") as Array<Record<string, unknown>>
    expect(String(docs[0]!.grand_total_minor)).toBe("34450")
  })
})

describe("per-shipment proformas vs webhook idempotency (shipment_ref)", () => {
  test("existing per-shipment proformas (shipment_ref set) do NOT satisfy the duplicate check: the legal invoice still issues", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    // A batch proforma issued for this order BEFORE the paid webhook arrives.
    // scope null + shipment_ref set: the historical scope-null legacy check must
    // not mistake it for "order fully invoiced".
    db.__seed("documents", [
      {
        id: "00000000-0000-4000-8000-00000000ship",
        type: "proforma",
        status: "issued",
        scope: null,
        shipment_ref: "batch-1",
        shopify_order_id: "shopify-order-1",
        external_refs: { shopify_order_id: "shopify-order-1" },
      },
    ])
    const result = await onShopifyOrderPaid(basePayload(), ctx)
    expect(result.status).toBe("ok")
    // The invoice issued alongside the pre-existing batch proforma.
    const docs = db.__all("documents").filter((d) => d.shopify_order_id === "shopify-order-1")
    expect(docs).toHaveLength(2)
  })

  test("a NULL-shipment_ref legacy document still short-circuits the webhook exactly as today", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    db.__seed("documents", [
      {
        id: "00000000-0000-4000-8000-0000000legcy",
        type: "invoice",
        status: "issued",
        scope: null,
        shopify_order_id: "shopify-order-1",
        external_refs: { shopify_order_id: "shopify-order-1" },
      },
    ])
    const result = await onShopifyOrderPaid(basePayload(), ctx)
    expect(result.status).toBe("skipped")
    if (result.status !== "skipped") throw new Error("unreachable")
    expect(result.reason).toBe("duplicate_document")
    expect(db.__all("documents")).toHaveLength(1)
  })
})

describe("fully credit noted scope-null document does not suppress a webhook reissue", () => {
  test("a fully credit noted invoice does not suppress a webhook reissue", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    // Pre-split legacy invoice for the order, fully reversed by a credit note. basePayload's
    // single 100.00 line taxes at FR domestic 20% -> grand_total_minor 12000 matches
    // total_price_minor, so a full credit note is exactly -12000.
    db.__seed("documents", [
      {
        id: "00000000-0000-4000-8000-000000invorg",
        type: "invoice",
        status: "issued",
        scope: null,
        shopify_order_id: "shopify-order-1",
        external_refs: { shopify_order_id: "shopify-order-1" },
        grand_total_minor: "12000",
        lifecycle_log: [],
      },
      {
        id: "00000000-0000-4000-8000-0000000cnote",
        type: "credit_note",
        status: "issued",
        scope: null,
        shopify_order_id: "shopify-order-1",
        external_refs: { original_document_id: "00000000-0000-4000-8000-000000invorg" },
        grand_total_minor: "-12000",
        lifecycle_log: [],
      },
    ])
    const result = await onShopifyOrderPaid(basePayload(), ctx)
    // Before the fix: { status: "skipped", reason: "duplicate_document" }.
    // After the fix: a NEW invoice issues alongside the fully-credited original.
    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("unreachable")
    expect(result.document_id).not.toBe("00000000-0000-4000-8000-000000invorg")
    const docs = db.__all("documents").filter((d) => d.shopify_order_id === "shopify-order-1")
    expect(docs).toHaveLength(3)
    const created = docs.find((d) => d.id === result.document_id)
    expect(created).toBeDefined()
    expect(created?.type).toBe("invoice")
  })

  test("a NOT fully credited invoice still suppresses a webhook reissue", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    // Same shape, but the credit note only reverses half the invoice -- the original still
    // stands, so idempotency must survive exactly as before.
    db.__seed("documents", [
      {
        id: "00000000-0000-4000-8000-000000invorg",
        type: "invoice",
        status: "issued",
        scope: null,
        shopify_order_id: "shopify-order-1",
        external_refs: { shopify_order_id: "shopify-order-1" },
        grand_total_minor: "12000",
        lifecycle_log: [],
      },
      {
        id: "00000000-0000-4000-8000-0000000cnote",
        type: "credit_note",
        status: "issued",
        scope: null,
        shopify_order_id: "shopify-order-1",
        external_refs: { original_document_id: "00000000-0000-4000-8000-000000invorg" },
        grand_total_minor: "-6000",
        lifecycle_log: [],
      },
    ])
    const result = await onShopifyOrderPaid(basePayload(), ctx)
    expect(result.status).toBe("skipped")
    if (result.status !== "skipped") throw new Error("unreachable")
    expect(result.reason).toBe("duplicate_document")
    expect(db.__all("documents")).toHaveLength(2)
  })
})


// ── Parks: idempotency, cancelled orders, order number ─────────────────
describe("order parks (customer email missing)", () => {
  const noEmail = () =>
    basePayload({ id: "12966079070539", customer: { ...basePayload().customer!, email: null } })

  test("a redelivered order that is still blocked keeps ONE open park", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    const a = await onShopifyOrderPaid(noEmail(), ctx)
    const b = await onShopifyOrderPaid(noEmail(), ctx)
    const c = await onShopifyOrderPaid(noEmail(), ctx)
    expect(a.status).toBe("deferred")
    expect(db.__all("deferred_events")).toHaveLength(1)
    expect((b as { deferred_id: string }).deferred_id).toBe((a as { deferred_id: string }).deferred_id)
    expect((c as { deferred_id: string }).deferred_id).toBe((a as { deferred_id: string }).deferred_id)
  })

  test("the retry sweep re-driving a still-blocked park does not spawn a new row", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    const cronCtx = {
      ...ctx,
      db,
      emit: async () => {},
      decideApproval: async () => ({ status: "ok" as const }),
    }
    await onShopifyOrderPaid(noEmail(), ctx)
    await deferredRetryJobHandler(undefined, cronCtx, { now: new Date("2030-01-01T00:00:00Z") })
    await deferredRetryJobHandler(undefined, cronCtx, { now: new Date("2030-01-02T00:00:00Z") })
    const rows = db.__all("deferred_events") as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.retry_count).toBe(2)
  })

  test("the park stores the order number from the enrichment when the event carried none", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
      executeToolByName: {
        "shopify:orders_get": { status: "completed", result: { name: "#3280", customer: null } },
      },
    })
    await onShopifyOrderPaid(noEmail(), ctx)
    const row = db.__all("deferred_events")[0] as Record<string, unknown>
    expect((row.event_payload_json as Record<string, unknown>).order_number).toBe("#3280")
  })

  test("a cancelled order is not parked, and its existing parks are resolved", async () => {
    const cancelledOrder: CrossAppEnvelope = {
      status: "completed",
      result: {
        name: "#3280",
        customer: { email: null },
        financialStatus: "VOIDED",
        attributes: { cancelledAt: "2026-07-11T12:03:30Z", financialStatus: "VOIDED" },
      },
    }
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
      executeToolByName: { "shopify:orders_get": cancelledOrder },
    })
    await db.insert("deferred_events", {
      event_id: "12966079070539",
      event_payload_json: noEmail(),
      status: "awaiting_data",
      reason: "customer_email_missing",
      blocked_on: { kind: "customer_email", customer_id: "shopify-customer-1" },
      retry_count: 0,
      retried_at: null,
    })
    const result = await onShopifyOrderPaid(noEmail(), ctx)
    expect(result).toEqual({ status: "skipped", reason: "order_cancelled" })
    const rows = db.__all("deferred_events") as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: "resolved", reason: "order_cancelled" })
    expect((rows[0]!.event_payload_json as Record<string, unknown>).order_number).toBe("#3280")
    expect(db.__all("documents")).toHaveLength(0)
  })

  test("a voided order with no cancelledAt is not parked either", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
      executeToolByName: {
        "shopify:orders_get": {
          status: "completed",
          result: { customer: null, financialStatus: "VOIDED" },
        },
      },
    })
    const result = await onShopifyOrderPaid(noEmail(), ctx)
    expect(result).toEqual({ status: "skipped", reason: "order_cancelled" })
    expect(db.__all("deferred_events")).toHaveLength(0)
  })

  test("the retry sweep heals a backlog: duplicates collapse, the cancelled order resolves", async () => {
    const cancelledOrder: CrossAppEnvelope = {
      status: "completed",
      result: { name: "#3280", customer: { email: null }, attributes: { cancelledAt: "2026-07-11T12:03:30Z" } },
    }
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
      executeToolByName: { "shopify:orders_get": cancelledOrder },
    })
    const cronCtx = {
      ...ctx,
      db,
      emit: async () => {},
      decideApproval: async () => ({ status: "ok" as const }),
    }
    for (let i = 0; i < 12; i++) {
      await db.insert("deferred_events", {
        event_id: "12966079070539",
        event_payload_json: noEmail(),
        status: "awaiting_data",
        reason: "customer_email_missing",
        blocked_on: { kind: "customer_email", customer_id: "shopify-customer-1" },
        retry_count: 0,
        retried_at: null,
        created_at: "2026-07-11T13:55:09Z",
      })
    }
    const result = await deferredRetryJobHandler(undefined, cronCtx, {
      now: new Date("2026-09-30T12:00:00Z"),
    })
    expect(result.collapsed).toBe(11)
    const rows = db.__all("deferred_events") as Array<Record<string, unknown>>
    expect(rows).toHaveLength(12)
    expect(rows.every((r) => r.status === "resolved")).toBe(true)
    expect(rows.filter((r) => r.reason === "duplicate_park")).toHaveLength(11)
    expect(rows.filter((r) => r.reason === "order_cancelled")).toHaveLength(1)
    // Only the survivor was re-driven: one orders_get for the whole backlog.
    expect(db.__all("documents")).toHaveLength(0)
  })
})

// Audit of order #3386 (Shop channel, billed in Italy, delivered to California): the documents must
// carry only the seller's own tax, as Shopify reported it, and print the billing country under the
// billing address while classifying on the delivery country.
describe("tax read from Shopify, not replayed", () => {
  const order3386 = (overrides: Record<string, unknown> = {}) => ({
    orderId: "13104256549195",
    name: "#3386",
    shopDomain: "shop-1",
    createdAt: "2026-08-20T10:00:00Z",
    financialStatus: "paid",
    totalPrice: { amount: "1047.18", currencyCode: "USD" },
    taxesIncluded: false,
    billingAddress: {
      name: "Luca Ciatto",
      address1: "Via Comune 1",
      zip: "95047",
      city: "Paterno",
      province: "Catania",
      country_code: "IT",
    },
    shippingAddress: {
      name: "Luca Ciatto",
      address1: "309 Shasta Way",
      zip: "96067",
      city: "Mount Shasta",
      province: "CA",
      country_code: "US",
    },
    customer: { id: "c-3386", email: "buyer3386@example.com", first_name: "Luca", last_name: "Ciatto", country: "US" },
    lineItems: [
      {
        id: "li-tessera",
        title: "Tessera 2",
        quantity: 1,
        priceSet: { amount: "899.00", currencyCode: "USD" },
        requiresShipping: true,
        // Marketplace facilitator tax: the Shop channel collects and remits it.
        taxLines: [{ title: "CA State Tax", rate: 0.0725, amount: "65.18", channelLiable: true }],
        variant: { id: "777" },
      },
    ],
    shippingLines: [
      {
        title: "Standard",
        priceSet: { amount: "83.00", currencyCode: "USD" },
        // Exempt in California: the jurisdiction rate is reported, the amount is zero.
        taxLines: [{ title: "CA State Tax", rate: 0.0725, amount: "0.00", channelLiable: true }],
      },
    ],
    ...overrides,
  })
  const overlay = [
    {
      source: "shopify",
      external_id: "gid://shopify/ProductVariant/777",
      hs_code: "854370",
      country_of_origin: "FR",
      customs_description: "Audio recorder",
    },
  ]

  // red: revert shopifyLineTaxFacts to summing every tax line's rate -> the shipping line reads
  // 725 bp (the 6.02 phantom tax on 83.00).
  test("a tax line reported with a rate but a zero amount contributes a zero rate", () => {
    const payload = adaptShopifyOrderCreatedEvent(
      order3386({
        lineItems: [],
        shippingLines: [
          {
            title: "Standard",
            priceSet: { amount: "83.00", currencyCode: "USD" },
            taxLines: [{ title: "CA State Tax", rate: 0.0725, amount: "0.00" }],
          },
        ],
      }),
    )
    const ship = payload.line_items.find((l) => l.line_kind === "shipping")!
    expect(ship.tax_rate_bp).toBe(0)
    expect(ship.shopify_tax_minor).toBe("0")
  })

  // red: drop the channelLiable exclusion -> the goods line carries 725 bp of marketplace tax and
  // the export invoice is parked (or, before the guard, printed 65.18 next to Article 146).
  test("order 3386 replay: goods 899.00 and shipping 83.00, no tax on either, billed IT, classified on US", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
      overlay,
    })
    const result = await onShopifyOrderCreated(order3386(), ctx)
    expect(result.status).toBe("ok")
    const docs = db.__all("documents") as Array<Record<string, unknown>>
    const goods = docs.find((d) => d.scope === "goods")!
    const services = docs.find((d) => d.scope === "software")!
    expect(String(goods.grand_total_minor)).toBe("89900")
    expect(String(goods.tax_total_minor)).toBe("0")
    expect(String(services.grand_total_minor)).toBe("8300")
    expect(String(services.tax_total_minor)).toBe("0")
    // Sum of what is invoiced = 982.00, the revenue the payout reconciles with.
    expect(goods.tax_treatment).toBe("eu_export_non_eu")
    // Printed under the Italian billing address: IT, never US.
    expect(goods.counterparty_country).toBe("IT")
    expect(String(goods.counterparty_address)).toContain("Via Comune 1")
    const refs = goods.external_refs as Record<string, unknown>
    expect(refs.tax_country).toBe("US")
    expect(refs.marketplace_tax_minor).toBe("6518")
    expect(String(goods.counterparty_shipping_address)).toContain("309 Shasta Way")
  })

  // red: delete the shopifyTaxMismatches guard -> the order issues with a tax Shopify never charged.
  test("a line whose computed tax disagrees with Shopify's reported amount parks the order (shopify_tax_mismatch)", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    const result = await onShopifyOrderCreated(
      {
        orderId: "order-mismatch",
        shopDomain: "shop-1",
        totalPrice: { amount: "121.00", currencyCode: "EUR" },
        taxesIncluded: false,
        billingAddress: { address1: "1 rue Test", zip: "75001", city: "Paris", country_code: "FR" },
        customer: { id: "c-m", email: "m@example.com", first_name: "M", last_name: "B", country: "FR" },
        lineItems: [
          {
            id: "li-m",
            title: "Widget",
            quantity: 1,
            priceSet: { amount: "100.00", currencyCode: "EUR" },
            requiresShipping: false,
            // 20% on 100.00 is 20.00; Shopify reports 21.00.
            taxLines: [{ rate: 0.2, amount: "21.00" }],
            variant: { id: "1" },
          },
        ],
      },
      ctx,
    )
    expect(result).toMatchObject({ status: "deferred", reason: "awaiting_data" })
    expect(db.__all("documents")).toHaveLength(0)
    const park = db.__all("deferred_events")[0] as Record<string, unknown>
    expect(park.reason).toBe("shopify_tax_mismatch")
    const lines = (park.blocked_on as { lines: Array<Record<string, unknown>> }).lines
    expect(lines[0]).toMatchObject({ description: "Widget", computed_minor: "2000", shopify_minor: "2100" })
  })

  test("the per line check accepts a one minor unit rounding difference", () => {
    expect(
      shopifyTaxMismatches([
        {
          id: "x",
          description: "Cable",
          quantity: "1",
          unit_price_minor: "1417",
          tax_rate_bp: 2000,
          shopify_tax_minor: "282",
          shopify_tax_line_count: 1,
        },
      ]),
    ).toEqual([])
  })

  // red: delete the exempt-treatment guard -> an export invoice issues with a 7.25% seller tax line
  // next to the Article 146 exemption.
  test("seller tax on an export (exempt) treatment parks the order (tax_on_exempt_treatment)", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
      overlay,
    })
    const result = await onShopifyOrderCreated(
      order3386({
        lineItems: [
          {
            id: "li-tessera",
            title: "Tessera 2",
            quantity: 1,
            priceSet: { amount: "899.00", currencyCode: "USD" },
            requiresShipping: true,
            taxLines: [{ title: "CA State Tax", rate: 0.0725, amount: "65.18" }],
            variant: { id: "777" },
          },
        ],
        shippingLines: [],
      }),
      ctx,
    )
    expect(result).toMatchObject({ status: "deferred", reason: "awaiting_data" })
    expect(db.__all("documents")).toHaveLength(0)
    const park = db.__all("deferred_events")[0] as Record<string, unknown>
    expect(park.reason).toBe("tax_on_exempt_treatment")
  })

  // red: delete the placeholder guard -> an EU B2C order with no Shopify rate issues at the
  // issuer's domestic rate standing in for the destination's OSS rate.
  test("an EU B2C (OSS) line with no Shopify rate parks instead of issuing the placeholder rate", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    const result = await onShopifyOrderPaid(
      basePayload({
        id: "order-oss",
        customer: {
          ...basePayload().customer!,
          country: "DE",
          vat_id: null,
          address: "Hauptstrasse 5, 10115 Berlin",
        },
      }),
      ctx,
    )
    expect(result).toMatchObject({ status: "deferred", reason: "awaiting_config" })
    expect(db.__all("documents")).toHaveLength(0)
    expect((db.__all("deferred_events")[0] as Record<string, unknown>).reason).toBe(
      "tax_rate_placeholder",
    )
  })

  test("an EU B2C line that carries Shopify's own rate is not blocked by the placeholder guard", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    const p = basePayload({
      id: "order-oss-rated",
      customer: { ...basePayload().customer!, country: "DE", vat_id: null, address: "Hauptstrasse 5" },
    })
    p.line_items = p.line_items.map((l) => ({ ...l, tax_rate_bp: 1900 }))
    const result = await onShopifyOrderPaid(p, ctx)
    expect(result.status).toBe("ok")
    expect(db.__all("documents")).toHaveLength(1)
  })

  // red: drop `vat_id: buyerTaxId` in adaptShopifyOrderCreatedEvent -> counterparty_vat_id stays null.
  test("the buyer's VAT id from the order reaches the document", async () => {
    const { ctx, db } = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
    })
    // A French company buyer: its registry-confirmed identity (fictional SIREN, matches the VAT id).
    await seedConfirmedIdentity(db, {
      contact_id: "contact-resolved-1",
      siren: "902000009",
      name: "Acme SAS",
      postcode: "75001",
      city: "Paris",
      line1: "1 rue Test",
    })
    const result = await onShopifyOrderCreated(
      {
        orderId: "order-vat",
        shopDomain: "shop-1",
        buyerTaxId: "FR60902000009",
        totalPrice: { amount: "120.00", currencyCode: "EUR" },
        taxesIncluded: true,
        billingAddress: { company: "Acme SAS", address1: "1 rue Test", zip: "75001", city: "Paris", country_code: "FR" },
        customer: { id: "c-v", email: "v@example.com", first_name: "V", last_name: "B", country: "FR" },
        lineItems: [
          {
            id: "li-v",
            title: "Licence",
            quantity: 1,
            priceSet: { amount: "120.00", currencyCode: "EUR" },
            requiresShipping: false,
            taxLines: [{ rate: 0.2, amount: "20.00" }],
            variant: { id: "2" },
          },
        ],
      },
      ctx,
    )
    expect(result.status).toBe("ok")
    const doc = db.__all("documents")[0] as Record<string, unknown>
    expect(doc.counterparty_vat_id).toBe("FR60902000009")
  })
})

// A tax review park never clears on its own: it raises attention once and waits for a person, who
// issues the order through the gated deferred_tax_override with an explicit tax source.
describe("tax review parks: attention once, resolved by an explicit override", () => {
  const mismatchEvent = {
    orderId: "order-review",
    name: "#4001",
    shopDomain: "shop-1",
    totalPrice: { amount: "121.00", currencyCode: "EUR" },
    taxesIncluded: false,
    billingAddress: { address1: "1 rue Test", zip: "75001", city: "Paris", country_code: "FR" },
    customer: { id: "c-r", email: "r@example.com", first_name: "R", last_name: "B", country: "FR" },
    lineItems: [
      {
        id: "li-r",
        title: "Widget",
        quantity: 1,
        priceSet: { amount: "100.00", currencyCode: "EUR" },
        requiresShipping: false,
        taxLines: [{ rate: 0.2, amount: "21.00" }],
        variant: { id: "1" },
      },
    ],
  }
  function withEmits() {
    const made = makeCtx({ issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }] })
    const emits: Array<Record<string, unknown>> = []
    const ctx = { ...made.ctx, emit: async (e: Record<string, unknown>) => void emits.push(e) }
    return { ...made, ctx, emits }
  }

  // red: drop the emit in parkForTaxReview (or emit on every refresh) -> no attention row, or one
  // per webhook redelivery.
  test("the park raises one attention row, not one per redelivery", async () => {
    const { ctx, emits } = withEmits()
    await onShopifyOrderCreated(mismatchEvent, ctx)
    await onShopifyOrderCreated(mismatchEvent, ctx)
    const reviews = emits.filter((e) => e.entity === "deferred" && e.action === "tax_review")
    expect(reviews).toHaveLength(1)
    expect(reviews[0]!.data).toMatchObject({ order_label: "#4001", reason: "shopify_tax_mismatch", resolved: false })
  })

  // red: drop the tax_override handling in onShopifyOrderPaid -> the override re-parks.
  test("shopify_reported issues with Shopify's tax, resolves the park and the attention row", async () => {
    const { ctx, db, emits } = withEmits()
    const parked = await onShopifyOrderCreated(mismatchEvent, ctx)
    const deferredId = (parked as { deferred_id: string }).deferred_id
    const listed = await deferredList({ db } as never, {})
    expect(listed.items.find((i) => i.id === deferredId)?.resolution_options).toEqual([
      "shopify_reported",
      "as_computed",
    ])
    const res = await deferredTaxOverride(
      { ...ctx, approval: { approvalRequestId: "a1", approvalDeciderId: "u1", toolName: "invoicing:deferred_tax_override" } },
      { deferred_id: deferredId, mode: "shopify_reported" },
    )
    expect(res.status).toBe("completed")
    const doc = db.__all("documents")[0] as Record<string, unknown>
    expect(String(doc.tax_total_minor)).toBe("2100")
    expect((doc.lifecycle_log as Array<Record<string, unknown>>).at(-1)).toMatchObject({
      event: "tax_override",
      mode: "shopify_reported",
    })
    const park = (await db.findOne("deferred_events", deferredId)) as Record<string, unknown>
    expect(park).toMatchObject({ status: "resolved", reason: "tax_override_shopify_reported" })
    expect(emits.at(-1)).toMatchObject({ entity: "deferred", action: "tax_review", data: { resolved: true } })
  })

  test("as_computed issues an export with no tax when Shopify charged some", async () => {
    const { ctx, db } = withEmits()
    const parked = await onShopifyOrderCreated(
      {
        ...mismatchEvent,
        orderId: "order-exempt",
        billingAddress: { address1: "1 Main St", zip: "10001", city: "New York", country_code: "US" },
        customer: { ...mismatchEvent.customer, country: "US" },
        lineItems: [{ ...mismatchEvent.lineItems[0]!, taxLines: [{ rate: 0.0725, amount: "7.25" }] }],
      },
      ctx,
    )
    const deferredId = (parked as { deferred_id: string }).deferred_id
    expect((await db.findOne("deferred_events", deferredId)) as Record<string, unknown>).toMatchObject({
      reason: "tax_on_exempt_treatment",
    })
    const res = await deferredTaxOverride(ctx, { deferred_id: deferredId, mode: "as_computed" })
    expect(res.status).toBe("completed")
    const doc = db.__all("documents")[0] as Record<string, unknown>
    expect(String(doc.tax_total_minor)).toBe("0")
    expect(String(doc.grand_total_minor)).toBe("10000")
  })

  // red: run the exempt-treatment guard on an overridden payload -> the operator's explicit
  // "keep Shopify's tax" decision re-parks forever.
  test("shopify_reported on an exempt park issues the tax the operator chose to keep", async () => {
    const { ctx, db } = withEmits()
    const parked = await onShopifyOrderCreated(
      {
        ...mismatchEvent,
        orderId: "order-exempt-keep",
        billingAddress: { address1: "1 Main St", zip: "10001", city: "New York", country_code: "US" },
        customer: { ...mismatchEvent.customer, country: "US" },
        lineItems: [{ ...mismatchEvent.lineItems[0]!, taxLines: [{ rate: 0.0725, amount: "7.25" }] }],
      },
      ctx,
    )
    const res = await deferredTaxOverride(ctx, {
      deferred_id: (parked as { deferred_id: string }).deferred_id,
      mode: "shopify_reported",
    })
    expect(res.status).toBe("completed")
    expect(String((db.__all("documents")[0] as Record<string, unknown>).tax_total_minor)).toBe("725")
  })

  test("a park that is not a tax review is refused, it retries on its own", async () => {
    const { ctx, db } = withEmits()
    const p = basePayload({ id: "order-noemail", customer: { ...basePayload().customer!, email: null } })
    const parked = await onShopifyOrderPaid(p, ctx)
    const res = await deferredTaxOverride(ctx, {
      deferred_id: (parked as { deferred_id: string }).deferred_id,
      mode: "as_computed",
    })
    expect(res).toMatchObject({ status: "error", error: { code: "not_a_tax_review", refusal: true } })
    expect(db.__all("documents")).toHaveLength(0)
  })

  // The tool is gated: the kernel runs the manifest preflight BEFORE it parks the approval, so a
  // call the handler would refuse never reaches a human who could only watch it fail.
  // red: drop the preflight (or let it skip the park checks) -> these calls are accepted at staging.
  test("the stage-time preflight refuses what the handler would refuse, and writes nothing", async () => {
    const { ctx, db } = withEmits()
    const review = await onShopifyOrderCreated(mismatchEvent, ctx)
    const reviewId = (review as { deferred_id: string }).deferred_id
    const noEmail = await onShopifyOrderPaid(
      basePayload({ id: "order-noemail-pre", customer: { ...basePayload().customer!, email: null } }),
      ctx,
    )
    const noEmailId = (noEmail as { deferred_id: string }).deferred_id
    const parksBefore = db.__all("deferred_events").length
    const noEmailStatus = ((await db.findOne("deferred_events", noEmailId)) as Record<string, unknown>).status

    expect(await deferredTaxOverridePreflight(ctx, { deferred_id: reviewId, mode: "as_computed" })).toEqual({ ok: true })
    expect(await deferredTaxOverridePreflight(ctx, { deferred_id: reviewId, mode: "bogus" })).toMatchObject({
      error: { code: "invalid_params" },
    })
    expect(await deferredTaxOverridePreflight(ctx, { mode: "as_computed" })).toMatchObject({
      error: { code: "invalid_params" },
    })
    expect(await deferredTaxOverridePreflight(ctx, { deferred_id: "nope", mode: "as_computed" })).toMatchObject({
      error: { code: "not_found" },
    })
    expect(await deferredTaxOverridePreflight(ctx, { deferred_id: noEmailId, mode: "as_computed" })).toMatchObject({
      error: { code: "not_a_tax_review" },
    })
    await db.update("deferred_events", reviewId, { status: "resolved" })
    expect(await deferredTaxOverridePreflight(ctx, { deferred_id: reviewId, mode: "as_computed" })).toMatchObject({
      error: { code: "already_resolved" },
    })
    expect(db.__all("documents")).toHaveLength(0)
    expect(db.__all("deferred_events")).toHaveLength(parksBefore)
    expect(((await db.findOne("deferred_events", noEmailId)) as Record<string, unknown>).status).toBe(noEmailStatus)
  })
})


// An order to a buyer in another member state, tax exempt in Shopify (every line at 0%), parked
// first on a missing email. Its VAT number and company reach the order only afterwards.
describe("intra-EU order without VAT charged: late VAT number, or a review park", () => {
  const italianBuyer = (): OrderPaidPayload =>
    basePayload({
      id: "order-it",
      order_number: "#3001",
      total_price_minor: 36000n,
      customer: {
        id: "c-it",
        email: null,
        contact_id: "contact-it",
        country: "IT",
        legal_name: "Gina Rossi",
        vat_id: null,
        address: "Via Roma 1\n10100 Torino",
        billing: {
          company: null,
          line1: "Via Roma 1",
          line2: null,
          postcode: "10100",
          city: "Torino",
          country_code: "IT",
        },
      },
      line_items: [
        { id: "prod-it", description: "Instrument", quantity: "1", unit_price_minor: 36000n, tax_rate_bp: 0 },
      ],
    })
  function setup(order: Record<string, unknown>) {
    const byName: Record<string, CrossAppEnvelope> = {
      "shopify:orders_get": { status: "completed", result: order },
    }
    const made = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
      executeToolByName: byName,
      noDefaultIdentity: true,
    })
    const cronCtx = {
      ...made.ctx,
      db: made.db,
      emit: async () => {},
      decideApproval: async () => ({ status: "ok" as const }),
    }
    return { ...made, byName, cronCtx }
  }
  const liveOrder = (extra: Record<string, unknown>) => ({
    name: "#3001",
    customer: { email: "gina@example.com", first_name: "Gina", last_name: "Rossi" },
    billingAddress: {
      name: "Gina Rossi",
      company: "Rossi Strumenti SRL",
      address1: "Via Roma 1",
      city: "Torino",
      zip: "10100",
      countryCode: "IT",
    },
    ...extra,
  })

  // red: mergeCustomer takes vat_id from the stored payload only (or legal_name ignores the
  // company) -> the retry issues eu_b2c_oss at 0% to the person, the invoice this fix exists for.
  test("a VAT number added to the order before the retry issues the reverse charge to the company", async () => {
    const { ctx, db, byName, cronCtx } = setup({ name: "#3001", customer: { email: null } })
    const first = await onShopifyOrderPaid(italianBuyer(), ctx)
    expect(first).toMatchObject({ status: "deferred", reason: "awaiting_data" })
    expect((db.__all("deferred_events")[0] as Record<string, unknown>).reason).toBe("customer_email_missing")

    // The operator adds the email and the "VAT number" custom attribute on the Shopify order.
    byName["shopify:orders_get"] = {
      status: "completed",
      result: liveOrder({ buyerTaxId: "IT01234567890" }),
    }
    const swept = await deferredRetryJobHandler(undefined, cronCtx, { now: new Date("2030-01-01T00:00:00Z") })
    expect(swept.succeeded).toBe(1)
    const docs = db.__all("documents") as Array<Record<string, unknown>>
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({
      tax_treatment: "eu_reverse_charge",
      counterparty_vat_id: "IT01234567890",
      counterparty_name: "Rossi Strumenti SRL",
    })
  })

  // red: delete guard (4) in onShopifyOrderPaid -> the order issues as eu_b2c_oss at 0%.
  test("with no VAT number it parks for review instead of issuing a 0% consumer invoice", async () => {
    const { ctx, db } = setup(liveOrder({ buyerTaxId: null }))
    const result = await onShopifyOrderPaid(italianBuyer(), ctx)
    expect(result).toMatchObject({ status: "deferred", reason: "awaiting_data" })
    expect(db.__all("documents")).toHaveLength(0)
    const park = db.__all("deferred_events")[0] as Record<string, unknown>
    expect(park.reason).toBe("buyer_vat_missing")
    const blockedOn = park.blocked_on as Record<string, unknown>
    expect(blockedOn).toMatchObject({ kind: "tax_rate", treatment: "eu_b2c_oss", counterparty_country: "IT" })
    expect(String(blockedOn.detail)).toContain("VAT number")
    const listed = await deferredList({ db } as never, {})
    expect(listed.items[0]?.resolution_options).toEqual(["shopify_reported", "as_computed"])
  })

  test("once the VAT number is on the order, the override issues the reverse charge", async () => {
    const { ctx, db, byName } = setup(liveOrder({ buyerTaxId: null }))
    const parked = await onShopifyOrderPaid(italianBuyer(), ctx)
    byName["shopify:orders_get"] = { status: "completed", result: liveOrder({ buyerTaxId: "IT01234567890" }) }
    const res = await deferredTaxOverride(ctx, {
      deferred_id: (parked as { deferred_id: string }).deferred_id,
      mode: "shopify_reported",
    })
    expect(res.status).toBe("completed")
    expect(db.__all("documents")[0]).toMatchObject({
      tax_treatment: "eu_reverse_charge",
      counterparty_vat_id: "IT01234567890",
    })
  })

  test("an order that charged the destination's VAT on some line still issues", async () => {
    const { ctx, db } = setup(liveOrder({ buyerTaxId: null }))
    const p = italianBuyer()
    p.customer = { ...p.customer!, email: "gina@example.com" }
    p.line_items = [
      { ...p.line_items[0]!, tax_rate_bp: 2200 },
      { id: "", description: "Shipping", quantity: "1", unit_price_minor: 1000n, tax_rate_bp: 0, line_kind: "shipping" },
    ]
    const result = await onShopifyOrderPaid(p, ctx)
    expect(result.status).toBe("ok")
    expect(db.__all("deferred_events")).toHaveLength(0)
  })
})

// E-invoicing on the order-paid path: the kind is derived at creation from the checkout signals,
// the structured billing is captured, a French business buyer whose identity is incomplete parks
// the order (enforce) with one attention item per contact, and warn mode issues with a warning.
describe("order-paid e-invoicing gate", () => {
  const BILLING = {
    company: "Forge Exemple SARL",
    address1: "12 rue de l'Exemple",
    address2: "Bâtiment B",
    zip: "69002",
    city: "Lyon",
    country_code: "FR",
  }
  function fireEvent(overrides: Record<string, unknown> = {}) {
    return {
      orderId: "order-ei-1",
      name: "#5001",
      shopDomain: "shop-1",
      financialStatus: "paid",
      createdAt: "2026-10-10T09:00:00Z",
      totalPrice: { amount: "120.00", currencyCode: "EUR" },
      taxesIncluded: true,
      billingAddress: BILLING,
      customer: { id: "c-ei", email: "forge@example.com", first_name: "Alex", last_name: "Exemple", country: "FR" },
      lineItems: [
        {
          id: "li-ei",
          title: "Widget",
          quantity: 1,
          priceSet: { amount: "120.00", currencyCode: "EUR" },
          requiresShipping: true,
          taxLines: [{ rate: 0.2, amount: "20.00" }],
          variant: { id: "7" },
        },
      ],
      ...overrides,
    }
  }
  function gated(opts?: { gateMode?: "warn" | "enforce"; resolveContactId?: string }) {
    const made = makeCtx({
      issuerProfiles: [{ profile: issuerFR, shopify_shop_id: "shop-1" }],
      resolveContactId: opts?.resolveContactId ?? "contact-ei",
      noDefaultIdentity: true,
    })
    const emits: Array<Record<string, unknown>> = []
    const ctx = { ...made.ctx, emit: async (e: Record<string, unknown>) => void emits.push(e) }
    return { ...made, ctx, emits }
  }
  async function setMode(db: MockDb, mode: "warn" | "enforce") {
    await db.insert("einvoicing_settings", { gate_mode: mode, gate_mode_source: "explicit" })
  }
  const identityEmits = (emits: Array<Record<string, unknown>>) =>
    emits.filter((e) => e.entity === "einvoicing" && e.action === "identity_missing")

  // red: issue with the gate not activated -> an e-invoice-bound document issues with no SIREN.
  test("a business FR order without a SIREN parks einvoice_identity; a second order for the same contact parks but emits nothing more", async () => {
    const { ctx, db, emits } = gated()
    await setMode(db, "enforce")
    const first = await onShopifyOrderCreated(fireEvent(), ctx)
    expect(first).toMatchObject({ status: "deferred", reason: "awaiting_data" })
    expect(db.__all("documents")).toHaveLength(0)
    const parks = db.__all("deferred_events")
    expect(parks).toHaveLength(1)
    expect(parks[0]).toMatchObject({
      event_id: "order-ei-1",
      status: "awaiting_data",
      reason: "einvoice_data_missing",
      blocked_on: { kind: "einvoice_identity", contact_id: "contact-ei", code: "einvoice_data_missing" },
    })
    expect(identityEmits(emits)).toHaveLength(1)
    expect(identityEmits(emits)[0]).toMatchObject({
      entityId: "contact-ei",
      data: { contact_id: "contact-ei", code: "einvoice_data_missing", order_id: "order-ei-1", resolved: false },
    })
    // The derived identity is recorded: a company on the billing address makes a business.
    const ids = db.__all("counterparty_identities")
    expect(ids).toHaveLength(1)
    expect(ids[0]).toMatchObject({ contact_id: "contact-ei", customer_kind: "business", source: "derived", siren: null })

    // Redelivery of the same order refreshes its park, emits nothing.
    await onShopifyOrderCreated(fireEvent(), ctx)
    // A second order for the same contact parks too, still one attention item for the contact.
    const second = await onShopifyOrderCreated(fireEvent({ orderId: "order-ei-2", name: "#5002" }), ctx)
    expect(second).toMatchObject({ status: "deferred" })
    expect(db.__all("deferred_events")).toHaveLength(2)
    expect(identityEmits(emits)).toHaveLength(1)
  })

  // red: no derivation from the VAT id -> einvoice_data_missing instead of registry_unconfirmed.
  test("company + FR VAT id -> derived unconfirmed SIREN -> parks registry_unconfirmed", async () => {
    const { ctx, db, emits } = gated()
    await setMode(db, "enforce")
    const r = await onShopifyOrderCreated(fireEvent({ buyerTaxId: "FR68900000001" }), ctx)
    expect(r).toMatchObject({ status: "deferred", reason: "awaiting_data" })
    expect(db.__all("documents")).toHaveLength(0)
    const ids = db.__all("counterparty_identities")
    expect(ids).toHaveLength(1)
    expect(ids[0]).toMatchObject({ customer_kind: "business", siren: "900000001", source: "derived", confirmed_via: null })
    expect(db.__all("deferred_events")[0]).toMatchObject({
      reason: "registry_unconfirmed",
      blocked_on: { kind: "einvoice_identity", contact_id: "contact-ei", code: "registry_unconfirmed" },
    })
    expect(identityEmits(emits)).toHaveLength(1)
  })

  test("a USD e-invoice the ECB cannot price is deferred, nothing issued", async () => {
    const { ctx, db } = gated()
    await setMode(db, "enforce")
    await seedConfirmedIdentity(db, {
      contact_id: "contact-ei",
      siren: "900000001",
      name: "Forge Exemple SARL",
      postcode: "69002",
      city: "Lyon",
    })
    // No ctx.fetch and no cached rate: the ECB is unreachable at issue.
    const usd = fireEvent({ buyerTaxId: "FR68900000001", totalPrice: { amount: "120.00", currencyCode: "USD" } })
    usd.lineItems = usd.lineItems.map((li) => ({ ...li, priceSet: { amount: "120.00", currencyCode: "USD" } }))
    const r = await onShopifyOrderCreated(usd, ctx)
    expect(r.status).toBe("deferred")
    expect(db.__all("documents")).toHaveLength(0)
    const deferred = db.__all("deferred_events")
    expect(deferred).toHaveLength(1)
    expect(deferred[0]).toMatchObject({ status: "awaiting_dependency", reason: "awaiting_fx_rate" })
  })

  // red: gate not activated -> the document carries no regime snapshot.
  test("a confirmed identity issues an e_invoice, payment state paid, BT-23 B2", async () => {
    const { ctx, db, emits } = gated()
    await setMode(db, "enforce")
    await seedConfirmedIdentity(db, {
      contact_id: "contact-ei",
      siren: "900000001",
      name: "Forge Exemple SARL",
      postcode: "69002",
      city: "Lyon",
    })
    const r = await onShopifyOrderCreated(fireEvent({ buyerTaxId: "FR68900000001" }), ctx)
    expect(r.status).toBe("ok")
    const doc = db.__all("documents")[0] as Record<string, unknown>
    expect(doc.regime).toBe("e_invoice")
    expect(doc.payment_state).toBe("paid")
    expect(doc.operation_category).toBe("goods")
    expect(doc.operation_category_source).toBe("lines_authoritative")
    expect(bt23(doc.operation_category as "goods", doc.payment_state as "paid")).toBe("B2")
    expect(doc.buyer_siren).toBe("900000001")
    expect(doc.buyer_siren_confirmed_via).toBe("auto")
    expect(db.__all("deferred_events")).toHaveLength(0)
    expect(identityEmits(emits)).toHaveLength(0)
  })

  // red: a checkout consumer without a kind would need a manual step (customer_kind_missing).
  test("a fresh B2C French order issues with no manual step", async () => {
    const { ctx, db, emits } = gated()
    await setMode(db, "enforce")
    const { company: _c, ...consumerBilling } = BILLING
    const r = await onShopifyOrderCreated(fireEvent({ billingAddress: consumerBilling }), ctx)
    expect(r.status).toBe("ok")
    const doc = db.__all("documents")[0] as Record<string, unknown>
    expect(doc.regime).toBe("e_reporting")
    expect(doc.customer_kind).toBe("individual")
    expect(db.__all("deferred_events")).toHaveLength(0)
    expect(identityEmits(emits)).toHaveLength(0)
  })

  // red: the adapter flattens the address only -> no structured billing / delivery on the payload
  // or the document.
  test("structured billing and delivery are captured from the event addresses", async () => {
    const shipping = {
      name: "Quai de réception",
      address1: "3 quai du Test",
      zip: "13002",
      city: "Marseille",
      country_code: "FR",
    }
    const p = adaptShopifyOrderCreatedEvent(fireEvent({ shippingAddress: shipping }))
    expect(p.customer?.billing).toEqual({
      company: "Forge Exemple SARL",
      line1: "12 rue de l'Exemple",
      line2: "Bâtiment B",
      postcode: "69002",
      city: "Lyon",
      country_code: "FR",
    })
    expect(p.customer?.delivery).toEqual({
      name: "Quai de réception",
      line1: "3 quai du Test",
      line2: null,
      postcode: "13002",
      city: "Marseille",
      country_code: "FR",
    })

    const { ctx, db } = gated()
    await setMode(db, "enforce")
    await seedConfirmedIdentity(db, {
      contact_id: "contact-ei",
      siren: "900000001",
      name: "Forge Exemple SARL",
      postcode: "69002",
      city: "Lyon",
    })
    const r = await onShopifyOrderCreated(fireEvent({ shippingAddress: shipping }), ctx)
    expect(r.status).toBe("ok")
    const doc = db.__all("documents")[0] as Record<string, unknown>
    expect(doc).toMatchObject({
      billing_line1: "12 rue de l'Exemple",
      billing_line2: "Bâtiment B",
      billing_postcode: "69002",
      billing_city: "Lyon",
      billing_country_code: "FR",
      delivery_name: "Quai de réception",
      delivery_line1: "3 quai du Test",
      delivery_postcode: "13002",
      delivery_city: "Marseille",
      delivery_country_code: "FR",
    })
  })

  // red: gate after the approval threshold -> an approval is requested for an order that can only park.
  test("an order above the approval threshold parks on the identity before any approval is requested", async () => {
    const made = makeCtx({
      issuerProfiles: [
        { profile: { ...issuerFR, invoice_approval_threshold_minor: 5000n }, shopify_shop_id: "shop-1" },
      ],
      resolveContactId: "contact-ei",
      noDefaultIdentity: true,
    })
    const emits: Array<Record<string, unknown>> = []
    const ctx = { ...made.ctx, emit: async (e: Record<string, unknown>) => void emits.push(e) }
    await setMode(made.db, "enforce")
    const r = await onShopifyOrderCreated(fireEvent({ buyerTaxId: "FR68900000001" }), ctx)
    expect(r).toMatchObject({ status: "deferred", reason: "awaiting_data" })
    expect(made.extras.approvalsFiled).toHaveLength(0)
    expect(made.db.__all("documents")).toHaveLength(0)
    expect(made.db.__all("deferred_events")[0]).toMatchObject({
      reason: "registry_unconfirmed",
      blocked_on: { kind: "einvoice_identity", contact_id: "contact-ei", code: "registry_unconfirmed" },
    })
    expect(made.db.__all("counterparty_identities")[0]).toMatchObject({ siren: "900000001", confirmed_via: null })
    expect(identityEmits(emits)).toHaveLength(1)
  })

  // red: warn mode must issue, not park; and the warning must be recorded on the document.
  test("warn mode issues and records the warning", async () => {
    const { ctx, db, emits } = gated()
    await setMode(db, "warn")
    const r = await onShopifyOrderCreated(fireEvent(), ctx)
    expect(r.status).toBe("ok")
    const doc = db.__all("documents")[0] as Record<string, unknown>
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    expect(log.find((e) => e.event === "einvoice_gate_warning")).toMatchObject({ code: "einvoice_data_missing" })
    expect((doc.regime_reasons as Array<Record<string, unknown>>).some((x) => x.code === "gate_warning")).toBe(true)
    expect(db.__all("deferred_events")).toHaveLength(0)
    expect(identityEmits(emits)).toHaveLength(0)
  })
})
