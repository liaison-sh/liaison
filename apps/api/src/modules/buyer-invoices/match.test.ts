// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { type BuyerIdentity, hasIdentity, normaliseIdentity, saleMatches } from "./match"

const id = (p: Partial<BuyerIdentity>): BuyerIdentity => ({
  email: null,
  shopifyCustomerId: null,
  hubUserId: null,
  ...p,
})

describe("the matching rule", () => {
  test("a guest sale (email only) matches the same email, trimmed and lower-cased", () => {
    const req = normaliseIdentity({ email: "  A@B.com " })
    expect(saleMatches(req, id({ email: "a@b.com" }))).toBe(true)
    expect(saleMatches(req, id({ email: "a+x@b.com" }))).toBe(false)
  })

  test("an email alone never reaches a sale that carries a strong id", () => {
    expect(saleMatches(id({ email: "a@b.com" }), id({ email: "a@b.com", hubUserId: "u1" }))).toBe(
      false,
    )
    expect(
      saleMatches(id({ email: "a@b.com" }), id({ email: "a@b.com", shopifyCustomerId: "81" })),
    ).toBe(false)
  })

  test("a forged id next to the right email excludes the sale", () => {
    const sale = id({ email: "a@b.com", shopifyCustomerId: "81", hubUserId: "u1" })
    expect(saleMatches(id({ email: "a@b.com", hubUserId: "u-forged" }), sale)).toBe(false)
    expect(
      saleMatches(id({ email: "a@b.com", shopifyCustomerId: "82", hubUserId: "u1" }), sale),
    ).toBe(false)
  })

  test("one shared strong id matches, whatever the email", () => {
    const sale = id({ email: "old@b.com", hubUserId: "u1" })
    expect(saleMatches(id({ email: "new@b.com", hubUserId: "u1" }), sale)).toBe(true)
    expect(saleMatches(id({ hubUserId: "u1" }), sale)).toBe(true)
  })

  test("a strong id the sale lacks neither matches nor conflicts", () => {
    const guest = id({ email: "a@b.com" })
    expect(saleMatches(id({ email: "a@b.com", hubUserId: "u1" }), guest)).toBe(true)
    expect(saleMatches(id({ hubUserId: "u1" }), guest)).toBe(false)
    expect(saleMatches(id({ shopifyCustomerId: "81" }), id({ hubUserId: "u1" }))).toBe(false)
  })

  test("a request with no identity field is none", () => {
    expect(hasIdentity(normaliseIdentity({ email: " ", hubUserId: null }))).toBe(false)
  })
})
