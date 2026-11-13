// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { rememberPeople, resetTablePeople } from "~/modules/dashboards/blocks/table-people"
import type { TableColumn } from "~/modules/dashboards/dashboards-client"
import { TaskFieldsSection } from "~/modules/projects/TaskFieldsSection"
import { ApiContext } from "~/modules/shell/ApiContext"

afterEach(() => {
  cleanup()
  resetTablePeople()
})

const FIELDS: TableColumn[] = [
  { key: "serial", label: "Serial", type: "text", required: true },
  { key: "count", label: "Count", type: "number" },
  { key: "price", label: "Price", type: "amount", currency: "EUR" },
  { key: "due", label: "Promised", type: "date" },
  { key: "kind", label: "Kind", type: "choice", choices: ["A", "B"] },
  { key: "tags", label: "Tags", type: "choices", choices: ["x", "y", "z"] },
  { key: "urgent", label: "Urgent", type: "checkbox" },
  { key: "owner", label: "Owner", type: "person" },
  { key: "order", label: "Order", type: "link" },
]

function mount(fields: TableColumn[], values: Record<string, unknown>) {
  const onSave = vi.fn()
  const api = {
    getEnvelope: vi.fn(async () => ({ data: [] })),
    get: vi.fn(async () => ({ items: [] })),
  } as unknown as ApiClient
  render(() => (
    <ApiContext.Provider value={api}>
      <TaskFieldsSection fields={fields} values={values} onSave={onSave} />
    </ApiContext.Provider>
  ))
  return { onSave }
}

describe("TaskFieldsSection", () => {
  it("is hidden when the project declares no field", () => {
    mount([], { serial: "S-1" })
    expect(screen.queryByTestId("task-fields")).toBeNull()
  })

  it("reads each type's value as the dashboard tables do, an empty one as Not set", () => {
    rememberPeople([{ id: "u1", name: "Nico Durand", email: "nico@x.test" }])
    mount(FIELDS, {
      serial: "S-1",
      count: 3,
      price: 12.5,
      due: "2026-11-18",
      kind: "B",
      tags: ["x", "z"],
      urgent: true,
      owner: "u1",
      order: { app: "shop", entityType: "order", id: "o1", label: "Order 1042" },
    })
    const value = (k: string) => screen.getByTestId(`task-fields.value-${k}`).textContent
    expect(value("serial")).toBe("S-1")
    expect(value("count")).toBe("3")
    expect(value("price")).toContain("12.50")
    expect(value("price")).toContain("€")
    expect(value("due")).toBe("Nov 18, 2026")
    expect(value("kind")).toBe("B")
    expect(value("tags")).toBe("x, z")
    expect(value("owner")).toBe("Nico Durand")
    expect(value("order")).toBe("Order 1042")
    expect((screen.getByTestId("task-fields.checkbox-urgent") as HTMLInputElement).checked).toBe(
      true,
    )
    // In the project's order, the required one marked.
    expect(screen.getByTestId("task-fields.label-serial").textContent).toBe("Serial*")
  })

  it("an empty value reads Not set", () => {
    mount(FIELDS.slice(0, 2), {})
    expect(screen.getByTestId("task-fields.value-count").textContent).toBe("Not set")
  })

  it("editing a text field saves only that field", () => {
    const { onSave } = mount(FIELDS, { serial: "S-1" })
    fireEvent.click(screen.getByTestId("task-fields.value-serial"))
    const input = screen.getByTestId("task-fields.editor-serial") as HTMLInputElement
    input.value = "S-2"
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onSave).toHaveBeenCalledWith({ serial: "S-2" })
    expect(screen.queryByTestId("task-fields.editor-serial")).toBeNull()
  })

  it("a number field parses the input; a non-number is refused in words, nothing saved", () => {
    const { onSave } = mount(FIELDS, {})
    fireEvent.click(screen.getByTestId("task-fields.value-count"))
    const input = screen.getByTestId("task-fields.editor-count") as HTMLInputElement
    input.value = "abc"
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByTestId("task-fields.error-count").textContent).toBe("Enter a number.")

    fireEvent.click(screen.getByTestId("task-fields.value-count"))
    const again = screen.getByTestId("task-fields.editor-count") as HTMLInputElement
    again.value = "4,5"
    fireEvent.keyDown(again, { key: "Enter" })
    expect(onSave).toHaveBeenCalledWith({ count: 4.5 })
  })

  it("an unchanged value saves nothing", () => {
    const { onSave } = mount(FIELDS, { serial: "S-1" })
    fireEvent.click(screen.getByTestId("task-fields.value-serial"))
    fireEvent.keyDown(screen.getByTestId("task-fields.editor-serial"), { key: "Enter" })
    expect(onSave).not.toHaveBeenCalled()
  })

  it("a choice saves the option picked; emptying a field sends null", () => {
    const { onSave } = mount(FIELDS, { kind: "A", count: 2 })
    fireEvent.click(screen.getByTestId("task-fields.value-kind"))
    fireEvent.click(screen.getByTestId("task-fields.editor-kind-choice-1"))
    expect(onSave).toHaveBeenCalledWith({ kind: "B" })

    fireEvent.click(screen.getByTestId("task-fields.value-count"))
    const input = screen.getByTestId("task-fields.editor-count") as HTMLInputElement
    input.value = ""
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onSave).toHaveBeenCalledWith({ count: null })
  })

  it("multiple choices save on Done; a checkbox toggles in place", () => {
    const { onSave } = mount(FIELDS, { tags: ["x"] })
    fireEvent.click(screen.getByTestId("task-fields.value-tags"))
    fireEvent.click(screen.getByTestId("task-fields.editor-tags-choice-2"))
    fireEvent.click(screen.getByTestId("task-fields.editor-tags-done"))
    expect(onSave).toHaveBeenCalledWith({ tags: ["x", "z"] })

    fireEvent.click(screen.getByTestId("task-fields.checkbox-urgent"))
    expect(onSave).toHaveBeenCalledWith({ urgent: true })
  })

  it("a required field cannot be emptied", () => {
    const { onSave } = mount(FIELDS, { serial: "S-1" })
    fireEvent.click(screen.getByTestId("task-fields.value-serial"))
    const input = screen.getByTestId("task-fields.editor-serial") as HTMLInputElement
    input.value = "  "
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByTestId("task-fields.error-serial").textContent).toBe(
      "This field is required.",
    )
  })
})
