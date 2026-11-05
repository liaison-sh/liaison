// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A beat that pointed into a dialog (the Company knowledge scenario's Share
// dialog) closes it when the person presses Next: left open, it covered the
// Chats entry the next step rings. A next beat inside the same dialog keeps it.
import { defineTour, type TourListItem, type TourProgress } from "@liaison/shared"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Dialog } from "~/ui/Dialog"
import type { TourApi } from "./tour-api"

vi.mock("~/modules/shell/shell-tier", () => ({ shellTier: () => "desktop" }))
vi.mock("~/framework/spa-navigate", () => ({ spaNavigate: vi.fn() }))
vi.mock("~/modules/shell/dock-store", () => ({ putAwayWindows: vi.fn() }))

const fixtures = vi.hoisted(() => ({ tours: [] as unknown[] }))
vi.mock("./tour-catalog", () => ({
  resolveTour: (id: string) => (fixtures.tours as { id: string }[]).find((t) => t.id === id),
}))

const { resetTourStore, setTourApi, tourStore } = await import("./tour-store")
const { TourOverlay } = await import("./TourHost")

const beat = (id: string, anchor: string) => ({
  id,
  kind: "show" as const,
  title: "tours.kernel.sample.welcome.title",
  body: "tours.kernel.sample.welcome.body",
  anchor,
})

/** The share step, then a step on the page behind the dialog. */
const leaves = defineTour({
  id: "kernel.dialog-leaves",
  app: "kernel",
  title: "tours.kernel.sample.title",
  summary: "tours.kernel.sample.summary",
  beats: [beat("share", "fixture-dialog"), beat("ask", "fixture-behind")],
})
/** The share step, then a step on a control inside the same dialog. */
const stays = defineTour({
  ...leaves,
  id: "kernel.dialog-stays",
  beats: [beat("share", "fixture-dialog"), beat("roles", "fixture-dialog-roles")],
})

function progress(tourId: string, beatId: string, beatIndex: number): TourProgress {
  return {
    tourId,
    status: "active",
    beatId,
    beatIndex,
    beatCount: 2,
    beatStates: {},
    source: "help",
    startedAt: "2026-10-23T10:00:00.000Z",
    updatedAt: "2026-10-23T10:00:00.000Z",
  }
}

function api(tourId: string, nextBeat: string): TourApi {
  const item: TourListItem = {
    tourId,
    app: "kernel",
    title: leaves.title,
    summary: leaves.summary,
    beatCount: 2,
    progress: progress(tourId, "share", 0),
  }
  return {
    list: vi.fn(async () => [item]),
    start: vi.fn(async (id: string) => progress(id, "share", 0)),
    update: vi.fn(async (id: string) => progress(id, nextBeat, 1)),
    progress: vi.fn(async (id: string) => progress(id, "share", 0)),
  }
}

/** The page with its Share dialog open, as the share step leaves it. */
function renderPageWithDialog() {
  const [open, setOpen] = createSignal(true)
  const onOpenChange = vi.fn((next: boolean) => setOpen(next))
  render(() => (
    <>
      <div data-testid="fixture-behind">Chats</div>
      <Dialog open={open()} onOpenChange={onOpenChange}>
        <Dialog.Content data-testid="fixture-dialog">
          <Dialog.Title>Share</Dialog.Title>
          <div data-testid="fixture-dialog-roles">Roles with access</div>
        </Dialog.Content>
      </Dialog>
      <TourOverlay />
    </>
  ))
  return { open, onOpenChange }
}

beforeEach(() => {
  fixtures.tours = [leaves, stays]
  resetTourStore()
  // jsdom lays nothing out: every element gets a box.
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

describe("a beat that pointed into a dialog", () => {
  it("closes the dialog when the person presses Next", async () => {
    setTourApi(api(leaves.id, "ask"))
    const page = renderPageWithDialog()
    await tourStore.load()
    await screen.findByTestId("tour-panel")
    expect(page.open()).toBe(true)
    fireEvent.click(screen.getByTestId("tour-next"))
    await waitFor(() => expect(screen.getByTestId("tour-panel").dataset.beatId).toBe("ask"))
    await waitFor(() => expect(page.open()).toBe(false))
    expect(page.onOpenChange).toHaveBeenCalledWith(false)
  })

  it("keeps the dialog when the next beat points inside it", async () => {
    setTourApi(api(stays.id, "roles"))
    const page = renderPageWithDialog()
    await tourStore.load()
    await screen.findByTestId("tour-panel")
    fireEvent.click(screen.getByTestId("tour-next"))
    await waitFor(() => expect(screen.getByTestId("tour-panel").dataset.beatId).toBe("roles"))
    expect(page.open()).toBe(true)
    expect(page.onOpenChange).not.toHaveBeenCalled()
  })
})
