// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AppLockOverlay } from "~/ui/AppLockOverlay"

afterEach(() => cleanup())

function renderOverlay(locked: boolean, onUnlock = vi.fn(async () => true)) {
  render(() => (
    <AppLockOverlay
      locked={locked}
      onUnlock={onUnlock}
      title="Liaison is locked"
      unlockLabel="Unlock"
      failedLabel="That did not unlock. Try again."
    />
  ))
  return { onUnlock }
}

describe("the app lock overlay", () => {
  it("renders nothing while the app is unlocked", () => {
    renderOverlay(false)
    expect(screen.queryByTestId("app-lock-overlay")).toBeNull()
  })

  it("covers the app as a modal with the caller's own title", () => {
    renderOverlay(true)
    const overlay = screen.getByTestId("app-lock-overlay")
    expect(overlay.getAttribute("role")).toBe("dialog")
    expect(overlay.getAttribute("aria-modal")).toBe("true")
    expect(overlay.getAttribute("aria-label")).toBe("Liaison is locked")
    expect(overlay.textContent).toContain("Liaison is locked")
  })

  it("runs the biometric when the control is used", async () => {
    const { onUnlock } = renderOverlay(true)
    fireEvent.click(screen.getByTestId("app-lock-unlock"))
    await new Promise((r) => setTimeout(r, 0))
    expect(onUnlock).toHaveBeenCalledTimes(1)
  })

  it("says so after a refusal, and does not re-prompt on its own", async () => {
    const onUnlock = vi.fn(async () => false)
    renderOverlay(true, onUnlock)
    expect(screen.queryByTestId("app-lock-failed")).toBeNull()
    fireEvent.click(screen.getByTestId("app-lock-unlock"))
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByTestId("app-lock-failed").textContent).toBe(
      "That did not unlock. Try again.",
    )
    // One attempt per tap: a loop is how a platform decides an app is abusing
    // the sensor.
    expect(onUnlock).toHaveBeenCalledTimes(1)
  })

  it("does not stack attempts while one is still running", async () => {
    let release!: (ok: boolean) => void
    const onUnlock = vi.fn(() => new Promise<boolean>((r) => (release = r)))
    renderOverlay(true, onUnlock as never)
    const button = screen.getByTestId("app-lock-unlock")
    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.click(button)
    expect(onUnlock).toHaveBeenCalledTimes(1)
    release(true)
    await new Promise((r) => setTimeout(r, 0))
  })
})
