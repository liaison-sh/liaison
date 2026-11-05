// SPDX-License-Identifier: FSL-1.1-ALv2
import { render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  api: { post: vi.fn() } as any,
  cached: {} as Record<string, any>,
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => state.api }))
vi.mock("~/modules/tickets/ticket-detail-store", () => ({
  ticketDetailStore: {
    get byId() {
      return state.cached
    },
  },
}))

import { TicketCard } from "./TicketCard"

describe("TicketCard", () => {
  beforeEach(() => {
    state.cached = {}
  })

  it("uses cached ticket when available without an extra request", async () => {
    state.cached = {
      t1: {
        id: "t1",
        handle: "ticket-1",
        subject: "From cache",
        status: "open",
        priority: "normal",
      },
    }
    state.api.post = vi.fn()
    render(() => <TicketCard entityId="t1" />)
    await waitFor(() =>
      expect(screen.getByTestId("tickets-card-subject").textContent).toBe("From cache"),
    )
  })

  it("aborts the in-flight tickets:get fetch on unmount", async () => {
    const abortSpy = vi.fn()
    state.api.post = vi.fn(
      (_path: string, _body: unknown, init?: { signal?: AbortSignal }) =>
        new Promise(() => {
          init?.signal?.addEventListener("abort", abortSpy)
        }),
    )
    const { unmount } = render(() => <TicketCard entityId="t-cancel" />)
    unmount()
    await waitFor(() => expect(abortSpy).toHaveBeenCalled())
  })

  it("[SC16] fetches via tickets:get when not cached", async () => {
    state.api.post = vi.fn().mockResolvedValue({
      ticket: {
        id: "t9",
        handle: "ticket-9",
        subject: "Lazy",
        status: "open",
        priority: "normal",
      },
    })
    render(() => <TicketCard entityId="t9" />)
    await waitFor(() => expect(screen.getByTestId("tickets-card-subject").textContent).toBe("Lazy"))
    expect(state.api.post).toHaveBeenCalledWith(
      "/apps/run-tool",
      expect.objectContaining({ toolName: "tickets:get", params: { ticketId: "t9" } }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })
})
