// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import {
  FloatingPanel,
  PHONE_VIEWPORT_INSET_PX,
  VIEWPORT_INSET_PX,
  viewportInsetForTier,
} from "~/ui/FloatingPanel"

function TestPanel() {
  return (
    <FloatingPanel.Uncontrolled trigger="Actions" triggerLabel="Thread actions">
      <button type="button">Pin</button>
    </FloatingPanel.Uncontrolled>
  )
}

function tap(trigger: HTMLElement) {
  // A tap on a phone: pointerdown with pointerType "touch", then the click the
  // browser synthesizes from touchend (when it synthesizes one at all).
  fireEvent.pointerDown(trigger, { pointerId: 1, pointerType: "touch", button: 0 })
  fireEvent.click(trigger, { detail: 0 })
}

/** Publish a layout tier the way the shell root does. */
function setTier(tier: "desktop" | "phone"): void {
  let root = document.querySelector("[data-shell-tier]")
  if (!root) {
    root = document.createElement("div")
    document.body.appendChild(root)
  }
  root.setAttribute("data-shell-tier", tier)
}

describe("FloatingPanel viewport inset", () => {
  afterEach(() => {
    for (const el of document.querySelectorAll("[data-shell-tier]")) el.remove()
  })

  it("keeps a 16px gutter off the viewport edge at the phone tier", async () => {
    setTier("phone")
    render(() => <TestPanel />)
    const trigger = screen.getByRole("button", { name: "Thread actions" })

    tap(trigger)

    await waitFor(() => expect(screen.getByText("Pin")).toBeInTheDocument())
    const panel = screen.getByText("Pin").closest("[data-viewport-inset]")
    // A 390px menu anchored to a trailing header button flips hard right, so
    // with no collision padding its border lands ON the screen edge.
    expect(panel?.getAttribute("data-viewport-inset")).toBe(String(PHONE_VIEWPORT_INSET_PX))
    expect(PHONE_VIEWPORT_INSET_PX).toBe(16)
  })

  it("leaves desktop and tablet on the tighter edge", async () => {
    setTier("desktop")
    render(() => <TestPanel />)
    const trigger = screen.getByRole("button", { name: "Thread actions" })

    tap(trigger)

    await waitFor(() => expect(screen.getByText("Pin")).toBeInTheDocument())
    const panel = screen.getByText("Pin").closest("[data-viewport-inset]")
    expect(panel?.getAttribute("data-viewport-inset")).toBe(String(VIEWPORT_INSET_PX))
    expect(viewportInsetForTier("tablet")).toBe(VIEWPORT_INSET_PX)
    expect(viewportInsetForTier("phone")).toBeGreaterThan(viewportInsetForTier("desktop"))
  })
})

describe("FloatingPanel", () => {
  it("opens on a tap: pointerdown(touch) then the synthesized click", async () => {
    render(() => <TestPanel />)
    const trigger = screen.getByRole("button", { name: "Thread actions" })

    tap(trigger)

    await waitFor(() => expect(screen.getByText("Pin")).toBeInTheDocument())
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
  })

  it("a touch pointerdown with no synthesized click still opens the panel", async () => {
    render(() => <TestPanel />)
    const trigger = screen.getByRole("button", { name: "Thread actions" })

    fireEvent.pointerDown(trigger, { pointerId: 1, pointerType: "touch", button: 0 })

    await waitFor(() => expect(screen.getByText("Pin")).toBeInTheDocument())
  })

  it("a second tap closes the panel", async () => {
    render(() => <TestPanel />)
    const trigger = screen.getByRole("button", { name: "Thread actions" })

    tap(trigger)
    await waitFor(() => expect(screen.getByText("Pin")).toBeInTheDocument())

    tap(trigger)
    await waitFor(() => expect(screen.queryByText("Pin")).not.toBeInTheDocument())
  })

  it("a mouse click still toggles the panel", async () => {
    render(() => <TestPanel />)
    const trigger = screen.getByRole("button", { name: "Thread actions" })

    fireEvent.pointerDown(trigger, { pointerId: 1, pointerType: "mouse", button: 0 })
    fireEvent.click(trigger)

    await waitFor(() => expect(screen.getByText("Pin")).toBeInTheDocument())
  })
})
