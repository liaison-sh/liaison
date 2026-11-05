// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  api: { post: vi.fn() } as any,
  loadTicket: vi.fn(),
  onClose: vi.fn(),
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => state.api }))
vi.mock("~/modules/tickets/ticket-detail-store", () => ({ loadTicket: state.loadTicket }))

import { TicketCloseDialog } from "./TicketCloseDialog"

describe("TicketCloseDialog", () => {
  beforeEach(() => {
    state.api.post = vi.fn().mockResolvedValue({})
    state.loadTicket.mockReset()
    state.loadTicket.mockResolvedValue(undefined)
    state.onClose.mockReset()
  })

  it("renders close form with reason select and final-reply textarea", () => {
    render(() => <TicketCloseDialog ticketId="t1" onClose={state.onClose} />)
    expect(screen.getByTestId("tickets-close-dialog")).toBeTruthy()
    expect(screen.getByTestId("tickets-close-reason")).toBeTruthy()
    expect(screen.getByTestId("tickets-close-body")).toBeTruthy()
  })

  it("submit invokes tickets:close, reloads the ticket, and closes dialog", async () => {
    render(() => <TicketCloseDialog ticketId="t1" onClose={state.onClose} />)
    fireEvent.change(screen.getByTestId("tickets-close-reason"), { target: { value: "duplicate" } })
    fireEvent.click(screen.getByTestId("tickets-close-submit"))
    await waitFor(() => expect(state.onClose).toHaveBeenCalled())
    expect(state.api.post.mock.calls[0][1]).toMatchObject({
      toolName: "tickets:close",
      params: { ticketId: "t1", closedReason: "duplicate" },
    })
    expect(state.loadTicket).toHaveBeenCalledWith(state.api, "t1")
    expect(state.api.post.mock.calls).toHaveLength(1)
  })

  it("renders pending banner if tool returns blocked", async () => {
    state.api.post = vi.fn().mockResolvedValue({ blocked: { reason: "gated" } })
    render(() => <TicketCloseDialog ticketId="t1" onClose={state.onClose} />)
    fireEvent.click(screen.getByTestId("tickets-close-submit"))
    await waitFor(() => expect(screen.getByTestId("tickets-close-pending")).toBeTruthy())
  })
})
