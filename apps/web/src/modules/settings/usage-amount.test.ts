// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { describe, expect, it } from "vitest"
import { usageAmountDisplay } from "~/modules/settings/usage-amount"

describe("usageAmountDisplay", () => {
  it("self-hosted Activity: a model-call debit reads as a positive cost", () => {
    // The walk: gemini-pro-latest row printed "-€0.07".
    expect(usageAmountDisplay("-0.07000000", false)).toEqual({
      prefix: "",
      value: "0.07",
      credit: false,
    })
  })

  it("self-hosted: a sub-cent cost reads '<0.01', never '-0.00'", () => {
    expect(usageAmountDisplay("-0.00123000", false)).toEqual({
      prefix: "<",
      value: "0.01",
      credit: false,
    })
  })

  it("managed ledger keeps the sign: debits negative, credits '+'", () => {
    expect(usageAmountDisplay("-0.07", true)).toEqual({ prefix: "", value: "-0.07", credit: false })
    expect(usageAmountDisplay("10", true)).toEqual({ prefix: "+", value: "10", credit: true })
  })

  it("an exact zero stays zero", () => {
    expect(usageAmountDisplay("0", false)).toEqual({ prefix: "", value: "0", credit: false })
  })
})

describe("usageAmountDisplay, managed sub-cent", () => {
  it("keeps the ledger sign in front of '<'", () => {
    expect(usageAmountDisplay("-0.001", true)).toEqual({
      prefix: "-<",
      value: "0.01",
      credit: false,
    })
  })
})
