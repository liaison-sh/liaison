// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A formula column in the grid: read-only (no editor, no sort), a number formula as one cell
// with its emphasis, a months-shaped one as one sub-column per month with no "to fill" marker,
// and a saved row reads the page again for the formulas the write changed.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ApiContext } from "~/modules/shell/ApiContext"
import type { TableInfo, TableRow } from "../dashboards-client"
import { EditableTableBlock } from "./EditableTableBlock"
import { addFormColumns, cellText } from "./table-cells"
import { resetTablePeople } from "./table-people"

const NOW = Date.parse("2026-11-12T12:00:00Z")
const MONTHS = ["2026-11", "2026-12", "2027-01"]

const TABLE: TableInfo = {
  id: "t1",
  name: "Stock",
  columns: [
    { key: "item", label: "Item", type: "text" },
    { key: "stock", label: "Stock", type: "number" },
    {
      key: "free",
      label: "Free",
      type: "formula",
      formula: { expr: "stock - 10" },
      emphasis: "negative",
    },
    {
      key: "projected",
      label: "Projected",
      type: "formula",
      formula: { expr: "stock + cumsum(expected)" },
      months: MONTHS,
    },
  ],
  agentWritesNeedApproval: false,
  orgAccess: "viewer",
  myRole: "editor",
  rowCount: 1,
  version: 1,
  updatedAt: "2026-11-12T08:00:00Z",
  droppedKeys: [],
}

const row = (cells: Record<string, unknown>, version = 1): TableRow => ({
  id: "r1",
  cells,
  version,
  updatedAt: "2026-11-12T11:56:00Z",
  updatedBy: { type: "user", id: "u1", label: "Nico" },
})

function mount(pages: TableRow[][], write?: unknown) {
  let reads = 0
  const get = vi.fn(async (path: string) => {
    if (path === "/dashboards/tables/t1") return TABLE
    if (path.startsWith("/dashboards/tables/t1/rows?")) {
      const rows = pages[Math.min(reads, pages.length - 1)]!
      reads++
      return { nextCursor: null, rows }
    }
    throw new Error(`unexpected GET ${path}`)
  })
  const post = vi.fn(async () => write)
  const getEnvelope = vi.fn(async () => ({ data: [] }))
  const api = { get, post, getEnvelope } as unknown as ApiClient
  render(() => (
    <ApiContext.Provider value={api}>
      <EditableTableBlock tableId="t1" now={NOW} />
    </ApiContext.Provider>
  ))
  return { post, reads: () => reads }
}

beforeEach(() => resetTablePeople())
afterEach(cleanup)

describe("a formula column", () => {
  it("shows a number read-only, with its emphasis, and cannot be sorted", async () => {
    mount([[row({ item: "Widget", stock: 4, free: -6 })]])
    const cell = await screen.findByTestId("table-block-formula-cell-r1-free")
    expect(cell.textContent).toBe("-6")
    expect(cell.querySelector("[data-emphasis='on']")).not.toBeNull()
    expect(screen.queryByTestId("table-block-edit-r1-free")).toBeNull()
    expect(screen.queryByTestId("table-block-sort-free")).toBeNull()
    expect(screen.getByTestId("table-block-formula-free").title).toContain("stock - 10")
  })

  it("shows a months-shaped formula month by month, read-only, an empty month with no to-fill marker", async () => {
    mount([[row({ item: "Widget", stock: 4, projected: { "2026-11": 14, "2027-01": 18 } })]])
    expect((await screen.findByTestId("table-block-month-r1-projected-2026-11")).textContent).toBe(
      "14",
    )
    expect(screen.getByTestId("table-block-month-r1-projected-2027-01").textContent).toBe("18")
    expect(screen.queryByTestId("table-block-tofill-r1-projected-2026-12")).toBeNull()
    expect(screen.queryByTestId("table-block-edit-r1-projected-2026-11")).toBeNull()
    expect(screen.getByTestId("table-block-months-head-projected").textContent).toContain(
      "Projected",
    )
  })

  it("reads the page again after a saved row, for the formulas it changed", async () => {
    const { post, reads } = mount(
      [
        [row({ item: "Widget", stock: 4, free: -6 })],
        [row({ item: "Widget", stock: 15, free: 5 }, 2)],
      ],
      { rows: [row({ item: "Widget", stock: 15 }, 2)] },
    )
    fireEvent.click(await screen.findByTestId("table-block-edit-r1-stock"))
    const input = screen.getByTestId("table-block-editor-r1-stock") as HTMLInputElement
    input.value = "15"
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(screen.getByTestId("table-block-formula-cell-r1-free").textContent).toBe("5"),
    )
    expect(post).toHaveBeenCalledTimes(1)
    expect(reads()).toBeGreaterThanOrEqual(2)
  })

  it("is never in the add form; its text reads a number or its months", () => {
    expect(addFormColumns(TABLE.columns).map((c) => c.key)).toEqual(["item", "stock"])
    const t = (k: string) => k
    const projected = TABLE.columns[3]!
    expect(cellText(projected, { "2026-11": 3 }, { locale: "en", t })).toBe("Nov 2026: 3")
    expect(cellText(TABLE.columns[2]!, 1200, { locale: "en", t })).toBe("1,200")
  })
})
