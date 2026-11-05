// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `runsFor` where operators: equality, IS NULL, IS NOT NULL and a set, nothing else.
import { describe, expect, it } from "bun:test"
import { runsForErrors, runsForWhereOp } from "./fanout-runs-for"

describe("runsFor where operators", () => {
  it("reads a value, null, a set and not-null", () => {
    expect(runsForWhereOp("open")).toEqual({ op: "eq", value: "open" })
    expect(runsForWhereOp(null)).toEqual({ op: "null" })
    expect(runsForWhereOp({ in: ["open", 2] })).toEqual({ op: "in", values: ["open", 2] })
    expect(runsForWhereOp({ not: null })).toEqual({ op: "notNull" })
  })

  it("refuses an empty or oversized set and any other operator", () => {
    expect(typeof runsForWhereOp({ in: [] })).toBe("string")
    expect(typeof runsForWhereOp({ in: Array.from({ length: 51 }, (_, i) => i) })).toBe("string")
    expect(typeof runsForWhereOp({ notIn: ["EUR"] })).toBe("string")
  })

  it("a manifest using an unknown operator is refused", () => {
    const manifest = {
      name: "demo",
      schema: { documents: { fields: { currency: { type: "string" } } } },
      jobs: {
        rates: {
          handler: "h",
          schedule: "0 * * * *",
          runsFor: { rows: { entity: "documents", where: { currency: { notIn: ["EUR"] } } } },
        },
      },
    }
    expect(runsForErrors(manifest, { requireDeclared: true }).length).toBeGreaterThan(0)
  })
})
