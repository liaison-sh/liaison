// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The calculated values' grammar: arithmetic over named values, parsed by hand (no eval).

import { describe, expect, it } from "bun:test"
import { evaluateExpr, exprNames, exprProblems, parseExpr } from "~/modules/dashboards/expr"

describe("expressions", () => {
  it("computes + - * / with precedence, parentheses, unary minus and functions", () => {
    expect(evaluateExpr("revenue / spend", { revenue: 300, spend: 100 })).toBe(3)
    expect(evaluateExpr("a - b * 2", { a: 10, b: 3 })).toBe(4)
    expect(evaluateExpr("(a - b) * 2", { a: 10, b: 3 })).toBe(14)
    expect(evaluateExpr("-a + 1", { a: 2 })).toBe(-1)
    expect(evaluateExpr("round(a / b * 100, 1)", { a: 1, b: 3 })).toBe(33.3)
    expect(evaluateExpr("max(a, b, 0) + min(a, b) + abs(-2)", { a: 1, b: 5 })).toBe(8)
    expect(evaluateExpr("0.1 + 0.2", {})).toBe(0.3)
  })

  it("is null for a division by zero or a missing value, never a wrong number", () => {
    expect(evaluateExpr("a / b", { a: 1, b: 0 })).toBeNull()
    expect(evaluateExpr("a + b", { a: 1, b: null })).toBeNull()
    expect(evaluateExpr("a + c", { a: 1 })).toBeNull()
  })

  it("refuses anything that is not the grammar", () => {
    for (const bad of ["a +", "a b", "alert(1)", "a.b", "a; b", "(a", "", "a ** 2", "'x'"]) {
      expect(() => parseExpr(bad)).toThrow()
    }
    expect(() => parseExpr("x".repeat(301))).toThrow(/at most/)
  })

  it("names the values it reads and those that do not exist", () => {
    expect(exprNames("revenue / max(spend, 1)")).toEqual(["revenue", "spend"])
    expect(exprProblems("revenue / spend", ["revenue"])).toEqual([
      "'spend' is not a value of this block (revenue)",
    ])
    expect(exprProblems("a +", ["a"])[0]).toMatch(/ends too early/)
  })
})
