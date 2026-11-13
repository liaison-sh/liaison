// SPDX-License-Identifier: FSL-1.1-ALv2
// Tables backed by a project, in the web: "From a project" in the sidebar's create form sends the
// backing, a backed grid marks the columns read from the project, a read-through edit writes the
// row (the server changes the task), a refused one says why in plain words, Add creates a task,
// delete is not offered; a link cell opens its record, in a plain table as well.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/auth/auth-store", () => ({
  onAuthCleared: () => () => {},
  userFromToken: () => ({ userId: "me", name: "Tester", scopes: [] }),
}))
const openEntity = vi.fn(async () => {})
vi.mock("~/modules/shell/entity-opener", () => ({
  openEntity: (...args: unknown[]) => openEntity(...(args as [])),
}))

import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { ApiContext } from "~/modules/shell/ApiContext"
import { resetTabStore } from "~/modules/shell/tab-store"
import { EditableTableBlock } from "./blocks/EditableTableBlock"
import { resetTablePeople } from "./blocks/table-people"
import { DashboardsSidebar } from "./DashboardsSidebar"
import type { TableInfo, TableRow } from "./dashboards-client"
import { resetDashboardsStore } from "./dashboards-store"
import { resetBackingNames } from "./table-backing"
import { resetTablesStore } from "./tables-store"

const PROJECT = "11111111-1111-4111-8111-111111111111"

const BACKED: TableInfo = {
  id: "t1",
  name: "Returns follow-up",
  columns: [
    { key: "title", label: "Title", type: "text", required: true },
    { key: "status", label: "Status", type: "choice", choices: ["To do", "Doing", "Done"] },
    { key: "note", label: "Note", type: "text" },
    { key: "ref", label: "Ref", type: "link", linkTo: { app: "projects", entityType: "task" } },
  ],
  agentWritesNeedApproval: false,
  orgAccess: "editor",
  myRole: "editor",
  rowCount: 1,
  version: 1,
  updatedAt: "2026-11-13T08:00:00Z",
  droppedKeys: [],
  backing: {
    app: "projects",
    entity: "task",
    parentId: PROJECT,
    fields: ["title", "status"],
    readThrough: ["title", "status"],
    own: ["note", "ref"],
  },
}

const row = (
  cells: Record<string, unknown>,
  version = 0,
  more: Partial<TableRow> = {},
): TableRow => ({
  id: "task-1",
  cells,
  version,
  recordVersion: "rv1",
  updatedAt: "2026-11-13T08:00:00Z",
  updatedBy: { type: "user", id: "u1", label: "Nico" },
  ...more,
})

const ROW = row({
  title: "Return RMA-7",
  status: "To do",
  ref: { app: "projects", entityType: "task", id: "task-9", label: "RMA-6" },
})

function mountBlock(
  table: TableInfo,
  write: (body: { ops: Array<Record<string, unknown>> }) => unknown = () => ({ rows: [] }),
  rows: TableRow[] = [ROW],
) {
  const get = vi.fn(async (path: string) => {
    if (path === "/dashboards/tables/t1") return table
    if (path.startsWith("/dashboards/tables/t1/rows?")) return { rows, nextCursor: null }
    if (path === `/projects/${PROJECT}`) return { id: PROJECT, name: "Returns", fields: [] }
    throw new Error(`unexpected GET ${path}`)
  })
  const post = vi.fn(async (path: string, body: unknown) => {
    if (path === "/dashboards/tables/t1/rows")
      return write(body as { ops: Array<Record<string, unknown>> })
    throw new Error(`unexpected POST ${path}`)
  })
  const getEnvelope = vi.fn(async () => ({ data: [] }))
  const api = { get, post, getEnvelope } as unknown as ApiClient
  render(() => (
    <ApiContext.Provider value={api}>
      <EditableTableBlock tableId="t1" now={Date.parse("2026-11-13T09:00:00Z")} />
    </ApiContext.Provider>
  ))
  return { get, post }
}

beforeEach(() => {
  resetTablePeople()
  resetBackingNames()
  openEntity.mockClear()
})
afterEach(cleanup)

describe("a table backed by a project", () => {
  it("marks the columns read from the project, naming it, and the table's own", async () => {
    mountBlock(BACKED)
    await screen.findByTestId("table-block-row-task-1")
    expect(screen.getByTestId("table-block-from-record-title")).toBeTruthy()
    expect(screen.getByTestId("table-block-from-record-status")).toBeTruthy()
    expect(screen.queryByTestId("table-block-from-record-note")).toBeNull()
    expect(screen.getByTestId("table-block-sort-note").dataset.source).toBe("own")
    await waitFor(() =>
      expect(screen.getByTestId("table-block-sort-status").getAttribute("title")).toBe(
        "From Returns: changing it changes the task.",
      ),
    )
    expect(screen.getByTestId("table-block-sort-note").getAttribute("title")).toBe(
      "Kept in this table only.",
    )
  })

  it("edits a status cell with the same editor and writes it to the row", async () => {
    const { post } = mountBlock(BACKED, () => ({
      rows: [row({ ...ROW.cells, status: "Doing" })],
    }))
    await screen.findByTestId("table-block-row-task-1")
    fireEvent.click(screen.getByTestId("table-block-edit-task-1-status"))
    fireEvent.click(await screen.findByTestId("table-block-editor-task-1-status-choice-1"))
    await waitFor(() =>
      expect(screen.getByTestId("table-block-cell-task-1-status").textContent).toBe("Doing"),
    )
    expect(post).toHaveBeenCalledWith(
      "/dashboards/tables/t1/rows",
      {
        ops: [
          {
            op: "update",
            id: "task-1",
            ifVersion: 0,
            cells: { status: "Doing" },
            // The record's version from the read: the server refuses the change if the task moved.
            ifRecordVersion: "rv1",
          },
        ],
      },
      expect.anything(),
    )
  })

  it("says plainly when the task changed meanwhile (409) and shows its latest version", async () => {
    mountBlock(BACKED, () => {
      throw new ApiError("stale", 409, "version_conflict", undefined, {
        current: row({ ...ROW.cells, status: "Done" }, 0, {
          recordVersion: "rv2",
          updatedBy: { type: "system", id: null, label: "System" },
        }),
      })
    })
    await screen.findByTestId("table-block-row-task-1")
    fireEvent.click(screen.getByTestId("table-block-edit-task-1-status"))
    fireEvent.click(await screen.findByTestId("table-block-editor-task-1-status-choice-1"))
    const notice = await screen.findByTestId("table-block-notice-task-1")
    expect(notice.textContent).toBe("This task changed meanwhile. Reload and try again.")
    expect(notice.textContent).not.toContain("System")
  })

  it("a row no one changed through the table shows when its task last changed", async () => {
    mountBlock(BACKED, undefined, [
      row(ROW.cells, 0, {
        updatedAt: "2026-11-10T09:00:00Z",
        updatedBy: { type: "system", id: null, label: "System" },
      }),
    ])
    const last = await screen.findByTestId("table-block-history-task-1")
    expect(last.textContent).not.toContain("System")
    expect(last.textContent).toMatch(/^Task changed /)
  })

  it("says in plain words when the person may not change the project's tasks", async () => {
    mountBlock(BACKED, () => {
      throw new ApiError("needs projects:tasks:write", 403, "forbidden")
    })
    await screen.findByTestId("table-block-row-task-1")
    fireEvent.click(screen.getByTestId("table-block-edit-task-1-status"))
    fireEvent.click(await screen.findByTestId("table-block-editor-task-1-status-choice-2"))
    const notice = await screen.findByTestId("table-block-notice-task-1")
    expect(notice.textContent).toBe(
      "You can't change the tasks of Returns. Ask an admin for permission to edit tasks.",
    )
  })

  it("adds a task from its title and offers no delete, saying why", async () => {
    const { post } = mountBlock(BACKED, () => ({ rows: [row({ title: "New one" })] }))
    await screen.findByTestId("table-block-row-task-1")
    expect(screen.queryByTestId("table-block-delete-task-1")).toBeNull()
    await waitFor(() =>
      expect(screen.getByTestId("table-block-delete-off-task-1").getAttribute("title")).toBe(
        "Each row is a task of Returns. To remove one, archive the task in Projects.",
      ),
    )
    const add = screen.getByTestId("table-block-add")
    expect(add.textContent).toContain("Add a task")
    fireEvent.click(add)
    // The add form asks the task's title and the table's own columns, not the other task values.
    expect(screen.queryByTestId("table-block-add-status")).toBeNull()
    fireEvent.input(screen.getByTestId("table-block-add-title"), { target: { value: "New one" } })
    fireEvent.click(screen.getByTestId("table-block-add-save"))
    await waitFor(() => expect(post).toHaveBeenCalled())
    const body = post.mock.calls[0]?.[1] as { ops: Array<{ op: string; cells: unknown }> }
    expect(body.ops[0]?.op).toBe("add")
    expect(body.ops[0]?.cells).toMatchObject({ title: "New one" })
  })
})

describe("a link cell", () => {
  it("opens its record from a click or the keyboard, editing stays on the pencil", async () => {
    mountBlock(BACKED)
    await screen.findByTestId("table-block-row-task-1")
    const open = screen.getByTestId("table-block-open-task-1-ref")
    expect(open.tagName).toBe("BUTTON")
    expect(open.getAttribute("aria-label")).toBe("Open RMA-6")
    fireEvent.click(open)
    expect(openEntity).toHaveBeenCalledWith(expect.anything(), "projects", "task", "task-9")
    fireEvent.click(screen.getByTestId("table-block-edit-task-1-ref"))
    expect(await screen.findByTestId("table-block-editor-task-1-ref")).toBeTruthy()
  })

  it("opens in a plain read-only table too", async () => {
    const { backing: _b, ...plain } = BACKED
    mountBlock({ ...plain, myRole: "viewer" })
    await screen.findByTestId("table-block-row-task-1")
    expect(screen.queryByTestId("table-block-edit-task-1-ref")).toBeNull()
    fireEvent.click(screen.getByTestId("table-block-open-task-1-ref"))
    expect(openEntity).toHaveBeenCalledWith(expect.anything(), "projects", "task", "task-9")
  })
})

describe("creating a table from a project", () => {
  beforeEach(() => {
    resetDashboardsStore()
    resetTablesStore()
    resetTabStore()
  })

  it("sends the project and the ticked task values as the table's backing", async () => {
    const created: TableInfo = { ...BACKED, id: "t9", name: "Returns board" }
    const post = vi.fn(async (_path: string, _body: unknown) => created)
    const api = {
      get: vi.fn(async (path: string) => {
        if (path === "/dashboards") return []
        if (path === "/dashboards/tables") return { tables: [] }
        if (path.startsWith("/dashboards/tables/link-search?")) {
          const q = new URLSearchParams(path.split("?")[1])
          expect(q.get("app")).toBe("projects")
          expect(q.get("entityType")).toBe("project")
          return {
            items: [{ id: PROJECT, label: "Returns", app: "projects", entityType: "project" }],
          }
        }
        if (path === `/projects/${PROJECT}`)
          return {
            id: PROJECT,
            name: "Returns",
            fields: [{ key: "refund", label: "Refund", type: "amount" }],
          }
        throw new Error(`unexpected GET ${path}`)
      }),
      post,
    } as unknown as ApiClient
    render(() => (
      <ApiContext.Provider value={api}>
        <DashboardsSidebar />
      </ApiContext.Provider>
    ))
    fireEvent.click(screen.getByTestId("dashboards-sidebar-new-table"))
    fireEvent.input(screen.getByTestId("dashboards-sidebar-new-table-name"), {
      target: { value: "Returns board" },
    })
    fireEvent.click(screen.getByTestId("dashboards-sidebar-new-table-from-project"))
    // Create without a project says what is missing.
    fireEvent.click(screen.getByTestId("dashboards-sidebar-new-table-create"))
    expect((await screen.findByTestId("dashboards-sidebar-new-table-error")).textContent).toBe(
      "Pick a project.",
    )
    fireEvent.click(
      await screen.findByTestId(`dashboards-sidebar-new-table-project-option-${PROJECT}`),
    )
    // The built-ins and the project's own fields are offered; four are ticked by default.
    const refund = (await screen.findByTestId(
      "dashboards-sidebar-new-table-field-refund",
    )) as HTMLInputElement
    expect(refund.checked).toBe(false)
    expect(
      (screen.getByTestId("dashboards-sidebar-new-table-field-priority") as HTMLInputElement)
        .checked,
    ).toBe(false)
    fireEvent.click(refund)
    fireEvent.click(screen.getByTestId("dashboards-sidebar-new-table-field-due"))
    fireEvent.click(screen.getByTestId("dashboards-sidebar-new-table-create"))
    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(post.mock.calls[0]?.[0]).toBe("/dashboards/tables")
    expect(post.mock.calls[0]?.[1]).toEqual({
      columns: [],
      name: "Returns board",
      backing: {
        app: "projects",
        entity: "task",
        parentId: PROJECT,
        fields: ["title", "status", "assignee", "refund"],
      },
    })
  })
})
