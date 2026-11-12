// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { ApiContext } from "~/modules/shell/ApiContext"
import type { TableInfo } from "./dashboards-client"
import { TableSettings } from "./TableSettings"

afterEach(cleanup)

const TABLE: TableInfo = {
  id: "t1",
  name: "Inbound batches",
  columns: [
    { key: "batch", label: "Batch", type: "text", required: true },
    { key: "status", label: "Status", type: "choice", choices: ["Planned", "Arrived"] },
  ],
  agentWritesNeedApproval: false,
  orgAccess: "viewer",
  myRole: "owner",
  rowCount: 4,
  version: 7,
  updatedAt: "2026-11-12T08:00:00Z",
  droppedKeys: ["eta"],
}

function mount(table: TableInfo = TABLE, patch?: (body: Record<string, unknown>) => unknown) {
  // The API answers in the `{data}` envelope.
  const patchFn = vi.fn(async (_path: string, body: Record<string, unknown>) => ({
    data: patch ? patch(body) : { ...table, version: table.version + 1 },
  }))
  const get = vi.fn(async () => ({ data: { ...table, version: 9 } }))
  const api = { get, patch: patchFn } as unknown as ApiClient
  const [current, setCurrent] = createSignal(table)
  render(() => (
    <ApiContext.Provider value={api}>
      <TableSettings table={current()} onChanged={setCurrent} />
    </ApiContext.Provider>
  ))
  return { patch: patchFn, get, current }
}

describe("TableSettings", () => {
  it("lists the columns with their type and required flag", () => {
    mount()
    expect(screen.getByTestId("table-settings-column-type-batch").textContent).toBe(
      "Text · required",
    )
    expect(screen.getByTestId("table-settings-column-type-status").textContent).toBe(
      "Choice · Planned, Arrived",
    )
    expect(screen.getByTestId("table-settings-access").textContent).toBe(
      "Everyone in the organization can view",
    )
  })

  it("adds a column at the table's version, with a key that avoids reserved and dropped ones", async () => {
    const { patch } = mount()
    fireEvent.input(screen.getByTestId("table-settings-new-label"), { target: { value: "ETA" } })
    fireEvent.change(screen.getByTestId("table-settings-new-type"), { target: { value: "date" } })
    fireEvent.click(screen.getByTestId("table-settings-add-column-save"))
    await waitFor(() => expect(patch).toHaveBeenCalled())
    expect(patch.mock.calls[0]?.[0]).toBe("/dashboards/tables/t1")
    expect(patch.mock.calls[0]?.[1]).toEqual({
      ifVersion: 7,
      columns: { add: [{ key: "eta_2", label: "ETA", type: "date" }] },
    })
    cleanup()
    const second = mount()
    fireEvent.input(screen.getByTestId("table-settings-new-label"), { target: { value: "Id" } })
    fireEvent.click(screen.getByTestId("table-settings-add-column-save"))
    await waitFor(() => expect(second.patch).toHaveBeenCalled())
    expect(second.patch.mock.calls[0]?.[1]).toMatchObject({ columns: { add: [{ key: "id_2" }] } })
  })

  it("a choice column needs its choices", async () => {
    const { patch } = mount()
    fireEvent.input(screen.getByTestId("table-settings-new-label"), {
      target: { value: "Transport" },
    })
    fireEvent.change(screen.getByTestId("table-settings-new-type"), { target: { value: "choice" } })
    fireEvent.click(screen.getByTestId("table-settings-add-column-save"))
    expect(screen.getByTestId("table-settings-error").textContent).toBe("Give at least one choice.")
    fireEvent.input(screen.getByTestId("table-settings-new-choices"), {
      target: { value: "Air, Sea" },
    })
    fireEvent.click(screen.getByTestId("table-settings-add-column-save"))
    await waitFor(() => expect(patch).toHaveBeenCalled())
    expect(patch.mock.calls[0]?.[1]).toMatchObject({
      columns: { add: [{ key: "transport", type: "choice", choices: ["Air", "Sea"] }] },
    })
  })

  it("renames a column's label and edits its choices", async () => {
    const { patch } = mount()
    fireEvent.click(screen.getByTestId("table-settings-rename-batch"))
    const input = screen.getByTestId("table-settings-rename-input-batch") as HTMLInputElement
    input.value = "Lot"
    fireEvent.click(screen.getByTestId("table-settings-rename-save-batch"))
    await waitFor(() =>
      expect(patch.mock.calls[0]?.[1]).toEqual({
        ifVersion: 7,
        columns: { rename: [{ key: "batch", label: "Lot" }] },
      }),
    )
    await waitFor(() =>
      expect(screen.queryByTestId("table-settings-rename-input-batch")).toBeNull(),
    )
    fireEvent.click(screen.getByTestId("table-settings-choices-status"))
    const choices = screen.getByTestId("table-settings-choices-input-status") as HTMLInputElement
    choices.value = "Planned, In transit, Arrived"
    fireEvent.click(screen.getByTestId("table-settings-choices-save-status"))
    await waitFor(() =>
      expect(patch.mock.calls[1]?.[1]).toMatchObject({
        columns: { setChoices: [{ key: "status", choices: ["Planned", "In transit", "Arrived"] }] },
      }),
    )
  })

  it("drops a column only after the confirm", async () => {
    const { patch } = mount()
    fireEvent.click(screen.getByTestId("table-settings-drop-status"))
    expect((await screen.findByTestId("table-settings-drop-dialog-text")).textContent).toContain(
      "cannot be used again",
    )
    fireEvent.click(screen.getByTestId("table-settings-drop-dialog-confirm"))
    await waitFor(() =>
      expect(patch.mock.calls[0]?.[1]).toEqual({ ifVersion: 7, columns: { drop: ["status"] } }),
    )
  })

  it("switches agent approval, and a conflict rereads the table", async () => {
    const { patch, get, current } = mount(TABLE, () => {
      throw new ApiError("stale", 409, "version_conflict")
    })
    fireEvent.click(screen.getByTestId("table-settings-agent-approval"))
    await waitFor(() => expect(patch).toHaveBeenCalled())
    expect(patch.mock.calls[0]?.[1]).toEqual({ ifVersion: 7, agentWritesNeedApproval: true })
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith("/dashboards/tables/t1", expect.anything()),
    )
    expect(screen.getByTestId("table-settings-error").textContent).toContain(
      "Someone changed the table",
    )
    await waitFor(() => expect(current().version).toBe(9))
  })

  it("a viewer sees the settings without the controls", () => {
    mount({ ...TABLE, myRole: "viewer" })
    expect(screen.queryByTestId("table-settings-rename-batch")).toBeNull()
    expect(screen.queryByTestId("table-settings-add-column")).toBeNull()
    expect(
      (screen.getByTestId("table-settings-agent-approval") as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})
