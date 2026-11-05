// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { convertToDeclared, deriveShopifyOrderRate, type FxConversion } from "./fx"

describe("deriveShopifyOrderRate", () => {
  it("derives the invoice→EUR rate from the order's presentment and shop totals", () => {
    const fx = deriveShopifyOrderRate("USD", {
      totalAmount: "1000.00",
      totalAmountShop: "917.43",
      shopCurrency: "EUR",
    })
    expect(fx).not.toBeNull()
    expect(fx!.from).toBe("USD")
    expect(fx!.to).toBe("EUR")
    expect(fx!.source).toBe("shopify_order_totals")
    expect(fx!.rate).toBeCloseTo(0.91743, 6)
  })

  it("returns null for an invoice already in EUR (nothing to convert)", () => {
    expect(
      deriveShopifyOrderRate("EUR", {
        totalAmount: "699.00",
        totalAmountShop: "699.00",
        shopCurrency: "EUR",
      }),
    ).toBeNull()
  })

  it("returns null rather than a guessed rate when the order cannot answer", () => {
    const totals = { totalAmount: "1000.00", totalAmountShop: "917.43", shopCurrency: "EUR" }
    expect(deriveShopifyOrderRate("USD", null)).toBeNull()
    expect(deriveShopifyOrderRate("USD", { ...totals, totalAmountShop: null })).toBeNull()
    expect(deriveShopifyOrderRate("USD", { ...totals, totalAmount: "0" })).toBeNull()
    expect(deriveShopifyOrderRate("USD", { ...totals, totalAmount: "not-a-number" })).toBeNull()
    // A store that does not keep books in EUR cannot supply a EUR rate.
    expect(deriveShopifyOrderRate("USD", { ...totals, shopCurrency: "GBP" })).toBeNull()
  })

  it("is case-insensitive on the currency codes", () => {
    const fx = deriveShopifyOrderRate("usd", {
      totalAmount: "100",
      totalAmountShop: "90",
      shopCurrency: "eur",
    })
    expect(fx?.from).toBe("USD")
    expect(fx?.rate).toBeCloseTo(0.9, 6)
  })
})

describe("convertToDeclared", () => {
  const fx: FxConversion = { rate: 0.91743, from: "USD", to: "EUR", source: "shopify_order_totals" }

  it("converts and rounds to EUR minor-unit precision", () => {
    expect(convertToDeclared(1000, fx)).toBe(917.43)
    expect(convertToDeclared(19.99, fx)).toBe(18.34)
  })

  it("never leaves a float tail on the declared figure", () => {
    const v = convertToDeclared(33.33, { ...fx, rate: 1 / 3 })
    expect(Number.isInteger(v * 100)).toBe(true)
  })
})

// Regression (prod 2026-08-05, order #3320): a FULLY REFUNDED order reports
// current totals of 0.00 in both currencies, so the presentment/shop rate
// derivable from the pair vanished and every customs article blocked
// `fx_unavailable` -> "Customs value needs a manual EUR amount". The FX rate is
// a property of the order's currency pair, not of how much is still owed.
describe("deriveShopifyOrderRate falls back to pre-refund totals", () => {
  it("derives the rate from ORIGINAL totals when current ones are zeroed by a refund", () => {
    const fx = deriveShopifyOrderRate("USD", {
      totalAmount: "0.0",
      totalAmountShop: "0.0",
      shopCurrency: "EUR",
      originalTotalAmount: "172.00",
      originalTotalAmountShop: "151.11",
      originalShopCurrency: "EUR",
    })
    expect(fx).not.toBeNull()
    expect(fx?.rate).toBeCloseTo(151.11 / 172.0, 8)
    expect(fx?.from).toBe("USD")
    expect(fx?.to).toBe("EUR")
  })

  it("still prefers CURRENT totals on a normal unrefunded order", () => {
    const fx = deriveShopifyOrderRate("USD", {
      totalAmount: "100.00",
      totalAmountShop: "90.00",
      shopCurrency: "EUR",
      originalTotalAmount: "200.00",
      originalTotalAmountShop: "10.00",
      originalShopCurrency: "EUR",
    })
    expect(fx?.rate).toBeCloseTo(0.9, 8)
  })

  it("returns null when BOTH pairs are unusable", () => {
    expect(
      deriveShopifyOrderRate("USD", {
        totalAmount: "0.0",
        totalAmountShop: "0.0",
        shopCurrency: "EUR",
        originalTotalAmount: "0.0",
        originalTotalAmountShop: "0.0",
        originalShopCurrency: "EUR",
      }),
    ).toBeNull()
  })

  it("does not use an original pair whose store currency is not EUR", () => {
    expect(
      deriveShopifyOrderRate("USD", {
        totalAmount: "0.0",
        totalAmountShop: "0.0",
        shopCurrency: "EUR",
        originalTotalAmount: "172.00",
        originalTotalAmountShop: "151.11",
        originalShopCurrency: "GBP",
      }),
    ).toBeNull()
  })
})
