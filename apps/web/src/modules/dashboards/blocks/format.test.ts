// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { formatAxisLabel, formatValue, looksLikeDate } from "./format"

const nbsp = (s: string) => s.replace(/[  ]/g, " ")

describe("formatValue", () => {
  it("a year bucket (a four-digit string) reads as a label; a number stays a number", () => {
    expect(formatValue("2026", { locale: "en" })).toBe("2026")
    expect(formatValue(2026, { locale: "en" })).toBe("2,026")
  })
  it("formats numbers in the viewer's language", () => {
    expect(formatValue(1234.567, { locale: "en" })).toBe("1,234.57")
    expect(nbsp(formatValue(1234.5, { locale: "fr" }))).toBe("1 234,5")
    expect(formatValue("42", { format: "number", locale: "en" })).toBe("42")
  })

  it("formats currency, and falls back to a number without a code", () => {
    expect(formatValue(12, { format: "currency", currency: "EUR", locale: "en" })).toBe("€12.00")
    expect(nbsp(formatValue(12, { format: "currency", currency: "EUR", locale: "fr" }))).toBe(
      "12,00 €",
    )
    expect(formatValue(12, { format: "currency", locale: "en" })).toBe("12")
    expect(formatValue(12, { format: "currency", currency: "NOPE!", locale: "en" })).toBe("12")
  })

  it("formats a fraction as a percent", () => {
    expect(formatValue(0.255, { format: "percent", locale: "en" })).toBe("25.5%")
  })

  it("formats dates; a bare day stays that day", () => {
    expect(formatValue("2026-11-07", { format: "date", locale: "en" })).toBe("Nov 7, 2026")
    expect(formatValue("not a date", { format: "date", locale: "en" })).toBe("not a date")
  })

  it("an unformatted timestamp reads as a date and a time; a day or a midnight as the date", () => {
    const v = "2026-11-24 22:47:30.548+00"
    expect(nbsp(formatValue(v, { locale: "en", timeZone: "UTC" }))).toBe("Nov 24, 2026, 10:47 PM")
    expect(nbsp(formatValue(v, { locale: "fr", timeZone: "Europe/Paris" }))).toBe(
      "24 nov. 2026, 23:47",
    )
    expect(formatValue("2026-11-24", { locale: "en" })).toBe("Nov 24, 2026")
    expect(formatValue("2026-11-24T00:00:00.000Z", { locale: "en", timeZone: "UTC" })).toBe(
      "Nov 24, 2026",
    )
    expect(formatValue("INV-2026-11", { locale: "en" })).toBe("INV-2026-11")
  })

  it("a date column shows the day alone, Postgres' short offset included", () => {
    expect(
      formatValue("2026-11-24 22:47:30.548+00", {
        format: "date",
        locale: "en",
        timeZone: "Asia/Tokyo",
      }),
    ).toBe("Nov 25, 2026")
  })

  it("shows text as it came and nothing for an empty value", () => {
    expect(formatValue("Blue mug", { format: "number", locale: "en" })).toBe("Blue mug")
    expect(formatValue(null, { locale: "en" })).toBe("")
    expect(formatValue(undefined, { locale: "en" })).toBe("")
    expect(formatValue(true, { locale: "en" })).toBe("true")
  })
})

describe("axis labels", () => {
  it("reads days as short dates and keeps other labels", () => {
    expect(looksLikeDate("2026-11-07")).toBe(true)
    expect(looksLikeDate("Mugs")).toBe(false)
    expect(formatAxisLabel("2026-11-07", "en")).toBe("Nov 7")
    expect(formatAxisLabel("Mugs", "en")).toBe("Mugs")
    expect(formatAxisLabel(3, "en")).toBe("3")
  })
})
