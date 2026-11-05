// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import { Combobox } from "~/ui/Combobox"

function setup(value = "", onCommit = vi.fn(), onCancel = vi.fn()) {
  render(() => (
    <Combobox
      value={value}
      suggestions={["2.1.0", "2.2.0", "3.0.0"]}
      onCommit={onCommit}
      onCancel={onCancel}
      aria-label="Release"
      data-testid="combo"
    />
  ))
  return { input: screen.getByTestId("combo") as HTMLInputElement, onCommit, onCancel }
}

describe("Combobox", () => {
  it("shows the current value in the field", () => {
    const { input } = setup("2.1.0")
    expect(input.value).toBe("2.1.0")
    expect(input.getAttribute("role")).toBe("combobox")
  })

  it("suggests the values matching what is typed", async () => {
    const { input } = setup()
    input.focus()
    input.value = "2."
    fireEvent.input(input)
    const listbox = await screen.findByRole("listbox")
    const labels = [...listbox.querySelectorAll("[role='option']")].map((o) => o.textContent)
    expect(labels).toEqual(["2.1.0", "2.2.0"])
  })

  it("commits a picked suggestion", async () => {
    const { input, onCommit } = setup()
    input.focus()
    input.value = "2.2"
    fireEvent.input(input)
    await screen.findByRole("listbox")
    fireEvent.keyDown(input, { key: "ArrowDown" })
    await waitFor(() => expect(input.getAttribute("aria-activedescendant")).toBeTruthy())
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("2.2.0"))
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it("a pointer pick of a suggestion after typing a prefix commits the suggestion once", async () => {
    const { input, onCommit } = setup()
    input.focus()
    input.value = "2.2"
    fireEvent.input(input)
    const listbox = await screen.findByRole("listbox")
    const option = [...listbox.querySelectorAll<HTMLElement>("[role='option']")].find(
      (o) => o.textContent === "2.2.0",
    )!
    // The browser's sequence for a mouse click on an option. The mousedown
    // default moves focus off the input; jsdom does not, so blur it by hand
    // unless the component prevented that default.
    fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 })
    if (fireEvent.mouseDown(option, { button: 0 })) fireEvent.blur(input, { relatedTarget: null })
    fireEvent.pointerUp(option, { pointerType: "mouse", button: 0 })
    fireEvent.mouseUp(option, { button: 0 })
    fireEvent.click(option, { button: 0 })
    await waitFor(() => expect(onCommit).toHaveBeenCalled())
    expect(onCommit.mock.calls).toEqual([["2.2.0"]])
  })

  it("accepts free text that matches no suggestion on Enter", async () => {
    const { input, onCommit } = setup()
    input.focus()
    input.value = "  4.0.0-beta "
    fireEvent.input(input)
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onCommit).toHaveBeenCalledWith("4.0.0-beta")
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it("Escape closes the list first, then cancels without committing", async () => {
    const { input, onCommit, onCancel } = setup("2.1.0")
    input.focus()
    fireEvent.keyDown(input, { key: "ArrowDown" })
    await waitFor(() => expect(input.getAttribute("aria-expanded")).toBe("true"))
    fireEvent.keyDown(input, { key: "Escape" })
    expect(onCancel).not.toHaveBeenCalled()
    await waitFor(() => expect(input.getAttribute("aria-expanded")).toBe("false"))
    fireEvent.keyDown(input, { key: "Escape" })
    fireEvent.blur(input)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
  })
})
