// SPDX-License-Identifier: FSL-1.1-ALv2
// Walk 2026-10-12 (Home "Mark all as read" at 390 px): the toast stack sat
// bottom-right over the phone tab bar, hiding Home / Chats / Work for the whole
// Undo window. On a phone it rises above the bar and spans the screen width.
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ToastContainer } from "~/modules/shell/Toast"
import { addToast, resetToastStore } from "~/modules/shell/toast-store"
import { setShellTier } from "~/tests/helpers/shell-tier"

afterEach(() => {
  cleanup()
  resetToastStore()
  vi.unstubAllGlobals()
})

describe("ToastContainer placement", () => {
  it("on a phone, sits above the tab bar, full width", () => {
    setShellTier("phone")
    addToast({ message: "Marked 2 as read.", type: "success" })
    render(() => <ToastContainer />)
    const stack = screen.getByTestId("toast-stack")
    expect(stack.dataset.tier).toBe("phone")
    // 56 px of tab bar + an 8 px gap, over the bottom safe area (jsdom folds the calc).
    expect(stack.style.bottom).toMatch(/64px|56px/)
    expect(stack.style.bottom).toContain("safe-area-inset-bottom")
    expect(stack.className).toContain("left-4")
  })

  it("on a desktop, stays in the bottom-right corner", () => {
    setShellTier("desktop")
    addToast({ message: "Saved", type: "success" })
    render(() => <ToastContainer />)
    const stack = screen.getByTestId("toast-stack")
    expect(stack.className).toContain("bottom-4")
    expect(stack.className).toContain("right-4")
    expect(stack.style.bottom).toBe("")
  })
})

// Re-walk 2026-10-20: the Undo toast gave no sense of how long was left. Like
// Gmail's, it draws a bar that empties over the window.
describe("Undo countdown bar", () => {
  it("an Undo toast draws a bar lasting its window; a plain toast draws none", () => {
    setShellTier("phone")
    addToast({ message: "Saved", type: "success" })
    addToast({
      message: "Approved",
      type: "success",
      action: { label: "Undo", onClick: () => {} },
      durationMs: 5000,
    })
    render(() => <ToastContainer />)
    const bars = screen.getAllByTestId("toast-countdown")
    expect(bars).toHaveLength(1)
    expect(bars[0].style.animationDuration).toBe("5000ms")
    expect(bars[0].className).toContain("toast-countdown")
  })
})
