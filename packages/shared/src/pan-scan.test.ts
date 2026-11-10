// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  hasVendorKey,
  luhnValid,
  maskCardNumbers,
  maskHtmlWithNote,
  maskPaymentSecrets,
  maskVendorKeys,
  maskWithNote,
} from "./pan-scan"

// Every card number below is Luhn-valid and starts with a real network prefix
// (the processors' published test numbers and a few computed ones).
const CARDS: Array<[string, string]> = [
  ["Visa, spaced", "Ma carte 4242 4242 4242 4242 merci"],
  ["Visa, dashed", "card: 4111-1111-1111-1111."],
  ["Visa debit, one run", "4000056655665556"],
  ["Visa, computed", "le numéro 4917484589897107 expire 12/27"],
  ["Mastercard 5-series", "MC 5555555555554444"],
  ["Mastercard 5-series, computed", "5123 4567 8901 2346"],
  ["Mastercard 2-series", "2223 0031 2200 3222"],
  ["American Express, 15 digits", "Amex 3782 822463 10005"],
  ["Discover", "6011 1111 1111 1117"],
  ["JCB", "JCB 3530111333300000"],
  ["Diners Club, 14 digits", "Diners 3056 9309 0259 04"],
  ["Diners Club 36, 14 digits", "36148900647913"],
  ["after an order number in one run of digits", "Order 1234 4242 4242 4242 4242 paid"],
  ["two spaces between groups", "4242  4242  4242  4242"],
]

const NOT_CARDS: Array<[string, string]> = [
  ["16 digit order number failing Luhn", "Commande 4242424242424241"],
  ["16 digit order number failing Luhn, grouped", "Order 4242 4242 4242 4241"],
  ["Luhn-valid serial with no card prefix", "Serial 1234567812345670"],
  ["Luhn-valid serial starting 1", "SN 1000000000000008"],
  ["Luhn-valid order number starting 20", "#2024000012345672"],
  ["SIRET, Luhn-valid, no card prefix", "SIRET 732 829 320 00074"],
  ["IBAN fragment, French", "IBAN FR76 3000 6000 0112 3456 7890 189"],
  ["IBAN fragment, German", "DE89 3704 0044 0532 0130 00"],
  ["IBAN whose digits hold a card-shaped stretch", "IBAN FR55 4242 4242 4242 4242 4242 123"],
  ["UPS tracking number", "Suivi 1Z999AA10123456784"],
  ["USPS tracking number", "Tracking 9400 1000 0000 0000 0000 00"],
  ["card-shaped number glued to letters", "ref ORD4242424242424242"],
  ["20 digits with no separator", "id 42424242424242424242"],
  ["ISO date", "Livraison le 2026-11-10"],
  ["French date and time", "le 10/11/2026 à 14:30"],
]

describe("maskCardNumbers", () => {
  it("a table of 30 values masks only Luhn-valid card numbers with a card prefix", () => {
    const phones: Array<[string, string]> = [
      ["French phone numbers", "+33 6 12 34 56 78 ou 01 23 45 67 89"],
    ]
    const rows = [
      ...CARDS.map((r) => [...r, true] as const),
      ...[...NOT_CARDS, ...phones].map((r) => [...r, false] as const),
    ]
    expect(rows.length).toBe(30)
    for (const [label, input, isCard] of rows) {
      const out = maskCardNumbers(input)
      if (isCard) {
        const digits = (input.match(/\d[\d -]*\d/g) ?? []).map((d) => d.replace(/\D/g, ""))
        const card = digits.find((d) => d.length >= 13) ?? ""
        const pan = card.length > 19 ? card.slice(-16) : card
        expect({ label, masked: out.masked }).toEqual({ label, masked: 1 })
        expect(out.text).toContain(`•••• •••• •••• ${pan.slice(-4)}`)
        expect(out.text.replace(/\D/g, "")).not.toContain(pan)
      } else {
        expect({ label, text: out.text, masked: out.masked }).toEqual({
          label,
          text: input,
          masked: 0,
        })
      }
    }
  })

  it("a CVC within 40 characters of a masked number is masked", () => {
    const near = maskCardNumbers("4242 4242 4242 4242 exp 12/27 CVC 737")
    expect(near.text).toBe("•••• •••• •••• 4242 exp 12/27 CVC •••")
    const french = maskCardNumbers("cryptogramme : 123, carte 5555555555554444")
    expect(french.text).toBe("cryptogramme : •••, carte •••• •••• •••• 4444")
    const label = maskCardNumbers("4111111111111111 security code is 9876")
    expect(label.text).toBe("•••• •••• •••• 1111 security code is •••")
    // Far from any card, or with no card at all, a 3 digit value stays.
    expect(maskCardNumbers("CVV 123").text).toBe("CVV 123")
    const far = `4242424242424242 ${"x".repeat(60)} CVV 123`
    expect(maskCardNumbers(far).text.endsWith("CVV 123")).toBe(true)
  })

  it("a card number split by markup is masked in HTML, with a note", () => {
    const html = "<p>Card <b>4242</b>&nbsp;4242 4242 <span>4242</span></p>"
    const out = maskHtmlWithNote(html)
    expect(out.cards).toBe(1)
    expect(out.text.replace(/<[^>]*>|&nbsp;|\D/g, "")).not.toContain("4242424242424242")
    expect(out.text).toContain("•••• •••• •••• 4242")
    expect(out.text).toContain("<p>[A card number was hidden.]</p>")
  })

  it("luhnValid accepts a valid number and refuses one digit off", () => {
    expect(luhnValid("4242424242424242")).toBe(true)
    expect(luhnValid("4242424242424241")).toBe(false)
    expect(luhnValid("42a2")).toBe(false)
  })
})

describe("maskVendorKeys", () => {
  const live = `sk_live_${"51HxQzA9bC3dE4fG5hI6jK7lM8"}`
  const test = `sk_test_${"4eC39HqLyjWDarjtT1zdp7dc"}`
  const restricted = `rk_live_${"51HxQzA9bC3dE4fG5hI6jK7lM8nO9pQ"}`
  const restrictedTest = `rk_test_${"51HxQzA9bC3dE4fG5hI6jK"}`
  const signing = `whsec_${"Kx8pYQ2mZ7cV3nB6vR1tW9aS4dF0gH5j"}`

  it("restricted keys, secret keys and signing secrets keep their prefix only", () => {
    for (const key of [live, test, restricted, restrictedTest, signing]) {
      const out = maskVendorKeys(`here it is: ${key} thanks`)
      expect(out.masked).toBe(1)
      expect(out.text).not.toContain(key)
      expect(out.text).toMatch(/^here it is: (?:rk|sk)?(?:_live_|_test_)?(?:whsec_)?•{8} thanks$/)
      expect(hasVendorKey(key)).toBe(true)
    }
  })

  it("a short or prefix-only value is not a key", () => {
    for (const text of [
      "sk_live_abc",
      "pk_live_51HxQzA9bC3dE4fG5h",
      "rk_prod_51HxQzA9bC3dE4fG5h",
      "whsec_",
    ]) {
      expect(maskVendorKeys(text)).toEqual({ text, masked: 0 })
      expect(hasVendorKey(text)).toBe(false)
    }
  })

  it("both masks together, with the note on its own line", () => {
    const out = maskWithNote(`key ${live} card 4242424242424242`)
    expect(out).toEqual({
      text: "key sk_live_•••••••• card •••• •••• •••• 4242\n\n[A card number and a key were hidden.]",
      cards: 1,
      keys: 1,
    })
    expect(maskPaymentSecrets("nothing here")).toEqual({ text: "nothing here", cards: 0, keys: 0 })
    expect(maskWithNote("nothing here").text).toBe("nothing here")
  })
})
