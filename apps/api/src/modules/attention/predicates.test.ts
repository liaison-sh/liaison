// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { evaluatePredicate } from "./predicates"

const payload = {
  actorId: "u-1",
  data: { status: "decided", priority: 80, tags: ["urgent"], nested: { ok: true } },
}

describe("evaluatePredicate", () => {
  it("eq matches", () => {
    expect(evaluatePredicate({ op: "eq", path: "data.status", value: "decided" }, payload)).toBe(
      true,
    )
  })

  it("eq misses", () => {
    expect(evaluatePredicate({ op: "eq", path: "data.status", value: "open" }, payload)).toBe(false)
  })

  it("in matches with numeric value", () => {
    expect(
      evaluatePredicate({ op: "in", path: "data.priority", values: [70, 80, 90] }, payload),
    ).toBe(true)
  })

  it("in misses", () => {
    expect(evaluatePredicate({ op: "in", path: "data.priority", values: [10, 20] }, payload)).toBe(
      false,
    )
  })

  it("exists true for arrays and objects", () => {
    expect(evaluatePredicate({ op: "exists", path: "data.tags" }, payload)).toBe(true)
    expect(evaluatePredicate({ op: "exists", path: "data.nested" }, payload)).toBe(true)
  })

  it("exists false for missing path", () => {
    expect(evaluatePredicate({ op: "exists", path: "data.missing" }, payload)).toBe(false)
  })

  it("and short-circuits on false", () => {
    expect(
      evaluatePredicate(
        {
          op: "and",
          clauses: [
            { op: "eq", path: "data.status", value: "open" },
            { op: "eq", path: "data.priority", value: 80 },
          ],
        },
        payload,
      ),
    ).toBe(false)
  })

  it("and true when all true", () => {
    expect(
      evaluatePredicate(
        {
          op: "and",
          clauses: [
            { op: "eq", path: "data.status", value: "decided" },
            { op: "exists", path: "data.tags" },
          ],
        },
        payload,
      ),
    ).toBe(true)
  })

  it("or matches any clause", () => {
    expect(
      evaluatePredicate(
        {
          op: "or",
          clauses: [
            { op: "eq", path: "data.status", value: "open" },
            { op: "eq", path: "data.priority", value: 80 },
          ],
        },
        payload,
      ),
    ).toBe(true)
  })

  it("not negates", () => {
    expect(
      evaluatePredicate(
        { op: "not", clause: { op: "eq", path: "data.status", value: "open" } },
        payload,
      ),
    ).toBe(true)
  })

  it("unknown op returns false (safe default)", () => {
    expect(evaluatePredicate({ op: "garbage" } as any, payload)).toBe(false)
  })
})
