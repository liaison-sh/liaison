// SPDX-License-Identifier: FSL-1.1-ALv2
// Every CSV export neutralises spreadsheet formulas the same way. The sandboxed app scripts and the
// bundled invoicing app cannot import @liaison/shared, so their copies are pinned to it here.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
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

function extract(file: string, name: string): (v: unknown) => string {
  const src = readFileSync(join(import.meta.dir, "../..", file), "utf8")
  const start = src.indexOf(`function ${name}(value: unknown): string {`)
  expect(start).toBeGreaterThan(-1)
  const end = src.indexOf("\n}\n", start) + 3
  const body = src
    .slice(start, end)
    .replace(/: unknown/g, "")
    .replace(/\): string/, ")")
  return new Function(`${body}; return ${name}`)()
}

describe("csv cell escaper", () => {
  test("formula starters get a single-quote prefix, plain numbers stay numeric", () => {
    for (const v of ["=1+1", "+1", "-1+1", "@SUM(A1)", "\tx", "\rx"]) {
      expect(csvCell(v).replace(/^"/, "").startsWith("'")).toBe(true)
    }
    expect(csvCell("-5000")).toBe("-5000")
  })

  const copies: Array<[string, (v: unknown) => string]> = [
    ["bundled invoicing", invoicingCsvCell],
    ["mail handlers", extract("apps/mail/handlers.ts", "mailCsvCell")],
    ["knowledge handlers", extract("apps/knowledge/handlers.ts", "knowledgeCsvCell")],
    ["projects handlers", extract("apps/projects/handlers.ts", "projectsCsvCell")],
  ]
  for (const [name, fn] of copies) {
    test(`${name} copy matches @liaison/shared`, () => {
      for (const v of VECTORS) expect(fn(v)).toBe(csvCell(v))
    })
  }
})
