// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  CARRIER_BRANDS,
  carrierBrandOf,
  filterOffersByAllowlist,
  filterOffersByPickupPoint,
  isKnownCarrierBrand,
  isPickupPointOffer,
  resolveCarrierBrand,
} from "./carriers"

// A minimal offer factory — only the two fields the classifier reads.
const offer = (carrier: string, carrier_code: string) => ({ carrier, carrier_code })

// The real offer shapes seen in a live DE cotation (see the quote result in the
// task): several FedEx/DHL SERVICE variants, all under one operator code each.
const FEDEX_VARIANTS = [
  offer("FedEx", "FEDX"), // Regional Economy
  offer("FedEx", "FEDX"), // International Priority
  offer("FedEx", "FEDX"), // International Priority Express
  offer("FedEx", "FEDX"), // International Connect Plus
]
const UPS_VARIANTS = [
  offer("UPS", "UPSE"), // Economy Access Point
  offer("UPS", "UPSE"), // Standard AP
]
const DHL_VARIANTS = [
  offer("DHL Express", "DHLE"), // Economy Select
  offer("DHL Express", "DHLE"), // Express Worldwide
]
const OTHERS = [
  offer("Chronopost", "CHRP"),
  offer("La Poste", "POFR"),
  offer("Mondial Relay", "MONR"),
  offer("Colis Privé", "COPR"),
  offer("TNT Express", "TNTE"),
]

describe("carrierBrandOf", () => {
  it("classifies every FedEx/UPS/DHL service variant to its brand by operator code", () => {
    for (const o of FEDEX_VARIANTS) expect(carrierBrandOf(o)).toBe("fedex")
    for (const o of UPS_VARIANTS) expect(carrierBrandOf(o)).toBe("ups")
    for (const o of DHL_VARIANTS) expect(carrierBrandOf(o)).toBe("dhl")
  })

  it("classifies Chronopost and the other domestic carriers distinctly", () => {
    expect(carrierBrandOf(offer("Chronopost", "CHRP"))).toBe("chronopost")
    expect(carrierBrandOf(offer("La Poste", "POFR"))).toBe("laposte")
    expect(carrierBrandOf(offer("La Poste", "SOGP"))).toBe("laposte") // Colissimo SOGP-* code
    expect(carrierBrandOf(offer("TNT Express", "TNTE"))).toBe("tnt") // NOT fedex, despite ownership
  })

  it("falls back to the human label when the operator code is unknown", () => {
    // A DHL network under a code we do not enumerate is still caught by label.
    expect(carrierBrandOf(offer("DHL Parcel", "DHLX"))).toBe("dhl")
    expect(carrierBrandOf(offer("UPS Access Point", "UPSX"))).toBe("ups")
  })

  it("returns null for a genuinely unclassifiable carrier", () => {
    expect(carrierBrandOf(offer("Acme Freight", "ACME"))).toBeNull()
  })
})

describe("filterOffersByAllowlist", () => {
  const ALL = [...FEDEX_VARIANTS, ...UPS_VARIANTS, ...DHL_VARIANTS, ...OTHERS]

  it("passes every offer through when the allowlist is empty (no restriction)", () => {
    expect(filterOffersByAllowlist(ALL, [])).toHaveLength(ALL.length)
    expect(filterOffersByAllowlist(ALL, null)).toHaveLength(ALL.length)
    expect(filterOffersByAllowlist(ALL, undefined)).toHaveLength(ALL.length)
  })

  it("keeps ALL variants of the allowed express trio and drops everyone else", () => {
    const kept = filterOffersByAllowlist(ALL, ["ups", "fedex", "dhl"])
    expect(kept).toHaveLength(FEDEX_VARIANTS.length + UPS_VARIANTS.length + DHL_VARIANTS.length)
    const brands = new Set(kept.map((o) => carrierBrandOf(o)))
    expect(brands).toEqual(new Set(["ups", "fedex", "dhl"]))
    // Chronopost specifically is gone.
    expect(kept.some((o) => o.carrier_code === "CHRP")).toBe(false)
  })

  it("is case-insensitive on the allowlist keys", () => {
    expect(filterOffersByAllowlist(ALL, ["UPS", "FedEx", "DHL"])).toHaveLength(
      FEDEX_VARIANTS.length + UPS_VARIANTS.length + DHL_VARIANTS.length,
    )
  })

  it("drops an unclassifiable carrier when an allowlist is active (closed set)", () => {
    const withUnknown = [...FEDEX_VARIANTS, offer("Acme Freight", "ACME")]
    const kept = filterOffersByAllowlist(withUnknown, ["fedex", "ups", "dhl"])
    expect(kept).toHaveLength(FEDEX_VARIANTS.length)
  })
})

describe("isPickupPointOffer", () => {
  // A fuller offer factory carrying the fields the pickup detector reads.
  const pp = (
    o: Partial<{
      needs_relay_point: boolean
      service: string
      service_code: string
      offer_code: string
    }>,
  ) => ({
    needs_relay_point: o.needs_relay_point ?? false,
    service: o.service ?? "",
    service_code: o.service_code ?? "",
    offer_code: o.offer_code ?? "",
  })

  it("flags an offer Boxtal marks needs_relay_point (the authoritative delivery-type signal)", () => {
    expect(
      isPickupPointOffer(pp({ needs_relay_point: true, service: "Mondial Relay Domicile" })),
    ).toBe(true)
  })

  it("flags an UPS Access Point service by its NAME when Boxtal leaves needs_relay_point false", () => {
    // Live shape: UPSE-EconomyAccessPoint / UPSE-StandardAP come back with a generic
    // delivery type but an access-point service label — the naming is the only tell.
    expect(
      isPickupPointOffer(
        pp({ service: "UPS Standard Access Point", offer_code: "UPSE-StandardAP" }),
      ),
    ).toBe(true)
    expect(
      isPickupPointOffer(
        pp({ service: "UPS Economy Access Point", offer_code: "UPSE-EconomyAccessPoint" }),
      ),
    ).toBe(true)
  })

  it("flags a point-relais / pickup-point / drop-off service by name", () => {
    expect(isPickupPointOffer(pp({ service: "Point Relais", offer_code: "MRLY-Point" }))).toBe(true)
    expect(
      isPickupPointOffer(pp({ service: "Chrono Relais Europe", offer_code: "CHRP-Relais" })),
    ).toBe(true)
    expect(isPickupPointOffer(pp({ service: "Colissimo Point Retrait" }))).toBe(true)
    expect(isPickupPointOffer(pp({ service: "DropOff Point delivery" }))).toBe(true)
  })

  it("does NOT flag an ordinary home / door-to-door service (even from a relay-oriented carrier)", () => {
    // The carrier name is Mondial Relay, but the SERVICE is home delivery — must survive.
    expect(
      isPickupPointOffer(pp({ service: "Mondial Relay Domicile", offer_code: "MONR-Home" })),
    ).toBe(false)
    expect(isPickupPointOffer(pp({ service: "Chrono 18", offer_code: "CHRP-Chrono18" }))).toBe(
      false,
    )
    expect(
      isPickupPointOffer(pp({ service: "FedEx International Priority", offer_code: "FEDX-IP" })),
    ).toBe(false)
    expect(
      isPickupPointOffer(pp({ service: "UPS Express Saver", offer_code: "UPSE-ExpressSaver" })),
    ).toBe(false)
  })
})

describe("filterOffersByPickupPoint", () => {
  const homeOffer = {
    needs_relay_point: false,
    service: "FedEx International Priority",
    service_code: "IP",
    offer_code: "FEDX-IP",
  }
  const relayFlagged = {
    needs_relay_point: true,
    service: "Mondial Relay",
    service_code: "Point",
    offer_code: "MONR-Point",
  }
  const relayNamed = {
    needs_relay_point: false,
    service: "UPS Standard Access Point",
    service_code: "StandardAP",
    offer_code: "UPSE-StandardAP",
  }
  const OFFERS = [homeOffer, relayFlagged, relayNamed]

  it("passes every offer through when exclude is false (policy off)", () => {
    expect(filterOffersByPickupPoint(OFFERS, false)).toHaveLength(3)
  })

  it("drops BOTH the metadata-flagged and the name-matched relay offers when exclude is true", () => {
    const kept = filterOffersByPickupPoint(OFFERS, true)
    expect(kept).toEqual([homeOffer])
  })
})

describe("resolveCarrierBrand / isKnownCarrierBrand", () => {
  it("resolves keys, labels, and brand names to the canonical key", () => {
    expect(resolveCarrierBrand("dhl")).toBe("dhl")
    expect(resolveCarrierBrand("DHL")).toBe("dhl")
    expect(resolveCarrierBrand("FedEx")).toBe("fedex")
    expect(resolveCarrierBrand("UPS")).toBe("ups")
    expect(resolveCarrierBrand("  ups  ")).toBe("ups")
  })

  it("returns null for an unknown carrier", () => {
    expect(resolveCarrierBrand("acme")).toBeNull()
    expect(resolveCarrierBrand("")).toBeNull()
  })

  it("isKnownCarrierBrand agrees with the catalogue keys", () => {
    for (const b of CARRIER_BRANDS) expect(isKnownCarrierBrand(b.key)).toBe(true)
    expect(isKnownCarrierBrand("acme")).toBe(false)
  })
})
