// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { toShopifyOrderGid } from "./shopify-ref"

describe("toShopifyOrderGid", () => {
  it("wraps the bare numeric id invoicing persists", () => {
    expect(toShopifyOrderGid("13018158072139")).toBe("gid://shopify/Order/13018158072139")
  })

  it("leaves an id that is already a gid untouched", () => {
    const gid = "gid://shopify/Order/13018158072139"
    expect(toShopifyOrderGid(gid)).toBe(gid)
  })

  it("passes through any other reference shape rather than mangling it", () => {
    // An order NAME ("#2357") is not a gid and not numeric. Wrapping it would
    // build a nonsense gid; passing it through lets the callee reject it
    // honestly (and keeps a future reference style working).
    expect(toShopifyOrderGid("#2357")).toBe("#2357")
    expect(toShopifyOrderGid("")).toBe("")
  })
})
