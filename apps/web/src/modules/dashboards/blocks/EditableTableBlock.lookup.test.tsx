// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A lookup column in the grid: its cells are read-only (no editor, no sort), a failed read says
// so in the column's header, and a saved row keeps the lookup values it was read with.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ApiContext } from "~/modules/shell/ApiContext"
import type { TableInfo, TableRow } from "../dashboards-client"
import { EditableTableBlock } from "./EditableTableBlock"
import { addFormColumns, withLookupCells } from "./table-cells"
import { resetTablePeople } from "./table-people"

const NOW = Date.parse("2026-11-12T12:00:00Z")

const TABLE: TableInfo = {
  id: "t1",
  name: "Stock",
  columns: [
    { key: "item", label: "Item", type: "text" },
    { key: "code", label: "Code", type: "text" },
    {
      key: "stock",
      label: "On hand",
      type: "lookup",
      lookup: {
        source: { tool: "shop:products_search" },
        match: { field: "sku", on: "code" },
        value: "on_hand",
        valueType: "number",
      },
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

function mount(page: { rows: TableRow[]; columnNotes?: Record<string, string> }, write?: unknown) {
  const get = vi.fn(async (path: string) => {
    if (path === "/dashboards/tables/t1") return TABLE
    if (path.startsWith("/dashboards/tables/t1/rows?")) return { nextCursor: null, ...page }
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
  return { post }
}

beforeEach(() => resetTablePeople())
afterEach(cleanup)

describe("a lookup column", () => {
  it("shows its value read-only and cannot be sorted", async () => {
    mount({ rows: [row({ item: "Widget", code: "W-1", stock: 1250 })] })
    const cell = await screen.findByTestId("table-block-lookup-cell-r1-stock")
    expect(cell.textContent).toBe("1,250")
    expect(screen.queryByTestId("table-block-edit-r1-stock")).toBeNull()
    expect(screen.queryByTestId("table-block-sort-stock")).toBeNull()
    expect(screen.getByTestId("table-block-lookup-stock").textContent).toContain("On hand")
    expect(screen.getByTestId("table-block-lookup-stock").title).toContain("shop:products_search")
    expect(screen.queryByTestId("table-block-note-stock")).toBeNull()
  })

  it("says in its header that it is not available when its read failed", async () => {
    mount({
      rows: [row({ item: "Widget", code: "W-1" })],
      columnNotes: { stock: "shop:products_search needs shop:products:read" },
    })
    const note = await screen.findByTestId("table-block-note-stock")
    expect(note.textContent).toBe("Not available")
    expect(note.title).toContain("shop:products:read")
    expect(screen.getByTestId("table-block-lookup-cell-r1-stock").textContent).toBe("")
    // The other cells are there.
    expect(screen.getByTestId("table-block-cell-r1-item").textContent).toBe("Widget")
  })

  it("keeps its value when a saved row comes back without it", async () => {
    const { post } = mount(
      { rows: [row({ item: "Widget", code: "W-1", stock: 12 })] },
      { rows: [row({ item: "Widget 2", code: "W-1" }, 2)] },
    )
    fireEvent.click(await screen.findByTestId("table-block-edit-r1-item"))
    const input = screen.getByTestId("table-block-editor-r1-item") as HTMLInputElement
    input.value = "Widget 2"
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(screen.getByTestId("table-block-cell-r1-item").textContent).toBe("Widget 2"),
    )
    expect(post).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("table-block-lookup-cell-r1-stock").textContent).toBe("12")
  })

  it("is never in the add form, and a row keeps only lookup cells", () => {
    expect(addFormColumns(TABLE.columns).map((c) => c.key)).toEqual(["item", "code"])
    const kept = withLookupCells(TABLE.columns, row({ item: "A", stock: 3 }), row({ item: "B" }, 2))
    expect(kept.cells).toEqual({ item: "B", stock: 3 })
  })
})
