// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The scenario runner: the queue in pick order, nothing started on load (a
// reload resumes the paused one through the chip), the completion card
// offering the next scenario (resumed when unfinished), and nothing started by
// itself after a whole-scenario play. What the visitor starts from is the
// welcome popup (DemoWelcome.test.tsx).
import { findTour, type TourListItem, type TourProgress } from "@liaison/shared"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TourApi } from "~/modules/tours/tour-api"
import type { DemoScenarioItem } from "./DemoScenarioRunner"

vi.mock("~/modules/shell/shell-tier", () => ({ shellTier: () => "desktop" }))
vi.mock("~/framework/spa-navigate", () => ({ spaNavigate: vi.fn() }))
vi.mock("~/modules/tours/tour-catalog", () => ({ resolveTour: (id: string) => findTour(id) }))
const client = vi.hoisted(() => ({
  queue: [] as unknown[],
  get: vi.fn(),
  post: vi.fn(async () => ({ outcome: "completed" })),
}))
vi.mock("~/modules/shell/ApiContext", () => ({
  useOptionalApi: () => ({ get: client.get, post: client.post }),
}))

const { resetTourStore, setTourApi, tourStore } = await import("~/modules/tours/tour-store")
const { TourOverlay } = await import("~/modules/tours/TourHost")
const { COMPLETED_CARD_MS } = await import("~/modules/tours/tour-store")
const { DemoScenarioRunner, DemoScenarioRunnerTestAccess, demoScenarioQueue, openScenario } =
  await import("./DemoScenarioRunner")
const { _resetDemoStore, demoNextSteps } = await import("./demo-store")

const item = (need: DemoScenarioItem["need"], status: DemoScenarioItem["status"]) => ({
  need,
  tourId: `kernel.scenario-${need}`,
  status,
  beatIndex: 0,
  beatCount: 8,
})

function progress(tourId: string, status: TourProgress["status"]): TourProgress {
  const tour = findTour(tourId)
  return {
    tourId,
    status,
    beatId: status === "completed" ? null : (tour?.beats[0]?.id ?? null),
    beatIndex: status === "completed" ? 8 : 0,
    beatCount: 8,
    beatStates: {},
    source: "demo",
    startedAt: "2026-10-23T10:00:00.000Z",
    updatedAt: "2026-10-23T10:00:00.000Z",
  }
}

function tourApi(list: TourListItem[]): TourApi {
  return {
    list: vi.fn(async () => list),
    start: vi.fn(async (tourId: string) => progress(tourId, "active")),
    update: vi.fn(async (tourId: string) => progress(tourId, "paused")),
    progress: vi.fn(async (tourId: string) => progress(tourId, "active")),
  }
}

function listItem(tourId: string, p: TourProgress | null): TourListItem {
  return { tourId, app: "kernel", title: "", summary: "", beatCount: 8, progress: p }
}

beforeEach(() => {
  resetTourStore()
  _resetDemoStore()
  DemoScenarioRunnerTestAccess.reset()
  client.get.mockReset()
  client.get.mockImplementation(async () => client.queue)
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ""
})

function mount() {
  render(() => (
    <>
      <DemoScenarioRunner />
      <TourOverlay showBeatMs={5000} />
    </>
  ))
}

describe("DemoScenarioRunner", () => {
  // Walk D43: a scenario starts only when the visitor starts it.
  it("starts nothing on load, and reads the queue in pick order", async () => {
    client.queue = [item("sales", "completed"), item("support", "new"), item("dev", "new")]
    const api = tourApi([])
    setTourApi(api)
    mount()
    await tourStore.load()
    await waitFor(() =>
      expect(demoScenarioQueue().map((i) => i.need)).toEqual(["sales", "support", "dev"]),
    )
    await new Promise((r) => setTimeout(r, 50))
    expect(api.start).not.toHaveBeenCalled()
    expect(client.get).toHaveBeenCalledWith("/demo/scenarios")
  })

  // A chat window the previous scenario left open would cover what this one points at.
  it("a scenario starts with every chat window put away, the conversations kept", async () => {
    const dock = await import("~/modules/shell/dock-store")
    dock.resetDockStore()
    dock.openConversation("thread-left-open", { expand: true })
    expect(dock.visibleTabs().some((t) => t.expanded)).toBe(true)
    client.queue = [item("dev", "new")]
    const api = tourApi([])
    setTourApi(api)
    mount()
    await tourStore.load()
    await waitFor(() => expect(demoScenarioQueue()).toHaveLength(1))
    void openScenario(item("dev", "new"))
    await waitFor(() => expect(api.start).toHaveBeenCalledWith("kernel.scenario-dev", "demo"))
    expect(dock.visibleTabs().some((t) => t.expanded)).toBe(false)
    expect(dock.tabs().map((t) => t.threadId)).toContain("thread-left-open")
    expect(dock.chatsOpen()).toBe(false)
    dock.resetDockStore()
  })

  it("starts nothing when a tour is already on screen (a reload: the paused one stays a chip)", async () => {
    client.queue = [item("support", "paused"), item("chat", "new")]
    const paused = progress("kernel.scenario-support", "paused")
    const api = tourApi([listItem("kernel.scenario-support", paused)])
    setTourApi(api)
    mount()
    await tourStore.load()
    expect(await screen.findByTestId("tour-chip")).toBeTruthy()
    await new Promise((r) => setTimeout(r, 50))
    expect(api.start).not.toHaveBeenCalled()
  })

  it("the completion card offers the next scenario and starts it on click", async () => {
    client.queue = [item("support", "active"), item("chat", "new")]
    const api = tourApi([
      listItem("kernel.scenario-support", progress("kernel.scenario-support", "active")),
    ])
    setTourApi(api)
    mount()
    await tourStore.load()
    client.queue = [item("support", "completed"), item("chat", "new")]
    vi.mocked(api.progress).mockResolvedValueOnce(progress("kernel.scenario-support", "completed"))
    await tourStore.refresh("kernel.scenario-support")
    const next = await screen.findByTestId("demo-scenario-next")
    expect(next.getAttribute("data-tour-id")).toBe("kernel.scenario-chat")
    fireEvent.click(next)
    await waitFor(() => expect(api.start).toHaveBeenCalledWith("kernel.scenario-chat", "demo"))
  })

  // Walk D43: the queue restarted an unfinished scenario by itself, in a new
  // conversation, after each whole-scenario play, and every re-run spent.
  it("after a whole-scenario play, the next one does not start by itself", async () => {
    client.queue = [item("support", "active"), item("chat", "new")]
    const api = tourApi([
      listItem("kernel.scenario-support", progress("kernel.scenario-support", "active")),
    ])
    setTourApi(api)
    mount()
    await tourStore.load()
    tourStore.setPlayAll(true)
    client.queue = [item("support", "completed"), item("chat", "new")]
    vi.mocked(api.progress).mockResolvedValueOnce(progress("kernel.scenario-support", "completed"))
    await tourStore.refresh("kernel.scenario-support")
    expect(await screen.findByTestId("demo-scenario-next")).toBeTruthy()
    await new Promise((r) => setTimeout(r, 50))
    expect(api.start).not.toHaveBeenCalled()
  })

  it("Next on an unfinished scenario resumes it, never starts it over", async () => {
    client.queue = [item("support", "active"), item("chat", "paused")]
    const api = tourApi([
      listItem("kernel.scenario-support", progress("kernel.scenario-support", "active")),
      listItem("kernel.scenario-chat", progress("kernel.scenario-chat", "paused")),
    ])
    setTourApi(api)
    mount()
    await tourStore.load()
    client.queue = [item("support", "completed"), item("chat", "paused")]
    vi.mocked(api.progress).mockResolvedValueOnce(progress("kernel.scenario-support", "completed"))
    await tourStore.refresh("kernel.scenario-support")
    fireEvent.click(await screen.findByTestId("demo-scenario-next"))
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith("kernel.scenario-chat", { status: "active" }),
    )
    expect(api.start).not.toHaveBeenCalled()
  })

  // Walk D45: the card's "Next: <scenario>" went after 6 s, and since nothing
  // goes on by itself it was the only prompt to continue.
  it("the completion card offering the next scenario stays until the visitor acts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      client.queue = [item("support", "active"), item("chat", "new")]
      const api = tourApi([
        listItem("kernel.scenario-support", progress("kernel.scenario-support", "active")),
      ])
      setTourApi(api)
      mount()
      await tourStore.load()
      client.queue = [item("support", "completed"), item("chat", "new")]
      vi.mocked(api.progress).mockResolvedValueOnce(
        progress("kernel.scenario-support", "completed"),
      )
      await tourStore.refresh("kernel.scenario-support")
      expect(await screen.findByTestId("demo-scenario-next")).toBeTruthy()
      await vi.advanceTimersByTimeAsync(COMPLETED_CARD_MS * 10)
      expect(screen.getByTestId("demo-scenario-next")).toBeTruthy()
      fireEvent.click(screen.getByTestId("tour-completed-close"))
      expect(screen.queryByTestId("tour-completed")).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  describe("after the last scenario", () => {
    async function finishLast(): Promise<void> {
      client.queue = [item("sales", "completed"), item("support", "active")]
      const api = tourApi([
        listItem("kernel.scenario-support", progress("kernel.scenario-support", "active")),
      ])
      setTourApi(api)
      mount()
      await tourStore.load()
      client.queue = [item("sales", "completed"), item("support", "completed")]
      vi.mocked(api.progress).mockResolvedValueOnce(
        progress("kernel.scenario-support", "completed"),
      )
      await tourStore.refresh("kernel.scenario-support")
    }

    it("opens the next-steps dialog at the end, in place of the completion card", async () => {
      await finishLast()
      await waitFor(() => expect(demoNextSteps()).toBe("end"))
      expect(screen.queryByTestId("tour-completed")).toBeNull()
      expect(screen.queryByTestId("demo-scenario-next")).toBeNull()
    })
  })
})
