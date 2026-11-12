// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { bt23, operationCategory } from "./classify-operation"

describe("operationCategory", () => {
  test("goods, and shipping counts with goods", () => {
    expect(operationCategory([{ line_kind: "goods" }], { authoritative: true })).toEqual({
      category: "goods",
      source: "lines_authoritative",
    })
    expect(
      operationCategory([{ line_kind: "goods" }, { line_kind: "shipping" }], {
        authoritative: false,
      }),
    ).toEqual({
      category: "goods",
      source: "lines_default",
    })
    expect(operationCategory([{ line_kind: "shipping" }], { authoritative: true }).category).toBe(
      "goods",
    )
  })
  test("software is services", () => {
    expect(operationCategory([{ line_kind: "software" }], { authoritative: true }).category).toBe(
      "services",
    )
  })
  test("mixed", () => {
    expect(
      operationCategory([{ line_kind: "software" }, { line_kind: "goods" }], {
        authoritative: true,
      }).category,
    ).toBe("mixed")
    expect(
      operationCategory([{ line_kind: "software" }, { line_kind: "shipping" }], {
        authoritative: true,
      }).category,
    ).toBe("mixed")
  })
  test("empty -> null", () => {
    expect(operationCategory([], { authoritative: true })).toEqual({
      category: null,
      source: "lines_authoritative",
    })
    expect(operationCategory([], { authoritative: false })).toEqual({
      category: null,
      source: "lines_default",
    })
  })
  test("a missing line_kind is the goods default", () => {
    expect(operationCategory([{ line_kind: null }], { authoritative: false }).category).toBe(
      "goods",
    )
  })
})

describe("bt23", () => {
  test("exactly nine codes", () => {
    const out = new Set<string>()
    for (const c of ["goods", "services", "mixed"] as const) {
      for (const p of ["due", "paid", "final_after_deposit"] as const) out.add(bt23(c, p))
    }
    expect([...out].sort()).toEqual(["B1", "B2", "B4", "M1", "M2", "M4", "S1", "S2", "S4"])
  })
  test("mapping", () => {
    expect(bt23("goods", "due")).toBe("B1")
    expect(bt23("services", "paid")).toBe("S2")
    expect(bt23("mixed", "final_after_deposit")).toBe("M4")
  })
})
