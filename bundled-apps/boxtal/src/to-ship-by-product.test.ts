// SPDX-License-Identifier: FSL-1.1-ALv2
//
// to_ship_by_product: the To prepare worklist folded into units per product code. Pins that a
// wholesale variant folds into its retail code, that quantities add up across rows and within one
// row, that `orders` counts worklist rows (not lines), that a fully covered partial row counts
// nothing, that a non-quantity summary is skipped, the rank order, and the empty worklist.
import { describe, expect, it } from "bun:test"
import type { ProductCodeConfig } from "./product-codes"
import { aggregateToShipByProduct } from "./to-ship-by-product"

// A fictional store: house prefix ACME-, wholesale suffix -B2B.
const ORG: ProductCodeConfig = {
  strip_prefixes: ["ACME-"],
  strip_suffixes: ["-B2B"],
  aliases: { "K1-BLACK": "K1", "K1-HARDCOVER": "HC", HARDCOVER: "HC" },
}

describe("aggregateToShipByProduct", () => {
  it("returns no rows and zero units for an empty worklist", () => {
    expect(aggregateToShipByProduct([], ORG)).toEqual({ rows: [], total_units: 0 })
  })

  it("folds sku variants into one code and sums units across rows", () => {
    const out = aggregateToShipByProduct(
      [
        { products: "2xK1" },
        { products: "3xACME-K1-BLACK-B2B, 1xACME-K1-HARDCOVER-B2B" },
        { products: "1xHC" },
      ],
      ORG,
    )
    expect(out.rows).toEqual([
      { code: "HC", units: 2, orders: 2 },
      { code: "K1", units: 5, orders: 2 },
    ])
    expect(out.total_units).toBe(7)
  })

  it("counts an order once when it lists the same code on two lines", () => {
    const out = aggregateToShipByProduct([{ products: "1xK1, 2xACME-K1-BLACK-B2B" }], ORG)
    expect(out.rows).toEqual([{ code: "K1", units: 3, orders: 1 }])
  })

  it("skips a partial row with nothing left and keeps one with remaining units", () => {
    const out = aggregateToShipByProduct(
      [
        { products: "4xK1", partially_shipped: true, remaining_units: 0 },
        { products: "1xK1", partially_shipped: true, remaining_units: 1 },
      ],
      ORG,
    )
    expect(out.rows).toEqual([{ code: "K1", units: 1, orders: 1 }])
  })

  it("ignores summaries that are not a quantity list", () => {
    const out = aggregateToShipByProduct([{ products: "-" }, { products: "2 parcels" }], ORG)
    expect(out).toEqual({ rows: [], total_units: 0 })
  })

  it("orders rows by the org's code rank, then alphabetically", () => {
    const ranked: ProductCodeConfig = { ...ORG, ranks: { K1: 1 } }
    const rows = [{ products: "1xZZ, 1xHC, 1xK1, 1xAA" }]
    expect(aggregateToShipByProduct(rows, ranked).rows.map((r) => r.code)).toEqual([
      "K1",
      "AA",
      "HC",
      "ZZ",
    ])
    // No rank declared: alphabetical.
    expect(aggregateToShipByProduct(rows, ORG).rows.map((r) => r.code)).toEqual([
      "AA",
      "HC",
      "K1",
      "ZZ",
    ])
  })

  it("leaves an sku with no alias under its trimmed form, never drops it", () => {
    const out = aggregateToShipByProduct([{ products: "2xACME-WIDGET-B2B" }], ORG)
    expect(out.rows).toEqual([{ code: "WIDGET", units: 2, orders: 1 }])
  })
})
