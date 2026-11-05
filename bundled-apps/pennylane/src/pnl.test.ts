// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, it, expect } from "bun:test"
import { classifyAccount, computePnlSummary, computeRunway } from "./pnl"
import type { PnlClass } from "./types"

const MAPPING: Record<string, PnlClass> = { "70": "revenue", "60": "cogs", "62": "opex" }

describe("classifyAccount (longest-prefix wins)", () => {
  it.each([
    ["707000", "revenue"],
    ["601000", "cogs"], // 601… must beat 60… — the load-bearing case
    ["627000", "opex"],
    ["999999", "other"], // no prefix match
    ["60", "cogs"], // exact-prefix boundary
    ["6", "other"], // shorter than any key
    ["", "other"], // empty code
  ] as const)("classifies %s as %s", (code, expected) => {
    expect(classifyAccount(code, MAPPING)).toBe(expected)
  })

  it("prefers the longest matching prefix when a longer key is added", () => {
    const m: Record<string, PnlClass> = { "60": "opex", "601": "cogs" }
    expect(classifyAccount("601000", m)).toBe("cogs") // 601 (len 3) beats 60 (len 2)
    expect(classifyAccount("605000", m)).toBe("opex") // only 60 matches
  })
})

describe("computePnlSummary", () => {
  it("buckets trial-balance lines into P&L classes with summed minor amounts", () => {
    const tb = [
      { account_code: "707000", label: "Sales", balance_minor: 100000n },
      { account_code: "601000", label: "Parts", balance_minor: 40000n },
      { account_code: "627000", label: "Bank fees", balance_minor: 5000n },
      { account_code: "999999", label: "Suspense", balance_minor: 1234n },
    ]
    const out = computePnlSummary(tb, MAPPING)
    expect(out.revenue).toBe(100000n)
    expect(out.cogs).toBe(40000n)
    expect(out.opex).toBe(5000n)
    expect(out.other).toBe(1234n)
    expect(out.gross_margin).toBe(60000n) // revenue - cogs
  })

  it("returns all-zero on an empty book", () => {
    const out = computePnlSummary([], MAPPING)
    expect(out).toEqual({ revenue: 0n, cogs: 0n, opex: 0n, other: 0n, gross_margin: 0n })
  })
})

describe("computeRunway", () => {
  it("computes cash / trailing net burn in whole months", () => {
    expect(computeRunway(300000n, 30000n).months).toBe(10)
    expect(computeRunway(300000n, 30000n).cash_status).toBe("live")
  })
  it("returns months:null when net burn is non-positive (cash-flow positive)", () => {
    expect(computeRunway(300000n, -5000n).months).toBeNull()
    expect(computeRunway(300000n, 0n).months).toBeNull()
    expect(computeRunway(300000n, -5000n).cash_status).toBe("live")
  })
  it("returns cash_status:unavailable + months:null when bank scope is descoped (403)", () => {
    const r = computeRunway(0n, 30000n, { cashUnavailable: true })
    expect(r.cash_status).toBe("unavailable")
    expect(r.months).toBeNull()
  })
})
