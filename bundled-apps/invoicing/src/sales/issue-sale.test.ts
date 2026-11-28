// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One sale, one invoice, through the revenue stream path: a provider's `sale:paid` reaches
// `onSaleEvent`, which reads the sale through the contract and issues it under the bound stream's
// issuer, keyed by the sale's own names; idempotent under replays; the stream's mode and its
// `issue_from` are honoured; a review stream asks a person and its approval re-enters with the
// sale read again; the shop's sales go through the order flow as before.
import { describe, expect, test } from "bun:test"
import type { Sale } from "@liaison/app-sdk/contracts"
import { FR_SELLER_IDENTITY } from "../einvoicing/test-fixtures"
import type { OrderPaidCtx } from "../handlers/shopify-order-paid"
import { createMockDb } from "../test-db"
import { testTime } from "../test-time"
import { onSaleApproved, onSaleEvent, type SaleCtx } from "./issue-sale"

const ISSUER = {
  id: "issuer-1",
  legal_name: "Studio Test SARL",
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
  mail_account_id: null,
  timezone: "Europe/Paris",
  email_templates: {},
  shopify_shop_id: null,
  ...FR_SELLER_IDENTITY,
}

function sale(over: Partial<Sale> = {}): Sale {
  return {
    external_id: "pi_1",
    refs: { charge_id: "ch_1", checkout_session_id: "cs_1", order_name: "HUB-1" },
    sold_at: "2026-11-20T10:00:00.000Z",
    paid: { status: "paid", payment_ref: "ch_1" },
    currency: "EUR",
    buyer: {
      email: "buyer@example.de",
      name: "Lena Buyer",
      kind: "individual",
      billing: { line1: "Hauptstr. 1", postcode: "10115", city: "Berlin", country: "DE" },
      tax_evidence: { billing_country: "DE", card_country: "DE" },
    },
    lines: [
      {
        description: "Sound pack",
        quantity: "1",
        unit_price_minor: "2000",
        kind: "service",
        tax: { rate_bp: 1900, amount_minor: "380", reported_by_source: true },
      },
    ],
    totals: { total_minor: "2380", subtotal_minor: "2000", tax_minor: "380" },
    ...over,
  }
}

function makeCtx(opts: {
  streams?: Array<Record<string, unknown>>
  sales?: Record<string, Sale>
  approval?: OrderPaidCtx["approval"]
  issuer?: Record<string, unknown>
}) {
  const db = createMockDb({
    seed: {
      issuer_profiles: [{ ...ISSUER, ...(opts.issuer ?? {}) }],
      revenue_streams: opts.streams ?? [],
    },
    bridgeWhereOperators: true,
  })
  const calls: Array<{ op: string; params: unknown; provider: string | null | undefined }> = []
  const approvals: Array<{ tool_name: string; current_payload: unknown }> = []
  const ctx: SaleCtx = {
    getUserId: async () => "user-1",
    approval: opts.approval ?? null,
    db,
    time: testTime(),
    pdf: {
      async render() {
        return {
          file_id: crypto.randomUUID(),
          byte_size: 1,
          page_count: 1,
          sha256: "0".repeat(64),
          parent_entity_id: crypto.randomUUID(),
        }
      },
    },
    messages: { post: async () => ({ message_id: "m" }) },
    executeTool: async (name) =>
      name === "shopify:orders_get"
        ? { status: "completed", result: { customer: null } }
        : { status: "completed", result: {} },
    requestApproval: async (input) => {
      approvals.push({ tool_name: input.tool_name, current_payload: input.current_payload })
      return { approval_id: `approval-${approvals.length}` }
    },
    resolveContact: async () => ({ id: "contact-1" }),
    contracts: {
      async call<T>(
        _contract: string,
        op: string,
        params: Record<string, unknown>,
        o?: { provider?: string | null },
      ) {
        calls.push({ op, params, provider: o?.provider })
        const s = opts.sales?.[`${o?.provider}:${String(params.external_id)}`]
        return {
          status: "completed" as const,
          result: (s ? { found: true, sale: s } : { found: false }) as T,
          provider: String(o?.provider),
        }
      },
    },
  } as SaleCtx
  return { ctx, db, calls, approvals }
}

const stream = (over: Record<string, unknown> = {}) => ({
  id: "stream-1",
  provider_app: "hubshop",
  source_ref: null,
  label: "Hub",
  issuer_profile_id: "issuer-1",
  mode: "auto",
  issue_from: "2026-11-01T00:00:00.000Z",
  mail: "none",
  ...over,
})

const event = (app: string, external_id: string) => ({
  app,
  entity: "sale",
  action: "paid",
  data: { external_id, occurred_at: "2026-11-20T10:00:00.000Z" },
})

async function docs(db: ReturnType<typeof createMockDb>) {
  return (await db.findMany("documents", { limit: 50 })) as Array<Record<string, unknown>>
}

describe("onSaleEvent", () => {
  test("no bound stream: nothing is read and nothing issued", async () => {
    const { ctx, db, calls } = makeCtx({ sales: { "hubshop:pi_1": sale() } })
    expect(await onSaleEvent(event("hubshop", "pi_1"), ctx)).toEqual({
      status: "skipped",
      reason: "no_stream",
    })
    expect(calls).toEqual([])
    expect(await docs(db)).toEqual([])
  })

  test("a custom app's sale issues one invoice under the stream's issuer, keyed by the sale", async () => {
    const { ctx, db, calls } = makeCtx({
      streams: [stream()],
      sales: { "hubshop:pi_1": sale() },
    })
    const r = await onSaleEvent(event("hubshop", "pi_1"), ctx)
    expect(r.status).toBe("ok")
    expect(calls).toEqual([
      { op: "sale_get", params: { external_id: "pi_1" }, provider: "hubshop" },
    ])
    const [doc] = await docs(db)
    expect(doc).toMatchObject({
      type: "invoice",
      issuer_profile_id: "issuer-1",
      external_ref: "rs:hubshop:pi_1:software",
      currency: "EUR",
      grand_total_minor: "2380",
    })
    const refs = doc?.external_refs as Record<string, unknown>
    expect(refs).toMatchObject({
      revenue_stream_id: "stream-1",
      sale_provider: "hubshop",
      sale_external_id: "pi_1",
      order_name: "HUB-1",
      sold_at: "2026-11-20T10:00:00.000Z",
    })
    expect(refs.shopify_order_id).toBeUndefined()
    // The sale is in the ledger with its buyer, and its invoice points at it.
    const ledger = (await db.findMany("sales", { limit: 5 })) as Array<Record<string, unknown>>
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      stream: "hubshop",
      external_id: "pi_1",
      buyer_email: "buyer@example.de",
      sold_on: "2026-11-20",
      state: "issued",
    })
    expect(doc?.sale_id).toBe(ledger[0]?.id)
    // Sold on 20 November, issued today: the sale date is on the invoice.
    expect(doc?.supply_date).toBe("2026-11-20")
    // A replayed event issues nothing more.
    expect((await onSaleEvent(event("hubshop", "pi_1"), ctx)).status).toBe("skipped")
    expect(await docs(db)).toHaveLength(1)
  })

  test("a sale paid before the stream was bound, or a stream turned off, issues nothing", async () => {
    const early = makeCtx({
      streams: [stream({ issue_from: "2026-11-25T00:00:00.000Z" })],
      sales: { "hubshop:pi_1": sale() },
    })
    expect(await onSaleEvent(event("hubshop", "pi_1"), early.ctx)).toEqual({
      status: "skipped",
      reason: "before_stream",
    })
    const off = makeCtx({ streams: [stream({ mode: "off" })], sales: { "hubshop:pi_1": sale() } })
    expect(await onSaleEvent(event("hubshop", "pi_1"), off.ctx)).toEqual({
      status: "skipped",
      reason: "stream_off",
    })
    expect(await docs(early.db)).toEqual([])
    expect(await docs(off.db)).toEqual([])
  })

  test("an invalid sale parks with its problems instead of issuing", async () => {
    const { ctx, db } = makeCtx({
      streams: [stream()],
      sales: { "hubshop:pi_1": sale({ currency: "euro" }) },
    })
    const r = await onSaleEvent(event("hubshop", "pi_1"), ctx)
    expect(r).toMatchObject({ status: "deferred", reason: "awaiting_data" })
    const parks = (await db.findMany("deferred_events", { limit: 5 })) as Array<
      Record<string, unknown>
    >
    expect(parks[0]).toMatchObject({
      event_id: "rs:stream-1:pi_1",
      reason: "sale_invalid",
      event_payload_json: {
        kind: "revenue_stream_sale",
        stream_id: "stream-1",
        external_id: "pi_1",
      },
    })
    expect(await docs(db)).toEqual([])
  })

  test("a sale whose lines do not add up to its totals parks for a person", async () => {
    const { ctx, db } = makeCtx({
      streams: [stream()],
      sales: { "hubshop:pi_1": sale({ totals: { total_minor: "2500", tax_minor: "380" } }) },
    })
    expect(await onSaleEvent(event("hubshop", "pi_1"), ctx)).toMatchObject({ status: "deferred" })
    const parks = (await db.findMany("deferred_events", { limit: 5 })) as Array<
      Record<string, unknown>
    >
    expect(parks[0]).toMatchObject({ reason: "sale_totals_mismatch" })
    expect(await docs(db)).toEqual([])
  })

  test("a consumer buying a digital service needs no street address: the country is printed", async () => {
    const { ctx, db } = makeCtx({
      streams: [stream()],
      sales: {
        "hubshop:pi_1": sale({
          buyer: {
            email: "buyer@example.de",
            name: "Lena Buyer",
            kind: "individual",
            billing: { country: "DE" },
            tax_evidence: { billing_country: "DE", card_country: "DE" },
          },
        }),
      },
    })
    expect((await onSaleEvent(event("hubshop", "pi_1"), ctx)).status).toBe("ok")
    const [doc] = await docs(db)
    expect(doc).toMatchObject({ type: "invoice", grand_total_minor: "2380" })
  })

  test("a company buyer, or a sale of goods, still needs the postal address", async () => {
    const company = makeCtx({
      streams: [stream()],
      sales: {
        "hubshop:pi_1": sale({
          buyer: {
            email: "ap@studio.example.de",
            name: "Jan",
            legal_name: "Studio GmbH",
            kind: "company",
            billing: { country: "DE" },
            tax_evidence: { billing_country: "DE", card_country: "DE" },
          },
        }),
      },
    })
    expect(await onSaleEvent(event("hubshop", "pi_1"), company.ctx)).toMatchObject({
      status: "deferred",
    })
    const goods = makeCtx({
      streams: [stream()],
      sales: {
        "hubshop:pi_1": sale({
          buyer: {
            email: "buyer@example.de",
            name: "Lena Buyer",
            kind: "individual",
            billing: { country: "DE" },
          },
          lines: [
            {
              description: "Controller",
              quantity: "1",
              unit_price_minor: "2000",
              kind: "goods",
              tax: { rate_bp: 1900, amount_minor: "380", reported_by_source: true },
            },
          ],
        }),
      },
    })
    expect(await onSaleEvent(event("hubshop", "pi_1"), goods.ctx)).toMatchObject({
      status: "deferred",
    })
    for (const { db } of [company, goods]) {
      const parks = (await db.findMany("deferred_events", { limit: 5 })) as Array<
        Record<string, unknown>
      >
      expect(parks[0]).toMatchObject({ reason: "counterparty_incomplete" })
      expect(await docs(db)).toEqual([])
    }
  })

  test("a French consumer taxed at 20 % by the source issues at 20 %", async () => {
    const { ctx, db } = makeCtx({
      streams: [stream()],
      sales: {
        "hubshop:pi_1": sale({
          buyer: {
            email: "a@example.fr",
            name: "Alice",
            kind: "individual",
            billing: { line1: "1 rue A", postcode: "75001", city: "Paris", country: "FR" },
            tax_evidence: { billing_country: "FR", card_country: "FR" },
          },
          lines: [
            {
              description: "Sound pack",
              quantity: "1",
              unit_price_minor: "6703",
              discount_minor: "6033",
              kind: "service",
              tax: { rate_bp: 2000, amount_minor: "134", reported_by_source: true },
            },
          ],
          totals: { total_minor: "804", subtotal_minor: "670", tax_minor: "134" },
        }),
      },
    })
    expect((await onSaleEvent(event("hubshop", "pi_1"), ctx)).status).toBe("ok")
    const [doc] = await docs(db)
    expect(doc).toMatchObject({ grand_total_minor: "804", tax_treatment: "eu_domestic" })
  })

  test("a rate the source charged that is not the treatment's standard rate parks for a person", async () => {
    // A French company with its VAT number is domestic B2B at 20 %: a 0 % sale is never issued as is.
    const fr = makeCtx({
      streams: [stream()],
      sales: {
        "hubshop:pi_1": sale({
          buyer: {
            email: "ap@example.fr",
            name: "Paul",
            legal_name: "Studio SAS",
            kind: "company",
            vat_id: "FR40303265045",
            billing: { line1: "1 rue A", postcode: "75001", city: "Paris", country: "FR" },
          },
          lines: [
            {
              description: "Sound pack",
              quantity: "1",
              unit_price_minor: "2000",
              kind: "service",
              tax: { rate_bp: 0, amount_minor: "0", reported_by_source: true },
            },
          ],
          totals: { total_minor: "2000", subtotal_minor: "2000", tax_minor: "0" },
        }),
      },
    })
    // A consumer in Poland (OSS) charged the German rate.
    const pl = makeCtx({
      streams: [stream()],
      sales: {
        "hubshop:pi_1": sale({
          buyer: {
            email: "p@example.pl",
            name: "Piotr",
            kind: "individual",
            billing: { line1: "ul. 1", postcode: "00-001", city: "Warszawa", country: "PL" },
          },
        }),
      },
    })
    for (const { ctx, db } of [fr, pl]) {
      expect(await onSaleEvent(event("hubshop", "pi_1"), ctx)).toMatchObject({ status: "deferred" })
      const parks = (await db.findMany("deferred_events", { limit: 5 })) as Array<
        Record<string, unknown>
      >
      expect(parks[0]).toMatchObject({ reason: "sale_tax_rate_mismatch" })
      expect(await docs(db)).toEqual([])
    }
  })

  test("an auto stream's sale issues with no card, whatever the issuer's approval threshold", async () => {
    const { ctx, db, approvals } = makeCtx({
      streams: [stream({ mode: "auto" })],
      sales: { "hubshop:pi_1": sale() },
      issuer: { invoice_approval_threshold_minor: "100" },
    })
    expect((await onSaleEvent(event("hubshop", "pi_1"), ctx)).status).toBe("ok")
    expect(approvals).toEqual([])
    expect(await docs(db)).toHaveLength(1)
  })

  test("the invoice's total must be the source's: a gap at issue refuses the sale", async () => {
    // Within the one-unit-per-line tolerance of the lines check (999 + 190 against 1190), but the
    // invoice would total 1189 where the buyer paid 1190: never issued with a cent of difference.
    const { ctx, db } = makeCtx({
      streams: [stream()],
      sales: {
        "hubshop:pi_1": sale({
          lines: [
            {
              description: "Sound pack",
              quantity: "3",
              unit_price_minor: "333",
              kind: "service",
              tax: { rate_bp: 1900, amount_minor: "190", reported_by_source: true },
            },
          ],
          totals: { total_minor: "1190", subtotal_minor: "999", tax_minor: "190" },
        }),
      },
    })
    expect(await onSaleEvent(event("hubshop", "pi_1"), ctx)).toMatchObject({ status: "deferred" })
    expect(await docs(db)).toEqual([])
  })

  test("an inclusive line issues with the source's own tax, so the invoice totals what was paid", async () => {
    // Paid 0.99 including 20 %: Stripe's tax 0.17, net 0.82. 0.82 at 20 % recomputes to 0.16
    // (0.98 in all), and no net in cents gives 0.99: the tax charged is the line's tax.
    const { ctx, db } = makeCtx({
      streams: [stream()],
      sales: {
        "hubshop:pi_1": sale({
          buyer: {
            email: "a@example.fr",
            name: "Alice",
            kind: "individual",
            billing: { country: "FR" },
            tax_evidence: { billing_country: "FR", card_country: "FR" },
          },
          lines: [
            {
              description: "Preset",
              quantity: "1",
              unit_price_minor: "825",
              discount_minor: "743",
              kind: "service",
              tax: { rate_bp: 2000, amount_minor: "17", reported_by_source: true },
            },
          ],
          totals: { total_minor: "99", subtotal_minor: "82", tax_minor: "17" },
        }),
      },
    })
    expect((await onSaleEvent(event("hubshop", "pi_1"), ctx)).status).toBe("ok")
    const [doc] = await docs(db)
    expect(doc).toMatchObject({
      subtotal_minor: "82",
      tax_total_minor: "17",
      grand_total_minor: "99",
    })
    const lines = (await db.findMany("document_lines", { limit: 5 })) as Array<
      Record<string, unknown>
    >
    expect(lines[0]).toMatchObject({ tax_rate_bp: 2000, tax_minor: "17", total_minor: "99" })
  })

  test("a review stream asks a person; the approval re-reads the sale and issues it", async () => {
    const s = { "hubshop:pi_1": sale() }
    const first = makeCtx({ streams: [stream({ mode: "review" })], sales: s })
    const r = await onSaleEvent(event("hubshop", "pi_1"), first.ctx)
    expect(r.status).toBe("pending_approval")
    expect(first.approvals).toEqual([
      {
        tool_name: "invoicing:revenue_stream_sale_issue",
        current_payload: {
          kind: "revenue_stream_sale",
          stream_id: "stream-1",
          external_id: "pi_1",
        },
      },
    ])
    expect(await docs(first.db)).toEqual([])
    const approved = makeCtx({
      streams: [stream({ mode: "review" })],
      sales: s,
      approval: { approvalRequestId: "a-1", approvalDeciderId: "user-2", toolName: "x" },
    })
    const r2 = await onSaleApproved(first.approvals[0]!.current_payload as never, approved.ctx)
    expect(r2.status).toBe("ok")
    expect(await docs(approved.db)).toHaveLength(1)
  })

  test("a Stripe sale claims its payment, charge and checkout names with its invoice", async () => {
    const { ctx, db } = makeCtx({
      streams: [stream({ provider_app: "stripe" })],
      sales: { "stripe:pi_1": sale() },
    })
    expect((await onSaleEvent(event("stripe", "pi_1"), ctx)).status).toBe("ok")
    const [doc] = await docs(db)
    expect(doc?.external_ref).toBe("stripe:pi_1:software")
    const claims = (await db.findMany("stripe_sales", { limit: 10 })) as Array<
      Record<string, unknown>
    >
    expect(claims.map((c) => c.key).sort()).toEqual(["stripe:ch_1", "stripe:cs_1", "stripe:pi_1"])
    expect(claims.every((c) => c.document_id === doc?.id)).toBe(true)
    // The buyer's side knows the sale by its PaymentIntent, never by the Checkout Session.
    const ledger = (await db.findMany("sales", { limit: 5 })) as Array<Record<string, unknown>>
    expect(ledger[0]).toMatchObject({ stream: "stripe", external_id: "pi_1", source_ref: "pi_1" })
  })

  test("a Stripe sale already invoiced under its charge (by hand) is not invoiced again", async () => {
    const { ctx, db } = makeCtx({
      streams: [stream({ provider_app: "stripe" })],
      sales: { "stripe:pi_1": sale() },
    })
    await db.insert("documents", {
      type: "invoice",
      number: "INV-2026-0001",
      external_ref: "stripe:ch_1",
      scope: null,
      grand_total_minor: "2380",
    })
    expect(await onSaleEvent(event("stripe", "pi_1"), ctx)).toEqual({
      status: "skipped",
      reason: "duplicate_document",
    })
    expect(await docs(db)).toHaveLength(1)
  })

  test("the shop's first sale creates its stream and issues through the order flow", async () => {
    const { ctx, db } = makeCtx({
      sales: {
        "shopify:7001": sale({
          external_id: "7001",
          refs: { order_name: "#7001", account: "shop.myshopify.com" },
          lines: [
            {
              description: "Widget",
              quantity: "1",
              unit_price_minor: "2000",
              kind: "goods",
              variant_ref: "gid://shopify/ProductVariant/1",
              tax: { rate_bp: 1900, amount_minor: "380", line_count: 1, reported_by_source: true },
            },
          ],
          buyer: { ...sale().buyer, customer_id: "c-1", ids: { shopify_customer_id: "c-1" } },
        }),
      },
    })
    await db.update("issuer_profiles", "issuer-1", { shopify_shop_id: "shop.myshopify.com" })
    const r = await onSaleEvent(event("shopify", "7001"), ctx)
    expect(r.status).toBe("ok")
    const streams = (await db.findMany("revenue_streams", { limit: 5 })) as Array<
      Record<string, unknown>
    >
    expect(streams).toHaveLength(1)
    expect(streams[0]).toMatchObject({ provider_app: "shopify", mode: "auto", issue_from: null })
    const [doc] = await docs(db)
    expect(doc).toMatchObject({ external_ref: "shopify-order:7001:goods" })
    expect((doc?.external_refs as Record<string, unknown> | undefined)?.shopify_order_id).toBe(
      "7001",
    )
  })
})

describe("French overseas VAT on a revenue-stream sale (DOM-TOM)", () => {
  const reunion = (over: Partial<Sale> = {}) =>
    sale({
      buyer: {
        email: "marie@example.re",
        name: "Marie Hoarau",
        kind: "individual",
        billing: { line1: "5 rue de Paris", postcode: "97400", city: "Saint-Denis", country: "RE" },
        tax_evidence: { billing_country: "RE", ip_country: "RE" },
      },
      // Stripe Tax computes nothing for La Réunion: the line carries no tax.
      lines: [
        { description: "Sound pack", quantity: "1", unit_price_minor: "10850", kind: "service" },
      ],
      totals: { total_minor: "10850", subtotal_minor: "10850", tax_minor: "0" },
      ...over,
    })

  test("a Réunion consumer's untaxed digital sale, tax-inclusive prices: 8.5 % extracted, total = what was paid", async () => {
    const { ctx, db } = makeCtx({
      streams: [stream()],
      sales: { "hubshop:pi_1": reunion() },
      issuer: { prices_include_tax: true },
    })
    expect(await onSaleEvent(event("hubshop", "pi_1"), ctx)).toMatchObject({ status: "ok" })
    const [doc] = await docs(db)
    expect(doc).toMatchObject({ tax_treatment: "eu_domestic" })
    expect(String(doc?.subtotal_minor)).toBe("10000")
    expect(String(doc?.tax_total_minor)).toBe("850")
    expect(String(doc?.grand_total_minor)).toBe("10850")
  })

  test("the same sale with tax-exclusive prices parks: the buyer paid no VAT on top", async () => {
    const { ctx, db } = makeCtx({ streams: [stream()], sales: { "hubshop:pi_1": reunion() } })
    expect(await onSaleEvent(event("hubshop", "pi_1"), ctx)).toMatchObject({ status: "deferred" })
    const parks = (await db.findMany("deferred_events", { limit: 5 })) as Array<
      Record<string, unknown>
    >
    expect(parks[0]).toMatchObject({ reason: "overseas_tax_not_collected" })
    expect(await docs(db)).toEqual([])
  })

  test("a source that charged another rate to La Réunion parks as a mismatch", async () => {
    const { ctx, db } = makeCtx({
      streams: [stream()],
      sales: {
        "hubshop:pi_1": reunion({
          lines: [
            {
              description: "Sound pack",
              quantity: "1",
              unit_price_minor: "10000",
              kind: "service",
              tax: { rate_bp: 2000, amount_minor: "2000", reported_by_source: true },
            },
          ],
          totals: { total_minor: "12000", subtotal_minor: "10000", tax_minor: "2000" },
        }),
      },
      issuer: { prices_include_tax: true },
    })
    expect(await onSaleEvent(event("hubshop", "pi_1"), ctx)).toMatchObject({ status: "deferred" })
    const parks = (await db.findMany("deferred_events", { limit: 5 })) as Array<
      Record<string, unknown>
    >
    expect(parks[0]).toMatchObject({ reason: "overseas_tax_mismatch" })
  })
})
