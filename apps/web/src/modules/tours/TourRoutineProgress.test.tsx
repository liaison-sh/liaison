// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A step that waits on a routine says what that routine is doing, from the
// server's own word on its run (owner, 2026-10-25: "something that shows
// routine progress on the runner card so the user knows something is
// brewing"): working on it, with the time it has taken; finished; stopped
// with an error; or did not run, and why, with the way to fix it.
//
// The word is the step status the server computes from its rows
// (`TourProgress.beatStatus`), read on load, on every tour frame and on a
// reconnect. Live demo 2026-10-26: the card kept saying the routine was
// running after the step was done, from a run frame it remembered. A step the
// server recorded done is never shown as running.
import {
  defineTour,
  type TourBeatStatus,
  type TourListItem,
  type TourProgress,
} from "@liaison/shared"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
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

const { dispatchWsEntityEvent } = await import("~/framework/app-registry")
const { resetTourStore, setTourApi, tourStore } = await import("./tour-store")
const { TourOverlay } = await import("./TourHost")

const tour = defineTour({
  id: "kernel.routine-wait",
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
      id: "note",
      kind: "do",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      anchor: "desk-conversation",
      event: {
        app: "desk",
        entity: "note",
        action: "create",
        match: { itemId: "{arrive}" },
        actor: "any",
      },
      autoplay: [{ waitEvent: true }],
    },
  ],
})

const server = vi.hoisted(() => ({
  status: { kind: "pending" } as unknown,
  beatStates: {} as Record<string, unknown>,
}))

const base: TourProgress = {
  tourId: tour.id,
  status: "active",
  beatId: "note",
  beatIndex: 1,
  beatCount: 2,
  beatStates: { arrive: { state: "done", entityId: "t-1" } },
  source: "demo",
  startedAt: "2026-10-25T10:00:00.000Z",
  updatedAt: "2026-10-25T10:00:00.000Z",
}

const progress = (): TourProgress => ({
  ...base,
  beatStates: { ...base.beatStates, ...(server.beatStates as TourProgress["beatStates"]) },
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

/** The server pushes the one tour frame; the card re-reads its progress. */
function tourFrame(): void {
  dispatchWsEntityEvent(
    "kernel:tour",
    "update",
    {
      ownerUserId: "u-1",
      tourId: tour.id,
      status: "active",
      beatId: "note",
      beatIndex: 1,
      emittedAt: new Date().toISOString(),
    },
    CTX,
  )
}

async function serve(status: TourBeatStatus): Promise<void> {
  server.status = status
  tourFrame()
  await new Promise((r) => setTimeout(r, 0))
}

const line = () => screen.queryByTestId("tour-routine-progress")
const running = (agoMs: number): TourBeatStatus => ({
  kind: "routine-running",
  routineName: "Support first look",
  startedAt: new Date(Date.now() - agoMs).toISOString(),
})

async function mount(): Promise<void> {
  setTourApi(api())
  render(() => <TourOverlay />)
  await tourStore.load()
  await screen.findByTestId("tour-panel")
}

beforeEach(async () => {
  fixtures.tours = [tour]
  resetTourStore()
  server.status = { kind: "pending" }
  server.beatStates = {}
  nav.spaNavigate.mockReset()
  const { subscribeToTourFrames } = await import("./TourHost")
  subscribeToTourFrames()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.body.innerHTML = ""
})

describe("a step waiting on a routine says what the server says the routine is doing", () => {
  it("working on it, with the time it has taken, then finished after a long run", async () => {
    await mount()
    expect(line()).toBeNull()
    await serve(running(65_000))
    const working = await screen.findByTestId("tour-routine-progress")
    expect(working.dataset.status).toBe("running")
    expect(working.textContent).toContain("Support first look")
    expect(working.textContent).toMatch(/1:0[5-7]/)
    // Calm: a quiet line, never an alarm. One line says what is going on.
    expect(working.className).not.toContain("text-error")
    expect(screen.queryByTestId("tour-working")).toBeNull()
    await serve({ kind: "routine-succeeded", routineName: "Support first look" })
    await waitFor(() => expect(line()?.dataset.status).toBe("succeeded"))
  })

  it("the step done after a long run: Next, and never the routine running", async () => {
    await mount()
    await serve(running(77_000))
    await screen.findByTestId("tour-routine-progress")
    // The routine wrote its note: the server records the step done.
    server.beatStates = { note: { state: "done", entityId: "n-1" } }
    await serve({ kind: "done", held: false })
    await waitFor(() =>
      expect((screen.getByTestId("tour-next") as HTMLButtonElement).disabled).toBe(false),
    )
    expect(line()).toBeNull()
    expect(screen.queryByTestId("tour-working")).toBeNull()
  })

  it("a step done is never shown running, even on a status that says otherwise", async () => {
    server.beatStates = { note: { state: "done", entityId: "n-1" } }
    server.status = running(10_000)
    await mount()
    await screen.findByTestId("tour-next")
    expect(line()).toBeNull()
  })

  it("did not run: says why, and offers the way to set up a model", async () => {
    await mount()
    await serve({
      kind: "routine-skipped",
      routineName: "Support first look",
      status: "skipped_no_credits",
      error: "No model is set up for this workspace.",
    })
    const skipped = await screen.findByTestId("tour-routine-progress")
    expect(skipped.dataset.status).toBe("skipped")
    expect(skipped.textContent).toContain("No model is set up for this workspace.")
    fireEvent.click(screen.getByTestId("tour-routine-setup"))
    expect(nav.spaNavigate).toHaveBeenCalledWith("/settings/ai-models")
  })

  it("stopped with an error: says so plainly, with the error", async () => {
    await mount()
    await serve({
      kind: "routine-failed",
      routineName: "Support first look",
      error: "The model provider refused the request.",
    })
    const failed = await screen.findByTestId("tour-routine-progress")
    expect(failed.dataset.status).toBe("failed")
    expect(failed.textContent).toContain("The model provider refused the request.")
    expect(screen.queryByTestId("tour-routine-setup")).toBeNull()
  })

  it("a page reloaded mid-run reads the run from the server", async () => {
    server.status = running(30_000)
    await mount()
    expect((await screen.findByTestId("tour-routine-progress")).dataset.status).toBe("running")
  })

  it("a reconnect that missed the run's end re-reads the server: finished, not running", async () => {
    await mount()
    await serve(running(30_000))
    await screen.findByTestId("tour-routine-progress")
    // The end frame was lost with the socket; the resync re-reads progress.
    server.status = { kind: "routine-succeeded", routineName: "Support first look" }
    const { requestResync } = await import("~/framework/resync")
    requestResync("ws-reconnect")
    await waitFor(() => expect(line()?.dataset.status).toBe("succeeded"))
  })

  it("no routine frame is read: a routine frame alone changes nothing on the card", async () => {
    await mount()
    dispatchWsEntityEvent(
      "kernel:routine",
      "run_started",
      { routineId: "r-1", eventEntityId: "t-1", startedAt: new Date().toISOString() },
      CTX,
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(line()).toBeNull()
  })

  // Walk 2026-10-26: a step the routine does showed "I'll do it" and "Do it
  // for me" beside the routine's line ("Do it for me: do what?").
  it("a step the routine does offers nothing to do: the line, and Next once it is done", async () => {
    await mount()
    await serve(running(3_000))
    await screen.findByTestId("tour-routine-progress")
    expect(screen.queryByTestId("tour-do-for-me")).toBeNull()
    expect(screen.queryByTestId("tour-do-myself")).toBeNull()
    expect((screen.getByTestId("tour-next") as HTMLButtonElement).disabled).toBe(true)
    // Before any run is reported, it says the work is under way, still with nothing to do.
    await serve({ kind: "pending" })
    await waitFor(() => expect(line()).toBeNull())
    expect(screen.getByTestId("tour-working")).toBeTruthy()
    expect(screen.queryByTestId("tour-do-for-me")).toBeNull()
    server.beatStates = { note: { state: "done", entityId: "n-1" } }
    await serve({ kind: "done", held: false })
    await waitFor(() =>
      expect((screen.getByTestId("tour-next") as HTMLButtonElement).disabled).toBe(false),
    )
    expect(screen.getByTestId("tour-beat-body").dataset.done).toBe("")
  })

  // Walk 2026-10-26: "(0:00)" 8 s into a run. The time taken is the run's,
  // and it ticks on even when the server's clock runs ahead of this one.
  it("the time taken ticks from the run's start, also when the server's clock is ahead", async () => {
    await mount()
    await serve(running(8_000))
    expect((await screen.findByTestId("tour-routine-progress")).textContent).toMatch(/0:0[89]/)
    await serve({
      kind: "routine-running",
      routineName: "Support first look",
      startedAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await waitFor(() => expect(line()?.textContent).toContain("0:00"))
    await waitFor(() => expect(line()?.textContent).toMatch(/0:0[1-3]/), { timeout: 3000 })
  })
})
