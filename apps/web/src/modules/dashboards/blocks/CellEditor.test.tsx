// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ApiContext } from "~/modules/shell/ApiContext"
import type { TableColumn } from "../dashboards-client"
import { CellEditor } from "./CellEditor"
import { personName } from "./table-people"

afterEach(cleanup)

function mount(column: TableColumn, value: unknown, extra: { inline?: boolean } = {}) {
  const onCommit = vi.fn()
  const onCancel = vi.fn()
  const get = vi.fn(async (path: string) => {
    if (path.startsWith("/dashboards/tables/link-search?")) {
      return {
        data: {
          items: [
            { id: "p1", label: "Touch stand", app: "shop", entityType: "product" },
            { id: "p2", label: "Stand bag", app: "shop", entityType: "product" },
          ],
        },
      }
    }
    throw new Error(`unexpected ${path}`)
  })
  const getEnvelope = vi.fn(async (_path: string) => ({
    data: [
      { id: "u1", name: "Nico Durand", email: "nico@x.test" },
      { id: "u2", name: "", email: "sam@x.test" },
    ],
  }))
  const api = { get, getEnvelope } as unknown as ApiClient
  render(() => (
    <ApiContext.Provider value={api}>
      <CellEditor
        column={column}
        value={value}
        testid="ed"
        onCommit={onCommit}
        onCancel={onCancel}
        {...extra}
      />
    </ApiContext.Provider>
  ))
  return { onCommit, onCancel, get, getEnvelope }
}

describe("CellEditor", () => {
  it("a text field saves on Enter and cancels on Escape", () => {
    const { onCommit, onCancel } = mount({ key: "a", label: "A", type: "text" }, "x")
    const input = screen.getByTestId("ed") as HTMLInputElement
    expect(document.activeElement).toBe(input)
    input.value = "y"
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onCommit).toHaveBeenCalledWith("y")
    cleanup()
    const second = mount({ key: "a", label: "A", type: "text" }, "x")
    fireEvent.keyDown(screen.getByTestId("ed"), { key: "Escape" })
    expect(second.onCancel).toHaveBeenCalled()
    expect(second.onCommit).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it("a date uses the date input; an amount shows its currency", () => {
    mount({ key: "d", label: "ETA", type: "date" }, "2026-11-18")
    expect((screen.getByTestId("ed") as HTMLInputElement).type).toBe("date")
    expect((screen.getByTestId("ed") as HTMLInputElement).value).toBe("2026-11-18")
    cleanup()
    mount({ key: "p", label: "Price", type: "amount", currency: "EUR" }, 12)
    expect(screen.getByText("EUR")).toBeTruthy()
  })

  it("multiple choices save the ticked ones in the column's order on Done", () => {
    const { onCommit } = mount(
      { key: "t", label: "Tags", type: "choices", choices: ["a", "b", "c"] },
      ["c"],
    )
    fireEvent.click(screen.getByTestId("ed-choice-0"))
    fireEvent.click(screen.getByTestId("ed-done"))
    expect(onCommit).toHaveBeenCalledWith(["a", "c"])
  })

  it("a single choice clears when picked again (not required)", () => {
    const { onCommit } = mount({ key: "s", label: "S", type: "choice", choices: ["x", "y"] }, "x")
    expect(screen.getByTestId("ed-choice-0").getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(screen.getByTestId("ed-choice-0"))
    expect(onCommit).toHaveBeenCalledWith("")
  })

  it("a person is picked from the member directory, and their name is remembered", async () => {
    const { onCommit, getEnvelope } = mount({ key: "o", label: "Owner", type: "person" }, null)
    fireEvent.click(await screen.findByTestId("ed-option-u1"))
    expect(onCommit).toHaveBeenCalledWith("u1")
    expect(String(getEnvelope.mock.calls[0]?.[0])).toContain("/mentions/members?")
    expect(personName("u1")).toBe("Nico Durand")
    expect(screen.getByTestId("ed-option-u2").textContent).toBe("sam@x.test")
  })

  it("a link is picked from the column's app records via link search", async () => {
    const column: TableColumn = {
      key: "product",
      label: "Product",
      type: "link",
      linkTo: { app: "shop", entityType: "product" },
    }
    const { onCommit, get } = mount(column, null)
    fireEvent.input(screen.getByTestId("ed"), { target: { value: "stand" } })
    await waitFor(() =>
      expect(get.mock.calls.some((c) => String(c[0]).includes("q=stand"))).toBe(true),
    )
    const path = String(get.mock.calls.at(-1)?.[0])
    expect(path).toContain("app=shop")
    expect(path).toContain("entityType=product")
    fireEvent.click(await screen.findByTestId("ed-option-p1"))
    expect(onCommit).toHaveBeenCalledWith({
      app: "shop",
      entityType: "product",
      id: "p1",
      label: "Touch stand",
    })
  })

  it("a link already set can be cleared when the column is optional", async () => {
    const { onCommit } = mount(
      { key: "l", label: "L", type: "link", linkTo: { app: "shop" } },
      { app: "shop", entityType: "product", id: "p1", label: "Touch stand" },
    )
    fireEvent.click(await screen.findByTestId("ed-clear"))
    expect(onCommit).toHaveBeenCalledWith(null)
  })
})
