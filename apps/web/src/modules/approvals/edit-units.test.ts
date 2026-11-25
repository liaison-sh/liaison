// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { shownValue, storedValue } from "./edit-units"

describe("an approval field edited in the unit a person reads", () => {
  it("minutes read and typed as hours", () => {
    expect(shownValue("hours", 3600)).toBe("60")
    expect(shownValue("hours", 90)).toBe("1.5")
    expect(storedValue("hours", "62", 3600)).toBe(3720)
    expect(storedValue("hours", "1,5", 3600)).toBe(90)
    expect(storedValue("hours", "soon", 3600)).toBeUndefined()
  })

  it("an amount in cents read and typed in the currency's units, kept a string", () => {
    expect(shownValue("money", "11000", "EUR")).toBe("110.00")
    expect(shownValue("money", "5", "EUR")).toBe("0.05")
    expect(storedValue("money", "115", "11000", "EUR")).toBe("11500")
    expect(storedValue("money", "115.5", "11000", "EUR")).toBe("11550")
    expect(storedValue("money", "115,25", "11000", "EUR")).toBe("11525")
    expect(storedValue("money", "1.234", "11000", "EUR")).toBeUndefined()
    // A currency with no minor unit.
    expect(shownValue("money", "1500", "JPY")).toBe("1500")
    expect(storedValue("money", "1600", "1500", "JPY")).toBe("1600")
  })

  it("a field with no unit is shown and kept as typed", () => {
    expect(shownValue(undefined, "abc")).toBe("abc")
    expect(storedValue(undefined, "abc", "")).toBe("abc")
  })
})
