// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"

describe("ticket-list-store search unavailable handling", () => {
  beforeEach(() => vi.resetModules())

  it("sets searchUnavailable on a SEARCH_UNAVAILABLE tool error without clobbering the list with garbage", async () => {
    // Import ApiError from the SAME fresh module graph the store resolves after
    // resetModules — a statically-imported ApiError would be a different class
    // reference, breaking `instanceof` in isSearchUnavailableError.
    const { ApiError } = await import("~/lib/api-error")
    const post = vi
      .fn()
      .mockRejectedValueOnce(new ApiError("Search unavailable", 503, "SEARCH_UNAVAILABLE"))
    const api = { post } as any
    const {
      loadTickets,
      setListParams,
      paramsForSmartFilter,
      ticketListStore,
      resetTicketListStore,
    } = await import("~/modules/tickets/ticket-list-store")
    resetTicketListStore()

    // A query search fails with SEARCH_UNAVAILABLE — the flag is set, no rows
    // are written (loadTickets's catch block never touches byId/ids), and the
    // generic error banner stays clear.
    setListParams({ ...paramsForSmartFilter("all-open"), query: "nachumi" })
    await loadTickets(api)
    expect(ticketListStore.searchUnavailable).toBe(true)
    expect(ticketListStore.error).toBeNull()
    expect(ticketListStore.ids).toEqual([])
    expect(ticketListStore.byId).toEqual({})
  })

  it("clears searchUnavailable on the next successful load", async () => {
    const { ApiError } = await import("~/lib/api-error")
    const post = vi
      .fn()
      .mockRejectedValueOnce(new ApiError("Search unavailable", 503, "SEARCH_UNAVAILABLE"))
      .mockResolvedValueOnce({
        items: [{ id: "t2", handle: "ticket-2", subject: "B", status: "open", priority: "normal" }],
        nextCursor: null,
      })
    const api = { post } as any
    const {
      loadTickets,
      setListParams,
      paramsForSmartFilter,
      ticketListStore,
      resetTicketListStore,
    } = await import("~/modules/tickets/ticket-list-store")
    resetTicketListStore()

    setListParams({ ...paramsForSmartFilter("all-open"), query: "nachumi" })
    await loadTickets(api)
    expect(ticketListStore.searchUnavailable).toBe(true)

    // Retrying the same search succeeds — the flag clears.
    await loadTickets(api)
    expect(ticketListStore.searchUnavailable).toBe(false)
    expect(ticketListStore.ids).toEqual(["t2"])
  })

  it("clears searchUnavailable when the query is cleared", async () => {
    const { ApiError } = await import("~/lib/api-error")
    const post = vi
      .fn()
      .mockRejectedValueOnce(new ApiError("Search unavailable", 503, "SEARCH_UNAVAILABLE"))
      .mockResolvedValueOnce({ items: [], nextCursor: null })
    const api = { post } as any
    const {
      loadTickets,
      setListParams,
      paramsForSmartFilter,
      ticketListStore,
      resetTicketListStore,
    } = await import("~/modules/tickets/ticket-list-store")
    resetTicketListStore()

    setListParams({ ...paramsForSmartFilter("all-open"), query: "nachumi" })
    await loadTickets(api)
    expect(ticketListStore.searchUnavailable).toBe(true)

    // Clearing the query resets the flag synchronously via setListParams, even
    // before the follow-up reload resolves.
    setListParams({ ...paramsForSmartFilter("all-open"), query: "" })
    expect(ticketListStore.searchUnavailable).toBe(false)
    await loadTickets(api)
    expect(ticketListStore.searchUnavailable).toBe(false)
  })

  it("a non-SEARCH_UNAVAILABLE error still sets the generic error banner, not searchUnavailable", async () => {
    const { ApiError } = await import("~/lib/api-error")
    const post = vi.fn().mockRejectedValueOnce(new ApiError("Boom", 500))
    const api = { post } as any
    const {
      loadTickets,
      setListParams,
      paramsForSmartFilter,
      ticketListStore,
      resetTicketListStore,
    } = await import("~/modules/tickets/ticket-list-store")
    resetTicketListStore()

    setListParams({ ...paramsForSmartFilter("all-open"), query: "nachumi" })
    await loadTickets(api)
    expect(ticketListStore.searchUnavailable).toBe(false)
    expect(ticketListStore.error).toBe("Boom")
  })
})
