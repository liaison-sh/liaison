// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pure (JSX-free) helpers for the Shopify list/home/panel UI. Kept in a `.ts`
// module — separate from the `.tsx` view files — so they are unit-testable
// under the bundled-app `bun:test` runner, which transpiles JSX to the React
// runtime and therefore cannot import a `.tsx` component module. The view files
// import these helpers; the tests import them directly.
import { app } from "@liaison/host"

// ─────────────────────────────────────────────────────────────────────────
// listCountLabel — honest header count for a Shopify list view.
//
// Shopify's GraphQL connections expose NO exact total, only cursor pagination.
// So a full page must NOT render as a bare exact count (which reads as "this
// many total"); when a further page exists we render "N+" to mean "at least
// N". With no next page, the loaded length IS the total for the current query.
// Returns null while loading so the header hides the count.
// ─────────────────────────────────────────────────────────────────────────
export function listCountLabel(loaded: number | null | undefined, hasMore: boolean): string | null {
  if (loaded === null || loaded === undefined) return null
  return hasMore ? `${loaded}+` : `${loaded}`
}

// ─────────────────────────────────────────────────────────────────────────
// loadShopDomain — coalesced home_load probe for the connected store domain.
//
// The home tab, all four list views, and every detail panel that needs the
// store domain share a SINGLE network round-trip instead of each issuing its
// own home_load bundle (the N+1 the deep review flagged). The in-flight promise
// is memoised at module scope; a failure clears the cache so a later mount can
// retry rather than caching null forever.
//
// `null` = resolved-but-no-domain (loading finished — degrade gracefully).
// ─────────────────────────────────────────────────────────────────────────
let shopDomainProbe: Promise<string | null> | null = null

export function loadShopDomain(): Promise<string | null> {
  if (!shopDomainProbe) {
    shopDomainProbe = app
      .invokeTool<{ connection?: { shopDomain?: string | null } }>("home_load", {})
      .then((res) => res?.connection?.shopDomain ?? null)
      .catch(() => {
        shopDomainProbe = null
        return null
      })
  }
  return shopDomainProbe
}

// ─────────────────────────────────────────────────────────────────────────
// Merged orders list — filter chip predicates.
//
// The orders list shows regular orders AND draft orders in one table, with a
// segmented row of filter chips above it. `OrderRow` is the minimal shape the
// predicates below need (a subset of the merged row the view builds from
// `orders_search` + `draft_orders_list` NormalizedHits) — kept JSX-free here
// so it is directly unit-testable without mounting a component.
// ─────────────────────────────────────────────────────────────────────────
export type OrderRowKind = "order" | "draft"

export interface OrderRowLike {
  kind: OrderRowKind
  fulfillmentStatus?: string | null
  financialStatus?: string | null
  cancelledAt?: string | null
}

export type OrderFilterKey = "all" | "open" | "unfulfilled" | "cancelled" | "refunded" | "drafts"

export const ORDER_FILTERS: ReadonlyArray<{ key: OrderFilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "unfulfilled", label: "Unfulfilled" },
  { key: "cancelled", label: "Cancelled" },
  { key: "refunded", label: "Refunded" },
  { key: "drafts", label: "Drafts" },
]

// Shopify's Admin GraphQL returns `displayFinancialStatus` / `displayFulfillmentStatus`
// as UPPERCASE enum values ("PAID", "REFUNDED", "PARTIALLY_REFUNDED", "UNFULFILLED",
// "PARTIALLY_FULFILLED", …) which `orders_search` surfaces verbatim. Normalize to
// lowercase before matching so the predicates work on real store data (a
// case-sensitive compare against the raw uppercase value silently matched nothing).
export function normOrderStatus(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase()
}

/**
 * Human labels for the status enums Shopify returns.
 *
 * The API speaks SCREAMING_SNAKE ("PARTIALLY_FULFILLED") and the order cards
 * printed it straight through, so a customer-facing card read PARTIALLY_
 * FULFILLED. Every status a pill can carry passes through here.
 */
const STATUS_LABELS: Readonly<Record<string, string>> = {
  fulfilled: "Fulfilled",
  unfulfilled: "Unfulfilled",
  partially_fulfilled: "Partially fulfilled",
  scheduled: "Scheduled",
  on_hold: "On hold",
  restocked: "Restocked",
  paid: "Paid",
  partially_paid: "Partially paid",
  pending: "Pending",
  authorized: "Authorized",
  refunded: "Refunded",
  partially_refunded: "Partially refunded",
  voided: "Voided",
  expired: "Expired",
  open: "Open",
  closed: "Closed",
  cancelled: "Cancelled",
  canceled: "Cancelled",
  completed: "Completed",
  active: "Active",
  draft: "Draft",
  invoice_sent: "Invoice sent",
  in_progress: "In progress",
  running: "Running",
  requested: "Requested",
  declined: "Declined",
}

/**
 * The label a status pill shows. An enum the map does not carry still reads as
 * a phrase rather than as a constant: underscores and hyphens become spaces
 * and the first letter is capitalised, so a status Shopify adds tomorrow is
 * legible on the day it appears.
 */
export function statusLabel(status: string | null | undefined): string {
  const key = normOrderStatus(status).replace(/[\s-]+/g, "_")
  if (!key) return ""
  const known = STATUS_LABELS[key]
  if (known) return known
  const words = key.split("_").filter(Boolean).join(" ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * Classify a merged order/draft row against one filter chip (pure —
 * unit-testable without rendering). All status comparisons are case-insensitive.
 * Mirrors the bucket rules the view's segmented control enforces:
 *   - all         → everything
 *   - open        → orders only, not cancelled, financialStatus not
 *                   refunded/partially_refunded/voided
 *   - unfulfilled → orders only, not cancelled, not fully fulfilled
 *                   (unfulfilled / partially fulfilled / on hold / absent)
 *   - cancelled   → orders only, cancelledAt truthy
 *   - refunded    → orders only, financialStatus refunded/partially_refunded
 *   - drafts      → draft rows only
 */
export function orderMatchesFilter(row: OrderRowLike, filter: OrderFilterKey): boolean {
  if (filter === "all") return true
  if (filter === "drafts") return row.kind === "draft"
  if (row.kind !== "order") return false
  const cancelled = Boolean(row.cancelledAt)
  if (filter === "cancelled") return cancelled
  const fin = normOrderStatus(row.financialStatus)
  if (filter === "refunded") return fin === "refunded" || fin === "partially_refunded"
  if (filter === "open") {
    return !cancelled && fin !== "refunded" && fin !== "partially_refunded" && fin !== "voided"
  }
  // unfulfilled — any order not fully fulfilled (and not cancelled).
  return !cancelled && normOrderStatus(row.fulfillmentStatus) !== "fulfilled"
}

// ─────────────────────────────────────────────────────────────────────────
// formatHoursHuman — a coarse, human age from a raw hour count.
//
// Attention tiles carry `hoursSincePlaced` as a raw number; rendering it as
// "33660h" (3.8 years) is unreadable. Step the unit up as the age grows:
//   - under 48h  -> hours   ("6h")
//   - under 60d  -> days    ("5d")
//   - under 24mo -> months  ("7mo", ~30.44-day months)
//   - otherwise  -> years   ("3y")
// Negative or non-finite inputs clamp to "0h".
// ─────────────────────────────────────────────────────────────────────────
export function formatHoursHuman(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "0h"
  if (hours < 48) return `${Math.floor(hours)}h`
  const days = Math.floor(hours / 24)
  if (days < 60) return `${days}d`
  const months = Math.floor(days / 30.44)
  if (months < 24) return `${months}mo`
  const years = Math.floor(days / 365.25)
  return `${years}y`
}

// ─────────────────────────────────────────────────────────────────────────
// formatShopifyMoney — normalize a Shopify decimal-MAJOR money string to the
// currency's ISO 4217 minor-digit count. Shopify's Money.amount arrives as a
// major-unit decimal string with variable precision ("0.0", "23900.00"); a bare
// "0.0 EUR" reads as broken. Render EUR/USD with two decimals, zero-decimal
// currencies (JPY, KRW, ...) with none. Returns "" for absent/unparseable input
// so callers can hide the cell.
// ─────────────────────────────────────────────────────────────────────────
const SHOPIFY_ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "HUF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
])

export function formatShopifyMoney(
  amount: string | number | null | undefined,
  currency?: string | null,
): string {
  if (amount === null || amount === undefined || amount === "") return ""
  const n = typeof amount === "number" ? amount : Number(amount)
  if (!Number.isFinite(n)) return ""
  const exp = currency && SHOPIFY_ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2
  return n.toFixed(exp)
}

// ─────────────────────────────────────────────────────────────────────────
// Orders column declaration (phone + desktop, one source of truth).
//
// The view renders through `CardTable` from `@liaison/app-ui`, which reads the
// ROLE of each column: a dense table from 640 px up, a stack of cards below
// it. The roles are declared here, JSX-free, so the projection is unit-testable
// without mounting the view:
//   anchor     the line a row is identified by (bold, card line 1)
//   secondary  who or what the row belongs to (card line 2)
//   meta       the numbers and states it is judged by (card lines 1 and 3)
//   fold       detail, behind the card's chevron (a plain column on desktop)
// ─────────────────────────────────────────────────────────────────────────
export type ListColumnRole = "anchor" | "secondary" | "meta" | "fold"

export interface ListColumn {
  key: string
  header: string
  role: ListColumnRole
  align?: "right"
  numeric?: boolean
}

export const ORDER_COLUMNS: ListColumn[] = [
  { key: "order", header: "Order", role: "anchor" },
  { key: "customer", header: "Customer", role: "secondary" },
  { key: "items", header: "Items", role: "meta" },
  { key: "total", header: "Total", role: "meta", align: "right", numeric: true },
  { key: "status", header: "Status", role: "meta" },
  { key: "tags", header: "Tags", role: "fold" },
  { key: "invoice", header: "Invoice", role: "fold" },
  { key: "date", header: "Date", role: "meta", align: "right" },
]

// ─────────────────────────────────────────────────────────────────────────
// Orders list — tags, "Has items to ship", cart summary.
//
// `orders_search` hits carry the order's tags and its first line items (sku,
// title, quantity, requiresShipping). The cart summary ("1×E2, 2×FS") reads
// each line's SKU through the org's product short codes (the kernel's product
// attributes, key `short_code`, fetched with this app's `products_short_codes`
// tool): whichever app set them, this app never knows which. A SKU with no
// code is NEVER given a made-up one: it shows as "1×?" with its product title
// on hover, because a wrong code silently mislabels what is in the box.
// ─────────────────────────────────────────────────────────────────────────

export interface OrderLineLike {
  sku?: string | null
  title?: string | null
  quantity?: number | null
  /** What is still on the order (removed items excluded); the summary counts this one. */
  currentQuantity?: number | null
  /** Shopify's LineItem.requiresShipping; absent on an older hit (= unknown). */
  requiresShipping?: boolean | null
}

/** The order's own tags, without blanks and the internal seed markers. */
export function orderTags(tags: ReadonlyArray<string> | null | undefined): string[] {
  return (tags ?? [])
    .map((t) => t.trim())
    .filter((t) => t !== "" && t !== "liaison-seed" && !t.startsWith("liaison-seed-"))
}

/** A line's quantity still on the order: currentQuantity, else quantity, else 1. */
function lineQty(li: OrderLineLike): number {
  const q = typeof li.currentQuantity === "number" ? li.currentQuantity : li.quantity
  return typeof q === "number" && Number.isFinite(q) ? q : 1
}

/**
 * "Has items to ship": a regular order that requires shipping. The order's own
 * `requiresShipping` (Shopify computes it over every line) decides when the hit
 * carries it; otherwise the fetched lines do: one that requires shipping is
 * enough, and a line whose flag is unknown counts as shippable, as does an order
 * with more lines than were fetched. Hiding an order that has a parcel to send is
 * worse than showing one that has none. A draft is out.
 */
export function orderHasItemsToShip(row: {
  kind: OrderRowKind
  requiresShipping?: boolean | null
  lineItemsMore?: boolean | null
  lineItems?: ReadonlyArray<OrderLineLike> | null
}): boolean {
  if (row.kind !== "order") return false
  if (typeof row.requiresShipping === "boolean") return row.requiresShipping
  if (row.lineItemsMore === true) return true
  return (row.lineItems ?? []).some((li) => li.requiresShipping !== false && lineQty(li) > 0)
}

/**
 * "+N more" after the cart summary when the order has more lines than were
 * fetched: N items when the order's item count is known, else "+ more".
 */
export function cartMoreLabel(row: {
  lineItems?: ReadonlyArray<OrderLineLike> | null
  lineItemsMore?: boolean | null
  itemsQuantity?: number | null
}): string | null {
  if (row.lineItemsMore !== true) return null
  if (typeof row.itemsQuantity === "number" && Number.isFinite(row.itemsQuantity)) {
    const shown = (row.lineItems ?? []).reduce((n, li) => n + Math.max(0, lineQty(li)), 0)
    const more = row.itemsQuantity - shown
    if (more > 0) return `+${more} more`
  }
  return "+ more"
}

export interface CartEntry {
  /** "2×FS", or "1×?" when the line's SKU has no short code. */
  label: string
  /** The short code, null when unknown. */
  code: string | null
  qty: number
  /** The product title(s) behind the entry, for the hover text. */
  title: string
}

/**
 * The abbreviated cart: one entry per short code (quantities summed, first
 * appearance order), and one "N×?" entry per unknown product (by SKU, else by
 * title). `codes` maps a SKU to its short code.
 */
export function cartSummary(
  lines: ReadonlyArray<OrderLineLike>,
  codes: Readonly<Record<string, string>>,
): CartEntry[] {
  const out: CartEntry[] = []
  const byKey = new Map<string, CartEntry>()
  for (const li of lines) {
    const qty = lineQty(li)
    if (qty <= 0) continue
    const sku = li.sku?.trim() ?? ""
    const title = li.title?.trim() || sku || "Unnamed item"
    const code = sku !== "" ? (codes[sku]?.trim() ?? "") : ""
    const key = code !== "" ? `code:${code.toUpperCase()}` : `unknown:${sku !== "" ? sku : title}`
    const existing = byKey.get(key)
    if (existing) {
      existing.qty += qty
      if (!existing.title.split(", ").includes(title)) existing.title += `, ${title}`
      continue
    }
    const entry: CartEntry = { label: "", code: code !== "" ? code : null, qty, title }
    byKey.set(key, entry)
    out.push(entry)
  }
  for (const e of out) e.label = `${e.qty}×${e.code ?? "?"}`
  return out
}

/** Every distinct SKU on a set of order lines (what `products_short_codes` is asked for). */
export function lineSkus(lines: ReadonlyArray<OrderLineLike>): string[] {
  return [...new Set(lines.map((li) => li.sku?.trim() ?? "").filter((s) => s !== ""))]
}

/** Compact absolute date for a list row ("2 Sep"). Empty for absent/unparseable
 *  input so the cell can render a dash instead of "Invalid Date". */
export function formatListDate(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const ListHelpersTestAccess = {
  /** Reset the module-level shop-domain coalescing cache between unit tests. */
  resetShopDomainProbe(): void {
    shopDomainProbe = null
  },
}
