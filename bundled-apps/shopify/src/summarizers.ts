// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Gated-tool approval summarizers (host-side, TRUSTED). Bundled into the freeze
// entrypoint via the `export * from "./summarizers"` re-export in src/handlers.ts,
// so the host's `loadTrustedBundleFunction` can resolve them from the built bundle.
//
// An approval summarizer turns a gated tool's params into the human-reviewable
// ApprovalSummary that the kernel records on the approval request AND echoes back
// to the agent inside the BLOCKED envelope (execute-tool.ts `BlockedEnvelope.summary`).
// In a chaos run that summary is the toolEvent output the Opus judge grades, so a
// summary that DESCRIBES THE ACTION AS IT WILL EXECUTE (after handler normalisation)
// is the difference between the judge seeing the true order-level discount vs the raw,
// pre-normalisation per-line shape the weak model happened to emit.
//
// These are pure (no DB / no fetch) so they are safe to run synchronously at gate time.

import {
  type B2bVerdict,
  type CustomerNotificationReason,
  type TrackingFacts,
  customerNotificationFor,
  parseShippingEmailPolicy,
  SHIPPING_EMAIL_POLICIES,
  trackingNumbersOf,
} from "./lib/b2b"
import { describeDiscountInput } from "./mutations/discounts"
import { normalizeTrackingInfo } from "./mutations/fulfillments"

interface ApprovalSummaryLinkShape {
  label: string
  app: string
  entityType: string
  entityId: string
}

/** External https link shape (BL — summarizerContext). Rendered by the web app as a
 *  new-tab anchor, distinct from the in-app `ApprovalSummaryLinkShape` list link above. */
interface ExternalLinkShape {
  label: string
  url: string
}

interface ApprovalSummaryShape {
  kind: string
  title: string
  subtitle?: string
  lines: string[]
  // The kernel schema accepts BOTH shapes in one list: in-app entity links and
  // external https links ({label, url}). External links come first.
  links?: Array<ApprovalSummaryLinkShape | ExternalLinkShape>
}

/** The `meta` third arg the kernel now passes to every untrusted-app summarizer:
 *  `connectionIdentifier` is the connected shop domain (e.g. "acme.myshopify.com"),
 *  and `context` is the `.data` result of the manifest tool's declared `summarizerContext`
 *  read (run under the caller's authorization at gate time) — or `null` when no
 *  `summarizerContext` is declared, the read tool failed, or the read is not yet wired.
 *  Every summarizer that reads `meta.context` MUST degrade gracefully when it is absent:
 *  the context fetch is best-effort and never blocks the approval from being staged. */
interface SummarizerMeta {
  connectionIdentifier: string | null
  context: unknown
}

/** Build the `https://<shop-domain>/admin/...` external link when a connection identifier is
 *  available. Returns undefined (never an empty array) when there is nothing to link — a
 *  summarizer should omit `externalLinks` entirely rather than emit an empty list. */
function externalLink(
  connectionIdentifier: string | null | undefined,
  label: string,
  adminPath: string,
): ExternalLinkShape[] | undefined {
  if (!connectionIdentifier) return undefined
  return [{ label, url: `https://${connectionIdentifier}${adminPath}` }]
}

/** Numeric id from a gid for building a Shopify admin URL (e.g. `.../orders/123456789`). */
function numericId(v: unknown): string | null {
  const s = str(v)
  if (!s) return null
  const m = s.match(/^gid:\/\/shopify\/[A-Za-z]+\/(\d+)/)
  return m?.[1] ?? (/^\d+$/.test(s) ? s : null)
}

/** Money formatter for a context-hydrated amount + currency pair, e.g. "129.00 USD".
 *  Falls back to just the amount when currency is missing, and to null when both are absent —
 *  callers must handle null (never fabricate a total when the context lacks one). */
function money(amount: unknown, currencyCode: unknown): string | null {
  const a = str(amount)
  if (!a) return null
  const c = str(currencyCode)
  return c ? `${a} ${c}` : a
}

/** Render an order's context (the `orders_get` OrderDetail shape) as reviewer-legible lines:
 *  human order number, customer name + email, each line item qty x title, total + currency,
 *  and ship-to country. Used by every order-scoped gated tool's summarizer. Returns an EMPTY
 *  array (never throws) when the context is absent/malformed — callers append these onto their
 *  own params-only lines, so a missing/failed context hydration just means fewer lines, not a
 *  broken card (graceful degradation — the context fetch is best-effort at gate time). */
function orderContextLines(context: unknown): string[] {
  if (!isRec(context)) return []
  const lines: string[] = []
  const customer = isRec(context.customer) ? context.customer : null
  const custName = customer
    ? [str(customer.first_name), str(customer.last_name)].filter(Boolean).join(" ")
    : null
  const custEmail = customer ? str(customer.email) : null
  if (custName || custEmail) {
    lines.push(`Customer: ${[custName, custEmail].filter(Boolean).join(" ")}`)
  }
  // The order's true placed/transaction date (see reads.ts orders_get: `processedAt` is the
  // real purchase date, `createdAt` the record-creation instant — they coincide for a normal
  // checkout but diverge for an imported/backdated order). Placed EARLY (right after the
  // customer line) so it survives the kernel's 8-line truncation on a line-item-heavy order.
  const placedAt = dateOnly(context.attributes && isRec(context.attributes) ? context.attributes.processedAt : null)
  if (placedAt) lines.push(`Order placed: ${placedAt}`)
  const lineItems = isArr(context.lineItems) ? (context.lineItems.filter(isRec) as Record<string, unknown>[]) : []
  for (const li of lineItems.slice(0, 10)) {
    const qty = li.quantity ?? "?"
    const title = str(li.title) ?? (isRec(li.variant) ? str(li.variant.title) : null) ?? "item"
    lines.push(`${qty}x ${title}`)
  }
  if (lineItems.length > 10) lines.push(`...and ${lineItems.length - 10} more line item(s)`)
  const total = isRec(context.totalPrice) ? money(context.totalPrice.amount, context.totalPrice.currencyCode) : null
  if (total) lines.push(`Order total: ${total}`)
  const shipCountry =
    (isRec(context.attributes) && str(context.attributes.shippingCountry)) || null
  if (shipCountry) lines.push(`Ships to: ${shipCountry}`)
  return lines
}

/** Human order number ("#2830") from the order context, else null. */
function orderNumberFromContext(context: unknown): string | null {
  if (!isRec(context)) return null
  return str(context.name) ?? (isRec(context.title) ? null : str(context.title))
}

/** Customer display name from an order context's nested customer, else null. */
function orderCustomerNameFromContext(context: unknown): string | null {
  if (!isRec(context) || !isRec(context.customer)) return null
  const name = [str(context.customer.first_name), str(context.customer.last_name)].filter(Boolean).join(" ")
  return name || str(context.customer.email)
}

/** Render a customer's context (the `customers_get` NormalizedHit shape) as reviewer-legible
 *  lines: name, email, phone, lifetime spend. Empty array when context is absent/malformed. */
function customerContextLines(context: unknown): string[] {
  if (!isRec(context) || !isRec(context.attributes)) return []
  const attrs = context.attributes
  const lines: string[] = []
  const email = str(attrs.email)
  if (email) lines.push(`Email: ${email}`)
  const phone = str(attrs.phone)
  if (phone) lines.push(`Phone: ${phone}`)
  // Account-creation date — placed early, before the spend figure, so it survives truncation.
  const since = dateOnly(attrs.createdAt)
  if (since) lines.push(`Customer since: ${since}`)
  const spent = isRec(attrs.amountSpent) ? money(attrs.amountSpent.amount, attrs.amountSpent.currencyCode) : null
  if (spent) lines.push(`Lifetime spend: ${spent}`)
  return lines
}

/** Customer display name/email from a customer context (`customers_get`'s NormalizedHit.title
 *  is already "First Last" or the email), else null. */
function customerNameFromContext(context: unknown): string | null {
  if (!isRec(context)) return null
  return str(context.title)
}

/** Product title from a product context (`products_get`'s NormalizedHit.title), else null. */
function productTitleFromContext(context: unknown): string | null {
  if (!isRec(context)) return null
  return str(context.title)
}

/** Listing creation date from a product context (`products_get`'s attributes.createdAt), else
 *  null. Named "Listed since" (not "Created") because these summarizers cover UPDATE/DELETE/
 *  PUBLISH/UNPUBLISH of an EXISTING listing — the operator-useful fact is its age, not "now". */
function productListedSinceLine(context: unknown): string | null {
  if (!isRec(context) || !isRec(context.attributes)) return null
  const since = dateOnly(context.attributes.createdAt)
  return since ? `Listed since: ${since}` : null
}

/** Draft order human name ("#D123") from a draft-order context, else null. */
function draftOrderNameFromContext(context: unknown): string | null {
  if (!isRec(context)) return null
  return str(context.title)
}

/** Draft order's customer ({id,email,firstName,lastName}, from `draft_orders_get`'s
 *  attributes.customer) rendered as a single "Customer: Name email" line, plus its line items
 *  (qty x title) and total when present. Empty array when context is absent/malformed. */
function draftOrderContextLines(context: unknown): string[] {
  if (!isRec(context) || !isRec(context.attributes)) return []
  const attrs = context.attributes
  const lines: string[] = []
  const customer = isRec(attrs.customer) ? attrs.customer : null
  if (customer) {
    const name = [str(customer.firstName), str(customer.lastName)].filter(Boolean).join(" ")
    const email = str(customer.email)
    if (name || email) lines.push(`Customer: ${[name, email].filter(Boolean).join(" ")}`)
  }
  // Draft orders carry only `createdAt` (no separate placed/processed date — a draft is not yet
  // a transaction). Placed early so it survives truncation on a line-item-heavy draft.
  const draftCreatedAt = dateOnly(attrs.createdAt)
  if (draftCreatedAt) lines.push(`Draft created: ${draftCreatedAt}`)
  const lineItems = isArr(context.lineItems) ? (context.lineItems.filter(isRec) as Record<string, unknown>[]) : []
  for (const li of lineItems.slice(0, 10)) {
    const qty = li.quantity ?? "?"
    const title = str(li.title) ?? "item"
    lines.push(`${qty}x ${title}`)
  }
  if (lineItems.length > 10) lines.push(`...and ${lineItems.length - 10} more line item(s)`)
  const total = money(attrs.totalAmount, context.currency)
  if (total) lines.push(`Draft total: ${total}`)
  return lines
}

/** Draft order's customer display name/email, else null. */
function draftOrderCustomerNameFromContext(context: unknown): string | null {
  if (!isRec(context) || !isRec(context.attributes) || !isRec(context.attributes.customer)) return null
  const customer = context.attributes.customer
  const name = [str(customer.firstName), str(customer.lastName)].filter(Boolean).join(" ")
  return name || str(customer.email)
}

/** Variant title/SKU line from a variant context (`variants_get`'s NormalizedHit shape). */
function variantLabelFromContext(context: unknown): string | null {
  if (!isRec(context)) return null
  const title = str(context.title)
  const sku = isRec(context.attributes) ? str(context.attributes.sku) : null
  if (title && sku) return `${title} (SKU ${sku})`
  return title ?? (sku ? `SKU ${sku}` : null)
}

// Shopify's tab surfaces are all app-wide singleton LISTS (Orders/Customers/Products/
// Markets) — there is no per-entity detail tab (`referenceable: false` on every
// tabType in app.manifest.json), so a link can only point at the relevant list, not
// the specific order/product/customer. `entityId` matches the tabType's own key
// (namespaced by the frontend as `shopify:<key>`), not the record id.
function listLink(label: string, tabKey: "orders" | "customers" | "products" | "markets"): ApprovalSummaryLinkShape {
  return { label, app: "shopify", entityType: tabKey, entityId: tabKey }
}

// One origin link, never two: the real per-entity Shopify admin URL when the shop
// domain is known, otherwise the in-app list tab as a fallback. Emitting both put a
// second "open in Shopify" button on every card that dead-ended on the app's list view.
function adminLink(
  meta: SummarizerMeta | undefined,
  label: string,
  base: "orders" | "draft_orders" | "customers" | "products",
  id: string | null,
  fallbackLabel: string,
  tabKey: "orders" | "customers" | "products" | "markets",
): Array<ApprovalSummaryLinkShape | ExternalLinkShape> {
  const path = id ? `/admin/${base}/${id}` : `/admin/${base}`
  return externalLink(meta?.connectionIdentifier, label, path) ?? [listLink(fallbackLabel, tabKey)]
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isArr(v: unknown): v is unknown[] {
  return Array.isArray(v)
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null
}

/** Slice an ISO-8601 date/date-time string down to its `YYYY-MM-DD` calendar date for a
 *  reviewer-legible summary line — malformed/absent input degrades to null (never throws,
 *  never renders "Invalid Date"). Shopify's GraphQL dates are always full ISO instants
 *  ("2026-04-09T14:32:00Z"), so a plain string slice is safe and avoids a timezone-shifting
 *  `Date` round-trip. */
function dateOnly(v: unknown): string | null {
  const s = str(v)
  if (!s) return null
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1]! : null
}

/** Unwrap the manifest's `{ input: {...} }` param-envelope convention, merging any
 *  top-level sibling params (e.g. `id`) alongside the unwrapped `input` fields. */
function unwrapInput(params: unknown): Record<string, unknown> {
  if (!isRec(params)) return {}
  if (isRec(params.input)) return { ...params, ...params.input }
  return params
}

/** Shorten a Shopify GID (`gid://shopify/Product/123456789`) to its trailing numeric
 *  id ("123456789") for a legible line — falls back to the raw value untouched when it
 *  is not a recognisable gid (e.g. already a bare id or a human title). */
function gidShort(v: unknown): string {
  const s = str(v)
  if (!s) return "(unknown)"
  const m = s.match(/^gid:\/\/shopify\/[A-Za-z]+\/(.+)$/)
  return m?.[1] ?? s
}

/** Best-effort human label for an entity reference: prefer a real name/title param,
 *  else fall back to the shortened gid so the card is never blank. */
function entityLabel(idLike: unknown, titleLike?: unknown): string {
  const title = str(titleLike)
  if (title) return title
  return gidShort(idLike)
}

// ─── Generic payload-field renderer (no card may claim "no changes" while fields exist) ──
//
// Every update summarizer used to render a hand-picked whitelist of fields and collapse
// anything else to "No field changes detected in the payload" — a LIE whenever the payload
// carried a field outside the whitelist (a live variants_update setting
// inventoryItem.requiresShipping showed exactly that, so the approver had no idea what they
// were approving). This renderer walks whatever fields the whitelist did NOT handle and
// prints each as a legible "Label -> value" line, with first-class wording for the fields
// where a bare key would still under-explain the consequence.

/** Human wording for known field paths whose consequence a reviewer must understand. */
function describeKnownField(path: string, value: unknown): string | null {
  switch (path) {
    case "inventoryItem.requiresShipping":
      return value === false
        ? "Requires shipping -> no (marks this a DIGITAL good: checkout stops collecting a shipping address for it)"
        : "Requires shipping -> yes (marks this a PHYSICAL good: checkout collects a shipping address)"
    case "inventoryItem.tracked":
      return `Inventory tracking -> ${value === true ? "on" : "off"}`
    case "inventoryItem.cost":
      return `Cost per item -> ${String(value)}`
    case "taxable":
      return `Taxable -> ${value === true ? "yes" : "no"}`
    default:
      return null
  }
}

/** "inventoryItem.requiresShipping" → "Inventory item requires shipping" (fallback label). */
function humanizeFieldPath(path: string): string {
  const words = path
    .replace(/\./g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function humanizeFieldValue(value: unknown): string {
  if (value === true) return "yes"
  if (value === false) return "no"
  if (typeof value === "string") return gidShort(value)
  return String(value)
}

/**
 * Render every payload field the summarizer's whitelist did not already handle.
 * `handled` lists top-level keys AND dotted paths already covered. Identifier keys
 * (`id`, `productId`, `orderId`, …) are skipped — they belong in the title, not the lines.
 */
function describeRemainingFields(payload: Record<string, unknown>, handled: readonly string[]): string[] {
  const handledSet = new Set(handled)
  const skip = new Set(["id", "productId", "orderId", "customerId", "input"])
  const lines: string[] = []
  const walk = (obj: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (handledSet.has(path) || (prefix === "" && (handledSet.has(key) || skip.has(key)))) continue
      if (value == null) continue
      if (isRec(value)) {
        walk(value, path)
        continue
      }
      if (isArr(value)) {
        const scalars = value.filter((v) => typeof v === "string" || typeof v === "number")
        lines.push(
          scalars.length === value.length && value.length > 0
            ? `${humanizeFieldPath(path)} -> ${scalars.map(humanizeFieldValue).join(", ")}`
            : `${humanizeFieldPath(path)} -> ${value.length} item(s)`,
        )
        continue
      }
      lines.push(describeKnownField(path, value) ?? `${humanizeFieldPath(path)} -> ${humanizeFieldValue(value)}`)
    }
  }
  walk(payload, "")
  return lines
}

function discountLabel(d: Record<string, unknown>): string {
  const value = d.value ?? d.percentage ?? d.amount
  const isPct =
    d.valueType === "PERCENTAGE" ||
    (d.valueType == null && d.percentage != null) ||
    (d.valueType == null && d.value != null && Number(d.value) <= 100)
  const reason = typeof d.title === "string" && d.title.length > 0 ? ` (${d.title})` : ""
  return isPct ? `${value}% off${reason}` : `${value} off${reason}`
}

/** True when every per-line discount present is the same value (one distinct discount across the
 *  lines) — i.e. a single whole-order discount the weak model spread per-line. Mirrors the
 *  handler's promoteUniformLineDiscountToOrderLevel so the summary matches what executes. */
function uniformLineDiscount(
  lines: Record<string, unknown>[],
): Record<string, unknown> | null {
  const present: Record<string, unknown>[] = []
  for (const l of lines) if (isRec(l.appliedDiscount)) present.push(l.appliedDiscount)
  if (present.length === 0) return null
  const first = present[0]
  if (!first) return null
  const same = present.every(
    (d) => d.valueType === first.valueType && Number(d.value ?? d.percentage ?? d.amount) === Number(first.value ?? first.percentage ?? first.amount),
  )
  return same ? first : null
}

/**
 * Summary for shopify `draft_orders_create`. Presents the draft as it will EXECUTE after
 * normalisation: a WHOLE-ORDER discount (one expressed identically across the lines, OR on a
 * single line of a multi-line order) is reported as an ORDER-LEVEL discount on the whole order —
 * because that is exactly how the handler places it (promoteUniformLineDiscountToOrderLevel). A
 * genuine mix of DIFFERENT per-line discounts is reported per line. The customer and the draft note
 * (e.g. a UK-export customs note) are surfaced too.
 */
/** A price exception as the card shows it: `<reason>` or `<reason>: <note>`. */
function priceExceptionText(v: unknown): string | null {
  if (v == null) return null
  const reason = isRec(v) ? v.reason : v
  if (typeof reason !== "string" || reason.trim() === "") return null
  const note = isRec(v) && typeof v.note === "string" && v.note.trim() !== "" ? v.note.trim() : null
  return note ? `${reason.trim()}: ${note}` : reason.trim()
}

/** The price basis of one B2B line: the company catalog, or its exception with the price it sets. */
function b2bPriceBasis(li: Record<string, unknown>): string {
  const why = priceExceptionText(li.priceException)
  if (!why) return "catalog price"
  const override = li.priceOverride ?? li.price ?? li.unitPrice
  const amount = isRec(override) ? override.amount : override
  const parts: string[] = []
  if (amount != null && amount !== "") parts.push(`unit price ${String(amount)}`)
  if (isRec(li.appliedDiscount)) parts.push(discountLabel(li.appliedDiscount))
  if (isRec(li.originalUnitPriceWithCurrency)) parts.push(`custom price ${String(li.originalUnitPriceWithCurrency.amount)}`)
  return `price exception (${why})${parts.length ? `, ${parts.join(", ")}` : ""}`
}

/** The company and location a B2B draft is placed for (names from the hydrated context). */
function companyLines(pc: Record<string, unknown>, hydrated: unknown): string[] {
  const h = isRec(hydrated) ? hydrated : {}
  const company = (typeof h.name === "string" && h.name) || (typeof pc.companyId === "string" ? pc.companyId : "?")
  const location =
    (typeof h.locationName === "string" && h.locationName) ||
    (typeof pc.companyLocationId === "string" ? pc.companyLocationId : "?")
  return [`Company: ${company}`, `Location: ${location} (prices from this location's B2B catalog)`]
}

export function summarizeDraftOrderCreate(
  params: unknown,
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const input = isRec(params) && isRec(params.input) ? params.input : isRec(params) ? params : {}
  const lineItems = Array.isArray(input.lineItems)
    ? (input.lineItems.filter(isRec) as Record<string, unknown>[])
    : []
  const lines: string[] = []

  // summarizerContext hydration (variants_brief): variantId → human identity. Without it the
  // card read "1× gid://shopify/ProductVariant/57467363623243" — the approver had no idea WHAT
  // product they were approving. Hydration is best-effort; a raw gid remains the fallback.
  const briefById = new Map<string, { title: string; price: string | null; requiresShipping: boolean | null }>()
  const metaCtx = meta?.context
  const ctxVariants = isRec(metaCtx) && Array.isArray(metaCtx.variants) ? metaCtx.variants : []
  for (const v of ctxVariants) {
    if (isRec(v) && typeof v.id === "string" && typeof v.title === "string") {
      briefById.set(v.id, {
        title: v.title,
        price: typeof v.price === "string" ? v.price : null,
        requiresShipping: typeof v.requiresShipping === "boolean" ? v.requiresShipping : null,
      })
    }
  }

  const pc =
    isRec(input.purchasingEntity) && isRec(input.purchasingEntity.purchasingCompany)
      ? input.purchasingEntity.purchasingCompany
      : null
  const companyDraft = pc != null
  if (pc) lines.push(...companyLines(pc, isRec(metaCtx) ? metaCtx.company : null))

  // Order-level discount: an explicit one, else a uniform per-line discount promoted to order level.
  const explicitOrderDiscount = isRec(input.appliedDiscount) ? input.appliedDiscount : null
  const promoted =
    explicitOrderDiscount == null && lineItems.length >= 2 && !companyDraft ? uniformLineDiscount(lineItems) : null
  const orderDiscount = explicitOrderDiscount ?? promoted

  // Deterministic price arithmetic: the approver must see what each discounted
  // line ACTUALLY costs and what the whole draft totals, so an invented discount
  // (a "tier" the model hallucinated) is legible as wrong numbers at a glance
  // instead of hiding behind a percentage label.
  const effectiveUnit = (list: number, d: Record<string, unknown> | null): number => {
    if (!d) return list
    const v = typeof d.value === "number" ? d.value : Number(d.value)
    if (!Number.isFinite(v)) return list
    return d.valueType === "PERCENTAGE" ? list * (1 - v / 100) : Math.max(0, list - v)
  }
  const money = (n: number): string => (Math.round(n * 100) / 100).toFixed(2)
  let projectedTotal = 0
  let totalComplete = lineItems.length > 0

  for (const li of lineItems) {
    const qty = li.quantity ?? "?"
    const brief = typeof li.variantId === "string" ? briefById.get(li.variantId) : undefined
    const ident =
      brief?.title ||
      (typeof li.title === "string" && li.title) ||
      (typeof li.variantId === "string" && li.variantId) ||
      (typeof li.productId === "string" && li.productId) ||
      "item"
    const priceTag = brief?.price ? ` (list ${brief.price})` : ""
    const kindTag = brief?.requiresShipping === false ? " [digital]" : ""
    // A per-line discount that is NOT the promoted whole-order one stays shown per line.
    const lineDiscount = isRec(li.appliedDiscount) ? li.appliedDiscount : null
    const perLine = lineDiscount && promoted == null && explicitOrderDiscount == null
      ? ` (${discountLabel(lineDiscount)})`
      : ""
    const listNum = brief?.price ? Number(brief.price) : Number.NaN
    const qtyNum = typeof li.quantity === "number" ? li.quantity : Number(li.quantity)
    let effTag = ""
    if (companyDraft) {
      // B2B: Shopify prices the line from the company location's catalog; the card says which
      // basis each line uses instead of projecting a retail-price total.
      lines.push(`${qty}× ${ident}${kindTag}: ${b2bPriceBasis(li)}`)
      totalComplete = false
      continue
    }
    if (Number.isFinite(listNum) && Number.isFinite(qtyNum)) {
      const eff = effectiveUnit(listNum, orderDiscount ?? lineDiscount)
      if (eff !== listNum) effTag = ` -> ${money(eff)}/unit`
      projectedTotal += eff * qtyNum
    } else {
      totalComplete = false
    }
    lines.push(`${qty}× ${ident}${priceTag}${kindTag}${perLine}${effTag}`)
  }

  if (orderDiscount) {
    const why = priceExceptionText(input.priceException)
    lines.push(`Order-level discount (whole order): ${discountLabel(orderDiscount)}${why ? ` (exception: ${why})` : ""}`)
  }
  if (totalComplete) {
    lines.push(`Projected total before shipping/tax: ${money(projectedTotal)}`)
  }

  const custId =
    (isRec(input.purchasingEntity) && typeof input.purchasingEntity.customerId === "string" && input.purchasingEntity.customerId) ||
    (isRec(input.customer) && typeof input.customer.id === "string" && input.customer.id) ||
    (typeof input.customerId === "string" && input.customerId) ||
    null
  if (custId) lines.push(`Customer: ${custId}`)
  // Buyer identity the guard binds a digital order to — the approver must see WHO receives it.
  if (typeof input.email === "string" && input.email.length > 0) lines.push(`Buyer email: ${input.email}`)
  const addr = isRec(input.billingAddress) ? input.billingAddress : isRec(input.shippingAddress) ? input.shippingAddress : null
  const buyerName = addr
    ? [addr.firstName, addr.lastName].filter((v) => typeof v === "string" && v.length > 0).join(" ")
    : ""
  if (buyerName) lines.push(`Buyer: ${buyerName}`)
  if (typeof input.note === "string" && input.note.length > 0) lines.push(`Note: ${input.note}`)

  return Promise.resolve({
    kind: "draft_orders_create",
    title: "Create Shopify draft order",
    subtitle: "Pending approval",
    lines: lines.length > 0 ? lines : ["Draft order"],
  })
}

/**
 * Summary for shopify `products_merge` (BL-262). This is a DESTRUCTIVE, orchestrated merge: it
 * reassigns the duplicate's variants/inventory onto the survivor, sets up a URL redirect, then DELETES
 * the duplicate. The human reviewer must see a LEGIBLE action — which listing is KEPT, which is DELETED
 * (by title, not just an opaque id), and the data-loss caveat (reviews/metafields do not carry over).
 *
 * The handler resolves true titles at execution, but the summarizer is pure (no fetch), so it names the
 * survivor/duplicate from the titles the agent passes (it read both from products_search). Titles are
 * OPTIONAL: when absent the summary falls back to the ids so the card is never blank — but the tool
 * description nudges the agent to pass them so the reviewer sees real names.
 */
export function summarizeProductsMerge(params: unknown): Promise<ApprovalSummaryShape> {
  const p = isRec(params) && isRec(params.input) ? { ...params, ...params.input } : isRec(params) ? params : {}
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null)
  const gid = (v: unknown): string | null =>
    str(v) ?? (isRec(v) && typeof v.id === "string" ? v.id : null)

  const survivorId = gid(p.survivorId ?? p.keepId ?? p.keep ?? p.canonicalId ?? p.targetId ?? p.winnerId)
  const duplicateId = gid(p.duplicateId ?? p.removeId ?? p.remove ?? p.sourceId ?? p.deleteId ?? p.loserId)
  const survivorTitle =
    str(p.survivorTitle ?? p.keepTitle ?? p.canonicalTitle ?? p.targetTitle) ?? survivorId ?? "(unnamed)"
  const duplicateTitle =
    str(p.duplicateTitle ?? p.removeTitle ?? p.sourceTitle ?? p.deleteTitle) ?? duplicateId ?? "(unnamed)"

  const lines: string[] = [
    `KEEP (survivor): ${survivorTitle}`,
    `DELETE (duplicate): ${duplicateTitle}`,
    "Reassign the duplicate's variants + inventory onto the survivor, then delete the duplicate.",
    "Set up a URL redirect from the deleted listing's handle to the survivor (inbound links/SEO preserved).",
    "DATA-LOSS CAVEAT: product reviews and metafields do NOT carry over. Shopify has no merge primitive for them.",
  ]

  return Promise.resolve({
    kind: "products_merge",
    title: "Merge duplicate Shopify products (reassign + redirect + delete)",
    subtitle: "Pending approval: this DELETES the duplicate listing",
    lines,
  })
}

// ─── Orders / refunds / fulfillments ──────────────────────────────────────────

export function summarizeRefundsCreate(params: unknown, _ctx?: unknown, meta?: SummarizerMeta): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const orderId = gidShort(p.orderId)
  const amount = str(p.amount)
  const lineItems = isArr(p.refundLineItems) ? (p.refundLineItems.filter(isRec) as Record<string, unknown>[]) : []
  const lines: string[] = []

  if (amount) {
    lines.push(`Flat goodwill refund: ${amount}`)
  } else if (lineItems.length > 0) {
    for (const li of lineItems) {
      const qty = li.quantity ?? "?"
      lines.push(`Refund ${qty}x line item ${gidShort(li.lineItemId)}${li.restockType ? ` (restock: ${li.restockType})` : ""}`)
    }
  } else {
    lines.push("Refund the full remaining order amount")
  }

  const shipping = isRec(p.shipping) ? p.shipping : null
  if (shipping) {
    if (shipping.fullRefund) lines.push("Also refund shipping in full")
    else if (str(shipping.amount)) lines.push(`Also refund shipping: ${str(shipping.amount)}`)
  }

  const notify = p.notify !== false
  const note = str(p.note)
  if (note) lines.push(`Note: ${note}`)

  // Rich hydration: order number + customer name/email from the context (orders_get), so the
  // reviewer sees WHO the refund is for and WHAT the order contains, not just an opaque order id.
  // Degrades to the params-only card above when meta/context is absent (best-effort fetch).
  const context = meta?.context
  const orderNumber = orderNumberFromContext(context)
  const customerName = orderCustomerNameFromContext(context)
  lines.push(...orderContextLines(context))

  const orderLabel = orderNumber ? `order ${orderNumber}` : `order ${orderId}`
  const forWhom = customerName ? ` for ${customerName}` : ""

  return Promise.resolve({
    kind: "refunds_create",
    title: amount ? `Refund ${amount} on ${orderLabel}${forWhom}` : `Refund ${orderLabel}${forWhom}`,
    subtitle: notify ? "Customer WILL be notified" : "No customer notification",
    lines,
    links: adminLink(meta, "Open order in Shopify", "orders", numericId(p.orderId), "Open orders in Shopify", "orders"),
  })
}

export function summarizeDraftOrdersComplete(
  params: unknown,
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const p = unwrapInput(params)
  const id = gidShort(p.id)
  const lines = [
    p.paymentPending ? "Mark as paid: payment PENDING (not collected now)" : "Mark as paid: payment collected now",
  ]

  const context = meta?.context
  const draftName = draftOrderNameFromContext(context)
  const customerName = draftOrderCustomerNameFromContext(context)
  lines.push(...draftOrderContextLines(context))

  return Promise.resolve({
    kind: "draft_orders_complete",
    title: `Complete draft order ${draftName ?? id}${customerName ? ` for ${customerName}` : ""}`,
    subtitle: "Converts the draft into a real order",
    lines,
    links: adminLink(meta, "Open draft order in Shopify", "draft_orders", numericId(p.id), "Open orders in Shopify", "orders"),
  })
}

// Whether Shopify emails the customer is the org's shipping email policy, decided by the handler at
// execution with `customerNotificationFor` (lib/b2b.ts). The card is staged first, so it runs the SAME
// rule on the policy, the order's B2B verdict and the fulfilment's tracking from the hydrated read
// (orders_get / fulfillments_get) and says exactly what will happen; a fact it cannot know at
// staging (fail closed at execution) reads as decided at execution, never as a promise.
const CARD_NOTICE: Record<CustomerNotificationReason, string> = {
  b2b_company_buyer: "Customer will not be notified: B2B order",
  b2b_sku_suffix: "Customer will not be notified: B2B order",
  retail_order: "Customer will be notified: retail order",
  policy_all: "Customer will be notified (policy: every order)",
  policy_none: "Customer will not be notified (policy: no shipping emails)",
  no_tracking: "Customer will not be notified: no tracking number yet",
  already_notified: "Customer will not be notified: the fulfillment already has a tracking number",
  undecided_fail_closed: "Notification decided at execution (store shipping email policy)",
}

function fulfilmentNotifySubtitle(callerNotify: boolean, source: unknown, tracking: TrackingFacts): string {
  const rec = isRec(source) ? source : {}
  const policy =
    typeof rec.shippingEmailPolicy === "string" && (SHIPPING_EMAIL_POLICIES as readonly string[]).includes(rec.shippingEmailPolicy)
      ? parseShippingEmailPolicy(rec.shippingEmailPolicy)
      : null
  if (policy === null) return CARD_NOTICE.undecided_fail_closed
  const v = isRec(rec.b2bOrder) ? rec.b2bOrder : null
  const verdict: B2bVerdict | null =
    v?.b2b === true && (v.reason === "b2b_company_buyer" || v.reason === "b2b_sku_suffix")
      ? { b2b: true, reason: v.reason }
      : v?.b2b === false
        ? { b2b: false, reason: null }
        : null
  const decision = customerNotificationFor({ policy, verdict, callerAsksToNotify: callerNotify, tracking })
  if (decision.notice) return CARD_NOTICE[decision.notice.reason]
  const notify = decision.notify ?? callerNotify
  return notify ? "Customer WILL be notified" : "No customer notification"
}

export function summarizeFulfillmentsCreate(
  params: unknown,
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const orderId = gidShort(p.orderId)
  const fulfillment = isRec(p.fulfillment) ? p.fulfillment : {}
  const itemGroups = isArr(fulfillment.lineItemsByFulfillmentOrder)
    ? (fulfillment.lineItemsByFulfillmentOrder.filter(isRec) as Record<string, unknown>[])
    : []
  const tracking = isRec(fulfillment.trackingInfo) ? fulfillment.trackingInfo : null
  const notify = fulfillment.notifyCustomer === true

  const lines: string[] = [
    itemGroups.length > 0
      ? `Fulfillment order(s): ${itemGroups.length}`
      : "Fulfill all remaining line items on the order",
  ]
  if (tracking) {
    const company = str(tracking.company)
    const number = str(tracking.number)
    if (company || number) lines.push(`Tracking: ${[company, number].filter(Boolean).join(" ")}`)
  }

  // Rich hydration: human order number, customer, and line items (qty x title) from context
  // (orders_get) so the reviewer sees WHO the fulfillment is for and WHAT ships, e.g.
  // "Fulfill order #2830 for US Sam (1 item)". Degrades to the params-only title/lines above
  // when meta/context is absent.
  const context = meta?.context
  const orderNumber = orderNumberFromContext(context)
  const customerName = orderCustomerNameFromContext(context)
  const itemCount = isRec(context) && isArr(context.lineItems) ? context.lineItems.length : null
  lines.push(...orderContextLines(context))

  const orderLabel = orderNumber ? `order ${orderNumber}` : `order ${orderId}`
  const forWhom = customerName ? ` for ${customerName}` : ""
  const itemSuffix =
    itemCount != null
      ? ` (${itemCount} item${itemCount === 1 ? "" : "s"})`
      : itemGroups.length > 0
        ? ` (${itemGroups.length} fulfillment order${itemGroups.length === 1 ? "" : "s"})`
        : ""

  return Promise.resolve({
    kind: "fulfillments_create",
    title: `Fulfill ${orderLabel}${forWhom}${itemSuffix}`,
    subtitle: fulfilmentNotifySubtitle(notify, context, {
      write: "create",
      hasNumber: trackingNumbersOf(normalizeTrackingInfo(fulfillment.trackingInfo)).length > 0,
    }),
    lines,
    links: adminLink(meta, "Open order in Shopify", "orders", numericId(p.orderId), "Open orders in Shopify", "orders"),
  })
}

export function summarizeFulfillmentsCancel(params: unknown): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  return Promise.resolve({
    kind: "fulfillments_cancel",
    title: `Cancel fulfillment ${gidShort(p.id)}`,
    subtitle: "Undoes the fulfillment; the order returns to unfulfilled",
    lines: [`Fulfillment: ${gidShort(p.id)}`],
  })
}

export function summarizeFulfillmentsUpdateTracking(
  params: unknown,
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const info = isRec(p.trackingInfoInput) ? p.trackingInfoInput : {}
  const company = str(info.company)
  const number = str(info.number)
  const numbers = isArr(info.numbers) ? info.numbers.filter((n): n is string => typeof n === "string") : []
  const notify = p.notifyCustomer === true
  const attrs = isRec(meta?.context) && isRec(meta.context.attributes) ? meta.context.attributes : null
  // The fulfilment's tracking before this update (fulfillments_get); unknown without the read.
  const hadNumber =
    isRec(attrs) && isArr(attrs.trackingInfo)
      ? trackingNumbersOf({ numbers: attrs.trackingInfo.map((t) => (isRec(t) ? t.number : null)) }).length > 0
      : null

  const lines: string[] = []
  if (company) lines.push(`Carrier: ${company}`)
  if (number) lines.push(`Tracking number: ${number}`)
  if (numbers.length > 0) lines.push(`Tracking numbers: ${numbers.join(", ")}`)
  if (lines.length === 0) lines.push("No tracking number provided")

  return Promise.resolve({
    kind: "fulfillments_update_tracking",
    title: `Update tracking on fulfillment ${gidShort(p.fulfillmentId)}`,
    subtitle: fulfilmentNotifySubtitle(notify, attrs, {
      write: "update",
      setsNumber: trackingNumbersOf(normalizeTrackingInfo(info)).length > 0,
      hadNumber,
    }),
    lines,
  })
}

export function summarizeOrderUpdate(params: unknown, _ctx?: unknown, meta?: SummarizerMeta): Promise<ApprovalSummaryShape> {
  const p = unwrapInput(params)
  const id = gidShort(p.id)
  const lines: string[] = []
  const tags = isArr(p.tags) ? p.tags.filter((t): t is string => typeof t === "string") : []
  if (tags.length > 0) lines.push(`Tags: ${tags.join(", ")}`)
  const note = str(p.note)
  if (note) lines.push(`Note: ${note}`)
  const email = str(p.email)
  if (email) lines.push(`Email: ${email}`)
  lines.push(...describeRemainingFields(p, ["tags", "note", "email"]))
  if (lines.length === 0) lines.push("Only the order identifier is present in the payload")

  const context = meta?.context
  const orderNumber = orderNumberFromContext(context)
  const customerName = orderCustomerNameFromContext(context)
  lines.push(...orderContextLines(context))

  const orderLabel = orderNumber ? `order ${orderNumber}` : `order ${id}`
  const forWhom = customerName ? ` for ${customerName}` : ""

  return Promise.resolve({
    kind: "order_update",
    title: `Update ${orderLabel}${forWhom}`,
    lines,
    links: adminLink(meta, "Open order in Shopify", "orders", numericId(p.id), "Open orders in Shopify", "orders"),
  })
}

export function summarizeOrderCancel(params: unknown, _ctx?: unknown, meta?: SummarizerMeta): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const orderId = gidShort(p.orderId)
  const reason = str(p.reason)
  const refund = p.refund === true
  const restock = p.restock === true
  const notify = p.notifyCustomer === true

  const lines: string[] = [
    `Refund: ${refund ? "yes" : "no"}`,
    `Restock: ${restock ? "yes" : "no"}`,
  ]
  if (reason) lines.push(`Reason: ${reason}`)

  const context = meta?.context
  const orderNumber = orderNumberFromContext(context)
  const customerName = orderCustomerNameFromContext(context)
  lines.push(...orderContextLines(context))

  const orderLabel = orderNumber ? `order ${orderNumber}` : `order ${orderId}`
  const forWhom = customerName ? ` for ${customerName}` : ""

  return Promise.resolve({
    kind: "order_cancel",
    title: `Cancel ${orderLabel}${forWhom}`,
    subtitle: notify ? "Customer WILL be notified" : "No customer notification",
    lines,
    links: adminLink(meta, "Open order in Shopify", "orders", numericId(p.orderId), "Open orders in Shopify", "orders"),
  })
}

// ─── Draft orders (update / delete / send) ────────────────────────────────────

export function summarizeDraftOrdersUpdate(params: unknown, _ctx?: unknown, meta?: SummarizerMeta): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const id = gidShort(p.id)
  const input = isRec(p.input) ? p.input : {}
  const lineItems = isArr(input.lineItems) ? (input.lineItems.filter(isRec) as Record<string, unknown>[]) : []
  const lines: string[] = []
  const context = meta?.context
  // B2B: the company the draft is (or will be) placed for, and each line's price basis.
  const existing =
    isRec(context) && isRec(context.draftOrder) && isRec(context.draftOrder.purchasingCompany)
      ? context.draftOrder.purchasingCompany
      : null
  const pcInput =
    isRec(input.purchasingEntity) && isRec(input.purchasingEntity.purchasingCompany)
      ? input.purchasingEntity.purchasingCompany
      : null
  const companyDraft = pcInput != null || existing != null
  if (pcInput) lines.push(...companyLines(pcInput, null))
  else if (existing) {
    const company = typeof existing.companyName === "string" ? existing.companyName : "?"
    const location = typeof existing.locationName === "string" ? existing.locationName : "?"
    lines.push(`Company: ${company}`, `Location: ${location} (prices from this location's B2B catalog)`)
  }
  for (const li of lineItems) {
    lines.push(`${li.quantity ?? "?"}x ${gidShort(li.variantId)}${companyDraft ? `: ${b2bPriceBasis(li)}` : ""}`)
  }
  if (isRec(input.appliedDiscount)) {
    const why = priceExceptionText(input.priceException)
    lines.push(`Discount: ${discountLabel(input.appliedDiscount)}${why ? ` (exception: ${why})` : ""}`)
  }
  const note = str(input.note)
  if (note) lines.push(`Note: ${note}`)
  if (lines.length === 0) lines.push("No line-item or discount changes in the payload")

  const draftName = draftOrderNameFromContext(context)
  const customerName = draftOrderCustomerNameFromContext(context)

  return Promise.resolve({
    kind: "draft_orders_update",
    title: `Update draft order ${draftName ?? id}${customerName ? ` for ${customerName}` : ""}`,
    lines,
    links: externalLink(meta?.connectionIdentifier, "Open draft order in Shopify", `/admin/draft_orders/${numericId(p.id)}`),
  })
}

export function summarizeDraftOrdersDelete(params: unknown, _ctx?: unknown, meta?: SummarizerMeta): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const context = meta?.context
  const draftName = draftOrderNameFromContext(context)
  const customerName = draftOrderCustomerNameFromContext(context)
  const lines = [`Draft order: ${draftName ?? gidShort(p.id)}`, ...draftOrderContextLines(context)]

  return Promise.resolve({
    kind: "draft_orders_delete",
    title: `Delete draft order ${draftName ?? gidShort(p.id)}${customerName ? ` for ${customerName}` : ""}`,
    subtitle: "This permanently removes the draft",
    lines,
    links: externalLink(meta?.connectionIdentifier, "Open draft order in Shopify", `/admin/draft_orders/${numericId(p.id)}`),
  })
}

export function summarizeDraftOrdersSend(params: unknown, _ctx?: unknown, meta?: SummarizerMeta): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const id = gidShort(p.id)
  const email = isRec(p.email) ? p.email : {}
  const to = str(email.to)
  const subject = str(email.subject)
  const customMessage = str(email.customMessage)

  const lines: string[] = []
  if (to) lines.push(`To: ${to}`)
  if (subject) lines.push(`Subject: ${subject}`)
  if (customMessage) lines.push(`Message: ${customMessage}`)
  if (lines.length === 0) lines.push("Sends the invoice email using Shopify's default template")

  const context = meta?.context
  const draftName = draftOrderNameFromContext(context)
  const customerName = draftOrderCustomerNameFromContext(context)
  // Only pad recipient-less lines with the draft's own customer context (avoid duplicating an
  // explicit `to` override the caller already listed above).
  if (!to) lines.push(...draftOrderContextLines(context))

  return Promise.resolve({
    kind: "draft_orders_send",
    title: `Email draft order ${draftName ?? id} invoice${to ? ` to ${to}` : customerName ? ` to ${customerName}` : ""}`,
    lines,
    links: externalLink(meta?.connectionIdentifier, "Open draft order in Shopify", `/admin/draft_orders/${numericId(p.id)}`),
  })
}

// ─── Products / variants / publishing ─────────────────────────────────────────

export function summarizeProductsCreate(params: unknown, _ctx?: unknown, meta?: SummarizerMeta): Promise<ApprovalSummaryShape> {
  const p = unwrapInput(params)
  const title = str(p.title) ?? "(untitled product)"
  const status = str(p.status) ?? "DRAFT"
  const vendor = str(p.vendor)
  const productType = str(p.productType)
  const tags = isArr(p.tags) ? p.tags.filter((t): t is string => typeof t === "string") : []

  const lines: string[] = [`Status: ${status}`]
  if (vendor) lines.push(`Vendor: ${vendor}`)
  if (productType) lines.push(`Type: ${productType}`)
  if (tags.length > 0) lines.push(`Tags: ${tags.join(", ")}`)

  return Promise.resolve({
    kind: "products_create",
    title: `Create product: ${title}`,
    lines,
    links: adminLink(meta, "Open products in Shopify", "products", null, "Open products in Shopify", "products"),
  })
}

export function summarizeProductsUpdate(params: unknown, _ctx?: unknown, meta?: SummarizerMeta): Promise<ApprovalSummaryShape> {
  const p = unwrapInput(params)
  const id = gidShort(p.id)
  const title = str(p.title)
  const lines: string[] = []
  if (title) lines.push(`Title -> ${title}`)
  if (str(p.status)) lines.push(`Status -> ${str(p.status)}`)
  if (str(p.vendor)) lines.push(`Vendor -> ${str(p.vendor)}`)
  if (str(p.productType)) lines.push(`Type -> ${str(p.productType)}`)
  const tags = isArr(p.tags) ? p.tags.filter((t): t is string => typeof t === "string") : []
  if (tags.length > 0) lines.push(`Tags -> ${tags.join(", ")}`)
  lines.push(...describeRemainingFields(p, ["title", "status", "vendor", "productType", "tags"]))
  if (lines.length === 0) lines.push("Only the product identifier is present in the payload")

  // Rich hydration: the CURRENT product title from context (products_get) — the title the caller
  // is about to change FROM (a new title in `params.title` above is the CHANGE, not the current
  // name), so the card names the real listing being edited even when the caller didn't pass one.
  const currentTitle = productTitleFromContext(meta?.context)
  const listedSince = productListedSinceLine(meta?.context)
  if (listedSince) lines.push(listedSince)

  return Promise.resolve({
    kind: "products_update",
    title: `Update product ${title ?? currentTitle ?? id}`,
    lines,
    links: adminLink(meta, "Open product in Shopify", "products", numericId(p.id), "Open products in Shopify", "products"),
  })
}

export function summarizeProductsDelete(params: unknown, _ctx?: unknown, meta?: SummarizerMeta): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const title = productTitleFromContext(meta?.context)
  const listedSince = productListedSinceLine(meta?.context)

  return Promise.resolve({
    kind: "products_delete",
    title: `Delete product ${title ?? gidShort(p.id)}`,
    subtitle: "This permanently removes the listing from the store",
    lines: [`Product: ${title ?? gidShort(p.id)}`, ...(listedSince ? [listedSince] : [])],
    links: adminLink(meta, "Open product in Shopify", "products", numericId(p.id), "Open products in Shopify", "products"),
  })
}

/** The channels a publish / unpublish will act on, from `products_publication_targets` (the
 *  summarizerContext of both tools): `attributes.publishTargets` / `attributes.unpublishTargets`,
 *  resolved by the SAME rules the handler applies on approval. Null when the context is absent. */
function publicationTargetsFromContext(
  context: unknown,
  key: "publishTargets" | "unpublishTargets",
): Array<{ name: string; publishDate: string | null }> | null {
  if (!isRec(context) || !isRec(context.attributes)) return null
  const raw = context.attributes[key]
  if (!isArr(raw)) return null
  return raw.filter(isRec).map((t) => ({
    name: str(t.name) ?? gidShort(t.publicationId),
    publishDate: str(t.publishDate),
  }))
}

export function summarizeProductsPublish(params: unknown, _ctx?: unknown, meta?: SummarizerMeta): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const id = gidShort(p.id)
  const targets = publicationTargetsFromContext(meta?.context, "publishTargets")
  // Never claim a channel the call will not reach: with no hydrated context the card states the
  // rule the handler applies, not a "default sales channel" that does not exist.
  const lines =
    targets && targets.length > 0
      ? targets.map((t) => `Sales channel: ${t.name}${t.publishDate ? ` at ${t.publishDate}` : ""}`)
      : ["Sales channels: every channel this product is not on yet (the list could not be loaded)"]

  const title = productTitleFromContext(meta?.context)
  const listedSince = productListedSinceLine(meta?.context)
  if (listedSince) lines.push(listedSince)

  return Promise.resolve({
    kind: "products_publish",
    title: `Publish product ${title ?? id}`,
    ...(targets && targets.length > 0
      ? { subtitle: `Puts the listing on ${targets.length === 1 ? "1 sales channel" : `${targets.length} sales channels`}` }
      : {}),
    lines,
    links: adminLink(meta, "Open product in Shopify", "products", numericId(p.id), "Open products in Shopify", "products"),
  })
}

export function summarizeProductsUnpublish(params: unknown, _ctx?: unknown, meta?: SummarizerMeta): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const id = gidShort(p.id)
  const targets = publicationTargetsFromContext(meta?.context, "unpublishTargets")
  const lines =
    targets && targets.length > 0
      ? targets.map((t) => `Sales channel: ${t.name}`)
      : ["Sales channels: every channel this product is on (the list could not be loaded)"]

  const title = productTitleFromContext(meta?.context)
  const listedSince = productListedSinceLine(meta?.context)
  if (listedSince) lines.push(listedSince)

  return Promise.resolve({
    kind: "products_unpublish",
    title: `Unpublish product ${title ?? id}`,
    subtitle: "Hides the listing from these sales channels; the product record is kept",
    lines,
    links: adminLink(meta, "Open product in Shopify", "products", numericId(p.id), "Open products in Shopify", "products"),
  })
}


export function summarizeVariantsCreate(params: unknown): Promise<ApprovalSummaryShape> {
  const p = unwrapInput(params)
  const productId = gidShort(p.productId)
  const price = str(p.price)
  const sku = isRec(p.inventoryItem) ? str(p.inventoryItem.sku) : null

  const lines: string[] = [`Product: ${productId}`]
  if (price) lines.push(`Price: ${price}`)
  if (str(p.compareAtPrice)) lines.push(`Compare-at price: ${str(p.compareAtPrice)}`)
  if (sku) lines.push(`SKU: ${sku}`)
  if (str(p.barcode)) lines.push(`Barcode: ${str(p.barcode)}`)

  return Promise.resolve({
    kind: "variants_create",
    title: `Create variant on product ${productId}${price ? ` at ${price}` : ""}`,
    lines,
  })
}

export function summarizeVariantsUpdate(params: unknown, _ctx?: unknown, meta?: SummarizerMeta): Promise<ApprovalSummaryShape> {
  const p = unwrapInput(params)
  const id = gidShort(p.id)
  const lines: string[] = []
  if (str(p.price)) lines.push(`Price -> ${str(p.price)}`)
  if (str(p.compareAtPrice)) lines.push(`Compare-at price -> ${str(p.compareAtPrice)}`)
  if (str(p.barcode)) lines.push(`Barcode -> ${str(p.barcode)}`)
  if (str(p.inventoryPolicy)) lines.push(`Inventory policy -> ${str(p.inventoryPolicy)}`)
  if (isRec(p.inventoryItem) && str(p.inventoryItem.sku)) lines.push(`SKU -> ${str(p.inventoryItem.sku)}`)
  lines.push(
    ...describeRemainingFields(p, ["price", "compareAtPrice", "barcode", "inventoryPolicy", "inventoryItem.sku"]),
  )
  if (lines.length === 0) lines.push("Only the variant identifier is present in the payload")

  const label = variantLabelFromContext(meta?.context)

  return Promise.resolve({
    kind: "variants_update",
    title: `Update variant ${label ?? id}`,
    lines,
  })
}

export function summarizeVariantsDelete(params: unknown, _ctx?: unknown, meta?: SummarizerMeta): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const label = variantLabelFromContext(meta?.context)
  return Promise.resolve({
    kind: "variants_delete",
    title: `Delete variant ${label ?? gidShort(p.id)}`,
    subtitle: "This permanently removes the variant",
    lines: [`Variant: ${label ?? gidShort(p.id)}`],
  })
}

// ─── Inventory ─────────────────────────────────────────────────────────────────

export function summarizeInventoryAdjust(params: unknown): Promise<ApprovalSummaryShape> {
  const p = unwrapInput(params)
  const reason = str(p.reason) ?? "(no reason given)"
  const name = str(p.name)
  const changes = isArr(p.changes) ? (p.changes.filter(isRec) as Record<string, unknown>[]) : []

  const lines: string[] = [`Reason: ${reason}`]
  if (name) lines.push(`Ledger: ${name}`)
  for (const c of changes.slice(0, 6)) {
    const delta = typeof c.delta === "number" ? c.delta : Number(c.delta ?? 0)
    lines.push(`${delta > 0 ? "+" : ""}${delta} on item ${gidShort(c.inventoryItemId)} at location ${gidShort(c.locationId)}`)
  }
  if (changes.length > 6) lines.push(`...and ${changes.length - 6} more line(s)`)

  return Promise.resolve({
    kind: "inventory_adjust",
    title: `Adjust inventory (${changes.length} item${changes.length === 1 ? "" : "s"})`,
    subtitle: reason,
    lines,
  })
}

export function summarizeInventorySetOnHand(params: unknown): Promise<ApprovalSummaryShape> {
  const p = unwrapInput(params)
  const reason = str(p.reason) ?? "(no reason given)"
  const changes = isArr(p.setQuantities) ? (p.setQuantities.filter(isRec) as Record<string, unknown>[]) : []

  const lines: string[] = [`Reason: ${reason}`]
  for (const c of changes.slice(0, 6)) {
    lines.push(`Set item ${gidShort(c.inventoryItemId)} at location ${gidShort(c.locationId)} to ${c.quantity ?? "?"}`)
  }
  if (changes.length > 6) lines.push(`...and ${changes.length - 6} more line(s)`)

  return Promise.resolve({
    kind: "inventory_set_on_hand",
    title: `Set on-hand inventory (${changes.length} item${changes.length === 1 ? "" : "s"})`,
    subtitle: reason,
    lines,
  })
}

// ─── Discounts ──────────────────────────────────────────────────────────────────

export function summarizeDiscountsCreate(params: unknown): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const d = isRec(p.basicCodeDiscount) ? p.basicCodeDiscount : p
  const code = str(d.code) ?? "(no code)"
  // The lines describe the NORMALISED discount the handler will send, not the raw payload.
  return Promise.resolve({
    kind: "discounts_create",
    title: `Create discount code: ${code}`,
    lines: describeDiscountInput(p, "create"),
  })
}

export function summarizeDiscountsBulkCreate(params: unknown): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const count = typeof p.count === "number" ? p.count : Number(p.count ?? 0)
  const prefix = str(p.codePrefix) ?? "(no prefix)"

  return Promise.resolve({
    kind: "discounts_bulk_create",
    title: `Bulk-create ${count} discount code${count === 1 ? "" : "s"} (prefix "${prefix}")`,
    lines: [`Prefix: ${prefix}`, ...describeDiscountInput(p, "bulk")],
  })
}

export function summarizeDiscountsUpdate(params: unknown): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const id = gidShort(p.id)
  const d = isRec(p.basicCodeDiscount) ? p.basicCodeDiscount : {}
  const lines = describeDiscountInput(p, "update")
  if (lines.length === 0) lines.push(...describeRemainingFields(d, []))
  if (lines.length === 0) lines.push("Only the discount identifier is present in the payload")

  return Promise.resolve({
    kind: "discounts_update",
    title: `Update discount ${str(d.code) ?? id}`,
    lines,
  })
}

export function summarizeDiscountsDelete(params: unknown): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  return Promise.resolve({
    kind: "discounts_delete",
    title: `Delete discount ${gidShort(p.id)}`,
    subtitle: "The code stops working for future orders",
    lines: [`Discount: ${gidShort(p.id)}`],
  })
}

// ─── Returns ────────────────────────────────────────────────────────────────────

export function summarizeReturnsRequest(params: unknown): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const input = isRec(p.input) ? p.input : {}
  const orderId = gidShort(input.orderId)
  const items = isArr(input.returnLineItems) ? (input.returnLineItems.filter(isRec) as Record<string, unknown>[]) : []

  const lines = items.map(
    (li) => `${li.quantity ?? "?"}x ${gidShort(li.fulfillmentLineItemId)}: ${str(li.returnReason) ?? "(no reason)"}`,
  )

  return Promise.resolve({
    kind: "returns_request",
    title: `Request return on order ${orderId} (${items.length} item${items.length === 1 ? "" : "s"})`,
    lines: lines.length > 0 ? lines : ["No return line items provided"],
  })
}

export function summarizeReturnsApprove(params: unknown): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  return Promise.resolve({
    kind: "returns_approve",
    title: `Approve return ${gidShort(p.id)}`,
    lines: [`Return: ${gidShort(p.id)}`],
  })
}

export function summarizeReturnsDecline(params: unknown): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const reason = str(p.declineReason)
  const lines = [`Return: ${gidShort(p.id)}`]
  if (reason) lines.push(`Reason: ${reason}`)

  return Promise.resolve({
    kind: "returns_decline",
    title: `Decline return ${gidShort(p.id)}`,
    lines,
  })
}

export function summarizeReturnsRefund(params: unknown): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const input = isRec(p.returnRefundInput) ? p.returnRefundInput : {}
  const returnId = gidShort(input.returnId)
  const items = isArr(input.returnRefundLineItems)
    ? (input.returnRefundLineItems.filter(isRec) as Record<string, unknown>[])
    : []
  const notify = input.notifyCustomer === true
  const shippingRefund = isRec(input.refundShipping) ? input.refundShipping : null

  const lines = items.map((li) => `Refund ${li.quantity ?? "?"}x ${gidShort(li.returnLineItemId)}`)
  if (shippingRefund?.fullRefund === true) lines.push("Also refund shipping in full")
  if (lines.length === 0) lines.push("Refund the return's full amount")

  return Promise.resolve({
    kind: "returns_refund",
    title: `Refund return ${returnId}`,
    subtitle: notify ? "Customer WILL be notified" : "No customer notification",
    lines,
  })
}

export function summarizeReturnsClose(params: unknown): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  return Promise.resolve({
    kind: "returns_close",
    title: `Close return ${gidShort(p.id)}`,
    lines: [`Return: ${gidShort(p.id)}`],
  })
}

// ─── Customers ──────────────────────────────────────────────────────────────────

export function summarizeCustomersUpdate(params: unknown, _ctx?: unknown, meta?: SummarizerMeta): Promise<ApprovalSummaryShape> {
  const p = unwrapInput(params)
  const id = gidShort(p.id)
  const name = [str(p.firstName), str(p.lastName)].filter(Boolean).join(" ") || null
  const lines: string[] = []
  if (str(p.email)) lines.push(`Email -> ${str(p.email)}`)
  if (str(p.phone)) lines.push(`Phone -> ${str(p.phone)}`)
  if (str(p.note)) lines.push(`Note -> ${str(p.note)}`)
  const tags = isArr(p.tags) ? p.tags.filter((t): t is string => typeof t === "string") : []
  if (tags.length > 0) lines.push(`Tags -> ${tags.join(", ")}`)
  if (isArr(p.addresses) && p.addresses.length > 0) lines.push(`Address change(s): ${p.addresses.length}`)
  lines.push(
    ...describeRemainingFields(p, ["email", "phone", "note", "tags", "addresses", "firstName", "lastName"]),
  )
  if (lines.length === 0) lines.push("Only the customer identifier is present in the payload")

  // Rich hydration: the customer's CURRENT name/email (customers_get) — the caller's `name` above
  // is the CHANGE being made, so fall back to the current identity when no new name was passed.
  const currentName = customerNameFromContext(meta?.context)
  lines.push(...customerContextLines(meta?.context))

  return Promise.resolve({
    kind: "customers_update",
    title: `Update customer ${name ?? currentName ?? id}`,
    lines,
    links: adminLink(meta, "Open customer in Shopify", "customers", numericId(p.id), "Open customers in Shopify", "customers"),
  })
}

function marketingConsentLines(input: Record<string, unknown>, key: "emailMarketingConsent" | "smsMarketingConsent"): string[] {
  const consent = isRec(input[key]) ? (input[key] as Record<string, unknown>) : {}
  const state = str(consent.marketingState) ?? "(unspecified)"
  const optIn = str(consent.marketingOptInLevel)
  const lines = [`New state: ${state}`]
  if (optIn) lines.push(`Opt-in level: ${optIn}`)
  return lines
}

export function summarizeCustomersEmailMarketingConsentUpdate(
  params: unknown,
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const customerId = gidShort(p.customerId)
  const input = isRec(p.input) ? p.input : {}
  const lines = marketingConsentLines(input, "emailMarketingConsent")

  const name = customerNameFromContext(meta?.context)
  lines.push(...customerContextLines(meta?.context))

  return Promise.resolve({
    kind: "customers_email_marketing_consent_update",
    title: `Update email marketing consent for customer ${name ?? customerId}`,
    lines,
    links: adminLink(meta, "Open customer in Shopify", "customers", numericId(p.customerId), "Open customers in Shopify", "customers"),
  })
}

export function summarizeCustomersSmsMarketingConsentUpdate(
  params: unknown,
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const customerId = gidShort(p.customerId)
  const input = isRec(p.input) ? p.input : {}
  const lines = marketingConsentLines(input, "smsMarketingConsent")

  const name = customerNameFromContext(meta?.context)
  lines.push(...customerContextLines(meta?.context))

  return Promise.resolve({
    kind: "customers_sms_marketing_consent_update",
    title: `Update SMS marketing consent for customer ${name ?? customerId}`,
    lines,
    links: adminLink(meta, "Open customer in Shopify", "customers", numericId(p.customerId), "Open customers in Shopify", "customers"),
  })
}

export function summarizeCustomersTag(params: unknown, _ctx?: unknown, meta?: SummarizerMeta): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const customerId = gidShort(p.customerId)
  const tags = isArr(p.tags) ? p.tags.filter((t): t is string => typeof t === "string") : []
  const op = str(p.op) === "remove" ? "remove" : "add"

  const name = customerNameFromContext(meta?.context)
  const lines = [
    `${op === "remove" ? "Remove" : "Add"}: ${tags.length > 0 ? tags.join(", ") : "(no tags given)"}`,
    ...customerContextLines(meta?.context),
  ]

  return Promise.resolve({
    kind: "customers_tag",
    title: `${op === "remove" ? "Remove" : "Add"} tag${tags.length === 1 ? "" : "s"} on customer ${name ?? customerId}`,
    lines,
    links: adminLink(meta, "Open customer in Shopify", "customers", numericId(p.customerId), "Open customers in Shopify", "customers"),
  })
}

// ─── Metafields ─────────────────────────────────────────────────────────────────

export function summarizeMetafieldsSet(params: unknown): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const metafields = isArr(p.metafields) ? (p.metafields.filter(isRec) as Record<string, unknown>[]) : []

  const lines = metafields
    .slice(0, 6)
    .map((m) => `${gidShort(m.ownerId)}: ${str(m.namespace)}.${str(m.key)} (${str(m.type)}) = ${str(m.value)}`)
  if (metafields.length > 6) lines.push(`...and ${metafields.length - 6} more field(s)`)

  return Promise.resolve({
    kind: "metafields_set",
    title: `Set ${metafields.length} metafield${metafields.length === 1 ? "" : "s"}`,
    lines: lines.length > 0 ? lines : ["No metafields provided"],
  })
}

export function summarizeMetafieldsDelete(params: unknown): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  return Promise.resolve({
    kind: "metafields_delete",
    title: `Delete metafield ${str(p.namespace)}.${str(p.key)} on ${gidShort(p.ownerId)}`,
    lines: [`Owner: ${gidShort(p.ownerId)}`, `Key: ${str(p.namespace)}.${str(p.key)}`],
  })
}

// ─── Admin / connection / staff overrides / scope seeding ──────────────────────

export function summarizeApplySeedSuggestion(params: unknown): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const scopes = isArr(p.scopes) ? p.scopes.filter((s): s is string => typeof s === "string") : []

  return Promise.resolve({
    kind: "apply_seed_suggestion",
    title: `Grant ${scopes.length} Shopify scope${scopes.length === 1 ? "" : "s"} to a user`,
    subtitle: `User: ${str(p.liaisonUserId) ?? "(unknown)"}`,
    lines: scopes.length > 0 ? scopes : ["No scopes specified"],
  })
}

export function summarizeConnectionDisconnect(_params: unknown): Promise<ApprovalSummaryShape> {
  return Promise.resolve({
    kind: "connection_disconnect",
    title: "Disconnect this Liaison instance from Shopify",
    subtitle: "Every Shopify tool becomes unavailable until reconnected",
    lines: ["All agent access to Shopify orders, products, and customers stops immediately."],
  })
}

export function summarizeStaffOverridesUpsert(params: unknown): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const lines = [
    `Liaison user: ${str(p.liaisonUserId) ?? "(unknown)"}`,
    `Shopify staff id: ${str(p.shopifyStaffId) ?? "(unknown)"}`,
  ]
  const reason = str(p.reason)
  if (reason) lines.push(`Reason: ${reason}`)

  return Promise.resolve({
    kind: "staff_overrides_upsert",
    title: "Set Shopify staff-attribution override",
    lines,
  })
}

export function summarizeStaffOverridesDelete(params: unknown): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  return Promise.resolve({
    kind: "staff_overrides_delete",
    title: `Remove Shopify staff-attribution override ${str(p.id) ?? "(unknown)"}`,
    lines: [`Override id: ${str(p.id) ?? "(unknown)"}`],
  })
}
