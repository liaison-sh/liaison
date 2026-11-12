// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { timeSeriesRows } from "./analytics"
import {
  type AnalyticsSpecError,
  buildAnalyticsQuery,
  buildAnalyticsQuerySafe,
} from "./lib/analytics-query-builder"

describe("buildAnalyticsQuery — typed aggregate, injection-hardened", () => {
  it("builds a revenue-by-market ShopifyQL spec from allowlisted enums", () => {
    const { query, variables } = buildAnalyticsQuery({
      metric: "revenue",
      period: { since: "2026-05-01", until: "2026-05-31" },
      groupBy: "market",
    })
    expect(query).toContain("total_sales") // metric → ShopifyQL column from the allowlist
    expect(query).toContain("GROUP BY")
    // The two dates are isIsoDate-validated literals interpolated into the ShopifyQL string (SINCE/
    // UNTIL are ShopifyQL literals, NOT GraphQL variables) — so `variables` is empty.
    expect(query).toContain("SINCE 2026-05-01 UNTIL 2026-05-31")
    expect(variables).toEqual({})
  })

  // Regression (l271): the query must match the LIVE Admin GraphQL schema (API 2026-01). The old query
  // selected `tableData { rowData ... }` (field renamed to `rows`), `parseErrors { code message }`
  // (parseErrors is a [String] scalar list, not objects), and declared unused `$since`/`$until` GraphQL
  // vars — so EVERY analytics_query errored ("Field 'rowData' doesn't exist" / "Selections can't be made
  // on scalars" / "Variable $since … not used") against a real store, masking ~20 analytics scenarios.
  it("emits a query valid for the live 2026-01 ShopifyQL schema (rows, scalar parseErrors, no GraphQL vars)", () => {
    const { query, variables } = buildAnalyticsQuery({
      metric: "revenue",
      period: { since: "2026-06-01", until: "2026-06-12" },
      groupBy: "sku",
    })
    expect(query).toContain("tableData { rows columns { name } }") // `rows`, NOT `rowData`
    expect(query).not.toContain("rowData")
    expect(query).toContain("parseErrors\n") // scalar field, no `{ code message }` selection
    expect(query).not.toContain("parseErrors { code message }")
    expect(query).not.toContain("$since") // no unused GraphQL variable declarations
    expect(query).not.toContain("$until")
    expect(variables).toEqual({})
  })

  it("builds units-by-SKU", () => {
    const { query } = buildAnalyticsQuery({
      metric: "units",
      period: { since: "2026-05-01", until: "2026-05-31" },
      groupBy: "sku",
    })
    expect(query).toContain("net_items_sold") // units column from the allowlist
  })

  // competitor-price-undercut-analysis: a product's REAL average selling price (ASP) — the per-unit price
  // it actually sold at after discounts — is derivable per SKU from TWO groupBy=sku reads (net_sales +
  // units) divided. The numerator MUST be net_sales (after discounts/returns, EXCLUDING taxes and
  // shipping) — Shopify's total_sales INCLUDES taxes and shipping, which inflated a real ASP analysis
  // and led the agent to invent a VAT back-conversion. This is the host-side proof that the two halves
  // of the ASP derivation are buildable with the tax-exclusive column.
  it("supports per-SKU ASP derivation: net_sales-by-SKU and units-by-SKU both build valid ShopifyQL", () => {
    const netSales = buildAnalyticsQuery({
      metric: "net_sales",
      period: { since: "2026-01-01", until: "2026-12-31" },
      groupBy: "sku",
    })
    const units = buildAnalyticsQuery({
      metric: "units",
      period: { since: "2026-01-01", until: "2026-12-31" },
      groupBy: "sku",
    })
    // Net-sales read → net_sales grouped by SKU; units read → net_items_sold grouped by SKU.
    expect(netSales.query).toContain("net_sales")
    expect(netSales.query).not.toContain("total_sales")
    expect(netSales.query).toContain("GROUP BY product_variant_sku")
    expect(units.query).toContain("net_items_sold")
    expect(units.query).toContain("GROUP BY product_variant_sku")
    // Same period window on both so the per-SKU net_sales ÷ units quotient (the ASP) is well-defined.
    expect(netSales.query).toContain("SINCE 2026-01-01 UNTIL 2026-12-31")
    expect(units.query).toContain("SINCE 2026-01-01 UNTIL 2026-12-31")
  })

  it("keeps metric=revenue mapped to Shopify total_sales (tax- and shipping-inclusive store total)", () => {
    const { query } = buildAnalyticsQuery({
      metric: "revenue",
      period: { since: "2026-01-01", until: "2026-12-31" },
      groupBy: "none",
    })
    expect(query).toContain("total_sales")
  })

  it("rejects a non-allowlisted metric (injection in a param) with AnalyticsSpecError", () => {
    let code = ""
    try {
      buildAnalyticsQuery({
        metric: "total_sales SHOW *; DROP" as never,
        period: { since: "2026-05-01", until: "2026-05-31" },
        groupBy: "none",
      })
    } catch (e) {
      code = (e as AnalyticsSpecError).code
    }
    expect(code).toBe("INVALID_METRIC")
  })

  it("rejects a non-allowlisted groupBy", () => {
    let code = ""
    try {
      buildAnalyticsQuery({
        metric: "revenue",
        period: { since: "2026-05-01", until: "2026-05-31" },
        groupBy: "customer_email" as never,
      })
    } catch (e) {
      code = (e as AnalyticsSpecError).code
    }
    expect(code).toBe("INVALID_GROUP_BY")
  })

  it("rejects a malformed period date (no SQL-ish injection reaches the builder)", () => {
    let code = ""
    try {
      buildAnalyticsQuery({
        metric: "revenue",
        period: { since: "2026-05-01' OR '1'='1", until: "2026-05-31" },
        groupBy: "none",
      })
    } catch (e) {
      code = (e as AnalyticsSpecError).code
    }
    expect(code).toBe("INVALID_PERIOD")
  })

  it("leaves a call without timeGrain unchanged (no TIMESERIES, sku stays one dimension)", () => {
    const { query } = buildAnalyticsQuery({
      metric: "units",
      period: { since: "2026-05-01", until: "2026-05-31" },
      groupBy: "sku",
    })
    expect(query).toContain(
      'FROM sales SHOW net_items_sold GROUP BY product_variant_sku SINCE 2026-05-01 UNTIL 2026-05-31")',
    )
  })

  it("builds store sessions per day from the sessions dataset", () => {
    const { query } = buildAnalyticsQuery({
      metric: "sessions",
      period: { since: "2026-05-01", until: "2026-05-31" },
      groupBy: "none",
      timeGrain: "day",
    })
    expect(query).toContain(
      "FROM sessions SHOW sessions TIMESERIES day SINCE 2026-05-01 UNTIL 2026-05-31 ORDER BY day ASC",
    )
  })

  it("builds conversion_rate per week from the sessions dataset", () => {
    const { query } = buildAnalyticsQuery({
      metric: "conversion_rate",
      period: { since: "2026-05-01", until: "2026-06-30" },
      groupBy: "none",
      timeGrain: "week",
    })
    expect(query).toContain("FROM sessions SHOW conversion_rate TIMESERIES week")
  })

  it("builds units per SKU per day, labelled with the product title", () => {
    const { query } = buildAnalyticsQuery({
      metric: "units",
      period: { since: "2026-05-01", until: "2026-05-31" },
      groupBy: "sku",
      timeGrain: "day",
    })
    expect(query).toContain(
      "FROM sales SHOW net_items_sold GROUP BY product_variant_sku, product_title, day TIMESERIES day SINCE 2026-05-01 UNTIL 2026-05-31 ORDER BY day ASC",
    )
  })

  it("builds net sales per product per month", () => {
    const { query } = buildAnalyticsQuery({
      metric: "net_sales",
      period: { since: "2026-01-01", until: "2026-12-31" },
      groupBy: "product",
      timeGrain: "month",
    })
    expect(query).toContain("GROUP BY product_title, month TIMESERIES month")
  })

  it("rejects sessions grouped by sku with a message naming the allowed combination", () => {
    const res = buildAnalyticsQuerySafe({
      metric: "sessions",
      period: { since: "2026-05-01", until: "2026-05-31" },
      groupBy: "sku",
      timeGrain: "day",
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe("UNSUPPORTED_COMBINATION")
    expect(res.message).toContain("supports groupBy none only")
    expect(res.message).toContain("timeGrain day, week or month")
  })

  it("rejects a timeGrain outside day, week, month", () => {
    const res = buildAnalyticsQuerySafe({
      metric: "orders",
      period: { since: "2026-05-01", until: "2026-05-31" },
      groupBy: "none",
      timeGrain: "hour; DROP" as never,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe("INVALID_TIME_GRAIN")
  })

  it("rejects an inherited object key as a metric or groupBy (own keys only)", () => {
    const metric = buildAnalyticsQuerySafe({
      metric: "toString" as never,
      period: { since: "2026-05-01", until: "2026-05-31" },
      groupBy: "none",
    })
    const groupBy = buildAnalyticsQuerySafe({
      metric: "orders",
      period: { since: "2026-05-01", until: "2026-05-31" },
      groupBy: "constructor" as never,
    })
    expect(metric.ok ? null : metric.code).toBe("INVALID_METRIC")
    expect(groupBy.ok ? null : groupBy.code).toBe("INVALID_GROUP_BY")
  })
})

describe("timeSeriesRows — dashboard-ready rows", () => {
  it("adds date (YYYY-MM-DD bucket start) to keyed rows", () => {
    const rows = timeSeriesRows(
      {
        columns: [
          { name: "product_variant_sku" },
          { name: "product_title" },
          { name: "day" },
          { name: "net_items_sold" },
        ],
        rows: [
          {
            product_variant_sku: "SKU-1",
            product_title: "Widget",
            day: "2026-05-01",
            net_items_sold: 3,
          },
          {
            product_variant_sku: "SKU-1",
            product_title: "Widget",
            day: "2026-05-02T00:00:00Z",
            net_items_sold: 0,
          },
        ],
      },
      "day",
    )
    expect(rows).toEqual([
      {
        product_variant_sku: "SKU-1",
        product_title: "Widget",
        day: "2026-05-01",
        net_items_sold: 3,
        date: "2026-05-01",
      },
      {
        product_variant_sku: "SKU-1",
        product_title: "Widget",
        day: "2026-05-02T00:00:00Z",
        net_items_sold: 0,
        date: "2026-05-02",
      },
    ])
  })

  it("maps positional rows through columns", () => {
    const rows = timeSeriesRows(
      { columns: [{ name: "month" }, { name: "sessions" }], rowData: [["2026-04-01", 120]] },
      "month",
    )
    expect(rows).toEqual([{ month: "2026-04-01", sessions: 120, date: "2026-04-01" }])
  })

  it("returns no rows for an empty table", () => {
    expect(timeSeriesRows(null, "week")).toEqual([])
  })
})
