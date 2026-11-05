// SPDX-License-Identifier: FSL-1.1-ALv2
import { createRoot } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createNow } from "./createNow"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("createNow", () => {
  it("advances after each interval tick", () => {
    createRoot((dispose) => {
      const now = createNow(1_000)
      const first = now()
      vi.advanceTimersByTime(1_000)
      expect(now()).toBeGreaterThan(first)
      dispose()
    })
  })

  it("clears the interval on owner disposal (leak guard)", () => {
    const clearSpy = vi.spyOn(globalThis, "clearInterval")
    createRoot((dispose) => {
      createNow(1_000)
      dispose()
    })
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })

  it("does not tick after disposal", () => {
    let now!: () => number
    createRoot((dispose) => {
      now = createNow(1_000)
      dispose()
    })
    const frozen = now()
    vi.advanceTimersByTime(5_000)
    expect(now()).toBe(frozen)
  })
})
