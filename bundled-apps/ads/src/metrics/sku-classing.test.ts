// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { DEFAULT_SKU_CLASSING_CONFIG, orderHitIsB2b, shopifyOrderKey } from "./sku-classing"

const plainLines = [{ sku: "KIT-01" }, { sku: "CABLE-2M" }]

describe("orderHitIsB2b: an order is B2B by the order itself", () => {
  it("the shopify app's verdict wins, both ways", () => {
    expect(orderHitIsB2b({ attributes: { b2bOrder: { b2b: true }, lineItems: plainLines } })).toBe(
      true,
    )
    // A false verdict stands even with the default tag (the org changed its tags).
    expect(orderHitIsB2b({ attributes: { b2bOrder: { b2b: false }, tags: ["B2B"] } })).toBe(false)
  })

  it("company order with plain skus -> b2b (no verdict on the hit)", () => {
    expect(
      orderHitIsB2b({
        attributes: { b2bCompany: { name: "A dealer" }, tags: [], lineItems: plainLines },
      }),
    ).toBe(true)
  })

  it("B2B-tagged order with plain skus -> b2b, tag compared without case", () => {
    expect(
      orderHitIsB2b({ attributes: { tags: ["Distribution", "b2b"], lineItems: plainLines } }),
    ).toBe(true)
    expect(
      orderHitIsB2b(
        { attributes: { tags: ["Wholesale"] } },
        { ...DEFAULT_SKU_CLASSING_CONFIG, b2bOrderTags: ["wholesale"] },
      ),
    ).toBe(true)
  })

  it("legacy sku suffix -> b2b", () => {
    expect(orderHitIsB2b({ attributes: { tags: [], lineItems: [{ sku: "KIT-01-B2B" }] } })).toBe(
      true,
    )
  })

  it("plain retail order -> not b2b", () => {
    expect(
      orderHitIsB2b({ attributes: { b2bCompany: null, tags: ["vip"], lineItems: plainLines } }),
    ).toBe(false)
    expect(orderHitIsB2b({})).toBe(false)
  })
})

describe("shopifyOrderKey", () => {
  it("joins a gid and a plain id on the numeric id", () => {
    expect(shopifyOrderKey("gid://shopify/Order/5551234")).toBe("5551234")
    expect(shopifyOrderKey("5551234")).toBe("5551234")
    expect(shopifyOrderKey(5551234)).toBe("5551234")
    expect(shopifyOrderKey("not-an-id")).toBeNull()
    expect(shopifyOrderKey(null)).toBeNull()
  })
})
