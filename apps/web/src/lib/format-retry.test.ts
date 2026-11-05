// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { formatRetryDelay } from "~/lib/format-retry"

describe("formatRetryDelay", () => {
  it("degrades to a unit-free message for unknown or invalid input", () => {
    expect(formatRetryDelay(undefined)).toBe("Try again in a moment.")
    expect(formatRetryDelay(0)).toBe("Try again in a moment.")
    expect(formatRetryDelay(-5)).toBe("Try again in a moment.")
    expect(formatRetryDelay(Number.NaN)).toBe("Try again in a moment.")
  })

  it("uses grammatical seconds below 90s, rounding up", () => {
    expect(formatRetryDelay(1)).toBe("Try again in 1 second.")
    expect(formatRetryDelay(0.4)).toBe("Try again in 1 second.")
    expect(formatRetryDelay(30)).toBe("Try again in 30 seconds.")
    expect(formatRetryDelay(89)).toBe("Try again in 89 seconds.")
  })

  it("switches to minutes at 90s, rounding up (never promises less than the real wait)", () => {
    expect(formatRetryDelay(90)).toBe("Try again in about 2 minutes.")
    expect(formatRetryDelay(2953)).toBe("Try again in about 50 minutes.")
    expect(formatRetryDelay(3600)).toBe("Try again in about 60 minutes.")
  })

  it("switches to hours for very long waits", () => {
    expect(formatRetryDelay(90 * 60)).toBe("Try again in about 2 hours.")
    expect(formatRetryDelay(3 * 3600)).toBe("Try again in about 3 hours.")
  })

  it("never emits an absurd magnitude in any unit (duration-humanizer sanity)", () => {
    // Property sweep: for any input up to a week, the numeric figure shown
    // stays within its unit's sane range (seconds < 90, minutes < 90,
    // hours <= 24 * 7) and no dash punctuation appears in the copy.
    for (let s = 1; s <= 7 * 24 * 3600; s = Math.ceil(s * 1.37)) {
      const msg = formatRetryDelay(s)
      const m = msg.match(/(\d+) (second|minute|hour)/)
      expect(m, msg).toBeTruthy()
      const n = Number(m?.[1])
      if (m?.[2] === "second") expect(n).toBeLessThan(90)
      if (m?.[2] === "minute") expect(n).toBeLessThan(90)
      if (m?.[2] === "hour") expect(n).toBeLessThanOrEqual(24 * 7)
      expect(msg.includes("--")).toBe(false)
      expect(msg.includes("—")).toBe(false)
    }
  })
})
