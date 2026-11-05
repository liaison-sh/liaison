// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The split-order link, rendered. The Shopify auto-flow splits a mixed order
// into a goods invoice and a software invoice; the documents list keeps the
// two halves adjacent AND draws them as one block: a shared tint, no divider
// between them, and a bracket down their leading edge. The move onto the
// shared CardTable kept the adjacency but dropped the whole visual link, so
// the two rows read as unrelated neighbours. These tests render the real
// DataTable over real pairSplitDocuments output, in both CardTable variants.
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ALL_SALES_COLUMNS } from "./columns"
import { DataTable } from "./DataTable"
import { pairSplitDocuments } from "./pair-split"
import type { DocumentRow } from "./types"

vi.mock("@liaison/host", () => ({
  navigate: () => {},
  hostLocale: () => "en",
}))

function row(id: string, number: string, order: string | null, scope: string | null): DocumentRow {
  return {
    id,
    number,
    type: "invoice",
    status: "paid",
    issued_at: "2026-09-01T10:00:00Z",
    counterparty_name: "Ada Lovelace",
    grand_total_minor: 10000,
    currency: "EUR",
    shopify_order_number: order,
    scope,
  } as unknown as DocumentRow
}

// The halves are NOT adjacent on input (another invoice issued in between),
// exactly the shape seen on prod.
const ROWS: DocumentRow[] = [
  row("g", "INV-2026-0001", "#1001", "goods"),
  row("x", "INV-2026-0002", "#1002", null),
  row("s", "INV-2026-0003", "#1001", "software"),
]

function stubViewport(phone: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: phone || query.includes("1023"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  )
  window.matchMedia = globalThis.matchMedia
}

function renderList() {
  const paired = pairSplitDocuments(ROWS)
  const pairing = (r: DocumentRow) => {
    const hit = paired.find((p) => p.row.id === r.id)
    return hit?.pairKey ? { key: hit.pairKey, position: hit.position } : null
  }
  render(() => (
    <DataTable
      columns={ALL_SALES_COLUMNS}
      rows={paired.map((p) => p.row)}
      emptyState="none"
      testid="t"
      pairing={pairing}
    />
  ))
}

/** The row element (tr or card root) that holds a given document number. */
function rowOf(number: string): HTMLElement {
  const el = screen.getByText(number).closest("[data-row-key]")
  if (!el) throw new Error(`no row for ${number}`)
  return el as HTMLElement
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe.each([
  ["table", false],
  ["card", true],
])("split-order link in the %s variant", (_variant, phone) => {
  it("draws a bracket on both halves, turning in at the top of the first and the bottom of the last", () => {
    stubViewport(phone)
    renderList()
    const goods = rowOf("INV-2026-0001")
    const software = rowOf("INV-2026-0003")
    const goodsBracket = goods.querySelector('[data-testid="invoicing-pair-bracket"]')
    const softwareBracket = software.querySelector('[data-testid="invoicing-pair-bracket"]')
    expect(goodsBracket?.className).toContain("border-t-2")
    expect(goodsBracket?.className).toContain("top-1/2")
    expect(softwareBracket?.className).toContain("border-b-2")
    expect(softwareBracket?.className).toContain("bottom-1/2")
    // Positioned against the row, not some ancestor far up the page.
    expect(goodsBracket?.parentElement?.className).toContain("relative")
  })

  it("tints the pair as one block and suppresses only the divider between its members", () => {
    stubViewport(phone)
    renderList()
    const goods = rowOf("INV-2026-0001")
    const software = rowOf("INV-2026-0003")
    expect(goods.className).toContain("bg-accent/[0.055]")
    expect(software.className).toContain("bg-accent/[0.055]")
    expect(goods.className).toContain("border-b-transparent")
    expect(software.className).not.toContain("border-b-transparent")
    expect(goods.getAttribute("data-pair-position")).toBe("first")
    expect(software.getAttribute("data-pair-position")).toBe("last")
    expect(goods.getAttribute("data-pair-key")).toBe("#1001")
  })

  it("leaves an unpaired document plain", () => {
    stubViewport(phone)
    renderList()
    const other = rowOf("INV-2026-0002")
    expect(other.querySelector('[data-testid="invoicing-pair-bracket"]')).toBeNull()
    expect(other.className).not.toContain("bg-accent/[0.055]")
    expect(other.hasAttribute("data-pair-key")).toBe(false)
  })
})
