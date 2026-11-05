// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Carrier allowlist — an advisory org GUIDELINE over WHICH shipping companies are
// surfaced in ROUTINE quoting. Held in app_config under `carrier_allowlist` (a list
// of brand keys, see settings.ts). When the list is EMPTY/unset the org has no
// restriction and every carrier is quoted (back-compat); when it is set, ONLY
// offers whose carrier maps to an allowed brand survive the quote chokepoint
// (shipment.ts quote(), the single call site of client.v1.quote). It is NOT a
// buy-time gate: create_shipment's pre-buy re-quotes pass ignore_allowlist, so a
// gated (human-approved) buy of an explicitly-picked non-allowlisted carrier is
// never refused on allowlist grounds — the guideline steers the default, the human
// makes the exception.
//
// A "brand" is a shipping company (UPS, FedEx, DHL, ...). Boxtal returns each
// offer with a machine `carrier_code` (the <operator><code>, e.g. FEDX) and a
// human `carrier` label (e.g. "FedEx"). ONE brand can span SEVERAL Boxtal
// service variants (FedEx: RegionalEconomy, InternationalPriority, Priority
// Express, ...) — they ALL share the one operator code, so allowing the brand
// keeps every variant without enumerating services. The label is matched too,
// as a defensive fallback, so a variant under an operator code we do not yet
// enumerate (e.g. a secondary DHL network) is still classified by its label.

import type { Offer } from "./lib/boxtal-v1-client"

export interface CarrierBrand {
  /** Stable allowlist key (lowercase, no spaces). */
  key: string
  /** Human label for the settings UI. */
  label: string
  /** Boxtal operator codes (<operator><code>) confirmed for this brand. */
  codes: string[]
  /** Fallback: match the human carrier label (case-insensitive). Catches
   *  service variants under an operator code not listed above. */
  labelPattern: RegExp
}

// The brands this org's Boxtal account surfaces. `codes` are the operator codes
// actually observed in live cotations; anything else for the same company is
// caught by `labelPattern`, so the allowlist stays correct even if a carrier
// adds a network we have not enumerated.
export const CARRIER_BRANDS: readonly CarrierBrand[] = [
  { key: "ups", label: "UPS", codes: ["UPSE"], labelPattern: /\bups\b/i },
  { key: "fedex", label: "FedEx", codes: ["FEDX"], labelPattern: /\bfedex\b/i },
  { key: "dhl", label: "DHL", codes: ["DHLE"], labelPattern: /\bdhl\b/i },
  { key: "chronopost", label: "Chronopost", codes: ["CHRP"], labelPattern: /\bchrono/i },
  { key: "laposte", label: "La Poste / Colissimo", codes: ["POFR", "SOGP"], labelPattern: /(colissimo|la poste)/i },
  { key: "mondialrelay", label: "Mondial Relay", codes: ["MONR"], labelPattern: /\bmondial\b/i },
  { key: "colisprive", label: "Colis Prive", codes: ["COPR"], labelPattern: /colis priv/i },
  { key: "tnt", label: "TNT", codes: ["TNTE"], labelPattern: /\btnt\b/i },
  { key: "sodexi", label: "Sodexi", codes: ["SODX"], labelPattern: /\bsodexi\b/i },
  { key: "happypost", label: "Happy Post", codes: ["IMXE"], labelPattern: /happy ?post/i },
]

const CODE_TO_BRAND = new Map<string, string>()
for (const b of CARRIER_BRANDS) for (const c of b.codes) CODE_TO_BRAND.set(c.toUpperCase(), b.key)

export function isKnownCarrierBrand(key: string): boolean {
  return CARRIER_BRANDS.some((b) => b.key === key)
}

/** Resolve a human-entered value (brand key, label, or brand name) to a canonical
 *  brand key — so `set(["UPS","DHL","FedEx"])` works as well as `["ups","dhl","fedex"]`.
 *  Null when nothing matches. */
export function resolveCarrierBrand(input: string): string | null {
  const s = input.trim().toLowerCase()
  if (!s) return null
  for (const b of CARRIER_BRANDS) {
    if (b.key === s) return b.key
    if (b.label.toLowerCase() === s) return b.key
    if (b.labelPattern.test(input)) return b.key
  }
  return null
}

/** The brand an offer belongs to — by operator code first, then by label. Null
 *  when the offer cannot be classified into any known brand. */
export function carrierBrandOf(offer: Pick<Offer, "carrier" | "carrier_code">): string | null {
  const byCode = offer.carrier_code ? CODE_TO_BRAND.get(offer.carrier_code.toUpperCase()) : undefined
  if (byCode) return byCode
  const label = offer.carrier ?? ""
  for (const b of CARRIER_BRANDS) if (b.labelPattern.test(label)) return b.key
  return null
}

/**
 * Keep only offers whose carrier maps to an ALLOWED brand. An empty/blank
 * allowlist means "no restriction" → every offer passes (back-compat). With a
 * non-empty allowlist, an offer whose brand cannot be classified is DROPPED — an
 * allowlist is a closed set: only explicitly-allowed carriers ship.
 */
export function filterOffersByAllowlist<T extends Pick<Offer, "carrier" | "carrier_code">>(
  offers: T[],
  allow: readonly string[] | null | undefined,
): T[] {
  const allowed = new Set((allow ?? []).map((s) => s.toLowerCase()))
  if (allowed.size === 0) return offers
  return offers.filter((o) => {
    const brand = carrierBrandOf(o)
    return brand != null && allowed.has(brand)
  })
}

// — pickup-point / relay-service policy (a SEPARATE axis from the carrier brand) —
//
// A B2C door-to-door order should not be quoted (or shipped) on a service that
// delivers to a relay / pickup point (UPS Access Point, a point relais, a
// drop-off/pickup-point network), because the customer expects delivery to their
// home, not a manual collection at a third-party point. The single authoritative
// Boxtal signal is `needs_relay_point` (the offer's delivery `<type><code>` is
// PICKUP_POINT). Some access-point service variants are NOT flagged there (Boxtal
// returns a generic DELIVERY type but names the service "... Access Point" /
// "Point Relais"), so when the delivery metadata is silent the service naming is
// the only reliable tell. Both signals live in this ONE documented function — NOT
// a hardcoded per-carrier offer-code list, which would rot the moment a carrier
// renamed a service or added a network.

/**
 * Service-metadata fallback pattern: names a relay / pickup-point / drop-off-point
 * delivery service when Boxtal did not set `needs_relay_point`. Matched against the
 * offer's service label + service code + offer code (NOT the carrier name — the
 * carrier "Mondial Relay" also runs a home-delivery service that must NOT be caught
 * here). Kept deliberately narrow to avoid catching an ordinary home service.
 */
export const PICKUP_POINT_SERVICE_PATTERN =
  /access[\s._-]?point|\brelais\b|point[\s._-]?relais|\brelay[\s._-]?point\b|pickup[\s._-]?point|drop[\s._-]?off[\s._-]?point|point[\s._-]?retrait/i

/**
 * Whether an offer delivers to a RELAY / PICKUP POINT rather than the recipient's
 * address. True when Boxtal flags `needs_relay_point`, OR — as a documented fallback
 * for services Boxtal leaves unflagged — when the service label/code names an
 * access-point / point-relais / pickup-point / drop-off delivery. This is the single
 * detection chokepoint (see PICKUP_POINT_SERVICE_PATTERN); every filter/badge reads it.
 */
export function isPickupPointOffer(
  offer: Pick<Offer, "needs_relay_point" | "service" | "service_code" | "offer_code">,
): boolean {
  if (offer.needs_relay_point) return true
  const hay = `${offer.service ?? ""} ${offer.service_code ?? ""} ${offer.offer_code ?? ""}`
  return PICKUP_POINT_SERVICE_PATTERN.test(hay)
}

/**
 * Drop relay / pickup-point offers when `exclude` is true (the org policy is ON).
 * `exclude:false` is pass-through — every offer survives, including relay ones (the
 * caller either turned the policy off or explicitly asked to include pickup points).
 * A door-to-door quote thus never surfaces a relay offer as its cheapest when the
 * policy is on.
 */
export function filterOffersByPickupPoint<
  T extends Pick<Offer, "needs_relay_point" | "service" | "service_code" | "offer_code">,
>(offers: T[], exclude: boolean): T[] {
  if (!exclude) return offers
  return offers.filter((o) => !isPickupPointOffer(o))
}
