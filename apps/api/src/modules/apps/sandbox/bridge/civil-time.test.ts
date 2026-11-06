// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { civilTimeAt, instantOf } from "./civil-time"

describe("civilTimeAt", () => {
  it("reads the wall clock of the zone", () => {
    expect(civilTimeAt("Europe/Paris", new Date("2026-12-31T23:20:00Z"))).toEqual({
      date: "2027-01-01",
      year: 2027,
      month: 1,
      day: 1,
      hour: 0,
      minute: 20,
      weekday: 5,
      zone: "Europe/Paris",
    })
  })

  it("midnight is hour 0, and Sunday is weekday 7", () => {
    expect(civilTimeAt("Etc/UTC", new Date("2026-11-08T00:05:00Z"))).toMatchObject({
      hour: 0,
      minute: 5,
      weekday: 7,
    })
  })

  it("follows the clock change", () => {
    expect(civilTimeAt("Europe/Paris", new Date("2027-03-28T00:59:00Z"))).toMatchObject({
      date: "2027-03-28",
      hour: 1,
    })
    expect(civilTimeAt("Europe/Paris", new Date("2027-03-28T01:00:00Z"))).toMatchObject({
      date: "2027-03-28",
      hour: 3,
    })
  })

  it("refuses what is not a zone name, an offset included", () => {
    for (const zone of ["Europe/Atlantis", "+01:00", "", " Europe/Paris", "UTC; DROP"]) {
      expect(() => civilTimeAt(zone, new Date())).toThrow(
        expect.objectContaining({ code: "invalid_timezone", status: 422 }),
      )
    }
  })
})

describe("instantOf", () => {
  it("takes a date-time or epoch milliseconds, and now when absent", () => {
    expect(instantOf("2027-01-01T00:00:00Z").getTime()).toBe(Date.UTC(2027, 0, 1))
    expect(instantOf(Date.UTC(2027, 0, 1)).getTime()).toBe(Date.UTC(2027, 0, 1))
    expect(Math.abs(instantOf(undefined).getTime() - Date.now())).toBeLessThan(5000)
  })

  it("refuses a value that names no instant, never falling back to now", () => {
    for (const at of ["not a date", {}, true]) {
      expect(() => instantOf(at)).toThrow(expect.objectContaining({ code: "invalid_instant" }))
    }
  })
})
