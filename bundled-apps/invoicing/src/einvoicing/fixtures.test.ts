// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The recorded business-registry and ECB responses are fakes at a boundary: real response
// shapes, every identifying value replaced with fictional ones. This guard keeps them that way:
// any company or person name outside the allow-list, or any SIREN / SIRET / VAT id that is not
// one of the fictional SIRENs, fails.
import { describe, expect, test } from "bun:test"
import { ECB_EMPTY_200, ECB_USD_CSV } from "./fx.fixtures"
import { isValidSiren, isValidSiret, sirenFromFrVat } from "./identity"
import {
  FIXTURE_NAME_ALLOWLIST,
  REGISTRY_RATE_LIMITED,
  REGISTRY_SEARCH_EMPTY,
  REGISTRY_SEARCH_HIT,
} from "./lookup.fixtures"
import { FICTIONAL_SIRENS } from "./test-fixtures"

const NAME_KEYS = new Set([
  "nom_complet",
  "nom_raison_sociale",
  "denomination",
  "nom_commercial",
  "nom",
  "prenoms",
])
const LIST_NAME_KEYS = new Set(["liste_enseignes"])

function collect(node: unknown, out: Array<{ key: string; value: unknown }>, key = ""): void {
  if (Array.isArray(node)) {
    for (const v of node) collect(v, out, key)
    return
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      out.push({ key: k, value: v })
      collect(v, out, k)
    }
  }
}

const fields: Array<{ key: string; value: unknown }> = []
collect(REGISTRY_SEARCH_HIT, fields)
collect(REGISTRY_SEARCH_EMPTY, fields)

describe("recorded registry fixtures are anonymised", () => {
  test("every company, trade and person name is on the fictional allow-list", () => {
    const names = fields
      .filter((f) => NAME_KEYS.has(f.key) && typeof f.value === "string")
      .map((f) => f.value as string)
    for (const f of fields) {
      if (LIST_NAME_KEYS.has(f.key) && Array.isArray(f.value)) names.push(...(f.value as string[]))
    }
    expect(names.length).toBeGreaterThan(3)
    for (const n of names) expect(FIXTURE_NAME_ALLOWLIST).toContain(n)
  })

  test("every SIREN, SIRET and VAT id belongs to a fictional SIREN", () => {
    const fictional = new Set<string>(FICTIONAL_SIRENS)
    const sirens = fields.filter((f) => f.key === "siren").map((f) => String(f.value))
    const sirets = fields.filter((f) => f.key === "siret").map((f) => String(f.value))
    const vats = fields
      .filter((f) => f.key === "tva" && Array.isArray(f.value))
      .flatMap((f) => f.value as string[])
    expect(sirens.length).toBeGreaterThan(0)
    expect(sirets.length).toBeGreaterThan(0)
    expect(vats.length).toBeGreaterThan(0)
    for (const s of sirens) {
      expect(fictional.has(s)).toBe(true)
      expect(isValidSiren(s)).toBe(true)
    }
    for (const s of sirets) {
      expect(fictional.has(s.slice(0, 9))).toBe(true)
      expect(isValidSiret(s)).toBe(true)
    }
    for (const v of vats) {
      const siren = sirenFromFrVat(v, { billingCountry: "FR" })
      expect(siren && fictional.has(siren)).toBe(true)
    }
  })

  test("the recorded shapes: one hit, zero results, and a 429 that carries no Retry-After", () => {
    expect(REGISTRY_SEARCH_HIT.results).toHaveLength(1)
    expect(REGISTRY_SEARCH_HIT.results[0]!.etat_administratif).toBe("A")
    expect(REGISTRY_SEARCH_EMPTY).toEqual({
      results: [],
      total_results: 0,
      page: 1,
      per_page: 1,
      total_pages: 0,
    })
    expect(REGISTRY_RATE_LIMITED.status).toBe(429)
    const headerNames = Object.keys(REGISTRY_RATE_LIMITED.headers).map((h) => h.toLowerCase())
    expect(headerNames).not.toContain("retry-after")
  })
})

describe("recorded ECB fixtures", () => {
  test("the CSV carries one observation per business day and the empty answer is a bare 200", () => {
    const [header, ...rows] = ECB_USD_CSV.trim().split("\n")
    const cols = header!.split(",")
    const period = cols.indexOf("TIME_PERIOD")
    const value = cols.indexOf("OBS_VALUE")
    expect(period).toBeGreaterThan(-1)
    expect(value).toBeGreaterThan(-1)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.split(",")[period]).toBe("2026-10-01")
    expect(rows[0]!.split(",")[value]).toBe("1.1298")
    expect(ECB_EMPTY_200.status).toBe(200)
    expect(ECB_EMPTY_200.body).toBe("")
  })
})
