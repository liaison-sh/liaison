// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { describe, expect, it, vi } from "vitest"
import { PopupMenu } from "~/ui/PopupMenu"

function TestMenu(props: { onSelect?: (value: string) => void }) {
  const [open, setOpen] = createSignal(false)

  return (
    <PopupMenu open={open()} onOpenChange={setOpen}>
      <PopupMenu.Trigger aria-label="Open actions">Actions</PopupMenu.Trigger>
      <PopupMenu.Content>
        <PopupMenu.Group>
          <PopupMenu.Label>Message actions</PopupMenu.Label>
          <PopupMenu.Item onSelect={() => props.onSelect?.("edit")}>Edit</PopupMenu.Item>
          <PopupMenu.Item onSelect={() => props.onSelect?.("delete")} variant="danger">
            Delete
          </PopupMenu.Item>
        </PopupMenu.Group>
      </PopupMenu.Content>
    </PopupMenu>
  )
}

describe("PopupMenu", () => {
  it("renders accessible menu semantics", async () => {
    render(() => <TestMenu />)

    const trigger = screen.getByRole("button", { name: "Open actions" })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })

    const menu = await screen.findByRole("menu", { name: "Open actions" })
    expect(menu).toBeInTheDocument()
    expect(screen.getByRole("group", { name: "Message actions" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument()
  })

  it("supports keyboard navigation between menu items", async () => {
    render(() => <TestMenu />)

    const trigger = screen.getByRole("button", { name: "Open actions" })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })

    const editItem = await screen.findByRole("menuitem", { name: "Edit" })
    await waitFor(() => expect(editItem).toHaveFocus())

    fireEvent.keyDown(editItem, { key: "ArrowDown" })

    const deleteItem = screen.getByRole("menuitem", { name: "Delete" })
    await waitFor(() => expect(deleteItem).toHaveFocus())

    expect(deleteItem).toHaveFocus()
    expect(deleteItem).toHaveClass("data-[highlighted]:ring-2")
  })

  it("keeps the menu name anchored to the trigger", async () => {
    const [open, setOpen] = createSignal(false)

    render(() => (
      <PopupMenu open={open()} onOpenChange={setOpen}>
        <PopupMenu.Trigger aria-label="Open actions">Actions</PopupMenu.Trigger>
        <PopupMenu.Content aria-label="Do not use this label">
          <PopupMenu.Item onSelect={() => undefined}>Edit</PopupMenu.Item>
        </PopupMenu.Content>
      </PopupMenu>
    ))

    const trigger = screen.getByRole("button", { name: "Open actions" })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })

    expect(await screen.findByRole("menu", { name: "Open actions" })).toBeInTheDocument()
    expect(screen.queryByRole("menu", { name: "Do not use this label" })).not.toBeInTheDocument()
  })

  // THE SILENT MENU (P6d-T18, skeptic 1). Kobalte's GroupLabel reads its
  // group's context and throws when there is none, and the content is
  // portalled, so that throw took the whole portal with it: the trigger opened
  // onto nothing, with no error on screen and no failing assertion anywhere.
  // A section heading in the wrong place now costs a console line, not a menu.
  it("renders the menu when a label is written outside a group", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const [open, setOpen] = createSignal(false)
      render(() => (
        <PopupMenu open={open()} onOpenChange={setOpen}>
          <PopupMenu.Trigger aria-label="Open actions">Actions</PopupMenu.Trigger>
          <PopupMenu.Content>
            <PopupMenu.Label>Local models</PopupMenu.Label>
            <PopupMenu.Item onSelect={() => undefined}>Edit</PopupMenu.Item>
          </PopupMenu.Content>
        </PopupMenu>
      ))

      const trigger = screen.getByRole("button", { name: "Open actions" })
      trigger.focus()
      fireEvent.keyDown(trigger, { key: "ArrowDown" })

      // The menu is there, and so is everything under the misplaced heading.
      expect(await screen.findByRole("menu", { name: "Open actions" })).toBeInTheDocument()
      expect(await screen.findByRole("menuitem", { name: "Edit" })).toBeInTheDocument()
      expect(screen.getByText("Local models")).toBeInTheDocument()
      // And the mistake said so.
      expect(errors.mock.calls.flat().join(" ")).toContain("PopupMenu.Label outside")
    } finally {
      errors.mockRestore()
    }
  })
})
