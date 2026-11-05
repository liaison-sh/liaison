// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A demo world beat in the panel: it says it is watching and has no Next;
// "Play whole scenario" waits on it (no show-beat timer) and moves on with the
// frame that says it happened; a gate frame renders the gate registered for
// it (or the engine's own line), and only for the beat it names.
import { defineTour, type TourProgress } from "@liaison/shared"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { pressTourMenuItem } from "./test-helpers"
import type { TourApi } from "./tour-api"

vi.mock("~/modules/shell/shell-tier", () => ({ shellTier: () => "desktop" }))
vi.mock("~/framework/spa-navigate", () => ({ spaNavigate: vi.fn() }))
const fixtures = vi.hoisted(() => ({ tours: [] as unknown[] }))
vi.mock("./tour-catalog", () => ({
  resolveTour: (id: string) => (fixtures.tours as { id: string }[]).find((t) => t.id === id),
}))

const { resetTourStore, setTourApi, tourStore } = await import("./tour-store")
const { TourOverlay } = await import("./TourHost")
const { registerTourBeatGate } = await import("./beat-gates")

const tour = defineTour({
  id: "kernel.world",
  app: "kernel",
  demoOnly: true,
  title: "tours.kernel.sample.title",
  summary: "tours.kernel.sample.summary",
  beats: [
    {
      id: "live",
      kind: "world",
      title: "tours.kernel.sample.liveTicket.title",
      body: "tours.kernel.sample.liveTicket.body",
      injector: "sample-ticket",
    },
    {
      id: "after",
      kind: "show",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
    },
  ],
})

const USER = "user-1"

function progress(beatId: string, beatIndex: number): TourProgress {
  return {
    tourId: "kernel.world",
    status: "active",
    beatId,
    beatIndex,
    beatCount: 2,
    beatStates: {},
    source: "demo",
    startedAt: "2026-10-23T10:00:00.000Z",
    updatedAt: "2026-10-23T10:00:00.000Z",
  }
}

let current: TourProgress
let api: TourApi

function frame(extra: Record<string, unknown> = {}) {
  return {
    ownerUserId: USER,
    tourId: "kernel.world",
    status: "active",
    beatId: current.beatId,
    beatIndex: current.beatIndex,
    emittedAt: new Date().toISOString(),
    ...extra,
  }
}

beforeEach(() => {
  fixtures.tours = [tour]
  resetTourStore()
  current = progress("live", 0)
  api = {
    list: vi.fn(async () => [
      {
        tourId: "kernel.world",
        app: "kernel",
        title: "",
        summary: "",
        beatCount: 2,
        progress: current,
      },
    ]),
    start: vi.fn(async () => current),
    update: vi.fn(async () => current),
    progress: vi.fn(async () => current),
  }
  setTourApi(api)
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ""
})

describe("world beat", () => {
  it("watches, with no Next and no Do it for me", async () => {
    render(() => <TourOverlay showBeatMs={20} />)
    await tourStore.load()
    expect(await screen.findByTestId("tour-world-watching")).toBeTruthy()
    expect(screen.queryByTestId("tour-next")).toBeNull()
    expect(screen.queryByTestId("tour-do-for-me")).toBeNull()
  })

  // The live event came: the step stays, to be read, until the visitor's Next
  // (it once flashed and vanished as the server moved on at once).
  it("once its live event arrived it stays on screen with Next, and only Next moves on", async () => {
    render(() => <TourOverlay showBeatMs={20} />)
    await tourStore.load()
    expect(await screen.findByTestId("tour-world-watching")).toBeTruthy()
    current = { ...progress("live", 0), beatStates: { live: { state: "done", entityId: "t-1" } } }
    tourStore.onFrame(frame(), USER)
    const next = await screen.findByTestId("tour-next")
    expect(screen.getByTestId("tour-panel").getAttribute("data-beat-id")).toBe("live")
    expect(screen.queryByTestId("tour-world-watching")).toBeNull()
    await new Promise((r) => setTimeout(r, 120))
    expect(api.update).not.toHaveBeenCalled()
    fireEvent.click(next)
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith("kernel.world", {
        advance: true,
        fromBeatId: "live",
      }),
    )
  })

  it("play-all reads an arrived live event for a moment, then presses Next itself", async () => {
    render(() => <TourOverlay showBeatMs={20} />)
    await tourStore.load()
    await pressTourMenuItem("tour-play-all")
    current = { ...progress("live", 0), beatStates: { live: "done" } }
    tourStore.onFrame(frame(), USER)
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith("kernel.world", {
        advance: true,
        fromBeatId: "live",
      }),
    )
  })

  it("play-all does not move on by a timer, and moves on with the frame", async () => {
    render(() => <TourOverlay showBeatMs={20} />)
    await tourStore.load()
    await pressTourMenuItem("tour-play-all")
    await new Promise((r) => setTimeout(r, 120))
    expect(api.update).not.toHaveBeenCalled()
    expect(screen.getByTestId("tour-panel").getAttribute("data-beat-id")).toBe("live")
    // The injector ran; the server moved the row and pushed a frame.
    current = progress("after", 1)
    tourStore.onFrame(frame(), USER)
    await waitFor(() =>
      expect(screen.getByTestId("tour-panel").getAttribute("data-beat-id")).toBe("after"),
    )
  })

  it("a gate frame renders its registered gate for that beat only, without a refetch", async () => {
    const off = registerTourBeatGate("verify", (p) => (
      <p data-testid="fixture-verify-gate">{p.gate}</p>
    ))
    render(() => <TourOverlay />)
    await tourStore.load()
    const reads = vi.mocked(api.progress).mock.calls.length
    tourStore.onFrame(frame({ gate: "verify" }), USER)
    expect((await screen.findByTestId("tour-beat-gate")).getAttribute("data-gate")).toBe("verify")
    expect(screen.getByTestId("fixture-verify-gate")).toBeTruthy()
    expect(screen.queryByTestId("tour-world-watching")).toBeNull()
    expect(vi.mocked(api.progress).mock.calls.length).toBe(reads)
    // Another user's gate frame, or one for another beat, shows nothing.
    off()
    tourStore.clearGate()
    tourStore.onFrame(frame({ gate: "failed", ownerUserId: "someone-else" }), USER)
    tourStore.onFrame(frame({ gate: "failed", beatId: "after" }), USER)
    await waitFor(() => expect(screen.queryByTestId("tour-beat-gate")).toBeNull())
  })

  it("a gate with no registered component shows the engine's own line", async () => {
    render(() => <TourOverlay />)
    await tourStore.load()
    tourStore.onFrame(frame({ gate: "budget" }), USER)
    const gate = await screen.findByTestId("tour-beat-gate")
    expect(gate.textContent).toContain("budget")
  })
})
