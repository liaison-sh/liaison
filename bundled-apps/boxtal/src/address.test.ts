// SPDX-License-Identifier: FSL-1.1-ALv2
//
// State/province handling on Boxtal addresses. Pinned by the prod incident of
// 2026-07-20: a US FedEx label POSTed without location.state came back as an
// opaque Boxtal 400 BAD_REQUEST after approval. validateParty now fails
// precisely at stage time, and assembleAddress emits the state.
import { describe, expect, it } from "bun:test"
import { assembleAddress, boxtalText, normalizeRegion, postalCodeRequired, validateParty, validateRecipientPhone } from "./address"

const base = {
  name: "Stanley Fortson",
  email: "s@example.com",
  phone: "+16155730921",
  street: "116 Chickasaw Dr.",
  city: "Crossville",
  postalCode: "38572",
  countryIsoCode: "US",
}

describe("validateParty — state requirement", () => {
  it("US/CA without a state is incomplete; with one it validates", () => {
    expect(validateParty(base)).toEqual(["state"])
    expect(validateParty({ ...base, state: "TN" })).toEqual([])
    expect(validateParty({ ...base, countryIsoCode: "CA", state: null })).toEqual(["state"])
  })

  it("non-US/CA countries never require a state", () => {
    expect(validateParty({ ...base, countryIsoCode: "FR", postalCode: "75018" })).toEqual([])
  })
})

describe("assembleAddress — state emission", () => {
  it("includes location.state when set, omits it when absent", () => {
    expect(assembleAddress({ ...base, state: "TN" }).location.state).toBe("TN")
    expect("state" in assembleAddress({ ...base, countryIsoCode: "FR" }).location).toBe(false)
  })
})

describe("normalizeRegion", () => {
  it("maps full US state and CA province names to codes, passes codes through", () => {
    expect(normalizeRegion("US", "Pennsylvania")).toBe("PA")
    expect(normalizeRegion("US", "tn")).toBe("TN")
    expect(normalizeRegion("CA", "Alberta")).toBe("AB")
    expect(normalizeRegion("CA", "Québec")).toBe("QC")
    expect(normalizeRegion("US", "Not A State")).toBeNull()
  })

  it("passes non-US/CA regions through untouched and blanks to null", () => {
    expect(normalizeRegion("FR", "Île-de-France")).toBe("Île-de-France")
    expect(normalizeRegion("US", "  ")).toBeNull()
  })
})

describe("validateRecipientPhone — North American rule for US/CA", () => {
  it("accepts valid NANP numbers in common formats", () => {
    expect(validateRecipientPhone("US", "+1 212 555 0100")).toBeNull()
    expect(validateRecipientPhone("US", "(212) 555-0100")).toBeNull()
    expect(validateRecipientPhone("US", "2125550100")).toBeNull()
    expect(validateRecipientPhone("CA", "1-416-555-0199")).toBeNull()
    expect(validateRecipientPhone("ca", "+14165550199")).toBeNull()
  })

  it("rejects non-North-American numbers on a US/CA route with a readable message", () => {
    // The exact field failure Boxtal/FedEx 422s on: a French mobile on a US label.
    const err = validateRecipientPhone("US", "0612345678")
    expect(err).toMatch(/North American/)
    expect(validateRecipientPhone("US", "+33 6 12 34 56 78")).toMatch(/North American/)
    expect(validateRecipientPhone("CA", "+44 20 7946 0958")).toMatch(/North American/)
    // 10 digits but invalid NANP: area code cannot start with 0/1.
    expect(validateRecipientPhone("US", "1234567890")).toMatch(/North American/)
  })

  it("applies no rule outside US/CA, and leaves missing phones to the required-fields check", () => {
    expect(validateRecipientPhone("FR", "0612345678")).toBeNull()
    expect(validateRecipientPhone("DE", "+49 151 12345678")).toBeNull()
    expect(validateRecipientPhone("US", "")).toBeNull()
    expect(validateRecipientPhone("US", null)).toBeNull()
  })
})

// Field reports, 2026-11: labels to the United Arab Emirates (a country with no postal codes) were
// refused before reaching Boxtal for a "missing postal code", and names or streets carrying
// characters outside Boxtal's set (accents, typographic quotes, non-Latin letters) were refused by
// the carrier.
describe("countries without postal codes", () => {
  const ae = { ...base, countryIsoCode: "AE", city: "Dubai", postalCode: null, state: null, phone: "+971500000000" }
  it("a UAE recipient without a postal code is complete", () => {
    expect(postalCodeRequired("AE")).toBe(false)
    expect(validateParty(ae)).toEqual([])
  })
  it("a country with postal codes still requires one", () => {
    expect(postalCodeRequired("FR")).toBe(true)
    expect(validateParty({ ...ae, countryIsoCode: "FR" })).toEqual(["postalCode"])
  })
  it("the address sent for a UAE recipient carries an empty postal code, never a guessed one", () => {
    expect(assembleAddress({ ...ae, postalCode: "1234" }).location.postalCode).toBe("")
  })
})

describe("Boxtal-safe text", () => {
  it("transliterates accents and the letters NFD cannot split, keeps ASCII punctuation", () => {
    expect(boxtalText("Zoë Ñúñez-O’Brien")).toBe("Zoe Nunez-O'Brien")
    expect(boxtalText("12 Straße – Hof «B»")).toBe("12 Strasse - Hof B")
    expect(boxtalText("Łódź, Kraków; Ørsted Æble")).toBe("Lodz, Krakow; Orsted AEble")
  })
  it("strips what has no Latin form and collapses the spaces left behind", () => {
    expect(boxtalText("Test  \u0645\u062d\u0645\u062f  Road\u200b\t")).toBe("Test Road")
  })
  it("the create address is sent in Boxtal's character set", () => {
    const a = assembleAddress({ ...base, state: "TN", name: "Zoë O’Brien", street: "1 Rue de l’Église", city: "Montréal" })
    expect(a.contact.firstName).toBe("Zoe")
    expect(a.contact.lastName).toBe("O'Brien")
    expect(a.location.street).toBe("1 Rue de l'Eglise")
    expect(a.location.city).toBe("Montreal")
  })
  it("a name with no Latin letters at all is reported missing, never sent blank", () => {
    expect(validateParty({ ...base, state: "TN", name: "\u0645\u062d\u0645\u062f" })).toEqual(["name"])
  })
})
