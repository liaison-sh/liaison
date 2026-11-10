// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shopify mutation tools: draft-order input normalisation (buyer email, mailing
// addresses, applied discounts, line items and shipping requirement) for the draft-order
// create and update tools.

import type { AppContext } from "@liaison/app-sdk"
import { getShopifyClient } from "../lib/get-client"
import { toCountryCode, toProvinceCode } from "../lib/address-aliases"
import { type ShopClient, isRec, makeMutationError, gidFrom } from "./shared"
import {
  type B2bContext,
  type PriceException,
  type VerifiedCompanyBuyer,
  cleanPurchasingCompany,
  companyAddressToMailingInput,
  companyRequiredError,
  noCatalogPriceError,
  nonCatalogPriceFields,
  parsePriceException,
  priceNotCatalogError,
  readLocationCatalogs,
  rememberVerifiedBuyer,
  resolveB2bContext,
  variantsWithFixedCatalogPrice,
  verifyPurchasingCompany,
  withPriceExceptionAttribute,
} from "./draft-order-b2b"

// The authoritative DraftOrderInput / DraftOrderLineItemInput field sets (Shopify Admin API
// 2026-01, from schema introspection). A weak model invents fields outside these — `customer`,
// `customerId`, `lineItemsDiscount`, `currencyCode`, `user_id` on the input; `price`, `productId`,
// `id` on a line — so the gated draftOrderCreate 422s. We MAP the known aliases (below) then STRIP
// anything still outside the allowlist, so an unknown/hallucinated field can never reach Shopify.
const DRAFT_ORDER_INPUT_FIELDS = new Set([
  "acceptAutomaticDiscounts", "allowDiscountCodesInCheckout", "appliedDiscount", "billingAddress",
  "customAttributes", "discountCodes", "email", "lineItems", "localizedFields", "metafields",
  "note", "paymentTerms", "phone", "poNumber", "presentmentCurrencyCode", "purchasingEntity",
  "reserveInventoryUntil", "sessionToken", "shippingAddress", "shippingLine", "sourceName", "tags",
  "taxExempt", "transformerFingerprint", "useCustomerDefaultAddress", "visibleToCustomer",
])
const DRAFT_ORDER_LINE_FIELDS = new Set([
  "appliedDiscount", "components", "customAttributes", "generatePriceOverride",
  "originalUnitPriceWithCurrency", "priceOverride", "quantity", "requiresShipping", "sku",
  "taxable", "title", "uuid", "variantId", "weight",
])

function stripToAllowlist(obj: Record<string, unknown>, allow: Set<string>): void {
  for (const k of Object.keys(obj)) if (!allow.has(k)) delete obj[k]
}

// Shopify rejects emails on reserved, non-deliverable TLDs ("Email contains an invalid domain
// name"). The chaos seed's fictional customers use `*.example` addresses (the privacy convention),
// so the weak agent copies one onto a draft and the gated create 422s. A quote needs no email, so
// we drop an unusable one (and any email when the customer is already linked).
const RESERVED_EMAIL_TLDS = new Set(["example", "invalid", "test", "localhost", "local"])
// RFC 2606 reserved SECOND-level domains: deliverable-looking (TLD is `.com/.net/.org`) but they
// never resolve, so Shopify draftOrderCreate / draftOrderInvoiceSend 422 "Email contains an invalid
// domain name". The seed/world uses `*.example` addresses; a weak model sometimes appends `.com`
// (→ `…example.com`, a subdomain of the reserved example.com) — caught here too. (BL-129.)
const RESERVED_EMAIL_DOMAINS = ["example.com", "example.net", "example.org"]
export function isUsableEmail(v: unknown): boolean {
  if (typeof v !== "string") return false
  const m = v.match(/^[^@\s]+@([^@\s]+\.([^@\s.]+))$/)
  if (!m) return false
  const domain = (m[1] ?? "").toLowerCase()
  if (RESERVED_EMAIL_TLDS.has((m[2] ?? "").toLowerCase())) return false
  if (RESERVED_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return false
  return true
}

// EmailInput (draftOrderInvoiceSend) accepts {to, from, subject, customMessage, bcc, body} — NOT
// `address`/`email`, which the weak model invents.
const EMAIL_INPUT_FIELDS = new Set(["to", "from", "subject", "customMessage", "bcc", "body"])

/** Normalise a draftOrderInvoiceSend EmailInput a weak model malforms: map a misnamed recipient
 *  (`address`/`email`/`recipient`) to `to`, allowlist-strip unknown fields, and drop an unusable
 *  `to`. Returns null when nothing usable remains → draftOrderInvoiceSend then emails the customer
 *  on the draft (the safe default). */
export function normalizeEmailInput(v: unknown): Record<string, unknown> | null {
  if (!isRec(v)) return null
  const e: Record<string, unknown> = { ...v }
  if (e.to == null) {
    const alt = e.address ?? e.email ?? e.recipient
    if (typeof alt === "string") e.to = alt
  }
  if (e.to != null && !isUsableEmail(e.to)) delete e.to
  stripToAllowlist(e, EMAIL_INPUT_FIELDS)
  // An EmailInput WITHOUT a usable `to` is invalid — Shopify rejects it "To can't be blank" even when
  // it still carries subject/customMessage/body. So if no usable recipient survives, drop the WHOLE
  // input (return null) → draftOrderInvoiceSend falls back to emailing the draft's customer (the safe
  // default), instead of sending a recipient-less EmailInput. (BL-137: dealer-volume's agent passes a
  // {subject, customMessage} EmailInput with a blank/missing `to`, which previously slipped through.)
  if (typeof e.to !== "string" || e.to.length === 0) return null
  return Object.keys(e).length > 0 ? e : null
}

// MailingAddressInput (shipping/billing) accepts only these. A weak model invents `name` (one
// string — the field is firstName/lastName, so it 422s "Field is not defined on MailingAddressInput"),
// `street`, `state`, `postalCode`, etc. Map the obvious aliases, then STRIP the rest — same philosophy
// as DRAFT_ORDER_INPUT_FIELDS. A draft QUOTE needs no address, so over-stripping is harmless and an
// invented field can never reach Shopify.
const MAILING_ADDRESS_FIELDS = new Set([
  "address1", "address2", "city", "company", "countryCode",
  "firstName", "lastName", "phone", "provinceCode", "zip",
])
/** Normalise a MailingAddressInput a weak model malforms (the observed 422 is a single `name`).
 *  Returns undefined if nothing usable remains → the caller drops the address (a quote needs none). */
function normaliseMailingAddress(v: unknown): Record<string, unknown> | undefined {
  if (!isRec(v)) return undefined
  const a: Record<string, unknown> = { ...v }
  if (typeof a.name === "string" && a.firstName == null && a.lastName == null) {
    const parts = a.name.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 1) a.firstName = parts[0]
    else if (parts.length > 1) {
      a.firstName = parts.slice(0, -1).join(" ")
      a.lastName = parts[parts.length - 1]
    }
  }
  if (a.address1 == null && typeof a.street === "string") a.address1 = a.street
  if (a.address1 == null && typeof a.line1 === "string") a.address1 = a.line1
  if (a.address2 == null && typeof a.line2 === "string") a.address2 = a.line2
  if (a.zip == null) {
    // Assign only when there is something to assign: writing `undefined` still
    // creates the key, and the "nothing usable left" check below counts keys.
    const zip = a.postalCode ?? a.postal_code ?? a.zipCode ?? a.zip_code
    if (zip != null) a.zip = zip
  }
  // Country/province arrive as HUMAN text far more often than as ISO codes: a
  // Shopify order read renders `country: "United States"`, and an agent copying
  // an address across hands the mutation exactly that. The allowlist strip below
  // used to drop it, leaving no `countryCode` at all, and the physical-goods
  // guard then refused a draft whose address was in fact complete
  // (ticket-10280). Fold the aliases onto the codes first; an unrecognised
  // country still resolves to nothing, so the guard keeps its teeth.
  const countryCode = (text(a.countryCode) && toCountryCode(a.countryCode)) ||
    toCountryCode(a.country ?? a.countryCodeV2 ?? a.country_code)
  if (countryCode) a.countryCode = countryCode
  const provinceCode =
    (text(a.provinceCode) && toProvinceCode(a.provinceCode, countryCode)) ||
    toProvinceCode(a.province ?? a.state ?? a.province_code ?? a.region, countryCode)
  if (provinceCode) a.provinceCode = provinceCode
  stripToAllowlist(a, MAILING_ADDRESS_FIELDS)
  return Object.keys(a).length > 0 ? a : undefined
}

function text(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t === "" ? null : t
}

/** Canonicalise a DraftOrderAppliedDiscountInput a weak model may shape as {percentage}/{amount}
 *  or {value} with no valueType. valueType is the Shopify enum PERCENTAGE | FIXED_AMOUNT. */
function normaliseAppliedDiscount(v: unknown): Record<string, unknown> | undefined {
  if (!isRec(v)) return undefined
  const d: Record<string, unknown> = { ...v }
  if (d.percentage != null && d.value == null) {
    d.value = d.percentage
    d.valueType ??= "PERCENTAGE"
    delete d.percentage
  }
  if (d.amount != null && d.value == null) {
    d.value = d.amount
    d.valueType ??= "FIXED_AMOUNT"
    delete d.amount
  }
  if (d.value != null && d.valueType == null) {
    const n = Number(d.value)
    d.valueType = Number.isFinite(n) && n <= 100 ? "PERCENTAGE" : "FIXED_AMOUNT"
  }
  if (typeof d.value === "string") {
    const n = Number(d.value)
    if (Number.isFinite(n)) d.value = n
  }
  d.title ??= "Discount"
  return d
}

/** Canonical comparison of two already-normalised appliedDiscounts by their MONEY semantics
 *  (valueType + numeric value). Title is intentionally ignored — two lines bearing the SAME 20%
 *  with different titles ("EDU" vs "Discount") are still one whole-order discount. */
function sameDiscountValue(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return a.valueType === b.valueType && Number(a.value) === Number(b.value)
}

/** A WHOLE-ORDER discount on a multi-line draft must live at the order level (Shopify's API
 *  rejects an inconsistent per-line discount on a multi-line draft with a 422 "Record is invalid",
 *  and the order-level placement is the canonical shape a quote review/approval reads). A weak model
 *  routinely expresses a single flat % off the whole order as a per-line `appliedDiscount` — either
 *  on every line identically, or (worse) on just ONE line of a multi-line order. Both are the SAME
 *  intent: one discount across the order. So when a MULTI-line draft carries NO order-level discount
 *  and the per-line discounts present are all the SAME value (exactly one distinct discount across
 *  the lines), LIFT it to the order level and strip it from the lines.
 *
 *  Scope guards (so a genuine per-line tier is never clobbered):
 *   - MULTI-line only — a single-line draft keeps its per-line discount (one line IS the whole order
 *     anyway; and `draft_orders_update`'s per-line round-trip, BL-04, stays intact since this only
 *     runs on the CREATE path).
 *   - Exactly ONE distinct discount value — a mixed order with DIFFERENT per-line discounts (a real
 *     per-line tier, e.g. a volume price on the instrument line only alongside a differently-priced
 *     accessory) has >1 distinct value and is left untouched.
 */
function promoteUniformLineDiscountToOrderLevel(input: Record<string, unknown>): void {
  if (input.appliedDiscount != null) return // an order-level discount already wins
  if (!Array.isArray(input.lineItems) || input.lineItems.length < 2) return
  const lineDiscounts: Record<string, unknown>[] = []
  for (const li of input.lineItems) {
    if (isRec(li) && isRec(li.appliedDiscount)) lineDiscounts.push(li.appliedDiscount)
  }
  const first = lineDiscounts[0]
  if (first == null) return
  if (!lineDiscounts.every((d) => sameDiscountValue(d, first))) return // genuine per-line tiers → leave
  // One uniform discount across the lines == a whole-order discount. Promote it.
  input.appliedDiscount = { ...first }
  for (const li of input.lineItems) {
    if (isRec(li)) delete li.appliedDiscount
  }
}

async function lookupGidTitle(client: ShopClient, gid: string): Promise<string | undefined> {
  try {
    const data = await client.query<{ node?: { title?: string; product?: { title?: string } } }>(
      `query($id: ID!){ node(id:$id){ ... on Product { title } ... on ProductVariant { title product { title } } } }`,
      { id: gid },
    )
    return data.node?.product?.title ?? data.node?.title ?? undefined
  } catch {
    return undefined
  }
}

async function resolveDefaultVariantId(client: ShopClient, productGid: string): Promise<string | undefined> {
  try {
    const data = await client.query<{ product?: { variants?: { nodes?: Array<{ id: string }> } } }>(
      `query($id: ID!){ product(id:$id){ variants(first:1){ nodes{ id } } } }`,
      { id: productGid },
    )
    return data.product?.variants?.nodes?.[0]?.id
  } catch {
    return undefined
  }
}

async function shopCurrencyCode(client: ShopClient): Promise<string> {
  try {
    const data = await client.query<{ shop?: { currencyCode?: string } }>(`query{ shop{ currencyCode } }`)
    return data.shop?.currencyCode ?? "EUR"
  } catch {
    return "EUR"
  }
}

async function lookupVariantPrice(client: ShopClient, variantGid: string): Promise<number | null> {
  try {
    const data = await client.query<{ node?: { price?: string } }>(
      `query($id: ID!){ node(id:$id){ ... on ProductVariant { price } } }`,
      { id: variantGid },
    )
    const p = data.node?.price
    const n = p != null ? Number(p) : Number.NaN
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

// A line is DIGITAL when its variant does not require shipping (license keys, downloads) and PHYSICAL
// otherwise — the same seam the order webhook uses (`requires_shipping !== false`). Batches every
// variant of a draft into ONE `nodes(ids:)` query (not one per line) so the buyer-identity guard costs
// a single round-trip. The flag lives on `inventoryItem.requiresShipping` — the variant-level
// `ProductVariant.requiresShipping` field was REMOVED from the Admin API, so selecting it errors the
// whole query, the catch swallowed it, and EVERY line silently defaulted to physical (the guard then
// demanded a shipping address for a digital license — the bug that wedged a live approval). Variants
// that don't resolve are simply absent from the map (caller defaults them to physical: we would rather
// demand an address than silently ship blind).
async function variantsRequireShipping(client: ShopClient, variantGids: string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  const ids = [...new Set(variantGids)]
  if (ids.length === 0) return out
  try {
    const data = await client.query<{
      nodes?: Array<{ id?: string; inventoryItem?: { requiresShipping?: boolean } | null } | null>
    }>(
      `query($ids: [ID!]!){ nodes(ids: $ids){ ... on ProductVariant { id inventoryItem { requiresShipping } } } }`,
      { ids },
    )
    for (const n of data.nodes ?? []) {
      if (n && typeof n.id === "string" && typeof n.inventoryItem?.requiresShipping === "boolean")
        out.set(n.id, n.inventoryItem.requiresShipping)
    }
  } catch {
    // leave unknown → caller treats as physical
  }
  return out
}

/** Whether a single draft line ships a physical good. An explicit `requiresShipping` on the line wins;
 *  otherwise the pre-fetched variant map decides; unknown → true (physical). */
function lineIsPhysical(li: unknown, shipMap: Map<string, boolean>): boolean {
  if (isRec(li)) {
    if (typeof li.requiresShipping === "boolean") return li.requiresShipping
    if (typeof li.variantId === "string") {
      const r = shipMap.get(li.variantId)
      if (typeof r === "boolean") return r
    }
  }
  return true
}

/** A MoneyInput from an agent's priceOverride: a number/string amount, or {amount, currencyCode}. */
async function toMoneyInput(v: unknown, getCurrency: () => Promise<string>): Promise<Record<string, unknown> | undefined> {
  const amountRaw = isRec(v) ? v.amount : v
  const n = Number(amountRaw)
  if (amountRaw == null || amountRaw === "" || !Number.isFinite(n) || n < 0) return undefined
  const currency = isRec(v) && typeof v.currencyCode === "string" && v.currencyCode.trim() !== "" ? v.currencyCode.trim().toUpperCase() : await getCurrency()
  return { amount: String(amountRaw), currencyCode: currency }
}

async function normaliseDraftOrderLine(
  li: unknown,
  client: ShopClient,
  getCurrency: () => Promise<string>,
  pricing: { b2b: boolean; exception: PriceException | undefined } = { b2b: false, exception: undefined },
): Promise<unknown> {
  if (!isRec(li)) return li
  const l: Record<string, unknown> = { ...li }
  delete l.priceException

  // `productId` is NOT a DraftOrderLineItemInput field — resolve to a variant gid FIRST (before the
  // price handling below) so a catalog line that also carries a bogus per-unit price keeps its
  // variant link instead of degrading to a variant-less custom line.
  if (l.variantId == null && l.productId != null) {
    const g = String(l.productId)
    if (g.includes("/ProductVariant/")) l.variantId = g
    else if (g.includes("/Product/")) {
      const v = await resolveDefaultVariantId(client, g)
      // REFUSE an unresolvable catalog gid rather than dropping the link. Falling through here left
      // the line with no variantId, and the price branch below then rewrote it as a variant-less
      // CUSTOM line: the draft that executed was not the draft the human approved (a different item,
      // no SKU, no stock decrement). A gated call must not be parked for a human on data that does
      // not resolve, so this throws and the stage-time preflight turns it into a clean refusal.
      if (!v)
        throw makeMutationError(
          "VARIANT_UNRESOLVED",
          `draft order line: the product ${g} has no resolvable variant, so this line cannot be a catalog line. ` +
            "Re-resolve the product with products_search / variants_search and pass a real variantId, or drop the product id and send a deliberate custom line (title + price).",
        )
      l.variantId = v
    }
  }
  delete l.productId

  // `price`/`unitPrice` is NOT a DraftOrderLineItemInput field (API 2026-01).
  const priceRaw = l.price ?? l.unitPrice ?? l.unit_price
  const hasRealPrice = l.originalUnitPriceWithCurrency != null || l.originalUnitPrice != null
  if (priceRaw != null && pricing.b2b && l.variantId != null && l.priceOverride == null) {
    // B2B: a line price is NEVER turned into a discount. It reached here only with a
    // priceException (the guard refused it otherwise), so it becomes the line's unit price, with
    // the variant kept: priceOverride sets the price with no discount on the line.
    const money = await toMoneyInput(priceRaw, getCurrency)
    if (!money)
      throw makeMutationError("BAD_PARAM", `draft order line: price ${JSON.stringify(priceRaw)} is not a valid amount.`)
    l.priceOverride = money
    delete l.price
    delete l.unitPrice
    delete l.unit_price
  } else if (priceRaw != null) {
    const priceNum = Number(priceRaw)
    if (pricing.b2b && l.priceOverride != null) {
      // an explicit priceOverride wins over a redundant per-unit price
    } else if (l.appliedDiscount != null) {
      // the agent already expressed the discount correctly — drop the redundant bogus price
    } else if (l.variantId != null && Number.isFinite(priceNum)) {
      // A catalog variant at a custom unit price → express it as a per-line PERCENTAGE appliedDiscount
      // off the variant's LIST price, PRESERVING the real variant (the rubric wants the actual SKU,
      // not a variant-less custom line) and the store currency. Falls back to a custom line only if
      // the list price can't be resolved or the price isn't a discount.
      const listPrice = await lookupVariantPrice(client, String(l.variantId))
      // An UNRESOLVABLE variant gid (no price came back at all) used to fall into the custom-line
      // branch below, which DELETES the variant link: the approved draft and the executed draft
      // disagree. Refuse instead. A resolvable variant priced ABOVE its list price is a genuine
      // markup, not an unresolvable gid, and still degrades to a custom line as before.
      if (listPrice == null)
        throw makeMutationError(
          "VARIANT_UNRESOLVED",
          `draft order line: the variant ${String(l.variantId)} does not resolve in this store, so its price cannot be checked. ` +
            "Re-resolve it with variants_search and pass a real variantId, or drop the variantId and send a deliberate custom line (title + price).",
        )
      if (listPrice > 0 && priceNum < listPrice) {
        const pct = Math.round(((listPrice - priceNum) / listPrice) * 10000) / 100
        l.appliedDiscount = { valueType: "PERCENTAGE", value: pct, title: "Discount" }
      } else if (!hasRealPrice) {
        if (l.title == null)
          l.title = (await lookupGidTitle(client, String(l.variantId))) ?? "Custom item"
        l.originalUnitPriceWithCurrency = { amount: String(priceRaw), currencyCode: await getCurrency() }
        delete l.variantId // can't discount-off-list → custom line carries no variant
      }
    } else if (!hasRealPrice) {
      // No variant at all → honour the exact price as a custom line item.
      if (l.title == null) l.title = "Custom item"
      l.originalUnitPriceWithCurrency = { amount: String(priceRaw), currencyCode: await getCurrency() }
    }
    delete l.price
    delete l.unitPrice
    delete l.unit_price
  }

  if (l.appliedDiscount != null) {
    const d = normaliseAppliedDiscount(l.appliedDiscount)
    if (d) l.appliedDiscount = d
  }
  if (l.priceOverride != null) {
    const money = await toMoneyInput(l.priceOverride, getCurrency)
    if (!money)
      throw makeMutationError(
        "BAD_PARAM",
        `draft order line: priceOverride ${JSON.stringify(l.priceOverride)} is not a valid amount; pass {amount: '120.00', currencyCode: 'EUR'}.`,
      )
    l.priceOverride = money
  }
  // The reason for a non-catalog price travels with the line: the approval card and the order show it.
  if (pricing.exception) l.customAttributes = withPriceExceptionAttribute(l.customAttributes, pricing.exception)
  if (l.quantity != null) {
    const q = Math.trunc(Number(l.quantity))
    if (Number.isFinite(q) && q > 0) l.quantity = q
  }
  // Drop any field still outside the real DraftOrderLineItemInput (e.g. a hallucinated `id`).
  stripToAllowlist(l, DRAFT_ORDER_LINE_FIELDS)
  return l
}

/**
 * Make a weak model's DraftOrderInput API-2026-correct before the gated draftOrderCreate/Update.
 * The agent, drawing on older-API training data, repeatedly sends fields that do not exist in
 * 2026-01 — `customer`, `lineItemsDiscount`, and per-line `price`/`productId` — so the APPROVED
 * write 422s. The manifest already documents the right shape but the weak model ignores it; this
 * maps the common wrong guesses to the real fields so the write succeeds:
 *   customer | customerId → purchasingEntity.customerId
 *   lineItemsDiscount     → appliedDiscount (order-level)
 *   line.productId        → line.variantId (variant gid as-is; product gid → its default variant)
 *   line.price (per-unit) → a custom line item (title + originalUnitPriceWithCurrency), honouring
 *                           the exact computed price; OR, when the line already pairs a variant with
 *                           an appliedDiscount, just drop the bogus price.
 */
export async function normalizeDraftOrderInput(
  rawInput: Record<string, unknown>,
  ctx: AppContext,
  opts?: {
    promoteWholeOrderDiscount?: boolean
    enforceBuyerIdentity?: boolean
    /** Update path: the draft being changed (its current buyer decides whether it is B2B). */
    draftId?: string
  },
): Promise<Record<string, unknown>> {
  const input: Record<string, unknown> = { ...rawInput }

  const custId =
    gidFrom(input.customer) ?? (typeof input.customerId === "string" ? input.customerId : undefined)
  if (custId && input.purchasingEntity == null) input.purchasingEntity = { customerId: custId }
  delete input.customer
  delete input.customerId

  // PurchasingEntityInput accepts ONLY `customerId` (a gid) and `purchasingCompany` — nothing else.
  // The weak model routinely nests a stray `email` (or `id`/`firstName`/…) inside purchasingEntity,
  // which Shopify 422s ("Field is not defined on PurchasingEntityInput") and fails the whole gated
  // draftOrderCreate. Strip it to the two valid fields; if a stray `id`/`customerId` is the only
  // identifier, salvage it as `customerId`. An entity left with nothing usable is dropped.
  if (isRec(input.purchasingEntity)) {
    const pe = input.purchasingEntity as Record<string, unknown>
    const salvagedId =
      (typeof pe.customerId === "string" && pe.customerId) ||
      (typeof pe.id === "string" && pe.id) ||
      gidFrom(pe.customer) ||
      undefined
    const cleaned: Record<string, unknown> = {}
    const company = cleanPurchasingCompany(pe.purchasingCompany)
    // PurchasingEntityInput takes a customer OR a company: a company draft's customer is its contact.
    if (company) cleaned.purchasingCompany = company
    else if (salvagedId) cleaned.customerId = salvagedId
    if (Object.keys(cleaned).length > 0) input.purchasingEntity = cleaned
    else delete input.purchasingEntity
  }

  // ── B2B guard (deterministic, before any approval is staged; see draft-order-b2b.ts) ──
  const purchasingCompany =
    isRec(input.purchasingEntity) && isRec(input.purchasingEntity.purchasingCompany)
      ? (input.purchasingEntity.purchasingCompany as ReturnType<typeof cleanPurchasingCompany>)
      : undefined
  const buyerCustomerId =
    isRec(input.purchasingEntity) && typeof input.purchasingEntity.customerId === "string"
      ? input.purchasingEntity.customerId
      : undefined
  const touchesPrices = input.lineItems != null || input.appliedDiscount != null || input.lineItemsDiscount != null
  let client: ShopClient | undefined
  let b2b: B2bContext = { b2b: false, existingCompany: null, contactCompanies: [] }
  let verified: VerifiedCompanyBuyer | undefined
  if (purchasingCompany || buyerCustomerId || (opts?.draftId && touchesPrices)) {
    client = await getShopifyClient(ctx)
    b2b = await resolveB2bContext(client, {
      purchasingCompany,
      customerId: buyerCustomerId,
      draftId: input.purchasingEntity == null ? opts?.draftId : undefined,
    })
    if (b2b.b2b && !purchasingCompany && !b2b.existingCompany) throw companyRequiredError(b2b.contactCompanies)
    if (purchasingCompany) verified = await verifyPurchasingCompany(client, purchasingCompany)
  }
  const orderException = parsePriceException(input.priceException, "order")
  delete input.priceException
  const rawLines = Array.isArray(input.lineItems) ? input.lineItems : []
  const lineExceptions = rawLines.map((li, i) =>
    isRec(li) ? parsePriceException(li.priceException, `line ${i + 1}`) : undefined,
  )
  const offences: string[] = []
  rawLines.forEach((li, i) => {
    if (!isRec(li) || lineExceptions[i]) return
    if (b2b.b2b) {
      const fields = nonCatalogPriceFields(li)
      if (fields.length > 0) offences.push(`line ${i + 1} (${fields.join(", ")})`)
    } else if (li.priceOverride != null) {
      throw makeMutationError(
        "PRICE_EXCEPTION_REQUIRED",
        `line ${i + 1}: a priceOverride needs a priceException { reason, note } saying why the price differs.`,
      )
    }
  })
  if (b2b.b2b && !orderException && (input.appliedDiscount != null || input.lineItemsDiscount != null))
    offences.push("the order-level appliedDiscount")
  if (offences.length > 0) throw priceNotCatalogError(offences)
  if (orderException) input.customAttributes = withPriceExceptionAttribute(input.customAttributes, orderException)
  // The company location's own addresses are the draft's, unless the caller set them.
  if (verified && input.useCustomerDefaultAddress !== true) {
    if (input.shippingAddress == null) {
      const a = companyAddressToMailingInput(verified.location.shippingAddress)
      if (a) input.shippingAddress = a
    }
    if (input.billingAddress == null) {
      const a = companyAddressToMailingInput(verified.location.billingAddress ?? verified.location.shippingAddress)
      if (a) input.billingAddress = a
    }
  }

  if (input.lineItemsDiscount != null && input.appliedDiscount == null) {
    const d = normaliseAppliedDiscount(input.lineItemsDiscount)
    if (d) input.appliedDiscount = d
  }
  delete input.lineItemsDiscount
  if (input.appliedDiscount != null) {
    const d = normaliseAppliedDiscount(input.appliedDiscount)
    if (d) input.appliedDiscount = d
  }

  if (Array.isArray(input.lineItems) && input.lineItems.length > 0) {
    client ??= await getShopifyClient(ctx)
    const c = client
    let currency: string | undefined
    const presentment =
      typeof input.presentmentCurrencyCode === "string" && input.presentmentCurrencyCode.trim() !== ""
        ? input.presentmentCurrencyCode.trim().toUpperCase()
        : undefined
    const getCurrency = async (): Promise<string> => (currency ??= presentment ?? (await shopCurrencyCode(c)))
    const normalisedLines = await Promise.all(
      input.lineItems.map((li, i) =>
        normaliseDraftOrderLine(li, c, getCurrency, { b2b: b2b.b2b, exception: lineExceptions[i] }),
      ),
    )
    input.lineItems = normalisedLines
    // B2B: a catalog-priced line (a variant, no exception) must have a FIXED price in a catalog that
    // applies to the company location; otherwise Shopify falls back to an adjusted retail price.
    const locationId = verified?.location.id ?? b2b.existingCompany?.locationId ?? null
    if (b2b.b2b && locationId) {
      const locationLabel = verified?.location.name ?? b2b.existingCompany?.locationName ?? locationId
      const catalogLines = normalisedLines.flatMap((li, i) =>
        isRec(li) && typeof li.variantId === "string" && !lineExceptions[i] && li.priceOverride == null
          ? [{ index: i, variantId: li.variantId }]
          : [],
      )
      if (catalogLines.length > 0) {
        const catalogs = await readLocationCatalogs(c, locationId, locationLabel)
        const fixed = await variantsWithFixedCatalogPrice(
          c,
          catalogs,
          catalogLines.map((l) => l.variantId),
          locationLabel,
        )
        const missing = catalogLines.filter((l) => !fixed.has(l.variantId))
        if (missing.length > 0) {
          const labelled = await Promise.all(
            missing.map(async (m) => ({ ...m, label: (await lookupGidTitle(c, m.variantId)) ?? null })),
          )
          throw noCatalogPriceError(labelled, catalogs, locationLabel)
        }
      }
    }
  }

  // After per-line normalisation, lift a uniform whole-order discount expressed per-line up to the
  // order level (CREATE path only — see promoteUniformLineDiscountToOrderLevel; BL-04 keeps the
  // UPDATE path's per-line round-trip intact). Never on a B2B draft: each line's price basis (the
  // catalog, or its own exception) is what the approver reads.
  if (opts?.promoteWholeOrderDiscount && !b2b.b2b) promoteUniformLineDiscountToOrderLevel(input)

  // Normalise nested MailingAddressInputs (the weak model invents `name`/`street`/…); drop one that
  // has nothing usable left — a draft quote needs no address. Done BEFORE the buyer-identity guard so
  // it inspects the canonical firstName/lastName/address1 shape, not the raw `name`/`street` aliases.
  for (const k of ["shippingAddress", "billingAddress"] as const) {
    if (input[k] != null) {
      const addr = normaliseMailingAddress(input[k])
      if (addr) input[k] = addr
      else delete input[k]
    }
  }

  // Buyer-identity guard (CREATE path only — see enforceBuyerIdentity). A sold order must bind to a
  // person: for DIGITAL goods (license keys, downloads — no shipping) the fulfilment webhook issues
  // the license off the order's EMAIL, so a nameless/emailless digital order silently grants nothing;
  // for PHYSICAL goods there must be somewhere to ship. So refuse to CREATE either kind without the
  // identity it needs, rather than dropping it and producing an order that quietly does the wrong
  // thing (the exact failure that let a comp software order issue no license).
  if (opts?.enforceBuyerIdentity && client && Array.isArray(input.lineItems) && input.lineItems.length > 0) {
    const lines = input.lineItems
    const variantIds = lines
      .map((li) => (isRec(li) && typeof li.variantId === "string" ? li.variantId : undefined))
      .filter((v): v is string => v != null)
    const shipMap = await variantsRequireShipping(client, variantIds)
    const physical = lines.map((li) => lineIsPhysical(li, shipMap))
    const hasPhysical = physical.some((p) => p === true)
    const hasDigital = physical.some((p) => p === false)

    // A company draft's contact is its customer (name + email on its own record).
    const hasLinkedCustomer =
      isRec(input.purchasingEntity) &&
      (typeof input.purchasingEntity.customerId === "string" || isRec(input.purchasingEntity.purchasingCompany))
    const nameOn = (a: unknown): boolean =>
      isRec(a) &&
      ((typeof a.firstName === "string" && a.firstName.trim() !== "") ||
        (typeof a.lastName === "string" && a.lastName.trim() !== ""))
    // A linked customer already carries a name + email on its record; otherwise the draft must carry
    // both itself (a usable email, and a name on billing/shipping).
    const hasBuyerName = hasLinkedCustomer || nameOn(input.billingAddress) || nameOn(input.shippingAddress)
    const hasBuyerEmail = hasLinkedCustomer || isUsableEmail(input.email)

    if (hasDigital) {
      if (!hasBuyerEmail)
        throw makeMutationError(
          "MISSING_BUYER_EMAIL",
          "A draft order with digital goods needs a usable buyer email, since the license is issued to it. " +
            "Set a real `email`, or link a customer via purchasingEntity.customerId.",
          400,
        )
      if (!hasBuyerName)
        throw makeMutationError(
          "MISSING_BUYER_NAME",
          "A draft order with digital goods needs a buyer name. Link a customer via " +
            "purchasingEntity.customerId, or supply firstName/lastName on billingAddress.",
          400,
        )
    }

    if (hasPhysical) {
      const addrOk = (a: unknown): boolean =>
        isRec(a) &&
        typeof a.address1 === "string" &&
        a.address1.trim() !== "" &&
        typeof a.city === "string" &&
        a.city.trim() !== "" &&
        typeof a.countryCode === "string" &&
        a.countryCode.trim() !== ""
      const hasShipTo =
        input.useCustomerDefaultAddress === true || addrOk(input.shippingAddress) || addrOk(input.billingAddress)
      if (!hasShipTo)
        throw makeMutationError(
          "MISSING_SHIPPING_ADDRESS",
          "A draft order with physical goods needs a shipping address (address1, city, countryCode). " +
            "Set shippingAddress, or useCustomerDefaultAddress: true to bill the customer's saved address.",
          400,
        )
    }
  }

  // Email policy. KEEP a USABLE buyer email on every draft, digital or physical. It is the address a
  // digital order's fulfilment webhook issues the license to, AND — when no Shopify customer is
  // linked — the only recipient invoicing has to issue a quote/invoice against: stripping it left
  // Shopify holding `email: null`, invoicing rejecting the counterparty as incomplete, and no
  // document ever appearing for the draft.
  // An UNUSABLE email is still deleted (`isUsableEmail` screens the reserved TLDs and the RFC 2606
  // domains Shopify provably 422s), and a LINKED customer's own record supplies the address, so the
  // redundant copy is dropped there as before.
  // The residual risk this drop used to cover — a fabricated-but-plausible domain that passes the
  // heuristic yet makes Shopify 422 "Email contains an invalid domain name" — is handled where it
  // actually surfaces: `draft_orders_create` retries the mutation ONCE without the email when
  // Shopify rejects its domain, so a bogus address can no longer fail the whole gated create.
  const hasLinkedCustomer =
    isRec(input.purchasingEntity) &&
    (typeof input.purchasingEntity.customerId === "string" || isRec(input.purchasingEntity.purchasingCompany))
  const keepEmail = !hasLinkedCustomer && isUsableEmail(input.email)
  if (input.email != null && !keepEmail) delete input.email

  // Drop any field still outside the real DraftOrderInput (e.g. `currencyCode`, `user_id`).
  stripToAllowlist(input, DRAFT_ORDER_INPUT_FIELDS)
  if (verified) rememberVerifiedBuyer(input, verified)
  return input
}
