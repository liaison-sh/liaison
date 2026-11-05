// SPDX-License-Identifier: FSL-1.1-ALv2
// Walk D28: the server's progress had moved on while the panel stayed on the
// beat before. The store keeps the newest progress it has seen (a slower,
// older read never moves the panel back), and a resync (a WS reconnect, whose
// frames may have been lost meanwhile) refetches the tour in progress.
import type { TourListItem, TourProgress } from "@liaison/shared"
import { afterEach, describe, expect, it, vi } from "vitest"
import { requestResync } from "~/framework/resync"
import type { TourApi } from "./tour-api"
import { applyProgress, resetTourStore, setTourApi, tourStore } from "./tour-store"

const TOUR = "tickets.basics"

function progress(beatId: string, beatIndex: number, updatedAt: string): TourProgress {
  return {
    tourId: TOUR,
    status: "active",
    beatId,
    beatIndex,
    beatCount: 8,
    beatStates: {},
    source: "help",
    startedAt: "2026-10-24T00:51:04.000Z",
    updatedAt,
  }
}

function api(over: Partial<TourApi>): TourApi {
  return {
    list: async (): Promise<TourListItem[]> => [],
    progress: async () => null,
    start: async () => null,
    update: async () => null,
    ...over,
  } as TourApi
}

afterEach(() => resetTourStore())

describe("tour progress sync", () => {
  it("a read older than what the panel shows never moves it back", () => {
    applyProgress(TOUR, progress("review", 4, "2026-10-24T00:52:22.100Z"))
    applyProgress(TOUR, progress("ask-draft", 3, "2026-10-24T00:51:11.500Z"))
    expect(tourStore.current?.beatId).toBe("review")
    // A newer one still moves it on.
    applyProgress(TOUR, progress("note", 5, "2026-10-24T00:53:00.000Z"))
    expect(tourStore.current?.beatId).toBe("note")
  })

  it("a resync refetches the tour in progress", async () => {
    applyProgress(TOUR, progress("ask-draft", 3, "2026-10-24T00:51:11.500Z"))
    const read = vi.fn(async () => progress("review", 4, "2026-10-24T00:52:22.100Z"))
    setTourApi(api({ progress: read }))
    requestResync("ws-reconnect")
    await vi.waitFor(() => expect(tourStore.current?.beatId).toBe("review"))
    expect(read).toHaveBeenCalledWith(TOUR)
  })
})
