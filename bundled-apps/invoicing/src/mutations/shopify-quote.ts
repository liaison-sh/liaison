// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoicing mutations: quotes created as Shopify draft orders (line, name and address mapping).

import { type DraftLine, counterpartyCompletenessError } from "../issue"
// Cycle note: the draft-order sync imports the mutations index back (it calls quoteCreateAndIssue
// and documentsUpdate). Both directions are function-level only -- nothing runs at module init --
// so the bundle resolves it through hoisting.
import { syncQuoteFromDraftOrder } from "../handlers/shopify-draft-order"
import { type IssuerProfileRow, describeIssuerProfiles } from "./db-helpers"
import { normaliseDraftLines } from "./lines"
import {
  type QuoteCreateAndIssueInput,
  type QuoteCreateAndIssueResult,
  completedIssueResult,
} from "./quote-proforma-po"
import {
  type MutationsCtx,
  lineAmountsError,
  lineDiscountError,
  normaliseCustomerReference,
  toBigInt,
} from "./shared"

/** A line discount as Shopify's DraftOrderAppliedDiscountInput takes it. */
type ShopifyAppliedDiscount = { value: number; valueType: "PERCENTAGE"; title: string }

/** A Shopify DraftOrderInput line: a catalog variant, or a free-text custom line. */
type ShopifyDraftLineInput = (
  | { variantId: string; quantity: number }
  | {
      title: string
      quantity: number
      originalUnitPriceWithCurrency: { amount: string; currencyCode: string }
    }
) & { appliedDiscount?: ShopifyAppliedDiscount }

/**
 * A quote line's `discount_minor` (the TOTAL discount of the line) as a Shopify line discount.
 * Shopify applies a line discount per unit, so it is sent as the equivalent PERCENTAGE of the
 * line, which is the same whatever the quantity; the sync then reads Shopify's computed amount
 * back onto the quote line. Null when the line has no discount or no amount to take it from.
 */
export function toShopifyLineDiscount(li: DraftLine): ShopifyAppliedDiscount | null {
  const discount = li.discount_minor ?? 0n
  if (discount <= 0n) return null
  const gross = Number(toBigInt(li.unit_price_minor)) * Number(li.quantity ?? 1)
  if (!Number.isFinite(gross) || gross <= 0) return null
  const pct = Math.min(100, Math.round((Number(discount) / gross) * 100 * 10000) / 10000)
  return { value: pct, valueType: "PERCENTAGE", title: "Discount" }
}

const SHOPIFY_VARIANT_GID_PREFIX = "gid://shopify/ProductVariant/"

/** Minor units to the major-unit decimal string Shopify's money inputs take. */
export function minorToMajorAmount(minor: bigint): string {
  const negative = minor < 0n
  const abs = negative ? -minor : minor
  const units = abs / 100n
  const cents = abs % 100n
  return `${negative ? "-" : ""}${units}.${cents.toString().padStart(2, "0")}`
}

/**
 * Split a quote's lines into Shopify draft-order lines. A line that names a catalog variant
 * (product_source "shopify" + a variant gid) is sent as a variant line so Shopify prices and
 * stocks it itself; everything else goes as a custom line at the price the quote states.
 */
export function toShopifyDraftLines(
  items: DraftLine[],
  currency: string,
): ShopifyDraftLineInput[] {
  return items.map((li) => {
    const quantity = Math.max(1, Math.round(Number(li.quantity ?? 1)))
    const externalId = typeof li.external_id === "string" ? li.external_id : null
    const discount = toShopifyLineDiscount(li)
    const withDiscount = discount ? { appliedDiscount: discount } : {}
    if (li.product_source === "shopify" && externalId?.startsWith(SHOPIFY_VARIANT_GID_PREFIX)) {
      return { variantId: externalId, quantity, ...withDiscount }
    }
    return {
      title: li.description,
      quantity,
      originalUnitPriceWithCurrency: {
        amount: minorToMajorAmount(toBigInt(li.unit_price_minor)),
        currencyCode: currency,
      },
      ...withDiscount,
    }
  })
}

/** Split "Buyer SARL" / "Ada Lovelace" into the firstName/lastName MailingAddressInput wants. */
function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/)
  if (parts.length <= 1) return { firstName: parts[0] ?? "", lastName: parts[0] ?? "" }
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1]! }
}

/**
 * The Shopify customer gid for the quote's kernel contact, when the contact carries one.
 * Absent is NORMAL (a brand-new B2B lead has no Shopify customer yet): the draft order then
 * identifies the buyer by email, so this never fails the create.
 */
// Country names a free-text address commonly ends with, keyed by ISO-2. Only used to drop the
// trailing country segment before splitting: Shopify takes the country from countryCode.
const COUNTRY_NAMES_BY_CODE: Record<string, string[]> = {
  FR: ["france"], DE: ["germany", "deutschland"], US: ["united states", "usa", "united states of america"],
  GB: ["united kingdom", "uk", "great britain", "england"], ES: ["spain", "espana", "españa"], IT: ["italy", "italia"],
  NL: ["netherlands", "the netherlands", "nederland"], BE: ["belgium", "belgique", "belgie"], CH: ["switzerland", "suisse", "schweiz"],
  AT: ["austria", "osterreich", "österreich"], PT: ["portugal"], IE: ["ireland"], SE: ["sweden"], NO: ["norway"], DK: ["denmark"],
  FI: ["finland"], PL: ["poland", "polska"], CZ: ["czech republic", "czechia"], CA: ["canada"], AU: ["australia"], JP: ["japan"],
  LU: ["luxembourg"], GR: ["greece"], HU: ["hungary"], RO: ["romania"], KR: ["south korea", "korea"], CN: ["china"],
}

export interface SplitPostalAddress {
  address1: string
  address2: string | null
  zip: string | null
  city: string | null
}

/**
 * Split the ONE-STRING recipient address a document snapshot carries ("24 Avenue Marceau, Bureau
 * 108A, 75008 Paris, France") into the address1 / address2 / zip / city fields a Shopify
 * MailingAddressInput needs (Shopify refuses a draft order with physical goods that has no
 * address1 + city + countryCode). Segments are comma or newline separated; a trailing segment
 * naming the country is dropped; the LAST segment that reads "zip city" (or "city zip") gives
 * zip + city; the first segment is address1 and anything in between is address2. When no zip
 * segment exists the last remaining segment is taken as the city, so a two-part address still
 * satisfies Shopify. A single segment goes to address1 with city null: the caller decides.
 */
export function splitPostalAddress(text: string | null | undefined, countryCode: string | null | undefined): SplitPostalAddress {
  const raw = (text ?? "").trim()
  let segs = raw.split(/\s*(?:,|\n)\s*/).map((x) => x.trim()).filter((x) => x.length > 0)
  const cc = (countryCode ?? "").trim().toUpperCase()
  if (segs.length > 1) {
    const last = segs[segs.length - 1]!.toLowerCase()
    const names = COUNTRY_NAMES_BY_CODE[cc] ?? []
    if (last === cc.toLowerCase() || names.includes(last)) segs = segs.slice(0, -1)
  }
  if (segs.length === 0) return { address1: raw, address2: null, zip: null, city: null }
  if (segs.length === 1) return { address1: segs[0]!, address2: null, zip: null, city: null }
  const zipFirst = /^([A-Z0-9][A-Z0-9 -]{2,9}\d[A-Z0-9]*)\s+(\p{L}.*)$/iu
  const zipLast = /^(\p{L}.*?)\s+(\d{4,6})$/u
  let zip: string | null = null
  let city: string | null = null
  let cityIdx = -1
  for (let i = segs.length - 1; i >= 1; i--) {
    const seg = segs[i]!
    const m1 = seg.match(zipFirst)
    if (m1 && /\d/.test(m1[1]!)) { zip = m1[1]!.trim(); city = m1[2]!.trim(); cityIdx = i; break }
    const m2 = seg.match(zipLast)
    if (m2) { city = m2[1]!.trim(); zip = m2[2]!; cityIdx = i; break }
  }
  if (cityIdx === -1) { cityIdx = segs.length - 1; city = segs[cityIdx]! }
  const middle = segs.slice(1, cityIdx)
  const tail = segs.slice(cityIdx + 1)
  const address2 = [...middle, ...tail].join(", ")
  return { address1: segs[0]!, address2: address2.length > 0 ? address2 : null, zip, city }
}

async function resolveShopifyCustomerId(
  ctx: MutationsCtx,
  contactId: string | null | undefined,
): Promise<string | null> {
  if (!contactId) return null
  try {
    // kernel:contacts_read takes `contactId` and answers `{ contact: { externalIds } }`.
    const envelope = await ctx.executeTool("kernel:contacts_read", { contactId })
    if (envelope.status !== "completed") return null
    const result = envelope.result as { contact?: { externalIds?: Record<string, unknown> | null } } | null
    const raw = result?.contact?.externalIds?.shopify
    if (typeof raw !== "string" || raw.trim() === "") return null
    return raw.startsWith("gid://") ? raw : `gid://shopify/Customer/${raw.trim()}`
  } catch {
    return null
  }
}

export async function quoteCreateViaShopifyDraftOrder(
  ctx: MutationsCtx,
  rawInput: QuoteCreateAndIssueInput,
  issuer: IssuerProfileRow,
): Promise<QuoteCreateAndIssueResult> {
  const counterpartyErr = counterpartyCompletenessError(rawInput.counterparty)
  if (counterpartyErr) return { status: "error", error: counterpartyErr }
  const amountsErr = lineAmountsError(rawInput.items)
  if (amountsErr) return amountsErr
  const discountErr = lineDiscountError(rawInput.items)
  if (discountErr) return discountErr
  const customerReference = normaliseCustomerReference(rawInput.customer_reference)
  if (!customerReference.ok) return customerReference.error
  const items = normaliseDraftLines(rawInput.items ?? [])
  if (items.length === 0) {
    return {
      status: "error",
      error: {
        code: "empty_document",
        message: "cannot create a quote with no line items: pass at least one `items` entry",
      },
    }
  }
  const currency = rawInput.currency ?? "EUR"
  const cp = rawInput.counterparty
  const { firstName, lastName } = splitName(cp.legal_name ?? "")
  // The quote carries the recipient's address as ONE snapshot string (that is what it prints).
  // Shopify wants it in fields and refuses a physical-goods draft without address1 + city +
  // countryCode, so split it (see splitPostalAddress); a one-segment address still ships as
  // address1 with the segment repeated as the city rather than being refused.
  const split = splitPostalAddress(cp.address, cp.country)
  const address = {
    firstName,
    lastName,
    company: cp.legal_name ?? null,
    address1: split.address1,
    ...(split.address2 ? { address2: split.address2 } : {}),
    ...(split.zip ? { zip: split.zip } : {}),
    city: split.city ?? split.address1,
    countryCode: cp.country ?? null,
  }
  const customerId = await resolveShopifyCustomerId(ctx, cp.contact_id)
  const envelope = await ctx.executeTool("shopify:draft_orders_create", { input: {
    email: cp.email ?? null,
    ...(customerId ? { purchasingEntity: { customerId } } : {}),
    billingAddress: address,
    shippingAddress: address,
    lineItems: toShopifyDraftLines(items, currency),
    // The sync copies the draft order's PO number onto the quote, so this is how the tool's
    // po_number reaches a quote made as a draft order.
    ...(rawInput.po_number?.trim() ? { poNumber: rawInput.po_number.trim() } : {}),
    // The order-created auto-flow reads the buyer's VAT number only from the order's custom
    // attributes (a draft's carry over to its order), so a business quote keeps its reverse charge.
    ...(cp.vat_id?.trim() ? { customAttributes: [{ key: "VAT number", value: cp.vat_id.trim() }] } : {}),
    note: `Quote for ${cp.legal_name ?? cp.email ?? "customer"}`,
    tags: ["liaison-quote"],
  } })
  if (envelope.status === "pending_approval") {
    // The Shopify approval card IS the gate for this quote: the draft order (and therefore
    // the quote) appears once a human approves it there.
    return { status: "pending_approval", approval_id: envelope.approval_id }
  }
  if (envelope.status !== "completed") {
    const code = envelope.error?.code ?? "draft_order_create_failed"
    return {
      status: "error",
      error: {
        code,
        message: await draftOrderFailureMessage(
          ctx,
          issuer,
          `${code}: ${envelope.error?.message ?? "shopify:draft_orders_create returned an error"}`,
        ),
      },
    }
  }
  const created = envelope.result as
    | { draftOrder?: { id?: unknown; name?: unknown }; id?: unknown; name?: unknown }
    | null
  const draftOrderId =
    readGid(created?.draftOrder?.id) ?? readGid(created?.id)
  if (!draftOrderId) {
    return {
      status: "error",
      error: {
        code: "draft_order_id_missing",
        message: "shopify:draft_orders_create completed without a draft order id",
      },
    }
  }
  // Mirror the draft order back as the quote. The sync is the single writer of the quote's
  // content, so a quote created here and one created by a Shopify-side draft order are the
  // same document built by the same code.
  const synced = await syncQuoteFromDraftOrder(ctx, {
    draftOrderId,
    counterpartyFallback: cp,
    customerReference: customerReference.value ?? null,
  })
  if (synced.status === "created" || synced.status === "updated") {
    return {
      ...(await completedIssueResult(ctx.db, synced.document_id, synced.number ?? "")),
      shopify_draft_order_id: draftOrderId,
      shopify_draft_order_name: synced.shopify_draft_order_name ?? null,
    }
  }
  if (synced.status === "error") {
    return { status: "error", error: synced.error }
  }
  return {
    status: "error",
    error: {
      code: "draft_order_sync_skipped",
      message: `draft order ${draftOrderId} was created in Shopify but no quote could be built from it (${
        synced.status === "skipped" ? synced.reason : synced.status
      })`,
    },
  }
}

/**
 * The refusal for a quote whose Shopify draft order could not be created: says WHY the quote went
 * to Shopify at all (its issuer profile is linked to a shop), the underlying error, and how to
 * issue a plain quote instead (an issuer profile with no shop), listing those profiles.
 */
async function draftOrderFailureMessage(
  ctx: MutationsCtx,
  issuer: IssuerProfileRow,
  cause: string,
): Promise<string> {
  let plain: Array<Record<string, unknown>> = []
  try {
    const rows = (await ctx.db.findMany("issuer_profiles", { limit: 100 })) as Array<Record<string, unknown>>
    plain = rows.filter((r) => typeof r.shopify_shop_id !== "string" || r.shopify_shop_id.trim() === "")
  } catch {
    plain = []
  }
  return (
    `issuer profile ${issuer.id} (${issuer.legal_name}) is linked to Shopify shop ` +
    `${issuer.shopify_shop_id}, so this quote is made as a Shopify draft order, and ` +
    `shopify:draft_orders_create failed: ${cause}. Nothing was created. Fix that cause and call ` +
    `quote_create_and_issue again, or issue a plain quote with no Shopify draft order by passing ` +
    `as issuer_profile_id the id of a profile with no shop linked (settings_issuer_profile_list ` +
    `shows each profile's shopify_shop_id). ` +
    (plain.length > 0
      ? `Profiles with no shop: ${describeIssuerProfiles(plain)}.`
      : `This org has no profile without a shop; ask the person before creating one.`)
  )
}

function readGid(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null
}
