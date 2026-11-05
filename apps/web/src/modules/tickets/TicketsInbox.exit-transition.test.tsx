// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Ticket 10344: a ticket that left the currently-filtered list (closed via a
// gated reply approved on its detail tab, merged away, ...) used to vanish
// from the list the INSTANT the store update landed. Every row below jumped
// up in the same frame, so a click already headed for one of those rows
// landed on whatever ticket had just shifted into that screen position.
//
// Fix: TicketsInbox keeps a removed row rendered (fading out, not clickable)
// for a short exit transition instead of dropping it from the DOM the same
// tick the store drops it from `ticketListStore.ids`.
//
// Uses the REAL ticket-list-store (not mocked) so `applyTicketUpdateToList`
// exercises the exact code path a WS `tickets:ticket update` event drives.

import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  api: { post: vi.fn() } as any,
  ws: { status: () => "connected" as const },
  openTab: vi.fn(),
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => state.api }))
vi.mock("~/modules/shell/WsContext", () => ({ useWs: () => state.ws }))
vi.mock("~/modules/tickets/ticket-inbox-store", () => ({
  loadInboxes: vi.fn(),
  ticketInboxStore: {
    get inboxes() {
      return []
    },
    get loaded() {
      return true
    },
  },
}))
vi.mock("~/modules/tickets/ticket-category-store", () => ({
  loadCategories: vi.fn(),
  ticketCategoryStore: {
    get categories() {
      return [] as any[]
    },
    get loaded() {
      return true
    },
  },
}))
vi.mock("~/modules/shell/tab-store", () => ({
  openTab: state.openTab,
  tabStore: {
    get tabs() {
      return []
    },
    get activeTabId() {
      return null
    },
  },
}))

import {
  applyTicketMessageToList,
  applyTicketUpdateToList,
  loadTickets,
  paramsForSmartFilter,
  resetTicketListStore,
  setListParams,
} from "~/modules/tickets/ticket-list-store"
import { TicketsInbox } from "./TicketsInbox"

/** DOM order of rendered ticket rows, reading the list container directly
 *  (not `getAllByTestId`, which does not guarantee document order across
 *  distinct testids) so a reorder is actually provable. */
function renderedRowOrder(): string[] {
  const prefix = "tickets-list-row-"
  return Array.from(
    screen.getByTestId("tickets-list").querySelectorAll(`[data-testid^="${prefix}"]`),
  ).map((el) => el.getAttribute("data-testid")!.slice(prefix.length))
}

describe("TicketsInbox — a ticket leaving the list does not reflow rows instantly", () => {
  beforeEach(() => {
    state.api.post.mockReset()
    state.openTab.mockReset()
  })

  it("keeps the removed row in place (uninteractive) for the exit transition, then closes the gap", async () => {
    resetTicketListStore()
    setListParams(paramsForSmartFilter("all-open"))
    state.api.post.mockResolvedValue({
      items: [
        { id: "t1", handle: "ticket-1", subject: "First", status: "open", priority: "normal" },
        {
          id: "t2",
          handle: "ticket-2",
          subject: "Second",
          status: "awaiting_customer",
          priority: "high",
        },
      ],
      nextCursor: null,
    })
    await loadTickets(state.api)

    render(() => <TicketsInbox />)
    expect(screen.getByTestId("tickets-list-row-t1")).toBeTruthy()
    expect(screen.getByTestId("tickets-list-row-t2")).toBeTruthy()

    // Simulate the WS event a gated close/reply approval fires: t1 closes and
    // leaves the "all-open" view.
    applyTicketUpdateToList("t1", { status: "closed", closedReason: "resolved" })

    // FALSIFIABLE: without the fix, the row is spliced out of the store and
    // the <For> re-renders instantly — this row would already be gone here.
    const row1 = screen.getByTestId("tickets-list-row-t1")
    expect(row1).toBeTruthy()
    expect(row1.getAttribute("data-exiting")).toBe("true")

    // Not clickable while exiting — a click meant for the row about to occupy
    // this position later must never resolve against the stale ticket.
    fireEvent.click(row1)
    expect(state.openTab).not.toHaveBeenCalled()

    // t2 never moved and must still open correctly during the transition.
    fireEvent.click(screen.getByTestId("tickets-list-row-t2"))
    expect(state.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tickets:ticket", entityId: "t2" }),
    )

    // After the transition, the row is actually gone and the gap has closed.
    await waitFor(
      () => {
        expect(screen.queryByTestId("tickets-list-row-t1")).toBeNull()
      },
      { timeout: 1000 },
    )
    expect(screen.getByTestId("tickets-list-row-t2")).toBeTruthy()
  })

  it("still reflects a live reorder (new message bumping a ticket to the front) while nothing is exiting", async () => {
    resetTicketListStore()
    setListParams(paramsForSmartFilter("all-open"))
    state.api.post.mockResolvedValue({
      items: [
        { id: "t1", handle: "ticket-1", subject: "First", status: "open", priority: "normal" },
        { id: "t2", handle: "ticket-2", subject: "Second", status: "open", priority: "normal" },
        { id: "t3", handle: "ticket-3", subject: "Third", status: "open", priority: "normal" },
      ],
      nextCursor: null,
    })
    await loadTickets(state.api)
    render(() => <TicketsInbox />)
    expect(renderedRowOrder()).toEqual(["t1", "t2", "t3"])

    // A new inbound message on t3 bumps it to the front under activity_newest
    // (the "all-open" view's sort) -- the same store update a WS
    // tickets:message create event drives.
    applyTicketMessageToList({ ticketId: "t3", kind: "inbound", textBody: "reply please" })

    // FALSIFIABLE: the merge previously rebuilt the render list by walking the
    // OLD render order first, so a pure reorder (no row entering or leaving)
    // never showed up here -- this stayed ["t1","t2","t3"] even though the
    // store itself had already moved t3 to the front.
    await waitFor(() => {
      expect(renderedRowOrder()).toEqual(["t3", "t1", "t2"])
    })
  })

  it("un-exits a row that reappears before its exit transition finishes, instead of vanishing it later", async () => {
    resetTicketListStore()
    setListParams(paramsForSmartFilter("all-open"))
    state.api.post.mockResolvedValue({
      items: [
        { id: "t1", handle: "ticket-1", subject: "First", status: "open", priority: "normal" },
        { id: "t2", handle: "ticket-2", subject: "Second", status: "open", priority: "normal" },
      ],
      nextCursor: null,
    })
    await loadTickets(state.api)
    render(() => <TicketsInbox />)

    // t1 closes and starts exiting...
    applyTicketUpdateToList("t1", { status: "closed", closedReason: "resolved" })
    expect(screen.getByTestId("tickets-list-row-t1").getAttribute("data-exiting")).toBe("true")

    // ...then a resync (e.g. a WS reconnect reload) brings it straight back
    // before the 220ms transition would have finished.
    state.api.post.mockResolvedValue({
      items: [
        { id: "t1", handle: "ticket-1", subject: "First", status: "open", priority: "normal" },
        { id: "t2", handle: "ticket-2", subject: "Second", status: "open", priority: "normal" },
      ],
      nextCursor: null,
    })
    await loadTickets(state.api)

    // It must be live and clickable again immediately, not still marked exiting.
    const row1 = screen.getByTestId("tickets-list-row-t1")
    expect(row1.getAttribute("data-exiting")).toBe("false")
    fireEvent.click(row1)
    expect(state.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tickets:ticket", entityId: "t1" }),
    )

    // FALSIFIABLE: without cancelling the stale exit timer on reappearance,
    // it fires anyway at ~220ms and yanks t1 out of the render list even
    // though the store still has it -- the ticket would vanish here until
    // some unrelated store change resynced the two.
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(screen.getByTestId("tickets-list-row-t1")).toBeTruthy()
  })
})
