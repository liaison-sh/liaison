// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { type AnalyticsSpecError, buildAnalyticsQuery } from "./lib/analytics-query-builder"

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
})
