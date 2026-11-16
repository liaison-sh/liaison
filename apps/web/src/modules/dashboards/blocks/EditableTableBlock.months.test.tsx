// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A months column in the grid: one sub-column per month it shows, each edited on its own (a
// write names only that month), a quiet "to fill" on a month without a value (0 is a value),
// and cell emphasis (bold in the accent colour) on number and months cells.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ApiContext } from "~/modules/shell/ApiContext"
import type { TableInfo, TableRow } from "../dashboards-client"
import { EditableTableBlock } from "./EditableTableBlock"
import { resetTablePeople } from "./table-people"

const NOW = Date.parse("2026-11-12T12:00:00Z")

const TABLE: TableInfo = {
  id: "t1",
  name: "Parts",
  columns: [
    { key: "item", label: "Item", type: "text" },
    { key: "stock", label: "Stock", type: "number", emphasis: "negative" },
    {
      key: "expected",
      label: "Expected",
      type: "months",
      horizon: 3,
      emphasis: "nonzero",
      months: ["2026-11", "2026-12", "2027-01"],
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
  updatedBy: { type: "user", id: "u1", label: "Ana" },
})

function mount(opts: { table?: TableInfo; write?: (body: unknown) => unknown } = {}) {
  const get = vi.fn(async (path: string) => {
    if (path === "/dashboards/tables/t1") return opts.table ?? TABLE
    if (path.startsWith("/dashboards/tables/t1/rows?")) {
      return {
        rows: [
          row({ item: "Display panel", stock: -4, expected: { "2026-11": 0, "2026-12": 25 } }),
        ],
        nextCursor: null,
      }
    }
    throw new Error(`unexpected GET ${path}`)
  })
  const post = vi.fn(async (_path: string, body: unknown) => opts.write?.(body))
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

describe("EditableTableBlock months column", () => {
  it("shows one sub-column per month, labelled by month name", async () => {
    mount()
    await screen.findByTestId("table-block-row-r1")
    expect(screen.getByTestId("table-block-months-head-expected").textContent).toBe("Expected")
    const heads = screen.getAllByTestId(/^table-block-month-head-expected-/)
    expect(heads.map((h) => h.textContent)).toEqual(["Nov", "Dec", "Jan"])
    expect(screen.getByTestId("table-block-cell-r1-expected-2026-12").textContent).toBe("25")
  })

  it("marks a month without a value 'to fill', never a month holding 0", async () => {
    mount()
    await screen.findByTestId("table-block-row-r1")
    expect(screen.getByTestId("table-block-tofill-r1-expected-2027-01").textContent).toBe("to fill")
    expect(screen.queryByTestId("table-block-tofill-r1-expected-2026-11")).toBeNull()
    expect(screen.getByTestId("table-block-month-r1-expected-2026-11").textContent).toBe("0")
  })

  it("draws emphasised values bold in the accent colour, and only those", async () => {
    mount()
    await screen.findByTestId("table-block-row-r1")
    const dec = screen.getByTestId("table-block-month-r1-expected-2026-12")
    expect(dec.dataset.emphasis).toBe("on")
    expect(dec.className).toContain("text-accent")
    expect(screen.getByTestId("table-block-month-r1-expected-2026-11").dataset.emphasis).toBe(
      undefined,
    )
    const stock = screen.getByTestId("table-block-cell-r1-stock").querySelector("[data-emphasis]")
    expect(stock?.getAttribute("data-emphasis")).toBe("on")
  })

  it("edits one month: the write names only that month", async () => {
    const writes: unknown[] = []
    mount({
      write: (body) => {
        writes.push(body)
        return {
          rows: [
            row(
              {
                item: "Display panel",
                stock: -4,
                expected: { "2026-11": 0, "2026-12": 25, "2027-01": 40 },
              },
              2,
            ),
          ],
        }
      },
    })
    fireEvent.click(await screen.findByTestId("table-block-edit-r1-expected-2027-01"))
    const input = screen.getByTestId("table-block-editor-r1-expected-2027-01") as HTMLInputElement
    input.value = "40"
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(screen.getByTestId("table-block-month-r1-expected-2027-01").textContent).toBe("40"),
    )
    expect(writes).toEqual([
      { ops: [{ op: "update", id: "r1", ifVersion: 1, cells: { expected: { "2027-01": 40 } } }] },
    ])
  })

  it("clears a month from an emptied input", async () => {
    const writes: unknown[] = []
    mount({
      write: (body) => {
        writes.push(body)
        return { rows: [row({ item: "Display panel", stock: -4, expected: { "2026-11": 0 } }, 2)] }
      },
    })
    fireEvent.click(await screen.findByTestId("table-block-edit-r1-expected-2026-12"))
    const input = screen.getByTestId("table-block-editor-r1-expected-2026-12") as HTMLInputElement
    input.value = ""
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toEqual({
      ops: [{ op: "update", id: "r1", ifVersion: 1, cells: { expected: { "2026-12": null } } }],
    })
    await screen.findByTestId("table-block-tofill-r1-expected-2026-12")
  })
})
