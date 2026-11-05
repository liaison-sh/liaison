// SPDX-License-Identifier: FSL-1.1-ALv2
// Buyer establishment territory for the French e-invoicing regime. Pure.

export type TerritoryCode = "monaco" | "dom" | "dom_no_vat" | "com" | "buyer_country_conflict"

export interface BuyerTerritory {
  territory: "FR" | "needs_review" | "foreign"
  country: string | null
  code?: TerritoryCode
}

const DOM_VAT = new Set(["GP", "MQ", "RE"])
const DOM_NO_VAT = new Set(["GF", "YT"])
const COM = new Set(["PM", "BL", "MF", "WF", "PF", "NC", "TF"])

/** Countries whose companies legitimately carry an `FR` VAT prefix (French VAT territory + Monaco). */
const FR_VAT_PREFIX_OK = new Set(["FR", "MC", ...DOM_VAT, ...DOM_NO_VAT, ...COM])

function vatPrefix(vatId: string | null | undefined): string | null {
  const m = /^([A-Za-z]{2})/.exec((vatId ?? "").replace(/[\s.-]/g, ""))
  if (!m) return null
  const p = (m[1] ?? "").toUpperCase()
  return p === "EL" ? "GR" : p
}

function postcodeCode(postcode: string): TerritoryCode | null {
  const pc = postcode.replace(/\s/g, "")
  if (pc === "98000") return "monaco"
  if (/^(971|972|974)/.test(pc)) return "dom"
  if (/^(973|976)/.test(pc)) return "dom_no_vat"
  if (/^(975|977|978|98)/.test(pc)) return "com"
  return null
}

export function buyerTerritory(input: {
  billingCountry: string | null | undefined
  billingPostcode: string | null | undefined
  vatId: string | null | undefined
}): BuyerTerritory {
  const country = (input.billingCountry ?? "").trim().toUpperCase() || null
  if (!country) return { territory: "needs_review", country: null }

  const prefix = vatPrefix(input.vatId)
  if (prefix && prefix !== country && !(prefix === "FR" && FR_VAT_PREFIX_OK.has(country))) {
    return { territory: "needs_review", country, code: "buyer_country_conflict" }
  }

  if (country === "MC") return { territory: "needs_review", country, code: "monaco" }
  if (DOM_VAT.has(country)) return { territory: "needs_review", country, code: "dom" }
  if (DOM_NO_VAT.has(country)) return { territory: "needs_review", country, code: "dom_no_vat" }
  if (COM.has(country)) return { territory: "needs_review", country, code: "com" }
  if (country === "FR") {
    const code = postcodeCode(input.billingPostcode ?? "")
    if (code) return { territory: "needs_review", country, code }
    return { territory: "FR", country }
  }
  return { territory: "foreign", country }
}
