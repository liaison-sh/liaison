// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Metrics input-gathering layer (§2.2, T7). Pulls every raw input a
// registry formula needs, tagging each source with a lineage descriptor and
// a stale/unavailable flag on failure — NEVER a throw, NEVER a fabricated
// number. Sources:
//   - Shopify net revenue: shopify:orders_search (cursor-paginated over the
//     placed-date window; current totals are refund-adjusted, so net revenue
//     needs no separate refunds read), split into DTC and B2B orders by the
//     order-level B2B rule (sku-classing.ts `orderHitIsB2b`).
//   - manual_spend total: this app's own `manual_spend` table (ctx.db).
//   - platform spend: Meta insights_query + Google google_insights_query.
//   - hub-DB attribution rows: database:db_read (preferred, curated) with a
//     database:db_query (admin scope, parameterized SELECT) fallback when
//     the hub catalog does not yet expose a curated read (§2.2 decision;
//     R1/R2) — every hub read degrades to a stale/unavailable lineage flag
//     on a connect-error, missing catalog entry, or missing table, never a
//     crash.
//
// Every gathered value is `{ value, lineage }`; `lineage.stale` or
// `lineage.unavailable` signal degraded input to the registry — formulas
// must still compute (possibly with a `null`/partial result) rather than
// throw, per the spec's graceful-degradation requirement.

import {
  DEFAULT_SKU_CLASSING_CONFIG,
  orderHitIsB2b,
  shopifyOrderKey,
  type SkuClassingConfig,
} from "./sku-classing"

export interface SourceLineage {
  source: string
  /** Exact tool/query calls made to gather this value, for audit. */
  calls: string[]
  period?: { start: string; end: string }
  /** True when the source could not be reached / returned nothing usable. */
  unavailable?: boolean
  /** True when the value is present but known-stale (e.g. cached, partial page). */
  stale?: boolean
  note?: string
}

export interface GatheredValue<T> {
  value: T
  lineage: SourceLineage
}

interface ExecuteToolCtx {
  executeTool?: (target: string, args: Record<string, unknown>) => Promise<{
    status: "completed" | "pending_approval" | "error"
    result?: unknown
    error?: { code: string; message: string; retryable?: boolean }
  }>
}

interface DbCtx {
  db?: {
    findMany(entity: string, opts?: Record<string, unknown>): Promise<unknown[]>
  }
}

export interface MetricsInputCtx extends ExecuteToolCtx, DbCtx {}

export interface Period {
  start: string
  end: string
}

// ─── Shopify net revenue ────────────────────────────────────────────────────

// A shopify:orders_search hit (the tool's real result envelope is
// { results: OrderHit[], nextCursor, totalCount }). `attributes.totalAmount`
// carries the order's CURRENT total (Shopify currentTotalPriceSet) — already
// refund-adjusted, so summing it yields net revenue without a per-refund read.
interface OrderHit {
  id?: string | null
  currency?: string | null
  attributes?: {
    /** The shopify app's verdict on the order (company order, B2B tag, legacy B2B sku suffix). */
    b2bOrder?: { b2b?: unknown } | null
    b2bCompany?: unknown
    tags?: unknown
    lineItems?: unknown
    totalAmount?: string | null
    /** Store-currency total (shopMoney) — uniform across orders. */
    totalAmountShop?: string | null
    shopCurrency?: string | null
  }
}
interface OrdersSearchResult {
  results?: unknown[]
  nextCursor?: string | null
  totalCount?: number
}

// The kernel lets one tool execution hold at most 2 nested tool calls at once
// and refuses a third outright (the reentrancy ceiling), so gatherAllInputs's
// parallel gathers must never have more than 2 cross-app calls in flight for
// the same ctx. Excess calls wait for a slot; no timer is needed.
export const MAX_INFLIGHT_CROSS_APP_CALLS = 2

interface CrossAppSlots {
  inflight: number
  waiting: Array<() => void>
}
const crossAppSlots = new WeakMap<object, CrossAppSlots>()

async function withCrossAppSlot<T>(ctx: object, run: () => Promise<T>): Promise<T> {
  let slots = crossAppSlots.get(ctx)
  if (!slots) {
    slots = { inflight: 0, waiting: [] }
    crossAppSlots.set(ctx, slots)
  }
  const s = slots
  if (s.inflight >= MAX_INFLIGHT_CROSS_APP_CALLS) {
    await new Promise<void>((resolve) => s.waiting.push(resolve))
  } else {
    s.inflight++
  }
  try {
    return await run()
  } finally {
    // Hand the slot straight to the next waiter (inflight unchanged), or free it.
    const next = s.waiting.shift()
    if (next) next()
    else s.inflight--
  }
}

async function callCrossApp(
  ctx: ExecuteToolCtx,
  target: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; note: string }> {
  if (!ctx.executeTool) {
    return { ok: false, note: `${target}: cross-app calls not enabled on this ctx` }
  }
  return withCrossAppSlot(ctx, () => callCrossAppNow(ctx, target, args))
}

async function callCrossAppNow(
  ctx: ExecuteToolCtx,
  target: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; note: string }> {
  if (!ctx.executeTool) {
    return { ok: false, note: `${target}: cross-app calls not enabled on this ctx` }
  }
  try {
    const envelope = await ctx.executeTool(target, args)
    if (envelope.status === "error") {
      return { ok: false, note: `${target} failed: ${envelope.error?.message ?? "unknown error"}` }
    }
    if (envelope.status === "pending_approval") {
      return { ok: false, note: `${target} requires approval, so this input cannot be gathered right now` }
    }
    return { ok: true, result: envelope.result }
  } catch (e) {
    return { ok: false, note: `${target} threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// Prefer the store-currency (shopMoney) total: presentment totals are in the
// BUYER's currency, which varies per order (EUR/USD/GBP markets), so summing
// them across orders is only valid when every buyer happened to share one
// currency. shopMoney is uniform by construction. Falls back to presentment
// (with the MIXED degrade) for hits from an older shopify bundle that does
// not yet surface totalAmountShop.
function sumOrderTotals(hits: OrderHit[]): { sum: number; currency: string | null } {
  let sum = 0
  let currency: string | null = null
  const currencies = new Set<string>()
  for (const r of hits) {
    const shopAmt = r.attributes?.totalAmountShop
    const amt = Number(shopAmt ?? r.attributes?.totalAmount ?? 0)
    if (Number.isFinite(amt)) sum += amt
    const cur = shopAmt != null ? r.attributes?.shopCurrency : r.currency
    if (typeof cur === "string" && cur) currencies.add(cur)
  }
  if (currencies.size === 1) currency = [...currencies][0]!
  return { sum, currency: currencies.size > 1 ? "MIXED" : currency }
}

// Cursor-paginate shopify:orders_search over the placed-date window. Date
// bounds MUST go through created_at_min/created_at_max — a date term inside
// the `query` string is silently ignored by the tool (its schema says so),
// which would return the recent-orders page instead of the requested window.
const ORDERS_PAGE_SIZE = 50
const ORDERS_MAX_PAGES = 20

async function fetchOrdersWindow(
  ctx: ExecuteToolCtx,
  period: Period,
): Promise<
  | { ok: true; hits: OrderHit[]; totalCount: number; truncated: boolean }
  | { ok: false; note: string }
> {
  const hits: OrderHit[] = []
  let cursor: string | null = null
  let totalCount = 0
  for (let page = 0; page < ORDERS_MAX_PAGES; page++) {
    const resp = await callCrossApp(ctx, "shopify:orders_search", {
      created_at_min: period.start,
      created_at_max: period.end,
      limit: ORDERS_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    })
    if (!resp.ok) return resp
    const r = (resp.result ?? {}) as OrdersSearchResult
    hits.push(...((Array.isArray(r.results) ? r.results : []) as OrderHit[]))
    totalCount = typeof r.totalCount === "number" ? r.totalCount : hits.length
    cursor = typeof r.nextCursor === "string" && r.nextCursor.length > 0 ? r.nextCursor : null
    if (!cursor) return { ok: true, hits, totalCount, truncated: false }
  }
  return { ok: true, hits, totalCount, truncated: true }
}

/** Net Shopify revenue for a period, split by the order-level B2B rule. */
export interface ShopifyRevenueSplit {
  /** Net revenue of the non-B2B (DTC) orders. */
  dtc: GatheredValue<number | null>
  /** Net revenue of the B2B orders (recognised by the order itself, sku-classing.ts). */
  b2b: GatheredValue<number | null>
  /** Numeric ids of the B2B orders in the window (sku-classing.ts `shopifyOrderKey`). */
  b2bOrderIds: GatheredValue<string[]>
}

/**
 * Gather net Shopify revenue for a period, split into DTC and B2B orders.
 * Sums each order's CURRENT total (Shopify currentTotalPriceSet, surfaced by
 * orders_search as attributes.totalAmount) — that figure is already
 * refund-adjusted, so net revenue needs no separate refunds read
 * (shopify:refunds_get is a fetch-one-by-id tool, not a period listing). An
 * order is B2B as a whole when the order says so (`orderHitIsB2b`: the shopify
 * app's verdict, i.e. a company order, a B2B order tag, or a legacy B2B sku
 * suffix). A currency mismatch across returned order rows degrades both sums
 * to `null` (unavailable) rather than returning a confidently-quoted number
 * summed across incompatible currencies — a MIXED-currency sum is not a real
 * amount in any single unit, so formulas that require a number must degrade
 * (`unavailable`/`degraded:true`) rather than silently present a
 * currency-corrupted figure as trustworthy. `lineage.note` explains why.
 */
export async function gatherShopifyRevenueSplit(
  ctx: MetricsInputCtx,
  period: Period,
  config: SkuClassingConfig = DEFAULT_SKU_CLASSING_CONFIG,
): Promise<ShopifyRevenueSplit> {
  const calls = [
    `shopify:orders_search(created_at_min:${period.start}, created_at_max:${period.end}, cursor-paginated)`,
  ]
  const both = (lineage: SourceLineage, dtc: number | null, b2b: number | null, ids: string[]): ShopifyRevenueSplit => ({
    dtc: { value: dtc, lineage },
    b2b: { value: b2b, lineage },
    b2bOrderIds: { value: ids, lineage },
  })

  const ordersResp = await fetchOrdersWindow(ctx, period)
  if (!ordersResp.ok) {
    return both(
      { source: "shopify:orders_search", calls, period, unavailable: true, note: ordersResp.note },
      null,
      null,
      [],
    )
  }

  const dtcHits: OrderHit[] = []
  const b2bHits: OrderHit[] = []
  for (const hit of ordersResp.hits) (orderHitIsB2b(hit, config) ? b2bHits : dtcHits).push(hit)
  const b2bOrderIds = b2bHits.map((h) => shopifyOrderKey(h.id)).filter((k): k is string => k !== null).sort()
  const dtc = sumOrderTotals(dtcHits)
  const b2b = sumOrderTotals(b2bHits)
  const all = sumOrderTotals(ordersResp.hits)

  if (all.currency === "MIXED") {
    return both(
      {
        source: "shopify:orders_search",
        calls,
        period,
        unavailable: true,
        note:
          "Order rows spanned more than one currency. A MIXED-currency sum is not a real amount, so this input degrades to unavailable rather than quoting a currency-corrupted figure; verify currency alignment before re-running.",
      },
      null,
      null,
      b2bOrderIds,
    )
  }

  const split = `${b2bHits.length} of ${ordersResp.hits.length} order(s) are B2B by the order itself (a company order, a B2B order tag, or a legacy B2B sku suffix) and are counted as B2B, never as DTC.`
  if (ordersResp.truncated) {
    return both(
      {
        source: "shopify:orders_search",
        calls,
        period,
        stale: true,
        note: `Pagination stopped at ${ORDERS_MAX_PAGES * ORDERS_PAGE_SIZE} orders but the window holds ${ordersResp.totalCount}, so the sum covers only the paged subset (partial). ${split}`,
      },
      dtc.sum,
      b2b.sum,
      b2bOrderIds,
    )
  }

  return both(
    {
      source: "shopify:orders_search",
      calls,
      period,
      note: `Order totals are Shopify current totals (refund-adjusted), so refunds against these orders are already netted out. ${split}`,
    },
    dtc.sum,
    b2b.sum,
    b2bOrderIds,
  )
}

/** Net revenue of the period's DTC (non-B2B) orders; see `gatherShopifyRevenueSplit`. */
export async function gatherShopifyNetRevenue(
  ctx: MetricsInputCtx,
  period: Period,
): Promise<GatheredValue<number | null>> {
  return (await gatherShopifyRevenueSplit(ctx, period)).dtc
}

// ─── manual_spend total ─────────────────────────────────────────────────────

interface ManualSpendRow {
  amount?: number
  currency?: string
  period_start?: string
  period_end?: string
}

/**
 * Sum manual_spend rows whose period overlaps the requested window (this
 * app's own table, read via ctx.db — no cross-app call). Empty/unseeded
 * ledger returns 0 with an explicit unseeded note (§5.6 fallback), never a
 * silent skip.
 */
export async function gatherManualSpendTotal(
  ctx: MetricsInputCtx,
  period: Period,
): Promise<GatheredValue<number>> {
  if (!ctx.db) {
    return {
      value: 0,
      lineage: { source: "manual_spend", calls: [], period, unavailable: true, note: "app DB not available" },
    }
  }
  const rows = (await ctx.db.findMany("manual_spend", {})) as ManualSpendRow[]
  const overlapping = rows.filter((r) => {
    if (!r.period_start || !r.period_end) return false
    return r.period_start <= period.end && r.period_end >= period.start
  })
  const sum = overlapping.reduce((acc, r) => acc + (Number.isFinite(r.amount) ? Number(r.amount) : 0), 0)

  return {
    value: sum,
    lineage: {
      source: "manual_spend",
      calls: [`manual_spend_list(period_start<=${period.end}, period_end>=${period.start})`],
      period,
      note: rows.length === 0 ? "manual_spend ledger is unseeded (empty), so the total is 0 by absence, not by measurement." : undefined,
    },
  }
}

// ─── Platform spend (Meta + Google) ────────────────────────────────────────

interface InsightsCostRow {
  cost?: number
  spend?: number
}

// Both insight tools return an envelope, not a bare array: Meta's
// insights_query returns { data: rows, ... } and google_insights_query
// returns { rows, count, currency } (cost already micros-converted and
// flattened onto each row). Accept either envelope or a bare array.
function sumCost(result: unknown): number {
  let arr: InsightsCostRow[] = []
  if (Array.isArray(result)) {
    arr = result as InsightsCostRow[]
  } else if (result && typeof result === "object") {
    const env = result as { data?: unknown; rows?: unknown }
    if (Array.isArray(env.data)) arr = env.data as InsightsCostRow[]
    else if (Array.isArray(env.rows)) arr = env.rows as InsightsCostRow[]
  }
  return arr.reduce((acc, r) => acc + Number(r.cost ?? r.spend ?? 0), 0)
}

/**
 * Gather Meta + Google platform spend for a period via their own read tools
 * (in-app calls, not cross-app — insights_query / google_insights_query are
 * this app's own handlers, invoked here as plain function results the
 * caller already has, OR via ctx.executeTool("ads:...") if the metrics tool
 * runs in a context where only cross-app dispatch is available). Each
 * platform degrades independently — a missing Google connection does not
 * block Meta's figure.
 */
export async function gatherPlatformSpend(
  ctx: MetricsInputCtx,
  period: Period,
): Promise<{ meta: GatheredValue<number | null>; google: GatheredValue<number | null> }> {
  const calls = [`insights_query(level:account, time_range:${period.start}..${period.end})`]
  const metaResp = await callCrossApp(ctx, "ads:insights_query", {
    level: "account",
    time_range: { since: period.start, until: period.end },
  })
  const meta: GatheredValue<number | null> = metaResp.ok
    ? { value: sumCost(metaResp.result), lineage: { source: "meta:insights_query", calls, period } }
    : { value: null, lineage: { source: "meta:insights_query", calls, period, unavailable: true, note: metaResp.note } }

  const googleCalls = [`google_insights_query(${period.start}..${period.end})`]
  const googleResp = await callCrossApp(ctx, "ads:google_insights_query", {
    query:
      `SELECT metrics.cost_micros FROM campaign WHERE segments.date BETWEEN '${period.start}' AND '${period.end}'`,
  })
  // A NOT-CONNECTED Google arm is 0 spend BY ABSENCE (the app manages no
  // Google account, so it has no platform spend to count) — mirroring the
  // manual_spend unseeded-ledger precedent, with an explicit note so the
  // reader knows this is absence, not measurement. A CONNECTED-but-failing
  // read stays unavailable (spend exists but is unknown — degrading beats
  // understating spend and inflating MER). Detection is deterministic: the
  // tool RETURNS { error: { code: "google_not_connected" } } for that state
  // (throws are kernel-redacted for sandboxed handlers, so a message match
  // is kept only as a fallback for older bundles).
  const googleEnvErr =
    googleResp.ok && googleResp.result && typeof googleResp.result === "object"
      ? (googleResp.result as { error?: { code?: string; message?: string } }).error
      : undefined
  const googleNotConnected =
    googleEnvErr?.code === "google_not_connected" ||
    (!googleResp.ok && /not connected|not configured/i.test(googleResp.note))
  let google: GatheredValue<number | null>
  if (googleNotConnected) {
    google = {
      value: 0,
      lineage: {
        source: "google:google_insights_query",
        calls: googleCalls,
        period,
        note: "Google Ads is not connected, so spend is counted as 0 by absence (no managed account), not by measurement.",
      },
    }
  } else if (googleResp.ok && !googleEnvErr) {
    google = {
      value: sumCost(googleResp.result),
      lineage: { source: "google:google_insights_query", calls: googleCalls, period },
    }
  } else {
    google = {
      value: null,
      lineage: {
        source: "google:google_insights_query",
        calls: googleCalls,
        period,
        unavailable: true,
        note: googleResp.ok
          ? `${googleEnvErr?.code ?? "error"}: ${googleEnvErr?.message ?? "unknown"}`
          : googleResp.note,
      },
    }
  }

  return { meta, google }
}

// ─── Hub-DB attribution rows (commerce.purchase_attribution) ──────────────

export interface AttributionRow {
  shopify_order_id: string
  ad_consent: "granted" | "denied" | null
  utm_source_first?: string | null
  utm_source_last?: string | null
  fbclid?: string | null
  gclid?: string | null
  conversion_value_minor: number
  conversion_currency: string
  sku_class_breakdown?: Record<string, number> | null
  created_at: string
}

/**
 * Gather commerce.purchase_attribution rows for a period via the `database`
 * cross-app (§2.2 decision). Preferred: a curated read
 * (`purchase_attribution_for_period`) if the hub catalog exposes one;
 * fallback: `database:db_query` with a parameterized SELECT (still routed
 * through the read-only, grant-restricted connector — never a crash on
 * connect-absent, empty catalog, or missing table; those degrade to an
 * `unavailable` lineage flag).
 */
export async function gatherAttributionRows(
  ctx: MetricsInputCtx,
  period: Period,
): Promise<GatheredValue<AttributionRow[]>> {
  // Both database tools return an envelope, not a bare array: { rows,
  // truncated } on success or { error: { code, message } } on a
  // handler-level failure (the tool call itself still completes, so
  // callCrossApp's ok:true is not sufficient — the error envelope must be
  // treated as unavailable too).
  // The DB transport serializes bigint columns as STRINGS —
  // conversion_value_minor arrives as "900", and a strict
  // Number.isFinite("900") check downstream would silently zero every row.
  // Coerce at this boundary so every formula sees a real number.
  const normalizeRow = (raw: unknown): AttributionRow => {
    const r = raw as AttributionRow & { conversion_value_minor: unknown }
    const minor = Number(r.conversion_value_minor)
    return { ...r, conversion_value_minor: Number.isFinite(minor) ? minor : 0 }
  }
  const unwrapDbRows = (
    result: unknown,
  ): { ok: true; rows: AttributionRow[] } | { ok: false; note: string } => {
    if (Array.isArray(result)) return { ok: true, rows: result.map(normalizeRow) }
    if (result && typeof result === "object") {
      const env = result as { rows?: unknown; error?: { code?: string; message?: string } }
      if (env.error) {
        return { ok: false, note: `${env.error.code ?? "error"}: ${env.error.message ?? "unknown"}` }
      }
      if (Array.isArray(env.rows)) return { ok: true, rows: env.rows.map(normalizeRow) }
    }
    return { ok: false, note: "unexpected result shape (no rows array)" }
  }

  // The curated read compares `created_at <= :period_end` — a date-only end
  // bound would cut the window at that day's midnight and drop the whole
  // final day, so widen a plain YYYY-MM-DD end to its last instant.
  const periodEndTs = /^\d{4}-\d{2}-\d{2}$/.test(period.end)
    ? `${period.end}T23:59:59.999Z`
    : period.end
  const curated = await callCrossApp(ctx, "database:db_read", {
    name: "purchase_attribution_for_period",
    params: { period_start: period.start, period_end: periodEndTs },
  })
  const curatedRows = curated.ok ? unwrapDbRows(curated.result) : { ok: false as const, note: curated.note }
  if (curatedRows.ok) {
    return {
      value: curatedRows.rows,
      lineage: {
        source: "database:db_read(purchase_attribution_for_period)",
        calls: [`database:db_read(purchase_attribution_for_period, ${period.start}..${period.end})`],
        period,
      },
    }
  }

  // Fallback: db_query (§2.2 sanctioned fallback when the curated read is
  // not yet in the hub catalog — R1/R2). db_query takes ONLY a literal SQL
  // string (no bind params), so the period bounds are inlined — guarded by a
  // strict YYYY-MM-DD shape check so an agent-supplied period string can
  // never smuggle SQL into the literal.
  const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
  let fallbackRows: { ok: true; rows: AttributionRow[] } | { ok: false; note: string }
  if (!DATE_ONLY_RE.test(period.start) || !DATE_ONLY_RE.test(period.end)) {
    fallbackRows = {
      ok: false,
      note: "db_query fallback skipped: period bounds must be plain YYYY-MM-DD dates to inline safely",
    }
  } else {
    const fallback = await callCrossApp(ctx, "database:db_query", {
      sql:
        "SELECT shopify_order_id, ad_consent, utm_source_first, utm_source_last, fbclid, gclid, " +
        "conversion_value_minor, conversion_currency, sku_class_breakdown, created_at " +
        `FROM commerce.purchase_attribution WHERE created_at >= '${period.start}' AND created_at <= '${period.end} 23:59:59.999+00' ` +
        "ORDER BY shopify_order_id",
    })
    fallbackRows = fallback.ok ? unwrapDbRows(fallback.result) : { ok: false, note: fallback.note }
  }
  if (fallbackRows.ok) {
    return {
      value: fallbackRows.rows,
      lineage: {
        source: "database:db_query(commerce.purchase_attribution)",
        calls: [`database:db_query(commerce.purchase_attribution, ${period.start}..${period.end})`],
        period,
        note: "Used db_query fallback: the hub catalog does not yet expose a curated purchase_attribution_for_period read (see docs/sdk-gaps.md).",
      },
    }
  }

  return {
    value: [],
    lineage: {
      source: "database (unavailable)",
      calls: [],
      period,
      unavailable: true,
      note: `hub-DB attribution unreachable: ${curatedRows.note}; ${fallbackRows.note}`,
    },
  }
}

export interface MetricsInputs {
  /** Net revenue of the DTC orders (B2B orders, recognised by the order itself, excluded). */
  shopifyNetRevenue: GatheredValue<number | null>
  /** Net revenue of the B2B orders. */
  shopifyB2bNetRevenue: GatheredValue<number | null>
  /** Numeric ids of the window's B2B orders, to class attribution rows by order. */
  b2bOrderIds: GatheredValue<string[]>
  manualSpendTotal: GatheredValue<number>
  metaSpend: GatheredValue<number | null>
  googleSpend: GatheredValue<number | null>
  attribution: GatheredValue<AttributionRow[]>
}

/** Gather every input a registry formula might need, for one period, in one call. */
export async function gatherAllInputs(ctx: MetricsInputCtx, period: Period): Promise<MetricsInputs> {
  const [shopify, manualSpendTotal, platformSpend, attribution] = await Promise.all([
    gatherShopifyRevenueSplit(ctx, period),
    gatherManualSpendTotal(ctx, period),
    gatherPlatformSpend(ctx, period),
    gatherAttributionRows(ctx, period),
  ])

  return {
    shopifyNetRevenue: shopify.dtc,
    shopifyB2bNetRevenue: shopify.b2b,
    b2bOrderIds: shopify.b2bOrderIds,
    manualSpendTotal,
    metaSpend: platformSpend.meta,
    googleSpend: platformSpend.google,
    attribution,
  }
}
