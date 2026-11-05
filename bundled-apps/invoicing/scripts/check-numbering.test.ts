// SPDX-License-Identifier: FSL-1.1-ALv2
//
// G5 — numbering-invariant SQL shape test. Asserts the SQL file ships
// with the gap-proof query shape: a `generate_series` enumeration of the
// expected [MIN, MAX] sequence minus the actual rows (anti-join), which
// catches non-terminal gaps the older MAX - COUNT heuristic missed. The
// full execution against a seeded DB happens at validation protocol step 6
// (manual SQL run), so the unit test pins the SQL text rather than
// instantiating a postgres connection here.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const sql = readFileSync(join(import.meta.dir, "check-numbering.sql"), "utf-8")

describe("check-numbering.sql (Phase 17 G5)", () => {
  it("queries app_invoicing.documents grouped by (issuer, type, year)", () => {
    expect(sql).toMatch(/from\s+app_invoicing\.documents/i)
    expect(sql).toMatch(/group\s+by/i)
    expect(sql).toContain("issuer_profile_id")
    expect(sql).toContain("type")
    expect(sql).toContain("year_of_issue")
  })

  it("enumerates the expected sequence via generate_series over [MIN, MAX](number_int)", () => {
    expect(sql).toMatch(/min\(number_int\)/i)
    expect(sql).toMatch(/max\(number_int\)/i)
    expect(sql).toMatch(/generate_series\s*\(/i)
  })

  it("filters out non-issued (NULL number_int) rows", () => {
    expect(sql).toMatch(/number_int\s+is\s+not\s+null/i)
  })

  it("reports gaps via an anti-join (NOT EXISTS) selecting the missing number", () => {
    expect(sql).toMatch(/where\s+not\s+exists/i)
    expect(sql).toMatch(/as\s+missing_number/i)
  })
})
