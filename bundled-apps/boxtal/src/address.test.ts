// SPDX-License-Identifier: FSL-1.1-ALv2
//
// State/province handling on Boxtal addresses. Pinned by the prod incident of
// 2026-07-20: a US FedEx label POSTed without location.state came back as an
// opaque Boxtal 400 BAD_REQUEST after approval. validateParty now fails
// precisely at stage time, and assembleAddress emits the state.
import { describe, expect, it } from "bun:test"
import { assembleAddress, normalizeRegion, validateParty, validateRecipientPhone } from "./address"

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
