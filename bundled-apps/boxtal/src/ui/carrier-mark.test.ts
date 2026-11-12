// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Oracle for the collapsed carrier control's brand -> WORDMARK resolution.
//
// The prep grid's total cell shows the chosen offer's carrier as a mark instead
// of the carrier name plus a 140px dropdown. Three things can silently break
// that: a carrier this org ships with that resolves to no mark (the operator
// sees a bare text name where every other row shows a logo), a mark with no
// accessible name (an unnamable glyph, which is a regression, not a fix), and a
// mark that stops being a LOGO -- the first pass drew 2-3 letter abbreviations
// (`CHR` for Chronopost), which is less recognisable than the carrier's name
// and is not what a wordmark brand looks like. A mark must therefore carry the
// brand's NAME, and it must still fit the width the Total column can pay for.
// All three are decidable from data, so they are pinned here rather than left
// to a rendered capture. (The e2e measures the rendered width of every mark
// against the same cap: prep-grid.scenario.test.ts step 3e.)

import { describe, expect, it } from "bun:test"
import { CARRIER_BRANDS } from "../carriers"
import {
  brandsMissingAMark,
  CARRIER_MARKS,
  carrierDisplay,
  carrierMark,
  carrierShortName,
  MARK_MAX_WIDTH,
  markedCarrierBrands,
  markWordmark,
} from "./carrier-mark"

describe("carrier mark resolution", () => {
  it("every enumerated carrier brand resolves to a mark", () => {
    expect(brandsMissingAMark()).toEqual([])
    expect(markedCarrierBrands().sort()).toEqual(CARRIER_BRANDS.map((b) => b.key).sort())
  })

  it("resolves by brand key, by label, and by a service variant of the label", () => {
    for (const b of CARRIER_BRANDS) {
      expect(carrierMark(b.key)?.brand, `key ${b.key}`).toBe(b.key)
      expect(carrierMark(b.label)?.brand, `label ${b.label}`).toBe(b.key)
    }
    // Boxtal names the carrier per SERVICE variant; the mark follows the brand.
    expect(carrierMark("FedEx International Priority")?.brand).toBe("fedex")
    expect(carrierMark("Chronopost Chrono 13")?.brand).toBe("chronopost")
    expect(carrierMark("Colissimo Domicile")?.brand).toBe("laposte")
    expect(carrierMark("UPS Express Saver")?.brand).toBe("ups")
    expect(carrierMark("Mondial Relay Point Relais")?.brand).toBe("mondialrelay")
  })

  it("every mark carries an accessible name and the brand's own name as its wordmark", () => {
    for (const m of CARRIER_MARKS) {
      // The name is what reaches title + aria-label, verbatim.
      expect(m.name.trim().length, `name for ${m.brand}`).toBeGreaterThan(0)
      expect(m.name).toBe(m.name.trim())
      // A brand's mark must be named after the brand, not after another one.
      const brand = CARRIER_BRANDS.find((b) => b.key === m.brand)
      expect(brand, `unknown brand ${m.brand}`).toBeDefined()
      expect(m.name).toBe(brand!.label)
      // THE MARK IS A WORDMARK, NOT AN ABBREVIATION. What it draws has to be a
      // name the operator reads, and that name has to be the brand's own: it is
      // part of the accessible name, letters not initials, at least 3 of them.
      const word = markWordmark(m)
      expect(word, `wordmark for ${m.brand}`).toMatch(/^[A-Za-z][A-Za-z ]{2,}$/)
      const flat = (v: string) => v.toLowerCase().replace(/[^a-z]/g, "")
      expect(flat(m.name), `wordmark ${word} is not the name of ${m.name}`).toContain(flat(word))
      // Brand colours, and a ground the mark paints itself so a brand colour
      // never lands on the theme's background in either theme.
      expect(m.fg, `fg for ${m.brand}`).toMatch(/^#[0-9a-f]{6}$/)
      expect(m.bg, `bg for ${m.brand}`).toMatch(/^#[0-9a-f]{6}$/)
      expect(m.fg).not.toBe(m.bg)
      // A two-tone wordmark (FedEx, Chronopost) declares the second colour.
      if (m.text2 !== undefined) {
        expect(m.text2.length, `text2 for ${m.brand}`).toBeGreaterThan(0)
        expect(m.fg2, `fg2 for ${m.brand}`).toMatch(/^#[0-9a-f]{6}$/)
        expect(m.fg2).not.toBe(m.bg)
      } else {
        expect(m.fg2).toBeUndefined()
      }
      // WIDTH CAP. The renderer condenses the name to exactly this width
      // (textLength + lengthAdjust), so the Total column's cost is declared
      // here and cannot drift with the platform font.
      expect(m.width, `width for ${m.brand}`).toBeLessThanOrEqual(MARK_MAX_WIDTH)
      expect(m.width, `width for ${m.brand}`).toBeGreaterThan(0)
      // Enough room for the letters: the badge is not a sliver.
      expect(m.width / word.length, `px per glyph for ${m.brand}`).toBeGreaterThanOrEqual(3)
    }
    // One mark per brand, no two brands drawing the same wordmark.
    expect(new Set(CARRIER_MARKS.map((m) => m.brand)).size).toBe(CARRIER_MARKS.length)
    expect(new Set(CARRIER_MARKS.map((m) => markWordmark(m))).size).toBe(CARRIER_MARKS.length)
  })

  it("names the carriers the owner asked to recognise, in their own colours", () => {
    const by = (k: string) => CARRIER_MARKS.find((m) => m.brand === k)!
    // FedEx: the two-tone wordmark, purple "Fed" + orange "Ex".
    expect(markWordmark(by("fedex"))).toBe("FedEx")
    expect(by("fedex").fg).toBe("#4d148c")
    expect(by("fedex").fg2).toBe("#ff6600")
    // UPS: white on the brown.
    expect(markWordmark(by("ups"))).toBe("UPS")
    expect(by("ups").fg).toBe("#ffffff")
    expect(by("ups").bg).toBe("#351c15")
    // DHL: red on the yellow.
    expect(markWordmark(by("dhl"))).toBe("DHL")
    expect(by("dhl").fg).toBe("#d40511")
    expect(by("dhl").bg).toBe("#ffcc00")
    // Chronopost: its blue and green, on white -- and spelled out, not "CHR".
    expect(markWordmark(by("chronopost"))).toBe("Chronopost")
    expect(by("chronopost").bg).toBe("#ffffff")
    // The rest carry their names too, which is the property that matters.
    expect(markWordmark(by("laposte"))).toBe("Colissimo")
    expect(markWordmark(by("mondialrelay"))).toBe("Mondial Relay")
    expect(markWordmark(by("colisprive"))).toBe("Colis Prive")
    expect(markWordmark(by("tnt"))).toBe("TNT")
    expect(markWordmark(by("sodexi"))).toBe("Sodexi")
    expect(markWordmark(by("happypost"))).toBe("Happy Post")
  })

  it("an unknown carrier falls back to its short text name, never to a nameless glyph", () => {
    expect(carrierMark("Zorg Logistics Express")).toBeNull()
    const d = carrierDisplay("Zorg Logistics Express")
    expect(d.mark).toBeNull()
    expect(d.name).toBe("Zorg")
    expect(carrierShortName("Zorg Logistics Express")).toBe("Zorg")
    expect(carrierShortName("Extraordinarily Long Carrier")).toBe("Extraordin")
  })

  it("a known carrier displays as its mark, and the display always has a name", () => {
    const d = carrierDisplay("Chronopost Chrono 13")
    expect(d.mark?.brand).toBe("chronopost")
    expect(d.name).toBe("Chronopost")
    for (const carrier of [null, undefined, "", "   ", "Zorg", "UPS"]) {
      expect(
        carrierDisplay(carrier).name.length,
        `display name for ${String(carrier)}`,
      ).toBeGreaterThan(0)
    }
    expect(carrierDisplay("").name).toBe("Unknown carrier")
  })
})
