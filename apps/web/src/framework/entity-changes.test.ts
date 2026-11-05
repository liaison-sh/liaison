// SPDX-License-Identifier: FSL-1.1-ALv2
import { createRoot } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  type EntityChangeEvent,
  EntityChangesTestAccess,
  entityKeyMatches,
  notifyEntityChange,
  onEntityChange,
} from "./entity-changes"
import { requestResync } from "./resync"

function ev(key: string, action = "updated", data: unknown = {}): EntityChangeEvent {
  const [app = "", entity = ""] = key.split(":")
  return { key, app, entity, action, data }
}

describe("entity-changes", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    EntityChangesTestAccess.reset()
  })
  afterEach(() => {
    EntityChangesTestAccess.reset()
    vi.useRealTimers()
  })

  it("matches exact keys, app wildcards and the global wildcard only", () => {
    expect(entityKeyMatches("tickets:ticket", "tickets:ticket")).toBe(true)
    expect(entityKeyMatches("tickets:*", "tickets:message")).toBe(true)
    expect(entityKeyMatches("*", "kernel:node")).toBe(true)
    expect(entityKeyMatches("tickets:ticket", "tickets:message")).toBe(false)
    expect(entityKeyMatches("tickets:*", "ticketsx:ticket")).toBe(false)
    expect(entityKeyMatches("projects:*", "tickets:ticket")).toBe(false)
  })

  it("fires on a matching event and ignores others", () => {
    const cb = vi.fn<(events: EntityChangeEvent[]) => void>()
    const dispose = onEntityChange(["tickets:ticket", "projects:*"], cb, { debounceMs: 0 })
    notifyEntityChange(ev("mail:message"))
    expect(cb).not.toHaveBeenCalled()
    notifyEntityChange(ev("tickets:ticket", "created"))
    notifyEntityChange(ev("projects:task", "moved"))
    expect(cb).toHaveBeenCalledTimes(2)
    expect(cb.mock.calls[0]?.[0].map((e) => e.action)).toEqual(["created"])
    expect(cb.mock.calls[1]?.[0].map((e) => e.key)).toEqual(["projects:task"])
    dispose()
  })

  it("coalesces a burst of 5 into one call carrying the 5 events in order", () => {
    const cb = vi.fn<(events: EntityChangeEvent[]) => void>()
    const dispose = onEntityChange("projects:task", cb)
    for (let i = 0; i < 5; i++) notifyEntityChange(ev("projects:task", "updated", { i }))
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(150)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0]?.[0].map((e) => (e.data as { i: number }).i)).toEqual([0, 1, 2, 3, 4])
    dispose()
  })

  it("debounceMs 0 delivers each event alone and synchronously", () => {
    const cb = vi.fn<(events: EntityChangeEvent[]) => void>()
    const dispose = onEntityChange("tickets:message", cb, { debounceMs: 0 })
    for (let i = 0; i < 3; i++) notifyEntityChange(ev("tickets:message"))
    expect(cb).toHaveBeenCalledTimes(3)
    for (const call of cb.mock.calls) expect(call[0]).toHaveLength(1)
    dispose()
  })

  it("a continuous stream still delivers at the 1 s max-wait", () => {
    const cb = vi.fn<(events: EntityChangeEvent[]) => void>()
    const dispose = onEntityChange("tickets:ticket", cb)
    // One event every 100 ms: the 150 ms quiet window never elapses.
    for (let t = 0; t < 1000; t += 100) {
      notifyEntityChange(ev("tickets:ticket"))
      vi.advanceTimersByTime(100)
    }
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0]?.[0]).toHaveLength(10)
    dispose()
  })

  it("a wide debounce honours its own max-wait, not the 1 s default", () => {
    const cb = vi.fn<(events: EntityChangeEvent[]) => void>()
    const dispose = onEntityChange("tickets:ticket", cb, { debounceMs: 1500, maxWaitMs: 4000 })
    // One event every 500 ms: the 1.5 s quiet window never elapses.
    for (let t = 0; t < 3500; t += 500) {
      notifyEntityChange(ev("tickets:ticket"))
      vi.advanceTimersByTime(500)
    }
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0]?.[0]).toHaveLength(7)
    dispose()
  })

  it("resync delivers one synthetic resync batch to every live subscription", () => {
    const a = vi.fn<(events: EntityChangeEvent[]) => void>()
    const b = vi.fn<(events: EntityChangeEvent[]) => void>()
    const da = onEntityChange("tickets:ticket", a)
    const db = onEntityChange("kernel:node", b, { debounceMs: 0 })
    notifyEntityChange(ev("tickets:ticket")) // pending, dropped by the resync
    requestResync("test")
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(a.mock.calls[0]?.[0]).toEqual([
      { key: "*", app: "*", entity: "*", action: "resync", data: null, resync: true },
    ])
    vi.advanceTimersByTime(2000)
    expect(a).toHaveBeenCalledTimes(1)
    da()
    db()
  })

  it("stops after its reactive owner is disposed, including a pending batch", () => {
    const cb = vi.fn<(events: EntityChangeEvent[]) => void>()
    const dispose = createRoot((d) => {
      onEntityChange("tickets:ticket", cb)
      return d
    })
    notifyEntityChange(ev("tickets:ticket"))
    dispose()
    vi.advanceTimersByTime(2000)
    notifyEntityChange(ev("tickets:ticket"))
    requestResync("after-dispose")
    vi.advanceTimersByTime(2000)
    expect(cb).not.toHaveBeenCalled()
  })

  it("the returned disposer stops an owner-less subscription", () => {
    const cb = vi.fn<(events: EntityChangeEvent[]) => void>()
    const dispose = onEntityChange("tickets:ticket", cb, { debounceMs: 0 })
    dispose()
    notifyEntityChange(ev("tickets:ticket"))
    expect(cb).not.toHaveBeenCalled()
  })

  it("a throwing subscriber does not starve the others", () => {
    const bad = vi.fn(() => {
      throw new Error("boom")
    })
    const good = vi.fn<(events: EntityChangeEvent[]) => void>()
    const d1 = onEntityChange("tickets:ticket", bad, { debounceMs: 0 })
    const d2 = onEntityChange("tickets:ticket", good, { debounceMs: 0 })
    notifyEntityChange(ev("tickets:ticket"))
    expect(good).toHaveBeenCalledTimes(1)
    d1()
    d2()
  })
})
