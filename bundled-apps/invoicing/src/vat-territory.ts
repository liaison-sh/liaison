// SPDX-License-Identifier: FSL-1.1-ALv2
//
// French VAT territories: metropolitan France, the overseas departments where French VAT applies
// at its own rates (Guadeloupe, Martinique, La Réunion), the departments where it does not
// (Guyane, Mayotte), and the overseas collectivities outside it. Pure.
//
// Sources (BOFIP, read 2026-11-28; check with your accountant):
//  - "France" for VAT is metropolitan France + Guadeloupe + Martinique + La Réunion
//    (BOI-TVA-CHAMP-20-10 § 1). VAT is not applicable in Guyane and Mayotte (CGI art. 294-1;
//    BOI-TVA-GEO-20 § 10), nor in Saint-Martin, Saint-Barthélemy, Saint-Pierre-et-Miquelon,
//    Polynésie française, Wallis-et-Futuna, Nouvelle-Calédonie, the TAAF and Clipperton
//    (BOI-TVA-CHAMP-20-10 § 10, remarque 3). All of them are outside the EU VAT territory.
//  - Rates in Guadeloupe, Martinique and La Réunion: 8.5 % normal, 2.1 % reduced (CGI art. 296-1);
//    1.05 % and 1.75 % special rates (art. 296 bis, 298 septies) (BOI-TVA-GEO-20-10).
//  - Goods: these departments are third territories (CGI art. 294-2 and 3): a shipment between
//    metropolitan France and a department, or between La Réunion and the Antilles, is an export.
//    Guadeloupe and Martinique are one market (BOI-TVA-GEO-20 § 40).
//  - Services: they are NOT third territories; the rate is the one of the place where art. 259 to
//    259 D locate the service, with no reverse charge between them (BOI-TVA-GEO-20-40 § 20-40,
//    § 110-230).

/** The kind of a territory for French VAT. */
export type VatTerritoryKind =
  /** Metropolitan France (Corsica and Monaco included for these rules). */
  | "fr_metro"
  /** Guadeloupe, Martinique, La Réunion: French VAT at their own rates. */
  | "dom_vat"
  /** Guyane, Mayotte: French territory, VAT not applicable. */
  | "dom_no_vat"
  /** Overseas collectivities and other territories outside French VAT: third territories. */
  | "com"
  /** Anything else: an EU member state or a third country, as the ISO code says. */
  | "other"

const DOM_VAT = new Set(["GP", "MQ", "RE"])
const DOM_NO_VAT = new Set(["GF", "YT"])
const COM = new Set(["BL", "MF", "PM", "WF", "PF", "NC", "TF"])

/** Standard VAT rate (basis points) of each French VAT territory (CGI art. 278 and 296-1 b). */
export const FR_TERRITORY_STANDARD_RATE_BP: Readonly<Record<string, number>> = {
  FR: 2000,
  GP: 850,
  MQ: 850,
  RE: 850,
}

/** The rates of Guadeloupe, Martinique and La Réunion (CGI art. 296-1, 296 bis, 298 septies).
 *  Only `standard` is a default; the others are per-line overrides, as in metropolitan France. */
export const DOM_VAT_RATES_BP = { standard: 850, reduced: 210, press: 105, live_animals: 175 }

/** Overseas postcodes (La Poste) to the territory code. Saint-Barthélemy and Saint-Martin use
 *  971xx postcodes (97133, 97150) as well as the 977 / 978 INSEE prefixes. */
function postcodeTerritory(postcode: string | null | undefined): string | null {
  const pc = (postcode ?? "").replace(/\s/g, "")
  if (!/^\d{5}$/.test(pc)) return null
  if (pc === "97133") return "BL"
  if (pc === "97150") return "MF"
  const p3 = pc.slice(0, 3)
  switch (p3) {
    case "971":
      return "GP"
    case "972":
      return "MQ"
    case "973":
      return "GF"
    case "974":
      return "RE"
    case "975":
      return "PM"
    case "976":
      return "YT"
    case "977":
      return "BL"
    case "978":
      return "MF"
    case "984":
      return "TF"
    case "986":
      return "WF"
    case "987":
      return "PF"
    case "988":
      return "NC"
    default:
      return null
  }
}

/**
 * The tax territory of an address, as an ISO 3166-1 code: a French address (`FR`) with an
 * overseas postcode is that territory's own code (FR 97411 is RE), every other country is itself.
 * Shopify and Stripe send either form, so every classification reads through this.
 */
export function vatTerritoryOf(
  country: string | null | undefined,
  postcode?: string | null | undefined,
): string {
  const c = (country ?? "").trim().toUpperCase()
  if (c === "FR") return postcodeTerritory(postcode) ?? "FR"
  return c
}

export function territoryKind(code: string | null | undefined): VatTerritoryKind {
  const c = (code ?? "").trim().toUpperCase()
  if (c === "FR" || c === "MC") return "fr_metro"
  if (DOM_VAT.has(c)) return "dom_vat"
  if (DOM_NO_VAT.has(c)) return "dom_no_vat"
  if (COM.has(c)) return "com"
  return "other"
}

/** True for a French overseas territory (any department or collectivity). */
export function isFrenchOverseas(code: string | null | undefined): boolean {
  const k = territoryKind(code)
  return k === "dom_vat" || k === "dom_no_vat" || k === "com"
}

/**
 * The French VAT "zone" goods move within without being exported: metropolitan France, the
 * Antilles single market (Guadeloupe + Martinique), La Réunion. Null outside French VAT.
 */
export function frVatZone(code: string | null | undefined): "FR" | "ANTILLES" | "RE" | null {
  const c = (code ?? "").trim().toUpperCase()
  if (territoryKind(c) === "fr_metro") return "FR"
  if (c === "GP" || c === "MQ") return "ANTILLES"
  if (c === "RE") return "RE"
  return null
}

/** The standard rate of a French VAT territory, or null outside French VAT. */
export function frTerritoryRateBp(code: string | null | undefined): number | null {
  const c = (code ?? "").trim().toUpperCase()
  if (territoryKind(c) === "fr_metro") return FR_TERRITORY_STANDARD_RATE_BP.FR ?? 2000
  return FR_TERRITORY_STANDARD_RATE_BP[c] ?? null
}
