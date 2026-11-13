// SPDX-License-Identifier: FSL-1.1-ALv2
// Every CSV export neutralises spreadsheet formulas the same way. The bundled invoicing app cannot
// import @liaison/shared, so its copy is pinned to it here.
import { describe, expect, test } from "bun:test"
import { csvCell } from "@liaison/shared"
import { csvCell as invoicingCsvCell } from "../../../../../bundled-apps/invoicing/src/csv"

const VECTORS: unknown[] = [
  "plain",
  "=1+1",
  "+1",
  "-1+1",
  "@SUM(A1)",
  "\tx",
  "\rx",
  "-5000",
  "-12.50",
  'a,"b"',
  "line\nbreak",
  "cr\rinside",
  null,
  undefined,
  42,
]

describe("csv cell escaper", () => {
  test("formula starters get a single-quote prefix, plain numbers stay numeric", () => {
    for (const v of ["=1+1", "+1", "-1+1", "@SUM(A1)", "\tx", "\rx"]) {
      expect(csvCell(v).replace(/^"/, "").startsWith("'")).toBe(true)
    }
    expect(csvCell("-5000")).toBe("-5000")
  })

  test("the bundled invoicing copy matches @liaison/shared", () => {
    for (const v of VECTORS) expect(invoicingCsvCell(v)).toBe(csvCell(v))
  })
})
