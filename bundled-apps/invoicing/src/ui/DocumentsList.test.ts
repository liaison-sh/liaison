// SPDX-License-Identifier: FSL-1.1-ALv2
//
// DocumentsList rowHref wiring — bundled-app suites use bun:test (no jsdom),
// so the rendered <DataTable rowHref=.../> call is pinned via source grep
// (mirrors dashboards.test.ts's "module surface" pattern). Grouped rollup
// rows (customer/market) are aggregates with no real document id, so rowHref
// must be undefined outside flat/List mode.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { FULL_LIST_MIN_VIEWPORT, LIST_COLUMNS, listColumnsForWidth } from "./DocumentsList"
import { searchPlaceholder } from "./dashboards/Toolbar"

const source = readFileSync(join(import.meta.dir, "DocumentsList.tsx"), "utf-8")

describe("DocumentsList rowHref (Phase 17 — list → detail navigation)", () => {
  it("passes rowHref to DataTable, gated on flat group mode", () => {
    expect(source).toMatch(/rowHref=\{\s*group\(\) === "flat"/)
    expect(source).toContain("`/invoicing/document/${r.id}`")
    // The row primes the tab-label registry so the detail tab opens named
    // after the document number.
    expect(source).toContain("rememberDocumentLabel(r.id, r.number")
  })

  it("does not unconditionally link every row (grouped rollups must stay inert)", () => {
    // A naive `rowHref={(r) => ...}` with no group() guard would make the
    // customer/market rollup rows clickable too — those rows' `id` is a
    // synthetic group key, not a real document id.
    expect(source).not.toMatch(/rowHref=\{\(r\) => `\/invoicing\/document/)
  })

  it("has no drafts filter key or noun, and always strips draft rows client-side", () => {
    // Draft is not a user-facing document category: no Drafts tab, no
    // draftsOnly resource key, and every tab hides draft rows.
    expect(source).not.toContain("draftsOnly")
    expect(source).not.toMatch(/drafts:\s*"drafts"/)
    expect(source).not.toContain('status: "draft"')
    expect(source).toContain("filterRowsForTab(applyFilter(rows, f), false)")
  })

  it("wires the credit-notes sidebar segment to type='credit_note' (0.5.0)", () => {
    expect(source).toMatch(/"credit-notes":\s*"credit_note"/)
    // The footer noun carries singular and plural forms (0.20.19).
    expect(source).toMatch(
      /"credit-notes":\s*\{\s*one:\s*"credit note",\s*other:\s*"credit notes"\s*\}/,
    )
  })

  // ── Payment column (feature 1 — list surfaces a synced Shopify invoice's
  // payment_status so it reads "Paid", not just "Issued") ──────────────────
  it("appends a Payment column to the flat List view without mutating ALL_SALES_COLUMNS", () => {
    expect(source).toContain('key: "payment"')
    expect(source).toContain('label: "Payment"')
    expect(source).toMatch(/\.\.\.ALL_SALES_COLUMNS,\s*PAYMENT_COLUMN\b/)
  })

  // red: drop the PO number column addition -> a document carrying a PO number is
  // indistinguishable from one without it until an operator opens each row.
  it("appends a PO number column to the flat List view without mutating ALL_SALES_COLUMNS", () => {
    expect(source).toContain('key: "po_number"')
    expect(source).toContain('label: "PO number"')
    expect(source).toMatch(/\.\.\.ALL_SALES_COLUMNS,\s*PAYMENT_COLUMN,\s*PO_NUMBER_COLUMN\b/)
  })

  it("only the flat group mode uses LIST_COLUMNS; customer/market keep their own column sets", () => {
    expect(source).toContain('group() === "customer"')
    expect(source).toContain("B2B_COLUMNS")
    expect(source).toContain("BY_MARKET_COLUMNS")
    // The flat mode is the only one that narrows, and it narrows LIST_COLUMNS.
    expect(source).toContain("listColumnsForWidth(")
  })
})

// ── The table was 68 px wider than its own pane at 1440 ──────────────────
//
// CardTable keeps a 7.5rem floor under every visible column, so the flat
// list's ten columns ask for 1200 px while the documents pane at a 1440 px
// window is about 1130. The container scrolls sideways with no affordance, so
// the last column (PO number) was simply not on screen and nothing said it was
// anywhere else.
describe("DocumentsList column width (the PO number column was off screen at 1440)", () => {
  const MIN_COLUMN_PX = 7.5 * 16
  /** The documents pane at a given window: the shell's activity bar and
   *  sidebar take a little over 300 px of it. */
  const paneWidth = (viewport: number) => viewport - 308

  it("fits inside the pane at 1440, with the PO number column still drawn", () => {
    const cols = listColumnsForWidth(1440)
    expect(cols.map((c) => c.key)).toContain("po_number")
    expect(cols.length * MIN_COLUMN_PX).toBeLessThanOrEqual(paneWidth(1440))
  })

  it("gives up the channel column, and only that one", () => {
    const wide = listColumnsForWidth(1920).map((c) => c.key)
    const narrow = listColumnsForWidth(1440).map((c) => c.key)
    expect(wide.filter((k) => !narrow.includes(k))).toEqual(["channel"])
  })

  it("keeps every column once the window is wide enough for all of them", () => {
    expect(listColumnsForWidth(FULL_LIST_MIN_VIEWPORT)).toEqual(LIST_COLUMNS)
    expect(LIST_COLUMNS.length * MIN_COLUMN_PX).toBeLessThanOrEqual(
      paneWidth(FULL_LIST_MIN_VIEWPORT),
    )
  })

  it("exports every column to CSV whatever the window is doing", () => {
    // A narrow window is a drawing constraint, not an export one.
    expect(source).toContain("toCsv(csvColumns(), rows())")
    expect(source).toMatch(/csvColumns[\s\S]{0,200}LIST_COLUMNS/)
  })
})

// The phone toolbar's search box shares its line with the Filters disclosure,
// and the desktop hint was cut mid word there.
describe("Toolbar search placeholder", () => {
  it("is short enough to survive the phone toolbar", () => {
    expect(searchPlaceholder(true)).toBe("Search")
    expect(searchPlaceholder(true).length).toBeLessThanOrEqual(10)
  })

  it("keeps the full hint wherever there is room for it", () => {
    expect(searchPlaceholder(false)).toBe("Search number or customer")
  })

  it("is wired to the box, not hardcoded on it", () => {
    const toolbar = readFileSync(join(import.meta.dir, "dashboards/Toolbar.tsx"), "utf-8")
    expect(toolbar).toContain("placeholder={searchPlaceholder(isPhone())}")
    expect(toolbar).not.toContain('placeholder="Search number or customer"')
  })
})
