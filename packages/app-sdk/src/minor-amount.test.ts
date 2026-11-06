// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, it } from "bun:test"
import { minorAmountRefusal, readMinorAmount } from "./minor-amount"

describe("readMinorAmount", () => {
  it("reads a whole number, in any form the wire delivers", () => {
    expect(readMinorAmount(41940)).toBe(41940n)
    expect(readMinorAmount(-41940)).toBe(-41940n)
    expect(readMinorAmount("41940")).toBe(41940n)
    expect(readMinorAmount(" -41940 ")).toBe(-41940n)
    expect(readMinorAmount(41940n)).toBe(41940n)
    expect(readMinorAmount(0)).toBe(0n)
    expect(readMinorAmount("90071992547409930")).toBe(90071992547409930n)
  })

  it("reads nothing else, never guessing a unit", () => {
    for (const v of [
      "899.00",
      "-1260.50",
      12.5,
      -550.5,
      "$1",
      "1 EUR",
      "1,00",
      "1e3",
      1e21,
      "",
      " ",
      null,
      undefined,
      NaN,
      Infinity,
      true,
      {},
      [],
    ]) {
      expect(readMinorAmount(v)).toBeNull()
    }
  })
})

describe("minorAmountRefusal", () => {
  it("names the amount it read and what to send under each meaning", () => {
    const text = minorAmountRefusal("items[0].unit_price_minor", "-1260.50")
    expect(text).toContain('items[0].unit_price_minor is "-1260.50"')
    expect(text).toContain("send -126050")
    expect(text).toContain("send -1260 or -1261")
    expect(text).toContain("nothing was done")
  })

  it("a whole number written with a decimal point has one reading of each kind", () => {
    const text = minorAmountRefusal("x_minor", "899.00")
    expect(text).toContain("send 89900")
    expect(text).toContain("send 899.")
  })

  it("handles a fractional number, and one too fine to be currency units", () => {
    expect(minorAmountRefusal("x_minor", -550.5)).toContain("send -55050")
    const fine = minorAmountRefusal("x_minor", "12.345")
    expect(fine).not.toContain("currency units")
    expect(fine).toContain("send 12 or 13")
  })

  it("says what a value with no reading should look like", () => {
    for (const v of ["$1", "1,50", "1e3", true, { a: 1 }]) {
      const text = minorAmountRefusal("x_minor", v)
      expect(text).toContain("not a whole number")
      expect(text).toContain("41940 for 419.40")
    }
  })
})
