// SPDX-License-Identifier: FSL-1.1-ALv2
//
// After the visitor approves, the approval waits out its undo window before it
// really happens. The approve step says so and rings the toast that offers
// Undo for as long as it is there; once the approval went through, the step
// moves on with its event as before.
import { defineTour, type TourProgress } from "@liaison/shared"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TourApi } from "./tour-api"

vi.mock("~/modules/shell/shell-tier", () => ({ shellTier: () => "desktop" }))
vi.mock("~/framework/spa-navigate", () => ({ spaNavigate: vi.fn() }))
const fixtures = vi.hoisted(() => ({ tours: [] as unknown[] }))
vi.mock("./tour-catalog", () => ({
  resolveTour: (id: string) => (fixtures.tours as { id: string }[]).find((t) => t.id === id),
}))
const toasts = vi.hoisted(() => ({
  items: null as null | (() => unknown[]),
  set: null as null | ((v: unknown[]) => void),
}))
vi.mock("~/modules/approvals/decision-queue", async () => {
  const [items, setItems] = createSignal<unknown[]>([])
  toasts.items = items
  toasts.set = setItems
  return { decisionToastItems: items }
})

const { resetTourStore, setTourApi, tourStore } = await import("./tour-store")
const { TourOverlay } = await import("./TourHost")

const tour = defineTour({
  id: "kernel.undo",
  app: "kernel",
  title: "tours.kernel.sample.title",
  summary: "tours.kernel.sample.summary",
  beats: [
    {
      id: "approve",
      kind: "do",
      title: "tours.kernel.sample.postMessage.title",
      body: "tours.kernel.sample.postMessage.body",
      anchor: "approval-card",
      event: {
        app: "kernel",
        entity: "approval_request",
        action: "update",
        match: { status: "approved" },
      },
      autoplay: [{ click: "approval-card-action-approve" }, { waitEvent: true }],
      undo: {
        title: "tours.scenarios.common.undoTitle",
        role: "tours.scenarios.common.undoRole",
        body: "tours.scenarios.support.approve.undo",
      },
    },
    {
      id: "after",
      kind: "show",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
    },
  ],
})

const current: TourProgress = {
  tourId: "kernel.undo",
  status: "active",
  beatId: "approve",
  beatIndex: 0,
  beatCount: 2,
  beatStates: {},
  source: "help",
  startedAt: "2026-10-25T10:00:00.000Z",
  updatedAt: "2026-10-25T10:00:00.000Z",
}

function el(testid: string): HTMLElement {
  const node = document.createElement("div")
  node.dataset.testid = testid
  document.body.append(node)
  return node
}

beforeEach(() => {
  fixtures.tours = [tour]
  toasts.set?.([])
  resetTourStore()
  const api: TourApi = {
    list: vi.fn(async () => [
      {
        tourId: "kernel.undo",
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

describe("the undo window after an approval", () => {
  it("rings the toast offering Undo and explains it while it is there, then the step reads as before", async () => {
    el("approval-card")
    render(() => <TourOverlay />)
    await tourStore.load()
    await waitFor(() =>
      expect(screen.getByTestId("tour-spotlight").dataset.anchor).toBe("approval-card"),
    )
    const title = () => screen.getByTestId("tour-beat-title").textContent
    const before = title()

    // Approved: the decision waits out its window in the toast.
    const toast = el("decision-toast")
    toasts.set?.([{ kind: "approval", decision: "approve", id: "a-1", phase: "queued" }])
    await waitFor(() =>
      expect(screen.getByTestId("tour-spotlight").dataset.anchor).toBe("decision-toast*"),
    )
    expect(title()).toContain("undoable")
    expect(screen.getByTestId("tour-beat-role").textContent).toContain("waits a few seconds")
    expect(screen.getByTestId("tour-beat-body").textContent).toContain("Undo")
    expect(screen.queryByTestId("tour-do-for-me")).toBeNull()

    // Undone (or gone through): the toast leaves, the step is the approve step again.
    toast.remove()
    toasts.set?.([])
    await waitFor(() => expect(title()).toBe(before))
    expect(screen.getByTestId("tour-spotlight").dataset.anchor).toBe("approval-card")
  })
})
