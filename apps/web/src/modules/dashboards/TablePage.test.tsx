// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ApiContext } from "~/modules/shell/ApiContext"
import type { TableInfo } from "./dashboards-client"
import { TablePage } from "./TablePage"
import { resetTablesStore, tablesList, tableTitle } from "./tables-store"

const TABLE: TableInfo = {
  id: "t1",
  name: "Inbound batches",
  columns: [{ key: "batch", label: "Batch", type: "text", required: true }],
  agentWritesNeedApproval: true,
  orgAccess: "none",
  myRole: "editor",
  rowCount: 1,
  version: 2,
  updatedAt: "2026-11-12T08:00:00Z",
}

function mount() {
  const get = vi.fn(async (path: string) => {
    if (path === "/dashboards/tables/t1") return TABLE
    if (path.startsWith("/dashboards/tables/t1/rows?")) {
      return {
        rows: [
          {
            id: "r1",
            cells: { batch: "B4" },
            version: 1,
            updatedAt: "2026-11-12T08:00:00Z",
            updatedBy: { type: "user", id: "u1", label: "Nico" },
          },
        ],
        nextCursor: null,
      }
    }
    if (path.startsWith("/dashboards/tables/t1/changes?")) {
      return {
        changes: [
          {
            id: "c1",
            rowId: "r1",
            op: "create",
            before: null,
            after: { batch: "B4" },
            actor: { type: "user", id: "u1", label: "Nico" },
            at: "2026-11-12T08:00:00Z",
            undoable: false,
          },
        ],
        nextCursor: null,
      }
    }
    throw new Error(`unexpected ${path}`)
  })
  const getEnvelope = vi.fn(async () => ({ data: [] }))
  const api = { get, getEnvelope } as unknown as ApiClient
  render(() => (
    <ApiContext.Provider value={api}>
      <TablePage entityId="t1" />
    </ApiContext.Provider>
  ))
  return { get }
}

beforeEach(resetTablesStore)
afterEach(cleanup)

describe("TablePage", () => {
  it("names the table, shows the grid, and keeps the table for the tab label and the sidebar", async () => {
    mount()
    await waitFor(() =>
      expect(screen.getByTestId("table-page-title").textContent).toBe("Inbound batches"),
    )
    await screen.findByTestId("table-page-grid-row-r1")
    expect(screen.getByTestId("table-page-tab-grid").getAttribute("aria-selected")).toBe("true")
    expect(tableTitle("t1")).toBe("Inbound batches")
    expect(tablesList().map((t) => t.id)).toEqual(["t1"])
  })

  it("opens Settings and History from the tabs at the top", async () => {
    mount()
    await screen.findByTestId("table-page-grid-row-r1")
    fireEvent.click(screen.getByTestId("table-page-tab-settings"))
    expect(await screen.findByTestId("table-settings")).toBeTruthy()
    expect(screen.getByTestId("table-settings-agent-approval").getAttribute("aria-checked")).toBe(
      "true",
    )
    fireEvent.click(screen.getByTestId("table-page-tab-history"))
    const change = await screen.findByTestId("table-page-history-change-c1")
    expect(change.textContent).toContain("Added the row: B4")
    expect(screen.queryByTestId("table-page-history-undo-c1")).toBeNull()
  })
})
