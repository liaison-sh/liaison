// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { ApiContext } from "~/modules/shell/ApiContext"
import type { TableInfo, TableRow } from "../dashboards-client"
import { handleTableEvent } from "../tables-store"
import { EditableTableBlock } from "./EditableTableBlock"
import { resetTablePeople } from "./table-people"

const NOW = Date.parse("2026-11-12T12:00:00Z")

const TABLE: TableInfo = {
  id: "t1",
  name: "Inbound batches",
  columns: [
    { key: "batch", label: "Batch", type: "text", required: true },
    { key: "units", label: "Units", type: "number", required: true },
    {
      key: "status",
      label: "Status",
      type: "choice",
      choices: ["Planned", "In transit", "Arrived"],
    },
    { key: "eta", label: "ETA", type: "date" },
    { key: "checked", label: "Checked", type: "checkbox" },
  ],
  agentWritesNeedApproval: false,
  orgAccess: "viewer",
  myRole: "editor",
  rowCount: 2,
  version: 1,
  updatedAt: "2026-11-12T08:00:00Z",
  droppedKeys: [],
}

const row = (
  id: string,
  cells: Record<string, unknown>,
  extra: Partial<TableRow> = {},
): TableRow => ({
  id,
  cells,
  version: 1,
  updatedAt: "2026-11-12T11:56:00Z",
  updatedBy: { type: "agent", id: "a1", label: "@logistics" },
  ...extra,
})

const ROWS = [
  row("r1", { batch: "B4", units: 200, status: "In transit", eta: "2026-11-18", checked: false }),
  row("r2", { batch: "B5", units: 300, status: "Planned" }, { updatedAt: "2026-10-01T09:00:00Z" }),
]

interface Mock {
  table?: TableInfo | (() => TableInfo)
  rows?: (query: URLSearchParams) => { rows: TableRow[]; nextCursor: string | null }
  write?: (body: { ops: Array<Record<string, unknown>> }) => unknown
  changes?: () => unknown
  undo?: () => unknown
}

function mount(m: Mock = {}, props: Partial<Parameters<typeof EditableTableBlock>[0]> = {}) {
  // The api client hands back the envelope's payload.
  const get = vi.fn(async (path: string) => getBody(path))
  const post = vi.fn(async (path: string, body: unknown) => postBody(path, body))
  async function getBody(path: string): Promise<unknown> {
    if (path === "/dashboards/tables/t1")
      return typeof m.table === "function" ? m.table() : (m.table ?? TABLE)
    if (path.startsWith("/dashboards/tables/t1/rows?")) {
      const q = new URLSearchParams(path.split("?")[1])
      return m.rows ? m.rows(q) : { rows: ROWS, nextCursor: null }
    }
    if (path.startsWith("/dashboards/tables/t1/changes?"))
      return m.changes ? m.changes() : { changes: [], nextCursor: null }
    throw new Error(`unexpected GET ${path}`)
  }
  async function postBody(path: string, body: unknown): Promise<unknown> {
    if (path === "/dashboards/tables/t1/rows")
      return m.write?.(body as { ops: Array<Record<string, unknown>> })
    if (path.endsWith("/undo")) return m.undo?.()
    throw new Error(`unexpected POST ${path}`)
  }
  const getEnvelope = vi.fn(async () => ({ data: [{ id: "u1", name: "Nico", email: "n@x.test" }] }))
  const api = { get, post, getEnvelope } as unknown as ApiClient
  render(() => (
    <ApiContext.Provider value={api}>
      <EditableTableBlock tableId="t1" now={NOW} {...props} />
    </ApiContext.Provider>
  ))
  return { get, post }
}

const block = () => screen.getByTestId("table-block")

beforeEach(() => resetTablePeople())
afterEach(cleanup)

describe("EditableTableBlock", () => {
  it("loads, then shows the rows with who changed each and when", async () => {
    mount()
    expect(block().dataset.state).toBe("loading")
    expect(screen.getByTestId("table-block-loading")).toBeTruthy()
    await screen.findByTestId("table-block-row-r1")
    expect(screen.getByTestId("table-block-cell-r1-batch").textContent).toBe("B4")
    expect(screen.getByTestId("table-block-cell-r1-status").textContent).toBe("In transit")
    expect(screen.getByTestId("table-block-cell-r1-eta").textContent).toBe("Nov 18, 2026")
    expect(screen.getByTestId("table-block-history-r1").textContent).toBe("@logistics · 4 min. ago")
    expect(screen.getByTestId("table-block-count").textContent).toBe("2 rows")
  })

  it("shows only the map's columns, in its order", async () => {
    mount({}, { columns: ["status", "batch"] })
    await screen.findByTestId("table-block-row-r1")
    const headers = screen.getAllByTestId(/^table-block-sort-/).map((h) => h.dataset.testid)
    expect(headers).toEqual(["table-block-sort-status", "table-block-sort-batch"])
  })

  it("edits a text cell in place and shows the saved row", async () => {
    const { post } = mount({
      write: () => ({
        rows: [
          row(
            "r1",
            { ...ROWS[0]?.cells, batch: "B4a" },
            {
              version: 2,
              updatedBy: { type: "user", id: "me", label: "You" },
              updatedAt: "2026-11-12T12:00:00Z",
            },
          ),
        ],
      }),
    })
    fireEvent.click(await screen.findByTestId("table-block-edit-r1-batch"))
    const input = screen.getByTestId("table-block-editor-r1-batch") as HTMLInputElement
    input.value = "B4a"
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(screen.getByTestId("table-block-cell-r1-batch").textContent).toBe("B4a"),
    )
    expect(post).toHaveBeenCalledWith(
      "/dashboards/tables/t1/rows",
      { ops: [{ op: "update", id: "r1", ifVersion: 1, cells: { batch: "B4a" } }] },
      expect.anything(),
    )
    expect(screen.getByTestId("table-block-history-r1").textContent).toContain("You")
  })

  it("refuses a word in a number cell before sending it, and Escape leaves the cell as it was", async () => {
    const { post } = mount()
    fireEvent.click(await screen.findByTestId("table-block-edit-r1-units"))
    const input = screen.getByTestId("table-block-editor-r1-units") as HTMLInputElement
    input.value = "lots"
    fireEvent.keyDown(input, { key: "Enter" })
    expect(screen.getByTestId("table-block-notice-r1").textContent).toBe("Units needs a number.")
    fireEvent.click(screen.getByTestId("table-block-edit-r1-units"))
    fireEvent.keyDown(screen.getByTestId("table-block-editor-r1-units"), { key: "Escape" })
    expect(screen.queryByTestId("table-block-editor-r1-units")).toBeNull()
    expect(post).not.toHaveBeenCalled()
  })

  it("picks a choice from its chips", async () => {
    const { post } = mount({
      write: () => ({
        rows: [row("r1", { ...ROWS[0]?.cells, status: "Arrived" }, { version: 2 })],
      }),
    })
    fireEvent.click(await screen.findByTestId("table-block-edit-r1-status"))
    fireEvent.click(screen.getByTestId("table-block-editor-r1-status-choice-2"))
    await waitFor(() =>
      expect(screen.getByTestId("table-block-cell-r1-status").textContent).toBe("Arrived"),
    )
    expect(post.mock.calls[0]?.[1]).toEqual({
      ops: [{ op: "update", id: "r1", ifVersion: 1, cells: { status: "Arrived" } }],
    })
  })

  it("toggles a checkbox in place", async () => {
    const { post } = mount({
      write: () => ({ rows: [row("r1", { ...ROWS[0]?.cells, checked: true }, { version: 2 })] }),
    })
    fireEvent.click(await screen.findByTestId("table-block-check-r1-checked"))
    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(post.mock.calls[0]?.[1]).toEqual({
      ops: [{ op: "update", id: "r1", ifVersion: 1, cells: { checked: true } }],
    })
  })

  it("on a version conflict reloads the row and says who changed it", async () => {
    let reads = 0
    mount({
      rows: () => {
        reads++
        return {
          rows:
            reads === 1
              ? ROWS
              : [
                  row(
                    "r1",
                    { ...ROWS[0]?.cells, batch: "B4-nico" },
                    { version: 2, updatedBy: { type: "user", id: "u1", label: "Nico" } },
                  ),
                  ROWS[1] as TableRow,
                ],
          nextCursor: null,
        }
      },
      write: () => {
        throw new ApiError("stale", 409, "version_conflict")
      },
    })
    fireEvent.click(await screen.findByTestId("table-block-edit-r1-batch"))
    const input = screen.getByTestId("table-block-editor-r1-batch") as HTMLInputElement
    input.value = "B4b"
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(screen.getByTestId("table-block-notice-r1").textContent).toBe(
        "Changed by Nico just now: the row shows their version.",
      ),
    )
    expect(screen.getByTestId("table-block-cell-r1-batch").textContent).toBe("B4-nico")
  })

  it("adds a row from the form, required columns first, and refuses a missing one", async () => {
    const { post } = mount({
      write: () => ({
        rows: [
          row(
            "r3",
            { batch: "B6", units: 120 },
            { updatedBy: { type: "user", id: "me", label: "You" } },
          ),
        ],
      }),
    })
    fireEvent.click(await screen.findByTestId("table-block-add"))
    const form = screen.getByTestId("table-block-add-form")
    const fields = [...form.querySelectorAll("[data-testid^='table-block-add-']")]
      .map((e) => (e as HTMLElement).dataset.testid)
      .filter((id) => id && !/-(save|cancel|error|form)$/.test(id) && !/-choice-/.test(id))
    expect(fields.slice(0, 2)).toEqual(["table-block-add-batch", "table-block-add-units"])
    fireEvent.input(screen.getByTestId("table-block-add-batch"), { target: { value: "B6" } })
    fireEvent.click(screen.getByTestId("table-block-add-save"))
    expect(screen.getByTestId("table-block-add-error").textContent).toBe("Units is required.")
    expect(post).not.toHaveBeenCalled()
    fireEvent.input(screen.getByTestId("table-block-add-units"), { target: { value: "120" } })
    fireEvent.click(screen.getByTestId("table-block-add-save"))
    await screen.findByTestId("table-block-row-r3")
    expect(post.mock.calls[0]?.[1]).toEqual({
      ops: [{ op: "add", cells: { batch: "B6", units: 120 } }],
    })
    expect(screen.queryByTestId("table-block-add-form")).toBeNull()
    expect(screen.getByTestId("table-block-count").textContent).toBe("3 rows")
  })

  it("deletes a row only after the confirm", async () => {
    const { post } = mount({ write: () => ({ rows: [{ id: "r2", deleted: true }] }) })
    fireEvent.click(await screen.findByTestId("table-block-delete-r2"))
    fireEvent.click(await screen.findByTestId("table-block-delete-dialog-cancel"))
    expect(post).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("table-block-delete-r2"))
    fireEvent.click(await screen.findByTestId("table-block-delete-dialog-confirm"))
    await waitFor(() => expect(screen.queryByTestId("table-block-row-r2")).toBeNull())
    expect(post.mock.calls[0]?.[1]).toEqual({ ops: [{ op: "delete", id: "r2", ifVersion: 1 }] })
  })

  it("is read-only for a viewer", async () => {
    mount({ table: { ...TABLE, myRole: "viewer" } })
    await screen.findByTestId("table-block-row-r1")
    expect(screen.queryByTestId("table-block-edit-r1-batch")).toBeNull()
    expect(screen.queryByTestId("table-block-delete-r1")).toBeNull()
    expect(screen.queryByTestId("table-block-add")).toBeNull()
    expect((screen.getByTestId("table-block-check-r1-checked") as HTMLInputElement).disabled).toBe(
      true,
    )
    expect(screen.getByTestId("table-block-count").textContent).toContain("view only")
  })

  it("an empty table says so in one line with Add", async () => {
    mount({ rows: () => ({ rows: [], nextCursor: null }), table: { ...TABLE, rowCount: 0 } })
    const empty = await screen.findByTestId("table-block-empty")
    expect(empty.textContent).toContain("No rows yet.")
    fireEvent.click(screen.getByTestId("table-block-add"))
    expect(screen.getByTestId("table-block-add-form")).toBeTruthy()
  })

  it("a failed read says so and retries", async () => {
    let fail = true
    mount({
      table: () => {
        if (fail) throw new ApiError("down", 500)
        return TABLE
      },
    })
    const err = await screen.findByTestId("table-block-error")
    expect(err.dataset.error).toBe("error")
    fail = false
    fireEvent.click(screen.getByTestId("table-block-retry"))
    await screen.findByTestId("table-block-row-r1")
  })

  it("a table that is gone or not shared reads as not found, without a retry", async () => {
    mount({
      table: () => {
        throw new ApiError("nope", 404)
      },
    })
    const err = await screen.findByTestId("table-block-error")
    expect(err.dataset.error).toBe("not_found")
    expect(screen.queryByTestId("table-block-retry")).toBeNull()
  })

  it("pages by 50 with the cursor and sorts by a column", async () => {
    const { get } = mount({
      rows: (q) => ({
        rows: q.get("cursor") === "c2" ? [row("r51", { batch: "B51", units: 1 })] : ROWS,
        nextCursor: q.get("cursor") === "c2" ? null : "c2",
      }),
    })
    await screen.findByTestId("table-block-row-r1")
    const first = get.mock.calls.find((c) => String(c[0]).includes("/rows?"))?.[0] as string
    expect(first).toContain("limit=50")
    fireEvent.click(screen.getByTestId("table-block-next"))
    await screen.findByTestId("table-block-row-r51")
    expect(screen.getByTestId("table-block-page").textContent).toBe("Page 2")
    fireEvent.click(screen.getByTestId("table-block-prev"))
    await screen.findByTestId("table-block-row-r1")
    fireEvent.click(screen.getByTestId("table-block-sort-units"))
    await waitFor(() =>
      expect(get.mock.calls.some((c) => String(c[0]).includes("sort=units&dir=asc"))).toBe(true),
    )
    fireEvent.click(screen.getByTestId("table-block-sort-units"))
    await waitFor(() =>
      expect(get.mock.calls.some((c) => String(c[0]).includes("sort=units&dir=desc"))).toBe(true),
    )
  })

  it("marks rows not changed for the block's days as to confirm", async () => {
    mount({}, { staleAfterDays: 14 })
    await screen.findByTestId("table-block-row-r2")
    expect(screen.getByTestId("table-block-stale-r2").textContent).toBe("To confirm")
    expect(screen.queryByTestId("table-block-stale-r1")).toBeNull()
  })

  it("opens a row's history and undoes a change; a newer change refuses the undo", async () => {
    let undos = 0
    const { post, get } = mount({
      changes: () => ({
        changes: [
          {
            id: "c2",
            rowId: "r1",
            op: "update",
            before: { status: "Planned" },
            after: { status: "In transit" },
            actor: { type: "agent", id: "a1", label: "@logistics" },
            at: "2026-11-12T11:56:00Z",
            undoable: true,
          },
        ],
        nextCursor: null,
      }),
      undo: () => {
        undos++
        if (undos === 2) {
          throw new ApiError("stale", 409, "version_conflict", undefined, {
            current: row("r1", {}, { updatedBy: { type: "user", id: "u1", label: "Nico" } }),
          })
        }
        return row("r1", { ...ROWS[0]?.cells, status: "Planned" }, { version: 3 })
      },
    })
    fireEvent.click(await screen.findByTestId("table-block-history-r1"))
    const change = await screen.findByTestId("table-block-row-history-change-c2")
    expect(change.textContent).toContain("Status: Planned → In transit")
    expect(screen.getByTestId("table-block-row-history-title").textContent).toBe("History · B4")
    fireEvent.click(screen.getByTestId("table-block-row-history-undo-c2"))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/dashboards/tables/t1/changes/c2/undo",
        {},
        expect.anything(),
      ),
    )
    // The history reads itself again after an undo.
    const historyReads = () =>
      get.mock.calls.filter((c) => String(c[0]).includes("/changes?")).length
    await waitFor(() => expect(historyReads()).toBe(2))
    await screen.findByTestId("table-block-row-history-change-c2")
    fireEvent.click(await screen.findByTestId("table-block-row-history-undo-c2"))
    expect((await screen.findByTestId("table-block-row-history-notice")).textContent).toBe(
      "Not undone: Nico changed the row since.",
    )
  })

  it("reads the page again when a row change of its table arrives live, not another's", async () => {
    let units = 120
    let rowCount = 1
    const { get } = mount({
      table: () => ({ ...TABLE, rowCount }),
      rows: () => ({
        rows: [row("r1", { batch: "B4", units, status: "In transit" })],
        nextCursor: null,
      }),
    })
    await screen.findByTestId("table-block-row-r1")
    const rowReads = () => get.mock.calls.filter((c) => String(c[0]).includes("/rows?")).length
    const before = rowReads()
    const api = { get } as unknown as ApiClient
    void handleTableEvent(api, "rows", "updated", { tableId: "other" })
    units = 150
    rowCount = 2
    void handleTableEvent(api, "rows", "updated", { tableId: "t1" })
    await waitFor(() => expect(rowReads()).toBe(before + 1))
    await waitFor(() =>
      expect(screen.getByTestId("table-block-cell-r1-units").textContent).toBe("150"),
    )
    // The count follows too (it is the table's, read again with the page).
    expect(screen.getByTestId("table-block-count").textContent).toBe("2 rows")
  })
})
