// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Booking lines carry Pennylane's per-line `vat_rate` enum (verified against the live list: e.g.
// FR_200, DE_190, crossborder, extracom, exempt). The mapping from the invoicing app's tax
// treatment is on the accountant sign-off list. There is no 0 % `intracom_*` member (those carry a
// French rate, for intra-EU acquisitions), so a 0 % intra-EU supply of goods books as
// `crossborder`, like reverse-charged services.
import type { BookingLine } from "@liaison/app-sdk/contracts"

/** Members of the enum this mapping can produce (subset of the 176 verified members). */
const COUNTRY_RATES: Readonly<Record<string, readonly number[]>> = {
  FR: [21, 55, 100, 200],
  AT: [100, 130, 190, 200], BE: [60, 120, 210], BG: [90, 200], CY: [30, 50, 80, 90, 190], CZ: [100, 120, 150, 210],
  DE: [70, 190], DK: [250], EE: [90, 200, 220, 240], ES: [40, 70, 100, 210], FI: [100, 135, 140, 240, 255],
  GR: [40, 60, 130, 170, 240], HR: [50, 130, 250], HU: [50, 180, 270], IE: [48, 90, 135, 210, 230],
  IT: [40, 50, 100, 220], LT: [50, 90, 120, 210], LU: [30, 70, 80, 120, 130, 140, 160, 170], LV: [50, 120, 210],
  MT: [50, 70, 120, 180], NL: [90, 210], PL: [50, 80, 230], PT: [60, 130, 160, 180, 220, 230], RO: [50, 90, 110, 190, 210],
  SE: [60, 120, 250], SI: [50, 95, 220], SK: [50, 100, 190, 200, 230],
}

export type VatRateResult = { ok: true; vat_rate: string } | { ok: false; reason: string }

export function pennylaneVatRate(line: BookingLine, sellerCountry = "FR"): VatRateResult {
  const permille = Math.round(line.tax_rate_bp / 10) // 2000 bp = 20.00 % → 200
  switch (line.tax_treatment) {
    case "eu_domestic": {
      if (permille === 0) return { ok: true, vat_rate: "exempt" }
      const ok = COUNTRY_RATES[sellerCountry]?.includes(permille)
      return ok ? { ok: true, vat_rate: `${sellerCountry}_${permille}` } : { ok: false, reason: `no ${sellerCountry} rate ${permille / 10}%` }
    }
    case "eu_reverse_charge":
      return { ok: true, vat_rate: "crossborder" }
    case "eu_export_non_eu":
      return { ok: true, vat_rate: "extracom" }
    case "eu_b2c_oss": {
      if (line.rate_is_placeholder) return { ok: false, reason: "the destination rate is a placeholder" }
      const cc = (line.destination_country ?? "").toUpperCase()
      if (COUNTRY_RATES[cc]?.includes(permille)) return { ok: true, vat_rate: `${cc}_${permille}` }
      return { ok: false, reason: `no ${cc || "destination"} rate ${permille / 10}%` }
    }
    default:
      return { ok: false, reason: `tax treatment ${line.tax_treatment} has no booking rate` }
  }
}
