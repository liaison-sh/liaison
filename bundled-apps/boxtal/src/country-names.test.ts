// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { countryIsoFromName, countryKey, namesCountry } from "./country-names"

describe("countryIsoFromName", () => {
  const cases: Array<[string, string]> = [
    ["Germany", "DE"],
    ["Deutschland", "DE"],
    ["Allemagne", "DE"],
    ["Alemania", "DE"],
    ["Niemcy", "DE"],
    ["GERMANY", "DE"],
    ["France", "FR"],
    ["Frankreich", "FR"],
    ["The Netherlands", "NL"],
    ["Netherlands", "NL"],
    ["Holland", "NL"],
    ["Pays-Bas", "NL"],
    ["Nederland", "NL"],
    ["UK", "GB"],
    ["U.K.", "GB"],
    ["Great Britain", "GB"],
    ["United Kingdom", "GB"],
    ["Royaume-Uni", "GB"],
    ["Großbritannien", "GB"],
    ["USA", "US"],
    ["U.S.A.", "US"],
    ["United States of America", "US"],
    ["États-Unis", "US"],
    ["Czechia", "CZ"],
    ["Czech Republic", "CZ"],
    ["Česko", "CZ"],
    ["Österreich", "AT"],
    ["Oesterreich", "AT"],
    ["Schweiz", "CH"],
    ["Suisse", "CH"],
    ["Svizzera", "CH"],
    ["España", "ES"],
    ["espana", "ES"],
    ["Italia", "IT"],
    ["Włochy", "IT"],
    ["Polska", "PL"],
    ["Belgique", "BE"],
    ["België", "BE"],
    ["Norge", "NO"],
    ["Sverige", "SE"],
    ["Danmark", "DK"],
    ["Suomi", "FI"],
    ["Éire", "IE"],
    ["Magyarország", "HU"],
    ["Canada", "CA"],
    ["Australia", "AU"],
    ["Japan", "JP"],
    ["Japon", "JP"],
    ["  luxembourg  ", "LU"],
  ]
  for (const [name, iso] of cases) {
    it(`${name} -> ${iso}`, () => expect(countryIsoFromName(name)).toBe(iso))
  }

  it("is null for text that is not a listed country name", () => {
    expect(countryIsoFromName("Berlin")).toBeNull()
    expect(countryIsoFromName("10115 Berlin")).toBeNull()
    expect(countryIsoFromName("")).toBeNull()
    expect(countryIsoFromName("DE")).toBeNull()
  })

  it("does not depend on Intl", () => {
    const realIntl = globalThis.Intl
    // biome-ignore lint/performance/noDelete: the QuickJS sandbox has no Intl at all
    delete (globalThis as { Intl?: unknown }).Intl
    let got: string | null
    try {
      got = countryIsoFromName("Deutschland")
    } finally {
      ;(globalThis as { Intl?: unknown }).Intl = realIntl
    }
    expect(got).toBe("DE")
  })
})

describe("namesCountry", () => {
  it("accepts the code itself and every listed name of the expected country", () => {
    expect(namesCountry("DE", "DE")).toBe(true)
    expect(namesCountry("de", "de")).toBe(true)
    expect(namesCountry("Germany", "DE")).toBe(true)
    expect(namesCountry("U.S.", "US")).toBe(true)
    expect(namesCountry("america", "US")).toBe(true)
    expect(namesCountry("Etats-Unis d'Amérique", "US")).toBe(true)
    expect(namesCountry("England", "GB")).toBe(true)
  })

  it("rejects another country's name, a city, or a missing code", () => {
    expect(namesCountry("France", "DE")).toBe(false)
    expect(namesCountry("Berlin", "DE")).toBe(false)
    expect(namesCountry("Germany", null)).toBe(false)
    expect(namesCountry("", "DE")).toBe(false)
  })
})

describe("countryKey", () => {
  it("folds case, diacritics and the letters NFD cannot split", () => {
    expect(countryKey("Österreich")).toBe("osterreich")
    expect(countryKey("Großbritannien")).toBe("grossbritannien")
    expect(countryKey("Włochy")).toBe("wlochy")
    expect(countryKey("U.S.A.")).toBe("usa")
  })
})
