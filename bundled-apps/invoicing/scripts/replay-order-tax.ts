// SPDX-License-Identifier: FSL-1.1-ALv2
//
// READ ONLY replay of a real Shopify order through the CURRENT order-paid computation.
//
// Feeds a stored `shopify/order:created` (or `order:updated`) event through
// `onShopifyOrderCreated` against an IN MEMORY database with offline stubs: nothing is written
// anywhere, no number is allocated in any real sequence, no PDF is stored, no mail is sent, no
// Shopify call is made. It prints what the code would do with that order today: each line's
// Shopify tax facts, the per line tax check, and either the park reason or the documents it
// would issue (totals, tax treatment, printed country, tax country).
//
// Usage (from bundled-apps/invoicing):
//   bun scripts/replay-order-tax.ts <event.json> [issuerCountry=FR]
//   cat event.json | bun scripts/replay-order-tax.ts - [issuerCountry]
// The JSON is either the event envelope ({ entity, action, data, ... }) or its `data` object, as
// stored in kernel.pending_events.payload, OR a Shopify Admin GraphQL `Order` node (detected by its
// `legacyResourceId`), converted below to the shape the shopify app's orders/create webhook emits.

import { readFileSync } from "node:fs"
import {
  adaptShopifyOrderCreatedEvent,
  type OrderPaidCtx,
  onShopifyOrderCreated,
  shopifyTaxMismatches,
} from "../src/handlers/shopify-order-paid"
import { createMockDb } from "../src/test-db"
import { testTime } from "../src/test-time"

const [, , file = "-", issuerCountry = "FR"] = process.argv
const raw = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8")
const parsed = JSON.parse(raw) as Record<string, unknown>
const event = (
  "legacyResourceId" in parsed ? eventFromAdminOrder(parsed) : (parsed.data ?? parsed)
) as Record<string, unknown>
const shopId = String(event.shopDomain ?? "replay-shop")

const db = createMockDb({
  seed: {
    issuer_profiles: [
      {
        id: "replay-issuer",
        legal_name: "Replay issuer",
        country: issuerCountry,
        vat_id: null,
        address: "Replay",
        default_language: "en",
        prefix_invoice: "REPLAY-",
        invoice_approval_threshold_minor: null,
        auto_email_enabled: false,
        shopify_shop_id: shopId,
      },
    ],
  },
})

let seq = 0
const ctx: OrderPaidCtx = {
  getUserId: async () => "replay",
  approval: null,
  db,
  time: testTime(),
  pdf: { render: async () => ({ file_id: `replay-pdf-${++seq}`, byte_size: 0, page_count: 1 }) },
  messages: { post: async () => ({ message_id: "replay" }) },
  // Offline: no enrichment, no customs fetch, no mail.
  executeTool: async (name) =>
    name === "shopify:orders_get"
      ? { status: "completed", result: null }
      : { status: "completed", result: {} },
  requestApproval: async () => ({ approval_id: "replay-approval" }),
  resolveContact: async () => ({ id: "replay-contact" }),
}

const payload = adaptShopifyOrderCreatedEvent(event as never)
console.log(`order ${payload.order_number ?? payload.id} (${payload.currency})`)
console.log(
  `billing country ${payload.customer?.country ?? "-"}, tax country ${payload.customer?.tax_country ?? "-"}, buyer VAT id ${payload.customer?.vat_id ?? "-"}`,
)
for (const li of payload.line_items) {
  console.log(
    `  [${li.line_kind}] ${li.description}: net ${li.unit_price_minor} x ${li.quantity}, rate_bp ${li.tax_rate_bp ?? "classifier"}, shopify seller tax ${li.shopify_tax_minor ?? "-"}, marketplace tax ${li.marketplace_tax_minor ?? "0"}`,
  )
}
const mismatches = shopifyTaxMismatches(payload.line_items)
console.log(`per line tax check: ${mismatches.length === 0 ? "ok" : JSON.stringify(mismatches)}`)

const result = await onShopifyOrderCreated(event as never, ctx)
if (result.status === "deferred") {
  const park = (db.__all("deferred_events") as Array<Record<string, unknown>>).at(-1)
  console.log(`WOULD PARK: ${park?.reason} ${JSON.stringify(park?.blocked_on)}`)
} else if (result.status === "ok") {
  for (const d of db.__all("documents") as Array<Record<string, unknown>>) {
    const refs = (d.external_refs ?? {}) as Record<string, unknown>
    console.log(
      `WOULD ISSUE ${d.scope}: subtotal ${d.subtotal_minor} tax ${d.tax_total_minor} total ${d.grand_total_minor} ${d.currency}, ${d.tax_treatment}, printed country ${d.counterparty_country}, tax country ${refs.tax_country ?? d.counterparty_country}, marketplace tax ${refs.marketplace_tax_minor ?? "0"}`,
    )
  }
} else {
  console.log(`result: ${JSON.stringify(result)}`)
}

// ── Admin GraphQL Order node -> order:created event (mirrors shopify webhooks.ts normalizeOrder) ──

type Money = { presentmentMoney?: { amount?: string; currencyCode?: string } } | null | undefined
function money(m: Money, fallbackCurrency: string) {
  return {
    amount: String(m?.presentmentMoney?.amount ?? "0"),
    currencyCode: m?.presentmentMoney?.currencyCode ?? fallbackCurrency,
  }
}
function address(a: Record<string, unknown> | null | undefined) {
  if (!a) return null
  return {
    name: a.name ?? null,
    company: a.company ?? null,
    address1: a.address1 ?? null,
    address2: a.address2 ?? null,
    zip: a.zip ?? null,
    city: a.city ?? null,
    province: a.province ?? null,
    country_code: a.countryCodeV2 ?? null,
  }
}
function taxIdKeys(): Set<string> {
  return new Set([
    "vat",
    "vatid",
    "vatnumber",
    "vatno",
    "vatnr",
    "vatregistrationnumber",
    "vattaxid",
    "taxid",
    "taxnumber",
    "tva",
    "ntva",
    "numerotva",
    "numerodetva",
    "ustid",
    "ustidnr",
    "partitaiva",
    "piva",
    "nif",
    "cif",
    "nifcif",
  ])
}
function taxLines(tls: Array<Record<string, unknown>> | undefined, currency: string) {
  return (tls ?? []).map((t) => ({
    title: t.title ?? null,
    rate: typeof t.rate === "number" ? t.rate : null,
    ...money(t.priceSet as Money, currency),
    channelLiable: typeof t.channelLiable === "boolean" ? t.channelLiable : null,
  }))
}
function eventFromAdminOrder(o: Record<string, any>): Record<string, unknown> {
  const currency = o.totalPriceSet?.presentmentMoney?.currencyCode ?? "USD"
  const country =
    o.shippingAddress?.countryCodeV2 ??
    o.customer?.defaultAddress?.countryCodeV2 ??
    o.billingAddress?.countryCodeV2 ??
    null
  const attr = (o.customAttributes ?? []).find(
    (a: { key?: string; value?: string }) =>
      taxIdKeys().has(
        String(a.key ?? "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, ""),
      ) && String(a.value ?? "").trim() !== "",
  )
  return {
    orderId: String(o.legacyResourceId),
    name: o.name,
    shopDomain: "replay-shop",
    createdAt: o.createdAt,
    // The order was paid when it was created (what the webhook carried then).
    financialStatus: "paid",
    poNumber: o.poNumber ?? null,
    buyerTaxId: attr ? String(attr.value).trim() : null,
    totalPrice: money(o.totalPriceSet, currency),
    taxesIncluded: o.taxesIncluded === true,
    billingAddress: address(o.billingAddress),
    shippingAddress: address(o.shippingAddress),
    customer: o.customer
      ? {
          id: String(o.customer.legacyResourceId),
          email: o.customer.email ?? "replay@example.com",
          first_name: o.customer.firstName ?? null,
          last_name: o.customer.lastName ?? null,
          country,
        }
      : { id: "guest", email: "replay@example.com", first_name: "Guest", last_name: null, country },
    lineItems: (o.lineItems?.nodes ?? []).map((li: any) => ({
      id: String(li.id),
      title: li.title,
      quantity: li.quantity,
      priceSet: money(li.originalUnitPriceSet, currency),
      requiresShipping: li.requiresShipping !== false,
      taxLines: taxLines(li.taxLines, currency),
      discountAllocations: (li.discountAllocations ?? []).map((d: any) =>
        money(d.allocatedAmountSet, currency),
      ),
      variant: { id: li.variant?.legacyResourceId ?? null },
    })),
    shippingLines: (o.shippingLines?.nodes ?? []).map((sl: any) => ({
      title: sl.title,
      priceSet: money(sl.discountedPriceSet, currency),
      taxLines: taxLines(sl.taxLines, currency),
    })),
  }
}
