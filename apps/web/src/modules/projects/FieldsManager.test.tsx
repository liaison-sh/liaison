// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import type { TableColumn } from "~/modules/dashboards/dashboards-client"
import { FieldsManager } from "~/modules/projects/FieldsManager"
import { type ProjectDetail, projectStore } from "~/modules/projects/project-store"

afterEach(cleanup)

const project = (): ProjectDetail => ({
  id: "p1",
  name: "Repairs",
  description: null,
  icon: null,
  color: null,
  ownerId: "u1",
  archivedAt: null,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  statuses: [],
})

beforeEach(() => {
  projectStore._resetForTest()
  projectStore._setForTest({ projectId: "p1", current: project(), tasks: [] })
})

function mount(fields: TableColumn[], put: ReturnType<typeof vi.fn>) {
  const api = { put } as unknown as ApiClient
  render(() => <FieldsManager api={api} projectId="p1" fields={fields} />)
}

const input = (id: string, value: string) =>
  fireEvent.input(screen.getByTestId(id), { target: { value } })

describe("FieldsManager", () => {
  it("adds a choice field with its options and saves the whole list", async () => {
    const put = vi.fn(async (_path: string, body: { fields: TableColumn[] }) => ({
      projectId: "p1",
      fields: body.fields,
    }))
    mount([{ key: "serial", label: "Serial", type: "text", required: true }], put)
    expect(screen.getByTestId("fields-manager.save").closest("button")?.disabled).toBe(true)

    input("fields-manager.new-label", "Repair kind")
    fireEvent.change(screen.getByTestId("fields-manager.new-type"), {
      target: { value: "choice" },
    })
    fireEvent.click(screen.getByTestId("fields-manager.add"))
    expect(screen.getByTestId("fields-manager.row-repair_kind")).toBeTruthy()
    input("fields-manager.option-new-repair_kind", "Screen")
    fireEvent.click(screen.getByTestId("fields-manager.option-add-repair_kind"))
    input("fields-manager.option-new-repair_kind", "Battery")
    fireEvent.keyDown(screen.getByTestId("fields-manager.option-new-repair_kind"), {
      key: "Enter",
    })
    fireEvent.click(screen.getByTestId("fields-manager.required-repair_kind"))
    expect(screen.getByTestId("fields-manager.unsaved")).toBeTruthy()

    fireEvent.click(screen.getByTestId("fields-manager.save"))
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1))
    expect(put).toHaveBeenCalledWith("/projects/p1/fields", {
      fields: [
        { key: "serial", label: "Serial", type: "text", required: true },
        {
          key: "repair_kind",
          label: "Repair kind",
          type: "choice",
          required: true,
          choices: ["Screen", "Battery"],
        },
      ],
    })
    await waitFor(() => expect(screen.getByTestId("fields-manager.saved")).toBeTruthy())
    // The project in the store carries the saved list (the task page reads it).
    expect(projectStore.project("p1")?.fields?.map((f) => f.key)).toEqual(["serial", "repair_kind"])
  })

  it("renaming an option of a saved field sends it as a rename; reorder and remove follow", async () => {
    const put = vi.fn(async (_path: string, body: { fields: TableColumn[] }) => ({
      projectId: "p1",
      fields: body.fields,
    }))
    mount(
      [
        { key: "kind", label: "Kind", type: "choice", choices: ["A", "B"] },
        { key: "count", label: "Count", type: "number" },
        { key: "note", label: "Note", type: "text" },
      ],
      put,
    )
    input("fields-manager.option-kind-0", "Alpha")
    fireEvent.click(screen.getByTestId("fields-manager.move-up-count"))
    fireEvent.click(screen.getByTestId("fields-manager.remove-note"))
    fireEvent.click(screen.getByTestId("fields-manager.save"))
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1))
    expect(put).toHaveBeenCalledWith("/projects/p1/fields", {
      fields: [
        { key: "count", label: "Count", type: "number" },
        { key: "kind", label: "Kind", type: "choice", choices: ["Alpha", "B"] },
      ],
      renames: { kind: { A: "Alpha" } },
    })
  })

  it("an option still in use reads in plain words, and the draft stays", async () => {
    const put = vi.fn(async () => {
      throw new ApiError("field 'kind': tasks still use 'A'", 422, "choice_in_use", undefined, {
        field: "kind",
        options: ["A"],
      })
    })
    mount([{ key: "kind", label: "Kind", type: "choice", choices: ["A", "B"] }], put)
    fireEvent.click(screen.getByTestId("fields-manager.option-remove-kind-0"))
    fireEvent.click(screen.getByTestId("fields-manager.save"))
    await waitFor(() => expect(screen.getByTestId("fields-manager.error")).toBeTruthy())
    expect(screen.getByTestId("fields-manager.error").textContent).toBe(
      "Tasks still use “A” in “Kind”. Keep the option, or rename it to one you keep.",
    )
    expect(screen.getByTestId("fields-manager.unsaved")).toBeTruthy()
    expect(screen.queryByTestId("fields-manager.option-kind-1")).toBeNull()
  })

  it("a type the tasks' values no longer fit reads in plain words", async () => {
    const put = vi.fn(async () => {
      throw new ApiError(
        "field 'count': 2 task(s) hold values",
        422,
        "field_type_in_use",
        undefined,
        {
          field: "count",
          taskCount: 2,
        },
      )
    })
    mount([{ key: "count", label: "Count", type: "number" }], put)
    fireEvent.change(screen.getByTestId("fields-manager.type-count"), {
      target: { value: "date" },
    })
    fireEvent.click(screen.getByTestId("fields-manager.save"))
    await waitFor(() => expect(screen.getByTestId("fields-manager.error")).toBeTruthy())
    expect(screen.getByTestId("fields-manager.error").textContent).toBe(
      "2 task(s) hold values in “Count” that do not fit its new type. Empty them first, or keep the type.",
    )
  })
})
