// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Walk D46 (manual): one "Do it for me" on Support's "Approve the reply", with
// the draft card on screen, approved nothing and the step then offered only
// "Do it for me" again, for good. The press started the script, then the tour's
// progress was read again while the routine still wrote (its draft and its
// note landed out of order): the panel left the step for an instant and came
// back, which aborted the script and cleared the step's state. A press is the
// person's request for that step: when the step comes back, it plays on.
import { defineTour, type TourProgress } from "@liaison/shared"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TourApi } from "./tour-api"

vi.mock("~/modules/shell/shell-tier", () => ({ shellTier: () => "desktop" }))
vi.mock("~/framework/spa-navigate", () => ({ spaNavigate: vi.fn() }))
const fixtures = vi.hoisted(() => ({ tours: [] as unknown[] }))
vi.mock("./tour-catalog", () => ({
  resolveTour: (id: string) => (fixtures.tours as { id: string }[]).find((t) => t.id === id),
}))

const { applyProgress, resetTourStore, setTourApi, tourStore } = await import("./tour-store")
const { TourOverlay } = await import("./TourHost")

const tour = defineTour({
  id: "kernel.fixture-approve",
  app: "kernel",
  title: "tours.knowledge.basics.title",
  summary: "tours.knowledge.basics.summary",
  beats: [
    {
      id: "draft",
      kind: "do",
      title: "tours.knowledge.basics.create.title",
      body: "tours.knowledge.basics.create.body",
      event: { app: "kernel", entity: "approval_request", action: "create" },
      autoplay: [{ waitEvent: true }],
    },
    {
      id: "approve",
      kind: "do",
      title: "tours.knowledge.basics.create.title",
      body: "tours.knowledge.basics.create.body",
      event: { app: "kernel", entity: "approval_request", action: "update" },
      waitsOn: "routine",
      autoplay: [{ waitFor: "fixture-approve" }, { click: "fixture-approve" }, { waitEvent: true }],
    },
    {
      id: "sent",
      kind: "show",
      title: "tours.knowledge.basics.recent.title",
      body: "tours.knowledge.basics.recent.body",
    },
  ],
})

function at(
  beatId: string,
  beatIndex: number,
  updatedAt: string,
  beatStates: TourProgress["beatStates"] = beatIndex > 0
    ? { draft: { state: "done", entityId: "req-1" } }
    : {},
): TourProgress {
  return {
    tourId: tour.id,
    status: "active",
    beatId,
    beatIndex,
    beatCount: 3,
    beatStates,
    source: "help",
    startedAt: "2026-10-24T10:00:00.000Z",
    updatedAt,
  }
}

function api(p: TourProgress): TourApi {
  return {
    list: vi.fn(async () => [
      { tourId: tour.id, app: "kernel", title: tour.title, summary: "", beatCount: 2, progress: p },
    ]),
    start: vi.fn(async () => p),
    update: vi.fn(async () => p),
    progress: vi.fn(async () => p),
  }
}

const timing = { typeDelayMs: 0, stepPauseMs: 0, findTimeoutMs: 50, showBeatMs: 30 }

beforeEach(() => {
  fixtures.tours = [tour]
  resetTourStore()
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ""
})

describe("Do it for me on a step the panel briefly leaves", () => {
  it("plays on when the step comes back, and presses what it waited for", async () => {
    setTourApi(api(at("approve", 1, "2026-10-24T10:00:02.000Z")))
    render(() => <TourOverlay {...timing} waitOnMs={{ routine: 5_000 }} />)
    await tourStore.load()
    fireEvent.click(await screen.findByTestId("tour-do-for-me"))
    await waitFor(() => expect(tourStore.autoplay.status).toBe("playing"))

    // A read of the tour lands on the step before, then the step again.
    applyProgress(tour.id, at("draft", 0, "2026-10-24T10:00:03.000Z"))
    await new Promise((r) => setTimeout(r, 20))
    applyProgress(tour.id, at("approve", 1, "2026-10-24T10:00:04.000Z"))

    // The card it waits for arrives: the step presses it.
    const approve = document.createElement("button")
    approve.dataset.testid = "fixture-approve"
    approve.getClientRects = () => [{}] as unknown as DOMRectList
    const clicked = vi.fn()
    approve.addEventListener("click", clicked)
    document.body.append(approve)
    await waitFor(() => expect(clicked).toHaveBeenCalledTimes(1), { timeout: 3_000 })
  })

  it("forgets the press once its step is done: a later run of the tour plays nothing unasked", async () => {
    setTourApi(api(at("approve", 1, "2026-10-24T10:00:02.000Z")))
    render(() => <TourOverlay {...timing} waitOnMs={{ routine: 5_000 }} />)
    await tourStore.load()
    fireEvent.click(await screen.findByTestId("tour-do-for-me"))
    await waitFor(() => expect(tourStore.autoplay.status).toBe("playing"))
    // Approved meanwhile by hand: the tour moves on with the step done.
    applyProgress(
      tour.id,
      at("sent", 2, "2026-10-24T10:00:03.000Z", {
        draft: { state: "done", entityId: "req-1" },
        approve: "done",
      }),
    )
    await new Promise((r) => setTimeout(r, 20))
    // The tour is played again from that step, on a fresh run.
    applyProgress(tour.id, at("approve", 1, "2026-10-24T10:00:04.000Z"))
    await new Promise((r) => setTimeout(r, 50))
    expect(tourStore.autoplay.status).toBe("idle")
  })

  it("does not play a step the person never asked it to", async () => {
    setTourApi(api(at("approve", 1, "2026-10-24T10:00:02.000Z")))
    render(() => <TourOverlay {...timing} waitOnMs={{ routine: 5_000 }} />)
    await tourStore.load()
    await screen.findByTestId("tour-do-for-me")
    applyProgress(tour.id, at("draft", 0, "2026-10-24T10:00:03.000Z"))
    await new Promise((r) => setTimeout(r, 20))
    applyProgress(tour.id, at("approve", 1, "2026-10-24T10:00:04.000Z"))
    await new Promise((r) => setTimeout(r, 50))
    expect(tourStore.autoplay.status).toBe("idle")
  })
})
