// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The way to a step's screen (owner, 2026-10-25, on the demo's support
// scenario): a step whose screen is in another app rings that app's entry on
// the rail until the person is in it; a step about what the person opens (the
// ticket the run brought in) offers "Take me there" to that very entity from
// the list, rings the row that opens it, and is done once it is open, never
// "waiting for this to appear".
import { defineTour, type TourListItem, type TourProgress } from "@liaison/shared"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { findTourMenuItem, pressTourMenuItem, tourMenuItem } from "./test-helpers"
import type { TourApi } from "./tour-api"

const tier = vi.hoisted(() => ({ value: "desktop" as "desktop" | "tablet" | "phone" }))
vi.mock("~/modules/shell/shell-tier", () => ({ shellTier: () => tier.value }))
const nav = vi.hoisted(() => ({ spaNavigate: vi.fn() }))
vi.mock("~/framework/spa-navigate", () => nav)
vi.mock("~/modules/shell/dock-store", () => ({ putAwayWindows: vi.fn() }))
const fixtures = vi.hoisted(() => ({ tours: [] as unknown[] }))
vi.mock("./tour-catalog", () => ({
  resolveTour: (id: string) => (fixtures.tours as { id: string }[]).find((t) => t.id === id),
}))

const { registerActivityBarEntry, registerTabType } = await import("~/framework/app-registry")
const { openTab, resetTabStore } = await import("~/modules/shell/tab-store")
const { resetTourStore, setTourApi, tourStore } = await import("./tour-store")
const { TourOverlay } = await import("./TourHost")

const Blank = () => null
registerTabType("kernel:home", {
  component: Blank,
  sidebar: null,
  icon: Blank,
  urlPattern: "/",
  defaultLabel: "Home",
  appId: "kernel",
})
registerTabType("desk:inbox", {
  component: Blank,
  sidebar: null,
  icon: Blank,
  urlPattern: "/desk",
  defaultLabel: "Desk",
  appId: "desk",
  singleton: true,
})
registerTabType("desk:detail", {
  component: Blank,
  sidebar: null,
  icon: Blank,
  urlPattern: "/desk/:entityId",
  defaultLabel: "Item",
  appId: "desk",
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
  id: "kernel.wayfinding",
  app: "kernel",
  demoOnly: true,
  title: "tours.kernel.sample.title",
  summary: "tours.kernel.sample.summary",
  beats: [
    {
      id: "inbox",
      kind: "show",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      anchor: "desk-inbox",
      route: "/desk",
    },
    {
      id: "arrive",
      kind: "world",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      injector: "fixture-injector",
      anchor: "desk-list",
      route: "/desk",
    },
    {
      id: "open",
      kind: "show",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      anchor: "desk-detail[data-item-id={arrive}]",
      path: [{ label: "tours.kernel.sample.welcome.title", anchor: "desk-row-{arrive}" }],
      route: "/desk/{arrive}",
    },
    {
      // Nested: the app on the rail, then the item's row, then its notes tab,
      // then the last thing to do there.
      id: "deep",
      kind: "show",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      anchor: "desk-notes",
      path: [
        { label: "tours.kernel.sample.welcome.title", rail: true },
        { label: "tours.kernel.sample.welcome.body", anchor: "desk-row-{arrive}" },
        { label: "tours.kernel.sample.postMessage.title", anchor: "desk-tab-notes" },
        { label: "tours.kernel.sample.postMessage.body" },
      ],
      route: "/desk/{arrive}",
    },
  ],
})

function progress(over: Partial<TourProgress> = {}): TourProgress {
  return {
    tourId: tour.id,
    status: "active",
    beatId: "inbox",
    beatIndex: 0,
    beatCount: 4,
    beatStates: {},
    source: "demo",
    startedAt: "2026-10-25T10:00:00.000Z",
    updatedAt: "2026-10-25T10:00:00.000Z",
    ...over,
  }
}

function item(p: TourProgress): TourListItem {
  return {
    tourId: tour.id,
    app: "kernel",
    title: tour.title,
    summary: tour.summary,
    beatCount: 4,
    progress: p,
  }
}

function api(p: TourProgress): TourApi {
  return {
    list: vi.fn(async () => [item(p)]),
    start: vi.fn(async () => p),
    update: vi.fn(async () => p),
    progress: vi.fn(async () => p),
  }
}

function el(testid: string, attrs: Record<string, string> = {}): HTMLElement {
  const node = document.createElement("div")
  node.dataset.testid = testid
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  document.body.append(node)
  return node
}

/** The desktop rail's entry for the fixture app, as ActivityBar renders it. */
function railEntry(): HTMLElement {
  return el("activity-desk", { "data-rail-entry": "desk" })
}

const AT_OPEN = progress({
  beatId: "open",
  beatIndex: 2,
  beatStates: { inbox: "done", arrive: { state: "done", entityId: "t-1" } },
})

beforeEach(() => {
  fixtures.tours = [tour]
  tier.value = "desktop"
  resetTourStore()
  resetTabStore()
  nav.spaNavigate.mockReset()
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

describe("the way to a step's screen", () => {
  it("a step in another app rings that app's rail entry, until the person is in it", async () => {
    railEntry()
    setTourApi(api(progress()))
    render(() => <TourOverlay />)
    await tourStore.load()
    await findTourMenuItem("tour-take-me-there")
    const spot = await screen.findByTestId("tour-spotlight")
    expect(spot.dataset.anchor).toBe("activity-*[data-rail-entry=desk]")
    expect(screen.queryByTestId("tour-scrim")).toBeNull()

    // In the app (its page still drawing): the rail ring drops.
    openTab({ type: "desk:inbox", entityId: "desk", label: "Desk" })
    await waitFor(() => expect(screen.queryByTestId("tour-spotlight")).toBeNull())
    el("desk-inbox")
    await waitFor(() =>
      expect(screen.getByTestId("tour-spotlight").dataset.anchor).toBe("desk-inbox"),
    )
  })

  it("phone: no rail, nothing ringed for it", async () => {
    tier.value = "phone"
    railEntry()
    setTourApi(api(progress()))
    render(() => <TourOverlay />)
    await tourStore.load()
    await screen.findByTestId("tour-panel")
    expect(screen.queryByTestId("tour-spotlight")).toBeNull()
  })

  it("the step about what the run brought in: from the list, Take me there opens that very one and its row is ringed", async () => {
    openTab({ type: "desk:inbox", entityId: "desk", label: "Desk" })
    railEntry()
    const row = el("desk-row-t-1")
    el("desk-row-t-2")
    setTourApi(api(AT_OPEN))
    render(() => <TourOverlay />)
    await tourStore.load()
    await screen.findByTestId("tour-panel")
    // On arrival: Take me there, the row ringed, no "waiting for this to appear".
    expect(await findTourMenuItem("tour-take-me-there")).toBeTruthy()
    await waitFor(() =>
      expect(screen.getByTestId("tour-spotlight").dataset.anchor).toBe("desk-row-t-1"),
    )
    expect(screen.queryByTestId("tour-anchor-waiting")).toBeNull()
    expect((screen.getByTestId("tour-next") as HTMLButtonElement).disabled).toBe(true)

    await pressTourMenuItem("tour-take-me-there")
    expect(nav.spaNavigate).toHaveBeenCalledWith("/desk/t-1")

    // Opened (by Take me there or a click on the row): the step is done.
    openTab({ type: "desk:detail", entityId: "t-1", label: "Item" })
    row.remove()
    el("desk-detail", { "data-item-id": "t-1" })
    await waitFor(() =>
      expect((screen.getByTestId("tour-next") as HTMLButtonElement).disabled).toBe(false),
    )
    expect(await tourMenuItem("tour-take-me-there")).toBeNull()
    expect(screen.queryByTestId("tour-anchor-waiting")).toBeNull()
    expect(screen.getByTestId("tour-spotlight").dataset.anchor).toBe(
      "desk-detail[data-item-id=t-1]",
    )
  })

  it("a nested way rings each hop in turn, and the panel shows only the hop to take now, n/m", async () => {
    railEntry()
    const at = progress({
      beatId: "deep",
      beatIndex: 3,
      beatStates: { inbox: "done", arrive: { state: "done", entityId: "t-1" }, open: "done" },
    })
    setTourApi(api(at))
    render(() => <TourOverlay />)
    await tourStore.load()
    /** The one hop the card shows: its "n/m", and never the whole list. */
    const states = () => {
      const hops = screen.getAllByTestId("tour-path-hop")
      expect(hops).toHaveLength(1)
      expect(hops[0]?.dataset.hopState).toBe("now")
      return screen.getByTestId("tour-path").textContent?.match(/^\d+\/\d+/)?.[0]
    }
    const ringed = () => screen.getByTestId("tour-spotlight").dataset.anchor
    // In another app: hop 1, the rail entry.
    await waitFor(() => expect(ringed()).toBe("activity-*[data-rail-entry=desk]"))
    expect(states()).toEqual("1/4")
    // In the app, on its list: hop 2, the item's row.
    openTab({ type: "desk:inbox", entityId: "desk", label: "Desk" })
    const row = el("desk-row-t-1")
    await waitFor(() => expect(ringed()).toBe("desk-row-t-1"))
    expect(states()).toEqual("2/4")
    // The item open: hop 3, its notes tab.
    openTab({ type: "desk:detail", entityId: "t-1", label: "Item" })
    row.remove()
    const tab = el("desk-tab-notes")
    await waitFor(() => expect(ringed()).toBe("desk-tab-notes"))
    expect(states()).toEqual("3/4")
    // There: the element itself, and the last hop is what is left to do.
    tab.remove()
    el("desk-notes")
    await waitFor(() => expect(ringed()).toBe("desk-notes"))
    expect(states()).toEqual("4/4")
    // Take me there stays as the shortcut while the element was away.
    expect(await tourMenuItem("tour-take-me-there")).toBeNull()
  })

  it("a step whose element is on screen on arrival lists no way", async () => {
    openTab({ type: "desk:detail", entityId: "t-1", label: "Item" })
    el("desk-notes")
    setTourApi(
      api(
        progress({
          beatId: "deep",
          beatIndex: 3,
          beatStates: { inbox: "done", arrive: { state: "done", entityId: "t-1" }, open: "done" },
        }),
      ),
    )
    render(() => <TourOverlay />)
    await tourStore.load()
    await waitFor(() =>
      expect(screen.getByTestId("tour-spotlight").dataset.anchor).toBe("desk-notes"),
    )
    expect(screen.queryByTestId("tour-path")).toBeNull()
  })

  it("opened but still drawing: it says so, with no Take me there to the screen it is on", async () => {
    openTab({ type: "desk:detail", entityId: "t-1", label: "Item" })
    setTourApi(api(AT_OPEN))
    render(() => <TourOverlay />)
    await tourStore.load()
    expect(await screen.findByTestId("tour-anchor-waiting")).toBeTruthy()
    expect(await tourMenuItem("tour-take-me-there")).toBeNull()
  })
})
