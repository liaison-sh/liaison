// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { describe, expect, it } from "vitest"
import { capitalize, compactAge, formatDay, relativeTime } from "./relative-time"

const NOW = new Date("2026-09-22T12:00:00Z")
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000)
// Intl separates figure and unit with a no-break space; compare on plain ones.
const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, " ")

// A French reader got "il y a 11w ago" and "mise à jour 11w ago": a translated
// template around an English figure. The whole phrase comes from Intl now.
describe("relativeTime", () => {
  it("speaks one language, the reader's", () => {
    expect(plain(relativeTime(ago(11 * 7 * 86_400), "fr", { now: NOW }))).toBe("il y a 2 mois")
    expect(plain(relativeTime(ago(300), "fr", { now: NOW }))).toBe("il y a 5 min")
    expect(plain(relativeTime(ago(3 * 86_400), "fr", { now: NOW }))).toBe("il y a 3 j")
    expect(plain(relativeTime(ago(400 * 86_400), "fr", { now: NOW }))).toBe("il y a 1 an")
    for (const s of [30, 300, 7200, 3 * 86_400, 77 * 86_400]) {
      expect(relativeTime(ago(s), "fr", { now: NOW })).not.toMatch(/ago|\d[mhdw]\b/)
    }
  })

  it("keeps the compact English the product always used", () => {
    expect(relativeTime(ago(300), "en", { now: NOW })).toBe("5m ago")
    expect(relativeTime(ago(7200), "en", { now: NOW })).toBe("2h ago")
    expect(relativeTime(ago(300), "en", { now: NOW, style: "long" })).toBe("5 minutes ago")
  })

  it("phrases the future too, and answers blank for nothing", () => {
    expect(plain(relativeTime(new Date(NOW.getTime() + 7_200_000), "fr", { now: NOW }))).toBe(
      "dans 2 h",
    )
    expect(relativeTime(null, "fr")).toBe("")
    expect(relativeTime("not a date", "fr")).toBe("")
  })
})

describe("compactAge", () => {
  it("is a bare age in the reader's units", () => {
    expect(compactAge(ago(300), "en", NOW)).toBe("5m")
    expect(plain(compactAge(ago(300), "fr", NOW))).toBe("5min")
    expect(compactAge(ago(86_400), "fr", NOW)).toBe("hier")
  })
})

describe("formatDay", () => {
  it("names a calendar day in the locale, never raw ISO", () => {
    expect(formatDay("2026-07-05", "fr")).toBe("5 juil.")
    expect(formatDay("2026-07-05", "en")).toBe("Jul 5")
    expect(formatDay("2026-07-05", "fr", { dateStyle: "long" })).toBe("5 juillet 2026")
  })

  it("reads YYYY-MM-DD as a local day, so it never shifts across a timezone", () => {
    expect(formatDay("2026-01-01", "en", { day: "numeric" })).toBe("1")
  })

  it("capitalises a relative day word", () => {
    expect(capitalize("hier")).toBe("Hier")
  })
})
