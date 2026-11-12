// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { resolveRecipient, sameLocation, streetKey, type VerifiedAddress } from "./address-check"

const at = (street: string, postalCode = "53424", countryIsoCode = "DE") => ({
  street,
  postalCode,
  countryIsoCode,
  city: "Remagen",
})

describe("sameLocation", () => {
  it("folds case, accents, punctuation, spacing and common abbreviations", () => {
    expect(sameLocation(at("Werkstr. 6"), at("WERKSTRASSE 6"))).toBe(true)
    expect(sameLocation(at("Werk Straße 6"), at("Werkstrasse 6"))).toBe(true)
    expect(sameLocation(at("6 Werkstrasse"), at("Werkstr. 6"))).toBe(true)
    expect(
      sameLocation(
        at("12 av. Jean-Jaurès", "75019", "FR"),
        at("12 Avenue Jean Jaures", "75019", "FR"),
      ),
    ).toBe(true)
    expect(
      sameLocation(
        at("Keizersgracht 101", "1015 CJ", "NL"),
        at("keizersgracht 101", "1015cj", "NL"),
      ),
    ).toBe(true)
    expect(sameLocation(at("Gartenweg 3a"), at("Gartenweg 3 A"))).toBe(true)
  })

  it("requires the same house number", () => {
    expect(sameLocation(at("Werkstr. 6"), at("Werkstr. 8"))).toBe(false)
    expect(sameLocation(at("Werkstr. 6"), at("Werkstr. 6a"))).toBe(false)
    expect(sameLocation(at("Werkstr."), at("Werkstr."))).toBe(false)
  })

  it("counts anything it cannot decide as a difference", () => {
    expect(sameLocation(at("Werkstr. 6"), { ...at("Werkstr. 6"), postalCode: null })).toBe(false)
    expect(sameLocation(at("Werkstr. 6"), { ...at("Werkstr. 6"), countryIsoCode: null })).toBe(
      false,
    )
    expect(sameLocation(at("Werkstr. 6"), at("Werkstr. 6", "53425"))).toBe(false)
    expect(sameLocation(at("Werkstr. 6"), at("Werkstr. 6", "53424", "AT"))).toBe(false)
    expect(sameLocation(at("Werkstr. 6"), at("Fliederstr. 6"))).toBe(false)
    expect(sameLocation(null, at("Werkstr. 6"))).toBe(false)
  })

  it("compares the city: two communes share a postal code and a street name", () => {
    const grandeRue = (city: string) => ({
      street: "3 Grande Rue",
      postalCode: "39130",
      countryIsoCode: "FR",
      city,
    })
    expect(sameLocation(grandeRue("Clairvaux-les-Lacs"), grandeRue("Doucier"))).toBe(false)
    expect(sameLocation(grandeRue("Clairvaux-les-Lacs"), grandeRue("CLAIRVAUX LES LACS"))).toBe(
      true,
    )
    expect(sameLocation(grandeRue("Doucier"), { ...grandeRue("Doucier"), city: null })).toBe(false)
    const se = (city: string) => ({
      street: "4 rue Gambetta",
      postalCode: "42000",
      countryIsoCode: "FR",
      city,
    })
    expect(sameLocation(se("St-Étienne"), se("Saint Etienne"))).toBe(true)
    expect(sameLocation(se("Saint-Etienne"), se("SAINT ETIENNE CEDEX 1"))).toBe(true)
  })

  it("reads St / Ste as a saint before a name, and as a street or a suite by position", () => {
    const fr = (street: string) => ({
      street,
      postalCode: "75007",
      countryIsoCode: "FR",
      city: "Paris",
    })
    // Before, "St" always became "street": rue St-Michel and rue Saint-Michel were held as different.
    expect(sameLocation(fr("12 rue St-Michel"), fr("12 rue Saint Michel"))).toBe(true)
    expect(sameLocation(fr("3 rue Ste Catherine"), fr("3 rue Sainte-Catherine"))).toBe(true)
    const us = (street: string) => ({
      street,
      postalCode: "10019",
      countryIsoCode: "US",
      city: "New York",
    })
    expect(sameLocation(us("12 Main St"), us("12 Main Street"))).toBe(true)
    expect(sameLocation(us("12 St Paul St"), us("12 Saint Paul Street"))).toBe(true)
    expect(sameLocation(us("100 Main St Ste 200"), us("100 Main Street Suite 200"))).toBe(true)
    // No false match: a saint is never a street, and a missing word still differs.
    expect(sameLocation(us("12 Saint Paul St"), us("12 Saint Paul"))).toBe(false)
    expect(sameLocation(fr("12 rue St Michel"), fr("12 rue Michel"))).toBe(false)
    expect(streetKey("12 rue St-Michel").words).toBe("ruesaintmichel")
    expect(streetKey("12 Main St").words).toBe("mainstreet")
  })

  it("keys a street by its numbers and its words", () => {
    expect(streetKey("Lilienthalstr. 7")).toEqual({ numbers: ["7"], words: "lilienthalstrasse" })
  })
})

describe("resolveRecipient", () => {
  const order = { ...at("Werkstr. 6"), name: "Receiving", phone: null }
  const copy = { ...at("Fliederstrasse 7"), name: "Head office", phone: "+491" }
  const verified = (street: string, phone = "+492"): VerifiedAddress => ({
    id: "a1",
    address: { ...at(street), phone },
    verified_at: "2026-10-20T00:00:00.000Z",
    verified_by_name: "Sam",
    verification_source: "purchase_order",
  })
  const none = {
    prep: null,
    order: null,
    verified: [],
    contact: null,
    customerDefault: null,
    invoice: null,
  }

  it("an operator's choice wins over everything (the T5 hook)", () => {
    const r = resolveRecipient({
      ...none,
      order,
      contact: copy,
      verified: [verified("Industriepark 3")],
      choice: { address: verified("Industriepark 3").address, address_id: "a1" },
    })
    expect(r.address?.street).toBe("Industriepark 3")
    expect(r.check.used).toMatchObject({ source: "operator_choice", address_id: "a1" })
    expect(r.check.state).toBe("differs")
  })

  it("no source at all gives no address", () => {
    expect(resolveRecipient(none)).toEqual({
      address: null,
      check: { state: "no_verified", used: null, order_address: null, verified_address: null },
    })
  })

  it("an order that could not be read keeps a verified address from standing in for it", () => {
    const r = resolveRecipient({
      ...none,
      orderUnknown: true,
      contact: copy,
      verified: [verified("Werkstr. 6")],
    })
    expect(r.check.state).toBe("differs")
    expect(r.check.used?.source).toBe("contact")
  })

  it("never takes a phone from another place", () => {
    const r = resolveRecipient({ ...none, order, contact: copy })
    expect(r.address).toMatchObject({ street: "Werkstr. 6", phone: null, name: "Receiving" })
  })

  it("fills a state from a source in the same postal area only", () => {
    const us = {
      street: "1200 Market St",
      city: "Philadelphia",
      postalCode: "19107",
      countryIsoCode: "US",
    }
    const r = resolveRecipient({
      ...none,
      contact: us,
      invoice: { ...us, street: "PO Box 9", state: "PA" },
    })
    expect(r.address?.state).toBe("PA")
    const r2 = resolveRecipient({
      ...none,
      contact: us,
      invoice: { ...us, postalCode: "10001", state: "NY" },
    })
    expect(r2.address?.state).toBeNull()
  })
})
