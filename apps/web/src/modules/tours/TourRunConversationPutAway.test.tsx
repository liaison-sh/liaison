// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Play whole scenario, onto a beat that asks in the run's conversation on
// ANOTHER screen than the beat before: the chat windows are put away for the
// new screen, and only THEN does the script open the conversation it types
// into. Opened first, the put-away folded it right back and the script never
// found its composer (the commerce scenario's ask, back from Invoices).
import { defineTour, type TourListItem, type TourProgress } from "@liaison/shared"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { TourApi } from "./tour-api"

vi.mock("~/modules/shell/shell-tier", () => ({ shellTier: () => "desktop" }))
vi.mock("~/framework/spa-navigate", () => ({ spaNavigate: vi.fn() }))
const dock = vi.hoisted(() => {
  const order: string[] = []
  return {
    order,
    dockAvailable: () => true,
    putAwayWindows: vi.fn(() => order.push("putAway")),
    openConversation: vi.fn((id: string) => order.push(`open:${id}`)),
  }
})
vi.mock("~/modules/shell/dock-store", () => dock)
const fixtures = vi.hoisted(() => ({ tours: [] as unknown[] }))
vi.mock("./tour-catalog", () => ({
  resolveTour: (id: string) => (fixtures.tours as { id: string }[]).find((t) => t.id === id),
}))

const { applyProgress, resetTourStore, setTourApi, tourStore } = await import("./tour-store")
const { TourOverlay } = await import("./TourHost")

const tour = defineTour({
  id: "kernel.scenario-ask-elsewhere",
  app: "kernel",
  demoOnly: true,
  talksToAgent: true,
  title: "tours.kernel.sample.title",
  summary: "tours.kernel.sample.summary",
  beats: [
    {
      id: "before",
      kind: "show",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      route: "/invoices",
    },
    {
      id: "ask",
      kind: "do",
      title: "tours.kernel.sample.postMessage.title",
      body: "tours.kernel.sample.postMessage.body",
      route: "/orders",
      event: { app: "kernel", entity: "message", action: "create" },
      autoplay: [{ openRunConversation: true }, { waitEvent: true }],
    },
  ],
})

const beatStates = { conversation: { state: "done", entityId: "thread-1" } } as const

function progress(over: Partial<TourProgress> = {}): TourProgress {
  return {
    tourId: tour.id,
    status: "active",
    beatId: "before",
    beatIndex: 0,
    beatCount: 2,
    beatStates,
    source: "demo",
    startedAt: "2026-10-23T10:00:00.000Z",
    updatedAt: "2026-10-23T10:00:00.000Z",
    ...over,
  } as TourProgress
}

function item(p: TourProgress): TourListItem {
  return {
    tourId: tour.id,
    app: "kernel",
    title: tour.title,
    summary: tour.summary,
    beatCount: 2,
    progress: p,
  }
}

beforeEach(() => {
  fixtures.tours = [tour]
  dock.order.length = 0
  resetTourStore()
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ""
})

it("puts the windows away for the new screen before the script opens the run's conversation", async () => {
  const api: TourApi = {
    list: vi.fn(async () => [item(progress())]),
    start: vi.fn(async () => progress()),
    update: vi.fn(async () =>
      progress({
        beatId: "ask",
        beatIndex: 1,
        beatStates: { ...beatStates, before: "done" },
        updatedAt: "2026-10-23T10:00:02.000Z",
      }),
    ),
    progress: vi.fn(async () => progress()),
  }
  setTourApi(api)
  render(() => <TourOverlay showBeatMs={60} stepPauseMs={1} findTimeoutMs={50} />)
  await tourStore.load()
  await screen.findByTestId("tour-panel")
  tourStore.setPlayAll(true)
  // The server's read of the same step lands while it shows (its beatStatus): the
  // effects watching the tour then flush in an order the code does not choose.
  applyProgress(
    tour.id,
    progress({ updatedAt: "2026-10-23T10:00:01.000Z", beatStatus: { kind: "pending" } }),
  )
  await waitFor(() => expect(dock.order).toContain("open:thread-1"))
  // The conversation the script opened is the last thing the dock was told: still open.
  expect(dock.order).toEqual(["putAway", "putAway", "open:thread-1"])
})
