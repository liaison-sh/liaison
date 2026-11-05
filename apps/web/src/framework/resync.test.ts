// SPDX-License-Identifier: FSL-1.1-ALv2
import { createRoot } from "solid-js"
import { describe, expect, it, vi } from "vitest"
import {
  installResumeResync,
  onResync,
  RESUME_RESYNC_MIN_HIDDEN_MS,
  requestResync,
  resyncVersion,
  subscribeResync,
} from "./resync"

describe("resync bus", () => {
  it("requestResync bumps resyncVersion monotonically", () => {
    const before = resyncVersion()
    requestResync("a")
    expect(resyncVersion()).toBe(before + 1)
    requestResync("b")
    expect(resyncVersion()).toBe(before + 2)
  })

  it("onResync fires the callback on each bump, not on subscribe", async () => {
    await createRoot(async (dispose) => {
      const cb = vi.fn<(v: number) => void>()
      onResync(cb)
      // No immediate call on subscribe.
      await Promise.resolve()
      expect(cb).not.toHaveBeenCalled()

      requestResync("x")
      await Promise.resolve()
      expect(cb).toHaveBeenCalledTimes(1)

      requestResync("y")
      await Promise.resolve()
      expect(cb).toHaveBeenCalledTimes(2)
      dispose()
    })
  })

  it("subscribeResync fires imperatively (no owner needed) and unsubscribes", () => {
    const cb = vi.fn<(v: number) => void>()
    const unsub = subscribeResync(cb)
    requestResync("a")
    expect(cb).toHaveBeenCalledTimes(1)
    requestResync("b")
    expect(cb).toHaveBeenCalledTimes(2)
    unsub()
    requestResync("c")
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it("a throwing subscriber does not block other subscribers", () => {
    const good = vi.fn<(v: number) => void>()
    const unsub1 = subscribeResync(() => {
      throw new Error("boom")
    })
    const unsub2 = subscribeResync(good)
    requestResync("mixed")
    expect(good).toHaveBeenCalledTimes(1)
    unsub1()
    unsub2()
  })

  it("onResync stops firing after owner disposal", async () => {
    let cb!: ReturnType<typeof vi.fn<(v: number) => void>>
    createRoot((dispose) => {
      cb = vi.fn<(v: number) => void>()
      onResync(cb)
      dispose()
    })
    requestResync("after-dispose")
    await Promise.resolve()
    expect(cb).not.toHaveBeenCalled()
  })
})

// A phone app back from the background may hold a socket that still reads
// "connected" and missed everything, read marks from other devices included.
// Its return is a resync of its own, not only a reconnect.
describe("installResumeResync", () => {
  function fakeDocument(initial: "visible" | "hidden") {
    const listeners = new Set<() => void>()
    const doc = {
      visibilityState: initial as DocumentVisibilityState,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    }
    const set = (state: "visible" | "hidden") => {
      doc.visibilityState = state
      for (const fn of listeners) fn()
    }
    return { doc: doc as never, set, listeners }
  }

  it("a return after a real absence bumps the bus; a glance away does not", () => {
    let t = 1_000
    const { doc, set } = fakeDocument("visible")
    const uninstall = installResumeResync(doc, () => t)
    const before = resyncVersion()

    set("hidden")
    t += 1_000
    set("visible")
    expect(resyncVersion()).toBe(before)

    set("hidden")
    t += RESUME_RESYNC_MIN_HIDDEN_MS
    set("visible")
    expect(resyncVersion()).toBe(before + 1)

    uninstall()
  })

  it("a page that starts hidden (a cold launch into the background) resyncs on first show", () => {
    let t = 0
    const { doc, set } = fakeDocument("hidden")
    const uninstall = installResumeResync(doc, () => t)
    const before = resyncVersion()
    t += RESUME_RESYNC_MIN_HIDDEN_MS + 1
    set("visible")
    expect(resyncVersion()).toBe(before + 1)
    uninstall()
  })

  it("uninstalls its listener", () => {
    const { doc, listeners } = fakeDocument("visible")
    const uninstall = installResumeResync(doc)
    expect(listeners.size).toBe(1)
    uninstall()
    expect(listeners.size).toBe(0)
  })
})
