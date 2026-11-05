// SPDX-License-Identifier: FSL-1.1-ALv2
//
// product-codes: the prep grid's PRODUCTS cell, as pure functions over an org's mapping.
//
// The standing case is a wholesale row: long wrapped skus with no shipping profile, the same product
// listed twice as two entries. Everything asserted here is a property an operator reads off a
// carton, so nothing may be silently dropped: an unknown sku has to survive the pass in a readable
// form, and the merge has to be arithmetic, not de-duplication. The mapping itself is the org's
// data, so the default must rename nothing.
import { describe, expect, it } from "bun:test"
import {
  DEFAULT_PRODUCT_CODE_RANK,
  EMPTY_PRODUCT_CODE_CONFIG,
  normalizeProductSku,
  orderProductsSummary,
  type ProductCodeConfig,
  productCodeConfigFromValue,
  resolveProductCodes,
  shortProductCode,
} from "./product-codes"
import { formatProductCode, productChipLabel } from "./ui/product-codes"

// A fictional store: house prefix ACME-, wholesale suffix -B2B, main unit K1 and its accessories.
const ORG: ProductCodeConfig = {
  strip_prefixes: ["ACME-", "ACME_"],
  strip_suffixes: ["-B2B", "_B2B"],
  aliases: {
    "K1-BLACK": "K1",
    BLACK: "K1",
    "K1-FABRICSKIN": "FS",
    FABRICSKIN: "FS",
    "K1-HARDCOVER": "HC",
    HARDCOVER: "HC",
    "K1-PLATE": "MP",
    PLATE: "MP",
    PSUSBCK1: "PS",
    USBC2M: "USBC",
    USBC: "USBC",
  },
}

const WHOLESALE_SUMMARY =
  "2xACME-K1-BLACK-B2B, 1xACME-K1-FABRICSKIN-B2B, 1xACME-K1-HARDCOVER-B2B, " +
  "1xACME-K1-PLATE-B2B, 2xPSUSBCK1-B2B, 2xUSBC2M-B2B, 1xACME-K1-BLACK-B2B"

describe("the default mapping", () => {
  it("is empty and renames nothing: a wrapped sku is only trimmed", () => {
    expect(EMPTY_PRODUCT_CODE_CONFIG).toEqual({ strip_prefixes: [], strip_suffixes: [], aliases: {} })
    expect(normalizeProductSku("  ACME-K1-HARDCOVER-B2B ")).toBe("ACME-K1-HARDCOVER-B2B")
    expect(shortProductCode("ACME-K1-HARDCOVER-B2B")).toBe("ACME-K1-HARDCOVER-B2B")
    expect(shortProductCode("HARDCOVER")).toBe("HARDCOVER")
  })

  it("still merges one product listed on several line items", () => {
    expect(resolveProductCodes("2xK1, 1xHC, 1xK1")).toEqual([
      { code: "K1", qty: 3 },
      { code: "HC", qty: 1 },
    ])
  })
})

describe("normalizeProductSku", () => {
  it("strips the org's house prefix and channel suffix, case-insensitively, keeping case", () => {
    expect(normalizeProductSku("ACME-K1-HARDCOVER-B2B", ORG)).toBe("K1-HARDCOVER")
    expect(normalizeProductSku("USBC2M-B2B", ORG)).toBe("USBC2M")
    expect(normalizeProductSku("acme-k1-plate-b2b", ORG)).toBe("k1-plate")
  })

  it("leaves a retail sku, a short code and a gid alone", () => {
    expect(normalizeProductSku("VARIANT-STAB", ORG)).toBe("VARIANT-STAB")
    expect(normalizeProductSku("K1", ORG)).toBe("K1")
    expect(normalizeProductSku("gid://shopify/ProductVariant/50468186128715", ORG)).toBe(
      "gid://shopify/ProductVariant/50468186128715",
    )
  })
})

describe("shortProductCode", () => {
  it("resolves every wholesale sku of the row to its retail code", () => {
    expect(shortProductCode("ACME-K1-BLACK-B2B", ORG)).toBe("K1")
    expect(shortProductCode("ACME-K1-FABRICSKIN-B2B", ORG)).toBe("FS")
    expect(shortProductCode("ACME-K1-HARDCOVER-B2B", ORG)).toBe("HC")
    expect(shortProductCode("ACME-K1-PLATE-B2B", ORG)).toBe("MP")
    expect(shortProductCode("PSUSBCK1-B2B", ORG)).toBe("PS")
    expect(shortProductCode("USBC2M-B2B", ORG)).toBe("USBC")
  })

  it("resolves the retail sku to the SAME code as its wholesale variant", () => {
    expect(shortProductCode("K1-HARDCOVER", ORG)).toBe(shortProductCode("ACME-K1-HARDCOVER-B2B", ORG))
    expect(shortProductCode("hardcover", ORG)).toBe("HC")
  })

  it("falls through an unlisted family prefix to the accessory word", () => {
    expect(shortProductCode("ACME-K2-FABRICSKIN-B2B", ORG)).toBe("FS")
  })

  it("keeps an UNKNOWN sku, in a shorter readable form, rather than dropping it", () => {
    expect(shortProductCode("ACME-K1-MYSTERY-B2B", ORG)).toBe("K1-MYSTERY")
    expect(shortProductCode("VARIANT-STAB", ORG)).toBe("VARIANT-STAB")
    expect(shortProductCode("E2C", ORG)).toBe("E2C")
  })
})

describe("resolveProductCodes", () => {
  it("resolves and MERGES the wholesale row: the twice-listed unit becomes 3x", () => {
    expect(resolveProductCodes(WHOLESALE_SUMMARY, ORG)).toEqual([
      { code: "K1", qty: 3 },
      { code: "FS", qty: 1 },
      { code: "HC", qty: 1 },
      { code: "MP", qty: 1 },
      { code: "PS", qty: 2 },
      { code: "USBC", qty: 2 },
    ])
  })

  it("merges a retail entry and a wholesale entry of the same product into one", () => {
    expect(resolveProductCodes("1xK1-HARDCOVER, 2xACME-K1-HARDCOVER-B2B", ORG)).toEqual([
      { code: "HC", qty: 3 },
    ])
  })

  it("keeps first-appearance order, not alphabetical order", () => {
    expect(resolveProductCodes("1xUSBC2M-B2B, 1xACME-K1-BLACK-B2B", ORG).map((e) => e.code)).toEqual([
      "USBC",
      "K1",
    ])
  })

  it("reads the invoicing decimal quantity form", () => {
    expect(resolveProductCodes("01.000xACME-K1-BLACK-B2B", ORG)).toEqual([{ code: "K1", qty: 1 }])
  })

  it("returns nothing for a summary that is not a quantity list", () => {
    // The renderer shows these verbatim: "-" is the empty placeholder and "2 parcels" is
    // summarizeProducts' fallback for a draft with no goods lines.
    expect(resolveProductCodes("-", ORG)).toEqual([])
    expect(resolveProductCodes("2 parcels", ORG)).toEqual([])
    expect(resolveProductCodes("", ORG)).toEqual([])
  })

  it("keeps an unresolvable entry in the list", () => {
    expect(resolveProductCodes("1xACME-K1-BLACK-B2B, 4xWHO-KNOWS", ORG)).toEqual([
      { code: "K1", qty: 1 },
      { code: "WHO-KNOWS", qty: 4 },
    ])
  })
})

describe("display rank", () => {
  // The request: ET2 first, MP second, SOUND last, everything else in one fixed order between.
  const RANKED: ProductCodeConfig = { ...EMPTY_PRODUCT_CODE_CONFIG, ranks: { ET2: 1, MP: 2, SOUND: 1000 } }

  it("orders identical orders the same way whatever the invoice-line order", () => {
    const a = orderProductsSummary("1xMP, 1xBSkin, 1xHC, 1xET2, 1xSOUND", RANKED)
    const b = orderProductsSummary("1xSOUND, 1xHC, 1xET2, 1xBSkin, 1xMP", RANKED)
    expect(a).toBe("1xET2, 1xMP, 1xBSkin, 1xHC, 1xSOUND")
    expect(b).toBe(a)
  })

  it("puts unranked codes at the default rank, alphabetically between low and high ranks", () => {
    expect(DEFAULT_PRODUCT_CODE_RANK).toBe(100)
    const cfg: ProductCodeConfig = { ...EMPTY_PRODUCT_CODE_CONFIG, ranks: { LATE: 101, EARLY: 99, TIE: 100 } }
    expect(orderProductsSummary("1xLATE, 1xZED, 1xTIE, 1xALPHA, 1xEARLY", cfg)).toBe(
      "1xEARLY, 1xALPHA, 1xTIE, 1xZED, 1xLATE",
    )
  })

  it("ranks by the short code an sku resolves to, and keeps each entry's text", () => {
    const cfg: ProductCodeConfig = { ...ORG, ranks: { K1: 1, HC: 2 } }
    expect(orderProductsSummary("1xACME-K1-HARDCOVER-B2B, 2xUSBC2M-B2B, 1xACME-K1-BLACK-B2B", cfg)).toBe(
      "1xACME-K1-BLACK-B2B, 1xACME-K1-HARDCOVER-B2B, 2xUSBC2M-B2B",
    )
    expect(resolveProductCodes("1xHC, 2xUSBC, 1xK1, 1xK1", cfg)).toEqual([
      { code: "K1", qty: 2 },
      { code: "HC", qty: 1 },
      { code: "USBC", qty: 2 },
    ])
  })

  it("changes nothing for an org with no rank: first-appearance order is kept", () => {
    expect(orderProductsSummary("1xMP, 1xBSkin, 1xET2")).toBe("1xMP, 1xBSkin, 1xET2")
    expect(orderProductsSummary("1xMP, 1xBSkin, 1xET2", { ...EMPTY_PRODUCT_CODE_CONFIG, ranks: {} })).toBe(
      "1xMP, 1xBSkin, 1xET2",
    )
    expect(resolveProductCodes("1xMP, 1xET2").map((e) => e.code)).toEqual(["MP", "ET2"])
  })

  it("leaves a string that is not a quantity list verbatim", () => {
    expect(orderProductsSummary("-", RANKED)).toBe("-")
    expect(orderProductsSummary("2 parcels", RANKED)).toBe("2 parcels")
  })

  it("reads stored ranks, upper-cased, skipping junk, and a value without ranks stays rank-free", () => {
    expect(productCodeConfigFromValue({ ranks: { et2: 1, mp: 2.5, X: "3", SOUND: 1000 } }).ranks).toEqual({
      ET2: 1,
      SOUND: 1000,
    })
    expect(productCodeConfigFromValue({ aliases: {} }).ranks).toBeUndefined()
  })
})

describe("productCodeConfigFromValue", () => {
  it("reads a stored mapping, upper-casing keys and dropping junk entries", () => {
    expect(
      productCodeConfigFromValue({
        strip_prefixes: ["ACME-", 3, ""],
        strip_suffixes: "nope",
        aliases: { "k1-black": "K1", bad: 7, EMPTY: "", LONG: "THIRTEEN-CHAR" },
      }),
    ).toEqual({ strip_prefixes: ["ACME-"], strip_suffixes: [], aliases: { "K1-BLACK": "K1" } })
  })

  it("degrades anything that is not an object to the empty default", () => {
    for (const v of [null, undefined, "x", 4, ["a"]]) {
      expect(productCodeConfigFromValue(v)).toEqual(EMPTY_PRODUCT_CODE_CONFIG)
    }
  })
})

describe("productChipLabel", () => {
  it("passes a short code through untouched", () => {
    expect(productChipLabel("K1")).toBe("K1")
    expect(productChipLabel("VARIANT-STAB")).toBe("VARIANT-STAB")
  })

  it("elides a long code and names a gid by its tail", () => {
    expect(productChipLabel("K1-SOMETHING-VERY-LONG")).toBe("K1-SOMETHIN…")
    expect(productChipLabel("gid://shopify/ProductVariant/50468186128715")).toBe("V128715")
  })
})

describe("formatProductCode", () => {
  it("shows a quantity only when it is not one", () => {
    expect(formatProductCode({ code: "K1", qty: 1 })).toBe("K1")
    expect(formatProductCode({ code: "K1", qty: 3 })).toBe("3xK1")
  })
})
