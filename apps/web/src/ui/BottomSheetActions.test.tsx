// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import { BottomSheetActions } from "~/ui/BottomSheetActions"

const makeActions = (onApprove = vi.fn(), onReject = vi.fn()) => [
  { label: "Approve", onClick: onApprove, testid: "action-approve" },
  { label: "Reject", onClick: onReject, testid: "action-reject" },
]

describe("BottomSheetActions", () => {
  it("phone width renders a single more trigger instead of inline action buttons", () => {
    render(() => <BottomSheetActions actions={makeActions()} moreLabel="Actions" />)

    const trigger = screen.getByTestId("actions-more-trigger")
    expect(trigger).toBeInTheDocument()
    // jsdom applies no CSS, so the phone/desktop split is asserted through the
    // breakpoint classes: the trigger hides from md up, the inline row hides
    // below it, which is what makes the inline buttons unreachable at phone
    // width until the sheet opens.
    expect(trigger.classList.contains("md:hidden")).toBe(true)
    const inlineRow = screen.getByTestId("actions-inline-row")
    expect(inlineRow.classList.contains("hidden")).toBe(true)
    expect(inlineRow.classList.contains("md:flex")).toBe(true)
    expect(document.querySelector("[data-overlay-sheet]")).toBeNull()
  })

  it("opening the trigger reveals every action inside a bottom OverlaySheet", () => {
    render(() => <BottomSheetActions actions={makeActions()} moreLabel="Actions" />)

    fireEvent.click(screen.getByTestId("actions-more-trigger"))

    const sheet = document.querySelector('[data-overlay-sheet][data-variant="bottom"]')
    expect(sheet).toBeTruthy()
    // One row per action, counted by the sheet testid so the sheet's own close
    // control does not inflate the count.
    expect((sheet as HTMLElement).querySelectorAll('[data-testid$="-sheet"]').length).toBe(2)
    // Sheet copies carry a "-sheet" suffixed testid so the inline row and the
    // sheet row never collide in the same document.
    expect((sheet as HTMLElement).querySelector('[data-testid="action-reject-sheet"]')).toBeTruthy()
    expect((sheet as HTMLElement).textContent).toContain("Approve")
    expect((sheet as HTMLElement).textContent).toContain("Reject")
  })

  it("clicking an action inside the sheet calls its own onClick handler exactly once", () => {
    const onApprove = vi.fn()
    const onReject = vi.fn()
    render(() => (
      <BottomSheetActions actions={makeActions(onApprove, onReject)} moreLabel="Actions" />
    ))

    fireEvent.click(screen.getByTestId("actions-more-trigger"))
    const sheet = document.querySelector(
      '[data-overlay-sheet][data-variant="bottom"]',
    ) as HTMLElement
    const approve = sheet.querySelector('[data-testid="action-approve-sheet"]') as HTMLElement
    fireEvent.click(approve)

    expect(onApprove).toHaveBeenCalledTimes(1)
    expect(onReject).not.toHaveBeenCalled()
  })

  it("takes its labels as props so ui never reaches into the i18n module", () => {
    render(() => (
      <BottomSheetActions actions={makeActions()} moreLabel="Plus" closeLabel="Fermer" />
    ))
    expect(screen.getByTestId("actions-more-trigger").getAttribute("aria-label")).toBe("Plus")

    fireEvent.click(screen.getByTestId("actions-more-trigger"))
    const sheet = document.querySelector('[data-overlay-sheet][data-variant="bottom"]')
    expect(sheet?.textContent).toContain("Plus")
    expect(
      document.querySelector('[data-testid="overlay-sheet-close"]')?.getAttribute("aria-label"),
    ).toBe("Fermer")
  })
})
