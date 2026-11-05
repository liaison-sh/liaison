// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  buildCustomsArticles,
  categoryToCustomsBasis,
  contentCategoryNumeric,
  contentCategoryV3,
  countMandatoryEmpty,
  requiresCustoms,
  type CustomsDocLine,
} from "./customs"

function docLine(over: Partial<CustomsDocLine> = {}): CustomsDocLine {
  return {
    id: over.id ?? "line-0",
    description: "Generic line",
    quantity: 1,
    unit_price_minor: 5000n as unknown as bigint,
    hs_code: "851762",
    country_of_origin: "FR",
    customs_description: "Tessera touchpad",
    product_source: "shopify",
    external_id: "V1",
    ...over,
  }
}

const doc = { incoterm: "DAP", currency: "EUR" }

function profiles(map: Record<string, number>) {
  const out: Record<string, { unit_weight: number }> = {}
  for (const [k, w] of Object.entries(map)) out[k] = { unit_weight: w }
  return out
}

describe("buildCustomsArticles", () => {
  it("maps a two-line export doc to v3 articles with the invoice customs snapshot", () => {
    const lines = [
      docLine({ external_id: "V1", customs_description: "Touchpad", hs_code: "851762", country_of_origin: "FR", unit_price_minor: 10000n as unknown as bigint, quantity: 2 }),
      docLine({ external_id: "V2", customs_description: "Cable", hs_code: "854442", country_of_origin: "CN", unit_price_minor: 2500n as unknown as bigint, quantity: 1 }),
    ]
    const arts = buildCustomsArticles(lines, doc, profiles({ "shopify:V1": 0.5, "shopify:V2": 0.1 }))
    expect(arts).toHaveLength(2)
    expect(arts[0]).toMatchObject({
      description: "Touchpad",
      quantity: 2,
      unitWeight: 0.5,
      unitValue: { value: 100, currency: "EUR" },
      originCountry: "FR",
      tariffNumber: "851762",
    })
    expect(arts[1]).toMatchObject({
      description: "Cable",
      quantity: 1,
      unitWeight: 0.1,
      unitValue: { value: 25, currency: "EUR" },
      originCountry: "CN",
      tariffNumber: "854442",
    })
  })

  it("prefers customs_description, falls back to description, truncates to 64", () => {
    const long = "y".repeat(100)
    const arts = buildCustomsArticles(
      [docLine({ customs_description: null, description: long })],
      doc,
      profiles({ "shopify:V1": 0.5 }),
    )
    expect(arts[0]!.description.length).toBe(64)
  })

  it("zero re-entry: a fully-profiled export doc yields zero mandatory-empty fields", () => {
    const lines = [
      docLine({ external_id: "V1", hs_code: "851762", country_of_origin: "FR" }),
      docLine({ external_id: "V2", hs_code: "854442", country_of_origin: "CN" }),
    ]
    const arts = buildCustomsArticles(lines, doc, profiles({ "shopify:V1": 0.5, "shopify:V2": 0.1 }))
    expect(arts.some((a) => a.blocked)).toBe(false)
    expect(countMandatoryEmpty(arts)).toBe(0)
  })

  it("missing unit_weight: a line with no profile match → blocked missing_weight", () => {
    const arts = buildCustomsArticles([docLine({ external_id: "V9" })], doc, profiles({}))
    expect(arts[0]!.blocked).toBe(true)
    expect(arts[0]!.reason).toBe("missing_weight")
    expect(countMandatoryEmpty(arts)).toBe(1)
  })

  it("incomplete: a non-EU line missing hs_code/origin → tariffNumber/originCountry null + incomplete", () => {
    const arts = buildCustomsArticles(
      [docLine({ hs_code: null, country_of_origin: null })],
      doc,
      profiles({ "shopify:V1": 0.5 }),
    )
    expect(arts[0]!.tariffNumber).toBeNull()
    expect(arts[0]!.originCountry).toBeNull()
    expect(arts[0]!.incomplete).toBe(true)
    // M1: `incomplete` counts as a re-entry burden ONLY on a customs-required
    // route. On an intra-EU route (no declaration needed) it must NOT count.
    expect(countMandatoryEmpty(arts, true)).toBe(1)
    expect(countMandatoryEmpty(arts, false)).toBe(0)
  })

  it("editable override wins without mutating the source doc", () => {
    const lines = [docLine({ external_id: "V1" })]
    const snapshot = JSON.parse(JSON.stringify(lines, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))
    const arts = buildCustomsArticles(lines, doc, profiles({ "shopify:V1": 0.5 }), {
      overrides: { "line-0": { description: "Custom name", unitWeight: 2, unitValue: 99 } },
    })
    expect(arts[0]!.description).toBe("Custom name")
    expect(arts[0]!.unitWeight).toBe(2)
    expect(arts[0]!.unitValue.value).toBe(99)
    // source untouched
    const after = JSON.parse(JSON.stringify(lines, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))
    expect(after).toEqual(snapshot)
  })

  it("tariffNumber + originCountry override wins (HS-code correction via set_customs persist path)", () => {
    // Regression: a mis-classified line carries hs_code 9207.90 on the invoice; correcting it to
    // 8543.70 via set_customs must surface on the re-derived draft. Before the fix the override
    // dropped tariffNumber/originCountry and the article kept the wrong code (a silent no-op).
    const lines = [docLine({ external_id: "V1", hs_code: "9207.90", country_of_origin: "CN" })]
    const arts = buildCustomsArticles(lines, doc, profiles({ "shopify:V1": 0.5 }), {
      overrides: { "line-0": { tariffNumber: "8543.70", originCountry: "FR" } },
    })
    expect(arts[0]!.tariffNumber).toBe("8543.70")
    expect(arts[0]!.originCountry).toBe("FR")
    // an article with both fields present is no longer flagged incomplete
    expect(arts[0]!.incomplete).toBeUndefined()
  })

  it("declared total = Σ(quantity × unitValue)", () => {
    const lines = [
      docLine({ external_id: "V1", quantity: 2, unit_price_minor: 10000n as unknown as bigint }),
      docLine({ external_id: "V2", quantity: 1, unit_price_minor: 2500n as unknown as bigint }),
    ]
    const arts = buildCustomsArticles(lines, doc, profiles({ "shopify:V1": 0.5, "shopify:V2": 0.1 }))
    const total = arts.reduce((s, a) => s + a.quantity * a.unitValue.value, 0)
    expect(total).toBe(225) // 2*100 + 1*25
  })
})

describe("requiresCustoms", () => {
  it("intra-EU route → false", () => {
    expect(requiresCustoms("FR", "DE")).toBe(false)
  })
  it("EU → non-EU route → true", () => {
    expect(requiresCustoms("FR", "US")).toBe(true)
  })
  it("an explicit invoice flag wins", () => {
    expect(requiresCustoms("FR", "DE", true)).toBe(true)
  })
})

describe("content category round-trip", () => {
  it("contentCategoryNumeric strips the v3 prefix", () => {
    expect(contentCategoryNumeric("content:v1:10120")).toBe("10120")
  })
  it("contentCategoryV3 re-adds the prefix", () => {
    expect(contentCategoryV3("10120")).toBe("content:v1:10120")
  })
  it("round-trips", () => {
    expect(contentCategoryNumeric(contentCategoryV3("10120"))).toBe("10120")
  })
})

describe("categoryToCustomsBasis", () => {
  it("sale -> SALE (the dutiable commercial-sale basis)", () => {
    expect(categoryToCustomsBasis("sale")).toBe("SALE")
  })
  it("gift -> GIFT", () => {
    expect(categoryToCustomsBasis("gift")).toBe("GIFT")
  })
  it("repair -> REPAIR", () => {
    expect(categoryToCustomsBasis("repair")).toBe("REPAIR")
  })
  it("return -> RETURN", () => {
    expect(categoryToCustomsBasis("return")).toBe("RETURN")
  })
  it("an unknown/missing category defaults to SALE (the safe dutiable default)", () => {
    expect(categoryToCustomsBasis(undefined)).toBe("SALE")
    expect(categoryToCustomsBasis(null)).toBe("SALE")
    expect(categoryToCustomsBasis("bogus")).toBe("SALE")
  })
})

describe("buildCustomsArticles — string-quantity coercion (prod export 400)", () => {
  it("coerces invoicing's decimal-string quantities to numbers", () => {
    const line = docLine({ external_id: "V1" })
    ;(line as { quantity: unknown }).quantity = "2.000"
    const arts = buildCustomsArticles([line], doc, profiles({ "shopify:V1": 0.5 }))
    expect(arts[0]!.quantity).toBe(2)
    expect(typeof arts[0]!.quantity).toBe("number")
  })
})

describe("buildCustomsArticles -- declared currency (ticket-10154)", () => {
  const usdDoc = { incoterm: "DAP", currency: "USD" }
  const fx = { rate: 0.9, from: "USD", to: "EUR" as const, source: "shopify_order_totals" as const }

  it("converts a non-EUR invoice value to EUR instead of relabelling it", () => {
    const lines = [docLine({ unit_price_minor: 100000n as unknown as bigint, quantity: 1 })]
    const [a] = buildCustomsArticles(lines, usdDoc, profiles({ "shopify:V1": 1 }), { fx })
    // Pre-fix this declared 1000 as EUR: same number, wrong unit, over-valued at customs.
    expect(a!.unitValue).toEqual({ value: 900, currency: "EUR" })
    expect(a!.blocked).toBeUndefined()
  })

  it("blocks a non-EUR line when no rate could be derived, rather than declaring it at face value", () => {
    const lines = [docLine({ unit_price_minor: 100000n as unknown as bigint })]
    const [a] = buildCustomsArticles(lines, usdDoc, profiles({ "shopify:V1": 1 }), { fx: null })
    expect(a!.blocked).toBe(true)
    expect(a!.reason).toBe("fx_unavailable")
  })

  it("treats an operator override as an already-declared EUR amount and unblocks the line", () => {
    const lines = [docLine({ id: "l1", unit_price_minor: 100000n as unknown as bigint })]
    const [a] = buildCustomsArticles(lines, usdDoc, profiles({ "shopify:V1": 1 }), {
      fx: null,
      overrides: { l1: { unitValue: 850 } },
    })
    expect(a!.unitValue).toEqual({ value: 850, currency: "EUR" })
    expect(a!.blocked).toBeUndefined()
  })

  it("does not convert an override when a rate IS available (it is already declared-currency)", () => {
    const lines = [docLine({ id: "l1", unit_price_minor: 100000n as unknown as bigint })]
    const [a] = buildCustomsArticles(lines, usdDoc, profiles({ "shopify:V1": 1 }), {
      fx,
      overrides: { l1: { unitValue: 850 } },
    })
    expect(a!.unitValue.value).toBe(850)
  })

  it("leaves an EUR invoice untouched", () => {
    const lines = [docLine({ unit_price_minor: 69900n as unknown as bigint })]
    const [a] = buildCustomsArticles(lines, doc, profiles({ "shopify:V1": 1 }))
    expect(a!.unitValue).toEqual({ value: 699, currency: "EUR" })
    expect(a!.blocked).toBeUndefined()
  })

  it("scales minor units by the invoice currency's exponent, not a hardcoded 100", () => {
    // 120000 JPY is 120000 major units (zero-decimal), not 1200.
    const lines = [docLine({ unit_price_minor: 120000n as unknown as bigint })]
    const jpyFx = { ...fx, from: "JPY", rate: 0.0062 }
    const [a] = buildCustomsArticles(lines, { incoterm: "DAP", currency: "JPY" }, profiles({ "shopify:V1": 1 }), { fx: jpyFx })
    expect(a!.unitValue.value).toBe(744)
  })

  it("reports missing weight ahead of an unresolved rate (the more actionable defect)", () => {
    const lines = [docLine({ unit_price_minor: 100000n as unknown as bigint })]
    const [a] = buildCustomsArticles(lines, usdDoc, profiles({}), { fx: null })
    expect(a!.blocked).toBe(true)
    expect(a!.reason).toBe("missing_weight")
  })
})
