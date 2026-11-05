// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { buyerTerritory } from "./territory"

const t = (billingCountry: string | null, billingPostcode: string | null = null, vatId: string | null = null) =>
  buyerTerritory({ billingCountry, billingPostcode, vatId })

describe("buyerTerritory", () => {
  test("metropolitan France incl. Corsica is FR", () => {
    expect(t("FR", "75001").territory).toBe("FR")
    expect(t("FR", "20000").territory).toBe("FR")
    expect(t("fr", "69 002", "FR12345678901")).toMatchObject({ territory: "FR", country: "FR" })
  })
  test("Monaco is needs_review/monaco, with or without an FR vat id", () => {
    expect(t("MC", "98000")).toMatchObject({ territory: "needs_review", code: "monaco" })
    expect(t("MC", "98000", "FR40303265045")).toMatchObject({ territory: "needs_review", code: "monaco" })
    expect(t("FR", "98000")).toMatchObject({ territory: "needs_review", code: "monaco" })
  })
  test("DOM with VAT", () => {
    for (const c of ["GP", "MQ", "RE"]) expect(t(c)).toMatchObject({ territory: "needs_review", code: "dom" })
    for (const p of ["97100", "97200", "97400"]) {
      expect(t("FR", p)).toMatchObject({ territory: "needs_review", code: "dom" })
    }
  })
  test("DOM without VAT", () => {
    for (const c of ["GF", "YT"]) expect(t(c)).toMatchObject({ territory: "needs_review", code: "dom_no_vat" })
    for (const p of ["97300", "97600"]) {
      expect(t("FR", p)).toMatchObject({ territory: "needs_review", code: "dom_no_vat" })
    }
  })
  test("COM", () => {
    for (const c of ["PM", "BL", "MF", "WF", "PF", "NC", "TF"]) {
      expect(t(c)).toMatchObject({ territory: "needs_review", code: "com" })
    }
    for (const p of ["97500", "97700", "97800", "98600", "98700", "98800"]) {
      expect(t("FR", p)).toMatchObject({ territory: "needs_review", code: "com" })
    }
  })
  test("other countries are foreign", () => {
    expect(t("DE", "10115", "DE123456789")).toMatchObject({ territory: "foreign", country: "DE" })
    expect(t("US")).toMatchObject({ territory: "foreign", country: "US" })
    expect(t("GR", null, "EL123456789").territory).toBe("foreign")
  })
  test("VAT prefix different from billing country is a conflict", () => {
    expect(t("FR", "75001", "DE123456789")).toMatchObject({
      territory: "needs_review",
      code: "buyer_country_conflict",
    })
    expect(t("DE", "10115", "FR12345678901")).toMatchObject({
      territory: "needs_review",
      code: "buyer_country_conflict",
    })
  })
  test("no usable country is needs_review, never guessed", () => {
    expect(t(null).territory).toBe("needs_review")
    expect(t("").territory).toBe("needs_review")
  })
})
