// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Rollup columns and links to another table's rows in the grid: a rollup is read-only (no
// editor, no sort), a rollup by month takes one grid column per month like a months column (a
// month without rows reads empty, never "to fill"), emphasis applies, a failed read says so in
// the header, and a link to a deleted row reads quietly struck through.
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ApiContext } from "~/modules/shell/ApiContext"
import type { TableInfo, TableRow } from "../dashboards-client"
import { EditableTableBlock } from "./EditableTableBlock"
import { addFormColumns, isMonthly, withLookupCells } from "./table-cells"
import { resetTablePeople } from "./table-people"

const NOW = Date.parse("2026-11-12T12:00:00Z")
const LOTS = "22222222-2222-4222-8222-222222222222"
const PARTS = "11111111-1111-4111-8111-111111111111"

const TABLE: TableInfo = {
  id: "t1",
  name: "Parts",
  columns: [
    { key: "item", label: "Item", type: "text" },
    {
      key: "kit",
      label: "Kit",
      type: "link",
      linkTo: { app: "kernel", entityType: "table_row", table: PARTS },
    },
    {
      key: "ordered",
      label: "Ordered",
      type: "rollup",
      emphasis: "nonzero",
      rollup: { table: LOTS, link: "part", value: "qty", agg: "sum" },
    },
    {
      key: "expected",
      label: "Expected",
      type: "rollup",
      horizon: 2,
      months: ["2026-11", "2026-12"],
      rollup: { table: LOTS, link: "part", value: "qty", agg: "sum", byMonth: "eta" },
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

function mount(page: { rows: TableRow[]; columnNotes?: Record<string, string> }) {
  const get = vi.fn(async (path: string) => {
    if (path === "/dashboards/tables/t1") return TABLE
    if (path.startsWith("/dashboards/tables/t1/rows?")) return { nextCursor: null, ...page }
    throw new Error(`unexpected GET ${path}`)
  })
  const api = {
    get,
    post: vi.fn(),
    getEnvelope: vi.fn(async () => ({ data: [] })),
  } as unknown as ApiClient
  render(() => (
    <ApiContext.Provider value={api}>
      <EditableTableBlock tableId="t1" now={NOW} />
    </ApiContext.Provider>
  ))
}

beforeEach(() => resetTablePeople())
afterEach(cleanup)

describe("a rollup column", () => {
  it("shows its number read-only, with emphasis, and cannot be sorted", async () => {
    mount({ rows: [row({ item: "Display panel", ordered: 55, expected: { "2026-11": 40 } })] })
    const cell = await screen.findByTestId("table-block-rollup-cell-r1-ordered")
    expect(cell.textContent).toBe("55")
    expect(cell.querySelector("[data-emphasis='on']")).not.toBeNull()
    expect(screen.queryByTestId("table-block-edit-r1-ordered")).toBeNull()
    expect(screen.queryByTestId("table-block-sort-ordered")).toBeNull()
    expect(screen.getByTestId("table-block-rollup-ordered").title).toContain("qty")
  })

  it("by month: one read-only grid column per month, an empty month reads empty", async () => {
    mount({ rows: [row({ item: "Display panel", ordered: 0, expected: { "2026-11": 40 } })] })
    expect(await screen.findByTestId("table-block-months-head-expected")).toBeTruthy()
    expect(screen.getByTestId("table-block-month-head-expected-2026-12")).toBeTruthy()
    expect(screen.getByTestId("table-block-month-r1-expected-2026-11").textContent).toBe("40")
    expect(screen.getByTestId("table-block-cell-r1-expected-2026-12").textContent).toBe("")
    expect(screen.queryByTestId("table-block-tofill-r1-expected-2026-12")).toBeNull()
    expect(screen.queryByTestId("table-block-edit-r1-expected-2026-11")).toBeNull()
    // 0 is a value that does not stand out under nonzero.
    const zero = screen.getByTestId("table-block-rollup-cell-r1-ordered")
    expect(zero.textContent).toBe("0")
    expect(zero.querySelector("[data-emphasis='on']")).toBeNull()
  })

  it("says in its header that it is not available when the reader cannot read the table", async () => {
    mount({
      rows: [row({ item: "Display panel" })],
      columnNotes: { ordered: "you cannot read the table", expected: "you cannot read the table" },
    })
    const note = await screen.findByTestId("table-block-note-ordered")
    expect(note.textContent).toBe("Not available")
    expect(note.title).toContain("cannot read")
    expect(screen.getByTestId("table-block-note-expected").textContent).toBe("Not available")
  })

  it("is never in the add form, and a saved row keeps its rollup cells", () => {
    expect(addFormColumns(TABLE.columns).map((c) => c.key)).toEqual(["item", "kit"])
    expect(isMonthly(TABLE.columns[3]!)).toBe(true)
    expect(isMonthly(TABLE.columns[2]!)).toBe(false)
    const kept = withLookupCells(
      TABLE.columns,
      row({ item: "A", ordered: 3 }),
      row({ item: "B" }, 2),
    )
    expect(kept.cells).toEqual({ item: "B", ordered: 3 })
  })
})

describe("a link to another table's row", () => {
  it("reads as the row's label; a deleted row reads struck through", async () => {
    mount({
      rows: [
        row({
          item: "Widget",
          kit: { app: "kernel", entityType: "table_row", id: "x1", label: "Kit A", missing: true },
        }),
      ],
    })
    const link = await screen.findByTestId("table-block-rowlink-r1-kit")
    expect(link.textContent).toBe("Kit A")
    expect(link.dataset.missing).toBe("true")
    expect(link.title).toBe("This row was deleted")
    expect(screen.queryByTestId("table-block-open-r1-kit")).toBeNull()
  })
})
