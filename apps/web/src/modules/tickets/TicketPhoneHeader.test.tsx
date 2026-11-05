// SPDX-License-Identifier: FSL-1.1-ALv2
//
// G1. TicketPhoneHeader is the ticket detail's phone-tier nav bar, tested on
// its own now that it is a separate component (registered onto the tab type
// at runtime, rendered by MainPanel's phone top bar) instead of a block
// inside TicketDetail.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ openTab: vi.fn(), openTicketMoreSheet: vi.fn() }))

vi.mock("~/modules/shell/tab-store", () => ({ openTab: state.openTab }))
vi.mock("~/modules/tickets/ticket-phone-header-store", () => ({
  openTicketMoreSheet: state.openTicketMoreSheet,
}))
vi.mock("~/modules/tickets/ticket-detail-store", () => ({
  ticketDetailStore: { byId: { t1: { id: "t1", handle: "ticket-1" } } },
}))

import TicketPhoneHeader from "~/modules/tickets/TicketPhoneHeader"
import {
  clearThreadMapSize,
  closeThreadMap,
  isThreadMapOpen,
  setThreadMapSize,
} from "~/ui/thread-map-store"

describe("TicketPhoneHeader", () => {
  afterEach(() => {
    cleanup()
    state.openTab.mockClear()
    state.openTicketMoreSheet.mockClear()
  })

  it("shows the ticket's handle", () => {
    render(() => <TicketPhoneHeader entityId="t1" />)
    expect(screen.getByTestId("ticket-phone-handle").textContent).toBe("#ticket-1")
  })

  it("back returns to the ticket list", () => {
    render(() => <TicketPhoneHeader entityId="t1" />)
    fireEvent.click(screen.getByTestId("ticket-phone-back"))
    expect(state.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tickets:inbox", entityId: "inbox" }),
    )
  })

  it("the more control opens the shared actions sheet for this ticket", () => {
    render(() => <TicketPhoneHeader entityId="t1" />)
    fireEvent.click(screen.getByTestId("ticket-phone-more"))
    expect(state.openTicketMoreSheet).toHaveBeenCalledWith("t1")
  })

  it("offers no thread map button on a ticket of fewer than 3 messages", () => {
    setThreadMapSize("tickets:t1", 2)
    render(() => <TicketPhoneHeader entityId="t1" />)
    expect(screen.queryByTestId("ticket-phone-thread-map")).toBeNull()
    clearThreadMapSize("tickets:t1")
  })

  it("the thread map button opens this ticket's drawer", () => {
    setThreadMapSize("tickets:t1", 4)
    render(() => <TicketPhoneHeader entityId="t1" />)
    fireEvent.click(screen.getByTestId("ticket-phone-thread-map"))
    expect(isThreadMapOpen("tickets:t1")).toBe(true)
    closeThreadMap()
    clearThreadMapSize("tickets:t1")
  })
})
