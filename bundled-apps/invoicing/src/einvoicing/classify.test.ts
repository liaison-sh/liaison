// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { type ClassifyInput, classifyRegime } from "./classify"

const SIREN = "123456782"

const base: ClassifyInput = {
  docType: "invoice",
  issuerCountry: "FR",
  issuerVatRegistered: true,
  customerKind: "business",
  billingCountry: "FR",
  billingPostcode: "75001",
  vatId: null,
  buyerSiren: SIREN,
  sirenStatus: "A",
  territoryTreatment: null,
}
const c = (over: Partial<ClassifyInput>) => classifyRegime({ ...base, ...over })

describe("classifyRegime, matrix rows", () => {
  test("1 business FR valid siren -> e_invoice", () => {
    const r = c({})
    expect(r.regime).toBe("e_invoice")
    expect(r.reasons.length).toBeGreaterThan(0)
  })
  test("2 business FR missing siren -> einvoice_data_missing", () => {
    expect(c({ buyerSiren: null })).toMatchObject({ regime: null, error: { code: "einvoice_data_missing" } })
    expect(c({ buyerSiren: "" })).toMatchObject({ regime: null, error: { code: "einvoice_data_missing" } })
  })
  test("3 invalid luhn -> siren_invalid", () => {
    expect(c({ buyerSiren: "123456783" })).toMatchObject({ regime: null, error: { code: "siren_invalid" } })
  })
  test("4 individual FR -> e_reporting", () => {
    expect(c({ customerKind: "individual", buyerSiren: null }).regime).toBe("e_reporting")
  })
  test("5 individual DE -> e_reporting", () => {
    expect(c({ customerKind: "individual", billingCountry: "DE", billingPostcode: "10115", buyerSiren: null }).regime).toBe(
      "e_reporting",
    )
  })
  test("6 individual US -> e_reporting", () => {
    expect(c({ customerKind: "individual", billingCountry: "US", billingPostcode: "10001", buyerSiren: null }).regime).toBe(
      "e_reporting",
    )
  })
  test("7 business DE with VAT -> e_reporting", () => {
    expect(
      c({ billingCountry: "DE", billingPostcode: "10115", vatId: "DE123456789", buyerSiren: null }).regime,
    ).toBe("e_reporting")
  })
  test("8 business US -> e_reporting", () => {
    expect(c({ billingCountry: "US", billingPostcode: "10001", buyerSiren: null }).regime).toBe("e_reporting")
  })
  test("9 kind missing FR -> customer_kind_missing", () => {
    expect(c({ customerKind: null, buyerSiren: null })).toMatchObject({
      regime: null,
      error: { code: "customer_kind_missing" },
    })
  })
  test("10 kind missing DE -> e_reporting (a missing kind never blocks outside FR)", () => {
    expect(c({ customerKind: null, billingCountry: "DE", billingPostcode: "10115", buyerSiren: null }).regime).toBe(
      "e_reporting",
    )
  })
  test("11 credit note of an e_invoice -> e_invoice", () => {
    const r = c({ docType: "credit_note", original: { regime: "e_invoice", transmissionStatus: "accepted" } })
    expect(r.regime).toBe("e_invoice")
    expect(r.internalCancellation).toBeFalsy()
  })
  test("12 credit note of a refused / rejected original -> e_invoice + internal cancellation", () => {
    for (const transmissionStatus of ["refused", "rejected"]) {
      const r = c({ docType: "credit_note", original: { regime: "e_invoice", transmissionStatus } })
      expect(r.regime).toBe("e_invoice")
      expect(r.internalCancellation).toBe(true)
    }
  })
  test("13 credit note of a legacy original (no stored regime) classifies from current data", () => {
    const r = c({ docType: "credit_note", original: { regime: null } })
    expect(r.regime).toBe("e_invoice")
    expect(c({ docType: "credit_note", original: { regime: null }, buyerSiren: null })).toMatchObject({
      regime: null,
      error: { code: "einvoice_data_missing" },
    })
    expect(c({ docType: "credit_note" }).regime).toBe("e_invoice")
  })
  test("credit note keeps the original's stored regime even if buyer data changed", () => {
    expect(
      c({ docType: "credit_note", customerKind: "individual", original: { regime: "e_invoice" } }).regime,
    ).toBe("e_invoice")
    expect(c({ docType: "credit_note", original: { regime: "e_reporting" } }).regime).toBe("e_reporting")
  })
  test("14 quote / proforma / purchase order -> out_of_scope", () => {
    for (const docType of ["quote", "proforma", "purchase_order"]) {
      expect(c({ docType }).regime).toBe("out_of_scope")
    }
  })
  test("15 issuer not in France -> out_of_scope", () => {
    expect(c({ issuerCountry: "DE" }).regime).toBe("out_of_scope")
  })
  test("issuer FR without VAT registration -> out_of_scope", () => {
    expect(c({ issuerVatRegistered: false }).regime).toBe("out_of_scope")
    expect(c({ issuerVatRegistered: false, docType: "credit_note", original: { regime: "e_invoice" } }).regime).toBe(
      "out_of_scope",
    )
  })
  test("16 ceased registry status -> siren_inactive", () => {
    expect(c({ sirenStatus: "C" })).toMatchObject({ regime: null, error: { code: "siren_inactive" } })
  })
  test("17 public entity -> out_of_scope (public_entity_chorus_pro)", () => {
    const r = c({ customerKind: "public_entity" })
    expect(r.regime).toBe("out_of_scope")
    expect(r.reasons.map((x) => x.code)).toContain("public_entity_chorus_pro")
  })
  test("18 non registered entity -> e_reporting", () => {
    expect(c({ customerKind: "non_registered_entity", buyerSiren: null }).regime).toBe("e_reporting")
  })
  test("19 auto-entrepreneur business with siren -> e_invoice", () => {
    expect(c({}).regime).toBe("e_invoice")
  })
  test("20 individual holding a siren -> e_reporting", () => {
    expect(c({ customerKind: "individual" }).regime).toBe("e_reporting")
  })
  test("21 FR billing e_invoice regardless of shipping (establishment decides)", () => {
    expect(c({ billingCountry: "FR" }).regime).toBe("e_invoice")
  })
  test("22 DE billing -> e_reporting", () => {
    expect(c({ billingCountry: "DE", billingPostcode: "10115", buyerSiren: null }).regime).toBe("e_reporting")
  })
  test("23 FR billing with DE VAT prefix -> needs_review", () => {
    const r = c({ vatId: "DE123456789" })
    expect(r.regime).toBe("needs_review")
    expect(r.reasons.map((x) => x.code)).toContain("buyer_country_conflict")
  })
  test("24 Monaco with FR vat id -> needs_review", () => {
    const r = c({ billingCountry: "MC", billingPostcode: "98000", vatId: "FR40303265045", buyerSiren: null })
    expect(r.regime).toBe("needs_review")
    expect(r.reasons.map((x) => x.code)).toContain("monaco")
  })
  test("25 RE / GF / PF -> needs_review", () => {
    for (const billingCountry of ["RE", "GF", "PF"]) {
      expect(c({ billingCountry, billingPostcode: null }).regime).toBe("needs_review")
    }
  })
  test("26 needs_review with territory treatment", () => {
    expect(c({ billingCountry: "RE", territoryTreatment: "as_fr" }).regime).toBe("e_invoice")
    expect(c({ billingCountry: "RE", territoryTreatment: "as_foreign", buyerSiren: null }).regime).toBe("e_reporting")
    expect(c({ vatId: "DE123456789", territoryTreatment: "as_fr" }).regime).toBe("e_invoice")
  })
  test("as_fr then goes through the FR rules (still needs a kind / siren)", () => {
    expect(c({ billingCountry: "RE", territoryTreatment: "as_fr", buyerSiren: null })).toMatchObject({
      error: { code: "einvoice_data_missing" },
    })
  })
  test("27 order-paid style input (business FR valid) -> e_invoice", () => {
    expect(c({ vatId: "FR40123456782" }).regime).toBe("e_invoice")
  })
})

describe("classifyRegime, reasons", () => {
  test("every reason has a code, English and French text; French carries accents where natural", () => {
    for (const r of [c({}), c({ customerKind: "public_entity" }), c({ docType: "quote" }), c({ vatId: "DE1" })]) {
      for (const reason of r.reasons) {
        expect(reason.code.length).toBeGreaterThan(0)
        expect(reason.en.length).toBeGreaterThan(0)
        expect(reason.fr.length).toBeGreaterThan(0)
      }
    }
    const fr = c({ customerKind: "public_entity" }).reasons.map((x) => x.fr).join(" ")
    expect(fr).toMatch(/[éèêàç]/)
  })
})
