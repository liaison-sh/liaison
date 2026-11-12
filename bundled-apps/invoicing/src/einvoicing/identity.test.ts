// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import {
  isSirenConfirmed,
  isValidSiren,
  isValidSiret,
  LEGAL_FORM_TOKENS,
  namesMatch,
  normaliseCompanyName,
  sirenFromFrVat,
} from "./identity"

// Fictional, Luhn-valid test numbers.
const SIREN = "123456782"
const SIRET = "12345678200010"

function frVat(siren: string): string {
  const key = (12 + 3 * (Number(siren) % 97)) % 97
  return `FR${String(key).padStart(2, "0")}${siren}`
}

describe("isValidSiren / isValidSiret", () => {
  test("Luhn", () => {
    expect(isValidSiren(SIREN)).toBe(true)
    expect(isValidSiren("123456783")).toBe(false)
    expect(isValidSiren("12345678")).toBe(false)
    expect(isValidSiren("12345678a")).toBe(false)
    expect(isValidSiren(" 123 456 782 ")).toBe(true)
    expect(isValidSiren(null)).toBe(false)
  })
  test("SIRET prefix must be a valid SIREN and the whole must pass Luhn", () => {
    expect(isValidSiret(SIRET)).toBe(true)
    expect(isValidSiret("12345678200011")).toBe(false)
    expect(isValidSiret("1234567820001")).toBe(false)
  })
  test("SIRET whose SIREN prefix fails Luhn is invalid even when the 14 digits pass", () => {
    expect(isValidSiret("90000000200007")).toBe(false)
    expect(isValidSiret("90000000100009")).toBe(true)
  })

  test("La Poste exception: digit sum divisible by 5", () => {
    expect(isValidSiret("35600000000001")).toBe(true)
    expect(isValidSiret("35600000000002")).toBe(false)
    expect(isValidSiret("12345678200001")).toBe(false)
  })
})

describe("sirenFromFrVat", () => {
  test("derives from a numeric-key FR vat id", () => {
    expect(sirenFromFrVat(frVat(SIREN), { billingCountry: "FR" })).toBe(SIREN)
  })
  test("bad key, alphabetic key, non-FR prefix, Monaco billing -> null", () => {
    const good = frVat(SIREN)
    const badKey = `FR${String((Number(good.slice(2, 4)) + 1) % 97).padStart(2, "0")}${SIREN}`
    expect(sirenFromFrVat(badKey, { billingCountry: "FR" })).toBeNull()
    expect(sirenFromFrVat(`FRAB${SIREN}`, { billingCountry: "FR" })).toBeNull()
    expect(sirenFromFrVat(`DE${SIREN}`, { billingCountry: "DE" })).toBeNull()
    expect(sirenFromFrVat(good, { billingCountry: "MC" })).toBeNull()
    expect(sirenFromFrVat(null, { billingCountry: "FR" })).toBeNull()
  })
  test("tolerates spaces and lowercase", () => {
    const good = frVat(SIREN)
    expect(
      sirenFromFrVat(`${good.slice(0, 2)} ${good.slice(2, 4)} ${good.slice(4)}`.toLowerCase(), {
        billingCountry: "FR",
      }),
    ).toBe(SIREN)
  })
})

describe("names", () => {
  test("normalise strips accents, punctuation, case and legal-form tokens", () => {
    expect(normaliseCompanyName("  Société Étoile, S.A.R.L. ")).toBe("societe etoile")
    expect(normaliseCompanyName("ACME SAS")).toBe("acme")
    expect(LEGAL_FORM_TOKENS).toContain("sas")
    expect(LEGAL_FORM_TOKENS).toContain("sarl")
  })
  test("namesMatch: legal form and case variants", () => {
    expect(namesMatch("Acme SAS", "ACME")).toBe(true)
    expect(namesMatch("Les Ateliers du Nord", "LES ATELIERS DU NORD SARL")).toBe(true)
  })
  test("namesMatch: small typo passes, different names fail", () => {
    expect(namesMatch("Boulangerie Dupont", "Boulangerie Dupond")).toBe(true)
    expect(namesMatch("Boulangerie Dupont", "Garage Martin")).toBe(false)
  })
  test("namesMatch: whole-token prefix", () => {
    expect(namesMatch("Acme", "Acme Industries France")).toBe(true)
    expect(namesMatch("Acm", "Acme Industries France")).toBe(false)
  })
  test("namesMatch: empty never matches", () => {
    expect(namesMatch("", "Acme")).toBe(false)
    expect(namesMatch("SAS", "SARL")).toBe(false)
  })
})

describe("isSirenConfirmed", () => {
  test("only a registry-checked write sets confirmed_via", () => {
    expect(isSirenConfirmed({ siren: SIREN, source: "derived", confirmed_via: null })).toBe(false)
    expect(isSirenConfirmed({ siren: SIREN, source: "vat_derived" })).toBe(false)
    expect(isSirenConfirmed({ siren: SIREN, source: "registry", confirmed_via: "auto" })).toBe(true)
    expect(isSirenConfirmed({ siren: SIREN, source: "manual", confirmed_via: "approval" })).toBe(
      true,
    )
    expect(isSirenConfirmed(null)).toBe(false)
    expect(isSirenConfirmed(undefined)).toBe(false)
  })
})
