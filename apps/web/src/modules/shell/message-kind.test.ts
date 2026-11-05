// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ticket-10175: "renforcer les différences visuelles entre les messages reçus,
// envoyés, les rapports de l'IA." The streams did distinguish them -- by hue at
// ~20% opacity, with a badge printing the raw enum. This pins the properties
// that make the distinction survive a bright room, greyscale, and a colour
// vision deficiency.
import { describe, expect, it } from "vitest"
import { isCustomerVisible, presentMessageKind } from "~/modules/shell/message-kind"

const KINDS = ["inbound", "outbound", "outbound-pending", "note"] as const

describe("presentMessageKind", () => {
  it("never shows the raw enum to a human", () => {
    for (const k of KINDS) {
      const p = presentMessageKind(k)
      expect(p.label).not.toBe(k)
      expect(p.label).not.toMatch(/[-_]/) // "outbound-pending" and friends
    }
  })

  it("says who can see an internal note, in words", () => {
    // The costly mistake runs BOTH ways: reading a note as something the
    // customer saw, or writing one believing they will.
    const note = presentMessageKind("note")
    expect(note.visibility).toMatch(/not visible to the customer/i)
    expect(note.label).toMatch(/internal/i)
  })

  it("distinguishes every kind WITHOUT relying on colour", () => {
    const seen = new Set(
      KINDS.map((k) => `${presentMessageKind(k).label}|${presentMessageKind(k).tone}`),
    )
    expect(seen.size).toBe(KINDS.length)
  })

  it("gives the two customer-facing kinds a rail and inbound none", () => {
    // Inbound is the baseline the others are read AGAINST; railing everything
    // would flatten the very distinction the rail exists to carry.
    expect(presentMessageKind("inbound").rail).toBe("")
    expect(presentMessageKind("outbound").rail).not.toBe("")
    expect(presentMessageKind("note").rail).not.toBe("")
  })

  it("expresses the rail as a BACKGROUND, never a border utility", () => {
    // The first cut used `border-l-[3px] border-l-accent`. The card's own
    // `border-border` sets all four sides and beat it, so outbound rendered a
    // 3px left border in the ORDINARY border colour: correct in the class
    // string, invisible on screen, identical to inbound. Measured on prod as
    // borderLeftColor rgb(223,223,229). A class-string assertion could not see
    // it; this one at least stops the pattern coming back.
    for (const k of KINDS) {
      const rail = presentMessageKind(k).rail
      expect(rail).not.toContain("border-")
      if (rail !== "") expect(rail).toMatch(/^bg-/)
    }
  })

  it("marks an undelivered reply as not-yet-committed", () => {
    const pending = presentMessageKind("outbound-pending")
    expect(pending.visibility).toMatch(/not delivered/i)
    // Weaker than a delivered reply: the commitment is not made until it lands.
    expect(pending.rail).not.toBe(presentMessageKind("outbound").rail)
  })

  it("carries a stable semantic tone independent of styling", () => {
    expect(presentMessageKind("inbound").tone).toBe("evidence")
    expect(presentMessageKind("outbound").tone).toBe("commitment")
    expect(presentMessageKind("outbound-pending").tone).toBe("commitment")
    expect(presentMessageKind("note").tone).toBe("internal")
  })

  it("falls back to the RECESSIVE treatment for a kind it has never seen", () => {
    // A stream must still render when the backend grows a kind the frontend has
    // not shipped. The safe default is the one that never claims a message was
    // sent to anyone.
    for (const unknown of ["system", "", null, undefined, "brand-new-kind"]) {
      const p = presentMessageKind(unknown)
      expect(p.tone).toBe("evidence")
      expect(p.rail).toBe("")
    }
  })

  it("uses design tokens, not raw palette values", () => {
    // The streams had hardcoded amber-950 / blue-950, which bypasses the theme
    // and does not follow light mode.
    for (const k of KINDS) {
      const p = presentMessageKind(k)
      const all = `${p.rail} ${p.surface} ${p.badge}`
      expect(all).not.toMatch(/\b(amber|blue|red|green|slate|zinc|gray|grey)-\d{2,3}\b/)
    }
  })
})

describe("isCustomerVisible", () => {
  it("is true for what the customer can see and false for a note", () => {
    expect(isCustomerVisible("inbound")).toBe(true)
    expect(isCustomerVisible("outbound")).toBe(true)
    expect(isCustomerVisible("outbound-pending")).toBe(true)
    expect(isCustomerVisible("note")).toBe(false)
  })

  it("is false for an unknown kind -- never claim reach we cannot prove", () => {
    expect(isCustomerVisible("mystery")).toBe(false)
    expect(isCustomerVisible(null)).toBe(false)
  })
})
