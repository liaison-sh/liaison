// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { addToast, dismissToast, resetToastStore, toasts } from "~/modules/shell/toast-store"

describe("toast-store", () => {
  beforeEach(() => {
    resetToastStore()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("adds a toast", () => {
    addToast({ message: "Hello", type: "success" })
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0].message).toBe("Hello")
    expect(toasts()[0].type).toBe("success")
  })

  it("limits visible toasts to 3", () => {
    addToast({ message: "1", type: "success" })
    addToast({ message: "2", type: "success" })
    addToast({ message: "3", type: "success" })
    addToast({ message: "4", type: "success" })
    expect(toasts()).toHaveLength(3)
  })

  it("auto-dismisses after 5 seconds", () => {
    addToast({ message: "Temp", type: "info" })
    expect(toasts()).toHaveLength(1)
    vi.advanceTimersByTime(5000)
    expect(toasts()).toHaveLength(0)
  })

  it("dismisses a specific toast by id", () => {
    const id = addToast({ message: "Dismiss me", type: "error" })
    expect(toasts()).toHaveLength(1)
    dismissToast(id)
    expect(toasts()).toHaveLength(0)
  })

  it("assigns unique ids", () => {
    const id1 = addToast({ message: "One", type: "success" })
    const id2 = addToast({ message: "Two", type: "success" })
    expect(id1).not.toBe(id2)
  })

  it("an actioned toast stays by default, but auto-dismisses after its own duration", () => {
    addToast({ message: "Stays", type: "info", action: { label: "Go", onClick: () => {} } })
    addToast({
      message: "Undo window",
      type: "success",
      action: { label: "Undo", onClick: () => {} },
      durationMs: 8000,
    })
    vi.advanceTimersByTime(8000)
    expect(toasts().map((t) => t.message)).toEqual(["Stays"])
  })

  it("an Undo toast carries its window as a countdown; a plain or open-ended one does not", () => {
    addToast({ message: "Plain", type: "info", durationMs: 3000 })
    addToast({ message: "Open", type: "info", action: { label: "Go", onClick: () => {} } })
    addToast({
      message: "Approved",
      type: "success",
      action: { label: "Undo", onClick: () => {} },
      durationMs: 5000,
    })
    expect(toasts().map((t) => t.countdownMs)).toEqual([undefined, undefined, 5000])
  })
})
