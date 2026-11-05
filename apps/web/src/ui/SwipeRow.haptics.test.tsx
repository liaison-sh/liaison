// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The haptic half of SwipeRow: the detent crossing and the full-swipe commit.
// The geometry itself is pinned in SwipeRow.test.tsx; what this file is for is
// that the two ticks fire on the right EVENTS and, above all, that they fire
// once each rather than on every pointer move.
import { fireEvent, render } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NATIVE_BRIDGE_GLOBAL } from "~/lib/native-bridge"
import { crossedOpenDetent, SWIPE_COMMIT_PX, SwipeRow } from "~/ui/SwipeRow"

const haptic = vi.fn()

beforeEach(() => {
  haptic.mockClear()
  ;(globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL] = { haptic }
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL]
})

describe("the open detent", () => {
  it("is a crossing, not a comparison", () => {
    expect(crossedOpenDetent(SWIPE_COMMIT_PX - 1, SWIPE_COMMIT_PX)).toBe(true)
    // Already past it: a slow drag must not buzz on every move.
    expect(crossedOpenDetent(SWIPE_COMMIT_PX, SWIPE_COMMIT_PX + 40)).toBe(false)
    expect(crossedOpenDetent(0, SWIPE_COMMIT_PX - 1)).toBe(false)
    // Closing again: no tick on the way back.
    expect(crossedOpenDetent(SWIPE_COMMIT_PX + 10, 0)).toBe(false)
  })
})

function renderRow(onSelect = vi.fn(), width = 300) {
  const result = render(() => (
    <SwipeRow actions={[{ label: "Archive", onSelect }]}>
      <div>row</div>
    </SwipeRow>
  ))
  const row = result.getByTestId("swipe-row") as HTMLElement
  Object.defineProperty(row, "offsetWidth", { value: width, configurable: true })
  const surface = row.querySelector("[style]") as HTMLElement
  return { ...result, row, surface, onSelect }
}

function drag(surface: HTMLElement, xs: number[]): void {
  fireEvent.pointerDown(surface, { clientX: 0, clientY: 0, button: 0, pointerId: 1 })
  for (const x of xs) fireEvent.pointerMove(surface, { clientX: x, clientY: 0, pointerId: 1 })
}

describe("SwipeRow haptics", () => {
  it("ticks once as the drag passes the open threshold", () => {
    const { surface } = renderRow()
    drag(surface, [-20, -40, -70, -90, -110])
    expect(haptic.mock.calls.filter((c) => c[0] === "selection")).toHaveLength(1)
  })

  it("does not tick for a drag that never reaches the threshold", () => {
    const { surface } = renderRow()
    drag(surface, [-20, -40, -50])
    expect(haptic).not.toHaveBeenCalled()
  })

  it("marks a full swipe with a light impact and runs the action", () => {
    const { surface, onSelect } = renderRow(vi.fn(), 300)
    // Past 0.6 of the row's own width: the full-swipe commit.
    drag(surface, [-60, -120, -200])
    fireEvent.pointerUp(surface, { pointerId: 1 })
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(haptic.mock.calls.filter((c) => c[0] === "light")).toHaveLength(1)
  })

  it("does not buzz for a release that merely leaves the rail open", () => {
    const { surface, onSelect } = renderRow(vi.fn(), 300)
    drag(surface, [-70, -90])
    fireEvent.pointerUp(surface, { pointerId: 1 })
    expect(onSelect).not.toHaveBeenCalled()
    expect(haptic.mock.calls.filter((c) => c[0] === "light")).toHaveLength(0)
  })

  it("is a no-op with no shell under the page", () => {
    delete (globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL]
    const { surface, onSelect } = renderRow(vi.fn(), 300)
    expect(() => {
      drag(surface, [-60, -120, -200])
      fireEvent.pointerUp(surface, { pointerId: 1 })
    }).not.toThrow()
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(haptic).not.toHaveBeenCalled()
  })
})
