// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pure, injection-hardened ShopifyQL builder for aggregate analytics reads.
// The agent calls a TYPED tool with structured enum params; this builder
// assembles the ShopifyQL string from a FROZEN allowlist of columns/dims +
// format-validated date literals. The allowlist IS the security boundary: no
// agent-supplied string ever reaches the query un-sanitized, so an injection
// attempt in any param is rejected before a query is built.
//
// Bundle-pure: only @liaison/app-sdk types may be imported; no `node:*`.

export type AnalyticsMetric = "revenue" | "net_sales" | "aov" | "units" | "orders"
export type AnalyticsGroupBy = "none" | "sku" | "market"

export interface AnalyticsSpec {
  metric: AnalyticsMetric
  period: { since: string; until: string }
  groupBy: AnalyticsGroupBy
}

export type AnalyticsSpecErrorCode = "INVALID_METRIC" | "INVALID_GROUP_BY" | "INVALID_PERIOD"

/**
 * The builder's spec error carries a stable `code` (the security-relevant
 * rejection reason) and `name`. It is a PLAIN `Error` with those fields set —
 * deliberately NOT a `class extends Error` subclass: the bundle runs inside a
 * QuickJS sandbox where a transpiled `extends Error` is unreliable (an
 * `instanceof` check against it does not settle and hangs the handler until the
 * execution deadline → a 504). Consumers recognise it by `err.code` / `err.name`,
 * the same convention the rest of the bundle uses (`makeError`).
 */
export interface AnalyticsSpecError extends Error {
  code: AnalyticsSpecErrorCode
}

export function analyticsSpecError(code: AnalyticsSpecErrorCode, msg: string): AnalyticsSpecError {
  const err = new Error(msg) as AnalyticsSpecError
  err.name = "AnalyticsSpecError"
  err.code = code
  return err
}

// Shopify sales-dataset semantics matter here and the agent instructions state
// them: `total_sales` INCLUDES taxes and shipping (net sales + taxes + duties +
// shipping); `net_sales` is gross - discounts - returns, EXCLUDING taxes and
// shipping — the correct numerator for per-unit/ASP and product-revenue math.
const METRIC_COLUMN: Record<AnalyticsMetric, string> = {
  revenue: "total_sales",
  net_sales: "net_sales",
  aov: "average_order_value",
  units: "net_items_sold",
  orders: "orders",
}

const GROUP_DIM: Record<Exclude<AnalyticsGroupBy, "none">, string> = {
  sku: "product_variant_sku",
  market: "billing_region",
}

/**
 * Strict `YYYY-MM-DD` check WITHOUT a regex. The sandboxed bundle runs under
 * QuickJS, whose RegExp engine can stall on certain `.test()` inputs and hang the
 * tool call to the execution deadline (a 504); a hand-rolled scan is both
 * regex-engine-independent and unambiguously linear. Validates length, the dash
 * positions, and that every other character is a digit — exactly the prior
 * `/^\d{4}-\d{2}-\d{2}$/` contract.
 */
function isIsoDate(v: unknown): boolean {
  if (typeof v !== "string" || v.length !== 10) return false
  for (let i = 0; i < 10; i++) {
    const c = v.charCodeAt(i)
    if (i === 4 || i === 7) {
      if (c !== 45 /* '-' */) return false
    } else if (c < 48 || c > 57 /* '0'..'9' */) {
      return false
    }
  }
  return true
}

/**
 * Non-throwing spec validation against the frozen allowlist. Returns the first
 * rejection `code`, or `null` when the spec is clean. This is the form the
 * sandboxed handler uses: a synchronous `throw` raised in the QuickJS sandbox
 * before any `await` does NOT settle the handler promise and hangs the tool call
 * to the execution deadline (a 504). Returning the code instead keeps the hot
 * path throw-free. `buildAnalyticsQuery` (which throws) is the ergonomic form for
 * host-side unit tests.
 */
export function validateAnalyticsSpec(spec: AnalyticsSpec): AnalyticsSpecErrorCode | null {
  if (!(spec.metric in METRIC_COLUMN)) return "INVALID_METRIC"
  if (spec.groupBy !== "none" && !(spec.groupBy in GROUP_DIM)) return "INVALID_GROUP_BY"
  if (!isIsoDate(spec.period.since) || !isIsoDate(spec.period.until)) return "INVALID_PERIOD"
  return null
}

/** Assemble the ShopifyQL for a spec already known valid (no further checks). */
function assembleAnalyticsQuery(spec: AnalyticsSpec): {
  query: string
  variables: Record<string, string>
} {
  const col = METRIC_COLUMN[spec.metric]
  const groupClause = spec.groupBy === "none" ? "" : ` GROUP BY ${GROUP_DIM[spec.groupBy]}`
  // ShopifyQL assembled ONLY from allowlisted columns/dims (METRIC_COLUMN / GROUP_DIM) + the two
  // dates, which validateAnalyticsSpec has already `isIsoDate`-checked (strict YYYY-MM-DD, no quotes
  // or special chars) — so direct interpolation into the ShopifyQL string is injection-safe. SINCE/
  // UNTIL are ShopifyQL LITERALS, not GraphQL variables (the old `$since`/`$until` were declared as
  // GraphQL vars but embedded as literal text in the ShopifyQL string → "variable not used" + never
  // substituted). API 2026-01: `ShopifyqlTableData` exposes `rows` (JSON) + `columns { name }` (NOT
  // `rowData`), and `parseErrors` is a `[String]` scalar list (NOT `{ code, message }` objects).
  const query = `query Analytics {
    shopifyqlQuery(query: "FROM sales SHOW ${col}${groupClause} SINCE ${spec.period.since} UNTIL ${spec.period.until}") {
      tableData { rows columns { name } } parseErrors
    }
  }`
  return { query, variables: {} }
}

/**
 * Throwing builder — validates then assembles, raising `AnalyticsSpecError` on a
 * non-allowlisted/malformed spec. Ergonomic for host-side unit tests. The
 * sandboxed handler uses the non-throwing {@link buildAnalyticsQuerySafe} instead.
 */
export function buildAnalyticsQuery(spec: AnalyticsSpec): {
  query: string
  variables: Record<string, string>
} {
  const code = validateAnalyticsSpec(spec)
  if (code) throw analyticsSpecError(code, analyticsSpecMessage(code, spec))
  return assembleAnalyticsQuery(spec)
}

/**
 * Non-throwing builder for the sandbox handler: returns the assembled query, or
 * the rejection `code` — never throws (a synchronous throw in QuickJS pre-await
 * hangs the tool call). The allowlist is still the security boundary.
 */
export function buildAnalyticsQuerySafe(
  spec: AnalyticsSpec,
):
  | { ok: true; query: string; variables: Record<string, string> }
  | { ok: false; code: AnalyticsSpecErrorCode; message: string } {
  const code = validateAnalyticsSpec(spec)
  if (code) return { ok: false, code, message: analyticsSpecMessage(code, spec) }
  return { ok: true, ...assembleAnalyticsQuery(spec) }
}

function analyticsSpecMessage(code: AnalyticsSpecErrorCode, spec: AnalyticsSpec): string {
  switch (code) {
    case "INVALID_METRIC":
      return `metric ${spec.metric} not allowed`
    case "INVALID_GROUP_BY":
      return `groupBy ${spec.groupBy} not allowed`
    case "INVALID_PERIOD":
      return "period dates must be YYYY-MM-DD"
  }
}
