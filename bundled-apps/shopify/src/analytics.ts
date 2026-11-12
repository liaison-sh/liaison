// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `analytics_query` — a typed aggregate read. The agent supplies structured
// enum params (metric / period / groupBy); the injection-hardened builder
// assembles the ShopifyQL internally. When ShopifyQL is unavailable on the
// connected plan (parseErrors), the handler degrades to a BOUNDED in-context
// tally over `orders_search`, STATING the bound (`source:"bounded_tally"`,
// `partial:true`, `boundedTo:N`) — never presenting it as an authoritative total.
//
// Bundle-pure: only @liaison/app-sdk + sibling bundle modules.

import type { AppContext } from "@liaison/app-sdk"
import {
  type AnalyticsSpec,
  type AnalyticsTimeGrain,
  buildAnalyticsQuerySafe,
  isSessionsMetric,
} from "./lib/analytics-query-builder"
import { getShopifyClient } from "./lib/get-client"
import { orders_search } from "./reads"

const BOUNDED_TALLY_CAP = 250

interface ShopifyQlResult {
  shopifyqlQuery?: {
    // API 2026-01: tableData = { rows: JSON, columns: [{ name }] }; parseErrors = [String] (a
    // scalar list of ShopifyQL parse-error strings, NOT { code, message } objects).
    tableData?: unknown
    parseErrors?: string[]
  }
}

export async function analytics_query(
  params: AnalyticsSpec,
  ctx: AppContext,
): Promise<Record<string, unknown>> {
  // Non-throwing build: the allowlist rejects a non-allowlisted / malformed spec
  // by RETURNING a code, not by throwing. A synchronous `throw` raised in the
  // QuickJS sandbox before the first `await` does NOT settle the handler promise
  // and hangs the tool call to the execution deadline (a 504) — so the injection
  // rejection must be a value, never an exception, on this hot path.
  const built = buildAnalyticsQuerySafe(params)
  if (!built.ok) {
    // Surface the rejected spec (a non-allowlisted enum or a malformed period —
    // the surface an injection would target) at warn level. This is also load-
    // bearing for the runtime: the error path makes no other host bridge call, and
    // a QuickJS async handler that resolves WITHOUT any host round-trip does not
    // settle its promise (the tool call hangs to the execution deadline → a 504).
    // The bridged log both records the rejection and pumps the runtime so the
    // error envelope returns promptly.
    ctx.logger.warn("analytics_query rejected an invalid or non-allowlisted spec", {
      code: built.code,
    })
    return { error: { code: built.code, message: built.message } }
  }
  const client = await getShopifyClient(ctx)
  let data: ShopifyQlResult
  try {
    data = await client.query<ShopifyQlResult>(built.query, built.variables)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // `shopifyqlQuery` is gated behind the `read_reports` scope AND Shopify's
    // protected-customer-data (Level 2) approval. A store whose token predates
    // those grants gets a top-level GraphQL ACCESS_DENIED — thrown by the
    // client, previously escaping as an opaque redacted 500 ("Tool execution
    // failed"). Degrade to the same bounded tally the parse-error path uses,
    // carrying the real reason so the agent reports the limitation honestly.
    if (/access denied|ACCESS_DENIED|read_reports|protected customer data/i.test(message)) {
      if (isSessionsMetric(params.metric)) return sessionsUnavailable(params, message)
      ctx.logger.warn("analytics_query: ShopifyQL access denied — degrading to bounded tally", {
        reason: message,
      })
      return degradeToBoundedTally(
        params,
        ctx,
        `ShopifyQL analytics is not authorized for this store connection (${message}). ` +
          "The app needs the read_reports scope plus Shopify protected customer data approval, in the Shopify app's released configuration, then a reconnect.",
      )
    }
    // Any other upstream failure: return a structured error envelope (a RETURNED
    // error is deliberate app output and reaches the agent verbatim; a THROW from
    // an untrusted sandboxed app is redacted to "Tool execution failed" in prod).
    return { error: { code: "shopify_error", message: `Shopify analytics_query failed: ${message}` } }
  }
  const parseErrors = data.shopifyqlQuery?.parseErrors ?? []
  if (parseErrors.length > 0) {
    // Sessions have no order-based fallback: say so instead of tallying orders.
    if (isSessionsMetric(params.metric)) return sessionsUnavailable(params, parseErrors.join("; "))
    // ShopifyQL unavailable on this plan → bounded degrade over orders_search.
    return degradeToBoundedTally(params, ctx)
  }
  const table = data.shopifyqlQuery?.tableData ?? null
  const grain = params.timeGrain ?? null
  if (!grain) {
    return {
      source: "shopifyql",
      metric: params.metric,
      period: params.period,
      groupBy: params.groupBy,
      table,
    }
  }
  return {
    source: "shopifyql",
    metric: params.metric,
    period: params.period,
    groupBy: params.groupBy,
    timeGrain: grain,
    rows: timeSeriesRows(table, grain),
    table,
  }
}

function sessionsUnavailable(params: AnalyticsSpec, reason: string): Record<string, unknown> {
  return {
    error: {
      code: "sessions_unavailable",
      message:
        `Shopify ShopifyQL could not return ${params.metric} for this store (${reason}). ` +
        "Sessions come only from Shopify's sessions dataset (read_reports scope); there is no order-based estimate for them.",
    },
  }
}

/**
 * Flattens a ShopifyQL table into one object per row keyed by column name, and adds `date`:
 * the bucket's start as YYYY-MM-DD (the day itself, or the first day of the week or month).
 * Accepts both row shapes Shopify has used: objects keyed by column (API 2026-01 `rows`) and
 * positional arrays matched to `columns`.
 */
export function timeSeriesRows(
  table: unknown,
  grain: AnalyticsTimeGrain,
): Array<Record<string, unknown>> {
  if (!table || typeof table !== "object") return []
  const t = table as { rows?: unknown; rowData?: unknown; columns?: Array<{ name?: string }> }
  const raw = Array.isArray(t.rows) ? t.rows : Array.isArray(t.rowData) ? t.rowData : []
  const names = Array.isArray(t.columns) ? t.columns.map((c) => String(c?.name ?? "")) : []
  const out: Array<Record<string, unknown>> = []
  for (const r of raw) {
    let row: Record<string, unknown>
    if (Array.isArray(r)) {
      row = {}
      for (let i = 0; i < names.length; i++) row[names[i] as string] = r[i]
    } else if (r && typeof r === "object") {
      row = { ...(r as Record<string, unknown>) }
    } else {
      continue
    }
    const bucket = row[grain]
    row.date = typeof bucket === "string" ? bucket.slice(0, 10) : null
    out.push(row)
  }
  return out
}

/**
 * Bounded fallback: page `orders_search` up to a hard cap, tally in-context, and
 * return the result WITH the bound stated so the model reports the partial
 * honestly. Never an authoritative total.
 */
async function degradeToBoundedTally(
  params: AnalyticsSpec,
  ctx: AppContext,
  reason?: string,
): Promise<Record<string, unknown>> {
  // Date-scope through the REAL created_at_min/created_at_max params — a
  // `created_at:` term inside the query string is silently ignored by
  // orders_search (its own dateFilterNotice says exactly that), so the old
  // query-term form tallied the most-recent orders REGARDLESS of the period.
  let cursor: string | null = null
  let counted = 0
  let pages = 0
  let totalCount = 0
  do {
    const res: { results: unknown[]; nextCursor: string | null; totalCount?: number } =
      await orders_search(
        {
          created_at_min: params.period.since,
          created_at_max: `${params.period.until}T23:59:59Z`,
          limit: 50,
          cursor,
        },
        ctx,
      )
    counted += res.results.length
    totalCount = res.totalCount ?? totalCount
    cursor = res.nextCursor
    pages += 1
  } while (cursor && counted < BOUNDED_TALLY_CAP && pages < 10)
  return {
    source: "bounded_tally",
    partial: true,
    boundedTo: counted,
    totalCount,
    metric: params.metric,
    period: params.period,
    groupBy: params.groupBy,
    note:
      (reason ??
        "ShopifyQL is unavailable on this plan; this is a bounded in-context count over orders in the requested period, not an authoritative aggregate.") +
      " The tally is capped; totalCount is the server-side order count for the period." +
      (params.timeGrain ? ` It is one figure for the whole period, not split by ${params.timeGrain}.` : ""),
  }
}
