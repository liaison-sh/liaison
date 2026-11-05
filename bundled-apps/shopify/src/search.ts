// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B7 — Shopify search handler.
//
// Dispatched via the kernel's sandbox-search bridge (`makeSandboxSearchHandler`
// in `liaison/apps/api/src/modules/search/external-bridge.ts`). The bridge
// calls into the bundle with `{ orgId, userId, query, filters }` and expects
// a `{ results: [...] }` payload back, where each row has:
//   { id, entity, title, market?, currency?, attributes? }
//
// The bridge tags each row with `app: "shopify"` on its way back out, so we
// don't have to.
//
// Routing rules (spec §3.7):
//   - email-shaped query (contains `@`)  → customer search only
//   - order-number-shaped (`#?\d+`)      → order search only
//   - otherwise (free text)              → fanout to orders + products + customers
//
// Handler contract (spec §4.4): the kernel invokes this with
// `({ query, limit, cursor, marketContext }, ctx)` and expects
// `{ results, nextCursor? }`. `marketContext` is forwarded into Shopify's
// GraphQL `query` arg by concatenation (`<base> market:<handle>`); Shopify
// ignores `market:` on entities that don't expose it (orders/products), so the
// fanout stays safe.
//
// Pagination (spec §3.7): each fanned-out source has its own opaque cursor.
// The handler packs the per-source Shopify `endCursor`s into a single opaque
// JSON cursor (`{ orders, products, customers }`), which the kernel passes back
// verbatim on the next-page call; the handler unpacks it and resumes each
// source independently. `nextCursor` is `null` when no source has a next page.
import type { AppContext } from "@liaison/app-sdk"
import {
  customers_search,
  orders_search,
  products_search,
} from "./reads"

interface SearchParams {
  query?: string
  limit?: number
  cursor?: string | null
  /** Market handle the caller is scoped to (spec §4.4). */
  marketContext?: string | null
  /**
   * Legacy shape — the pre-§4.4 bridge passed `{ filters }`. Accepted for
   * back-compat until the kernel bridge is migrated; `marketContext` wins.
   */
  filters?: Record<string, unknown>
}

interface SearchHit {
  id: string
  entity: string
  title: string
  market: string | null
  currency: string | null
  attributes: Record<string, unknown>
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ORDER_NUMBER_RE = /^#?\d+$/

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

/** Clamp a caller-supplied limit into the sandbox-safe 1..100 range. */
function clampLimit(input: unknown): number {
  if (typeof input !== "number" || !Number.isFinite(input)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(input)))
}

/** Resolve the market handle from §4.4 `marketContext` or the legacy `filters.market`. */
function resolveMarket(params: SearchParams): string | null {
  if (typeof params.marketContext === "string" && params.marketContext.length > 0) {
    return params.marketContext
  }
  const m = params.filters?.market
  return typeof m === "string" && m.length > 0 ? m : null
}

/** Append `market:<handle>` to the query string when a market is in scope. */
function withMarketFilter(query: string, market: string | null): string {
  if (!market) return query
  return query.length === 0 ? `market:${market}` : `${query} market:${market}`
}

interface SourceCursors {
  orders?: string | null
  products?: string | null
  customers?: string | null
}

/** Parse the opaque composite cursor; tolerate malformed input by ignoring it. */
function parseCursor(cursor: string | null | undefined): SourceCursors {
  if (typeof cursor !== "string" || cursor.length === 0) return {}
  try {
    const parsed = JSON.parse(cursor) as unknown
    if (parsed && typeof parsed === "object") return parsed as SourceCursors
  } catch {
    // Not a composite cursor — ignore and start from the beginning.
  }
  return {}
}

/** Pack per-source endCursors into an opaque cursor, or null when nothing pages. */
function packCursor(next: SourceCursors): string | null {
  const entries = Object.entries(next).filter(([, v]) => typeof v === "string" && v.length > 0)
  if (entries.length === 0) return null
  return JSON.stringify(Object.fromEntries(entries))
}

export async function searchHandler(
  params: SearchParams,
  ctx: AppContext,
): Promise<{ results: SearchHit[]; nextCursor: string | null }> {
  const query = typeof params.query === "string" ? params.query.trim() : ""
  if (query.length === 0) return { results: [], nextCursor: null }

  const limit = clampLimit(params.limit)
  const market = resolveMarket(params)
  const qWithMarket = withMarketFilter(query, market)
  const cursors = parseCursor(params.cursor)

  // Email-shaped → customers only.
  if (EMAIL_RE.test(query)) {
    const r = await customers_search({ query: qWithMarket, limit, cursor: cursors.customers ?? null }, ctx)
    return { results: r.results, nextCursor: packCursor({ customers: r.nextCursor }) }
  }

  // Order-number-shaped → orders only. Pass through the raw `#1234` token —
  // Shopify's order query syntax accepts `name:#1234` and bare `#1234`.
  if (ORDER_NUMBER_RE.test(query)) {
    const r = await orders_search({ query: qWithMarket, limit, cursor: cursors.orders ?? null }, ctx)
    return { results: r.results, nextCursor: packCursor({ orders: r.nextCursor }) }
  }

  // Free-text → fan out to orders + products + customers in parallel, each
  // resuming from its own source cursor.
  const [orders, products, customers] = await Promise.allSettled([
    orders_search({ query: qWithMarket, limit, cursor: cursors.orders ?? null }, ctx),
    products_search({ query: qWithMarket, limit, cursor: cursors.products ?? null }, ctx),
    customers_search({ query: qWithMarket, limit, cursor: cursors.customers ?? null }, ctx),
  ])

  const merged: SearchHit[] = []
  const next: SourceCursors = {}
  if (orders.status === "fulfilled") {
    merged.push(...orders.value.results)
    next.orders = orders.value.nextCursor
  }
  if (products.status === "fulfilled") {
    merged.push(...products.value.results)
    next.products = products.value.nextCursor
  }
  if (customers.status === "fulfilled") {
    merged.push(...customers.value.results)
    next.customers = customers.value.nextCursor
  }
  return { results: merged, nextCursor: packCursor(next) }
}

/**
 * Test access to this module's internal helpers, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const SearchTestAccess = {
  clampLimit,
  parseCursor,
  packCursor,
  resolveMarket,
  MAX_LIMIT,
}
