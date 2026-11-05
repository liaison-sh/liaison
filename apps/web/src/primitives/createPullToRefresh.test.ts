// SPDX-License-Identifier: FSL-1.1-ALv2
import { createRoot } from "solid-js"
import { describe, expect, it, vi } from "vitest"
import {
  createPullToRefresh,
  PULL_MAX_PX,
  PULL_THRESHOLD_PX,
  pullArmed,
  pullDistance,
  scrollTopFor,
} from "~/primitives/createPullToRefresh"

/** A TouchEvent shaped enough for the handlers. */
function touch(clientY: number, target: EventTarget | null = null): TouchEvent {
  return { touches: [{ clientY }], target } as unknown as TouchEvent
}

describe("the gesture math", () => {
  it("ignores upward travel entirely", () => {
    expect(pullDistance(-40)).toBe(0)
    expect(pullDistance(0)).toBe(0)
  })

  it("resists, so the threshold is not tripped by a flick", () => {
    // 64px of finger is half the threshold, not all of it.
    expect(pullDistance(PULL_THRESHOLD_PX)).toBe(PULL_THRESHOLD_PX / 2)
    expect(pullArmed(pullDistance(PULL_THRESHOLD_PX))).toBe(false)
    expect(pullArmed(pullDistance(PULL_THRESHOLD_PX * 2))).toBe(true)
  })

  it("stops moving well before the finger does", () => {
    expect(pullDistance(10_000)).toBe(PULL_MAX_PX)
  })

  it("arms exactly at the threshold", () => {
    expect(pullArmed(PULL_THRESHOLD_PX - 1)).toBe(false)
    expect(pullArmed(PULL_THRESHOLD_PX)).toBe(true)
  })
})

describe("finding the scroller", () => {
  it("reads the first scrollable ancestor of the touch, not the element itself", () => {
    const scroller = document.createElement("div")
    Object.defineProperty(scroller, "scrollHeight", { value: 900, configurable: true })
    Object.defineProperty(scroller, "clientHeight", { value: 300, configurable: true })
    scroller.scrollTop = 120
    const row = document.createElement("div")
    scroller.appendChild(row)
    expect(scrollTopFor(row)).toBe(120)
    scroller.scrollTop = 0
    expect(scrollTopFor(row)).toBe(0)
  })

  it("treats a list too short to scroll as being at its top", () => {
    expect(scrollTopFor(document.createElement("div"))).toBe(0)
    expect(scrollTopFor(null)).toBe(0)
  })
})

function harness(scrollTop = 0) {
  const onRefresh = vi.fn(async () => {})
  let pull!: ReturnType<typeof createPullToRefresh>
  const dispose = createRoot((d) => {
    pull = createPullToRefresh({
      onRefresh,
      scrollTop: () => scrollTop,
      reducedMotion: () => false,
    })
    return d
  })
  return { pull, onRefresh, dispose }
}

describe("the gesture", () => {
  it("refreshes on a release past the threshold", async () => {
    const { pull, onRefresh, dispose } = harness()
    pull.handlers.onTouchStart(touch(0))
    pull.handlers.onTouchMove(touch(200))
    expect(pull.armed()).toBe(true)
    pull.handlers.onTouchEnd()
    expect(pull.refreshing()).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(pull.refreshing()).toBe(false)
    expect(pull.distance()).toBe(0)
    dispose()
  })

  it("does nothing on a release short of the threshold", () => {
    const { pull, onRefresh, dispose } = harness()
    pull.handlers.onTouchStart(touch(0))
    pull.handlers.onTouchMove(touch(40))
    expect(pull.armed()).toBe(false)
    pull.handlers.onTouchEnd()
    expect(onRefresh).not.toHaveBeenCalled()
    expect(pull.refreshing()).toBe(false)
    dispose()
  })

  it("NEVER arms when the list is not scrolled to the top", () => {
    const { pull, onRefresh, dispose } = harness(240)
    pull.handlers.onTouchStart(touch(0))
    pull.handlers.onTouchMove(touch(400))
    expect(pull.distance()).toBe(0)
    pull.handlers.onTouchEnd()
    expect(onRefresh).not.toHaveBeenCalled()
    dispose()
  })

  it("hands an upward gesture back for good, even if it wanders down again", () => {
    const { pull, onRefresh, dispose } = harness()
    pull.handlers.onTouchStart(touch(100))
    pull.handlers.onTouchMove(touch(40))
    pull.handlers.onTouchMove(touch(400))
    expect(pull.distance()).toBe(0)
    pull.handlers.onTouchEnd()
    expect(onRefresh).not.toHaveBeenCalled()
    dispose()
  })

  it("drops the gesture on a cancel", () => {
    const { pull, onRefresh, dispose } = harness()
    pull.handlers.onTouchStart(touch(0))
    pull.handlers.onTouchMove(touch(300))
    pull.handlers.onTouchCancel()
    expect(pull.distance()).toBe(0)
    pull.handlers.onTouchEnd()
    expect(onRefresh).not.toHaveBeenCalled()
    dispose()
  })

  it("refuses a second pull while one is still loading", async () => {
    let release!: () => void
    const onRefresh = vi.fn(() => new Promise<void>((r) => (release = r)))
    const dispose = createRoot((d) => {
      const pull = createPullToRefresh({
        onRefresh,
        scrollTop: () => 0,
        reducedMotion: () => false,
      })
      pull.handlers.onTouchStart(touch(0))
      pull.handlers.onTouchMove(touch(300))
      pull.handlers.onTouchEnd()
      // In flight: a second gesture does not arm at all.
      pull.handlers.onTouchStart(touch(0))
      pull.handlers.onTouchMove(touch(300))
      expect(pull.distance()).toBe(0)
      pull.handlers.onTouchEnd()
      return d
    })
    await new Promise((r) => setTimeout(r, 0))
    release()
    await new Promise((r) => setTimeout(r, 0))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    dispose()
  })

  it("stops the spinner even when the refresh fails", async () => {
    const onRefresh = vi.fn(async () => {
      throw new Error("offline")
    })
    let pull!: ReturnType<typeof createPullToRefresh>
    const dispose = createRoot((d) => {
      pull = createPullToRefresh({ onRefresh, scrollTop: () => 0, reducedMotion: () => false })
      return d
    })
    pull.handlers.onTouchStart(touch(0))
    pull.handlers.onTouchMove(touch(300))
    pull.handlers.onTouchEnd()
    await new Promise((r) => setTimeout(r, 0))
    expect(pull.refreshing()).toBe(false)
    dispose()
  })

  it("reports reduced motion so the indicator does not slide", () => {
    let pull!: ReturnType<typeof createPullToRefresh>
    const dispose = createRoot((d) => {
      pull = createPullToRefresh({
        onRefresh: () => {},
        scrollTop: () => 0,
        reducedMotion: () => true,
      })
      return d
    })
    expect(pull.animated()).toBe(false)
    dispose()
  })
})
