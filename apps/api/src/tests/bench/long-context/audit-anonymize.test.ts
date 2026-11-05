// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { createAnonymizer, FREE_TEXT_MAX_CHARS } from "./audit-anonymize"

describe("createAnonymizer / anonymizeText", () => {
  it("maps the same email to the same pseudonym within a run", () => {
    const a = createAnonymizer([])
    const first = a.anonymizeText("contact stephanie@tailspin.example about the order")
    const second = a.anonymizeText("cc stephanie@tailspin.example on the reply too")
    const p1 = first.match(/email_\d+/)?.[0]
    const p2 = second.match(/email_\d+/)?.[0]
    expect(p1).toBeDefined()
    expect(p1).toBe(p2)
    expect(first).not.toContain("stephanie@tailspin.example")
    expect(second).not.toContain("stephanie@tailspin.example")
  })

  it("maps the same UUID to the same pseudonym within a run", () => {
    const a = createAnonymizer([])
    const uuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
    const first = a.anonymizeText(`order ${uuid} was refunded`)
    const second = a.anonymizeText(`entity ${uuid} updated again`)
    const p1 = first.match(/uuid_\d+/)?.[0]
    const p2 = second.match(/uuid_\d+/)?.[0]
    expect(p1).toBeDefined()
    expect(p1).toBe(p2)
  })

  it("gives different pseudonyms to different emails", () => {
    const a = createAnonymizer([])
    const out1 = a.anonymizeText("a@example.com")
    const out2 = a.anonymizeText("b@example.com")
    expect(out1).not.toBe(out2)
  })

  it("replaces a name from the known user/contact list wherever it appears", () => {
    const a = createAnonymizer(["Stephanie Aubert"])
    const out = a.anonymizeText(
      "Stephanie Aubert asked about the shipment, then Stephanie Aubert called",
    )
    expect(out).not.toContain("Stephanie Aubert")
    const matches = out.match(/person_\d+/g)
    expect(matches).toEqual(["person_1", "person_1"])
  })

  it("does not let a shorter known name shadow a longer one it is a substring of", () => {
    const a = createAnonymizer(["Stephanie", "Stephanie Aubert"])
    const out = a.anonymizeText("Stephanie Aubert is the account owner")
    // The full "Stephanie Aubert" match wins (longest-first ordering); the
    // bare "Stephanie" token must not leak out of a partial replacement.
    expect(out).not.toContain("Stephanie")
  })

  it("redacts an IBAN-like string", () => {
    const a = createAnonymizer([])
    const out = a.anonymizeText("wire to FR7630006000011234567890189 please")
    expect(out).not.toContain("FR7630006000011234567890189")
    expect(out).toMatch(/iban_\d+/)
  })

  it("redacts a phone number", () => {
    const a = createAnonymizer([])
    const out = a.anonymizeText("call me at +33 6 12 34 56 78 tomorrow")
    expect(out).not.toContain("12 34 56 78")
    expect(out).toMatch(/phone_\d+/)
  })

  it("redacts a street address", () => {
    const a = createAnonymizer([])
    const out = a.anonymizeText("ship to 221B Baker Street for the demo")
    expect(out).not.toContain("221B Baker Street")
    expect(out).toMatch(/address_\d+/)
  })
})

describe("anonymizeJsonValue", () => {
  it("collapses a free text value over the length cutoff to a shape token", () => {
    const a = createAnonymizer([])
    const longText = "x".repeat(300)
    expect(longText.length).toBeGreaterThan(FREE_TEXT_MAX_CHARS)
    const out = a.anonymizeJsonValue({ note: longText }) as Record<string, unknown>
    expect(out.note).toBe(`<text:300chars>`)
  })

  it("keeps a short enum-like string, a number, and a boolean as-is", () => {
    const a = createAnonymizer([])
    const out = a.anonymizeJsonValue({
      status: "pending",
      count: 7,
      urgent: true,
    }) as Record<string, unknown>
    expect(out.status).toBe("pending")
    expect(out.count).toBe(7)
    expect(out.urgent).toBe(true)
  })

  it("keeps a tool name and an action name verbatim even past the length cutoff", () => {
    const a = createAnonymizer([])
    const longToolName = `shopify.orders.search.${"x".repeat(50)}`
    expect(longToolName.length).toBeGreaterThan(FREE_TEXT_MAX_CHARS)
    const out = a.anonymizeJsonValue({
      tool: longToolName,
      action: "orders.search",
    }) as Record<string, unknown>
    expect(out.tool).toBe(longToolName)
    expect(out.action).toBe("orders.search")
  })

  it("keeps an ABC-1234-shaped identifier verbatim", () => {
    const a = createAnonymizer([])
    const out = a.anonymizeJsonValue({ ref: "ORD-4821" }) as Record<string, unknown>
    expect(out.ref).toBe("ORD-4821")
  })

  it("keeps object keys and array length (item count) while recursing into values", () => {
    const a = createAnonymizer([])
    const out = a.anonymizeJsonValue({
      items: [{ sku: "A" }, { sku: "B" }, { sku: "C" }],
    }) as { items: unknown[] }
    expect(Object.keys(out)).toEqual(["items"])
    expect(out.items).toHaveLength(3)
  })

  it("pseudonymizes PII found inside a short JSON string value", () => {
    const a = createAnonymizer([])
    const out = a.anonymizeJsonValue({
      contact: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    }) as Record<string, unknown>
    expect(out.contact).toMatch(/^uuid_\d+$/)
  })

  it("returns null and undefined unchanged", () => {
    const a = createAnonymizer([])
    expect(a.anonymizeJsonValue(null)).toBeNull()
    expect(a.anonymizeJsonValue(undefined)).toBeUndefined()
  })
})
