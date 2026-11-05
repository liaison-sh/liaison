// SPDX-License-Identifier: FSL-1.1-ALv2
//
// BL-169 #2: computeInventoryValue — the pure summation behind the inventory_value tool.
// (The live GraphQL pagination is exercised by the chaos gate against the dev store.)

import { describe, expect, it } from "bun:test"
import { computeInventoryValue, type VariantValuationInput } from "./inventory-value"

function v(partial: Partial<VariantValuationInput>): VariantValuationInput {
  return { sku: null, title: null, displayName: null, price: null, inventoryQuantity: null, ...partial }
}

describe("computeInventoryValue (BL-169 #2)", () => {
  it("sums on-hand × selling price across variants and ranks topByValue", () => {
    const r = computeInventoryValue([
      v({ sku: "RAL-44", title: "Kestrel 6", price: "699.00", inventoryQuantity: 10 }), // 6990
      v({ sku: "RAL-CBL", title: "Cable", price: "29.00", inventoryQuantity: 6 }), // 174
      v({ sku: "RAL-WND", title: "Overlay", price: "15.00", inventoryQuantity: 4 }), // 60
    ])
    expect(r.totalInventoryValue).toBe(7224)
    expect(r.basis).toBe("retail")
    expect(r.valuedVariants).toBe(3)
    expect(r.variantsScanned).toBe(3)
    expect(r.topByValue[0]?.sku).toBe("RAL-44")
    expect(r.topByValue[0]?.value).toBe(6990)
  })

  it("excludes zero/negative on-hand (no stock → no value)", () => {
    const r = computeInventoryValue([
      v({ sku: "ERT-FW", price: "799.00", inventoryQuantity: 0 }),
      v({ sku: "NEG", price: "10.00", inventoryQuantity: -3 }),
      v({ sku: "OK", price: "5.00", inventoryQuantity: 2 }),
    ])
    expect(r.totalInventoryValue).toBe(10)
    expect(r.valuedVariants).toBe(1)
  })

  it("counts variants with no parseable price and excludes them from the total", () => {
    const r = computeInventoryValue([
      v({ sku: "NOPRICE", price: null, inventoryQuantity: 5 }),
      v({ sku: "BADPRICE", price: "n/a", inventoryQuantity: 5 }),
      v({ sku: "GOOD", price: "100.00", inventoryQuantity: 3 }),
    ])
    expect(r.variantsMissingPrice).toBe(2)
    expect(r.totalInventoryValue).toBe(300)
    expect(r.valuedVariants).toBe(1)
  })

  it("rounds to cents and handles an empty catalog", () => {
    expect(computeInventoryValue([]).totalInventoryValue).toBe(0)
    const r = computeInventoryValue([v({ sku: "X", price: "9.999", inventoryQuantity: 3 })])
    expect(r.totalInventoryValue).toBe(30) // 29.997 → 30.00
  })
})
