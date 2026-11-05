// SPDX-License-Identifier: FSL-1.1-ALv2
import { createRoot } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDebouncedSearch } from "./createDebouncedSearch"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("createDebouncedSearch", () => {
  it("calls onResults after delay", async () => {
    const onResults = vi.fn()
    const search = vi.fn().mockResolvedValue(["result1"])

    createRoot((dispose) => {
      const trigger = createDebouncedSearch(search, { delay: 100, onResults })
      trigger("test")
      vi.advanceTimersByTime(100)
      dispose()
    })

    await vi.waitFor(() => expect(onResults).toHaveBeenCalledWith(["result1"]))
  })

  it("rapid calls only fire the last one", async () => {
    const onResults = vi.fn()
    const search = vi.fn().mockImplementation(async (q) => [q])

    createRoot((dispose) => {
      const trigger = createDebouncedSearch(search, { delay: 100, onResults })
      trigger("first")
      vi.advanceTimersByTime(50)
      trigger("second")
      vi.advanceTimersByTime(100)
      dispose()
    })

    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1))
    expect(search).toHaveBeenCalledWith("second", expect.any(Number))
  })

  it("discards stale results but delivers the fresh result", async () => {
    const onResults = vi.fn()
    const resolvers: Array<(v: string[]) => void> = []
    const search = vi.fn().mockImplementation(() => new Promise<string[]>((r) => resolvers.push(r)))

    createRoot(async (dispose) => {
      const trigger = createDebouncedSearch(search, { delay: 0, onResults })
      trigger("first")
      vi.advanceTimersByTime(0)
      trigger("second")
      vi.advanceTimersByTime(0)
      // Resolve "first" after "second" was dispatched — should be discarded
      resolvers[0](["stale"])
      await Promise.resolve()
      expect(onResults).not.toHaveBeenCalled()
      // Resolve "second" — should be delivered
      resolvers[1](["fresh"])
      await vi.waitFor(() => expect(onResults).toHaveBeenCalledWith(["fresh"]))
      expect(onResults).toHaveBeenCalledTimes(1)
      dispose()
    })
  })
})
