// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { formatDateCell, parseCellTimestamp } from "./date-cell"

const sp = (s: string | null) => s?.replace(/[  ]/g, " ") ?? null

describe("parseCellTimestamp", () => {
  it("reads a bare day, ISO timestamps and Postgres' text form (short +00 offset)", () => {
    expect(parseCellTimestamp("2026-11-24")).toMatchObject({ dayOnly: true })
    expect(parseCellTimestamp("2026-11-24 22:47:30.548+00")?.date.toISOString()).toBe(
      "2026-11-24T22:47:30.548Z",
    )
    expect(parseCellTimestamp("2026-11-24T22:47:30Z")?.date.toISOString()).toBe(
      "2026-11-24T22:47:30.000Z",
    )
    expect(parseCellTimestamp("2026-11-24T23:47:30+01:00")?.date.toISOString()).toBe(
      "2026-11-24T22:47:30.000Z",
    )
    expect(parseCellTimestamp("2026-11-24 23:47:30+0100")?.date.toISOString()).toBe(
      "2026-11-24T22:47:30.000Z",
    )
  })
  it("a written midnight in UTC is a day; a naive timestamp keeps its written clock", () => {
    expect(parseCellTimestamp("2026-11-24T00:00:00.000Z")).toMatchObject({ dayOnly: true })
    expect(parseCellTimestamp("2026-11-24 00:00:00+00")).toMatchObject({ dayOnly: true })
    expect(parseCellTimestamp("2026-11-24 09:15:00")).toMatchObject({ dayOnly: false, naive: true })
  })
  it("is not fooled by text, numbers or impossible dates", () => {
    expect(parseCellTimestamp("Blue mug")).toBeNull()
    expect(parseCellTimestamp("2026")).toBeNull()
    expect(parseCellTimestamp("2026-11")).toBeNull()
    expect(parseCellTimestamp("2026-13-40")).toBeNull()
    expect(parseCellTimestamp("INV-2026-11-24")).toBeNull()
  })
})

describe("formatDateCell", () => {
  it("the bug: a timestamptz text reads as a date and a time in the reader's language", () => {
    const v = "2026-11-24 22:47:30.548+00"
    expect(sp(formatDateCell(v, { locale: "en", timeZone: "UTC" }))).toBe("Nov 24, 2026, 10:47 PM")
    expect(sp(formatDateCell(v, { locale: "fr", timeZone: "UTC" }))).toBe("24 nov. 2026, 22:47")
  })
  it("reads a timestamp in the org's zone", () => {
    const v = "2026-11-24 22:47:30.548+00"
    expect(sp(formatDateCell(v, { locale: "fr", timeZone: "Europe/Paris" }))).toBe(
      "24 nov. 2026, 23:47",
    )
    expect(sp(formatDateCell(v, { locale: "en", timeZone: "Asia/Tokyo" }))).toBe(
      "Nov 25, 2026, 7:47 AM",
    )
  })
  it("a day, a written midnight and a midnight in the reading zone read as the date alone", () => {
    expect(formatDateCell("2026-11-24", { locale: "en", timeZone: "America/New_York" })).toBe(
      "Nov 24, 2026",
    )
    expect(
      formatDateCell("2026-11-24T00:00:00Z", { locale: "en", timeZone: "America/New_York" }),
    ).toBe("Nov 24, 2026")
    expect(formatDateCell("2026-11-23T23:00:00Z", { locale: "en", timeZone: "Europe/Paris" })).toBe(
      "Nov 24, 2026",
    )
  })
  it("dateOnly (a date column) drops the time; the day is the reading zone's", () => {
    expect(
      formatDateCell("2026-11-24 22:47:30+00", {
        locale: "en",
        timeZone: "Asia/Tokyo",
        dateOnly: true,
      }),
    ).toBe("Nov 25, 2026")
  })
  it("a naive timestamp keeps its written clock; an unknown zone falls back to UTC", () => {
    expect(
      sp(formatDateCell("2026-11-24 09:15:00", { locale: "en", timeZone: "Asia/Tokyo" })),
    ).toBe("Nov 24, 2026, 9:15 AM")
    expect(
      sp(formatDateCell("2026-11-24T09:15:00Z", { locale: "en", timeZone: "Nope/Zone" })),
    ).toBe("Nov 24, 2026, 9:15 AM")
  })
  it("returns null for what is not a date, so the caller shows it as it came", () => {
    expect(formatDateCell("Blue mug", { locale: "en" })).toBeNull()
    expect(formatDateCell(42, { locale: "en" })).toBeNull()
    expect(formatDateCell(null, { locale: "en" })).toBeNull()
  })
  it("takes a Date", () => {
    expect(
      sp(formatDateCell(new Date("2026-11-24T22:47:30Z"), { locale: "en", timeZone: "UTC" })),
    ).toBe("Nov 24, 2026, 10:47 PM")
  })
})
