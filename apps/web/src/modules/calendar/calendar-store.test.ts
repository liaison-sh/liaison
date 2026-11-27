// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The events of the visible window: a window fetched before paints at once from the cache and is
// refetched behind it, only the answer to the latest request writes the store (two quick "next"
// clicks used to leave the older, slower week on screen), and a failed fetch says so while the
// events already shown stay.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  listEvents: vi.fn(),
  listCalendars: vi.fn(async () => [] as unknown[]),
}))

vi.mock("./calendar-api", () => ({
  listEvents: mocks.listEvents,
  listCalendars: mocks.listCalendars,
  listCalendarConnections: vi.fn(async () => []),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
}))

import type { ApiClient } from "~/lib/api-client"
import {
  calendarStore,
  loadCalendarsList,
  loadEventsForWindow,
  reloadCurrentWindow,
  resetCalendarStore,
} from "./calendar-store"

const api = {} as ApiClient

function event(id: string) {
  return { eventId: id, calendarId: "c1", title: id } as never
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const W1 = ["2026-11-02T00:00:00.000Z", "2026-11-09T00:00:00.000Z"] as const
const W2 = ["2026-11-09T00:00:00.000Z", "2026-11-16T00:00:00.000Z"] as const

beforeEach(() => {
  resetCalendarStore()
  mocks.listEvents.mockReset()
})
afterEach(() => vi.restoreAllMocks())

describe("calendar window store", () => {
  it("ignores an older answer that arrives after the latest one", async () => {
    const slow = deferred<unknown[]>()
    const fast = deferred<unknown[]>()
    mocks.listEvents.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise)
    const first = loadEventsForWindow(api, ...W1)
    const second = loadEventsForWindow(api, ...W2)
    fast.resolve([event("week-2")])
    await second
    slow.resolve([event("week-1")])
    await first
    expect(calendarStore.events.map((e) => e.eventId)).toEqual(["week-2"])
    expect(calendarStore.loading).toBe(false)
  })

  it("paints a window fetched before at once, then replaces it with the fresh answer", async () => {
    mocks.listEvents.mockResolvedValueOnce([event("old")])
    await loadEventsForWindow(api, ...W1)
    mocks.listEvents.mockResolvedValueOnce([event("other")])
    await loadEventsForWindow(api, ...W2)
    const fresh = deferred<unknown[]>()
    mocks.listEvents.mockReturnValueOnce(fresh.promise)
    const back = loadEventsForWindow(api, ...W1)
    // Cached copy on screen before the server answered, and no loading bar for it.
    expect(calendarStore.events.map((e) => e.eventId)).toEqual(["old"])
    expect(calendarStore.loading).toBe(false)
    fresh.resolve([event("new")])
    await back
    expect(calendarStore.events.map((e) => e.eventId)).toEqual(["new"])
  })

  it("shows loading only for a window with nothing cached", async () => {
    const pending = deferred<unknown[]>()
    mocks.listEvents.mockReturnValueOnce(pending.promise)
    const load = loadEventsForWindow(api, ...W1)
    expect(calendarStore.loading).toBe(true)
    pending.resolve([])
    await load
    expect(calendarStore.loading).toBe(false)
  })

  it("a failed fetch sets the error and keeps the events shown; the next success clears it", async () => {
    mocks.listEvents.mockResolvedValueOnce([event("kept")])
    await loadEventsForWindow(api, ...W1)
    mocks.listEvents.mockRejectedValueOnce(new Error("network down"))
    await reloadCurrentWindow(api)
    expect(calendarStore.error).toBe("network down")
    expect(calendarStore.events.map((e) => e.eventId)).toEqual(["kept"])
    mocks.listEvents.mockResolvedValueOnce([event("back")])
    await reloadCurrentWindow(api)
    expect(calendarStore.error).toBeNull()
    expect(calendarStore.events.map((e) => e.eventId)).toEqual(["back"])
  })

  it("reloadCurrentWindow refetches the window last asked for, bypassing its cached copy", async () => {
    mocks.listEvents.mockResolvedValueOnce([event("a")])
    await loadEventsForWindow(api, ...W2)
    mocks.listEvents.mockResolvedValueOnce([event("a"), event("b")])
    await reloadCurrentWindow(api)
    expect(mocks.listEvents).toHaveBeenLastCalledWith(api, { timeMin: W2[0], timeMax: W2[1] })
    expect(calendarStore.events.map((e) => e.eventId)).toEqual(["a", "b"])
  })

  it("a failed calendar list is reported instead of an unhandled rejection", async () => {
    mocks.listCalendars.mockRejectedValueOnce(new Error("boom"))
    await expect(loadCalendarsList(api)).resolves.toBeUndefined()
    expect(calendarStore.error).toBe("boom")
  })
})
