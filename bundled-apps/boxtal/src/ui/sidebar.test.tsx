// SPDX-License-Identifier: FSL-1.1-ALv2
//
// createNavRefreshController — the badge-refresh coalescer BoxtalSidebar's
// onMount wires up (see sidebar.tsx). No DOM is reachable from this app's
// test harness without adding a dependency (same limitation noted in
// Editor.test.tsx), so this drives the extracted controller directly with a
// manual clock instead of mounting the real Solid component under jsdom.
// That is the exact function the component delegates to (fetch: refresh,
// getPathname: () => window.location.pathname), so exercising it here
// exercises the sidebar's real fetch-coalescing behavior end to end.
//
// Regression pinned: opening "To prepare" used to fire the sidebar's own
// refresh() once on mount PLUS once per NAV_EVENT with no gate, no
// debounce and no in-flight guard, so a page-open burst of 5 nav events
// produced 6 concurrent queue_counts calls and deadlocked the 6-worker
// sandbox pool against itself (prod: 5x queue_counts 504 within 22ms).
import { describe, expect, it } from "bun:test"
import { createNavRefreshController } from "./sidebar"

// Deterministic, real-timer-free clock: notify() reschedules through this
// instead of setTimeout, so a burst can be asserted without any real wait.
function makeManualClock() {
  let now = 0
  let nextId = 0
  const timers = new Map<number, { at: number; cb: () => void }>()
  return {
    schedule: (cb: () => void, ms: number) => {
      const id = ++nextId
      timers.set(id, { at: now + ms, cb })
      return id
    },
    cancel: (id: number) => {
      timers.delete(id)
    },
    advance: (ms: number) => {
      now += ms
      for (const [id, t] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) {
          timers.delete(id)
          t.cb()
        }
      }
    },
  }
}

// A fetch mock that stays pending until resolveAll() is called, so tests can
// assert call COUNT while a fetch is deliberately kept in flight.
function makeDeferredFetch() {
  let calls = 0
  const resolvers: Array<() => void> = []
  const fetch = () => {
    calls++
    return new Promise<void>((resolve) => resolvers.push(resolve))
  }
  return {
    fetch,
    callCount: () => calls,
    resolveAll: () => {
      const pending = resolvers.splice(0, resolvers.length)
      for (const r of pending) r()
    },
  }
}

describe("createNavRefreshController", () => {
  it("sidebar fetches counts once on mount", () => {
    const clock = makeManualClock()
    const { fetch, callCount } = makeDeferredFetch()
    const controller = createNavRefreshController({
      fetch,
      getPathname: () => "/boxtal/queue/to-prepare",
      schedule: clock.schedule,
      cancel: clock.cancel,
    })
    controller.fetchNow()
    expect(callCount()).toBe(1)
  })

  it("sidebar coalesces a burst of nav events into one fetch", () => {
    // Direct regression test for the prod incident: without the fix, mount
    // (1) + 5 nav events (5) = 6 concurrent queue_counts calls.
    const clock = makeManualClock()
    const { fetch, callCount } = makeDeferredFetch()
    let pathname = "/boxtal/shipments"
    const controller = createNavRefreshController({
      fetch,
      getPathname: () => pathname,
      schedule: clock.schedule,
      cancel: clock.cancel,
    })
    controller.fetchNow() // mount fetch — stays in flight (deferred)
    expect(callCount()).toBe(1)

    // Burst: tab open + url pattern + filter/selection state, five distinct
    // nav events, one of them a real route change.
    pathname = "/boxtal/queue/to-prepare"
    controller.notify()
    controller.notify()
    pathname = "/boxtal/queue/to-prepare?x=1"
    controller.notify()
    controller.notify()
    controller.notify()

    clock.advance(250) // fires the single coalesced debounce timer

    // The mount fetch is still in flight, so the debounced nav refresh is
    // coalesced into a trailing flag, not a second invokeTool call.
    expect(callCount()).toBe(1)
  })

  it("sidebar does not refetch when replaceState leaves the pathname unchanged", () => {
    const clock = makeManualClock()
    const { fetch, callCount, resolveAll } = makeDeferredFetch()
    const pathname = "/boxtal/queue/to-prepare"
    const controller = createNavRefreshController({
      fetch,
      getPathname: () => pathname,
      schedule: clock.schedule,
      cancel: clock.cancel,
    })
    controller.fetchNow()
    resolveAll()
    expect(callCount()).toBe(1)

    // A replaceState that only carries filter/selection state (same
    // pathname) must produce ZERO backend calls.
    controller.notify()
    clock.advance(250)
    expect(callCount()).toBe(1)
  })

  it("sidebar runs one trailing refresh when nav happens during an in flight fetch", async () => {
    const clock = makeManualClock()
    const { fetch, callCount, resolveAll } = makeDeferredFetch()
    let pathname = "/boxtal/queue/to-prepare"
    const controller = createNavRefreshController({
      fetch,
      getPathname: () => pathname,
      schedule: clock.schedule,
      cancel: clock.cancel,
    })
    controller.fetchNow() // call #1 — held open
    expect(callCount()).toBe(1)

    pathname = "/boxtal/shipments"
    controller.notify()
    controller.notify()
    controller.notify()
    clock.advance(250)

    // Coalesced into a pending trailing request, not a second call yet.
    expect(callCount()).toBe(1)

    resolveAll() // the in-flight fetch lands
    await Promise.resolve()
    await Promise.resolve()

    // Exactly one trailing refresh ran — never 4 (one per nav event).
    expect(callCount()).toBe(2)

    resolveAll()
    await Promise.resolve()
    expect(callCount()).toBe(2) // no further trailing runs
  })

  it("sidebar does not fetch after unmount", () => {
    const clock = makeManualClock()
    const { fetch, callCount, resolveAll } = makeDeferredFetch()
    let pathname = "/boxtal/queue/to-prepare"
    const controller = createNavRefreshController({
      fetch,
      getPathname: () => pathname,
      schedule: clock.schedule,
      cancel: clock.cancel,
    })
    controller.fetchNow()
    resolveAll()
    expect(callCount()).toBe(1)

    controller.dispose()
    pathname = "/boxtal/shipments"
    controller.notify()
    clock.advance(250)

    expect(callCount()).toBe(1)
  })
})
