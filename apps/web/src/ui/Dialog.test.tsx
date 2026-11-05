// SPDX-License-Identifier: FSL-1.1-ALv2
import { render, screen } from "@solidjs/testing-library"
import { describe, expect, it } from "vitest"
import { Dialog } from "~/ui/Dialog"

describe("Dialog", () => {
  it("renders content when open", () => {
    render(() => (
      <Dialog open={true} onOpenChange={() => {}}>
        <Dialog.Content>
          <Dialog.Title>Test Dialog</Dialog.Title>
          <Dialog.Description>Dialog body</Dialog.Description>
        </Dialog.Content>
      </Dialog>
    ))
    expect(screen.getByText("Test Dialog")).toBeInTheDocument()
    expect(screen.getByText("Dialog body")).toBeInTheDocument()
  })

  it("does not render content when closed", () => {
    render(() => (
      <Dialog open={false} onOpenChange={() => {}}>
        <Dialog.Content>
          <Dialog.Title>Hidden</Dialog.Title>
        </Dialog.Content>
      </Dialog>
    ))
    expect(screen.queryByText("Hidden")).not.toBeInTheDocument()
  })

  it("has correct ARIA role", () => {
    render(() => (
      <Dialog open={true} onOpenChange={() => {}}>
        <Dialog.Content>
          <Dialog.Title>Accessible</Dialog.Title>
        </Dialog.Content>
      </Dialog>
    ))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })
})
