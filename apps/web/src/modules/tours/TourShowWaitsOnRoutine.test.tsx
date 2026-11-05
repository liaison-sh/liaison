// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A show step about what a routine produces (the reply it drafts, shown as a
// request in Home) whose element is not on screen yet: the card says the
// routine is working, with its spinner, never only "Waiting for this to
// appear on screen" (sales walk 2026-10-29: the card read as stuck while the
// routine drafted). Once the way to the element shows (the request's row),
// the hop line says what to open instead.
import {
  defineTour,
  type TourBeatStatus,
  type TourListItem,
  type TourProgress,
} from "@liaison/shared"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TourApi } from "./tour-api"

vi.mock("~/modules/shell/shell-tier", () => ({ shellTier: () => "desktop" }))
const nav = vi.hoisted(() => ({ spaNavigate: vi.fn() }))
vi.mock("~/framework/spa-navigate", () => nav)
vi.mock("~/modules/shell/dock-store", () => ({ putAwayWindows: vi.fn() }))
const fixtures = vi.hoisted(() => ({ tours: [] as unknown[] }))
vi.mock("./tour-catalog", () => ({
  resolveTour: (id: string) => (fixtures.tours as { id: string }[]).find((t) => t.id === id),
}))

const { dispatchWsEntityEvent, registerActivityBarEntry, registerTabType } = await import(
  "~/framework/app-registry"
)
const { openTab, resetTabStore } = await import("~/modules/shell/tab-store")
const { resetTourStore, setTourApi, tourStore } = await import("./tour-store")
const { TourOverlay, subscribeToTourFrames } = await import("./TourHost")

const Blank = () => null
registerTabType("desk:inbox", {
  component: Blank,
  sidebar: null,
  icon: Blank,
  urlPattern: "/desk",
  defaultLabel: "Desk",
  appId: "desk",
  singleton: true,
})
registerActivityBarEntry({
  id: "desk",
  icon: Blank,
  label: "Desk",
  order: 1,
  appId: "desk",
  tabAction: { type: "desk:inbox", entityId: "desk", label: "Desk" },
})

const tour = defineTour({
  id: "kernel.show-waits-on-routine",
  app: "kernel",
  demoOnly: true,
  title: "tours.kernel.sample.title",
  summary: "tours.kernel.sample.summary",
  beats: [
    {
      id: "arrive",
      kind: "world",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      injector: "fixture-injector",
    },
    {
      // What the routine drafted on the item the run brought in.
      id: "drafted",
      kind: "show",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      anchor: "desk-draft",
      waitsOn: "routine",
      route: "/desk",
      path: [
        { label: "tours.kernel.sample.welcome.title", rail: true },
        { label: "tours.kernel.sample.welcome.body", anchor: "desk-row-{arrive}" },
      ],
    },
  ],
})

const server = vi.hoisted(() => ({ status: { kind: "pending" } as unknown }))

const progress = (): TourProgress => ({
  tourId: tour.id,
  status: "active",
  beatId: "drafted",
  beatIndex: 1,
  beatCount: 2,
  beatStates: { arrive: { state: "done", entityId: "t-1" } },
  source: "demo",
  startedAt: "2026-10-29T10:00:00.000Z",
  updatedAt: "2026-10-29T10:00:00.000Z",
  beatStatus: server.status as TourBeatStatus,
})

function api(): TourApi {
  const item = (): TourListItem => ({
    tourId: tour.id,
    app: "kernel",
    title: tour.title,
    summary: tour.summary,
    beatCount: 2,
    progress: progress(),
  })
  return {
    list: vi.fn(async () => [item()]),
    start: vi.fn(async () => progress()),
    update: vi.fn(async () => progress()),
    progress: vi.fn(async () => progress()),
  }
}

const CTX = { currentUserId: "u-1", activeTabId: null, isDocumentVisible: true, isOwnAction: false }

/** The server's status changes and it pushes the tour frame: the card re-reads. */
async function serve(status: TourBeatStatus): Promise<void> {
  server.status = status
  dispatchWsEntityEvent(
    "kernel:tour",
    "update",
    {
      ownerUserId: "u-1",
      tourId: tour.id,
      status: "active",
      beatId: "drafted",
      beatIndex: 1,
      emittedAt: new Date().toISOString(),
    },
    CTX,
  )
  await new Promise((r) => setTimeout(r, 0))
}

function el(testid: string, attrs: Record<string, string> = {}): HTMLElement {
  const node = document.createElement("div")
  node.dataset.testid = testid
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  document.body.append(node)
  return node
}

beforeEach(() => {
  fixtures.tours = [tour]
  server.status = { kind: "pending" }
  resetTourStore()
  resetTabStore()
  nav.spaNavigate.mockReset()
  subscribeToTourFrames()
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    () => [{}] as unknown as DOMRectList,
  )
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ top: 10, left: 20, width: 100, height: 30, bottom: 40, right: 120 }) as DOMRect,
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.body.innerHTML = ""
})

describe("a show step about what a routine produces, not on screen yet", () => {
  it("says the routine works, then what the server says, then the hop once its row shows", async () => {
    openTab({ type: "desk:inbox", entityId: "desk", label: "Desk" })
    el("activity-desk", { "data-rail-entry": "desk" })
    setTourApi(api())
    render(() => <TourOverlay />)
    await tourStore.load()
    await screen.findByTestId("tour-panel")

    // On its screen, nothing to open yet: the routine is working, with a spinner.
    const working = await screen.findByTestId("tour-working")
    expect(working.textContent).toContain("routine")
    expect(working.querySelector("[class*=animate-spin]")).not.toBeNull()
    expect(screen.queryByTestId("tour-anchor-waiting")).toBeNull()
    expect((screen.getByTestId("tour-next") as HTMLButtonElement).disabled).toBe(true)

    // The server says the run is under way: its own line, with its time.
    await serve({
      kind: "routine-running",
      routineName: "Draft replies",
      startedAt: new Date(Date.now() - 5_000).toISOString(),
    })
    await waitFor(() =>
      expect(screen.getByTestId("tour-routine-progress").dataset.status).toBe("running"),
    )
    expect(screen.queryByTestId("tour-working")).toBeNull()
    expect(screen.queryByTestId("tour-anchor-waiting")).toBeNull()

    // The routine raised its request: the row shows, ringed, and the hop says to open it.
    await serve({ kind: "pending" })
    el("desk-row-t-1")
    await waitFor(() =>
      expect(screen.getByTestId("tour-spotlight").dataset.anchor).toBe("desk-row-t-1"),
    )
    await waitFor(() => expect(screen.queryByTestId("tour-working")).toBeNull())
    expect(screen.queryByTestId("tour-anchor-waiting")).toBeNull()
    expect(screen.getByTestId("tour-path").textContent).toMatch(/^2\/2/)
  })
})
