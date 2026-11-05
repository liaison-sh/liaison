// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { localDateSentence } from "./local-date"

describe("localDateSentence", () => {
  it("gives the person's own date with its weekday", () => {
    // 23:30 UTC on Tuesday is already Wednesday in Paris.
    const now = new Date("2026-10-27T23:30:00Z")
    expect(localDateSentence(now, "Europe/Paris")).toBe(" There it is Wednesday, 28 October 2026.")
    expect(localDateSentence(now, "UTC")).toBe(" There it is Tuesday, 27 October 2026.")
  })

  it("says nothing for a timezone the runtime cannot read", () => {
    expect(localDateSentence(new Date(), "Not/AZone")).toBe("")
  })
})
